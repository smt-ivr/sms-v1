// מפתחות API + API ציבורי (v1) לשליחה וקריאה מתוך מערכות חיצוניות
import { all, first, run, insertId, audit } from '../lib/db.js';
import { json, fail, readJson, str } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature, resolveAccess } from '../lib/features.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { parsePhoneList, normalizePhone } from '../lib/validate.js';
import { fetchMessages, sendSms } from '../lib/yemot.js';
import { assertQuota, logSend } from '../lib/quota.js';
import { limit } from '../lib/ratelimit.js';
import { resolveSystem } from './systems.js';
import { contactMap, buildConversations } from './messages.js';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

async function apiAuth(ctx) {
  const header = ctx.request.headers.get('Authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key.startsWith('smt_')) fail(401, 'חסר מפתח API בכותרת Authorization: Bearer smt_...');
  const row = await first(ctx.env, 'SELECT * FROM v2_api_keys WHERE key_hash = ?', await sha256(key));
  if (!row) fail(401, 'מפתח API שגוי או שבוטל.');
  const user = await first(ctx.env, 'SELECT * FROM v2_users WHERE id = ?', row.user_id);
  if (!user || user.status !== 'active') fail(403, 'החשבון אינו פעיל.');
  ctx.user = user;
  ctx.access = await resolveAccess(ctx.env, user);
  if (!ctx.access.features.api) fail(403, 'הגישה ל-API כבויה בחשבון הזה.');
  await limit(ctx.env, `api:${row.id}`, 120, 60, 'חריגה ממגבלת הקצב: עד 120 בקשות בדקה.');
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) ctx.waitUntil(run(ctx.env, 'UPDATE v2_api_keys SET last_used_at = ? WHERE id = ?', Date.now(), row.id));
  ctx.apiKey = row;
}

const cors = (data, status = 200) => json(data, status, CORS);

export default function developerRoutes(r) {
  // ---------- ניהול מפתחות ----------
  r.get('/api/keys', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env, 'SELECT id, name, prefix, last_used_at, created_at FROM v2_api_keys WHERE user_id = ? ORDER BY id DESC', user.id);
  });

  r.post('/api/keys', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'api');
    const body = await readJson(ctx.request);
    const name = str(body.name, 50) || 'מפתח API';
    const n = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_api_keys WHERE user_id = ?', user.id);
    if (n.n >= 10) fail(400, 'אפשר להחזיק עד 10 מפתחות.');
    const key = `smt_${randomToken(30)}`;
    const id = await insertId(ctx.env, 'INSERT INTO v2_api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
      user.id, name, await sha256(key), key.slice(0, 10), Date.now());
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'apikey.create', detail: { id, name }, ip: ctx.ip });
    return { ok: true, id, key }; // מוצג פעם אחת בלבד
  });

  r.delete('/api/keys/:id', async (ctx) => {
    const user = await requireUser(ctx);
    await run(ctx.env, 'DELETE FROM v2_api_keys WHERE id = ? AND user_id = ?', Number(ctx.params.id), user.id);
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'apikey.delete', detail: { id: ctx.params.id }, ip: ctx.ip });
    return { ok: true };
  });

  // ---------- API ציבורי ----------
  r.get('/api/v1/systems', async (ctx) => {
    await apiAuth(ctx);
    return cors(await all(ctx.env, 'SELECT id, name, number, status FROM v2_systems WHERE user_id = ? ORDER BY id', ctx.user.id));
  });

  r.post('/api/v1/send', async (ctx) => {
    await apiAuth(ctx);
    if (!ctx.access.features['messages.send']) fail(403, 'שליחת הודעות כבויה בחשבון.');
    const body = await readJson(ctx.request);
    const system = await resolveSystem(ctx, body.system_id);
    const message = String(body.message || '').trim();
    if (!message || message.length > 1000) fail(400, 'message חסר או ארוך מ-1000 תווים.');
    let phones = parsePhoneList(body.phones ?? body.phone, 300);
    if (!phones.length) fail(400, 'phones חסר.');
    if (phones.length > 5 && !ctx.access.features['messages.bulk']) fail(403, 'שליחה ליותר מ-5 נמענים דורשת הרשאת שליחה קבוצתית.');
    const contacts = await contactMap(ctx.env, ctx.user.id);
    const blocked = phones.filter((p) => contacts.get(p) && contacts.get(p).is_blocked);
    phones = phones.filter((p) => !blocked.includes(p));
    if (!phones.length) fail(400, 'כל הנמענים חסומים.');
    await assertQuota(ctx, phones.length);
    try {
      const res = await sendSms(ctx.env, system, phones, message, str(body.from, 20) || undefined);
      await logSend(ctx.env, { userId: ctx.user.id, systemId: system.id, via: 'api', recipients: phones.length, preview: message, ok: true, actor: `key:${ctx.apiKey.id}` });
      return cors({ ok: true, sent: res.sent, skipped_blocked: blocked });
    } catch (e) {
      await logSend(ctx.env, { userId: ctx.user.id, systemId: system.id, via: 'api', recipients: phones.length, preview: message, ok: false, error: e.message, actor: `key:${ctx.apiKey.id}` });
      throw e;
    }
  });

  r.get('/api/v1/messages', async (ctx) => {
    await apiAuth(ctx);
    const system = await resolveSystem(ctx, ctx.url.searchParams.get('system_id'));
    const phone = ctx.url.searchParams.get('phone') ? normalizePhone(ctx.url.searchParams.get('phone')) : null;
    const since = ctx.url.searchParams.get('since') || '';
    const direction = ctx.url.searchParams.get('direction'); // in | out
    let msgs = await fetchMessages(ctx.env, system, { limit: 1500 });
    if (phone) msgs = msgs.filter((m) => m.phone === phone);
    if (since) msgs = msgs.filter((m) => m.time > since);
    if (direction === 'in') msgs = msgs.filter((m) => !m.out);
    if (direction === 'out') msgs = msgs.filter((m) => m.out);
    return cors({ messages: msgs.slice(-500).map(({ phone: p, text, time, out, status }) => ({ phone: p, text, time, direction: out ? 'out' : 'in', status })) });
  });

  r.get('/api/v1/conversations', async (ctx) => {
    await apiAuth(ctx);
    const system = await resolveSystem(ctx, ctx.url.searchParams.get('system_id'));
    const [msgs, contacts] = await Promise.all([fetchMessages(ctx.env, system, { limit: 1500 }), contactMap(ctx.env, ctx.user.id)]);
    return cors({ conversations: buildConversations(msgs, contacts, new Map()).map(({ phone, name, last, count }) => ({ phone, name, last, count })) });
  });
}

// גישת אורחים — היורש של "קודים זמניים".
// האורח מקבל קוד, נכנס ל-/guest.html, ועובד דרך השרת בלבד, לפי הרשאות מוגדרות. הטוקן לא נחשף.
import { all, first, run, insertId, audit } from '../lib/db.js';
import { json, fail, readJson, str, toInt, bool } from '../lib/http.js';
import { requireUser, requireGuest, createSession, clearCookie, destroyCurrentSession } from '../lib/session.js';
import { requireFeature, resolveAccess } from '../lib/features.js';
import { randomCode, sha256 } from '../lib/crypto.js';
import { normalizePhone, parsePhoneList } from '../lib/validate.js';
import { fetchMessages, sendSms } from '../lib/yemot.js';
import { assertQuota, logSend } from '../lib/quota.js';
import { limit } from '../lib/ratelimit.js';
import { getOwnedSystem } from './systems.js';
import { buildConversations, contactMap } from './messages.js';

const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function readShare(body) {
  const phones = body.phones ? parsePhoneList(body.phones, 200) : [];
  const out = {
    label: str(body.label, 60) || 'גישת אורח',
    can_read: bool(body.can_read ?? 1),
    can_send: bool(body.can_send ?? 0),
    phones: phones.length ? JSON.stringify(phones) : null,
    max_sends: body.max_sends ? Math.max(1, Math.min(100000, toInt(body.max_sends, 0))) : null,
  };
  if (!out.can_read && !out.can_send) fail(400, 'יש לאפשר לפחות צפייה או שליחה.');
  return out;
}

function expiresFrom(body, fallback = null) {
  if (body.expires_minutes === 0 || body.expires_minutes === '0') return null; // ללא תפוגה
  const mins = toInt(body.expires_minutes, null);
  if (mins) return Date.now() + Math.min(mins, 365 * 24 * 60) * 60_000;
  return fallback;
}

async function newCode(env) {
  for (let i = 0; i < 5; i++) {
    const code = randomCode(10);
    const hash = await sha256(code);
    if (!(await first(env, 'SELECT id FROM v2_shares WHERE code_hash = ?', hash))) return { code, hash };
  }
  fail(500, 'לא ניתן היה ליצור קוד ייחודי. נסה שוב.');
}

// הקישור נבנה מהכתובת שממנה המשתמש עובד בפועל (כולל הנתיב), כדי שיעבוד גם כשהפרויקט רץ תחת נתיב
const guestLink = (ctx, code) => `${ctx.url ? ctx.url.origin + (ctx.base || '') : (ctx.env.APP_URL || '')}/guest.html#${code}`;

export default function shareRoutes(r) {
  r.get('/api/shares', async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await all(ctx.env,
      `SELECT sh.id, sh.system_id, sh.label, sh.code_hint, sh.can_read, sh.can_send, sh.phones, sh.max_sends, sh.sends, sh.uses, sh.is_active,
              sh.expires_at, sh.last_used_at, sh.created_at, s.name AS system_name
       FROM v2_shares sh LEFT JOIN v2_systems s ON s.id = sh.system_id WHERE sh.user_id = ? ORDER BY sh.id DESC`, user.id);
    return rows.map((s) => ({ ...s, phones: s.phones ? JSON.parse(s.phones) : [] }));
  });

  r.post('/api/shares', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'shares');
    const body = await readJson(ctx.request);
    const system = await getOwnedSystem(ctx, body.system_id);
    const data = readShare(body);
    const n = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_shares WHERE user_id = ?', user.id);
    if (n.n >= 100) fail(400, 'הגעת למספר המרבי של קודי גישה.');
    const { code, hash } = await newCode(ctx.env);
    const id = await insertId(ctx.env,
      `INSERT INTO v2_shares (user_id, system_id, label, code_hash, code_hint, can_read, can_send, phones, max_sends, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, system.id, data.label, hash, code.slice(-3), data.can_read, data.can_send, data.phones, data.max_sends,
      expiresFrom(body, Date.now() + 60 * 60_000), Date.now());
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'share.create', detail: { id, system: system.id }, ip: ctx.ip });
    return { ok: true, id, code, link: guestLink(ctx, code) };
  });

  r.put('/api/shares/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const sh = await first(ctx.env, 'SELECT * FROM v2_shares WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!sh) fail(404, 'הקוד לא נמצא.');
    const body = await readJson(ctx.request);
    const data = readShare({ ...sh, phones: sh.phones ? JSON.parse(sh.phones) : null, ...body });
    let expiresAt = sh.expires_at;
    if (body.extend_minutes) expiresAt = Math.max(Date.now(), sh.expires_at || Date.now()) + Math.min(toInt(body.extend_minutes, 0), 525600) * 60_000;
    else if (body.expires_minutes !== undefined) expiresAt = expiresFrom(body, sh.expires_at);
    const active = body.is_active !== undefined ? bool(body.is_active) : sh.is_active;
    await run(ctx.env, 'UPDATE v2_shares SET label = ?, can_read = ?, can_send = ?, phones = ?, max_sends = ?, is_active = ?, expires_at = ? WHERE id = ?',
      data.label, data.can_read, data.can_send, data.phones, data.max_sends, active, expiresAt, sh.id);
    if (!active) await run(ctx.env, 'DELETE FROM v2_sessions WHERE share_id = ?', sh.id);
    return { ok: true };
  });

  r.post('/api/shares/:id/regenerate', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'shares');
    const sh = await first(ctx.env, 'SELECT id FROM v2_shares WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!sh) fail(404, 'הקוד לא נמצא.');
    const { code, hash } = await newCode(ctx.env);
    await run(ctx.env, 'UPDATE v2_shares SET code_hash = ?, code_hint = ? WHERE id = ?', hash, code.slice(-3), sh.id);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE share_id = ?', sh.id);
    return { ok: true, code, link: guestLink(ctx, code) };
  });

  r.delete('/api/shares/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const id = toInt(ctx.params.id);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM v2_sessions WHERE share_id IN (SELECT id FROM v2_shares WHERE id = ? AND user_id = ?)').bind(id, user.id),
      ctx.env.DB.prepare('DELETE FROM v2_shares WHERE id = ? AND user_id = ?').bind(id, user.id),
    ]);
    return { ok: true };
  });

  // ================= צד האורח =================
  r.post('/api/guest/login', async (ctx) => {
    await limit(ctx.env, `guest:ip:${ctx.ip}`, 15, 900, 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות.');
    const body = await readJson(ctx.request);
    const code = normCode(body.code);
    if (code.length < 6) fail(400, 'קוד לא תקין.');
    const share = await first(ctx.env, 'SELECT * FROM v2_shares WHERE code_hash = ?', await sha256(code));
    if (!share || !share.is_active) fail(401, 'הקוד שגוי או שבוטל.');
    if (share.expires_at && share.expires_at < Date.now()) fail(401, 'תוקף הקוד הסתיים.');
    const owner = await first(ctx.env, 'SELECT * FROM v2_users WHERE id = ?', share.user_id);
    if (!owner || owner.status !== 'active') fail(401, 'הגישה אינה זמינה כרגע.');
    const access = await resolveAccess(ctx.env, owner);
    if (!access.features.shares) fail(403, 'גישת אורחים כבויה כרגע בחשבון הזה.');

    await run(ctx.env, 'UPDATE v2_shares SET uses = uses + 1, last_used_at = ? WHERE id = ?', Date.now(), share.id);
    await audit(ctx.env, { userId: owner.id, action: 'share.login', detail: { share: share.id, label: share.label }, ip: ctx.ip });
    const ttl = share.expires_at ? Math.max(60_000, Math.min(12 * 3600_000, share.expires_at - Date.now())) : 12 * 3600_000;
    const setCookie = await createSession(ctx, { kind: 'guest', shareId: share.id, ttlMs: ttl });
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
  });

  r.post('/api/guest/logout', async (ctx) => {
    await destroyCurrentSession(ctx, 'guest');
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ctx, 'guest') });
  });

  r.get('/api/guest/me', async (ctx) => {
    const share = await requireGuest(ctx);
    const system = await first(ctx.env, 'SELECT name FROM v2_systems WHERE id = ?', share.system_id);
    return {
      label: share.label, can_read: !!share.can_read, can_send: !!share.can_send,
      phones: share.phones ? JSON.parse(share.phones) : [], expires_at: share.expires_at,
      sends: share.sends, max_sends: share.max_sends, system_name: system ? system.name : '',
    };
  });

  const allowed = (share, phone) => !share.phones || JSON.parse(share.phones).includes(phone);

  r.get('/api/guest/conversations', async (ctx) => {
    const share = await requireGuest(ctx);
    if (!share.can_read) return { conversations: [] };
    const system = await first(ctx.env, 'SELECT * FROM v2_systems WHERE id = ?', share.system_id);
    if (!system) fail(410, 'המערכת הוסרה.');
    const [messages, contacts] = await Promise.all([fetchMessages(ctx.env, system, { limit: 1500 }), contactMap(ctx.env, share.user_id)]);
    const conversations = buildConversations(messages, contacts, new Map())
      .filter((c) => !c.blocked && allowed(share, c.phone))
      .map((c) => ({ ...c, unread: 0, pinned: false, archived: false }));
    return { conversations };
  });

  r.get('/api/guest/thread', async (ctx) => {
    const share = await requireGuest(ctx);
    const phone = normalizePhone(ctx.url.searchParams.get('phone'));
    if (!allowed(share, phone)) fail(403, 'אין לך גישה למספר הזה.');
    if (!share.can_read) return { phone, messages: [] };
    const system = await first(ctx.env, 'SELECT * FROM v2_systems WHERE id = ?', share.system_id);
    const messages = (await fetchMessages(ctx.env, system, { limit: 1500 })).filter((m) => m.phone === phone);
    const contact = await first(ctx.env, 'SELECT name FROM v2_contacts WHERE user_id = ? AND phone = ?', share.user_id, phone);
    return { phone, name: contact ? contact.name : null, messages: messages.map(({ text, time, out, status }) => ({ text, time, out, status })) };
  });

  r.post('/api/guest/send', async (ctx) => {
    const share = await requireGuest(ctx);
    if (!share.can_send) fail(403, 'הקוד הזה מאפשר צפייה בלבד.');
    await requireFeature(ctx, 'messages.send');
    await limit(ctx.env, `gsend:${share.id}`, 20, 60, 'שולחים מהר מדי. המתן רגע.');
    const body = await readJson(ctx.request);
    const phone = normalizePhone(body.phone);
    if (!/^0\d{8,9}$/.test(phone) && !/^\d{10,15}$/.test(phone)) fail(400, 'מספר טלפון לא תקין.');
    if (!allowed(share, phone)) fail(403, 'אין לך הרשאה לשלוח למספר הזה.');
    const message = String(body.message || '').trim();
    if (!message || message.length > 1000) fail(400, 'ההודעה ריקה או ארוכה מדי.');
    if (share.max_sends && share.sends >= share.max_sends) fail(403, 'נוצלה מכסת השליחות של הקוד.');
    const blocked = await first(ctx.env, 'SELECT id FROM v2_contacts WHERE user_id = ? AND phone = ? AND is_blocked = 1', share.user_id, phone);
    if (blocked) fail(403, 'המספר חסום.');
    await assertQuota(ctx, 1);
    const system = await first(ctx.env, 'SELECT * FROM v2_systems WHERE id = ?', share.system_id);
    try {
      await sendSms(ctx.env, system, [phone], message);
      await run(ctx.env, 'UPDATE v2_shares SET sends = sends + 1 WHERE id = ?', share.id);
      await logSend(ctx.env, { userId: share.user_id, systemId: system.id, via: 'guest', recipients: 1, preview: message, ok: true, actor: `share:${share.id}` });
    } catch (e) {
      await logSend(ctx.env, { userId: share.user_id, systemId: system.id, via: 'guest', recipients: 1, preview: message, ok: false, error: e.message, actor: `share:${share.id}` });
      throw e;
    }
    return { ok: true };
  });
}

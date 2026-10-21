// הודעות: שיחות, שליחה, קמפיינים ותזמון, סטטיסטיקה וייצוא — הכל דרך השרת
import { all, first, run, audit } from '../lib/db.js';
import { fail, readJson, str, toInt } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature, getAccess } from '../lib/features.js';
import { fetchMessages, sendSms } from '../lib/yemot.js';
import { normalizePhone, parsePhoneList, israelParts } from '../lib/validate.js';
import { assertQuota, logSend } from '../lib/quota.js';
import { limit } from '../lib/ratelimit.js';
import { randomToken } from '../lib/crypto.js';
import { processRows } from '../lib/queue.js';
import { resolveSystem } from './systems.js';

const MAX_LEN = 1000;
const FETCH_LIMIT = 1500;
const UNREAD_HORIZON_MS = 3 * 86400_000;

function checkMessage(text) {
  const m = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!m) fail(400, 'ההודעה ריקה.');
  if (m.length > MAX_LEN) fail(400, `ההודעה ארוכה מדי (מקסימום ${MAX_LEN} תווים).`);
  return m;
}

export async function contactMap(env, userId) {
  const rows = await all(env, 'SELECT id, phone, name, is_blocked, is_favorite FROM v2_contacts WHERE user_id = ?', userId);
  return new Map(rows.map((c) => [c.phone, c]));
}

// בונה רשימת שיחות מתוך ההודעות הגולמיות
export function buildConversations(messages, contacts, metaMap) {
  const convs = new Map();
  for (const m of messages) {
    let c = convs.get(m.phone);
    if (!c) { c = { phone: m.phone, count: 0, incoming: [], lastOut: null, last: null }; convs.set(m.phone, c); }
    c.count++;
    c.last = m;
    if (m.out) c.lastOut = m.time; else c.incoming.push(m.time);
  }
  // גבול תחתון לחישוב "לא נקרא" כשאין עדיין נתוני קריאה
  const horizon = israelParts(Date.now() - UNREAD_HORIZON_MS).stamp;
  const out = [];
  for (const c of convs.values()) {
    const contact = contacts.get(c.phone);
    const meta = metaMap.get(c.phone) || {};
    const readMark = [meta.last_read, c.lastOut, meta.last_read ? null : horizon].filter(Boolean).sort().pop() || '';
    out.push({
      phone: c.phone,
      name: contact ? contact.name : null,
      contact_id: contact ? contact.id : null,
      favorite: contact ? !!contact.is_favorite : false,
      blocked: contact ? !!contact.is_blocked : false,
      last: { text: c.last.text.slice(0, 140), time: c.last.time, out: c.last.out, status: c.last.status },
      count: c.count,
      unread: c.incoming.filter((t) => t > readMark).length,
      pinned: !!meta.pinned,
      archived: !!meta.archived,
    });
  }
  out.sort((a, b) => (b.pinned - a.pinned) || (a.last.time < b.last.time ? 1 : -1));
  return out;
}

async function metaFor(env, userId, systemId) {
  const rows = await all(env, 'SELECT phone, last_read, pinned, archived FROM v2_conv_meta WHERE user_id = ? AND system_id = ?', userId, systemId);
  return new Map(rows.map((r) => [r.phone, r]));
}

async function upsertMeta(env, userId, systemId, phone, patch) {
  await run(env, 'INSERT OR IGNORE INTO v2_conv_meta (user_id, system_id, phone) VALUES (?, ?, ?)', userId, systemId, phone);
  if ('last_read' in patch) {
    await run(env, 'UPDATE v2_conv_meta SET last_read = CASE WHEN last_read IS NULL OR last_read < ? THEN ? ELSE last_read END WHERE user_id = ? AND system_id = ? AND phone = ?',
      patch.last_read, patch.last_read, userId, systemId, phone);
  }
  if ('pinned' in patch) await run(env, 'UPDATE v2_conv_meta SET pinned = ? WHERE user_id = ? AND system_id = ? AND phone = ?', patch.pinned ? 1 : 0, userId, systemId, phone);
  if ('archived' in patch) await run(env, 'UPDATE v2_conv_meta SET archived = ? WHERE user_id = ? AND system_id = ? AND phone = ?', patch.archived ? 1 : 0, userId, systemId, phone);
}

// הוספת שורות לתור; אם קטן ומיידי — שולח מיד
async function enqueue(ctx, { system, groups, sendAt, label, via }) {
  const batchId = randomToken(9);
  const t = Date.now();
  const stmts = groups.map((g) => ctx.env.DB.prepare(
    'INSERT INTO v2_scheduled (user_id, system_id, batch_id, label, via, phones, body, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(ctx.user.id, system.id, batchId, label, via, JSON.stringify(g.phones), g.body, sendAt, t));
  for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));
  let immediate = null;
  if (sendAt <= t + 5000 && groups.length <= 3) {
    const rows = await all(ctx.env, "SELECT * FROM v2_scheduled WHERE user_id = ? AND batch_id = ? AND status = 'pending'", ctx.user.id, batchId);
    immediate = await processRows(ctx.env, rows);
  }
  return { batch_id: batchId, parts: groups.length, immediate };
}

const fill = (tpl, vars) => tpl.replace(/\{(name|phone|first)\}/g, (_, k) => vars[k] || '');

export default function messageRoutes(r) {
  r.get('/api/messages/conversations', async (ctx) => {
    const user = await requireUser(ctx);
    const system = await resolveSystem(ctx, ctx.url.searchParams.get('system'));
    const fresh = ctx.url.searchParams.get('fresh') === '1';
    if (fresh) await limit(ctx.env, `conv:${user.id}`, 40, 60);
    const [messages, contacts, meta] = await Promise.all([
      fetchMessages(ctx.env, system, { limit: FETCH_LIMIT, fresh }),
      contactMap(ctx.env, user.id),
      metaFor(ctx.env, user.id, system.id),
    ]);
    const conversations = buildConversations(messages, contacts, meta);
    const visible = conversations.filter((c) => !c.blocked);
    return {
      system: { id: system.id, name: system.name, status: system.status },
      conversations: visible,
      hidden_blocked: conversations.length - visible.length,
      total_unread: visible.filter((c) => !c.archived).reduce((s, c) => s + c.unread, 0),
      fetched_at: Date.now(),
    };
  });

  r.get('/api/messages/thread', async (ctx) => {
    const user = await requireUser(ctx);
    const system = await resolveSystem(ctx, ctx.url.searchParams.get('system'));
    const phone = normalizePhone(ctx.url.searchParams.get('phone'));
    if (!phone) fail(400, 'חסר מספר טלפון.');
    const messages = (await fetchMessages(ctx.env, system, { limit: FETCH_LIMIT })).filter((m) => m.phone === phone);
    const contact = await first(ctx.env, 'SELECT * FROM v2_contacts WHERE user_id = ? AND phone = ?', user.id, phone);
    const lastIn = [...messages].reverse().find((m) => !m.out);
    if (lastIn && ctx.url.searchParams.get('mark') === '1') await upsertMeta(ctx.env, user.id, system.id, phone, { last_read: lastIn.time });
    const meta = await first(ctx.env, 'SELECT pinned, archived FROM v2_conv_meta WHERE user_id = ? AND system_id = ? AND phone = ?', user.id, system.id, phone);
    return {
      phone,
      contact,
      messages: messages.map(({ text, time, out, status }) => ({ text, time, out, status })),
      pinned: !!(meta && meta.pinned),
      archived: !!(meta && meta.archived),
    };
  });

  r.post('/api/messages/meta', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    const system = await resolveSystem(ctx, body.system);
    const phone = normalizePhone(body.phone);
    if (!phone) fail(400, 'חסר מספר טלפון.');
    const patch = {};
    if (body.pinned !== undefined) patch.pinned = !!body.pinned;
    if (body.archived !== undefined) patch.archived = !!body.archived;
    if (body.read) patch.last_read = israelParts().stamp;
    await upsertMeta(ctx.env, user.id, system.id, phone, patch);
    return { ok: true };
  });

  r.post('/api/messages/read-all', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    const system = await resolveSystem(ctx, body.system);
    const stamp = israelParts().stamp;
    const messages = await fetchMessages(ctx.env, system, { limit: FETCH_LIMIT });
    const phones = [...new Set(messages.filter((m) => !m.out).map((m) => m.phone))];
    for (let i = 0; i < phones.length; i += 50) {
      await ctx.env.DB.batch(phones.slice(i, i + 50).flatMap((p) => [
        ctx.env.DB.prepare('INSERT OR IGNORE INTO v2_conv_meta (user_id, system_id, phone) VALUES (?, ?, ?)').bind(user.id, system.id, p),
        ctx.env.DB.prepare('UPDATE v2_conv_meta SET last_read = ? WHERE user_id = ? AND system_id = ? AND phone = ?').bind(stamp, user.id, system.id, p),
      ]));
    }
    return { ok: true };
  });

  // שליחה רגילה (עד 5 נמענים)
  r.post('/api/messages/send', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'messages.send');
    await limit(ctx.env, `send:${user.id}`, 30, 60, 'שולחים מהר מדי. המתן רגע ונסה שוב.');
    const body = await readJson(ctx.request);
    const system = await resolveSystem(ctx, body.system);
    const message = checkMessage(body.message);
    let phones = parsePhoneList(body.phones ?? body.phone, 50);
    if (!phones.length) fail(400, 'לא צוין נמען.');
    if (phones.length > 5) await requireFeature(ctx, 'messages.bulk');

    const contacts = await contactMap(ctx.env, user.id);
    const blocked = phones.filter((p) => contacts.get(p) && contacts.get(p).is_blocked);
    phones = phones.filter((p) => !blocked.includes(p));
    if (!phones.length) fail(400, 'הנמען חסום אצלך באנשי הקשר. בטל את החסימה כדי לשלוח.');
    await assertQuota(ctx, phones.length);

    try {
      const r2 = await sendSms(ctx.env, system, phones, message, str(body.from, 20) || undefined);
      await logSend(ctx.env, { userId: user.id, systemId: system.id, via: 'app', recipients: phones.length, preview: message, ok: true });
      for (const p of phones) await upsertMeta(ctx.env, user.id, system.id, p, { last_read: israelParts().stamp });
      return { ok: true, sent: r2.sent, skipped_blocked: blocked };
    } catch (e) {
      await logSend(ctx.env, { userId: user.id, systemId: system.id, via: 'app', recipients: phones.length, preview: message, ok: false, error: e.message });
      throw e;
    }
  });

  // קמפיין / שליחה קבוצתית / תזמון
  r.post('/api/messages/campaign', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'messages.send');
    const body = await readJson(ctx.request, 2_000_000);
    const system = await resolveSystem(ctx, body.system);
    const message = checkMessage(body.message);
    const sendAt = body.send_at ? Number(body.send_at) : Date.now();
    if (!Number.isFinite(sendAt)) fail(400, 'זמן שליחה לא תקין.');
    const scheduled = sendAt > Date.now() + 60_000;
    if (scheduled) {
      await requireFeature(ctx, 'messages.schedule');
      if (sendAt > Date.now() + 366 * 86400_000) fail(400, 'אפשר לתזמן עד שנה קדימה.');
    }
    await limit(ctx.env, `camp:${user.id}`, 20, 3600, 'יותר מדי קמפיינים בשעה האחרונה.');

    // איסוף נמענים: קבוצות + מספרים ידניים
    const recipients = new Map();
    const groupIds = (Array.isArray(body.group_ids) ? body.group_ids : []).map((g) => toInt(g)).filter(Boolean);
    if (groupIds.length) {
      const ph = groupIds.map(() => '?').join(',');
      const rows = await all(ctx.env,
        `SELECT DISTINCT c.phone, c.name FROM v2_contacts c JOIN v2_group_members gm ON gm.contact_id = c.id JOIN v2_groups g ON g.id = gm.group_id
         WHERE c.user_id = ? AND g.user_id = ? AND c.is_blocked = 0 AND gm.group_id IN (${ph})`, user.id, user.id, ...groupIds);
      for (const c of rows) recipients.set(c.phone, c.name || '');
    }
    const contacts = await contactMap(ctx.env, user.id);
    for (const p of parsePhoneList(body.phones || [], 5000)) {
      const c = contacts.get(p);
      if (c && c.is_blocked) continue;
      if (!recipients.has(p)) recipients.set(p, c ? c.name || '' : '');
    }
    if (!recipients.size) fail(400, 'לא נמצאו נמענים (או שכולם חסומים).');
    if (recipients.size > 5) await requireFeature(ctx, 'messages.bulk');
    if (recipients.size > 5000) fail(400, 'מקסימום 5,000 נמענים לקמפיין.');
    await assertQuota(ctx, recipients.size);

    const personalized = /\{(name|first|phone)\}/.test(message);
    const groups = [];
    if (personalized) {
      for (const [phone, name] of recipients) {
        groups.push({ phones: [phone], body: fill(message, { name: name || '', first: (name || '').split(' ')[0], phone }).trim() || message });
      }
    } else {
      const list = [...recipients.keys()];
      for (let i = 0; i < list.length; i += 100) groups.push({ phones: list.slice(i, i + 100), body: message });
    }
    const label = str(body.label, 80) || `${recipients.size} נמענים · ${israelParts(sendAt).stamp.slice(0, 16)}`;
    const res = await enqueue(ctx, { system, groups, sendAt, label, via: scheduled ? 'schedule' : 'bulk' });
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: scheduled ? 'campaign.schedule' : 'campaign.create', detail: { recipients: recipients.size, parts: groups.length }, ip: ctx.ip });
    return { ok: true, recipients: recipients.size, personalized, scheduled, ...res };
  });

  r.get('/api/messages/campaigns', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env,
      `SELECT batch_id, MIN(label) AS label, MIN(body) AS body, MIN(system_id) AS system_id, MIN(send_at) AS send_at, MIN(created_at) AS created_at, MIN(via) AS via,
              COUNT(*) AS parts,
              SUM(json_array_length(phones)) AS recipients,
              SUM(CASE WHEN status = 'sent' THEN json_array_length(phones) ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'failed' THEN json_array_length(phones) ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('pending','sending') THEN json_array_length(phones) ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'canceled' THEN json_array_length(phones) ELSE 0 END) AS canceled,
              MAX(CASE WHEN status = 'failed' THEN result END) AS last_error
       FROM v2_scheduled WHERE user_id = ? GROUP BY batch_id ORDER BY MIN(created_at) DESC LIMIT 100`, user.id);
  });

  r.delete('/api/messages/campaigns/:batch', async (ctx) => {
    const user = await requireUser(ctx);
    const res = await run(ctx.env, "UPDATE v2_scheduled SET status = 'canceled', result = 'בוטל ע\"י המשתמש' WHERE user_id = ? AND batch_id = ? AND status = 'pending'", user.id, ctx.params.batch);
    return { ok: true, canceled: res.meta ? res.meta.changes : 0 };
  });

  r.get('/api/messages/history', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env,
      `SELECT l.id, l.via, l.recipients, l.preview, l.ok, l.error, l.created_at, s.name AS system_name
       FROM v2_send_log l LEFT JOIN v2_systems s ON s.id = l.system_id WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 150`, user.id);
  });

  // סטטיסטיקה ללוח הבקרה: 14 ימים אחרונים + אנשי קשר פעילים
  r.get('/api/messages/stats', async (ctx) => {
    const user = await requireUser(ctx);
    const system = await resolveSystem(ctx, ctx.url.searchParams.get('system'));
    const messages = await fetchMessages(ctx.env, system, { limit: FETCH_LIMIT });
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(israelParts(Date.now() - i * 86400_000).ymd);
    const perDay = Object.fromEntries(days.map((d) => [d, { in: 0, out: 0 }]));
    const byPhone = new Map();
    for (const m of messages) {
      const d = m.time.slice(0, 10);
      if (perDay[d]) perDay[d][m.out ? 'out' : 'in']++;
      byPhone.set(m.phone, (byPhone.get(m.phone) || 0) + 1);
    }
    const contacts = await contactMap(ctx.env, user.id);
    const top = [...byPhone.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([phone, n]) => ({ phone, n, name: contacts.get(phone) ? contacts.get(phone).name : null }));
    const { limits } = await getAccess(ctx);
    const { usedToday } = await import('../lib/quota.js');
    return {
      days: days.map((d) => ({ day: d, ...perDay[d] })),
      top,
      totals: { incoming: messages.filter((m) => !m.out).length, outgoing: messages.filter((m) => m.out).length, contacts: byPhone.size },
      quota: { used: await usedToday(ctx.env, user.id), limit: limits.daily_sms_limit },
    };
  });

  // ייצוא שיחות ל-CSV (עם BOM כדי שאקסל יציג עברית)
  r.get('/api/messages/export', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'messages.export');
    const system = await resolveSystem(ctx, ctx.url.searchParams.get('system'));
    const phone = ctx.url.searchParams.get('phone') ? normalizePhone(ctx.url.searchParams.get('phone')) : null;
    let messages = await fetchMessages(ctx.env, system, { limit: 3000 });
    if (phone) messages = messages.filter((m) => m.phone === phone);
    const contacts = await contactMap(ctx.env, user.id);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['תאריך,כיוון,טלפון,שם,הודעה,סטטוס'];
    for (const m of messages) {
      lines.push([q(m.time), q(m.out ? 'יוצאת' : 'נכנסת'), q(m.phone), q(contacts.get(m.phone) ? contacts.get(m.phone).name : ''), q(m.text), q(m.status || '')].join(','));
    }
    return new Response('\uFEFF' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sms-${system.id}${phone ? '-' + phone : ''}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}

// ייצוא קבצים (CSV) דרך קישור רגיל מהשרת ולא קובץ שנבנה בזיכרון הדפדפן,
// כדי שסינון כמו נטפרי יוכל לבדוק אותו ולאשר אותו. הקישור חתום, מוגבל בזמן ומחזיר רק את הנתונים של המשתמש שיצר אותו.
import { first, all } from '../lib/db.js';
import { fail, readJson, str, toInt } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature } from '../lib/features.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { normalizePhone } from '../lib/validate.js';
import { fetchMessages } from '../lib/yemot.js';
import { resolveSystem } from './systems.js';
import { contactMap } from './messages.js';

const PURPOSE = 'export';
const TTL_MS = 24 * 3600_000; // זמן מספיק לבדיקה ידנית של נטפרי
const FEATURE = { contacts: 'contacts', messages: 'messages.export' };

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (lines) => '﻿' + lines.join('\r\n'); // BOM כדי שאקסל יציג עברית

async function contactsCsv(env, userId, { group, search }) {
  const rows = await all(env,
    `SELECT c.*, (SELECT group_concat(group_id) FROM v2_group_members WHERE contact_id = c.id) AS group_ids
     FROM v2_contacts c WHERE c.user_id = ? ORDER BY c.is_favorite DESC, COALESCE(c.name, c.phone) COLLATE NOCASE`, userId);
  const groups = await all(env, 'SELECT id, name FROM v2_groups WHERE user_id = ?', userId);
  const gname = Object.fromEntries(groups.map((g) => [g.id, g.name]));
  const s = String(search || '').toLowerCase();
  const lines = ['שם,טלפון,מייל,הערות,קבוצות,חסום'];
  for (const c of rows) {
    const ids = c.group_ids ? String(c.group_ids).split(',').map(Number) : [];
    if (group === -1 && !c.is_blocked) continue;
    if (group === -2 && !c.is_favorite) continue;
    if (group > 0 && !ids.includes(group)) continue;
    if (s && !`${c.name || ''} ${c.phone} ${c.email || ''} ${c.notes || ''}`.toLowerCase().includes(s)) continue;
    lines.push([q(c.name), q(c.phone), q(c.email), q(c.notes), q(ids.map((g) => gname[g]).join('; ')), q(c.is_blocked ? 'כן' : '')].join(','));
  }
  return csv(lines);
}

async function messagesCsv(env, userId, system, phone) {
  let messages = await fetchMessages(env, system, { limit: 3000 });
  if (phone) messages = messages.filter((m) => m.phone === phone);
  const contacts = await contactMap(env, userId);
  const lines = ['תאריך,כיוון,טלפון,שם,הודעה,סטטוס'];
  for (const m of messages) {
    lines.push([q(m.time), q(m.out ? 'יוצאת' : 'נכנסת'), q(m.phone), q(contacts.get(m.phone) ? contacts.get(m.phone).name : ''), q(m.text), q(m.status || '')].join(','));
  }
  return csv(lines);
}

export default function exportRoutes(r) {
  // יצירת קישור הורדה (דורש התחברות)
  r.post('/api/exports', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    const kind = body.kind === 'messages' ? 'messages' : body.kind === 'contacts' ? 'contacts' : fail(400, 'סוג ייצוא לא מוכר.');
    await requireFeature(ctx, FEATURE[kind]);
    const payload = { u: user.id, k: kind, exp: Date.now() + TTL_MS };
    let file = 'contacts.csv';
    if (kind === 'messages') {
      const system = await resolveSystem(ctx, body.system);
      const phone = body.phone ? normalizePhone(body.phone) : null;
      Object.assign(payload, { s: system.id, p: phone });
      file = `sms-${system.id}${phone ? '-' + phone : ''}.csv`;
    } else {
      Object.assign(payload, { g: toInt(body.group, 0), q: str(body.q, 100) });
    }
    const token = await signToken(ctx.env, PURPOSE, payload);
    return { ok: true, url: `/api/exports/${token}/${file}`, expires_at: payload.exp };
  });

  // הורדה דרך הקישור החתום (בלי עוגייה)
  r.get('/api/exports/:token/:file', async (ctx) => {
    const p = await verifyToken(ctx.env, PURPOSE, ctx.params.token);
    if (!p) fail(404, 'הקישור אינו תקף או שפג תוקפו. צור קישור חדש מתוך המערכת.');
    const user = await first(ctx.env, 'SELECT * FROM v2_users WHERE id = ?', p.u);
    if (!user || user.status !== 'active') fail(404, 'הקישור אינו תקף.');
    ctx.user = user;
    await requireFeature(ctx, FEATURE[p.k]);
    let content;
    if (p.k === 'messages') {
      const system = await first(ctx.env, 'SELECT * FROM v2_systems WHERE id = ? AND user_id = ?', p.s, user.id);
      if (!system) fail(404, 'המערכת לא נמצאה.');
      content = await messagesCsv(ctx.env, user.id, system, p.p);
    } else {
      content = await contactsCsv(ctx.env, user.id, { group: p.g, search: p.q });
    }
    const name = String(ctx.params.file || 'export.csv').replace(/[^\w.\-]/g, '_');
    return new Response(content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
        'Referrer-Policy': 'no-referrer',
      },
    });
  });
}

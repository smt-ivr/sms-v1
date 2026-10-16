// אנשי קשר, קבוצות ותבניות
import { all, first, run, insertId } from '../lib/db.js';
import { fail, readJson, str, toInt, bool } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature } from '../lib/features.js';
import { normalizePhone, validPhone } from '../lib/validate.js';

const MAX_CONTACTS = 20000;

function readContact(body) {
  const phone = normalizePhone(body.phone);
  if (!validPhone(phone)) fail(400, 'מספר הטלפון אינו תקין.');
  const email = str(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'כתובת המייל של איש הקשר אינה תקינה.');
  return { phone, name: str(body.name, 80) || null, email: email || null, notes: str(body.notes, 1000) || null };
}

async function setGroups(env, userId, contactId, groupIds) {
  if (!Array.isArray(groupIds)) return;
  const valid = await all(env, 'SELECT id FROM v2_groups WHERE user_id = ?', userId);
  const ok = new Set(valid.map((g) => g.id));
  const ids = groupIds.map((g) => toInt(g)).filter((g) => ok.has(g));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM v2_group_members WHERE contact_id = ?').bind(contactId),
    ...ids.map((g) => env.DB.prepare('INSERT OR IGNORE INTO v2_group_members (group_id, contact_id) VALUES (?, ?)').bind(g, contactId)),
  ]);
}

export default function contactRoutes(r) {
  r.get('/api/contacts', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const rows = await all(ctx.env,
      `SELECT c.*, (SELECT group_concat(group_id) FROM v2_group_members WHERE contact_id = c.id) AS group_ids
       FROM v2_contacts c WHERE c.user_id = ? ORDER BY c.is_favorite DESC, COALESCE(c.name, c.phone) COLLATE NOCASE`, user.id);
    return rows.map((c) => ({ ...c, groups: c.group_ids ? String(c.group_ids).split(',').map(Number) : [], group_ids: undefined }));
  });

  r.post('/api/contacts', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const body = await readJson(ctx.request);
    const c = readContact(body);
    const count = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_contacts WHERE user_id = ?', user.id);
    if (count.n >= MAX_CONTACTS) fail(400, 'הגעת למספר המרבי של אנשי קשר.');
    if (await first(ctx.env, 'SELECT id FROM v2_contacts WHERE user_id = ? AND phone = ?', user.id, c.phone)) fail(409, 'איש קשר עם המספר הזה כבר קיים.');
    const t = Date.now();
    const id = await insertId(ctx.env,
      'INSERT INTO v2_contacts (user_id, phone, name, email, notes, is_blocked, is_favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, c.phone, c.name, c.email, c.notes, bool(body.is_blocked), bool(body.is_favorite), t, t);
    await setGroups(ctx.env, user.id, id, body.groups);
    return { ok: true, id };
  });

  r.put('/api/contacts/:id', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const existing = await first(ctx.env, 'SELECT * FROM v2_contacts WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!existing) fail(404, 'איש הקשר לא נמצא.');
    const body = await readJson(ctx.request);
    const c = readContact({ ...existing, ...body });
    if (c.phone !== existing.phone && await first(ctx.env, 'SELECT id FROM v2_contacts WHERE user_id = ? AND phone = ? AND id != ?', user.id, c.phone, existing.id)) {
      fail(409, 'איש קשר אחר כבר משתמש במספר הזה.');
    }
    await run(ctx.env,
      'UPDATE v2_contacts SET phone = ?, name = ?, email = ?, notes = ?, is_blocked = ?, is_favorite = ?, updated_at = ? WHERE id = ?',
      c.phone, c.name, c.email, c.notes,
      body.is_blocked !== undefined ? bool(body.is_blocked) : existing.is_blocked,
      body.is_favorite !== undefined ? bool(body.is_favorite) : existing.is_favorite,
      Date.now(), existing.id);
    await setGroups(ctx.env, user.id, existing.id, body.groups);
    return { ok: true };
  });

  // יצירה/עדכון מהיר לפי טלפון (מתוך מסך השיחה: "שמור איש קשר", "חסום")
  r.post('/api/contacts/upsert', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const body = await readJson(ctx.request);
    const phone = normalizePhone(body.phone);
    if (!validPhone(phone)) fail(400, 'מספר הטלפון אינו תקין.');
    const t = Date.now();
    await run(ctx.env, 'INSERT OR IGNORE INTO v2_contacts (user_id, phone, created_at, updated_at) VALUES (?, ?, ?, ?)', user.id, phone, t, t);
    const sets = [];
    const vals = [];
    if (body.name !== undefined) { sets.push('name = ?'); vals.push(str(body.name, 80) || null); }
    if (body.is_blocked !== undefined) { sets.push('is_blocked = ?'); vals.push(bool(body.is_blocked)); }
    if (body.is_favorite !== undefined) { sets.push('is_favorite = ?'); vals.push(bool(body.is_favorite)); }
    if (body.notes !== undefined) { sets.push('notes = ?'); vals.push(str(body.notes, 1000) || null); }
    if (sets.length) await run(ctx.env, `UPDATE v2_contacts SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ? AND phone = ?`, ...vals, t, user.id, phone);
    return first(ctx.env, 'SELECT * FROM v2_contacts WHERE user_id = ? AND phone = ?', user.id, phone);
  });

  r.delete('/api/contacts/:id', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const id = toInt(ctx.params.id);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM v2_group_members WHERE contact_id IN (SELECT id FROM v2_contacts WHERE id = ? AND user_id = ?)').bind(id, user.id),
      ctx.env.DB.prepare('DELETE FROM v2_contacts WHERE id = ? AND user_id = ?').bind(id, user.id),
    ]);
    return { ok: true };
  });

  r.post('/api/contacts/bulk-delete', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const body = await readJson(ctx.request);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => toInt(x)).filter(Boolean).slice(0, 2000);
    for (let i = 0; i < ids.length; i += 50) {
      await ctx.env.DB.batch(ids.slice(i, i + 50).flatMap((id) => [
        ctx.env.DB.prepare('DELETE FROM v2_group_members WHERE contact_id IN (SELECT id FROM v2_contacts WHERE id = ? AND user_id = ?)').bind(id, user.id),
        ctx.env.DB.prepare('DELETE FROM v2_contacts WHERE id = ? AND user_id = ?').bind(id, user.id),
      ]));
    }
    return { ok: true, deleted: ids.length };
  });

  // ייבוא: הדפדפן מפענח את ה-CSV ושולח מערך
  r.post('/api/contacts/import', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts.import');
    const body = await readJson(ctx.request, 3_000_000);
    const list = Array.isArray(body.contacts) ? body.contacts.slice(0, 5000) : [];
    if (!list.length) fail(400, 'הקובץ ריק או שלא זוהתה עמודת טלפון.');
    const groupId = toInt(body.group_id);
    if (groupId && !(await first(ctx.env, 'SELECT id FROM v2_groups WHERE id = ? AND user_id = ?', groupId, user.id))) fail(400, 'הקבוצה לא נמצאה.');
    const count = (await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_contacts WHERE user_id = ?', user.id)).n;

    const overwrite = !!body.overwrite;
    const t = Date.now();
    let added = 0; let updated = 0; let skipped = 0;
    const valid = [];
    for (const raw of list) {
      const phone = normalizePhone(raw.phone);
      if (!validPhone(phone)) { skipped++; continue; }
      valid.push({ phone, name: str(raw.name, 80) || null, email: str(raw.email, 120) || null, notes: str(raw.notes, 1000) || null });
    }
    if (count + valid.length > MAX_CONTACTS) fail(400, `הייבוא יחרוג מהמקסימום (${MAX_CONTACTS} אנשי קשר).`);

    for (let i = 0; i < valid.length; i += 40) {
      const chunk = valid.slice(i, i + 40);
      const existing = await all(ctx.env, `SELECT phone FROM v2_contacts WHERE user_id = ? AND phone IN (${chunk.map(() => '?').join(',')})`, user.id, ...chunk.map((c) => c.phone));
      const exists = new Set(existing.map((e) => e.phone));
      const stmts = [];
      for (const c of chunk) {
        if (exists.has(c.phone)) {
          if (overwrite) {
            stmts.push(ctx.env.DB.prepare('UPDATE v2_contacts SET name = COALESCE(?, name), email = COALESCE(?, email), notes = COALESCE(?, notes), updated_at = ? WHERE user_id = ? AND phone = ?')
              .bind(c.name, c.email, c.notes, t, user.id, c.phone));
            updated++;
          } else skipped++;
        } else {
          stmts.push(ctx.env.DB.prepare('INSERT INTO v2_contacts (user_id, phone, name, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(user.id, c.phone, c.name, c.email, c.notes, t, t));
          added++;
        }
        if (groupId) {
          stmts.push(ctx.env.DB.prepare('INSERT OR IGNORE INTO v2_group_members (group_id, contact_id) SELECT ?, id FROM v2_contacts WHERE user_id = ? AND phone = ?')
            .bind(groupId, user.id, c.phone));
        }
      }
      if (stmts.length) await ctx.env.DB.batch(stmts);
    }
    return { ok: true, added, updated, skipped };
  });

  // ---------- קבוצות ----------
  r.get('/api/groups', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env,
      `SELECT g.*, (SELECT COUNT(*) FROM v2_group_members gm JOIN v2_contacts c ON c.id = gm.contact_id WHERE gm.group_id = g.id AND c.is_blocked = 0) AS members
       FROM v2_groups g WHERE g.user_id = ? ORDER BY g.name`, user.id);
  });

  r.post('/api/groups', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'contacts');
    const body = await readJson(ctx.request);
    const name = str(body.name, 50);
    if (!name) fail(400, 'נא להזין שם לקבוצה.');
    const n = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_groups WHERE user_id = ?', user.id);
    if (n.n >= 200) fail(400, 'הגעת למספר המרבי של קבוצות.');
    const id = await insertId(ctx.env, 'INSERT INTO v2_groups (user_id, name, color, created_at) VALUES (?, ?, ?, ?)', user.id, name, str(body.color, 9) || null, Date.now());
    return { ok: true, id };
  });

  r.put('/api/groups/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    const name = str(body.name, 50);
    if (!name) fail(400, 'נא להזין שם לקבוצה.');
    await run(ctx.env, 'UPDATE v2_groups SET name = ?, color = ? WHERE id = ? AND user_id = ?', name, str(body.color, 9) || null, toInt(ctx.params.id), user.id);
    return { ok: true };
  });

  r.delete('/api/groups/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const id = toInt(ctx.params.id);
    const g = await first(ctx.env, 'SELECT id FROM v2_groups WHERE id = ? AND user_id = ?', id, user.id);
    if (!g) fail(404, 'הקבוצה לא נמצאה.');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM v2_group_members WHERE group_id = ?').bind(id),
      ctx.env.DB.prepare('DELETE FROM v2_groups WHERE id = ?').bind(id),
    ]);
    return { ok: true };
  });

  r.post('/api/groups/:id/members', async (ctx) => {
    const user = await requireUser(ctx);
    const id = toInt(ctx.params.id);
    if (!(await first(ctx.env, 'SELECT id FROM v2_groups WHERE id = ? AND user_id = ?', id, user.id))) fail(404, 'הקבוצה לא נמצאה.');
    const body = await readJson(ctx.request);
    const ids = (Array.isArray(body.contact_ids) ? body.contact_ids : []).map((x) => toInt(x)).filter(Boolean).slice(0, 5000);
    const add = body.action !== 'remove';
    for (let i = 0; i < ids.length; i += 80) {
      await ctx.env.DB.batch(ids.slice(i, i + 80).map((cid) => add
        ? ctx.env.DB.prepare('INSERT OR IGNORE INTO v2_group_members (group_id, contact_id) SELECT ?, id FROM v2_contacts WHERE id = ? AND user_id = ?').bind(id, cid, user.id)
        : ctx.env.DB.prepare('DELETE FROM v2_group_members WHERE group_id = ? AND contact_id = ?').bind(id, cid)));
    }
    return { ok: true };
  });

  // ---------- תבניות ----------
  r.get('/api/templates', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env, 'SELECT id, name, body, created_at FROM v2_templates WHERE user_id = ? ORDER BY name', user.id);
  });

  r.post('/api/templates', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'templates');
    const body = await readJson(ctx.request);
    const name = str(body.name, 60);
    const text = str(body.body, 1000);
    if (!name || !text) fail(400, 'נא למלא שם ותוכן לתבנית.');
    const n = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_templates WHERE user_id = ?', user.id);
    if (n.n >= 300) fail(400, 'הגעת למספר המרבי של תבניות.');
    const id = await insertId(ctx.env, 'INSERT INTO v2_templates (user_id, name, body, created_at) VALUES (?, ?, ?, ?)', user.id, name, text, Date.now());
    return { ok: true, id };
  });

  r.put('/api/templates/:id', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'templates');
    const body = await readJson(ctx.request);
    const name = str(body.name, 60);
    const text = str(body.body, 1000);
    if (!name || !text) fail(400, 'נא למלא שם ותוכן לתבנית.');
    await run(ctx.env, 'UPDATE v2_templates SET name = ?, body = ? WHERE id = ? AND user_id = ?', name, text, toInt(ctx.params.id), user.id);
    return { ok: true };
  });

  r.delete('/api/templates/:id', async (ctx) => {
    const user = await requireUser(ctx);
    await run(ctx.env, 'DELETE FROM v2_templates WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    return { ok: true };
  });
}

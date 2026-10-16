// צ'אט תמיכה עם מנהל המערכת + התראות
import { all, first, run, insertId, notifyAdmins } from '../lib/db.js';
import { fail, readJson, str, toInt } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature } from '../lib/features.js';
import { limit } from '../lib/ratelimit.js';
import { getSettings } from '../lib/db.js';

async function supportOn(ctx) {
  const s = await getSettings(ctx.env);
  if (s.support_enabled !== '1') fail(403, 'צ׳אט התמיכה סגור כרגע.');
  await requireFeature(ctx, 'support');
}

export default function supportRoutes(r) {
  r.get('/api/support/threads', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env,
      `SELECT t.*, (SELECT body FROM v2_support_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body
       FROM v2_support_threads t WHERE t.user_id = ? ORDER BY t.updated_at DESC`, user.id);
  });

  r.post('/api/support/threads', async (ctx) => {
    const user = await requireUser(ctx);
    await supportOn(ctx);
    await limit(ctx.env, `sup:new:${user.id}`, 5, 3600, 'פתחת כמה פניות בשעה האחרונה. אפשר להמשיך בפנייה קיימת.');
    const body = await readJson(ctx.request);
    const subject = str(body.subject, 100);
    const text = str(body.body, 4000);
    if (!subject || !text) fail(400, 'נא למלא נושא ותוכן.');
    const t = Date.now();
    const id = await insertId(ctx.env, 'INSERT INTO v2_support_threads (user_id, subject, admin_unread, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', user.id, subject, t, t);
    await run(ctx.env, "INSERT INTO v2_support_messages (thread_id, sender_role, sender_id, body, created_at) VALUES (?, 'user', ?, ?, ?)", id, user.id, text, t);
    ctx.waitUntil(notifyAdmins(ctx.env, { title: `פנייה חדשה: ${subject}`, body: `${user.name}: ${text.slice(0, 140)}`, link: `#/admin/support/${id}` }));
    return { ok: true, id };
  });

  r.get('/api/support/threads/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const thread = await first(ctx.env, 'SELECT * FROM v2_support_threads WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!thread) fail(404, 'הפנייה לא נמצאה.');
    const messages = await all(ctx.env,
      `SELECT m.id, m.sender_role, m.body, m.created_at, u.name AS sender_name FROM v2_support_messages m
       LEFT JOIN v2_users u ON u.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id`, thread.id);
    if (thread.user_unread) await run(ctx.env, 'UPDATE v2_support_threads SET user_unread = 0 WHERE id = ?', thread.id);
    return { thread, messages };
  });

  r.post('/api/support/threads/:id/messages', async (ctx) => {
    const user = await requireUser(ctx);
    await supportOn(ctx);
    await limit(ctx.env, `sup:msg:${user.id}`, 30, 600);
    const thread = await first(ctx.env, 'SELECT * FROM v2_support_threads WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!thread) fail(404, 'הפנייה לא נמצאה.');
    const body = await readJson(ctx.request);
    const text = str(body.body, 4000);
    if (!text) fail(400, 'ההודעה ריקה.');
    const t = Date.now();
    await run(ctx.env, "INSERT INTO v2_support_messages (thread_id, sender_role, sender_id, body, created_at) VALUES (?, 'user', ?, ?, ?)", thread.id, user.id, text, t);
    await run(ctx.env, "UPDATE v2_support_threads SET admin_unread = admin_unread + 1, status = 'open', updated_at = ? WHERE id = ?", t, thread.id);
    if (!thread.admin_unread) ctx.waitUntil(notifyAdmins(ctx.env, { title: `תגובה בפנייה: ${thread.subject}`, body: `${user.name}: ${text.slice(0, 140)}`, link: `#/admin/support/${thread.id}` }));
    return { ok: true };
  });

  // ---------- התראות ----------
  r.get('/api/notifications', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env, 'SELECT * FROM v2_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id);
  });

  r.post('/api/notifications/read-all', async (ctx) => {
    const user = await requireUser(ctx);
    await run(ctx.env, 'UPDATE v2_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', user.id);
    return { ok: true };
  });

  r.delete('/api/notifications', async (ctx) => {
    const user = await requireUser(ctx);
    await run(ctx.env, 'DELETE FROM v2_notifications WHERE user_id = ?', user.id);
    return { ok: true };
  });
}

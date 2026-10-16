// תור שליחה: קמפיינים, הודעות מתוזמנות ושליחה מותאמת אישית.
// כל שורה = קריאת SendSms אחת (עד 100 נמענים), כדי להישאר בתוך מגבלת ה-subrequests של Workers.
import { all, first, run, notify } from './db.js';
import { sendSms } from './yemot.js';
import { logSend } from './quota.js';

export async function processRows(env, rows) {
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    // נעילה אופטימית: רק מי שהצליח לעבור מ-pending ל-sending מטפל בשורה
    const lock = await env.DB.prepare("UPDATE v2_scheduled SET status = 'sending' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    if (!lock.meta || !lock.meta.changes) continue;
    const phones = JSON.parse(row.phones || '[]');
    try {
      const user = await first(env, 'SELECT id, status FROM v2_users WHERE id = ?', row.user_id);
      if (!user || user.status !== 'active') throw new Error('החשבון אינו פעיל');
      const system = await first(env, 'SELECT * FROM v2_systems WHERE id = ? AND user_id = ?', row.system_id, row.user_id);
      if (!system) throw new Error('המערכת הוסרה');
      const r = await sendSms(env, system, phones, row.body);
      await run(env, "UPDATE v2_scheduled SET status = 'sent', result = ? WHERE id = ?", `נשלח ל-${r.sent}`, row.id);
      await logSend(env, { userId: row.user_id, systemId: row.system_id, via: row.via || 'bulk', recipients: phones.length, preview: row.body, ok: true });
      sent++;
    } catch (e) {
      await run(env, "UPDATE v2_scheduled SET status = 'failed', result = ? WHERE id = ?", String(e.message || e).slice(0, 300), row.id);
      await logSend(env, { userId: row.user_id, systemId: row.system_id, via: row.via || 'bulk', recipients: phones.length, preview: row.body, ok: false, error: e.message });
      failed++;
    }
  }
  return { sent, failed };
}

export async function processDue(env, max = 40) {
  // שחרור שורות שנתקעו ב-sending (קריסה באמצע) אחרי 10 דקות
  await run(env, "UPDATE v2_scheduled SET status = 'pending' WHERE status = 'sending' AND send_at < ?", Date.now() - 600_000);
  const rows = await all(env, "SELECT * FROM v2_scheduled WHERE status = 'pending' AND send_at <= ? ORDER BY send_at, id LIMIT ?", Date.now(), max);
  if (!rows.length) return { sent: 0, failed: 0 };
  const res = await processRows(env, rows);

  // התראה כשקמפיין הסתיים
  const batches = [...new Set(rows.map((r) => `${r.user_id}|${r.batch_id}`))];
  for (const b of batches) {
    const [userId, batchId] = b.split('|');
    const left = await first(env, "SELECT COUNT(*) AS n FROM v2_scheduled WHERE user_id = ? AND batch_id = ? AND status IN ('pending','sending')", Number(userId), batchId);
    if (left.n === 0) {
      const stats = await first(env,
        "SELECT MIN(label) AS label, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS bad, COUNT(*) AS total FROM v2_scheduled WHERE user_id = ? AND batch_id = ?",
        Number(userId), batchId);
      if (stats.total > 1 || stats.bad > 0) {
        await notify(env, Number(userId), {
          title: stats.bad ? `שליחה "${stats.label || 'קמפיין'}" הסתיימה עם שגיאות` : `שליחה "${stats.label || 'קמפיין'}" הושלמה`,
          body: `${stats.ok} מנות נשלחו${stats.bad ? `, ${stats.bad} נכשלו` : ''}.`,
          link: '#/campaigns',
        });
      }
    }
  }
  return res;
}

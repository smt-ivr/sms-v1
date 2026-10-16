// משימות מתוזמנות — רץ כל דקה (ראה triggers ב-wrangler.toml)
import { run, getSettings } from './lib/db.js';
import { processDue } from './lib/queue.js';
import { runRules } from './lib/rules.js';
import { israelParts } from './lib/validate.js';

export async function runCron(env, scheduledTime = Date.now()) {
  // מגבלת subrequests: 50 בתוכנית החינמית, 1000 בתוכנית בתשלום. ניתן להגדיל דרך SUBREQUEST_BUDGET
  const budget = { left: Number(env.SUBREQUEST_BUDGET || 45) };
  const report = {};

  // 1) תור השליחה (קמפיינים ותזמונים)
  const queueMax = Math.max(1, Math.min(200, Math.floor(budget.left / 2)));
  report.queue = await processDue(env, queueMax);
  budget.left -= report.queue.sent + report.queue.failed;

  // 2) אוטומציות — כל X דקות
  const settings = await getSettings(env, true);
  const every = Math.max(1, Number(settings.rules_poll_minutes || 2));
  const minuteIndex = Math.floor(scheduledTime / 60_000);
  if (minuteIndex % every === 0 && budget.left > 3) {
    report.rules = await runRules(env, { budget });
  }

  // 3) ניקוי לילי (03:00 שעון ישראל)
  if (israelParts(scheduledTime).minutes === 180) {
    const t = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM v2_sessions WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM v2_email_codes WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM v2_rate WHERE window_start < ?').bind(t - 86400_000),
      env.DB.prepare('DELETE FROM v2_audit WHERE created_at < ?').bind(t - 180 * 86400_000),
      env.DB.prepare('DELETE FROM v2_send_log WHERE created_at < ?').bind(t - 365 * 86400_000),
      env.DB.prepare('DELETE FROM v2_notifications WHERE is_read = 1 AND created_at < ?').bind(t - 60 * 86400_000),
      env.DB.prepare('DELETE FROM v2_autoreply_log WHERE sent_at < ?').bind(t - 60 * 86400_000),
      env.DB.prepare("DELETE FROM v2_scheduled WHERE status IN ('sent','failed','canceled') AND created_at < ?").bind(t - 90 * 86400_000),
      env.DB.prepare('UPDATE v2_announcements SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < ?').bind(t),
    ]);
    report.cleanup = true;
  }
  await run(env, "INSERT INTO v2_settings (key, value) VALUES ('cron_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
  return report;
}

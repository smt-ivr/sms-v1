// מכסת הודעות יומית (לפי יום בשעון ישראל) ורישום שליחות
import { first, run } from './db.js';
import { fail } from './http.js';
import { israelDayStart } from './validate.js';
import { getAccess } from './features.js';

export async function usedToday(env, userId) {
  const r = await first(env, 'SELECT COALESCE(SUM(recipients),0) AS n FROM v2_send_log WHERE user_id = ? AND ok = 1 AND created_at >= ?', userId, israelDayStart());
  return r ? r.n : 0;
}

export async function assertQuota(ctx, count) {
  const { limits } = await getAccess(ctx);
  if (limits.daily_sms_limit === null || limits.daily_sms_limit === undefined) return;
  const used = await usedToday(ctx.env, ctx.user.id);
  if (used + count > limits.daily_sms_limit) {
    fail(429, `חריגה מהמכסה היומית: נשלחו היום ${used} מתוך ${limits.daily_sms_limit} הודעות. ניסיון לשלוח ל-${count} נמענים נוספים.`, 'quota');
  }
}

export async function logSend(env, { userId, systemId, via, recipients, preview, ok, error = null, actor = null }) {
  await run(env,
    'INSERT INTO v2_send_log (user_id, system_id, via, recipients, preview, ok, error, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId, systemId, via, recipients, String(preview || '').slice(0, 120), ok ? 1 : 0, error ? String(error).slice(0, 300) : null, actor, Date.now());
}

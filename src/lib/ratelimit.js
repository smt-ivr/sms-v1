// הגבלת קצב מבוססת D1 (חלון קבוע)
import { fail } from './http.js';

export async function hit(env, key, limit, windowSec) {
  const nowMs = Date.now();
  const windowStart = nowMs - (nowMs % (windowSec * 1000));
  const row = await env.DB.prepare(
    `INSERT INTO v2_rate (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN v2_rate.window_start = excluded.window_start THEN v2_rate.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`
  ).bind(key, windowStart).first();
  return { count: row ? row.count : 1, allowed: (row ? row.count : 1) <= limit };
}

export async function limit(env, key, max, windowSec, message) {
  const r = await hit(env, key, max, windowSec);
  if (!r.allowed) fail(429, message || 'יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.', 'rate_limited');
}

export async function resetLimit(env, key) {
  await env.DB.prepare('DELETE FROM v2_rate WHERE key = ?').bind(key).run();
}

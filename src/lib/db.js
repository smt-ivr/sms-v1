// עזרי מסד נתונים, הגדרות, יומן ביקורת והתראות

export async function all(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

export async function first(env, sql, ...args) {
  return (await env.DB.prepare(sql).bind(...args).first()) || null;
}

export async function run(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}

export async function insertId(env, sql, ...args) {
  const res = await env.DB.prepare(sql).bind(...args).run();
  return res.meta && res.meta.last_row_id;
}

// ---------- הגדרות ----------
const SETTINGS_TTL = 15_000;
let settingsCache = null;
let settingsAt = 0;

export async function getSettings(env, fresh = false) {
  if (!fresh && settingsCache && Date.now() - settingsAt < SETTINGS_TTL) return settingsCache;
  const rows = await all(env, 'SELECT key, value FROM v2_settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  settingsCache = out;
  settingsAt = Date.now();
  return out;
}

export async function setSettings(env, patch) {
  const stmts = Object.entries(patch).map(([k, v]) =>
    env.DB.prepare('INSERT INTO v2_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(k, v === null || v === undefined ? null : String(v)));
  if (stmts.length) await env.DB.batch(stmts);
  settingsCache = null;
}

// ---------- יומן ביקורת ----------
export async function audit(env, { userId = null, actorId = null, action, detail = null, ip = null }) {
  try {
    await run(env, 'INSERT INTO v2_audit (user_id, actor_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId, actorId, action, detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000) : null, ip, Date.now());
  } catch (e) {
    console.error('audit failed', e);
  }
}

// ---------- התראות בתוך האפליקציה ----------
export async function notify(env, userId, { title, body = null, link = null }) {
  await run(env, 'INSERT INTO v2_notifications (user_id, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, String(title).slice(0, 200), body ? String(body).slice(0, 2000) : null, link, Date.now());
}

export async function notifyAdmins(env, payload) {
  const admins = await all(env, "SELECT id FROM v2_users WHERE role IN ('admin','owner') AND status = 'active'");
  for (const a of admins) await notify(env, a.id, payload);
}

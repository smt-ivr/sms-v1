// ניהול סשנים: העוגייה מכילה טוקן אקראי, במסד נשמר רק ה-SHA-256 שלו
import { first, run, getSettings } from './db.js';
import { randomToken, sha256 } from './crypto.js';
import { cookie, parseCookies, fail } from './http.js';

export const USER_COOKIE = 'smt2_s';
export const GUEST_COOKIE = 'smt2_g';
const USER_TTL_DAYS = 30;
const GUEST_TTL_HOURS = 12;

const isSecure = (request) => new URL(request.url).protocol === 'https:';

export async function createSession(ctx, { kind = 'user', userId = null, shareId = null, impersonatorId = null, ttlMs } = {}) {
  const token = randomToken(32);
  const id = await sha256(token);
  const t = Date.now();
  const ttl = ttlMs || (kind === 'guest' ? GUEST_TTL_HOURS * 3600_000 : USER_TTL_DAYS * 86400_000);
  await run(ctx.env,
    `INSERT INTO v2_sessions (id, kind, user_id, share_id, impersonator_id, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, kind, userId, shareId, impersonatorId, ctx.ip, (ctx.request.headers.get('User-Agent') || '').slice(0, 300), t, t, t + ttl);
  const name = kind === 'guest' ? GUEST_COOKIE : USER_COOKIE;
  return cookie(name, token, { maxAge: Math.floor(ttl / 1000), secure: isSecure(ctx.request) });
}

export function clearCookie(ctx, kind = 'user') {
  return cookie(kind === 'guest' ? GUEST_COOKIE : USER_COOKIE, '', { maxAge: 0, secure: isSecure(ctx.request) });
}

export async function sessionIdFromRequest(request, kind = 'user') {
  const token = parseCookies(request)[kind === 'guest' ? GUEST_COOKIE : USER_COOKIE];
  return token ? sha256(token) : null;
}

export async function destroyCurrentSession(ctx, kind = 'user') {
  const id = await sessionIdFromRequest(ctx.request, kind);
  if (id) await run(ctx.env, 'DELETE FROM v2_sessions WHERE id = ?', id);
}

async function loadSession(ctx, kind) {
  const id = await sessionIdFromRequest(ctx.request, kind);
  if (!id) return null;
  const s = await first(ctx.env, 'SELECT * FROM v2_sessions WHERE id = ? AND kind = ?', id, kind);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE id = ?', id);
    return null;
  }
  if (Date.now() - s.last_seen_at > 5 * 60_000) {
    ctx.waitUntil(run(ctx.env, 'UPDATE v2_sessions SET last_seen_at = ?, ip = ? WHERE id = ?', Date.now(), ctx.ip, id));
  }
  return s;
}

// הגנת CSRF: כל בקשה משנה-מצב חייבת header מותאם (דפדפן לא שולח אותו בין-אתרים בלי CORS)
export function checkCsrf(ctx) {
  const m = ctx.request.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
  if (ctx.request.headers.get('X-Requested-With') !== 'smt2') fail(403, 'בקשה לא מורשית (CSRF).', 'csrf');
}

export async function optionalUser(ctx) {
  const s = await loadSession(ctx, 'user');
  if (!s) return null;
  const user = await first(ctx.env, 'SELECT * FROM v2_users WHERE id = ?', s.user_id);
  if (!user) return null;
  ctx.session = s;
  ctx.user = user;
  return user;
}

export async function requireUser(ctx) {
  checkCsrf(ctx);
  const user = await optionalUser(ctx);
  if (!user) fail(401, 'יש להתחבר מחדש.', 'unauthenticated');
  if (user.status === 'blocked') {
    fail(403, user.block_reason ? `החשבון חסום: ${user.block_reason}` : 'החשבון חסום. פנה למנהל המערכת.', 'blocked');
  }
  if (user.status === 'pending') fail(403, 'החשבון ממתין לאישור מנהל.', 'pending');
  const isAdmin = user.role === 'admin' || user.role === 'owner';
  if (!isAdmin) {
    const settings = await getSettings(ctx.env);
    if (settings.maintenance === '1') fail(503, settings.maintenance_message || 'המערכת בתחזוקה.', 'maintenance');
  }
  return user;
}

export async function requireAdmin(ctx) {
  const user = await requireUser(ctx);
  if (user.role !== 'admin' && user.role !== 'owner') fail(403, 'אין לך הרשאת ניהול.', 'forbidden');
  if (ctx.session.impersonator_id) fail(403, 'לא ניתן לבצע פעולות ניהול בזמן התחזות.', 'forbidden');
  return user;
}

export async function requireGuest(ctx) {
  checkCsrf(ctx);
  const s = await loadSession(ctx, 'guest');
  if (!s) fail(401, 'הגישה פגה. הזן את הקוד מחדש.', 'unauthenticated');
  const share = await first(ctx.env, 'SELECT * FROM v2_shares WHERE id = ?', s.share_id);
  if (!share || !share.is_active) fail(401, 'קוד הגישה בוטל.', 'unauthenticated');
  if (share.expires_at && share.expires_at < Date.now()) fail(401, 'תוקף קוד הגישה הסתיים.', 'unauthenticated');
  const owner = await first(ctx.env, 'SELECT * FROM v2_users WHERE id = ?', share.user_id);
  if (!owner || owner.status !== 'active') fail(401, 'הגישה אינה זמינה כרגע.', 'unauthenticated');
  ctx.session = s;
  ctx.share = share;
  ctx.user = owner; // הפעולות מתבצעות בשם בעל החשבון, בכפוף להרשאות הקוד
  return share;
}

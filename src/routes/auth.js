// הרשמה חכמה, התחברות, איפוס סיסמה, פרופיל ומכשירים
import { all, first, run, insertId, getSettings, audit, notifyAdmins } from '../lib/db.js';
import { json, fail, readJson, str } from '../lib/http.js';
import { hashPassword, verifyPassword, randomDigits, sha256 } from '../lib/crypto.js';
import { normalizeEmail, canonicalEmail, isDisposable, checkPassword, israelParts } from '../lib/validate.js';
import { limit, resetLimit } from '../lib/ratelimit.js';
import { createSession, clearCookie, destroyCurrentSession, requireUser, optionalUser } from '../lib/session.js';
import { resolveAccess, getAccess } from '../lib/features.js';
import { usedToday } from '../lib/quota.js';
import { mailVerifyCode, mailResetCode, mailWelcome, mailLoginAlert } from '../lib/email.js';

const CODE_TTL = 15 * 60_000;
const RESEND_COOLDOWN = 60_000;
const MAX_ATTEMPTS = 5;
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function issueCode(ctx, canonical, purpose, payload) {
  const code = randomDigits(6);
  const t = Date.now();
  await run(ctx.env, 'DELETE FROM v2_email_codes WHERE email_canonical = ? AND purpose = ?', canonical, purpose);
  await run(ctx.env,
    'INSERT INTO v2_email_codes (email_canonical, purpose, code_hash, payload, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    canonical, purpose, await sha256(code), payload ? JSON.stringify(payload) : null, ctx.ip, t, t + CODE_TTL);
  return code;
}

async function consumeCode(ctx, canonical, purpose, code) {
  const row = await first(ctx.env, 'SELECT * FROM v2_email_codes WHERE email_canonical = ? AND purpose = ? ORDER BY id DESC LIMIT 1', canonical, purpose);
  if (!row || row.expires_at < Date.now()) fail(400, 'הקוד פג תוקף. בקש קוד חדש.', 'code_expired');
  if (row.attempts >= MAX_ATTEMPTS) {
    await run(ctx.env, 'DELETE FROM v2_email_codes WHERE id = ?', row.id);
    fail(400, 'יותר מדי ניסיונות שגויים. בקש קוד חדש.', 'code_expired');
  }
  if ((await sha256(String(code || '').trim())) !== row.code_hash) {
    await run(ctx.env, 'UPDATE v2_email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    fail(400, left > 0 ? `הקוד שגוי. נותרו ${left} ניסיונות.` : 'הקוד שגוי. בקש קוד חדש.', 'code_wrong');
  }
  await run(ctx.env, 'DELETE FROM v2_email_codes WHERE id = ?', row.id);
  return row.payload ? JSON.parse(row.payload) : null;
}

function isOwnerEmail(env, canonical) {
  const list = String(env.OWNER_EMAIL || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.some((e) => { try { return canonicalEmail(normalizeEmail(e)) === canonical; } catch { return false; } });
}

export default function authRoutes(r) {
  // ---------- תצורה ציבורית למסך הכניסה ----------
  r.get('/api/public/config', async (ctx) => {
    const s = await getSettings(ctx.env);
    return { app_name: s.app_name, registration_mode: s.registration_mode, maintenance: s.maintenance === '1', maintenance_message: s.maintenance_message };
  });

  // ---------- הרשמה: שלב 1 ----------
  r.post('/api/auth/register/start', async (ctx) => {
    const body = await readJson(ctx.request);
    const s = await getSettings(ctx.env);
    if (s.registration_mode === 'closed') fail(403, 'ההרשמה סגורה כרגע. פנה למנהל המערכת.');
    if (str(body.website)) return { ok: true }; // מלכודת בוטים

    const name = str(body.name, 80);
    if (name.length < 2) fail(400, 'נא להזין שם מלא או שם עסק.');
    const email = normalizeEmail(body.email);
    const canonical = canonicalEmail(email);
    const password = checkPassword(body.password);

    await limit(ctx.env, `reg:ip:${ctx.ip}`, 10, 3600, 'יותר מדי ניסיונות הרשמה מהרשת שלך. נסה שוב בעוד שעה.');
    await limit(ctx.env, `reg:em:${canonical}`, 5, 3600);

    if (s.block_disposable_emails === '1' && isDisposable(email)) fail(400, 'לא ניתן להירשם עם כתובת מייל זמנית.');
    if (await first(ctx.env, 'SELECT id FROM v2_users WHERE email_canonical = ?', canonical)) {
      fail(409, 'כבר קיים חשבון עם כתובת המייל הזו. אפשר להתחבר או לאפס סיסמה.', 'email_taken');
    }
    const perIp = Number(s.signups_per_ip_per_day || 3);
    if (perIp > 0) {
      const c = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_users WHERE signup_ip = ? AND created_at > ?', ctx.ip, Date.now() - 86400_000);
      if (c && c.n >= perIp) fail(429, 'נפתחו יותר מדי חשבונות מהרשת שלך היום.');
    }
    const prev = await first(ctx.env, "SELECT created_at FROM v2_email_codes WHERE email_canonical = ? AND purpose = 'register'", canonical);
    if (prev && Date.now() - prev.created_at < RESEND_COOLDOWN) {
      fail(429, `קוד נשלח זה עתה. אפשר לבקש שוב בעוד ${Math.ceil((RESEND_COOLDOWN - (Date.now() - prev.created_at)) / 1000)} שניות.`);
    }

    const code = await issueCode(ctx, canonical, 'register', { name, email, password_hash: await hashPassword(password) });
    const sent = await mailVerifyCode(ctx.env, email, name, code);
    if (!sent.ok) {
      await run(ctx.env, "DELETE FROM v2_email_codes WHERE email_canonical = ? AND purpose = 'register'", canonical);
      fail(502, sent.error);
    }
    return { ok: true, email, resend_after: RESEND_COOLDOWN / 1000 };
  });

  r.post('/api/auth/register/resend', async (ctx) => {
    const body = await readJson(ctx.request);
    const canonical = canonicalEmail(normalizeEmail(body.email));
    await limit(ctx.env, `reg:em:${canonical}`, 5, 3600);
    const row = await first(ctx.env, "SELECT * FROM v2_email_codes WHERE email_canonical = ? AND purpose = 'register'", canonical);
    if (!row) fail(400, 'לא נמצאה הרשמה פתוחה. התחל מחדש.');
    if (Date.now() - row.created_at < RESEND_COOLDOWN) fail(429, 'אפשר לבקש קוד חדש פעם בדקה.');
    const payload = JSON.parse(row.payload);
    const code = await issueCode(ctx, canonical, 'register', payload);
    const sent = await mailVerifyCode(ctx.env, payload.email, payload.name, code);
    if (!sent.ok) fail(502, sent.error);
    return { ok: true, resend_after: RESEND_COOLDOWN / 1000 };
  });

  // ---------- הרשמה: שלב 2 (אימות) ----------
  r.post('/api/auth/register/verify', async (ctx) => {
    const body = await readJson(ctx.request);
    const email = normalizeEmail(body.email);
    const canonical = canonicalEmail(email);
    await limit(ctx.env, `regv:ip:${ctx.ip}`, 30, 900);
    const payload = await consumeCode(ctx, canonical, 'register', body.code);
    if (await first(ctx.env, 'SELECT id FROM v2_users WHERE email_canonical = ?', canonical)) fail(409, 'החשבון כבר קיים. אפשר להתחבר.');

    const s = await getSettings(ctx.env);
    const owner = isOwnerEmail(ctx.env, canonical)
      || (!ctx.env.OWNER_EMAIL && !(await first(ctx.env, "SELECT id FROM v2_users WHERE role = 'owner'")));
    const status = owner || s.registration_mode !== 'approval' ? 'active' : 'pending';
    let plan = (await first(ctx.env, 'SELECT key FROM v2_plans WHERE key = ?', s.default_plan || 'free')) ? (s.default_plan || 'free') : 'free';
    if (owner) { const top = await first(ctx.env, 'SELECT key FROM v2_plans ORDER BY sort DESC LIMIT 1'); if (top) plan = top.key; }

    const userId = await insertId(ctx.env,
      `INSERT INTO v2_users (email, email_canonical, name, password_hash, role, status, plan, signup_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payload.email, canonical, payload.name, payload.password_hash, owner ? 'owner' : 'user', status, plan, ctx.ip, Date.now());

    // ערכי פיצ'רים שהמנהל קבע "לחשבונות חדשים בלבד"
    const defaults = await all(ctx.env, 'SELECT key, new_user_value FROM v2_features WHERE new_user_value IS NOT NULL');
    if (defaults.length) {
      await ctx.env.DB.batch(defaults.map((d) =>
        ctx.env.DB.prepare('INSERT OR REPLACE INTO v2_user_features (user_id, key, value) VALUES (?, ?, ?)').bind(userId, d.key, d.new_user_value)));
    }

    await audit(ctx.env, { userId, actorId: userId, action: 'user.register', detail: { status, plan }, ip: ctx.ip });
    ctx.waitUntil(notifyAdmins(ctx.env, {
      title: status === 'pending' ? 'הרשמה חדשה ממתינה לאישור' : 'משתמש חדש נרשם',
      body: `${payload.name} (${payload.email})`, link: `#/admin/users/${userId}`,
    }));
    ctx.waitUntil(mailWelcome(ctx.env, payload.email, payload.name, status === 'pending'));

    if (status !== 'active') return { ok: true, status };
    const setCookie = await createSession(ctx, { userId });
    return json({ ok: true, status }, 200, { 'Set-Cookie': setCookie });
  });

  // ---------- התחברות ----------
  r.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.request);
    const email = normalizeEmail(body.email);
    const canonical = canonicalEmail(email);
    await limit(ctx.env, `login:ip:${ctx.ip}`, 30, 900);
    await limit(ctx.env, `login:em:${canonical}`, 8, 900, 'יותר מדי ניסיונות כניסה לחשבון הזה. נסה שוב בעוד 15 דקות או אפס סיסמה.');

    const user = await first(ctx.env, 'SELECT * FROM v2_users WHERE email_canonical = ?', canonical);
    const okPass = await verifyPassword(String(body.password || ''), user ? user.password_hash : DUMMY_HASH);
    if (!user || !okPass) {
      if (user) await audit(ctx.env, { userId: user.id, action: 'login.failed', ip: ctx.ip });
      fail(401, 'אימייל או סיסמה שגויים.');
    }
    if (user.status === 'blocked') fail(403, user.block_reason ? `החשבון חסום: ${user.block_reason}` : 'החשבון חסום. פנה למנהל המערכת.', 'blocked');
    if (user.status === 'pending') fail(403, 'החשבון ממתין לאישור מנהל. נעדכן אותך במייל.', 'pending');
    const s = await getSettings(ctx.env);
    const isAdmin = user.role === 'admin' || user.role === 'owner';
    if (s.maintenance === '1' && !isAdmin) fail(503, s.maintenance_message || 'המערכת בתחזוקה.', 'maintenance');

    await resetLimit(ctx.env, `login:em:${canonical}`);
    const knownIp = await first(ctx.env, "SELECT id FROM v2_audit WHERE user_id = ? AND action = 'login' AND ip = ? LIMIT 1", user.id, ctx.ip);
    if (s.login_alerts === '1' && user.last_login_at && !knownIp) {
      ctx.waitUntil(mailLoginAlert(ctx.env, user.email, user.name, {
        ip: ctx.ip, ua: ctx.request.headers.get('User-Agent') || '', when: israelParts().stamp,
      }));
    }
    await run(ctx.env, 'UPDATE v2_users SET last_login_at = ?, last_ip = ? WHERE id = ?', Date.now(), ctx.ip, user.id);
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'login', ip: ctx.ip });
    const setCookie = await createSession(ctx, { userId: user.id });
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
  });

  r.post('/api/auth/logout', async (ctx) => {
    await destroyCurrentSession(ctx, 'user');
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ctx, 'user') });
  });

  // ---------- שכחתי סיסמה ----------
  r.post('/api/auth/forgot', async (ctx) => {
    const body = await readJson(ctx.request);
    const email = normalizeEmail(body.email);
    const canonical = canonicalEmail(email);
    await limit(ctx.env, `forgot:ip:${ctx.ip}`, 10, 3600);
    await limit(ctx.env, `forgot:em:${canonical}`, 3, 900, 'כבר נשלח קוד לאחרונה. בדוק את תיבת המייל (גם בספאם).');
    const user = await first(ctx.env, "SELECT * FROM v2_users WHERE email_canonical = ? AND status != 'blocked'", canonical);
    if (user) {
      const code = await issueCode(ctx, canonical, 'reset', null);
      ctx.waitUntil(mailResetCode(ctx.env, user.email, user.name, code));
    }
    return { ok: true }; // תמיד אותה תשובה — לא חושפים אם המייל רשום
  });

  r.post('/api/auth/reset', async (ctx) => {
    const body = await readJson(ctx.request);
    const canonical = canonicalEmail(normalizeEmail(body.email));
    const password = checkPassword(body.password);
    await limit(ctx.env, `reset:ip:${ctx.ip}`, 20, 900);
    const user = await first(ctx.env, 'SELECT * FROM v2_users WHERE email_canonical = ?', canonical);
    if (!user) fail(400, 'הקוד פג תוקף. בקש קוד חדש.');
    await consumeCode(ctx, canonical, 'reset', body.code);
    await run(ctx.env, 'UPDATE v2_users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE user_id = ?', user.id);
    await resetLimit(ctx.env, `login:em:${canonical}`);
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'password.reset', ip: ctx.ip });
    return { ok: true };
  });

  // ---------- המשתמש המחובר ----------
  r.get('/api/me', async (ctx) => {
    const user = await requireUser(ctx);
    const access = await getAccess(ctx);
    const [systems, smsToday, notif, support, announcements, settings] = await Promise.all([
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_systems WHERE user_id = ?', user.id),
      usedToday(ctx.env, user.id).then((n) => ({ n })),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_notifications WHERE user_id = ? AND is_read = 0', user.id),
      first(ctx.env, 'SELECT COALESCE(SUM(user_unread),0) AS n FROM v2_support_threads WHERE user_id = ?', user.id),
      all(ctx.env, 'SELECT id, title, body, level FROM v2_announcements WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 3', Date.now()),
      getSettings(ctx.env),
    ]);
    let impersonator = null;
    if (ctx.session.impersonator_id) {
      impersonator = await first(ctx.env, 'SELECT id, name FROM v2_users WHERE id = ?', ctx.session.impersonator_id);
    }
    let adminCounts = null;
    if (user.role === 'admin' || user.role === 'owner') {
      const [pending, openThreads] = await Promise.all([
        first(ctx.env, "SELECT COUNT(*) AS n FROM v2_users WHERE status = 'pending'"),
        first(ctx.env, 'SELECT COALESCE(SUM(admin_unread),0) AS n FROM v2_support_threads'),
      ]);
      adminCounts = { pending: pending.n, support_unread: openThreads.n };
    }
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, created_at: user.created_at },
      plan: access.plan,
      features: access.features,
      limits: access.limits,
      usage: { systems: systems.n, sms_today: smsToday.n },
      unread: { notifications: notif.n, support: support.n },
      admin: adminCounts,
      announcements,
      impersonator,
      app: { name: settings.app_name, maintenance: settings.maintenance === '1', support_enabled: settings.support_enabled === '1' },
    };
  });

  r.put('/api/me', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    const name = str(body.name, 80);
    if (name.length < 2) fail(400, 'השם קצר מדי.');
    await run(ctx.env, 'UPDATE v2_users SET name = ? WHERE id = ?', name, user.id);
    return { ok: true };
  });

  r.post('/api/me/password', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    await limit(ctx.env, `pw:${user.id}`, 10, 900);
    if (!(await verifyPassword(String(body.current || ''), user.password_hash))) fail(400, 'הסיסמה הנוכחית שגויה.');
    const next = checkPassword(body.next);
    await run(ctx.env, 'UPDATE v2_users SET password_hash = ? WHERE id = ?', await hashPassword(next), user.id);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE user_id = ? AND id != ?', user.id, ctx.session.id);
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'password.change', ip: ctx.ip });
    return { ok: true };
  });

  r.get('/api/me/sessions', async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await all(ctx.env,
      "SELECT rowid AS rid, id, ip, user_agent, created_at, last_seen_at, impersonator_id FROM v2_sessions WHERE user_id = ? AND kind = 'user' AND expires_at > ? ORDER BY last_seen_at DESC",
      user.id, Date.now());
    return rows.map((s) => ({ id: s.rid, ip: s.ip, user_agent: s.user_agent, created_at: s.created_at, last_seen_at: s.last_seen_at, current: s.id === ctx.session.id, support: !!s.impersonator_id }));
  });

  r.delete('/api/me/sessions/:id', async (ctx) => {
    const user = await requireUser(ctx);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE rowid = ? AND user_id = ?', Number(ctx.params.id), user.id);
    return { ok: true };
  });

  r.post('/api/me/sessions/revoke-others', async (ctx) => {
    const user = await requireUser(ctx);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE user_id = ? AND id != ?', user.id, ctx.session.id);
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'sessions.revoke_others', ip: ctx.ip });
    return { ok: true };
  });

  r.get('/api/me/activity', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env, 'SELECT action, detail, ip, created_at FROM v2_audit WHERE user_id = ? ORDER BY id DESC LIMIT 60', user.id);
  });

  r.post('/api/me/delete', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    if (user.role === 'owner') fail(400, 'בעל המערכת לא יכול למחוק את עצמו.');
    if (!(await verifyPassword(String(body.password || ''), user.password_hash))) fail(400, 'הסיסמה שגויה.');
    const { deleteUserCascade } = await import('./admin.js');
    await deleteUserCascade(ctx.env, user.id);
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'user.self_delete', ip: ctx.ip });
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ctx, 'user') });
  });

  // יציאה מהתחזות — חזרה לחשבון המנהל
  r.post('/api/auth/impersonate/stop', async (ctx) => {
    const user = await optionalUser(ctx);
    if (!user || !ctx.session.impersonator_id) fail(400, 'אין התחזות פעילה.');
    const adminId = ctx.session.impersonator_id;
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE id = ?', ctx.session.id);
    await audit(ctx.env, { userId: user.id, actorId: adminId, action: 'admin.impersonate.stop', ip: ctx.ip });
    const setCookie = await createSession(ctx, { userId: adminId });
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
  });

  // משמש לבדיקות: מחזיר את ההרשאות בפועל
  r.get('/api/me/access', async (ctx) => {
    const user = await requireUser(ctx);
    return resolveAccess(ctx.env, user);
  });
}

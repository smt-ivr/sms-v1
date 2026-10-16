// פאנל ניהול: משתמשים, הרשאות, חבילות, מתגי פיצ'רים, הגדרות, תמיכה, הודעות, ביקורת
import { all, first, run, insertId, getSettings, setSettings, audit, notify } from '../lib/db.js';
import { json, fail, readJson, str, toInt, bool } from '../lib/http.js';
import { requireAdmin, createSession, destroyCurrentSession } from '../lib/session.js';
import { resolveAccess } from '../lib/features.js';
import { hashPassword } from '../lib/crypto.js';
import { normalizeEmail, canonicalEmail, checkPassword, israelParts, israelDayStart } from '../lib/validate.js';
import { mailApproved, mailResetCode, mailGeneric, mailBroadcast, mailTest } from '../lib/email.js';
import { issueCode } from './auth.js';

const ROLES = ['user', 'admin', 'owner'];
const STATUSES = ['active', 'pending', 'blocked'];

export async function deleteUserCascade(env, userId) {
  const q = (sql) => env.DB.prepare(sql).bind(userId);
  await env.DB.batch([
    q('DELETE FROM v2_autoreply_log WHERE rule_id IN (SELECT id FROM v2_rules WHERE user_id = ?)'),
    q('DELETE FROM v2_rules WHERE user_id = ?'),
    q('DELETE FROM v2_sessions WHERE share_id IN (SELECT id FROM v2_shares WHERE user_id = ?)'),
    q('DELETE FROM v2_shares WHERE user_id = ?'),
    q('DELETE FROM v2_group_members WHERE group_id IN (SELECT id FROM v2_groups WHERE user_id = ?)'),
    q('DELETE FROM v2_groups WHERE user_id = ?'),
    q('DELETE FROM v2_contacts WHERE user_id = ?'),
    q('DELETE FROM v2_templates WHERE user_id = ?'),
    q('DELETE FROM v2_scheduled WHERE user_id = ?'),
    q('DELETE FROM v2_conv_meta WHERE user_id = ?'),
    q('DELETE FROM v2_api_keys WHERE user_id = ?'),
    q('DELETE FROM v2_support_messages WHERE thread_id IN (SELECT id FROM v2_support_threads WHERE user_id = ?)'),
    q('DELETE FROM v2_support_threads WHERE user_id = ?'),
    q('DELETE FROM v2_notifications WHERE user_id = ?'),
    q('DELETE FROM v2_user_features WHERE user_id = ?'),
    q('DELETE FROM v2_systems WHERE user_id = ?'),
    q('DELETE FROM v2_sessions WHERE user_id = ?'),
    q('DELETE FROM v2_users WHERE id = ?'),
  ]);
}

// מי רשאי לנהל את מי
function assertCanManage(actor, target) {
  if (target.role === 'owner' && actor.id !== target.id) fail(403, 'אי אפשר לשנות את בעל המערכת.');
  if (target.role === 'admin' && actor.role !== 'owner' && actor.id !== target.id) fail(403, 'רק בעל המערכת יכול לנהל מנהלים אחרים.');
}

async function getTarget(ctx) {
  const target = await first(ctx.env, 'SELECT * FROM v2_users WHERE id = ?', toInt(ctx.params.id));
  if (!target) fail(404, 'המשתמש לא נמצא.');
  return target;
}

const userPublic = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, block_reason: u.block_reason, plan: u.plan,
  max_systems: u.max_systems, daily_sms_limit: u.daily_sms_limit, admin_notes: u.admin_notes, signup_ip: u.signup_ip,
  last_login_at: u.last_login_at, last_ip: u.last_ip, created_at: u.created_at,
});

export default function adminRoutes(r) {
  // ---------- לוח בקרה ----------
  r.get('/api/admin/stats', async (ctx) => {
    await requireAdmin(ctx);
    const day = israelDayStart();
    const [users, newUsers, systems, sendsToday, sends7, failedToday, supportOpen, rulesActive, sharesActive, plans, recent, auditRows] = await Promise.all([
      all(ctx.env, 'SELECT status, COUNT(*) AS n FROM v2_users GROUP BY status'),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_users WHERE created_at > ?', Date.now() - 7 * 86400_000),
      all(ctx.env, 'SELECT status, COUNT(*) AS n FROM v2_systems GROUP BY status'),
      first(ctx.env, 'SELECT COALESCE(SUM(recipients),0) AS n FROM v2_send_log WHERE ok = 1 AND created_at >= ?', day),
      first(ctx.env, 'SELECT COALESCE(SUM(recipients),0) AS n FROM v2_send_log WHERE ok = 1 AND created_at >= ?', Date.now() - 7 * 86400_000),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_send_log WHERE ok = 0 AND created_at >= ?', day),
      first(ctx.env, "SELECT COUNT(*) AS n FROM v2_support_threads WHERE status = 'open'"),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_rules WHERE enabled = 1'),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_shares WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > ?)', Date.now()),
      all(ctx.env, 'SELECT p.key, p.name, (SELECT COUNT(*) FROM v2_users u WHERE u.plan = p.key) AS users FROM v2_plans p ORDER BY p.sort'),
      all(ctx.env, 'SELECT id, name, email, status, plan, created_at FROM v2_users ORDER BY id DESC LIMIT 6'),
      all(ctx.env, 'SELECT a.action, a.created_at, a.ip, u.name AS user_name FROM v2_audit a LEFT JOIN v2_users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 10'),
    ]);
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(israelParts(Date.now() - i * 86400_000).ymd);
    const since = Date.now() - 15 * 86400_000;
    const sendRows = await all(ctx.env, 'SELECT created_at, recipients, ok FROM v2_send_log WHERE created_at > ?', since);
    const signupRows = await all(ctx.env, 'SELECT created_at FROM v2_users WHERE created_at > ?', since);
    const chart = Object.fromEntries(days.map((d) => [d, { day: d, sent: 0, failed: 0, signups: 0 }]));
    for (const s of sendRows) { const d = israelParts(s.created_at).ymd; if (chart[d]) chart[d][s.ok ? 'sent' : 'failed'] += s.ok ? s.recipients : 1; }
    for (const s of signupRows) { const d = israelParts(s.created_at).ymd; if (chart[d]) chart[d].signups++; }
    let legacy = null;
    try {
      const [codes, tokens] = await Promise.all([first(ctx.env, 'SELECT COUNT(*) AS n FROM access_codes'), first(ctx.env, 'SELECT COUNT(*) AS n FROM system_tokens')]);
      legacy = { codes: codes.n, systems: tokens.n };
    } catch { legacy = null; }
    const by = (rows) => Object.fromEntries(rows.map((x) => [x.status, x.n]));
    return {
      users: { ...by(users), total: users.reduce((s, x) => s + x.n, 0), new_7d: newUsers.n },
      systems: { ...by(systems), total: systems.reduce((s, x) => s + x.n, 0) },
      sends: { today: sendsToday.n, d7: sends7.n, failed_today: failedToday.n },
      support_open: supportOpen.n, rules_active: rulesActive.n, shares_active: sharesActive.n,
      plans, recent_users: recent, recent_audit: auditRows, chart: Object.values(chart), legacy,
    };
  });

  // ---------- משתמשים ----------
  r.get('/api/admin/users', async (ctx) => {
    await requireAdmin(ctx);
    const p = ctx.url.searchParams;
    const where = [];
    const args = [];
    if (p.get('q')) { where.push('(u.name LIKE ? OR u.email LIKE ? OR CAST(u.id AS TEXT) = ?)'); args.push(`%${p.get('q')}%`, `%${p.get('q')}%`, p.get('q')); }
    if (p.get('status')) { where.push('u.status = ?'); args.push(p.get('status')); }
    if (p.get('plan')) { where.push('u.plan = ?'); args.push(p.get('plan')); }
    if (p.get('role')) { where.push('u.role = ?'); args.push(p.get('role')); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, toInt(p.get('page'), 1));
    const per = 50;
    const total = await first(ctx.env, `SELECT COUNT(*) AS n FROM v2_users u ${w}`, ...args);
    const rows = await all(ctx.env,
      `SELECT u.id, u.name, u.email, u.role, u.status, u.plan, u.created_at, u.last_login_at, u.last_ip,
              (SELECT COUNT(*) FROM v2_systems s WHERE s.user_id = u.id) AS systems,
              (SELECT COALESCE(SUM(recipients),0) FROM v2_send_log l WHERE l.user_id = u.id AND l.ok = 1 AND l.created_at > ?) AS sms_7d
       FROM v2_users u ${w} ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.id DESC LIMIT ? OFFSET ?`,
      Date.now() - 7 * 86400_000, ...args, per, (page - 1) * per);
    return { rows, total: total.n, page, per };
  });

  r.post('/api/admin/users', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const name = str(body.name, 80);
    if (name.length < 2) fail(400, 'נא להזין שם.');
    const email = normalizeEmail(body.email);
    const canonical = canonicalEmail(email);
    if (await first(ctx.env, 'SELECT id FROM v2_users WHERE email_canonical = ?', canonical)) fail(409, 'כבר קיים חשבון עם המייל הזה.');
    const password = checkPassword(body.password);
    const role = body.role === 'admin' && admin.role === 'owner' ? 'admin' : 'user';
    const plan = (await first(ctx.env, 'SELECT key FROM v2_plans WHERE key = ?', str(body.plan, 30))) ? str(body.plan, 30) : 'free';
    const id = await insertId(ctx.env,
      'INSERT INTO v2_users (email, email_canonical, name, password_hash, role, status, plan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      email, canonical, name, await hashPassword(password), role, 'active', plan, Date.now());
    await audit(ctx.env, { userId: id, actorId: admin.id, action: 'admin.user.create', detail: { email, role, plan }, ip: ctx.ip });
    if (body.send_email) ctx.waitUntil(mailGeneric(ctx.env, email, { title: 'נפתח עבורך חשבון', body: `שלום ${name},\nמנהל המערכת פתח עבורך חשבון. ההתחברות היא עם כתובת המייל הזו והסיסמה שנמסרה לך.`, cta: { label: 'כניסה', url: ctx.env.APP_URL || '#' } }));
    return { ok: true, id };
  });

  r.get('/api/admin/users/:id', async (ctx) => {
    await requireAdmin(ctx);
    const target = await getTarget(ctx);
    const [access, overrides, features, systems, sessions, activity, usage, threads, rules, shares, keys] = await Promise.all([
      resolveAccess(ctx.env, target),
      all(ctx.env, 'SELECT key, value FROM v2_user_features WHERE user_id = ?', target.id),
      all(ctx.env, 'SELECT key, label, global_enabled FROM v2_features ORDER BY sort'),
      all(ctx.env, 'SELECT id, name, number, auth_type, status, status_msg, last_check_at, created_at FROM v2_systems WHERE user_id = ?', target.id),
      all(ctx.env, "SELECT rowid AS id, ip, user_agent, last_seen_at, impersonator_id FROM v2_sessions WHERE user_id = ? AND kind = 'user' AND expires_at > ? ORDER BY last_seen_at DESC", target.id, Date.now()),
      all(ctx.env, 'SELECT a.action, a.detail, a.ip, a.created_at, x.name AS actor_name FROM v2_audit a LEFT JOIN v2_users x ON x.id = a.actor_id WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 40', target.id),
      first(ctx.env, `SELECT COALESCE(SUM(CASE WHEN created_at >= ? THEN recipients END),0) AS today, COALESCE(SUM(recipients),0) AS d30
                       FROM v2_send_log WHERE user_id = ? AND created_at > ? AND ok = 1`,
        israelDayStart(), target.id, Date.now() - 30 * 86400_000),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_support_threads WHERE user_id = ?', target.id),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_rules WHERE user_id = ?', target.id),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_shares WHERE user_id = ?', target.id),
      first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_api_keys WHERE user_id = ?', target.id),
    ]);
    const ov = Object.fromEntries(overrides.map((o) => [o.key, o.value]));
    return {
      user: userPublic(target),
      access: { plan: access.plan, limits: access.limits },
      features: features.map((f) => ({ key: f.key, label: f.label, global_enabled: !!f.global_enabled, effective: !!access.features[f.key], override: f.key in ov ? ov[f.key] : null })),
      systems, sessions, activity,
      usage: { today: usage.today, d30: usage.d30 },
      counts: { threads: threads.n, rules: rules.n, shares: shares.n, keys: keys.n },
    };
  });

  r.put('/api/admin/users/:id', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    assertCanManage(admin, target);
    const body = await readJson(ctx.request);
    const patch = {};
    if (body.name !== undefined) { const n = str(body.name, 80); if (n.length < 2) fail(400, 'שם קצר מדי.'); patch.name = n; }
    if (body.role !== undefined && body.role !== target.role) {
      if (!ROLES.includes(body.role) || body.role === 'owner') fail(400, 'תפקיד לא תקין.');
      if (admin.role !== 'owner') fail(403, 'רק בעל המערכת יכול לשנות תפקידים.');
      if (target.id === admin.id) fail(400, 'אי אפשר לשנות את התפקיד של עצמך.');
      patch.role = body.role;
    }
    if (body.status !== undefined && body.status !== target.status) {
      if (!STATUSES.includes(body.status)) fail(400, 'סטטוס לא תקין.');
      if (target.id === admin.id) fail(400, 'אי אפשר לחסום את עצמך.');
      patch.status = body.status;
    }
    if (body.block_reason !== undefined) patch.block_reason = str(body.block_reason, 200) || null;
    if (body.plan !== undefined && body.plan !== target.plan) {
      if (!(await first(ctx.env, 'SELECT key FROM v2_plans WHERE key = ?', body.plan))) fail(400, 'חבילה לא קיימת.');
      patch.plan = body.plan;
    }
    if (body.max_systems !== undefined) patch.max_systems = body.max_systems === null || body.max_systems === '' ? null : Math.max(0, toInt(body.max_systems, 0));
    if (body.daily_sms_limit !== undefined) patch.daily_sms_limit = body.daily_sms_limit === null || body.daily_sms_limit === '' ? null : Math.max(0, toInt(body.daily_sms_limit, 0));
    if (body.admin_notes !== undefined) patch.admin_notes = str(body.admin_notes, 2000) || null;
    const keys = Object.keys(patch);
    if (!keys.length) return { ok: true };
    await run(ctx.env, `UPDATE v2_users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), target.id);

    if (patch.status === 'blocked') {
      await run(ctx.env, 'DELETE FROM v2_sessions WHERE user_id = ?', target.id);
      await run(ctx.env, 'UPDATE v2_shares SET is_active = 0 WHERE user_id = ?', target.id);
    }
    if (patch.status === 'active' && target.status === 'pending') {
      ctx.waitUntil(mailApproved(ctx.env, target.email, target.name));
      await notify(ctx.env, target.id, { title: 'החשבון אושר', body: 'ברוך הבא! אפשר להתחיל לחבר מערכות.' });
    }
    if (patch.plan) await notify(ctx.env, target.id, { title: 'החבילה שלך עודכנה', body: `החבילה הנוכחית: ${patch.plan}` });
    const before = Object.fromEntries(keys.map((k) => [k, target[k]]));
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.user.update', detail: { before, after: patch }, ip: ctx.ip });
    return { ok: true };
  });

  r.post('/api/admin/users/:id/features', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    assertCanManage(admin, target);
    const body = await readJson(ctx.request);
    const key = str(body.key, 60);
    if (!(await first(ctx.env, 'SELECT key FROM v2_features WHERE key = ?', key))) fail(400, 'פיצ׳ר לא קיים.');
    if (body.value === null || body.value === undefined || body.value === '') {
      await run(ctx.env, 'DELETE FROM v2_user_features WHERE user_id = ? AND key = ?', target.id, key);
    } else {
      await run(ctx.env, 'INSERT OR REPLACE INTO v2_user_features (user_id, key, value) VALUES (?, ?, ?)', target.id, key, bool(body.value));
    }
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.user.feature', detail: { key, value: body.value ?? null }, ip: ctx.ip });
    return { ok: true };
  });

  r.post('/api/admin/users/:id/revoke-sessions', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    assertCanManage(admin, target);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE user_id = ? AND id != ?', target.id, ctx.session.id);
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.user.revoke_sessions', ip: ctx.ip });
    return { ok: true };
  });

  r.post('/api/admin/users/:id/reset-password', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    assertCanManage(admin, target);
    const code = await issueCode(ctx, target.email_canonical, 'reset', null);
    const res = await mailResetCode(ctx.env, target.email, target.name, code);
    if (!res.ok) fail(502, res.error);
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.user.reset_password', ip: ctx.ip });
    return { ok: true };
  });

  // כניסה כמשתמש (לתמיכה) — מתועד ביומן, ומוצג למשתמש ברשימת המכשירים
  r.post('/api/admin/users/:id/impersonate', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    if (target.id === admin.id) fail(400, 'זה החשבון שלך.');
    assertCanManage(admin, target);
    if (target.status !== 'active') fail(400, 'אפשר להיכנס רק לחשבון פעיל.');
    await destroyCurrentSession(ctx, 'user');
    const setCookie = await createSession(ctx, { userId: target.id, impersonatorId: admin.id, ttlMs: 2 * 3600_000 });
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.impersonate.start', ip: ctx.ip });
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
  });

  r.post('/api/admin/users/:id/notify', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    const body = await readJson(ctx.request);
    const title = str(body.title, 120);
    const text = str(body.body, 2000);
    if (!title) fail(400, 'נא להזין כותרת.');
    await notify(ctx.env, target.id, { title, body: text, link: str(body.link, 200) || null });
    if (body.email) {
      const res = await mailGeneric(ctx.env, target.email, { title, body: text });
      if (!res.ok) fail(502, res.error);
    }
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.user.notify', detail: { title, email: !!body.email }, ip: ctx.ip });
    return { ok: true };
  });

  r.delete('/api/admin/users/:id', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const target = await getTarget(ctx);
    if (target.id === admin.id) fail(400, 'אי אפשר למחוק את עצמך מכאן.');
    assertCanManage(admin, target);
    await deleteUserCascade(ctx.env, target.id);
    await audit(ctx.env, { userId: target.id, actorId: admin.id, action: 'admin.user.delete', detail: { email: target.email, name: target.name }, ip: ctx.ip });
    return { ok: true };
  });

  r.delete('/api/admin/sessions/:id', async (ctx) => {
    await requireAdmin(ctx);
    await run(ctx.env, 'DELETE FROM v2_sessions WHERE rowid = ?', toInt(ctx.params.id));
    return { ok: true };
  });

  // ---------- פיצ'רים ----------
  r.get('/api/admin/features', async (ctx) => {
    await requireAdmin(ctx);
    return all(ctx.env,
      `SELECT f.*, (SELECT COUNT(*) FROM v2_user_features uf WHERE uf.key = f.key AND uf.value = 1) AS forced_on,
              (SELECT COUNT(*) FROM v2_user_features uf WHERE uf.key = f.key AND uf.value = 0) AS forced_off
       FROM v2_features f ORDER BY f.sort`);
  });

  r.put('/api/admin/features/:key', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const f = await first(ctx.env, 'SELECT * FROM v2_features WHERE key = ?', ctx.params.key);
    if (!f) fail(404, 'פיצ׳ר לא קיים.');
    const body = await readJson(ctx.request);
    const g = body.global_enabled !== undefined ? bool(body.global_enabled) : f.global_enabled;
    const d = body.default_value !== undefined ? bool(body.default_value) : f.default_value;
    const n = body.new_user_value === undefined ? f.new_user_value : (body.new_user_value === null || body.new_user_value === '' ? null : bool(body.new_user_value));
    await run(ctx.env, 'UPDATE v2_features SET global_enabled = ?, default_value = ?, new_user_value = ? WHERE key = ?', g, d, n, f.key);
    await audit(ctx.env, { actorId: admin.id, action: 'admin.feature.update', detail: { key: f.key, global_enabled: g, default_value: d, new_user_value: n }, ip: ctx.ip });
    return { ok: true };
  });

  // החלה גורפת: scope=all → כל החשבונות (מנקה דריסות ומסיר מהחבילות) | scope=new → רק לחשבונות שייפתחו מעכשיו
  r.post('/api/admin/features/:key/apply', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const f = await first(ctx.env, 'SELECT * FROM v2_features WHERE key = ?', ctx.params.key);
    if (!f) fail(404, 'פיצ׳ר לא קיים.');
    const body = await readJson(ctx.request);
    const value = body.value === null ? null : bool(body.value);
    if (body.scope === 'all') {
      if (value === null) fail(400, 'נא לבחור הפעלה או כיבוי.');
      await run(ctx.env, 'UPDATE v2_features SET default_value = ? WHERE key = ?', value, f.key);
      await run(ctx.env, 'DELETE FROM v2_user_features WHERE key = ?', f.key);
      const plans = await all(ctx.env, 'SELECT key, features FROM v2_plans');
      for (const p of plans) {
        const map = JSON.parse(p.features || '{}');
        if (f.key in map) { delete map[f.key]; await run(ctx.env, 'UPDATE v2_plans SET features = ? WHERE key = ?', JSON.stringify(map), p.key); }
      }
    } else if (body.scope === 'new') {
      await run(ctx.env, 'UPDATE v2_features SET new_user_value = ? WHERE key = ?', value, f.key);
    } else if (body.scope === 'plan') {
      const plan = await first(ctx.env, 'SELECT * FROM v2_plans WHERE key = ?', str(body.plan, 30));
      if (!plan) fail(400, 'חבילה לא קיימת.');
      const map = JSON.parse(plan.features || '{}');
      if (value === null) delete map[f.key]; else map[f.key] = value;
      await run(ctx.env, 'UPDATE v2_plans SET features = ? WHERE key = ?', JSON.stringify(map), plan.key);
    } else fail(400, 'scope לא תקין.');
    await audit(ctx.env, { actorId: admin.id, action: 'admin.feature.apply', detail: { key: f.key, scope: body.scope, value, plan: body.plan || null }, ip: ctx.ip });
    return { ok: true };
  });

  // ---------- חבילות ----------
  r.get('/api/admin/plans', async (ctx) => {
    await requireAdmin(ctx);
    const rows = await all(ctx.env, 'SELECT p.*, (SELECT COUNT(*) FROM v2_users u WHERE u.plan = p.key) AS users FROM v2_plans p ORDER BY p.sort, p.key');
    return rows.map((p) => ({ ...p, features: JSON.parse(p.features || '{}') }));
  });

  const readPlan = (body) => ({
    name: str(body.name, 40) || fail(400, 'נא להזין שם לחבילה.'),
    description: str(body.description, 200) || null,
    max_systems: Math.max(0, toInt(body.max_systems, 1)),
    daily_sms_limit: body.daily_sms_limit === null || body.daily_sms_limit === '' || body.daily_sms_limit === undefined ? null : Math.max(0, toInt(body.daily_sms_limit, 0)),
    features: JSON.stringify(Object.fromEntries(Object.entries(body.features || {}).filter(([, v]) => v === 0 || v === 1 || v === true || v === false).map(([k, v]) => [k, v ? 1 : 0]))),
    sort: toInt(body.sort, 0),
  });

  r.post('/api/admin/plans', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const key = str(body.key, 30).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!key) fail(400, 'נא להזין מזהה באנגלית (למשל gold).');
    if (await first(ctx.env, 'SELECT key FROM v2_plans WHERE key = ?', key)) fail(409, 'חבילה עם המזהה הזה כבר קיימת.');
    const p = readPlan(body);
    await run(ctx.env, 'INSERT INTO v2_plans (key, name, description, max_systems, daily_sms_limit, features, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
      key, p.name, p.description, p.max_systems, p.daily_sms_limit, p.features, p.sort);
    await audit(ctx.env, { actorId: admin.id, action: 'admin.plan.create', detail: { key }, ip: ctx.ip });
    return { ok: true, key };
  });

  r.put('/api/admin/plans/:key', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const plan = await first(ctx.env, 'SELECT * FROM v2_plans WHERE key = ?', ctx.params.key);
    if (!plan) fail(404, 'החבילה לא נמצאה.');
    const body = await readJson(ctx.request);
    const p = readPlan({ ...plan, features: JSON.parse(plan.features || '{}'), ...body });
    await run(ctx.env, 'UPDATE v2_plans SET name = ?, description = ?, max_systems = ?, daily_sms_limit = ?, features = ?, sort = ? WHERE key = ?',
      p.name, p.description, p.max_systems, p.daily_sms_limit, p.features, p.sort, plan.key);
    await audit(ctx.env, { actorId: admin.id, action: 'admin.plan.update', detail: { key: plan.key }, ip: ctx.ip });
    return { ok: true };
  });

  r.delete('/api/admin/plans/:key', async (ctx) => {
    const admin = await requireAdmin(ctx);
    if (ctx.params.key === 'free') fail(400, 'אי אפשר למחוק את חבילת הבסיס.');
    const users = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_users WHERE plan = ?', ctx.params.key);
    if (users.n) fail(400, `יש ${users.n} משתמשים בחבילה הזו. העבר אותם קודם לחבילה אחרת.`);
    const s = await getSettings(ctx.env);
    if (s.default_plan === ctx.params.key) fail(400, 'זו חבילת ברירת המחדל להרשמה. שנה אותה בהגדרות קודם.');
    await run(ctx.env, 'DELETE FROM v2_plans WHERE key = ?', ctx.params.key);
    await audit(ctx.env, { actorId: admin.id, action: 'admin.plan.delete', detail: { key: ctx.params.key }, ip: ctx.ip });
    return { ok: true };
  });

  r.post('/api/admin/plans/:key/move', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const to = str(body.to, 30);
    if (!(await first(ctx.env, 'SELECT key FROM v2_plans WHERE key = ?', to))) fail(400, 'חבילת היעד לא קיימת.');
    const res = await run(ctx.env, "UPDATE v2_users SET plan = ? WHERE plan = ? AND role = 'user'", to, ctx.params.key);
    await audit(ctx.env, { actorId: admin.id, action: 'admin.plan.move', detail: { from: ctx.params.key, to, count: res.meta ? res.meta.changes : null }, ip: ctx.ip });
    return { ok: true, moved: res.meta ? res.meta.changes : 0 };
  });

  // ---------- הגדרות ----------
  const SETTING_KEYS = {
    app_name: (v) => str(v, 60) || 'S.M.T Messages',
    registration_mode: (v) => (['open', 'approval', 'closed'].includes(v) ? v : 'open'),
    default_plan: (v) => str(v, 30),
    maintenance: (v) => (bool(v) ? '1' : '0'),
    maintenance_message: (v) => str(v, 300),
    signups_per_ip_per_day: (v) => String(Math.max(0, Math.min(100, toInt(v, 3)))),
    block_disposable_emails: (v) => (bool(v) ? '1' : '0'),
    login_alerts: (v) => (bool(v) ? '1' : '0'),
    rules_poll_minutes: (v) => String(Math.max(1, Math.min(60, toInt(v, 2)))),
    support_enabled: (v) => (bool(v) ? '1' : '0'),
  };

  r.get('/api/admin/settings', async (ctx) => {
    await requireAdmin(ctx);
    const s = await getSettings(ctx.env, true);
    return {
      settings: s,
      env: {
        app_url: ctx.env.APP_URL || null, mail_from: ctx.env.MAIL_FROM || null,
        resend: !!ctx.env.RESEND_API_KEY, encryption: !!ctx.env.ENCRYPTION_KEY, owner_email: !!ctx.env.OWNER_EMAIL,
      },
    };
  });

  r.put('/api/admin/settings', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const patch = {};
    for (const [k, fn] of Object.entries(SETTING_KEYS)) if (body[k] !== undefined) patch[k] = fn(body[k]);
    if (patch.default_plan && !(await first(ctx.env, 'SELECT key FROM v2_plans WHERE key = ?', patch.default_plan))) fail(400, 'חבילת ברירת המחדל לא קיימת.');
    await setSettings(ctx.env, patch);
    await audit(ctx.env, { actorId: admin.id, action: 'admin.settings', detail: patch, ip: ctx.ip });
    return { ok: true };
  });

  r.post('/api/admin/settings/test-email', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const res = await mailTest(ctx.env, admin.email);
    if (!res.ok) fail(502, res.error);
    return { ok: true, to: admin.email };
  });

  // ---------- תמיכה ----------
  r.get('/api/admin/support/threads', async (ctx) => {
    await requireAdmin(ctx);
    const status = ctx.url.searchParams.get('status');
    return all(ctx.env,
      `SELECT t.*, u.name AS user_name, u.email AS user_email, u.plan AS user_plan,
              (SELECT body FROM v2_support_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body
       FROM v2_support_threads t JOIN v2_users u ON u.id = t.user_id
       ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.admin_unread > 0 DESC, t.updated_at DESC LIMIT 200`, ...(status ? [status] : []));
  });

  r.get('/api/admin/support/threads/:id', async (ctx) => {
    await requireAdmin(ctx);
    const thread = await first(ctx.env,
      'SELECT t.*, u.name AS user_name, u.email AS user_email, u.plan AS user_plan, u.status AS user_status FROM v2_support_threads t JOIN v2_users u ON u.id = t.user_id WHERE t.id = ?', toInt(ctx.params.id));
    if (!thread) fail(404, 'הפנייה לא נמצאה.');
    const messages = await all(ctx.env,
      'SELECT m.id, m.sender_role, m.body, m.created_at, u.name AS sender_name FROM v2_support_messages m LEFT JOIN v2_users u ON u.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id', thread.id);
    if (thread.admin_unread) await run(ctx.env, 'UPDATE v2_support_threads SET admin_unread = 0 WHERE id = ?', thread.id);
    return { thread, messages };
  });

  r.post('/api/admin/support/threads/:id/messages', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const thread = await first(ctx.env, 'SELECT t.*, u.email, u.name FROM v2_support_threads t JOIN v2_users u ON u.id = t.user_id WHERE t.id = ?', toInt(ctx.params.id));
    if (!thread) fail(404, 'הפנייה לא נמצאה.');
    const body = await readJson(ctx.request);
    const text = str(body.body, 4000);
    if (!text) fail(400, 'ההודעה ריקה.');
    const t = Date.now();
    await run(ctx.env, "INSERT INTO v2_support_messages (thread_id, sender_role, sender_id, body, created_at) VALUES (?, 'admin', ?, ?, ?)", thread.id, admin.id, text, t);
    await run(ctx.env, `UPDATE v2_support_threads SET user_unread = user_unread + 1, admin_unread = 0, updated_at = ? ${body.close ? ", status = 'closed'" : ''} WHERE id = ?`, t, thread.id);
    await notify(ctx.env, thread.user_id, { title: `תשובה בפנייה: ${thread.subject}`, body: text.slice(0, 200), link: `#/support/${thread.id}` });
    if (body.email) ctx.waitUntil(mailGeneric(ctx.env, thread.email, { title: `תשובה לפנייה: ${thread.subject}`, body: text, cta: { label: 'פתיחת הפנייה', url: `${ctx.env.APP_URL || ''}/#/support/${thread.id}` } }));
    return { ok: true };
  });

  r.put('/api/admin/support/threads/:id', async (ctx) => {
    await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    await run(ctx.env, 'UPDATE v2_support_threads SET status = ?, updated_at = ? WHERE id = ?', body.status === 'closed' ? 'closed' : 'open', Date.now(), toInt(ctx.params.id));
    return { ok: true };
  });

  r.post('/api/admin/support/start', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const target = await first(ctx.env, 'SELECT id FROM v2_users WHERE id = ?', toInt(body.user_id));
    if (!target) fail(404, 'המשתמש לא נמצא.');
    const subject = str(body.subject, 100);
    const text = str(body.body, 4000);
    if (!subject || !text) fail(400, 'נא למלא נושא ותוכן.');
    const t = Date.now();
    const id = await insertId(ctx.env, 'INSERT INTO v2_support_threads (user_id, subject, user_unread, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', target.id, subject, t, t);
    await run(ctx.env, "INSERT INTO v2_support_messages (thread_id, sender_role, sender_id, body, created_at) VALUES (?, 'admin', ?, ?, ?)", id, admin.id, text, t);
    await notify(ctx.env, target.id, { title: `הודעה ממנהל המערכת: ${subject}`, body: text.slice(0, 200), link: `#/support/${id}` });
    return { ok: true, id };
  });

  // ---------- הודעות מערכת (באנר) ----------
  r.get('/api/admin/announcements', async (ctx) => {
    await requireAdmin(ctx);
    return all(ctx.env, 'SELECT * FROM v2_announcements ORDER BY id DESC');
  });

  r.post('/api/admin/announcements', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const title = str(body.title, 120);
    if (!title) fail(400, 'נא להזין כותרת.');
    const days = toInt(body.days, 0);
    const id = await insertId(ctx.env, 'INSERT INTO v2_announcements (title, body, level, active, expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      title, str(body.body, 1000) || null, ['info', 'warn', 'success'].includes(body.level) ? body.level : 'info', days ? Date.now() + days * 86400_000 : null, Date.now());
    await audit(ctx.env, { actorId: admin.id, action: 'admin.announcement.create', detail: { id, title }, ip: ctx.ip });
    return { ok: true, id };
  });

  r.put('/api/admin/announcements/:id', async (ctx) => {
    await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    await run(ctx.env, 'UPDATE v2_announcements SET active = ? WHERE id = ?', bool(body.active), toInt(ctx.params.id));
    return { ok: true };
  });

  r.delete('/api/admin/announcements/:id', async (ctx) => {
    await requireAdmin(ctx);
    await run(ctx.env, 'DELETE FROM v2_announcements WHERE id = ?', toInt(ctx.params.id));
    return { ok: true };
  });

  // ---------- שידור הודעה לכל המשתמשים ----------
  r.post('/api/admin/broadcast', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.request);
    const title = str(body.title, 120);
    const text = str(body.body, 2000);
    if (!title || !text) fail(400, 'נא למלא כותרת ותוכן.');
    const plan = str(body.plan, 30);
    const users = await all(ctx.env, `SELECT id, email FROM v2_users WHERE status = 'active' ${plan ? 'AND plan = ?' : ''}`, ...(plan ? [plan] : []));
    const t = Date.now();
    for (let i = 0; i < users.length; i += 80) {
      await ctx.env.DB.batch(users.slice(i, i + 80).map((u) =>
        ctx.env.DB.prepare('INSERT INTO v2_notifications (user_id, title, body, created_at) VALUES (?, ?, ?, ?)').bind(u.id, title, text, t)));
    }
    let emailed = 0;
    if (body.email) {
      const res = await mailBroadcast(ctx.env, users.map((u) => u.email), { title, body: text });
      if (!res.ok) fail(502, `ההתראות נשמרו, אבל שליחת המייל נעצרה: ${res.error}`);
      emailed = res.sent;
    }
    await audit(ctx.env, { actorId: admin.id, action: 'admin.broadcast', detail: { title, plan: plan || 'all', users: users.length, emailed }, ip: ctx.ip });
    return { ok: true, users: users.length, emailed };
  });

  // ---------- יומנים ----------
  r.get('/api/admin/audit', async (ctx) => {
    await requireAdmin(ctx);
    const p = ctx.url.searchParams;
    const where = [];
    const args = [];
    if (p.get('user_id')) { where.push('(a.user_id = ? OR a.actor_id = ?)'); args.push(toInt(p.get('user_id')), toInt(p.get('user_id'))); }
    if (p.get('action')) { where.push('a.action LIKE ?'); args.push(`${p.get('action')}%`); }
    if (p.get('q')) { where.push('(u.name LIKE ? OR u.email LIKE ? OR a.ip LIKE ? OR a.detail LIKE ?)'); const q = `%${p.get('q')}%`; args.push(q, q, q, q); }
    const page = Math.max(1, toInt(p.get('page'), 1));
    return all(ctx.env,
      `SELECT a.*, u.name AS user_name, u.email AS user_email, x.name AS actor_name FROM v2_audit a
       LEFT JOIN v2_users u ON u.id = a.user_id LEFT JOIN v2_users x ON x.id = a.actor_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 100 OFFSET ?`, ...args, (page - 1) * 100);
  });

  r.get('/api/admin/sends', async (ctx) => {
    await requireAdmin(ctx);
    const page = Math.max(1, toInt(ctx.url.searchParams.get('page'), 1));
    const okFilter = ctx.url.searchParams.get('failed') === '1' ? 'WHERE l.ok = 0' : '';
    return all(ctx.env,
      `SELECT l.*, u.name AS user_name, s.name AS system_name FROM v2_send_log l
       LEFT JOIN v2_users u ON u.id = l.user_id LEFT JOIN v2_systems s ON s.id = l.system_id
       ${okFilter} ORDER BY l.id DESC LIMIT 100 OFFSET ?`, (page - 1) * 100);
  });

  r.get('/api/admin/systems', async (ctx) => {
    await requireAdmin(ctx);
    return all(ctx.env,
      `SELECT s.id, s.name, s.number, s.auth_type, s.status, s.status_msg, s.last_check_at, s.legacy_id, s.created_at, u.id AS user_id, u.name AS user_name
       FROM v2_systems s JOIN v2_users u ON u.id = s.user_id ORDER BY CASE s.status WHEN 'ok' THEN 1 ELSE 0 END, s.id DESC LIMIT 500`);
  });

  // ---------- תצוגה (קריאה בלבד) של הגרסה הישנה ----------
  r.get('/api/admin/legacy', async (ctx) => {
    await requireAdmin(ctx);
    try {
      const codes = await all(ctx.env,
        `SELECT a.id, a.owner_name, a.code, a.max_systems, a.is_blocked, a.allow_temp_codes,
                (SELECT COUNT(*) FROM system_tokens s WHERE s.code_id = a.id) AS systems,
                (SELECT MAX(timestamp) FROM access_logs l WHERE l.code_id = a.id) AS last_access
         FROM access_codes a ORDER BY a.id DESC LIMIT 500`);
      const imported = await all(ctx.env, 'SELECT legacy_id FROM v2_systems WHERE legacy_id IS NOT NULL');
      const importedSet = new Set(imported.map((x) => x.legacy_id));
      const tokens = await all(ctx.env, 'SELECT id, code_id FROM system_tokens');
      const importedByCode = {};
      for (const t of tokens) if (importedSet.has(t.id)) importedByCode[t.code_id] = (importedByCode[t.code_id] || 0) + 1;
      return {
        available: true,
        codes: codes.map((c) => ({ ...c, code: c.code ? `${'•'.repeat(Math.max(0, String(c.code).length - 2))}${String(c.code).slice(-2)}` : '', imported: importedByCode[c.id] || 0 })),
      };
    } catch {
      return { available: false, codes: [] };
    }
  });
}

// חיבור מערכות ימות המשיח. הטוקן והסיסמה נשמרים מוצפנים ואינם חוזרים לדפדפן לעולם.
import { all, first, run, insertId, audit } from '../lib/db.js';
import { fail, readJson, str, toInt } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature, getAccess } from '../lib/features.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { verifyConnection, mfaStatus, mfaTry, mfaUrl, yemotSession, invalidateSystemCache } from '../lib/yemot.js';
import { limit } from '../lib/ratelimit.js';

const PUBLIC_COLS = 'id, name, number, auth_type, sender, color, status, status_msg, last_check_at, legacy_id, created_at';

export async function getOwnedSystem(ctx, id) {
  const sys = await first(ctx.env, 'SELECT * FROM v2_systems WHERE id = ? AND user_id = ?', toInt(id), ctx.user.id);
  if (!sys) fail(404, 'המערכת לא נמצאה בחשבון שלך.');
  return sys;
}

// מערכת ברירת מחדל: הראשונה, או זו שצוינה
export async function resolveSystem(ctx, id) {
  if (id) return getOwnedSystem(ctx, id);
  const sys = await first(ctx.env, 'SELECT * FROM v2_systems WHERE user_id = ? ORDER BY id LIMIT 1', ctx.user.id);
  if (!sys) fail(400, 'עדיין לא חיברת מערכת. היכנס ל"מערכות" וחבר מערכת ימות המשיח.', 'no_system');
  return sys;
}

const COLORS = ['#0B6E66', '#2F6FB5', '#8A4FB8', '#C2412D', '#B7791F', '#2F8F4E'];

function readCreds(body) {
  const authType = body.auth_type === 'token' ? 'token' : 'password';
  const number = str(body.number, 30).replace(/[^\d*#]/g, '');
  const password = str(body.password, 100);
  const token = str(body.token, 300);
  if (authType === 'password' && (!number || !password)) fail(400, 'נא להזין מספר מערכת וסיסמה.');
  if (authType === 'token' && !token) fail(400, 'נא להדביק טוקן.');
  return { authType, number, password, token };
}

export default function systemRoutes(r) {
  r.get('/api/systems', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env, `SELECT ${PUBLIC_COLS} FROM v2_systems WHERE user_id = ? ORDER BY id`, user.id);
  });

  r.post('/api/systems', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'systems.add');
    await limit(ctx.env, `sysadd:${user.id}`, 15, 3600);
    const { limits } = await getAccess(ctx);
    const count = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_systems WHERE user_id = ?', user.id);
    if (count.n >= limits.max_systems) fail(400, `הגעת למכסת המערכות בחבילה שלך (${limits.max_systems}).`, 'limit');

    const body = await readJson(ctx.request);
    const creds = readCreds(body);
    const result = await verifyConnection(creds);
    const name = str(body.name, 60) || (result.info && result.info.name) || `מערכת ${creds.number || count.n + 1}`;
    const number = creds.number || (result.info && result.info.username) || null;

    const id = await insertId(ctx.env,
      `INSERT INTO v2_systems (user_id, name, number, auth_type, secret_enc, token_enc, sender, color, status, status_msg, last_check_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, name, number, creds.authType,
      creds.authType === 'password' ? await encryptSecret(ctx.env, creds.password) : null,
      await encryptSecret(ctx.env, result.token),
      str(body.sender, 20) || null, str(body.color, 9) || COLORS[count.n % COLORS.length],
      result.status, result.message, Date.now(), Date.now());

    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'system.add', detail: { id, name, auth: creds.authType }, ip: ctx.ip });
    // קישור האימות הדו-שלבי מוצג רק לבעל המערכת, שהזין את פרטי הגישה בעצמו
    return { ok: true, id, status: result.status, units: result.info ? result.info.units : null, mfa_url: result.status === 'mfa' ? mfaUrl(result.token) : null };
  });

  r.put('/api/systems/:id', async (ctx) => {
    await requireUser(ctx);
    const sys = await getOwnedSystem(ctx, ctx.params.id);
    const body = await readJson(ctx.request);
    const name = str(body.name, 60) || sys.name;
    const sender = body.sender !== undefined ? (str(body.sender, 20) || null) : sys.sender;
    const color = str(body.color, 9) || sys.color;
    await run(ctx.env, 'UPDATE v2_systems SET name = ?, sender = ?, color = ? WHERE id = ?', name, sender, color, sys.id);

    if (body.password || body.token) {
      const creds = readCreds({ ...body, number: body.number || sys.number });
      const result = await verifyConnection(creds);
      await run(ctx.env, 'UPDATE v2_systems SET auth_type = ?, number = ?, secret_enc = ?, token_enc = ?, status = ?, status_msg = ?, last_check_at = ? WHERE id = ?',
        creds.authType, creds.number || sys.number,
        creds.authType === 'password' ? await encryptSecret(ctx.env, creds.password) : null,
        await encryptSecret(ctx.env, result.token), result.status, result.message, Date.now(), sys.id);
      invalidateSystemCache(sys.id);
      await audit(ctx.env, { userId: ctx.user.id, actorId: ctx.user.id, action: 'system.credentials', detail: { id: sys.id }, ip: ctx.ip });
      return { ok: true, status: result.status, mfa_url: result.status === 'mfa' ? mfaUrl(result.token) : null };
    }
    return { ok: true };
  });

  r.delete('/api/systems/:id', async (ctx) => {
    await requireUser(ctx);
    const sys = await getOwnedSystem(ctx, ctx.params.id);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM v2_autoreply_log WHERE rule_id IN (SELECT id FROM v2_rules WHERE system_id = ?)').bind(sys.id),
      ctx.env.DB.prepare('DELETE FROM v2_rules WHERE system_id = ?').bind(sys.id),
      ctx.env.DB.prepare('DELETE FROM v2_sessions WHERE share_id IN (SELECT id FROM v2_shares WHERE system_id = ?)').bind(sys.id),
      ctx.env.DB.prepare('DELETE FROM v2_shares WHERE system_id = ?').bind(sys.id),
      ctx.env.DB.prepare("UPDATE v2_scheduled SET status = 'canceled', result = 'המערכת הוסרה' WHERE system_id = ? AND status = 'pending'").bind(sys.id),
      ctx.env.DB.prepare('DELETE FROM v2_conv_meta WHERE system_id = ?').bind(sys.id),
      ctx.env.DB.prepare('DELETE FROM v2_systems WHERE id = ?').bind(sys.id),
    ]);
    invalidateSystemCache(sys.id);
    await audit(ctx.env, { userId: ctx.user.id, actorId: ctx.user.id, action: 'system.delete', detail: { id: sys.id, name: sys.name }, ip: ctx.ip });
    return { ok: true };
  });

  // בדיקת חיבור יזומה
  r.post('/api/systems/:id/test', async (ctx) => {
    await requireUser(ctx);
    const sys = await getOwnedSystem(ctx, ctx.params.id);
    await limit(ctx.env, `systest:${sys.id}`, 20, 600);
    let token = await decryptSecret(ctx.env, sys.token_enc);
    let session = await yemotSession(token);
    if (session.responseStatus !== 'OK' && sys.auth_type === 'password') {
      const { yemotLogin } = await import('../lib/yemot.js');
      try {
        token = await yemotLogin(sys.number, await decryptSecret(ctx.env, sys.secret_enc));
        await run(ctx.env, 'UPDATE v2_systems SET token_enc = ? WHERE id = ?', await encryptSecret(ctx.env, token), sys.id);
        session = await yemotSession(token);
      } catch (e) {
        await run(ctx.env, "UPDATE v2_systems SET status = 'error', status_msg = ?, last_check_at = ? WHERE id = ?", e.message.slice(0, 200), Date.now(), sys.id);
        return { status: 'error', message: e.message };
      }
    }
    if (session.responseStatus !== 'OK') {
      const msg = String(session.message || 'שגיאה').slice(0, 200);
      const status = /mfa/i.test(msg) ? 'mfa' : 'error';
      await run(ctx.env, 'UPDATE v2_systems SET status = ?, status_msg = ?, last_check_at = ? WHERE id = ?', status, msg, Date.now(), sys.id);
      return { status, message: msg, mfa_url: status === 'mfa' ? mfaUrl(token) : null };
    }
    let mfa = await mfaStatus(token);
    if (mfa.ok && !mfa.isPass) mfa = await mfaTry(token);
    const status = mfa.ok && !mfa.isPass ? 'mfa' : 'ok';
    await run(ctx.env, 'UPDATE v2_systems SET status = ?, status_msg = ?, last_check_at = ? WHERE id = ?', status, status === 'mfa' ? 'נדרש אימות דו-שלבי' : null, Date.now(), sys.id);
    return {
      status, mfa_reason: mfa.reason || null,
      info: { name: session.name || null, username: session.username || null, units: session.units ?? null },
      mfa_url: status === 'mfa' ? mfaUrl(token) : null,
    };
  });

  // סטטוס אימות דו-שלבי (ל-polling אחרי שהמשתמש לחץ על הקישור)
  r.get('/api/systems/:id/mfa', async (ctx) => {
    await requireUser(ctx);
    const sys = await getOwnedSystem(ctx, ctx.params.id);
    const token = await decryptSecret(ctx.env, sys.token_enc);
    const mfa = await mfaStatus(token);
    if (mfa.ok && mfa.isPass && sys.status !== 'ok') {
      await run(ctx.env, "UPDATE v2_systems SET status = 'ok', status_msg = NULL, last_check_at = ? WHERE id = ?", Date.now(), sys.id);
    }
    return { passed: mfa.ok && mfa.isPass, reason: mfa.reason || null };
  });

  // ---------- גשר לגרסה הישנה: ייבוא מערכות לפי הקוד האישי הישן (קריאה בלבד מהטבלאות הישנות) ----------
  r.post('/api/systems/legacy-import', async (ctx) => {
    const user = await requireUser(ctx);
    await requireFeature(ctx, 'legacy.import');
    await limit(ctx.env, `legacy:${user.id}`, 5, 3600, 'יותר מדי ניסיונות ייבוא. נסה שוב בעוד שעה.');
    const body = await readJson(ctx.request);
    const code = str(body.code, 40);
    if (!code) fail(400, 'נא להזין את הקוד האישי מהמערכת הישנה.');

    let legacyUser;
    try {
      legacyUser = await first(ctx.env, 'SELECT id, owner_name, is_blocked FROM access_codes WHERE code = ?', code);
    } catch {
      fail(400, 'לא נמצאו נתונים של הגרסה הישנה במסד הזה.');
    }
    if (!legacyUser) fail(404, 'הקוד לא נמצא במערכת הישנה.');
    if (legacyUser.is_blocked === 1) fail(403, 'הקוד חסום במערכת הישנה.');

    const legacySystems = await all(ctx.env, 'SELECT id, description, token FROM system_tokens WHERE code_id = ? ORDER BY id', legacyUser.id);
    const { limits } = await getAccess(ctx);
    let count = (await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_systems WHERE user_id = ?', user.id)).n;
    const imported = [];
    const skipped = [];
    for (const ls of legacySystems) {
      if (await first(ctx.env, 'SELECT id FROM v2_systems WHERE user_id = ? AND legacy_id = ?', user.id, ls.id)) { skipped.push({ name: ls.description, reason: 'כבר יובאה' }); continue; }
      if (count >= limits.max_systems) { skipped.push({ name: ls.description, reason: 'חריגה ממכסת המערכות' }); continue; }
      const session = await yemotSession(ls.token);
      const status = session.responseStatus === 'OK' ? 'ok' : 'error';
      await insertId(ctx.env,
        `INSERT INTO v2_systems (user_id, name, number, auth_type, token_enc, color, status, status_msg, last_check_at, legacy_id, created_at)
         VALUES (?, ?, ?, 'token', ?, ?, ?, ?, ?, ?, ?)`,
        user.id, str(ls.description, 60) || `מערכת ${ls.id}`, session.username || null, await encryptSecret(ctx.env, ls.token),
        COLORS[count % COLORS.length], status, status === 'ok' ? null : String(session.message || 'הטוקן לא תקף').slice(0, 200), Date.now(), ls.id, Date.now());
      imported.push({ name: ls.description, status });
      count++;
    }
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'legacy.import', detail: { legacy_user: legacyUser.id, imported: imported.length }, ip: ctx.ip });
    return { ok: true, owner_name: legacyUser.owner_name, imported, skipped };
  });
}

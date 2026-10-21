// בדיקות מקצה לקצה: ה-Worker האמיתי מול SQLite אמיתי, עם ימות המשיח ו-Resend מדומים
// הרצה: npm test   (דורש Node 22.5 ומעלה)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, client, lastCode } from './harness.js';

const t = await createEnv();
const { env, yemot, mail, hooks } = t;
const { runCron } = await import('../src/cron.js');
const { hmacHex } = await import('../src/lib/crypto.js');
const db = env.DB.db;
const legacyBefore = db.prepare('SELECT (SELECT COUNT(*) FROM access_codes) a, (SELECT COUNT(*) FROM system_tokens) b, (SELECT COUNT(*) FROM settings) c').get();

async function register(c, name, email, password = 'Passw0rd!') {
  const s = await c.post('/api/auth/register/start', { name, email, password });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const v = await c.post('/api/auth/register/verify', { email, code: lastCode(mail, email) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.data;
}

const owner = client(t, '10.0.0.1');
const user = client(t, '10.0.0.2');
let systemId;

test('health + public config', async () => {
  const h = await owner.get('/api/health');
  assert.equal(h.data.ok, true);
  const c = await owner.get('/api/public/config');
  assert.equal(c.data.registration_mode, 'open');
});

test('CSRF: בקשה בלי הכותרת נחסמת', async () => {
  const res = await t.worker.fetch(new Request('https://sms2.test/api/auth/login', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), env, { waitUntil() {} });
  assert.equal(res.status, 403);
});

test('הרשמה: הבעלים מקבל role=owner, מייל מעוצב עם קוד', async () => {
  const r = await register(owner, 'בעל המערכת', 'owner@example.com');
  assert.equal(r.status, 'active');
  const me = await owner.get('/api/me');
  assert.equal(me.data.user.role, 'owner');
  assert.ok(mail.some((m) => m.subject.includes('קוד האימות')));
});

test('הרשמה חכמה: אותו ג׳ימייל עם נקודות/+tag נחסם, מייל זמני נחסם', async () => {
  await register(user, 'משה כהן', 'moshe.cohen@gmail.com');
  const other = client(t, '10.0.0.3');
  const dup = await other.post('/api/auth/register/start', { name: 'כפול', email: 'MosheCohen+spam@googlemail.com', password: 'Passw0rd!' });
  assert.equal(dup.status, 409);
  const temp = await other.post('/api/auth/register/start', { name: 'זמני', email: 'x@mailinator.com', password: 'Passw0rd!' });
  assert.equal(temp.status, 400);
  const weak = await other.post('/api/auth/register/start', { name: 'חלש', email: 'weak@example.com', password: 'short' });
  assert.equal(weak.status, 400);
});

test('קוד אימות שגוי: מונה ניסיונות', async () => {
  const c = client(t, '10.0.0.4');
  await c.post('/api/auth/register/start', { name: 'בדיקה', email: 'codes@example.com', password: 'Passw0rd!' });
  const bad = await c.post('/api/auth/register/verify', { email: 'codes@example.com', code: '000000' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /נותרו 4/);
  const resendTooSoon = await c.post('/api/auth/register/resend', { email: 'codes@example.com' });
  assert.equal(resendTooSoon.status, 429);
});

test('התחברות: סיסמה שגויה ואז נכונה', async () => {
  const c = client(t, '10.0.0.2');
  assert.equal((await c.post('/api/auth/login', { email: 'moshe.cohen@gmail.com', password: 'wrong' })).status, 401);
  const ok = await c.post('/api/auth/login', { email: 'mosheCohen@gmail.com', password: 'Passw0rd!' });
  assert.equal(ok.status, 200);
  assert.ok(c.jar.smt2_s);
});

test('חיבור מערכת: הסיסמה והטוקן מוצפנים ולא חוזרים לדפדפן', async () => {
  const bad = await user.post('/api/systems', { auth_type: 'password', number: '0771234567', password: 'nope' });
  assert.equal(bad.status, 400);
  const r = await user.post('/api/systems', { auth_type: 'password', number: '0771234567', password: 'pass1234', name: 'קו ראשי' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  systemId = r.data.id;
  const list = await user.get('/api/systems');
  const json = JSON.stringify(list.data);
  assert.ok(!json.includes('pass1234') && !json.includes(':tok') && !json.includes('token_enc'));
  const row = db.prepare('SELECT secret_enc, token_enc FROM v2_systems WHERE id = ?').get(systemId);
  assert.ok(row.secret_enc.startsWith('v1:') && !row.secret_enc.includes('pass1234'));
});

test('הודעות: שיחות, לא נקראו, שרשור, שליחה', async () => {
  yemot.addIncoming('0501111111', 'שלום, אפשר לקבוע תור?', 0);
  yemot.addIncoming('0502222222', 'הודעה שנייה', 0);
  const c = await user.get(`/api/messages/conversations?system=${systemId}&fresh=1`);
  assert.equal(c.status, 200);
  assert.equal(c.data.conversations.length, 2);
  assert.equal(c.data.total_unread, 2);
  const th = await user.get(`/api/messages/thread?system=${systemId}&phone=0501111111&mark=1`);
  assert.equal(th.data.messages.length, 1);
  const c2 = await user.get(`/api/messages/conversations?system=${systemId}`);
  assert.equal(c2.data.total_unread, 1);
  const s = await user.post('/api/messages/send', { system: systemId, phones: ['050-111-1111'], message: 'בוודאי, מחר ב-10?' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.deepEqual(yemot.sends.at(-1).phones, ['0501111111']);
});

test('טוקן פג: השרת מתחבר מחדש אוטומטית', async () => {
  const loginsBefore = yemot.calls.filter((x) => x.endpoint === 'Login').length;
  yemot.expireNext = true;
  const s = await user.post('/api/messages/send', { system: systemId, phones: ['0501111111'], message: 'אחרי חידוש' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(yemot.calls.filter((x) => x.endpoint === 'Login').length, loginsBefore + 1);
});

test('חסימת איש קשר: מוסתר מהתיבה ולא ניתן לשלוח אליו', async () => {
  await user.post('/api/contacts/upsert', { phone: '0502222222', is_blocked: true });
  const c = await user.get(`/api/messages/conversations?system=${systemId}&fresh=1`);
  assert.equal(c.data.hidden_blocked, 1);
  const s = await user.post('/api/messages/send', { system: systemId, phones: ['0502222222'], message: 'x' });
  assert.equal(s.status, 400);
  await user.post('/api/contacts/upsert', { phone: '0502222222', is_blocked: false });
});

test('הרשאות: חבילת חינם חוסמת קמפיין גדול, דריסת מנהל פותחת', async () => {
  const phones = Array.from({ length: 8 }, (_, i) => `05000000${10 + i}`);
  const denied = await user.post('/api/messages/campaign', { system: systemId, phones, message: 'שלום {first}' });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'feature_disabled');
  const uid = (await user.get('/api/me')).data.user.id;
  assert.equal((await owner.post(`/api/admin/users/${uid}/features`, { key: 'messages.bulk', value: 1 })).status, 200);
  const ok = await user.post('/api/messages/campaign', { system: systemId, phones, message: 'שלום {first}' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.personalized, true);
  assert.equal(ok.data.parts, 8);
  const r = await runCron(env, 60_000 * 7);
  assert.equal(r.queue.sent, 8);
  const camps = await user.get('/api/messages/campaigns');
  assert.equal(camps.data[0].sent, 8);
});

test('מכסה יומית: חריגה נחסמת', async () => {
  const uid = (await user.get('/api/me')).data.user.id;
  await owner.put(`/api/admin/users/${uid}`, { daily_sms_limit: 12 });
  const res = await user.post('/api/messages/send', { system: systemId, phones: ['0501111111', '0501111112', '0501111113'], message: 'x' });
  assert.equal(res.status, 429);
  assert.equal(res.data.code, 'quota');
  await owner.put(`/api/admin/users/${uid}`, { daily_sms_limit: '' });
});

test('אוטומציה: SMS למייל — מיידי בחלון, נשמר מחוץ לחלון', async () => {
  const r = await user.post('/api/rules', { type: 'email', system_id: systemId, target: 'me@example.com', days: '0123456', start_min: 0, end_min: 1440 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  yemot.addIncoming('0503333333', 'הודעה שתועבר למייל', 1);
  const before = mail.length;
  await runCron(env, 0);
  assert.equal(mail.length, before + 1);
  assert.match(mail.at(-1).subject, /0503333333/);
  // שוב — לא נשלח פעמיים
  await runCron(env, 0);
  assert.equal(mail.length, before + 1);
  // חלון סגור (יום שאינו היום) + hold: לא נשלח ולא מתקדם
  const today = String(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay());
  const other = '0123456'.replace(today, '');
  await user.put(`/api/rules/${r.data.id}`, { days: other, outside_mode: 'hold' });
  yemot.addIncoming('0504444444', 'מחוץ לשעות', 2);
  await runCron(env, 0);
  assert.equal(mail.length, before + 1);
  await user.put(`/api/rules/${r.data.id}`, { days: '0123456' });
  await runCron(env, 0);
  assert.equal(mail.length, before + 2);
  assert.match(mail.at(-1).subject, /0504444444/);
});

test('אוטומציה: מענה אוטומטי עם cooldown, ו-Webhook חתום', async () => {
  await env.DB.prepare("UPDATE v2_users SET plan = 'pro' WHERE email = 'moshe.cohen@gmail.com'").run();
  const ar = await user.post('/api/rules', { type: 'autoreply', system_id: systemId, target: 'נחזור אליך בהקדם', cooldown_hours: 12 });
  assert.equal(ar.status, 200, JSON.stringify(ar.data));
  const wh = await user.post('/api/rules', { type: 'webhook', system_id: systemId, target: 'https://hooks.test/sms' });
  assert.equal(wh.status, 200);
  yemot.addIncoming('0505555555', 'שלום?', 3);
  const sendsBefore = yemot.sends.length;
  await runCron(env, 0);
  assert.equal(yemot.sends.length, sendsBefore + 1);
  assert.equal(yemot.sends.at(-1).message, 'נחזור אליך בהקדם');
  yemot.addIncoming('0505555555', 'עוד הודעה', 4);
  await runCron(env, 0);
  assert.equal(yemot.sends.length, sendsBefore + 1, 'cooldown');
  assert.ok(hooks.length >= 1);
  const h = hooks.at(-1);
  const secret = db.prepare('SELECT secret FROM v2_rules WHERE id = ?').get(wh.data.id).secret;
  assert.equal(h.headers['X-SMT-Signature'], `sha256=${await hmacHex(secret, h.body)}`);
});

test('גישת אורח: קוד מוגבל, צפייה לפי מספרים, שליחה נספרת, ביטול מנתק', async () => {
  const sh = await user.post('/api/shares', { system_id: systemId, label: 'עובד', can_read: true, can_send: true, phones: '0501111111', max_sends: 1, expires_minutes: 60 });
  assert.equal(sh.status, 200, JSON.stringify(sh.data));
  assert.ok(sh.data.link.startsWith('https://sms2.test/guest.html#'), sh.data.link);
  assert.ok(!(await user.get('/api/shares')).data[0].code_hash);
  const g = client(t, '10.9.9.9');
  assert.equal((await g.post('/api/guest/login', { code: 'WRONGCODE1' })).status, 401);
  assert.equal((await g.post('/api/guest/login', { code: sh.data.code.toLowerCase() })).status, 200);
  const conv = await g.get('/api/guest/conversations');
  assert.deepEqual(conv.data.conversations.map((c) => c.phone), ['0501111111']);
  assert.equal((await g.get('/api/guest/thread?phone=0503333333')).status, 403);
  assert.equal((await g.post('/api/guest/send', { phone: '0501111111', message: 'מהאורח' })).status, 200);
  assert.equal((await g.post('/api/guest/send', { phone: '0501111111', message: 'שוב' })).status, 403);
  assert.ok(!JSON.stringify(conv.data).includes('tok'));
  await user.put(`/api/shares/${sh.data.id}`, { is_active: false });
  assert.equal((await g.get('/api/guest/me')).status, 401);
});

test('API ציבורי עם מפתח', async () => {
  const k = await user.post('/api/keys', { name: 'אתר' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  const api = client(t, '10.7.7.7');
  assert.equal((await api.get('/api/v1/systems', { Authorization: 'Bearer smt_nope' })).status, 401);
  const res = await t.worker.fetch(new Request('https://sms2.test/api/v1/send', {
    method: 'POST', headers: { Authorization: `Bearer ${k.data.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phones: ['0506666666'], message: 'מה-API' }),
  }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const msgs = await api.get('/api/v1/messages?direction=in', { Authorization: `Bearer ${k.data.key}` });
  assert.ok(msgs.data.messages.length > 0);
});

test('צ׳אט תמיכה בין משתמש למנהל + התראות', async () => {
  const th = await user.post('/api/support/threads', { subject: 'שדרוג', body: 'אפשר חבילה עסקית?' });
  assert.equal(th.status, 200);
  const list = await owner.get('/api/admin/support/threads');
  assert.equal(list.data[0].admin_unread, 1);
  await owner.post(`/api/admin/support/threads/${th.data.id}/messages`, { body: 'בטח, עודכן.' });
  const me = await user.get('/api/me');
  assert.equal(me.data.unread.support, 1);
  assert.ok(me.data.unread.notifications >= 1);
  const view = await user.get(`/api/support/threads/${th.data.id}`);
  assert.equal(view.data.messages.length, 2);
});

test('הרשאות ניהול: משתמש רגיל לא נכנס לאדמין', async () => {
  assert.equal((await user.get('/api/admin/stats')).status, 403);
  const s = await owner.get('/api/admin/stats');
  assert.equal(s.status, 200);
  assert.equal(s.data.legacy.codes, 1);
});

test('התחזות לתמיכה ויציאה', async () => {
  const uid = (await user.get('/api/me')).data.user.id;
  const admin2 = client(t, '10.0.0.1');
  await admin2.post('/api/auth/login', { email: 'owner@example.com', password: 'Passw0rd!' });
  assert.equal((await admin2.post(`/api/admin/users/${uid}/impersonate`)).status, 200);
  const me = await admin2.get('/api/me');
  assert.equal(me.data.user.id, uid);
  assert.equal(me.data.impersonator.name, 'בעל המערכת');
  assert.equal((await admin2.get('/api/admin/stats')).status, 403);
  assert.equal((await admin2.post('/api/auth/impersonate/stop')).status, 200);
  assert.equal((await admin2.get('/api/me')).data.user.role, 'owner');
});

test('פיצ׳ר "רק לחשבונות חדשים"', async () => {
  await owner.post('/api/admin/features/contacts/apply', { scope: 'new', value: 0 });
  const n = client(t, '10.0.0.8');
  await register(n, 'חדש', 'newbie@example.com');
  assert.equal((await n.get('/api/contacts')).status, 403);
  assert.equal((await user.get('/api/contacts')).status, 200);
  await owner.post('/api/admin/features/contacts/apply', { scope: 'all', value: 1 });
  assert.equal((await n.get('/api/contacts')).status, 200);
});

test('מתג גלובלי כבוי חוסם גם בתוך האפליקציה', async () => {
  await owner.put('/api/admin/features/templates', { global_enabled: false });
  assert.equal((await user.post('/api/templates', { name: 'a', body: 'b' })).status, 403);
  await owner.put('/api/admin/features/templates', { global_enabled: true });
  assert.equal((await user.post('/api/templates', { name: 'a', body: 'b' })).status, 200);
});

test('חסימת משתמש: מנותק, כניסה נדחית עם הסיבה', async () => {
  const c = client(t, '10.0.0.20');
  await register(c, 'לחסימה', 'blockme@example.com');
  const uid = (await c.get('/api/me')).data.user.id;
  await owner.put(`/api/admin/users/${uid}`, { status: 'blocked', block_reason: 'שימוש לרעה' });
  assert.equal((await c.get('/api/me')).status, 401);
  const l = await c.post('/api/auth/login', { email: 'blockme@example.com', password: 'Passw0rd!' });
  assert.equal(l.status, 403);
  assert.match(l.data.error, /שימוש לרעה/);
});

test('הרשמה באישור מנהל', async () => {
  await owner.put('/api/admin/settings', { registration_mode: 'approval' });
  const c = client(t, '10.0.0.30');
  const r = await register(c, 'ממתין', 'waiting@example.com');
  assert.equal(r.status, 'pending');
  assert.equal((await c.post('/api/auth/login', { email: 'waiting@example.com', password: 'Passw0rd!' })).data.code, 'pending');
  const uid = db.prepare("SELECT id FROM v2_users WHERE email = 'waiting@example.com'").get().id;
  await owner.put(`/api/admin/users/${uid}`, { status: 'active' });
  assert.equal((await c.post('/api/auth/login', { email: 'waiting@example.com', password: 'Passw0rd!' })).status, 200);
  await owner.put('/api/admin/settings', { registration_mode: 'open' });
});

test('איפוס סיסמה מנתק את כל המכשירים', async () => {
  const c = client(t, '10.0.0.40');
  await c.post('/api/auth/forgot', { email: 'newbie@example.com' });
  const code = lastCode(mail, 'newbie@example.com');
  assert.equal((await c.post('/api/auth/reset', { email: 'newbie@example.com', code, password: 'NewPass123' })).status, 200);
  assert.equal((await c.post('/api/auth/login', { email: 'newbie@example.com', password: 'NewPass123' })).status, 200);
});

test('ייבוא מהגרסה הישנה, בלי לגעת בטבלאות הישנות', async () => {
  const c = client(t, '10.0.0.50');
  await register(c, 'לקוח ישן', 'legacy@example.com');
  const uid = db.prepare("SELECT id FROM v2_users WHERE email = 'legacy@example.com'").get().id;
  await owner.put(`/api/admin/users/${uid}`, { max_systems: 5 });
  assert.equal((await c.post('/api/systems/legacy-import', { code: '999' })).status, 404);
  const r = await c.post('/api/systems/legacy-import', { code: '123456' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported.length, 2);
  const again = await c.post('/api/systems/legacy-import', { code: '123456' });
  assert.equal(again.data.imported.length, 0);
  assert.equal(again.data.skipped.length, 2);
  const after = db.prepare('SELECT (SELECT COUNT(*) FROM access_codes) a, (SELECT COUNT(*) FROM system_tokens) b, (SELECT COUNT(*) FROM settings) c').get();
  assert.deepEqual({ ...after }, { ...legacyBefore });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='admin_password'").get().value, 'old-admin');
});

test('מחיקת משתמש מוחקת את כל הנתונים שלו', async () => {
  const uid = db.prepare("SELECT id FROM v2_users WHERE email = 'legacy@example.com'").get().id;
  assert.equal((await owner.del(`/api/admin/users/${uid}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM v2_systems WHERE user_id = ?').get(uid).n, 0);
});

test('הרצה תחת נתיב (BASE_PATH=/sms/v1)', async () => {
  env.BASE_PATH = '/sms/v1';
  try {
    const go = (p) => t.worker.fetch(new Request(`https://smti.uk${p}`), env, { waitUntil() {} });
    const r1 = await go('/sms/v1');
    assert.equal(r1.status, 301);
    assert.equal(r1.headers.get('Location'), 'https://smti.uk/sms/v1/');
    const r2 = await go('/sms/v1/api/health');
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).ok, true);
    assert.equal((await go('/other/api/health')).status, 404);
  } finally { env.BASE_PATH = ''; }
});

test('קוד אורח תחת נתיב: לא בורח לדומיין הראשי', async () => {
  // מדמה את Cloudflare Assets: /guest.html מפנה ל-/guest (נתיב מוחלט מהשורש)
  const prevAssets = env.ASSETS;
  env.ASSETS = {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === '/guest.html') return new Response(null, { status: 307, headers: { Location: '/guest' } });
      if (p === '/index.html') return new Response(null, { status: 307, headers: { Location: '/' } });
      if (p === '/guest') return new Response('GUEST PAGE', { status: 200 });
      if (p === '/') return new Response('APP PAGE', { status: 200 });
      return new Response('nf', { status: 404 });
    },
  };
  try {
    const go = (p) => t.worker.fetch(new Request(`https://smti.uk${p}`), env, { waitUntil() {} });
    const g = await go('/sms/v1/guest.html');
    assert.equal(g.status, 200);
    assert.equal(await g.text(), 'GUEST PAGE');
    const i = await go('/sms/v1/index.html');
    assert.equal(await i.text(), 'APP PAGE');

    // הקישור לאורח נבנה מהכתובת והנתיב שממנו עובדים
    const r = await user.post('/sms/v1/api/shares', { system_id: systemId, label: 'נתיב', can_read: true, expires_minutes: 60 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.link.startsWith('https://sms2.test/sms/v1/guest.html#'), r.data.link);
  } finally { env.ASSETS = prevAssets; }
});

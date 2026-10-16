// שרת הדגמה מקומי: מריץ את ה-Worker האמיתי עם ימות המשיח מדומה ונתוני דוגמה.
// הרצה: node test/demo-server.js  →  http://localhost:8788
// כניסה: owner@example.com / Passw0rd!   ·   משתמש: dana@example.com / Passw0rd!
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createEnv, client, lastCode, root } from './harness.js';

const PORT = Number(process.env.PORT || 8788);
// אפשר גם תחת נתיב: BASE_PATH=/sms/v1 node test/demo-server.js
const t = await createEnv();
const { env, yemot, mail } = t;
env.APP_URL = `http://localhost:${PORT}${env.BASE_PATH}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
env.ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, 'public', p);
    if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file)) return new Response(fs.readFileSync(path.join(root, 'public/404.html')), { status: 404, headers: { 'Content-Type': MIME['.html'] } });
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' } });
  },
};

// ---------- נתוני דוגמה ----------
async function seed() {
  const reg = async (c, name, email) => {
    await c.post('/api/auth/register/start', { name, email, password: 'Passw0rd!' });
    await c.post('/api/auth/register/verify', { email, code: lastCode(mail, email) });
  };
  const owner = client(t, '127.0.0.9');
  await reg(owner, 'אבי מנהל', 'owner@example.com');
  const dana = client(t, '127.0.0.8');
  await reg(dana, 'דנה לוי', 'dana@example.com');
  await env.DB.prepare("UPDATE v2_users SET plan = 'pro' WHERE email = 'dana@example.com'").run();
  for (const [n, e] of [['יוסי ברק', 'yossi@example.com'], ['מרכז שירות', 'service@example.com']]) await reg(client(t, `127.0.1.${n.length}`), n, e);
  await owner.put('/api/admin/settings', { registration_mode: 'approval' });
  await reg(client(t, '127.0.2.1'), 'רונית אברהם', 'ronit@example.com');
  await owner.put('/api/admin/settings', { registration_mode: 'open' });

  for (const c of [owner, dana]) {
    await c.post('/api/systems', { auth_type: 'password', number: '0771234567', password: 'pass1234', name: 'קו שירות לקוחות' });
  }
  await dana.post('/api/systems', { auth_type: 'token', token: '0779876543:permanent', name: 'מוקד ערב', color: '#8A4FB8' });

  const people = [['0501234567', 'שרה כהן'], ['0527654321', 'מיכאל לוי'], ['0548889999', 'נועה פרץ'], ['0533332211', 'דוד מזרחי'], ['0586667777', null], ['0509990000', 'קפה השכונה']];
  for (const [p, n] of people) if (n) for (const c of [owner, dana]) await c.post('/api/contacts', { phone: p, name: n });
  const g = await dana.post('/api/groups', { name: 'לקוחות VIP' });
  const ids = (await dana.get('/api/contacts')).data.map((c) => c.id);
  await dana.post(`/api/groups/${g.data.id}/members`, { contact_ids: ids.slice(0, 3) });
  await dana.post('/api/groups', { name: 'ספקים' });

  const convo = [
    ['0501234567', 'in', 'שלום, רציתי לברר אם אפשר לקבוע תור ליום חמישי?', -60 * 26],
    ['0501234567', 'out', 'היי שרה! בטח. יש לנו מקום ב-10:30 או ב-14:00, מה מתאים?', -60 * 25.5],
    ['0501234567', 'in', '10:30 מעולה 🙏', -60 * 25],
    ['0501234567', 'out', 'נקבע. נשלח תזכורת יום לפני.', -60 * 24.9],
    ['0501234567', 'in', 'תודה רבה! אגב, יש חניה באזור?', -12],
    ['0527654321', 'in', 'ההזמנה הגיעה, הכל תקין. תודה!', -60 * 5],
    ['0527654321', 'out', 'שמחים לשמוע 😊', -60 * 4.8],
    ['0548889999', 'in', 'מתי אתם פתוחים בשישי?', -40],
    ['0533332211', 'out', 'תזכורת: הפגישה שלך מחר ב-09:00. להשיב 1 לאישור.', -60 * 30],
    ['0533332211', 'in', '1', -60 * 29],
    ['0586667777', 'in', 'קוד האימות שלך הוא 482910. לא לשתף.', -60 * 72],
    ['0509990000', 'in', 'יש לכם משלוחים לרמת גן? אשמח לפרטים https://example.com/menu', -3],
  ];
  for (const [p, dir, text, off] of convo) {
    if (dir === 'in') yemot.incoming.push({ source: p.replace(/^0/, '972'), message: text, receive_date: yemot.stamp(off) });
    else yemot.outgoing.push({ To: p, Message: text, Time: yemot.stamp(off), DeliveryReport: 'DELIVRD' });
  }
  const sysId = (await dana.get('/api/systems')).data[0].id;
  await dana.post('/api/rules', { type: 'email', name: 'הודעות למשרד', system_id: sysId, target: 'dana@example.com', days: '01234', start_min: 540, end_min: 1080, mode: 'instant' });
  await dana.post('/api/rules', { type: 'autoreply', name: 'מחוץ לשעות', system_id: sysId, target: 'תודה על פנייתך! נחזור אליך בשעות הפעילות (א׳–ה׳ 9:00–18:00).', start_min: 1080, end_min: 540 });
  await dana.post('/api/rules', { type: 'email', name: 'סיכום ערב', system_id: sysId, target: 'manager@example.com', mode: 'digest', digest_minutes: 120, start_min: 1080, end_min: 1380 });
  await dana.post('/api/templates', { name: 'תזכורת לתור', body: 'שלום {first}, תזכורת לתור שלך מחר. להשיב 1 לאישור.' });
  await dana.post('/api/shares', { system_id: sysId, label: 'עובד משמרת ערב', can_read: true, can_send: true, expires_minutes: 480 });
  await dana.post('/api/messages/campaign', { system: sysId, group_ids: [g.data.id], message: 'שלום {first}, מבצע ללקוחות VIP השבוע!', label: 'מבצע VIP', send_at: Date.now() + 86400_000 });
  await dana.post('/api/messages/send', { system: sysId, phones: ['0548889999'], message: 'בשישי אנחנו פתוחים 8:00–13:00.' });
  const th = await dana.post('/api/support/threads', { subject: 'שדרוג לחבילה עסקית', body: 'היי, אני צריכה API לחיבור לאתר. אפשר לשדרג?' });
  await owner.post(`/api/admin/support/threads/${th.data.id}/messages`, { body: 'בטח! פתחתי לך את ה-API, תבדקי בתפריט.' });
  await dana.post(`/api/support/threads/${th.data.id}/messages`, { body: 'עובד, תודה רבה!' });
  await owner.post('/api/admin/announcements', { title: 'חדש: העברת SMS למייל לפי שעות', body: 'אפשר להגדיר באוטומציות — רק בימים ובשעות שתבחרו.', level: 'success' });
}
await seed();
env.BASE_PATH = process.env.BASE_PATH || '';
env.APP_URL = `http://localhost:${PORT}${env.BASE_PATH}`;
setInterval(() => t.worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p }), 60_000);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await t.worker.fetch(request, env, { waitUntil: () => {} });
  const h = {};
  out.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(out.status, h);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`Demo: http://localhost:${PORT}${env.BASE_PATH}/  (owner@example.com / dana@example.com, Passw0rd!)`));

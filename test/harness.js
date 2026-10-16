// סביבת בדיקות: D1 מדומה מעל node:sqlite (Node 22.5+), ימות המשיח ו-Resend מדומים
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { israelParts } from '../src/lib/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- D1 shim ----------
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a)); return this; }
  _s() { return this.db.prepare(this.sql); }
  async first() { const r = this._s().get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this._s().all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    if (/\breturning\b/i.test(this.sql)) { const rows = this._s().all(...this.args); return { results: rows, meta: { changes: rows.length } }; }
    const r = this._s().run(...this.args);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
export class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  exec(sql) { this.db.exec(sql); }
}

export const LEGACY_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO settings VALUES ('admin_password', 'old-admin');
CREATE TABLE access_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, owner_name TEXT, max_systems INTEGER, is_blocked INTEGER DEFAULT 0, allow_temp_codes INTEGER DEFAULT 0);
CREATE TABLE system_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER, description TEXT, token TEXT);
CREATE TABLE access_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER, system_id INTEGER, ip_address TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE temp_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER, system_id INTEGER, temp_code TEXT, expires_at INTEGER, is_active INTEGER DEFAULT 1);
CREATE TABLE temp_access_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, temp_code_id INTEGER, ip_address TEXT, endpoint TEXT, timestamp INTEGER);
CREATE TABLE pending_users (email TEXT, code TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
INSERT INTO access_codes (code, owner_name, max_systems) VALUES ('123456', 'לקוח ישן', 5);
INSERT INTO system_tokens (code_id, description, token) VALUES (1, 'מערכת ישנה א', '0771111111:legacy'), (1, 'מערכת ישנה ב', '0772222222:legacy');
`;

// ---------- ימות המשיח מדומה ----------
export function createYemot() {
  const y = {
    incoming: [], outgoing: [], sends: [], calls: [], mfaPassed: true, validPasswords: { '0771234567': 'pass1234' }, expireNext: false,
    stamp(offsetMin = 0) { return israelParts(Date.now() + offsetMin * 60000).stamp; },
    addIncoming(phone, text, offsetMin = 0) { y.incoming.push({ source: phone.replace(/^0/, '972'), message: text, receive_date: y.stamp(offsetMin) }); },
    handle(endpoint, p) {
      y.calls.push({ endpoint, p });
      if (endpoint === 'Login') return y.validPasswords[p.username] === p.password ? { responseStatus: 'OK', token: `${p.username}:tok${Date.now()}` } : { responseStatus: 'EXCEPTION', message: 'login failed' };
      if (y.expireNext && endpoint !== 'MFASession') { y.expireNext = false; return { responseStatus: 'EXCEPTION', message: 'Token expired' }; }
      if (!p.token || p.token.includes('bad')) return { responseStatus: 'EXCEPTION', message: 'Token invalid' };
      if (endpoint === 'GetSession') return { responseStatus: 'OK', username: p.token.split(':')[0], name: 'מערכת בדיקה', units: 1234 };
      if (endpoint === 'MFASession') return { responseStatus: 'OK', isPass: y.mfaPassed, passReason: 'IS_CUSTOMER_AUTH_TOKEN' };
      if (endpoint === 'GetIncomingSms') return { responseStatus: 'OK', rows: y.incoming.slice(-Number(p.limit || 100)) };
      if (endpoint === 'GetSmsOutLog') return { responseStatus: 'OK', rows: y.outgoing.slice(-Number(p.limit || 100)) };
      if (endpoint === 'SendSms') {
        const phones = String(p.phones).split(':');
        y.sends.push({ phones, message: p.message, from: p.from });
        for (const ph of phones) y.outgoing.push({ To: ph, Message: p.message, Time: y.stamp(), DeliveryReport: 'DELIVRD' });
        return { responseStatus: 'OK', sendCount: phones.length };
      }
      return { responseStatus: 'EXCEPTION', message: 'unknown endpoint' };
    },
  };
  return y;
}

// ---------- fetch גלובלי מדומה ----------
export function installFetch(yemot, mail, hooks) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://www.call2all.co.il/ym/api/')) {
      const endpoint = url.split('/ym/api/')[1].split('?')[0];
      const params = Object.fromEntries(new URLSearchParams(String(init.body || '')));
      return new Response(JSON.stringify(yemot.handle(endpoint, params)), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('https://api.resend.com/')) {
      const body = JSON.parse(init.body);
      for (const m of Array.isArray(body) ? body : [body]) mail.push(m);
      return new Response('{"id":"x"}', { status: 200 });
    }
    if (hooks && url.startsWith('https://hooks.test/')) { hooks.push({ url, body: init.body, headers: init.headers }); return new Response('ok'); }
    return real(input, init);
  };
}

// ---------- סביבה מלאה ----------
export async function createEnv({ legacy = true } = {}) {
  const DB = new D1();
  if (legacy) DB.exec(LEGACY_SCHEMA);
  DB.exec(fs.readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8'));
  const env = {
    DB, ENCRYPTION_KEY: 'test-encryption-key-please-change', RESEND_API_KEY: 're_test', OWNER_EMAIL: 'owner@example.com',
    APP_URL: 'https://sms2.test', MAIL_FROM: 'Test <t@test>', SUBREQUEST_BUDGET: '45',
  };
  const yemot = createYemot();
  const mail = [];
  const hooks = [];
  installFetch(yemot, mail, hooks);
  const worker = (await import(path.join(root, 'src/index.js'))).default;
  return { env, yemot, mail, hooks, worker };
}

// לקוח עם עוגיות
export function client(t, ip = '1.1.1.1') {
  const jar = {};
  const call = async (method, p, body, headers = {}) => {
    const h = { 'CF-Connecting-IP': ip, 'User-Agent': 'test-agent', ...headers };
    if (method !== 'GET') h['X-Requested-With'] = 'smt2';
    if (Object.keys(jar).length) h.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const waits = [];
    const res = await t.worker.fetch(new Request(`https://sms2.test${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), t.env, { waitUntil: (pr) => waits.push(pr) });
    await Promise.all(waits);
    const sc = res.headers.get('Set-Cookie');
    if (sc) { const [kv] = sc.split(';'); const [k, ...v] = kv.split('='); const val = v.join('='); if (/Max-Age=0/.test(sc)) delete jar[k]; else jar[k] = val; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    jar,
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

export const lastCode = (mail, to) => {
  const m = [...mail].reverse().find((x) => x.to.includes(to));
  return m ? (m.html.match(/letter-spacing:10px[^>]*>(\d{6})</) || [])[1] : null;
};

export { root };

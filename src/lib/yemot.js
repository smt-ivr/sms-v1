// לקוח ימות המשיח בצד השרת בלבד.
// הטוקן נשמר מוצפן במסד, מפוענח רק לרגע הקריאה, ולעולם לא נשלח לדפדפן.
import { decryptSecret, encryptSecret } from './crypto.js';
import { run } from './db.js';
import { fail } from './http.js';
import { normalizePhone } from './validate.js';

const BASE = 'https://www.call2all.co.il/ym/api/';
// ימות המשיח מקבלת מספר נמענים ב-SendSms מופרדים בנקודתיים
export const PHONE_SEPARATOR = ':';
const SEND_CHUNK = 100;

async function rawCall(endpoint, params = {}, timeoutMs = 20000) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { responseStatus: 'EXCEPTION', message: text.slice(0, 200) || `HTTP ${res.status}` }; }
  } catch (e) {
    return { responseStatus: 'NETWORK', message: e.name === 'AbortError' ? 'תם הזמן לתשובה מימות המשיח' : 'שגיאת רשת מול ימות המשיח' };
  } finally {
    clearTimeout(timer);
  }
}

const isOk = (r) => r && r.responseStatus === 'OK';
const looksLikeTokenProblem = (r) => r && !isOk(r) && /token|טוקן|session|login|התחבר|expired|פג/i.test(String(r.message || ''));
const looksLikeMfa = (r) => r && /mfa|אימות דו/i.test(String(r.message || ''));

// ---------- התחברות ובדיקות ----------
export async function yemotLogin(username, password) {
  const r = await rawCall('Login', { username, password });
  if (!isOk(r) || !r.token) fail(400, `ההתחברות לימות המשיח נכשלה: ${r.message || 'פרטים שגויים'}`);
  return r.token;
}

export async function yemotSession(token) {
  return rawCall('GetSession', { token });
}

export async function mfaStatus(token) {
  const r = await rawCall('MFASession', { token, action: 'isPass' });
  if (!isOk(r)) return { ok: false, isPass: false, message: r.message };
  return { ok: true, isPass: !!r.isPass, reason: r.passReason || null };
}

export async function mfaTry(token) {
  await rawCall('MFASession', { token, action: 'try' });
  return mfaStatus(token);
}

export function mfaUrl(token) {
  return `https://call2all.co.il/ym/mfa.php?mode=SSO&ymapitoken=${encodeURIComponent(token)}&callback=https://call2all.co.il`;
}

// בדיקת חיבור מלאה למערכת חדשה/קיימת. מחזירה {status, message, token}
export async function verifyConnection({ authType, number, password, token }) {
  let tk = token;
  if (authType === 'password') tk = await yemotLogin(number, password);
  const session = await yemotSession(tk);
  if (!isOk(session)) {
    if (looksLikeMfa(session)) return { status: 'mfa', message: 'נדרש אימות דו-שלבי', token: tk };
    fail(400, `הטוקן לא אומת מול ימות המשיח: ${session.message || 'שגיאה לא ידועה'}`);
  }
  let mfa = await mfaStatus(tk);
  if (mfa.ok && !mfa.isPass) mfa = await mfaTry(tk);
  const info = { name: session.name || session.username || null, units: session.units ?? null, username: session.username || number || null };
  if (mfa.ok && !mfa.isPass) return { status: 'mfa', message: 'נדרש אימות דו-שלבי', token: tk, info };
  return { status: 'ok', message: null, token: tk, info, mfaReason: mfa.reason };
}

// ---------- קריאה בשם מערכת שמורה ----------
async function setStatus(env, system, status, msg) {
  if (system.status === status && system.status_msg === msg) return;
  system.status = status;
  system.status_msg = msg;
  await run(env, 'UPDATE v2_systems SET status = ?, status_msg = ?, last_check_at = ? WHERE id = ?', status, msg, Date.now(), system.id);
}

async function relogin(env, system) {
  if (system.auth_type !== 'password' || !system.secret_enc) return null;
  const password = await decryptSecret(env, system.secret_enc);
  const r = await rawCall('Login', { username: system.number, password });
  if (!isOk(r) || !r.token) return null;
  const tokenEnc = await encryptSecret(env, r.token);
  await run(env, 'UPDATE v2_systems SET token_enc = ? WHERE id = ?', tokenEnc, system.id);
  system.token_enc = tokenEnc;
  return r.token;
}

export async function callSystem(env, system, endpoint, params = {}) {
  let token = await decryptSecret(env, system.token_enc);
  let r = await rawCall(endpoint, { ...params, token });
  if (looksLikeTokenProblem(r) && !looksLikeMfa(r)) {
    const fresh = await relogin(env, system);
    if (fresh) r = await rawCall(endpoint, { ...params, token: fresh });
  }
  if (!isOk(r)) {
    if (r.responseStatus === 'NETWORK') fail(502, r.message);
    const mfa = looksLikeMfa(r);
    await setStatus(env, system, mfa ? 'mfa' : 'error', String(r.message || 'שגיאה').slice(0, 200));
    fail(502, mfa
      ? `המערכת "${system.name}" דורשת אימות דו-שלבי. היכנס ל"מערכות" והשלם אימות.`
      : `ימות המשיח החזירה שגיאה עבור "${system.name}": ${r.message || r.responseStatus}`, mfa ? 'system_mfa' : 'system_error');
  }
  if (system.status !== 'ok') await setStatus(env, system, 'ok', null);
  return r;
}

// ---------- הודעות ----------
const cache = new Map(); // מטמון קצר לכל isolate — חוסך קריאות כפולות לימות
const CACHE_TTL = 8000;

export function invalidateSystemCache(systemId) {
  for (const k of cache.keys()) if (k.startsWith(`${systemId}:`)) cache.delete(k);
}

const keyOf = (m) => `${m.out ? 'o' : 'i'}|${m.time}|${m.phone}|${m.text.length}|${m.text.slice(0, 24)}`;

export async function fetchMessages(env, system, { limit = 1500, fresh = false } = {}) {
  const ck = `${system.id}:${limit}`;
  const hit = cache.get(ck);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const [inc, out] = await Promise.all([
    callSystem(env, system, 'GetIncomingSms', { limit }),
    callSystem(env, system, 'GetSmsOutLog', { limit }),
  ]);
  const messages = [];
  for (const row of inc.rows || []) {
    const m = { phone: normalizePhone(row.source || row.phone), text: String(row.message ?? ''), time: String(row.receive_date || row.date || ''), out: false, status: null };
    m.key = keyOf(m);
    messages.push(m);
  }
  for (const row of out.rows || []) {
    const m = { phone: normalizePhone(row.To || row.to || row.phone), text: String(row.Message ?? row.message ?? ''), time: String(row.Time || row.time || ''), out: true, status: row.DeliveryReport || row.status || null };
    m.key = keyOf(m);
    messages.push(m);
  }
  // הסרת כפילויות ומיון כרונולוגי (פורמט התאריך של ימות ניתן למיון כמחרוזת)
  const seen = new Set();
  const data = messages.filter((m) => m.phone && !seen.has(m.key) && seen.add(m.key)).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

export async function fetchIncoming(env, system, limit = 200) {
  const r = await callSystem(env, system, 'GetIncomingSms', { limit });
  return (r.rows || []).map((row) => {
    const m = { phone: normalizePhone(row.source || row.phone), text: String(row.message ?? ''), time: String(row.receive_date || row.date || ''), out: false };
    m.key = keyOf(m);
    return m;
  }).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

export async function sendSms(env, system, phones, message, from) {
  const sender = from || system.sender || undefined;
  let sent = 0;
  const results = [];
  for (let i = 0; i < phones.length; i += SEND_CHUNK) {
    const chunk = phones.slice(i, i + SEND_CHUNK);
    const r = await callSystem(env, system, 'SendSms', { phones: chunk.join(PHONE_SEPARATOR), message, from: sender });
    sent += Number(r.sendCount ?? chunk.length);
    results.push({ count: chunk.length, billing: r.Billing ?? r.billing ?? null });
  }
  invalidateSystemCache(system.id);
  return { sent, results };
}

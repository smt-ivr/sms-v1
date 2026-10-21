// קריפטוגרפיה: גיבוב סיסמאות, הצפנת טוקנים, מחולל קודים מאובטח
import { fail } from './http.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(bytes = 32) {
  return b64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// מספר אקראי בטווח ללא הטיה
export function randomInt(max) {
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % max;
}

export function randomDigits(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += String(randomInt(10));
  return s;
}

// ללא תווים מבלבלים (0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(len = 10) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- סיסמאות: PBKDF2-SHA256 (Workers מגביל ל-100,000 איטרציות) ----------
const PBKDF2_ITER = 100000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterStr, saltB64, hashB64] = stored.split('$');
  const hash = await pbkdf2(password, unb64(saltB64), Number(iterStr));
  return timingSafeEqual(b64(hash), hashB64);
}

// ---------- הצפנת סודות (טוקנים/סיסמאות של ימות) AES-256-GCM ----------
let cachedKey = null;
let cachedKeySource = null;

async function getKey(env) {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) fail(500, 'ENCRYPTION_KEY לא הוגדר בשרת. ראה README.');
  if (cachedKey && cachedKeySource === raw) return cachedKey;
  let bytes;
  try { bytes = unb64(raw); } catch { bytes = null; }
  if (!bytes || bytes.length !== 32) {
    // מאפשר גם מחרוזת חופשית — נגזרת ממנה מפתח של 32 בתים
    bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(raw)));
  }
  cachedKey = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  cachedKeySource = raw;
  return cachedKey;
}

export async function encryptSecret(env, plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const key = await getKey(env);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plain)));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptSecret(env, packed) {
  if (!packed) return null;
  const [ver, ivB64, ctB64] = packed.split(':');
  if (ver !== 'v1') return null;
  const key = await getKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return dec.decode(pt);
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- קישורים חתומים (למשל להורדת קבצים) ----------
// הקישור עובד גם בלי עוגייה (למשל כשנטפרי בודק את הקובץ מהשרתים שלו), אבל חתום, מוגבל בזמן ומחזיר רק את הנתונים של המשתמש שיצר אותו
export async function signToken(env, purpose, payload) {
  const body = b64(enc.encode(JSON.stringify(payload))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!env.ENCRYPTION_KEY) fail(500, 'ENCRYPTION_KEY לא הוגדר בשרת. ראה README.');
  const sig = await hmacHex(`${env.ENCRYPTION_KEY}:${purpose}`, body);
  return `${body}.${sig.slice(0, 32)}`;
}

export async function verifyToken(env, purpose, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !env.ENCRYPTION_KEY) return null;
  const expected = (await hmacHex(`${env.ENCRYPTION_KEY}:${purpose}`, body)).slice(0, 32);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(dec.decode(unb64(body.replace(/-/g, '+').replace(/_/g, '/'))));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

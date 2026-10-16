// ולידציה ונרמול: מיילים, טלפונים, זמנים
import { fail } from './http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// דומיינים זמניים נפוצים — חוסם הרשמות "חד פעמיות"
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'sharklasers.com', 'maildrop.cc',
  'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com',
  'mailnesia.com', 'spamgourmet.com', 'moakt.com', 'tempr.email', 'discard.email', 'burnermail.io',
]);

export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'כתובת האימייל אינה תקינה.');
  return email;
}

// כתובת "קנונית" — מונעת פתיחת כמה חשבונות על אותו מייל עם טריקים (נקודות, +tag)
export function canonicalEmail(email) {
  let [local, domain] = email.split('@');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export function isDisposable(email) {
  const domain = email.split('@')[1] || '';
  return DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith('.' + d));
}

export function checkPassword(pw) {
  const p = String(pw || '');
  if (p.length < 8) fail(400, 'הסיסמה חייבת להכיל לפחות 8 תווים.');
  if (p.length > 128) fail(400, 'הסיסמה ארוכה מדי.');
  if (!/[A-Za-z\u0590-\u05FF]/.test(p) || !/\d/.test(p)) fail(400, 'הסיסמה חייבת לכלול גם אותיות וגם ספרות.');
  return p;
}

// נרמול טלפון ישראלי: 972501234567 / +972-50-123-4567 → 0501234567
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  if (/[a-zA-Z\u0590-\u05FF]/.test(s)) return s; // שולח אלפאנומרי
  let d = s.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d;
}

export function validPhone(p) {
  return /^0\d{8,9}$/.test(p) || /^\d{10,15}$/.test(p);
}

export function parsePhoneList(input, max = 5000) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const p = normalizePhone(raw);
    if (!p || seen.has(p)) continue;
    if (!validPhone(p)) fail(400, `מספר טלפון לא תקין: ${String(raw).slice(0, 30)}`);
    seen.add(p);
    out.push(p);
    if (out.length > max) fail(400, `ניתן לשלוח עד ${max} נמענים בפעולה אחת.`);
  }
  return out;
}

// ---------- זמן ישראל ----------
const IL_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
});
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function israelParts(ts = Date.now()) {
  const p = {};
  for (const { type, value } of IL_FMT.formatToParts(new Date(ts))) p[type] = value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    weekday: WD[p.weekday],
    minutes: Number(hour) * 60 + Number(p.minute),
    ymd: `${p.year}-${p.month}-${p.day}`,
    stamp: `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`, // אותו פורמט כמו ימות המשיח
  };
}

// תחילת היום הנוכחי (שעון ישראל) כ-timestamp — לחישוב מכסה יומית
export function israelDayStart(ts = Date.now()) {
  const { minutes } = israelParts(ts);
  const secs = new Date(ts).getUTCSeconds();
  return ts - minutes * 60_000 - secs * 1000 - (ts % 1000);
}

export function inWindow(rule, ts = Date.now()) {
  const { weekday, minutes } = israelParts(ts);
  if (!String(rule.days || '').includes(String(weekday))) return false;
  const s = rule.start_min ?? 0;
  const e = rule.end_min ?? 1440;
  if (s === e) return true;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // תומך בחלון שחוצה חצות
}

// ליבת הצד-לקוח: קריאות API, מצב, ניתוב, רכיבי ממשק ופורמטים
// הנתיב שבו האפליקציה מותקנת ('' בשורש, '/sms/v1' תחת נתיב) — מחושב ממיקום הקובץ הזה
export const BASE = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
export const href = (p) => (p.startsWith('/') ? BASE + p : p);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<span class="ms ${cls}" aria-hidden="true">${name}</span>`;

// ---------- מצב גלובלי ----------
export const state = {
  me: null,
  systems: [],
  systemId: Number(localStorage.getItem('smt2.system')) || null,
};

export function currentSystem() {
  return state.systems.find((s) => s.id === state.systemId) || state.systems[0] || null;
}

export function setSystem(id) {
  state.systemId = Number(id) || null;
  localStorage.setItem('smt2.system', String(state.systemId || ''));
  applySystemColor();
  window.dispatchEvent(new CustomEvent('system-change'));
}

export function applySystemColor() {
  const s = currentSystem();
  document.documentElement.style.setProperty('--sys', (s && s.color) || '');
  if (!s || !s.color) document.documentElement.style.removeProperty('--sys');
}

export const can = (feature) => !!(state.me && state.me.features && state.me.features[feature]);
export const isAdmin = () => !!(state.me && ['admin', 'owner'].includes(state.me.user.role));

// ---------- API ----------
export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
let unauthorizedHandler = null;
export const onUnauthorized = (fn) => { unauthorizedHandler = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'smt2' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(href(path), opts); } catch { throw new ApiError('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.', 0, 'network'); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new ApiError((data && data.error) || `שגיאה ${res.status}`, res.status, data && data.code);
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  return data;
}

// מריץ פעולה עם מצב "עסוק" על הכפתור ומציג שגיאה כטוסט
export async function withBusy(btn, fn) {
  if (btn) { btn.classList.add('busy'); btn.disabled = true; }
  try { return await fn(); } catch (e) { toast(e.message, 'err'); throw e; } finally { if (btn) { btn.classList.remove('busy'); btn.disabled = false; } }
}

// ---------- טוסטים ----------
export function toast(message, type = 'ok', ms = 4000) {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'err' ? 'error' : 'check_circle')}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- מודאל ----------
export function modal({ title, body = '', actions = [], wide = false, onOpen } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="סגירה">${icon('close')}</button></div>
      <div class="modal-body">${body}</div>
      ${actions.length ? '<div class="modal-foot"></div>' : ''}
    </div>`;
  const prevFocus = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-close]').addEventListener('click', close);
  const foot = wrap.querySelector('.modal-foot');
  const api2 = { el: wrap, body: wrap.querySelector('.modal-body'), close };
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-solid-danger' : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.classList.add('busy'); b.disabled = true;
      try { const keep = await a.onClick(api2); if (keep !== false) close(); } catch (e) { toast(e.message, 'err'); } finally { b.classList.remove('busy'); b.disabled = false; }
    });
    foot.appendChild(b);
  }
  // Enter בטופס = לחיצה על הכפתור הראשי
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && foot) {
      e.preventDefault();
      const primary = foot.querySelector('.btn-primary, .btn-solid-danger');
      if (primary) primary.click();
    }
  });
  document.body.appendChild(wrap);
  const firstInput = wrap.querySelector('.modal-body input:not([type=hidden]), .modal-body textarea, .modal-body select');
  (firstInput || wrap.querySelector('[data-close]')).focus();
  if (onOpen) onOpen(api2);
  return api2;
}

export function confirmDialog(text, { title = 'אישור', confirm = 'אישור', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: `<p>${esc(text)}</p>`,
      actions: [
        { label: 'ביטול', onClick: () => { done = true; resolve(false); } },
        { label: confirm, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

// ---------- תפריט צף ----------
let openPop = null;
export function popover(anchor, html, { className = '' } = {}) {
  closePopover();
  const el = document.createElement('div');
  el.className = `popover ${className}`;
  el.innerHTML = html;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  let left = r.left + r.width - w;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  const below = r.bottom + 6 + el.offsetHeight < window.innerHeight;
  el.style.left = `${left}px`;
  el.style.top = below ? `${r.bottom + 6 + window.scrollY}px` : `${Math.max(8, r.top - el.offsetHeight - 6 + window.scrollY)}px`;
  openPop = el;
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  return el;
}
function outside(e) { if (openPop && !openPop.contains(e.target)) closePopover(); }
export function closePopover() {
  if (openPop) { openPop.remove(); openPop = null; }
  document.removeEventListener('mousedown', outside);
}

// ---------- טפסים ----------
export function formValues(root) {
  const out = {};
  for (const el of root.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.tagName === 'SELECT' && el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value.trim();
  }
  return out;
}

// האזנה מואצלת: on(root, 'click', '[data-act=x]', fn)
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  });
}

export function copy(text, msg = 'הועתק') {
  navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast('לא ניתן להעתיק אוטומטית', 'err'));
}

export function download(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- פורמטים ----------
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

export function toDate(x) {
  if (x instanceof Date) return x;
  if (typeof x === 'number') return new Date(x);
  const s = String(x || '');
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}
const pad = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function hhmm(x) { const d = toDate(x); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
export function shortDate(x) { const d = toDate(x); return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}` : ''; }

// בתוך רשימה: שעה להיום, "אתמול", יום בשבוע, או תאריך
export function listTime(x) {
  const d = toDate(x);
  if (!d) return '';
  const now = new Date();
  if (sameDay(d, now)) return hhmm(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'אתמול';
  if (now - d < 6 * 86400_000) return WEEKDAYS[d.getDay()];
  return shortDate(d);
}

export function dayLabel(x) {
  const d = toDate(x);
  if (!d) return '';
  const now = new Date();
  if (sameDay(d, now)) return 'היום';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'אתמול';
  return `יום ${WEEKDAYS[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

export function fullTime(x) { const d = toDate(x); return d ? `${shortDate(d)} · ${hhmm(d)}` : '—'; }

export function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) { const f = -s; if (f < 3600) return `בעוד ${Math.ceil(f / 60)} דק׳`; if (f < 86400) return `בעוד ${Math.round(f / 3600)} שע׳`; return `בעוד ${Math.round(f / 86400)} ימים`; }
  if (s < 60) return 'הרגע';
  if (s < 3600) return `לפני ${Math.floor(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.floor(s / 3600)} שע׳`;
  if (s < 30 * 86400) return `לפני ${Math.floor(s / 86400)} ימים`;
  return shortDate(ts);
}

export const fmt = (n) => (n === null || n === undefined ? '∞' : Number(n).toLocaleString('he-IL'));
export const minToHm = (m) => `${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`;
export const hmToMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

export function initials(name, phone) {
  const n = String(name || '').trim();
  if (n) { const parts = n.split(/\s+/); return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase(); }
  return String(phone || '#').slice(-2);
}

export function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// אורך SMS: GSM ל-160 תווים, עברית/יוניקוד ל-70 (ולמקטעים 153/67)
export function smsInfo(text) {
  const t = String(text || '');
  const unicode = /[^\u0000-\u007F]/.test(t);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const parts = t.length === 0 ? 0 : t.length <= single ? 1 : Math.ceil(t.length / multi);
  return { length: t.length, parts, unicode };
}

export function statusIcon(status) {
  if (!status) return '';
  const s = String(status).toUpperCase();
  if (s === 'DELIVRD' || s === 'DELIVERED') return icon('done_all', 'ok');
  if (s === 'UNDELIV' || s === 'REJECTD' || s === 'FAILED') return icon('error', 'bad');
  if (s === 'EXPIRED') return icon('history');
  return icon('done');
}

export const STATUS_TEXT = { DELIVRD: 'נמסר', UNDELIV: 'לא נמסר', REJECTD: 'נדחה', EXPIRED: 'פג תוקף' };

export function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d;
}

// ---------- ניתוב (hash) ----------
const routes = [];
let cleanup = null;
let renderToken = 0;
export function route(pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ pattern, re, keys, handler, ...opts });
}
export const go = (hash) => { if (location.hash === hash) renderRoute(); else location.hash = hash; };

export async function renderRoute(host, setTitle) {
  host = host || document.getElementById('view');
  if (!host) return;
  const raw = (location.hash || '#/').slice(1) || '/';
  const [path, qs] = raw.split('?');
  const query = new URLSearchParams(qs || '');
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const token = ++renderToken;
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    if (setTitle) setTitle(r);
    host.scrollTop = 0;
    try {
      const c = await r.handler(host, params, query);
      if (token === renderToken) cleanup = typeof c === 'function' ? c : null;
      else if (typeof c === 'function') c();
    } catch (e) {
      if (token === renderToken) host.innerHTML = errorState(e.message);
    }
    return;
  }
  host.innerHTML = errorState('העמוד לא נמצא.');
}

export function errorState(msg) {
  return `<div class="page"><div class="empty">${icon('cloud_off')}<h3>משהו השתבש</h3><p>${esc(msg)}</p><a class="btn" href="#/">חזרה ללוח הבקרה</a></div></div>`;
}
export function loadingState() {
  return `<div class="page"><div class="skeleton" style="height:28px;width:220px;margin-bottom:22px"></div><div class="skeleton" style="height:90px;margin-bottom:16px"></div><div class="skeleton" style="height:260px"></div></div>`;
}
export function emptyState({ ic = 'inbox', title, text = '', action = '' }) {
  return `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}

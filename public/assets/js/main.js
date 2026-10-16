// אתחול האפליקציה: מעטפת, ניווט, התראות, ערכת צבע
import { api, state, $, esc, icon, can, isAdmin, onUnauthorized, renderRoute, setSystem, currentSystem, applySystemColor, popover, closePopover, ago, initials, toast, on } from './core.js';
import { showAuth } from './views/auth.js';
import * as dashboard from './views/dashboard.js';
import * as inbox from './views/inbox.js';
import * as contacts from './views/contacts.js';
import * as campaigns from './views/campaigns.js';
import * as automations from './views/automations.js';
import * as systems from './views/systems.js';
import * as shares from './views/shares.js';
import * as developers from './views/developers.js';
import * as support from './views/support.js';
import * as account from './views/account.js';
import * as admin from './views/admin.js';

const app = document.getElementById('app');

// ---------- ערכת צבע ----------
function applyTheme() {
  const t = localStorage.getItem('smt2.theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

// ---------- טעינת המשתמש ----------
export async function loadMe() {
  const [me, sys] = await Promise.all([api('/api/me'), api('/api/systems')]);
  state.me = me;
  state.systems = sys;
  if (!state.systems.find((s) => s.id === state.systemId)) state.systemId = state.systems[0] ? state.systems[0].id : null;
  applySystemColor();
  return me;
}
export async function reloadSystems() {
  state.systems = await api('/api/systems');
  if (!state.systems.find((s) => s.id === state.systemId)) setSystem(state.systems[0] ? state.systems[0].id : null);
  renderSystemSwitch();
}
window.addEventListener('systems-changed', reloadSystems);

// ---------- ניווט ----------
function navItems() {
  const me = state.me;
  const work = [
    { href: '#/', ic: 'space_dashboard', label: 'לוח בקרה', key: 'dashboard' },
    { href: '#/inbox', ic: 'forum', label: 'הודעות', key: 'inbox' },
    can('contacts') && { href: '#/contacts', ic: 'contacts', label: 'אנשי קשר', key: 'contacts' },
    can('messages.send') && { href: '#/campaigns', ic: 'campaign', label: 'שליחה וקמפיינים', key: 'campaigns' },
    (can('rules.email') || can('rules.autoreply') || can('rules.webhook')) && { href: '#/automations', ic: 'bolt', label: 'אוטומציות', key: 'automations' },
  ];
  const setup = [
    { href: '#/systems', ic: 'dns', label: 'מערכות', key: 'systems' },
    can('shares') && { href: '#/shares', ic: 'key', label: 'גישת אורחים', key: 'shares' },
    can('api') && { href: '#/developers', ic: 'code', label: 'API למפתחים', key: 'developers' },
    me.app.support_enabled && can('support') && { href: '#/support', ic: 'support_agent', label: 'תמיכה', key: 'support', count: me.unread.support },
  ];
  const adm = isAdmin() && !me.impersonator ? [
    { href: '#/admin', ic: 'monitoring', label: 'סקירה', key: 'admin' },
    { href: '#/admin/users', ic: 'group', label: 'משתמשים', key: 'admin-users', count: me.admin ? me.admin.pending : 0 },
    { href: '#/admin/features', ic: 'tune', label: 'הרשאות וחבילות', key: 'admin-features' },
    { href: '#/admin/support', ic: 'mark_chat_unread', label: 'פניות', key: 'admin-support', count: me.admin ? me.admin.support_unread : 0 },
    { href: '#/admin/announce', ic: 'campaign', label: 'הודעות מערכת', key: 'admin-announce' },
    { href: '#/admin/logs', ic: 'receipt_long', label: 'יומנים', key: 'admin-logs' },
    { href: '#/admin/settings', ic: 'settings', label: 'הגדרות מערכת', key: 'admin-settings' },
    { href: '#/admin/legacy', ic: 'history', label: 'הגרסה הישנה', key: 'admin-legacy' },
  ] : [];
  const link = (i) => i && `<a href="${i.href}" data-key="${i.key}">${icon(i.ic)}<span>${i.label}</span>${i.count ? `<span class="count">${i.count}</span>` : ''}</a>`;
  return `
    ${work.map(link).join('')}
    <div class="nav-group">הגדרות</div>
    ${setup.map(link).join('')}
    ${adm.length ? `<div class="nav-group">ניהול</div>${adm.map(link).join('')}` : ''}`;
}

function renderSystemSwitch() {
  const host = $('#sys-switch');
  if (!host) return;
  const cur = currentSystem();
  if (!state.systems.length) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.innerHTML = `
    <span class="sys-dot" style="--c:${esc(cur ? cur.color || '' : '')}"></span>
    <label class="sr-only" for="sys-select">מערכת פעילה</label>
    <select id="sys-select">${state.systems.map((s) => `<option value="${s.id}" ${cur && s.id === cur.id ? 'selected' : ''}>${esc(s.name)}${s.status !== 'ok' ? ' ⚠' : ''}</option>`).join('')}</select>`;
  $('#sys-select').addEventListener('change', (e) => setSystem(e.target.value));
}

function renderCounts() {
  const nav = $('#nav');
  if (nav) {
    const active = nav.querySelector('a.active');
    const key = active ? active.dataset.key : null;
    nav.innerHTML = navItems();
    if (key) { const a = nav.querySelector(`a[data-key="${key}"]`); if (a) a.classList.add('active'); }
  }
  const bell = $('#bell-count');
  if (bell) {
    const n = state.me.unread.notifications;
    bell.textContent = n > 99 ? '99+' : n;
    bell.classList.toggle('hidden', !n);
  }
}

function renderShell() {
  const me = state.me;
  app.innerHTML = `
    ${me.impersonator ? `<div class="imp-bar">${icon('visibility')} אתה צופה בחשבון של ${esc(me.user.name)} בתור ${esc(me.impersonator.name)} <button id="imp-stop">חזרה לחשבון שלי</button></div>` : ''}
    <div class="shell" id="shell" style="${me.impersonator ? 'height:calc(100dvh - 38px)' : ''}">
      <aside class="rail" aria-label="ניווט ראשי">
        <a class="brand" href="#/"><span class="brand-mark">${icon('sms', 'fill')}</span><span><b>${esc(me.app.name)}</b><small>גרסה 2</small></span></a>
        <nav class="nav" id="nav">${navItems()}</nav>
        <div class="rail-foot">
          <button class="me-chip" id="me-chip"><span class="avatar">${esc(initials(me.user.name))}</span><span class="t"><b>${esc(me.user.name)}</b><small>${esc(me.plan.name)}${isAdmin() ? ' · מנהל' : ''}</small></span></button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-toggle" id="menu-toggle" aria-label="תפריט">${icon('menu')}</button>
          <div class="title" id="page-title"></div>
          <div class="sys-switch" id="sys-switch"></div>
          <button class="icon-btn" id="bell" aria-label="התראות">${icon('notifications')}<span class="dot-count hidden" id="bell-count"></span></button>
        </header>
        <main class="view" id="view"></main>
      </div>
    </div>`;
  renderSystemSwitch();
  renderCounts();

  const shell = $('#shell');
  $('#menu-toggle').addEventListener('click', () => shell.classList.toggle('nav-open'));
  shell.addEventListener('click', (e) => { if (e.target.closest('.nav a')) shell.classList.remove('nav-open'); });
  $('#bell').addEventListener('click', (e) => openNotifications(e.currentTarget));
  $('#me-chip').addEventListener('click', (e) => openMeMenu(e.currentTarget));
  const stop = $('#imp-stop');
  if (stop) stop.addEventListener('click', async () => { await api('/api/auth/impersonate/stop', { method: 'POST' }); location.hash = '#/admin/users'; location.reload(); });
  route();
}

function setTitle(r) {
  const t = $('#page-title');
  if (t) t.textContent = r.title || '';
  document.title = `${r.title ? r.title + ' · ' : ''}${state.me ? state.me.app.name : 'S.M.T'}`;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.key === r.nav);
}

const route = () => renderRoute($('#view'), setTitle);
window.addEventListener('hashchange', () => { closePopover(); if (state.me && $('#view')) route(); });
window.addEventListener('system-change', () => { renderSystemSwitch(); route(); });

// ---------- התראות ----------
async function openNotifications(anchor) {
  const pop = popover(anchor, `<div class="notif-pop"><div class="panel-head"><h3>התראות</h3><button class="btn btn-sm btn-ghost" data-act="readall">סמן הכל כנקרא</button></div><div class="notif-list"><div class="empty small">טוען…</div></div></div>`);
  const list = pop.querySelector('.notif-list');
  try {
    const items = await api('/api/notifications');
    list.innerHTML = items.length ? items.map((n) => `
      <a class="notif ${n.is_read ? '' : 'unread'}" href="${esc(n.link || '#/')}">
        <b>${esc(n.title)}</b>${n.body ? `<p>${esc(n.body)}</p>` : ''}<time>${ago(n.created_at)}</time>
      </a>`).join('') : `<div class="empty">${icon('notifications_off')}<p>אין התראות חדשות.</p></div>`;
  } catch (e) { list.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; }
  pop.querySelector('[data-act=readall]').addEventListener('click', async () => {
    await api('/api/notifications/read-all', { method: 'POST' });
    state.me.unread.notifications = 0;
    renderCounts();
    closePopover();
  });
  if (state.me.unread.notifications) {
    api('/api/notifications/read-all', { method: 'POST' }).then(() => { state.me.unread.notifications = 0; renderCounts(); }).catch(() => {});
  }
}

function openMeMenu(anchor) {
  const theme = localStorage.getItem('smt2.theme') || 'auto';
  const pop = popover(anchor, `<div class="menu">
      <a href="#/account">${icon('person')} החשבון שלי</a>
      <hr>
      <button data-theme="auto">${icon(theme === 'auto' ? 'radio_button_checked' : 'radio_button_unchecked')} ערכת צבע לפי המכשיר</button>
      <button data-theme="light">${icon(theme === 'light' ? 'radio_button_checked' : 'radio_button_unchecked')} בהיר</button>
      <button data-theme="dark">${icon(theme === 'dark' ? 'radio_button_checked' : 'radio_button_unchecked')} כהה</button>
      <hr>
      <button data-act="logout">${icon('logout')} התנתקות</button>
    </div>`);
  on(pop, 'click', '[data-theme]', (e, b) => { localStorage.setItem('smt2.theme', b.dataset.theme); applyTheme(); closePopover(); });
  on(pop, 'click', '[data-act=logout]', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.me = null;
    location.hash = '#/';
    boot();
  });
  on(pop, 'click', 'a', () => closePopover());
}

// רענון מונים ברקע
let tick = null;
function startTicker() {
  clearInterval(tick);
  tick = setInterval(async () => {
    if (document.hidden || !state.me) return;
    try {
      const me = await api('/api/me');
      const changed = me.unread.notifications > state.me.unread.notifications;
      state.me = me;
      renderCounts();
      if (changed) toast('יש לך התראה חדשה');
    } catch { /* שקט */ }
  }, 60_000);
}

// ---------- רישום עמודים ----------
for (const v of [dashboard, inbox, contacts, campaigns, automations, systems, shares, developers, support, account, admin]) v.register();

// ---------- אתחול ----------
export async function boot(message) {
  onUnauthorized(() => { if (state.me) { state.me = null; showAuth(app, { onDone: boot, message: 'פג תוקף ההתחברות. היכנס שוב.' }); } });
  try {
    await loadMe();
    renderShell();
    startTicker();
  } catch (e) {
    clearInterval(tick);
    if (e.status === 401 || e.status === 403 || e.status === 503) showAuth(app, { onDone: boot, message: e.status === 401 ? message : e.message, maintenance: e.status === 503 });
    else {
      app.innerHTML = `<div class="page"><div class="empty">${icon('cloud_off')}<h3>לא ניתן להתחבר לשרת</h3><p>${esc(e.message)}</p><button class="btn" id="retry">נסה שוב</button></div></div>`;
      document.getElementById('retry').addEventListener('click', () => location.reload());
    }
  }
}

boot();

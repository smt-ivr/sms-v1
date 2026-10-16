// עמוד אורח: כניסה עם קוד גישה ועבודה מוגבלת לפי ההרשאות — דרך השרת בלבד
import { api, href, $, esc, icon, toast, on, onUnauthorized, listTime, dayLabel, hhmm, initials, linkify, smsInfo, statusIcon, normPhone, ago, modal, formValues } from './core.js';

const app = document.getElementById('app');
let timer = null;

function loginScreen(msg) {
  clearInterval(timer);
  const pre = (location.hash || '').slice(1).replace(/[^A-Za-z0-9]/g, '');
  app.innerHTML = `
    <div class="auth" style="grid-template-columns:1fr"><section class="auth-form"><div class="auth-card">
      <div class="brand" style="padding:0 0 26px;color:var(--ink)"><span class="brand-mark">${icon('key', 'fill')}</span><span><b>גישת אורח</b><small style="color:var(--muted)">S.M.T Messages</small></span></div>
      <h1>הזנת קוד גישה</h1><p class="sub">את הקוד קיבלת מבעל החשבון. הגישה מוגבלת בזמן ובהרשאות.</p>
      ${msg ? `<div class="banner banner-warn">${icon('info')}<div>${esc(msg)}</div></div>` : ''}
      <form id="f"><div class="field"><label for="code" class="sr-only">קוד</label><input id="code" class="code-input" style="letter-spacing:6px;font-size:22px!important" autocomplete="off" autocapitalize="characters" value="${esc(pre)}" placeholder="XXXXXXXXXX"></div>
      <button class="btn btn-primary btn-block" type="submit">כניסה</button></form>
      <div class="alt"><a href="${href('/')}">כניסה לבעלי חשבון</a></div>
    </div></section></div>`;
  const f = $('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.classList.add('busy'); btn.disabled = true;
    try {
      await api('/api/guest/login', { method: 'POST', body: { code: $('#code').value } });
      history.replaceState(null, '', href('/guest.html'));
      start();
    } catch (err) { toast(err.message, 'err'); } finally { btn.classList.remove('busy'); btn.disabled = false; }
  });
  if (pre) f.requestSubmit(); else $('#code').focus();
}

async function start() {
  let me;
  try { me = await api('/api/guest/me'); } catch { return loginScreen(); }
  onUnauthorized((e) => loginScreen(e.message));
  const s = { convs: [], active: null };
  app.innerHTML = `
    <div style="height:100dvh;display:flex;flex-direction:column">
      <header class="topbar"><span class="brand-mark" style="width:30px;height:30px;border-radius:8px;background:var(--accent);display:grid;place-items:center">${icon('key', 'fill')}</span>
        <div class="title">${esc(me.label)} <span class="muted small">· ${esc(me.system_name)}</span></div>
        <span class="badge hide-sm">${me.can_read ? 'צפייה' : ''}${me.can_read && me.can_send ? ' + ' : ''}${me.can_send ? 'שליחה' : ''}</span>
        ${me.expires_at ? `<span class="badge badge-warn" id="exp"></span>` : ''}
        <button class="btn btn-sm" id="out">${icon('logout')} יציאה</button></header>
      <div class="inbox" id="inbox" style="flex:1;min-height:0">
        <section class="conv-col"><div class="conv-tools"><div class="search">${icon('search')}<input id="q" type="search" placeholder="חיפוש"></div>
          ${me.can_send ? `<button class="btn btn-primary btn-sm" id="new">${icon('edit_square')}</button>` : ''}</div><div class="conv-list" id="list"></div></section>
        <section class="thread-col" id="thread"><div class="thread-empty"><div>${icon('forum', 'big')}<p class="muted">בחר שיחה</p></div></div></section>
      </div></div>`;
  const list = $('#list');
  const thread = $('#thread');
  const exp = $('#exp');
  const tickExp = () => { if (exp) exp.textContent = me.expires_at > Date.now() ? `נסגר ${ago(me.expires_at)}` : 'הגישה הסתיימה'; };
  tickExp();

  const renderList = () => {
    const q = ($('#q').value || '').toLowerCase();
    const items = s.convs.filter((c) => !q || `${c.name || ''} ${c.phone} ${c.last.text}`.toLowerCase().includes(q));
    list.innerHTML = items.length ? items.map((c) => `<div class="conv ${c.phone === s.active ? 'active' : ''}" data-phone="${esc(c.phone)}" role="button" tabindex="0">
      <span class="avatar">${esc(initials(c.name, c.phone))}</span><span class="who">${esc(c.name || c.phone)}</span><span class="when">${listTime(c.last.time)}</span>
      <span class="snip">${c.last.out ? icon('reply') : ''}${esc(c.last.text)}</span><span class="meta"></span></div>`).join('')
      : `<div class="empty small">${me.can_read ? 'אין שיחות.' : 'לקוד הזה יש הרשאת שליחה בלבד.'}</div>`;
  };
  const loadConvs = async () => { try { s.convs = (await api('/api/guest/conversations')).conversations; renderList(); } catch (e) { if (e.status !== 401) list.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; } };

  const loadThread = async () => {
    const t = await api(`/api/guest/thread?phone=${encodeURIComponent(s.active)}`);
    let last = '';
    const rows = t.messages.map((m) => { const d = dayLabel(m.time); const sep = d !== last ? `<div class="day-sep">${esc(d)}</div>` : ''; last = d; return `${sep}<div class="bubble ${m.out ? 'out' : 'in'}">${linkify(m.text)}<div class="foot">${hhmm(m.time)} ${m.out ? statusIcon(m.status) : ''}</div></div>`; }).join('');
    const draft = $('#msg') ? $('#msg').value : '';
    thread.innerHTML = `
      <div class="thread-head"><button class="icon-btn show-sm" id="back">${icon('arrow_forward')}</button><span class="avatar">${esc(initials(t.name, t.phone))}</span><div class="who"><b>${esc(t.name || t.phone)}</b><small class="ltr">${esc(t.phone)}</small></div></div>
      <div class="thread-body" id="tb">${rows || `<div class="thread-empty"><p class="muted">אין הודעות קודמות.</p></div>`}</div>
      ${me.can_send ? `<div class="composer"><div class="composer-row"><textarea id="msg" rows="1" placeholder="כתיבת הודעה…"></textarea><button class="send" id="send">${icon('send')}</button></div>
        <div class="composer-meta"><span class="grow"></span><span id="count"></span>${me.max_sends ? `<span>${me.sends}/${me.max_sends} שליחות</span>` : ''}</div></div>` : ''}`;
    if ($('#msg')) $('#msg').value = draft;
    const tb = $('#tb'); tb.scrollTop = tb.scrollHeight;
  };
  const open = (phone) => { s.active = phone; $('#inbox').classList.add('show-thread'); renderList(); loadThread().catch((e) => toast(e.message, 'err')); };

  const send = async () => {
    const msg = $('#msg');
    const text = msg.value.trim();
    if (!text) return;
    const btn = $('#send'); btn.disabled = true;
    try { await api('/api/guest/send', { method: 'POST', body: { phone: s.active, message: text } }); msg.value = ''; me.sends++; toast('נשלח'); setTimeout(() => { loadThread(); loadConvs(); }, 1200); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
  };

  on(list, 'click', '.conv', (e, el) => open(el.dataset.phone));
  on(thread, 'click', '#send', send);
  on(thread, 'click', '#back', () => { $('#inbox').classList.remove('show-thread'); s.active = null; renderList(); });
  on(thread, 'keydown', '#msg', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  on(thread, 'input', '#msg', (e, t) => { const i = smsInfo(t.value); $('#count').textContent = i.length ? `${i.length} תווים · ${i.parts} SMS` : ''; });
  $('#q').addEventListener('input', renderList);
  $('#out').addEventListener('click', async () => { await api('/api/guest/logout', { method: 'POST' }).catch(() => {}); loginScreen(); });
  const nb = $('#new');
  if (nb) nb.addEventListener('click', () => modal({
    title: 'הודעה חדשה',
    body: me.phones.length
      ? `<div class="field"><label>אל</label><select name="phone">${me.phones.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select></div>`
      : '<div class="field"><label>מספר טלפון</label><input name="phone" class="ltr" inputmode="tel"></div>',
    actions: [{ label: 'ביטול' }, { label: 'פתיחה', kind: 'primary', onClick: (m) => { const p = normPhone(formValues(m.body).phone); if (!/^\d{9,15}$/.test(p)) { toast('מספר לא תקין', 'err'); return false; } open(p); return true; } }],
  }));

  await loadConvs();
  timer = setInterval(() => { if (!document.hidden) { loadConvs(); tickExp(); if (s.active && !$('#msg')?.value) loadThread().catch(() => {}); } }, 20_000);
}

start();

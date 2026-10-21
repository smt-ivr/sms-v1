// תיבת הודעות: רשימת שיחות + שיחה + פאנל איש קשר
import {
  api, route, $, esc, icon, currentSystem, can, toast, modal, popover, closePopover, confirmDialog, on, formValues,
  listTime, dayLabel, hhmm, initials, linkify, smsInfo, statusIcon, STATUS_TEXT, normPhone, emptyState, fmt, exportFile,
} from '../core.js';

const POLL_MS = 15_000;

export function register() {
  route('/inbox', (view, _p, query) => mountInbox(view, query), { title: 'הודעות', nav: 'inbox' });
}

function mountInbox(view, query) {
  const sys = currentSystem();
  if (!sys) {
    view.innerHTML = `<div class="page">${emptyState({ ic: 'dns', title: 'אין מערכת מחוברת', text: 'כדי לראות הודעות, חבר קודם מערכת של ימות המשיח.', action: '<a class="btn btn-primary" href="#/systems">חיבור מערכת</a>' })}</div>`;
    return null;
  }
  const s = {
    convs: [], filter: 'all', q: '', active: normPhone(query.get('phone')) || null, thread: null,
    info: localStorage.getItem('smt2.info') === '1', templates: null, lastSig: '', timer: null, sending: false,
  };

  view.innerHTML = `
    <div class="inbox ${s.info ? 'with-info' : ''}" id="inbox">
      <section class="conv-col" aria-label="שיחות">
        <div class="conv-tools">
          <div class="search">${icon('search')}<input id="q" type="search" placeholder="חיפוש" aria-label="חיפוש"></div>
          ${can('messages.send') ? `<button class="btn btn-primary btn-sm" id="new-conv" title="שיחה חדשה">${icon('edit_square')}</button>` : ''}
          <button class="icon-btn" id="more" aria-label="עוד">${icon('more_vert')}</button>
        </div>
        <div class="conv-filter" id="filters">
          <button class="chip on" data-f="all">הכל</button>
          <button class="chip" data-f="unread">לא נקראו</button>
          <button class="chip" data-f="pinned">מוצמדות</button>
          <button class="chip" data-f="fav">מועדפים</button>
          <button class="chip" data-f="archived">ארכיון</button>
        </div>
        <div class="conv-list" id="list"><div class="empty small">טוען שיחות…</div></div>
      </section>
      <section class="thread-col" id="thread" aria-label="שיחה"></section>
      <aside class="info-col ${s.info ? '' : 'hidden'}" id="info" aria-label="פרטי איש קשר"></aside>
    </div>`;
  const root = $('#inbox', view);
  const listEl = $('#list', view);
  const threadEl = $('#thread', view);
  const infoEl = $('#info', view);

  // ---------- רשימה ----------
  const visible = () => {
    const q = s.q.toLowerCase();
    return s.convs.filter((c) => {
      if (s.filter === 'archived') { if (!c.archived) return false; } else if (c.archived) return false;
      if (s.filter === 'unread' && !c.unread) return false;
      if (s.filter === 'pinned' && !c.pinned) return false;
      if (s.filter === 'fav' && !c.favorite) return false;
      if (q && !(`${c.name || ''} ${c.phone} ${c.last.text}`.toLowerCase().includes(q))) return false;
      return true;
    });
  };

  function renderList() {
    const items = visible();
    if (!items.length) {
      listEl.innerHTML = s.convs.length ? `<div class="empty small">${icon('filter_alt_off')}<p>אין שיחות שמתאימות לסינון.</p></div>`
        : emptyState({ ic: 'forum', title: 'אין עדיין הודעות', text: 'כשתתקבל או תישלח הודעה מהמערכת, היא תופיע כאן.' });
      return;
    }
    listEl.innerHTML = items.slice(0, 500).map((c) => `
      <div class="conv ${c.unread ? 'unread' : ''} ${c.phone === s.active ? 'active' : ''}" data-phone="${esc(c.phone)}" role="button" tabindex="0">
        <span class="avatar">${esc(initials(c.name, c.phone))}</span>
        <span class="who ${c.name ? '' : 'ltr'}">${esc(c.name || c.phone)}</span>
        <span class="when">${listTime(c.last.time)}</span>
        <span class="snip">${c.last.out ? icon('reply') : ''}${esc(c.last.text)}</span>
        <span class="meta">${c.pinned ? icon('push_pin', 'pin') : ''}${c.favorite ? icon('star', 'pin fill') : ''}${c.unread ? `<span class="unread-n">${c.unread}</span>` : ''}</span>
      </div>`).join('') + (items.length > 500 ? `<div class="empty small">מוצגות 500 שיחות ראשונות. השתמש בחיפוש.</div>` : '');
  }

  async function loadConvs(fresh = false) {
    try {
      const data = await api(`/api/messages/conversations?system=${sys.id}${fresh ? '&fresh=1' : ''}`);
      const sig = data.conversations.map((c) => `${c.phone}${c.last.time}${c.unread}${c.pinned}${c.archived}`).join('|');
      const activeBefore = s.convs.find((c) => c.phone === s.active);
      s.convs = data.conversations;
      if (sig !== s.lastSig) { s.lastSig = sig; renderList(); }
      const activeNow = s.convs.find((c) => c.phone === s.active);
      if (s.active && activeNow && activeBefore && activeNow.last.time !== activeBefore.last.time && !s.sending) loadThread(true);
    } catch (e) {
      if (!s.convs.length) listEl.innerHTML = `<div class="empty small">${icon('link_off')}<h3>לא ניתן לטעון הודעות</h3><p>${esc(e.message)}</p><a class="btn btn-sm" href="#/systems">בדיקת המערכת</a></div>`;
    }
  }

  // ---------- שיחה ----------
  function threadHtml(t) {
    const name = t.contact && t.contact.name;
    let last = '';
    const rows = [];
    for (const m of t.messages) {
      const d = dayLabel(m.time);
      if (d !== last) { rows.push(`<div class="day-sep">${esc(d)}</div>`); last = d; }
      const st = m.out && m.status ? ` title="${esc(STATUS_TEXT[m.status] || m.status)}"` : '';
      rows.push(`<div class="bubble ${m.out ? 'out' : 'in'}">${linkify(m.text)}<div class="foot"${st}>${hhmm(m.time)} ${m.out ? statusIcon(m.status) : ''}</div></div>`);
    }
    return `
      <div class="thread-head">
        <button class="icon-btn show-sm" data-act="back" aria-label="חזרה">${icon('arrow_forward')}</button>
        <span class="avatar">${esc(initials(name, t.phone))}</span>
        <div class="who"><b class="${name ? '' : 'ltr'}">${esc(name || t.phone)}</b><small class="ltr">${name ? esc(t.phone) : `${t.messages.length} הודעות`}</small></div>
        <button class="icon-btn" data-act="pin" title="${t.pinned ? 'ביטול הצמדה' : 'הצמדה'}">${icon('push_pin', t.pinned ? 'fill' : '')}</button>
        <button class="icon-btn" data-act="archive" title="${t.archived ? 'הוצאה מהארכיון' : 'העברה לארכיון'}">${icon(t.archived ? 'unarchive' : 'archive')}</button>
        <button class="icon-btn" data-act="info" title="פרטי איש קשר">${icon('info')}</button>
      </div>
      <div class="thread-body" id="tb">${rows.join('') || `<div class="thread-empty"><div>${icon('chat', 'big')}<p>זו תחילת השיחה עם ${esc(name || t.phone)}.</p></div></div>`}</div>
      ${can('messages.send') ? `
      <div class="composer">
        <div class="composer-row">
          <textarea id="msg" rows="1" placeholder="כתיבת הודעה…" aria-label="הודעה"></textarea>
          <button class="send" id="send" aria-label="שליחה">${icon('send')}</button>
        </div>
        <div class="composer-meta">
          ${can('templates') ? `<button class="btn btn-sm btn-ghost" data-act="templates">${icon('text_snippet')} תבניות</button>` : ''}
          <span class="grow"></span><span id="count"></span><span class="hide-sm">Enter לשליחה · Shift+Enter לשורה חדשה</span>
        </div>
      </div>` : ''}
`;
  }

  function scrollBottom() { const tb = $('#tb', threadEl); if (tb) tb.scrollTop = tb.scrollHeight; }

  async function loadThread(silent = false) {
    if (!s.active) {
      threadEl.innerHTML = `<div class="thread-empty"><div>${icon('forum', 'big')}<h3>בחר שיחה</h3><p class="muted">או התחל שיחה חדשה עם הכפתור שליד החיפוש.</p></div></div>`;
      renderInfo();
      return;
    }
    if (!silent) threadEl.innerHTML = `<div class="thread-empty"><div class="muted">טוען שיחה…</div></div>`;
    try {
      const phone = s.active;
      const t = await api(`/api/messages/thread?system=${sys.id}&phone=${encodeURIComponent(phone)}&mark=1`);
      if (phone !== s.active) return;
      const tb = $('#tb', threadEl);
      const atBottom = !tb || tb.scrollHeight - tb.scrollTop - tb.clientHeight < 80;
      const draft = $('#msg', threadEl) ? $('#msg', threadEl).value : '';
      s.thread = t;
      threadEl.innerHTML = threadHtml(t);
      const msg = $('#msg', threadEl);
      if (msg) { msg.value = draft; autosize(msg); updateCount(); }
      if (!silent || atBottom) scrollBottom();
      const c = s.convs.find((x) => x.phone === phone);
      if (c && c.unread) { c.unread = 0; renderList(); }
      renderInfo();
    } catch (e) {
      threadEl.innerHTML = `<div class="thread-empty"><div>${icon('error')}<p>${esc(e.message)}</p></div></div>`;
    }
  }

  function open(phone) {
    s.active = phone;
    root.classList.add('show-thread');
    history.replaceState(null, '', `#/inbox?phone=${encodeURIComponent(phone)}`);
    renderList();
    loadThread();
  }

  // ---------- כתיבה ושליחה ----------
  function autosize(t) { t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; }
  function updateCount() {
    const msg = $('#msg', threadEl);
    const out = $('#count', threadEl);
    if (!msg || !out) return;
    const i = smsInfo(msg.value);
    out.textContent = i.length ? `${i.length} תווים · ${i.parts} SMS` : '';
  }

  async function send() {
    const msg = $('#msg', threadEl);
    const btn = $('#send', threadEl);
    const text = msg.value.trim();
    if (!text || s.sending) return;
    s.sending = true;
    btn.disabled = true;
    const tb = $('#tb', threadEl);
    const empty = tb.querySelector('.thread-empty');
    if (empty) empty.remove();
    const bubble = document.createElement('div');
    bubble.className = 'bubble out sending';
    bubble.innerHTML = `${linkify(text)}<div class="foot">${icon('schedule')}</div>`;
    tb.appendChild(bubble);
    scrollBottom();
    msg.value = ''; autosize(msg); updateCount();
    try {
      await api('/api/messages/send', { method: 'POST', body: { system: sys.id, phones: [s.active], message: text } });
      bubble.classList.remove('sending');
      bubble.querySelector('.foot').innerHTML = `${hhmm(new Date())} ${icon('done')}`;
      s.sending = false;
      setTimeout(() => { loadConvs(true); }, 1500);
    } catch (e) {
      bubble.classList.remove('sending');
      bubble.querySelector('.foot').innerHTML = `${icon('error', 'bad')} לא נשלח`;
      msg.value = text; autosize(msg); updateCount();
      toast(e.message, 'err');
      s.sending = false;
    } finally {
      btn.disabled = false;
      msg.focus();
    }
  }

  async function showTemplates(anchor) {
    if (!s.templates) { try { s.templates = await api('/api/templates'); } catch (e) { return toast(e.message, 'err'); } }
    const pop = popover(anchor, `<div class="menu" style="max-height:320px;overflow-y:auto;min-width:260px">
      ${s.templates.length ? s.templates.map((t, i) => `<button data-t="${i}"><span class="ms">text_snippet</span><span><b>${esc(t.name)}</b><div class="muted small">${esc(t.body.slice(0, 60))}</div></span></button>`).join('')
        : `<div class="empty small">אין תבניות עדיין.</div>`}
      <hr><a href="#/campaigns?tab=templates">${icon('settings')} ניהול תבניות</a></div>`);
    on(pop, 'click', '[data-t]', (e, b) => {
      const t = s.templates[Number(b.dataset.t)];
      const msg = $('#msg', threadEl);
      const name = s.thread && s.thread.contact && s.thread.contact.name ? s.thread.contact.name : '';
      msg.value = (msg.value ? msg.value + ' ' : '') + t.body.replace(/\{name\}/g, name).replace(/\{first\}/g, name.split(' ')[0] || '').replace(/\{phone\}/g, s.active);
      autosize(msg); updateCount(); msg.focus(); closePopover();
    });
  }

  // ---------- פאנל איש קשר ----------
  function renderInfo() {
    if (!s.info) { infoEl.classList.add('hidden'); root.classList.remove('with-info'); return; }
    infoEl.classList.remove('hidden'); root.classList.add('with-info');
    const t = s.thread;
    if (!t || t.phone !== s.active) { infoEl.innerHTML = `<div class="empty small">בחר שיחה כדי לראות פרטים.</div>`; return; }
    const c = t.contact || {};
    const ins = t.messages.filter((m) => !m.out).length;
    const outs = t.messages.length - ins;
    const first = t.messages[0];
    infoEl.innerHTML = `
      <div style="display:flex;justify-content:flex-end"><button class="icon-btn" data-act="info" aria-label="סגירה">${icon('close')}</button></div>
      <span class="avatar" style="display:grid">${esc(initials(c.name, t.phone))}</span>
      <h3>${esc(c.name || 'ללא שם')}</h3>
      <div class="phone ltr">${esc(t.phone)}</div>
      ${can('contacts') ? `
      <div class="info-actions">
        <button data-act="edit-contact">${icon(c.id ? 'edit' : 'person_add')}${c.id ? 'עריכה' : 'שמירה'}</button>
        <button data-act="fav" class="${c.is_favorite ? 'on' : ''}">${icon('star', c.is_favorite ? 'fill' : '')}מועדף</button>
        <button data-act="block" class="${c.is_blocked ? 'on-danger' : ''}">${icon('block')}${c.is_blocked ? 'חסום' : 'חסימה'}</button>
      </div>` : ''}
      <dl class="kv">
        <dt>נכנסות</dt><dd class="num">${fmt(ins)}</dd>
        <dt>יוצאות</dt><dd class="num">${fmt(outs)}</dd>
        ${first ? `<dt>הודעה ראשונה</dt><dd>${esc(listTime(first.time))}</dd>` : ''}
        ${c.email ? `<dt>אימייל</dt><dd class="ltr">${esc(c.email)}</dd>` : ''}
      </dl>
      ${can('contacts') ? `<div class="field" style="margin-top:18px"><label for="notes">הערות</label><textarea id="notes" rows="4" placeholder="הערה פנימית, רק אתה רואה אותה">${esc(c.notes || '')}</textarea></div>` : ''}
      ${can('messages.export') ? `<button class="btn btn-sm btn-block" id="export-conv">${icon('download')} ייצוא השיחה ל-CSV</button>` : ''}`;
    const ex = $('#export-conv', infoEl);
    if (ex) ex.addEventListener('click', () => exportFile({ kind: 'messages', system: sys.id, phone: t.phone }));
    const notes = $('#notes', infoEl);
    if (notes) notes.addEventListener('change', () => upsertContact({ notes: notes.value }));
  }

  async function upsertContact(patch) {
    try {
      const c = await api('/api/contacts/upsert', { method: 'POST', body: { phone: s.active, ...patch } });
      if (s.thread) s.thread.contact = c;
      const conv = s.convs.find((x) => x.phone === s.active);
      if (conv) { conv.name = c.name; conv.favorite = !!c.is_favorite; }
      if (c.is_blocked) {
        s.convs = s.convs.filter((x) => x.phone !== s.active);
        toast('המספר נחסם. הודעות ממנו יוסתרו ולא יועברו באוטומציות.');
      }
      renderList();
      if (s.thread) { threadEl.querySelector('.who b').textContent = c.name || s.active; }
      renderInfo();
      return c;
    } catch (e) { toast(e.message, 'err'); return null; }
  }

  function editContact() {
    const c = (s.thread && s.thread.contact) || {};
    modal({
      title: c.id ? 'עריכת איש קשר' : 'שמירת איש קשר',
      body: `<div class="field"><label>שם</label><input name="name" value="${esc(c.name || '')}" maxlength="80"></div>
             <div class="field"><label>טלפון</label><input value="${esc(s.active)}" class="ltr" disabled></div>`,
      actions: [{ label: 'ביטול' }, { label: 'שמירה', kind: 'primary', onClick: async (m) => { await upsertContact({ name: formValues(m.body).name }); } }],
    });
  }

  // ---------- אירועים ----------
  on(listEl, 'click', '.conv', (e, el) => open(el.dataset.phone));
  on(listEl, 'keydown', '.conv', (e, el) => { if (e.key === 'Enter') open(el.dataset.phone); });
  on($('#filters', view), 'click', '[data-f]', (e, b) => {
    s.filter = b.dataset.f;
    view.querySelectorAll('#filters .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  });
  $('#q', view).addEventListener('input', (e) => { s.q = e.target.value.trim(); renderList(); });

  const newBtn = $('#new-conv', view);
  if (newBtn) newBtn.addEventListener('click', () => {
    modal({
      title: 'שיחה חדשה',
      body: `<div class="field"><label for="np">מספר טלפון</label><input id="np" name="phone" class="ltr" inputmode="tel" placeholder="05X-XXXXXXX" list="np-list"></div>
             <datalist id="np-list">${s.convs.filter((c) => c.name).map((c) => `<option value="${esc(c.phone)}">${esc(c.name)}</option>`).join('')}</datalist>`,
      actions: [{ label: 'ביטול' }, {
        label: 'פתיחת שיחה', kind: 'primary', onClick: (m) => {
          const p = normPhone(formValues(m.body).phone);
          if (!/^\d{9,15}$/.test(p)) { toast('מספר הטלפון לא תקין', 'err'); return false; }
          if (!s.convs.find((c) => c.phone === p)) s.convs.unshift({ phone: p, name: null, last: { text: '', time: '', out: true }, count: 0, unread: 0, pinned: false, archived: false, favorite: false });
          open(p);
          setTimeout(() => { const m2 = $('#msg', threadEl); if (m2) m2.focus(); }, 300);
          return true;
        },
      }],
    });
  });

  $('#more', view).addEventListener('click', (e) => {
    const pop = popover(e.currentTarget, `<div class="menu">
      <button data-m="refresh">${icon('refresh')} רענון מימות המשיח</button>
      <button data-m="readall">${icon('done_all')} סימון הכל כנקרא</button>
      ${can('messages.export') ? `<button data-m="export">${icon('download')} ייצוא כל ההודעות (CSV)</button>` : ''}
    </div>`);
    on(pop, 'click', '[data-m]', async (ev, b) => {
      closePopover();
      if (b.dataset.m === 'export') exportFile({ kind: 'messages', system: sys.id });
      if (b.dataset.m === 'refresh') { await loadConvs(true); toast('עודכן'); }
      if (b.dataset.m === 'readall') { try { await api('/api/messages/read-all', { method: 'POST', body: { system: sys.id } }); s.convs.forEach((c) => { c.unread = 0; }); renderList(); toast('כל השיחות סומנו כנקראו'); } catch (err) { toast(err.message, 'err'); } }
    });
  });

  on(threadEl, 'click', '[data-act]', async (e, b) => {
    const act = b.dataset.act;
    if (act === 'back') { root.classList.remove('show-thread'); s.active = null; history.replaceState(null, '', '#/inbox'); renderList(); return; }
    if (act === 'info') { s.info = !s.info; localStorage.setItem('smt2.info', s.info ? '1' : '0'); renderInfo(); return; }
    if (act === 'templates') return showTemplates(b);
    if (act === 'pin' || act === 'archive') {
      const t = s.thread;
      const patch = act === 'pin' ? { pinned: !t.pinned } : { archived: !t.archived };
      try {
        await api('/api/messages/meta', { method: 'POST', body: { system: sys.id, phone: s.active, ...patch } });
        Object.assign(t, patch);
        const c = s.convs.find((x) => x.phone === s.active);
        if (c) Object.assign(c, patch);
        s.convs.sort((a, z) => (z.pinned - a.pinned) || (a.last.time < z.last.time ? 1 : -1));
        s.lastSig = '';
        renderList();
        threadEl.querySelector('.thread-head').outerHTML = threadHtml(t).split('<div class="thread-body"')[0];
        toast(act === 'pin' ? (patch.pinned ? 'השיחה הוצמדה' : 'ההצמדה בוטלה') : (patch.archived ? 'הועבר לארכיון' : 'הוצא מהארכיון'));
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  on(threadEl, 'click', '#send', () => send());
  on(threadEl, 'input', '#msg', (e, t) => { autosize(t); updateCount(); });
  on(threadEl, 'keydown', '#msg', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  on(infoEl, 'click', '[data-act]', async (e, b) => {
    const c = (s.thread && s.thread.contact) || {};
    if (b.dataset.act === 'info') { s.info = false; localStorage.setItem('smt2.info', '0'); renderInfo(); }
    if (b.dataset.act === 'edit-contact') editContact();
    if (b.dataset.act === 'fav') upsertContact({ is_favorite: !c.is_favorite });
    if (b.dataset.act === 'block') {
      if (!c.is_blocked && !(await confirmDialog('לחסום את המספר? הודעות ממנו יוסתרו מהתיבה, לא יועברו באוטומציות ולא ניתן יהיה לשלוח אליו.', { confirm: 'חסימה', danger: true }))) return;
      upsertContact({ is_blocked: !c.is_blocked });
    }
  });

  // ---------- התחלה ופולינג ----------
  loadConvs().then(() => { if (s.active) open(s.active); else loadThread(); });
  s.timer = setInterval(() => { if (!document.hidden) loadConvs(); }, POLL_MS);
  const onVis = () => { if (!document.hidden) loadConvs(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { clearInterval(s.timer); document.removeEventListener('visibilitychange', onVis); };
}


// חיבור וניהול מערכות ימות המשיח
import { api, route, state, $, esc, icon, can, toast, modal, confirmDialog, on, formValues, emptyState, ago, fmt, popover, closePopover } from '../core.js';

const COLORS = ['#0B6E66', '#2F6FB5', '#8A4FB8', '#C2412D', '#B7791F', '#2F8F4E', '#475569'];
const STATUS = {
  ok: '<span class="badge badge-ok">מחובר</span>',
  mfa: '<span class="badge badge-warn">ממתין לאימות דו-שלבי</span>',
  error: '<span class="badge badge-danger">שגיאת חיבור</span>',
};

const refresh = () => window.dispatchEvent(new Event('systems-changed'));

function colorPicker(current) {
  return `<div class="row" style="gap:6px">${COLORS.map((c) => `<label style="cursor:pointer"><input type="radio" name="color" value="${c}" ${c === current ? 'checked' : ''} class="sr-only"><span class="sys-dot" style="--c:${c};width:26px;height:26px;outline-offset:2px" data-sw></span></label>`).join('')}</div>`;
}
function bindSwatches(root) {
  const paint = () => root.querySelectorAll('[data-sw]').forEach((sw) => { sw.style.outline = sw.previousElementSibling.checked ? '2px solid var(--ink)' : 'none'; });
  root.addEventListener('change', paint);
  paint();
}

export function mfaFlow(systemId, url, onDone) {
  let timer = null;
  const m = modal({
    title: 'השלמת אימות דו-שלבי',
    body: `<p>ימות המשיח דורשת אימות נוסף לחיבור הזה. לחץ על הכפתור, אשר באתר של ימות המשיח, וחזור לכאן — החיבור יתעדכן אוטומטית.</p>
      <a class="btn btn-primary btn-block" href="${esc(url)}" target="_blank" rel="noopener">${icon('open_in_new')} מעבר לאימות</a>
      <p class="hint" style="margin-top:12px;text-align:center" id="mfa-st">ממתין לאישור…</p>`,
    actions: [{ label: 'סגירה' }],
  });
  const poll = async () => {
    if (!document.body.contains(m.el)) return clearInterval(timer);
    try {
      const r = await api(`/api/systems/${systemId}/mfa`);
      if (r.passed) { clearInterval(timer); m.close(); toast('האימות הושלם, המערכת מחוברת'); onDone && onDone(); }
    } catch { /* ממשיכים לנסות */ }
  };
  timer = setInterval(poll, 2500);
}

function addModal(onDone) {
  const m = modal({
    title: 'חיבור מערכת', wide: false,
    body: `
      <div class="seg" style="margin-bottom:16px" id="mode"><button type="button" class="on" data-m="password">מספר מערכת וסיסמה</button><button type="button" data-m="token">טוקן קבוע</button></div>
      <input type="hidden" name="auth_type" value="password">
      <div id="m-password" class="grid-2">
        <div class="field"><label>מספר מערכת</label><input name="number" class="ltr" inputmode="numeric" autocomplete="off" placeholder="077…"></div>
        <div class="field"><label>סיסמה</label><input name="password" type="password" autocomplete="new-password"></div>
      </div>
      <div id="m-token" class="hidden"><div class="field"><label>טוקן API</label><input name="token" class="ltr" autocomplete="off" placeholder="מספר:סיסמה או טוקן קבוע"><div class="hint">טוקן קבוע (מפתח גישה) לא דורש אימות דו-שלבי ולא פג.</div></div></div>
      <div class="field"><label>שם לתצוגה</label><input name="name" maxlength="60" placeholder="למשל: קו שירות לקוחות"></div>
      <div class="grid-2">
        <div class="field"><label>שם שולח ברירת מחדל <span class="muted">(לא חובה)</span></label><input name="sender" class="ltr" maxlength="20" placeholder="מספר או שם באנגלית"></div>
        <div class="field"><span class="label">צבע</span>${colorPicker(COLORS[state.systems.length % COLORS.length])}</div>
      </div>
      <div class="banner banner-info" style="margin:4px 0 0">${icon('lock')}<div>הסיסמה והטוקן נשמרים מוצפנים בשרת (AES-256) ולא נשלחים לדפדפן — גם לא אליך.</div></div>`,
    actions: [{ label: 'ביטול' }, {
      label: 'חיבור ובדיקה', kind: 'primary', onClick: async (mm) => {
        const v = formValues(mm.body);
        const r = await api('/api/systems', { method: 'POST', body: v });
        refresh();
        if (r.status === 'mfa' && r.mfa_url) mfaFlow(r.id, r.mfa_url, () => { refresh(); onDone(); });
        else toast(`המערכת חוברה${r.units != null ? ` · יתרת יחידות: ${fmt(r.units)}` : ''}`);
        onDone();
      },
    }],
  });
  bindSwatches(m.el);
  on(m.el, 'click', '#mode [data-m]', (e, b) => {
    m.el.querySelectorAll('#mode button').forEach((x) => x.classList.toggle('on', x === b));
    m.el.querySelector('[name=auth_type]').value = b.dataset.m;
    $('#m-password', m.el).classList.toggle('hidden', b.dataset.m !== 'password');
    $('#m-token', m.el).classList.toggle('hidden', b.dataset.m !== 'token');
  });
}

function editModal(sys, onDone) {
  const m = modal({
    title: `עריכה: ${sys.name}`,
    body: `
      <div class="field"><label>שם לתצוגה</label><input name="name" value="${esc(sys.name)}" maxlength="60"></div>
      <div class="field"><label>שם שולח ברירת מחדל</label><input name="sender" class="ltr" value="${esc(sys.sender || '')}" maxlength="20"></div>
      <div class="field"><span class="label">צבע</span>${colorPicker(sys.color)}</div>
      <details><summary class="label" style="cursor:pointer">החלפת פרטי התחברות</summary>
        <div style="margin-top:10px">
          <input type="hidden" name="auth_type" value="${esc(sys.auth_type)}">
          ${sys.auth_type === 'password' ? `<div class="field"><label>סיסמה חדשה למערכת ${esc(sys.number || '')}</label><input name="password" type="password" autocomplete="new-password"></div>`
            : `<div class="field"><label>טוקן חדש</label><input name="token" class="ltr" autocomplete="off"></div>`}
        </div></details>`,
    actions: [{ label: 'ביטול' }, {
      label: 'שמירה', kind: 'primary', onClick: async (mm) => {
        const v = formValues(mm.body);
        const r = await api(`/api/systems/${sys.id}`, { method: 'PUT', body: v });
        refresh();
        if (r.mfa_url) mfaFlow(sys.id, r.mfa_url, () => { refresh(); onDone(); });
        else toast('נשמר');
        onDone();
      },
    }],
  });
  bindSwatches(m.el);
}

function legacyModal(onDone) {
  modal({
    title: 'ייבוא מהגרסה הישנה',
    body: `<p>הזן את הקוד האישי שבו השתמשת בגרסה הקודמת. כל המערכות שהיו מקושרות אליו יועתקו לחשבון הזה (הגרסה הישנה ממשיכה לעבוד כרגיל).</p>
      <div class="field"><label>קוד אישי ישן</label><input name="code" type="password" autocomplete="off" inputmode="numeric"></div>`,
    actions: [{ label: 'ביטול' }, {
      label: 'ייבוא', kind: 'primary', onClick: async (mm) => {
        const r = await api('/api/systems/legacy-import', { method: 'POST', body: formValues(mm.body) });
        refresh();
        modal({
          title: `יובאו ${r.imported.length} מערכות`,
          body: `${r.imported.map((i) => `<div class="list-row">${icon(i.status === 'ok' ? 'check_circle' : 'warning')}<span class="grow">${esc(i.name)}</span>${STATUS[i.status] || ''}</div>`).join('')}
            ${r.skipped.map((i) => `<div class="list-row">${icon('block')}<span class="grow">${esc(i.name)}</span><span class="muted small">${esc(i.reason)}</span></div>`).join('')}
            ${!r.imported.length && !r.skipped.length ? '<p>לא נמצאו מערכות תחת הקוד הזה.</p>' : ''}`,
          actions: [{ label: 'סגירה' }],
        });
        onDone();
      },
    }],
  });
}

export function register() {
  route('/systems', async (view, _p, query) => {
    const draw = async () => {
      const list = await api('/api/systems');
      state.systems = list;
      const me = state.me;
      const full = list.length >= me.limits.max_systems;
      view.innerHTML = `
        <div class="page page-narrow">
          <div class="page-head"><div class="lead"><h1>מערכות</h1><p>המערכות של ימות המשיח שמחוברות לחשבון. בשימוש: ${list.length} מתוך ${fmt(me.limits.max_systems)}.</p></div>
            <div class="row">
              ${can('legacy.import') ? `<button class="btn" id="legacy">${icon('history')} ייבוא מהגרסה הישנה</button>` : ''}
              ${can('systems.add') ? `<button class="btn btn-primary" id="add" ${full ? 'disabled title="הגעת למכסת המערכות"' : ''}>${icon('add_link')} חיבור מערכת</button>` : ''}
            </div></div>
          ${list.length ? `<div class="panel panel-flush"><div class="panel-body">${list.map((s) => `
            <div class="list-row">
              <span class="sys-dot" style="--c:${esc(s.color || '')};width:14px;height:14px"></span>
              <div class="grow"><b>${esc(s.name)}</b> ${STATUS[s.status] || ''}
                <div class="muted small"><span class="ltr">${esc(s.number || '—')}</span> · ${s.auth_type === 'token' ? 'טוקן קבוע' : 'סיסמה (התחברות מחדש אוטומטית)'}${s.sender ? ` · שולח: <span class="ltr">${esc(s.sender)}</span>` : ''}${s.legacy_id ? ' · יובא מהגרסה הישנה' : ''}</div>
                ${s.status !== 'ok' && s.status_msg ? `<div class="small" style="color:var(--danger)">${esc(s.status_msg)}</div>` : ''}
                <div class="muted small">נבדק ${ago(s.last_check_at)}</div></div>
              ${s.status === 'mfa' ? `<button class="btn btn-sm btn-primary" data-a="test" data-id="${s.id}">${icon('verified_user')} השלמת אימות</button>` : `<button class="btn btn-sm" data-a="test" data-id="${s.id}">${icon('network_check')} בדיקה</button>`}
              <button class="icon-btn" data-a="menu" data-id="${s.id}" aria-label="פעולות">${icon('more_vert')}</button>
            </div>`).join('')}</div></div>`
            : emptyState({ ic: 'dns', title: 'עוד לא חיברת מערכת', text: 'חבר מערכת של ימות המשיח כדי לקבל ולשלוח הודעות. אפשר עם מספר וסיסמה או עם טוקן קבוע.' })}
          <div class="banner banner-info">${icon('shield_lock')}<div><b>איך שומרים על הטוקן שלך</b>כל הפניות לימות המשיח יוצאות מהשרת. הטוקן והסיסמה מוצפנים במסד, לא מוחזרים לדפדפן, ולא נחשפים לאורחים שקיבלו קוד גישה.</div></div>
        </div>`;
      const add = $('#add', view);
      if (add) add.addEventListener('click', () => addModal(draw));
      const leg = $('#legacy', view);
      if (leg) leg.addEventListener('click', () => legacyModal(draw));
      if (query.get('import') === '1' && leg) { history.replaceState(null, '', '#/systems'); legacyModal(draw); }
      if (!list.length && add && !query.get('import')) setTimeout(() => add.focus(), 50);
    };

    on(view, 'click', '[data-a]', async (e, b) => {
      const sys = state.systems.find((x) => x.id === Number(b.dataset.id));
      if (!sys) return;
      if (b.dataset.a === 'test') {
        b.classList.add('busy'); b.disabled = true;
        try {
          const r = await api(`/api/systems/${sys.id}/test`, { method: 'POST' });
          if (r.status === 'ok') toast(`החיבור תקין${r.info && r.info.units != null ? ` · יתרת יחידות: ${fmt(r.info.units)}` : ''}`);
          else if (r.status === 'mfa' && r.mfa_url) mfaFlow(sys.id, r.mfa_url, () => { refresh(); draw(); });
          else toast(r.message || 'החיבור נכשל', 'err');
          refresh(); await draw();
        } catch (err) { toast(err.message, 'err'); } finally { b.classList.remove('busy'); b.disabled = false; }
      }
      if (b.dataset.a === 'menu') {
        const pop = popover(b, `<div class="menu"><button data-x="edit">${icon('edit')} עריכה</button><hr><button data-x="delete">${icon('link_off')} ניתוק והסרה</button></div>`);
        on(pop, 'click', '[data-x]', async (ev, x) => {
          closePopover();
          if (x.dataset.x === 'edit') editModal(sys, draw);
          if (x.dataset.x === 'delete' && await confirmDialog(`לנתק את "${sys.name}"? יימחקו גם האוטומציות וקודי הגישה של המערכת הזו, ושליחות מתוזמנות יבוטלו.`, { danger: true, confirm: 'ניתוק' })) {
            try { await api(`/api/systems/${sys.id}`, { method: 'DELETE' }); toast('המערכת נותקה'); refresh(); draw(); } catch (err) { toast(err.message, 'err'); }
          }
        });
      }
    });
    await draw();
  }, { title: 'מערכות', nav: 'systems' });
}

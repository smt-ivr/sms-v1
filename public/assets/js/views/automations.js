// אוטומציות: SMS למייל לפי שעות, מענה אוטומטי, Webhook
import { api, route, state, $, esc, icon, can, toast, modal, confirmDialog, on, formValues, emptyState, loadingState, ago, fmt, minToHm, hmToMin, DAY_LETTERS, popover, closePopover, copy, currentSystem } from '../core.js';

const TYPES = {
  email: { ic: 'forward_to_inbox', label: 'SMS למייל', feature: 'rules.email', desc: 'העברת הודעות נכנסות לתיבת המייל — מיידית או כסיכום, רק בימים ובשעות שתבחר.' },
  autoreply: { ic: 'quickreply', label: 'מענה אוטומטי', feature: 'rules.autoreply', desc: 'תשובה אוטומטית לשולח — למשל מחוץ לשעות הפעילות.' },
  webhook: { ic: 'webhook', label: 'Webhook', feature: 'rules.webhook', desc: 'שליחת כל הודעה נכנסת כ-JSON לכתובת שלך, עם חתימת HMAC.' },
};

function daysText(days) {
  if (days === '0123456') return 'כל השבוע';
  if (days === '01234') return 'א׳–ה׳';
  if (days === '012345') return 'א׳–ו׳';
  return days.split('').map((d) => DAY_LETTERS[d] + '׳').join(' ');
}
function windowText(r) {
  if (r.start_min === r.end_min || (r.start_min === 0 && r.end_min === 1440)) return 'כל היום';
  return `\u2066${minToHm(r.start_min)}–${minToHm(r.end_min)}\u2069`;
}
function describe(r) {
  const when = `${daysText(r.days)} · ${windowText(r)}`;
  if (r.type === 'email') return `הודעות נכנסות ל"${r.system_name}" יישלחו אל ${r.target.replace(/,/g, ', ')} · ${when} · ${r.mode === 'digest' ? `סיכום כל ${r.digest_minutes} דק׳` : 'מיידי'}`;
  if (r.type === 'autoreply') return `מענה אוטומטי ב"${r.system_name}" · ${when} · פעם ב-${r.cooldown_hours} שעות לכל שולח`;
  return `POST אל ${r.target} · ${when}`;
}

export function register() {
  route('/automations', async (view) => {
    view.innerHTML = loadingState();
    const draw = async () => {
      const rules = await api('/api/rules');
      const available = Object.entries(TYPES).filter(([, t]) => can(t.feature));
      view.innerHTML = `
        <div class="page">
          <div class="page-head"><div class="lead"><h1>אוטומציות</h1><p>כללים שרצים ברקע בשרת, גם כשהדפדפן סגור. נבדקות הודעות חדשות כל כמה דקות.</p></div>
            ${state.systems.length && available.length ? `<button class="btn btn-primary" id="new">${icon('add')} אוטומציה חדשה</button>` : ''}</div>
          ${!state.systems.length ? emptyState({ ic: 'dns', title: 'אין מערכת מחוברת', action: '<a class="btn btn-primary" href="#/systems">חיבור מערכת</a>' }) : ''}
          ${state.systems.length && !rules.length ? `<div class="panel"><div class="panel-body">${available.map(([k, t]) => `
            <div class="list-row"><span class="rule-icon ${k}">${icon(t.ic)}</span><div class="grow"><b>${t.label}</b><div class="muted small">${t.desc}</div></div><button class="btn" data-create="${k}">יצירה</button></div>`).join('')}</div></div>` : ''}
          ${rules.length ? `<div class="panel panel-flush"><div class="panel-body">${rules.map((r) => `
            <div class="rule-card">
              <span class="rule-icon ${r.type}">${icon(TYPES[r.type].ic)}</span>
              <div style="min-width:0"><b>${esc(r.name)}</b>
                <div class="desc">${esc(describe(r))}</div>
                <div class="facts">
                  ${r.enabled ? '<span class="badge badge-ok">פעיל</span>' : '<span class="badge">כבוי</span>'}
                  ${r.filter_keyword ? `<span class="badge">${icon('filter_alt')} ${esc(r.filter_keyword)}</span>` : ''}
                  ${r.filter_sender ? `<span class="badge ltr">${icon('person_search')} ${esc(r.filter_sender)}</span>` : ''}
                  <span class="badge">${fmt(r.fire_count)} הפעלות</span>
                  ${r.last_fire_at ? `<span class="badge">אחרון: ${ago(r.last_fire_at)}</span>` : ''}
                  ${r.last_error ? `<span class="badge badge-danger" title="${esc(r.last_error)}">${icon('error')} ${esc(r.last_error.slice(0, 60))}</span>` : ''}
                </div></div>
              <div class="row" style="gap:4px">
                <label class="switch" title="הפעלה/כיבוי"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''}><span></span></label>
                <button class="icon-btn" data-menu="${r.id}" aria-label="פעולות">${icon('more_vert')}</button>
              </div>
            </div>`).join('')}</div></div>` : ''}
        </div>`;

      const newBtn = $('#new', view);
      if (newBtn) newBtn.addEventListener('click', (e) => {
        const pop = popover(e.currentTarget, `<div class="menu">${available.map(([k, t]) => `<button data-create="${k}">${icon(t.ic)} ${t.label}</button>`).join('')}</div>`);
        on(pop, 'click', '[data-create]', (ev, b) => { closePopover(); editor({ type: b.dataset.create }, draw); });
      });
      on(view, 'click', '.panel [data-create]', (e, b) => editor({ type: b.dataset.create }, draw));
      on(view, 'change', '[data-toggle]', async (e, cb) => {
        try { await api(`/api/rules/${cb.dataset.toggle}/toggle`, { method: 'POST' }); toast(cb.checked ? 'האוטומציה הופעלה' : 'האוטומציה כובתה'); draw(); } catch (err) { cb.checked = !cb.checked; toast(err.message, 'err'); }
      });
      on(view, 'click', '[data-menu]', (e, b) => {
        const r = rules.find((x) => x.id === Number(b.dataset.menu));
        const pop = popover(b, `<div class="menu">
          <button data-a="edit">${icon('edit')} עריכה</button>
          <button data-a="test">${icon('science')} שליחת בדיקה</button>
          ${r.enabled ? `<button data-a="run">${icon('play_arrow')} הרצה עכשיו</button>` : ''}
          <hr><button data-a="delete">${icon('delete')} מחיקה</button></div>`);
        on(pop, 'click', '[data-a]', async (ev, x) => {
          closePopover();
          try {
            if (x.dataset.a === 'edit') editor(r, draw);
            if (x.dataset.a === 'test') {
              const res = await api(`/api/rules/${r.id}/test`, { method: 'POST' });
              toast(r.type === 'autoreply' ? `נוסח המענה: ${res.preview}` : r.type === 'email' ? 'מייל בדיקה נשלח' : 'הבקשה נשלחה לכתובת ה-Webhook');
            }
            if (x.dataset.a === 'run') {
              const res = await api(`/api/rules/${r.id}/run`, { method: 'POST' });
              toast(res.last_error ? res.last_error : res.fired ? 'נמצאו הודעות חדשות והכלל הופעל' : 'אין הודעות חדשות שמתאימות לכלל', res.last_error ? 'err' : 'ok');
              draw();
            }
            if (x.dataset.a === 'delete' && await confirmDialog(`למחוק את "${r.name}"?`, { danger: true, confirm: 'מחיקה' })) {
              await api(`/api/rules/${r.id}`, { method: 'DELETE' }); draw();
            }
          } catch (err) { toast(err.message, 'err'); }
        });
      });
    };
    await draw();
  }, { title: 'אוטומציות', nav: 'automations' });
}

function editor(rule, onSaved) {
  const type = rule.type;
  const t = TYPES[type];
  const r = {
    name: '', system_id: (currentSystem() || state.systems[0] || {}).id, days: '0123456', start_min: 0, end_min: 1440,
    outside_mode: type === 'autoreply' ? 'skip' : 'hold', mode: 'instant', digest_minutes: 60, filter_keyword: '', filter_sender: '',
    target: type === 'email' ? state.me.user.email : '', cooldown_hours: 12, enabled: 1, ...rule,
  };
  if (type === 'autoreply' && !rule.id) { r.days = '0123456'; r.start_min = 18 * 60; r.end_min = 9 * 60; r.target = 'תודה על פנייתך! קיבלנו את ההודעה ונחזור אליך בשעות הפעילות.'; }
  const allDay = r.start_min === r.end_min || (r.start_min === 0 && r.end_min === 1440);

  const m = modal({
    title: rule.id ? `עריכה: ${r.name}` : t.label, wide: true,
    body: `
      <p class="muted">${t.desc}</p>
      <div class="grid-2">
        <div class="field"><label>שם</label><input name="name" value="${esc(r.name)}" maxlength="60" placeholder="${t.label}"></div>
        <div class="field"><label>מערכת</label><select name="system_id">${state.systems.map((s) => `<option value="${s.id}" ${s.id === r.system_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      </div>
      ${type === 'email' ? `<div class="field"><label>לשלוח אל</label><input name="target" class="ltr" value="${esc(r.target)}" placeholder="me@example.com"><div class="hint">עד 5 כתובות, מופרדות בפסיק.</div></div>` : ''}
      ${type === 'webhook' ? `<div class="field"><label>כתובת Webhook</label><input name="target" class="ltr" value="${esc(r.target)}" placeholder="https://example.com/hooks/sms"></div>
        ${r.secret ? `<div class="field"><label>סוד לחתימה</label><div class="row"><code class="code-box grow">${esc(r.secret)}</code><button type="button" class="btn btn-sm" data-copy="${esc(r.secret)}">${icon('content_copy')}</button></div>
        <div class="hint">הכותרת X-SMT-Signature מכילה sha256=HMAC של גוף הבקשה עם הסוד הזה.</div></div>` : ''}` : ''}
      ${type === 'autoreply' ? `<div class="field"><label>נוסח המענה</label><textarea name="target" rows="3" maxlength="500">${esc(r.target)}</textarea></div>` : ''}

      <div class="field"><span class="label">ימים</span><div class="daypick" id="days">${DAY_LETTERS.map((d, i) => `<button type="button" data-d="${i}" class="${r.days.includes(String(i)) ? 'on' : ''}">${d}</button>`).join('')}</div></div>
      <div class="field"><span class="label">שעות (שעון ישראל)</span>
        <div class="row">
          <label class="check" style="padding:0"><input type="checkbox" id="allday" ${allDay ? 'checked' : ''}><span>כל היממה</span></label>
          <span id="hours" class="row ${allDay ? 'hidden' : ''}">מ-<input type="time" class="input" id="start" value="${minToHm(r.start_min)}" style="width:auto"> עד <input type="time" class="input" id="end" value="${minToHm(r.end_min === 1440 ? 0 : r.end_min)}" style="width:auto"></span>
        </div>
        <div class="window-strip" id="strip"></div><div class="window-strip-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        <div class="hint">אפשר לבחור חלון שחוצה חצות, למשל 18:00 עד 09:00.</div></div>

      ${type !== 'autoreply' ? `
      <div class="grid-2">
        <div class="field"><span class="label">הודעות שמגיעות מחוץ לשעות</span>
          <label class="check"><input type="radio" name="outside_mode" value="hold" ${r.outside_mode === 'hold' ? 'checked' : ''}><span><b>לשמור</b><span class="hint">יישלחו יחד כשהחלון ייפתח</span></span></label>
          <label class="check"><input type="radio" name="outside_mode" value="skip" ${r.outside_mode === 'skip' ? 'checked' : ''}><span><b>לדלג</b><span class="hint">לא יישלחו בכלל</span></span></label></div>
        <div class="field"><span class="label">אופן שליחה</span>
          <label class="check"><input type="radio" name="mode" value="instant" ${r.mode === 'instant' ? 'checked' : ''}><span><b>מיידי</b><span class="hint">כל כמה דקות, ברגע שיש הודעה חדשה</span></span></label>
          <label class="check"><input type="radio" name="mode" value="digest" ${r.mode === 'digest' ? 'checked' : ''}><span><b>סיכום מרוכז</b><span class="hint">כל <input type="number" name="digest_minutes" min="15" max="1440" value="${r.digest_minutes}" class="input" style="width:80px;min-height:30px;display:inline-block;padding:2px 6px"> דקות</span></span></label></div>
      </div>` : `
      <div class="field"><label>לא לענות שוב לאותו מספר במשך</label><div class="row"><input type="number" name="cooldown_hours" min="1" max="720" value="${r.cooldown_hours}" class="input" style="width:100px"> שעות</div></div>`}

      <details ${r.filter_keyword || r.filter_sender ? 'open' : ''}><summary class="label" style="cursor:pointer;margin-bottom:10px">סינון (לא חובה)</summary>
        <div class="grid-2">
          <div class="field"><label>רק הודעות שמכילות</label><input name="filter_keyword" value="${esc(r.filter_keyword || '')}" placeholder="מילה, או כמה מופרדות בפסיק"></div>
          <div class="field"><label>רק משולחים</label><input name="filter_sender" class="ltr" value="${esc(r.filter_sender || '')}" placeholder="050, 0521234567"><div class="hint">מספרים או קידומות</div></div>
        </div>
      </details>`,
    actions: [{ label: 'ביטול' }, {
      label: rule.id ? 'שמירה' : 'יצירה', kind: 'primary', onClick: async (mm) => {
        const v = formValues(mm.body);
        const days = [...mm.body.querySelectorAll('#days .on')].map((b) => b.dataset.d).join('');
        const all = mm.body.querySelector('#allday').checked;
        const body = {
          ...v, type, days,
          start_min: all ? 0 : hmToMin(mm.body.querySelector('#start').value),
          end_min: all ? 1440 : (hmToMin(mm.body.querySelector('#end').value) || 1440),
          outside_mode: type === 'autoreply' ? 'skip' : v.outside_mode,
        };
        if (!days) { toast('בחר לפחות יום אחד', 'err'); return false; }
        await api(rule.id ? `/api/rules/${rule.id}` : '/api/rules', { method: rule.id ? 'PUT' : 'POST', body });
        toast(rule.id ? 'נשמר' : 'האוטומציה נוצרה ופעילה');
        onSaved();
      },
    }],
  });

  const strip = $('#strip', m.el);
  const drawStrip = () => {
    const all = $('#allday', m.el).checked;
    const s = all ? 0 : hmToMin($('#start', m.el).value);
    let e = all ? 1440 : hmToMin($('#end', m.el).value);
    if (!all && e === 0) e = 1440;
    const pct = (x) => (x / 1440) * 100;
    const seg = (a, b) => `<i style="left:${pct(a)}%;width:${pct(b - a)}%"></i>`;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const nowMin = now.getHours() * 60 + now.getMinutes();
    strip.innerHTML = (all || s === e ? seg(0, 1440) : s < e ? seg(s, e) : seg(s, 1440) + seg(0, e)) + `<span class="now" style="left:${pct(nowMin)}%" title="עכשיו"></span>`;
    strip.style.direction = 'ltr';
  };
  drawStrip();
  m.el.addEventListener('input', drawStrip);
  $('#allday', m.el).addEventListener('change', (e) => { $('#hours', m.el).classList.toggle('hidden', e.target.checked); drawStrip(); });
  on(m.el, 'click', '#days [data-d]', (e, b) => b.classList.toggle('on'));
  on(m.el, 'click', '[data-copy]', (e, b) => copy(b.dataset.copy));
}

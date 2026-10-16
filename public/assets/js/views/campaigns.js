// שליחה קבוצתית, תזמון, קמפיינים, תבניות והיסטוריה
import { api, route, state, $, esc, icon, can, toast, modal, confirmDialog, on, formValues, emptyState, loadingState, smsInfo, fullTime, ago, fmt, normPhone, currentSystem, go } from '../core.js';

const TABS = [
  { key: 'compose', label: 'שליחה חדשה' },
  { key: 'list', label: 'קמפיינים ותזמונים' },
  { key: 'templates', label: 'תבניות', feature: 'templates' },
  { key: 'history', label: 'היסטוריה' },
];

export function register() {
  route('/campaigns', async (view, _p, query) => {
    const tab = query.get('tab') || 'compose';
    const tabs = TABS.filter((t) => !t.feature || can(t.feature));
    view.innerHTML = `<div class="page"><div class="page-head"><div class="lead"><h1>שליחה וקמפיינים</h1>
      <p>שליחה לקבוצות ולרשימות, עם התאמה אישית לכל נמען ותזמון מראש. שליחות גדולות נשלחות ברקע במנות.</p></div></div>
      <nav class="tabs">${tabs.map((t) => `<a href="#/campaigns?tab=${t.key}" class="${t.key === tab ? 'on' : ''}">${t.label}</a>`).join('')}</nav>
      <div id="tab"></div></div>`;
    const host = $('#tab', view);
    if (tab === 'compose') return compose(host);
    if (tab === 'list') return campaignsList(host);
    if (tab === 'templates') return templates(host);
    if (tab === 'history') return history(host);
    return null;
  }, { title: 'שליחה וקמפיינים', nav: 'campaigns' });
}

async function compose(host) {
  if (!state.systems.length) { host.innerHTML = emptyState({ ic: 'dns', title: 'אין מערכת מחוברת', action: '<a class="btn btn-primary" href="#/systems">חיבור מערכת</a>' }); return; }
  host.innerHTML = loadingState();
  const [groups, tpls, contacts] = await Promise.all([
    can('contacts') ? api('/api/groups') : [],
    can('templates') ? api('/api/templates') : [],
    can('contacts') ? api('/api/contacts') : [],
  ]);
  const byPhone = new Map(contacts.map((c) => [c.phone, c]));
  const prefill = JSON.parse(sessionStorage.getItem('smt2.prefill') || '[]');
  sessionStorage.removeItem('smt2.prefill');
  const cur = currentSystem();
  const canBulk = can('messages.bulk');
  const canSchedule = can('messages.schedule');

  host.innerHTML = `
    <div class="split">
      <form id="f" class="panel"><div class="panel-body">
        <div class="grid-2">
          <div class="field"><label>שליחה דרך</label><select name="system">${state.systems.map((s) => `<option value="${s.id}" ${cur && cur.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label>שם לקמפיין <span class="muted">(לא חובה)</span></label><input name="label" maxlength="80" placeholder="למשל: תזכורת לפגישות"></div>
        </div>
        ${groups.length ? `<div class="field"><span class="label">קבוצות</span><div class="row">${groups.map((g) => `
          <label class="chip" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-g="${g.id}" data-n="${g.members}" style="accent-color:var(--accent)">${esc(g.name)} <span class="muted">${g.members}</span></label>`).join('')}</div></div>` : ''}
        <div class="field"><label for="phones">מספרים נוספים</label>
          <textarea id="phones" name="phones" class="ltr" rows="3" placeholder="0501234567, 0527654321 …">${esc(prefill.join(', '))}</textarea>
          <div class="hint">אפשר להדביק עמודה מאקסל. מספרים כפולים וחסומים יסוננו אוטומטית.</div></div>
        <div class="field"><label for="msg">ההודעה</label>
          <textarea id="msg" name="message" rows="5"></textarea>
          <div class="row small" style="justify-content:space-between">
            <span class="row" style="gap:6px">התאמה אישית:
              <button type="button" class="chip" data-ins="{name}">{name} שם מלא</button>
              <button type="button" class="chip" data-ins="{first}">{first} שם פרטי</button>
              ${tpls.length ? `<select class="input" id="tpl" style="width:auto;min-height:30px;padding:2px 8px"><option value="">הוספת תבנית…</option>${tpls.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select>` : ''}
            </span><span class="muted" id="count"></span></div></div>
        <div class="field"><span class="label">מתי לשלוח</span>
          <div class="row">
            <label class="check"><input type="radio" name="when" value="now" checked><span>עכשיו</span></label>
            <label class="check" ${canSchedule ? '' : 'title="לא זמין בחבילה שלך"'}><input type="radio" name="when" value="later" ${canSchedule ? '' : 'disabled'}><span>בזמן מתוזמן</span></label>
            <input type="datetime-local" name="at" class="input hidden" style="width:auto">
          </div></div>
        <button class="btn btn-primary" type="submit">${icon('send')} <span id="send-label">שליחה</span></button>
      </div></form>
      <aside>
        <div class="panel"><div class="panel-head"><h3>סיכום</h3></div><div class="panel-body">
          <dl class="kv">
            <dt>נמענים</dt><dd class="num" id="sum-r">0</dd>
            <dt>אורך</dt><dd id="sum-l">—</dd>
            <dt>סה״כ SMS</dt><dd class="num" id="sum-t">0</dd>
            <dt>מכסה יומית</dt><dd>${fmt(state.me.limits.daily_sms_limit)}</dd>
          </dl>
          ${!canBulk ? `<div class="banner banner-warn" style="margin-top:14px">${icon('lock')}<div>בחבילה הנוכחית אפשר לשלוח עד 5 נמענים בכל פעם.</div></div>` : ''}
        </div></div>
        <div class="panel"><div class="panel-head"><h3>תצוגה מקדימה</h3></div><div class="panel-body" style="background:var(--bg);border-radius:0 0 12px 12px">
          <div class="bubble out" id="preview" style="max-width:100%">ההודעה תופיע כאן.</div>
          <div class="hint" id="preview-to" style="margin-top:8px"></div>
        </div></div>
      </aside>
    </div>`;

  const f = $('#f', host);
  const msg = $('#msg', host);
  const phonesEl = $('#phones', host);
  const at = f.querySelector('[name=at]');

  function recipients() {
    const set = new Set(phonesEl.value.split(/[\s,;]+/).map(normPhone).filter((p) => /^\d{9,15}$/.test(p)));
    let groupCount = 0;
    host.querySelectorAll('[data-g]:checked').forEach((g) => { groupCount += Number(g.dataset.n); });
    for (const p of set) if (byPhone.get(p) && byPhone.get(p).is_blocked) set.delete(p);
    return { phones: [...set], total: set.size + groupCount, groupIds: [...host.querySelectorAll('[data-g]:checked')].map((g) => Number(g.dataset.g)) };
  }

  function update() {
    const r = recipients();
    const info = smsInfo(msg.value);
    $('#sum-r', host).textContent = fmt(r.total);
    $('#sum-l', host).textContent = info.length ? `${info.length} תווים · ${info.parts} SMS${/\{(name|first)\}/.test(msg.value) ? ' (משתנה)' : ''}` : '—';
    $('#sum-t', host).textContent = fmt(r.total * Math.max(1, info.parts));
    $('#count', host).textContent = info.length ? `${info.length} · ${info.parts} SMS` : '';
    const sample = r.phones[0] || '0501234567';
    const c = byPhone.get(sample);
    const name = c && c.name ? c.name : 'ישראל ישראלי';
    $('#preview', host).textContent = msg.value ? msg.value.replace(/\{name\}/g, name).replace(/\{first\}/g, name.split(' ')[0]).replace(/\{phone\}/g, sample) : 'ההודעה תופיע כאן.';
    $('#preview-to', host).textContent = msg.value && /\{(name|first|phone)\}/.test(msg.value) ? `דוגמה עבור ${name}` : '';
    const later = f.querySelector('[name=when]:checked').value === 'later';
    $('#send-label', host).textContent = later ? 'תזמון' : r.total > 1 ? `שליחה ל-${fmt(r.total)} נמענים` : 'שליחה';
  }

  on(host, 'click', '[data-ins]', (e, b) => {
    const pos = msg.selectionStart ?? msg.value.length;
    msg.value = msg.value.slice(0, pos) + b.dataset.ins + msg.value.slice(pos);
    msg.focus(); update();
  });
  const tplSel = $('#tpl', host);
  if (tplSel) tplSel.addEventListener('change', () => { if (tplSel.value !== '') { msg.value = (msg.value ? msg.value + '\n' : '') + tpls[Number(tplSel.value)].body; tplSel.value = ''; update(); } });
  host.addEventListener('input', update);
  host.addEventListener('change', (e) => {
    if (e.target.name === 'when') {
      at.classList.toggle('hidden', e.target.value !== 'later');
      if (e.target.value === 'later' && !at.value) {
        const d = new Date(Date.now() + 3600_000); d.setMinutes(0, 0, 0);
        at.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
    }
    update();
  });
  update();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(f);
    const r = recipients();
    if (!r.total) return toast('לא נבחרו נמענים', 'err');
    if (!v.message) return toast('ההודעה ריקה', 'err');
    const later = v.when === 'later';
    const sendAt = later ? new Date(v.at).getTime() : null;
    if (later && !(sendAt > Date.now())) return toast('בחר זמן עתידי', 'err');
    const ok = await confirmDialog(`${later ? `לתזמן ל-${fullTime(sendAt)}` : 'לשלוח עכשיו'} ל-${fmt(r.total)} נמענים?`, { confirm: later ? 'תזמון' : 'שליחה', title: 'אישור שליחה' });
    if (!ok) return;
    const btn = f.querySelector('button[type=submit]');
    btn.classList.add('busy'); btn.disabled = true;
    try {
      const res = await api('/api/messages/campaign', { method: 'POST', body: { system: Number(v.system), group_ids: r.groupIds, phones: r.phones, message: v.message, label: v.label, send_at: sendAt } });
      toast(res.scheduled ? 'השליחה תוזמנה' : res.immediate ? `נשלח ל-${fmt(res.recipients)} נמענים` : `הקמפיין נכנס לתור (${res.parts} מנות) ויישלח ברקע`);
      go('#/campaigns?tab=list');
    } catch (err) { toast(err.message, 'err'); } finally { btn.classList.remove('busy'); btn.disabled = false; }
  });
}

async function campaignsList(host) {
  host.innerHTML = loadingState();
  let timer = null;
  async function draw() {
    const rows = await api('/api/messages/campaigns');
    const sysName = Object.fromEntries(state.systems.map((s) => [s.id, s.name]));
    if (!rows.length) { host.innerHTML = emptyState({ ic: 'campaign', title: 'אין עדיין קמפיינים', text: 'שליחות קבוצתיות ומתוזמנות יופיעו כאן עם מעקב התקדמות.', action: '<a class="btn btn-primary" href="#/campaigns">שליחה חדשה</a>' }); return false; }
    host.innerHTML = `<div class="panel panel-flush"><div class="panel-body">${rows.map((c) => {
      const pct = c.recipients ? Math.round(((c.sent + c.failed) / c.recipients) * 100) : 0;
      const future = c.pending && c.send_at > Date.now() + 60_000;
      const status = c.canceled && !c.pending ? '<span class="badge">בוטל</span>'
        : future ? `<span class="badge badge-accent">${icon('schedule')} ${ago(c.send_at)}</span>`
          : c.pending ? '<span class="badge badge-warn">בשליחה</span>'
            : c.failed ? '<span class="badge badge-danger">הסתיים עם שגיאות</span>' : '<span class="badge badge-ok">נשלח</span>';
      return `<div class="list-row">
        <div class="grow"><b>${esc(c.label || 'קמפיין')}</b> ${status}
          <div class="muted small">${esc(sysName[c.system_id] || '')} · ${fullTime(c.send_at)} · ${fmt(c.recipients)} נמענים${c.failed ? ` · ${fmt(c.failed)} נכשלו` : ''}</div>
          <div class="muted small" style="margin-top:4px">${esc(String(c.body).slice(0, 110))}</div>
          ${c.last_error ? `<div class="small" style="color:var(--danger)">${esc(c.last_error)}</div>` : ''}
          <div class="meter" style="max-width:340px"><i style="width:${pct}%"></i></div></div>
        ${c.pending ? `<button class="btn btn-sm btn-danger" data-cancel="${esc(c.batch_id)}">${icon('cancel')} ביטול</button>` : ''}
      </div>`;
    }).join('')}</div></div>`;
    return rows.some((c) => c.pending);
  }
  const loop = async () => { try { const pending = await draw(); if (pending) timer = setTimeout(loop, 10_000); } catch (e) { host.innerHTML = emptyState({ ic: 'error', title: e.message }); } };
  on(host, 'click', '[data-cancel]', async (e, b) => {
    if (!(await confirmDialog('לבטל את השליחות שעדיין לא יצאו?', { danger: true, confirm: 'ביטול שליחה' }))) return;
    const r = await api(`/api/messages/campaigns/${b.dataset.cancel}`, { method: 'DELETE' });
    toast(`בוטלו ${r.canceled} מנות`); clearTimeout(timer); loop();
  });
  await loop();
  return () => clearTimeout(timer);
}

async function templates(host) {
  host.innerHTML = loadingState();
  const draw = async () => {
    const list = await api('/api/templates');
    host.innerHTML = `
      <div class="row" style="justify-content:flex-end;margin-bottom:12px"><button class="btn btn-primary" id="new">${icon('add')} תבנית חדשה</button></div>
      <div class="panel panel-flush"><div class="panel-body">${list.length ? list.map((t) => `
        <div class="list-row"><div class="grow"><b>${esc(t.name)}</b><div class="muted small" style="white-space:pre-wrap">${esc(t.body)}</div></div>
          <button class="icon-btn" data-edit="${t.id}">${icon('edit')}</button><button class="icon-btn" data-del="${t.id}">${icon('delete')}</button></div>`).join('')
        : emptyState({ ic: 'text_snippet', title: 'אין תבניות', text: 'שמור נוסחים שאתה שולח הרבה. אפשר להשתמש ב-{name} ו-{first} להתאמה אישית.' })}</div></div>`;
    const edit = (t = {}) => modal({
      title: t.id ? 'עריכת תבנית' : 'תבנית חדשה',
      body: `<div class="field"><label>שם</label><input name="name" value="${esc(t.name || '')}" maxlength="60"></div>
             <div class="field"><label>תוכן</label><textarea name="body" rows="5">${esc(t.body || '')}</textarea><div class="hint">{name} = שם מלא, {first} = שם פרטי</div></div>`,
      actions: [{ label: 'ביטול' }, { label: 'שמירה', kind: 'primary', onClick: async (m) => { const v = formValues(m.body); await api(t.id ? `/api/templates/${t.id}` : '/api/templates', { method: t.id ? 'PUT' : 'POST', body: v }); toast('נשמר'); draw(); } }],
    });
    $('#new', host).addEventListener('click', () => edit());
    on(host, 'click', '[data-edit]', (e, b) => edit(list.find((t) => t.id === Number(b.dataset.edit))));
    on(host, 'click', '[data-del]', async (e, b) => { if (await confirmDialog('למחוק את התבנית?', { danger: true, confirm: 'מחיקה' })) { await api(`/api/templates/${b.dataset.del}`, { method: 'DELETE' }); draw(); } });
  };
  await draw();
}

const VIA = { app: 'מהאפליקציה', bulk: 'קמפיין', schedule: 'מתוזמן', api: 'API', guest: 'אורח', autoreply: 'מענה אוטומטי' };
async function history(host) {
  host.innerHTML = loadingState();
  const rows = await api('/api/messages/history');
  host.innerHTML = rows.length ? `<div class="panel panel-flush"><div class="panel-body table-wrap"><table class="table">
    <thead><tr><th>זמן</th><th>מקור</th><th>מערכת</th><th>נמענים</th><th>הודעה</th><th>סטטוס</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="num">${fullTime(r.created_at)}</td><td>${VIA[r.via] || esc(r.via)}</td><td>${esc(r.system_name || '—')}</td><td class="num">${fmt(r.recipients)}</td>
      <td class="muted small">${esc(r.preview || '')}</td><td>${r.ok ? '<span class="badge badge-ok">נשלח</span>' : `<span class="badge badge-danger" title="${esc(r.error || '')}">נכשל</span>`}</td></tr>`).join('')}
    </tbody></table></div></div>` : emptyState({ ic: 'history', title: 'עוד לא נשלחו הודעות מהמערכת החדשה' });
}

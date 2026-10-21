// אנשי קשר וקבוצות
import { api, route, $, esc, icon, can, toast, modal, confirmDialog, on, formValues, emptyState, loadingState, exportFile, go, normPhone } from '../core.js';

export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function mapColumns(rows) {
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/^\uFEFF/, ''));
  const find = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  let phone = find('phone', 'טלפון', 'נייד', 'mobile', 'מספר');
  const name = find('name', 'שם');
  const email = find('mail', 'מייל', 'דוא');
  const notes = find('note', 'הער');
  const hasHeader = phone >= 0 || name >= 0;
  if (phone < 0) {
    // בלי כותרת: העמודה עם הכי הרבה מספרים היא הטלפון
    const sample = rows.slice(0, 20);
    let best = 0; let bestScore = -1;
    for (let c = 0; c < rows[0].length; c++) {
      const score = sample.filter((r) => /^\+?[\d\-\s()]{9,}$/.test((r[c] || '').trim())).length;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    phone = best;
  }
  const data = (hasHeader ? rows.slice(1) : rows).map((r) => ({
    phone: normPhone(r[phone]),
    name: name >= 0 ? (r[name] || '').trim() : (r.find((x, i) => i !== phone && x && !/\d{5,}/.test(x)) || '').trim(),
    email: email >= 0 ? (r[email] || '').trim() : '',
    notes: notes >= 0 ? (r[notes] || '').trim() : '',
  })).filter((c) => c.phone);
  return data;
}

export function register() {
  route('/contacts', async (view) => {
    if (!can('contacts')) { view.innerHTML = `<div class="page">${emptyState({ ic: 'lock', title: 'אנשי קשר אינם זמינים בחשבון שלך' })}</div>`; return; }
    view.innerHTML = loadingState();
    const s = { contacts: [], groups: [], q: '', group: '', selected: new Set() };

    async function load() {
      [s.contacts, s.groups] = await Promise.all([api('/api/contacts'), api('/api/groups')]);
    }
    await load();

    view.innerHTML = `
      <div class="page">
        <div class="page-head"><div class="lead"><h1>אנשי קשר</h1><p>שמות במקום מספרים בכל מקום, קבוצות לשליחה, וחסימה של מספרים לא רצויים.</p></div>
          <div class="row">
            ${can('contacts.import') ? `<button class="btn" id="import">${icon('upload')} ייבוא</button><button class="btn" id="export">${icon('download')} ייצוא</button>` : ''}
            <button class="btn" id="groups">${icon('folder_shared')} קבוצות</button>
            <button class="btn btn-primary" id="add">${icon('person_add')} איש קשר</button>
          </div></div>
        <div class="panel panel-flush">
          <div class="panel-head">
            <div class="search" style="max-width:320px">${icon('search')}<input id="q" type="search" placeholder="חיפוש" aria-label="חיפוש"></div>
            <select class="input" id="gf" style="width:auto;min-height:36px"><option value="">כל הקבוצות</option><option value="-1">חסומים</option><option value="-2">מועדפים</option></select>
            <span class="grow" style="flex:1"></span>
            <div id="bulk" class="row hidden"><span class="muted small" id="selcount"></span>
              <button class="btn btn-sm" data-b="group">${icon('group_add')} לקבוצה</button>
              ${can('messages.send') ? `<button class="btn btn-sm" data-b="send">${icon('send')} שליחה</button>` : ''}
              <button class="btn btn-sm btn-danger" data-b="delete">${icon('delete')}</button></div>
          </div>
          <div class="panel-body table-wrap" id="tbl"></div>
        </div>
      </div>`;
    const tbl = $('#tbl', view);
    const gf = $('#gf', view);

    function renderGroupsFilter() {
      gf.innerHTML = `<option value="">כל הקבוצות</option><option value="-2">מועדפים</option><option value="-1">חסומים</option>${s.groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.members})</option>`).join('')}`;
      gf.value = s.group;
    }

    function filtered() {
      const q = s.q.toLowerCase();
      return s.contacts.filter((c) => {
        if (s.group === '-1' && !c.is_blocked) return false;
        if (s.group === '-2' && !c.is_favorite) return false;
        if (s.group && Number(s.group) > 0 && !c.groups.includes(Number(s.group))) return false;
        if (q && !`${c.name || ''} ${c.phone} ${c.email || ''} ${c.notes || ''}`.toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function render() {
      const list = filtered();
      const gname = Object.fromEntries(s.groups.map((g) => [g.id, g]));
      if (!s.contacts.length) {
        tbl.innerHTML = emptyState({ ic: 'contacts', title: 'אין עדיין אנשי קשר', text: 'הוסף ידנית, ייבא מקובץ CSV, או שמור ישירות מתוך שיחה.' });
      } else if (!list.length) {
        tbl.innerHTML = `<div class="empty small">אין תוצאות.</div>`;
      } else {
        tbl.innerHTML = `<table class="table"><thead><tr>
            <th style="width:36px"><input type="checkbox" id="all" aria-label="בחירת הכל"></th><th>שם</th><th>טלפון</th><th class="hide-sm">קבוצות</th><th class="hide-sm">הערות</th><th></th></tr></thead>
          <tbody>${list.slice(0, 1000).map((c) => `
            <tr>
              <td><input type="checkbox" data-sel="${c.id}" ${s.selected.has(c.id) ? 'checked' : ''} aria-label="בחירה"></td>
              <td class="cell-main"><b>${c.is_favorite ? icon('star', 'fill') : ''} ${esc(c.name || '—')}</b>${c.is_blocked ? '<span class="badge badge-danger">חסום</span>' : ''}${c.email ? `<small class="ltr">${esc(c.email)}</small>` : ''}</td>
              <td class="ltr num">${esc(c.phone)}</td>
              <td class="hide-sm">${c.groups.map((g) => gname[g] ? `<span class="badge">${esc(gname[g].name)}</span> ` : '').join('')}</td>
              <td class="hide-sm muted small">${esc((c.notes || '').slice(0, 50))}</td>
              <td class="actions">
                <a class="icon-btn" href="#/inbox?phone=${encodeURIComponent(c.phone)}" title="לשיחה">${icon('chat')}</a>
                <button class="icon-btn" data-edit="${c.id}" title="עריכה">${icon('edit')}</button>
                <button class="icon-btn" data-del="${c.id}" title="מחיקה">${icon('delete')}</button>
              </td>
            </tr>`).join('')}</tbody></table>${list.length > 1000 ? '<div class="empty small">מוצגים 1,000 ראשונים. צמצם עם חיפוש.</div>' : ''}`;
      }
      const bulk = $('#bulk', view);
      bulk.classList.toggle('hidden', !s.selected.size);
      $('#selcount', view).textContent = `${s.selected.size} נבחרו`;
    }

    function editModal(c = {}) {
      modal({
        title: c.id ? 'עריכת איש קשר' : 'איש קשר חדש',
        body: `
          <div class="grid-2">
            <div class="field"><label>שם</label><input name="name" value="${esc(c.name || '')}" maxlength="80"></div>
            <div class="field"><label>טלפון</label><input name="phone" class="ltr" inputmode="tel" value="${esc(c.phone || '')}"></div>
          </div>
          <div class="field"><label>אימייל</label><input name="email" type="email" class="ltr" value="${esc(c.email || '')}"></div>
          <div class="field"><label>הערות</label><textarea name="notes" rows="3">${esc(c.notes || '')}</textarea></div>
          ${s.groups.length ? `<div class="field"><label>קבוצות</label><div class="row">${s.groups.map((g) => `<label class="check" style="padding:0"><input type="checkbox" data-g="${g.id}" ${(c.groups || []).includes(g.id) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('')}</div></div>` : ''}
          <label class="check"><input type="checkbox" name="is_favorite" ${c.is_favorite ? 'checked' : ''}><span><b>מועדף</b></span></label>
          <label class="check"><input type="checkbox" name="is_blocked" ${c.is_blocked ? 'checked' : ''}><span><b>חסום</b><span class="hint">הודעות ממנו יוסתרו ולא יועברו באוטומציות</span></span></label>`,
        actions: [{ label: 'ביטול' }, {
          label: 'שמירה', kind: 'primary', onClick: async (m) => {
            const v = formValues(m.body);
            v.groups = [...m.body.querySelectorAll('[data-g]:checked')].map((x) => Number(x.dataset.g));
            if (c.id) await api(`/api/contacts/${c.id}`, { method: 'PUT', body: v });
            else await api('/api/contacts', { method: 'POST', body: v });
            toast('נשמר');
            await load(); renderGroupsFilter(); render();
          },
        }],
      });
    }

    function groupsModal() {
      const m = modal({
        title: 'קבוצות', wide: false,
        body: `<div id="gl"></div><div class="row" style="margin-top:12px"><input class="input grow" id="gname" placeholder="שם קבוצה חדשה" maxlength="50"><button class="btn btn-primary" id="gadd">${icon('add')} הוספה</button></div>`,
        actions: [{ label: 'סגירה' }],
      });
      const gl = $('#gl', m.el);
      const draw = () => {
        gl.innerHTML = s.groups.length ? s.groups.map((g) => `<div class="list-row"><span class="grow"><b>${esc(g.name)}</b> <span class="muted small">${g.members} חברים</span></span>
          <button class="icon-btn" data-gren="${g.id}" title="שינוי שם">${icon('edit')}</button><button class="icon-btn" data-gdel="${g.id}" title="מחיקה">${icon('delete')}</button></div>`).join('')
          : '<div class="empty small">אין עדיין קבוצות.</div>';
      };
      draw();
      $('#gadd', m.el).addEventListener('click', async () => {
        const name = $('#gname', m.el).value.trim();
        if (!name) return;
        try { await api('/api/groups', { method: 'POST', body: { name } }); $('#gname', m.el).value = ''; s.groups = await api('/api/groups'); draw(); renderGroupsFilter(); } catch (e) { toast(e.message, 'err'); }
      });
      on(gl, 'click', '[data-gdel]', async (e, b) => {
        if (!(await confirmDialog('למחוק את הקבוצה? אנשי הקשר עצמם יישארו.', { danger: true, confirm: 'מחיקה' }))) return;
        await api(`/api/groups/${b.dataset.gdel}`, { method: 'DELETE' });
        s.groups = await api('/api/groups'); draw(); await load(); renderGroupsFilter(); render();
      });
      on(gl, 'click', '[data-gren]', (e, b) => {
        const g = s.groups.find((x) => x.id === Number(b.dataset.gren));
        modal({
          title: 'שינוי שם קבוצה', body: `<div class="field"><input name="name" value="${esc(g.name)}" maxlength="50"></div>`,
          actions: [{ label: 'ביטול' }, { label: 'שמירה', kind: 'primary', onClick: async (m2) => { await api(`/api/groups/${g.id}`, { method: 'PUT', body: { name: formValues(m2.body).name } }); s.groups = await api('/api/groups'); draw(); renderGroupsFilter(); render(); } }],
        });
      });
    }

    function importModal() {
      let parsed = [];
      const m = modal({
        title: 'ייבוא אנשי קשר מ-CSV', wide: true,
        body: `
          <p class="muted">קובץ CSV מאקסל או מגוגל שיטס. המערכת מזהה אוטומטית עמודות של טלפון, שם, מייל והערות (גם בעברית).</p>
          <div class="field"><input type="file" id="file" accept=".csv,.txt,text/csv"></div>
          <div id="preview"></div>
          <div class="grid-2">
            <div class="field"><label>הוספה לקבוצה</label><select name="group_id"><option value="">ללא</option>${s.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
            <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="overwrite"><span>לעדכן שם/מייל של אנשי קשר קיימים</span></label></div>
          </div>`,
        actions: [{ label: 'ביטול' }, {
          label: 'ייבוא', kind: 'primary', onClick: async (mm) => {
            if (!parsed.length) { toast('בחר קובץ עם אנשי קשר', 'err'); return false; }
            const v = formValues(mm.body);
            const r = await api('/api/contacts/import', { method: 'POST', body: { contacts: parsed, group_id: v.group_id || null, overwrite: v.overwrite } });
            toast(`נוספו ${r.added}, עודכנו ${r.updated}, דולגו ${r.skipped}`);
            await load(); renderGroupsFilter(); render();
          },
        }],
      });
      $('#file', m.el).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const text = await f.text();
        try { parsed = mapColumns(parseCsv(text)); } catch { parsed = []; }
        $('#preview', m.el).innerHTML = parsed.length ? `
          <div class="banner banner-info">${icon('task')}<div>זוהו <b>${parsed.length}</b> אנשי קשר. תצוגה מקדימה:</div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>טלפון</th><th>שם</th><th>מייל</th></tr></thead><tbody>
          ${parsed.slice(0, 5).map((c) => `<tr><td class="ltr">${esc(c.phone)}</td><td>${esc(c.name)}</td><td class="ltr">${esc(c.email)}</td></tr>`).join('')}</tbody></table></div>`
          : `<div class="banner banner-danger">${icon('error')}<div>לא זוהו מספרי טלפון בקובץ.</div></div>`;
      });
    }

    // ---------- אירועים ----------
    renderGroupsFilter();
    render();
    $('#q', view).addEventListener('input', (e) => { s.q = e.target.value.trim(); render(); });
    gf.addEventListener('change', () => { s.group = gf.value; render(); });
    $('#add', view).addEventListener('click', () => editModal());
    $('#groups', view).addEventListener('click', groupsModal);
    const imp = $('#import', view);
    if (imp) imp.addEventListener('click', importModal);
    const exp = $('#export', view);
    if (exp) exp.addEventListener('click', () => exportFile({ kind: 'contacts', group: s.group, q: s.q }));
    on(tbl, 'click', '[data-edit]', (e, b) => editModal(s.contacts.find((c) => c.id === Number(b.dataset.edit))));
    on(tbl, 'click', '[data-del]', async (e, b) => {
      if (!(await confirmDialog('למחוק את איש הקשר?', { danger: true, confirm: 'מחיקה' }))) return;
      await api(`/api/contacts/${b.dataset.del}`, { method: 'DELETE' });
      s.contacts = s.contacts.filter((c) => c.id !== Number(b.dataset.del));
      render();
    });
    on(tbl, 'change', '[data-sel]', (e, cb) => { const id = Number(cb.dataset.sel); if (cb.checked) s.selected.add(id); else s.selected.delete(id); render(); });
    on(tbl, 'change', '#all', (e, cb) => { for (const c of filtered()) { if (cb.checked) s.selected.add(c.id); else s.selected.delete(c.id); } render(); });
    on($('#bulk', view), 'click', '[data-b]', async (e, b) => {
      const ids = [...s.selected];
      if (b.dataset.b === 'delete') {
        if (!(await confirmDialog(`למחוק ${ids.length} אנשי קשר?`, { danger: true, confirm: 'מחיקה' }))) return;
        await api('/api/contacts/bulk-delete', { method: 'POST', body: { ids } });
        s.selected.clear(); await load(); render(); toast('נמחקו');
      }
      if (b.dataset.b === 'group') {
        if (!s.groups.length) return toast('צור קודם קבוצה', 'err');
        modal({
          title: `שיוך ${ids.length} אנשי קשר`,
          body: `<div class="field"><label>קבוצה</label><select name="g">${s.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
                 <label class="check"><input type="radio" name="action" value="add" checked><span>הוספה לקבוצה</span></label>
                 <label class="check"><input type="radio" name="action" value="remove"><span>הסרה מהקבוצה</span></label>`,
          actions: [{ label: 'ביטול' }, { label: 'ביצוע', kind: 'primary', onClick: async (m) => { const v = formValues(m.body); await api(`/api/groups/${v.g}/members`, { method: 'POST', body: { contact_ids: ids, action: v.action } }); await load(); renderGroupsFilter(); render(); toast('עודכן'); } }],
        });
      }
      if (b.dataset.b === 'send') {
        sessionStorage.setItem('smt2.prefill', JSON.stringify(s.contacts.filter((c) => s.selected.has(c.id) && !c.is_blocked).map((c) => c.phone)));
        go('#/campaigns');
      }
    });
  }, { title: 'אנשי קשר', nav: 'contacts' });
}

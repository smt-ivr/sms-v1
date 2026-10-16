// גישת אורחים — קודים עם הרשאות מוגבלות (מחליף את "הקודים הזמניים")
import { api, href, route, state, $, esc, icon, toast, modal, confirmDialog, on, formValues, emptyState, loadingState, ago, fmt, copy, popover, closePopover, currentSystem } from '../core.js';

const EXPIRY = [[60, 'שעה'], [480, '8 שעות'], [1440, 'יום'], [10080, 'שבוע'], [43200, '30 יום'], [0, 'ללא תפוגה']];

function reveal(code, link) {
  const m = modal({
    title: 'קוד הגישה מוכן',
    body: `<p>זה הקוד היחיד שיוצג — שמור או שלח אותו עכשיו. אפשר תמיד ליצור קוד חדש במקומו.</p>
      <div class="secret-reveal"><code>${esc(code)}</code><button class="btn btn-sm" data-c="${esc(code)}">${icon('content_copy')} קוד</button></div>
      <div class="field" style="margin-top:14px"><label>קישור ישיר</label><div class="row"><input class="input ltr grow" readonly value="${esc(link)}"><button class="btn btn-sm" data-c="${esc(link)}">${icon('link')} העתקה</button></div></div>`,
    actions: [{ label: 'סיום', kind: 'primary' }],
  });
  on(m.el, 'click', '[data-c]', (e, b) => copy(b.dataset.c));
}

function editor(share, onDone) {
  const sh = share || { label: '', system_id: (currentSystem() || {}).id, can_read: 1, can_send: 0, phones: [], max_sends: null };
  modal({
    title: share ? `עריכה: ${share.label}` : 'קוד גישה חדש',
    body: `
      <div class="grid-2">
        <div class="field"><label>שם לזיהוי</label><input name="label" value="${esc(sh.label)}" maxlength="60" placeholder="למשל: עובד משמרת ערב"></div>
        <div class="field"><label>מערכת</label><select name="system_id" ${share ? 'disabled' : ''}>${state.systems.map((s) => `<option value="${s.id}" ${s.id === sh.system_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      </div>
      <label class="check"><input type="checkbox" name="can_read" ${sh.can_read ? 'checked' : ''}><span><b>צפייה בהודעות</b></span></label>
      <label class="check"><input type="checkbox" name="can_send" ${sh.can_send ? 'checked' : ''}><span><b>שליחת הודעות</b><span class="hint">נספר במכסה היומית שלך</span></span></label>
      <div class="field" style="margin-top:10px"><label>הגבלה למספרים מסוימים <span class="muted">(לא חובה)</span></label><textarea name="phones" class="ltr" rows="2" placeholder="ריק = כל המספרים">${esc((sh.phones || []).join(', '))}</textarea></div>
      <div class="grid-2">
        <div class="field"><label>מקסימום שליחות</label><input name="max_sends" type="number" min="1" value="${sh.max_sends || ''}" placeholder="ללא הגבלה"></div>
        ${share ? '' : `<div class="field"><label>תוקף</label><select name="expires_minutes">${EXPIRY.map(([v, l]) => `<option value="${v}" ${v === 1440 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`}
      </div>`,
    actions: [{ label: 'ביטול' }, {
      label: share ? 'שמירה' : 'יצירת קוד', kind: 'primary', onClick: async (m) => {
        const v = formValues(m.body);
        if (share) { await api(`/api/shares/${share.id}`, { method: 'PUT', body: v }); toast('נשמר'); }
        else { const r = await api('/api/shares', { method: 'POST', body: v }); reveal(r.code, r.link); }
        onDone();
      },
    }],
  });
}

export function register() {
  route('/shares', async (view) => {
    view.innerHTML = loadingState();
    const draw = async () => {
      const list = await api('/api/shares');
      view.innerHTML = `
        <div class="page page-narrow">
          <div class="page-head"><div class="lead"><h1>גישת אורחים</h1><p>תן למישהו גישה מוגבלת לתיבת ההודעות — רק צפייה, רק שליחה, או רק למספרים מסוימים — בלי למסור לו סיסמה או טוקן.</p></div>
            ${state.systems.length ? `<button class="btn btn-primary" id="new">${icon('key')} קוד חדש</button>` : ''}</div>
          ${list.length ? `<div class="panel panel-flush"><div class="panel-body">${list.map((s) => {
            const expired = s.expires_at && s.expires_at < Date.now();
            return `<div class="list-row">
              <div class="grow"><b>${esc(s.label)}</b>
                ${!s.is_active ? '<span class="badge">מושבת</span>' : expired ? '<span class="badge badge-danger">פג תוקף</span>' : '<span class="badge badge-ok">פעיל</span>'}
                <div class="muted small">${esc(s.system_name || '')} · קוד שמסתיים ב-<span class="ltr">…${esc(s.code_hint || '')}</span> · ${s.can_read ? 'צפייה' : ''}${s.can_read && s.can_send ? ' + ' : ''}${s.can_send ? 'שליחה' : ''}${s.phones.length ? ` · ${s.phones.length} מספרים בלבד` : ''}</div>
                <div class="muted small">${s.expires_at ? (expired ? `פג ${ago(s.expires_at)}` : `בתוקף עד ${ago(s.expires_at).replace('בעוד ', 'עוד ')}`) : 'ללא תפוגה'} · ${fmt(s.uses)} כניסות · ${fmt(s.sends)}${s.max_sends ? `/${fmt(s.max_sends)}` : ''} שליחות${s.last_used_at ? ` · שימוש אחרון ${ago(s.last_used_at)}` : ''}</div></div>
              <label class="switch" title="הפעלה/השבתה"><input type="checkbox" data-toggle="${s.id}" ${s.is_active ? 'checked' : ''}><span></span></label>
              <button class="icon-btn" data-menu="${s.id}" aria-label="פעולות">${icon('more_vert')}</button></div>`;
          }).join('')}</div></div>` : emptyState({ ic: 'key', title: 'אין קודי גישה', text: 'צור קוד, שלח אותו למי שצריך, והוא ייכנס דרך עמוד האורחים. אפשר לבטל בכל רגע.' })}
          <div class="banner banner-info">${icon('info')}<div>האורח נכנס בכתובת <a href="${href('/guest.html')}" target="_blank" class="ltr">${esc(location.origin + href('/guest.html'))}</a> עם הקוד. כל הפעולות שלו עוברות דרך השרת ומתועדות.</div></div>
        </div>`;
      const nb = $('#new', view);
      if (nb) nb.addEventListener('click', () => editor(null, draw));
      on(view, 'change', '[data-toggle]', async (e, cb) => {
        try { await api(`/api/shares/${cb.dataset.toggle}`, { method: 'PUT', body: { is_active: cb.checked } }); toast(cb.checked ? 'הקוד הופעל' : 'הקוד הושבת והאורחים נותקו'); draw(); } catch (err) { cb.checked = !cb.checked; toast(err.message, 'err'); }
      });
      on(view, 'click', '[data-menu]', (e, b) => {
        const s = list.find((x) => x.id === Number(b.dataset.menu));
        const pop = popover(b, `<div class="menu">
          <button data-x="1h">${icon('more_time')} הארכה בשעה</button>
          <button data-x="1d">${icon('more_time')} הארכה ביום</button>
          <button data-x="7d">${icon('more_time')} הארכה בשבוע</button>
          <hr><button data-x="edit">${icon('edit')} עריכת הרשאות</button>
          <button data-x="regen">${icon('autorenew')} יצירת קוד חדש במקום</button>
          <hr><button data-x="delete">${icon('delete')} מחיקה</button></div>`);
        on(pop, 'click', '[data-x]', async (ev, x) => {
          closePopover();
          const a = x.dataset.x;
          try {
            if (a === '1h' || a === '1d' || a === '7d') { await api(`/api/shares/${s.id}`, { method: 'PUT', body: { extend_minutes: { '1h': 60, '1d': 1440, '7d': 10080 }[a] } }); toast('התוקף הוארך'); draw(); }
            if (a === 'edit') editor(s, draw);
            if (a === 'regen' && await confirmDialog('הקוד הנוכחי יפסיק לעבוד מיד. להמשיך?', { confirm: 'יצירת קוד חדש' })) { const r = await api(`/api/shares/${s.id}/regenerate`, { method: 'POST' }); reveal(r.code, r.link); draw(); }
            if (a === 'delete' && await confirmDialog(`למחוק את "${s.label}"?`, { danger: true, confirm: 'מחיקה' })) { await api(`/api/shares/${s.id}`, { method: 'DELETE' }); draw(); }
          } catch (err) { toast(err.message, 'err'); }
        });
      });
    };
    await draw();
  }, { title: 'גישת אורחים', nav: 'shares' });
}

// החשבון שלי: פרופיל, חבילה והרשאות, סיסמה, מכשירים מחוברים, פעילות
import { api, route, state, $, esc, icon, toast, modal, on, formValues, loadingState, ago, fmt, fullTime, withBusy } from '../core.js';

const ACTIONS = {
  login: 'כניסה', 'login.failed': 'ניסיון כניסה שנכשל', 'password.change': 'שינוי סיסמה', 'password.reset': 'איפוס סיסמה',
  'sessions.revoke_others': 'ניתוק מכשירים אחרים', 'user.register': 'פתיחת החשבון', 'system.add': 'חיבור מערכת', 'system.delete': 'ניתוק מערכת',
  'system.credentials': 'עדכון פרטי מערכת', 'rule.create': 'יצירת אוטומציה', 'share.create': 'יצירת קוד גישה', 'share.login': 'כניסת אורח',
  'apikey.create': 'יצירת מפתח API', 'apikey.delete': 'ביטול מפתח API', 'campaign.create': 'קמפיין', 'campaign.schedule': 'תזמון שליחה',
  'legacy.import': 'ייבוא מהגרסה הישנה', 'admin.impersonate.start': 'מנהל נכנס לחשבון (תמיכה)', 'admin.impersonate.stop': 'מנהל יצא מהחשבון',
  'admin.user.update': 'עדכון ע״י מנהל', 'admin.user.feature': 'שינוי הרשאה ע״י מנהל',
};

function device(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'מכשיר';
  const br = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'דפדפן';
  return { os, br, mobile: /Mobile|Android|iPhone/.test(s) };
}

export function register() {
  route('/account', async (view) => {
    view.innerHTML = loadingState();
    const draw = async () => {
      const [sessions, activity, access] = await Promise.all([api('/api/me/sessions'), api('/api/me/activity'), api('/api/me/access')]);
      const me = state.me;
      const feats = Object.entries(access.features);
      view.innerHTML = `
        <div class="page page-narrow">
          <div class="page-head"><div class="lead"><h1>החשבון שלי</h1><p class="ltr" style="text-align:right">${esc(me.user.email)}</p></div></div>

          <div class="panel"><div class="panel-head"><h3>פרטים</h3></div><div class="panel-body">
            <form id="profile" class="row" style="align-items:flex-end">
              <div class="field grow" style="margin:0"><label>שם</label><input name="name" value="${esc(me.user.name)}" maxlength="80"></div>
              <button class="btn" type="submit">שמירה</button>
            </form></div></div>

          <div class="panel"><div class="panel-head"><h3>חבילה: ${esc(me.plan.name)}</h3></div><div class="panel-body">
            <div class="ledger" style="margin-bottom:14px">
              <div><div class="k">מערכות</div><div class="v">${me.usage.systems} <small>/ ${fmt(me.limits.max_systems)}</small></div></div>
              <div><div class="k">הודעות ביום</div><div class="v">${fmt(me.limits.daily_sms_limit)}</div></div>
            </div>
            <div class="grid-2">${feats.map(([k, v]) => `<div class="check" style="cursor:default">${icon(v ? 'check_circle' : 'lock', v ? 'fill' : '')}<span class="${v ? '' : 'muted'}">${esc(access.labels[k] || k)}</span></div>`).join('')}</div>
            ${me.app.support_enabled && access.features.support ? `<p class="hint" style="margin-top:10px">רוצה פיצ׳ר שנעול? <a href="#/support">כתוב למנהל המערכת</a>.</p>` : ''}
          </div></div>

          <div class="panel"><div class="panel-head"><h3>שינוי סיסמה</h3></div><div class="panel-body">
            <form id="pw"><div class="grid-2">
              <div class="field"><label>סיסמה נוכחית</label><input name="current" type="password" autocomplete="current-password"></div>
              <div class="field"><label>סיסמה חדשה</label><input name="next" type="password" autocomplete="new-password"><div class="hint">לפחות 8 תווים, אותיות וספרות. שאר המכשירים ינותקו.</div></div>
            </div><button class="btn btn-primary" type="submit">עדכון סיסמה</button></form></div></div>

          <div class="panel panel-flush"><div class="panel-head"><h3>מכשירים מחוברים</h3>${sessions.length > 1 ? '<button class="btn btn-sm" id="others">ניתוק כל השאר</button>' : ''}</div><div class="panel-body">
            ${sessions.map((s) => { const d = device(s.user_agent); return `<div class="list-row">${icon(d.mobile ? 'smartphone' : 'computer')}
              <div class="grow"><b>${d.br} · ${d.os}</b> ${s.current ? '<span class="badge badge-ok">המכשיר הזה</span>' : ''}${s.support ? '<span class="badge badge-warn">כניסת תמיכה</span>' : ''}
              <div class="muted small"><span class="ltr">${esc(s.ip || '')}</span> · פעיל ${ago(s.last_seen_at)}</div></div>
              ${s.current ? '' : `<button class="btn btn-sm" data-kill="${s.id}">ניתוק</button>`}</div>`; }).join('')}
          </div></div>

          <div class="panel panel-flush"><div class="panel-head"><h3>פעילות אחרונה</h3></div><div class="panel-body table-wrap"><table class="table"><tbody>
            ${activity.map((a) => `<tr><td>${esc(ACTIONS[a.action] || a.action)}</td><td class="ltr muted small">${esc(a.ip || '')}</td><td class="num muted small">${fullTime(a.created_at)}</td></tr>`).join('') || '<tr><td class="muted">אין פעילות.</td></tr>'}
          </tbody></table></div></div>

          ${me.user.role !== 'owner' ? `<div class="panel" style="border-color:color-mix(in srgb,var(--danger) 35%,var(--line))"><div class="panel-body row">
            <div class="grow"><b>מחיקת החשבון</b><div class="muted small">מוחק את כל המערכות, אנשי הקשר, האוטומציות וההיסטוריה. אי אפשר לשחזר.</div></div>
            <button class="btn btn-danger" id="del">מחיקת החשבון</button></div></div>` : ''}
        </div>`;

      $('#profile', view).addEventListener('submit', async (e) => {
        e.preventDefault();
        await withBusy(e.submitter, async () => { await api('/api/me', { method: 'PUT', body: formValues(e.target) }); state.me = await api('/api/me'); toast('נשמר'); }).catch(() => {});
      });
      $('#pw', view).addEventListener('submit', async (e) => {
        e.preventDefault();
        await withBusy(e.submitter, async () => { await api('/api/me/password', { method: 'POST', body: formValues(e.target) }); e.target.reset(); toast('הסיסמה עודכנה'); draw(); }).catch(() => {});
      });
      const others = $('#others', view);
      if (others) others.addEventListener('click', async () => { await api('/api/me/sessions/revoke-others', { method: 'POST' }); toast('שאר המכשירים נותקו'); draw(); });
      on(view, 'click', '[data-kill]', async (e, b) => { await api(`/api/me/sessions/${b.dataset.kill}`, { method: 'DELETE' }); draw(); });
      const del = $('#del', view);
      if (del) del.addEventListener('click', () => modal({
        title: 'מחיקת החשבון',
        body: '<p>הפעולה סופית. להמשך הזן את הסיסמה שלך.</p><div class="field"><label>סיסמה</label><input name="password" type="password" autocomplete="current-password"></div>',
        actions: [{ label: 'ביטול' }, { label: 'מחיקה לצמיתות', kind: 'danger', onClick: async (m) => { await api('/api/me/delete', { method: 'POST', body: formValues(m.body) }); location.hash = '#/'; location.reload(); } }],
      }));
    };
    await draw();
  }, { title: 'החשבון שלי', nav: 'account' });
}

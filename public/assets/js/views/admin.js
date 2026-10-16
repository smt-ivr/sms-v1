// פאנל ניהול
import { api, route, state, $, esc, icon, toast, modal, confirmDialog, on, formValues, emptyState, loadingState, ago, fmt, fullTime, listTime, initials, popover, closePopover, go, withBusy } from '../core.js';
import { chatHtml } from './support.js';

const ROLE = { user: 'משתמש', admin: 'מנהל', owner: 'בעלים' };
const STATUS = {
  active: '<span class="badge badge-ok">פעיל</span>',
  pending: '<span class="badge badge-warn">ממתין לאישור</span>',
  blocked: '<span class="badge badge-danger">חסום</span>',
};
const SYS = { ok: '<span class="badge badge-ok">תקין</span>', mfa: '<span class="badge badge-warn">אימות דו-שלבי</span>', error: '<span class="badge badge-danger">שגיאה</span>' };

const page = (title, lead, actions = '') => `<div class="page-head"><div class="lead"><h1>${title}</h1>${lead ? `<p>${lead}</p>` : ''}</div>${actions}</div>`;

function chart(days) {
  const max = Math.max(1, ...days.map((d) => d.sent + d.failed));
  return `<div class="bars">${days.map((d) => `<div class="b" data-tip="${d.day.slice(8)}.${d.day.slice(5, 7)} · ${d.sent} נשלחו · ${d.failed} כשלים · ${d.signups} נרשמו">
      <i class="out" style="height:${(d.sent / max) * 100}%"></i><i class="fail" style="height:${(d.failed / max) * 100}%"></i></div>`).join('')}</div>
    <div class="bars-axis">${days.map((d, i) => `<span>${i % 2 ? '' : Number(d.day.slice(8))}</span>`).join('')}</div>`;
}

export function register() {
  // ---------------- סקירה ----------------
  route('/admin', async (view) => {
    view.innerHTML = loadingState();
    const [s, health] = await Promise.all([api('/api/admin/stats'), api('/api/health')]);
    const cronOk = health.cron_last_run && Date.now() - health.cron_last_run < 5 * 60_000;
    view.innerHTML = `<div class="page">
      ${page('סקירת מערכת', `גרסה ${esc(health.version)} · Cron ${health.cron_last_run ? `רץ ${ago(health.cron_last_run)}` : 'עוד לא רץ'}`)}
      ${!cronOk ? `<div class="banner banner-warn">${icon('schedule')}<div><b>המשימות המתוזמנות לא רצו לאחרונה</b>שליחות מתוזמנות ואוטומציות תלויות ב-Cron. בדוק שה-trigger מוגדר ב-wrangler.toml ושה-Worker פרוס.</div></div>` : ''}
      ${s.users.pending ? `<div class="banner banner-info">${icon('how_to_reg')}<div><b>${s.users.pending} משתמשים ממתינים לאישור</b><a href="#/admin/users?status=pending">לרשימה</a></div></div>` : ''}
      <div class="ledger">
        <div><div class="k">משתמשים</div><div class="v">${fmt(s.users.total)}</div><div class="muted small">+${fmt(s.users.new_7d)} השבוע</div></div>
        <div><div class="k">SMS היום</div><div class="v">${fmt(s.sends.today)}</div><div class="muted small">${fmt(s.sends.d7)} ב-7 ימים${s.sends.failed_today ? ` · <span style="color:var(--danger)">${s.sends.failed_today} כשלים</span>` : ''}</div></div>
        <div><div class="k">מערכות מחוברות</div><div class="v">${fmt(s.systems.total)}</div><div class="muted small">${(s.systems.error || 0) + (s.systems.mfa || 0)} דורשות טיפול</div></div>
        <div><div class="k">פניות פתוחות</div><div class="v">${fmt(s.support_open)}</div></div>
        <div><div class="k">אוטומציות פעילות</div><div class="v">${fmt(s.rules_active)}</div><div class="muted small">${fmt(s.shares_active)} קודי אורח</div></div>
      </div>
      <div class="split">
        <div>
          <div class="panel"><div class="panel-head"><h3>שליחות ב-14 ימים</h3><div class="legend"><span><i style="background:var(--sys)"></i>נשלחו</span><span><i style="background:var(--danger)"></i>כשלים</span></div></div><div class="panel-body">${chart(s.chart)}</div></div>
          <div class="panel panel-flush"><div class="panel-head"><h3>פעילות אחרונה</h3><a class="btn btn-sm btn-ghost" href="#/admin/logs">ליומן המלא</a></div><div class="panel-body table-wrap"><table class="table"><tbody>
            ${s.recent_audit.map((a) => `<tr><td>${esc(a.user_name || '—')}</td><td class="ltr small">${esc(a.action)}</td><td class="muted small num">${ago(a.created_at)}</td></tr>`).join('')}
          </tbody></table></div></div>
        </div>
        <div>
          <div class="panel panel-flush"><div class="panel-head"><h3>נרשמו לאחרונה</h3></div><div class="panel-body">
            ${s.recent_users.map((u) => `<a class="list-row" href="#/admin/users/${u.id}" style="text-decoration:none;color:inherit"><span class="avatar">${esc(initials(u.name))}</span><span class="grow"><b>${esc(u.name)}</b><div class="muted small ltr" style="text-align:right">${esc(u.email)}</div></span>${STATUS[u.status]}</a>`).join('')}
          </div></div>
          <div class="panel"><div class="panel-head"><h3>חלוקה לחבילות</h3></div><div class="panel-body">
            ${s.plans.map((p) => `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span>${esc(p.name)}</span><b class="num">${fmt(p.users)}</b></div><div class="meter" style="margin:0 0 12px"><i style="width:${s.users.total ? (p.users / s.users.total) * 100 : 0}%"></i></div>`).join('')}
          </div></div>
          ${s.legacy ? `<div class="panel"><div class="panel-body row"><span class="grow">${icon('history')} בגרסה הישנה: <b>${fmt(s.legacy.codes)}</b> קודים, <b>${fmt(s.legacy.systems)}</b> מערכות</span><a class="btn btn-sm" href="#/admin/legacy">פרטים</a></div></div>` : ''}
        </div>
      </div></div>`;
  }, { title: 'ניהול · סקירה', nav: 'admin' });

  // ---------------- משתמשים ----------------
  route('/admin/users', async (view, _p, query) => {
    const f = { q: query.get('q') || '', status: query.get('status') || '', plan: query.get('plan') || '', role: '', page: 1 };
    const plans = await api('/api/admin/plans');
    view.innerHTML = `<div class="page">
      ${page('משתמשים', 'חיפוש, אישור, חסימה, שינוי חבילה והרשאות לכל חשבון.', `<button class="btn btn-primary" id="add">${icon('person_add')} משתמש חדש</button>`)}
      <div class="panel panel-flush"><div class="panel-head" style="flex-wrap:wrap">
        <div class="search" style="max-width:300px">${icon('search')}<input id="q" type="search" placeholder="שם, מייל או מזהה" value="${esc(f.q)}"></div>
        <select class="input" id="fs" style="width:auto;min-height:36px"><option value="">כל הסטטוסים</option><option value="active">פעילים</option><option value="pending">ממתינים</option><option value="blocked">חסומים</option></select>
        <select class="input" id="fp" style="width:auto;min-height:36px"><option value="">כל החבילות</option>${plans.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select>
        <select class="input" id="fr" style="width:auto;min-height:36px"><option value="">כל התפקידים</option><option value="user">משתמשים</option><option value="admin">מנהלים</option><option value="owner">בעלים</option></select>
        <span style="flex:1"></span><span class="muted small" id="total"></span>
      </div><div class="panel-body table-wrap" id="tbl"></div><div class="panel-body row hidden" id="pager" style="justify-content:center"></div></div></div>`;
    $('#fs', view).value = f.status; $('#fp', view).value = f.plan;
    const planName = Object.fromEntries(plans.map((p) => [p.key, p.name]));
    const draw = async () => {
      const qs = new URLSearchParams({ q: f.q, status: f.status, plan: f.plan, role: f.role, page: f.page });
      const r = await api(`/api/admin/users?${qs}`);
      $('#total', view).textContent = `${fmt(r.total)} משתמשים`;
      $('#tbl', view).innerHTML = r.rows.length ? `<table class="table"><thead><tr><th>משתמש</th><th>סטטוס</th><th class="hide-sm">חבילה</th><th class="hide-sm">מערכות</th><th class="hide-sm">SMS 7 ימים</th><th class="hide-sm">כניסה אחרונה</th><th></th></tr></thead><tbody>
        ${r.rows.map((u) => `<tr class="click" data-id="${u.id}">
          <td class="cell-main"><b>${esc(u.name)} ${u.role !== 'user' ? `<span class="badge badge-accent">${ROLE[u.role]}</span>` : ''}</b><small class="ltr">${esc(u.email)}</small></td>
          <td>${STATUS[u.status]}</td><td class="hide-sm">${esc(planName[u.plan] || u.plan)}</td><td class="hide-sm num">${u.systems}</td><td class="hide-sm num">${fmt(u.sms_7d)}</td>
          <td class="hide-sm muted small">${ago(u.last_login_at)}</td>
          <td class="actions">${u.status === 'pending' ? `<button class="btn btn-sm btn-primary" data-approve="${u.id}">אישור</button>` : icon('chevron_left')}</td></tr>`).join('')}</tbody></table>`
        : emptyState({ ic: 'person_search', title: 'לא נמצאו משתמשים' });
      const pages = Math.ceil(r.total / r.per);
      const pager = $('#pager', view);
      pager.classList.toggle('hidden', pages <= 1);
      pager.innerHTML = `<button class="btn btn-sm" data-pg="-1" ${f.page <= 1 ? 'disabled' : ''}>הקודם</button><span class="muted small">עמוד ${f.page} מתוך ${pages}</span><button class="btn btn-sm" data-pg="1" ${f.page >= pages ? 'disabled' : ''}>הבא</button>`;
    };
    let t = null;
    $('#q', view).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); f.page = 1; draw(); }, 300); });
    $('#fs', view).addEventListener('change', (e) => { f.status = e.target.value; f.page = 1; draw(); });
    $('#fp', view).addEventListener('change', (e) => { f.plan = e.target.value; f.page = 1; draw(); });
    $('#fr', view).addEventListener('change', (e) => { f.role = e.target.value; f.page = 1; draw(); });
    on(view, 'click', '[data-pg]', (e, b) => { f.page += Number(b.dataset.pg); draw(); });
    on(view, 'click', '[data-approve]', async (e, b) => {
      e.stopPropagation();
      await api(`/api/admin/users/${b.dataset.approve}`, { method: 'PUT', body: { status: 'active' } });
      toast('המשתמש אושר ונשלח אליו מייל'); draw();
    });
    on(view, 'click', 'tr[data-id]', (e, tr) => { if (!e.target.closest('button')) go(`#/admin/users/${tr.dataset.id}`); });
    $('#add', view).addEventListener('click', () => modal({
      title: 'משתמש חדש',
      body: `<div class="grid-2"><div class="field"><label>שם</label><input name="name"></div><div class="field"><label>אימייל</label><input name="email" type="email" class="ltr"></div></div>
        <div class="grid-2"><div class="field"><label>סיסמה ראשונית</label><input name="password" type="text" class="ltr" autocomplete="off"></div>
        <div class="field"><label>חבילה</label><select name="plan">${plans.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select></div></div>
        ${state.me.user.role === 'owner' ? '<label class="check"><input type="checkbox" name="role_admin"><span><b>מנהל</b></span></label>' : ''}
        <label class="check"><input type="checkbox" name="send_email" checked><span><b>לשלוח מייל עם הודעה על פתיחת החשבון</b></span></label>`,
      actions: [{ label: 'ביטול' }, { label: 'יצירה', kind: 'primary', onClick: async (m) => { const v = formValues(m.body); const r = await api('/api/admin/users', { method: 'POST', body: { ...v, role: v.role_admin ? 'admin' : 'user' } }); toast('המשתמש נוצר'); go(`#/admin/users/${r.id}`); } }],
    }));
    await draw();
  }, { title: 'ניהול · משתמשים', nav: 'admin-users' });

  // ---------------- משתמש בודד ----------------
  route('/admin/users/:id', async (view, params) => {
    view.innerHTML = loadingState();
    const plans = await api('/api/admin/plans');
    const draw = async () => {
      const d = await api(`/api/admin/users/${params.id}`);
      const u = d.user;
      const self = u.id === state.me.user.id;
      const ownerOnly = state.me.user.role === 'owner';
      view.innerHTML = `<div class="page">
        <div class="page-head"><div class="lead row" style="gap:14px"><a class="icon-btn" href="#/admin/users">${icon('arrow_forward')}</a><span class="avatar" style="width:52px;height:52px;font-size:18px">${esc(initials(u.name))}</span>
          <div><h1>${esc(u.name)}</h1><p class="ltr" style="text-align:right;margin:2px 0 0">${esc(u.email)}</p><div class="row" style="gap:6px;margin-top:6px">${STATUS[u.status]}<span class="badge badge-accent">${ROLE[u.role]}</span><span class="badge">${esc(d.access.plan.name)}</span></div></div></div>
          ${!self ? `<div class="row"><button class="btn" id="imp" ${u.status !== 'active' ? 'disabled' : ''}>${icon('visibility')} כניסה לחשבון</button><button class="btn" id="msg">${icon('chat')} הודעה</button><button class="icon-btn" id="more">${icon('more_vert')}</button></div>` : ''}
        </div>
        <div class="ledger">
          <div><div class="k">SMS היום</div><div class="v">${fmt(d.usage.today)} <small>/ ${fmt(d.access.limits.daily_sms_limit)}</small></div></div>
          <div><div class="k">SMS ב-30 יום</div><div class="v">${fmt(d.usage.d30)}</div></div>
          <div><div class="k">מערכות</div><div class="v">${d.systems.length} <small>/ ${fmt(d.access.limits.max_systems)}</small></div></div>
          <div><div class="k">אוטומציות · קודים · מפתחות</div><div class="v">${d.counts.rules} · ${d.counts.shares} · ${d.counts.keys}</div></div>
        </div>
        <div class="split">
          <div>
            <form class="panel" id="pf"><div class="panel-head"><h3>הגדרות החשבון</h3><button class="btn btn-primary btn-sm" type="submit">שמירה</button></div><div class="panel-body">
              <div class="grid-2">
                <div class="field"><label>שם</label><input name="name" value="${esc(u.name)}"></div>
                <div class="field"><label>חבילה</label><select name="plan">${plans.map((p) => `<option value="${esc(p.key)}" ${p.key === u.plan ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
                <div class="field"><label>סטטוס</label><select name="status" ${self ? 'disabled' : ''}>${['active', 'pending', 'blocked'].map((s) => `<option value="${s}" ${s === u.status ? 'selected' : ''}>${{ active: 'פעיל', pending: 'ממתין לאישור', blocked: 'חסום' }[s]}</option>`).join('')}</select></div>
                <div class="field"><label>תפקיד</label><select name="role" ${!ownerOnly || self || u.role === 'owner' ? 'disabled' : ''}>${u.role === 'owner' ? '<option>בעלים</option>' : ['user', 'admin'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}</select></div>
              </div>
              <div class="field"><label>סיבת חסימה (מוצגת למשתמש)</label><input name="block_reason" value="${esc(u.block_reason || '')}"></div>
              <div class="grid-2">
                <div class="field"><label>מכסת מערכות</label><input name="max_systems" type="number" min="0" value="${u.max_systems ?? ''}" placeholder="לפי החבילה"></div>
                <div class="field"><label>מכסת SMS יומית</label><input name="daily_sms_limit" type="number" min="0" value="${u.daily_sms_limit ?? ''}" placeholder="לפי החבילה"></div>
              </div>
              <div class="field"><label>הערות פנימיות</label><textarea name="admin_notes" rows="2">${esc(u.admin_notes || '')}</textarea></div>
              <div class="muted small">נרשם ${fullTime(u.created_at)}${u.signup_ip ? ` מ-<span class="ltr">${esc(u.signup_ip)}</span>` : ''} · כניסה אחרונה ${ago(u.last_login_at)}${u.last_ip ? ` מ-<span class="ltr">${esc(u.last_ip)}</span>` : ''}</div>
            </div></form>

            <div class="panel panel-flush"><div class="panel-head"><h3>הרשאות לחשבון הזה</h3></div><div class="panel-body table-wrap"><table class="table"><thead><tr><th>פיצ׳ר</th><th>בפועל</th><th>הגדרה אישית</th></tr></thead><tbody>
              ${d.features.map((f) => `<tr><td>${esc(f.label)}${!f.global_enabled ? ' <span class="badge badge-danger">כבוי לכולם</span>' : ''}</td>
                <td>${f.effective ? icon('check_circle', 'fill') : `<span class="muted">${icon('block')}</span>`}</td>
                <td><div class="seg" data-feat="${esc(f.key)}">
                  <button type="button" class="${f.override === null ? 'on' : ''}" data-v="">לפי החבילה</button>
                  <button type="button" class="${f.override === 1 ? 'on' : ''}" data-v="1">פתוח</button>
                  <button type="button" class="${f.override === 0 ? 'on' : ''}" data-v="0">חסום</button></div></td></tr>`).join('')}
            </tbody></table></div></div>
          </div>
          <div>
            <div class="panel panel-flush"><div class="panel-head"><h3>מערכות</h3></div><div class="panel-body">
              ${d.systems.length ? d.systems.map((s) => `<div class="list-row"><div class="grow"><b>${esc(s.name)}</b> ${SYS[s.status] || ''}<div class="muted small ltr" style="text-align:right">${esc(s.number || '')} · ${s.auth_type}</div></div></div>`).join('') : '<div class="empty small">אין מערכות.</div>'}
            </div></div>
            <div class="panel panel-flush"><div class="panel-head"><h3>מכשירים (${d.sessions.length})</h3>${d.sessions.length && !self ? '<button class="btn btn-sm" id="kill">ניתוק הכל</button>' : ''}</div><div class="panel-body">
              ${d.sessions.map((s) => `<div class="list-row"><div class="grow small"><span class="ltr">${esc(s.ip || '')}</span> · ${ago(s.last_seen_at)}${s.impersonator_id ? ' · <span class="badge badge-warn">תמיכה</span>' : ''}<div class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px" dir="ltr">${esc(s.user_agent || '')}</div></div></div>`).join('') || '<div class="empty small">לא מחובר.</div>'}
            </div></div>
            <div class="panel panel-flush"><div class="panel-head"><h3>יומן</h3></div><div class="panel-body" style="max-height:380px;overflow-y:auto">
              ${d.activity.map((a) => `<div class="list-row small"><div class="grow"><span class="ltr">${esc(a.action)}</span>${a.actor_name && a.actor_name !== u.name ? ` <span class="muted">ע״י ${esc(a.actor_name)}</span>` : ''}</div><span class="muted">${ago(a.created_at)}</span></div>`).join('') || '<div class="empty small">אין פעילות.</div>'}
            </div></div>
          </div>
        </div></div>`;

      $('#pf', view).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = formValues(e.target);
        if (self) { delete v.status; delete v.role; }
        if (!ownerOnly || u.role === 'owner') delete v.role;
        await withBusy(e.submitter, async () => { await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: v }); toast('נשמר'); draw(); }).catch(() => {});
      });
      on(view, 'click', '[data-feat] button', async (e, b) => {
        const key = b.parentElement.dataset.feat;
        try { await api(`/api/admin/users/${u.id}/features`, { method: 'POST', body: { key, value: b.dataset.v === '' ? null : Number(b.dataset.v) } }); draw(); } catch (err) { toast(err.message, 'err'); }
      });
      const kill = $('#kill', view);
      if (kill) kill.addEventListener('click', async () => { await api(`/api/admin/users/${u.id}/revoke-sessions`, { method: 'POST' }); toast('נותק'); draw(); });
      if (self) return;
      $('#imp', view).addEventListener('click', async () => {
        if (!(await confirmDialog(`להיכנס לחשבון של ${u.name}? הכניסה מתועדת ומוצגת למשתמש. היציאה דרך הפס הצהוב למעלה.`, { confirm: 'כניסה' }))) return;
        await api(`/api/admin/users/${u.id}/impersonate`, { method: 'POST' });
        location.hash = '#/'; location.reload();
      });
      $('#msg', view).addEventListener('click', () => modal({
        title: `הודעה ל-${u.name}`,
        body: `<div class="seg" id="kind" style="margin-bottom:14px"><button type="button" class="on" data-k="chat">צ׳אט תמיכה</button><button type="button" data-k="notify">התראה</button></div>
          <div class="field"><label>כותרת / נושא</label><input name="title"></div><div class="field"><label>תוכן</label><textarea name="body" rows="4"></textarea></div>
          <label class="check"><input type="checkbox" name="email"><span>לשלוח גם במייל</span></label>`,
        onOpen: (m) => on(m.el, 'click', '#kind button', (e, b) => m.el.querySelectorAll('#kind button').forEach((x) => x.classList.toggle('on', x === b))),
        actions: [{ label: 'ביטול' }, {
          label: 'שליחה', kind: 'primary', onClick: async (m) => {
            const v = formValues(m.body);
            const kind = m.el.querySelector('#kind .on').dataset.k;
            if (kind === 'chat') { const r = await api('/api/admin/support/start', { method: 'POST', body: { user_id: u.id, subject: v.title, body: v.body } }); toast('נפתחה שיחה'); go(`#/admin/support/${r.id}`); }
            else { await api(`/api/admin/users/${u.id}/notify`, { method: 'POST', body: v }); toast('נשלח'); }
          },
        }],
      }));
      $('#more', view).addEventListener('click', (e) => {
        const pop = popover(e.currentTarget, `<div class="menu"><button data-x="reset">${icon('lock_reset')} שליחת קוד איפוס סיסמה</button><button data-x="audit">${icon('receipt_long')} כל היומן</button><hr><button data-x="delete">${icon('delete_forever')} מחיקת המשתמש</button></div>`);
        on(pop, 'click', '[data-x]', async (ev, x) => {
          closePopover();
          try {
            if (x.dataset.x === 'reset') { await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' }); toast('קוד איפוס נשלח למייל המשתמש'); }
            if (x.dataset.x === 'audit') go(`#/admin/logs?user=${u.id}`);
            if (x.dataset.x === 'delete' && await confirmDialog(`למחוק לצמיתות את ${u.name} וכל הנתונים שלו?`, { danger: true, confirm: 'מחיקה' })) { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('נמחק'); go('#/admin/users'); }
          } catch (err) { toast(err.message, 'err'); }
        });
      });
    };
    await draw();
  }, { title: 'ניהול · משתמש', nav: 'admin-users' });

  // ---------------- פיצ'רים וחבילות ----------------
  route('/admin/features', async (view, _p, query) => {
    const tab = query.get('tab') || 'features';
    view.innerHTML = `<div class="page">${page('הרשאות וחבילות', 'כל פעולה במערכת ניתנת להפעלה או לחסימה — לכולם, לחבילה מסוימת, לחשבונות חדשים בלבד, או למשתמש בודד.')}
      <nav class="tabs"><a href="#/admin/features" class="${tab === 'features' ? 'on' : ''}">פיצ׳רים</a><a href="#/admin/features?tab=plans" class="${tab === 'plans' ? 'on' : ''}">חבילות</a></nav><div id="tab">${loadingState()}</div></div>`;
    const host = $('#tab', view);
    if (tab === 'plans') return plansTab(host);

    const draw = async () => {
      const list = await api('/api/admin/features');
      host.innerHTML = `
        <div class="banner banner-info">${icon('info')}<div><b>איך זה עובד</b>מתג "פעיל במערכת" כבוי = חסום לכולם, כולל מנהלים. אחרת: הגדרה אישית למשתמש ← הגדרת החבילה ← ברירת המחדל.</div></div>
        <div class="panel panel-flush"><div class="panel-body table-wrap"><table class="table"><thead><tr><th>פיצ׳ר</th><th>פעיל במערכת</th><th>ברירת מחדל</th><th>לחשבונות חדשים</th><th class="hide-sm">דריסות</th><th></th></tr></thead><tbody>
        ${list.map((f) => `<tr>
          <td class="cell-main"><b>${esc(f.label)}</b><small>${esc(f.description || '')}</small></td>
          <td><label class="switch"><input type="checkbox" data-g="${esc(f.key)}" ${f.global_enabled ? 'checked' : ''}><span></span></label></td>
          <td><label class="switch"><input type="checkbox" data-d="${esc(f.key)}" ${f.default_value ? 'checked' : ''}><span></span></label></td>
          <td><select class="input" data-n="${esc(f.key)}" style="width:auto;min-height:32px;padding:2px 8px"><option value="" ${f.new_user_value === null ? 'selected' : ''}>לפי חבילה</option><option value="1" ${f.new_user_value === 1 ? 'selected' : ''}>פתוח</option><option value="0" ${f.new_user_value === 0 ? 'selected' : ''}>חסום</option></select></td>
          <td class="hide-sm small muted">${f.forced_on ? `${f.forced_on} פתוח` : ''}${f.forced_on && f.forced_off ? ' · ' : ''}${f.forced_off ? `${f.forced_off} חסום` : ''}</td>
          <td class="actions"><button class="btn btn-sm" data-apply="${esc(f.key)}">החלה גורפת</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
      const put = async (key, body) => { try { await api(`/api/admin/features/${encodeURIComponent(key)}`, { method: 'PUT', body }); toast('עודכן'); } catch (e) { toast(e.message, 'err'); draw(); } };
      on(host, 'change', '[data-g]', (e, cb) => put(cb.dataset.g, { global_enabled: cb.checked }));
      on(host, 'change', '[data-d]', (e, cb) => put(cb.dataset.d, { default_value: cb.checked }));
      on(host, 'change', '[data-n]', (e, s) => put(s.dataset.n, { new_user_value: s.value === '' ? null : Number(s.value) }));
      on(host, 'click', '[data-apply]', (e, b) => {
        const f = list.find((x) => x.key === b.dataset.apply);
        modal({
          title: `החלה גורפת: ${f.label}`,
          body: `<label class="check"><input type="radio" name="scope" value="all-1" checked><span><b>לפתוח לכל החשבונות</b><span class="hint">מוחק הגדרות אישיות והגדרות חבילה לפיצ׳ר הזה</span></span></label>
            <label class="check"><input type="radio" name="scope" value="all-0"><span><b>לחסום לכל החשבונות</b><span class="hint">מנהלים לא מושפעים. לחסימה מוחלטת השתמש במתג "פעיל במערכת"</span></span></label>
            <label class="check"><input type="radio" name="scope" value="new-1"><span><b>לפתוח רק לחשבונות שייפתחו מעכשיו</b></span></label>
            <label class="check"><input type="radio" name="scope" value="new-0"><span><b>לחסום רק לחשבונות שייפתחו מעכשיו</b><span class="hint">שימושי כשהפיצ׳ר הופך לבתשלום — הקיימים שומרים עליו</span></span></label>`,
          actions: [{ label: 'ביטול' }, {
            label: 'החלה', kind: 'primary', onClick: async (m) => {
              const [scope, value] = formValues(m.body).scope.split('-');
              await api(`/api/admin/features/${encodeURIComponent(f.key)}/apply`, { method: 'POST', body: { scope, value: Number(value) } });
              toast('הוחל'); draw();
            },
          }],
        });
      });
    };
    await draw();
    return null;
  }, { title: 'ניהול · הרשאות', nav: 'admin-features' });

  // ---------------- פניות תמיכה ----------------
  const supportHandler = async (view, params, query) => {
    const active = params.id ? Number(params.id) : null;
    let filter = query.get('status') || 'open';
    view.innerHTML = `<div class="support ${active ? 'show-thread' : ''}">
      <section class="conv-col"><div class="conv-filter"><button class="chip" data-f="open">פתוחות</button><button class="chip" data-f="closed">סגורות</button><button class="chip" data-f="">הכל</button></div><div class="conv-list" id="list"></div></section>
      <section class="thread-col" id="thread"></section></div>`;
    const list = $('#list', view);
    const thread = $('#thread', view);
    const drawList = async () => {
      view.querySelectorAll('[data-f]').forEach((c) => c.classList.toggle('on', c.dataset.f === filter));
      const rows = await api(`/api/admin/support/threads${filter ? `?status=${filter}` : ''}`);
      list.innerHTML = rows.length ? rows.map((t) => `<a class="conv ${t.admin_unread ? 'unread' : ''} ${t.id === active ? 'active' : ''}" href="#/admin/support/${t.id}" style="text-decoration:none;color:inherit">
        <span class="avatar">${esc(initials(t.user_name))}</span><span class="who">${esc(t.user_name)} · ${esc(t.subject)}</span><span class="when">${listTime(t.updated_at)}</span>
        <span class="snip">${esc(t.last_body || '')}</span><span class="meta">${t.admin_unread ? `<span class="unread-n">${t.admin_unread}</span>` : ''}</span></a>`).join('')
        : emptyState({ ic: 'inbox', title: 'אין פניות' });
    };
    const drawThread = async (silent) => {
      if (!active) { thread.innerHTML = `<div class="thread-empty"><div>${icon('mark_chat_unread', 'big')}<p class="muted">בחר פנייה.</p></div></div>`; return; }
      const { thread: t, messages } = await api(`/api/admin/support/threads/${active}`);
      const draft = $('#msg', thread) ? $('#msg', thread).value : '';
      thread.innerHTML = `
        <div class="thread-head"><a class="icon-btn show-sm" href="#/admin/support">${icon('arrow_forward')}</a>
          <div class="who"><b>${esc(t.subject)}</b><small><a href="#/admin/users/${t.user_id}">${esc(t.user_name)}</a> · <span class="ltr">${esc(t.user_email)}</span> · ${esc(t.user_plan)}</small></div>
          <button class="btn btn-sm" id="toggle">${t.status === 'open' ? `${icon('task_alt')} סגירה` : `${icon('replay')} פתיחה מחדש`}</button></div>
        <div class="thread-body" id="tb">${chatHtml(messages, 'admin')}</div>
        <div class="composer"><div class="composer-row"><textarea id="msg" rows="2" placeholder="תשובה…"></textarea><button class="send" id="send">${icon('send')}</button></div>
          <div class="composer-meta"><label class="check" style="padding:0"><input type="checkbox" id="em"><span>גם במייל</span></label><label class="check" style="padding:0"><input type="checkbox" id="cl"><span>לסגור אחרי התשובה</span></label></div></div>`;
      $('#msg', thread).value = draft;
      const tb = $('#tb', thread); tb.scrollTop = tb.scrollHeight;
      if (!silent) $('#msg', thread).focus();
      $('#toggle', thread).addEventListener('click', async () => { await api(`/api/admin/support/threads/${active}`, { method: 'PUT', body: { status: t.status === 'open' ? 'closed' : 'open' } }); drawThread(); drawList(); });
    };
    const send = async () => {
      const text = $('#msg', thread).value.trim();
      if (!text) return;
      try {
        await api(`/api/admin/support/threads/${active}/messages`, { method: 'POST', body: { body: text, email: $('#em', thread).checked, close: $('#cl', thread).checked } });
        $('#msg', thread).value = ''; await drawThread(); drawList();
      } catch (e) { toast(e.message, 'err'); }
    };
    on(thread, 'click', '#send', send);
    on(thread, 'keydown', '#msg', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    on(view, 'click', '[data-f]', (e, c) => { filter = c.dataset.f; drawList(); });
    await Promise.all([drawList(), drawThread()]);
    const timer = setInterval(() => { if (!document.hidden) { drawList(); if (active) drawThread(true); } }, 20_000);
    return () => clearInterval(timer);
  };
  route('/admin/support', supportHandler, { title: 'ניהול · פניות', nav: 'admin-support' });
  route('/admin/support/:id', supportHandler, { title: 'ניהול · פניות', nav: 'admin-support' });

  // ---------------- הודעות מערכת ושידור ----------------
  route('/admin/announce', async (view) => {
    view.innerHTML = loadingState();
    const plans = await api('/api/admin/plans');
    const draw = async () => {
      const list = await api('/api/admin/announcements');
      view.innerHTML = `<div class="page page-narrow">${page('הודעות מערכת', 'באנר שמופיע בלוח הבקרה של כל המשתמשים, או התראה ישירה לכולם (וגם במייל).')}
        <div class="panel"><div class="panel-head"><h3>באנר חדש</h3></div><div class="panel-body"><form id="an">
          <div class="field"><label>כותרת</label><input name="title" maxlength="120"></div>
          <div class="field"><label>תוכן</label><textarea name="body" rows="2"></textarea></div>
          <div class="grid-2"><div class="field"><label>סוג</label><select name="level"><option value="info">מידע</option><option value="warn">אזהרה</option><option value="success">חדשות טובות</option></select></div>
          <div class="field"><label>להסיר אוטומטית אחרי (ימים)</label><input name="days" type="number" min="0" placeholder="ללא"></div></div>
          <button class="btn btn-primary" type="submit">פרסום</button></form></div></div>
        <div class="panel panel-flush"><div class="panel-head"><h3>באנרים</h3></div><div class="panel-body">
          ${list.length ? list.map((a) => `<div class="list-row"><div class="grow"><b>${esc(a.title)}</b> <span class="badge">${{ info: 'מידע', warn: 'אזהרה', success: 'חדשות' }[a.level]}</span><div class="muted small">${esc(a.body || '')}</div><div class="muted small">${fullTime(a.created_at)}${a.expires_at ? ` · עד ${fullTime(a.expires_at)}` : ''}</div></div>
            <label class="switch"><input type="checkbox" data-act="${a.id}" ${a.active ? 'checked' : ''}><span></span></label><button class="icon-btn" data-del="${a.id}">${icon('delete')}</button></div>`).join('') : '<div class="empty small">אין באנרים.</div>'}
        </div></div>
        <div class="panel"><div class="panel-head"><h3>שידור התראה</h3></div><div class="panel-body"><form id="bc">
          <div class="field"><label>כותרת</label><input name="title" maxlength="120"></div>
          <div class="field"><label>תוכן</label><textarea name="body" rows="3"></textarea></div>
          <div class="grid-2"><div class="field"><label>למי</label><select name="plan"><option value="">כל המשתמשים הפעילים</option>${plans.map((p) => `<option value="${esc(p.key)}">חבילת ${esc(p.name)}</option>`).join('')}</select></div>
          <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="email"><span>לשלוח גם במייל</span></label></div></div>
          <button class="btn btn-primary" type="submit">${icon('campaign')} שידור</button></form></div></div></div>`;
      $('#an', view).addEventListener('submit', async (e) => { e.preventDefault(); await withBusy(e.submitter, async () => { await api('/api/admin/announcements', { method: 'POST', body: formValues(e.target) }); toast('פורסם'); draw(); }).catch(() => {}); });
      $('#bc', view).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = formValues(e.target);
        if (!(await confirmDialog(`לשלוח את ההתראה${v.email ? ' (כולל מייל)' : ''}?`, { confirm: 'שידור' }))) return;
        await withBusy(e.submitter, async () => { const r = await api('/api/admin/broadcast', { method: 'POST', body: v }); toast(`נשלח ל-${r.users} משתמשים${r.emailed ? `, ${r.emailed} מיילים` : ''}`); e.target.reset(); }).catch(() => {});
      });
      on(view, 'change', '[data-act]', async (e, cb) => { await api(`/api/admin/announcements/${cb.dataset.act}`, { method: 'PUT', body: { active: cb.checked } }); });
      on(view, 'click', '[data-del]', async (e, b) => { await api(`/api/admin/announcements/${b.dataset.del}`, { method: 'DELETE' }); draw(); });
    };
    await draw();
  }, { title: 'ניהול · הודעות מערכת', nav: 'admin-announce' });

  // ---------------- יומנים ----------------
  route('/admin/logs', async (view, _p, query) => {
    const tab = query.get('tab') || 'audit';
    const userFilter = query.get('user') || '';
    view.innerHTML = `<div class="page">${page('יומנים', 'כל פעולה רגישה מתועדת: כניסות, שינויי הרשאות, חיבורי מערכות, שליחות.')}
      <nav class="tabs"><a href="#/admin/logs" class="${tab === 'audit' ? 'on' : ''}">יומן ביקורת</a><a href="#/admin/logs?tab=sends" class="${tab === 'sends' ? 'on' : ''}">שליחות</a><a href="#/admin/logs?tab=systems" class="${tab === 'systems' ? 'on' : ''}">מערכות</a></nav>
      <div id="tab">${loadingState()}</div></div>`;
    const host = $('#tab', view);
    if (tab === 'audit') {
      host.innerHTML = `<div class="panel panel-flush"><div class="panel-head"><div class="search" style="max-width:320px">${icon('search')}<input id="q" type="search" placeholder="חיפוש שם, מייל, IP או פרטים"></div>${userFilter ? `<span class="badge">משתמש #${esc(userFilter)} <a href="#/admin/logs">${icon('close')}</a></span>` : ''}</div><div class="panel-body table-wrap" id="t"></div></div>`;
      const draw = async (q = '') => {
        const rows = await api(`/api/admin/audit?${new URLSearchParams({ q, user_id: userFilter })}`);
        $('#t', host).innerHTML = `<table class="table"><thead><tr><th>זמן</th><th>פעולה</th><th>על</th><th>ע״י</th><th class="hide-sm">פרטים</th><th>IP</th></tr></thead><tbody>
          ${rows.map((a) => `<tr><td class="num small">${fullTime(a.created_at)}</td><td class="ltr small">${esc(a.action)}</td><td>${a.user_id ? `<a href="#/admin/users/${a.user_id}">${esc(a.user_name || `#${a.user_id}`)}</a>` : '—'}</td><td class="small">${esc(a.actor_name || '')}</td>
            <td class="hide-sm muted small ltr" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.detail || '')}">${esc(a.detail || '')}</td><td class="ltr small">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table>`;
      };
      let t = null;
      $('#q', host).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => draw(e.target.value.trim()), 300); });
      await draw();
    } else if (tab === 'sends') {
      const draw = async (failed) => {
        const rows = await api(`/api/admin/sends${failed ? '?failed=1' : ''}`);
        host.innerHTML = `<div class="row" style="margin-bottom:12px"><div class="seg"><button class="${failed ? '' : 'on'}" data-f="0">הכל</button><button class="${failed ? 'on' : ''}" data-f="1">כשלים בלבד</button></div></div>
          <div class="panel panel-flush"><div class="panel-body table-wrap"><table class="table"><thead><tr><th>זמן</th><th>משתמש</th><th>מערכת</th><th>מקור</th><th>נמענים</th><th class="hide-sm">הודעה</th><th>סטטוס</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td class="num small">${fullTime(r.created_at)}</td><td><a href="#/admin/users/${r.user_id}">${esc(r.user_name || '')}</a></td><td class="small">${esc(r.system_name || '')}</td><td class="small">${esc(r.via)}</td><td class="num">${r.recipients}</td>
            <td class="hide-sm muted small">${esc(r.preview || '')}</td><td>${r.ok ? '<span class="badge badge-ok">נשלח</span>' : `<span class="badge badge-danger" title="${esc(r.error || '')}">נכשל</span>`}</td></tr>`).join('')}</tbody></table></div></div>`;
        on(host, 'click', '[data-f]', (e, b) => draw(b.dataset.f === '1'));
      };
      await draw(false);
    } else {
      const rows = await api('/api/admin/systems');
      host.innerHTML = `<div class="panel panel-flush"><div class="panel-body table-wrap"><table class="table"><thead><tr><th>מערכת</th><th>משתמש</th><th>חיבור</th><th>סטטוס</th><th>נבדק</th></tr></thead><tbody>
        ${rows.map((s) => `<tr><td class="cell-main"><b>${esc(s.name)}</b><small class="ltr">${esc(s.number || '')}</small></td><td><a href="#/admin/users/${s.user_id}">${esc(s.user_name)}</a></td><td class="small">${s.auth_type}${s.legacy_id ? ' · מהישנה' : ''}</td>
          <td>${SYS[s.status] || ''}${s.status_msg ? `<div class="muted small">${esc(s.status_msg)}</div>` : ''}</td><td class="muted small">${ago(s.last_check_at)}</td></tr>`).join('')}</tbody></table></div></div>`;
    }
  }, { title: 'ניהול · יומנים', nav: 'admin-logs' });

  // ---------------- הגדרות ----------------
  route('/admin/settings', async (view) => {
    view.innerHTML = loadingState();
    const [{ settings: s, env }, plans] = await Promise.all([api('/api/admin/settings'), api('/api/admin/plans')]);
    const ok = (v) => (v ? `<span class="badge badge-ok">${icon('check')} מוגדר</span>` : '<span class="badge badge-danger">חסר</span>');
    view.innerHTML = `<div class="page page-narrow">${page('הגדרות מערכת', '')}
      <div class="panel"><div class="panel-head"><h3>תצורת שרת</h3><button class="btn btn-sm" id="test">${icon('mail')} מייל בדיקה</button></div><div class="panel-body">
        <dl class="kv"><dt>RESEND_API_KEY</dt><dd>${ok(env.resend)}</dd><dt>ENCRYPTION_KEY</dt><dd>${ok(env.encryption)}</dd><dt>OWNER_EMAIL</dt><dd>${ok(env.owner_email)}</dd>
          <dt>APP_URL</dt><dd class="ltr">${esc(env.app_url || '—')}</dd><dt>MAIL_FROM</dt><dd class="ltr">${esc(env.mail_from || '—')}</dd></dl></div></div>
      <form id="f">
        <div class="panel"><div class="panel-head"><h3>כללי</h3></div><div class="panel-body">
          <div class="field"><label>שם המערכת</label><input name="app_name" value="${esc(s.app_name || '')}"></div>
          <label class="check"><input type="checkbox" name="maintenance" ${s.maintenance === '1' ? 'checked' : ''}><span><b>מצב תחזוקה</b><span class="hint">רק מנהלים יכולים להיכנס. אוטומציות ממשיכות לרוץ.</span></span></label>
          <div class="field"><label>הודעת תחזוקה</label><input name="maintenance_message" value="${esc(s.maintenance_message || '')}"></div>
          <label class="check"><input type="checkbox" name="support_enabled" ${s.support_enabled === '1' ? 'checked' : ''}><span><b>צ׳אט תמיכה פתוח</b></span></label>
          <label class="check"><input type="checkbox" name="login_alerts" ${s.login_alerts === '1' ? 'checked' : ''}><span><b>מייל התראה על כניסה מכתובת חדשה</b></span></label>
          <div class="field" style="margin-top:10px"><label>בדיקת אוטומציות כל (דקות)</label><input name="rules_poll_minutes" type="number" min="1" max="60" value="${esc(s.rules_poll_minutes || '2')}" style="max-width:120px"></div>
        </div></div>
        <div class="panel"><div class="panel-head"><h3>הרשמה</h3></div><div class="panel-body">
          <div class="field"><span class="label">מצב הרשמה</span>
            <label class="check"><input type="radio" name="registration_mode" value="open" ${s.registration_mode === 'open' ? 'checked' : ''}><span><b>פתוחה</b><span class="hint">כל מי שמאמת מייל נכנס מיד</span></span></label>
            <label class="check"><input type="radio" name="registration_mode" value="approval" ${s.registration_mode === 'approval' ? 'checked' : ''}><span><b>באישור מנהל</b></span></label>
            <label class="check"><input type="radio" name="registration_mode" value="closed" ${s.registration_mode === 'closed' ? 'checked' : ''}><span><b>סגורה</b><span class="hint">רק מנהל יכול לפתוח חשבונות</span></span></label></div>
          <div class="grid-2">
            <div class="field"><label>חבילה לנרשמים חדשים</label><select name="default_plan">${plans.map((p) => `<option value="${esc(p.key)}" ${p.key === s.default_plan ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
            <div class="field"><label>מקסימום חשבונות מאותה כתובת IP ביום</label><input name="signups_per_ip_per_day" type="number" min="0" value="${esc(s.signups_per_ip_per_day || '3')}"><div class="hint">0 = ללא הגבלה</div></div>
          </div>
          <label class="check"><input type="checkbox" name="block_disposable_emails" ${s.block_disposable_emails === '1' ? 'checked' : ''}><span><b>חסימת מיילים זמניים</b><span class="hint">mailinator, yopmail ודומיהם</span></span></label>
        </div></div>
        <button class="btn btn-primary" type="submit">שמירת ההגדרות</button>
      </form></div>`;
    $('#f', view).addEventListener('submit', async (e) => { e.preventDefault(); await withBusy(e.submitter, async () => { await api('/api/admin/settings', { method: 'PUT', body: formValues(e.target) }); toast('ההגדרות נשמרו'); }).catch(() => {}); });
    $('#test', view).addEventListener('click', async (e) => withBusy(e.currentTarget, async () => { const r = await api('/api/admin/settings/test-email', { method: 'POST' }); toast(`נשלח אל ${r.to}`); }).catch(() => {}));
  }, { title: 'ניהול · הגדרות', nav: 'admin-settings' });

  // ---------------- הגרסה הישנה ----------------
  route('/admin/legacy', async (view) => {
    view.innerHTML = loadingState();
    const r = await api('/api/admin/legacy');
    view.innerHTML = `<div class="page">${page('הגרסה הישנה', 'תצוגה לקריאה בלבד של הטבלאות של V1 באותו מסד. V2 לא כותב אליהן. משתמשים יכולים לייבא את המערכות שלהם עם הקוד הישן מתוך עמוד "מערכות".')}
      ${!r.available ? emptyState({ ic: 'history', title: 'לא נמצאו טבלאות של הגרסה הישנה במסד' }) : `
      <div class="panel panel-flush"><div class="panel-body table-wrap"><table class="table"><thead><tr><th>#</th><th>בעלים</th><th>קוד</th><th>מערכות</th><th>יובאו ל-V2</th><th>קודים זמניים</th><th>סטטוס</th><th>גישה אחרונה</th></tr></thead><tbody>
        ${r.codes.map((c) => `<tr><td class="num">${c.id}</td><td>${esc(c.owner_name)}</td><td class="ltr">${esc(c.code)}</td><td class="num">${c.systems} / ${c.max_systems}</td>
          <td>${c.imported ? `<span class="badge badge-ok">${c.imported}</span>` : '<span class="muted">—</span>'}</td><td>${c.allow_temp_codes ? 'כן' : 'לא'}</td>
          <td>${c.is_blocked ? '<span class="badge badge-danger">חסום</span>' : '<span class="badge">פעיל</span>'}</td><td class="muted small">${c.last_access ? ago(c.last_access) : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>`}</div>`;
  }, { title: 'ניהול · הגרסה הישנה', nav: 'admin-legacy' });
}

// ---------- לשונית חבילות ----------
async function plansTab(host) {
  const draw = async () => {
    const [plans, feats] = await Promise.all([api('/api/admin/plans'), api('/api/admin/features')]);
    host.innerHTML = `<div class="row" style="justify-content:flex-end;margin-bottom:12px"><button class="btn btn-primary" id="new">${icon('add')} חבילה חדשה</button></div>
      <div class="panel panel-flush"><div class="panel-body">${plans.map((p) => {
        const on1 = Object.entries(p.features).filter(([, v]) => v).length;
        const off = Object.entries(p.features).filter(([, v]) => !v).length;
        return `<div class="list-row"><div class="grow"><b>${esc(p.name)}</b> <span class="badge ltr">${esc(p.key)}</span> <span class="muted small">${fmt(p.users)} משתמשים</span>
          <div class="muted small">${esc(p.description || '')}</div>
          <div class="muted small">${fmt(p.max_systems)} מערכות · ${p.daily_sms_limit == null ? 'ללא הגבלת SMS' : `${fmt(p.daily_sms_limit)} SMS ביום`}${off ? ` · ${off} פיצ׳רים חסומים` : ''}${on1 ? ` · ${on1} פתוחים במפורש` : ''}</div></div>
          <button class="btn btn-sm" data-edit="${esc(p.key)}">עריכה</button><button class="icon-btn" data-menu="${esc(p.key)}">${icon('more_vert')}</button></div>`;
      }).join('')}</div></div>`;

    const edit = (p) => {
      const isNew = !p;
      p = p || { key: '', name: '', description: '', max_systems: 1, daily_sms_limit: 100, features: {}, sort: plans.length + 1 };
      modal({
        title: isNew ? 'חבילה חדשה' : `עריכה: ${p.name}`, wide: true,
        body: `<div class="grid-3">
            <div class="field"><label>מזהה (באנגלית)</label><input name="key" class="ltr" value="${esc(p.key)}" ${isNew ? '' : 'disabled'}></div>
            <div class="field"><label>שם</label><input name="name" value="${esc(p.name)}"></div>
            <div class="field"><label>סדר</label><input name="sort" type="number" value="${p.sort}"></div></div>
          <div class="field"><label>תיאור</label><input name="description" value="${esc(p.description || '')}"></div>
          <div class="grid-2"><div class="field"><label>מקסימום מערכות</label><input name="max_systems" type="number" min="0" value="${p.max_systems}"></div>
            <div class="field"><label>SMS ביום</label><input name="daily_sms_limit" type="number" min="0" value="${p.daily_sms_limit ?? ''}" placeholder="ללא הגבלה"></div></div>
          <table class="table"><thead><tr><th>פיצ׳ר</th><th>בחבילה</th></tr></thead><tbody>
            ${feats.map((f) => { const v = f.key in p.features ? p.features[f.key] : null; return `<tr><td>${esc(f.label)}</td><td><div class="seg" data-pf="${esc(f.key)}">
              <button type="button" class="${v === null ? 'on' : ''}" data-v="">ברירת מחדל (${f.default_value ? 'פתוח' : 'חסום'})</button>
              <button type="button" class="${v === 1 ? 'on' : ''}" data-v="1">פתוח</button><button type="button" class="${v === 0 ? 'on' : ''}" data-v="0">חסום</button></div></td></tr>`; }).join('')}
          </tbody></table>`,
        onOpen: (m) => on(m.el, 'click', '[data-pf] button', (e, b) => b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))),
        actions: [{ label: 'ביטול' }, {
          label: 'שמירה', kind: 'primary', onClick: async (m) => {
            const v = formValues(m.body);
            const features = {};
            m.body.querySelectorAll('[data-pf]').forEach((seg) => { const val = seg.querySelector('.on').dataset.v; if (val !== '') features[seg.dataset.pf] = Number(val); });
            await api(isNew ? '/api/admin/plans' : `/api/admin/plans/${encodeURIComponent(p.key)}`, { method: isNew ? 'POST' : 'PUT', body: { ...v, features } });
            toast('נשמר'); draw();
          },
        }],
      });
    };
    $('#new', host).addEventListener('click', () => edit(null));
    on(host, 'click', '[data-edit]', (e, b) => edit(plans.find((p) => p.key === b.dataset.edit)));
    on(host, 'click', '[data-menu]', (e, b) => {
      const p = plans.find((x) => x.key === b.dataset.menu);
      const pop = popover(b, `<div class="menu"><button data-x="move">${icon('swap_horiz')} העברת כל המשתמשים לחבילה אחרת</button><hr><button data-x="delete">${icon('delete')} מחיקה</button></div>`);
      on(pop, 'click', '[data-x]', async (ev, x) => {
        closePopover();
        if (x.dataset.x === 'move') modal({
          title: `העברת משתמשים מ"${p.name}"`,
          body: `<div class="field"><label>לחבילה</label><select name="to">${plans.filter((q) => q.key !== p.key).map((q) => `<option value="${esc(q.key)}">${esc(q.name)}</option>`).join('')}</select></div>`,
          actions: [{ label: 'ביטול' }, { label: 'העברה', kind: 'primary', onClick: async (m) => { const r = await api(`/api/admin/plans/${encodeURIComponent(p.key)}/move`, { method: 'POST', body: formValues(m.body) }); toast(`הועברו ${r.moved} משתמשים`); draw(); } }],
        });
        if (x.dataset.x === 'delete' && await confirmDialog(`למחוק את החבילה "${p.name}"?`, { danger: true, confirm: 'מחיקה' })) {
          try { await api(`/api/admin/plans/${encodeURIComponent(p.key)}`, { method: 'DELETE' }); draw(); } catch (err) { toast(err.message, 'err'); }
        }
      });
    });
  };
  await draw();
}

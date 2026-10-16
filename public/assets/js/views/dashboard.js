// לוח בקרה
import { api, route, state, esc, icon, currentSystem, can, isAdmin, fmt, listTime, initials, toast, withBusy, smsInfo, emptyState, loadingState, on } from '../core.js';

function onboarding() {
  return `
    <div class="panel">
      <div class="panel-head"><h3>שלושה צעדים כדי להתחיל</h3></div>
      <div class="panel-body">
        <div class="list-row">${icon('looks_one')}<div class="grow"><b>חיבור מערכת ימות המשיח</b><div class="muted small">עם מספר מערכת וסיסמה, או עם טוקן קבוע. הפרטים נשמרים מוצפנים בשרת.</div></div><a class="btn btn-primary" href="#/systems">חיבור מערכת</a></div>
        ${can('legacy.import') ? `<div class="list-row">${icon('history')}<div class="grow"><b>יש לך קוד אישי מהגרסה הישנה?</b><div class="muted small">אפשר לייבא ממנו את כל המערכות בלחיצה.</div></div><a class="btn" href="#/systems?import=1">ייבוא</a></div>` : ''}
        ${can('contacts') ? `<div class="list-row">${icon('looks_two')}<div class="grow"><b>הוספת אנשי קשר</b><div class="muted small">ידנית או מקובץ CSV — כדי לראות שמות במקום מספרים.</div></div><a class="btn" href="#/contacts">אנשי קשר</a></div>` : ''}
        ${can('rules.email') ? `<div class="list-row">${icon('looks_3')}<div class="grow"><b>העברת SMS למייל</b><div class="muted small">קבל הודעות נכנסות במייל, רק בימים ובשעות שתבחר.</div></div><a class="btn" href="#/automations">אוטומציות</a></div>` : ''}
      </div>
    </div>`;
}

function announcements() {
  const dismissed = JSON.parse(localStorage.getItem('smt2.dismissed') || '[]');
  return (state.me.announcements || []).filter((a) => !dismissed.includes(a.id)).map((a) => `
    <div class="banner banner-${a.level === 'warn' ? 'warn' : a.level === 'success' ? 'success' : 'info'}">
      ${icon(a.level === 'warn' ? 'warning' : 'campaign')}
      <div class="grow" style="flex:1"><b>${esc(a.title)}</b>${a.body ? `<div>${esc(a.body)}</div>` : ''}</div>
      <button class="icon-btn" data-dismiss="${a.id}" aria-label="הסתר">${icon('close')}</button>
    </div>`).join('');
}

function chart(days) {
  const max = Math.max(1, ...days.map((d) => d.in + d.out));
  return `
    <div class="bars">${days.map((d) => `
      <div class="b" data-tip="${d.day.slice(8)}.${d.day.slice(5, 7)} · ${d.in} נכנסות · ${d.out} יוצאות">
        <i class="out" style="height:${(d.out / max) * 100}%"></i><i class="in" style="height:${(d.in / max) * 100}%"></i>
      </div>`).join('')}</div>
    <div class="bars-axis">${days.map((d, i) => `<span>${i % 2 === 1 ? '' : Number(d.day.slice(8))}</span>`).join('')}</div>`;
}

export function register() {
  route('/', async (view) => {
    const sys = currentSystem();
    const me = state.me;
    const head = `
      <div class="page-head"><div class="lead"><h1>שלום, ${esc(me.user.name.split(' ')[0])}</h1>
        <p>${sys ? `מציג נתונים עבור <b>${esc(sys.name)}</b>.` : 'עוד לא חיברת מערכת.'}</p></div>
        ${sys && can('messages.send') ? `<a class="btn btn-primary" href="#/campaigns">${icon('send')} שליחה חדשה</a>` : ''}
      </div>`;
    const maint = me.app.maintenance && isAdmin() ? `<div class="banner banner-warn">${icon('construction')}<div><b>מצב תחזוקה פעיל</b>משתמשים רגילים לא יכולים להיכנס כרגע. <a href="#/admin/settings">להגדרות</a></div></div>` : '';

    if (!sys) {
      view.innerHTML = `<div class="page">${head}${maint}${announcements()}${onboarding()}</div>`;
      bindDismiss(view);
      return;
    }
    view.innerHTML = loadingState();
    let stats = null; let convs = null; let err = null;
    try {
      [stats, convs] = await Promise.all([
        api(`/api/messages/stats?system=${sys.id}`),
        api(`/api/messages/conversations?system=${sys.id}`),
      ]);
    } catch (e) { err = e; }

    const sysWarn = sys.status !== 'ok' || err ? `
      <div class="banner banner-danger">${icon('link_off')}<div><b>יש בעיה בחיבור ל"${esc(sys.name)}"</b>${esc(err ? err.message : sys.status_msg || 'נדרשת בדיקה')} <a href="#/systems">לבדיקת המערכת</a></div></div>` : '';

    const quota = stats ? stats.quota : null;
    const qPct = quota && quota.limit ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
    const sysPct = Math.min(100, Math.round((me.usage.systems / Math.max(1, me.limits.max_systems)) * 100));
    const recent = convs ? convs.conversations.filter((c) => !c.archived).slice(0, 7) : [];

    view.innerHTML = `
      <div class="page">
        ${head}${maint}${announcements()}${sysWarn}
        ${stats ? `
        <div class="ledger">
          <div><div class="k">נכנסות · 14 ימים</div><div class="v">${fmt(stats.days.reduce((s, d) => s + d.in, 0))}</div></div>
          <div><div class="k">יוצאות · 14 ימים</div><div class="v">${fmt(stats.days.reduce((s, d) => s + d.out, 0))}</div></div>
          <div><div class="k">שיחות לא נקראו</div><div class="v">${fmt(convs ? convs.total_unread : 0)}</div></div>
          <div><div class="k">מכסה היום</div><div class="v">${fmt(quota.used)} <small>/ ${fmt(quota.limit)}</small></div>${quota.limit ? `<div class="meter"><i class="${qPct > 85 ? 'hot' : ''}" style="width:${qPct}%"></i></div>` : ''}</div>
          <div><div class="k">מערכות</div><div class="v">${me.usage.systems} <small>/ ${fmt(me.limits.max_systems)}</small></div><div class="meter"><i style="width:${sysPct}%"></i></div></div>
        </div>` : ''}
        <div class="split">
          <div>
            ${stats ? `<div class="panel"><div class="panel-head"><h3>תנועה ב-14 הימים האחרונים</h3>
              <div class="legend"><span><i style="background:var(--sys)"></i>יוצאות</span><span><i style="background:color-mix(in srgb,var(--amber) 75%,transparent)"></i>נכנסות</span></div></div>
              <div class="panel-body">${chart(stats.days)}</div></div>` : ''}
            <div class="panel panel-flush"><div class="panel-head"><h3>שיחות אחרונות</h3><a class="btn btn-sm btn-ghost" href="#/inbox">לכל ההודעות</a></div>
              <div class="panel-body">${recent.length ? recent.map((c) => `
                <a class="conv ${c.unread ? 'unread' : ''}" href="#/inbox?phone=${encodeURIComponent(c.phone)}" style="text-decoration:none;color:inherit">
                  <span class="avatar">${esc(initials(c.name, c.phone))}</span>
                  <span class="who">${esc(c.name || c.phone)}</span><span class="when">${listTime(c.last.time)}</span>
                  <span class="snip">${c.last.out ? icon('reply') : ''}${esc(c.last.text)}</span>
                  <span class="meta">${c.unread ? `<span class="unread-n">${c.unread}</span>` : ''}</span>
                </a>`).join('') : emptyState({ ic: 'forum', title: 'אין עדיין שיחות', text: 'הודעות שיתקבלו או יישלחו מהמערכת יופיעו כאן.' })}</div></div>
          </div>
          <div>
            ${can('messages.send') ? `
            <div class="panel"><div class="panel-head"><h3>שליחה מהירה</h3></div><div class="panel-body">
              <form id="quick">
                <div class="field"><label for="q-phone">מספר טלפון</label><input id="q-phone" name="phone" class="ltr" inputmode="tel" placeholder="05X-XXXXXXX"></div>
                <div class="field"><label for="q-msg">הודעה</label><textarea id="q-msg" name="message" rows="3"></textarea><div class="hint" id="q-info"></div></div>
                <button class="btn btn-primary btn-block" type="submit">${icon('send')} שליחה</button>
              </form>
            </div></div>` : ''}
            ${stats && stats.top.length ? `<div class="panel panel-flush"><div class="panel-head"><h3>הכי פעילים</h3></div><div class="panel-body">
              ${stats.top.map((t) => `<a class="list-row" href="#/inbox?phone=${encodeURIComponent(t.phone)}" style="text-decoration:none;color:inherit">
                <span class="avatar">${esc(initials(t.name, t.phone))}</span><span class="grow"><b>${esc(t.name || t.phone)}</b>${t.name ? `<div class="muted small ltr">${esc(t.phone)}</div>` : ''}</span>
                <span class="badge num">${t.n}</span></a>`).join('')}</div></div>` : ''}
          </div>
        </div>
      </div>`;
    bindDismiss(view);
    const quick = view.querySelector('#quick');
    if (quick) {
      const msg = quick.querySelector('#q-msg');
      const info = quick.querySelector('#q-info');
      msg.addEventListener('input', () => { const s = smsInfo(msg.value); info.textContent = s.length ? `${s.length} תווים · ${s.parts} הודעות SMS` : ''; });
      quick.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = quick.phone.value.trim();
        const message = msg.value.trim();
        if (!phone || !message) return toast('נא למלא מספר והודעה', 'err');
        await withBusy(quick.querySelector('button'), async () => {
          await api('/api/messages/send', { method: 'POST', body: { system: sys.id, phones: [phone], message } });
          toast('ההודעה נשלחה');
          quick.reset(); info.textContent = '';
        }).catch(() => {});
      });
    }
  }, { title: 'לוח בקרה', nav: 'dashboard' });
}

function bindDismiss(view) {
  on(view, 'click', '[data-dismiss]', (e, b) => {
    const list = JSON.parse(localStorage.getItem('smt2.dismissed') || '[]');
    list.push(Number(b.dataset.dismiss));
    localStorage.setItem('smt2.dismissed', JSON.stringify(list.slice(-50)));
    b.closest('.banner').remove();
  });
}

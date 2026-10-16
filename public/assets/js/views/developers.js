// API למפתחים
import { api, BASE, route, $, esc, icon, toast, modal, confirmDialog, on, formValues, emptyState, loadingState, ago, copy, state } from '../core.js';

export function register() {
  route('/developers', async (view) => {
    view.innerHTML = loadingState();
    const origin = location.origin + BASE;
    const draw = async () => {
      const keys = await api('/api/keys');
      const sys = state.systems[0];
      view.innerHTML = `
        <div class="page page-narrow">
          <div class="page-head"><div class="lead"><h1>API למפתחים</h1><p>שלח SMS וקרא הודעות מתוך מערכות אחרות — אתר, CRM, סקריפט. ההרשאות, המכסות והחסימות של החשבון חלות גם כאן.</p></div>
            <button class="btn btn-primary" id="new">${icon('vpn_key')} מפתח חדש</button></div>
          <div class="panel panel-flush"><div class="panel-head"><h3>מפתחות</h3></div><div class="panel-body">
            ${keys.length ? keys.map((k) => `<div class="list-row">${icon('key')}<div class="grow"><b>${esc(k.name)}</b><div class="muted small"><span class="ltr">${esc(k.prefix)}…</span> · נוצר ${ago(k.created_at)} · ${k.last_used_at ? `שימוש אחרון ${ago(k.last_used_at)}` : 'טרם נעשה שימוש'}</div></div>
              <button class="btn btn-sm btn-danger" data-del="${k.id}">ביטול</button></div>`).join('') : emptyState({ ic: 'vpn_key', title: 'אין מפתחות', text: 'צור מפתח ושמור אותו במקום בטוח. הוא מוצג פעם אחת בלבד.' })}
          </div></div>

          <div class="panel"><div class="panel-head"><h3>שליחת הודעה</h3></div><div class="panel-body">
            <div class="code-box">curl -X POST ${esc(origin)}/api/v1/send \\
  -H "Authorization: Bearer smt_XXXXXXXX" \\
  -H "Content-Type: application/json" \\
  -d '{"system_id": ${sys ? sys.id : 1}, "phones": ["0501234567"], "message": "שלום!"}'</div>
            <p class="hint" style="margin-top:8px">system_id לא חובה (ברירת מחדל: המערכת הראשונה). עד 300 נמענים לבקשה. התשובה: <span class="ltr">{"ok":true,"sent":1}</span></p>
          </div></div>

          <div class="panel"><div class="panel-head"><h3>קריאת הודעות</h3></div><div class="panel-body">
            <div class="code-box">GET ${esc(origin)}/api/v1/messages?system_id=${sys ? sys.id : 1}&direction=in&since=2026-01-01%2000:00:00
GET ${esc(origin)}/api/v1/conversations?system_id=${sys ? sys.id : 1}
GET ${esc(origin)}/api/v1/systems</div>
            <p class="hint" style="margin-top:8px">פרמטרים לסינון: phone, direction (in/out), since (בפורמט התאריך של ימות המשיח). מגבלה: 120 בקשות לדקה למפתח.</p>
          </div></div>

          <div class="panel"><div class="panel-head"><h3>Webhook להודעות נכנסות</h3></div><div class="panel-body">
            <p>במקום לשאול כל הזמן, אפשר לקבל כל הודעה נכנסת ישירות לשרת שלך. הגדר כלל Webhook ב<a href="#/automations">אוטומציות</a>. בדיקת החתימה ב-Node.js:</p>
            <div class="code-box">const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
if (sig !== req.headers['x-smt-signature']) return res.status(401).end();</div>
          </div></div>
        </div>`;
      $('#new', view).addEventListener('click', () => modal({
        title: 'מפתח API חדש',
        body: '<div class="field"><label>שם לזיהוי</label><input name="name" maxlength="50" placeholder="למשל: אתר החנות"></div>',
        actions: [{ label: 'ביטול' }, {
          label: 'יצירה', kind: 'primary', onClick: async (m) => {
            const r = await api('/api/keys', { method: 'POST', body: formValues(m.body) });
            const mm = modal({
              title: 'המפתח נוצר',
              body: `<p>העתק את המפתח עכשיו — הוא לא יוצג שוב.</p><div class="secret-reveal"><code style="font-size:14px;letter-spacing:0">${esc(r.key)}</code><button class="btn btn-sm" data-c>${icon('content_copy')}</button></div>`,
              actions: [{ label: 'העתקתי', kind: 'primary' }],
            });
            mm.el.querySelector('[data-c]').addEventListener('click', () => copy(r.key));
            draw();
          },
        }],
      }));
      on(view, 'click', '[data-del]', async (e, b) => {
        if (!(await confirmDialog('לבטל את המפתח? מערכות שמשתמשות בו יפסיקו לעבוד מיד.', { danger: true, confirm: 'ביטול המפתח' }))) return;
        await api(`/api/keys/${b.dataset.del}`, { method: 'DELETE' }); toast('המפתח בוטל'); draw();
      });
    };
    await draw();
  }, { title: 'API למפתחים', nav: 'developers' });
}

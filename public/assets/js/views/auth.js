// מסכי כניסה, הרשמה חכמה, אימות מייל ואיפוס סיסמה
import { api, href, esc, icon, toast, withBusy, formValues } from '../core.js';

const COMMON_DOMAINS = ['gmail.com', 'walla.co.il', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'netvision.net.il', 'bezeqint.net', 'live.com', 'zahav.net.il'];

// הצעת תיקון לשגיאות כתיב בדומיין (gmial.com → gmail.com)
function suggestDomain(email) {
  const [local, domain] = String(email).toLowerCase().split('@');
  if (!local || !domain || COMMON_DOMAINS.includes(domain)) return null;
  const dist = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  const best = COMMON_DOMAINS.map((d) => [d, dist(domain, d)]).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] > 0 && best[1] <= 2 ? `${local}@${best[0]}` : null;
}

function pwScore(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (/\d/.test(p) && /[A-Za-z\u0590-\u05FF]/.test(p)) s++;
  if (p.length >= 12 || /[^A-Za-z0-9\u0590-\u05FF]/.test(p)) s++;
  return s;
}

const side = (appName) => `
  <aside class="auth-side">
    <div class="brand"><span class="brand-mark">${icon('sms', 'fill')}</span><span><b>${esc(appName)}</b><small>גרסה 2</small></span></div>
    <div>
      <h2>כל ה-SMS של ימות המשיח, במקום אחד.</h2>
      <p class="lead">שיחות, אנשי קשר, קמפיינים והעברה למייל לפי שעות — והטוקן של המערכת שלך לא יוצא מהשרת אף פעם.</p>
      <div class="auth-demo" aria-hidden="true">
        <div class="bubble in">שלום, אפשר לקבוע תור למחר בבוקר?</div>
        <div class="tag">${icon('forward_to_inbox')} הועבר למייל · 08:02</div>
        <div class="bubble out">בוודאי. 10:30 מתאים לך?</div>
        <div class="bubble in">מעולה, תודה!</div>
        <div class="tag">${icon('bolt')} מענה אוטומטי פעיל מחוץ לשעות</div>
      </div>
    </div>
    <div class="auth-foot">חיבור מאובטח · הצפנת AES-256 לפרטי המערכות</div>
  </aside>`;

export async function showAuth(app, { onDone, message, maintenance } = {}) {
  let config = { app_name: 'S.M.T Messages', registration_mode: 'open' };
  try { config = await api('/api/public/config'); } catch { /* ממשיכים עם ברירת מחדל */ }
  document.title = config.app_name;
  app.innerHTML = `<div class="auth">${side(config.app_name)}<section class="auth-form"><div class="auth-card" id="auth-card"></div></section></div>`;
  const card = app.querySelector('#auth-card');
  const ctx = { email: '', resendTimer: null };

  const notice = (text, kind = 'warn') => (text ? `<div class="banner banner-${kind}">${icon(kind === 'warn' ? 'info' : kind === 'danger' ? 'block' : 'check_circle')}<div>${esc(text)}</div></div>` : '');

  function login(msg, kind) {
    card.innerHTML = `
      <h1>כניסה</h1>
      <p class="sub">התחבר עם כתובת המייל והסיסמה שלך.</p>
      ${notice(msg, kind)}
      ${maintenance && !msg ? notice('המערכת בתחזוקה כרגע. מנהלים יכולים להתחבר.') : ''}
      <form id="f" novalidate>
        <div class="field"><label for="email">אימייל</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required value="${esc(ctx.email)}"></div>
        <div class="field"><label for="password">סיסמה</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary btn-block" type="submit">כניסה לחשבון</button>
      </form>
      <div class="alt"><a data-go="forgot">שכחתי סיסמה</a>${config.registration_mode !== 'closed' ? ` · אין לך חשבון? <a data-go="register">הרשמה</a>` : ''}</div>
      <div class="alt"><a href="${href('/guest.html')}">כניסה עם קוד גישה</a></div>`;
    card.querySelector(ctx.email ? '#password' : '#email').focus();
    card.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      ctx.email = v.email;
      if (!v.email || !v.password) return toast('נא למלא אימייל וסיסמה', 'err');
      await withBusy(e.target.querySelector('button'), async () => {
        await api('/api/auth/login', { method: 'POST', body: v });
        onDone();
      }).catch((err) => { if (err.code === 'pending') pending(); });
    });
  }

  function register() {
    card.innerHTML = `
      <h1>פתיחת חשבון</h1>
      <p class="sub">${config.registration_mode === 'approval' ? 'אחרי אימות המייל, החשבון יעבור לאישור מנהל.' : 'חשבון אחד לכל כתובת מייל. נשלח אליך קוד אימות.'}</p>
      <form id="f" novalidate autocomplete="on">
        <div class="field"><label for="name">שם מלא או שם העסק</label><input id="name" name="name" autocomplete="name" required maxlength="80"></div>
        <div class="field"><label for="email">אימייל</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required value="${esc(ctx.email)}">
          <div class="hint hidden" id="email-hint"></div></div>
        <div class="field"><label for="password">סיסמה</label><input id="password" name="password" type="password" autocomplete="new-password" required>
          <div class="pw-meter"><i></i><i></i><i></i></div><div class="hint">לפחות 8 תווים, אותיות וספרות.</div></div>
        <div class="sr-only" aria-hidden="true"><label>אתר<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <button class="btn btn-primary btn-block" type="submit">שליחת קוד אימות</button>
      </form>
      <div class="alt">כבר רשום? <a data-go="login">כניסה</a></div>`;
    const email = card.querySelector('#email');
    const hint = card.querySelector('#email-hint');
    email.addEventListener('blur', () => {
      const s = suggestDomain(email.value.trim());
      hint.classList.toggle('hidden', !s);
      if (s) hint.innerHTML = `האם התכוונת ל-<a href="#" data-fix="${esc(s)}" class="ltr">${esc(s)}</a>?`;
    });
    hint.addEventListener('click', (e) => { const a = e.target.closest('[data-fix]'); if (a) { e.preventDefault(); email.value = a.dataset.fix; hint.classList.add('hidden'); } });
    const pw = card.querySelector('#password');
    pw.addEventListener('input', () => {
      const s = pwScore(pw.value);
      card.querySelectorAll('.pw-meter i').forEach((i, idx) => { i.className = idx < s ? `on${s}` : ''; });
    });
    card.querySelector('#name').focus();
    card.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      ctx.email = v.email;
      if (!v.name || !v.email || !v.password) return toast('נא למלא את כל השדות', 'err');
      await withBusy(e.target.querySelector('button'), async () => {
        const r = await api('/api/auth/register/start', { method: 'POST', body: v });
        verify(r.resend_after || 60);
      }).catch((err) => { if (err.code === 'email_taken') login('כבר קיים חשבון עם המייל הזה. התחבר או אפס סיסמה.', 'warn'); });
    });
  }

  function verify(cooldown) {
    card.innerHTML = `
      <h1>אימות המייל</h1>
      <p class="sub">שלחנו קוד בן 6 ספרות אל <b class="ltr">${esc(ctx.email)}</b>. כדאי לבדוק גם בתיקיית הספאם.</p>
      <form id="f" novalidate>
        <div class="field"><label for="code" class="sr-only">קוד אימות</label>
          <input id="code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required></div>
        <button class="btn btn-primary btn-block" type="submit">אימות ופתיחת החשבון</button>
      </form>
      <div class="alt"><a id="resend" aria-disabled="true"></a> · <a data-go="register">שינוי כתובת</a></div>`;
    const code = card.querySelector('#code');
    code.focus();
    code.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      if (code.value.length === 6) card.querySelector('#f').requestSubmit();
    });
    const resend = card.querySelector('#resend');
    let left = cooldown;
    const tickResend = () => {
      resend.textContent = left > 0 ? `שליחה חוזרת בעוד ${left} שנ׳` : 'שליחת קוד חדש';
      resend.style.pointerEvents = left > 0 ? 'none' : '';
      resend.style.opacity = left > 0 ? '.6' : '';
      left--;
    };
    tickResend();
    clearInterval(ctx.resendTimer);
    ctx.resendTimer = setInterval(() => { if (left < -1) return clearInterval(ctx.resendTimer); tickResend(); }, 1000);
    resend.addEventListener('click', async () => {
      try { const r = await api('/api/auth/register/resend', { method: 'POST', body: { email: ctx.email } }); toast('קוד חדש נשלח'); left = r.resend_after || 60; tickResend(); clearInterval(ctx.resendTimer); ctx.resendTimer = setInterval(() => { if (left < -1) return clearInterval(ctx.resendTimer); tickResend(); }, 1000); } catch (e) { toast(e.message, 'err'); }
    });
    card.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (code.value.length !== 6) return toast('הקוד צריך להכיל 6 ספרות', 'err');
      await withBusy(e.target.querySelector('button'), async () => {
        const r = await api('/api/auth/register/verify', { method: 'POST', body: { email: ctx.email, code: code.value } });
        clearInterval(ctx.resendTimer);
        if (r.status === 'pending') pending();
        else { toast('החשבון נפתח. ברוך הבא!'); location.hash = '#/systems'; onDone(); }
      }).catch(() => { code.value = ''; code.focus(); });
    });
  }

  function pending() {
    card.innerHTML = `
      <div class="empty" style="padding:10px 0 0">${icon('hourglass_top')}<h3>החשבון ממתין לאישור</h3>
      <p>מנהל המערכת יאשר את החשבון בהקדם ונשלח אליך מייל. אחרי האישור אפשר להתחבר כרגיל.</p>
      <button class="btn" data-go="login">חזרה לכניסה</button></div>`;
  }

  function forgot() {
    card.innerHTML = `
      <h1>איפוס סיסמה</h1>
      <p class="sub">נשלח קוד איפוס לכתובת המייל של החשבון.</p>
      <form id="f" novalidate>
        <div class="field"><label for="email">אימייל</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required value="${esc(ctx.email)}"></div>
        <button class="btn btn-primary btn-block" type="submit">שליחת קוד</button>
      </form>
      <div class="alt"><a data-go="login">חזרה לכניסה</a></div>`;
    card.querySelector('#email').focus();
    card.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      ctx.email = formValues(e.target).email;
      await withBusy(e.target.querySelector('button'), async () => {
        await api('/api/auth/forgot', { method: 'POST', body: { email: ctx.email } });
        reset();
      }).catch(() => {});
    });
  }

  function reset() {
    card.innerHTML = `
      <h1>סיסמה חדשה</h1>
      <p class="sub">אם הכתובת <b class="ltr">${esc(ctx.email)}</b> רשומה, נשלח אליה קוד. הזן אותו ובחר סיסמה חדשה.</p>
      <form id="f" novalidate>
        <div class="field"><label for="code">קוד איפוס</label><input id="code" name="code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>
        <div class="field"><label for="password">סיסמה חדשה</label><input id="password" name="password" type="password" autocomplete="new-password" required><div class="hint">לפחות 8 תווים, אותיות וספרות.</div></div>
        <button class="btn btn-primary btn-block" type="submit">שמירת הסיסמה</button>
      </form>
      <div class="alt"><a data-go="forgot">שליחת קוד חדש</a> · <a data-go="login">חזרה לכניסה</a></div>`;
    card.querySelector('#code').focus();
    card.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      await withBusy(e.target.querySelector('button'), async () => {
        await api('/api/auth/reset', { method: 'POST', body: { email: ctx.email, ...v } });
        login('הסיסמה עודכנה וכל המכשירים נותקו. אפשר להתחבר עם הסיסמה החדשה.', 'success');
      }).catch(() => {});
    });
  }

  card.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]');
    if (!a) return;
    e.preventDefault();
    ({ login, register, forgot, verify: () => verify(0) })[a.dataset.go]();
  });

  const blocked = message && /חסום/.test(message);
  login(message, blocked ? 'danger' : 'warn');
}

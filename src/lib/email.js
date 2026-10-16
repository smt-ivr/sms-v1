// מיילים מעוצבים (RTL) דרך Resend
import { getSettings } from './db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BRAND = '#0B6E66';
const INK = '#16202B';
const PAPER = '#F1F4F2';

function layout({ appName, appUrl, title, preheader = '', bodyHtml, cta }) {
  const button = cta ? `
    <tr><td style="padding:8px 32px 28px">
      <a href="${esc(cta.url)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">${esc(cta.label)}</a>
    </td></tr>` : '';
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:Arial,'Segoe UI',Helvetica,sans-serif;color:${INK}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:28px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #DCE2DE" dir="rtl">
    <tr><td style="background:${INK};padding:18px 32px;text-align:right">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3FB7A8;margin-left:8px;vertical-align:middle"></span>
      <span style="color:#ffffff;font-size:16px;font-weight:700;vertical-align:middle">${esc(appName)}</span>
    </td></tr>
    <tr><td style="padding:28px 32px 8px;text-align:right">
      <h1 style="margin:0 0 12px;font-size:21px;line-height:1.35;color:${INK}">${esc(title)}</h1>
      <div style="font-size:15px;line-height:1.7;color:#3B4743">${bodyHtml}</div>
    </td></tr>
    ${button}
    <tr><td style="padding:18px 32px;border-top:1px solid #E6EBE8;font-size:12px;line-height:1.6;color:#6B7772;text-align:right">
      הודעה זו נשלחה אוטומטית מ-${esc(appName)}${appUrl ? ` · <a href="${esc(appUrl)}" style="color:${BRAND}">${esc(appUrl.replace(/^https?:\/\//, ''))}</a>` : ''}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

const codeBlock = (code) => `
  <div style="margin:18px 0;padding:16px;background:${PAPER};border-radius:10px;text-align:center">
    <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:${INK}" dir="ltr">${esc(code)}</span>
  </div>`;

async function send(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — email not sent:', subject, '→', to);
    return { ok: false, error: 'שירות המייל לא הוגדר בשרת (RESEND_API_KEY).' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'S.M.T <sms@smti.uk>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('Resend error', res.status, t);
      return { ok: false, error: `שגיאה בשליחת מייל (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    console.error('Resend network error', e);
    return { ok: false, error: 'שגיאת רשת בשליחת מייל' };
  }
}

async function base(env) {
  const s = await getSettings(env);
  return { appName: s.app_name || 'S.M.T Messages', appUrl: env.APP_URL || '' };
}

export async function mailVerifyCode(env, to, name, code) {
  const b = await base(env);
  return send(env, {
    to, subject: `${code} — קוד האימות שלך ב-${b.appName}`,
    html: layout({
      ...b, title: 'אימות כתובת המייל', preheader: `קוד האימות: ${code}`,
      bodyHtml: `שלום ${esc(name)},<br>כדי להשלים את פתיחת החשבון, הזן את הקוד הבא:${codeBlock(code)}
        הקוד תקף ל-15 דקות. אם לא ביקשת להירשם, אפשר להתעלם מהמייל הזה.`,
    }),
  });
}

export async function mailResetCode(env, to, name, code) {
  const b = await base(env);
  return send(env, {
    to, subject: `איפוס סיסמה — ${b.appName}`,
    html: layout({
      ...b, title: 'איפוס סיסמה', preheader: `קוד האיפוס: ${code}`,
      bodyHtml: `שלום ${esc(name)},<br>התקבלה בקשה לאיפוס הסיסמה לחשבון שלך. קוד האיפוס:${codeBlock(code)}
        הקוד תקף ל-15 דקות. אם לא ביקשת איפוס, הסיסמה שלך לא שונתה ואין צורך לעשות דבר.`,
    }),
  });
}

export async function mailWelcome(env, to, name, pending) {
  const b = await base(env);
  return send(env, {
    to, subject: pending ? `החשבון נפתח וממתין לאישור — ${b.appName}` : `ברוך הבא ל-${b.appName}`,
    html: layout({
      ...b, title: pending ? 'החשבון ממתין לאישור' : 'החשבון מוכן',
      bodyHtml: pending
        ? `שלום ${esc(name)},<br>כתובת המייל אומתה. החשבון ממתין כעת לאישור מנהל המערכת, ונעדכן אותך במייל ברגע שיאושר.`
        : `שלום ${esc(name)},<br>החשבון שלך פעיל. השלב הבא: חבר מערכת של ימות המשיח והתחל לנהל את ההודעות שלך במקום אחד.`,
      cta: pending ? null : { label: 'כניסה לחשבון', url: b.appUrl || '#' },
    }),
  });
}

export async function mailApproved(env, to, name) {
  const b = await base(env);
  return send(env, {
    to, subject: `החשבון אושר — ${b.appName}`,
    html: layout({ ...b, title: 'החשבון שלך אושר', bodyHtml: `שלום ${esc(name)},<br>מנהל המערכת אישר את החשבון. אפשר להתחבר עכשיו.`, cta: { label: 'כניסה לחשבון', url: b.appUrl || '#' } }),
  });
}

export async function mailLoginAlert(env, to, name, { ip, ua, when }) {
  const b = await base(env);
  return send(env, {
    to, subject: `כניסה חדשה לחשבון — ${b.appName}`,
    html: layout({
      ...b, title: 'זוהתה כניסה ממכשיר חדש',
      bodyHtml: `שלום ${esc(name)},<br>נרשמה כניסה לחשבון שלך:
        <table style="margin:14px 0;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:4px 0 4px 16px;color:#6B7772">זמן</td><td>${esc(when)}</td></tr>
          <tr><td style="padding:4px 0 4px 16px;color:#6B7772">כתובת IP</td><td dir="ltr">${esc(ip)}</td></tr>
          <tr><td style="padding:4px 0 4px 16px;color:#6B7772">דפדפן</td><td dir="ltr" style="font-size:12px">${esc(String(ua).slice(0, 120))}</td></tr>
        </table>
        אם זה לא היית אתה, החלף סיסמה מיד ונתק את כל המכשירים מתוך "החשבון שלי".`,
      cta: { label: 'ניהול מכשירים מחוברים', url: (b.appUrl || '') + '/#/account' },
    }),
  });
}

// העברת SMS למייל — מיידי או סיכום
export async function mailSmsForward(env, to, { ruleName, systemName, messages, names = {} }) {
  const b = await base(env);
  const rows = messages.map((m) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #E6EBE8;vertical-align:top;width:130px">
        <div style="font-weight:700;color:${INK}">${esc(names[m.phone] || m.phone)}</div>
        ${names[m.phone] ? `<div style="font-size:12px;color:#6B7772" dir="ltr">${esc(m.phone)}</div>` : ''}
        <div style="font-size:12px;color:#6B7772" dir="ltr">${esc(m.time)}</div>
      </td>
      <td style="padding:12px 12px 12px 0;border-bottom:1px solid #E6EBE8;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(m.text)}</td>
    </tr>`).join('');
  const single = messages.length === 1;
  return send(env, {
    to,
    subject: single
      ? `SMS מ-${names[messages[0].phone] || messages[0].phone}: ${messages[0].text.slice(0, 40)}`
      : `${messages.length} הודעות SMS חדשות — ${systemName}`,
    html: layout({
      ...b,
      title: single ? 'הודעת SMS חדשה' : `${messages.length} הודעות חדשות`,
      preheader: messages[0] ? messages[0].text.slice(0, 90) : '',
      bodyHtml: `<div style="font-size:13px;color:#6B7772;margin-bottom:6px">מערכת: ${esc(systemName)} · כלל: ${esc(ruleName)}</div>
        <table role="presentation" width="100%" style="border-collapse:collapse">${rows}</table>`,
      cta: { label: 'פתיחה בתיבת ההודעות', url: (b.appUrl || '') + '/#/inbox' },
    }),
  });
}

export async function mailGeneric(env, to, { title, body, cta }) {
  const b = await base(env);
  return send(env, {
    to, subject: `${title} — ${b.appName}`,
    html: layout({ ...b, title, bodyHtml: esc(body).replace(/\n/g, '<br>'), cta }),
  });
}

// שליחה מרוכזת (Resend batch: עד 100 מיילים לקריאה)
export async function mailBroadcast(env, recipients, { title, body, cta }) {
  if (!env.RESEND_API_KEY) return { ok: false, sent: 0, error: 'RESEND_API_KEY לא הוגדר' };
  const b = await base(env);
  const html = layout({ ...b, title, bodyHtml: esc(body).replace(/\n/g, '<br>'), cta });
  let sent = 0;
  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100).map((to) => ({ from: env.MAIL_FROM || 'S.M.T <sms@smti.uk>', to: [to], subject: `${title} — ${b.appName}`, html }));
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) return { ok: false, sent, error: `Resend ${res.status}` };
    sent += chunk.length;
  }
  return { ok: true, sent };
}

export async function mailTest(env, to) {
  return mailGeneric(env, to, { title: 'בדיקת שליחה', body: 'אם קיבלת את המייל הזה, ההגדרה עובדת.' });
}

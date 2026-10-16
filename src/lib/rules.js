// מנוע האוטומציות — רץ מה-Cron.
// לכל כלל יש "סמן" (cursor): תאריך ההודעה הנכנסת האחרונה שטופלה. הודעות חדשות = מעבר לסמן.
// מחוץ לחלון השעות: hold = ההודעות נשמרות ונשלחות כשהחלון נפתח; skip = מדלגים עליהן.
import { all, first, run, notify } from './db.js';
import { fetchIncoming, sendSms } from './yemot.js';
import { inWindow, israelParts } from './validate.js';
import { mailSmsForward } from './email.js';
import { hmacHex } from './crypto.js';
import { resolveAccess } from './features.js';
import { logSend, usedToday } from './quota.js';

const FEATURE_FOR = { email: 'rules.email', autoreply: 'rules.autoreply', webhook: 'rules.webhook' };

function matches(rule, m) {
  if (rule.filter_keyword) {
    const words = rule.filter_keyword.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.length && !words.some((w) => m.text.toLowerCase().includes(w))) return false;
  }
  if (rule.filter_sender) {
    const senders = rule.filter_sender.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (senders.length && !senders.some((s) => m.phone.startsWith(s))) return false;
  }
  return true;
}

function newSince(rule, messages) {
  const keys = new Set(rule.cursor_keys ? JSON.parse(rule.cursor_keys) : []);
  const c = rule.cursor || '';
  return messages.filter((m) => m.time > c || (m.time === c && !keys.has(m.key)));
}

async function advance(env, rule, msgs, fired) {
  if (!msgs.length && !fired) {
    await run(env, 'UPDATE v2_rules SET last_run_at = ? WHERE id = ?', Date.now(), rule.id);
    return;
  }
  const maxTime = msgs.reduce((mx, m) => (m.time > mx ? m.time : mx), rule.cursor || '');
  const prevKeys = maxTime === rule.cursor && rule.cursor_keys ? JSON.parse(rule.cursor_keys) : [];
  const keys = [...new Set([...prevKeys, ...msgs.filter((m) => m.time === maxTime).map((m) => m.key)])].slice(-200);
  await run(env,
    `UPDATE v2_rules SET cursor = ?, cursor_keys = ?, last_run_at = ?, last_error = NULL
       ${fired ? ', last_fire_at = ?, fire_count = fire_count + 1' : ''} WHERE id = ?`,
    ...(fired ? [maxTime, JSON.stringify(keys), Date.now(), Date.now(), rule.id] : [maxTime, JSON.stringify(keys), Date.now(), rule.id]));
}

async function setError(env, rule, message) {
  const msg = String(message || 'שגיאה').slice(0, 300);
  if (!rule.last_error) {
    await notify(env, rule.user_id, { title: `האוטומציה "${rule.name}" נתקלה בשגיאה`, body: msg, link: '#/automations' });
  }
  await run(env, 'UPDATE v2_rules SET last_error = ?, last_run_at = ? WHERE id = ?', msg, Date.now(), rule.id);
}

async function fire(env, rule, system, msgs, budget) {
  const contacts = await all(env, 'SELECT phone, name FROM v2_contacts WHERE user_id = ? AND name IS NOT NULL', rule.user_id);
  const names = Object.fromEntries(contacts.map((c) => [c.phone, c.name]));

  if (rule.type === 'email') {
    budget.left -= 1;
    const res = await mailSmsForward(env, rule.target, { ruleName: rule.name, systemName: system.name, messages: msgs.slice(-60), names });
    if (!res.ok) throw new Error(res.error);
    return;
  }

  if (rule.type === 'webhook') {
    budget.left -= 1;
    const payload = JSON.stringify({
      event: 'sms.incoming', rule: { id: rule.id, name: rule.name }, system: { id: system.id, name: system.name },
      messages: msgs.map((m) => ({ phone: m.phone, name: names[m.phone] || null, text: m.text, time: m.time })),
      sent_at: new Date().toISOString(),
    });
    const sig = await hmacHex(rule.secret || '', payload);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(rule.target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SMT-Signature': `sha256=${sig}`, 'User-Agent': 'SMT-Messages-Webhook/2' }, body: payload, signal: ctrl.signal });
      if (!res.ok) throw new Error(`השרת המרוחק החזיר ${res.status}`);
    } finally { clearTimeout(t); }
    return;
  }

  if (rule.type === 'autoreply') {
    const phones = [...new Set(msgs.map((m) => m.phone))].filter((p) => /^0\d{8,9}$/.test(p)); // לא עונים לשולחים אלפאנומריים
    const cutoff = Date.now() - rule.cooldown_hours * 3600_000;
    const user = await first(env, 'SELECT * FROM v2_users WHERE id = ?', rule.user_id);
    const access = await resolveAccess(env, user);
    let used = await usedToday(env, rule.user_id);
    for (const phone of phones.slice(0, 20)) {
      if (budget.left <= 2) break;
      const last = await first(env, 'SELECT sent_at FROM v2_autoreply_log WHERE rule_id = ? AND phone = ?', rule.id, phone);
      if (last && last.sent_at > cutoff) continue;
      if (access.limits.daily_sms_limit != null && used >= access.limits.daily_sms_limit) throw new Error('המכסה היומית נוצלה — המענה האוטומטי הושהה עד מחר');
      budget.left -= 1;
      await sendSms(env, system, [phone], rule.target);
      used++;
      await run(env, 'INSERT OR REPLACE INTO v2_autoreply_log (rule_id, phone, sent_at) VALUES (?, ?, ?)', rule.id, phone, Date.now());
      await logSend(env, { userId: rule.user_id, systemId: system.id, via: 'autoreply', recipients: 1, preview: rule.target, ok: true, actor: `rule:${rule.id}` });
    }
  }
}

export async function runRules(env, { budget = { left: 20 }, onlyRuleId = null } = {}) {
  const rules = await all(env,
    `SELECT r.* FROM v2_rules r JOIN v2_users u ON u.id = r.user_id
     WHERE r.enabled = 1 AND u.status = 'active' ${onlyRuleId ? 'AND r.id = ?' : ''}
     ORDER BY COALESCE(r.last_run_at, 0) ASC`, ...(onlyRuleId ? [onlyRuleId] : []));
  const bySystem = new Map();
  for (const r of rules) {
    if (!bySystem.has(r.system_id)) bySystem.set(r.system_id, []);
    bySystem.get(r.system_id).push(r);
  }
  const accessCache = new Map();
  const stats = { systems: 0, rules: 0, fired: 0, errors: 0 };

  for (const [systemId, list] of bySystem) {
    if (budget.left <= 2) break;
    const system = await first(env, 'SELECT * FROM v2_systems WHERE id = ?', systemId);
    if (!system) continue;
    let messages;
    try {
      budget.left -= 1;
      messages = await fetchIncoming(env, system, 200);
    } catch (e) {
      for (const r of list) await setError(env, r, e.message);
      stats.errors++;
      continue;
    }
    stats.systems++;
    const blocked = new Set((await all(env, 'SELECT phone FROM v2_contacts WHERE user_id = ? AND is_blocked = 1', system.user_id)).map((c) => c.phone));

    for (const rule of list) {
      stats.rules++;
      if (!accessCache.has(rule.user_id)) {
        const user = await first(env, 'SELECT * FROM v2_users WHERE id = ?', rule.user_id);
        accessCache.set(rule.user_id, await resolveAccess(env, user));
      }
      const fresh = newSince(rule, messages);
      // אם הפיצ'ר כובה ע"י המנהל — מקדמים את הסמן בשקט כדי שלא יהיה "שטף" כשיופעל שוב
      if (!accessCache.get(rule.user_id).features[FEATURE_FOR[rule.type]]) { await advance(env, rule, fresh, false); continue; }

      const relevant = fresh.filter((m) => !blocked.has(m.phone) && matches(rule, m));
      if (!relevant.length) { await advance(env, rule, fresh, false); continue; }

      const open = inWindow(rule);
      if (!open) {
        if (rule.outside_mode === 'skip') await advance(env, rule, fresh, false);
        else await run(env, 'UPDATE v2_rules SET last_run_at = ? WHERE id = ?', Date.now(), rule.id);
        continue;
      }
      if (rule.mode === 'digest' && rule.type !== 'autoreply' && rule.last_fire_at && Date.now() - rule.last_fire_at < rule.digest_minutes * 60_000) {
        await run(env, 'UPDATE v2_rules SET last_run_at = ? WHERE id = ?', Date.now(), rule.id);
        continue; // מצטבר לסיכום הבא
      }
      try {
        await fire(env, rule, system, relevant, budget);
        await advance(env, rule, fresh, true);
        stats.fired++;
      } catch (e) {
        await setError(env, rule, e.message);
        stats.errors++;
      }
    }
  }
  return stats;
}

// דוגמה לבדיקת כלל מהממשק
export function sampleMessages() {
  const stamp = israelParts().stamp;
  return [{ phone: '0501234567', text: 'זו הודעת בדיקה מהמערכת. אם קיבלת אותה — הכלל עובד.', time: stamp, key: 'test' }];
}

export async function testFire(env, rule, system) {
  if (rule.type === 'autoreply') return { ok: true, preview: rule.target };
  await fire(env, rule, system, sampleMessages(), { left: 5 });
  return { ok: true };
}

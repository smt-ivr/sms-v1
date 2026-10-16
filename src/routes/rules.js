// ניהול אוטומציות: SMS למייל לפי שעות, מענה אוטומטי, Webhook
import { all, first, run, insertId, audit } from '../lib/db.js';
import { fail, readJson, str, toInt } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { requireFeature } from '../lib/features.js';
import { randomToken } from '../lib/crypto.js';
import { fetchIncoming } from '../lib/yemot.js';
import { israelParts } from '../lib/validate.js';
import { limit } from '../lib/ratelimit.js';
import { testFire, runRules } from '../lib/rules.js';
import { getOwnedSystem } from './systems.js';

const FEATURE_FOR = { email: 'rules.email', autoreply: 'rules.autoreply', webhook: 'rules.webhook' };
const PUBLIC = 'r.id, r.system_id, r.name, r.type, r.enabled, r.days, r.start_min, r.end_min, r.outside_mode, r.mode, r.digest_minutes, r.filter_keyword, r.filter_sender, r.target, r.secret, r.cooldown_hours, r.last_run_at, r.last_fire_at, r.fire_count, r.last_error, r.created_at';

async function readRule(ctx, body) {
  const type = ['email', 'autoreply', 'webhook'].includes(body.type) ? body.type : fail(400, 'סוג אוטומציה לא תקין.');
  await requireFeature(ctx, FEATURE_FOR[type]);
  const system = await getOwnedSystem(ctx, body.system_id);
  const name = str(body.name, 60) || ({ email: 'SMS למייל', autoreply: 'מענה אוטומטי', webhook: 'Webhook' })[type];
  const days = [...new Set(String(body.days ?? '0123456').replace(/[^0-6]/g, '').split(''))].sort().join('');
  if (!days) fail(400, 'יש לבחור לפחות יום אחד.');
  const startMin = Math.max(0, Math.min(1440, toInt(body.start_min, 0)));
  const endMin = Math.max(0, Math.min(1440, toInt(body.end_min, 1440)));
  let target = str(body.target, 1000);
  if (type === 'email') {
    const emails = target.split(/[,\s;]+/).filter(Boolean);
    if (!emails.length || emails.length > 5 || emails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) fail(400, 'נא להזין עד 5 כתובות מייל תקינות, מופרדות בפסיק.');
    target = emails.join(',');
  } else if (type === 'webhook') {
    let u;
    try { u = new URL(target); } catch { fail(400, 'כתובת ה-Webhook אינה תקינה.'); }
    if (u.protocol !== 'https:') fail(400, 'כתובת ה-Webhook חייבת להתחיל ב-https://');
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) fail(400, 'לא ניתן לשלוח לכתובת פנימית.');
  } else {
    if (!target) fail(400, 'נא לכתוב את נוסח המענה האוטומטי.');
    if (target.length > 500) fail(400, 'נוסח המענה ארוך מדי (עד 500 תווים).');
  }
  return {
    system,
    data: {
      system_id: system.id, name, type, days, start_min: startMin, end_min: endMin,
      outside_mode: body.outside_mode === 'skip' ? 'skip' : 'hold',
      mode: body.mode === 'digest' && type !== 'autoreply' ? 'digest' : 'instant',
      digest_minutes: Math.max(15, Math.min(1440, toInt(body.digest_minutes, 60))),
      filter_keyword: str(body.filter_keyword, 200) || null,
      filter_sender: str(body.filter_sender, 500) || null,
      target,
      cooldown_hours: Math.max(1, Math.min(720, toInt(body.cooldown_hours, 12))),
      enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
    },
  };
}

export default function ruleRoutes(r) {
  r.get('/api/rules', async (ctx) => {
    const user = await requireUser(ctx);
    return all(ctx.env, `SELECT ${PUBLIC}, s.name AS system_name FROM v2_rules r LEFT JOIN v2_systems s ON s.id = r.system_id WHERE r.user_id = ? ORDER BY r.id DESC`, user.id);
  });

  r.post('/api/rules', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.request);
    const { system, data } = await readRule(ctx, body);
    const n = await first(ctx.env, 'SELECT COUNT(*) AS n FROM v2_rules WHERE user_id = ?', user.id);
    if (n.n >= 30) fail(400, 'הגעת למספר המרבי של אוטומציות (30).');

    // הסמן מתחיל מההודעה האחרונה הקיימת — כדי לא לשלוח את כל ההיסטוריה
    let cursor = israelParts().stamp;
    let cursorKeys = [];
    try {
      const msgs = await fetchIncoming(ctx.env, system, 50);
      if (msgs.length) {
        const last = msgs[msgs.length - 1].time;
        if (last > cursor) cursor = last;
        cursorKeys = msgs.filter((m) => m.time === cursor).map((m) => m.key);
      }
    } catch { /* המערכת לא זמינה כרגע — נשתמש בזמן הנוכחי */ }

    const id = await insertId(ctx.env,
      `INSERT INTO v2_rules (user_id, system_id, name, type, enabled, days, start_min, end_min, outside_mode, mode, digest_minutes,
        filter_keyword, filter_sender, target, secret, cooldown_hours, cursor, cursor_keys, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, data.system_id, data.name, data.type, data.enabled, data.days, data.start_min, data.end_min, data.outside_mode, data.mode,
      data.digest_minutes, data.filter_keyword, data.filter_sender, data.target, data.type === 'webhook' ? randomToken(24) : null,
      data.cooldown_hours, cursor, JSON.stringify(cursorKeys), Date.now());
    await audit(ctx.env, { userId: user.id, actorId: user.id, action: 'rule.create', detail: { id, type: data.type }, ip: ctx.ip });
    return { ok: true, id };
  });

  r.put('/api/rules/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const existing = await first(ctx.env, 'SELECT * FROM v2_rules WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!existing) fail(404, 'האוטומציה לא נמצאה.');
    const body = await readJson(ctx.request);
    const { data } = await readRule(ctx, { ...existing, ...body });
    const resetCursor = data.system_id !== existing.system_id;
    await run(ctx.env,
      `UPDATE v2_rules SET system_id = ?, name = ?, type = ?, enabled = ?, days = ?, start_min = ?, end_min = ?, outside_mode = ?, mode = ?,
        digest_minutes = ?, filter_keyword = ?, filter_sender = ?, target = ?, cooldown_hours = ?, last_error = NULL,
        secret = COALESCE(secret, ?) ${resetCursor ? ', cursor = ?, cursor_keys = NULL' : ''} WHERE id = ?`,
      data.system_id, data.name, data.type, data.enabled, data.days, data.start_min, data.end_min, data.outside_mode, data.mode,
      data.digest_minutes, data.filter_keyword, data.filter_sender, data.target, data.cooldown_hours,
      data.type === 'webhook' ? randomToken(24) : null,
      ...(resetCursor ? [israelParts().stamp] : []), existing.id);
    return { ok: true };
  });

  r.post('/api/rules/:id/toggle', async (ctx) => {
    const user = await requireUser(ctx);
    const rule = await first(ctx.env, 'SELECT * FROM v2_rules WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!rule) fail(404, 'האוטומציה לא נמצאה.');
    if (!rule.enabled) await requireFeature(ctx, FEATURE_FOR[rule.type]);
    // בהפעלה מחדש — מתחילים מעכשיו, לא שולחים את מה שהצטבר בזמן הכיבוי
    await run(ctx.env, `UPDATE v2_rules SET enabled = ?, last_error = NULL ${rule.enabled ? '' : ', cursor = ?, cursor_keys = NULL'} WHERE id = ?`,
      rule.enabled ? 0 : 1, ...(rule.enabled ? [] : [israelParts().stamp]), rule.id);
    return { ok: true, enabled: !rule.enabled };
  });

  r.delete('/api/rules/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const id = toInt(ctx.params.id);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM v2_autoreply_log WHERE rule_id IN (SELECT id FROM v2_rules WHERE id = ? AND user_id = ?)').bind(id, user.id),
      ctx.env.DB.prepare('DELETE FROM v2_rules WHERE id = ? AND user_id = ?').bind(id, user.id),
    ]);
    return { ok: true };
  });

  r.post('/api/rules/:id/test', async (ctx) => {
    const user = await requireUser(ctx);
    await limit(ctx.env, `ruletest:${user.id}`, 10, 600);
    const rule = await first(ctx.env, 'SELECT * FROM v2_rules WHERE id = ? AND user_id = ?', toInt(ctx.params.id), user.id);
    if (!rule) fail(404, 'האוטומציה לא נמצאה.');
    const system = await getOwnedSystem(ctx, rule.system_id);
    return testFire(ctx.env, rule, system);
  });

  // הרצה מיידית של כלל (בלי לחכות ל-Cron)
  r.post('/api/rules/:id/run', async (ctx) => {
    const user = await requireUser(ctx);
    await limit(ctx.env, `rulerun:${user.id}`, 10, 600);
    const rule = await first(ctx.env, 'SELECT id FROM v2_rules WHERE id = ? AND user_id = ? AND enabled = 1', toInt(ctx.params.id), user.id);
    if (!rule) fail(404, 'האוטומציה לא נמצאה או כבויה.');
    const stats = await runRules(ctx.env, { onlyRuleId: rule.id, budget: { left: 25 } });
    const after = await first(ctx.env, 'SELECT last_error, fire_count FROM v2_rules WHERE id = ?', rule.id);
    return { ok: true, fired: stats.fired, last_error: after.last_error };
  });
}

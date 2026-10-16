// מנגנון הרשאות פיצ'רים
// סדר עדיפויות: מתג גלובלי כבוי → כבוי לכולם
//               דריסה אישית למשתמש → קובעת
//               הגדרת החבילה → קובעת
//               ברירת מחדל של הפיצ'ר
import { all, first } from './db.js';
import { fail } from './http.js';

export async function resolveAccess(env, user) {
  const [features, plan, overrides] = await Promise.all([
    all(env, 'SELECT key, label, global_enabled, default_value FROM v2_features ORDER BY sort'),
    first(env, 'SELECT * FROM v2_plans WHERE key = ?', user.plan),
    all(env, 'SELECT key, value FROM v2_user_features WHERE user_id = ?', user.id),
  ]);
  let planFeatures = {};
  try { planFeatures = plan ? JSON.parse(plan.features || '{}') : {}; } catch { planFeatures = {}; }
  const ov = Object.fromEntries(overrides.map((o) => [o.key, o.value]));
  const isAdmin = user.role === 'admin' || user.role === 'owner';

  const map = {};
  const labels = {};
  for (const f of features) {
    labels[f.key] = f.label;
    if (!f.global_enabled) { map[f.key] = false; continue; }
    if (isAdmin) { map[f.key] = true; continue; }
    if (f.key in ov) map[f.key] = !!ov[f.key];
    else if (f.key in planFeatures) map[f.key] = !!planFeatures[f.key];
    else map[f.key] = !!f.default_value;
  }

  const limits = {
    max_systems: user.max_systems ?? (plan ? plan.max_systems : 1),
    daily_sms_limit: user.daily_sms_limit ?? (plan ? plan.daily_sms_limit : null),
  };
  if (isAdmin && user.max_systems == null) limits.max_systems = 999;
  if (isAdmin && user.daily_sms_limit == null) limits.daily_sms_limit = null;

  return { features: map, labels, limits, plan: plan ? { key: plan.key, name: plan.name } : { key: user.plan, name: user.plan } };
}

export async function getAccess(ctx) {
  if (!ctx.access) ctx.access = await resolveAccess(ctx.env, ctx.user);
  return ctx.access;
}

export async function requireFeature(ctx, key) {
  const access = await getAccess(ctx);
  if (!access.features[key]) {
    const label = access.labels[key] || key;
    fail(403, `התכונה "${label}" אינה זמינה בחשבון שלך. ניתן לפנות למנהל המערכת לשדרוג.`, 'feature_disabled');
  }
}

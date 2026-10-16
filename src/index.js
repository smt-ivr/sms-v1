// S.M.T Messages V2 — נקודת הכניסה של ה-Worker
import { Router } from './router.js';
import { json, errorResponse, clientIp, fail } from './lib/http.js';
import authRoutes from './routes/auth.js';
import systemRoutes from './routes/systems.js';
import messageRoutes from './routes/messages.js';
import contactRoutes from './routes/contacts.js';
import ruleRoutes from './routes/rules.js';
import shareRoutes from './routes/shares.js';
import supportRoutes from './routes/support.js';
import developerRoutes, { CORS } from './routes/developer.js';
import adminRoutes from './routes/admin.js';
import { runCron } from './cron.js';

export const VERSION = '2.0.0';

const router = new Router();
router.get('/api/health', async (ctx) => {
  let migrated = true;
  let cron = null;
  try {
    const row = await ctx.env.DB.prepare("SELECT value FROM v2_settings WHERE key = 'cron_last_run'").first();
    cron = row ? Number(row.value) : null;
  } catch { migrated = false; }
  return { ok: migrated, version: VERSION, migrated, cron_last_run: cron };
});
authRoutes(router);
systemRoutes(router);
messageRoutes(router);
contactRoutes(router);
ruleRoutes(router);
shareRoutes(router);
supportRoutes(router);
developerRoutes(router);
adminRoutes(router);

async function handleApi(request, env, execCtx) {
  const url = new URL(request.url);
  const isPublicApi = url.pathname.startsWith('/api/v1/');
  if (isPublicApi && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const ctx = {
    request, env, url,
    ip: clientIp(request),
    waitUntil: (p) => execCtx.waitUntil(Promise.resolve(p).catch((e) => console.error('waitUntil error', e))),
    user: null, session: null, params: {},
  };
  try {
    // הגנת CSRF גלובלית לכל בקשה משנה-מצב (פרט ל-API הציבורי שעובד עם Bearer)
    if (!isPublicApi && !['GET', 'HEAD'].includes(request.method) && request.headers.get('X-Requested-With') !== 'smt2') {
      fail(403, 'בקשה לא מורשית (CSRF).', 'csrf');
    }
    return await router.handle(ctx);
  } catch (err) {
    const res = errorResponse(err);
    if (isPublicApi) for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  }
}

// תמיכה בהרצה תחת נתיב (למשל https://smti.uk/sms/v1) — BASE_PATH ב-wrangler.toml
function stripBase(request, env) {
  const base = String(env.BASE_PATH || '').trim().replace(/\/+$/, '');
  const url = new URL(request.url);
  if (!base) return { request, url };
  if (url.pathname === base) return { redirect: `${url.origin}${base}/${url.search}` };
  if (!url.pathname.startsWith(base + '/')) return { notFound: true };
  url.pathname = url.pathname.slice(base.length) || '/';
  return { request: new Request(url.toString(), request), url };
}

export default {
  async fetch(request, env, execCtx) {
    const r = stripBase(request, env);
    if (r.redirect) return Response.redirect(r.redirect, 301);
    if (r.notFound) return json({ error: 'Not found' }, 404);
    if (r.url.pathname.startsWith('/api/')) return handleApi(r.request, env, execCtx);
    if (env.ASSETS) return env.ASSETS.fetch(r.request);
    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, execCtx) {
    execCtx.waitUntil(runCron(env, event.scheduledTime).then((r) => console.log('cron', JSON.stringify(r))).catch((e) => console.error('cron failed', e)));
  },
};

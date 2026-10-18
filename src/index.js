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

async function handleApi(request, env, execCtx, base = '') {
  const url = new URL(request.url);
  const isPublicApi = url.pathname.startsWith('/api/v1/');
  if (isPublicApi && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const ctx = {
    request, env, url, base,
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

// הרצה תחת נתיב (למשל https://smti.uk/sms/v1).
// אם BASE_PATH מוגדר — משתמשים בו. אחרת מזהים אוטומטית לפי מבנה הנתיב, כך שכל Route עובד בלי הגדרות.
const PUBLIC_FILES = /\/(index\.html|guest\.html|icon\.svg|manifest\.webmanifest|404\.html)$/;

export function resolvePath(pathname, basePath) {
  const base = String(basePath || '').trim().replace(/\/+$/, '');
  if (base) {
    if (pathname === base) return { redirect: base + '/' };
    if (!pathname.startsWith(base + '/')) return { notFound: true };
    return { path: pathname.slice(base.length) || '/' };
  }
  if (pathname === '/') return { path: '/' };
  const api = pathname.indexOf('/api/');
  if (api >= 0) return { path: pathname.slice(api) };
  const assets = pathname.indexOf('/assets/');
  if (assets >= 0) return { path: pathname.slice(assets) };
  const file = pathname.match(PUBLIC_FILES);
  if (file) return { path: '/' + file[1] };
  if (pathname.endsWith('/')) return { path: '/' };                      // /sms/v1/ → האפליקציה
  if (!pathname.split('/').pop().includes('.')) return { redirect: pathname + '/' }; // /sms/v1 → /sms/v1/
  return { path: pathname };
}

function stripBase(request, env) {
  const url = new URL(request.url);
  const r = resolvePath(url.pathname, env.BASE_PATH);
  if (r.redirect) return { redirect: `${url.origin}${r.redirect}${url.search}` };
  if (r.notFound) return { notFound: true };
  const base = url.pathname.endsWith(r.path) ? url.pathname.slice(0, url.pathname.length - r.path.length) : '';
  if (r.path === url.pathname) return { request, url, base };
  url.pathname = r.path;
  return { request: new Request(url.toString(), request), url, base };
}

// Cloudflare Assets מפנה /guest.html → /guest ו-/index.html → / עם נתיב מוחלט מהשורש,
// מה שזורק את הדפדפן מחוץ לנתיב של הפרויקט. לכן עוקבים אחרי ההפניה בתוך ה-Worker ומחזירים את הקובץ ישירות.
async function serveAsset(env, request) {
  let res = await env.ASSETS.fetch(request);
  for (let hops = 0; hops < 3 && res.status >= 300 && res.status < 400; hops++) {
    const loc = res.headers.get('Location');
    if (!loc) break;
    const next = new URL(loc, request.url);
    if (next.origin !== new URL(request.url).origin) break;
    request = new Request(next.toString(), { method: request.method, headers: request.headers });
    res = await env.ASSETS.fetch(request);
  }
  return res;
}

export default {
  async fetch(request, env, execCtx) {
    const r = stripBase(request, env);
    if (r.redirect) return Response.redirect(r.redirect, 301);
    if (r.notFound) return json({ error: 'Not found' }, 404);
    if (r.url.pathname.startsWith('/api/')) return handleApi(r.request, env, execCtx, r.base);
    if (env.ASSETS) return serveAsset(env, r.request);
    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, execCtx) {
    execCtx.waitUntil(runCron(env, event.scheduledTime).then((r) => console.log('cron', JSON.stringify(r))).catch((e) => console.error('cron failed', e)));
  },
};

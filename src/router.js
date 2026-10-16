// נתב מינימלי עם פרמטרים בנתיב (/api/contacts/:id)
import { json, fail } from './lib/http.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  async handle(ctx) {
    const path = ctx.url.pathname;
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.method !== ctx.request.method) { methodMismatch = true; continue; }
      ctx.params = {};
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      const out = await r.handler(ctx);
      return out instanceof Response ? out : json(out ?? { ok: true });
    }
    if (methodMismatch) fail(405, 'Method not allowed');
    fail(404, 'נתיב API לא נמצא.');
  }
}

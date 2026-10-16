// עזרי HTTP משותפים

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

export const fail = (status, message, code) => { throw new HttpError(status, message, code); };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  return json({ error: 'שגיאת שרת פנימית. נסה שוב בעוד רגע.' }, 500);
}

export async function readJson(request, maxBytes = 1_000_000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) fail(413, 'הבקשה גדולה מדי.');
  const text = await request.text();
  if (text.length > maxBytes) fail(413, 'הבקשה גדולה מדי.');
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch {
    fail(400, 'גוף הבקשה אינו JSON תקין.');
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export const now = () => Date.now();

export function toInt(v, def = null) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function str(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

export function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0;
}

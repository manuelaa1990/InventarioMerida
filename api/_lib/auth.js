import crypto from 'node:crypto';

const COOKIE = 'inv_session';
const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 horas

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) {
    throw new Error('Falta configurar AUTH_SECRET (mínimo 16 caracteres)');
  }
  return value;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function createSessionCookie() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + MAX_AGE_SECONDS * 1000 })
  ).toString('base64url');
  const token = `${payload}.${sign(payload)}`;

  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`;
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function isValidSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || !token.includes('.')) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  let expected;
  try {
    expected = sign(payload);
  } catch {
    return false;
  }
  if (!safeEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function requireAuth(req, res) {
  if (isValidSession(req)) return true;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'Sesión no válida o expirada' }));
  return false;
}

export function checkPassword(input) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error('Falta configurar ADMIN_PASSWORD');
  if (typeof input !== 'string' || input.length === 0) return false;
  return safeEqual(input, expected);
}

/* Limitador sencillo en memoria (por instancia) para el login. */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function clientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconocido';
}

export function loginAllowed(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(ip, { start: now, count: 0 });
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

export function registerFailedLogin(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.start > WINDOW_MS) {
    attempts.set(ip, { start: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

export function clearLoginAttempts(ip) {
  attempts.delete(ip);
}

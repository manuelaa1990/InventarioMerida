import { readBody, send, handleError, HttpError, methodNotAllowed } from './_lib/http.js';
import {
  checkPassword,
  createSessionCookie,
  clearSessionCookie,
  clientIP,
  loginAllowed,
  registerFailedLogin,
  clearLoginAttempts,
  isValidSession,
} from './_lib/auth.js';

/**
 * Sesión del panel en un solo endpoint (Vercel Hobby permite máximo
 * 12 funciones por despliegue, así que login, logout y "me" comparten ruta):
 *
 *   GET    /api/login  -> { authenticated }
 *   POST   /api/login  -> inicia sesión con { password }
 *   DELETE /api/login  -> cierra sesión
 */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return send(res, 200, { authenticated: isValidSession(req) });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return send(res, 200, { ok: true });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);

  try {
    const ip = clientIP(req);
    if (!loginAllowed(ip)) {
      throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
    }

    const { password } = await readBody(req);
    if (!checkPassword(password)) {
      registerFailedLogin(ip);
      throw new HttpError(401, 'Contraseña incorrecta');
    }

    clearLoginAttempts(ip);
    res.setHeader('Set-Cookie', createSessionCookie());
    return send(res, 200, { ok: true });
  } catch (error) {
    return handleError(res, error);
  }
}

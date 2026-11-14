import { db } from '../_lib/db.js';
import { send, handleError, methodNotAllowed } from '../_lib/http.js';
import { actualizarTasas } from '../_lib/tasas.js';

/**
 * Cron diario de Vercel: mantiene al día la tasa BCV y la tasa USDT/dólar
 * físico aunque nadie entre al panel. Vercel envía el encabezado
 * `x-vercel-cron` en sus invocaciones. También se acepta
 * `Authorization: Bearer <CRON_SECRET>` si se configura.
 */
function autorizado(req) {
  if (req.headers['x-vercel-cron']) return true;
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (!autorizado(req)) {
    return send(res, 401, { error: 'No autorizado' });
  }

  try {
    const tasas = await actualizarTasas(db());
    return send(res, 200, tasas, 'no-store');
  } catch (error) {
    return handleError(res, error);
  }
}

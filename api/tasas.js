import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { send, handleError, methodNotAllowed } from './_lib/http.js';
import { getConfig } from './_lib/calc.js';
import { actualizarTasas, consultarTasas } from './_lib/tasas.js';

/**
 * GET  -> consulta BCV y USDT sin modificar la configuración.
 * POST -> consulta ambas tasas y las guarda (tasa_bcv y tasa_compra).
 *
 * La app también las actualiza automáticamente cada 6 horas y con un cron
 * diario; este endpoint se usa para el botón "Actualizar tasas ahora".
 */
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const sql = db();

  try {
    if (req.method === 'GET') {
      return send(res, 200, await consultarTasas(), 'no-store');
    }

    if (req.method === 'POST') {
      const tasas = await actualizarTasas(sql);
      return send(res, 200, { ...tasas, config: await getConfig(sql) }, 'no-store');
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}

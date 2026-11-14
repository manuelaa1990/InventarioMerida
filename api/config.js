import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { readBody, send, handleError, HttpError, methodNotAllowed } from './_lib/http.js';
import { getConfig } from './_lib/calc.js';

const KEYS = ['tasa_bcv', 'tasa_compra', 'iva_pct', 'margen_pct'];

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const sql = db();

  try {
    if (req.method === 'GET') {
      return send(res, 200, { config: await getConfig(sql) });
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const cambios = [];

      for (const key of KEYS) {
        if (body[key] === undefined) continue;
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < 0) {
          throw new HttpError(400, `El valor de ${key} no es válido`);
        }
        if ((key === 'tasa_bcv' || key === 'tasa_compra') && value <= 0) {
          throw new HttpError(400, `El valor de ${key} debe ser mayor que cero`);
        }
        cambios.push([key, value]);
      }

      if (!cambios.length) throw new HttpError(400, 'No hay valores para actualizar');

      await Promise.all(
        cambios.map(
          ([key, value]) => sql`
            insert into configuracion (clave, valor, updated_at)
            values (${key}, ${value}, now())
            on conflict (clave) do update
              set valor = excluded.valor, updated_at = now()
          `
        )
      );

      return send(res, 200, { config: await getConfig(sql) });
    }

    return methodNotAllowed(res, ['GET', 'PUT']);
  } catch (error) {
    return handleError(res, error);
  }
}

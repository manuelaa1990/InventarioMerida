import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { send, handleError, methodNotAllowed, toNumber } from './_lib/http.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const sql = db();
    const productoId = Number(req.query?.producto_id);
    const limite = Math.min(Math.max(Number(req.query?.limit) || 200, 1), 500);

    const rows = Number.isInteger(productoId) && productoId > 0
      ? await sql`
          select m.*, p.codigo, p.nombre
            from movimientos m
            left join productos p on p.id = m.producto_id
           where m.producto_id = ${productoId}
           order by m.fecha desc
           limit ${limite}
        `
      : await sql`
          select m.*, p.codigo, p.nombre
            from movimientos m
            left join productos p on p.id = m.producto_id
           order by m.fecha desc
           limit ${limite}
        `;

    return send(res, 200, {
      movimientos: rows.map((m) => ({
        ...m,
        id: Number(m.id),
        producto_id: m.producto_id === null ? null : Number(m.producto_id),
        cantidad: toNumber(m.cantidad),
        costo_unitario_usd: toNumber(m.costo_unitario_usd),
      })),
    });
  } catch (error) {
    return handleError(res, error);
  }
}

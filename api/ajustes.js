import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { readBody, send, handleError, HttpError, methodNotAllowed } from './_lib/http.js';

const TIPOS = ['entrada', 'salida', 'ajuste', 'ajuste_cero'];

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = await readBody(req);
    const productoId = Number(body.producto_id);
    const tipo = String(body.tipo || '');
    const cantidad = body.cantidad === undefined && tipo === 'ajuste_cero'
      ? 0
      : Number(body.cantidad);
    const motivo = tipo === 'ajuste_cero'
      ? 'Ajuste manual a cero'
      : typeof body.motivo === 'string' ? body.motivo.trim() : '';

    if (!Number.isInteger(productoId) || productoId <= 0) {
      throw new HttpError(400, 'Producto inválido');
    }
    if (!TIPOS.includes(tipo)) {
      throw new HttpError(400, 'Tipo inválido. Usa entrada, salida, ajuste o ajuste_cero');
    }
    if (!Number.isFinite(cantidad) || cantidad < 0) {
      throw new HttpError(400, 'La cantidad debe ser un número mayor o igual a 0');
    }
    if (tipo !== 'ajuste' && tipo !== 'ajuste_cero' && cantidad === 0) {
      throw new HttpError(400, 'La cantidad debe ser mayor que cero');
    }

    const tipoAjuste = tipo === 'ajuste_cero' ? 'ajuste' : tipo;

    const sql = db();
    const [resultado] = await sql`
      select * from ajustar_stock(${productoId}, ${tipoAjuste}, ${tipo === 'ajuste_cero' ? 0 : cantidad}, ${motivo})
    `;

    return send(res, 200, {
      ok: true,
      producto_id: Number(resultado.producto_id),
      anterior: Number(resultado.anterior),
      nuevo: Number(resultado.nuevo),
    });
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.includes('Stock insuficiente')) {
      return handleError(res, new HttpError(409, error.message));
    }
    if (typeof error?.message === 'string' && error.message.includes('no encontrado')) {
      return handleError(res, new HttpError(404, error.message));
    }
    return handleError(res, error);
  }
}

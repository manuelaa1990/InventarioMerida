import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { readBody, send, handleError, HttpError, methodNotAllowed, toNumber } from './_lib/http.js';
import { getConfig } from './_lib/calc.js';

function normalizarItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'Agrega al menos un producto a la venta');
  }

  return items.map((item, index) => {
    const productoId = Number(item.producto_id);
    const cantidad = Number(item.cantidad);
    const precio = Number(item.precio_unitario_usd);

    if (!Number.isInteger(productoId) || productoId <= 0) {
      throw new HttpError(400, `Producto inválido en la línea ${index + 1}`);
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new HttpError(400, `Cantidad inválida en la línea ${index + 1}`);
    }
    if (!Number.isFinite(precio) || precio < 0) {
      throw new HttpError(400, `Precio inválido en la línea ${index + 1}`);
    }

    return {
      producto_id: productoId,
      cantidad,
      precio_unitario_usd: precio,
    };
  });
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const sql = db();

  try {
    if (req.method === 'GET') {
      const ventas = await sql`
        select
          v.id,
          v.cliente,
          v.nota,
          v.tasa_bcv,
          v.total_usd,
          v.total_bs,
          v.total_costo_usd,
          v.utilidad_usd,
          v.fecha,
          coalesce(
            json_agg(
              json_build_object(
                'producto_id', vi.producto_id,
                'codigo', p.codigo,
                'nombre', p.nombre,
                'cantidad', vi.cantidad,
                'precio_unitario_usd', vi.precio_unitario_usd,
                'costo_unitario_usd', vi.costo_unitario_usd,
                'utilidad_usd', vi.utilidad_usd
              )
              order by vi.id
            ) filter (where vi.id is not null),
            '[]'::json
          ) as items
        from ventas v
        left join venta_items vi on vi.venta_id = v.id
        left join productos p on p.id = vi.producto_id
        group by v.id
        order by v.fecha desc
        limit 100
      `;

      return send(res, 200, {
        ventas: ventas.map((v) => ({
          ...v,
          id: Number(v.id),
          tasa_bcv: toNumber(v.tasa_bcv),
          total_usd: toNumber(v.total_usd),
          total_bs: toNumber(v.total_bs),
          total_costo_usd: toNumber(v.total_costo_usd),
          utilidad_usd: toNumber(v.utilidad_usd),
          items: (v.items || []).map((item) => ({
            ...item,
            cantidad: toNumber(item.cantidad),
            precio_unitario_usd: toNumber(item.precio_unitario_usd),
            costo_unitario_usd: toNumber(item.costo_unitario_usd),
            utilidad_usd: toNumber(item.utilidad_usd),
          })),
        })),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const items = normalizarItems(body.items);
      const cfg = await getConfig(sql);

      const tasaBcv = body.tasa_bcv === undefined ? cfg.tasa_bcv : Number(body.tasa_bcv);
      if (!Number.isFinite(tasaBcv) || tasaBcv <= 0) {
        throw new HttpError(400, 'La tasa BCV debe ser mayor que cero');
      }

      const cliente = typeof body.cliente === 'string' ? body.cliente.trim().slice(0, 160) : '';
      const nota = typeof body.nota === 'string' ? body.nota.trim().slice(0, 500) : '';

      const [venta] = await sql`
        select * from registrar_venta(
          ${cliente},
          ${nota},
          ${tasaBcv},
          ${cfg.iva_pct},
          ${JSON.stringify(items)}::jsonb
        )
      `;

      return send(res, 201, {
        venta: {
          id: Number(venta.venta_id),
          total_usd: toNumber(venta.total_usd),
          total_bs: toNumber(venta.total_bs),
          utilidad_usd: toNumber(venta.utilidad_usd),
        },
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    const message = error?.message || '';
    if (message.includes('Stock insuficiente') || message.includes('no encontrado') || message.includes('inválid')) {
      return handleError(res, new HttpError(409, message));
    }
    return handleError(res, error);
  }
}

import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { send, handleError, methodNotAllowed, toNumber } from './_lib/http.js';
import { getConfig } from './_lib/calc.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const sql = db();
    const cfg = await getConfig(sql);

    // Una sola consulta para todos los totales (menos viajes a Neon).
    // El valor a venta se calcula en SQL con la misma fórmula del Excel.
    const [resumen, bajoStock, movimientos] = await Promise.all([
      sql`
        with cfg as (
          select
            coalesce((select valor from configuracion where clave = 'tasa_bcv'), 1) as tasa_bcv,
            coalesce((select valor from configuracion where clave = 'tasa_compra'), 1) as tasa_compra,
            coalesce((select valor from configuracion where clave = 'margen_pct'), 0) as margen_global
        ),
        stats as (
          select
            count(*) filter (where p.activo) as productos,
            coalesce(sum(p.stock) filter (where p.activo), 0) as unidades,
            coalesce(sum(p.stock * p.costo_usd) filter (where p.activo), 0) as valor_costo,
            count(*) filter (where p.activo and p.stock <= p.stock_minimo) as bajos,
            count(*) filter (where p.activo and p.stock <= 0) as agotados,
            coalesce(sum(
              case when p.activo then
                p.stock * round(
                  p.costo_usd * (cfg.tasa_compra / nullif(cfg.tasa_bcv, 0))
                  * (1 + coalesce(p.margen_pct, cfg.margen_global) / 100),
                  2
                )
              else 0 end
            ), 0) as valor_venta
          from productos p, cfg
        ),
        mes as (
          select
            count(*) as cantidad,
            coalesce(sum(total_usd), 0) as total_usd,
            coalesce(sum(utilidad_usd), 0) as utilidad_usd
          from ventas
          where fecha >= date_trunc('month', now())
        ),
        hoy as (
          select
            count(*) as cantidad,
            coalesce(sum(total_usd), 0) as total_usd
          from ventas
          where fecha >= date_trunc('day', now())
        )
        select
          (select row_to_json(stats) from stats) as totales,
          (select row_to_json(mes) from mes) as ventas_mes,
          (select row_to_json(hoy) from hoy) as ventas_hoy
      `,
      sql`
        select id, codigo, nombre, stock, stock_minimo
          from productos
         where activo = true and stock <= stock_minimo
         order by stock asc, nombre
         limit 10
      `,
      sql`
        select m.id, m.tipo, m.cantidad, m.motivo, m.fecha, p.codigo, p.nombre
          from movimientos m
          left join productos p on p.id = m.producto_id
         order by m.fecha desc
         limit 10
      `,
    ]);

    const fila = resumen[0] || {};
    const t = fila.totales || {};
    const vm = fila.ventas_mes || {};
    const vh = fila.ventas_hoy || {};

    return send(res, 200, {
      config: cfg,
      totales: {
        productos: Number(t.productos || 0),
        unidades: toNumber(t.unidades),
        valor_costo_usd: toNumber(t.valor_costo),
        valor_venta_usd: toNumber(t.valor_venta),
        bajos: Number(t.bajos || 0),
        agotados: Number(t.agotados || 0),
      },
      ventas_mes: {
        cantidad: Number(vm.cantidad || 0),
        total_usd: toNumber(vm.total_usd),
        utilidad_usd: toNumber(vm.utilidad_usd),
      },
      ventas_hoy: {
        cantidad: Number(vh.cantidad || 0),
        total_usd: toNumber(vh.total_usd),
      },
      bajo_stock: bajoStock.map((p) => ({
        id: Number(p.id),
        codigo: p.codigo,
        nombre: p.nombre,
        stock: toNumber(p.stock),
        stock_minimo: toNumber(p.stock_minimo),
      })),
      movimientos: movimientos.map((m) => ({
        ...m,
        id: Number(m.id),
        cantidad: toNumber(m.cantidad),
      })),
    });
  } catch (error) {
    return handleError(res, error);
  }
}

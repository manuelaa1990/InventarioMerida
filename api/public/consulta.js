import { db } from '../_lib/db.js';
import { send, handleError, methodNotAllowed } from '../_lib/http.js';
import { getConfig, presentarProductoPublico } from '../_lib/calc.js';

/**
 * Endpoint público. Solo devuelve datos del catálogo:
 * nunca costos, márgenes ni utilidad.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const sql = db();
    const q = String(req.query?.q || '').trim().slice(0, 80);
    const limite = Math.min(Math.max(Number(req.query?.limit) || 40, 1), 100);

    const palabras = q.split(' ').filter(Boolean);
    const condiciones = palabras.map((_, index) => {
      const parametro = `$${index + 1}`;
      return `(codigo ilike ${parametro} or nombre ilike ${parametro}
              or descripcion ilike ${parametro} or presentacion ilike ${parametro}
              or categoria ilike ${parametro} or marca ilike ${parametro}
              or tags ilike ${parametro})`;
    });
    const filtroBusqueda = condiciones.length ? condiciones.join(' and ') : 'true';
    const parametros = [...palabras.map((palabra) => `%${palabra}%`), limite];

    const rows = await sql.query(`
      select *
        from productos
       where activo = true
         and (${filtroBusqueda})
       order by (stock > 0) desc, categoria, nombre
       limit $${parametros.length}
    `, parametros);

    const cfg = await getConfig(sql);

    // Solo la foto principal de cada producto (el catálogo público no necesita más).
    const ids = rows.map((row) => Number(row.id));
    const imagenes = ids.length
      ? await sql`
          select producto_id, url, alt, principal
            from producto_imagenes
           where producto_id = any(${ids}) and principal = true
        `
      : [];
    const porProducto = new Map(imagenes.map((img) => [Number(img.producto_id), [img]]));

    return send(
      res,
      200,
      {
        productos: rows.map((row) =>
          presentarProductoPublico(
            { ...row, imagenes: porProducto.get(Number(row.id)) || [] },
            cfg
          )
        ),
        tasa_bcv: cfg.tasa_bcv,
        actualizado: new Date().toISOString(),
      },
      'public, s-maxage=60, stale-while-revalidate=300'
    );
  } catch (error) {
    return handleError(res, error);
  }
}

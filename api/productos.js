import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import { readBody, send, handleError, HttpError, methodNotAllowed, toNumber } from './_lib/http.js';
import { getConfig, listaTags, presentarProducto } from './_lib/calc.js';

const TEXT_FIELDS = ['codigo', 'nombre', 'descripcion', 'presentacion', 'categoria', 'marca'];

/** Devuelve un Map producto_id -> imagenes para las filas indicadas. */
async function cargarImagenes(sql, ids) {
  const mapa = new Map();
  if (!ids.length) return mapa;

  const filas = await sql`
    select id, producto_id, url, alt, principal
      from producto_imagenes
     where producto_id = any(${ids})
     order by principal desc, id
  `;

  for (const fila of filas) {
    const clave = Number(fila.producto_id);
    if (!mapa.has(clave)) mapa.set(clave, []);
    mapa.get(clave).push(fila);
  }
  return mapa;
}

function conImagenes(row, mapa) {
  return { ...row, imagenes: mapa.get(Number(row.id)) || [] };
}

function texto(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function numeroOpcional(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Valor numérico inválido');
  return n;
}

function validar(body, { partial = false, actual = {} } = {}) {
  const datos = {};
  for (const field of TEXT_FIELDS) {
    if (body[field] !== undefined) datos[field] = texto(body[field]);
  }
  if (body.tags !== undefined) {
    datos.tags = listaTags(body.tags).join(', ').slice(0, 300);
  }

  const codigo = datos.codigo ?? actual.codigo;
  const nombre = datos.nombre ?? actual.nombre;
  if (!codigo) throw new HttpError(400, 'El código es obligatorio');
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio');

  datos.codigo = codigo.toUpperCase();

  if (body.costo_usd !== undefined) {
    const n = Number(body.costo_usd);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'El costo debe ser un número mayor o igual a 0');
    datos.costo_usd = n;
  }
  if (body.stock !== undefined) {
    const n = Number(body.stock);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'El stock debe ser un número mayor o igual a 0');
    datos.stock = n;
  }
  if (body.stock_minimo !== undefined) {
    const n = Number(body.stock_minimo);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'El stock mínimo debe ser un número mayor o igual a 0');
    datos.stock_minimo = n;
  }
  if (body.margen_pct !== undefined) datos.margen_pct = numeroOpcional(body.margen_pct);
  if (body.iva_pct !== undefined) datos.iva_pct = numeroOpcional(body.iva_pct);

  if (!partial) {
    datos.descripcion ??= '';
    datos.presentacion ??= '';
    datos.categoria ??= 'General';
    datos.marca ??= '';
    datos.tags ??= '';
    datos.costo_usd ??= 0;
    datos.stock ??= 0;
    datos.stock_minimo ??= 3;
    datos.margen_pct ??= null;
    datos.iva_pct ??= null;
  }

  return datos;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const sql = db();

  try {
    if (req.method === 'GET') {
      const cfg = await getConfig(sql);
      const rows = await sql`
        select * from productos
         where activo = true
         order by categoria, nombre
      `;
      const imagenes = await cargarImagenes(sql, rows.map((row) => Number(row.id)));
      return send(res, 200, {
        productos: rows.map((row) => presentarProducto(conImagenes(row, imagenes), cfg)),
        config: cfg,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const datos = validar(body);

      const [creado] = await sql`
        insert into productos
          (codigo, nombre, descripcion, presentacion, categoria, marca, tags,
           costo_usd, stock, stock_minimo, margen_pct, iva_pct)
        values
          (${datos.codigo}, ${datos.nombre}, ${datos.descripcion}, ${datos.presentacion},
           ${datos.categoria}, ${datos.marca}, ${datos.tags}, ${datos.costo_usd}, ${datos.stock},
           ${datos.stock_minimo}, ${datos.margen_pct}, ${datos.iva_pct})
        returning *
      `;

      if (toNumber(datos.stock) !== 0) {
        await sql`
          insert into movimientos (producto_id, tipo, cantidad, motivo)
          values (${creado.id}, 'inicial', ${datos.stock}, 'Stock inicial al crear el producto')
        `;
      }

      const cfg = await getConfig(sql);
      return send(res, 201, { producto: presentarProducto(creado, cfg) });
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de producto inválido');

      const [actual] = await sql`select * from productos where id = ${id}`;
      if (!actual) throw new HttpError(404, 'Producto no encontrado');

      const datos = validar(body, { partial: true, actual });

      const [actualizado] = await sql`
        update productos set
          codigo = ${datos.codigo ?? actual.codigo},
          nombre = ${datos.nombre ?? actual.nombre},
          descripcion = ${datos.descripcion ?? actual.descripcion},
          presentacion = ${datos.presentacion ?? actual.presentacion},
          categoria = ${datos.categoria ?? actual.categoria},
          marca = ${datos.marca ?? actual.marca},
          tags = ${datos.tags ?? actual.tags},
          costo_usd = ${datos.costo_usd ?? actual.costo_usd},
          stock_minimo = ${datos.stock_minimo ?? actual.stock_minimo},
          margen_pct = ${datos.margen_pct === undefined ? actual.margen_pct : datos.margen_pct},
          iva_pct = ${datos.iva_pct === undefined ? actual.iva_pct : datos.iva_pct},
          updated_at = now()
        where id = ${id}
        returning *
      `;

      const cfg = await getConfig(sql);
      const imagenes = await cargarImagenes(sql, [Number(actualizado.id)]);
      return send(res, 200, { producto: presentarProducto(conImagenes(actualizado, imagenes), cfg) });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id ?? (await readBody(req)).id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de producto inválido');

      const [borrado] = await sql`
        update productos set activo = false, updated_at = now()
         where id = ${id} and activo = true
        returning id
      `;
      if (!borrado) throw new HttpError(404, 'Producto no encontrado');
      return send(res, 200, { ok: true, id });
    }

    return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
  } catch (error) {
    if (error?.code === '23505') {
      return handleError(res, new HttpError(409, 'Ya existe un producto con ese código'));
    }
    if (error?.code === '23514') {
      return handleError(res, new HttpError(400, 'Los valores enviados no son válidos'));
    }
    return handleError(res, error);
  }
}

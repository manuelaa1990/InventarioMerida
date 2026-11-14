import { del, put } from '@vercel/blob';
import { db } from './_lib/db.js';
import { requireAuth } from './_lib/auth.js';
import {
  readBody,
  readRawBody,
  send,
  handleError,
  HttpError,
  methodNotAllowed,
} from './_lib/http.js';
import { optimizarImagen } from './_lib/imagen.js';

const MAX_IMAGENES = 4;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB por imagen (límite original del navegador)

const TIPOS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

function exigirBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new HttpError(
      503,
      'Faltan las fotos por configurar: crea un Blob store en Vercel y agrega BLOB_READ_WRITE_TOKEN.'
    );
  }
}

function presentarImagen(row) {
  return {
    id: Number(row.id),
    url: row.url,
    alt: row.alt || '',
    principal: Boolean(row.principal),
  };
}

function idValido(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de imagen inválido');
  return id;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const sql = db();

  try {
    /* -------------------- Subir una imagen -------------------- */
    if (req.method === 'POST') {
      const productoId = Number(req.query?.producto_id);
      if (!Number.isInteger(productoId) || productoId <= 0) {
        throw new HttpError(400, 'Falta indicar el producto');
      }

      exigirBlob();

      const contentType = String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const extension = TIPOS[contentType];
      if (!extension) {
        throw new HttpError(400, 'Formato no permitido. Usa WebP, JPG o PNG.');
      }

      const declarado = Number(req.headers['content-length']);
      if (Number.isFinite(declarado) && declarado > MAX_BYTES) {
        throw new HttpError(413, 'La imagen supera el límite de 2 MB');
      }

      const [producto] = await sql`
        select id, codigo from productos
         where id = ${productoId} and activo = true
      `;
      if (!producto) throw new HttpError(404, 'Producto no encontrado');

      const [{ total }] = await sql`
        select count(*)::int as total
          from producto_imagenes
         where producto_id = ${productoId}
      `;
      if (Number(total) >= MAX_IMAGENES) {
        throw new HttpError(409, `Máximo ${MAX_IMAGENES} imágenes por producto`);
      }

      const bytes = await readRawBody(req, MAX_BYTES);
      if (!bytes.length) throw new HttpError(400, 'La imagen está vacía');

      // Optimizar con sharp: corrige orientación, redimensiona a 600px max y convierte a webp 80%
      const optimized = await optimizarImagen(bytes);

      const carpeta = String(producto.codigo || 'producto')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'producto';

      // Subimos el archivo ya optimizado; el nombre conserva .webp
      const blob = await put(`productos/${carpeta}/foto.webp`, optimized, {
        access: 'public',
        contentType: 'image/webp',
        addRandomSuffix: true,
        cacheControlMaxAge: 60 * 60 * 24 * 365,
      });

      const [imagen] = await sql`
        insert into producto_imagenes (producto_id, url, pathname, alt, principal)
        values (${productoId}, ${blob.url}, ${blob.pathname}, '', ${Number(total) === 0})
        returning *
      `;

      return send(res, 201, { imagen: presentarImagen(imagen) });
    }

    /* -------------------- Marcar principal / editar texto -------------------- */
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const id = idValido(body.id);

      const [imagen] = await sql`select * from producto_imagenes where id = ${id}`;
      if (!imagen) throw new HttpError(404, 'Imagen no encontrada');

      if (body.alt !== undefined) {
        const alt = typeof body.alt === 'string' ? body.alt.trim().slice(0, 160) : '';
        await sql`update producto_imagenes set alt = ${alt} where id = ${id}`;
      }

      if (body.principal === true && !imagen.principal) {
        // Primero se desmarca la anterior para respetar el índice único.
        await sql`
          update producto_imagenes set principal = false
           where producto_id = ${imagen.producto_id} and principal = true
        `;
        await sql`update producto_imagenes set principal = true where id = ${id}`;
      }

      const [actualizada] = await sql`select * from producto_imagenes where id = ${id}`;
      return send(res, 200, { imagen: presentarImagen(actualizada) });
    }

    /* -------------------- Eliminar una imagen -------------------- */
    if (req.method === 'DELETE') {
      const id = idValido(req.query?.id ?? (await readBody(req)).id);

      const [imagen] = await sql`select * from producto_imagenes where id = ${id}`;
      if (!imagen) throw new HttpError(404, 'Imagen no encontrada');

      try {
        await del(imagen.pathname);
      } catch (error) {
        // Si el archivo ya no existe en Blob, igual se limpia la fila.
        console.warn('No se pudo borrar el archivo de Blob:', error?.message || error);
      }

      await sql`delete from producto_imagenes where id = ${id}`;

      // Si era la principal, la imagen más antigua pasa a serla.
      if (imagen.principal) {
        const [siguiente] = await sql`
          select id from producto_imagenes
           where producto_id = ${imagen.producto_id}
           order by creado_en, id
           limit 1
        `;
        if (siguiente) {
          await sql`update producto_imagenes set principal = true where id = ${siguiente.id}`;
        }
      }

      return send(res, 200, { ok: true, id });
    }

    return methodNotAllowed(res, ['POST', 'PUT', 'DELETE']);
  } catch (error) {
    return handleError(res, error);
  }
}
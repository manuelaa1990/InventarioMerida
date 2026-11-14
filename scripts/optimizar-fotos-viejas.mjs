import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { del, put } from '@vercel/blob';
import sharp from 'sharp';
import { optimizarImagen } from './../api/_lib/imagen.js';

const root = process.cwd();
const args = process.argv.slice(2);
const apply = args.includes('--apply');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

if (args.some((arg) => arg !== '--apply') || args.filter((arg) => arg === '--apply').length > 1) {
  console.error('Uso: node scripts/optimizar-fotos-viejas.mjs [--apply]');
  process.exit(1);
}

loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Crea .env.local con la cadena pooled de Neon.');
  process.exit(1);
}
if (apply && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Falta BLOB_READ_WRITE_TOKEN para reemplazar las imágenes en Vercel Blob.');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'inventario-hvac-optimize-images',
});

async function optimizeAll() {
  await client.connect();
  const { rows } = await client.query(
    'select id, url, pathname from producto_imagenes order by id'
  );
  console.log(`${apply ? 'Aplicando' : 'Simulación:'} ${rows.length} imagen(es).`);

  const CONCURRENCIA = 3; // Procesar de a 3 imágenes para no saturar memoria

  for (let index = 0; index < rows.length; index += CONCURRENCIA) {
    const lote = rows.slice(index, index + CONCURRENCIA);

    await Promise.all(lote.map(async (row, i) => {
      const num = index + i + 1;
      try {
        const response = await fetch(row.url);
        if (!response.ok) {
          console.warn(`[${num}/${rows.length}] #${row.id}: HTTP ${response.status}, saltando.`);
          return;
        }

        const source = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(source).metadata();
        if (metadata.format === 'webp' && metadata.width <= 600) {
          unchangedCount += 1;
          console.log(`[${num}/${rows.length}] #${row.id}: ya optimizado.`);
          return;
        }

        const optimized = await optimizarImagen(source);
        console.log(
          `[${num}/${rows.length}] #${row.id}: ${source.length} -> ${optimized.length} bytes` +
          (apply ? '' : ' (sin cambios en Blob ni en la base de datos)')
        );

        if (!apply) return;

        const blob = await put(row.pathname, optimized, {
          access: 'public',
          contentType: 'image/webp',
          addRandomSuffix: true,
          cacheControlMaxAge: 60 * 60 * 24 * 365,
        });

        try {
          const result = await client.query(
            `update producto_imagenes
                set url = $1, pathname = $2
              where id = $3 and url = $4 and pathname = $5`,
            [blob.url, blob.pathname, row.id, row.url, row.pathname]
          );
          if (result.rowCount !== 1) {
            throw new Error(`La imagen #${row.id} cambió durante la migración.`);
          }
        } catch (error) {
          try {
            await del(blob.pathname);
          } catch (cleanupError) {
            console.error(`No se pudo limpiar el Blob nuevo ${blob.pathname}:`, cleanupError.message);
          }
          throw error;
        }

        const references = await client.query(
          'select 1 from producto_imagenes where pathname = $1 limit 1',
          [row.pathname]
        );
        if (references.rowCount === 0) {
          try {
            await del(row.pathname);
          } catch (error) {
            console.warn(`No se pudo borrar el Blob antiguo ${row.pathname}:`, error.message);
          }
        }

        optimizedCount += 1;
      } catch (error) {
        console.error(`[${num}/${rows.length}] #${row.id}: ERROR - ${error.message}`);
      }
    }));
  }

  console.log(
    `Listo. ${optimizedCount} optimizada(s), ${unchangedCount} ya estaban optimizadas.` +
    (apply ? '' : ' Ejecuta con --apply para reemplazarlas.')
  );
}

try {
  await optimizeAll();
} catch (error) {
  console.error('Falló la optimización de imágenes:');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

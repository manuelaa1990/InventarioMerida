/**
 * Servidor de desarrollo local.
 *
 * Monta las mismas funciones de /api sobre un servidor HTTP de Node y
 * sirve la carpeta public/. No necesita Vercel CLI ni conexión a Vercel.
 *
 * Uso:  npm run dev   ->  http://localhost:3000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);

/* ---------- Variables de entorno ---------- */

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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

loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

/* ---------- Rutas de la API ---------- */

const rutas = {
  '/api/login': 'api/login.js',
  '/api/productos': 'api/productos.js',
  '/api/imagenes': 'api/imagenes.js',
  '/api/config': 'api/config.js',
  '/api/tasas': 'api/tasas.js',
  '/api/cron/tasa-bcv': 'api/cron/tasa-bcv.js',
  '/api/ajustes': 'api/ajustes.js',
  '/api/ventas': 'api/ventas.js',
  '/api/movimientos': 'api/movimientos.js',
  '/api/dashboard': 'api/dashboard.js',
  '/api/public/consulta': 'api/public/consulta.js',
};

const handlers = {};
for (const [ruta, archivo] of Object.entries(rutas)) {
  const modulo = await import('file:///' + path.join(root, archivo).replace(/\\/g, '/'));
  handlers[ruta] = modulo.default;
}

/* ---------- Tipos de archivo estáticos ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function servirArchivo(res, archivo) {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(archivo)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(archivo).pipe(res);
}

/* ---------- Servidor ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  const handler = handlers[url.pathname];
  if (handler) {
    req.query = Object.fromEntries(url.searchParams);
    try {
      await handler(req, res);
    } catch (error) {
      console.error(`[${req.method} ${url.pathname}]`, error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Error interno del servidor' }));
      }
    }
    return;
  }

  const relativa = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const completo = path.join(publicDir, relativa);

  if (!completo.startsWith(publicDir) || !fs.existsSync(completo) || fs.statSync(completo).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
    return;
  }

  servirArchivo(res, completo);
});

server.listen(port, () => {
  const faltantes = ['DATABASE_URL', 'ADMIN_PASSWORD', 'AUTH_SECRET'].filter((v) => !process.env[v]);
  console.log('');
  console.log(`  Panel:            http://localhost:${port}`);
  console.log(`  Consulta publica: http://localhost:${port}/consulta.html`);
  if (faltantes.length) {
    console.log('');
    console.log(`  ATENCION: faltan variables en .env.local: ${faltantes.join(', ')}`);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    console.log('');
    console.log('  AVISO: sin BLOB_READ_WRITE_TOKEN las fotos no se pueden subir en local.');
  }
  console.log('');
});

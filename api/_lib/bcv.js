import https from 'node:https';
import { HttpError } from './http.js';

/**
 * Tasa oficial del Banco Central de Venezuela.
 *
 * bcv.org.ve publica la tasa del día en el HTML de su portada, dentro de
 * `<div id="dolar">`. El certificado del sitio no valida correctamente en
 * Node, así que la lectura se hace con `rejectUnauthorized: false`: solo se
 * descarga una página pública de solo lectura, nunca se envían credenciales.
 *
 * Si el sitio del BCV no responde, se usa como respaldo la API pública
 * dolarapi.com (fuente "oficial"), que replica la tasa del BCV.
 */
const FUENTE = 'https://www.bcv.org.ve/';
const FUENTE_RESPALDO = 'https://ve.dolarapi.com/v1/dolares/oficial';
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

function descargar(url, timeoutMs = 4000, saltos = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        rejectUnauthorized: false,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (saltos >= 3) {
            reject(new Error('Demasiadas redirecciones'));
            return;
          }
          resolve(descargar(new URL(res.headers.location, url).toString(), timeoutMs, saltos + 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`El BCV respondió HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Tiempo de espera agotado al consultar el BCV'));
    });
  });
}

function aNumero(texto) {
  const valor = String(texto).trim();
  if (valor.includes(',')) {
    // Formato venezolano: 911,62430000 o 1.234,56
    return Number(valor.replace(/\./g, '').replace(',', '.'));
  }
  const puntos = valor.match(/\./g) || [];
  if (puntos.length > 1 || /\.\d{3}$/.test(valor)) {
    // Puntos de miles: 1.234.567
    return Number(valor.replace(/\./g, ''));
  }
  return Number(valor);
}

function tasaValida(valor) {
  return Number.isFinite(valor) && valor > 0 && valor <= 1e9;
}

/** Extrae la tasa y la fecha valor del HTML de bcv.org.ve. */
export function parsearTasaBcv(html) {
  const inicio = html.search(/id=["']dolar["']/i);
  const bloque = inicio >= 0 ? html.slice(inicio, inicio + 5000) : html;
  const match = bloque.match(
    /<strong[^>]*class=["'][^"']*strong-tb[^"']*["'][^>]*>\s*([\d.,]+)\s*<\/strong>/i
  );
  if (!match) return null;

  const tasa = aNumero(match[1]);
  if (!tasaValida(tasa)) return null;

  const fecha = html.match(/Fecha\s+Valor:[\s\S]{0,400}?content=["']([^"']+)["']/i);
  return { tasa, fecha_valor: fecha ? fecha[1] : null };
}

async function consultarRespaldo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const response = await fetch(FUENTE_RESPALDO, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const tasa = Number(data.promedio ?? data.venta ?? data.compra);
    if (!tasaValida(tasa)) throw new Error('La API devolvió una tasa inválida');

    return {
      tasa: Math.round(tasa * 10000) / 10000,
      fecha_valor: data.fechaActualizacion || null,
      fuente: FUENTE_RESPALDO,
      nombre: 'DolarAPI',
      oficial: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function consultarTasaBcv() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.valor;

  let valor = null;
  let errorOficial = null;

  try {
    const html = await descargar(FUENTE);
    const datos = parsearTasaBcv(html);
    if (!datos) throw new Error('No se pudo leer la tasa en el HTML del BCV');
    valor = {
      tasa: Math.round(datos.tasa * 10000) / 10000,
      fecha_valor: datos.fecha_valor,
      fuente: FUENTE,
      nombre: 'BCV',
      oficial: true,
    };
  } catch (error) {
    errorOficial = error;
  }

  if (!valor) {
    try {
      valor = await consultarRespaldo();
    } catch (error) {
      throw new HttpError(
        502,
        `No se pudo obtener la tasa BCV (${errorOficial?.message || 'BCV no disponible'}; respaldo: ${error.message}). Escribe la tasa manualmente.`
      );
    }
  }

  valor.consultado_en = new Date().toISOString();
  cache = { at: Date.now(), valor };
  return valor;
}

/** Guarda la tasa en la configuración global. */
export async function guardarTasaBcv(sql, tasa) {
  const valor = Number(tasa);
  if (!tasaValida(valor)) throw new Error('La tasa que se intentó guardar no es válida');

  await sql`
    insert into configuracion (clave, valor, updated_at)
    values ('tasa_bcv', ${valor}, now())
    on conflict (clave) do update
      set valor = excluded.valor, updated_at = now()
  `;
}

/** Consulta la tasa y la guarda. Devuelve la información de la fuente. */
export async function actualizarTasaBcv(sql) {
  const info = await consultarTasaBcv();
  await guardarTasaBcv(sql, info.tasa);
  return info;
}

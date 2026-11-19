import { toNumber } from './http.js';
import { consultarTasas, guardarTasa } from './tasas.js';

const DEFAULTS = {
  tasa_bcv: 1,
  tasa_compra: 1,
  iva_pct: 16,
  margen_pct: 15,
};

// Las tasas se refrescan solas cada 6 horas. Si alguna fuente falla, se
// reintenta como máximo cada 10 minutos para no golpearla en cada petición.
const TASA_TTL_MS = 6 * 60 * 60 * 1000;
const TASA_REINTENTO_MS = 10 * 60 * 1000;
let ultimoIntento = 0;
let refrescoEnCurso = null;

function edadMs(valor) {
  if (!valor) return Infinity;
  const ms = new Date(valor).getTime();
  return Number.isFinite(ms) ? Date.now() - ms : Infinity;
}

function fechaISO(valor) {
  if (!valor) return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

function aplicarTasas(cfg, tasas) {
  if (!tasas) return;
  if (tasas.bcv) cfg.tasa_bcv = tasas.bcv.tasa;
  if (tasas.usdt) cfg.tasa_compra = tasas.usdt.tasa;
}

async function refrescarTasasSiHaceFalta(sql, cfg, actualizadas) {
  const vencidas = Object.values(actualizadas).some((valor) => {
    const edad = edadMs(valor);
    return !Number.isFinite(edad) || edad >= TASA_TTL_MS;
  });
  if (!vencidas) return null;

  // Si otra petición ya está refrescando, comparte su resultado.
  if (refrescoEnCurso) {
    const tasas = await refrescoEnCurso;
    aplicarTasas(cfg, tasas);
    return tasas;
  }

  if (Date.now() - ultimoIntento < TASA_REINTENTO_MS) return null;
  ultimoIntento = Date.now();

  refrescoEnCurso = (async () => {
    try {
      const tasas = await consultarTasas();

      if (tasas.bcv) await guardarTasa(sql, 'tasa_bcv', tasas.bcv.tasa);
      if (tasas.usdt) await guardarTasa(sql, 'tasa_compra', tasas.usdt.tasa);

      if (tasas.bcv || tasas.usdt) {
        console.log(
          `Tasas actualizadas automáticamente: BCV ${tasas.bcv?.tasa ?? '—'} · USDT ${tasas.usdt?.tasa ?? '—'}`
        );
      }
      if (tasas.errores.length) {
        console.warn('Aviso al actualizar tasas:', tasas.errores.join(' · '));
      }

      return tasas;
    } catch (error) {
      console.warn('No se pudieron actualizar las tasas automáticamente:', error.message);
      return null;
    } finally {
      refrescoEnCurso = null;
    }
  })();

  const tasas = await refrescoEnCurso;
  aplicarTasas(cfg, tasas);
  return tasas;
}

/** Lee la configuración global y mantiene las tasas BCV/USDT actualizadas solas. */
export async function getConfig(sql) {
  const rows = await sql`select clave, valor, updated_at from configuracion`;
  const cfg = { ...DEFAULTS };
  const actualizadas = { tasa_bcv: null, tasa_compra: null };

  for (const row of rows) {
    if (row.clave in cfg) cfg[row.clave] = toNumber(row.valor, cfg[row.clave]);
    if (row.clave in actualizadas) actualizadas[row.clave] = row.updated_at;
  }

  const tasas = await refrescarTasasSiHaceFalta(sql, cfg, actualizadas);
  if (tasas?.bcv) actualizadas.tasa_bcv = tasas.bcv.consultado_en;
  if (tasas?.usdt) actualizadas.tasa_compra = tasas.usdt.consultado_en;

  cfg.tasa_bcv_actualizada = fechaISO(actualizadas.tasa_bcv);
  cfg.tasa_compra_actualizada = fechaISO(actualizadas.tasa_compra);

  const fechas = [actualizadas.tasa_bcv, actualizadas.tasa_compra]
    .map((valor) => new Date(valor).getTime())
    .filter((ms) => Number.isFinite(ms));

  cfg.tasas_actualizadas = fechas.length ? new Date(Math.max(...fechas)).toISOString() : null;
  return cfg;
}

export function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Fórmula de precio:
 *   factor          = tasa_binance / tasa_bcv
 *   precio s/IVA    = costo_usd × factor × (1 + margen/100)
 *   precio final    = precio s/IVA × (1 + IVA/100)   ← USD a tasa BCV
 *   precio Bs       = precio final × tasa_bcv
 *
 * `costo_usd` siempre está en dólares a tasa Binance (costo real de compra).
 * No se guarda ningún factor ni precio en BCV: se recalculan en cada lectura
 * con las tasas vigentes que trae `getConfig`.
 */
export function calcularProducto(producto, cfg) {
  const costoBinance = toNumber(producto.costo_usd);
  const tasaBcv = toNumber(cfg.tasa_bcv, 1) || 1;
  const tasaBinance = toNumber(cfg.tasa_compra, tasaBcv) || tasaBcv;
  const margen = toNumber(producto.margen_pct ?? cfg.margen_pct, DEFAULTS.margen_pct);
  const iva = toNumber(producto.iva_pct ?? cfg.iva_pct, DEFAULTS.iva_pct);

  const factor = tasaBinance / tasaBcv;
  const precioSinIva = costoBinance * factor * (1 + margen / 100);
  const precioFinalBcv = precioSinIva * (1 + iva / 100);
  const precioBs = precioFinalBcv * tasaBcv;

  // Utilidad real en USD: al cobrar en Bs y recomprar USDT se obtiene
  // precio_sin_iva / factor, o sea, costo × margen.
  const ingresoNetoUsd = factor > 0 ? precioSinIva / factor : 0;
  const utilidad = ingresoNetoUsd - costoBinance;
  const margenReal = ingresoNetoUsd > 0 ? (utilidad / ingresoNetoUsd) * 100 : 0;

  return {
    margen_aplicado_pct: round(margen, 2),
    iva_aplicado_pct: round(iva, 2),
    factor_cambio: round(factor, 6),
    brecha_pct: round(((tasaBinance - tasaBcv) / tasaBcv) * 100, 2),
    tasa_bcv_aplicada: round(tasaBcv, 4),
    tasa_binance_aplicada: round(tasaBinance, 4),
    precio_sin_iva_usd: round(precioSinIva, 2),
    // `precio_usd` se mantiene por compatibilidad: es el precio final en USD BCV.
    precio_usd: round(precioFinalBcv, 2),
    precio_bs: round(precioBs, 2),
    utilidad_usd: round(utilidad, 2),
    margen_real_pct: round(margenReal, 2),
  };
}

export function estadoStock(stock, stockMinimo) {
  const s = toNumber(stock);
  if (s <= 0) return 'agotado';
  if (s <= toNumber(stockMinimo)) return 'bajo';
  return 'disponible';
}

/** Convierte "nevera, split, pila" en ['nevera', 'split', 'pila']. */
export function listaTags(value) {
  if (Array.isArray(value)) value = value.join(',');
  return String(value ?? '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index);
}

/** Imágenes que vienen agregadas a la fila del producto (json_agg). */
function imagenesDeFila(row) {
  if (!Array.isArray(row.imagenes)) return [];
  return row.imagenes
    .filter((img) => img && img.url)
    .map((img) => ({
      id: Number(img.id),
      url: String(img.url),
      alt: img.alt || '',
      principal: Boolean(img.principal),
    }))
    .sort((a, b) => Number(b.principal) - Number(a.principal) || a.id - b.id);
}

/** Convierte una fila de la base de datos al objeto que consume el frontend. */
export function presentarProducto(row, cfg) {
  const calculo = calcularProducto(row, cfg);
  const imagenes = imagenesDeFila(row);
  return {
    id: Number(row.id),
    codigo: row.codigo,
    nombre: row.nombre,
    descripcion: row.descripcion || '',
    presentacion: row.presentacion || '',
    categoria: row.categoria || 'General',
    marca: row.marca || '',
    tags: listaTags(row.tags),
    costo_usd: round(row.costo_usd, 2),
    stock: toNumber(row.stock),
    stock_minimo: toNumber(row.stock_minimo),
    // Valor explícito del producto; null = usa el global.
    margen_pct: row.margen_pct === null || row.margen_pct === undefined ? null : round(row.margen_pct, 2),
    iva_pct: row.iva_pct === null || row.iva_pct === undefined ? null : round(row.iva_pct, 2),
    activo: row.activo,
    estado: estadoStock(row.stock, row.stock_minimo),
    imagenes,
    ...calculo,
    updated_at: row.updated_at,
  };
}

/** Versión pública: nunca expone costo, margen ni utilidad. */
export function presentarProductoPublico(row, cfg) {
  const p = presentarProducto(row, cfg);
  const tienePrecio = p.costo_usd > 0;
  const principal = p.imagenes.find((img) => img.principal) || p.imagenes[0] || null;
  return {
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    descripcion: p.descripcion,
    presentacion: p.presentacion,
    categoria: p.categoria,
    marca: p.marca,
    tags: p.tags,
    estado: p.estado,
    precio_disponible: tienePrecio,
    precio_usd: tienePrecio ? p.precio_usd : null,
    precio_bs: tienePrecio ? p.precio_bs : null,
    imagen: principal ? principal.url : null,
    imagen_alt: principal ? principal.alt || p.nombre : null,
  };
}

import { HttpError } from './http.js';

/**
 * Tasa de compra en USDT / dólar físico (Bs por USD).
 *
 * Fuente principal: los anuncios de Binance P2P para comprar USDT con VES.
 * Se toma la mediana de los primeros anuncios para evitar precios atípicos.
 * Respaldo: el dólar paralelo de dolarapi.com, que sigue la referencia
 * del mercado físico venezolano.
 */
const FUENTE_BINANCE = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FUENTE_PARALELO = 'https://ve.dolarapi.com/v1/dolares/paralelo';
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

function tasaValida(valor) {
  return Number.isFinite(valor) && valor > 0 && valor <= 1e9;
}

async function consultarBinance() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(FUENTE_BINANCE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      },
      body: JSON.stringify({
        asset: 'USDT',
        fiat: 'VES',
        merchantCheck: false,
        page: 1,
        payTypes: [],
        publisherType: null,
        rows: 10,
        tradeType: 'BUY',
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Binance respondió HTTP ${response.status}`);

    const data = await response.json();
    const precios = (data.data || [])
      .map((item) => Number(item?.adv?.price))
      .filter((valor) => tasaValida(valor))
      .sort((a, b) => a - b);

    if (!precios.length) throw new Error('Binance no devolvió anuncios de USDT/VES');

    const mitad = Math.floor(precios.length / 2);
    const mediana =
      precios.length % 2
        ? precios[mitad]
        : (precios[mitad - 1] + precios[mitad]) / 2;

    return {
      tasa: Math.round(mediana * 10000) / 10000,
      fecha_valor: new Date().toISOString(),
      fuente: FUENTE_BINANCE,
      nombre: 'Binance P2P',
      oficial: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function consultarParalelo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(FUENTE_PARALELO, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DolarAPI respondió HTTP ${response.status}`);

    const data = await response.json();
    const tasa = Number(data.promedio ?? data.venta ?? data.compra);
    if (!tasaValida(tasa)) throw new Error('DolarAPI devolvió una tasa inválida');

    return {
      tasa: Math.round(tasa * 10000) / 10000,
      fecha_valor: data.fechaActualizacion || null,
      fuente: FUENTE_PARALELO,
      nombre: 'Dólar paralelo',
      oficial: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function consultarTasaUsdt() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.valor;

  let valor = null;
  let errorBinance = null;

  try {
    valor = await consultarBinance();
  } catch (error) {
    errorBinance = error;
  }

  if (!valor) {
    try {
      valor = await consultarParalelo();
    } catch (error) {
      throw new HttpError(
        502,
        `No se pudo obtener la tasa USDT/paralelo (${errorBinance?.message || 'Binance no disponible'}; respaldo: ${error.message}).`
      );
    }
  }

  valor.consultado_en = new Date().toISOString();
  cache = { at: Date.now(), valor };
  return valor;
}

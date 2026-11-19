import { HttpError } from './http.js';
import { consultarTasaBcv } from './bcv.js';
import { consultarTasaUsdt } from './usdt.js';

/**
 * Tasas que usa el cálculo:
 *   tasa_bcv     = tasa oficial del BCV (Bs por USD)
 *   tasa_compra  = USDT / dólar físico (Bs por USD)
 *
 * El factor de cambio del inventario es tasa_compra / tasa_bcv.
 */

async function consultarTasas() {
  const [bcv, usdt] = await Promise.allSettled([consultarTasaBcv(), consultarTasaUsdt()]);

  return {
    bcv: bcv.status === 'fulfilled' ? bcv.value : null,
    usdt: usdt.status === 'fulfilled' ? usdt.value : null,
    errores: [
      ...(bcv.status === 'rejected' ? [`BCV: ${bcv.reason?.message || 'error'}`] : []),
      ...(usdt.status === 'rejected' ? [`USDT: ${usdt.reason?.message || 'error'}`] : []),
    ],
  };
}

export { consultarTasas };

/** Guarda una tasa en la tabla configuracion. */
export async function guardarTasa(sql, clave, tasa) {
  const valor = Number(tasa);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(`La tasa ${clave} que se intentó guardar no es válida`);
  }

  await sql`
    insert into configuracion (clave, valor, updated_at)
    values (${clave}, ${valor}, now())
    on conflict (clave) do update
      set valor = excluded.valor, updated_at = now()
  `;
}

/** Consulta ambas tasas y guarda las que se hayan podido obtener. */
export async function actualizarTasas(sql) {
  const tasas = await consultarTasas();

  if (tasas.bcv) await guardarTasa(sql, 'tasa_bcv', tasas.bcv.tasa);
  if (tasas.usdt) await guardarTasa(sql, 'tasa_compra', tasas.usdt.tasa);

  if (!tasas.bcv && !tasas.usdt) {
    throw new HttpError(
      502,
      `No se pudieron obtener las tasas. ${tasas.errores.join(' · ')}`
    );
  }

  return tasas;
}

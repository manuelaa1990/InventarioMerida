import { neon } from '@neondatabase/serverless';

let client = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Solo reintenta errores de conexión, es decir, cuando la petición
 * nunca llegó al servidor. Un timeout después de enviar la consulta
 * no se reintenta para no duplicar escrituras.
 */
function esErrorDeConexion(error) {
  const cause = error?.sourceError?.cause || error?.sourceError || error?.cause || error;
  const texto = [
    cause?.code,
    cause?.name,
    cause?.message,
    error?.message,
  ]
    .filter(Boolean)
    .join(' ');

  if (/UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(texto)) return false;
  return /ConnectTimeoutError|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(texto);
}

async function conReintento(fn, intentos = 3) {
  let ultimo;
  for (let i = 0; i < intentos; i += 1) {
    try {
      return await fn();
    } catch (error) {
      ultimo = error;
      if (!esErrorDeConexion(error) || i === intentos - 1) throw error;
      await sleep(300 * (i + 1));
    }
  }
  throw ultimo;
}

/**
 * Devuelve el cliente HTTP de Neon. La conexión se reutiliza entre
 * invocaciones "calientes" de la misma función serverless.
 */
export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Falta configurar la variable de entorno DATABASE_URL');
  }

  if (!client) {
    const sql = neon(url);
    client = Object.assign(
      (...args) => conReintento(() => sql(...args)),
      {
        query: (...args) => conReintento(() => sql.query(...args)),
        transaction: (...args) => conReintento(() => sql.transaction(...args)),
      }
    );
  }

  return client;
}

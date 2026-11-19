export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new HttpError(400, 'El cuerpo de la petición no es JSON válido');
    }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'El cuerpo de la petición no es JSON válido');
  }
}

/**
 * Lee el cuerpo binario (subida de imágenes). Vercel puede entregarlo
 * ya como Buffer; en el servidor local llega como stream.
 */
export async function readRawBody(req, maxBytes = 4 * 1024 * 1024) {
  let buffer;

  if (Buffer.isBuffer(req.body)) {
    buffer = req.body;
  } else if (typeof req.body === 'string' && req.body.length) {
    buffer = Buffer.from(req.body, 'binary');
  } else {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new HttpError(413, 'La imagen es demasiado grande');
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
  }

  if (buffer.length > maxBytes) throw new HttpError(413, 'La imagen es demasiado grande');
  return buffer;
}

export function send(res, status, data, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(data));
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  return send(res, 405, { error: `Método no permitido. Usa: ${allowed.join(', ')}` });
}

export function handleError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message =
    error instanceof HttpError
      ? error.message
      : 'Error interno del servidor. Revisa los logs de Vercel.';

  if (status >= 500) console.error(error);
  return send(res, status, { error: message });
}

export function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** Convierte los valores numeric de PostgreSQL (que llegan como texto) a número. */
export function numericFields(row, fields) {
  const copy = { ...row };
  for (const field of fields) copy[field] = toNumber(copy[field]);
  return copy;
}

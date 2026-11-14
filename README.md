# Inventario HVAC

Aplicación web de inventario, costos y ventas para un negocio de repuestos de refrigeración y aire acondicionado.

- **Panel administrativo** (`/`): productos, stock, costos, márgenes, precios en USD y bolívares, ventas y movimientos.
- **Consulta pública** (`/consulta.html`): catálogo de disponibilidad y precios referenciales. Usa un endpoint que **nunca devuelve costos, márgenes ni utilidad**.
- **Backend**: PostgreSQL en [Neon](https://neon.tech) mediante funciones serverless de Vercel. La base de datos no se expone al navegador.
- **Tasas automáticas**: la tasa oficial se consulta desde [bcv.org.ve](https://www.bcv.org.ve/) y la tasa real de compra (USDT / dólar físico) desde Binance P2P. Se refrescan cada 6 horas y con un cron diario, para que los cálculos y la consulta pública estén al día.
- **Datos iniciales**: 125 productos importados de la hoja `INFRA` del archivo `Presupuesto 28OCT26.xlsx`, con su existencia.

## Cómo funciona el cálculo de precios

La fórmula reproduce la del Excel original, con la tasa real de compra:

```text
factor          = tasa_usdt / tasa_bcv
precio_sin_iva  = costo_usd × factor × (1 + margen / 100)
precio_final    = precio_sin_iva × (1 + iva / 100)      ← precio final $ BCV
precio_bs       = precio_final × tasa_bcv
utilidad        = costo_usd × margen / 100              ← utilidad real en USD
```

> `costo_usd` es el costo real de compra en dólares a tasa Binance. No se guardan el factor ni los precios en BCV: se recalculan en cada lectura con las tasas del día.

Los costos del inventario están en USD. Como la compra real se paga en **USDT o dólar físico**, el precio se ajusta con el factor `tasa_usdt / tasa_bcv`: si el dólar paralelo está por encima del BCV, el factor sube y el precio en bolívares refleja el costo real de reponer la mercancía.

Parámetros (editables desde **Configuración**):

| Parámetro | Origen |
| --- | --- |
| Tasa BCV | Automática desde `bcv.org.ve` (respaldo: DolarAPI oficial) |
| Tasa USDT / dólar físico (`tasa_compra`) | Automática desde Binance P2P (respaldo: DolarAPI paralelo) |
| IVA | Manual, 16 % por defecto |
| Margen global | Manual, 15 % por defecto |

> Ambas tasas se pueden escribir o corregir a mano en **Configuración**. El botón **Actualizar tasas ahora** las vuelve a consultar al instante.
>
> Cada producto puede tener su propio margen e IVA. Si se dejan vacíos, se usan los valores globales.

## Estructura

```text
api/                     Funciones serverless (Vercel)
  _lib/                  Utilidades compartidas (no son rutas)
  public/consulta.js     Endpoint público y restringido
  productos.js           CRUD de productos
  imagenes.js            Fotos de producto (Vercel Blob)
  ventas.js              Registro y listado de ventas
  ajustes.js             Entradas, salidas y ajustes de stock
  movimientos.js         Historial
  config.js              Parámetros de cálculo
  tasas.js               Consulta y guarda las tasas BCV y USDT
  cron/tasa-bcv.js       Cron diario: actualiza ambas tasas
  dashboard.js           Totales del panel
  login.js               Sesión: GET / POST / DELETE (login, me y logout)
db/
  setup.sql              Esquema + datos en un solo archivo para Neon
  schema.sql             Tablas, funciones y configuración inicial
  seed.sql               125 productos de la hoja INFRA
public/
  index.html             Panel administrativo
  consulta.html          Consulta pública
  assets/                CSS y JavaScript
scripts/
  apply-db.mjs           Aplica esquema y seed contra Neon
  dev-server.mjs         Servidor local con las funciones de api/
  import-excel.py        Regenera db/seed.sql desde el Excel
```

> **Límite de Vercel Hobby:** un despliegue admite como máximo **12 funciones serverless**. Los archivos dentro de `api/_lib/` no cuentan (son utilidades compartidas), pero cada archivo de ruta sí. Hoy hay 11; si agregas una nueva ruta, consolida otra en el mismo archivo (por ejemplo, `api/login.js` maneja `GET`, `POST` y `DELETE`) para no superar el límite y romper el despliegue. El archivo `.vercelignore` excluye `api/logout.js`, `api/me.js` y `api/tasa-bcv.js`: si esas rutas antiguas siguen en el repositorio, no se despliegan ni cuentan; también puedes borrarlas.

## Puesta en marcha

### 1. Crear el proyecto en Neon

1. Crea un proyecto en [Neon](https://console.neon.tech).
2. En **Connect**, copia la cadena de conexión **pooled** (la que termina en `-pooler`).

### 2. Configurar variables de entorno

Copia `.env.example` a `.env.local` y completa:

```env
DATABASE_URL=postgresql://usuario:clave@ep-xxxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
ADMIN_PASSWORD=una-clave-larga-y-unica
AUTH_SECRET=un-secreto-aleatorio-largo
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

Genera el secreto con:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`BLOB_READ_WRITE_TOKEN` solo lo necesitas para **subir fotos en local**. En Vercel se obtiene al conectar un Blob store al proyecto (ver [Fotos de producto](#6-fotos-de-producto-vercel-blob)).

### 3. Crear las tablas y cargar los datos

**Opción A — SQL Editor de Neon (la más rápida):**

1. Abre tu proyecto en [Neon](https://console.neon.tech) y entra en **SQL Editor**.
2. Abre el archivo [`db/setup.sql`](db/setup.sql), copia **todo** su contenido y pégalo en el editor.
3. Pulsa **Run**. En unos segundos tendrás las tablas, las funciones, la configuración y los 125 productos.

> `db/setup.sql` es la unión de `db/schema.sql` + `db/seed.sql`. Se puede ejecutar más de una vez sin duplicar nada.

**Opción B — desde la terminal:**

Con `DATABASE_URL` ya definida en `.env.local`:

```bash
npm run db:apply
```

Esto aplica [`db/schema.sql`](db/schema.sql) y luego [`db/seed.sql`](db/seed.sql), y muestra un resumen del inventario. También puedes ejecutar cada paso por separado:

```bash
npm run db:schema   # solo tablas, funciones y configuración
npm run db:seed     # solo los 125 productos
npm run db:check    # solo el resumen
```

> Alternativa sin terminal: pega el contenido de `db/schema.sql` y después el de `db/seed.sql` en el **SQL Editor** de Neon.
>
> El seed solo crea productos si el código no existe, así que puedes ejecutarlo de nuevo sin duplicar el inventario.

### 4. Probar en local

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`. La primera vez te pedirá la contraseña definida en `ADMIN_PASSWORD`.

`npm run dev` levanta un servidor local propio que monta las mismas funciones de `api/`, así que no necesitas iniciar sesión en Vercel. Si prefieres el entorno exacto de Vercel, usa `npm run dev:vercel`.

### 5. Publicar en Vercel

#### Paso 1 — Repositorio en GitHub

Crea un repositorio vacío (sin README ni .gitignore) y luego, desde la carpeta del proyecto:

```bash
git remote add origin https://github.com/TU-USUARIO/inventario-hvac.git
git branch -M main
git push -u origin main
```

> El proyecto ya tiene su historial de commits, así que no necesitas subir archivos a mano.

#### Paso 2 — Importar en Vercel

1. En Vercel: **Add New → Project** → importa el repositorio.
2. **Framework Preset:** `Other`.
3. **Root Directory:** `./` (la raíz).
4. **Build Command:** déjalo vacío (activa *Override* y bórralo si aparece algo).
5. **Output Directory:** `public`.
6. **Install Command:** `npm install` (por defecto).

#### Paso 3 — Variables de entorno

Agrega las variables en **Environment Variables**, marcando Production, Preview y Development:

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | La cadena **pooled** de Neon (puedes quitarle `&channel_binding=require`) |
| `ADMIN_PASSWORD` | La misma clave que usas en local |
| `AUTH_SECRET` | El mismo secreto que está en tu `.env.local` |
| `BLOB_READ_WRITE_TOKEN` | Se genera al conectar el Blob store (siguiente sección) |

> `AUTH_SECRET` debe ser **idéntico** al de local solo si quieres reutilizar sesiones; si no, puedes generar uno nuevo. Si lo cambias, las sesiones abiertas se cierran.

#### Paso 4 — Deploy y verificación

Después del deploy, comprueba en este orden:

1. `https://TU-APP.vercel.app/consulta.html` → debe mostrar el catálogo sin precios en cero.
2. `https://TU-APP.vercel.app/` → login con `ADMIN_PASSWORD`.
3. El panel debe mostrar **125 productos y 624 unidades**. Si muestra 0, la variable `DATABASE_URL` está mal o apunta a otra rama de Neon.
4. Si el login falla con “Falta configurar AUTH_SECRET”, la variable no quedó guardada: edítala y haz **Redeploy**.

> Cada vez que cambies una variable de entorno en Vercel debes volver a desplegar para que surta efecto.

También puedes desplegar desde la terminal:

```bash
npx vercel
npx vercel --prod
```

### 6. Fotos de producto (Vercel Blob)

Las fotos se guardan en **Vercel Blob**, no en el repositorio: Vercel borra el disco en cada deploy.

1. En el proyecto de Vercel: **Storage → Create → Blob**. Elige acceso **público** (las fotos se sirven por URL).
2. Conéctalo al proyecto `inventariomerida` y marca **Add a read-write token env var** (crea `BLOB_READ_WRITE_TOKEN`).
3. Haz **Redeploy** para que las funciones reciban la variable.
4. En el panel: abre un producto → **Editar** → **Agregar foto**. Máximo 4 por producto.

El navegador reduce cada foto a WebP (máximo 1200 px de lado) antes de subirla, así que suele pesar 100–200 KB.

Para probar la subida en local, agrega el token a `.env.local` (lo puedes copiar desde Vercel → Storage → tu store → `.env.local` snippet):

```env
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

> Si tu base de datos ya existía, ejecuta en el SQL Editor de Neon solo el bloque `producto_imagenes` de [`db/schema.sql`](db/schema.sql) (o vuelve a correr `db/setup.sql`, que es idempotente).

Para normalizar fotos ya cargadas, ejecuta `npm run images:optimize` primero para simular la migración. Si el resultado es correcto, `npm run images:optimize -- --apply` sube las versiones WebP 400x400, actualiza sus filas y elimina los blobs antiguos que ya no estén referenciados. Requiere `DATABASE_URL` y `BLOB_READ_WRITE_TOKEN` en el entorno o en `.env.local`.

### 7. TAGs de búsqueda

Los productos tienen un campo **TAGs de búsqueda** (editable en el modal del producto). Sirve para que un cliente encuentre un repuesto aunque use un nombre distinto al del inventario: por ejemplo, `nevera`, `refrigerador`, `bimetales`, `pila`, `caucho`.

- Se escriben separados por coma. El servidor los guarda en minúsculas, sin repetidos.
- La consulta pública busca en código, nombre, descripción, presentación, categoría **y TAGs**.
- Los TAGs también funcionan en el buscador del panel, en el buscador de ventas y en la exportación CSV.
- La consulta pública ya no muestra los botones de categorías: se busca escribiendo en la barra.

La columna se agrega sola al ejecutar `db/setup.sql` o `db/schema.sql` (usa `alter table ... add column if not exists`).

### 8. Marca del producto

Cada producto tiene un campo **Marca** (opcional, editable en el modal y justo debajo del nombre). Se muestra como distintivo en la tarjeta de la consulta pública y también se incluye en el buscador del panel, el de ventas, el catálogo público y la exportación CSV.

La columna se agrega sola al ejecutar `db/setup.sql` o `db/schema.sql`; si prefieres hacerlo a mano en Neon:

```sql
alter table productos add column if not exists marca text not null default '';
```

### 9. Tasas automáticas (BCV y USDT)

Las dos tasas se mantienen al día **solas**, sin que nadie tenga que escribirlas:

1. **Al usar la aplicación:** cada vez que se lee la configuración (panel o consulta pública), si alguna de las tasas guardadas tiene más de **6 horas**, el servidor consulta las fuentes y guarda las nuevas antes de calcular los precios.
2. **Cron diario en Vercel:** [`vercel.json`](vercel.json) programa `/api/cron/tasa-bcv` todos los días a las 22:00 UTC (18:00 en Venezuela), después de que el BCV publica la tasa.
3. **Botón de respaldo:** en *Configuración* → **Actualizar tasas ahora** fuerza la consulta al instante.

| Tasa | Fuente principal | Respaldo |
| --- | --- | --- |
| `tasa_bcv` (oficial) | Scraping de `bcv.org.ve` | `ve.dolarapi.com/v1/dolares/oficial` |
| `tasa_compra` (USDT / dólar físico) | Binance P2P: mediana de los anuncios BUY USDT/VES | `ve.dolarapi.com/v1/dolares/paralelo` |

Detalles técnicos:

- `GET /api/tasas` consulta ambas tasas sin modificar la configuración.
- `POST /api/tasas` las consulta y las aplica a la configuración.
- La respuesta de `/api/tasas` incluye `bcv`, `usdt` y la lista `errores` de las fuentes que fallaron.
- Si una fuente falla, la otra se guarda igual y la aplicación sigue usando la última tasa conocida de la que falló.
- La lectura de cada fuente se cachea 10 minutos por instancia para no golpear los sitios.
- El certificado de `bcv.org.ve` no valida correctamente en Node, por eso la petición usa `rejectUnauthorized: false`. Solo se descarga la portada pública; no se envían credenciales. Binance y DolarAPI se consultan por HTTPS normal.
- La tasa de compra es la mediana de los anuncios, no el primero: así se evitan ofertas atípicas de montos muy altos o muy bajos.

> La tasa del BCV suele publicarse por la tarde con valor para el día siguiente. Después de actualizarla, espera hasta 60 segundos para que la consulta pública muestre los precios nuevos (caché `s-maxage`).

> El cron de Vercel requiere que el proyecto esté desplegado con el `vercel.json` actualizado. En el plan Hobby los cron se ejecutan una vez al día, que es suficiente para estas tasas.

> **Sobre la tasa USDT:** Binance P2P refleja el precio al que se compra USDT con bolívares. Es una referencia del mercado, no una tasa oficial; si tu operación real es distinta, escribe el valor en **Configuración**. El respaldo de dólar paralelo puede variar unos puntos respecto a Binance.

## Seguridad

- `DATABASE_URL` solo existe en las funciones serverless. El navegador nunca se conecta directamente a Neon.
- El panel usa una cookie de sesión `HttpOnly`, firmada con HMAC y con expiración de 8 horas.
- El login tiene un límite básico de intentos por IP.
- La consulta pública usa un endpoint propio que devuelve únicamente código, nombre, descripción, categoría, TAGs, presentación, estado, precios de venta y la URL de la foto principal.
- Los productos desactivados desaparecen del inventario y de la consulta pública.
- Las ventas y los ajustes se ejecutan con funciones SQL atómicas: no se puede dejar stock negativo.
- **Nunca** subas `.env.local` ni compartas `DATABASE_URL`, `ADMIN_PASSWORD`, `AUTH_SECRET` o `BLOB_READ_WRITE_TOKEN`.

## Datos del Excel

- Se importó la hoja **INFRA**: código, nombre, descripción, presentación, existencia y categoría inferida por el prefijo del código.
- El Excel solo trae costo para `TER993`; el resto quedó en `0` para que los actualices desde el panel.
- Los productos sin costo se marcan como **Sin costo** en el panel y muestran **Consultar precio** en la consulta pública, para no publicar precios en cero.
- La hoja **MAXWELL** es una cotización de proveedor con códigos distintos; no se mezcló con el inventario para evitar duplicados.

## Próximos pasos sugeridos

- Importación masiva de costos desde CSV/Excel.
- Reportes de ventas por período y utilidad.
- Múltiples usuarios con roles (administrador / vendedor).
- Historial de precios y costo promedio ponderado.
- Códigos de barras y etiquetas.
- Comprobantes de venta en PDF.

## Regenerar el seed

Si cambia el Excel:

```bash
python scripts/import-excel.py "C:\ruta\Presupuesto 28OCT26.xlsx"
```

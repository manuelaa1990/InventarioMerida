/**
 * Aplica el esquema y los datos iniciales contra Neon.
 *
 * Uso:
 *   node scripts/apply-db.mjs            (esquema + seed + resumen)
 *   node scripts/apply-db.mjs --schema   (solo esquema)
 *   node scripts/apply-db.mjs --seed     (solo datos)
 *   node scripts/apply-db.mjs --check    (solo resumen)
 *
 * Lee DATABASE_URL desde .env.local, .env o el entorno.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const root = process.cwd();
const args = new Set(process.argv.slice(2));

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

loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Crea .env.local con la cadena pooled de Neon.');
  process.exit(1);
}

const onlySchema = args.has('--schema');
const onlySeed = args.has('--seed');
const onlyCheck = args.has('--check');
const runSchema = onlySchema || (!onlySeed && !onlyCheck);
const runSeed = onlySeed || (!onlySchema && !onlyCheck);

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  application_name: 'inventario-hvac-setup',
});

try {
  await client.connect();
  console.log('Conectado a Neon.');

  if (runSchema) {
    const schema = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('Esquema aplicado correctamente.');
  }

  if (runSeed) {
    const seed = fs.readFileSync(path.join(root, 'db', 'seed.sql'), 'utf8');
    await client.query(seed);
    console.log('Datos iniciales aplicados correctamente.');
  }

  const resumen = await client.query(`
    select
      count(*)::int as productos,
      coalesce(sum(stock), 0)::int as unidades,
      count(*) filter (where stock <= stock_minimo)::int as alertas,
      count(*) filter (where costo_usd > 0)::int as con_costo
    from productos
    where activo = true
  `);

  const config = await client.query('select clave, valor from configuracion order by clave');
  const r = resumen.rows[0];

  console.log('');
  console.log('Resumen:');
  console.log(`  Productos activos: ${r.productos}`);
  console.log(`  Unidades en stock: ${r.unidades}`);
  console.log(`  Alertas de stock:  ${r.alertas}`);
  console.log(`  Productos con costo: ${r.con_costo}`);
  console.log('  Configuración: ' + config.rows.map((row) => `${row.clave}=${Number(row.valor)}`).join(' · '));
} catch (error) {
  console.error('Error al aplicar la base de datos:');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

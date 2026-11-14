-- ============================================================
--  Inventario HVAC - esquema para Neon (PostgreSQL)
--  Ejecutar una sola vez en el SQL Editor de Neon.
-- ============================================================

-- ------------------------------------------------------------
-- Productos
-- ------------------------------------------------------------
create table if not exists productos (
  id            bigserial primary key,
  codigo        text not null unique,
  nombre        text not null,
  descripcion   text not null default '',
  presentacion  text not null default '',
  categoria     text not null default 'General',
  -- Fabricante o marca comercial del repuesto.
  marca         text not null default '',
  -- Etiquetas libres para búsquedas (separadas por coma).
  tags          text not null default '',
  costo_usd     numeric(12,4) not null default 0 check (costo_usd >= 0),
  stock         numeric(12,3) not null default 0 check (stock >= 0),
  stock_minimo  numeric(12,3) not null default 3 check (stock_minimo >= 0),
  -- Si se dejan en NULL se usan los valores globales de configuración.
  margen_pct    numeric(6,2) check (margen_pct >= 0),
  iva_pct       numeric(6,2) check (iva_pct >= 0),
  activo        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Migración para bases creadas antes de la columna marca.
alter table productos add column if not exists marca text not null default '';

-- Migración para bases creadas antes de los TAGs de búsqueda.
alter table productos add column if not exists tags text not null default '';

create index if not exists productos_codigo_idx on productos (codigo);
create index if not exists productos_activo_idx on productos (activo);

-- ------------------------------------------------------------
-- Imagenes de producto (archivos en Vercel Blob)
-- ------------------------------------------------------------
create table if not exists producto_imagenes (
  id           bigserial primary key,
  producto_id  bigint not null references productos(id) on delete cascade,
  url          text not null,
  pathname     text not null,
  alt          text not null default '',
  principal    boolean not null default false,
  creado_en    timestamptz not null default now()
);

create index if not exists producto_imagenes_producto_idx on producto_imagenes (producto_id);

-- Solo puede haber una imagen principal por producto.
create unique index if not exists producto_imagenes_principal_idx
  on producto_imagenes (producto_id)
  where principal;

-- ------------------------------------------------------------
-- Ventas
-- ------------------------------------------------------------
create table if not exists ventas (
  id               bigserial primary key,
  cliente          text not null default '',
  nota             text not null default '',
  tasa_bcv         numeric(14,4) not null,
  total_usd        numeric(14,4) not null default 0,
  total_bs         numeric(18,4) not null default 0,
  total_costo_usd  numeric(14,4) not null default 0,
  utilidad_usd     numeric(14,4) not null default 0,
  fecha            timestamptz not null default now()
);

create index if not exists ventas_fecha_idx on ventas (fecha desc);

create table if not exists venta_items (
  id                  bigserial primary key,
  venta_id            bigint not null references ventas(id) on delete cascade,
  producto_id         bigint references productos(id) on delete set null,
  cantidad            numeric(12,3) not null check (cantidad > 0),
  precio_unitario_usd numeric(12,4) not null,
  costo_unitario_usd  numeric(12,4) not null default 0,
  utilidad_usd        numeric(14,4) not null default 0
);

create index if not exists venta_items_venta_idx on venta_items (venta_id);

-- ------------------------------------------------------------
-- Movimientos de inventario (auditoría)
-- ------------------------------------------------------------
create table if not exists movimientos (
  id                  bigserial primary key,
  producto_id         bigint references productos(id) on delete cascade,
  tipo                text not null check (tipo in ('inicial','entrada','salida','ajuste','venta')),
  cantidad            numeric(12,3) not null,
  motivo              text not null default '',
  referencia          text not null default '',
  costo_unitario_usd  numeric(12,4) not null default 0,
  fecha               timestamptz not null default now()
);

create index if not exists movimientos_fecha_idx on movimientos (fecha desc);
create index if not exists movimientos_producto_idx on movimientos (producto_id);

-- ------------------------------------------------------------
-- Configuración global de cálculo
-- ------------------------------------------------------------
create table if not exists configuracion (
  clave      text primary key,
  valor      numeric(18,6) not null,
  updated_at timestamptz not null default now()
);

insert into configuracion (clave, valor) values
  ('tasa_bcv',    904.44),
  ('tasa_compra', 1020),
  ('iva_pct',      16),
  ('margen_pct',   15)
on conflict (clave) do nothing;

-- ------------------------------------------------------------
-- Venta atómica: descuenta stock y registra movimientos.
-- p_items = [{"producto_id":1,"cantidad":2,"precio_unitario_usd":1.35}]
-- ------------------------------------------------------------
create or replace function registrar_venta(
  p_cliente  text,
  p_nota     text,
  p_tasa_bcv numeric,
  p_iva_pct  numeric,
  p_items    jsonb
)
returns table (venta_id bigint, total_usd numeric, total_bs numeric, utilidad_usd numeric)
language plpgsql
as $$
declare
  v_id       bigint;
  v_total    numeric := 0;
  v_costo    numeric := 0;
  v_utilidad numeric := 0;
  v_nombre   text;
  v_stock    numeric;
  v_costo_u  numeric;
  v_util     numeric;
  it         record;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;
  if p_tasa_bcv is null or p_tasa_bcv <= 0 then
    raise exception 'La tasa BCV debe ser mayor que cero';
  end if;

  insert into ventas (cliente, nota, tasa_bcv)
  values (coalesce(p_cliente, ''), coalesce(p_nota, ''), p_tasa_bcv)
  returning id into v_id;

  for it in
    select * from jsonb_to_recordset(p_items)
      as x(producto_id bigint, cantidad numeric, precio_unitario_usd numeric)
     order by producto_id
  loop
    if it.cantidad is null or it.cantidad <= 0 then
      raise exception 'Cantidad inválida para el producto %', it.producto_id;
    end if;
    if it.precio_unitario_usd is null or it.precio_unitario_usd < 0 then
      raise exception 'Precio inválido para el producto %', it.producto_id;
    end if;

    select nombre, stock, costo_usd
      into v_nombre, v_stock, v_costo_u
      from productos
     where id = it.producto_id and activo
       for update;

    if not found then
      raise exception 'Producto % no encontrado o inactivo', it.producto_id;
    end if;
    if v_stock < it.cantidad then
      raise exception 'Stock insuficiente para % (disponible: %)', v_nombre, v_stock;
    end if;

    update productos
       set stock = stock - it.cantidad,
           updated_at = now()
     where id = it.producto_id;

    v_util := (it.precio_unitario_usd / (1 + coalesce(p_iva_pct, 0) / 100) - v_costo_u) * it.cantidad;

    insert into venta_items
      (venta_id, producto_id, cantidad, precio_unitario_usd, costo_unitario_usd, utilidad_usd)
    values
      (v_id, it.producto_id, it.cantidad, it.precio_unitario_usd, v_costo_u, v_util);

    insert into movimientos
      (producto_id, tipo, cantidad, motivo, referencia, costo_unitario_usd)
    values
      (it.producto_id, 'venta', -it.cantidad, 'Venta #' || v_id, 'venta:' || v_id, v_costo_u);

    v_total    := v_total + (it.cantidad * it.precio_unitario_usd);
    v_costo    := v_costo + (it.cantidad * v_costo_u);
    v_utilidad := v_utilidad + v_util;
  end loop;

  update ventas
     set total_usd       = v_total,
         total_bs        = v_total * p_tasa_bcv,
         total_costo_usd = v_costo,
         utilidad_usd    = v_utilidad
   where id = v_id;

  return query select v_id, v_total, v_total * p_tasa_bcv, v_utilidad;
end;
$$;

-- ------------------------------------------------------------
-- Ajuste atómico de stock (entrada, salida o ajuste a valor final)
-- ------------------------------------------------------------
create or replace function ajustar_stock(
  p_producto_id bigint,
  p_tipo        text,
  p_cantidad    numeric,
  p_motivo      text default ''
)
returns table (producto_id bigint, anterior numeric, nuevo numeric)
language plpgsql
as $$
declare
  v_ant    numeric;
  v_nuevo  numeric;
  v_nombre text;
begin
  if p_tipo not in ('entrada', 'salida', 'ajuste') then
    raise exception 'Tipo de movimiento inválido: %', p_tipo;
  end if;

  select stock, nombre into v_ant, v_nombre
    from productos where id = p_producto_id and activo
     for update;

  if not found then
    raise exception 'Producto no encontrado o inactivo';
  end if;

  if p_tipo = 'entrada' then
    v_nuevo := v_ant + p_cantidad;
  elsif p_tipo = 'salida' then
    v_nuevo := v_ant - p_cantidad;
  else
    v_nuevo := p_cantidad;
  end if;

  if v_nuevo < 0 then
    raise exception 'Stock insuficiente para % (disponible: %)', v_nombre, v_ant;
  end if;

  update productos
     set stock = v_nuevo, updated_at = now()
   where id = p_producto_id;

  insert into movimientos (producto_id, tipo, cantidad, motivo)
  values (p_producto_id, p_tipo, v_nuevo - v_ant, coalesce(p_motivo, ''));

  return query select p_producto_id, v_ant, v_nuevo;
end;
$$;

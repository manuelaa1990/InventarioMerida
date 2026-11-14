-- ============================================================
--  Inventario HVAC - instalacion completa para Neon
--  Pega TODO este archivo en el SQL Editor de Neon y ejecutalo.
--  Incluye: tablas, funciones, configuracion y 125 productos.
--  Se puede ejecutar mas de una vez sin duplicar datos.
-- ============================================================

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

-- ============================================================
--  Datos iniciales
-- ============================================================

-- Datos iniciales generados desde la hoja INFRA del Excel.
-- Archivo origen: Presupuesto 28OCT26.xlsx
-- Productos: 125

insert into productos
  (codigo, nombre, descripcion, presentacion, categoria, costo_usd, stock, stock_minimo)
values
  ('TER993', 'TERMINAL HEMBRA AMARILLO', 'TERMINAL PARA CONEXIONES HEMBRA CABLE 14al10', 'PAQ DE 10 U', 'Terminales', 0.9000, 2.000, 3.000),
  ('TER1094', 'TERMINAL BANDERA (100u)', '', '', 'Terminales', 0.0000, 2.000, 3.000),
  ('VAR1103', 'VARILLA DE BRONCE REVESTIDA', '', '', 'Varillas', 0.0000, 10.000, 3.000),
  ('VAR1104', 'VARILLA ALUMINIO FUNDENTE', '', '', 'Varillas', 0.0000, 10.000, 3.000),
  ('ROL648', 'ROLINERA 6000-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL448', 'ROLINERA 608-2RS', '', '', 'Rolineras', 0.0000, 10.000, 3.000),
  ('ROL649', 'ROLINERA 6200-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL449', 'ROLINERA 6201-2RS', '', '', 'Rolineras', 0.0000, 10.000, 3.000),
  ('ROL650', 'ROLINERA 6201 X 1/2', '', '', 'Rolineras', 0.0000, 10.000, 3.000),
  ('ROL651', 'ROLINERA 6202-2RS', '', '', 'Rolineras', 0.0000, 10.000, 3.000),
  ('ROL652', 'ROLINERA 6202 X 1/2', '', '', 'Rolineras', 0.0000, 10.000, 3.000),
  ('ROL653', 'ROLINERA 6203-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL654', 'ROLINERA 6203 X 5/8', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL910', 'ROLINERA 6006-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL911', 'ROLINERA 6001-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL912', 'ROLINERA 606-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL913', 'ROLINERA 607-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL914', 'ROLINERA 6202 X 5/8', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL915', 'ROLINERA 6204-2RS', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL916', 'ROLINERA 6205', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('ROL1113', 'ROLINERA 6205 CON RACHET', '', '', 'Rolineras', 0.0000, 0.000, 3.000),
  ('CAP434', 'CAPACITOR 5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1126', 'CAPACITOR 6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP433', 'CAPACITOR 7,5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP432', 'CAPACITOR 10uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1202', 'CAPACITOR 12,5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP431', 'CAPACITOR 15uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP640', 'CAPACITOR 20uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP430', 'CAPACITOR 25uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP411', 'CAPACITOR 30uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP412', 'CAPACITOR 35uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP413', 'CAPACITOR 40uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP414', 'CAPACITOR 45uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP415', 'CAPACITOR 50uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP416', 'CAPACITOR 55uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP417', 'CAPACITOR 60uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP418', 'CAPACITOR 70uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP419', 'CAPACITOR 80uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1074', 'CAPACITOR 30+5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1075', 'CAPACITOR 35+5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1076', 'CAPACITOR 40+5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1077', 'CAPACITOR 45+5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP1203', 'CAPACITOR 50+5uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP849', 'CAPACITOR 30+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP850', 'CAPACITOR 35+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP851', 'CAPACITOR 40+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP852', 'CAPACITOR 45+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP853', 'CAPACITOR 50+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP854', 'CAPACITOR 55+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('CAP855', 'CAPACITOR 60+6uF 450V', '', '', 'Capacitores', 0.0000, 5.000, 3.000),
  ('BIM890', 'L45', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM487', 'L50', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM909', 'L55', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM488', 'L60', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM489', 'L70', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM781', 'BOLSITA NEGRO/MARRON', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM986', 'BOLSITA ROJO/AZUL', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM987', 'BOLSITA NARANJA', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM782', 'BOLSITA LG MARRON/NARANJA/AZUL/ROJO', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM783', 'BOLSITA SAMSUNG 2CONECTOR', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('BIM784', 'BOLSITA LG ROJO/NARANJA/MARRN', '', '', 'Bimetales', 0.0000, 10.000, 3.000),
  ('REL772', 'MABE TMDJ621ZH9 6H21M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL723', 'MABE TMDJX21RB9 10H21M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL871', 'MABE TMDJX35RB9 10H35M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL724', 'MABE TMDJ625RN9 6H25M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL725', 'ASIATICA TMDE625ZF1 6H25M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL872', 'ASIATICA TMDE807KA1 8H7M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL492', 'RELOJ 6H21M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL493', 'RELOJ 8H20M', '', '', 'Relojes y timers', 0.0000, 5.000, 3.000),
  ('REL767', 'MULTIHORAS 4-12 UET120', '', '', 'Relojes y timers', 0.0000, 0.000, 3.000),
  ('REL870', 'MULTIHORAS 4-12 UET220', '', '', 'Relojes y timers', 0.0000, 0.000, 3.000),
  ('REL875', 'PROGRAMABLE 4-12 110V', '', '', 'Relojes y timers', 0.0000, 0.000, 3.000),
  ('REL873', 'KOREANO 6H40M', '', '', 'Relojes y timers', 0.0000, 0.000, 3.000),
  ('REL874', 'MABE DHKA-625-1 6H25M', '', '', 'Relojes y timers', 0.0000, 0.000, 3.000),
  ('RES735', '10"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES736', '12"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES737', '13"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES738', '14"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES739', '15"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES740', '16"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES741', '17"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES742', '18"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES743', '19"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES744', '20"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES745', '22"', '', '', 'Resistencias', 0.0000, 5.000, 3.000),
  ('RES1121', 'MABE 33CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES1122', 'MABE 36CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES827', 'MABE 38CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES828', 'MABE 41CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES829', 'MABE 46CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES746', 'MABE 52CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES747', 'MABE 56CM', '', '', 'Resistencias', 0.0000, 3.000, 3.000),
  ('RES1183', 'GH-261', '', '', 'Resistencias', 0.0000, 0.000, 3.000),
  ('RES1184', 'GH-264', '', '', 'Resistencias', 0.0000, 0.000, 3.000),
  ('RES1185', 'GH-306', '', '', 'Resistencias', 0.0000, 0.000, 3.000),
  ('VAL480', 'VALVULAS DE SERVICIO', '', '', 'Válvulas', 0.0000, 20.000, 3.000),
  ('VAL876', 'RESTRICTORA 12K', '', '', 'Válvulas', 0.0000, 5.000, 3.000),
  ('VAL877', 'RESTRICTORA 18K', '', '', 'Válvulas', 0.0000, 5.000, 3.000),
  ('VAL878', 'RESTRICTORA 24K', '', '', 'Válvulas', 0.0000, 5.000, 3.000),
  ('VAL1095', 'RESTRICTORA 36K', '', '', 'Válvulas', 0.0000, 0.000, 3.000),
  ('VAL1096', 'RESTRICTORA 60K', '', '', 'Válvulas', 0.0000, 0.000, 3.000),
  ('FIL491', 'NEVERA 15G', '', '', 'Filtros', 0.0000, 10.000, 3.000),
  ('FIL482', 'HERCULES 25G', '', '', 'Filtros', 0.0000, 10.000, 3.000),
  ('FIL826', 'HERCULES 30G', '', '', 'Filtros', 0.0000, 0.000, 3.000),
  ('FIL991', 'NEVERA 15G CON VALVULA', '', '', 'Filtros', 0.0000, 10.000, 3.000),
  ('FIL1101', 'NEVERA 25G CON VALVULA', '', '', 'Filtros', 0.0000, 10.000, 3.000),
  ('FIL494', 'AIRE 2 SALIDAS', '', '', 'Filtros', 0.0000, 10.000, 3.000),
  ('FIL479', 'AIRE 3 SALIDAS', '', '', 'Filtros', 0.0000, 10.000, 3.000),
  ('FIL989', 'AIRE 4 SALIDAS', '', '', 'Filtros', 0.0000, 0.000, 3.000),
  ('FIL1102', 'AIRE 5 SALIDAS', '', '', 'Filtros', 0.0000, 0.000, 3.000),
  ('FIL990', 'AIRE 6 SALIDAS', '', '', 'Filtros', 0.0000, 0.000, 3.000),
  ('STAR490', 'STARKIT SPP5 220', '', '', 'Starkit', 0.0000, 3.000, 3.000),
  ('REL049', 'RELEE AMERICOL 4 PIN', '', '', 'Relojes y timers', 0.0000, 3.000, 3.000),
  ('TUB1013', 'TUBERIA FLEX 3/16 15M', '', '', 'Tubería', 0.0000, 1.000, 3.000),
  ('PRO478', 'TERMICO 1/6 ELEC', '', '', 'Protectores', 0.0000, 20.000, 3.000),
  ('PRO477', 'TERMICO 1/4 ELEC', '', '', 'Protectores', 0.0000, 20.000, 3.000),
  ('TEI385', 'TEIPE COBRA 3/4 10M', '', '', 'Cintas', 0.0000, 10.000, 3.000),
  ('TEI343', 'TEIPE COBRA 3/4 18M', '', '', 'Cintas', 0.0000, 0.000, 3.000),
  ('JUE542', 'CABLES MULTIMETRO', '', '', 'Herramientas', 0.0000, 5.000, 3.000),
  ('EXT151', 'EXTRACTOR GUSANILLO LAPIZ', '', '', 'Herramientas', 0.0000, 5.000, 3.000),
  ('PEG453', 'PEGA TANKE 24U', '', '', 'Químicos', 0.0000, 0.000, 3.000),
  ('ENC551', 'ENCHUFE METAL3P GATO', '', '', 'Eléctrico', 0.0000, 5.000, 3.000),
  ('ENC556', 'ENCHUFE OJO CHINO 3P', '', '', 'Eléctrico', 0.0000, 5.000, 3.000),
  ('ENC1056', 'ENCHUFE METAL 2P', '', '', 'Eléctrico', 0.0000, 5.000, 3.000),
  ('ORI1084', 'ORING 250PIEZAS', '', '', 'Orings', 0.0000, 2.000, 3.000)
on conflict (codigo) do nothing;

-- Movimiento de carga inicial para los productos con existencia.
insert into movimientos (producto_id, tipo, cantidad, motivo, referencia)
select p.id, 'inicial', p.stock, 'Carga inicial desde Excel', 'seed'
  from productos p
 where p.stock <> 0
   and not exists (select 1 from movimientos m where m.producto_id = p.id and m.referencia = 'seed')
   and p.codigo in (
  'TER993', 'TER1094', 'VAR1103', 'VAR1104', 'ROL648', 'ROL448', 'ROL649', 'ROL449', 'ROL650', 'ROL651', 'ROL652', 'ROL653', 'ROL654', 'ROL910', 'ROL911', 'ROL912', 'ROL913', 'ROL914', 'ROL915', 'ROL916', 'ROL1113', 'CAP434', 'CAP1126', 'CAP433', 'CAP432', 'CAP1202', 'CAP431', 'CAP640', 'CAP430', 'CAP411', 'CAP412', 'CAP413', 'CAP414', 'CAP415', 'CAP416', 'CAP417', 'CAP418', 'CAP419', 'CAP1074', 'CAP1075', 'CAP1076', 'CAP1077', 'CAP1203', 'CAP849', 'CAP850', 'CAP851', 'CAP852', 'CAP853', 'CAP854', 'CAP855', 'BIM890', 'BIM487', 'BIM909', 'BIM488', 'BIM489', 'BIM781', 'BIM986', 'BIM987', 'BIM782', 'BIM783', 'BIM784', 'REL772', 'REL723', 'REL871', 'REL724', 'REL725', 'REL872', 'REL492', 'REL493', 'REL767', 'REL870', 'REL875', 'REL873', 'REL874', 'RES735', 'RES736', 'RES737', 'RES738', 'RES739', 'RES740', 'RES741', 'RES742', 'RES743', 'RES744', 'RES745', 'RES1121', 'RES1122', 'RES827', 'RES828', 'RES829', 'RES746', 'RES747', 'RES1183', 'RES1184', 'RES1185', 'VAL480', 'VAL876', 'VAL877', 'VAL878', 'VAL1095', 'VAL1096', 'FIL491', 'FIL482', 'FIL826', 'FIL991', 'FIL1101', 'FIL494', 'FIL479', 'FIL989', 'FIL1102', 'FIL990', 'STAR490', 'REL049', 'TUB1013', 'PRO478', 'PRO477', 'TEI385', 'TEI343', 'JUE542', 'EXT151', 'PEG453', 'ENC551', 'ENC556', 'ENC1056', 'ORI1084'
);

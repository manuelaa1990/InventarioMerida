/* ============================================================
   Inventario HVAC - panel administrativo
   ============================================================ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const bsFmt = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numFmt = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const longDateFmt = new Intl.DateTimeFormat('es-VE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const state = {
  productos: [],
  config: { tasa_bcv: 1, tasa_compra: 1, iva_pct: 16, margen_pct: 15 },
  dashboard: null,
  ventas: [],
  movimientos: [],
  cart: [],
  editingId: null,
  stockProduct: null,
  invFilter: { q: '', estado: 'todos', categoria: '' },
  movFilter: { q: '', tipo: '' },
};

let loading = false;

/* ---------------- Utilidades ---------------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function norm(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const moneyUsd = (value) => usdFmt.format(Number(value) || 0);
const moneyBs = (value) => `Bs ${bsFmt.format(Number(value) || 0)}`;
const number = (value) => numFmt.format(Number(value) || 0);

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFmt.format(date);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFmt.format(date);
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function byId(id) {
  return state.productos.find((p) => p.id === Number(id));
}

function toast(message, type = 'ok') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : 'ok'}`;
  el.innerHTML = `<span>${type === 'err' ? '⚠' : '✓'}</span><span>${esc(message)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

async function api(path, options = {}) {
  const { raw = false, headers: extraHeaders = {}, ...rest } = options;
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: raw ? { ...extraHeaders } : { 'Content-Type': 'application/json', ...extraHeaders },
    ...rest,
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (response.status === 401 && path !== '/api/login') {
    showAuth();
    throw new Error('Tu sesión expiró. Ingresa nuevamente.');
  }

  if (!response.ok) {
    throw new Error(data.error || `Error ${response.status}`);
  }

  return data;
}

/* ---------------- Sesión ---------------- */

async function init() {
  try {
    const response = await fetch('/api/login', { credentials: 'same-origin' });
    const data = await response.json();
    if (data.authenticated) await showApp();
    else showAuth();
  } catch {
    showAuth();
  }
}

function showAuth() {
  $('#authScreen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $$('dialog').forEach((dialog) => {
    if (dialog.open) dialog.close();
  });
  setTimeout(() => $('#password')?.focus(), 30);
}

async function showApp() {
  $('#authScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadAll();
  const initial = location.hash.replace('#', '');
  const valid = ['panel', 'inventario', 'ventas', 'movimientos', 'config'];
  showView(valid.includes(initial) ? initial : 'panel');
}

async function loadAll() {
  if (loading) return false;
  loading = true;
  try {
    const [productos, dashboard, ventas, movimientos] = await Promise.all([
      api('/api/productos'),
      api('/api/dashboard'),
      api('/api/ventas'),
      api('/api/movimientos?limit=200'),
    ]);

    state.productos = productos.productos || [];
    state.config = productos.config || state.config;
    state.dashboard = dashboard;
    state.ventas = ventas.ventas || [];
    state.movimientos = movimientos.movimientos || [];

    $('#saleRate').value = Number(state.config.tasa_bcv).toFixed(2);
    $('#saleRateBadge').textContent = `Tasa BCV: Bs ${number(state.config.tasa_bcv)}`;

    renderAll();
    fillConfigForm();
    return true;
  } catch (error) {
    toast(error.message, 'err');
    return false;
  } finally {
    loading = false;
  }
}

function renderAll() {
  renderPanel();
  renderInventory();
  renderSaleHistory();
  renderMovements();
  renderCategories();
}

/* ---------------- Panel ---------------- */

function renderPanel() {
  const today = longDateFmt.format(new Date());
  $('#panelDate').textContent = capitalize(today);

  const dash = state.dashboard;
  if (!dash) {
    $('#statGrid').innerHTML = '';
    return;
  }

  const { totales, ventas_mes: mes, ventas_hoy: hoy } = dash;

  $('#statGrid').innerHTML = `
    <div class="stat">
      <div class="label">Unidades en stock</div>
      <div class="value">${number(totales.unidades)}</div>
      <div class="foot">${number(totales.productos)} productos activos</div>
    </div>
    <div class="stat blue">
      <div class="label">Valor a costo</div>
      <div class="value">${moneyUsd(totales.valor_costo_usd)}</div>
      <div class="foot">Capital invertido en inventario</div>
    </div>
    <div class="stat">
      <div class="label">Valor a venta</div>
      <div class="value">${moneyUsd(totales.valor_venta_usd)}</div>
      <div class="foot">Precio de lista sin IVA</div>
    </div>
    <div class="stat danger">
      <div class="label">Alertas de stock</div>
      <div class="value">${number(totales.bajos)} <span class="unit">productos</span></div>
      <div class="foot">${number(totales.agotados)} agotados · ${number(totales.bajos - totales.agotados)} por reponer</div>
    </div>
  `;

  $('#balanceStrip').innerHTML = `
    <div class="item">
      <span class="k">Ventas del mes</span>
      <span class="v">${moneyUsd(mes.total_usd)}</span>
    </div>
    <div class="item">
      <span class="k">Utilidad bruta del mes</span>
      <span class="v">${moneyUsd(mes.utilidad_usd)}</span>
    </div>
    <div class="item">
      <span class="k">Ventas de hoy</span>
      <span class="v">${moneyUsd(hoy.total_usd)} <span class="tiny">(${number(hoy.cantidad)})</span></span>
    </div>
    <div class="spacer"></div>
    <div class="note">Tasa BCV actual: <strong>Bs ${number(state.config.tasa_bcv)}</strong> por USD · IVA ${number(state.config.iva_pct)}%</div>
  `;

  const low = dash.bajo_stock || [];
  $('#lowStockList').innerHTML = low.length
    ? low.map((p) => `
        <div class="list-row">
          <div class="grow">
            <strong>${esc(p.nombre)}</strong>
            <span>${esc(p.codigo)} · mínimo ${number(p.stock_minimo)}</span>
          </div>
          <span class="badge ${p.stock <= 0 ? 'out' : 'low'}">${number(p.stock)} disp.</span>
          <button class="icon-btn" data-act="adjust" data-id="${p.id}" title="Ajustar stock">±</button>
        </div>
      `).join('')
    : `<div class="empty"><strong>Todo en orden</strong>No hay productos por debajo del stock mínimo.</div>`;

  const movs = dash.movimientos || [];
  $('#recentMovs').innerHTML = movs.length
    ? `<div class="list">${movs.map((m) => {
        const meta = movementMeta(m.tipo);
        return `
          <div class="list-row">
            <span class="mov-type ${esc(m.tipo)}">${meta.letter}</span>
            <div class="grow">
              <strong>${esc(m.nombre || 'Producto eliminado')}</strong>
              <span>${esc(m.codigo || '—')} · ${formatDateTime(m.fecha)}</span>
            </div>
            <div class="right">
              <strong class="num" style="color:${m.cantidad < 0 ? 'var(--danger)' : 'var(--ok)'}">${m.cantidad > 0 ? '+' : ''}${number(m.cantidad)}</strong>
              <div class="tiny muted">${meta.label}</div>
            </div>
          </div>
        `;
      }).join('')}</div>`
    : `<div class="empty"><strong>Sin movimientos</strong>Los movimientos aparecerán aquí.</div>`;
}

function movementMeta(tipo) {
  const map = {
    inicial: { letter: 'I', label: 'Carga inicial' },
    entrada: { letter: 'E', label: 'Entrada' },
    salida: { letter: 'S', label: 'Salida' },
    ajuste: { letter: 'A', label: 'Ajuste' },
    venta: { letter: 'V', label: 'Venta' },
  };
  return map[tipo] || { letter: '?', label: tipo };
}

/* ---------------- Inventario ---------------- */

function filteredProducts() {
  const q = norm(state.invFilter.q);
  return state.productos.filter((p) => {
    if (state.invFilter.categoria && p.categoria !== state.invFilter.categoria) return false;
    if (state.invFilter.estado === 'bajo' && p.estado !== 'bajo') return false;
    if (state.invFilter.estado === 'agotado' && p.estado !== 'agotado') return false;
    if (!q) return true;
    return [p.codigo, p.nombre, p.marca, p.descripcion, p.categoria, p.presentacion, ...(p.tags || [])]
      .some((value) => norm(value).includes(q));
  });
}

function stockBadge(product) {
  if (product.estado === 'agotado') {
    return '<span class="badge out"><span class="dot"></span>Agotado</span>';
  }
  if (product.estado === 'bajo') {
    return `<span class="badge low" title="Stock bajo">${number(product.stock)}</span>`;
  }
  return `<span class="badge ok">${number(product.stock)}</span>`;
}

function principalImage(product) {
  const imagenes = product.imagenes || [];
  return imagenes.find((img) => img.principal) || imagenes[0] || null;
}

function productThumb(product) {
  const foto = principalImage(product);
  if (!foto) return '';
  return `<img class="thumb" src="${esc(foto.url)}" alt="" loading="lazy" decoding="async">`;
}

function renderInventory() {
  const rows = filteredProducts();
  const body = $('#invBody');
  const empty = $('#invEmpty');

  $('#invCount').textContent = `${rows.length} de ${state.productos.length} productos`;
  empty.classList.toggle('hidden', rows.length > 0);

  body.innerHTML = rows.map((p) => `
    <tr>
      <td>
        <div class="product-cell">
          ${productThumb(p)}
          <div class="product-text">
            <strong>${esc(p.nombre)}</strong>
            <span>${esc(p.codigo)}${p.marca ? ` · ${esc(p.marca)}` : ''} · ${esc(p.categoria)}${p.presentacion ? ` · ${esc(p.presentacion)}` : ''}</span>
          </div>
        </div>
      </td>
      <td class="right">${stockBadge(p)}</td>
      <td class="right num">${p.costo_usd > 0 ? moneyUsd(p.costo_usd) : '<span class="badge low">Sin costo</span>'}</td>
      <td class="right num">${p.costo_usd > 0 ? `${number(p.margen_aplicado_pct)}%` : '<span class="muted">—</span>'}</td>
      <td class="right num">
        ${p.costo_usd > 0
          ? `<strong>${moneyUsd(p.precio_usd)}</strong><div class="tiny muted">s/IVA ${moneyUsd(p.precio_sin_iva_usd)}</div>`
          : '<span class="muted">—</span>'}
      </td>
      <td class="right num">${p.costo_usd > 0 ? moneyBs(p.precio_bs) : '<span class="muted">—</span>'}</td>
      <td>
        <div class="actions">
          <button class="icon-btn" data-act="adjust" data-id="${p.id}" title="Ajustar stock">±</button>
          <button class="icon-btn" data-act="edit" data-id="${p.id}" title="Editar producto">✎</button>
          <button class="icon-btn danger" data-act="delete" data-id="${p.id}" title="Desactivar producto">×</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderCategories() {
  const categories = [...new Set(state.productos.map((p) => p.categoria).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );

  const select = $('#invCategory');
  const current = select.value;
  select.innerHTML = `<option value="">Todas las categorías</option>` +
    categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (categories.includes(current)) select.value = current;

  $('#categoriasList').innerHTML = categories.map((c) => `<option value="${esc(c)}"></option>`).join('');

  const tags = [...new Set(state.productos.flatMap((p) => p.tags || []))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  const tagsList = $('#tagsList');
  if (tagsList) tagsList.innerHTML = tags.map((t) => `<option value="${esc(t)}"></option>`).join('');

  const marcas = [...new Set(state.productos.map((p) => p.marca).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  const marcasList = $('#marcasList');
  if (marcasList) marcasList.innerHTML = marcas.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

function exportCsv() {
  const rows = filteredProducts();
  if (!rows.length) {
    toast('No hay productos para exportar', 'err');
    return;
  }

  const header = ['Codigo', 'Nombre', 'Marca', 'Categoria', 'Tags', 'Presentacion', 'Stock', 'Stock minimo', 'Costo $ Binance', 'Margen %', 'Precio sin IVA USD', 'Precio $ BCV', 'Precio Bs'];
  const lines = rows.map((p) => [
    p.codigo,
    p.nombre,
    p.marca,
    p.categoria,
    (p.tags || []).join(', '),
    p.presentacion,
    p.stock,
    p.stock_minimo,
    p.costo_usd,
    p.margen_aplicado_pct,
    p.precio_sin_iva_usd,
    p.precio_usd,
    p.precio_bs,
  ]);

  const cell = (value) => {
    let text = String(value ?? '');
    // Evita que Excel interprete el contenido como fórmula.
    if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const csv = [header, ...lines].map((line) => line.map(cell).join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `inventario-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`Se exportaron ${rows.length} productos`);
}

/* ---------------- Ventas ---------------- */

function renderSaleResults() {
  const query = $('#saleSearch').value.trim();
  const container = $('#saleResults');

  if (!query) {
    container.innerHTML = '';
    return;
  }

  const q = norm(query);
  const matches = state.productos
    .filter((p) => p.stock > 0 && [p.codigo, p.nombre, p.marca, p.descripcion, p.categoria, ...(p.tags || [])].some((v) => norm(v).includes(q)))
    .slice(0, 8);

  if (!matches.length) {
    container.innerHTML = `<div class="search-results"><div class="empty" style="padding:18px;">Sin productos disponibles con ese criterio.</div></div>`;
    return;
  }

  container.innerHTML = `<div class="search-results">${matches.map((p) => `
    <button type="button" class="search-item" data-add="${p.id}">
      <div class="grow">
        <strong>${esc(p.nombre)}</strong>
        <span>${esc(p.codigo)} · ${number(p.stock)} disponibles</span>
      </div>
      <span class="price">${moneyUsd(p.precio_usd)}</span>
    </button>
  `).join('')}</div>`;
}

function addToCart(productId) {
  const product = byId(productId);
  if (!product) return;
  if (product.stock <= 0) {
    toast('Ese producto está agotado', 'err');
    return;
  }

  const existing = state.cart.find((item) => item.id === product.id);
  if (existing) {
    existing.cantidad += 1;
  } else {
    state.cart.push({ id: product.id, cantidad: 1, precio: product.precio_usd });
  }

  $('#saleSearch').value = '';
  $('#saleResults').innerHTML = '';
  renderCart();
}

function renderCart() {
  const list = $('#cartList');

  if (!state.cart.length) {
    list.innerHTML = `<div class="empty"><strong>La venta está vacía</strong>Busca un producto arriba para agregarlo.</div>`;
    recalcSale();
    return;
  }

  list.innerHTML = state.cart.map((item) => {
    const product = byId(item.id);
    if (!product) return '';
    return `
      <div class="cart-row">
        <div class="name">
          <strong>${esc(product.nombre)}</strong>
          <span>${esc(product.codigo)} · ${number(product.stock)} disp. · Total: <b id="line-${item.id}">${moneyUsd(item.cantidad * item.precio)}</b></span>
        </div>
        <input type="number" min="0.001" step="0.001" value="${item.cantidad}" data-cart-qty="${item.id}" aria-label="Cantidad">
        <input type="number" min="0" step="0.01" value="${item.precio}" data-cart-price="${item.id}" aria-label="Precio unitario USD">
        <button class="icon-btn danger" data-act="cart-remove" data-id="${item.id}" title="Quitar">×</button>
      </div>
    `;
  }).join('');

  recalcSale();
}

function recalcSale() {
  const rate = Number($('#saleRate').value) || Number(state.config.tasa_bcv) || 1;
  const iva = Number(state.config.iva_pct) || 0;

  let subtotal = 0;
  let units = 0;
  let utility = 0;
  let overstock = null;

  for (const item of state.cart) {
    const product = byId(item.id);
    if (!product) continue;
    const quantity = Number(item.cantidad) || 0;
    const line = quantity * (Number(item.precio) || 0);
    subtotal += line;
    units += quantity;
    utility += ((Number(item.precio) || 0) / (1 + iva / 100) - product.costo_usd) * quantity;

    if (quantity > product.stock && !overstock) overstock = product;

    const lineEl = $(`#line-${item.id}`);
    if (lineEl) lineEl.textContent = moneyUsd(line);
  }

  const totalBs = subtotal * rate;
  const ivaMonto = subtotal - subtotal / (1 + iva / 100);

  $('#cartTotals').innerHTML = `
    <div class="row"><span>Artículos</span><strong class="num">${number(units)}</strong></div>
    <div class="row"><span>Subtotal (IVA incluido)</span><strong class="num">${moneyUsd(subtotal)}</strong></div>
    <div class="row"><span>IVA incluido (${number(iva)}%)</span><strong class="num">${moneyUsd(ivaMonto)}</strong></div>
    <div class="row"><span>Utilidad estimada</span><strong class="num" style="color:var(--brand-dark)">${moneyUsd(utility)}</strong></div>
    ${overstock ? `<div class="row" style="color:var(--danger); font-weight:600;"><span>Stock insuficiente: ${esc(overstock.nombre)}</span><strong class="num">${number(overstock.stock)} disp.</strong></div>` : ''}
    <div class="row total"><span>Total</span><strong class="num">${moneyUsd(subtotal)} · ${moneyBs(totalBs)}</strong></div>
  `;

  $('#saleRateBadge').textContent = `Tasa aplicada: Bs ${number(rate)}`;
}

async function submitSale() {
  if (!state.cart.length) {
    toast('Agrega al menos un producto', 'err');
    return;
  }

  const sinStock = state.cart.find((item) => {
    const product = byId(item.id);
    return product && Number(item.cantidad) > product.stock;
  });
  if (sinStock) {
    const product = byId(sinStock.id);
    toast(`Stock insuficiente de ${product?.nombre || 'un producto'} (${number(product?.stock)} disponibles)`, 'err');
    return;
  }

  const rate = Number($('#saleRate').value);
  if (!Number.isFinite(rate) || rate <= 0) {
    toast('Ingresa una tasa BCV válida', 'err');
    return;
  }

  const button = $('#saleSubmit');
  button.disabled = true;
  button.textContent = 'Registrando venta…';

  try {
    const payload = {
      cliente: $('#saleClient').value.trim(),
      nota: $('#saleNote').value.trim(),
      tasa_bcv: rate,
      items: state.cart.map((item) => ({
        producto_id: item.id,
        cantidad: item.cantidad,
        precio_unitario_usd: item.precio,
      })),
    };

    const response = await api('/api/ventas', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    toast(`Venta #${response.venta.id} registrada por ${moneyUsd(response.venta.total_usd)}`);
    state.cart = [];
    $('#saleClient').value = '';
    $('#saleNote').value = '';
    $('#saleSearch').value = '';
    $('#saleResults').innerHTML = '';
    renderCart();
    await loadAll();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Registrar venta';
  }
}

function renderSaleHistory() {
  const container = $('#saleHistory');
  const ventas = state.ventas.slice(0, 25);

  if (!ventas.length) {
    container.innerHTML = `<div class="empty"><strong>Aún no hay ventas</strong>Las ventas registradas aparecerán aquí.</div>`;
    return;
  }

  container.innerHTML = ventas.map((venta) => {
    const productos = (venta.items || [])
      .map((item) => `${number(item.cantidad)}× ${item.nombre || 'Producto'}`)
      .join(', ');

    return `
      <div class="sale-card">
        <div class="top">
          <strong>Venta #${venta.id}</strong>
          <span class="amt">${moneyUsd(venta.total_usd)}</span>
        </div>
        <div class="meta">${formatDateTime(venta.fecha)}${venta.cliente ? ` · ${esc(venta.cliente)}` : ''} · ${moneyBs(venta.total_bs)}</div>
        <div class="items" title="${esc(productos)}">${esc(productos)}</div>
      </div>
    `;
  }).join('');
}

/* ---------------- Movimientos ---------------- */

function renderMovements() {
  const q = norm(state.movFilter.q);
  const tipo = state.movFilter.tipo;

  const rows = state.movimientos.filter((m) => {
    if (tipo && m.tipo !== tipo) return false;
    if (!q) return true;
    return [m.codigo, m.nombre, m.motivo, m.referencia, m.tipo]
      .some((value) => norm(value).includes(q));
  });

  $('#movBody').innerHTML = rows.map((m) => {
    const meta = movementMeta(m.tipo);
    return `
      <tr>
        <td class="nowrap muted small">${formatDateTime(m.fecha)}</td>
        <td><span class="badge ${movementClass(m.tipo)}">${meta.label}</span></td>
        <td>
          <div class="product-cell">
            <strong>${esc(m.nombre || 'Producto eliminado')}</strong>
            <span>${esc(m.codigo || '—')}</span>
          </div>
        </td>
        <td class="right num" style="color:${m.cantidad < 0 ? 'var(--danger)' : 'var(--ok)'}; font-weight:700;">
          ${m.cantidad > 0 ? '+' : ''}${number(m.cantidad)}
        </td>
        <td class="muted small">${esc(m.motivo || '—')}${m.referencia ? ` · <span class="mono">${esc(m.referencia)}</span>` : ''}</td>
      </tr>
    `;
  }).join('');

  $('#movEmpty').classList.toggle('hidden', rows.length > 0);
}

function movementClass(tipo) {
  return {
    inicial: 'info',
    entrada: 'ok',
    salida: 'low',
    ajuste: 'neutral',
    venta: 'info',
  }[tipo] || 'neutral';
}

/* ---------------- Producto: alta / edición ---------------- */

function openProductDialog(productId = null) {
  const form = $('#productForm');
  form.reset();
  state.editingId = productId ? Number(productId) : null;

  $('#prodId').value = state.editingId || '';
  $('#prodCategoria').value = 'General';
  $('#prodMarca').value = '';
  $('#prodTags').value = '';
  $('#prodStockMin').value = '3';
  $('#prodCosto').value = '0';
  $('#prodStock').value = '0';
  $('#prodStockField').classList.remove('hidden');
  $('#prodStockNote').classList.add('hidden');
  $('#productDialogTitle').textContent = 'Nuevo producto';
  $('#prodSave').textContent = 'Guardar producto';

  if (state.editingId) {
    const product = byId(state.editingId);
    if (!product) return;

    $('#productDialogTitle').textContent = 'Editar producto';
    $('#prodSave').textContent = 'Guardar cambios';
    $('#prodCodigo').value = product.codigo;
    $('#prodNombre').value = product.nombre;
    $('#prodDescripcion').value = product.descripcion || '';
    $('#prodPresentacion').value = product.presentacion || '';
    $('#prodCategoria').value = product.categoria || 'General';
    $('#prodMarca').value = product.marca || '';
    $('#prodTags').value = (product.tags || []).join(', ');
    $('#prodCosto').value = product.costo_usd;
    $('#prodStockMin').value = product.stock_minimo;
    $('#prodMargen').value = product.margen_pct ?? '';
    $('#prodIva').value = product.iva_pct ?? '';
    $('#prodStockField').classList.add('hidden');
    $('#prodStockNote').classList.remove('hidden');
  }

  updateProductPreview();
  renderProductPhotos();
  $('#productDialog').showModal();
  setTimeout(() => $('#prodCodigo').focus(), 50);
}

function previewCalculation(costo, margenPct, ivaPct) {
  const cfg = state.config;
  const tasaBcv = Number(cfg.tasa_bcv) || 1;
  const tasaBinance = Number(cfg.tasa_compra) || tasaBcv;

  // El costo está en dólares a tasa Binance. Para expresarlo en dólares BCV
  // se multiplica por la brecha entre ambas tasas.
  const factor = tasaBinance / tasaBcv;
  const margen = Number(margenPct) || 0;
  const iva = Number(ivaPct) || 0;

  const costoBcv = costo * factor;
  const sinIva = costoBcv * (1 + margen / 100);
  const conIva = sinIva * (1 + iva / 100);

  return {
    tasaBcv,
    tasaBinance,
    factor,
    brecha: ((tasaBinance - tasaBcv) / tasaBcv) * 100,
    costoBcv,
    sinIva,
    conIva,
    bs: conIva * tasaBcv,
    // Utilidad real en USD: al vender en Bs y recomprar USDT se obtiene
    // precio_sin_iva / factor, es decir, costo * margen.
    utilidad: (sinIva / factor) - costo,
    margen,
    iva,
  };
}

function updateProductPreview() {
  const costo = Number($('#prodCosto').value) || 0;
  const margenInput = $('#prodMargen').value;
  const ivaInput = $('#prodIva').value;
  const margen = margenInput === '' ? state.config.margen_pct : Number(margenInput);
  const iva = ivaInput === '' ? state.config.iva_pct : Number(ivaInput);
  const calc = previewCalculation(costo, margen, iva);
  const signo = calc.brecha >= 0 ? '+' : '';

  $('#prodCalc').innerHTML = `
    <div class="item"><span class="k">Costo (USD Binance)</span><span class="v">${moneyUsd(costo)}</span></div>
    <div class="item"><span class="k">Tasa Binance</span><span class="v">${moneyBs(calc.tasaBinance)}</span></div>
    <div class="item"><span class="k">Tasa BCV</span><span class="v">${moneyBs(calc.tasaBcv)}</span></div>
    <div class="item">
      <span class="k">Factor Binance / BCV</span>
      <span class="v">${calc.factor.toFixed(4)} <span class="badge ${calc.brecha >= 0 ? 'low' : 'info'}">${signo}${number(calc.brecha)}%</span></span>
    </div>
    <div class="item"><span class="k">Margen de ganancia</span><span class="v">${number(calc.margen)}%</span></div>
    <div class="item"><span class="k">Precio sin IVA</span><span class="v">${moneyUsd(calc.sinIva)}</span></div>
    <div class="item"><span class="k">Precio final $ BCV</span><span class="v green">${moneyUsd(calc.conIva)}</span></div>
    <div class="item"><span class="k">Precio en Bs</span><span class="v green">${moneyBs(calc.bs)}</span></div>
    <div class="item"><span class="k">Utilidad / unidad</span><span class="v green">${moneyUsd(calc.utilidad)}</span></div>
  `;
}

async function saveProduct(event) {
  event.preventDefault();

  const id = state.editingId;
  const payload = {
    codigo: $('#prodCodigo').value.trim(),
    nombre: $('#prodNombre').value.trim(),
    descripcion: $('#prodDescripcion').value.trim(),
    presentacion: $('#prodPresentacion').value.trim(),
    categoria: $('#prodCategoria').value.trim() || 'General',
    marca: $('#prodMarca').value.trim(),
    tags: $('#prodTags').value.trim(),
    costo_usd: Number($('#prodCosto').value) || 0,
    stock_minimo: Number($('#prodStockMin').value) || 0,
    margen_pct: $('#prodMargen').value === '' ? null : Number($('#prodMargen').value),
    iva_pct: $('#prodIva').value === '' ? null : Number($('#prodIva').value),
  };

  if (!payload.codigo || !payload.nombre) {
    toast('Código y nombre son obligatorios', 'err');
    return;
  }

  if (!id) payload.stock = Number($('#prodStock').value) || 0;
  else payload.id = id;

  const button = $('#prodSave');
  button.disabled = true;
  button.textContent = 'Guardando…';

  try {
    await api('/api/productos', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    $('#productDialog').close();
    toast(id ? 'Producto actualizado' : 'Producto creado');
    await loadAll();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = id ? 'Guardar cambios' : 'Guardar producto';
  }
}

/* ---------------- Fotos del producto ---------------- */

const MAX_FOTOS = 4;

function renderProductPhotos() {
  const wrap = $('#prodPhotos');
  const notaNuevo = $('#prodPhotoNewNote');
  if (!wrap) return;

  const product = state.editingId ? byId(state.editingId) : null;
  wrap.hidden = !product;
  if (notaNuevo) notaNuevo.hidden = Boolean(product);
  if (!product) return;

  const fotos = product.imagenes || [];
  const grid = $('#prodPhotoGrid');

  grid.innerHTML = fotos.length
    ? fotos.map((foto) => `
        <figure class="photo-item${foto.principal ? ' is-principal' : ''}">
          <img src="${esc(foto.url)}" alt="${esc(foto.alt || product.nombre)}" loading="lazy" decoding="async">
          <figcaption>
            ${foto.principal
              ? '<span class="badge ok">Principal</span>'
              : `<button type="button" class="btn ghost sm" data-photo-principal="${foto.id}">Hacer principal</button>`}
            <button type="button" class="icon-btn danger" data-photo-delete="${foto.id}" title="Eliminar foto">×</button>
          </figcaption>
        </figure>
      `).join('')
    : '<div class="photo-empty">Este producto todavía no tiene fotos.</div>';

  const restantes = MAX_FOTOS - fotos.length;
  const input = $('#prodPhotoInput');
  if (input) input.disabled = restantes <= 0;
  $('#prodPhotoAddLabel')?.classList.toggle('disabled', restantes <= 0);

  const nota = $('#prodPhotoNote');
  if (nota) {
    nota.textContent = restantes > 0
      ? `Puedes agregar ${restantes} foto${restantes === 1 ? '' : 's'} más.`
      : `Llegaste al máximo de ${MAX_FOTOS} fotos.`;
  }
}

/** Reduce la imagen en el navegador antes de subirla (WebP, lado máximo 1200 px). */
function comprimirImagen(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('El archivo no es una imagen'));
      return;
    }

    const url = URL.createObjectURL(file);
    const imagen = new Image();

    imagen.onload = () => {
      URL.revokeObjectURL(url);
      const maxLado = 1200;
      const escala = Math.min(1, maxLado / Math.max(imagen.width, imagen.height));
      const ancho = Math.max(1, Math.round(imagen.width * escala));
      const alto = Math.max(1, Math.round(imagen.height * escala));

      const canvas = document.createElement('canvas');
      canvas.width = ancho;
      canvas.height = alto;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, ancho, alto);
      ctx.drawImage(imagen, 0, 0, ancho, alto);

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo procesar la imagen'))),
        'image/webp',
        0.82
      );
    };

    imagen.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };

    imagen.src = url;
  });
}

async function subirFotos(files) {
  const product = state.editingId ? byId(state.editingId) : null;
  if (!product) {
    toast('Guarda el producto antes de agregar fotos', 'err');
    return;
  }

  const lista = Array.from(files || []);
  if (!lista.length) return;

  const disponibles = MAX_FOTOS - (product.imagenes || []).length;
  if (disponibles <= 0) {
    toast(`Máximo ${MAX_FOTOS} fotos por producto`, 'err');
    return;
  }

  const lote = lista.slice(0, disponibles);
  if (lista.length > disponibles) {
    toast(`Solo se subirán ${disponibles} foto(s): el máximo es ${MAX_FOTOS}`);
  }

  const input = $('#prodPhotoInput');
  const nota = $('#prodPhotoNote');
  if (input) input.disabled = true;
  let subidas = 0;

  for (const [indice, archivo] of lote.entries()) {
    if (nota) nota.textContent = `Procesando ${indice + 1} de ${lote.length}…`;
    try {
      const blob = await comprimirImagen(archivo);
      await api(`/api/imagenes?producto_id=${product.id}`, {
        method: 'POST',
        raw: true,
        headers: { 'Content-Type': blob.type || 'image/webp' },
        body: blob,
      });
      subidas += 1;
    } catch (error) {
      toast(`${archivo.name}: ${error.message}`, 'err');
    }
  }

  await loadAll();
  renderProductPhotos();
  if (subidas) toast(subidas === 1 ? 'Foto agregada' : `${subidas} fotos agregadas`);
}

async function marcarFotoPrincipal(fotoId) {
  const product = state.editingId ? byId(state.editingId) : null;
  if (!product) return;

  try {
    await api('/api/imagenes', {
      method: 'PUT',
      body: JSON.stringify({ id: Number(fotoId), principal: true }),
    });
    product.imagenes = (product.imagenes || []).map((foto) => ({
      ...foto,
      principal: Number(foto.id) === Number(fotoId),
    }));
    renderProductPhotos();
    renderInventory();
    toast('Foto principal actualizada');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function eliminarFoto(fotoId) {
  const product = state.editingId ? byId(state.editingId) : null;
  if (!product) return;
  if (!confirm('¿Eliminar esta foto del producto?')) return;

  try {
    await api(`/api/imagenes?id=${Number(fotoId)}`, { method: 'DELETE' });
    await loadAll();
    renderProductPhotos();
    toast('Foto eliminada');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function deleteProduct(productId) {
  const product = byId(productId);
  if (!product) return;
  if (!confirm(`¿Desactivar "${product.nombre}"? Dejará de aparecer en el inventario y en la consulta pública.`)) {
    return;
  }

  try {
    await api(`/api/productos?id=${product.id}`, { method: 'DELETE' });
    toast('Producto desactivado');
    await loadAll();
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ---------------- Ajuste de stock ---------------- */

function openStockDialog(productId) {
  const product = byId(productId);
  if (!product) return;

  state.stockProduct = product;
  $('#stockProductId').value = product.id;
  $('#stockProductName').textContent = `${product.codigo} · ${product.nombre} — stock actual: ${number(product.stock)}`;
  $('#stockTipo').value = 'entrada';
  $('#stockCantidad').value = '1';
  $('#stockMotivo').value = '';
  updateStockPreview();
  $('#stockDialog').showModal();
  setTimeout(() => $('#stockCantidad').focus(), 60);
}

function updateStockPreview() {
  const product = state.stockProduct;
  if (!product) return;

  const tipo = $('#stockTipo').value;
  const cantidad = Number($('#stockCantidad').value) || 0;
  const actual = Number(product.stock) || 0;

  let nuevo = actual;
  if (tipo === 'entrada') nuevo = actual + cantidad;
  if (tipo === 'salida') nuevo = actual - cantidad;
  if (tipo === 'ajuste') nuevo = cantidad;

  const color = nuevo < 0 ? 'var(--danger)' : nuevo <= Number(product.stock_minimo) ? '#b45309' : 'var(--brand-dark)';

  $('#stockPreview').innerHTML = `
    <div class="item"><span class="k">Stock actual</span><span class="v">${number(actual)}</span></div>
    <div class="item"><span class="k">Movimiento</span><span class="v">${tipo === 'entrada' ? '+' : tipo === 'salida' ? '−' : '='} ${number(cantidad)}</span></div>
    <div class="item"><span class="k">Stock resultante</span><span class="v" style="color:${color}">${number(nuevo)}</span></div>
  `;
}

async function saveStock(event) {
  event.preventDefault();
  const product = state.stockProduct;
  if (!product) return;

  const tipo = $('#stockTipo').value;
  const cantidad = Number($('#stockCantidad').value);

  if (!Number.isFinite(cantidad) || cantidad < 0) {
    toast('Cantidad inválida', 'err');
    return;
  }

  const button = $('#stockSave');
  button.disabled = true;
  button.textContent = 'Registrando…';

  try {
    const response = await api('/api/ajustes', {
      method: 'POST',
      body: JSON.stringify({
        producto_id: product.id,
        tipo,
        cantidad,
        motivo: $('#stockMotivo').value.trim(),
      }),
    });

    $('#stockDialog').close();
    toast(`Stock actualizado: ${number(response.anterior)} → ${number(response.nuevo)}`);
    await loadAll();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Registrar movimiento';
  }
}

/* ---------------- Configuración ---------------- */

function fillConfigForm() {
  $('#cfgTasaBcv').value = state.config.tasa_bcv;
  $('#cfgTasaCompra').value = state.config.tasa_compra;
  $('#cfgIva').value = state.config.iva_pct;
  $('#cfgMargen').value = state.config.margen_pct;

  const status = $('#cfgTasasStatus');
  const actualizada = state.config.tasas_actualizadas || state.config.tasa_bcv_actualizada;
  if (status && !status.textContent && actualizada) {
    status.textContent = `Actualizadas: ${formatDateTime(actualizada)} · automáticas cada 6 h`;
  }

  updateConfigExample();
}

function updateConfigExample() {
  const tasaBcv = Number($('#cfgTasaBcv').value) || 1;
  const tasaCompra = Number($('#cfgTasaCompra').value) || tasaBcv;
  const iva = Number($('#cfgIva').value) || 0;
  const margen = Number($('#cfgMargen').value) || 0;

  const factor = tasaCompra / tasaBcv;
  const sinIva = factor * (1 + margen / 100);
  const conIva = sinIva * (1 + iva / 100);

  $('#configExample').innerHTML = `
    <div class="row"><span>Con un costo de ejemplo de $1.00</span><strong>${moneyUsd(1)}</strong></div>
    <div class="row"><span>Factor de cambio (Binance / BCV)</span><strong>${factor.toFixed(4)}</strong></div>
    <div class="row"><span>Precio sin IVA</span><strong>${moneyUsd(sinIva)}</strong></div>
    <div class="row"><span>Precio final $ BCV</span><strong>${moneyUsd(conIva)}</strong></div>
    <div class="row"><span>Precio final en bolívares</span><strong>${moneyBs(conIva * tasaBcv)}</strong></div>
    <div class="row"><span>Utilidad por unidad</span><strong style="color:var(--brand-dark)">${moneyUsd(margen / 100)}</strong></div>
  `;
}

async function actualizarTasas() {
  const button = $('#cfgTasasFetch');
  const status = $('#cfgTasasStatus');
  if (!button) return;

  button.disabled = true;
  button.textContent = 'Consultando…';
  if (status) status.textContent = 'Leyendo BCV y USDT…';

  try {
    const data = await api('/api/tasas', { method: 'POST' });
    state.config = data.config || state.config;
    fillConfigForm();
    $('#saleRate').value = Number(state.config.tasa_bcv).toFixed(2);

    const partes = [];
    if (data.bcv) partes.push(`BCV: Bs ${number(data.bcv.tasa)}`);
    if (data.usdt) partes.push(`USDT: Bs ${number(data.usdt.tasa)}`);
    if (status) status.textContent = `${partes.join(' · ')} · guardadas ahora`;
    toast(`Tasas actualizadas: ${partes.join(' · ')}`);

    await loadAll();
  } catch (error) {
    if (status) status.textContent = 'No se pudieron leer las tasas. Escríbelas manualmente.';
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Actualizar tasas ahora';
  }
}

async function saveConfig(event) {
  event.preventDefault();
  const button = $('#cfgSave');
  button.disabled = true;
  button.textContent = 'Guardando…';

  try {
    const payload = {
      tasa_bcv: Number($('#cfgTasaBcv').value),
      tasa_compra: Number($('#cfgTasaCompra').value),
      iva_pct: Number($('#cfgIva').value),
      margen_pct: Number($('#cfgMargen').value),
    };

    const response = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    state.config = response.config;
    $('#saleRate').value = Number(state.config.tasa_bcv).toFixed(2);
    fillConfigForm();
    toast('Configuración guardada');
    await loadAll();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Guardar configuración';
  }
}

/* ---------------- Navegación y eventos ---------------- */

function showView(name) {
  state.view = name;
  $$('.view').forEach((view) => view.classList.toggle('hidden', view.id !== `view-${name}`));
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  history.replaceState(null, '', `#${name}`);

  if (name === 'config') fillConfigForm();
  if (name === 'ventas') {
    renderCart();
    recalcSale();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindEvents() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#loginBtn');
    const error = $('#loginError');
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Entrando…';

    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: $('#password').value }),
      });
      $('#password').value = '';
      await showApp();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar al panel';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/login', { method: 'DELETE' });
    } catch {
      /* la sesión se limpia igual */
    }
    state.productos = [];
    state.cart = [];
    state.dashboard = null;
    showAuth();
  });

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      showView(tab.dataset.tab);
      return;
    }

    const go = event.target.closest('[data-go]');
    if (go) {
      showView(go.dataset.go);
      return;
    }

    const close = event.target.closest('[data-close]');
    if (close) {
      document.getElementById(close.dataset.close)?.close();
      return;
    }

    const filter = event.target.closest('[data-filter]');
    if (filter) {
      state.invFilter.estado = filter.dataset.filter;
      $$('#invStockFilter button').forEach((btn) => btn.classList.toggle('active', btn === filter));
      renderInventory();
      return;
    }

    const action = event.target.closest('[data-act]');
    if (!action) return;

    const id = action.dataset.id;
    switch (action.dataset.act) {
      case 'new-product':
        openProductDialog();
        break;
      case 'edit':
        openProductDialog(id);
        break;
      case 'adjust':
        openStockDialog(id);
        break;
      case 'delete':
        deleteProduct(id);
        break;
      case 'export':
        exportCsv();
        break;
      case 'refresh':
        loadAll().then((ok) => {
          if (ok) toast('Datos actualizados');
        });
        break;
      case 'cart-remove':
        state.cart = state.cart.filter((item) => item.id !== Number(id));
        renderCart();
        break;
      default:
        break;
    }
  });

  $('#invSearch').addEventListener('input', (event) => {
    state.invFilter.q = event.target.value;
    renderInventory();
  });

  $('#invCategory').addEventListener('change', (event) => {
    state.invFilter.categoria = event.target.value;
    renderInventory();
  });

  $('#movSearch').addEventListener('input', (event) => {
    state.movFilter.q = event.target.value;
    renderMovements();
  });

  $('#movType').addEventListener('change', (event) => {
    state.movFilter.tipo = event.target.value;
    renderMovements();
  });

  $('#saleSearch').addEventListener('input', renderSaleResults);

  $('#saleResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add]');
    if (button) addToCart(Number(button.dataset.add));
  });

  $('#saleRate').addEventListener('input', recalcSale);

  $('#cartList').addEventListener('input', (event) => {
    const qtyInput = event.target.closest('[data-cart-qty]');
    const priceInput = event.target.closest('[data-cart-price]');
    const id = Number(qtyInput?.dataset.cartQty || priceInput?.dataset.cartPrice);
    const item = state.cart.find((row) => row.id === id);
    if (!item) return;

    if (qtyInput) item.cantidad = Math.max(Number(qtyInput.value) || 0, 0);
    if (priceInput) item.precio = Math.max(Number(priceInput.value) || 0, 0);
    recalcSale();
  });

  $('#saleSubmit').addEventListener('click', submitSale);

  $('#productForm').addEventListener('submit', saveProduct);
  ['#prodCosto', '#prodMargen', '#prodIva'].forEach((selector) => {
    $(selector).addEventListener('input', updateProductPreview);
  });

  $('#prodPhotoInput').addEventListener('change', (event) => {
    const files = event.target.files;
    event.target.value = '';
    subirFotos(files);
  });

  $('#prodPhotoGrid').addEventListener('click', (event) => {
    const principal = event.target.closest('[data-photo-principal]');
    if (principal) {
      marcarFotoPrincipal(principal.dataset.photoPrincipal);
      return;
    }
    const eliminar = event.target.closest('[data-photo-delete]');
    if (eliminar) eliminarFoto(eliminar.dataset.photoDelete);
  });

  $('#stockForm').addEventListener('submit', saveStock);
  $('#stockTipo').addEventListener('change', () => {
    if ($('#stockTipo').value === 'ajuste') {
      $('#stockCantidad').value = state.stockProduct ? state.stockProduct.stock : 0;
    }
    updateStockPreview();
  });
  $('#stockCantidad').addEventListener('input', updateStockPreview);

  $('#configForm').addEventListener('submit', saveConfig);
  $('#cfgTasasFetch').addEventListener('click', actualizarTasas);
  ['#cfgTasaBcv', '#cfgTasaCompra', '#cfgIva', '#cfgMargen'].forEach((selector) => {
    $(selector).addEventListener('input', updateConfigExample);
  });

  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

bindEvents();
init();

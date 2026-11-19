const $ = (selector, root = document) => root.querySelector(selector);

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const bsFmt = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 });

const state = {
  productos: [],
  config: { tasa_bcv: 1, iva_pct: 16 },
  cart: [],
  tipoDocumento: 'factura',
};

function moneyUsd(value) {
  return usdFmt.format(Number(value) || 0);
}

function moneyBs(value) {
  return `Bs ${bsFmt.format(Number(value) || 0)}`;
}

function number(value) {
  return numFmt.format(Number(value) || 0);
}

function norm(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[char];
  });
}

function productById(id) {
  return state.productos.find((product) => product.id === Number(id));
}

function showState(message, error = false) {
  const stateEl = $('#posState');
  stateEl.hidden = !message;
  stateEl.textContent = message || '';
  stateEl.classList.toggle('error', error);
}

function renderResults() {
  const query = norm($('#productSearch').value);
  const container = $('#productResults');
  if (!query) {
    container.innerHTML = '';
    return;
  }

  const matches = state.productos
    .filter((product) => product.stock > 0)
    .filter((product) => [product.codigo, product.nombre, product.marca, product.categoria, product.descripcion, ...(product.tags || [])]
      .some((value) => norm(value).includes(query)))
    .slice(0, 10);

  if (!matches.length) {
    container.innerHTML = '<div class="empty pos-empty">No hay productos disponibles con ese criterio.</div>';
    return;
  }

  container.innerHTML = matches.map((product) => `
    <button class="pos-result" type="button" data-add-product="${product.id}">
      <span>
        <strong>${esc(product.nombre)}</strong>
        <small>${esc(product.codigo)} · ${number(product.stock)} disponibles</small>
      </span>
      <b>${moneyUsd(product.precio_usd)}</b>
    </button>
  `).join('');
}

function addProduct(id) {
  const product = productById(id);
  if (!product || product.stock <= 0) return;

  const existing = state.cart.find((item) => item.id === product.id);
  if (existing) {
    if (existing.cantidad < product.stock) existing.cantidad += 1;
  } else {
    state.cart.push({ id: product.id, cantidad: 1, precio: Number(product.precio_usd) || 0 });
  }

  $('#productSearch').value = '';
  $('#productResults').innerHTML = '';
  renderCart();
}

function renderCart() {
  const body = $('#cartBody');
  $('#cartEmpty').hidden = state.cart.length > 0;
  $('#itemCount').textContent = `${state.cart.length} ${state.cart.length === 1 ? 'producto' : 'productos'}`;

  body.innerHTML = state.cart.map((item) => {
    const product = productById(item.id);
    if (!product) return '';
    const displayPrice = state.tipoDocumento === 'nota_entrega'
      ? item.precio / (1 + (Number(state.config.iva_pct) || 16) / 100)
      : item.precio;
    const lineTotal = item.cantidad * displayPrice;
    return `
      <tr>
        <td>
          <div class="pos-product-name"><strong>${esc(product.nombre)}</strong><small>${esc(product.codigo)}</small></div>
        </td>
        <td class="right"><input class="pos-quantity" type="number" min="0.001" max="${product.stock}" step="0.001" value="${item.cantidad}" data-quantity="${product.id}" aria-label="Cantidad de ${esc(product.nombre)}"></td>
        <td class="right num">${moneyUsd(displayPrice)}</td>
        <td class="right num"><strong>${moneyUsd(lineTotal)}</strong></td>
        <td class="right"><button class="icon-btn danger" type="button" data-remove-product="${product.id}" title="Quitar producto" aria-label="Quitar producto">×</button></td>
      </tr>
    `;
  }).join('');

  renderTotals();
}

function renderTotals() {
  const iva = Number(state.config.iva_pct) || 16;
  const rate = Number(state.config.tasa_bcv) || 1;
  const subtotalBruto = state.cart.reduce((total, item) => total + item.cantidad * item.precio, 0);
  const subtotal = state.tipoDocumento === 'nota_entrega'
    ? subtotalBruto / (1 + iva / 100)
    : subtotalBruto;
  const ivaAmount = state.tipoDocumento === 'nota_entrega' ? 0 : subtotal - subtotal / (1 + iva / 100);
  const total = subtotal;

  $('#subtotalLabel').textContent = state.tipoDocumento === 'nota_entrega' ? 'Subtotal sin IVA' : 'Subtotal';
  $('#ivaRow').hidden = state.tipoDocumento === 'nota_entrega';
  $('#subtotalUsd').textContent = moneyUsd(subtotal);
  $('#ivaLabel').textContent = number(iva);
  $('#ivaUsd').textContent = moneyUsd(ivaAmount);
  $('#totalUsd').textContent = moneyUsd(total);
  $('#totalBs').textContent = moneyBs(total * rate);
  $('#rateLabel').textContent = `Tasa BCV aplicada: ${moneyBs(rate)}`;
  $('#issueInvoice').textContent = state.tipoDocumento === 'nota_entrega'
    ? 'Emitir Nota de Entrega'
    : 'Emitir Factura';
}

function updateQuantity(id, value) {
  const item = state.cart.find((row) => row.id === Number(id));
  const product = productById(id);
  if (!item || !product) return;
  item.cantidad = Math.min(Math.max(Number(value) || 0.001, 0.001), product.stock);
  renderCart();
}

async function loadData() {
  try {
    const response = await fetch('/api/productos', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo cargar el inventario.');
    state.productos = data.productos || [];
    state.config = data.config || state.config;
    $('#ivaLabel').textContent = number(state.config.iva_pct);
    $('#posContent').hidden = false;
    showState('');
    renderTotals();
  } catch (error) {
    showState(error.message, true);
  }
}

async function issueInvoice() {
  if (!state.cart.length) {
    showState('Agrega al menos un producto para emitir la factura.', true);
    return;
  }

  const overstock = state.cart.find((item) => {
    const product = productById(item.id);
    return !product || item.cantidad > product.stock;
  });
  if (overstock) {
    showState('Una de las cantidades supera el stock disponible.', true);
    return;
  }

  const button = $('#issueInvoice');
  button.disabled = true;
  button.textContent = 'Emitiendo...';

  const rif = $('#customerRif').value.trim();
  const note = $('#saleNote').value.trim();

  try {
    const response = await fetch('/api/ventas', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente: $('#customerName').value.trim(),
        rif_cliente: rif,
        tipo_documento: state.tipoDocumento,
        nota: note,
        tasa_bcv: Number(state.config.tasa_bcv),
        items: state.cart.map((item) => ({
          producto_id: item.id,
          cantidad: item.cantidad,
          precio_unitario_usd: item.precio,
        })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo emitir la factura.');
    const documentoUrl = state.tipoDocumento === 'nota_entrega' ? 'nota-entrega.html' : 'factura.html';
    window.location.href = `${documentoUrl}?id=${encodeURIComponent(data.venta.id)}`;
  } catch (error) {
    showState(error.message, true);
    button.disabled = false;
    button.textContent = state.tipoDocumento === 'nota_entrega' ? 'Emitir Nota de Entrega' : 'Emitir Factura';
  }
}

$('#productSearch').addEventListener('input', renderResults);
$('#productResults').addEventListener('click', (event) => {
  const result = event.target.closest('[data-add-product]');
  if (result) addProduct(result.dataset.addProduct);
});
$('#cartBody').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-product]');
  if (!remove) return;
  state.cart = state.cart.filter((item) => item.id !== Number(remove.dataset.removeProduct));
  renderCart();
});
$('#cartBody').addEventListener('change', (event) => {
  const quantity = event.target.closest('[data-quantity]');
  if (quantity) updateQuantity(quantity.dataset.quantity, quantity.value);
});
$('#issueInvoice').addEventListener('click', issueInvoice);
$('#documentType').addEventListener('change', (event) => {
  state.tipoDocumento = event.target.value;
  renderTotals();
});

loadData();

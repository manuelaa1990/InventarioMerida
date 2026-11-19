const $ = (selector) => document.querySelector(selector);

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const bsFmt = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTimeFmt = new Intl.DateTimeFormat('es-VE', { dateStyle: 'medium', timeStyle: 'short' });

function moneyUsd(value) {
  return usdFmt.format(Number(value) || 0);
}

function moneyBs(value) {
  return `Bs ${bsFmt.format(Number(value) || 0)}`;
}

function number(value) {
  return bsFmt.format(Number(value) || 0);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[char];
  });
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFmt.format(date);
}

function showError(message) {
  const state = $('#deliveryState');
  state.textContent = message;
  state.classList.add('error');
}

function renderDeliveryNote(venta) {
  const total = Number(venta.total_usd) || 0;
  const controlNumber = `00-${String(venta.id).padStart(4, '0')}`;
  const ivaFactor = 1.16;

  $('#deliveryNumber').textContent = controlNumber;
  $('#deliveryDate').textContent = formatDate(venta.fecha);
  $('#customerName').textContent = venta.cliente || 'Cliente general';
  $('#customerRif').textContent = venta.rif_cliente ? `RIF: ${venta.rif_cliente}` : 'RIF no indicado';
  $('#deliveryRate').textContent = moneyBs(venta.tasa_bcv);
  $('#deliveryNote').textContent = venta.nota ? `Nota: ${venta.nota}` : '';

  $('#deliveryItems').innerHTML = (venta.items || []).map((item) => {
    const price = Number(item.precio_unitario_usd || 0) / ivaFactor;
    const lineTotal = Number(item.cantidad || 0) * price;
    return `
      <tr>
        <td>${esc(item.codigo || '—')} · ${esc(item.nombre || 'Producto')}</td>
        <td class="right">${number(item.cantidad)}</td>
        <td class="right">${moneyUsd(price)}</td>
        <td class="right">${moneyUsd(lineTotal)}</td>
      </tr>
    `;
  }).join('');

  $('#deliveryTotal').textContent = `${moneyUsd(total)} · ${moneyBs(venta.total_bs)}`;
  $('#deliveryState').hidden = true;
  $('#deliveryLines').hidden = false;
  $('#deliverySummary').hidden = false;
}

async function loadDeliveryNote() {
  const id = new URLSearchParams(location.search).get('id');
  if (!/^\d+$/.test(id || '') || Number(id) <= 0) {
    showError('Indica un numero de nota valido en la URL.');
    return;
  }

  try {
    const response = await fetch(`/api/ventas?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo cargar la nota de entrega.');
    const venta = data.ventas?.[0];
    if (!venta || venta.tipo_documento !== 'nota_entrega') throw new Error('El documento solicitado no es una nota de entrega.');
    renderDeliveryNote(venta);
  } catch (error) {
    showError(error.message);
  }
}

$('#printDeliveryNote').addEventListener('click', () => window.print());
loadDeliveryNote();

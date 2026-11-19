const $ = (selector) => document.querySelector(selector);

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

const dateTimeFmt = new Intl.DateTimeFormat('es-VE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

// Completar estos datos con la informacion fiscal y de contacto del negocio.
const negocio = {
  rif: 'RIF:  J-508305876',
  direccion: 'CALLE DON BOSCO CASA N/A NRO S/N SECTOR CREOLANDIA, JUDIBANA, FALCON, VENEZUELA',
  telefono: 'Telefono: 04246926108 / 04126666397',
};

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

function setBusinessData() {
  $('#businessTaxId').textContent = negocio.rif;
  $('#businessAddress').textContent = negocio.direccion;
  $('#businessPhone').textContent = negocio.telefono;
}

function showError(message) {
  const state = $('#invoiceState');
  state.textContent = message;
  state.classList.add('error');
}

function renderInvoice(venta) {
  const lineTotal = (venta.items || []).reduce(
    (total, item) => total + Number(item.cantidad || 0) * Number(item.precio_unitario_usd || 0),
    0,
  );
  const storedTotal = Number(venta.total_usd);
  const total = Number.isFinite(storedTotal) ? storedTotal : lineTotal;
  const base = total / 1.16;
  const tax = total - base;
  const controlNumber = `00-${String(venta.id).padStart(4, '0')}`;

  $('#invoiceNumber').textContent = controlNumber;
  $('#invoiceDate').textContent = formatDate(venta.fecha);
  $('#customerName').textContent = venta.cliente || 'Cliente general';
  $('#customerRif').textContent = venta.rif_cliente ? `RIF: ${venta.rif_cliente}` : 'RIF no indicado';
  $('#invoiceRate').textContent = moneyBs(venta.tasa_bcv);
  $('#invoiceNote').textContent = venta.nota ? `Nota: ${venta.nota}` : '';

  $('#invoiceItems').innerHTML = (venta.items || []).map((item) => {
    const lineTotal = Number(item.cantidad || 0) * Number(item.precio_unitario_usd || 0);
    return `
      <tr>
        <td>${esc(item.codigo || '—')} · ${esc(item.nombre || 'Producto')}</td>
        <td class="right">${number(item.cantidad)}</td>
        <td class="right">${moneyUsd(item.precio_unitario_usd)}</td>
        <td class="right">${moneyUsd(lineTotal)}</td>
      </tr>
    `;
  }).join('');

  $('#invoiceBase').textContent = moneyUsd(base);
  $('#invoiceTax').textContent = moneyUsd(tax);
  $('#invoiceTotal').textContent = `${moneyUsd(total)} · ${moneyBs(venta.total_bs)}`;
  $('#invoiceState').hidden = true;
  $('#invoiceLines').hidden = false;
  $('#invoiceSummary').hidden = false;
}

async function loadInvoice() {
  setBusinessData();
  const id = new URLSearchParams(location.search).get('id');
  if (!/^\d+$/.test(id || '') || Number(id) <= 0) {
    showError('Indica un numero de factura valido en la URL.');
    return;
  }

  try {
    const response = await fetch(`/api/ventas?id=${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo cargar la factura.');
    renderInvoice(data.ventas?.[0]);
  } catch (error) {
    showError(error.message);
  }
}

$('#printInvoice').addEventListener('click', () => window.print());
loadInvoice();

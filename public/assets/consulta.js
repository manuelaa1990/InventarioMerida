/* ============================================================
   Inventario HVAC - consulta pública
   Solo consume /api/public/consulta (sin costos ni márgenes).
   ============================================================ */

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

const numFmt = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 });
const dateTimeFmt = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

let currentQuery = '';
let debounceTimer = null;
let controller = null;

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

const moneyUsd = (value) => usdFmt.format(Number(value) || 0);
const moneyBs = (value) => `Bs ${bsFmt.format(Number(value) || 0)}`;
const number = (value) => numFmt.format(Number(value) || 0);

function stateBadge(estado) {
  if (estado === 'agotado') return '<span class="badge out"><span class="dot"></span>Agotado</span>';
  if (estado === 'bajo') return '<span class="badge low"><span class="dot"></span>Últimas unidades</span>';
  return '<span class="badge ok"><span class="dot"></span>Disponible</span>';
}

function renderSkeleton(count = 8) {
  $('#results').innerHTML = Array.from({ length: count }).map(() => `
    <div class="product-card">
      <div class="skeleton media-skeleton"></div>
      <div class="skeleton" style="height:16px; width:80%;"></div>
      <div class="skeleton" style="height:12px; width:45%;"></div>
      <div class="skeleton" style="height:12px; width:100%;"></div>
      <div class="skeleton" style="height:28px; width:100%; margin-top:8px;"></div>
    </div>
  `).join('');
}

function cardMedia(product) {
  if (!product.imagen) return '';
  return `
    <div class="card-media">
      <img src="${esc(product.imagen)}" alt="${esc(product.imagen_alt || product.nombre)}" loading="lazy" decoding="async">
    </div>
  `;
}

function render(data) {
  const products = data.productos || [];
  $('#resultCount').textContent = products.length === 1
    ? 'Mostrando 1 producto'
    : `Mostrando ${products.length} productos`;

  $('#rateInfo').textContent = data.tasa_bcv
    ? `Tasa BCV: Bs ${number(data.tasa_bcv)} / USD · Precios con IVA incluido`
    : 'Precios con IVA incluido';

  $('#updatedAt').textContent = data.actualizado
    ? `Actualizado: ${dateTimeFmt.format(new Date(data.actualizado))}`
    : '';

  if (!products.length) {
    $('#results').innerHTML = '';
    $('#emptyState').classList.remove('hidden');
    $('#emptyState').innerHTML = `
      <strong>No encontramos ese repuesto</strong>
      Prueba con otro código, nombre o palabra clave.
    `;
    return;
  }

  $('#emptyState').classList.add('hidden');

  $('#results').innerHTML = products.map((product) => `
    <article class="product-card">
      ${cardMedia(product)}
      <div class="head">
        <div>
          <h3>${esc(product.nombre)}</h3>
          ${product.marca ? `<div class="brand">${esc(product.marca)}</div>` : ''}
          <div class="code">${esc(product.codigo)}</div>
        </div>
        ${stateBadge(product.estado)}
      </div>
      ${product.descripcion ? `<p class="desc">${esc(product.descripcion)}</p>` : ''}
      <div class="cat">
        ${esc(product.categoria)}${product.presentacion ? ` · ${esc(product.presentacion)}` : ''}
      </div>
      <div class="prices">
        <div>
          ${product.precio_disponible
            ? `<div class="usd">${moneyUsd(product.precio_usd)}</div>
               <div class="tiny muted">IVA incluido</div>`
            : `<div class="usd" style="font-size:.98rem;">Consultar precio</div>
               <div class="tiny muted">Disponible en tienda</div>`}
        </div>
        <div class="bs">
          ${product.precio_disponible ? `${moneyBs(product.precio_bs)}<br><span class="tiny">referencial</span>` : ''}
        </div>
      </div>
    </article>
  `).join('');
}

function renderError(message) {
  $('#results').innerHTML = '';
  $('#resultCount').textContent = 'No se pudo cargar el catálogo';
  $('#rateInfo').textContent = '';
  $('#emptyState').classList.remove('hidden');
  $('#emptyState').innerHTML = `
    <strong>No pudimos conectar con el inventario</strong>
    ${esc(message)}<br><br>
    <button type="button" class="btn ghost sm" id="retryBtn">Reintentar</button>
  `;
  $('#retryBtn')?.addEventListener('click', () => load());
}

async function load() {
  if (controller) controller.abort();
  controller = new AbortController();
  renderSkeleton();

  const params = new URLSearchParams();
  if (currentQuery) params.set('q', currentQuery);

  try {
    const response = await fetch(`/api/public/consulta?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Error ${response.status}`);
    }

    const data = await response.json();
    render(data);
  } catch (error) {
    if (error.name === 'AbortError') return;
    renderError(error.message || 'Error de conexión');
  }
}

function onSearch(value) {
  currentQuery = value.trim();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 300);
}

$('#searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(debounceTimer);
  currentQuery = $('#searchInput').value.trim();
  load();
});

$('#searchInput').addEventListener('input', (event) => onSearch(event.target.value));

load();

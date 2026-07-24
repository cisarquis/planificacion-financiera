// ============================================================================
// app.js — Orquestador: navegación, estado, cálculos y render de cada vista.
// ============================================================================
(function () {
  'use strict';

  // ------------------------------------------------------------------ Utils
  const MESES_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  const PF = {
    fmtNum(v) {
      if (v === null || v === undefined || isNaN(v)) return '—';
      return Math.round(v).toLocaleString('es-CL');
    },
    fmtMoney(v, moneda) {
      if (v === null || v === undefined || isNaN(v)) return '—';
      const n = PF.fmtNum(v);
      return (moneda || state.config.moneda) === 'CLP' ? '$' + n : n + ' UF';
    },
    monthLabel(key) {
      if (!key) return '';
      const [y, m] = key.split('-').map(Number);
      return MESES_ABBR[m - 1] + '-' + String(y).slice(2);
    },
    addMonth(key, delta) {
      let [y, m] = key.split('-').map(Number);
      m += delta;
      y += Math.floor((m - 1) / 12);
      m = ((m - 1) % 12 + 12) % 12 + 1;
      return y + '-' + String(m).padStart(2, '0');
    },
    monthRange(start, end) {
      const out = [];
      if (!start || !end || start > end) return out;
      let cur = start;
      while (cur <= end) { out.push(cur); cur = PF.addMonth(cur, 1); }
      return out;
    },
    currentMonth() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    },
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
  };
  window.PF = PF;

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast align-items-center text-bg-' + (type || 'primary') + ' border-0 show';
    el.role = 'alert';
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${PF.esc(msg)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ------------------------------------------------------------------ Estado
  const state = {
    mode: 'local',
    user: null,
    config: { cajaInicial: 0, mesInicial: '', moneda: 'UF', umbralAlerta: 0 },
    categorias: [],
    proyectos: [],
    cajaReal: {},
    currentProyectoId: null,
  };

  async function loadAll() {
    const [config, categorias, proyectos, cajaReal] = await Promise.all([
      DB.getConfig(), DB.listCategorias(), DB.listProyectos(), DB.getCajaReal(),
    ]);
    state.config = config;
    state.categorias = categorias;
    state.proyectos = proyectos;
    state.cajaReal = cajaReal;
    document.getElementById('moneda-label').textContent = config.moneda;
  }

  // ------------------------------------------------------- Cálculos derivados
  // Une todos los meses con datos (+ mesInicial) y genera rango continuo.
  function allMonths(proyectos) {
    const set = new Set();
    (proyectos || state.proyectos).forEach((p) => {
      Object.keys(p.proyeccion || {}).forEach((k) => set.add(k));
    });
    Object.keys(state.cajaReal || {}).forEach((k) => set.add(k));
    if (state.config.mesInicial) set.add(state.config.mesInicial);
    if (!set.size) return [];
    const keys = Array.from(set).sort();
    return PF.monthRange(keys[0], keys[keys.length - 1]);
  }

  // Flujo neto consolidado por mes (sobre un subconjunto opcional de proyectos).
  function netByMonth(months, proyectos) {
    const list = proyectos || state.proyectos;
    const net = {};
    months.forEach((m) => { net[m] = 0; });
    list.forEach((p) => {
      const pr = p.proyeccion || {};
      months.forEach((m) => { if (pr[m]) net[m] += pr[m]; });
    });
    return net;
  }

  // Serie de caja proyectada acumulada partiendo de cajaInicial.
  function projectedSeries(months, net) {
    let acc = Number(state.config.cajaInicial) || 0;
    const out = {};
    months.forEach((m) => { acc += (net[m] || 0); out[m] = acc; });
    return out;
  }

  // Construye todo el "timeline" para dashboard/reportes.
  function buildTimeline(proyectos) {
    const months = allMonths(proyectos);
    const net = netByMonth(months, proyectos);
    const proj = projectedSeries(months, net);
    const real = {};
    months.forEach((m) => { if (state.cajaReal[m]) real[m] = state.cajaReal[m].monto; });

    // Mínimo de caja proyectada (alerta de liquidez).
    let minAcc = null, minMonth = null;
    months.forEach((m) => { if (minAcc === null || proj[m] < minAcc) { minAcc = proj[m]; minMonth = m; } });

    // Aportes (negativos) y devoluciones (positivos) totales.
    let aportes = 0, devoluciones = 0;
    months.forEach((m) => { if (net[m] < 0) aportes += net[m]; else devoluciones += net[m]; });

    return { months, net, proj, real, minAcc, minMonth, aportes, devoluciones };
  }

  function categoriaNombre(id) {
    const c = state.categorias.find((x) => x.id === id);
    return c ? c.nombre : 'Sin categoría';
  }

  // ------------------------------------------------------------- Navegación
  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.add('d-none'));
    const el = document.getElementById(id);
    if (el) el.classList.remove('d-none');
    document.querySelectorAll('.sidebar-nav .nav-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.view === id);
    });
    const titles = {
      dashboard: 'Consolidado', 'categorias-view': 'Por categoría', proyectos: 'Por proyecto',
      importar: 'Importar Excel', caja: 'Caja del banco', pagos: 'Programar pagos',
      reportes: 'Reportes', config: 'Configuración',
    };
    document.getElementById('view-title').textContent = titles[id] || '';
    const renders = {
      dashboard: renderDashboard, 'categorias-view': renderCategoriasView, proyectos: renderProyectos,
      importar: renderImportar, caja: renderCaja, pagos: renderPagos,
      reportes: renderReportes, config: renderConfig,
    };
    if (renders[id]) renders[id]();
  }

  function wireNav() {
    document.querySelectorAll('.sidebar-nav .nav-link').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
    });
  }

  // ------------------------------------------------------------- Vista: Dashboard
  function renderDashboard() {
    const el = document.getElementById('dashboard');
    if (!state.proyectos.length) { el.innerHTML = emptyState('No hay proyectos todavía', 'Importa un Excel para comenzar.', 'importar'); wireEmpty(el); return; }

    const t = buildTimeline();
    const cur = PF.currentMonth();
    // Si el mes actual no tiene proyección (fuera del rango de datos), usa el mes
    // disponible más cercano y refleja ESE mes en la etiqueta (nunca "cur" a secas).
    const cajaActualMonth = (t.proj[cur] != null) ? cur
      : (t.months.length ? (cur < t.months[0] ? t.months[0] : t.months[t.months.length - 1]) : null);
    const cajaActual = state.cajaReal[cur] ? state.cajaReal[cur].monto : (cajaActualMonth ? t.proj[cajaActualMonth] : null);
    const decKey = new Date().getFullYear() + '-12';
    const finAnioMonth = (t.proj[decKey] != null) ? decKey
      : (t.months.length ? t.months[t.months.length - 1] : null);
    const finAnio = finAnioMonth ? t.proj[finAnioMonth] : null;
    const alerta = t.minAcc != null && t.minAcc < (Number(state.config.umbralAlerta) || 0);

    el.innerHTML = `
      <div class="kpi-grid">
        ${kpiCard('Caja actual', PF.fmtMoney(cajaActual), state.cajaReal[cur] ? 'Real (banco), ' + PF.monthLabel(cur) : 'Proyectada, ' + PF.monthLabel(cajaActualMonth))}
        ${kpiCard('Caja proyectada fin de año', PF.fmtMoney(finAnio), 'A ' + PF.monthLabel(finAnioMonth))}
        ${kpiCard('Aportes proyectados', PF.fmtMoney(t.aportes), 'Total egresos', 'neg')}
        ${kpiCard('Devoluciones proyectadas', PF.fmtMoney(t.devoluciones), 'Total ingresos', 'pos')}
        ${kpiCard('Mínimo de caja', PF.fmtMoney(t.minAcc), 'En ' + PF.monthLabel(t.minMonth), alerta ? 'neg' : '', alerta)}
      </div>
      ${alerta ? `<div class="alert alert-danger"><i class="bi bi-exclamation-triangle-fill me-1"></i>
        Alerta de liquidez: la caja proyectada cae a <b>${PF.fmtMoney(t.minAcc)}</b> en <b>${PF.monthLabel(t.minMonth)}</b>
        (bajo el umbral de ${PF.fmtMoney(state.config.umbralAlerta)}).</div>` : ''}

      <div class="panel">
        <div class="d-flex justify-content-between align-items-center">
          <h6 class="mb-0">Caja proyectada acumulada vs. caja real</h6>
          <span class="text-muted small">Caja inicial: ${PF.fmtMoney(state.config.cajaInicial)}</span>
        </div>
        <div class="chart-box mt-3"><canvas id="chart-proj-real"></canvas></div>
      </div>

      <div class="panel">
        <h6>Flujo neto mensual consolidado (aportes / devoluciones)</h6>
        <div class="chart-box"><canvas id="chart-flujo"></canvas></div>
      </div>`;

    const labels = t.months.map(PF.monthLabel);
    PFCharts.lineProjVsReal('chart-proj-real', labels, t.months.map((m) => t.proj[m]), t.months.map((m) => (t.real[m] != null ? t.real[m] : null)));
    PFCharts.barFlujoMensual('chart-flujo', labels, t.months.map((m) => t.net[m]));
  }

  // ------------------------------------------------------- Vista: Por categoría
  function renderCategoriasView() {
    const el = document.getElementById('categorias-view');
    if (!state.proyectos.length) { el.innerHTML = emptyState('Sin datos', 'Importa proyectos para ver el desglose por categoría.', 'importar'); wireEmpty(el); return; }

    const months = allMonths();
    const labels = months.map(PF.monthLabel);

    // Serie por categoría (flujo neto por mes) + aportes absolutos por categoría.
    const series = [], aportesCat = [], catNames = [];
    state.categorias.forEach((cat) => {
      const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
      if (!proys.length) return;
      const net = netByMonth(months, proys);
      series.push({ nombre: cat.nombre, data: months.map((m) => net[m]) });
      catNames.push(cat.nombre);
      let ap = 0; months.forEach((m) => { if (net[m] < 0) ap += net[m]; });
      aportesCat.push(Math.abs(ap));
    });

    // Tabla resumen por categoría.
    const rows = state.categorias.map((cat) => {
      const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
      const net = netByMonth(months, proys);
      let ap = 0, dev = 0;
      months.forEach((m) => { if (net[m] < 0) ap += net[m]; else dev += net[m]; });
      return `<tr><td>${PF.esc(cat.nombre)}</td><td class="num">${proys.length}</td>
        <td class="num neg">${PF.fmtMoney(ap)}</td><td class="num pos">${PF.fmtMoney(dev)}</td>
        <td class="num ${ap + dev < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(ap + dev)}</td></tr>`;
    }).join('');

    el.innerHTML = `
      <div class="row g-3">
        <div class="col-lg-7"><div class="panel"><h6>Flujo neto por categoría (mensual)</h6>
          <div class="chart-box"><canvas id="chart-cat-stack"></canvas></div></div></div>
        <div class="col-lg-5"><div class="panel"><h6>Participación en aportes</h6>
          <div class="chart-box sm"><canvas id="chart-cat-dona"></canvas></div></div></div>
      </div>
      <div class="panel">
        <h6>Resumen por categoría</h6>
        <table class="table table-sm">
          <thead><tr><th>Categoría</th><th class="num">Proyectos</th><th class="num">Aportes</th>
            <th class="num">Devoluciones</th><th class="num">Neto</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    PFCharts.stackedByCategoria('chart-cat-stack', labels, series);
    PFCharts.doughnutCategorias('chart-cat-dona', catNames, aportesCat);
  }

  // ------------------------------------------------------- Vista: Por proyecto
  function renderProyectos() {
    const el = document.getElementById('proyectos');
    const porCat = state.categorias.map((cat) => {
      const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
      const items = proys.map((p) => proyectoCard(p)).join('') || '<div class="text-muted small px-2">Sin proyectos</div>';
      return `<div class="mb-3"><div class="fw-semibold mb-2">${PF.esc(cat.nombre)}
        <span class="text-muted small">(${proys.length})</span></div>
        <div class="row g-2">${items}</div></div>`;
    }).join('');
    const sinCat = state.proyectos.filter((p) => !state.categorias.some((c) => c.id === p.categoriaId));
    el.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3">
        <span class="text-muted">${state.proyectos.length} proyecto(s)</span>
        <button class="btn btn-sm btn-primary" id="btn-nuevo-proj"><i class="bi bi-plus-lg"></i> Nuevo proyecto</button>
      </div>
      ${porCat}
      ${sinCat.length ? `<div class="mb-3"><div class="fw-semibold mb-2 text-muted">Sin categoría</div>
        <div class="row g-2">${sinCat.map(proyectoCard).join('')}</div></div>` : ''}
      <div id="proj-detail"></div>`;

    document.getElementById('btn-nuevo-proj').addEventListener('click', () => nuevoProyectoDialog());
    el.querySelectorAll('[data-proj]').forEach((c) => c.addEventListener('click', () => renderProyectoDetail(c.dataset.proj)));
  }

  function proyectoCard(p) {
    const months = Object.keys(p.proyeccion || {}).sort();
    const total = Object.values(p.proyeccion || {}).reduce((a, b) => a + b, 0);
    return `<div class="col-md-4 col-lg-3">
      <div class="panel mb-0" style="cursor:pointer" data-proj="${p.id}">
        <div class="fw-semibold text-truncate">${PF.esc(p.nombre)}</div>
        <div class="text-muted small mb-2">${PF.esc(categoriaNombre(p.categoriaId))}</div>
        <div class="small">Meses: ${months.length}</div>
        <div class="small ${total < 0 ? 'neg' : 'pos'}">Neto: ${PF.fmtMoney(total, p.moneda)}</div>
      </div></div>`;
  }

  function renderProyectoDetail(id) {
    state.currentProyectoId = id;
    const p = state.proyectos.find((x) => x.id === id);
    const box = document.getElementById('proj-detail');
    if (!p) { box.innerHTML = ''; return; }
    const months = allMonths([p]);
    const net = {}; months.forEach((m) => { net[m] = (p.proyeccion || {})[m] || 0; });
    const proj = (() => { let acc = 0; const o = {}; months.forEach((m) => { acc += net[m]; o[m] = acc; }); return o; })();

    box.innerHTML = `
      <div class="panel">
        <div class="d-flex justify-content-between align-items-start">
          <div>
            <h6 class="mb-1">${PF.esc(p.nombre)}</h6>
            <span class="text-muted small">${PF.esc(categoriaNombre(p.categoriaId))} · ${p.moneda || state.config.moneda}
            ${p.ultimaImportacion ? '· última importación: ' + PF.esc(p.ultimaImportacion.fileName || '') : ''}</span>
          </div>
          <div>
            <button class="btn btn-sm btn-outline-secondary" id="btn-edit-proj"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-danger" id="btn-del-proj"><i class="bi bi-trash"></i></button>
          </div>
        </div>
        <div class="chart-box mt-3"><canvas id="chart-proj-detail"></canvas></div>
      </div>`;

    const labels = months.map(PF.monthLabel);
    PFCharts.destroy('chart-proj-detail');
    const c = document.getElementById('chart-proj-detail').getContext('2d');
    new Chart(c, {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Flujo mensual', data: months.map((m) => net[m]),
            backgroundColor: months.map((m) => (net[m] >= 0 ? PFCharts.COLORS.ingreso : PFCharts.COLORS.egreso)) },
          { type: 'line', label: 'Acumulado', data: months.map((m) => proj[m]),
            borderColor: PFCharts.COLORS.proy, tension: .25, pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${PF.fmtNum(it.parsed.y)}` } } },
        scales: { y: { ticks: { callback: PF.fmtNum } } } },
    });
    document.getElementById('btn-edit-proj').addEventListener('click', () => nuevoProyectoDialog(p));
    document.getElementById('btn-del-proj').addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el proyecto "${p.nombre}"? Esto borra su proyección.`)) return;
      await DB.deleteProyecto(p.id); await loadAll(); toast('Proyecto eliminado', 'danger'); renderProyectos();
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Diálogo crear/editar proyecto (usa prompt simple con modal Bootstrap).
  function nuevoProyectoDialog(proj) {
    const isEdit = !!proj;
    const opts = state.categorias.map((c) =>
      `<option value="${c.id}" ${proj && proj.categoriaId === c.id ? 'selected' : ''}>${PF.esc(c.nombre)}</option>`).join('');
    const html = `
      <div class="modal fade" tabindex="-1" id="proj-modal"><div class="modal-dialog"><div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${isEdit ? 'Editar' : 'Nuevo'} proyecto</h5>
          <button class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body">
          <div class="mb-2"><label class="form-label small">Nombre</label>
            <input class="form-control" id="mp-nombre" value="${isEdit ? PF.esc(proj.nombre) : ''}"></div>
          <div class="mb-2"><label class="form-label small">Categoría</label>
            <select class="form-select" id="mp-cat">${opts}</select></div>
          <div class="mb-2"><label class="form-label small">Moneda</label>
            <select class="form-select" id="mp-moneda">
              <option value="UF" ${!proj || proj.moneda === 'UF' ? 'selected' : ''}>UF</option>
              <option value="CLP" ${proj && proj.moneda === 'CLP' ? 'selected' : ''}>CLP</option>
            </select></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
          <button class="btn btn-primary" id="mp-save">Guardar</button></div>
      </div></div></div>`;
    const wrap = document.createElement('div'); wrap.innerHTML = html; document.body.appendChild(wrap);
    const modal = new bootstrap.Modal(wrap.querySelector('#proj-modal'));
    modal.show();
    wrap.querySelector('#proj-modal').addEventListener('hidden.bs.modal', () => wrap.remove());
    wrap.querySelector('#mp-save').addEventListener('click', async () => {
      const nombre = wrap.querySelector('#mp-nombre').value.trim();
      if (!nombre) { toast('Ingresa un nombre', 'warning'); return; }
      const data = { nombre, categoriaId: wrap.querySelector('#mp-cat').value, moneda: wrap.querySelector('#mp-moneda').value };
      if (isEdit) await DB.updateProyecto(proj.id, data); else await DB.addProyecto(data);
      await loadAll(); modal.hide(); toast('Proyecto guardado', 'success'); renderProyectos();
    });
  }

  // ------------------------------------------------------- Vista: Importar
  let importState = null;

  function renderImportar() {
    const el = document.getElementById('importar');
    const projOpts = state.proyectos.map((p) => `<option value="${p.id}">${PF.esc(p.nombre)} — ${PF.esc(categoriaNombre(p.categoriaId))}</option>`).join('');
    const catOpts = state.categorias.map((c) => `<option value="${c.id}">${PF.esc(c.nombre)}</option>`).join('');
    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">1</span> ¿A qué proyecto pertenece este Excel?</h6>
        <div class="row g-2 align-items-end">
          <div class="col-md-5">
            <label class="form-label small">Proyecto existente</label>
            <select class="form-select" id="imp-proj"><option value="">— Crear proyecto nuevo —</option>${projOpts}</select>
          </div>
          <div class="col-md-4" id="imp-new-name-box">
            <label class="form-label small">Nombre del nuevo proyecto</label>
            <input class="form-control" id="imp-new-name" placeholder="Ej: Edificio Matta">
          </div>
          <div class="col-md-3" id="imp-new-cat-box">
            <label class="form-label small">Categoría</label>
            <select class="form-select" id="imp-new-cat">${catOpts}</select>
          </div>
        </div>
      </div>
      <div class="panel">
        <h6><span class="step-badge">2</span> Sube el Excel del proyecto</h6>
        <div class="dropzone" id="imp-drop">
          <i class="bi bi-file-earmark-excel fs-1"></i>
          <div class="mt-2">Arrastra el archivo aquí o haz clic para seleccionar</div>
          <div class="small">.xlsx / .xlsm / .xls</div>
        </div>
        <input type="file" id="imp-file" accept=".xlsx,.xls,.xlsm" class="d-none">
      </div>
      <div id="imp-map"></div>`;

    const projSel = el.querySelector('#imp-proj');
    const toggleNew = () => {
      const isNew = !projSel.value;
      el.querySelector('#imp-new-name-box').style.display = isNew ? '' : 'none';
      el.querySelector('#imp-new-cat-box').style.display = isNew ? '' : 'none';
    };
    projSel.addEventListener('change', toggleNew); toggleNew();

    const drop = el.querySelector('#imp-drop');
    const fileInput = el.querySelector('#imp-file');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  }

  async function handleFile(file) {
    try {
      const { wb, sheetNames } = await PFImporter.parseFile(file);
      // Preferir una hoja llamada "Planificación Financiera" si existe.
      const pref = sheetNames.find((n) => /planificaci/i.test(n)) || sheetNames[0];
      importState = { file, wb, sheetNames, sheet: pref };
      renderMapping();
    } catch (e) {
      console.error(e); toast('No se pudo leer el archivo: ' + e.message, 'danger');
    }
  }

  function renderMapping() {
    const box = document.getElementById('imp-map');
    const { wb, sheetNames, sheet } = importState;
    const grid = PFImporter.sheetToGrid(wb, sheet);
    importState.grid = grid;
    const det = PFImporter.detectRows(grid);
    if (importState.monthRow == null) importState.monthRow = det.monthRow;
    if (importState.flowRows == null) importState.flowRows = det.flowRow >= 0 ? [det.flowRow] : [];
    if (importState.invert == null) importState.invert = false;

    const rowOpts = (sel, multi) => grid.map((_, r) =>
      `<option value="${r}" ${(multi ? importState.flowRows.includes(r) : importState.monthRow === r) ? 'selected' : ''}>
        Fila ${r + 1}: ${PF.esc(PFImporter.rowLabel(grid, r).slice(0, 40))}</option>`).join('');

    const sheetOpts = sheetNames.map((n) => `<option ${n === sheet ? 'selected' : ''}>${PF.esc(n)}</option>`).join('');

    box.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">3</span> Mapea los datos</h6>
        <div class="row g-2 align-items-end mb-3">
          <div class="col-md-4"><label class="form-label small">Hoja</label>
            <select class="form-select" id="imp-sheet">${sheetOpts}</select></div>
          <div class="col-md-4"><label class="form-label small">Fila de meses (fechas)</label>
            <select class="form-select" id="imp-monthrow">${rowOpts(false, false)}</select></div>
          <div class="col-md-4"><label class="form-label small">Fila(s) de flujo (Ctrl para varias)</label>
            <select class="form-select" id="imp-flowrows" multiple size="4">${rowOpts(true, true)}</select></div>
        </div>
        <div class="form-check mb-3">
          <input class="form-check-input" type="checkbox" id="imp-invert" ${importState.invert ? 'checked' : ''}>
          <label class="form-check-label small" for="imp-invert">Invertir signo (si los aportes vinieran en positivo)</label>
        </div>
        <div id="imp-preview"></div>
        <div id="imp-summary" class="mt-3"></div>
        <button class="btn btn-primary mt-3" id="imp-save"><i class="bi bi-check-lg"></i> Guardar proyección</button>
      </div>`;

    box.querySelector('#imp-sheet').addEventListener('change', (e) => {
      importState.sheet = e.target.value; importState.monthRow = null; importState.flowRows = null; renderMapping();
    });
    box.querySelector('#imp-monthrow').addEventListener('change', (e) => { importState.monthRow = +e.target.value; updatePreview(); });
    box.querySelector('#imp-flowrows').addEventListener('change', (e) => {
      importState.flowRows = Array.from(e.target.selectedOptions).map((o) => +o.value); updatePreview();
    });
    box.querySelector('#imp-invert').addEventListener('change', (e) => { importState.invert = e.target.checked; updatePreview(); });
    box.querySelector('#imp-save').addEventListener('click', saveImport);

    updatePreview();
  }

  function updatePreview() {
    const grid = importState.grid;
    const { monthRow, flowRows } = importState;
    // Vista previa: primeras ~14 columnas, marca fila de meses y de flujo.
    const maxCols = Math.min(15, grid.reduce((m, r) => Math.max(m, (r || []).length), 0));
    const showRows = [];
    const rowsToShow = new Set([monthRow, ...flowRows]);
    for (let r = 0; r < grid.length && showRows.length < 12; r++) {
      if (rowsToShow.has(r) || showRows.length < 8) showRows.push(r);
    }
    let html = '<div class="preview-grid"><table class="table table-sm mb-0"><tbody>';
    showRows.forEach((r) => {
      const cls = r === monthRow ? 'row-months' : (flowRows.includes(r) ? 'row-flow' : '');
      html += `<tr class="${cls}"><th class="text-muted">${r + 1}</th>`;
      for (let c = 0; c < maxCols; c++) {
        let v = (grid[r] || [])[c];
        if (r === monthRow) { const d = PFImporter.cellToDate(v); if (d) v = PF.monthLabel(PFImporter.dateToMonthKey(d)); }
        else if (typeof v === 'number') v = PF.fmtNum(v);
        html += `<td>${PF.esc(v == null ? '' : v)}</td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    document.getElementById('imp-preview').innerHTML = html;

    // Resumen.
    const sum = document.getElementById('imp-summary');
    if (monthRow >= 0 && flowRows.length) {
      const { proyeccion, meta } = PFImporter.extractProjection(grid, importState);
      importState.proyeccion = proyeccion;
      sum.innerHTML = `<div class="alert alert-info py-2 mb-0">
        <b>${meta.count}</b> meses detectados (${PF.monthLabel(meta.minMonth)} → ${PF.monthLabel(meta.maxMonth)}).
        Neto total: <b class="${meta.total < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(meta.total)}</b>.
        <span class="text-muted">Azul = fila de meses · Verde = fila(s) de flujo. Ajusta arriba si no coincide.</span></div>`;
    } else {
      importState.proyeccion = null;
      sum.innerHTML = `<div class="alert alert-warning py-2 mb-0">Selecciona la fila de meses y al menos una fila de flujo.</div>`;
    }
  }

  async function saveImport() {
    if (!importState || !importState.proyeccion || !Object.keys(importState.proyeccion).length) {
      toast('No hay proyección válida para guardar', 'warning'); return;
    }
    const el = document.getElementById('importar');
    let projId = el.querySelector('#imp-proj').value;
    const meta = { fileName: importState.file.name, sheet: importState.sheet, importedAt: Date.now() };

    if (!projId) {
      const nombre = el.querySelector('#imp-new-name').value.trim();
      if (!nombre) { toast('Ingresa el nombre del nuevo proyecto', 'warning'); return; }
      const p = await DB.addProyecto({
        nombre, categoriaId: el.querySelector('#imp-new-cat').value, moneda: state.config.moneda,
        proyeccion: importState.proyeccion, ultimaImportacion: meta,
      });
      projId = p.id;
    } else {
      // Fusiona la proyección importada con la existente (sobrescribe meses repetidos).
      const existing = state.proyectos.find((p) => p.id === projId);
      const merged = Object.assign({}, existing ? existing.proyeccion : {}, importState.proyeccion);
      await DB.updateProyecto(projId, { proyeccion: merged, ultimaImportacion: meta });
    }
    await DB.addImportLog({ projId, fileName: meta.fileName, sheet: meta.sheet, meses: Object.keys(importState.proyeccion).length, byEmail: state.user ? state.user.email : 'local' });
    await loadAll();
    importState = null;
    toast('Proyección importada correctamente', 'success');
    showView('proyectos');
    renderProyectoDetail(projId);
  }

  // ------------------------------------------------------- Vista: Caja del banco
  function renderCaja() {
    const el = document.getElementById('caja');
    const months = allMonths();
    const t = state.proyectos.length ? buildTimeline() : { proj: {} };
    const rows = months.map((m) => {
      const real = state.cajaReal[m] ? state.cajaReal[m].monto : '';
      const proj = t.proj[m];
      const desv = (real !== '' && proj != null) ? real - proj : null;
      return `<tr>
        <td>${PF.monthLabel(m)}</td>
        <td class="num">${proj != null ? PF.fmtMoney(proj) : '—'}</td>
        <td class="num" style="width:160px"><input type="number" class="form-control form-control-sm num caja-input" data-mes="${m}" value="${real}"></td>
        <td class="num ${desv == null ? '' : (desv < 0 ? 'neg' : 'pos')}">${desv == null ? '—' : PF.fmtMoney(desv)}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="panel">
        <h6>Punto de partida</h6>
        <div class="row g-2 align-items-end">
          <div class="col-md-4"><label class="form-label small">Caja inicial (${state.config.moneda})</label>
            <input type="number" class="form-control" id="cfg-caja-inicial" value="${state.config.cajaInicial}"></div>
          <div class="col-md-4"><label class="form-label small">Mes inicial</label>
            <input type="month" class="form-control" id="cfg-mes-inicial" value="${state.config.mesInicial}"></div>
          <div class="col-md-4"><button class="btn btn-primary" id="cfg-save-caja">Guardar</button></div>
        </div>
      </div>
      <div class="panel">
        <h6>Caja real del banco (ingresa el saldo de cada mes)</h6>
        ${months.length ? `<table class="table table-sm">
          <thead><tr><th>Mes</th><th class="num">Caja proyectada</th><th class="num">Caja real (banco)</th><th class="num">Desviación</th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="text-muted">Importa proyectos para ver los meses.</div>'}
      </div>`;

    el.querySelector('#cfg-save-caja').addEventListener('click', async () => {
      await DB.setConfig({
        cajaInicial: Number(el.querySelector('#cfg-caja-inicial').value) || 0,
        mesInicial: el.querySelector('#cfg-mes-inicial').value || '',
      });
      await loadAll(); toast('Guardado', 'success'); renderCaja();
    });
    el.querySelectorAll('.caja-input').forEach((inp) => {
      inp.addEventListener('change', async () => {
        await DB.setCajaRealMes(inp.dataset.mes, inp.value);
        await loadAll(); renderCaja();
      });
    });
  }

  // ------------------------------------------------------- Vista: Programar pagos
  function renderPagos() {
    const el = document.getElementById('pagos');
    const cur = PF.currentMonth();
    const months = allMonths().filter((m) => m >= cur);
    if (!months.length) { el.innerHTML = emptyState('Sin pagos futuros', 'No hay egresos proyectados desde este mes.', 'importar'); wireEmpty(el); return; }

    // Por cada mes futuro, lista los egresos (flujo negativo) por proyecto.
    let bodyRows = '', totalGlobal = 0;
    months.forEach((m) => {
      const egresos = state.proyectos
        .map((p) => ({ p, val: (p.proyeccion || {})[m] || 0 }))
        .filter((x) => x.val < 0)
        .sort((a, b) => a.val - b.val);
      if (!egresos.length) return;
      const totMes = egresos.reduce((a, b) => a + b.val, 0);
      totalGlobal += totMes;
      bodyRows += `<tr class="table-light"><td colspan="3" class="fw-semibold">${PF.monthLabel(m)}</td>
        <td class="num fw-semibold neg">${PF.fmtMoney(totMes)}</td></tr>`;
      egresos.forEach((x) => {
        bodyRows += `<tr><td></td><td>${PF.esc(x.p.nombre)}</td><td class="text-muted small">${PF.esc(categoriaNombre(x.p.categoriaId))}</td>
          <td class="num neg">${PF.fmtMoney(Math.abs(x.val), x.p.moneda)}</td></tr>`;
      });
    });

    el.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3">
        <div class="text-muted">Egresos proyectados (aportes) desde <b>${PF.monthLabel(cur)}</b> — total a programar:
          <b class="neg">${PF.fmtMoney(Math.abs(totalGlobal))}</b></div>
        <button class="btn btn-sm btn-outline-success" id="btn-pagos-excel"><i class="bi bi-file-earmark-excel"></i> Exportar Excel</button>
      </div>
      <div class="panel">
        <table class="table table-sm">
          <thead><tr><th></th><th>Proyecto</th><th>Categoría</th><th class="num">Monto a pagar</th></tr></thead>
          <tbody>${bodyRows || '<tr><td colspan="4" class="text-muted">Sin egresos futuros.</td></tr>'}</tbody>
        </table>
      </div>`;

    el.querySelector('#btn-pagos-excel').addEventListener('click', () => {
      const aoa = [['Mes', 'Proyecto', 'Categoría', 'Monto a pagar (' + state.config.moneda + ')']];
      months.forEach((m) => {
        state.proyectos.forEach((p) => {
          const v = (p.proyeccion || {})[m] || 0;
          if (v < 0) aoa.push([PF.monthLabel(m), p.nombre, categoriaNombre(p.categoriaId), Math.abs(v)]);
        });
      });
      PFReports.exportExcel('programacion_pagos.xlsx', 'Pagos', aoa);
    });
  }

  // ------------------------------------------------------- Vista: Reportes
  function renderReportes() {
    const el = document.getElementById('reportes');
    el.innerHTML = `
      <div class="panel">
        <h6>Exportar consolidado</h6>
        <p class="text-muted small">Descarga el flujo consolidado (mes a mes: neto, caja proyectada y caja real).</p>
        <button class="btn btn-outline-success me-2" id="rep-excel"><i class="bi bi-file-earmark-excel"></i> Excel</button>
        <button class="btn btn-outline-danger" id="rep-pdf"><i class="bi bi-file-earmark-pdf"></i> PDF</button>
      </div>
      <div class="panel">
        <h6>Exportar por proyecto</h6>
        <p class="text-muted small">Un archivo Excel con una hoja por proyecto.</p>
        <button class="btn btn-outline-success" id="rep-proj-excel"><i class="bi bi-file-earmark-excel"></i> Excel por proyecto</button>
      </div>`;

    el.querySelector('#rep-excel').addEventListener('click', () => {
      const t = buildTimeline();
      const aoa = [['Mes', 'Flujo neto', 'Caja proyectada', 'Caja real', 'Desviación']];
      t.months.forEach((m) => {
        const real = state.cajaReal[m] ? state.cajaReal[m].monto : '';
        aoa.push([PF.monthLabel(m), t.net[m], t.proj[m], real, real === '' ? '' : real - t.proj[m]]);
      });
      PFReports.exportExcel('flujo_consolidado.xlsx', 'Consolidado', aoa);
    });
    el.querySelector('#rep-pdf').addEventListener('click', () => {
      const t = buildTimeline();
      const body = t.months.map((m) => {
        const real = state.cajaReal[m] ? state.cajaReal[m].monto : null;
        return [PF.monthLabel(m), PF.fmtNum(t.net[m]), PF.fmtNum(t.proj[m]), real == null ? '—' : PF.fmtNum(real)];
      });
      PFReports.exportPDF({
        title: 'Flujo de caja consolidado',
        subtitle: 'Caja inicial: ' + PF.fmtMoney(state.config.cajaInicial),
        kpis: [{ label: 'Aportes', value: PF.fmtMoney(t.aportes) }, { label: 'Devoluciones', value: PF.fmtMoney(t.devoluciones) },
          { label: 'Mínimo caja', value: PF.fmtMoney(t.minAcc) + ' (' + PF.monthLabel(t.minMonth) + ')' }],
        head: ['Mes', 'Flujo neto', 'Caja proyectada', 'Caja real'],
        body,
      });
    });
    el.querySelector('#rep-proj-excel').addEventListener('click', () => {
      const sheets = state.proyectos.map((p) => {
        const months = Object.keys(p.proyeccion || {}).sort();
        const aoa = [['Mes', 'Flujo neto']];
        months.forEach((m) => aoa.push([PF.monthLabel(m), p.proyeccion[m]]));
        return { name: p.nombre, aoa };
      });
      if (!sheets.length) { toast('No hay proyectos', 'warning'); return; }
      PFReports.exportExcelMulti('flujo_por_proyecto.xlsx', sheets);
    });
  }

  // ------------------------------------------------------- Vista: Configuración
  function renderConfig() {
    const el = document.getElementById('config');
    const catRows = state.categorias.map((c) => `<tr>
      <td><input class="form-control form-control-sm cat-name" data-id="${c.id}" value="${PF.esc(c.nombre)}"></td>
      <td class="num" style="width:120px"><button class="btn btn-sm btn-outline-danger cat-del" data-id="${c.id}"><i class="bi bi-trash"></i></button></td>
    </tr>`).join('');

    el.innerHTML = `
      <div class="panel">
        <h6>General</h6>
        <div class="row g-2 align-items-end">
          <div class="col-md-3"><label class="form-label small">Moneda por defecto</label>
            <select class="form-select" id="cfg-moneda">
              <option value="UF" ${state.config.moneda === 'UF' ? 'selected' : ''}>UF</option>
              <option value="CLP" ${state.config.moneda === 'CLP' ? 'selected' : ''}>CLP</option></select></div>
          <div class="col-md-3"><label class="form-label small">Caja inicial</label>
            <input type="number" class="form-control" id="cfg-caja-inicial2" value="${state.config.cajaInicial}"></div>
          <div class="col-md-3"><label class="form-label small">Umbral de alerta de liquidez</label>
            <input type="number" class="form-control" id="cfg-umbral" value="${state.config.umbralAlerta}"></div>
          <div class="col-md-3"><button class="btn btn-primary" id="cfg-save-general">Guardar</button></div>
        </div>
      </div>
      <div class="panel">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="mb-0">Categorías</h6>
          <button class="btn btn-sm btn-primary" id="cat-add"><i class="bi bi-plus-lg"></i> Agregar</button>
        </div>
        <table class="table table-sm"><tbody>${catRows}</tbody></table>
        <div class="text-muted small">Renombrar: edita el texto y presiona Guardar categorías.</div>
        <button class="btn btn-sm btn-outline-primary mt-2" id="cat-save">Guardar categorías</button>
      </div>
      <div class="panel">
        <h6>Datos</h6>
        <div class="text-muted small mb-2">Modo actual: <b>${state.mode === 'firebase' ? 'Firebase (nube, multiusuario)' : 'Local (este navegador)'}</b>.
        ${state.mode === 'local' ? 'Para compartir con finanzas, completa <code>firebase-config.js</code> con tu proyecto Firebase propio.' : ''}</div>
      </div>`;

    el.querySelector('#cfg-save-general').addEventListener('click', async () => {
      await DB.setConfig({
        moneda: el.querySelector('#cfg-moneda').value,
        cajaInicial: Number(el.querySelector('#cfg-caja-inicial2').value) || 0,
        umbralAlerta: Number(el.querySelector('#cfg-umbral').value) || 0,
      });
      await loadAll(); toast('Configuración guardada', 'success'); renderConfig();
    });
    el.querySelector('#cat-add').addEventListener('click', async () => {
      await DB.addCategoria('Nueva categoría'); await loadAll(); renderConfig();
    });
    el.querySelector('#cat-save').addEventListener('click', async () => {
      for (const inp of el.querySelectorAll('.cat-name')) {
        await DB.updateCategoria(inp.dataset.id, { nombre: inp.value.trim() || 'Sin nombre' });
      }
      await loadAll(); toast('Categorías guardadas', 'success'); renderConfig();
    });
    el.querySelectorAll('.cat-del').forEach((b) => b.addEventListener('click', async () => {
      const used = state.proyectos.some((p) => p.categoriaId === b.dataset.id);
      if (used) { toast('No se puede eliminar: hay proyectos en esta categoría', 'warning'); return; }
      if (!confirm('¿Eliminar esta categoría?')) return;
      await DB.deleteCategoria(b.dataset.id); await loadAll(); renderConfig();
    }));
  }

  // ------------------------------------------------------------------ Helpers UI
  function kpiCard(label, value, sub, valClass, alert) {
    return `<div class="kpi-card ${alert ? 'alert' : ''}">
      <div class="kpi-label">${PF.esc(label)}</div>
      <div class="kpi-value ${valClass || ''}">${value}</div>
      <div class="kpi-sub">${PF.esc(sub || '')}</div></div>`;
  }
  function emptyState(title, sub, gotoView) {
    return `<div class="empty-state"><i class="bi bi-inbox"></i>
      <h5>${PF.esc(title)}</h5><p>${PF.esc(sub)}</p>
      ${gotoView ? `<button class="btn btn-primary" data-goto="${gotoView}"><i class="bi bi-file-earmark-arrow-up me-1"></i>Importar Excel</button>` : ''}</div>`;
  }
  function wireEmpty(el) {
    el.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
  }

  // ------------------------------------------------------------------ Auth
  function setupAuthUI() {
    const overlay = document.getElementById('login-overlay');
    const shell = document.getElementById('app-shell');
    const showLogin = () => { overlay.classList.remove('d-none'); shell.style.display = 'none'; };
    const showApp = () => { overlay.classList.add('d-none'); shell.style.display = 'flex'; };

    const errBox = document.getElementById('login-error');
    const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('d-none'); };

    firebase.auth().onAuthStateChanged(async (user) => {
      if (user) {
        const dom = window.ALLOWED_EMAIL_DOMAIN;
        if (dom && !(user.email || '').endsWith('@' + dom)) {
          showErr('Solo cuentas @' + dom); await firebase.auth().signOut(); showLogin(); return;
        }
        state.user = user;
        document.getElementById('user-box').classList.remove('d-none');
        document.getElementById('user-email').textContent = user.email;
        showApp();
        await loadAll(); showView('dashboard');
      } else { state.user = null; showLogin(); }
    });

    document.getElementById('login-btn').addEventListener('click', async () => {
      try {
        await firebase.auth().signInWithEmailAndPassword(
          document.getElementById('login-email').value.trim(),
          document.getElementById('login-password').value);
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('login-google').addEventListener('click', async () => {
      try { await firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
      catch (e) { showErr(e.message); }
    });
    document.getElementById('logout-btn').addEventListener('click', () => firebase.auth().signOut());
  }

  // ------------------------------------------------------------------ Init
  async function init() {
    wireNav();
    state.mode = await DB.init();
    document.getElementById('mode-badge').innerHTML = state.mode === 'firebase'
      ? '<i class="bi bi-cloud-check"></i> Nube'
      : '<i class="bi bi-hdd"></i> Local';

    if (state.mode === 'firebase') {
      setupAuthUI(); // el resto se dispara en onAuthStateChanged
    } else {
      await loadAll();
      showView('dashboard');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

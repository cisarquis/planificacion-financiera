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
    importLog: [],
    currentProyectoId: null,
  };

  async function loadAll() {
    const [config, categorias, proyectos, cajaReal, importLog] = await Promise.all([
      DB.getConfig(), DB.listCategorias(), DB.listProyectos(), DB.getCajaReal(), DB.listImportLog(),
    ]);
    state.config = config;
    state.categorias = categorias;
    state.proyectos = proyectos;
    state.cajaReal = cajaReal;
    state.importLog = importLog;
    document.getElementById('view-subtitle').textContent = 'Flujo de caja consolidado de proyectos · moneda ' + config.moneda;
    updateTopbarStats();
  }

  // Chip de stats del topbar: última importación, nº de proyectos, horizonte en meses.
  function updateTopbarStats() {
    const el = document.getElementById('topbar-stats');
    if (!el) return;
    if (!state.proyectos.length) { el.innerHTML = ''; return; }
    const ultima = state.importLog[0];
    const horizonte = allMonths().length;
    el.innerHTML = `
      <span><span class="live-dot"></span>Última carga: <b>${ultima ? PF.esc(new Date(ultima.importedAt).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })) : '—'}</b></span>
      <span>Proyectos: <b>${state.proyectos.length}</b></span>
      <span>Horizonte: <b>${horizonte} meses</b></span>`;
  }

  // ------------------------------------------------------- Cálculos derivados
  // Une todos los meses con datos (+ mesInicial) y genera rango continuo.
  function allMonths(proyectos) {
    const set = new Set();
    (proyectos || state.proyectos).forEach((p) => {
      Object.keys(p.proyeccion || {}).forEach((k) => set.add(k));
      Object.keys(p.presupuesto || {}).forEach((k) => set.add(k));
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

  // Tramo contiguo de meses con proj[m] < umbral que contiene t.minMonth (para el banner de
  // veredicto y la alerta crítica). Devuelve null si t.minMonth no está bajo el umbral.
  function umbralAlertaMonths(t, umbral) {
    if (t.minAcc == null || t.minAcc >= umbral) return null;
    const idx = t.months.indexOf(t.minMonth);
    let start = idx, end = idx;
    while (start > 0 && t.proj[t.months[start - 1]] < umbral) start--;
    while (end < t.months.length - 1 && t.proj[t.months[end + 1]] < umbral) end++;
    return { start: t.months[start], end: t.months[end], count: end - start + 1 };
  }

  // Suma un campo ('proyeccion' o 'presupuesto') de una lista de proyectos sobre un set de meses.
  function sumField(proyectos, months, field) {
    let total = 0;
    proyectos.forEach((p) => {
      const data = p[field] || {};
      months.forEach((m) => { if (data[m]) total += data[m]; });
    });
    return total;
  }

  // Agrupa una lista de meses ('YYYY-MM') en buckets de período (trimestral/semestral/anual).
  function periodBuckets(months, granularidad) {
    const map = new Map();
    months.forEach((m) => {
      const [y, mo] = m.split('-').map(Number);
      let key, label;
      if (granularidad === 'trimestral') {
        const q = Math.floor((mo - 1) / 3) + 1;
        key = y + '-Q' + q; label = 'T' + q + ' ' + y;
      } else if (granularidad === 'anual') {
        key = String(y); label = String(y);
      } else {
        const s = mo <= 6 ? 1 : 2;
        key = y + '-S' + s; label = s + 'S ' + y;
      }
      if (!map.has(key)) map.set(key, { key, label, months: [] });
      map.get(key).months.push(m);
    });
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
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
      dashboard: 'Consolidado', 'categorias-view': 'Por categoría', 'flujo-mensual': 'Flujo de Caja',
      'resumen-directorio': 'Resumen Directorio', proyectos: 'Por proyecto', importar: 'Importar Excel',
      caja: 'Caja del banco', pagos: 'Programar pagos', reportes: 'Reportes', config: 'Configuración',
    };
    document.getElementById('view-title').textContent = titles[id] || '';
    const renders = {
      dashboard: renderDashboard, 'categorias-view': renderCategoriasView, 'flujo-mensual': renderFlujoMensual,
      'resumen-directorio': renderResumenDirectorio, proyectos: renderProyectos, importar: renderImportar,
      caja: renderCaja, pagos: renderPagos, reportes: renderReportes, config: renderConfig,
    };
    if (renders[id]) renders[id]();
  }

  function wireNav() {
    document.querySelectorAll('.sidebar-nav .nav-link').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
    });
  }

  // ------------------------------------------------------------- Vista: Dashboard
  function kpi2Card(label, value, sub, accent, valueColor) {
    return `<div class="kpi2-card">
      <div class="kpi2-accent" style="background:${accent}"></div>
      <div class="kpi2-label">${PF.esc(label)}</div>
      <div class="kpi2-value" style="color:${valueColor}">${PF.fmtNum(value)} <span class="unit">UF</span></div>
      <div class="kpi2-sub">${PF.esc(sub)}</div>
    </div>`;
  }

  function alertItemHtml(a) {
    return `<div class="alert-item">
      <div class="alert-icon" style="background:${a.bg}; color:${a.fg}"><i class="bi ${a.icon}"></i></div>
      <div class="alert-body">
        <div class="alert-meta"><span class="alert-level" style="color:${a.fg}">${PF.esc(a.nivel)}</span><span class="alert-when">${PF.esc(a.when)}</span></div>
        <div class="alert-title">${PF.esc(a.title)}</div>
        <div class="alert-detail">${PF.esc(a.detail)}</div>
        <a href="#" class="alert-action" data-goto="${a.gotoView}">${PF.esc(a.action)} →</a>
      </div>
    </div>`;
  }

  function renderDashboard() {
    const el = document.getElementById('dashboard');
    if (!state.proyectos.length) { el.innerHTML = emptyState('No hay proyectos todavía', 'Importa un Excel para comenzar.', 'importar'); wireEmpty(el); return; }

    const t = buildTimeline();
    const cur = PF.currentMonth();
    const umbral = Number(state.config.umbralAlerta) || 0;
    const tramo = umbralAlertaMonths(t, umbral);

    // ---- KPI 1: Caja actual (real si hay dato del mes actual, si no la proyección más cercana).
    const cajaActualMonth = (t.proj[cur] != null) ? cur
      : (t.months.length ? (cur < t.months[0] ? t.months[0] : t.months[t.months.length - 1]) : null);
    const cajaActual = state.cajaReal[cur] ? state.cajaReal[cur].monto : (cajaActualMonth ? t.proj[cajaActualMonth] : null);

    // ---- KPI 3: aportes de los próximos 3 meses desde hoy.
    const curIdx = t.months.findIndex((m) => m >= cur);
    const proxStart = curIdx >= 0 ? curIdx : Math.max(0, t.months.length - 3);
    const proxMonths = t.months.slice(proxStart, proxStart + 3);
    const prox3 = proxMonths.reduce((s, m) => s + Math.min(0, t.net[m] || 0), 0);
    const proxLabel = proxMonths.length
      ? 'Aportes ' + PF.monthLabel(proxMonths[0]) + (proxMonths.length > 1 ? '–' + PF.monthLabel(proxMonths[proxMonths.length - 1]) : '')
      : 'Aportes próximos';

    // ---- KPI 4: neto del año calendario en curso.
    const curYear = String(new Date().getFullYear());
    const yearMonths = t.months.filter((m) => m.slice(0, 4) === curYear);
    const aportesAnio = yearMonths.reduce((s, m) => s + Math.min(0, t.net[m] || 0), 0);
    const devolAnio = yearMonths.reduce((s, m) => s + Math.max(0, t.net[m] || 0), 0);

    // ---- Banner de veredicto.
    let verdictHtml;
    if (tramo) {
      const rango = tramo.count > 1 ? `entre <b>${PF.monthLabel(tramo.start)}</b> y <b>${PF.monthLabel(tramo.end)}</b>` : `en <b>${PF.monthLabel(tramo.start)}</b>`;
      verdictHtml = `<div class="verdict-banner">
        <i class="bi bi-exclamation-triangle-fill verdict-icon"></i>
        <div class="verdict-text">La caja no alcanza: cae bajo el umbral ${rango}, con mínimo de <b>${PF.fmtNum(t.minAcc)} UF</b> en ${PF.monthLabel(t.minMonth)}.</div>
        <div class="verdict-gap">Faltan <b>${PF.fmtNum(umbral - t.minAcc)} UF</b> para sostener el umbral</div>
      </div>`;
    } else {
      verdictHtml = `<div class="verdict-banner ok">
        <i class="bi bi-check-circle-fill verdict-icon"></i>
        <div class="verdict-text">La caja se sostiene sobre el umbral en los ${t.months.length} meses proyectados (mínimo ${PF.fmtNum(t.minAcc)} UF en ${PF.monthLabel(t.minMonth)}).</div>
      </div>`;
    }

    // ---- Alertas.
    const alertas = [];
    if (tramo) {
      const rangoTxt = tramo.count > 1 ? `De ${PF.monthLabel(tramo.start)} a ${PF.monthLabel(tramo.end)}` : `En ${PF.monthLabel(tramo.start)}`;
      alertas.push({
        nivel: 'Crítica', when: 'hoy', icon: 'bi-exclamation-triangle-fill', bg: 'var(--pf-danger-100)', fg: 'var(--pf-danger-700)',
        title: `Caja bajo el umbral ${tramo.count} mes${tramo.count > 1 ? 'es' : ''} seguido${tramo.count > 1 ? 's' : ''}`,
        detail: `${rangoTxt}; el punto más bajo es ${PF.fmtNum(t.minAcc)} UF en ${PF.monthLabel(t.minMonth)}.`,
        action: 'Ver flujo mensual', gotoView: 'flujo-mensual',
      });

      const rangeMonths = t.months.slice(t.months.indexOf(tramo.start), t.months.indexOf(tramo.end) + 1);
      const porProyecto = state.proyectos.map((p) => {
        let s = 0; rangeMonths.forEach((m) => { const v = (p.proyeccion || {})[m] || 0; if (v < 0) s += v; });
        return { p, aportes: Math.abs(s) };
      }).filter((x) => x.aportes > 0).sort((a, b) => b.aportes - a.aportes);
      const totalAportesTramo = porProyecto.reduce((s, x) => s + x.aportes, 0);
      if (porProyecto.length && totalAportesTramo > 0) {
        const top = porProyecto[0], share = top.aportes / totalAportesTramo;
        if (share > 0.3) {
          alertas.push({
            nivel: 'Alta', when: 'hoy', icon: 'bi-pie-chart-fill', bg: 'var(--pf-warning-100)', fg: 'var(--pf-warning-700)',
            title: `${top.p.nombre} concentra ${Math.round(share * 100)}% de los aportes`,
            detail: `${rangoTxt} dependen${tramo.count === 1 ? '' : ''} de un solo proyecto para el peor tramo de caja.`,
            action: 'Ver por proyecto', gotoView: 'proyectos',
          });
        }
      }
    }

    const realKeys = Object.keys(state.cajaReal || {}).sort();
    const lastReal = realKeys.length ? realKeys[realKeys.length - 1] : null;
    if (!lastReal || lastReal < cur) {
      alertas.push({
        nivel: 'Atención', when: lastReal ? 'hace tiempo' : '—', icon: 'bi-bank', bg: 'var(--pf-warning-100)', fg: 'var(--pf-warning-700)',
        title: lastReal ? `Caja real sin cargar desde ${PF.monthLabel(lastReal)}` : 'Todavía no se ha cargado caja real del banco',
        detail: 'La desviación proyectado vs. real no se puede calcular para los meses recientes.',
        action: 'Cargar caja del banco', gotoView: 'caja',
      });
    }

    const ultimaImport = state.importLog[0];
    if (ultimaImport) {
      alertas.push({
        nivel: 'Info', when: PF.esc(new Date(ultimaImport.importedAt).toLocaleDateString('es-CL', { day: '2-digit', month: 'short' })), icon: 'bi-file-earmark-arrow-up', bg: 'var(--pf-primary-100)', fg: 'var(--pf-primary-700)',
        title: ultimaImport.sheet && ultimaImport.sheet.startsWith('maestro') ? 'Importación maestra exitosa' : 'Importación exitosa',
        detail: `${ultimaImport.meses} meses actualizados desde ${ultimaImport.fileName}.`,
        action: 'Ver detalle de importación', gotoView: 'importar',
      });
    }

    // ---- Próximos aportes (rail): 3 mayores egresos por proyecto desde el mes actual.
    const futMonths = t.months.filter((m) => m >= cur);
    const hitos = [];
    futMonths.forEach((m) => state.proyectos.forEach((p) => {
      const v = (p.proyeccion || {})[m] || 0;
      if (v < 0) hitos.push({ mes: m, nombre: p.nombre, v });
    }));
    hitos.sort((a, b) => a.v - b.v);
    const topHitos = hitos.slice(0, 3);

    const labels = t.months.map(PF.monthLabel);
    const projArr = t.months.map((m) => t.proj[m]);
    const realArr = t.months.map((m) => (t.real[m] != null ? t.real[m] : null));
    const netArr = t.months.map((m) => t.net[m]);

    el.innerHTML = `
      ${verdictHtml}
      <div class="d-flex gap-3 align-items-start flex-wrap flex-lg-nowrap">
        <div class="flex-grow-1" style="min-width:0; flex-basis:0">
          <div class="kpi2-grid">
            ${kpi2Card('Caja actual', cajaActual, state.cajaReal[cur] ? 'Real (banco), ' + PF.monthLabel(cur) : 'Proyectada, ' + PF.monthLabel(cajaActualMonth), '#2563eb', 'var(--pf-slate-800)')}
            ${kpi2Card('Mínimo proyectado', t.minAcc, 'En ' + PF.monthLabel(t.minMonth) + (tramo ? ' · bajo umbral' : ''), '#dc2626', tramo ? 'var(--pf-danger-700)' : 'var(--pf-slate-800)')}
            ${kpi2Card(proxLabel, Math.abs(prox3), 'Egresos a programar', '#f59e0b', 'var(--pf-slate-800)')}
            ${kpi2Card('Neto del año', aportesAnio + devolAnio, PF.fmtNum(Math.abs(aportesAnio)) + ' aportes / ' + PF.fmtNum(devolAnio) + ' devol.', '#16a34a', 'var(--pf-slate-800)')}
          </div>

          <div class="panel">
            <div class="panel-header-row">
              <div>
                <h3>Caja acumulada: proyectada vs. real</h3>
                <p class="panel-hint">Caja inicial ${PF.fmtNum(state.config.cajaInicial)} UF · umbral de alerta ${PF.fmtNum(umbral)} UF</p>
              </div>
              <div class="chart-legend">
                <span class="chart-legend-item"><span class="swatch-line" style="background:#2563eb"></span>Proyectada</span>
                <span class="chart-legend-item"><span class="swatch-dash"></span>Real (banco)</span>
                <span class="chart-legend-item"><span class="swatch-box" style="background:#fee2e2; border:1px solid #fecaca"></span>Bajo umbral</span>
              </div>
            </div>
            ${PFCharts.svgCajaAcumulada(labels, projArr, realArr, umbral)}
          </div>

          <div class="panel mb-0">
            <div class="panel-header-row">
              <div>
                <h3>Flujo neto mensual</h3>
                <p class="panel-hint">Bajo la línea: aportes a proyectos. Sobre la línea: devoluciones.</p>
              </div>
              <div class="chart-legend">
                <span class="chart-legend-item"><span class="swatch-sq" style="background:#16a34a"></span>Devoluciones</span>
                <span class="chart-legend-item"><span class="swatch-sq" style="background:#dc2626"></span>Aportes</span>
              </div>
            </div>
            ${PFCharts.svgFlujoNeto(labels, netArr)}
          </div>
        </div>

        <aside class="alert-rail">
          <div class="alert-rail-header">
            <i class="bi bi-bell-fill"></i>
            <h3>Alertas</h3>
            ${alertas.some((a) => a.nivel === 'Crítica') ? `<span class="alert-rail-badge">${alertas.filter((a) => a.nivel === 'Crítica').length} crítica</span>` : ''}
          </div>
          <div>${alertas.map(alertItemHtml).join('') || '<div class="alert-detail p-3">Sin alertas por ahora.</div>'}</div>
          ${topHitos.length ? `<div class="hitos-block">
            <div class="hitos-title">Próximos aportes</div>
            ${topHitos.map((h) => `<div class="hitos-row">
              <div class="hitos-mes">${PF.monthLabel(h.mes)}</div>
              <div class="hitos-proyecto">${PF.esc(h.nombre)}</div>
              <div class="hitos-monto">${PF.fmtNum(Math.abs(h.v))}</div>
            </div>`).join('')}
          </div>` : ''}
        </aside>
      </div>`;

    el.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.goto); }));
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

  // ------------------------------------------------------- Vista: Flujo de Caja (mensual)
  const OPEN_CATS_KEY = 'pf.flujo.openCats';
  // Persiste qué filas de grupo quedan expandidas en una tabla colapsable (Flujo de Caja mensual,
  // Flujo de Obras en Resumen Directorio), cada una con su propia key de localStorage.
  function loadOpenMap(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
  }
  function saveOpenMap(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* ignora si localStorage no está disponible */ }
  }

  function flujoCell(v) {
    const cls = v < 0 ? 'neg' : (v > 0 ? 'pos' : 'num-zero');
    return `<td class="num ${cls}">${PF.fmtNum(v)}</td>`;
  }

  function renderFlujoMensual() {
    const el = document.getElementById('flujo-mensual');
    if (!state.proyectos.length) { el.innerHTML = emptyState('Sin datos', 'Importa proyectos para ver el flujo de caja mensual.', 'importar'); wireEmpty(el); return; }

    const t = buildTimeline();
    const months = t.months;
    const labels = months.map(PF.monthLabel);
    const umbral = Number(state.config.umbralAlerta) || 0;
    const mesesBajoUmbral = months.filter((m) => t.proj[m] < umbral).length;
    const openCats = loadOpenMap(OPEN_CATS_KEY);

    // ---- Filas de la tabla.
    let rows = '';
    let catIdx = 0;
    state.categorias.forEach((cat) => {
      const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
      if (!proys.length) return;
      const isOpen = Object.prototype.hasOwnProperty.call(openCats, cat.id) ? openCats[cat.id] : catIdx === 0;
      catIdx++;
      const net = netByMonth(months, proys);
      const netArr = months.map((m) => net[m]);
      rows += `<tr class="cat-row" data-cat-id="${cat.id}" data-is-open="${isOpen}" role="button" tabindex="0">
        <td class="proj-col"><span class="row-label"><i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}"></i><span>${PF.esc(cat.nombre)}</span></span></td>
        ${months.map((m) => flujoCell(net[m])).join('')}
        <td class="trend-col">${PFCharts.sparkline(netArr)}</td>
      </tr>`;
      if (isOpen) proys.forEach((p) => {
        const projArr = months.map((m) => (p.proyeccion || {})[m] || 0);
        rows += `<tr class="proj-row">
          <td class="proj-col"><span class="row-label" style="padding-left:14px"><i class="bi bi-dot"></i><span>${PF.esc(p.nombre)}</span></span></td>
          ${projArr.map(flujoCell).join('')}
          <td class="trend-col">${PFCharts.sparkline(projArr)}</td>
        </tr>`;
      });
    });

    const netArr = months.map((m) => t.net[m]);
    const accArr = months.map((m) => t.proj[m]);
    const realArr = months.map((m) => (t.real[m] != null ? t.real[m] : null));

    const totalRow = `<tr class="total-row">
      <td class="proj-col"><span class="row-label"><i class="bi bi-arrow-left-right"></i><span>Flujo de caja del mes</span></span></td>
      ${netArr.map(flujoCell).join('')}
      <td class="trend-col">${PFCharts.sparkline(netArr)}</td>
    </tr>`;

    const acumRow = `<tr class="acum-row">
      <td class="proj-col"><span class="row-label"><i class="bi bi-wallet2"></i><span>Caja proyectada acumulada</span></span></td>
      ${accArr.map((v) => `<td class="num ${v < umbral ? 'sem-bajo' : (v < umbral * 1.5 ? 'sem-riesgo' : 'sem-ok')}">${PF.fmtNum(v)}</td>`).join('')}
      <td class="trend-col">${PFCharts.sparkline(accArr)}</td>
    </tr>`;

    const realRow = `<tr class="real-row">
      <td class="proj-col"><span class="row-label"><i class="bi bi-bank"></i><span>Caja real (banco)</span></span></td>
      ${realArr.map((v) => `<td class="num ${v == null ? 'num-zero' : ''}">${v != null ? PF.fmtNum(v) : '—'}</td>`).join('')}
      <td class="trend-col">${PFCharts.sparkline(realArr.map((v) => v || 0))}</td>
    </tr>`;

    const headCols = labels.map((l) => `<th class="month-col">${PF.esc(l)}</th>`).join('');

    el.innerHTML = `
      <div class="flujo-chip-bar">
        <div class="flujo-chip">
          <span>Caja inicial <b>${PF.fmtNum(state.config.cajaInicial)} UF</b></span>
          <span class="sep"></span>
          <span>Umbral <b>${PF.fmtNum(umbral)} UF</b></span>
          <span class="sep"></span>
          <span>${mesesBajoUmbral} meses <b>bajo umbral</b></span>
        </div>
        <div class="flujo-actions">
          <button class="flujo-btn" id="flujo-excel"><i class="bi bi-file-earmark-excel" style="color:#15803d"></i> Exportar Excel</button>
          <button class="flujo-btn" id="flujo-pdf"><i class="bi bi-filetype-pdf" style="color:#b91c1c"></i> PDF directorio</button>
        </div>
      </div>
      <div class="panel mb-0">
        <h3>Flujo de caja mensual por proyecto</h3>
        <p class="panel-hint">Haz clic en una categoría para expandir sus proyectos. Rojo = aporte, verde = devolución.</p>
        <div class="flujo-table-wrap">
          <table class="flujo-table">
            <thead><tr><th class="proj-col">Proyecto</th>${headCols}<th class="trend-col">Tendencia</th></tr></thead>
            <tbody>${rows}${totalRow}${acumRow}${realRow}</tbody>
          </table>
        </div>
        <div class="flujo-legend">
          <span class="flujo-legend-item"><span class="swatch" style="background:#fee2e2; border-color:#fecaca"></span>Caja bajo umbral</span>
          <span class="flujo-legend-item"><span class="swatch" style="background:#fef3c7; border-color:#fde68a"></span>Caja en zona de riesgo (&lt; 1,5× umbral)</span>
          <span class="flujo-legend-item"><span class="swatch" style="background:#dcfce7; border-color:#bbf7d0"></span>Caja holgada</span>
        </div>
      </div>`;

    el.querySelectorAll('.cat-row').forEach((row) => {
      const toggle = () => {
        const id = row.dataset.catId;
        const wasOpen = row.dataset.isOpen === 'true';
        const cur = loadOpenMap(OPEN_CATS_KEY);
        cur[id] = !wasOpen;
        saveOpenMap(OPEN_CATS_KEY, cur);
        renderFlujoMensual();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });

    function buildExportRows(fmt) {
      const out = [['Proyecto', ...labels]];
      state.categorias.forEach((cat) => {
        const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
        if (!proys.length) return;
        const net = netByMonth(months, proys);
        out.push([cat.nombre, ...months.map((m) => fmt(net[m]))]);
        proys.forEach((p) => out.push(['  ' + p.nombre, ...months.map((m) => fmt((p.proyeccion || {})[m] || 0))]));
      });
      out.push(['Flujo de caja del mes', ...months.map((m) => fmt(t.net[m]))]);
      out.push(['Caja proyectada acumulada', ...months.map((m) => fmt(t.proj[m]))]);
      out.push(['Caja real (banco)', ...months.map((m) => (t.real[m] != null ? fmt(t.real[m]) : ''))]);
      return out;
    }

    el.querySelector('#flujo-excel').addEventListener('click', () => {
      PFReports.exportExcel('flujo_de_caja_mensual.xlsx', 'Flujo de Caja', buildExportRows((v) => v));
    });
    el.querySelector('#flujo-pdf').addEventListener('click', () => {
      const rowsAoa = buildExportRows(PF.fmtNum);
      PFReports.exportPDF({
        title: 'Flujo de caja mensual',
        subtitle: `Caja inicial ${PF.fmtNum(state.config.cajaInicial)} UF · umbral de alerta ${PF.fmtNum(umbral)} UF`,
        head: rowsAoa[0],
        body: rowsAoa.slice(1),
      });
    });
  }

  // ------------------------------------------------------- Vista: Resumen Directorio
  const DIR_GRAN_KEY = 'pf.directorio.gran';
  let resumenGranularidad = (function () {
    try { return localStorage.getItem(DIR_GRAN_KEY) || 'semestral'; } catch (e) { return 'semestral'; }
  })();
  const OPEN_GRUPOS_KEY = 'pf.resumen.openGrupos';
  const CAT_FINANCIAMIENTO = 'Financiamiento, Dividendo e Impuestos';

  // Infiere el "grupo de obra" (año de inicio) de un proyecto a partir del primer aporte relevante
  // de su proyección — umbral = el mayor entre 500 UF y 10% del máximo aporte absoluto del propio
  // proyecto. Es una simplificación deliberada: no distingue "iniciadas" vs "por iniciar" del mismo
  // año (esa distinción no es inferible solo desde el flujo de caja); el usuario corrige a mano
  // arrastrando la fila si hace falta.
  function inferirGrupoObra(p) {
    const proy = p.proyeccion || {};
    const keys = Object.keys(proy).sort();
    if (!keys.length) return 'Sin clasificar';
    const maxAbs = Math.max(0, ...keys.map((k) => Math.abs(proy[k])));
    const umbral = Math.max(500, maxAbs * 0.1);
    const primero = keys.find((k) => proy[k] < 0 && Math.abs(proy[k]) >= umbral);
    return primero ? 'Obras ' + primero.slice(0, 4) : 'Sin clasificar';
  }

  // Clasifica (una sola vez, perezoso) y persiste grupoObra en los proyectos que no lo tengan
  // todavía, para que el drag-and-drop del usuario nunca se pise con un recálculo automático.
  async function ensureGruposObra() {
    const finCat = state.categorias.find((c) => c.nombre === CAT_FINANCIAMIENTO);
    const pendientes = state.proyectos.filter((p) => !p.grupoObra && (!finCat || p.categoriaId !== finCat.id));
    if (!pendientes.length) return false;
    for (const p of pendientes) {
      await DB.updateProyecto(p.id, { grupoObra: inferirGrupoObra(p) });
    }
    await loadAll();
    return true;
  }

  // Primer índice a partir del cual el acumulado ya no vuelve a ser negativo (para el copy
  // "la caja se construye recién en...").
  function primerIndiceRecuperacion(acum) {
    let idx = 0;
    for (let i = acum.length - 1; i >= 0; i--) { if (acum[i] < 0) { idx = i + 1; break; } }
    return idx;
  }

  // Banner de veredicto de Resumen Directorio: 3 estados según el acumulado del rango visible.
  function resumenVeredicto(buckets, acumActual) {
    const n = acumActual.length;
    const minVal = Math.min(...acumActual);
    const minIdx = acumActual.indexOf(minVal);
    const cierre = acumActual[n - 1];
    if (cierre < 0) {
      return { tipo: 'danger', icon: 'bi-exclamation-triangle-fill',
        texto: `La caja cierra el horizonte en negativo: <span style="color:#dc2626">${PF.fmtNum(cierre)} UF</span> en ${PF.esc(buckets[n - 1].label)}, con mínimo de <span style="color:#b91c1c">${PF.fmtNum(minVal)} UF</span> en ${PF.esc(buckets[minIdx].label)}.` };
    }
    if (minVal < 0) {
      const recIdx = Math.min(primerIndiceRecuperacion(acumActual), n - 1);
      const beforeIdx = Math.max(0, recIdx - 1);
      return { tipo: 'warning', icon: 'bi-graph-up-arrow',
        texto: `La caja se construye recién en ${PF.esc(buckets[recIdx].label)}: hasta ${PF.esc(buckets[beforeIdx].label)} el acumulado es de <span style="color:#b45309">${PF.fmtNum(acumActual[beforeIdx])} UF</span> y toca <span style="color:#b91c1c">${PF.fmtNum(minVal)} UF</span> en ${PF.esc(buckets[minIdx].label)}.` };
    }
    return { tipo: 'ok', icon: 'bi-check-circle-fill',
      texto: `La caja se mantiene positiva en todo el horizonte (mínimo <b>${PF.fmtNum(minVal)} UF</b> en ${PF.esc(buckets[minIdx].label)}).` };
  }

  function renderResumenDirectorio() {
    const el = document.getElementById('resumen-directorio');
    if (!state.proyectos.length) { el.innerHTML = emptyState('Sin datos', 'Importa proyectos para ver el resumen para directorio.', 'importar'); wireEmpty(el); return; }

    ensureGruposObra().then((changed) => { if (changed) renderResumenDirectorio(); });

    const months = allMonths();
    const buckets = periodBuckets(months, resumenGranularidad);
    const catsConProyectos = state.categorias.filter((cat) => state.proyectos.some((p) => p.categoriaId === cat.id));

    const filas = catsConProyectos.map((cat) => {
      const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
      return {
        nombre: cat.nombre,
        actual: buckets.map((b) => sumField(proys, b.months, 'proyeccion')),
        ppto: buckets.map((b) => sumField(proys, b.months, 'presupuesto')),
      };
    });

    const totalActual = buckets.map((_, i) => filas.reduce((a, f) => a + f.actual[i], 0));
    const totalPpto = buckets.map((_, i) => filas.reduce((a, f) => a + f.ppto[i], 0));
    const acumActual = []; let accA = 0; totalActual.forEach((v) => { accA += v; acumActual.push(accA); });
    const acumPpto = []; let accP = 0; totalPpto.forEach((v) => { accP += v; acumPpto.push(accP); });

    // periodBorder/filaHtml/headCols/subCols: formato "3 columnas por período" (Ppto/Actual/Var),
    // usado por la tabla de Flujo de Obras más abajo (sin cambios respecto a la sesión anterior).
    const periodBorder = 'border-left:2px solid var(--pf-border)';
    function filaHtml(nombre, actualArr, pptoArr, cls) {
      const cells = buckets.map((b, i) => {
        const a = actualArr[i], p = pptoArr[i], v = a - p;
        const bs = i > 0 ? periodBorder : '';
        return `<td class="num" style="${bs}">${PF.fmtMoney(p)}</td><td class="num">${PF.fmtMoney(a)}</td><td class="num ${v < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(v)}</td>`;
      }).join('');
      return `<tr class="${cls || ''}"><td class="proj-col">${PF.esc(nombre)}</td>${cells}</tr>`;
    }
    const headCols = buckets.map((b, i) => `<th class="num" colspan="3" style="${i > 0 ? periodBorder : ''}">${PF.esc(b.label)}</th>`).join('');
    const subCols = buckets.map((b, i) => `<th class="num small text-muted" style="${i > 0 ? periodBorder : ''}">Ppto</th><th class="num small text-muted">Actual</th><th class="num small text-muted">Var</th>`).join('');

    // ---- Tabla por categoría (rediseñada): 1 columna por período sin presupuesto, 2 con
    // presupuesto (Actual, Δ) — nunca 3, y nunca "0 UF" (se muestra "—").
    const hasPresupuesto = totalPpto.some((v) => v !== 0);
    const minVal = Math.min(...acumActual);
    const minIdx = acumActual.indexOf(minVal);
    const jumpIdx = totalActual.indexOf(Math.max(...totalActual));
    const jumpBeforeIdx = Math.max(0, jumpIdx - 1);
    const jumpContribs = filas.map((f) => ({ nombre: f.nombre, v: f.actual[jumpIdx] }))
      .filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 2).map((x) => x.nombre);
    const veredicto = resumenVeredicto(buckets, acumActual);

    function dirKpiCard(label, value, unit, sub, accent, valueColor) {
      return `<div class="kpi2-card">
        <div class="kpi2-accent" style="background:${accent}"></div>
        <div class="kpi2-label">${PF.esc(label)}</div>
        <div class="kpi2-value" style="color:${valueColor}">${PF.esc(value)}${unit ? ` <span class="unit">${PF.esc(unit)}</span>` : ''}</div>
        <div class="kpi2-sub">${PF.esc(sub)}</div>
      </div>`;
    }
    const anioFinal = months.length ? months[months.length - 1].slice(0, 4) : '';
    const anioInicial = months.length ? months[0].slice(0, 4) : '';
    const numAnios = Math.max(1, Math.round((months.length || 0) / 12));
    const negCount = acumActual.filter((v) => v < 0).length;
    let kpi4;
    if (hasPresupuesto) {
      const delta = acumActual[acumActual.length - 1] - acumPpto[acumPpto.length - 1];
      kpi4 = { label: 'Desviación vs. PPTO', value: PF.fmtNum(delta), unit: 'UF', sub: 'Actual − Presupuesto, cierre del horizonte',
        accent: delta >= 0 ? '#16a34a' : '#dc2626', valueColor: delta >= 0 ? 'var(--pf-success-700)' : 'var(--pf-danger-700)' };
    } else {
      kpi4 = { label: 'Presupuesto', value: 'No cargado', unit: '', sub: `0 de ${buckets.length} períodos con PPTO`, accent: '#94a3b8', valueColor: 'var(--pf-slate-500)' };
    }
    const kpisHtml = [
      dirKpiCard(`Caja acumulada ${anioFinal}`, PF.fmtNum(acumActual[acumActual.length - 1] || 0), 'UF',
        `Cierre del horizonte de ${numAnios} año${numAnios === 1 ? '' : 's'}`, '#2563eb', 'var(--pf-slate-800)'),
      dirKpiCard('Punto más bajo', PF.fmtNum(minVal), 'UF',
        `En ${buckets.length ? buckets[minIdx].label : '—'}` + (negCount <= 1 ? ' · único tramo negativo' : ` · ${negCount} períodos bajo cero`),
        '#dc2626', minVal < 0 ? 'var(--pf-danger-700)' : 'var(--pf-slate-800)'),
      dirKpiCard(`Caja hasta ${buckets.length ? buckets[jumpBeforeIdx].label : '—'}`, PF.fmtNum(acumActual[jumpBeforeIdx] || 0), 'UF',
        `Previo al mayor salto (${buckets.length ? buckets[jumpIdx].label : '—'})`, '#f59e0b', 'var(--pf-slate-800)'),
      dirKpiCard(kpi4.label, kpi4.value, kpi4.unit, kpi4.sub, kpi4.accent, kpi4.valueColor),
    ].join('');

    const verdictClass = veredicto.tipo === 'ok' ? 'ok' : (veredicto.tipo === 'warning' ? 'warn' : '');
    const cierreVal = acumActual[acumActual.length - 1] || 0;
    const verdictHtml = `<div class="verdict-banner ${verdictClass}">
      <i class="bi ${veredicto.icon} verdict-icon"></i>
      <div class="verdict-text">${veredicto.texto}</div>
      <div class="verdict-gap">Cierre ${PF.esc(buckets.length ? buckets[buckets.length - 1].label : '')}: <b style="color:${cierreVal < 0 ? 'var(--pf-danger-700)' : 'var(--pf-success-700)'}">${PF.fmtNum(cierreVal)} UF</b></div>
    </div>`;

    const dirColW = resumenGranularidad === 'anual' ? '108px' : (resumenGranularidad === 'trimestral' ? '74px' : '78px');
    function dirCellPair(a, p) {
      const cls = a < 0 ? 'neg' : (a > 0 ? 'pos' : 'num-zero');
      const txt = a === 0 ? '—' : PF.fmtNum(a);
      const actualTd = `<td class="num ${cls}">${txt}</td>`;
      if (!hasPresupuesto) return actualTd;
      const d = a - p;
      const dTxt = d === 0 ? '—' : (d > 0 ? '+' : '') + PF.fmtNum(d);
      const dCls = d > 0 ? 'pos' : (d < 0 ? 'neg' : 'num-zero');
      return actualTd + `<td class="num ${dCls}">${dTxt}</td>`;
    }
    function dirAcumCellPair(a, p) {
      const maxAcum = Math.max(...acumActual, 1);
      const semClass = a < 0 ? 'sem-bajo' : (a > maxAcum * 0.25 ? 'sem-ok' : '');
      const txt = a === 0 ? '—' : PF.fmtNum(a);
      const actualTd = `<td class="num ${semClass}" ${semClass ? '' : 'style="background:#f8fafc"'}>${txt}</td>`;
      if (!hasPresupuesto) return actualTd;
      const d = a - p;
      const dTxt = d === 0 ? '—' : (d > 0 ? '+' : '') + PF.fmtNum(d);
      const dCls = d > 0 ? 'pos' : (d < 0 ? 'neg' : 'num-zero');
      return actualTd + `<td class="num ${dCls}">${dTxt}</td>`;
    }
    function dirRowHtml(nombre, icon, actualArr, pptoArr, opts) {
      opts = opts || {};
      const cellFn = opts.isAcum ? dirAcumCellPair : dirCellPair;
      const cellsHtml = buckets.map((b, i) => cellFn(actualArr[i], pptoArr[i])).join('');
      const rowBg = opts.rowBg || '#fff';
      return `<tr style="background:${rowBg}">
        <td class="proj-col" style="background:${rowBg}; font-weight:${opts.weight || 500}; color:${opts.labelColor || 'var(--pf-slate-700)'}">
          <span class="row-label"><i class="bi ${icon}"></i><span>${PF.esc(nombre)}</span></span>
        </td>
        ${cellsHtml}
        <td class="trend-col">${PFCharts.sparkline(actualArr)}</td>
      </tr>`;
    }
    const dirRowsHtml = filas.map((f) => dirRowHtml(f.nombre, 'bi-diagram-2', f.actual, f.ppto)).join('');
    const dirTotalRow = dirRowHtml('Flujo de caja del período', 'bi-arrow-left-right', totalActual, totalPpto, { weight: 700, labelColor: 'var(--pf-slate-800)', rowBg: '#eff6ff' });
    const dirAcumRow = dirRowHtml('Caja acumulada', 'bi-wallet2', acumActual, acumPpto, { weight: 700, labelColor: 'var(--pf-slate-800)', isAcum: true });
    const dirHeadHtml = hasPresupuesto
      ? `<tr><th class="proj-col"></th>${buckets.map((b) => `<th class="num" colspan="2" style="min-width:${dirColW}">${PF.esc(b.label)}</th>`).join('')}<th class="trend-col"></th></tr>
         <tr><th class="proj-col">Categoría</th>${buckets.map(() => '<th class="num small text-muted">Actual</th><th class="num small text-muted">Δ</th>').join('')}<th class="trend-col">Tendencia</th></tr>`
      : `<tr><th class="proj-col">Categoría</th>${buckets.map((b) => `<th class="num" style="min-width:${dirColW}">${PF.esc(b.label)}</th>`).join('')}<th class="trend-col">Tendencia</th></tr>`;
    const GRAN_OPTS = [['trimestral', 'Trimestral'], ['semestral', 'Semestral'], ['anual', 'Anual']];
    const dirTabsHtml = `<div class="dir-tabs" role="tablist">${GRAN_OPTS.map(([g, label]) =>
      `<button type="button" class="dir-tab ${g === resumenGranularidad ? 'active' : ''}" role="tab" aria-selected="${g === resumenGranularidad}" tabindex="${g === resumenGranularidad ? 0 : -1}" data-gran="${g}">${label}</button>`).join('')}</div>`;

    // ---- Flujo de Obras por año de inicio (todo excepto Financiamiento, Dividendo e Impuestos).
    const finCat = state.categorias.find((c) => c.nombre === CAT_FINANCIAMIENTO);
    const obraProyectos = state.proyectos.filter((p) => !finCat || p.categoriaId !== finCat.id);
    const grupos = Array.from(new Set(obraProyectos.map((p) => p.grupoObra || 'Sin clasificar'))).sort();
    const openGrupos = loadOpenMap(OPEN_GRUPOS_KEY);

    const filasObra = grupos.map((g) => {
      const proys = obraProyectos.filter((p) => (p.grupoObra || 'Sin clasificar') === g);
      return {
        grupo: g, proys,
        actual: buckets.map((b) => sumField(proys, b.months, 'proyeccion')),
        ppto: buckets.map((b) => sumField(proys, b.months, 'presupuesto')),
      };
    });
    const totalActualObra = buckets.map((_, i) => filasObra.reduce((a, f) => a + f.actual[i], 0));
    const totalPptoObra = buckets.map((_, i) => filasObra.reduce((a, f) => a + f.ppto[i], 0));
    const acumActualObra = []; let accAO = 0; totalActualObra.forEach((v) => { accAO += v; acumActualObra.push(accAO); });
    const acumPptoObra = []; let accPO = 0; totalPptoObra.forEach((v) => { accPO += v; acumPptoObra.push(accPO); });

    let obraIdx = 0;
    const obraRowsHtml = filasObra.map((f) => {
      const isOpen = Object.prototype.hasOwnProperty.call(openGrupos, f.grupo) ? openGrupos[f.grupo] : obraIdx === 0;
      obraIdx++;
      const cells = buckets.map((b, i) => {
        const a = f.actual[i], p = f.ppto[i], v = a - p;
        const bs = i > 0 ? periodBorder : '';
        return `<td class="num" style="${bs}">${PF.fmtMoney(p)}</td><td class="num">${PF.fmtMoney(a)}</td><td class="num ${v < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(v)}</td>`;
      }).join('');
      const grupoRow = `<tr class="cat-row" data-grupo="${PF.esc(f.grupo)}" data-is-open="${isOpen}" role="button" tabindex="0">
        <td class="proj-col"><span class="row-label"><i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}"></i><span>${PF.esc(f.grupo)}</span></span></td>
        ${cells}
      </tr>`;
      const proyRows = isOpen ? f.proys.map((p) => {
        const pActual = buckets.map((b) => sumField([p], b.months, 'proyeccion'));
        const pPpto = buckets.map((b) => sumField([p], b.months, 'presupuesto'));
        const pCells = buckets.map((b, i) => {
          const a = pActual[i], pp = pPpto[i], v = a - pp;
          const bs = i > 0 ? periodBorder : '';
          return `<td class="num" style="${bs}">${PF.fmtMoney(pp)}</td><td class="num">${PF.fmtMoney(a)}</td><td class="num ${v < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(v)}</td>`;
        }).join('');
        return `<tr class="proj-row" draggable="true" data-proj-id="${p.id}">
          <td class="proj-col"><span class="row-label" style="padding-left:14px; cursor:grab"><i class="bi bi-dot"></i><span>${PF.esc(p.nombre)}</span></span></td>
          ${pCells}
        </tr>`;
      }).join('') : '';
      return grupoRow + proyRows;
    }).join('');
    const obraTotalRow = filaHtml('Flujo de caja (obra)', totalActualObra, totalPptoObra, 'table-light fw-semibold');
    const obraAcumRow = filaHtml('Flujo acumulado (obra)', acumActualObra, acumPptoObra, 'table-light fw-semibold');

    el.innerHTML = `
      ${verdictHtml}
      <div class="kpi2-grid mb-3">${kpisHtml}</div>
      <div class="panel">
        <div class="panel-header-row">
          <div>
            <h3>Caja acumulada ${anioInicial}${anioInicial !== anioFinal ? ' – ' + anioFinal : ''}</h3>
            <p class="panel-hint">Flujo consolidado acumulado por ${resumenGranularidad === 'anual' ? 'año' : (resumenGranularidad === 'trimestral' ? 'trimestre' : 'semestre')}, en UF.</p>
          </div>
          <div class="chart-legend">
            <span class="chart-legend-item"><span class="swatch-line" style="background:#2563eb"></span>Caja acumulada</span>
            ${hasPresupuesto
              ? '<span class="chart-legend-item"><span class="swatch-dash" style="border-top-color:#94a3b8"></span>Presupuesto</span>'
              : '<span class="chart-legend-item" style="color:#94a3b8; background:#f8fafc; border:1px solid var(--pf-border); padding:4px 10px; border-radius:999px"><i class="bi bi-slash-circle"></i> Presupuesto no cargado</span>'}
          </div>
        </div>
        <div class="chart-box" style="position:relative"><canvas id="chart-resumen-acum"></canvas></div>
      </div>
      <div class="panel mb-0">
        <div class="panel-header-row" style="flex-wrap:wrap; gap:12px">
          <div>
            <h3>Flujo de caja por categoría</h3>
            <p class="panel-hint">Valores en UF. Sin movimiento en el período: —</p>
          </div>
          <div style="display:flex; align-items:center; gap:12px; margin-left:auto">
            ${dirTabsHtml}
            <button class="flujo-btn" id="resumen-excel"><i class="bi bi-file-earmark-excel" style="color:#15803d"></i> Exportar Excel</button>
          </div>
        </div>
        ${!buckets.length ? '<div class="text-muted">No hay meses con datos.</div>' : `
        <div class="flujo-table-wrap table-sticky-col" style="margin-top:14px">
          <table class="flujo-table">
            <thead>${dirHeadHtml}</thead>
            <tbody>${dirRowsHtml}${dirTotalRow}${dirAcumRow}</tbody>
          </table>
        </div>`}
        <div class="dir-footer-note">
          <i class="bi bi-info-circle"></i>
          <span>Las columnas de <b>presupuesto y desviación</b> aparecen cuando se importa el PPTO por categoría.</span>
          <a href="#" data-goto="importar">Importar presupuesto →</a>
        </div>
      </div>
      <div class="panel">
        <h6>Flujo de Obras por año de inicio</h6>
        <p class="panel-hint">Todo excepto "${PF.esc(CAT_FINANCIAMIENTO)}". El año se infiere del primer aporte relevante de cada
          proyecto — arrastra una fila a otro grupo si hace falta corregirlo.</p>
        ${!buckets.length ? '<div class="text-muted">No hay meses con datos.</div>' : `
        <div class="flujo-table-wrap table-sticky-col">
          <table class="flujo-table">
            <thead>
              <tr><th class="proj-col"></th>${headCols}</tr>
              <tr><th class="proj-col">Grupo / Proyecto</th>${subCols}</tr>
            </thead>
            <tbody>${obraRowsHtml}${obraTotalRow}${obraAcumRow}</tbody>
          </table>
        </div>`}
      </div>
      <div class="panel">
        <h6>Flujo de Caja: Actual vs Presupuesto</h6>
        <div class="chart-box"><canvas id="chart-resumen-obra"></canvas></div>
      </div>`;

    if (buckets.length) {
      const chart = PFCharts.lineCajaAcumulada('chart-resumen-acum', buckets.map((b) => b.label), acumActual, acumPpto, minIdx);
      if (chart) {
        try {
          const box = document.getElementById('chart-resumen-acum').parentElement;
          const meta = chart.getDatasetMeta(1);
          const minPt = meta.data[minIdx];
          const jumpPt = meta.data[jumpIdx];
          const boxW = box.clientWidth, boxH = box.clientHeight;
          const clampL = (x, w) => Math.max(4, Math.min(x, boxW - w - 4));
          const clampT = (y, h) => Math.max(4, Math.min(y, boxH - h - 4));
          let annotHtml = '';
          if (minPt) {
            const l = clampL(minPt.x - 80, 160), t = clampT(minPt.y - 52, 44);
            annotHtml += `<div class="chart-annotation dark" style="left:${l}px; top:${t}px">
              <div style="font-size:11px; font-weight:700; color:#fff; white-space:nowrap">mínimo ${PF.fmtNum(minVal)} UF</div>
              <div style="font-size:10.5px; color:#94a3b8; white-space:nowrap; margin-top:1px">${PF.esc(buckets[minIdx].label)}</div>
            </div>`;
          }
          if (jumpPt && jumpIdx !== minIdx && totalActual[jumpIdx] > 0) {
            const l = clampL(jumpPt.x - 60, 180), t = clampT(jumpPt.y - 48, 44);
            annotHtml += `<div class="chart-annotation light" style="left:${l}px; top:${t}px">
              <div style="font-size:11px; font-weight:700; color:#15803d; white-space:nowrap">+${PF.fmtNum(totalActual[jumpIdx])} UF en ${PF.esc(buckets[jumpIdx].label)}</div>
              ${jumpContribs.length ? `<div style="font-size:10.5px; color:#64748b; white-space:nowrap; margin-top:1px">${PF.esc(jumpContribs.join(' + '))}</div>` : ''}
            </div>`;
          }
          box.querySelectorAll('.chart-annotation').forEach((n) => n.remove());
          box.insertAdjacentHTML('beforeend', annotHtml);
        } catch (e) { /* anotación visual: no debe romper el render si cambian los internals de Chart.js */ }
      }
      PFCharts.comboInversionVsPpto('chart-resumen-obra', buckets.map((b) => b.label), totalActualObra, totalPptoObra, acumActualObra, acumPptoObra);
    }

    el.querySelectorAll('.cat-row[data-grupo]').forEach((row) => {
      const toggle = () => {
        const grupo = row.dataset.grupo;
        const wasOpen = row.dataset.isOpen === 'true';
        const cur = loadOpenMap(OPEN_GRUPOS_KEY);
        cur[grupo] = !wasOpen;
        saveOpenMap(OPEN_GRUPOS_KEY, cur);
        renderResumenDirectorio();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.style.background = 'var(--pf-primary-tint)'; });
      row.addEventListener('dragleave', () => { row.style.background = ''; });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.style.background = '';
        const projId = e.dataTransfer.getData('text/plain');
        if (!projId) return;
        await DB.updateProyecto(projId, { grupoObra: row.dataset.grupo });
        await loadAll();
        renderResumenDirectorio();
      });
    });
    el.querySelectorAll('.proj-row[draggable]').forEach((row) => {
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', row.dataset.projId); });
    });

    el.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.goto); }));

    const tabEls = Array.from(el.querySelectorAll('.dir-tab'));
    const setGran = (g) => {
      resumenGranularidad = g;
      try { localStorage.setItem(DIR_GRAN_KEY, g); } catch (e) { /* localStorage puede no estar disponible */ }
      renderResumenDirectorio();
    };
    tabEls.forEach((btn, i) => {
      btn.addEventListener('click', () => setGran(btn.dataset.gran));
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = tabEls[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabEls.length) % tabEls.length];
        next.focus();
        setGran(next.dataset.gran);
      });
    });

    el.querySelector('#resumen-excel').addEventListener('click', () => {
      const header = ['Categoría', ...buckets.flatMap((b) => (hasPresupuesto ? [b.label + ' Actual', b.label + ' Δ'] : [b.label]))];
      const aoa = [header];
      filas.forEach((f) => aoa.push([f.nombre, ...buckets.flatMap((b, i) => (hasPresupuesto ? [f.actual[i], f.actual[i] - f.ppto[i]] : [f.actual[i]]))]));
      aoa.push(['Flujo de caja del período', ...buckets.flatMap((b, i) => (hasPresupuesto ? [totalActual[i], totalActual[i] - totalPpto[i]] : [totalActual[i]]))]);
      aoa.push(['Caja acumulada', ...buckets.flatMap((b, i) => (hasPresupuesto ? [acumActual[i], acumActual[i] - acumPpto[i]] : [acumActual[i]]))]);
      PFReports.exportExcel('resumen_directorio.xlsx', 'Resumen Directorio', aoa);
    });
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
        <div class="text-muted small mb-2">${PF.esc(categoriaNombre(p.categoriaId))}${p.tipo ? ' · ' + PF.esc(p.tipo) : ''}</div>
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
            ${p.tipo ? '· ' + PF.esc(p.tipo) : ''}
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
          <div class="mb-2"><label class="form-label small">Tipo <span class="text-muted">(opcional)</span></label>
            <input class="form-control" id="mp-tipo" value="${isEdit ? PF.esc(proj.tipo || '') : ''}" placeholder="Ej: DS19, Núcleos, Hoteles"></div>
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
      const data = { nombre, categoriaId: wrap.querySelector('#mp-cat').value, moneda: wrap.querySelector('#mp-moneda').value, tipo: wrap.querySelector('#mp-tipo').value.trim() };
      if (isEdit) await DB.updateProyecto(proj.id, data); else await DB.addProyecto(data);
      await loadAll(); modal.hide(); toast('Proyecto guardado', 'success'); renderProyectos();
    });
  }

  // ------------------------------------------------------- Vista: Importar
  let importState = null;
  let masterState = null;
  let importMode = 'unico';

  function renderImportar() {
    const el = document.getElementById('importar');
    el.innerHTML = `
      <div class="panel">
        <div class="btn-group" role="group">
          <input type="radio" class="btn-check" name="imp-mode" id="imp-mode-unico" ${importMode === 'unico' ? 'checked' : ''}>
          <label class="btn btn-outline-primary" for="imp-mode-unico"><i class="bi bi-file-earmark-spreadsheet me-1"></i>Un proyecto</label>
          <input type="radio" class="btn-check" name="imp-mode" id="imp-mode-maestro" ${importMode === 'maestro' ? 'checked' : ''}>
          <label class="btn btn-outline-primary" for="imp-mode-maestro"><i class="bi bi-files me-1"></i>Archivo maestro (todas las categorías)</label>
          <input type="radio" class="btn-check" name="imp-mode" id="imp-mode-presupuesto" ${importMode === 'presupuesto' ? 'checked' : ''}>
          <label class="btn btn-outline-primary" for="imp-mode-presupuesto"><i class="bi bi-bookmark-check me-1"></i>Presupuesto (semestral)</label>
        </div>
      </div>
      <div id="imp-body"></div>`;
    el.querySelector('#imp-mode-unico').addEventListener('change', () => { importMode = 'unico'; renderImportarBody(); });
    el.querySelector('#imp-mode-maestro').addEventListener('change', () => { importMode = 'maestro'; renderImportarBody(); });
    el.querySelector('#imp-mode-presupuesto').addEventListener('change', () => { importMode = 'presupuesto'; renderImportarBody(); });
    renderImportarBody();
  }

  function renderImportarBody() {
    if (importMode === 'maestro') renderImportarMaestro();
    else if (importMode === 'presupuesto') renderImportarPresupuesto();
    else renderImportarUnico();
  }

  function renderImportarUnico() {
    const el = document.getElementById('imp-body');
    const projOpts = state.proyectos.map((p) => `<option value="${p.id}">${PF.esc(p.nombre)} — ${PF.esc(categoriaNombre(p.categoriaId))}</option>`).join('');
    const catOpts = state.categorias.map((c) => `<option value="${c.id}">${PF.esc(c.nombre)}</option>`).join('');
    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">1</span> ¿Qué actualiza este archivo?</h6>
        <div class="btn-group" role="group" id="imp-target-group">
          <input type="radio" class="btn-check" name="imp-target" id="imp-target-proyeccion" value="proyeccion" checked>
          <label class="btn btn-outline-primary" for="imp-target-proyeccion">Proyección (actualización mensual)</label>
          <input type="radio" class="btn-check" name="imp-target" id="imp-target-presupuesto" value="presupuesto">
          <label class="btn btn-outline-primary" for="imp-target-presupuesto">Presupuesto (línea base)</label>
        </div>
        <div class="text-muted small mt-2">La Proyección se actualiza cada vez que subes un Excel nuevo.
          El Presupuesto se carga una sola vez y queda fijo, para comparar &quot;cómo vamos&quot; contra esa línea base.</div>
      </div>
      <div class="panel">
        <h6><span class="step-badge">2</span> ¿A qué proyecto pertenece este Excel?</h6>
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
        <h6><span class="step-badge">3</span> Sube el Excel del proyecto</h6>
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
        <h6><span class="step-badge">4</span> Mapea los datos</h6>
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
        <button class="btn btn-primary mt-3" id="imp-save"><i class="bi bi-check-lg"></i> Guardar datos</button>
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
    const target = (el.querySelector('input[name="imp-target"]:checked') || {}).value || 'proyeccion';
    let projId = el.querySelector('#imp-proj').value;
    const meta = { fileName: importState.file.name, sheet: importState.sheet, importedAt: Date.now() };

    if (!projId) {
      const nombre = el.querySelector('#imp-new-name').value.trim();
      if (!nombre) { toast('Ingresa el nombre del nuevo proyecto', 'warning'); return; }
      const p = await DB.addProyecto({
        nombre, categoriaId: el.querySelector('#imp-new-cat').value, moneda: state.config.moneda,
        [target]: importState.proyeccion, ultimaImportacion: meta,
      });
      projId = p.id;
    } else {
      const existing = state.proyectos.find((p) => p.id === projId);
      const existingField = (existing && existing[target]) || {};
      if (target === 'presupuesto' && Object.keys(existingField).length) {
        const ok = confirm(`Este proyecto ya tiene un Presupuesto cargado (${Object.keys(existingField).length} meses). ` +
          'El Presupuesto debería quedar fijo como línea base. ¿Confirmas que quieres reemplazarlo/actualizarlo?');
        if (!ok) return;
      }
      // Fusiona los datos importados con los existentes (sobrescribe meses repetidos).
      const merged = Object.assign({}, existingField, importState.proyeccion);
      await DB.updateProyecto(projId, { [target]: merged, ultimaImportacion: meta });
    }
    await DB.addImportLog({ projId, target, fileName: meta.fileName, sheet: meta.sheet, meses: Object.keys(importState.proyeccion).length, byEmail: state.user ? state.user.email : 'local' });
    await loadAll();
    importState = null;
    toast((target === 'presupuesto' ? 'Presupuesto' : 'Proyección') + ' importado correctamente', 'success');
    showView('proyectos');
    renderProyectoDetail(projId);
  }

  // ------------------------------------------------------- Importar: Archivo maestro
  function renderImportarMaestro() {
    const el = document.getElementById('imp-body');
    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">1</span> Sube el archivo maestro (una hoja por categoría, una fila por proyecto)</h6>
        <div class="dropzone" id="mst-drop">
          <i class="bi bi-file-earmark-excel fs-1"></i>
          <div class="mt-2">Arrastra el archivo aquí o haz clic para seleccionar</div>
          <div class="small">.xlsx / .xlsm / .xls</div>
        </div>
        <input type="file" id="mst-file" accept=".xlsx,.xls,.xlsm" class="d-none">
      </div>
      <div id="mst-map"></div>`;

    const drop = el.querySelector('#mst-drop');
    const fileInput = el.querySelector('#mst-file');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) handleMasterFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleMasterFile(e.target.files[0]); });
  }

  async function handleMasterFile(file) {
    try {
      const { wb, sheetNames } = await PFImporter.parseFile(file);
      const sheets = sheetNames.map((sheetName) => {
        const grid = PFImporter.sheetToGrid(wb, sheetName);
        const det = PFImporter.detectRows(grid);
        const headerRow = det.monthRow >= 0 ? det.monthRow : 0;
        const { rows } = PFImporter.extractMasterRows(grid, headerRow);
        return { sheetName, rows, categoriaId: guessCategoria(sheetName) };
      }).filter((s) => s.rows.length);
      if (!sheets.length) { toast('No se detectaron hojas con proyectos (fila de nombre + meses).', 'warning'); return; }
      masterState = { file, sheets };
      renderMasterMapping();
    } catch (e) {
      console.error(e); toast('No se pudo leer el archivo: ' + e.message, 'danger');
    }
  }

  // Adivina la categoría de una hoja por nombre: match exacto normalizado, o mayor solape de
  // palabras (tolera plurales/abreviaturas como "Inv y Rentas" vs "Inv. y Rentas").
  function guessCategoria(sheetName) {
    const target = PFImporter.normalizeLabel(sheetName);
    const exact = state.categorias.find((c) => PFImporter.normalizeLabel(c.nombre) === target);
    if (exact) return exact.id;

    const targetWords = target.split(' ').filter(Boolean);
    let best = null, bestScore = 0;
    state.categorias.forEach((c) => {
      const words = PFImporter.normalizeLabel(c.nombre).split(' ').filter(Boolean);
      let hits = 0;
      words.forEach((w) => {
        if (targetWords.some((tw) => tw === w || tw.startsWith(w) || w.startsWith(tw))) hits++;
      });
      const score = hits / Math.max(words.length, targetWords.length);
      if (score > bestScore) { bestScore = score; best = c; }
    });
    return bestScore >= 0.35 ? best.id : '';
  }

  function renderMasterMapping() {
    const el = document.getElementById('mst-map');
    const catOpts = (selectedId) => state.categorias.map((c) =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${PF.esc(c.nombre)}</option>`).join('');
    const rows = masterState.sheets.map((s, i) => `
      <tr>
        <td>${PF.esc(s.sheetName)}</td>
        <td class="num">${s.rows.length}</td>
        <td><select class="form-select form-select-sm mst-cat" data-idx="${i}">
          <option value="">— Omitir esta hoja —</option>${catOpts(s.categoriaId)}
        </select></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">2</span> Confirma a qué categoría corresponde cada hoja</h6>
        <table class="table table-sm">
          <thead><tr><th>Hoja del Excel</th><th class="num">Proyectos detectados</th><th>Categoría</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <button class="btn btn-primary mt-2" id="mst-continue">Continuar</button>
      </div>`;

    el.querySelectorAll('.mst-cat').forEach((sel) => sel.addEventListener('change', (e) => {
      masterState.sheets[+e.target.dataset.idx].categoriaId = e.target.value;
    }));
    el.querySelector('#mst-continue').addEventListener('click', renderMasterPreview);
  }

  function renderMasterPreview() {
    const el = document.getElementById('mst-map');
    const mapped = masterState.sheets.filter((s) => s.categoriaId);
    let nuevos = 0, actualizados = 0;
    const items = [];
    mapped.forEach((s) => {
      const existentesEnCat = state.proyectos.filter((p) => p.categoriaId === s.categoriaId);
      s.rows.forEach((r) => {
        const match = existentesEnCat.find((p) => PFImporter.normalizeLabel(p.nombre) === PFImporter.normalizeLabel(r.nombre));
        const meses = Object.keys(r.proyeccion).length;
        const neto = Object.values(r.proyeccion).reduce((a, b) => a + b, 0);
        if (match) actualizados++; else nuevos++;
        items.push({ categoriaId: s.categoriaId, nombre: r.nombre, tipo: r.tipo, proyeccion: r.proyeccion, matchId: match ? match.id : null, meses, neto });
      });
    });

    if (!items.length) {
      el.innerHTML = `<div class="alert alert-warning">No quedó ninguna hoja mapeada a una categoría. Vuelve atrás y elige al menos una.</div>
        <button class="btn btn-secondary" id="mst-back">Volver</button>`;
      el.querySelector('#mst-back').addEventListener('click', renderMasterMapping);
      return;
    }

    const rowsHtml = items.map((it) => `
      <tr>
        <td>${PF.esc(it.nombre)}</td>
        <td class="text-muted small">${PF.esc(categoriaNombre(it.categoriaId))}${it.tipo ? ' · ' + PF.esc(it.tipo) : ''}</td>
        <td class="num">${it.meses}</td>
        <td class="num ${it.neto < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(it.neto)}</td>
        <td>${it.matchId ? '<span class="badge text-bg-secondary">Actualizar</span>' : '<span class="badge text-bg-success">Nuevo</span>'}</td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">3</span> Confirma e importa</h6>
        <div class="alert alert-info py-2">
          <b>${items.length}</b> proyectos detectados en <b>${mapped.length}</b> hoja(s):
          <b class="pos">${nuevos} nuevos</b>, <b>${actualizados} a actualizar</b>.
        </div>
        <div class="preview-grid mb-3">
          <table class="table table-sm mb-0">
            <thead><tr><th>Proyecto</th><th>Categoría</th><th class="num">Meses</th><th class="num">Neto</th><th>Estado</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <button class="btn btn-secondary me-2" id="mst-back">Volver</button>
        <button class="btn btn-primary" id="mst-import"><i class="bi bi-check-lg"></i> Importar ${items.length} proyectos</button>
      </div>`;

    el.querySelector('#mst-back').addEventListener('click', renderMasterMapping);
    el.querySelector('#mst-import').addEventListener('click', () => saveMasterImport(items));
  }

  async function saveMasterImport(items) {
    let nuevos = 0, actualizados = 0;
    const mesesSet = new Set();
    const meta = { fileName: masterState.file.name, sheet: `maestro (${masterState.sheets.filter((s) => s.categoriaId).length} hojas)`, importedAt: Date.now() };
    for (const it of items) {
      Object.keys(it.proyeccion).forEach((m) => mesesSet.add(m));
      if (it.matchId) {
        const existing = state.proyectos.find((p) => p.id === it.matchId);
        const merged = Object.assign({}, existing ? existing.proyeccion : {}, it.proyeccion);
        await DB.updateProyecto(it.matchId, { proyeccion: merged, tipo: it.tipo || (existing && existing.tipo) || '', ultimaImportacion: meta });
        actualizados++;
      } else {
        await DB.addProyecto({ nombre: it.nombre, categoriaId: it.categoriaId, moneda: state.config.moneda, tipo: it.tipo, proyeccion: it.proyeccion, ultimaImportacion: meta });
        nuevos++;
      }
    }
    await DB.addImportLog({
      fileName: meta.fileName, sheet: meta.sheet,
      target: 'proyeccion', meses: mesesSet.size, byEmail: state.user ? state.user.email : 'local',
    });
    await loadAll();
    masterState = null;
    toast(`Importación masiva: ${nuevos} proyectos nuevos, ${actualizados} actualizados`, 'success');
    showView('proyectos');
  }

  // ------------------------------------------------------- Importar: Presupuesto semestral
  let presupuestoState = null;

  function renderImportarPresupuesto() {
    const el = document.getElementById('imp-body');
    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">1</span> Sube el archivo de presupuesto (columnas por semestre: 1S 2026, 2S 2026, ...)</h6>
        <div class="dropzone" id="ppt-drop">
          <i class="bi bi-file-earmark-excel fs-1"></i>
          <div class="mt-2">Arrastra el archivo aquí o haz clic para seleccionar</div>
          <div class="small">.xlsx / .xlsm / .xls</div>
        </div>
        <input type="file" id="ppt-file" accept=".xlsx,.xls,.xlsm" class="d-none">
      </div>
      <div id="ppt-map"></div>`;

    const drop = el.querySelector('#ppt-drop');
    const fileInput = el.querySelector('#ppt-file');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) handlePresupuestoFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handlePresupuestoFile(e.target.files[0]); });
  }

  async function handlePresupuestoFile(file) {
    try {
      const { wb, sheetNames } = await PFImporter.parseFile(file);
      const sheetName = sheetNames.find((n) => /presupuesto/i.test(n)) || sheetNames[0];
      const grid = PFImporter.sheetToGrid(wb, sheetName);
      const headerRow = PFImporter.detectSemesterHeaderRow(grid);
      if (headerRow < 0) { toast('No se detectaron columnas de semestre (ej. "1S 2026") en el archivo.', 'danger'); return; }
      const flagCol = PFImporter.detectFlagColumn(grid, headerRow);
      const { rows } = PFImporter.extractPresupuestoRows(grid, headerRow, flagCol);
      if (!rows.length) { toast('No se detectaron filas de proyecto con presupuesto.', 'warning'); return; }
      presupuestoState = { file, rows };
      renderPresupuestoPreview();
    } catch (e) {
      console.error(e); toast('No se pudo leer el archivo: ' + e.message, 'danger');
    }
  }

  function renderPresupuestoPreview() {
    const el = document.getElementById('ppt-map');
    const catOtros = state.categorias.find((c) => c.nombre === 'Otros') || state.categorias[0] || {};
    const catOpts = (selectedId) => state.categorias.map((c) =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${PF.esc(c.nombre)}</option>`).join('');

    const items = presupuestoState.rows.map((r) => {
      const match = state.proyectos.find((p) => PFImporter.normalizeLabel(p.nombre) === PFImporter.normalizeLabel(r.nombre));
      const meses = Object.keys(r.presupuesto).length;
      const neto = Object.values(r.presupuesto).reduce((a, b) => a + b, 0);
      return {
        nombre: r.nombre, presupuesto: r.presupuesto, matchId: match ? match.id : null,
        categoriaId: match ? match.categoriaId : catOtros.id, meses, neto,
      };
    });
    const nuevos = items.filter((it) => !it.matchId).length;
    const actualizados = items.length - nuevos;

    const rowsHtml = items.map((it, i) => `
      <tr>
        <td>${PF.esc(it.nombre)}</td>
        <td class="num">${it.meses}</td>
        <td class="num ${it.neto < 0 ? 'neg' : 'pos'}">${PF.fmtMoney(it.neto)}</td>
        <td>${it.matchId ? '<span class="badge text-bg-secondary">Actualizar</span>' : '<span class="badge text-bg-success">Nuevo</span>'}</td>
        <td>${it.matchId ? PF.esc(categoriaNombre(it.categoriaId)) : `<select class="form-select form-select-sm ppt-cat" data-idx="${i}">${catOpts(it.categoriaId)}</select>`}</td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="panel">
        <h6><span class="step-badge">2</span> Confirma e importa</h6>
        <div class="alert alert-info py-2">
          <b>${items.length}</b> proyectos detectados: <b class="pos">${nuevos} nuevos</b>, <b>${actualizados} a actualizar</b>.
          El monto de cada semestre se reparte en partes iguales entre sus 6 meses.
        </div>
        <div class="preview-grid mb-3">
          <table class="table table-sm mb-0">
            <thead><tr><th>Proyecto</th><th class="num">Meses</th><th class="num">Neto</th><th>Estado</th><th>Categoría</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <button class="btn btn-primary" id="ppt-import"><i class="bi bi-check-lg"></i> Importar presupuesto de ${items.length} proyectos</button>
      </div>`;

    el.querySelectorAll('.ppt-cat').forEach((sel) => sel.addEventListener('change', (e) => {
      items[+e.target.dataset.idx].categoriaId = e.target.value;
    }));
    el.querySelector('#ppt-import').addEventListener('click', () => savePresupuestoImport(items));
  }

  async function savePresupuestoImport(items) {
    const yaCargados = items.filter((it) => {
      if (!it.matchId) return false;
      const existing = state.proyectos.find((p) => p.id === it.matchId);
      return existing && Object.keys(existing.presupuesto || {}).length;
    }).length;
    if (yaCargados) {
      const ok = confirm(`${yaCargados} proyecto(s) ya tienen presupuesto cargado y se van a actualizar. ¿Continuar?`);
      if (!ok) return;
    }
    let nuevos = 0, actualizados = 0;
    const mesesSet = new Set();
    const meta = { fileName: presupuestoState.file.name, sheet: 'presupuesto semestral', importedAt: Date.now() };
    for (const it of items) {
      Object.keys(it.presupuesto).forEach((m) => mesesSet.add(m));
      if (it.matchId) {
        const existing = state.proyectos.find((p) => p.id === it.matchId);
        const merged = Object.assign({}, existing ? existing.presupuesto : {}, it.presupuesto);
        await DB.updateProyecto(it.matchId, { presupuesto: merged });
        actualizados++;
      } else {
        await DB.addProyecto({ nombre: it.nombre, categoriaId: it.categoriaId, moneda: state.config.moneda, presupuesto: it.presupuesto });
        nuevos++;
      }
    }
    await DB.addImportLog({
      fileName: meta.fileName, sheet: meta.sheet, target: 'presupuesto',
      meses: mesesSet.size, byEmail: state.user ? state.user.email : 'local',
    });
    await loadAll();
    presupuestoState = null;
    toast(`Presupuesto importado: ${nuevos} proyectos nuevos, ${actualizados} actualizados`, 'success');
    showView('resumen-directorio');
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
        <button class="btn btn-sm btn-outline-secondary" id="btn-reset-cats">Restablecer categorías por defecto</button>
        <div class="text-muted small mt-1">Borra las categorías sin proyectos asociados y vuelve a crear las 5 categorías estándar
          (Inmobiliaria Ingevec, Inmobiliarias Asociadas, Inv. y Rentas, Financiamiento/Dividendo e Impuestos, Otros).
          Útil si este navegador quedó con categorías de una versión anterior de la app.</div>
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
    el.querySelector('#btn-reset-cats').addEventListener('click', async () => {
      if (!confirm('Esto borra las categorías sin proyectos asociados y vuelve a crear las 5 categorías estándar. ¿Continuar?')) return;
      const usadas = new Set(state.proyectos.map((p) => p.categoriaId));
      for (const c of state.categorias) {
        if (!usadas.has(c.id)) await DB.deleteCategoria(c.id);
      }
      await DB.ensureSeed();
      await loadAll();
      toast('Categorías restablecidas', 'success');
      renderConfig();
    });
  }

  // ------------------------------------------------------------------ Helpers UI
  function emptyState(title, sub, gotoView) {
    return `<div class="empty-state"><div class="empty-icon"><i class="bi bi-inbox"></i></div>
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

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
      const r = Math.round(v);
      const s = Math.abs(r).toLocaleString('es-CL');
      return r < 0 ? '(' + s + ')' : s;
    },
    fmtMoney(v, moneda) {
      if (v === null || v === undefined || isNaN(v)) return '—';
      const r = Math.round(v);
      const body = Math.abs(r).toLocaleString('es-CL');
      const withUnit = (moneda || state.config.moneda) === 'CLP' ? '$' + body : body + ' UF';
      return r < 0 ? '(' + withUnit + ')' : withUnit;
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

  // Desactiva el botón mientras `fn` corre (evita doble clic durante guardados largos —
  // ej. importar 170 proyectos hace ~170 escrituras seguidas sin ningún indicador visual,
  // así que un segundo clic mientras tanto dispara el guardado completo dos veces y duplica
  // todo). Si `fn` navega a otra vista al terminar, el botón deja de existir y no hace falta
  // reactivarlo; si lanza un error, se reactiva para poder reintentar.
  function busyOnClick(btn, label, fn) {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${PF.esc(label)}`;
      try {
        await fn();
      } catch (e) {
        console.error(e);
        toast('No se pudo guardar: ' + e.message, 'danger');
      } finally {
        if (document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = original; }
      }
    });
  }

  // ------------------------------------------------------------------ Estado
  const state = {
    mode: 'local',
    user: null,
    role: null, // 'admin' | 'lector' | null (null = local o sin rol asignado)
    config: { cajaInicial: 0, mesInicial: '', moneda: 'UF', umbralAlerta: 0 },
    categorias: [],
    proyectos: [],
    cajaReal: {},
    importLog: [],
    planProyectos: [],
    currentProyectoId: null,
  };

  async function loadAll() {
    const [config, categorias, proyectos, cajaReal, importLog, planProyectos] = await Promise.all([
      DB.getConfig(), DB.listCategorias(), DB.listProyectos(), DB.getCajaReal(), DB.listImportLog(), DB.listPlanProyectos(),
    ]);
    state.config = config;
    state.categorias = categorias;
    state.proyectos = proyectos;
    state.cajaReal = cajaReal;
    state.importLog = importLog;
    state.planProyectos = planProyectos;
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
      caja: 'Caja del banco', pagos: 'Programar pagos', planificacion: 'Planificación',
      reportes: 'Reportes', config: 'Configuración', usuarios: 'Usuarios',
    };
    document.getElementById('view-title').textContent = titles[id] || '';
    const renders = {
      dashboard: renderDashboard, 'categorias-view': renderCategoriasView, 'flujo-mensual': renderFlujoMensual,
      'resumen-directorio': renderResumenDirectorio, proyectos: renderProyectos, importar: renderImportar,
      caja: renderCaja, pagos: renderPagos, planificacion: renderPlanificacion, reportes: renderReportes,
      config: renderConfig, usuarios: renderUsuarios,
    };
    if (renders[id]) renders[id]();
  }

  function wireNav() {
    document.querySelectorAll('.sidebar-nav .nav-link').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
    });
  }

  // ------------------------------------------------------------- Vista: Dashboard
  function kpi2Card(label, value, sub, accent, valueColor, signed) {
    const num = PF.fmtNum(value);
    const shown = signed && value > 0 ? '+' + num : num;
    return `<div class="kpi2-card">
      <div class="kpi2-accent" style="background:${accent}"></div>
      <div class="kpi2-label">${PF.esc(label)}</div>
      <div class="kpi2-value" style="color:${valueColor}">${shown} <span class="unit">UF</span></div>
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

  // Tooltip on-hover para los gráficos SVG a mano (Consolidado): cada `.hover-pt` (punto o
  // barra invisible) trae data-tip-title/-sub/-tone; en mouseenter se posiciona un único div
  // por gráfico usando las coordenadas reales del punto (getBoundingClientRect), no las
  // unidades internas del viewBox — así siempre cae en el lugar correcto sin importar a qué
  // ancho haya escalado el SVG.
  function wireChartHoverTips(root) {
    root.querySelectorAll('.chart-svg-wrap').forEach((wrap) => {
      const tip = document.createElement('div');
      tip.className = 'chart-hover-tip chart-annotation';
      wrap.appendChild(tip);
      wrap.querySelectorAll('.hover-pt').forEach((pt) => {
        pt.addEventListener('mouseenter', () => {
          const tone = pt.dataset.tipTone || 'dark';
          tip.className = 'chart-hover-tip chart-annotation ' + tone;
          tip.innerHTML = `<div style="font-size:11px; font-weight:700; color:${tone === 'dark' ? '#fff' : '#0f172a'}; white-space:nowrap">${PF.esc(pt.dataset.tipTitle)}</div>
            <div style="font-size:10.5px; color:${tone === 'dark' ? '#94a3b8' : '#64748b'}; white-space:nowrap; margin-top:1px">${PF.esc(pt.dataset.tipSub)}</div>`;
          tip.style.display = 'block';
          const wrapRect = wrap.getBoundingClientRect();
          const ptRect = pt.getBoundingClientRect();
          const cx = ptRect.left + ptRect.width / 2 - wrapRect.left;
          const cy = ptRect.top - wrapRect.top;
          const tipW = tip.offsetWidth || 140, tipH = tip.offsetHeight || 44;
          const left = Math.max(4, Math.min(cx - tipW / 2, wrapRect.width - tipW - 4));
          const top = Math.max(4, cy - tipH - 12);
          tip.style.left = left + 'px';
          tip.style.top = top + 'px';
        });
        pt.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      });
    });
  }

  // Años marcados para mostrar en los 2 gráficos de Consolidado (vacío = todos). Es solo una
  // ventana de visualización — recorta qué meses/trimestres se dibujan, pero no recalcula nada
  // (KPIs y alertas siguen viendo el horizonte completo, porque son advertencias reales, no una
  // vista editable).
  let dashYearFilter = new Set();

  function renderDashboard() {
    const el = document.getElementById('dashboard');
    if (!state.proyectos.length) { el.innerHTML = emptyState('No hay proyectos todavía', 'Importa un Excel para comenzar (menú "Importar Excel").'); return; }

    const t = buildTimeline();
    const cur = PF.currentMonth();
    // La referencia de este panel es "caja en cero" (no un umbral configurable): tramo = meses
    // consecutivos con proyección negativa que contienen el mínimo.
    const tramo = umbralAlertaMonths(t, 0);

    // ---- KPI 1: Caja actual (real si hay dato del mes actual; si no hay ninguna caja real
    // cargada todavía, se deja claro que el número es solo la Caja inicial configurada).
    const cajaActualMonth = (t.proj[cur] != null) ? cur
      : (t.months.length ? (cur < t.months[0] ? t.months[0] : t.months[t.months.length - 1]) : null);
    const cajaActual = state.cajaReal[cur] ? state.cajaReal[cur].monto : (cajaActualMonth ? t.proj[cajaActualMonth] : null);
    const hasCajaReal = Object.keys(state.cajaReal || {}).length > 0;
    const kpi1Sub = state.cajaReal[cur]
      ? 'Real (banco), ' + PF.monthLabel(cur)
      : (hasCajaReal ? 'Proyectada, ' + PF.monthLabel(cajaActualMonth) : 'Caja inicial · sin caja real cargada');

    // ---- KPI 3: egresos (aportes) de los próximos 12 meses desde hoy.
    const curIdx = t.months.findIndex((m) => m >= cur);
    const proxStart = curIdx >= 0 ? curIdx : Math.max(0, t.months.length - 12);
    const prox12Months = t.months.slice(proxStart, proxStart + 12);
    const prox12 = prox12Months.reduce((s, m) => s + Math.min(0, t.net[m] || 0), 0);
    const prox12Year = prox12Months.length ? prox12Months[0].slice(0, 4) : '';

    // ---- KPI 4: neto de todo el horizonte proyectado (no solo el año calendario en curso).
    const netoHorizonte = t.months.reduce((s, m) => s + (t.net[m] || 0), 0);
    const cierreProyectado = t.months.length ? t.proj[t.months[t.months.length - 1]] : 0;

    // ---- Banner de veredicto.
    let verdictHtml;
    if (tramo) {
      verdictHtml = `<div class="verdict-banner">
        <i class="bi bi-exclamation-triangle-fill verdict-icon"></i>
        <div class="verdict-text">La caja queda negativa ${tramo.count} mes${tramo.count > 1 ? 'es' : ''} a partir de <b>${PF.monthLabel(tramo.start)}</b>, con un mínimo de <b>${PF.fmtNum(t.minAcc)} UF</b> en ${PF.monthLabel(t.minMonth)}.</div>
        <div class="verdict-gap">Faltan <b>${PF.fmtNum(Math.abs(t.minAcc))} UF</b> para no cruzar el cero</div>
      </div>`;
    } else {
      verdictHtml = `<div class="verdict-banner ok">
        <i class="bi bi-check-circle-fill verdict-icon"></i>
        <div class="verdict-text">La caja se mantiene positiva en los ${t.months.length} meses proyectados (mínimo ${PF.fmtNum(t.minAcc)} UF en ${PF.monthLabel(t.minMonth)}).</div>
      </div>`;
    }

    // ---- Alertas.
    const alertas = [];
    if (tramo) {
      const tramoEndIdx = t.months.indexOf(tramo.end);
      const recoveryMonth = tramoEndIdx + 1 < t.months.length ? t.months[tramoEndIdx + 1] : null;
      const recoveryTxt = recoveryMonth ? `se recupera recién en ${recoveryMonth.slice(0, 4)}` : 'no se recupera dentro del horizonte proyectado';
      const rangoTxt = tramo.count > 1 ? `De ${PF.monthLabel(tramo.start)} a ${PF.monthLabel(tramo.end)}` : `En ${PF.monthLabel(tramo.start)}`;
      alertas.push({
        nivel: 'Crítica', when: 'hoy', icon: 'bi-exclamation-triangle-fill', bg: 'var(--pf-danger-100)', fg: 'var(--pf-danger-700)',
        title: `La caja cruza a negativo en ${tramo.start.slice(0, 4)}`,
        detail: `El punto más bajo es ${PF.fmtNum(t.minAcc)} UF en ${PF.monthLabel(t.minMonth)}; ${recoveryTxt}.`,
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

    const allYearsInData = Array.from(new Set(t.months.map((m) => m.slice(0, 4))));
    const yearKeep = (y) => !dashYearFilter.size || dashYearFilter.has(y);

    const monthsShown = t.months.filter((m) => yearKeep(m.slice(0, 4)));
    const labels = monthsShown.map(PF.monthLabel);
    const years = monthsShown.map((m) => m.slice(0, 4));
    const projArr = monthsShown.map((m) => t.proj[m]);
    const realArr = monthsShown.map((m) => (t.real[m] != null ? t.real[m] : null));

    // Flujo neto: se agrega a trimestre (60 barras mensuales no se leen); reutiliza
    // periodBuckets, igual que Resumen Directorio.
    const qBuckets = periodBuckets(t.months, 'trimestral').filter((b) => yearKeep(b.months[0].slice(0, 4)));
    const qLabels = qBuckets.map((b) => b.label);
    const qYears = qBuckets.map((b) => b.months[0].slice(0, 4));
    const qNet = qBuckets.map((b) => b.months.reduce((s, m) => s + (t.net[m] || 0), 0));

    const dashYearChipsHtml = allYearsInData.length > 1 ? `<div class="dash-year-chips">
      <span class="text-muted small me-1">Años:</span>
      <button type="button" class="dash-year-chip ${!dashYearFilter.size ? 'active' : ''}" data-year="">Todos</button>
      ${allYearsInData.map((y) => `<button type="button" class="dash-year-chip ${dashYearFilter.has(y) ? 'active' : ''}" data-year="${y}">${y}</button>`).join('')}
    </div>` : '';

    el.innerHTML = `
      ${verdictHtml}
      <div class="d-flex gap-3 align-items-start flex-wrap flex-lg-nowrap">
        <div class="flex-grow-1" style="min-width:0; flex-basis:0">
          <div class="kpi2-grid">
            ${kpi2Card('Caja actual', cajaActual, kpi1Sub, '#2563eb', 'var(--pf-slate-800)')}
            ${kpi2Card('Mínimo proyectado', t.minAcc, 'En ' + PF.monthLabel(t.minMonth) + (tramo ? ' · caja negativa' : ''), '#dc2626', tramo ? 'var(--pf-danger-700)' : 'var(--pf-slate-800)')}
            ${kpi2Card('Aportes próximos 12 meses', Math.abs(prox12), 'Egresos a programar en ' + prox12Year, '#f59e0b', 'var(--pf-slate-800)')}
            ${kpi2Card('Neto del horizonte', netoHorizonte, 'Cierre proyectado ' + PF.fmtNum(cierreProyectado) + ' UF', '#16a34a', 'var(--pf-slate-800)', true)}
          </div>

          ${dashYearChipsHtml}
          <div class="panel">
            <div class="panel-header-row">
              <div>
                <h3>Caja acumulada: proyectada vs. real</h3>
                <p class="panel-hint">Caja inicial ${PF.fmtNum(state.config.cajaInicial)} UF · ${monthsShown.length} de ${t.months.length} meses, en UF</p>
              </div>
              <div class="chart-legend">
                <span class="chart-legend-item"><span class="swatch-line" style="background:#2563eb"></span>Proyectada</span>
                <span class="chart-legend-item"><span class="swatch-dash"></span>Real (banco)</span>
                <span class="chart-legend-item"><span class="swatch-box" style="background:#fee2e2; border:1px solid #fecaca"></span>Caja negativa</span>
              </div>
            </div>
            ${monthsShown.length ? PFCharts.svgCajaAcumulada(labels, projArr, realArr, years) : '<div class="text-muted">Ningún mes en los años elegidos.</div>'}
          </div>

          <div class="panel mb-0">
            <div class="panel-header-row">
              <div>
                <h3>Flujo neto por trimestre</h3>
                <p class="panel-hint">Agregado a trimestre: ${t.months.length} barras mensuales no se leen. Bajo la línea: aportes netos.</p>
              </div>
              <div class="chart-legend">
                <span class="chart-legend-item"><span class="swatch-sq" style="background:#16a34a"></span>Devoluciones</span>
                <span class="chart-legend-item"><span class="swatch-sq" style="background:#dc2626"></span>Aportes</span>
              </div>
            </div>
            ${qBuckets.length ? PFCharts.svgFlujoNeto(qLabels, qNet, qYears) : '<div class="text-muted">Ningún trimestre en los años elegidos.</div>'}
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
    el.querySelectorAll('.dash-year-chip').forEach((btn) => btn.addEventListener('click', () => {
      const y = btn.dataset.year;
      if (!y) { dashYearFilter = new Set(); } else if (dashYearFilter.has(y)) { dashYearFilter.delete(y); } else { dashYearFilter.add(y); }
      renderDashboard();
    }));
    wireChartHoverTips(el);
  }

  // ------------------------------------------------------- Vista: Por categoría
  function renderCategoriasView() {
    const el = document.getElementById('categorias-view');
    if (!state.proyectos.length) { el.innerHTML = emptyState('Sin datos', 'Importa proyectos para ver el desglose por categoría.'); return; }

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
  const OPEN_CATS_ESTADO_KEY = 'pf.flujo.openCatsEstado';
  const FLUJO_AGRUPACION_KEY = 'pf.flujo.agrupacion';
  // 'categoria' (las 5 categorías de siempre) o 'estado' (En evaluación / En ejecución /
  // Terminado / Sin estado) — mismo grid, misma edición, solo cambia el criterio de agrupación.
  let flujoAgrupacion = (function () {
    try { return localStorage.getItem(FLUJO_AGRUPACION_KEY) || 'categoria'; } catch (e) { return 'categoria'; }
  })();
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

  // Fuera de las filas de proyecto: no se editan (son sumas calculadas, no datos propios).
  let flujoEditMode = false;
  // Celda a reenfocar después de un re-render disparado por una edición (renderFlujoMensual()
  // reconstruye toda la tabla, así que el foco se perdería si no se restaura a mano) — {projId,
  // mes} o null.
  let flujoFocusTarget = null;
  // Mientras se edita, los cambios NO se mandan a Firestore de inmediato: se acumulan en memoria
  // (ya aplicados a state.proyectos, para que el resto de la vista —totales, acumulado— se vea
  // actualizado en vivo) y solo se persisten al presionar "Guardar cambios". flujoEditSnapshot
  // guarda el valor original de cada proyecto tocado para poder revertir con "Cancelar" o
  // "Deshacer". flujoUndo/flujoRedo son pilas de {projId, mes, oldVal, newVal} para Ctrl+Z/Ctrl+Y.
  // flujoDirty son los IDs de proyecto con al menos un cambio pendiente de guardar.
  let flujoEditSnapshot = null;
  let flujoUndo = [];
  let flujoRedo = [];
  let flujoDirty = new Set();

  function flujoApplyEdit(projId, mes, val, { history = true } = {}) {
    const p = state.proyectos.find((x) => x.id === projId);
    if (!p) return;
    const oldVal = (p.proyeccion || {})[mes] || 0;
    if (oldVal === val) return;
    p.proyeccion = Object.assign({}, p.proyeccion, { [mes]: val });
    flujoDirty.add(projId);
    if (history) {
      flujoUndo.push({ projId, mes, oldVal, newVal: val });
      flujoRedo = [];
    }
  }
  function flujoUndoEdit() {
    const a = flujoUndo.pop();
    if (!a) return;
    flujoApplyEdit(a.projId, a.mes, a.oldVal, { history: false });
    flujoRedo.push(a);
    flujoFocusTarget = { projId: a.projId, mes: a.mes };
    renderFlujoMensual();
  }
  function flujoRedoEdit() {
    const a = flujoRedo.pop();
    if (!a) return;
    flujoApplyEdit(a.projId, a.mes, a.newVal, { history: false });
    flujoUndo.push(a);
    flujoFocusTarget = { projId: a.projId, mes: a.mes };
    renderFlujoMensual();
  }
  function flujoProjCell(v, projId, mes) {
    if (!flujoEditMode) return flujoCell(v);
    const orig = flujoEditSnapshot && flujoEditSnapshot.has(projId) ? (flujoEditSnapshot.get(projId)[mes] || 0) : v;
    const dirty = orig !== v;
    return `<td class="num p-1"><input type="number" step="any" class="form-control form-control-sm num flujo-edit-input${dirty ? ' dirty' : ''}" data-proj-id="${projId}" data-mes="${mes}" value="${v}"></td>`;
  }
  // Fila de un proyecto normal dentro de Flujo de Caja mensual — indent mayor (28px) cuando está
  // anidado bajo la fila de un grupo (ver flujoGrupoRow), para que se note visualmente que es un
  // sub-proyecto de ese grupo y no otro proyecto suelto de la categoría.
  function flujoProyectoRow(p, months, indent) {
    const projArr = months.map((m) => (p.proyeccion || {})[m] || 0);
    return `<tr class="proj-row">
      <td class="proj-col"><span class="row-label" style="padding-left:${indent || 14}px"><i class="bi bi-dot"></i><span>${PF.esc(p.nombre)}</span></span></td>
      ${months.map((m, i) => flujoProjCell(projArr[i], p.id, m)).join('')}
      <td class="trend-col">${PFCharts.sparkline(projArr)}</td>
    </tr>`;
  }
  // Fila de un grupo (proyecto.grupoPadre) dentro de Flujo de Caja mensual: muestra el flujo
  // neteado mes a mes de sus proyectos hijos (mergeProyeccion, la misma función que usa "Por
  // proyecto") y se puede expandir/contraer para ver cada hijo como fila normal debajo — el
  // estado abierto/cerrado se guarda en la misma key que "Por proyecto" (OPEN_PROJ_GRUPOS_KEY),
  // para que expandir un grupo en una vista lo deje expandido en la otra también.
  function flujoGrupoRow(nombre, children, months, isOpen) {
    const merged = mergeProyeccion(children);
    const arr = months.map((m) => merged[m] || 0);
    return `<tr class="proj-row" data-grupo-flujo="${PF.esc(nombre)}" role="button" tabindex="0" style="cursor:pointer">
      <td class="proj-col"><span class="row-label" style="padding-left:14px"><i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}"></i><span>${PF.esc(nombre)}</span></span></td>
      ${months.map((m, i) => flujoCell(arr[i])).join('')}
      <td class="trend-col">${PFCharts.sparkline(arr)}</td>
    </tr>`;
  }
  // Arma las filas de proyecto de una categoría (dentro de Flujo de Caja mensual), agrupando los
  // que compartan grupoPadre en una sola fila expandible en vez de listarlos sueltos — mismo
  // criterio que proyectosGridHtml en "Por proyecto".
  function flujoProyectoRowsHtml(proys, months) {
    const openGrupos = loadOpenMap(OPEN_PROJ_GRUPOS_KEY);
    const seen = new Set();
    let out = '';
    proys.forEach((p) => {
      if (!p.grupoPadre) { out += flujoProyectoRow(p, months); return; }
      if (seen.has(p.grupoPadre)) return;
      seen.add(p.grupoPadre);
      const children = proys.filter((x) => x.grupoPadre === p.grupoPadre);
      const isOpen = openGrupos[p.grupoPadre] === true;
      out += flujoGrupoRow(p.grupoPadre, children, months, isOpen);
      if (isOpen) children.forEach((c) => { out += flujoProyectoRow(c, months, 28); });
    });
    return out;
  }

  function renderFlujoMensual() {
    const el = document.getElementById('flujo-mensual');
    if (!state.proyectos.length) { el.innerHTML = emptyState('Sin datos', 'Importa proyectos para ver el flujo de caja mensual.'); return; }

    const t = buildTimeline();
    const months = t.months;
    const labels = months.map(PF.monthLabel);
    const umbral = Number(state.config.umbralAlerta) || 0;
    const mesesBajoUmbral = months.filter((m) => t.proj[m] < umbral).length;
    const groupByEstado = flujoAgrupacion === 'estado';
    const openCatsKey = groupByEstado ? OPEN_CATS_ESTADO_KEY : OPEN_CATS_KEY;
    const openCats = loadOpenMap(openCatsKey);
    // Grupos a recorrer: las 5 categorías de siempre, o Evaluación/Ejecución/Terminado/Sin
    // estado — mismo id que usa el badge de "Por proyecto" (ver ESTADOS_PROYECTO), más 'sin'
    // para los que no tienen estado definido.
    const grupos = groupByEstado
      ? [...ESTADOS_PROYECTO, { id: 'sin', nombre: 'Sin estado' }]
      : state.categorias;
    const proysDeGrupo = (g) => groupByEstado
      ? state.proyectos.filter((p) => (p.estado || 'sin') === g.id)
      : state.proyectos.filter((p) => p.categoriaId === g.id);

    // ---- Filas de la tabla.
    let rows = '';
    let catIdx = 0;
    grupos.forEach((cat) => {
      const proys = proysDeGrupo(cat);
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
      if (isOpen) rows += flujoProyectoRowsHtml(proys, months);
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
          ${isAdmin() ? (flujoEditMode ? `
            <button class="flujo-btn" id="flujo-undo" ${flujoUndo.length ? '' : 'disabled'} title="Deshacer (Ctrl+Z)"><i class="bi bi-arrow-counterclockwise"></i> Deshacer</button>
            <button class="flujo-btn" id="flujo-redo" ${flujoRedo.length ? '' : 'disabled'} title="Rehacer (Ctrl+Y)"><i class="bi bi-arrow-clockwise"></i> Rehacer</button>
            <button class="flujo-btn" id="flujo-cancel"><i class="bi bi-x-lg"></i> Cancelar</button>
            <button class="flujo-btn active" id="flujo-save" ${flujoDirty.size ? '' : 'disabled'}><i class="bi bi-check-lg"></i> Guardar cambios${flujoDirty.size ? ` (${flujoDirty.size})` : ''}</button>
          ` : `<button class="flujo-btn" id="flujo-edit-toggle"><i class="bi bi-pencil-square"></i> Editar flujo</button>`) : ''}
          <button class="flujo-btn" id="flujo-excel"><i class="bi bi-file-earmark-excel" style="color:#15803d"></i> Exportar Excel</button>
          <button class="flujo-btn" id="flujo-pdf"><i class="bi bi-filetype-pdf" style="color:#b91c1c"></i> PDF directorio</button>
        </div>
      </div>
      ${flujoEditMode ? '<div class="alert alert-primary py-2 px-3 mb-3 small"><i class="bi bi-info-circle me-1"></i>Modo edición: escribe un valor y usa las flechas o Enter para moverte, como en Excel. Los cambios quedan pendientes hasta que presiones "Guardar cambios".</div>' : ''}
      <div class="panel mb-0">
        <div class="panel-header-row" style="flex-wrap:wrap; gap:12px">
          <div>
            <h3>Flujo de caja mensual por proyecto</h3>
            <p class="panel-hint">Haz clic en un grupo para expandir sus proyectos. Rojo = aporte, verde = devolución.</p>
          </div>
          <div class="dir-tabs" role="tablist" style="margin-left:auto">
            <button type="button" class="dir-tab ${!groupByEstado ? 'active' : ''}" role="tab" aria-selected="${!groupByEstado}" data-flujo-agrup="categoria">Categoría</button>
            <button type="button" class="dir-tab ${groupByEstado ? 'active' : ''}" role="tab" aria-selected="${groupByEstado}" data-flujo-agrup="estado">Estado</button>
          </div>
        </div>
        <div class="flujo-table-wrap flujo-scroll">
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

    if (flujoFocusTarget) {
      const t = flujoFocusTarget;
      flujoFocusTarget = null;
      const inp = el.querySelector(`.flujo-edit-input[data-proj-id="${CSS.escape(t.projId)}"][data-mes="${CSS.escape(t.mes)}"]`);
      if (inp) { inp.focus(); inp.select(); }
    }

    el.querySelectorAll('[data-flujo-agrup]').forEach((btn) => btn.addEventListener('click', () => {
      flujoAgrupacion = btn.dataset.flujoAgrup;
      try { localStorage.setItem(FLUJO_AGRUPACION_KEY, flujoAgrupacion); } catch (e2) { /* localStorage puede no estar disponible */ }
      renderFlujoMensual();
    }));

    el.querySelectorAll('.cat-row').forEach((row) => {
      const toggle = () => {
        const id = row.dataset.catId;
        const wasOpen = row.dataset.isOpen === 'true';
        const cur = loadOpenMap(openCatsKey);
        cur[id] = !wasOpen;
        saveOpenMap(openCatsKey, cur);
        renderFlujoMensual();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    el.querySelectorAll('[data-grupo-flujo]').forEach((row) => {
      const toggle = () => {
        const nombre = row.dataset.grupoFlujo;
        const cur = loadOpenMap(OPEN_PROJ_GRUPOS_KEY);
        cur[nombre] = !(cur[nombre] === true);
        saveOpenMap(OPEN_PROJ_GRUPOS_KEY, cur);
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

    if (isAdmin()) {
      if (!flujoEditMode) {
        el.querySelector('#flujo-edit-toggle').addEventListener('click', () => {
          flujoEditMode = true;
          flujoFocusTarget = null;
          flujoUndo = []; flujoRedo = []; flujoDirty = new Set();
          flujoEditSnapshot = new Map(state.proyectos.map((p) => [p.id, Object.assign({}, p.proyeccion)]));
          renderFlujoMensual();
        });
      } else {
        el.querySelector('#flujo-undo').addEventListener('click', flujoUndoEdit);
        el.querySelector('#flujo-redo').addEventListener('click', flujoRedoEdit);
        el.querySelector('#flujo-cancel').addEventListener('click', () => {
          if (flujoDirty.size && !confirm('¿Descartar los cambios sin guardar?')) return;
          if (flujoEditSnapshot) {
            state.proyectos.forEach((p) => { if (flujoEditSnapshot.has(p.id)) p.proyeccion = flujoEditSnapshot.get(p.id); });
          }
          flujoEditMode = false; flujoEditSnapshot = null; flujoUndo = []; flujoRedo = []; flujoDirty = new Set(); flujoFocusTarget = null;
          renderFlujoMensual();
        });
        busyOnClick(el.querySelector('#flujo-save'), 'Guardando...', async () => {
          if (!flujoDirty.size) return;
          const ids = Array.from(flujoDirty);
          // En paralelo: mismo criterio que el borrado masivo, no hay razón para esperar una
          // escritura antes de lanzar la siguiente.
          await Promise.all(ids.map(async (id) => {
            const p = state.proyectos.find((x) => x.id === id);
            if (!p) return;
            const updated = await DB.updateProyecto(id, { proyeccion: p.proyeccion });
            if (updated) Object.assign(p, updated);
          }));
          flujoEditMode = false; flujoEditSnapshot = null; flujoUndo = []; flujoRedo = []; flujoDirty = new Set(); flujoFocusTarget = null;
          toast('Cambios guardados', 'success');
          renderFlujoMensual();
        });
      }
      // Navegación tipo Excel entre celdas editables: flechas mueven el foco (y de paso
      // confirman el valor de la celda que se abandona, porque enfocar otro input dispara el
      // blur/'change' del anterior); Enter se comporta como flecha abajo. Al llegar al borde de
      // una fila de proyecto sigue buscando en las filas de arriba/abajo saltándose las de
      // categoría/total/acumulado/caja real, que no tienen input. Ctrl+Z/Ctrl+Y deshacen/rehacen
      // el historial de ediciones en vez del undo nativo del input (que se anula con
      // preventDefault) — el guardado real a Firestore solo ocurre al presionar "Guardar cambios".
      function findEditInput(row, colIndex) {
        const cell = row && row.children[colIndex];
        return cell && cell.querySelector ? cell.querySelector('.flujo-edit-input') : null;
      }
      function focusInput(target) {
        if (!target) return;
        flujoFocusTarget = { projId: target.dataset.projId, mes: target.dataset.mes };
        target.focus();
        target.select();
      }
      el.querySelectorAll('.flujo-edit-input').forEach((inp) => {
        inp.addEventListener('keydown', (e) => {
          const key = e.key.toLowerCase();
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') { e.preventDefault(); flujoUndoEdit(); return; }
          if ((e.ctrlKey || e.metaKey) && (key === 'y' || (e.shiftKey && key === 'z'))) { e.preventDefault(); flujoRedoEdit(); return; }
          const td = inp.closest('td');
          const tr = td.parentElement;
          const colIndex = Array.prototype.indexOf.call(tr.children, td);
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            let r = tr.previousElementSibling;
            while (r) { const t2 = findEditInput(r, colIndex); if (t2) { focusInput(t2); break; } r = r.previousElementSibling; }
          } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            let r = tr.nextElementSibling;
            while (r) { const t2 = findEditInput(r, colIndex); if (t2) { focusInput(t2); break; } r = r.nextElementSibling; }
          } else if (e.key === 'ArrowLeft' && inp.selectionStart === 0 && inp.selectionEnd === 0) {
            e.preventDefault();
            focusInput(findEditInput(tr, colIndex - 1));
          } else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length && inp.selectionEnd === inp.value.length) {
            e.preventDefault();
            focusInput(findEditInput(tr, colIndex + 1));
          }
        });
        inp.addEventListener('change', () => {
          const val = Number(inp.value) || 0;
          flujoApplyEdit(inp.dataset.projId, inp.dataset.mes, val);
          renderFlujoMensual();
        });
      });
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
  const OPEN_DIR_CATS_KEY = 'pf.resumen.openDirCats';
  const OPEN_DIR_DELTA_KEY = 'pf.resumen.openDirDelta';
  // Versión guardada activa para comparar en "Flujo de caja por categoría" (null = sin comparar).
  let resumenCompareSnapshot = null;
  // Listado de versiones guardadas para el selector; null = todavía no se cargó.
  let resumenSnapshotsCache = null;
  const CAT_FINANCIAMIENTO = 'Financiamiento, Dividendo e Impuestos';
  const OBRA_CHART_ANIO_DESDE = 2026;
  const OBRA_CHART_ANIO_HASTA = 2028;

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

  // Año de construcción "efectivo" de un proyecto: el que el usuario haya escrito a mano en Flujo
  // de Caja (proyecto.anioConstruccion) si existe, o si no el inferido desde el flujo de caja (ver
  // inferirGrupoObra) como valor por defecto para mostrar en el input antes de que alguien lo edite.
  function anioConstruccionEfectivo(p) {
    if (p.anioConstruccion) return Number(p.anioConstruccion);
    const m = /^Obras (\d{4})$/.exec(p.grupoObra || inferirGrupoObra(p));
    return m ? Number(m[1]) : new Date().getFullYear();
  }

  // "Grupo de obra" (año de inicio) usado para agrupar en Resumen Directorio: manda
  // proyecto.anioConstruccion si el usuario lo definió a mano en Flujo de Caja — es la fuente de
  // verdad más confiable que existe, porque no depende de adivinar el flujo de caja. Si no está
  // definido, cae al grupoObra ya clasificado/corregido por drag-and-drop, o a la heurística.
  function grupoObraDe(p) {
    if (p.anioConstruccion) return 'Obras ' + Number(p.anioConstruccion);
    return p.grupoObra || 'Sin clasificar';
  }

  // Clasifica (una sola vez, perezoso) y persiste grupoObra en los proyectos que no tengan ni
  // grupoObra ni anioConstruccion todavía, para que el drag-and-drop del usuario nunca se pise con
  // un recálculo automático.
  async function ensureGruposObra() {
    // Clasificación automática = escritura; un lector no tiene permiso en Firestore para
    // esto (las reglas lo rechazarían), así que ni se intenta — el admin la completa cuando entre.
    if (!isAdmin()) return false;
    const finCat = state.categorias.find((c) => c.nombre === CAT_FINANCIAMIENTO);
    const pendientes = state.proyectos.filter((p) => !p.grupoObra && !p.anioConstruccion && (!finCat || p.categoriaId !== finCat.id));
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
    if (!state.proyectos.length) { el.innerHTML = emptyState('Sin datos', 'Importa proyectos para ver el resumen para directorio.'); return; }

    ensureGruposObra().then((changed) => { if (changed) renderResumenDirectorio(); });
    if (resumenSnapshotsCache === null) {
      resumenSnapshotsCache = [];
      DB.listSnapshots().then((list) => { resumenSnapshotsCache = list; renderResumenDirectorio(); });
    }

    const months = allMonths();
    const buckets = periodBuckets(months, resumenGranularidad);
    const catsConProyectos = state.categorias.filter((cat) => state.proyectos.some((p) => p.categoriaId === cat.id));

    const filas = catsConProyectos.map((cat) => {
      const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
      return {
        id: cat.id,
        nombre: cat.nombre,
        actual: buckets.map((b) => sumField(proys, b.months, 'proyeccion')),
        ppto: buckets.map((b) => sumField(proys, b.months, 'presupuesto')),
      };
    });

    const totalActual = buckets.map((_, i) => filas.reduce((a, f) => a + f.actual[i], 0));
    const totalPpto = buckets.map((_, i) => filas.reduce((a, f) => a + f.ppto[i], 0));
    const acumActual = []; let accA = 0; totalActual.forEach((v) => { accA += v; acumActual.push(accA); });
    const acumPpto = []; let accP = 0; totalPpto.forEach((v) => { accP += v; acumPpto.push(accP); });

    const periodBorder = 'border-left:2px solid var(--pf-border)';

    // ---- Tabla por categoría (rediseñada): 1 columna por período sin presupuesto, 2 con
    // presupuesto (Actual, Δ) — nunca 3, y nunca "0 UF" (se muestra "—").
    const hasPresupuesto = totalPpto.some((v) => v !== 0);

    // ---- Comparación con una versión guardada (opcional): afecta SOLO la tabla "Flujo de
    // caja por categoría" de abajo. Con un snapshot activo, esa tabla muestra los valores de
    // esa versión como "Actual" y la Δ pasa a ser el cambio desde esa versión hasta hoy — el
    // resto del panel (KPIs, gráfico, veredicto) sigue mostrando los datos actuales en vivo.
    const catCompare = resumenCompareSnapshot;
    let catFilas = filas;
    if (catCompare) {
      const snapProys = catCompare.proyectos || [];
      catFilas = catsConProyectos.map((cat) => {
        const proysHoy = state.proyectos.filter((p) => p.categoriaId === cat.id);
        const proysViejo = snapProys.filter((p) => p.categoriaId === cat.id);
        return {
          id: cat.id,
          nombre: cat.nombre,
          actual: buckets.map((b) => sumField(proysViejo, b.months, 'proyeccion')),
          ppto: buckets.map((b) => sumField(proysHoy, b.months, 'proyeccion')),
        };
      });
    }
    // Detalle por proyecto dentro de cada categoría, para el desglose expandible de abajo —
    // mismo criterio que catFilas: actual = versión comparada (o la de hoy si no hay
    // comparación), ppto = base de la Δ (hoy si se compara, presupuesto si no).
    const catProyectosDetalle = {};
    catsConProyectos.forEach((cat) => {
      const proysHoy = state.proyectos.filter((p) => p.categoriaId === cat.id);
      const proysViejo = catCompare ? (catCompare.proyectos || []).filter((p) => p.categoriaId === cat.id) : null;
      catProyectosDetalle[cat.id] = proysHoy.map((p) => {
        const pViejo = catCompare ? (proysViejo.find((v) => v.id === p.id) || { proyeccion: {} }) : null;
        return {
          nombre: p.nombre,
          actual: buckets.map((b) => sumField([catCompare ? pViejo : p], b.months, 'proyeccion')),
          ppto: buckets.map((b) => sumField([p], b.months, catCompare ? 'proyeccion' : 'presupuesto')),
        };
      });
    });
    const catTotalActual = buckets.map((_, i) => catFilas.reduce((a, f) => a + f.actual[i], 0));
    const catTotalPpto = buckets.map((_, i) => catFilas.reduce((a, f) => a + f.ppto[i], 0));
    const catAcumActual = []; let accCA = 0; catTotalActual.forEach((v) => { accCA += v; catAcumActual.push(accCA); });
    const catAcumPpto = []; let accCP = 0; catTotalPpto.forEach((v) => { accCP += v; catAcumPpto.push(accCP); });
    const catHasDelta = catCompare ? true : hasPresupuesto;
    // Sin comparar: Δ = actual − presupuesto. Comparando: Δ = hoy − versión guardada (así se
    // ve como positivo lo que "creció" desde esa versión, sin importar que el valor mostrado
    // como Actual sea el de esa versión antigua, no el de hoy).
    const catDeltaOf = catCompare
      ? (f) => f.ppto.map((p, i) => p - f.actual[i])
      : (f) => f.actual.map((a, i) => a - f.ppto[i]);

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
    const dirGroupGap = 'border-left:1px solid var(--pf-border); padding-left:20px';
    function dirActualTd(a, cls, bs) {
      const txt = a === 0 ? '—' : PF.fmtNum(a);
      return `<td class="num" style="text-align:center; ${bs}"><span class="${cls}">${txt}</span></td>`;
    }
    function dirDeltaTd(d, bs) {
      const dTxt = d === 0 ? '—' : (d > 0 ? '+' : '') + PF.fmtNum(d);
      const dCls = d > 0 ? 'pos' : (d < 0 ? 'neg' : 'num-zero');
      return `<td class="num" style="text-align:center; ${bs}"><span class="${dCls}">${dTxt}</span></td>`;
    }
    // `bucketList` es opcional (default `buckets`, la granularidad elegida arriba) — lo usan
    // también la tabla de Obras y la de Actual/Ppto/Desviación, que siempre trabajan en anual
    // (`obraAnualBuckets`), para compartir el mismo look de 2 columnas (Actual, Δ) centradas.
    // `mode`: 'both' (default, cols de años seguidas de cols de Δ en la misma tabla),
    // 'actual' (solo años — para la tabla separada de valores) o 'delta' (solo Δ — para la
    // tabla separada de variaciones, sin el hueco/borde extra que separaba los 2 bloques
    // cuando iban juntos).
    function dirNumCells(actualArr, deltaArr, isAcum, bucketList, mode) {
      mode = mode || 'both';
      bucketList = bucketList || buckets;
      const maxAcum = Math.max(...actualArr.map((v) => Math.abs(v)), 1);
      const actualsHtml = mode === 'delta' ? '' : bucketList.map((b, i) => {
        const a = actualArr[i];
        const bs = i > 0 ? periodBorder : '';
        if (isAcum) {
          const semClass = a < 0 ? 'sem-bajo' : (a > maxAcum * 0.25 ? 'sem-ok' : '');
          return dirActualTd(a, semClass, `${bs}${semClass ? '' : 'background:#f8fafc'}`);
        }
        const cls = a < 0 ? 'neg' : (a > 0 ? 'pos' : 'num-zero');
        return dirActualTd(a, cls, bs);
      }).join('');
      const deltasHtml = (mode === 'actual' || !deltaArr) ? '' : bucketList.map((b, i) => {
        const bs = mode === 'delta' ? (i > 0 ? periodBorder : '') : (i === 0 ? dirGroupGap : periodBorder);
        return dirDeltaTd(deltaArr[i], bs);
      }).join('');
      return actualsHtml + deltasHtml;
    }
    // opts.catId: fila de categoría (tabla "por categoría"), toggle propio vía OPEN_DIR_CATS_KEY.
    // opts.grupo: fila de grupo de obra (tabla "Flujo de Obras"), mismo markup/toggle/drag&drop
    // que ya tenía esa tabla (clase `.cat-row[data-grupo]`, wireada más abajo) — no se reemplaza
    // por el mecanismo de opts.catId porque son 2 estados de apertura y 2 comportamientos
    // distintos (esta además acepta soltar una fila de proyecto arrastrada encima).
    function dirRowHtml(nombre, icon, actualArr, deltaArr, opts) {
      opts = opts || {};
      const rowBg = opts.rowBg || '#fff';
      const isCat = !!opts.catId;
      const isGrupo = !!opts.grupo;
      const isOpen = isCat
        ? (Object.prototype.hasOwnProperty.call(openDirCats, opts.catId) ? openDirCats[opts.catId] : false)
        : !!opts.grupoOpen;
      const labelHtml = (isCat || isGrupo)
        ? `<span class="row-label"><i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}"></i>${isGrupo ? '' : `<i class="bi ${icon}"></i>`}<span>${PF.esc(nombre)}</span></span>`
        : `<span class="row-label"><i class="bi ${icon}"></i><span>${PF.esc(nombre)}</span></span>`;
      const rowAttrs = isCat
        ? `class="dir-cat-row" data-catid="${PF.esc(opts.catId)}" role="button" tabindex="0"`
        : (isGrupo ? `class="cat-row" data-grupo="${PF.esc(opts.grupo)}" data-is-open="${isOpen}" role="button" tabindex="0"` : '');
      const mode = opts.mode || 'both';
      return `<tr style="background:${rowBg}" ${rowAttrs}>
        <td class="proj-col" style="background:${rowBg}; font-weight:${opts.weight || 500}; color:${opts.labelColor || 'var(--pf-slate-700)'}">
          ${labelHtml}
        </td>
        ${dirNumCells(actualArr, deltaArr, !!opts.isAcum, opts.buckets, mode)}
        <td class="trend-col">${mode === 'delta' ? '' : PFCharts.sparkline(actualArr)}</td>
      </tr>`;
    }
    // opts.projId: fila de proyecto dentro de un grupo de obra — arrastrable para reclasificar
    // (mismo comportamiento que tenía antes esa tabla). Sin projId: detalle dentro de una
    // categoría (tabla "por categoría"), solo lectura. opts.mode: ver dirNumCells.
    function dirProjRowHtml(nombre, actualArr, deltaArr, bucketList, opts) {
      opts = opts || {};
      const mode = opts.mode || 'both';
      const trendTd = `<td class="trend-col">${mode === 'delta' ? '' : PFCharts.sparkline(actualArr)}</td>`;
      if (opts.projId) {
        return `<tr class="proj-row" ${isAdmin() ? 'draggable="true"' : ''} data-proj-id="${opts.projId}">
          <td class="proj-col"><span class="row-label" style="padding-left:14px; ${isAdmin() ? 'cursor:grab' : ''}"><i class="bi bi-dot"></i><span>${PF.esc(nombre)}</span></span></td>
          ${dirNumCells(actualArr, deltaArr, false, bucketList, mode)}
          ${trendTd}
        </tr>`;
      }
      return `<tr class="dir-proj-row">
        <td class="proj-col" style="padding-left:34px; font-weight:400; color:var(--pf-slate-500)">
          <span class="row-label"><i class="bi bi-dot"></i><span>${PF.esc(nombre)}</span></span>
        </td>
        ${dirNumCells(actualArr, deltaArr, false, bucketList, mode)}
        ${trendTd}
      </tr>`;
    }
    // mode: 'both' (año + Δ juntas), 'actual' (solo columnas de año) o 'delta' (solo columnas Δ,
    // sin el hueco extra que las separaba cuando iban en la misma tabla que los años). La
    // columna de tendencia se mantiene (vacía) en modo 'delta' para que las 2 tablas midan
    // exactamente lo mismo por columna y queden alineadas una debajo de la otra.
    function dirHeadRow(bucketList, labelCol, mode) {
      mode = mode || 'both';
      const yearsTh = mode === 'delta' ? '' : bucketList.map((b, i) => `<th class="num" style="min-width:${dirColW}; text-align:center; ${i > 0 ? periodBorder : ''}">${PF.esc(b.label)}</th>`).join('');
      const deltaTh = mode === 'actual' ? '' : bucketList.map((b, i) => `<th class="num small text-muted" style="text-align:center; ${mode === 'delta' ? (i > 0 ? periodBorder : '') : (i === 0 ? dirGroupGap : periodBorder)}">Δ ${PF.esc(b.label)}</th>`).join('');
      const trendTh = '<th class="trend-col">' + (mode === 'delta' ? '' : 'Tendencia') + '</th>';
      return `<tr><th class="proj-col">${labelCol}</th>${yearsTh}${deltaTh}${trendTh}</tr>`;
    }
    const openDirDelta = loadOpenMap(OPEN_DIR_DELTA_KEY);
    // Arma el bloque de 2 tablas separadas — "Valores actuales" y "Variación (Δ)" — a pedido: el
    // grupo/proyecto siempre a la izquierda, los años en su propia tabla y las variaciones en la
    // suya, en vez de columnas Actual/Δ intercaladas en una sola tabla. Si no hay Δ que mostrar
    // (sin presupuesto ni versión comparada), el botón ni se dibuja. La de variaciones arranca
    // escondida (colapsada) — se abre con el botón, y queda igual de ancha/alineada que la de
    // arriba porque ambas comparten `wrapClass` y las mismas columnas (incluida "Tendencia",
    // vacía en la de variaciones, solo para que el ancho de columnas calce entre las 2 tablas).
    function dirTablePairHtml(opts) {
      const wrapClass = `flujo-table-wrap table-sticky-col flujo-scroll${opts.wrapClass ? ' ' + opts.wrapClass : ''}`;
      const actualTable = `<div class="${wrapClass}" style="margin-top:14px">
        <table class="flujo-table">
          <thead>${opts.headActual}</thead>
          <tbody>${opts.bodyActual}</tbody>
        </table>
      </div>`;
      if (!opts.showDelta) return actualTable;
      const isOpen = !!openDirDelta[opts.sectionKey];
      const toggleBtn = `<button type="button" class="dir-delta-toggle" data-delta-toggle="${PF.esc(opts.sectionKey)}">
        <i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}"></i>
        <i class="bi bi-arrow-left-right"></i> Variación (Δ)
      </button>`;
      const deltaTable = isOpen ? `<div class="${wrapClass}">
        <table class="flujo-table">
          <thead>${opts.headDelta}</thead>
          <tbody>${opts.bodyDelta}</tbody>
        </table>
      </div>` : '';
      return actualTable + `<div class="dir-delta-block">${toggleBtn}${deltaTable}</div>`;
    }
    const openDirCats = loadOpenMap(OPEN_DIR_CATS_KEY);
    // Genera las filas de la tabla "por categoría" en un modo dado ('actual' o 'delta') — 2
    // tablas separadas en vez de 1 con ambos bloques, a pedido: valores a la izquierda del todo
    // (grupo/proyecto), años en su propia tabla, variaciones en la suya.
    function buildDirCatRows(mode) {
      return catFilas.map((f) => {
        const catRow = dirRowHtml(f.nombre, 'bi-diagram-2', f.actual, catHasDelta ? catDeltaOf(f) : null, { catId: f.id, mode });
        const isOpen = Object.prototype.hasOwnProperty.call(openDirCats, f.id) ? openDirCats[f.id] : false;
        const detalleHtml = isOpen
          ? (catProyectosDetalle[f.id] || []).map((p) => dirProjRowHtml(p.nombre, p.actual, catHasDelta ? catDeltaOf(p) : null, buckets, { mode })).join('')
          : '';
        return catRow + detalleHtml;
      }).join('');
    }
    function dirTotalAcumRows(mode) {
      const totalRow = dirRowHtml('Flujo de caja del período', 'bi-arrow-left-right', catTotalActual, catHasDelta ? catDeltaOf({ actual: catTotalActual, ppto: catTotalPpto }) : null, { weight: 700, labelColor: 'var(--pf-slate-800)', rowBg: '#eff6ff', mode });
      const acumRow = dirRowHtml('Caja acumulada', 'bi-wallet2', catAcumActual, catHasDelta ? catDeltaOf({ actual: catAcumActual, ppto: catAcumPpto }) : null, { weight: 700, labelColor: 'var(--pf-slate-800)', isAcum: true, mode });
      return totalRow + acumRow;
    }
    const dirRowsHtml = buildDirCatRows('actual');
    const dirTotalAcumHtml = dirTotalAcumRows('actual');
    const dirHeadHtml = dirHeadRow(buckets, 'Categoría', 'actual');
    const dirDeltaRowsHtml = buildDirCatRows('delta');
    const dirDeltaTotalAcumHtml = dirTotalAcumRows('delta');
    const dirDeltaHeadHtml = dirHeadRow(buckets, 'Categoría', 'delta');
    const GRAN_OPTS = [['trimestral', 'Trimestral'], ['semestral', 'Semestral'], ['anual', 'Anual']];
    const dirTabsHtml = `<div class="dir-tabs" role="tablist">${GRAN_OPTS.map(([g, label]) =>
      `<button type="button" class="dir-tab ${g === resumenGranularidad ? 'active' : ''}" role="tab" aria-selected="${g === resumenGranularidad}" tabindex="${g === resumenGranularidad ? 0 : -1}" data-gran="${g}">${label}</button>`).join('')}</div>`;

    // ---- Versiones guardadas (snapshots): guardar el estado actual y/o comparar contra una
    // versión anterior en la tabla de categorías (ver bloque catCompare más arriba).
    const fmtSnapFecha = (ts) => new Date(ts).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
    const snapshotOptionsHtml = (resumenSnapshotsCache || [])
      .map((s) => `<option value="${PF.esc(s.id)}" ${catCompare && catCompare.id === s.id ? 'selected' : ''}>${PF.esc(s.nombre)} — ${fmtSnapFecha(s.fecha)}</option>`)
      .join('');
    const dirSnapshotBarHtml = `<div class="dir-snapshot-bar">
      ${isAdmin() ? '<button type="button" class="flujo-btn" id="resumen-snapshot-save"><i class="bi bi-camera"></i> Guardar versión actual</button>' : ''}
      <label class="dir-snapshot-select-wrap">
        <span class="small text-muted">Ver versión guardada</span>
        <select id="resumen-snapshot-select">
          <option value="">— Versión actual —</option>
          ${snapshotOptionsHtml}
        </select>
      </label>
      ${isAdmin() && catCompare ? '<button type="button" class="flujo-btn" id="resumen-snapshot-delete" title="Borrar esta versión"><i class="bi bi-trash text-danger"></i></button>' : ''}
    </div>`;
    const dirCompareBannerHtml = catCompare ? `<div class="dir-compare-banner">
      <i class="bi bi-clock-history"></i>
      <span>Mostrando la versión <b>${PF.esc(catCompare.nombre)}</b> del ${fmtSnapFecha(catCompare.fecha)}. La columna <b>Δ</b> es el cambio desde esa versión hasta hoy.</span>
      <button type="button" class="flujo-btn" id="resumen-snapshot-clear">Volver a la versión actual</button>
    </div>` : '';

    // ---- Flujo de Obras por año de inicio (todo excepto Financiamiento, Dividendo e Impuestos).
    const finCat = state.categorias.find((c) => c.nombre === CAT_FINANCIAMIENTO);
    const obraProyectos = state.proyectos.filter((p) => !finCat || p.categoriaId !== finCat.id);
    const grupos = Array.from(new Set(obraProyectos.map((p) => grupoObraDe(p)))).sort();
    const openGrupos = loadOpenMap(OPEN_GRUPOS_KEY);

    const filasObra = grupos.map((g) => {
      const proys = obraProyectos.filter((p) => grupoObraDe(p) === g);
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

    // Sección "Inversión en obras" (2 gráficos + tabla), siempre anual y acotada a
    // 2026-2028 sin importar la granularidad de la vista — es el rango y grano que pidió
    // el usuario para esta sección específica (viene del PPTX original del directorio).
    const obraAnualBuckets = periodBuckets(months, 'anual').filter((b) => {
      const anio = Number(b.months[0].slice(0, 4));
      return anio >= OBRA_CHART_ANIO_DESDE && anio <= OBRA_CHART_ANIO_HASTA;
    });
    const obraAnualLabels = obraAnualBuckets.map((b) => b.label);

    const obrasGruposEnRango = new Set();
    for (let y = OBRA_CHART_ANIO_DESDE; y <= OBRA_CHART_ANIO_HASTA; y++) obrasGruposEnRango.add('Obras ' + y);
    const obraNuevaProyectos = obraProyectos.filter((p) => obrasGruposEnRango.has(grupoObraDe(p)));
    const obraActivosProyectos = obraProyectos.filter((p) => !obrasGruposEnRango.has(grupoObraDe(p)));
    const finProyectos = finCat ? state.proyectos.filter((p) => p.categoriaId === finCat.id) : [];
    const bonoFProyectos = finProyectos.filter((p) => (p.tipo || '') === 'Bono F');
    const finCorpProyectos = finProyectos.filter((p) => (p.tipo || '') !== 'Bono F');

    // Los 2 gráficos de arriba muestran solo la línea "obras nuevas 2026-2028" (no el
    // consolidado de las 4 líneas), acumulada pura desde cero (sin Caja inicial) — así
    // reconcilian con el desglose de la tabla de abajo.
    const obraNuevaActualAnual = obraAnualBuckets.map((b) => sumField(obraNuevaProyectos, b.months, 'proyeccion'));
    const obraNuevaPptoAnual = obraAnualBuckets.map((b) => sumField(obraNuevaProyectos, b.months, 'presupuesto'));
    const obraNuevaAcumActual = []; let accONA = 0; obraNuevaActualAnual.forEach((v) => { accONA += v; obraNuevaAcumActual.push(accONA); });
    const obraNuevaAcumPpto = []; let accONP = 0; obraNuevaPptoAnual.forEach((v) => { accONP += v; obraNuevaAcumPpto.push(accONP); });

    // Tabla de abajo: 4 líneas (obras nuevas + activos + Financiero Corp + Bono F) + total +
    // acumulado; el acumulado sí parte de Configuración > Caja inicial (igual que Consolidado
    // y Flujo de Caja mensual), a diferencia del acumulado de los 2 gráficos de arriba.
    const lineasTablaObra = [
      { nombre: 'Flujo proyectos activos a diciembre 2025', proys: obraActivosProyectos },
      { nombre: `Flujo obras ${OBRA_CHART_ANIO_DESDE} a ${OBRA_CHART_ANIO_HASTA}`, proys: obraNuevaProyectos },
      { nombre: 'Flujo Financiero Corp', proys: finCorpProyectos },
      { nombre: 'Bono F (aportes y amortizaciones e intereses)', proys: bonoFProyectos },
    ].map((l) => ({
      nombre: l.nombre,
      actual: obraAnualBuckets.map((b) => sumField(l.proys, b.months, 'proyeccion')),
      ppto: obraAnualBuckets.map((b) => sumField(l.proys, b.months, 'presupuesto')),
    }));
    const tablaObraTotalActual = obraAnualBuckets.map((_, idx) => lineasTablaObra.reduce((a, l) => a + l.actual[idx], 0));
    const tablaObraTotalPpto = obraAnualBuckets.map((_, idx) => lineasTablaObra.reduce((a, l) => a + l.ppto[idx], 0));
    const cajaInicialCfg = Number(state.config.cajaInicial) || 0;
    const tablaObraAcumActual = []; let accTA = cajaInicialCfg; tablaObraTotalActual.forEach((v) => { accTA += v; tablaObraAcumActual.push(accTA); });
    const tablaObraAcumPpto = []; let accTP = cajaInicialCfg; tablaObraTotalPpto.forEach((v) => { accTP += v; tablaObraAcumPpto.push(accTP); });

    const obraDeltaOf = (actualArr, pptoArr) => actualArr.map((a, i) => a - pptoArr[i]);

    function buildTablaObraRows(mode) {
      const lineas = lineasTablaObra.map((l) =>
        dirRowHtml(l.nombre, 'bi-diagram-2', l.actual, obraDeltaOf(l.actual, l.ppto), { buckets: obraAnualBuckets, mode })).join('');
      const total = dirRowHtml('Flujo de caja', 'bi-arrow-left-right', tablaObraTotalActual, obraDeltaOf(tablaObraTotalActual, tablaObraTotalPpto),
        { buckets: obraAnualBuckets, weight: 700, labelColor: 'var(--pf-slate-800)', rowBg: '#eff6ff', mode });
      const acum = dirRowHtml('Flujo de caja acumulado', 'bi-wallet2', tablaObraAcumActual, obraDeltaOf(tablaObraAcumActual, tablaObraAcumPpto),
        { buckets: obraAnualBuckets, weight: 700, labelColor: 'var(--pf-slate-800)', isAcum: true, mode });
      return lineas + total + acum;
    }
    const tablaObraBodyActual = buildTablaObraRows('actual');
    const tablaObraHeadActual = dirHeadRow(obraAnualBuckets, 'Concepto', 'actual');
    const tablaObraBodyDelta = buildTablaObraRows('delta');
    const tablaObraHeadDelta = dirHeadRow(obraAnualBuckets, 'Concepto', 'delta');

    function buildObraRows(mode) {
      let idx = 0;
      return filasObra.map((f) => {
        const isOpen = Object.prototype.hasOwnProperty.call(openGrupos, f.grupo) ? openGrupos[f.grupo] : idx === 0;
        idx++;
        const grupoRow = dirRowHtml(f.grupo, 'bi-diagram-2', f.actual, obraDeltaOf(f.actual, f.ppto), { grupo: f.grupo, grupoOpen: isOpen, mode });
        const proyRows = isOpen ? f.proys.map((p) => {
          const pActual = buckets.map((b) => sumField([p], b.months, 'proyeccion'));
          const pPpto = buckets.map((b) => sumField([p], b.months, 'presupuesto'));
          return dirProjRowHtml(p.nombre, pActual, obraDeltaOf(pActual, pPpto), buckets, { projId: p.id, mode });
        }).join('') : '';
        return grupoRow + proyRows;
      }).join('');
    }
    function buildObraTotalAcum(mode) {
      const total = dirRowHtml('Flujo de caja (obra)', 'bi-arrow-left-right', totalActualObra, obraDeltaOf(totalActualObra, totalPptoObra), { weight: 700, labelColor: 'var(--pf-slate-800)', rowBg: '#eff6ff', mode });
      const acum = dirRowHtml('Flujo acumulado (obra)', 'bi-wallet2', acumActualObra, obraDeltaOf(acumActualObra, acumPptoObra), { weight: 700, labelColor: 'var(--pf-slate-800)', isAcum: true, mode });
      return total + acum;
    }
    const obraRowsHtml = buildObraRows('actual') + buildObraTotalAcum('actual');
    const obraHeadActual = dirHeadRow(buckets, 'Grupo / Proyecto', 'actual');
    const obraRowsDeltaHtml = buildObraRows('delta') + buildObraTotalAcum('delta');
    const obraHeadDelta = dirHeadRow(buckets, 'Grupo / Proyecto', 'delta');

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
            <span class="chart-legend-item"><span class="swatch-line" style="background:#2563eb"></span>Caja acumulada (actual)</span>
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
          <div style="display:flex; align-items:center; gap:12px; margin-left:auto; flex-wrap:wrap">
            ${dirSnapshotBarHtml}
            ${dirTabsHtml}
            <button class="flujo-btn" id="resumen-excel"><i class="bi bi-file-earmark-excel" style="color:#15803d"></i> Exportar Excel</button>
          </div>
        </div>
        ${dirCompareBannerHtml}
        ${!buckets.length ? '<div class="text-muted">No hay meses con datos.</div>' : dirTablePairHtml({
          headActual: dirHeadHtml, bodyActual: dirRowsHtml + dirTotalAcumHtml,
          headDelta: dirDeltaHeadHtml, bodyDelta: dirDeltaRowsHtml + dirDeltaTotalAcumHtml,
          showDelta: catHasDelta, sectionKey: 'categoria',
        })}
        <div class="dir-footer-note">
          <i class="bi bi-info-circle"></i>
          <span>Las columnas de <b>presupuesto y desviación</b> aparecen cuando se importa el PPTO por categoría.</span>
          <a href="#" data-goto="importar">Importar presupuesto →</a>
        </div>
      </div>
      <div class="panel">
        <h6>Flujo de Obras por año de inicio</h6>
        <p class="panel-hint">Todo excepto "${PF.esc(CAT_FINANCIAMIENTO)}". Valores en UF. El año se infiere del primer aporte
          relevante de cada proyecto — arrastra una fila a otro grupo si hace falta corregirlo.</p>
        ${!buckets.length ? '<div class="text-muted">No hay meses con datos.</div>' : dirTablePairHtml({
          headActual: obraHeadActual, bodyActual: obraRowsHtml,
          headDelta: obraHeadDelta, bodyDelta: obraRowsDeltaHtml,
          showDelta: true, wrapClass: 'obra-table', sectionKey: 'obras',
        })}
      </div>
      <div class="row g-3">
        <div class="col-lg-6"><div class="panel mb-0">
          <div class="panel-header-row">
            <div>
              <h3>Inversión en obras del período</h3>
              <p class="panel-hint">Egresos por año, en UF. Una sola escala.</p>
            </div>
            <div class="chart-legend">
              <span class="chart-legend-item"><span class="swatch-sq" style="background:#2563eb"></span>Actual</span>
              <span class="chart-legend-item"><span class="swatch-sq" style="background:#dbe3ee; border:1px solid #cbd5e1"></span>Presupuesto</span>
            </div>
          </div>
          ${obraAnualLabels.length ? '<div class="chart-box"><canvas id="chart-obra-periodo"></canvas></div>' : '<div class="text-muted">No hay períodos en ese rango de años.</div>'}
        </div></div>
        <div class="col-lg-6"><div class="panel mb-0">
          <div class="panel-header-row">
            <div>
              <h3>Inversión acumulada</h3>
              <p class="panel-hint">La brecha sombreada es la sobre-inversión vs. PPTO.</p>
            </div>
            <div class="chart-legend">
              <span class="chart-legend-item"><span class="swatch-line" style="background:#2563eb"></span>Actual</span>
              <span class="chart-legend-item"><span class="swatch-dash"></span>PPTO</span>
            </div>
          </div>
          ${obraAnualLabels.length ? '<div class="chart-box" style="position:relative"><canvas id="chart-obra-acum"></canvas></div>' : '<div class="text-muted">No hay períodos en ese rango de años.</div>'}
        </div></div>
      </div>
      <div class="panel">
        <div class="panel-header-row">
          <div>
            <h3>Actual, presupuesto y desviación por año</h3>
            <p class="panel-hint">Valores en UF. Δ = actual − presupuesto; verde favorece la caja.</p>
          </div>
          <button class="flujo-btn" id="resumen-obra-excel"><i class="bi bi-file-earmark-excel" style="color:#15803d"></i> Exportar Excel</button>
        </div>
        ${obraAnualLabels.length ? dirTablePairHtml({
          headActual: tablaObraHeadActual, bodyActual: tablaObraBodyActual,
          headDelta: tablaObraHeadDelta, bodyDelta: tablaObraBodyDelta,
          showDelta: true, sectionKey: 'obra-anual',
        }) : '<div class="text-muted">No hay períodos en ese rango de años.</div>'}
      </div>`;

    if (buckets.length) {
      const chart = PFCharts.lineCajaAcumulada('chart-resumen-acum', buckets.map((b) => b.label), acumActual, null, minIdx);
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
      if (obraAnualLabels.length) {
        PFCharts.barInversionPeriodo('chart-obra-periodo', obraAnualLabels, obraNuevaActualAnual.map(Math.abs), obraNuevaPptoAnual.map(Math.abs));
        // La brecha actual vs. ppto se muestra en el tooltip nativo del chart (al pasar el
        // mouse), no en una caja fija — ver lineInversionAcumulada en charts.js.
        PFCharts.lineInversionAcumulada('chart-obra-acum', obraAnualLabels, obraNuevaAcumActual.map(Math.abs), obraNuevaAcumPpto.map(Math.abs));
      }
    }

    el.querySelectorAll('[data-delta-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.deltaToggle;
        const cur = loadOpenMap(OPEN_DIR_DELTA_KEY);
        cur[key] = !openDirDelta[key];
        saveOpenMap(OPEN_DIR_DELTA_KEY, cur);
        renderResumenDirectorio();
      });
    });

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
        // grupoObraDe() prioriza anioConstruccion sobre grupoObra, así que la corrección manual
        // por drag-and-drop tiene que tocar ese mismo campo para que quede reflejada — si no, el
        // valor ya definido en Flujo de Caja seguiría ganando y el drop no se vería. Soltar en
        // "Sin clasificar" limpia anioConstruccion para que vuelva a mandar la heurística/grupoObra.
        const m = /^Obras (\d{4})$/.exec(row.dataset.grupo);
        await DB.updateProyecto(projId, { anioConstruccion: m ? Number(m[1]) : null, grupoObra: row.dataset.grupo });
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

    el.querySelectorAll('.dir-cat-row[data-catid]').forEach((row) => {
      const toggle = () => {
        const id = row.dataset.catid;
        const wasOpen = Object.prototype.hasOwnProperty.call(openDirCats, id) ? openDirCats[id] : false;
        const cur = loadOpenMap(OPEN_DIR_CATS_KEY);
        cur[id] = !wasOpen;
        saveOpenMap(OPEN_DIR_CATS_KEY, cur);
        renderResumenDirectorio();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });

    const snapshotSelectEl = el.querySelector('#resumen-snapshot-select');
    if (snapshotSelectEl) {
      snapshotSelectEl.addEventListener('change', async () => {
        const id = snapshotSelectEl.value;
        if (!id) { resumenCompareSnapshot = null; renderResumenDirectorio(); return; }
        snapshotSelectEl.disabled = true;
        resumenCompareSnapshot = await DB.getSnapshot(id);
        renderResumenDirectorio();
      });
    }
    const snapshotClearBtn = el.querySelector('#resumen-snapshot-clear');
    if (snapshotClearBtn) {
      snapshotClearBtn.addEventListener('click', () => { resumenCompareSnapshot = null; renderResumenDirectorio(); });
    }
    const snapshotDeleteBtn = el.querySelector('#resumen-snapshot-delete');
    if (snapshotDeleteBtn) {
      snapshotDeleteBtn.addEventListener('click', async () => {
        const s = resumenCompareSnapshot;
        if (!s) return;
        if (!confirm(`¿Borrar la versión "${s.nombre}"? No se puede deshacer.`)) return;
        snapshotDeleteBtn.disabled = true;
        await DB.deleteSnapshot(s.id);
        resumenCompareSnapshot = null;
        resumenSnapshotsCache = null;
        toast('Versión borrada', 'danger');
        renderResumenDirectorio();
      });
    }
    const snapshotSaveBtn = el.querySelector('#resumen-snapshot-save');
    if (snapshotSaveBtn) {
      snapshotSaveBtn.addEventListener('click', async () => {
        const nombre = prompt('Nombre para esta versión:', 'Directorio ' + fmtSnapFecha(Date.now()));
        if (!nombre) return;
        snapshotSaveBtn.disabled = true;
        try {
          await DB.addSnapshot(nombre, state.proyectos);
          resumenSnapshotsCache = null;
          renderResumenDirectorio();
        } finally {
          snapshotSaveBtn.disabled = false;
        }
      });
    }

    el.querySelector('#resumen-excel').addEventListener('click', () => {
      const header = ['Categoría', ...buckets.flatMap((b) => (catHasDelta ? [b.label + ' Actual', b.label + ' Δ'] : [b.label]))];
      const aoa = [header];
      catFilas.forEach((f) => aoa.push([f.nombre, ...buckets.flatMap((b, i) => (catHasDelta ? [f.actual[i], catDeltaOf(f)[i]] : [f.actual[i]]))]));
      aoa.push(['Flujo de caja del período', ...buckets.flatMap((b, i) => (catHasDelta ? [catTotalActual[i], catDeltaOf({ actual: catTotalActual, ppto: catTotalPpto })[i]] : [catTotalActual[i]]))]);
      aoa.push(['Caja acumulada', ...buckets.flatMap((b, i) => (catHasDelta ? [catAcumActual[i], catDeltaOf({ actual: catAcumActual, ppto: catAcumPpto })[i]] : [catAcumActual[i]]))]);
      PFReports.exportExcel('resumen_directorio.xlsx', 'Resumen Directorio', aoa);
    });

    const btnObraExcel = el.querySelector('#resumen-obra-excel');
    if (btnObraExcel) {
      btnObraExcel.addEventListener('click', () => {
        const header = ['Concepto', ...obraAnualLabels.flatMap((l) => [l + ' Actual', l + ' Ppto', l + ' Δ'])];
        const aoa = [header];
        lineasTablaObra.forEach((l) => aoa.push([l.nombre, ...obraAnualBuckets.flatMap((_, i) => [l.actual[i], l.ppto[i], l.actual[i] - l.ppto[i]])]));
        aoa.push(['Flujo de caja', ...obraAnualBuckets.flatMap((_, i) => [tablaObraTotalActual[i], tablaObraTotalPpto[i], tablaObraTotalActual[i] - tablaObraTotalPpto[i]])]);
        aoa.push(['Flujo de caja acumulado', ...obraAnualBuckets.flatMap((_, i) => [tablaObraAcumActual[i], tablaObraAcumPpto[i], tablaObraAcumActual[i] - tablaObraAcumPpto[i]])]);
        PFReports.exportExcel('inversion_obras.xlsx', 'Inversión de obras', aoa);
      });
    }
  }

  // ------------------------------------------------------- Vista: Por proyecto
  const OPEN_PROJ_GRUPOS_KEY = 'pf.proyectos.openGrupos';
  const OPEN_PROJ_CATS_KEY = 'pf.proyectos.openCats';
  let proyectosBuscar = '';
  let proyectosEstadoFiltro = ''; // '' = todos; si no, uno de ESTADOS_PROYECTO[].id o 'sin' (sin definir)
  const ESTADOS_PROYECTO = [
    { id: 'evaluacion', nombre: 'En evaluación', color: 'var(--pf-warning-700)', bg: 'var(--pf-warning-100)' },
    { id: 'ejecucion', nombre: 'En ejecución', color: 'var(--pf-primary-700)', bg: 'var(--pf-primary-100)' },
    { id: 'terminado', nombre: 'Terminado', color: 'var(--pf-success-700)', bg: 'var(--pf-success-100)' },
  ];
  function estadoInfo(id) { return ESTADOS_PROYECTO.find((e) => e.id === id) || null; }
  // Siempre muestra algo (también "Sin estado" en gris) — antes, sin estado definido no se veía
  // ningún badge y el campo pasaba desapercibido.
  function estadoBadgeHtml(id) {
    const e = estadoInfo(id);
    if (!e) return `<span class="estado-badge" style="color:var(--pf-slate-500); background:var(--pf-slate-100)">Sin estado</span>`;
    return `<span class="estado-badge" style="color:${e.color}; background:${e.bg}">${PF.esc(e.nombre)}</span>`;
  }

  // Meses/Neto/Aportes/Margen a partir de una proyección — se usa tanto para un proyecto normal
  // como para el neto combinado de un grupo (ver mergeProyeccion), así el cálculo es siempre el
  // mismo sin importar si son datos de un solo proyecto o de varios sumados mes a mes.
  function flowStats(proyeccion) {
    const months = Object.keys(proyeccion || {}).sort();
    const vals = Object.values(proyeccion || {});
    const total = vals.reduce((a, b) => a + b, 0);
    const aportes = Math.abs(vals.filter((v) => v < 0).reduce((a, b) => a + b, 0));
    const margen = aportes ? (total / aportes) * 100 : null;
    return { months, total, aportes, margen };
  }
  function statsRowsHtml(stats, moneda) {
    return `<div class="small">Meses: ${stats.months.length}</div>
      <div class="small ${stats.total < 0 ? 'neg' : 'pos'}">Neto: ${PF.fmtMoney(stats.total, moneda)}</div>
      <div class="small neg">Aportes: ${PF.fmtMoney(stats.aportes, moneda)}</div>
      <div class="small ${stats.margen == null ? 'text-muted' : (stats.margen < 0 ? 'neg' : 'pos')}">Margen: ${stats.margen == null ? '—' : PF.fmtNum(stats.margen) + '%'}</div>`;
  }
  // Suma mes a mes las proyecciones de varios proyectos — para el neto/aportes/margen combinado
  // de un grupo se necesita el flujo neteado por mes (no la suma de los stats de cada hijo por
  // separado), porque un mes donde un hijo aporta y el otro devuelve debe netearse igual que
  // pasaría si fuera un solo proyecto real.
  function mergeProyeccion(proyectos) {
    const merged = {};
    proyectos.forEach((p) => {
      Object.entries(p.proyeccion || {}).forEach(([m, v]) => { merged[m] = (merged[m] || 0) + v; });
    });
    return merged;
  }

  function proyectoCard(p) {
    return `<div class="col-md-4 col-lg-3">
      <div class="panel mb-0" style="cursor:pointer" data-proj="${p.id}">
        <div class="d-flex align-items-start justify-content-between gap-2">
          <div class="fw-semibold text-truncate">${PF.esc(p.nombre)}</div>
          ${estadoBadgeHtml(p.estado)}
        </div>
        <div class="text-muted small mb-2">${PF.esc(categoriaNombre(p.categoriaId))}${p.tipo ? ' · ' + PF.esc(p.tipo) : ''}
        ${p.anioConstruccion ? ' · año ' + PF.esc(String(p.anioConstruccion)) : ''}</div>
        ${statsRowsHtml(flowStats(p.proyeccion), p.moneda)}
      </div></div>`;
  }

  // Tarjeta de un "grupo" (proyecto.grupoPadre): proyectos independientes que en la práctica son
  // sub-obras de un mismo proyecto más grande (ej. "Icuadra Sn Bdo 3 y 4" agrupando "Jardines de
  // San Bernardo I" y "II"). El agrupamiento es solo de la app — cada hijo sigue siendo un
  // proyecto normal con su propio flujo real, así que no hay riesgo de doble conteo en
  // categorías/Resumen Directorio/Flujo de Caja, que siguen viendo cada hijo por separado.
  function grupoCard(nombre, children, isOpen) {
    const stats = flowStats(mergeProyeccion(children));
    const moneda = (children[0] && children[0].moneda) || state.config.moneda;
    return `<div class="col-md-4 col-lg-3">
      <div class="panel mb-0" style="cursor:pointer; border-color:var(--pf-primary-500)" data-grupo-toggle="${PF.esc(nombre)}">
        <div class="d-flex align-items-center gap-1">
          <i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'} text-muted"></i>
          <div class="fw-semibold text-truncate">${PF.esc(nombre)}</div>
        </div>
        <div class="text-muted small mb-2">${children.length} proyectos agrupados</div>
        ${statsRowsHtml(stats, moneda)}
      </div></div>`;
  }

  // Arma las tarjetas de una lista de proyectos, agrupando los que compartan grupoPadre en una
  // sola tarjeta expandible en vez de mostrarlos sueltos.
  function proyectosGridHtml(proys) {
    const openGrupos = loadOpenMap(OPEN_PROJ_GRUPOS_KEY);
    const seen = new Set();
    return proys.map((p) => {
      if (!p.grupoPadre) return proyectoCard(p);
      if (seen.has(p.grupoPadre)) return '';
      seen.add(p.grupoPadre);
      const children = proys.filter((x) => x.grupoPadre === p.grupoPadre);
      const isOpen = openGrupos[p.grupoPadre] === true;
      const childrenHtml = isOpen
        ? `<div class="col-12"><div class="row g-2 ps-4 pt-1">${children.map(proyectoCard).join('')}</div></div>`
        : '';
      return grupoCard(p.grupoPadre, children, isOpen) + childrenHtml;
    }).join('');
  }

  function renderProyectos() {
    const el = document.getElementById('proyectos');
    const openCats = loadOpenMap(OPEN_PROJ_CATS_KEY);
    const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g');
    const norm = (s) => (s || '').toString().normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase().trim();
    const q = norm(proyectosBuscar);
    const matches = (p) => {
      if (q && !norm(`${p.nombre} ${p.tipo || ''} ${p.grupoPadre || ''}`).includes(q)) return false;
      if (proyectosEstadoFiltro === 'sin') return !p.estado;
      if (proyectosEstadoFiltro) return p.estado === proyectosEstadoFiltro;
      return true;
    };
    const filtroActivo = !!(q || proyectosEstadoFiltro);
    let catIdx = 0;
    const porCat = state.categorias.map((cat) => {
      const proysCat = state.proyectos.filter((p) => p.categoriaId === cat.id);
      const proys = proysCat.filter(matches);
      if (!proysCat.length) return '';
      if (filtroActivo && !proys.length) return '';
      // Con un filtro activo (búsqueda o estado), la categoría con resultados se muestra siempre abierta.
      const isOpen = filtroActivo ? true : (Object.prototype.hasOwnProperty.call(openCats, cat.id) ? openCats[cat.id] : catIdx === 0);
      catIdx++;
      const items = proyectosGridHtml(proys) || '<div class="text-muted small px-2">Sin proyectos</div>';
      return `<div class="mb-3 proj-cat-group">
        <div class="proj-cat-header" data-cat-toggle="${cat.id}" role="button" tabindex="0">
          <i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}"></i>
          <span class="fw-semibold">${PF.esc(cat.nombre)}</span>
          <span class="text-muted small">(${proys.length}${filtroActivo ? ' de ' + proysCat.length : ''})</span>
        </div>
        ${isOpen ? `<div class="row g-2 mt-1">${items}</div>` : ''}
      </div>`;
    }).join('');
    const sinCat = state.proyectos.filter((p) => !state.categorias.some((c) => c.id === p.categoriaId)).filter(matches);
    const estadoChips = [{ id: '', nombre: 'Todos' }, ...ESTADOS_PROYECTO, { id: 'sin', nombre: 'Sin estado' }]
      .map((e) => `<button type="button" class="dash-year-chip ${proyectosEstadoFiltro === e.id ? 'active' : ''}" data-estado-filtro="${e.id}">${PF.esc(e.nombre)}</button>`).join('');
    el.innerHTML = `
      <div class="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
        <div class="d-flex flex-column gap-2">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <div class="input-group input-group-sm" style="width:260px">
              <span class="input-group-text"><i class="bi bi-search"></i></span>
              <input type="text" class="form-control" id="proj-search" placeholder="Buscar proyecto..." value="${PF.esc(proyectosBuscar)}">
            </div>
            <span class="text-muted small">${state.proyectos.length} proyecto(s)</span>
          </div>
          <div class="dash-year-chips" style="margin-bottom:0"><span class="text-muted small me-1">Estado:</span>${estadoChips}</div>
        </div>
        ${isAdmin() ? '<button class="btn btn-sm btn-primary" id="btn-nuevo-proj"><i class="bi bi-plus-lg"></i> Nuevo proyecto</button>' : ''}
      </div>
      ${porCat || '<div class="text-muted small">Ningún proyecto coincide con el filtro.</div>'}
      ${sinCat.length ? `<div class="mb-3"><div class="fw-semibold mb-2 text-muted">Sin categoría</div>
        <div class="row g-2">${proyectosGridHtml(sinCat)}</div></div>` : ''}`;

    if (isAdmin()) document.getElementById('btn-nuevo-proj').addEventListener('click', () => nuevoProyectoDialog());
    el.querySelectorAll('[data-estado-filtro]').forEach((btn) => btn.addEventListener('click', () => {
      proyectosEstadoFiltro = btn.dataset.estadoFiltro;
      renderProyectos();
    }));
    el.querySelectorAll('[data-proj]').forEach((c) => c.addEventListener('click', () => renderProyectoDetail(c.dataset.proj)));
    el.querySelectorAll('[data-grupo-toggle]').forEach((c) => c.addEventListener('click', () => {
      const nombre = c.dataset.grupoToggle;
      const cur = loadOpenMap(OPEN_PROJ_GRUPOS_KEY);
      cur[nombre] = !(cur[nombre] === true);
      saveOpenMap(OPEN_PROJ_GRUPOS_KEY, cur);
      renderProyectos();
    }));
    el.querySelectorAll('[data-cat-toggle]').forEach((row) => {
      const toggle = () => {
        const id = row.dataset.catToggle;
        const wasOpen = Object.prototype.hasOwnProperty.call(openCats, id) ? openCats[id] : false;
        const cur = loadOpenMap(OPEN_PROJ_CATS_KEY);
        cur[id] = !wasOpen;
        saveOpenMap(OPEN_PROJ_CATS_KEY, cur);
        renderProyectos();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    const searchEl = el.querySelector('#proj-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => { proyectosBuscar = searchEl.value; renderProyectos(); });
      if (proyectosBuscar) { searchEl.focus(); searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length); }
    }
  }

  // Detalle de proyecto en un modal (antes se insertaba al final de la página y había que
  // desplazarse hasta abajo para verlo, y de nuevo hacia arriba para volver a la grilla) — el
  // modal se abre encima, sin mover el scroll ni perder la posición en la grilla de tarjetas.
  function renderProyectoDetail(id) {
    state.currentProyectoId = id;
    const p = state.proyectos.find((x) => x.id === id);
    if (!p) return;
    const months = allMonths([p]);
    const net = {}; months.forEach((m) => { net[m] = (p.proyeccion || {})[m] || 0; });
    const proj = (() => { let acc = 0; const o = {}; months.forEach((m) => { acc += net[m]; o[m] = acc; }); return o; })();
    const stats = flowStats(p.proyeccion);

    const html = `
      <div class="modal fade" tabindex="-1" id="proj-detail-modal"><div class="modal-dialog modal-lg modal-dialog-centered"><div class="modal-content">
        <div class="modal-header">
          <div>
            <h5 class="modal-title mb-1 d-flex align-items-center gap-2">${PF.esc(p.nombre)} ${estadoBadgeHtml(p.estado)}</h5>
            <span class="text-muted small">${PF.esc(categoriaNombre(p.categoriaId))} · ${p.moneda || state.config.moneda}
            ${p.tipo ? '· ' + PF.esc(p.tipo) : ''}
            ${p.grupoPadre ? '· grupo: ' + PF.esc(p.grupoPadre) : ''}
            ${p.anioConstruccion ? '· año construcción: ' + PF.esc(String(p.anioConstruccion)) : ''}
            ${p.ultimaImportacion ? '· última importación: ' + PF.esc(p.ultimaImportacion.fileName || '') : ''}</span>
          </div>
          <button class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          ${statsRowsHtml(stats, p.moneda)}
          <div class="chart-box mt-3"><canvas id="chart-proj-detail"></canvas></div>
        </div>
        <div class="modal-footer">
          ${isAdmin() ? `<button class="btn btn-outline-danger me-auto" id="btn-del-proj"><i class="bi bi-trash"></i> Eliminar</button>
          <button class="btn btn-outline-secondary" id="btn-edit-proj"><i class="bi bi-pencil"></i> Editar</button>` : ''}
          <button class="btn btn-primary" data-bs-dismiss="modal">Cerrar</button>
        </div>
      </div></div></div>`;
    const wrap = document.createElement('div'); wrap.innerHTML = html; document.body.appendChild(wrap);
    const modalEl = wrap.querySelector('#proj-detail-modal');
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
    modalEl.addEventListener('hidden.bs.modal', () => wrap.remove());

    const labels = months.map(PF.monthLabel);
    PFCharts.destroy('chart-proj-detail');
    const c = wrap.querySelector('#chart-proj-detail').getContext('2d');
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
    if (isAdmin()) {
      wrap.querySelector('#btn-edit-proj').addEventListener('click', () => { modal.hide(); nuevoProyectoDialog(p); });
      wrap.querySelector('#btn-del-proj').addEventListener('click', async () => {
        if (!confirm(`¿Eliminar el proyecto "${p.nombre}"? Esto borra su proyección.`)) return;
        await DB.deleteProyecto(p.id); await loadAll(); toast('Proyecto eliminado', 'danger'); modal.hide(); renderProyectos();
      });
    }
  }

  // Diálogo crear/editar proyecto (usa prompt simple con modal Bootstrap).
  function nuevoProyectoDialog(proj) {
    const isEdit = !!proj;
    const opts = state.categorias.map((c) =>
      `<option value="${c.id}" ${proj && proj.categoriaId === c.id ? 'selected' : ''}>${PF.esc(c.nombre)}</option>`).join('');
    // Grupos existentes para el datalist, para que al agregar el segundo proyecto de un grupo
    // ("Jardines de San Bernardo II") sea fácil escribir EXACTO el mismo nombre que el primero
    // ("Icuadra Sn Bdo 3 y 4") — el agrupamiento en Por proyecto es por coincidencia exacta de texto.
    const gruposExistentes = Array.from(new Set(state.proyectos.map((p) => p.grupoPadre).filter(Boolean))).sort();
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
          <div class="mb-2"><label class="form-label small">Grupo <span class="text-muted">(opcional — para agrupar sub-proyectos, ej. "Icuadra Sn Bdo 3 y 4")</span></label>
            <input class="form-control" id="mp-grupo" list="mp-grupo-list" value="${isEdit ? PF.esc(proj.grupoPadre || '') : ''}" placeholder="Nombre del grupo">
            <datalist id="mp-grupo-list">${gruposExistentes.map((g) => `<option value="${PF.esc(g)}">`).join('')}</datalist></div>
          <div class="mb-2"><label class="form-label small">Moneda</label>
            <select class="form-select" id="mp-moneda">
              <option value="UF" ${!proj || proj.moneda === 'UF' ? 'selected' : ''}>UF</option>
              <option value="CLP" ${proj && proj.moneda === 'CLP' ? 'selected' : ''}>CLP</option>
            </select></div>
          <div class="mb-2"><label class="form-label small">Estado</label>
            <select class="form-select" id="mp-estado">
              <option value="" ${!proj || !proj.estado ? 'selected' : ''}>Sin definir</option>
              ${ESTADOS_PROYECTO.map((e) => `<option value="${e.id}" ${proj && proj.estado === e.id ? 'selected' : ''}>${PF.esc(e.nombre)}</option>`).join('')}
            </select></div>
          <div class="mb-2"><label class="form-label small">Año de construcción <span class="text-muted">(opcional — agrupa "Flujo de Obras" en Resumen Directorio)</span></label>
            <input type="number" class="form-control" id="mp-anio" min="2000" max="2100" value="${isEdit ? anioConstruccionEfectivo(proj) : ''}" placeholder="Ej: 2026"></div>
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
      const anioVal = wrap.querySelector('#mp-anio').value;
      const data = {
        nombre, categoriaId: wrap.querySelector('#mp-cat').value, moneda: wrap.querySelector('#mp-moneda').value,
        tipo: wrap.querySelector('#mp-tipo').value.trim(), grupoPadre: wrap.querySelector('#mp-grupo').value.trim() || null,
        estado: wrap.querySelector('#mp-estado').value || null, anioConstruccion: anioVal ? Number(anioVal) : null,
      };
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
    if (!isAdmin()) {
      el.innerHTML = emptyState('Solo administradores', 'Pídele a un administrador que importe el Excel por ti.');
      return;
    }
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
    busyOnClick(box.querySelector('#imp-save'), 'Guardando...', saveImport);

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
    busyOnClick(el.querySelector('#mst-import'), 'Guardando...', () => saveMasterImport(items));
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
    busyOnClick(el.querySelector('#ppt-import'), 'Guardando...', () => savePresupuestoImport(items));
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
        <td class="num" style="width:160px"><input type="number" class="form-control form-control-sm num caja-input" data-mes="${m}" value="${real}" ${isAdmin() ? '' : 'disabled'}></td>
        <td class="num ${desv == null ? '' : (desv < 0 ? 'neg' : 'pos')}">${desv == null ? '—' : PF.fmtMoney(desv)}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="panel">
        <h6>Punto de partida</h6>
        ${!isAdmin() ? '<p class="text-muted small mb-0">Solo un administrador puede cambiar esto.</p>' : ''}
        <div class="row g-2 align-items-end">
          <div class="col-md-4"><label class="form-label small">Caja inicial (${state.config.moneda})</label>
            <input type="number" class="form-control" id="cfg-caja-inicial" value="${state.config.cajaInicial}" ${isAdmin() ? '' : 'disabled'}></div>
          <div class="col-md-4"><label class="form-label small">Mes inicial</label>
            <input type="month" class="form-control" id="cfg-mes-inicial" value="${state.config.mesInicial}" ${isAdmin() ? '' : 'disabled'}></div>
          <div class="col-md-4">${isAdmin() ? '<button class="btn btn-primary" id="cfg-save-caja">Guardar</button>' : ''}</div>
        </div>
      </div>
      <div class="panel">
        <h6>Caja real del banco${isAdmin() ? ' (ingresa el saldo de cada mes)' : ''}</h6>
        ${months.length ? `<table class="table table-sm">
          <thead><tr><th>Mes</th><th class="num">Caja proyectada</th><th class="num">Caja real (banco)</th><th class="num">Desviación</th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="text-muted">Importa proyectos para ver los meses.</div>'}
      </div>`;

    if (isAdmin()) {
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
  }

  // ------------------------------------------------------- Vista: Programar pagos
  const PAGOS_METRIC_KEY = 'pf.pagos.metrica';
  // 'pagar' = solo egresos (aportes, flujo &lt; 0, se muestran en positivo); 'devolucion' = solo
  // ingresos (flujo &gt; 0); 'neto' = devolución - pagar, o sea el mismo valor con signo de
  // proyeccion[m] (cada proyecto tiene un único neto por mes, no aportes y devoluciones por
  // separado, así que "neto" no es más que no filtrar por signo).
  const PAGOS_METRICAS = {
    pagar: { label: 'Monto a pagar', titulo: 'Egresos proyectados (aportes)', colHead: 'Monto a pagar', cls: 'neg',
      filtro: (v) => v < 0, valor: (v) => Math.abs(v) },
    devolucion: { label: 'Devoluciones', titulo: 'Devoluciones proyectadas', colHead: 'Monto a recibir', cls: 'pos',
      filtro: (v) => v > 0, valor: (v) => v },
    neto: { label: 'Neto', titulo: 'Flujo neto proyectado', colHead: 'Neto', cls: '', filtro: (v) => v !== 0, valor: (v) => v },
  };
  let pagosMetric = (function () {
    try { return PAGOS_METRICAS[localStorage.getItem(PAGOS_METRIC_KEY)] ? localStorage.getItem(PAGOS_METRIC_KEY) : 'pagar'; } catch (e) { return 'pagar'; }
  })();

  function renderPagos() {
    const el = document.getElementById('pagos');
    const cur = PF.currentMonth();
    const months = allMonths().filter((m) => m >= cur);
    if (!months.length) { el.innerHTML = emptyState('Sin pagos futuros', 'No hay egresos proyectados desde este mes.'); return; }

    const metrica = PAGOS_METRICAS[pagosMetric];
    // Por cada mes futuro, lista las filas que cumplen el filtro de la métrica elegida.
    let bodyRows = '', totalGlobal = 0;
    months.forEach((m) => {
      const filas = state.proyectos
        .map((p) => ({ p, val: (p.proyeccion || {})[m] || 0 }))
        .filter((x) => metrica.filtro(x.val))
        .sort((a, b) => Math.abs(metrica.valor(b.val)) - Math.abs(metrica.valor(a.val)));
      if (!filas.length) return;
      const totMes = filas.reduce((a, b) => a + metrica.valor(b.val), 0);
      totalGlobal += totMes;
      const totCls = totMes < 0 ? 'neg' : (totMes > 0 ? 'pos' : '');
      bodyRows += `<tr class="table-light"><td colspan="3" class="fw-semibold">${PF.monthLabel(m)}</td>
        <td class="num fw-semibold ${totCls}">${PF.fmtMoney(totMes)}</td></tr>`;
      filas.forEach((x) => {
        const v = metrica.valor(x.val);
        const cls = metrica.cls || (v < 0 ? 'neg' : (v > 0 ? 'pos' : ''));
        bodyRows += `<tr><td></td><td>${PF.esc(x.p.nombre)}</td><td class="text-muted small">${PF.esc(categoriaNombre(x.p.categoriaId))}</td>
          <td class="num ${cls}">${PF.fmtMoney(v, x.p.moneda)}</td></tr>`;
      });
    });

    const metricOpts = Object.entries(PAGOS_METRICAS).map(([key, m]) =>
      `<option value="${key}" ${key === pagosMetric ? 'selected' : ''}>${PF.esc(m.label)}</option>`).join('');

    el.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div class="text-muted">${PF.esc(metrica.titulo)} desde <b>${PF.monthLabel(cur)}</b> — total:
          <b class="${totalGlobal < 0 ? 'neg' : (totalGlobal > 0 ? 'pos' : '')}">${PF.fmtMoney(Math.abs(totalGlobal))}</b></div>
        <div class="d-flex align-items-center gap-2">
          <label class="text-muted small mb-0" for="pagos-metrica">Ver</label>
          <select class="form-select form-select-sm" id="pagos-metrica" style="width:auto">${metricOpts}</select>
          <button class="btn btn-sm btn-outline-success" id="btn-pagos-excel"><i class="bi bi-file-earmark-excel"></i> Exportar Excel</button>
        </div>
      </div>
      <div class="panel">
        <table class="table table-sm">
          <thead><tr><th></th><th>Proyecto</th><th>Categoría</th><th class="num">${PF.esc(metrica.colHead)}</th></tr></thead>
          <tbody>${bodyRows || '<tr><td colspan="4" class="text-muted">Sin datos para esta métrica.</td></tr>'}</tbody>
        </table>
      </div>`;

    el.querySelector('#pagos-metrica').addEventListener('change', (e) => {
      pagosMetric = e.target.value;
      try { localStorage.setItem(PAGOS_METRIC_KEY, pagosMetric); } catch (e2) { /* localStorage puede no estar disponible */ }
      renderPagos();
    });
    el.querySelector('#btn-pagos-excel').addEventListener('click', () => {
      const aoa = [['Mes', 'Proyecto', 'Categoría', metrica.colHead + ' (' + state.config.moneda + ')']];
      months.forEach((m) => {
        state.proyectos.forEach((p) => {
          const v = (p.proyeccion || {})[m] || 0;
          if (metrica.filtro(v)) aoa.push([PF.monthLabel(m), p.nombre, categoriaNombre(p.categoriaId), metrica.valor(v)]);
        });
      });
      PFReports.exportExcel('programacion_pagos.xlsx', 'Pagos', aoa);
    });
  }

  // ------------------------------------------------------- Vista: Planificación
  // Seguimiento de etapas de negocio (evaluación → financiamiento → MCG) para un proyecto — vive
  // en su propia colección (planProyectos) que por ahora no está vinculada a proyectos/*
  // (ver comentario en renderPlanificacion). El usuario solo ingresa 2 fechas ancla por proyecto
  // (promesaCompraventa, fechaInicioConstruccion, ver PLAN_FECHAS_HITO) — TODAS las fechas
  // objetivo de las 7 etapas se calculan solas a partir de esas 2 y de las duraciones fijas del
  // negocio (ver planEtapasObjetivo). Lo único que se ingresa a mano etapa por etapa es la fecha
  // real en que se completó ("Completado el"), para poder comparar avance real vs. calculado.
  // Cada tarjeta de proyecto empieza cerrada (solo el header, con el badge de alertas si las
  // tiene) — con varios proyectos, mostrar las 7 filas de todos de entrada era demasiado; se
  // abre haciendo clic en el header, igual que las categorías colapsables de otras vistas.
  const OPEN_PLAN_KEY = 'pf.planificacion.openProyectos';
  let planificacionBuscar = '';
  let planificacionEncargadoFiltro = ''; // '' = todos; si no, el nombre exacto de un encargado
  const ETAPAS_PLANIFICACION = [
    { id: 'evaluacion', nombre: 'Evaluación' },
    { id: 'financiamientoTerreno', nombre: 'Financiamiento Terreno' },
    { id: 'actualizacion1', nombre: 'Actualización evaluación' },
    { id: 'financiamientoConstruccion', nombre: 'Financiamiento Construcción' },
    { id: 'actualizacion2', nombre: 'Actualización evaluación' },
    { id: 'mcg', nombre: 'MCG' },
  ];
  // Fechas hito editables en el header de cada tarjeta — las únicas 2 fechas que se ingresan a
  // mano en toda la planificación; todo lo demás se deriva de ellas.
  const PLAN_FECHAS_HITO = [
    { campo: 'promesaCompraventa', label: 'Promesa de compraventa del terreno' },
    { campo: 'fechaInicioConstruccion', label: 'Fecha de inicio de construcción' },
  ];
  function hoyISO() { return new Date().toISOString().slice(0, 10); }
  function addMesesISO(iso, meses) {
    const d = new Date(iso + 'T00:00:00');
    d.setMonth(d.getMonth() + meses);
    return d.toISOString().slice(0, 10);
  }
  function addDiasISO(iso, dias) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
  }
  function fmtFechaCorta(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}-${m}-${y}`;
  }
  // Calcula la fecha objetivo (inicio/fin) de cada etapa a partir de las 2 fechas ancla del
  // proyecto — nunca a mano. Encadenamiento (duraciones fijas del negocio, las mismas que pidió
  // el usuario): Evaluación (1 mes) → Financiamiento Terreno (4 meses, termina justo en la
  // promesa) → Actualización evaluación (2 semanas) → Fecha de lanzamiento (hito) →
  // Financiamiento Construcción (6 meses, termina justo en el inicio de obra) → Actualización
  // evaluación (2 semanas) → MCG (hito final). Cada tramo solo se puede calcular si ya está la
  // fecha ancla de la que depende — si falta, esa etapa (y las que dependen de ella hacia atrás)
  // devuelven `undefined`.
  function planEtapasObjetivo(plan) {
    const obj = {};
    const promesa = plan.promesaCompraventa;
    const inicioConst = plan.fechaInicioConstruccion;
    if (promesa) {
      const financiamientoTerreno = { inicio: addMesesISO(promesa, -4), fin: promesa };
      obj.financiamientoTerreno = financiamientoTerreno;
      obj.evaluacion = { inicio: addMesesISO(financiamientoTerreno.inicio, -1), fin: financiamientoTerreno.inicio };
      obj.actualizacion1 = { inicio: promesa, fin: addDiasISO(promesa, 15) };
    }
    if (inicioConst) {
      const financiamientoConstruccion = { inicio: addMesesISO(inicioConst, -6), fin: inicioConst };
      obj.fechaLanzamiento = { inicio: financiamientoConstruccion.inicio, fin: financiamientoConstruccion.inicio };
      obj.financiamientoConstruccion = financiamientoConstruccion;
      const actualizacion2 = { inicio: inicioConst, fin: addDiasISO(inicioConst, 15) };
      obj.actualizacion2 = actualizacion2;
      obj.mcg = { inicio: actualizacion2.fin, fin: actualizacion2.fin };
    }
    return obj;
  }
  // Estado de una etapa: compara la fecha real marcada a mano (`etapas[id].fin`) contra la
  // objetivo calculada. Sin fecha ancla → no hay nada que comparar. Completada tarde o atrasada
  // sin completar (hoy ya pasó el objetivo) cuentan como alerta.
  function planEtapaEstado(plan, etapaDef, objetivo) {
    const e = (plan.etapas || {})[etapaDef.id] || {};
    if (!objetivo) return { alerta: false, html: '<span class="text-muted small">Falta la fecha ancla</span>' };
    if (e.fin) {
      if (e.fin > objetivo.fin) {
        return { alerta: true, html: `<div class="plan-alert-badge"><i class="bi bi-exclamation-triangle-fill"></i> Se completó tarde (objetivo: ${fmtFechaCorta(objetivo.fin)})</div>` };
      }
      return { alerta: false, html: '<span class="text-success small"><i class="bi bi-check-circle-fill"></i> Completada</span>' };
    }
    if (hoyISO() > objetivo.fin) {
      return { alerta: true, html: `<div class="plan-alert-badge"><i class="bi bi-exclamation-triangle-fill"></i> Atrasada (objetivo: ${fmtFechaCorta(objetivo.fin)})</div>` };
    }
    return { alerta: false, html: '<span class="text-muted small">En plazo</span>' };
  }

  // Índice de la etapa "actual" de un proyecto: la primera que todavía no tiene `fin` marcado a
  // mano (o sea, en la que está parado hoy). Si todas tienen `fin`, el proyecto ya completó todo
  // el proceso (índice = ETAPAS_PLANIFICACION.length). Se usa para ordenar la lista de proyectos.
  function planEtapaActualIdx(plan) {
    const etapas = plan.etapas || {};
    for (let i = 0; i < ETAPAS_PLANIFICACION.length; i++) {
      if (!(etapas[ETAPAS_PLANIFICACION[i].id] || {}).fin) return i;
    }
    return ETAPAS_PLANIFICACION.length;
  }

  function renderPlanificacion() {
    const el = document.getElementById('planificacion');

    const addBarHtml = isAdmin() ? `
      <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <input type="text" class="form-control form-control-sm" id="plan-add-nombre" style="max-width:320px" placeholder="Nombre del proyecto…">
        <button class="btn btn-sm btn-primary" id="plan-add-btn"><i class="bi bi-plus-lg"></i> Agregar a planificación</button>
      </div>` : '';
    const introHtml = `<p class="text-muted small mb-3">Seguimiento de etapas de negocio: evaluación, financiamiento de terreno,
      actualización, financiamiento de construcción, actualización y MCG. Solo se ingresan las 2 fechas ancla de cada
      proyecto (promesa de compraventa del terreno y fecha de inicio de construcción) — el resto de las fechas objetivo se
      calculan solas. "Completado el" es la única fecha que se marca a mano, etapa por etapa, a medida que se va avanzando.
      Por ahora los proyectos se agregan a mano con su nombre — más adelante se van a poder vincular con los proyectos del
      flujo de caja.</p>`;

    if (!state.planProyectos.length) {
      el.innerHTML = introHtml + addBarHtml + emptyState('Sin proyectos en planificación', 'Agrega un proyecto a mano para empezar a seguir sus etapas.');
      wirePlanAdd(el);
      return;
    }

    const DIACRITICS_RE_PLAN = new RegExp('[̀-ͯ]', 'g');
    const normPlan = (s) => (s || '').toString().normalize('NFD').replace(DIACRITICS_RE_PLAN, '').toLowerCase().trim();
    const qPlan = normPlan(planificacionBuscar);
    // Encargados existentes, para el filtro — si el que estaba seleccionado ya no existe (se
    // renombró o se quitó el proyecto que lo tenía), el filtro vuelve solo a "Todos".
    const encargadosPlan = Array.from(new Set(state.planProyectos.map((p) => p.encargado).filter(Boolean))).sort();
    if (planificacionEncargadoFiltro && !encargadosPlan.includes(planificacionEncargadoFiltro)) planificacionEncargadoFiltro = '';
    const searchBarHtml = `<div class="d-flex align-items-center gap-2 flex-wrap mb-3">
      <div class="input-group input-group-sm" style="max-width:320px">
        <span class="input-group-text"><i class="bi bi-search"></i></span>
        <input type="text" class="form-control" id="plan-search" placeholder="Buscar proyecto..." value="${PF.esc(planificacionBuscar)}">
      </div>
      <select class="form-select form-select-sm" id="plan-encargado-filtro" style="max-width:220px">
        <option value="">Todos los encargados</option>
        ${encargadosPlan.map((e) => `<option value="${PF.esc(e)}" ${e === planificacionEncargadoFiltro ? 'selected' : ''}>${PF.esc(e)}</option>`).join('')}
      </select>
    </div>`;

    const openPlanes = loadOpenMap(OPEN_PLAN_KEY);

    // ---- Alertas por proyecto, calculadas una sola vez para TODOS los proyectos (sin filtro de
    // búsqueda) — sirven tanto para el resumen de arriba como, reutilizadas, para las filas de
    // cada tarjeta (evita recalcular 2 veces lo mismo).
    const planInfo = state.planProyectos.map((plan) => {
      const objetivos = planEtapasObjetivo(plan);
      const items = ETAPAS_PLANIFICACION.map((ed) => {
        const e = (plan.etapas || {})[ed.id] || {};
        return { ed, e, objetivo: objetivos[ed.id], estado: planEtapaEstado(plan, ed, objetivos[ed.id]) };
      });
      const alertas = items.filter((it) => it.estado.alerta)
        .map((it) => `${it.ed.nombre}${it.e.fin ? ' (se completó tarde)' : ' (atrasada)'}`);
      return { plan, items, alertas, fechaLanzamiento: objetivos.fechaLanzamiento };
    });
    const planInfoPorId = new Map(planInfo.map((x) => [x.plan.id, x]));
    const conAlerta = planInfo.filter((x) => x.alertas.length > 0);
    const totalAlertas = conAlerta.reduce((s, x) => s + x.alertas.length, 0);

    const alertSummaryHtml = conAlerta.length ? `<div class="plan-alert-summary">
      <div class="plan-alert-summary-head">
        <i class="bi bi-exclamation-triangle-fill"></i>
        <span><b>${totalAlertas}</b> alerta${totalAlertas > 1 ? 's' : ''} en <b>${conAlerta.length}</b> de ${state.planProyectos.length} proyecto${state.planProyectos.length === 1 ? '' : 's'}</span>
      </div>
      <div class="plan-alert-summary-list">
        ${conAlerta.map((x) => `<button type="button" class="plan-alert-chip" data-plan-jump="${x.plan.id}" title="${PF.esc(x.alertas.join(' · '))}">
          <span>${PF.esc(x.plan.nombre || '(sin nombre)')}</span>
          <span class="plan-alert-chip-count">${x.alertas.length}</span>
        </button>`).join('')}
      </div>
    </div>` : `<div class="plan-alert-summary ok"><i class="bi bi-check-circle-fill"></i> Sin alertas — todas las etapas están en plazo o se completaron a tiempo.</div>`;

    // Ordenados por etapa actual (la primera sin `fin`): los que van más atrás en el proceso
    // primero, los que ya completaron todo (MCG con fin) al final.
    const planesOrdenados = state.planProyectos.slice()
      .filter((plan) => !qPlan || normPlan(plan.nombre).includes(qPlan))
      .filter((plan) => !planificacionEncargadoFiltro || plan.encargado === planificacionEncargadoFiltro)
      .sort((a, b) => planEtapaActualIdx(a) - planEtapaActualIdx(b));
    const cardsHtml = planesOrdenados.map((plan) => {
      const nombre = plan.nombre || '(sin nombre)';
      const isOpen = openPlanes[plan.id] === true;
      const etapaActualIdx = planEtapaActualIdx(plan);
      const completado = etapaActualIdx >= ETAPAS_PLANIFICACION.length;
      const etapaActualTexto = completado ? 'Completado' : ETAPAS_PLANIFICACION[etapaActualIdx].nombre;
      const { items, alertas, fechaLanzamiento } = planInfoPorId.get(plan.id);
      const alertasTotal = alertas.length;
      const dotsHtml = `<div class="plan-progress" title="Etapa ${Math.min(etapaActualIdx + 1, ETAPAS_PLANIFICACION.length)} de ${ETAPAS_PLANIFICACION.length}">
        ${ETAPAS_PLANIFICACION.map((_, i) => `<span class="plan-dot ${i < etapaActualIdx || completado ? 'done' : (i === etapaActualIdx ? 'current' : '')}"></span>`).join('')}
      </div>`;
      const filas = items.map(({ ed, e, objetivo, estado }, idx) => {
        const rowCls = estado.alerta ? 'plan-etapa-alert' : (e.fin ? 'plan-etapa-done' : '');
        const objetivoTexto = objetivo ? `${fmtFechaCorta(objetivo.inicio)} → ${fmtFechaCorta(objetivo.fin)}` : '—';
        return `<tr class="${rowCls}">
          <td>${idx + 1}. ${PF.esc(ed.nombre)}</td>
          <td class="text-muted small">${objetivoTexto}</td>
          <td><input type="date" class="form-control form-control-sm plan-fecha" data-plan="${plan.id}" data-etapa="${ed.id}" value="${e.fin || ''}" ${isAdmin() ? '' : 'disabled'}></td>
          <td><input type="text" class="form-control form-control-sm plan-comentario" data-plan="${plan.id}" data-etapa="${ed.id}" value="${PF.esc(e.comentario || '')}" placeholder="Comentario…" ${isAdmin() ? '' : 'disabled'}></td>
          <td>${estado.html}</td>
        </tr>`;
      }).join('');

      return `<div class="panel plan-card ${alertasTotal ? 'has-alert' : ''}" data-plan-card="${plan.id}">
        <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 plan-card-header" data-plan-toggle="${plan.id}" role="button" tabindex="0" style="cursor:pointer">
          <div class="d-flex align-items-start gap-2">
            <i class="bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'} text-muted mt-1"></i>
            <div>
              <h6 class="mb-1 d-flex align-items-center gap-2">
                <input type="text" class="plan-nombre-input" data-plan="${plan.id}" value="${PF.esc(nombre)}" placeholder="Nombre del proyecto…" ${isAdmin() ? '' : 'disabled'} onclick="event.stopPropagation()">
                <span class="plan-stage-badge ${completado ? 'done' : ''}">${PF.esc(etapaActualTexto)}</span>
                ${plan.encargado ? `<span class="text-muted small fw-normal"><i class="bi bi-person"></i> ${PF.esc(plan.encargado)}</span>` : ''}
                ${alertasTotal ? `<span class="badge text-bg-danger">${alertasTotal} alerta${alertasTotal > 1 ? 's' : ''}</span>` : ''}</h6>
              ${dotsHtml}
              <div class="d-flex align-items-center gap-3 flex-wrap mt-2" onclick="event.stopPropagation()">
                <div class="d-flex align-items-center gap-2">
                  <label class="text-muted small mb-0">Encargado</label>
                  <input type="text" class="form-control form-control-sm plan-encargado" data-plan="${plan.id}" style="max-width:170px" value="${PF.esc(plan.encargado || '')}" placeholder="Nombre…" ${isAdmin() ? '' : 'disabled'}>
                </div>
                ${PLAN_FECHAS_HITO.map((f) => `<div class="d-flex align-items-center gap-2">
                  <label class="text-muted small mb-0">${PF.esc(f.label)}</label>
                  <input type="date" class="form-control form-control-sm plan-fecha-hito" data-plan="${plan.id}" data-campo="${f.campo}" style="max-width:170px" value="${plan[f.campo] || ''}" ${isAdmin() ? '' : 'disabled'}>
                </div>`).join('')}
                <div class="d-flex align-items-center gap-2">
                  <label class="text-muted small mb-0">Fecha de lanzamiento (informativa)</label>
                  <input type="date" class="form-control form-control-sm plan-fecha-hito" data-plan="${plan.id}" data-campo="fechaLanzamiento" style="max-width:170px" value="${plan.fechaLanzamiento || (fechaLanzamiento ? fechaLanzamiento.fin : '')}" ${isAdmin() ? '' : 'disabled'}>
                </div>
              </div>
            </div>
          </div>
          ${isAdmin() ? `<button class="btn btn-sm btn-outline-danger plan-del" data-plan="${plan.id}" onclick="event.stopPropagation()"><i class="bi bi-trash"></i> Quitar</button>` : ''}
        </div>
        ${isOpen ? `<div class="table-responsive mt-3">
          <table class="table table-sm plan-table">
            <thead><tr><th style="min-width:190px">Etapa</th><th style="min-width:190px">Objetivo (calculado)</th><th style="min-width:150px">Completado el</th><th style="min-width:220px">Comentario</th><th style="min-width:240px">Estado</th></tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>` : ''}
      </div>`;
    }).join('');

    el.innerHTML = introHtml + addBarHtml + searchBarHtml + alertSummaryHtml + (cardsHtml || '<div class="text-muted small mt-3">Ningún proyecto coincide con el filtro.</div>');
    wirePlanAdd(el);
    const planEncargadoFiltroEl = el.querySelector('#plan-encargado-filtro');
    if (planEncargadoFiltroEl) {
      planEncargadoFiltroEl.addEventListener('change', () => { planificacionEncargadoFiltro = planEncargadoFiltroEl.value; renderPlanificacion(); });
    }
    const planSearchEl = el.querySelector('#plan-search');
    if (planSearchEl) {
      planSearchEl.addEventListener('input', () => { planificacionBuscar = planSearchEl.value; renderPlanificacion(); });
      if (planificacionBuscar) { planSearchEl.focus(); planSearchEl.setSelectionRange(planSearchEl.value.length, planSearchEl.value.length); }
    }
    el.querySelectorAll('[data-plan-jump]').forEach((chip) => chip.addEventListener('click', () => {
      const id = chip.dataset.planJump;
      const cur = loadOpenMap(OPEN_PLAN_KEY);
      cur[id] = true;
      saveOpenMap(OPEN_PLAN_KEY, cur);
      planificacionBuscar = '';
      planificacionEncargadoFiltro = '';
      renderPlanificacion();
      const card = el.querySelector(`[data-plan-card="${CSS.escape(id)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

  function wirePlanAdd(el) {
    const addBtn = el.querySelector('#plan-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const inp = el.querySelector('#plan-add-nombre');
        const nombre = inp.value.trim();
        if (!nombre) { toast('Ingresa un nombre', 'warning'); return; }
        await DB.addPlanProyecto(nombre);
        await loadAll();
        toast('Proyecto agregado a planificación', 'success');
        renderPlanificacion();
      });
    }
    el.querySelectorAll('[data-plan-toggle]').forEach((header) => {
      const toggle = () => {
        const id = header.dataset.planToggle;
        const cur = loadOpenMap(OPEN_PLAN_KEY);
        cur[id] = !(cur[id] === true);
        saveOpenMap(OPEN_PLAN_KEY, cur);
        renderPlanificacion();
      };
      header.addEventListener('click', toggle);
      // El listener de teclado es para poder abrir/cerrar con Enter/Espacio parado en el propio
      // header (accesibilidad, role="button") — pero como el header ENVUELVE los inputs de fecha
      // y el de "Encargado", el evento de teclado de esos inputs burbujea hasta acá también. Sin
      // este guard, escribir un espacio dentro de "Encargado" quedaba interceptado como si fuera
      // el atajo de teclado para expandir/contraer la tarjeta, y jamás llegaba a escribirse.
      header.addEventListener('keydown', (e) => {
        if (e.target !== header && e.target.matches('input, select, textarea')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
    if (!isAdmin()) return;
    el.querySelectorAll('.plan-del').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('¿Quitar este proyecto de la planificación? No se borra el proyecto, solo su seguimiento de etapas.')) return;
      await DB.deletePlanProyecto(btn.dataset.plan);
      await loadAll();
      toast('Quitado de planificación', 'danger');
      renderPlanificacion();
    }));
    el.querySelectorAll('.plan-nombre-input').forEach((inp) => inp.addEventListener('change', async () => {
      const plan = state.planProyectos.find((p) => p.id === inp.dataset.plan);
      if (!plan) return;
      const nombre = inp.value.trim();
      if (!nombre) { toast('El nombre no puede quedar vacío', 'warning'); inp.value = plan.nombre || ''; return; }
      const updated = await DB.updatePlanProyecto(plan.id, { nombre });
      if (updated) Object.assign(plan, updated);
      renderPlanificacion();
    }));
    el.querySelectorAll('.plan-fecha-hito').forEach((inp) => inp.addEventListener('change', async () => {
      const plan = state.planProyectos.find((p) => p.id === inp.dataset.plan);
      if (!plan) return;
      const updated = await DB.updatePlanProyecto(plan.id, { [inp.dataset.campo]: inp.value || null });
      if (updated) Object.assign(plan, updated);
      renderPlanificacion();
    }));
    el.querySelectorAll('.plan-encargado').forEach((inp) => inp.addEventListener('change', async () => {
      const plan = state.planProyectos.find((p) => p.id === inp.dataset.plan);
      if (!plan) return;
      const updated = await DB.updatePlanProyecto(plan.id, { encargado: inp.value.trim() || null });
      if (updated) Object.assign(plan, updated);
      renderPlanificacion();
    }));
    el.querySelectorAll('.plan-fecha').forEach((inp) => inp.addEventListener('change', async () => {
      const plan = state.planProyectos.find((p) => p.id === inp.dataset.plan);
      if (!plan) return;
      const etapas = Object.assign({}, plan.etapas);
      etapas[inp.dataset.etapa] = Object.assign({}, etapas[inp.dataset.etapa], { fin: inp.value || null });
      const updated = await DB.updatePlanProyecto(plan.id, { etapas });
      if (updated) Object.assign(plan, updated);
      renderPlanificacion();
    }));
    el.querySelectorAll('.plan-comentario').forEach((inp) => inp.addEventListener('change', async () => {
      const plan = state.planProyectos.find((p) => p.id === inp.dataset.plan);
      if (!plan) return;
      const etapas = Object.assign({}, plan.etapas);
      etapas[inp.dataset.etapa] = Object.assign({}, etapas[inp.dataset.etapa], { comentario: inp.value });
      const updated = await DB.updatePlanProyecto(plan.id, { etapas });
      if (updated) Object.assign(plan, updated);
    }));
  }

  // ------------------------------------------------------- Vista: Reportes
  function renderReportes() {
    const el = document.getElementById('reportes');
    el.innerHTML = `
      <div class="panel">
        <h6>PDF resumen para Directorio</h6>
        <p class="text-muted small">Una página con lo esencial para la reunión: flujo por año, próximos aportes y
          devoluciones, y cantidad de proyectos por estado (ejecución / evaluación / terminado).</p>
        <button class="btn btn-outline-danger" id="rep-pdf-directorio"><i class="bi bi-file-earmark-pdf"></i> PDF Directorio</button>
      </div>
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
      </div>
      <div class="panel">
        <h6>Exportar como archivo maestro</h6>
        <p class="text-muted small">Mismo formato que se importa (una hoja por categoría, una fila por proyecto, meses en
          columnas) — incluye cualquier edición manual del flujo. Sirve para reemplazar el Excel maestro con los datos
          actuales de la app.</p>
        <button class="btn btn-outline-success" id="rep-master-excel"><i class="bi bi-file-earmark-excel"></i> Excel (formato maestro)</button>
      </div>`;

    el.querySelector('#rep-pdf-directorio').addEventListener('click', () => {
      const months = allMonths();
      if (!months.length) { toast('No hay datos para generar el resumen', 'warning'); return; }
      const t = buildTimeline();

      // ---- Mismos números que Resumen Directorio: flujo por categoría, agregado anual, y el
      // acumulado del rango visible (sin cajaInicial) — para que este PDF calce con lo que se ve
      // en pantalla en esa vista, no con otra fuente de verdad.
      const buckets = periodBuckets(months, 'anual');
      const catsConProyectos = state.categorias.filter((cat) => state.proyectos.some((p) => p.categoriaId === cat.id));
      const filasCat = catsConProyectos.map((cat) => {
        const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
        return { nombre: cat.nombre, actual: buckets.map((b) => sumField(proys, b.months, 'proyeccion')) };
      });
      const totalActualAnual = buckets.map((_, i) => filasCat.reduce((a, f) => a + f.actual[i], 0));
      const acumActualAnual = []; let accPdf = 0; totalActualAnual.forEach((v) => { accPdf += v; acumActualAnual.push(accPdf); });
      const veredicto = resumenVeredicto(buckets, acumActualAnual);
      const toneByTipo = { ok: 'ok', warning: 'warning', danger: 'danger' };

      const flujoCatBody = filasCat.map((f) => [f.nombre, ...f.actual.map((v) => (v === 0 ? '—' : PF.fmtNum(v)))]);
      flujoCatBody.push(['Flujo de caja del período', ...totalActualAnual.map((v) => (v === 0 ? '—' : PF.fmtNum(v)))]);
      flujoCatBody.push(['Caja acumulada', ...acumActualAnual.map((v) => (v === 0 ? '—' : PF.fmtNum(v)))]);

      // ---- Próximos aportes y devoluciones: movimientos desde el mes actual, los más grandes primero.
      const cur = PF.currentMonth();
      const futMonths = months.filter((m) => m >= cur);
      const movimientos = [];
      futMonths.forEach((m) => {
        state.proyectos.forEach((p) => {
          const v = (p.proyeccion || {})[m] || 0;
          if (v !== 0) movimientos.push({ mes: m, nombre: p.nombre, cat: categoriaNombre(p.categoriaId), v });
        });
      });
      const proximosBody = movimientos
        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
        .slice(0, 16)
        .map((x) => [PF.monthLabel(x.mes), x.nombre, x.cat, x.v > 0 ? 'Devolución' : 'Aporte', PF.fmtNum(Math.abs(x.v))]);

      // ---- Cantidad de proyectos por estado (columna "Estado" en Por proyecto).
      const countEstado = (id) => state.proyectos.filter((p) => p.estado === id).length;
      const sinEstado = state.proyectos.filter((p) => !p.estado).length;
      const estadoBody = ESTADOS_PROYECTO.map((e) => [e.nombre, String(countEstado(e.id))])
        .concat(sinEstado ? [['Sin definir', String(sinEstado)]] : []);

      const cierreVal = acumActualAnual[acumActualAnual.length - 1] || 0;
      PFReports.exportPDF({
        title: 'Resumen Directorio',
        subtitle: `${buckets[0].label} – ${buckets[buckets.length - 1].label} · Caja inicial ${PF.fmtMoney(state.config.cajaInicial)} · Moneda ${state.config.moneda || 'UF'}`,
        verdict: { text: veredicto.texto.replace(/<[^>]+>/g, ''), tone: toneByTipo[veredicto.tipo] },
        kpis: [
          { label: 'Caja acumulada al cierre', value: PF.fmtNum(cierreVal) + ' UF', accent: cierreVal < 0 ? '#dc2626' : '#16a34a' },
          { label: 'Mínimo de caja proyectado', value: PF.fmtNum(t.minAcc) + ' UF', accent: '#dc2626' },
          { label: 'Proyectos en ejecución', value: String(countEstado('ejecucion')), accent: '#2563eb' },
          { label: 'Proyectos en evaluación', value: String(countEstado('evaluacion')), accent: '#b45309' },
          { label: 'Proyectos terminados', value: String(countEstado('terminado')), accent: '#16a34a' },
        ],
        sections: [
          {
            heading: 'Flujo de caja por categoría y año',
            note: 'Valores en UF — mismos datos que la tabla "Flujo de caja por categoría" de Resumen Directorio.',
            head: ['Categoría', ...buckets.map((b) => b.label)],
            body: flujoCatBody,
            columnStyles: { 0: { fontStyle: 'bold', cellWidth: 160 } },
          },
          {
            heading: 'Próximos aportes y devoluciones',
            note: 'Movimientos futuros de mayor monto, todos los proyectos.',
            head: ['Mes', 'Proyecto', 'Categoría', 'Tipo', 'Monto (UF)'],
            body: proximosBody.length ? proximosBody : [['—', 'Sin movimientos futuros', '', '', '']],
          },
          {
            heading: 'Proyectos por estado',
            head: ['Estado', 'Cantidad'],
            body: estadoBody,
          },
        ],
      });
    });

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
    el.querySelector('#rep-master-excel').addEventListener('click', () => {
      const months = allMonths();
      const header = ['', 'Tipo', ...months.map(PF.monthLabel)];
      const sheets = state.categorias.map((cat) => {
        const proys = state.proyectos.filter((p) => p.categoriaId === cat.id);
        const aoa = [header];
        proys.forEach((p) => aoa.push([p.nombre, p.tipo || '', ...months.map((m) => (p.proyeccion || {})[m] || 0)]));
        return { name: cat.nombre, aoa };
      }).filter((s) => s.aoa.length > 1);
      if (!sheets.length) { toast('No hay proyectos', 'warning'); return; }
      PFReports.exportExcelMulti('flujo_maestro.xlsx', sheets);
    });
  }

  // ------------------------------------------------------- Vista: Configuración
  function renderConfig() {
    const el = document.getElementById('config');
    if (!isAdmin()) {
      el.innerHTML = emptyState('Solo administradores', 'Pídele a un administrador que cambie la configuración.');
      return;
    }
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
      </div>
      <div class="panel" style="border-color:var(--pf-danger-500)">
        <h6 class="text-danger">Zona de peligro</h6>
        <div class="text-muted small mb-2">Borra los ${state.proyectos.length} proyecto(s) (proyección y presupuesto incluidos) —
          útil para empezar de cero después de una importación equivocada. No se puede deshacer.</div>
        <button class="btn btn-sm btn-outline-danger" id="btn-del-all-proj">Borrar todos los proyectos</button>
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
    busyOnClick(el.querySelector('#btn-del-all-proj'), 'Borrando...', async () => {
      const total = state.proyectos.length;
      if (!total) { toast('No hay proyectos que borrar', 'warning'); return; }
      if (!confirm(`¿Borrar los ${total} proyecto(s)? No se puede deshacer.`)) return;
      // En paralelo, no uno por uno: con 340 proyectos, borrarlos secuencialmente se sentía
      // lentísimo (una espera de red por cada uno); Firestore no tiene problema con muchas
      // escrituras concurrentes.
      await Promise.all(state.proyectos.map((p) => DB.deleteProyecto(p.id)));
      await loadAll();
      toast(`${total} proyecto(s) borrados`, 'danger');
      renderConfig();
    });
  }

  // ------------------------------------------------------------------ Vista: Usuarios
  // Solo dueño: administra quién es editor/lector desde la app. Promover a "dueño" no está
  // disponible acá a propósito (ver firestore.rules) — se hace a mano en la consola de Firebase.
  async function renderUsuarios() {
    const el = document.getElementById('usuarios');
    if (!isOwner()) {
      el.innerHTML = emptyState('Solo el dueño', 'Pídele al dueño de la cuenta que administre los usuarios.');
      return;
    }
    el.innerHTML = `<div class="panel"><div class="text-muted small">Cargando usuarios…</div></div>`;
    const roles = await DB.listRoles();
    const rows = roles.map((r) => `<tr>
      <td>${PF.esc(r.email)}</td>
      <td><span class="badge text-bg-${r.role === 'dueño' ? 'warning' : r.role === 'editor' ? 'primary' : 'secondary'}">${PF.esc(r.role)}</span></td>
      <td class="num" style="width:120px">${r.role === 'dueño' ? '' : `<button class="btn btn-sm btn-outline-danger user-del" data-email="${PF.esc(r.email)}"><i class="bi bi-trash"></i></button>`}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="text-muted small">Sin usuarios agregados todavía.</td></tr>';

    el.innerHTML = `
      <div class="panel">
        <h6>Agregar usuario</h6>
        <div class="row g-2 align-items-end">
          <div class="col-md-6"><label class="form-label small">Correo (@ingevec.cl)</label>
            <input type="email" class="form-control" id="user-email" placeholder="nombre@ingevec.cl"></div>
          <div class="col-md-3"><label class="form-label small">Rol</label>
            <select class="form-select" id="user-role">
              <option value="editor">Editor</option>
              <option value="lector">Lector</option>
            </select></div>
          <div class="col-md-3"><button class="btn btn-primary w-100" id="user-add">Agregar</button></div>
        </div>
      </div>
      <div class="panel">
        <h6>Usuarios con acceso</h6>
        <table class="table table-sm"><tbody>${rows}</tbody></table>
      </div>`;

    el.querySelector('#user-add').addEventListener('click', async () => {
      const email = el.querySelector('#user-email').value.trim().toLowerCase();
      const role = el.querySelector('#user-role').value;
      if (!email.endsWith('@ingevec.cl')) { toast('El correo debe ser @ingevec.cl', 'warning'); return; }
      await DB.setRole(email, role);
      toast('Usuario agregado', 'success');
      renderUsuarios();
    });
    el.querySelectorAll('.user-del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`¿Quitar el acceso de ${b.dataset.email}?`)) return;
      await DB.deleteRole(b.dataset.email);
      toast('Usuario eliminado', 'danger');
      renderUsuarios();
    }));
  }

  // ------------------------------------------------------------------ Helpers UI
  // Sin botón de acceso directo a Importar: esa vista solo se llega por el menú lateral,
  // a propósito (el usuario no quiere el atajo repetido en cada pantalla vacía).
  function emptyState(title, sub) {
    return `<div class="empty-state"><div class="empty-icon"><i class="bi bi-inbox"></i></div>
      <h5>${PF.esc(title)}</h5><p>${PF.esc(sub)}</p></div>`;
  }

  // ------------------------------------------------------------------ Auth
  // true en modo local (sin login, dueño de sus propios datos) o si el rol
  // asignado en Firestore es 'admin'. Se usa para mostrar/ocultar los
  // controles de escritura (importar, caja del banco, configuración, alta/
  // edición/borrado de proyecto, corrección de grupoObra) — la app solo
  // esconde los botones; la app.js/data.js del lector le pega igual a
  // Firestore si intenta saltarse la UI, pero ahí las reglas de seguridad lo
  // rechazan (ver firestore.rules), así que la protección real no depende
  // de este helper.
  function isAdmin() {
    return state.role === 'editor' || state.role === 'dueño';
  }
  // Dueño: además de todo lo que puede un editor, administra quién es editor/lector desde la
  // pantalla "Usuarios" — promover a alguien a "dueño" queda fuera de la app a propósito
  // (ver firestore.rules), así que este rol nunca se asigna desde la UI.
  function isOwner() {
    return state.role === 'dueño';
  }

  function setupAuthUI() {
    const overlay = document.getElementById('login-overlay');
    const noAccess = document.getElementById('no-access-overlay');
    const shell = document.getElementById('app-shell');
    const showLogin = () => { overlay.classList.remove('d-none'); noAccess.classList.add('d-none'); shell.style.display = 'none'; };
    const showNoAccess = (email) => { noAccess.classList.remove('d-none'); overlay.classList.add('d-none'); shell.style.display = 'none'; document.getElementById('no-access-email').textContent = email; };
    const showApp = () => { overlay.classList.add('d-none'); noAccess.classList.add('d-none'); shell.style.display = 'flex'; };

    const errBox = document.getElementById('login-error');
    const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('d-none'); };

    const { auth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } = window.__fb;

    onAuthStateChanged(auth, async (user) => {
      if (!user) { state.user = null; state.role = null; showLogin(); return; }

      const dom = window.ALLOWED_EMAIL_DOMAIN;
      if (dom && !(user.email || '').toLowerCase().endsWith('@' + dom)) {
        showErr('Solo cuentas @' + dom); await signOut(auth); showLogin(); return;
      }

      const role = await DB.getRole(user.email);
      if (!role) { showNoAccess(user.email); return; }

      state.user = user;
      state.role = role;
      document.getElementById('user-box').classList.remove('d-none');
      document.getElementById('user-email').textContent = user.email;
      showApp();
      await DB.ensureSeed();
      await loadAll(); showView('dashboard');
    });

    document.getElementById('login-google').addEventListener('click', async () => {
      try {
        const provider = new GoogleAuthProvider();
        if (window.ALLOWED_EMAIL_DOMAIN) provider.setCustomParameters({ hd: window.ALLOWED_EMAIL_DOMAIN });
        await signInWithPopup(auth, provider);
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));
    document.getElementById('no-access-logout').addEventListener('click', () => signOut(auth));
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
      state.role = 'admin';
      await loadAll();
      showView('dashboard');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

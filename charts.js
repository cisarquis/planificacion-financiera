// ============================================================================
// charts.js — Helpers de gráficos
// Expone window.PFCharts. Los gráficos de "Por categoría" y "Resumen Directorio" usan Chart.js
// (registro para destruir antes de recrear); los de "Consolidado" (svgCajaAcumulada, svgFlujoNeto)
// y las sparklines de "Flujo de Caja" son SVG a mano (funciones puras que devuelven markup),
// para lograr el diseño pixel-perfect del handoff (banda de riesgo, callout, barras divergentes).
// ============================================================================
(function () {
  const registry = {};

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }

  function ctx(id) {
    const el = document.getElementById(id);
    return el ? el.getContext('2d') : null;
  }

  // Formato corto de eje/tooltip (usa PF.fmtMoney si existe).
  function fmt(v) {
    return (window.PF && PF.fmtNum) ? PF.fmtNum(v) : Math.round(v).toLocaleString('es-CL');
  }

  const COLORS = {
    proy: '#2f6fed',
    real: '#17233b',
    ingreso: '#1f9d63',
    egreso: '#e05353',
    palette: ['#2f6fed', '#1f9d63', '#e0953a', '#8b5cf6', '#e05353', '#0ea5b7', '#6b7688'],
  };

  // Barras apiladas por categoría (una serie por categoría).
  function stackedByCategoria(canvasId, labels, series) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    registry[canvasId] = new Chart(c, {
      type: 'bar',
      data: {
        labels,
        datasets: series.map((s, i) => ({
          label: s.nombre, data: s.data,
          backgroundColor: COLORS.palette[i % COLORS.palette.length],
        })),
      },
      options: Object.assign(baseOpts(), {
        scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: fmt } } },
      }),
    });
  }

  // Dona: participación por categoría (valor absoluto de aportes).
  function doughnutCategorias(canvasId, labels, valores) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    registry[canvasId] = new Chart(c, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: valores, backgroundColor: COLORS.palette }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
    });
  }

  // Línea "Caja acumulada" de Resumen Directorio: línea de cero de referencia + punto mínimo
  // resaltado; la serie de Presupuesto se omite si viene toda en 0 (nada que comparar todavía).
  function lineCajaAcumulada(canvasId, labels, acumActual, acumPpto, minIdx) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    const hasPpto = (acumPpto || []).some((v) => v !== 0);
    const pointRadius = acumActual.map((_, i) => (i === minIdx ? 5.5 : 3.4));
    const pointBg = acumActual.map((_, i) => (i === minIdx ? '#dc2626' : '#fff'));
    const pointBorder = acumActual.map((_, i) => (i === minIdx ? '#dc2626' : '#2563eb'));
    const datasets = [
      { label: 'Cero', data: labels.map(() => 0), borderColor: '#cbd5e1', borderWidth: 1.5, pointRadius: 0, borderDash: [] },
      { label: 'Caja acumulada', data: acumActual, borderColor: '#2563eb',
        backgroundColor: 'rgba(59,130,246,.15)', fill: true, tension: .15, borderWidth: 2.8,
        pointRadius, pointBackgroundColor: pointBg, pointBorderColor: pointBorder, pointBorderWidth: 2 },
    ];
    if (hasPpto) {
      datasets.push({ label: 'Presupuesto', data: acumPpto, borderColor: '#94a3b8', borderDash: [5, 4],
        fill: false, tension: .15, pointRadius: 3, borderWidth: 2 });
    }
    const opts = baseOpts();
    opts.animation = false;
    opts.plugins.legend.labels.filter = (item) => item.text !== 'Cero';
    opts.plugins.tooltip.filter = (item) => item.dataset.label !== 'Cero';
    registry[canvasId] = new Chart(c, { type: 'line', data: { labels, datasets }, options: opts });
    return registry[canvasId];
  }

  // Combo barras + líneas: Inversión (flujo de obra) Actual vs Presupuesto, por período y acumulado.
  function comboInversionVsPpto(canvasId, labels, actual, ppto, actualAcum, pptoAcum) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    registry[canvasId] = new Chart(c, {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Inversión Proyectada', data: actual, backgroundColor: '#0f172a' },
          { type: 'bar', label: 'Inversión Ppto', data: ppto, backgroundColor: '#38bdf8' },
          { type: 'line', label: 'Inversión Proyectada Acum.', data: actualAcum, borderColor: '#1e3a8a',
            tension: .2, pointRadius: 3, borderWidth: 2 },
          { type: 'line', label: 'Inversión Ppto Acum.', data: pptoAcum, borderColor: '#7dd3fc',
            tension: .2, pointRadius: 3, borderWidth: 2 },
        ],
      },
      options: baseOpts(),
    });
  }

  // Redondea hacia arriba al múltiplo "lindo" (1/2/5/10 × 10^n) más cercano — techo de eje Y.
  function niceCeil(v) {
    if (!(v > 0)) return 1000;
    const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
    const residual = v / magnitude;
    const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  // Cada cuántas etiquetas de mes mostrar una, para no amontonar texto con horizontes largos.
  function labelStep(n) {
    return n > 15 ? Math.ceil(n / 12) : 1;
  }

  function fmtK(v) {
    return Math.round(v / 1000) + 'k';
  }

  // Gráfico SVG "Caja acumulada: proyectada vs. real" (banda de riesgo + umbral + callout del mínimo).
  // labels/proj alineados por índice; real puede tener null en los meses sin dato (se corta la línea).
  function svgCajaAcumulada(labels, proj, real, umbral) {
    const n = proj.length;
    if (!n) return '';
    const W = 780, H = 300, padL = 62, padR = 18, padT = 20, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const top = niceCeil(Math.max(...proj, umbral || 0, 1) * 1.05);
    const x = (i) => padL + (i + 0.5) * (plotW / n);
    const y = (v) => padT + plotH * (1 - v / top);

    const pts = proj.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ' L' + pts[n - 1][0].toFixed(1) + ' ' + y(0).toFixed(1) + ' L' + pts[0][0].toFixed(1) + ' ' + y(0).toFixed(1) + ' Z';

    let realLine = '', drawing = false;
    real.forEach((v, i) => {
      if (v == null) { drawing = false; return; }
      realLine += (drawing ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
      drawing = true;
    });

    const minVal = Math.min(...proj);
    const minIdx = proj.indexOf(minVal);
    const umbralY = y(umbral || 0);

    const step = labelStep(n);
    const monthLabelY = H - padB + 22;
    let monthLabels = '';
    labels.forEach((lab, i) => {
      if (i % step !== 0) return;
      const isMin = i === minIdx;
      monthLabels += `<text x="${x(i).toFixed(1)}" y="${monthLabelY}" text-anchor="middle" font-size="10.5" fill="${isMin ? '#b91c1c' : '#64748b'}" font-weight="${isMin ? 700 : 600}">${PF.esc(lab)}</text>`;
    });

    let gridlines = '', gridLabels = '';
    for (let g = 0; g <= 4; g++) {
      const v = top * g / 4, gy = y(v);
      gridlines += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + plotW}" y2="${gy.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"></line>`;
      gridLabels += `<text x="${padL - 10}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#94a3b8" font-weight="600">${PF.fmtNum(v)}</text>`;
    }

    const dots = pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#fff" stroke="#2563eb" stroke-width="2"></circle>`).join('');

    const calloutL = Math.max(4, Math.min(x(minIdx) - 80, padL + plotW - 160));
    const calloutT = Math.max(4, y(minVal) - 52);

    return `<div class="chart-svg-wrap">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block; width:100%">
        <defs><linearGradient id="cajaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02" />
        </linearGradient></defs>
        <rect x="${padL}" y="${umbralY.toFixed(1)}" width="${plotW}" height="${(y(0) - umbralY).toFixed(1)}" fill="#fee2e2" opacity="0.55"></rect>
        ${gridlines}${gridLabels}
        <line x1="${padL}" y1="${umbralY.toFixed(1)}" x2="${padL + plotW}" y2="${umbralY.toFixed(1)}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 4"></line>
        <text x="${padL + plotW}" y="${(umbralY - 6).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#b91c1c" font-weight="700">umbral de alerta</text>
        <path d="${area}" fill="url(#cajaFill)"></path>
        <path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"></path>
        ${realLine ? `<path d="${realLine.trim()}" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-dasharray="6 4" stroke-linecap="round"></path>` : ''}
        ${dots}
        <circle cx="${x(minIdx).toFixed(1)}" cy="${y(minVal).toFixed(1)}" r="5.5" fill="#dc2626" stroke="#fff" stroke-width="2"></circle>
        ${monthLabels}
      </svg>
      <div style="position:absolute; left:${calloutL.toFixed(1)}px; top:${calloutT.toFixed(1)}px; background:#0f172a; border-radius:8px; padding:7px 11px; box-shadow:var(--pf-shadow-callout)">
        <div style="font-size:11px; font-weight:700; color:#fff; white-space:nowrap">mínimo ${PF.fmtNum(minVal)} UF</div>
        <div style="font-size:10.5px; color:#94a3b8; white-space:nowrap; margin-top:1px">${PF.esc(labels[minIdx])}</div>
      </div>
    </div>`;
  }

  // Gráfico SVG "Flujo neto mensual" — barras divergentes (aportes bajo el eje, devoluciones sobre).
  function svgFlujoNeto(labels, net) {
    const n = net.length;
    if (!n) return '';
    const W = 780, H = 220, padL = 62, padR = 18, padT = 26, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxPos = Math.max(0, ...net) || 1000;
    const maxNeg = Math.max(0, ...net.map((v) => -v)) || 1000;
    const zeroY = padT + plotH * maxPos / (maxPos + maxNeg);
    const bw = (plotW / n) * 0.5;

    let bars = '', valueLabels = '';
    net.forEach((v, i) => {
      const cx = padL + (i + 0.5) * (plotW / n);
      const h = Math.abs(v) / (maxPos + maxNeg) * plotH;
      const pos = v >= 0;
      const barY = pos ? zeroY - h : zeroY;
      const fill = pos ? '#16a34a' : '#dc2626';
      bars += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${barY.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${fill}"></rect>`;
      const labelY = pos ? barY - 6 : barY + h + 12;
      valueLabels += `<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="10" fill="${fill}" font-weight="700">${fmtK(v)}</text>`;
    });

    const step = labelStep(n);
    const monthLabelY = H - padB + 20;
    let monthLabels = '';
    labels.forEach((lab, i) => {
      if (i % step !== 0) return;
      monthLabels += `<text x="${(padL + (i + 0.5) * (plotW / n)).toFixed(1)}" y="${monthLabelY}" text-anchor="middle" font-size="10.5" fill="#64748b" font-weight="600">${PF.esc(lab)}</text>`;
    });

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block; max-width:100%">
      ${bars}
      <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${padL + plotW}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-width="1.5"></line>
      ${valueLabels}${monthLabels}
    </svg>`;
  }

  // Sparkline SVG 58×22 para una fila de la tabla de Flujo de Caja.
  function sparkline(values) {
    const n = values.length;
    if (!n) return '';
    const mx = Math.max(...values.map(Math.abs)) || 1;
    const sw = 58 / n;
    const gap = Math.min(1.4, sw * 0.25);
    const w = Math.max(0.4, sw - gap);
    let bars = '';
    values.forEach((v, i) => {
      const h = Math.max(1.5, Math.abs(v) / mx * 9);
      const yPos = v >= 0 ? 11 - h : 11;
      const fill = v >= 0 ? '#4ade80' : '#f87171';
      bars += `<rect x="${(i * sw + gap / 2).toFixed(1)}" y="${yPos.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${fill}"></rect>`;
    });
    return `<svg width="58" height="22" viewBox="0 0 58 22" style="display:inline-block; vertical-align:middle">${bars}<line x1="0" y1="11" x2="58" y2="11" stroke="#e2e8f0" stroke-width="1"></line></svg>`;
  }

  function baseOpts() {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${fmt(it.parsed.y)}` } },
      },
      scales: { y: { ticks: { callback: fmt } } },
    };
  }

  window.PFCharts = {
    destroy, stackedByCategoria, doughnutCategorias, comboInversionVsPpto,
    lineCajaAcumulada, svgCajaAcumulada, svgFlujoNeto, sparkline, COLORS,
  };
})();

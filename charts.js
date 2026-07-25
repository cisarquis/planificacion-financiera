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

  // Formato corto de eje/tooltip (usa PF.fmtNum si existe; negativos entre paréntesis).
  function fmt(v) {
    if (window.PF && PF.fmtNum) return PF.fmtNum(v);
    const r = Math.round(v);
    const s = Math.abs(r).toLocaleString('es-CL');
    return r < 0 ? '(' + s + ')' : s;
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

  // Barras agrupadas Actual vs Ppto por año, con el valor de cada barra como etiqueta
  // (plugin inline, sin dependencias externas) — "Inversión en obras del período".
  function barInversionPeriodo(canvasId, labels, actual, ppto) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    const dataLabelsPlugin = {
      id: 'pfBarLabels',
      afterDatasetsDraw(chart) {
        const g = chart.ctx;
        chart.data.datasets.forEach((ds, dsIdx) => {
          chart.getDatasetMeta(dsIdx).data.forEach((bar, i) => {
            const v = ds.data[i];
            if (v == null) return;
            g.save();
            g.font = '600 11px sans-serif';
            g.fillStyle = dsIdx === 0 ? '#1d4ed8' : '#64748b';
            g.textAlign = 'center';
            g.fillText(fmt(v), bar.x, v < 0 ? bar.y + 16 : bar.y - 6);
            g.restore();
          });
        });
      },
    };
    registry[canvasId] = new Chart(c, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Actual', data: actual, backgroundColor: '#2563eb', borderRadius: 3, maxBarThickness: 46 },
          { label: 'Presupuesto', data: ppto, backgroundColor: '#dbe3ee', borderRadius: 3, maxBarThickness: 46 },
        ],
      },
      options: Object.assign(baseOpts(), {
        plugins: Object.assign({}, baseOpts().plugins, { legend: { display: false } }),
      }),
      plugins: [dataLabelsPlugin],
    });
  }

  // Línea "Inversión acumulada" Actual (sólida) vs Ppto (punteada), con el área entre
  // ambas rellena (Chart.js fill nativo, sin plugin) — "sobre-inversión vs. PPTO".
  function lineInversionAcumulada(canvasId, labels, actualAcum, pptoAcum) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    const datasets = [
      { label: 'PPTO', data: pptoAcum, borderColor: '#94a3b8', borderDash: [5, 4],
        fill: false, tension: .15, pointRadius: 3, borderWidth: 2 },
      { label: 'Actual', data: actualAcum, borderColor: '#2563eb', backgroundColor: 'rgba(245,158,11,.18)',
        fill: 0, tension: .15, pointRadius: 4, pointBackgroundColor: '#fff', pointBorderColor: '#2563eb',
        pointBorderWidth: 2, borderWidth: 2.8 },
    ];
    const opts = baseOpts();
    opts.animation = false;
    opts.plugins.legend.display = false;
    // La brecha (actual vs. ppto) se muestra solo al pasar el mouse, dentro del tooltip
    // nativo de Chart.js — nada queda dibujado fijo sobre el gráfico tapando la línea.
    opts.plugins.tooltip.callbacks.label = (it) => `${it.dataset.label}: ${fmt(it.parsed.y)} UF`;
    opts.plugins.tooltip.callbacks.afterBody = (items) => {
      if (!items.length) return [];
      const idx = items[0].dataIndex;
      const gap = Math.abs(actualAcum[idx]) - Math.abs(pptoAcum[idx]);
      if (gap === 0) return [];
      return [`${fmt(Math.abs(gap))} UF ${gap > 0 ? 'sobre' : 'bajo'} el PPTO`];
    };
    registry[canvasId] = new Chart(c, { type: 'line', data: { labels, datasets }, options: opts });
    return registry[canvasId];
  }

  // Redondea hacia arriba al múltiplo "lindo" (1/2/5/10 × 10^n) más cercano — techo de eje Y.
  function niceCeil(v) {
    if (!(v > 0)) return 1000;
    const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
    const residual = v / magnitude;
    const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  // Eje X por año: 1 etiqueta centrada por año + separador vertical entre años (en vez de
  // una etiqueta por mes/trimestre, ilegible con horizontes largos). `years[i]` = "2026" etc.,
  // paralelo a los datos; `xOf(i)` ya calculado por el chart que llama a este helper.
  function yearAxisSvg(years, xOf, n, plotTop, plotBottom, labelY) {
    let out = '';
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || years[i] !== years[start]) {
        if (start > 0) {
          const sepX = ((xOf(start - 1) + xOf(start)) / 2).toFixed(1);
          out += `<line x1="${sepX}" y1="${plotTop}" x2="${sepX}" y2="${plotBottom}" stroke="#e2e8f0" stroke-width="1"></line>`;
        }
        const midX = ((xOf(start) + xOf(i - 1)) / 2).toFixed(1);
        out += `<text x="${midX}" y="${labelY}" text-anchor="middle" font-size="12" fill="#475569" font-weight="700">${PF.esc(years[start])}</text>`;
        start = i;
      }
    }
    return out;
  }

  // Gráfico SVG "Caja acumulada: proyectada vs. real" — banda roja = zona negativa (bajo cero),
  // callout del mínimo, eje X por año. labels/proj/years alineados por índice; real puede tener
  // null en los meses sin dato (se corta la línea).
  function svgCajaAcumulada(labels, proj, real, years) {
    const n = proj.length;
    if (!n) return '';
    const W = 1340, H = 320, padL = 68, padR = 18, padT = 20, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const top = niceCeil(Math.max(...proj, 1) * 1.05);
    const minRaw = Math.min(...proj, 0);
    const bottom = minRaw < 0 ? -niceCeil(-minRaw * 1.05) : 0;
    const x = (i) => padL + (i + 0.5) * (plotW / n);
    const y = (v) => padT + plotH * (top - v) / (top - bottom);

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

    const yearLabels = yearAxisSvg(years, x, n, padT, padT + plotH, H - padB + 20);

    const gridVals = bottom < 0 ? [bottom, bottom / 2, 0, top / 2, top] : [0, top / 4, top / 2, top * 3 / 4, top];
    let gridlines = '', gridLabels = '';
    gridVals.forEach((v) => {
      const gy = y(v);
      const isZero = Math.abs(v) < 1e-6;
      gridlines += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + plotW}" y2="${gy.toFixed(1)}" stroke="${isZero ? '#94a3b8' : '#e2e8f0'}" stroke-width="${isZero ? 1.5 : 1}"></line>`;
      gridLabels += `<text x="${padL - 10}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#94a3b8" font-weight="600">${PF.fmtNum(v)}</text>`;
    });

    const dots = pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#fff" stroke="#2563eb" stroke-width="2"></circle>`).join('');

    // Ningún callout queda dibujado por default — el detalle (valor + mes) solo aparece al
    // pasar el mouse, con un hit-circle invisible más grande (r=9) por punto, con data-tip-*
    // que app.js usa para armar el tooltip flotante. El mínimo, además, sigue con un punto
    // rojo siempre visible para no perder esa referencia de un vistazo.
    const hoverPts = pts.map((p, i) => {
      const isMin = i === minIdx && minVal < 0;
      const title = (isMin ? 'mínimo ' : '') + PF.fmtNum(proj[i]) + ' UF';
      return `<circle class="hover-pt" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9" fill="transparent"
        data-tip-title="${PF.esc(title)}" data-tip-sub="${PF.esc(labels[i])}" data-tip-tone="${isMin ? 'dark' : 'light'}"></circle>`;
    }).join('');

    return `<div class="chart-svg-wrap">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block; width:100%">
        <defs><linearGradient id="cajaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02" />
        </linearGradient></defs>
        ${bottom < 0 ? `<rect x="${padL}" y="${y(0).toFixed(1)}" width="${plotW}" height="${(y(bottom) - y(0)).toFixed(1)}" fill="#fee2e2" opacity="0.55"></rect>` : ''}
        ${gridlines}${gridLabels}
        <path d="${area}" fill="url(#cajaFill)"></path>
        <path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"></path>
        ${realLine ? `<path d="${realLine.trim()}" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-dasharray="6 4" stroke-linecap="round"></path>` : ''}
        ${dots}
        ${minVal < 0 ? `<circle cx="${x(minIdx).toFixed(1)}" cy="${y(minVal).toFixed(1)}" r="5.5" fill="#dc2626" stroke="#fff" stroke-width="2"></circle>` : ''}
        ${yearLabels}
        ${hoverPts}
      </svg>
    </div>`;
  }

  // Gráfico SVG "Flujo neto por trimestre" — barras divergentes (aportes bajo el eje,
  // devoluciones sobre), eje X por año, y solo 2 callouts (mínimo y máximo) en vez de una
  // etiqueta por barra.
  function svgFlujoNeto(labels, net, years) {
    const n = net.length;
    if (!n) return '';
    const W = 1340, H = 240, padL = 68, padR = 18, padT = 30, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxPos = Math.max(0, ...net) || 1000;
    const maxNeg = Math.max(0, ...net.map((v) => -v)) || 1000;
    const zeroY = padT + plotH * maxPos / (maxPos + maxNeg);
    const bw = (plotW / n) * 0.55;
    const x = (i) => padL + (i + 0.5) * (plotW / n);

    let bars = '', hoverBars = '';
    net.forEach((v, i) => {
      const cx = x(i);
      const h = Math.abs(v) / (maxPos + maxNeg) * plotH;
      const pos = v >= 0;
      const barY = pos ? zeroY - h : zeroY;
      const fill = pos ? '#16a34a' : '#dc2626';
      bars += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${barY.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="3" fill="${fill}"></rect>`;
      // Hit-rect invisible más ancho que la barra (fácil de hoverear) con el detalle del
      // valor de esta barra — ningún callout se dibuja por default, solo al pasar el mouse.
      hoverBars += `<rect class="hover-pt" x="${(cx - (plotW / n) / 2).toFixed(1)}" y="${padT}" width="${(plotW / n).toFixed(1)}" height="${plotH.toFixed(1)}" fill="transparent"
        data-tip-title="${v >= 0 ? '+' : ''}${PF.fmtNum(v)} UF" data-tip-sub="${PF.esc(labels[i])}" data-tip-tone="${v < 0 ? 'dark' : 'light'}"></rect>`;
    });

    const yearLabels = yearAxisSvg(years, x, n, padT, padT + plotH, H - padB + 20);

    return `<div class="chart-svg-wrap">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block; width:100%">
        ${bars}
        <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${padL + plotW}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-width="1.5"></line>
        ${yearLabels}
        ${hoverBars}
      </svg>
    </div>`;
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
    destroy, stackedByCategoria, doughnutCategorias, barInversionPeriodo, lineInversionAcumulada,
    lineCajaAcumulada, svgCajaAcumulada, svgFlujoNeto, sparkline, COLORS,
  };
})();

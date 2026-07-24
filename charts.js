// ============================================================================
// charts.js — Helpers de Chart.js
// Expone window.PFCharts. Mantiene un registro para destruir antes de recrear.
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

  // Línea: caja proyectada acumulada vs caja real.
  function lineProjVsReal(canvasId, labels, proyectada, real) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    registry[canvasId] = new Chart(c, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Caja proyectada', data: proyectada, borderColor: COLORS.proy,
            backgroundColor: 'rgba(47,111,237,.08)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
          { label: 'Caja real', data: real, borderColor: COLORS.real, borderDash: [5, 4],
            fill: false, tension: .1, pointRadius: 3, borderWidth: 2, spanGaps: true },
        ],
      },
      options: baseOpts(),
    });
  }

  // Barras: flujo neto mensual (verde ingreso / rojo egreso).
  function barFlujoMensual(canvasId, labels, netos) {
    destroy(canvasId);
    const c = ctx(canvasId); if (!c) return;
    registry[canvasId] = new Chart(c, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Flujo neto',
          data: netos,
          backgroundColor: netos.map((v) => (v >= 0 ? COLORS.ingreso : COLORS.egreso)),
        }],
      },
      options: baseOpts(),
    });
  }

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

  window.PFCharts = { destroy, lineProjVsReal, barFlujoMensual, stackedByCategoria, doughnutCategorias, COLORS };
})();

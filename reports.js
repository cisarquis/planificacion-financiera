// ============================================================================
// reports.js — Exportación a Excel (SheetJS) y PDF (jsPDF + autotable)
// Expone window.PFReports. Recibe datos ya calculados desde app.js.
// ============================================================================
(function () {
  // Exporta una matriz [ [fila], ... ] a un .xlsx con una hoja.
  function exportExcel(filename, sheetName, aoa) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    XLSX.writeFile(wb, filename);
  }

  // Exporta varias hojas: sheets = [{ name, aoa }]
  function exportExcelMulti(filename, sheets) {
    const wb = XLSX.utils.book_new();
    sheets.forEach((s) => {
      const ws = XLSX.utils.aoa_to_sheet(s.aoa);
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    });
    XLSX.writeFile(wb, filename);
  }

  // PDF con título, KPIs y una tabla. Opcionalmente incrusta un chart (canvas).
  function exportPDF(opts) {
    const { title, subtitle, kpis, head, body, chartCanvasId } = opts;
    const jsPDF = window.jspdf.jsPDF;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    let y = 40;

    doc.setFontSize(16); doc.setTextColor(23, 35, 59);
    doc.text(title, 40, y); y += 18;
    if (subtitle) { doc.setFontSize(10); doc.setTextColor(120); doc.text(subtitle, 40, y); y += 16; }

    if (kpis && kpis.length) {
      doc.setFontSize(9); doc.setTextColor(90);
      const line = kpis.map((k) => `${k.label}: ${k.value}`).join('     ');
      doc.text(line, 40, y); y += 14;
    }

    if (chartCanvasId) {
      const canvas = document.getElementById(chartCanvasId);
      if (canvas) {
        try {
          const img = canvas.toDataURL('image/png', 1.0);
          const imgW = W - 80, imgH = imgW * (canvas.height / canvas.width);
          const h = Math.min(imgH, 220);
          doc.addImage(img, 'PNG', 40, y, imgW, h); y += h + 16;
        } catch (e) { /* ignora si el canvas no está disponible */ }
      }
    }

    if (head && body) {
      doc.autoTable({
        head: [head], body, startY: y, margin: { left: 40, right: 40 },
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [47, 111, 237] },
      });
    }
    doc.save((title || 'reporte').replace(/[^\w\-]+/g, '_') + '.pdf');
  }

  window.PFReports = { exportExcel, exportExcelMulti, exportPDF };
})();

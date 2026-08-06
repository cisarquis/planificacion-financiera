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

  // PDF con título, KPIs (en tarjetas), y una o más tablas. Opcionalmente incrusta un chart
  // (canvas). `kpis` acepta un color por tarjeta (`accent`, hex) para que destaque visualmente
  // en vez de ser una sola línea de texto — pensado para un resumen "de un vistazo" (Directorio).
  // `sections` (opcional) permite varias tablas con su propio título, cada una en su bloque; si
  // no se pasa, se usa el `head`/`body` de nivel superior como sección única (compatibilidad).
  function exportPDF(opts) {
    const { title, subtitle, kpis, head, body, chartCanvasId, sections } = opts;
    const jsPDF = window.jspdf.jsPDF;
    const orientation = opts.orientation || 'landscape';
    const doc = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const marginL = 40, marginR = 40;
    let y = 42;

    doc.setFontSize(17); doc.setTextColor(23, 35, 59); doc.setFont(undefined, 'bold');
    doc.text(title, marginL, y); y += 18;
    doc.setFont(undefined, 'normal');
    if (subtitle) { doc.setFontSize(10); doc.setTextColor(120); doc.text(subtitle, marginL, y); y += 18; }
    else { y += 4; }

    if (kpis && kpis.length) {
      const gap = 10, cardW = (W - marginL - marginR - gap * (kpis.length - 1)) / kpis.length, cardH = 46;
      kpis.forEach((k, i) => {
        const x = marginL + i * (cardW + gap);
        const accent = k.accent || '#2563eb';
        doc.setFillColor('#f8fafc'); doc.setDrawColor('#e2e8f0');
        doc.roundedRect(x, y, cardW, cardH, 4, 4, 'FD');
        doc.setFillColor(accent); doc.rect(x, y, 3, cardH, 'F');
        doc.setFontSize(8); doc.setTextColor(100);
        doc.text(String(k.label), x + 10, y + 16, { maxWidth: cardW - 16 });
        doc.setFontSize(14); doc.setTextColor(23, 35, 59); doc.setFont(undefined, 'bold');
        doc.text(String(k.value), x + 10, y + 34, { maxWidth: cardW - 16 });
        doc.setFont(undefined, 'normal');
      });
      y += cardH + 18;
    }

    if (chartCanvasId) {
      const canvas = document.getElementById(chartCanvasId);
      if (canvas) {
        try {
          const img = canvas.toDataURL('image/png', 1.0);
          const imgW = W - marginL - marginR, imgH = imgW * (canvas.height / canvas.width);
          const h = Math.min(imgH, 220);
          doc.addImage(img, 'PNG', marginL, y, imgW, h); y += h + 16;
        } catch (e) { /* ignora si el canvas no está disponible */ }
      }
    }

    const tableSections = sections && sections.length ? sections : (head && body ? [{ head, body }] : []);
    tableSections.forEach((s) => {
      if (y > H - 120) { doc.addPage(); y = 42; }
      if (s.heading) {
        doc.setFontSize(11); doc.setTextColor(23, 35, 59); doc.setFont(undefined, 'bold');
        doc.text(s.heading, marginL, y); y += 6;
        doc.setFont(undefined, 'normal');
      }
      doc.autoTable({
        head: [s.head], body: s.body, startY: y, margin: { left: marginL, right: marginR },
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [47, 111, 237] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
      });
      y = doc.lastAutoTable.finalY + 22;
    });

    doc.save((title || 'reporte').replace(/[^\w\-]+/g, '_') + '.pdf');
  }

  window.PFReports = { exportExcel, exportExcelMulti, exportPDF };
})();

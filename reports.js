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

  // PDF "de directorio": banner de título oscuro, banner de veredicto (opcional, coloreado por
  // tono), tarjetas de KPI, una o más tablas con encabezado de sección con barra de color, y pie
  // de página con fecha y "Página X de Y" en cada hoja. Pensado para leerse de un vistazo, no
  // para ser un volcado de datos.
  // `kpis` acepta un color por tarjeta (`accent`, hex). `sections` (opcional) permite varias
  // tablas con su propio título; si no se pasa, se usa `head`/`body` de nivel superior como
  // sección única (compatibilidad con llamadas previas). `verdict` = { text, tone } donde tone
  // es 'ok'|'warning'|'danger' (colores semáforo) o se omite para un banner neutro.
  function exportPDF(opts) {
    const { title, subtitle, kpis, head, body, chartCanvasId, sections, verdict, footerNote } = opts;
    const jsPDF = window.jspdf.jsPDF;
    const orientation = opts.orientation || 'landscape';
    const doc = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const marginL = 40, marginR = 40;

    // ---- Banner de título: barra oscura de ancho completo, título en blanco.
    const bannerH = subtitle ? 62 : 48;
    doc.setFillColor(23, 35, 59); doc.rect(0, 0, W, bannerH, 'F');
    doc.setFillColor(37, 99, 235); doc.rect(0, bannerH - 3, W, 3, 'F');
    doc.setFontSize(18); doc.setTextColor(255, 255, 255); doc.setFont(undefined, 'bold');
    doc.text(title, marginL, 32);
    doc.setFont(undefined, 'normal');
    if (subtitle) { doc.setFontSize(9.5); doc.setTextColor(203, 213, 225); doc.text(subtitle, marginL, 48); }
    let y = bannerH + 24;

    // ---- Banner de veredicto (opcional): mismo semáforo que usa la app en pantalla.
    if (verdict && verdict.text) {
      const tone = verdict.tone || 'neutral';
      const palettes = {
        ok: { bg: [220, 252, 231], fg: [21, 128, 61], accent: [22, 163, 74] },
        warning: { bg: [254, 243, 199], fg: [180, 83, 9], accent: [245, 158, 11] },
        danger: { bg: [254, 226, 226], fg: [185, 28, 28], accent: [220, 38, 38] },
        neutral: { bg: [241, 245, 249], fg: [51, 65, 85], accent: [100, 116, 139] },
      };
      const p = palettes[tone] || palettes.neutral;
      const boxH = 30;
      doc.setFillColor(p.bg[0], p.bg[1], p.bg[2]); doc.rect(marginL, y, W - marginL - marginR, boxH, 'F');
      doc.setFillColor(p.accent[0], p.accent[1], p.accent[2]); doc.rect(marginL, y, 3, boxH, 'F');
      doc.setFontSize(9.5); doc.setTextColor(p.fg[0], p.fg[1], p.fg[2]); doc.setFont(undefined, 'bold');
      doc.text(verdict.text, marginL + 12, y + boxH / 2 + 3.5, { maxWidth: W - marginL - marginR - 24 });
      doc.setFont(undefined, 'normal');
      y += boxH + 18;
    }

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
      y += cardH + 20;
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
      if (y > H - 130) { doc.addPage(); y = 42; }
      if (s.heading) {
        doc.setFillColor(37, 99, 235); doc.rect(marginL, y - 9, 3, 13, 'F');
        doc.setFontSize(11.5); doc.setTextColor(23, 35, 59); doc.setFont(undefined, 'bold');
        doc.text(s.heading, marginL + 9, y); y += 4;
        doc.setFont(undefined, 'normal');
        if (s.note) { doc.setFontSize(8); doc.setTextColor(140); doc.text(s.note, marginL + 9, y + 9); y += 12; }
        y += 6;
      }
      doc.autoTable({
        head: [s.head], body: s.body, startY: y, margin: { left: marginL, right: marginR, bottom: 46 },
        styles: { fontSize: 8.5, cellPadding: 5, textColor: [30, 41, 59] },
        headStyles: { fillColor: [23, 35, 59], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: s.columnStyles || {},
      });
      y = doc.lastAutoTable.finalY + 24;
    });

    // ---- Pie de página en cada hoja: nota izquierda + "Página X de Y" a la derecha.
    const pageCount = doc.internal.getNumberOfPages();
    const generatedAt = new Date().toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.5);
      doc.line(marginL, H - 30, W - marginR, H - 30);
      doc.setFontSize(7.5); doc.setTextColor(148, 163, 184); doc.setFont(undefined, 'normal');
      doc.text(footerNote || `Generado ${generatedAt}`, marginL, H - 18);
      doc.text(`Página ${i} de ${pageCount}`, W - marginR, H - 18, { align: 'right' });
    }

    doc.save((title || 'reporte').replace(/[^\w\-]+/g, '_') + '.pdf');
  }

  window.PFReports = { exportExcel, exportExcelMulti, exportPDF };
})();

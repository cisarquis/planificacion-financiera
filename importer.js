// ============================================================================
// importer.js — Motor de importación de Excel (SheetJS)
// Expone window.PFImporter con utilidades puras de parseo/detección/extracción.
// La UI del asistente (wizard) vive en app.js (renderImportar), que llama aquí.
// ============================================================================
(function () {
  // Lee el archivo y devuelve el workbook + nombres de hojas.
  async function parseFile(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { cellDates: true });
    return { wb, sheetNames: wb.SheetNames };
  }

  // Convierte una hoja en grilla (array de arrays), respetando huecos.
  function sheetToGrid(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  }

  // ¿La celda parece un mes/fecha?
  function cellToDate(cell) {
    if (cell instanceof Date && !isNaN(cell)) return cell;
    if (typeof cell === 'number' && cell > 20000 && cell < 80000) {
      // Serial de Excel (epoch 1899-12-30).
      return new Date(Date.UTC(1899, 11, 30) + Math.round(cell) * 86400000);
    }
    if (typeof cell === 'string') {
      const s = cell.trim();
      // dd-mm-yyyy, mm/yyyy, yyyy-mm, etc.
      const m = s.match(/^(\d{1,2})[\/\-.](\d{4})$/); // mm/yyyy
      if (m) return new Date(Date.UTC(+m[2], +m[1] - 1, 1));
      const m2 = s.match(/^(\d{4})[\/\-.](\d{1,2})$/); // yyyy-mm
      if (m2) return new Date(Date.UTC(+m2[1], +m2[2] - 1, 1));
      const d = new Date(s);
      if (!isNaN(d) && s.length >= 6) return d;
    }
    return null;
  }

  function dateToMonthKey(d) {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  // Detecta automáticamente la fila de meses y la fila de flujo.
  function detectRows(grid) {
    let monthRow = -1, bestDates = 1;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      let count = 0;
      for (const cell of row) if (cellToDate(cell)) count++;
      if (count > bestDates) { bestDates = count; monthRow = r; }
    }

    // Fila de flujo: rótulo con "flujo" (evita totales de "acumulado"/"saldo").
    let flowRow = -1;
    const labelRe = /flujo/i;
    for (let r = 0; r < grid.length; r++) {
      if (r === monthRow) continue;
      const row = grid[r] || [];
      const label = String(row.find((c) => typeof c === 'string' && c.trim()) || '');
      if (labelRe.test(label) && !/acumulad|saldo/i.test(label)) { flowRow = r; break; }
    }
    // Fallback: primera fila numérica bajo la fila de meses.
    if (flowRow === -1 && monthRow >= 0) {
      for (let r = monthRow + 1; r < grid.length; r++) {
        const row = grid[r] || [];
        if (row.some((c) => typeof c === 'number')) { flowRow = r; break; }
      }
    }
    return { monthRow, flowRow };
  }

  // Rótulo legible de una fila (primera celda de texto).
  function rowLabel(grid, r) {
    if (r < 0 || r >= grid.length) return '';
    return String((grid[r] || []).find((c) => typeof c === 'string' && c.trim()) || `Fila ${r + 1}`);
  }

  // Construye el mapa { 'YYYY-MM': neto } a partir del mapeo elegido.
  //  opts = { monthRow, flowRows:[idx...], invert:bool }
  //  - Suma las filas de flujo elegidas por columna.
  //  - invert: multiplica por -1 (por si el signo viene al revés).
  function extractProjection(grid, opts) {
    const { monthRow, flowRows, invert } = opts;
    const monthsRowArr = grid[monthRow] || [];
    const sign = invert ? -1 : 1;
    const proyeccion = {};
    let total = 0, count = 0, minMonth = null, maxMonth = null;

    for (let col = 0; col < monthsRowArr.length; col++) {
      const d = cellToDate(monthsRowArr[col]);
      if (!d) continue;
      const key = dateToMonthKey(d);
      let val = 0, any = false;
      for (const fr of flowRows) {
        const cell = (grid[fr] || [])[col];
        if (typeof cell === 'number' && !isNaN(cell)) { val += cell; any = true; }
      }
      if (!any) continue;
      val = val * sign;
      // Si un mes se repite en columnas, se acumula.
      proyeccion[key] = (proyeccion[key] || 0) + val;
      total += val; count++;
      if (!minMonth || key < minMonth) minMonth = key;
      if (!maxMonth || key > maxMonth) maxMonth = key;
    }
    return { proyeccion, meta: { total, count, minMonth, maxMonth } };
  }

  window.PFImporter = {
    parseFile, sheetToGrid, cellToDate, dateToMonthKey,
    detectRows, rowLabel, extractProjection,
  };
})();

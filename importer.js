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

  // Normaliza texto para comparar nombres de hoja/categoría/proyecto de forma tolerante
  // (minúsculas, sin tildes, sin puntuación).
  function normalizeLabel(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Columnas de mes de la fila de encabezado de una hoja "maestro" (una hoja por categoría,
  // una fila por proyecto). Descarta columnas iniciales aisladas (salto > ~70 días a la
  // siguiente): son acumulados históricos previos, no meses secuenciales a importar.
  function monthColumns(grid, headerRow) {
    const row = grid[headerRow] || [];
    const cols = [];
    for (let c = 0; c < row.length; c++) {
      const d = cellToDate(row[c]);
      if (d) cols.push({ col: c, key: dateToMonthKey(d), time: d.getTime() });
    }
    cols.sort((a, b) => a.time - b.time);
    const GAP = 70 * 86400000;
    while (cols.length > 1 && (cols[1].time - cols[0].time) > GAP) cols.shift();
    return cols;
  }

  // Extrae { nombre, tipo, proyeccion } de cada fila de proyecto bajo la fila de encabezado.
  // Descarta filas sin nombre y filas sin ninguna celda numérica real en las columnas de mes
  // (esto filtra filas de título/rótulo repetidas, que no tienen números, sin descartar
  // proyectos con flujo en cero explícito).
  function extractMasterRows(grid, headerRow) {
    const cols = monthColumns(grid, headerRow);
    const rows = [];
    for (let r = headerRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const nombre = typeof row[0] === 'string' ? row[0].trim() : '';
      if (!nombre) continue;
      const tipo = typeof row[1] === 'string' ? row[1].trim() : '';
      const proyeccion = {};
      let any = false;
      cols.forEach(({ col, key }) => {
        const v = row[col];
        if (typeof v === 'number' && !isNaN(v)) { proyeccion[key] = (proyeccion[key] || 0) + v; any = true; }
      });
      if (!any) continue;
      rows.push({ nombre, tipo, proyeccion });
    }
    return { cols, rows };
  }

  // Reconoce encabezados de semestre en texto literal: "1S 2026", "2S2026", etc.
  function parseSemesterLabel(cell) {
    if (typeof cell !== 'string') return null;
    const m = cell.trim().match(/^([12])\s*s\.?\s*(\d{4})$/i);
    if (!m) return null;
    return { sem: +m[1], year: +m[2] };
  }

  // Fila con más celdas que matchean parseSemesterLabel (equivalente a detectRows, pero para
  // archivos de presupuesto semestral en vez de mensual).
  function detectSemesterHeaderRow(grid) {
    let best = -1, bestCount = 0;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      let count = 0;
      for (const cell of row) if (parseSemesterLabel(cell)) count++;
      if (count > bestCount) { bestCount = count; best = r; }
    }
    return best;
  }

  // Columnas de semestre de la fila de encabezado: cada una trae sus 6 meses (ene-jun / jul-dic).
  function semesterColumns(grid, headerRow) {
    const row = grid[headerRow] || [];
    const cols = [];
    for (let c = 0; c < row.length; c++) {
      const s = parseSemesterLabel(row[c]);
      if (!s) continue;
      const start = s.sem === 1 ? 1 : 7;
      const monthKeys = [];
      for (let m = start; m < start + 6; m++) monthKeys.push(s.year + '-' + String(m).padStart(2, '0'));
      cols.push({ col: c, monthKeys });
    }
    return cols;
  }

  // Busca, entre las primeras columnas, la que marca fila de proyecto real ("Sí"/"No"). Devuelve
  // -1 si el archivo no tiene esa columna (no se filtra ninguna fila en ese caso).
  function detectFlagColumn(grid, headerRow) {
    let best = -1, bestCount = 0;
    for (let c = 0; c < 4; c++) {
      let count = 0;
      for (let r = headerRow + 1; r < grid.length; r++) {
        const v = (grid[r] || [])[c];
        if (typeof v === 'string' && /^(s[ií]|no)$/i.test(v.trim())) count++;
      }
      if (count > bestCount) { bestCount = count; best = c; }
    }
    return bestCount > 0 ? best : -1;
  }

  // Extrae { nombre, presupuesto } de cada fila de proyecto real (columna de flag = "Sí", o sin
  // filtro si el archivo no trae esa columna). Reparte cada valor semestral en partes iguales
  // entre sus 6 meses — el archivo no da más precisión que eso.
  function extractPresupuestoRows(grid, headerRow, flagCol) {
    const cols = semesterColumns(grid, headerRow);
    const rows = [];
    for (let r = headerRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const nombre = typeof row[0] === 'string' ? row[0].trim() : '';
      if (!nombre) continue;
      if (flagCol >= 0 && !/^s[ií]$/i.test(String(row[flagCol] || '').trim())) continue;
      const presupuesto = {};
      let any = false;
      cols.forEach(({ col, monthKeys }) => {
        const v = row[col];
        if (typeof v !== 'number' || isNaN(v)) return;
        any = true;
        const share = v / monthKeys.length;
        monthKeys.forEach((k) => { presupuesto[k] = (presupuesto[k] || 0) + share; });
      });
      if (!any) continue;
      rows.push({ nombre, presupuesto });
    }
    return { cols, rows };
  }

  window.PFImporter = {
    parseFile, sheetToGrid, cellToDate, dateToMonthKey,
    detectRows, rowLabel, extractProjection,
    normalizeLabel, monthColumns, extractMasterRows,
    parseSemesterLabel, detectSemesterHeaderRow, semesterColumns, detectFlagColumn, extractPresupuestoRows,
  };
})();

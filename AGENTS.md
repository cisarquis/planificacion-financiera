# AGENTS.md — Planificación Financiera (Flujo de Caja Consolidado)

Proyecto **independiente**, sin relación con Mira (otra app del mismo usuario). No comparte carpeta,
repositorio ni proyecto Firebase con Mira.

## Qué es

App web para que Cristian (Ingevec) haga seguimiento del flujo de caja de todos sus proyectos
inmobiliarios: sube un Excel por proyecto cada mes (aportes/devoluciones), define una caja inicial,
y la app consolida la proyección por proyecto, por categoría y a nivel global, comparándola contra la
caja real del banco (ingresada mes a mes). Sirve también al área de finanzas para programar pagos
(ver egresos futuros).

**Categorías** (configurables desde la app, sembradas al primer uso, reflejan la estructura real de
carpetas del directorio): Inmobiliaria Ingevec, Inmobiliarias Asociadas, Inv. y Rentas,
Financiamiento/Dividendo e Impuestos, Otros. Las líneas corporativas (financiero corp, Bono F, etc.)
se cargan como proyectos dentro de "Financiamiento, Dividendo e Impuestos", no como categorías aparte.
`DB.ensureSeed()` (en `data.js`) asegura estas 5 por nombre en **cada** `init()`, no solo si la lista
está vacía — así, si un navegador quedó con categorías de una versión anterior, al recargar se agregan
las que falten sin duplicar ni tocar las que ya tienen proyectos. Configuración → Datos tiene además un
botón "Restablecer categorías por defecto" que borra las categorías sin proyectos asociados y llama a
`ensureSeed()`, para el caso en que sobren categorías viejas que haya que limpiar activamente.

## Stack

HTML/JS vanilla + Bootstrap 5.3.3 + Chart.js + SheetJS (xlsx) + jsPDF/autotable, todo vía CDN (sin
build step, sin `npm install` para producción). Persistencia: Firebase (Firestore v8 namespaced) o,
si `firebase-config.js` no tiene credenciales, **modo local** con `localStorage` (mismo código,
`data.js` abstrae ambos backends).

## Estructura

```
index.html            Login + shell (sidebar + secciones)
app.js                Orquestador: estado, navegación, cálculos, render de cada vista
data.js               Capa de datos (window.DB) — Firestore v8 o localStorage
importer.js           Parseo/mapeo/extracción de Excel (window.PFImporter)
charts.js             Helpers de gráficos (window.PFCharts): Chart.js (Por categoría, Resumen
                       Directorio) + SVG a mano (Consolidado, sparklines de Flujo de Caja)
reports.js            Exportación Excel/PDF (window.PFReports)
firebase-config.js     Config del proyecto Firebase PROPIO (null = modo local)
style.css             Estilos
.claude/launch.json   Preview local puerto 3300 (usa `npx serve .`)
```

## Modelo de datos (Firestore o localStorage, mismas claves)

```
config/global       { cajaInicial, mesInicial:'YYYY-MM', moneda:'UF'|'CLP', umbralAlerta }
categorias/{id}     { nombre, orden }
proyectos/{id}      { nombre, categoriaId, moneda, tipo, proyeccion:{'YYYY-MM':neto},
                      presupuesto:{'YYYY-MM':neto}, ultimaImportacion, ... }
cajaReal/{YYYY-MM}  { monto, nota }
importLog/{id}      { projId, fileName, sheet, meses, importedAt, byEmail }
```

**Signo:** en `proyeccion`, negativo = aporte (egreso de caja del proyecto), positivo = devolución
(ingreso). La caja proyectada acumulada = `cajaInicial + Σ flujo neto consolidado hasta el mes`.

**Presupuesto:** `presupuesto` tiene el mismo formato que `proyeccion`, pero es una línea base que se
carga **una sola vez** (vía el importador, eligiendo el destino "Presupuesto") y debe quedar fija —
`saveImport` en `app.js` pide confirmación antes de sobreescribirla si ya tiene meses cargados. Se usa
para comparar "cómo vamos" contra el presupuesto original en la vista **Resumen Directorio**.

## Formato de Excel esperado (confirmado con archivo real de ejemplo)

**Un proyecto por archivo** (modo "Un proyecto"): hoja tipo "Planificación Financiera", una fila con
los meses (fechas/series de Excel) y una fila "Flujo de Caja" con el neto mensual. El importador
(`importer.js`) es **flexible**: detecta automáticamente la fila de meses y la fila de flujo por
heurística, pero el usuario puede corregir el mapeo manualmente (útil si el formato cambia).

**Archivo maestro** (modo "Archivo maestro", el que se sube todos los meses en la práctica): un libro
con **una hoja por categoría** y, dentro de cada hoja, **una fila por proyecto** — columna A = nombre,
columna B = "Tipo" (sub-clasificación libre, ej. DS19/Núcleos/Bono/Hoteles, se guarda en
`proyecto.tipo` pero no se usa en cálculos), y desde la columna C en adelante una fecha por columna en
la fila de encabezado con el flujo mensual de cada proyecto. Suele traer una primera columna con una
fecha muy anterior y aislada (acumulado histórico previo) — `PFImporter.monthColumns` la descarta
automáticamente por el salto de fecha anormal a la siguiente columna; la caja de partida real se
entrega aparte vía `cajaInicial`/`mesInicial` (vista "Caja del banco"), no desde ese archivo. Como los
nombres de hoja no siempre calzan exacto con el nombre de la categoría, `guessCategoria` (`app.js`)
adivina por coincidencia normalizada (sin tildes/mayúsculas/puntuación) o solapamiento de palabras, y
el usuario confirma/corrige el mapeo antes de importar. El match proyecto-existente vs proyecto-nuevo
es por `categoriaId` + nombre normalizado.

**Presupuesto semestral** (modo "Presupuesto (semestral)"): una sola hoja, una fila por proyecto,
pero las columnas son **semestres en texto literal** ("1S 2026", "2S 2026", ...), no fechas —
`PFImporter.parseSemesterLabel`/`detectSemesterHeaderRow`/`semesterColumns` reconocen ese patrón en
vez de `cellToDate`. Suele traer una columna de flag ("¿En PPTO?" con "Sí"/vacío) que marca cuáles
filas son proyectos reales; las filas en blanco son subtotales de agrupación interna del archivo
(no corresponden a las categorías de la app) y se descartan (`detectFlagColumn` +
`extractPresupuestoRows`). Cada monto semestral se reparte **en partes iguales entre sus 6 meses**
al guardarlo en `presupuesto` — no hay forma de recuperar más precisión de un dato que solo viene a
nivel semestre; esto es exacto en las vistas Semestral/Anual de Resumen Directorio, y una
aproximación 50/50 en la vista Trimestral. Como este archivo no trae categoría por fila (a
diferencia del archivo maestro), el paso de confirmación deja elegir categoría solo para los
proyectos nuevos (por defecto "Otros"); los que ya existen conservan su categoría actual.

## Reglas críticas

- **No mezclar con Mira**: Firebase, colecciones, deploy y repo son independientes. Nunca apuntar
  comandos `firebase deploy` de este proyecto al proyecto de Mira, ni viceversa.
- `firebase-config.js` empieza con `window.FIREBASE_CONFIG = null` (modo local). Se activa el modo
  nube solo cuando el usuario pega su propio config de un proyecto Firebase creado para esta app.
- Los cálculos derivados (flujo neto, caja acumulada, alertas) viven en `app.js` (`buildTimeline`,
  `netByMonth`, `projectedSeries`) — son puros, no tocan el DOM directamente.

## Rediseño (Consolidado + Flujo de Caja)

El shell (sidebar+topbar), `#dashboard` (Consolidado) y `#flujo-mensual` (Flujo de Caja) siguen un
handoff de diseño de alta fidelidad hecho en Claude Design (paleta, tipografía, espaciados y —para
los dos gráficos y las sparklines— las fórmulas SVG exactas). El paquete original
(`design_handoff_planificacion_financiera/README.md` + `Planificacion Financiera.dc.html`) no vive
en el repo; si hay que revisar el detalle pixel-a-pixel, pedirle el zip de nuevo al usuario. Las
otras 8 vistas **no** se rediseñaron — solo heredan la paleta/paneles nuevos de `style.css`.

- **Tokens**: paleta "Radar Comercial" en `:root` de `style.css` (`--pf-primary-*`, `--pf-slate-*`,
  `--pf-success-*`, `--pf-warning-*`, `--pf-danger-*`), radios (`--pf-radius-*`) y sombras
  (`--pf-shadow-*`). `--pf-primary`/`--pf-ingreso`/`--pf-egreso`/`--pf-border`/`--pf-text-muted`
  (usadas en toda la app, incluidas las 8 vistas no rediseñadas) apuntan a esos tokens.
- **Consolidado** (`renderDashboard`): banner de veredicto (sano/no alcanza, calculado con
  `umbralAlertaMonths`), 4 KPIs (`kpi2Card`), los dos gráficos como SVG a mano
  (`PFCharts.svgCajaAcumulada`, `PFCharts.svgFlujoNeto` en `charts.js` — no Chart.js, para lograr la
  banda de riesgo/callout/barras divergentes pixel-perfect) y un rail de alertas de 4 reglas
  (`alertItemHtml`): tramo bajo umbral, proyecto que concentra >30% de los aportes en ese tramo,
  caja real desactualizada, y la última importación (`state.importLog[0]`).
- **Flujo de Caja** (`renderFlujoMensual`): tabla con categorías colapsables (chevron, clic o
  Enter/Espacio; estado en `localStorage['pf.flujo.openCats']`, la primera categoría con proyectos
  abierta por defecto), semáforo por celda en "Caja proyectada acumulada" (clases `.sem-bajo/
  .sem-riesgo/.sem-ok`), sparkline por fila (`PFCharts.sparkline`), columna de proyecto fija, y
  export a Excel/PDF (`PFReports.exportExcel`/`exportPDF`). Sigue siendo el equivalente en la app a
  la hoja "Flujo JAB" del Excel de directorio (grid mensual, sin los bloques de escenario
  "Esc. Base +..." que esa hoja tiene y no se replicaron).
- **Generalización sobre el prototipo**: el prototipo de diseño usaba 12 meses fijos; las fórmulas
  de `charts.js` generalizan a `buildTimeline().months` de cualquier largo (etiquetas de mes se
  espacian con `labelStep` para horizontes largos, el techo del eje Y se calcula con `niceCeil`, y
  la sparkline ajusta el ancho de barra para no dar anchos negativos con muchos meses).
- **`state.importLog`**: `loadAll()` lo carga (`DB.listImportLog()`); lo usan tanto el chip de
  stats del topbar ("Última carga") como la alerta "Info" del rail de Consolidado.

## Resumen Directorio

Vista (`renderResumenDirectorio` en `app.js`) que arma la tabla y el gráfico que antes se rearmaban a
mano cada mes en un PPTX para el directorio: flujo de caja **Presupuesto vs Actual (proyección)**, por
categoría, con selector Trimestral / Semestral / Anual (helper `periodBuckets`, persistido en
`localStorage['pf.directorio.gran']`, constante `DIR_GRAN_KEY`). No replica la sub-agrupación exacta
del PPTX original (proyectos activos vs obras nuevas por proyecto individual); cada fila es una
categoría de la app, que ya es la misma idea (suma de todos sus proyectos). El "acumulado" de esta
vista es la suma acumulada del flujo neto del rango visible (no usa `cajaInicial`), para que Actual y
Presupuesto sean comparables aunque partan de supuestos de caja distintos.

**Banner de veredicto + KPIs + tabla por categoría** (segundo rediseño, encabezado de la vista):
`resumenVeredicto(buckets, acumActual)` clasifica el acumulado en 3 estados (rojo si el cierre queda
negativo, ámbar si algún período intermedio es negativo pero el cierre no, verde si todo el horizonte
es positivo) y arma el texto del `.verdict-banner`. Las 4 tarjetas `.kpi2-card` (cierre acumulado,
punto más bajo, caja acumulada justo antes del mayor salto positivo, y una cuarta dinámica: "Presupuesto:
No cargado" en gris si `presupuesto` está vacío en todos los períodos, o "Desviación vs. PPTO" en
verde/rojo si hay presupuesto cargado) usan un helper local `dirKpiCard` (no el `kpi2Card` de
Consolidado, porque el valor de esta cuarta tarjeta puede ser texto, no solo número). La tabla de
categorías tiene **columnas condicionales**: 1 columna (Actual) por período sin presupuesto cargado, 2
(Actual, Δ) con presupuesto — nunca 3 columnas fijas de Ppto/Actual/Var como antes; los ceros se
muestran como "—", nunca "0 UF". El gráfico (`PFCharts.lineCajaAcumulada` en `charts.js`) es una sola
línea de Chart.js con el punto mínimo resaltado y una línea de presupuesto punteada que se omite del
todo si viene toda en cero; las anotaciones de texto (mínimo y mayor salto) son `<div>` absolutos
posicionados leyendo los píxeles reales de `chart.getDatasetMeta(...)` después de renderizar, no
porcentajes fijos.

**Flujo de Obras por año de inicio** (misma vista, sección aparte): tabla igual de colapsable que
Flujo de Caja pero agrupada por `proyecto.grupoObra` en vez de categoría, y **excluyendo los
proyectos de la categoría "Financiamiento, Dividendo e Impuestos"** (constante `CAT_FINANCIAMIENTO`
en `app.js`) — es el "flujo de obra" que pidió el usuario: todo lo que no es financiamiento
corporativo. `grupoObra` no viene de ningún Excel; se infiere una sola vez por proyecto
(`inferirGrupoObra`, corre perezoso vía `ensureGruposObra` al entrar a la vista y se persiste con
`DB.updateProyecto`) buscando el primer mes con un aporte "relevante" (≥ 500 UF o ≥10% del mayor
aporte del propio proyecto) y usando su año ("Obras 2026", etc.); si no hay ninguno, "Sin
clasificar". **Es una simplificación deliberada**: no distingue "obras iniciadas" de "obras por
iniciar" del mismo año (esa distinción no es inferible solo del flujo de caja) — por eso cada fila de
proyecto es `draggable="true"` y cada fila de grupo acepta el `drop`, para que el usuario corrija a
mano cuando la heurística se equivoque; la corrección se guarda en `grupoObra` y nunca se
recalcula sola (`ensureGruposObra` solo clasifica proyectos que **no** tienen `grupoObra` todavía).
El gráfico "Flujo de Caja: Actual vs Presupuesto" (`PFCharts.comboInversionVsPpto`, Chart.js con
datasets `bar`+`line` mezclados, mismo patrón que el chart de detalle de proyecto) usa los totales de
esta misma tabla (actual/ppto por período y acumulado).

## Pendiente

Ver el plan original en el historial de la conversación / `README.md` para el checklist de conexión a
Firebase real (crear proyecto, habilitar Auth+Firestore, pegar config, escribir `firestore.rules`,
deploy a Hosting).

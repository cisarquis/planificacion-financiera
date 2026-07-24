# AGENTS.md — Planificación Financiera (Flujo de Caja Consolidado)

Proyecto **independiente**, sin relación con Mira (otra app del mismo usuario). No comparte carpeta,
repositorio ni proyecto Firebase con Mira.

## Qué es

App web para que Cristian (Ingevec) haga seguimiento del flujo de caja de todos sus proyectos
inmobiliarios: sube un Excel por proyecto cada mes (aportes/devoluciones), define una caja inicial,
y la app consolida la proyección por proyecto, por categoría y a nivel global, comparándola contra la
caja real del banco (ingresada mes a mes). Sirve también al área de finanzas para programar pagos
(ver egresos futuros).

**Categorías** (configurables desde la app, sembradas al primer uso): Proyectos propios, Con terceros,
Hoteles, Multifamily, Evaluación.

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
charts.js             Helpers de Chart.js (window.PFCharts)
reports.js            Exportación Excel/PDF (window.PFReports)
firebase-config.js     Config del proyecto Firebase PROPIO (null = modo local)
style.css             Estilos
.claude/launch.json   Preview local puerto 3300 (usa `npx serve .`)
```

## Modelo de datos (Firestore o localStorage, mismas claves)

```
config/global       { cajaInicial, mesInicial:'YYYY-MM', moneda:'UF'|'CLP', umbralAlerta }
categorias/{id}     { nombre, orden }
proyectos/{id}      { nombre, categoriaId, moneda, proyeccion:{'YYYY-MM':neto}, ultimaImportacion, ... }
cajaReal/{YYYY-MM}  { monto, nota }
importLog/{id}      { projId, fileName, sheet, meses, importedAt, byEmail }
```

**Signo:** en `proyeccion`, negativo = aporte (egreso de caja del proyecto), positivo = devolución
(ingreso). La caja proyectada acumulada = `cajaInicial + Σ flujo neto consolidado hasta el mes`.

## Formato de Excel esperado (confirmado con archivo real de ejemplo)

Hoja tipo "Planificación Financiera": una fila con los meses (fechas/series de Excel) y una fila
"Flujo de Caja" con el neto mensual. El importador (`importer.js`) es **flexible**: detecta
automáticamente la fila de meses y la fila de flujo por heurística, pero el usuario puede corregir el
mapeo manualmente (útil si el formato cambia entre archivos).

## Reglas críticas

- **No mezclar con Mira**: Firebase, colecciones, deploy y repo son independientes. Nunca apuntar
  comandos `firebase deploy` de este proyecto al proyecto de Mira, ni viceversa.
- `firebase-config.js` empieza con `window.FIREBASE_CONFIG = null` (modo local). Se activa el modo
  nube solo cuando el usuario pega su propio config de un proyecto Firebase creado para esta app.
- Los cálculos derivados (flujo neto, caja acumulada, alertas) viven en `app.js` (`buildTimeline`,
  `netByMonth`, `projectedSeries`) — son puros, no tocan el DOM directamente.

## Pendiente

Ver el plan original en el historial de la conversación / `README.md` para el checklist de conexión a
Firebase real (crear proyecto, habilitar Auth+Firestore, pegar config, escribir `firestore.rules`,
deploy a Hosting).

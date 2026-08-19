# AGENTS.md — Planificación Financiera (Flujo de Caja Consolidado)

Proyecto **independiente** de Mira (otra app de Ingevec) en cuanto a carpeta, repositorio y datos.
Sí **comparte el proyecto de Firebase** (`mira-87ec6`, cuenta/facturación de la empresa) — pero usa su
**propia base de datos Firestore** (`planificacion-financiera`, no la `(default)` que usa Mira), así
que no hay ninguna colección ni documento en común entre ambas apps. Ver "Auth y roles" más abajo
para el detalle completo de por qué se armó así.

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
build step, sin `npm install` para producción). Persistencia: Firebase (Firestore, SDK **modular**
v10) o, si `firebase-config.js` no tiene credenciales, **modo local** con `localStorage` (mismo
código, `data.js` abstrae ambos backends). Login con Google, roles dueño/editor/lector — ver "Auth y roles".

## Estructura

```
index.html            Login + "sin acceso" + shell (sidebar + secciones)
app.js                Orquestador: estado, navegación, cálculos, render de cada vista, auth/roles
data.js               Capa de datos (window.DB) — Firestore (modular) o localStorage
firebase-init.js      Único módulo ES de la app: SDK modular de Firebase, expone window.__fb
firebase-config.js    Config de Firebase (proyecto mira-87ec6) + database ID + dominio permitido
firestore.rules       Reglas de seguridad de la base "planificacion-financiera" (roles)
firebase.json         Config de deploy (array multi-base — ver "Auth y roles")
.firebaserc           Proyecto default (mira-87ec6) para el Firebase CLI
importer.js           Parseo/mapeo/extracción de Excel (window.PFImporter)
charts.js             Helpers de gráficos (window.PFCharts): Chart.js (Por categoría, Resumen
                       Directorio) + SVG a mano (Consolidado, sparklines de Flujo de Caja)
reports.js            Exportación Excel/PDF (window.PFReports)
style.css             Estilos
.claude/launch.json   Preview local puerto 3301 (usa `npx serve .`)
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

## Auth y roles

Login obligatorio (Google, `signInWithPopup` + `GoogleAuthProvider`, restringido a
`window.ALLOWED_EMAIL_DOMAIN` = `ingevec.cl`), con tres roles:
- **dueño**: todo lo que puede un editor, más administra desde la app quién es editor/lector (vista
  "Usuarios", solo visible para dueño vía `isOwner()`). Promover a alguien a "dueño" queda **fuera**
  de la app a propósito (ver más abajo) — sigue siendo un paso manual en la consola/CLI de Firebase.
- **editor** (antes "admin"): puede escribir — importar Excel (los 3 modos), Caja del banco,
  Configuración, alta/edición/borrado manual de proyecto, edición manual del flujo de caja mensual
  celda por celda (botón "Editar flujo" en Flujo de Caja mensual), y la corrección por
  drag-and-drop de `grupoObra` en Resumen Directorio.
- **lector**: todo lo demás, sin ninguna de esas acciones — las ve deshabilitadas/ocultas
  (`isAdmin()` en `app.js` sigue con ese nombre por compatibilidad con sus ~14 usos, pero ahora es
  `true` para 'editor' o 'dueño'; gatea cada botón/formulario en el punto donde se renderiza), pero
  la protección real es del lado del servidor (`firestore.rules`): si alguien se saltara la UI, las
  reglas igual rechazan la escritura.

**Editar el flujo de caja a mano**: en "Flujo de Caja mensual", un editor/dueño puede activar "Editar
flujo" — las celdas de las filas de proyecto pasan a `<input type="number">`; las filas de categoría/
total/acumulado/caja real siguen de solo lectura (son sumas calculadas). Navegación tipo Excel: las
flechas mueven el foco entre celdas (saltándose filas no editables al subir/bajar) y Enter se
comporta como flecha abajo. Los cambios **no se guardan en Firestore al vuelo**: se acumulan en
memoria sobre `state.proyectos` (para que totales/acumulado se vean actualizados en vivo) hasta que
se presiona **"Guardar cambios"** (ahí sí, un `DB.updateProyecto(id, { proyeccion })` por proyecto
tocado, en paralelo) o **"Cancelar"** (revierte todo a como estaba al entrar en modo edición). Ctrl+Z/
Ctrl+Y (o los botones "Deshacer"/"Rehacer") navegan una pila de cambios celda por celda
(`flujoUndo`/`flujoRedo` en `app.js`) independiente del guardado — deshacer/rehacer no habla con
Firestore, solo mueve el valor en memoria. Las celdas con un cambio sin guardar se resaltan en
ámbar (clase `.dirty`). Como "Exportar por proyecto" y el botón **"Exportar como archivo maestro"**
(en Reportes, mismo layout que el importador: una hoja por categoría, una fila por proyecto) leen esa
misma estructura en vivo, cualquier edición manual —guardada o todavía pendiente— ya queda reflejada
al exportar sin lógica extra de reconciliación.

**Año de construcción**: se edita en "Por proyecto" (diálogo de "Nuevo/Editar proyecto", junto a
Estado), **no en Flujo de Caja mensual** (se sacó de ahí — vivía como una columna "Año constr." por
fila de proyecto, pero se movió porque es metadata del proyecto, no un dato del flujo, y el resto de
esa metadata — Estado, Grupo, Tipo — ya se edita en "Por proyecto"). El campo `proyecto.anioConstruccion`
se guarda con `DB.updateProyecto` como cualquier otro campo del diálogo. El input se precarga con
`anioConstruccionEfectivo(p)`: el valor ya definido si existe, o si no un valor por defecto inferido
en el momento (no se persiste hasta guardar el diálogo). Este campo es la entrada manual para el
agrupamiento de "Flujo de Obras por año de inicio" en Resumen Directorio — ver esa sección para el
detalle de `grupoObraDe`. También se muestra (solo lectura) en la tarjeta y en el detalle de "Por
proyecto" cuando está definido.

**Por qué comparte proyecto de Firebase con Mira pero no la base de datos**: se evaluó un proyecto
Firebase 100% aparte, pero la cuenta de Google del usuario (`csarquis@ingevec.cl`) pertenece a la
organización de Ingevec y esa organización **bloquea crear proyectos nuevos de Google Cloud** (ni por
CLI ni por consola — se confirmó con ambos). Firestore sí soporta **múltiples bases de datos por
proyecto** (GA desde 2024), así que la solución fue pedirle a Andrés Lowener (Propietario del proyecto
`mira-87ec6`; este usuario es solo Editor ahí) que creara una base nueva y vacía llamada
`planificacion-financiera` — mismo proyecto/facturación de la empresa, cero colecciones ni documentos
en común con la base `(default)` que usa Mira.

**Por qué el SDK es modular (v10), no namespaced (v8)**: Firestore multi-base de datos **no existe**
en el SDK namespaced clásico (`firebase.firestore()` siempre apunta a `(default)`, sin forma de pasar
un database ID). `firebase-init.js` es el único módulo ES de la app (`<script type="module">`,
cargado antes que `data.js`/`app.js` en `index.html` aunque por spec los módulos siempre corren
*después* que los scripts clásicos — no importa, porque `DB.init()`/`Fire.*` solo acceden a
`window.__fb` cuando de verdad se llaman, nunca al cargar el archivo) — hace `initializeApp` +
`getAuth` + `getFirestore(app, 'planificacion-financiera')` y cuelga todo en `window.__fb` (instancias
+ funciones modulares) para que `data.js` y `app.js`, que siguen siendo scripts clásicos, lo usen sin
tener que convertirse ellos mismos en módulos.

**Colección `roles/{email}`** (doc ID = correo en minúsculas) → `{ role: 'dueño'|'editor'|'lector' }`.
Cualquier cuenta logueada puede leer (`DB.getRole`/`DB.listRoles`). Un **dueño** puede además crear/
actualizar/borrar roles desde la vista "Usuarios" (`DB.setRole`/`DB.deleteRole`), pero las reglas de
Firestore (`allow create, update: if isOwner() && request.resource.data.role in ['editor','lector']`)
solo dejan asignar 'editor' o 'lector' — nunca 'dueño', para que nadie pueda crear un segundo dueño
por error o de forma casual, ni siquiera el propio dueño saltándose la UI. El primer dueño se crea a
mano en la consola de Firebase o por Firebase CLI directamente sobre Firestore — es la única
excepción a "todo pasa por `window.DB`" en toda la app.

**`firebase.json` usa el formato de array multi-base** (`"firestore": [{ "database": "...", "rules":
"...", "indexes": "..." }]`), necesario porque el proyecto tiene más de una base de datos. Ojo con un
bug real del CLI: `firebase deploy --only firestore:rules` **falla en silencio** (exit 0, no despliega
nada) en proyectos con config multi-base — hay que usar `firebase deploy --only firestore` (sin
`:rules`) para que realmente suba las reglas.

**Modo local** (sin `FIREBASE_CONFIG`) no tiene login ni roles: `DB.getRole()` del backend local
siempre devuelve `'dueño'`, porque quien abre el navegador ya es dueño de sus propios datos en
`localStorage` — no tiene sentido pedirle login a sí mismo. `DB.listRoles()` devuelve `[]` y
`setRole`/`deleteRole` son no-op: el concepto de "otros usuarios" no aplica en modo local.

## Planificación (etapas de proyectos en evaluación)

Vista nueva en el sidebar, justo debajo de "Programar pagos". Hace seguimiento del avance de
negocio de un proyecto (no del flujo de caja) a través de 6 etapas fijas, definidas en
`ETAPAS_PLANIFICACION` (`app.js`): **Evaluación** (objetivo 1 mes) → **Financiamiento Terreno**
(4 meses) → **Actualización evaluación** (2 semanas) → **Financiamiento Construcción** (6 meses)
→ **Actualización evaluación** (2 semanas, se repite) → **MCG** (hito final, sin duración — llegar
ahí significa que el proyecto terminó su proceso de evaluación/financiamiento).

**Modelo de datos**: colección aparte `planProyectos/{id}` (`{ proyectoId, promesaCompraventa,
etapas: { [etapaId]: { inicio, fin, comentario } } }`) que **referencia** un proyecto real de
`proyectos/*` por id, sin duplicar sus datos ni tocar su flujo de caja — por diseño, para que
borrar un registro de planificación ("Quitar") nunca borre el proyecto real ni su historial. Solo
se puede **agregar** a planificación un proyecto cuyo `proyecto.estado` (campo separado, editable
en el diálogo de "Nuevo/Editar proyecto" en "Por proyecto"; valores en `ESTADOS_PROYECTO` de
`app.js`: `'evaluacion'`/`'ejecucion'`/`'terminado'`, o sin definir) sea `'evaluacion'` — el
desplegable de "Agregar a planificación" filtra por eso y excluye los que ya están agregados. Una
vez agregado, sigue visible aunque el proyecto cambie de estado después (no se saca solo, para no
perder el historial de seguimiento).

**Alertas** (`planEtapaAlertas`, `app.js`):
- **Atraso de duración**: si una etapa tiene `inicio` pero no `fin` (sigue abierta) y ya pasaron
  más días que el objetivo de esa etapa, se marca en rojo con "Lleva N días abierta".
- **Regla de Financiamiento Terreno vs. promesa de compraventa**: cada proyecto tiene un campo
  `promesaCompraventa` (fecha) editable en la tarjeta. Si está definida, Financiamiento Terreno
  debe **iniciar al menos 4 meses antes** de esa fecha (y como además dura 4 meses, en el caso
  ideal termina justo cuando se firma la promesa) — si no tiene `inicio`, o si `inicio` es
  posterior al objetivo (`promesaCompraventa` − 4 meses), se marca la alerta correspondiente.

Todo editable (fechas, comentario de texto libre por etapa, promesa de compraventa) requiere
`isAdmin()` — un lector ve la vista de solo lectura, inputs deshabilitados. Guardado campo a
campo con `DB.updatePlanProyecto(id, patch)` (merge parcial, igual que `updateProyecto`), no hay
modo edición en lote como en Flujo de Caja — no hace falta, son pocos campos por proyecto.

## Agrupar proyectos relacionados (`proyecto.grupoPadre`)

Algunos proyectos del Excel son en realidad "contenedores" de sub-obras — ej. "Icuadra Sn Bdo 3 y 4"
agrupa a "Jardines de San Bernardo I" y "II". En vez de sumar eso a mano en el Excel (con el riesgo
de que el importador la lea como un proyecto más y la sume una segunda vez a los totales de
categoría/Resumen Directorio), cada sub-obra se importa como proyecto normal e independiente, y se
les asigna el mismo texto libre en `proyecto.grupoPadre` (editable en el diálogo de "Nuevo/Editar
proyecto" en "Por proyecto", con un `<datalist>` de los grupos ya existentes para no escribirlo con
una tilde o mayúscula distinta por error — el agrupamiento es por coincidencia **exacta** de texto).

El agrupamiento se ve en dos vistas, ambas leyendo el mismo `grupoPadre` y comparten el estado
abierto/cerrado (`OPEN_PROJ_GRUPOS_KEY` en `localStorage`, así expandir un grupo en una vista lo deja
expandido en la otra):
- **"Por proyecto"**: `proyectosGridHtml` agrupa las tarjetas que compartan `grupoPadre` en una sola
  tarjeta expandible (`grupoCard`). Al hacer clic se expande y muestra cada hijo como tarjeta normal,
  clickeable a su detalle de siempre.
- **"Flujo de Caja mensual"**: `flujoProyectoRowsHtml` hace lo mismo pero como filas de tabla
  (`flujoGrupoRow`/`flujoProyectoRow`) dentro de cada categoría — el grupo aparece como una fila
  colapsable con chevron (como una categoría, pero para un sub-conjunto de sus proyectos) y al
  expandirla los hijos aparecen indentados debajo, con sus celdas editables normales (`flujoProjCell`,
  año de construcción) intactas.

En ambos casos el neto/aportes/margen combinado (o el flujo mensual combinado, en la tabla) se
calcula sobre el flujo **neteado mes a mes** de los hijos (`mergeProyeccion`), no sumando el margen de
cada uno por separado, para que un mes en que un hijo aporta y el otro devuelve se compense igual que
si fuera un solo proyecto real. **El agrupamiento es puramente visual** — cada hijo sigue siendo un
proyecto de verdad con su propio flujo, así que los totales de categoría, Resumen Directorio y el
resto de la app lo siguen contando individualmente, sin doble conteo.

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

- **No mezclar con Mira a nivel de datos**: comparten proyecto de Firebase (`mira-87ec6`) pero NO base
  de datos (`planificacion-financiera` vs `(default)` de Mira) — nunca apuntar código o reglas de esta
  app a la base `(default)`, ni tocar las reglas/colecciones de Mira desde acá. Ver "Auth y roles".
- `firebase-config.js` ya tiene el config real de `mira-87ec6` + `FIREBASE_DATABASE_ID =
  'planificacion-financiera'` — no volver a ponerlo en `null` salvo que se quiera forzar modo local
  a propósito (por ejemplo para probar sin depender de Firebase).
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
- **Consolidado** (`renderDashboard`): banner de veredicto (sano/caja negativa) y 4 KPIs
  (`kpi2Card`, con un 5º parámetro `signed` opcional que antepone "+" a valores positivos — usado
  solo en "Neto del horizonte"), los dos gráficos como SVG a mano (`PFCharts.svgCajaAcumulada`,
  `PFCharts.svgFlujoNeto` en `charts.js` — no Chart.js, para lograr la banda de riesgo/callout/barras
  divergentes pixel-perfect) y un rail de alertas de 4 reglas (`alertItemHtml`): caja que cruza a
  negativo, proyecto que concentra >30% de los aportes en ese tramo, caja real desactualizada, y la
  última importación (`state.importLog[0]`).
  - **Sin umbral configurable**: `renderDashboard` llama `umbralAlertaMonths(t, 0)` (referencia fija
    "caja en cero"), no `state.config.umbralAlerta` — a diferencia de Flujo de Caja mensual
    (`renderFlujoMensual`), que **sí** sigue usando el umbral configurable de Configuración para su
    semáforo de celda (`sem-bajo/sem-riesgo/sem-ok`). Es la única vista donde se simplificó así.
  - **Escala Y bipolar** en `svgCajaAcumulada`: `bottom` se calcula del mínimo real de la serie (no
    siempre 0), para que la línea proyectada se pueda dibujar correctamente cuando cruza a negativo,
    con la banda roja cubriendo solo la zona bajo cero (antes el eje asumía 0 como piso fijo, lo que
    rompía la banda/línea si el dato bajaba de 0).
  - **Eje X por año** (`yearAxisSvg`, helper compartido): 1 etiqueta centrada por año + separador
    vertical entre años, en vez de una etiqueta por mes/trimestre — usa un array `years[i]` paralelo
    a los datos (no parsea el texto de la label).
  - **`svgFlujoNeto` recibe datos trimestrales**, no mensuales: `renderDashboard` agrega con
    `periodBuckets(t.months, 'trimestral')` antes de llamar al chart (mismo patrón que Resumen
    Directorio). Ya no dibuja una etiqueta de valor por barra ("0k0k0k..." con 60 barras).
  - **Sin callouts dibujados por default — solo tooltip on-hover**: ambos SVG dibujan, sobre cada
    punto/barra, un elemento invisible `class="hover-pt"` (`<circle r="9">` o `<rect>` del ancho de
    la barra) con `data-tip-title`/`data-tip-sub`/`data-tip-tone` (`dark` si el valor es negativo,
    `light` si es positivo). `wireChartHoverTips(el)` en `app.js` (llamado al final de
    `renderDashboard`) crea **un solo** div `.chart-hover-tip.chart-annotation` por gráfico y lo
    reposiciona/rellena en cada `mouseenter` de un `.hover-pt`, usando `getBoundingClientRect()` del
    punto hovereado (no las unidades del viewBox) — por eso cae bien sin importar a qué ancho haya
    escalado el SVG. El punto mínimo de `svgCajaAcumulada` sigue con un puntito rojo siempre visible
    (referencia rápida sin hover); todo lo demás (valor exacto, mes/trimestre) es solo al pasar el
    mouse, para no tapar el gráfico con cajas fijas.
  - **`.chart-svg-wrap` ya no tiene `max-width:780px`** (bug real: dejaba los 2 gráficos a poco más
    de la mitad del ancho del panel en pantallas anchas, un resabio de cuando `W` del SVG era 780).
    Ahora ambos SVG usan `W=1340` y ocupan el 100% del panel.
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
muestran como "—", nunca "0 UF". El gráfico (`PFCharts.lineCajaAcumulada` en `charts.js`, llamado con
`acumPpto = null`) muestra **solo la línea de Actual** (con el punto mínimo resaltado) — no compara
contra presupuesto, a diferencia de la tabla; las anotaciones de texto (mínimo y mayor salto) son
`<div>` absolutos posicionados leyendo los píxeles reales de `chart.getDatasetMeta(...)` después de
renderizar, no porcentajes fijos.

**Flujo de Obras por año de inicio** (misma vista, sección aparte): tabla igual de colapsable que
Flujo de Caja pero agrupada por el año de inicio de cada proyecto en vez de categoría, y
**excluyendo los proyectos de la categoría "Financiamiento, Dividendo e Impuestos"** (constante
`CAT_FINANCIAMIENTO` en `app.js`) — es el "flujo de obra" que pidió el usuario: todo lo que no es
financiamiento corporativo. El año de agrupamiento sale de `grupoObraDe(p)` (`app.js`), que prioriza
en este orden:
1. **`proyecto.anioConstruccion`** — un año que el usuario escribe a mano en la columna "Año
   constr." de **Flujo de Caja mensual** (siempre editable ahí, sin depender de "Editar flujo",
   porque es un solo valor por proyecto y no una grilla; se guarda al vuelo con
   `DB.updateProyecto`). Es la fuente de verdad más confiable porque no depende de adivinar nada
   del flujo de caja — si está definido, manda siempre.
2. Si no está definido, `proyecto.grupoObra` — el valor ya clasificado/corregido por drag-and-drop
   en esta misma sección (ver abajo).
3. Si tampoco existe, `inferirGrupoObra(p)` — heurística que infiere el año buscando el primer mes
   con un aporte "relevante" (≥ 500 UF o ≥10% del mayor aporte del propio proyecto) y usando su año
   ("Obras 2026", etc.); si no hay ninguno, "Sin clasificar".

**Es una simplificación deliberada**: la heurística no distingue "obras iniciadas" de "obras por
iniciar" del mismo año (esa distinción no es inferible solo del flujo de caja) — por eso, además del
campo "Año constr." editable, cada fila de proyecto en esta sección sigue siendo `draggable="true"` y
cada fila de grupo acepta el `drop`, para corregir a mano cuando haga falta; soltar sobre un grupo
real ("Obras 2026") escribe ese año en **`anioConstruccion`** (no solo en `grupoObra`, porque
`grupoObraDe` le da prioridad a `anioConstruccion` y si no se tocara ese campo la corrección por
drag-and-drop no se vería reflejada); soltar sobre "Sin clasificar" limpia `anioConstruccion` para
que vuelva a mandar `grupoObra`/la heurística. `ensureGruposObra` (clasificación automática
perezosa al entrar a la vista) solo toca proyectos que **no** tienen ni `grupoObra` ni
`anioConstruccion` todavía, para no pisar ninguna de las dos formas de corrección manual.
**Sección "Inversión en obras"** (2 gráficos + 1 tabla, siempre **anual y acotada a 2026-2028**
— constantes `OBRA_CHART_ANIO_DESDE`/`_HASTA` en `app.js` — sin importar la granularidad elegida
arriba para la tabla por categoría; `obraAnualBuckets = periodBuckets(months, 'anual')` filtrado a
ese rango de años):
- **"Inversión en obras del período"** (`PFCharts.barInversionPeriodo`): barras agrupadas Actual vs
  Presupuesto por año, con el valor de cada barra dibujado encima/debajo vía un plugin de Chart.js
  inline (sin librería de datalabels externa).
- **"Inversión acumulada"** (`PFCharts.lineInversionAcumulada`): línea Actual sólida vs Ppto punteada,
  con el área entre ambas rellena (`fill: 0` de Chart.js apuntando al dataset de Ppto, nativo, sin
  plugin). La brecha ("X UF sobre/bajo el PPTO") **no** se dibuja fija sobre el gráfico — se calcula
  por punto en `opts.plugins.tooltip.callbacks.afterBody` y aparece solo en el tooltip nativo de
  Chart.js al pasar el mouse (una caja fija tapaba la línea y quedaba "pegada" siempre en el mismo
  lugar, independiente de qué tan ancho se renderizara el chart).
  **Estos 2 gráficos usan solo la línea "obras nuevas 2026-2028"** (`obraNuevaProyectos` — ver abajo),
  acumulada pura desde cero, **sin** `cajaInicial` — a propósito, para que reconcilien exactamente
  con la fila "Flujo obras 2026 a 2028" de la tabla de abajo.
- **Tabla "Actual, presupuesto y desviación por año"**: `Concepto` + 3 columnas (Actual/Ppto/Δ) por
  año, 4 líneas + fila total + fila acumulada (clase `.total-row`, reutilizada), botón "Exportar
  Excel" propio (`#resumen-obra-excel`, separado del de la tabla por categoría). Las 4 líneas:
  - **Flujo obras 2026 a 2028**: proyectos de Flujo de Obras (`obraProyectos`, ya excluye
    Financiamiento) cuyo `grupoObra` cae en ese rango de años.
  - **Flujo proyectos activos a diciembre 2025**: el resto de `obraProyectos` (`grupoObra` "Sin
    clasificar" o fuera del rango) — proyectos sin un aporte nuevo detectado en 2026-2028.
  - **Flujo Financiero Corp** / **Bono F**: split de la categoría Financiamiento por el campo `tipo`
    del proyecto — `tipo === 'Bono F'` (bono F y sus intereses) va a la fila Bono F, todo lo demás
    (otros bonos, factoring, CxP relacionadas, FOGAES, dividendos, impuestos, etc.) va a Financiero
    Corp. Este split viene directo del archivo maestro real (columna "tipo" de la hoja
    "FINANCIAMIENTO, DIVIDENDOS, IMP"), no es inventado.
  - **Flujo de caja** / **Flujo de caja acumulado**: suma de las 4 líneas; a diferencia de los 2
    gráficos de arriba, el acumulado de **esta tabla sí** parte de `state.config.cajaInicial` (mismo
    campo que usan Consolidado y Flujo de Caja mensual) — es la única excepción en todo Resumen
    Directorio, que por lo demás deliberadamente no usa caja inicial para que Actual y Ppto sean
    comparables entre sí sin depender de un saldo externo.
  Los colores de signo (Actual) y semáforo (Δ, `success-100`/`danger-100`) se aplican con `style`
  inline en las celdas, no con las clases `.pos`/`.neg`/`.sem-*`, porque la fila total tiene su
  propio fondo por CSS (`.total-row`) que gana por especificidad sobre esas clases.

## Pendiente

Ver el plan original en el historial de la conversación / `README.md` para el checklist de conexión a
Firebase real (crear proyecto, habilitar Auth+Firestore, pegar config, escribir `firestore.rules`,
deploy a Hosting).

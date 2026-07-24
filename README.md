# Planificación Financiera — Flujo de Caja Consolidado

App para seguimiento y consolidación del flujo de caja de tus proyectos inmobiliarios: subes un Excel
por proyecto cada mes, defines una caja inicial, y la app te muestra cómo evoluciona la caja por
proyecto, por categoría y a nivel consolidado — comparando la proyección contra la caja real del banco.

## Correr localmente

No requiere instalación (es HTML/JS estático). Cualquier servidor estático funciona:

```bash
npx serve .
```

Ábrelo en `http://localhost:3000` (o el puerto que indique). Si usas el preview de Claude Code, ya
está configurado en `.claude/launch.json` (puerto 3300).

Mientras `firebase-config.js` tenga `FIREBASE_CONFIG = null`, la app funciona en **modo local**: los
datos se guardan en el navegador (localStorage) y no hay login. Puedes usarla así desde ya.

## Conectar Firebase (para compartir con finanzas / multiusuario)

Esta app usa su **propio** proyecto Firebase — no el de Mira. Pasos (una sola vez):

1. Ve a [console.firebase.google.com](https://console.firebase.google.com) y crea un proyecto nuevo,
   por ejemplo `planificacion-financiera-ingevec`.
2. En **Authentication**, habilita el proveedor **Email/Password** y/o **Google**.
3. En **Firestore Database**, crea la base de datos en la región `southamerica-west1` (modo producción).
4. En **Configuración del proyecto → Tus apps**, registra una **app web** y copia el objeto
   `firebaseConfig` que te entrega.
5. Pega ese objeto en [`firebase-config.js`](firebase-config.js), reemplazando el `null`:
   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "...",
   };
   ```
6. Instala el CLI de Firebase si no lo tienes y despliega las reglas de seguridad:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add        # elige tu proyecto nuevo, alias "default"
   firebase deploy --only firestore:rules
   ```
7. (Opcional) Para publicar la app en la nube (Firebase Hosting):
   ```bash
   firebase deploy --only hosting
   ```

Con esto, tú y el área de finanzas pueden iniciar sesión (correo `@ingevec.cl`) y ver los mismos datos
en tiempo real.

## Uso

1. **Importar Excel**: elige el proyecto (o crea uno nuevo + categoría), sube el `.xlsx`/`.xlsm`, y
   confirma el mapeo (fila de meses, fila de flujo). La app detecta el mapeo automáticamente pero
   puedes corregirlo si el formato cambia.
2. **Caja del banco**: define la caja inicial y el mes de partida, y cada mes ingresa el saldo real
   del banco para comparar contra lo proyectado.
3. **Consolidado / Por categoría / Por proyecto**: dashboards y gráficos de evolución.
4. **Programar pagos**: lista de egresos futuros por mes y proyecto, exportable a Excel — para que
   finanzas programe los desembolsos.
5. **Reportes**: exporta el consolidado a Excel o PDF.
6. **Configuración**: administra categorías, moneda y el umbral de alerta de liquidez.

## Estructura del proyecto

Ver [AGENTS.md](AGENTS.md) para el detalle técnico (modelo de datos, arquitectura, convenciones).

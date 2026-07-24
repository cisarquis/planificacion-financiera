// ============================================================================
// Configuración de Firebase — Proyecto PROPIO de "Planificación Financiera"
// ----------------------------------------------------------------------------
// Este proyecto NO comparte Firebase con Mira. Debe usar su propio proyecto.
//
// Cómo completar (una sola vez):
//   1. Crea un proyecto nuevo en https://console.firebase.google.com
//      (ej. "planificacion-financiera-ingevec").
//   2. Habilita Authentication (Email/Password y/o Google) y Firestore
//      (región southamerica-west1).
//   3. Registra una "Web app" y pega aquí abajo el objeto firebaseConfig.
//
// Mientras FIREBASE_CONFIG sea null, la app funciona en MODO LOCAL (sin login,
// datos en el navegador con localStorage). Apenas pegues el config real, la app
// pasa a MODO FIREBASE (nube + multiusuario) automáticamente.
// ============================================================================

window.FIREBASE_CONFIG = null;

// Ejemplo de cómo se verá una vez completado (reemplaza el null de arriba):
//
// window.FIREBASE_CONFIG = {
//     apiKey: "AIza...",
//     authDomain: "planificacion-financiera-ingevec.firebaseapp.com",
//     projectId: "planificacion-financiera-ingevec",
//     storageBucket: "planificacion-financiera-ingevec.firebasestorage.app",
//     messagingSenderId: "000000000000",
//     appId: "1:000000000000:web:abcdef"
// };

// Dominio permitido para login (déjalo en null para permitir cualquier correo).
window.ALLOWED_EMAIL_DOMAIN = "ingevec.cl";

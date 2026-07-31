// ============================================================================
// Configuración de Firebase — proyecto "mira-87ec6", base de datos dedicada
// ----------------------------------------------------------------------------
// Esta app NO comparte la base "(default)" de Mira: usa su propia base
// Firestore ("planificacion-financiera") dentro del mismo proyecto/cuenta de
// la empresa. Ver AGENTS.md para el detalle de por qué y cómo se armó.
//
// Mientras FIREBASE_CONFIG sea null, la app funciona en MODO LOCAL (sin login,
// datos en el navegador con localStorage). Con el config puesto, pasa a MODO
// FIREBASE (nube + login + roles) automáticamente.
// ============================================================================

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBhEier3rU3uwruOjo97uQAp_DJh41T4CM",
  authDomain: "mira-87ec6.firebaseapp.com",
  projectId: "mira-87ec6",
  storageBucket: "mira-87ec6.firebasestorage.app",
  messagingSenderId: "516314401429",
  appId: "1:516314401429:web:e1cdcfc098e8a328f9299c",
};

// Base de datos Firestore a usar (NO la "(default)" que usa Mira).
window.FIREBASE_DATABASE_ID = "planificacion-financiera";

// Dominio permitido para login (déjalo en null para permitir cualquier correo).
window.ALLOWED_EMAIL_DOMAIN = "ingevec.cl";

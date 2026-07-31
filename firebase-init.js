// ============================================================================
// firebase-init.js — único punto de contacto con el SDK modular de Firebase.
// ----------------------------------------------------------------------------
// Necesitamos el SDK modular (v9+) porque Firestore multi-base de datos (usar
// una base con nombre en vez de "(default)") NO existe en el SDK namespaced
// clásico (firebase.firestore()). El resto de la app (data.js, app.js) sigue
// siendo scripts clásicos (sin módulos) para no tener que tocar cómo se cargan
// charts.js/importer.js/etc. — este archivo hace de puente colgando en
// `window.__fb` tanto las instancias (app/auth/db) como las funciones
// modulares que data.js/app.js necesitan.
//
// Si window.FIREBASE_CONFIG es null (modo local), este módulo no hace nada:
// window.__fb queda undefined y data.js usa el backend local.
// ============================================================================
import {
  initializeApp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc,
  query, orderBy, limit, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) {
  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app, window.FIREBASE_DATABASE_ID || '(default)');

  window.__fb = {
    app, auth, db,
    collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc,
    query, orderBy, limit, serverTimestamp,
    onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut,
  };
}

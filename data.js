// ============================================================================
// data.js — Capa de datos unificada
// ----------------------------------------------------------------------------
// Expone `window.DB`, una API async idéntica para dos backends:
//   - 'firebase' : Firestore (SDK modular v9+, vía window.__fb de firebase-init.js;
//                  nube, multiusuario, con login) cuando hay FIREBASE_CONFIG.
//   - 'local'    : localStorage (un solo navegador, sin login) cuando no lo hay.
// app.js consume esta API sin saber qué backend está activo.
//
// Colecciones / claves (base Firestore "planificacion-financiera", NO la
// "(default)" que usa la app Mira en el mismo proyecto — ver AGENTS.md):
//   config/global            { cajaInicial, mesInicial:'YYYY-MM', moneda, umbralAlerta }
//   categorias/{id}          { nombre, orden }
//   proyectos/{id}           { nombre, categoriaId, moneda, proyeccion:{'YYYY-MM':neto},
//                              presupuesto:{'YYYY-MM':neto} (línea base, se carga una sola vez),
//                              ultimaImportacion, createdAt, updatedAt }
//   cajaReal/{YYYY-MM}       { monto, nota }
//   importLog/{id}           { projId, fileName, sheet, meses, importedAt, byEmail }
//   roles/{email}            { role: 'admin'|'lector', nombre, addedAt } — solo lectura desde
//                            la app; se crea/edita por consola o CLI (ver firestore.rules).
// ============================================================================

(function () {
  const CATEGORIAS_SEMILLA = [
    'Inmobiliaria Ingevec',
    'Inmobiliarias Asociadas',
    'Inv. y Rentas',
    'Financiamiento, Dividendo e Impuestos',
    'Otros',
  ];

  const CONFIG_DEFAULT = {
    cajaInicial: 0,
    mesInicial: '', // 'YYYY-MM' — si vacío se infiere del primer mes con datos
    moneda: 'UF',
    umbralAlerta: 0, // caja proyectada bajo este valor dispara alerta de liquidez
  };

  function uid(prefix) {
    return (prefix || 'id_') + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // ----------------------------------------------------------------------
  // Backend LOCAL (localStorage)
  // ----------------------------------------------------------------------
  const Local = {
    _get(key, fallback) {
      try {
        const raw = localStorage.getItem('pf_' + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    _set(key, val) {
      localStorage.setItem('pf_' + key, JSON.stringify(val));
    },

    async getConfig() {
      return Object.assign({}, CONFIG_DEFAULT, this._get('config', {}));
    },
    async setConfig(patch) {
      const cur = await this.getConfig();
      const next = Object.assign({}, cur, patch);
      this._set('config', next);
      return next;
    },

    async listCategorias() {
      return this._get('categorias', []).slice().sort((a, b) => (a.orden || 0) - (b.orden || 0));
    },
    async addCategoria(nombre) {
      const list = this._get('categorias', []);
      const cat = { id: uid('cat_'), nombre, orden: list.length };
      list.push(cat);
      this._set('categorias', list);
      return cat;
    },
    async updateCategoria(id, patch) {
      const list = this._get('categorias', []);
      const i = list.findIndex((c) => c.id === id);
      if (i >= 0) { list[i] = Object.assign({}, list[i], patch); this._set('categorias', list); }
    },
    async deleteCategoria(id) {
      this._set('categorias', this._get('categorias', []).filter((c) => c.id !== id));
    },

    async listProyectos() {
      return this._get('proyectos', []);
    },
    async getProyecto(id) {
      return this._get('proyectos', []).find((p) => p.id === id) || null;
    },
    async addProyecto(data) {
      const list = this._get('proyectos', []);
      const p = Object.assign({ id: uid('pr_'), proyeccion: {}, presupuesto: {}, createdAt: Date.now() }, data, { updatedAt: Date.now() });
      list.push(p);
      this._set('proyectos', list);
      return p;
    },
    async updateProyecto(id, patch) {
      const list = this._get('proyectos', []);
      const i = list.findIndex((p) => p.id === id);
      if (i >= 0) { list[i] = Object.assign({}, list[i], patch, { updatedAt: Date.now() }); this._set('proyectos', list); return list[i]; }
      return null;
    },
    async deleteProyecto(id) {
      this._set('proyectos', this._get('proyectos', []).filter((p) => p.id !== id));
    },

    async getCajaReal() {
      return this._get('cajaReal', {});
    },
    async setCajaRealMes(mes, monto, nota) {
      const cr = this._get('cajaReal', {});
      if (monto === null || monto === undefined || monto === '') delete cr[mes];
      else cr[mes] = { monto: Number(monto), nota: nota || '' };
      this._set('cajaReal', cr);
      return cr;
    },

    async addImportLog(entry) {
      const list = this._get('importLog', []);
      list.unshift(Object.assign({ id: uid('log_'), importedAt: Date.now() }, entry));
      this._set('importLog', list.slice(0, 200));
    },
    async listImportLog() {
      return this._get('importLog', []);
    },

    // Modo local no tiene login: quien abre el navegador ya es dueño de sus
    // propios datos, así que actúa siempre como admin.
    async getRole() {
      return 'admin';
    },
  };

  // ----------------------------------------------------------------------
  // Backend FIREBASE (Firestore v9+ modular, vía el puente window.__fb que
  // arma firebase-init.js — necesario para usar una base con nombre en vez
  // de "(default)", algo que el SDK namespaced v8 no soporta).
  // ----------------------------------------------------------------------
  const Fire = {
    get fb() { return window.__fb; },
    get db() { return window.__fb.db; },

    async getConfig() {
      const { doc, getDoc } = this.fb;
      const snap = await getDoc(doc(this.db, 'config', 'global'));
      return Object.assign({}, CONFIG_DEFAULT, snap.exists() ? snap.data() : {});
    },
    async setConfig(patch) {
      const { doc, setDoc, serverTimestamp } = this.fb;
      patch = Object.assign({}, patch, { updatedAt: serverTimestamp() });
      await setDoc(doc(this.db, 'config', 'global'), patch, { merge: true });
      return this.getConfig();
    },

    async listCategorias() {
      const { collection, getDocs } = this.fb;
      const qs = await getDocs(collection(this.db, 'categorias'));
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.orden || 0) - (b.orden || 0));
    },
    async addCategoria(nombre) {
      const { collection, addDoc } = this.fb;
      const list = await this.listCategorias();
      const ref = await addDoc(collection(this.db, 'categorias'), { nombre, orden: list.length });
      return { id: ref.id, nombre, orden: list.length };
    },
    async updateCategoria(id, patch) {
      const { doc, setDoc } = this.fb;
      await setDoc(doc(this.db, 'categorias', id), patch, { merge: true });
    },
    async deleteCategoria(id) {
      const { doc, deleteDoc } = this.fb;
      await deleteDoc(doc(this.db, 'categorias', id));
    },

    async listProyectos() {
      const { collection, getDocs } = this.fb;
      const qs = await getDocs(collection(this.db, 'proyectos'));
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
    async getProyecto(id) {
      const { doc, getDoc } = this.fb;
      const snap = await getDoc(doc(this.db, 'proyectos', id));
      return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
    },
    async addProyecto(data) {
      const { collection, addDoc } = this.fb;
      const payload = Object.assign({ proyeccion: {}, presupuesto: {}, createdAt: Date.now(), updatedAt: Date.now() }, data);
      const ref = await addDoc(collection(this.db, 'proyectos'), payload);
      return Object.assign({ id: ref.id }, payload);
    },
    async updateProyecto(id, patch) {
      const { doc, setDoc } = this.fb;
      patch = Object.assign({}, patch, { updatedAt: Date.now() });
      await setDoc(doc(this.db, 'proyectos', id), patch, { merge: true });
      return this.getProyecto(id);
    },
    async deleteProyecto(id) {
      const { doc, deleteDoc } = this.fb;
      await deleteDoc(doc(this.db, 'proyectos', id));
    },

    async getCajaReal() {
      const { collection, getDocs } = this.fb;
      const qs = await getDocs(collection(this.db, 'cajaReal'));
      const out = {};
      qs.docs.forEach((d) => { out[d.id] = d.data(); });
      return out;
    },
    async setCajaRealMes(mes, monto, nota) {
      const { doc, setDoc, deleteDoc } = this.fb;
      const ref = doc(this.db, 'cajaReal', mes);
      if (monto === null || monto === undefined || monto === '') await deleteDoc(ref);
      else await setDoc(ref, { monto: Number(monto), nota: nota || '' });
      return this.getCajaReal();
    },

    async addImportLog(entry) {
      const { collection, addDoc } = this.fb;
      await addDoc(collection(this.db, 'importLog'), Object.assign({ importedAt: Date.now() }, entry));
    },
    async listImportLog() {
      const { collection, query, orderBy, limit, getDocs } = this.fb;
      const qs = await getDocs(query(collection(this.db, 'importLog'), orderBy('importedAt', 'desc'), limit(200)));
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },

    // Rol de un correo (admin/lector), o null si no tiene documento asignado.
    // Solo lectura desde la app — el documento se crea/edita por consola o CLI,
    // nunca por las reglas de Firestore (ver AGENTS.md).
    async getRole(email) {
      const { doc, getDoc } = this.fb;
      const snap = await getDoc(doc(this.db, 'roles', (email || '').toLowerCase()));
      return snap.exists() ? snap.data().role : null;
    },
  };

  // ----------------------------------------------------------------------
  // Fachada pública
  // ----------------------------------------------------------------------
  const DB = {
    mode: 'local',
    backend: Local,

    // En modo Firebase NO se siembra acá: las reglas de Firestore exigen sesión
    // iniciada, y a esta altura todavía no hay login. app.js llama a
    // DB.ensureSeed() explícitamente recién después de un login válido (ver
    // setupAuthUI en app.js).
    async init() {
      if (window.__fb) {
        this.mode = 'firebase';
        this.backend = Fire;
      } else {
        this.mode = 'local';
        this.backend = Local;
        await this.ensureSeed();
      }
      return this.mode;
    },

    // Asegura que las 5 categorías estándar existan (por nombre, idempotente) — no solo la
    // primera vez: si queda alguna categoría de una versión anterior y se borran las demás,
    // esto repone las que falten sin duplicar las que ya están.
    async ensureSeed() {
      const cats = await this.backend.listCategorias();
      const nombres = new Set(cats.map((c) => c.nombre));
      for (const nombre of CATEGORIAS_SEMILLA) {
        if (!nombres.has(nombre)) await this.backend.addCategoria(nombre);
      }
    },

    categoriasSemilla: CATEGORIAS_SEMILLA,
  };

  // Reexporta cada método del backend en la fachada.
  const METHODS = [
    'getConfig', 'setConfig',
    'listCategorias', 'addCategoria', 'updateCategoria', 'deleteCategoria',
    'listProyectos', 'getProyecto', 'addProyecto', 'updateProyecto', 'deleteProyecto',
    'getCajaReal', 'setCajaRealMes',
    'addImportLog', 'listImportLog',
    'getRole',
  ];
  METHODS.forEach((m) => {
    DB[m] = function (...args) { return this.backend[m](...args); };
  });

  window.DB = DB;
})();

// ============================================================================
// data.js — Capa de datos unificada
// ----------------------------------------------------------------------------
// Expone `window.DB`, una API async idéntica para dos backends:
//   - 'firebase' : Firestore v8 (nube, multiusuario) cuando hay FIREBASE_CONFIG.
//   - 'local'    : localStorage (un solo navegador) cuando no lo hay.
// app.js consume esta API sin saber qué backend está activo.
//
// Colecciones / claves:
//   config/global            { cajaInicial, mesInicial:'YYYY-MM', moneda, umbralAlerta }
//   categorias/{id}          { nombre, orden }
//   proyectos/{id}           { nombre, categoriaId, moneda, proyeccion:{'YYYY-MM':neto},
//                              presupuesto:{'YYYY-MM':neto} (línea base, se carga una sola vez),
//                              ultimaImportacion, createdAt, updatedAt }
//   cajaReal/{YYYY-MM}       { monto, nota }
//   importLog/{id}           { projId, fileName, sheet, meses, importedAt, byEmail }
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
  };

  // ----------------------------------------------------------------------
  // Backend FIREBASE (Firestore v8)
  // ----------------------------------------------------------------------
  const Fire = {
    get db() { return firebase.firestore(); },

    async getConfig() {
      const snap = await this.db.collection('config').doc('global').get();
      return Object.assign({}, CONFIG_DEFAULT, snap.exists ? snap.data() : {});
    },
    async setConfig(patch) {
      patch = Object.assign({}, patch, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      await this.db.collection('config').doc('global').set(patch, { merge: true });
      return this.getConfig();
    },

    async listCategorias() {
      const qs = await this.db.collection('categorias').get();
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.orden || 0) - (b.orden || 0));
    },
    async addCategoria(nombre) {
      const list = await this.listCategorias();
      const ref = await this.db.collection('categorias').add({ nombre, orden: list.length });
      return { id: ref.id, nombre, orden: list.length };
    },
    async updateCategoria(id, patch) {
      await this.db.collection('categorias').doc(id).set(patch, { merge: true });
    },
    async deleteCategoria(id) {
      await this.db.collection('categorias').doc(id).delete();
    },

    async listProyectos() {
      const qs = await this.db.collection('proyectos').get();
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
    async getProyecto(id) {
      const snap = await this.db.collection('proyectos').doc(id).get();
      return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
    },
    async addProyecto(data) {
      const payload = Object.assign({ proyeccion: {}, presupuesto: {}, createdAt: Date.now(), updatedAt: Date.now() }, data);
      const ref = await this.db.collection('proyectos').add(payload);
      return Object.assign({ id: ref.id }, payload);
    },
    async updateProyecto(id, patch) {
      patch = Object.assign({}, patch, { updatedAt: Date.now() });
      await this.db.collection('proyectos').doc(id).set(patch, { merge: true });
      return this.getProyecto(id);
    },
    async deleteProyecto(id) {
      await this.db.collection('proyectos').doc(id).delete();
    },

    async getCajaReal() {
      const qs = await this.db.collection('cajaReal').get();
      const out = {};
      qs.docs.forEach((d) => { out[d.id] = d.data(); });
      return out;
    },
    async setCajaRealMes(mes, monto, nota) {
      const ref = this.db.collection('cajaReal').doc(mes);
      if (monto === null || monto === undefined || monto === '') await ref.delete();
      else await ref.set({ monto: Number(monto), nota: nota || '' });
      return this.getCajaReal();
    },

    async addImportLog(entry) {
      await this.db.collection('importLog').add(Object.assign({ importedAt: Date.now() }, entry));
    },
    async listImportLog() {
      const qs = await this.db.collection('importLog').orderBy('importedAt', 'desc').limit(200).get();
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
  };

  // ----------------------------------------------------------------------
  // Fachada pública
  // ----------------------------------------------------------------------
  const DB = {
    mode: 'local',
    backend: Local,

    async init() {
      const cfg = window.FIREBASE_CONFIG;
      if (cfg && cfg.apiKey && typeof firebase !== 'undefined') {
        firebase.initializeApp(cfg);
        this.mode = 'firebase';
        this.backend = Fire;
      } else {
        this.mode = 'local';
        this.backend = Local;
      }
      await this.ensureSeed();
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
  ];
  METHODS.forEach((m) => {
    DB[m] = function (...args) { return this.backend[m](...args); };
  });

  window.DB = DB;
})();

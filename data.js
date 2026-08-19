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
//                              anioConstruccion, grupoPadre (opcional, agrupa sub-proyectos en
//                              "Por proyecto" — ver app.js), ultimaImportacion, createdAt, updatedAt }
//   cajaReal/{YYYY-MM}       { monto, nota }
//   importLog/{id}           { projId, fileName, sheet, meses, importedAt, byEmail }
//   snapshots/{id}           { nombre, fecha, proyectos:[{id,categoriaId,nombre,proyeccion}] }
//                            — versión guardada del flujo de caja (ej. "Directorio 2026-08-05"),
//                            solo para ver/comparar en Resumen Directorio; append-only, no se edita.
//   roles/{email}            { role: 'admin'|'lector', nombre, addedAt } — solo lectura desde
//                            la app; se crea/edita por consola o CLI (ver firestore.rules).
//   planProyectos/{id}       { nombre, proyectoId:null (por ahora, se agregan a mano por nombre;
//                              a futuro se vinculará con proyectos/*), promesaCompraventa:
//                              'YYYY-MM-DD'|null, fechaInicioConstruccion:'YYYY-MM-DD'|null,
//                              etapas:{ [etapaId]: { inicio, fin, comentario } } } — vista
//                            "Planificación" (debajo de Programar pagos): seguimiento de etapas
//                            de negocio de un proyecto. Ver ETAPAS_PLANIFICACION/PLAN_HITO_REGLAS
//                            en app.js (promesaCompraventa/fechaInicioConstruccion son las 2
//                            fechas hito que disparan alertas de "debe iniciar N meses antes").
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

    async addSnapshot(nombre, proyectos) {
      const list = this._get('snapshots', []);
      const snap = {
        id: uid('snap_'),
        nombre,
        fecha: Date.now(),
        proyectos: (proyectos || []).map((p) => ({ id: p.id, categoriaId: p.categoriaId, nombre: p.nombre, proyeccion: p.proyeccion || {} })),
      };
      list.unshift(snap);
      this._set('snapshots', list.slice(0, 50));
      return snap;
    },
    async listSnapshots() {
      return this._get('snapshots', []).map(({ id, nombre, fecha }) => ({ id, nombre, fecha }));
    },
    async getSnapshot(id) {
      return this._get('snapshots', []).find((s) => s.id === id) || null;
    },
    async deleteSnapshot(id) {
      this._set('snapshots', this._get('snapshots', []).filter((s) => s.id !== id));
    },

    async listPlanProyectos() {
      return this._get('planProyectos', []);
    },
    async addPlanProyecto(nombre) {
      const list = this._get('planProyectos', []);
      // proyectoId queda null por ahora: se agregan a mano por nombre libre, sin vincular a un
      // proyecto real de proyectos/* todavía (ver comentario en app.js/renderPlanificacion).
      const p = { id: uid('plan_'), nombre, proyectoId: null, promesaCompraventa: null, fechaInicioConstruccion: null, etapas: {}, createdAt: Date.now(), updatedAt: Date.now() };
      list.push(p);
      this._set('planProyectos', list);
      return p;
    },
    async updatePlanProyecto(id, patch) {
      const list = this._get('planProyectos', []);
      const i = list.findIndex((p) => p.id === id);
      if (i >= 0) { list[i] = Object.assign({}, list[i], patch, { updatedAt: Date.now() }); this._set('planProyectos', list); return list[i]; }
      return null;
    },
    async deletePlanProyecto(id) {
      this._set('planProyectos', this._get('planProyectos', []).filter((p) => p.id !== id));
    },

    // Modo local no tiene login: quien abre el navegador ya es dueño de sus propios datos.
    async getRole() {
      return 'dueño';
    },
    // Sin concepto de "otros usuarios" en modo local — no aplica.
    async listRoles() {
      return [];
    },
    async setRole() {},
    async deleteRole() {},
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

    async addSnapshot(nombre, proyectos) {
      const { collection, addDoc } = this.fb;
      const payload = {
        nombre,
        fecha: Date.now(),
        proyectos: (proyectos || []).map((p) => ({ id: p.id, categoriaId: p.categoriaId, nombre: p.nombre, proyeccion: p.proyeccion || {} })),
      };
      const ref = await addDoc(collection(this.db, 'snapshots'), payload);
      return Object.assign({ id: ref.id }, payload);
    },
    async listSnapshots() {
      const { collection, query, orderBy, getDocs } = this.fb;
      const qs = await getDocs(query(collection(this.db, 'snapshots'), orderBy('fecha', 'desc')));
      return qs.docs.map((d) => ({ id: d.id, nombre: d.data().nombre, fecha: d.data().fecha }));
    },
    async getSnapshot(id) {
      const { doc, getDoc } = this.fb;
      const snap = await getDoc(doc(this.db, 'snapshots', id));
      return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
    },
    async deleteSnapshot(id) {
      const { doc, deleteDoc } = this.fb;
      await deleteDoc(doc(this.db, 'snapshots', id));
    },

    async listPlanProyectos() {
      const { collection, getDocs } = this.fb;
      const qs = await getDocs(collection(this.db, 'planProyectos'));
      return qs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
    async addPlanProyecto(nombre) {
      const { collection, addDoc } = this.fb;
      const payload = { nombre, proyectoId: null, promesaCompraventa: null, fechaInicioConstruccion: null, etapas: {}, createdAt: Date.now(), updatedAt: Date.now() };
      const ref = await addDoc(collection(this.db, 'planProyectos'), payload);
      return Object.assign({ id: ref.id }, payload);
    },
    async updatePlanProyecto(id, patch) {
      const { doc, setDoc } = this.fb;
      patch = Object.assign({}, patch, { updatedAt: Date.now() });
      await setDoc(doc(this.db, 'planProyectos', id), patch, { merge: true });
      const { getDoc } = this.fb;
      const snap = await getDoc(doc(this.db, 'planProyectos', id));
      return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
    },
    async deletePlanProyecto(id) {
      const { doc, deleteDoc } = this.fb;
      await deleteDoc(doc(this.db, 'planProyectos', id));
    },

    // Rol de un correo (dueño/editor/lector), o null si no tiene documento asignado.
    async getRole(email) {
      const { doc, getDoc } = this.fb;
      const snap = await getDoc(doc(this.db, 'roles', (email || '').toLowerCase()));
      return snap.exists() ? snap.data().role : null;
    },
    // Solo el dueño puede llamar a estos 3 en la práctica (las reglas de Firestore lo exigen);
    // setRole además solo acepta 'editor'/'lector' — asignar "dueño" queda fuera de la app
    // a propósito (ver firestore.rules y AGENTS.md).
    async listRoles() {
      const { collection, getDocs } = this.fb;
      const qs = await getDocs(collection(this.db, 'roles'));
      return qs.docs.map((d) => Object.assign({ email: d.id }, d.data()));
    },
    async setRole(email, role) {
      const { doc, setDoc, serverTimestamp } = this.fb;
      await setDoc(doc(this.db, 'roles', (email || '').toLowerCase()), { role, updatedAt: serverTimestamp() });
    },
    async deleteRole(email) {
      const { doc, deleteDoc } = this.fb;
      await deleteDoc(doc(this.db, 'roles', (email || '').toLowerCase()));
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
    'addSnapshot', 'listSnapshots', 'getSnapshot', 'deleteSnapshot',
    'listPlanProyectos', 'addPlanProyecto', 'updatePlanProyecto', 'deletePlanProyecto',
    'getRole', 'listRoles', 'setRole', 'deleteRole',
  ];
  METHODS.forEach((m) => {
    DB[m] = function (...args) { return this.backend[m](...args); };
  });

  window.DB = DB;
})();

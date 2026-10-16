/* ==========================================================================
   Redline — js/arcade/mode.js
   CB.arcade.mode : the Arcade game mode core (docs/ARCADE-SPEC.md §1-§4). Pure logic (no DOM), Node-loadable.

   Arcade is its own top-level mode (#/arcade), separate from Race and Drift: every car (player + AI) runs the
   arcade vehicle model (CB.race.vehicle with params.handling === 'arcade': no traction loss at all), on the
   stunt tracks (CB.arcade.stunt, feature-detected) or on any normal circuit. Race and Drift never touch this.

     CB.arcade.mode.DEFAULTS / MODES / DIFFICULTIES
     sanitize(settings) -> arcade session settings { trackId, mode, laps, opponents, difficulty, weather, timeOfDay, options }
     registerExtension(ext) -> unregister()     gameplay layers (nitro / items / speed classes ...), see ARCADE-SPEC §3
     extensions() / optionDefs()                registered extensions / their setup options (sorted by ext.order)
     trackEntries(circuits) -> [{ id, name, kind 'stunt'|'circuit', def }]   stunt tracks FIRST, then the circuits
     isStunt(idOrDef)                           is this a CB.arcade.stunt track?
     engineConfig(base, settings) -> engine cfg (handling 'arcade' + extension hooks)
     createSession(cfg, opts) -> session        stunt: CB.arcade.stunt.createSession(cfg); circuit: opts.createCircuit(cfg)
                                                (race-ui wraps the assist) or CB.race.engine.createSession(cfg). The returned
                                                session has the engine surface (update / snapshot / results / ...), with
                                                snapshot().arcade = { handling, kind, ext: { [id]: ... } } and extension
                                                entities / HUD hooks reachable through session.arcade.
     RECORDS_KEY                                localStorage key of the separate arcade best-lap store
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  var MODES = [
    { id: 'race', name: 'Race', desc: 'Grid start against arcade AI. First across the line wins' },
    { id: 'time-trial', name: 'Time trial', desc: 'Solo hot laps against your arcade ghost' }
  ];
  var DIFFICULTIES = [
    { id: 'rookie', name: 'Rookie', desc: 'Relaxed rivals' },
    { id: 'amateur', name: 'Amateur', desc: 'A fair fight' },
    { id: 'pro', name: 'Pro', desc: 'Quick, clean rivals' },
    { id: 'alien', name: 'Alien', desc: 'Flat out, every lap' }
  ];
  var DEFAULTS = { trackId: null, mode: 'race', laps: 3, opponents: 7, difficulty: 'amateur', weather: 'dry', timeOfDay: 'day', options: {} };
  var RECORDS_KEY = 'forge.arcade.records.v1';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ids(list) { return list.map(function (o) { return o.id; }); }

  /* ---------------------------------------------------------------- extensions */
  var EXT = [];
  function registerExtension(ext) {
    if (!isObj(ext) || !ext.id) throw new Error('arcade.registerExtension: ext.id required');
    EXT = EXT.filter(function (e) { return e.id !== ext.id; });
    EXT.push(ext);
    EXT.sort(function (a, b) { return num(a.order, 50) - num(b.order, 50); });
    return function () { EXT = EXT.filter(function (e) { return e !== ext; }); };
  }
  function extensions() { return EXT.slice(); }
  /** Setup options of every extension: [{ ext, id, name, desc, type 'choice'|'toggle', choices?, default }]. */
  function optionDefs() {
    var out = [];
    EXT.forEach(function (e) {
      (Array.isArray(e.options) ? e.options : []).forEach(function (o) {
        if (!o || !o.id) return;
        out.push(Object.assign({ ext: e.id, type: Array.isArray(o.choices) ? 'choice' : 'toggle' }, o));
      });
    });
    return out;
  }
  function optionValue(def, v) {
    if (def.type === 'choice') {
      var c = def.choices || [];
      return ids(c).indexOf(v) >= 0 ? v : (def.default != null && ids(c).indexOf(def.default) >= 0 ? def.default : (c[0] && c[0].id));
    }
    return v == null ? def.default !== false : !!v;
  }

  /* ---------------------------------------------------------------- settings */
  function sanitize(s) {
    s = isObj(s) ? s : {};
    var o = {};
    o.trackId = typeof s.trackId === 'string' && s.trackId ? s.trackId : null;
    o.mode = ids(MODES).indexOf(s.mode) >= 0 ? s.mode : DEFAULTS.mode;
    o.laps = Math.round(clamp(num(s.laps, DEFAULTS.laps), 1, 20));
    o.opponents = Math.round(clamp(num(s.opponents, DEFAULTS.opponents), 1, 11));
    o.difficulty = ids(DIFFICULTIES).indexOf(s.difficulty) >= 0 ? s.difficulty : DEFAULTS.difficulty;
    o.weather = ['dry', 'damp', 'wet'].indexOf(s.weather) >= 0 ? s.weather : DEFAULTS.weather;
    o.timeOfDay = ['day', 'dusk', 'night'].indexOf(s.timeOfDay) >= 0 ? s.timeOfDay : DEFAULTS.timeOfDay;
    // no steerAssist: arcade handling needs no assist layer (a stored level from older saves is ignored)
    var opts = isObj(s.options) ? s.options : {};
    o.options = {};
    optionDefs().forEach(function (d) { o.options[d.id] = optionValue(d, opts[d.id]); });
    Object.keys(opts).forEach(function (k) { if (!(k in o.options)) o.options[k] = opts[k]; });   // keep values of not-yet-loaded extensions
    return o;
  }

  /* ---------------------------------------------------------------- tracks */
  function stuntMod() { var S = CB.arcade && CB.arcade.stunt; return S && typeof S.list === 'function' ? S : null; }
  function stuntList() {
    var S = stuntMod();
    if (!S) return [];
    try { var l = S.list(); return Array.isArray(l) ? l.filter(function (t) { return t && t.id; }) : []; } catch (e) { return []; }
  }
  function isStunt(t) {
    if (!t) return false;
    if (isObj(t) && (t.stunt === true || t.kind === 'stunt')) return true;
    var id = isObj(t) ? t.id : t;
    return stuntList().some(function (s) { return s.id === id; });
  }
  /** Stunt tracks first, then the normal circuits (drift venues last). circuits = race-ui's track defs. */
  function trackEntries(circuits) {
    var out = [];
    stuntList().forEach(function (d) { out.push({ id: d.id, name: d.name || d.id, kind: 'stunt', def: d }); });
    (Array.isArray(circuits) ? circuits : []).forEach(function (d) {
      if (d && d.id && !out.some(function (e) { return e.id === d.id; })) out.push({ id: d.id, name: d.name || d.id, kind: 'circuit', def: d });
    });
    return out;
  }

  /* ---------------------------------------------------------------- sessions */
  function mulberry(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /** Engine cfg for an arcade session. base = the race-ui / test cfg; settings = sanitize()d arcade settings. */
  function engineConfig(base, settings) {
    var c = Object.assign({}, base || {});
    var S = sanitize(settings || c.arcade || {});
    c.handling = 'arcade';
    c.arcade = S;
    if (c.seed == null) c.seed = (Math.floor(Math.random() * 4294967296)) >>> 0;   // fixed at creation: the sim stays deterministic
    c.persistGhost = c.persistGhost !== false;
    return c;
  }

  /** Instantiate the extensions for a session (before it is created: their engine hooks go into cfg.hooks). */
  function instantiate(cfg, kind) {
    var list = [];
    EXT.forEach(function (e) {
      var ctx = {
        cfg: cfg, kind: kind, settings: cfg.arcade, options: (cfg.arcade && cfg.arcade.options) || {}, mode: cfg.mode,
        seed: (num(cfg.seed, 1) ^ hashStr(e.id)) >>> 0, rng: mulberry((num(cfg.seed, 1) ^ hashStr(e.id)) >>> 0),
        vehicle: CB.race && CB.race.vehicle, playerId: 'player', track: cfg.track || null
      };
      try {
        if (typeof e.appliesTo === 'function' && !e.appliesTo(ctx)) return;
        var inst = typeof e.create === 'function' ? e.create(ctx) : null;
        if (inst) { inst._ext = e; list.push(inst); }
      } catch (err) { if (typeof console !== 'undefined') console.warn('[arcade] extension ' + e.id + ' failed', err); }
    });
    return list;
  }
  function call(inst, fn, args) {
    if (!inst || typeof inst[fn] !== 'function') return undefined;
    try { return inst[fn].apply(inst, args || []); } catch (e) {
      if (!inst._warned) { inst._warned = true; if (typeof console !== 'undefined') console.warn('[arcade] ' + (inst._ext && inst._ext.id) + '.' + fn, e); }
      return undefined;
    }
  }

  /**
   * createSession(cfg, opts) -> session
   *   cfg  engine-style cfg (trackId, track, laps, opponents, playerBuild, assists, seed, ...) + cfg.arcade settings
   *   opts { createCircuit(cfg) -> session }   race-ui passes its assist-aware session factory for normal circuits
   */
  function createSession(cfgIn, opts) {
    opts = opts || {};
    var cfg = engineConfig(cfgIn, cfgIn && cfgIn.arcade);
    var kind = isStunt(cfg.track || cfg.trackId) ? 'stunt' : 'circuit';
    var insts = instantiate(cfg, kind);
    var hooks = [].concat(cfg.hooks || []);
    insts.forEach(function (i) { if (i.hooks) hooks = hooks.concat(i.hooks); });
    cfg.hooks = hooks.length ? hooks : undefined;
    var inner;
    if (kind === 'stunt') inner = stuntMod().createSession(cfg);
    else if (typeof opts.createCircuit === 'function') inner = opts.createCircuit(cfg);
    else inner = CB.race.engine.createSession(cfg);
    if (!inner || typeof inner.snapshot !== 'function') throw new Error('arcade: session factory returned no session');
    insts.forEach(function (i) { call(i, 'attach', [inner]); });
    return wrap(inner, cfg, kind, insts);
  }

  /** own-property override on the wrapper (the inner session may expose getter-only accessors, e.g. drift sessions) */
  function def(o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: true }); }
  /** Same surface as the inner session; snapshot() / results() gain the arcade block. */
  function wrap(inner, cfg, kind, insts) {
    var s = Object.create(inner);
    var A = {
      kind: kind, handling: 'arcade', settings: cfg.arcade, instances: insts,
      /** world entities for renderers / HUD: [{ id, type, x, y, z?, heading?, radius?, color?, glyph?, ext }] */
      entities: function (snap) {
        var out = [];
        insts.forEach(function (i) { var l = call(i, 'entities', [snap]); if (Array.isArray(l)) l.forEach(function (e) { if (e) { e.ext = e.ext || i._ext.id; out.push(e); } }); });
        return out;
      },
      /** draw every extension's HUD widgets: ctx (CSS px transform already set), view { width, height, project, units, renderer } */
      drawHud: function (ctx, snap, view) { insts.forEach(function (i) { call(i, 'drawHud', [ctx, snap, view]); }); },
      setRenderer: function (r) { insts.forEach(function (i) { call(i, 'setRenderer', [r]); }); },
      /** host-authoritative networking later (ARCADE-SPEC §6): extension state in / out */
      serialize: function () { var o = {}; insts.forEach(function (i) { var v = call(i, 'serialize'); if (v !== undefined) o[i._ext.id] = v; }); return o; },
      restore: function (o) { o = o || {}; insts.forEach(function (i) { if (o[i._ext.id] !== undefined) call(i, 'restore', [o[i._ext.id]]); }); },
      destroy: function () { insts.forEach(function (i) { call(i, 'destroy'); }); }
    };
    def(s, 'arcade', A);
    var innerCfg = inner.config;
    def(s, 'config', innerCfg && typeof innerCfg === 'object' ? innerCfg : cfg);
    def(s, 'update', function () { return inner.update.apply(inner, arguments); });
    def(s, 'snapshot', function () {
      var snap = inner.snapshot.apply(inner, arguments);
      if (snap && typeof snap === 'object') {
        snap.handling = 'arcade';
        var ext = {};
        insts.forEach(function (i) { var v = call(i, 'snapshot', [snap]); if (v !== undefined) ext[i._ext.id] = v; });
        snap.arcade = { handling: 'arcade', kind: kind, mode: cfg.mode, ext: ext };
      }
      return snap;
    });
    def(s, 'results', function () {
      var r = typeof inner.results === 'function' ? inner.results.apply(inner, arguments) : null;
      if (r && typeof r === 'object') {
        r.handling = 'arcade';
        r.arcade = { kind: kind, mode: cfg.mode, settings: cfg.arcade };
        insts.forEach(function (i) { call(i, 'results', [r]); });
      }
      return r;
    });
    // tearing the session down must also destroy the extensions: their window key listeners run in the capture phase and
    // stop propagation, so a stale layer from the previous race would swallow N / F (nitro, item) in the next one
    def(s, 'destroy', function () {
      A.destroy();
      return typeof inner.destroy === 'function' ? inner.destroy.apply(inner, arguments) : undefined;
    });
    if (typeof inner.restart === 'function') def(s, 'restart', function () { var v = inner.restart.apply(inner, arguments); insts.forEach(function (i) { call(i, 'reset'); }); return v; });
    return s;
  }

  CB.arcade.mode = {
    VERSION: 1, HANDLING: 'arcade', MODES: MODES, DIFFICULTIES: DIFFICULTIES, DEFAULTS: DEFAULTS, RECORDS_KEY: RECORDS_KEY,
    sanitize: sanitize, registerExtension: registerExtension, extensions: extensions, optionDefs: optionDefs,
    trackEntries: trackEntries, stuntTracks: stuntList, isStunt: isStunt,
    engineConfig: engineConfig, createSession: createSession,
    _internal: { mulberry: mulberry, wrap: wrap, instantiate: instantiate }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.arcade.mode;

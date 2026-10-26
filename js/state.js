/* ==========================================================================
   FORGE Atelier — js/state.js
   CB.state : the single store for the Build object.

   API
     get()                              current build (frozen-by-convention, never mutate)
     set(path, value, opts)             immutable leaf update. opts: { silent, noHistory, label, noCoalesce }
     patch(partial, opts)               deep merge. opts as above
     replace(build, opts)               whole replacement. opts also { resetHistory }
     reset(opts)                        replace with starterBuild(current model) ("New build": a factory car)
     subscribe(fn)                      fn(build, change) — change = { path, value, label, type, paths }
                                        type: 'set' | 'patch' | 'replace' | 'undo' | 'redo' | 'boot'
     undo() / redo() / canUndo() / canRedo()
     history()                          array of past labels (oldest → newest)
     historyDetail()                    { past:[{label,path,time}], future:[...] }
     normalize(build, ctx?)             pure; ctx = { paths:[changed leaf paths], prev: previousBuild }
     encode(build) / decode(str)        URL-safe share codes ("v1." + base64url(JSON of diff vs default))
     shareURL(build?)                   absolute URL with '#b=<code>'
     saveLocal(build?) / listLocal() / loadLocal(id) / deleteLocal(id) / renameLocal(id, name) / duplicateLocal(id)
     exportJSON(build?) / importJSON(str)
     boot({force})                      restore order: '#b=' hash → autosave 'forge.current.v1' → default
     flushAutosave()
     defaultBuild()                     CB.data.defaultBuild() at the default real model's dimensions (fallback; share-code base)
     starterBuild(model?)               factory (CB.stock) spec of model / the default model, "<car>" e.g. "Porsche 911 Carrera S" (new builds, first boot)
     realDims(model|id|build)           partial build with the real car's wheelbase/track/ride height/wheel Ø/tyres (CB.shapes.refBuild)
     applyModel(id, opts)               pick a real model (+ its style) and its real dims as ONE undo step
     matchRealDims(opts)                snap the build to its shown model's real dims (one step; false when nothing changes)
     dimsDeviation(build?)              { model, items:[{path,label,unit,build,real,reachable,delta,big}], large, atLimit }
     modelOf(build|id)                  registered CB.shapes model the build shows (null without CB.shapes)

   Real dimensions: a set()/patch() that changes which real model the build shows (body.model, or a body.style whose
   default model differs) also applies that model's real dims in the same undo step, except for dimension paths the
   caller set in that change. Pass { realDims: false } to opt out.

   History: capped at 100 steps. Consecutive set() calls on the SAME path within 600 ms are coalesced into one
   undo step (slider drags). patch/replace always create a new step unless opts.coalesceKey matches the last one.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var U = CB.util;
  var GARAGE_KEY = 'forge.garage.v1';
  var CURRENT_KEY = 'forge.current.v1';
  var HISTORY_CAP = 100;
  var COALESCE_MS = 600;
  var hasWindow = typeof window !== 'undefined';

  function D() { return CB.data; }

  /* ---------------------------------------------------------------- storage (guarded) */
  var memoryStore = (function () {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      clear: function () { m = {}; }
    };
  })();

  var storage = (function () {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        var t = '__forge_test__';
        localStorage.setItem(t, '1'); localStorage.removeItem(t);
        return localStorage;
      }
    } catch (e) { /* file:// in some browsers, private mode, Node */ }
    return memoryStore;
  })();

  function readJSON(key, fallback) {
    try { var s = storage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { storage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { if (typeof console !== 'undefined') console.warn('[CB.state] storage write failed', e); return false; }
  }

  /* ---------------------------------------------------------------- normalize helpers */
  function num(v, fallback) { var n = Number(v); return isFinite(n) ? n : fallback; }
  function bool(v, fallback) { return typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : (v == null ? fallback : !!v)); }
  function rangeOf(path) { return (D().ranges && D().ranges[path]) || null; }

  function clampStep(v, min, max, step, fallback) {
    var n = num(v, fallback);
    n = U.clamp(n, min, max);
    if (step) n = U.snap(n, step, 0);
    return U.clamp(n, min, max);
  }
  function rng(v, path, fallback, overrideMin, overrideMax) {
    var r = rangeOf(path) || { min: -Infinity, max: Infinity, step: 0 };
    var min = overrideMin != null ? Math.max(r.min, overrideMin) : r.min;
    var max = overrideMax != null ? Math.min(r.max, overrideMax) : r.max;
    var n = num(v, fallback);
    n = U.clamp(n, min, max);
    if (r.step) n = U.snap(n, r.step, r.base || 0);
    if (n < min) n = U.snap(n + r.step, r.step, r.base || 0);
    if (n > max) n = U.snap(n - r.step, r.step, r.base || 0);
    return n;
  }
  function optId(coll, v, fallback) {
    var o = D().find(coll, v);
    return o ? o.id : fallback;
  }
  function hex(v, fallback) { return U.normHex(v, fallback); }

  /** Keep only keys that exist in the template (schema), merging values from src. Arrays/leaves taken from src. */
  function conform(template, src) {
    var out = {};
    Object.keys(template).forEach(function (k) {
      var t = template[k], s = src ? src[k] : undefined;
      if (U.isPlainObject(t)) out[k] = conform(t, U.isPlainObject(s) ? s : {});
      else out[k] = s === undefined ? U.deepClone(t) : U.deepClone(s);
    });
    return out;
  }

  /** Flatten an object into leaf paths. */
  function leafPaths(obj, prefix, out) {
    out = out || []; prefix = prefix || '';
    if (!U.isPlainObject(obj)) { if (prefix) out.push(prefix); return out; }
    Object.keys(obj).forEach(function (k) {
      var p = prefix ? prefix + '.' + k : k;
      if (U.isPlainObject(obj[k])) leafPaths(obj[k], p, out); else out.push(p);
    });
    return out;
  }

  function changed(ctx, path) {
    if (!ctx || !ctx.paths) return false;
    for (var i = 0; i < ctx.paths.length; i++) {
      var p = ctx.paths[i];
      if (p === path || p.indexOf(path + '.') === 0 || path.indexOf(p + '.') === 0) return true;
    }
    return false;
  }
  function prevVal(ctx, path) { return ctx && ctx.prev ? U.get(ctx.prev, path) : undefined; }

  /**
   * body.model: CB.shapes real-car model id (js/shapes/README.md); null = the style's default model (what
   * CB.shapes.getModel resolves to, mirrored by CB.data.bodyStyles[].defaultModel). normalize keeps it valid for the
   * current body style: changing body.style (without picking a model in the same change), a malformed id, a model of
   * another style or an unknown id (when that style's models are registered) all resolve to the style default (null).
   * When CB.shapes is not loaded at all (Node tests, old pages) a well-formed id is kept so shared builds survive a
   * round trip, unless it is known (from the catalog) to be another style's default model.
   */
  function modelFor(body, ctx) {
    var id = body.model;
    if (changed(ctx, 'body.style') && !changed(ctx, 'body.model') && prevVal(ctx, 'body.style') !== body.style) return null;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return null;
    var S = (typeof globalThis !== 'undefined' && globalThis.CB && globalThis.CB.shapes) || null;
    if (!S || !S.models || typeof S.modelsByStyle !== 'function' || !Object.keys(S.models).length) {
      var styles = D().bodyStyles || [];
      for (var i = 0; i < styles.length; i++) if (styles[i].id !== body.style && styles[i].defaultModel === id) return null;
      return id;
    }
    var m = S.models[id];
    if (m) return m.style === body.style ? id : null;
    // unknown id: drop it when this style's models are registered (a typo / removed model); a page that loaded only
    // some model files keeps it (renderers fall back to the style default via getModel anyway)
    var forStyle = [];
    try { forStyle = S.modelsByStyle(body.style) || []; } catch (e) { forStyle = []; }
    return forStyle.length ? null : id;
  }

  /* ---------------------------------------------------------------- real dimensions (CB.shapes.refBuild) */
  /** Build paths a real model's reference dimensions drive. */
  var REAL_DIM_PATHS = ['body.wheelbase_mm', 'body.trackWidth_mm', 'suspension.rideHeight_mm', 'wheels.diameter_in',
    'tires.widthFront_mm', 'tires.widthRear_mm', 'tires.profileFront', 'tires.profileRear'];
  function shapesLib() {
    var S = (typeof globalThis !== 'undefined' && globalThis.CB && globalThis.CB.shapes) || null;
    return S && S.models && typeof S.refBuild === 'function' && typeof S.getModel === 'function' ? S : null;
  }
  /** Registered model (object) a build shows: body.model when valid for body.style, else the style default. null without CB.shapes. */
  function modelOf(build) {
    var S = shapesLib();
    if (!S) return null;
    if (typeof build === 'string') return S.models[build] || null;
    if (build && build.ref && build.id) return build;
    var m = null;
    try { m = S.getModel(build || get(), { strict: true }); } catch (e) { m = null; }
    var style = build && build.body && build.body.style;
    return m && m.ref && (!style || m.style === style) ? m : null;
  }
  /**
   * realDims(modelOrIdOrBuild) — partial build with the real car's wheelbase, track, ride height, wheel diameter and
   * tyre sizes (CB.shapes.refBuild; staggered on when the real car is), or null when unknown. No style/model keys.
   */
  function realDims(src) {
    var m = modelOf(src), S = shapesLib();
    if (!m) return null;
    var r;
    try { r = S.refBuild(m); } catch (e) { return null; }
    if (!r) return null;
    var out = {};
    REAL_DIM_PATHS.forEach(function (p) { var v = U.get(r, p); if (isFinite(Number(v))) out = U.set(out, p, Number(v)); });
    var t = r.tires || {};
    // rims sized to the real tyres (ideal fit, as the Wheels panel's "ideal rim fit"), so a model pick never leaves
    // the build with stretched / ballooned tyres (rules wheels.tire-rim-*)
    var tf = Number(U.get(out, 'tires.widthFront_mm')), tr = Number(U.get(out, 'tires.widthRear_mm'));
    if (isFinite(tf)) out = U.set(out, 'wheels.widthFront_in', idealRim_in(tf));
    if (isFinite(tr)) out = U.set(out, 'wheels.widthRear_in', idealRim_in(tr));
    var stag = t.widthFront_mm !== t.widthRear_mm || t.profileFront !== t.profileRear ||
      U.get(out, 'wheels.widthFront_in') !== U.get(out, 'wheels.widthRear_in');
    out = U.set(out, 'wheels.staggered', !!stag);
    return out;
  }
  /** Ideal rim width (in, 0.5" steps) for a tyre section width: 86% of the section (inside rules' 75–102% band). */
  function idealRim_in(tire_mm) {
    var w = Math.round(Number(tire_mm) / 25.4 * 0.86 * 2) / 2;
    var R = (typeof globalThis !== 'undefined' && globalThis.CB && globalThis.CB.rules) || null;
    if (R && typeof R.rimRange === 'function') {   // stay inside the rules' fit band after the 0.5" rounding
      var rr = R.rimRange(tire_mm);
      if (rr && w > rr[1]) w = Math.floor(rr[1] * 2) / 2;
      if (rr && w < rr[0]) w = Math.ceil(rr[0] * 2) / 2;
    }
    return Math.min(13, Math.max(6, w));
  }
  /**
   * Brakes that fit inside the wheels the real dims bring (rules brakes.front/rear-rotor-fit: rotor + 60 mm caliper
   * clearance inside the rim; brakes.material-wheel: the package's minimum wheel). Partial build ({} when all fits).
   * skip(path) -> true leaves a path the caller set explicitly.
   */
  function brakeFit(dims, base, skip) {
    var out = {}, d = Number(U.get(dims, 'wheels.diameter_in'));
    if (!isFinite(d) || !base) return out;
    var maxRotor = Math.floor((d * 25.4 - 60) / 2) * 2;
    ['frontRotor_mm', 'rearRotor_mm'].forEach(function (k) {
      var p = 'brakes.' + k, v = Number(U.get(base, p));
      if (isFinite(v) && v > maxRotor && !(skip && skip(p))) out = U.set(out, p, maxRotor);
    });
    var mats = D().brakeMaterials || [], matId = U.get(base, 'brakes.material'), mat = null;
    for (var i = 0; i < mats.length; i++) if (mats[i].id === matId) mat = mats[i];
    if (mat && Number(mat.minWheel_in || 15) > d && !(skip && skip('brakes.material'))) {
      var fit = mats.filter(function (x) { return Number(x.minWheel_in || 15) <= d; }).pop();
      if (fit) out = U.set(out, 'brakes.material', fit.id);
    }
    return out;
  }
  /** defaultBuild() at the default model's real dimensions (falls back to CB.data.defaultBuild() without CB.shapes). */
  function defaultBuild() {
    var b = D().defaultBuild();
    var dims = realDims({ body: { style: b.body.style, model: b.body.model } });
    return dims ? U.deepMerge(b, dims) : b;
  }
  /**
   * starterBuild(model?) — what a NEW build starts from: the factory (stock) spec of a real car (CB.stock, Auto-config)
   * — by default the default model (Porsche 911 Carrera S), so the Simple Garage shows real levels ("Stock") from the
   * first visit instead of "Custom". Named like Auto-config names it (the car's title) with a fresh meta. Falls back to
   * defaultBuild() when CB.stock / CB.physics are not loaded (Node suites, pages without stock specs) or the model has
   * no factory spec. Share codes still diff against CB.data.defaultBuild(), so links are unaffected.
   */
  function starterBuild(model) {
    var St = CB.stock;
    if (!St || typeof St.build !== 'function' || typeof St.has !== 'function' || !CB.physics || typeof CB.physics.compute !== 'function') return defaultBuild();
    var id = null;
    try {
      var m = model ? modelOf(model) : null;
      if (!m || !St.has(m.id)) m = modelOf(defaultBuild());
      id = m && St.has(m.id) ? m.id : null;
    } catch (e) { id = null; }
    if (!id) return defaultBuild();
    var res = null;
    try { res = St.build(id); } catch (e) { res = null; }
    if (!res || !U.isPlainObject(res.build)) return defaultBuild();
    var b = U.deepClone(res.build), t = Date.now();
    b.meta = { name: String(res.title || id).slice(0, 60), id: U.uid('b'), created: t, modified: t, presetId: null };
    return b;
  }
  /**
   * When a set/patch changes which real model the build shows (picking body.model, or a body style that resolves to
   * another default model), fold that model's real dimensions into the same change, except for paths the caller set
   * explicitly. Returns { raw, paths } (unchanged when nothing applies). opts.realDims === false opts out.
   */
  function foldRealDims(raw, paths, prev, opts) {
    if ((opts && opts.realDims === false) || !shapesLib()) return null;
    var touches = paths.some(function (p) { return p === 'body' || p === 'body.style' || p === 'body.model'; });
    if (!touches) return null;
    var probe = normalize(raw, { paths: paths, prev: prev });
    var mNext = modelOf(probe), mPrev = modelOf(prev);
    if (!mNext || (mPrev && mPrev.id === mNext.id)) return null;
    var dims = realDims(mNext);
    if (!dims) return null;
    var ctx = { paths: paths };
    dims = U.deepMerge(dims, brakeFit(dims, probe, function (p) { return changed(ctx, p); }));
    var add = leafPaths(dims).filter(function (p) { return !changed(ctx, p); });
    if (!add.length) return null;
    var out = raw;
    add.forEach(function (p) { out = U.set(out, p, U.get(dims, p)); });
    return { raw: out, paths: paths.concat(add), model: mNext };
  }
  /**
   * dimsDeviation(build?) — how far the build sits from its real model.
   * { model, items:[{path,label,unit,build,real,reachable,delta,big}], large, atLimit:[paths the shell can't reach] }
   * big: |build-real| beyond a per-field tolerance AND matching would actually move the value (so shell limits never nag).
   */
  var DIM_TOL = {
    'body.wheelbase_mm': { label: 'Wheelbase', unit: 'mm', abs: 0, rel: 0.04 },
    'body.trackWidth_mm': { label: 'Track', unit: 'mm', abs: 0, rel: 0.04 },
    'suspension.rideHeight_mm': { label: 'Ride height', unit: 'mm', abs: 25, rel: 0.2 },
    'wheels.diameter_in': { label: 'Wheels', unit: 'in', abs: 2, rel: 0 },
    'tires.widthFront_mm': { label: 'Front tyres', unit: 'mm', abs: 30, rel: 0 },
    'tires.widthRear_mm': { label: 'Rear tyres', unit: 'mm', abs: 30, rel: 0 },
    'tires.profileFront': { label: 'Front profile', unit: '%', abs: 10, rel: 0 },
    'tires.profileRear': { label: 'Rear profile', unit: '%', abs: 10, rel: 0 }
  };
  function dimsDeviation(build) {
    build = build || get();
    var m = modelOf(build), dims = m && realDims(m);
    if (!dims) return { model: null, items: [], large: false, atLimit: [] };
    var reach = normalize(U.deepMerge(build, dims), { paths: leafPaths(dims), prev: build });
    var items = [], atLimit = [];
    REAL_DIM_PATHS.forEach(function (p) {
      var real = U.get(dims, p);
      if (!isFinite(real)) return;
      var tol = DIM_TOL[p], bv = Number(U.get(build, p)), rv = Number(U.get(reach, p));
      var delta = bv - real, lim = Math.max(tol.abs, Math.abs(real) * tol.rel);
      if (rv !== real) atLimit.push(p);
      items.push({ path: p, label: tol.label, unit: tol.unit, build: bv, real: real, reachable: rv, delta: delta,
        big: Math.abs(delta) > lim && bv !== rv });
    });
    return { model: m, items: items, large: items.some(function (i) { return i.big; }), atLimit: atLimit };
  }

  /**
   * normalize(build, ctx?) — pure. Returns a NEW build satisfying every invariant.
   * ctx.paths (optional) lists leaf paths just changed so that conflicts resolve in favour of the user's latest
   * intent (e.g. switching engine.type to 'ev' selects the single-speed gearbox; toggling rearSeats on picks a
   * seat count > 2).
   */
  function normalize(input, ctx) {
    var data = D();
    var def = data.defaultBuild();
    var src = U.isPlainObject(input) ? input : {};
    var b = conform(def, src);
    ctx = ctx || {};

    /* ---- meta */
    b.version = 1;
    var m = b.meta;
    m.name = String(m.name == null ? def.meta.name : m.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Untitled Build';
    // legacy auto name "Stock <factory car title>" -> just the title (a name the player typed is left alone)
    if (/^Stock /.test(m.name) && CB.stock && typeof CB.stock.isAutoName === 'function' && CB.stock.isAutoName(m.name.slice(6))) m.name = m.name.slice(6);
    m.id = typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : def.meta.id;
    m.created = num(m.created, def.meta.created);
    m.modified = num(m.modified, m.created);
    m.presetId = typeof m.presetId === 'string' && data.preset(m.presetId) ? m.presetId : null;

    /* ---- body */
    var body = b.body;
    body.style = optId('bodyStyles', body.style, def.body.style);
    var style = data.find('bodyStyles', body.style);
    body.chassisMaterial = optId('chassisMaterials', body.chassisMaterial, def.body.chassisMaterial);
    body.construction = optId('constructions', body.construction, 'standard');
    body.modelPhysics = bool(body.modelPhysics, false);
    if (changed(ctx, 'body.style') && !changed(ctx, 'body.wheelbase_mm') && prevVal(ctx, 'body.style') !== body.style) {
      body.wheelbase_mm = style.defaultWheelbase;
    }
    body.wheelbase_mm = rng(body.wheelbase_mm, 'body.wheelbase_mm', style.defaultWheelbase, style.wheelbaseRange[0], style.wheelbaseRange[1]);
    body.trackWidth_mm = rng(body.trackWidth_mm, 'body.trackWidth_mm', def.body.trackWidth_mm);
    body.model = modelFor(body, ctx);
    body.doors = U.nearest(style.doorOptions, Math.round(num(body.doors, style.doorOptions[0])));
    body.seats = U.nearest(style.seatOptions, Math.round(num(body.seats, style.seatOptions[0])));

    /* ---- weight (rear seats interplay with seat count) */
    var w = b.weight;
    w.soundDeadening = bool(w.soundDeadening, true);
    w.rearSeats = bool(w.rearSeats, true);
    w.spareTire = bool(w.spareTire, false);
    w.glass = optId('glassTypes', w.glass, 'standard');
    w.battery = optId('batteryTypes', w.battery, 'lead');
    w.rollCage = optId('rollCages', w.rollCage, 'none');
    w.ballast_kg = rng(w.ballast_kg, 'weight.ballast_kg', 0);
    w.ballastPosition = optId('ballastPositions', w.ballastPosition, 'center');

    var minSeat = style.seatOptions[0];
    var rearSeatsIntent = changed(ctx, 'weight.rearSeats') && !changed(ctx, 'body.seats');
    if (rearSeatsIntent) {
      if (w.rearSeats && body.seats <= 2) {
        var bigger = style.seatOptions.filter(function (s) { return s > 2; });
        if (bigger.length) body.seats = bigger[0]; else w.rearSeats = false;
      } else if (!w.rearSeats && body.seats > 2) {
        if (minSeat <= 2) body.seats = style.seatOptions.filter(function (s) { return s <= 2; }).pop();
        else w.rearSeats = true;
      }
    } else {
      // seat count is authoritative
      w.rearSeats = body.seats > 2;
    }

    /* ---- engine */
    var e = b.engine;
    e.type = optId('engineTypes', e.type, 'ice');
    var prevType = prevVal(ctx, 'engine.type');
    var typeSwitched = changed(ctx, 'engine.type') && prevType !== undefined && prevType !== e.type;
    e.layout = optId('engineLayouts', e.layout, def.engine.layout);
    var layout = data.find('engineLayouts', e.layout);
    e.displacement_l = clampStep(e.displacement_l, layout.displacementRange[0], layout.displacementRange[1], 0.1, layout.displacementRange[0]);
    e.aspiration = optId('aspirations', e.aspiration, def.engine.aspiration);
    var asp = data.find('aspirations', e.aspiration);
    if (asp.id === 'na') e.boost_bar = 0;
    else {
      if (changed(ctx, 'engine.aspiration') && !changed(ctx, 'engine.boost_bar') && prevVal(ctx, 'engine.aspiration') === 'na') e.boost_bar = asp.typicalBoost_bar;
      e.boost_bar = rng(e.boost_bar, 'engine.boost_bar', asp.typicalBoost_bar, 0.2, asp.maxBoost_bar);
    }
    e.compression = rng(e.compression, 'engine.compression', 10);
    e.fuel = optId('fuels', e.fuel, 'premium');
    var fuel = data.find('fuels', e.fuel);
    var redMax = fuel.redlineCap_rpm || 9500;
    e.redline_rpm = rng(e.redline_rpm, 'engine.redline_rpm', 7000, null, redMax);
    e.position = optId('enginePositions', e.position, 'front');
    if (style.allowedEnginePositions.indexOf(e.position) < 0) e.position = style.allowedEnginePositions[0];
    e.tune = optId('tunes', e.tune, 'stock');
    e.exhaust = optId('exhausts', e.exhaust, 'stock');
    e.cooling = optId('coolings', e.cooling, 'standard');
    e.speedLimiter_kph = num(e.speedLimiter_kph, 0) > 0 ? U.nearest(data.speedLimiters.map(function (o) { return o.id; }).filter(Boolean), num(e.speedLimiter_kph, 0)) : 0;
    e.chemistry = optId('batteryChemistries', e.chemistry, 'nmc');
    e.voltage = Number(e.voltage) >= 600 ? 800 : 400;
    e.regen = rng(e.regen, 'engine.regen', 2);
    e.motorPower_kw = rng(e.motorPower_kw, 'engine.motorPower_kw', 200);

    if (e.type === 'hybrid') {
      if (typeSwitched) {
        if (num(e.battery_kwh, 0) > 30) e.battery_kwh = 6.5;
        if (num(e.motorPower_kw, 0) > 250) e.motorPower_kw = 120;
        e.motors = Math.min(num(e.motors, 1), 1);
      }
      e.motors = rng(e.motors, 'engine.motors', 1, data.motorRanges.hybrid[0], data.motorRanges.hybrid[1]);
      e.battery_kwh = rng(e.battery_kwh, 'engine.battery_kwh', 6.5, data.batteryRanges.hybrid[0], data.batteryRanges.hybrid[1]);
    } else if (e.type === 'ev') {
      if (typeSwitched && num(e.battery_kwh, 0) < 30) e.battery_kwh = 85;
      e.motors = rng(e.motors, 'engine.motors', 2, data.motorRanges.ev[0], data.motorRanges.ev[1]);
      e.battery_kwh = rng(e.battery_kwh, 'engine.battery_kwh', 85, data.batteryRanges.ev[0], data.batteryRanges.ev[1]);
      e.battery_kwh = U.round(e.battery_kwh, 0);
    } else {
      // ICE keeps (but ignores) the electric fields so switching back restores them; keep them in global range.
      e.motors = rng(e.motors, 'engine.motors', 2);
      e.battery_kwh = rng(e.battery_kwh, 'engine.battery_kwh', 85);
    }

    // factory calibration (0 = generic): a Garage edit of what it was calibrated for voids it
    function edited(pth) { return changed(ctx, pth) && !U.equal(prevVal(ctx, pth), U.get(b, pth)); }
    function calib(v, lo, hi, step) { v = num(v, 0); return v > 0 ? clampStep(v, lo, hi, step, lo) : 0; }
    e.torqueLimit_nm = calib(e.torqueLimit_nm, 50, 3000, 1);
    e.motorBase_pct = calib(e.motorBase_pct, 12, 60, 1);
    e.motorFade_pct = e.motorFade_pct > 0 ? calib(Math.max(num(e.motorFade_pct, 0), e.motorBase_pct || 12), 12, 100, 1) : 0;
    e.motorTopPower_pct = calib(e.motorTopPower_pct, 20, 100, 1);
    e.batteryPower_kw = calib(e.batteryPower_kw, 10, 3000, 1);
    if (typeSwitched || ['engine.layout', 'engine.displacement_l', 'engine.aspiration', 'engine.boost_bar', 'engine.compression',
      'engine.fuel', 'engine.redline_rpm', 'engine.tune'].some(edited)) e.torqueLimit_nm = 0;
    if (typeSwitched) { e.motorBase_pct = 0; e.motorFade_pct = 0; e.motorTopPower_pct = 0; } // envelope = motor design (kW-independent)
    if (typeSwitched || edited('engine.battery_kwh') || edited('engine.chemistry') || edited('engine.voltage')) e.batteryPower_kw = 0;

    /* ---- transmission */
    var t = b.transmission;
    t.type = optId('transmissions', t.type, 'dct');
    if (typeSwitched && !changed(ctx, 'transmission.type')) {
      if (e.type === 'ev') t.type = 'single-speed';
      else if (prevType === 'ev' && t.type === 'single-speed') t.type = 'dct';
    }
    if (e.type === 'ice' && t.type === 'single-speed') t.type = 'dct';
    var trans = data.find('transmissions', t.type);
    var typeChanged = changed(ctx, 'transmission.type') && prevVal(ctx, 'transmission.type') !== t.type;
    if ((typeChanged || (typeSwitched && prevVal(ctx, 'transmission.type') !== t.type)) && !changed(ctx, 'transmission.gears')) {
      t.gears = trans.defaultRatios().length; // reference gear count for that box
    }
    t.gears = Math.round(U.clamp(num(t.gears, trans.gearRange[0]), trans.gearRange[0], trans.gearRange[1]));
    var gearsChanged = changed(ctx, 'transmission.gears') && prevVal(ctx, 'transmission.gears') !== t.gears;
    var ratiosOk = Array.isArray(t.ratios) && t.ratios.length === t.gears && t.ratios.every(function (r) { return isFinite(Number(r)); });
    var userSetRatios = changed(ctx, 'transmission.ratios');
    var transTypeDiffers = prevVal(ctx, 'transmission.type') !== undefined && prevVal(ctx, 'transmission.type') !== t.type;
    if (!ratiosOk || ((gearsChanged || transTypeDiffers) && !userSetRatios)) {
      t.ratios = trans.defaultRatios(t.gears);
    } else {
      var rr = rangeOf('transmission.ratio');
      t.ratios = t.ratios.map(function (r) { return U.clamp(U.round(Number(r), 2), rr.min, rr.max); });
      for (var i = 1; i < t.ratios.length; i++) {
        if (t.ratios[i] >= t.ratios[i - 1]) t.ratios[i] = U.round(t.ratios[i - 1] - 0.01, 2);
      }
      if (t.ratios[t.ratios.length - 1] < rr.min) t.ratios = trans.defaultRatios(t.gears);
    }
    t.finalDrive = rng(t.finalDrive, 'transmission.finalDrive', 3.42);
    t.launchControl = bool(t.launchControl, true);

    /* ---- drivetrain */
    var dt = b.drivetrain;
    dt.layout = optId('drivetrainLayouts', dt.layout, 'rwd');
    dt.frontDiff = optId('differentials', dt.frontDiff, 'open');
    dt.rearDiff = optId('differentials', dt.rearDiff, 'open');
    dt.centerDiff = optId('differentials', dt.centerDiff, 'none');
    var prevLayout = prevVal(ctx, 'drivetrain.layout');
    if (dt.layout === 'fwd') dt.torqueSplitFront_pct = 100;
    else if (dt.layout === 'rwd') dt.torqueSplitFront_pct = 0;
    else {
      if (changed(ctx, 'drivetrain.layout') && prevLayout && prevLayout !== 'awd' && !changed(ctx, 'drivetrain.torqueSplitFront_pct')) {
        dt.torqueSplitFront_pct = e.position === 'front' ? 40 : 30;
      }
      var tr = rangeOf('drivetrain.torqueSplitFront_pct');
      dt.torqueSplitFront_pct = rng(dt.torqueSplitFront_pct, 'drivetrain.torqueSplitFront_pct', 40, tr.awdMin, tr.awdMax);
    }
    if (dt.layout !== 'awd') dt.centerDiff = 'none';
    else if (dt.centerDiff === 'none') dt.centerDiff = 'lsd-torsen';
    if ((dt.layout === 'fwd' || dt.layout === 'awd') && dt.frontDiff === 'none') dt.frontDiff = 'open';
    if ((dt.layout === 'rwd' || dt.layout === 'awd') && dt.rearDiff === 'none') dt.rearDiff = 'open';
    dt.torqueVectoring = bool(dt.torqueVectoring, false);
    dt.tractionControl = rng(dt.tractionControl, 'drivetrain.tractionControl', 2);

    /* ---- suspension */
    var s = b.suspension;
    s.type = optId('suspensionTypes', s.type, 'double-wishbone');
    var st = data.find('suspensionTypes', s.type);
    s.springFront_nmm = rng(s.springFront_nmm, 'suspension.springFront_nmm', 60);
    s.springRear_nmm = rng(s.springRear_nmm, 'suspension.springRear_nmm', 70);
    s.damping = rng(s.damping, 'suspension.damping', 5);
    s.rideHeight_mm = rng(s.rideHeight_mm, 'suspension.rideHeight_mm', 120, st.rideHeightRange[0], st.rideHeightRange[1]);
    s.camberFront_deg = rng(s.camberFront_deg, 'suspension.camberFront_deg', -1.5);
    s.camberRear_deg = rng(s.camberRear_deg, 'suspension.camberRear_deg', -1.0);
    s.toeFront_deg = rng(s.toeFront_deg, 'suspension.toeFront_deg', 0);
    s.toeRear_deg = rng(s.toeRear_deg, 'suspension.toeRear_deg', 0.1);
    s.arbFront = rng(s.arbFront, 'suspension.arbFront', 5);
    s.arbRear = rng(s.arbRear, 'suspension.arbRear', 4);

    /* ---- brakes */
    var br = b.brakes;
    br.material = optId('brakeMaterials', br.material, 'iron');
    br.frontRotor_mm = rng(br.frontRotor_mm, 'brakes.frontRotor_mm', 360);
    br.rearRotor_mm = rng(br.rearRotor_mm, 'brakes.rearRotor_mm', 330);
    br.frontPistons = U.nearest(data.pistonOptions, num(br.frontPistons, 6));
    br.rearPistons = U.nearest(data.pistonOptions, num(br.rearPistons, 4));
    br.abs = optId('absModes', br.abs, 'sport');

    /* ---- wheels & tyres */
    var wh = b.wheels, ti = b.tires;
    wh.design = optId('wheelDesigns', wh.design, 'y-spoke');
    wh.material = optId('wheelMaterials', wh.material, 'cast');
    wh.diameter_in = rng(wh.diameter_in, 'wheels.diameter_in', 19);
    wh.staggered = bool(wh.staggered, true);
    wh.widthFront_in = rng(wh.widthFront_in, 'wheels.widthFront_in', 9);
    wh.widthRear_in = rng(wh.widthRear_in, 'wheels.widthRear_in', 10.5);
    wh.finish = hex(wh.finish, '#2b2b2b');
    ti.compound = optId('tireCompounds', ti.compound, 'performance');
    ti.speedRating = optId('tireSpeedRatings', ti.speedRating, 'compound');
    ti.widthFront_mm = rng(ti.widthFront_mm, 'tires.widthFront_mm', 255);
    ti.widthRear_mm = rng(ti.widthRear_mm, 'tires.widthRear_mm', 295);
    ti.profileFront = rng(ti.profileFront, 'tires.profileFront', 35);
    ti.profileRear = rng(ti.profileRear, 'tires.profileRear', 30);
    if (!wh.staggered) {
      // square setup: rear follows front unless the user explicitly edited only a rear value
      var rearEdited = (changed(ctx, 'wheels.widthRear_in') || changed(ctx, 'tires.widthRear_mm') || changed(ctx, 'tires.profileRear')) &&
        !(changed(ctx, 'wheels.widthFront_in') || changed(ctx, 'tires.widthFront_mm') || changed(ctx, 'tires.profileFront'));
      if (rearEdited) {
        wh.widthFront_in = wh.widthRear_in; ti.widthFront_mm = ti.widthRear_mm; ti.profileFront = ti.profileRear;
      } else {
        wh.widthRear_in = wh.widthFront_in; ti.widthRear_mm = ti.widthFront_mm; ti.profileRear = ti.profileFront;
      }
    }

    /* ---- aero */
    var a = b.aero;
    a.splitter = optId('aero.splitters', a.splitter, 'none');
    a.wing = optId('aero.wings', a.wing, 'none');
    a.diffuser = optId('aero.diffusers', a.diffuser, 'none');
    var wing = data.find('aero.wings', a.wing);
    if (changed(ctx, 'aero.wing') && wing.adjustable && num(a.wingAngle_deg, 0) === 0 && !changed(ctx, 'aero.wingAngle_deg')) a.wingAngle_deg = 6;
    a.wingAngle_deg = rng(a.wingAngle_deg, 'aero.wingAngle_deg', 6);
    a.canards = bool(a.canards, false);
    a.sideSkirts = bool(a.sideSkirts, false);
    a.activeAero = bool(a.activeAero, false);
    if (wing.active) a.activeAero = true;

    /* ---- exterior */
    var x = b.exterior;
    x.paint = hex(x.paint, def.exterior.paint);
    x.finish = optId('paintFinishes', x.finish, 'metallic');
    x.roof = optId('roofTypes', x.roof, 'body');
    x.roofColor = hex(x.roofColor, '#111111');
    x.stripe = optId('stripes', x.stripe, 'none');
    x.stripeColor = hex(x.stripeColor, '#ffffff');
    x.caliperColor = hex(x.caliperColor, '#f2c200');
    x.windowTint_pct = rng(x.windowTint_pct, 'exterior.windowTint_pct', 20);
    x.lights = optId('lightTypes', x.lights, 'led');
    x.mirrors = optId('mirrorTypes', x.mirrors, 'body');
    x.badge = optId('badgeTypes', x.badge, 'chrome');
    x.livery_number = String(x.livery_number == null ? '' : x.livery_number).toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 3);

    /* ---- interior */
    var n = b.interior;
    n.seatType = optId('seatTypes', n.seatType, 'sport');
    n.upholstery = optId('upholsteries', n.upholstery, 'leather');
    n.primaryColor = hex(n.primaryColor, '#1a1a1a');
    n.accentColor = hex(n.accentColor, '#b3121f');
    n.stitchColor = hex(n.stitchColor, '#b3121f');
    n.trim = optId('trims', n.trim, 'aluminum');
    n.steering = optId('steeringTypes', n.steering, 'round');
    n.headliner = optId('headliners', n.headliner, 'alcantara');
    n.ambientLighting = bool(n.ambientLighting, true);
    n.ambientColor = hex(n.ambientColor, '#ff3344');
    n.harness = bool(n.harness, false);

    /* ---- tech */
    var tc = b.tech;
    tc.screen_in = U.nearest(data.screenSizes.map(function (o) { return o.id; }), num(tc.screen_in, 12));
    tc.digitalCluster = bool(tc.digitalCluster, true);
    tc.hud = bool(tc.hud, false);
    tc.audio = optId('audioSystems', tc.audio, 'premium');
    tc.adas = optId('adasLevels', tc.adas, 'assist');
    tc.climateZones = rng(tc.climateZones, 'tech.climateZones', 2, 1, Math.max(1, Math.min(4, body.seats)));
    tc.telemetry = bool(tc.telemetry, false);
    tc.liftSystem = bool(tc.liftSystem, false);
    tc.nightVision = bool(tc.nightVision, false);

    return b;
  }

  /* ---------------------------------------------------------------- store */
  var current = null;
  var past = [];    // [{build, label, path, time}]
  var future = [];
  var listeners = [];
  var lastCommit = null; // {path, time, key}
  var bootInfo = null;

  function init() { if (!current) current = normalize(defaultBuild()); }

  function sameIgnoringModified(a, b) {
    if (!a || !b) return false;
    var am = a.meta, bm = b.meta;
    if (!am || !bm) return U.equal(a, b);
    var a2 = Object.assign({}, a, { meta: Object.assign({}, am, { modified: 0 }) });
    var b2 = Object.assign({}, b, { meta: Object.assign({}, bm, { modified: 0 }) });
    return U.equal(a2, b2);
  }

  function emit(change) {
    var snapshot = listeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](current, change); }
      catch (err) { if (typeof console !== 'undefined') console.error('[CB.state] subscriber error', err); }
    }
  }

  function commit(next, change, opts) {
    opts = opts || {};
    if (sameIgnoringModified(next, current)) return false;
    next = U.set(next, 'meta.modified', Date.now());
    var now = Date.now();
    if (!opts.noHistory) {
      var key = opts.coalesceKey || (change.type === 'set' ? 'set:' + change.path : null);
      var coalesce = !opts.noCoalesce && key && lastCommit && lastCommit.key === key && (now - lastCommit.time) < COALESCE_MS && past.length > 0;
      if (!coalesce) {
        past.push({ build: current, label: change.label, path: change.path, time: now });
        if (past.length > HISTORY_CAP) past.splice(0, past.length - HISTORY_CAP);
      } else {
        past[past.length - 1].label = change.label;
      }
      future = [];
      lastCommit = { key: key, time: now };
    }
    current = next;
    if (!opts.silent) emit(change);
    return true;
  }

  function labelFor(path, value) {
    var r = D().ranges && D().ranges[path];
    var name = r ? r.label : String(path).split('.').pop().replace(/_[a-z]+$/, '').replace(/([A-Z])/g, ' $1');
    name = U.capitalize(name.trim());
    var coll = D().pathCollections && D().pathCollections[path];
    if (coll) { var o = D().find(coll, value); if (o) return name + ': ' + o.name; }
    if (typeof value === 'boolean') return name + (value ? ' on' : ' off');
    if (typeof value === 'number') return name + ' → ' + U.fmtNum(value, Math.abs(value) < 10 && value % 1 ? 2 : 0) + (r && r.unit ? ' ' + r.unit : '');
    if (typeof value === 'string' && value.length < 24) return name + ' → ' + value;
    return name;
  }

  function get() { init(); return current; }

  function set(path, value, opts) {
    init(); opts = opts || {};
    if (!path) return false;
    if (U.equal(U.get(current, path), value)) return false;
    var raw = U.set(current, path, value), paths = [path];
    var fold = foldRealDims(raw, paths, current, opts);
    if (fold) { raw = fold.raw; paths = fold.paths; }
    var next = normalize(raw, { paths: paths, prev: current });
    return commit(next, { type: 'set', path: path, value: value, paths: paths, realDims: fold ? fold.model.id : undefined, label: opts.label || labelFor(path, value) }, opts);
  }

  function patch(partial, opts) {
    init(); opts = opts || {};
    if (!U.isPlainObject(partial)) return false;
    var paths = leafPaths(partial);
    var raw = U.deepMerge(current, partial), own = paths;
    var fold = foldRealDims(raw, paths, current, opts);
    if (fold) { raw = fold.raw; paths = fold.paths; }
    var next = normalize(raw, { paths: paths, prev: current });
    paths = own;
    return commit(next, { type: 'patch', path: paths.length === 1 ? paths[0] : '*', value: partial, paths: fold ? fold.paths : paths, realDims: fold ? fold.model.id : undefined, label: opts.label || (paths.length === 1 ? labelFor(paths[0], U.get(partial, paths[0])) : 'Update ' + paths.length + ' settings') }, opts);
  }

  function replace(build, opts) {
    init(); opts = opts || {};
    var next = normalize(U.deepMerge(D().defaultBuild(), build || {}));
    if (opts.resetHistory) { past = []; future = []; lastCommit = null; }
    var change = { type: opts.type || 'replace', path: '*', value: null, paths: ['*'], label: opts.label || ('Load “' + next.meta.name + '”') };
    if (opts.resetHistory || opts.force) {
      current = next;
      if (!opts.silent) emit(change);
      return true;
    }
    return commit(next, change, opts);
  }

  /** Snap the build to its real model's dimensions (one undo step). Returns true when anything changed. */
  function matchRealDims(opts) {
    init(); opts = opts || {};
    var m = modelOf(current), dims = m && realDims(m);
    if (!dims) return false;
    dims = U.deepMerge(dims, brakeFit(dims, current));
    return patch(dims, Object.assign({ label: 'Match ' + (m.make ? m.make + ' ' : '') + (m.name || m.id) + ' dimensions', realDims: false }, opts));
  }
  /** Pick a real model (switching body style to its style) and apply its real dimensions, as one undo step. */
  function applyModel(id, opts) {
    init(); opts = opts || {};
    var m = modelOf(String(id || ''));
    if (!m || !(D().bodyStyles || []).some(function (st) { return st.id === m.style; })) return false;
    var dims = realDims(m) || {};
    dims = U.deepMerge(dims, brakeFit(dims, current));
    var p = U.deepMerge(dims, { body: { style: m.style, model: m.id } });
    return patch(p, Object.assign({ label: 'Model → ' + (m.make ? m.make + ' ' : '') + (m.name || m.id), realDims: false }, opts));
  }

  /** New build: the factory spec of the car the build currently shows (starterBuild), else the default build. */
  function reset(opts) { return replace(starterBuild(current ? modelOf(current) : null), Object.assign({ label: 'New build' }, opts || {})); }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function unsubscribe() { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  function undo() {
    if (!past.length) return false;
    var entry = past.pop();
    future.push({ build: current, label: entry.label, path: entry.path, time: Date.now() });
    current = entry.build;
    lastCommit = null;
    emit({ type: 'undo', path: '*', value: null, paths: ['*'], label: 'Undo ' + entry.label });
    return true;
  }

  function redo() {
    if (!future.length) return false;
    var entry = future.pop();
    past.push({ build: current, label: entry.label, path: entry.path, time: Date.now() });
    current = entry.build;
    lastCommit = null;
    emit({ type: 'redo', path: '*', value: null, paths: ['*'], label: 'Redo ' + entry.label });
    return true;
  }

  function canUndo() { return past.length > 0; }
  function canRedo() { return future.length > 0; }
  function history() { return past.map(function (h) { return h.label; }); }
  function historyDetail() {
    function m(h) { return { label: h.label, path: h.path, time: h.time }; }
    return { past: past.map(m), future: future.slice().reverse().map(m) };
  }
  function clearHistory() { past = []; future = []; lastCommit = null; }

  /* ---------------------------------------------------------------- encode / decode */
  /** Build a nested object containing only leaves that differ from `base`. */
  function diffObject(base, obj) {
    var out = {}, any = false;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k], bv = base ? base[k] : undefined;
      if (U.isPlainObject(v)) {
        var d = diffObject(U.isPlainObject(bv) ? bv : {}, v);
        if (d) { out[k] = d; any = true; }
      } else if (!U.equal(v, bv)) { out[k] = v; any = true; }
    });
    return any ? out : null;
  }

  function encode(build) {
    var b = normalize(build || get());
    var def = D().defaultBuild();
    var shareable = U.deepClone(b);
    // id / timestamps are per-device; never part of a share code
    delete shareable.meta.id; delete shareable.meta.created; delete shareable.meta.modified;
    var defShare = U.deepClone(def);
    delete defShare.meta.id; delete defShare.meta.created; delete defShare.meta.modified;
    var d = diffObject(defShare, shareable) || {};
    d.v = 1;
    return 'v1.' + U.b64urlEncode(JSON.stringify(d));
  }

  function decode(str) {
    if (typeof str !== 'string' || !str) return null;
    try {
      var s = str.trim();
      if (s.indexOf('#') >= 0) s = s.slice(s.indexOf('#') + 1);
      if (s.indexOf('b=') === 0) s = s.slice(2);
      try { s = decodeURIComponent(s); } catch (e) { /* already decoded */ }
      var payload;
      if (s.indexOf('v1.') === 0) payload = JSON.parse(U.b64urlDecode(s.slice(3)));
      else if (s.charAt(0) === '{') payload = JSON.parse(s);
      else payload = JSON.parse(U.b64urlDecode(s));
      if (!U.isPlainObject(payload)) return null;
      delete payload.v;
      var merged = U.deepMerge(D().defaultBuild(), payload);
      return normalize(merged);
    } catch (err) {
      return null;
    }
  }

  function shareURL(build) {
    var code = encode(build || get());
    var base = '';
    if (hasWindow && window.location) base = String(window.location.href).split('#')[0];
    return base + '#b=' + code;
  }

  function exportJSON(build) { return JSON.stringify(normalize(build || get()), null, 2); }
  function importJSON(str) {
    try { var o = JSON.parse(str); return U.isPlainObject(o) ? normalize(U.deepMerge(D().defaultBuild(), o)) : null; }
    catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- garage */
  function readGarage() { var g = readJSON(GARAGE_KEY, []); return Array.isArray(g) ? g : []; }

  function saveLocal(build, opts) {
    opts = opts || {};
    var b = normalize(build || get());
    var garage = readGarage();
    var entry = { id: b.meta.id, name: b.meta.name, saved: Date.now(), build: b };
    var idx = -1;
    for (var i = 0; i < garage.length; i++) if (garage[i].id === entry.id) { idx = i; break; }
    if (idx >= 0 && !opts.asNew) garage[idx] = entry;
    else {
      if (opts.asNew && idx >= 0) {
        entry.build = U.set(U.set(b, 'meta.id', U.uid('b')), 'meta.created', Date.now());
        entry.id = entry.build.meta.id;
      }
      garage.unshift(entry);
    }
    writeJSON(GARAGE_KEY, garage);
    return entry;
  }

  function listLocal() {
    return readGarage().filter(function (e) { return e && e.id && e.build; })
      .sort(function (a, b) { return (b.saved || 0) - (a.saved || 0); });
  }

  function loadLocal(id) {
    var g = readGarage();
    for (var i = 0; i < g.length; i++) if (g[i].id === id) return normalize(g[i].build);
    return null;
  }

  function deleteLocal(id) {
    var g = readGarage(), n = g.filter(function (e) { return e.id !== id; });
    if (n.length === g.length) return false;
    writeJSON(GARAGE_KEY, n);
    return true;
  }

  function renameLocal(id, name) {
    var g = readGarage(), ok = false;
    g.forEach(function (e) {
      if (e.id === id) { e.name = String(name).slice(0, 60); e.build.meta.name = e.name; ok = true; }
    });
    if (ok) writeJSON(GARAGE_KEY, g);
    return ok;
  }

  function duplicateLocal(id) {
    var b = loadLocal(id);
    if (!b) return null;
    b = U.set(b, 'meta.name', (b.meta.name + ' (copy)').slice(0, 60));
    return saveLocal(b, { asNew: true });
  }

  /* ---------------------------------------------------------------- autosave */
  var autosave = U.debounce(function () {
    if (current) writeJSON(CURRENT_KEY, { saved: Date.now(), build: current });
  }, 400);
  function flushAutosave() { autosave.flush(); if (current) writeJSON(CURRENT_KEY, { saved: Date.now(), build: current }); }
  if (hasWindow) {
    subscribe(function () { autosave(); });
    try { window.addEventListener('beforeunload', flushAutosave); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- boot */
  function readHashCode() {
    if (!hasWindow || !window.location) return null;
    var h = String(window.location.hash || '');
    var m = h.match(/[#&]b=([^&]+)/);
    return m ? m[1] : null;
  }

  function boot(opts) {
    opts = opts || {};
    if (bootInfo && !opts.force) return bootInfo;
    var build = null, source = 'default';
    var code = readHashCode();
    if (code) { build = decode(code); if (build) { source = 'url'; build = U.set(build, 'meta.id', U.uid('b')); } }
    if (!build) {
      var saved = readJSON(CURRENT_KEY, null);
      if (saved && saved.build) {
        try { build = normalize(U.deepMerge(D().defaultBuild(), saved.build)); source = 'autosave'; } catch (e) { build = null; }
      }
    }
    if (!build) { build = normalize(starterBuild()); source = 'default'; }
    current = build;
    past = []; future = []; lastCommit = null;
    bootInfo = { source: source, build: build };
    emit({ type: 'boot', path: '*', value: null, paths: ['*'], label: 'Boot (' + source + ')' });
    return bootInfo;
  }

  if (hasWindow) {
    try {
      window.addEventListener('hashchange', function () {
        var code = readHashCode();
        if (!code || code === encode(current)) return;
        var b = decode(code);
        if (b && !sameIgnoringModified(b, current)) replace(U.set(b, 'meta.id', current.meta.id), { label: 'Load shared build' });
      });
    } catch (e) { /* ignore */ }
  }

  CB.state = {
    get: get, set: set, patch: patch, replace: replace, reset: reset, subscribe: subscribe,
    undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo, history: history, historyDetail: historyDetail, clearHistory: clearHistory,
    normalize: normalize, leafPaths: leafPaths,
    defaultBuild: defaultBuild, starterBuild: starterBuild, realDims: realDims, modelOf: modelOf, dimsDeviation: dimsDeviation, matchRealDims: matchRealDims,
    applyModel: applyModel, REAL_DIM_PATHS: REAL_DIM_PATHS.slice(),
    encode: encode, decode: decode, shareURL: shareURL, exportJSON: exportJSON, importJSON: importJSON,
    saveLocal: saveLocal, listLocal: listLocal, loadLocal: loadLocal, deleteLocal: deleteLocal, renameLocal: renameLocal, duplicateLocal: duplicateLocal,
    flushAutosave: flushAutosave, boot: boot,
    get bootInfo() { return bootInfo; },
    keys: { garage: GARAGE_KEY, current: CURRENT_KEY },
    _storage: storage,
    constants: { HISTORY_CAP: HISTORY_CAP, COALESCE_MS: COALESCE_MS }
  };

  // Browser: restore immediately so every later module sees the right build on load.
  if (hasWindow) { try { boot(); } catch (e) { if (typeof console !== 'undefined') console.error(e); init(); } }
  // A first visit (nothing saved, no share link) boots on defaultBuild() above because physics.js (which the factory
  // spec's calibration needs) loads after this file; once every script has loaded, swap that untouched build for the
  // factory car (starterBuild) as the boot build — saved builds, autosaves and share links are never touched.
  function promoteStarter() {
    if (!bootInfo || bootInfo.source !== 'default' || bootInfo.starter || past.length || current !== bootInfo.build) return;
    var b = null;
    try { b = normalize(starterBuild()); } catch (e) { b = null; }
    if (!b || sameIgnoringModified(b, current)) return;
    current = b; future = []; lastCommit = null;
    bootInfo = { source: 'default', build: b, starter: true };
    emit({ type: 'boot', path: '*', value: null, paths: ['*'], label: 'Boot (factory car)' });
  }
  if (hasWindow && typeof document !== 'undefined' && document.addEventListener) {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', promoteStarter);
      else setTimeout(promoteStarter, 0);
    } catch (e) { /* ignore */ }
  }
  else init();
})();

if (typeof module !== 'undefined') module.exports = CB.state;

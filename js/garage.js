/* ==========================================================================
   FORGE Atelier — js/garage.js
   CB.garage : the "garage" shell — presets gallery, saved builds, compare mode, share & JSON
               import/export, the print-ready specification sheet and "Surprise me".

   PUBLIC API (all DOM entry points are safe to call from app.js buttons / shortcuts)
     openPresets()                 presets gallery modal (thumbnail, tagline, tags, stats, confirm-load)
     openSaved() / open()          saved builds modal (save / save-as / rename / duplicate / delete / load,
                                   search + sort, multi-select → compare, garage backup import/export)
     openCompare(sources?)         compare 2–3 builds (current + saved / presets). sources: array of
                                   'current' | 'saved:<id>' | 'preset:<id>' | build objects
     openShare(build?)             '#b=' share link (clipboard with fallbacks), text/markdown summary, JSON
     openImport()                  import modal: file picker, drag & drop, paste (JSON, garage backup,
                                   share link or code) with live preview
     openSpec(build?)              print-ready specification sheet (Print / Save PDF, download .html, copy text)
     surprise(opts?)               random → normalize → rules auto-fix → replace current build (undoable)
     save() / saveAs(name?)        save current build to the garage (Ctrl/⌘ S)
     load(id) / loadPreset(id)     with "unsaved changes" confirmation
     remove(id) / rename(id, name) / duplicate(id) / list()
     exportJSON(build?)            download the build as .redline.json
     exportGarage()                download every saved build as a garage backup
     importJSON()                  open the import modal (file picker focused)
     copy(text) -> Promise<bool>   clipboard with execCommand + manual fallbacks

   PURE (also usable in Node — see tests/garage.test.js)
     compute(build)                { build, metrics, pricing, issues, legality } (uses CB.app.compute if present)
     metricGroups                  compare table definition
     compareRows(bundles, opts)    → [{ group, rows:[{ key, label, unit, better, differs, cells:[{ v, text,
                                       best, worst, delta, deltaText, deltaGood }] }] }]
     bestIndices(values, better, target)  → { best:[i], worst:[i] }
     specSections(build, bundle)   → [{ id, title, rows:[{ label, value, color? }] }]
     describe(build)               → { style, engine, transmission, drivetrain, headline }
     surpriseBuild(opts)           → { build, archetype, attempts, issues, score }   (seedable: opts.seed)
     randomBuild(rng, archetypeId) → raw partial-merged build (not yet normalized / fixed)
     parseImport(text)             → { ok, kind:'build'|'garage'|'share', builds:[...], error }
     thumbnail(build)              → SVG string (CB.render.thumbnail, else a parametric fallback)

   Events: document 'cb:garage-changed' { detail: { action, id } } after any garage mutation.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  var U = CB.util;
  if (!U) { if (typeof console !== 'undefined') console.error('[CB.garage] CB.util missing.'); return; }

  var VERSION = '1.0.0';
  var EXPORT_FORMAT = 'forge-garage';   // wire format id of a saved-builds backup: unchanged by the Redline rebrand (old backups import)
  var RATING_KEYS = ['acceleration', 'handling', 'braking', 'comfort', 'efficiency', 'reliability', 'practicality', 'luxury', 'sound', 'track'];

  /* ======================================================================
     SMALL HELPERS
     ====================================================================== */
  function D() { return CB.data; }
  function S() { return CB.state; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function fmt(v, d) { return isNum(Number(v)) && v !== null && v !== '' ? U.fmtNum(v, d || 0) : '—'; }
  function money(v, opts) { return v == null || !isFinite(Number(v)) ? '—' : U.fmtMoney(v, opts); }
  function esc(s) { return U.escapeHtml(s); }
  function titleCase(s) { return String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function warn(msg, err) { if (typeof console !== 'undefined') console.warn('[CB.garage] ' + msg, err || ''); }
  function safe(fn, fallback, label) {
    try { return fn(); } catch (err) { if (typeof console !== 'undefined') console.error('[CB.garage] ' + (label || 'error'), err); return fallback; }
  }
  function has(path) { var v = U.get(CB, path); return typeof v === 'function' || (v && typeof v === 'object'); }
  function find(coll, id) { return D() && D().find ? D().find(coll, id) : undefined; }
  function optName(coll, id) { var o = find(coll, id); return o ? o.name : (id == null || id === '' ? '—' : titleCase(String(id))); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmtLap(s) {
    if (s == null || !isFinite(s)) return '—';
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
  }
  function fmtDate(ms) { return ms ? U.fmtDate(ms) : '—'; }
  function relTime(ms) {
    if (!ms) return '';
    var d = (Date.now() - ms) / 1000;
    if (d < 45) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    if (d < 86400 * 7) return Math.round(d / 86400) + ' d ago';
    return fmtDate(ms);
  }
  function normalize(b) { return S() && S().normalize ? S().normalize(b) : b; }
  function stripMeta(b) { if (!b) return b; var c = U.deepClone(b); delete c.meta; return c; }
  function sameBuild(a, b) { return !!a && !!b && U.equal(stripMeta(a), stripMeta(b)); }
  function fileSlug(name) { return (U.slugify ? U.slugify(name) : String(name || 'build').toLowerCase().replace(/[^a-z0-9]+/g, '-')) || 'redline-build'; }

  /* ======================================================================
     COMPUTE (metrics / pricing / issues / legality for ANY build)
     ====================================================================== */
  var cache = [];           // tiny identity LRU: [{ build, bundle }]
  var CACHE_MAX = 40;
  function compute(build) {
    if (!build) return { build: null, metrics: null, pricing: null, issues: [], legality: null };
    if (CB.app && typeof CB.app.compute === 'function') {
      var viaApp = safe(function () { return CB.app.compute(build); }, null, 'app.compute');
      if (viaApp) return viaApp;
    }
    for (var i = 0; i < cache.length; i++) if (cache[i].build === build) return cache[i].bundle;
    var metrics = null, pricing = null, issues = [], legality = null;
    if (has('physics.compute')) metrics = safe(function () { return CB.physics.compute(build); }, null, 'physics.compute');
    if (has('pricing.compute')) pricing = safe(function () { return CB.pricing.compute(build, metrics); }, null, 'pricing.compute');
    if (has('rules.validate')) issues = safe(function () { return CB.rules.validate(build, metrics) || []; }, [], 'rules.validate');
    if (has('rules.legality')) legality = safe(function () { return CB.rules.legality(build, metrics); }, null, 'rules.legality');
    if (!Array.isArray(issues)) issues = [];
    var bundle = { build: build, metrics: metrics, pricing: pricing, issues: issues, legality: legality };
    cache.unshift({ build: build, bundle: bundle });
    if (cache.length > CACHE_MAX) cache.length = CACHE_MAX;
    return bundle;
  }

  function priceOf(bundle) {
    var p = bundle && bundle.pricing;
    if (!p) return null;
    if (isNum(p.total)) return p.total;
    if (isNum(p.msrp)) return p.msrp;
    return null;
  }

  var financeCache = {};
  function financeOf(total) {
    if (!isNum(total) || total <= 0) return null;
    var k = Math.round(total);
    if (financeCache[k] !== undefined) return financeCache[k];
    var r = null;
    if (CB.app && typeof CB.app.financeFor === 'function') r = safe(function () { return CB.app.financeFor(total); }, null, 'financeFor');
    if (!r && has('pricing.finance')) {
      r = safe(function () {
        var opts = { apr: 6.9, months: 60, down: Math.round(total * 0.1), tradeIn: 0, taxRate: 0 };
        return { finance: CB.pricing.finance(total, opts), lease: has('pricing.lease') ? CB.pricing.lease(total, { months: 36, residual_pct: 55, moneyFactor: 0.0025, down: Math.round(total * 0.1) }) : null, settings: opts };
      }, null, 'pricing.finance');
    }
    financeCache[k] = r;
    return r;
  }
  function monthlyOf(bundle) {
    var f = financeOf(priceOf(bundle));
    return f && f.finance && isNum(f.finance.monthly) ? f.finance.monthly : null;
  }
  function countSev(bundle, sev) { return ((bundle && bundle.issues) || []).filter(function (i) { return i && i.severity === sev; }).length; }

  /* ======================================================================
     DESCRIPTIONS
     ====================================================================== */
  function describeEngine(b) {
    var e = (b && b.engine) || {};
    if (e.type === 'ev') {
      return (e.motors || 1) + ' × ' + fmt(e.motorPower_kw) + ' kW electric · ' + fmt(e.battery_kwh) + ' kWh ' + optName('batteryChemistries', e.chemistry).replace(/\s*\(.*\)$/, '') + ' · ' + (e.voltage || 400) + ' V';
    }
    var asp = find('aspirations', e.aspiration);
    var s = U.fmtNum(num(e.displacement_l), 1) + ' L ' + optName('engineLayouts', e.layout) + ' ' + (asp ? (asp.id === 'na' ? 'naturally aspirated' : asp.name.toLowerCase()) : '');
    if (asp && asp.id !== 'na' && isNum(Number(e.boost_bar)) && e.boost_bar > 0) s += ' ' + U.fmtNum(e.boost_bar, 2) + ' bar';
    if (e.fuel === 'diesel') s += ' diesel';
    if (e.type === 'hybrid') s += ' + ' + (e.motors || 1) + ' × ' + fmt(e.motorPower_kw) + ' kW hybrid (' + U.fmtNum(num(e.battery_kwh), 1) + ' kWh)';
    return s.replace(/\s+/g, ' ').trim();
  }
  function describeTransmission(b) {
    var t = (b && b.transmission) || {};
    var tr = find('transmissions', t.type);
    if (!tr) return '—';
    if (t.type === 'cvt' || t.type === 'single-speed') return tr.name;
    return t.gears + '-speed ' + tr.name.replace(/^\d+-speed\s*/i, '');
  }
  function describeDrivetrain(b) {
    var d = (b && b.drivetrain) || {};
    var lay = String(d.layout || '').toUpperCase();
    var diff = d.layout === 'fwd' ? d.frontDiff : d.rearDiff;
    var s = lay + ' · ' + optName('differentials', diff);
    if (d.layout === 'awd') s += ' · ' + num(d.torqueSplitFront_pct) + '/' + (100 - num(d.torqueSplitFront_pct)) + ' split';
    if (d.torqueVectoring) s += ' · torque vectoring';
    return s;
  }
  function describe(b) {
    if (!b) return { style: '—', engine: '—', transmission: '—', drivetrain: '—', headline: '—' };
    var style = optName('bodyStyles', b.body && b.body.style);
    var pos = b.engine && b.engine.type !== 'ev' && b.engine.position && b.engine.position !== 'front' ? b.engine.position + '-engined ' : '';
    var core = b.engine && b.engine.type === 'ev'
      ? (b.engine.motors || 1) + '-motor electric'
      : optName('engineLayouts', b.engine && b.engine.layout) + (b.engine && b.engine.type === 'hybrid' ? ' hybrid' : '');
    return {
      style: style, engine: describeEngine(b), transmission: describeTransmission(b), drivetrain: describeDrivetrain(b),
      headline: (pos + core + ' ' + style.replace(/\b(?![A-Z]{2,}\b)\w+/g, function (w) { return w.toLowerCase(); }) + ', ' + String((b.drivetrain && b.drivetrain.layout) || '').toUpperCase()).replace(/\s+/g, ' ')
    };
  }
  function tyreSize(w, p, d) { return fmt(w) + '/' + fmt(p) + ' R' + fmt(d); }
  function paintName(b) {
    var x = (b && b.exterior) || {};
    var nm = D() && D().swatchName ? D().swatchName(x.paint) : null;
    return (nm || String(x.paint || '').toUpperCase()) + ' · ' + optName('paintFinishes', x.finish);
  }

  /* ======================================================================
     COMPARE MODEL
     ====================================================================== */
  function M(path) { return function (bd) { var v = U.get(bd && bd.metrics, path); return isNum(v) ? v : null; }; }
  function R(key) { return function (bd) { var v = U.get(bd && bd.metrics, 'ratings.' + key); return isNum(v) ? v : null; }; }

  var metricGroups = [
    { group: 'Performance', rows: [
      { key: 'power', label: 'Power', unit: 'hp', d: 0, better: 'high', get: M('power_hp') },
      { key: 'torque', label: 'Torque', unit: 'Nm', d: 0, better: 'high', get: M('torque_nm') },
      { key: 'p2w', label: 'Power-to-weight', unit: 'hp/t', d: 0, better: 'high', get: M('powerToWeight_hpPerTon') },
      { key: 'z60', label: '0–60 mph', unit: 's', d: 2, better: 'low', get: M('zeroTo60_s') },
      { key: 'z100', label: '0–100 km/h', unit: 's', d: 2, better: 'low', get: M('zeroTo100_s') },
      { key: 'z200', label: '0–200 km/h', unit: 's', d: 2, better: 'low', get: M('zeroTo200_s') },
      { key: 'qm', label: '¼ mile', unit: 's', d: 2, better: 'low', get: M('quarterMile_s') },
      { key: 'trap', label: '¼ mile trap', unit: 'mph', d: 1, better: 'high', get: M('quarterMileTrap_mph') },
      { key: 'vmax', label: 'Top speed', unit: 'km/h', d: 0, better: 'high', get: M('topSpeed_kph') },
      { key: 'lap', label: 'Redline Ring lap', unit: '', d: 2, better: 'low', get: M('lapTime_s'), format: fmtLap },
      { key: 'latg', label: 'Lateral grip', unit: 'g', d: 2, better: 'high', get: M('lateralG') },
      { key: 'brake', label: '100–0 km/h', unit: 'm', d: 1, better: 'low', get: M('brakingDist_100_0_m') }
    ] },
    { group: 'Chassis & aero', rows: [
      { key: 'weight', label: 'Kerb weight', unit: 'kg', d: 0, better: 'low', get: M('weight_kg') },
      { key: 'wf', label: 'Front weight', unit: '%', d: 1, better: 'target', target: 50, get: M('weightFront_pct') },
      { key: 'cg', label: 'CG height', unit: 'mm', d: 0, better: 'low', get: M('cgHeight_mm') },
      { key: 'cd', label: 'Drag coefficient', unit: 'Cd', d: 3, better: 'low', get: M('cd') },
      { key: 'cda', label: 'Drag area', unit: 'm²', d: 3, better: 'low', get: M('cda') },
      { key: 'df', label: 'Downforce @ 200', unit: 'kg', d: 0, better: 'high', get: M('downforce_kg_200') },
      { key: 'gf', label: 'Front grip', unit: 'μ', d: 2, better: 'high', get: M('gripFront') },
      { key: 'gr', label: 'Rear grip', unit: 'μ', d: 2, better: 'high', get: M('gripRear') }
    ] },
    { group: 'Efficiency', rows: [
      { key: 'l100', label: 'Consumption', unit: 'L/100 km', d: 1, better: 'low', get: function (bd) { var v = U.get(bd && bd.metrics, 'fuelEconomy_l100'); return isNum(v) && v > 0 ? v : null; } },
      { key: 'whkm', label: 'Energy use', unit: 'Wh/km', d: 0, better: 'low', get: function (bd) { var v = U.get(bd && bd.metrics, 'efficiency_whkm'); return isNum(v) && v > 0 ? v : null; } },
      { key: 'range', label: 'Range', unit: 'km', d: 0, better: 'high', get: M('range_km') },
      { key: 'co2', label: 'CO₂', unit: 'g/km', d: 0, better: 'low', get: M('co2_gkm') }
    ] },
    { group: 'Comfort & ownership', rows: [
      { key: 'comfort', label: 'Comfort index', unit: '/100', d: 0, better: 'high', get: M('comfortIndex') },
      { key: 'rel', label: 'Reliability', unit: '/100', d: 0, better: 'high', get: M('reliabilityScore') },
      { key: 'cabin', label: 'Cabin noise', unit: 'dB', d: 0, better: 'low', get: M('noise_db_cabin') },
      { key: 'exh', label: 'Exhaust volume', unit: 'dB', d: 0, better: null, get: M('exhaust_db') }
    ] },
    { group: 'Price', rows: [
      { key: 'price', label: 'Total price', unit: '', d: 0, better: 'low', get: priceOf, format: function (v) { return money(v); }, deltaFormat: function (v) { return U.fmtMoney(v, { sign: true, compact: Math.abs(v) >= 10000 }); } },
      { key: 'monthly', label: 'Finance / month', unit: '', d: 0, better: 'low', get: monthlyOf, format: function (v) { return money(v); }, deltaFormat: function (v) { return U.fmtMoney(v, { sign: true }); } },
      { key: 'weeks', label: 'Build time', unit: 'weeks', d: 0, better: 'low', get: function (bd) { var v = U.get(bd && bd.pricing, 'buildTime_weeks'); return isNum(v) ? v : null; } },
      { key: 'ins', label: 'Insurance group', unit: '/50', d: 0, better: 'low', get: function (bd) { var v = U.get(bd && bd.pricing, 'insuranceGroup'); return isNum(v) ? v : null; } }
    ] },
    { group: 'Ratings', rows: RATING_KEYS.map(function (k) { return { key: 'r_' + k, label: titleCase(k), unit: '/100', d: 0, better: 'high', get: R(k), bar: true }; }) },
    { group: 'Validation', rows: [
      { key: 'errors', label: 'Errors', unit: '', d: 0, better: 'low', get: function (bd) { return bd && has('rules.validate') ? countSev(bd, 'error') : null; } },
      { key: 'warnings', label: 'Warnings', unit: '', d: 0, better: 'low', get: function (bd) { return bd && has('rules.validate') ? countSev(bd, 'warning') : null; } },
      { key: 'legal', label: 'Street legal', text: true, get: function (bd) { return bd && bd.legality ? (bd.legality.streetLegal ? 'Yes' : 'No') : '—'; } }
    ] }
  ];

  var configRows = [
    { key: 'c_style', label: 'Body', get: function (b) { return optName('bodyStyles', b.body.style) + ' · ' + b.body.doors + '-door · ' + b.body.seats + ' seats'; } },
    { key: 'c_chassis', label: 'Chassis', get: function (b) { return optName('chassisMaterials', b.body.chassisMaterial) + ' · ' + fmt(b.body.wheelbase_mm) + ' mm wb'; } },
    { key: 'c_engine', label: 'Powertrain', get: function (b) { return describeEngine(b); } },
    { key: 'c_pos', label: 'Engine position', get: function (b) { return b.engine.type === 'ev' ? 'Motors on axles' : titleCase(b.engine.position); } },
    { key: 'c_tune', label: 'Tune & exhaust', get: function (b) { return b.engine.type === 'ev' ? optName('tunes', b.engine.tune) : optName('tunes', b.engine.tune) + ' · ' + optName('exhausts', b.engine.exhaust); } },
    { key: 'c_trans', label: 'Gearbox', get: describeTransmission },
    { key: 'c_drive', label: 'Drivetrain', get: describeDrivetrain },
    { key: 'c_susp', label: 'Suspension', get: function (b) { return optName('suspensionTypes', b.suspension.type) + ' · ' + fmt(b.suspension.rideHeight_mm) + ' mm'; } },
    { key: 'c_brakes', label: 'Brakes', get: function (b) { return optName('brakeMaterials', b.brakes.material) + ' · ' + fmt(b.brakes.frontRotor_mm) + '/' + fmt(b.brakes.rearRotor_mm) + ' mm'; } },
    { key: 'c_wheels', label: 'Wheels', get: function (b) { return fmt(b.wheels.diameter_in) + '″ ' + optName('wheelMaterials', b.wheels.material).toLowerCase() + ' ' + optName('wheelDesigns', b.wheels.design); } },
    { key: 'c_tyres', label: 'Tyres', get: function (b) { return optName('tireCompounds', b.tires.compound) + ' · ' + tyreSize(b.tires.widthFront_mm, b.tires.profileFront, b.wheels.diameter_in) + (b.tires.widthRear_mm !== b.tires.widthFront_mm || b.tires.profileRear !== b.tires.profileFront ? ' / ' + tyreSize(b.tires.widthRear_mm, b.tires.profileRear, b.wheels.diameter_in) : ''); } },
    { key: 'c_aero', label: 'Aero', get: function (b) { return [optName('aero.splitters', b.aero.splitter), optName('aero.wings', b.aero.wing), optName('aero.diffusers', b.aero.diffuser)].join(' · ') + (b.aero.activeAero ? ' · active' : ''); } },
    { key: 'c_paint', label: 'Paint', get: paintName, color: function (b) { return b.exterior.paint; } },
    { key: 'c_int', label: 'Interior', get: function (b) { return optName('upholsteries', b.interior.upholstery) + ' · ' + optName('seatTypes', b.interior.seatType); }, color: function (b) { return b.interior.primaryColor; } }
  ];

  /** Indices of best and worst numeric values. Needs ≥2 numbers that are not all equal. */
  function bestIndices(values, better, target) {
    var out = { best: [], worst: [] };
    if (!better) return out;
    var idx = [];
    values.forEach(function (v, i) { if (isNum(v)) idx.push(i); });
    if (idx.length < 2) return out;
    var score = function (v) { return better === 'high' ? v : better === 'low' ? -v : -Math.abs(v - num(target, 0)); };
    var scores = idx.map(function (i) { return score(values[i]); });
    var hi = Math.max.apply(null, scores), lo = Math.min.apply(null, scores);
    if (Math.abs(hi - lo) < 1e-9) return out;
    idx.forEach(function (i, j) {
      if (Math.abs(scores[j] - hi) < 1e-9) out.best.push(i);
      if (Math.abs(scores[j] - lo) < 1e-9) out.worst.push(i);
    });
    return out;
  }

  function roundTo(v, d) { var f = Math.pow(10, d || 0); return Math.round(v * f) / f; }

  /**
   * compareRows(bundles, { onlyDiff, includeConfig=true }) → grouped rows.
   * Cell 0 is the reference for deltas.
   */
  function compareRows(bundles, opts) {
    opts = opts || {};
    bundles = bundles || [];
    var groups = [];
    if (opts.includeConfig !== false) {
      var cfg = { group: 'Configuration', rows: [] };
      configRows.forEach(function (r) {
        var cells = bundles.map(function (bd) {
          var b = bd && bd.build;
          var t = b ? safe(function () { return r.get(b); }, '—') : '—';
          return { v: t, text: t, color: b && r.color ? safe(function () { return r.color(b); }, null) : null };
        });
        var differs = cells.some(function (c) { return c.text !== cells[0].text; });
        cells.forEach(function (c, i) { c.changed = i > 0 && c.text !== cells[0].text; });
        if (!opts.onlyDiff || differs) cfg.rows.push({ key: r.key, label: r.label, text: true, differs: differs, cells: cells });
      });
      if (cfg.rows.length) groups.push(cfg);
    }
    metricGroups.forEach(function (g) {
      var out = { group: g.group, rows: [] };
      g.rows.forEach(function (r) {
        if (r.text) {
          var tc = bundles.map(function (bd) { var t = safe(function () { return r.get(bd); }, '—'); return { v: t, text: t }; });
          var tdiff = tc.some(function (c) { return c.text !== tc[0].text; });
          if (!opts.onlyDiff || tdiff) out.rows.push({ key: r.key, label: r.label, text: true, differs: tdiff, cells: tc });
          return;
        }
        var vals = bundles.map(function (bd) { var v = safe(function () { return r.get(bd); }, null); return isNum(v) ? v : null; });
        var rounded = vals.map(function (v) { return v == null ? null : roundTo(v, r.d); });
        var bi = bestIndices(rounded, r.better, r.target);
        var differs = rounded.some(function (v) { return v !== rounded[0]; });
        if (opts.onlyDiff && !differs) return;
        if (opts.hideEmpty !== false && rounded.every(function (v) { return v == null; })) return;
        var ref = rounded[0];
        var cells = rounded.map(function (v, i) {
          var c = { v: v, text: v == null ? '—' : (r.format ? r.format(v) : U.fmtNum(v, r.d)), best: bi.best.indexOf(i) >= 0, worst: bi.worst.indexOf(i) >= 0 };
          if (i > 0 && v != null && ref != null) {
            var dlt = roundTo(v - ref, r.d);
            c.delta = dlt;
            if (dlt !== 0) {
              c.deltaText = r.deltaFormat ? r.deltaFormat(dlt) : (dlt > 0 ? '+' : '−') + U.fmtNum(Math.abs(dlt), r.d);
              c.deltaGood = r.better === 'high' ? dlt > 0 : r.better === 'low' ? dlt < 0 : r.better === 'target' ? Math.abs(v - r.target) < Math.abs(ref - r.target) : null;
            }
          }
          return c;
        });
        out.rows.push({ key: r.key, label: r.label, unit: r.unit, better: r.better, bar: !!r.bar, differs: differs, cells: cells });
      });
      if (out.rows.length) groups.push(out);
    });
    return groups;
  }

  /** Count best-in-row wins per column across numeric rows. */
  function tallyWins(groups, n) {
    var wins = []; for (var i = 0; i < n; i++) wins.push(0);
    var contested = 0;
    groups.forEach(function (g) {
      g.rows.forEach(function (r) {
        if (r.text || !r.better) return;
        var any = false;
        r.cells.forEach(function (c, i) { if (c.best) { wins[i]++; any = true; } });
        if (any) contested++;
      });
    });
    return { wins: wins, contested: contested };
  }

  /* ======================================================================
     SPEC SHEET MODEL
     ====================================================================== */
  function yes(v) { return v ? 'Yes' : 'No'; }
  function specSections(b, bundle) {
    if (!b) return [];
    bundle = bundle || compute(b);
    var m = (bundle && bundle.metrics) || {};
    var e = b.engine, t = b.transmission, dt = b.drivetrain, su = b.suspension, br = b.brakes, wh = b.wheels, ti = b.tires,
      ae = b.aero, w = b.weight, x = b.exterior, it = b.interior, te = b.tech;
    var style = find('bodyStyles', b.body.style) || {};
    var preset = b.meta.presetId && D().preset ? D().preset(b.meta.presetId) : null;
    var sections = [];
    function sec(id, title, rows) { sections.push({ id: id, title: title, rows: rows.filter(Boolean) }); }
    function row(label, value, color) { return { label: label, value: value == null || value === '' ? '—' : String(value), color: color || null }; }

    sec('overview', 'Overview', [
      row('Model', b.meta.name),
      row('Body style', style.name),
      row('Concept', describe(b).headline),
      preset ? row('Based on', preset.name) : null,
      row('Build reference', String(b.meta.id || '').toUpperCase()),
      row('Created', fmtDate(b.meta.created)),
      row('Last modified', fmtDate(b.meta.modified))
    ]);
    sec('body', 'Body & chassis', [
      row('Body', style.name + ', ' + b.body.doors + ' doors, ' + b.body.seats + ' seats'),
      row('Chassis', optName('chassisMaterials', b.body.chassisMaterial)),
      row('Wheelbase', fmt(b.body.wheelbase_mm) + ' mm'),
      row('Track width', fmt(b.body.trackWidth_mm) + ' mm'),
      style.svg ? row('Length × width × height', fmt(num(style.svg.length_mm) + (num(b.body.wheelbase_mm) - num(style.defaultWheelbase, b.body.wheelbase_mm))) + ' × ' + fmt(num(style.svg.width_mm) + (num(b.body.trackWidth_mm, 1600) - 1600)) + ' × ' + fmt(style.svg.height_mm) + ' mm') : null,
      style.cargo_l ? row('Luggage', fmt(style.cargo_l) + ' L') : null
    ]);
    if (e.type !== 'ev') {
      var asp = find('aspirations', e.aspiration);
      sec('engine', e.type === 'hybrid' ? 'Combustion engine' : 'Engine', [
        row('Layout', optName('engineLayouts', e.layout) + ' · ' + titleCase(e.position) + '-mounted'),
        row('Displacement', U.fmtNum(num(e.displacement_l), 1) + ' L'),
        row('Aspiration', asp ? asp.name + (asp.id !== 'na' ? ' · ' + U.fmtNum(num(e.boost_bar), 2) + ' bar' : '') : '—'),
        row('Compression', U.fmtNum(num(e.compression), 1) + ':1'),
        row('Fuel', optName('fuels', e.fuel)),
        row('Redline', fmt(e.redline_rpm) + ' rpm'),
        row('Calibration', optName('tunes', e.tune)),
        row('Exhaust', optName('exhausts', e.exhaust)),
        row('Cooling', optName('coolings', e.cooling))
      ]);
    }
    if (e.type === 'ev' || e.type === 'hybrid') {
      sec('electric', e.type === 'ev' ? 'Electric drive' : 'Hybrid system', [
        row('Motors', e.motors + ' × ' + fmt(e.motorPower_kw) + ' kW (' + fmt(e.motors * e.motorPower_kw) + ' kW combined)'),
        row('Battery', U.fmtNum(num(e.battery_kwh), 1) + ' kWh · ' + optName('batteryChemistries', e.chemistry)),
        row('Architecture', e.voltage + ' V'),
        row('Regeneration', ['Off', 'Low', 'Medium', 'High'][num(e.regen)] || e.regen),
        e.type === 'ev' ? row('Calibration', optName('tunes', e.tune)) : null
      ]);
    }
    sec('driveline', 'Transmission & driveline', [
      row('Gearbox', describeTransmission(b)),
      t.ratios && t.ratios.length > 1 ? row('Ratios', t.ratios.map(function (r) { return U.fmtNum(r, 2); }).join(' · ')) : null,
      row('Final drive', U.fmtNum(num(t.finalDrive), 2) + ':1'),
      row('Launch control', yes(t.launchControl)),
      row('Layout', optName('drivetrainLayouts', dt.layout)),
      dt.layout !== 'rwd' ? row('Front differential', optName('differentials', dt.frontDiff)) : null,
      dt.layout !== 'fwd' ? row('Rear differential', optName('differentials', dt.rearDiff)) : null,
      dt.layout === 'awd' ? row('Centre differential', optName('differentials', dt.centerDiff)) : null,
      row('Torque split F/R', num(dt.torqueSplitFront_pct) + ' / ' + (100 - num(dt.torqueSplitFront_pct)) + ' %'),
      row('Torque vectoring', yes(dt.torqueVectoring)),
      row('Traction control', ['Off', 'Sport', 'Normal', 'Max'][num(dt.tractionControl)] || dt.tractionControl)
    ]);
    sec('suspension', 'Suspension', [
      row('Type', optName('suspensionTypes', su.type)),
      row('Springs F/R', fmt(su.springFront_nmm) + ' / ' + fmt(su.springRear_nmm) + ' N/mm'),
      row('Damping', su.damping + ' / 10'),
      row('Ride height', fmt(su.rideHeight_mm) + ' mm'),
      row('Camber F/R', U.fmtNum(su.camberFront_deg, 1) + '° / ' + U.fmtNum(su.camberRear_deg, 1) + '°'),
      row('Toe F/R', U.fmtNum(su.toeFront_deg, 2) + '° / ' + U.fmtNum(su.toeRear_deg, 2) + '°'),
      row('Anti-roll bars F/R', su.arbFront + ' / ' + su.arbRear)
    ]);
    sec('brakes', 'Brakes', [
      row('Discs', optName('brakeMaterials', br.material)),
      row('Rotors F/R', fmt(br.frontRotor_mm) + ' / ' + fmt(br.rearRotor_mm) + ' mm'),
      row('Calipers F/R', br.frontPistons + '-piston / ' + br.rearPistons + '-piston', x.caliperColor),
      row('ABS', optName('absModes', br.abs))
    ]);
    sec('wheels', 'Wheels & tyres', [
      row('Design', optName('wheelDesigns', wh.design) + ' · ' + optName('wheelMaterials', wh.material), wh.finish),
      row('Diameter', fmt(wh.diameter_in) + '″' + (wh.staggered ? ' (staggered)' : '')),
      row('Rim width F/R', U.fmtNum(wh.widthFront_in, 1) + 'J / ' + U.fmtNum(wh.widthRear_in, 1) + 'J'),
      row('Compound', optName('tireCompounds', ti.compound)),
      row('Front tyres', tyreSize(ti.widthFront_mm, ti.profileFront, wh.diameter_in)),
      row('Rear tyres', tyreSize(ti.widthRear_mm, ti.profileRear, wh.diameter_in))
    ]);
    sec('aero', 'Aerodynamics', [
      row('Splitter', optName('aero.splitters', ae.splitter)),
      row('Rear wing', optName('aero.wings', ae.wing) + (ae.wing !== 'none' ? ' · ' + ae.wingAngle_deg + '°' : '')),
      row('Diffuser', optName('aero.diffusers', ae.diffuser)),
      row('Canards / skirts', yes(ae.canards) + ' / ' + yes(ae.sideSkirts)),
      row('Active aero', yes(ae.activeAero))
    ]);
    sec('weight', 'Weight programme', [
      row('Sound deadening', w.soundDeadening ? 'Fitted' : 'Deleted'),
      row('Rear seats', w.rearSeats ? 'Fitted' : 'Deleted'),
      row('Spare wheel', w.spareTire ? 'Fitted' : 'Repair kit'),
      row('Glazing', optName('glassTypes', w.glass)),
      row('12 V battery', optName('batteryTypes', w.battery)),
      row('Roll cage', optName('rollCages', w.rollCage)),
      w.ballast_kg > 0 ? row('Ballast', w.ballast_kg + ' kg · ' + w.ballastPosition) : null
    ]);
    sec('exterior', 'Exterior', [
      row('Paint', paintName(b), x.paint),
      row('Roof', optName('roofTypes', x.roof), x.roof === 'contrast' ? x.roofColor : null),
      row('Stripes', optName('stripes', x.stripe), x.stripe !== 'none' ? x.stripeColor : null),
      row('Lights', optName('lightTypes', x.lights)),
      row('Mirrors', optName('mirrorTypes', x.mirrors)),
      row('Badging', optName('badgeTypes', x.badge)),
      row('Window tint', x.windowTint_pct + ' %'),
      x.livery_number ? row('Race number', '#' + x.livery_number) : null
    ]);
    sec('interior', 'Interior', [
      row('Seats', optName('seatTypes', it.seatType)),
      row('Upholstery', optName('upholsteries', it.upholstery), it.primaryColor),
      row('Accent / stitching', String(it.accentColor).toUpperCase() + ' / ' + String(it.stitchColor).toUpperCase(), it.accentColor),
      row('Trim', optName('trims', it.trim)),
      row('Steering wheel', optName('steeringTypes', it.steering)),
      row('Headliner', optName('headliners', it.headliner)),
      row('Ambient lighting', it.ambientLighting ? 'On' : 'Off', it.ambientLighting ? it.ambientColor : null),
      row('Harness', yes(it.harness))
    ]);
    sec('tech', 'Technology', [
      row('Centre screen', optName('screenSizes', te.screen_in)),
      row('Digital cluster / HUD', yes(te.digitalCluster) + ' / ' + yes(te.hud)),
      row('Audio', optName('audioSystems', te.audio)),
      row('Driver assistance', optName('adasLevels', te.adas)),
      row('Climate zones', te.climateZones),
      row('Telemetry / lift / night vision', yes(te.telemetry) + ' / ' + yes(te.liftSystem) + ' / ' + yes(te.nightVision))
    ]);
    if (bundle && bundle.metrics) {
      sec('performance', 'Performance (simulated)', [
        row('Power', fmt(m.power_hp) + ' hp (' + fmt(m.power_kw) + ' kW)' + (isNum(m.peakPowerRpm) ? ' @ ' + fmt(m.peakPowerRpm) + ' rpm' : '')),
        row('Torque', fmt(m.torque_nm) + ' Nm' + (isNum(m.peakTorqueRpm) ? ' @ ' + fmt(m.peakTorqueRpm) + ' rpm' : '')),
        row('Kerb weight', fmt(m.weight_kg) + ' kg · ' + fmt(m.weightFront_pct, 1) + ' % front'),
        row('Power-to-weight', fmt(m.powerToWeight_hpPerTon) + ' hp/t'),
        row('0–60 mph / 0–100 km/h', fmt(m.zeroTo60_s, 2) + ' s / ' + fmt(m.zeroTo100_s, 2) + ' s' + (m.zeroTo60_note ? ' (' + m.zeroTo60_note + ')' : '')),
        row('0–200 km/h', m.zeroTo200_s == null ? 'Not reached' : fmt(m.zeroTo200_s, 2) + ' s'),
        row('Quarter mile', fmt(m.quarterMile_s, 2) + ' s @ ' + fmt(m.quarterMileTrap_mph, 1) + ' mph'),
        row('Top speed', fmt(m.topSpeed_kph) + ' km/h (' + fmt(m.topSpeed_mph) + ' mph)' + (m.topSpeedLimitedBy ? ' · ' + m.topSpeedLimitedBy + '-limited' : '')),
        row('Braking 100–0', fmt(m.brakingDist_100_0_m, 1) + ' m'),
        row('Lateral grip', fmt(m.lateralG, 2) + ' g'),
        row('Downforce @ 200 km/h', fmt(m.downforce_kg_200) + ' kg'),
        row('Drag', 'Cd ' + fmt(m.cd, 3) + ' · CdA ' + fmt(m.cda, 3) + ' m²'),
        row('Redline Ring lap', fmtLap(m.lapTime_s))
      ]);
      sec('efficiency', 'Efficiency & refinement', [
        e.type !== 'ev' ? row('Consumption', fmt(m.fuelEconomy_l100, 1) + ' L/100 km (' + fmt(m.fuelEconomy_mpg, 1) + ' mpg)') : null,
        e.type !== 'ice' ? row('Energy use', fmt(m.efficiency_whkm) + ' Wh/km') : null,
        row('Range', fmt(m.range_km) + ' km'),
        row('CO₂', fmt(m.co2_gkm) + ' g/km'),
        row('Cabin noise', fmt(m.noise_db_cabin) + ' dB'),
        e.type !== 'ev' ? row('Exhaust', fmt(m.exhaust_db) + ' dB') : null,
        row('Reliability', fmt(m.reliabilityScore) + ' / 100'),
        row('Comfort', fmt(m.comfortIndex) + ' / 100')
      ]);
    }
    return sections;
  }

  /** Plain-text summary of a build (share sheet / clipboard / spec "copy as text"). */
  function textSummary(b, opts) {
    opts = opts || {};
    var bd = compute(b), m = bd.metrics || {}, md = opts.markdown;
    var lines = [];
    var d = describe(b);
    lines.push(md ? '### ' + b.meta.name : b.meta.name.toUpperCase());
    lines.push(d.headline.charAt(0).toUpperCase() + d.headline.slice(1));
    lines.push('');
    var kv = [
      ['Powertrain', d.engine], ['Gearbox', d.transmission], ['Drivetrain', d.drivetrain],
      ['Power', bd.metrics ? fmt(m.power_hp) + ' hp / ' + fmt(m.torque_nm) + ' Nm' : null],
      ['0–100 km/h', bd.metrics ? fmt(m.zeroTo100_s, 2) + ' s' : null],
      ['Top speed', bd.metrics ? fmt(m.topSpeed_kph) + ' km/h' : null],
      ['Weight', bd.metrics ? fmt(m.weight_kg) + ' kg' : null],
      ['Lap (Redline Ring)', bd.metrics ? fmtLap(m.lapTime_s) : null],
      ['Paint', paintName(b)],
      ['Price', priceOf(bd) != null ? money(priceOf(bd)) : null]
    ].filter(function (r) { return r[1]; });
    kv.forEach(function (r) { lines.push(md ? '- **' + r[0] + ':** ' + r[1] : r[0] + ': ' + r[1]); });
    if (opts.url) { lines.push(''); lines.push(md ? '[Open in the Redline Garage](' + opts.url + ')' : opts.url); }
    return lines.join('\n');
  }

  /* ======================================================================
     THUMBNAIL — CB.render.thumbnail if present, else a parametric side profile
     built from the catalog's per-style svg hints.
     ====================================================================== */
  var thumbSeq = 0;
  function thumbnail(build, opts) {
    if (!build) return '';
    if (CB.render && typeof CB.render.thumbnail === 'function') {
      var t = safe(function () { return CB.render.thumbnail(build, opts); }, null, 'render.thumbnail');
      if (typeof t === 'string' && t.indexOf('<svg') >= 0) return t;
    }
    return fallbackThumb(build);
  }

  function smoothPath(pts, closed) {
    // Catmull-Rom → cubic Bézier, tension 0.5 (k = 1/6)
    var n = pts.length, s = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var i = 0; i < n - (closed ? 0 : 1); i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      if (!closed) { if (i === 0) p0 = p1; if (i + 2 >= n) p3 = p2; }
      var k = p1[2] === 'sharp' || p2[2] === 'sharp' ? 0 : 1 / 6;
      var c1x = p1[0] + (p2[0] - p0[0]) * k, c1y = p1[1] + (p2[1] - p0[1]) * k;
      var c2x = p2[0] - (p3[0] - p1[0]) * k, c2y = p2[1] - (p3[1] - p1[1]) * k;
      s += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return s + (closed ? ' Z' : '');
  }

  function fallbackThumb(b) {
    var style = find('bodyStyles', b.body && b.body.style) || (D() && D().bodyStyles[0]) || {};
    var h = style.svg || { length_mm: 4550, height_mm: 1300, frontOverhang_mm: 930, rearOverhang_mm: 970, noseHeight: 0.46, cabinStart: 0.4, roofStart: 0.52, roofEnd: 0.66, cabinEnd: 0.84, roofHeight: 1, beltline: 0.68, deckHeight: 0.72, tailHeight: 0.6 };
    var W = 320, H = 150, ground = 132, padX = 14;
    var L = num(h.length_mm, 4500), scale = (W - padX * 2) / Math.max(L, 4300);
    var x0 = (W - L * scale) / 2;
    var ride = num(b.suspension && b.suspension.rideHeight_mm, 120);
    var bodyTop = num(h.height_mm, 1300) * scale;
    var bottom = ground - Math.max(6, ride * scale);
    var ty = function (f) { return ground - f * bodyTop * (1 - 0.06) - 0.06 * bodyTop; };
    var tx = function (f) { return x0 + f * L * scale; };
    var ys = function (f) { return Math.min(bottom, ty(f)); };
    var open = !!h.openTop;
    var nose = num(h.noseHeight, 0.46), belt = num(h.beltline, 0.66), deck = num(h.deckHeight, 0.7), tail = num(h.tailHeight, 0.6);
    var cs = num(h.cabinStart, 0.4), rs = num(h.roofStart, 0.5), re = num(h.roofEnd, 0.7), ce = num(h.cabinEnd, 0.85), rh = num(h.roofHeight, 1);
    var pts = [
      [tx(0.004), bottom - 2],
      [tx(0.0), ys(nose * 0.62)],
      [tx(0.025), ys(nose)],
      [tx(cs * 0.55), ys((nose + belt) / 2 + 0.03)],
      [tx(cs), ys(belt + 0.02), 'sharp']
    ];
    if (open) {
      pts.push([tx(rs), ys(rh * 0.9), 'sharp'], [tx(rs + 0.02), ys(belt + 0.04)], [tx(ce), ys(deck)]);
    } else {
      pts.push([tx(rs), ys(rh * 0.985)], [tx((rs + re) / 2), ys(rh)], [tx(re), ys(rh * 0.975)], [tx(ce), ys(deck), h.tailStyle === 'wagon' || h.tailStyle === 'box' || h.tailStyle === 'bed' ? 'sharp' : null]);
    }
    if (h.tailStyle === 'bed') pts.push([tx(0.985), ys(deck), 'sharp']);
    else pts.push([tx(0.97), ys((deck + tail) / 2 + 0.02)]);
    pts.push([tx(1.0), ys(tail * 0.72)], [tx(0.996), bottom - 2]);

    var frontAxle = tx(num(h.frontOverhang_mm, 930) / L), rearAxle = tx(1 - num(h.rearOverhang_mm, 970) / L);
    var dia = num(b.wheels && b.wheels.diameter_in, 19), tw = num(b.tires && b.tires.widthFront_mm, 255), tp = num(b.tires && b.tires.profileFront, 35);
    var od = dia * 25.4 + 2 * tw * tp / 100;
    var wr = Math.max(9, od / 2 * scale), rimR = dia * 25.4 / 2 * scale;
    var wy = ground - wr;
    var paint = U.normHex ? U.normHex(b.exterior && b.exterior.paint, '#b3121f') : (b.exterior && b.exterior.paint) || '#b3121f';
    var finish = (b.exterior && b.exterior.finish) || 'metallic';
    var fin = find('paintFinishes', finish) || { gloss: 0.6, metallic: 0.5 };
    var rim = (b.wheels && b.wheels.finish) || '#2b2b2b';
    var caliper = (b.exterior && b.exterior.caliperColor) || '#f2c200';
    var id = 'gxt' + (++thumbSeq) + '_' + (U.hash ? U.hash(paint + style.id).toString(36) : thumbSeq);
    var top = finish === 'chameleon' && U.hueShift ? U.hueShift(paint, 70) : U.shade(paint, finish === 'chrome' ? 55 : 22);
    var low = U.shade(paint, finish === 'matte' ? -30 : -52);
    var gloss = finish === 'matte' ? 0.05 : finish === 'satin' ? 0.16 : finish === 'chrome' ? 0.85 : 0.25 + num(fin.gloss, 0.6) * 0.35;
    var body = smoothPath(pts, true);
    var glass;
    if (open) {
      glass = 'M' + tx(cs + 0.01).toFixed(1) + ' ' + ys(belt + 0.03).toFixed(1) + ' L' + tx(rs - 0.005).toFixed(1) + ' ' + ys(rh * 0.86).toFixed(1) + ' L' + tx(rs + 0.012).toFixed(1) + ' ' + ys(rh * 0.86).toFixed(1) + ' L' + tx(rs + 0.02).toFixed(1) + ' ' + ys(belt + 0.03).toFixed(1) + ' Z';
    } else {
      var gi = 0.05;
      glass = smoothPath([
        [tx(cs + 0.025), ys(belt + 0.035), 'sharp'], [tx(rs + 0.012), ys(rh - gi)], [tx((rs + re) / 2), ys(rh - gi * 0.9)],
        [tx(re - 0.008), ys(rh - gi * 1.05)], [tx(ce - 0.03), ys(Math.max(belt, deck) + 0.035), 'sharp']
      ], true);
    }
    var tint = num(b.exterior && b.exterior.windowTint_pct, 20) / 100;
    var s = [];
    s.push('<svg class="gx-thumb-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc((b.meta && b.meta.name) || style.name || 'Car') + '">');
    s.push('<defs>' +
      '<linearGradient id="' + id + 'p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + top + '"/><stop offset=".5" stop-color="' + paint + '"/><stop offset="1" stop-color="' + low + '"/></linearGradient>' +
      '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a9bccd" stop-opacity="' + (0.85 - tint * 0.6).toFixed(2) + '"/><stop offset=".55" stop-color="#18222d"/><stop offset="1" stop-color="#05070a"/></linearGradient>' +
      '<linearGradient id="' + id + 's" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".55" stop-color="#fff" stop-opacity="' + gloss.toFixed(2) + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<radialGradient id="' + id + 'sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".7"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
      '<clipPath id="' + id + 'c"><path d="' + body + '"/></clipPath></defs>');
    s.push('<ellipse cx="' + (W / 2) + '" cy="' + (ground + 2) + '" rx="' + (L * scale * 0.52).toFixed(1) + '" ry="7" fill="url(#' + id + 'sh)"/>');
    // wing (behind body)
    var wing = (b.aero && b.aero.wing) || 'none';
    var tailX = tx(0.94), deckY = ys(deck);
    if (wing === 'gt-wing' || wing === 'swan-neck' || wing === 'biplane' || wing === 'active') {
      var wy0 = deckY - (wing === 'swan-neck' ? 17 : 13);
      s.push('<path d="M' + (tailX - 14) + ' ' + (deckY + 1) + ' L' + (tailX - 11) + ' ' + wy0 + ' M' + (tailX + 4) + ' ' + (deckY + 1) + ' L' + (tailX + 6) + ' ' + wy0 + '" stroke="#111" stroke-width="2.4"/>');
      s.push('<path d="M' + (tailX - 26) + ' ' + wy0 + ' L' + (tailX + 16) + ' ' + (wy0 - 3) + ' L' + (tailX + 16) + ' ' + (wy0 + 2) + ' L' + (tailX - 26) + ' ' + (wy0 + 3) + ' Z" fill="' + U.shade(paint, -60) + '"/>');
      if (wing === 'biplane') s.push('<path d="M' + (tailX - 22) + ' ' + (wy0 + 7) + ' L' + (tailX + 14) + ' ' + (wy0 + 5) + ' L' + (tailX + 14) + ' ' + (wy0 + 8) + ' L' + (tailX - 22) + ' ' + (wy0 + 9) + ' Z" fill="#111"/>');
    }
    s.push('<path d="' + body + '" fill="url(#' + id + 'p)" stroke="rgba(0,0,0,.55)" stroke-width="1"/>');
    s.push('<g clip-path="url(#' + id + 'c)">');
    var stripe = (b.exterior && b.exterior.stripe) || 'none', sc = (b.exterior && b.exterior.stripeColor) || '#fff';
    var midY = ys((belt + 0.3) / 1.6);
    if (stripe === 'racing-dual' || stripe === 'center' || stripe === 'hood' || stripe === 'le-mans') s.push('<rect x="0" y="' + (ys(belt) + 2).toFixed(1) + '" width="' + W + '" height="4" fill="' + sc + '" opacity=".9"/>');
    if (stripe === 'side-skirt' || stripe === 'le-mans' || stripe === 'gradient') s.push('<rect x="0" y="' + (bottom - 9).toFixed(1) + '" width="' + W + '" height="4" fill="' + sc + '" opacity=".85"/>');
    if (stripe === 'pinstripe') s.push('<rect x="0" y="' + midY.toFixed(1) + '" width="' + W + '" height="1" fill="' + sc + '"/>');
    s.push('<rect x="0" y="' + (ys(rh) - 2).toFixed(1) + '" width="' + W + '" height="' + (bodyTop * 0.42).toFixed(1) + '" fill="url(#' + id + 's)"/>');
    s.push('<rect x="0" y="' + (bottom - 5).toFixed(1) + '" width="' + W + '" height="8" fill="#000" opacity=".32"/>');
    s.push('</g>');
    var roof = (b.exterior && b.exterior.roof) || 'body';
    s.push('<path d="' + glass + '" fill="url(#' + id + 'g)" stroke="rgba(0,0,0,.6)" stroke-width=".8"/>');
    if (!open && roof !== 'body' && roof !== 'glass') {
      var rc = roof === 'black' ? '#0c0c0e' : roof === 'carbon' ? '#1d1f22' : (b.exterior.roofColor || '#111');
      s.push('<path d="M' + tx(rs + 0.01).toFixed(1) + ' ' + (ys(rh) + 0.6).toFixed(1) + ' L' + tx(re - 0.01).toFixed(1) + ' ' + (ys(rh) + 0.8).toFixed(1) + '" stroke="' + rc + '" stroke-width="3" stroke-linecap="round"/>');
    }
    var number = b.exterior && b.exterior.livery_number;
    if (number) {
      var nx = (frontAxle + rearAxle) / 2, ny = (ys(belt) + bottom) / 2;
      s.push('<circle cx="' + nx.toFixed(1) + '" cy="' + ny.toFixed(1) + '" r="8.5" fill="#f4f1ea" stroke="#111" stroke-width="1"/>');
      s.push('<text x="' + nx.toFixed(1) + '" y="' + (ny + 3.4).toFixed(1) + '" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="9.5" fill="#111">' + esc(String(number).slice(0, 3)) + '</text>');
    }
    var lights = (b.exterior && b.exterior.lights) || 'led';
    s.push('<path d="M' + (tx(0.006) + 1).toFixed(1) + ' ' + ys(nose * 0.9).toFixed(1) + ' l7 1.2 l-.6 3.4 l-6.6 -1.2 z" fill="' + (lights === 'halogen' ? '#ffe2a0' : lights === 'laser' ? '#cfe6ff' : '#f4f8ff') + '"/>');
    s.push('<path d="M' + (tx(0.996) - 1).toFixed(1) + ' ' + ys(tail * 0.9).toFixed(1) + ' l-6 1 l.5 3.2 l5.5 -.8 z" fill="#ff2a2a"/>');
    var design = find('wheelDesigns', b.wheels && b.wheels.design) || { spokes: 5, style: 'y' };
    [frontAxle, rearAxle].forEach(function (cx) {
      s.push('<circle cx="' + cx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="' + (wr + 2.6).toFixed(1) + '" fill="#060607"/>');
      s.push('<circle cx="' + cx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="' + wr.toFixed(1) + '" fill="#121214" stroke="#2c2c30" stroke-width="1.2"/>');
      s.push('<circle cx="' + cx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="' + rimR.toFixed(1) + '" fill="' + U.shade(rim, -25) + '" stroke="' + U.shade(rim, 35) + '" stroke-width="1"/>');
      var sp = design.style === 'aero-disc' ? 0 : Math.min(12, Math.max(4, num(design.spokes, 5)));
      if (sp) {
        for (var k = 0; k < sp; k++) {
          var a = (k / sp) * Math.PI * 2 - Math.PI / 2;
          s.push('<line x1="' + cx.toFixed(1) + '" y1="' + wy.toFixed(1) + '" x2="' + (cx + Math.cos(a) * rimR * 0.92).toFixed(1) + '" y2="' + (wy + Math.sin(a) * rimR * 0.92).toFixed(1) + '" stroke="' + U.shade(rim, 40) + '" stroke-width="' + (sp > 10 ? 0.9 : 1.6) + '" stroke-linecap="round"/>');
        }
      } else {
        s.push('<circle cx="' + cx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="' + (rimR * 0.82).toFixed(1) + '" fill="' + U.shade(rim, 18) + '"/>');
      }
      s.push('<path d="M' + (cx + rimR * 0.35).toFixed(1) + ' ' + (wy - rimR * 0.62).toFixed(1) + ' A' + (rimR * 0.72).toFixed(1) + ' ' + (rimR * 0.72).toFixed(1) + ' 0 0 1 ' + (cx + rimR * 0.7).toFixed(1) + ' ' + (wy - rimR * 0.1).toFixed(1) + '" stroke="' + caliper + '" stroke-width="3" fill="none" stroke-linecap="round"/>');
      s.push('<circle cx="' + cx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="' + (rimR * 0.16).toFixed(1) + '" fill="#111" stroke="' + U.shade(rim, 50) + '" stroke-width=".6"/>');
    });
    s.push('</svg>');
    return s.join('');
  }

  /* ======================================================================
     SURPRISE ME — archetype-driven random builds
     random → normalize → CB.rules auto-fixes (errors, then tidy warnings) → best of N attempts
     ====================================================================== */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    if (seed == null) return Math.random;
    if (typeof seed === 'string') seed = U.hash ? U.hash(seed) : seed.length;
    return mulberry32(Number(seed) || 1);
  }
  function rpick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }
  /** weighted pick: { id: weight } or [[id, weight]] */
  function wpick(r, w) {
    var entries = Array.isArray(w) ? w : Object.keys(w).map(function (k) { return [k, w[k]]; });
    entries = entries.filter(function (e) { return e[1] > 0; });
    var total = entries.reduce(function (s, e) { return s + e[1]; }, 0);
    var x = r() * total;
    for (var i = 0; i < entries.length; i++) { x -= entries[i][1]; if (x <= 0) return entries[i][0]; }
    return entries.length ? entries[entries.length - 1][0] : undefined;
  }
  function rrange(r, a, b) { return a + (b - a) * r(); }
  function rint(r, a, b) { return Math.floor(rrange(r, a, b + 1 - 1e-9)); }
  function snapTo(v, step, base) { base = base || 0; return Math.round((v - base) / step) * step + base; }
  function chance(r, p) { return r() < p; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var INTERIOR_PALETTES = [
    { primary: '#1a1a1a', accent: '#b3121f', stitch: '#b3121f', ambient: '#ff3344', tag: 'sport' },
    { primary: '#141414', accent: '#f2c200', stitch: '#f2c200', ambient: '#ffcc33', tag: 'sport' },
    { primary: '#101418', accent: '#2f7dd1', stitch: '#5aa9ff', ambient: '#3fa0ff', tag: 'sport' },
    { primary: '#b0814f', accent: '#3b2a1e', stitch: '#f2e8d5', ambient: '#ffb366', tag: 'lux' },
    { primary: '#e8e1d4', accent: '#5a4632', stitch: '#5a4632', ambient: '#fff1d6', tag: 'lux' },
    { primary: '#6b1d22', accent: '#1a1a1a', stitch: '#e9d8c4', ambient: '#ff6f61', tag: 'lux' },
    { primary: '#2a3b2f', accent: '#c9b37e', stitch: '#c9b37e', ambient: '#c7ffb0', tag: 'lux' },
    { primary: '#1d2433', accent: '#c0c6d0', stitch: '#e6e9ee', ambient: '#a8c8ff', tag: 'lux' },
    { primary: '#3a3a3a', accent: '#ff6a00', stitch: '#ff6a00', ambient: '#ff8a3d', tag: 'track' },
    { primary: '#0e0e0e', accent: '#e10600', stitch: '#ffffff', ambient: '#ff2020', tag: 'track' },
    { primary: '#5b5f63', accent: '#1a1a1a', stitch: '#9ad14b', ambient: '#9aff6b', tag: 'eco' },
    { primary: '#d9d6cf', accent: '#3e6b5a', stitch: '#3e6b5a', ambient: '#9fffe0', tag: 'eco' }
  ];
  var CALIPERS = ['#f2c200', '#c8102e', '#111111', '#2f7dd1', '#c0c0c0', '#ff6a00', '#9ad14b', '#c9b37e', '#7a2bd1'];
  var RIM_FINISHES = ['#2b2b2b', '#111111', '#c0c4c8', '#8a8d91', '#3a3a3a', '#b8a06a', '#d9d9d9', '#4a3b2a', '#1d2a3a'];

  var NAME_PARTS = {
    gt: { a: ['Aurelia', 'Vespera', 'Solenne', 'Meridian', 'Castellan', 'Lucerne', 'Dorado', 'Corviglia'], b: ['GT', 'Gran Turismo', 'GTS', 'Tourer', 'Coupé'] },
    track: { a: ['Apex', 'Kinetic', 'Strada', 'Ignis', 'Circuit', 'Talon', 'Ventus', 'Nürburg'], b: ['R', 'RS', 'Clubsport', 'CSL', 'Trofeo', 'Cup'] },
    hyper: { a: ['Halcyon', 'Aethon', 'Zenith', 'Oblivion', 'Tempesta', 'Valkyr', 'Ultima', 'Spectre'], b: ['', 'Hyper', 'X', 'One', 'Ultra'] },
    hatch: { a: ['Rascal', 'Pocket', 'Hornet', 'Sprite', 'Viper', 'Kestrel', 'Bolt', 'Mistral'], b: ['GTi', 'R', 'Type S', 'Sport', 'Turbo'] },
    rally: { a: ['Gravel', 'Sierra', 'Tarmac', 'Safari', 'Monte', 'Kielder', 'Finnmark', 'Acropolis'], b: ['Evo', 'WRX', 'Rallye', 'Group B', 'S1'] },
    offroad: { a: ['Atlas', 'Kodiak', 'Sahara', 'Ridgeline', 'Outpost', 'Basalt', 'Canyon', 'Tundra'], b: ['Trail', 'Expedition', 'Raptor', 'Overland', 'Rubicon'] },
    muscle: { a: ['Thunder', 'Hellcat', 'Bandit', 'Outlaw', 'Ironclad', 'Mustang', 'Detroit', 'Stallion'], b: ['SS', 'Super Bee', 'Boss', 'Hemi', 'Shaker'] },
    eco: { a: ['Breeze', 'Lumen', 'Verdant', 'Ion', 'Aero', 'Pebble', 'Kinetica', 'Leaf'], b: ['e', 'Hybrid', 'Eco', 'Plug-in', 'Efficient'] },
    lux: { a: ['Sovereign', 'Regent', 'Ambassador', 'Silhouette', 'Opaline', 'Marquis', 'Celestia', 'Ivory'], b: ['e-Lounge', 'Electric', 'Limousine', 'Signature', 'Grand'] },
    sleeper: { a: ['Ghost', 'Shadow', 'Stealth', 'Phantom', 'Undercover', 'Graphite', 'Incognito', 'Nocturne'], b: ['Avant', 'Touring', 'Estate', 'RS', 'Sleeper'] },
    drift: { a: ['Sideways', 'Smoke', 'Kaido', 'Touge', 'Ebisu', 'Hachi', 'Tsuchiya', 'Kansei'], b: ['D', 'Drift', 'Spec-D', 'Missile', 'Slide'] },
    wild: { a: ['Chaos', 'Wildcard', 'Fever', 'Mirage', 'Paradox', 'Enigma', 'Jester', 'Quirk'], b: ['', 'Special', 'Prototype', 'Concept', 'One-Off'] }
  };

  /**
   * Archetype definitions. Each field is a weight table (id → weight) or [min,max] range.
   * Unspecified fields fall back to a broad, sane random choice.
   */
  var ARCHETYPES = [
    { id: 'gt', name: 'Grand Tourer', weight: 3, names: 'gt',
      style: { coupe: 4, 'shooting-brake': 2, sedan: 1 }, chassis: { aluminum: 3, 'carbon-tub': 1, 'high-strength-steel': 1 },
      type: { ice: 7, hybrid: 3 }, layout: { V8: 3, V12: 3, I6: 2, V6: 1 }, aspiration: { na: 2, 'twin-turbo': 4, turbo: 1 }, disp: [0.15, 0.65], boost: [0.7, 1.0],
      position: { front: 9, mid: 1 }, tune: { stock: 5, stage1: 2 }, exhaust: { valvetronic: 3, sport: 2, titanium: 1 },
      trans: { dct: 3, auto: 3 }, drive: { rwd: 3, awd: 2 }, susp: { magnetic: 3, air: 2, multilink: 1, 'double-wishbone': 2 },
      stiff: [0.35, 0.55], ride: [100, 130], tires: { 'super-sport': 3, performance: 3, touring: 1 }, wheelDia: [19, 22],
      brakes: { 'carbon-ceramic': 2, 'two-piece': 2, 'drilled-slotted': 1 }, aero: 'subtle', colors: { green: 3, blue: 3, grey: 2, silver: 2, red: 2, gold: 1 },
      interior: 'lux', seat: { comfort: 3, sport: 3, lounge: 1 }, upholstery: { 'semi-aniline': 3, nappa: 3, leather: 2 },
      trim: { 'open-pore-wood': 3, 'gloss-walnut': 2, 'brushed-titanium': 2, carbon: 1 }, audio: { reference: 3, concert: 2, premium: 2 }, adas: { plus: 3, pilot: 2, assist: 1 } },
    { id: 'track', name: 'Track Weapon', weight: 3, names: 'track',
      style: { coupe: 4, roadster: 2, hypercar: 1, hatchback: 1 }, chassis: { 'carbon-tub': 3, aluminum: 2, 'carbon-monocoque': 1 },
      type: { ice: 10, hybrid: 1 }, layout: { 'flat-6': 3, V8: 2, V10: 2, I4: 1, V6: 1, 'rotary-2': 1 }, aspiration: { na: 4, turbo: 2, 'twin-turbo': 2 },
      position: { mid: 5, front: 2, rear: 2 }, tune: { stage1: 2, stage2: 3, 'time-attack': 1 }, exhaust: { titanium: 3, 'straight-pipe': 2, sport: 1 },
      trans: { sequential: 3, dct: 3, manual: 1 }, drive: { rwd: 4, awd: 1 }, susp: { 'coilover-track': 4, pushrod: 2, 'double-wishbone': 2 },
      stiff: [0.7, 0.95], ride: [70, 100], tires: { track: 4, 'super-sport': 3, slick: 1 }, wheelDia: [18, 20],
      brakes: { 'carbon-ceramic': 3, 'two-piece': 2 }, aero: 'big', colors: { orange: 3, yellow: 3, white: 2, green: 2, blue: 2, grey: 1 },
      interior: 'track', seat: { 'carbon-bucket': 3, 'race-shell': 2, bucket: 2 }, upholstery: { alcantara: 4, 'carbon-weave': 2, cloth: 1 },
      trim: { carbon: 4, 'forged-carbon': 2, aluminum: 1 }, audio: { delete: 2, track: 3, standard: 1 }, adas: { none: 4, assist: 1 }, lightweight: true, number: 0.6 },
    { id: 'hyper', name: 'Hypercar', weight: 2, names: 'hyper',
      style: { hypercar: 1 }, chassis: { 'carbon-monocoque': 4, 'carbon-tub': 1 },
      type: { ice: 4, hybrid: 4, ev: 3 }, layout: { V12: 3, V8: 3, W16: 1, V10: 1, V6: 1 }, aspiration: { 'twin-turbo': 3, 'quad-turbo': 2, na: 2, 'electric-turbo': 1 },
      position: { mid: 1 }, tune: { stock: 3, stage1: 2, stage2: 1 }, exhaust: { titanium: 3, valvetronic: 2 },
      trans: { dct: 4, sequential: 1 }, drive: { rwd: 2, awd: 3 }, susp: { pushrod: 4, magnetic: 1, 'coilover-track': 1 },
      stiff: [0.6, 0.85], ride: [70, 95], tires: { 'super-sport': 4, track: 1 }, wheelDia: [20, 22], motors: [2, 4], kw: [250, 450], battery: [70, 120],
      brakes: { 'carbon-ceramic': 1 }, aero: 'active', colors: { black: 2, grey: 2, blue: 2, orange: 2, red: 2, silver: 1, purple: 1 },
      interior: 'sport', seat: { 'carbon-bucket': 3, bucket: 2 }, upholstery: { alcantara: 3, 'carbon-weave': 2, nappa: 1 }, trim: { 'forged-carbon': 3, carbon: 2, 'brushed-titanium': 1 },
      audio: { premium: 2, reference: 1, track: 1 }, adas: { assist: 2, none: 1 } },
    { id: 'hatch', name: 'Hot Hatch', weight: 3, names: 'hatch',
      style: { hatchback: 1 }, chassis: { steel: 2, 'high-strength-steel': 3, aluminum: 1 },
      type: { ice: 9, hybrid: 1 }, layout: { I4: 6, I3: 2, I5: 2 }, aspiration: { turbo: 6, 'electric-turbo': 1, supercharged: 1 },
      position: { front: 1 }, tune: { stock: 3, stage1: 3, stage2: 1 }, exhaust: { sport: 3, valvetronic: 1, titanium: 1 },
      trans: { manual: 3, dct: 3 }, drive: { fwd: 3, awd: 2 }, susp: { macpherson: 3, multilink: 2, 'coilover-track': 1 },
      stiff: [0.5, 0.75], ride: [100, 125], tires: { performance: 4, 'super-sport': 2, 'all-season': 1 }, wheelDia: [18, 19],
      brakes: { 'drilled-slotted': 3, 'two-piece': 1, iron: 1 }, aero: 'mild', colors: { red: 3, blue: 3, white: 2, yellow: 1, grey: 1, green: 1 },
      interior: 'sport', seat: { bucket: 3, sport: 3 }, upholstery: { tartan: 2, alcantara: 2, cloth: 2, leather: 1 }, trim: { 'piano-black': 2, aluminum: 2, carbon: 1 },
      audio: { standard: 2, premium: 2 }, adas: { assist: 3, plus: 1 } },
    { id: 'rally', name: 'Rally Legend', weight: 2, names: 'rally',
      style: { hatchback: 4, sedan: 1, coupe: 1 }, chassis: { 'high-strength-steel': 3, steel: 1, aluminum: 1 },
      type: { ice: 1 }, layout: { I4: 5, I5: 2, 'flat-4': 3 }, aspiration: { turbo: 5, 'twin-turbo': 1, 'electric-turbo': 1 },
      position: { front: 1 }, fuel: { premium: 2, e85: 2, race: 1 }, tune: { stage1: 2, stage2: 3, stage3: 1 }, exhaust: { sport: 2, 'straight-pipe': 2, titanium: 1 },
      trans: { sequential: 4, manual: 2 }, drive: { awd: 1 }, susp: { 'coilover-track': 2, 'double-wishbone': 2, multilink: 1 },
      stiff: [0.45, 0.7], ride: [135, 175], tires: { performance: 2, 'all-season': 2, track: 1 }, wheelDia: [17, 18],
      brakes: { 'two-piece': 2, 'drilled-slotted': 2 }, aero: 'rally', colors: { white: 3, blue: 3, red: 2, yellow: 1, green: 1 },
      interior: 'track', seat: { 'race-shell': 2, bucket: 3 }, upholstery: { cloth: 2, alcantara: 2 }, trim: { carbon: 2, aluminum: 2 },
      audio: { delete: 2, track: 2, standard: 1 }, adas: { none: 3, assist: 1 }, lightweight: true, number: 0.85, stripe: 0.7 },
    { id: 'offroad', name: 'Overlander', weight: 2, names: 'offroad',
      style: { suv: 3, pickup: 3 }, chassis: { steel: 3, 'high-strength-steel': 2, aluminum: 1 },
      type: { ice: 6, hybrid: 1, ev: 2 }, layout: { I6: 3, V8: 3, V6: 2, I4: 1 }, aspiration: { turbo: 3, 'twin-turbo': 2, supercharged: 1, na: 1 },
      position: { front: 1 }, fuel: { diesel: 4, premium: 2, regular: 1 }, tune: { stock: 4, stage1: 1, eco: 1 }, exhaust: { stock: 2, sport: 2 },
      trans: { auto: 5, manual: 1 }, drive: { awd: 1 }, diff: { locking: 4, 'lsd-torsen': 2 }, susp: { air: 3, 'double-wishbone': 3, multilink: 1 },
      stiff: [0.25, 0.45], ride: [215, 260], tires: { 'all-season': 4, winter: 1, touring: 1 }, wheelDia: [17, 20], motors: [2, 3], kw: [150, 260], battery: [100, 160],
      wheelDesign: { beadlock: 3, 'deep-dish': 2, 'classic-5': 2, 'monoblock-6': 2 },
      brakes: { iron: 3, 'drilled-slotted': 1 }, aero: 'none', colors: { green: 3, gold: 2, grey: 2, white: 2, black: 1, orange: 1, blue: 1 },
      interior: 'lux', seat: { comfort: 4, sport: 1 }, upholstery: { leather: 3, vegan: 2, cloth: 1 }, trim: { 'open-pore-wood': 2, aluminum: 2, 'piano-black': 1 },
      audio: { premium: 3, standard: 1 }, adas: { assist: 2, plus: 2 } },
    { id: 'muscle', name: 'Muscle Car', weight: 2, names: 'muscle',
      style: { coupe: 4, sedan: 1 }, chassis: { steel: 4, 'high-strength-steel': 2 },
      type: { ice: 1 }, layout: { V8: 1 }, aspiration: { supercharged: 4, na: 3, 'twin-turbo': 1 }, disp: [0.5, 0.85], boost: [0.7, 0.95],
      position: { front: 1 }, tune: { stock: 3, stage1: 2, stage2: 1 }, exhaust: { 'straight-pipe': 2, sport: 3, valvetronic: 1 },
      trans: { manual: 4, auto: 3 }, drive: { rwd: 1 }, diff: { 'lsd-clutch': 3, 'lsd-torsen': 2, locking: 1 }, susp: { multilink: 2, 'double-wishbone': 2, magnetic: 1 },
      stiff: [0.4, 0.6], ride: [110, 135], tires: { performance: 3, 'super-sport': 2 }, wheelDia: [19, 21], wheelDesign: { 'classic-5': 3, 'deep-dish': 2, 'y-spoke': 2, 'monoblock-5': 1 },
      brakes: { 'two-piece': 2, 'drilled-slotted': 2 }, aero: 'muscle', colors: { orange: 3, blue: 2, red: 2, black: 2, green: 1, purple: 2, yellow: 1 },
      interior: 'sport', seat: { sport: 3, bucket: 1 }, upholstery: { leather: 3, alcantara: 1 }, trim: { aluminum: 3, 'piano-black': 1 },
      audio: { premium: 2, standard: 2 }, adas: { assist: 2, none: 1 }, stripe: 0.75 },
    { id: 'eco', name: 'Eco Commuter', weight: 2, names: 'eco',
      style: { sedan: 3, hatchback: 3, wagon: 1 }, chassis: { 'high-strength-steel': 3, aluminum: 2, steel: 1 },
      type: { hybrid: 4, ev: 4, ice: 1 }, layout: { I3: 3, I4: 4 }, aspiration: { na: 3, turbo: 2 }, disp: [0, 0.45],
      position: { front: 1 }, fuel: { regular: 4, premium: 1 }, tune: { eco: 4, stock: 2 }, exhaust: { stock: 1 },
      trans: { cvt: 3, auto: 2, dct: 1 }, drive: { fwd: 4, awd: 1 }, susp: { macpherson: 3, multilink: 2 }, motors: [1, 1], kw: [80, 160], battery: [45, 80],
      stiff: [0.25, 0.4], ride: [125, 150], tires: { eco: 4, touring: 2, 'all-season': 2 }, wheelDia: [16, 18], wheelDesign: { 'aero-disc': 4, 'aero-blade': 3, turbine: 2 },
      brakes: { iron: 1 }, aero: 'eco', colors: { white: 3, silver: 2, blue: 2, grey: 2, green: 1 },
      interior: 'eco', seat: { comfort: 3, sport: 1 }, upholstery: { vegan: 4, cloth: 3 }, trim: { 'piano-black': 2, aluminum: 2 },
      audio: { standard: 3, premium: 1 }, adas: { plus: 3, pilot: 2, assist: 2 } },
    { id: 'lux', name: 'Electric Limousine', weight: 2, names: 'lux',
      style: { sedan: 3, suv: 2, 'shooting-brake': 1, van: 1 }, chassis: { aluminum: 3, 'carbon-tub': 1 },
      type: { ev: 1 }, motors: [2, 2], kw: [170, 300], battery: [100, 150],
      tune: { stock: 1 }, drive: { awd: 1 }, susp: { air: 4, magnetic: 2 }, stiff: [0.2, 0.35], ride: [115, 150],
      tires: { touring: 3, performance: 2, 'all-season': 1 }, wheelDia: [21, 23], wheelDesign: { turbine: 2, 'aero-blade': 2, 'multi-spoke': 2, 'split-10': 2 },
      brakes: { 'two-piece': 2, 'carbon-ceramic': 1 }, aero: 'subtle', colors: { black: 2, silver: 2, blue: 2, white: 2, grey: 2, gold: 1 },
      interior: 'lux', seat: { lounge: 4, comfort: 2 }, upholstery: { 'semi-aniline': 3, nappa: 3, vegan: 1 }, trim: { 'open-pore-wood': 3, 'gloss-walnut': 2, 'brushed-titanium': 1 },
      audio: { concert: 4, reference: 2 }, adas: { pilot: 3, 'autonomous-l3': 3 } },
    { id: 'sleeper', name: 'Sleeper', weight: 2, names: 'sleeper',
      style: { wagon: 3, sedan: 2 }, chassis: { aluminum: 2, 'high-strength-steel': 2 },
      type: { ice: 5, hybrid: 1 }, layout: { V8: 4, V10: 1, I6: 2 }, aspiration: { 'twin-turbo': 5, supercharged: 1 }, disp: [0.2, 0.6], boost: [0.7, 1.0],
      position: { front: 1 }, tune: { stage1: 3, stage2: 2, stock: 1 }, exhaust: { valvetronic: 3, sport: 1, stock: 1 },
      trans: { auto: 3, dct: 2 }, drive: { awd: 4, rwd: 1 }, susp: { air: 2, magnetic: 2, multilink: 1 },
      stiff: [0.4, 0.6], ride: [110, 130], tires: { 'super-sport': 3, performance: 2 }, wheelDia: [20, 21],
      brakes: { 'carbon-ceramic': 3, 'two-piece': 1 }, aero: 'none', colors: { grey: 4, black: 3, silver: 3, blue: 1 },
      interior: 'lux', seat: { sport: 3, comfort: 1 }, upholstery: { nappa: 2, leather: 2, alcantara: 1 }, trim: { carbon: 2, 'brushed-titanium': 2, 'piano-black': 1 },
      audio: { reference: 2, premium: 2 }, adas: { plus: 2, assist: 1 }, stealth: true },
    { id: 'drift', name: 'Drift Missile', weight: 2, names: 'drift',
      style: { coupe: 4, sedan: 1 }, chassis: { steel: 3, 'high-strength-steel': 2 },
      type: { ice: 1 }, layout: { I6: 3, V8: 2, 'rotary-2': 2, I4: 1 }, aspiration: { turbo: 4, 'twin-turbo': 2, na: 1 },
      position: { front: 1 }, tune: { stage2: 3, stage1: 2, stage3: 1 }, exhaust: { 'straight-pipe': 3, titanium: 1 },
      trans: { manual: 3, sequential: 2 }, drive: { rwd: 1 }, diff: { locking: 2, 'lsd-clutch': 4 }, tc: [0, 0], susp: { 'coilover-track': 4, 'double-wishbone': 1 },
      stiff: [0.6, 0.85], ride: [85, 110], tires: { performance: 3, 'super-sport': 1, touring: 1 }, wheelDia: [18, 19], wheelDesign: { 'deep-dish': 3, 'mesh-bbs': 2, 'monoblock-6': 2 },
      brakes: { 'drilled-slotted': 2, 'two-piece': 2 }, aero: 'drift', colors: { purple: 2, green: 2, blue: 2, orange: 2, white: 1, yellow: 1 },
      finish: { candy: 2, chameleon: 2, pearl: 1, metallic: 1, matte: 1 },
      interior: 'track', seat: { bucket: 3, 'race-shell': 1 }, upholstery: { alcantara: 2, cloth: 2 }, trim: { carbon: 2, aluminum: 1 },
      audio: { track: 2, standard: 1, delete: 1 }, adas: { none: 3 }, number: 0.5, lightweight: true },
    { id: 'wild', name: 'Wildcard', weight: 1.5, names: 'wild', wild: true }
  ];
  function archetype(id) { for (var i = 0; i < ARCHETYPES.length; i++) if (ARCHETYPES[i].id === id) return ARCHETYPES[i]; return null; }

  function ids(coll) { return ((D() && D().list(coll)) || []).map(function (o) { return o.id; }); }
  function uniformW(coll) { var w = {}; ids(coll).forEach(function (id) { w[id] = 1; }); return w; }
  function pickFrom(r, weights, coll, allowed) {
    var w = weights ? U.deepClone(weights) : uniformW(coll);
    var valid = ids(coll);
    Object.keys(w).forEach(function (k) { if (valid.indexOf(k) < 0 && valid.indexOf(Number(k)) < 0) delete w[k]; if (allowed && allowed.indexOf(k) < 0) delete w[k]; });
    var v = wpick(r, w);
    if (v === undefined) v = allowed && allowed.length ? rpick(r, allowed) : rpick(r, valid);
    return v;
  }
  function paintFrom(r, families) {
    var sw = (D() && D().paintSwatches) || [];
    if (chance(r, 0.12) && U.hslToHex) return U.hslToHex(rint(r, 0, 359), rrange(r, 0.45, 0.9), rrange(r, 0.25, 0.55));
    var fam = families ? wpick(r, families) : null;
    var pool = fam ? sw.filter(function (s) { return s.family === fam; }) : sw;
    if (!pool.length) pool = sw;
    return pool.length ? rpick(r, pool).hex : '#b3121f';
  }
  /** profile so the overall tyre diameter lands in a plausible band for the car type */
  function profileFor(diaIn, width, targetOD) {
    var p = (targetOD - diaIn * 25.4) / (2 * width) * 100;
    return clamp(snapTo(p, 5), 25, 70);
  }
  function tyreWidthFor(rimIn, bias) {
    var w = rimIn * 25.4 + 18 + bias;
    return clamp(snapTo(w, 10, 5), 175, 355);
  }

  /** One raw random build for an archetype (merged on defaultBuild, NOT normalized). */
  function randomBuild(r, archId) {
    r = r || Math.random;
    var data = D();
    var A = (archId && archetype(archId)) || archetype(wpick(r, ARCHETYPES.map(function (a) { return [a.id, a.weight]; })));
    var wild = !!A.wild;
    var b = data.defaultBuild();
    var styleId = pickFrom(r, wild ? null : A.style, 'bodyStyles');
    var style = data.find('bodyStyles', styleId);
    b.body.style = styleId;
    b.body.chassisMaterial = pickFrom(r, wild ? null : A.chassis, 'chassisMaterials');
    var wbR = style.wheelbaseRange;
    b.body.wheelbase_mm = snapTo(rrange(r, wbR[0] + (wbR[1] - wbR[0]) * 0.15, wbR[1] - (wbR[1] - wbR[0]) * 0.15), 5);
    b.body.trackWidth_mm = snapTo(rrange(r, styleId === 'hypercar' || styleId === 'suv' || styleId === 'pickup' ? 1620 : 1520, styleId === 'hatchback' ? 1600 : 1700), 5);
    b.body.doors = rpick(r, style.doorOptions);
    b.body.seats = rpick(r, style.seatOptions);

    // ---- powertrain
    var e = b.engine;
    e.type = pickFrom(r, wild ? { ice: 5, hybrid: 2, ev: 3 } : A.type || { ice: 1 }, 'engineTypes');
    var posAllowed = style.allowedEnginePositions;
    e.position = pickFrom(r, wild ? null : A.position, 'enginePositions', posAllowed);
    if (e.type !== 'ev') {
      e.layout = pickFrom(r, wild ? null : A.layout, 'engineLayouts');
      var lay = data.find('engineLayouts', e.layout);
      var dr = lay.displacementRange, disp = A.disp || [0.15, 0.75];
      e.displacement_l = U.round(rrange(r, dr[0] + (dr[1] - dr[0]) * disp[0], dr[0] + (dr[1] - dr[0]) * disp[1]), 1);
      e.fuel = pickFrom(r, wild ? { regular: 1, premium: 3, e85: 1, race: 1, diesel: 1 } : A.fuel || { premium: 4, regular: 1 }, 'fuels');
      var aspW = wild ? null : A.aspiration;
      if (e.fuel === 'diesel') aspW = { turbo: 3, 'twin-turbo': 2 };
      if (e.layout === 'rotary-2' && aspW) { aspW = U.deepClone(aspW); delete aspW['quad-turbo']; }
      e.aspiration = pickFrom(r, aspW, 'aspirations');
      var asp = data.find('aspirations', e.aspiration);
      var bm = A.boost || [0.8, 1.15];
      e.boost_bar = asp.id === 'na' ? 0 : U.round(clamp(asp.typicalBoost_bar * rrange(r, bm[0], bm[1]), 0.2, asp.maxBoost_bar), 2);
      if (asp.id === 'na') e.compression = U.round(rrange(r, e.fuel === 'race' || e.fuel === 'e85' ? 12.0 : 11.0, e.fuel === 'regular' ? 11.5 : 13.5), 1);
      else e.compression = U.round(rrange(r, 8.8, e.fuel === 'e85' || e.fuel === 'race' ? 10.8 : 10.0), 1);
      if (e.fuel === 'diesel') { e.compression = U.round(rrange(r, 13.0, 14.0), 1); e.redline_rpm = snapTo(rrange(r, 4500, 5200), 100); }
      else e.redline_rpm = clamp(snapTo(num(lay.typicalRedline, 7000) + rrange(r, -600, 500), 100), 5000, 9500);
      e.tune = pickFrom(r, wild ? null : A.tune, 'tunes');
      e.exhaust = pickFrom(r, wild ? null : A.exhaust, 'exhausts');
      e.cooling = e.tune === 'stage3' || e.tune === 'time-attack' || A.id === 'track' || A.id === 'hyper' ? (chance(r, 0.6) ? 'race' : 'uprated') : e.tune === 'stage2' ? 'uprated' : pickFrom(r, { standard: 3, uprated: 1 }, 'coolings');
    } else {
      e.tune = pickFrom(r, wild ? { eco: 1, stock: 3, stage1: 1 } : A.tune || { stock: 1 }, 'tunes');
      e.exhaust = 'stock';
    }
    if (e.type === 'ev') {
      var mr = A.motors || [1, 4];
      e.motors = rint(r, mr[0], mr[1]);
      var kr = A.kw || [120, 400];
      e.motorPower_kw = snapTo(rrange(r, kr[0], kr[1]), 5);
      var br = A.battery || [50, 130];
      e.battery_kwh = Math.round(rrange(r, br[0], br[1]));
      e.chemistry = pickFrom(r, A.id === 'hyper' ? { nca: 2, 'solid-state': 2 } : A.id === 'eco' ? { lfp: 3, nmc: 1 } : null, 'batteryChemistries');
      e.voltage = chance(r, A.id === 'eco' ? 0.3 : 0.75) ? 800 : 400;
      e.regen = rint(r, 1, 3);
    } else if (e.type === 'hybrid') {
      e.motors = chance(r, 0.35) ? 2 : 1;
      e.motorPower_kw = snapTo(rrange(r, 60, A.id === 'hyper' ? 250 : 160), 5);
      e.battery_kwh = U.round(rrange(r, A.id === 'eco' ? 8 : 2, A.id === 'eco' ? 22 : 10), 1);
      e.chemistry = pickFrom(r, { nmc: 3, lfp: 1, nca: 1 }, 'batteryChemistries');
      e.voltage = chance(r, 0.5) ? 800 : 400;
      e.regen = rint(r, 1, 3);
    }

    // ---- transmission
    var t = b.transmission;
    if (e.type === 'ev') t.type = 'single-speed';
    else {
      t.type = pickFrom(r, wild ? { manual: 2, dct: 3, auto: 2, cvt: 1, sequential: 1 } : A.trans, 'transmissions');
      if (t.type === 'single-speed') t.type = 'dct';
      if (t.type === 'cvt' && num(e.displacement_l) > 3.0) t.type = 'auto';
    }
    var tr = data.find('transmissions', t.type);
    var ref = tr.defaultRatios().length;
    t.gears = clamp(ref + rint(r, -1, 1), tr.gearRange[0], tr.gearRange[1]);
    t.ratios = tr.defaultRatios(t.gears).slice();
    t.finalDrive = U.round(rrange(r, A.id === 'eco' || A.id === 'gt' || A.id === 'lux' ? 2.7 : 3.1, A.id === 'track' || A.id === 'rally' || A.id === 'hatch' ? 4.4 : 3.9), 2);
    if (e.type === 'ev') t.finalDrive = U.round(rrange(r, 2.8, 3.8), 2);
    t.launchControl = t.type !== 'manual' || chance(r, 0.3);

    // ---- drivetrain
    var d = b.drivetrain;
    d.layout = pickFrom(r, wild ? null : A.drive, 'drivetrainLayouts');
    if (e.type === 'ev' && e.motors >= 2) d.layout = 'awd';
    if (e.position === 'mid' || e.position === 'rear') { if (d.layout === 'fwd') d.layout = chance(r, 0.5) ? 'rwd' : 'awd'; }
    var diffW = A.diff || { 'lsd-clutch': 3, 'lsd-torsen': 2, 'e-diff': 2, 'lsd-viscous': 1, open: 1 };
    var diffs = ['open', 'lsd-viscous', 'lsd-clutch', 'lsd-torsen', 'e-diff', 'locking'];
    if (d.layout === 'fwd') { d.frontDiff = pickFrom(r, A.id === 'eco' ? { open: 1 } : diffW, 'differentials', diffs); d.rearDiff = 'none'; d.centerDiff = 'none'; d.torqueSplitFront_pct = 100; }
    else if (d.layout === 'rwd') { d.rearDiff = pickFrom(r, diffW, 'differentials', diffs); d.frontDiff = 'open'; d.centerDiff = 'none'; d.torqueSplitFront_pct = 0; }
    else {
      d.frontDiff = pickFrom(r, A.diff || { open: 2, 'lsd-torsen': 1, 'lsd-clutch': 1 }, 'differentials', diffs);
      d.rearDiff = pickFrom(r, diffW, 'differentials', diffs);
      d.centerDiff = pickFrom(r, A.id === 'offroad' ? { locking: 2, 'lsd-torsen': 1 } : { 'lsd-viscous': 2, 'lsd-torsen': 2, 'e-diff': 2, 'lsd-clutch': 1 }, 'differentials', diffs);
      d.torqueSplitFront_pct = snapTo(rrange(r, A.id === 'rally' ? 40 : 25, A.id === 'offroad' ? 50 : 45), 1);
    }
    d.torqueVectoring = (A.id === 'gt' || A.id === 'hyper' || A.id === 'lux') ? chance(r, 0.7) : chance(r, 0.2);
    d.tractionControl = A.tc ? rint(r, A.tc[0], A.tc[1]) : (A.id === 'track' ? rint(r, 0, 2) : rint(r, 1, 3));

    // ---- suspension
    var su = b.suspension;
    su.type = pickFrom(r, wild ? null : A.susp, 'suspensionTypes');
    var st = data.find('suspensionTypes', su.type);
    var stiff = A.stiff ? rrange(r, A.stiff[0], A.stiff[1]) : rrange(r, 0.25, 0.85);
    var springBase = 20 + stiff * 150;
    var frontBias = e.position === 'front' ? 1.05 : 0.88;
    su.springFront_nmm = Math.round(clamp(springBase * frontBias * rrange(r, 0.9, 1.1), 20, 250));
    su.springRear_nmm = Math.round(clamp(springBase * (2 - frontBias) * rrange(r, 0.9, 1.1), 20, 250));
    su.damping = clamp(Math.round(2 + stiff * 7 + rrange(r, -1, 1)), 1, 10);
    var rr = A.ride || [st.rideHeightRange[0] + 20, st.rideHeightRange[0] + 70];
    su.rideHeight_mm = Math.round(clamp(rrange(r, rr[0], rr[1]), st.rideHeightRange[0], st.rideHeightRange[1]));
    su.camberFront_deg = U.round(-(0.4 + stiff * 2.6) + rrange(r, -0.3, 0.3), 1);
    su.camberRear_deg = U.round(su.camberFront_deg * rrange(r, 0.55, 0.8), 1);
    su.toeFront_deg = U.round(snapTo(rrange(r, -0.1, 0.05), 0.05), 2);
    su.toeRear_deg = U.round(snapTo(rrange(r, 0.05, 0.2), 0.05), 2);
    su.arbFront = clamp(Math.round(3 + stiff * 6 + rrange(r, -1, 1)), 1, 10);
    su.arbRear = clamp(Math.round(su.arbFront + (d.layout === 'fwd' ? 1 : -1) * rint(r, 0, 2)), 1, 10);

    // ---- wheels & tyres
    var wh = b.wheels, ti = b.tires;
    var wd = A.wheelDia || [17, 22];
    wh.diameter_in = rint(r, wd[0], wd[1]);
    wh.design = pickFrom(r, A.wheelDesign || null, 'wheelDesigns');
    if (A.id === 'track' || A.id === 'hyper') wh.design = pickFrom(r, { 'centerlock-race': 3, 'monoblock-5': 2, 'mesh-bbs': 2, 'split-10': 1 }, 'wheelDesigns');
    wh.material = pickFrom(r, A.id === 'track' || A.id === 'hyper' ? { forged: 3, magnesium: 2, carbon: 1 } : A.id === 'eco' ? { cast: 3, 'flow-formed': 1 } : A.id === 'offroad' ? { cast: 2, forged: 1, steel: 1 } : { cast: 2, 'flow-formed': 2, forged: 2 }, 'wheelMaterials');
    wh.finish = rpick(r, RIM_FINISHES);
    var wide = A.id === 'eco' ? 0.15 : A.id === 'track' || A.id === 'hyper' || A.id === 'muscle' || A.id === 'drift' ? 0.75 : 0.45;
    var rimF = clamp(snapTo(6.5 + wide * 4 + rrange(r, -0.5, 0.5) + (wh.diameter_in - 18) * 0.25, 0.5), 6, 12.5);
    wh.staggered = d.layout !== 'fwd' && (A.id !== 'eco' && A.id !== 'offroad') && chance(r, 0.65);
    var rimR = wh.staggered ? clamp(rimF + snapTo(rrange(r, 0.5, 2), 0.5), 6, 13) : rimF;
    wh.widthFront_in = rimF; wh.widthRear_in = rimR;
    ti.compound = pickFrom(r, wild ? null : A.tires, 'tireCompounds');
    ti.widthFront_mm = tyreWidthFor(rimF, rrange(r, -5, 15));
    ti.widthRear_mm = tyreWidthFor(rimR, rrange(r, -5, 15));
    var od = A.id === 'offroad' ? rrange(r, 780, 830) : A.id === 'lux' ? rrange(r, 720, 760) : A.id === 'eco' || A.id === 'hatch' ? rrange(r, 630, 670) : rrange(r, 660, 710);
    ti.profileFront = profileFor(wh.diameter_in, ti.widthFront_mm, od);
    ti.profileRear = profileFor(wh.diameter_in, ti.widthRear_mm, od);

    // ---- brakes (must fit in the wheel: rotor + 60 <= wheel mm)
    var bk = b.brakes;
    bk.material = pickFrom(r, wild ? null : A.brakes, 'brakeMaterials');
    if (bk.material === 'carbon-ceramic' && wh.diameter_in < 19) wh.diameter_in = 19;
    var maxRotor = Math.min(440, wh.diameter_in * 25.4 - 64);
    bk.frontRotor_mm = clamp(snapTo(rrange(r, Math.min(maxRotor, 300 + stiff * 60), maxRotor), 2), 280, 440);
    bk.rearRotor_mm = clamp(snapTo(bk.frontRotor_mm - rrange(r, 10, 40), 2), 280, 440);
    var pistons = data.pistonOptions || [1, 2, 4, 6, 8, 10];
    bk.frontPistons = rpick(r, pistons.filter(function (p) { return bk.material === 'carbon-ceramic' || A.id === 'track' || A.id === 'hyper' ? p >= 6 : A.id === 'eco' ? p <= 2 : p >= 2 && p <= 6; })) || 4;
    bk.rearPistons = rpick(r, pistons.filter(function (p) { return p <= bk.frontPistons && p >= Math.max(1, bk.frontPistons / 2 - 1); })) || 2;
    bk.abs = A.id === 'track' ? pickFrom(r, { race: 3, sport: 1 }, 'absModes') : A.id === 'drift' ? 'sport' : pickFrom(r, { standard: 2, sport: 2 }, 'absModes');

    // ---- aero
    var ae = b.aero, aeroKind = wild ? rpick(r, ['none', 'subtle', 'mild', 'big', 'active', 'muscle', 'drift']) : A.aero || 'subtle';
    var AERO = {
      none: { splitter: { none: 3, lip: 1 }, wing: { none: 1 }, diffuser: { none: 2, mild: 1 } },
      subtle: { splitter: { lip: 3, none: 1 }, wing: { none: 3, 'lip-spoiler': 2, ducktail: 1 }, diffuser: { mild: 3, carbon: 1 } },
      mild: { splitter: { lip: 2, carbon: 1 }, wing: { 'lip-spoiler': 2, ducktail: 1, none: 1 }, diffuser: { mild: 2, carbon: 1 } },
      big: { splitter: { race: 3, carbon: 2 }, wing: { 'gt-wing': 4, 'swan-neck': 3, biplane: 1 }, diffuser: { race: 3, carbon: 2 } },
      active: { splitter: { carbon: 2, race: 1 }, wing: { active: 4, 'swan-neck': 1 }, diffuser: { race: 2, carbon: 2 } },
      rally: { splitter: { lip: 2, carbon: 1 }, wing: { 'gt-wing': 2, ducktail: 2, 'lip-spoiler': 1 }, diffuser: { mild: 2, carbon: 1 } },
      muscle: { splitter: { lip: 2, none: 1 }, wing: { ducktail: 3, 'lip-spoiler': 2, none: 2 }, diffuser: { none: 1, mild: 2 } },
      drift: { splitter: { carbon: 2, lip: 1 }, wing: { 'swan-neck': 2, 'gt-wing': 2, ducktail: 1 }, diffuser: { carbon: 2, mild: 1 } },
      eco: { splitter: { none: 2, lip: 1 }, wing: { none: 2, 'lip-spoiler': 2 }, diffuser: { mild: 2, none: 1 } }
    };
    var ak = AERO[aeroKind] || AERO.subtle;
    ae.splitter = pickFrom(r, ak.splitter, 'aero.splitters');
    ae.wing = pickFrom(r, ak.wing, 'aero.wings');
    ae.diffuser = pickFrom(r, ak.diffuser, 'aero.diffusers');
    ae.wingAngle_deg = ae.wing === 'none' ? 6 : rint(r, aeroKind === 'big' ? 8 : 3, aeroKind === 'big' ? 16 : 10);
    ae.canards = aeroKind === 'big' || aeroKind === 'drift' ? chance(r, 0.6) : chance(r, 0.05);
    ae.sideSkirts = aeroKind !== 'none' && aeroKind !== 'eco' ? chance(r, 0.7) : chance(r, 0.2);
    ae.activeAero = aeroKind === 'active' || ae.wing === 'active' || (A.id === 'eco' && chance(r, 0.3));

    // ---- weight programme
    var w = b.weight;
    var light = !!A.lightweight;
    w.soundDeadening = light ? chance(r, 0.25) : true;
    w.spareTire = A.id === 'offroad' ? true : chance(r, 0.1);
    w.glass = light ? pickFrom(r, { thin: 2, polycarbonate: 2, standard: 1 }, 'glassTypes') : 'standard';
    w.battery = light || A.id === 'hyper' ? 'lithium' : pickFrom(r, { lead: 3, lithium: 1 }, 'batteryTypes');
    w.rollCage = light ? pickFrom(r, A.id === 'rally' ? { full: 3, half: 1 } : { none: 1, half: 2, full: 1 }, 'rollCages') : 'none';
    if (w.rollCage !== 'none') { b.body.seats = style.seatOptions.filter(function (s) { return s <= 2; }).pop() || b.body.seats; }
    w.ballast_kg = 0; w.ballastPosition = 'center';

    // ---- exterior
    var x = b.exterior;
    x.paint = paintFrom(r, wild ? null : A.colors);
    x.finish = pickFrom(r, A.finish || (A.stealth ? { matte: 2, satin: 2, metallic: 2 } : wild ? null : { metallic: 5, pearl: 2, solid: 2, satin: 1, matte: 1, candy: 0.5 }), 'paintFinishes');
    x.roof = pickFrom(r, style.svg && style.svg.openTop ? { body: 1 } : A.id === 'track' || A.id === 'hyper' ? { carbon: 3, body: 1, black: 1 } : A.id === 'lux' ? { glass: 3, body: 1 } : { body: 4, black: 1, glass: 1, contrast: 0.5 }, 'roofTypes');
    x.roofColor = x.roof === 'contrast' ? rpick(r, ['#111111', '#f4f1ea', '#c0c4c8']) : '#111111';
    var stripeP = A.stripe != null ? A.stripe : 0.15;
    x.stripe = chance(r, stripeP) ? pickFrom(r, A.id === 'muscle' ? { 'racing-dual': 4, hood: 1, 'side-skirt': 1 } : A.id === 'rally' ? { 'le-mans': 3, 'side-skirt': 2, gradient: 1 } : { 'racing-dual': 2, center: 1, 'side-skirt': 1, pinstripe: 1, gradient: 1 }, 'stripes') : 'none';
    x.stripeColor = U.luminance && U.luminance(x.paint) > 0.35 ? rpick(r, ['#111111', '#c8102e', '#1d4ed8']) : rpick(r, ['#ffffff', '#f2c200', '#111111', '#c0c4c8']);
    x.caliperColor = A.stealth ? rpick(r, ['#111111', '#3a3a3a']) : rpick(r, CALIPERS);
    x.windowTint_pct = A.stealth ? rint(r, 35, 60) : rint(r, 5, 35);
    x.lights = pickFrom(r, A.id === 'eco' ? { led: 3, matrix: 1 } : A.id === 'hyper' || A.id === 'lux' ? { laser: 2, matrix: 2 } : A.id === 'muscle' || A.id === 'drift' ? { led: 2, halogen: 1 } : { led: 2, matrix: 2, laser: 0.5 }, 'lightTypes');
    x.mirrors = pickFrom(r, A.id === 'track' || A.id === 'hyper' ? { carbon: 3, black: 1 } : A.stealth ? { black: 3, body: 1 } : { body: 3, black: 1, carbon: 0.5 }, 'mirrorTypes');
    x.badge = A.stealth ? pickFrom(r, { delete: 3, black: 2 }, 'badgeTypes') : pickFrom(r, { chrome: 3, black: 2, delete: 0.5 }, 'badgeTypes');
    x.livery_number = chance(r, A.number || 0) ? String(rint(r, 1, 99)) : '';

    // ---- interior
    var it = b.interior;
    var pal = INTERIOR_PALETTES.filter(function (p) { return !A.interior || p.tag === A.interior || (A.interior === 'sport' && p.tag === 'track'); });
    var pp = rpick(r, pal.length ? pal : INTERIOR_PALETTES);
    it.seatType = pickFrom(r, wild ? null : A.seat, 'seatTypes');
    if (w.rollCage === 'full' && ['carbon-bucket', 'race-shell', 'bucket'].indexOf(it.seatType) < 0) it.seatType = 'bucket';
    it.upholstery = pickFrom(r, wild ? null : A.upholstery, 'upholsteries');
    it.primaryColor = pp.primary;
    it.accentColor = chance(r, 0.3) ? x.paint : pp.accent;
    it.stitchColor = pp.stitch;
    it.trim = pickFrom(r, wild ? null : A.trim, 'trims');
    it.steering = pickFrom(r, A.id === 'track' ? { 'race-quick-release': 2, 'flat-bottom': 2 } : A.id === 'lux' || A.id === 'eco' ? { round: 3, yoke: 1 } : A.id === 'hyper' ? { 'flat-bottom': 2, yoke: 1 } : { round: 2, 'flat-bottom': 2 }, 'steeringTypes');
    it.headliner = pickFrom(r, A.id === 'eco' ? { cloth: 3 } : A.interior === 'lux' ? { leather: 2, alcantara: 2 } : { alcantara: 3, cloth: 1 }, 'headliners');
    it.ambientLighting = A.id === 'track' || A.id === 'rally' ? false : chance(r, 0.75);
    it.ambientColor = pp.ambient;
    it.harness = w.rollCage !== 'none' || (light && chance(r, 0.4));

    // ---- tech
    var te = b.tech;
    te.screen_in = Number(pickFrom(r, A.lightweight ? { 0: 2, 8: 2, 10: 1 } : A.id === 'lux' ? { 15: 2, 17: 2 } : { 10: 2, 12: 3, 15: 1 }, 'screenSizes'));
    te.digitalCluster = !A.lightweight || chance(r, 0.6);
    te.hud = A.id === 'lux' || A.id === 'gt' || A.id === 'hyper' ? chance(r, 0.7) : chance(r, 0.2);
    te.audio = pickFrom(r, wild ? null : A.audio, 'audioSystems');
    te.adas = pickFrom(r, wild ? null : A.adas, 'adasLevels');
    te.climateZones = A.lightweight ? 1 : A.id === 'lux' ? rint(r, 3, 4) : rint(r, 1, 2);
    te.telemetry = A.id === 'track' || A.id === 'rally' || A.id === 'drift' ? chance(r, 0.8) : chance(r, 0.1);
    te.liftSystem = A.id === 'hyper' || (A.id === 'track' && b.suspension.rideHeight_mm < 85) ? chance(r, 0.6) : false;
    te.nightVision = A.id === 'lux' || A.id === 'offroad' ? chance(r, 0.4) : false;

    // ---- identity
    var np = NAME_PARTS[A.names] || NAME_PARTS.wild;
    var name = (rpick(r, np.a) + ' ' + rpick(r, np.b)).trim();
    var SUFFIX = { gt: ['Speciale', 'Signature', 'Heritage', 'Nera'], track: ['Competizione', 'Superleggera', 'Aero'], hyper: ['Speciale', 'Aero', 'Nera'], sleeper: ['Nera', 'Signature'], drift: ['Edition', 'Kai'], offroad: ['Edition', 'Heritage'], muscle: ['Heritage', 'Edition'] }[A.id];
    if (SUFFIX && chance(r, 0.25)) name += ' ' + rpick(r, SUFFIX);
    b.meta = { name: name.slice(0, 60), id: U.uid('b'), created: Date.now(), modified: Date.now(), presetId: null };
    return { build: b, archetype: A };
  }

  /** Apply CB.rules fixes until no fixable errors remain (and optionally tidy warnings). */
  function resolveIssues(b, opts) {
    opts = opts || {};
    if (!has('rules.validate')) return { build: b, issues: [], iterations: 0, applied: [] };
    var applied = [], iter = 0, issues = [];
    var maxIter = opts.maxIter || 8;
    var tidyLeft = opts.tidyWarnings === false ? 0 : 2;
    for (; iter < maxIter; iter++) {
      var metrics = has('physics.compute') ? safe(function () { return CB.physics.compute(b); }, null, 'physics (surprise)') : null;
      issues = safe(function () { return CB.rules.validate(b, metrics) || []; }, []);
      var fixable = issues.filter(function (i) { return i && i.severity === 'error' && i.fix && i.fix.patch; });
      if (!fixable.length && tidyLeft > 0) {
        fixable = issues.filter(function (i) { return i && i.severity === 'warning' && i.fix && i.fix.patch && (!opts.keep || opts.keep.indexOf(i.id) < 0); });
        tidyLeft--;
      }
      if (!fixable.length) break;
      var before = b;
      fixable.forEach(function (i) {
        b = U.deepMerge(b, i.fix.patch);
        applied.push(i.fix.label || i.id || 'fix');
      });
      b = normalize(b);
      if (sameBuild(before, b)) break; // fixes had no effect → stop
    }
    var finalMetrics = has('physics.compute') ? safe(function () { return CB.physics.compute(b); }, null) : null;
    issues = safe(function () { return CB.rules.validate(b, finalMetrics) || []; }, []);
    return { build: b, issues: issues, iterations: iter, applied: applied, metrics: finalMetrics };
  }

  function scoreCandidate(res) {
    var errs = 0, warns = 0;
    (res.issues || []).forEach(function (i) { if (i.severity === 'error') errs++; else if (i.severity === 'warning') warns++; });
    var s = errs * 1000 + warns * 8;
    var m = res.metrics;
    if (m) {
      if (!isNum(m.power_hp) || m.power_hp < 70) s += 400;
      if (!isNum(m.topSpeed_kph) || m.topSpeed_kph < 130) s += 200;
      if (!isNum(m.zeroTo100_s) || m.zeroTo100_s > 16) s += 120;
    }
    return { score: s, errors: errs, warnings: warns };
  }

  /**
   * surpriseBuild({ seed?, archetype?, attempts=6, tidyWarnings=true }) → best candidate.
   * Pure (no state mutation).
   */
  function surpriseBuild(opts) {
    opts = opts || {};
    var r = makeRng(opts.seed);
    var tries = Math.max(1, opts.attempts || 6);
    var best = null;
    for (var i = 0; i < tries; i++) {
      var raw = randomBuild(r, opts.archetype);
      var nb = normalize(raw.build);
      var res = resolveIssues(nb, { tidyWarnings: opts.tidyWarnings, keep: raw.archetype.id === 'track' ? ['slicks-street', 'tires-slick-street'] : null });
      var sc = scoreCandidate(res);
      var cand = { build: res.build, archetype: { id: raw.archetype.id, name: raw.archetype.name }, issues: res.issues, applied: res.applied, score: sc.score, errors: sc.errors, warnings: sc.warnings, attempts: i + 1 };
      if (!best || cand.score < best.score) best = cand;
      if (sc.errors === 0 && sc.warnings <= 2 && sc.score < 100) break;
    }
    // keep a stable identity for the chosen build
    best.build = U.set(best.build, 'meta.name', best.build.meta.name);
    return best;
  }

  /* ======================================================================
     IMPORT / EXPORT
     ====================================================================== */
  var BUILD_KEYS = ['body', 'engine', 'transmission', 'drivetrain', 'suspension', 'brakes', 'wheels', 'tires', 'aero', 'weight', 'exterior', 'interior', 'tech'];
  function looksLikeBuild(o) {
    if (!U.isPlainObject(o)) return false;
    var n = 0;
    BUILD_KEYS.forEach(function (k) { if (U.isPlainObject(o[k])) n++; });
    return n >= 1;
  }
  function toBuild(o) {
    var b = U.deepMerge(D().defaultBuild(), o);
    if (!U.isPlainObject(b.meta)) b.meta = D().defaultBuild().meta;
    return normalize(b);
  }

  /** parseImport(text) → { ok, kind, builds:[build], entries?, error } */
  function parseImport(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, error: 'Nothing to import yet.' };
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      var o;
      try { o = JSON.parse(s); } catch (err) { return { ok: false, error: 'This is not valid JSON (' + String(err.message || err).replace(/^JSON\.parse:\s*/, '') + ').' }; }
      var list = null, kind = 'build';
      if (Array.isArray(o)) { list = o; kind = 'garage'; }
      else if (o && o.format === EXPORT_FORMAT && Array.isArray(o.entries)) { list = o.entries; kind = 'garage'; }
      else if (o && Array.isArray(o.builds)) { list = o.builds; kind = 'garage'; }
      if (list) {
        var builds = [];
        list.forEach(function (it) {
          var raw = it && it.build && looksLikeBuild(it.build) ? it.build : it;
          if (looksLikeBuild(raw)) {
            var b = safe(function () { return toBuild(raw); }, null);
            if (b) { if (it && it.name && it.build) b = U.set(b, 'meta.name', String(it.name).slice(0, 60)); builds.push(b); }
          }
        });
        if (!builds.length) return { ok: false, error: 'No builds found in this file.' };
        return { ok: true, kind: builds.length === 1 && kind !== 'garage' ? 'build' : kind, builds: builds };
      }
      var raw1 = o && o.build && looksLikeBuild(o.build) ? o.build : o;
      if (!looksLikeBuild(raw1)) return { ok: false, error: 'This JSON does not look like a Redline build (no body / engine / … sections).' };
      var b1 = safe(function () { return toBuild(raw1); }, null);
      return b1 ? { ok: true, kind: 'build', builds: [b1] } : { ok: false, error: 'The build could not be read.' };
    }
    // share link / code
    var code = s;
    var m = s.match(/[#&?]b=([^&\s]+)/);
    if (m) code = m[1];
    if (S() && S().decode) {
      var dec = safe(function () { return S().decode(code); }, null);
      if (dec) return { ok: true, kind: 'share', builds: [dec] };
    }
    return { ok: false, error: 'Paste a Redline share link, share code or build JSON.' };
  }

  function garageBackup() {
    var entries = S() && S().listLocal ? S().listLocal() : [];
    return { format: EXPORT_FORMAT, version: 1, app: 'Redline', exported: Date.now(), count: entries.length, entries: entries };
  }

  /* ---- clipboard & downloads (DOM) */
  function legacyCopy(text) {
    if (!hasDOM) return false;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    var sel = document.getSelection(), prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    ta.select(); ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (prev && sel) { sel.removeAllRanges(); sel.addRange(prev); }
    return ok;
  }
  /** copy(text) → Promise<boolean>. Async Clipboard API → execCommand → false (caller shows manual fallback). */
  function copy(text) {
    text = String(text == null ? '' : text);
    return new Promise(function (resolve) {
      var done = false;
      function fallback() { if (done) return; done = true; resolve(legacyCopy(text)); }
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText && (typeof window === 'undefined' || window.isSecureContext !== false)) {
          var p = navigator.clipboard.writeText(text);
          var timer = setTimeout(fallback, 1200); // some file:// contexts never settle
          p.then(function () { clearTimeout(timer); if (!done) { done = true; resolve(true); } }, function () { clearTimeout(timer); fallback(); });
          return;
        }
      } catch (e) { /* fall through */ }
      fallback();
    });
  }
  function download(filename, text, mime) {
    if (!hasDOM) return false;
    try {
      var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
      return true;
    } catch (e) {
      try {
        var a2 = document.createElement('a');
        a2.href = 'data:' + (mime || 'application/json') + ';charset=utf-8,' + encodeURIComponent(text);
        a2.download = filename; document.body.appendChild(a2); a2.click(); document.body.removeChild(a2);
        return true;
      } catch (e2) { return false; }
    }
  }

  /* ======================================================================
     DOM LAYER
     ====================================================================== */
  var el = U.el;
  function toast(msg, kind, opts) {
    if (CB.ui && CB.ui.toast) return CB.ui.toast(msg, kind, opts);
    if (typeof console !== 'undefined') console.log('[garage]', msg);
    return { close: function () {} };
  }
  function emitChange(action, id) {
    if (!hasDOM) return;
    try { document.dispatchEvent(new CustomEvent('cb:garage-changed', { detail: { action: action, id: id || null } })); } catch (e) { /* ignore */ }
    refreshOpen();
  }

  function svgI(body, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var IC = {
    dice: svgI('<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
    load: svgI('<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>'),
    save: svgI('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h8V4"/><rect x="8" y="13" width="8" height="5" rx="1"/>'),
    copy: svgI('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    edit: svgI('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    trash: svgI('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
    share: svgI('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>'),
    link: svgI('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4L12 18.4"/>'),
    compare: svgI('<rect x="3" y="5" width="7" height="14" rx="1.5"/><rect x="14" y="5" width="7" height="14" rx="1.5"/><path d="M12 3v18" stroke-dasharray="2 2"/>'),
    print: svgI('<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>'),
    download: svgI('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
    upload: svgI('<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M4 3h16"/>'),
    doc: svgI('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>'),
    search: svgI('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    plus: svgI('<path d="M12 5v14M5 12h14"/>'),
    close: svgI('<path d="M6 6l12 12M18 6L6 18"/>'),
    check: svgI('<path d="M5 12l5 5L20 7"/>'),
    garage: svgI('<path d="M3 10l9-6 9 6v10H3z"/><path d="M7 20v-7h10v7"/><path d="M7 16h10"/>'),
    star: svgI('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
    swap: svgI('<path d="M7 7h12l-3-3M17 17H5l3 3"/>'),
    open: svgI('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>'),
    text: svgI('<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>')
  };

  function btn(label, opts) {
    opts = opts || {};
    var b = el('button', { type: 'button', class: 'cb-btn gx-btn' + (opts.kind ? ' ' + opts.kind : '') + (opts.cls ? ' ' + opts.cls : '') + (label ? '' : ' icon-btn'),
      title: opts.title || (label ? null : opts.ariaLabel), 'aria-label': opts.ariaLabel || null, disabled: opts.disabled });
    if (opts.icon) b.appendChild(el('span', { class: 'gx-btn-icon', html: IC[opts.icon] || opts.icon }));
    if (label) b.appendChild(el('span', { class: 'gx-btn-label' }, label));
    if (opts.onClick) b.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onClick(ev); });
    return b;
  }
  function thumbNode(build, cls) {
    var paint = (build && build.exterior && build.exterior.paint) || '#888888';
    var n = el('div', { class: 'gx-thumb' + (cls ? ' ' + cls : ''), style: { '--gx-paint': paint } });
    n.innerHTML = thumbnail(build);
    return n;
  }
  function statChip(label, value, unit) {
    return el('div', { class: 'gx-stat' }, el('span', { class: 'gx-stat-v' }, value, unit ? el('small', null, ' ' + unit) : null), el('span', { class: 'gx-stat-l' }, label));
  }
  function quickStats(bundle) {
    var m = (bundle && bundle.metrics) || null, p = priceOf(bundle);
    var f = el('div', { class: 'gx-stats' });
    if (!m && p == null) { f.appendChild(el('div', { class: 'gx-stat is-empty' }, 'Figures unavailable')); return f; }
    f.appendChild(statChip('Power', m ? fmt(m.power_hp) : '—', 'hp'));
    f.appendChild(statChip('0–100', m ? fmt(m.zeroTo100_s, 1) : '—', 's'));
    f.appendChild(statChip('Top', m ? fmt(m.topSpeed_kph) : '—', 'km/h'));
    f.appendChild(statChip('Price', p == null ? '—' : U.fmtMoney(p, { compact: true })));
    return f;
  }
  /** fill a placeholder with stats on the next idle slice (keeps modals snappy). */
  var idleQ = [], idleT = null;
  function later(fn) {
    idleQ.push(fn);
    if (idleT) return;
    var pump = function () {
      idleT = null;
      var t0 = Date.now();
      while (idleQ.length && Date.now() - t0 < 12) safe(idleQ.shift(), null, 'idle task');
      if (idleQ.length) idleT = setTimeout(pump, 16);
    };
    idleT = setTimeout(pump, 0);
  }

  /* ---- modal registry */
  var openMods = {};
  function modal(kind, opts) {
    if (!CB.ui || !CB.ui.modal) { toast('Modals are unavailable (CB.ui missing).', 'error'); return null; }
    ensureStyles();
    if (openMods[kind]) openMods[kind].close();
    var userClose = opts.onClose;
    opts.onClose = function (res) {
      if (openMods[kind] === api) delete openMods[kind];
      if (userClose) safe(function () { userClose(res); }, null, 'modal onClose');
    };
    var api = CB.ui.modal(opts);
    if (api && api.card) { api.card.classList.add('gx-modal', 'gx-' + kind); }
    if (api && api.el) api.el.classList.add('gx-overlay', 'gx-overlay-' + kind);
    openMods[kind] = api;
    return api;
  }
  var refreshers = {};
  function refreshOpen() { Object.keys(refreshers).forEach(function (k) { if (openMods[k]) safe(refreshers[k], null, 'refresh ' + k); }); }

  /* ======================================================================
     GARAGE OPERATIONS
     ====================================================================== */
  function list() { return S() && S().listLocal ? S().listLocal() : []; }
  function entry(id) { var l = list(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function current() { return S().get(); }

  function presetFresh(id) {
    var raw = D().presetBuild ? D().presetBuild(id) : null;
    return raw ? normalize(raw) : null;
  }
  var presetCache = {};
  function presetBuildCached(id) {
    if (!presetCache[id]) presetCache[id] = presetFresh(id);
    return presetCache[id];
  }

  /** Unsaved = differs from its garage entry; if never saved, differs from its preset / its factory spec / the default build. */
  function isDirty(b) {
    b = b || current();
    var e = entry(b.meta.id);
    if (e) return !sameBuild(b, e.build);
    if (b.meta.presetId) { var p = presetBuildCached(b.meta.presetId); if (p && sameBuild(b, p)) return false; }
    // an untouched factory car (a new build / first visit starts as one) is not unsaved work
    if (CB.stock && typeof CB.stock.isStock === 'function') { try { if (CB.stock.isStock(b)) return false; } catch (eS) { /* ignore */ } }
    return !sameBuild(b, normalize(D().defaultBuild()));
  }

  function save() {
    var b = current();
    var existed = !!entry(b.meta.id);
    var e = S().saveLocal(b);
    if (!e) { toast('Could not save — storage unavailable.', 'error'); return null; }
    toast((existed ? 'Updated “' : 'Saved “') + e.name + '” in Saved builds', 'success', { action: openMods.saved ? null : { label: 'Open saved builds', onClick: openSaved } });
    emitChange(existed ? 'update' : 'save', e.id);
    return e;
  }
  function saveAs(name) {
    var b = current();
    var nm = String(name || (b.meta.name + (entry(b.meta.id) ? ' (copy)' : ''))).trim().slice(0, 60) || 'Untitled Build';
    var nb = U.set(U.set(U.set(b, 'meta.id', U.uid('b')), 'meta.name', nm), 'meta.created', Date.now());
    var e = S().saveLocal(nb);
    S().patch({ meta: { id: e.id, name: nm, created: nb.meta.created } }, { label: 'Save as “' + nm + '”', noHistory: true });
    toast('Saved as “' + nm + '”', 'success');
    emitChange('save', e.id);
    return e;
  }
  function remove(id, opts) {
    var e = entry(id);
    if (!e) return false;
    var go = function () {
      S().deleteLocal(id);
      toast('Deleted “' + e.name + '”', 'info', { action: { label: 'Undo', onClick: function () { S().saveLocal(e.build); emitChange('restore', id); } } });
      emitChange('delete', id);
    };
    if (opts && opts.confirm === false) { go(); return true; }
    if (CB.ui && CB.ui.confirm) CB.ui.confirm({ title: 'Delete “' + e.name + '”?', message: 'This removes the saved build from this device. You can undo right after.', okLabel: 'Delete', danger: true }).then(function (ok) { if (ok) go(); });
    else go();
    return true;
  }
  function rename(id, name) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return false;
    var ok = S().renameLocal(id, name);
    if (ok && current().meta.id === id && current().meta.name !== name) S().set('meta.name', name, { label: 'Rename to “' + name + '”' });
    if (ok) emitChange('rename', id);
    return ok;
  }
  function duplicate(id) {
    var e = S().duplicateLocal(id);
    if (e) { toast('Duplicated as “' + e.name + '”', 'success'); emitChange('duplicate', e.id); }
    return e;
  }

  /** Ask before replacing an unsaved build. choice → 'load' | 'save' | null */
  function confirmReplace(targetName) {
    return new Promise(function (resolve) {
      if (!isDirty()) { resolve('load'); return; }
      var done = false;
      var api = modal('confirm', {
        title: 'Load “' + targetName + '”?', size: 'sm',
        content: el('p', { class: 'gx-confirm-text' }, 'Your current build “' + current().meta.name + '” has unsaved changes. It stays in the undo history either way.'),
        onClose: function () { if (!done) resolve(null); },
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: function () { done = true; resolve(null); } },
          { label: 'Save current & load', kind: 'ghost', onClick: function () { done = true; resolve('save'); } },
          { label: 'Load', kind: 'primary', onClick: function () { done = true; resolve('load'); } }
        ]
      });
      if (!api) resolve('load');
    });
  }
  function applyBuild(b, label, opts) {
    opts = opts || {};
    return confirmReplace(b.meta.name).then(function (choice) {
      if (!choice) return false;
      if (choice === 'save') save();
      S().replace(b, { label: label });
      toast(opts.toast || ('Loaded “' + b.meta.name + '”'), 'success', { action: { label: 'Undo', onClick: function () { S().undo(); } } });
      if (opts.closeKinds) opts.closeKinds.forEach(function (k) { if (openMods[k]) openMods[k].close(); });
      return true;
    });
  }
  function load(id, opts) {
    var b = S().loadLocal(id);
    if (!b) { toast('That saved build no longer exists.', 'error'); return Promise.resolve(false); }
    return applyBuild(b, 'Load “' + b.meta.name + '”', opts);
  }
  function loadPreset(id, opts) {
    var p = D().preset ? D().preset(id) : null;
    var b = presetFresh(id);
    if (!b || !p) { toast('Unknown preset.', 'error'); return Promise.resolve(false); }
    b = U.set(b, 'meta.id', U.uid('b'));
    return applyBuild(b, 'Load preset “' + p.name + '”', Object.assign({ toast: 'Loaded preset “' + p.name + '”' }, opts || {}));
  }

  /* ======================================================================
     SURPRISE ME
     ====================================================================== */
  function surprise(opts) {
    opts = opts || {};
    var res = safe(function () { return surpriseBuild(opts); }, null, 'surpriseBuild');
    if (!res || !res.build) { toast('Could not roll a build this time.', 'error'); return null; }
    S().replace(res.build, { label: 'Surprise: ' + res.build.meta.name });
    var bd = compute(S().get()), m = bd.metrics;
    var detail = m ? ' · ' + fmt(m.power_hp) + ' hp · 0–100 ' + fmt(m.zeroTo100_s, 1) + ' s' : '';
    toast(res.archetype.name + ': “' + res.build.meta.name + '”' + detail + (res.applied && res.applied.length ? ' (' + plural(res.applied.length, 'rule fix') + ' applied)' : ''), 'success', { duration: 4800, action: { label: 'Undo', onClick: function () { S().undo(); } } });
    if (openMods.presets) openMods.presets.close();
    return res;
  }

  /* ======================================================================
     PRESETS GALLERY
     ====================================================================== */
  function openPresets() {
    var presets = (D() && D().presets) || [];
    var state = { q: '', tag: 'All' };
    var tags = ['All'];
    presets.forEach(function (p) { (p.tags || []).forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); }); });
    var api = modal('presets', {
      title: 'Presets gallery', subtitle: presets.length + ' signature builds from the Redline design studio. Load one as a starting point — everything stays editable.',
      size: 'xl',
      content: function (body) {
        var search = el('input', { type: 'search', class: 'gx-search-input', placeholder: 'Search presets…', 'aria-label': 'Search presets' });
        var chips = el('div', { class: 'gx-chips', role: 'toolbar', 'aria-label': 'Filter by tag' });
        var count = el('span', { class: 'gx-count' });
        var grid = el('div', { class: 'gx-grid gx-grid-presets', role: 'list' });
        tags.forEach(function (t) {
          var c = el('button', { type: 'button', class: 'gx-chip' + (t === state.tag ? ' is-active' : ''), 'aria-pressed': t === state.tag ? 'true' : 'false' }, t);
          c.addEventListener('click', function () {
            state.tag = t;
            Array.prototype.forEach.call(chips.children, function (n) { var on = n.textContent === t; n.classList.toggle('is-active', on); n.setAttribute('aria-pressed', on ? 'true' : 'false'); });
            filter();
          });
          chips.appendChild(c);
        });
        body.appendChild(el('div', { class: 'gx-toolbar' },
          el('label', { class: 'gx-search' }, el('span', { class: 'gx-search-icon', html: IC.search }), search),
          chips, el('span', { class: 'gx-spacer' }), count,
          btn('Surprise me', { icon: 'dice', kind: 'ghost', title: 'Random, valid build', onClick: function () { surprise(); } })));
        body.appendChild(grid);
        var cur = current();
        var cards = presets.map(function (p) {
          var tagline = p.tagline || '';
          var statsHost = el('div', { class: 'gx-stats-host' }, el('div', { class: 'gx-stats is-loading' }, el('span', { class: 'gx-skel' }), el('span', { class: 'gx-skel' }), el('span', { class: 'gx-skel' }), el('span', { class: 'gx-skel' })));
          var isBase = cur.meta.presetId === p.id;
          var card = el('article', { class: 'gx-card gx-preset-card' + (isBase ? ' is-current' : ''), role: 'listitem', tabindex: '0', 'aria-label': p.name + ' — ' + tagline },
            el('div', { class: 'gx-card-media' }, el('div', { class: 'gx-thumb-host' }), isBase ? el('span', { class: 'gx-ribbon' }, isDirty() ? 'Based on this' : 'Current') : null),
            el('div', { class: 'gx-card-body' },
              el('h3', { class: 'gx-card-title' }, p.name),
              el('p', { class: 'gx-card-tagline' }, tagline),
              el('div', { class: 'gx-tags' }, (p.tags || []).map(function (t) { return el('span', { class: 'gx-tag' }, t); })),
              statsHost),
            el('div', { class: 'gx-card-actions' },
              btn('Load', { icon: 'load', kind: 'primary', onClick: function () { loadPreset(p.id, { closeKinds: ['presets'] }); } }),
              btn('Compare', { icon: 'compare', kind: 'ghost', title: 'Compare with your current build', onClick: function () { openCompare(['current', 'preset:' + p.id]); } }),
              btn('', { icon: 'doc', kind: 'ghost', ariaLabel: 'Spec sheet for ' + p.name, title: 'Spec sheet', onClick: function () { var pb = presetBuildCached(p.id); if (pb) openSpec(pb); } })));
          card.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target === card) { ev.preventDefault(); loadPreset(p.id, { closeKinds: ['presets'] }); } });
          card.addEventListener('dblclick', function () { loadPreset(p.id, { closeKinds: ['presets'] }); });
          later(function () {
            var pb = presetBuildCached(p.id);
            if (!pb) return;
            card.querySelector('.gx-thumb-host').appendChild(thumbNode(pb));
            U.clear(statsHost).appendChild(quickStats(compute(pb)));
            var bd = compute(pb), errs = countSev(bd, 'error');
            if (bd.legality && bd.legality.streetLegal === false) card.querySelector('.gx-tags').appendChild(el('span', { class: 'gx-tag is-warn', title: (bd.legality.reasons || []).map(function (r) { return typeof r === 'string' ? r : r.message; }).join('\n') }, 'Track only'));
            if (errs) card.querySelector('.gx-tags').appendChild(el('span', { class: 'gx-tag is-bad' }, plural(errs, 'error')));
          });
          grid.appendChild(card);
          return { p: p, card: card, text: (p.name + ' ' + tagline + ' ' + (p.tags || []).join(' ')).toLowerCase() };
        });
        function filter() {
          var q = state.q.trim().toLowerCase(), n = 0;
          cards.forEach(function (c) {
            var ok = (!q || q.split(/\s+/).every(function (w) { return c.text.indexOf(w) >= 0; })) && (state.tag === 'All' || (c.p.tags || []).indexOf(state.tag) >= 0);
            c.card.hidden = !ok; if (ok) n++;
          });
          count.textContent = n + ' of ' + presets.length;
          var empty = grid.querySelector('.gx-empty-inline');
          if (!n && !empty) grid.appendChild(el('div', { class: 'gx-empty-inline' }, 'No presets match “' + state.q + '”.'));
          else if (n && empty) empty.parentNode.removeChild(empty);
        }
        search.addEventListener('input', function () { state.q = search.value; filter(); });
        filter();
        setTimeout(function () { try { search.focus(); } catch (e) { /* ignore */ } }, 60);
      },
      actions: [{ label: 'Close', kind: 'ghost' }]
    });
    return api;
  }

  /* ======================================================================
     SAVED BUILDS
     ====================================================================== */
  var savedUi = { q: '', sort: 'recent', selected: [] };
  function openSaved() {
    var api = modal('saved', {
      title: 'Saved builds', subtitle: 'Saved builds live in this browser (localStorage). Export a backup to move them between devices.',
      size: 'xl',
      content: function (body) {
        var host = el('div', { class: 'gx-saved' });
        body.appendChild(host);
        refreshers.saved = function () { renderSaved(host); };
        renderSaved(host);
      },
      onClose: function () { delete refreshers.saved; },
      actions: [{ label: 'Close', kind: 'ghost' }]
    });
    return api;
  }

  function sortEntries(entries, mode) {
    var withB = entries.map(function (e) { return { e: e, key: null }; });
    var keyFn = {
      recent: function (e) { return -(e.saved || 0); },
      name: function (e) { return String(e.name || '').toLowerCase(); },
      price: function (e) { var p = priceOf(compute(e.build)); return p == null ? Infinity : p; },
      power: function (e) { var v = U.get(compute(e.build), 'metrics.power_hp'); return isNum(v) ? -v : Infinity; },
      lap: function (e) { var v = U.get(compute(e.build), 'metrics.lapTime_s'); return isNum(v) ? v : Infinity; }
    }[mode] || function (e) { return -(e.saved || 0); };
    withB.forEach(function (w) { w.key = keyFn(w.e); });
    withB.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return withB.map(function (w) { return w.e; });
  }

  function renderSaved(host) {
    var cur = current();
    var entries = list();
    savedUi.selected = savedUi.selected.filter(function (id) { return entries.some(function (e) { return e.id === id; }); });
    U.clear(host);
    var dirty = isDirty(cur), curEntry = entry(cur.meta.id);

    // ---- current build banner
    var banner = el('div', { class: 'gx-current' },
      thumbNode(cur, 'is-small'),
      el('div', { class: 'gx-current-text' },
        el('span', { class: 'gx-eyebrow' }, 'Current build'),
        el('strong', null, cur.meta.name),
        el('span', { class: 'gx-current-state ' + (curEntry ? (dirty ? 'is-warn' : 'is-good') : 'is-dim') },
          curEntry ? (dirty ? 'Unsaved changes since ' + relTime(curEntry.saved) : 'Saved ' + relTime(curEntry.saved)) : 'Not saved yet')),
      el('div', { class: 'gx-current-actions' },
        btn(curEntry ? 'Update' : 'Save', { icon: 'save', kind: 'primary', disabled: curEntry && !dirty, title: 'Ctrl/⌘ S', onClick: function () { save(); } }),
        btn('Save as new…', { icon: 'plus', kind: 'ghost', onClick: function () { promptName('Save as new build', cur.meta.name + (curEntry ? ' (copy)' : ''), function (nm) { saveAs(nm); }); } })));
    host.appendChild(banner);

    // ---- toolbar
    var search = el('input', { type: 'search', class: 'gx-search-input', placeholder: 'Search ' + plural(entries.length, 'saved build') + '…', value: savedUi.q, 'aria-label': 'Search saved builds' });
    var sort = el('select', { class: 'gx-select', 'aria-label': 'Sort by' },
      [['recent', 'Recently saved'], ['name', 'Name'], ['price', 'Price (low → high)'], ['power', 'Power (high → low)'], ['lap', 'Lap time']].map(function (o) {
        return el('option', { value: o[0], selected: savedUi.sort === o[0] }, o[1]);
      }));
    var cmpBtn = btn('Compare selected', { icon: 'compare', kind: 'ghost', disabled: !savedUi.selected.length, title: 'Compare your current build with up to 2 selected builds', onClick: function () {
      var src = ['current'].concat(savedUi.selected.filter(function (id) { return id !== cur.meta.id; }).map(function (id) { return 'saved:' + id; })).slice(0, 3);
      if (src.length < 2 && savedUi.selected.length) src = savedUi.selected.slice(0, 3).map(function (id) { return 'saved:' + id; });
      openCompare(src);
    } });
    var selInfo = el('span', { class: 'gx-count' }, savedUi.selected.length ? savedUi.selected.length + ' selected' : '');
    host.appendChild(el('div', { class: 'gx-toolbar' },
      el('label', { class: 'gx-search' }, el('span', { class: 'gx-search-icon', html: IC.search }), search),
      el('label', { class: 'gx-sort' }, el('span', { class: 'cb-hint' }, 'Sort'), sort),
      el('span', { class: 'gx-spacer' }), selInfo, cmpBtn,
      btn('Import', { icon: 'upload', kind: 'ghost', onClick: function () { openImport(); } }),
      btn('Backup', { icon: 'download', kind: 'ghost', title: 'Download every saved build as one JSON file', disabled: !entries.length, onClick: exportGarage })));

    if (!entries.length) {
      host.appendChild(el('div', { class: 'gx-empty' },
        el('div', { class: 'gx-empty-art', html: IC.garage.replace(/width="16" height="16"/, 'width="56" height="56"') }),
        el('h3', null, 'No saved builds yet'),
        el('p', null, 'Save the build you are working on, start from a preset, or roll the dice.'),
        el('div', { class: 'gx-empty-actions' },
          btn('Save current build', { icon: 'save', kind: 'primary', onClick: function () { save(); } }),
          btn('Browse presets', { icon: 'star', kind: 'ghost', onClick: function () { openPresets(); } }),
          btn('Surprise me', { icon: 'dice', kind: 'ghost', onClick: function () { surprise(); } }))));
      return;
    }

    var grid = el('div', { class: 'gx-grid gx-grid-saved', role: 'list' });
    host.appendChild(grid);
    function draw() {
      U.clear(grid);
      var q = savedUi.q.trim().toLowerCase();
      var shown = sortEntries(entries, savedUi.sort).filter(function (e) {
        if (!q) return true;
        var d = describe(e.build);
        return (e.name + ' ' + d.style + ' ' + d.engine + ' ' + paintName(e.build)).toLowerCase().indexOf(q) >= 0;
      });
      if (!shown.length) { grid.appendChild(el('div', { class: 'gx-empty-inline' }, 'No saved builds match “' + savedUi.q + '”.')); return; }
      shown.forEach(function (e) { grid.appendChild(savedCard(e, cur, dirty, function () { cmpBtn.disabled = !savedUi.selected.length; selInfo.textContent = savedUi.selected.length ? savedUi.selected.length + ' selected' : ''; })); });
    }
    search.addEventListener('input', function () { savedUi.q = search.value; draw(); });
    sort.addEventListener('change', function () { savedUi.sort = sort.value; draw(); });
    draw();
  }

  function savedCard(e, cur, curDirty, onSel) {
    var isCur = e.id === cur.meta.id;
    var preset = e.build.meta.presetId && D().preset ? D().preset(e.build.meta.presetId) : null;
    var sel = el('input', { type: 'checkbox', class: 'gx-check', checked: savedUi.selected.indexOf(e.id) >= 0, 'aria-label': 'Select ' + e.name + ' for comparison' });
    var title = el('h3', { class: 'gx-card-title', title: 'Double-click to rename' }, e.name);
    var statsHost = el('div', { class: 'gx-stats-host' }, el('div', { class: 'gx-stats is-loading' }, el('span', { class: 'gx-skel' }), el('span', { class: 'gx-skel' }), el('span', { class: 'gx-skel' }), el('span', { class: 'gx-skel' })));
    var d = describe(e.build);
    var card = el('article', { class: 'gx-card gx-saved-card' + (isCur ? ' is-current' : '') + (sel.checked ? ' is-selected' : ''), role: 'listitem', tabindex: '0', 'aria-label': e.name },
      el('div', { class: 'gx-card-media' },
        el('div', { class: 'gx-thumb-host' }),
        el('label', { class: 'gx-check-wrap', title: 'Select for comparison' }, sel, el('span', { class: 'gx-check-box', html: IC.check })),
        isCur ? el('span', { class: 'gx-ribbon' + (curDirty ? ' is-warn' : '') }, curDirty ? 'Current · edited' : 'Current') : null),
      el('div', { class: 'gx-card-body' },
        title,
        el('p', { class: 'gx-card-meta' }, d.headline),
        el('p', { class: 'gx-card-meta is-dim' }, 'Saved ' + relTime(e.saved) + (preset ? ' · from ' + preset.name : '')),
        statsHost),
      el('div', { class: 'gx-card-actions' },
        btn(isCur ? 'Revert' : 'Load', { icon: 'load', kind: isCur ? 'ghost' : 'primary', disabled: isCur && !curDirty, title: isCur ? 'Discard edits and reload the saved version' : 'Load into the Garage', onClick: function () { load(e.id, { closeKinds: ['saved'] }); } }),
        btn('', { icon: 'edit', kind: 'ghost', ariaLabel: 'Rename', title: 'Rename', onClick: function () { startRename(); } }),
        btn('', { icon: 'copy', kind: 'ghost', ariaLabel: 'Duplicate', title: 'Duplicate', onClick: function () { duplicate(e.id); } }),
        btn('', { icon: 'share', kind: 'ghost', ariaLabel: 'Share', title: 'Share link', onClick: function () { openShare(e.build); } }),
        btn('', { icon: 'doc', kind: 'ghost', ariaLabel: 'Spec sheet', title: 'Spec sheet', onClick: function () { openSpec(e.build); } }),
        btn('', { icon: 'download', kind: 'ghost', ariaLabel: 'Export JSON', title: 'Export JSON', onClick: function () { exportJSON(e.build); } }),
        btn('', { icon: 'trash', kind: 'ghost danger', ariaLabel: 'Delete', title: 'Delete', onClick: function () { remove(e.id); } })));
    sel.addEventListener('click', function (ev) { ev.stopPropagation(); });
    sel.addEventListener('change', function () {
      var i = savedUi.selected.indexOf(e.id);
      if (sel.checked && i < 0) {
        if (savedUi.selected.length >= 2) { sel.checked = false; toast('Compare holds up to 3 builds: your current one plus 2 selected.', 'warning'); return; }
        savedUi.selected.push(e.id);
      } else if (!sel.checked && i >= 0) savedUi.selected.splice(i, 1);
      card.classList.toggle('is-selected', sel.checked);
      onSel();
    });
    function startRename() {
      var input = el('input', { type: 'text', class: 'gx-rename', value: e.name, maxlength: '60', 'aria-label': 'New name' });
      title.replaceWith(input);
      input.focus(); input.select();
      var finished = false;
      function finish(commit) {
        if (finished) return; finished = true;
        var v = input.value.trim();
        if (commit && v && v !== e.name) { rename(e.id, v); return; } // re-renders
        input.replaceWith(title);
      }
      input.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } });
      input.addEventListener('blur', function () { finish(true); });
    }
    title.addEventListener('dblclick', function (ev) { ev.stopPropagation(); startRename(); });
    card.addEventListener('keydown', function (ev) {
      if (ev.target !== card) return;
      if (ev.key === 'Enter') { ev.preventDefault(); if (!isCur || curDirty) load(e.id, { closeKinds: ['saved'] }); }
      else if (ev.key === 'F2') { ev.preventDefault(); startRename(); }
      else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); remove(e.id); }
    });
    later(function () {
      card.querySelector('.gx-thumb-host').appendChild(thumbNode(e.build));
      var bd = compute(e.build);
      U.clear(statsHost).appendChild(quickStats(bd));
      var errs = countSev(bd, 'error');
      if (errs) statsHost.appendChild(el('span', { class: 'gx-tag is-bad' }, plural(errs, 'error')));
    });
    return card;
  }

  function promptName(title, initial, onOk) {
    var input = el('input', { type: 'text', class: 'gx-text-input', value: initial || '', maxlength: '60', autofocus: true, 'aria-label': 'Build name' });
    var api = modal('prompt', {
      title: title, size: 'sm',
      content: function (body) {
        body.appendChild(el('label', { class: 'gx-field' }, el('span', { class: 'cb-label' }, 'Name'), input));
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); var v = input.value.trim(); if (v) { api.close(); onOk(v); } } });
        setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 40);
      },
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save', kind: 'primary', onClick: function () { var v = input.value.trim(); if (!v) { input.focus(); return false; } onOk(v); } }
      ]
    });
    return api;
  }

  /* ======================================================================
     COMPARE MODE
     ====================================================================== */
  var SLOT_LETTERS = ['A', 'B', 'C'];
  function resolveSource(src) {
    if (src && typeof src === 'object' && src.body) return { key: 'build:' + (src.meta && src.meta.id), kind: 'build', label: (src.meta && src.meta.name) || 'Build', build: src };
    if (src && typeof src === 'object' && src.build) return { key: src.key || 'build:' + src.build.meta.id, kind: 'build', label: src.label || src.build.meta.name, build: src.build };
    src = String(src || 'current');
    if (src === 'current') { var c = current(); return { key: 'current', kind: 'current', label: c.meta.name + ' (current)', build: c }; }
    if (src.indexOf('saved:') === 0) {
      var id = src.slice(6), b = S().loadLocal(id), e = entry(id);
      return b ? { key: src, kind: 'saved', id: id, label: (e && e.name) || b.meta.name, build: b } : null;
    }
    if (src.indexOf('preset:') === 0) {
      var pid = src.slice(7), p = D().preset ? D().preset(pid) : null, pb = presetBuildCached(pid);
      return pb ? { key: src, kind: 'preset', id: pid, label: (p && p.name) || pb.meta.name, build: pb } : null;
    }
    return null;
  }
  function defaultSources() {
    var cur = current(), out = ['current'];
    var saved = list().filter(function (e) { return e.id !== cur.meta.id; });
    if (saved.length) out.push('saved:' + saved[0].id);
    else {
      var ps = (D().presets || []).filter(function (p) { return p.id !== cur.meta.presetId; });
      if (ps.length) out.push('preset:' + ps[0].id);
    }
    return out;
  }

  function openCompare(sources) {
    var srcs = (Array.isArray(sources) && sources.length ? sources : defaultSources()).slice(0, 3);
    var slots = srcs.map(resolveSource).filter(Boolean);
    if (slots.length < 2) {
      var extra = defaultSources().map(resolveSource).filter(function (s) { return s && !slots.some(function (x) { return x.key === s.key; }); });
      while (slots.length < 2 && extra.length) slots.push(extra.shift());
    }
    if (slots.length < 2) {
      var ps = (D().presets || []);
      for (var i = 0; i < ps.length && slots.length < 2; i++) { var r = resolveSource('preset:' + ps[i].id); if (r && !slots.some(function (x) { return x.key === r.key; })) slots.push(r); }
    }
    var ui = { onlyDiff: false, overlay: [0, 1], charts: {} };
    var root;
    var api = modal('compare', {
      title: 'Compare builds', subtitle: 'Side by side, with the best value in every row highlighted. Overlay any two builds on the charts.',
      size: 'xl',
      content: function (body) { root = el('div', { class: 'gx-compare' }); body.appendChild(root); render(); },
      onClose: function () { Object.keys(ui.charts).forEach(function (k) { safe(function () { ui.charts[k].destroy(); }); }); ui.charts = {}; },
      actions: [{ label: 'Close', kind: 'ghost' }]
    });

    function sourceOptions(selectedKey) {
      var cur = current();
      var opts = [el('optgroup', { label: 'This session' }, el('option', { value: 'current', selected: selectedKey === 'current' }, cur.meta.name + ' (current)'))];
      var saved = list();
      if (saved.length) opts.push(el('optgroup', { label: 'Saved builds' }, saved.map(function (e) { return el('option', { value: 'saved:' + e.id, selected: selectedKey === 'saved:' + e.id }, e.name + (e.id === cur.meta.id ? ' (saved copy)' : '')); })));
      opts.push(el('optgroup', { label: 'Presets' }, (D().presets || []).map(function (p) { return el('option', { value: 'preset:' + p.id, selected: selectedKey === 'preset:' + p.id }, p.name); })));
      return opts;
    }

    function render() {
      U.clear(root);
      var bundles = slots.map(function (s) { return compute(s.build); });
      if (ui.overlay[0] >= slots.length) ui.overlay[0] = 0;
      if (ui.overlay[1] >= slots.length || ui.overlay[1] === ui.overlay[0]) ui.overlay[1] = ui.overlay[0] === 0 ? 1 : 0;

      // ---- toolbar
      var diffT = el('input', { type: 'checkbox', checked: ui.onlyDiff });
      diffT.addEventListener('change', function () { ui.onlyDiff = diffT.checked; renderTable(); });
      root.appendChild(el('div', { class: 'gx-toolbar' },
        el('label', { class: 'gx-toggle' }, diffT, el('span', { class: 'gx-toggle-track' }), el('span', null, 'Differences only')),
        el('span', { class: 'gx-spacer' }),
        slots.length < 3 ? btn('Add build', { icon: 'plus', kind: 'ghost', onClick: function () {
          var pool = defaultSources().concat(list().map(function (e) { return 'saved:' + e.id; }), (D().presets || []).map(function (p) { return 'preset:' + p.id; }));
          for (var i = 0; i < pool.length; i++) { var r = resolveSource(pool[i]); if (r && !slots.some(function (s) { return s.key === r.key; })) { slots.push(r); break; } }
          render();
        } }) : null,
        btn('Swap A ↔ B', { icon: 'swap', kind: 'ghost', onClick: function () { var t = slots[0]; slots[0] = slots[1]; slots[1] = t; render(); } })));

      // ---- slot headers
      var heads = el('div', { class: 'gx-cmp-heads', style: { '--gx-cols': slots.length } });
      slots.forEach(function (s, i) {
        var sel = el('select', { class: 'gx-select', 'aria-label': 'Build ' + SLOT_LETTERS[i] }, sourceOptions(s.kind === 'build' ? null : s.key));
        if (s.kind === 'build') sel.insertBefore(el('option', { value: s.key, selected: true }, s.label), sel.firstChild);
        sel.addEventListener('change', function () { var r = resolveSource(sel.value); if (r) { slots[i] = r; render(); } });
        var bd = bundles[i];
        heads.appendChild(el('div', { class: 'gx-cmp-head is-slot-' + i },
          el('div', { class: 'gx-cmp-letter' }, SLOT_LETTERS[i]),
          thumbNode(s.build, 'is-compare'),
          sel,
          el('div', { class: 'gx-cmp-sub' }, describe(s.build).headline),
          el('div', { class: 'gx-cmp-price' }, priceOf(bd) == null ? '—' : money(priceOf(bd))),
          el('div', { class: 'gx-cmp-actions' },
            s.kind !== 'current' ? btn('Load', { icon: 'load', kind: 'ghost', onClick: function () { applyBuild(U.set(s.build, 'meta.id', s.kind === 'saved' ? s.build.meta.id : U.uid('b')), 'Load “' + s.label + '” from compare').then(function (ok) { if (ok && api) api.close(); }); } }) : null,
            btn('', { icon: 'doc', kind: 'ghost', ariaLabel: 'Spec sheet', title: 'Spec sheet', onClick: function () { openSpec(s.build); } }),
            slots.length > 2 ? btn('', { icon: 'close', kind: 'ghost', ariaLabel: 'Remove from comparison', title: 'Remove', onClick: function () { slots.splice(i, 1); render(); } }) : null)));
      });
      root.appendChild(heads);

      // ---- verdict
      var verdict = el('div', { class: 'gx-verdict' });
      root.appendChild(verdict);

      // ---- overlay charts
      var oa = el('select', { class: 'gx-select is-compact', 'aria-label': 'Primary series' }, slots.map(function (s, i) { return el('option', { value: String(i), selected: ui.overlay[0] === i }, SLOT_LETTERS[i] + ' · ' + s.label); }));
      var ob = el('select', { class: 'gx-select is-compact', 'aria-label': 'Overlay series' }, slots.map(function (s, i) { return el('option', { value: String(i), selected: ui.overlay[1] === i }, SLOT_LETTERS[i] + ' · ' + s.label); }));
      oa.addEventListener('change', function () { ui.overlay[0] = Number(oa.value); if (ui.overlay[1] === ui.overlay[0]) ui.overlay[1] = (ui.overlay[0] + 1) % slots.length; ob.value = String(ui.overlay[1]); drawCharts(); });
      ob.addEventListener('change', function () { ui.overlay[1] = Number(ob.value); if (ui.overlay[1] === ui.overlay[0]) ui.overlay[0] = (ui.overlay[1] + 1) % slots.length; oa.value = String(ui.overlay[0]); drawCharts(); });
      root.appendChild(el('div', { class: 'gx-section-head' }, el('h3', null, 'Overlay'), el('div', { class: 'gx-overlay-pick' }, oa, el('span', { class: 'cb-hint' }, 'solid  vs  dashed'), ob)));
      var chartGrid = el('div', { class: 'gx-cmp-charts' });
      root.appendChild(chartGrid);
      var chartDefs = [
        { id: 'dyno', title: 'Dyno — power & torque', fn: 'dyno', data: function (bd) { return bd.metrics; } },
        { id: 'accel', title: 'Acceleration — speed vs time', fn: 'accel', data: function (bd) { return bd.metrics; } },
        { id: 'radar', title: 'Ratings', fn: 'radar', data: function (bd) { return bd.metrics && bd.metrics.ratings; } },
        { id: 'downforce', title: 'Downforce vs drag', fn: 'downforce', data: function (bd) { return bd.metrics; } }
      ];
      Object.keys(ui.charts).forEach(function (k) { safe(function () { ui.charts[k].destroy(); }); });
      ui.charts = {};
      var canvases = {};
      chartDefs.forEach(function (c) {
        var cv = el('canvas', { 'aria-label': c.title, role: 'img' });
        canvases[c.id] = cv;
        chartGrid.appendChild(el('figure', { class: 'gx-chart-card' }, el('figcaption', null, c.title), el('div', { class: 'cb-chart gx-chart' }, cv)));
      });
      function drawCharts() {
        var A = bundles[ui.overlay[0]], B = bundles[ui.overlay[1]];
        var la = SLOT_LETTERS[ui.overlay[0]] + ' · ' + slots[ui.overlay[0]].label, lb = SLOT_LETTERS[ui.overlay[1]] + ' · ' + slots[ui.overlay[1]].label;
        chartDefs.forEach(function (c) {
          var cv = canvases[c.id];
          if (!CB.charts || typeof CB.charts[c.fn] !== 'function' || !A.metrics) {
            var wrap = cv.parentNode;
            if (wrap && !wrap.querySelector('.gx-chart-empty')) wrap.appendChild(el('div', { class: 'gx-chart-empty' }, !A.metrics ? 'Performance model not loaded' : 'Charts unavailable'));
            return;
          }
          var opts = { label: la, compareLabel: lb, height: c.id === 'radar' ? 300 : 240 };
          if (ui.charts[c.id]) safe(function () { ui.charts[c.id].redraw(c.data(A), B.metrics ? c.data(B) : null, opts); }, null, 'chart redraw');
          else ui.charts[c.id] = safe(function () { return CB.charts[c.fn](cv, c.data(A), B.metrics ? c.data(B) : null, opts); }, null, 'chart ' + c.id);
        });
      }
      requestAnimationFrame(drawCharts);

      // ---- table
      var tableHost = el('div', { class: 'gx-cmp-table-host' });
      root.appendChild(el('div', { class: 'gx-section-head' }, el('h3', null, 'Full comparison'), el('span', { class: 'cb-hint' }, 'Deltas are relative to build A. Green = better.')));
      root.appendChild(tableHost);
      function renderTable() {
        var groups = compareRows(bundles, { onlyDiff: ui.onlyDiff });
        var tally = tallyWins(compareRows(bundles, { includeConfig: false }), slots.length);
        U.clear(verdict);
        var maxW = Math.max.apply(null, tally.wins);
        var leaders = tally.wins.map(function (w, i) { return w === maxW ? i : -1; }).filter(function (i) { return i >= 0; });
        verdict.appendChild(el('div', { class: 'gx-verdict-text' },
          tally.contested ? (leaders.length === 1
            ? el('span', null, el('strong', null, SLOT_LETTERS[leaders[0]] + ' · ' + slots[leaders[0]].label), ' leads ' + maxW + ' of ' + tally.contested + ' measured categories.')
            : el('span', null, 'Dead heat — ' + leaders.map(function (i) { return SLOT_LETTERS[i]; }).join(' & ') + ' each lead ' + maxW + ' of ' + tally.contested + ' categories.'))
            : el('span', { class: 'cb-hint' }, 'Load the performance model to see who wins each row.')));
        verdict.appendChild(el('div', { class: 'gx-verdict-bars' }, tally.wins.map(function (w, i) {
          return el('div', { class: 'gx-verdict-bar is-slot-' + i, title: SLOT_LETTERS[i] + ': ' + w + ' wins' },
            el('span', { class: 'gx-verdict-letter' }, SLOT_LETTERS[i]),
            el('span', { class: 'gx-verdict-fill', style: { width: (tally.contested ? (w / tally.contested) * 100 : 0).toFixed(1) + '%' } }),
            el('span', { class: 'gx-verdict-n' }, String(w)));
        })));

        var table = el('table', { class: 'gx-cmp-table' });
        var thead = el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'gx-cmp-metric' }, 'Metric'),
          slots.map(function (s, i) { return el('th', { scope: 'col', class: 'is-slot-' + i }, el('span', { class: 'gx-cmp-letter is-inline' }, SLOT_LETTERS[i]), ' ', s.label); })));
        table.appendChild(thead);
        groups.forEach(function (g) {
          var tb = el('tbody');
          tb.appendChild(el('tr', { class: 'gx-cmp-group' }, el('th', { colspan: String(slots.length + 1), scope: 'colgroup' }, g.group)));
          g.rows.forEach(function (r) {
            var tr = el('tr', { class: r.differs ? 'is-diff' : 'is-same' });
            tr.appendChild(el('th', { scope: 'row', class: 'gx-cmp-metric' }, r.label, r.unit ? el('small', null, ' ' + r.unit) : null,
              r.better ? el('span', { class: 'gx-better', title: r.better === 'high' ? 'Higher is better' : r.better === 'low' ? 'Lower is better' : 'Closest to ' + 50 + ' is best' }, r.better === 'high' ? '↑' : r.better === 'low' ? '↓' : '◎') : null));
            r.cells.forEach(function (c, i) {
              var td = el('td', { class: 'is-slot-' + i + (c.best ? ' gx-best' : '') + (c.worst ? ' gx-worst' : '') + (c.changed ? ' gx-changed' : '') });
              if (c.color) td.appendChild(el('span', { class: 'gx-swatch-dot', style: { background: c.color } }));
              td.appendChild(el('span', { class: 'gx-cell-v' }, c.text));
              if (r.bar && isNum(c.v)) td.appendChild(el('span', { class: 'gx-cell-bar' }, el('span', { style: { width: clamp(c.v, 0, 100) + '%' } })));
              if (c.deltaText) td.appendChild(el('span', { class: 'gx-delta' + (c.deltaGood === true ? ' is-good' : c.deltaGood === false ? ' is-bad' : '') }, c.deltaText));
              if (c.best) td.setAttribute('title', 'Best in row');
              tr.appendChild(td);
            });
            tb.appendChild(tr);
          });
          table.appendChild(tb);
        });
        U.clear(tableHost).appendChild(table);
        if (!groups.length) tableHost.appendChild(el('div', { class: 'gx-empty-inline' }, 'These builds are identical.'));
      }
      renderTable();
    }
    return api;
  }

  /* ======================================================================
     SHARE
     ====================================================================== */
  function shareURLFor(b) {
    if (S() && S().shareURL) return S().shareURL(b);
    var base = hasDOM ? String(window.location.href).split('#')[0] : '';
    return base + '#b=' + (S() && S().encode ? S().encode(b) : '');
  }
  function copyWithFeedback(text, what, selectEl) {
    return copy(text).then(function (ok) {
      if (ok) toast(what + ' copied to clipboard', 'success', { duration: 1800 });
      else {
        if (selectEl) { try { selectEl.focus(); selectEl.select(); } catch (e) { /* ignore */ } }
        toast('Clipboard blocked here — the text is selected, press ' + (/Mac|iP/.test((typeof navigator !== 'undefined' && navigator.platform) || '') ? '⌘' : 'Ctrl') + '+C to copy.', 'warning', { duration: 5000 });
      }
      return ok;
    });
  }

  function openShare(build) {
    var b = build || current();
    var url = shareURLFor(b);
    var code = S().encode ? S().encode(b) : '';
    var json = S().exportJSON ? S().exportJSON(b) : JSON.stringify(b, null, 2);
    var isFile = hasDOM && /^file:/i.test(String(window.location.protocol));
    var fmtMode = 'plain';
    return modal('share', {
      title: 'Share “' + b.meta.name + '”', subtitle: 'The whole configuration travels inside the link — nothing is uploaded anywhere.',
      size: 'lg',
      content: function (body) {
        var bd = compute(b);
        body.appendChild(el('div', { class: 'gx-share-hero' }, thumbNode(b, 'is-share'),
          el('div', null, el('strong', null, b.meta.name), el('div', { class: 'cb-hint' }, describe(b).headline), quickStats(bd))));

        // link
        var urlIn = el('input', { type: 'text', class: 'gx-text-input is-mono', readonly: true, value: url, 'aria-label': 'Share link' });
        urlIn.addEventListener('focus', function () { urlIn.select(); });
        var linkRow = el('div', { class: 'gx-copy-row' }, urlIn,
          btn('Copy link', { icon: 'link', kind: 'primary', onClick: function () { copyWithFeedback(url, 'Link', urlIn); } }));
        var extra = el('div', { class: 'gx-share-extra' },
          btn('Copy code only', { icon: 'copy', kind: 'ghost', onClick: function () { copyWithFeedback(code, 'Share code', urlIn); } }),
          el('a', { class: 'cb-btn ghost gx-btn', href: url, target: '_blank', rel: 'noopener' }, el('span', { class: 'gx-btn-icon', html: IC.open }), el('span', { class: 'gx-btn-label' }, 'Open in new tab')),
          typeof navigator !== 'undefined' && navigator.share ? btn('Share…', { icon: 'share', kind: 'ghost', onClick: function () {
            navigator.share({ title: b.meta.name + ' — Redline', text: textSummary(b), url: /^https?:/i.test(url) ? url : undefined }).catch(function () { /* cancelled */ });
          } }) : null);
        body.appendChild(el('section', { class: 'gx-share-sec' }, el('h4', null, 'Share link'), linkRow, extra,
          el('p', { class: 'cb-hint' }, 'Code: ' + U.fmtNum(code.length) + ' characters · only the differences from the default car are encoded.' +
            (isFile ? ' You are running from a local file, so this link points at this computer — host the game (any static server) to share it with others, or send the code / JSON instead.' : ''))));

        // summary
        var ta = el('textarea', { class: 'gx-textarea is-mono', rows: '9', readonly: true, 'aria-label': 'Build summary' });
        var seg = el('div', { class: 'gx-seg', role: 'tablist' });
        function setFmt(m) {
          fmtMode = m;
          ta.value = textSummary(b, { markdown: m === 'md', url: url });
          Array.prototype.forEach.call(seg.children, function (n) { var on = n.dataset.m === m; n.classList.toggle('is-active', on); n.setAttribute('aria-selected', on ? 'true' : 'false'); });
        }
        [['plain', 'Plain text'], ['md', 'Markdown']].forEach(function (o) {
          var sbtn = el('button', { type: 'button', class: 'gx-seg-btn', role: 'tab', dataset: { m: o[0] } }, o[1]);
          sbtn.addEventListener('click', function () { setFmt(o[0]); });
          seg.appendChild(sbtn);
        });
        setFmt('plain');
        body.appendChild(el('section', { class: 'gx-share-sec' },
          el('div', { class: 'gx-section-head' }, el('h4', null, 'Summary'), seg),
          ta, el('div', { class: 'gx-share-extra' }, btn('Copy summary', { icon: 'text', kind: 'ghost', onClick: function () { copyWithFeedback(ta.value, 'Summary', ta); } }))));

        // json
        body.appendChild(el('section', { class: 'gx-share-sec' },
          el('h4', null, 'JSON file'),
          el('p', { class: 'cb-hint' }, 'Full, human-readable build file (' + U.fmtNum(json.length / 1024, 1) + ' KB). Re-import it here or in any copy of Redline.'),
          el('div', { class: 'gx-share-extra' },
            btn('Download .json', { icon: 'download', kind: 'ghost', onClick: function () { exportJSON(b); } }),
            btn('Copy JSON', { icon: 'copy', kind: 'ghost', onClick: function () { copyWithFeedback(json, 'JSON'); } }),
            btn('Import…', { icon: 'upload', kind: 'ghost', onClick: function () { openImport(); } }))));
        void fmtMode;
      },
      actions: [{ label: 'Close', kind: 'ghost' }]
    });
  }

  function exportJSON(build) {
    var b = build || current();
    var json = S().exportJSON ? S().exportJSON(b) : JSON.stringify(b, null, 2);
    var ok = download(fileSlug(b.meta.name) + '.redline.json', json, 'application/json');
    if (ok) toast('Exported “' + b.meta.name + '”', 'success', { duration: 2000 });
    else { toast('Download blocked — opening the JSON so you can copy it.', 'warning'); openShare(b); }
    return ok;
  }
  function exportGarage() {
    var bk = garageBackup();
    if (!bk.count) { toast('No saved builds yet — nothing to back up.', 'info'); return false; }
    var d = new Date();
    var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var ok = download('redline-saved-builds-' + stamp + '.json', JSON.stringify(bk, null, 2), 'application/json');
    if (ok) toast('Backed up ' + plural(bk.count, 'build'), 'success');
    return ok;
  }

  /* ======================================================================
     IMPORT
     ====================================================================== */
  function importJSON() { return openImport({ pickFile: true }); }

  function importToGarage(builds) {
    var existing = list(), added = 0, updated = 0, skipped = 0;
    builds.forEach(function (b) {
      var same = existing.filter(function (e) { return e.id === b.meta.id; })[0];
      if (same && sameBuild(same.build, b) && same.name === b.meta.name) { skipped++; return; }
      if (same) { b = U.set(b, 'meta.id', U.uid('b')); }
      S().saveLocal(b);
      if (same) updated++; else added++;
    });
    emitChange('import');
    var parts = [];
    if (added) parts.push(plural(added, 'build') + ' added');
    if (updated) parts.push(updated + ' imported as copies');
    if (skipped) parts.push(skipped + ' already saved');
    toast(parts.join(' · ') || 'Nothing imported', added || updated ? 'success' : 'info');
    return { added: added, updated: updated, skipped: skipped };
  }

  function openImport(opts) {
    opts = opts || {};
    var api = modal('import', {
      title: 'Import a build', subtitle: 'Drop a .json file, choose one, or paste a share link, share code or JSON.',
      size: 'lg',
      content: function (body) {
        var file = el('input', { type: 'file', accept: '.json,application/json,text/plain', class: 'gx-file', 'aria-label': 'Choose a build file' });
        var drop = el('div', { class: 'gx-drop', tabindex: '0', role: 'button', 'aria-label': 'Drop a build file here or press Enter to choose one' },
          el('div', { class: 'gx-drop-icon', html: IC.upload.replace(/width="16" height="16"/, 'width="34" height="34"') }),
          el('strong', null, 'Drop a Redline build or saved-builds backup'),
          el('span', { class: 'cb-hint' }, '.redline.json · .forge.json · saved-builds backup · any build JSON'),
          btn('Choose file…', { icon: 'doc', kind: 'ghost', onClick: function () { file.click(); } }), file);
        var ta = el('textarea', { class: 'gx-textarea is-mono', rows: '5', placeholder: 'Paste a link (…#b=v1.…), a share code or JSON here', 'aria-label': 'Paste build data' });
        var preview = el('div', { class: 'gx-import-preview', 'aria-live': 'polite' });
        body.appendChild(drop);
        body.appendChild(el('div', { class: 'gx-or' }, el('span', null, 'or paste')));
        body.appendChild(ta);
        body.appendChild(preview);

        function show(res, source) {
          U.clear(preview);
          if (!res) return;
          if (!res.ok) { preview.appendChild(el('div', { class: 'gx-import-error' }, el('span', { html: IC.close }), res.error)); return; }
          var bs = res.builds;
          var head = res.kind === 'garage' ? 'Saved-builds backup · ' + plural(bs.length, 'build') : res.kind === 'share' ? 'Shared build' : 'Build file';
          preview.appendChild(el('div', { class: 'gx-import-head' }, el('span', { class: 'gx-tag is-good' }, head), source ? el('span', { class: 'cb-hint' }, source) : null));
          var listEl = el('div', { class: 'gx-import-list' });
          bs.slice(0, 6).forEach(function (b) {
            var bd = compute(b), errs = countSev(bd, 'error');
            listEl.appendChild(el('div', { class: 'gx-import-item' }, thumbNode(b, 'is-small'),
              el('div', { class: 'gx-import-text' }, el('strong', null, b.meta.name), el('span', { class: 'cb-hint' }, describe(b).headline), quickStats(bd),
                errs ? el('span', { class: 'gx-tag is-bad' }, plural(errs, 'error')) : null)));
          });
          if (bs.length > 6) listEl.appendChild(el('div', { class: 'cb-hint' }, '…and ' + (bs.length - 6) + ' more'));
          preview.appendChild(listEl);
          var acts = el('div', { class: 'gx-share-extra' });
          if (bs.length === 1) {
            var one = U.set(bs[0], 'meta.id', U.uid('b'));
            acts.appendChild(btn('Load into Garage', { icon: 'load', kind: 'primary', onClick: function () { applyBuild(one, 'Import “' + one.meta.name + '”', { closeKinds: ['import', 'share'] }); } }));
            acts.appendChild(btn('Save build', { icon: 'save', kind: 'ghost', onClick: function () { importToGarage([one]); } }));
            acts.appendChild(btn('Compare with current', { icon: 'compare', kind: 'ghost', onClick: function () { openCompare(['current', one]); } }));
          } else {
            acts.appendChild(btn('Import ' + plural(bs.length, 'build') + ' to Saved builds', { icon: 'download', kind: 'primary', onClick: function () { importToGarage(bs); if (api) api.close(); openSaved(); } }));
            acts.appendChild(btn('Load the first', { icon: 'load', kind: 'ghost', onClick: function () { applyBuild(U.set(bs[0], 'meta.id', U.uid('b')), 'Import “' + bs[0].meta.name + '”', { closeKinds: ['import'] }); } }));
          }
          preview.appendChild(acts);
        }
        function readFile(f) {
          if (!f) return;
          if (f.size > 5 * 1024 * 1024) { show({ ok: false, error: 'That file is larger than 5 MB — not a Redline build.' }); return; }
          var fr = new FileReader();
          fr.onload = function () { ta.value = ''; show(parseImport(String(fr.result || '')), f.name + ' · ' + U.fmtNum(f.size / 1024, 1) + ' KB'); };
          fr.onerror = function () { show({ ok: false, error: 'The file could not be read.' }); };
          fr.readAsText(f);
        }
        file.addEventListener('change', function () { readFile(file.files && file.files[0]); file.value = ''; });
        drop.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); file.click(); } });
        ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.add('is-over'); }); });
        ['dragleave', 'dragend'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('is-over'); }); });
        drop.addEventListener('drop', function (ev) {
          ev.preventDefault(); drop.classList.remove('is-over');
          var dt = ev.dataTransfer;
          if (dt && dt.files && dt.files.length) readFile(dt.files[0]);
          else if (dt) { var t = dt.getData('text'); if (t) { ta.value = t; show(parseImport(t), 'Dropped text'); } }
        });
        var onInput = U.debounce(function () { show(ta.value.trim() ? parseImport(ta.value) : null, 'Pasted'); }, 180);
        ta.addEventListener('input', onInput);
        if (opts.text) { ta.value = opts.text; show(parseImport(opts.text), 'Pasted'); }
        if (opts.pickFile) setTimeout(function () { try { drop.querySelector('.gx-btn').focus(); } catch (e) { /* ignore */ } }, 60);
      },
      actions: [{ label: 'Close', kind: 'ghost' }]
    });
    return api;
  }

  /* ======================================================================
     SPEC SHEET (print-ready)
     ====================================================================== */
  function openSpec(build) {
    var b = build || current();
    var isCurrent = !build || build === current();
    var charts = [];
    var sheet;
    var api = modal('spec', {
      title: 'Specification sheet', subtitle: 'Print it, save it as PDF, or download a standalone HTML copy.',
      size: 'xl',
      content: function (body) {
        sheet = buildSheet(b, isCurrent, charts);
        body.appendChild(el('div', { class: 'gx-spec-toolbar' },
          btn('Print / Save PDF', { icon: 'print', kind: 'primary', title: 'Ctrl/⌘ P', onClick: function () { printSheet(); } }),
          btn('Download HTML', { icon: 'download', kind: 'ghost', onClick: function () { downloadSheet(sheet, b); } }),
          btn('Copy as text', { icon: 'text', kind: 'ghost', onClick: function () { copyWithFeedback(sheetText(b), 'Spec sheet'); } }),
          btn('Share', { icon: 'share', kind: 'ghost', onClick: function () { openShare(b); } })));
        body.appendChild(el('div', { class: 'gx-sheet-scroll' }, sheet));
      },
      onClose: function () {
        if (hasDOM) document.documentElement.classList.remove('gx-print-spec');
        charts.forEach(function (c) { safe(function () { c.destroy(); }); });
      },
      actions: [{ label: 'Close', kind: 'ghost' }]
    });
    if (api && api.el) { api.el.classList.add('gx-print-target'); document.documentElement.classList.add('gx-print-spec'); }
    return api;
  }
  function printSheet() {
    if (!hasDOM) return;
    document.documentElement.classList.add('gx-print-spec');
    if (CB.charts && CB.charts.redrawAll) safe(function () { CB.charts.redrawAll(); });
    setTimeout(function () { try { window.print(); } catch (e) { toast('Printing is not available here.', 'error'); } }, 60);
  }

  function sheetText(b) {
    var lines = ['REDLINE GARAGE — SPECIFICATION SHEET', b.meta.name, describe(b).headline, ''];
    specSections(b).forEach(function (s) {
      lines.push(s.title.toUpperCase());
      s.rows.forEach(function (r) { lines.push('  ' + r.label + ': ' + r.value); });
      lines.push('');
    });
    var bd = compute(b), p = bd.pricing;
    if (p) {
      lines.push('PRICE');
      (p.lines || []).forEach(function (l) { if (l.amount) lines.push('  ' + l.label + ': ' + U.fmtMoney(l.amount)); });
      lines.push('  Total: ' + money(priceOf(bd)));
    }
    lines.push('', shareURLFor(b));
    return lines.join('\n');
  }

  function buildSheet(b, isCurrent, charts) {
    var bd = compute(b), m = bd.metrics, p = bd.pricing, d = describe(b);
    var total = priceOf(bd);
    var sheet = el('article', { class: 'gx-sheet', 'aria-label': 'Specification sheet for ' + b.meta.name });
    var today = fmtDate(Date.now());
    sheet.appendChild(el('header', { class: 'gx-sheet-mast' },
      el('div', { class: 'gx-sheet-brand' }, el('span', { class: 'gx-sheet-mark' }, 'REDLINE'), el('span', { class: 'gx-sheet-sub' }, 'Garage · Bespoke specification')),
      el('div', { class: 'gx-sheet-ref' }, el('div', null, 'Issued ' + today), el('div', null, 'Ref. ' + String(b.meta.id || '').toUpperCase().slice(-10)))));

    // hero
    var art = null;
    if (isCurrent && CB.render && typeof CB.render.snapshotSVG === 'function') {
      var snap = safe(function () { /* spec sheet hero is always the clean side-on beauty shot, whatever the studio is showing */ return CB.render.snapshotSVG({ view: 'side', xray: false }); }, null, 'render.snapshotSVG');
      if (typeof snap === 'string' && snap.indexOf('<svg') >= 0) { art = el('div', { class: 'gx-sheet-art is-snapshot' }); art.innerHTML = snap; }
    }
    if (!art) art = el('div', { class: 'gx-sheet-art', html: thumbnail(b) });
    var leg = bd.legality;
    sheet.appendChild(el('section', { class: 'gx-sheet-hero' }, art,
      el('div', { class: 'gx-sheet-title' },
        el('h1', null, b.meta.name),
        el('p', { class: 'gx-sheet-headline' }, d.headline.charAt(0).toUpperCase() + d.headline.slice(1)),
        el('p', { class: 'gx-sheet-engine' }, d.engine),
        el('div', { class: 'gx-sheet-price' }, el('span', null, 'As specified'), el('strong', null, total == null ? '—' : money(total))),
        leg ? el('span', { class: 'gx-sheet-badge ' + (leg.streetLegal ? 'is-good' : 'is-warn') }, leg.streetLegal ? 'Road legal as configured' : 'Not road legal — track use') : null)));

    // KPIs
    if (m) {
      var k = [
        ['Power', fmt(m.power_hp), 'hp'], ['Torque', fmt(m.torque_nm), 'Nm'], ['0–100 km/h', fmt(m.zeroTo100_s, 2), 's'], ['0–60 mph', fmt(m.zeroTo60_s, 2), 's'],
        ['Top speed', fmt(m.topSpeed_kph), 'km/h'], ['Weight', fmt(m.weight_kg), 'kg'], ['Power/weight', fmt(m.powerToWeight_hpPerTon), 'hp/t'], ['Redline Ring', fmtLap(m.lapTime_s), '']
      ];
      sheet.appendChild(el('section', { class: 'gx-sheet-kpis' }, k.map(function (x) {
        return el('div', { class: 'gx-sheet-kpi' }, el('span', { class: 'gx-sheet-kpi-v' }, x[1], x[2] ? el('small', null, ' ' + x[2]) : null), el('span', { class: 'gx-sheet-kpi-l' }, x[0]));
      })));
    }

    // specification tables
    var secs = specSections(b, bd);
    var cols = el('section', { class: 'gx-sheet-cols' });
    secs.forEach(function (s) {
      cols.appendChild(el('div', { class: 'gx-sheet-sec' },
        el('h4', null, s.title),
        el('table', null, el('tbody', null, s.rows.map(function (r) {
          return el('tr', null, el('th', { scope: 'row' }, r.label), el('td', null, r.color ? el('span', { class: 'gx-swatch-dot', style: { background: r.color } }) : null, r.value));
        })))));
    });
    sheet.appendChild(cols);

    // charts + ratings
    if (m) {
      var chartRow = el('section', { class: 'gx-sheet-charts' });
      var dyno = el('canvas', { role: 'img', 'aria-label': 'Dyno chart' }), accel = el('canvas', { role: 'img', 'aria-label': 'Acceleration chart' });
      chartRow.appendChild(el('figure', null, el('figcaption', null, 'Power & torque'), el('div', { class: 'cb-chart gx-chart' }, dyno)));
      chartRow.appendChild(el('figure', null, el('figcaption', null, 'Acceleration'), el('div', { class: 'cb-chart gx-chart' }, accel)));
      var ratings = m.ratings || {};
      chartRow.appendChild(el('figure', { class: 'gx-sheet-ratings' }, el('figcaption', null, 'Ratings'),
        el('div', null, RATING_KEYS.map(function (key) {
          var v = num(ratings[key], 0);
          return el('div', { class: 'gx-rating' }, el('span', { class: 'gx-rating-l' }, titleCase(key)), el('span', { class: 'gx-rating-bar' }, el('span', { style: { width: clamp(v, 0, 100) + '%' } })), el('span', { class: 'gx-rating-v' }, fmt(v)));
        }))));
      sheet.appendChild(chartRow);
      if (CB.charts) {
        requestAnimationFrame(function () {
          if (typeof CB.charts.dyno === 'function') { var c1 = safe(function () { return CB.charts.dyno(dyno, m, null, { height: 210 }); }, null, 'spec dyno'); if (c1) charts.push(c1); }
          if (typeof CB.charts.accel === 'function') { var c2 = safe(function () { return CB.charts.accel(accel, m, null, { height: 210 }); }, null, 'spec accel'); if (c2) charts.push(c2); }
        });
      }
    }

    // pricing
    if (p) {
      var bySec = {}, order = [];
      (p.lines || []).forEach(function (l) {
        if (!l || !l.amount) return;
        var s = l.section || 'other';
        if (!bySec[s]) { bySec[s] = []; order.push(s); }
        bySec[s].push(l);
      });
      var tb = el('tbody');
      order.forEach(function (s) {
        var sum = bySec[s].reduce(function (a, l) { return a + num(l.amount); }, 0);
        tb.appendChild(el('tr', { class: 'gx-price-group' }, el('th', { scope: 'rowgroup' }, (CB.panels && CB.panels[s] && CB.panels[s].title) || titleCase(s)), el('td', null, U.fmtMoney(sum))));
        bySec[s].forEach(function (l) { tb.appendChild(el('tr', null, el('th', { scope: 'row', class: 'is-sub' }, l.label), el('td', null, U.fmtMoney(l.amount, { sign: l.amount < 0 })))); });
      });
      var foot = el('tfoot');
      [['Subtotal', p.subtotal], ['Destination', p.destination], ['Gas-guzzler tax', p.gasGuzzlerTax], ['Luxury tax', p.luxuryTax], ['EV credit', p.evCredit && -Math.abs(p.evCredit)]].forEach(function (r) {
        if (isNum(r[1]) && r[1] !== 0) foot.appendChild(el('tr', null, el('th', { scope: 'row' }, r[0]), el('td', null, U.fmtMoney(r[1], { sign: r[1] < 0 }))));
      });
      foot.appendChild(el('tr', { class: 'gx-price-total' }, el('th', { scope: 'row' }, 'Total'), el('td', null, money(total))));
      var fin = financeOf(total);
      var finBox = null;
      if (fin && fin.finance) {
        var st = fin.settings || {};
        finBox = el('div', { class: 'gx-sheet-finance' },
          el('h4', null, 'Finance example'),
          el('div', { class: 'gx-sheet-fin-v' }, money(fin.finance.monthly), el('small', null, ' / month')),
          el('p', null, (st.months || 60) + ' months · ' + (isNum(st.apr) ? U.fmtNum(st.apr, 1) + ' % APR' : '') + (isNum(st.down) && st.down ? ' · ' + U.fmtMoney(st.down) + ' down' : '')),
          isNum(fin.finance.totalInterest) ? el('p', null, 'Total interest ' + U.fmtMoney(fin.finance.totalInterest)) : null,
          fin.lease && isNum(fin.lease.monthly) ? el('p', null, 'Lease from ' + U.fmtMoney(fin.lease.monthly) + ' / month') : null,
          isNum(p.buildTime_weeks) ? el('p', null, 'Hand-built in ' + p.buildTime_weeks + ' weeks') : null,
          isNum(p.insuranceGroup) ? el('p', null, 'Insurance group ' + p.insuranceGroup + ' / 50') : null);
      }
      sheet.appendChild(el('section', { class: 'gx-sheet-pricing' },
        el('div', { class: 'gx-sheet-sec' }, el('h4', null, 'Pricing'), el('table', { class: 'gx-price-table' }, tb, foot)), finBox));
    }

    // compliance
    var issues = (bd.issues || []).filter(function (i) { return i && i.severity !== 'info'; });
    if (issues.length || (leg && leg.reasons && leg.reasons.length)) {
      sheet.appendChild(el('section', { class: 'gx-sheet-sec gx-sheet-issues' },
        el('h4', null, 'Engineering notes'),
        el('ul', null, issues.slice(0, 14).map(function (i) { return el('li', { class: 'is-' + i.severity }, el('strong', null, i.severity === 'error' ? 'Error' : 'Note'), ' ', i.message); }),
          leg && !leg.streetLegal ? (leg.reasons || []).slice(0, 6).map(function (r) { return el('li', { class: 'is-warning' }, el('strong', null, 'Legality'), ' ', typeof r === 'string' ? r : r.message); }) : null)));
    }
    sheet.appendChild(el('footer', { class: 'gx-sheet-foot' },
      el('p', null, 'Performance, economy and pricing figures are simulated estimates produced by the Redline Garage and are not guaranteed.'),
      el('p', { class: 'gx-sheet-code' }, 'Rebuild this exact car: ' + shareURLFor(b).replace(/^(.{0,110}).*$/, function (all, head) { return all.length > 110 ? head + '…' : all; }))));
    return sheet;
  }

  function downloadSheet(sheet, b) {
    if (!sheet) return;
    var clone = sheet.cloneNode(true);
    var srcC = sheet.querySelectorAll('canvas'), dstC = clone.querySelectorAll('canvas');
    for (var i = 0; i < dstC.length; i++) {
      var url = safe(function () { return srcC[i].toDataURL('image/png'); }, null);
      var img = document.createElement('img');
      if (url) { img.src = url; img.alt = srcC[i].getAttribute('aria-label') || ''; img.style.width = '100%'; }
      dstC[i].parentNode.replaceChild(img, dstC[i]);
    }
    var html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(b.meta.name) + ' — Redline specification</title>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + SHEET_CSS + '\nbody{margin:0;background:#e9e6df;padding:24px}.gx-sheet{margin:0 auto}@media print{body{background:#fff;padding:0}}</style></head><body>' +
      clone.outerHTML + '</body></html>';
    var ok = download(fileSlug(b.meta.name) + '-spec.html', html, 'text/html');
    if (ok) toast('Spec sheet downloaded', 'success', { duration: 2000 });
  }

  /* ======================================================================
     STYLES (injected once; theme-aware through the contract CSS variables)
     ====================================================================== */
  var SHEET_CSS = [
    '.gx-sheet{--bg:#ffffff;--bg-2:#f6f4ef;--panel:#ffffff;--panel-2:#f3f0e9;--line:#d8d3c8;--text:#16181b;--text-dim:#62666d;--accent:#9a6b2f;--accent-2:#2a5d9f;--good:#1f8a4c;--warn:#b7791f;--bad:#c0392b;',
    'box-sizing:border-box;width:min(210mm,100%);margin:0 auto;padding:14mm 13mm 10mm;background:#fff;color:#16181b;font:13px/1.45 Inter,"SF Pro Display","Segoe UI",system-ui,-apple-system,sans-serif;border-radius:4px;box-shadow:0 18px 50px rgba(0,0,0,.35)}',
    '.gx-sheet *{box-sizing:border-box}',
    '.gx-sheet-mast{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #16181b;padding-bottom:8px;margin-bottom:14px}',
    '.gx-sheet-mark{font-weight:800;letter-spacing:.42em;font-size:22px}',
    '.gx-sheet-sub{display:block;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:#62666d;margin-top:2px}',
    '.gx-sheet-ref{text-align:right;font:11px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:#62666d}',
    '.gx-sheet-hero{display:grid;grid-template-columns:1.25fr 1fr;gap:18px;align-items:center;margin-bottom:12px}',
    '.gx-sheet-art{background:radial-gradient(120% 90% at 50% 85%,#efece5 0,#fff 70%);border:1px solid #ece8df;border-radius:6px;padding:8px;min-height:150px;display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '.gx-sheet-art svg{width:100%;height:auto;max-height:230px;display:block}',
    '.gx-sheet-title h1{font-size:28px;line-height:1.1;margin:0 0 6px;font-weight:750;letter-spacing:-.01em}',
    '.gx-sheet-headline{margin:0 0 4px;font-size:13.5px;color:#30343a}',
    '.gx-sheet-engine{margin:0 0 12px;font-size:12px;color:#62666d}',
    '.gx-sheet-price span{display:block;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#62666d}',
    '.gx-sheet-price strong{font-size:26px;font-variant-numeric:tabular-nums;font-weight:750}',
    '.gx-sheet-badge{display:inline-block;margin-top:8px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid currentColor}',
    '.gx-sheet-badge.is-good{color:#1f8a4c}.gx-sheet-badge.is-warn{color:#b7791f}',
    '.gx-sheet-kpis{display:grid;grid-template-columns:repeat(8,1fr);border:1px solid #d8d3c8;border-radius:6px;margin:6px 0 16px;overflow:hidden}',
    '.gx-sheet-kpi{padding:8px 8px 7px;border-right:1px solid #e6e1d7;display:flex;flex-direction:column;gap:2px}',
    '.gx-sheet-kpi:last-child{border-right:0}',
    '.gx-sheet-kpi-v{font:700 16px/1.1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}',
    '.gx-sheet-kpi-v small{font-size:10px;font-weight:500;color:#62666d}',
    '.gx-sheet-kpi-l{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#62666d}',
    '.gx-sheet-cols{column-count:2;column-gap:20px}',
    '.gx-sheet-sec{break-inside:avoid;page-break-inside:avoid;margin:0 0 12px}',
    '.gx-sheet-sec h4{margin:0 0 4px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#9a6b2f;border-bottom:1px solid #d8d3c8;padding-bottom:3px}',
    '.gx-sheet table{width:100%;border-collapse:collapse}',
    '.gx-sheet th,.gx-sheet td{padding:2.5px 0;vertical-align:top;font-size:11.5px;border-bottom:1px dotted #e3ded3;text-align:left}',
    '.gx-sheet th{font-weight:500;color:#62666d;width:44%;padding-right:8px}',
    '.gx-sheet td{font-variant-numeric:tabular-nums}',
    '.gx-sheet .gx-swatch-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px;border:1px solid rgba(0,0,0,.25)}',
    '.gx-sheet-charts{display:grid;grid-template-columns:1fr 1fr .85fr;gap:14px;margin:4px 0 14px;break-inside:avoid;page-break-inside:avoid}',
    '.gx-sheet-charts figure{margin:0;border:1px solid #e3ded3;border-radius:6px;padding:8px}',
    '.gx-sheet-charts figcaption{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#62666d;margin-bottom:4px}',
    '.gx-sheet-charts canvas,.gx-sheet-charts img{display:block;width:100%}',
    '.gx-rating{display:grid;grid-template-columns:78px 1fr 24px;gap:6px;align-items:center;font-size:10.5px;margin:3px 0}',
    '.gx-rating-l{color:#62666d}.gx-rating-v{text-align:right;font-family:ui-monospace,Menlo,monospace}',
    '.gx-rating-bar{height:6px;background:#efebe3;border-radius:3px;overflow:hidden}',
    '.gx-rating-bar span{display:block;height:100%;background:linear-gradient(90deg,#9a6b2f,#c9a45c);border-radius:3px}',
    '.gx-sheet-pricing{display:grid;grid-template-columns:1.6fr 1fr;gap:18px;break-inside:avoid;page-break-inside:avoid}',
    '.gx-price-table th.is-sub{padding-left:12px;color:#7a7e85;font-weight:400}',
    '.gx-price-table td{text-align:right}',
    '.gx-price-group th,.gx-price-group td{font-weight:650;color:#16181b;border-bottom:1px solid #d8d3c8;padding-top:5px}',
    '.gx-price-table tfoot th,.gx-price-table tfoot td{border-bottom:0;padding-top:4px}',
    '.gx-price-total th,.gx-price-total td{font-size:14px;font-weight:800;color:#16181b;border-top:2px solid #16181b;padding-top:6px}',
    '.gx-sheet-finance{border:1px solid #d8d3c8;border-radius:6px;padding:10px 12px;align-self:start;background:#faf8f4}',
    '.gx-sheet-finance h4{margin:0 0 4px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#9a6b2f}',
    '.gx-sheet-fin-v{font:750 22px/1.2 ui-monospace,Menlo,monospace}.gx-sheet-fin-v small{font-size:11px;color:#62666d}',
    '.gx-sheet-finance p{margin:3px 0;font-size:11px;color:#3c4046}',
    '.gx-sheet-issues ul{margin:4px 0 0;padding-left:16px;columns:2;column-gap:20px}',
    '.gx-sheet-issues li{font-size:11px;margin:2px 0;break-inside:avoid}',
    '.gx-sheet-issues li.is-error strong{color:#c0392b}.gx-sheet-issues li.is-warning strong{color:#b7791f}',
    '.gx-sheet-foot{margin-top:14px;border-top:1px solid #d8d3c8;padding-top:6px;font-size:9.5px;color:#7a7e85}',
    '.gx-sheet-foot p{margin:2px 0}.gx-sheet-code{font-family:ui-monospace,Menlo,monospace;word-break:break-all}',
    '@media (max-width:760px){.gx-sheet{padding:18px}.gx-sheet-hero,.gx-sheet-pricing,.gx-sheet-charts{grid-template-columns:1fr}.gx-sheet-kpis{grid-template-columns:repeat(4,1fr)}.gx-sheet-cols{column-count:1}}',
    '@media (max-width:480px){.gx-sheet-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.gx-sheet-kpi{min-width:0;border-bottom:1px solid #e6e1d7}.gx-sheet-kpi-v,.gx-sheet-kpi-l{overflow-wrap:anywhere}}'
  ].join('\n');

  var GARAGE_CSS = [
    '.gx-modal{--gx-slot-0:var(--accent);--gx-slot-1:var(--accent-2);--gx-slot-2:#b48cff;--gx-r:var(--radius)}',
    '.cb-modal-card.gx-modal.is-xl{width:min(1260px,calc(100vw - 28px));max-width:none}',
    '.cb-modal-card.gx-modal.is-lg{width:min(860px,calc(100vw - 28px));max-width:none}',
    '.gx-modal .cb-modal-body{max-height:calc(100vh - 190px);max-height:calc(100dvh - 190px);overflow:auto}',
    '.gx-btn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
    '.gx-btn-icon{display:inline-flex;line-height:0}',
    '.gx-btn.icon-btn{padding-left:8px;padding-right:8px}',
    '.gx-btn.danger:hover{color:var(--bad)}',
    '.gx-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 14px}',
    '.gx-spacer{flex:1 1 auto}',
    '.gx-count{font-size:var(--fs-sm);color:var(--text-dim);font-variant-numeric:tabular-nums}',
    '.gx-search{position:relative;display:inline-flex;align-items:center;min-width:220px;flex:0 1 300px}',
    '.gx-search-icon{position:absolute;left:10px;color:var(--text-dim);line-height:0;pointer-events:none}',
    '.gx-search-input,.gx-text-input,.gx-select,.gx-rename,.gx-textarea{font:inherit;color:var(--text);background:var(--bg-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 10px;outline:none;transition:border-color .15s,box-shadow .15s}',
    '.gx-search-input{width:100%;padding-left:32px}',
    '.gx-search-input:focus,.gx-text-input:focus,.gx-select:focus,.gx-rename:focus,.gx-textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}',
    '.gx-select.is-compact{padding:5px 8px;font-size:var(--fs-sm);max-width:240px}',
    '.gx-text-input{width:100%}.gx-text-input.is-mono,.gx-textarea.is-mono{font-family:var(--mono);font-size:var(--fs-sm)}',
    '.gx-textarea{width:100%;resize:vertical;min-height:90px;line-height:1.5}',
    '.gx-sort{display:inline-flex;align-items:center;gap:6px}',
    '.gx-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.gx-chip{font:inherit;font-size:var(--fs-sm);padding:4px 10px;border-radius:var(--pill);border:1px solid var(--line);background:transparent;color:var(--text-dim);cursor:pointer;transition:all .15s}',
    '.gx-chip:hover{color:var(--text);border-color:var(--text-dim)}',
    '.gx-chip.is-active{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent)}',
    '.gx-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}',
    '.gx-card{position:relative;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:var(--gx-r);overflow:hidden;transition:transform .18s ease,border-color .18s,box-shadow .18s;outline:none}',
    '.gx-card:hover,.gx-card:focus-visible{transform:translateY(-2px);border-color:color-mix(in srgb,var(--accent) 55%,var(--line));box-shadow:var(--elev-2)}',
    '.gx-card.is-current{border-color:var(--accent)}',
    '.gx-card.is-selected{box-shadow:0 0 0 2px var(--accent-2)}',
    '.gx-card-media{position:relative;aspect-ratio:16/8;background:radial-gradient(120% 100% at 50% 100%,color-mix(in srgb,var(--gx-paint,#888) 22%,var(--bg-2)) 0,var(--bg-2) 70%)}',
    '.gx-thumb-host{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}',
    '.gx-thumb{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:6px 10px}',
    '.gx-thumb svg{width:100%;height:100%;display:block;filter:drop-shadow(0 6px 10px rgba(0,0,0,.35))}',
    '.gx-thumb.is-small{width:120px;height:62px;flex:0 0 auto;padding:2px;border-radius:var(--radius-sm);background:radial-gradient(120% 100% at 50% 100%,color-mix(in srgb,var(--gx-paint,#888) 25%,var(--bg-2)) 0,var(--bg-2) 70%)}',
    '.gx-thumb.is-share{width:180px;height:92px;flex:0 0 auto;border-radius:var(--radius-sm);background:radial-gradient(120% 100% at 50% 100%,color-mix(in srgb,var(--gx-paint,#888) 25%,var(--bg-2)) 0,var(--bg-2) 70%)}',
    '.gx-thumb.is-compare{height:96px;border-radius:var(--radius-sm);background:radial-gradient(120% 100% at 50% 100%,color-mix(in srgb,var(--gx-paint,#888) 25%,var(--bg-2)) 0,var(--bg-2) 70%)}',
    '.gx-ribbon{position:absolute;top:10px;right:10px;font-size:var(--fs-2xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:var(--pill);background:var(--accent);color:var(--accent-ink)}',
    '.gx-ribbon.is-warn{background:var(--warn)}',
    '.gx-card-body{padding:12px 14px 6px;display:flex;flex-direction:column;gap:4px;flex:1 1 auto}',
    '.gx-card-title{margin:0;font-size:var(--fs-lg);font-weight:650;letter-spacing:.005em}',
    '.gx-card-tagline{margin:0;font-size:var(--fs-sm);line-height:1.45;color:var(--text-dim);min-height:3.6em}',
    '.gx-card-meta{margin:0;font-size:var(--fs-sm);color:var(--text);opacity:.9}.gx-card-meta.is-dim{color:var(--text-dim);opacity:1}',
    '.gx-card-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 12px;border-top:1px solid color-mix(in srgb,var(--line) 60%,transparent)}',
    '.gx-card-actions .gx-btn.primary{margin-right:auto}',
    '.gx-tags{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0}',
    '.gx-tag{font-size:var(--fs-2xs);font-weight:600;letter-spacing:.04em;padding:2px 7px;border-radius:var(--radius-xs);background:var(--panel-2);color:var(--text-dim);border:1px solid var(--line)}',
    '.gx-tag.is-warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}',
    '.gx-tag.is-bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,transparent)}',
    '.gx-tag.is-good{color:var(--good);border-color:color-mix(in srgb,var(--good) 45%,transparent)}',
    '.gx-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}',
    '.gx-stat{display:flex;flex-direction:column;padding:6px 6px 5px;border-radius:var(--radius-xs);background:var(--bg-2);min-width:0}',
    '.gx-stat.is-empty{grid-column:1/-1;font-size:var(--fs-sm);color:var(--text-dim);text-align:center}',
    // value + unit never truncate ("314 km/h", "1,931 hp"): the unit wraps under the number when the tile is narrow
    '.gx-stat-v{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:3px;font:650 var(--fs-sm)/1.2 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:0}',
    '.gx-stat-v small{font-size:var(--fs-2xs);font-weight:500;color:var(--text-dim);white-space:nowrap}',
    '.gx-stat-l{font-size:var(--fs-2xs);letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}',
    '.gx-skel{display:block;height:34px;border-radius:var(--radius-xs);background:linear-gradient(90deg,var(--bg-2),var(--panel-2),var(--bg-2));background-size:200% 100%;animation:gx-shimmer 1.2s linear infinite}',
    '@keyframes gx-shimmer{to{background-position:-200% 0}}',
    '.gx-empty,.gx-empty-inline{text-align:center;color:var(--text-dim)}',
    '.gx-empty{padding:40px 16px}.gx-empty h3{color:var(--text);margin:10px 0 4px}.gx-empty-art{color:var(--accent);opacity:.8}',
    '.gx-empty-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:14px}',
    '.gx-empty-inline{grid-column:1/-1;padding:28px 10px}',
    '.gx-current{display:flex;align-items:center;gap:14px;padding:10px 12px;margin:0 0 14px;border-radius:var(--gx-r);border:1px solid var(--line);background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 9%,var(--panel)),var(--panel))}',
    '.gx-current-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
    '.gx-current-text strong{font-size:var(--fs-lg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.gx-eyebrow{font-size:var(--fs-2xs);letter-spacing:var(--tracking-caps);text-transform:uppercase;font-weight:700;color:var(--accent)}',
    '.gx-current-state{font-size:var(--fs-sm)}.gx-current-state.is-warn{color:var(--warn)}.gx-current-state.is-good{color:var(--good)}.gx-current-state.is-dim{color:var(--text-dim)}',
    '.gx-current-actions{display:flex;gap:8px;flex-wrap:wrap}',
    '.gx-check-wrap{position:absolute;top:10px;left:10px;display:inline-flex;cursor:pointer}',
    '.gx-check{position:absolute;opacity:0;width:22px;height:22px;margin:0;cursor:pointer}',
    '.gx-check-box{width:22px;height:22px;border-radius:var(--radius-xs);border:1.5px solid color-mix(in srgb,var(--text) 55%,transparent);background:rgba(0,0,0,.35);display:inline-flex;align-items:center;justify-content:center;color:transparent;transition:all .15s}',
    '.gx-check:checked+.gx-check-box{background:var(--accent-2);border-color:var(--accent-2);color:var(--mode-ink)}',
    '.gx-check:focus-visible+.gx-check-box{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-2) 40%,transparent)}',
    '.gx-rename{width:100%;font-size:var(--fs-lg);font-weight:650;padding:3px 6px}',
    '.gx-field{display:flex;flex-direction:column;gap:6px}',
    '.gx-confirm-text{margin:0;line-height:1.5}',
    /* compare */
    '.gx-cmp-heads{display:grid;grid-template-columns:repeat(var(--gx-cols,2),minmax(0,1fr));gap:12px;margin-bottom:12px}',
    '.gx-cmp-head{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:var(--gx-r);background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--gx-c)}',
    '.is-slot-0{--gx-c:var(--gx-slot-0)}.is-slot-1{--gx-c:var(--gx-slot-1)}.is-slot-2{--gx-c:var(--gx-slot-2)}',
    '.gx-cmp-letter{position:absolute;top:10px;left:12px;width:24px;height:24px;border-radius:50%;background:var(--gx-c);color:var(--accent-ink);font-weight:800;font-size:var(--fs-sm);display:flex;align-items:center;justify-content:center;z-index:1}',
    '.gx-cmp-letter.is-inline{position:static;display:inline-flex;width:18px;height:18px;font-size:var(--fs-2xs);vertical-align:1px}',
    '.gx-cmp-head .gx-select{width:100%}',
    '.gx-cmp-sub{font-size:var(--fs-sm);color:var(--text-dim);min-height:2.6em}',
    '.gx-cmp-price{font:700 var(--fs-lg)/1.2 var(--mono);font-variant-numeric:tabular-nums}',
    '.gx-cmp-actions{display:flex;gap:6px;flex-wrap:wrap}',
    '.gx-verdict{display:grid;grid-template-columns:1fr minmax(220px,340px);gap:16px;align-items:center;padding:10px 14px;border-radius:var(--gx-r);background:var(--panel-2);margin-bottom:16px}',
    '.gx-verdict-text{font-size:var(--fs-md)}',
    '.gx-verdict-bar{display:grid;grid-template-columns:18px 1fr 26px;gap:8px;align-items:center;margin:3px 0;font-size:var(--fs-xs)}',
    '.gx-verdict-letter{font-weight:800;color:var(--gx-c)}',
    '.gx-verdict-fill{display:block;height:8px;border-radius:4px;background:var(--gx-c);min-width:2px;transition:width .4s ease}',
    '.gx-verdict-n{text-align:right;font-family:var(--mono)}',
    '.gx-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:6px 0 10px}',
    '.gx-section-head h3,.gx-section-head h4{margin:0;font-size:var(--fs-sm);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-dim)}',
    '.gx-overlay-pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.gx-cmp-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin-bottom:18px}',
    '.gx-chart-card{margin:0;padding:10px 12px;border-radius:var(--gx-r);background:var(--panel);border:1px solid var(--line)}',
    '.gx-chart-card figcaption{font-size:var(--fs-xs);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-dim);margin-bottom:6px}',
    '.gx-chart{position:relative;min-height:200px}.gx-chart canvas{display:block;width:100%}',
    '.gx-chart-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:var(--fs-sm);color:var(--text-dim)}',
    '.gx-cmp-table-host{overflow-x:auto;border-radius:var(--gx-r);border:1px solid var(--line)}',
    '.gx-cmp-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm);font-variant-numeric:tabular-nums}',
    '.gx-cmp-table thead th{position:sticky;top:0;z-index:1;background:var(--panel-2);text-align:left;padding:9px 10px;font-weight:650;border-bottom:1px solid var(--line);border-top:3px solid var(--gx-c,transparent)}',
    '.gx-cmp-table thead th.gx-cmp-metric{border-top-color:transparent}',
    '.gx-cmp-group th{text-align:left;padding:12px 10px 5px;font-size:var(--fs-2xs);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--accent);background:var(--panel)}',
    '.gx-cmp-table tbody th.gx-cmp-metric{text-align:left;font-weight:500;color:var(--text-dim);padding:6px 10px;white-space:nowrap;width:22%}',
    '.gx-cmp-table tbody th small{opacity:.75}',
    '.gx-better{margin-left:6px;font-size:var(--fs-2xs);opacity:.6}',
    '.gx-cmp-table td{padding:6px 10px;border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent);position:relative}',
    '.gx-cmp-table tr.is-same td{color:color-mix(in srgb,var(--text) 70%,transparent)}',
    '.gx-cell-v{font-family:var(--mono)}',
    '.gx-cmp-table td.gx-best{background:color-mix(in srgb,var(--good) 16%,transparent);box-shadow:inset 3px 0 0 var(--good)}',
    '.gx-cmp-table td.gx-best .gx-cell-v{font-weight:750;color:var(--good)}',
    '.gx-cmp-table td.gx-worst .gx-cell-v{color:color-mix(in srgb,var(--bad) 80%,var(--text))}',
    '.gx-cmp-table td.gx-changed{background:color-mix(in srgb,var(--accent-2) 10%,transparent)}',
    '.gx-delta{margin-left:8px;font-size:var(--fs-xs);font-family:var(--mono);color:var(--text-dim)}',
    '.gx-delta.is-good{color:var(--good)}.gx-delta.is-bad{color:var(--bad)}',
    '.gx-cell-bar{display:block;height:3px;margin-top:4px;border-radius:2px;background:var(--bg-2);overflow:hidden;max-width:160px}',
    '.gx-cell-bar span{display:block;height:100%;background:var(--gx-c,var(--accent))}',
    '.gx-swatch-dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:-1px;border:1px solid rgba(255,255,255,.25)}',
    '.gx-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--fs-sm);user-select:none}',
    '.gx-toggle input{position:absolute;opacity:0;width:1px;height:1px}',
    '.gx-toggle-track{width:34px;height:20px;border-radius:var(--pill);background:var(--line);position:relative;transition:background .15s}',
    '.gx-toggle-track:after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--text);transition:transform .15s}',
    '.gx-toggle input:checked+.gx-toggle-track{background:var(--accent)}',
    '.gx-toggle input:checked+.gx-toggle-track:after{transform:translateX(14px);background:var(--accent-ink)}',
    '.gx-toggle input:focus-visible+.gx-toggle-track{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}',
    /* share / import */
    '.gx-share-hero{display:flex;gap:16px;align-items:center;margin-bottom:12px}.gx-share-hero>div:last-child{flex:1 1 auto;min-width:0}',
    '.gx-share-sec{padding:12px 0;border-top:1px solid color-mix(in srgb,var(--line) 70%,transparent)}',
    '.gx-share-sec h4{margin:0 0 8px;font-size:var(--fs-sm);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-dim)}',
    '.gx-copy-row{display:flex;gap:8px}.gx-copy-row .gx-text-input{flex:1 1 auto;min-width:0}',
    '.gx-share-extra{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}',
    '.gx-seg{display:inline-flex;gap:2px;padding:3px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--radius)}',
    '.gx-seg-btn{font:inherit;font-size:var(--fs-sm);font-weight:650;min-height:28px;padding:0 10px;background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--text-dim);cursor:pointer}.gx-seg-btn:hover:not(.is-active){color:var(--text);background:var(--panel-2)}.gx-seg-btn:focus-visible{outline:none;box-shadow:var(--focus)}',
    '.gx-seg-btn.is-active{color:var(--text-strong);background:linear-gradient(180deg,var(--panel-3),var(--panel-2));border-color:var(--line)}',
    '.gx-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px;border:1.5px dashed var(--line);border-radius:var(--gx-r);text-align:center;transition:all .15s;outline:none}',
    '.gx-drop:focus-visible,.gx-drop.is-over{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}',
    '.gx-drop-icon{color:var(--accent)}.gx-file{display:none}',
    '.gx-or{display:flex;align-items:center;gap:10px;margin:12px 0;color:var(--text-dim);font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.14em}',
    '.gx-or:before,.gx-or:after{content:"";flex:1;height:1px;background:var(--line)}',
    '.gx-import-preview{margin-top:12px}',
    '.gx-import-error{display:flex;gap:8px;align-items:center;color:var(--bad);font-size:var(--fs-sm);padding:8px 10px;border-radius:var(--radius-sm);background:color-mix(in srgb,var(--bad) 10%,transparent)}',
    '.gx-import-head{display:flex;gap:10px;align-items:center;margin-bottom:8px}',
    '.gx-import-list{display:flex;flex-direction:column;gap:8px}',
    '.gx-import-item{display:flex;gap:12px;align-items:center;padding:8px;border-radius:var(--radius-sm);background:var(--panel-2)}',
    '.gx-import-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}',
    /* spec modal */
    '.gx-spec-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:-20px 0 14px;position:sticky;top:-20px;z-index:2;padding:24px 0 8px;background:var(--panel)}',
    '.gx-sheet-scroll{padding:6px 0 18px;background:repeating-linear-gradient(45deg,transparent 0 10px,rgba(127,127,127,.04) 10px 20px);border-radius:var(--radius-sm)}',
    '@media (max-width:720px){.gx-verdict{grid-template-columns:1fr}.gx-cmp-heads{grid-template-columns:1fr}.gx-current{flex-wrap:wrap}.gx-search{flex:1 1 100%}}',
    '@media (prefers-reduced-motion:reduce){.gx-card,.gx-verdict-fill,.gx-skel{transition:none;animation:none}}',
    /* print: only the spec sheet */
    '@media print{',
    '  html.gx-print-spec,html.gx-print-spec body{overflow:visible!important;height:auto!important;background:#fff!important}',
    '  html.gx-print-spec body>*:not(#modal-root){display:none!important}',
    '  html.gx-print-spec #modal-root>*:not(.gx-print-target){display:none!important}',
    '  html.gx-print-spec .gx-print-target{position:static!important;inset:auto!important;display:block!important;padding:0!important;margin:0!important;background:none!important;backdrop-filter:none!important;overflow:visible!important;opacity:1!important}',
    '  html.gx-print-spec .gx-print-target .cb-modal-card{position:static!important;transform:none!important;width:auto!important;max-width:none!important;max-height:none!important;margin:0!important;box-shadow:none!important;border:0!important;background:#fff!important;overflow:visible!important;animation:none!important;opacity:1!important}',
    '  html.gx-print-spec .gx-print-target .cb-modal-head,html.gx-print-spec .gx-print-target .cb-modal-foot,html.gx-print-spec .gx-spec-toolbar{display:none!important}',
    '  html.gx-print-spec .gx-print-target .cb-modal-body,html.gx-print-spec .gx-sheet-scroll{overflow:visible!important;max-height:none!important;padding:0!important;background:none!important}',
    '  html.gx-print-spec .gx-sheet{box-shadow:none!important;width:auto!important;padding:0!important;border-radius:0!important}',
    '  @page{size:A4;margin:11mm}',
    '}'
  ].join('\n');

  var stylesDone = false;
  function ensureStyles() {
    if (stylesDone || !hasDOM) return;
    stylesDone = true;
    if (document.getElementById('cb-garage-styles')) return;
    var st = document.createElement('style');
    st.id = 'cb-garage-styles';
    st.textContent = GARAGE_CSS + '\n' + SHEET_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  if (hasDOM) {
    try {
      window.addEventListener('storage', function (ev) {
        if (!ev || !S() || !S().keys || ev.key === S().keys.garage) refreshOpen();
      });
      window.addEventListener('afterprint', function () { if (!openMods.spec) document.documentElement.classList.remove('gx-print-spec'); });
    } catch (e) { /* ignore */ }
  }

  /* ======================================================================
     PUBLIC API
     ====================================================================== */
  CB.garage = {
    version: VERSION,
    // modals
    open: openSaved, openSaved: openSaved, openPresets: openPresets, openCompare: openCompare,
    openShare: openShare, openImport: openImport, openSpec: openSpec,
    // garage operations
    save: save, saveAs: saveAs, load: load, loadPreset: loadPreset, remove: remove, rename: rename, duplicate: duplicate,
    list: list, isDirty: isDirty,
    // surprise
    surprise: surprise, surpriseBuild: surpriseBuild, randomBuild: function (rng, archId) { return randomBuild(typeof rng === 'function' ? rng : makeRng(rng), archId).build; },
    archetypes: ARCHETYPES.map(function (a) { return { id: a.id, name: a.name }; }),
    resolveIssues: resolveIssues,
    // share / files
    exportJSON: exportJSON, exportGarage: exportGarage, importJSON: importJSON, importToGarage: importToGarage,
    parseImport: parseImport, garageBackup: garageBackup, shareURL: shareURLFor, copy: copy, download: download,
    textSummary: textSummary, print: printSheet,
    // pure helpers
    compute: compute, compareRows: compareRows, bestIndices: bestIndices, tallyWins: tallyWins, metricGroups: metricGroups,
    specSections: specSections, describe: describe, thumbnail: thumbnail,
    _internal: { mulberry32: mulberry32, makeRng: makeRng, wpick: wpick, profileFor: profileFor, tyreWidthFor: tyreWidthFor, fallbackThumb: fallbackThumb, sameBuild: sameBuild, sheetText: sheetText, looksLikeBuild: looksLikeBuild, SHEET_CSS: SHEET_CSS }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.garage;

/* ==========================================================================
   FORGE Atelier — js/panels-powertrain.js
   Registers the four "Engineering" panels: body, engine, transmission, drivetrain.

   Architecture
   ------------
   * Every panel is created through makePanel(), which gives it a small runtime object P:
       P.root      the panel's root element (inside the container app.js hands us)
       P.build     latest build;   P.metrics  latest metrics (physics output, merged over local estimates)
       P.watch(node, fn(build, metrics), dispose?)   — metric-driven widgets (stat tiles, charts, tables).
                   Watchers are re-run on every update() and pruned automatically once their node has
                   left P.root (e.g. after a structural slot rebuild).
   * Controls built with CB.ui follow the ui-kit sync strategy (data-cb-path + .sync(build)); update()
     calls CB.ui.syncAll(P.root, build) and never rebuilds the DOM, so slider drags are never interrupted.
   * Structural changes (engine type switch, body style → door/seat options, gear count → ratio sliders)
     are handled by slot(keyFn, renderFn): a bound container that rebuilds ONLY its own contents when
     keyFn(build) changes. Everything else is updated in place.
   * Defensive by design: CB.physics, CB.rules and CB.charts are all optional. Missing metrics are filled
     from a local catalog-based estimator; missing charts fall back to a tiny built-in canvas plotter;
     option compatibility uses CB.rules.compatibleOptions when present, else built-in fallback rules.
   ========================================================================== */
window.CB = window.CB || {};

(function () {
  'use strict';

  var CB = window.CB;
  var U = CB.util, D = CB.data, ui = CB.ui;
  if (!U || !D || !ui || typeof CB.registerPanel !== 'function') {
    if (typeof console !== 'undefined') console.error('[panels-powertrain] CB.util / CB.data / CB.ui must load first.');
    return;
  }
  var el = U.el;
  var hasRAF = typeof requestAnimationFrame === 'function';
  // rAF is suspended in hidden / background tabs, so every scheduled frame races a timer: whichever fires
  // first runs the callback once and cancels the other. Handles are small objects understood by caf().
  function raf(f) {
    var h = { r: 0, t: 0, done: false };
    var run = function (ts) {
      if (h.done) return;
      h.done = true;
      if (h.r && hasRAF) cancelAnimationFrame(h.r);
      clearTimeout(h.t);
      f(ts);
    };
    var hidden = typeof document !== 'undefined' && document.hidden;
    if (hasRAF && !hidden) h.r = requestAnimationFrame(run);
    h.t = setTimeout(run, hidden || !hasRAF ? 16 : 120);
    return h;
  }
  function caf(h) {
    if (!h || h.done) return;
    h.done = true;
    if (h.r && hasRAF) cancelAnimationFrame(h.r);
    clearTimeout(h.t);
  }

  /* ======================================================================
     SMALL HELPERS
     ====================================================================== */
  function find(c, id) { try { return D.find(c, id); } catch (e) { return undefined; } }
  function list(c) { try { return D.list(c) || []; } catch (e) { return []; } }
  function get(b, p, fb) { var v = U.get(b, p); return v === undefined || v === null ? fb : v; }
  function R(path, fb) { return (D.ranges && D.ranges[path]) || fb || { min: 0, max: 100, step: 1 }; }
  function num(v, fb) { v = Number(v); return isFinite(v) ? v : fb; }
  function fmt(n, d) { return n == null || !isFinite(Number(n)) ? '—' : U.fmtNum(Number(n), d || 0); }
  function money(n) { return U.fmtMoney(n); }
  function opt(key, fb) { return D.options && D.options[key] != null ? D.options[key] : fb; }
  function setState(path, v, label) { return CB.state.set(path, v, { label: label }); }
  function patchState(p, label) { return CB.state.patch(p, { label: label }); }
  function cur() { return CB.state.get(); }
  function toast(msg, kind) { if (ui.toast) ui.toast(msg, kind || 'info'); }
  function hint(text) { return el('div', { class: 'cb-hint' }, text); }
  function note(text, kind) { return el('div', { class: 'pp-note is-' + (kind || 'info') }, text); }
  function clamp(v, a, b) { return U.clamp(v, a, b); }
  function r2(n) { return U.round(n, 2); }
  function isElectric(b) { return get(b, 'engine.type') === 'ev'; }
  function hasICE(b) { return get(b, 'engine.type') !== 'ev'; }
  function hasMotors(b) { return get(b, 'engine.type') !== 'ice'; }
  function kwToHp(kw) { return kw * 1.34102; }
  function nmToLbft(nm) { return nm * 0.737562; }
  function kphToMph(k) { return k * 0.621371; }

  function svgWrap(vb, w, h, body, cls) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" width="' + w + '" height="' + h +
      '" class="pp-svg ' + (cls || '') + '" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function attrs(o) {
    return Object.keys(o).map(function (k) { return k + '="' + o[k] + '"'; }).join(' ');
  }

  /* ======================================================================
     SCOPED STYLES (only for widgets that ui-kit does not style)
     ====================================================================== */
  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('pp-styles')) return;
    var css = [
      '.pp-panel{display:flex;flex-direction:column;gap:18px}',
      '.pp-stack{display:flex;flex-direction:column;gap:14px}',
      '.pp-slot{display:flex;flex-direction:column;gap:14px}',
      '.pp-slot:empty{display:none}',
      '.pp-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px}',
      '.pp-stats .cb-stat{min-width:0}',
      '.pp-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '@media (max-width:720px){.pp-two{grid-template-columns:1fr}}',
      '.pp-svg{display:block;max-width:100%}',
      '.cb-card-icon .pp-svg{width:100%;height:auto;max-height:56px}',
      '.pp-diagram{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg-2);padding:10px;overflow:hidden}',
      '.pp-diagram svg{width:100%;height:auto;display:block}',
      '.pp-diagram text{font-family:var(--mono);font-size:var(--fs-2xs);fill:var(--text-dim)}',
      '.pp-diagram .pp-strong{fill:var(--text)}',
      '.pp-note{font-size:var(--fs-sm);line-height:1.45;padding:9px 12px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--panel-2);color:var(--text-dim)}',
      '.pp-note.is-warning{border-color:color-mix(in srgb,var(--warn) 55%,transparent);color:var(--text)}',
      '.pp-note.is-error{border-color:color-mix(in srgb,var(--bad) 60%,transparent);color:var(--text)}',
      '.pp-note.is-good{border-color:color-mix(in srgb,var(--good) 55%,transparent)}',
      '.pp-meter{position:relative;height:8px;border-radius:var(--radius-xs);background:var(--panel-2);overflow:hidden;margin:6px 0 4px}',
      '.pp-meter>i{position:absolute;left:0;top:0;bottom:0;border-radius:var(--radius-xs);background:var(--accent);transition:width .25s ease,background-color .25s}',
      '.pp-meter>b{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--text);opacity:.65}',
      '.pp-meter.is-good>i{background:var(--good)}.pp-meter.is-warn>i{background:var(--warn)}.pp-meter.is-bad>i{background:var(--bad)}',
      '.pp-readout{display:flex;justify-content:space-between;gap:10px;font-size:var(--fs-sm);color:var(--text-dim);font-variant-numeric:tabular-nums}',
      '.pp-readout strong{color:var(--text);font-weight:600}',
      '.pp-widget{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel-2)}',
      '.pp-widget .pp-title{font-size:var(--fs-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}',
      '.pp-btnrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.pp-gears{display:flex;flex-direction:column;gap:6px}',
      '.pp-gear-row{display:grid;grid-template-columns:38px minmax(0,1fr) 128px;gap:12px;align-items:center;padding:4px 0;border-bottom:1px dashed var(--line)}',
      '.pp-gear-row:last-child{border-bottom:0}',
      '.pp-gear-no{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);font-family:var(--mono);font-weight:700;color:var(--accent)}',
      '.pp-gear-row .cb-slider{margin:0}',
      '.pp-gear-meta{font-family:var(--mono);font-size:var(--fs-xs);line-height:1.5;color:var(--text-dim);text-align:right;font-variant-numeric:tabular-nums}',
      '.pp-gear-meta strong{color:var(--text)}',
      '.pp-gear-bar{height:4px;border-radius:2px;background:var(--accent);opacity:.8;margin-top:3px;margin-left:auto;transition:width .2s}',
      '@media (max-width:560px){.pp-gear-row{grid-template-columns:30px minmax(0,1fr)}.pp-gear-meta{grid-column:2;text-align:left}.pp-gear-bar{margin-left:0}}',
      '.pp-table-wrap{overflow-x:auto}',
      '.pp-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm);font-variant-numeric:tabular-nums}',
      '.pp-table th{font-weight:600;text-align:right;color:var(--text-dim);font-size:var(--fs-2xs);letter-spacing:.06em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--line)}',
      '.pp-table td{text-align:right;padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);font-family:var(--mono)}',
      '.pp-table th:first-child,.pp-table td:first-child{text-align:left}',
      '.pp-table tr.is-top td{color:var(--accent)}',
      '.pp-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:var(--pill);font-size:var(--fs-xs);border:1px solid var(--line);color:var(--text-dim)}',
      '.pp-chip.is-on{border-color:var(--accent);color:var(--text)}',
      '.pp-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.pp-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:var(--fs-xs);color:var(--text-dim)}',
      '.pp-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}',
      '.pp-estimated{font-size:var(--fs-xs);color:var(--warn)}',
      '.pp-fallback-chart{width:100%;height:100%;display:block}',
      /* real-model picker (CB.shapes) */
      '.pp-models{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}',
      '.pp-model{position:relative;display:flex;flex-direction:column;gap:6px;text-align:left;cursor:pointer;padding:10px 12px 11px;border-radius:var(--radius);',
      'border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;transition:border-color .15s,transform .15s,box-shadow .15s}',
      '.pp-model:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));transform:translateY(-1px)}',
      '.pp-model:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.pp-model.is-selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset,0 10px 30px -18px var(--accent)}',
      '.pp-model-art{height:70px;display:flex;align-items:flex-end;justify-content:center;border-radius:var(--radius-sm);background:radial-gradient(120% 90% at 50% 100%,color-mix(in srgb,var(--accent) 14%,transparent),transparent 70%)}',
      '.pp-model-art svg{width:100%;height:100%;display:block}',
      '.pp-model-make{font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--text-dim)}',
      '.pp-model-name{font-weight:650;font-size:var(--fs-md);line-height:1.2}',
      '.pp-model-sub{font-size:var(--fs-xs);color:var(--text-dim)}',
      '.pp-model-specs{display:grid;grid-template-columns:auto 1fr;gap:1px 10px;font-size:var(--fs-xs);font-family:var(--mono);color:var(--text-dim);margin-top:2px}',
      '.pp-model-specs b{color:var(--text);font-weight:500;text-align:right}',
      '.pp-model-badge{position:absolute;top:8px;right:8px;font-size:var(--fs-2xs);letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:var(--pill);border:1px solid var(--line);color:var(--text-dim)}',
      '.pp-model.is-selected .pp-model-badge.is-pick{border-color:var(--accent);color:var(--accent)}',
      '.pp-model-fit{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:var(--fs-sm);color:var(--text-dim)}',
      '.pp-model-fit strong{color:var(--text);font-weight:600}',
      /* Auto-config (stock spec) */
      '.pp-stock-btn.is-stock{background:transparent;color:var(--accent);border-color:var(--accent)}',
      '.pp-stock-chip{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--pill);border:1px solid var(--accent);',
      'background:color-mix(in srgb,var(--accent) 10%,transparent);font-size:var(--fs-sm);color:var(--text);width:max-content;max-width:100%}',
      '.pp-stock-chip[hidden]{display:none}',
      '.pp-stock-chip .cb-btn.sm{min-height:26px;padding:0 10px;font-size:var(--fs-sm)}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'pp-styles';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ======================================================================
     METRICS: physics output merged over a local catalog-based estimate
     ====================================================================== */
  function tireDiameter_mm(b, axle) {
    var rear = axle !== 'front';
    var dIn = num(get(b, 'wheels.diameter_in'), 19);
    var w = num(get(b, rear ? 'tires.widthRear_mm' : 'tires.widthFront_mm'), 255);
    var pr = num(get(b, rear ? 'tires.profileRear' : 'tires.profileFront'), 35);
    return dIn * 25.4 + 2 * w * pr / 100;
  }
  function drivenAxleTireDiameter(b) {
    return tireDiameter_mm(b, get(b, 'drivetrain.layout') === 'fwd' ? 'front' : 'rear');
  }
  function maxRpm(b) {
    if (isElectric(b)) return (D.constants && D.constants.evMaxRpm) || 16000;
    return num(get(b, 'engine.redline_rpm'), 7000);
  }
  function localGearSpeeds(b) {
    var ratios = get(b, 'transmission.ratios', []) || [];
    var fd = num(get(b, 'transmission.finalDrive'), 3.42);
    var circ = Math.PI * drivenAxleTireDiameter(b) / 1000; // m
    var rpm = maxRpm(b);
    return ratios.map(function (r, i) {
      return { gear: i + 1, ratio: r, maxKph: rpm / (r * fd) * circ * 60 / 1000 };
    });
  }

  /** Coarse catalog estimate — only used to fill gaps when CB.physics is unavailable. */
  function estimate(b) {
    var st = find('bodyStyles', get(b, 'body.style')) || {};
    var cm = find('chassisMaterials', get(b, 'body.chassisMaterial')) || { weightFactor: 1 };
    var tr = find('transmissions', get(b, 'transmission.type')) || {};
    var w = num(st.baseWeight_kg, 1500) * num(cm.weightFactor, 1);
    var type = get(b, 'engine.type', 'ice');
    if (type !== 'ev') {
      var lay = find('engineLayouts', get(b, 'engine.layout')) || {};
      var asp = find('aspirations', get(b, 'engine.aspiration')) || {};
      var ex = find('exhausts', get(b, 'engine.exhaust')) || {};
      var co = find('coolings', get(b, 'engine.cooling')) || {};
      var mid = lay.displacementRange ? (lay.displacementRange[0] + lay.displacementRange[1]) / 2 : 3;
      w += num(lay.baseWeight_kg, 180) * Math.pow(num(get(b, 'engine.displacement_l'), mid) / mid, 0.3) + num(asp.weight_kg, 0) + num(ex.weight_kg, 0) + num(co.weight_kg, 0);
    }
    if (type !== 'ice') {
      var ch = find('batteryChemistries', get(b, 'engine.chemistry')) || { whPerKg: 180 };
      w += num(get(b, 'engine.battery_kwh'), 0) * 1000 / num(ch.whPerKg, 180) * 1.25 + num(get(b, 'engine.motors'), 1) * 42;
    }
    w += num(tr.weight_kg, 70);
    if (get(b, 'drivetrain.layout') === 'awd') w += 70;
    var cd = num(st.cd, 0.32);
    ['splitter:aero.splitters', 'wing:aero.wings', 'diffuser:aero.diffusers'].forEach(function (pair) {
      var kv = pair.split(':');
      var o = find(kv[1], get(b, 'aero.' + kv[0]));
      if (o) cd += num(o.dragDelta, 0);
    });
    var fa = num(st.frontalArea_m2, 2.1);
    var pos = get(b, 'engine.position', 'front');
    var front = type === 'ev' ? 48 : pos === 'front' ? 54 : pos === 'mid' ? 42 : 37;
    return {
      weight_kg: w, weightFront_pct: front, cd: cd, frontalArea_m2: fa, cda: cd * fa,
      cgHeight_mm: num(st.cgHeight_mm, 500), gearSpeeds: localGearSpeeds(b)
    };
  }

  var physCache = { build: null, m: null };
  var mergeCache = { build: null, src: null, out: null };
  function physicsFor(build) {
    if (physCache.build === build) return physCache.m;
    var m = null;
    if (CB.physics && typeof CB.physics.compute === 'function') {
      try { m = CB.physics.compute(build); } catch (e) { if (typeof console !== 'undefined') console.error('[panels-powertrain] physics.compute failed', e); }
    }
    physCache = { build: build, m: m };
    return m;
  }
  function metricsFor(build, metrics) {
    var src = metrics && typeof metrics === 'object' ? metrics : physicsFor(build);
    if (mergeCache.build === build && mergeCache.src === src) return mergeCache.out;
    var est = estimate(build);
    var out;
    if (!src) { out = est; out._estimated = true; }
    else {
      out = Object.assign({}, est, src);
      if (!Array.isArray(src.gearSpeeds) || !src.gearSpeeds.length) out.gearSpeeds = est.gearSpeeds;
      out._estimated = false;
    }
    mergeCache = { build: build, src: src, out: out };
    return out;
  }

  /* ======================================================================
     OPTION COMPATIBILITY (CB.rules.compatibleOptions when available)
     ====================================================================== */
  var compatCache = { build: null, map: {} };

  /** Accepts many plausible return shapes and normalises to { list?:Set-like map, map:{id: false|reason} }. */
  function normalizeCompat(r) {
    if (!r) return null;
    var out = { listMode: false, allowed: {}, map: {} };
    function reasonOf(o) { return o.reason || o.message || o.why || 'Not compatible with the current build'; }
    if (Array.isArray(r)) {
      if (!r.length) return null;
      r.forEach(function (item) {
        if (item == null) return;
        if (typeof item !== 'object') { out.listMode = true; out.allowed[String(item)] = true; return; }
        var id = String(item.id);
        var ok = item.ok != null ? item.ok : item.compatible != null ? item.compatible : item.allowed != null ? item.allowed :
          item.disabled != null ? !item.disabled : item.valid != null ? item.valid : true;
        out.map[id] = ok ? false : reasonOf(item);
      });
      return out;
    }
    if (typeof r === 'object') {
      Object.keys(r).forEach(function (k) {
        var v = r[k];
        if (v === true) out.map[k] = false;
        else if (v === false) out.map[k] = 'Not compatible with the current build';
        else if (typeof v === 'string') out.map[k] = v;
        else if (v && typeof v === 'object') {
          var ok = v.ok != null ? v.ok : v.compatible != null ? v.compatible : v.allowed != null ? v.allowed : v.disabled != null ? !v.disabled : true;
          out.map[k] = ok ? false : reasonOf(v);
        }
      });
      return out;
    }
    return null;
  }
  function rulesCompat(build, path) {
    if (!CB.rules || typeof CB.rules.compatibleOptions !== 'function') return null;
    if (compatCache.build !== build) compatCache = { build: build, map: {} };
    if (Object.prototype.hasOwnProperty.call(compatCache.map, path)) return compatCache.map[path];
    var res = null;
    try { res = normalizeCompat(CB.rules.compatibleOptions(build, path)); } catch (e) { res = null; }
    if (!res) { try { res = normalizeCompat(CB.rules.compatibleOptions(path, build)); } catch (e2) { res = null; } }
    compatCache.map[path] = res;
    return res;
  }
  function fallbackCompat(build, path, id) {
    var st = find('bodyStyles', get(build, 'body.style')) || { allowedEnginePositions: ['front'] };
    var allowedPos = st.allowedEnginePositions || ['front'];
    switch (path) {
      case 'engine.layout':
        if (id === 'W16' && (['hypercar', 'coupe'].indexOf(st.id) < 0 || allowedPos.indexOf('mid') < 0)) return 'The W16 needs a mid-engined hypercar or coupé chassis';
        if (id === 'V12' && st.id === 'hatchback') return 'A V12 will not fit a hatchback engine bay';
        return false;
      case 'engine.position':
        if (allowedPos.indexOf(id) < 0) return st.name + ' supports ' + allowedPos.join(' / ') + ' engine placement only';
        if (id !== 'mid' && get(build, 'engine.layout') === 'W16' && hasICE(build)) return 'The W16 must be mid-mounted';
        return false;
      case 'transmission.type':
        if (id === 'single-speed' && hasICE(build)) return 'Single-speed reduction is reserved for full-electric drivetrains';
        return false;
      case 'drivetrain.layout':
        if (id === 'fwd' && hasICE(build) && get(build, 'engine.position') !== 'front') return 'Front-wheel drive needs a front-mounted engine';
        return false;
      default:
        return false;
    }
  }
  function compat(build, path, id) {
    var r = rulesCompat(build, path);
    if (r) {
      var sid = String(id);
      if (r.listMode && !r.allowed[sid]) return 'Not compatible with the current build';
      if (Object.prototype.hasOwnProperty.call(r.map, sid)) return r.map[sid];
    }
    return fallbackCompat(build, path, id);
  }
  function compatFn(path) { return function (o, build) { return compat(build, path, o.id); }; }

  /* ======================================================================
     SVG ICON GENERATORS
     ====================================================================== */
  var C_BODY = 'currentColor';

  /** Side-profile shape of a body style in mm (x from front bumper, y up from ground). */
  function bodyShape(style, wheelbase_mm) {
    var s = style.svg || {};
    var L0 = num(s.length_mm, 4600), H = num(s.height_mm, 1350);
    var fo = num(s.frontOverhang_mm, 900), ro = num(s.rearOverhang_mm, 950);
    var wbDef = num(style.defaultWheelbase, L0 - fo - ro);
    var dWb = (wheelbase_mm == null ? wbDef : wheelbase_mm) - wbDef;
    var L = L0 + dWb;
    function X(f) {
      var px = f * L0;
      var t = clamp((px - fo) / Math.max(1, L0 - fo - ro), 0, 1);
      return px + dWb * t;
    }
    function Y(f) { return f * H; }
    var nose = num(s.noseHeight, 0.48), hood = num(s.hoodLength, 0.36), cab = num(s.cabinStart, hood);
    var rs = num(s.roofStart, 0.5), re = num(s.roofEnd, 0.7), ce = num(s.cabinEnd, 0.85);
    var rh = num(s.roofHeight, 1), belt = num(s.beltline, 0.66), deck = num(s.deckHeight, 0.7), tail = num(s.tailHeight, 0.6);
    var bottom = 0.14;
    var pts = [[0, bottom], [0, nose * 0.82], [0.018, nose], [hood * 0.55, nose + (belt - nose) * 0.62], [cab, belt + 0.03]];
    if (s.openTop) {
      pts.push([rs, rh], [rs + 0.012, rh - 0.02], [rs + 0.03, belt + 0.06], [ce, deck]);
    } else {
      pts.push([rs, rh], [re, rh], [ce, deck]);
    }
    if (s.tailStyle === 'bed') pts.push([ce + 0.01, rh * 0.62], [0.995, deck]);
    else if (s.tailStyle === 'notchback') pts.push([0.975, deck]);
    else if (s.tailStyle === 'fastback' || s.tailStyle === 'longtail') pts.push([0.975, (deck + tail) / 2 + 0.03]);
    pts.push([1, tail], [1, bottom]);
    var body = pts.map(function (p) { return [X(p[0]), Y(p[1])]; });
    var glass = null;
    if (!s.openTop) {
      glass = [[cab + 0.025, belt + 0.01], [rs + 0.012, rh - 0.055], [re - 0.006, rh - 0.055], [re + (ce - re) * 0.72, belt + 0.01]]
        .map(function (p) { return [X(p[0]), Y(p[1])]; });
    } else {
      glass = [[cab + 0.02, belt + 0.03], [rs - 0.004, rh - 0.02], [rs + 0.008, rh - 0.03], [cab + 0.04, belt + 0.03]]
        .map(function (p) { return [X(p[0]), Y(p[1])]; });
    }
    var tall = ['suv', 'pickup', 'van'].indexOf(style.id) >= 0;
    var wr = tall ? 390 : style.id === 'hypercar' ? 350 : 335;
    return { L: L, H: H, body: body, glass: glass, wheels: [[fo, wr], [fo + wbDef + dWb, wr]], wheelR: wr, fo: fo, ro: ro, wheelbase: wbDef + dWb, openTop: !!s.openTop };
  }

  function polyD(points, mapX, mapY) {
    return points.map(function (p, i) { return (i ? 'L' : 'M') + mapX(p[0]).toFixed(1) + ' ' + mapY(p[1]).toFixed(1); }).join(' ') + ' Z';
  }

  /** Small card icon silhouette, all styles drawn to a common scale so sizes are comparable. */
  function silhouetteIcon(style) {
    var W = 120, Hh = 46, pad = 3, ground = 42;
    var sh = bodyShape(style);
    var k = (W - 2 * pad) / 6000;
    var x0 = (W - sh.L * k) / 2;
    function mx(x) { return x0 + x * k; }
    function my(y) { return ground - y * k * 1.15; }
    var out = '<line x1="2" y1="' + (ground + 0.5) + '" x2="' + (W - 2) + '" y2="' + (ground + 0.5) + '" stroke="currentColor" stroke-opacity=".25" stroke-width="1"/>';
    out += '<path d="' + polyD(sh.body, mx, my) + '" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';
    out += '<path d="' + polyD(sh.glass, mx, my) + '" fill="currentColor" fill-opacity=".38" stroke="none"/>';
    sh.wheels.forEach(function (w) {
      var cx = mx(w[0]), cy = my(w[1]), r = w[1] * k * 1.15;
      out += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (r + 1.2).toFixed(1) + '" fill="var(--panel,#111)"/>';
      out += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="none" stroke="currentColor" stroke-width="1.6"/>';
      out += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (r * 0.42).toFixed(1) + '" fill="currentColor" fill-opacity=".5"/>';
    });
    return svgWrap('0 0 ' + W + ' ' + Hh, W, Hh, out, 'pp-silhouette');
  }

  /** Stiffness / weight meter icon for chassis materials. */
  function chassisIcon(m) {
    var out = '';
    var segs = 10, lit = Math.round(num(m.stiffness, 0.5) * segs);
    for (var i = 0; i < segs; i++) {
      out += '<rect x="' + (4 + i * 9) + '" y="6" width="7" height="10" rx="1.5" fill="currentColor" fill-opacity="' + (i < lit ? 0.85 : 0.15) + '"/>';
    }
    // torsion box lattice — denser for stiffer materials
    var bars = 3 + Math.round(num(m.stiffness, 0.5) * 6);
    out += '<rect x="4" y="22" width="88" height="16" rx="3" fill="none" stroke="currentColor" stroke-opacity=".6"/>';
    for (var j = 1; j < bars; j++) {
      var x = 4 + j * 88 / bars;
      out += '<line x1="' + x.toFixed(1) + '" y1="22" x2="' + (x - 88 / bars).toFixed(1) + '" y2="38" stroke="currentColor" stroke-opacity=".45"/>';
    }
    var wf = num(m.weightFactor, 1);
    out += '<rect x="4" y="42" width="' + (88 * wf).toFixed(1) + '" height="3" rx="1.5" fill="currentColor" fill-opacity=".5"/>';
    return svgWrap('0 0 96 48', 96, 48, out, 'pp-chassis-icon');
  }

  /** Cylinder-arrangement icon per engine layout. */
  function layoutIcon(lay) {
    var n = lay.cylinders || 4, cfg = lay.config || 'inline';
    var out = '', W = 96, H = 40;
    function cyl(cx, cy, r) { return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.2"/>'; }
    if (cfg === 'rotary') {
      [30, 66].forEach(function (cx) {
        var r = 12, cy = 20, p = [];
        for (var i = 0; i < 3; i++) { var a = -Math.PI / 2 + i * 2 * Math.PI / 3; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
        out += '<ellipse cx="' + cx + '" cy="20" rx="16" ry="14" fill="none" stroke="currentColor" stroke-opacity=".5"/>';
        out += '<path d="M' + p[0].join(' ') + ' Q' + cx + ' ' + (cy + 2) + ' ' + p[1].join(' ') + ' Q' + cx + ' ' + (cy + 2) + ' ' + p[2].join(' ') + ' Q' + cx + ' ' + (cy + 2) + ' ' + p[0].join(' ') + 'Z" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.2"/>';
        out += '<circle cx="' + cx + '" cy="20" r="2.5" fill="currentColor"/>';
      });
    } else if (cfg === 'inline') {
      var r = Math.min(8, 80 / n / 2.3), gap = 84 / n;
      out += '<rect x="4" y="8" width="88" height="24" rx="6" fill="none" stroke="currentColor" stroke-opacity=".45"/>';
      for (var i = 0; i < n; i++) out += cyl(6 + gap / 2 + i * gap, 20, r);
    } else if (cfg === 'flat') {
      var half = n / 2, g = 76 / half, rr = Math.min(7, g / 2.4);
      out += '<line x1="8" y1="20" x2="88" y2="20" stroke="currentColor" stroke-width="2"/>';
      for (var j = 0; j < half; j++) {
        var x = 14 + g / 2 + j * g - g / 2 + 4;
        out += '<rect x="' + (x - rr).toFixed(1) + '" y="3" width="' + (rr * 2).toFixed(1) + '" height="12" rx="2" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.2"/>';
        out += '<rect x="' + (x - rr + g * 0.25).toFixed(1) + '" y="25" width="' + (rr * 2).toFixed(1) + '" height="12" rx="2" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.2"/>';
      }
    } else if (cfg === 'w') {
      for (var row = 0; row < 4; row++) {
        for (var c = 0; c < 4; c++) out += cyl(16 + c * 20 + (row % 2) * 5, 6 + row * 9.5, 4);
      }
      out += '<path d="M6 2 L48 38 L90 2" fill="none" stroke="currentColor" stroke-opacity=".35"/>';
    } else { // vee
      var bank = Math.ceil(n / 2), gv = 78 / bank, rv = Math.min(6.5, gv / 2.5);
      out += '<path d="M6 4 L48 36 L90 4" fill="none" stroke="currentColor" stroke-opacity=".3"/>';
      for (var k = 0; k < bank; k++) {
        out += cyl(10 + gv / 2 + k * gv, 10, rv);
        if (k < Math.floor(n / 2)) out += cyl(10 + gv / 2 + k * gv + gv * 0.3, 30, rv);
      }
    }
    return svgWrap('0 0 ' + W + ' ' + H, W, H, out, 'pp-layout-icon');
  }

  function spiral(cx, cy, r) {
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M' + cx + ' ' + cy + ' m' + (-r * 0.55) + ' 0 a' + (r * 0.55) + ' ' + (r * 0.55) + ' 0 1 1 ' + (r * 0.55) + ' ' + (r * 0.55) + '" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="1.8" fill="currentColor"/>' +
      '<path d="M' + (cx + r) + ' ' + cy + ' h' + (r * 0.6) + '" stroke="currentColor" stroke-width="2.4"/>';
  }
  function blower(cx, cy) {
    return '<rect x="' + (cx - 14) + '" y="' + (cy - 9) + '" width="28" height="18" rx="5" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="1.3"/>' +
      '<circle cx="' + (cx - 5) + '" cy="' + cy + '" r="5" fill="none" stroke="currentColor"/><circle cx="' + (cx + 5) + '" cy="' + cy + '" r="5" fill="none" stroke="currentColor"/>' +
      '<circle cx="' + (cx - 18) + '" cy="' + (cy + 14) + '" r="4" fill="none" stroke="currentColor"/><path d="M' + (cx - 21) + ' ' + (cy + 11) + ' L' + (cx - 9) + ' ' + (cy + 6) + ' M' + (cx - 15) + ' ' + (cy + 17) + ' L' + (cx - 1) + ' ' + (cy + 6) + '" stroke="currentColor" stroke-opacity=".6"/>';
  }
  function bolt(x, y, s) {
    s = s || 1;
    return '<path d="M' + x + ' ' + y + ' l' + (-6 * s) + ' ' + (11 * s) + ' h' + (5 * s) + ' l' + (-3 * s) + ' ' + (10 * s) + ' l' + (9 * s) + ' ' + (-13 * s) + ' h' + (-5 * s) + ' l' + (3 * s) + ' ' + (-8 * s) + 'z" fill="currentColor" fill-opacity=".85"/>';
  }
  function aspirationIcon(a) {
    var out = '';
    switch (a.id) {
      case 'na':
        out = '<path d="M60 8 h16 v24 h-16 q-10 -12 0 -24z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.3"/>' +
          '<path d="M10 12 q12 -4 24 0 t22 0M10 20 q12 -4 24 0 t22 0M10 28 q12 -4 24 0 t22 0" fill="none" stroke="currentColor" stroke-opacity=".7"/>'; break;
      case 'turbo': out = spiral(48, 20, 12); break;
      case 'twin-turbo': out = spiral(30, 20, 11) + spiral(66, 20, 11); break;
      case 'quad-turbo': out = spiral(22, 11, 7) + spiral(52, 11, 7) + spiral(22, 30, 7) + spiral(52, 30, 7) + '<path d="M70 20 h18" stroke="currentColor" stroke-opacity=".5"/>'; break;
      case 'supercharged': out = blower(52, 16); break;
      case 'twincharged': out = blower(30, 16) + spiral(72, 20, 10); break;
      case 'electric-turbo': out = spiral(40, 20, 12) + bolt(78, 7, 1.15); break;
      default: out = spiral(48, 20, 12);
    }
    return svgWrap('0 0 96 40', 96, 40, out, 'pp-asp-icon');
  }
  function gaugeIcon(mult) {
    var t = clamp((num(mult, 1) - 0.85) / (1.65 - 0.85), 0, 1);
    var a = Math.PI * (1 - t), cx = 48, cy = 34, r = 26;
    var nx = cx + Math.cos(a) * (r - 4), ny = cy - Math.sin(a) * (r - 4);
    var out = '<path d="M22 34 A26 26 0 0 1 74 34" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="5"/>';
    var ex = cx + Math.cos(a) * r, ey = cy - Math.sin(a) * r;
    out += '<path d="M22 34 A26 26 0 0 1 ' + ex.toFixed(1) + ' ' + ey.toFixed(1) + '" fill="none" stroke="currentColor" stroke-width="5"/>';
    out += '<line x1="48" y1="34" x2="' + nx.toFixed(1) + '" y2="' + ny.toFixed(1) + '" stroke="currentColor" stroke-width="2"/><circle cx="48" cy="34" r="3" fill="currentColor"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pp-gauge-icon');
  }
  function exhaustIcon(x) {
    var out = '<path d="M6 10 h84 v10 q0 6 -6 6 h-72 q-6 0 -6 -6z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".5"/>';
    var n = x.tipCount || 2, style = x.tipStyle || 'round';
    var col = style === 'blued' ? 'stroke="#7c8cff"' : 'stroke="currentColor"';
    var xs = n === 1 ? [48] : n === 2 ? [22, 74] : [16, 28, 68, 80];
    if (style === 'center') xs = [48];
    xs.forEach(function (cx) {
      if (style === 'hidden') out += '<rect x="' + (cx - 6) + '" y="27" width="12" height="3" rx="1.5" fill="currentColor" fill-opacity=".6"/>';
      else if (style === 'oval') out += '<ellipse cx="' + cx + '" cy="27" rx="7" ry="4" fill="var(--panel,#111)" ' + col + ' stroke-width="1.6"/>';
      else if (style === 'center') out += '<circle cx="' + cx + '" cy="27" r="7" fill="var(--panel,#111)" ' + col + ' stroke-width="2"/>';
      else out += '<circle cx="' + cx + '" cy="27" r="4.5" fill="var(--panel,#111)" ' + col + ' stroke-width="1.6"/>';
    });
    var waves = clamp(Math.round((num(x.loudness_db, 85) - 78) / 9), 0, 4);
    for (var i = 0; i < waves; i++) out += '<path d="M' + (40 - i * 4) + ' ' + (36 + i * 0.3) + ' q8 3 16 0" fill="none" stroke="currentColor" stroke-opacity="' + (0.7 - i * 0.12) + '"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pp-exhaust-icon');
  }
  function coolingIcon(c) {
    var fins = Math.round(4 + (num(c.heatCapacity, 1) - 1) * 9);
    var out = '<rect x="18" y="6" width="60" height="28" rx="3" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1.2"/>';
    for (var i = 1; i <= fins; i++) {
      var x = 18 + i * 60 / (fins + 1);
      out += '<line x1="' + x.toFixed(1) + '" y1="8" x2="' + x.toFixed(1) + '" y2="32" stroke="currentColor" stroke-opacity=".55"/>';
    }
    out += '<path d="M6 14 h8 M6 20 h8 M6 26 h8 M82 14 h8 M82 20 h8 M82 26 h8" stroke="currentColor" stroke-opacity=".4"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pp-cool-icon');
  }
  function chemistryIcon(c) {
    var f = clamp(num(c.whPerKg, 160) / 330, 0.1, 1);
    var out = '<rect x="10" y="9" width="70" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="80" y="15" width="5" height="10" rx="1.5" fill="currentColor"/>';
    out += '<rect x="13" y="12" width="' + (64 * f).toFixed(1) + '" height="16" rx="2" fill="currentColor" fill-opacity=".55"/>';
    return svgWrap('0 0 96 40', 96, 40, out, 'pp-chem-icon');
  }
  function transIcon(t) {
    var out = '';
    switch (t.id) {
      case 'manual':
        out = '<path d="M24 8 v24 M48 8 v24 M72 8 v24 M24 20 h48" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
        [[24, 8, 1], [24, 32, 2], [48, 8, 3], [48, 32, 4], [72, 8, 5], [72, 32, 6]].forEach(function (p) {
          out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4.5" fill="var(--panel,#111)" stroke="currentColor"/><text x="' + p[0] + '" y="' + (p[1] + 3) + '" font-size="6.5" text-anchor="middle" fill="currentColor">' + p[2] + '</text>';
        }); break;
      case 'dct':
        out = '<circle cx="40" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="40" cy="20" r="9" fill="currentColor" fill-opacity=".2" stroke="currentColor"/>' +
          '<path d="M64 10 h22 M64 30 h22 M58 20 h28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><text x="40" y="23" font-size="8" text-anchor="middle" fill="currentColor">2×</text>'; break;
      case 'auto':
        out = ['P', 'R', 'N', 'D'].map(function (l, i) { return '<text x="' + (18 + i * 20) + '" y="25" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor" fill-opacity="' + (l === 'D' ? 1 : 0.45) + '">' + l + '</text>'; }).join('');
        out += '<rect x="68" y="9" width="20" height="22" rx="4" fill="none" stroke="currentColor"/>'; break;
      case 'cvt':
        out = '<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity=".15" stroke="currentColor"/><circle cx="72" cy="20" r="7" fill="currentColor" fill-opacity=".15" stroke="currentColor"/>' +
          '<path d="M26 7 L72 13 M26 33 L72 27" stroke="currentColor" stroke-width="1.8"/>'; break;
      case 'sequential':
        out = '<rect x="42" y="4" width="12" height="32" rx="6" fill="currentColor" fill-opacity=".15" stroke="currentColor"/><circle cx="48" cy="13" r="4" fill="currentColor"/>' +
          '<text x="28" y="15" font-size="12" text-anchor="middle" fill="currentColor">+</text><text x="28" y="33" font-size="13" text-anchor="middle" fill="currentColor">−</text>' +
          '<path d="M64 10 l8 -4 l8 4 M64 30 l8 4 l8 -4" fill="none" stroke="currentColor" stroke-opacity=".6"/>'; break;
      default: // single-speed planetary
        out = '<circle cx="48" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="48" cy="20" r="5" fill="currentColor" fill-opacity=".5"/>';
        for (var i = 0; i < 3; i++) { var a = i * 2 * Math.PI / 3 - Math.PI / 2; out += '<circle cx="' + (48 + Math.cos(a) * 11).toFixed(1) + '" cy="' + (20 + Math.sin(a) * 11).toFixed(1) + '" r="4.5" fill="none" stroke="currentColor"/>'; }
    }
    return svgWrap('0 0 96 40', 96, 40, out, 'pp-trans-icon');
  }
  var typeIcons = {
    ice: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="7" y="3" width="10" height="8" rx="1.5"/><path d="M12 11v5M9 21l3-5 3 5"/></svg>',
    hybrid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1.5"/><path d="M7 11v4M5 20l2-5 2 5"/><path d="M17 3l-3 7h4l-2 7" stroke-linejoin="round"/></svg>',
    ev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13 2L5 14h6l-1 8 8-12h-6z" stroke-linejoin="round"/></svg>'
  };

  /* ======================================================================
     WIDGET HELPERS
     ====================================================================== */

  /** A container that rebuilds its own contents only when keyFn(build) changes. */
  function slot(keyFn, renderFn, cls) {
    var host = el('div', { class: 'pp-slot' + (cls ? ' ' + cls : '') });
    var key = {};
    return ui.bind(host, '*', function (build) {
      var k = keyFn(build);
      if (k === key) return;
      key = k;
      U.clear(host);
      var content = renderFn(build);
      (Array.isArray(content) ? content : [content]).forEach(function (n) { if (n) host.appendChild(n); });
    });
  }

  /** Meter widget: {value 0..1+, marker?, kind:'good'|'warn'|'bad'} */
  function meter() {
    var bar = el('i'), mark = el('b', { hidden: true });
    var m = el('div', { class: 'pp-meter' }, bar, mark);
    m.set = function (frac, kind, markerFrac) {
      bar.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
      m.className = 'pp-meter' + (kind ? ' is-' + kind : '');
      if (markerFrac != null) { mark.hidden = false; mark.style.left = (clamp(markerFrac, 0, 1) * 100).toFixed(1) + '%'; }
      else mark.hidden = true;
    };
    return m;
  }

  /** Grid of stat tiles. defs: [{key, label, unit, decimals, kind}] → element with .tiles[key] */
  function statGrid(defs) {
    var g = el('div', { class: 'pp-stats' });
    g.tiles = {};
    g.units = {};
    defs.forEach(function (d) {
      g.units[d.key] = d.unit || '';
      var t = ui.stat(d.label, null, d.unit || '', { decimals: d.decimals, kind: d.kind });
      if (d.title) t.title = d.title;
      g.tiles[d.key] = t;
      g.appendChild(t);
    });
    g.setAll = function (vals) {
      Object.keys(vals).forEach(function (k) {
        var v = vals[k];
        if (!g.tiles[k]) return;
        if (v && typeof v === 'object' && !Array.isArray(v)) g.tiles[k].set(v.value, v.unit != null ? v.unit : g.units[k], v.delta);
        else g.tiles[k].set(v == null || (typeof v === 'number' && !isFinite(v)) ? null : v, g.units[k]);
      });
    };
    return g;
  }

  /* ---------------- fallback canvas plotter (only used when CB.charts is missing) */
  function cssVar(name, fb) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
  }
  function fallbackPlot(canvas, series, opts) {
    var wrap = canvas.parentNode;
    var w = Math.max(200, (wrap && wrap.clientWidth) || 400), h = Math.max(120, ((wrap && wrap.clientHeight) || 220) - 18);
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var padL = 38, padR = opts.right ? 38 : 10, padT = 10, padB = 22;
    var xs = [], yl = [], yr = [];
    series.forEach(function (s) { s.pts.forEach(function (p) { xs.push(p[0]); (s.axis === 'r' ? yr : yl).push(p[1]); }); });
    if (!xs.length) return;
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var yl1 = Math.max.apply(null, yl.concat([1])) * 1.1, yr1 = yr.length ? Math.max.apply(null, yr) * 1.1 : 1;
    function px(x) { return padL + (x - x0) / Math.max(1e-9, x1 - x0) * (w - padL - padR); }
    function py(y, ax) { return h - padB - y / (ax === 'r' ? yr1 : yl1) * (h - padT - padB); }
    var line = cssVar('--line', '#2a2a2a'), dim = cssVar('--text-dim', '#999');
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.font = '10px ' + cssVar('--mono', 'monospace'); ctx.fillStyle = dim;
    for (var i = 0; i <= 4; i++) {
      var yy = padT + i * (h - padT - padB) / 4;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(Math.round(yl1 * (1 - i / 4)), 4, yy + 3);
      if (opts.right) ctx.fillText(Math.round(yr1 * (1 - i / 4)), w - padR + 4, yy + 3);
    }
    ctx.fillText(Math.round(x0) + (opts.xUnit || ''), padL, h - 6);
    ctx.fillText(Math.round(x1) + (opts.xUnit || ''), w - padR - 40, h - 6);
    series.forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.beginPath();
      s.pts.forEach(function (p, k) { var X = px(p[0]), Y = py(p[1], s.axis); if (k && !p.jump) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      ctx.stroke();
    });
  }
  function fallbackChart(kind, canvas, m) {
    var acc = cssVar('--accent', '#c8a46a'), acc2 = cssVar('--accent-2', '#6aa8c8');
    if (kind === 'dyno' && Array.isArray(m.curve) && m.curve.length) {
      fallbackPlot(canvas, [
        { pts: m.curve.map(function (c) { return [c.rpm, c.hp]; }), color: acc, axis: 'l' },
        { pts: m.curve.map(function (c) { return [c.rpm, c.nm]; }), color: acc2, axis: 'r' }
      ], { right: true, xUnit: '' });
    } else if (kind === 'gears' && Array.isArray(m.gearSpeeds) && m.gearSpeeds.length) {
      var red = num(m.redlineRpm, 7000), pts = [];
      m.gearSpeeds.forEach(function (g, i) {
        var lo = i ? m.gearSpeeds[i - 1].maxKph : 0;
        var a = [lo, lo / g.maxKph * red]; a.jump = i > 0 ? false : true;
        pts.push(a, [g.maxKph, red]);
      });
      fallbackPlot(canvas, [{ pts: pts, color: acc, axis: 'l' }], { xUnit: ' km/h' });
    }
  }

  /** A chart that redraws (rAF-coalesced) whenever metrics change. Uses CB.charts[kind] or fallback. */
  function liveChart(P, kind, opts) {
    opts = opts || {};
    var wrap = ui.chart({ height: opts.height || 230, title: opts.title, label: opts.label || opts.title });
    var inst = null, lastM = null, frame = 0;
    function draw() {
      frame = 0;
      var m = P.metrics;
      if (!m || !wrap.isConnected) return;
      if (CB.charts && typeof CB.charts[kind] === 'function') {
        try {
          if (inst && typeof inst.update === 'function') { inst.update(m); return; }
          if (inst && inst.destroy) inst.destroy();
          inst = CB.charts[kind](wrap.canvas, m);
          return;
        } catch (e) { if (typeof console !== 'undefined') console.error('[panels-powertrain] chart ' + kind + ' failed', e); inst = null; }
      }
      try { fallbackChart(kind, wrap.canvas, m); } catch (e2) { /* ignore */ }
    }
    P.watch(wrap, function (b, m) {
      if (m === lastM) return;
      lastM = m;
      if (!frame) frame = raf(draw);
    }, function () {
      if (frame) caf(frame);
      if (inst && inst.destroy) { try { inst.destroy(); } catch (e) { /* ignore */ } }
      inst = null;
    });
    return wrap;
  }

  /* ======================================================================
     PANEL FACTORY
     ====================================================================== */
  function makePanel(def) {
    var P = { root: null, mounted: false, build: null, metrics: null, watchers: [], id: def.id };
    P.watch = function (node, fn, dispose) {
      var w = { node: node, fn: fn, dispose: dispose };
      P.watchers.push(w);
      if (P.mounted) { try { fn(cur(), P.metrics); } catch (e) { if (typeof console !== 'undefined') console.error('[panels-powertrain] watcher', e); } }
      return node;
    };
    P.disposeAll = function () {
      P.watchers.forEach(function (w) { if (w.dispose) { try { w.dispose(); } catch (e) { /* ignore */ } } });
      P.watchers = [];
    };
    P.refresh = function (change) {
      if (!P.root) return;
      var keep = [];
      P.watchers.forEach(function (w) {
        if (!P.root.contains(w.node)) { if (w.dispose) { try { w.dispose(); } catch (e) { /* ignore */ } } return; }
        keep.push(w);
        try { w.fn(P.build, P.metrics, change); } catch (e) { if (typeof console !== 'undefined') console.error('[panels-powertrain] watcher', e); }
      });
      P.watchers = keep;
    };
    CB.registerPanel({
      id: def.id, title: def.title, subtitle: def.subtitle, icon: (ui.icons && ui.icons[def.id]) || undefined,
      group: 'Engineering', order: def.order,
      render: function (container, build, metrics) {
        injectStyles();
        P.disposeAll();
        if (P.root && P.root.parentNode === container) container.removeChild(P.root);
        P.mounted = false;
        P.build = build || cur();
        P.metrics = metricsFor(P.build, metrics);
        var root = el('div', { class: 'pp-panel pp-panel-' + def.id, dataset: { panel: def.id } });
        P.root = root;
        try { def.build(root, P, P.build); }
        catch (e) {
          if (typeof console !== 'undefined') console.error('[panels-powertrain] render failed for ' + def.id, e);
          root.appendChild(note('This panel failed to render: ' + (e && e.message), 'error'));
        }
        container.appendChild(root);
        P.mounted = true;
        P.refresh({ path: '*' });
        return root;
      },
      update: function (build, metrics, change) {
        if (!P.root) return;
        P.build = build || cur();
        P.metrics = metricsFor(P.build, metrics);
        ui.syncAll(P.root, P.build);
        P.refresh(change);
      }
    });
    return P;
  }

  /* ======================================================================
     PANEL: BODY
     ====================================================================== */
  function styleOf(b) { return find('bodyStyles', get(b, 'body.style')) || D.bodyStyles[0]; }
  function chassisOf(b) { return find('chassisMaterials', get(b, 'body.chassisMaterial')) || D.chassisMaterials[0]; }

  function turningCircle_m(wb_mm, track_mm) {
    var steer = 35 * Math.PI / 180; // effective outer-wheel lock
    return 2 * (wb_mm / Math.sin(steer) + track_mm * 0.08) / 1000;
  }

  /** Live side + top proportion drawing with dimension lines. */
  function proportionDiagram() {
    var host = el('div', { class: 'pp-diagram', role: 'img', 'aria-label': 'Body proportions diagram' });
    var lastKey = '';
    return ui.bind(host, '*', function (b) {
      var st = styleOf(b), wb = num(get(b, 'body.wheelbase_mm'), st.defaultWheelbase), tr = num(get(b, 'body.trackWidth_mm'), 1600);
      var key = st.id + '|' + wb + '|' + tr;
      if (key === lastKey) return;
      lastKey = key;
      var sh = bodyShape(st, wb);
      var W = 560, Hh = 200, ground = 150, k = 470 / 6400, x0 = (W - sh.L * k) / 2 - 40;
      function mx(x) { return x0 + x * k; }
      function my(y) { return ground - y * k; }
      var s = '<defs><linearGradient id="pp-bodygrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent,#c8a46a)" stop-opacity=".45"/><stop offset="1" stop-color="var(--accent,#c8a46a)" stop-opacity=".08"/></linearGradient></defs>';
      s += '<line x1="0" y1="' + ground + '" x2="' + W + '" y2="' + ground + '" stroke="var(--line,#333)"/>';
      s += '<path d="' + polyD(sh.body, mx, my) + '" fill="url(#pp-bodygrad)" stroke="var(--accent,#c8a46a)" stroke-width="1.5" stroke-linejoin="round"/>';
      s += '<path d="' + polyD(sh.glass, mx, my) + '" fill="var(--text,#eee)" fill-opacity=".16"/>';
      sh.wheels.forEach(function (w) {
        s += '<circle cx="' + mx(w[0]).toFixed(1) + '" cy="' + my(w[1]).toFixed(1) + '" r="' + (w[1] * k).toFixed(1) + '" fill="var(--bg,#0a0a0a)" stroke="var(--text,#eee)" stroke-width="2"/>';
        s += '<circle cx="' + mx(w[0]).toFixed(1) + '" cy="' + my(w[1]).toFixed(1) + '" r="' + (w[1] * k * 0.4).toFixed(1) + '" fill="var(--text-dim,#888)" fill-opacity=".5"/>';
      });
      // dimension lines
      var fa = mx(sh.wheels[0][0]), ra = mx(sh.wheels[1][0]);
      function dim(xA, xB, y, label) {
        return '<path d="M' + xA + ' ' + (y - 4) + ' v8 M' + xB + ' ' + (y - 4) + ' v8 M' + xA + ' ' + y + ' H' + xB + '" stroke="var(--text-dim,#888)" fill="none"/>' +
          '<text x="' + ((Number(xA) + Number(xB)) / 2).toFixed(1) + '" y="' + (y + 13) + '" text-anchor="middle" class="pp-strong">' + label + '</text>';
      }
      s += dim(fa.toFixed(1), ra.toFixed(1), ground + 16, 'Wheelbase ' + fmt(wb) + ' mm');
      s += dim(mx(0).toFixed(1), mx(sh.L).toFixed(1), 18, 'Length ' + fmt(sh.L) + ' mm');
      s += '<path d="M' + mx(0) + ' 22 V' + ground + ' M' + mx(sh.L) + ' 22 V' + ground + '" stroke="var(--line,#333)" stroke-dasharray="2 3"/>';
      // top view (track)
      var tx = W - 95, ty = 30, sc = 0.05, len = Math.min(170, sh.L * sc * 0.6), bw = tr * sc * 0.95 + 10;
      s += '<rect x="' + (tx - bw / 2) + '" y="' + ty + '" width="' + bw + '" height="' + len + '" rx="14" fill="var(--accent,#c8a46a)" fill-opacity=".12" stroke="var(--accent,#c8a46a)"/>';
      var tw = tr * sc;
      [ty + len * 0.2, ty + len * 0.8].forEach(function (yy) {
        [-1, 1].forEach(function (side) {
          s += '<rect x="' + (tx + side * tw / 2 - 5).toFixed(1) + '" y="' + (yy - 10) + '" width="10" height="20" rx="3" fill="var(--text,#eee)" fill-opacity=".8"/>';
        });
      });
      s += dim((tx - tw / 2).toFixed(1), (tx + tw / 2).toFixed(1), ty + len + 12, 'Track ' + fmt(tr));
      host.innerHTML = svgWrap('0 0 ' + W + ' ' + Hh, W, Hh, s);
    });
  }

  /* ---------------------------------------------------------------- real models (js/shapes/README.md) */
  function shapesApi() {
    var S = CB.shapes;
    return S && typeof S.modelsByStyle === 'function' && typeof S.toSvgPath === 'function' && typeof S.items === 'function' && typeof S.bounds === 'function' ? S : null;
  }
  var silhouetteCache = {};
  /** Side-view mini silhouette of a model in the build's paint (cached per model + paint). */
  function modelSilhouette(m, paint) {
    var S = shapesApi();
    if (!S || !m || !m.side) return '';
    paint = /^#[0-9a-f]{3,8}$/i.test(String(paint || '')) ? paint : '#9aa3ad';
    var key = m.id + '|' + paint;
    if (silhouetteCache[key]) return silhouetteCache[key];
    var out = '';
    try {
      var f = typeof S.fit === 'function' ? S.fit(m) : m, v = f.side;
      var bodies = S.items(v.body), b = S.bounds(bodies.map(function (i) { return i.path; }));
      var W = 200, H = 70, pad = 5;
      var height = Math.max(b.maxY, num(f.dims && f.dims.height, b.h));
      var sc = Math.min((W - 2 * pad) / b.w, (H - 2 * pad) / height);
      var T = { scale: sc, ox: W / 2 - (b.minX + b.maxX) / 2 * sc, oy: H - pad, flipY: true };
      var gid = 'ppm-' + m.id.replace(/[^a-z0-9-]/gi, '') + '-' + paint.slice(1);
      var parts = ['<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".42" stop-color="' + paint + '" stop-opacity="1"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient></defs>'];
      parts.push('<ellipse cx="' + (W / 2) + '" cy="' + (H - pad + 1) + '" rx="' + (b.w * sc * 0.48).toFixed(1) + '" ry="3" fill="#000" opacity=".45"/>');
      var d = function (p) { return S.toSvgPath(p, T); };
      bodies.forEach(function (it) { parts.push('<path d="' + d(it.path) + '" fill="' + paint + '"/><path d="' + d(it.path) + '" fill="url(#' + gid + ')"/>'); });
      ['lowerTrim', 'sill'].forEach(function (k) { if (v[k]) S.items(v[k]).forEach(function (it) { parts.push('<path d="' + d(it.path) + '" fill="#121315"/>'); }); });
      if (v.greenhouse) S.items(v.greenhouse).forEach(function (it) { parts.push('<path d="' + d(it.path) + '" fill="#121417"/>'); });
      if (v.windows) S.items(v.windows).forEach(function (it) { parts.push('<path d="' + d(it.path) + '" fill="#2b3a49"/>'); });
      var wh = f.wheels || {};
      [wh.front, wh.rear].forEach(function (w) {
        if (!w || !isFinite(w.x)) return;
        var cx = T.ox + w.x * sc, cy = T.oy - num(w.y, w.r) * sc;
        parts.push('<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (w.r * sc).toFixed(1) + '" fill="#0c0c0e"/>');
        parts.push('<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (num(w.rimR, w.r * 0.65) * sc).toFixed(1) + '" fill="#8d939b" stroke="#2a2c30" stroke-width=".8"/>');
        parts.push('<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (w.r * sc * 0.16).toFixed(1) + '" fill="#2a2c30"/>');
      });
      out = svgWrap('0 0 ' + W + ' ' + H, W, H, parts.join(''));
    } catch (e) {
      out = '';
    }
    silhouetteCache[key] = out;
    return out;
  }
  function mmOf(m_) { return isFinite(m_) ? fmt(Math.round(m_ * 1000)) : '—'; }
  /** The fields "match real dimensions" applies (S.refBuild when present, else derived from model.ref). */
  function refPatch(m) {
    var S = shapesApi(), r = m.ref || {}, p = null;
    if (S && typeof S.refBuild === 'function') { try { p = S.refBuild(m); } catch (e) { p = null; } }
    if (!p) {
      p = { body: { wheelbase_mm: Math.round(num(r.wheelbase, 2.65) * 1000), trackWidth_mm: Math.round((num(r.trackF, 1.6) + num(r.trackR, 1.6)) / 2 * 1000) },
            suspension: { rideHeight_mm: Math.round(num(r.rideHeight, 0.13) * 1000) } };
    }
    p = U.deepClone(p);
    p.body = p.body || {};
    delete p._rimRear_in;
    p.body.style = m.style; p.body.model = m.id;
    return p;
  }
  /** "Far from the real car" note for a build (null when within tolerance / no real model). Uses CB.state.dimsDeviation. */
  function realDimsNote(b) {
    var St = CB.state;
    if (!St || typeof St.dimsDeviation !== 'function') return null;
    var dev = null;
    try { dev = St.dimsDeviation(b); } catch (e) { dev = null; }
    if (!dev || !dev.model || !dev.large) return null;
    var off = dev.items.filter(function (i) { return i.big; }).map(function (i) {
      var d = Math.round(i.delta * (i.unit === 'in' ? 10 : 1)) / (i.unit === 'in' ? 10 : 1);
      return i.label + ' ' + (d > 0 ? '+' : '−') + fmt(Math.abs(d)) + (i.unit === '%' ? ' pts' : ' ' + i.unit);
    });
    var m = dev.model;
    return 'Far from the real ' + (m.make ? m.make + ' ' : '') + (m.name || m.id) + ': ' + off.join(', ') + '. Use "Match real dimensions" to snap back.';
  }
  function modelPicker(P) {
    var S = shapesApi();
    var wrap = el('div', { class: 'pp-stack' });
    var gridSlot = slot(function (b) { return get(b, 'body.style') + '|' + get(b, 'exterior.paint'); }, function (b) {
      var list = [];
      try { list = S.modelsByStyle(get(b, 'body.style')) || []; } catch (e) { list = []; }
      if (!list.length) return note('No real-world models are registered for the ' + styleOf(b).name.toLowerCase() + ' body yet: the Garage draws its own coachwork.', 'info');
      var def = typeof S.defaultModel === 'function' ? S.defaultModel(get(b, 'body.style')) : list[0];
      var grid = el('div', { class: 'pp-models', role: 'radiogroup', 'aria-label': 'Production model' });
      list.forEach(function (m) {
        var r = m.ref || {};
        var specs = [
          ['L × W × H', mmOf(r.length) + ' × ' + mmOf(r.width) + ' × ' + mmOf(r.height)],
          ['Wheelbase', mmOf(r.wheelbase) + ' mm'],
          r.curbWeight_kg ? ['Curb', fmt(r.curbWeight_kg) + ' kg'] : null,
          r.tireF ? ['Tyres', r.tireF === r.tireR || !r.tireR ? r.tireF : r.tireF + ' / ' + r.tireR] : null,
          r.cd ? ['Cd', fmt(r.cd, 2)] : null
        ].filter(Boolean);
        var card = el('button', { type: 'button', class: 'pp-model', role: 'radio', 'aria-checked': 'false', dataset: { model: m.id },
            title: m.make + ' ' + m.name + (m.signature && m.signature.notes ? ' · ' + m.signature.notes : '') },
          el('span', { class: 'pp-model-badge' + (def && def.id === m.id ? '' : ' is-pick') }, def && def.id === m.id ? 'Style default' : (m.powertrain === 'ev' ? 'EV' : m.drivetrain ? String(m.drivetrain).toUpperCase() : 'Model')),
          el('div', { class: 'pp-model-art', html: modelSilhouette(m, get(b, 'exterior.paint')) }),
          el('div', { class: 'pp-model-make' }, m.make || ''),
          el('div', { class: 'pp-model-name' }, m.name || m.id),
          el('div', { class: 'pp-model-sub' }, [m.gen, m.years].filter(Boolean).join(' · ') + (m.enginePosition ? ' · ' + m.enginePosition + '-engined' : '')),
          el('div', { class: 'pp-model-specs', html: specs.map(function (sp) { return '<span>' + U.escapeHtml(sp[0]) + '</span><b>' + U.escapeHtml(sp[1]) + '</b>'; }).join('') }));
        card.addEventListener('click', function () {
          var cur0 = cur();
          if (get(cur0, 'body.model') === m.id) return;
          // CB.state folds the model's real wheelbase / track / ride height / tyres into this one undo step
          if (typeof CB.state.applyModel === 'function') CB.state.applyModel(m.id);
          else setState('body.model', m.id, 'Model → ' + m.make + ' ' + m.name);
        });
        grid.appendChild(card);
      });
      return grid;
    });
    P.watch(gridSlot, function (b) {
      var current = null;
      try { current = S.getModel(b, { strict: true }); } catch (e) { current = null; }
      Array.prototype.forEach.call(gridSlot.querySelectorAll('.pp-model'), function (c) {
        var on = !!current && c.dataset.model === current.id;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    });
    var fitInfo = el('div', { class: 'pp-model-fit' });
    function matchReal() {
      var b = cur(), m = null;
      try { m = S.getModel(b, { strict: true }); } catch (e) { m = null; }
      if (!m) return;
      if (typeof CB.state.matchRealDims === 'function') CB.state.matchRealDims();
      else patchState(refPatch(m), 'Match ' + m.make + ' ' + m.name + ' dimensions');
      if (ui.toast) ui.toast('Wheelbase, track, ride height and tyres set to the ' + m.make + ' ' + m.name + ' (within this shell\'s limits)', 'success');
    }
    var matchBtn = typeof ui.button === 'function'
      ? ui.button('Match real dimensions', { kind: 'ghost', title: 'Copy the real car\'s wheelbase, track, ride height and tyre sizes into this build', onClick: matchReal })
      : el('button', { type: 'button', class: 'cb-btn ghost', onclick: matchReal }, 'Match real dimensions');
    var devNote = el('div', { class: 'pp-note is-warning pp-model-dev', role: 'status', hidden: true });
    /* Auto-config: the shown model's factory spec in every section (CB.stock, js/shapes/stock-specs.js) */
    var Stk = CB.stock && typeof CB.stock.run === 'function' ? CB.stock : null;
    function runStock() { if (Stk) { stockChip.hidden = true; Stk.run(); } }
    var stockBtn = typeof ui.button === 'function'
      ? ui.button('Auto-config: stock', { kind: 'primary', title: 'Set engine, gearbox, drivetrain, chassis, wheels, aero, weight, paint, cabin and tech to this car\'s factory spec (F). One undo step.', onClick: runStock })
      : el('button', { type: 'button', class: 'cb-btn primary', onclick: runStock }, 'Auto-config: stock');
    stockBtn.classList.add('pp-stock-btn');
    var stockChip = el('div', { class: 'pp-stock-chip', role: 'status', hidden: true },
      el('span', { class: 'pp-stock-chip-text' }, 'Apply stock spec for this car?'),
      el('button', { type: 'button', class: 'cb-btn primary sm', onclick: runStock }, 'Apply'),
      el('button', { type: 'button', class: 'cb-btn ghost sm', 'aria-label': 'Dismiss', onclick: function () { stockChip.hidden = true; } }, 'Not now'));
    var lastModelId = null;
    P.watch(fitInfo, function (b) {
      var m = null;
      try { m = S.getModel(b, { strict: true }); } catch (e) { m = null; }
      U.clear(fitInfo);
      var hasStock = !!(Stk && m && Stk.has(m.id));
      var isStock = hasStock && Stk.isStock(b);
      var title = hasStock ? Stk.title(m.id) : '';
      stockBtn.hidden = !hasStock;
      if (hasStock) {
        var lbl = stockBtn.querySelector('span') || stockBtn;
        lbl.textContent = (isStock ? 'Stock ✓ ' : 'Auto-config: stock ') + title;
        stockBtn.classList.toggle('is-stock', isStock);
        stockBtn.title = isStock ? 'This build is the factory-spec ' + title + '. Click to re-apply.' :
          'Set every section to the factory ' + title + ' (F). One undo step.';
      }
      // offer the stock spec inline right after a model change (not on first render)
      var mid = m ? m.id : null;
      if (lastModelId !== null && mid !== lastModelId && hasStock && !isStock) {
        stockChip.querySelector('.pp-stock-chip-text').textContent = 'Apply stock spec for the ' + title + '?';
        stockChip.hidden = false;
      } else if (isStock || !hasStock) stockChip.hidden = true;
      lastModelId = mid;
      if (!m) { matchBtn.hidden = true; devNote.hidden = true; return; }
      matchBtn.hidden = false;
      var r = m.ref || {}, wbB = num(get(b, 'body.wheelbase_mm'), 0), wbR = Math.round(num(r.wheelbase, 0) * 1000);
      var trB = num(get(b, 'body.trackWidth_mm'), 0), trR = Math.round((num(r.trackF, 0) + num(r.trackR, 0)) / 2 * 1000);
      var dW = wbB - wbR, dT = trB - trR;
      // the sliders step in 5 mm: a build sitting on the nearest reachable value counts as "as real"
      var dev = null;
      try { dev = typeof CB.state.dimsDeviation === 'function' ? CB.state.dimsDeviation(b) : null; } catch (e) { dev = null; }
      var limW = '', limT = '';
      (dev && dev.items || []).forEach(function (i) {
        if (i.build !== i.reachable) return;
        var lim = Math.abs(i.real - i.reachable) > 10 ? ' (shell limit)' : '';
        if (i.path === 'body.wheelbase_mm') { if (lim) limW = lim; else dW = 0; }
        if (i.path === 'body.trackWidth_mm') { if (lim) limT = lim; else dT = 0; }
      });
      fitInfo.innerHTML = '<span>Showing <strong>' + U.escapeHtml(m.make + ' ' + m.name) + '</strong>' + (typeof S.defaultModel === 'function' && (S.defaultModel(get(b, 'body.style')) || {}).id === m.id ? ' (style default)' : '') + '</span>' +
        '<span>Wheelbase <strong>' + (dW === 0 ? 'as real' : (dW > 0 ? '+' : '−') + fmt(Math.abs(dW)) + ' mm' + limW) + '</strong></span>' +
        '<span>Track <strong>' + (Math.abs(dT) < 1 ? 'as real' : (dT > 0 ? '+' : '−') + fmt(Math.abs(dT)) + ' mm' + limT) + '</strong></span>';
      var far = realDimsNote(b);
      devNote.hidden = !far;
      devNote.textContent = far || '';
    });
    wrap.appendChild(gridSlot);
    wrap.appendChild(el('div', { class: 'pp-btnrow' }, fitInfo, matchBtn, Stk ? stockBtn : null));
    if (Stk) wrap.appendChild(stockChip);
    wrap.appendChild(devNote);
    return wrap;
  }

  function buildBody(root, P) {
    root.appendChild(ui.issues('body'));

    /* ---- live stats */
    var stats = statGrid([
      { key: 'weight', label: 'Curb weight', unit: 'kg', decimals: 0 },
      { key: 'front', label: 'Front axle', unit: '%', decimals: 1 },
      { key: 'cd', label: 'Drag coeff. Cd', decimals: 3 },
      { key: 'area', label: 'Frontal area', unit: 'm²', decimals: 2 },
      { key: 'cda', label: 'CdA', unit: 'm²', decimals: 3 },
      { key: 'cg', label: 'CG height', unit: 'mm', decimals: 0 },
      { key: 'p2w', label: 'Power / weight', unit: 'hp/t', decimals: 0 },
      { key: 'stiff', label: 'Torsional rigidity', unit: 'kNm/°', decimals: 1 }
    ]);
    var estFlag = el('div', { class: 'pp-estimated', hidden: true }, 'Estimated — physics engine not loaded.');
    P.watch(stats, function (b, m) {
      var cm = chassisOf(b);
      var cage = find('rollCages', get(b, 'weight.rollCage')) || { stiffnessGain: 0 };
      stats.setAll({
        weight: m.weight_kg, front: m.weightFront_pct, cd: m.cd, area: m.frontalArea_m2,
        cda: m.cda != null ? m.cda : (m.cd * m.frontalArea_m2), cg: m.cgHeight_mm,
        p2w: m.powerToWeight_hpPerTon != null ? m.powerToWeight_hpPerTon : (m.power_hp && m.weight_kg ? m.power_hp / m.weight_kg * 1000 : null),
        stiff: (num(cm.stiffness, 0.5) + num(cage.stiffnessGain, 0)) * 48
      });
      estFlag.hidden = !m._estimated;
    });
    root.appendChild(ui.section('Vital statistics', 'Updated live as you shape the body and chassis.', stats, estFlag));

    /* ---- body style */
    var styleCards = ui.cards({
      path: 'body.style', label: 'Body style', columns: 3, priceMode: 'relative',
      hint: 'Prices shown relative to your current body. Changing style re-fits wheelbase, doors and seats to the new shell.',
      options: D.bodyStyles.map(function (s) {
        return {
          id: s.id, name: s.name, desc: s.desc, price: s.basePrice, icon: silhouetteIcon(s),
          specs: [['From', U.fmtMoney(s.basePrice, { compact: true })], ['Mass', fmt(s.baseWeight_kg) + ' kg'], ['Cd', fmt(s.cd, 2)], ['Seats', s.seatOptions.join('/')]]
        };
      })
    });
    root.appendChild(ui.section('Silhouette', 'Ten distinct coachwork families, each with its own aerodynamic and packaging signature.', styleCards));

    /* ---- real manufacturer model (CB.shapes): looks only, physics still come from the build's numbers */
    if (shapesApi()) {
      root.appendChild(ui.section('Model', 'Real production-car coachwork for this body style. The shape is fitted to your wheelbase, track, ride height and tyres; picking one changes the look only.',
        modelPicker(P),
        ui.toggle({ path: 'body.modelPhysics', label: 'Real-car mass & aero',
          hint: 'Scale the shell mass to the real model’s size and use its frontal area and drag (a small AE86 shell is lighter than a Challenger’s; a high-roof van catches more air). Auto-config switches it on.' })));
    }

    /* ---- chassis material (rebuilt per style so weight-saving figures are exact) */
    var chassisSlot = slot(function (b) { return styleOf(b).id; }, function (b) {
      var st = styleOf(b);
      var cards = ui.cards({
        path: 'body.chassisMaterial', label: 'Chassis construction', columns: 2,
        hint: 'Lighter, stiffer structures sharpen handling and acceleration. Rigidity also lets the suspension do its job instead of the shell flexing.',
        options: D.chassisMaterials.map(function (m) {
          var saved = st.baseWeight_kg * (1 - num(m.weightFactor, 1));
          return {
            id: m.id, name: m.name, desc: m.desc, price: m.price, icon: chassisIcon(m),
            badge: m.id === 'carbon-monocoque' ? 'Prototype' : m.id === 'carbon-tub' ? 'Supercar' : null,
            specs: [['Rigidity', fmt(num(m.stiffness) * 48, 1) + ' kNm/°'], ['Shell mass', '×' + fmt(m.weightFactor, 2)], ['Saves', saved > 0 ? '−' + fmt(saved) + ' kg' : 'Baseline']]
          };
        })
      });
      return cards;
    });
    var conSlot = slot(function (b) { return styleOf(b).id; }, function (b) {
      var st = styleOf(b), glider = num(st.baseWeight_kg, 1450) * 0.64;
      return ui.cards({
        path: 'body.construction', label: 'Body construction', columns: 3, compact: true,
        hint: 'Gauge, insulation and reinforcement of the shell on top of the material: period thin-gauge and lightweight shells shed mass (and refinement); reinforced and armoured bodies add it. The real model’s size scales the shell too.',
        options: (D.constructions || []).map(function (c) {
          var dKg = glider * (num(c.weightFactor, 1) - 1);
          return { id: c.id, name: c.name, desc: c.desc, price: c.price, badge: c.id === 'armoured' ? 'Exoskeleton' : c.id === 'classic' ? 'Pre-2000' : null,
            specs: [['Shell mass', '×' + fmt(c.weightFactor, 2)], ['Mass', Math.abs(dKg) < 1 ? 'Baseline' : (dKg > 0 ? '+' : '−') + fmt(Math.abs(dKg)) + ' kg'], ['Comfort', (c.comfort > 0 ? '+' : c.comfort < 0 ? '−' : '±') + fmt(Math.abs(num(c.comfort, 0)))]] };
        })
      });
    });
    root.appendChild(ui.section('Structure', 'The skeleton everything else bolts to.', chassisSlot, conSlot));

    /* ---- proportions */
    var wbR = R('body.wheelbase_mm'), tR = R('body.trackWidth_mm');
    var wb = ui.slider({
      path: 'body.wheelbase_mm', label: 'Wheelbase', min: wbR.min, max: wbR.max, step: wbR.step || 5, unit: 'mm',
      range: function (b) { var r = styleOf(b).wheelbaseRange; return [r[0], r[1]]; },
      resettable: false, ticks: false,
      hint: 'Longer = more stable at speed, more cabin and a smoother ride. Shorter = quicker rotation and a tighter turning circle.'
    });
    var tw = ui.slider({
      path: 'body.trackWidth_mm', label: 'Track width', min: tR.min, max: tR.max, step: tR.step || 5, unit: 'mm',
      ticks: [tR.min, 1600, tR.max],
      hint: 'Wider track reduces lateral load transfer (more grip, less roll) but needs wider arches and adds frontal area.'
    });
    var packaging = ui.kv([]);
    P.watch(packaging, function (b) {
      var st = styleOf(b), s = st.svg || {};
      var w = num(get(b, 'body.wheelbase_mm'), st.defaultWheelbase), t = num(get(b, 'body.trackWidth_mm'), 1600);
      var len = num(s.length_mm, 4600) + (w - st.defaultWheelbase);
      var ratio = w / t;
      packaging.set([
        ['Overall length', fmt(len) + ' mm'],
        ['Overall width', fmt(num(s.width_mm, 1900) + (t - 1600)) + ' mm'],
        ['Height', fmt(s.height_mm) + ' mm'],
        ['Overhangs F / R', fmt(s.frontOverhang_mm) + ' / ' + fmt(s.rearOverhang_mm) + ' mm'],
        ['Wheelbase : track', fmt(ratio, 2) + (ratio < 1.6 ? ' · agile' : ratio > 1.85 ? ' · stable' : ' · balanced')],
        ['Turning circle', '≈ ' + fmt(turningCircle_m(w, t), 1) + ' m'],
        ['Luggage', fmt(st.cargo_l) + ' L'],
        ['Fuel tank', st.tank_l ? fmt(st.tank_l) + ' L' : '—'],
        ['Engine placement', (st.allowedEnginePositions || []).join(' · ')]
      ]);
    });
    root.appendChild(ui.section('Proportions', 'Stretch or shrink the wheelbase within the shell\'s engineering limits.',
      proportionDiagram(), ui.grid(2, wb, tw), packaging));

    /* ---- doors / seats (only valid options for the current style) */
    var dsSlot = slot(function (b) { return styleOf(b).id; }, function (b) {
      var st = styleOf(b);
      var doors = ui.segmented({
        path: 'body.doors', label: 'Doors',
        options: st.doorOptions.map(function (n) { return { id: n, name: n + (n === 1 ? ' door' : ' doors') }; }),
        hint: st.doorOptions.length > 1 ? 'More doors add ~18 kg each and a little torsional flex.' : st.name + ' is offered with ' + st.doorOptions[0] + ' doors only.'
      });
      var seats = ui.segmented({
        path: 'body.seats', label: 'Seating',
        options: st.seatOptions.map(function (n) { return { id: n, name: n === 1 ? 'Single-seat' : n + ' seats' }; }),
        hint: 'Each extra row adds mass and moves the CG rearward; a single-seater centres the driver.'
      });
      return ui.grid(2, doors, seats);
    });
    root.appendChild(ui.section('Openings & seating', null, dsSlot));
  }

  /* ======================================================================
     PANEL: ENGINE
     ====================================================================== */
  function layoutOf(b) { return find('engineLayouts', get(b, 'engine.layout')) || D.engineLayouts[0]; }
  function aspOf(b) { return find('aspirations', get(b, 'engine.aspiration')) || D.aspirations[0]; }
  function fuelOf(b) { return find('fuels', get(b, 'engine.fuel')) || D.fuels[0]; }

  /** Bore/stroke estimate from displacement per cylinder and a layout-typical bore:stroke ratio. */
  function boreStroke(b) {
    var lay = layoutOf(b);
    if (lay.config === 'rotary') return null;
    var cyl = lay.cylinders || 4;
    var vc = num(get(b, 'engine.displacement_l'), 2) * 1e6 / cyl; // mm^3
    var k = { inline: 1.0, v: 1.12, flat: 1.25, w: 1.02 }[lay.config] || 1;
    if (get(b, 'engine.fuel') === 'diesel') k = 0.88;
    if (lay.id === 'V10' || lay.id === 'V12' || lay.id === 'flat-6') k += 0.05;
    var stroke = Math.cbrt(4 * vc / (Math.PI * k * k));
    return { bore: stroke * k, stroke: stroke, cc: vc / 1000 };
  }

  function knockWidget() {
    var m = meter();
    var line = el('div', { class: 'pp-readout' });
    var msg = el('div', { class: 'cb-hint' });
    var fixRow = el('div', { class: 'pp-btnrow' });
    var root = el('div', { class: 'pp-widget' }, el('div', { class: 'pp-title' }, 'Knock margin'), m, line, msg, fixRow);
    return ui.bind(root, '*', function (b) {
      var fuel = fuelOf(b), cr = num(get(b, 'engine.compression'), 10), boost = num(get(b, 'engine.boost_bar'), 0);
      var eff = D.effectiveCompression ? D.effectiveCompression(cr, boost) : cr * Math.sqrt(1 + boost);
      U.clear(fixRow);
      if (fuel.id === 'diesel') {
        m.set(0.5, 'good');
        line.innerHTML = '<span>Compression ignition</span><strong>' + fmt(cr, 1) + ':1 static</strong>';
        msg.textContent = 'Diesel cannot knock — the fuel auto-ignites by design. Higher compression improves cold starts and efficiency.';
        return;
      }
      var lim = num(fuel.knockLimit, 15.5), frac = eff / (lim * 1.15);
      var margin = (lim - eff) / lim;
      var kind = margin > 0.06 ? 'good' : margin > 0 ? 'warn' : 'bad';
      m.set(frac, kind, lim / (lim * 1.15));
      line.innerHTML = '<span>Effective ' + fmt(eff, 1) + ':1</span><strong>' + (margin >= 0 ? fmt(margin * 100, 0) + '% headroom' : fmt(-margin * 100, 0) + '% OVER') + '</strong><span>Limit ' + fmt(lim, 1) + ':1 (' + fuel.name.split(' ')[0] + ')</span>';
      msg.textContent = margin >= 0.06 ? 'Safe timing advance with room to spare.'
        : margin >= 0 ? 'Close to the detonation threshold — the ECU will pull timing on hot days.'
          : 'Detonation risk: the effective compression exceeds what this fuel tolerates. Lower compression or boost, or use a higher-octane fuel.';
      if (margin < 0.02) {
        var safeCr = U.round(clamp(lim * 0.96 / Math.sqrt(1 + boost), R('engine.compression').min, R('engine.compression').max), 1);
        if (safeCr < cr) fixRow.appendChild(ui.button('Set safe compression ' + fmt(safeCr, 1) + ':1', { kind: 'ghost', onClick: function () { setState('engine.compression', safeCr, 'Compression → ' + safeCr + ':1 (knock-safe)'); } }));
        var better = D.fuels.filter(function (f) { return f.id !== 'diesel' && num(f.knockLimit) * 0.98 > eff; }).sort(function (a, b2) { return a.pricePerUnit - b2.pricePerUnit; })[0];
        if (better && better.id !== fuel.id) fixRow.appendChild(ui.button('Switch to ' + better.name, { kind: 'ghost', onClick: function () { setState('engine.fuel', better.id, 'Fuel → ' + better.name); } }));
      }
    });
  }

  function geometryWidget() {
    var kv = ui.kv([]);
    var m = meter();
    var line = el('div', { class: 'pp-readout' });
    var root = el('div', { class: 'pp-widget' }, el('div', { class: 'pp-title' }, 'Bottom-end geometry'), kv, el('div', { class: 'pp-title' }, 'Mean piston speed at redline'), m, line);
    return ui.bind(root, '*', function (b) {
      var lay = layoutOf(b), bs = boreStroke(b), rpm = num(get(b, 'engine.redline_rpm'), 7000);
      if (!bs) {
        kv.set([['Rotors', lay.rotors || 2], ['Chamber volume', fmt(num(get(b, 'engine.displacement_l'), 1.3) / (lay.rotors || 2) / 2 * 1000) + ' cc/face'], ['Firing', 'Three power pulses per rotor revolution']]);
        m.set(0.3, 'good'); line.innerHTML = '<span>Rotary — no reciprocating pistons</span><strong>eccentric shaft ' + fmt(rpm) + ' rpm</strong>';
        return;
      }
      var mps = 2 * bs.stroke / 1000 * rpm / 60;
      kv.set([
        ['Cylinders', lay.cylinders + ' · ' + (lay.config === 'v' ? lay.bankAngle_deg + '° vee' : lay.config === 'flat' ? 'boxer' : lay.config)],
        ['Swept volume', fmt(bs.cc, 0) + ' cc / cyl'],
        ['Bore × stroke (est.)', fmt(bs.bore, 1) + ' × ' + fmt(bs.stroke, 1) + ' mm'],
        ['Bore : stroke', fmt(bs.bore / bs.stroke, 2) + (bs.bore > bs.stroke * 1.05 ? ' oversquare' : bs.bore < bs.stroke * 0.95 ? ' undersquare' : ' square')],
        ['Firing order', lay.firingOrder || '—']
      ]);
      var kind = mps < 21 ? 'good' : mps < 25 ? 'warn' : 'bad';
      m.set(mps / 30, kind, 25 / 30);
      line.innerHTML = '<span>' + fmt(mps, 1) + ' m/s</span><strong>' + (kind === 'good' ? 'Road-durable' : kind === 'warn' ? 'Race-engine territory' : 'Beyond F1 practice (≈25 m/s)') + '</strong>';
    });
  }

  function electricWidget() {
    var kv = ui.kv([]);
    var m = meter();
    var line = el('div', { class: 'pp-readout' });
    var msg = el('div', { class: 'cb-hint' });
    var root = el('div', { class: 'pp-widget' }, el('div', { class: 'pp-title' }, 'Pack analysis'), kv, el('div', { class: 'pp-title' }, 'Discharge capability vs motor demand'), m, line, msg);
    return ui.bind(root, '*', function (b) {
      var ch = find('batteryChemistries', get(b, 'engine.chemistry')) || D.batteryChemistries[0];
      var kwh = num(get(b, 'engine.battery_kwh'), 50), motors = num(get(b, 'engine.motors'), 1), kw = num(get(b, 'engine.motorPower_kw'), 150);
      var volt = num(get(b, 'engine.voltage'), 400);
      var cells = kwh * 1000 / num(ch.whPerKg, 180), packMass = cells * 1.28;
      var discharge = kwh * num(ch.cRate, 4), demand = motors * kw;
      var chargePeak = Math.min(volt >= 800 ? 350 : 150, kwh * num(ch.cRate, 4) * 0.55);
      var minutes = (0.7 * kwh) / Math.max(1, chargePeak * 0.72) * 60;
      var series = Math.round(volt / 3.7);
      kv.set([
        ['Pack mass (est.)', fmt(packMass) + ' kg'],
        ['Cell cost', money(kwh * num(ch.pricePerKwh, 130))],
        ['Configuration', series + 's · ' + fmt(volt) + ' V nominal'],
        ['Peak discharge', fmt(discharge) + ' kW (' + ch.cRate + 'C)'],
        ['DC fast charge', 'peak ' + fmt(chargePeak) + ' kW · 10→80% ≈ ' + fmt(minutes) + ' min'],
        ['Cycle life', fmt(ch.cycleLife) + ' cycles ≈ ' + fmt(ch.cycleLife * (get(b, 'engine.type') === 'ev' ? kwh * 5.5 : kwh * 6) / 1000) + 'k km'],
        ['Cold-weather capacity', fmt(num(ch.coldPerformance, 0.85) * 100) + '%']
      ]);
      var ratio = demand / Math.max(1, discharge);
      var kind = ratio <= 0.85 ? 'good' : ratio <= 1 ? 'warn' : 'bad';
      m.set(ratio / 1.5, kind, 1 / 1.5);
      line.innerHTML = '<span>Motors ' + fmt(demand) + ' kW</span><strong>' + fmt(ratio * 100) + '% of pack</strong><span>Pack ' + fmt(discharge) + ' kW</span>';
      msg.textContent = ratio > 1 ? 'The pack cannot supply full motor power — output will be battery-limited. Add capacity or choose a higher C-rate chemistry.'
        : ratio > 0.85 ? 'Pack runs near its discharge limit at full power — expect thermal derating on track.'
          : 'Ample discharge headroom for repeated full-power pulls.';
    });
  }

  function buildEngine(root, P) {
    root.appendChild(ui.issues('engine'));

    /* ---- powertrain type */
    var typeSeg = ui.segmented({
      path: 'engine.type', label: 'Powertrain',
      options: (D.engineTypes || [{ id: 'ice', name: 'Combustion' }, { id: 'hybrid', name: 'Hybrid' }, { id: 'ev', name: 'Full Electric' }]).map(function (t) {
        return { id: t.id, name: t.name, desc: t.desc + (t.price ? ' (' + ui.priceText(t.price) + ')' : ''), icon: typeIcons[t.id] };
      }),
      hint: 'Switching powertrain reconfigures the gearbox automatically (EVs default to a single-speed reduction).'
    });

    /* ---- output: dyno + tiles */
    var tiles = statGrid([
      { key: 'hp', label: 'Peak power', unit: 'hp', decimals: 0 },
      { key: 'nm', label: 'Peak torque', unit: 'Nm', decimals: 0 },
      { key: 'spec', label: 'Specific output', unit: 'hp/L', decimals: 0 },
      { key: 'rel', label: 'Reliability', unit: '/100', decimals: 0 },
      { key: 'prpm', label: 'Power peak', unit: 'rpm', decimals: 0 },
      { key: 'trpm', label: 'Torque peak', unit: 'rpm', decimals: 0 },
      { key: 'p2w', label: 'Power / weight', unit: 'hp/t', decimals: 0 },
      { key: 'snd', label: 'Exhaust', unit: 'dB', decimals: 0 }
    ]);
    var dynoNote = el('div', { class: 'cb-hint' });
    P.watch(tiles, function (b, m) {
      var ev = isElectric(b);
      var disp = num(get(b, 'engine.displacement_l'), 0);
      var hp = m.power_hp;
      var spec = null;
      if (!ev && hp && disp) spec = hp / disp;
      else if (ev && hp) spec = { value: m.weight_kg ? hp / (m.weight_kg / 1000) : null, unit: 'hp/t' };
      tiles.setAll({
        hp: hp, nm: m.torque_nm, rel: m.reliabilityScore,
        spec: spec,
        prpm: m.peakPowerRpm, trpm: m.peakTorqueRpm,
        p2w: m.powerToWeight_hpPerTon != null ? m.powerToWeight_hpPerTon : (hp && m.weight_kg ? hp / m.weight_kg * 1000 : null),
        snd: ev ? { value: 'Silent', unit: '' } : m.exhaust_db
      });
      tiles.tiles.spec.querySelector('.cb-stat-label').textContent = ev ? 'Power density' : 'Specific output';
      if (m._estimated || hp == null) dynoNote.textContent = 'Live dyno requires the physics engine (CB.physics).';
      else dynoNote.textContent = (ev ? 'EV: flat torque to base speed, then constant power. ' : '') +
        fmt(hp) + ' hp (' + fmt(m.power_kw != null ? m.power_kw : hp / 1.341) + ' kW) · ' + fmt(m.torque_nm) + ' Nm (' + fmt(nmToLbft(m.torque_nm || 0)) + ' lb-ft)' +
        (m.redlineRpm ? ' · limiter ' + fmt(m.redlineRpm) + ' rpm' : '');
    });
    var dyno = liveChart(P, 'dyno', { title: 'Dynamometer — power & torque vs rpm', height: 240 });
    root.appendChild(ui.section('Powertrain', 'Choose how the car makes its power — everything below adapts.', typeSeg));
    root.appendChild(ui.section('Output', 'Live chassis-dyno simulation of the current specification.', tiles, dyno, dynoNote));

    /* ---- structural slot: rebuilt only when the powertrain type changes */
    root.appendChild(slot(function (b) { return get(b, 'engine.type', 'ice'); }, function (b) {
      var type = get(b, 'engine.type', 'ice');
      var parts = [];
      if (type !== 'ev') parts = parts.concat(iceSections(type));
      if (type !== 'ice') parts = parts.concat(electricSections(type));
      if (type === 'ev') parts.push(ui.section('Sound & thermal', null, note('Full-electric builds have no exhaust or combustion cooling. The exhaust and fuel selections are retained but ignored, so switching back to combustion restores them.', 'info'),
        coolingCards('Battery & inverter cooling', 'Larger heat exchangers keep the pack in its optimal 25–40 °C window during repeated launches and fast charging.')));
      return parts;
    }, 'pp-stack'));
  }

  function coolingCards(label, hintText) {
    return ui.cards({
      path: 'engine.cooling', label: label, columns: 3, compact: true, hint: hintText,
      options: D.coolings.map(function (c) { return { id: c.id, name: c.name, desc: c.desc, price: c.price, icon: coolingIcon(c), specs: [['Heat capacity', '×' + fmt(c.heatCapacity, 1)], ['Mass', '+' + fmt(c.weight_kg) + ' kg']] }; })
    });
  }

  function iceSections(type) {
    var out = [];
    var dR = R('engine.displacement_l'), bR = R('engine.boost_bar'), cR = R('engine.compression'), rR = R('engine.redline_rpm');

    /* layout */
    var layoutCards = ui.cards({
      path: 'engine.layout', label: 'Cylinder architecture', columns: 3,
      optionDisabled: compatFn('engine.layout'),
      hint: 'Greyed layouts do not package in the current body. Smoothness affects refinement; length affects where the engine can sit.',
      options: D.engineLayouts.map(function (l) {
        return {
          id: l.id, name: l.name, desc: l.desc, price: l.basePrice != null ? l.basePrice : l.price, icon: layoutIcon(l),
          badge: l.id === 'W16' ? 'Halo' : l.id === 'V12' ? 'Flagship' : null,
          specs: [['Displacement', fmt(l.displacementRange[0], 1) + '–' + fmt(l.displacementRange[1], 1) + ' L'], ['Mass', fmt(l.baseWeight_kg) + ' kg'], ['Smoothness', fmt(l.smoothness * 100) + '%'], ['Typical redline', fmt(l.typicalRedline)]]
        };
      })
    });
    var disp = ui.slider({
      path: 'engine.displacement_l', label: 'Displacement', min: dR.min, max: dR.max, step: 0.1, unit: 'L',
      range: function (b) { var r = layoutOf(b).displacementRange; return [r[0], r[1]]; },
      hint: 'Swept volume. More litres = more torque everywhere, more mass and fuel use. Range is limited by the block\'s bore spacing.'
    });
    out.push(ui.section('Engine block', 'The heart of the build.', layoutCards, ui.grid(2, disp, geometryWidget())));

    /* aspiration & boost */
    var aspCards = ui.cards({
      path: 'engine.aspiration', label: 'Induction', columns: 3, compact: false,
      hint: 'Forced induction multiplies output but adds heat, mass and (for exhaust-driven turbos) throttle lag.',
      options: D.aspirations.map(function (a) {
        return { id: a.id, name: a.name, desc: a.desc, price: a.price, icon: aspirationIcon(a),
          specs: [['Lag', a.lag ? fmt(a.lag * 100) + '%' : 'None'], ['Max boost', a.maxBoost_bar ? fmt(a.maxBoost_bar, 1) + ' bar' : '—'], ['Torque', a.torqueShape || '—'], ['Mass', a.weight_kg ? '+' + a.weight_kg + ' kg' : '—']] };
      })
    });
    var boost = ui.slider({
      path: 'engine.boost_bar', label: 'Boost pressure', min: 0.2, max: bR.max, step: bR.step || 0.05, unit: 'bar',
      visible: function (b) { return get(b, 'engine.aspiration') !== 'na'; },
      range: function (b) { var a = aspOf(b); return [0.2, Math.max(0.3, num(a.maxBoost_bar, 2))]; },
      format: function (v) { return fmt(v, 2) + ' bar · ' + fmt(v * 14.5038, 1) + ' psi'; },
      hint: 'Gauge pressure above atmospheric. Each bar roughly doubles air mass, but raises effective compression and thermal load.'
    });
    var naNote = ui.bind(note('Naturally aspirated — no boost to adjust. Power comes from revs, displacement and compression.', 'info'), 'engine.aspiration', function () {}, { visible: function (b) { return get(b, 'engine.aspiration') === 'na'; } });
    var comp = ui.slider({
      path: 'engine.compression', label: 'Static compression ratio', min: cR.min, max: cR.max, step: cR.step || 0.1,
      format: function (v) { return fmt(v, 1) + ':1'; }, ticks: [cR.min, 10, 12, cR.max],
      hint: 'Higher compression extracts more energy per bang (efficiency & response) but must stay below the fuel\'s knock limit once boost is applied.'
    });
    out.push(ui.section('Induction & combustion', null, aspCards, ui.grid(2, ui.group(null, boost, naNote, comp), knockWidget())));

    /* fuel, redline, position */
    var fuelSel = ui.select({
      path: 'engine.fuel', label: 'Fuel',
      options: D.fuels.map(function (f) { return { id: f.id, name: f.name + (f.octane ? ' · knock limit ' + fmt(f.knockLimit, 1) + ':1' : ' · ' + fmt(f.redlineCap_rpm) + ' rpm cap'), price: f.price }; }),
      hint: 'Octane governs how much compression and boost are safe. E85 & race fuel unlock aggressive tunes; diesel caps revs but brings torque and range.'
    });
    var redline = ui.slider({
      path: 'engine.redline_rpm', label: 'Redline', min: rR.min, max: rR.max, step: rR.step || 100, unit: 'rpm',
      range: function (b) { return [rR.min, num(fuelOf(b).redlineCap_rpm, rR.max)]; },
      format: function (v) { return fmt(v) + ' rpm'; },
      hint: 'Higher redlines stretch the power band and gear speeds. Piston speed (shown in the geometry card) rises with it — durability falls.'
    });
    var position = ui.segmented({
      path: 'engine.position', label: 'Engine position',
      options: (D.enginePositions || []).map(function (p) { return { id: p.id, name: p.name + (p.price ? ' (' + ui.priceText(p.price) + ')' : ''), desc: p.desc }; }),
      optionDisabled: compatFn('engine.position'),
      hint: 'Front: balanced & practical. Mid: lowest polar inertia, best turn-in. Rear: maximum traction under power, a lively tail at the limit.'
    });
    var redKv = ui.kv([]);
    var redWrap = el('div', null, redline, redKv);
    P_watchProxy(redWrap, function (b) {
      var lay = layoutOf(b);
      redKv.set([['Layout typical', fmt(lay.typicalRedline) + ' rpm'], ['Fuel cap', fuelOf(b).redlineCap_rpm ? fmt(fuelOf(b).redlineCap_rpm) + ' rpm' : 'none']]);
    });
    var limiterSel = ui.select({
      path: 'engine.speedLimiter_kph', label: 'Electronic speed limiter',
      options: (D.speedLimiters || []).map(function (o) { return { id: o.id, name: o.id ? o.name + ' — ' + o.desc : 'Off — no electronic cap' }; }),
      hint: 'ECU top-speed cap (German makers’ 250 km/h, van and truck governors, hypercar speed keys). Gearing, drag and the tyres’ speed rating can still stop the car sooner.'
    });
    out.push(ui.section('Fuel, revs & placement', null, ui.grid(2, fuelSel, redWrap), position, limiterSel));

    /* tune, exhaust, cooling */
    var tune = ui.cards({
      path: 'engine.tune', label: 'Calibration', columns: 3, compact: true,
      hint: 'Software and hardware tuning stages. Every step up trades reliability for power — Time Attack needs rebuilds measured in hours.',
      options: D.tunes.map(function (t) {
        return { id: t.id, name: t.name, desc: t.desc, price: t.price, icon: gaugeIcon(t.powerMult),
          specs: [['Power', (t.powerMult >= 1 ? '+' : '') + fmt((t.powerMult - 1) * 100) + '%'], ['Reliability', t.reliabilityHit > 0 ? '−' + fmt(t.reliabilityHit * 100) + '%' : t.reliabilityHit < 0 ? '+' + fmt(-t.reliabilityHit * 100) + '%' : '±0'], ['Efficiency', '×' + fmt(num(t.efficiencyMult, 1), 2)]] };
      })
    });
    var exhaust = ui.cards({
      path: 'engine.exhaust', label: 'Exhaust system', columns: 3, compact: true,
      hint: 'Freer flow adds a few percent of power and a lot of character. Above ~100 dB drive-by noise most markets will refuse registration.',
      options: D.exhausts.map(function (x) {
        return { id: x.id, name: x.name, desc: x.desc, price: x.price, icon: exhaustIcon(x),
          badge: x.loudness_db >= 105 ? 'Track only' : null,
          specs: [['Power', '+' + fmt((x.powerMult - 1) * 100) + '%'], ['Loudness', x.loudnessQuiet_db ? fmt(x.loudnessQuiet_db) + '–' + fmt(x.loudness_db) + ' dB' : fmt(x.loudness_db) + ' dB'], ['Mass', (x.weight_kg > 0 ? '+' : '') + fmt(x.weight_kg) + ' kg']] };
      })
    });
    out.push(ui.section('Calibration, sound & cooling', null, tune, exhaust,
      coolingCards('Cooling package', 'Heat capacity determines how long the engine (and brakes) sustain full power before derating. Essential with Stage 2+ tunes or track use.')));
    if (type === 'hybrid') out.unshift(note('Hybrid: the combustion engine below is paired with ' + 'the electric system further down. Motor torque fills the turbo lag and boosts peak output.', 'info'));
    return out;
  }

  /* Small indirection so iceSections() (which has no P) can register a watcher on the current engine panel. */
  var enginePanelRef = null;
  function P_watchProxy(node, fn) {
    if (enginePanelRef) enginePanelRef.watch(node, fn);
    return node;
  }

  function electricSections(type) {
    var mr = (D.motorRanges && D.motorRanges[type]) || (type === 'hybrid' ? [1, 2] : [1, 4]);
    var br = (D.batteryRanges && D.batteryRanges[type]) || (type === 'hybrid' ? [1, 30] : [30, 200]);
    var mpR = R('engine.motorPower_kw');
    var motorOpts = [];
    var motorNames = { 1: 'Single', 2: 'Dual', 3: 'Tri', 4: 'Quad' };
    for (var i = mr[0]; i <= mr[1]; i++) motorOpts.push({ id: i, name: motorNames[i] + ' motor' + (i > 1 ? 's' : ''), desc: i === 4 ? 'One motor per wheel — true torque vectoring' : i === 3 ? (type === 'hybrid' ? 'Crank motor + twin-motor front e-axle' : 'One front, two rear') : i === 2 ? (type === 'hybrid' ? 'Crank-integrated + axle motor' : 'One per axle') : 'Single axle' });
    var motors = ui.segmented({ path: 'engine.motors', label: 'Motor count', options: motorOpts,
      hint: type === 'hybrid' ? 'A second motor on the non-engine axle gives through-the-road all-wheel drive.' : 'More motors = more power and torque-vectoring authority, at +45 kg and cost each.' });
    var power = ui.slider({
      path: 'engine.motorPower_kw', label: 'Power per motor', min: mpR.min, max: type === 'hybrid' ? 250 : mpR.max, step: mpR.step || 5, unit: 'kW',
      format: function (v) { return fmt(v) + ' kW · ' + fmt(kwToHp(v)) + ' hp'; },
      ticks: type === 'hybrid' ? [mpR.min, 150, 250] : [mpR.min, 250, mpR.max],
      hint: 'Continuous rating of each permanent-magnet synchronous motor. Peak output is also capped by what the pack can discharge.'
    });
    var battery = ui.slider({
      path: 'engine.battery_kwh', label: type === 'hybrid' ? 'Hybrid battery' : 'Battery capacity', min: br[0], max: br[1], step: type === 'hybrid' ? 0.5 : 1, unit: 'kWh',
      ticks: type === 'hybrid' ? [1, 10, 20, 30] : [30, 100, 150, 200],
      hint: type === 'hybrid' ? 'Small packs (≤2 kWh) are power buffers; 10 kWh+ makes it a plug-in with meaningful electric-only range.' : 'Usable capacity. Range scales with kWh — but so do mass, cost and charging time.'
    });
    var chem = ui.cards({
      path: 'engine.chemistry', label: 'Cell chemistry', columns: 2, compact: true,
      hint: 'Energy density sets pack mass; C-rate sets peak power and charge speed; cycle life sets longevity.',
      options: D.batteryChemistries.map(function (c) {
        return { id: c.id, name: c.name, desc: c.desc, price: 0, icon: chemistryIcon(c),
          badge: c.id === 'solid-state' ? 'Next-gen' : null,
          specs: [['Density', fmt(c.whPerKg) + ' Wh/kg'], ['C-rate', c.cRate + 'C'], ['Cycles', fmt(c.cycleLife)], ['Cost', '$' + fmt(c.pricePerKwh) + '/kWh']] };
      })
    });
    var volt = ui.segmented({
      path: 'engine.voltage', label: 'System voltage',
      options: (D.voltages || [{ id: 400, name: '400 V' }, { id: 800, name: '800 V' }]).map(function (v) { return { id: v.id, name: v.name + (v.price ? ' (' + ui.priceText(v.price) + ')' : ''), desc: v.desc }; }),
      hint: '800 V halves current for the same power — thinner cables, cooler inverters, 350 kW charging.'
    });
    var regen = ui.segmented({
      path: 'engine.regen', label: 'Regenerative braking',
      options: [{ id: 0, name: 'Off', desc: 'Free-wheeling coast' }, { id: 1, name: 'Low', desc: 'Gentle, ICE-like engine braking' }, { id: 2, name: 'Medium', desc: 'Recovers most braking energy' }, { id: 3, name: 'One-pedal', desc: 'Strong regen — stops the car without the brake pedal' }],
      hint: 'Stronger regen recovers more energy (range) and spares the friction brakes, but alters balance on corner entry.'
    });
    var evLimiter = type === 'ev' ? ui.select({
      path: 'engine.speedLimiter_kph', label: 'Electronic speed limiter',
      options: (D.speedLimiters || []).map(function (o) { return { id: o.id, name: o.id ? o.name + ' — ' + o.desc : 'Off — no electronic cap' }; }),
      hint: 'Inverter / ECU top-speed cap. Motor rpm, drag and the tyres’ speed rating can still stop the car sooner.'
    }) : null;
    return [
      ui.section(type === 'hybrid' ? 'Hybrid electric system' : 'Electric drive units', type === 'hybrid' ? 'Motor and buffer battery that work alongside the engine.' : 'Motors, inverters and the traction battery.',
        motors, power, evLimiter),
      ui.section('Energy storage', null, ui.grid(2, ui.group(null, battery, volt, regen), electricWidget()), chem)
    ];
  }

  /* ======================================================================
     PANEL: TRANSMISSION
     ====================================================================== */
  function transOf(b) { return find('transmissions', get(b, 'transmission.type')) || D.transmissions[0]; }
  var RATIO_GAP = 0.02;

  function progressive(first, top, n, p) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0 : Math.pow(i / (n - 1), p);
      out.push(Math.exp(Math.log(first) + (Math.log(top) - Math.log(first)) * t));
    }
    return out;
  }
  function sanitizeRatios(arr) {
    var rr = R('transmission.ratio');
    var out = arr.map(function (r) { return r2(clamp(r, rr.min, rr.max)); });
    for (var i = out.length - 2; i >= 0; i--) if (out[i] < out[i + 1] + RATIO_GAP) out[i] = r2(out[i + 1] + RATIO_GAP);
    for (var j = 1; j < out.length; j++) if (out[j] > out[j - 1] - RATIO_GAP) out[j] = r2(out[j - 1] - RATIO_GAP);
    return out.map(function (r) { return r2(clamp(r, rr.min, rr.max)); });
  }
  function reshapeRatios(b, mode) {
    var ratios = (get(b, 'transmission.ratios') || []).slice(), n = ratios.length;
    if (n < 2) return null;
    var first = ratios[0], top = ratios[n - 1];
    if (mode === 'close') {
      var nf = first * 0.9, nt = top * 1.1;
      var minSpread = Math.pow(1.05, n - 1);
      if (nf / nt < minSpread) { var mid = Math.sqrt(first * top); nf = mid * Math.sqrt(minSpread); nt = mid / Math.sqrt(minSpread); }
      if (Math.abs(nf - first) < 0.02 && Math.abs(nt - top) < 0.02) return 'limit';
      return sanitizeRatios(progressive(nf, nt, n, 0.92));
    }
    if (mode === 'long') {
      return sanitizeRatios(progressive(first * 0.95, Math.max(R('transmission.ratio').min, top * 0.88), n, 0.8));
    }
    return null;
  }

  function ratioEditor(P) {
    return slot(function (b) { return get(b, 'transmission.type') + '|' + get(b, 'transmission.gears'); }, function (b) {
      var tr = transOf(b), n = num(get(b, 'transmission.gears'), 1), rr = R('transmission.ratio');
      var wrap = el('div', { class: 'pp-gears' });
      var defaults = tr.defaultRatios ? tr.defaultRatios(n) : [];
      for (var i = 0; i < n; i++) {
        (function (i) {
          var sl = ui.slider({
            path: 'transmission.ratios', label: n === 1 ? (tr.id === 'cvt' ? 'Lowest pulley ratio' : 'Reduction ratio') : 'Gear ' + (i + 1),
            min: rr.min, max: rr.max, step: 0.01, decimals: 2, ticks: false,
            format: function (v) { return fmt(v, 2) + ':1'; },
            defaultValue: defaults[i],
            get: function (bb) { var a = get(bb, 'transmission.ratios') || []; return a[i]; },
            set: function (v) {
              var a = (get(cur(), 'transmission.ratios') || []).slice();
              if (a.length !== n) return;
              a[i] = r2(v);
              CB.state.set('transmission.ratios', a, { label: 'Gear ' + (i + 1) + ' ratio → ' + fmt(v, 2) });
            },
            range: function (bb) {
              var a = get(bb, 'transmission.ratios') || [];
              var lo = i < a.length - 1 ? r2(a[i + 1] + RATIO_GAP) : rr.min;
              var hi = i > 0 ? r2(a[i - 1] - RATIO_GAP) : rr.max;
              if (hi < lo) hi = lo;
              return [lo, hi];
            },
            resettable: true
          });
          var meta = el('div', { class: 'pp-gear-meta' });
          var bar = el('div', { class: 'pp-gear-bar' });
          var row = el('div', { class: 'pp-gear-row' }, el('div', { class: 'pp-gear-no', 'aria-hidden': 'true' }, n === 1 ? '1' : String(i + 1)), sl, el('div', null, meta, bar));
          P.watch(row, function (bb, m) {
            var a = get(bb, 'transmission.ratios') || [];
            var fd = num(get(bb, 'transmission.finalDrive'), 3.42);
            var gs = (m.gearSpeeds || [])[i];
            var step = i > 0 && a[i - 1] ? (1 - a[i] / a[i - 1]) * 100 : null;
            meta.innerHTML = '<strong>' + fmt((a[i] || 0) * fd, 2) + '</strong> overall<br>' +
              (gs ? fmt(gs.maxKph) + ' km/h' : '—') + (step != null ? ' · −' + fmt(step) + '%' : '');
            bar.style.width = clamp((a[i] || 0) / (a[0] || 1), 0.05, 1) * 100 + '%';
          });
          wrap.appendChild(row);
        })(i);
      }
      return wrap;
    });
  }

  function gearTable() {
    var table = el('table', { class: 'pp-table' });
    var wrap = el('div', { class: 'pp-table-wrap' }, table);
    wrap._update = function (b, m) {
      var gs = m.gearSpeeds || [];
      var a = get(b, 'transmission.ratios') || [];
      var fd = num(get(b, 'transmission.finalDrive'), 3.42);
      var red = isElectric(b) ? null : num(get(b, 'engine.redline_rpm'), 7000);
      var head = '<thead><tr><th>Gear</th><th>Ratio</th><th>Overall</th><th>Max km/h</th><th>Max mph</th><th>Step</th><th>' + (red ? 'RPM after shift' : 'Motor rpm @ max') + '</th></tr></thead>';
      var top = m.topSpeed_kph;
      var rows = gs.map(function (g, i) {
        var r = g.ratio != null ? g.ratio : a[i];
        var step = i > 0 && gs[i - 1] ? (1 - r / (gs[i - 1].ratio != null ? gs[i - 1].ratio : a[i - 1])) * 100 : null;
        var after = red && i < gs.length - 1 ? red * (gs[i + 1].ratio != null ? gs[i + 1].ratio : a[i + 1]) / r : null;
        var isTop = top && g.maxKph >= top * 0.98 && (i === 0 || gs[i - 1].maxKph < top * 0.98);
        return '<tr' + (isTop ? ' class="is-top" title="Top speed is reached in this gear"' : '') + '><td>' + g.gear + '</td><td>' + fmt(r, 2) + '</td><td>' + fmt(r * fd, 2) + '</td><td>' + fmt(g.maxKph) + '</td><td>' + fmt(kphToMph(g.maxKph)) + '</td><td>' + (step != null ? '−' + fmt(step) + '%' : '—') + '</td><td>' + (after ? fmt(after) : red ? '—' : fmt(maxRpm(b))) + '</td></tr>';
      }).join('');
      table.innerHTML = head + '<tbody>' + rows + '</tbody>';
    };
    return wrap;
  }

  function buildTransmission(root, P) {
    root.appendChild(ui.issues('transmission'));

    var typeCards = ui.cards({
      path: 'transmission.type', label: 'Gearbox type', columns: 3,
      optionDisabled: compatFn('transmission.type'),
      hint: 'Shift time costs acceleration on every upshift; efficiency is lost to heat at every speed.',
      options: D.transmissions.map(function (t) {
        return { id: t.id, name: t.name, desc: t.desc, price: t.price, icon: transIcon(t),
          badge: t.id === 'sequential' ? 'Motorsport' : t.id === 'single-speed' ? 'EV' : null,
          specs: [['Gears', t.gearRange[0] === t.gearRange[1] ? (t.id === 'cvt' ? '∞ (CVT)' : '1') : t.gearRange[0] + '–' + t.gearRange[1]], ['Shift', t.shiftTime_s ? fmt(t.shiftTime_s * 1000) + ' ms' : 'seamless'], ['Efficiency', fmt(t.efficiency * 100) + '%'], ['Torque cap', fmt(t.torqueLimit_nm) + ' Nm']] };
      })
    });

    var stats = statGrid([
      { key: 'shift', label: 'Shift time', unit: 'ms', decimals: 0 },
      { key: 'eff', label: 'Mech. efficiency', unit: '%', decimals: 0 },
      { key: 'mass', label: 'Gearbox mass', unit: 'kg', decimals: 0 },
      { key: 'spread', label: 'Ratio spread', decimals: 2 },
      { key: 'top', label: 'Top speed', unit: 'km/h', decimals: 0 },
      { key: 'limit', label: 'Limited by', decimals: 0 }
    ]);
    var capMeter = meter(), capLine = el('div', { class: 'pp-readout' });
    var capWidget = el('div', { class: 'pp-widget' }, el('div', { class: 'pp-title' }, 'Torque capacity'), capMeter, capLine);
    P.watch(stats, function (b, m) {
      var t = transOf(b), a = get(b, 'transmission.ratios') || [];
      stats.setAll({
        shift: t.shiftTime_s ? t.shiftTime_s * 1000 : { value: 'Seamless', unit: '' },
        eff: t.efficiency * 100, mass: t.weight_kg,
        spread: a.length > 1 ? a[0] / a[a.length - 1] : (t.ratioSpan ? t.ratioSpan[0] / t.ratioSpan[1] : { value: 'Fixed', unit: '' }),
        top: m.topSpeed_kph, limit: m.topSpeedLimitedBy ? { value: U.capitalize ? U.capitalize(m.topSpeedLimitedBy) : m.topSpeedLimitedBy, unit: '' } : null
      });
      var tq = num(m.torque_nm, NaN), cap = num(t.torqueLimit_nm, 1000);
      if (!isFinite(tq)) { capMeter.set(0, null); capLine.innerHTML = '<span>Rated ' + fmt(cap) + ' Nm</span><strong>engine torque unknown</strong>'; return; }
      var f = tq / cap;
      capMeter.set(f / 1.3, f <= 0.85 ? 'good' : f <= 1 ? 'warn' : 'bad', 1 / 1.3);
      capLine.innerHTML = '<span>Input ' + fmt(tq) + ' Nm</span><strong>' + fmt(f * 100) + '% of rating</strong><span>Rated ' + fmt(cap) + ' Nm</span>';
    });
    root.appendChild(ui.section('Gearbox', 'How power reaches the driveline — and how fast it changes gear.', typeCards, stats, capWidget));

    /* gear count + ratio editor + presets */
    var countSlot = slot(function (b) { return get(b, 'transmission.type'); }, function (b) {
      var t = transOf(b);
      if (t.gearRange[0] === t.gearRange[1]) {
        return note(t.id === 'cvt'
          ? 'CVT: the belt varies the ratio continuously between ' + (t.ratioSpan ? fmt(t.ratioSpan[0], 2) + ' and ' + fmt(t.ratioSpan[1], 2) : 'its limits') + ', holding the engine at peak efficiency or peak power. Set the lowest pulley ratio below.'
          : 'Single-speed reduction: one fixed ratio from motor to wheels. Choose it to balance launch torque against the motor\'s maximum speed (' + fmt((D.constants && D.constants.evMaxRpm) || 16000) + ' rpm).', 'info');
      }
      var opts = [];
      for (var g = t.gearRange[0]; g <= t.gearRange[1]; g++) opts.push({ id: g, name: g + '-speed' });
      return ui.segmented({ path: 'transmission.gears', label: 'Forward gears', options: opts,
        hint: 'More ratios keep the engine nearer its power peak and allow a taller cruising gear — at the cost of more shifts and weight. Changing the count regenerates the ratio set.' });
    });

    var presetRow = el('div', { class: 'pp-btnrow' },
      ui.button('Reset to optimal', { kind: 'ghost', icon: ui.icons && ui.icons.reset, title: 'Restore the factory-optimised progression for this gearbox and gear count', onClick: function () {
        var b = cur(), t = transOf(b), n = num(get(b, 'transmission.gears'), 1);
        if (t.defaultRatios) { setState('transmission.ratios', t.defaultRatios(n), 'Gear ratios → optimal'); toast('Ratios reset to the optimal progression', 'success'); }
      } }),
      ui.button('Close-ratio', { kind: 'ghost', title: 'Tighten the spacing — smaller rpm drops between gears, lower top gear', onClick: function () {
        var r = reshapeRatios(cur(), 'close');
        if (r === 'limit') toast('Already at the closest practical spacing (5% steps)', 'warning');
        else if (r) { setState('transmission.ratios', r, 'Gear ratios → close-ratio'); toast('Close-ratio set applied', 'success'); }
      } }),
      ui.button('Long-ratio', { kind: 'ghost', title: 'Taller gearing — higher speed in every gear, relaxed cruising, softer acceleration', onClick: function () {
        var r = reshapeRatios(cur(), 'long');
        if (r) { setState('transmission.ratios', r, 'Gear ratios → long-ratio'); toast('Long-ratio set applied', 'success'); }
      } }),
      ui.button('Gear for top speed', { kind: 'ghost', title: 'Adjust the final drive so top gear runs out right at the drag-limited top speed', onClick: function () {
        var b = cur(), m = metricsFor(b), fd = num(get(b, 'transmission.finalDrive'), 3.42), fr = R('transmission.finalDrive');
        var a = get(b, 'transmission.ratios') || [], rTop = a[a.length - 1];
        if (!m.topSpeed_kph || !rTop) { toast('Top-speed data unavailable (physics engine not loaded)', 'warning'); return; }
        var nfd;
        if (m.topSpeedLimitedBy === 'redline') nfd = fd * 0.92;
        else {
          var circ = Math.PI * drivenAxleTireDiameter(b) / 1000;
          nfd = maxRpm(b) * circ * 60 / 1000 / (m.topSpeed_kph * 1.03 * rTop);
        }
        nfd = r2(clamp(nfd, fr.min, fr.max));
        if (Math.abs(nfd - fd) < 0.01) { toast('Final drive is already matched to top speed', 'info'); return; }
        setState('transmission.finalDrive', nfd, 'Final drive → ' + fmt(nfd, 2) + ' (top-speed match)');
        toast('Final drive set to ' + fmt(nfd, 2) + ':1' + (m.topSpeedLimitedBy === 'redline' ? ' — was redline-limited, iterate again if needed' : ''), 'success');
      } })
    );
    var presetVis = ui.bind(el('div', null, presetRow), 'transmission.gears', function (b) {
      var multi = num(get(b, 'transmission.gears'), 1) > 1;
      presetRow.querySelectorAll('button').forEach(function (btn, idx) { if (idx === 1 || idx === 2) btn.hidden = !multi; });
    });
    root.appendChild(ui.section('Ratios', 'Drag a gear to re-cut it. Each ratio is held between its neighbours so the box always stays progressive.',
      countSlot, presetVis, ratioEditor(P)));

    /* final drive & launch */
    var fdR = R('transmission.finalDrive');
    var fdSlider = ui.slider({
      path: 'transmission.finalDrive', label: 'Final drive', min: fdR.min, max: fdR.max, step: fdR.step || 0.01, decimals: 2,
      format: function (v) { return fmt(v, 2) + ':1'; }, ticks: [fdR.min, 3.5, 4.5, fdR.max],
      hint: 'Multiplies every gear. Shorter (higher number) = harder acceleration, lower top speed in each gear. Taller = calmer cruising, better economy.'
    });
    var launch = ui.toggle({
      path: 'transmission.launchControl', label: 'Launch control', price: opt('launchControl', 900),
      hint: 'Holds the optimal launch rpm and meters wheelslip off the line — typically worth 0.1–0.3 s to 60 mph.'
    });
    var cruise = ui.kv([]);
    P.watch(cruise, function (b, m) {
      var a = get(b, 'transmission.ratios') || [], fd = num(get(b, 'transmission.finalDrive'), 3.42);
      var circ = Math.PI * drivenAxleTireDiameter(b) / 1000;
      function rpmAt(kph, r) { return kph * 1000 / 60 / circ * r * fd; }
      var topR = a[a.length - 1] || 1;
      cruise.set([
        ['Driven tyre diameter', fmt(drivenAxleTireDiameter(b)) + ' mm'],
        [isElectric(b) ? 'Motor rpm @ 100 km/h' : 'Engine rpm @ 100 km/h (top)', fmt(rpmAt(100, topR))],
        [isElectric(b) ? 'Motor rpm @ 130 km/h' : 'Engine rpm @ 130 km/h (top)', fmt(rpmAt(130, topR))],
        ['Overall 1st-gear ratio', fmt((a[0] || 0) * fd, 2) + ':1'],
        ['0–60 mph', m.zeroTo60_s != null ? fmt(m.zeroTo60_s, 2) + ' s' + (m.zeroTo60_note ? ' · ' + m.zeroTo60_note : '') : '—']
      ]);
    });
    root.appendChild(ui.section('Final drive & launch', null, ui.grid(2, ui.group(null, fdSlider, launch), cruise)));

    /* gear speeds */
    var table = gearTable();
    P.watch(table, function (b, m) { table._update(b, m); });
    var chart = liveChart(P, 'gears', { title: 'Engine speed vs road speed — every gear', height: 240 });
    root.appendChild(ui.section('Gear speeds', 'Maximum road speed in each gear at the limiter, and the rpm you land on after each upshift.', chart, table));
  }

  /* ======================================================================
     PANEL: DRIVETRAIN
     ====================================================================== */
  function diffOf(b, axle) { return find('differentials', get(b, 'drivetrain.' + axle + 'Diff')) || { name: '—', lockFactor: 0 }; }

  function drivetrainDiagram() {
    var host = el('div', { class: 'pp-diagram', role: 'img', 'aria-label': 'Drivetrain torque-flow diagram' });
    var lastKey = '';
    return ui.bind(host, '*', function (b) {
      var layout = get(b, 'drivetrain.layout', 'rwd'), split = num(get(b, 'drivetrain.torqueSplitFront_pct'), 0);
      var type = get(b, 'engine.type', 'ice'), pos = get(b, 'engine.position', 'front'), motors = num(get(b, 'engine.motors'), 1);
      var tv = !!get(b, 'drivetrain.torqueVectoring'), tc = num(get(b, 'drivetrain.tractionControl'), 2);
      var fD = diffOf(b, 'front'), rD = diffOf(b, 'rear'), cD = diffOf(b, 'center');
      var key = [layout, split, type, pos, motors, tv, tc, fD.id, rD.id, cD.id, get(b, 'engine.layout')].join('|');
      if (key === lastKey) return;
      lastKey = key;
      var W = 300, H = 340, cx = 150, fy = 70, ry = 270, wx = 70;
      var front = layout === 'rwd' ? 0 : layout === 'fwd' ? 100 : split;
      var rear = 100 - front;
      var acc = 'var(--accent,#c8a46a)', dim = 'var(--text-dim,#777)', line = 'var(--line,#333)';
      function wheel(x, y, driven) {
        return '<rect x="' + (x - 11) + '" y="' + (y - 24) + '" width="22" height="48" rx="6" fill="' + (driven ? acc : 'var(--panel-2,#222)') + '" fill-opacity="' + (driven ? 0.85 : 1) + '" stroke="' + (driven ? acc : line) + '"/>';
      }
      function shaft(x1, y1, x2, y2, pct) {
        var wdt = pct > 0 ? 2 + pct / 100 * 8 : 1.5;
        return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + (pct > 0 ? acc : line) + '" stroke-width="' + wdt.toFixed(1) + '" stroke-linecap="round"' + (pct > 0 ? '' : ' stroke-dasharray="3 4"') + '/>';
      }
      function diffBox(x, y, d, label, active) {
        var lf = num(d.lockFactor, 0);
        return '<g><circle cx="' + x + '" cy="' + y + '" r="13" fill="var(--bg,#0b0b0c)" stroke="' + (active ? acc : line) + '" stroke-width="2"/>' +
          '<circle cx="' + x + '" cy="' + y + '" r="' + (3 + lf * 7).toFixed(1) + '" fill="' + (active ? acc : dim) + '" fill-opacity=".7"/>' +
          '<text x="' + (x + 20) + '" y="' + (y - 2) + '" class="pp-strong">' + label + '</text>' +
          '<text x="' + (x + 20) + '" y="' + (y + 10) + '">' + U.escapeHtml(active ? d.name + ' · ' + fmt(lf * 100) + '% lock' : 'undriven') + '</text></g>';
      }
      var s = '';
      // body outline
      s += '<rect x="45" y="18" width="210" height="304" rx="46" fill="none" stroke="' + line + '" stroke-width="1.5"/>';
      s += '<path d="M85 120 h130 l-10 60 h-110 z" fill="var(--text,#eee)" fill-opacity=".05" stroke="' + line + '"/>';
      s += '<text x="150" y="154" text-anchor="middle">cabin</text>';
      // axles & wheels
      s += shaft(wx, fy, cx - 13, fy, front) + shaft(cx + 13, fy, W - wx, fy, front);
      s += shaft(wx, ry, cx - 13, ry, rear) + shaft(cx + 13, ry, W - wx, ry, rear);
      s += wheel(wx - 12, fy, front > 0) + wheel(W - wx + 12, fy, front > 0) + wheel(wx - 12, ry, rear > 0) + wheel(W - wx + 12, ry, rear > 0);
      // power source
      var srcY;
      if (type === 'ev') {
        // motor placement
        var mpos = [];
        if (motors === 1) mpos = [layout === 'fwd' ? 'f' : 'r'];
        else if (motors === 2) mpos = layout === 'awd' ? ['f', 'r'] : layout === 'fwd' ? ['fl', 'fr'] : ['rl', 'rr'];
        else if (motors === 3) mpos = ['f', 'rl', 'rr'];
        else mpos = ['fl', 'fr', 'rl', 'rr'];
        mpos.forEach(function (p) {
          var y = p.charAt(0) === 'f' ? fy : ry;
          var x = p.length === 1 ? cx : p.charAt(1) === 'l' ? cx - 45 : cx + 45;
          s += '<rect x="' + (x - 14) + '" y="' + (y + (p.charAt(0) === 'f' ? 18 : -38)) + '" width="28" height="20" rx="5" fill="' + acc + '" fill-opacity=".25" stroke="' + acc + '"/>';
          s += '<text x="' + x + '" y="' + (y + (p.charAt(0) === 'f' ? 32 : -24)) + '" text-anchor="middle" class="pp-strong">M</text>';
        });
        s += '<rect x="100" y="190" width="100" height="40" rx="6" fill="' + acc + '" fill-opacity=".08" stroke="' + dim + '" stroke-dasharray="4 3"/><text x="150" y="214" text-anchor="middle">battery ' + fmt(get(b, 'engine.battery_kwh')) + ' kWh</text>';
        srcY = null;
      } else {
        srcY = pos === 'front' ? 108 : pos === 'mid' ? 212 : 300;
        var eh = 34;
        s += '<rect x="112" y="' + (srcY - eh / 2) + '" width="76" height="' + eh + '" rx="6" fill="' + acc + '" fill-opacity=".22" stroke="' + acc + '"/>';
        s += '<text x="150" y="' + (srcY + 4) + '" text-anchor="middle" class="pp-strong">' + U.escapeHtml(get(b, 'engine.layout', '')) + (type === 'hybrid' ? ' + e' : '') + '</text>';
        var gy = pos === 'front' ? srcY + 32 : pos === 'mid' ? srcY + 34 : srcY - 34;
        s += '<rect x="132" y="' + (gy - 9) + '" width="36" height="18" rx="4" fill="var(--panel-2,#222)" stroke="' + dim + '"/><text x="150" y="' + (gy + 4) + '" text-anchor="middle">gbx</text>';
        // shafts from gearbox to diffs
        if (layout === 'awd') {
          s += shaft(cx, gy + (pos === 'front' ? 9 : -9), cx, 160 + (pos === 'front' ? -13 : 13), 100);
          s += shaft(cx, 147, cx, fy + 13, front) + shaft(cx, 173, cx, ry - 13, rear);
        } else if (layout === 'fwd') {
          s += shaft(cx, srcY - eh / 2, cx, fy + 13, 100);
        } else {
          if (pos === 'front') s += shaft(cx, gy + 9, cx, ry - 13, 100);
          else s += shaft(cx, gy + (pos === 'rear' ? 9 : 9), cx, ry - 13, 100);
          s += shaft(cx, fy + 13, cx, srcY - eh / 2, 0);
        }
      }
      if (type === 'ev' && layout === 'awd') s += shaft(cx, fy + 40, cx, ry - 40, 0);
      // diffs
      s += diffBox(cx, fy, fD, 'FRONT ' + fmt(front) + '%', front > 0);
      s += diffBox(cx, ry, rD, 'REAR ' + fmt(rear) + '%', rear > 0);
      if (layout === 'awd' && type !== 'ev') s += diffBox(cx, 160, cD, 'CENTRE', true);
      else if (layout === 'awd') s += '<text x="160" y="164" class="pp-strong">e-AWD · software split</text>';
      // torque vectoring arcs
      if (tv) {
        var ty_ = rear > 0 ? ry : fy;
        s += '<path d="M' + (wx - 30) + ' ' + (ty_ - 34) + ' q -14 34 0 68" fill="none" stroke="var(--good,#3fb950)" stroke-width="2" marker-end="url(#pp-arr)"/>';
        s += '<path d="M' + (W - wx + 30) + ' ' + (ty_ + 34) + ' q 14 -34 0 -68" fill="none" stroke="var(--good,#3fb950)" stroke-width="2" marker-end="url(#pp-arr)"/>';
        s += '<text x="150" y="' + (ty_ === ry ? 312 : 36) + '" text-anchor="middle" fill="var(--good,#3fb950)">torque vectoring active</text>';
      }
      // traction control badge
      var tcName = ['TC OFF', 'TC TRACK', 'TC SPORT', 'TC FULL'][tc] || 'TC';
      s += '<rect x="6" y="6" width="74" height="18" rx="9" fill="none" stroke="' + (tc === 0 ? 'var(--bad,#e5484d)' : dim) + '"/><text x="43" y="18" text-anchor="middle">' + tcName + '</text>';
      s = '<defs><marker id="pp-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--good,#3fb950)"/></marker></defs>' + s;
      host.innerHTML = svgWrap('0 0 ' + W + ' ' + H, W, H, s);
    });
  }

  function diffOptions(includeNone) {
    return function () {
      return D.differentials.filter(function (d) { return includeNone || d.id !== 'none'; }).map(function (d) {
        return { id: d.id, name: d.name + (d.id === 'none' ? '' : ' · ' + fmt(num(d.lockFactor, 0) * 100) + '% lock'), price: d.price };
      });
    };
  }

  function buildDrivetrain(root, P) {
    root.appendChild(ui.issues('drivetrain'));

    var layoutSeg = ui.segmented({
      path: 'drivetrain.layout', label: 'Driven wheels',
      options: (D.drivetrainLayouts || []).map(function (l) { return { id: l.id, name: l.id.toUpperCase() + ' — ' + l.name.replace(/-Wheel Drive|Wheel Drive/, '').trim(), desc: l.desc + (l.price ? ' (' + ui.priceText(l.price) + ', +' + l.weight_kg + ' kg)' : '') }; }),
      optionDisabled: compatFn('drivetrain.layout'),
      hint: 'FWD: light & efficient, traction-limited. RWD: pure steering and throttle adjustability. AWD: all-weather launches at the cost of mass and losses.'
    });
    var stats = statGrid([
      { key: 'driven', label: 'Driven wheels', decimals: 0 },
      { key: 'split', label: 'Torque F / R', decimals: 0 },
      { key: 'loss', label: 'Driveline loss', unit: '%', decimals: 1 },
      { key: 'wheelNm', label: '1st-gear wheel torque', unit: 'Nm', decimals: 0 },
      { key: 't60', label: '0–60 mph', unit: 's', decimals: 2 },
      { key: 'grip', label: 'Lateral grip', unit: 'g', decimals: 2 }
    ]);
    var warnBox = el('div', { class: 'pp-stack' });
    P.watch(stats, function (b, m) {
      var layout = get(b, 'drivetrain.layout', 'rwd'), split = num(get(b, 'drivetrain.torqueSplitFront_pct'), 0);
      var t = transOf(b), a = get(b, 'transmission.ratios') || [], fd = num(get(b, 'transmission.finalDrive'), 3.42);
      var axleLoss = layout === 'awd' ? 0.06 : layout === 'fwd' ? 0.02 : 0.035;
      var eff = num(t.efficiency, 0.92) * (1 - axleLoss);
      stats.setAll({
        driven: { value: layout === 'awd' ? 'All four' : layout === 'fwd' ? 'Front two' : 'Rear two', unit: '' },
        split: { value: (layout === 'fwd' ? 100 : layout === 'rwd' ? 0 : split) + ' / ' + (layout === 'fwd' ? 0 : layout === 'rwd' ? 100 : 100 - split), unit: '%' },
        loss: (1 - eff) * 100,
        wheelNm: m.torque_nm && a[0] ? m.torque_nm * a[0] * fd * eff : null,
        t60: m.zeroTo60_s, grip: m.lateralG
      });
      U.clear(warnBox);
      var ws = (m.warnings || []).filter(function (w) { return /wheelspin|traction|torque steer|spin|launch|understeer|oversteer|diff/i.test(String(w && w.message || w)); });
      ws.forEach(function (w) { warnBox.appendChild(note(String(w && w.message || w), 'warning')); });
      if (m.zeroTo60_note) warnBox.appendChild(note('Launch: ' + m.zeroTo60_note + '.', /traction/i.test(m.zeroTo60_note) ? 'warning' : 'info'));
    });
    root.appendChild(ui.section('Layout', 'Where the torque goes.', layoutSeg, ui.grid(2, drivetrainDiagram(), ui.group(null, stats, warnBox))));

    /* differentials */
    var front = ui.select({ path: 'drivetrain.frontDiff', label: 'Front differential', options: diffOptions(false),
      visible: function (b) { var l = get(b, 'drivetrain.layout'); return l === 'fwd' || l === 'awd'; },
      hint: 'A front LSD fights understeer and wheelspin out of tight corners — at the price of some torque steer.' });
    var center = ui.select({ path: 'drivetrain.centerDiff', label: 'Centre differential / coupling', options: diffOptions(false),
      visible: function (b) { return get(b, 'drivetrain.layout') === 'awd'; },
      hint: 'Splits torque between axles. Torsen and e-diff bias automatically; a locked centre is unbeatable off-road but binds on tarmac.' });
    var rear = ui.select({ path: 'drivetrain.rearDiff', label: 'Rear differential', options: diffOptions(false),
      visible: function (b) { var l = get(b, 'drivetrain.layout'); return l === 'rwd' || l === 'awd'; },
      hint: 'A clutch-pack or e-diff lets you steer with the throttle; an open diff spins the inside wheel when cornering hard.' });
    var diffNoteEl = el('div', { class: 'cb-hint' });
    var diffNote = ui.bind(diffNoteEl, '*', function (b) {
      var l = get(b, 'drivetrain.layout');
      diffNoteEl.textContent = l === 'fwd' ? 'Rear axle is undriven — no rear differential fitted.' : l === 'rwd' ? 'Front axle is undriven — no front or centre differential fitted.' : 'Three differentials: front, centre and rear. Lock factor shows how strongly each resists wheel-speed difference.';
    });
    var lockKv = ui.kv([]);
    P.watch(lockKv, function (b) {
      var l = get(b, 'drivetrain.layout');
      var rows = [];
      if (l !== 'rwd') rows.push(['Front lock', fmt(num(diffOf(b, 'front').lockFactor) * 100) + '%']);
      if (l === 'awd') rows.push(['Centre lock', fmt(num(diffOf(b, 'center').lockFactor) * 100) + '%']);
      if (l !== 'fwd') rows.push(['Rear lock', fmt(num(diffOf(b, 'rear').lockFactor) * 100) + '%']);
      var w = 0; ['front', 'center', 'rear'].forEach(function (ax) { w += num(diffOf(b, ax).weight_kg, 0); });
      rows.push(['Diff hardware mass', '+' + fmt(w) + ' kg']);
      lockKv.set(rows);
    });
    root.appendChild(ui.section('Differentials', null, diffNote, ui.grid(2, ui.group(null, front, center, rear), lockKv)));

    /* torque split (awd only) */
    var tsR = R('drivetrain.torqueSplitFront_pct');
    var split = ui.slider({
      path: 'drivetrain.torqueSplitFront_pct', label: 'Nominal torque split', min: tsR.awdMin || 10, max: tsR.awdMax || 90, step: 1,
      format: function (v) { return fmt(v) + ' F / ' + fmt(100 - v) + ' R'; },
      ticks: [{ value: tsR.awdMin || 10, label: 'Rear' }, { value: 50, label: '50:50' }, { value: tsR.awdMax || 90, label: 'Front' }],
      marks: [{ value: 30, label: 'Rear-biased sports AWD', kind: 'info' }, { value: 40, label: 'Typical GT AWD' }],
      hint: 'Static front share of drive torque. Rear-biased splits feel like RWD on corner exit; nearer 50:50 maximises traction off the line.'
    });
    var splitPresets = el('div', { class: 'pp-btnrow' });
    [[30, 'Rear-biased 30:70'], [40, 'GT 40:60'], [50, 'Rally 50:50'], [60, 'Front-biased 60:40']].forEach(function (p) {
      splitPresets.appendChild(ui.button(p[1], { kind: 'ghost', onClick: function () { setState('drivetrain.torqueSplitFront_pct', p[0], 'Torque split → ' + p[1]); } }));
    });
    var splitGroup = ui.bind(el('div', { class: 'pp-stack' }, split, splitPresets), 'drivetrain.layout', function () {}, {
      visible: function (b) { return get(b, 'drivetrain.layout') === 'awd'; }
    });
    var splitOffEl = note('', 'info');
    var splitOff = ui.bind(splitOffEl, 'drivetrain.layout', function (b) {
      splitOffEl.textContent = get(b, 'drivetrain.layout') === 'fwd' ? 'Front-wheel drive: 100% of torque goes to the front axle. Switch to AWD to tune the split.' : 'Rear-wheel drive: 100% of torque goes to the rear axle. Switch to AWD to tune the split.';
    }, { visible: function (b) { return get(b, 'drivetrain.layout') !== 'awd'; } });

    /* electronics */
    var tv = ui.toggle({
      path: 'drivetrain.torqueVectoring', label: 'Active torque vectoring', price: opt('torqueVectoring', 2800),
      hint: 'Over-drives the outside wheel in a corner to rotate the car — kills understeer. Works best with an e-diff or multiple motors.'
    });
    var tc = ui.segmented({
      path: 'drivetrain.tractionControl', label: 'Traction control',
      options: [{ id: 0, name: 'Off', desc: 'No intervention — all on you' }, { id: 1, name: 'Track', desc: 'Allows ~12% slip, intervenes late' }, { id: 2, name: 'Sport', desc: 'Moderate slip for a playful balance' }, { id: 3, name: 'Full', desc: 'Maximum intervention — safest on wet roads' }],
      hint: 'Calibration of wheelslip limiting. Higher levels protect the launch in poor grip; lower levels allow drifts and quicker laps for skilled drivers.'
    });
    root.appendChild(ui.section('Torque distribution & electronics', null, splitGroup, splitOff, ui.grid(2, tv, tc)));
  }

  /* ======================================================================
     REGISTRATION
     ====================================================================== */
  makePanel({ id: 'body', title: 'Body & Chassis', subtitle: 'Silhouette, structure and proportions', order: 10, build: buildBody });
  enginePanelRef = makePanel({ id: 'engine', title: 'Engine', subtitle: 'Combustion, hybrid or electric power', order: 20, build: buildEngine });
  makePanel({ id: 'transmission', title: 'Transmission', subtitle: 'Gearbox, ratios and final drive', order: 30, build: buildTransmission });
  makePanel({ id: 'drivetrain', title: 'Drivetrain', subtitle: 'Driven wheels, differentials and torque', order: 40, build: buildDrivetrain });

  // Exposed for tests / other modules (pure helpers only).
  CB.panelsPowertrain = {
    bodyShape: bodyShape, silhouetteIcon: silhouetteIcon, reshapeRatios: reshapeRatios, sanitizeRatios: sanitizeRatios,
    localGearSpeeds: localGearSpeeds, estimate: estimate, compat: compat, boreStroke: boreStroke, realDimsNote: realDimsNote
  };
})();

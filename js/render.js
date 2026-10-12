/* ==========================================================================
   FORGE Atelier — js/render.js
   CB.render : the procedural SVG car visualiser.

   Public API (docs/SPEC.md "CB.render")
   --------------------------------
     CB.render.mount(containerEl)          create the live <svg> inside the container (idempotent)
     CB.render.update(build, metrics)      re-target the drawing; numeric geometry (wheelbase, ride
                                           height, wheel/tyre size, rotor size, wing angle, colours,
                                           even body-style hints) tweens over 350 ms with rAF
     CB.render.setView(v)                  'side' | 'front' | 'rear' | 'top'   (cross-fade)
     CB.render.getView()
     CB.render.toggleXray(bool?)           engine / battery / motors / driveshafts / CG / weight split
     CB.render.toggleSpin(bool?)           spinning wheels (also: setSpin, isSpinning)
     CB.render.snapshotSVG() -> string     standalone SVG of the current view (studio backdrop)
     CB.render.thumbnail(build, opts?)     small static side profile string for garage / hub cards
                                           opts: { view, uid, spin (SMIL), backdrop, xray, detail }
     CB.render.markup(build, metrics, opts) pure full-SVG generator (used by tests in Node)
     CB.render.resolve(build, metrics)     pure: build -> render spec { n (numbers), c (colours), d (discrete) }
     CB.render.mode()                      'webgl' (live viewer handed to CB.studio3d) | 'svg' | null (not mounted)
     CB.render.use3d(bool?)                get / set whether mount() may hand the live viewer to CB.studio3d
                                           (default on; off via ?studio=svg or localStorage cb.studio = 'svg')

   3D studio hand-over (docs/LOWPOLY-SPEC.md "Studio")
   ----------------------------------------------
     When CB.studio3d (js/studio3d.js) is loaded and WebGL works, mount() gives the live viewer to the WebGL
     turntable of the low-poly car; update / setView / toggleXray / toggleSpin are forwarded. The SVG renderer
     stays the fallback (no WebGL, context lost for good, init failure) and keeps producing snapshotSVG() and
     thumbnail() (spec sheet, garage / hub cards) in both modes.

   Architecture
   ------------
     build ──resolve()──▶ spec {n,c,d} ──interp(from,to,t)──▶ frame spec ──drawView()──▶ markup strings
   Everything is generated as SVG *markup strings* (no DOM needed), so the generator runs in Node and
   tests can sweep every body style × wheel design × view looking for NaN/undefined. In the browser the
   live controller writes the strings into two persistent nodes (<defs> for paint, <g> for the scene)
   only when they changed, and drives wheel spin by rotating [data-spin] groups each animation frame.

   Coordinate system: viewBox 1200 × 520, ground line at y = 434. Side & top views share a scale
   (px per mm) derived from the overall length so a van really is bigger than a roadster; front/rear
   views fit width/height. All model geometry is computed in millimetres and mapped to px late.

   Ids inside one SVG are prefixed (live view 'cbrm', snapshots 'cbrs', thumbnails 'cbt<n>') so many
   thumbnails can coexist in one document.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  var VBW = 1200, VBH = 520, GROUND = 434;
  var TWEEN_MS = 350;
  var VIEWS = ['side', 'front', 'rear', 'top'];
  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var XR = '#5cc8ff', XR2 = '#9fe0ff', XR_ENG = '#ffb35c', XR_BAT = '#3ee6a8', XR_MOT = '#c48bff', XR_FUEL = '#ffd166', XR_HOT = '#ff6b4a';
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var SANS = 'Inter, "SF Pro Display", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  /* ======================================================================
     Small numeric / string helpers
     ====================================================================== */
  function num(v, d) {
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    return typeof v === 'number' && isFinite(v) ? v : d;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  /* Format a coordinate. NaN / Infinity are emitted literally (never masked) so tests catch them. */
  function f(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 'NaN';
    var r = Math.round(v * 10) / 10;
    return String(r === 0 ? 0 : r);
  }
  function f2(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 'NaN';
    var r = Math.round(v * 100) / 100;
    return String(r === 0 ? 0 : r);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function P2(x, y) { return f(x) + ' ' + f(y); }
  function polar(cx, cy, r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; }
  function hashStr(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0; }
    return h >>> 0;
  }
  /* deterministic PRNG (mulberry32) for flakes, carbon speckle, tread */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function deepMerge(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = isObj(base[k]) ? deepMerge(base[k], {}) : base[k];
    if (!isObj(over)) return out;
    for (k in over) {
      if (!Object.prototype.hasOwnProperty.call(over, k)) continue;
      var v = over[k];
      if (v === undefined) continue;
      out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : (isObj(v) ? deepMerge({}, v) : v);
    }
    return out;
  }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; }
    return t;
  }

  /* ======================================================================
     Markup helpers
     ====================================================================== */
  function attrs(o) {
    var s = '';
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (v == null || v === false) continue;
      s += ' ' + k + '="' + (typeof v === 'number' ? f2(v) : esc(v)) + '"';
    }
    return s;
  }
  function tag(name, a, inner) { return '<' + name + attrs(a || {}) + (inner == null ? '/>' : '>' + inner + '</' + name + '>'); }
  function pathEl(d, a) { return '<path d="' + d + '"' + attrs(a || {}) + '/>'; }
  function circleEl(cx, cy, r, a) { return '<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f2(Math.max(0, r)) + '"' + attrs(a || {}) + '/>'; }
  function ellipseEl(cx, cy, rx, ry, a) { return '<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f2(Math.max(0, rx)) + '" ry="' + f2(Math.max(0, ry)) + '"' + attrs(a || {}) + '/>'; }
  function rectEl(x, y, w, h, a) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f2(w) + '" height="' + f2(h) + '"' + attrs(a || {}) + '/>';
  }
  function lineEl(x1, y1, x2, y2, a) { return '<line x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(x2) + '" y2="' + f(y2) + '"' + attrs(a || {}) + '/>'; }
  function textEl(x, y, txt, a) { return '<text x="' + f(x) + '" y="' + f(y) + '"' + attrs(a || {}) + '>' + esc(txt) + '</text>'; }
  function g(a, inner) { return '<g' + attrs(a || {}) + '>' + (inner || '') + '</g>'; }
  function polyD(pts, close) {
    if (!pts.length) return '';
    var s = 'M' + P2(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) s += ' L' + P2(pts[i][0], pts[i][1]);
    return s + (close ? ' Z' : '');
  }
  /* Catmull-Rom → cubic Bézier. points: [x, y, sharp?]. A segment touching a sharp point is straight. */
  function smoothD(pts, closed, k0, noMove) {
    var n = pts.length;
    if (n < 2) return '';
    var k = k0 == null ? 1 / 6 : k0;
    var s = noMove ? '' : 'M' + P2(pts[0][0], pts[0][1]);
    var segs = closed ? n : n - 1;
    for (var i = 0; i < segs; i++) {
      var p1 = pts[i], p2 = pts[(i + 1) % n];
      var p0 = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
      var p3 = closed ? pts[(i + 2) % n] : pts[Math.min(n - 1, i + 2)];
      if (p1[2] || p2[2]) { s += ' L' + P2(p2[0], p2[1]); continue; }
      var a = p0[2] ? 0.6 * k : k, b = p3[2] ? 0.6 * k : k;
      s += ' C' + P2(p1[0] + (p2[0] - p0[0]) * a, p1[1] + (p2[1] - p0[1]) * a) + ' ' +
        P2(p2[0] - (p3[0] - p1[0]) * b, p2[1] - (p3[1] - p1[1]) * b) + ' ' + P2(p2[0], p2[1]);
    }
    return s + (closed ? ' Z' : '');
  }
  function circleD(cx, cy, r) {
    return 'M' + P2(cx - r, cy) + ' A' + f2(r) + ' ' + f2(r) + ' 0 1 1 ' + P2(cx + r, cy) + ' A' + f2(r) + ' ' + f2(r) + ' 0 1 1 ' + P2(cx - r, cy) + ' Z';
  }
  /* annular sector (angles in radians, a0 < a1) */
  function sectorD(cx, cy, r0, r1, a0, a1) {
    var p = polar(cx, cy, r1, a0), q = polar(cx, cy, r1, a1), u = polar(cx, cy, r0, a1), v = polar(cx, cy, r0, a0);
    var large = a1 - a0 > PI ? 1 : 0;
    return 'M' + P2(p[0], p[1]) + ' A' + f2(r1) + ' ' + f2(r1) + ' 0 ' + large + ' 1 ' + P2(q[0], q[1]) +
      ' L' + P2(u[0], u[1]) + ' A' + f2(r0) + ' ' + f2(r0) + ' 0 ' + large + ' 0 ' + P2(v[0], v[1]) + ' Z';
  }
  function roundRectD(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    return 'M' + P2(x + r, y) + ' H' + f(x + w - r) + ' Q' + P2(x + w, y) + ' ' + P2(x + w, y + r) + ' V' + f(y + h - r) +
      ' Q' + P2(x + w, y + h) + ' ' + P2(x + w - r, y + h) + ' H' + f(x + r) + ' Q' + P2(x, y + h) + ' ' + P2(x, y + h - r) +
      ' V' + f(y + r) + ' Q' + P2(x, y) + ' ' + P2(x + r, y) + ' Z';
  }

  /* ======================================================================
     Colour helpers (self-contained so the renderer never depends on load order)
     ====================================================================== */
  function hexRgb(h) {
    if (typeof h !== 'string') return null;
    h = h.trim();
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.length === 3 || h.length === 4) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    var v = parseInt(h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbHex(r, g2, b) {
    function c(v) { v = clamp(Math.round(v), 0, 255); return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + c(r) + c(g2) + c(b);
  }
  function nhex(h, d) { var c = hexRgb(h); return c ? rgbHex(c[0], c[1], c[2]) : (d || '#888888'); }
  function mix(a, b, t) {
    var x = hexRgb(a) || [128, 128, 128], y = hexRgb(b) || [128, 128, 128];
    t = clamp(num(t, 0.5), 0, 1);
    return rgbHex(lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t));
  }
  function shade(h, amt) { return amt >= 0 ? mix(h, '#ffffff', amt) : mix(h, '#000000', -amt); }
  function toHsl(hex) {
    var c = hexRgb(hex) || [128, 128, 128], r = c[0] / 255, gg = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, gg, b), min = Math.min(r, gg, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (gg - b) / d + (gg < b ? 6 : 0); else if (max === gg) h = (b - r) / d + 2; else h = (r - gg) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function fromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, gg = 0, b = 0;
    if (h < 60) { r = c; gg = x; } else if (h < 120) { r = x; gg = c; } else if (h < 180) { gg = c; b = x; }
    else if (h < 240) { gg = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return rgbHex((r + m) * 255, (gg + m) * 255, (b + m) * 255);
  }
  function hue(hex, deg) { var x = toHsl(hex); return fromHsl(x[0] + deg, x[1], x[2]); }
  function sat(hex, k) { var x = toHsl(hex); return fromHsl(x[0], x[1] * k, x[2]); }
  function luma(hex) { var c = hexRgb(hex) || [0, 0, 0]; return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function ink(hex) { return luma(hex) > 0.55 ? '#111317' : '#f6f4ef'; }

  /* ======================================================================
     Catalog access & defaults
     ====================================================================== */
  function D() { return CB.data || {}; }
  function findIn(list, id) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function cat(path, id) {
    var d = D(), list;
    if (path.indexOf('.') > 0) { var p = path.split('.'); list = d[p[0]] && d[p[0]][p[1]]; } else list = d[path];
    return findIn(list, id);
  }

  var FALLBACK_SVG = {
    length_mm: 4550, height_mm: 1300, width_mm: 1930, frontOverhang_mm: 930, rearOverhang_mm: 970,
    noseHeight: 0.46, hoodLength: 0.40, cabinStart: 0.40, roofStart: 0.52, roofEnd: 0.66, cabinEnd: 0.84,
    roofHeight: 1.0, beltline: 0.68, deckHeight: 0.72, tailHeight: 0.60, windshieldRake_deg: 62,
    tailStyle: 'fastback', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 2, pillarStyle: 'thin'
  };
  var FALLBACK_STYLE = { id: 'coupe', name: 'Coupé', defaultWheelbase: 2650, wheelbaseRange: [2450, 2800], cgHeight_mm: 480, baseWeight_kg: 1420, tank_l: 64, svg: FALLBACK_SVG };
  var FALLBACK_BUILD = {
    version: 1, meta: { name: 'Untitled Build' },
    body: { style: 'coupe', chassisMaterial: 'steel', wheelbase_mm: 2650, trackWidth_mm: 1600, doors: 2, seats: 4 },
    engine: { type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 1.2, compression: 10, fuel: 'premium', redline_rpm: 7500, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard', motors: 2, motorPower_kw: 200, battery_kwh: 85, chemistry: 'nmc', voltage: 800, regen: 2 },
    transmission: { type: 'dct', gears: 7, finalDrive: 3.42, launchControl: true },
    drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
    suspension: { type: 'double-wishbone', rideHeight_mm: 120, camberFront_deg: -1.5, camberRear_deg: -1.0 },
    brakes: { material: 'iron', frontRotor_mm: 360, rearRotor_mm: 330, frontPistons: 6, rearPistons: 4, abs: 'sport' },
    wheels: { design: 'y-spoke', material: 'cast', diameter_in: 19, widthFront_in: 9.0, widthRear_in: 10.5, finish: '#2b2b2b', staggered: true },
    tires: { compound: 'performance', widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 },
    aero: { splitter: 'lip', wing: 'none', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
    weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lead', rollCage: 'none', ballast_kg: 0, ballastPosition: 'center' },
    exterior: { paint: '#b3121f', finish: 'metallic', roof: 'body', roofColor: '#111111', stripe: 'none', stripeColor: '#ffffff', caliperColor: '#f2c200', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome', livery_number: '' },
    interior: { seatType: 'sport', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#b3121f', stitchColor: '#b3121f', ambientLighting: true, ambientColor: '#ff3344' },
    tech: {}
  };
  var NOMINAL_RIDE = { coupe: 120, sedan: 130, hatchback: 130, wagon: 135, suv: 200, roadster: 115, pickup: 230, hypercar: 95, 'shooting-brake': 120, van: 160 };
  /* Per-style extras for the views the catalog hints do not describe (front/rear/top), and details. */
  var STYLE_X = {
    coupe: { tumble: 0.30, shoulder: 0.985, planNose: 0.30, planTail: 0.40, waist: 0.955, roofRails: false, cladding: false, intake: false, hoodVents: true, grille: 'wide', plate: true },
    sedan: { tumble: 0.24, shoulder: 0.985, planNose: 0.34, planTail: 0.42, waist: 0.97, roofRails: false, cladding: false, intake: false, hoodVents: false, grille: 'kidney', plate: true },
    hatchback: { tumble: 0.22, shoulder: 0.98, planNose: 0.36, planTail: 0.44, waist: 0.965, roofRails: false, cladding: false, intake: false, hoodVents: false, grille: 'honeycomb', plate: true },
    wagon: { tumble: 0.20, shoulder: 0.985, planNose: 0.34, planTail: 0.45, waist: 0.97, roofRails: true, cladding: false, intake: false, hoodVents: false, grille: 'wide', plate: true },
    suv: { tumble: 0.15, shoulder: 0.99, planNose: 0.40, planTail: 0.46, waist: 0.98, roofRails: true, cladding: true, intake: false, hoodVents: false, grille: 'tall', plate: true },
    roadster: { tumble: 0.30, shoulder: 0.98, planNose: 0.30, planTail: 0.40, waist: 0.95, roofRails: false, cladding: false, intake: false, hoodVents: false, grille: 'oval', plate: true },
    pickup: { tumble: 0.10, shoulder: 0.995, planNose: 0.44, planTail: 0.49, waist: 0.99, roofRails: false, cladding: true, intake: false, hoodVents: false, grille: 'truck', plate: true },
    hypercar: { tumble: 0.46, shoulder: 0.97, planNose: 0.24, planTail: 0.43, waist: 0.90, roofRails: false, cladding: false, intake: true, hoodVents: true, grille: 'none', plate: false },
    'shooting-brake': { tumble: 0.26, shoulder: 0.985, planNose: 0.31, planTail: 0.43, waist: 0.96, roofRails: false, cladding: false, intake: false, hoodVents: true, grille: 'wide', plate: true },
    van: { tumble: 0.08, shoulder: 0.995, planNose: 0.42, planTail: 0.48, waist: 0.99, roofRails: true, cladding: false, intake: false, hoodVents: false, grille: 'slot', plate: true }
  };

  function baseBuild() {
    var d = D();
    try { if (typeof d.defaultBuild === 'function') { var b = d.defaultBuild(); if (isObj(b)) return b; } } catch (e) { /* ignore */ }
    return deepMerge(FALLBACK_BUILD, {});
  }

  function engineLabel(e, lay) {
    if (!e) return '';
    if (e.type === 'ev') return 'EV';
    var id = (lay && lay.id) || e.layout || '';
    var base = id === 'rotary-2' ? 'ROTARY' : id.replace('flat-', 'FLAT ').toUpperCase();
    return e.type === 'hybrid' ? base + ' HYBRID' : base;
  }

  /* ======================================================================
     resolve(build, metrics) → render spec
       n : tweenable numbers (mm, degrees, fractions)
       c : tweenable colours (#rrggbb)
       d : discrete choices (switch at the tween midpoint)
     ====================================================================== */
  function resolve(build, metrics, env) {
    env = env || {};
    var b = deepMerge(baseBuild(), isObj(build) ? build : {});
    var m = isObj(metrics) ? metrics : {};
    var body = b.body || {}, e = b.engine || {}, tr = b.transmission || {}, dt = b.drivetrain || {}, su = b.suspension || {};
    var br = b.brakes || {}, w = b.wheels || {}, t = b.tires || {}, a = b.aero || {}, wt = b.weight || {}, ex = b.exterior || {}, it = b.interior || {};

    var bs = cat('bodyStyles', body.style) || cat('bodyStyles', 'coupe') || FALLBACK_STYLE;
    var styleId = STYLE_X[bs.id] ? bs.id : 'coupe';
    var h = assign({}, FALLBACK_SVG, bs.svg || {});
    var range = bs.wheelbaseRange || [2200, 3900];
    var L0 = clamp(num(h.length_mm, 4550), 3000, 7000);
    var fo = clamp(num(h.frontOverhang_mm, 930), 500, 1600);
    var wb0 = clamp(num(bs.defaultWheelbase, L0 - fo - num(h.rearOverhang_mm, 970)), 1800, 4500);
    var ro = L0 - fo - wb0;
    if (ro < 450) { ro = 450; L0 = fo + wb0 + ro; }
    var wb = clamp(num(body.wheelbase_mm, wb0), Math.min(range[0], wb0) - 200, Math.max(range[1], wb0) + 200);

    var design = cat('wheelDesigns', w.design) || { id: 'y-spoke', name: 'Y-Spoke', spokes: 5, style: 'y', concavity: 0.4 };
    var compound = cat('tireCompounds', t.compound) || { id: 'performance', name: 'Max Performance' };
    var finish = cat('paintFinishes', ex.finish) || { id: ex.finish || 'metallic', gloss: 0.9, metallic: 0.5, flake: true };
    var exh = cat('exhausts', e.exhaust) || { id: 'sport', tipStyle: 'round', tipCount: 2 };
    var lay = cat('engineLayouts', e.layout) || { id: e.layout || 'V8', cylinders: 8, config: 'v', bankAngle_deg: 90, length_mm: 650 };
    var asp = cat('aspirations', e.aspiration) || { id: e.aspiration || 'na' };
    var trans = cat('transmissions', tr.type) || { id: tr.type || 'dct', name: 'DCT' };
    var dia = clamp(num(w.diameter_in, 19), 13, 26);
    var rim = dia * 12.7;
    var twF = clamp(num(t.widthFront_mm, 255), 145, 405), twR = clamp(num(t.widthRear_mm, twF), 145, 405);
    var prF = clamp(num(t.profileFront, 35), 15, 85), prR = clamp(num(t.profileRear, prF), 15, 85);
    var engType = e.type === 'ev' || e.type === 'hybrid' ? e.type : 'ice';
    var position = engType === 'ev' ? 'none' : (e.position === 'mid' || e.position === 'rear' ? e.position : 'front');
    var wfEst = engType === 'ev' ? 48 : position === 'mid' ? 42 : position === 'rear' ? 38 : 55;
    var nominal = NOMINAL_RIDE[styleId] || 130;
    var theme = env.theme || (HAS_DOM && document.documentElement && document.documentElement.getAttribute('data-theme')) || 'dark';

    var n = {
      L0: L0, H: clamp(num(h.height_mm, 1300), 900, 2400), W: clamp(num(h.width_mm, 1930), 1500, 2300), fo: fo, ro: ro, wb0: wb0, wb: wb,
      nose: clamp(num(h.noseHeight, 0.46), 0.2, 0.8), hood: clamp(num(h.hoodLength, 0.4), 0.05, 0.6),
      cs: clamp(num(h.cabinStart, 0.4), 0.05, 0.7), rs: clamp(num(h.roofStart, 0.52), 0.1, 0.8), re: clamp(num(h.roofEnd, 0.66), 0.2, 0.99),
      ce: clamp(num(h.cabinEnd, 0.84), 0.3, 0.995), roofH: clamp(num(h.roofHeight, 1), 0.6, 1.1), belt: clamp(num(h.beltline, 0.68), 0.35, 0.9),
      deck: clamp(num(h.deckHeight, 0.72), 0.3, 0.95), tail: clamp(num(h.tailHeight, 0.6), 0.25, 0.9),
      bedLen: num(h.bedLength_mm, 0),
      ride: clamp(num(su.rideHeight_mm, nominal), 30, 360), nomRide: nominal,
      track: clamp(num(body.trackWidth_mm, 1600), 1300, 1900),
      rimR: rim, tRF: rim + twF * prF / 100, tRR: rim + twR * prR / 100, twF: twF, twR: twR, prF: prF, prR: prR,
      rimWF: clamp(num(w.widthFront_in, 9), 5, 14) * 25.4, rimWR: clamp(num(w.widthRear_in, 9), 5, 14) * 25.4,
      rotF: clamp(num(br.frontRotor_mm, 360), 220, 480), rotR: clamp(num(br.rearRotor_mm, 330), 220, 480),
      camF: clamp(num(su.camberFront_deg, -1.5), -6, 2), camR: clamp(num(su.camberRear_deg, -1), -6, 2),
      wingAng: clamp(num(a.wingAngle_deg, 6), 0, 25),
      tint: clamp(num(ex.windowTint_pct, 20), 0, 95) / 100,
      concave: clamp(num(design.concavity, 0.4), 0, 1),
      wf: clamp(num(m.weightFront_pct, wfEst), 15, 85),
      cgH: clamp(num(m.cgHeight_mm, num(bs.cgHeight_mm, 500)), 200, 1200),
      mass: clamp(num(m.weight_kg, num(bs.baseWeight_kg, 1500)), 400, 6000),
      hp: Math.max(0, num(m.power_hp, 0)), torque: Math.max(0, num(m.torque_nm, 0)),
      disp: clamp(num(e.displacement_l, 3), 0.5, 10), boost: clamp(num(e.boost_bar, 0), 0, 4),
      kwh: clamp(num(e.battery_kwh, engType === 'hybrid' ? 12 : 80), 0.5, 250), motorKw: clamp(num(e.motorPower_kw, 200), 10, 800),
      engLen: clamp(num(lay.length_mm, 600), 250, 1200), ballast: clamp(num(wt.ballast_kg, 0), 0, 300), tank: clamp(num(bs.tank_l, 60), 20, 200)
    };
    // the build's own overall figures, computed exactly like physics.js / the Body panel (the real-model shell
    // and the clamped drawing geometry may differ — x-ray dimension labels quote these, not the outline's size)
    var bsv = bs.svg || {};
    n.buildLen = num(bsv.length_mm, wb + 1850) + (wb - num(bs.defaultWheelbase, wb));
    n.buildW = num(bsv.width_mm, 1900) + (n.track - 1600);
    var c = {
      paint: nhex(ex.paint, '#b3121f'), stripe: nhex(ex.stripeColor, '#ffffff'), caliper: nhex(ex.caliperColor, '#f2c200'),
      rim: nhex(w.finish, '#2b2b2b'), roof: nhex(ex.roofColor, '#111111'),
      intP: nhex(it.primaryColor, '#1a1a1a'), intA: nhex(it.accentColor, '#b3121f'), stitch: nhex(it.stitchColor, '#b3121f'), ambient: nhex(it.ambientColor, '#ff3344')
    };
    var motors = clamp(Math.round(num(e.motors, 2)), 1, 4);
    var d = {
      style: styleId, styleName: bs.name || styleId, X: STYLE_X[styleId],
      tailStyle: h.tailStyle || 'fastback', noseStyle: h.noseStyle || 'long', archStyle: h.archStyle || 'round', openTop: !!h.openTop,
      sideWindows: clamp(Math.round(num(h.sideWindows, 2)), 1, 5), pillar: h.pillarStyle || 'thin',
      doors: clamp(Math.round(num(body.doors, 2)), 2, 5), seats: clamp(Math.round(num(body.seats, 2)), 1, 9),
      finish: finish.id || 'metallic', gloss: clamp(num(finish.gloss, 0.85), 0, 1), metallic: clamp(num(finish.metallic, 0.3), 0, 1),
      flake: !!finish.flake, hueShift: num(finish.hueShift_deg, 70),
      roof: ex.roof || 'body', stripe: ex.stripe || 'none', lights: ex.lights || 'led', mirrors: ex.mirrors || 'body', badge: ex.badge || 'chrome',
      number: String(ex.livery_number == null ? '' : ex.livery_number).replace(/[^0-9A-Za-z]/g, '').slice(0, 3).toUpperCase(),
      wheel: design.id || 'y-spoke', wheelName: design.name || '', wstyle: design.style || 'y', spokes: clamp(Math.round(num(design.spokes, 5)), 0, 24),
      wheelMat: w.material || 'cast', brakeMat: br.material || 'iron', pisF: num(br.frontPistons, 4), pisR: num(br.rearPistons, 2),
      compound: compound.id || 'performance', compoundName: compound.name || '', dia: dia,
      splitter: a.splitter || 'none', wing: a.wing || 'none', diffuser: a.diffuser || 'none', canards: !!a.canards, skirts: !!a.sideSkirts, activeAero: !!a.activeAero,
      exhaust: exh.id || 'sport', tipStyle: engType === 'ev' ? 'none' : (exh.tipStyle || 'round'), tipCount: engType === 'ev' ? 0 : clamp(Math.round(num(exh.tipCount, 2)), 1, 6),
      engType: engType, layout: lay.id || 'V8', config: lay.config || 'v', cyl: clamp(Math.round(num(lay.cylinders, 8)), 1, 16), rotors: num(lay.rotors, 2),
      bank: num(lay.bankAngle_deg, 90), position: position, aspiration: asp.id || 'na', fuel: e.fuel || 'premium', cooling: e.cooling || 'standard',
      trans: trans.id || 'dct', transName: trans.name || '', gears: clamp(Math.round(num(tr.gears, 6)), 1, 10),
      drive: dt.layout === 'fwd' || dt.layout === 'awd' ? dt.layout : 'rwd', frontDiff: dt.frontDiff || 'open', rearDiff: dt.rearDiff || 'open', centerDiff: dt.centerDiff || 'none', tv: !!dt.torqueVectoring,
      motors: motors, chem: e.chemistry || 'nmc', voltage: num(e.voltage, 800),
      rollCage: wt.rollCage || 'none', rearSeats: wt.rearSeats !== false, glass: wt.glass || 'standard', battery12: wt.battery || 'lead', ballastPos: wt.ballastPosition || 'center', spare: !!wt.spareTire,
      susp: su.type || 'double-wishbone', seatType: it.seatType || 'sport', harness: !!it.harness, ambientOn: !!it.ambientLighting,
      name: (b.meta && b.meta.name) || 'Untitled Build', engineLabel: engineLabel(e, lay), theme: theme === 'light' ? 'light' : 'dark'
    };
    // real manufacturer model (CB.shapes): build.body.model, else the style default; absent → procedural drawing
    var mdl = shapeModelFor(styleId, body.model);
    if (mdl) {
      d.model = mdl.id; d.modelName = ((mdl.make || '') + ' ' + (mdl.name || '')).trim();
      var spf = { n: n, c: c, d: d }, fe = fittedFor(spf);
      if (fe) { n.length = Math.round((fe.f.dims.xFront - fe.f.dims.xRear) * 1000); n.height = Math.round(fe.f.dims.height * 1000); }
      // studio framing: the model's reference size (lerped between models while tweening, so the live
      // viewBox zoom moves smoothly from one car to the next)
      var rf = mdl.ref || {};
      if (num(rf.length, 0) > 1 && num(rf.height, 0) > 0.5 && num(rf.width, 0) > 1) {
        var rtw = S_TW(rf);
        n.frameL = rf.length * 1000; n.frameH = rf.height * 1000;
        n.frameW = Math.max(rf.width, Math.max(num(rf.trackF, 0), num(rf.trackR, 0)) + rtw) * 1000;
      }
    }
    if (!(n.frameL > 0)) { n.frameL = n.L0; n.frameH = n.H; n.frameW = Math.max(n.W, n.track + Math.max(n.twF, n.twR)); }
    return { n: n, c: c, d: d };
  }

  /** widest reference tyre of a model, metres */
  function S_TW(rf) {
    var S = CB.shapes, w = 0.25;
    try {
      [rf.tireF, rf.tireR].forEach(function (t) { var p = t && S && S.parseTire ? S.parseTire(t) : null; if (p && p.width_mm > 100) w = Math.max(w, p.width_mm / 1000); });
    } catch (e) { /* keep default */ }
    return w;
  }

  function interp(A, B, t) {
    if (!A || t >= 1) return B;
    if (t <= 0) return A;
    var n = {}, c = {}, k;
    for (k in B.n) n[k] = typeof A.n[k] === 'number' && typeof B.n[k] === 'number' ? lerp(A.n[k], B.n[k], t) : B.n[k];
    for (k in B.c) c[k] = A.c[k] ? mix(A.c[k], B.c[k], t) : B.c[k];
    return { n: n, c: c, d: t < 0.5 ? A.d : B.d };
  }

  /* ======================================================================
     Paint & material definitions (gradients, patterns, filters)
     ====================================================================== */
  function stops(list) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      s += '<stop offset="' + f2(it[0]) + '" stop-color="' + it[1] + '"' + (it[2] != null && it[2] < 1 ? ' stop-opacity="' + f2(it[2]) + '"' : '') + (it[3] || '') + '>' + '</stop>';
    }
    return s.replace(/><\/stop>/g, '/>');
  }
  function paintStops(p, d) {
    var hs = d.hueShift || 70;
    switch (d.finish) {
      case 'solid': return [[0, shade(p, 0.30)], [0.16, shade(p, 0.12)], [0.42, p], [0.74, shade(p, -0.24)], [1, shade(p, -0.55)]];
      case 'pearl': return [[0, shade(hue(p, 28), 0.55)], [0.14, shade(hue(p, 16), 0.28)], [0.40, p], [0.58, hue(shade(p, 0.06), -10)], [0.78, hue(shade(p, -0.25), -20)], [1, shade(hue(p, -28), -0.55)]];
      case 'matte': { var mp = sat(p, 0.86); return [[0, shade(mp, 0.10)], [0.45, mp], [0.8, shade(mp, -0.14)], [1, shade(mp, -0.3)]]; }
      case 'satin': return [[0, shade(p, 0.20)], [0.3, shade(p, 0.06)], [0.58, p], [0.85, shade(p, -0.22)], [1, shade(p, -0.42)]];
      case 'chrome': {
        var tch = mix(p, '#c9ced6', 0.42);
        return [[0, shade(tch, 0.85)], [0.16, shade(tch, 0.45)], [0.36, shade(tch, -0.05)], [0.40, shade(tch, -0.72)], [0.44, shade(tch, 0.55)],
          [0.6, shade(tch, 0.15)], [0.78, mix(shade(tch, -0.35), '#4a3a2a', 0.35)], [0.9, shade(tch, -0.55)], [1, shade(tch, -0.2)]];
      }
      case 'candy': {
        var cp = sat(p, 1.25);
        return [[0, shade(cp, 0.6)], [0.1, shade(cp, 0.25)], [0.3, cp], [0.55, shade(cp, -0.3)], [0.8, shade(cp, -0.62)], [1, shade(cp, -0.82)]];
      }
      case 'chameleon': return [[0, shade(hue(p, hs), 0.35)], [0.3, p], [0.6, hue(p, -hs * 0.6)], [1, shade(hue(p, hs * 1.6), -0.5)]];
      case 'metallic':
      default:
        return [[0, shade(p, 0.48)], [0.1, shade(p, 0.22)], [0.3, p], [0.52, shade(p, -0.16)], [0.6, shade(p, 0.05)], [0.84, shade(p, -0.4)], [1, shade(p, -0.62)]];
    }
  }
  function chameleonAnim(p, d, offsetIdx) {
    var hs = d.hueShift || 70;
    var cyc = [p, hue(p, hs), hue(p, hs * 2), hue(p, -hs * 0.7), p];
    var rot = cyc.slice(offsetIdx).concat(cyc.slice(1, offsetIdx + 1));
    return '<animate attributeName="stop-color" dur="9s" repeatCount="indefinite" values="' + rot.join(';') + '"/>';
  }
  function paintGradient(id, p, d, x2, y2, gradAttrs) {
    var st = paintStops(p, d);
    var body = '';
    for (var i = 0; i < st.length; i++) {
      var anim = d.finish === 'chameleon' ? chameleonAnim(st[i][1], d, i % 3) : '';
      body += '<stop offset="' + f2(st[i][0]) + '" stop-color="' + st[i][1] + '"' + (anim ? '>' + anim + '</stop>' : '/>');
    }
    return '<linearGradient id="' + id + '" x1="0" y1="0" x2="' + x2 + '" y2="' + y2 + '"' + (gradAttrs || '') + '>' + body + '</linearGradient>';
  }

  function paintDefs(P, sp, opts) {
    var c = sp.c, d = sp.d, n = sp.n, p = c.paint, out = [];
    var hi = opts && opts.detail === 'low' ? 0 : 1;
    out.push(paintGradient(P + 'paint', p, d, 0, 1));
    out.push(paintGradient(P + 'paintH', p, d, 1, 0));
    // plan view: lit along the spine, falling off towards both flanks
    var k = d.finish === 'matte' ? 0.45 : d.finish === 'chrome' ? 1.6 : d.finish === 'satin' ? 0.7 : 1;
    var tops = [[0, shade(p, -0.5 * k)], [0.16, shade(p, -0.14 * k)], [0.38, shade(p, 0.12 * k)], [0.5, shade(p, 0.26 * k)], [0.62, shade(p, 0.1 * k)], [0.84, shade(p, -0.16 * k)], [1, shade(p, -0.5 * k)]];
    var tb = '';
    for (var ti = 0; ti < tops.length; ti++) {
      var tAnim = d.finish === 'chameleon' ? chameleonAnim(tops[ti][1], d, ti % 3) : '';
      tb += '<stop offset="' + f2(tops[ti][0]) + '" stop-color="' + tops[ti][1] + '"' + (tAnim ? '>' + tAnim + '</stop>' : '/>');
    }
    out.push('<linearGradient id="' + P + 'paintTop" x1="0" y1="0" x2="0" y2="1">' + tb + '</linearGradient>');
    // roof / mirror / contrast materials
    out.push('<linearGradient id="' + P + 'roofc" x1="0" y1="0" x2="0" y2="1">' + stops([[0, shade(c.roof, 0.35)], [0.45, c.roof], [1, shade(c.roof, -0.45)]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'gblack" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#4a4d54'], [0.18, '#17181c'], [0.6, '#0a0a0c'], [1, '#000000']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'trim" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#34363b'], [0.5, '#141518'], [1, '#050506']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'chrome" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#ffffff'], [0.25, '#c9ced6'], [0.48, '#5d636c'], [0.52, '#f2f4f7'], [0.8, '#9aa0a8'], [1, '#e8eaee']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'chromeH" x1="0" y1="0" x2="1" y2="0">' + stops([[0, '#8e949c'], [0.3, '#ffffff'], [0.55, '#6b7179'], [0.75, '#e3e6ea'], [1, '#7d838b']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'blued" x1="0" y1="0" x2="1" y2="1">' + stops([[0, '#d9b36a'], [0.3, '#b0607a'], [0.55, '#5b4fb0'], [0.8, '#2f6fc0'], [1, '#c9d1dc']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'badgeBlack" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#55585f'], [0.5, '#101114'], [1, '#2a2c31']]) + '</linearGradient>');
    // glass
    var tint = n.tint;
    out.push('<linearGradient id="' + P + 'glass" x1="0" y1="0" x2="0.35" y2="1">' + stops([
      [0, mix('#a9bfd3', '#1b2430', tint * 0.7), 0.95 - tint * 0.25], [0.35, mix('#4b6378', '#0b1117', tint * 0.85)], [0.7, mix('#1d2a36', '#05080b', tint)], [1, mix('#2a3946', '#080b0f', tint)]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'glassRef" x1="0" y1="0" x2="1" y2="0.6">' + stops([[0, '#ffffff', 0], [0.42, '#ffffff', 0], [0.5, '#ffffff', 0.22], [0.58, '#ffffff', 0.05], [0.66, '#ffffff', 0.14], [0.7, '#ffffff', 0], [1, '#ffffff', 0]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'glassTop" x1="0" y1="0" x2="1" y2="0">' + stops([[0, mix('#22303c', '#06090c', tint)], [0.5, mix('#6f879b', '#141c24', tint)], [1, mix('#22303c', '#06090c', tint)]]) + '</linearGradient>');
    // shading overlays
    var gl = d.gloss;
    var specA = d.finish === 'matte' ? 0.05 : d.finish === 'satin' ? 0.16 : d.finish === 'chrome' ? 0.7 : 0.18 + gl * 0.32;
    out.push('<linearGradient id="' + P + 'spec" x1="0" y1="0" x2="1" y2="0">' + stops([[0, '#ffffff', 0], [0.18, '#ffffff', specA * 0.5], [0.42, '#ffffff', specA], [0.62, '#ffffff', specA * 0.35], [0.8, '#ffffff', specA * 0.7], [1, '#ffffff', 0]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'lowShade" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#000000', 0], [0.55, '#000000', 0.18], [1, '#000000', 0.55]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'topLight" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#ffffff', d.finish === 'matte' ? 0.06 : 0.22 * (0.4 + gl)], [1, '#ffffff', 0]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'edgeShade" x1="0" y1="0" x2="1" y2="0">' + stops([[0, '#000000', 0.5], [0.12, '#000000', 0.12], [0.5, '#000000', 0], [0.88, '#000000', 0.12], [1, '#000000', 0.5]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'edgeShadeV" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#000000', 0.45], [0.14, '#000000', 0.1], [0.5, '#000000', 0], [0.86, '#000000', 0.1], [1, '#000000', 0.45]]) + '</linearGradient>');
    out.push('<radialGradient id="' + P + 'hot" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#ffffff', d.finish === 'matte' ? 0.05 : 0.25 + gl * 0.4], [0.5, '#ffffff', 0.08], [1, '#ffffff', 0]]) + '</radialGradient>');
    // stripes
    out.push('<linearGradient id="' + P + 'fade" x1="1" y1="0" x2="0" y2="0">' + stops([[0, c.stripe, 0.95], [0.35, c.stripe, 0.75], [0.7, c.stripe, 0.18], [1, c.stripe, 0]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'fadeTop" x1="1" y1="0" x2="0" y2="0">' + stops([[0, c.stripe, 0.9], [0.5, c.stripe, 0.4], [1, c.stripe, 0]]) + '</linearGradient>');
    out.push('<pattern id="' + P + 'halftone" width="9" height="9" patternUnits="userSpaceOnUse">' + circleEl(4.5, 4.5, 2.2, { fill: c.stripe }) + '</pattern>');
    // flakes
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') {
      var r = rng(hashStr(p + d.finish)), fl = '';
      var tintF = d.finish === 'pearl' ? hue(shade(p, 0.6), 40) : d.finish === 'chameleon' ? hue(shade(p, 0.5), d.hueShift) : '#ffffff';
      for (var i = 0; i < 26; i++) {
        fl += circleEl(r() * 14, r() * 14, 0.18 + r() * 0.3, { fill: r() > 0.35 ? tintF : '#000000', opacity: f2(0.2 + r() * 0.5) });
      }
      out.push('<pattern id="' + P + 'flake" width="14" height="14" patternUnits="userSpaceOnUse">' + fl + '</pattern>');
    }
    // carbon twill (2x2) and forged carbon
    out.push('<pattern id="' + P + 'carbon" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      rectEl(0, 0, 6, 6, { fill: '#16171a' }) + rectEl(0, 0, 3, 1.5, { fill: '#2b2d32' }) + rectEl(3, 3, 3, 1.5, { fill: '#2b2d32' }) +
      rectEl(1.5, 3, 1.5, 3, { fill: '#202226' }) + rectEl(4.5, 0, 1.5, 3, { fill: '#202226' }) + '</pattern>');
    out.push('<linearGradient id="' + P + 'carbonSheen" x1="0" y1="0" x2="1" y2="1">' + stops([[0, '#ffffff', 0.18], [0.45, '#ffffff', 0.02], [0.6, '#ffffff', 0.12], [1, '#ffffff', 0]]) + '</linearGradient>');
    // real-car shapes: grille mesh (honeycomb) and amber indicator lens
    out.push('<pattern id="' + P + 'grilleMesh" width="5" height="4.4" patternUnits="userSpaceOnUse">' + rectEl(0, 0, 5, 4.4, { fill: '#08090a' }) +
      pathEl('M0 2.2 L1.25 0 L3.75 0 L5 2.2 L3.75 4.4 L1.25 4.4 Z', { fill: 'none', stroke: '#2e3136', 'stroke-width': 0.7 }) + '</pattern>');
    out.push('<linearGradient id="' + P + 'amber" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#ffd27a'], [0.5, '#f0960f'], [1, '#a85a00']]) + '</linearGradient>');
    // tyres, rotors, calipers
    out.push('<radialGradient id="' + P + 'tire" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#050506'], [0.62, '#141417'], [0.86, '#1d1d21'], [0.95, '#26262b'], [1, '#0b0b0d']]) + '</radialGradient>');
    out.push('<linearGradient id="' + P + 'tread" x1="0" y1="0" x2="1" y2="0">' + stops([[0, '#060607'], [0.12, '#1b1b1f'], [0.5, '#24242a'], [0.88, '#1b1b1f'], [1, '#060607']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'treadV" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#060607'], [0.12, '#1b1b1f'], [0.5, '#24242a'], [0.88, '#1b1b1f'], [1, '#060607']]) + '</linearGradient>');
    out.push('<radialGradient id="' + P + 'well" cx="0.5" cy="0.62" r="0.55">' + stops([[0, '#000000'], [0.7, '#060607'], [1, '#141416']]) + '</radialGradient>');
    out.push('<radialGradient id="' + P + 'rotIron" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#3a3c40'], [0.5, '#6d7076'], [0.75, '#9a9ea5'], [0.9, '#7a7d83'], [1, '#55585d']]) + '</radialGradient>');
    out.push('<radialGradient id="' + P + 'rotCer" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#2a2b2e'], [0.6, '#3c3d41'], [0.85, '#4a4b4f'], [1, '#2f3033']]) + '</radialGradient>');
    out.push('<radialGradient id="' + P + 'hat" cx="0.42" cy="0.38" r="0.6">' + stops([[0, '#e3e6ea'], [0.6, '#9ca2aa'], [1, '#5d636b']]) + '</radialGradient>');
    out.push('<pattern id="' + P + 'speckle" width="5" height="5" patternUnits="userSpaceOnUse">' + circleEl(1, 1, 0.35, { fill: '#7b7d82' }) + circleEl(3.6, 2.4, 0.3, { fill: '#18191b' }) + circleEl(2.2, 4.1, 0.28, { fill: '#909297' }) + '</pattern>');
    out.push('<linearGradient id="' + P + 'cal" x1="0" y1="0" x2="0" y2="1">' + stops([[0, shade(c.caliper, 0.4)], [0.35, c.caliper], [1, shade(c.caliper, -0.45)]]) + '</linearGradient>');
    // lights
    var lensCol = d.lights === 'halogen' ? '#fff0c2' : d.lights === 'laser' ? '#dce9ff' : '#f2f7ff';
    out.push('<linearGradient id="' + P + 'lens" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#ffffff', 0.9], [0.3, lensCol], [0.7, mix(lensCol, '#6d7887', 0.45)], [1, '#2a2f37']]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'tailL" x1="0" y1="0" x2="0" y2="1">' + stops([[0, '#ff8a80'], [0.3, '#ff2a2a'], [0.75, '#a00010'], [1, '#4a0006']]) + '</linearGradient>');
    out.push('<radialGradient id="' + P + 'beam" cx="0" cy="0.5" r="1">' + stops([[0, lensCol, d.theme === 'light' ? 0.06 : 0.12], [0.6, lensCol, 0.03], [1, lensCol, 0]]) + '</radialGradient>');
    out.push('<radialGradient id="' + P + 'tailGlow" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#ff2a2a', 0.5], [1, '#ff2a2a', 0]]) + '</radialGradient>');
    // shadows & studio
    out.push('<radialGradient id="' + P + 'shadow" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#000000', d.theme === 'light' ? 0.42 : 0.7], [0.55, '#000000', d.theme === 'light' ? 0.2 : 0.35], [1, '#000000', 0]]) + '</radialGradient>');
    out.push('<radialGradient id="' + P + 'pool" cx="0.5" cy="0.5" r="0.5">' + stops([[0, '#ffffff', d.theme === 'light' ? 0.55 : 0.07], [1, '#ffffff', 0]]) + '</radialGradient>');
    out.push('<linearGradient id="' + P + 'studio" x1="0" y1="0" x2="0" y2="1">' + (d.theme === 'light'
      ? stops([[0, '#f4f2ed'], [0.62, '#e8e5de'], [0.835, '#ddd9d0'], [1, '#d4cfc4']])
      : stops([[0, '#17181d'], [0.62, '#0f1014'], [0.835, '#0b0b0e'], [1, '#060607']])) + '</linearGradient>');
    out.push('<radialGradient id="' + P + 'spot" cx="0.5" cy="0.25" r="0.65">' + stops([[0, d.theme === 'light' ? '#ffffff' : '#c9a56b', d.theme === 'light' ? 0.8 : 0.14], [1, '#000000', 0]]) + '</radialGradient>');
    out.push('<linearGradient id="' + P + 'horizon" x1="0" y1="0" x2="1" y2="0">' + stops([[0, '#c9a56b', 0], [0.5, '#c9a56b', d.theme === 'light' ? 0.3 : 0.32], [1, '#c9a56b', 0]]) + '</linearGradient>');
    // x-ray
    out.push('<linearGradient id="' + P + 'xbat" x1="0" y1="0" x2="0" y2="1">' + stops([[0, XR_BAT, 0.55], [1, XR_BAT, 0.18]]) + '</linearGradient>');
    out.push('<linearGradient id="' + P + 'xeng" x1="0" y1="0" x2="0" y2="1">' + stops([[0, XR_ENG, 0.5], [1, XR_ENG, 0.14]]) + '</linearGradient>');
    out.push('<pattern id="' + P + 'check" width="8" height="8" patternUnits="userSpaceOnUse">' + rectEl(0, 0, 8, 8, { fill: '#ffffff' }) + rectEl(0, 0, 4, 4, { fill: '#111111' }) + rectEl(4, 4, 4, 4, { fill: '#111111' }) + '</pattern>');
    // filters
    out.push('<filter id="' + P + 'glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    out.push('<filter id="' + P + 'blur" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="7"/></filter>');
    out.push('<filter id="' + P + 'blurS" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/></filter>');
    out.push('<filter id="' + P + 'blurM" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>');
    return out.join('');
  }
  function url(P, id) { return 'url(#' + P + id + ')'; }

  /* ======================================================================
     SIDE VIEW — geometry (millimetres; x from the front bumper, y up from the ground)
     ====================================================================== */
  function sideGeom(sp) {
    var n = sp.n, d = sp.d;
    var dWb = n.wb - n.wb0, L = n.L0 + dWb;
    var s = clamp(1010 / L, 0.15, 0.205);
    if (n.shapeH > 0) s = Math.min(s, 400 / n.shapeH); // tall real models (high-roof vans) stay inside the frame
    var G = { n: n, d: d, c: sp.c, s: s, L: L, dz: n.ride - n.nomRide };
    G.ox = (VBW - L * s) / 2;
    G.X = function (fr) {
      var m0 = fr * n.L0;
      if (m0 <= n.fo) return m0;
      if (m0 >= n.fo + n.wb0) return m0 + dWb;
      return n.fo + (m0 - n.fo) * n.wb / n.wb0;
    };
    G.Y = function (fy) { return fy * n.H + G.dz; };
    G.px = function (mm) { return G.ox + mm * s; };
    G.py = function (mm) { return GROUND - mm * s; };
    G.fa = n.fo; G.ra = n.fo + n.wb;
    G.yb = n.ride;
    var gap = clamp(34 + G.dz * 0.8, 8, 170) + (d.archStyle === 'flared' ? 6 : d.archStyle === 'squared' ? 16 : 0);
    G.aRF = n.tRF + gap; G.aRR = n.tRR + gap;
    G.top = topProfile(G);
    G.prof = function (x) { return profileAt(G.top, x); };
    G.yBelt = G.Y(n.belt); G.yRoof = G.Y(n.roofH); G.yDeck = G.Y(n.deck); G.yNose = G.Y(n.nose); G.yTail = G.Y(n.tail);
    G.xA = G.X(n.cs); G.xRS = G.X(Math.max(n.rs, n.cs + 0.02)); G.xRE = G.X(Math.max(n.re, n.rs + 0.04)); G.xCE = G.X(Math.max(n.ce, n.re + 0.05));
    G.yCowl = G.Y(G.cowlF);
    G.doors = doorLayout(G);
    G.wingMount = wingMount(G);
    var topMm = 0;
    for (var i = 0; i < G.top.length; i++) topMm = Math.max(topMm, G.top[i][1]);
    G.topMm = Math.max(topMm, G.wingMount ? G.wingMount.topMm : 0);
    G.bounds = { x: G.px(-160), y: G.py(G.topMm + 140), w: (L + 320) * s, h: G.py(-60) - G.py(G.topMm + 140) };
    return G;
  }

  function topProfile(G) {
    var n = G.n, d = G.d, X = G.X, Y = G.Y, pts = [];
    function P(fx, fy, sh) { pts.push([X(fx), Y(fy), sh ? 1 : 0]); }
    var nose = n.nose, belt = n.belt, cs = n.cs, rs = Math.max(n.rs, cs + 0.02), re = Math.max(n.re, rs + 0.04), ce = Math.max(n.ce, re + 0.05);
    var rh = n.roofH, deck = n.deck, tail = n.tail;
    var cowl = Math.max(belt + 0.02, nose + 0.05);
    if (d.openTop) cowl = Math.max(belt + 0.025, nose + 0.06);
    G.cowlF = cowl;
    switch (d.noseStyle) {
      case 'wedge': P(-0.004, nose * 0.34, 1); P(0.025, nose * 0.62); P(0.12, nose * 0.86); P(cs * 0.75, lerp(nose, cowl, 0.78)); break;
      case 'blunt': P(0, nose * 0.4); P(0.003, nose * 0.9); P(0.022, nose); P(Math.max(0.05, cs * 0.55), lerp(nose, cowl, 0.6)); break;
      case 'tall': P(0, nose * 0.48); P(0.007, nose * 0.9); P(0.035, nose); P(Math.max(0.07, cs * 0.6), lerp(nose, cowl, 0.65)); break;
      case 'short': P(0, nose * 0.58); P(0.014, nose * 0.95); P(0.06, lerp(nose, cowl, 0.4)); P(Math.max(0.09, cs * 0.7), lerp(nose, cowl, 0.82)); break;
      case 'low': P(0, nose * 0.5); P(0.016, nose * 0.9); P(0.08, lerp(nose, cowl, 0.3)); P(Math.max(0.1, cs * 0.6), lerp(nose, cowl, 0.7)); break;
      default: P(0, nose * 0.55); P(0.012, nose * 0.93); P(0.05, lerp(nose, cowl, 0.22)); P(Math.max(0.08, cs * 0.55), lerp(nose, cowl, 0.68));
    }
    P(cs, cowl, 1);
    if (d.openTop) {
      P(lerp(cs, ce, 0.5), lerp(cowl, deck, 0.5) - 0.004); P(ce, deck);
      P(0.93, deck + 0.004); P(0.992, lerp(deck, tail, 0.55)); P(1, tail * 0.74);
    } else {
      P(rs, rh * 0.986); P(lerp(rs, re, 0.45), rh);
      switch (d.tailStyle) {
        case 'notchback': P(re, rh * 0.978); P(lerp(re, ce, 0.55), lerp(rh, deck, 0.62)); P(ce, deck + 0.012, 1); P(0.955, deck + 0.004); P(0.994, deck - 0.03); P(1, tail * 0.72); break;
        case 'hatch': P(re, rh * 0.985); P(Math.min(re + 0.012, ce - 0.01), rh * 0.962); P(ce, deck + 0.05); P(0.99, deck - 0.005); P(1, tail * 0.72); break;
        case 'wagon': P(re, rh * 0.98); P(lerp(re, ce, 0.5), lerp(rh, deck, 0.16)); P(ce, lerp(rh, deck, 0.5)); P(Math.max(ce + 0.005, 0.992), deck + 0.005); P(1, tail * 0.72); break;
        case 'kammback': P(re, rh * 0.97); P(lerp(re, ce, 0.55), lerp(rh, deck, 0.45)); P(ce, deck + 0.06); P(0.996, deck + 0.03, 1); P(1, tail * 0.72); break;
        case 'box': P(re, rh * 0.995); P(Math.min(ce, 0.985), rh * 0.955); P(0.998, lerp(rh, deck, 0.45)); P(1, deck - 0.02); P(1, tail * 0.66); break;
        case 'bed': P(re, rh * 0.98); P(Math.min(re + 0.012, ce - 0.01), lerp(rh, belt, 0.55)); P(ce, deck + 0.012, 1); P(0.994, deck, 1); P(1, deck - 0.03); P(1, tail * 0.5); break;
        case 'longtail': P(re, rh * 0.975); P(lerp(re, ce, 0.5), lerp(rh, deck, 0.6)); P(ce, deck + 0.02); P(0.9, deck + 0.004); P(0.985, tail + 0.04); P(1, tail, 1); P(1, tail * 0.55); break;
        default: P(re, rh * 0.975); P(lerp(re, ce, 0.5), lerp(rh, deck, 0.58)); P(ce, deck + 0.01); P(lerp(ce, 1, 0.6), deck - 0.006); P(0.994, lerp(deck, tail, 0.6)); P(1, tail * 0.74);
      }
    }
    // fender bulges: the bodywork must clear the arches (big wheels / lowered cars sprout haunches)
    ensureMin(pts, G.fa, n.tRF + G.aRF + 70, G.aRF);
    ensureMin(pts, G.ra, n.tRR + G.aRR + 70, G.aRR);
    return pts;
  }
  function profileAt(pts, x) {
    var best = -Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var lo = Math.min(a[0], b[0]), hi2 = Math.max(a[0], b[0]);
      if (x < lo || x > hi2) continue;
      var y = b[0] === a[0] ? Math.max(a[1], b[1]) : lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
      if (y > best) best = y;
    }
    if (best === -Infinity) best = x <= pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
    return best;
  }
  /* Raise the profile around an axle so the bodywork clears the arch; the lift fades out smoothly
     over +/-1.7 arch radii, giving a sculpted wing/haunch instead of a lump. */
  function ensureMin(pts, x, need, half) {
    var y = profileAt(pts, x);
    var deficit = need - y;
    if (deficit <= 0) return;
    var reach = half * 1.7, near = false;
    for (var i = 1; i < pts.length - 1; i++) {
      var dx = Math.abs(pts[i][0] - x);
      if (dx >= reach) continue;
      var k = 0.5 + 0.5 * Math.cos(PI * dx / reach);
      if (pts[i][2]) k *= 0.35;
      pts[i][1] += deficit * k;
      if (dx < half * 0.35) near = true;
    }
    if (!near && profileAt(pts, x) < need - 1) {
      for (var j = 0; j < pts.length - 1; j++) {
        if (pts[j][0] <= x && pts[j + 1][0] > x) { pts.splice(j + 1, 0, [x, need, 0]); return; }
      }
    }
  }
  function archHit(cx, cy, R, yE) {
    var dy = yE - cy;
    if (Math.abs(dy) > R * 0.96) { dy = (dy < 0 ? -1 : 1) * R * 0.96; yE = cy + dy; }
    return { dx: Math.sqrt(R * R - dy * dy), y: yE, large: yE < cy ? 1 : 0 };
  }
  /* body silhouette as a px path */
  function bodyPathSide(G) {
    var px = G.px, py = G.py, s = G.s, d = G.d, n = G.n, L = G.L;
    var pts = [[G.X(0.012), G.yb + 62, 0]].concat(G.top).concat([[L - 28, G.yb + 112, 0]]);
    var pp = pts.map(function (p) { return [px(p[0]), py(p[1]), p[2]]; });
    var dpath = smoothD(pp, false);
    var yE = G.yb + 12;
    var aR = archHit(G.ra, n.tRR, G.aRR, yE), aF = archHit(G.fa, n.tRF, G.aRF, yE);
    dpath += ' L' + P2(px(Math.min(L - 60, G.ra + aR.dx + 90)), py(G.yb + 48));
    dpath += archSeg(G, G.ra, n.tRR, G.aRR, aR);
    dpath += ' L' + P2(px(G.fa + aF.dx), py(aF.y));
    dpath += archSeg(G, G.fa, n.tRF, G.aRF, aF);
    dpath += ' L' + P2(px(Math.max(60, G.fa - aF.dx - 70)), py(G.yb + 44)) + ' Z';
    return dpath;
  }
  function archSeg(G, cx, cy, R, hit) {
    var px = G.px, py = G.py, s = G.s;
    if (G.d.archStyle === 'squared') {
      var q = [[cx + hit.dx, hit.y], [cx + R * 0.94, cy + R * 0.42], [cx + R * 0.6, cy + R * 0.92], [cx - R * 0.6, cy + R * 0.92], [cx - R * 0.94, cy + R * 0.42], [cx - hit.dx, hit.y]];
      var str = ' L' + P2(px(q[0][0]), py(q[0][1]));
      for (var i = 1; i < q.length; i++) str += ' L' + P2(px(q[i][0]), py(q[i][1]));
      return str;
    }
    return ' L' + P2(px(cx + hit.dx), py(hit.y)) + ' A' + f2(R * s) + ' ' + f2(R * s) + ' 0 ' + hit.large + ' 0 ' + P2(px(cx - hit.dx), py(hit.y));
  }

  function doorLayout(G) {
    var d = G.d, sideDoors = d.doors >= 4 ? 2 : 1;
    if (d.style === 'hypercar' || d.style === 'roadster' || d.style === 'coupe' || d.style === 'shooting-brake') sideDoors = 1;
    var x0 = Math.max(G.fa + G.aRF + 45, G.xA - (d.style === 'van' ? 40 : 130));
    var xMax = G.ra - G.aRR - 30;
    var doors = [];
    if (sideDoors === 1) {
      var len = d.style === 'pickup' ? 1120 : d.style === 'hypercar' ? 1180 : d.style === 'hatchback' ? 1120 : d.style === 'roadster' ? 1050 : 1260;
      var x1 = Math.min(x0 + len, xMax + 40);
      if (x1 < x0 + 600) x1 = x0 + 600;
      doors.push({ x0: x0, x1: x1, front: true });
    } else {
      var end = Math.min(G.ra - G.aRR * 0.35, G.xCE - 80);
      if (d.style === 'pickup') end = Math.min(end, G.xCE - 40);
      var span = Math.max(1200, end - x0);
      var fl = span * (d.style === 'van' ? 0.4 : 0.53);
      doors.push({ x0: x0, x1: x0 + fl, front: true });
      doors.push({ x0: x0 + fl + 10, x1: x0 + span, rear: true, slide: d.style === 'van' });
    }
    return doors;
  }

  function wingMount(G) {
    var d = G.d, n = G.n, w = d.wing;
    if (w === 'none' || w === 'ducktail' || w === 'lip-spoiler') return null;
    var roofMount = ['hatch', 'wagon', 'box', 'kammback'].indexOf(d.tailStyle) >= 0 && !d.openTop;
    var chord = w === 'active' ? 380 : w === 'swan-neck' ? 300 : w === 'biplane' ? 300 : 330;
    var xLe = roofMount ? G.xCE - chord * 0.75 : G.L - chord - G.L * 0.035;
    if (d.tailStyle === 'bed') xLe = G.L - chord - 120;
    var base = G.prof(xLe + chord * 0.5);
    var hgt = w === 'active' ? (d.activeAero ? 70 + n.wingAng * 9 : 34) : w === 'biplane' ? 360 : w === 'swan-neck' ? 300 : 330;
    if (roofMount) hgt *= 0.42;
    return { type: w, xLe: xLe, chord: chord, base: base, h: hgt, roof: roofMount, topMm: base + hgt + chord * 0.2 };
  }

  /* greenhouse daylight opening (mm points, closed) */
  function dloSide(G) {
    var d = G.d;
    if (d.openTop) return null;
    var inset = d.style === 'van' || d.style === 'suv' || d.style === 'pickup' ? 72 : 60;
    var yB = G.yBelt + 14;
    var xA = G.xA, yC = G.yCowl, xRS = G.xRS, yR = G.prof(xRS + 4);
    var slope = (xRS - xA) / Math.max(1, yR - yC);
    var pill = d.style === 'hypercar' ? 45 : d.style === 'van' ? 60 : 78;
    var q1 = [xA + (yB - yC) * slope + pill + 18, yB, 1];
    var q2 = [xRS - inset * slope * 0.9 + pill * 0.7, yR - inset, 0];
    var closedBack = ['hatch', 'wagon', 'box', 'kammback', 'bed'].indexOf(d.tailStyle) >= 0;
    var cp = d.pillar === 'thick' ? 170 : d.pillar === 'floating' ? 80 : 95;
    var xStart = Math.max(q2[0] + 60, xRS + 40), xLimit = G.xCE - cp;
    if (d.tailStyle === 'bed') xLimit = G.xRE - 50;
    var steps = 16, step = (xLimit - xStart) / steps, top = [], lastX = xStart, broke = false;
    var fn = function (x) { return G.prof(x) - inset - (yB + 30); };
    for (var i = 0; i <= steps; i++) {
      var x = xStart + step * i;
      if (fn(x) < 0) { broke = true; break; }
      top.push([x, G.prof(x) - inset, 0]);
      lastX = x;
    }
    var pts = [q1, q2].concat(top);
    if (broke && top.length) {
      var lo = lastX, hi2 = lastX + step;
      for (var k = 0; k < 18; k++) { var mid = (lo + hi2) / 2; if (fn(mid) > 0) lo = mid; else hi2 = mid; }
      pts.push([lo + 30, yB, 1]);
    } else if (top.length) {
      var yTopEnd = G.prof(xLimit) - inset;
      pts.push([xLimit, closedBack ? Math.max(yB + 40, yTopEnd - 30) : yTopEnd, 0]);
      pts.push([xLimit - (closedBack ? 10 : 60), yB, 1]);
    } else {
      pts.push([q2[0] + 200, yB, 1]);
    }
    var xRear = pts[pts.length - 1][0];
    return { pts: pts, xFront: q1[0], xRear: xRear, yB: yB, inset: inset };
  }

  /* B/C/D pillars: x positions (mm) of window dividers */
  function pillarsSide(G, dlo) {
    var d = G.d, out = [];
    if (!dlo || d.sideWindows <= 1) return out;
    var lo = dlo.xFront + 180, hi2 = dlo.xRear - 140;
    G.doors.forEach(function (dr) { if (dr.x1 > lo && dr.x1 < hi2) out.push(dr.x1 - 30); });
    var want = d.sideWindows - 1;
    var guard = 0;
    while (out.length < want && guard++ < 6) {
      var pos = [lo - 180].concat(out.slice().sort(function (a, b) { return a - b; })).concat([dlo.xRear]);
      var bi = 0, bl = 0;
      for (var i = 0; i < pos.length - 1; i++) { var l = pos[i + 1] - pos[i]; if (l > bl * 0.9) { bl = l; bi = i; } }
      if (bl < 420) break;
      var x = pos[bi] + bl * (bi === pos.length - 2 ? 0.58 : 0.5);
      if (x <= lo || x >= hi2) break;
      out.push(x);
    }
    return out.sort(function (a, b) { return a - b; }).slice(0, want);
  }

  /* ======================================================================
     WHEELS (side face) — tyre, sidewall lettering, rotor, caliper, spokes per design
     ====================================================================== */
  function spinAttrs(cx, cy, o) {
    var a = { 'data-spin': '1', 'data-cx': f(cx), 'data-cy': f(cy) };
    if (o.spinAngle) a.transform = 'rotate(' + f(o.spinAngle) + ' ' + f(cx) + ' ' + f(cy) + ')';
    return a;
  }
  function smilSpin(cx, cy, o, dur) {
    if (!o.spin) return '';
    return '<animateTransform attributeName="transform" type="rotate" from="0 ' + f(cx) + ' ' + f(cy) + '" to="360 ' + f(cx) + ' ' + f(cy) + '" dur="' + (dur || '0.9s') + '" repeatCount="indefinite"/>';
  }

  function spokeShapes(sp, cx, cy, r) {
    var d = sp.d, N = Math.max(d.spokes, 0), style = d.wstyle, id = d.wheel;
    var fills = [], holes = null, lines = [], hubR = r * 0.2, faceR = r * 0.93, a0 = -PI / 2, k, a, i;
    function pp(rad, ang) { return polar(cx, cy, rad, ang); }
    switch (style) {
      case 'y': {
        N = N || 5;
        var dl = TAU / N * 0.2, tw = 0.07;
        for (k = 0; k < N; k++) {
          a = a0 + k * TAU / N;
          var wH = r * 0.09, wS = r * 0.06, wB = r * 0.042, rS = r * 0.5, rC = lerp(rS, faceR, 0.4);
          fills.push(polyD([pp(hubR, a - wH / hubR), pp(rS, a - wS / rS), pp(faceR, a - dl - wB / faceR + tw), pp(faceR, a - dl + wB / faceR + tw),
            pp(rC, a + tw * 0.55), pp(faceR, a + dl - wB / faceR + tw), pp(faceR, a + dl + wB / faceR + tw), pp(rS, a + wS / rS), pp(hubR, a + wH / hubR)], true));
        }
        fills.push(circleD(cx, cy, hubR * 1.35));
        break;
      }
      case 'split': {
        N = N || 10;
        var pairs = id === 'split-10' ? N / 2 : N;
        var dl2 = TAU / pairs * 0.15;
        for (k = 0; k < pairs; k++) {
          a = a0 + k * TAU / pairs;
          for (var sg = -1; sg <= 1; sg += 2) {
            var wh = r * 0.034 / hubR, wr = r * 0.028 / faceR;
            fills.push(polyD([pp(hubR, a + sg * 0.07 - wh), pp(hubR, a + sg * 0.07 + wh), pp(faceR, a + sg * dl2 + wr), pp(faceR, a + sg * dl2 - wr)], true));
          }
        }
        fills.push(circleD(cx, cy, hubR * 1.3));
        break;
      }
      case 'mesh': {
        N = N || 20;
        if (id === 'multi-spoke') {
          for (k = 0; k < N; k++) {
            a = a0 + k * TAU / N;
            var w1 = r * 0.03 / hubR, w2 = r * 0.016 / faceR;
            fills.push(polyD([pp(hubR, a - w1), pp(faceR, a - w2), pp(faceR, a + w2), pp(hubR, a + w1)], true));
          }
          fills.push(circleD(cx, cy, hubR * 1.25));
        } else {
          var r0 = r * 0.3, sk = TAU / N * 1.5;
          for (k = 0; k < N; k++) {
            a = a0 + k * TAU / N;
            var p0 = pp(r0, a), pa = pp(faceR, a + sk), pb = pp(faceR, a - sk);
            lines.push('M' + P2(p0[0], p0[1]) + ' L' + P2(pa[0], pa[1]) + ' M' + P2(p0[0], p0[1]) + ' L' + P2(pb[0], pb[1]));
          }
          fills.push(circleD(cx, cy, r0 * 1.05));
        }
        break;
      }
      case 'turbine': {
        N = N || 12;
        if (id === 'fan-blade') {
          holes = circleD(cx, cy, faceR);
          for (k = 0; k < N; k++) {
            a = a0 + k * TAU / N;
            var s1 = pp(r * 0.42, a), c1 = pp(r * 0.66, a + 0.22), e1 = pp(r * 0.86, a + 0.36), e2 = pp(r * 0.86, a + 0.36 + TAU / N * 0.4), c2 = pp(r * 0.66, a + 0.22 + TAU / N * 0.42), s2 = pp(r * 0.42, a + TAU / N * 0.3);
            holes += ' M' + P2(s1[0], s1[1]) + ' Q' + P2(c1[0], c1[1]) + ' ' + P2(e1[0], e1[1]) + ' L' + P2(e2[0], e2[1]) + ' Q' + P2(c2[0], c2[1]) + ' ' + P2(s2[0], s2[1]) + ' Z';
          }
        } else {
          var wA = TAU / N * 0.42;
          for (k = 0; k < N; k++) {
            a = a0 + k * TAU / N;
            var b1 = pp(hubR, a), b2 = pp(r * 0.6, a + 0.32), b3 = pp(faceR, a + 0.55), b4 = pp(faceR, a + 0.55 + wA * 0.62), b5 = pp(r * 0.6, a + 0.32 + wA), b6 = pp(hubR, a + wA * 0.5);
            fills.push('M' + P2(b1[0], b1[1]) + ' Q' + P2(b2[0], b2[1]) + ' ' + P2(b3[0], b3[1]) + ' L' + P2(b4[0], b4[1]) + ' Q' + P2(b5[0], b5[1]) + ' ' + P2(b6[0], b6[1]) + ' Z');
          }
          fills.push(circleD(cx, cy, hubR * 1.4));
        }
        break;
      }
      case 'dish': {
        N = N || 8;
        holes = circleD(cx, cy, r * 0.62) + windows(cx, cy, N, r * 0.26, r * 0.55, r * 0.07, r * 0.06, false, a0);
        break;
      }
      case 'centerlock': {
        N = N || 10;
        for (k = 0; k < N; k++) {
          a = a0 + k * TAU / N;
          var c1w = r * 0.05 / hubR, c2w = r * 0.026 / faceR;
          fills.push(polyD([pp(hubR, a - c1w), pp(r * 0.55, a - c1w * 0.55 + 0.03), pp(faceR, a - c2w + 0.05), pp(faceR, a + c2w + 0.05), pp(r * 0.55, a + c1w * 0.55 + 0.03), pp(hubR, a + c1w)], true));
        }
        fills.push(circleD(cx, cy, hubR * 1.25));
        break;
      }
      case 'aero-disc': {
        holes = circleD(cx, cy, faceR);
        if (N > 0) {
          for (k = 0; k < N; k++) {
            a = a0 + k * TAU / N;
            var g1 = pp(r * 0.36, a), g2 = pp(r * 0.62, a + 0.3), g3 = pp(r * 0.86, a + 0.42);
            lines.push('M' + P2(g1[0], g1[1]) + ' Q' + P2(g2[0], g2[1]) + ' ' + P2(g3[0], g3[1]));
          }
        }
        break;
      }
      default: { // monoblock (and classic five-star)
        N = N || 5;
        var star = id === 'classic-5';
        holes = circleD(cx, cy, faceR) + windows(cx, cy, N, r * (star ? 0.27 : 0.36), r * 0.84, r * (star ? 0.075 : 0.11), r * (star ? 0.02 : 0.1), star, a0);
      }
    }
    return { fills: fills, holes: holes, lines: lines, N: N };
  }
  function windows(cx, cy, N, rI, rO, wsO, wsI, star, a0) {
    var s = '';
    for (var k = 0; k < N; k++) {
      var c0 = a0 + k * TAU / N + TAU / (2 * N);
      var hO = Math.max(0.04, TAU / (2 * N) - wsO / rO), hI = Math.max(0.03, TAU / (2 * N) - wsI / rI);
      var p1 = polar(cx, cy, rO, c0 - hO), p2 = polar(cx, cy, rO, c0 + hO);
      if (star) {
        var pi = polar(cx, cy, rI, c0);
        s += ' M' + P2(pi[0], pi[1]) + ' L' + P2(p1[0], p1[1]) + ' A' + f2(rO) + ' ' + f2(rO) + ' 0 0 1 ' + P2(p2[0], p2[1]) + ' Z';
      } else {
        var p3 = polar(cx, cy, rI, c0 + hI), p4 = polar(cx, cy, rI, c0 - hI);
        s += ' M' + P2(p4[0], p4[1]) + ' L' + P2(p1[0], p1[1]) + ' A' + f2(rO) + ' ' + f2(rO) + ' 0 0 1 ' + P2(p2[0], p2[1]) + ' L' + P2(p3[0], p3[1]) + ' A' + f2(rI) + ' ' + f2(rI) + ' 0 0 0 ' + P2(p4[0], p4[1]) + ' Z';
      }
    }
    return s;
  }

  function rotorMarkup(sp, o, cx, cy, rr, idx) {
    var d = sp.d, P = o.P, hi = o.detail !== 'low', out = [], mat = d.brakeMat, k;
    var cer = mat === 'carbon-ceramic';
    out.push(circleEl(cx, cy, rr, { fill: url(P, cer ? 'rotCer' : 'rotIron') }));
    if (cer) out.push(circleEl(cx, cy, rr, { fill: url(P, 'speckle'), opacity: 0.6 }));
    if (hi) {
      out.push(circleEl(cx, cy, rr * 0.86, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.07, 'stroke-width': rr * 0.06 }));
      out.push(circleEl(cx, cy, rr * 0.72, { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.12, 'stroke-width': 0.6 }));
    }
    if (mat === 'drilled-slotted' || cer) {
      var holes = '', nH = cer ? 20 : 24;
      for (k = 0; k < nH; k++) {
        var a = k * TAU / nH;
        var ring = k % 2 ? 0.8 : 0.9;
        var hp = polar(cx, cy, rr * ring, a);
        holes += circleD(hp[0], hp[1], Math.max(0.5, rr * 0.028));
      }
      out.push(pathEl(holes, { fill: '#0b0b0c', opacity: 0.85 }));
      if (mat === 'drilled-slotted' && hi) {
        var slots = '';
        for (k = 0; k < 6; k++) {
          var sa = k * TAU / 6 + 0.25, q1 = polar(cx, cy, rr * 0.66, sa), q2 = polar(cx, cy, rr * 0.95, sa + 0.32);
          slots += 'M' + P2(q1[0], q1[1]) + ' Q' + P2(polar(cx, cy, rr * 0.8, sa + 0.08)[0], polar(cx, cy, rr * 0.8, sa + 0.08)[1]) + ' ' + P2(q2[0], q2[1]) + ' ';
        }
        out.push(pathEl(slots, { fill: 'none', stroke: '#18191b', 'stroke-width': Math.max(0.6, rr * 0.03), 'stroke-linecap': 'round', opacity: 0.8 }));
      }
    }
    // hat (bell)
    var two = mat === 'two-piece' || cer;
    out.push(circleEl(cx, cy, rr * 0.5, { fill: two ? url(P, 'hat') : '#55585e', stroke: '#2a2b2e', 'stroke-width': 0.5 }));
    if (two && hi) {
      var bolts = '';
      for (k = 0; k < 10; k++) { var bp = polar(cx, cy, rr * 0.56, k * TAU / 10); bolts += circleD(bp[0], bp[1], Math.max(0.4, rr * 0.022)); }
      out.push(pathEl(bolts, { fill: '#d9dce0', stroke: '#333', 'stroke-width': 0.3 }));
    }
    return out.join('');
  }

  function caliperMarkup(sp, o, cx, cy, rr, pistons, front) {
    var P = o.P, c = sp.c;
    var span = { 1: 0.5, 2: 0.6, 4: 0.78, 6: 0.94, 8: 1.06, 10: 1.18 }[pistons] || 0.75;
    var ac = front ? -0.42 : PI + 0.42;
    var r0 = rr * 0.6, r1 = rr * 1.08;
    var dP = sectorD(cx, cy, r0, r1, ac - span / 2, ac + span / 2);
    var out = pathEl(dP, { fill: url(P, 'cal'), stroke: shade(c.caliper, -0.55), 'stroke-width': 0.8, 'stroke-linejoin': 'round' });
    out += pathEl(sectorD(cx, cy, r1 - (r1 - r0) * 0.22, r1 - (r1 - r0) * 0.12, ac - span / 2 + 0.06, ac + span / 2 - 0.06), { fill: '#ffffff', opacity: 0.18 });
    if ((r1 - r0) > 6 && o.detail !== 'low') {
      var tp = polar(cx, cy, (r0 + r1) / 2, ac), rot = ac * 180 / PI + 90;
      out += '<text x="' + f(tp[0]) + '" y="' + f(tp[1]) + '" transform="rotate(' + f(rot) + ' ' + f(tp[0]) + ' ' + f(tp[1]) + ')" text-anchor="middle" dominant-baseline="central" font-family="' + SANS + '" font-weight="800" font-size="' + f2((r1 - r0) * 0.32) + '" letter-spacing="' + f2((r1 - r0) * 0.06) + '" fill="' + ink(c.caliper) + '" fill-opacity="0.85">REDLINE</text>';
    }
    return out;
  }

  /* One complete wheel, side face. (cx, cy) px; tR/rimR mm; s px/mm */
  function wheelFace(sp, o, cx, cy, tR, rimR, rotorMm, pistons, front, idx, s) {
    var d = sp.d, c = sp.c, n = sp.n, P = o.P, hi = o.detail !== 'low';
    var R = tR * s, r = rimR * s, out = [], id = P + 'w' + idx;
    var fin = c.rim;
    if (d.wheelMat === 'magnesium') fin = mix(fin, '#8a8064', 0.12);
    var conc = n.concave, steel = d.wheelMat === 'steel';
    out.push('<defs><radialGradient id="' + id + 'f" gradientUnits="userSpaceOnUse" cx="' + f(cx - r * 0.2) + '" cy="' + f(cy - r * 0.25) + '" r="' + f(r * 1.2) + '">' +
      stops([[0, shade(fin, steel ? 0.05 : 0.18 - conc * 0.35)], [0.4, shade(fin, steel ? 0.02 : 0.1)], [0.72, shade(fin, steel ? 0.06 : 0.3)], [1, shade(fin, -0.25)]]) + '</radialGradient>' +
      '<radialGradient id="' + id + 'b" gradientUnits="userSpaceOnUse" cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(r) + '">' + stops([[0, '#050506'], [0.75, shade(fin, -0.82)], [1, shade(fin, -0.6)]]) + '</radialGradient>' +
      (hi ? (function () {
        // sidewall lettering paths: upper arc left→right over the top, lower arc left→right under the bottom,
        // so both labels read upright (the lower baseline sits on the outer edge, glyphs grow towards the hub)
        var fsw = Math.min((R - r) * 0.3, R * 0.075), ra = (R + r) / 2 - fsw * 0.35, rb = (R + r) / 2 + fsw * 0.35;
        return '<path id="' + id + 'sw" d="M' + P2(cx - ra, cy) + ' A' + f2(ra) + ' ' + f2(ra) + ' 0 0 1 ' + P2(cx + ra, cy) + '"/>' +
          '<path id="' + id + 'swb" d="M' + P2(cx - rb, cy) + ' A' + f2(rb) + ' ' + f2(rb) + ' 0 0 0 ' + P2(cx + rb, cy) + '"/>';
      })() : '') + '</defs>');
    // tyre
    out.push(circleEl(cx, cy, R, { fill: url(P, 'tire') }));
    out.push(circleEl(cx, cy, R - 0.6, { fill: 'none', stroke: '#2e2e34', 'stroke-width': 1.1 }));
    if (hi) out.push(pathEl('M' + P2(polar(cx, cy, R * 0.9, -2.6)[0], polar(cx, cy, R * 0.9, -2.6)[1]) + ' A' + f2(R * 0.9) + ' ' + f2(R * 0.9) + ' 0 0 1 ' + P2(polar(cx, cy, R * 0.9, -1.0)[0], polar(cx, cy, R * 0.9, -1.0)[1]), { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.07, 'stroke-width': Math.max(1, (R - r) * 0.45), 'stroke-linecap': 'round' }));
    out.push(circleEl(cx, cy, r * 1.035, { fill: 'none', stroke: '#050506', 'stroke-width': Math.max(0.8, r * 0.04) }));
    // barrel
    out.push(circleEl(cx, cy, r, { fill: 'url(#' + id + 'b)' }));
    var aero = d.wstyle === 'aero-disc';
    var rr = Math.min(rotorMm / 2 * s, r * 0.9);
    var spinA = spinAttrs(cx, cy, o);
    var tyreSpin = '';
    if (hi && (R - r) > 5.5) {
      var fs = Math.min((R - r) * 0.3, R * 0.075), col = d.compound === 'slick' || d.compound === 'track' ? '#d9bd46' : '#64646c';
      var label = 'REDLINE · ' + String(d.compoundName || d.compound).toUpperCase() + ' · ' + Math.round(front ? n.twF : n.twR) + '/' + Math.round(front ? n.prF : n.prR) + ' ZR' + Math.round(d.dia);
      tyreSpin = '<text font-family="' + SANS + '" font-weight="700" font-size="' + f2(fs) + '" letter-spacing="' + f2(fs * 0.14) + '" fill="' + col + '" fill-opacity="0.8">' +
        '<textPath href="#' + id + 'sw" startOffset="50%" text-anchor="middle">' + esc(label) + '</textPath></text>' +
        '<text font-family="' + SANS + '" font-weight="700" font-size="' + f2(fs) + '" letter-spacing="' + f2(fs * 0.14) + '" fill="' + col + '" fill-opacity="0.8">' +
        '<textPath href="#' + id + 'swb" startOffset="50%" text-anchor="middle">' + esc(label) + '</textPath></text>';
    }
    if (!aero) {
      out.push(g(spinA, rotorMarkup(sp, o, cx, cy, rr, idx) + smilSpin(cx, cy, o)));
      out.push(caliperMarkup(sp, o, cx, cy, rr, pistons, front));
    }
    // face
    var sh = spokeShapes(sp, cx, cy, r);
    var face = [];
    var stroke = { stroke: shade(fin, -0.5), 'stroke-width': 0.6, 'stroke-linejoin': 'round' };
    var ff = 'url(#' + id + 'f)';
    if (sh.holes) face.push(pathEl(sh.holes, assign({ fill: ff, 'fill-rule': 'evenodd' }, stroke)));
    if (sh.fills.length) face.push(pathEl(sh.fills.join(' '), assign({ fill: ff }, stroke)));
    if (sh.lines.length) face.push(pathEl(sh.lines.join(' '), { fill: 'none', stroke: d.wstyle === 'aero-disc' ? shade(fin, -0.4) : ff, 'stroke-width': Math.max(0.8, r * (d.wstyle === 'aero-disc' ? 0.05 : 0.036)), 'stroke-linecap': 'round' }));
    if (d.wheelMat === 'carbon' || d.wheel === 'aero-disc') {
      if (sh.holes) face.push(pathEl(sh.holes, { fill: url(P, 'carbon'), 'fill-rule': 'evenodd', opacity: 0.55 }));
      if (sh.fills.length) face.push(pathEl(sh.fills.join(' '), { fill: url(P, 'carbon'), opacity: 0.55 }));
      if (hi) face.push(circleEl(cx, cy, r * 0.9, { fill: url(P, 'carbonSheen'), opacity: 0.6 }));
    }
    if (hi && (d.wheelMat === 'forged' || d.wheelMat === 'magnesium') && sh.fills.length) face.push(pathEl(sh.fills.join(' '), { fill: 'none', stroke: shade(fin, 0.55), 'stroke-width': 0.5, opacity: 0.55 }));
    if (d.wstyle === 'aero-disc' && hi) {
      face.push(circleEl(cx, cy, r * 0.7, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.1, 'stroke-width': 0.8 }));
      face.push(circleEl(cx, cy, r * 0.45, { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.25, 'stroke-width': 0.8 }));
    }
    // dish: polished stepped lip; beadlock ring
    if (d.wstyle === 'dish') {
      face.push(pathEl(circleD(cx, cy, r * 0.97) + ' ' + circleD(cx, cy, r * 0.62), { fill: url(P, 'chrome'), 'fill-rule': 'evenodd', opacity: 0.9 }));
      face.push(circleEl(cx, cy, r * 0.62, { fill: 'none', stroke: '#111', 'stroke-width': 1 }));
      face.push(circleEl(cx, cy, r * 0.78, { fill: 'none', stroke: '#000', 'stroke-opacity': 0.35, 'stroke-width': 0.6 }));
      if (d.wheel === 'beadlock') {
        face.push(pathEl(circleD(cx, cy, r * 0.98) + ' ' + circleD(cx, cy, r * 0.82), { fill: shade(fin, -0.35), 'fill-rule': 'evenodd' }));
        var bl = '';
        for (var bk = 0; bk < 20; bk++) { var bp = polar(cx, cy, r * 0.9, bk * TAU / 20); bl += circleD(bp[0], bp[1], Math.max(0.5, r * 0.024)); }
        face.push(pathEl(bl, { fill: '#cfd3d8', stroke: '#222', 'stroke-width': 0.3 }));
      }
    }
    // lip
    var polished = d.wstyle === 'mesh' || d.wstyle === 'split' || d.wstyle === 'dish';
    face.push(circleEl(cx, cy, r * 0.965, { fill: 'none', stroke: polished ? url(P, 'chrome') : shade(fin, 0.18), 'stroke-width': r * (polished ? 0.075 : 0.04) }));
    if (d.wstyle === 'mesh' && d.wheel !== 'multi-spoke') face.push(circleEl(cx, cy, r * 0.3, { fill: 'none', stroke: shade(fin, 0.25), 'stroke-width': r * 0.05 }));
    // hub, lugs / centre-lock nut, cap
    face.push(circleEl(cx, cy, r * 0.17, { fill: shade(fin, -0.12), stroke: shade(fin, -0.5), 'stroke-width': 0.5 }));
    if (d.wstyle === 'centerlock') {
      var hex = [];
      for (var hk = 0; hk < 6; hk++) hex.push(polar(cx, cy, r * 0.13, hk * TAU / 6));
      face.push(circleEl(cx, cy, r * 0.16, { fill: 'none', stroke: '#c62828', 'stroke-width': r * 0.035 }));
      face.push(pathEl(polyD(hex, true), { fill: url(P, 'chrome'), stroke: '#333', 'stroke-width': 0.5 }));
      var ears = '';
      for (var ek = 0; ek < 3; ek++) { var ea = ek * TAU / 3 - PI / 2, e1 = polar(cx, cy, r * 0.1, ea - 0.25), e2 = polar(cx, cy, r * 0.21, ea - 0.1), e3 = polar(cx, cy, r * 0.21, ea + 0.1), e4 = polar(cx, cy, r * 0.1, ea + 0.25); ears += polyD([e1, e2, e3, e4], true) + ' '; }
      face.push(pathEl(ears, { fill: '#b9bec5', stroke: '#333', 'stroke-width': 0.4 }));
      face.push(circleEl(cx, cy, r * 0.05, { fill: '#c62828' }));
    } else {
      var lugs = sh.N > 0 && sh.N % 6 === 0 ? 6 : 5, ld = '', lugOff = PI / Math.max(1, sh.N || 5);
      for (var lk = 0; lk < lugs; lk++) { var lp = polar(cx, cy, r * 0.25 * 0.92, -PI / 2 + lugOff + lk * TAU / lugs); ld += circleD(lp[0], lp[1], Math.max(0.6, r * 0.036)); }
      face.push(pathEl(ld, { fill: '#c9cdd3', stroke: '#3a3c40', 'stroke-width': 0.4 }));
      face.push(circleEl(cx, cy, r * 0.105, { fill: d.badge === 'black' ? url(P, 'badgeBlack') : url(P, 'chrome'), stroke: '#2a2b2e', 'stroke-width': 0.4 }));
      if (hi && r > 20) face.push(textEl(cx, cy + r * 0.04, 'F', { 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(r * 0.12), fill: d.badge === 'black' ? '#d8d8d8' : '#1a1a1c' }));
    }
    // valve stem
    var vp = polar(cx, cy, r * 0.9, 0.95);
    face.push(circleEl(vp[0], vp[1], Math.max(0.5, r * 0.025), { fill: '#202124', stroke: '#8a8d92', 'stroke-width': 0.3 }));
    out.push(g(spinA, face.join('') + tyreSpin + smilSpin(cx, cy, o)));
    // motion blur veil (CSS shows it while spinning)
    var blurA = { class: 'cbr-blur', fill: aero ? 'none' : mix(fin, '#0a0a0b', 0.35) };
    if (o.spin) blurA.opacity = 0.35;
    if (!aero && (o.live || o.spin)) out.push(pathEl(circleD(cx, cy, r * 0.93) + ' ' + circleD(cx, cy, r * 0.2), assign(blurA, { 'fill-rule': 'evenodd' })));
    return g({ class: 'cbr-wheel' }, out.join(''));
  }

  /* ======================================================================
     SIDE VIEW — drawing
     ====================================================================== */
  function profLine(G, x0, x1, off, steps) {
    var pts = [], n = steps || 18;
    for (var i = 0; i <= n; i++) { var x = lerp(x0, x1, i / n); pts.push([G.px(x), G.py(G.prof(x) + off)]); }
    return pts;
  }
  function mmPts(G, pts) { return pts.map(function (p) { return [G.px(p[0]), G.py(p[1]), p[2]]; }); }

  function materialFill(P, kind, sp) {
    if (kind === 'carbon') return url(P, 'carbon');
    if (kind === 'black') return url(P, 'gblack');
    if (kind === 'contrast') return url(P, 'roofc');
    return url(P, 'paint');
  }

  function stripesSide(G, sp, o) {
    var d = sp.d, c = sp.c, P = o.P, s = G.s, px = G.px, py = G.py, out = [], L = G.L;
    var st = d.stripe;
    if (st === 'none') return '';
    var topLine = function (x0, x1, w, op) {
      out.push(pathEl(polyD(profLine(G, x0, x1, 0, 40)), { fill: 'none', stroke: c.stripe, 'stroke-width': w * s * 2, 'stroke-linejoin': 'round', opacity: op || 0.95 }));
    };
    if (st === 'racing-dual') { topLine(-20, L + 20, 55); }
    else if (st === 'center') { topLine(-20, L + 20, 75); }
    else if (st === 'le-mans') { topLine(-20, L + 20, 42); }
    else if (st === 'hood') { topLine(G.X(0.015), G.xA - 30, 40, 0.9); }
    else if (st === 'side-skirt') {
      var x0 = G.fa + G.aRF + 30, x1 = G.ra - G.aRR - 30, y0 = G.yb + 58, y1 = G.yb + 150;
      out.push(rectEl(px(x0), py(y1), (x1 - x0) * s, (y1 - y0) * s, { fill: c.stripe }));
      out.push(rectEl(px(x0), py(y1 + 22), (x1 - x0) * s, 9 * s, { fill: c.stripe }));
      if ((y1 - y0) * s > 8) out.push(textEl(px((x0 + x1) / 2), py((y0 + y1) / 2) + (y1 - y0) * s * 0.3, 'REDLINE', { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-style': 'italic', 'font-size': f2((y1 - y0) * s * 0.78), 'letter-spacing': f2((y1 - y0) * s * 0.25), fill: c.paint }));
    } else if (st === 'pinstripe') {
      var pl = [];
      for (var i = 0; i <= 30; i++) { var x = lerp(G.X(0.03), G.X(0.975), i / 30); pl.push([px(x), py(Math.min(G.prof(x) - 95, G.yBelt - 48))]); }
      out.push(pathEl(smoothD(pl, false), { fill: 'none', stroke: c.stripe, 'stroke-width': 1.3 }));
      out.push(pathEl(smoothD(pl.map(function (p) { return [p[0], p[1] + 3.2]; }), false), { fill: 'none', stroke: c.stripe, 'stroke-width': 0.6 }));
    } else if (st === 'gradient') {
      out.push(rectEl(px(-20), py(G.yBelt - 20), (L + 40) * s, (G.yBelt - 20 - G.yb + 40) * s, { fill: url(P, 'fade') }));
      if (o.detail !== 'low') out.push(rectEl(px(L * 0.3), py(G.yBelt - 20), L * 0.28 * s, (G.yBelt - G.yb) * s, { fill: url(P, 'halftone'), opacity: 0.35 }));
    }
    return out.join('');
  }

  function panelLinesSide(G, sp, o) {
    var d = sp.d, n = sp.n, s = G.s, px = G.px, py = G.py, L = G.L, out = [];
    var gap = { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.55, 'stroke-width': 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    var hl = { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.16, 'stroke-width': 0.7, 'stroke-linecap': 'round' };
    function cut(dd) { out.push(pathEl(dd, gap)); out.push(pathEl(dd, assign({}, hl, { transform: 'translate(0.8 0.8)' }))); }
    // bonnet shut line
    if (G.xA - G.X(0.04) > 300) cut(polyD(profLine(G, G.X(0.045), G.xA - 40, -42, 14)));
    // front bumper / wing seam and rear bumper seam
    var fA = polar(G.fa, n.tRF, G.aRF + 14, PI - 0.62), fB = [G.fa - G.aRF * 1.02, G.prof(G.fa - G.aRF * 1.02) - 62];
    cut('M' + P2(px(fA[0]), py(fA[1])) + ' Q' + P2(px(fA[0] - 30), py(fB[1] - 40)) + ' ' + P2(px(fB[0]), py(fB[1])));
    var rA = polar(G.ra, n.tRR, G.aRR + 14, 0.6), rB = [G.ra + G.aRR * 1.05, Math.min(G.prof(G.ra + G.aRR * 1.05) - 70, G.yTail - 40)];
    cut('M' + P2(px(rA[0]), py(rA[1])) + ' Q' + P2(px(rA[0] + 40), py(rB[1] - 40)) + ' ' + P2(px(rB[0]), py(rB[1])));
    // doors
    var yTop = d.openTop ? G.yBelt + 10 : G.yBelt + 20, yBot = G.yb + 46;
    G.doors.forEach(function (dr, i) {
      var lean = d.style === 'hypercar' ? 60 : 14;
      var dd = 'M' + P2(px(dr.x0 + lean), py(yTop)) + ' L' + P2(px(dr.x0), py(yBot)) + ' L' + P2(px(dr.x1 - 6), py(yBot));
      if (dr.rear && dr.x1 > G.ra - G.aRR - 40) {
        var rr = G.aRR + 36, dxh = clamp(dr.x1 - G.ra, -rr * 0.98, rr * 0.98);
        var yHit = n.tRR + Math.sqrt(rr * rr - dxh * dxh);
        var xs = G.ra - Math.sqrt(Math.max(0, rr * rr - Math.pow(yBot - n.tRR, 2)));
        dd = 'M' + P2(px(dr.x0 + lean), py(yTop)) + ' L' + P2(px(dr.x0), py(yBot)) + ' L' + P2(px(xs), py(yBot)) +
          ' A' + f2(rr * s) + ' ' + f2(rr * s) + ' 0 0 1 ' + P2(px(dr.x1), py(yHit)) + ' L' + P2(px(dr.x1), py(yTop));
      } else {
        dd += ' L' + P2(px(dr.x1), py(yTop));
      }
      cut(dd);
      if (dr.slide) out.push(lineEl(px(dr.x0 + 80), py(G.yBelt - 30), px(G.ra - G.aRR * 0.2), py(G.yBelt - 30), { stroke: '#000', 'stroke-opacity': 0.45, 'stroke-width': 1.4 }));
    });
    // boot / hatch / tailgate shut lines
    if (['fastback', 'notchback', 'longtail', 'open'].indexOf(d.tailStyle) >= 0) {
      if (G.L - G.xCE > 350) cut(polyD(profLine(G, G.xCE + 70, G.X(0.985), -36, 10)));
    } else if (d.tailStyle === 'bed') {
      cut('M' + P2(px(L - 70), py(G.yDeck - 30)) + ' L' + P2(px(L - 70), py(G.Y(n.tail * 0.55))));
      cut('M' + P2(px(G.xCE + 30), py(G.yDeck - 4)) + ' L' + P2(px(L - 40), py(G.yDeck - 4)));
    } else {
      cut('M' + P2(px(L - 85), py(G.prof(L - 85) - 25)) + ' L' + P2(px(L - 70), py(G.Y(n.tail * 0.82))));
    }
    // character line & sill crease
    var cy0 = lerp(G.yb, G.yBelt, 0.64);
    var cl = 'M' + P2(px(G.fa + G.aRF * 0.5), py(cy0 - 10)) + ' C' + P2(px(lerp(G.fa, G.ra, 0.35)), py(cy0 + 10)) + ' ' + P2(px(lerp(G.fa, G.ra, 0.7)), py(cy0 + 22)) + ' ' + P2(px(G.ra - G.aRR * 0.3), py(cy0 + 36));
    out.push(pathEl(cl, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.12 + d.gloss * 0.18, 'stroke-width': 1.2 }));
    out.push(pathEl(cl, { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.22, 'stroke-width': 1.6, transform: 'translate(0 2.2)' }));
    out.push(lineEl(px(G.fa + G.aRF + 20), py(G.yb + 150), px(G.ra - G.aRR - 20), py(G.yb + 150), { stroke: '#000', 'stroke-opacity': 0.2, 'stroke-width': 1 }));
    // side intake for mid-engined shapes
    if (d.X.intake || d.position === 'mid') {
      var ix1 = G.ra - G.aRR - 50, ix0 = ix1 - (d.X.intake ? 620 : 420), iyT = G.yBelt - 40, iyB = G.yb + (d.X.intake ? 190 : 260);
      var dI = 'M' + P2(px(ix0), py(iyT)) + ' C' + P2(px(ix0 + 260), py(iyT + 10)) + ' ' + P2(px(ix1), py(iyT - 30)) + ' ' + P2(px(ix1), py(iyB + 120)) +
        ' L' + P2(px(ix1 - 30), py(iyB)) + ' C' + P2(px(ix1 - 200), py(iyB + 40)) + ' ' + P2(px(ix0 + 200), py(lerp(iyB, iyT, 0.6))) + ' ' + P2(px(ix0), py(iyT)) + ' Z';
      out.push(pathEl(dI, { fill: '#060607', stroke: '#000', 'stroke-width': 0.8 }));
      for (var k = 1; k < 4; k++) out.push(lineEl(px(lerp(ix0 + 120, ix1 - 20, k / 4)), py(iyT - 20), px(lerp(ix0 + 160, ix1 - 40, k / 4)), py(iyB + 40), { stroke: '#2a2b30', 'stroke-width': 1.2 }));
      out.push(pathEl(dI, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.2, 'stroke-width': 0.8, transform: 'translate(0 -1)' }));
    }
    // front wing vents for hot cars
    if (d.X.hoodVents && (n.hp > 480 || d.style === 'hypercar')) {
      var vx = G.fa + G.aRF * 0.95, vy = lerp(G.yb, G.yBelt, 0.62);
      for (var v = 0; v < 3; v++) out.push(lineEl(px(vx + v * 45), py(vy + 70), px(vx + v * 45 + 70), py(vy - 60), { stroke: '#050506', 'stroke-width': 1.8, 'stroke-linecap': 'round', opacity: 0.85 }));
    }
    // cladding (SUV / pickup)
    if (d.X.cladding) {
      out.push(rectEl(px(G.fa + G.aRF - 40), py(G.yb + 90), (G.ra - G.aRR - G.fa - G.aRF + 80) * s, 110 * s, { fill: '#121315', opacity: 0.88 }));
    }
    return out.join('');
  }

  function greenhouseSide(G, sp, o) {
    var d = sp.d, n = sp.n, c = sp.c, P = o.P, s = G.s, px = G.px, py = G.py, out = [], hi = o.detail !== 'low';
    var dlo = G.dlo;
    if (!dlo) return roadsterCockpit(G, sp, o);
    var dd = smoothD(mmPts(G, dlo.pts), true, 0.12);
    var glassOp = clamp(0.55 + n.tint * 0.45, 0, 1);
    var inner = [];
    // interior silhouettes through the glass (fade out with tint)
    var seatX = [lerp(dlo.xFront, dlo.xRear, d.seats <= 2 || !d.rearSeats ? 0.55 : 0.42)];
    if (d.seats > 2 && d.rearSeats) seatX.push(lerp(dlo.xFront, dlo.xRear, 0.78));
    if (d.seats > 5 && d.rearSeats) seatX.push(lerp(dlo.xFront, dlo.xRear, 0.93));
    var hrTop = Math.min(G.yRoof - 170, G.yBelt + 420);
    seatX.forEach(function (x) {
      inner.push(pathEl(roundRectD(px(x - 95), py(hrTop), 190 * s, 210 * s, 40 * s), { fill: shade(c.intP, 0.12) }));
      inner.push(pathEl(roundRectD(px(x - 40), py(hrTop - 190), 300 * s, (hrTop - 190 - G.yBelt + 60) * s, 30 * s), { fill: shade(c.intP, -0.05) }));
      inner.push(lineEl(px(x - 80), py(hrTop - 30), px(x + 80), py(hrTop - 30), { stroke: c.stitch, 'stroke-width': 0.6, opacity: 0.8 }));
    });
    inner.push(ellipseEl(px(dlo.xFront + 330), py(G.yBelt + 150), 30 * s, 190 * s, { fill: 'none', stroke: '#0a0a0a', 'stroke-width': 26 * s, transform: 'rotate(-18 ' + f(px(dlo.xFront + 330)) + ' ' + f(py(G.yBelt + 150)) + ')' }));
    if (d.ambientOn) inner.push(lineEl(px(dlo.xFront + 80), py(G.yBelt + 40), px(dlo.xRear - 60), py(G.yBelt + 40), { stroke: c.ambient, 'stroke-width': 1.4, opacity: 0.6 * (1 - n.tint) }));
    if (d.rollCage !== 'none') {
      var cage = 'M' + P2(px(dlo.xFront + 120), py(G.yBelt + 20)) + ' L' + P2(px(G.xRS + 120), py(G.yRoof - 110)) + ' L' + P2(px(G.xRE - 120), py(G.prof(G.xRE - 120) - 110)) + ' L' + P2(px(dlo.xRear - 80), py(G.yBelt + 20));
      if (d.rollCage === 'half') cage = 'M' + P2(px(seatX[0] + 220), py(G.yBelt + 10)) + ' L' + P2(px(seatX[0] + 180), py(G.yRoof - 110)) + ' M' + P2(px(seatX[0] + 200), py(G.yRoof - 140)) + ' L' + P2(px(dlo.xRear), py(G.yBelt + 60));
      inner.push(pathEl(cage, { fill: 'none', stroke: '#c7342b', 'stroke-width': 32 * s, 'stroke-linejoin': 'round', opacity: 0.9 }));
    }
    var glassFill = rectEl(px(dlo.xFront - 100), py(G.yRoof + 100), (dlo.xRear - dlo.xFront + 300) * s, (G.yRoof - G.yBelt + 200) * s, { fill: url(P, 'glass'), opacity: f2(glassOp) });
    var refl = rectEl(px(dlo.xFront - 100), py(G.yRoof + 100), (dlo.xRear - dlo.xFront + 300) * s, (G.yRoof - G.yBelt + 200) * s, { fill: url(P, 'glassRef') });
    // pillars
    var pil = [];
    var pillars = pillarsSide(G, dlo);
    pillars.forEach(function (x, i) {
      var last = i === pillars.length - 1 && pillars.length > 1;
      var wP = last ? (d.pillar === 'thick' ? 210 : 90) : (d.pillar === 'thick' ? 95 : 70);
      var fill = d.pillar === 'floating' || !last ? url(P, 'gblack') : url(P, 'paint');
      if (last && d.pillar === 'thin') fill = url(P, 'gblack');
      var lean = last ? 50 : 18;
      pil.push(pathEl(polyD([[px(x - wP / 2 + lean), py(G.yRoof + 50)], [px(x + wP / 2 + lean), py(G.yRoof + 50)], [px(x + wP / 2), py(G.yBelt - 20)], [px(x - wP / 2), py(G.yBelt - 20)]], true), { fill: fill }));
    });
    out.push('<clipPath id="' + P + 'dlo"><path d="' + dd + '"/></clipPath>');
    out.push(g({ 'clip-path': url(P, 'dlo') }, rectEl(px(dlo.xFront - 100), py(G.yRoof + 100), (dlo.xRear - dlo.xFront + 300) * s, (G.yRoof - G.yBelt + 200) * s, { fill: '#0d1116' }) + inner.join('') + glassFill + refl + pil.join('')));
    var seal = d.badge === 'chrome' && ['sedan', 'wagon', 'suv', 'van', 'shooting-brake'].indexOf(d.style) >= 0 ? url(P, 'chrome') : '#050506';
    out.push(pathEl(dd, { fill: 'none', stroke: seal, 'stroke-width': seal === '#050506' ? 2 : 2.4, 'stroke-linejoin': 'round' }));
    // roof treatment
    if (d.roof !== 'body') {
      var rx0 = G.xRS - 40, rx1 = ['hatch', 'wagon', 'box', 'kammback', 'bed'].indexOf(d.tailStyle) >= 0 ? G.xCE - 10 : Math.min(dlo.xRear + 200, G.xCE);
      var topP = profLine(G, rx0, rx1, 120, 16), botP = [];
      for (var i = 16; i >= 0; i--) { var x = lerp(rx0, rx1, i / 16); botP.push([px(x), py(Math.max(G.yBelt + 40, Math.min(G.prof(x) - dlo.inset + 14, G.prof(x) - 26)))]); }
      var roofD = polyD(topP.concat(botP), true);
      var rf = d.roof === 'glass' ? url(P, 'glass') : materialFill(P, d.roof, sp);
      var roofG = pathEl(roofD, { fill: rf });
      if (d.roof === 'carbon' && hi) roofG += pathEl(roofD, { fill: url(P, 'carbonSheen') });
      if (d.roof === 'glass') roofG += pathEl(roofD, { fill: url(P, 'glassRef') });
      out.push(g({ 'clip-path': url(P, 'body') }, roofG));
    }
    // roof rails, shark fin
    if (d.X.roofRails) {
      var r0 = G.xRS + 160, r1 = G.xRE - 80, rl = profLine(G, r0, r1, 52, 10);
      out.push(pathEl(polyD(rl), { fill: 'none', stroke: d.badge === 'chrome' ? url(P, 'chromeH') : '#0c0c0e', 'stroke-width': 22 * s, 'stroke-linecap': 'round' }));
      [r0 + 40, lerp(r0, r1, 0.5), r1 - 40].forEach(function (x) { out.push(lineEl(px(x), py(G.prof(x) + 52), px(x), py(G.prof(x) - 2), { stroke: '#0c0c0e', 'stroke-width': 30 * s })); });
    }
    var fx = G.xRE - 260;
    if (fx > G.xRS + 200) {
      var fy = G.prof(fx);
      out.push(pathEl('M' + P2(px(fx - 80), py(fy - 4)) + ' Q' + P2(px(fx + 20), py(fy + 46)) + ' ' + P2(px(fx + 80), py(fy + 42)) + ' L' + P2(px(fx + 95), py(fy - 4)) + ' Z', { fill: url(P, 'gblack') }));
    }
    // wipers / A-pillar
    out.push(lineEl(px(G.xA - 30), py(G.yCowl + 6), px(G.xA + 200), py(G.yCowl + 60), { stroke: '#0a0a0b', 'stroke-width': 1.4, opacity: 0.7 }));
    return out.join('');
  }

  function roadsterCockpit(G, sp, o) {
    var d = sp.d, n = sp.n, c = sp.c, P = o.P, s = G.s, px = G.px, py = G.py, out = [];
    var topY = G.Y(n.roofH * 0.95), x0 = G.xA + 20, x1 = G.xRS;
    // seats / headrest & steering visible above the waist
    var hx = lerp(G.xRS, G.xRE, 0.7);
    out.push(pathEl(roundRectD(px(hx - 90), py(G.yBelt + 330), 190 * s, 260 * s, 50 * s), { fill: shade(c.intP, 0.1) }));
    out.push(ellipseEl(px(G.xRS + 120), py(G.yBelt + 110), 22 * s, 120 * s, { fill: 'none', stroke: '#0a0a0b', 'stroke-width': 26 * s, transform: 'rotate(-20 ' + f(px(G.xRS + 120)) + ' ' + f(py(G.yBelt + 110)) + ')' }));
    // fairings / roll hoops behind the seats, in the roof colour choice
    var rx = G.xRE, fTop = lerp(G.yBelt, topY, 0.62);
    var fair = 'M' + P2(px(rx - 260), py(G.yBelt + 20)) + ' C' + P2(px(rx - 200), py(fTop + 10)) + ' ' + P2(px(rx - 40), py(fTop + 30)) + ' ' + P2(px(rx + 60), py(fTop)) +
      ' C' + P2(px(rx + 260), py(fTop - 40)) + ' ' + P2(px(G.xCE + 200), py(G.yDeck + 40)) + ' ' + P2(px(G.xCE + 520), py(G.prof(G.xCE + 520) - 4)) + ' L' + P2(px(rx - 260), py(G.yBelt + 10)) + ' Z';
    var rfK = d.roof === 'body' || d.roof === 'glass' ? 'paint' : d.roof;
    out.push(pathEl(fair, { fill: materialFill(P, rfK, sp), stroke: shade(c.paint, -0.6), 'stroke-width': 0.8 }));
    out.push(pathEl(fair, { fill: url(P, 'topLight') }));
    if (d.rollCage !== 'none' || d.style === 'roadster') {
      out.push(pathEl('M' + P2(px(rx - 150), py(G.yBelt + 30)) + ' Q' + P2(px(rx - 120), py(fTop + 150)) + ' ' + P2(px(rx + 10), py(fTop + 150)) + ' L' + P2(px(rx + 30), py(G.yBelt + 30)), { fill: 'none', stroke: d.rollCage !== 'none' ? '#c7342b' : url(P, 'chromeH'), 'stroke-width': 30 * s, 'stroke-linecap': 'round' }));
    }
    // windscreen: frame + glass seen edge-on
    out.push(pathEl(polyD([[px(x0 - 20), py(G.yCowl - 5)], [px(x1 - 40), py(topY)], [px(x1 + 40), py(topY - 10)], [px(x0 + 110), py(G.yCowl - 5)]], true), { fill: url(P, 'glass'), opacity: f2(0.45 + n.tint * 0.3) }));
    out.push(lineEl(px(x0 - 20), py(G.yCowl - 5), px(x1 - 40), py(topY), { stroke: d.badge === 'chrome' ? url(P, 'chromeH') : '#0b0b0c', 'stroke-width': 34 * s, 'stroke-linecap': 'round' }));
    out.push(lineEl(px(x1 - 40), py(topY), px(x1 + 50), py(topY - 12), { stroke: '#0b0b0c', 'stroke-width': 30 * s, 'stroke-linecap': 'round' }));
    return out.join('');
  }

  function lightsSide(G, sp, o) {
    var d = sp.d, n = sp.n, P = o.P, s = G.s, px = G.px, py = G.py, out = [], hi = o.detail !== 'low', L = G.L;
    var face = d.noseStyle === 'blunt' || d.noseStyle === 'tall';
    var hx0 = G.X(0.006), hx1 = G.X(face ? 0.04 : d.noseStyle === 'wedge' ? 0.1 : 0.085);
    var h0 = face ? 170 : d.noseStyle === 'wedge' ? 55 : 105, h1 = face ? 120 : 34;
    var top = [], bot = [];
    for (var i = 0; i <= 8; i++) {
      var x = lerp(hx0, hx1, i / 8), yT = G.prof(x) - (face ? 70 : 26), hh = lerp(h0, h1, i / 8);
      top.push([px(x), py(yT)]); bot.unshift([px(x), py(yT - hh)]);
    }
    var lamp = smoothD(top.concat(bot).map(function (p) { return [p[0], p[1], 0]; }), true, 0.08);
    var on = d.lights !== 'halogen';
    out.push(pathEl(lamp, { fill: '#0d1015', stroke: '#050506', 'stroke-width': 0.8 }));
    out.push(pathEl(lamp, { fill: url(P, 'lens'), opacity: 0.85 }));
    var mid = top[3], midB = bot[bot.length - 4];
    var cxL = (mid[0] + midB[0]) / 2, cyL = (mid[1] + midB[1]) / 2, lh = Math.abs(midB[1] - mid[1]);
    if (d.lights === 'halogen') {
      out.push(circleEl(cxL, cyL, lh * 0.36, { fill: '#fff6d6', stroke: '#b8a46a', 'stroke-width': 0.6, filter: hi ? url(P, 'glow') : null }));
      out.push(pathEl(polyD([top[6], top[8], bot[0], bot[2]], true), { fill: '#ff9a1f', opacity: 0.85 }));
    } else {
      var drl = polyD(bot.slice(0, 7).reverse().map(function (p) { return [p[0], p[1] - 2.2]; }));
      if (d.lights === 'matrix') {
        var cells = '';
        for (var k = 0; k < 7; k++) { var t = 0.15 + k * 0.1, cxk = lerp(top[0][0], top[8][0], t), cyk = lerp(top[1][1], bot[7][1], 0.4) + (k - 3) * 0.2; cells += roundRectD(cxk - 1.3, cyk - 1.3, 2.6, 2.6, 0.5) + ' '; }
        out.push(pathEl(cells, { fill: '#ffffff', filter: hi ? url(P, 'glow') : null }));
      } else {
        out.push(circleEl(cxL - 3, cyL, Math.max(1.2, lh * 0.22), { fill: '#ffffff', filter: hi ? url(P, 'glow') : null }));
        out.push(circleEl(cxL + lh * 0.55, cyL, Math.max(1, lh * 0.18), { fill: '#eef4ff' }));
      }
      out.push(pathEl(drl, { fill: 'none', stroke: '#ffffff', 'stroke-width': 1.8, 'stroke-linecap': 'round', filter: hi ? url(P, 'glow') : null }));
      if (d.lights === 'laser') out.push(pathEl(polyD(top.slice(1, 7).map(function (p) { return [p[0], p[1] + 2.4]; })), { fill: 'none', stroke: '#3a8bff', 'stroke-width': 1.3, filter: hi ? url(P, 'glow') : null }));
    }
    out.push(pathEl(lamp, { fill: url(P, 'glassRef'), opacity: 0.8 }));
    // side marker (front, amber)
    out.push(pathEl(roundRectD(px(G.X(0.03)), py(G.Y(n.nose * 0.62)), 70 * s, 26 * s, 6 * s), { fill: '#ff9a1f', opacity: 0.8 }));
    // tail lamp
    var vertical = ['hatch', 'wagon', 'box', 'kammback', 'bed'].indexOf(d.tailStyle) >= 0;
    var tx0 = vertical ? L - 150 : G.X(0.935), tx1 = L - 6;
    var th = vertical ? (d.tailStyle === 'bed' ? 300 : 260) : 85;
    var tT = [], tB = [];
    for (var j = 0; j <= 6; j++) {
      var xx = lerp(tx0, tx1, j / 6), yy = vertical ? Math.min(G.prof(xx) - 40, (d.tailStyle === 'bed' ? G.yDeck - 30 : G.yDeck + 120)) : G.prof(xx) - 22;
      tT.push([px(xx), py(yy)]); tB.unshift([px(xx), py(yy - th * (vertical ? 1 : lerp(0.7, 1, j / 6)))]);
    }
    var tl = smoothD(tT.concat(tB).map(function (p) { return [p[0], p[1], 0]; }), true, 0.06);
    out.push(pathEl(tl, { fill: url(P, 'tailL'), stroke: '#2a0004', 'stroke-width': 0.7 }));
    if (d.lights !== 'halogen') out.push(pathEl(polyD(tT.slice(1, 6).map(function (p) { return [p[0], p[1] + 2]; })), { fill: 'none', stroke: '#ff5a4a', 'stroke-width': 1.6, filter: hi ? url(P, 'glow') : null }));
    else out.push(pathEl(polyD([tT[4], tT[6], tB[0], tB[2]], true), { fill: '#ff8f1f', opacity: 0.7 }));
    out.push(pathEl(tl, { fill: url(P, 'glassRef'), opacity: 0.6 }));
    out.push(pathEl(roundRectD(px(L - 260), py(G.Y(n.tail * 0.5)), 70 * s, 22 * s, 5 * s), { fill: '#d0101a', opacity: 0.7 }));
    return out.join('');
  }

  function detailsSide(G, sp, o) {
    var d = sp.d, n = sp.n, c = sp.c, P = o.P, s = G.s, px = G.px, py = G.py, out = [], hi = o.detail !== 'low';
    // mirror
    var mx = G.xA + (d.openTop ? 90 : 140), my = G.yBelt + 55;
    var mirFill = d.mirrors === 'carbon' ? url(P, 'carbon') : d.mirrors === 'black' ? url(P, 'gblack') : url(P, 'paint');
    out.push(lineEl(px(mx + 30), py(G.yBelt - 6), px(mx + 60), py(my - 30), { stroke: '#0b0b0c', 'stroke-width': 26 * s, 'stroke-linecap': 'round' }));
    var mirD = 'M' + P2(px(mx - 90), py(my + 10)) + ' C' + P2(px(mx - 90), py(my + 75)) + ' ' + P2(px(mx + 40), py(my + 80)) + ' ' + P2(px(mx + 120), py(my + 50)) +
      ' C' + P2(px(mx + 150), py(my + 20)) + ' ' + P2(px(mx + 140), py(my - 40)) + ' ' + P2(px(mx + 80), py(my - 50)) + ' C' + P2(px(mx), py(my - 55)) + ' ' + P2(px(mx - 90), py(my - 40)) + ' ' + P2(px(mx - 90), py(my + 10)) + ' Z';
    out.push(pathEl(mirD, { fill: mirFill, stroke: '#050506', 'stroke-width': 0.8 }));
    out.push(pathEl(mirD, { fill: url(P, 'topLight') }));
    out.push(lineEl(px(mx - 70), py(my - 30), px(mx + 30), py(my - 42), { stroke: '#ff9a1f', 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: 0.85 }));
    // door handles
    var flush = d.style === 'hypercar' || d.style === 'coupe' || d.style === 'roadster';
    G.doors.forEach(function (dr) {
      var hx = dr.slide ? dr.x0 + 120 : dr.x1 - 240, hy = G.yBelt - (d.openTop ? 60 : 95);
      if (flush) out.push(pathEl(roundRectD(px(hx), py(hy + 9), 150 * s, 18 * s, 9 * s), { fill: '#060607', opacity: 0.8 }));
      else {
        out.push(pathEl(roundRectD(px(hx - 10), py(hy + 24), 170 * s, 48 * s, 18 * s), { fill: '#000', opacity: 0.35 }));
        out.push(pathEl(roundRectD(px(hx), py(hy + 16), 150 * s, 30 * s, 14 * s), { fill: d.badge === 'chrome' && d.style !== 'pickup' ? url(P, 'chromeH') : url(P, 'paint'), stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 0.6 }));
      }
    });
    // fuel door / charge port
    var lastDoor = G.doors[G.doors.length - 1];
    if (d.engType !== 'ev') {
      var fx = Math.max(G.ra - G.aRR * 0.1, lastDoor.x1 + 120), fy = G.yBelt - 140;
      if (d.tailStyle === 'bed') { fx = Math.max(G.xCE + 220, G.ra - G.aRR - 160); fy = G.yDeck - 150; }
      out.push(circleEl(px(fx), py(fy), 54 * s, { fill: 'none', stroke: '#000', 'stroke-opacity': 0.55, 'stroke-width': 1 }));
      out.push(circleEl(px(fx) + 0.7, py(fy) + 0.7, 54 * s, { fill: 'none', stroke: '#fff', 'stroke-opacity': 0.15, 'stroke-width': 0.6 }));
    }
    if (d.engType !== 'ice') {
      var cxp = G.fa + G.aRF * 0.1, cyp = G.yBelt - 130;
      if (d.engType === 'ev' && d.style === 'hypercar') cxp = G.ra + G.aRR * 0.2;
      out.push(pathEl(roundRectD(px(cxp - 60), py(cyp + 45), 120 * s, 90 * s, 18 * s), { fill: 'none', stroke: '#000', 'stroke-opacity': 0.55, 'stroke-width': 1 }));
      if (hi) out.push(pathEl('M' + P2(px(cxp + 8), py(cyp + 32)) + ' L' + P2(px(cxp - 20), py(cyp - 4)) + ' L' + P2(px(cxp + 4), py(cyp - 4)) + ' L' + P2(px(cxp - 8), py(cyp - 34)) + ' L' + P2(px(cxp + 22), py(cyp + 6)) + ' L' + P2(px(cxp - 2), py(cyp + 6)) + ' Z', { fill: '#3ee6a8', opacity: 0.85 }));
    }
    // fender badge
    if (d.badge !== 'delete') {
      var bx = (G.fa + G.aRF * 0.55 + G.doors[0].x0) / 2, by = lerp(G.yb, G.yBelt, 0.7);
      if (d.style === 'van') bx = G.fa + G.aRF + 60;
      var fsz = 52 * s;
      out.push(textEl(px(bx), py(by), d.engineLabel || 'REDLINE', { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 800, 'font-style': 'italic', 'font-size': f2(fsz), 'letter-spacing': f2(fsz * 0.08), fill: d.badge === 'black' ? '#0c0c0e' : url(P, 'chrome'), stroke: d.badge === 'black' ? 'none' : '#3a3d42', 'stroke-width': 0.25 }));
    }
    // race roundel
    if (d.number || d.stripe === 'le-mans') {
      var dr0 = G.doors[0], rx = (dr0.x0 + dr0.x1) / 2 + (d.style === 'hypercar' ? -40 : 0), ry = lerp(G.yb, G.yBelt, 0.47), rr = Math.min(210, (G.yBelt - G.yb) * 0.34);
      out.push(circleEl(px(rx), py(ry), rr * s, { fill: '#f6f3ea', stroke: '#111', 'stroke-width': Math.max(1, rr * s * 0.07) }));
      if (d.number) out.push(textEl(px(rx), py(ry) + rr * s * 0.36, d.number, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(rr * s * (d.number.length > 2 ? 0.82 : 1.05)), 'letter-spacing': f2(-rr * s * 0.04), fill: '#111' }));
    }
    return out.join('');
  }

  /* aero parts hugging a real (CB.shapes) body: they follow its lower edge (G.yLow) instead of the procedural floor */
  function aeroSideShape(G, sp, o) {
    var d = sp.d, P = o.P, s = G.s, px = G.px, py = G.py, out = [], L = G.L, fm = G.fm;
    var carbonish = d.splitter === 'carbon' || d.splitter === 'race' || d.wheelMat === 'carbon' || d.style === 'hypercar';
    var yL = function (mm) { return Math.max(0, G.yLow(clamp(mm, 0, L))); };
    var edge = function (a, b, off, steps) { var pts = []; for (var i = 0; i <= steps; i++) { var x = lerp(a, b, i / steps); pts.push([px(x), py(Math.max(12, yL(x) + off))]); } return pts; };
    if (d.splitter !== 'none') {
      var mLow = 60, yMin = Infinity;
      for (var q = 60; q <= 400; q += 10) { var yy = yL(q); if (yy < yMin) { yMin = yy; mLow = q; } }
      var ext = d.splitter === 'race' ? 110 : d.splitter === 'carbon' ? 45 : 14, th = d.splitter === 'race' ? 24 : d.splitter === 'lip' ? 14 : 18;
      var sx0 = Math.max(-ext, mLow - 40 - ext), sx1 = Math.max(sx0 + 200, Math.min(G.aFx - G.aRF - 30, mLow + 520));
      var top = [[px(sx0), py(yMin + 6)]].concat(edge(mLow, sx1, 6, 8));
      var bot = edge(mLow, sx1, 6 - th, 8).reverse().concat([[px(sx0 + 8), py(yMin + 6 - th)]]);
      out.push(pathEl(polyD(top.concat(bot), true), { fill: d.splitter === 'lip' ? url(P, 'gblack') : url(P, 'carbon'), stroke: '#050506', 'stroke-width': 0.7 }));
      if (d.splitter !== 'lip') out.push(lineEl(px(sx0 + 4), py(yMin + 3), px(sx1 - 20), py(yL(sx1 - 20) + 3), { stroke: '#ffffff', 'stroke-opacity': 0.25, 'stroke-width': 0.7 }));
      if (d.splitter === 'race') {
        out.push(lineEl(px(sx0 + 40), py(yMin + 6), px(mLow + 30), py(yMin + 160), { stroke: '#a7adb5', 'stroke-width': 1.3 }));
        out.push(pathEl(polyD([[px(sx0), py(yMin + 6 - th)], [px(sx0 + 6), py(yMin + 66)], [px(sx0 + 70), py(yMin + 66)], [px(sx0 + 80), py(yMin + 6 - th)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.5, opacity: 0.95 }));
      }
    }
    if (d.canards) {
      var yN = G.yNose, yB = yL(80);
      [[0.62, 0.15], [0.4, 0.1]].forEach(function (cfg) {
        var cy0 = lerp(yB, yN, cfg[0]);
        out.push(pathEl(polyD([[px(10), py(cy0 - 10)], [px(G.X(0.02) + 60), py(cy0 + 34)], [px(G.X(0.02) + 70), py(cy0 + 14)], [px(20), py(cy0 - 26)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
      });
    }
    if (d.skirts) {
      var k0 = G.aFx + G.aRF + 10, k1 = G.aRx - G.aRR - 10;
      if (k1 > k0 + 100) {
        var st = edge(k0, k1, 22, 10), sb = edge(k0, k1, -34, 10).reverse();
        out.push(pathEl(polyD(st.concat(sb), true), { fill: carbonish ? url(P, 'carbon') : url(P, 'trim'), stroke: '#000', 'stroke-width': 0.6 }));
        out.push(pathEl(polyD(edge(k0 + 10, k1 - 10, 18, 10), false), { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.18, 'stroke-width': 0.8 }));
      }
    }
    if (d.diffuser !== 'none' && fm.style !== 'pickup') {
      var big = d.diffuser === 'race' ? 1.6 : d.diffuser === 'carbon' ? 1.2 : 0.8;
      var dx0 = Math.min(L - 160, G.aRx + G.aRR * 0.95), dxe = L - 10, dpts = [], dbot = [], N = 8;
      for (var i = 0; i <= N; i++) {
        var t = i / N, x = lerp(dx0, dxe, t), y0 = yL(x);
        dpts.push([px(x), py(y0 + 8)]);
        dbot.push([px(x + (d.diffuser === 'race' ? t * 30 : 0)), py(Math.max(15, y0 - (8 + 40 * big * t)))]);
      }
      out.push(pathEl(polyD(dpts.concat(dbot.reverse()), true), { fill: d.diffuser === 'mild' ? url(P, 'trim') : url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
      if (d.diffuser !== 'mild') out.push(lineEl(px(dx0 + 30), py(yL(dx0 + 30) - 4), px(dxe - 6), py(Math.max(18, yL(dxe - 6) - 40 * big + 4)), { stroke: '#ffffff', 'stroke-opacity': 0.2, 'stroke-width': 0.7 }));
    }
    return out.join('');
  }
  function aeroSide(G, sp, o) {
    if (G.fm && G.yLow) return aeroSideShape(G, sp, o);
    var d = sp.d, n = sp.n, P = o.P, s = G.s, px = G.px, py = G.py, out = [], L = G.L;
    var carbonish = d.splitter === 'carbon' || d.splitter === 'race' || d.wheelMat === 'carbon' || d.style === 'hypercar';
    // splitter
    if (d.splitter !== 'none') {
      var ext = d.splitter === 'race' ? 115 : d.splitter === 'carbon' ? 48 : 12, th = d.splitter === 'race' ? 24 : 18;
      var y0 = G.yb + (d.splitter === 'lip' ? 52 : 34);
      var sd = polyD([[px(-ext), py(y0)], [px(G.X(0.16)), py(y0 + 10)], [px(G.X(0.16)), py(y0 + 10 - th)], [px(-ext + 8), py(y0 - th)]], true);
      out.push(pathEl(sd, { fill: d.splitter === 'lip' ? url(P, 'paint') : url(P, 'carbon'), stroke: '#050506', 'stroke-width': 0.7 }));
      if (d.splitter !== 'lip') out.push(lineEl(px(-ext + 4), py(y0 - 2), px(G.X(0.1)), py(y0 + 4), { stroke: '#ffffff', 'stroke-opacity': 0.25, 'stroke-width': 0.7 }));
      if (d.splitter === 'race') {
        out.push(lineEl(px(-ext + 40), py(y0), px(G.X(0.008)), py(G.Y(n.nose * 0.52)), { stroke: '#a7adb5', 'stroke-width': 1.3 }));
        out.push(pathEl(polyD([[px(-ext), py(y0 - th)], [px(-ext + 6), py(y0 + 60)], [px(-ext + 70), py(y0 + 60)], [px(-ext + 80), py(y0 - th)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.5, opacity: 0.95 }));
      }
    }
    // canards / dive planes
    if (d.canards) {
      [[0.62, 0.15], [0.42, 0.1]].forEach(function (cfg) {
        var cy0 = G.Y(n.nose * cfg[0]);
        out.push(pathEl(polyD([[px(-30), py(cy0 - 10)], [px(G.X(0.02) + 60), py(cy0 + 34)], [px(G.X(0.02) + 70), py(cy0 + 14)], [px(-20), py(cy0 - 26)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
      });
    }
    // side skirts
    if (d.skirts) {
      var sx0 = G.fa + G.aRF + 20, sx1 = G.ra - G.aRR - 20;
      out.push(pathEl(polyD([[px(sx0), py(G.yb + 40)], [px(sx1), py(G.yb + 40)], [px(sx1 + 10), py(G.yb - 22)], [px(sx0 - 10), py(G.yb - 18)]], true), { fill: carbonish ? url(P, 'carbon') : url(P, 'trim'), stroke: '#000', 'stroke-width': 0.6 }));
      out.push(lineEl(px(sx0), py(G.yb + 36), px(sx1), py(G.yb + 36), { stroke: '#ffffff', 'stroke-opacity': 0.18, 'stroke-width': 0.8 }));
    }
    // diffuser
    if (d.diffuser !== 'none') {
      var big = d.diffuser === 'race' ? 1.7 : d.diffuser === 'carbon' ? 1.25 : 0.85;
      var dx0 = Math.max(G.ra + G.aRR * 0.75, L - 520 * big), dxe = L + (d.diffuser === 'race' ? 40 : 0);
      var ddf = polyD([[px(dx0), py(G.yb + 8)], [px(dxe), py(G.yb + 95 * big)], [px(dxe), py(G.yb + 40 * big - 30)], [px(dx0 + 40), py(G.yb - 16)]], true);
      out.push(pathEl(ddf, { fill: d.diffuser === 'mild' ? url(P, 'trim') : url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
      if (d.diffuser !== 'mild') out.push(lineEl(px(dx0 + 40), py(G.yb - 6), px(dxe - 4), py(G.yb + 82 * big), { stroke: '#ffffff', 'stroke-opacity': 0.2, 'stroke-width': 0.7 }));
    }
    return out.join('');
  }

  function exhaustSide(G, sp, o) {
    var d = sp.d, P = o.P, s = G.s, px = G.px, py = G.py, L = G.L, out = [];
    if (d.tipStyle === 'none') return '';
    var yC = G.yb + (d.tipStyle === 'center' ? 125 : 72);
    var x1 = L + 12;
    function tip(xEnd, y, dia, fill, len, oval) {
      var rH = dia / 2 * s, rW = (oval ? dia * 0.42 : dia * 0.3) * s, l = len * s;
      out.push(pathEl(roundRectD(px(xEnd) - l, py(y) - rH, l, rH * 2, rH * 0.5), { fill: fill, stroke: '#2a2b2e', 'stroke-width': 0.5 }));
      out.push(ellipseEl(px(xEnd), py(y), rW * 0.6, rH, { fill: '#080809', stroke: fill, 'stroke-width': 1.2 }));
    }
    switch (d.tipStyle) {
      case 'hidden': out.push(pathEl(roundRectD(px(L - 210), py(G.yb + 40), 70 * s, 26 * s, 6 * s), { fill: '#141416' })); break;
      case 'blued': tip(x1 - 10, yC + 18, 92, url(P, 'blued'), 120); tip(x1, yC - 30, 92, url(P, 'blued'), 110); break;
      case 'center': tip(x1 + 6, yC, 128, url(P, 'chrome'), 130); break;
      case 'oval': tip(x1, yC, 74, url(P, 'chrome'), 130, true); break;
      default: tip(x1, yC, 96, url(P, 'chrome'), 110);
    }
    return out.join('');
  }

  /* wing element in local coordinates (leading edge at 0,0; chord along +x; y down) */
  function airfoilD(cpx, tpx) {
    return 'M0 0 C' + P2(cpx * 0.06, -tpx * 0.95) + ' ' + P2(cpx * 0.45, -tpx * 0.95) + ' ' + P2(cpx, -tpx * 0.3) +
      ' L' + P2(cpx, -tpx * 0.05) + ' C' + P2(cpx * 0.62, tpx * 1.05) + ' ' + P2(cpx * 0.14, tpx * 1.0) + ' 0 0 Z';
  }
  function wingSide(G, sp, o) {
    var d = sp.d, n = sp.n, c = sp.c, P = o.P, s = G.s, px = G.px, py = G.py, out = [], L = G.L;
    if (d.wing === 'ducktail') {
      var x0 = G.X(0.88), x1 = L - 4, yE = G.prof(x1 - 30);
      var dd = 'M' + P2(px(x0), py(G.prof(x0) - 2)) + ' C' + P2(px(lerp(x0, x1, 0.55)), py(G.prof(lerp(x0, x1, 0.55)) + 10)) + ' ' + P2(px(x1 - 70), py(yE + 70)) + ' ' + P2(px(x1 + 20), py(yE + 85)) +
        ' L' + P2(px(x1 + 10), py(yE - 30)) + ' L' + P2(px(x0), py(G.prof(x0) - 40)) + ' Z';
      out.push(pathEl(dd, { fill: url(P, 'paint'), stroke: shade(c.paint, -0.6), 'stroke-width': 0.9 }));
      out.push(pathEl(dd, { fill: url(P, 'topLight') }));
      return out.join('');
    }
    if (d.wing === 'lip-spoiler') {
      var lx = ['hatch', 'wagon', 'box', 'kammback'].indexOf(d.tailStyle) >= 0 && !d.openTop ? G.xCE - 30 : L - 40;
      var ly = G.prof(lx);
      out.push(pathEl(polyD([[px(lx - 220), py(ly - 4)], [px(lx + 20), py(ly + 46)], [px(lx + 26), py(ly + 30)], [px(lx + 12), py(ly - 10)]], true), { fill: d.style === 'hypercar' ? url(P, 'carbon') : url(P, 'gblack'), stroke: '#000', 'stroke-width': 0.6 }));
      return out.join('');
    }
    var m = G.wingMount;
    if (!m) return '';
    var cpx = m.chord * s, tpx = m.chord * 0.12 * s;
    var ang = d.wing === 'active' && !d.activeAero ? Math.min(n.wingAng, 4) : n.wingAng;
    var leX = px(m.xLe), leY = py(m.base + m.h);
    var carbon = d.style === 'hypercar' || d.wheelMat === 'carbon' || d.splitter === 'carbon' || d.splitter === 'race';
    var elFill = carbon ? url(P, 'carbon') : url(P, 'gblack');
    var basePx = py(m.base);
    // supports
    if (d.wing === 'gt-wing' || d.wing === 'biplane') {
      var a0 = px(m.xLe + m.chord * 0.28), a1 = px(m.xLe + m.chord * 0.56);
      out.push(pathEl(polyD([[a0 - 3, basePx + 3], [a1 + 3, basePx + 3], [a1, leY + tpx * 0.6], [a0 + 6, leY + tpx * 0.9]], true), { fill: url(P, 'gblack'), stroke: '#000', 'stroke-width': 0.6 }));
      out.push(lineEl(a0 + 4, basePx - 2, a0 + 8, leY + tpx * 1.4, { stroke: '#ffffff', 'stroke-opacity': 0.12, 'stroke-width': 0.8 }));
    } else if (d.wing === 'swan-neck') {
      var nx = px(m.xLe + m.chord * 0.8);
      out.push(pathEl('M' + P2(nx, basePx + 2) + ' C' + P2(nx + 10, leY + 20) + ' ' + P2(nx + 14, leY - tpx * 3.2) + ' ' + P2(px(m.xLe + m.chord * 0.42), leY - tpx * 1.8), { fill: 'none', stroke: '#0b0b0c', 'stroke-width': Math.max(2, 32 * s), 'stroke-linecap': 'round' }));
    } else if (d.wing === 'active') {
      out.push(lineEl(px(m.xLe + m.chord * 0.3), basePx, px(m.xLe + m.chord * 0.32), leY + tpx * 0.5, { stroke: '#8d939b', 'stroke-width': Math.max(1.2, 16 * s) }));
      out.push(lineEl(px(m.xLe + m.chord * 0.66), basePx, px(m.xLe + m.chord * 0.62), leY + tpx * 0.3, { stroke: '#8d939b', 'stroke-width': Math.max(1.2, 16 * s) }));
    }
    // endplate (fixed)
    var epTop = leY - cpx * 0.32, epBot = d.wing === 'biplane' ? py(m.base + m.h * 0.5) + cpx * 0.15 : leY + cpx * 0.28;
    if (d.wing !== 'active') out.push(pathEl(roundRectD(leX - cpx * 0.08, epTop, cpx * 1.14, epBot - epTop, cpx * 0.08), { fill: elFill, opacity: 0.92, stroke: '#000', 'stroke-width': 0.6 }));
    // element(s), rotated by the wing angle (positive angle of attack lifts the trailing edge)
    var el = function (x, y, cp, tp, extra) {
      return '<g transform="translate(' + f(x) + ' ' + f(y) + ') rotate(' + f(-ang) + ')">' + pathEl(airfoilD(cp, tp), { fill: elFill, stroke: '#000', 'stroke-width': 0.7 }) +
        pathEl('M' + P2(cp * 0.05, -tp * 0.75) + ' C' + P2(cp * 0.3, -tp * 0.95) + ' ' + P2(cp * 0.7, -tp * 0.7) + ' ' + P2(cp * 0.98, -tp * 0.32), { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.28, 'stroke-width': 0.7 }) +
        lineEl(cp, -tp * 0.3, cp + 0.5, -tp * 0.3 - cp * 0.07, { stroke: '#111', 'stroke-width': 1.4 }) + (extra || '') + '</g>';
    };
    out.push(el(leX, leY, cpx, tpx));
    if (d.wing === 'biplane') out.push(el(px(m.xLe + m.chord * 0.12), py(m.base + m.h * 0.55), cpx * 0.8, tpx * 0.85));
    if (d.wing === 'active' && d.activeAero) out.push(circleEl(leX + cpx * 0.5, leY - tpx * 1.8, 1.6, { fill: '#3ee6a8', filter: url(P, 'glow') }));
    return out.join('');
  }

  function studio(P, d, mode, groundY, poolCx, poolRx) {
    if (mode === 'none') return '';
    var out = [];
    if (mode === 'full') {
      out.push(rectEl(0, 0, VBW, VBH, { fill: url(P, 'studio') }));
      out.push(rectEl(0, 0, VBW, groundY + 20, { fill: url(P, 'spot') }));
      var grid = '';
      for (var i = -12; i <= 12; i++) grid += 'M' + P2(VBW / 2 + i * 40, groundY) + ' L' + P2(VBW / 2 + i * 150, VBH) + ' ';
      for (var j = 1; j < 6; j++) { var yy = groundY + Math.pow(j / 6, 1.7) * (VBH - groundY); grid += 'M0 ' + f(yy) + ' L' + VBW + ' ' + f(yy) + ' '; }
      out.push(pathEl(grid, { fill: 'none', stroke: d.theme === 'light' ? '#000000' : '#ffffff', 'stroke-opacity': 0.05, 'stroke-width': 1 }));
    }
    // floor glare: centred under the car when the caller knows where it is (shape-drawn cars)
    out.push(ellipseEl(isFinite(poolCx) ? poolCx : VBW / 2, groundY + 6, isFinite(poolRx) && poolRx > 0 ? poolRx : VBW * 0.42, 70, { fill: url(P, 'pool') }));
    out.push(rectEl(-VBW * 0.5, groundY, VBW * 2, 1, { fill: url(P, 'horizon') }));
    return g({ class: 'cbr-studio' }, out.join(''));
  }

  function drawSide(sp, o) {
    var G = sideGeom(sp), n = sp.n, d = sp.d, c = sp.c, P = o.P, s = G.s, px = G.px, py = G.py, hi = o.detail !== 'low', L = G.L;
    G.dlo = dloSide(G);
    var bodyD = bodyPathSide(G), out = [], car = [];
    out.push('<defs><clipPath id="' + P + 'body"><path d="' + bodyD + '"/></clipPath>' +
      '<linearGradient id="' + P + 'reflG" gradientUnits="userSpaceOnUse" x1="0" y1="' + GROUND + '" x2="0" y2="' + (GROUND + 120) + '">' + stops([[0, '#ffffff', 0.9], [1, '#ffffff', 0]]) + '</linearGradient>' +
      '<mask id="' + P + 'reflM" maskUnits="userSpaceOnUse" x="' + (-VBW) + '" y="' + GROUND + '" width="' + (3 * VBW) + '" height="' + (VBH - GROUND) + '">' + rectEl(-VBW, GROUND, 3 * VBW, VBH - GROUND, { fill: url(P, 'reflG') }) + '</mask></defs>');
    out.push(studio(P, d, o.backdrop || 'soft', GROUND));
    // headlight beam on the floor
    if (d.lights !== 'halogen' && d.theme !== 'light' && hi) out.push(ellipseEl(px(-260), GROUND + 4, 260 * s * 1.6, 14, { fill: url(P, 'beam') }));
    // contact & ambient shadows
    out.push(ellipseEl(px(L / 2), GROUND + 3, L * s * 0.56, 16, { fill: url(P, 'shadow') }));
    out.push(rectEl(px(G.fa), GROUND - 6, (G.ra - G.fa) * s, 8, { fill: '#000', opacity: d.theme === 'light' ? 0.18 : 0.35, filter: hi ? url(P, 'blurM') : null }));
    [[G.fa, n.tRF], [G.ra, n.tRR]].forEach(function (w) { out.push(ellipseEl(px(w[0]), GROUND + 1, w[1] * s * 0.95, 5, { fill: '#000', opacity: 0.75, filter: hi ? url(P, 'blurS') : null })); });
    if (o.reflection) out.push(g({ mask: url(P, 'reflM'), opacity: d.theme === 'light' ? 0.22 : 0.18, class: 'cbr-ghost' }, '<use href="#' + P + 'car" xlink:href="#' + P + 'car" transform="matrix(1 0 0 -1 0 ' + f(GROUND * 2 + 2) + ')"/>'));

    // ---- the car
    // wheel wells (dark arch interiors)
    [[G.fa, n.tRF, G.aRF], [G.ra, n.tRR, G.aRR]].forEach(function (w) {
      var hit = archHit(w[0], w[1], w[2], G.yb + 12);
      car.push(pathEl('M' + P2(px(w[0] + hit.dx), py(hit.y)) + ' A' + f2(w[2] * s) + ' ' + f2(w[2] * s) + ' 0 ' + hit.large + ' 0 ' + P2(px(w[0] - hit.dx), py(hit.y)) + ' Z', { fill: url(P, 'well') }));
    });
    var paintG = [];
    paintG.push(pathEl(bodyD, { fill: url(P, 'paint') }));
    var ov = [];
    var yTopPx = py(G.topMm + 60), yBotPx = py(G.yb - 40), x0p = px(-80), wp = (L + 160) * s;
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') ov.push(rectEl(x0p, yTopPx, wp, yBotPx - yTopPx, { fill: url(P, 'flake'), opacity: f2(0.06 + d.metallic * 0.16) }));
    ov.push(rectEl(x0p, yTopPx, wp, py(G.yBelt - (G.yBelt - G.yb) * 0.2) - yTopPx, { fill: url(P, 'topLight') }));
    var yS1 = G.yBelt - (G.yBelt - G.yb) * 0.1, yS2 = G.yBelt - (G.yBelt - G.yb) * 0.34;
    if (d.finish !== 'matte') {
      ov.push(rectEl(px(G.X(0.03)), py(yS1), (G.X(0.97) - G.X(0.03)) * s, (yS1 - yS2) * s, { fill: url(P, 'spec'), filter: hi ? url(P, 'blurS') : null }));
      ov.push(pathEl(polyD(profLine(G, G.X(0.06), G.X(0.95), -70, 24).map(function (p) { return [p[0], Math.max(p[1], py(G.yBelt - 28))]; })), { fill: 'none', stroke: '#ffffff', 'stroke-opacity': f2(0.1 + d.gloss * 0.28), 'stroke-width': 1.1 }));
      ov.push(ellipseEl(px(G.fa + 120), py(G.yBelt - 70), 520 * s, 110 * s, { fill: url(P, 'hot') }));
      ov.push(ellipseEl(px(G.ra - 60), py(G.yBelt - 50), 480 * s, 120 * s, { fill: url(P, 'hot') }));
    }
    if (d.finish === 'chrome' || d.finish === 'candy') ov.push(rectEl(x0p, py(lerp(G.yb, G.yBelt, 0.5)), wp, 3, { fill: '#000', opacity: d.finish === 'chrome' ? 0.35 : 0.12 }));
    ov.push(rectEl(x0p, py(G.yb + (G.yBelt - G.yb) * 0.55), wp, (G.yBelt - G.yb) * 0.55 * s + 40, { fill: url(P, 'lowShade') }));
    ov.push(stripesSide(G, sp, o));
    ov.push(panelLinesSide(G, sp, o));
    paintG.push(g({ 'clip-path': url(P, 'body') }, ov.join('')));
    paintG.push(pathEl(bodyD, { fill: 'none', stroke: shade(c.paint, -0.62), 'stroke-width': 1.1, 'stroke-linejoin': 'round' }));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, paintG.join('')));
    car.push(g({ class: 'cbr-ghost' }, greenhouseSide(G, sp, o) + lightsSide(G, sp, o) + detailsSide(G, sp, o) + aeroSide(G, sp, o) + exhaustSide(G, sp, o)));
    // wheels
    var wh = wheelFace(sp, o, px(G.fa), py(n.tRF), n.tRF, n.rimR, n.rotF, d.pisF, true, 0, s) + wheelFace(sp, o, px(G.ra), py(n.tRR), n.tRR, n.rimR, n.rotR, d.pisR, false, 1, s);
    car.push(g({ class: 'cbr-ghost cbr-wheels' }, wh));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, wingSide(G, sp, o)));
    out.push(g({ id: P + 'car', class: 'cbr-car' }, car.join('')));
    if (o.xray) out.push(g({ class: 'cbr-xr' }, xraySide(G, sp, o)));
    return { markup: out.join(''), bounds: G.bounds, G: G };
  }

  /* ======================================================================
     FRONT / REAR VIEWS
     ====================================================================== */
  function crossGeom(sp) {
    var n = sp.n, d = sp.d;
    var dz = n.ride - n.nomRide;
    var tw = Math.max(n.twF, n.twR);
    var Wt = Math.max(n.W, n.track + tw + 40) + 560;
    var Ht = n.H + Math.max(0, dz) + 260;
    var s = Math.min(800 / Wt, 395 / Ht);
    var C = { n: n, d: d, s: s, dz: dz };
    C.px = function (x) { return VBW / 2 + x * s; };
    C.py = function (y) { return GROUND - y * s; };
    C.Y = function (fy) { return fy * n.H + dz; };
    C.hw = n.W / 2;
    C.yb = n.ride;
    C.yBelt = C.Y(n.belt); C.yRoof = C.Y(n.roofH); C.yNose = C.Y(n.nose); C.yDeck = C.Y(n.deck); C.yTail = C.Y(n.tail);
    C.yCowl = C.Y(Math.max(n.belt + 0.02, n.nose + 0.05));
    var X = d.X;
    C.shoulder = X.shoulder; C.tumble = d.style === 'hypercar' ? 0.5 : X.tumble;
    C.tRmax = Math.max(n.tRF, n.tRR);
    C.yArch = clamp(C.tRmax * 1.02 + dz * 0.5, C.yb + 60, C.yBelt - 120);
    C.xIn = n.track / 2 - tw / 2 - 30;
    return C;
  }
  /* body cross-section outline (px), with tyre openings at the lower corners */
  function crossOutline(C, rear) {
    var d = C.d, hw = C.hw, px = C.px, py = C.py, sh = C.shoulder, tb = C.tumble;
    var yTop = d.openTop ? C.yCowl + 10 : C.yRoof;
    var right = [
      [hw * 0.975, C.yArch + 10, 0], [hw, lerp(C.yArch, C.yBelt, 0.45), 0], [hw * sh, C.yBelt - 30, 0], [hw * (sh - 0.05), C.yBelt + 15, 1]
    ];
    if (!d.openTop) {
      var gwB = hw * (sh - 0.1), gwT = hw * (1 - tb) * 0.9;
      right.push([lerp(gwB, gwT, 0.5) + hw * 0.02, lerp(C.yBelt, yTop, 0.5), 0], [gwT, yTop - 55, 0], [gwT * 0.8, yTop, 0]);
    } else {
      right.push([hw * (sh - 0.12), yTop, 0]);
    }
    var pts = [];
    // bottom: centre section at the bumper, lifting over the tyres at the corners
    var xIn = Math.min(C.xIn, hw * 0.72);
    pts.push([-xIn, C.yArch, 1], [-xIn + 50, C.yb + 30, 0], [0, C.yb + 18, 0], [xIn - 50, C.yb + 30, 0], [xIn, C.yArch, 1]);
    pts = pts.concat(right);
    var left = right.slice().reverse().map(function (p) { return [-p[0], p[1], p[2]]; });
    pts = pts.concat(left);
    return smoothD(pts.map(function (p) { return [px(p[0]), py(p[1]), p[2]]; }), true, 0.14);
  }
  function crossHalfAt(C, y) {
    var hw = C.hw, sh = C.shoulder, tb = C.tumble, d = C.d;
    if (y <= C.yBelt) return y < C.yArch ? hw * 0.97 : lerp(hw, hw * sh, clamp((y - C.yArch) / Math.max(1, C.yBelt - C.yArch), 0, 1));
    if (d.openTop) return hw * (sh - 0.08);
    return lerp(hw * (sh - 0.1), hw * (1 - tb) * 0.9, clamp((y - C.yBelt) / Math.max(1, C.yRoof - C.yBelt), 0, 1));
  }

  function tyreFront(C, sp, o, x, rear) {
    var n = sp.n, d = sp.d, P = o.P, s = C.s, px = C.px, py = C.py, out = [];
    var tw = rear ? n.twR : n.twF, tR = rear ? n.tRR : n.tRF;
    var cam = rear ? n.camR : n.camF;
    var ang = x < 0 ? -cam : cam;
    if (rear) ang = -ang;
    var x0 = px(x - tw / 2), y0 = py(tR * 2), w = tw * s, h = tR * 2 * s;
    var inner = pathEl(roundRectD(x0, y0, w, h, w * 0.22), { fill: url(P, 'tread') });
    // grooves & sipes by compound
    var grooves = d.compound === 'slick' ? 0 : d.compound === 'track' ? 2 : d.compound === 'eco' || d.compound === 'touring' ? 4 : d.compound === 'performance' || d.compound === 'super-sport' ? 3 : 5;
    var gl = '';
    for (var k = 1; k <= grooves; k++) { var gx = x0 + w * (0.12 + 0.76 * k / (grooves + 1)); gl += 'M' + P2(gx, y0 + h * 0.05) + ' L' + P2(gx, y0 + h * 0.95) + ' '; }
    if (gl) inner += pathEl(gl, { stroke: '#050506', 'stroke-width': Math.max(0.8, w * 0.035), fill: 'none' });
    if (grooves >= 3 && o.detail !== 'low') {
      var sip = '', per = h / 14;
      for (var j = -1; j < 16; j++) { var yy = y0 + j * per; sip += 'M' + P2(x0 + w * 0.1, yy) + ' L' + P2(x0 + w * 0.9, yy + per * (d.compound === 'winter' || d.compound === 'all-season' ? 0.6 : 0.25)) + ' '; }
      var clipId = P + 'tc' + (rear ? 'r' : 'f') + (x < 0 ? 'l' : 'r');
      inner += '<clipPath id="' + clipId + '"><path d="' + roundRectD(x0, y0, w, h, w * 0.22) + '"/></clipPath>';
      inner += g({ 'clip-path': 'url(#' + clipId + ')' }, g({ 'data-tread': 'y', 'data-period': f2(per) }, pathEl(sip, { stroke: '#060607', 'stroke-width': 0.8, fill: 'none', opacity: 0.8 })));
    }
    inner += pathEl(roundRectD(x0, y0, w, h, w * 0.22), { fill: 'none', stroke: '#2b2b30', 'stroke-width': 0.8 });
    inner += rectEl(x0 + w * 0.08, y0 + h * 0.5, w * 0.84, h * 0.02, { fill: '#ffffff', opacity: 0.04 });
    out.push(g({ transform: 'rotate(' + f2(ang) + ' ' + f(px(x)) + ' ' + f(py(0)) + ')' }, inner));
    return out.join('');
  }

  function headlampFront(C, sp, o, side) {
    var d = sp.d, P = o.P, s = C.s, px = C.px, py = C.py, out = [], hi = o.detail !== 'low', hw = C.hw;
    var ns = d.noseStyle, cyL = C.yNose - (ns === 'blunt' || ns === 'tall' ? 140 : 70);
    var lw = ns === 'wedge' ? hw * 0.36 : ns === 'blunt' || ns === 'tall' ? hw * 0.3 : hw * 0.3, lh = ns === 'wedge' ? 60 : ns === 'blunt' || ns === 'tall' ? 170 : 110;
    var xc = side * hw * 0.66;
    var pts;
    if (ns === 'wedge') pts = [[xc - side * lw / 2, cyL + lh * 0.2], [xc + side * lw / 2, cyL + lh * 0.9], [xc + side * lw / 2, cyL - lh * 0.1], [xc - side * lw / 2, cyL - lh * 0.6]];
    else if (ns === 'blunt' || ns === 'tall') pts = [[xc - side * lw / 2, cyL + lh / 2], [xc + side * lw / 2, cyL + lh / 2], [xc + side * lw / 2, cyL - lh / 2], [xc - side * lw / 2, cyL - lh / 2]];
    else pts = [[xc - side * lw / 2, cyL + lh * 0.1], [xc - side * lw * 0.1, cyL + lh * 0.55], [xc + side * lw / 2, cyL + lh * 0.45], [xc + side * lw * 0.45, cyL - lh * 0.35], [xc - side * lw * 0.3, cyL - lh * 0.45]];
    var pp = pts.map(function (p) { return [px(p[0]), py(p[1]), 0]; });
    var lamp = smoothD(pp, true, ns === 'blunt' || ns === 'tall' ? 0.03 : 0.12);
    out.push(pathEl(lamp, { fill: '#0b0e13', stroke: '#030304', 'stroke-width': 0.9 }));
    out.push(pathEl(lamp, { fill: url(P, 'lens'), opacity: 0.7 }));
    var cx = px(xc), cy = py(cyL), r = lh * s * 0.28;
    if (d.lights === 'halogen') {
      out.push(circleEl(cx - side * lw * s * 0.15, cy, r * 1.1, { fill: '#fff4d0', stroke: '#9c8a5a', 'stroke-width': 0.6, filter: hi ? url(P, 'glow') : null }));
      out.push(circleEl(cx + side * lw * s * 0.22, cy, r * 0.8, { fill: '#fff8e2', stroke: '#9c8a5a', 'stroke-width': 0.5 }));
      out.push(rectEl(px(xc + side * lw * 0.38) - 3, cy - 2, 6, 6, { fill: '#ff9a1f' }));
    } else {
      if (d.lights === 'matrix') {
        var cells = '';
        for (var k = 0; k < 8; k++) { var t = k / 7, xx = lerp(px(xc - side * lw * 0.36), px(xc + side * lw * 0.3), t); cells += roundRectD(xx - 1.4, cy - 1.4, 2.8, 2.8, 0.5) + ' '; }
        out.push(pathEl(cells, { fill: '#ffffff', filter: hi ? url(P, 'glow') : null }));
      } else {
        out.push(circleEl(cx - side * lw * s * 0.1, cy, r * 0.7, { fill: '#ffffff', filter: hi ? url(P, 'glow') : null }));
        out.push(circleEl(cx + side * lw * s * 0.18, cy, r * 0.55, { fill: '#e9f1ff' }));
      }
      // signature DRL along the lower edge
      var drl = 'M' + P2(pp[0][0], pp[0][1] - 1.5) + ' L' + P2(pp[1][0], pp[1][1] - 2) + (pp.length > 4 ? ' L' + P2(pp[2][0], pp[2][1] - 2) : '');
      out.push(pathEl(drl, { fill: 'none', stroke: '#ffffff', 'stroke-width': 2, 'stroke-linecap': 'round', filter: hi ? url(P, 'glow') : null }));
      if (d.lights === 'laser') out.push(circleEl(cx + side * lw * s * 0.18, cy, r * 0.25, { fill: '#3a8bff', filter: hi ? url(P, 'glow') : null }));
    }
    out.push(pathEl(lamp, { fill: url(P, 'glassRef'), opacity: 0.7 }));
    return out.join('');
  }

  function grilleFront(C, sp, o) {
    var d = sp.d, P = o.P, s = C.s, px = C.px, py = C.py, out = [], hw = C.hw, X = d.X, hi = o.detail !== 'low';
    var yb = C.yb, yN = C.yNose, h = yN - yb;
    var ev = d.engType === 'ev';
    var dark = '#07080a';
    var mesh = function (dd) { if (hi) out.push(pathEl(dd, { fill: url(P, 'carbon'), opacity: 0.35 })); };
    var chromeEdge = d.badge === 'chrome' ? url(P, 'chrome') : '#0a0a0b';
    function rr(x, y, w, hh, r, a) { return pathEl(roundRectD(px(x), py(y + hh), w * s, hh * s, r * s), a); }
    var type = X.grille;
    if (type === 'kidney') {
      [-1, 1].forEach(function (sd) {
        var dd = roundRectD(px(sd > 0 ? 25 : -25 - hw * 0.26), py(yb + h * 0.92), hw * 0.26 * s, h * 0.42 * s, 60 * s);
        out.push(pathEl(dd, { fill: ev ? url(P, 'paint') : dark, stroke: chromeEdge, 'stroke-width': 2 }));
        if (!ev) { var sl = ''; for (var k = 1; k < 7; k++) { var xx = px((sd > 0 ? 25 : -25 - hw * 0.26) + hw * 0.26 * k / 7); sl += 'M' + P2(xx, py(yb + h * 0.9)) + ' L' + P2(xx, py(yb + h * 0.52)) + ' '; } out.push(pathEl(sl, { stroke: '#3a3d42', 'stroke-width': 1.4 })); }
      });
    } else if (type === 'truck') {
      var dd2 = roundRectD(px(-hw * 0.62), py(yb + h * 0.95), hw * 1.24 * s, h * 0.55 * s, 40 * s);
      out.push(pathEl(dd2, { fill: ev ? url(P, 'paint') : dark, stroke: chromeEdge, 'stroke-width': 2.4 }));
      if (!ev) mesh(dd2);
      out.push(rectEl(px(-hw * 0.62), py(yb + h * 0.72), hw * 1.24 * s, 50 * s, { fill: d.badge === 'chrome' ? url(P, 'chrome') : '#111' }));
      if (d.badge !== 'delete') out.push(textEl(px(0), py(yb + h * 0.79), 'F O R G E', { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(h * 0.16 * s), fill: d.badge === 'chrome' ? url(P, 'chrome') : '#1a1a1c', stroke: '#000', 'stroke-width': 0.4 }));
    } else if (type === 'tall') {
      var dd3 = roundRectD(px(-hw * 0.46), py(yb + h * 0.96), hw * 0.92 * s, h * 0.55 * s, 70 * s);
      out.push(pathEl(dd3, { fill: ev ? url(P, 'paint') : dark, stroke: chromeEdge, 'stroke-width': 2 }));
      if (!ev) { var bars = ''; for (var b = 1; b < 6; b++) { var yy = py(yb + h * (0.41 + 0.55 * b / 6)); bars += 'M' + P2(px(-hw * 0.42), yy) + ' L' + P2(px(hw * 0.42), yy) + ' '; } out.push(pathEl(bars, { stroke: d.badge === 'chrome' ? '#c9ced6' : '#2c2e33', 'stroke-width': 1.6 })); }
    } else if (type === 'none') {
      // hypercar: central nose spine, huge side intakes
      out.push(pathEl(polyD([[px(-hw * 0.18), py(yb + 40)], [px(hw * 0.18), py(yb + 40)], [px(hw * 0.12), py(yb + h * 0.75)], [px(-hw * 0.12), py(yb + h * 0.75)]], true), { fill: dark }));
      [-1, 1].forEach(function (sd) {
        var dd4 = polyD([[px(sd * hw * 0.26), py(yb + 50)], [px(sd * hw * 0.9), py(yb + 70)], [px(sd * hw * 0.86), py(yb + h * 0.55)], [px(sd * hw * 0.3), py(yb + h * 0.62)]], true);
        out.push(pathEl(dd4, { fill: dark, stroke: '#000', 'stroke-width': 0.8 }));
        mesh(dd4);
      });
    } else {
      var gw = type === 'oval' ? hw * 0.62 : type === 'slot' ? hw * 0.9 : type === 'honeycomb' ? hw * 1.0 : hw * 0.86;
      var gy0 = type === 'slot' ? yb + h * 0.66 : yb + h * 0.38, gh = type === 'slot' ? h * 0.12 : type === 'oval' ? h * 0.36 : h * 0.4;
      var dd5 = type === 'honeycomb'
        ? polyD([[px(-gw / 2), py(gy0 + gh)], [px(gw / 2), py(gy0 + gh)], [px(gw * 0.42), py(gy0)], [px(-gw * 0.42), py(gy0)]], true)
        : roundRectD(px(-gw / 2), py(gy0 + gh), gw * s, gh * s, (type === 'oval' ? gh * 0.5 : 50) * s);
      out.push(pathEl(dd5, { fill: ev ? url(P, 'paint') : dark, stroke: ev ? shade(sp.c.paint, -0.4) : chromeEdge, 'stroke-width': ev ? 0.8 : 1.6 }));
      if (!ev) mesh(dd5);
      if (type !== 'slot') {
        var low = roundRectD(px(-hw * 0.5), py(yb + h * 0.3), hw * s, h * 0.18 * s, 30 * s);
        out.push(pathEl(low, { fill: dark }));
        mesh(low);
      } else {
        out.push(pathEl(roundRectD(px(-hw * 0.6), py(yb + h * 0.35), hw * 1.2 * s, h * 0.2 * s, 30 * s), { fill: dark }));
      }
    }
    if (d.activeAero && type !== 'none' && !ev) {
      var sh = '';
      for (var k2 = -5; k2 <= 5; k2++) { var xx2 = px(k2 * hw * 0.07); sh += 'M' + P2(xx2, py(yb + h * 0.32)) + ' L' + P2(xx2, py(yb + h * 0.14)) + ' '; }
      out.push(pathEl(sh, { stroke: '#5a5e66', 'stroke-width': 2.2, opacity: 0.9 }));
    }
    // lower corner intakes / fog lamps
    if (type !== 'none' && type !== 'truck') {
      [-1, 1].forEach(function (sd) {
        var ci = polyD([[px(sd * hw * 0.58), py(yb + 50)], [px(sd * hw * 0.86), py(yb + 60)], [px(sd * hw * 0.82), py(yb + h * 0.3)], [px(sd * hw * 0.6), py(yb + h * 0.26)]], true);
        out.push(pathEl(ci, { fill: dark }));
        if (d.lights === 'halogen' || d.style === 'suv' || d.style === 'pickup') out.push(circleEl(px(sd * hw * 0.72), py(yb + h * 0.17), Math.max(2, 34 * s), { fill: '#fff4d0', stroke: '#777', 'stroke-width': 0.5, opacity: 0.9 }));
      });
    }
    return out.join('');
  }

  function wingCross(C, sp, o, rear) {
    var d = sp.d, P = o.P, s = C.s, px = C.px, py = C.py, out = [];
    if (['gt-wing', 'swan-neck', 'biplane', 'active'].indexOf(d.wing) < 0) return '';
    var G = C.G || sideGeom(sp), m = G.wingMount;
    if (!m) return '';
    var dz = C.dz - G.dz; // identical in both, kept for clarity
    var yW = m.base + m.h + dz, span = d.wing === 'active' ? C.hw * 1.7 : C.hw * 1.84, th = Math.max(30, m.chord * (0.12 + Math.sin(sp.n.wingAng * DEG) * 0.6));
    var carbon = d.style === 'hypercar' || d.wheelMat === 'carbon' || d.splitter === 'carbon' || d.splitter === 'race';
    var fill = carbon ? url(P, 'carbon') : url(P, 'gblack');
    if (rear) {
      if (d.wing === 'gt-wing' || d.wing === 'biplane') [-1, 1].forEach(function (sd) { out.push(rectEl(px(sd * C.hw * 0.42) - 12 * s, py(yW), 24 * s, (yW - m.base - dz) * s, { fill: '#0b0b0c' })); });
      if (d.wing === 'swan-neck') [-1, 1].forEach(function (sd) { out.push(pathEl('M' + P2(px(sd * C.hw * 0.4), py(m.base + dz)) + ' C' + P2(px(sd * C.hw * 0.4), py(yW + 120)) + ' ' + P2(px(sd * C.hw * 0.34), py(yW + 160)) + ' ' + P2(px(sd * C.hw * 0.34), py(yW + th)), { fill: 'none', stroke: '#0b0b0c', 'stroke-width': 26 * s })); });
      if (d.wing === 'active') [-1, 1].forEach(function (sd) { out.push(lineEl(px(sd * C.hw * 0.3), py(m.base + dz), px(sd * C.hw * 0.3), py(yW), { stroke: '#8d939b', 'stroke-width': 14 * s })); });
    }
    out.push(pathEl(roundRectD(px(-span / 2), py(yW + th), span * s, th * s, 10 * s), { fill: fill, stroke: '#000', 'stroke-width': 0.7 }));
    out.push(rectEl(px(-span / 2), py(yW + th) + 1, span * s, 1.4, { fill: '#ffffff', opacity: 0.2 }));
    if (d.wing === 'biplane') out.push(pathEl(roundRectD(px(-span * 0.47), py(m.base + m.h * 0.55 + dz + th * 0.8), span * 0.94 * s, th * 0.8 * s, 8 * s), { fill: fill, stroke: '#000', 'stroke-width': 0.6 }));
    if (d.wing !== 'active') [-1, 1].forEach(function (sd) {
      out.push(pathEl(roundRectD(px(sd * span / 2) - (sd > 0 ? 0 : 14 * s), py(yW + th + 120), 14 * s, (th + 120 + (d.wing === 'biplane' ? m.h * 0.45 : 60)) * s, 4 * s), { fill: fill, stroke: '#000', 'stroke-width': 0.6 }));
    });
    return out.join('');
  }

  function tipsRear(C, sp, o) {
    var d = sp.d, P = o.P, s = C.s, px = C.px, py = C.py, out = [], hw = C.hw;
    if (d.tipStyle === 'none') return '';
    var y = C.yb + (d.tipStyle === 'center' ? 140 : 80);
    var xs = [], n = d.tipCount;
    if (d.tipStyle === 'center') xs = [0];
    else if (n === 1) xs = [hw * 0.55];
    else if (n === 2) xs = [-hw * 0.62, hw * 0.62];
    else if (n === 3) xs = [-hw * 0.6, 0, hw * 0.6];
    else if (n === 4) xs = [-hw * 0.7, -hw * 0.52, hw * 0.52, hw * 0.7];
    else xs = [-hw * 0.74, -hw * 0.6, -hw * 0.46, hw * 0.46, hw * 0.6, hw * 0.74];
    xs.forEach(function (x) {
      if (d.tipStyle === 'hidden') { out.push(ellipseEl(px(x), py(C.yb + 30), 34 * s, 16 * s, { fill: '#111' })); return; }
      var rx = (d.tipStyle === 'oval' ? 62 : d.tipStyle === 'center' ? 66 : 48) * s, ry = (d.tipStyle === 'oval' ? 36 : d.tipStyle === 'center' ? 66 : 48) * s;
      var fill = d.tipStyle === 'blued' ? url(P, 'blued') : url(P, 'chrome');
      out.push(ellipseEl(px(x), py(y), rx, ry, { fill: fill, stroke: '#1b1c1f', 'stroke-width': 0.6 }));
      out.push(ellipseEl(px(x), py(y), rx * 0.78, ry * 0.78, { fill: '#050506' }));
      out.push(ellipseEl(px(x) - rx * 0.15, py(y) - ry * 0.2, rx * 0.45, ry * 0.3, { fill: '#2a1a12', opacity: 0.6 }));
    });
    return out.join('');
  }

  function drawCross(sp, o, rear) {
    var C = crossGeom(sp), n = sp.n, d = sp.d, c = sp.c, P = o.P, s = C.s, px = C.px, py = C.py, hw = C.hw, hi = o.detail !== 'low';
    var out = [], car = [];
    var outline = crossOutline(C, rear);
    out.push('<defs><clipPath id="' + P + 'xbody"><path d="' + outline + '"/></clipPath></defs>');
    out.push(studio(P, d, o.backdrop || 'soft', GROUND));
    out.push(ellipseEl(VBW / 2, GROUND + 3, (Math.max(hw, n.track / 2 + n.twF / 2) + 160) * s, 18, { fill: url(P, 'shadow') }));
    // wing behind the body when seen from the front
    if (!rear) car.push(g({ class: 'cbr-ghost' }, wingCross(C, sp, o, false)));
    // wells + tyres (behind body)
    [-1, 1].forEach(function (sd) {
      car.push(rectEl(px(sd > 0 ? C.xIn - 20 : -hw * 0.98), py(C.yArch + 30), (hw * 0.98 - C.xIn + 20) * s, (C.yArch + 30) * s, { fill: '#040405' }));
    });
    car.push(rectEl(px(-C.xIn), py(C.yb + 40), C.xIn * 2 * s, (C.yb + 40) * s, { fill: '#08080a' }));
    car.push(g({ class: 'cbr-ghost cbr-wheels' }, tyreFront(C, sp, o, -n.track / 2, rear) + tyreFront(C, sp, o, n.track / 2, rear)));
    // mirrors (behind the body edge)
    var mirFill = d.mirrors === 'carbon' ? url(P, 'carbon') : d.mirrors === 'black' ? url(P, 'gblack') : url(P, 'paint');
    var mirrors = '';
    [-1, 1].forEach(function (sd) {
      var mx = sd * (hw + 120), my = C.yBelt + 80;
      mirrors += lineEl(px(sd * hw * 0.86), py(C.yBelt + 30), px(mx - sd * 60), py(my), { stroke: '#0b0b0c', 'stroke-width': 24 * s, 'stroke-linecap': 'round' });
      mirrors += pathEl(roundRectD(px(mx - 100), py(my + 70), 200 * s, 130 * s, 45 * s), { fill: rear ? '#0c0d10' : mirFill, stroke: '#050506', 'stroke-width': 0.8 });
      if (rear) mirrors += pathEl(roundRectD(px(mx - 85), py(my + 58), 170 * s, 106 * s, 36 * s), { fill: url(P, 'glass') });
      mirrors += pathEl(roundRectD(px(mx - 100), py(my + 70), 200 * s, 130 * s, 45 * s), { fill: url(P, 'topLight') });
    });
    car.push(g({ class: 'cbr-ghost' }, mirrors));
    // body
    var bodyG = [pathEl(outline, { fill: url(P, 'paint') })];
    var ov = [];
    var topPx = py(C.yRoof + 80), botPx = py(C.yb - 20);
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') ov.push(rectEl(px(-hw - 50), topPx, (hw * 2 + 100) * s, botPx - topPx, { fill: url(P, 'flake'), opacity: f2(0.06 + d.metallic * 0.16) }));
    ov.push(rectEl(px(-hw - 50), topPx, (hw * 2 + 100) * s, botPx - topPx, { fill: url(P, 'edgeShade') }));
    // bonnet / boot lid surface catches the sky
    var yS0 = rear ? C.yTail : C.yNose, yS1 = rear ? C.yDeck + 30 : C.yCowl;
    var lid = polyD([[px(-crossHalfAt(C, yS0) * 0.94), py(yS0)], [px(crossHalfAt(C, yS0) * 0.94), py(yS0)], [px(crossHalfAt(C, yS1) * 0.9), py(yS1)], [px(-crossHalfAt(C, yS1) * 0.9), py(yS1)]], true);
    ov.push(pathEl(lid, { fill: '#ffffff', opacity: d.finish === 'matte' ? 0.04 : 0.1 + d.gloss * 0.1 }));
    ov.push(lineEl(px(-crossHalfAt(C, yS0) * 0.94), py(yS0), px(crossHalfAt(C, yS0) * 0.94), py(yS0), { stroke: '#000', 'stroke-opacity': 0.4, 'stroke-width': 1 }));
    ov.push(rectEl(px(-hw - 50), py(C.yb + (C.yBelt - C.yb) * 0.45), (hw * 2 + 100) * s, (C.yBelt - C.yb) * 0.45 * s + 20, { fill: url(P, 'lowShade') }));
    // stripes (over the nose/tail, the lids and the roof)
    var st = d.stripe, sc = c.stripe;
    var band = function (x0, w, op) { ov.push(rectEl(px(x0), topPx, w * s, botPx - topPx, { fill: sc, opacity: op || 0.95 })); };
    if (st === 'racing-dual') { band(-hw * 0.26, hw * 0.17); band(hw * 0.09, hw * 0.17); }
    else if (st === 'center') band(-hw * 0.2, hw * 0.4);
    else if (st === 'le-mans') { band(rear ? hw * 0.12 : -hw * 0.36, hw * 0.24); band(rear ? hw * 0.39 : -hw * 0.41, hw * 0.025); }
    else if (st === 'hood' && !rear) ov.push(pathEl(lid, { fill: sc, opacity: 0.85 }));
    else if (st === 'side-skirt' || st === 'gradient') [-1, 1].forEach(function (sd) { ov.push(rectEl(px(sd > 0 ? hw * 0.9 : -hw * 1.02), py(C.yb + 160), hw * 0.12 * s, 110 * s, { fill: sc, opacity: st === 'gradient' ? 0.5 : 0.95 })); });
    else if (st === 'pinstripe') ov.push(pathEl('M' + P2(px(-hw * C.shoulder), py(C.yBelt - 45)) + ' L' + P2(px(hw * C.shoulder), py(C.yBelt - 45)), { stroke: sc, 'stroke-width': 1.1 }));
    // cladding
    if (d.X.cladding) [-1, 1].forEach(function (sd) { ov.push(rectEl(px(sd > 0 ? C.xIn - 30 : -hw), py(C.yArch + 70), (hw - C.xIn + 30) * s, 80 * s, { fill: '#121315', opacity: 0.9 })); });
    bodyG.push(g({ 'clip-path': url(P, 'xbody') }, ov.join('')));
    bodyG.push(pathEl(outline, { fill: 'none', stroke: shade(c.paint, -0.62), 'stroke-width': 1.1 }));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, bodyG.join('')));

    // glass: windscreen / rear window; roof band
    var det = [];
    if (!d.openTop) {
      var gy0 = (rear ? Math.max(C.yDeck, C.yBelt) : C.yCowl) + 15, gy1 = C.yRoof - (d.roof === 'glass' ? 40 : 70);
      if (rear && (d.tailStyle === 'bed')) gy0 = C.yBelt + 60;
      var gb = crossHalfAt(C, gy0) * 0.88, gt = crossHalfAt(C, gy1) * 0.9;
      var gl = smoothD([[px(-gb), py(gy0), 1], [px(gb), py(gy0), 1], [px(gt), py(gy1), 0], [px(0), py(gy1 + 12), 0], [px(-gt), py(gy1), 0]], true, 0.1);
      det.push('<clipPath id="' + P + 'xgl"><path d="' + gl + '"/></clipPath>');
      var inside = rectEl(px(-hw), py(gy1 + 40), hw * 2 * s, (gy1 - gy0 + 80) * s, { fill: '#0d1116' });
      var seatsN = d.seats > 1 ? 2 : 1;
      for (var si = 0; si < seatsN; si++) {
        var sx = seatsN === 1 ? 0 : (si ? 1 : -1) * hw * 0.36;
        inside += pathEl(roundRectD(px(sx - 110), py(Math.min(gy1 - 40, C.yBelt + 520)), 220 * s, 300 * s, 60 * s), { fill: shade(sp.c.intP, 0.1) });
      }
      if (!rear) inside += ellipseEl(px(hw * 0.36), py(C.yBelt + 210), 150 * s, 60 * s, { fill: 'none', stroke: '#050506', 'stroke-width': 26 * s });
      inside += rectEl(px(-hw), py(gy1 + 40), hw * 2 * s, (gy1 - gy0 + 80) * s, { fill: url(P, 'glass'), opacity: f2(clamp(0.55 + n.tint * 0.42, 0, 1)) });
      inside += rectEl(px(-hw), py(gy1 + 40), hw * 2 * s, (gy1 - gy0 + 80) * s, { fill: url(P, 'glassRef') });
      if (!rear) inside += pathEl(roundRectD(px(-90), py(gy1 - 10), 180 * s, 55 * s, 20 * s), { fill: '#0a0a0b' });
      det.push(g({ 'clip-path': url(P, 'xgl') }, inside));
      det.push(pathEl(gl, { fill: 'none', stroke: '#050506', 'stroke-width': 2 }));
      if (!rear || ['hatch', 'wagon', 'box', 'kammback'].indexOf(d.tailStyle) >= 0) {
        var wy = py(gy0 + 25);
        det.push(pathEl('M' + P2(px(rear ? -40 : -gb * 0.8), wy) + ' L' + P2(px(rear ? gb * 0.55 : -gb * 0.05), wy - (rear ? 30 : 4) * s) + (rear ? '' : ' M' + P2(px(gb * 0.05), wy) + ' L' + P2(px(gb * 0.8), wy - 4 * s)), { stroke: '#0a0a0b', 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
      }
      if (d.roof !== 'body') {
        var rb = polyD([[px(-gt * 1.15), py(gy1 + 8)], [px(gt * 1.15), py(gy1 + 8)], [px(gt * 1.15), py(C.yRoof + 80)], [px(-gt * 1.15), py(C.yRoof + 80)]], true);
        det.push(g({ 'clip-path': url(P, 'xbody') }, pathEl(rb, { fill: d.roof === 'glass' ? url(P, 'glass') : materialFill(P, d.roof, sp) })));
      }
      if (d.X.roofRails) [-1, 1].forEach(function (sd) { det.push(rectEl(px(sd * gt * 0.92) - 10 * s, py(C.yRoof + 50), 20 * s, 52 * s, { fill: '#0c0c0e' })); });
    } else {
      // roadster: windscreen frame (front), fairings & hoops behind
      var fy0 = C.yCowl + 5, fy1 = C.Y(n.roofH * 0.95);
      if (!rear) {
        var ws = polyD([[px(-hw * 0.78), py(fy0)], [px(hw * 0.78), py(fy0)], [px(hw * 0.7), py(fy1)], [px(-hw * 0.7), py(fy1)]], true);
        det.push(pathEl(ws, { fill: url(P, 'glass'), opacity: 0.55 }));
        det.push(pathEl(ws, { fill: 'none', stroke: d.badge === 'chrome' ? url(P, 'chrome') : '#0a0a0b', 'stroke-width': 30 * s, 'stroke-linejoin': 'round' }));
      }
      [-1, 1].forEach(function (sd) {
        var hx = sd * hw * 0.38;
        det.push(pathEl(roundRectD(px(hx - 110), py(C.yBelt + 330), 220 * s, 300 * s, 60 * s), { fill: shade(sp.c.intP, 0.1) }));
        det.push(pathEl('M' + P2(px(hx - 150), py(C.yBelt + 10)) + ' Q' + P2(px(hx), py(C.yBelt + 560)) + ' ' + P2(px(hx + 150), py(C.yBelt + 10)), { fill: d.roof === 'body' || d.roof === 'glass' ? url(P, 'paint') : materialFill(P, d.roof, sp), stroke: '#000', 'stroke-width': 0.6, opacity: rear ? 1 : 0.85 }));
      });
    }
    // lights, grille, plate, badge
    if (!rear) {
      det.push(grilleFront(C, sp, o));
      det.push(headlampFront(C, sp, o, -1) + headlampFront(C, sp, o, 1));
      if (d.engType === 'ev' && d.lights !== 'halogen') det.push(lineEl(px(-hw * 0.5), py(C.yNose - 40), px(hw * 0.5), py(C.yNose - 40), { stroke: '#ffffff', 'stroke-width': 1.6, filter: hi ? url(P, 'glow') : null, opacity: 0.9 }));
    } else {
      // tail lamps
      var tY = (['hatch', 'wagon', 'box', 'kammback', 'bed'].indexOf(d.tailStyle) >= 0 ? C.yDeck + 40 : C.yTail + 30);
      var vertical = d.tailStyle === 'box' || d.tailStyle === 'bed' || d.tailStyle === 'wagon';
      [-1, 1].forEach(function (sd) {
        var tw = vertical ? hw * 0.2 : hw * 0.4, th = vertical ? 380 : 110;
        var x0 = sd > 0 ? hw * 0.94 - tw : -hw * 0.94;
        var tl = roundRectD(px(x0), py(tY), tw * s, th * s, 20 * s);
        det.push(pathEl(tl, { fill: url(P, 'tailL'), stroke: '#2a0004', 'stroke-width': 0.8 }));
        if (d.lights !== 'halogen') det.push(pathEl('M' + P2(px(x0 + tw * 0.08), py(tY - th * 0.3)) + ' L' + P2(px(x0 + tw * 0.92), py(tY - th * 0.3)), { stroke: '#ff6a5a', 'stroke-width': 2, filter: hi ? url(P, 'glow') : null }));
        else det.push(rectEl(px(x0 + tw * (sd > 0 ? 0 : 0.6)), py(tY - th * 0.55), tw * 0.4 * s, th * 0.4 * s, { fill: '#ff9a1f', opacity: 0.75 }));
        det.push(rectEl(px(x0 + tw * 0.3), py(tY - th * 0.62), tw * 0.32 * s, th * 0.26 * s, { fill: '#f4f4f0', opacity: 0.6 }));
        det.push(pathEl(tl, { fill: url(P, 'glassRef'), opacity: 0.5 }));
      });
      if (d.lights !== 'halogen' && !vertical) det.push(lineEl(px(-hw * 0.54), py(tY - 40), px(hw * 0.54), py(tY - 40), { stroke: '#ff3b30', 'stroke-width': 2.2, filter: hi ? url(P, 'glow') : null }));
      if (!d.openTop) det.push(rectEl(px(-120), py(C.yRoof - 30), 240 * s, 22 * s, { fill: '#ff2a2a', opacity: 0.9 }));
      // boot / tailgate seams
      det.push(pathEl(roundRectD(px(-hw * 0.62), py((vertical ? C.yBelt + 40 : C.yDeck + 10)), hw * 1.24 * s, ((vertical ? C.yBelt + 40 : C.yDeck + 10) - C.yb - 170) * s, 30 * s), { fill: 'none', stroke: '#000', 'stroke-opacity': 0.45, 'stroke-width': 1 }));
      if (d.style === 'van') det.push(lineEl(px(0), py(C.yRoof - 40), px(0), py(C.yb + 170), { stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 1 }));
      if (d.style === 'pickup' && d.badge !== 'delete') det.push(textEl(px(0), py(C.yb + (C.yDeck - C.yb) * 0.55), 'F O R G E', { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(120 * s), fill: d.badge === 'chrome' ? url(P, 'chrome') : '#0d0d0f' }));
      if (d.wing === 'ducktail') det.push(pathEl('M' + P2(px(-hw * 0.86), py(C.yDeck + 20)) + ' Q' + P2(px(0), py(C.yDeck + 70)) + ' ' + P2(px(hw * 0.86), py(C.yDeck + 20)) + ' L' + P2(px(hw * 0.86), py(C.yDeck - 30)) + ' L' + P2(px(-hw * 0.86), py(C.yDeck - 30)) + ' Z', { fill: url(P, 'paint'), stroke: shade(c.paint, -0.6), 'stroke-width': 0.8 }));
      if (d.wing === 'lip-spoiler') det.push(pathEl(roundRectD(px(-hw * 0.7), py(C.yDeck + 40), hw * 1.4 * s, 30 * s, 10 * s), { fill: url(P, 'gblack') }));
    }
    // plate + badge
    if (d.X.plate) {
      var plY = rear ? C.yb + 230 : C.yb + 110;
      det.push(pathEl(roundRectD(px(-260), py(plY + 110), 520 * s, 110 * s, 10 * s), { fill: '#f1f0ea', stroke: '#222', 'stroke-width': 0.8 }));
      det.push(textEl(px(0), py(plY + 22), d.number ? 'RDL ' + d.number : 'RPM WORKS', { 'text-anchor': 'middle', 'font-family': MONO, 'font-weight': 700, 'font-size': f2(76 * s), 'letter-spacing': f2(8 * s), fill: '#16171a' }));
    }
    if (d.badge !== 'delete') {
      var by = rear ? C.yDeck - 60 : (d.X.grille === 'none' ? C.yNose - 30 : C.yb + (C.yNose - C.yb) * 0.86);
      if (rear && ['hatch', 'wagon', 'box', 'kammback', 'bed'].indexOf(d.tailStyle) >= 0) by = C.yBelt - 30;
      var bf = d.badge === 'black' ? url(P, 'badgeBlack') : url(P, 'chrome');
      if (rear) {
        det.push(textEl(px(0), py(by), 'REDLINE', { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 800, 'font-size': f2(70 * s), 'letter-spacing': f2(22 * s), fill: bf, stroke: '#222', 'stroke-width': 0.25 }));
        if (d.engineLabel) det.push(textEl(px(hw * 0.62), py(by - 60), d.engineLabel, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 800, 'font-style': 'italic', 'font-size': f2(46 * s), fill: bf }));
      } else {
        det.push(circleEl(px(0), py(by), 58 * s, { fill: bf, stroke: '#222', 'stroke-width': 0.6 }));
        det.push(textEl(px(0), py(by) + 22 * s, 'F', { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(64 * s), fill: d.badge === 'black' ? '#d8d8d8' : '#1a1a1c' }));
      }
    }
    if (d.number && !rear) {
      det.push(circleEl(px(-hw * 0.3), py(lerp(C.yNose, C.yCowl, 0.5)), 70 * s, { fill: '#f6f3ea', stroke: '#111', 'stroke-width': 1 }));
      det.push(textEl(px(-hw * 0.3), py(lerp(C.yNose, C.yCowl, 0.5)) + 24 * s, d.number, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(66 * s), fill: '#111' }));
    }
    // aero (front: splitter / canards; rear: diffuser & tips) and skirts
    if (!rear) {
      if (d.splitter !== 'none') {
        var spw = d.splitter === 'lip' ? hw * 0.86 : hw * (d.splitter === 'race' ? 1.0 : 0.94);
        det.push(pathEl(roundRectD(px(-spw), py(C.yb + 34), spw * 2 * s, (d.splitter === 'race' ? 30 : 22) * s, 6 * s), { fill: d.splitter === 'lip' ? url(P, 'paint') : url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
        if (d.splitter === 'race') [-1, 1].forEach(function (sd) { det.push(rectEl(px(sd * spw) - (sd > 0 ? 14 * s : 0), py(C.yb + 110), 14 * s, 90 * s, { fill: url(P, 'carbon') })); det.push(lineEl(px(sd * spw * 0.6), py(C.yb + 30), px(sd * spw * 0.5), py(C.yb + 160), { stroke: '#a7adb5', 'stroke-width': 1.2 })); });
      }
      if (d.canards) [-1, 1].forEach(function (sd) {
        [0.3, 0.52].forEach(function (fr) { var yy = C.yb + (C.yNose - C.yb) * fr; det.push(pathEl(polyD([[px(sd * hw * 0.86), py(yy)], [px(sd * (hw + 70)), py(yy + 30)], [px(sd * (hw + 70)), py(yy + 12)], [px(sd * hw * 0.86), py(yy - 18)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.5 })); });
      });
    } else {
      if (d.diffuser !== 'none') {
        var dw = hw * (d.diffuser === 'race' ? 0.82 : d.diffuser === 'carbon' ? 0.7 : 0.55), dh = d.diffuser === 'race' ? 200 : d.diffuser === 'carbon' ? 150 : 100;
        var strakes = d.diffuser === 'race' ? 7 : d.diffuser === 'carbon' ? 5 : 3;
        det.push(pathEl(polyD([[px(-dw), py(C.yb + dh)], [px(dw), py(C.yb + dh)], [px(dw * 1.05), py(C.yb - 10)], [px(-dw * 1.05), py(C.yb - 10)]], true), { fill: d.diffuser === 'mild' ? url(P, 'trim') : url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
        var stk = '';
        for (var k = 0; k < strakes; k++) { var xx = -dw + 2 * dw * (k + 0.5) / strakes; stk += 'M' + P2(px(xx), py(C.yb + dh)) + ' L' + P2(px(xx * 1.05), py(C.yb - 30)) + ' '; }
        det.push(pathEl(stk, { stroke: '#1d1f23', 'stroke-width': Math.max(1.5, 14 * s), fill: 'none' }));
        if (d.diffuser === 'race') det.push(rectEl(px(-40), py(C.yb + dh - 10), 80 * s, 60 * s, { fill: '#ff2a2a', opacity: 0.85 }));
      }
      det.push(tipsRear(C, sp, o));
      if (d.style === 'pickup' || d.style === 'suv') det.push(pathEl(roundRectD(px(-90), py(C.yb + 60), 180 * s, 70 * s, 12 * s), { fill: '#16171a' }));
    }
    if (d.skirts) [-1, 1].forEach(function (sd) { det.push(rectEl(px(sd > 0 ? hw * 0.9 : -hw * 1.0), py(C.yb + 30), hw * 0.1 * s, 55 * s, { fill: url(P, 'carbon') })); });
    car.push(g({ class: 'cbr-ghost' }, det.join('')));
    if (rear) car.push(g({ class: 'cbr-ghost' }, wingCross(C, sp, o, true)));
    out.push(g({ id: P + 'car', class: 'cbr-car' }, car.join('')));
    if (o.xray) out.push(g({ class: 'cbr-xr' }, xrayCross(C, sp, o, rear)));
    var top = Math.min(py(C.yRoof + 300), py(C.yRoof + 80));
    var bw = (Math.max(hw, n.track / 2 + n.twF / 2) + 340) * s;
    return { markup: out.join(''), bounds: { x: VBW / 2 - bw, y: top, w: bw * 2, h: GROUND + 30 - top }, C: C };
  }

  /* ======================================================================
     TOP (PLAN) VIEW — nose to the left, driver (LHD) on the lower half
     ====================================================================== */
  function planGeom(sp) {
    var G = sideGeom(sp), n = sp.n, d = sp.d, X = d.X;
    var T = { G: G, n: n, d: d, s: G.s, L: G.L, cy: 252 };
    T.px = G.px;
    T.py = function (y) { return T.cy + y * G.s; };
    var hw = n.W / 2;
    var fF = Math.max(hw * 0.985, n.track / 2 + n.twF / 2 - 22), fR = Math.max(hw * 0.985, n.track / 2 + n.twR / 2 - 22);
    var tailK = ['box', 'bed', 'wagon', 'kammback', 'hatch'].indexOf(d.tailStyle) >= 0 ? 0.86 : X.planTail + 0.2;
    T.half = [
      [0, hw * X.planNose], [G.X(0.012), hw * (X.planNose + 0.3)], [G.X(0.05), hw * 0.88], [G.fa, fF],
      [lerp(G.fa, G.ra, 0.5), hw * X.waist], [G.ra, fR], [G.X(0.96), hw * 0.94], [G.X(0.992), hw * tailK * 0.97], [G.L, hw * tailK * 0.82]
    ];
    T.hwAt = function (x) {
      var h = T.half;
      if (x <= h[0][0]) return h[0][1];
      for (var i = 0; i < h.length - 1; i++) if (x >= h[i][0] && x <= h[i + 1][0]) return lerp(h[i][1], h[i + 1][1], (x - h[i][0]) / Math.max(1, h[i + 1][0] - h[i][0]));
      return h[h.length - 1][1];
    };
    return T;
  }
  function planOutline(T) {
    var px = T.px, py = T.py, h = T.half;
    var up = h.map(function (p) { return [px(p[0]), py(-p[1]), 0]; });
    var dn = h.slice().reverse().map(function (p) { return [px(p[0]), py(p[1]), 0]; });
    return smoothD(up.concat(dn), true, 0.15);
  }

  function drawTop(sp, o) {
    var T = planGeom(sp), G = T.G, n = sp.n, d = sp.d, c = sp.c, P = o.P, s = T.s, px = T.px, py = T.py, L = T.L, hi = o.detail !== 'low';
    var out = [], car = [];
    var outline = planOutline(T);
    out.push('<defs><clipPath id="' + P + 'pbody"><path d="' + outline + '"/></clipPath></defs>');
    if (o.backdrop === 'full') out.push(rectEl(0, 0, VBW, VBH, { fill: url(P, 'studio') }));
    // floor shadow
    out.push(pathEl(outline, { fill: '#000', opacity: d.theme === 'light' ? 0.22 : 0.5, transform: 'translate(6 12)', filter: hi ? url(P, 'blur') : null }));
    // tyres (only slivers show past the fenders)
    var tyres = '';
    [[G.fa, n.tRF, n.twF], [G.ra, n.tRR, n.twR]].forEach(function (w, wi) {
      [-1, 1].forEach(function (sd) {
        var x0 = px(w[0] - w[1]), y0 = py(sd * n.track / 2 - w[2] / 2), ww = w[1] * 2 * s, hh = w[2] * s;
        var id = P + 'pt' + wi + (sd > 0 ? 'b' : 'a');
        tyres += '<clipPath id="' + id + '"><path d="' + roundRectD(x0, y0, ww, hh, hh * 0.3) + '"/></clipPath>';
        tyres += pathEl(roundRectD(x0, y0, ww, hh, hh * 0.3), { fill: url(P, 'treadV') });
        if (d.compound !== 'slick') {
          var tl = '', per = ww / 12;
          for (var k = -2; k < 15; k++) tl += 'M' + P2(x0 + k * per, y0) + ' L' + P2(x0 + k * per + per * 0.4, y0 + hh) + ' ';
          tyres += g({ 'clip-path': 'url(#' + id + ')' }, g({ 'data-tread': 'x', 'data-period': f2(per) }, pathEl(tl, { stroke: '#050506', 'stroke-width': 0.8, fill: 'none' })));
        }
      });
    });
    car.push(g({ class: 'cbr-ghost cbr-wheels' }, tyres));
    // aero pieces below the body outline
    var under = [];
    if (d.splitter !== 'none') {
      var ext = d.splitter === 'race' ? 120 : d.splitter === 'carbon' ? 55 : 18;
      var sx1 = G.X(0.07);
      var sd0 = smoothD([[px(sx1), py(-T.hwAt(sx1) * 0.97), 1], [px(-ext * 0.4), py(-T.hwAt(0) * 1.05 - ext * 0.5), 0], [px(-ext), py(0), 0], [px(-ext * 0.4), py(T.hwAt(0) * 1.05 + ext * 0.5), 0], [px(sx1), py(T.hwAt(sx1) * 0.97), 1]], true, 0.18);
      under.push(pathEl(sd0, { fill: d.splitter === 'lip' ? url(P, 'paintTop') : url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
    }
    if (d.canards) [-1, 1].forEach(function (sd) { under.push(pathEl(polyD([[px(G.X(0.01)), py(sd * T.hwAt(G.X(0.01)))], [px(G.X(0.045)), py(sd * (T.hwAt(G.X(0.045)) + 60))], [px(G.X(0.06)), py(sd * T.hwAt(G.X(0.06)))]], true), { fill: url(P, 'carbon') })); });
    if (d.skirts) [-1, 1].forEach(function (sd) { under.push(rectEl(px(G.fa + G.aRF), py(sd * (T.hwAt(lerp(G.fa, G.ra, 0.5)) + (sd > 0 ? 0 : 26))), (G.ra - G.aRR - G.fa - G.aRF) * s, 26 * s, { fill: url(P, 'carbon') })); });
    if (d.diffuser === 'race' || d.diffuser === 'carbon') {
      var dd = '', nS = d.diffuser === 'race' ? 7 : 5, dw = T.hwAt(L) * 0.9;
      for (var k = 0; k < nS; k++) { var yy = py(-dw + 2 * dw * (k + 0.5) / nS); dd += 'M' + P2(px(L - 30), yy) + ' L' + P2(px(L + (d.diffuser === 'race' ? 70 : 35)), yy) + ' '; }
      under.push(pathEl(dd, { stroke: '#1d1f23', 'stroke-width': 2.4 }));
    }
    if (d.tipStyle !== 'none' && d.tipStyle !== 'hidden') {
      var C = { hw: n.W / 2 };
      var ys = d.tipStyle === 'center' ? [0] : d.tipCount === 2 ? [-0.62, 0.62] : d.tipCount === 4 ? [-0.7, -0.52, 0.52, 0.7] : d.tipCount === 3 ? [-0.6, 0, 0.6] : d.tipCount === 1 ? [0.55] : [-0.74, -0.6, -0.46, 0.46, 0.6, 0.74];
      ys.forEach(function (fr) { var y = fr * C.hw; under.push(pathEl(roundRectD(px(L - 40), py(y) - 44 * s, 80 * s, 88 * s, 20 * s), { fill: d.tipStyle === 'blued' ? url(P, 'blued') : url(P, 'chromeH') })); });
    }
    car.push(g({ class: 'cbr-ghost' }, under.join('')));
    // mirrors
    var mx = G.xA + 120, mir = '';
    var mirFill = d.mirrors === 'carbon' ? url(P, 'carbon') : d.mirrors === 'black' ? url(P, 'gblack') : url(P, 'paintTop');
    [-1, 1].forEach(function (sd) {
      var y0 = sd * T.hwAt(mx) * 0.92, y1 = sd * (T.hwAt(mx) + 170);
      mir += pathEl('M' + P2(px(mx - 40), py(y0)) + ' L' + P2(px(mx + 10), py(y1)) + ' Q' + P2(px(mx + 140), py(y1 + sd * 10)) + ' ' + P2(px(mx + 150), py(lerp(y0, y1, 0.4))) + ' L' + P2(px(mx + 90), py(y0)) + ' Z', { fill: mirFill, stroke: '#050506', 'stroke-width': 0.8 });
    });
    car.push(g({ class: 'cbr-ghost' }, mir));
    // body
    var bodyG = [pathEl(outline, { fill: url(P, 'paintTop'), stroke: shade(c.paint, -0.62), 'stroke-width': 1.1 })];
    var ov = [];
    var bx = px(-60), bw = (L + 120) * s, by = py(-n.W / 2 - 60), bh = (n.W + 120) * s;
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') ov.push(rectEl(bx, by, bw, bh, { fill: url(P, 'flake'), opacity: f2(0.06 + d.metallic * 0.16) }));
    ov.push(rectEl(bx, by, bw, bh, { fill: url(P, 'edgeShadeV') }));
    if (d.finish !== 'matte') ov.push(ellipseEl(px(L * 0.18), py(-n.W * 0.12), L * 0.16 * s, n.W * 0.14 * s, { fill: url(P, 'hot') }));
    // stripes
    var sc = c.stripe, st = d.stripe, W = n.W;
    var bandY = function (y0, w, op, x0, x1) { ov.push(rectEl(px(x0 == null ? -40 : x0), py(y0), ((x1 == null ? L + 40 : x1) - (x0 == null ? -40 : x0)) * s, w * s, { fill: sc, opacity: op || 0.95 })); };
    if (st === 'racing-dual') { bandY(-W * 0.13, W * 0.085); bandY(W * 0.045, W * 0.085); }
    else if (st === 'center') bandY(-W * 0.1, W * 0.2);
    else if (st === 'le-mans') { bandY(-W * 0.2, W * 0.12); bandY(-W * 0.235, W * 0.015); }
    else if (st === 'hood') ov.push(pathEl(roundRectD(px(G.X(0.03)), py(-T.hwAt(G.xA) * 0.62), (G.xA - G.X(0.03) - 40) * s, T.hwAt(G.xA) * 1.24 * s, 40 * s), { fill: sc, opacity: 0.85 }));
    else if (st === 'pinstripe') { var pp = T.half.slice(1, -1); [-1, 1].forEach(function (sd) { ov.push(pathEl(smoothD(pp.map(function (p) { return [px(p[0]), py(sd * (p[1] - 70)), 0]; }), false), { fill: 'none', stroke: sc, 'stroke-width': 1.1 })); }); }
    else if (st === 'side-skirt') [-1, 1].forEach(function (sd) { ov.push(rectEl(px(G.fa + G.aRF), py(sd > 0 ? T.hwAt(lerp(G.fa, G.ra, 0.5)) - 40 : -T.hwAt(lerp(G.fa, G.ra, 0.5))), (G.ra - G.aRR - G.fa - G.aRF) * s, 40 * s, { fill: sc })); });
    else if (st === 'gradient') ov.push(rectEl(bx, by, bw, bh, { fill: url(P, 'fadeTop'), opacity: 0.8 }));
    // panel seams: bonnet, boot
    var seam = { fill: 'none', stroke: '#000', 'stroke-opacity': 0.45, 'stroke-width': 1 };
    ov.push(lineEl(px(G.xA - 50), py(-T.hwAt(G.xA) * 0.8), px(G.xA - 50), py(T.hwAt(G.xA) * 0.8), seam));
    [-1, 1].forEach(function (sd) { ov.push(pathEl('M' + P2(px(G.xA - 50), py(sd * T.hwAt(G.xA) * 0.8)) + ' Q' + P2(px(G.X(0.1)), py(sd * T.hwAt(G.X(0.1)) * 0.82)) + ' ' + P2(px(G.X(0.035)), py(sd * T.hwAt(G.X(0.035)) * 0.6)), seam)); });
    if (['fastback', 'notchback', 'longtail', 'open'].indexOf(d.tailStyle) >= 0) ov.push(pathEl(roundRectD(px(G.xCE + 60), py(-T.hwAt(G.xCE) * 0.78), (L - G.xCE - 130) * s, T.hwAt(G.xCE) * 1.56 * s, 50 * s), seam));
    // power bulge / vents
    if (d.engType !== 'ev' && d.position === 'front' && n.hp > 520) ov.push(ellipseEl(px(lerp(G.X(0.05), G.xA, 0.55)), py(0), (G.xA - G.X(0.05)) * 0.38 * s, W * 0.12 * s, { fill: '#ffffff', opacity: 0.12 }));
    if (d.X.hoodVents && n.hp > 450) [-1, 1].forEach(function (sd) { for (var v = 0; v < 4; v++) ov.push(lineEl(px(lerp(G.X(0.12), G.xA - 120, 0.4) + v * 40), py(sd * W * 0.12), px(lerp(G.X(0.12), G.xA - 120, 0.4) + v * 40 + 60), py(sd * W * 0.26), { stroke: '#050506', 'stroke-width': 2, 'stroke-linecap': 'round' })); });
    bodyG.push(g({ 'clip-path': url(P, 'pbody') }, ov.join('')));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, bodyG.join('')));
    // greenhouse
    var gh = [];
    var tb = d.style === 'hypercar' ? 0.5 : d.X.tumble;
    var wA = T.hwAt(G.xA) * 0.82, wR = T.hwAt(lerp(G.xRS, G.xRE, 0.5)) * (1 - tb) * 0.98, wC = T.hwAt(G.xCE) * (d.tailStyle === 'box' || d.tailStyle === 'wagon' ? 0.86 : 0.62);
    if (d.openTop) {
      var cx0 = G.xA + 40, cx1 = G.xCE - 30, cw = T.hwAt(lerp(cx0, cx1, 0.5)) * 0.8;
      gh.push(pathEl(roundRectD(px(cx0), py(-cw), (cx1 - cx0) * s, cw * 2 * s, 120 * s), { fill: '#0b0c0e', stroke: '#000', 'stroke-width': 0.8 }));
      [-1, 1].forEach(function (sd) {
        var sy = sd * cw * 0.48, sx = lerp(cx0, cx1, 0.5);
        gh.push(pathEl(roundRectD(px(sx - 260), py(sy - 230), 560 * s, 460 * s, 90 * s), { fill: c.intP, stroke: shade(c.intP, -0.5), 'stroke-width': 0.6 }));
        gh.push(rectEl(px(sx - 220), py(sy - 60), 470 * s, 120 * s, { fill: c.intA, opacity: 0.7 }));
        gh.push(pathEl(roundRectD(px(sx + 220), py(sy - 160), 120 * s, 320 * s, 40 * s), { fill: shade(c.intP, 0.15) }));
      });
      gh.push(ellipseEl(px(lerp(cx0, cx1, 0.5) - 420), py(cw * 0.48), 60 * s, 190 * s, { fill: 'none', stroke: '#050506', 'stroke-width': 30 * s }));
      gh.push(pathEl(polyD([[px(G.xA - 40), py(-T.hwAt(G.xA) * 0.84)], [px(G.xA + 120), py(-T.hwAt(G.xA) * 0.8)], [px(G.xA + 120), py(T.hwAt(G.xA) * 0.8)], [px(G.xA - 40), py(T.hwAt(G.xA) * 0.84)]], true), { fill: url(P, 'glassTop'), stroke: '#0a0a0b', 'stroke-width': 1.4 }));
      [-1, 1].forEach(function (sd) { gh.push(pathEl(roundRectD(px(G.xRE - 60), py(sd * cw * 0.48 - 130), 520 * s, 260 * s, 110 * s), { fill: d.roof === 'body' || d.roof === 'glass' ? url(P, 'paintTop') : materialFill(P, d.roof, sp), stroke: '#000', 'stroke-width': 0.6 })); });
    } else {
      var ws = smoothD([[px(G.xA), py(-wA), 1], [px(G.xRS), py(-wR), 0], [px(G.xRS), py(wR), 0], [px(G.xA), py(wA), 1], [px(G.xA - 30), py(0), 0]], true, 0.1);
      gh.push(pathEl(ws, { fill: url(P, 'glassTop'), stroke: '#050506', 'stroke-width': 1.4 }));
      var rearEnd = d.tailStyle === 'bed' ? G.xCE - 20 : G.xCE;
      var rw = smoothD([[px(G.xRE), py(-wR), 0], [px(rearEnd), py(-wC), 1], [px(rearEnd + 20), py(0), 0], [px(rearEnd), py(wC), 1], [px(G.xRE), py(wR), 0]], true, 0.1);
      gh.push(pathEl(rw, { fill: url(P, 'glassTop'), stroke: '#050506', 'stroke-width': 1.4 }));
      var roofD = roundRectD(px(G.xRS - 10), py(-wR), (G.xRE - G.xRS + 20) * s, wR * 2 * s, Math.min(120, wR * 0.4) * s);
      var rf = d.roof === 'glass' ? url(P, 'glassTop') : d.roof === 'body' ? url(P, 'paintTop') : materialFill(P, d.roof, sp);
      if (d.roof === 'glass') {
        gh.push('<clipPath id="' + P + 'proof"><path d="' + roofD + '"/></clipPath>');
        var seats = '';
        var rows = d.seats > 2 && d.rearSeats ? [0.3, 0.72] : [0.45];
        rows.forEach(function (fr) { [-1, 1].forEach(function (sd) { seats += pathEl(roundRectD(px(lerp(G.xRS, G.xRE, fr) - 200), py(sd * wR * 0.5 - 170), 420 * s, 340 * s, 80 * s), { fill: c.intP }); }); });
        gh.push(g({ 'clip-path': url(P, 'proof') }, rectEl(px(G.xRS - 20), py(-wR - 10), (G.xRE - G.xRS + 40) * s, (wR * 2 + 20) * s, { fill: '#0b0d10' }) + seats + rectEl(px(G.xRS - 20), py(-wR - 10), (G.xRE - G.xRS + 40) * s, (wR * 2 + 20) * s, { fill: url(P, 'glassTop'), opacity: f2(0.55 + n.tint * 0.4) })));
        gh.push(pathEl(roofD, { fill: 'none', stroke: '#050506', 'stroke-width': 1.2 }));
      } else {
        gh.push(pathEl(roofD, { fill: rf, stroke: '#050506', 'stroke-width': 1 }));
        if (d.roof === 'carbon' && hi) gh.push(pathEl(roofD, { fill: url(P, 'carbonSheen') }));
      }
      // roof-over stripes
      if (st === 'racing-dual' || st === 'center' || st === 'le-mans') {
        gh.push('<clipPath id="' + P + 'proof2"><path d="' + roofD + '"/></clipPath>');
        var rs2 = st === 'racing-dual' ? rectEl(px(G.xRS - 20), py(-W * 0.13), (G.xRE - G.xRS + 40) * s, W * 0.085 * s, { fill: sc }) + rectEl(px(G.xRS - 20), py(W * 0.045), (G.xRE - G.xRS + 40) * s, W * 0.085 * s, { fill: sc })
          : st === 'center' ? rectEl(px(G.xRS - 20), py(-W * 0.1), (G.xRE - G.xRS + 40) * s, W * 0.2 * s, { fill: sc }) : rectEl(px(G.xRS - 20), py(-W * 0.2), (G.xRE - G.xRS + 40) * s, W * 0.12 * s, { fill: sc });
        if (d.roof !== 'glass') gh.push(g({ 'clip-path': url(P, 'proof2'), opacity: 0.95 }, rs2));
      }
      if (d.X.roofRails) [-1, 1].forEach(function (sd) { gh.push(rectEl(px(G.xRS + 120), py(sd * wR * 0.86) - 11 * s, (G.xRE - G.xRS - 200) * s, 22 * s, { fill: d.badge === 'chrome' ? url(P, 'chromeH') : '#0b0b0c' })); });
      if (G.xRE - G.xRS > 500) gh.push(pathEl(roundRectD(px(G.xRE - 300), py(-30), 200 * s, 60 * s, 30 * s), { fill: url(P, 'gblack') }));
      if (d.style === 'pickup') {
        var bx0 = G.xCE + 50, bx1 = L - 70, bwh = T.hwAt(lerp(bx0, bx1, 0.5)) * 0.84;
        gh.push(pathEl(roundRectD(px(bx0), py(-bwh), (bx1 - bx0) * s, bwh * 2 * s, 30 * s), { fill: '#0e0f11', stroke: '#000', 'stroke-width': 1 }));
        var ribs = '';
        for (var rb = 1; rb < 8; rb++) { var ry = py(-bwh + bwh * 2 * rb / 8); ribs += 'M' + P2(px(bx0 + 40), ry) + ' L' + P2(px(bx1 - 40), ry) + ' '; }
        gh.push(pathEl(ribs, { stroke: '#24262a', 'stroke-width': 2 }));
      }
      if (d.style === 'hypercar' || (d.position === 'mid' && d.engType !== 'ev')) {
        var ex0 = G.xCE + 20, ex1 = G.ra + 200, ew = T.hwAt(ex0) * 0.45, lv = '';
        for (var lk = 0; lk < 7; lk++) { var lx = lerp(ex0 + 60, ex1, lk / 6); lv += 'M' + P2(px(lx), py(-ew)) + ' L' + P2(px(lx), py(ew)) + ' '; }
        gh.push(pathEl(roundRectD(px(ex0), py(-ew), (ex1 - ex0 + 60) * s, ew * 2 * s, 40 * s), { fill: '#0b0c0e', opacity: 0.85 }));
        gh.push(pathEl(lv, { stroke: '#2a2c31', 'stroke-width': 2.4 }));
      }
    }
    car.push(g({ class: 'cbr-ghost' }, gh.join('')));
    // lights
    var lt = [];
    [-1, 1].forEach(function (sd) {
      var hx0 = G.X(0.008), hx1 = G.X(0.085);
      lt.push(pathEl(polyD([[px(hx0 + 20), py(sd * T.hwAt(hx0) * 0.98)], [px(hx1), py(sd * T.hwAt(hx1) * 0.99)], [px(hx1 - 30), py(sd * T.hwAt(hx1) * 0.72)], [px(hx0 + 60), py(sd * T.hwAt(hx0) * 0.62)]], true), { fill: url(P, 'lens'), stroke: '#050506', 'stroke-width': 0.7 }));
      if (d.lights !== 'halogen') lt.push(lineEl(px(hx0 + 40), py(sd * T.hwAt(hx0) * 0.92), px(hx1 - 10), py(sd * T.hwAt(hx1) * 0.95), { stroke: '#ffffff', 'stroke-width': 1.4, filter: hi ? url(P, 'glow') : null }));
      var tx0 = G.X(0.95), tx1 = L - 10;
      lt.push(pathEl(polyD([[px(tx0), py(sd * T.hwAt(tx0) * 0.99)], [px(tx1), py(sd * T.hwAt(tx1) * 0.98)], [px(tx1), py(sd * T.hwAt(tx1) * 0.6)], [px(tx0 + 40), py(sd * T.hwAt(tx0) * 0.78)]], true), { fill: url(P, 'tailL'), stroke: '#2a0004', 'stroke-width': 0.6 }));
    });
    if (d.lights !== 'halogen') lt.push(lineEl(px(L - 12), py(-T.hwAt(L) * 0.6), px(L - 12), py(T.hwAt(L) * 0.6), { stroke: '#ff3b30', 'stroke-width': 1.6, filter: hi ? url(P, 'glow') : null }));
    // wing (plan)
    var m = G.wingMount;
    if (m) {
      var span = d.wing === 'active' ? n.W * 0.82 : n.W * 0.92, depth = m.chord * Math.cos(n.wingAng * DEG);
      var carbon = d.style === 'hypercar' || d.wheelMat === 'carbon' || d.splitter === 'carbon' || d.splitter === 'race';
      var wf = carbon ? url(P, 'carbon') : url(P, 'gblack');
      if (d.wing === 'biplane') lt.push(pathEl(roundRectD(px(m.xLe + m.chord * 0.25), py(-span / 2 * 0.94), depth * 0.8 * s, span * 0.94 * s, 20 * s), { fill: wf, opacity: 0.85 }));
      lt.push(pathEl(roundRectD(px(m.xLe), py(-span / 2), depth * s, span * s, 24 * s), { fill: wf, stroke: '#000', 'stroke-width': 0.7 }));
      lt.push(lineEl(px(m.xLe + 6), py(-span / 2 + 20), px(m.xLe + 6), py(span / 2 - 20), { stroke: '#ffffff', 'stroke-opacity': 0.25, 'stroke-width': 0.8 }));
      if (d.wing !== 'active') [-1, 1].forEach(function (sd) { lt.push(rectEl(px(m.xLe - 40), py(sd * span / 2) - (sd > 0 ? 0 : 16 * s), (m.chord + 90) * s, 16 * s, { fill: wf, stroke: '#000', 'stroke-width': 0.5 })); });
    } else if (d.wing === 'ducktail') {
      lt.push(pathEl(roundRectD(px(L - 120), py(-T.hwAt(L - 120) * 0.9), 100 * s, T.hwAt(L - 120) * 1.8 * s, 30 * s), { fill: url(P, 'paintTop'), stroke: shade(c.paint, -0.6), 'stroke-width': 0.8 }));
      lt.push(lineEl(px(L - 30), py(-T.hwAt(L - 30) * 0.85), px(L - 30), py(T.hwAt(L - 30) * 0.85), { stroke: '#ffffff', 'stroke-opacity': 0.35, 'stroke-width': 1 }));
    } else if (d.wing === 'lip-spoiler') {
      var lx = ['hatch', 'wagon', 'box', 'kammback'].indexOf(d.tailStyle) >= 0 ? G.xCE - 40 : L - 70;
      lt.push(rectEl(px(lx), py(-T.hwAt(lx) * 0.75), 50 * s, T.hwAt(lx) * 1.5 * s, { fill: url(P, 'gblack') }));
    }
    // number roundel on the bonnet
    if (d.number || d.stripe === 'le-mans') {
      var nx = lerp(G.X(0.05), G.xA, 0.5), rr = Math.min(260, n.W * 0.14);
      lt.push(circleEl(px(nx), py(n.W * 0.12), rr * s, { fill: '#f6f3ea', stroke: '#111', 'stroke-width': 1 }));
      if (d.number) lt.push(textEl(px(nx), py(n.W * 0.12) + rr * s * 0.36, d.number, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(rr * s * (d.number.length > 2 ? 0.8 : 1.05)), fill: '#111', transform: 'rotate(-90 ' + f(px(nx)) + ' ' + f(py(n.W * 0.12)) + ')' }));
    }
    if (d.badge !== 'delete') lt.push(circleEl(px(G.X(0.03)), py(0), 40 * s, { fill: d.badge === 'black' ? url(P, 'badgeBlack') : url(P, 'chrome'), stroke: '#222', 'stroke-width': 0.4 }));
    car.push(g({ class: 'cbr-ghost' }, lt.join('')));
    out.push(g({ id: P + 'car', class: 'cbr-car' }, car.join('')));
    if (o.xray) out.push(g({ class: 'cbr-xr' }, xrayTop(T, sp, o)));
    var yTop = py(-n.W / 2 - 220), yBot = py(n.W / 2 + 220);
    return { markup: out.join(''), bounds: { x: px(-200), y: yTop, w: (L + 400) * s, h: yBot - yTop }, T: T };
  }

  /* ======================================================================
     X-RAY — engine at its position, turbos, gearbox, shafts per layout, diffs, motors, battery,
     fuel tank, 12 V battery, radiators, exhaust route, springs, cage, ballast, CG and weight split
     ====================================================================== */
  function xrPal(d) {
    var light = d.theme === 'light';
    return {
      line: light ? '#1f6fb2' : XR, soft: light ? '#3b84c4' : XR2, eng: light ? '#c26a10' : XR_ENG, bat: light ? '#0e9a6c' : XR_BAT,
      mot: light ? '#7b4cc4' : XR_MOT, fuel: light ? '#a88400' : XR_FUEL, hot: light ? '#d0432a' : XR_HOT, text: light ? '#123a5c' : '#d9f1ff', bg: light ? '#ffffff' : '#07121c'
    };
  }
  function xLabel(x, y, t, col, anchor, size, bg) {
    var fs = size || 10.5;
    var w = String(t).length * fs * 0.62 + 8;
    var ax = anchor === 'end' ? x - w + 4 : anchor === 'middle' ? x - w / 2 : x - 4;
    return (bg ? pathEl(roundRectD(ax, y - fs * 0.95, w, fs * 1.35, 3), { fill: bg, opacity: 0.78 }) : '') +
      textEl(x, y, t, { 'text-anchor': anchor || 'start', 'font-family': MONO, 'font-size': f2(fs), 'font-weight': 600, 'letter-spacing': '0.04em', fill: col });
  }
  function dimLine(x1, y1, x2, y2, label, col, bg, off) {
    var a = Math.atan2(y2 - y1, x2 - x1), tick = 5, nx = -Math.sin(a) * tick, ny = Math.cos(a) * tick;
    var s = pathEl('M' + P2(x1, y1) + ' L' + P2(x2, y2) + ' M' + P2(x1 + nx, y1 + ny) + ' L' + P2(x1 - nx, y1 - ny) + ' M' + P2(x2 + nx, y2 + ny) + ' L' + P2(x2 - nx, y2 - ny), { stroke: col, 'stroke-width': 0.9, fill: 'none', opacity: 0.85 });
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + (off || -5);
    if (Math.abs(x2 - x1) < Math.abs(y2 - y1)) return s + '<g transform="rotate(-90 ' + f(mx - 6) + ' ' + f(my + 5) + ')">' + xLabel(mx - 6, my + 5, label, col, 'middle', 9.5, bg) + '</g>';
    return s + xLabel(mx, my, label, col, 'middle', 9.5, bg);
  }
  function cgMarker(x, y, r, P, pal, label) {
    var q1 = 'M' + P2(x, y) + ' L' + P2(x + r, y) + ' A' + f2(r) + ' ' + f2(r) + ' 0 0 0 ' + P2(x, y - r) + ' Z';
    var q2 = 'M' + P2(x, y) + ' L' + P2(x - r, y) + ' A' + f2(r) + ' ' + f2(r) + ' 0 0 0 ' + P2(x, y + r) + ' Z';
    return g({ class: 'cbr-xr-pulse' }, circleEl(x, y, r * 2.2, { fill: pal.line, opacity: 0.12 })) +
      circleEl(x, y, r, { fill: '#ffffff', stroke: '#111', 'stroke-width': 1 }) + pathEl(q1 + ' ' + q2, { fill: '#111' }) +
      lineEl(x - r * 2.4, y, x + r * 2.4, y, { stroke: pal.line, 'stroke-width': 0.8 }) + lineEl(x, y - r * 2.4, x, y + r * 2.4, { stroke: pal.line, 'stroke-width': 0.8 }) +
      (label ? xLabel(x + r * 2.6, y - r * 1.3, label, pal.text, 'start', 10, pal.bg) : '');
  }
  function coilD(x, y0, y1, w, turns) {
    var s = 'M' + P2(x, y0), n = turns * 2;
    for (var i = 1; i <= n; i++) s += ' L' + P2(x + (i % 2 ? w : -w), lerp(y0, y1, i / (n + 1)));
    return s + ' L' + P2(x, y1);
  }
  function turbosOf(d) {
    var a = d.aspiration;
    return { turbos: a === 'turbo' || a === 'electric-turbo' || a === 'twincharged' ? 1 : a === 'twin-turbo' ? 2 : a === 'quad-turbo' ? 4 : 0, blower: a === 'supercharged' || a === 'twincharged', eTurbo: a === 'electric-turbo' };
  }
  function motorSplit(d) {
    var m = d.motors;
    if (d.drive === 'fwd') return { f: m, r: 0 };
    if (d.drive === 'rwd') return { f: 0, r: m };
    return { f: m >= 4 ? 2 : 1, r: m >= 4 ? 2 : m - 1 || 1 };
  }
  function diffLabel(id) { return ({ open: 'OPEN', 'lsd-viscous': 'VLSD', 'lsd-clutch': 'LSD', 'lsd-torsen': 'TORSEN', 'e-diff': 'E-DIFF', locking: 'LOCKER', none: '' })[id] || String(id || '').toUpperCase(); }

  function xraySide(G, sp, o) {
    var n = sp.n, d = sp.d, P = o.P, s = G.s, px = G.px, py = G.py, L = G.L, pal = xrPal(d), out = [];
    var st = { fill: 'none', stroke: pal.line, 'stroke-width': 1.1 };
    // ghost body (blueprint) + chassis
    out.push(pathEl(G.shapeBodyD || bodyPathSide(G), { fill: pal.line, 'fill-opacity': 0.04, stroke: pal.line, 'stroke-width': 1.3, 'stroke-opacity': 0.85 }));
    if (G.dlo) out.push(pathEl(G.shapeDloD || smoothD(mmPts(G, G.dlo.pts), true, 0.12), { fill: 'none', stroke: pal.soft, 'stroke-width': 0.8, 'stroke-dasharray': '4 3', opacity: 0.7 }));
    out.push(rectEl(px(G.fa - G.aRF * 0.6), py(G.yb + 120), (G.ra - G.fa + (G.aRF + G.aRR) * 0.6) * s, 75 * s, { fill: 'none', stroke: pal.soft, 'stroke-width': 0.8, 'stroke-dasharray': '6 4', opacity: 0.55 }));
    // wheels, rotors
    [[G.fa, n.tRF, n.rotF], [G.ra, n.tRR, n.rotR]].forEach(function (w) {
      out.push(circleEl(px(w[0]), py(w[1]), w[1] * s, assign({}, st, { 'stroke-dasharray': '5 3' })));
      out.push(circleEl(px(w[0]), py(w[1]), n.rimR * s, assign({}, st, { 'stroke-opacity': 0.6 })));
      out.push(circleEl(px(w[0]), py(w[1]), Math.min(w[2] / 2, n.rimR * 0.9) * s, { fill: 'none', stroke: pal.hot, 'stroke-width': 1.2, opacity: 0.8 }));
      out.push(lineEl(px(w[0]) - 6, py(w[1]), px(w[0]) + 6, py(w[1]), st) + lineEl(px(w[0]), py(w[1]) - 6, px(w[0]), py(w[1]) + 6, st));
    });
    // suspension per axle
    [[G.fa, n.tRF], [G.ra, n.tRR]].forEach(function (w, i) {
      var x = px(w[0] + (i ? -60 : 60)), y0 = py(w[1] + 40), y1 = py(w[1] + 430);
      if (d.susp === 'air') out.push(ellipseEl(x, (y0 + y1) / 2, 18 * s * 3, (y0 - y1) * 0.32, { fill: pal.soft, 'fill-opacity': 0.15, stroke: pal.soft, 'stroke-width': 1 }));
      else if (d.susp === 'pushrod') out.push(pathEl('M' + P2(px(w[0]), py(w[1] - 40)) + ' L' + P2(px(w[0] + (i ? -340 : 340)), py(w[1] + 330)) + ' L' + P2(px(w[0] + (i ? -540 : 540)), py(w[1] + 300)), { fill: 'none', stroke: pal.soft, 'stroke-width': 1.3 }) + pathEl(coilD(px(w[0] + (i ? -440 : 440)), py(w[1] + 320), py(w[1] + 200), 4, 4), { fill: 'none', stroke: pal.soft, 'stroke-width': 1 }));
      else out.push(pathEl(coilD(x, y0, y1, d.susp === 'macpherson' ? 5 : 6, d.susp === 'coilover-track' ? 7 : 5), { fill: 'none', stroke: pal.soft, 'stroke-width': 1.1 }) + lineEl(x, y1, x, y1 - 14, { stroke: pal.soft, 'stroke-width': 2.2 }));
    });
    var labels = [];
    var floorY = G.yb + 90;
    var gbx0 = 0, gbx1 = 0, engX0 = 0, engX1 = 0;
    // engine
    if (d.engType !== 'ev') {
      var len = n.engLen * (d.drive === 'fwd' && d.config === 'inline' && d.position === 'front' ? 0.62 : 1);
      var eh = d.config === 'flat' ? 420 : d.config === 'rotary' ? 380 : d.config === 'inline' ? 600 : 560;
      if (d.position === 'mid') { engX1 = G.ra - G.aRR * 0.2 - 160; engX0 = engX1 - len; }
      else if (d.position === 'rear') { engX0 = G.ra - len * 0.15; engX1 = engX0 + len; }
      else { engX0 = G.fa - len * 0.18; engX1 = engX0 + len; }
      var ey0 = floorY + 40, ey1 = ey0 + eh;
      out.push(pathEl(roundRectD(px(engX0), py(ey1), len * s, eh * s, 40 * s), { fill: url(P, 'xeng'), stroke: pal.eng, 'stroke-width': 1.4 }));
      var rows = d.config === 'inline' ? 1 : d.config === 'w' ? 4 : d.config === 'rotary' ? 0 : 2;
      if (rows) {
        var perRow = Math.ceil(d.cyl / rows), cyls = '';
        for (var r = 0; r < Math.min(rows, 2); r++) {
          for (var k = 0; k < perRow; k++) {
            var cx = engX0 + len * (k + 0.5 + (r ? 0.18 : 0)) / (perRow + 0.2), cyc = ey0 + eh * (d.config === 'flat' ? 0.5 : r ? 0.62 : 0.5);
            var cw = len / (perRow + 0.6) * 0.62, chh = eh * (d.config === 'flat' ? 0.34 : 0.4);
            cyls += roundRectD(px(cx - cw / 2), py(cyc + chh / 2), cw * s, chh * s, cw * s * 0.2) + ' ';
            cyls += circleD(px(cx), py(cyc - chh / 2 - eh * 0.08), Math.max(1, cw * s * 0.22)) + ' ';
          }
        }
        out.push(pathEl(cyls, { fill: pal.eng, 'fill-opacity': 0.28, stroke: pal.eng, 'stroke-width': 0.8 }));
        out.push(lineEl(px(engX0 + 30), py(ey0 + eh * 0.16), px(engX1 - 30), py(ey0 + eh * 0.16), { stroke: pal.eng, 'stroke-width': 2, opacity: 0.8 }));
      } else {
        for (var rk = 0; rk < Math.max(1, d.rotors); rk++) {
          var rcx = px(lerp(engX0, engX1, (rk + 0.5) / Math.max(1, d.rotors))), rcy = py(ey0 + eh / 2), rrad = eh * 0.3 * s, tri = [];
          for (var t = 0; t < 3; t++) tri.push(polar(rcx, rcy, rrad, -PI / 2 + t * TAU / 3 + rk * 0.5));
          out.push(pathEl('M' + P2(tri[0][0], tri[0][1]) + ' Q' + P2(polar(rcx, rcy, rrad * 0.7, -PI / 2 + PI / 3 + rk * 0.5)[0], polar(rcx, rcy, rrad * 0.7, -PI / 2 + PI / 3 + rk * 0.5)[1]) + ' ' + P2(tri[1][0], tri[1][1]) +
            ' Q' + P2(polar(rcx, rcy, rrad * 0.7, PI / 2 + rk * 0.5)[0], polar(rcx, rcy, rrad * 0.7, PI / 2 + rk * 0.5)[1]) + ' ' + P2(tri[2][0], tri[2][1]) +
            ' Q' + P2(polar(rcx, rcy, rrad * 0.7, -PI / 2 - PI / 3 + rk * 0.5)[0], polar(rcx, rcy, rrad * 0.7, -PI / 2 - PI / 3 + rk * 0.5)[1]) + ' ' + P2(tri[0][0], tri[0][1]) + ' Z', { fill: pal.eng, 'fill-opacity': 0.3, stroke: pal.eng, 'stroke-width': 1 }));
        }
      }
      var tb = turbosOf(d);
      for (var ti = 0; ti < tb.turbos; ti++) {
        var tx = px(d.position === 'front' ? engX1 - 120 - ti * 150 : engX0 + 120 + ti * 150), ty = py(ey0 + eh * (ti % 2 ? 0.3 : 0.55)), tr = 62 * s;
        out.push(circleEl(tx, ty, tr, { fill: pal.hot, 'fill-opacity': 0.25, stroke: pal.hot, 'stroke-width': 1.2 }));
        out.push(pathEl('M' + P2(tx, ty) + ' m' + f(tr * 0.2) + ' 0 a' + f2(tr * 0.2) + ' ' + f2(tr * 0.2) + ' 0 1 1 ' + f(-tr * 0.4) + ' 0 a' + f2(tr * 0.45) + ' ' + f2(tr * 0.45) + ' 0 1 1 ' + f(tr * 0.85) + ' 0', { fill: 'none', stroke: pal.hot, 'stroke-width': 0.8 }));
        if (tb.eTurbo) out.push(circleEl(tx, ty, tr * 0.3, { fill: pal.mot, opacity: 0.9 }));
      }
      if (tb.blower) {
        out.push(pathEl(roundRectD(px(engX0 + len * 0.2), py(ey1 + 120), len * 0.55 * s, 130 * s, 20 * s), { fill: pal.hot, 'fill-opacity': 0.2, stroke: pal.hot, 'stroke-width': 1.1 }));
        out.push(circleEl(px(d.position === 'front' ? engX0 + len * 0.15 : engX1 - len * 0.15), py(ey1 + 60), 50 * s, { fill: 'none', stroke: pal.hot, 'stroke-width': 1.1 }));
      }
      labels.push([px((engX0 + engX1) / 2), py(ey1) - 8, d.layout + ' ' + n.disp.toFixed(1) + ' L ' + String(d.aspiration).toUpperCase() + (n.hp ? ' · ' + Math.round(n.hp) + ' HP' : ''), pal.eng]);
      // gearbox
      if (d.position === 'front') { gbx0 = d.drive === 'fwd' ? engX1 - 40 : engX1; gbx1 = gbx0 + (d.drive === 'fwd' ? 260 : 520); }
      else if (d.position === 'mid') { gbx0 = engX1; gbx1 = Math.max(engX1 + 380, G.ra + 220); }
      else { gbx1 = engX0; gbx0 = Math.min(engX0 - 420, G.ra - 380); }
      var gh = d.trans === 'cvt' || d.trans === 'single-speed' ? 240 : 300;
      out.push(pathEl(polyD([[px(gbx0), py(ey0 + 40 + gh)], [px(gbx1), py(ey0 + 40 + gh * 0.7)], [px(gbx1), py(ey0 + 40)], [px(gbx0), py(ey0 + 20)]], true), { fill: pal.soft, 'fill-opacity': 0.12, stroke: pal.soft, 'stroke-width': 1.1 }));
      labels.push([px((gbx0 + gbx1) / 2), py(ey0 - 20) + 14, (d.gears > 1 ? d.gears + '-SPD ' : '') + String(d.trans).toUpperCase(), pal.soft]);
      // hybrid e-motor + pack
      if (d.engType === 'hybrid') {
        var hm = d.position === 'front' ? engX1 : engX0;
        out.push(rectEl(px(hm - 50), py(ey0 + 380), 100 * s, 360 * s, { fill: pal.mot, 'fill-opacity': 0.3, stroke: pal.mot, 'stroke-width': 1.1 }));
        var hpx0 = G.ra - G.aRR - 620;
        out.push(pathEl(roundRectD(px(hpx0), py(floorY + 260), 520 * s, 200 * s, 20 * s), { fill: url(P, 'xbat'), stroke: pal.bat, 'stroke-width': 1.2 }));
        labels.push([px(hpx0 + 260), py(floorY + 260) - 6, n.kwh.toFixed(1) + ' kWh', pal.bat]);
      }
      // exhaust route, cat & muffler
      if (d.tipStyle !== 'none') {
        var exStart = d.position === 'front' ? engX0 + len * 0.6 : engX0 + len * 0.3;
        var exD = 'M' + P2(px(exStart), py(ey0 + eh * 0.4)) + ' C' + P2(px(exStart + 200), py(floorY - 20)) + ' ' + P2(px(exStart + 400), py(floorY - 40)) + ' ' + P2(px(Math.min(L - 500, exStart + 700)), py(floorY - 40)) + ' L' + P2(px(L - 60), py(G.yb + 72));
        out.push(pathEl(exD, { fill: 'none', stroke: pal.hot, 'stroke-width': 1.6, 'stroke-dasharray': d.exhaust === 'straight-pipe' ? '0' : '7 3', opacity: 0.85 }));
        if (d.exhaust !== 'straight-pipe') {
          out.push(pathEl(roundRectD(px(L - 700), py(floorY + 30), 360 * s, 120 * s, 40 * s), { fill: pal.hot, 'fill-opacity': 0.14, stroke: pal.hot, 'stroke-width': 1 }));
          out.push(pathEl(roundRectD(px(Math.min(L - 900, exStart + 260)), py(floorY + 10), 200 * s, 90 * s, 30 * s), { fill: pal.hot, 'fill-opacity': 0.14, stroke: pal.hot, 'stroke-width': 1 }));
        }
      }
      // fuel tank
      var tankW = clamp(n.tank * 9, 380, 900);
      var tankX = d.position === 'mid' ? G.fa + G.aRF + 120 : G.ra - G.aRR - tankW - 60;
      out.push(pathEl(roundRectD(px(tankX), py(floorY + 230), tankW * s, 200 * s, 50 * s), { fill: pal.fuel, 'fill-opacity': 0.14, stroke: pal.fuel, 'stroke-width': 1.1, 'stroke-dasharray': '5 3' }));
      labels.push([px(tankX + tankW / 2), py(floorY + 120) + 4, Math.round(n.tank) + ' L ' + String(d.fuel).toUpperCase(), pal.fuel]);
    } else {
      // EV: motors at the axles + floor battery
      var ms = motorSplit(d);
      [[G.fa, n.tRF, ms.f], [G.ra, n.tRR, ms.r]].forEach(function (w) {
        for (var mi = 0; mi < w[2]; mi++) {
          var mx = px(w[0] + (mi ? 90 : 0)), my = py(w[1] + (mi ? 30 : 0)), mw = 340 * s, mh = 250 * s;
          out.push(pathEl(roundRectD(mx - mw / 2, my - mh / 2, mw, mh, mh * 0.45), { fill: pal.mot, 'fill-opacity': mi ? 0.12 : 0.28, stroke: pal.mot, 'stroke-width': 1.2 }));
          var wl = '';
          for (var wk = 1; wk < 6; wk++) wl += 'M' + P2(mx - mw / 2 + mw * wk / 6, my - mh * 0.38) + ' L' + P2(mx - mw / 2 + mw * wk / 6, my + mh * 0.38) + ' ';
          out.push(pathEl(wl, { stroke: pal.mot, 'stroke-width': 0.7, opacity: 0.7 }));
        }
        if (w[2]) labels.push([px(w[0]), py(w[1] + 240), w[2] + ' × ' + Math.round(n.motorKw) + ' kW', pal.mot]);
      });
      var bx0 = G.fa + G.aRF * 0.85, bx1 = G.ra - G.aRR * 0.85, bth = clamp(90 + n.kwh * 0.55, 100, 210);
      out.push(pathEl(roundRectD(px(bx0), py(G.yb + 40 + bth), (bx1 - bx0) * s, bth * s, 14 * s), { fill: url(P, 'xbat'), stroke: pal.bat, 'stroke-width': 1.3 }));
      var mods = Math.max(4, Math.min(30, Math.round(n.kwh / 7))), ml = '';
      for (var mk = 1; mk < mods; mk++) { var mxk = px(lerp(bx0, bx1, mk / mods)); ml += 'M' + P2(mxk, py(G.yb + 40 + bth - 12)) + ' L' + P2(mxk, py(G.yb + 52)) + ' '; }
      out.push(pathEl(ml, { stroke: pal.bat, 'stroke-width': 0.7, opacity: 0.7 }));
      labels.push([px((bx0 + bx1) / 2), py(G.yb + 40 + bth) - 7, Math.round(n.kwh) + ' kWh ' + String(d.chem).toUpperCase() + ' · ' + Math.round(d.voltage) + ' V', pal.bat]);
      gbx0 = G.fa; gbx1 = G.ra;
    }
    // driveshafts & diffs
    var shY = py(G.yb + 150), shaft = { stroke: pal.line, 'stroke-width': 2.4, 'stroke-linecap': 'round' };
    if (d.engType !== 'ev') {
      if (d.position === 'front' && d.drive !== 'fwd') out.push(lineEl(px(gbx1), shY, px(G.ra), py(n.tRR), shaft));
      if (d.drive === 'awd' && d.position === 'front') out.push(lineEl(px(gbx0 + 60), shY, px(G.fa), py(n.tRF), shaft));
      if (d.drive === 'awd' && d.position !== 'front') out.push(lineEl(px(Math.min(gbx0, engX0)), shY, px(G.fa), py(n.tRF), shaft));
      if (d.drive === 'awd') out.push(pathEl(roundRectD(px((d.position === 'front' ? gbx1 : engX0) - 70), shY - 30 * s, 140 * s, 60 * s, 10 * s), { fill: pal.line, 'fill-opacity': 0.2, stroke: pal.line, 'stroke-width': 1 }) + xLabel(px((d.position === 'front' ? gbx1 : engX0)), shY + 22, 'CENTRE ' + diffLabel(d.centerDiff === 'none' ? 'open' : d.centerDiff), pal.text, 'middle', 9, pal.bg));
    }
    var fDriven = d.drive !== 'rwd', rDriven = d.drive !== 'fwd';
    [[G.fa, n.tRF, fDriven, d.frontDiff], [G.ra, n.tRR, rDriven, d.rearDiff]].forEach(function (w) {
      if (!w[2]) return;
      out.push(circleEl(px(w[0]), py(w[1]), 95 * s, { fill: pal.line, 'fill-opacity': 0.18, stroke: pal.line, 'stroke-width': 1.3 }));
      if (d.engType !== 'ev') labels.push([px(w[0]), py(w[1]) + 95 * s + 13, diffLabel(w[3]) + (d.tv ? ' + TV' : ''), pal.line]);
    });
    // 12V battery & radiators
    var b12x = d.position === 'front' && d.engType !== 'ev' ? G.fa + G.aRF * 0.2 : G.L - 600;
    out.push(rectEl(px(b12x), py(G.yb + 520), 240 * s, 170 * s, { fill: d.battery12 === 'lithium' ? pal.bat : pal.soft, 'fill-opacity': 0.25, stroke: d.battery12 === 'lithium' ? pal.bat : pal.soft, 'stroke-width': 1 }));
    labels.push([px(b12x + 120), py(G.yb + 520) - 6, d.battery12 === 'lithium' ? '12V LI' : '12V', pal.soft]);
    var radH = d.cooling === 'race' ? 520 : d.cooling === 'uprated' ? 460 : 400;
    var radX = G.fm && G.SX ? G.SX(G.fm.dims.xFront - 0.25) - 25 * s : px(G.X(0.03) + 30);
    if (G.fm && G.prof && G.mm) radH = Math.max(150, Math.min(radH, G.prof(G.mm(G.fm.dims.xFront - 0.25)) - G.yb - 160));
    out.push(rectEl(radX, py(G.yb + 90 + radH), 50 * s, radH * s, { fill: pal.line, 'fill-opacity': 0.2, stroke: pal.line, 'stroke-width': 1 }));
    if (d.cooling === 'race') out.push(rectEl(px(G.ra - G.aRR - 300), py(G.yBelt - 40), 60 * s, 320 * s, { fill: pal.line, 'fill-opacity': 0.2, stroke: pal.line, 'stroke-width': 1 }));
    // seats, cage, ballast
    var hipX = G.dlo ? lerp(G.dlo.xFront, G.dlo.xRear, d.seats <= 2 || !d.rearSeats ? 0.55 : 0.42) : lerp(G.xA, G.xCE, 0.55);
    var seat = function (x, k) {
      return pathEl('M' + P2(px(x - 320), py(G.yb + 260)) + ' L' + P2(px(x + 60), py(G.yb + 260)) + ' L' + P2(px(x + 120), py(G.yb + 760 * k)) + ' Q' + P2(px(x + 130), py(G.yb + 860 * k)) + ' ' + P2(px(x + 40), py(G.yb + 850 * k)) + ' L' + P2(px(x - 20), py(G.yb + 330)) + ' L' + P2(px(x - 320), py(G.yb + 330)) + ' Z', { fill: pal.soft, 'fill-opacity': 0.1, stroke: pal.soft, 'stroke-width': 0.9 });
    };
    out.push(seat(hipX, 1));
    if (d.seats > 2 && d.rearSeats && G.dlo) out.push(seat(lerp(G.dlo.xFront, G.dlo.xRear, 0.82), 0.92));
    if (d.rollCage !== 'none' && G.dlo) {
      var cg = 'M' + P2(px(hipX + 160), py(G.yb + 250)) + ' L' + P2(px(hipX + 130), py(G.yRoof - 70)) + ' L' + P2(px(G.dlo.xRear + 200), py(G.yb + 300));
      if (d.rollCage === 'full') cg += ' M' + P2(px(G.dlo.xFront), py(G.yBelt)) + ' L' + P2(px(G.xRS + 60), py(G.yRoof - 70)) + ' L' + P2(px(hipX + 130), py(G.yRoof - 70)) + ' M' + P2(px(G.dlo.xFront), py(G.yb + 300)) + ' L' + P2(px(hipX + 150), py(G.yBelt - 100));
      out.push(pathEl(cg, { fill: 'none', stroke: pal.hot, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
    }
    if (n.ballast > 0) {
      var blx = d.ballastPos === 'front' ? G.fa - 150 : d.ballastPos === 'rear' ? G.ra + 180 : (G.fa + G.ra) / 2;
      out.push(rectEl(px(blx - 120), py(G.yb + 200), 240 * s, 110 * s, { fill: '#b7bcc2', 'fill-opacity': 0.35, stroke: '#b7bcc2', 'stroke-width': 1 }));
      labels.push([px(blx), py(G.yb + 200) - 5, Math.round(n.ballast) + ' KG', '#b7bcc2']);
    }
    // CG + weight distribution
    var cgx = G.fa + n.wb * (1 - n.wf / 100);
    out.push(lineEl(px(cgx), py(n.cgH), px(cgx), GROUND, { stroke: pal.line, 'stroke-width': 0.8, 'stroke-dasharray': '3 3' }));
    out.push(cgMarker(px(cgx), py(n.cgH), 7, P, pal, 'CG ' + Math.round(n.cgH) + ' mm'));
    var by = GROUND + 22, wf = n.wf / 100;
    out.push(rectEl(px(G.fa), by - 4, (G.ra - G.fa) * s, 8, { fill: pal.line, opacity: 0.18, rx: 4 }));
    out.push(rectEl(px(G.fa), by - 4, (G.ra - G.fa) * s * (1 - wf), 8, { fill: pal.line, opacity: 0.75, rx: 4 }));
    out.push(xLabel(px(G.fa) - 8, by + 4, 'F ' + n.wf.toFixed(1) + '%  ' + Math.round(n.mass * wf) + ' kg', pal.text, 'end', 10, pal.bg));
    out.push(xLabel(px(G.ra) + 8, by + 4, 'R ' + (100 - n.wf).toFixed(1) + '%  ' + Math.round(n.mass * (1 - wf)) + ' kg', pal.text, 'start', 10, pal.bg));
    [[G.fa, wf], [G.ra, 1 - wf]].forEach(function (w) {
      var ax = px(w[0]), len2 = 10 + w[1] * 30;
      out.push(pathEl('M' + P2(ax, GROUND - len2 - 4) + ' L' + P2(ax, GROUND - 4) + ' M' + P2(ax - 4, GROUND - 9) + ' L' + P2(ax, GROUND - 3) + ' L' + P2(ax + 4, GROUND - 9), { stroke: pal.line, 'stroke-width': 1.3, fill: 'none' }));
    });
    // dimensions
    var dimY = py(G.topMm + 70);
    out.push(dimLine(px(0), dimY, px(L), dimY, Math.round(n.buildLen) + ' mm', pal.line, pal.bg));
    out.push(dimLine(px(G.fa), GROUND + 44, px(G.ra), GROUND + 44, 'WB ' + Math.round(n.wb) + ' mm', pal.line, pal.bg, 4));
    out.push(dimLine(px(L) + 34, GROUND, px(L) + 34, py(G.topMm > G.yRoof + 200 ? G.yRoof : G.topMm), Math.round(G.yRoof) + ' mm', pal.line, pal.bg));
    var midX = px(lerp(G.fa, G.ra, 0.62));
    out.push(dimLine(midX, GROUND, midX, py(G.yb), Math.round(n.ride) + '', pal.soft, null));
    labels.forEach(function (l) { out.push(xLabel(l[0], l[1], l[2], l[3], 'middle', 9.5, pal.bg)); });
    return out.join('');
  }

  function xrayTop(T, sp, o) {
    var G = T.G, n = sp.n, d = sp.d, P = o.P, s = T.s, px = T.px, py = T.py, L = T.L, pal = xrPal(d), out = [], labels = [];
    out.push(pathEl(T.shapeBodyD || planOutline(T), { fill: pal.line, 'fill-opacity': 0.04, stroke: pal.line, 'stroke-width': 1.3 }));
    // axles & tyres
    [[G.fa, n.tRF, n.twF], [G.ra, n.tRR, n.twR]].forEach(function (w) {
      [-1, 1].forEach(function (sd) { out.push(pathEl(roundRectD(px(w[0] - w[1]), py(sd * n.track / 2 - w[2] / 2), w[1] * 2 * s, w[2] * s, 6), { fill: 'none', stroke: pal.line, 'stroke-width': 1, 'stroke-dasharray': '4 3' })); });
    });
    var fDriven = d.drive !== 'rwd', rDriven = d.drive !== 'fwd';
    [[G.fa, fDriven], [G.ra, rDriven]].forEach(function (w) {
      out.push(lineEl(px(w[0]), py(-n.track / 2), px(w[0]), py(n.track / 2), { stroke: pal.line, 'stroke-width': w[1] ? 2.4 : 0.8, 'stroke-dasharray': w[1] ? null : '3 3', opacity: w[1] ? 1 : 0.6 }));
      if (w[1]) out.push(circleEl(px(w[0]), py(0), 95 * s, { fill: pal.line, 'fill-opacity': 0.2, stroke: pal.line, 'stroke-width': 1.2 }));
    });
    var engX0 = 0, engX1 = 0;
    if (d.engType !== 'ev') {
      var len = n.engLen, wE = d.config === 'inline' ? 520 : d.config === 'flat' ? 820 : d.config === 'w' ? 860 : d.config === 'rotary' ? 560 : 720;
      var transverse = d.drive === 'fwd' && d.config === 'inline' && d.position === 'front';
      if (d.position === 'mid') { engX1 = G.ra - G.aRR * 0.2 - 160; engX0 = engX1 - len; }
      else if (d.position === 'rear') { engX0 = G.ra - len * 0.15; engX1 = engX0 + len; }
      else { engX0 = G.fa - len * 0.18; engX1 = engX0 + len; }
      var ex = engX0, ew = transverse ? len : wE, el2 = transverse ? wE : len;
      if (transverse) { ex = G.fa - 120; engX1 = ex + el2; }
      out.push(pathEl(roundRectD(px(ex), py(-ew / 2), el2 * s, ew * s, 30 * s), { fill: url(P, 'xeng'), stroke: pal.eng, 'stroke-width': 1.4 }));
      var rows = d.config === 'inline' ? 1 : d.config === 'w' ? 4 : d.config === 'rotary' ? 0 : 2, per = rows ? Math.ceil(d.cyl / rows) : 0, cyl = '';
      for (var r = 0; r < rows; r++) for (var k = 0; k < per; k++) {
        var along = (k + 0.5 + (r % 2 ? 0.2 : 0)) / (per + 0.2);
        var lat = rows === 1 ? 0 : lerp(-0.3, 0.3, r / (rows - 1));
        var cx = transverse ? px(ex + el2 / 2 + lat * el2) : px(ex + el2 * along), cy = transverse ? py(-ew / 2 + ew * along) : py(lat * ew);
        cyl += circleD(cx, cy, Math.max(1.2, Math.min(el2, ew) / (per + 1) * 0.36 * s)) + ' ';
      }
      if (cyl) out.push(pathEl(cyl, { fill: pal.eng, 'fill-opacity': 0.3, stroke: pal.eng, 'stroke-width': 0.8 }));
      var tb = turbosOf(d);
      for (var ti = 0; ti < tb.turbos; ti++) out.push(circleEl(px(ex + el2 * (0.25 + 0.5 * (ti % 2))), py((ti < 2 ? -1 : 1) * (ew / 2 + 70) * (tb.turbos === 1 ? 1 : ti % 2 ? -1 : 1)), 60 * s, { fill: pal.hot, 'fill-opacity': 0.25, stroke: pal.hot, 'stroke-width': 1.1 }));
      labels.push([px(ex + el2 / 2), py(-ew / 2) - 6, d.layout + (transverse ? ' TRANSVERSE' : ''), pal.eng]);
      // gearbox + shafts
      var gx0 = transverse ? ex : d.position === 'front' ? engX1 : d.position === 'mid' ? engX1 : G.ra - 380, gx1 = transverse ? ex + el2 : d.position === 'front' ? engX1 + 520 : d.position === 'mid' ? Math.max(engX1 + 380, G.ra + 220) : engX0;
      if (!transverse) out.push(pathEl(polyD([[px(gx0), py(-150)], [px(gx1), py(-100)], [px(gx1), py(100)], [px(gx0), py(150)]], true), { fill: pal.soft, 'fill-opacity': 0.12, stroke: pal.soft, 'stroke-width': 1 }));
      if (d.position === 'front' && d.drive !== 'fwd') out.push(lineEl(px(gx1), py(0), px(G.ra), py(0), { stroke: pal.line, 'stroke-width': 2.4 }));
      if (d.drive === 'awd' && d.position !== 'front') out.push(lineEl(px(engX0), py(0), px(G.fa), py(0), { stroke: pal.line, 'stroke-width': 2.4 }));
      // fuel tank
      var tankW = clamp(n.tank * 9, 380, 900), tankX = d.position === 'mid' ? G.fa + G.aRF + 120 : G.ra - G.aRR - tankW - 60;
      out.push(pathEl(roundRectD(px(tankX), py(-n.W * 0.28), tankW * s, n.W * 0.56 * s, 50 * s), { fill: pal.fuel, 'fill-opacity': 0.12, stroke: pal.fuel, 'stroke-width': 1, 'stroke-dasharray': '5 3' }));
      if (d.engType === 'hybrid') out.push(pathEl(roundRectD(px(G.ra - G.aRR - 620), py(-n.W * 0.3), 520 * s, n.W * 0.6 * s, 20 * s), { fill: url(P, 'xbat'), stroke: pal.bat, 'stroke-width': 1.1 }));
    } else {
      var ms = motorSplit(d);
      [[G.fa, ms.f], [G.ra, ms.r]].forEach(function (w) {
        for (var mi = 0; mi < w[1]; mi++) {
          var y = w[1] === 1 ? 0 : (mi ? 1 : -1) * 220;
          out.push(pathEl(roundRectD(px(w[0] - 170), py(y - 150), 340 * s, 300 * s, 60 * s), { fill: pal.mot, 'fill-opacity': 0.28, stroke: pal.mot, 'stroke-width': 1.2 }));
        }
      });
      var bx0 = G.fa + G.aRF * 0.85, bx1 = G.ra - G.aRR * 0.85, bw = n.W * 0.78;
      out.push(pathEl(roundRectD(px(bx0), py(-bw / 2), (bx1 - bx0) * s, bw * s, 30 * s), { fill: url(P, 'xbat'), stroke: pal.bat, 'stroke-width': 1.3 }));
      var mods = Math.max(4, Math.min(24, Math.round(n.kwh / 8))), grid = '';
      for (var mk = 1; mk < mods; mk++) { var gx = px(lerp(bx0, bx1, mk / mods)); grid += 'M' + P2(gx, py(-bw / 2 + 20)) + ' L' + P2(gx, py(bw / 2 - 20)) + ' '; }
      grid += 'M' + P2(px(bx0 + 20), py(0)) + ' L' + P2(px(bx1 - 20), py(0));
      out.push(pathEl(grid, { stroke: pal.bat, 'stroke-width': 0.7, opacity: 0.7 }));
      labels.push([px((bx0 + bx1) / 2), py(-bw / 2) - 6, Math.round(n.kwh) + ' kWh', pal.bat]);
    }
    var cgx = G.fa + n.wb * (1 - n.wf / 100);
    out.push(cgMarker(px(cgx), py(0), 7, P, pal, 'CG'));
    out.push(xLabel(px(G.fa), py(n.track / 2 + 250), 'F ' + n.wf.toFixed(1) + '%', pal.text, 'middle', 10, pal.bg));
    out.push(xLabel(px(G.ra), py(n.track / 2 + 250), 'R ' + (100 - n.wf).toFixed(1) + '%', pal.text, 'middle', 10, pal.bg));
    out.push(dimLine(px(-120), py(-n.track / 2), px(-120), py(n.track / 2), 'TRACK ' + Math.round(n.track), pal.line, pal.bg));
    out.push(dimLine(px(G.fa), py(-n.W / 2 - 150), px(G.ra), py(-n.W / 2 - 150), 'WB ' + Math.round(n.wb) + ' mm', pal.line, pal.bg));
    labels.forEach(function (l) { out.push(xLabel(l[0], l[1], l[2], l[3], 'middle', 9.5, pal.bg)); });
    return out.join('');
  }

  function xrayCross(C, sp, o, rear) {
    var n = sp.n, d = sp.d, P = o.P, s = C.s, px = C.px, py = C.py, pal = xrPal(d), out = [], hw = C.hw;
    out.push(pathEl(C.shapeBodyD || crossOutline(C, rear), { fill: pal.line, 'fill-opacity': 0.04, stroke: pal.line, 'stroke-width': 1.3 }));
    var tR = rear ? n.tRR : n.tRF, tw = rear ? n.twR : n.twF, cam = rear ? n.camR : n.camF;
    [-1, 1].forEach(function (sd) {
      out.push(pathEl(roundRectD(px(sd * n.track / 2 - tw / 2), py(tR * 2), tw * s, tR * 2 * s, 8), { fill: 'none', stroke: pal.line, 'stroke-width': 1, 'stroke-dasharray': '4 3', transform: 'rotate(' + f2(sd < 0 ? -cam : cam) + ' ' + f(px(sd * n.track / 2)) + ' ' + f(py(0)) + ')' }));
      out.push(xLabel(px(sd * n.track / 2), py(tR * 2) - 8, (cam > 0 ? '+' : '') + cam.toFixed(1) + '°', pal.text, 'middle', 9.5, pal.bg));
      // wishbones / struts to the hubs
      out.push(pathEl('M' + P2(px(sd * n.track / 2), py(tR)) + ' L' + P2(px(sd * hw * 0.35), py(tR - 40)) + ' M' + P2(px(sd * (n.track / 2 - 40)), py(tR + 220)) + ' L' + P2(px(sd * hw * 0.4), py(tR + 160)), { stroke: pal.soft, 'stroke-width': 1.1, fill: 'none' }));
    });
    var driven = rear ? d.drive !== 'fwd' : d.drive !== 'rwd';
    var axleHasEngine = d.engType !== 'ev' && ((d.position === 'front') !== !!rear);
    if (driven) out.push(lineEl(px(-n.track / 2 + tw / 2), py(tR), px(n.track / 2 - tw / 2), py(tR), { stroke: pal.line, 'stroke-width': 2.4 }));
    if (axleHasEngine) {
      var base = C.yb + 140, ew = d.config === 'flat' ? 820 : d.config === 'inline' ? 420 : d.config === 'rotary' ? 520 : 700, eh = d.config === 'flat' ? 380 : 560;
      if (d.config === 'v' || d.config === 'w') {
        var ba = (d.bank || 90) * DEG / 2, lb = eh;
        var v = 'M' + P2(px(-90), py(base)) + ' L' + P2(px(90), py(base)) + ' L' + P2(px(90 + Math.sin(ba) * lb), py(base + Math.cos(ba) * lb)) + ' L' + P2(px(Math.sin(ba) * lb - 150), py(base + Math.cos(ba) * lb + 30)) +
          ' L' + P2(px(0), py(base + 170)) + ' L' + P2(px(-Math.sin(ba) * lb + 150), py(base + Math.cos(ba) * lb + 30)) + ' L' + P2(px(-90 - Math.sin(ba) * lb), py(base + Math.cos(ba) * lb)) + ' Z';
        out.push(pathEl(v, { fill: url(P, 'xeng'), stroke: pal.eng, 'stroke-width': 1.4 }));
      } else {
        out.push(pathEl(roundRectD(px(-ew / 2), py(base + eh), ew * s, eh * s, 30 * s), { fill: url(P, 'xeng'), stroke: pal.eng, 'stroke-width': 1.4 }));
      }
      out.push(xLabel(px(0), py(base + eh + 40), d.layout + ' ' + n.disp.toFixed(1) + ' L', pal.eng, 'middle', 10, pal.bg));
    }
    if (d.engType === 'ev') {
      var bth = clamp(90 + n.kwh * 0.55, 100, 210);
      out.push(pathEl(roundRectD(px(-hw * 0.8), py(C.yb + 40 + bth), hw * 1.6 * s, bth * s, 10 * s), { fill: url(P, 'xbat'), stroke: pal.bat, 'stroke-width': 1.2 }));
      var ms = motorSplit(d), cnt = rear ? ms.r : ms.f;
      for (var mi = 0; mi < cnt; mi++) out.push(circleEl(px(cnt === 1 ? 0 : (mi ? 1 : -1) * 220), py(tR), 140 * s, { fill: pal.mot, 'fill-opacity': 0.28, stroke: pal.mot, 'stroke-width': 1.2 }));
    }
    out.push(cgMarker(px(0), py(n.cgH), 7, P, pal, 'CG ' + Math.round(n.cgH) + ' mm'));
    out.push(dimLine(px(-n.track / 2), GROUND + 24, px(n.track / 2), GROUND + 24, 'TRACK ' + Math.round(n.track) + ' mm', pal.line, pal.bg, 4));
    out.push(dimLine(px(-hw), py(C.yRoof + 120), px(hw), py(C.yRoof + 120), 'W ' + Math.round(n.buildW) + ' mm', pal.line, pal.bg));
    out.push(dimLine(px(0) + 40, GROUND, px(0) + 40, py(C.yb), Math.round(n.ride) + '', pal.soft, null));
    return out.join('');
  }

  /* ======================================================================
     REAL MANUFACTURER SHAPES (CB.shapes, js/shapes/README.md)
       The fitted model (S.fit(model, build)) replaces the procedural silhouette in all four views.
       A derived spec (n.L0, fo, wb, H, W, tyre radii from the fitted dims) feeds the existing
       geometry helpers, so wheels, aero options, stripes, wings and the x-ray overlay land on the
       real car. Nose to the left in side/top (as the procedural views), front view mirrored.
       Any failure (no CB.shapes, unknown model, bad data) falls back to the procedural drawing.
     ====================================================================== */
  function SHP() {
    var S = CB.shapes;
    return S && typeof S.getModel === 'function' && typeof S.fit === 'function' && typeof S.toSvgPath === 'function' && typeof S.items === 'function' ? S : null;
  }
  function shapeModelFor(styleId, modelId) {
    var S = SHP();
    if (!S) return null;
    try { return S.getModel({ body: { style: styleId, model: modelId } }, { strict: true }) || null; } catch (e) { return null; }
  }
  var fitCache = [];
  /** fitted model for a (possibly tweened) spec, cached on the geometry fields only */
  function fittedFor(sp) {
    var S = SHP(), d = sp && sp.d, n = sp && sp.n;
    if (!S || !d || !d.model || !S.models || !S.models[d.model]) return null;
    var nums = [n.wb, n.track, n.ride, n.rimR, n.twF, n.twR, n.prF, n.prR];
    for (var i = 0; i < nums.length; i++) if (typeof nums[i] !== 'number' || !isFinite(nums[i])) return null;
    var key = d.model + '|' + nums.map(function (v) { return Math.round(v * 2) / 2; }).join(',');
    for (var j = 0; j < fitCache.length; j++) if (fitCache[j].key === key) return fitCache[j];
    var fb = {
      body: { style: d.style, model: d.model, wheelbase_mm: Math.round(n.wb), trackWidth_mm: Math.round(n.track) },
      suspension: { rideHeight_mm: Math.round(n.ride) }, wheels: { diameter_in: n.rimR / 12.7 },
      tires: { widthFront_mm: n.twF, widthRear_mm: n.twR, profileFront: n.prF, profileRear: n.prR }
    };
    var fm = null;
    try { fm = S.fit(S.models[d.model], fb); } catch (e) { fm = null; }
    if (!fm || !fm.dims || !fm.side || !fm.top || !fm.front || !fm.rear || !S.items(fm.side.body).length || !isFinite(fm.dims.xFront)) return null;
    var ent = { key: key, f: fm, prep: null };
    fitCache.unshift(ent);
    if (fitCache.length > 16) fitCache.length = 16;
    return ent;
  }
  function shPolys(slot, steps) {
    var S = CB.shapes, a = [];
    S.items(slot).forEach(function (it) { a = a.concat(S.flatten(it.path, steps || 12)); });
    return a;
  }
  function shBounds(slot) { var S = CB.shapes, b = S.bounds(S.items(slot).map(function (it) { return it.path; })); return b.empty ? null : b; }
  function shInside(polys, x, y) {
    var inside = false;
    polys.forEach(function (pl) {
      var p = pl.pts;
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
        if (((p[i][1] > y) !== (p[j][1] > y)) && (x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) inside = !inside;
      }
    });
    return inside;
  }
  /** sampled side profile (top line) and plan half-width, in metres */
  function shapePrep(ent) {
    if (ent.prep) return ent.prep;
    var S = CB.shapes, fm = ent.f, sv = fm.side;
    var body = shPolys(sv.body), gh = shPolys(sv.greenhouse), top = shPolys(fm.top.body);
    var bb = shBounds(sv.body), gb = shBounds(sv.greenhouse);
    var x0 = bb.minX, x1 = bb.maxX, N = 100, prof = [], hw = [], low = [], yTop = 0;
    for (var i = 0; i <= N; i++) {
      var x = lerp(x0, x1, i / N), a = S.sliceAt(body, x), b = gh.length ? S.sliceAt(gh, x) : null, t = top.length ? S.sliceAt(top, x) : null;
      var y = Math.max(a ? a[1] : 0, b ? b[1] : 0);
      prof.push(y); yTop = Math.max(yTop, y);
      low.push(a && isFinite(a[0]) ? a[0] : bb.minY);
      hw.push(t ? Math.max(Math.abs(t[0]), Math.abs(t[1])) : 0);
    }
    var tb = shBounds(fm.top.body);
    ent.prep = { body: body, x0: x0, x1: x1, N: N, prof: prof, hw: hw, low: low, bb: bb, gb: gb, yTop: Math.max(yTop, bb.maxY), halfW: tb ? Math.max(Math.abs(tb.minY), Math.abs(tb.maxY)) : fm.dims.width / 2 };
    return ent.prep;
  }
  /** [minX, maxX] where the polylines cross the horizontal line y (null when they don't) */
  function shSpanAtY(polys, y) {
    var lo = Infinity, hi = -Infinity;
    polys.forEach(function (pl) {
      var p = pl.pts;
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
        var a = p[j], b = p[i];
        if ((a[1] <= y && b[1] >= y) || (b[1] <= y && a[1] >= y)) {
          var x = b[1] === a[1] ? Math.min(a[0], b[0]) : a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]);
          if (b[1] === a[1]) { lo = Math.min(lo, a[0], b[0]); hi = Math.max(hi, a[0], b[0]); }
          else { if (x < lo) lo = x; if (x > hi) hi = x; }
        }
      }
    });
    return lo <= hi ? [lo, hi] : null;
  }
  /** every x where the polylines cross the horizontal line y */
  function shCrossX(polys, y) {
    var xs = [];
    polys.forEach(function (pl) {
      var p = pl.pts;
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
        var a = p[j], b = p[i];
        if (a[1] === b[1]) { if (a[1] === y) xs.push(a[0], b[0]); }
        else if ((a[1] <= y && b[1] >= y) || (b[1] <= y && a[1] >= y)) xs.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
      }
    });
    return xs;
  }
  function shSample(pr, arr, x) {
    var t = (x - pr.x0) / Math.max(1e-6, pr.x1 - pr.x0) * pr.N;
    if (!(t > 0)) return arr[0];
    if (t >= pr.N) return arr[pr.N];
    var i = Math.floor(t);
    return lerp(arr[i], arr[i + 1], t - i);
  }
  /** spec whose numbers describe the fitted car, so the procedural helpers line up with it */
  function shapeSpec(sp, ent) {
    var fm = ent.f, dm = fm.dims, pr = shapePrep(ent);
    var n = assign({}, sp.n), d = assign({}, sp.d);
    var ride = ((fm.ref && fm.ref.rideHeight) || dm.rideHeight) + (dm.dy || 0);
    n.L0 = (dm.xFront - dm.xRear) * 1000; n.fo = (dm.xFront - dm.axleF) * 1000; n.wb0 = n.wb = dm.wheelbase * 1000;
    n.ro = n.L0 - n.fo - n.wb; n.H = pr.yTop * 1000; n.W = pr.halfW * 2000; n.track = dm.track * 1000;
    n.tRF = dm.wheelRadius * 1000; n.tRR = dm.wheelRadiusR * 1000; n.rimR = dm.rimRadiusF * 1000;
    n.twF = dm.tireWidthF * 1000; n.twR = dm.tireWidthR * 1000;
    n.ride = n.nomRide = Math.max(30, ride * 1000);
    n.nose = clamp(shSample(pr, pr.prof, dm.xFront - 0.06) / pr.yTop, 0.2, 0.8);
    n.shapeH = n.H + 40;
    d.openTop = !!fm.openTop;
    return { n: n, c: sp.c, d: d };
  }
  /** side-view geometry object (procedural G) re-pointed at the fitted model */
  function shapeSideG(sp2, ent) {
    var fm = ent.f, dm = fm.dims, pr = shapePrep(ent), sv = fm.side, n = sp2.n;
    var G = sideGeom(sp2), k = G.s * 1000, xF = dm.xFront;
    G.k = k; G.fm = fm; G.pr = pr;
    G.T = { scale: k, ox: G.ox + xF * k, oy: GROUND, flipX: true, flipY: true };
    G.SX = function (x) { return G.T.ox - x * k; };
    G.SY = function (y) { return GROUND - y * k; };
    G.mm = function (x) { return (xF - x) * 1000; };
    G.prof = function (mm) { return shSample(pr, pr.prof, xF - mm / 1000) * 1000; };
    G.aRF = sv.archF.r * 1000; G.aRR = sv.archR.r * 1000;
    G.aFx = G.mm(sv.archF.x); G.aRx = G.mm(sv.archR.x);
    // lowest body edge at a station (mm from the nose): the real body curves up at the overhangs and arches
    G.yLow = function (mm) { return shSample(pr, pr.low, xF - mm / 1000) * 1000; };
    var sb = shBounds(sv.sill) || shBounds(sv.lowerTrim);
    if (sb && isFinite(sb.minY) && sb.minY > 0) G.yb = sb.minY * 1000;
    var gb = pr.gb || { minX: dm.axleR, maxX: dm.axleF * 0.4, minY: pr.yTop * 0.62, maxY: pr.yTop };
    G.yRoof = pr.yTop * 1000; G.yBelt = gb.minY * 1000;
    G.xA = G.mm(gb.maxX); G.xCE = G.mm(gb.minX);
    var xs = [], i;
    for (i = 0; i <= 40; i++) { var mmx = lerp(G.xA, G.xCE, i / 40); if (G.prof(mmx) >= G.yRoof - 45) xs.push(mmx); }
    G.xRS = xs.length ? xs[0] : lerp(G.xA, G.xCE, 0.35); G.xRE = xs.length ? xs[xs.length - 1] : lerp(G.xA, G.xCE, 0.7);
    if (G.xRE - G.xRS < 120) { G.xRS -= 60; G.xRE += 60; }
    G.yCowl = G.prof(G.xA); G.yNose = G.prof(60); G.yDeck = G.prof(Math.min(G.L - 260, Math.max(G.xCE + 120, G.L - 500))); G.yTail = G.prof(G.L - 40);
    var dc = shBounds(sv.doorCuts);
    G.doors = [dc ? { x0: G.mm(dc.maxX), x1: G.mm(dc.minX), front: true } : { x0: G.xA - 80, x1: G.xA + 1100, front: true }];
    G.dlo = { pts: [], xFront: G.xA + 120, xRear: Math.max(G.xA + 400, G.xCE - 80), yB: G.yBelt, inset: 60 };
    G.wingMount = wingMount(G);
    G.topMm = Math.max(G.yRoof, G.wingMount ? G.wingMount.topMm : 0);
    G.bounds = { x: G.px(-160), y: G.py(G.topMm + 140), w: (G.L + 320) * G.s, h: G.py(-60) - G.py(G.topMm + 140) };
    return G;
  }

  /** SVG d of the side shoulder: the highest long character line below the windows, else the body top
      profile capped at the belt (shape coordinates mapped through dd) */
  function shoulderLine(S, fm, pr, dd) {
    var sv = fm.side, best = null, by = -Infinity, bb = pr.bb, belt = pr.gb ? pr.gb.minY : bb.maxY * 0.7;
    S.items(sv.characterLines).forEach(function (it) {
      var b = S.bounds(it.path);
      if (b.empty || b.w < (bb.maxX - bb.minX) * 0.6) return;   // a short crease would leave a floating smear
      var cy = (b.minY + b.maxY) / 2;
      if (cy > belt + 0.02 || cy < belt - 0.35) return;   // a roof / window line or a sill crease, not the shoulder
      if (cy > by) { by = cy; best = it.path; }
    });
    if (best) return dd(best) || null;
    var segs = [], N = 40, x0 = bb.minX + 0.08, x1 = bb.maxX - 0.08;
    for (var i = 0; i <= N; i++) {
      var x = lerp(x0, x1, i / N), y = Math.min(shSample(pr, pr.prof, x), belt) - 0.03;
      segs.push({ t: i ? 'L' : 'M', p: [[x, y]] });
    }
    return dd(segs) || null;
  }
  /* paint vocabulary → SVG attributes */
  function shPaint(P, paint, view, d) {
    switch (paint) {
      case 'body': return { fill: url(P, view === 'top' ? 'paintTop' : 'paint') };
      case 'gloss-black': return { fill: url(P, 'gblack') };
      case 'chrome': return d && d.badge === 'black' ? { fill: url(P, 'gblack') } : { fill: url(P, view === 'top' ? 'chromeH' : 'chrome') };
      case 'glass': return { fill: url(P, view === 'top' ? 'glassTop' : 'glass') };
      case 'light': return { fill: url(P, 'lens'), stroke: '#3c4550', 'stroke-width': 0.6 };
      case 'drl': return { fill: d && d.lights === 'halogen' ? '#fff1c9' : '#ffffff', stroke: '#d9ecff', 'stroke-width': 0.5, opacity: d && d.lights === 'halogen' ? 0.7 : 1 };
      case 'light-red': return { fill: url(P, 'tailL'), stroke: '#2a0004', 'stroke-width': 0.6 };
      case 'light-amber': return { fill: url(P, 'amber'), stroke: '#4a2800', 'stroke-width': 0.4 };
      case 'carbon': return { fill: url(P, 'carbon') };
      case 'grille': return { fill: url(P, 'grilleMesh'), stroke: '#050506', 'stroke-width': 0.7 };
      case 'plate': return { fill: '#f1f0ea', stroke: '#26272b', 'stroke-width': 0.8 };
      case 'line': return { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.5, 'stroke-width': 1, 'stroke-linecap': 'round' };
      case 'trim': return { fill: '#0c0e11' };
      case 'contrast': return { fill: url(P, 'roofc') };
      case 'none': return { fill: 'none' };
      default: return { fill: '#121315' };
    }
  }
  var BADGE_INITIALS = { 'VOLKSWAGEN': 'VW', 'MERCEDES-BENZ': 'MB', 'MERCEDES-AMG': 'AMG', 'LAMBORGHINI': 'L', 'RANGE ROVER': 'RR' };
  function shMirrorPaint(paint, d) { return d.mirrors === 'black' ? 'gloss-black' : d.mirrors === 'carbon' ? 'carbon' : paint; }
  /** drawing context for one view */
  function shCtx(P, view, T, sp, hi) {
    var S = CB.shapes, d = sp.d;
    var X = {
      S: S, P: P, view: view, T: T, d: d, hi: hi,
      dd: function (path) { return S.toSvgPath(path, T); },
      x: function (a) { return T.ox + (T.flipX ? -a : a) * T.scale; },
      y: function (b) { return T.oy + (T.flipY ? -b : b) * T.scale; },
      pbox: function (path) { var b = S.bounds(path); if (b.empty) return null; var xa = X.x(b.minX), xb = X.x(b.maxX), ya = X.y(b.minY), yb = X.y(b.maxY); return { x: Math.min(xa, xb), y: Math.min(ya, yb), w: Math.abs(xb - xa), h: Math.abs(yb - ya), cx: (xa + xb) / 2, cy: (ya + yb) / 2 }; }
    };
    /* paint one path with lamp emission per build lights type */
    X.paintPath = function (out, path, paint, role) {
      var dd = X.dd(path);
      if (!dd) return;
      if (paint === 'line') { out.push(pathEl(dd, shPaint(P, 'line', view, d))); return; }
      out.push(pathEl(dd, shPaint(P, paint, view, d)));
      if (paint === 'body' && view !== 'top') out.push(pathEl(dd, { fill: url(P, 'topLight'), opacity: 0.8 }));
      if (paint === 'glass') out.push(pathEl(dd, { fill: url(P, 'glassRef') }));
      if (paint === 'carbon' && hi) out.push(pathEl(dd, { fill: url(P, 'carbonSheen') }));
      if (paint === 'light') {
        if (role === 'drl') { if (d.lights !== 'halogen') out.push(pathEl(dd, { fill: '#ffffff', filter: hi ? url(P, 'glow') : null, opacity: 0.95 })); else out.push(pathEl(dd, { fill: '#fff0c4', opacity: 0.6 })); }
        else out.push(pathEl(dd, { fill: url(P, 'glassRef'), opacity: 0.7 }));
      }
      if (paint === 'light-red' && d.lights !== 'halogen' && hi) out.push(pathEl(dd, { fill: '#ff2a1a', opacity: 0.32, filter: url(P, 'glow') }));
      if (paint === 'light-amber' && hi) out.push(pathEl(dd, { fill: '#ffb030', opacity: 0.25, filter: url(P, 'glow') }));
    };
    X.slot = function (out, slot, defPaint, role, mapPaint) {
      S.items(slot).forEach(function (it) {
        var p = it.paint || defPaint;
        if (mapPaint) p = mapPaint(p);
        X.paintPath(out, it.path, p, role || it.role);
      });
    };
    X.strokes = function (out, slot, kind) {
      S.items(slot).forEach(function (it) {
        var dd = X.dd(it.path);
        if (!dd) return;
        if (kind === 'char') {
          out.push(pathEl(dd, { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.24, 'stroke-width': 1.5, transform: 'translate(0 1.3)' }));
          out.push(pathEl(dd, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': f2(0.18 + d.gloss * 0.3), 'stroke-width': 1 }));
        } else {
          out.push(pathEl(dd, { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.58, 'stroke-width': 1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
          out.push(pathEl(dd, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.15, 'stroke-width': 0.7, transform: 'translate(0.8 0.8)' }));
        }
      });
    };
    /* projector / matrix / laser accents inside a headlamp */
    X.lampAccent = function (out, path) {
      var b = X.pbox(path);
      if (!b || b.w < 3 || b.h < 2) return;
      var r = Math.max(0.9, Math.min(b.w, b.h) * 0.24);
      if (d.lights === 'halogen') {
        out.push(circleEl(b.cx, b.cy, r * 1.1, { fill: '#fff4d0', stroke: '#9c8a5a', 'stroke-width': 0.4, filter: hi ? url(P, 'glow') : null }));
      } else if (d.lights === 'matrix') {
        var cells = '', nC = clamp(Math.round(b.w / 4), 3, 9), cs = Math.max(0.9, Math.min(b.h * 0.3, b.w / (nC * 1.8)));
        for (var k = 0; k < nC; k++) { var xx = b.x + b.w * (k + 0.5) / nC; cells += roundRectD(xx - cs / 2, b.cy - cs / 2, cs, cs, cs * 0.25) + ' '; }
        out.push(pathEl(cells, { fill: '#ffffff', filter: hi ? url(P, 'glow') : null }));
      } else {
        out.push(circleEl(b.cx - b.w * 0.16, b.cy, r * 0.8, { fill: '#ffffff', filter: hi ? url(P, 'glow') : null }));
        out.push(circleEl(b.cx + b.w * 0.18, b.cy, r * 0.6, { fill: '#e9f1ff' }));
        if (d.lights === 'laser') out.push(circleEl(b.cx + b.w * 0.18, b.cy, r * 0.32, { fill: '#3a8bff', filter: hi ? url(P, 'glow') : null }));
      }
    };
    X.details = function (out, fm, filter) {
      (fm.details || []).forEach(function (dt) {
        if (dt.view !== view || !dt.path) return;
        var role = dt.role || '', paint = dt.paint || 'black';
        if (filter && !filter(role, dt)) return;
        if (role === 'mirror') paint = shMirrorPaint(paint, d);
        if ((role === 'badge' || role === 'badgeText') && d.badge === 'delete') return;
        if (role === 'exhaust' && d.tipStyle === 'none') return;
        var dpath = S.toPath(dt.path) || dt.path;
        if (X.mapDetail && S.isPath(dpath)) dpath = X.mapDetail(dpath, paint, role) || dpath;
        // lettering authored for the car's right side / front: un-mirror it locally when the view is flipped
        if (T.flipX && (role === 'badge' || role === 'badgeText') && S.isPath(dpath)) {
          var bb0 = S.bounds(dpath), cx0 = (bb0.minX + bb0.maxX) / 2;
          if (!bb0.empty) dpath = S.mapPath(dpath, function (q) { return [2 * cx0 - q[0], q[1]]; });
        }
        X.paintPath(out, dpath, paint, role);
        // dark parts (carbon wing planks / struts, piano-black trim) get a light edge so they don't melt into
        // a dark deck or each other
        if (view === 'side' && (paint === 'carbon' || paint === 'gloss-black') && S.isPath(dpath)) out.push(pathEl(X.dd(dpath), { fill: 'none', stroke: '#3a3d42', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }));
        if (view === 'side' && S.isPath(dpath) && (paint === 'light' || paint === 'light-red') && role !== 'marker' && role !== 'glass') {
          // side view lamps: the model's look signature (nose on the left: a front lamp's outboard edge is the nose)
          var lb = S.bounds(dpath), lk = X.lookOf();
          var front = !lb.empty && (lb.minX + lb.maxX) / 2 > 0;
          var done = lk && !lb.empty && X.look(out, paint === 'light' ? 'head' : 'tail', paint === 'light' ? (front ? lk.head : null) : (!front ? lk.tail : null), dpath, front ? -1 : 1);
          if (!done && (role === 'light' || role === 'headlight') && paint === 'light') X.lampAccent(out, dpath);
        }
      });
    };
    /* model.look signature detailing, drawn inside one lamp / grille path (clipped to it).
       kind: 'head' | 'tail' | 'grille'; type: the model's look value; dir: +1 / -1 = the lamp's outboard
       direction on screen (towards the body side in front / rear views, towards the nose / tail in the side
       view). Unknown or missing types draw nothing, so models without `look` keep their plain lamps. */
    X.lid = 0;
    X.fm = null;
    X.lookOf = function () { var fm = X.fm, lk = fm && (fm.look || (S.models && S.models[fm.id] && S.models[fm.id].look)); return lk && typeof lk === 'object' ? lk : null; };
    X.dirOf = function (path) { var b = X.pbox(path); return b && b.cx < X.x(0) ? -1 : 1; };
    X.look = function (out, kind, type, path, dir) {
      if (!type || !path) return false;
      var b = X.pbox(path), k = T.scale;
      if (!b || b.w < 2.5 || b.h < 1.6) return false;
      var id = P + 'lk' + view.charAt(0) + (X.lid++), m = '', dd = X.dd(path);
      if (!dd) return false;
      dir = dir >= 0 ? 1 : -1;
      var cx = b.cx, cy = b.cy, w = b.w, h = b.h, mn = Math.min(w, h);
      var ix = function (fr) { return cx + dir * (fr - 0.5) * w; };     // 0 = inboard edge, 1 = outboard edge
      var halo = d.lights === 'halogen', glowF = hi && !halo ? url(P, 'glow') : null;
      var hc = halo ? '#fff1c9' : d.lights === 'laser' ? '#e4efff' : '#ffffff', tc = '#ff5446';
      var col = kind === 'tail' ? tc : hc, sw = clamp(mn * 0.13, 0.6, Math.max(0.8, 0.02 * k));
      var line = function (dl, wd, op) { return pathEl(dl, { fill: 'none', stroke: col, 'stroke-width': f2(wd || sw), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: op == null ? 1 : op, filter: glowF }); };
      var ring = function (x, y, r, wd) { return circleEl(x, y, r, { fill: 'none', stroke: col, 'stroke-width': f2(wd || sw), filter: glowF }); };
      var lens = function (x, y, r) { return circleEl(x, y, r, { fill: '#1b222b', stroke: '#8d99a8', 'stroke-width': f2(Math.max(0.3, r * 0.12)) }) + circleEl(x - r * 0.25, y - r * 0.25, r * 0.35, { fill: '#ffffff', opacity: 0.85 }); };
      if (kind === 'head' || kind === 'tail') {
        var t = type;
        if (t === 'oval-4pt') {
          // Porsche four-point DRL around a central projector
          var rr = mn * 0.5 * 0.62, ds = Math.max(0.6, mn * 0.1);
          m += lens(cx, cy, mn * 0.2);
          [45, 135, 225, 315].forEach(function (a) { var p = polar(cx, cy, rr, a * DEG); m += pathEl(roundRectD(p[0] - ds * 1.4, p[1] - ds * 0.55, ds * 2.8, ds * 1.1, ds * 0.5), { fill: col, filter: glowF, transform: 'rotate(' + f2(a + 90) + ' ' + f(p[0]) + ' ' + f(p[1]) + ')' }); });
        } else if (t === 'c-clamp' || t === 'c-ring') {
          // a C opening inboard: top, outer side, bottom
          var a0 = 0.18, a1 = 0.86, yt = b.y + h * 0.2, yb = b.y + h * 0.8, rc = Math.min(h * 0.3, w * 0.15);
          m += line('M' + P2(ix(a0), yt) + ' L' + P2(ix(a1) - dir * rc, yt) + ' Q' + P2(ix(a1), yt) + ' ' + P2(ix(a1), yt + rc) + ' L' + P2(ix(a1), yb - rc) + ' Q' + P2(ix(a1), yb) + ' ' + P2(ix(a1) - dir * rc, yb) + ' L' + P2(ix(a0), yb));
          if (kind === 'head') m += lens(ix(0.45), cy, Math.min(h * 0.2, w * 0.12));
        } else if (t === 'y-blade' || t === 'y-shape') {
          var yx = ix(0.42);
          m += line('M' + P2(ix(0.08), cy) + ' L' + P2(yx, cy) + ' L' + P2(ix(0.9), b.y + h * 0.18) + ' M' + P2(yx, cy) + ' L' + P2(ix(0.9), b.y + h * 0.82));
        } else if (t === 'round-halo' || t === 'round-ring' || t === 'quad-round') {
          var n2 = t === 'quad-round' || w / h > 1.75 ? 2 : 1, rr2 = Math.min(h * 0.36, w / (n2 * 2) * 0.78);
          for (var q = 0; q < n2; q++) {
            var qx = n2 === 1 ? cx : ix(q ? 0.73 : 0.27);
            if (kind === 'head') m += lens(qx, cy, rr2 * 0.55);
            else m += circleEl(qx, cy, rr2 * 0.55, { fill: '#5a0a10', opacity: 0.6 });
            m += ring(qx, cy, rr2, Math.max(0.6, sw * 0.9));
          }
        } else if (t === 'slim-led' || t === 'slim') {
          m += line('M' + P2(ix(0.06), b.y + h * 0.26) + ' L' + P2(ix(0.94), b.y + h * 0.26), Math.max(0.6, Math.min(sw, h * 0.16)));
          if (kind === 'head' && w > 8) { var nc = clamp(Math.round(w / Math.max(4, h * 1.4)), 2, 5), cs = Math.min(h * 0.32, w / (nc * 2.2)); for (var c2 = 0; c2 < nc; c2++) m += pathEl(roundRectD(ix(0.2 + 0.6 * (c2 + 0.5) / nc) - cs / 2, b.y + h * 0.5, cs, cs, cs * 0.25), { fill: '#d7e6ff', opacity: 0.9 }); }
        } else if (t === 'projector-twin') {
          var pr2 = Math.min(h * 0.27, w * 0.15);
          m += lens(ix(0.3), cy - h * 0.04, pr2) + lens(ix(0.68), cy - h * 0.04, pr2);
          m += line('M' + P2(ix(0.1), b.y + h * 0.84) + ' L' + P2(ix(0.92), b.y + h * 0.84), Math.max(0.6, sw * 0.8));
        } else if (t === 'blade') {
          m += line('M' + P2(ix(0.06), b.y + h * 0.7) + ' L' + P2(ix(0.94), b.y + h * 0.32), Math.max(0.7, sw * 1.1));
        } else if (t === 'light-bar' || t === 'full-width') {
          m += line('M' + P2(b.x + w * 0.04, cy) + ' L' + P2(b.x + w * 0.96, cy), Math.max(0.6, Math.min(sw, h * 0.3)));
        } else if (t === 'vertical') {
          var ns = clamp(Math.round(h / Math.max(3, w * 0.55)), 2, 5);
          for (var v2 = 0; v2 < ns; v2++) { var vy = b.y + h * (0.12 + 0.76 * (v2 + 0.5) / ns); m += line('M' + P2(ix(0.2), vy) + ' L' + P2(ix(0.82), vy), Math.max(0.6, Math.min(sw, h / ns * 0.3))); }
        } else return false;
      } else if (kind === 'grille') {
        var sp = Math.max(2, 0.028 * k), lw = Math.max(0.6, sp * 0.3), gl = '', bar = { fill: 'none', stroke: '#2f3237', 'stroke-width': f2(lw) };
        var chromeS = { fill: 'none', stroke: d.badge === 'black' ? '#1c1d20' : url(P, 'chrome'), 'stroke-width': f2(Math.max(0.8, 0.014 * k)), 'stroke-linejoin': 'round' };
        var hl = function (y) { return 'M' + P2(b.x - 1, y) + ' L' + P2(b.x + w + 1, y) + ' '; }, vl = function (x) { return 'M' + P2(x, b.y - 1) + ' L' + P2(x, b.y + h + 1) + ' '; };
        var q2;
        if (type === 'kidney' || type === 'seven-slot') {
          if (type === 'seven-slot' && w > h) {
            // body-colour surround with seven vertical openings
            m += rectEl(b.x - 1, b.y - 1, w + 2, h + 2, { fill: url(P, 'paint') }) + rectEl(b.x - 1, b.y - 1, w + 2, h + 2, { fill: url(P, 'topLight'), opacity: 0.6 });
            var sw7 = w / 7 * 0.56;
            for (q2 = 0; q2 < 7; q2++) m += pathEl(roundRectD(b.x + w * (q2 + 0.5) / 7 - sw7 / 2, b.y + h * 0.12, sw7, h * 0.76, sw7 * 0.45), { fill: url(P, 'grilleMesh'), stroke: '#040405', 'stroke-width': 0.5 });
          } else {
            for (q2 = b.x + sp * 0.6; q2 < b.x + w; q2 += sp * 1.1) gl += vl(q2);
            m += pathEl(gl, assign({}, bar, { stroke: '#3a3d43', 'stroke-width': f2(lw * 1.4) }));
            m += pathEl(dd, chromeS);
          }
        } else if (type === 'slats' || type === 'bar') {
          if (type === 'slats') { for (q2 = b.y + sp * 0.6; q2 < b.y + h; q2 += sp) gl += hl(q2); m += pathEl(gl, assign({}, bar, { stroke: '#34373c', 'stroke-width': f2(lw * 1.3) })); }
          else {
            var nb = h > 0.18 * k ? 2 : 1, bh = Math.max(1.4, Math.min(h * 0.16, 0.05 * k));
            for (q2 = 0; q2 < nb; q2++) { var by = b.y + h * (nb === 1 ? 0.5 : q2 ? 0.66 : 0.34) - bh / 2; m += rectEl(b.x - 1, by, w + 2, bh, { fill: url(P, 'gblack') }) + rectEl(b.x - 1, by, w + 2, Math.max(0.5, bh * 0.22), { fill: '#ffffff', opacity: 0.14 }); }
          }
        } else if (type === 'honeycomb' || type === 'hex') {
          var hs = type === 'hex' ? sp * 1.25 : sp * 0.8, hd = '', hy2 = hs * 0.866;
          for (var yy2 = b.y - hy2, row = 0; yy2 < b.y + h + hy2; yy2 += hy2, row++) for (var xx2 = b.x - hs + (row % 2) * hs * 0.75; xx2 < b.x + w + hs; xx2 += hs * 1.5) {
            hd += 'M' + P2(xx2 - hs / 2, yy2) + ' L' + P2(xx2 - hs / 4, yy2 - hy2 / 2) + ' L' + P2(xx2 + hs / 4, yy2 - hy2 / 2) + ' L' + P2(xx2 + hs / 2, yy2) + ' L' + P2(xx2 + hs / 4, yy2 + hy2 / 2) + ' L' + P2(xx2 - hs / 4, yy2 + hy2 / 2) + ' Z ';
          }
          m += rectEl(b.x - 1, b.y - 1, w + 2, h + 2, { fill: '#050506' }) + pathEl(hd, { fill: 'none', stroke: '#30333a', 'stroke-width': f2(Math.max(0.5, hs * 0.16)) });
          if (type === 'hex') m += pathEl(dd, chromeS);
        } else if (type === 'mesh') {
          for (q2 = -h; q2 < w + h; q2 += sp * 0.8) gl += 'M' + P2(b.x + q2, b.y - 1) + ' L' + P2(b.x + q2 + h + 2, b.y + h + 1) + ' M' + P2(b.x + q2, b.y + h + 1) + ' L' + P2(b.x + q2 + h + 2, b.y - 1) + ' ';
          m += rectEl(b.x - 1, b.y - 1, w + 2, h + 2, { fill: '#060607' }) + pathEl(gl, assign({}, bar, { 'stroke-width': f2(lw * 0.8) }));
        } else if (type === 'blanked') {
          m += rectEl(b.x - 1, b.y - 1, w + 2, h + 2, { fill: url(P, 'gblack') }) + rectEl(b.x - 1, b.y - 1, w + 2, h * 0.45, { fill: '#ffffff', opacity: 0.08 });
          m += pathEl(dd, { fill: 'none', stroke: '#3c3f45', 'stroke-width': 0.6 });
        } else if (type === 'horseshoe') {
          for (q2 = -h; q2 < w + h; q2 += sp * 0.7) gl += 'M' + P2(b.x + q2, b.y - 1) + ' L' + P2(b.x + q2 + h + 2, b.y + h + 1) + ' M' + P2(b.x + q2, b.y + h + 1) + ' L' + P2(b.x + q2 + h + 2, b.y - 1) + ' ';
          m += rectEl(b.x - 1, b.y - 1, w + 2, h + 2, { fill: '#060607' }) + pathEl(gl, assign({}, bar, { 'stroke-width': f2(lw * 0.7) }));
          m += pathEl(dd, assign({}, chromeS, { 'stroke-width': f2(Math.max(1.2, 0.028 * k)) }));
        } else if (type === 'split-v') {
          m += pathEl('M' + P2(b.x + w * 0.04, b.y + h * 0.08) + ' L' + P2(cx, b.y + h * 0.92) + ' L' + P2(b.x + w * 0.96, b.y + h * 0.08), assign({}, chromeS, { 'stroke-width': f2(Math.max(1, 0.02 * k)) }));
        } else return false;
      } else return false;
      if (!m) return false;
      out.push('<clipPath id="' + id + '"><path d="' + dd + '"/></clipPath>');
      out.push(g({ 'clip-path': 'url(#' + id + ')', class: 'cbr-look', 'data-look': kind + ':' + type }, m));
      return true;
    };
    X.text = function (out, slot, text, mono) {
      if (!text) return;
      S.items(slot).forEach(function (it) {
        var b = X.pbox(it.path);
        if (!b || b.w < 4 || b.h < 1.5) return;
        var str = String(text).toUpperCase(), metal = d.badge === 'black' ? url(P, 'badgeBlack') : url(P, 'chrome');
        // near-square badge areas (roundels): a chrome ring with the make's initials, never a squashed full name
        if (!mono && b.w / b.h < 1.6) {
          var ini = BADGE_INITIALS[str] || (str.split(/[\s\-]+/).length > 1 ? str.split(/[\s\-]+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 3) : str.length <= 3 ? str : str.charAt(0));
          var rr0 = Math.min(b.w, b.h) / 2;
          out.push(circleEl(b.cx, b.cy, rr0 * 0.9, { fill: 'none', stroke: metal, 'stroke-width': f2(Math.max(0.6, rr0 * 0.14)) }));
          out.push(textEl(b.cx, b.cy, ini, { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': f2(Math.min(rr0 * 1.05, rr0 * 2.1 / (ini.length * 0.62 + 0.4))), fill: metal, 'font-family': SANS, 'font-weight': 800 }));
          return;
        }
        var h = Math.min(b.h * (mono ? 0.56 : 0.72), b.w * (mono ? 0.8 : 0.95) / (Math.max(1, str.length) * (mono ? 0.62 : 0.66)));
        if (h < 1.6) return;
        var a = mono ? { fill: '#17181b', 'font-family': MONO, 'font-weight': 700 }
          : { fill: metal, stroke: d.badge === 'black' ? 'none' : '#2a2d31', 'stroke-width': 0.3, 'font-family': SANS, 'font-weight': 800, 'letter-spacing': '0.06em' };
        out.push(textEl(b.cx, b.cy, str, assign({ 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': f2(h) }, a)));
      });
    };
    return X;
  }
  /** exhaust tips: the model's own outlets, restyled by the build's exhaust choice */
  function shapeTips(fm, d) {
    if (d.tipStyle === 'none') return [];
    var ex = (fm.rear.exhaust || []).filter(function (e) { return e && isFinite(e.cx) && isFinite(e.cy); });
    var vis = ex.filter(function (e) { return e.shape !== 'hidden'; });
    // a battery-electric model without tailpipes never grows petrol tips
    if (fm.powertrain === 'ev' && !vis.length) return [];
    // vans and pickups: one tailpipe turned down under the bumper behind the rear wheel, whatever the
    // build's tip count says (no chrome twin tips in the middle of a work-van bumper)
    if ((fm.style === 'van' || fm.style === 'pickup') && ex.length && (ex.length === 1 || ex.some(function (e) { return e.shape === 'hidden'; }))) {
      var vbB = shBounds(fm.rear.bumper) || shBounds(fm.rear.body);
      return ex.slice(0, 1).map(function (e) {
        var w0 = Math.min(e.w || 0.075, 0.09), h0 = Math.min(e.h || 0.075, 0.09);
        return { shape: 'round', cx: e.cx, cy: vbB ? Math.min(e.cy, vbB.minY - h0 * 0.35) : e.cy, w: w0, h: h0, fin: d.tipStyle === 'blued' ? 'blued' : 'chrome', down: true };
      });
    }
    // hidden pipes behind big faux outlets (V60, Range Rover): a dark opening inset into the model's outlet
    if (!vis.length && (d.tipStyle === 'round' || d.tipStyle === 'sport' || d.tipStyle === 'hidden' || !d.tipStyle)) {
      var faux = ex.filter(function (e) { return e.w >= 0.1 && e.h >= 0.03; });
      if (faux.length) return faux.map(function (e) { return { shape: 'trapezoid', cx: e.cx, cy: e.cy, w: e.w - 0.02, h: e.h - 0.02, fin: 'chrome', faux: true }; });
    }
    // round / sport tips: the manufacturer's own outlets (count, position and trapezoid shapes) are kept
    if ((d.tipStyle === 'round' || d.tipStyle === 'sport' || !d.tipStyle) && vis.length && (d.tipCount || 2) <= vis.length) {
      return vis.map(function (e) { return { shape: e.shape, cx: e.cx, cy: e.cy, w: e.w || 0.09, h: e.h || 0.09, fin: 'chrome' }; });
    }
    if (d.tipStyle === 'hidden') return vis.map(function (e) { return { shape: e.shape, cx: e.cx, cy: e.cy, w: e.w || 0.09, h: e.h || 0.09, fin: 'chrome' }; });
    var hw = fm.dims.width / 2, base = ex.length ? ex : [{ cx: -hw * 0.6, cy: fm.dims.rideHeight + 0.14, w: 0.1, h: 0.08 }, { cx: hw * 0.6, cy: fm.dims.rideHeight + 0.14, w: 0.1, h: 0.08 }];
    var cy = 0; base.forEach(function (e) { cy += e.cy; }); cy /= base.length;
    if (d.tipStyle === 'center') return [{ shape: 'round', cx: 0, cy: cy + 0.03, w: 0.15, h: 0.15, fin: 'chrome' }];
    var shape = d.tipStyle === 'oval' ? 'oval' : 'round', fin = d.tipStyle === 'blued' ? 'blued' : 'chrome';
    var w = shape === 'oval' ? 0.13 : 0.095, h = shape === 'oval' ? 0.075 : 0.095;
    var sides = [-1, 1].map(function (sd) {
      var on = base.filter(function (e) { return sd < 0 ? e.cx < -0.02 : e.cx > 0.02; });
      if (!on.length) return null;
      var sx = 0, sy = 0; on.forEach(function (e) { sx += e.cx; sy += e.cy; });
      return [sx / on.length, sy / on.length];
    });
    if (!sides[0] && !sides[1]) sides = [[-hw * 0.12, cy], [hw * 0.12, cy]];
    if (!sides[0]) sides[0] = [-sides[1][0], sides[1][1]];
    if (!sides[1]) sides[1] = [-sides[0][0], sides[0][1]];
    var per = d.tipCount >= 4 ? 2 : 1, out = [];
    var list = d.tipCount === 1 ? [sides[1]] : sides;
    list.forEach(function (c) {
      for (var k = 0; k < per; k++) out.push({ shape: shape, cx: c[0] + (per === 2 ? (k ? 1 : -1) * w * 0.6 : 0), cy: c[1], w: w, h: h, fin: fin });
    });
    return out;
  }
  function tipMarkup(X, P, t) {
    var cx = X.x(t.cx), cy = X.y(t.cy), rx = t.w / 2 * X.T.scale, ry = t.h / 2 * X.T.scale;
    var fill = t.fin === 'blued' ? url(P, 'blued') : url(P, 'chrome');
    if (t.shape === 'round') rx = ry = Math.min(rx, ry) || rx;
    if (t.down) {
      // pipe turned toward the road: seen from behind, a short tube with its bore facing down
      return pathEl(roundRectD(cx - rx, cy - ry * 1.4, rx * 2, ry * 2, rx * 0.6), { fill: fill, stroke: '#1b1c1f', 'stroke-width': 0.5 }) +
        ellipseEl(cx, cy + ry * 0.5, rx * 0.95, ry * 0.32, { fill: '#050506' });
    }
    // a thick metal lip and a dark bore, so the tip still reads as a pipe at thumbnail size
    var lip = Math.max(1.2, 0.18 * Math.min(rx, ry)), fx = clamp(1 - lip / Math.max(0.01, rx), 0.2, 0.7), fy = clamp(1 - lip / Math.max(0.01, ry), 0.2, 0.7);
    if (t.shape === 'trapezoid') {
      // rounded trapezoid exactly w x h (no flange past the outlet), dark bore inset 0.01 m all round
      var ins = Math.max(0.8, 0.01 * X.T.scale), rc = Math.min(rx, ry) * 0.35;
      var rtrap = function (ax, ay, r) {
        var q = [[cx - ax, cy - ay], [cx + ax, cy - ay], [cx + ax * 0.9, cy + ay], [cx - ax * 0.9, cy + ay]], dd = '';
        for (var i = 0; i < 4; i++) {
          var a = q[(i + 3) % 4], b = q[i], c2 = q[(i + 1) % 4];
          var la = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, lc = Math.hypot(c2[0] - b[0], c2[1] - b[1]) || 1, rr = Math.min(r, la / 2, lc / 2);
          var p0 = [b[0] + (a[0] - b[0]) * rr / la, b[1] + (a[1] - b[1]) * rr / la], p1 = [b[0] + (c2[0] - b[0]) * rr / lc, b[1] + (c2[1] - b[1]) * rr / lc];
          dd += (i ? ' L' : 'M') + P2(p0[0], p0[1]) + ' Q' + P2(b[0], b[1]) + ' ' + P2(p1[0], p1[1]);
        }
        return dd + ' Z';
      };
      var ix = Math.max(0.5, rx - ins), iy = Math.max(0.5, ry - ins);
      return pathEl(rtrap(rx, ry, rc), { fill: fill }) + pathEl(rtrap(ix, iy, Math.max(0.3, rc - ins * 0.5)), { fill: '#050506' }) +
        pathEl(rtrap(ix, iy * 0.45, Math.max(0.3, rc * 0.5)), { fill: '#1a1b1e', opacity: 0.6, transform: 'translate(0 ' + f2(-iy * 0.4) + ')' });
    }
    return ellipseEl(cx, cy, rx, ry, { fill: fill, stroke: '#1b1c1f', 'stroke-width': 0.6 }) + ellipseEl(cx, cy, rx * fx, ry * fy, { fill: '#020203', stroke: '#000', 'stroke-width': 0.4 }) +
      ellipseEl(cx - rx * fx * 0.1, cy + ry * fy * 0.3, rx * fx * 0.6, ry * fy * 0.4, { fill: '#1a0f0a', opacity: 0.5 });
  }

  /* ---------------------------------------------------------------- side */
  function drawShapeSide(sp0, o, ent) {
    var S = CB.shapes, fm = ent.f, sv = fm.side, sp = shapeSpec(sp0, ent), G = shapeSideG(sp, ent), pr = G.pr;
    var n = sp.n, d = sp.d, c = sp.c, P = o.P, s = G.s, k = G.k, px = G.px, py = G.py, hi = o.detail !== 'low', L = G.L;
    var X = shCtx(P, 'side', G.T, sp, hi);
    X.fm = fm;
    var bodyD = S.items(sv.body).map(function (it) { return X.dd(it.path); }).join(' ');
    G.shapeBodyD = bodyD;
    G.shapeDloD = S.items(sv.greenhouse).map(function (it) { return X.dd(it.path); }).join(' ') || null;
    var out = [], car = [];
    out.push('<defs><clipPath id="' + P + 'body"><path d="' + bodyD + '"/></clipPath>' +
      '<linearGradient id="' + P + 'reflG" gradientUnits="userSpaceOnUse" x1="0" y1="' + GROUND + '" x2="0" y2="' + (GROUND + 120) + '">' + stops([[0, '#ffffff', 0.9], [1, '#ffffff', 0]]) + '</linearGradient>' +
      '<mask id="' + P + 'reflM" maskUnits="userSpaceOnUse" x="' + (-VBW) + '" y="' + GROUND + '" width="' + (3 * VBW) + '" height="' + (VBH - GROUND) + '">' + rectEl(-VBW, GROUND, 3 * VBW, VBH - GROUND, { fill: url(P, 'reflG') }) + '</mask></defs>');
    out.push(studio(P, d, o.backdrop || 'soft', GROUND, G.SX(fm.dims.centerX), (fm.dims.xFront - fm.dims.xRear) * k * 0.6));
    // headlamp light pool on the floor: warm, additive, starting at the real nose (not a dark puddle)
    if (d.lights !== 'halogen' && d.theme !== 'light' && hi) {
      // kept short and touching the bumper so it reads as lamp spill, not a detached glare spot
      var bx0 = G.SX(fm.dims.xFront), brx = 0.42 * k;
      out.push(ellipseEl(bx0 - brx * 0.55, GROUND + 3, brx, 7, { fill: '#fff1d8', opacity: 0.12, filter: url(P, 'blurM'), style: 'mix-blend-mode:screen' }));
    }
    out.push(ellipseEl(px(L / 2), GROUND + 3, L * s * 0.56, 16, { fill: url(P, 'shadow') }));
    out.push(rectEl(px(G.fa), GROUND - 6, (G.ra - G.fa) * s, 8, { fill: '#000', opacity: d.theme === 'light' ? 0.18 : 0.35, filter: hi ? url(P, 'blurM') : null }));
    [[G.fa, n.tRF], [G.ra, n.tRR]].forEach(function (w) { out.push(ellipseEl(px(w[0]), GROUND + 1, w[1] * s * 0.95, 5, { fill: '#000', opacity: 0.75, filter: hi ? url(P, 'blurS') : null })); });
    if (o.reflection) out.push(g({ mask: url(P, 'reflM'), opacity: d.theme === 'light' ? 0.22 : 0.18, class: 'cbr-ghost' }, '<use href="#' + P + 'car" xlink:href="#' + P + 'car" transform="matrix(1 0 0 -1 0 ' + f(GROUND * 2 + 2) + ')"/>'));

    // wheel wells: behind the body where the arch is cut out, else painted inside the body clip
    var behind = [], over = [];
    [sv.archF, sv.archR].forEach(function (a, i) {
      if (!a || !isFinite(a.r)) return;
      var cut = !shInside(pr.body, a.x, a.y + a.r * 0.6), id = P + 'wl' + i;
      var m = '<clipPath id="' + id + '">' + rectEl(0, -400, VBW, G.SY(a.y - a.r * 0.5) + 400) + '</clipPath>' +
        circleEl(G.SX(a.x), G.SY(a.y), a.r * k, { fill: url(P, 'well'), 'clip-path': 'url(#' + id + ')' });
      (cut ? behind : over).push(m);
    });
    car.push(behind.join(''));
    var paintG = [pathEl(bodyD, { fill: url(P, 'paint') })];
    if (over.length) paintG.push(g({ 'clip-path': url(P, 'body') }, over.join('')));
    var ov = [];
    var yTopPx = py(G.topMm + 60), yBotPx = py(G.yb - 40), x0p = px(-80), wp = (L + 160) * s;
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') ov.push(rectEl(x0p, yTopPx, wp, yBotPx - yTopPx, { fill: url(P, 'flake'), opacity: f2(0.06 + d.metallic * 0.16) }));
    // shoulder light follows the car's own shoulder (top character line, else the belt / bonnet profile),
    // as a soft blurred band clipped to the body and faded out over the bumpers
    var shLine = shoulderLine(S, fm, pr, X.dd), dmS = fm.dims, aRr = sv.archR && isFinite(sv.archR.r) ? sv.archR.r : dmS.wheelRadiusR, aFr = sv.archF && isFinite(sv.archF.r) ? sv.archF.r : dmS.wheelRadius;
    var gxF = G.SX(dmS.xFront), gxR = G.SX(dmS.xRear), gspan = gxR - gxF || 1;
    var gin = clamp((G.SX(dmS.axleF + aFr) - gxF) / gspan, 0.02, 0.45), gout = clamp((G.SX(dmS.axleR - aRr) - gxF) / gspan, 0.55, 0.98);
    ov.push('<defs><linearGradient id="' + P + 'shF" gradientUnits="userSpaceOnUse" x1="' + f2(gxF) + '" y1="0" x2="' + f2(gxR) + '" y2="0">' +
      stops([[0, '#ffffff', 0], [Math.max(0.001, gin - 0.06), '#ffffff', 0.15], [gin + 0.04, '#ffffff', 1], [gout - 0.04, '#ffffff', 1], [Math.min(0.999, gout + 0.06), '#ffffff', 0.15], [1, '#ffffff', 0]]) + '</linearGradient>' +
      '<mask id="' + P + 'shM" maskUnits="userSpaceOnUse" x="0" y="0" width="' + VBW + '" height="' + VBH + '">' + rectEl(0, 0, VBW, VBH, { fill: url(P, 'shF') }) + '</mask></defs>');
    // the upper body still gets the soft top-down light, only weaker; the defined shoulder band does the work
    ov.push(rectEl(x0p, yTopPx, wp, py(G.yBelt - (G.yBelt - G.yb) * 0.2) - yTopPx, { fill: url(P, 'topLight'), opacity: 0.55 }));
    if (shLine) {
      var shA = d.finish === 'matte' ? 0.08 : clamp(0.14 + d.gloss * 0.3, 0.1, 0.4), band = '';
      band += pathEl(shLine, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': f2(shA), 'stroke-width': f2(0.13 * k), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', transform: 'translate(0 ' + f2(0.06 * k) + ')', filter: hi ? url(P, 'blurM') : null });
      if (d.finish !== 'matte') band += pathEl(shLine, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': f2(shA * 0.9), 'stroke-width': f2(Math.max(1, 0.025 * k)), 'stroke-linecap': 'round', transform: 'translate(0 ' + f2(0.035 * k) + ')', filter: hi ? url(P, 'blurS') : null });
      // shadow just under the shoulder: the side turns away from the light
      band += pathEl(shLine, { fill: 'none', stroke: '#000000', 'stroke-opacity': 0.12, 'stroke-width': f2(0.08 * k), transform: 'translate(0 ' + f2(0.19 * k) + ')', filter: hi ? url(P, 'blurM') : null });
      ov.push(g({ mask: url(P, 'shM') }, band));
    } else {
      var yS1 = G.yBelt - (G.yBelt - G.yb) * 0.1, yS2 = G.yBelt - (G.yBelt - G.yb) * 0.34;
      if (d.finish !== 'matte') ov.push(g({ mask: url(P, 'shM') }, rectEl(px(G.X(0.03)), py(yS1), (G.X(0.97) - G.X(0.03)) * s, (yS1 - yS2) * s, { fill: url(P, 'spec'), filter: hi ? url(P, 'blurS') : null })));
    }
    if (d.finish !== 'matte') {
      ov.push(ellipseEl(px(G.fa + 120), py(G.yBelt - 70), 520 * s, 110 * s, { fill: url(P, 'hot'), opacity: 0.7 }));
      ov.push(ellipseEl(px(G.ra - 60), py(G.yBelt - 50), 480 * s, 120 * s, { fill: url(P, 'hot'), opacity: 0.7 }));
    }
    if (d.finish === 'chrome' || d.finish === 'candy') ov.push(rectEl(x0p, py(lerp(G.yb, G.yBelt, 0.5)), wp, 3, { fill: '#000', opacity: d.finish === 'chrome' ? 0.35 : 0.12 }));
    ov.push(rectEl(x0p, py(G.yb + (G.yBelt - G.yb) * 0.55), wp, (G.yBelt - G.yb) * 0.55 * s + 40, { fill: url(P, 'lowShade'), opacity: 0.8 }));
    ov.push(stripesSide(G, sp, o));
    // shut lines and character lines (clipped to the body)
    X.strokes(ov, sv.doorCuts); X.strokes(ov, sv.panelLines); X.strokes(ov, sv.characterLines, 'char');
    paintG.push(g({ 'clip-path': url(P, 'body') }, ov.join('')));
    paintG.push(pathEl(bodyD, { fill: 'none', stroke: shade(c.paint, -0.62), 'stroke-width': 1.1, 'stroke-linejoin': 'round' }));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, paintG.join('')));

    var det = [];
    X.slot(det, sv.lowerTrim, 'black'); X.slot(det, sv.sill, 'black');
    // roof option: body above the daylight opening (greenhouse is drawn over it)
    var gb = pr.gb;
    if (gb && !d.openTop && d.roof !== 'body') {
      var rxa = G.SX(gb.maxX + 0.04), rxb = G.SX(gb.minX - 0.04), ryt = G.SY(pr.yTop + 0.2), ryb = G.SY(gb.minY + (gb.maxY - gb.minY) * 0.3);
      var rfill = d.roof === 'glass' ? url(P, 'glass') : materialFill(P, d.roof, sp);
      var rg = rectEl(Math.min(rxa, rxb), ryt, Math.abs(rxb - rxa), ryb - ryt, { fill: rfill });
      if (d.roof === 'carbon' && hi) rg += rectEl(Math.min(rxa, rxb), ryt, Math.abs(rxb - rxa), ryb - ryt, { fill: url(P, 'carbonSheen') });
      if (d.roof === 'glass') rg += rectEl(Math.min(rxa, rxb), ryt, Math.abs(rxb - rxa), ryb - ryt, { fill: url(P, 'glassRef') });
      det.push(g({ 'clip-path': url(P, 'body') }, rg));
    }
    // raised soft top on open cars when a roof option is chosen
    if (d.openTop && d.roof !== 'body' && sv.softTop) X.slot(det, sv.softTop, 'black', null, function () { return d.roof === 'carbon' ? 'carbon' : d.roof === 'contrast' ? 'contrast' : 'gloss-black'; });
    X.slot(det, sv.greenhouse, 'trim');
    // glass: interior silhouettes through the tinted windows
    var wins = S.items(sv.windows);
    if (wins.length) {
      var wd = wins.map(function (it) { return X.dd(it.path); }).join(' '), wb = shBounds(sv.windows);
      det.push('<clipPath id="' + P + 'swin"><path d="' + wd + '"/></clipPath>');
      var inner = rectEl(G.SX(wb.maxX + 0.1), G.SY(wb.maxY + 0.1), (wb.w + 0.2) * k, (wb.h + 0.2) * k, { fill: '#0d1116' });
      var seatF = lerp(G.dlo.xFront, G.dlo.xRear, d.seats <= 2 || !d.rearSeats ? 0.55 : 0.42), seats = [seatF];
      if (d.seats > 2 && d.rearSeats && G.dlo.xRear - G.dlo.xFront > 1300) seats.push(lerp(G.dlo.xFront, G.dlo.xRear, 0.8));
      var hrTop = Math.min(G.yRoof - 150, G.yBelt + 430);
      seats.forEach(function (x) {
        inner += pathEl(roundRectD(px(x - 95), py(hrTop), 190 * s, 210 * s, 40 * s), { fill: shade(c.intP, 0.12) });
        inner += pathEl(roundRectD(px(x - 40), py(hrTop - 190), 300 * s, Math.max(10, hrTop - 190 - G.yBelt + 60) * s, 30 * s), { fill: shade(c.intP, -0.05) });
      });
      inner += ellipseEl(px(G.dlo.xFront + 300), py(G.yBelt + 140), 30 * s, 180 * s, { fill: 'none', stroke: '#0a0a0a', 'stroke-width': 26 * s, transform: 'rotate(-18 ' + f(px(G.dlo.xFront + 300)) + ' ' + f(py(G.yBelt + 140)) + ')' });
      if (d.rollCage !== 'none') inner += pathEl('M' + P2(px(G.dlo.xFront + 120), py(G.yBelt + 20)) + ' L' + P2(px(G.xRS + 120), py(G.yRoof - 110)) + ' L' + P2(px(G.xRE - 120), py(G.prof(G.xRE - 120) - 110)) + ' L' + P2(px(G.dlo.xRear - 80), py(G.yBelt + 20)), { fill: 'none', stroke: '#c7342b', 'stroke-width': 32 * s, 'stroke-linejoin': 'round', opacity: 0.9 });
      inner += rectEl(G.SX(wb.maxX + 0.1), G.SY(wb.maxY + 0.1), (wb.w + 0.2) * k, (wb.h + 0.2) * k, { fill: url(P, 'glass'), opacity: f2(clamp(0.55 + n.tint * 0.45, 0, 1)) });
      inner += rectEl(G.SX(wb.maxX + 0.1), G.SY(wb.maxY + 0.1), (wb.w + 0.2) * k, (wb.h + 0.2) * k, { fill: url(P, 'glassRef') });
      det.push(g({ 'clip-path': url(P, 'swin') }, inner));
      wins.forEach(function (it) { if (it.paint && it.paint !== 'glass') X.paintPath(det, it.path, it.paint); });
      det.push(pathEl(wd, { fill: 'none', stroke: '#050506', 'stroke-width': 1.1, 'stroke-linejoin': 'round' }));
    }
    X.slot(det, sv.windshield, 'glass');
    // open cars: the raked windscreen reads as a framed pane, not a floating stick
    S.items(sv.windshield).forEach(function (it) { var wdd = X.dd(it.path); if (wdd) det.push(pathEl(wdd, { fill: 'none', stroke: '#050506', 'stroke-width': Math.max(1.5, 0.012 * k), 'stroke-linejoin': 'round' })); });
    X.slot(det, sv.pillars, 'body');
    X.slot(det, sv.rollHoops, 'black');
    // wing struts that stop short of the deck: extend them down to the body surface so the wing is carried
    (fm.details || []).forEach(function (dt) {
      if (dt.view !== 'side' || !dt.path || (dt.role !== 'spoiler' && dt.role !== 'wing')) return;
      var sb0 = S.bounds(S.toPath(dt.path) || dt.path);
      if (sb0.empty || sb0.w > 0.6) return;
      var scx = (sb0.minX + sb0.maxX) / 2, deck = shSample(pr, pr.prof, scx);
      if (!(sb0.minY > deck + 0.008) || sb0.minY - deck > 0.35) return;
      var sw = Math.max(0.025, sb0.w * 0.18), sxa = G.SX(scx + sw / 2), sxb = G.SX(scx - sw / 2);
      det.push(rectEl(Math.min(sxa, sxb), G.SY(sb0.minY + 0.01), Math.abs(sxb - sxa), (sb0.minY + 0.01 - deck + 0.015) * k, { fill: url(P, 'carbon'), stroke: '#3a3d42', 'stroke-width': 0.6 }));
    });
    // side-specific details (fuel flap, charge port) are authored on the car's right side; this view shows the
    // left side (nose left), so they are not drawn here
    var sideKeep = function (role) { return role !== 'fuelCap' && role !== 'chargePort'; };
    // glass details (roof glass, quarter lights) stay inside the body / greenhouse silhouette
    var glassDet = [];
    X.details(glassDet, fm, function (role, dt) { return sideKeep(role) && dt.paint === 'glass'; });
    if (glassDet.length) {
      det.push('<clipPath id="' + P + 'sgc"><path d="' + bodyD + '"/>' + (G.shapeDloD ? '<path d="' + G.shapeDloD + '"/>' : '') + '</clipPath>');
      det.push(g({ 'clip-path': url(P, 'sgc') }, glassDet.join('')));
    }
    X.details(det, fm, function (role, dt) { return sideKeep(role) && dt.paint !== 'glass'; });
    // build exhaust tips poking out under the rear bumper
    // (the tip ends just inside the tail at its own height; tips set high in the tail face are hidden by the bumper)
    // models that author their own side-view tailpipe keep only that one (no doubled tip)
    var ownSideTip = (fm.details || []).some(function (dt) { return dt.view === 'side' && dt.role === 'exhaust'; });
    var tips = ownSideTip ? [] : shapeTips(fm, d).filter(function (t) { return !t.faux; }), rbB = shBounds(fm.rear.bumper);
    if (tips.length) {
      var hy = Infinity, hh = 0; tips.forEach(function (t) { hy = Math.min(hy, t.cy); hh = Math.max(hh, t.h); });
      // only body crossings behind the rear wheel arch count as the tail (not the sill, an arch edge or the nose)
      var xTailMax = fm.wheels.rear.x - (sv.archR && isFinite(sv.archR.r) ? sv.archR.r : fm.wheels.rear.r), xTip = Infinity;
      shCrossX(pr.body, hy).forEach(function (x) { if (x < xTailMax && x < xTip) xTip = x; });
      if (!isFinite(xTip)) xTip = pr.bb.minX;
      if (tips[0].down) {
        // van / pickup: the pipe drops out under the body just behind the rear wheel
        var dxp = fm.wheels.rear.x - (sv.archR && isFinite(sv.archR.r) ? sv.archR.r : fm.wheels.rear.r) - 0.14;
        var dyt = Math.max(hy + 0.02, shSample(pr, pr.low, dxp) + 0.02), dpw = Math.max(1.5, 0.06 * k), dpx = G.SX(dxp);
        var dtf = tips[0].fin === 'blued' ? url(P, 'blued') : url(P, 'chrome');
        det.push(pathEl(roundRectD(dpx - dpw / 2, G.SY(dyt), dpw * 1.6, Math.max(2, (dyt - hy + 0.02) * k), dpw * 0.3), { fill: dtf, stroke: '#2a2b2e', 'stroke-width': 0.5 }));
        det.push(ellipseEl(dpx + dpw * 0.3, G.SY(hy - 0.02), dpw * 0.8, Math.max(0.8, dpw * 0.25), { fill: '#080809' }));
      } else if (!(rbB && hy > rbB.maxY * 0.6)) {
        var tr = Math.max(1.2, hh / 2 * k), tl = 0.09 * k, tx = G.SX(xTip + 0.02), tf = tips[0].fin === 'blued' ? url(P, 'blued') : url(P, 'chrome');
        det.push(pathEl(roundRectD(tx - tl, G.SY(hy) - tr, tl, tr * 2, tr * 0.5), { fill: tf, stroke: '#2a2b2e', 'stroke-width': 0.5 }));
        det.push(ellipseEl(tx, G.SY(hy), tr * 0.35, tr, { fill: '#080809', stroke: tf, 'stroke-width': 1 }));
      }
    }
    det.push(aeroSide(G, sp, o));
    // race roundel on the door
    if (d.number || d.stripe === 'le-mans') {
      var dr0 = G.doors[0], rx = (dr0.x0 + dr0.x1) / 2, ry = lerp(G.yb, G.yBelt, 0.5), rr = Math.min(210, (G.yBelt - G.yb) * 0.32);
      det.push(circleEl(px(rx), py(ry), rr * s, { fill: '#f6f3ea', stroke: '#111', 'stroke-width': Math.max(1, rr * s * 0.07) }));
      if (d.number) det.push(textEl(px(rx), py(ry) + rr * s * 0.36, d.number, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(rr * s * (d.number.length > 2 ? 0.82 : 1.05)), fill: '#111' }));
    }
    car.push(g({ class: 'cbr-ghost' }, det.join('')));
    // arch lips, then the detailed wheels at the fitted axles
    var lips = '';
    [sv.archF, sv.archR].forEach(function (a) {
      if (!a || !isFinite(a.r)) return;
      var r = a.r * k, cx = G.SX(a.x), cy = G.SY(a.y), an = 0.25, lw = Math.max(1, (a.flare || 0) * k * 0.5 + 1);
      lips += pathEl('M' + P2(cx - r * Math.cos(an), cy + r * Math.sin(an)) + ' A' + f2(r) + ' ' + f2(r) + ' 0 0 1 ' + P2(cx + r * Math.cos(an), cy + r * Math.sin(an)), { fill: 'none', stroke: '#000', 'stroke-opacity': 0.45, 'stroke-width': f2(lw) });
    });
    car.push(g({ class: 'cbr-ghost' }, lips));
    var wf = fm.wheels.front, wr = fm.wheels.rear;
    var wh = wheelFace(sp, o, G.SX(wf.x), G.SY(wf.y), wf.r * 1000, wf.rimR * 1000, n.rotF, d.pisF, true, 0, s) +
      wheelFace(sp, o, G.SX(wr.x), G.SY(wr.y), wr.r * 1000, wr.rimR * 1000, n.rotR, d.pisR, false, 1, s);
    car.push(g({ class: 'cbr-ghost cbr-wheels' }, wh));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, wingSide(G, sp, o)));
    out.push(g({ id: P + 'car', class: 'cbr-car', 'data-model': fm.id }, car.join('')));
    if (o.xray) out.push(g({ class: 'cbr-xr' }, xraySide(G, sp, o)));
    return { markup: out.join(''), bounds: G.bounds, G: G };
  }

  /* ---------------------------------------------------------------- front / rear */
  /** an end-on tyre at the fitted track: rounded tread face with shoulders and a sidewall bulge at the contact
      patch, grooves + animated sipes and the rim lip edge-on at the hub. Drawn behind the body, so the bumper / arches hide whatever the real car hides. */
  function shapeTyreEnd(X, sp, o, w, sd, rear, idx) {
    var d = sp.d, n = sp.n, c = sp.c, P = o.P, k = X.T.scale, hi = o.detail !== 'low', out = [];
    var tw = Math.max(0.12, w.width || (rear ? n.twR : n.twF) / 1000), r = w.r, rimR = Math.min(w.rimR || r * 0.7, r * 0.92);
    var z = sd * w.track / 2, cx = X.x(z), out1 = X.x(z + sd * tw / 2) > cx ? 1 : -1;   // +1: outer sidewall on the screen right
    var W = tw * k, H = 2 * r * k, x0 = cx - W / 2, x1 = cx + W / 2, y1 = GROUND, y0 = GROUND - H;
    var rc = Math.min(W * 0.3, H * 0.2), bul = Math.max(0.6, W * 0.045), rb = Math.min(W * 0.22, H * 0.12);
    var cam = rear ? n.camR : n.camF, ang = clamp((out1 > 0 ? 1 : -1) * -cam, -6, 6);
    var gid = P + 'te' + idx;
    // tread face: dark sidewall edges, lit shoulders, darker top where it runs up into the arch
    out.push('<defs><linearGradient id="' + gid + 'h" gradientUnits="userSpaceOnUse" x1="' + f2(x0 - bul) + '" y1="0" x2="' + f2(x1 + bul) + '" y2="0">' +
      stops([[0, '#050506'], [0.06, '#16171a'], [0.13, '#2f3036'], [0.2, '#1c1d21'], [0.5, '#202125'], [0.8, '#1c1d21'], [0.87, '#2f3036'], [0.94, '#16171a'], [1, '#050506']]) + '</linearGradient>' +
      '<linearGradient id="' + gid + 'v" gradientUnits="userSpaceOnUse" x1="0" y1="' + f2(y0) + '" x2="0" y2="' + f2(y1) + '">' +
      stops([[0, '#000000', 0.75], [0.45, '#000000', 0.35], [0.85, '#000000', 0.05], [1, '#000000', 0.3]]) + '</linearGradient></defs>');
    var dd = 'M' + P2(x0 + rc, y0) + ' L' + P2(x1 - rc, y0) + ' Q' + P2(x1, y0) + ' ' + P2(x1, y0 + rc) +
      ' L' + P2(x1, y1 - rb * 1.8) + ' Q' + P2(x1 + bul, y1 - rb * 0.9) + ' ' + P2(x1 + bul * 0.4, y1 - rb * 0.15) + ' L' + P2(x1 - rb * 0.3, y1) +
      ' L' + P2(x0 + rb * 0.3, y1) + ' L' + P2(x0 - bul * 0.4, y1 - rb * 0.15) + ' Q' + P2(x0 - bul, y1 - rb * 0.9) + ' ' + P2(x0, y1 - rb * 1.8) +
      ' L' + P2(x0, y0 + rc) + ' Q' + P2(x0, y0) + ' ' + P2(x0 + rc, y0) + ' Z';
    var inner = pathEl(dd, { fill: 'url(#' + gid + 'h)' });
    var grooves = d.compound === 'slick' ? 0 : d.compound === 'track' ? 2 : d.compound === 'eco' || d.compound === 'touring' ? 4 : d.compound === 'performance' || d.compound === 'super-sport' ? 3 : 5;
    var cid = gid + 'c';
    inner += '<clipPath id="' + cid + '"><path d="' + dd + '"/></clipPath>';
    var tex = '';
    if (grooves) {
      var gl = '';
      for (var q = 1; q <= grooves; q++) { var gx = x0 + W * (0.16 + 0.68 * q / (grooves + 1)); gl += 'M' + P2(gx, y0) + ' L' + P2(gx, y1) + ' '; }
      tex += pathEl(gl, { stroke: '#040405', 'stroke-width': f2(Math.max(0.7, W * 0.04)), fill: 'none' });
      if (hi && grooves >= 2) {
        var sip = '', per = Math.max(2.2, H / 16), slope = d.compound === 'winter' || d.compound === 'all-season' ? 0.7 : 0.3;
        for (var j = -2; j < H / per + 2; j++) { var yy = y0 + j * per; sip += 'M' + P2(x0 + W * 0.14, yy) + ' L' + P2(x1 - W * 0.14, yy + per * slope) + ' '; }
        tex += g({ 'data-tread': 'y', 'data-period': f2(per) }, pathEl(sip, { stroke: '#060607', 'stroke-width': 0.7, fill: 'none', opacity: 0.85 }));
      }
    }
    // shoulder highlights and the shading towards the arch
    tex += pathEl('M' + P2(x0 + W * 0.13, y0 + rc * 0.6) + ' L' + P2(x0 + W * 0.13, y1 - rb * 1.4) + ' M' + P2(x1 - W * 0.13, y0 + rc * 0.6) + ' L' + P2(x1 - W * 0.13, y1 - rb * 1.4),
      { stroke: '#ffffff', 'stroke-opacity': 0.07, 'stroke-width': f2(Math.max(0.6, W * 0.05)), fill: 'none' });
    tex += rectEl(x0 - bul - 1, y0 - 1, W + bul * 2 + 2, H + 2, { fill: 'url(#' + gid + 'v)' });
    inner += g({ 'clip-path': 'url(#' + cid + ')' }, tex);
    inner += pathEl(dd, { fill: 'none', stroke: '#2a2b30', 'stroke-width': 0.7, 'stroke-linejoin': 'round' });
    // the rim's outer lip, edge-on at the hub, just inside the sidewall (everything else of the wheel sits
    // behind the tread face, as on the real car)
    var hy = GROUND - r * k, rh = rimR * k, lipW = Math.max(0.8, 0.014 * k);
    var xo = out1 > 0 ? x1 - lipW * 0.6 : x0 - lipW * 0.4;
    var rimFill = d.wheelMat === 'carbon' ? url(P, 'carbon') : c.rim;
    inner += pathEl(roundRectD(xo, hy - rh, lipW, rh * 2, lipW * 0.5), { fill: rimFill, stroke: shade(c.rim, -0.5), 'stroke-width': 0.3 });
    inner += pathEl(roundRectD(xo + (out1 > 0 ? lipW * 0.25 : lipW * 0.35), hy - rh * 0.92, lipW * 0.4, rh * 0.6, lipW * 0.2), { fill: '#ffffff', opacity: 0.35 });
    out.push(g({ id: gid + 'g', transform: 'rotate(' + f2(ang) + ' ' + f(cx) + ' ' + f(y1) + ')' }, inner));
    return out.join('');
  }
  /** contact shadows under the end-view tyres (drawn on the floor, in front of the studio) */
  function shapeTyreShadow(X, P, w, sd, hi) {
    var k = X.T.scale, cx = X.x(sd * w.track / 2), W = Math.max(0.12, w.width) * k;
    return ellipseEl(cx, GROUND + 1.5, W * 1.25, Math.max(3, 0.03 * k), { fill: '#000', opacity: 0.55, filter: hi ? url(P, 'blurM') : null }) +
      ellipseEl(cx, GROUND + 0.6, W * 0.6, Math.max(1.2, 0.011 * k), { fill: '#000', opacity: 0.9, filter: hi ? url(P, 'blurS') : null });
  }
  /** lowest body edge at a horizontal position a (polylines in view coordinates), or null */
  function shLowAt(polys, a) {
    var lo = Infinity;
    polys.forEach(function (pl) {
      var p = pl.pts;
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
        var A = p[j], B = p[i];
        if ((A[0] <= a && B[0] >= a) || (B[0] <= a && A[0] >= a)) {
          var y = B[0] === A[0] ? Math.min(A[1], B[1]) : A[1] + (B[1] - A[1]) * (a - A[0]) / (B[0] - A[0]);
          if (y < lo) lo = y;
        }
      }
    });
    return isFinite(lo) ? lo : null;
  }
  /** end views: the wheel arch seen past the bumper corner. Where the tyre runs up behind the body corner and
      nothing (lamps, intakes, plate, diffuser) sits in front of it, a shadowed arch opening shows the tyre
      continuing up into the wheelhouse, fading into the dark at the top. Clipped to the body by the caller. */
  function archOpenings(X, fm, v, w, rear, P) {
    var S = CB.shapes, k = X.T.scale, out = '';
    if (!w || !(w.r > 0) || !(w.track > 0)) return '';
    var polys = shPolys(v.body), bb = shBounds(v.body);
    if (!bb) return '';
    var keys = rear ? ['taillights', 'lightBar', 'diffuser', 'plateArea', 'bumper'] : ['grille', 'intakes', 'headlights', 'drl', 'fogLights', 'plateArea', 'splitter'];
    var blocks = [];
    keys.forEach(function (key) { S.items(v[key]).forEach(function (it) { if (key === 'bumper' && (!it.paint || it.paint === 'body')) return; var b = S.bounds(it.path); if (!b.empty) blocks.push(b); }); });
    (fm.details || []).forEach(function (dt) { if (dt.view === (rear ? 'rear' : 'front') && dt.path) { var b = S.bounds(S.toPath(dt.path) || dt.path); if (!b.empty && b.h < 0.6) blocks.push(b); } });
    if (rear) (fm.rear.exhaust || []).forEach(function (e) { if (e && isFinite(e.cx)) blocks.push({ minX: e.cx - (e.w || 0.1) / 2, maxX: e.cx + (e.w || 0.1) / 2, minY: e.cy - (e.h || 0.1) / 2, maxY: e.cy + (e.h || 0.1) / 2 }); });
    var gb = shBounds(v.greenhouse), belt = gb ? gb.minY : bb.maxY * 0.6;
    [-1, 1].forEach(function (sd, idx) {
      var zc = sd * w.track / 2, half = Math.max(0.12, w.width) / 2;
      var za = Math.min(zc - half, zc + half), zb = Math.max(zc - half, zc + half);
      var yTop = Math.min(2 * w.r * 0.66, belt * 0.62);
      // the opening never runs through a lamp, intake or plate in front of the tyre
      blocks.forEach(function (b) {
        var ov = Math.min(zb, b.maxX) - Math.max(za, b.minX);
        if (ov > 0.015 && b.minY < yTop) yTop = Math.min(yTop, b.minY - 0.02);
      });
      // inner edge: where the body bottom is still low enough to hide the tyre top
      var zi = sd > 0 ? za : zb, zo = sd > 0 ? zb + 0.06 : za - 0.06;
      var low = shLowAt(polys, zc);
      if (low == null || yTop - low < 0.05) return;
      var y0 = Math.max(0, Math.min(low, yTop) - 0.02);
      var xa = X.x(zi), xb = X.x(zo), x0 = Math.min(xa, xb), ww = Math.abs(xb - xa), ya = X.y(yTop), yb = X.y(y0), hh = yb - ya;
      if (!(ww > 2) || !(hh > 2)) return;
      var rad = Math.min(ww * 0.55, hh * 0.9), inL = X.x(zi) < X.x(zo);
      // arch shape: round at the top inner corner, square to the body side
      var dd = inL ? 'M' + P2(x0, yb) + ' L' + P2(x0, ya + rad) + ' Q' + P2(x0, ya) + ' ' + P2(x0 + rad, ya) + ' L' + P2(x0 + ww, ya) + ' L' + P2(x0 + ww, yb) + ' Z'
        : 'M' + P2(x0 + ww, yb) + ' L' + P2(x0 + ww, ya + rad) + ' Q' + P2(x0 + ww, ya) + ' ' + P2(x0 + ww - rad, ya) + ' L' + P2(x0, ya) + ' L' + P2(x0, yb) + ' Z';
      var id = P + 'ao' + (rear ? 'r' : 'f') + idx;
      out += '<defs><clipPath id="' + id + 'c"><path d="' + dd + '"/></clipPath>' +
        '<linearGradient id="' + id + 'g" gradientUnits="userSpaceOnUse" x1="0" y1="' + f2(ya) + '" x2="0" y2="' + f2(yb) + '">' + stops([[0, '#000000', 0.95], [0.55, '#000000', 0.55], [1, '#000000', 0.15]]) + '</linearGradient></defs>';
      out += g({ 'clip-path': 'url(#' + id + 'c)' },
        rectEl(x0 - 2, ya - 2, ww + 4, hh + 4, { fill: '#060607' }) +
        '<use href="#' + P + 'te' + idx + 'g" xlink:href="#' + P + 'te' + idx + 'g"/>' +
        rectEl(x0 - 2, ya - 2, ww + 4, hh + 4, { fill: 'url(#' + id + 'g)' }));
      // the arch lip catches a little light
      out += pathEl(inL ? 'M' + P2(x0, yb) + ' L' + P2(x0, ya + rad) + ' Q' + P2(x0, ya) + ' ' + P2(x0 + rad, ya) + ' L' + P2(x0 + ww, ya)
        : 'M' + P2(x0 + ww, yb) + ' L' + P2(x0 + ww, ya + rad) + ' Q' + P2(x0 + ww, ya) + ' ' + P2(x0 + ww - rad, ya) + ' L' + P2(x0, ya),
        { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.16, 'stroke-width': 0.8 });
    });
    return out;
  }
  function drawShapeCross(sp0, o, ent, rear) {
    var S = CB.shapes, fm = ent.f, v = rear ? fm.rear : fm.front, sp = shapeSpec(sp0, ent), G = shapeSideG(sp, ent);
    var C = crossGeom(sp), n = sp.n, d = sp.d, c = sp.c, P = o.P, s = C.s, k = s * 1000, px = C.px, py = C.py, hw = C.hw, hi = o.detail !== 'low';
    var T = { scale: k, ox: VBW / 2, oy: GROUND, flipX: !rear, flipY: true };
    var vName0 = rear ? 'rear' : 'front', X = shCtx(P, vName0, T, sp, hi);
    X.fm = fm;
    var gb = shBounds(v.greenhouse);
    C.G = G; C.yRoof = G.yRoof; C.yBelt = gb ? gb.minY * 1000 : G.yBelt; C.yCowl = C.yBelt; C.yNose = G.yNose; C.yDeck = G.yDeck; C.yTail = G.yTail;
    var outline = S.items(v.body).map(function (it) { return X.dd(it.path); }).join(' ');
    C.shapeBodyD = outline;
    var out = [], car = [];
    out.push('<defs><clipPath id="' + P + 'xbody"><path d="' + outline + '"/></clipPath></defs>');
    out.push(studio(P, d, o.backdrop || 'soft', GROUND, VBW / 2, (Math.max(hw, n.track / 2 + n.twF / 2) + 260) * s));
    out.push(ellipseEl(VBW / 2, GROUND + 3, (Math.max(hw, n.track / 2 + n.twF / 2) + 160) * s, 18, { fill: url(P, 'shadow') }));
    var wSh = rear ? fm.wheels.rear : fm.wheels.front;
    out.push(shapeTyreShadow(X, P, wSh, -1, hi) + shapeTyreShadow(X, P, wSh, 1, hi));
    if (!rear) car.push(g({ class: 'cbr-ghost' }, wingCross(C, sp, o, false)));
    var wtr = rear ? fm.wheels.rear.track : fm.wheels.front.track;
    // underbody: a shadow fading from the real body bottom to the floor (not a solid block); tall cars show
    // the axle and differential through the gap instead
    var ubB = shBounds(v.body), ubW = rear ? fm.wheels.rear : fm.wheels.front;
    if (ubB && isFinite(ubB.minY) && ubB.minY > 0.01) {
      var ubHalf = Math.max(0.2, wtr / 2 - (rear ? fm.dims.tireWidthR : fm.dims.tireWidthF) / 2), ubTop = Math.min(ubB.minY + 0.04, ubB.minY * 1.6);
      var ubId = P + 'ub' + (rear ? 'r' : 'f');
      car.push('<defs><linearGradient id="' + ubId + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + f2(X.y(ubTop)) + '" x2="0" y2="' + f2(GROUND) + '">' + stops([[0, '#060608', 0.85], [0.35, '#060608', 0.6], [1, '#060608', 0]]) + '</linearGradient></defs>');
      if (ubB.minY > 0.2) {
        var axY = X.y(ubW.y), axH = Math.max(1.5, 0.07 * k), dfW = Math.min(0.32, ubHalf * 0.4) * k, dfH = Math.min(0.24, ubB.minY - 0.06) * k, ush = '';
        ush += rectEl(px(-ubHalf * 1000), X.y(ubB.minY + 0.03), ubHalf * 2 * k, Math.min(0.12, ubB.minY * 0.4) * k, { fill: '#08080a', opacity: 0.75 });
        ush += pathEl(roundRectD(px(-ubHalf * 1000), axY - axH / 2, ubHalf * 2 * k, axH, axH * 0.45), { fill: '#141518', stroke: '#2b2d31', 'stroke-width': 0.5 });
        ush += ellipseEl(X.x(0), axY, dfW / 2, dfH / 2, { fill: '#121316', stroke: '#2b2d31', 'stroke-width': 0.6 });
        ush += ellipseEl(X.x(0), axY + dfH * 0.12, dfW * 0.22, dfH * 0.2, { fill: '#050506' });
        car.push(g({ class: 'cbr-under' }, ush));
      } else car.push(rectEl(px(-ubHalf * 1000), X.y(ubTop), ubHalf * 2 * k, Math.max(1, GROUND - X.y(ubTop)), { fill: url(P, 'ub' + (rear ? 'r' : 'f')) }));
    } else car.push(rectEl(px(-C.xIn), py(C.yb + 40), C.xIn * 2 * s, Math.min(C.yb + 40, 170) * s, { fill: '#08080a', opacity: 0.92 }));
    // side skirts sit behind the tyres, inside the body width
    if (d.skirts) {
      var skO = Math.min(fm.dims.width / 2 - 0.02, wtr / 2 + (rear ? fm.dims.tireWidthR : fm.dims.tireWidthF) / 2 - 0.03) * 1000, skY = G.yb;
      [-1, 1].forEach(function (sd) { car.push(rectEl(px(sd > 0 ? skO - 120 : -skO), py(skY + 35), 120 * s, 60 * s, { fill: url(P, 'carbon') })); });
    }
    var wEnd = rear ? fm.wheels.rear : fm.wheels.front;
    car.push(g({ class: 'cbr-ghost cbr-wheels' }, shapeTyreEnd(X, sp, o, wEnd, -1, rear, 0) + shapeTyreEnd(X, sp, o, wEnd, 1, rear, 1)));
    // pickups: tailpipes exit behind / under the rear bumper, so draw them first and let the body cover their tops
    var pickupTips = rear && fm.style === 'pickup';
    if (pickupTips) {
      var pbB = shBounds(v.bumper) || shBounds(v.body);
      shapeTips(fm, d).forEach(function (t) { car.push(tipMarkup(X, P, assign({}, t, { cy: pbB ? Math.min(t.cy, pbB.minY + 0.05) : t.cy }))); });
    }
    // body + finish overlays + stripes
    var bodyG = [pathEl(outline, { fill: url(P, 'paint') })], ov = [];
    var topPx = py(C.yRoof + 80), botPx = py(C.yb - 20);
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') ov.push(rectEl(px(-hw - 50), topPx, (hw * 2 + 100) * s, botPx - topPx, { fill: url(P, 'flake'), opacity: f2(0.06 + d.metallic * 0.16) }));
    ov.push(rectEl(px(-hw - 50), topPx, (hw * 2 + 100) * s, botPx - topPx, { fill: url(P, 'edgeShade') }));
    ov.push(rectEl(px(-hw - 50), topPx, (hw * 2 + 100) * s, py(C.yBelt) - topPx, { fill: url(P, 'topLight') }));
    ov.push(rectEl(px(-hw - 50), py(C.yb + (C.yBelt - C.yb) * 0.45), (hw * 2 + 100) * s, (C.yBelt - C.yb) * 0.45 * s + 20, { fill: url(P, 'lowShade') }));
    var st = d.stripe, sc = c.stripe;
    var band = function (x0, w, op) { ov.push(rectEl(px(x0), topPx, w * s, botPx - topPx, { fill: sc, opacity: op || 0.95 })); };
    if (st === 'racing-dual') { band(-hw * 0.26, hw * 0.17); band(hw * 0.09, hw * 0.17); }
    else if (st === 'center') band(-hw * 0.2, hw * 0.4);
    else if (st === 'le-mans') { band(rear ? hw * 0.12 : -hw * 0.36, hw * 0.24); band(rear ? hw * 0.39 : -hw * 0.41, hw * 0.025); }
    else if (st === 'hood' && !rear) ov.push(rectEl(px(-hw * 0.3), py(C.yBelt + 10), hw * 0.6 * s, (C.yBelt + 10 - C.yNose + 120) * s, { fill: sc, opacity: 0.85 }));
    else if (st === 'side-skirt' || st === 'gradient') [-1, 1].forEach(function (sd) { ov.push(rectEl(px(sd > 0 ? hw * 0.9 : -hw * 1.02), py(C.yb + 160), hw * 0.12 * s, 110 * s, { fill: sc, opacity: st === 'gradient' ? 0.5 : 0.95 })); });
    else if (st === 'pinstripe') ov.push(pathEl('M' + P2(px(-hw * 0.96), py(C.yBelt - 45)) + ' L' + P2(px(hw * 0.96), py(C.yBelt - 45)), { stroke: sc, 'stroke-width': 1.1 }));
    // bumper outline (shut line) or contrasting bumper
    S.items(v.bumper).forEach(function (it) {
      if (it.paint && it.paint !== 'body') X.paintPath(ov, it.path, it.paint);
      else ov.push(pathEl(X.dd(it.path), { fill: 'none', stroke: '#000', 'stroke-opacity': 0.45, 'stroke-width': 1 }));
    });
    X.strokes(ov, v.panelLines); X.strokes(ov, v.characterLines, 'char');
    ov.push(archOpenings(X, fm, v, wEnd, rear, P));
    bodyG.push(g({ 'clip-path': url(P, 'xbody') }, ov.join('')));
    bodyG.push(pathEl(outline, { fill: 'none', stroke: shade(c.paint, -0.62), 'stroke-width': 1.1 }));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, bodyG.join('')));

    var det = [];
    // roof option above the windscreen / back light
    if (gb && !d.openTop && d.roof !== 'body') {
      var rf = d.roof === 'glass' ? url(P, 'glass') : materialFill(P, d.roof, sp);
      det.push(g({ 'clip-path': url(P, 'xbody') }, rectEl(px(-hw - 60), py(C.yRoof + 200), (hw * 2 + 120) * s, (C.yRoof + 200 - gb.maxY * 1000 + 40) * s, { fill: rf })));
    }
    if (d.openTop && d.roof !== 'body' && v.softTop) X.slot(det, v.softTop, 'black', null, function () { return d.roof === 'carbon' ? 'carbon' : 'gloss-black'; });
    else if (d.openTop && gb) {
      // top down: the screen frame (and anything above the belt) is black trim, not a closed body-colour header
      var fp = S.items(fm.side.pillars).map(function (it) { return it.paint; }).filter(function (q) { return q && q !== 'body'; })[0] || 'gloss-black';
      det.push(g({ 'clip-path': url(P, 'xbody') }, rectEl(px(-hw - 60), py(C.yRoof + 300), (hw * 2 + 120) * s, (C.yRoof + 300 - gb.minY * 1000 + 10) * s, shPaint(P, fp, vName0, d))));
    }
    // glass: windscreen / back light with the cabin behind it
    S.items(v.greenhouse).forEach(function (it, gi) {
      if (it.paint && it.paint !== 'glass') { X.paintPath(det, it.path, it.paint); return; }
      var dd = X.dd(it.path), b = X.pbox(it.path);
      if (!b) return;
      var id = P + 'xgl' + gi;
      det.push('<clipPath id="' + id + '"><path d="' + dd + '"/></clipPath>');
      if (!rear && d.openTop && !(d.roof !== 'body' && v.softTop)) {
        // top down: the screen is a framed pane you see through: rear deck, roll hoops and headrests behind it,
        // open sky above them (no dark closed cabin)
        var thru = rectEl(b.x - 4, b.y - 4, b.w + 8, b.h + 8, { fill: url(P, 'glass'), opacity: f2(clamp(0.12 + n.tint * 0.25, 0, 0.4)) });
        var rbd = S.items(fm.rear.body).map(function (q) { return X.dd(q.path); }).join(' ');
        if (rbd) thru += pathEl(rbd, { fill: url(P, 'paint') }) + pathEl(rbd, { fill: '#000', opacity: 0.35 });
        var hrY = gb ? gb.minY + (gb.maxY - gb.minY) * 0.42 : 1;
        var hoops = S.items(fm.rear.rollHoops);
        hoops.forEach(function (q) {
          var hd = X.dd(q.path);
          if (!hd) return;
          thru += pathEl(hd, { fill: 'none', stroke: '#16171a', 'stroke-width': Math.max(2, 0.06 * k), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
          var hb = X.pbox(q.path);
          if (hb) thru += pathEl(roundRectD(hb.cx - hb.w * 0.32, hb.y + hb.h * 0.12, hb.w * 0.64, hb.h * 0.62, hb.w * 0.2), { fill: shade(c.intP, -0.25) });
        });
        if (!hoops.length) [-1, 1].forEach(function (sd) { thru += pathEl(roundRectD(px(sd * hw * 0.34 - 110), py(hrY * 1000 + 110), 220 * s, 200 * s, 60 * s), { fill: shade(c.intP, -0.2) }); });
        thru += ellipseEl(px(hw * 0.34), b.y + b.h * 0.9, 150 * s, 60 * s, { fill: 'none', stroke: '#050506', 'stroke-width': 26 * s });
        thru += rectEl(b.x - 4, b.y - 4, b.w + 8, b.h + 8, { fill: url(P, 'glassRef'), opacity: 0.7 });
        det.push(g({ 'clip-path': 'url(#' + id + ')' }, thru));
        det.push(pathEl(dd, { fill: 'none', stroke: '#050506', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
        return;
      }
      var inside = rectEl(b.x - 4, b.y - 4, b.w + 8, b.h + 8, { fill: '#0d1116' });
      var seatsN = d.seats > 1 ? 2 : 1;
      for (var si = 0; si < seatsN; si++) {
        var sx = seatsN === 1 ? 0 : (si ? 1 : -1) * hw * 0.34;
        inside += pathEl(roundRectD(px(sx - 110), b.y + b.h * 0.35, 220 * s, b.h, 60 * s), { fill: shade(c.intP, 0.1) });
      }
      if (!rear) inside += ellipseEl(px(hw * 0.34), b.y + b.h * 0.86, 150 * s, 60 * s, { fill: 'none', stroke: '#050506', 'stroke-width': 26 * s });
      inside += rectEl(b.x - 4, b.y - 4, b.w + 8, b.h + 8, { fill: url(P, 'glass'), opacity: f2(clamp(0.55 + n.tint * 0.42, 0, 1)) });
      inside += rectEl(b.x - 4, b.y - 4, b.w + 8, b.h + 8, { fill: url(P, 'glassRef') });
      det.push(g({ 'clip-path': 'url(#' + id + ')' }, inside));
      det.push(pathEl(dd, { fill: 'none', stroke: '#050506', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    });
    X.slot(det, v.windows, 'glass');
    if (!rear) {
      X.slot(det, v.grille, 'grille');
      var lkF = X.lookOf();
      if (lkF && lkF.grille) S.items(v.grille).forEach(function (it) { if (!it.paint || it.paint === 'grille') X.look(det, 'grille', lkF.grille, it.path, X.dirOf(it.path)); });
      X.slot(det, v.intakes, 'grille');
      S.items(v.headlights).forEach(function (it) {
        X.paintPath(det, it.path, it.paint || 'light');
        if (it.paint && it.paint !== 'light') return;
        if (!(lkF && X.look(det, 'head', lkF.head, it.path, X.dirOf(it.path)))) X.lampAccent(det, it.path);
        else if (d.lights === 'laser') { var lb0 = X.pbox(it.path); if (lb0) det.push(circleEl(lb0.cx, lb0.cy, Math.max(0.6, Math.min(lb0.w, lb0.h) * 0.08), { fill: '#3a8bff', filter: hi ? url(P, 'glow') : null })); }
      });
      X.slot(det, v.drl, 'light', 'drl');
      X.slot(det, v.fogLights, 'light');
      X.slot(det, v.splitter, 'carbon');
    } else {
      X.slot(det, v.diffuser, 'black');
      if (!pickupTips) shapeTips(fm, d).forEach(function (t) { det.push(tipMarkup(X, P, t)); });
      X.slot(det, v.taillights, 'light-red');
      X.slot(det, v.lightBar, 'light-red');
      var lkR = X.lookOf();
      if (lkR && lkR.tail) {
        S.items(v.taillights).forEach(function (it) { if (!it.paint || it.paint === 'light-red') X.look(det, 'tail', lkR.tail, it.path, X.dirOf(it.path)); });
        S.items(v.lightBar).forEach(function (it) { if (!it.paint || it.paint === 'light-red') X.look(det, 'tail', 'light-bar', it.path, 1); });
        // full-width signature without an authored light bar: a thin lit strip bridging the two lamps
        if ((lkR.tail === 'full-width' || lkR.tail === 'light-bar') && !S.items(v.lightBar).length) {
          var tls = S.items(v.taillights).map(function (it) { return X.pbox(it.path); }).filter(Boolean);
          var lt0 = tls.filter(function (q) { return q.cx < X.x(0); }), rt0 = tls.filter(function (q) { return q.cx > X.x(0); });
          if (lt0.length && rt0.length) {
            var la = lt0.reduce(function (a2, q) { return q.x + q.w > a2.x + a2.w ? q : a2; }), ra = rt0.reduce(function (a2, q) { return q.x < a2.x ? q : a2; });
            var byy = (la.cy + ra.cy) / 2, bh2 = Math.max(1, Math.min(la.h, ra.h) * 0.16);
            if (ra.x - (la.x + la.w) > 4) {
              det.push(pathEl(roundRectD(la.x + la.w - 1, byy - bh2 / 2, ra.x - la.x - la.w + 2, bh2, bh2 / 2), { fill: url(P, 'tailL'), stroke: '#2a0004', 'stroke-width': 0.4 }));
              det.push(lineEl(la.x + la.w, byy, ra.x, byy, { stroke: '#ff5446', 'stroke-width': f2(Math.max(0.5, bh2 * 0.4)), filter: hi ? url(P, 'glow') : null }));
            }
          }
        }
      }
      X.slot(det, v.spoiler, 'body');
    }
    X.slot(det, v.rollHoops, 'black');
    X.details(det, fm);
    // models without front/rear mirror art: project the side-view mirror out to the body sides
    var vName = rear ? 'rear' : 'front', dets = fm.details || [];
    if (!dets.some(function (dt) { return dt.view === vName && dt.role === 'mirror'; })) {
      var smir = dets.filter(function (dt) { return dt.view === 'side' && dt.role === 'mirror' && dt.path; })[0];
      var mb = smir ? S.bounds(S.toPath(smir.path) || smir.path) : null;
      if (mb && !mb.empty && mb.h > 0.02) {
        var mPaint = shMirrorPaint(smir.paint || 'body', d), mzc = fm.dims.width / 2 + 0.05;
        // the stalk starts at the real body / A-pillar edge at its height (hypercar mirrors sit high, where the
        // body is narrow), is drawn as a solid arm, and the cap is pulled inboard so it never floats
        var stY = mb.minY + mb.h * 0.3, edgeSp = shSpanAtY(shPolys(v.body).concat(shPolys(v.greenhouse)), stY);
        var edgeZ = edgeSp ? Math.max(Math.abs(edgeSp[0]), Math.abs(edgeSp[1])) : fm.dims.width / 2 - 0.08;
        mzc = Math.max(edgeZ + 0.1, Math.min(mzc, edgeZ + 0.26));
        [-1, 1].forEach(function (sd) {
          var xa = X.x(sd * (mzc - 0.08)), xb = X.x(sd * (mzc + 0.08)), ya = X.y(mb.maxY), yb2 = X.y(mb.minY);
          var mx = Math.min(xa, xb), mw = Math.abs(xb - xa), mh = Math.abs(yb2 - ya), my = Math.min(ya, yb2);
          var sx0 = X.x(sd * (edgeZ - 0.03)), sx1 = X.x(sd * (mzc - 0.05)), sth = Math.max(1.6, 0.025 * k);
          det.push(pathEl(roundRectD(Math.min(sx0, sx1), X.y(stY) - sth / 2, Math.abs(sx1 - sx0), sth, sth * 0.4), assign({}, shPaint(P, mPaint === 'body' ? 'gloss-black' : mPaint, vName, d), { stroke: '#050506', 'stroke-width': 0.4 })));
          det.push(pathEl(roundRectD(mx, my, mw, mh, Math.min(mw, mh) * 0.35), assign({}, shPaint(P, mPaint, vName, d), { stroke: '#050506', 'stroke-width': 0.6 })));
          if (rear) det.push(pathEl(roundRectD(mx + mw * 0.12, my + mh * 0.16, mw * 0.76, mh * 0.66, Math.min(mw, mh) * 0.25), { fill: url(P, 'glass') }));
          else if (mPaint === 'body') det.push(pathEl(roundRectD(mx, my, mw, mh, Math.min(mw, mh) * 0.35), { fill: url(P, 'topLight'), opacity: 0.6 }));
        });
      }
    }
    // number plate and badge last, so grille / diffuser slats and details never run through them
    X.slot(det, v.plateArea, 'plate');
    X.text(det, v.plateArea, d.number ? 'RDL ' + d.number : 'RPM WORKS', true);
    if (d.badge !== 'delete') {
      var bt = fm.badgeText, side = rear ? 'rear' : 'front';
      var btxt = v.badgeText != null ? v.badgeText : bt && typeof bt === 'object' ? (bt[side] != null ? bt[side] : rear ? fm.name : fm.make) : bt || (rear ? fm.name : fm.make);
      X.text(det, v.badgeArea, typeof btxt === 'string' ? btxt : '');
    }
    // build options layered on top
    if (!rear) {
      if (d.splitter !== 'none' && d.splitter !== 'lip') {
        var spw = hw * (d.splitter === 'race' ? 1.0 : 0.94);
        det.push(pathEl(roundRectD(px(-spw), py(C.yb + 34), spw * 2 * s, (d.splitter === 'race' ? 30 : 22) * s, 6 * s), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
        if (d.splitter === 'race') [-1, 1].forEach(function (sd) { det.push(rectEl(px(sd * spw) - (sd > 0 ? 14 * s : 0), py(C.yb + 110), 14 * s, 90 * s, { fill: url(P, 'carbon') })); det.push(lineEl(px(sd * spw * 0.6), py(C.yb + 30), px(sd * spw * 0.5), py(C.yb + 160), { stroke: '#a7adb5', 'stroke-width': 1.2 })); });
      } else if (d.splitter === 'lip') {
        det.push(pathEl(roundRectD(px(-hw * 0.84), py(C.yb + 30), hw * 1.68 * s, 16 * s, 5 * s), { fill: url(P, 'gblack'), stroke: '#000', 'stroke-width': 0.5 }));
      }
      if (d.canards) [-1, 1].forEach(function (sd) {
        [0.3, 0.52].forEach(function (fr) { var yy = C.yb + (C.yNose - C.yb) * fr; det.push(pathEl(polyD([[px(sd * hw * 0.86), py(yy)], [px(sd * (hw + 70)), py(yy + 30)], [px(sd * (hw + 70)), py(yy + 12)], [px(sd * hw * 0.86), py(yy - 18)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.5 })); });
      });
      if (d.number) {
        var nyy = lerp(C.yNose, C.yBelt, 0.25);
        det.push(circleEl(px(-hw * 0.32), py(nyy), 66 * s, { fill: '#f6f3ea', stroke: '#111', 'stroke-width': 1 }));
        det.push(textEl(px(-hw * 0.32), py(nyy) + 22 * s, d.number, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(62 * s), fill: '#111' }));
      }
    } else {
      if ((d.diffuser === 'carbon' || d.diffuser === 'race') && fm.style !== 'pickup') {
        var dw = hw * (d.diffuser === 'race' ? 0.82 : 0.7), dh = d.diffuser === 'race' ? 200 : 150, strakes = d.diffuser === 'race' ? 7 : 5, stk = '';
        det.push(pathEl(polyD([[px(-dw), py(C.yb + dh * 0.5)], [px(dw), py(C.yb + dh * 0.5)], [px(dw * 1.05), py(C.yb - 10)], [px(-dw * 1.05), py(C.yb - 10)]], true), { fill: url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6, opacity: 0.92 }));
        for (var kk = 0; kk < strakes; kk++) { var xx = -dw + 2 * dw * (kk + 0.5) / strakes; stk += 'M' + P2(px(xx), py(C.yb + dh * 0.5)) + ' L' + P2(px(xx * 1.05), py(C.yb - 30)) + ' '; }
        det.push(pathEl(stk, { stroke: '#1d1f23', 'stroke-width': Math.max(1.5, 14 * s), fill: 'none' }));
        if (d.diffuser === 'race') det.push(rectEl(px(-40), py(C.yb + dh * 0.5 - 10), 80 * s, 60 * s, { fill: '#ff2a2a', opacity: 0.85 }));
      }
      if (d.wing === 'ducktail') det.push(pathEl('M' + P2(px(-hw * 0.8), py(C.yDeck + 20)) + ' Q' + P2(px(0), py(C.yDeck + 70)) + ' ' + P2(px(hw * 0.8), py(C.yDeck + 20)) + ' L' + P2(px(hw * 0.8), py(C.yDeck - 30)) + ' L' + P2(px(-hw * 0.8), py(C.yDeck - 30)) + ' Z', { fill: url(P, 'paint'), stroke: shade(c.paint, -0.6), 'stroke-width': 0.8 }));
      if (d.wing === 'lip-spoiler') det.push(pathEl(roundRectD(px(-hw * 0.7), py(C.yDeck + 40), hw * 1.4 * s, 30 * s, 10 * s), { fill: url(P, 'gblack') }));
    }
    car.push(g({ class: 'cbr-ghost' }, det.join('')));
    if (rear) car.push(g({ class: 'cbr-ghost' }, wingCross(C, sp, o, true)));
    out.push(g({ id: P + 'car', class: 'cbr-car', 'data-model': fm.id }, car.join('')));
    if (o.xray) out.push(g({ class: 'cbr-xr' }, xrayCross(C, sp, o, rear)));
    var top = Math.min(py(C.yRoof + 300), py(G.topMm + 120));
    var bw = (Math.max(hw, n.track / 2 + n.twF / 2) + 340) * s;
    return { markup: out.join(''), bounds: { x: VBW / 2 - bw, y: top, w: bw * 2, h: GROUND + 30 - top }, C: C };
  }

  /* ---------------------------------------------------------------- top (plan) */
  function drawShapeTop(sp0, o, ent) {
    var S = CB.shapes, fm = ent.f, v = fm.top, sp = shapeSpec(sp0, ent), G = shapeSideG(sp, ent), pr = G.pr;
    var n = sp.n, d = sp.d, c = sp.c, P = o.P, s = G.s, k = G.k, L = G.L, hi = o.detail !== 'low';
    var Tt = { G: G, n: n, d: d, s: s, L: L, cy: 252 };
    Tt.px = G.px; Tt.py = function (y) { return Tt.cy + y * s; };
    Tt.hwAt = function (mm) { return shSample(pr, pr.hw, fm.dims.xFront - mm / 1000) * 1000; };
    var px = Tt.px, py = Tt.py;
    var X = shCtx(P, 'top', { scale: k, ox: G.T.ox, oy: Tt.cy, flipX: true, flipY: true }, sp, hi);
    var outline = S.items(v.body).map(function (it) { return X.dd(it.path); }).join(' ');
    Tt.shapeBodyD = outline;
    var out = [], car = [];
    out.push('<defs><clipPath id="' + P + 'pbody"><path d="' + outline + '"/></clipPath></defs>');
    if (o.backdrop === 'full') out.push(rectEl(0, 0, VBW, VBH, { fill: url(P, 'studio') }));
    out.push(pathEl(outline, { fill: '#000', opacity: d.theme === 'light' ? 0.22 : 0.5, transform: 'translate(6 12)', filter: hi ? url(P, 'blur') : null }));
    // tyres at the fitted axles / tracks
    var tyres = '';
    [fm.wheels.front, fm.wheels.rear].forEach(function (w, wi) {
      [-1, 1].forEach(function (sd) {
        var x0 = G.SX(w.x + w.r * 0.95), y0 = py(sd * w.track * 500 - w.width * 500), ww = w.r * 1.9 * k, hh = w.width * k;
        var id = P + 'pt' + wi + (sd > 0 ? 'b' : 'a');
        tyres += '<clipPath id="' + id + '"><path d="' + roundRectD(x0, y0, ww, hh, hh * 0.3) + '"/></clipPath>';
        tyres += pathEl(roundRectD(x0, y0, ww, hh, hh * 0.3), { fill: url(P, 'treadV') });
        if (d.compound !== 'slick') {
          var tl = '', per = ww / 12;
          for (var q = -2; q < 15; q++) tl += 'M' + P2(x0 + q * per, y0) + ' L' + P2(x0 + q * per + per * 0.4, y0 + hh) + ' ';
          tyres += g({ 'clip-path': 'url(#' + id + ')' }, g({ 'data-tread': 'x', 'data-period': f2(per) }, pathEl(tl, { stroke: '#050506', 'stroke-width': 0.8, fill: 'none' })));
        }
      });
    });
    car.push(g({ class: 'cbr-ghost cbr-wheels' }, tyres));
    // aero below the body outline
    var under = [], hwA = function (mm) { return Math.max(200, Tt.hwAt(mm)); };
    if (d.splitter !== 'none') {
      var ext = d.splitter === 'race' ? 120 : d.splitter === 'carbon' ? 55 : 18, sx1 = G.X(0.07), h0 = hwA(60);
      var sd0 = smoothD([[px(sx1), py(-hwA(sx1) * 0.97), 1], [px(-ext * 0.4 + 40), py(-h0 * 1.02 - ext * 0.3), 0], [px(-ext), py(0), 0], [px(-ext * 0.4 + 40), py(h0 * 1.02 + ext * 0.3), 0], [px(sx1), py(hwA(sx1) * 0.97), 1]], true, 0.18);
      under.push(pathEl(sd0, { fill: d.splitter === 'lip' ? url(P, 'gblack') : url(P, 'carbon'), stroke: '#000', 'stroke-width': 0.6 }));
    }
    if (d.canards) [-1, 1].forEach(function (sd) { var a0 = G.X(0.02), a1 = G.X(0.05), a2 = G.X(0.07); under.push(pathEl(polyD([[px(a0), py(sd * hwA(a0))], [px(a1), py(sd * (hwA(a1) + 60))], [px(a2), py(sd * hwA(a2))]], true), { fill: url(P, 'carbon') })); });
    if (d.skirts) [-1, 1].forEach(function (sd) { var mid = lerp(G.fa, G.ra, 0.5); under.push(rectEl(px(G.fa + G.aRF), py(sd * (hwA(mid) + (sd > 0 ? 0 : 26))), (G.ra - G.aRR - G.fa - G.aRF) * s, 26 * s, { fill: url(P, 'carbon') })); });
    if ((d.diffuser === 'race' || d.diffuser === 'carbon') && fm.style !== 'pickup') {
      var ddf = '', nS = d.diffuser === 'race' ? 7 : 5, dw = hwA(L - 60) * 0.85;
      for (var q2 = 0; q2 < nS; q2++) { var yy = py(-dw + 2 * dw * (q2 + 0.5) / nS); ddf += 'M' + P2(px(L - 30), yy) + ' L' + P2(px(L + (d.diffuser === 'race' ? 70 : 35)), yy) + ' '; }
      under.push(pathEl(ddf, { stroke: '#1d1f23', 'stroke-width': 2.4 }));
    }
    // tips: a short pipe whose end peeks out under the tail at its own z, never past the bumper extreme
    var topPolys = shPolys(v.body);
    shapeTips(fm, d).forEach(function (t) {
      var sp2 = shSpanAtY(topPolys, t.cx), edge = sp2 ? sp2[0] : fm.dims.xRear;
      var xEnd = Math.max(fm.dims.xRear + 0.005, edge - 0.015), x0t = G.SX(xEnd + 0.12), x1t = G.SX(xEnd);
      if (t.down || t.faux) return;   // turned-down van / pickup pipes and flush faux outlets: invisible from above
      under.push(pathEl(roundRectD(Math.min(x0t, x1t), X.y(t.cx) - t.w * 500 * s, Math.abs(x1t - x0t), t.w * 1000 * s, Math.min(20 * s, t.w * 300 * s)), { fill: t.fin === 'blued' ? url(P, 'blued') : url(P, 'chromeH') }));
    });
    car.push(g({ class: 'cbr-ghost' }, under.join('')));
    var mir = [];
    X.slot(mir, v.mirrors, 'body', 'mirror', function (p) { return shMirrorPaint(p, d); });
    car.push(g({ class: 'cbr-ghost' }, mir.join('')));
    // body
    var bodyG = [pathEl(outline, { fill: url(P, 'paintTop'), stroke: shade(c.paint, -0.62), 'stroke-width': 1.1 })], ov = [];
    var W = n.W, bx = px(-60), bw = (L + 120) * s, by = py(-W / 2 - 60), bh = (W + 120) * s;
    if (hi && (d.flake || d.metallic > 0.2) && d.finish !== 'chrome') ov.push(rectEl(bx, by, bw, bh, { fill: url(P, 'flake'), opacity: f2(0.06 + d.metallic * 0.16) }));
    ov.push(rectEl(bx, by, bw, bh, { fill: url(P, 'edgeShadeV') }));
    if (d.finish !== 'matte') ov.push(ellipseEl(px(L * 0.18), py(-W * 0.12), L * 0.16 * s, W * 0.14 * s, { fill: url(P, 'hot') }));
    var sc = c.stripe, st = d.stripe;
    var bandY = function (y0, w, op) { ov.push(rectEl(px(-40), py(y0), (L + 80) * s, w * s, { fill: sc, opacity: op || 0.95 })); };
    if (st === 'racing-dual') { bandY(-W * 0.13, W * 0.085); bandY(W * 0.045, W * 0.085); }
    else if (st === 'center') bandY(-W * 0.1, W * 0.2);
    else if (st === 'le-mans') { bandY(-W * 0.2, W * 0.12); bandY(-W * 0.235, W * 0.015); }
    else if (st === 'hood') ov.push(pathEl(roundRectD(px(G.X(0.03)), py(-hwA(G.xA) * 0.55), (G.xA - G.X(0.03) - 40) * s, hwA(G.xA) * 1.1 * s, 40 * s), { fill: sc, opacity: 0.85 }));
    else if (st === 'pinstripe') [-1, 1].forEach(function (sd) { var pl = []; for (var q3 = 1; q3 < 30; q3++) { var xm = L * q3 / 30; pl.push([px(xm), py(sd * (hwA(xm) - 70)), 0]); } ov.push(pathEl(smoothD(pl, false), { fill: 'none', stroke: sc, 'stroke-width': 1.1 })); });
    else if (st === 'side-skirt') [-1, 1].forEach(function (sd) { var mid2 = hwA(lerp(G.fa, G.ra, 0.5)); ov.push(rectEl(px(G.fa + G.aRF), py(sd > 0 ? mid2 - 40 : -mid2), (G.ra - G.aRR - G.fa - G.aRF) * s, 40 * s, { fill: sc })); });
    else if (st === 'gradient') ov.push(rectEl(bx, by, bw, bh, { fill: url(P, 'fadeTop'), opacity: 0.8 }));
    ['hood', 'deck'].forEach(function (key) {
      S.items(v[key]).forEach(function (it) {
        if (it.paint && it.paint !== 'body') X.paintPath(ov, it.path, it.paint);
        else ov.push(pathEl(X.dd(it.path), { fill: 'none', stroke: '#000', 'stroke-opacity': 0.45, 'stroke-width': 1 }));
      });
    });
    X.strokes(ov, v.panelLines); X.strokes(ov, v.characterLines, 'char');
    bodyG.push(g({ 'clip-path': url(P, 'pbody') }, ov.join('')));
    car.push(g({ class: 'cbr-ghost cbr-paint' }, bodyG.join('')));
    // greenhouse, roof (build roof option), cockpit for open cars
    var gh = [];
    X.slot(gh, v.cockpit, 'black');
    if (v.cockpit && hi) {
      var cb = shBounds(v.cockpit);
      if (cb) [-1, 1].forEach(function (sd) {
        var sx = G.SX(lerp(cb.minX, cb.maxX, 0.42)), sy = X.y(sd * cb.h * 0.24);
        gh.push(pathEl(roundRectD(sx - 0.26 * k, sy - 0.2 * k, 0.5 * k, 0.4 * k, 0.08 * k), { fill: c.intP, stroke: shade(c.intP, -0.5), 'stroke-width': 0.6 }));
      });
    }
    var roofItems = S.items(v.roof);
    if (d.openTop) {
      if (d.roof !== 'body' && v.softTop) X.slot(gh, v.softTop, 'black', null, function () { return d.roof === 'carbon' ? 'carbon' : 'gloss-black'; });
      X.slot(gh, v.greenhouse, 'glass');
    } else {
      // closed cars: the greenhouse is the black DLO surround; glass only fore and aft of the roof panel
      // (windscreen, back light), so the side windows don't read as a roof-wide tub of glass
      var ghB = shBounds(v.greenhouse), rfB = shBounds(v.roof);
      if (ghB && rfB && rfB.maxX < ghB.maxX && rfB.minX > ghB.minX) {
        var ghD = S.items(v.greenhouse).map(function (it) { return X.dd(it.path); }).join(' '), ghId = P + 'pgh';
        X.slot(gh, v.greenhouse, 'trim', null, function (p0) { return p0 === 'glass' ? 'trim' : p0; });
        gh.push('<clipPath id="' + ghId + '"><path d="' + ghD + '"/></clipPath>');
        var yA = X.y(ghB.minY - 0.05), yB = X.y(ghB.maxY + 0.05), gy0 = Math.min(yA, yB), gyh = Math.abs(yB - yA), panes = '';
        [[rfB.maxX - 0.02, ghB.maxX + 0.05], [ghB.minX - 0.05, rfB.minX + 0.02]].forEach(function (r) {
          var xa = X.x(r[0]), xb = X.x(r[1]), gx0 = Math.min(xa, xb), gw = Math.abs(xb - xa);
          panes += rectEl(gx0, gy0, gw, gyh, { fill: url(P, 'glassTop') }) + rectEl(gx0, gy0, gw, gyh, { fill: url(P, 'glassRef') });
        });
        gh.push(g({ 'clip-path': 'url(#' + ghId + ')' }, panes));
      } else X.slot(gh, v.greenhouse, 'glass');
      roofItems.forEach(function (it) {
        var p0 = it.paint || 'body', dd = X.dd(it.path);
        if (d.roof === 'body') { X.paintPath(gh, it.path, p0); if (p0 === 'body') gh.push(pathEl(dd, { fill: 'none', stroke: '#000', 'stroke-opacity': 0.35, 'stroke-width': 0.8 })); return; }
        var rf = d.roof === 'glass' ? url(P, 'glassTop') : materialFill(P, d.roof, sp);
        gh.push(pathEl(dd, { fill: rf, stroke: '#050506', 'stroke-width': 0.9 }));
        if (d.roof === 'carbon' && hi) gh.push(pathEl(dd, { fill: url(P, 'carbonSheen') }));
        if (d.roof === 'glass') gh.push(pathEl(dd, { fill: url(P, 'glassRef') }));
      });
      if (d.roof === 'body') X.slot(gh, v.roofGlass, 'glass');
      if (st === 'racing-dual' || st === 'center' || st === 'le-mans') {
        var rbx = shBounds(v.roof);
        if (rbx && d.roof !== 'glass') {
          var rd = roofItems.map(function (it) { return X.dd(it.path); }).join(' ');
          gh.push('<clipPath id="' + P + 'proof2"><path d="' + rd + '"/></clipPath>');
          var rx0 = G.SX(rbx.maxX), rw = rbx.w * k;
          var rs2 = st === 'racing-dual' ? rectEl(rx0, py(-W * 0.13), rw, W * 0.085 * s, { fill: sc }) + rectEl(rx0, py(W * 0.045), rw, W * 0.085 * s, { fill: sc })
            : st === 'center' ? rectEl(rx0, py(-W * 0.1), rw, W * 0.2 * s, { fill: sc }) : rectEl(rx0, py(-W * 0.2), rw, W * 0.12 * s, { fill: sc });
          gh.push(g({ 'clip-path': url(P, 'proof2'), opacity: 0.95 }, rs2));
        }
      }
    }
    // plan-view details stay inside the body outline (lamps authored to the bumper edge), mirrors stick out
    var ghc = [];
    // lamps authored at the bumper edge are pulled inside the plan outline (2.5 cm in from the sampled
    // half-width), so a headlamp / tail lamp never overhangs the body even on a narrower fitted track
    X.mapDetail = function (path, paint) {
      if (paint !== 'light' && paint !== 'light-red' && paint !== 'light-amber' && paint !== 'drl') return path;
      var mg = 0.025;
      return S.mapPath(path, function (q) {
        var x = clamp(q[0], pr.x0 + mg, pr.x1 - mg), hwx = Math.max(0, shSample(pr, pr.hw, x) - mg);
        return [x, clamp(q[1], -hwx, hwx)];
      });
    };
    X.details(ghc, fm, function (role) { return role !== 'mirror'; });
    X.mapDetail = null;
    gh.push(g({ 'clip-path': url(P, 'pbody') }, ghc.join('')));
    X.details(gh, fm, function (role) { return role === 'mirror'; });
    car.push(g({ class: 'cbr-ghost' }, gh.join('')));
    // wing / spoilers (build), number roundel on the bonnet
    var lt = [], m = G.wingMount;
    if (m) {
      var span = d.wing === 'active' ? W * 0.82 : W * 0.92, depth = m.chord * Math.cos(n.wingAng * DEG);
      var carbon = d.style === 'hypercar' || d.wheelMat === 'carbon' || d.splitter === 'carbon' || d.splitter === 'race';
      var wf = carbon ? url(P, 'carbon') : url(P, 'gblack');
      if (d.wing === 'biplane') lt.push(pathEl(roundRectD(px(m.xLe + m.chord * 0.25), py(-span / 2 * 0.94), depth * 0.8 * s, span * 0.94 * s, 20 * s), { fill: wf, opacity: 0.85 }));
      lt.push(pathEl(roundRectD(px(m.xLe), py(-span / 2), depth * s, span * s, 24 * s), { fill: wf, stroke: '#000', 'stroke-width': 0.7 }));
      lt.push(lineEl(px(m.xLe + 6), py(-span / 2 + 20), px(m.xLe + 6), py(span / 2 - 20), { stroke: '#ffffff', 'stroke-opacity': 0.25, 'stroke-width': 0.8 }));
      if (d.wing !== 'active') [-1, 1].forEach(function (sd) { lt.push(rectEl(px(m.xLe - 40), py(sd * span / 2) - (sd > 0 ? 0 : 16 * s), (m.chord + 90) * s, 16 * s, { fill: wf, stroke: '#000', 'stroke-width': 0.5 })); });
    } else if (d.wing === 'ducktail') {
      lt.push(pathEl(roundRectD(px(L - 140), py(-hwA(L - 140) * 0.86), 110 * s, hwA(L - 140) * 1.72 * s, 30 * s), { fill: url(P, 'paintTop'), stroke: shade(c.paint, -0.6), 'stroke-width': 0.8 }));
    } else if (d.wing === 'lip-spoiler') {
      var lx = ['hatch', 'wagon', 'box', 'kammback'].indexOf(d.tailStyle) >= 0 ? G.xCE - 40 : L - 90;
      lt.push(rectEl(px(lx), py(-hwA(lx) * 0.75), 50 * s, hwA(lx) * 1.5 * s, { fill: url(P, 'gblack') }));
    }
    if (d.number || d.stripe === 'le-mans') {
      var nx = lerp(G.X(0.06), G.xA, 0.5), rr = Math.min(240, W * 0.13);
      lt.push(circleEl(px(nx), py(W * 0.13), rr * s, { fill: '#f6f3ea', stroke: '#111', 'stroke-width': 1 }));
      if (d.number) lt.push(textEl(px(nx), py(W * 0.13) + rr * s * 0.36, d.number, { 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 900, 'font-size': f2(rr * s * (d.number.length > 2 ? 0.8 : 1.05)), fill: '#111', transform: 'rotate(-90 ' + f(px(nx)) + ' ' + f(py(W * 0.13)) + ')' }));
    }
    car.push(g({ class: 'cbr-ghost' }, lt.join('')));
    out.push(g({ id: P + 'car', class: 'cbr-car', 'data-model': fm.id }, car.join('')));
    if (o.xray) out.push(g({ class: 'cbr-xr' }, xrayTop(Tt, sp, o)));
    var yTop = py(-W / 2 - 220), yBot = py(W / 2 + 220);
    return { markup: out.join(''), bounds: { x: px(-200), y: yTop, w: (L + 400) * s, h: yBot - yTop }, T: Tt };
  }
  /** shape-library drawing for a view, or null (→ procedural) */
  function drawShapeView(sp, o) {
    var ent = sp && sp.d && sp.d.model ? fittedFor(sp) : null;
    if (!ent) return null;
    try {
      var v = o.view;
      return v === 'front' ? drawShapeCross(sp, o, ent, false) : v === 'rear' ? drawShapeCross(sp, o, ent, true) : v === 'top' ? drawShapeTop(sp, o, ent) : drawShapeSide(sp, o, ent);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('CB.render: shape view failed, using procedural', e);
      return null;
    }
  }

  /* ======================================================================
     Composition
     ====================================================================== */
  function drawView(sp, o) {
    var v = o.view;
    var r = drawShapeView(sp, o);
    if (!r) r = v === 'front' ? drawCross(sp, o, false) : v === 'rear' ? drawCross(sp, o, true) : v === 'top' ? drawTop(sp, o) : drawSide(sp, o);
    r.frame = frameOf(sp, v, r);
    return r;
  }
  /** the car's framing box in viewBox px: reference length / width / height at the drawing scale, centred on
      the stage centre line (every view draws the car centred on x = VBW/2), standing on GROUND (top view:
      centred on its spine) */
  function frameOf(sp, v, r) {
    var n = sp.n, geo = r.G || r.C || r.T, s = geo && geo.s;
    if (!(s > 0)) return null;
    var fl = n.frameL > 0 ? n.frameL : n.L0, fw = n.frameW > 0 ? n.frameW : n.W, fh = n.frameH > 0 ? n.frameH : n.H;
    if (v === 'top') return { view: v, cx: VBW / 2, cy: r.T && isFinite(r.T.cy) ? r.T.cy : 252, w: fl * s, h: fw * s };
    if (v === 'front' || v === 'rear') return { view: v, cx: VBW / 2, ground: GROUND, w: fw * s, h: fh * s };
    return { view: 'side', cx: VBW / 2, ground: GROUND, w: fl * s, h: fh * s };
  }
  /** live-stage viewBox: the car fills ~83 % of the stage width unless its height (plus the floor and the
      reflection) runs out first; the viewBox keeps the element's aspect so preserveAspectRatio never letterboxes */
  var FRAME_FILL = 0.83;
  function stageViewBox(fr, box) {
    if (!fr || !box || !(box.w > 40) || !(box.h > 40)) return null;
    // box (svg-local px): w, h, hostW (stage width), top / bottom: the free band for the car, measured from
    // the svg top (top may be negative: the stage padding above the svg is usable, overflow is visible)
    var hostW = box.hostW > 0 ? box.hostW : box.w;
    var top = isFinite(box.top) ? box.top : 0, bot = isFinite(box.bottom) ? box.bottom : box.h;
    if (!(bot - top > 30)) { top = 0; bot = box.h; }
    var wantW = Math.min(FRAME_FILL * hostW, box.w * 0.98), u, vbY;
    if (fr.view === 'top') {
      u = Math.min(wantW / fr.w, (bot - top) * 0.9 / fr.h);
      vbY = fr.cy - ((top + bot) / 2) / u;
    } else {
      // ground on the bottom of the free band (above the toolbars); the roof keeps ~5 % headroom
      var groundPx = bot, availH = (bot - top) * 0.95;
      u = Math.min(wantW / fr.w, availH / fr.h);
      vbY = fr.ground - groundPx / u;
    }
    if (!(u > 0) || !isFinite(u)) return null;
    u = clamp(u, 0.05, 40);
    var vbX = fr.cx - (box.w / 2) / u;
    return [vbX, vbY, box.w / u, box.h / u];
  }

  var STYLE_CSS =
    '.cbr-svg{overflow:visible}' +
    '.cbr-svg .cbr-xr{opacity:0;transition:opacity .35s ease;pointer-events:none}' +
    '.cbr-svg.is-xray .cbr-xr{opacity:1}' +
    '.cbr-svg .cbr-ghost{transition:opacity .35s ease}' +
    '.cbr-svg.is-xray .cbr-ghost{opacity:.14}' +
    '.cbr-svg.is-xray .cbr-ghost.cbr-paint{opacity:.08}' +
    '.cbr-svg.is-xray .cbr-studio{opacity:.35}' +
    '.cbr-svg .cbr-blur{opacity:0;transition:opacity .5s ease}' +
    '.cbr-svg.is-spinning .cbr-blur{opacity:.42}' +
    '.cbr-svg .cbr-scene{transform-box:view-box;transform-origin:50% 72%}' +
    '.cbr-svg .cbr-scene.cbr-enter{animation:cbr-enter .45s cubic-bezier(.2,.7,.2,1) both}' +
    '@keyframes cbr-enter{from{opacity:0;transform:translateY(10px) scale(.982)}to{opacity:1;transform:none}}' +
    '.cbr-svg .cbr-scene.cbr-swap{animation:cbr-swap ' + TWEEN_MS + 'ms ease-in-out both}' +
    '@keyframes cbr-swap{0%{opacity:1}50%{opacity:.18}100%{opacity:1}}' +
    '.cbr-svg .cbr-xr-pulse{animation:cbr-pulse 1.8s ease-in-out infinite}' +
    '@keyframes cbr-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
    '@media (prefers-reduced-motion:reduce){.cbr-svg .cbr-scene.cbr-enter,.cbr-svg .cbr-scene.cbr-swap,.cbr-svg .cbr-xr-pulse{animation:none}}';

  function ariaLabel(sp, view) {
    var d = sp.d;
    return (VIEWS.indexOf(view) >= 0 ? view.charAt(0).toUpperCase() + view.slice(1) : 'Side') + ' view of ' + d.name + ': ' + (d.modelName ? d.modelName + ' (' + d.styleName + ')' : d.styleName) + ', ' + d.finish + ' ' + sp.c.paint +
      ', ' + Math.round(d.dia) + '-inch ' + (d.wheelName || d.wheel) + ' wheels';
  }

  function documentFor(sp, opts) {
    opts = opts || {};
    var view = VIEWS.indexOf(opts.view) >= 0 ? opts.view : 'side';
    var P = opts.prefix || 'cbrx';
    var o = {
      P: P, view: view, detail: opts.detail === 'low' ? 'low' : 'high', xray: !!opts.xray, reflection: opts.reflection !== false && view === 'side',
      backdrop: opts.backdrop || 'full', spin: !!opts.spin, live: !!opts.live, spinAngle: 0
    };
    var r = drawView(sp, o);
    var vb = '0 0 ' + VBW + ' ' + VBH;
    if (opts.crop) { var b = r.bounds; vb = f(b.x) + ' ' + f(b.y) + ' ' + f(b.w) + ' ' + f(b.h); }
    var cls = 'cbr-svg' + (opts.className ? ' ' + opts.className : '') + (o.xray ? ' is-xray' : '') + (o.spin ? ' is-spinning' : '');
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="' + vb + '"' +
      (opts.width ? ' width="' + opts.width + '"' : '') + (opts.height ? ' height="' + opts.height + '"' : '') +
      ' preserveAspectRatio="xMidYMid meet" class="' + cls + '" role="img" aria-label="' + esc(ariaLabel(sp, view)) + '">' +
      (opts.style === false ? '' : '<style>' + STYLE_CSS + '</style>') +
      '<defs>' + paintDefs(P, sp, o) + '</defs>' + r.markup + '</svg>';
  }

  /** Pure: full standalone SVG for a build. opts: { view, xray, detail, backdrop:'full'|'soft'|'none', reflection, crop, prefix, theme, width, height, spin } */
  var markupSeq = 0;
  function markup(build, metrics, opts) {
    opts = opts || {};
    // unique id prefix per call unless the caller pins one, so several markups can share a document
    if (!opts.prefix) { markupSeq = (markupSeq + 1) % 1e9; opts = Object.assign({}, opts, { prefix: 'cbrx' + markupSeq.toString(36) + '_' }); }
    return documentFor(resolve(build, metrics, { theme: opts.theme }), opts);
  }

  var thumbSeq = 0;
  /** Small static SVG string (garage / hub / race cards). Unique ids per call. */
  function thumbnail(build, opts) {
    opts = opts || {};
    var sp = resolve(build, opts.metrics || null, { theme: opts.theme || 'dark' });
    var uid = String(opts.uid == null ? '' : opts.uid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
    thumbSeq = (thumbSeq + 1) % 1e9;
    return documentFor(sp, {
      view: opts.view || 'side', prefix: 'cbt' + uid + thumbSeq.toString(36) + '_', crop: opts.crop !== false,
      detail: opts.detail || (opts.spin || opts.large ? 'high' : 'low'), xray: !!opts.xray, reflection: !!opts.reflection,
      backdrop: opts.backdrop || 'none', spin: !!opts.spin, style: !!opts.xray, className: 'cbr-thumb gx-thumb-svg', width: opts.width, height: opts.height
    });
  }

  /* ======================================================================
     Live controller (browser only)
     ====================================================================== */
  var P_LIVE = 'cbrm';
  var live = {
    host: null, svg: null, defsEl: null, sceneEl: null, view: 'side', xray: false, spin: false,
    cur: null, from: null, to: null, toKey: '', t0: 0, raf: 0,
    angle: 0, speed: 0, spinRaf: 0, lastTs: 0, spinNodes: [], treadNodes: [], defsKey: '', sceneKey: '', xrayTimer: 0,
    frame: null, vbStr: '', ro: null, s3d: false
  };
  var use3dFlag = null;
  function use3dDefault() {
    if (!HAS_DOM) return false;
    try { if (/[?&]studio=svg\b/.test(window.location.search || '') || /[?&]studio=svg\b/.test(window.location.hash || '')) return false; } catch (e) { /* ignore */ }
    try { if (window.localStorage && window.localStorage.getItem('cb.studio') === 'svg') return false; } catch (e2) { /* ignore */ }
    return true;
  }
  function want3d() {
    if (use3dFlag === null) use3dFlag = use3dDefault();
    var S3 = CB.studio3d;
    return !!(HAS_DOM && use3dFlag && S3 && typeof S3.mount === 'function' && (typeof S3.isSupported !== 'function' || S3.isSupported()));
  }
  function stateBuild() {
    var b = null, m = null;
    if (CB.state && typeof CB.state.get === 'function') { try { b = CB.state.get(); } catch (e) { b = null; } }
    try { if (b && CB.physics && typeof CB.physics.compute === 'function') m = CB.physics.compute(b); } catch (e2) { m = null; }
    return { b: b, m: m };
  }
  /** try to hand the live viewer to the WebGL studio; true on success */
  function mount3d(container) {
    var cv = null;
    container.innerHTML = '';
    try {
      cv = CB.studio3d.mount(container, { view: live.view, xray: live.xray, spin: live.spin, onFail: function (why) { fallbackToSvg(why); } });
    } catch (e) { cv = null; }
    if (!cv) { try { CB.studio3d.destroy(); } catch (e2) { /* ignore */ } container.innerHTML = ''; return false; }
    live.host = container; live.svg = null; live.defsEl = null; live.sceneEl = null; live.s3d = true;
    if (live.raf) { caf(live.raf); live.raf = 0; }
    if (live.spinRaf) { caf(live.spinRaf); live.spinRaf = 0; }
    var sb = live.lastBuild ? { b: live.lastBuild, m: live.lastMetrics } : stateBuild();
    if (sb.b) {
      if (!live.to) { live.to = live.cur = resolve(sb.b, sb.m); live.toKey = specKey(live.to); }
      try { CB.studio3d.update(sb.b, sb.m, live.to); } catch (e3) { /* ignore */ }
    }
    try { CB.studio3d.setView(live.view); CB.studio3d.setXray(live.xray); CB.studio3d.setSpin(live.spin); } catch (e4) { /* ignore */ }
    return true;
  }
  /** the WebGL studio died (context lost for good / runtime failure): continue with the SVG viewer */
  function fallbackToSvg(why) {
    var host = live.host;
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[render] 3D studio unavailable (' + (why || 'error') + '), using the SVG viewer'); } catch (e) { /* ignore */ }
    try { if (CB.studio3d) CB.studio3d.destroy(); } catch (e2) { /* ignore */ }
    live.s3d = false; live.host = null; use3dFlag = false;
    if (host) mount(host);
  }
  var reduceMotion = false;
  function now() { return HAS_DOM && window.performance && performance.now ? performance.now() : Date.now(); }
  function raf(fn) { return HAS_DOM && window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(function () { fn(now()); }, 16); }
  function caf(id) { if (!id) return; if (HAS_DOM && window.cancelAnimationFrame) window.cancelAnimationFrame(id); else clearTimeout(id); }
  function specKey(sp) { try { return JSON.stringify(sp); } catch (e) { return String(Math.random()); } }

  function paint(sp, force) {
    if (!live.svg || !sp) return;
    var o = { P: P_LIVE, view: live.view, detail: 'high', xray: live.xray || !!live.xrayTimer, reflection: live.view === 'side', backdrop: 'soft', live: true, spin: false, spinAngle: live.angle };
    var defs = paintDefs(P_LIVE, sp, o);
    if (force || defs !== live.defsKey) { live.defsEl.innerHTML = defs; live.defsKey = defs; }
    var r = drawView(sp, o);
    if (force || r.markup !== live.sceneKey) {
      live.sceneEl.innerHTML = r.markup;
      live.sceneKey = r.markup;
      collectAnimNodes();
      applySpin();
    }
    live.frame = r.frame || null;
    applyFrame();
    live.svg.setAttribute('aria-label', ariaLabel(sp, live.view));
  }
  /** measure the live svg and its host, and zoom the viewBox onto the car (see stageViewBox) */
  function stageBox() {
    if (!live.svg || !live.host || !live.svg.getBoundingClientRect) return null;
    var a = live.svg.getBoundingClientRect(), h = live.host.getBoundingClientRect();
    if (!(a.width > 40) || !(a.height > 40)) return null;
    // overlay toolbars in the stage (view switch, x-ray / spin): the car stands above the highest one that
    // sits in the lower half of the stage
    var barTop = h.bottom, par = live.host.parentElement;
    if (par && par.children) {
      for (var i = 0; i < par.children.length; i++) {
        var el = par.children[i];
        if (el === live.host || el.contains(live.svg)) continue;
        var kids = el.children && el.children.length ? el.children : [el];
        for (var j = 0; j < kids.length; j++) {
          var r = kids[j].getBoundingClientRect ? kids[j].getBoundingClientRect() : null;
          if (!r || !(r.width > 4) || !(r.height > 4) || r.width > h.width * 0.9) continue;
          if (r.top > h.top + h.height * 0.5 && r.top < barTop) barTop = r.top;
        }
      }
    }
    var bottom = Math.min(barTop - 6, h.bottom - 6) - a.top;
    var top = h.top + h.height * 0.05 - a.top;
    return { w: a.width, h: a.height, hostW: h.width, top: top, bottom: bottom };
  }
  function applyFrame() {
    if (!live.svg) return;
    var box = stageBox();
    // not laid out yet (route just shown, entry animation): try again on the next frames
    if (!box && live.frame && (live.frameRetry || 0) < 40) { live.frameRetry = (live.frameRetry || 0) + 1; raf(applyFrame); return; }
    if (box) live.frameRetry = 0;
    var vb = stageViewBox(live.frame, box), str = vb ? vb.map(function (v) { return v.toFixed(1); }).join(' ') : '0 0 ' + VBW + ' ' + VBH;
    if (str !== live.vbStr) { live.svg.setAttribute('viewBox', str); live.vbStr = str; }
  }
  function collectAnimNodes() {
    live.spinNodes = []; live.treadNodes = [];
    if (!live.sceneEl) return;
    var a = live.sceneEl.querySelectorAll('[data-spin]');
    for (var i = 0; i < a.length; i++) live.spinNodes.push({ el: a[i], cx: +a[i].getAttribute('data-cx') || 0, cy: +a[i].getAttribute('data-cy') || 0 });
    var t = live.sceneEl.querySelectorAll('[data-tread]');
    for (var j = 0; j < t.length; j++) live.treadNodes.push({ el: t[j], axis: t[j].getAttribute('data-tread'), period: +t[j].getAttribute('data-period') || 10 });
  }
  function applySpin() {
    var a = live.angle;
    for (var i = 0; i < live.spinNodes.length; i++) {
      var nd = live.spinNodes[i];
      nd.el.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' ' + nd.cx + ' ' + nd.cy + ')');
    }
    for (var j = 0; j < live.treadNodes.length; j++) {
      var tn = live.treadNodes[j], off = ((a / 360) * tn.period * 9) % tn.period;
      tn.el.setAttribute('transform', tn.axis === 'x' ? 'translate(' + (-off).toFixed(2) + ' 0)' : 'translate(0 ' + off.toFixed(2) + ')');
    }
  }
  var SPIN_MAX = 0.9; // degrees per ms (~2.5 rev/s)
  function spinLoop(ts) {
    var dt = live.lastTs ? Math.min(64, ts - live.lastTs) : 16;
    live.lastTs = ts;
    var target = live.spin ? SPIN_MAX : 0;
    live.speed += (target - live.speed) * Math.min(1, dt / (live.spin ? 420 : 650));
    if (!live.spin && live.speed < 0.004) { live.speed = 0; live.spinRaf = 0; live.lastTs = 0; return; }
    live.angle = (live.angle + live.speed * dt) % 360;
    applySpin();
    live.spinRaf = raf(spinLoop);
  }

  function tick() {
    var t = clamp((now() - live.t0) / TWEEN_MS, 0, 1);
    live.cur = interp(live.from, live.to, easeInOut(t));
    paint(live.cur);
    if (t < 1) live.raf = raf(tick);
    else { live.raf = 0; live.cur = live.to; live.from = null; }
  }

  function mount(container) {
    if (!HAS_DOM || !container) return null;
    if (live.host === container && live.svg && container.contains(live.svg)) return live.svg;
    if (live.host === container && live.s3d && CB.studio3d && CB.studio3d.isMounted(container)) return container.querySelector('canvas');
    try { reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduceMotion = false; }
    if (live.s3d) { try { CB.studio3d.destroy(); } catch (e0) { /* ignore */ } live.s3d = false; }
    if (want3d() && mount3d(container)) return container.querySelector('canvas');
    container.innerHTML = '';
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + VBW + ' ' + VBH);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'cbr-svg cbr-live' + (live.xray ? ' is-xray' : '') + (live.spin ? ' is-spinning' : ''));
    svg.setAttribute('role', 'img');
    svg.setAttribute('focusable', 'false');
    // Grid/flex hosts (the studio .car-mount is a centred grid) would otherwise size the row by the
    // svg's intrinsic aspect height and overflow short viewports; let the host constrain us instead.
    svg.style.minWidth = '0';
    svg.style.minHeight = '0';
    svg.innerHTML = '<style>' + STYLE_CSS + '</style><defs class="cbr-defs"></defs><g class="cbr-scene"></g>';
    container.appendChild(svg);
    live.host = container; live.svg = svg;
    live.defsEl = svg.querySelector('.cbr-defs'); live.sceneEl = svg.querySelector('.cbr-scene');
    live.defsKey = ''; live.sceneKey = ''; live.vbStr = '';
    // re-frame the car when the stage changes size (window resize, panels opening, mobile rotation)
    if (live.ro && live.ro.disconnect) { try { live.ro.disconnect(); } catch (e0) { /* ignore */ } }
    live.ro = null;
    if (typeof window.ResizeObserver === 'function') {
      try { live.ro = new window.ResizeObserver(function () { applyFrame(); }); live.ro.observe(container); } catch (e1) { live.ro = null; }
    } else if (window.addEventListener && !live.resizeHooked) { live.resizeHooked = true; window.addEventListener('resize', function () { applyFrame(); }); }
    if (!live.to && CB.state && typeof CB.state.get === 'function') {
      var b = null, m = null;
      try { b = CB.state.get(); } catch (e) { b = null; }
      try { if (b && CB.physics && typeof CB.physics.compute === 'function') m = CB.physics.compute(b); } catch (e2) { m = null; }
      if (b) { live.to = live.cur = resolve(b, m); live.toKey = specKey(live.to); }
    }
    if (live.cur) paint(live.cur, true);
    if (live.spin && !live.spinRaf) live.spinRaf = raf(spinLoop);
    return svg;
  }

  function update(build, metrics) {
    var target = resolve(build, metrics);
    var key = specKey(target);
    if (live.s3d) {
      live.lastBuild = build; live.lastMetrics = metrics;
      live.toKey = key; live.to = live.cur = target;
      try { CB.studio3d.update(build, metrics, target); } catch (e) { fallbackToSvg('update'); }
      return;
    }
    live.lastBuild = build; live.lastMetrics = metrics;
    if (key === live.toKey && live.cur) return;
    live.toKey = key;
    if (!live.svg || !live.cur || reduceMotion) {
      if (live.raf) { caf(live.raf); live.raf = 0; }
      live.to = live.cur = target;
      if (live.svg) paint(target);
      return;
    }
    // another manufacturer model (or body style): a short dip-and-settle so the swap at the tween midpoint
    // reads as one smooth change while the viewBox zoom eases to the new car's size
    var prevTo = live.to;
    if (prevTo && prevTo.d && target.d && (prevTo.d.model !== target.d.model || prevTo.d.style !== target.d.style) && live.sceneEl && live.sceneEl.classList) {
      live.sceneEl.classList.remove('cbr-swap');
      void live.sceneEl.getBoundingClientRect();
      live.sceneEl.classList.add('cbr-swap');
    }
    live.from = live.cur;
    live.to = target;
    live.t0 = now();
    if (!live.raf) live.raf = raf(tick);
  }

  function setView(v) {
    if (VIEWS.indexOf(v) < 0) v = 'side';
    var changed = v !== live.view;
    live.view = v;
    if (live.s3d) { try { CB.studio3d.setView(v); } catch (e) { /* ignore */ } return live.view; }
    if (!live.svg || !changed) return live.view;
    paint(live.cur || live.to, true);
    var sc = live.sceneEl;
    if (sc && !reduceMotion) {
      sc.classList.remove('cbr-enter');
      void sc.getBoundingClientRect();
      sc.classList.add('cbr-enter');
    }
    return live.view;
  }
  function getView() { return live.view; }

  function toggleXray(force) {
    var on = typeof force === 'boolean' ? force : !live.xray;
    if (live.s3d) { live.xray = on; try { CB.studio3d.setXray(on); } catch (e) { /* ignore */ } return on; }
    if (on === live.xray && live.svg && (on ? live.sceneEl.querySelector('.cbr-xr') : true)) return on;
    live.xray = on;
    if (!live.svg) return on;
    if (live.xrayTimer) { clearTimeout(live.xrayTimer); live.xrayTimer = 0; }
    if (on) {
      paint(live.cur || live.to, true);
      void live.svg.getBoundingClientRect();
      live.svg.classList.add('is-xray');
    } else {
      live.svg.classList.remove('is-xray');
      // keep the layer during the fade-out, then drop it so tweening stays cheap
      live.xrayTimer = setTimeout(function () { live.xrayTimer = 0; if (!live.xray) paint(live.cur || live.to, true); }, 420);
    }
    return on;
  }
  function isXray() { return live.xray; }

  function toggleSpin(force) {
    var on = typeof force === 'boolean' ? force : !live.spin;
    live.spin = on;
    if (live.s3d) { try { CB.studio3d.setSpin(on); } catch (e) { /* ignore */ } return on; }
    if (live.svg) live.svg.classList.toggle('is-spinning', on);
    if (HAS_DOM && !live.spinRaf && (on || live.speed > 0)) { live.lastTs = 0; live.spinRaf = raf(spinLoop); }
    return on;
  }
  function isSpinning() { return live.spin; }

  /** Standalone SVG of what is on screen (current view, x-ray state), with an opaque studio backdrop. */
  function snapshotSVG(opts) {
    opts = opts || {};
    var sp = live.to || live.cur;
    if (!sp) {
      var b = CB.state && typeof CB.state.get === 'function' ? CB.state.get() : null, m = null;
      try { if (b && CB.physics && CB.physics.compute) m = CB.physics.compute(b); } catch (e) { m = null; }
      sp = resolve(b, m);
    }
    return documentFor(sp, { view: opts.view || live.view, xray: opts.xray != null ? !!opts.xray : live.xray, prefix: 'cbrs', backdrop: opts.backdrop || 'full', reflection: true, width: VBW, height: VBH, detail: 'high' });
  }

  CB.render = {
    version: '1.0.0',
    VIEWS: VIEWS.slice(),
    mount: mount, update: update, setView: setView, getView: getView,
    toggleXray: toggleXray, isXray: isXray, toggleSpin: toggleSpin, setSpin: toggleSpin, isSpinning: isSpinning,
    snapshotSVG: snapshotSVG, thumbnail: thumbnail, markup: markup, resolve: resolve, interp: interp,
    mode: function () { return live.s3d ? 'webgl' : live.svg ? 'svg' : null; },
    use3d: function (flag) {
      if (typeof flag !== 'boolean') return want3d();
      use3dFlag = flag;
      var host = live.host;
      if (host && HAS_DOM && (flag ? !live.s3d : live.s3d)) {
        if (live.s3d) { try { CB.studio3d.destroy(); } catch (e) { /* ignore */ } live.s3d = false; }
        live.host = null; live.svg = null;
        mount(host);
      }
      return want3d();
    },
    _internal: { sideGeom: sideGeom, crossGeom: crossGeom, planGeom: planGeom, drawView: drawView, paintDefs: paintDefs, documentFor: documentFor, profileAt: profileAt, live: live, frameOf: frameOf, stageViewBox: stageViewBox, applyFrame: applyFrame }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.render;

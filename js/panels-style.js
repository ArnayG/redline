/* ==========================================================================
   FORGE Atelier — js/panels-style.js
   Registers the three "Design" panels: exterior, interior, tech.

   Architecture
   ------------
   * PURE CORE (top half, no DOM): colour science (paint gradients per finish, harmony schemes, nearest
     heritage swatch), livery randomiser, section cost / weight / electrical-load estimators, and three
     inline-SVG string builders — exteriorSvg(build) (side + top livery plate), interiorSvg(build)
     (rear-seat cockpit view) and techSvg(build) (dash / display / HUD close-up) plus climate + audio
     diagrams. All exported as CB.panelsStyle and testable in Node (tests/panels-style.test.js).
   * PANELS (bottom half, DOM): built with CB.ui following the ui-kit sync strategy — every control is a
     bound node (data-cb-path + .sync(build)); live widgets join via CB.ui.bind(node, '*', fn) with a
     key cache so SVG is only regenerated when something it depends on changed. update() re-syncs the
     panel root and re-runs metric watchers; the DOM is never rebuilt, so slider drags are never broken.
   * Optional deps (feature-detected): CB.physics, CB.pricing, CB.rules (via CB.ui.issues), CB.app.goto,
     and a career lock hook CB.ui.lockReason(collection, id) -> false|string (greys locked options).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var U = CB.util, D = CB.data;
  if (!U || !D) {
    if (typeof console !== 'undefined') console.error('[panels-style] CB.util / CB.data must load first.');
    return;
  }
  var hasDOM = typeof document !== 'undefined';

  /* ======================================================================
     SMALL HELPERS
     ====================================================================== */
  function get(b, p, fb) { var v = U.get(b, p); return v === undefined || v === null ? fb : v; }
  function find(c, id) { try { return D.find(c, id); } catch (e) { return undefined; } }
  function list(c) { try { return D.list(c) || []; } catch (e) { return []; } }
  function opt(key, fb) { return D.options && D.options[key] != null ? D.options[key] : fb; }
  function owt(key, fb) { return D.optionWeights && D.optionWeights[key] != null ? D.optionWeights[key] : fb; }
  function num(v, fb) { v = Number(v); return isFinite(v) ? v : fb; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmt(n, d) { return n == null || !isFinite(Number(n)) ? '—' : U.fmtNum(Number(n), d || 0); }
  function money(n) { return U.fmtMoney(n); }
  function hex(v, fb) { return U.normHex(v, fb || '#000000'); }
  function esc(s) { return U.escapeHtml(s); }
  function f1(n) { return (Math.round(n * 10) / 10).toString(); }
  function shade(h, p) { return U.shade(hex(h), p); }
  function mix(a, b, t) { return U.mix(hex(a), hex(b), t); }
  function hsl(h) { return U.rgbToHsl(hex(h)); }
  function fromHsl(h, s, l) { return U.hslToHex(h, clamp(s, 0, 1), clamp(l, 0, 1)); }
  function lum(h) { return U.luminance(hex(h)); }
  function rgba(h, a) { var c = U.hexToRgb(hex(h)); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  function saturate(h, amt) { var c = hsl(h); return fromHsl(c.h, c.s + amt, c.l); }
  function hueShift(h, deg) { return U.hueShift(hex(h), deg); }
  function idxOf(coll, id) { var l = list(coll); for (var i = 0; i < l.length; i++) if (String(l[i].id) === String(id)) return i; return -1; }

  /** Deterministic PRNG (mulberry32). */
  function rng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length) % arr.length]; }
  function weighted(rand, pairs) {
    var tot = 0, i;
    for (i = 0; i < pairs.length; i++) tot += pairs[i][1];
    var r = rand() * tot;
    for (i = 0; i < pairs.length; i++) { r -= pairs[i][1]; if (r <= 0) return pairs[i][0]; }
    return pairs[pairs.length - 1][0];
  }

  /* ======================================================================
     COLOUR SCIENCE
     ====================================================================== */
  var FAMILY_ORDER = ['red', 'orange', 'yellow', 'gold', 'green', 'blue', 'purple', 'white', 'silver', 'grey', 'black'];
  var FAMILY_LABELS = {
    red: 'Rosso & Reds', orange: 'Oranges', yellow: 'Gialli & Yellows', gold: 'Golds & Sands', green: 'Greens',
    blue: 'Blues', purple: 'Purples', white: 'Whites', silver: 'Silvers', grey: 'Greys', black: 'Blacks'
  };

  /** Perceptual-ish RGB distance ("redmean"), 0..~765. */
  function colorDist(a, b) {
    var x = U.hexToRgb(hex(a)), y = U.hexToRgb(hex(b));
    var rm = (x.r + y.r) / 2, dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }

  function swatches() { return (D.paintSwatches || []).slice(); }

  /** Nearest heritage swatch {name, hex, family, dist}. */
  function nearestSwatch(h, pool) {
    pool = pool || swatches();
    var best = null, bd = Infinity;
    for (var i = 0; i < pool.length; i++) {
      var d = colorDist(h, pool[i].hex);
      if (d < bd) { bd = d; best = pool[i]; }
    }
    return best ? { name: best.name, hex: best.hex.toLowerCase(), family: best.family, dist: bd } : null;
  }

  /** Guess a family for an arbitrary hex (used for custom colours). */
  function familyOf(h) {
    var c = hsl(h);
    if (c.l < 0.12) return 'black';
    if (c.s < 0.12) return c.l > 0.85 ? 'white' : c.l > 0.62 ? 'silver' : 'grey';
    var hh = c.h;
    if (hh < 15 || hh >= 340) return 'red';
    if (hh < 40) return c.l < 0.45 && c.s < 0.6 ? 'gold' : 'orange';
    if (hh < 52) return c.s < 0.55 ? 'gold' : 'yellow';
    if (hh < 70) return 'yellow';
    if (hh < 170) return 'green';
    if (hh < 255) return 'blue';
    return 'purple';
  }

  /** Swatches grouped by family in a stable display order. */
  function groupSwatches() {
    var by = {}, order = FAMILY_ORDER.slice();
    swatches().forEach(function (s) {
      var f = s.family || familyOf(s.hex);
      if (!by[f]) { by[f] = []; if (order.indexOf(f) < 0) order.push(f); }
      by[f].push(s);
    });
    return order.filter(function (f) { return by[f] && by[f].length; }).map(function (f) {
      return { family: f, label: FAMILY_LABELS[f] || U.capitalize(f), swatches: by[f] };
    });
  }

  /** Is this hex one of the catalogue heritage swatches? */
  function isHeritage(h) {
    var v = hex(h).toLowerCase();
    return swatches().some(function (s) { return s.hex.toLowerCase() === v; });
  }

  /** A stable, plausible-looking paint code: e.g. "FX-7Q2 · Rosso Corsa". */
  function paintCode(h, finishId) {
    var n = U.hash(String(hex(h)) + '|' + (finishId || ''));
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 3; i++) { s += abc.charAt(n % abc.length); n = Math.floor(n / abc.length) + 7 * (i + 1); }
    var pre = { solid: 'S', metallic: 'M', pearl: 'P', matte: 'X', satin: 'T', chrome: 'C', candy: 'K', chameleon: 'F' }[finishId] || 'Z';
    return 'F' + pre + '-' + s;
  }

  /**
   * paintStops(hex, finishId) -> [[offset 0..1, color]] vertical light → shadow ramp tuned per finish.
   */
  function paintStops(h, finishId) {
    var b = hex(h, '#b3121f');
    var fin = find('paintFinishes', finishId) || {};
    switch (finishId) {
      case 'solid': return [[0, shade(b, 0.2)], [0.42, b], [1, shade(b, -0.38)]];
      case 'metallic': return [[0, shade(b, 0.45)], [0.22, shade(b, 0.12)], [0.52, b], [0.8, shade(b, -0.3)], [1, shade(b, -0.55)]];
      case 'pearl': return [[0, mix(b, '#ffffff', 0.5)], [0.2, hueShift(shade(b, 0.25), 16)], [0.5, b], [0.82, hueShift(shade(b, -0.3), -14)], [1, shade(b, -0.5)]];
      case 'matte': return [[0, shade(b, 0.07)], [0.5, b], [1, shade(b, -0.2)]];
      case 'satin': return [[0, shade(b, 0.16)], [0.45, b], [1, shade(b, -0.3)]];
      case 'chrome': return [[0, mix(b, '#ffffff', 0.85)], [0.16, shade(b, -0.5)], [0.3, mix(b, '#ffffff', 0.6)], [0.46, shade(b, -0.2)],
        [0.58, mix(b, '#ffffff', 0.9)], [0.76, shade(b, -0.62)], [1, mix(b, '#ffffff', 0.35)]];
      case 'candy': return [[0, mix(saturate(b, 0.2), '#ffffff', 0.38)], [0.3, saturate(shade(b, 0.12), 0.25)], [0.66, b], [1, shade(saturate(b, 0.2), -0.68)]];
      case 'chameleon': {
        var sh = num(fin.hueShift_deg, 70);
        return [[0, hueShift(shade(b, 0.2), sh)], [0.48, b], [1, shade(hueShift(b, -sh), -0.35)]];
      }
      default: return [[0, shade(b, 0.2)], [0.5, b], [1, shade(b, -0.35)]];
    }
  }

  /** CSS background for a live paint chip (gradient + flake + specular), reflects the finish. */
  function paintCss(h, finishId) {
    var fin = find('paintFinishes', finishId) || { gloss: 0.8, metallic: 0.3, flake: false };
    var stops = paintStops(h, finishId).map(function (s) { return s[1] + ' ' + Math.round(s[0] * 100) + '%'; }).join(', ');
    var layers = [];
    var g = num(fin.gloss, 0.8);
    if (g > 0.3) layers.push('radial-gradient(120% 60% at 28% 12%, rgba(255,255,255,' + (0.55 * g).toFixed(2) + ') 0%, rgba(255,255,255,0) 46%)');
    if (finishId === 'chameleon') {
      var sh = num(fin.hueShift_deg, 70);
      layers.push('linear-gradient(115deg, ' + rgba(hueShift(h, sh), 0.55) + ' 0%, rgba(0,0,0,0) 45%, ' + rgba(hueShift(h, -sh), 0.6) + ' 100%)');
    }
    if (fin.flake) {
      var a = (0.08 + num(fin.metallic, 0.4) * 0.16).toFixed(2);
      layers.push('radial-gradient(circle at 30% 40%, rgba(255,255,255,' + a + ') 0 0.5px, transparent 0.9px) 0 0/5px 6px');
      layers.push('radial-gradient(circle at 70% 80%, rgba(255,255,255,' + (a * 0.7).toFixed(2) + ') 0 0.4px, transparent 0.8px) 2px 1px/7px 5px');
    }
    if (finishId === 'matte') layers.push('radial-gradient(circle at 50% 50%, rgba(0,0,0,.08) 0 0.5px, transparent 1px) 0 0/3px 3px');
    layers.push('linear-gradient(165deg, ' + stops + ')');
    return layers.join(', ');
  }

  /** CSS swatch for interior trims (cards). */
  function trimCss(id) {
    switch (id) {
      case 'aluminum': return 'repeating-linear-gradient(45deg, rgba(255,255,255,.18) 0 1px, transparent 1px 4px), repeating-linear-gradient(-45deg, rgba(0,0,0,.14) 0 1px, transparent 1px 4px), linear-gradient(180deg,#dfe2e6,#9da2a8)';
      case 'piano-black': return 'linear-gradient(160deg, rgba(255,255,255,.28) 0%, rgba(255,255,255,0) 32%), linear-gradient(180deg,#141416,#030304)';
      case 'gloss-walnut': return 'linear-gradient(160deg, rgba(255,255,255,.25) 0%, rgba(255,255,255,0) 35%), repeating-radial-gradient(ellipse at 30% 60%, #6e3f1b 0 3px, #4a2810 3px 5px, #7d4c24 5px 8px)';
      case 'open-pore-wood': return 'repeating-linear-gradient(92deg, rgba(60,45,30,.35) 0 1px, transparent 1px 5px, rgba(60,45,30,.2) 5px 6px, transparent 6px 11px), linear-gradient(180deg,#a69279,#7c6a55)';
      case 'carbon': return 'linear-gradient(160deg, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 38%), repeating-linear-gradient(45deg,#2c3034 0 3px,#15171a 3px 6px), #1b1d20';
      case 'forged-carbon': return 'radial-gradient(ellipse 6px 3px at 20% 30%, #4a4e53 60%, transparent 62%), radial-gradient(ellipse 5px 8px at 70% 60%, #33363a 60%, transparent 62%), radial-gradient(ellipse 9px 4px at 45% 85%, #3d4044 60%, transparent 62%), radial-gradient(ellipse 4px 6px at 85% 15%, #50545a 60%, transparent 62%), linear-gradient(160deg, rgba(255,255,255,.2), transparent 40%), #18191b';
      case 'brushed-titanium': return 'repeating-linear-gradient(0deg, rgba(255,255,255,.12) 0 1px, transparent 1px 2px, rgba(0,0,0,.1) 2px 3px), linear-gradient(180deg,#a2a7ae,#6f747b)';
      default: return 'linear-gradient(180deg,#777,#444)';
    }
  }

  /** CSS swatch for upholsteries in the current interior colours. */
  function upholsteryCss(id, p, a, s) {
    p = hex(p, '#1a1a1a'); a = hex(a, '#b3121f'); s = hex(s, a);
    var hi = shade(p, 0.12), lo = shade(p, -0.25);
    switch (id) {
      case 'cloth': return 'repeating-linear-gradient(45deg,' + rgba(hi, 0.5) + ' 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg,' + rgba(lo, 0.6) + ' 0 1px, transparent 1px 3px), ' + p;
      case 'tartan': return 'repeating-linear-gradient(90deg,' + rgba(a, 0.55) + ' 0 5px, transparent 5px 14px, ' + rgba(s, 0.7) + ' 14px 15px, transparent 15px 22px), repeating-linear-gradient(0deg,' + rgba(a, 0.45) + ' 0 5px, transparent 5px 14px, ' + rgba(s, 0.6) + ' 14px 15px, transparent 15px 22px), ' + p;
      case 'vegan': return 'radial-gradient(circle at 50% 50%, ' + rgba(hi, 0.5) + ' 0 0.7px, transparent 1.2px) 0 0/4px 4px, linear-gradient(180deg,' + hi + ',' + p + ')';
      case 'leather': return 'radial-gradient(circle at 30% 30%, ' + rgba(lo, 0.5) + ' 0 0.8px, transparent 1.3px) 0 0/5px 5px, linear-gradient(160deg,' + shade(p, 0.2) + ',' + p + ' 50%,' + lo + ')';
      case 'alcantara': return 'radial-gradient(circle, ' + rgba(hi, 0.35) + ' 0 0.6px, transparent 0.9px) 0 0/3px 3px, radial-gradient(circle, ' + rgba(lo, 0.4) + ' 0 0.6px, transparent 0.9px) 1px 2px/3px 3px, ' + p;
      case 'nappa': return 'radial-gradient(circle, ' + rgba('#000000', 0.45) + ' 0 0.8px, transparent 1.2px) 0 0/6px 6px, repeating-linear-gradient(45deg, transparent 0 10px, ' + rgba(s, 0.85) + ' 10px 11px), repeating-linear-gradient(-45deg, transparent 0 10px, ' + rgba(s, 0.85) + ' 10px 11px), linear-gradient(180deg,' + hi + ',' + p + ')';
      case 'carbon-weave': return 'repeating-linear-gradient(90deg, transparent 0 9px, #1d1f22 9px 15px, transparent 15px 24px), repeating-linear-gradient(45deg, rgba(255,255,255,.08) 0 2px, transparent 2px 4px), linear-gradient(160deg,' + shade(p, 0.18) + ',' + p + ')';
      case 'semi-aniline': return 'repeating-linear-gradient(90deg,' + rgba(lo, 0.7) + ' 0 1px, ' + rgba(hi, 0.35) + ' 1px 3px, transparent 3px 11px), linear-gradient(160deg,' + shade(p, 0.28) + ',' + p + ' 55%,' + lo + ')';
      default: return p;
    }
  }

  /* ======================================================================
     HARMONY SUGGESTIONS
     ====================================================================== */
  var SIGNATURE_ACCENTS = ['#b3121f', '#f6c200', '#00a3d9', '#f37021', '#6dbf2c'];

  /** Snap a computed colour onto a heritage swatch when one is perceptually close (keeps names meaningful). */
  function snapHeritage(h, tol) {
    var n = nearestSwatch(h);
    if (n && n.dist < (tol || 70)) return { hex: n.hex, name: n.name };
    return { hex: hex(h).toLowerCase(), name: null };
  }

  /**
   * harmony(paintHex) -> [{ id, name, desc, stripe, caliper, roof, accent, stitch, names:{} }]
   * Six schemes derived from the paint's HSL: complementary, split-complementary, analogous, triadic,
   * tonal (monochrome) and heritage contrast. Chromatic schemes on near-neutral paints use a signature accent.
   */
  function harmony(paint) {
    var p = hex(paint, '#b3121f');
    var c = hsl(p);
    var neutral = c.s < 0.14;
    var baseHue = neutral ? hsl(SIGNATURE_ACCENTS[Math.floor(c.l * 4.99)]).h : c.h;
    var vivS = neutral ? 0.85 : clamp(Math.max(c.s, 0.65), 0.6, 0.95);
    var dark = lum(p) < 0.18;
    function at(dh, s, l) { return fromHsl(baseHue + dh, s == null ? vivS : s, l == null ? 0.5 : l); }
    function scheme(id, name, desc, cols) {
      var out = { id: id, name: name, desc: desc, names: {} };
      ['stripe', 'caliper', 'roof', 'accent', 'stitch'].forEach(function (k) {
        if (!cols[k]) return;
        var sn = snapHeritage(cols[k], k === 'roof' ? 40 : 60);
        out[k] = sn.hex; if (sn.name) out.names[k] = sn.name;
      });
      out.paint = p;
      return out;
    }
    var neutralContrast = lum(p) > 0.4 ? '#111111' : '#f4f3ef';
    return [
      scheme('complementary', 'Complementary', 'Opposite on the wheel — maximum punch for stripes and calipers.', {
        stripe: neutral ? at(0) : at(180, vivS, 0.52), caliper: neutral ? at(0) : at(180, vivS, 0.48),
        roof: dark ? '#0d0d0f' : shade(p, -0.55), accent: at(180, vivS, 0.45), stitch: at(180, vivS, 0.6)
      }),
      scheme('split', 'Split complementary', 'Two neighbours of the complement — vivid but less brash.', {
        stripe: at(150, vivS, 0.55), caliper: at(210, vivS, 0.5), roof: '#0d0d0f', accent: at(150, vivS, 0.45), stitch: at(210, vivS, 0.62)
      }),
      scheme('analogous', 'Analogous', 'Adjacent hues for a cohesive, coachbuilt look.', {
        stripe: at(32, c.s * 0.9 + 0.1, clamp(c.l + 0.12, 0.25, 0.8)), caliper: at(-28, vivS, 0.48),
        roof: shade(p, -0.4), accent: at(-28, vivS, 0.42), stitch: at(32, vivS, 0.6)
      }),
      scheme('triadic', 'Triadic', 'Three evenly spaced hues — playful, motorsport energy.', {
        stripe: at(120, vivS, 0.5), caliper: at(240, vivS, 0.5), roof: '#0d0d0f', accent: at(240, vivS, 0.45), stitch: at(120, vivS, 0.58)
      }),
      scheme('tonal', 'Tonal', 'One hue, many values — understated and expensive.', {
        stripe: c.l > 0.5 ? shade(p, -0.45) : shade(p, 0.5), caliper: shade(p, -0.25),
        roof: shade(p, -0.6), accent: shade(p, c.l > 0.5 ? -0.5 : 0.35), stitch: shade(p, 0.55)
      }),
      scheme('heritage', 'Heritage contrast', 'Period-correct contrast: black or white stripes, red or gold calipers.', {
        stripe: neutralContrast, caliper: (c.h > 330 || c.h < 20) && !neutral ? '#c9b37e' : '#d40000',
        roof: lum(p) > 0.4 ? '#0d0d0f' : '#f4f3ef', accent: neutralContrast === '#111111' ? '#b3121f' : '#c9b37e', stitch: neutralContrast
      })
    ];
  }

  /** Exterior patch applying a harmony scheme. scope: 'stripe'|'caliper'|'roof'|'all' */
  function harmonyPatch(scheme, scope, build) {
    var x = {};
    if (scope === 'stripe' || scope === 'all') x.stripeColor = scheme.stripe;
    if (scope === 'caliper' || scope === 'all') x.caliperColor = scheme.caliper;
    if (scope === 'roof' || scope === 'all') { x.roof = 'contrast'; x.roofColor = scheme.roof; }
    if (scope === 'all' && get(build, 'exterior.stripe', 'none') === 'none') x.stripe = 'pinstripe';
    var out = { exterior: x };
    if (scope === 'all' || scope === 'interior') out.interior = { accentColor: scheme.accent, stitchColor: scheme.stitch };
    if (scope === 'interior') delete out.exterior;
    return out;
  }

  /* ======================================================================
     LIVERY RANDOMISER
     ====================================================================== */
  var LIVERY_MODES = [
    { id: 'tasteful', name: 'Tasteful', desc: 'Heritage colours, restrained finishes.' },
    { id: 'racer', name: 'Racer', desc: 'Stripes, roundels and a race number.' },
    { id: 'wild', name: 'Wild', desc: 'Custom hues, candy & chameleon, anything goes.' },
    { id: 'stealth', name: 'Stealth', desc: 'Murdered-out greys, matte and carbon.' }
  ];

  /**
   * randomLivery(mode, rand?, build?) -> { exterior: {...} } — always produces values normalize() accepts.
   */
  function randomLivery(mode, rand, build) {
    rand = rand || Math.random;
    var sw = swatches();
    var fam = function (fs) { var l = sw.filter(function (s) { return fs.indexOf(s.family) >= 0; }); return l.length ? l : sw; };
    var paint, finish, stripe, roof, mirrors, badge, tint, number = '';
    if (mode === 'stealth') {
      paint = pick(rand, fam(['grey', 'black', 'green'])).hex;
      finish = weighted(rand, [['matte', 4], ['satin', 4], ['metallic', 1]]);
      stripe = weighted(rand, [['none', 5], ['hood', 2], ['pinstripe', 1]]);
      roof = weighted(rand, [['carbon', 3], ['black', 2], ['body', 1]]);
      mirrors = weighted(rand, [['carbon', 3], ['black', 2]]);
      badge = weighted(rand, [['black', 2], ['delete', 3]]);
      tint = Math.round(45 + rand() * 30);
    } else if (mode === 'wild') {
      paint = fromHsl(rand() * 360, 0.65 + rand() * 0.35, 0.35 + rand() * 0.3);
      finish = weighted(rand, [['candy', 3], ['chameleon', 3], ['pearl', 2], ['chrome', 1], ['metallic', 1]]);
      stripe = pick(rand, ['gradient', 'racing-dual', 'le-mans', 'center', 'pinstripe', 'side-skirt', 'none']);
      roof = weighted(rand, [['contrast', 3], ['carbon', 2], ['glass', 1], ['body', 1]]);
      mirrors = pick(rand, ['body', 'black', 'carbon']);
      badge = pick(rand, ['chrome', 'black']);
      tint = Math.round(rand() * 60);
      if (rand() < 0.4) number = String(Math.floor(rand() * 99) + 1);
    } else if (mode === 'racer') {
      paint = pick(rand, fam(['red', 'orange', 'yellow', 'blue', 'white', 'green'])).hex;
      finish = weighted(rand, [['solid', 5], ['metallic', 2], ['satin', 1]]);
      stripe = weighted(rand, [['le-mans', 4], ['racing-dual', 4], ['center', 2], ['side-skirt', 1]]);
      roof = weighted(rand, [['body', 3], ['black', 2], ['carbon', 2]]);
      mirrors = weighted(rand, [['carbon', 2], ['black', 1], ['body', 1]]);
      badge = weighted(rand, [['black', 2], ['chrome', 1]]);
      tint = Math.round(rand() * 20);
      number = String(Math.floor(rand() * 98) + 1);
    } else {
      paint = pick(rand, fam(['red', 'green', 'blue', 'silver', 'white', 'grey', 'black', 'gold'])).hex;
      finish = weighted(rand, [['metallic', 4], ['pearl', 2], ['solid', 2], ['satin', 1]]);
      stripe = weighted(rand, [['none', 6], ['pinstripe', 2], ['racing-dual', 1]]);
      roof = weighted(rand, [['body', 5], ['black', 2], ['glass', 1]]);
      mirrors = weighted(rand, [['body', 4], ['black', 1]]);
      badge = 'chrome';
      tint = Math.round(10 + rand() * 25);
    }
    var schemes = harmony(paint);
    var sc = mode === 'tasteful' ? pick(rand, [schemes[4], schemes[5], schemes[2]])
      : mode === 'stealth' ? schemes[4] : mode === 'racer' ? pick(rand, [schemes[5], schemes[0], schemes[3]]) : pick(rand, schemes);
    var caliper = mode === 'stealth' ? pick(rand, ['#111111', '#3a3d41', sc.caliper]) : sc.caliper;
    var x = {
      paint: hex(paint).toLowerCase(), finish: finish, roof: roof, roofColor: sc.roof, stripe: stripe,
      stripeColor: stripe === 'hood' && mode === 'stealth' ? '#111111' : sc.stripe,
      caliperColor: hex(caliper).toLowerCase(), windowTint_pct: clamp(tint, 0, 85), mirrors: mirrors, badge: badge,
      livery_number: number.slice(0, 3)
    };
    return { exterior: x };
  }

  /* ======================================================================
     ENGINEERING TABLES (style-side facts not in the catalogue)
     ====================================================================== */
  var LIGHT_SPECS = {
    halogen: { reach_m: 110, kelvin: 3200, lumens: 1500, glow: '#ffcf86', segments: 1 },
    led: { reach_m: 260, kelvin: 5700, lumens: 3200, glow: '#eaf4ff', segments: 6 },
    matrix: { reach_m: 400, kelvin: 6000, lumens: 4200, glow: '#d8ecff', segments: 84 },
    laser: { reach_m: 600, kelvin: 5500, lumens: 5200, glow: '#9fd2ff', segments: 84 }
  };
  var FINISH_CARE = {
    solid: { care: 'Easy', durability: 9, repair: 'Spot-repairable' },
    metallic: { care: 'Easy', durability: 8, repair: 'Blend panel' },
    pearl: { care: 'Moderate', durability: 7, repair: 'Tri-coat blend' },
    matte: { care: 'Demanding', durability: 5, repair: 'Full panel only' },
    satin: { care: 'Moderate', durability: 6, repair: 'Full panel' },
    chrome: { care: 'Concours', durability: 4, repair: 'Re-metallise' },
    candy: { care: 'Moderate', durability: 6, repair: 'Specialist' },
    chameleon: { care: 'Demanding', durability: 6, repair: 'Specialist' }
  };
  var STEERING_SPECS = {
    'round': { dia_mm: 370, lock: '2.6 turns', note: 'Three-spoke, heated rim' },
    'flat-bottom': { dia_mm: 365, lock: '2.4 turns', note: 'D-rim, 12 o’clock marker' },
    'yoke': { dia_mm: 330, lock: '1.0 turn', note: 'Steer-by-wire variable ratio' },
    'race-quick-release': { dia_mm: 330, lock: '2.0 turns', note: 'Quick-release hub, suede' }
  };
  var AUDIO_SPECS = {
    'delete': { speakers: 0, watts: 0, sub: 0, transducers: 0, dirac: false, tag: 'Mechanical symphony' },
    'track': { speakers: 4, watts: 120, sub: 0, transducers: 0, dirac: false, tag: 'Intercom-ready' },
    'standard': { speakers: 8, watts: 180, sub: 0, transducers: 0, dirac: false, tag: 'Balanced stereo' },
    'premium': { speakers: 16, watts: 900, sub: 1, transducers: 0, dirac: true, tag: '3D surround' },
    'reference': { speakers: 21, watts: 1400, sub: 2, transducers: 0, dirac: true, tag: 'Diamond tweeters' },
    'concert': { speakers: 25, watts: 2200, sub: 2, transducers: 4, dirac: true, tag: 'Active noise + in-seat' }
  };
  var SCREEN_SPECS = {
    0: { res: '—', load_w: 0, layout: 'none' }, 8: { res: '1280×720', load_w: 12, layout: 'landscape' },
    10: { res: '1920×720', load_w: 18, layout: 'landscape' }, 12: { res: '1920×1080 OLED', load_w: 24, layout: 'landscape' },
    15: { res: '1600×2000 OLED', load_w: 35, layout: 'portrait' }, 17: { res: '5760×900 curved', load_w: 48, layout: 'hyper' }
  };
  var ADAS_SENSORS = {
    'none': '1 radar', 'assist': '1 camera · 3 radar', 'plus': '5 cameras · 5 radar · 12 ultrasonic',
    'pilot': '8 cameras · 5 radar · 12 ultrasonic · DMS', 'autonomous-l3': 'Lidar · 11 cameras · 5 radar · redundant ECU'
  };
  var ADAS_LOAD_W = { 'none': 10, 'assist': 60, 'plus': 140, 'pilot': 260, 'autonomous-l3': 650 };
  /** ADAS features; `from` = minimum adasLevels id that includes it. */
  var ADAS_FEATURES = [
    { id: 'aeb', name: 'Autonomous emergency braking', from: 'none' },
    { id: 'fcw', name: 'Forward collision warning', from: 'none' },
    { id: 'lka', name: 'Lane-keep assist', from: 'assist' },
    { id: 'bsm', name: 'Blind-spot monitoring', from: 'assist' },
    { id: 'acc', name: 'Adaptive cruise control', from: 'assist' },
    { id: 'tsr', name: 'Traffic-sign recognition', from: 'assist' },
    { id: 'sg', name: 'Stop & go traffic assist', from: 'plus' },
    { id: 'lc', name: 'Lane centring', from: 'plus' },
    { id: 'cam360', name: '360° surround cameras', from: 'plus' },
    { id: 'park', name: 'Automated parking', from: 'plus' },
    { id: 'rcta', name: 'Rear cross-traffic braking', from: 'plus' },
    { id: 'hf', name: 'Hands-free highway driving', from: 'pilot' },
    { id: 'alc', name: 'Automatic lane changes', from: 'pilot' },
    { id: 'dms', name: 'Driver attention monitoring', from: 'pilot' },
    { id: 'rpa', name: 'Remote smartphone parking', from: 'pilot' },
    { id: 'lidar', name: 'Long-range lidar', from: 'autonomous-l3' },
    { id: 'eyesoff', name: 'Eyes-off traffic-jam pilot ≤130 km/h', from: 'autonomous-l3' },
    { id: 'redund', name: 'Redundant steering & braking', from: 'autonomous-l3' }
  ];
  function adasFeatures(levelId) {
    var li = idxOf('adasLevels', levelId);
    return ADAS_FEATURES.filter(function (f) { return idxOf('adasLevels', f.from) <= li; });
  }
  var TRIM_COLORS = {
    'aluminum': ['#c9cdd2', '#8f949a'], 'piano-black': ['#121214', '#030304'], 'gloss-walnut': ['#6e3f1b', '#3d220e'],
    'open-pore-wood': ['#9a8670', '#6d5e4d'], 'carbon': ['#2c3034', '#15171a'], 'forged-carbon': ['#3b3e42', '#141516'],
    'brushed-titanium': ['#9da2a9', '#6f747b']
  };
  var HEADLINER_TONE = { cloth: 0.08, alcantara: 0.0, leather: 0.05 };

  /* ======================================================================
     COST / WEIGHT / LOAD ESTIMATORS (local; CB.pricing preferred when present)
     ====================================================================== */
  function priceOf(coll, id) { var o = find(coll, id); return o ? num(o.price, 0) : 0; }
  function weightOf(coll, id) { var o = find(coll, id); return o ? num(o.weight_kg, 0) : 0; }

  function exteriorLines(b) {
    var x = b.exterior || {};
    var L = [];
    L.push(['Paint finish · ' + ((find('paintFinishes', x.finish) || {}).name || x.finish), priceOf('paintFinishes', x.finish)]);
    if (!isHeritage(x.paint)) L.push(['Bespoke paint colour', opt('customPaint', 2500)]);
    L.push(['Roof · ' + ((find('roofTypes', x.roof) || {}).name || x.roof), priceOf('roofTypes', x.roof)]);
    L.push(['Stripe · ' + ((find('stripes', x.stripe) || {}).name || x.stripe), priceOf('stripes', x.stripe)]);
    L.push(['Lighting · ' + ((find('lightTypes', x.lights) || {}).name || x.lights), priceOf('lightTypes', x.lights)]);
    L.push(['Mirror caps', priceOf('mirrorTypes', x.mirrors)]);
    L.push(['Badging', priceOf('badgeTypes', x.badge)]);
    L.push(['Window tint ' + num(x.windowTint_pct, 0) + '%', Math.round(num(x.windowTint_pct, 0) * opt('windowTintPerPct', 8))]);
    if (x.livery_number) L.push(['Race number #' + x.livery_number, opt('liveryNumber', 600)]);
    if (hex(x.caliperColor).toLowerCase() !== '#f2c200' && !CALIPER_SWATCHES.some(function (s) { return s.hex === hex(x.caliperColor).toLowerCase(); })) L.push(['Bespoke caliper colour', opt('customCaliper', 650)]);
    return L;
  }
  function interiorLines(b) {
    var n = b.interior || {};
    var L = [];
    L.push(['Seats · ' + ((find('seatTypes', n.seatType) || {}).name || n.seatType), priceOf('seatTypes', n.seatType)]);
    L.push(['Upholstery · ' + ((find('upholsteries', n.upholstery) || {}).name || n.upholstery), priceOf('upholsteries', n.upholstery)]);
    L.push(['Trim · ' + ((find('trims', n.trim) || {}).name || n.trim), priceOf('trims', n.trim)]);
    L.push(['Steering wheel', priceOf('steeringTypes', n.steering)]);
    L.push(['Headliner', priceOf('headliners', n.headliner)]);
    if (n.ambientLighting) L.push(['Ambient lighting', opt('ambientLighting', 500)]);
    if (n.harness) L.push(['Six-point harness', opt('harness', 1200)]);
    return L;
  }
  function techLines(b) {
    var t = b.tech || {};
    var L = [];
    L.push(['Centre display ' + ((find('screenSizes', t.screen_in) || {}).name || t.screen_in), priceOf('screenSizes', t.screen_in)]);
    if (t.digitalCluster) L.push(['Digital cluster', opt('digitalCluster', 900)]);
    if (t.hud) L.push(['Head-up display', opt('hud', 1400)]);
    L.push(['Audio · ' + ((find('audioSystems', t.audio) || {}).name || t.audio), priceOf('audioSystems', t.audio)]);
    L.push(['Driver assistance · ' + ((find('adasLevels', t.adas) || {}).name || t.adas), priceOf('adasLevels', t.adas)]);
    var z = num(t.climateZones, 2);
    if (z > 1) L.push([z + '-zone climate', (z - 1) * opt('perClimateZone', 650)]);
    if (t.telemetry) L.push(['Track telemetry', opt('telemetry', 2400)]);
    if (t.liftSystem) L.push(['Front-axle lift', opt('liftSystem', 3200)]);
    if (t.nightVision) L.push(['Night vision', opt('nightVision', 2600)]);
    return L;
  }
  var LINE_FNS = { exterior: exteriorLines, interior: interiorLines, tech: techLines };

  var pricingCache = { build: null, res: null };
  /** Section cost: { total, lines, source: 'pricing'|'estimate' } */
  function sectionCost(b, section) {
    if (CB.pricing && typeof CB.pricing.compute === 'function') {
      if (pricingCache.build !== b) {
        var res = null;
        try { res = CB.pricing.compute(b); } catch (e) { res = null; }
        pricingCache = { build: b, res: res };
      }
      var r = pricingCache.res;
      if (r && Array.isArray(r.lines)) {
        var ls = r.lines.filter(function (l) { return l && l.section === section; });
        if (ls.length) {
          return { total: ls.reduce(function (s, l) { return s + num(l.amount, 0); }, 0), lines: ls.map(function (l) { return [l.label, num(l.amount, 0)]; }), source: 'pricing' };
        }
      }
    }
    var L = (LINE_FNS[section] || function () { return []; })(b);
    return { total: L.reduce(function (s, l) { return s + l[1]; }, 0), lines: L, source: 'estimate' };
  }

  function sectionWeight(b, section) {
    var x = b.exterior || {}, n = b.interior || {}, t = b.tech || {};
    if (section === 'exterior') return weightOf('roofTypes', x.roof) + weightOf('lightTypes', x.lights) + weightOf('mirrorTypes', x.mirrors) + (x.stripe !== 'none' ? 0.4 : 0) + (x.finish === 'chrome' ? 3 : 0);
    if (section === 'interior') {
      return weightOf('seatTypes', n.seatType) * 2 + weightOf('upholsteries', n.upholstery) + weightOf('trims', n.trim) +
        weightOf('steeringTypes', n.steering) + (n.ambientLighting ? owt('ambientLighting', 0.5) : 0) + (n.harness ? owt('harness', 2) : 0);
    }
    if (section === 'tech') {
      return weightOf('screenSizes', t.screen_in) + weightOf('audioSystems', t.audio) + weightOf('adasLevels', t.adas) +
        (t.hud ? owt('hud', 1) : 0) + (t.telemetry ? owt('telemetry', 1.5) : 0) + (t.liftSystem ? owt('liftSystem', 9) : 0) +
        (t.nightVision ? owt('nightVision', 2) : 0) + Math.max(0, num(t.climateZones, 2) - 2) * owt('perClimateZone', 2);
    }
    return 0;
  }

  /** Continuous 12 V / HV electrical load of tech + interior features (W). */
  function electricalLoad(b) {
    var t = b.tech || {}, n = b.interior || {};
    var a = AUDIO_SPECS[t.audio] || AUDIO_SPECS.standard;
    var parts = [
      ['Centre display', (SCREEN_SPECS[t.screen_in] || SCREEN_SPECS[12]).load_w],
      ['Instrument cluster', t.digitalCluster ? 15 : 3],
      ['Head-up display', t.hud ? 20 : 0],
      ['Audio (avg.)', Math.round(a.watts * 0.12)],
      ['Driver assistance', ADAS_LOAD_W[t.adas] != null ? ADAS_LOAD_W[t.adas] : 60],
      ['Climate blowers', num(t.climateZones, 2) * 45],
      ['Telemetry logger', t.telemetry ? 25 : 0],
      ['Night vision', t.nightVision ? 30 : 0],
      ['Ambient lighting', n.ambientLighting ? 8 : 0],
      ['Lighting (DRL)', { halogen: 55, led: 22, matrix: 30, laser: 34 }[get(b, 'exterior.lights', 'led')] || 25]
    ];
    var total = parts.reduce(function (s, p) { return s + p[1]; }, 0);
    return { total: total, parts: parts };
  }

  /** EV range cost of the electrical load at a 100 km/h cruise. */
  function rangeImpact(b, metrics) {
    if (get(b, 'engine.type') !== 'ev') return null;
    var eff = num(metrics && metrics.efficiency_whkm, 0) || 175;
    var load = electricalLoad(b).total;
    var whkm = load / 100;
    var range = num(metrics && metrics.range_km, 0) || num(get(b, 'engine.battery_kwh'), 85) * 1000 / eff;
    return { whkm: whkm, pct: whkm / (eff + whkm) * 100, km: range * whkm / (eff + whkm) };
  }

  /** Visible light transmission through tinted side glass (%), base laminated glass VLT 88 %. */
  function vlt(tintPct) { return Math.round(88 * (1 - clamp(num(tintPct, 0), 0, 100) / 100)); }
  function tintForVlt(v) { return Math.round((1 - v / 88) * 100); }

  /** Interior luxury / sport character 0..100 (local; complements physics ratings). */
  function interiorScores(b) {
    var n = b.interior || {}, t = b.tech || {};
    var seat = find('seatTypes', n.seatType) || { support: 0.5 }, uph = find('upholsteries', n.upholstery) || { luxury: 0.5 };
    var trimLux = { 'aluminum': 0.5, 'piano-black': 0.45, 'gloss-walnut': 0.9, 'open-pore-wood': 0.8, 'carbon': 0.6, 'forged-carbon': 0.75, 'brushed-titanium': 0.85 }[n.trim] || 0.5;
    var trimSport = { 'carbon': 0.9, 'forged-carbon': 0.95, 'aluminum': 0.7, 'brushed-titanium': 0.6 }[n.trim] || 0.3;
    var audio = idxOf('audioSystems', t.audio) / Math.max(1, list('audioSystems').length - 1);
    var luxury = 100 * clamp(0.38 * num(uph.luxury, 0.5) + 0.18 * trimLux + 0.14 * (1 - num(seat.support, 0.5)) + 0.12 * audio +
      (n.headliner === 'alcantara' ? 0.06 : n.headliner === 'leather' ? 0.05 : 0) + (n.ambientLighting ? 0.05 : 0) + (num(t.climateZones, 2) / 4) * 0.07, 0, 1);
    var sport = 100 * clamp(0.5 * num(seat.support, 0.5) + 0.15 * trimSport + (n.harness ? 0.12 : 0) +
      ({ 'race-quick-release': 0.15, 'flat-bottom': 0.1, 'yoke': 0.06 }[n.steering] || 0.02) + (n.upholstery === 'alcantara' ? 0.08 : 0) + (get(b, 'weight.rollCage', 'none') !== 'none' ? 0.08 : 0), 0, 1);
    return { luxury: Math.round(luxury), sport: Math.round(sport), support: Math.round(num(seat.support, 0.5) * 100) };
  }

  /* ======================================================================
     CURATED SWATCH SETS (secondary colours)
     ====================================================================== */
  var CALIPER_SWATCHES = [
    { name: 'Giallo', hex: '#f2c200' }, { name: 'Rosso', hex: '#d40000' }, { name: 'Guards Red', hex: '#c8102e' },
    { name: 'Arancio', hex: '#f37021' }, { name: 'Verde Mantis', hex: '#6dbf2c' }, { name: 'Racing Blue', hex: '#1b3d8f' },
    { name: 'Acid Cyan', hex: '#00d5ff' }, { name: 'Champagne', hex: '#c9b37e' }, { name: 'Silver', hex: '#c5c8cc' },
    { name: 'Titanium', hex: '#6e7175' }, { name: 'Graphite', hex: '#3a3d41' }, { name: 'Black', hex: '#111111' }
  ];
  var CONTRAST_SWATCHES = [
    { name: 'Nero', hex: '#0d0d0f' }, { name: 'Graphite', hex: '#3a3d41' }, { name: 'Nardo', hex: '#7d7f7d' },
    { name: 'Silver Arrow', hex: '#b7bcc2' }, { name: 'Bianco', hex: '#f4f3ef' }, { name: 'Champagne', hex: '#c9b37e' },
    { name: 'Rosso Corsa', hex: '#d40000' }, { name: 'Gulf Orange', hex: '#f37021' }, { name: 'Giallo', hex: '#f6c200' },
    { name: 'BRG', hex: '#004225' }, { name: 'Gulf Blue', hex: '#7fb2e5' }, { name: 'Blu Le Mans', hex: '#1b3d8f' }
  ];
  var LEATHER_SWATCHES = [
    { name: 'Nero', hex: '#1a1a1a' }, { name: 'Graphite', hex: '#3a3d41' }, { name: 'Ash Grey', hex: '#8a8d90' },
    { name: 'Bianco Latte', hex: '#f2e8d5' }, { name: 'Crema', hex: '#e6dcc6' }, { name: 'Sabbia', hex: '#c2a878' },
    { name: 'Tan', hex: '#b0814f' }, { name: 'Cognac', hex: '#8b5a2b' }, { name: 'Saddle', hex: '#5a4632' },
    { name: 'Bordeaux', hex: '#5c0f1e' }, { name: 'Rosso', hex: '#b3121f' }, { name: 'Arancio', hex: '#f37021' },
    { name: 'Giallo', hex: '#f6c200' }, { name: 'Sage', hex: '#6f7d66' }, { name: 'Navy', hex: '#1b2a4a' },
    { name: 'Racing Blue', hex: '#1b3d8f' }, { name: 'Acid Cyan', hex: '#00d5ff' }, { name: 'Mint', hex: '#8fd1b0' }
  ];
  var STITCH_SWATCHES = [
    { name: 'Tone-on-tone', hex: '#2b2b2b' }, { name: 'Bianco', hex: '#f2e8d5' }, { name: 'Silver', hex: '#c5c8cc' },
    { name: 'Champagne', hex: '#c9b37e' }, { name: 'Rosso', hex: '#b3121f' }, { name: 'Arancio', hex: '#f37021' },
    { name: 'Giallo', hex: '#f6c200' }, { name: 'Verde', hex: '#6dbf2c' }, { name: 'Cyan', hex: '#00d5ff' },
    { name: 'Blu', hex: '#1b3d8f' }, { name: 'Mint', hex: '#8fd1b0' }, { name: 'Viola', hex: '#a77bff' }
  ];
  var AMBIENT_SWATCHES = [
    { name: 'Ruby', hex: '#ff3344' }, { name: 'Ember', hex: '#ff7a1a' }, { name: 'Amber', hex: '#ffb366' },
    { name: 'Warm White', hex: '#ffe8c2' }, { name: 'Ice', hex: '#9fd8ff' }, { name: 'Cyan', hex: '#00d5ff' },
    { name: 'Teal', hex: '#4fd1c5' }, { name: 'Lime', hex: '#b6ff4f' }, { name: 'Violet', hex: '#a77bff' },
    { name: 'Magenta', hex: '#ff4fd8' }
  ];
  var INTERIOR_THEMES = [
    { id: 'nero', name: 'Nero Assoluto', primary: '#1a1a1a', accent: '#3a3d41', stitch: '#2b2b2b', upholstery: 'nappa', trim: 'piano-black' },
    { id: 'cognac', name: 'Cognac Heritage', primary: '#8b5a2b', accent: '#1a1a1a', stitch: '#f2e8d5', upholstery: 'semi-aniline', trim: 'gloss-walnut' },
    { id: 'bianco', name: 'Bianco Latte', primary: '#f2e8d5', accent: '#1b2a4a', stitch: '#1b2a4a', upholstery: 'nappa', trim: 'open-pore-wood' },
    { id: 'rosso', name: 'Rosso Racing', primary: '#1a1a1a', accent: '#b3121f', stitch: '#b3121f', upholstery: 'alcantara', trim: 'carbon' },
    { id: 'clubsport', name: 'Clubsport', primary: '#111111', accent: '#f6c200', stitch: '#f6c200', upholstery: 'alcantara', trim: 'forged-carbon' },
    { id: 'ocean', name: 'Riviera', primary: '#1b2a4a', accent: '#c2a878', stitch: '#e6dcc6', upholstery: 'leather', trim: 'brushed-titanium' },
    { id: 'studio', name: 'Mint Studio', primary: '#3a3d41', accent: '#8fd1b0', stitch: '#8fd1b0', upholstery: 'vegan', trim: 'piano-black' },
    { id: 'tartan', name: 'Hot Hatch', primary: '#1a1a1a', accent: '#c8102e', stitch: '#c8102e', upholstery: 'tartan', trim: 'piano-black' }
  ];

  /* ======================================================================
     SVG: shared defs builders
     ====================================================================== */
  function grad(id, stops, x2, y2, extra) {
    return '<linearGradient id="' + id + '" x1="0" y1="0" x2="' + (x2 == null ? 0 : x2) + '" y2="' + (y2 == null ? 1 : y2) + '"' + (extra || '') + '>' +
      stops.map(function (s) { return '<stop offset="' + s[0] + '" stop-color="' + s[1] + '"' + (s[2] != null ? ' stop-opacity="' + s[2] + '"' : '') + '/>'; }).join('') +
      '</linearGradient>';
  }
  function carbonPattern(id, size, a, b) {
    var s = size || 6, h = s / 2;
    a = a || '#2c3034'; b = b || '#15171a';
    return '<pattern id="' + id + '" width="' + s + '" height="' + s + '" patternUnits="userSpaceOnUse">' +
      '<rect width="' + s + '" height="' + s + '" fill="' + b + '"/>' +
      '<rect width="' + h + '" height="' + h + '" fill="' + a + '"/><rect x="' + h + '" y="' + h + '" width="' + h + '" height="' + h + '" fill="' + a + '"/>' +
      '<path d="M0 ' + h + 'L' + h + ' 0M' + h + ' ' + s + 'L' + s + ' ' + h + '" stroke="rgba(255,255,255,.08)" stroke-width=".6"/></pattern>';
  }
  function svgDoc(vb, body, cls, label) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" class="ps-svg ' + (cls || '') + '" role="img"' +
      (label ? ' aria-label="' + esc(label) + '"' : ' aria-hidden="true"') + ' preserveAspectRatio="xMidYMid meet">' + body + '</svg>';
  }

  /* ======================================================================
     SVG: EXTERIOR LIVERY PLATE (side profile + plan view)
     ====================================================================== */
  function roofFill(x, ids) {
    switch (x.roof) {
      case 'black': return 'url(#' + ids.roofBlack + ')';
      case 'carbon': return 'url(#' + ids.carbon + ')';
      case 'glass': return 'url(#' + ids.roofGlass + ')';
      case 'contrast': return 'url(#' + ids.roofContrast + ')';
      default: return 'url(#' + ids.paintV + ')';
    }
  }
  function mirrorFill(x, ids) {
    return x.mirrors === 'carbon' ? 'url(#' + ids.carbon + ')' : x.mirrors === 'black' ? '#0d0d0f' : 'url(#' + ids.paintV + ')';
  }
  function glassFill(tint) {
    var t = clamp(num(tint, 20), 0, 85) / 85;
    return mix('#8fb0c4', '#07090c', 0.18 + t * 0.78);
  }

  /**
   * exteriorSvg(build, opts?) -> svg string. A 2-view livery plate that mirrors every exterior option:
   * paint + finish (gradient, flake, chameleon flip, specular), roof, stripes (all 8), mirror caps,
   * calipers, wheel finish, tint, light signature + beam, badge, race number roundels.
   */
  function exteriorSvg(b, opts) {
    opts = opts || {};
    var x = b.exterior || {};
    var fin = find('paintFinishes', x.finish) || { gloss: 0.8, metallic: 0.3, flake: false };
    var p = hex(x.paint, '#b3121f'), sc = hex(x.stripeColor, '#ffffff'), cal = hex(x.caliperColor, '#f2c200');
    var wheelFin = hex(get(b, 'wheels.finish', '#2b2b2b'), '#2b2b2b');
    var px = opts.idPrefix || 'psx';
    var ids = {
      paintV: px + '-pv', paintH: px + '-ph', shadeV: px + '-sv', flake: px + '-fl', carbon: px + '-cf', roofBlack: px + '-rb',
      roofGlass: px + '-rg', roofContrast: px + '-rc', clipSide: px + '-cs', clipTop: px + '-ct', beam: px + '-bm', grad: px + '-gr',
      gradT: px + '-gt', chrome: px + '-ch', glow: px + '-gw', rim: px + '-rim', shadow: px + '-sh'
    };
    var light = LIGHT_SPECS[x.lights] || LIGHT_SPECS.led;
    var stops = paintStops(p, x.finish);
    var d = '<defs>';
    if (x.finish === 'chameleon') {
      var shv = num(fin.hueShift_deg, 70);
      d += grad(ids.paintV, [[0, hueShift(p, shv)], [0.5, p], [1, hueShift(p, -shv)]], 1, 0.35);
    } else d += grad(ids.paintV, stops);
    d += grad(ids.paintH, [[0, shade(p, -0.4)], [0.22, p], [0.5, x.finish === 'chrome' ? mix(p, '#ffffff', 0.7) : shade(p, 0.18 * num(fin.gloss, 0.8))], [0.78, p], [1, shade(p, -0.4)]], 1, 0);
    d += grad(ids.shadeV, [[0, '#ffffff', 0.18 * num(fin.gloss, 0.8)], [0.45, '#ffffff', 0], [0.7, '#000000', 0], [1, '#000000', 0.45]]);
    d += '<pattern id="' + ids.flake + '" width="11" height="9" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="2" r=".4" fill="#fff" fill-opacity=".9"/><circle cx="7.2" cy="6.4" r=".35" fill="#fff" fill-opacity=".7"/><circle cx="4.1" cy="7.6" r=".3" fill="#fff" fill-opacity=".5"/><circle cx="9.6" cy="1.3" r=".3" fill="#000" fill-opacity=".5"/><circle cx="5.3" cy="3.4" r=".25" fill="#fff" fill-opacity=".6"/></pattern>';
    d += carbonPattern(ids.carbon, 5);
    d += grad(ids.roofBlack, [[0, '#3a3a3e'], [0.4, '#0d0d0f'], [1, '#000']]);
    d += grad(ids.roofGlass, [[0, '#6f8ea6'], [0.5, '#1d2a35'], [1, '#05080b']]);
    var rc = hex(x.roofColor, '#111111');
    d += grad(ids.roofContrast, [[0, shade(rc, 0.3)], [0.5, rc], [1, shade(rc, -0.4)]]);
    d += grad(ids.beam, [[0, light.glow, 0], [1, light.glow, 0.32]], 1, 0);
    d += grad(ids.grad, [[0, sc, 1], [0.55, sc, 0.55], [1, sc, 0]], 1, 0);
    d += grad(ids.gradT, [[0, sc, 1], [0.6, sc, 0.45], [1, sc, 0]], 0, 1);
    d += grad(ids.chrome, [[0, '#ffffff'], [0.45, '#9aa0a6'], [0.55, '#e9ecef'], [1, '#6c7177']]);
    d += '<radialGradient id="' + ids.rim + '"><stop offset="0" stop-color="' + shade(wheelFin, 0.35) + '"/><stop offset="1" stop-color="' + shade(wheelFin, -0.25) + '"/></radialGradient>';
    d += '<radialGradient id="' + ids.shadow + '" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>';
    d += '<filter id="' + ids.glow + '" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter>';

    /* ---------- side view geometry (viewBox 0..500 x 0..215, ground y=196) */
    var FW = 132, RW = 368, WY = 162, WR = 34;
    var body = 'M30 164 L27 146 Q28 128 54 122 L170 110 Q198 82 236 72 L326 68 Q378 72 418 100 L462 107 Q480 112 478 132 L476 164 ' +
      'L' + (RW + 42) + ' 164 A42 42 0 0 0 ' + (RW - 42) + ' 164 L' + (FW + 42) + ' 164 A42 42 0 0 0 ' + (FW - 42) + ' 164 Z';
    var glass = 'M188 107 Q212 86 239 78 L324 74 Q364 78 398 100 Z';
    d += '<clipPath id="' + ids.clipSide + '"><path d="' + body + '"/></clipPath>';

    /* ---------- plan view geometry (translated to x=525) */
    var TW = 92, TL = 200;
    var tb = 'M10 22 Q12 4 46 2 Q80 4 82 22 L86 70 L88 150 Q88 196 46 199 Q4 196 4 150 L6 70 Z';
    d += '<clipPath id="' + ids.clipTop + '"><path d="' + tb + '"/></clipPath>';
    d += '</defs>';

    var s = d;
    s += '<rect x="0" y="0" width="760" height="215" fill="none"/>';
    /* light beam (behind car) */
    if (x.lights !== 'halogen') s += '<path d="M30 132 L-10 112 L-10 168 Z" fill="url(#' + ids.beam + ')" opacity=".75"/>';
    s += '<ellipse cx="252" cy="198" rx="238" ry="9" fill="url(#' + ids.shadow + ')"/>';

    /* body */
    s += '<path d="' + body + '" fill="url(#' + ids.paintV + ')"/>';
    s += '<g clip-path="url(#' + ids.clipSide + ')">';
    if (x.finish === 'chameleon') s += '<rect x="0" y="0" width="500" height="200" fill="url(#' + ids.shadeV + ')"/>';
    if (fin.flake) s += '<rect x="0" y="0" width="500" height="200" fill="url(#' + ids.flake + ')" opacity="' + (0.12 + num(fin.metallic, 0.4) * 0.25).toFixed(2) + '"/>';
    if (x.finish === 'matte') s += '<rect x="0" y="0" width="500" height="200" fill="#000" opacity=".06"/>';
    /* stripes – side view */
    switch (x.stripe) {
      case 'side-skirt':
        s += '<rect x="40" y="149" width="440" height="8" fill="' + sc + '"/>';
        s += '<text x="' + ((FW + RW) / 2) + '" y="146" text-anchor="middle" font-size="9" font-weight="800" letter-spacing="3" fill="' + sc + '" font-family="system-ui,sans-serif">REDLINE</text>';
        break;
      case 'pinstripe':
        s += '<path d="M48 124 Q250 104 474 116" fill="none" stroke="' + sc + '" stroke-width="1.3"/>';
        s += '<path d="M48 128 Q250 108 474 120" fill="none" stroke="' + sc + '" stroke-width=".6"/>';
        break;
      case 'gradient':
        s += '<rect x="24" y="118" width="456" height="50" fill="url(#' + ids.grad + ')"/>';
        break;
      case 'le-mans':
        s += '<path d="M180 108 L214 108 L196 164 L162 164 Z" fill="' + sc + '"/>';
        break;
      case 'racing-dual':
      case 'center':
        s += '<path d="M54 122 L170 110 Q198 82 236 72 L326 68 Q378 72 418 100 L462 107" fill="none" stroke="' + sc + '" stroke-width="' + (x.stripe === 'center' ? 4 : 3) + '"/>';
        break;
      case 'hood':
        s += '<path d="M60 121 L168 110 L166 114 L60 125 Z" fill="' + sc + '" opacity=".9"/>';
        break;
    }
    /* shoulder specular + door line */
    s += '<path d="M56 126 Q250 106 472 116" fill="none" stroke="#fff" stroke-opacity="' + (0.5 * num(fin.gloss, 0.8)).toFixed(2) + '" stroke-width="1.6"/>';
    s += '</g>';
    /* roof (side) */
    s += '<path d="M232 74 Q236 70.5 242 70.5 L326 67 Q352 68 374 77 L366 79 Q348 73 326 72.5 L242 76 Z" fill="' + roofFill(x, ids) + '"/>';
    /* glass */
    s += '<path d="' + glass + '" fill="' + glassFill(x.windowTint_pct) + '" stroke="#0a0a0a" stroke-width="1.5"/>';
    s += '<path d="M300 75 L298 104" stroke="#0a0a0a" stroke-width="4"/>';
    s += '<path d="M206 98 Q236 80 262 77" stroke="#fff" stroke-opacity=".28" stroke-width="3" fill="none"/>';
    s += '<path d="M232 162 L234 112 M300 162 L300 110" stroke="#000" stroke-opacity=".35" stroke-width="1"/>';
    s += '<path d="M282 122 h12" stroke="' + (x.badge === 'black' ? '#0d0d0f' : '#c9ccd1') + '" stroke-width="2.4" stroke-linecap="round"/>';
    /* mirror */
    s += '<path d="M194 102 Q198 92 214 92 L218 100 Q206 104 194 102 Z" fill="' + mirrorFill(x, ids) + '" stroke="#000" stroke-opacity=".4"/>';
    /* lights */
    var hl = light.glow;
    s += '<path d="M31 131 Q40 124 64 121 L60 129 Q44 132 31 136 Z" fill="#141518" stroke="#000" stroke-opacity=".5"/>';
    if (x.lights === 'matrix' || x.lights === 'laser') {
      for (var i = 0; i < 6; i++) s += '<rect x="' + (35 + i * 4) + '" y="' + (128 - i * 0.8) + '" width="2.4" height="2.4" rx=".6" fill="' + hl + '"/>';
      if (x.lights === 'laser') s += '<circle cx="58" cy="125" r="2" fill="#4fb3ff"/>';
    } else if (x.lights === 'led') {
      s += '<path d="M34 133 Q46 126 62 123.5" stroke="' + hl + '" stroke-width="1.8" fill="none"/>';
    } else {
      s += '<circle cx="46" cy="128.5" r="3.4" fill="' + hl + '"/>';
    }
    s += '<path d="M33 133 Q46 126 62 123.5" stroke="' + hl + '" stroke-width="3" fill="none" filter="url(#' + ids.glow + ')" opacity=".7"/>';
    s += '<path d="M466 112 L477 116 L476 128 L468 126 Z" fill="#b0101a"/><path d="M468 114 L476 117" stroke="#ff4d5a" stroke-width="1.6"/>';
    /* badges */
    if (x.badge !== 'delete') {
      var bf = x.badge === 'black' ? '#0d0d0f' : 'url(#' + ids.chrome + ')';
      s += '<rect x="88" y="132" width="16" height="4" rx="1" fill="' + bf + '" stroke="#000" stroke-opacity=".3" stroke-width=".4"/>';
      s += '<rect x="446" y="116" width="12" height="3.2" rx="1" fill="' + bf + '"/>';
    }
    /* race number roundel (door) */
    if (x.livery_number) {
      var ring = x.stripe === 'le-mans' ? sc : '#111111';
      s += '<circle cx="266" cy="138" r="17" fill="#f4f3ef" stroke="' + ring + '" stroke-width="3"/>';
      s += '<text x="266" y="' + (138 + (x.livery_number.length > 2 ? 4.5 : 6)) + '" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="900" font-size="' + (x.livery_number.length > 2 ? 13 : 17) + '" fill="#111">' + esc(x.livery_number) + '</text>';
    }
    /* wheels */
    [FW, RW].forEach(function (cx) {
      s += '<circle cx="' + cx + '" cy="' + WY + '" r="' + WR + '" fill="#0c0c0d"/>';
      s += '<circle cx="' + cx + '" cy="' + WY + '" r="' + (WR - 2.5) + '" fill="none" stroke="#2a2a2c" stroke-width="1"/>';
      s += '<circle cx="' + cx + '" cy="' + WY + '" r="' + (WR - 8) + '" fill="#2e3033"/>';
      s += '<circle cx="' + cx + '" cy="' + WY + '" r="15" fill="#6f7378"/><circle cx="' + cx + '" cy="' + WY + '" r="11" fill="#55595e"/>';
      /* caliper (top-front quadrant) */
      var a0 = -150 * Math.PI / 180, a1 = -95 * Math.PI / 180, r = 15.5;
      s += '<path d="M' + f1(cx + r * Math.cos(a0)) + ' ' + f1(WY + r * Math.sin(a0)) + ' A' + r + ' ' + r + ' 0 0 1 ' + f1(cx + r * Math.cos(a1)) + ' ' + f1(WY + r * Math.sin(a1)) + '" stroke="' + cal + '" stroke-width="7" fill="none" stroke-linecap="round"/>';
      for (var k = 0; k < 5; k++) {
        var an = (k * 72 - 90) * Math.PI / 180;
        s += '<path d="M' + f1(cx + 5 * Math.cos(an)) + ' ' + f1(WY + 5 * Math.sin(an)) + ' L' + f1(cx + (WR - 8) * Math.cos(an - 0.12)) + ' ' + f1(WY + (WR - 8) * Math.sin(an - 0.12)) +
          ' L' + f1(cx + (WR - 8) * Math.cos(an + 0.12)) + ' ' + f1(WY + (WR - 8) * Math.sin(an + 0.12)) + ' Z" fill="url(#' + ids.rim + ')"/>';
      }
      s += '<circle cx="' + cx + '" cy="' + WY + '" r="' + (WR - 8) + '" fill="none" stroke="url(#' + ids.rim + ')" stroke-width="2.5"/>';
      s += '<circle cx="' + cx + '" cy="' + WY + '" r="5" fill="' + shade(wheelFin, 0.2) + '"/>';
    });

    /* ---------- plan view */
    var T = '<g transform="translate(560 8)">';
    T += '<ellipse cx="46" cy="102" rx="54" ry="104" fill="url(#' + ids.shadow + ')"/>';
    [[-3, 34], [83, 34], [-3, 146], [83, 146]].forEach(function (w) { T += '<rect x="' + w[0] + '" y="' + w[1] + '" width="12" height="30" rx="3" fill="#0c0c0d"/>'; });
    T += '<path d="' + tb + '" fill="url(#' + ids.paintH + ')"/>';
    T += '<g clip-path="url(#' + ids.clipTop + ')">';
    if (fin.flake) T += '<rect x="0" y="0" width="' + TW + '" height="' + TL + '" fill="url(#' + ids.flake + ')" opacity="' + (0.12 + num(fin.metallic, 0.4) * 0.25).toFixed(2) + '"/>';
    /* roof */
    T += '<rect x="12" y="86" width="68" height="62" rx="10" fill="' + roofFill(x, ids) + '"/>';
    /* glass */
    var gf = glassFill(Math.max(10, num(x.windowTint_pct, 20) * 0.6));
    T += '<path d="M14 66 Q46 58 78 66 L76 86 Q46 81 16 86 Z" fill="' + gf + '"/>';
    T += '<path d="M16 150 Q46 154 76 150 L72 166 Q46 169 20 166 Z" fill="' + glassFill(x.windowTint_pct) + '"/>';
    switch (x.stripe) {
      case 'racing-dual': T += '<rect x="31" y="0" width="11" height="' + TL + '" fill="' + sc + '"/><rect x="50" y="0" width="11" height="' + TL + '" fill="' + sc + '"/>'; break;
      case 'center': T += '<rect x="36" y="0" width="20" height="' + TL + '" fill="' + sc + '"/>'; break;
      case 'le-mans': T += '<rect x="54" y="0" width="13" height="' + TL + '" fill="' + sc + '"/>'; break;
      case 'hood': T += '<path d="M18 14 Q46 8 74 14 L76 58 Q46 54 16 58 Z" fill="' + sc + '" opacity=".92"/>'; break;
      case 'pinstripe': T += '<path d="M10 24 L12 150 M82 24 L80 150" stroke="' + sc + '" stroke-width="1.2" fill="none"/>'; break;
      case 'side-skirt': T += '<rect x="3" y="64" width="5" height="82" fill="' + sc + '"/><rect x="84" y="64" width="5" height="82" fill="' + sc + '"/>'; break;
      case 'gradient': T += '<rect x="0" y="0" width="' + TW + '" height="' + TL + '" fill="url(#' + ids.gradT + ')" opacity=".85"/>'; break;
    }
    T += '<path d="M24 6 Q46 2 68 6" stroke="#fff" stroke-opacity="' + (0.45 * num(fin.gloss, 0.8)).toFixed(2) + '" stroke-width="2" fill="none"/>';
    T += '</g>';
    /* mirrors, lights */
    T += '<path d="M2 72 L-8 70 L-8 78 L4 79 Z" fill="' + mirrorFill(x, ids) + '"/><path d="M90 72 L100 70 L100 78 L88 79 Z" fill="' + mirrorFill(x, ids) + '"/>';
    T += '<path d="M13 10 Q20 5 30 4" stroke="' + hl + '" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M79 10 Q72 5 62 4" stroke="' + hl + '" stroke-width="3" fill="none" stroke-linecap="round"/>';
    T += '<path d="M10 192 Q20 197 34 198" stroke="#ff2a3a" stroke-width="2.4" fill="none"/><path d="M82 192 Q72 197 58 198" stroke="#ff2a3a" stroke-width="2.4" fill="none"/>';
    if (x.livery_number) {
      T += '<circle cx="' + (x.stripe === 'le-mans' ? 60.5 : 46) + '" cy="117" r="15" fill="#f4f3ef" stroke="#111" stroke-width="1.5"/>';
      T += '<text x="' + (x.stripe === 'le-mans' ? 60.5 : 46) + '" y="122" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="900" font-size="' + (x.livery_number.length > 2 ? 10 : 14) + '" fill="#111">' + esc(x.livery_number) + '</text>';
    }
    if (x.badge !== 'delete') T += '<rect x="41" y="7" width="10" height="3" rx="1" fill="' + (x.badge === 'black' ? '#0d0d0f' : 'url(#' + ids.chrome + ')') + '"/>';
    T += '</g>';
    s += T;
    /* captions */
    s += '<text x="10" y="14" font-size="9" letter-spacing="1.6" fill="currentColor" opacity=".55" font-family="ui-monospace,monospace">PROFILE</text>';
    s += '<text x="560" y="214" font-size="9" letter-spacing="1.6" fill="currentColor" opacity=".55" font-family="ui-monospace,monospace">PLAN</text>';
    return svgDoc('-12 0 712 218', s, 'ps-livery', opts.label || 'Livery preview');
  }

  /* ======================================================================
     SVG: INTERIOR (rear-seat cockpit view)
     ====================================================================== */
  function upholsteryPattern(id, uph, P, A, S) {
    var hi = shade(P, 0.14), lo = shade(P, -0.28);
    var o = '<pattern id="' + id + '" patternUnits="userSpaceOnUse" ';
    switch (uph) {
      case 'cloth':
        return o + 'width="4" height="4"><rect width="4" height="4" fill="' + P + '"/><path d="M0 4L4 0M-1 1L1 -1M3 5L5 3" stroke="' + hi + '" stroke-width=".6" opacity=".7"/><path d="M0 0L4 4" stroke="' + lo + '" stroke-width=".5" opacity=".6"/></pattern>';
      case 'tartan':
        return o + 'width="26" height="26"><rect width="26" height="26" fill="' + P + '"/>' +
          '<rect x="3" width="7" height="26" fill="' + A + '" opacity=".55"/><rect y="3" width="26" height="7" fill="' + A + '" opacity=".5"/>' +
          '<rect x="17" width="1.2" height="26" fill="' + S + '" opacity=".85"/><rect y="17" width="26" height="1.2" fill="' + S + '" opacity=".85"/>' +
          '<rect x="21" width="2.5" height="26" fill="' + lo + '" opacity=".6"/><rect y="21" width="26" height="2.5" fill="' + lo + '" opacity=".6"/></pattern>';
      case 'vegan':
        return o + 'width="5" height="5"><rect width="5" height="5" fill="' + P + '"/><circle cx="1.2" cy="1.4" r=".6" fill="' + hi + '" opacity=".6"/><circle cx="3.6" cy="3.8" r=".5" fill="' + lo + '" opacity=".6"/></pattern>';
      case 'alcantara':
        return o + 'width="3" height="3"><rect width="3" height="3" fill="' + P + '"/><circle cx=".8" cy=".8" r=".45" fill="' + hi + '" opacity=".45"/><circle cx="2.2" cy="2.1" r=".45" fill="' + lo + '" opacity=".5"/></pattern>';
      case 'nappa':
        return o + 'width="18" height="18"><rect width="18" height="18" fill="' + P + '"/><path d="M9 0L18 9L9 18L0 9Z" fill="' + hi + '" opacity=".3" stroke="' + S + '" stroke-width=".9" stroke-dasharray="1.6 1.2"/>' +
          '<circle cx="9" cy="9" r=".9" fill="#000" opacity=".5"/><circle cx="4.5" cy="9" r=".6" fill="#000" opacity=".4"/><circle cx="13.5" cy="9" r=".6" fill="#000" opacity=".4"/><circle cx="9" cy="4.5" r=".6" fill="#000" opacity=".4"/><circle cx="9" cy="13.5" r=".6" fill="#000" opacity=".4"/></pattern>';
      case 'carbon-weave':
        return o + 'width="16" height="16"><rect width="16" height="16" fill="' + P + '"/><rect x="5" width="6" height="16" fill="#1d1f22"/>' +
          '<path d="M5 0L11 4M5 4L11 8M5 8L11 12M5 12L11 16" stroke="#3a3e43" stroke-width="1.2"/><rect x="4.4" width=".6" height="16" fill="' + S + '"/><rect x="11" width=".6" height="16" fill="' + S + '"/></pattern>';
      case 'semi-aniline':
        return o + 'width="14" height="10"><rect width="14" height="10" fill="' + P + '"/><rect width="1.6" height="10" fill="' + lo + '" opacity=".75"/><rect x="1.6" width="3" height="10" fill="' + hi + '" opacity=".35"/><rect x=".4" width=".5" height="10" fill="' + S + '" opacity=".8"/></pattern>';
      default: /* leather */
        return o + 'width="8" height="8"><rect width="8" height="8" fill="' + P + '"/><circle cx="2" cy="2.5" r=".7" fill="' + lo + '" opacity=".45"/><circle cx="6" cy="6" r=".6" fill="' + lo + '" opacity=".35"/><circle cx="5.5" cy="1.5" r=".4" fill="' + hi + '" opacity=".4"/></pattern>';
    }
  }

  function trimPattern(id, trim) {
    var o = '<pattern id="' + id + '" patternUnits="userSpaceOnUse" ';
    var c = TRIM_COLORS[trim] || ['#888', '#444'];
    switch (trim) {
      case 'aluminum':
        return o + 'width="6" height="6"><rect width="6" height="6" fill="' + c[0] + '"/><path d="M0 6L6 0M0 0L6 6" stroke="' + c[1] + '" stroke-width=".6" opacity=".7"/><path d="M0 3H6" stroke="#fff" stroke-width=".4" opacity=".5"/></pattern>';
      case 'piano-black':
        return o + 'width="60" height="18"><rect width="60" height="18" fill="' + c[1] + '"/><path d="M0 4 Q30 1 60 4 L60 6 Q30 3 0 6Z" fill="#fff" opacity=".22"/></pattern>';
      case 'gloss-walnut':
        return o + 'width="48" height="18"><rect width="48" height="18" fill="' + c[0] + '"/><path d="M0 4 Q12 1 24 5 T48 4 M0 9 Q10 13 22 9 T48 10 M0 14 Q14 11 26 15 T48 14" stroke="' + c[1] + '" stroke-width="1.3" fill="none" opacity=".75"/>' +
          '<ellipse cx="14" cy="9" rx="4" ry="2" fill="none" stroke="#8a5a2c" stroke-width=".8"/><path d="M0 2 Q24 0 48 2" stroke="#fff" stroke-width="1" opacity=".25"/></pattern>';
      case 'open-pore-wood':
        return o + 'width="40" height="18"><rect width="40" height="18" fill="' + c[0] + '"/><path d="M0 3 Q20 5 40 3 M0 8 Q18 6 40 8.5 M0 13 Q22 15 40 13" stroke="' + c[1] + '" stroke-width="1" fill="none" opacity=".8"/>' +
          '<rect x="0" y="16.4" width="40" height=".8" fill="#c9ccd1" opacity=".8"/></pattern>';
      case 'carbon':
        return carbonPattern(id, 6, c[0], c[1]);
      case 'forged-carbon':
        return o + 'width="30" height="30"><rect width="30" height="30" fill="' + c[1] + '"/>' +
          '<path d="M2 4 L10 2 L12 8 L5 9Z" fill="#3b3e42"/><path d="M16 3 L27 6 L24 11 L15 9Z" fill="#2a2c2f"/><path d="M4 14 L13 12 L14 19 L6 21Z" fill="#45494e"/>' +
          '<path d="M18 15 L28 13 L29 22 L20 24Z" fill="#33363a"/><path d="M3 24 L11 25 L9 29 L2 29Z" fill="#2c2f32"/><path d="M13 22 L19 26 L15 29 L11 27Z" fill="#4e5257"/></pattern>';
      case 'brushed-titanium':
        return o + 'width="40" height="4"><rect width="40" height="4" fill="' + c[0] + '"/><path d="M0 1H40M0 3H40" stroke="' + c[1] + '" stroke-width=".5" opacity=".7"/><path d="M0 2H25" stroke="#fff" stroke-width=".4" opacity=".4"/></pattern>';
      default:
        return o + 'width="4" height="4"><rect width="4" height="4" fill="' + c[0] + '"/></pattern>';
    }
  }

  /** Seat geometry from behind, per seat type. Returns svg fragment. */
  function seatSvg(cx, type, C, ids, harness) {
    var P = C.primary, A = C.accent, S = C.stitch;
    var specs = {
      'comfort': { w: 156, top: 262, hr: [86, 40, 218], bol: 14, integrated: false },
      'sport': { w: 146, top: 256, hr: [74, 38, 214], bol: 24, integrated: false },
      'lounge': { w: 176, top: 262, hr: [104, 46, 210], bol: 12, integrated: false, quilt: true },
      'bucket': { w: 136, top: 216, head: 70, bol: 30, integrated: true, slots: true },
      'carbon-bucket': { w: 134, top: 214, head: 68, bol: 30, integrated: true, slots: true, carbon: true },
      'race-shell': { w: 140, top: 206, head: 112, bol: 26, integrated: true, slots: true, shell: true }
    };
    var g = specs[type] || specs.sport;
    var L = cx - g.w / 2, R = cx + g.w / 2, top = g.top, B = 364;
    var back, out = '';
    if (g.integrated) {
      var hw = g.head, sh = top + 58, nk = top + 38;
      if (g.shell) { sh = top + 62; nk = top + 58; }
      back = 'M' + L + ' ' + B + ' L' + (L + 4) + ' ' + (sh + 22) + ' Q' + (L + 6) + ' ' + sh + ' ' + (L + 20) + ' ' + (sh - 6) +
        ' L' + (cx - hw / 2) + ' ' + nk + ' Q' + (cx - hw / 2 - 4) + ' ' + (top + 6) + ' ' + (cx - hw / 2 + 12) + ' ' + top +
        ' L' + (cx + hw / 2 - 12) + ' ' + top + ' Q' + (cx + hw / 2 + 4) + ' ' + (top + 6) + ' ' + (cx + hw / 2) + ' ' + nk +
        ' L' + (R - 20) + ' ' + (sh - 6) + ' Q' + (R - 6) + ' ' + sh + ' ' + (R - 4) + ' ' + (sh + 22) + ' L' + R + ' ' + B + ' Z';
    } else {
      back = 'M' + L + ' ' + B + ' L' + (L + 3) + ' ' + (top + 30) + ' Q' + (L + 5) + ' ' + top + ' ' + (L + 34) + ' ' + top +
        ' L' + (R - 34) + ' ' + top + ' Q' + (R - 5) + ' ' + top + ' ' + (R - 3) + ' ' + (top + 30) + ' L' + R + ' ' + B + ' Z';
      /* headrest + posts */
      var hr = g.hr;
      out += '<path d="M' + (cx - 14) + ' ' + (hr[2] + hr[1] - 4) + ' V' + (top + 4) + ' M' + (cx + 14) + ' ' + (hr[2] + hr[1] - 4) + ' V' + (top + 4) + '" stroke="#9aa0a6" stroke-width="3.2"/>';
      out += '<rect x="' + (cx - hr[0] / 2) + '" y="' + hr[2] + '" width="' + hr[0] + '" height="' + hr[1] + '" rx="' + (g.quilt ? 20 : 13) + '" fill="url(#' + ids.uph + ')" stroke="' + shade(P, -0.45) + '" stroke-width="1.2"/>';
      out += '<rect x="' + (cx - hr[0] / 2 + 6) + '" y="' + (hr[2] + 5) + '" width="' + (hr[0] - 12) + '" height="' + (hr[1] - 10) + '" rx="' + (g.quilt ? 15 : 9) + '" fill="none" stroke="' + S + '" stroke-width="1" stroke-dasharray="2.4 1.8"/>';
      out += '<path d="M' + (cx - hr[0] / 2 + 10) + ' ' + (hr[2] + 6) + ' Q' + cx + ' ' + (hr[2] + 1) + ' ' + (cx + hr[0] / 2 - 10) + ' ' + (hr[2] + 6) + '" stroke="#fff" stroke-opacity=".18" stroke-width="2" fill="none"/>';
    }
    var shellFill = g.carbon ? 'url(#' + ids.carbon + ')' : g.shell ? 'url(#' + ids.shell + ')' : 'url(#' + ids.uph + ')';
    out += '<path d="' + back + '" fill="' + shellFill + '" stroke="' + (g.carbon || g.shell ? A : shade(P, -0.5)) + '" stroke-width="' + (g.carbon || g.shell ? 1.6 : 1.2) + '"/>';
    out += '<path d="' + back + '" fill="url(#' + ids.seatShade + ')"/>';
    /* bolsters / piping in accent */
    var bTop = g.integrated ? top + 66 : top + 18;
    if (!g.carbon && !g.shell) {
      out += '<path d="M' + (L + 4) + ' ' + B + ' L' + (L + 6) + ' ' + (bTop + 10) + ' Q' + (L + 8) + ' ' + bTop + ' ' + (L + g.bol) + ' ' + (bTop - 2) + ' L' + (L + g.bol + 4) + ' ' + B + ' Z" fill="' + A + '" opacity="' + (g.bol > 20 ? 0.85 : 0.55) + '"/>';
      out += '<path d="M' + (R - 4) + ' ' + B + ' L' + (R - 6) + ' ' + (bTop + 10) + ' Q' + (R - 8) + ' ' + bTop + ' ' + (R - g.bol) + ' ' + (bTop - 2) + ' L' + (R - g.bol - 4) + ' ' + B + ' Z" fill="' + A + '" opacity="' + (g.bol > 20 ? 0.85 : 0.55) + '"/>';
      /* centre insert */
      var iL = L + g.bol + 10, iR = R - g.bol - 10, iT = bTop + 6;
      out += '<rect x="' + iL + '" y="' + iT + '" width="' + (iR - iL) + '" height="' + (B - iT) + '" rx="8" fill="url(#' + ids.uph + ')" stroke="' + shade(P, -0.4) + '" stroke-width=".8"/>';
      out += '<rect x="' + (iL + 4) + '" y="' + (iT + 4) + '" width="' + (iR - iL - 8) + '" height="' + (B - iT) + '" rx="6" fill="none" stroke="' + S + '" stroke-width="1.1" stroke-dasharray="2.6 1.8"/>';
      if (g.quilt) for (var q = iT + 18; q < B; q += 16) out += '<path d="M' + (iL + 4) + ' ' + q + ' H' + (iR - 4) + '" stroke="' + S + '" stroke-width=".8" stroke-dasharray="2 1.6" opacity=".8"/>';
      if (type === 'comfort' || type === 'lounge') out += '<rect x="' + (cx - 20) + '" y="' + (B - 34) + '" width="40" height="18" rx="4" fill="' + shade(P, -0.35) + '" opacity=".7"/>'; // map pocket
    } else {
      /* shell seats: visible pads at the edges + accent spine */
      out += '<path d="M' + (L + 6) + ' ' + (top + 70) + ' Q' + (L + 2) + ' ' + (top + 100) + ' ' + (L + 4) + ' ' + B + '" stroke="url(#' + ids.uph + ')" stroke-width="7" fill="none"/>';
      out += '<path d="M' + (R - 6) + ' ' + (top + 70) + ' Q' + (R - 2) + ' ' + (top + 100) + ' ' + (R - 4) + ' ' + B + '" stroke="url(#' + ids.uph + ')" stroke-width="7" fill="none"/>';
      out += '<path d="M' + (L + 10) + ' ' + (top + 74) + ' Q' + (L + 6) + ' ' + (top + 104) + ' ' + (L + 8) + ' ' + B + '" stroke="' + S + '" stroke-width=".9" stroke-dasharray="2 1.6" fill="none"/>';
      out += '<path d="M' + (R - 10) + ' ' + (top + 74) + ' Q' + (R - 6) + ' ' + (top + 104) + ' ' + (R - 8) + ' ' + B + '" stroke="' + S + '" stroke-width=".9" stroke-dasharray="2 1.6" fill="none"/>';
      out += '<rect x="' + (cx - 4) + '" y="' + (top + 76) + '" width="8" height="' + (B - top - 76) + '" fill="' + A + '" opacity=".9"/>';
      if (g.shell) out += '<text x="' + cx + '" y="' + (top + 140) + '" text-anchor="middle" font-size="7" font-weight="700" fill="#fff" opacity=".55" font-family="system-ui,sans-serif" letter-spacing="1.5">FIA 8855</text>';
    }
    /* integrated head opening + harness slots */
    if (g.slots) {
      out += '<rect x="' + (cx - 24) + '" y="' + (top + 68) + '" width="13" height="22" rx="5" fill="#050506"/><rect x="' + (cx + 11) + '" y="' + (top + 68) + '" width="13" height="22" rx="5" fill="#050506"/>';
      out += '<rect x="' + (cx - 7) + '" y="' + (top + 140) + '" width="14" height="10" rx="4" fill="#050506"/>';
    }
    if (harness) {
      var sy = g.slots ? top + 70 : top - 2;
      var hc = A;
      out += '<path d="M' + (cx - 18) + ' ' + sy + ' L' + (cx - 30) + ' 330 M' + (cx + 18) + ' ' + sy + ' L' + (cx + 30) + ' 330" stroke="' + hc + '" stroke-width="9" stroke-linecap="square"/>';
      out += '<path d="M' + (cx - 18) + ' ' + sy + ' L' + (cx - 30) + ' 330 M' + (cx + 18) + ' ' + sy + ' L' + (cx + 30) + ' 330" stroke="#000" stroke-opacity=".25" stroke-width="1" stroke-dasharray="3 3"/>';
      out += '<rect x="' + (cx - 36) + '" y="304" width="13" height="8" rx="1.5" fill="url(#' + ids.metal + ')"/><rect x="' + (cx + 23) + '" y="304" width="13" height="8" rx="1.5" fill="url(#' + ids.metal + ')"/>';
    }
    return out;
  }

  function steeringSvg(type, cx, cy, C, ids, paddles) {
    var rim = C.rim, S = C.stitch, A = C.accent, s = '';
    var spoke = type === 'race-quick-release' ? '#8a8f95' : '#5d6166';
    if (paddles) s += '<path d="M' + (cx - 66) + ' ' + (cy - 30) + ' l-14 6 l2 22 l14 -4 Z M' + (cx + 66) + ' ' + (cy - 30) + ' l14 6 l-2 22 l-14 -4 Z" fill="url(#' + ids.carbon + ')" stroke="#000" stroke-width=".6"/>';
    if (type === 'yoke') {
      var yk = 'M' + (cx - 66) + ' ' + (cy - 26) + ' Q' + (cx - 74) + ' ' + (cy + 28) + ' ' + (cx - 48) + ' ' + (cy + 38) + ' H' + (cx + 48) + ' Q' + (cx + 74) + ' ' + (cy + 28) + ' ' + (cx + 66) + ' ' + (cy - 26) +
        ' L' + (cx + 52) + ' ' + (cy - 30) + ' Q' + (cx + 50) + ' ' + (cy + 12) + ' ' + (cx + 30) + ' ' + (cy + 18) + ' H' + (cx - 30) + ' Q' + (cx - 50) + ' ' + (cy + 12) + ' ' + (cx - 52) + ' ' + (cy - 30) + ' Z';
      s += '<path d="' + yk + '" fill="' + rim + '" stroke="#000" stroke-opacity=".5"/>';
      s += '<path d="M' + (cx - 59) + ' ' + (cy - 24) + ' Q' + (cx - 64) + ' ' + (cy + 22) + ' ' + (cx - 44) + ' ' + (cy + 30) + ' H' + (cx + 44) + ' Q' + (cx + 64) + ' ' + (cy + 22) + ' ' + (cx + 59) + ' ' + (cy - 24) + '" stroke="' + S + '" stroke-dasharray="2 1.6" fill="none"/>';
      s += '<rect x="' + (cx - 30) + '" y="' + (cy - 14) + '" width="60" height="32" rx="10" fill="url(#' + ids.trim + ')" stroke="#000" stroke-opacity=".4"/>';
      s += '<circle cx="' + (cx - 46) + '" cy="' + (cy - 4) + '" r="3" fill="#2a2c2f"/><circle cx="' + (cx + 46) + '" cy="' + (cy - 4) + '" r="3" fill="#2a2c2f"/>';
      return s;
    }
    var r = type === 'race-quick-release' ? 48 : 56, w = type === 'race-quick-release' ? 9 : 11;
    if (type === 'flat-bottom') {
      var fy = cy + r * 0.78, fx = Math.sqrt(r * r - (fy - cy) * (fy - cy));
      var D_ = 'M' + f1(cx - fx) + ' ' + f1(fy) + ' A' + r + ' ' + r + ' 0 1 1 ' + f1(cx + fx) + ' ' + f1(fy) + ' Z';
      s += '<path d="' + D_ + '" fill="none" stroke="' + rim + '" stroke-width="' + w + '" stroke-linejoin="round"/>';
      s += '<path d="' + D_ + '" fill="none" stroke="' + S + '" stroke-width=".9" stroke-dasharray="2.2 1.8"/>';
    } else {
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + rim + '" stroke-width="' + w + '"/>';
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + S + '" stroke-width=".9" stroke-dasharray="2.2 1.8"/>';
    }
    s += '<path d="M' + cx + ' ' + (cy - r - w / 2) + ' v' + w + '" stroke="' + (type === 'round' ? S : A) + '" stroke-width="' + (type === 'round' ? 2 : 6) + '"/>';
    /* spokes */
    var sw = type === 'race-quick-release' ? 9 : 12;
    s += '<path d="M' + (cx - r + 2) + ' ' + cy + ' L' + (cx - 14) + ' ' + (cy + 4) + ' M' + (cx + r - 2) + ' ' + cy + ' L' + (cx + 14) + ' ' + (cy + 4) + ' M' + cx + ' ' + (cy + 14) + ' L' + cx + ' ' + (cy + r - 2) + '" stroke="' + spoke + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
    if (type === 'race-quick-release') {
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="17" fill="url(#' + ids.metal + ')" stroke="#000" stroke-opacity=".5"/>';
      for (var i = 0; i < 6; i++) { var an = i * Math.PI / 3; s += '<circle cx="' + f1(cx + 12 * Math.cos(an)) + '" cy="' + f1(cy + 12 * Math.sin(an)) + '" r="1.6" fill="#1a1a1a"/>'; }
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="' + A + '"/>';
      s += '<circle cx="' + (cx - 30) + '" cy="' + (cy - 8) + '" r="3.4" fill="#d40000"/><circle cx="' + (cx + 30) + '" cy="' + (cy - 8) + '" r="3.4" fill="#f6c200"/>';
    } else {
      s += '<path d="M' + (cx - 20) + ' ' + (cy - 10) + ' H' + (cx + 20) + ' L' + (cx + 16) + ' ' + (cy + 16) + ' H' + (cx - 16) + ' Z" fill="' + shade(rim, -0.25) + '" stroke="#000" stroke-opacity=".4"/>';
      s += '<text x="' + cx + '" y="' + (cy + 6) + '" text-anchor="middle" font-size="7" font-weight="800" fill="#c9ccd1" font-family="system-ui,sans-serif" letter-spacing="1">F</text>';
    }
    return s;
  }

  function cageSvg(level, ids) {
    if (!level || level === 'none') return '';
    var tube = 'url(#' + ids.cage + ')', s = '';
    /* main hoop behind the front seats (between camera and seats) */
    s += '<path d="M54 364 L66 168 Q70 126 112 122 H528 Q570 126 574 168 L586 364" fill="none" stroke="' + tube + '" stroke-width="13" stroke-linejoin="round"/>';
    s += '<path d="M78 300 H562" stroke="' + tube + '" stroke-width="10"/>'; // harness bar
    s += '<path d="M112 122 L-10 70 M528 122 L650 70" stroke="' + tube + '" stroke-width="12"/>'; // rear stays toward camera
    s += '<rect x="290" y="114" width="60" height="16" rx="8" fill="#141416"/>';
    if (level === 'full') {
      s += '<path d="M70 170 L570 298" stroke="' + tube + '" stroke-width="8" opacity=".75"/>'; // diagonal
      s += '<path d="M112 122 L132 46 M528 122 L508 46" stroke="' + tube + '" stroke-width="10"/>'; // roof bars to A-pillar
      s += '<path d="M132 46 L46 152 M508 46 L594 152" stroke="' + tube + '" stroke-width="9"/>'; // A-pillar tubes
      s += '<path d="M8 180 L60 260 M60 180 L8 260 M632 180 L580 260 M580 180 L632 260" stroke="' + tube + '" stroke-width="8"/>'; // door X bars
      s += '<path d="M132 46 H508" stroke="' + tube + '" stroke-width="7"/>';
    }
    /* weld gussets */
    s += '<circle cx="112" cy="122" r="6" fill="' + tube + '"/><circle cx="528" cy="122" r="6" fill="' + tube + '"/>';
    return s;
  }

  /** Inline SVG of the cockpit seen from the rear bench. Reflects every interior option + some tech. */
  function interiorSvg(b, opts) {
    opts = opts || {};
    var n = b.interior || {}, t = b.tech || {};
    var px = opts.idPrefix || 'psi';
    var ids = {
      uph: px + '-uph', trim: px + '-trim', carbon: px + '-cf', shell: px + '-sh', seatShade: px + '-ss', metal: px + '-mt', cage: px + '-cg',
      glow: px + '-gl', sky: px + '-sky', dash: px + '-dash', head: px + '-hd', bg: px + '-bg', amb: px + '-amb', scr: px + '-scr'
    };
    var P = hex(n.primaryColor, '#1a1a1a'), A = hex(n.accentColor, '#b3121f'), S = hex(n.stitchColor, '#b3121f');
    var amb = hex(n.ambientColor, '#ff3344');
    var C = { primary: P, accent: A, stitch: S, rim: n.steering === 'race-quick-release' || n.upholstery === 'alcantara' ? mix(P, '#2a2a2c', 0.5) : shade(P, -0.12) };
    var headBase = n.headliner === 'cloth' ? mix(P, '#55575c', 0.6) : n.headliner === 'leather' ? shade(P, 0.05) : mix(P, '#2a2a2c', 0.4);
    var d = '<defs>';
    d += upholsteryPattern(ids.uph, n.upholstery, P, A, S);
    d += trimPattern(ids.trim, n.trim);
    d += carbonPattern(ids.carbon, 6);
    d += grad(ids.shell, [[0, '#2a2b2e'], [0.5, '#161618'], [1, '#0b0b0c']], 1, 0.4);
    d += grad(ids.seatShade, [[0, '#ffffff', 0.12], [0.35, '#000000', 0], [1, '#000000', 0.45]]);
    d += grad(ids.metal, [[0, '#e3e6ea'], [0.5, '#8d9298'], [1, '#c9cdd2']]);
    d += grad(ids.cage, [[0, '#4a4d52'], [0.5, '#1d1e21'], [1, '#3a3d41']], 1, 1);
    d += grad(ids.sky, [[0, '#8ea8bd'], [0.6, '#c8d4dd'], [1, '#6a7b6a']]);
    d += grad(ids.dash, [[0, shade(P, 0.08)], [0.25, shade(P, -0.15)], [1, shade(P, -0.55)]]);
    d += grad(ids.head, [[0, shade(headBase, -0.3)], [1, headBase]]);
    d += grad(ids.bg, [[0, '#121214'], [1, '#050506']]);
    d += grad(ids.scr, [[0, '#0d1b2a'], [1, '#05080c']]);
    d += '<radialGradient id="' + ids.amb + '"><stop offset="0" stop-color="' + amb + '" stop-opacity=".55"/><stop offset="1" stop-color="' + amb + '" stop-opacity="0"/></radialGradient>';
    d += '<filter id="' + ids.glow + '" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="3.2"/></filter>';
    if (n.headliner === 'leather') d += '<pattern id="' + ids.head + 'p" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r=".7" fill="#000" opacity=".45"/></pattern>';
    d += '</defs>';

    var s = d;
    s += '<rect width="640" height="360" fill="url(#' + ids.bg + ')"/>';
    /* windscreen + scenery */
    s += '<path d="M118 40 H522 L606 152 H34 Z" fill="url(#' + ids.sky + ')"/>';
    s += '<path d="M34 152 L250 118 Q320 112 390 118 L606 152 Z" fill="#3d4a3c" opacity=".8"/><path d="M300 152 L316 116 H324 L340 152 Z" fill="#55595e"/>';
    s += '<path d="M316 120 v6 M318 134 v8" stroke="#e8e8e8" stroke-width="1.4"/>';
    /* HUD projection */
    if (t.hud) {
      s += '<g opacity=".9" font-family="ui-monospace,monospace" fill="#7dffb0"><text x="200" y="104" text-anchor="middle" font-size="18" font-weight="700">128</text><text x="200" y="114" text-anchor="middle" font-size="6.5">KM/H</text>' +
        '<path d="M238 104 l8 -10 l8 10 h-5 v8 h-6 v-8 Z" fill="#7dffb0" opacity=".85"/><path d="M160 112 l-6 -8 M166 112 l-4 -8" stroke="#7dffb0" stroke-width="1.4"/></g>';
    }
    /* headliner + pillars */
    s += '<path d="M0 0 H640 V64 Q606 46 522 40 H118 Q34 46 0 64 Z" fill="url(#' + ids.head + ')"/>';
    if (n.headliner === 'leather') s += '<path d="M0 0 H640 V64 Q606 46 522 40 H118 Q34 46 0 64 Z" fill="url(#' + ids.head + 'p)"/>';
    if (n.headliner === 'alcantara') s += '<path d="M0 0 H640 V64 Q606 46 522 40 H118 Q34 46 0 64 Z" fill="url(#' + ids.uph + ')" opacity=".25"/>';
    s += '<path d="M0 64 Q34 46 118 40 L34 152 L0 176 Z" fill="' + shade(headBase, -0.25) + '"/><path d="M640 64 Q606 46 522 40 L606 152 L640 176 Z" fill="' + shade(headBase, -0.25) + '"/>';
    s += '<rect x="296" y="6" width="48" height="16" rx="5" fill="#0b0b0c" stroke="' + shade(headBase, 0.2) + '" stroke-width=".8"/>'; // overhead console
    if (n.ambientLighting) s += '<path d="M120 42 H520" stroke="' + amb + '" stroke-width="2" opacity=".55" filter="url(#' + ids.glow + ')"/>';
    /* dashboard */
    s += '<path d="M0 176 L34 152 H606 L640 176 V268 H0 Z" fill="url(#' + ids.dash + ')"/>';
    s += '<path d="M34 152 Q320 140 606 152" stroke="' + S + '" stroke-width="1" stroke-dasharray="2.6 2" fill="none" opacity=".9"/>';
    /* trim strip + ambient glow */
    s += '<path d="M4 202 H636 V220 H4 Z" fill="url(#' + ids.trim + ')"/><path d="M4 202 H636" stroke="#fff" stroke-opacity=".18"/>';
    if (n.ambientLighting) {
      s += '<path d="M8 223 H632" stroke="' + amb + '" stroke-width="3" filter="url(#' + ids.glow + ')"/><path d="M8 223 H632" stroke="' + mix(amb, '#ffffff', 0.4) + '" stroke-width="1"/>';
      s += '<ellipse cx="160" cy="300" rx="140" ry="60" fill="url(#' + ids.amb + ')"/><ellipse cx="480" cy="300" rx="140" ry="60" fill="url(#' + ids.amb + ')"/>';
    }
    /* vents */
    [[46, 180], [560, 180], [232, 226], [374, 226]].forEach(function (v) {
      s += '<rect x="' + v[0] + '" y="' + v[1] + '" width="34" height="18" rx="5" fill="#0a0a0b" stroke="url(#' + ids.metal + ')" stroke-width="1.4"/>';
      for (var i = 1; i < 4; i++) s += '<path d="M' + (v[0] + 3) + ' ' + (v[1] + i * 4.5) + ' h28" stroke="#3a3c40" stroke-width="1"/>';
    });
    /* instrument cluster (behind wheel) */
    var cX = 200, cY = 172;
    s += '<path d="M' + (cX - 74) + ' 160 Q' + cX + ' 132 ' + (cX + 74) + ' 160 Z" fill="' + shade(P, -0.5) + '"/>';
    if (t.digitalCluster) {
      s += '<rect x="' + (cX - 62) + '" y="' + (cY - 14) + '" width="124" height="38" rx="7" fill="url(#' + ids.scr + ')" stroke="#000"/>';
      s += '<path d="M' + (cX - 50) + ' ' + (cY + 18) + ' A30 30 0 0 1 ' + (cX - 4) + ' ' + (cY - 6) + '" stroke="' + A + '" stroke-width="3" fill="none"/>';
      s += '<text x="' + (cX + 26) + '" y="' + (cY + 10) + '" text-anchor="middle" font-size="14" font-weight="700" fill="#e8f2ff" font-family="ui-monospace,monospace">88</text>';
      if (t.nightVision) s += '<rect x="' + (cX + 6) + '" y="' + (cY - 10) + '" width="22" height="14" rx="2" fill="#151515"/><circle cx="' + (cX + 17) + '" cy="' + (cY - 6) + '" r="2" fill="#ffd27a"/><path d="M' + (cX + 17) + ' ' + (cY - 4) + ' v6" stroke="#ffd27a" stroke-width="2.4"/>';
    } else {
      [cX - 32, cX + 32].forEach(function (gx, gi) {
        s += '<circle cx="' + gx + '" cy="' + (cY + 4) + '" r="19" fill="#0c0c0d" stroke="url(#' + ids.metal + ')" stroke-width="2"/>';
        for (var k = 0; k < 9; k++) { var an = (-220 + k * 32.5) * Math.PI / 180; s += '<path d="M' + f1(gx + 15 * Math.cos(an)) + ' ' + f1(cY + 4 + 15 * Math.sin(an)) + ' L' + f1(gx + 18 * Math.cos(an)) + ' ' + f1(cY + 4 + 18 * Math.sin(an)) + '" stroke="#ddd" stroke-width=".8"/>'; }
        var na = (gi ? -40 : -120) * Math.PI / 180;
        s += '<path d="M' + gx + ' ' + (cY + 4) + ' L' + f1(gx + 14 * Math.cos(na)) + ' ' + f1(cY + 4 + 14 * Math.sin(na)) + '" stroke="' + A + '" stroke-width="1.6"/>';
      });
    }
    /* centre screen */
    var scr = num(t.screen_in, 12);
    if (scr > 0) {
      var spec = SCREEN_SPECS[scr] || SCREEN_SPECS[12];
      var sw2, sh2, sx, sy;
      if (spec.layout === 'hyper') { sw2 = 300; sh2 = 30; sx = 300 - 40; sy = 156; }
      else if (spec.layout === 'portrait') { sw2 = 86; sh2 = 104; sx = 320; sy = 140; }
      else { sw2 = scr * 11; sh2 = Math.round(sw2 * 0.46); sx = 320; sy = 168 - sh2 / 2; }
      var x0 = sx - sw2 / 2;
      s += '<rect x="' + f1(x0 - 3) + '" y="' + f1(sy - 3) + '" width="' + f1(sw2 + 6) + '" height="' + f1(sh2 + 6) + '" rx="7" fill="#050506"/>';
      s += '<rect x="' + f1(x0) + '" y="' + f1(sy) + '" width="' + f1(sw2) + '" height="' + f1(sh2) + '" rx="5" fill="url(#' + ids.scr + ')"/>';
      s += '<path d="M' + f1(x0 + 6) + ' ' + f1(sy + sh2 - 8) + ' Q' + f1(x0 + sw2 * 0.4) + ' ' + f1(sy + sh2 * 0.3) + ' ' + f1(x0 + sw2 - 8) + ' ' + f1(sy + 8) + '" stroke="#3aa0ff" stroke-width="2" fill="none"/>';
      s += '<rect x="' + f1(x0 + 4) + '" y="' + f1(sy + 4) + '" width="' + f1(Math.min(30, sw2 * 0.25)) + '" height="5" rx="2" fill="' + A + '" opacity=".8"/>';
      s += '<path d="M' + f1(x0 + 4) + ' ' + f1(sy + 2) + ' h' + f1(sw2 * 0.5) + '" stroke="#fff" stroke-opacity=".15" stroke-width="2"/>';
    } else {
      for (var bI = 0; bI < 6; bI++) s += '<rect x="' + (284 + bI * 12) + '" y="166" width="8" height="10" rx="2" fill="url(#' + ids.metal + ')"/>';
      s += '<circle cx="320" cy="190" r="7" fill="url(#' + ids.metal + ')"/>';
    }
    /* climate strip (zones) */
    var zones = clamp(num(t.climateZones, 2), 1, 4);
    for (var z = 0; z < zones; z++) s += '<text x="' + (320 + (z - (zones - 1) / 2) * 30) + '" y="248" text-anchor="middle" font-size="7.5" fill="#cfd6de" font-family="ui-monospace,monospace">' + (21 + z * 0.5).toFixed(1) + '°</text>';
    /* centre console */
    s += '<path d="M262 258 H378 L392 364 H248 Z" fill="' + shade(P, -0.4) + '"/><path d="M270 262 H370 L380 330 H260 Z" fill="url(#' + ids.trim + ')"/>';
    var tt = get(b, 'transmission.type', 'dct');
    if (tt === 'manual') {
      s += '<circle cx="320" cy="290" r="9" fill="url(#' + ids.metal + ')" stroke="#000" stroke-opacity=".5"/><path d="M314 286 v8 M320 286 v8 M326 286 v8 M314 290 h12" stroke="#222" stroke-width=".9"/>';
      s += '<path d="M304 304 h32 l4 10 h-40 Z" fill="' + shade(P, -0.2) + '" stroke="' + S + '" stroke-dasharray="1.6 1.4"/>';
    } else if (tt === 'sequential') {
      s += '<rect x="316" y="276" width="8" height="34" rx="3" fill="url(#' + ids.metal + ')"/><rect x="311" y="270" width="18" height="12" rx="4" fill="#111"/>';
    } else {
      s += '<rect x="306" y="282" width="28" height="18" rx="6" fill="#0d0d0f" stroke="url(#' + ids.metal + ')"/><text x="320" y="294" text-anchor="middle" font-size="7" fill="' + A + '" font-family="ui-monospace,monospace">P R N D</text>';
    }
    /* steering wheel (left-hand drive) */
    var paddles = ['dct', 'sequential', 'auto', 'single-speed'].indexOf(tt) >= 0 && n.steering !== 'yoke';
    s += '<path d="M188 230 L200 268 H176 Z" fill="#111"/>';
    s += steeringSvg(n.steering, 200, 206, C, ids, paddles);
    /* seats */
    var seat = n.seatType || 'sport';
    s += seatSvg(166, seat, C, ids, !!n.harness);
    s += seatSvg(474, seat, C, ids, !!n.harness);
    /* roll cage (between camera and seats) */
    s += cageSvg(get(b, 'weight.rollCage', 'none'), ids);
    /* vignette */
    s += '<rect width="640" height="360" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="18"/>';
    return svgDoc('0 0 640 360', s, 'ps-cabin', opts.label || 'Interior preview');
  }

  /* ======================================================================
     SVG: TECH — cockpit display close-up, climate zones, speaker map
     ====================================================================== */
  function techSvg(b, opts) {
    opts = opts || {};
    var t = b.tech || {}, n = b.interior || {};
    var px = opts.idPrefix || 'pst';
    var A = hex(n.accentColor, '#b3121f'), amb = hex(n.ambientColor, '#ff3344');
    var ids = { scr: px + '-scr', dash: px + '-dash', glass: px + '-gl', glow: px + '-gw', nv: px + '-nv', trim: px + '-tr' };
    var d = '<defs>' + grad(ids.scr, [[0, '#0f2236'], [1, '#04070b']]) + grad(ids.dash, [[0, shade(hex(n.primaryColor, '#1a1a1a'), 0.05)], [1, '#050506']]) +
      grad(ids.glass, [[0, '#6e8aa0', 0.55], [1, '#2a3540', 0.25]]) + grad(ids.nv, [[0, '#1b1b1b'], [1, '#3a3a3a']]) + trimPattern(ids.trim, n.trim) +
      '<filter id="' + ids.glow + '" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>';
    var s = d;
    var li = idxOf('adasLevels', t.adas);
    s += '<rect width="640" height="230" fill="#060607"/>';
    s += '<path d="M0 0 H640 V92 Q320 70 0 92 Z" fill="url(#' + ids.glass + ')"/>';
    /* HUD */
    if (t.hud) {
      s += '<g filter="url(#' + ids.glow + ')" opacity=".55"><text x="190" y="54" text-anchor="middle" font-size="26" font-weight="700" fill="#7dffb0" font-family="ui-monospace,monospace">128</text></g>';
      s += '<g font-family="ui-monospace,monospace" fill="#7dffb0"><text x="190" y="54" text-anchor="middle" font-size="26" font-weight="700">128</text><text x="190" y="66" text-anchor="middle" font-size="8">KM/H · LIMIT 130</text>' +
        '<path d="M244 52 l10 -14 l10 14 h-6 v10 h-8 v-10 Z" opacity=".9"/><text x="254" y="74" text-anchor="middle" font-size="7">400 m</text>' +
        (li >= 1 ? '<path d="M128 70 l8 -24 M152 70 l-8 -24" stroke="#7dffb0" stroke-width="2" fill="none"/>' : '') + '</g>';
    }
    /* dash */
    s += '<path d="M0 100 Q320 80 640 100 V230 H0 Z" fill="url(#' + ids.dash + ')"/>';
    s += '<rect x="0" y="196" width="640" height="14" fill="url(#' + ids.trim + ')"/>';
    if (n.ambientLighting) s += '<path d="M0 212 H640" stroke="' + amb + '" stroke-width="3" filter="url(#' + ids.glow + ')"/>';
    /* cluster */
    var cx = 190;
    s += '<rect x="' + (cx - 120) + '" y="104" width="240" height="78" rx="12" fill="#030304" stroke="#1e1f22"/>';
    if (t.digitalCluster) {
      s += '<rect x="' + (cx - 114) + '" y="110" width="228" height="66" rx="9" fill="url(#' + ids.scr + ')"/>';
      /* tach arc */
      var red = num(get(b, 'engine.redline_rpm'), 7500), ev = get(b, 'engine.type') === 'ev';
      s += '<path d="M' + (cx - 96) + ' 168 A62 62 0 0 1 ' + (cx - 10) + ' 116" stroke="#1d2b3a" stroke-width="7" fill="none"/>';
      s += '<path d="M' + (cx - 96) + ' 168 A62 62 0 0 1 ' + (cx - 40) + ' 120" stroke="' + A + '" stroke-width="7" fill="none" stroke-linecap="round"/>';
      s += '<text x="' + (cx - 46) + '" y="160" font-size="9" fill="#9fb3c8" font-family="ui-monospace,monospace">' + (ev ? 'kW ' : 'RPM ') + (ev ? '210' : fmt(Math.round(red * 0.55 / 100) * 100)) + '</text>';
      s += '<text x="' + (cx + 44) + '" y="152" text-anchor="middle" font-size="28" font-weight="700" fill="#eef5ff" font-family="ui-monospace,monospace">128</text>';
      s += '<text x="' + (cx + 44) + '" y="164" text-anchor="middle" font-size="7" fill="#9fb3c8" font-family="ui-monospace,monospace">KM/H · ' + (ev ? 'D' : '4') + '</text>';
      /* ADAS tell-tales */
      var tell = [];
      if (li >= 1) tell.push('<path d="M0 10 l4 -10 M12 10 l-4 -10" stroke="#3fb950" stroke-width="1.6"/>');
      if (li >= 1) tell.push('<path d="M0 6 h12 M3 2 l-3 4 l3 4" stroke="#3fb950" stroke-width="1.4" fill="none"/>');
      if (li >= 3) tell.push('<circle cx="6" cy="5" r="5" fill="none" stroke="#3aa0ff" stroke-width="1.4"/><path d="M3 5 h6" stroke="#3aa0ff" stroke-width="1.4"/>');
      if (li >= 4) tell.push('<rect x="0" y="0" width="14" height="10" rx="2" fill="none" stroke="#c39bff" stroke-width="1.4"/><text x="7" y="8" text-anchor="middle" font-size="6" fill="#c39bff">L3</text>');
      tell.forEach(function (g, i) { s += '<g transform="translate(' + (cx + 70 + (i % 2) * 18) + ' ' + (116 + Math.floor(i / 2) * 14) + ')">' + g + '</g>'; });
      if (t.nightVision) {
        s += '<rect x="' + (cx - 30) + '" y="116" width="44" height="30" rx="3" fill="url(#' + ids.nv + ')" stroke="#555"/>';
        s += '<circle cx="' + (cx - 8) + '" cy="124" r="3" fill="#ffe0a0"/><path d="M' + (cx - 8) + ' 127 v9 M' + (cx - 12) + ' 131 h8 M' + (cx - 8) + ' 136 l-3 7 M' + (cx - 8) + ' 136 l3 7" stroke="#ffe0a0" stroke-width="2.2"/>';
        s += '<rect x="' + (cx - 30) + '" y="116" width="44" height="30" rx="3" fill="none" stroke="#f6c200" stroke-width="1.2"/>';
      }
    } else {
      [cx - 56, cx + 56].forEach(function (gx, gi) {
        s += '<circle cx="' + gx + '" cy="143" r="34" fill="#0b0b0c" stroke="#9aa0a6" stroke-width="2"/>';
        for (var k = 0; k <= 10; k++) {
          var an = (-225 + k * 27) * Math.PI / 180;
          s += '<path d="M' + f1(gx + 26 * Math.cos(an)) + ' ' + f1(143 + 26 * Math.sin(an)) + ' L' + f1(gx + 31 * Math.cos(an)) + ' ' + f1(143 + 31 * Math.sin(an)) + '" stroke="' + (gi === 0 && k >= 8 ? '#e5484d' : '#ddd') + '" stroke-width="1.2"/>';
        }
        var na = (gi ? -70 : -140) * Math.PI / 180;
        s += '<path d="M' + gx + ' 143 L' + f1(gx + 26 * Math.cos(na)) + ' ' + f1(143 + 26 * Math.sin(na)) + '" stroke="' + A + '" stroke-width="2"/><circle cx="' + gx + '" cy="143" r="3.5" fill="#333"/>';
        s += '<text x="' + gx + '" y="168" text-anchor="middle" font-size="6.5" fill="#999" font-family="ui-monospace,monospace">' + (gi ? 'KM/H' : 'x1000 RPM') + '</text>';
      });
    }
    /* centre display */
    var scr = num(t.screen_in, 12), spec = SCREEN_SPECS[scr] || SCREEN_SPECS[12];
    if (scr > 0) {
      var w, h, x0, y0;
      if (spec.layout === 'hyper') { w = 300; h = 64; x0 = 324; y0 = 110; }
      else if (spec.layout === 'portrait') { w = 90; h = 98; x0 = 405; y0 = 94; }
      else { w = scr * 14; h = Math.round(w * 0.5); x0 = 450 - w / 2; y0 = 140 - h / 2; }
      s += '<rect x="' + f1(x0 - 4) + '" y="' + f1(y0 - 4) + '" width="' + f1(w + 8) + '" height="' + f1(h + 8) + '" rx="9" fill="#020203"/>';
      s += '<rect x="' + f1(x0) + '" y="' + f1(y0) + '" width="' + f1(w) + '" height="' + f1(h) + '" rx="6" fill="url(#' + ids.scr + ')"/>';
      /* map tiles */
      for (var gx2 = x0 + 10; gx2 < x0 + w - 6; gx2 += 18) s += '<path d="M' + f1(gx2) + ' ' + f1(y0 + 4) + ' V' + f1(y0 + h - 4) + '" stroke="#16304a" stroke-width=".8"/>';
      for (var gy2 = y0 + 10; gy2 < y0 + h - 6; gy2 += 14) s += '<path d="M' + f1(x0 + 4) + ' ' + f1(gy2) + ' H' + f1(x0 + w - 4) + '" stroke="#16304a" stroke-width=".8"/>';
      s += '<path d="M' + f1(x0 + 12) + ' ' + f1(y0 + h - 12) + ' Q' + f1(x0 + w * 0.45) + ' ' + f1(y0 + h * 0.2) + ' ' + f1(x0 + w - 14) + ' ' + f1(y0 + 14) + '" stroke="#3aa0ff" stroke-width="3" fill="none" stroke-linecap="round"/>';
      s += '<circle cx="' + f1(x0 + 12) + '" cy="' + f1(y0 + h - 12) + '" r="4" fill="#fff"/>';
      /* footer: audio + climate */
      var aud = find('audioSystems', t.audio), aS = AUDIO_SPECS[t.audio] || {};
      s += '<rect x="' + f1(x0) + '" y="' + f1(y0 + h - 14) + '" width="' + f1(w) + '" height="14" fill="#000" opacity=".55"/>';
      s += '<text x="' + f1(x0 + 6) + '" y="' + f1(y0 + h - 4) + '" font-size="7" fill="#cfe3f7" font-family="ui-monospace,monospace">' + esc(aud ? (aS.speakers ? '♪ ' + aud.name + ' · ' + aS.speakers + ' spk' : aud.name) : '') + '</text>';
      if (t.telemetry) {
        s += '<rect x="' + f1(x0 + w - 66) + '" y="' + f1(y0 + 6) + '" width="60" height="30" rx="4" fill="#000" opacity=".72" stroke="' + A + '"/>';
        s += '<text x="' + f1(x0 + w - 36) + '" y="' + f1(y0 + 18) + '" text-anchor="middle" font-size="7" fill="' + A + '" font-family="ui-monospace,monospace">LAP Δ -0.42</text>';
        s += '<text x="' + f1(x0 + w - 36) + '" y="' + f1(y0 + 30) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="ui-monospace,monospace">1:58.31</text>';
      }
    } else {
      s += '<rect x="400" y="120" width="110" height="40" rx="6" fill="#0d0d0e" stroke="#2a2a2c"/>';
      for (var bi = 0; bi < 8; bi++) s += '<rect x="' + (406 + bi * 13) + '" y="130" width="9" height="9" rx="2" fill="#9aa0a6"/>';
      s += '<text x="455" y="153" text-anchor="middle" font-size="7" fill="#777" font-family="ui-monospace,monospace">ANALOGUE · NO SCREEN</text>';
    }
    /* switch bank: lift / telemetry / NV / ADAS */
    var keys = [['LIFT', t.liftSystem], ['TEL', t.telemetry], ['NV', t.nightVision], ['HUD', t.hud], ['ADAS', li > 0]];
    keys.forEach(function (k, i) {
      var kx = 344 + i * 46;
      s += '<rect x="' + kx + '" y="214" width="40" height="13" rx="3" fill="#121214" stroke="' + (k[1] ? A : '#2a2a2c') + '"/>';
      s += '<text x="' + (kx + 20) + '" y="223.5" text-anchor="middle" font-size="6.5" fill="' + (k[1] ? '#fff' : '#666') + '" font-family="ui-monospace,monospace">' + k[0] + '</text>';
      if (k[1]) s += '<circle cx="' + (kx + 5) + '" cy="220.5" r="1.6" fill="' + A + '"/>';
    });
    return svgDoc('0 0 640 230', s, 'ps-dash', opts.label || 'Display preview');
  }

  /** Plan view of the cabin with climate zones tinted. */
  function climateSvg(b) {
    var zones = clamp(num(get(b, 'tech.climateZones'), 2), 1, 4);
    var seats = num(get(b, 'body.seats'), 4), rear = seats > 2;
    var cold = '#3aa0ff', warm = '#ff8a3a';
    var cols = zones === 1 ? [cold] : zones === 2 ? [cold, warm] : zones === 3 ? [cold, warm, '#4fd1c5'] : [cold, warm, '#4fd1c5', '#c39bff'];
    var s = '<path d="M30 20 Q100 4 170 20 L176 180 Q100 196 24 180 Z" fill="#141416" stroke="#2c2c30"/>';
    var rects;
    if (zones === 1) rects = [[30, 24, 140, 152, 0]];
    else if (zones === 2) rects = [[30, 24, 70, 152, 0], [100, 24, 70, 152, 1]];
    else if (zones === 3) rects = [[30, 24, 70, 80, 0], [100, 24, 70, 80, 1], [30, 104, 140, 72, 2]];
    else rects = [[30, 24, 70, 80, 0], [100, 24, 70, 80, 1], [30, 104, 70, 72, 2], [100, 104, 70, 72, 3]];
    rects.forEach(function (r) {
      s += '<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="8" fill="' + cols[r[4]] + '" fill-opacity=".18" stroke="' + cols[r[4]] + '" stroke-opacity=".7" stroke-dasharray="3 2"/>';
      s += '<text x="' + (r[0] + r[2] / 2) + '" y="' + (r[1] + 14) + '" text-anchor="middle" font-size="9" font-weight="700" fill="' + cols[r[4]] + '" font-family="ui-monospace,monospace">' + (19.5 + r[4] * 1.5).toFixed(1) + '°</text>';
    });
    function seat(x, y) { return '<rect x="' + (x - 15) + '" y="' + y + '" width="30" height="34" rx="7" fill="#2e3034" stroke="#45484d"/><rect x="' + (x - 11) + '" y="' + (y + 28) + '" width="22" height="8" rx="3" fill="#3a3d41"/>'; }
    s += seat(65, 52) + seat(135, 52);
    if (rear) { if (seats >= 5) s += seat(52, 126) + seat(100, 126) + seat(148, 126); else s += seat(65, 126) + seat(135, 126); }
    s += '<text x="100" y="196" text-anchor="middle" font-size="8" fill="currentColor" opacity=".6" font-family="ui-monospace,monospace">' + zones + '-ZONE · ' + seats + ' SEATS</text>';
    return svgDoc('0 0 200 200', s, 'ps-climate', zones + '-zone climate diagram');
  }

  /** Plan view speaker map for the audio system. */
  function audioSvg(b) {
    var a = AUDIO_SPECS[get(b, 'tech.audio')] || AUDIO_SPECS.standard;
    var s = '<path d="M30 20 Q100 4 170 20 L176 180 Q100 196 24 180 Z" fill="#141416" stroke="#2c2c30"/>';
    /* perimeter positions */
    var spots = [[100, 22], [44, 30], [156, 30], [30, 70], [170, 70], [28, 110], [172, 110], [32, 150], [168, 150], [60, 178], [140, 178], [100, 180],
      [70, 24], [130, 24], [36, 50], [164, 50], [30, 90], [170, 90], [30, 130], [170, 130], [80, 180], [120, 180], [46, 168], [154, 168], [100, 100]];
    for (var i = 0; i < Math.min(a.speakers, spots.length); i++) {
      var p = spots[i];
      s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (i < 3 ? 4 : 3.2) + '" fill="#c9a26a" stroke="#000" stroke-width=".6"/>';
      if (i < 9) s += '<path d="M' + (p[0] + (p[0] < 100 ? 6 : -6)) + ' ' + (p[1] - 4) + ' q' + (p[0] < 100 ? 4 : -4) + ' 4 0 8" stroke="#c9a26a" stroke-opacity=".5" fill="none"/>';
    }
    for (var k = 0; k < a.sub; k++) s += '<rect x="' + (82 + k * 22) + '" y="150" width="16" height="16" rx="3" fill="#1e1f22" stroke="#c9a26a"/><circle cx="' + (90 + k * 22) + '" cy="158" r="5" fill="none" stroke="#c9a26a"/>';
    for (var j = 0; j < a.transducers; j++) s += '<rect x="' + [55, 125, 55, 125][j] + '" y="' + [60, 60, 130, 130][j] + '" width="20" height="20" rx="5" fill="none" stroke="#3aa0ff" stroke-dasharray="2 2"/>';
    if (!a.speakers) s += '<text x="100" y="104" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6" font-family="ui-monospace,monospace">NO SPEAKERS</text>';
    s += '<text x="100" y="196" text-anchor="middle" font-size="8" fill="currentColor" opacity=".6" font-family="ui-monospace,monospace">' + a.speakers + ' SPK · ' + fmt(a.watts) + ' W</text>';
    return svgDoc('0 0 200 200', s, 'ps-audio', 'Speaker layout');
  }

  /* ======================================================================
     PURE API EXPORT
     ====================================================================== */
  CB.panelsStyle = {
    colorDist: colorDist, nearestSwatch: nearestSwatch, familyOf: familyOf, groupSwatches: groupSwatches, isHeritage: isHeritage,
    paintCode: paintCode, paintStops: paintStops, paintCss: paintCss, trimCss: trimCss, upholsteryCss: upholsteryCss,
    harmony: harmony, harmonyPatch: harmonyPatch, randomLivery: randomLivery, rng: rng, LIVERY_MODES: LIVERY_MODES,
    sectionCost: sectionCost, sectionWeight: sectionWeight, electricalLoad: electricalLoad, rangeImpact: rangeImpact,
    vlt: vlt, tintForVlt: tintForVlt, interiorScores: interiorScores, adasFeatures: adasFeatures,
    exteriorSvg: exteriorSvg, interiorSvg: interiorSvg, techSvg: techSvg, climateSvg: climateSvg, audioSvg: audioSvg,
    tables: {
      LIGHT_SPECS: LIGHT_SPECS, FINISH_CARE: FINISH_CARE, STEERING_SPECS: STEERING_SPECS, AUDIO_SPECS: AUDIO_SPECS,
      SCREEN_SPECS: SCREEN_SPECS, ADAS_FEATURES: ADAS_FEATURES, ADAS_SENSORS: ADAS_SENSORS, INTERIOR_THEMES: INTERIOR_THEMES,
      CALIPER_SWATCHES: CALIPER_SWATCHES, LEATHER_SWATCHES: LEATHER_SWATCHES, STITCH_SWATCHES: STITCH_SWATCHES,
      AMBIENT_SWATCHES: AMBIENT_SWATCHES, CONTRAST_SWATCHES: CONTRAST_SWATCHES
    }
  };

  /* ======================================================================
     ======================  DOM / PANELS BELOW  ==========================
     ====================================================================== */
  var ui = CB.ui;
  if (!hasDOM || !ui || typeof CB.registerPanel !== 'function') return;
  var el = U.el;

  /* ---------------------------------------------------------------- small DOM helpers */
  function cur() { return CB.state.get(); }
  function setState(path, v, label) { return CB.state.set(path, v, { label: label }); }
  function patchState(p, label) { return CB.state.patch(p, { label: label }); }
  function toast(msg, kind, o) { if (ui.toast) return ui.toast(msg, kind || 'info', o); }
  function hint(text) { return el('div', { class: 'cb-hint' }, text); }
  function note(text, kind) { return el('div', { class: 'ps-note is-' + (kind || 'info') }, text); }
  function btn(label, onClick, o) { o = o || {}; return ui.button(label, { kind: o.kind || 'ghost', title: o.title, icon: o.icon, onClick: onClick }); }
  function undoAction() { return { label: 'Undo', onClick: function () { if (CB.state.undo) CB.state.undo(); } }; }
  function gotoPanel(id) { if (CB.app && typeof CB.app.goto === 'function') CB.app.goto(id); else if (typeof location !== 'undefined') location.hash = 'p=' + id; }

  /** Optional career lock hook: CB.ui.lockReason(collection, id) -> false | string. */
  function lockReason(coll, id) {
    var f = ui.lockReason;
    if (typeof f !== 'function') return false;
    try { var r = f(coll, id); return r ? (typeof r === 'string' ? r : 'Locked — earn more career XP to unlock') : false; } catch (e) { return false; }
  }
  function lockFn(coll) { return function (o) { return lockReason(coll, o.id); }; }

  /** A bound container that re-renders only when keyFn(build) changes. */
  function live(node, keyFn, renderFn) {
    var last = null;
    return ui.bind(node, '*', function (b) {
      var k = keyFn(b);
      if (k === last) return;
      last = k;
      renderFn(b, node);
    });
  }
  function svgHost(cls, builder, keyFn, label) {
    var host = el('div', { class: 'ps-figure ' + (cls || ''), role: 'img', 'aria-label': label || '' });
    return live(host, keyFn, function (b) { host.innerHTML = builder(b); });
  }
  /** Decorate each card of a ui.cards control on relevant changes (live chips / icons). */
  function decorateCards(cardsEl, keyFn, fn) {
    var wrap = el('div', { class: 'ps-cards-wrap' }, cardsEl);
    live(wrap, keyFn, function (b) {
      var cards = cardsEl.querySelectorAll('.cb-card');
      for (var i = 0; i < cards.length; i++) if (cards[i]._option) fn(cards[i], cards[i]._option, b);
    });
    return wrap;
  }
  function meter() {
    var bar = el('i'), m = el('div', { class: 'ps-meter' }, bar);
    m.set = function (frac, color) { bar.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%'; if (color) bar.style.background = color; };
    return m;
  }
  function statGrid(defs) {
    var g = el('div', { class: 'ps-stats' });
    g.tiles = {};
    defs.forEach(function (d) {
      var t = ui.stat(d.label, null, d.unit || '', { decimals: d.decimals, kind: d.kind });
      if (d.title) t.title = d.title;
      g.tiles[d.key] = t; g.appendChild(t);
    });
    g.setAll = function (vals) {
      Object.keys(vals).forEach(function (k) {
        if (!g.tiles[k]) return;
        var v = vals[k];
        if (v && typeof v === 'object') g.tiles[k].set(v.value, v.unit, v.delta);
        else g.tiles[k].set(v == null || (typeof v === 'number' && !isFinite(v)) ? null : v);
      });
    };
    return g;
  }
  function swatchRow(swList, path, label, o) {
    o = o || {};
    var row = el('div', { class: 'ps-swatch-row', role: 'listbox', 'aria-label': label });
    var btns = swList.map(function (s) {
      var bt = el('button', { type: 'button', class: 'cb-swatch ps-swatch', role: 'option', title: s.name + ' ' + s.hex.toUpperCase(), 'aria-label': s.name, style: { background: o.css ? o.css(s.hex) : s.hex } });
      bt._hex = s.hex.toLowerCase();
      bt.addEventListener('click', function () { setState(path, s.hex.toLowerCase(), label + ': ' + s.name); });
      row.appendChild(bt);
      return bt;
    });
    ui.bind(row, path, function (b) {
      var v = String(get(b, path, '')).toLowerCase();
      btns.forEach(function (bt) { var on = bt._hex === v; bt.classList.toggle('is-selected', on); bt.setAttribute('aria-selected', on ? 'true' : 'false'); });
      if (o.css) { var f = get(b, 'exterior.finish'); btns.forEach(function (bt) { bt.style.background = o.css(bt._hex, f); }); }
    });
    return row;
  }
  function kvLive(rowsFn, keyFn) {
    var k = ui.kv([]);
    var host = el('div', { class: 'ps-kv-host' }, k);
    live(host, keyFn || function (b) { return JSON.stringify(rowsFn(b)); }, function (b) { k.set(rowsFn(b)); });
    return host;
  }
  function costRows(b, section) {
    var c = sectionCost(b, section);
    var rows = c.lines.map(function (l) { return [l[0], ui.priceText(l[1])]; });
    rows.push([el('strong', null, 'Section total' + (c.source === 'estimate' ? ' (est.)' : '')), el('strong', null, c.total ? money(c.total) : 'Included')]);
    return rows;
  }
  function costBlock(section) {
    var k = ui.kv([]);
    var host = el('div', { class: 'ps-kv-host' }, k);
    live(host, function (b) { return JSON.stringify(sectionCost(b, section)); }, function (b) { k.set(costRows(b, section)); });
    return host;
  }

  /* ---------------------------------------------------------------- scoped styles */
  function injectStyles() {
    if (document.getElementById('ps-styles')) return;
    var css = [
      '.ps-panel{display:flex;flex-direction:column;gap:18px}',
      '.ps-hero{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(220px,1fr);gap:14px;align-items:stretch}',
      '@media (max-width:980px){.ps-hero{grid-template-columns:1fr}}',
      '.ps-figure{position:relative;border:1px solid var(--line);border-radius:var(--radius);background:radial-gradient(120% 90% at 50% 0%,var(--panel-2),var(--bg-2));overflow:hidden;color:var(--text-dim)}',
      '.ps-figure svg{display:block;width:100%;height:auto}',
      '.ps-figure.ps-plate{padding:10px 8px 4px;display:flex;flex-direction:column;justify-content:center}',
      '.ps-figure.ps-cabin svg{border-radius:inherit}',
      '.ps-side{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel-2)}',
      '.ps-title{font-size:var(--fs-xs);letter-spacing:.09em;text-transform:uppercase;color:var(--text-dim)}',
      '.ps-big{font-size:var(--fs-xl);font-weight:650;color:var(--text);line-height:1.15}',
      '.ps-sub{font-family:var(--mono);font-size:var(--fs-xs);color:var(--text-dim)}',
      '.ps-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}',
      '.ps-stats .cb-stat{min-width:0}',
      '.ps-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.ps-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '.ps-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
      '@media (max-width:760px){.ps-two,.ps-three{grid-template-columns:1fr}}',
      '.ps-note{font-size:var(--fs-sm);line-height:1.45;padding:9px 12px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--panel-2);color:var(--text-dim)}',
      '.ps-note.is-warning{border-color:color-mix(in srgb,var(--warn) 55%,transparent);color:var(--text)}',
      '.ps-note.is-good{border-color:color-mix(in srgb,var(--good) 55%,transparent)}',
      '.ps-family{display:flex;flex-direction:column;gap:6px}',
      '.ps-family-label{font-size:var(--fs-2xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}',
      '.ps-families{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px 18px}',
      '.ps-swatch-row{display:flex;flex-wrap:wrap;gap:6px}',
      '.ps-swatch{width:30px;height:30px;border-radius:50%;border:2px solid transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),0 1px 3px rgba(0,0,0,.5);cursor:pointer;padding:0;transition:transform .15s,border-color .15s}',
      '.ps-swatch:hover{transform:scale(1.12)}',
      '.ps-swatch.is-selected{border-color:var(--accent);transform:scale(1.08)}',
      '.ps-chip{display:block;width:100%;height:46px;border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),inset 0 -10px 18px rgba(0,0,0,.25);transition:background .25s}',
      '.cb-card-icon .ps-chip{min-width:72px}',
      '.cb-card-icon svg.ps-mini{display:block;width:100%;height:auto;max-height:70px}',
      '.ps-harmony{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}',
      '.ps-hcard{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--panel-2)}',
      '.ps-hstrip{display:grid;grid-template-columns:2.2fr 1fr 1fr 1fr 1fr;height:34px;border-radius:var(--radius-xs);overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}',
      '.ps-hstrip>span{display:block}',
      '.ps-hname{font-weight:600;color:var(--text);font-size:var(--fs-sm)}',
      '.ps-hdesc{font-size:var(--fs-xs);color:var(--text-dim);line-height:1.35}',
      '.ps-hbtns{display:flex;flex-wrap:wrap;gap:5px}',
      '.ps-hbtns .cb-btn{font-size:var(--fs-xs);padding:3px 8px;min-height:0}',
      '.ps-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:var(--pill);font-size:var(--fs-xs);border:1px solid var(--line);color:var(--text-dim);background:transparent;cursor:pointer}',
      '.ps-pill.is-on{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 14%,transparent)}',
      '.ps-pill i{display:inline-block;width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.2)}',
      '.ps-dots{display:inline-flex;gap:2px}',
      '.ps-meter{position:relative;height:7px;border-radius:var(--radius-xs);background:var(--panel);overflow:hidden}',
      '.ps-meter>i{position:absolute;left:0;top:0;bottom:0;border-radius:var(--radius-xs);background:var(--accent);transition:width .3s ease}',
      '.ps-meter-row{display:grid;grid-template-columns:90px minmax(0,1fr) 40px;gap:8px;align-items:center;font-size:var(--fs-sm);color:var(--text-dim);font-variant-numeric:tabular-nums}',
      '.ps-meter-row b{color:var(--text);font-weight:600;text-align:right}',
      '.ps-tint{position:relative;height:64px;border-radius:var(--radius-sm);overflow:hidden;background:linear-gradient(180deg,#8fb3cf 0%,#d7e3ea 55%,#4e5f48 56%,#3c4a37 100%)}',
      '.ps-tint::before{content:"";position:absolute;left:12%;bottom:44%;width:16%;height:30%;background:#2d3a2c;border-radius:50% 50% 0 0}',
      '.ps-tint>i{position:absolute;inset:0;background:#05070a;transition:opacity .2s}',
      '.ps-tint>b{position:absolute;right:10px;bottom:8px;font:600 var(--fs-sm) var(--mono);color:#fff;text-shadow:0 1px 2px #000}',
      '.ps-roundel{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:#f4f3ef;color:#111;font:900 var(--fs-2xl)/1 system-ui,sans-serif;border:5px solid #111;box-shadow:0 2px 8px rgba(0,0,0,.5)}',
      '.ps-roundel.is-empty{opacity:.35;font-size:var(--fs-sm);font-weight:600}',
      '.ps-feat{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:var(--fs-xs);color:var(--text-dim)}',
      '.ps-feat li::before{content:"✓ ";color:var(--good)}',
      '.ps-feat li.is-new{color:var(--text)}',
      '.ps-feat li.is-new::before{content:"+ ";color:var(--accent);font-weight:700}',
      '.ps-matrix-wrap{overflow-x:auto}',
      '.ps-matrix{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}',
      '.ps-matrix th{font-weight:600;font-size:var(--fs-2xs);letter-spacing:.05em;text-transform:uppercase;color:var(--text-dim);padding:6px;border-bottom:1px solid var(--line);text-align:center}',
      '.ps-matrix th:first-child,.ps-matrix td:first-child{text-align:left}',
      '.ps-matrix td{padding:5px 6px;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);text-align:center;color:var(--text-dim)}',
      '.ps-matrix .is-cur{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--text)}',
      '.ps-matrix .yes{color:var(--good);font-weight:700}',
      '.ps-diagrams{display:grid;grid-template-columns:200px minmax(0,1fr);gap:14px;align-items:start}',
      '@media (max-width:640px){.ps-diagrams{grid-template-columns:1fr}}',
      '.ps-figure.ps-small{max-width:220px;padding:6px}',
      '.ps-theme-dots i{width:9px;height:9px}',
      '.ps-caliper{max-width:170px}',
      '.ps-score{display:flex;flex-direction:column;gap:6px}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'ps-styles';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------------------------------------------------------------- metrics */
  var physCache = { build: null, m: null };
  function metricsFor(build, metrics) {
    if (metrics && typeof metrics === 'object') return metrics;
    if (physCache.build === build) return physCache.m;
    var m = null;
    if (CB.physics && typeof CB.physics.compute === 'function') { try { m = CB.physics.compute(build); } catch (e) { m = null; } }
    physCache = { build: build, m: m };
    return m;
  }

  /* ---------------------------------------------------------------- panel factory */
  function makePanel(def) {
    var P = { root: null, build: null, metrics: null, watchers: [] };
    P.watch = function (node, fn) { P.watchers.push({ node: node, fn: fn }); try { fn(P.build || cur(), P.metrics); } catch (e) { console.error('[panels-style] watcher', e); } return node; };
    P.refresh = function (change) {
      if (!P.root) return;
      P.watchers = P.watchers.filter(function (w) { return P.root.contains(w.node); });
      P.watchers.forEach(function (w) { try { w.fn(P.build, P.metrics, change); } catch (e) { console.error('[panels-style] watcher', e); } });
    };
    CB.registerPanel({
      id: def.id, title: def.title, subtitle: def.subtitle, icon: (ui.icons && ui.icons[def.id]) || undefined,
      group: 'Design', order: def.order,
      render: function (container, build, metrics) {
        injectStyles();
        if (P.root && P.root.parentNode === container) container.removeChild(P.root);
        P.watchers = [];
        P.build = build || cur();
        P.metrics = metricsFor(P.build, metrics);
        var root = el('div', { class: 'ps-panel ps-panel-' + def.id, dataset: { panel: def.id } });
        P.root = root;
        try { def.build(root, P); }
        catch (e) {
          console.error('[panels-style] render failed for ' + def.id, e);
          root.appendChild(note('This panel failed to render: ' + (e && e.message), 'warning'));
        }
        container.appendChild(root);
        ui.syncAll(root, P.build);
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
     MINI ICONS (live, per option)
     ====================================================================== */
  function stripeIcon(id, paint, sc) {
    var s = '<rect x="6" y="2" width="38" height="96" rx="15" fill="' + paint + '" stroke="rgba(0,0,0,.4)"/>';
    s += '<rect x="11" y="38" width="28" height="30" rx="6" fill="' + shade(paint, -0.3) + '"/><path d="M10 30 Q25 25 40 30 L38 38 Q25 35 12 38 Z" fill="#1d2a35"/>';
    var c = '<clipPath id="psst-' + id + '"><rect x="6" y="2" width="38" height="96" rx="15"/></clipPath><g clip-path="url(#psst-' + id + ')">';
    switch (id) {
      case 'racing-dual': c += '<rect x="16" y="0" width="6" height="100" fill="' + sc + '"/><rect x="28" y="0" width="6" height="100" fill="' + sc + '"/>'; break;
      case 'center': c += '<rect x="19" y="0" width="12" height="100" fill="' + sc + '"/>'; break;
      case 'le-mans': c += '<rect x="28" y="0" width="8" height="100" fill="' + sc + '"/><circle cx="25" cy="53" r="7" fill="#f4f3ef" stroke="#111"/>'; break;
      case 'hood': c += '<rect x="11" y="6" width="28" height="20" rx="5" fill="' + sc + '"/>'; break;
      case 'pinstripe': c += '<path d="M9 14 V86 M41 14 V86" stroke="' + sc + '" stroke-width="1.2"/>'; break;
      case 'side-skirt': c += '<rect x="6" y="28" width="3" height="46" fill="' + sc + '"/><rect x="41" y="28" width="3" height="46" fill="' + sc + '"/>'; break;
      case 'gradient': c += '<linearGradient id="psstg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + sc + '"/><stop offset="1" stop-color="' + sc + '" stop-opacity="0"/></linearGradient><rect x="0" y="0" width="50" height="100" fill="url(#psstg)"/>'; break;
    }
    c += '</g>';
    return '<svg viewBox="0 0 50 100" class="ps-mini" aria-hidden="true" style="max-height:62px">' + s + c + '</svg>';
  }
  function lightIcon(id) {
    var L = LIGHT_SPECS[id] || LIGHT_SPECS.led, s = '<rect x="2" y="8" width="76" height="26" rx="12" fill="#0d0e10" stroke="#2c2e33"/>';
    if (id === 'halogen') s += '<circle cx="24" cy="21" r="8" fill="' + L.glow + '"/><circle cx="52" cy="21" r="6" fill="' + L.glow + '" opacity=".7"/>';
    else if (id === 'led') s += '<path d="M10 28 Q40 10 70 16" stroke="' + L.glow + '" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="30" cy="22" r="4" fill="' + L.glow + '"/><circle cx="46" cy="20" r="4" fill="' + L.glow + '"/>';
    else {
      for (var i = 0; i < 12; i++) s += '<rect x="' + (12 + i * 4.6) + '" y="' + (18 - Math.sin(i / 3) * 2) + '" width="3" height="6" rx="1" fill="' + L.glow + '" opacity="' + (i % 4 === 1 ? 0.35 : 1) + '"/>';
      s += '<path d="M10 30 Q40 14 70 18" stroke="' + L.glow + '" stroke-width="1.6" fill="none"/>';
      if (id === 'laser') s += '<circle cx="66" cy="22" r="4" fill="#3aa0ff"/><circle cx="66" cy="22" r="7" fill="none" stroke="#3aa0ff" stroke-opacity=".5"/>';
    }
    return '<svg viewBox="0 0 80 42" class="ps-mini" aria-hidden="true">' + s + '</svg>';
  }
  function roofCss(id, b) {
    var x = b.exterior || {};
    switch (id) {
      case 'black': return 'linear-gradient(165deg,#3a3a3e,#0d0d0f 45%,#000)';
      case 'carbon': return trimCss('carbon');
      case 'glass': return 'radial-gradient(120% 60% at 30% 10%,rgba(255,255,255,.35),transparent 45%),linear-gradient(180deg,#6f8ea6,#1d2a35 50%,#05080b)';
      case 'contrast': return paintCss(x.roofColor || '#111111', 'solid');
      default: return paintCss(x.paint, x.finish);
    }
  }
  function caliperSvg(b) {
    var cal = hex(get(b, 'exterior.caliperColor'), '#f2c200');
    var mat = get(b, 'brakes.material', 'iron'), pistons = num(get(b, 'brakes.frontPistons'), 6), rotor = num(get(b, 'brakes.frontRotor_mm'), 360);
    var rotorCol = mat === 'carbon-ceramic' ? '#5d5650' : '#8d9095';
    var r = 46 + (rotor - 280) / 160 * 18;
    var s = '<circle cx="80" cy="80" r="' + f1(r) + '" fill="' + rotorCol + '" stroke="#5a5d61"/>';
    if (mat === 'carbon-ceramic') for (var k = 0; k < 40; k++) { var a = k * 2.4, rr = 20 + (k * 7) % (r - 22); s += '<circle cx="' + f1(80 + rr * Math.cos(a)) + '" cy="' + f1(80 + rr * Math.sin(a)) + '" r=".9" fill="#7a726a"/>'; }
    if (mat === 'drilled-slotted' || mat === 'two-piece') {
      for (var i = 0; i < 24; i++) { var an = i * Math.PI / 12; s += '<circle cx="' + f1(80 + (r - 12) * Math.cos(an)) + '" cy="' + f1(80 + (r - 12) * Math.sin(an)) + '" r="1.8" fill="#3a3c40"/>'; }
      for (var j = 0; j < 6; j++) { var a2 = j * Math.PI / 3 + 0.3; s += '<path d="M' + f1(80 + (r - 26) * Math.cos(a2)) + ' ' + f1(80 + (r - 26) * Math.sin(a2)) + ' L' + f1(80 + (r - 5) * Math.cos(a2 + 0.25)) + ' ' + f1(80 + (r - 5) * Math.sin(a2 + 0.25)) + '" stroke="#5a5d61" stroke-width="1.6"/>'; }
    }
    s += '<circle cx="80" cy="80" r="22" fill="' + (mat === 'two-piece' || mat === 'carbon-ceramic' ? '#b4b8bd' : '#6c7075') + '" stroke="#444"/>';
    for (var h = 0; h < 5; h++) { var a3 = h * 2 * Math.PI / 5; s += '<circle cx="' + f1(80 + 12 * Math.cos(a3)) + '" cy="' + f1(80 + 12 * Math.sin(a3)) + '" r="2.4" fill="#333"/>'; }
    var ca = 'M' + f1(80 + (r + 8) * Math.cos(-1.05)) + ' ' + f1(80 + (r + 8) * Math.sin(-1.05)) + ' A' + f1(r + 8) + ' ' + f1(r + 8) + ' 0 0 1 ' + f1(80 + (r + 8) * Math.cos(1.05)) + ' ' + f1(80 + (r + 8) * Math.sin(1.05)) +
      ' L' + f1(80 + (r - 16) * Math.cos(0.95)) + ' ' + f1(80 + (r - 16) * Math.sin(0.95)) + ' A' + f1(r - 16) + ' ' + f1(r - 16) + ' 0 0 0 ' + f1(80 + (r - 16) * Math.cos(-0.95)) + ' ' + f1(80 + (r - 16) * Math.sin(-0.95)) + ' Z';
    s += '<path d="' + ca + '" fill="' + cal + '" stroke="' + shade(cal, -0.45) + '" stroke-width="1.2"/>';
    s += '<path d="' + ca + '" fill="url(#psc-sh)"/>';
    s += '<text x="' + f1(80 + (r - 4)) + '" y="84" text-anchor="middle" font-size="8" font-weight="900" fill="' + U.contrastText(cal) + '" font-family="system-ui,sans-serif" transform="rotate(90 ' + f1(80 + (r - 4)) + ' 80)">REDLINE</text>';
    s += '<text x="80" y="156" text-anchor="middle" font-size="9" fill="currentColor" opacity=".7" font-family="ui-monospace,monospace">' + pistons + '-POT · ' + rotor + ' MM</text>';
    var defs = '<defs><linearGradient id="psc-sh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient></defs>';
    return svgDoc('0 0 160 162', defs + s, 'ps-caliper-svg', 'Caliper preview');
  }

  /* ======================================================================
     PANEL: EXTERIOR
     ====================================================================== */
  function finishCard(o) {
    var care = FINISH_CARE[o.id] || {};
    return {
      id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span class="ps-chip" aria-hidden="true"></span>',
      badge: o.id === 'chrome' ? 'Show' : o.id === 'chameleon' ? 'Flip' : o.flake ? 'Flake' : null,
      specs: [['Gloss', Math.round(num(o.gloss, 0) * 100) + '%'], ['Metallic', Math.round(num(o.metallic, 0) * 100) + '%'], ['Care', care.care || '—']]
    };
  }

  function buildExterior(root, P) {
    root.appendChild(ui.issues('exterior'));

    /* ---- hero: livery plate + identity + randomiser */
    var plate = svgHost('ps-plate', function (b) { return exteriorSvg(b); }, function (b) { return JSON.stringify([b.exterior, get(b, 'wheels.finish')]); }, 'Live livery preview, profile and plan view');
    var nameEl = el('div', { class: 'ps-big' }), codeEl = el('div', { class: 'ps-sub' }), famEl = el('div', { class: 'ps-sub' });
    var chipBig = el('span', { class: 'ps-chip', style: { height: '54px' } });
    var ident = live(el('div', { class: 'ps-score' }, el('div', { class: 'ps-title' }, 'Paint'), chipBig, nameEl, codeEl, famEl), function (b) { return get(b, 'exterior.paint') + get(b, 'exterior.finish'); }, function (b) {
      var p = get(b, 'exterior.paint'), f = get(b, 'exterior.finish');
      var heritage = D.swatchName ? D.swatchName(p) : null;
      var near = nearestSwatch(p);
      nameEl.textContent = heritage || ('Bespoke ' + p.toUpperCase());
      codeEl.textContent = paintCode(p, f) + ' · ' + ((find('paintFinishes', f) || {}).name || f);
      famEl.textContent = heritage ? 'Heritage palette · ' + (FAMILY_LABELS[(near && near.family) || familyOf(p)] || '') : 'Closest heritage: ' + (near ? near.name : '—');
      chipBig.style.background = paintCss(p, f);
    });
    var modeSel = 'tasteful', keepPaint = false;
    var modeBtns = LIVERY_MODES.map(function (m) {
      var b_ = el('button', { type: 'button', class: 'ps-pill' + (m.id === modeSel ? ' is-on' : ''), title: m.desc }, m.name);
      b_.addEventListener('click', function () { modeSel = m.id; modeBtns.forEach(function (x) { x.classList.toggle('is-on', x === b_); }); });
      return b_;
    });
    var keepBtn = el('button', { type: 'button', class: 'ps-pill', title: 'Keep the current paint & finish; randomise only stripes, roof, calipers and details' }, 'Keep paint');
    keepBtn.addEventListener('click', function () { keepPaint = !keepPaint; keepBtn.classList.toggle('is-on', keepPaint); });
    var rollCount = 0;
    var randBtn = ui.button('Randomize livery', { kind: 'primary', icon: ui.icons.spark, onClick: function () {
      var seed = (Date.now() ^ (++rollCount * 0x9e3779b1)) >>> 0;
      var patch = randomLivery(modeSel, rng(seed), cur());
      if (keepPaint) {
        delete patch.exterior.paint; delete patch.exterior.finish;
        var sc = harmony(get(cur(), 'exterior.paint'))[Math.floor(rng(seed + 1)() * 6)];
        patch.exterior.stripeColor = sc.stripe; patch.exterior.caliperColor = sc.caliper; patch.exterior.roofColor = sc.roof;
      }
      patchState(patch, 'Randomize livery (' + modeSel + ')');
      var nm = D.swatchName && D.swatchName(get(cur(), 'exterior.paint'));
      toast('New ' + modeSel + ' livery' + (nm ? ' in ' + nm : ''), 'success', { action: undoAction() });
    } });
    var side = el('div', { class: 'ps-side' }, ident,
      el('div', { class: 'ps-title' }, 'Livery generator'), el('div', { class: 'ps-row' }, modeBtns, keepBtn), el('div', { class: 'ps-row' }, randBtn,
        btn('Reset exterior', function () { var d = D.defaultBuild().exterior; patchState({ exterior: d }, 'Reset exterior'); toast('Exterior reset to factory', 'info', { action: undoAction() }); })));
    root.appendChild(el('div', { class: 'ps-hero' }, plate, side));

    /* ---- stats */
    var stats = statGrid([
      { key: 'cost', label: 'Options', decimals: 0 }, { key: 'paint', label: 'Paint', decimals: 0 },
      { key: 'weight', label: 'Weight Δ', unit: 'kg', decimals: 1 }, { key: 'vlt', label: 'Glass VLT', unit: '%', decimals: 0 },
      { key: 'care', label: 'Care' }, { key: 'reach', label: 'Beam', unit: 'm', decimals: 0 }
    ]);
    live(stats, function (b) { return JSON.stringify([b.exterior, CB.pricing ? b : 0]); }, function (b) {
      var x = b.exterior, c = sectionCost(b, 'exterior');
      var paintCost = priceOf('paintFinishes', x.finish) + (isHeritage(x.paint) ? 0 : opt('customPaint', 2500));
      stats.setAll({
        cost: c.total ? money(c.total) : 'Included', paint: paintCost ? money(paintCost) : 'Included',
        weight: { value: sectionWeight(b, 'exterior'), unit: 'kg' }, vlt: { value: vlt(x.windowTint_pct), unit: '%' },
        care: (FINISH_CARE[x.finish] || {}).care || '—', reach: { value: (LIGHT_SPECS[x.lights] || {}).reach_m, unit: 'm' }
      });
    });
    root.appendChild(stats);

    /* ---- paint colour */
    var fams = el('div', { class: 'ps-families' });
    groupSwatches().forEach(function (g) {
      fams.appendChild(el('div', { class: 'ps-family' }, el('div', { class: 'ps-family-label' }, g.label + ' · ' + g.swatches.length),
        swatchRow(g.swatches, 'exterior.paint', 'Paint', { css: function (h, f) { return paintCss(h, f || get(cur(), 'exterior.finish')); } })));
    });
    var custom = ui.color({ path: 'exterior.paint', label: 'Bespoke colour', swatches: [], hint: 'Any colour you can imagine, mixed to order (+' + money(opt('customPaint', 2500)) + ' unless it matches a heritage colour).' });
    var snapNote = live(el('div', { class: 'ps-row' }), function (b) { return get(b, 'exterior.paint'); }, function (b, node) {
      U.clear(node);
      var p = get(b, 'exterior.paint');
      if (isHeritage(p)) { node.appendChild(note('Heritage colour — no bespoke paint surcharge.', 'good')); return; }
      var n = nearestSwatch(p);
      if (!n) return;
      node.appendChild(el('span', { class: 'cb-hint' }, 'Closest heritage colour: '));
      node.appendChild(el('span', { class: 'ps-pill' }, el('i', { style: { background: n.hex } }), n.name));
      node.appendChild(btn('Snap to ' + n.name + ' (save ' + money(opt('customPaint', 2500)) + ')', function () { setState('exterior.paint', n.hex, 'Paint: ' + n.name); }));
    });
    root.appendChild(ui.section('Paint colour', swatches().length + ' heritage colours from motorsport history — or commission your own.', fams, ui.grid(2, custom, snapNote)));

    /* ---- harmony suggestions */
    var harmonyHost = live(el('div', { class: 'ps-harmony' }), function (b) { return get(b, 'exterior.paint'); }, function (b, node) {
      U.clear(node);
      harmony(get(b, 'exterior.paint')).forEach(function (sc) {
        var strip = el('div', { class: 'ps-hstrip', title: 'Paint · stripe · calipers · roof · cabin accent' },
          el('span', { style: { background: paintCss(sc.paint, get(b, 'exterior.finish')) } }), el('span', { style: { background: sc.stripe } }),
          el('span', { style: { background: sc.caliper } }), el('span', { style: { background: sc.roof } }), el('span', { style: { background: sc.accent } }));
        var nm = Object.keys(sc.names).map(function (k) { return k + ': ' + sc.names[k]; }).join(' · ');
        node.appendChild(el('div', { class: 'ps-hcard' }, strip,
          el('div', { class: 'ps-hname' }, sc.name), el('div', { class: 'ps-hdesc' }, sc.desc), nm ? el('div', { class: 'ps-sub' }, nm) : null,
          el('div', { class: 'ps-hbtns' },
            btn('Stripe', function () { patchState(harmonyPatch(sc, 'stripe', cur()), sc.name + ' stripe colour'); }),
            btn('Calipers', function () { patchState(harmonyPatch(sc, 'caliper', cur()), sc.name + ' calipers'); }),
            btn('Roof', function () { patchState(harmonyPatch(sc, 'roof', cur()), sc.name + ' contrast roof'); }),
            btn('Cabin', function () { patchState(harmonyPatch(sc, 'interior', cur()), sc.name + ' cabin accents'); }),
            ui.button('Apply all', { kind: 'primary', onClick: function () { patchState(harmonyPatch(sc, 'all', cur()), 'Colour scheme: ' + sc.name); toast(sc.name + ' scheme applied', 'success', { action: undoAction() }); } }))));
      });
    });
    root.appendChild(ui.section('Colour harmony', 'Suggested secondary colours computed from your paint, snapped to heritage names where close.', harmonyHost));

    /* ---- finish */
    var finishCards = decorateCards(ui.cards({ path: 'exterior.finish', label: 'Finish', columns: 4, options: list('paintFinishes').map(finishCard), optionDisabled: lockFn('paintFinishes') }),
      function (b) { return get(b, 'exterior.paint'); },
      function (card, o, b) { var c = card.querySelector('.ps-chip'); if (c) c.style.background = paintCss(get(b, 'exterior.paint'), o.id); });
    var careNote = live(el('div'), function (b) { return get(b, 'exterior.finish'); }, function (b, node) {
      var f = get(b, 'exterior.finish'), c = FINISH_CARE[f] || {};
      U.clear(node);
      node.appendChild(note((find('paintFinishes', f) || {}).name + ': care ' + (c.care || '—') + ', durability ' + (c.durability || '—') + '/10, repair — ' + (c.repair || '—') + '.' +
        (f === 'matte' || f === 'satin' ? ' No automatic car washes, no wax: use dedicated matte sealant.' : f === 'chrome' ? ' Requires a PPF wrap to survive daily use.' : ''), c.durability <= 5 ? 'warning' : 'info'));
    });
    root.appendChild(ui.section('Paint finish', 'Each chip is rendered live in your current colour.', finishCards, careNote));

    /* ---- roof */
    var roofCards = decorateCards(ui.cards({
      path: 'exterior.roof', label: 'Roof', columns: 5, optionDisabled: lockFn('roofTypes'),
      options: list('roofTypes').map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span class="ps-chip" aria-hidden="true"></span>', specs: o.weight_kg ? [['Weight', (o.weight_kg > 0 ? '+' : '') + o.weight_kg + ' kg']] : null }; })
    }), function (b) { return JSON.stringify([get(b, 'exterior.paint'), get(b, 'exterior.finish'), get(b, 'exterior.roofColor')]); },
    function (card, o, b) { var c = card.querySelector('.ps-chip'); if (c) c.style.background = roofCss(o.id, b); });
    var roofColor = ui.color({ path: 'exterior.roofColor', label: 'Contrast roof colour', swatches: CONTRAST_SWATCHES, visible: function (b) { return get(b, 'exterior.roof') === 'contrast'; } });
    var bodyStyleNote = live(el('div'), function (b) { return get(b, 'body.style') + get(b, 'exterior.roof'); }, function (b, node) {
      U.clear(node);
      var st = get(b, 'body.style'), r = get(b, 'exterior.roof');
      if (st === 'roadster' && r !== 'body') node.appendChild(note('Roadster: the roof option applies to the hard-top / tonneau panel.', 'info'));
      if (r === 'carbon') node.appendChild(note('Exposed carbon roof removes mass from the highest point of the car — a small but real CG drop.', 'good'));
      if (r === 'glass') node.appendChild(note('Panoramic glass adds ~12 kg up high, but floods the cabin with light.', 'info'));
    });
    root.appendChild(ui.section('Roof', null, roofCards, roofColor, bodyStyleNote));

    /* ---- stripes */
    var stripeCards = decorateCards(ui.cards({
      path: 'exterior.stripe', label: 'Stripe & livery', columns: 4, optionDisabled: lockFn('stripes'),
      options: list('stripes').map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span class="ps-stripe-icon"></span>' }; })
    }), function (b) { return get(b, 'exterior.paint') + get(b, 'exterior.stripeColor'); },
    function (card, o, b) { var c = card.querySelector('.cb-card-icon'); if (c) c.innerHTML = stripeIcon(o.id, hex(get(b, 'exterior.paint')), hex(get(b, 'exterior.stripeColor'))); });
    var stripeColor = ui.color({ path: 'exterior.stripeColor', label: 'Stripe colour', swatches: CONTRAST_SWATCHES, visible: function (b) { return get(b, 'exterior.stripe') !== 'none'; } });
    var stripeQuick = ui.bind(el('div', { class: 'ps-row' },
      btn('Auto contrast', function () { var p = get(cur(), 'exterior.paint'); setState('exterior.stripeColor', lum(p) > 0.35 ? '#111111' : '#f4f3ef', 'Stripe: auto contrast'); }),
      btn('Match calipers', function () { setState('exterior.stripeColor', get(cur(), 'exterior.caliperColor'), 'Stripe: match calipers'); }),
      btn('Tonal', function () { var p = get(cur(), 'exterior.paint'); setState('exterior.stripeColor', shade(p, lum(p) > 0.3 ? -0.45 : 0.5), 'Stripe: tonal'); })),
    'exterior.stripe', function () {}, { visible: function (b) { return get(b, 'exterior.stripe') !== 'none'; } });
    root.appendChild(ui.section('Stripes', 'Hand-laid vinyl or painted under clear — icons preview your colours.', stripeCards, ui.grid(2, stripeColor, stripeQuick)));

    /* ---- calipers */
    var calColor = ui.color({ path: 'exterior.caliperColor', label: 'Caliper colour', swatches: CALIPER_SWATCHES, hint: 'Heat-resistant powder coat, rated to 300 °C. Off-palette colours +' + money(opt('customCaliper', 650)) + '.' });
    var calFig = svgHost('ps-small ps-caliper', caliperSvg, function (b) { return JSON.stringify([get(b, 'exterior.caliperColor'), b.brakes]); }, 'Caliper and rotor preview');
    var calQuick = el('div', { class: 'ps-row' },
      btn('Match paint', function () { setState('exterior.caliperColor', get(cur(), 'exterior.paint'), 'Calipers: match paint'); }),
      btn('Match stripe', function () { setState('exterior.caliperColor', get(cur(), 'exterior.stripeColor'), 'Calipers: match stripe'); }),
      btn('Brakes panel →', function () { gotoPanel('brakes'); }));
    root.appendChild(ui.section('Brake calipers', 'Shown over your actual rotor size, material and piston count.', el('div', { class: 'ps-diagrams' }, calFig, el('div', { class: 'ps-score' }, calColor, calQuick))));

    /* ---- glass */
    var R = (D.ranges && D.ranges['exterior.windowTint_pct']) || { min: 0, max: 85, step: 1 };
    var euT = tintForVlt(70), usT = tintForVlt(35), limoT = tintForVlt(20);
    var tint = ui.slider({ path: 'exterior.windowTint_pct', label: 'Window tint', min: R.min, max: R.max, step: R.step || 1, unit: '%',
      ticks: [{ value: 0, label: '0' }, { value: euT, label: 'EU' }, { value: usT, label: 'US' }, { value: limoT, label: 'Limo' }, { value: 85, label: '85' }],
      marks: [{ value: euT, label: 'EU front-side legal limit (70% VLT)', kind: 'warn' }, { value: usT, label: 'Typical US limit (35% VLT)', kind: 'warn' }],
      hint: 'Ceramic nano film rejects 60% of infrared heat. Cost ' + money(opt('windowTintPerPct', 8)) + ' per %.' });
    var tintShade = el('i'), tintTxt = el('b');
    var tintPrev = live(el('div', { class: 'ps-tint', title: 'Looking out through the side glass' }, tintShade, tintTxt), function (b) { return get(b, 'exterior.windowTint_pct'); }, function (b) {
      var t = num(get(b, 'exterior.windowTint_pct'), 0), v = vlt(t);
      tintShade.style.opacity = (0.12 + t / 100 * 0.86).toFixed(2);
      tintTxt.textContent = v + '% VLT · ' + (v >= 70 ? 'legal everywhere' : v >= 35 ? 'rear/US legal' : 'track / privacy only');
    });
    root.appendChild(ui.section('Glass', null, ui.grid(2, tint, tintPrev)));

    /* ---- lights */
    var lightCards = ui.cards({
      path: 'exterior.lights', label: 'Headlights', columns: 4, optionDisabled: lockFn('lightTypes'),
      options: list('lightTypes').map(function (o) {
        var L = LIGHT_SPECS[o.id] || {};
        return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: lightIcon(o.id), badge: o.id === 'laser' ? '600 m' : null,
          specs: [['Reach', (L.reach_m || '—') + ' m'], ['Colour', (L.kelvin || '—') + ' K'], ['Segments', L.segments || 1]] };
      })
    });
    root.appendChild(ui.section('Lighting', 'Light signature shown on the livery plate, with beam.', lightCards));

    /* ---- details */
    var mirrors = ui.segmented({ path: 'exterior.mirrors', label: 'Mirror caps', options: list('mirrorTypes').map(function (o) { return { id: o.id, name: o.name, desc: o.desc + (o.price ? ' (' + ui.priceText(o.price) + ')' : '') }; }), optionDisabled: lockFn('mirrorTypes') });
    var badge = ui.segmented({ path: 'exterior.badge', label: 'Badging', options: list('badgeTypes').map(function (o) { return { id: o.id, name: o.name, desc: o.desc + (o.price ? ' (' + ui.priceText(o.price) + ')' : '') }; }), optionDisabled: lockFn('badgeTypes') });
    var numText = ui.text({ path: 'exterior.livery_number', label: 'Race number', maxLength: 3, placeholder: 'e.g. 27',
      transform: function (v) { return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 3); },
      hint: 'Up to three characters on door roundels and the roof (' + ui.priceText(opt('liveryNumber', 600)) + ').' });
    var roundel = live(el('span', { class: 'ps-roundel' }), function (b) { return get(b, 'exterior.livery_number') + get(b, 'exterior.stripe') + get(b, 'exterior.stripeColor'); }, function (b, node) {
      var nmb = get(b, 'exterior.livery_number', '');
      node.textContent = nmb || 'none';
      node.classList.toggle('is-empty', !nmb);
      node.style.borderColor = get(b, 'exterior.stripe') === 'le-mans' ? hex(get(b, 'exterior.stripeColor')) : '#111';
      node.style.fontSize = nmb.length > 2 ? '19px' : '';
    });
    var numBtns = el('div', { class: 'ps-row' }, roundel,
      btn('Random', function () { setState('exterior.livery_number', String(Math.floor(Math.random() * 99) + 1), 'Race number: random'); }),
      btn('Clear', function () { setState('exterior.livery_number', '', 'Race number cleared'); }));
    root.appendChild(ui.section('Details', null, ui.grid(2, mirrors, badge), ui.grid(2, numText, numBtns)));

    /* ---- cost */
    root.appendChild(ui.section('Exterior specification', 'Itemised cost of every exterior choice.', costBlock('exterior')));
  }

  /* ======================================================================
     PANEL: INTERIOR
     ====================================================================== */
  function interiorColors(b) {
    var n = b.interior || {};
    return { primary: hex(n.primaryColor, '#1a1a1a'), accent: hex(n.accentColor, '#b3121f'), stitch: hex(n.stitchColor, '#b3121f') };
  }
  function seatIcon(type, b) {
    var n = b.interior || {}, C = interiorColors(b);
    var px = 'psic-' + type;
    var ids = { uph: px + '-u', carbon: px + '-c', shell: px + '-s', seatShade: px + '-d', metal: px + '-m' };
    var defs = '<defs>' + upholsteryPattern(ids.uph, n.upholstery, C.primary, C.accent, C.stitch) + carbonPattern(ids.carbon, 6) +
      grad(ids.shell, [[0, '#2a2b2e'], [1, '#0b0b0c']], 1, 0.4) + grad(ids.seatShade, [[0, '#ffffff', 0.12], [0.35, '#000', 0], [1, '#000', 0.45]]) +
      grad(ids.metal, [[0, '#e3e6ea'], [0.5, '#8d9298'], [1, '#c9cdd2']]) + '</defs>';
    return '<svg viewBox="-12 196 184 170" class="ps-mini" aria-hidden="true">' + defs + seatSvg(80, type, C, ids, false) + '</svg>';
  }
  function steeringIcon(type, b) {
    var n = b.interior || {}, C = interiorColors(b);
    C.rim = type === 'race-quick-release' || n.upholstery === 'alcantara' ? mix(C.primary, '#2a2a2c', 0.5) : shade(C.primary, -0.12);
    if (lum(C.rim) < 0.02) C.rim = '#26262a';
    var px = 'psw-' + type, ids = { metal: px + '-m', carbon: px + '-c', trim: px + '-t' };
    var defs = '<defs>' + grad(ids.metal, [[0, '#e3e6ea'], [0.5, '#8d9298'], [1, '#c9cdd2']]) + carbonPattern(ids.carbon, 5) + trimPattern(ids.trim, n.trim) + '</defs>';
    return '<svg viewBox="-16 -2 172 144" class="ps-mini" aria-hidden="true">' + defs + steeringSvg(type, 70, 70, C, ids, false) + '</svg>';
  }

  function buildInterior(root, P) {
    root.appendChild(ui.issues('interior'));

    /* ---- hero: cabin + scores + themes */
    var cabin = svgHost('ps-cabin', function (b) { return interiorSvg(b); }, function (b) {
      return JSON.stringify([b.interior, b.tech, get(b, 'weight.rollCage'), get(b, 'transmission.type')]);
    }, 'Live interior preview from the rear seat');
    var lux = meter(), spt = meter(), sup = meter();
    var luxV = el('b'), sptV = el('b'), supV = el('b');
    var summary = el('div', { class: 'ps-sub' });
    var scores = live(el('div', { class: 'ps-score' },
      el('div', { class: 'ps-title' }, 'Cabin character'),
      el('div', { class: 'ps-meter-row' }, 'Luxury', lux, luxV), el('div', { class: 'ps-meter-row' }, 'Sport', spt, sptV), el('div', { class: 'ps-meter-row' }, 'Support', sup, supV),
      summary), function (b) { return JSON.stringify([b.interior, b.tech, get(b, 'weight.rollCage')]); }, function (b) {
      var sc = interiorScores(b), n = b.interior;
      lux.set(sc.luxury / 100, '#c9a26a'); luxV.textContent = sc.luxury;
      spt.set(sc.sport / 100, '#e5484d'); sptV.textContent = sc.sport;
      sup.set(sc.support / 100, '#3aa0ff'); supV.textContent = sc.support;
      summary.textContent = [(find('seatTypes', n.seatType) || {}).name, (find('upholsteries', n.upholstery) || {}).name, (find('trims', n.trim) || {}).name].filter(Boolean).join(' · ');
    });
    var themeRow = el('div', { class: 'ps-row' });
    INTERIOR_THEMES.forEach(function (th) {
      var b_ = el('button', { type: 'button', class: 'ps-pill', title: 'Apply the ' + th.name + ' interior theme' },
        el('span', { class: 'ps-dots ps-theme-dots' }, el('i', { style: { background: th.primary } }), el('i', { style: { background: th.accent } }), el('i', { style: { background: th.stitch } })), th.name);
      b_.addEventListener('click', function () {
        patchState({ interior: { primaryColor: th.primary, accentColor: th.accent, stitchColor: th.stitch, upholstery: th.upholstery, trim: th.trim } }, 'Interior theme: ' + th.name);
        toast(th.name + ' interior applied', 'success', { action: undoAction() });
      });
      b_._theme = th;
      themeRow.appendChild(b_);
    });
    ui.bind(themeRow, 'interior', function (b) {
      var n = b.interior;
      Array.prototype.forEach.call(themeRow.children, function (c) {
        var th = c._theme;
        c.classList.toggle('is-on', !!th && n.primaryColor === th.primary && n.accentColor === th.accent && n.stitchColor === th.stitch && n.upholstery === th.upholstery && n.trim === th.trim);
      });
    });
    var side = el('div', { class: 'ps-side' }, scores, el('div', { class: 'ps-title' }, 'Redline themes'), themeRow,
      el('div', { class: 'ps-row' },
        btn('Accent from paint', function () { var p = get(cur(), 'exterior.paint'); patchState({ interior: { accentColor: p, stitchColor: p } }, 'Cabin accent from paint'); }),
        btn('Reset interior', function () { patchState({ interior: D.defaultBuild().interior }, 'Reset interior'); toast('Interior reset to factory', 'info', { action: undoAction() }); })));
    root.appendChild(el('div', { class: 'ps-hero' }, cabin, side));

    /* ---- stats */
    var stats = statGrid([
      { key: 'cost', label: 'Options' }, { key: 'weight', label: 'Weight Δ', unit: 'kg', decimals: 1 },
      { key: 'seat', label: 'Seats (pair)', unit: 'kg', decimals: 0 }, { key: 'wheel', label: 'Wheel Ø', unit: 'mm', decimals: 0 },
      { key: 'noise', label: 'Cabin noise', unit: 'dB', decimals: 0 }, { key: 'lux', label: 'Luxury', decimals: 0 }
    ]);
    P.watch(stats, function (b, m) {
      var n = b.interior, c = sectionCost(b, 'interior');
      var seat = find('seatTypes', n.seatType) || {};
      var lr = m && m.ratings && m.ratings.luxury != null ? m.ratings.luxury : interiorScores(b).luxury;
      stats.setAll({
        cost: c.total ? money(c.total) : 'Included', weight: { value: sectionWeight(b, 'interior'), unit: 'kg' },
        seat: { value: 2 * (24 + num(seat.weight_kg, 0) / 2), unit: 'kg' }, wheel: { value: (STEERING_SPECS[n.steering] || {}).dia_mm, unit: 'mm' },
        noise: m && m.noise_db_cabin != null ? { value: m.noise_db_cabin, unit: 'dB' } : null, lux: Math.round(lr)
      });
    });
    root.appendChild(stats);

    /* ---- seats */
    var seatCards = decorateCards(ui.cards({
      path: 'interior.seatType', label: 'Seats', columns: 3, optionDisabled: lockFn('seatTypes'),
      options: list('seatTypes').map(function (o) {
        return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span></span>', badge: o.id === 'race-shell' ? 'FIA' : o.id === 'lounge' ? 'Massage' : null,
          specs: [['Lateral support', Math.round(num(o.support, 0.5) * 100) + '%'], ['Mass', (o.weight_kg > 0 ? '+' : '') + num(o.weight_kg, 0) + ' kg']] };
      })
    }), function (b) { return JSON.stringify(interiorColors(b)) + get(b, 'interior.upholstery'); },
    function (card, o, b) { var ic = card.querySelector('.cb-card-icon'); if (ic) ic.innerHTML = seatIcon(o.id, b); });
    var seatNote = live(el('div'), function (b) { return get(b, 'interior.seatType') + '|' + get(b, 'interior.harness') + '|' + get(b, 'body.seats') + '|' + get(b, 'weight.rearSeats'); }, function (b, node) {
      U.clear(node);
      var t = get(b, 'interior.seatType'), shell = ['bucket', 'carbon-bucket', 'race-shell'].indexOf(t) >= 0;
      if (get(b, 'interior.harness') && !shell) node.appendChild(note('A six-point harness on reclining seats offers little protection — pair it with buckets or FIA shells.', 'warning'));
      if (t === 'lounge' && get(b, 'body.seats') <= 2) node.appendChild(note('Lounge thrones are designed for grand tourers; in a two-seater they eat luggage space.', 'info'));
      if (t === 'race-shell') node.appendChild(note('Fixed shells: no heating, ventilation or power adjustment. Rails are bolted per driver.', 'info'));
    });
    root.appendChild(ui.section('Seating', 'Seat silhouettes are drawn in your upholstery and colours.', seatCards, seatNote));

    /* ---- upholstery */
    var uphCards = decorateCards(ui.cards({
      path: 'interior.upholstery', label: 'Upholstery', columns: 4, optionDisabled: lockFn('upholsteries'),
      options: list('upholsteries').map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span class="ps-chip" aria-hidden="true"></span>', specs: [['Luxury', Math.round(num(o.luxury, 0.5) * 100) + '%']] }; })
    }), function (b) { return JSON.stringify(interiorColors(b)); },
    function (card, o, b) { var c = card.querySelector('.ps-chip'); var C = interiorColors(b); if (c) c.style.background = upholsteryCss(o.id, C.primary, C.accent, C.stitch); });
    root.appendChild(ui.section('Upholstery', null, uphCards));

    /* ---- colours */
    var prim = ui.color({ path: 'interior.primaryColor', label: 'Primary hide', swatches: LEATHER_SWATCHES });
    var acc = ui.color({ path: 'interior.accentColor', label: 'Accent (bolsters, piping)', swatches: LEATHER_SWATCHES });
    var sti = ui.color({ path: 'interior.stitchColor', label: 'Contrast stitching', swatches: STITCH_SWATCHES });
    var colBtns = el('div', { class: 'ps-row' },
      btn('Stitch = accent', function () { setState('interior.stitchColor', get(cur(), 'interior.accentColor'), 'Stitch matches accent'); }),
      btn('Swap primary ⇄ accent', function () { var n = cur().interior; patchState({ interior: { primaryColor: n.accentColor, accentColor: n.primaryColor } }, 'Swap cabin colours'); }),
      btn('Tone-on-tone', function () { var p = get(cur(), 'interior.primaryColor'); patchState({ interior: { accentColor: shade(p, -0.2), stitchColor: shade(p, 0.25) } }, 'Tone-on-tone cabin'); }));
    var contrastNote = live(el('div'), function (b) { return JSON.stringify(interiorColors(b)); }, function (b, node) {
      U.clear(node);
      var C = interiorColors(b);
      if (colorDist(C.primary, C.stitch) < 40) node.appendChild(note('Stitching is nearly invisible against the primary hide — pick a contrasting thread to show the hand-work.', 'info'));
      if (lum(C.primary) > 0.6) node.appendChild(note('Light hides show denim dye transfer — the Garage applies a protective coat at no charge.', 'info'));
    });
    root.appendChild(ui.section('Colour & trim', 'Hides are dyed through; thread is bonded nylon in 12 shades.', ui.grid(3, prim, acc, sti), colBtns, contrastNote));

    /* ---- trim */
    var trimCards = decorateCards(ui.cards({
      path: 'interior.trim', label: 'Dashboard & console trim', columns: 4, optionDisabled: lockFn('trims'),
      options: list('trims').map(function (o) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span class="ps-chip" aria-hidden="true"></span>' }; })
    }), function () { return 'static'; }, function (card, o) { var c = card.querySelector('.ps-chip'); if (c) c.style.background = trimCss(o.id); });
    root.appendChild(ui.section('Trim inlays', null, trimCards));

    /* ---- steering + headliner */
    var steerCards = decorateCards(ui.cards({
      path: 'interior.steering', label: 'Steering wheel', columns: 4, optionDisabled: lockFn('steeringTypes'),
      options: list('steeringTypes').map(function (o) {
        var sp = STEERING_SPECS[o.id] || {};
        return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: '<span></span>', specs: [['Diameter', (sp.dia_mm || '—') + ' mm'], ['Lock-to-lock', sp.lock || '—']] };
      })
    }), function (b) { return JSON.stringify(interiorColors(b)) + get(b, 'interior.upholstery') + get(b, 'interior.trim'); },
    function (card, o, b) { var ic = card.querySelector('.cb-card-icon'); if (ic) ic.innerHTML = steeringIcon(o.id, b); });
    var headliner = ui.segmented({ path: 'interior.headliner', label: 'Headliner', optionDisabled: lockFn('headliners'),
      options: list('headliners').map(function (o) { return { id: o.id, name: o.name, desc: o.desc + (o.price ? ' (' + ui.priceText(o.price) + ')' : '') }; }) });
    root.appendChild(ui.section('Wheel & headliner', null, steerCards, headliner));

    /* ---- ambient */
    var ambT = ui.toggle({ path: 'interior.ambientLighting', label: 'Ambient lighting', price: opt('ambientLighting', 500), hint: '64-colour fibre-optic light lines across dash, doors and footwells.', disabled: function () { return lockReason('feature', 'interior.ambientLighting'); } });
    var ambC = ui.color({ path: 'interior.ambientColor', label: 'Ambient colour', swatches: AMBIENT_SWATCHES, visible: function (b) { return !!get(b, 'interior.ambientLighting'); } });
    var ambQ = ui.bind(el('div', { class: 'ps-row' },
      btn('Match accent', function () { setState('interior.ambientColor', U.shade(get(cur(), 'interior.accentColor'), 0.15), 'Ambient matches accent'); }),
      btn('Match paint', function () { setState('interior.ambientColor', U.shade(get(cur(), 'exterior.paint'), 0.2), 'Ambient matches paint'); })),
    'interior.ambientLighting', function () {}, { visible: function (b) { return !!get(b, 'interior.ambientLighting'); } });
    root.appendChild(ui.section('Ambient lighting', null, ambT, ambC, ambQ));

    /* ---- safety equipment */
    var harness = ui.toggle({ path: 'interior.harness', label: 'Six-point harness', price: opt('harness', 1200), hint: 'FIA 8853-2016 harness with camlock buckle; retains the inertia-reel belt for the road.', disabled: function () { return lockReason('feature', 'interior.harness'); } });
    var cageInfo = kvLive(function (b) {
      var cg = find('rollCages', get(b, 'weight.rollCage', 'none')) || { name: 'None', weight_kg: 0 };
      return [['Roll cage', cg.name], ['Cage mass', (cg.weight_kg ? '+' + cg.weight_kg : 0) + ' kg'], ['Rear seats', get(b, 'weight.rearSeats') ? 'Fitted' : 'Deleted']];
    });
    root.appendChild(ui.section('Safety equipment', 'The roll cage is specified on the Weight panel; it is drawn here so you can see it in the cabin.', ui.grid(2, harness, el('div', { class: 'ps-score' }, cageInfo, btn('Configure roll cage →', function () { gotoPanel('weight'); })))));

    root.appendChild(ui.section('Interior specification', null, costBlock('interior')));
  }

  /* ======================================================================
     PANEL: TECH
     ====================================================================== */
  function screenIcon(o) {
    var spec = SCREEN_SPECS[o.id] || {}, s;
    if (!o.id) s = '<rect x="10" y="14" width="60" height="20" rx="3" fill="none" stroke="currentColor" stroke-dasharray="3 2"/><path d="M14 18 L66 30" stroke="currentColor"/>';
    else if (spec.layout === 'portrait') s = '<rect x="27" y="2" width="26" height="36" rx="3" fill="#0f2236" stroke="currentColor"/>';
    else if (spec.layout === 'hyper') s = '<path d="M2 16 Q40 10 78 16 V28 Q40 22 2 28 Z" fill="#0f2236" stroke="currentColor"/>';
    else { var w = o.id * 4.4, h = w * 0.5; s = '<rect x="' + f1(40 - w / 2) + '" y="' + f1(20 - h / 2) + '" width="' + f1(w) + '" height="' + f1(h) + '" rx="3" fill="#0f2236" stroke="currentColor"/>'; }
    return '<svg viewBox="0 0 80 40" class="ps-mini" aria-hidden="true">' + s + '</svg>';
  }

  function buildTech(root, P) {
    root.appendChild(ui.issues('tech'));

    var dash = svgHost('ps-dash', function (b) { return techSvg(b); }, function (b) {
      return JSON.stringify([b.tech, get(b, 'interior.accentColor'), get(b, 'interior.primaryColor'), get(b, 'interior.trim'), get(b, 'interior.ambientLighting'), get(b, 'interior.ambientColor'), get(b, 'engine.type'), get(b, 'engine.redline_rpm')]);
    }, 'Live cockpit display preview');
    var loadTotal = el('div', { class: 'ps-big' }), loadSub = el('div', { class: 'ps-sub' });
    var loadBars = el('div', { class: 'ps-score' });
    var side = el('div', { class: 'ps-side' }, el('div', { class: 'ps-title' }, 'Electrical load'), loadTotal, loadSub, loadBars);
    P.watch(side, function (b, m) {
      var L = electricalLoad(b);
      loadTotal.textContent = fmt(L.total) + ' W';
      var ri = rangeImpact(b, m);
      loadSub.textContent = ri ? 'EV range cost at 100 km/h ≈ ' + fmt(ri.km) + ' km (' + fmt(ri.pct, 1) + '%)' : '12 V system · ≈ ' + fmt(L.total / 13.8, 1) + ' A from the alternator';
      U.clear(loadBars);
      var max = Math.max.apply(null, L.parts.map(function (p) { return p[1]; }).concat([1]));
      L.parts.filter(function (p) { return p[1] > 0; }).sort(function (a, c) { return c[1] - a[1]; }).slice(0, 7).forEach(function (p) {
        var mtr = meter(); mtr.set(p[1] / max);
        loadBars.appendChild(el('div', { class: 'ps-meter-row' }, p[0], mtr, el('b', null, fmt(p[1]))));
      });
    });
    root.appendChild(el('div', { class: 'ps-hero' }, dash, side));

    var stats = statGrid([
      { key: 'cost', label: 'Options' }, { key: 'weight', label: 'Weight Δ', unit: 'kg', decimals: 1 },
      { key: 'adas', label: 'ADAS features', decimals: 0 }, { key: 'spk', label: 'Speakers', decimals: 0 },
      { key: 'watts', label: 'Amplifier', unit: 'W', decimals: 0 }, { key: 'zones', label: 'Zones', decimals: 0 }
    ]);
    live(stats, function (b) { return JSON.stringify([b.tech, CB.pricing ? b : 0]); }, function (b) {
      var t = b.tech, a = AUDIO_SPECS[t.audio] || {}, c = sectionCost(b, 'tech');
      stats.setAll({
        cost: c.total ? (c.total < 0 ? '–' + money(-c.total) : money(c.total)) : 'Included', weight: { value: sectionWeight(b, 'tech'), unit: 'kg' },
        adas: adasFeatures(t.adas).length, spk: a.speakers, watts: { value: a.watts, unit: 'W' }, zones: t.climateZones
      });
    });
    root.appendChild(stats);

    /* ---- displays */
    var screens = ui.cards({
      path: 'tech.screen_in', label: 'Centre display', columns: 6, compact: true, optionDisabled: lockFn('screenSizes'),
      options: list('screenSizes').map(function (o) { var sp = SCREEN_SPECS[o.id] || {}; return { id: o.id, name: o.name, desc: o.desc, price: o.price, icon: screenIcon(o), specs: [['Resolution', sp.res || '—']] }; })
    });
    var cluster = ui.toggle({ path: 'tech.digitalCluster', label: 'Digital instrument cluster', price: opt('digitalCluster', 900), hint: '12.3" configurable cluster with track, map and classic dial layouts. Off = machined analogue dials.', disabled: function () { return lockReason('feature', 'tech.digitalCluster'); } });
    var hud = ui.toggle({ path: 'tech.hud', label: 'Augmented head-up display', price: opt('hud', 1400), hint: 'Projects speed, navigation arrows and lane guidance 2.5 m ahead of the windscreen.', disabled: function () { return lockReason('feature', 'tech.hud'); } });
    var screenNote = live(el('div'), function (b) { return get(b, 'tech.screen_in') + '|' + get(b, 'tech.digitalCluster') + '|' + get(b, 'tech.hud'); }, function (b, node) {
      U.clear(node);
      if (!num(get(b, 'tech.screen_in'), 12) && !get(b, 'tech.digitalCluster')) node.appendChild(note('Fully analogue cockpit: no screens at all. Navigation via phone mount only.', 'info'));
      if (!num(get(b, 'tech.screen_in'), 12) && get(b, 'tech.hud')) node.appendChild(note('Without a centre screen the HUD becomes your only navigation display.', 'info'));
    });
    root.appendChild(ui.section('Displays', 'The preview above draws your exact screen, cluster and HUD.', screens, ui.grid(2, cluster, hud), screenNote));

    /* ---- audio */
    var audioCards = ui.cards({
      path: 'tech.audio', label: 'Audio system', columns: 3, optionDisabled: lockFn('audioSystems'),
      options: list('audioSystems').map(function (o) {
        var a = AUDIO_SPECS[o.id] || {};
        return { id: o.id, name: o.name, desc: o.desc, price: o.price, badge: a.dirac ? 'Room-tuned' : null,
          specs: [['Speakers', a.speakers || 0], ['Power', (a.watts || 0) + ' W'], ['Mass', (o.weight_kg > 0 ? '+' : '') + num(o.weight_kg, 0) + ' kg']] };
      })
    });
    var audFig = svgHost('ps-small', audioSvg, function (b) { return get(b, 'tech.audio'); }, 'Speaker layout');
    var audInfo = kvLive(function (b) {
      var a = AUDIO_SPECS[get(b, 'tech.audio')] || {};
      return [['Character', a.tag || '—'], ['Subwoofers', a.sub || 0], ['In-seat transducers', a.transducers || 0], ['Room correction', a.dirac ? 'Yes' : 'No'],
        ['Exhaust (outside)', get(b, 'engine.type') === 'ev' ? 'Silent — EV' : ((find('exhausts', get(b, 'engine.exhaust')) || {}).loudness_db || '—') + ' dB']];
    });
    root.appendChild(ui.section('Audio', null, audioCards, el('div', { class: 'ps-diagrams' }, audFig, audInfo)));

    /* ---- ADAS */
    var adasList = list('adasLevels');
    var adasCards = ui.cards({
      path: 'tech.adas', label: 'Driver assistance', columns: 3, optionDisabled: lockFn('adasLevels'),
      options: adasList.map(function (o, i) { return { id: o.id, name: o.name, desc: o.desc, price: o.price, badge: i === adasList.length - 1 ? 'Eyes-off' : null, specs: [['Sensors', ADAS_SENSORS[o.id] || '—'], ['Features', adasFeatures(o.id).length]] }; })
    });
    /* append feature lists to each card: new features at that level highlighted */
    Array.prototype.forEach.call(adasCards.querySelectorAll('.cb-card'), function (card) {
      var o = card._option; if (!o) return;
      var body = card.querySelector('.cb-card-body') || card;
      var ul = el('ul', { class: 'ps-feat' });
      var feats = adasFeatures(o.id);
      var fresh = feats.filter(function (f) { return f.from === o.id; });
      (fresh.length ? fresh : feats).forEach(function (f) { ul.appendChild(el('li', { class: f.from === o.id ? 'is-new' : '' }, f.name)); });
      var prevCount = feats.length - fresh.length;
      if (prevCount > 0) ul.appendChild(el('li', null, '+ ' + prevCount + ' from lower levels'));
      body.appendChild(ul);
    });
    var matrixHost = el('div', { class: 'ps-matrix-wrap' });
    var table = el('table', { class: 'ps-matrix' });
    var thead = el('tr', null, el('th', null, 'Feature'));
    adasList.forEach(function (o) { thead.appendChild(el('th', { dataset: { lv: o.id } }, o.name.replace(/\s*\(.*\)/, ''))); });
    table.appendChild(el('thead', null, thead));
    var tbody = el('tbody');
    ADAS_FEATURES.forEach(function (f) {
      var tr = el('tr', null, el('td', null, f.name));
      var fi = idxOf('adasLevels', f.from);
      adasList.forEach(function (o, i) { tr.appendChild(el('td', { class: i >= fi ? 'yes' : '', dataset: { lv: o.id } }, i >= fi ? '●' : '·')); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    matrixHost.appendChild(table);
    ui.bind(matrixHost, 'tech.adas', function (b) {
      var v = get(b, 'tech.adas');
      Array.prototype.forEach.call(table.querySelectorAll('[data-lv]'), function (c) { c.classList.toggle('is-cur', c.dataset.lv === v); });
    });
    var adasNote = live(el('div'), function (b) { return get(b, 'tech.adas') + '|' + get(b, 'tires.compound') + '|' + get(b, 'suspension.rideHeight_mm'); }, function (b, node) {
      U.clear(node);
      var a = get(b, 'tech.adas');
      if (a === 'autonomous-l3') node.appendChild(note('L3 is legally restricted to mapped motorways in approved markets; the lidar adds 8 kg and ~650 W of compute.', 'info'));
      if (a !== 'none' && (get(b, 'tires.compound') === 'slick' || get(b, 'tires.compound') === 'track')) node.appendChild(note('Lane and emergency systems are calibrated for road tyres — on track rubber they will be set to advisory-only.', 'warning'));
      if (a === 'none') node.appendChild(note('Only the legally mandated emergency braking remains. Some markets require more for registration.', 'warning'));
    });
    root.appendChild(ui.section('Driver assistance', 'Feature lists per level; the matrix highlights your selection.', adasCards, matrixHost, adasNote));

    /* ---- climate */
    var zones = ui.slider({ path: 'tech.climateZones', label: 'Climate zones', min: 1, max: 4, step: 1, ticks: [1, 2, 3, 4],
      format: function (v) { return v + (v === 1 ? ' zone' : ' zones'); },
      range: function (b) { return [1, Math.max(1, Math.min(4, num(get(b, 'body.seats'), 4)))]; },
      hint: 'Independent temperature, airflow and seat heating per zone (' + ui.priceText(opt('perClimateZone', 650)) + ' per additional zone). Limited by seat count.' });
    var climFig = svgHost('ps-small', climateSvg, function (b) { return get(b, 'tech.climateZones') + '|' + get(b, 'body.seats'); }, 'Climate zone diagram');
    root.appendChild(ui.section('Climate', null, el('div', { class: 'ps-diagrams' }, climFig, zones)));

    /* ---- track & utility */
    var tel = ui.toggle({ path: 'tech.telemetry', label: 'Track telemetry', price: opt('telemetry', 2400), hint: '100 Hz GPS + IMU logger, lap timer, predictive delta and video overlay export.', disabled: function () { return lockReason('feature', 'tech.telemetry'); } });
    var lift = ui.toggle({ path: 'tech.liftSystem', label: 'Front-axle lift', price: opt('liftSystem', 3200), hint: 'Hydraulic nose lift (+40 mm in 3 s) with GPS memory for up to 1,000 driveways.', disabled: function () { return lockReason('feature', 'tech.liftSystem'); } });
    var nv = ui.toggle({ path: 'tech.nightVision', label: 'Night vision', price: opt('nightVision', 2600), hint: 'Far-infrared camera detects pedestrians and animals up to 300 m, shown in the cluster.', disabled: function () { return lockReason('feature', 'tech.nightVision'); } });
    var liftNote = live(el('div'), function (b) { return get(b, 'tech.liftSystem') + '|' + get(b, 'suspension.rideHeight_mm') + '|' + get(b, 'aero.splitter'); }, function (b, node) {
      U.clear(node);
      var rh = num(get(b, 'suspension.rideHeight_mm'), 120), sp = get(b, 'aero.splitter');
      if (!get(b, 'tech.liftSystem') && (rh < 90 || sp === 'race')) node.appendChild(note('Ride height ' + rh + ' mm' + (sp === 'race' ? ' with a race splitter' : '') + ' — the front-axle lift will save your bodywork on ramps.', 'warning'));
      if (get(b, 'tech.liftSystem') && rh > 180) node.appendChild(note('With ' + rh + ' mm of ground clearance the lift system is unlikely to be needed.', 'info'));
    });
    root.appendChild(ui.section('Track & utility', null, ui.grid(3, tel, lift, nv), liftNote));

    root.appendChild(ui.section('Tech specification', null, costBlock('tech')));
  }

  /* ======================================================================
     REGISTRATION
     ====================================================================== */
  makePanel({ id: 'exterior', title: 'Exterior', subtitle: 'Paint, finish, livery & details', order: 10, build: buildExterior });
  makePanel({ id: 'interior', title: 'Interior', subtitle: 'Seats, hides, trim & ambience', order: 20, build: buildInterior });
  makePanel({ id: 'tech', title: 'Technology', subtitle: 'Displays, audio, assistance & comfort', order: 30, build: buildTech });
})();

if (typeof module !== 'undefined') module.exports = CB.panelsStyle;

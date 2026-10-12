/* ==========================================================================
   FORGE Atelier — js/race/renderer.js
   CB.race.renderer : top-down Canvas 2D world renderer for Race Mode.

   Contract (RACE-SPEC.md, "Inter-module contracts"):
     CB.race.renderer.create(canvas, geom, trackDef, opts {timeOfDay, weather, camera, racingLine, labels, maxDpr})
       -> { render(snap, alpha?), setCamera('chase'|'north'|'tv'), cycleCamera(), resize(), destroy(),
            reset(), setRacingLine(bool), setLabels(bool), getCamera(), setQuality(q), stats() }

   Overview
   --------
   * World units are metres, +x east, +y north, heading 0 = +x, counter-clockwise (same as tracks.js / engine.js).
     The screen transform flips y so the circuit appears exactly as the minimap / previewPath draws it.
   * The static world (ground, run-off, gravel, asphalt, rubber, kerbs, lines, grid, pit lane, walls, flat scenery
     and baked shadows) is painted lazily into a multi-resolution tile pyramid of offscreen canvases (LRU cached,
     time-budgeted per frame, coarse level fully pre-rendered so there is never a hole).
   * Tall scenery (trees, grandstands, buildings, towers, lamps, billboards, start gantry, bridge deck) is drawn
     dynamically with a fake-3D parallax lean away from the camera eye, from cached procedural sprites.
   * Cars are cached body sprites (paint finish, stripes, glass, roof, wing, lights, roof number) built from the
     body style's proportions (CB.data.bodyStyles[].svg hints, with an internal fallback table) + dynamic wheels
     (steer angle, tread motion), brake lights, reverse lights, backfire, drop shadow.
   * Effects: persistent fading skid / dirt marks (ring buffer), pooled particles (smoke, dust, grass, sand, spray,
     sparks, debris, flames, rain splashes), screen-space rain streaks, camera shake.
   * Lighting: dusk/night use a half-resolution light map (ambient + additive light pools: lamps, headlights,
     tail/brake lights, sparks) multiplied over the world, followed by an emissive pass (lenses, windows, neon).
   * Cameras: rotating chase (look-ahead, speed zoom, smoothed, rate-limited rotation), north-up, and a TV
     broadcast cam (fixed trackside points, long-lens zoom, cuts with short eased blends). Mode switches blend.
   * Interpolation: if cars carry prevX/prevY/prevHeading (engine substep state) poses are lerped by alpha;
     otherwise the renderer keeps the previous snapshot internally and extrapolates by velocity.
   Zero dependencies; loads in Node (no DOM access at load time) so pure helpers are testable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

CB.race.renderer = (function () {
  'use strict';

  /* ================================================================ constants */

  var TAU = Math.PI * 2, PI = Math.PI, HALF_PI = Math.PI / 2;
  var TILE_PX = 512;                              // tile canvas content size (device px)
  var TILE_BLEED = 2;                             // overlap pixels on each side (hides seams)
  var LEVELS = [0.75, 1.5, 3, 6, 12, 24];         // tile pyramid resolutions (px per metre)
  var MAX_TILES = 110;                            // LRU capacity (levels >= 1)
  var CELL = 48;                                  // spatial bucket size (m)
  var SKID_CAP = 9000;                            // skid-mark ring buffer segments
  var PART_CAP = 2200;                            // particle pool
  var CAR_PPM = 40;                               // car sprite resolution (px per metre)
  var LIGHT_SCALE = 2;                            // light map down-scale
  var SUN_DAY = { x: 0.52, y: -0.40 };            // shadow displacement per metre of height
  var SUN_DUSK = { x: 1.25, y: -0.55 };
  var CAMERA_MODES = ['chase', 'north', 'tv'];

  /* ================================================================ math */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function wrapAngle(a) { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; }
  function lerpAngle(a, b, t) { return a + wrapAngle(b - a) * t; }
  function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function easeInOut(t) { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function damp(rate, dt) { return 1 - Math.exp(-rate * dt); }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  /* ================================================================ colour */

  var rgbCache = {};
  function hexToRgb(h) {
    if (Array.isArray(h)) return h;
    var key = String(h || '');
    var hit = rgbCache[key];
    if (hit) return hit;
    var out = [128, 128, 128];
    var s = key.trim();
    if (s[0] === '#') {
      s = s.slice(1);
      if (s.length === 3 || s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var n = parseInt(s.slice(0, 6), 16);
      if (!isNaN(n)) out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else {
      var m = /rgba?\(([^)]+)\)/.exec(s);
      if (m) {
        var p = m[1].split(',').map(function (x) { return parseFloat(x); });
        if (p.length >= 3) out = [p[0] | 0, p[1] | 0, p[2] | 0];
      }
    }
    rgbCache[key] = out;
    return out;
  }
  function rgba(c, a) {
    var r = hexToRgb(c);
    return 'rgba(' + (r[0] | 0) + ',' + (r[1] | 0) + ',' + (r[2] | 0) + ',' + (a == null ? 1 : Math.round(a * 1000) / 1000) + ')';
  }
  function toHex(r) {
    function h2(v) { v = clamp(Math.round(v), 0, 255); return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + h2(r[0]) + h2(r[1]) + h2(r[2]);
  }
  /** f < 0 darkens toward black, f > 0 lightens toward white. */
  function shade(c, f) {
    var r = hexToRgb(c);
    if (f < 0) return toHex([r[0] * (1 + f), r[1] * (1 + f), r[2] * (1 + f)]);
    return toHex([r[0] + (255 - r[0]) * f, r[1] + (255 - r[1]) * f, r[2] + (255 - r[2]) * f]);
  }
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return toHex([lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]);
  }
  function luminance(c) { var r = hexToRgb(c); return (0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]) / 255; }
  function hueShift(c, deg) {
    var r = hexToRgb(c), R = r[0] / 255, G = r[1] / 255, B = r[2] / 255;
    var mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === R) h = (G - B) / d + (G < B ? 6 : 0); else if (mx === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
      h /= 6;
    }
    h = mod(h + deg / 360, 1);
    function f(p, q, t) { t = mod(t, 1); if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 0.5) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    if (s === 0) return toHex([l * 255, l * 255, l * 255]);
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return toHex([f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255]);
  }

  /* ================================================================ rng */

  function hashStr(s) {
    s = String(s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    var f = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = function (lo, hi) { return lo + (hi - lo) * f(); };
    f.int = function (lo, hi) { return Math.floor(lo + (hi - lo + 1) * f()); };
    f.pick = function (arr) { return arr[Math.floor(f() * arr.length) % arr.length]; };
    f.chance = function (p) { return f() < p; };
    return f;
  }

  /* ================================================================ canvas helpers */

  function makeCanvas(w, h) {
    w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
    if (typeof document !== 'undefined' && document.createElement) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    return null;
  }
  function ctx2d(c) { return c ? c.getContext('2d') : null; }

  /** Draw text in a world (y-up, mirrored-on-screen) frame so it reads correctly; angle = baseline direction. */
  function worldText(ctx, str, x, y, angle, sizeM, font, align, baseline) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle || 0);
    ctx.scale(1, -1);
    ctx.font = (font || '800') + ' ' + 100 + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
    var k = sizeM / 100;
    ctx.scale(k, k);
    ctx.textAlign = align || 'center';
    ctx.textBaseline = baseline || 'middle';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /* ================================================================ procedural textures */

  /** Tileable multi-octave value noise -> Float32Array in 0..1. */
  function valueNoise(size, seed, octaves, basePeriod, persistence) {
    var out = new Float32Array(size * size), R = rng(seed);
    var amp = 1, total = 0, period = basePeriod;
    for (var o = 0; o < octaves; o++) {
      var P = Math.max(1, Math.round(period));
      var lat = new Float32Array(P * P);
      for (var k = 0; k < lat.length; k++) lat[k] = R();
      var cellPx = size / P;
      for (var y = 0; y < size; y++) {
        var fy = y / cellPx, iy = Math.floor(fy), ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
        var y0 = iy % P, y1 = (iy + 1) % P;
        for (var x = 0; x < size; x++) {
          var fx = x / cellPx, ix = Math.floor(fx), tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
          var x0 = ix % P, x1 = (ix + 1) % P;
          var a = lat[y0 * P + x0], b = lat[y0 * P + x1], c = lat[y1 * P + x0], d = lat[y1 * P + x1];
          out[y * size + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
        }
      }
      total += amp; amp *= persistence; period *= 2;
    }
    for (var i = 0; i < out.length; i++) out[i] /= total;
    return out;
  }

  function noiseCanvas(size, fn) {
    var c = makeCanvas(size, size), g = ctx2d(c);
    if (!g) return null;
    var img = g.createImageData(size, size), d = img.data;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var p = (y * size + x) * 4, px = fn(x, y, y * size + x);
        d[p] = px[0]; d[p + 1] = px[1]; d[p + 2] = px[2]; d[p + 3] = px[3] == null ? 255 : px[3];
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** Builds the texture set for a theme (patterns are created per-context lazily). */
  function buildTextures(theme, seed, wet, street) {
    var T = {};
    var grass = hexToRgb(theme.grass), sand = hexToRgb(theme.sand), asph = hexToRgb(theme.asphalt);
    var ground = hexToRgb(theme.ground || theme.grass);
    var R = rng(seed);
    var px = [0, 0, 0, 255];
    // grass: large blotches + mid noise + blade speckles (size 256 px covers 32 m)
    var nA = valueNoise(256, seed + 1, 4, 4, 0.55), nB = valueNoise(256, seed + 2, 3, 16, 0.5);
    T.grass = noiseCanvas(256, function (x, y, i) {
      var v = (nA[i] - 0.5) * 0.30 + (nB[i] - 0.5) * 0.16 + (R() - 0.5) * 0.10;
      var warm = (nA[i] - 0.5) * 0.12;
      px[0] = clamp(grass[0] * (1 + v) + warm * 40, 0, 255);
      px[1] = clamp(grass[1] * (1 + v * 0.9), 0, 255);
      px[2] = clamp(grass[2] * (1 + v * 0.7) - warm * 10, 0, 255);
      px[3] = 255;
      return px;
    });
    T.grassM = 32;
    // fine grass blades (alpha overlay, 128 px covers 3 m)
    T.blades = noiseCanvas(128, function () {
      var r = R();
      if (r < 0.10) { px[0] = 255; px[1] = 255; px[2] = 210; px[3] = 40; }
      else if (r < 0.24) { px[0] = 0; px[1] = 20; px[2] = 0; px[3] = 46; }
      else { px[3] = 0; }
      return px;
    });
    T.bladesM = 3;
    // urban ground: paving slabs (256 px covers 8 m, slab 2 m)
    var nU = valueNoise(256, seed + 3, 3, 8, 0.5);
    T.urban = noiseCanvas(256, function (x, y, i) {
      var v = (nU[i] - 0.5) * 0.22 + (R() - 0.5) * 0.08;
      var joint = (x % 64 < 2 || y % 64 < 2) ? -0.22 : 0;
      var slab = ((Math.floor(x / 64) * 7 + Math.floor(y / 64) * 13) % 5) * 0.012;
      px[0] = clamp(ground[0] * (1 + v + joint + slab), 0, 255);
      px[1] = clamp(ground[1] * (1 + v + joint + slab), 0, 255);
      px[2] = clamp(ground[2] * (1 + v + joint + slab), 0, 255);
      px[3] = 255;
      return px;
    });
    T.urbanM = 8;
    // asphalt aggregate grain (alpha overlay, 256 px covers 5 m)
    T.grain = noiseCanvas(256, function () {
      var r = R();
      if (r < 0.16) { px[0] = 255; px[1] = 255; px[2] = 255; px[3] = 18 + R() * 30; }
      else if (r < 0.36) { px[0] = 0; px[1] = 0; px[2] = 0; px[3] = 22 + R() * 34; }
      else { px[3] = 0; }
      return px;
    });
    T.grainM = 5;
    // asphalt large-scale patches / repairs / wear (256 px covers 90 m)
    var nP = valueNoise(256, seed + 4, 4, 6, 0.6);
    T.patches = noiseCanvas(256, function (x, y, i) {
      var v = nP[i];
      var a = v > 0.62 ? (v - 0.62) * 1.6 : v < 0.34 ? (0.34 - v) * 0.7 : 0;
      var dark = v > 0.5;
      px[0] = px[1] = px[2] = dark ? 0 : 255; px[3] = clamp(a * 255 * (wet ? 1.5 : 1), 0, 120);
      return px;
    });
    T.patchesM = 90;
    // gravel (256 px covers 6 m)
    var nS = valueNoise(256, seed + 5, 3, 8, 0.5);
    T.sand = noiseCanvas(256, function (x, y, i) {
      var g = R(), v = (nS[i] - 0.5) * 0.2 + (g - 0.5) * 0.34;
      if (g > 0.93) v += 0.18;
      px[0] = clamp(sand[0] * (1 + v), 0, 255);
      px[1] = clamp(sand[1] * (1 + v * 0.95), 0, 255);
      px[2] = clamp(sand[2] * (1 + v * 0.85), 0, 255);
      px[3] = 255;
      return px;
    });
    T.sandM = 6;
    // run-off / pit tarmac (lighter, coarser)
    T.tarmac = noiseCanvas(256, function (x, y, i) {
      var v = (nS[i] - 0.5) * 0.12 + (R() - 0.5) * 0.12;
      var base = shade(theme.asphalt, 0.10);
      var b = hexToRgb(base);
      px[0] = clamp(b[0] * (1 + v), 0, 255); px[1] = clamp(b[1] * (1 + v), 0, 255); px[2] = clamp(b[2] * (1 + v), 0, 255);
      px[3] = 255;
      return px;
    });
    T.tarmacM = 10;
    // carbon weave (used on car roofs/wings) 32 px, 8 px weave
    T.carbon = noiseCanvas(32, function (x, y) {
      var cx = Math.floor(x / 4), cy = Math.floor(y / 4);
      var along = (cx + cy) % 2 === 0;
      var t = along ? (x % 4) / 4 : (y % 4) / 4;
      var v = 26 + Math.sin(t * PI) * 26;
      px[0] = v; px[1] = v; px[2] = v + 4; px[3] = 255;
      return px;
    });
    // mowing stripes: 2 x 1 px, scaled to 9 m bands
    T.mow = makeCanvas(2, 1);
    var mg = ctx2d(T.mow);
    if (mg) {
      mg.fillStyle = 'rgba(255,255,230,0.075)'; mg.fillRect(0, 0, 1, 1);
      mg.fillStyle = 'rgba(0,20,0,0.07)'; mg.fillRect(1, 0, 1, 1);
    }
    T.mowM = 9;
    T.asph = asph;
    T.street = street;
    return T;
  }

  /** Pattern from a texture, scaled so `metres` of world == the texture width, optional rotation. */
  function makePattern(ctx, tex, metres, rot) {
    if (!tex || !ctx.createPattern) return null;
    var p = ctx.createPattern(tex, 'repeat');
    if (!p) return null;
    if (p.setTransform && typeof DOMMatrix !== 'undefined') {
      var k = metres / tex.width;
      var m = new DOMMatrix();
      if (rot) m = m.rotate(rot * 180 / PI);
      m = m.scale(k, k);
      p.setTransform(m);
      return p;
    }
    return null;
  }

  /* ================================================================ geometry preparation */

  var FLAT_TYPES = { water: 1, rock: 1, bush: 1, tyres: 1, marshal: 1, tent: 1, cone: 1, barrier: 1 };
  var DEFAULT_THEME = {
    grass: '#4f7a34', asphalt: '#3a3c40', kerbA: '#d42a2a', kerbB: '#f4f4f4', sand: '#d2bd88', sky: '#8fb8e0',
    line: '#f5f5f0', wall: '#d8d8d8', barrier: '#9aa1a8', tree: '#2f5a2a', ground: null, accent: '#ff5a1f', night: false
  };

  function cellKey(ix, iy) { return (ix + 8192) * 16384 + (iy + 8192); }

  function makeBuckets() {
    var map = new Map();
    return {
      map: map,
      insertBox: function (id, x0, y0, x1, y1) {
        var ax = Math.floor(x0 / CELL), ay = Math.floor(y0 / CELL), bx = Math.floor(x1 / CELL), by = Math.floor(y1 / CELL);
        for (var ix = ax; ix <= bx; ix++) {
          for (var iy = ay; iy <= by; iy++) {
            var k = cellKey(ix, iy), arr = map.get(k);
            if (!arr) { arr = []; map.set(k, arr); }
            arr.push(id);
          }
        }
      },
      query: function (x0, y0, x1, y1, fn) {
        var ax = Math.floor(x0 / CELL), ay = Math.floor(y0 / CELL), bx = Math.floor(x1 / CELL), by = Math.floor(y1 / CELL);
        for (var ix = ax; ix <= bx; ix++) {
          for (var iy = ay; iy <= by; iy++) {
            var arr = map.get(cellKey(ix, iy));
            if (arr) for (var k = 0; k < arr.length; k++) fn(arr[k]);
          }
        }
      }
    };
  }

  function sampleXY(p) {
    if (Array.isArray(p)) return [num(p[0], 0), num(p[1], 0)];
    return [num(p && p.x, 0), num(p && p.y, 0)];
  }

  /**
   * Normalises a geometry object (tracks.build output, or anything centerline-like) into flat typed arrays
   * plus spatial buckets. Every field has a fallback so a fake/partial geometry still renders.
   */
  function prepGeom(geom, def) {
    geom = geom || {};
    def = def || geom.def || {};
    var raw = geom.samples || geom.centerline || geom.points || [];
    if ((!raw || raw.length < 3) && def.points) raw = def.points;
    var N = raw.length;
    if (N < 3) {
      // degenerate: synthesise a 400 m circle so nothing downstream explodes
      raw = []; N = 200;
      for (var q = 0; q < N; q++) raw.push([Math.cos(q / N * TAU) * 64, Math.sin(q / N * TAU) * 64]);
    }
    var baseW = num(def.width_m, num(geom.width_m, 12));
    var G = {
      N: N, def: def, geom: geom,
      cx: new Float64Array(N), cy: new Float64Array(N), hd: new Float64Array(N),
      nx: new Float64Array(N), ny: new Float64Array(N), tx: new Float64Array(N), ty: new Float64Array(N),
      hw: new Float32Array(N), kL: new Float32Array(N), kR: new Float32Array(N),
      sL: new Float32Array(N), sR: new Float32Array(N), wL: new Float32Array(N), wR: new Float32Array(N),
      curv: new Float32Array(N), s: new Float64Array(N), layer: new Uint8Array(N),
      rlx: new Float64Array(N), rly: new Float64Array(N), rubber: new Float32Array(N),
      tarL: new Uint8Array(N), tarR: new Uint8Array(N), noWall: new Uint8Array(N)
    };
    var i, p, xy;
    for (i = 0; i < N; i++) { xy = sampleXY(raw[i]); G.cx[i] = xy[0]; G.cy[i] = xy[1]; }
    var cum = 0;
    for (i = 0; i < N; i++) {
      p = raw[i];
      var a = mod(i - 1, N), b = (i + 1) % N;
      var h = p && typeof p.heading === 'number' ? p.heading : Math.atan2(G.cy[b] - G.cy[a], G.cx[b] - G.cx[a]);
      G.hd[i] = h; G.tx[i] = Math.cos(h); G.ty[i] = Math.sin(h); G.nx[i] = -G.ty[i]; G.ny[i] = G.tx[i];
      var hw = p && typeof p.hw === 'number' ? p.hw : (p && typeof p.width === 'number' ? p.width / 2 : baseW / 2);
      G.hw[i] = Math.max(1.5, hw);
      G.s[i] = p && typeof p.s === 'number' ? p.s : cum;
      cum += Math.hypot(G.cx[b] - G.cx[i], G.cy[b] - G.cy[i]);
    }
    G.length = num(geom.length, num(geom.length_m, cum));
    G.ds = num(geom.ds, G.length / N);
    var hasKerb = false, runoff = def.runoff || {};
    for (i = 0; i < N; i++) {
      p = raw[i] || {};
      var a2 = mod(i - 1, N), b2 = (i + 1) % N;
      G.curv[i] = typeof p.curvature === 'number' ? p.curvature : wrapAngle(G.hd[b2] - G.hd[a2]) / (2 * G.ds);
      G.kL[i] = num(p.leftKerb, 0); G.kR[i] = num(p.rightKerb, 0);
      if (G.kL[i] > 0 || G.kR[i] > 0) hasKerb = true;
      G.sL[i] = num(p.sandL, 0); G.sR[i] = num(p.sandR, 0);
      G.wL[i] = Math.max(G.hw[i] + 0.5, num(p.wallL, G.hw[i] + 9));
      G.wR[i] = Math.max(G.hw[i] + 0.5, num(p.wallR, G.hw[i] + 9));
      G.layer[i] = p.layer | 0;
      G.tarL[i] = (p.runoffL || runoff.left) === 'tarmac' ? 1 : 0;
      G.tarR[i] = (p.runoffR || runoff.right) === 'tarmac' ? 1 : 0;
    }
    if (!hasKerb && !(raw[0] && 'leftKerb' in raw[0])) {
      // fallback kerbs from curvature: inside of anything tighter than r = 180 m
      for (i = 0; i < N; i++) {
        var k = G.curv[i];
        if (Math.abs(k) > 1 / 180) { if (k > 0) G.kL[i] = 1.1; else G.kR[i] = 1.1; }
      }
    }
    // racing line
    var rlxy = geom.racingLineXY, rlo = geom.racingLine;
    for (i = 0; i < N; i++) {
      if (rlxy && rlxy[i]) { xy = sampleXY(rlxy[i]); G.rlx[i] = xy[0]; G.rly[i] = xy[1]; }
      else {
        var off = rlo && typeof rlo[i] === 'number' ? rlo[i] : num(raw[i] && raw[i].racingLine, 0);
        G.rlx[i] = G.cx[i] + G.nx[i] * off; G.rly[i] = G.cy[i] + G.ny[i] * off;
      }
    }
    // rubber weight: heavier on corner entries (braking) and apexes
    var look = Math.max(4, Math.round(36 / G.ds));
    for (i = 0; i < N; i++) {
      var kc = Math.abs(G.curv[i]), ahead = 0;
      for (var j = 4; j < look; j += 3) ahead = Math.max(ahead, Math.abs(G.curv[(i + j) % N]));
      var brakeZone = ahead > 0.012 && kc < ahead * 0.6 ? clamp01((ahead - 0.012) * 60) : 0;
      G.rubber[i] = clamp01(0.25 + kc * 30 + brakeZone * 0.7);
    }
    // walls removed around crossings (figure-8): the other road passes there
    var crossings = geom.crossings || [];
    crossings.forEach(function (cr) {
      [cr.indexA, cr.indexB].forEach(function (ci) {
        if (typeof ci !== 'number') return;
        var span = Math.round((G.hw[ci] * 2 + 26) / G.ds);
        for (var k2 = -span; k2 <= span; k2++) G.noWall[mod(ci + k2, N)] = 1;
      });
    });
    // bridge spans (layer 1 runs)
    G.bridges = [];
    var inRun = false, start = 0;
    for (i = 0; i <= N; i++) {
      var on = i < N && G.layer[i] === 1;
      if (on && !inRun) { inRun = true; start = i; }
      if (!on && inRun) { inRun = false; G.bridges.push({ a: start, b: i - 1 }); }
    }
    if (G.bridges.length > 1 && G.bridges[0].a === 0 && G.bridges[G.bridges.length - 1].b === N - 1) {
      var last = G.bridges.pop(); G.bridges[0] = { a: last.a, b: G.bridges[0].b + N };
    }
    // sample buckets + bounds
    G.sb = makeBuckets();
    var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (i = 0; i < N; i++) {
      var j1 = (i + 1) % N;
      var lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
      [[i, G.wL[i] + 1.5], [i, -G.wR[i] - 1.5], [j1, G.wL[j1] + 1.5], [j1, -G.wR[j1] - 1.5]].forEach(function (e) {
        var x = G.cx[e[0]] + G.nx[e[0]] * e[1], y = G.cy[e[0]] + G.ny[e[0]] * e[1];
        if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y;
      });
      G.sb.insertBox(i, lx0, ly0, lx1, ly1);
      if (lx0 < bx0) bx0 = lx0; if (lx1 > bx1) bx1 = lx1; if (ly0 < by0) by0 = ly0; if (ly1 > by1) by1 = ly1;
    }
    G.trackBounds = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    G.stamp = new Int32Array(N); G.stampId = 0;
    // scenery
    G.scenery = [];
    G.tall = [];
    G.lamps = [];
    G.scb = makeBuckets();
    G.tallb = makeBuckets();
    var sc = geom.scenery || [];
    for (i = 0; i < sc.length; i++) {
      var o = sc[i];
      if (!o || typeof o.x !== 'number') continue;
      var it = {
        id: i, type: o.type || 'building', shape: o.shape || (o.r && !o.l ? 'circle' : 'rect'),
        x: o.x, y: o.y, rot: num(o.rot, 0), l: num(o.l, (o.r || 2) * 2), w: num(o.w, (o.r || 2) * 2),
        r: num(o.r, 2), h: num(o.h, 3), s: num(o.s, 0), side: o.side || 1, lat: num(o.lat, 0),
        color: o.color, accent: o.accent, variant: o.variant, text: o.text, lit: !!o.lit, seats: o.seats,
        seed: hashStr((def.id || 't') + ':' + i)
      };
      if (it.type === 'building' && it.variant === 'parking') it.flat = true;
      if (it.type === 'building' && it.variant === 'yacht') it.flat = true;
      if (FLAT_TYPES[it.type]) it.flat = true;
      var ext = Math.max(it.l, it.w, it.r * 2) / 2 + 1;
      var shadowExt = it.type === 'water' ? 0 : it.h * 1.4;
      G.scb.insertBox(G.scenery.length, it.x - ext - shadowExt, it.y - ext - shadowExt, it.x + ext + shadowExt, it.y + ext + shadowExt);
      G.scenery.push(it);
      if (!it.flat) {
        var lean = Math.min(it.h, 80) * 0.6;
        G.tallb.insertBox(G.tall.length, it.x - ext - lean, it.y - ext - lean, it.x + ext + lean, it.y + ext + lean);
        G.tall.push(it);
      }
      if (it.type === 'lamp') G.lamps.push(it);
      if (ext + shadowExt > 0) {
        bx0 = Math.min(bx0, it.x - ext); by0 = Math.min(by0, it.y - ext); bx1 = Math.max(bx1, it.x + ext); by1 = Math.max(by1, it.y + ext);
      }
    }
    G.bounds = { x0: bx0 - 60, y0: by0 - 60, x1: bx1 + 60, y1: by1 + 60 };
    // track furniture synthesised by the renderer: sector boards + start gantry
    var sectors = geom.sectors || [];
    G.sectorIdx = [];
    sectors.forEach(function (sc2, si) {
      var idx = typeof sc2.startIndex === 'number' ? sc2.startIndex : Math.round(num(sc2.start, 0) / G.ds) % N;
      G.sectorIdx.push(idx);
      if (si === 0) return;
      var side = 1, lat = G.wL[idx] + 2.2;
      var item = {
        id: 'sector' + si, type: 'sectorboard', shape: 'rect', x: G.cx[idx] + G.nx[idx] * lat, y: G.cy[idx] + G.ny[idx] * lat,
        rot: G.hd[idx], l: 2.4, w: 0.3, r: 1.3, h: 3.2, s: G.s[idx], side: side, text: 'S' + (si + 1), seed: si
      };
      G.tallb.insertBox(G.tall.length, item.x - 5, item.y - 5, item.x + 5, item.y + 5);
      G.tall.push(item);
    });
    G.gantry = {
      i: Math.min(N - 1, Math.max(1, Math.round(6 / G.ds))),
      type: 'gantry'
    };
    var gi = G.gantry.i;
    G.gantry.x = G.cx[gi]; G.gantry.y = G.cy[gi]; G.gantry.h = 6.5;
    G.gantry.l = G.hw[gi] * 2 + 4;
    G.tallb.insertBox(G.tall.length, G.gantry.x - G.gantry.l, G.gantry.y - G.gantry.l, G.gantry.x + G.gantry.l, G.gantry.y + G.gantry.l);
    G.tall.push(G.gantry);
    // grid slots
    G.grid = (geom.gridSlots || geom.grid || []).filter(function (g) { return g && typeof g.x === 'number'; });
    if (!G.grid.length) {
      for (var gk = 0; gk < 16; gk++) {
        var sRel = -(7 + gk * 5.5), latG = (gk % 2 ? -1 : 1) * Math.min(3, G.hw[0] * 0.42);
        var pa = pointAt(G, sRel, latG);
        G.grid.push({ x: pa.x, y: pa.y, heading: pa.h, position: gk + 1 });
      }
    }
    // pit lane
    G.pits = null;
    for (i = 0; i < G.scenery.length; i++) if (G.scenery[i].type === 'pits') { G.pits = G.scenery[i]; break; }
    // TV camera points: every ~260 m, outside of the local bend, behind the barrier
    G.tvCams = [];
    var spacing = clamp(G.length / 12, 140, 300), ncam = Math.max(4, Math.round(G.length / spacing));
    for (var c = 0; c < ncam; c++) {
      var sc3 = (c + 0.5) * G.length / ncam, ii = Math.round(sc3 / G.ds) % N;
      var kAvg = 0;
      for (var d = -20; d <= 20; d++) kAvg += G.curv[mod(ii + d, N)];
      var side2 = kAvg > 0 ? -1 : 1;  // outside of the bend
      var dist = (side2 > 0 ? G.wL[ii] : G.wR[ii]) + 14;
      G.tvCams.push({ s: G.s[ii], i: ii, x: G.cx[ii] + G.nx[ii] * dist * side2, y: G.cy[ii] + G.ny[ii] * dist * side2, h: G.hd[ii], side: side2 });
    }
    return G;
  }

  function idxAtS(G, s) { return Math.round(mod(s, G.length) / G.ds) % G.N; }

  /** Interpolated centerline point at arc length s with lateral offset (+left). */
  function pointAt(G, s, lat) {
    var f = mod(s, G.length) / G.ds, i0 = Math.floor(f) % G.N, i1 = (i0 + 1) % G.N, t = f - Math.floor(f);
    var h = G.hd[i0] + wrapAngle(G.hd[i1] - G.hd[i0]) * t;
    var x = lerp(G.cx[i0], G.cx[i1], t), y = lerp(G.cy[i0], G.cy[i1], t);
    lat = lat || 0;
    return { x: x - Math.sin(h) * lat, y: y + Math.cos(h) * lat, h: h, i: t < 0.5 ? i0 : i1, hw: lerp(G.hw[i0], G.hw[i1], t) };
  }

  /** Sorted unique sample indices whose footprint intersects the rect, grouped into contiguous runs. */
  function sampleRuns(G, x0, y0, x1, y1) {
    var id = ++G.stampId, list = [];
    G.sb.query(x0, y0, x1, y1, function (i) { if (G.stamp[i] !== id) { G.stamp[i] = id; list.push(i); } });
    if (!list.length) return [];
    list.sort(function (a, b) { return a - b; });
    var runs = [], a = list[0], prev = list[0];
    for (var k = 1; k < list.length; k++) {
      if (list[k] !== prev + 1) { runs.push({ a: a, b: prev }); a = list[k]; }
      prev = list[k];
    }
    runs.push({ a: a, b: prev });
    var N = G.N;
    if (runs.length > 1 && runs[0].a === 0 && runs[runs.length - 1].b === N - 1) {
      var last = runs.pop(); runs[0] = { a: last.a, b: runs[0].b + N };
    }
    // pad each run so strips overlap cleanly
    for (k = 0; k < runs.length; k++) {
      var len = runs[k].b - runs[k].a;
      if (len >= N - 4) { runs[k] = { a: 0, b: N, closed: true }; continue; }
      runs[k].a -= 2; runs[k].b += 2;
    }
    return runs;
  }

  function ex(G, i, lat) { i = mod(i, G.N); return G.cx[i] + G.nx[i] * lat; }
  function ey(G, i, lat) { i = mod(i, G.N); return G.cy[i] + G.ny[i] * lat; }

  /* ================================================================ static world painter (tiles) */

  /** Polyline along one offset function over a run. */
  function tracePath(ctx, G, a, b, latFn, move) {
    for (var i = a; i <= b; i++) {
      var lat = latFn(mod(i, G.N));
      var x = ex(G, i, lat), y = ey(G, i, lat);
      if (i === a && move !== false) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  /** Closed band between two lateral offset functions. */
  function bandPath(ctx, G, a, b, inner, outer) {
    ctx.beginPath();
    tracePath(ctx, G, a, b, outer, true);
    for (var i = b; i >= a; i--) { var lat = inner(mod(i, G.N)); ctx.lineTo(ex(G, i, lat), ey(G, i, lat)); }
    ctx.closePath();
  }
  /** Sub-runs where a predicate holds (for kerbs, gravel, tarmac run-off). */
  function subRuns(G, a, b, pred) {
    var out = [], st = null;
    for (var i = a; i <= b + 1; i++) {
      var ok = i <= b && pred(mod(i, G.N));
      if (ok && st === null) st = i;
      if (!ok && st !== null) { out.push([st - 1, i]); st = null; }
    }
    return out;
  }

  function convexHull(pts) {
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], i;
    for (i = 0; i < pts.length; i++) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], pts[i]) <= 0) lo.pop(); lo.push(pts[i]); }
    for (i = pts.length - 1; i >= 0; i--) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], pts[i]) <= 0) up.pop(); up.push(pts[i]); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  function rectCorners(o, grow) {
    var c = Math.cos(o.rot), s = Math.sin(o.rot), hl = o.l / 2 + (grow || 0), hw = o.w / 2 + (grow || 0);
    return [[o.x + c * hl - s * hw, o.y + s * hl + c * hw], [o.x - c * hl - s * hw, o.y - s * hl + c * hw],
            [o.x - c * hl + s * hw, o.y - s * hl - c * hw], [o.x + c * hl + s * hw, o.y + s * hl - c * hw]];
  }
  function polyPath(ctx, pts) {
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) { if (i) ctx.lineTo(pts[i][0], pts[i][1]); else ctx.moveTo(pts[i][0], pts[i][1]); }
    ctx.closePath();
  }

  /**
   * Paints everything static that intersects `rect` (world metres). ctx transform maps world -> target pixels
   * (unflipped). ppm = target pixels per metre (drives level of detail).
   */
  function paintStatic(ctx, W, rect, ppm) {
    var G = W.G, th = W.theme, P = W.P, wet = W.wet, night = W.night;
    var x0 = rect.x0, y0 = rect.y0, x1 = rect.x1, y1 = rect.y1;
    var detail = ppm >= 5, fine = ppm >= 10;
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';

    // 1. ground ---------------------------------------------------------------
    ctx.fillStyle = W.groundColor; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    if (P.ground) { ctx.fillStyle = P.ground; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    if (!W.street && P.mow && ppm >= 1.4) { ctx.fillStyle = P.mow; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    if (!W.street && fine && P.blades) { ctx.fillStyle = P.blades; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    if (wet) { ctx.fillStyle = 'rgba(0,10,25,0.12)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }

    var runs = sampleRuns(G, x0 - 4, y0 - 4, x1 + 4, y1 + 4);
    var r, k;
    function hwF(i) { return G.hw[i]; }
    function edgeL(i) { return G.hw[i] + G.kL[i]; }
    function edgeR(i) { return -(G.hw[i] + G.kR[i]); }

    // 2. verge wear + tarmac run-off --------------------------------------------
    for (r = 0; r < runs.length; r++) {
      var A = runs[r].a, B = runs[r].b;
      if (!W.street && detail) {
        ctx.fillStyle = 'rgba(40,30,10,0.10)';
        bandPath(ctx, G, A, B, edgeL, function (i) { return G.hw[i] + G.kL[i] + 1.6; }); ctx.fill();
        bandPath(ctx, G, A, B, function (i) { return -(G.hw[i] + G.kR[i] + 1.6); }, edgeR); ctx.fill();
      }
      ctx.fillStyle = P.tarmac || shade(th.asphalt, 0.1);
      subRuns(G, A, B, function (i) { return G.tarL[i]; }).forEach(function (sr) {
        bandPath(ctx, G, sr[0], sr[1], function (i) { return G.hw[i] - 0.1; }, function (i) { return G.wL[i] + 0.2; }); ctx.fill();
      });
      subRuns(G, A, B, function (i) { return G.tarR[i]; }).forEach(function (sr) {
        bandPath(ctx, G, sr[0], sr[1], function (i) { return -(G.wR[i] + 0.2); }, function (i) { return -(G.hw[i] - 0.1); }); ctx.fill();
      });
    }

    // 3. gravel traps -------------------------------------------------------------
    for (r = 0; r < runs.length; r++) {
      var A3 = runs[r].a, B3 = runs[r].b;
      [1, -1].forEach(function (sd) {
        var sArr = sd > 0 ? G.sL : G.sR, kArr = sd > 0 ? G.kL : G.kR;
        subRuns(G, A3, B3, function (i) { return sArr[i] > 0.15; }).forEach(function (sr) {
          var inner = function (i) { return sd * (G.hw[i] + kArr[i] + 0.6); };
          var outer = function (i) { return sd * (G.hw[i] + kArr[i] + 0.6 + sArr[i]); };
          // rim (darker, slightly larger) then gravel
          ctx.fillStyle = shade(th.sand, -0.22);
          bandPath(ctx, G, sr[0], sr[1], function (i) { return inner(i) - sd * 0.15; }, function (i) { return outer(i) + sd * 0.35; }); ctx.fill();
          ctx.fillStyle = P.sand || th.sand;
          bandPath(ctx, G, sr[0], sr[1], inner, outer); ctx.fill();
          if (detail) {
            // raked lines in the gravel
            ctx.strokeStyle = 'rgba(255,250,235,0.10)'; ctx.lineWidth = 0.18;
            for (var f = 0.25; f < 1; f += 0.25) {
              ctx.beginPath();
              tracePath(ctx, G, sr[0] + 1, sr[1] - 1, function (i) { return lerp(inner(i), outer(i), f); });
              ctx.stroke();
            }
          }
        });
      });
    }

    // 4. asphalt --------------------------------------------------------------------
    for (r = 0; r < runs.length; r++) {
      var A4 = runs[r].a, B4 = runs[r].b;
      bandPath(ctx, G, A4, B4, function (i) { return -G.hw[i] - 0.05; }, function (i) { return G.hw[i] + 0.05; });
      ctx.fillStyle = W.asphaltColor; ctx.fill();
      if (P.patches && ppm >= 1.4) { ctx.fillStyle = P.patches; ctx.fill(); }
      if (P.grain && detail) { ctx.fillStyle = P.grain; ctx.fill(); }
      if (wet) {
        ctx.fillStyle = 'rgba(20,35,60,0.20)'; ctx.fill();
      }
    }

    // 5. rubbered racing line --------------------------------------------------------
    if (ppm >= 1.4) {
      var bins = [[], [], []];
      for (r = 0; r < runs.length; r++) {
        for (k = runs[r].a; k < runs[r].b; k++) {
          var i5 = mod(k, G.N), w5 = G.rubber[i5];
          bins[w5 > 0.7 ? 2 : w5 > 0.45 ? 1 : 0].push(i5);
        }
      }
      var rubberAlpha = wet ? [0.05, 0.08, 0.11] : [0.07, 0.12, 0.18];
      ctx.lineCap = 'round';
      for (var bi = 0; bi < 3; bi++) {
        if (!bins[bi].length) continue;
        ctx.beginPath();
        for (k = 0; k < bins[bi].length; k++) {
          var ia = bins[bi][k], ib = (ia + 1) % G.N;
          ctx.moveTo(G.rlx[ia], G.rly[ia]); ctx.lineTo(G.rlx[ib], G.rly[ib]);
        }
        ctx.strokeStyle = 'rgba(8,8,10,' + rubberAlpha[bi] + ')'; ctx.lineWidth = 2.8; ctx.stroke();
        ctx.strokeStyle = 'rgba(8,8,10,' + rubberAlpha[bi] * 0.9 + ')'; ctx.lineWidth = 1.3; ctx.stroke();
        if (wet) { ctx.strokeStyle = 'rgba(120,150,190,0.05)'; ctx.lineWidth = 0.6; ctx.stroke(); }
      }
      ctx.lineCap = 'butt';
    }

    // 6. kerbs ------------------------------------------------------------------------
    for (r = 0; r < runs.length; r++) paintKerbs(ctx, W, runs[r].a, runs[r].b, detail);

    // 7. edge lines -----------------------------------------------------------------
    if (ppm >= 1.4) {
      ctx.strokeStyle = rgba(th.line || '#ffffff', wet ? 0.75 : 0.92); ctx.lineWidth = Math.max(0.2, 0.9 / ppm);
      for (r = 0; r < runs.length; r++) {
        ctx.beginPath(); tracePath(ctx, G, runs[r].a, runs[r].b, function (i) { return G.hw[i] - 0.32; }); ctx.stroke();
        ctx.beginPath(); tracePath(ctx, G, runs[r].a, runs[r].b, function (i) { return -G.hw[i] + 0.32; }); ctx.stroke();
      }
    }

    // 8. markings: start/finish, grid, pit lane -----------------------------------------
    if (ppm >= 1.4) {
      paintPitLane(ctx, W, rect, ppm);
      paintStartAndGrid(ctx, W, rect, ppm);
    }

    // 9. walls & barriers -----------------------------------------------------------------
    for (r = 0; r < runs.length; r++) paintWalls(ctx, W, runs[r].a, runs[r].b, ppm);

    // 10. scenery shadows + flat scenery ------------------------------------------------------
    paintSceneryStatic(ctx, W, rect, ppm);

    // 11. bridge shadow on whatever lies below -----------------------------------------------
    if (G.bridges.length) {
      ctx.fillStyle = 'rgba(0,0,15,' + (night ? 0.25 : 0.38) + ')';
      G.bridges.forEach(function (br) {
        ctx.save();
        ctx.translate(W.sun.x * 5, W.sun.y * 5);
        bandPath(ctx, G, br.a, br.b, function (i) { return -G.hw[i] - 1.4; }, function (i) { return G.hw[i] + 1.4; });
        ctx.fill();
        ctx.restore();
      });
    }
  }

  function paintKerbs(ctx, W, a, b, detail) {
    var G = W.G, th = W.theme;
    var colA = th.kerbA || '#d42a2a', colB = th.kerbB || '#f4f4f4';
    var block = 1.0;                                      // metres per colour block
    var sub = Math.max(1, Math.round(G.ds / block));
    [1, -1].forEach(function (sd) {
      var kArr = sd > 0 ? G.kL : G.kR;
      var runs = subRuns(G, a, b, function (i) { return kArr[i] > 0.05; });
      runs.forEach(function (sr) {
        var paths = [[], []];
        for (var k = sr[0]; k < sr[1]; k++) {
          var i0 = mod(k, G.N), i1 = mod(k + 1, G.N);
          var kw0 = kArr[i0], kw1 = kArr[i1];
          if (kw0 < 0.05 && kw1 < 0.05) continue;
          var sharp = Math.abs(G.curv[i0]) > 1 / 90;
          for (var q = 0; q < sub; q++) {
            var t0 = q / sub, t1 = (q + 1) / sub;
            var kwa = lerp(kw0, kw1, t0), kwb = lerp(kw0, kw1, t1);
            var hwa = lerp(G.hw[i0], G.hw[i1], t0), hwb = lerp(G.hw[i0], G.hw[i1], t1);
            var skew = 0.28 / G.ds;
            var pIa = lp(G, i0, i1, t0 + skew, sd * (hwa - 0.04)), pIb = lp(G, i0, i1, t1 + skew, sd * (hwb - 0.04));
            var pOa = lp(G, i0, i1, t0, sd * (hwa + kwa)), pOb = lp(G, i0, i1, t1, sd * (hwb + kwb));
            var colIdx = (k * sub + q) & 1;
            var pts = [pIa, pIb, pOb];
            if (sharp && detail) {
              // sawtooth teeth on the outer edge through tight corners
              var mid = lp(G, i0, i1, (t0 + t1) / 2, sd * ((hwa + hwb) / 2 + (kwa + kwb) / 2 + 0.32));
              pts.push(mid);
            }
            pts.push(pOa);
            paths[colIdx].push(pts);
          }
        }
        for (var c = 0; c < 2; c++) {
          ctx.fillStyle = c ? colB : colA;
          ctx.beginPath();
          paths[c].forEach(function (pts) {
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (var m = 1; m < pts.length; m++) ctx.lineTo(pts[m][0], pts[m][1]);
            ctx.closePath();
          });
          ctx.fill();
        }
        if (detail) {
          // outer shadow lip + inner highlight (raised kerb profile)
          ctx.lineWidth = 0.14;
          ctx.strokeStyle = 'rgba(0,0,0,0.28)';
          ctx.beginPath(); tracePath(ctx, G, sr[0], sr[1], function (i) { return sd * (G.hw[i] + kArr[i] + 0.05); }); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.08;
          ctx.beginPath(); tracePath(ctx, G, sr[0], sr[1], function (i) { return sd * (G.hw[i] + kArr[i] * 0.45); }); ctx.stroke();
        }
      });
    });
  }
  /** Interpolated point between samples i0 and i1 at t (may exceed 1 slightly) with lateral offset. */
  function lp(G, i0, i1, t, lat) {
    var x = lerp(G.cx[i0], G.cx[i1], t), y = lerp(G.cy[i0], G.cy[i1], t);
    var nx = lerp(G.nx[i0], G.nx[i1], t), ny = lerp(G.ny[i0], G.ny[i1], t);
    return [x + nx * lat, y + ny * lat];
  }

  var WALL_STYLE = {
    concrete: { w: 0.62, h: 1.1, fence: 3.5 },
    armco: { w: 0.34, h: 0.75, posts: 2 },
    guardrail: { w: 0.30, h: 0.8, posts: 2, reflectors: 8 },
    safer: { w: 0.85, h: 1.25, fence: 4.5 },
    tyres: { w: 0.9, h: 0.8 }
  };

  function paintWalls(ctx, W, a, b, ppm) {
    var G = W.G, th = W.theme, type = W.wallType, st = WALL_STYLE[type] || WALL_STYLE.armco;
    var sun = W.sun;
    [1, -1].forEach(function (sd) {
      var wArr = sd > 0 ? G.wL : G.wR;
      var segs = subRuns(G, a, b, function (i) { return !G.noWall[i]; });
      segs.forEach(function (sr) {
        var A = sr[0] + 1, B = sr[1] - 1;
        if (B <= A) return;
        var latF = function (i) { return sd * (wArr[i] + st.w / 2); };
        ctx.lineCap = 'round';
        // shadow
        ctx.save();
        ctx.translate(sun.x * st.h, sun.y * st.h);
        ctx.strokeStyle = 'rgba(0,0,12,' + (W.night ? 0.18 : 0.32) + ')'; ctx.lineWidth = st.w + 0.2;
        ctx.beginPath(); tracePath(ctx, G, A, B, latF); ctx.stroke();
        if (st.fence && ppm >= 3) {
          ctx.translate(sun.x * (st.fence - st.h), sun.y * (st.fence - st.h));
          ctx.strokeStyle = 'rgba(0,0,12,0.10)'; ctx.lineWidth = 0.12;
          ctx.beginPath(); tracePath(ctx, G, A, B, latF); ctx.stroke();
        }
        ctx.restore();
        if (type === 'tyres' && ppm >= 3) {
          paintTyreWall(ctx, G, A, B, latF, th);
        } else {
          ctx.strokeStyle = type === 'concrete' ? shade(th.wall || '#ccc', -0.25) : type === 'safer' ? '#8c9096' : shade(th.barrier || '#9aa1a8', -0.35);
          ctx.lineWidth = st.w + 0.12;
          ctx.beginPath(); tracePath(ctx, G, A, B, latF); ctx.stroke();
          ctx.strokeStyle = type === 'concrete' ? (th.wall || '#d8d8d8') : type === 'safer' ? '#f4f4f2' : (th.barrier || '#a8afb6');
          ctx.lineWidth = st.w;
          ctx.stroke();
          if (ppm >= 4) {
            // top highlight + inner dark edge (bevel)
            ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = st.w * 0.25;
            ctx.beginPath(); tracePath(ctx, G, A, B, function (i) { return sd * (wArr[i] + st.w * 0.3); }); ctx.stroke();
            if (type === 'safer') {
              ctx.strokeStyle = 'rgba(30,60,140,0.65)'; ctx.lineWidth = 0.12;
              ctx.beginPath(); tracePath(ctx, G, A, B, function (i) { return sd * (wArr[i] + 0.12); }); ctx.stroke();
            }
            if (type === 'armco' || type === 'guardrail') {
              ctx.strokeStyle = 'rgba(40,44,50,0.55)'; ctx.lineWidth = 0.06;
              ctx.beginPath(); tracePath(ctx, G, A, B, function (i) { return sd * (wArr[i] + st.w * 0.5); }); ctx.stroke();
            }
          }
          if (st.posts && ppm >= 6) {
            ctx.fillStyle = '#4b4f55';
            for (var i = A; i <= B; i += st.posts) {
              var lat = sd * (wArr[mod(i, G.N)] + st.w + 0.12);
              ctx.fillRect(ex(G, i, lat) - 0.09, ey(G, i, lat) - 0.09, 0.18, 0.18);
            }
          }
          if (st.reflectors && ppm >= 6) {
            for (var j = A; j <= B; j += st.reflectors) {
              var latr = sd * (wArr[mod(j, G.N)] + 0.05);
              ctx.fillStyle = sd > 0 ? '#ffd000' : '#ff3b30';
              ctx.fillRect(ex(G, j, latr) - 0.12, ey(G, j, latr) - 0.12, 0.24, 0.24);
            }
          }
          if (st.fence && ppm >= 5) {
            // catch-fence posts
            ctx.fillStyle = 'rgba(60,64,70,0.9)';
            for (var f = A; f <= B; f += 2) {
              var latf = sd * (wArr[mod(f, G.N)] + st.w + 0.15);
              ctx.beginPath(); ctx.arc(ex(G, f, latf), ey(G, f, latf), 0.08, 0, TAU); ctx.fill();
            }
            ctx.strokeStyle = 'rgba(70,74,80,0.35)'; ctx.lineWidth = 0.04;
            ctx.beginPath(); tracePath(ctx, G, A, B, function (i) { return sd * (wArr[i] + st.w + 0.15); }); ctx.stroke();
          }
        }
        ctx.lineCap = 'butt';
      });
    });
  }

  function paintTyreWall(ctx, G, A, B, latF, th) {
    // rows of stacked tyres, conveyor-belt front, coloured bands every few metres
    var acc = 0, n = 0;
    var cols = ['#141414', '#1a1a1a', '#101010'];
    for (var i = A; i < B; i++) {
      var i0 = mod(i, G.N), i1 = mod(i + 1, G.N);
      var x0 = ex(G, i, latF(i0)), y0 = ey(G, i, latF(i0)), x1 = ex(G, i + 1, latF(i1)), y1 = ey(G, i + 1, latF(i1));
      var d = Math.hypot(x1 - x0, y1 - y0);
      for (var t = acc; t < d; t += 0.62) {
        var f = t / d, x = lerp(x0, x1, f), y = lerp(y0, y1, f);
        var band = Math.floor(n / 6) % 3 === 2;
        ctx.fillStyle = band ? (n % 2 ? (th.kerbA || '#d42a2a') : '#f2f2f2') : cols[n % 3];
        ctx.beginPath(); ctx.arc(x, y, 0.3, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.arc(x, y, 0.13, 0, TAU); ctx.fill();
        n++;
        acc = t + 0.62 - d;
      }
      if (acc < 0) acc = 0;
    }
    // belt
    ctx.strokeStyle = 'rgba(25,25,28,0.85)'; ctx.lineWidth = 0.12;
    ctx.beginPath(); tracePath(ctx, G, A, B, function (i) { var l = latF(i); return l - Math.sign(l) * 0.36; }); ctx.stroke();
  }

  function paintStartAndGrid(ctx, W, rect, ppm) {
    var G = W.G, th = W.theme;
    // start/finish line (sample 0)
    var sx = G.cx[0], sy = G.cy[0];
    if (sx > rect.x0 - 30 && sx < rect.x1 + 30 && sy > rect.y0 - 30 && sy < rect.y1 + 30) {
      var tx = G.tx[0], ty = G.ty[0], nx = G.nx[0], ny = G.ny[0], hw = G.hw[0];
      var sq = 0.5, cols = Math.max(2, Math.round(hw * 2 / sq));
      var step = hw * 2 / cols;
      for (var row = 0; row < 3; row++) {
        for (var c = 0; c < cols; c++) {
          ctx.fillStyle = (row + c) % 2 ? '#111111' : '#f6f6f6';
          var lat = -hw + c * step, along = -0.75 + row * sq;
          ctx.beginPath();
          ctx.moveTo(sx + tx * along + nx * lat, sy + ty * along + ny * lat);
          ctx.lineTo(sx + tx * (along + sq) + nx * lat, sy + ty * (along + sq) + ny * lat);
          ctx.lineTo(sx + tx * (along + sq) + nx * (lat + step), sy + ty * (along + sq) + ny * (lat + step));
          ctx.lineTo(sx + tx * along + nx * (lat + step), sy + ty * along + ny * (lat + step));
          ctx.closePath(); ctx.fill();
        }
      }
      // painted track name ahead of the line
      if (ppm >= 3) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        var nm = String((W.def && (W.def.short || W.def.name)) || 'REDLINE').toUpperCase();
        var ax = sx + tx * 16, ay = sy + ty * 16;
        worldText(ctx, nm.slice(0, 18), ax, ay, G.hd[0] - HALF_PI, Math.min(2.6, hw * 2 / Math.max(4, nm.length) * 1.4), '900');
      }
    }
    // grid boxes
    if (ppm < 3) return;
    ctx.lineCap = 'butt';
    for (var k = 0; k < G.grid.length; k++) {
      var g = G.grid[k];
      if (g.x < rect.x0 - 10 || g.x > rect.x1 + 10 || g.y < rect.y0 - 10 || g.y > rect.y1 + 10) continue;
      var h = num(g.heading, G.hd[0]), ct = Math.cos(h), st = Math.sin(h), cn = -st, sn = ct;
      var fx = g.x + ct * 2.7, fy = g.y + st * 2.7, half = 1.45;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.18;
      ctx.beginPath();
      ctx.moveTo(fx + cn * half - ct * 1.3, fy + sn * half - st * 1.3);
      ctx.lineTo(fx + cn * half, fy + sn * half);
      ctx.lineTo(fx - cn * half, fy - sn * half);
      ctx.lineTo(fx - cn * half - ct * 1.3, fy - sn * half - st * 1.3);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      worldText(ctx, String(g.position || k + 1), g.x + ct * 3.9, g.y + st * 3.9, h - HALF_PI, 0.95, '800');
    }
  }

  function paintPitLane(ctx, W, rect, ppm) {
    var G = W.G, pit = G.pits;
    if (!pit) return;
    var sd = pit.side || (pit.lat >= 0 ? 1 : -1);
    var len = pit.l, s0 = pit.s - len / 2 - 35, s1 = pit.s + len / 2 + 35;
    var bx = pit.x, by = pit.y, ext = len / 2 + 60;
    if (bx + ext < rect.x0 || bx - ext > rect.x1 || by + ext < rect.y0 || by - ext > rect.y1) return;
    var buildingInner = Math.abs(pit.lat) - pit.w / 2 - 0.2;
    var step = G.ds;
    function wall(s) { var i = idxAtS(G, s); return (sd > 0 ? G.wL[i] : G.wR[i]) + 0.9; }
    var innerAt = function (s) { return wall(s); };
    var outerAt = function (s) {
      var full = Math.max(wall(s) + 3, buildingInner);
      var f = smoothstep(Math.min((s - s0) / 30, (s1 - s) / 30));
      return lerp(wall(s) + 0.2, full, f);
    };
    // lane surface
    ctx.beginPath();
    var s, p, first = true;
    for (s = s0; s <= s1; s += step) { p = pointAt(G, s, sd * outerAt(s)); if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y); }
    for (s = s1; s >= s0; s -= step) { p = pointAt(G, s, sd * innerAt(s)); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    ctx.fillStyle = W.P.tarmac || shade(W.theme.asphalt, 0.08); ctx.fill();
    if (W.wet) { ctx.fillStyle = 'rgba(20,35,60,0.18)'; ctx.fill(); }
    if (ppm < 3) return;
    // pit wall side line, dashed fast-lane line, garage boxes
    function line(latFn, dash, color, w) {
      ctx.strokeStyle = color; ctx.lineWidth = w;
      if (dash && ctx.setLineDash) ctx.setLineDash(dash);
      ctx.beginPath(); var f2 = true;
      for (var ss = s0 + 30; ss <= s1 - 30; ss += step) { var q = pointAt(G, ss, sd * latFn(ss)); if (f2) { ctx.moveTo(q.x, q.y); f2 = false; } else ctx.lineTo(q.x, q.y); }
      ctx.stroke();
      if (dash && ctx.setLineDash) ctx.setLineDash([]);
    }
    line(function (ss) { return innerAt(ss) + 0.3; }, null, 'rgba(255,255,255,0.85)', 0.15);
    line(function (ss) { return lerp(innerAt(ss), outerAt(ss), 0.55); }, [2.2, 2.2], 'rgba(255,255,255,0.6)', 0.14);
    var garages = Math.max(1, Math.floor(len / 12));
    var accent = pit.accent || W.theme.accent || '#ff5a1f';
    for (var g = 0; g < garages; g++) {
      var sg = pit.s - len / 2 + (g + 0.5) * (len / garages);
      var a1 = pointAt(G, sg - 4.2, sd * (outerAt(sg) - 0.4)), a2 = pointAt(G, sg + 4.2, sd * (outerAt(sg) - 0.4));
      var b1 = pointAt(G, sg - 4.2, sd * (lerp(innerAt(sg), outerAt(sg), 0.6))), b2 = pointAt(G, sg + 4.2, sd * (lerp(innerAt(sg), outerAt(sg), 0.6)));
      ctx.fillStyle = g % 2 ? rgba(accent, 0.22) : 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(b1.x, b1.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,214,0,0.75)'; ctx.lineWidth = 0.12; ctx.stroke();
    }
    // PIT and speed limit lettering at entry/exit
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    [s0 + 34, s1 - 34].forEach(function (sl, n) {
      var q = pointAt(G, sl, sd * lerp(innerAt(sl), outerAt(sl), 0.5));
      worldText(ctx, n ? 'PIT OUT' : 'PIT', q.x, q.y, q.h - HALF_PI, 0.9, '900');
      var q2 = pointAt(G, sl + (n ? -8 : 8), sd * lerp(innerAt(sl), outerAt(sl), 0.5));
      ctx.strokeStyle = '#e11'; ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.arc(q2.x, q2.y, 0.95, 0, TAU); ctx.stroke();
      worldText(ctx, '60', q2.x, q2.y, q2.h - HALF_PI, 0.8, '900');
    });
  }

  /* ---------------------------------------------------------------- flat scenery + baked shadows */

  function paintSceneryStatic(ctx, W, rect, ppm) {
    var G = W.G, sun = W.sun, night = W.night;
    var list = [], seen = {};
    G.scb.query(rect.x0, rect.y0, rect.x1, rect.y1, function (id) { if (!seen[id]) { seen[id] = 1; list.push(G.scenery[id]); } });
    if (!list.length) return;
    list.sort(function (a, b) { return a.id - b.id; });
    var shadowA = night ? 0.14 : W.dusk ? 0.30 : 0.34;
    var shadowCol = 'rgba(5,10,25,' + shadowA + ')';
    // water: rims then bodies then ripples (so overlapping circles merge into one shoreline)
    var water = list.filter(function (o) { return o.type === 'water'; });
    if (water.length) {
      water.forEach(function (o) {
        var bay = o.variant === 'bay' || o.variant === 'harbour';
        ctx.fillStyle = bay ? '#8d9096' : shade(W.theme.sand, -0.05);
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r + (bay ? 1.2 : 1.8), 0, TAU); ctx.fill();
      });
      water.forEach(function (o) {
        var col = o.color || '#3f7fb3';
        var g = ctx.createRadialGradient(o.x, o.y, o.r * 0.1, o.x, o.y, o.r);
        g.addColorStop(0, shade(col, -0.25)); g.addColorStop(0.8, col); g.addColorStop(1, shade(col, 0.18));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
      });
      if (ppm >= 3) {
        water.forEach(function (o) {
          var R = rng(o.seed);
          ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 0.15;
          for (var k = 0; k < 7; k++) {
            var a = R() * TAU, d = R() * o.r * 0.8, x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d, l = 1 + R() * 3;
            ctx.beginPath(); ctx.moveTo(x - l, y); ctx.quadraticCurveTo(x, y + 0.4, x + l, y); ctx.stroke();
          }
        });
      }
    }
    // shadows of everything with height
    ctx.fillStyle = shadowCol; ctx.strokeStyle = shadowCol;
    list.forEach(function (o) {
      if (o.type === 'water' || o.h < 0.3) return;
      var h = Math.min(o.h, 60), dx = sun.x * h, dy = sun.y * h;
      if (o.type === 'tree') {
        var hc = h * 0.75;
        ctx.lineCap = 'round'; ctx.lineWidth = 0.35;
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + sun.x * hc, o.y + sun.y * hc); ctx.stroke();
        ctx.beginPath(); ctx.ellipse ? ctx.ellipse(o.x + sun.x * hc, o.y + sun.y * hc, o.r * 1.05, o.r * 0.9, Math.atan2(sun.y, sun.x), 0, TAU) : ctx.arc(o.x + sun.x * hc, o.y + sun.y * hc, o.r, 0, TAU);
        ctx.fill();
      } else if (o.type === 'lamp') {
        ctx.lineCap = 'round'; ctx.lineWidth = 0.28;
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + dx, o.y + dy); ctx.stroke();
        ctx.beginPath(); ctx.arc(o.x + dx, o.y + dy, o.variant === 'stadium' ? 1.6 : 0.6, 0, TAU); ctx.fill();
      } else if (o.shape === 'circle') {
        ctx.beginPath(); ctx.arc(o.x + dx * 0.5, o.y + dy * 0.5, o.r * 0.95, 0, TAU); ctx.fill();
      } else if (o.type === 'tower' && o.variant === 'observation-wheel') {
        ctx.lineWidth = 0.8; ctx.lineCap = 'round';
        var c = Math.cos(o.rot), s = Math.sin(o.rot), R2 = Math.min(o.h * 0.45, 70);
        ctx.beginPath();
        for (var a2 = 0; a2 <= 32; a2++) {
          var t = a2 / 32 * TAU, u = Math.cos(t) * R2, z = R2 + 4 + Math.sin(t) * R2;
          var px = o.x + c * u + sun.x * z, py = o.y + s * u + sun.y * z;
          if (a2) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.stroke();
      } else {
        var cs = rectCorners(o);
        var pts = cs.concat(cs.map(function (p) { return [p[0] + dx, p[1] + dy]; }));
        polyPath(ctx, convexHull(pts)); ctx.fill();
      }
    });
    ctx.lineCap = 'butt';
    // flat bodies
    list.forEach(function (o) {
      switch (o.type) {
        case 'rock': drawRock(ctx, o); break;
        case 'bush': drawBush(ctx, o, W); break;
        case 'tyres': drawTyreStack(ctx, o, W, ppm); break;
        case 'marshal': drawMarshal(ctx, o, W, ppm); break;
        case 'tent': drawTent(ctx, o); break;
        case 'cone': ctx.fillStyle = '#ff6a00'; ctx.beginPath(); ctx.arc(o.x, o.y, Math.max(0.3, o.r * 0.6), 0, TAU); ctx.fill(); break;
        case 'barrier': ctx.fillStyle = '#cfd2d6'; polyPath(ctx, rectCorners(o)); ctx.fill(); break;
        case 'building':
          if (o.variant === 'parking') drawParking(ctx, o, ppm);
          else if (o.variant === 'yacht') drawYacht(ctx, o);
          break;
      }
    });
  }

  function drawRock(ctx, o) {
    var R = rng(o.seed), n = 7 + (o.seed % 4), pts = [];
    for (var k = 0; k < n; k++) { var a = k / n * TAU, d = o.r * (0.7 + R() * 0.35); pts.push([o.x + Math.cos(a) * d, o.y + Math.sin(a) * d]); }
    var g = ctx.createLinearGradient(o.x - o.r, o.y + o.r, o.x + o.r, o.y - o.r);
    g.addColorStop(0, '#a7a49d'); g.addColorStop(1, '#5d5b56');
    ctx.fillStyle = g; polyPath(ctx, pts); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.08; ctx.stroke();
  }
  function drawBush(ctx, o, W) {
    var R = rng(o.seed), base = o.color || W.theme.tree || '#2f5a2a';
    for (var k = 0; k < 5; k++) {
      var a = R() * TAU, d = R() * o.r * 0.5, rr = o.r * (0.45 + R() * 0.3);
      ctx.fillStyle = shade(base, (R() - 0.5) * 0.3);
      ctx.beginPath(); ctx.arc(o.x + Math.cos(a) * d, o.y + Math.sin(a) * d, rr, 0, TAU); ctx.fill();
    }
  }
  function drawTyreStack(ctx, o, W, ppm) {
    var c = Math.cos(o.rot), s = Math.sin(o.rot), rows = Math.max(1, Math.round(o.w / 0.66));
    var n = Math.max(1, Math.round(o.l / 0.64)), band = o.color || W.theme.kerbA || '#d42a2a';
    for (var r = 0; r < rows; r++) {
      var v = (r - (rows - 1) / 2) * 0.64;
      for (var k = 0; k < n; k++) {
        var u = (k - (n - 1) / 2) * 0.64 + (r % 2) * 0.32;
        var x = o.x + c * u - s * v, y = o.y + s * u + c * v;
        ctx.fillStyle = (Math.floor(k / 4) % 3 === 0 && r === 0) ? (k % 2 ? band : '#f4f4f4') : '#151515';
        ctx.beginPath(); ctx.arc(x, y, 0.31, 0, TAU); ctx.fill();
        if (ppm >= 6) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.arc(x, y, 0.14, 0, TAU); ctx.fill(); }
      }
    }
  }
  function drawMarshal(ctx, o, W, ppm) {
    var cs = rectCorners(o);
    ctx.fillStyle = '#f26b1d'; polyPath(ctx, cs); ctx.fill();
    ctx.fillStyle = '#f7f7f7'; polyPath(ctx, rectCorners({ x: o.x, y: o.y, rot: o.rot, l: o.l * 0.7, w: o.w * 0.7 })); ctx.fill();
    if (ppm >= 6 && o.text) { ctx.fillStyle = '#222'; worldText(ctx, o.text, o.x, o.y, o.rot, 0.9, '900'); }
  }
  function drawTent(ctx, o) {
    var cs = rectCorners(o), col = o.color || '#ffffff';
    var shades = [0.12, -0.06, -0.22, 0.02];
    for (var k = 0; k < 4; k++) {
      var a = cs[k], b = cs[(k + 1) % 4];
      ctx.fillStyle = shade(col, shades[k]);
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 0.08; polyPath(ctx, cs); ctx.stroke();
  }
  function drawParking(ctx, o, ppm) {
    var cs = rectCorners(o), R = rng(o.seed);
    ctx.fillStyle = o.color || '#55585c'; polyPath(ctx, cs); ctx.fill();
    if (ppm < 3) return;
    var c = Math.cos(o.rot), s = Math.sin(o.rot);
    var bays = Math.floor(o.l / 2.6), rowsY = [-o.w / 2 + 2.6, o.w / 2 - 2.6];
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.1;
    var palette = ['#c0c4c8', '#1d1d1f', '#8b0f14', '#f2f2f2', '#2b4a7a', '#4a4f55', '#c9a227'];
    rowsY.forEach(function (vy, ri) {
      for (var b = 0; b <= bays; b++) {
        var u = -o.l / 2 + 0.6 + b * 2.6;
        ctx.beginPath();
        ctx.moveTo(o.x + c * u - s * (vy - 2.5 * (ri ? -1 : 1) * 0), o.y + s * u + c * vy);
        var v2 = vy + (ri ? 2.4 : -2.4);
        ctx.moveTo(o.x + c * u - s * vy, o.y + s * u + c * vy);
        ctx.lineTo(o.x + c * u - s * v2, o.y + s * u + c * v2);
        ctx.stroke();
        if (b < bays && R() < 0.6) {
          var cu = u + 1.3, cv = vy + (ri ? 1.2 : -1.2);
          ctx.save(); ctx.translate(o.x + c * cu - s * cv, o.y + s * cu + c * cv); ctx.rotate(o.rot + HALF_PI);
          ctx.fillStyle = R.pick(palette); ctx.beginPath(); roundRectPath(ctx, -2.1, -0.88, 4.2, 1.76, 0.5); ctx.fill();
          ctx.fillStyle = 'rgba(20,30,40,0.7)'; ctx.fillRect(0.2, -0.7, 0.9, 1.4); ctx.fillRect(-1.5, -0.65, 0.6, 1.3);
          ctx.restore();
        }
      }
    });
  }
  function drawYacht(ctx, o) {
    ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
    var L = o.l, B = o.w;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(-L / 2 - 4, -B * 0.6); ctx.lineTo(-L / 2, 0); ctx.lineTo(-L / 2 - 4, B * 0.6); ctx.fill();
    ctx.fillStyle = o.color || '#f7f7f7';
    ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.quadraticCurveTo(L * 0.2, B / 2, -L / 2, B * 0.42); ctx.lineTo(-L / 2, -B * 0.42); ctx.quadraticCurveTo(L * 0.2, -B / 2, L / 2, 0); ctx.fill();
    ctx.fillStyle = '#b48a5a'; ctx.fillRect(-L * 0.42, -B * 0.3, L * 0.3, B * 0.6);
    ctx.fillStyle = o.accent || '#1d3557'; ctx.beginPath(); roundRectPath(ctx, -L * 0.1, -B * 0.28, L * 0.32, B * 0.56, 0.6); ctx.fill();
    ctx.fillStyle = 'rgba(160,200,230,0.8)'; ctx.fillRect(L * 0.16, -B * 0.22, L * 0.04, B * 0.44);
    ctx.restore();
  }

  /* ================================================================ tall scenery (dynamic, fake 3D) */
  /*
   * V (view) carries: ex, ey (camera eye in world), leanK (lean per metre of height), toScreen(x,y),
   * lx, ly (unit vector towards the sun in plan), dark (night), dusk, t (seconds, animation clock),
   * ppm (CSS px per metre), W (world), snap, S (sprite cache).
   */

  function locPt(o, u, v) {
    var c = Math.cos(o.rot), s = Math.sin(o.rot);
    return [o.x + c * u - s * v, o.y + s * u + c * v];
  }
  function leanPt(V, p, z) {
    var f = z * V.leanK;
    if (f > 0.42) f = 0.42; else if (f < 0) f = 0;
    return [p[0] + (p[0] - V.ex) * f, p[1] + (p[1] - V.ey) * f];
  }
  function lean(V, x, y, z) { return leanPt(V, [x, y], z); }
  function faceShade(V, nx, ny) {
    var d = nx * V.lx + ny * V.ly;
    return V.dark ? -0.30 + d * 0.06 : -0.16 + d * 0.17;
  }
  function polyFill(ctx, pts, style) {
    ctx.fillStyle = style;
    polyPath(ctx, pts);
    ctx.fill();
  }

  /** Extruded convex CCW polygon between heights z0 and z1: visible side faces + returns geometry (roof not filled). */
  function prism(ctx, V, cs, z0, z1, sideCol, noFill) {
    var n = cs.length, bot = new Array(n), top = new Array(n), vis = [], k;
    for (k = 0; k < n; k++) { bot[k] = leanPt(V, cs[k], z0); top[k] = leanPt(V, cs[k], z1); }
    for (k = 0; k < n; k++) {
      var a = cs[k], b = cs[(k + 1) % n];
      var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      var nx = dy / len, ny = -dx / len;
      var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (nx * (V.ex - mx) + ny * (V.ey - my) <= 0) continue;
      vis.push(k);
      if (noFill) continue;
      var k2 = (k + 1) % n;
      ctx.fillStyle = shade(sideCol, faceShade(V, nx, ny));
      ctx.beginPath();
      ctx.moveTo(bot[k][0], bot[k][1]); ctx.lineTo(bot[k2][0], bot[k2][1]);
      ctx.lineTo(top[k2][0], top[k2][1]); ctx.lineTo(top[k][0], top[k][1]);
      ctx.closePath(); ctx.fill();
    }
    return { bot: bot, top: top, vis: vis, cs: cs, z0: z0, z1: z1 };
  }
  /** Point on face k of a prism at (u along edge 0..1, t up 0..1). */
  function facePt(P, k, u, t) {
    var n = P.bot.length, k2 = (k + 1) % n;
    var bx = P.bot[k][0] + (P.bot[k2][0] - P.bot[k][0]) * u, by = P.bot[k][1] + (P.bot[k2][1] - P.bot[k][1]) * u;
    var tx = P.top[k][0] + (P.top[k2][0] - P.top[k][0]) * u, ty = P.top[k][1] + (P.top[k2][1] - P.top[k][1]) * u;
    return [bx + (tx - bx) * t, by + (ty - by) * t];
  }
  function faceQuad(ctx, P, k, u0, u1, t0, t1) {
    var a = facePt(P, k, u0, t0), b = facePt(P, k, u1, t0), c = facePt(P, k, u1, t1), d = facePt(P, k, u0, t1);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
  }
  function edgeLen(P, k) { var n = P.cs.length, a = P.cs[k], b = P.cs[(k + 1) % n]; return Math.hypot(b[0] - a[0], b[1] - a[1]); }

  /** Text painted onto a (leaned) vertical face so that it reads correctly on screen. */
  function faceText(ctx, V, P, k, str, color, tMid, hFrac, font) {
    var n = P.bot.length, k2 = (k + 1) % n;
    var A = P.bot[k], B = P.bot[k2], D = P.top[k], C = P.top[k2];
    var As = V.toScreen(A[0], A[1]), Bs = V.toScreen(B[0], B[1]), Ds = V.toScreen(D[0], D[1]);
    var Ls = Math.hypot(Bs[0] - As[0], Bs[1] - As[1]), Hs = Math.hypot(Ds[0] - As[0], Ds[1] - As[1]);
    if (Hs * hFrac < 3.5 || Ls < 6) return;
    var cr = (Bs[0] - As[0]) * (Ds[1] - As[1]) - (Bs[1] - As[1]) * (Ds[0] - As[0]);
    var ox = A[0], oy = A[1], ux = B[0] - A[0], uy = B[1] - A[1], vx = D[0] - A[0], vy = D[1] - A[1];
    if (cr > 0) { ox = B[0]; oy = B[1]; ux = -ux; uy = -uy; vx = C[0] - B[0]; vy = C[1] - B[1]; }
    ctx.save();
    ctx.transform(ux, uy, vx, vy, ox, oy);
    ctx.translate(0.5, tMid);
    var sy = hFrac / 100, sx = hFrac * Hs / (100 * Ls);
    ctx.font = (font || '900') + ' 100px "Inter", "Helvetica Neue", Arial, sans-serif';
    var w = ctx.measureText ? ctx.measureText(str).width : 100 * str.length * 0.6;
    if (w * sx > 0.92) { var f = 0.92 / (w * sx); sx *= f; sy *= f; }
    ctx.scale(sx, -sy);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- sprite cache (trees, crowd, lights) */

  function SpriteCache() { this.map = new Map(); }
  SpriteCache.prototype.get = function (key, build) {
    var c = this.map.get(key);
    if (c === undefined) { c = build(); this.map.set(key, c); }
    return c;
  };
  SpriteCache.prototype.clear = function () { this.map.clear(); };

  var TREE_KIND = {
    oak: 'broad', maple: 'broad', birch: 'broad', poplar: 'column', pine: 'conifer', cedar: 'conifer',
    cypress: 'column', palm: 'palm', 'default': 'broad'
  };

  /** Canopy sprite: unit radius maps to 44 px (canvas 112 px, centred). Painted in world-up convention. */
  function treeSprite(S, variant, color, sun, seed) {
    var key = 'tree|' + variant + '|' + color + '|' + (seed & 3);
    return S.get(key, function () {
      var size = 112, R0 = 44, c = makeCanvas(size, size), g = ctx2d(c);
      if (!g) return null;
      var R = rng(hashStr(key));
      var kind = TREE_KIND[variant] || 'broad';
      var base = color;
      if (variant === 'maple') base = mix(color, '#b5532a', 0.35);
      else if (variant === 'birch') base = shade(color, 0.18);
      else if (variant === 'cedar') base = shade(color, -0.12);
      else if (variant === 'cypress') base = shade(mix(color, '#2c3d22', 0.4), -0.05);
      else if (variant === 'palm') base = mix(color, '#5d8a2e', 0.4);
      var sl = Math.hypot(sun.x, sun.y) || 1, hx = -sun.x / sl, hy = -sun.y / sl;
      g.translate(size / 2, size / 2);
      function blob(x, y, r, col) {
        var gr = g.createRadialGradient(x + hx * r * 0.35, y + hy * r * 0.35, r * 0.1, x, y, r);
        gr.addColorStop(0, shade(col, 0.22)); gr.addColorStop(0.65, col); gr.addColorStop(1, shade(col, -0.35));
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      if (kind === 'broad' || kind === 'column') {
        // dark under-canopy then clustered blobs, lit from the sun side
        g.fillStyle = shade(base, -0.45); g.beginPath(); g.arc(0, 0, R0 * 0.96, 0, TAU); g.fill();
        var nb = kind === 'column' ? 7 : 12;
        for (var k = 0; k < nb; k++) {
          var a = R() * TAU, d = Math.sqrt(R()) * R0 * 0.52, rr = R0 * (0.32 + R() * 0.2);
          blob(Math.cos(a) * d, Math.sin(a) * d, rr, shade(base, (R() - 0.5) * 0.22));
        }
        blob(hx * R0 * 0.2, hy * R0 * 0.2, R0 * 0.36, shade(base, 0.06));
        if (variant === 'birch') {
          g.fillStyle = 'rgba(255,255,220,0.12)';
          for (var q = 0; q < 30; q++) { g.fillRect((R() - 0.5) * R0 * 1.5, (R() - 0.5) * R0 * 1.5, 2, 2); }
        }
      } else if (kind === 'conifer') {
        // star-shaped needle layer
        var spikes = 11 + (seed % 3);
        for (var layer = 0; layer < 2; layer++) {
          var rOut = R0 * (layer ? 0.66 : 1), rIn = rOut * 0.68;
          g.beginPath();
          for (var s2 = 0; s2 <= spikes * 2; s2++) {
            var ang = s2 / (spikes * 2) * TAU + layer * 0.3, rad = s2 % 2 ? rIn : rOut * (0.9 + R() * 0.1);
            if (s2) g.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad); else g.moveTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
          }
          g.closePath();
          var cg = g.createRadialGradient(hx * rOut * 0.3, hy * rOut * 0.3, 2, 0, 0, rOut);
          cg.addColorStop(0, shade(base, layer ? 0.18 : 0.05)); cg.addColorStop(1, shade(base, -0.4));
          g.fillStyle = cg; g.fill();
        }
        g.strokeStyle = rgba(shade(base, -0.5), 0.5); g.lineWidth = 1;
        for (var b = 0; b < spikes; b++) {
          var aa = b / spikes * TAU;
          g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(aa) * R0 * 0.8, Math.sin(aa) * R0 * 0.8); g.stroke();
        }
      } else if (kind === 'palm') {
        var fr = 8 + (seed % 3);
        for (var f = 0; f < fr; f++) {
          var a2 = f / fr * TAU + R() * 0.3, len = R0 * (0.85 + R() * 0.15), bend = (R() - 0.5) * 0.5;
          var ca = Math.cos(a2), sa = Math.sin(a2), cb = Math.cos(a2 + bend), sb = Math.sin(a2 + bend);
          g.fillStyle = shade(base, f % 2 ? -0.12 : 0.08);
          g.beginPath();
          g.moveTo(0, 0);
          g.quadraticCurveTo(ca * len * 0.5 - sa * 7, sa * len * 0.5 + ca * 7, cb * len, sb * len);
          g.quadraticCurveTo(ca * len * 0.5 + sa * 7, sa * len * 0.5 - ca * 7, 0, 0);
          g.fill();
          g.strokeStyle = rgba(shade(base, -0.45), 0.7); g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(ca * len * 0.5, sa * len * 0.5, cb * len, sb * len); g.stroke();
        }
        g.fillStyle = '#6b4f2a'; g.beginPath(); g.arc(0, 0, 5, 0, TAU); g.fill();
      }
      return c;
    });
  }

  /** Soft radial light / smoke sprite (white or tinted), 64 px. */
  function softSprite(S, color, hard) {
    return S.get('soft|' + color + '|' + (hard || 0), function () {
      var size = 64, c = makeCanvas(size, size), g = ctx2d(c);
      if (!g) return null;
      var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      var r = hexToRgb(color);
      var col = r[0] + ',' + r[1] + ',' + r[2];
      gr.addColorStop(0, 'rgba(' + col + ',1)');
      gr.addColorStop(hard ? 0.5 : 0.25, 'rgba(' + col + ',' + (hard ? 0.85 : 0.55) + ')');
      gr.addColorStop(hard ? 0.8 : 0.6, 'rgba(' + col + ',' + (hard ? 0.3 : 0.18) + ')');
      gr.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = gr; g.fillRect(0, 0, size, size);
      return c;
    });
  }

  /** Headlight cone sprite pointing along +x from the left-middle edge (128 x 64 px). */
  function coneSprite(S, color) {
    return S.get('cone|' + color, function () {
      var w = 128, h = 64, c = makeCanvas(w, h), g = ctx2d(c);
      if (!g) return null;
      var r = hexToRgb(color), col = r[0] + ',' + r[1] + ',' + r[2];
      var gr = g.createRadialGradient(0, h / 2, 0, 0, h / 2, w);
      gr.addColorStop(0, 'rgba(' + col + ',0.95)');
      gr.addColorStop(0.35, 'rgba(' + col + ',0.55)');
      gr.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(0, h / 2 - 3); g.lineTo(w, 0); g.lineTo(w, h); g.lineTo(0, h / 2 + 3); g.closePath(); g.fill();
      return c;
    });
  }

  /** Crowd texture for grandstand seating (64 px covers 8 m). */
  function crowdTexture(S, seatCol, seed) {
    return S.get('crowd|' + seatCol + '|' + seed, function () {
      var size = 64, R = rng(seed), c = makeCanvas(size, size), g = ctx2d(c);
      if (!g) return null;
      g.fillStyle = seatCol; g.fillRect(0, 0, size, size);
      var shirts = ['#e8e8e8', '#d13b2e', '#2a62b8', '#f2c200', '#1d1d1d', '#3b8d3b', '#ff7a1a', '#7a3db8', '#f2a3b5', '#8d6e4a'];
      for (var row = 0; row < 16; row++) {
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, row * 4 + 3, size, 1);
        for (var x = 0; x < size; x += 2) {
          if (R() < 0.62) { g.fillStyle = R.pick(shirts); g.fillRect(x, row * 4, 2, 2); g.fillStyle = 'rgba(240,200,170,0.9)'; g.fillRect(x, row * 4 + 2, 1, 1); }
        }
      }
      return c;
    });
  }

  /* ---------------------------------------------------------------- tall object painters */

  function drawTree(ctx, o, V) {
    var kind = TREE_KIND[o.variant] || 'broad';
    var spr = treeSprite(V.S, o.variant || 'oak', o.color || V.W.theme.tree, V.W.sun, o.seed);
    if (!spr) return;
    var h = o.h, r = o.r, sway = Math.sin(V.t * 1.3 + (o.seed % 97)) * 0.035 * r * V.wind;
    function stamp(z, k) {
      var p = lean(V, o.x + sway * (z / h), o.y + sway * 0.6 * (z / h), z), rr = r * k * 1.27;
      ctx.drawImage(spr, p[0] - rr, p[1] - rr, rr * 2, rr * 2);
    }
    if (kind === 'palm') {
      var top = lean(V, o.x + sway, o.y, h);
      ctx.strokeStyle = '#7a5a34'; ctx.lineWidth = 0.42; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(top[0], top[1]); ctx.stroke();
      ctx.lineCap = 'butt';
      stamp(h, 1);
    } else if (kind === 'conifer') {
      stamp(h * 0.3, 1); stamp(h * 0.6, 0.72); stamp(h * 0.88, 0.42);
    } else if (kind === 'column') {
      stamp(h * 0.35, 0.9); stamp(h * 0.62, 0.8); stamp(h * 0.9, 0.55);
    } else {
      stamp(h * 0.62, 1); stamp(h * 0.8, 0.62);
    }
  }

  function drawLamp(ctx, o, V) {
    var h = o.h, top = lean(V, o.x, o.y, h), vr = o.variant || 'street';
    ctx.strokeStyle = vr === 'stadium' ? '#6c7178' : '#4a4f56'; ctx.lineWidth = vr === 'stadium' ? 0.7 : 0.22; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(top[0], top[1]); ctx.stroke();
    ctx.lineCap = 'butt';
    // arm reaches toward the track
    var tc = -o.side, armL = vr === 'street' || vr === 'road' ? 1.8 : vr === 'flood' ? 0.9 : 0;
    var c = Math.cos(o.rot), s = Math.sin(o.rot);
    var hx = -s * tc * armL, hy = c * tc * armL;
    var head = lean(V, o.x + hx, o.y + hy, h);
    if (armL) {
      ctx.strokeStyle = '#4a4f56'; ctx.lineWidth = 0.16;
      ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(head[0], head[1]); ctx.stroke();
    }
    if (vr === 'stadium') {
      var cs = [];
      [[1.6, 0.6], [-1.6, 0.6], [-1.6, -0.6], [1.6, -0.6]].forEach(function (q) { cs.push(lean(V, o.x + c * q[0] - s * q[1], o.y + s * q[0] + c * q[1], h)); });
      polyFill(ctx, cs, '#3a3e44');
      ctx.fillStyle = V.dark || V.dusk ? '#fffbe8' : '#c8ccd2';
      for (var i = 0; i < 4; i++) for (var j = 0; j < 2; j++) {
        var u = -1.2 + i * 0.8, v = -0.3 + j * 0.6, p = lean(V, o.x + c * u - s * v, o.y + s * u + c * v, h);
        ctx.fillRect(p[0] - 0.22, p[1] - 0.18, 0.44, 0.36);
      }
    } else {
      ctx.fillStyle = '#2f3338';
      ctx.beginPath(); ctx.arc(head[0], head[1], vr === 'flood' ? 0.55 : 0.32, 0, TAU); ctx.fill();
      ctx.fillStyle = V.dark || V.dusk ? (o.color || '#ffe9b8') : '#d8dde2';
      ctx.beginPath(); ctx.arc(head[0], head[1], vr === 'flood' ? 0.36 : 0.2, 0, TAU); ctx.fill();
    }
    o._head = head;
  }

  function roofDetails(ctx, o, V, P, col) {
    if (V.ppm < 2.5) return;
    var R = rng(o.seed + 7);
    var inset = Math.min(0.6, o.w * 0.06);
    // parapet inner line
    var inner = rectCorners(o, -inset).map(function (p) { return leanPt(V, p, o.h); });
    ctx.strokeStyle = rgba(shade(col, -0.35), 0.6); ctx.lineWidth = 0.18;
    polyPath(ctx, inner); ctx.stroke();
    var n = Math.min(7, Math.floor(o.l * o.w / 140));
    for (var k = 0; k < n; k++) {
      var u = (R() - 0.5) * (o.l - 4), v = (R() - 0.5) * (o.w - 4), sz = 1 + R() * 2.2;
      var box = rectCorners({ x: locPt(o, u, v)[0], y: locPt(o, u, v)[1], rot: o.rot, l: sz * 1.4, w: sz });
      var Pb = prism(ctx, V, box, o.h, o.h + 0.9 + R() * 0.8, '#9aa0a6');
      polyFill(ctx, Pb.top, '#b8bdc2');
      if (R() < 0.5) {
        var cc = leanPt(V, locPt(o, u, v), Pb.z1);
        ctx.strokeStyle = '#6d7277'; ctx.lineWidth = 0.08;
        ctx.beginPath(); ctx.arc(cc[0], cc[1], sz * 0.32, 0, TAU); ctx.stroke();
      }
    }
  }

  function drawBuilding(ctx, o, V) {
    var th = V.W.theme, vr = o.variant || '';
    var col = o.color || '#c9c3b8';
    var cs = rectCorners(o);
    var glass = o.lit || /^#(1|2|3)/.test(col) && o.h > 30;
    if (vr === 'teahouse' || vr === 'clubhouse') {
      var wallH = o.h * 0.55;
      prism(ctx, V, cs, 0, wallH, vr === 'teahouse' ? '#d9c7a4' : col);
      // hipped roof with outset eaves and ridge
      var eave = rectCorners(o, 0.8).map(function (p) { return leanPt(V, p, wallH); });
      var rl = Math.max(0.5, o.l / 2 - o.w / 2);
      var r1 = leanPt(V, locPt(o, rl, 0), o.h), r2 = leanPt(V, locPt(o, -rl, 0), o.h);
      var roofCol = vr === 'teahouse' ? (o.accent || '#2b2b2b') : (o.accent || '#b5562f');
      var faces = [[eave[0], eave[1], r2, r1], [eave[1], eave[2], r2], [eave[2], eave[3], r1, r2], [eave[3], eave[0], r1]];
      var shadeF = [0.12, -0.05, -0.22, 0.02];
      // order faces by sun so the lit side is brighter (normals: +v, -u, -v, +u in local)
      var c = Math.cos(o.rot), s = Math.sin(o.rot);
      var normals = [[-s, c], [-c, -s], [s, -c], [c, s]];
      faces.forEach(function (f, i) { polyFill(ctx, f, shade(roofCol, faceShade(V, normals[i][0], normals[i][1]) + shadeF[i] * 0.3)); });
      ctx.strokeStyle = rgba(shade(roofCol, -0.5), 0.8); ctx.lineWidth = 0.14;
      ctx.beginPath(); ctx.moveTo(r1[0], r1[1]); ctx.lineTo(r2[0], r2[1]);
      ctx.moveTo(eave[0][0], eave[0][1]); ctx.lineTo(r1[0], r1[1]); ctx.lineTo(eave[3][0], eave[3][1]);
      ctx.moveTo(eave[1][0], eave[1][1]); ctx.lineTo(r2[0], r2[1]); ctx.lineTo(eave[2][0], eave[2][1]);
      ctx.stroke();
      if (vr === 'teahouse' && V.ppm > 3) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.06;
        for (var q = 1; q < 8; q++) {
          var a = facePt({ bot: [eave[0], eave[3]], top: [r1, r1] }, 0, 0, q / 8);
          var b = facePt({ bot: [eave[1], eave[2]], top: [r2, r2] }, 0, 0, q / 8);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
      }
      return;
    }
    var side = glass ? mix(col, '#0e1726', 0.25) : col;
    var P = prism(ctx, V, cs, 0, o.h, side);
    // facade detail: floors / glazing bands
    if (V.ppm > 1.6) {
      var floors = Math.max(1, Math.floor(o.h / 3.6));
      ctx.strokeStyle = glass ? 'rgba(170,210,255,0.16)' : 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.12;
      P.vis.forEach(function (k) {
        var step = Math.max(1, Math.ceil(floors / 40));
        ctx.beginPath();
        for (var f = step; f < floors; f += step) {
          var a = facePt(P, k, 0, f / floors), b = facePt(P, k, 1, f / floors);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
        ctx.stroke();
        if (glass) {
          var L = edgeLen(P, k), cols = Math.min(30, Math.floor(L / 3));
          ctx.strokeStyle = 'rgba(0,0,0,0.18)';
          ctx.beginPath();
          for (var m = 1; m < cols; m++) { var a2 = facePt(P, k, m / cols, 0), b2 = facePt(P, k, m / cols, 1); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); }
          ctx.stroke();
          ctx.strokeStyle = 'rgba(170,210,255,0.16)';
        }
      });
    }
    // roof
    var roofCol = glass ? shade(col, -0.15) : shade(col, -0.06);
    polyFill(ctx, P.top, roofCol);
    if (vr === 'media' && V.ppm > 2) {
      ctx.fillStyle = 'rgba(140,200,255,0.35)';
      polyPath(ctx, rectCorners({ x: o.x, y: o.y, rot: o.rot, l: o.l * 0.9, w: o.w * 0.2 }).map(function (p) { return leanPt(V, p, o.h); })); ctx.fill();
      for (var d = 0; d < 3; d++) {
        var dp = leanPt(V, locPt(o, -o.l * 0.3 + d * o.l * 0.3, o.w * 0.28), o.h + 1.5);
        ctx.fillStyle = '#e8ecef'; ctx.beginPath(); ctx.arc(dp[0], dp[1], 1.3, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#9aa0a6'; ctx.lineWidth = 0.1; ctx.stroke();
      }
    } else {
      roofDetails(ctx, o, V, P, roofCol);
    }
    if (o.h > 90 && o.l > 25 && o.w > 20 && V.ppm > 1.2) {
      // helipad on the tallest towers
      var hp = leanPt(V, [o.x, o.y], o.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 0.35;
      ctx.beginPath(); ctx.arc(hp[0], hp[1], Math.min(o.w, o.l) * 0.28, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      worldText(ctx, 'H', hp[0], hp[1], o.rot - HALF_PI, Math.min(o.w, o.l) * 0.3, '900');
    }
    if (o.accent && V.ppm > 1) {
      ctx.strokeStyle = rgba(o.accent, V.dark ? 0.35 : 0.7); ctx.lineWidth = 0.35;
      polyPath(ctx, P.top); ctx.stroke();
    }
    o._P = P;
  }

  function drawGrandstand(ctx, o, V) {
    var col = o.color || '#8c939b', acc = o.accent || V.W.theme.accent || '#ff5a1f';
    var h = o.h, sd = o.side || 1, front = -sd * o.w / 2, back = sd * o.w / 2;
    var cs = rectCorners(o);
    var P = prism(ctx, V, cs, 0, h * 0.85, col);
    // seating plane rises from the front (track side) to the back
    var hl = o.l / 2;
    var f1 = leanPt(V, locPt(o, hl, front), h * 0.18), f2 = leanPt(V, locPt(o, -hl, front), h * 0.18);
    var b1 = leanPt(V, locPt(o, hl, back), h * 0.85), b2 = leanPt(V, locPt(o, -hl, back), h * 0.85);
    var pts = [f1, f2, b2, b1];
    polyFill(ctx, pts, shade(col, -0.2));
    if (V.ppm > 2.2) {
      var tex = crowdTexture(V.S, shade(acc, -0.35), o.seed % 5);
      var pat = tex && V.pattern(tex, 8, o.rot);
      if (pat) { ctx.fillStyle = pat; polyPath(ctx, pts); ctx.fill(); }
      // stair aisles
      ctx.strokeStyle = 'rgba(230,230,230,0.6)'; ctx.lineWidth = 0.25;
      ctx.beginPath();
      var aisles = Math.max(2, Math.round(o.l / 12));
      for (var a = 1; a < aisles; a++) {
        var u = -hl + a * o.l / aisles;
        var p0 = leanPt(V, locPt(o, u, front), h * 0.18), p1 = leanPt(V, locPt(o, u, back), h * 0.85);
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      }
      ctx.stroke();
    }
    // front wall with an advertising band
    ctx.fillStyle = acc;
    var fw1 = leanPt(V, locPt(o, hl, front), h * 0.18), fw2 = leanPt(V, locPt(o, -hl, front), h * 0.18);
    ctx.strokeStyle = acc; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(fw1[0], fw1[1]); ctx.lineTo(fw2[0], fw2[1]); ctx.stroke();
    // cantilever roof over the back 60 %
    var mid = back - sd * o.w * 0.6;
    var r1 = leanPt(V, locPt(o, hl + 0.5, mid), h), r2 = leanPt(V, locPt(o, -hl - 0.5, mid), h);
    var r3 = leanPt(V, locPt(o, -hl - 0.5, back + sd * 0.3), h), r4 = leanPt(V, locPt(o, hl + 0.5, back + sd * 0.3), h);
    ctx.globalAlpha = 0.94;
    polyFill(ctx, [r1, r2, r3, r4], shade(V.W.theme.wall || '#dcdcdc', -0.05));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = acc; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(r1[0], r1[1]); ctx.lineTo(r2[0], r2[1]); ctx.stroke();
    if (V.ppm > 2.5) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.12;
      ctx.beginPath();
      var trusses = Math.max(2, Math.round(o.l / 8));
      for (var t = 0; t <= trusses; t++) {
        var uu = -hl + t * o.l / trusses;
        var q0 = leanPt(V, locPt(o, uu, mid), h), q1 = leanPt(V, locPt(o, uu, back), h);
        ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]);
      }
      ctx.stroke();
    }
    o._P = P; o._roof = [r1, r2];
  }

  function drawPits(ctx, o, V) {
    var col = o.color || '#e4e6e8', acc = o.accent || V.W.theme.accent || '#ff5a1f';
    var cs = rectCorners(o), sd = o.side || 1;
    var P = prism(ctx, V, cs, 0, o.h, col);
    // garage doors on the visible track-facing face
    var trackFace = sd > 0 ? 2 : 0;   // rectCorners: edge 0 = +v side, edge 2 = -v side
    if (P.vis.indexOf(trackFace) >= 0 && V.ppm > 1.5) {
      var n = Math.max(1, Math.floor(o.l / 12));
      ctx.fillStyle = V.dark ? 'rgba(255,240,210,0.15)' : 'rgba(30,32,36,0.55)';
      ctx.beginPath();
      for (var g = 0; g < n; g++) faceQuad(ctx, P, trackFace, (g + 0.12) / n, (g + 0.88) / n, 0, 0.6);
      ctx.fill();
    }
    polyFill(ctx, P.top, shade(col, -0.04));
    var stripe = rectCorners({ x: o.x, y: o.y, rot: o.rot, l: o.l, w: o.w * 0.18 }).map(function (p) { return leanPt(V, p, o.h); });
    polyFill(ctx, stripe, acc);
    if (o.text && V.ppm > 1.2) {
      var tp = leanPt(V, locPt(o, 0, sd * o.w * 0.25), o.h);
      ctx.fillStyle = shade(col, -0.55);
      worldText(ctx, String(o.text).toUpperCase(), tp[0], tp[1], o.rot, Math.min(o.w * 0.3, 4), '900');
    }
    roofDetails(ctx, { x: locPt(o, 0, -sd * o.w * 0.25)[0], y: locPt(o, 0, -sd * o.w * 0.25)[1], rot: o.rot, l: o.l * 0.9, w: o.w * 0.4, h: o.h, seed: o.seed }, V, P, col);
    o._P = P;
  }

  function drawBillboard(ctx, o, V) {
    var vr = o.variant, h = o.h, legs = vr === 'distance' ? h * 0.35 : vr === 'chevron' ? 0.2 : h * 0.4;
    var col = o.color || (vr === 'distance' ? '#f4f4f4' : '#1d1f24');
    var c = Math.cos(o.rot), s = Math.sin(o.rot);
    if (legs > 0.3) {
      ctx.strokeStyle = '#555a60'; ctx.lineWidth = 0.18;
      ctx.beginPath();
      [-0.35, 0.35].forEach(function (f) {
        var bx = o.x + c * o.l * f, by = o.y + s * o.l * f, tp = lean(V, bx, by, legs);
        ctx.moveTo(bx, by); ctx.lineTo(tp[0], tp[1]);
      });
      ctx.stroke();
    }
    var cs = rectCorners(o);
    var P = prism(ctx, V, cs, legs, h, col);
    polyFill(ctx, P.top, shade(col, -0.2));
    var face = P.vis.length ? P.vis[0] : -1;
    // the long faces are edges 0 and 2
    P.vis.forEach(function (k) {
      if (k !== 0 && k !== 2) return;
      face = k;
      if (vr === 'chevron') {
        ctx.fillStyle = '#111';
        ctx.beginPath(); faceQuad(ctx, P, k, 0, 1, 0, 1); ctx.fill();
        ctx.fillStyle = '#f2f2f2';
        var nch = Math.max(2, Math.round(o.l / 1.6));
        ctx.beginPath();
        for (var m = 0; m < nch; m++) {
          var u0 = m / nch, u1 = (m + 0.5) / nch, um = (m + 0.25) / nch;
          var a = facePt(P, k, u0, 0.1), b = facePt(P, k, um, 0.5), d = facePt(P, k, u0, 0.9);
          var a2 = facePt(P, k, u1, 0.1), b2 = facePt(P, k, (m + 0.75) / nch, 0.5), d2 = facePt(P, k, u1, 0.9);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(d[0], d[1]); ctx.lineTo(d2[0], d2[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath();
        }
        ctx.fill();
      } else if (o.text) {
        var tc = vr === 'distance' ? '#111' : (luminance(col) > 0.5 ? '#111' : (o.lit ? '#ffffff' : '#f2f2f2'));
        if (vr !== 'distance') { ctx.fillStyle = shade(col, 0.08); ctx.beginPath(); faceQuad(ctx, P, k, 0.02, 0.98, 0.08, 0.92); ctx.fill(); }
        faceText(ctx, V, P, k, String(o.text), tc, 0.5, 0.62, '900');
      }
    });
    o._P = P; o._face = face;
  }

  function drawSectorBoard(ctx, o, V) {
    var cs = rectCorners(o);
    ctx.strokeStyle = '#5a5f66'; ctx.lineWidth = 0.14;
    var lp1 = lean(V, o.x, o.y, 1.2);
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(lp1[0], lp1[1]); ctx.stroke();
    var P = prism(ctx, V, cs, 1.2, o.h, '#f4f4f4');
    polyFill(ctx, P.top, '#d8d8d8');
    P.vis.forEach(function (k) { if (k === 0 || k === 2) faceText(ctx, V, P, k, o.text || 'S', '#c8102e', 0.5, 0.7, '900'); });
  }

  function drawTower(ctx, o, V) {
    var vr = o.variant || '', col = o.color || '#d6d9dd', acc = o.accent || V.W.theme.accent || '#ff5a1f';
    var c = Math.cos(o.rot), s = Math.sin(o.rot);
    if (vr === 'observation-wheel') {
      var R2 = Math.min(o.h * 0.45, 70), hub = R2 + 4;
      var spin = V.t * 0.02;
      var pts = [];
      for (var a = 0; a <= 48; a++) {
        var t = a / 48 * TAU, u = Math.cos(t) * R2, z = hub + Math.sin(t) * R2;
        pts.push(lean(V, o.x + c * u, o.y + s * u, z));
      }
      // A-frame legs
      ctx.strokeStyle = shade(col, -0.25); ctx.lineWidth = 0.9;
      var hubP = lean(V, o.x, o.y, hub);
      ctx.beginPath();
      [-1, 1].forEach(function (k) {
        var bx = o.x + c * k * R2 * 0.45 - s * 3, by = o.y + s * k * R2 * 0.45 + c * 3;
        var bx2 = o.x + c * k * R2 * 0.45 + s * 3, by2 = o.y + s * k * R2 * 0.45 - c * 3;
        ctx.moveTo(bx, by); ctx.lineTo(hubP[0], hubP[1]); ctx.moveTo(bx2, by2); ctx.lineTo(hubP[0], hubP[1]);
      });
      ctx.stroke();
      ctx.strokeStyle = shade(col, -0.1); ctx.lineWidth = 0.35;
      ctx.beginPath();
      for (var sp = 0; sp < 16; sp++) {
        var ts = sp / 16 * TAU + spin, us = Math.cos(ts) * R2, zs = hub + Math.sin(ts) * R2;
        var ps = lean(V, o.x + c * us, o.y + s * us, zs);
        ctx.moveTo(hubP[0], hubP[1]); ctx.lineTo(ps[0], ps[1]);
      }
      ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.1;
      ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
      for (var g = 0; g < 28; g++) {
        var tg = g / 28 * TAU + spin, ug = Math.cos(tg) * (R2 + 1.2), zg = hub + Math.sin(tg) * (R2 + 1.2);
        var pg = lean(V, o.x + c * ug, o.y + s * ug, zg);
        ctx.fillStyle = g % 4 === 0 ? acc : '#eef2f6';
        ctx.beginPath(); ctx.arc(pg[0], pg[1], 1.1, 0, TAU); ctx.fill();
      }
      o._ring = pts; o._hub = hubP;
      return;
    }
    if (vr === 'torii') {
      var red = o.color || '#c8202a', hl = o.l / 2;
      ctx.strokeStyle = red; ctx.lineWidth = 0.55; ctx.lineCap = 'round';
      ctx.beginPath();
      [-0.62, 0.62].forEach(function (f) {
        var bx = o.x + c * hl * f, by = o.y + s * hl * f, tp = lean(V, bx, by, o.h * 0.92);
        ctx.moveTo(bx, by); ctx.lineTo(tp[0], tp[1]);
      });
      ctx.stroke();
      ctx.lineCap = 'butt';
      var nuki = prism(ctx, V, rectCorners({ x: o.x, y: o.y, rot: o.rot, l: o.l * 0.9, w: 0.35 }), o.h * 0.7, o.h * 0.76, red);
      polyFill(ctx, nuki.top, red);
      var kasagi = prism(ctx, V, rectCorners({ x: o.x, y: o.y, rot: o.rot, l: o.l * 1.18, w: 0.6 }), o.h * 0.92, o.h, '#1d1d1d');
      polyFill(ctx, kasagi.top, '#262626');
      return;
    }
    var cs = rectCorners(o);
    if (vr === 'control-tower') {
      var shaft = rectCorners({ x: o.x, y: o.y, rot: o.rot, l: o.l * 0.45, w: o.w * 0.45 });
      prism(ctx, V, shaft, 0, o.h * 0.78, col);
      var cab = prism(ctx, V, cs, o.h * 0.78, o.h, '#26445e');
      ctx.strokeStyle = 'rgba(200,230,255,0.35)'; ctx.lineWidth = 0.1;
      cab.vis.forEach(function (k) {
        ctx.beginPath();
        for (var m = 1; m < 6; m++) { var a2 = facePt(cab, k, m / 6, 0), b2 = facePt(cab, k, m / 6, 1); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); }
        ctx.stroke();
      });
      polyFill(ctx, cab.top, shade(col, -0.1));
      var mast = lean(V, o.x, o.y, o.h + 8);
      var mb = leanPt(V, [o.x, o.y], o.h);
      ctx.strokeStyle = '#8a9096'; ctx.lineWidth = 0.15;
      ctx.beginPath(); ctx.moveTo(mb[0], mb[1]); ctx.lineTo(mast[0], mast[1]); ctx.stroke();
      if (o.text && V.ppm > 1.5) cab.vis.forEach(function (k) { if (k === 0 || k === 2) faceText(ctx, V, cab, k, o.text, '#f2f2f2', 0.5, 0.35, '800'); });
      o._P = cab;
      return;
    }
    // scoring pylon / timing tower / generic tower
    var dark = vr === 'scoring-pylon' || vr === 'timing';
    var P = prism(ctx, V, cs, 0, o.h, dark ? '#1c1f24' : col);
    if (dark && V.ppm > 1.2) {
      P.vis.forEach(function (k) {
        var rows = Math.max(3, Math.min(14, Math.floor(o.h / 4)));
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.beginPath();
        for (var r = 0; r < rows; r++) faceQuad(ctx, P, k, 0.12, 0.88, (r + 0.2) / rows * 0.78, (r + 0.75) / rows * 0.78);
        ctx.fill();
        if (o.text) faceText(ctx, V, P, k, o.text, acc, 0.9, 0.08, '900');
      });
    }
    polyFill(ctx, P.top, dark ? '#2a2e34' : shade(col, -0.08));
    ctx.strokeStyle = acc; ctx.lineWidth = 0.3; polyPath(ctx, P.top); ctx.stroke();
    if (o.text && V.ppm > 1.2) {
      var tp = leanPt(V, [o.x, o.y], o.h);
      ctx.fillStyle = acc;
      worldText(ctx, String(o.text).slice(0, 12), tp[0], tp[1], o.rot, Math.min(o.l, o.w) * 0.16, '900');
    }
    o._P = P;
  }

  function drawGantry(ctx, o, V) {
    var G = V.W.G, i = o.i, hw = G.hw[i] + 1.8;
    var tx = G.tx[i], ty = G.ty[i];
    var go = { x: G.cx[i], y: G.cy[i], rot: G.hd[i] + HALF_PI, l: hw * 2, w: 1.0, h: o.h, seed: 3 };
    // pylons
    [-1, 1].forEach(function (k) {
      var px = G.cx[i] + G.nx[i] * hw * k, py = G.cy[i] + G.ny[i] * hw * k;
      var Pp = prism(ctx, V, rectCorners({ x: px, y: py, rot: G.hd[i], l: 1.0, w: 1.0 }), 0, o.h, '#4d535a');
      polyFill(ctx, Pp.top, '#5d636b');
    });
    var beam = prism(ctx, V, rectCorners(go), o.h - 1.1, o.h, '#30353b');
    polyFill(ctx, beam.top, '#3b4148');
    // light pods
    var cd = (V.snap && V.snap.countdown) || {};
    var on = cd.lightsOut ? 0 : (cd.lightsOn | 0);
    o._lights = [];
    for (var k = 0; k < 5; k++) {
      var lat = (k - 2) * 1.25;
      var p = leanPt(V, [G.cx[i] + G.nx[i] * lat - tx * 0.3, G.cy[i] + G.ny[i] * lat - ty * 0.3], o.h);
      ctx.fillStyle = '#111317';
      ctx.fillRect(p[0] - 0.42, p[1] - 0.42, 0.84, 0.84);
      ctx.fillStyle = k < on ? '#ff2a1a' : '#3a0c0a';
      ctx.beginPath(); ctx.arc(p[0], p[1], 0.3, 0, TAU); ctx.fill();
      o._lights.push({ x: p[0], y: p[1], on: k < on });
    }
    if (V.ppm > 2) {
      var mid = leanPt(V, [G.cx[i] + tx * 0.2, G.cy[i] + ty * 0.2], o.h);
      ctx.fillStyle = V.W.theme.accent || '#ff5a1f';
      worldText(ctx, 'REDLINE', mid[0] + G.nx[i] * (hw - 3), mid[1] + G.ny[i] * (hw - 3), G.hd[i] - HALF_PI, 0.7, '900');
    }
  }

  function drawTall(ctx, o, V) {
    switch (o.type) {
      case 'tree': drawTree(ctx, o, V); break;
      case 'lamp': drawLamp(ctx, o, V); break;
      case 'grandstand': drawGrandstand(ctx, o, V); break;
      case 'pits': drawPits(ctx, o, V); break;
      case 'billboard': drawBillboard(ctx, o, V); break;
      case 'tower': drawTower(ctx, o, V); break;
      case 'sectorboard': drawSectorBoard(ctx, o, V); break;
      case 'gantry': drawGantry(ctx, o, V); break;
      case 'bridge': {
        var P = prism(ctx, V, rectCorners(o), 0, o.h, o.color || V.W.theme.bridge || '#7d848c');
        polyFill(ctx, P.top, shade(o.color || V.W.theme.bridge || '#7d848c', 0.05));
        break;
      }
      default: drawBuilding(ctx, o, V);
    }
  }

  /** Emissive (unlit-by-lightmap) parts of tall objects: lamp heads, windows, neon, boards, start lights. */
  function drawTallEmissive(ctx, o, V) {
    var R, P = o._P;
    switch (o.type) {
      case 'lamp': {
        var hd = o._head; if (!hd) return;
        var spr = softSprite(V.S, o.color || '#ffe7b0');
        var rr = o.variant === 'stadium' ? 4.5 : o.variant === 'flood' ? 2.4 : 1.4;
        if (spr) { ctx.globalAlpha = 0.85; ctx.drawImage(spr, hd[0] - rr, hd[1] - rr, rr * 2, rr * 2); ctx.globalAlpha = 1; }
        ctx.fillStyle = '#fffdf0'; ctx.beginPath(); ctx.arc(hd[0], hd[1], o.variant === 'stadium' ? 1.1 : 0.22, 0, TAU); ctx.fill();
        return;
      }
      case 'gantry': {
        (o._lights || []).forEach(function (l) {
          if (!l.on) return;
          var s2 = softSprite(V.S, '#ff2a1a');
          if (s2) ctx.drawImage(s2, l.x - 1.6, l.y - 1.6, 3.2, 3.2);
          ctx.fillStyle = '#ffd2c8'; ctx.beginPath(); ctx.arc(l.x, l.y, 0.18, 0, TAU); ctx.fill();
        });
        return;
      }
      case 'tower':
        if (o.variant === 'observation-wheel' && o._ring && o.lit) {
          ctx.strokeStyle = rgba(o.accent || '#2bf3ff', 0.9); ctx.lineWidth = 0.7;
          ctx.beginPath(); o._ring.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
          ctx.strokeStyle = rgba(o.accent || '#2bf3ff', 0.25); ctx.lineWidth = 2.2; ctx.stroke();
          return;
        }
        break;
      case 'billboard':
        if (o.lit && P && o._face >= 0 && (o._face === 0 || o._face === 2)) {
          ctx.fillStyle = rgba(o.color || '#2bf3ff', 0.85);
          ctx.beginPath(); faceQuad(ctx, P, o._face, 0.02, 0.98, 0.08, 0.92); ctx.fill();
          if (o.text) faceText(ctx, V, P, o._face, String(o.text), '#ffffff', 0.5, 0.62, '900');
        }
        return;
      case 'grandstand':
        if (o._roof) {
          ctx.strokeStyle = rgba(o.lit ? (o.accent || '#ffe7b0') : '#ffe7b0', 0.85); ctx.lineWidth = 0.3;
          ctx.beginPath(); ctx.moveTo(o._roof[0][0], o._roof[0][1]); ctx.lineTo(o._roof[1][0], o._roof[1][1]); ctx.stroke();
        }
        return;
    }
    if (!P || !(o.lit || o.type === 'pits' || (o.type === 'building' && V.dark))) return;
    // lit windows on visible faces
    R = rng(o.seed + 99);
    var floors = Math.max(1, Math.floor((P.z1 - P.z0) / 3.6));
    var warm = ['rgba(255,226,170,0.85)', 'rgba(255,240,210,0.8)', 'rgba(190,220,255,0.75)', 'rgba(255,200,140,0.8)'];
    P.vis.forEach(function (k) {
      var L = edgeLen(P, k), cols = Math.max(1, Math.floor(L / 3.2));
      var fstep = Math.max(1, Math.ceil(floors / 36)), cstep = Math.max(1, Math.ceil(cols / 24));
      for (var ci = 0; ci < 4; ci++) {
        ctx.fillStyle = warm[ci];
        ctx.beginPath();
        var R2 = rng(o.seed * 31 + k * 7 + ci);
        for (var f = 0; f < floors; f += fstep) {
          for (var m = 0; m < cols; m += cstep) {
            if (R2() > (o.lit ? 0.16 : 0.07)) continue;
            faceQuad(ctx, P, k, (m + 0.2) / cols, (m + cstep - 0.2) / cols, (f + 0.25) / floors, (f + fstep - 0.3) / floors);
          }
        }
        ctx.fill();
      }
    });
    if (o.accent && o.lit) {
      ctx.strokeStyle = rgba(o.accent, 0.95); ctx.lineWidth = 0.4; polyPath(ctx, P.top); ctx.stroke();
      ctx.strokeStyle = rgba(o.accent, 0.25); ctx.lineWidth = 1.6; ctx.stroke();
    }
    if (R && o.type === 'pits' && o.text && V.ppm > 1.2) {
      var sd = o.side || 1, tp = leanPt(V, locPt(o, 0, sd * o.w * 0.25), o.h);
      ctx.fillStyle = rgba(o.accent || '#ffffff', 0.9);
      worldText(ctx, String(o.text).toUpperCase(), tp[0], tp[1], o.rot, Math.min(o.w * 0.3, 4), '900');
    }
  }

  /* ================================================================ tile pyramid (static world cache) */

  function tileKey(level, ix, iy) { return level * 1e8 + (ix + 5000) * 1e4 + (iy + 5000); }

  /**
   * Lazily painted multi-resolution tile cache. Level 0 is fully painted up front and pinned; finer levels are
   * painted on demand within a per-frame time budget, nearest-to-camera first, and evicted LRU.
   */
  function TileCache(W, opts) {
    this.W = W;
    this.levels = LEVELS.map(function (ppm) { return { ppm: ppm, size: TILE_PX / ppm }; });
    this.map = new Map();
    this.pool = [];
    this.count = 0;
    this.frame = 0;
    this.queue = [];
    this.queued = new Set();
    this.maxTiles = (opts && opts.maxTiles) || MAX_TILES;
    this.painted = 0;
    this.paintMs = 0;
    this.scratch = makeCanvas(TILE_PX + TILE_BLEED * 2, TILE_PX + TILE_BLEED * 2);
    this.sctx = ctx2d(this.scratch);
    this.patterns = null;
  }
  TileCache.prototype.ensurePatterns = function () {
    if (this.patterns || !this.sctx) return;
    var W = this.W, T = W.T, g = this.sctx, P = {};
    if (T) {
      var mowRot = W.G.hd[0];
      P.ground = W.street ? makePattern(g, T.urban, T.urbanM, W.G.hd[0]) : makePattern(g, T.grass, T.grassM, 0);
      P.mow = W.street ? null : makePattern(g, T.mow, T.mowM * 2, mowRot);
      P.blades = W.street ? null : makePattern(g, T.blades, T.bladesM, 0.4);
      P.grain = makePattern(g, T.grain, T.grainM, 0);
      P.patches = makePattern(g, T.patches, T.patchesM, 0.7);
      P.sand = makePattern(g, T.sand, T.sandM, 0);
      P.tarmac = makePattern(g, T.tarmac, T.tarmacM, 0.2);
    }
    this.patterns = P;
    W.P = P;
  };
  TileCache.prototype.paint = function (level, ix, iy) {
    var L = this.levels[level], ppm = L.ppm, size = L.size;
    var x0 = ix * size, y0 = iy * size;
    if (!this.sctx) return null;
    this.ensurePatterns();
    var t0 = now();
    var g = this.sctx, b = TILE_BLEED / ppm;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.scratch.width, this.scratch.height);
    g.setTransform(ppm, 0, 0, ppm, -(x0 - b) * ppm, -(y0 - b) * ppm);
    try {
      paintStatic(g, this.W, { x0: x0 - b, y0: y0 - b, x1: x0 + size + b, y1: y0 + size + b }, ppm);
    } catch (e) {
      if (typeof console !== 'undefined' && !this.warned) { this.warned = true; console.warn('[renderer] tile paint failed', e); }
    }
    var cv = this.pool.pop() || makeCanvas(TILE_PX + TILE_BLEED * 2, TILE_PX + TILE_BLEED * 2);
    var cg = ctx2d(cv);
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, cv.width, cv.height);
    cg.drawImage(this.scratch, 0, 0);
    var tile = { level: level, ix: ix, iy: iy, x0: x0 - b, y0: y0 - b, size: size + 2 * b, canvas: cv, used: this.frame };
    this.map.set(tileKey(level, ix, iy), tile);
    if (level > 0) this.count++;
    this.painted++;
    this.paintMs += now() - t0;
    return tile;
  };
  TileCache.prototype.prerenderBase = function () {
    var L = this.levels[0], B = this.W.G.bounds;
    for (var ix = Math.floor(B.x0 / L.size); ix <= Math.floor(B.x1 / L.size); ix++) {
      for (var iy = Math.floor(B.y0 / L.size); iy <= Math.floor(B.y1 / L.size); iy++) this.paint(0, ix, iy);
    }
  };
  TileCache.prototype.get = function (level, ix, iy) {
    var t = this.map.get(tileKey(level, ix, iy));
    if (t) t.used = this.frame;
    return t || null;
  };
  TileCache.prototype.request = function (level, ix, iy, pri) {
    var k = tileKey(level, ix, iy);
    if (this.map.has(k) || this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push({ k: k, level: level, ix: ix, iy: iy, pri: pri });
  };
  TileCache.prototype.evict = function () {
    if (this.count <= this.maxTiles) return;
    var arr = [];
    this.map.forEach(function (t) { if (t.level > 0) arr.push(t); });
    arr.sort(function (a, b) { return a.used - b.used; });
    var self = this, n = this.count - this.maxTiles;
    for (var i = 0; i < arr.length && n > 0; i++) {
      if (arr[i].used >= this.frame) break;   // never evict what is on screen now
      self.map.delete(tileKey(arr[i].level, arr[i].ix, arr[i].iy));
      if (self.pool.length < 8) self.pool.push(arr[i].canvas);
      self.count--; n--;
    }
  };
  /** Paints queued tiles until the budget (ms) is spent; always at least one. */
  TileCache.prototype.work = function (budgetMs) {
    if (!this.queue.length) return 0;
    this.queue.sort(function (a, b) { return a.pri - b.pri; });
    var t0 = now(), n = 0;
    while (this.queue.length) {
      var q = this.queue.shift();
      this.queued.delete(q.k);
      if (this.map.has(q.k)) continue;
      this.paint(q.level, q.ix, q.iy);
      n++;
      if (now() - t0 > budgetMs) break;
    }
    // stale requests (off screen by now) are dropped; the next frame re-requests what it needs
    this.queue.length = 0; this.queued.clear();
    this.evict();
    return n;
  };
  TileCache.prototype.clear = function () {
    var self = this;
    this.map.forEach(function (t) { if (self.pool.length < 8) self.pool.push(t.canvas); });
    this.map.clear(); this.count = 0; this.queue.length = 0; this.queued.clear();
  };
  /** Chooses the level for a given device-pixel density, capped by quality. */
  TileCache.prototype.levelFor = function (devPpm, maxLevel) {
    var lv = 0;
    for (var i = 0; i < LEVELS.length; i++) { lv = i; if (LEVELS[i] >= devPpm * 0.72) break; }
    return Math.min(lv, maxLevel);
  };
  /**
   * Draws the static world for the visible world AABB on ctx (current transform = world -> screen).
   * Missing fine tiles are covered by the best available coarser tile, then requested.
   */
  TileCache.prototype.draw = function (ctx, box, devPpm, maxLevel, focusX, focusY) {
    this.frame++;
    var lv = this.levelFor(devPpm, maxLevel);
    var L = this.levels[lv];
    var ix0 = Math.floor(box.x0 / L.size), ix1 = Math.floor(box.x1 / L.size);
    var iy0 = Math.floor(box.y0 / L.size), iy1 = Math.floor(box.y1 / L.size);
    // too many tiles for the cache at this level (huge screen / extreme zoom-out): step down a level
    while (lv > 0 && (ix1 - ix0 + 1) * (iy1 - iy0 + 1) > this.maxTiles * 0.7) {
      lv--; L = this.levels[lv];
      ix0 = Math.floor(box.x0 / L.size); ix1 = Math.floor(box.x1 / L.size);
      iy0 = Math.floor(box.y0 / L.size); iy1 = Math.floor(box.y1 / L.size);
    }
    var ready = [], under = new Map(), ix, iy, t;
    for (ix = ix0; ix <= ix1; ix++) {
      for (iy = iy0; iy <= iy1; iy++) {
        t = this.get(lv, ix, iy);
        if (t) { ready.push(t); continue; }
        var cx = (ix + 0.5) * L.size, cy = (iy + 0.5) * L.size;
        this.request(lv, ix, iy, Math.hypot(cx - focusX, cy - focusY));
        for (var c = lv - 1; c >= 0; c--) {
          var Lc = this.levels[c], jx = Math.floor(cx / Lc.size), jy = Math.floor(cy / Lc.size);
          var tc = this.get(c, jx, jy);
          if (!tc && c === 0) tc = this.paint(0, jx, jy);   // outside the pre-rendered bounds
          if (tc) { under.set(tileKey(c, jx, jy), tc); break; }
        }
      }
    }
    var smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    var list = Array.from(under.values()).sort(function (a, b) { return a.level - b.level; });
    for (var i = 0; i < list.length; i++) { t = list[i]; ctx.drawImage(t.canvas, t.x0, t.y0, t.size, t.size); }
    for (i = 0; i < ready.length; i++) { t = ready[i]; ctx.drawImage(t.canvas, t.x0, t.y0, t.size, t.size); }
    ctx.imageSmoothingEnabled = smooth;
    return { level: lv, drawn: ready.length, fallback: list.length };
  };

  /* ================================================================ cars: proportions, sprites, dynamic parts */

  // Fallback plan-view hints (mirrors CB.data.bodyStyles[].svg) so the renderer works without data.js.
  var BODY_FALLBACK = {
    coupe: { length_mm: 4550, width_mm: 1930, frontOverhang_mm: 930, rearOverhang_mm: 970, hoodLength: 0.40, cabinStart: 0.40, roofStart: 0.52, roofEnd: 0.66, cabinEnd: 0.84, tailStyle: 'fastback', noseStyle: 'long', archStyle: 'flared' },
    sedan: { length_mm: 4950, width_mm: 1900, frontOverhang_mm: 960, rearOverhang_mm: 1090, hoodLength: 0.33, cabinStart: 0.33, roofStart: 0.45, roofEnd: 0.66, cabinEnd: 0.80, tailStyle: 'notchback', noseStyle: 'long', archStyle: 'round' },
    hatchback: { length_mm: 4250, width_mm: 1800, frontOverhang_mm: 880, rearOverhang_mm: 770, hoodLength: 0.27, cabinStart: 0.27, roofStart: 0.40, roofEnd: 0.80, cabinEnd: 0.94, tailStyle: 'hatch', noseStyle: 'short', archStyle: 'flared' },
    wagon: { length_mm: 4980, width_mm: 1950, frontOverhang_mm: 960, rearOverhang_mm: 1140, hoodLength: 0.32, cabinStart: 0.32, roofStart: 0.44, roofEnd: 0.88, cabinEnd: 0.96, tailStyle: 'wagon', noseStyle: 'long', archStyle: 'flared' },
    suv: { length_mm: 4950, width_mm: 2000, frontOverhang_mm: 930, rearOverhang_mm: 1070, hoodLength: 0.30, cabinStart: 0.30, roofStart: 0.40, roofEnd: 0.90, cabinEnd: 0.97, tailStyle: 'box', noseStyle: 'tall', archStyle: 'squared' },
    roadster: { length_mm: 4100, width_mm: 1780, frontOverhang_mm: 820, rearOverhang_mm: 830, hoodLength: 0.42, cabinStart: 0.42, roofStart: 0.50, roofEnd: 0.62, cabinEnd: 0.70, tailStyle: 'open', noseStyle: 'long', archStyle: 'round', openTop: true },
    pickup: { length_mm: 5900, width_mm: 2080, frontOverhang_mm: 1000, rearOverhang_mm: 1500, hoodLength: 0.24, cabinStart: 0.24, roofStart: 0.32, roofEnd: 0.52, cabinEnd: 0.56, tailStyle: 'bed', noseStyle: 'blunt', archStyle: 'squared' },
    hypercar: { length_mm: 4700, width_mm: 2050, frontOverhang_mm: 1000, rearOverhang_mm: 1000, hoodLength: 0.26, cabinStart: 0.26, roofStart: 0.42, roofEnd: 0.54, cabinEnd: 0.70, tailStyle: 'longtail', noseStyle: 'wedge', archStyle: 'flared' },
    'shooting-brake': { length_mm: 4800, width_mm: 1950, frontOverhang_mm: 940, rearOverhang_mm: 1110, hoodLength: 0.38, cabinStart: 0.38, roofStart: 0.50, roofEnd: 0.84, cabinEnd: 0.95, tailStyle: 'kammback', noseStyle: 'long', archStyle: 'flared' },
    van: { length_mm: 5300, width_mm: 2000, frontOverhang_mm: 880, rearOverhang_mm: 1120, hoodLength: 0.14, cabinStart: 0.12, roofStart: 0.22, roofEnd: 0.96, cabinEnd: 0.99, tailStyle: 'box', noseStyle: 'blunt', archStyle: 'round' }
  };
  var NOSE_W = { long: 0.74, short: 0.80, blunt: 0.93, wedge: 0.60, low: 0.70, tall: 0.90 };
  var TAIL_W = { fastback: 0.86, notchback: 0.90, hatch: 0.92, wagon: 0.94, box: 0.97, bed: 0.97, kammback: 0.92, longtail: 0.80, open: 0.88 };
  var WAIST = { flared: 0.93, round: 0.965, squared: 0.985 };
  var LIGHT_COL = { halogen: '#fff1c2', led: '#f3f7ff', matrix: '#e8f1ff', laser: '#d6e6ff' };

  function bodyHints(style) {
    var bs = null;
    if (CB.data && Array.isArray(CB.data.bodyStyles)) {
      for (var i = 0; i < CB.data.bodyStyles.length; i++) if (CB.data.bodyStyles[i].id === style) { bs = CB.data.bodyStyles[i].svg; break; }
    }
    return Object.assign({}, BODY_FALLBACK.coupe, BODY_FALLBACK[style] || {}, bs || {});
  }

  /* ---------------------------------------------------------------- real-car plan views (CB.shapes) */
  // Fitted manufacturer models from js/shapes/ give the plan-view sprite its real outline, glasshouse, roof,
  // bonnet/deck shut lines and mirrors. Optional: without CB.shapes (or a model for the style) the procedural
  // profile below is used unchanged.
  var shapeFitCache = new Map();
  function shapeFitted(build, style) {
    var S = CB.shapes;
    if (!S || typeof S.getModel !== 'function' || typeof S.fit !== 'function') return null;
    var b = build || {}, body = b.body || {}, sus = b.suspension || {}, wh = b.wheels || {}, ty = b.tires || {};
    var q = { body: { style: style, model: body.model } };
    var model = null;
    try { model = S.getModel(q, { strict: true }); } catch (err) { model = null; }
    if (!model) return null;
    var key = [model.id, body.wheelbase_mm, body.trackWidth_mm, sus.rideHeight_mm, wh.diameter_in, ty.widthFront_mm, ty.widthRear_mm,
      ty.profileFront, ty.profileRear].join('|');
    if (shapeFitCache.has(key)) return shapeFitCache.get(key);
    var f = null;
    try {
      f = S.fit(model, { body: body, suspension: sus, wheels: wh, tires: ty });
      if (!f || !f.top || !f.dims || !S.items(f.top.body).length) f = null;
    } catch (err2) { f = null; }
    if (shapeFitCache.size > 64) shapeFitCache.clear();
    shapeFitCache.set(key, f);
    return f;
  }
  /** Converts a fitted model's plan view to sprite-local polylines (x fwd, y left) scaled to L x W metres. */
  function shapePlan(f, L, W) {
    var S = CB.shapes, d = f.dims, top = f.top;
    // uniform scale: the real model keeps its proportions (the physics L x W box is only used for collision)
    var sx = L / Math.max(0.5, d.length), sz = sx, cx = d.centerX;
    function polys(path) {
      return S.flatten(path, 10).map(function (pl) {
        return { pts: pl.pts.map(function (p) { return [(p[0] - cx) * sx, -p[1] * sz]; }), closed: pl.closed };
      }).filter(function (pl) { return pl.pts.length > 1; });
    }
    function slot(v, def) { return S.items(v).map(function (it) { return { polys: polys(it.path), paint: it.paint || def }; }); }
    var P = {
      sx: sx, sz: sz, id: f.id, make: f.make, openTop: !!(f.openTop || top.cockpit),
      body: slot(top.body, 'body'), greenhouse: slot(top.greenhouse, 'glass'), roof: slot(top.roof, 'body'),
      roofGlass: slot(top.roofGlass, 'glass'), hood: slot(top.hood, 'body'), deck: slot(top.deck, 'body'),
      mirrors: slot(top.mirrors, 'body'), cockpit: slot(top.cockpit, 'interior'),
      panelLines: slot(top.panelLines, 'line'), characterLines: slot(top.characterLines, 'line'),
      details: (f.details || []).filter(function (x) { return x && x.view === 'top' && x.role !== 'interior'; })
        .map(function (x) { return { polys: polys(x.path), paint: x.paint || 'black', role: x.role }; })
    };
    // a rear wing whose plan shape sits on the tail outline is moved over the boot lid (e.g. Civic Type R FL5)
    var xrL = (d.xRear - cx) * sx;
    P.details.forEach(function (it) {
      if (it.role !== 'wing') return;
      var x0 = Infinity; it.polys.forEach(function (pl) { pl.pts.forEach(function (p) { if (p[0] < x0) x0 = p[0]; }); });
      if (x0 < xrL + 0.1) it.polys.forEach(function (pl) { pl.pts = pl.pts.map(function (p) { return [p[0] + 0.2, p[1]]; }); });
    });
    P.bodyPts = [];
    P.body.forEach(function (it) { it.polys.forEach(function (pl) { if (pl.pts.length > P.bodyPts.length) P.bodyPts = pl.pts; }); });
    function bbox(list) {
      var b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      list.forEach(function (it) { it.polys.forEach(function (pl) { pl.pts.forEach(function (p) {
        if (p[0] < b.x0) b.x0 = p[0]; if (p[0] > b.x1) b.x1 = p[0]; if (p[1] < b.y0) b.y0 = p[1]; if (p[1] > b.y1) b.y1 = p[1];
      }); }); });
      return b.x0 < b.x1 ? b : null;
    }
    P.roofBox = bbox(P.roof.length ? P.roof : P.greenhouse);
    P.hoodBox = bbox(P.hood);
    return P;
  }
  /** Front-most (dir = 1) or rear-most (dir = -1) body x at lateral offset y (local metres). */
  function shapeEdgeX(pts, y, dir) {
    var best = null;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
      var x = a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]);
      if (best === null || x * dir > best * dir) best = x;
    }
    return best;
  }
  /** Lamp rectangles (local metres) at the nose / tail from the front / rear view lamp z extents. */
  function shapeLamps(f, P, slotV, dir, depth) {
    var S = CB.shapes, out = [];
    var edge = dir > 0 ? (f.dims.xFront - f.dims.centerX) * P.sx : (f.dims.xRear - f.dims.centerX) * P.sx;
    // one span per closed sub-polyline (a slot item may hold both lamps as two subpaths)
    var spans = [];
    S.items(slotV).forEach(function (it) {
      var pls = null;
      try { pls = S.flatten(it.path, 8); } catch (err) { pls = null; }
      (pls && pls.length ? pls : [null]).forEach(function (pl) {
        var lo = Infinity, hi = -Infinity;
        if (pl) pl.pts.forEach(function (p) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0]; });
        else { var b = S.bounds(it.path); if (b && !b.empty) { lo = b.minX; hi = b.maxX; } }
        if (hi > lo) spans.push([-hi * P.sz, -lo * P.sz]);
      });
    });
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    spans.forEach(function (s) {
      var last = merged[merged.length - 1];
      if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]); else merged.push(s.slice());
    });
    merged.forEach(function (s) {
      var y0 = s[0], y1 = s[1];
      // middle sample: the outer samples hit the rounded corners and pull the lamp inboard (bodyPath clips the overhang)
      var xm = shapeEdgeX(P.bodyPts, (y0 + y1) / 2, dir); if (xm === null) xm = edge;
      var xe = dir > 0 ? xm - 0.015 : xm + 0.015;
      out.push(dir > 0 ? { x0: xe - depth, x1: xe, y0: y0, y1: y1 } : { x0: xe, x1: xe + depth, y0: y0, y1: y1 });
    });
    return out;
  }
  /** Traces polys scaled about (cx, 0) by kx / ky (used to inset roof panels and roadster screens). */
  function tracePolysScaled(g, list, cx, kx, ky) {
    list.forEach(function (it) {
      (it.polys || [it]).forEach(function (pl) {
        pl.pts.forEach(function (p, i) { var X = cx + (p[0] - cx) * kx, Y = p[1] * ky; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
        if (pl.closed !== false) g.closePath();
      });
    });
  }
  function polysBox(list) {
    var b = null;
    list.forEach(function (it) { (it.polys || [it]).forEach(function (pl) { pl.pts.forEach(function (p) {
      b = b || { x0: p[0], x1: p[0], y0: p[1], y1: p[1] };
      if (p[0] < b.x0) b.x0 = p[0]; if (p[0] > b.x1) b.x1 = p[0]; if (p[1] < b.y0) b.y0 = p[1]; if (p[1] > b.y1) b.y1 = p[1];
    }); }); });
    return b;
  }
  function tracePolys(g, list, grow, L, W) {
    var kx = grow ? 1 + grow / (L / 2) : 1, ky = grow ? 1 + grow / (W / 2) : 1;
    list.forEach(function (it) {
      (it.polys || [it]).forEach(function (pl) {
        pl.pts.forEach(function (p, i) { if (i) g.lineTo(p[0] * kx, p[1] * ky); else g.moveTo(p[0] * kx, p[1] * ky); });
        if (pl.closed !== false) g.closePath();
      });
    });
  }

  /** Plan-view geometry of a car, derived from its build + snapshot dimensions (all in metres, local frame x fwd, y left). */
  function carModel(car) {
    var b = car.build || {}, body = b.body || {}, ext = b.exterior || {}, aero = b.aero || {}, wh = b.wheels || {}, ty = b.tires || {};
    var style = car.bodyStyle || body.style || 'coupe';
    var H = bodyHints(style);
    var SF = shapeFitted(car.build, style);
    var L = num(car.length_m, SF ? SF.dims.length : H.length_mm / 1000), W = num(car.width_m, SF ? SF.dims.width : H.width_mm / 1000);
    var k = L / (H.length_mm / 1000);
    var fo = H.frontOverhang_mm / 1000 * k;
    var wb = clamp(num(body.wheelbase_mm, (H.length_mm - H.frontOverhang_mm - H.rearOverhang_mm)) / 1000, L * 0.45, L * 0.75);
    var axF = L / 2 - fo, axR = Math.max(-L / 2 + 0.45, axF - wb);
    var twF = num(ty.widthFront_mm, 245) / 1000, twR = num(ty.widthRear_mm, num(ty.widthFront_mm, 265)) / 1000;
    var track = clamp(num(body.trackWidth_mm, W * 830) / 1000, W * 0.7, W - Math.max(twF, twR) * 0.55);
    var dia = num(wh.diameter_in, 18) * 0.0254 + 2 * twF * num(ty.profileFront, 40) / 100;
    var m = {
      style: style, H: H, L: L, W: W, axF: axF, axR: axR, track: track, twF: twF, twR: twR, tireLen: clamp(dia, 0.5, 0.85),
      circ: Math.PI * clamp(dia, 0.5, 0.85),
      paint: ext.paint || car.color || '#b3121f', accent: car.accent || ext.stripeColor || '#ffffff',
      finish: ext.finish || 'metallic', roof: ext.roof || 'body', roofColor: ext.roofColor || '#111111',
      stripe: ext.stripe || (car.build ? 'none' : 'racing-dual'), stripeColor: ext.stripeColor || car.accent || '#ffffff',
      tint: num(ext.windowTint_pct, 20), lights: ext.lights || 'led', mirrors: ext.mirrors || 'body',
      caliper: ext.caliperColor || '#c8102e', wheelFinish: wh.finish || '#2b2b2b', wheelDesign: wh.design || 'y-spoke',
      wing: aero.wing || 'none', splitter: aero.splitter || 'none', diffuser: aero.diffuser || 'none', canards: !!aero.canards,
      skirts: !!aero.sideSkirts, number: String(ext.livery_number || car.number || '').slice(0, 3),
      interior: (b.interior && b.interior.primaryColor) || '#1a1a1a'
    };
    if (car.color && !car.isPlayer && !(car.build && car.build.exterior && car.build.exterior.paint)) m.paint = car.color;
    m.noseW = NOSE_W[H.noseStyle] || 0.76;
    m.tailW = TAIL_W[H.tailStyle] || 0.88;
    m.waist = WAIST[H.archStyle] || 0.95;
    m.fx = function (f) { return L / 2 - f * L; };
    // outline half-widths (fraction of W/2) at fractions from the front
    var fF = (L / 2 - axF) / L, fR = (L / 2 - axR) / L, cab = (H.roofStart + H.roofEnd) / 2;
    m.profile = [
      [0, m.noseW * 0.80], [0.012, m.noseW], [0.05, lerp(m.noseW, 1, 0.55)], [Math.max(0.08, fF - 0.07), 0.975],
      [fF, 1.0], [fF + 0.07, 0.99], [cab, m.waist], [fR - 0.07, 0.99], [fR, 1.0], [Math.min(0.94, fR + 0.08), lerp(1, m.tailW, 0.4)],
      [0.975, m.tailW], [1, m.tailW * 0.9]
    ];
    m.key = [style, L.toFixed(2), W.toFixed(2), m.paint, m.finish, m.roof, m.roofColor, m.stripe, m.stripeColor, m.tint, m.lights,
      m.mirrors, m.wing, m.splitter, m.diffuser, m.canards, m.skirts, m.number, H.openTop ? 1 : 0].join('|');
    // light positions (local metres)
    var x0 = m.fx(0.004), x1 = m.fx(0.05), y0 = W / 2 * m.noseW * 0.48, y1 = W / 2 * m.noseW * 0.92;
    m.heads = [{ x0: x1, x1: x0, y0: y0, y1: y1 }, { x0: x1, x1: x0, y0: -y1, y1: -y0 }];
    var tx0 = m.fx(0.995), tx1 = m.fx(0.965), ty1 = W / 2 * m.tailW * 0.95, ty0 = ty1 * (H.tailStyle === 'longtail' || H.tailStyle === 'kammback' ? 0.02 : 0.55);
    m.tails = H.tailStyle === 'longtail' || H.tailStyle === 'kammback'
      ? [{ x0: tx0, x1: tx1, y0: -ty1, y1: ty1 }]
      : [{ x0: tx0, x1: tx1, y0: ty0, y1: ty1 }, { x0: tx0, x1: tx1, y0: -ty1, y1: -ty0 }];
    m.exhaust = [{ x: -L / 2 - 0.03, y: W * 0.18 }, { x: -L / 2 - 0.03, y: -W * 0.18 }];
    if (SF) {
      try { applyShape(m, SF); } catch (err) { m.shape = null; }
    }
    return m;
  }
  /** Replaces the procedural plan geometry of a car model with the fitted manufacturer model (if it converts). */
  function applyShape(m, f) {
    var P = shapePlan(f, m.L, m.W);
    if (P.bodyPts.length < 6) return;
    m.shape = P;
    m.W = Math.max(0.5, f.dims.width * P.sz);
    var wf = f.wheels.front, wr = f.wheels.rear, cx = f.dims.centerX;
    m.axF = (wf.x - cx) * P.sx; m.axR = (wr.x - cx) * P.sx;
    var tw = Math.max(m.twF, m.twR);
    m.track = clamp((wf.track + wr.track) / 2 * P.sz, m.W * 0.6, m.W - tw * 0.5);
    m.tireLen = clamp(wf.r * 2 * P.sx, 0.45, 1.0); m.circ = Math.PI * m.tireLen;
    var heads = shapeLamps(f, P, f.front && f.front.headlights, 1, 0.13);
    var tails = shapeLamps(f, P, f.rear && (f.rear.lightBar || f.rear.taillights), -1, 0.15);
    if (heads.length) m.heads = heads;
    if (tails.length) m.tails = tails;
    // the top-view details already draw the real headlamp shape (911, M4, Supra, 718): skip the sprite's nose block
    var noseX = -Infinity; P.bodyPts.forEach(function (p) { if (p[0] > noseX) noseX = p[0]; });
    m.headsInDetails = P.details.some(function (it) {
      if (it.paint !== 'light') return false;
      var b = polysBox([it]);
      return !!b && b.x1 > noseX - 0.5;
    });
    // full-width DRL / light bars (Cybertruck, ID. Buzz): thin strip at the nose
    m.drl = [];
    if (f.front && f.front.drl) {
      shapeLamps(f, P, f.front.drl, 1, 0.05).forEach(function (r) {
        var free = !m.heads.some(function (h) { return Math.min(r.y1, h.y1) - Math.max(r.y0, h.y0) > 0.04; });
        if (r.y1 - r.y0 > 0.6 * m.W || (free && r.y1 - r.y0 > 0.2)) m.drl.push(r);
      });
    }
    m.twoTone = !!(f.twoTone);
    var ex = [], xr = (f.dims.xRear - cx) * P.sx;
    (f.rear && f.rear.exhaust || []).forEach(function (e) {
      if (!e || e.shape === 'hidden' || typeof e.cx !== 'number') return;
      var y = -e.cx * P.sz, x = shapeEdgeX(P.bodyPts, y, -1);
      ex.push({ x: (x === null ? xr : x) - 0.03, y: y });
    });
    m.exhaust = ex;
    m.key += '|' + P.id + '|' + f.dims.wheelbase.toFixed(3) + '|' + f.dims.track.toFixed(3) + '|' + m.tireLen.toFixed(3);
  }

  /** Body outline path (local metres) built from the profile with smooth curves. */
  function bodyPath(g, m, grow) {
    if (m.shape) { g.beginPath(); tracePolys(g, [{ pts: m.shape.bodyPts, closed: true }], grow || 0, m.L, m.W); return; }
    var L = m.L, hw = m.W / 2 + (grow || 0), P = m.profile, pts = [], i;
    for (i = 0; i < P.length; i++) pts.push([L / 2 - P[i][0] * L + (i === 0 ? grow || 0 : i === P.length - 1 ? -(grow || 0) : 0), P[i][1] * hw]);
    var all = pts.slice();
    for (i = pts.length - 1; i >= 0; i--) all.push([pts[i][0], -pts[i][1]]);
    g.beginPath();
    var n = all.length;
    var mx = (all[n - 1][0] + all[0][0]) / 2, my = (all[n - 1][1] + all[0][1]) / 2;
    g.moveTo(mx, my);
    for (i = 0; i < n; i++) {
      var p = all[i], q = all[(i + 1) % n];
      g.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    g.closePath();
  }
  /** Half-width of the body (metres) at a fraction from the front. */
  function bodyHalfAt(m, f) {
    var P = m.profile;
    for (var i = 1; i < P.length; i++) {
      if (f <= P[i][0]) { var t = (f - P[i - 1][0]) / Math.max(1e-6, P[i][0] - P[i - 1][0]); return lerp(P[i - 1][1], P[i][1], t) * m.W / 2; }
    }
    return P[P.length - 1][1] * m.W / 2;
  }
  function taperQuad(g, m, f0, f1, w0, w1) {
    var x0 = m.fx(f0), x1 = m.fx(f1);
    g.beginPath();
    g.moveTo(x0, w0); g.lineTo(x1, w1); g.lineTo(x1, -w1); g.lineTo(x0, -w0); g.closePath();
  }

  function paintGradient(g, m) {
    var p = m.paint, W = m.W, gr = g.createLinearGradient(0, -W / 2, 0, W / 2);
    var f = m.finish;
    if (f === 'chrome') {
      gr.addColorStop(0, mix(p, '#3a3a3a', 0.6)); gr.addColorStop(0.18, mix(p, '#f4f4f4', 0.7)); gr.addColorStop(0.35, mix(p, '#777777', 0.5));
      gr.addColorStop(0.5, mix(p, '#ffffff', 0.75)); gr.addColorStop(0.65, mix(p, '#6a6a6a', 0.5)); gr.addColorStop(0.82, mix(p, '#e8e8e8', 0.65)); gr.addColorStop(1, mix(p, '#333333', 0.6));
      return gr;
    }
    var hi = f === 'matte' ? 0.05 : f === 'satin' ? 0.1 : 0.2, lo = f === 'matte' ? -0.12 : -0.3;
    var mid = f === 'pearl' ? shade(hueShift(p, 14), hi + 0.08) : f === 'candy' ? shade(p, hi * 0.7) : shade(p, hi);
    gr.addColorStop(0, shade(p, lo)); gr.addColorStop(0.22, p); gr.addColorStop(0.5, mid); gr.addColorStop(0.78, p); gr.addColorStop(1, shade(p, lo - 0.05));
    return gr;
  }

  /** Fill colour / gradient for a CB.shapes paint key in the plan-view sprite. */
  function shapePaint(g, m, paint, glassFill) {
    switch (paint) {
      case 'body': return paintGradient(g, m);
      case 'gloss-black': return '#0b0c0e';
      case 'chrome': return '#b9bec4';
      case 'glass': return glassFill();
      case 'light': return LIGHT_COL[m.lights] || LIGHT_COL.led;
      case 'light-red': return '#9a1018';
      case 'light-amber': return '#b8700f';
      case 'carbon': return '#1b1d20';
      case 'grille': return '#08090a';
      case 'interior': return shade(m.interior, -0.1);
      default: return '#121315';
    }
  }
  /** Diagonal carbon weave over the current path (fills it, clips to it; caller wraps in save / restore). */
  function carbonWeave(g, L, W, base) {
    g.fillStyle = base || '#1b1c1f'; g.fill(); g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 0.02;
    for (var cx = -L; cx < L; cx += 0.06) { g.beginPath(); g.moveTo(cx, -W); g.lineTo(cx + W * 2, W); g.stroke(); }
  }
  function stripeOverlay(g, m) {
    var L = m.L, W = m.W;
    g.fillStyle = m.stripeColor;
    if (m.stripe === 'racing-dual') { g.fillRect(-L, W * 0.06, L * 2, W * 0.13); g.fillRect(-L, -W * 0.19, L * 2, W * 0.13); }
    else if (m.stripe === 'center') g.fillRect(-L, -W * 0.12, L * 2, W * 0.24);
    else if (m.stripe === 'le-mans') g.fillRect(-L, W * 0.02, L * 2, W * 0.2);
  }
  /** Shut lines, bonnet/deck outlines and character lines of the real model (drawn inside the body clip). */
  function shapePanels(g, m) {
    var P = m.shape, L = m.L, W = m.W;
    g.lineWidth = 0.018; g.strokeStyle = 'rgba(0,0,0,0.30)';
    g.beginPath(); tracePolys(g, P.hood.concat(P.deck), 0, L, W); g.stroke();
    g.beginPath(); tracePolys(g, P.panelLines.map(openItem), 0, L, W); g.stroke();
    var cl = P.characterLines;
    if (cl.length) {
      g.lineWidth = 0.022; g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.save(); g.translate(0.012, 0.012); g.beginPath(); tracePolys(g, cl.map(openItem), 0, L, W); g.stroke(); g.restore();
      g.strokeStyle = m.finish === 'matte' ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.16)';
      g.beginPath(); tracePolys(g, cl.map(openItem), 0, L, W); g.stroke();
    }
    // soft bonnet sheen: a faint highlight along the bonnet centreline, clipped to the bonnet outline
    if (P.hoodBox && P.hood.length) {
      var hb = P.hoodBox, hg = g.createLinearGradient(0, hb.y0, 0, hb.y1);
      hg.addColorStop(0, 'rgba(255,255,255,0)'); hg.addColorStop(0.5, 'rgba(255,255,255,' + (m.finish === 'matte' ? 0.02 : 0.04) + ')'); hg.addColorStop(1, 'rgba(255,255,255,0)');
      g.save(); g.beginPath(); tracePolys(g, P.hood, 0, L, W); g.clip();
      g.fillStyle = hg; g.fillRect(hb.x0, hb.y0, hb.x1 - hb.x0, hb.y1 - hb.y0); g.restore();
    }
  }
  function openItem(it) { return { polys: it.polys.map(function (pl) { return { pts: pl.pts, closed: false }; }) }; }
  /** Glasshouse, roof, cockpit, mirrors and top-view details of the real model. */
  function shapeCabin(g, m, glassFill) {
    var P = m.shape, L = m.L, W = m.W;
    function gf() { return glassFill(L / 2, -L / 2); }
    function fillItems(list, def) {
      list.forEach(function (it) {
        var paint = it.paint || def;
        g.beginPath(); tracePolys(g, [it], 0, L, W);
        if (paint === 'line') { g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.02; g.stroke(); return; }
        if (paint === 'carbon') { g.save(); carbonWeave(g, L, W, '#1b1d20'); g.restore(); return; }
        if (paint === 'body') {
          // body-colour details (bulges, scoops, ribs, blades): a touch lighter, with a dark edge and a light offset edge
          g.fillStyle = shade(m.paint, 0.07); g.fill();
          g.strokeStyle = 'rgba(0,0,0,0.30)'; g.lineWidth = 0.015; g.stroke();
          g.save(); g.translate(-0.01, 0.01); g.beginPath(); tracePolys(g, [it], 0, L, W);
          g.strokeStyle = m.finish === 'matte' ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.22)'; g.lineWidth = 0.01; g.stroke(); g.restore();
          return;
        }
        g.fillStyle = shapePaint(g, m, paint, gf); g.fill();
      });
    }
    // glasshouse (screens + side glass seen through the tumblehome)
    var ghList = P.greenhouse.map(function (it) { return { polys: it.polys, paint: it.paint === 'black' ? 'glass' : it.paint }; });
    var traceGh = function () { g.beginPath(); tracePolys(g, P.greenhouse, 0, L, W); };
    if (P.cockpit.length && P.greenhouse.length) {
      // roadster windscreen: inset from the body sides (the frame / A-pillars are body colour) and squashed
      // lengthwise towards the cockpit edge so it reads as a raked screen, not a tarp
      var ghb = polysBox(P.greenhouse), ghw = ghb ? Math.max(Math.abs(ghb.y0), Math.abs(ghb.y1)) : 0;
      var kyS = ghw > 0.2 ? (ghw - 0.08) / ghw : 1, kxS = 0.8, cxS = ghb ? ghb.x0 : 0;
      traceGh = function () { g.beginPath(); tracePolysScaled(g, P.greenhouse, cxS, kxS, kyS); };
      ghList.forEach(function (it) {
        g.beginPath(); tracePolysScaled(g, [it], cxS, kxS, kyS);
        g.fillStyle = shapePaint(g, m, it.paint || 'glass', gf); g.fill();
      });
    } else fillItems(ghList, 'glass');
    if (P.greenhouse.length) {
      g.save(); traceGh(); g.clip();
      var rb = P.roofBox, gx = rb ? rb.x1 : L * 0.1;
      var split = !!(rb && P.roof.length && !P.cockpit.length);
      if (split) {
        // side glass seen through the tumblehome: a thin dark strip beside the roof
        g.fillStyle = 'rgba(15,19,24,0.85)';
        g.fillRect(rb.x0, -W, rb.x1 - rb.x0, W + rb.y0);
        g.fillRect(rb.x0, rb.y1, rb.x1 - rb.x0, W);
        // reflections only on the windscreen and backlight (fore / aft of the roof)
        g.beginPath(); g.rect(rb.x1, -W, L, W * 2); g.rect(-L, -W, rb.x0 + L, W * 2); g.clip();
      }
      var sh = g.createLinearGradient(gx + 0.6, W * 0.3, gx, -W * 0.3);
      sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.45, 'rgba(255,255,255,0.14)'); sh.addColorStop(0.6, 'rgba(255,255,255,0)');
      g.fillStyle = sh; g.fillRect(-L, -W, L * 2, W * 2);
      g.restore();
    }
    // open cockpit with seats
    if (P.cockpit.length) {
      fillItems(P.cockpit, 'interior');
      var cb = null;
      P.cockpit.forEach(function (it) { it.polys.forEach(function (pl) { pl.pts.forEach(function (p) {
        cb = cb || { x0: p[0], x1: p[0], y0: p[1], y1: p[1] };
        cb.x0 = Math.min(cb.x0, p[0]); cb.x1 = Math.max(cb.x1, p[0]); cb.y0 = Math.min(cb.y0, p[1]); cb.y1 = Math.max(cb.y1, p[1]);
      }); }); });
      if (cb) {
        var cl = cb.x1 - cb.x0, cw = cb.y1 - cb.y0;
        g.fillStyle = shade(m.interior, 0.15);
        [-1, 1].forEach(function (s) {
          var sy = (cb.y0 + cb.y1) / 2 + s * cw * 0.25, sx0 = cb.x0 + cl * 0.12;
          g.fillStyle = shade(m.interior, 0.15);
          g.beginPath(); roundRectPath(g, sx0, sy - cw * 0.18, cl * 0.55, cw * 0.36, 0.1); g.fill();
          // seat back (rounded, darker) and centre bolster line
          g.fillStyle = shade(m.interior, 0.32);
          g.beginPath(); roundRectPath(g, sx0 - 0.02, sy - cw * 0.19, Math.min(0.2, cl * 0.2), cw * 0.38, 0.07); g.fill();
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.02;
          g.beginPath(); g.moveTo(sx0 + 0.03, sy); g.lineTo(sx0 + cl * 0.5, sy); g.stroke();
        });
        // steering wheel: a rim ring with a small hub (left-hand drive side)
        var swx = cb.x0 + cl * 0.82, swy = (cb.y0 + cb.y1) / 2 + cw * 0.25, swr = Math.min(0.18, cw * 0.17);
        g.strokeStyle = '#1c1c1c'; g.lineWidth = 0.035; g.beginPath(); g.arc(swx, swy, swr, 0, TAU); g.stroke();
        g.fillStyle = '#1c1c1c'; g.beginPath(); g.arc(swx, swy, Math.min(0.045, swr * 0.3), 0, TAU); g.fill();
        g.strokeStyle = 'rgba(28,28,28,0.9)'; g.lineWidth = 0.02; g.beginPath(); g.moveTo(swx, swy - swr); g.lineTo(swx, swy + swr); g.stroke();
      }
    }
    // roof panel (body / black / contrast / glass / carbon per build)
    if (P.roof.length && !P.cockpit.length) {
      // inset 0.03 m so a thin pillar / glass line shows around the roof panel
      var rbx = P.roofBox, rcx = rbx ? (rbx.x0 + rbx.x1) / 2 : 0;
      var rkx = rbx && rbx.x1 - rbx.x0 > 0.2 ? 1 - 0.06 / (rbx.x1 - rbx.x0) : 1;
      var rky = rbx && rbx.y1 - rbx.y0 > 0.2 ? 1 - 0.06 / (rbx.y1 - rbx.y0) : 1;
      var traceRoof = function () { g.beginPath(); tracePolysScaled(g, P.roof, rcx, rkx, rky); };
      g.save(); traceRoof();
      var roofPaint = P.roof[0].paint;
      if (m.roof === 'carbon' || (roofPaint === 'carbon' && (!m.roof || m.roof === 'body'))) {
        carbonWeave(g, L, W, '#1b1c1f');
      } else if (m.roof === 'black') { g.fillStyle = '#121314'; g.fill(); }
      else if (m.roof === 'contrast') { g.fillStyle = m.roofColor; g.fill(); }
      else if (m.roof === 'glass' || roofPaint === 'glass') { g.fillStyle = gf(); g.fill(); }
      else if (m.twoTone && (roofPaint === 'body' || !roofPaint)) { g.fillStyle = '#f1f1ec'; g.fill(); }
      else { g.fillStyle = shapePaint(g, m, roofPaint === 'body' || !roofPaint ? 'body' : roofPaint, gf); g.fill(); if (roofPaint === 'body' || !roofPaint) { g.clip(); stripeOverlay(g, m); } }
      g.restore();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.02; traceRoof(); g.stroke();
    }
    fillItems(P.roofGlass, 'glass');
    // pickup beds, tonneaus and roll hoops get their own treatment; the rest are generic top-view details
    var floors = P.details.filter(function (it) { return it.role === 'bedFloor'; });
    var floorBoxes = floors.map(function (it) { return polysBox([it]); });
    var special = function (it) {
      if (it.role === 'bedFloor' || it.role === 'tonneau' || it.role === 'rollHoop') return true;
      if (it.role !== 'trim' || it.paint !== 'black') return false;
      var b = polysBox([it]);   // the bed outline that encloses a bed floor
      return !!b && floorBoxes.some(function (fb) { return fb && b.x0 <= fb.x0 && b.x1 >= fb.x1 && b.y0 <= fb.y0 && b.y1 >= fb.y1; });
    };
    var generic = P.details.filter(function (it) { return !special(it); });
    var rank = function (it) { return it.role === 'trim' ? 0 : 1; };   // bed outlines under their floors
    P.details.filter(special).sort(function (a, b) { return rank(a) - rank(b); }).forEach(function (it) {
      if (it.role === 'rollHoop') return;
      if (it.role === 'tonneau') {
        g.save(); g.beginPath(); tracePolys(g, [it], 0, L, W); g.fillStyle = '#3a3d42'; g.fill(); g.clip();
        var tb = polysBox([it]);
        if (tb) {
          g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.012;
          for (var tx = tb.x0 + 0.12; tx < tb.x1; tx += 0.12) { g.beginPath(); g.moveTo(tx, tb.y0); g.lineTo(tx, tb.y1); g.stroke(); }
        }
        g.restore(); return;
      }
      if (it.role === 'bedFloor') {
        g.save(); g.beginPath(); tracePolys(g, [it], 0, L, W); g.fillStyle = '#2b2d31'; g.fill(); g.clip();
        var fb = polysBox([it]);
        if (fb) {
          g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 0.03;
          for (var ri = 1; ri <= 5; ri++) { var ry = fb.y0 + (fb.y1 - fb.y0) * ri / 6; g.beginPath(); g.moveTo(fb.x0, ry); g.lineTo(fb.x1, ry); g.stroke(); }
          // inner wall shadow along the bed rails
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.05; g.beginPath(); tracePolys(g, [it], 0, L, W); g.stroke();
        }
        g.restore();
        // body-colour bed rails, 0.10 m wide around the inside of the bed outline
        g.strokeStyle = shade(m.paint, -0.08); g.lineWidth = 0.1; g.beginPath(); tracePolys(g, [it], 0, L, W); g.stroke();
        return;
      }
      // bed outline (rails / tailgate top) in body colour
      g.beginPath(); tracePolys(g, [it], 0, L, W); g.fillStyle = paintGradient(g, m); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.015; g.stroke();
    });
    // top-view details (wipers, vents, spoilers, roll hoops, lamps)
    fillItems(generic, 'black');
    P.details.forEach(function (it) {
      if (it.role !== 'rollHoop') return;
      var hb = polysBox([it]); if (!hb) return;
      var hx = (hb.x0 + hb.x1) / 2, bow = Math.min(0.06, (hb.x1 - hb.x0) * 0.35), lw = Math.min(0.06, Math.max(0.03, (hb.x1 - hb.x0) * 0.4));
      var arc = function () { g.beginPath(); g.moveTo(hx + bow * 0.5, hb.y0); g.quadraticCurveTo(hx - bow, (hb.y0 + hb.y1) / 2, hx + bow * 0.5, hb.y1); };
      g.lineCap = 'round';
      g.strokeStyle = '#1a1c1f'; g.lineWidth = lw; arc(); g.stroke();
      g.save(); g.translate(0.012, 0); g.strokeStyle = 'rgba(214,219,225,0.75)'; g.lineWidth = 0.02; arc(); g.stroke(); g.restore();
      g.lineCap = 'butt';
    });
    // roof rails (wagons, SUVs, Taycan Cross Turismo): two bars at +-0.88 of the roof half-width
    var rr = P.roof.length ? P.roofBox : null;
    if (rr && (m.style === 'wagon' || m.style === 'suv' || P.id === 'porsche-taycan-cross-turismo') && rr.x1 - rr.x0 > 0.8) {
      var rhw = (rr.y1 - rr.y0) / 2 * 0.88, rmy = (rr.y0 + rr.y1) / 2, rx0 = rr.x0 + 0.12, rx1 = rr.x1 - 0.18;
      g.lineCap = 'round';
      [-1, 1].forEach(function (s) {
        var y = rmy + s * rhw;
        g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 0.05; g.beginPath(); g.moveTo(rx0 + 0.02, y - 0.02); g.lineTo(rx1 + 0.02, y - 0.02); g.stroke();
        g.strokeStyle = '#8c9298'; g.lineWidth = 0.04; g.beginPath(); g.moveTo(rx0, y); g.lineTo(rx1, y); g.stroke();
        g.strokeStyle = 'rgba(240,244,248,0.55)'; g.lineWidth = 0.01; g.beginPath(); g.moveTo(rx0 + 0.03, y + 0.01); g.lineTo(rx1 - 0.03, y + 0.01); g.stroke();
      });
      g.lineCap = 'butt';
    }
    // vans: rear-door top shut line (barn-door split on the boxy vans) and the sliding-door track on the right
    if (m.style === 'van') {
      var xb = Infinity, xf = -Infinity, hwb = 0;
      P.bodyPts.forEach(function (p) { if (p[0] < xb) xb = p[0]; if (p[0] > xf) xf = p[0]; if (Math.abs(p[1]) > hwb) hwb = Math.abs(p[1]); });
      g.save(); bodyPath(g, m, 0); g.clip();
      g.strokeStyle = 'rgba(0,0,0,0.32)'; g.lineWidth = 0.018;
      var dl = xb + 0.07;
      g.beginPath(); g.moveTo(dl, -hwb); g.lineTo(dl, hwb); g.stroke();
      if (P.id !== 'vw-id-buzz') { g.beginPath(); g.moveTo(xb - 0.05, 0); g.lineTo(dl, 0); g.stroke(); }
      var sy = -(hwb - 0.06), sx1 = m.axF - m.tireLen * 0.6, sx0 = sx1 - Math.min(1.4, (m.axF - m.axR) * 0.45);
      g.beginPath(); g.moveTo(sx0, sy); g.lineTo(sx1, sy); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 0.01;
      g.beginPath(); g.moveTo(dl + 0.012, -hwb); g.lineTo(dl + 0.012, hwb); g.stroke();
      g.restore();
    }
    // mirrors
    var mc = m.mirrors === 'black' ? '#141414' : m.mirrors === 'carbon' ? '#202124' : null;
    g.save(); g.translate(0.03, -0.03); g.fillStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); tracePolys(g, P.mirrors, 0, L, W); g.fill(); g.restore();
    P.mirrors.forEach(function (it) {
      g.beginPath(); tracePolys(g, [it], 0, L, W);
      g.fillStyle = mc || (it.paint && it.paint !== 'body' ? shapePaint(g, m, it.paint, gf) : shade(m.paint, -0.05)); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.012; g.stroke();
    });
  }

  function buildCarSprite(m, ppm) {
    var pad = 0.5, L = m.L, W = m.W, H = m.H;
    var cw = (L + pad * 2) * ppm, ch = (W + pad * 2) * ppm;
    var c = makeCanvas(cw, ch), g = ctx2d(c);
    if (!g) return null;
    g.setTransform(ppm, 0, 0, ppm, (L / 2 + pad) * ppm, (W / 2 + pad) * ppm);
    g.lineJoin = 'round';
    var R = rng(hashStr(m.key));
    var fx = m.fx;
    // --- aero under-parts that stick out (splitter, diffuser)
    if (m.splitter === 'carbon' || m.splitter === 'race') {
      var ext = m.splitter === 'race' ? 0.14 : 0.07;
      g.fillStyle = '#16181b';
      g.beginPath(); roundRectPath(g, L / 2 - 0.25, -W / 2 * m.noseW * 1.02, 0.25 + ext, W * m.noseW * 1.02, 0.08); g.fill();
      if (m.splitter === 'race') { g.fillStyle = '#2a2d31'; g.fillRect(L / 2 - 0.3, W / 2 * m.noseW - 0.02, 0.34, 0.04); g.fillRect(L / 2 - 0.3, -W / 2 * m.noseW - 0.02, 0.34, 0.04); }
    }
    if (m.diffuser === 'carbon' || m.diffuser === 'race') {
      g.fillStyle = '#141619';
      g.fillRect(-L / 2 - 0.08, -W * 0.3, 0.2, W * 0.6);
      g.fillStyle = '#2b2f34';
      for (var d = -2; d <= 2; d++) g.fillRect(-L / 2 - 0.08, d * W * 0.12 - 0.015, 0.16, 0.03);
    }
    // exhaust tips
    g.fillStyle = '#b9bec4';
    m.exhaust.forEach(function (e) { g.beginPath(); g.arc(e.x + 0.02, e.y, 0.05, 0, TAU); g.fill(); });
    // --- body
    g.fillStyle = 'rgba(0,0,0,0.55)'; bodyPath(g, m, 0.035); g.fill();
    bodyPath(g, m, 0); g.fillStyle = paintGradient(g, m); g.fill();
    g.save();
    bodyPath(g, m, 0); g.clip();
    if (m.finish === 'chameleon') {
      var cg = g.createLinearGradient(L / 2, 0, -L / 2, 0);
      cg.addColorStop(0, rgba(hueShift(m.paint, -35), 0.55)); cg.addColorStop(0.5, rgba(m.paint, 0)); cg.addColorStop(1, rgba(hueShift(m.paint, 70), 0.55));
      g.fillStyle = cg; g.fillRect(-L, -W, L * 2, W * 2);
    }
    if (m.finish === 'metallic' || m.finish === 'pearl' || m.finish === 'candy' || m.finish === 'chameleon') {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      for (var fl = 0; fl < 260; fl++) g.fillRect((R() - 0.5) * L, (R() - 0.5) * W, 0.02, 0.02);
    }
    // wheel arches: a thin dark edge along the outline over each tyre so the axles read from above
    if (m.shape) {
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 0.035;
      [m.axF, m.axR].forEach(function (ax) {
        g.save(); g.beginPath(); g.rect(ax - m.tireLen * 0.55, -W, m.tireLen * 1.1, W * 2); g.clip();
        bodyPath(g, m, 0); g.stroke(); g.restore();
      });
    }
    // longitudinal highlight (shoulder line reflections)
    var sh = g.createLinearGradient(L / 2, 0, -L / 2, 0);
    sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.3, 'rgba(255,255,255,' + (m.finish === 'matte' ? 0.03 : 0.10) + ')'); sh.addColorStop(0.7, 'rgba(255,255,255,0)');
    g.fillStyle = sh; g.fillRect(-L, -W * 0.3, L * 2, W * 0.14);
    // --- stripes
    var sc = m.stripeColor;
    switch (m.stripe) {
      case 'racing-dual':
        g.fillStyle = sc; g.fillRect(-L, W * 0.06, L * 2, W * 0.13); g.fillRect(-L, -W * 0.19, L * 2, W * 0.13); break;
      case 'center':
        g.fillStyle = sc; g.fillRect(-L, -W * 0.12, L * 2, W * 0.24);
        g.fillStyle = rgba(m.paint, 0.9); g.fillRect(-L, -W * 0.012, L * 2, W * 0.024); break;
      case 'le-mans':
        g.fillStyle = sc; g.fillRect(-L, W * 0.02, L * 2, W * 0.2);
        g.fillStyle = shade(sc, -0.3); g.fillRect(-L, W * 0.22, L * 2, W * 0.03); break;
      case 'hood':
        g.fillStyle = 'rgba(15,15,17,0.82)';
        g.beginPath(); g.moveTo(fx(0.03), -W * 0.26); g.lineTo(fx(H.hoodLength * 0.9), -W * 0.3); g.lineTo(fx(H.hoodLength * 0.9), W * 0.3); g.lineTo(fx(0.03), W * 0.26); g.closePath(); g.fill(); break;
      case 'side-skirt':
        g.fillStyle = sc; g.fillRect(fx(0.85), W / 2 * 0.9, L * 0.6, W * 0.06); g.fillRect(fx(0.85), -W / 2 * 0.9 - W * 0.06, L * 0.6, W * 0.06); break;
      case 'pinstripe':
        g.strokeStyle = sc; g.lineWidth = 0.025; bodyPath(g, m, -0.12); g.stroke(); break;
      case 'gradient': {
        var gg = g.createLinearGradient(-L / 2, 0, L * 0.1, 0);
        gg.addColorStop(0, rgba(sc, 0.95)); gg.addColorStop(1, rgba(sc, 0));
        g.fillStyle = gg; g.fillRect(-L, -W, L * 2, W * 2); break;
      }
    }
    // panel shut lines
    if (m.shape) shapePanels(g, m);
    else {
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.018;
    var hx = fx(H.hoodLength), hw = bodyHalfAt(m, H.hoodLength) * 0.92;
    g.beginPath(); g.moveTo(hx + 0.05, hw); g.quadraticCurveTo(hx - 0.06, 0, hx + 0.05, -hw); g.stroke();
    if (H.tailStyle !== 'bed' && H.tailStyle !== 'box') {
      var bx = fx(Math.min(0.96, H.cabinEnd + 0.02)), bw = bodyHalfAt(m, H.cabinEnd) * 0.85;
      g.beginPath(); g.moveTo(bx, bw); g.quadraticCurveTo(bx + 0.05, 0, bx, -bw); g.stroke();
    }
    // bonnet power bulge / vents
    if (H.noseStyle !== 'blunt' && H.hoodLength > 0.2) {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.beginPath(); g.ellipse ? g.ellipse(fx(H.hoodLength * 0.55), 0, L * H.hoodLength * 0.32, W * 0.13, 0, 0, TAU) : g.rect(fx(H.hoodLength * 0.8), -W * 0.12, L * H.hoodLength * 0.5, W * 0.24); g.fill();
      if (m.wing !== 'none' || m.splitter === 'race') {
        g.fillStyle = 'rgba(10,10,12,0.55)';
        [-1, 1].forEach(function (s) { for (var v = 0; v < 4; v++) g.fillRect(fx(H.hoodLength * 0.5) + v * 0.07, s * W * 0.2 - 0.04, 0.035, 0.08); });
      }
    }
    }
    if (m.skirts) { g.fillStyle = 'rgba(12,12,14,0.55)'; g.fillRect(m.axR + 0.35, W / 2 * m.waist - 0.05, m.axF - m.axR - 0.7, 0.07); g.fillRect(m.axR + 0.35, -W / 2 * m.waist - 0.02, m.axF - m.axR - 0.7, 0.07); }
    g.restore();

    // --- glasshouse
    var tint = clamp(m.tint, 0, 85) / 100;
    var glassCol = mix('#4a6177', '#05080c', 0.55 + tint * 0.4);
    function glassFill(x0, x1) {
      var gr = g.createLinearGradient(x0, -W / 2, x1, W / 2);
      gr.addColorStop(0, shade(glassCol, 0.25)); gr.addColorStop(0.45, glassCol); gr.addColorStop(0.55, shade(glassCol, 0.12)); gr.addColorStop(1, shade(glassCol, -0.3));
      return gr;
    }
    var fs = H.cabinStart, frs = H.roofStart, fre = H.roofEnd, fce = H.cabinEnd;
    var wA = bodyHalfAt(m, fs) * 0.80, wR = bodyHalfAt(m, (frs + fre) / 2) * 0.70, wC = bodyHalfAt(m, fce) * 0.62;
    if (m.shape) shapeCabin(g, m, glassFill);
    else {
    if (H.openTop) {
      // cockpit tub, seats, roll hoops, low screen
      g.fillStyle = shade(m.interior, -0.1);
      g.beginPath(); roundRectPath(g, fx(fce), -wR * 1.1, (fce - frs + 0.06) * L, wR * 2.2, 0.18); g.fill();
      g.fillStyle = shade(m.interior, 0.15);
      [-1, 1].forEach(function (s) { g.beginPath(); roundRectPath(g, fx(fce) + 0.08, s * wR * 0.52 - wR * 0.38, (fce - frs) * L * 0.62, wR * 0.76, 0.12); g.fill(); });
      g.fillStyle = '#1c1c1c'; g.beginPath(); g.arc(fx(frs) - 0.12, wR * 0.5, 0.17, 0, TAU); g.fill();
      g.strokeStyle = '#3b3f44'; g.lineWidth = 0.06;
      [-1, 1].forEach(function (s) { g.beginPath(); g.arc(fx(fce) + 0.1, s * wR * 0.52, wR * 0.34, -HALF_PI, HALF_PI); g.stroke(); });
      taperQuad(g, m, fs, frs - 0.03, wA, wA * 0.9); g.fillStyle = glassFill(fx(fs), fx(frs)); g.fill();
    } else {
      // windscreen
      taperQuad(g, m, fs, frs, wA, wR); g.fillStyle = glassFill(fx(fs), fx(frs)); g.fill();
      // side glass (visible through the tumblehome)
      g.fillStyle = shade(glassCol, -0.1);
      [-1, 1].forEach(function (s) {
        g.beginPath();
        g.moveTo(fx(frs), s * wR); g.lineTo(fx(fre), s * wR);
        g.lineTo(fx(fce - 0.02), s * bodyHalfAt(m, fce - 0.02) * 0.84); g.lineTo(fx(fs + 0.04), s * bodyHalfAt(m, fs + 0.04) * 0.86);
        g.closePath(); g.fill();
      });
      // rear glass / tailgate
      if (H.tailStyle === 'bed') {
        taperQuad(g, m, fre, fce, wR, wR * 0.98); g.fillStyle = glassFill(fx(fre), fx(fce)); g.fill();
        // pickup bed
        var b0 = fce + 0.02, b1 = 0.975, bw0 = bodyHalfAt(m, b0) * 0.86;
        g.fillStyle = '#1f2124'; g.fillRect(fx(b1), -bw0, (b1 - b0) * L, bw0 * 2);
        g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 0.03;
        for (var rb = -3; rb <= 3; rb++) { g.beginPath(); g.moveTo(fx(b1), rb * bw0 / 4); g.lineTo(fx(b0), rb * bw0 / 4); g.stroke(); }
        g.strokeStyle = shade(m.paint, -0.25); g.lineWidth = 0.08; g.strokeRect(fx(b1), -bw0, (b1 - b0) * L, bw0 * 2);
      } else {
        var rearEnd = H.tailStyle === 'box' || H.tailStyle === 'wagon' ? Math.min(0.985, fce) : fce;
        taperQuad(g, m, fre, rearEnd, wR, wC); g.fillStyle = glassFill(fx(fre), fx(rearEnd)); g.fill();
        if (H.tailStyle === 'fastback' || H.tailStyle === 'longtail') {
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.02;
          for (var lv = 1; lv < 6; lv++) { var lf = lerp(fre, rearEnd, lv / 6); g.beginPath(); g.moveTo(fx(lf), wC); g.lineTo(fx(lf), -wC); g.stroke(); }
        }
      }
      // roof panel
      var roofCol = m.roof === 'black' ? '#121314' : m.roof === 'contrast' ? m.roofColor : m.roof === 'glass' ? shade(glassCol, -0.15) : null;
      g.beginPath(); roundRectPath(g, fx(fre), -wR, (fre - frs) * L, wR * 2, 0.12);
      if (m.roof === 'carbon' && W) {
        g.fillStyle = '#1b1c1f'; g.fill();
        g.save(); g.clip(); g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 0.02;
        for (var cx = -2; cx < 2; cx += 0.06) { g.beginPath(); g.moveTo(fx(fre) + cx, -wR); g.lineTo(fx(fre) + cx + wR * 2, wR); g.stroke(); }
        g.restore();
      } else if (roofCol) {
        g.fillStyle = roofCol; g.fill();
      } else {
        g.fillStyle = paintGradient(g, m); g.fill();
        if (m.stripe === 'racing-dual') { g.save(); g.clip(); g.fillStyle = m.stripeColor; g.fillRect(-L, W * 0.06, L * 2, W * 0.13); g.fillRect(-L, -W * 0.19, L * 2, W * 0.13); g.restore(); }
        else if (m.stripe === 'center') { g.save(); g.clip(); g.fillStyle = m.stripeColor; g.fillRect(-L, -W * 0.12, L * 2, W * 0.24); g.restore(); }
        else if (m.stripe === 'le-mans') { g.save(); g.clip(); g.fillStyle = m.stripeColor; g.fillRect(-L, W * 0.02, L * 2, W * 0.2); g.restore(); }
      }
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.02;
      g.beginPath(); roundRectPath(g, fx(fre), -wR, (fre - frs) * L, wR * 2, 0.12); g.stroke();
      // windscreen reflection
      g.fillStyle = 'rgba(255,255,255,0.13)';
      g.beginPath(); g.moveTo(fx(fs) - 0.03, wA * 0.6); g.lineTo(fx(frs) + 0.05, wR * 0.2); g.lineTo(fx(frs) + 0.05, -wR * 0.1); g.lineTo(fx(fs) - 0.03, wA * 0.1); g.closePath(); g.fill();
    }
    // --- mirrors
    var mc = m.mirrors === 'black' ? '#141414' : m.mirrors === 'carbon' ? '#202124' : shade(m.paint, -0.05);
    [-1, 1].forEach(function (s) {
      var mx = fx(fs + 0.035), my = s * (bodyHalfAt(m, fs + 0.035) + 0.07);
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(mx - 0.03, my - 0.07, 0.14, 0.14);
      g.fillStyle = mc; g.beginPath(); roundRectPath(g, mx - 0.05, my - 0.07, 0.16, 0.14, 0.05); g.fill();
    });
    }
    // --- canards
    if (m.canards) {
      g.fillStyle = '#1b1d20';
      [-1, 1].forEach(function (s) { g.beginPath(); g.moveTo(fx(0.04), s * W / 2 * m.noseW * 1.02); g.lineTo(fx(0.1), s * (W / 2 * 0.98 + 0.06)); g.lineTo(fx(0.11), s * W / 2 * 0.95); g.closePath(); g.fill(); });
    }
    // --- lights (off state; brake / head glow is dynamic)
    var lc = LIGHT_COL[m.lights] || LIGHT_COL.led;
    if (m.shape) { g.save(); bodyPath(g, m, 0); g.clip(); }
    m.heads.forEach(function (r) {
      if (m.shape && m.headsInDetails) return;   // the real lamp shape is already drawn by the top-view details
      g.fillStyle = '#2a2d31'; g.beginPath(); roundRectPath(g, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 0.04); g.fill();
      g.fillStyle = lc; g.beginPath(); roundRectPath(g, r.x0 + 0.02, r.y0 + 0.02, r.x1 - r.x0 - 0.04, r.y1 - r.y0 - 0.04, 0.03); g.fill();
      if (m.lights !== 'halogen') { g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(r.x0 + 0.01, r.y0 + 0.02, 0.025, r.y1 - r.y0 - 0.04); }
    });
    (m.drl || []).forEach(function (r) {
      g.fillStyle = lc; g.beginPath(); roundRectPath(g, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 0.02); g.fill();
    });
    m.tails.forEach(function (r) {
      if (m.shape) {
        // dark outline, bright lens, thin highlight along the rear edge; outboard corners rounded to follow the body
        var dx = r.x1 - r.x0, dy = r.y1 - r.y0, rad = Math.min(dy * 0.4, dx * 0.6);
        var outL = r.y1 > 0.05, outR = r.y0 < -0.05;   // outboard side(s): +y (left), -y (right), both for full-width bars
        var lamp = function (gr) {
          var x0 = r.x0 - gr, x1 = r.x1 + gr, y0 = r.y0 - gr, y1 = r.y1 + gr;
          var rRL = outR ? rad : 0.02, rFL = outR ? rad * 0.5 : 0.02, rRH = outL ? rad : 0.02, rFH = outL ? rad * 0.5 : 0.02;
          g.beginPath();
          g.moveTo(x0 + rRL, y0); g.lineTo(x1 - rFL, y0); g.arcTo(x1, y0, x1, y0 + rFL, rFL);
          g.lineTo(x1, y1 - rFH); g.arcTo(x1, y1, x1 - rFH, y1, rFH);
          g.lineTo(x0 + rRH, y1); g.arcTo(x0, y1, x0, y1 - rRH, rRH);
          g.lineTo(x0, y0 + rRL); g.arcTo(x0, y0, x0 + rRL, y0, rRL);
          g.closePath();
        };
        g.fillStyle = '#1a0204'; lamp(0.02); g.fill();
        g.fillStyle = '#c8141e'; lamp(0); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.012;
        g.beginPath(); g.moveTo(r.x0 + 0.025, r.y0 + (outR ? rad : 0.02)); g.lineTo(r.x0 + 0.025, r.y1 - (outL ? rad : 0.02)); g.stroke();
        return;
      }
      g.fillStyle = '#4a0606'; g.beginPath(); roundRectPath(g, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 0.03); g.fill();
      g.fillStyle = 'rgba(255,60,60,0.35)'; g.fillRect(r.x0 + 0.02, r.y0 + 0.01, (r.x1 - r.x0) * 0.4, r.y1 - r.y0 - 0.02);
    });
    if (m.shape) g.restore();
    // --- wing
    var wingX = fx(0.935), wingOn = true;
    var chordW = m.wing === 'active' ? 0.22 : 0.3;
    if (m.shape) {
      // real tail: over the deck lid's rear edge (bed tonneau on pickups; open beds get no wing)
      var SP = m.shape, xRear = Infinity;
      SP.bodyPts.forEach(function (p) { if (p[0] < xRear) xRear = p[0]; });
      var tonneau = SP.details.filter(function (it) { return it.role === 'tonneau'; });
      var hasBed = SP.details.some(function (it) { return it.role === 'bedFloor'; }) || (m.style === 'pickup' && !tonneau.length);
      var db = tonneau.length ? polysBox(tonneau) : hasBed ? null : SP.deck.length ? polysBox(SP.deck) : null;
      if (hasBed && !tonneau.length) wingOn = false;
      else {
        // keep the tail lamps visible: the wing's trailing edge sits just ahead of them
        var lampFront = xRear; m.tails.forEach(function (r) { if (r.x1 > lampFront) lampFront = r.x1; });
        var trail = db && db.x1 - db.x0 > chordW * 0.5 ? db.x0 : xRear + 0.35 - chordW / 2;
        wingX = Math.max(trail, lampFront + 0.03, xRear + 0.05) + chordW / 2;
      }
    }
    if (wingOn && (m.wing === 'gt-wing' || m.wing === 'swan-neck' || m.wing === 'biplane' || m.wing === 'active')) {
      var span = W * 0.94, chord = chordW;
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(wingX - chord / 2 - 0.05, -span / 2 + 0.05, chord, span);
      var wc = m.wing === 'active' ? shade(m.paint, -0.15) : '#1a1b1e';
      g.fillStyle = wc; g.beginPath(); roundRectPath(g, wingX - chord / 2, -span / 2, chord, span, 0.05); g.fill();
      if (m.wing !== 'active') {
        g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 0.015;
        for (var ws = -span / 2; ws < span / 2; ws += 0.05) { g.beginPath(); g.moveTo(wingX - chord / 2, ws); g.lineTo(wingX + chord / 2, ws + 0.05); g.stroke(); }
      }
      if (m.wing === 'biplane') { g.fillStyle = '#26282c'; g.beginPath(); roundRectPath(g, wingX + chord / 2 + 0.04, -span / 2 + 0.05, 0.16, span - 0.1, 0.04); g.fill(); }
      g.fillStyle = m.wing === 'active' ? m.accent : '#2d3035';
      g.fillRect(wingX - chord / 2 - 0.05, span / 2 - 0.03, chord + 0.12, 0.05);
      g.fillRect(wingX - chord / 2 - 0.05, -span / 2 - 0.02, chord + 0.12, 0.05);
      g.fillStyle = rgba(m.accent, 0.9); g.fillRect(wingX + chord / 2 - 0.035, -span / 2 + 0.03, 0.03, span - 0.06);
    } else if (m.wing === 'ducktail') {
      g.fillStyle = shade(m.paint, 0.18);
      g.beginPath(); g.moveTo(fx(0.9), -W * 0.38); g.quadraticCurveTo(fx(0.99), 0, fx(0.9), W * 0.38); g.lineTo(fx(0.94), W * 0.36); g.quadraticCurveTo(fx(1.0), 0, fx(0.94), -W * 0.36); g.closePath(); g.fill();
    } else if (m.wing === 'lip-spoiler') {
      g.strokeStyle = '#141416'; g.lineWidth = 0.05;
      g.beginPath(); g.moveTo(fx(0.955), -W * 0.36); g.quadraticCurveTo(fx(0.975), 0, fx(0.955), W * 0.36); g.stroke();
    }
    // --- number roundel on the roof (bonnet for open cars)
    if (m.number) {
      var nfx = H.openTop ? H.hoodLength * 0.5 : (frs + fre) / 2;
      var nr = Math.min(wR * 0.82, (fre - frs) * L * 0.42, 0.46);
      if (H.openTop) nr = Math.min(W * 0.2, 0.42);
      if (m.stripe === 'le-mans') { nfx = H.hoodLength * 0.5; nr = Math.min(W * 0.2, 0.42); }
      var nx = fx(nfx);
      if (m.shape) {
        var nb = (m.shape.cockpit.length || m.stripe === 'le-mans' || !m.shape.roofBox) ? m.shape.hoodBox : m.shape.roofBox;
        if (nb) { nx = (nb.x0 + nb.x1) / 2; nr = Math.max(0.16, Math.min(nb.y1 - nb.y0, nb.x1 - nb.x0) * 0.28); }
      }
      nr = Math.min(nr, 0.28);
      g.fillStyle = '#f7f7f5'; g.beginPath(); g.arc(nx, 0, nr, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.02; g.stroke();
      g.fillStyle = '#111';
      worldText(g, m.number, nx, 0, -HALF_PI, nr * (m.number.length > 2 ? 0.85 : 1.15), '900');
    }
    // --- final gloss sheen + outline
    g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 0.03; bodyPath(g, m, 0); g.stroke();
    return { canvas: c, pad: pad, ppm: ppm };
  }

  /** Draws a car's wheels (under the body) with steering and rolling tread. */
  function drawWheels(ctx, m, steer, phase, ppm) {
    var tl = m.tireLen;
    var fo = m.shape ? 0.02 : 0;   // front tyres a touch outboard so steering shows past the body
    var wheels = [[m.axF, m.track / 2 + fo, m.twF, steer], [m.axF, -m.track / 2 - fo, m.twF, steer], [m.axR, m.track / 2, m.twR, 0], [m.axR, -m.track / 2, m.twR, 0]];
    for (var k = 0; k < 4; k++) {
      var w = wheels[k];
      ctx.save();
      ctx.translate(w[0], w[1]);
      if (w[3]) ctx.rotate(w[3]);
      ctx.fillStyle = '#0d0d0e';
      ctx.beginPath(); roundRectPath(ctx, -tl / 2, -w[2] / 2, tl, w[2], 0.07); ctx.fill();
      if (ppm > 9) {
        ctx.fillStyle = 'rgba(70,70,74,0.9)';
        var ph = mod(phase, 1) * 0.16;
        for (var t = -tl / 2 + ph; t < tl / 2; t += 0.16) ctx.fillRect(t, -w[2] / 2, 0.04, w[2]);
        ctx.fillStyle = shade(m.wheelFinish, 0.15);
        ctx.fillRect(-tl * 0.3, w[1] > 0 ? w[2] / 2 - 0.05 : -w[2] / 2, tl * 0.6, 0.05);
      }
      ctx.restore();
    }
  }

  /* ================================================================ effects: skid marks */

  var SKID_RUBBER = 0, SKID_DIRT = 1, SKID_WET = 2;

  function SkidBuffer(cap) {
    this.cap = cap;
    this.x0 = new Float32Array(cap); this.y0 = new Float32Array(cap);
    this.x1 = new Float32Array(cap); this.y1 = new Float32Array(cap);
    this.a = new Float32Array(cap); this.t = new Float32Array(cap);
    this.w = new Float32Array(cap); this.type = new Uint8Array(cap);
    this.head = 0; this.size = 0;
  }
  SkidBuffer.prototype.add = function (x0, y0, x1, y1, w, a, t, type) {
    var i = this.head;
    this.x0[i] = x0; this.y0[i] = y0; this.x1[i] = x1; this.y1[i] = y1;
    this.w[i] = w; this.a[i] = a; this.t[i] = t; this.type[i] = type;
    this.head = (i + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  };
  SkidBuffer.prototype.clear = function () { this.head = 0; this.size = 0; };
  /** Batched draw: 5 alpha buckets x 3 types, culled to box. */
  SkidBuffer.prototype.draw = function (ctx, box, t, wetness) {
    if (!this.size) return;
    var life = [150, 70, 25], cols = ['12,12,14', '74,56,34', '30,34,40'];
    var bucket = [[], [], []], k, i, b;
    for (k = 0; k < 3; k++) for (b = 0; b < 5; b++) bucket[k].push([]);
    var x0 = box.x0 - 2, x1 = box.x1 + 2, y0 = box.y0 - 2, y1 = box.y1 + 2;
    var wash = 1 + wetness * 1.5;
    for (k = 0; k < this.size; k++) {
      i = k;
      var ax = this.x0[i], ay = this.y0[i];
      if ((ax < x0 && this.x1[i] < x0) || (ax > x1 && this.x1[i] > x1) || (ay < y0 && this.y1[i] < y0) || (ay > y1 && this.y1[i] > y1)) continue;
      var ty = this.type[i], age = (t - this.t[i]) * (ty === SKID_RUBBER ? wash : 1);
      var f = this.a[i] * (age < 0 ? 1 : 1 - age / life[ty]);
      if (f <= 0.02) continue;
      b = f > 0.8 ? 4 : f > 0.6 ? 3 : f > 0.4 ? 2 : f > 0.2 ? 1 : 0;
      bucket[ty][b].push(i);
    }
    ctx.lineCap = 'round';
    for (var ty2 = 0; ty2 < 3; ty2++) {
      for (b = 0; b < 5; b++) {
        var list = bucket[ty2][b];
        if (!list.length) continue;
        var alpha = (b + 0.6) / 5 * (ty2 === SKID_RUBBER ? 0.55 : ty2 === SKID_DIRT ? 0.5 : 0.25);
        ctx.strokeStyle = 'rgba(' + cols[ty2] + ',' + alpha.toFixed(3) + ')';
        ctx.lineWidth = ty2 === SKID_DIRT ? 0.34 : 0.26;
        ctx.beginPath();
        for (k = 0; k < list.length; k++) { i = list[k]; ctx.moveTo(this.x0[i], this.y0[i]); ctx.lineTo(this.x1[i], this.y1[i]); }
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  };

  /* ================================================================ effects: particles */

  var PT = { SMOKE: 0, DUST: 1, GRASS: 2, SAND: 3, SPRAY: 4, SPARK: 5, DEBRIS: 6, FLAME: 7, SPLASH: 8, CONFETTI: 9, MIST: 10 };
  var PT_COLOR = ['#e9e9ea', '#b49a72', '#4c7a2c', '#d7c08c', '#dfe8f0', '#ffcf5a', '#2a2b2e', '#ff8a1f', '#cfe0ee', '#ffffff', '#c8d4de'];

  function Particles(cap) {
    this.cap = cap;
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.z = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.size = new Float32Array(cap); this.grow = new Float32Array(cap);
    this.alpha = new Float32Array(cap); this.rot = new Float32Array(cap);
    this.type = new Uint8Array(cap); this.col = new Uint32Array(cap);
    this.n = 0;
    this.limit = cap;
  }
  Particles.prototype.spawn = function (type, x, y, vx, vy, life, size, grow, alpha, vz, col) {
    if (this.n >= this.limit) {
      // recycle the oldest-looking slot (cheap: random replacement keeps distribution stable)
      var j = (Math.random() * this.n) | 0;
      this.n--; this.copy(this.n, j);
    }
    var i = this.n++;
    this.type[i] = type; this.x[i] = x; this.y[i] = y; this.z[i] = 0;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz || 0;
    this.life[i] = 0; this.max[i] = life; this.size[i] = size; this.grow[i] = grow || 0;
    this.alpha[i] = alpha == null ? 1 : alpha; this.rot[i] = Math.random() * TAU; this.col[i] = col || 0;
    return i;
  };
  Particles.prototype.copy = function (from, to) {
    this.type[to] = this.type[from]; this.x[to] = this.x[from]; this.y[to] = this.y[from]; this.z[to] = this.z[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.life[to] = this.life[from]; this.max[to] = this.max[from]; this.size[to] = this.size[from]; this.grow[to] = this.grow[from];
    this.alpha[to] = this.alpha[from]; this.rot[to] = this.rot[from]; this.col[to] = this.col[from];
  };
  Particles.prototype.update = function (dt, wind) {
    if (dt <= 0) return;
    var wx = wind ? wind.x : 0, wy = wind ? wind.y : 0;
    for (var i = 0; i < this.n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) { this.n--; this.copy(this.n, i); i--; continue; }
      var ty = this.type[i], drag;
      switch (ty) {
        case PT.SMOKE: case PT.DUST: case PT.MIST: case PT.SPRAY:
          drag = ty === PT.SPRAY ? 2.6 : 1.6;
          this.vx[i] += (wx - this.vx[i]) * Math.min(1, drag * dt); this.vy[i] += (wy - this.vy[i]) * Math.min(1, drag * dt);
          break;
        case PT.SPARK:
          this.vx[i] *= 1 - Math.min(1, 1.6 * dt); this.vy[i] *= 1 - Math.min(1, 1.6 * dt);
          break;
        case PT.GRASS: case PT.SAND: case PT.DEBRIS: case PT.CONFETTI:
          this.vz[i] -= 9.81 * dt * (ty === PT.CONFETTI ? 0.12 : 1);
          this.z[i] += this.vz[i] * dt;
          if (this.z[i] < 0) { this.z[i] = 0; this.vz[i] *= -0.25; this.vx[i] *= 0.5; this.vy[i] *= 0.5; }
          drag = ty === PT.CONFETTI ? 1.2 : 0.4;
          this.vx[i] *= 1 - Math.min(1, drag * dt); this.vy[i] *= 1 - Math.min(1, drag * dt);
          if (ty === PT.CONFETTI) { this.vx[i] += wx * dt * 0.5; this.rot[i] += dt * 6; }
          break;
        case PT.FLAME:
          this.vx[i] *= 1 - Math.min(1, 5 * dt); this.vy[i] *= 1 - Math.min(1, 5 * dt);
          break;
      }
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      this.size[i] += this.grow[i] * dt;
    }
  };
  Particles.prototype.clear = function () { this.n = 0; };

  /** Non-emissive particles (smoke, dust, dirt, spray, debris, confetti). */
  function drawParticles(ctx, Pa, S, box, V) {
    var dark = V.dark ? 0.55 : V.dusk ? 0.85 : 1;
    var sprites = {};
    function spr(ty) { return sprites[ty] || (sprites[ty] = softSprite(S, ty === PT.SMOKE ? '#ececee' : PT_COLOR[ty])); }
    var x0 = box.x0 - 8, x1 = box.x1 + 8, y0 = box.y0 - 8, y1 = box.y1 + 8;
    for (var i = 0; i < Pa.n; i++) {
      var ty = Pa.type[i];
      if (ty === PT.SPARK || ty === PT.FLAME) continue;
      var x = Pa.x[i], y = Pa.y[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      var f = Pa.life[i] / Pa.max[i], a = Pa.alpha[i], sz = Pa.size[i];
      if (ty === PT.SMOKE || ty === PT.DUST || ty === PT.SPRAY || ty === PT.MIST) {
        var fade = f < 0.12 ? f / 0.12 : 1 - (f - 0.12) / 0.88;
        var s = spr(ty);
        if (!s) continue;
        ctx.globalAlpha = clamp01(a * fade * dark);
        ctx.drawImage(s, x - sz, y - sz, sz * 2, sz * 2);
      } else if (ty === PT.SPLASH) {
        ctx.globalAlpha = clamp01(a * (1 - f) * 0.7);
        ctx.strokeStyle = '#d6e4f0'; ctx.lineWidth = 0.05;
        ctx.beginPath(); ctx.arc(x, y, sz * (0.3 + f), 0, TAU); ctx.stroke();
      } else {
        // chunks with fake height (drawn larger + offset when airborne)
        var z = Pa.z[i], lift = 1 + z * 0.12;
        ctx.globalAlpha = clamp01(a * (f > 0.7 ? (1 - f) / 0.3 : 1) * dark);
        if (ty === PT.CONFETTI) {
          ctx.fillStyle = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#ff2bd6'][Pa.col[i] % 6];
          var cr = Math.cos(Pa.rot[i]);
          ctx.fillRect(x - sz * cr / 2, y + z * 0.3 - sz * 0.3, sz * Math.abs(cr) + 0.02, sz * 0.6);
        } else {
          ctx.fillStyle = ty === PT.DEBRIS && Pa.col[i] ? '#' + ('000000' + Pa.col[i].toString(16)).slice(-6) : PT_COLOR[ty];
          ctx.fillRect(x - sz * lift / 2 + z * V.W.sun.x * 0.6, y - sz * lift / 2 + z * V.W.sun.y * 0.6, sz * lift, sz * lift);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Emissive particles (sparks, flames) — drawn after the light map so they glow. */
  function drawEmissiveParticles(ctx, Pa, S, box) {
    var glow = softSprite(S, '#ff9a2a');
    var x0 = box.x0 - 8, x1 = box.x1 + 8, y0 = box.y0 - 8, y1 = box.y1 + 8;
    var prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffe28a'; ctx.lineWidth = 0.07;
    ctx.beginPath();
    var any = false;
    for (var i = 0; i < Pa.n; i++) {
      if (Pa.type[i] !== PT.SPARK) continue;
      var x = Pa.x[i], y = Pa.y[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      var tl = 0.035 * (1 - Pa.life[i] / Pa.max[i]);
      ctx.moveTo(x, y); ctx.lineTo(x - Pa.vx[i] * tl, y - Pa.vy[i] * tl);
      any = true;
    }
    if (any) ctx.stroke();
    for (i = 0; i < Pa.n; i++) {
      if (Pa.type[i] !== PT.FLAME || !glow) continue;
      var f = Pa.life[i] / Pa.max[i], sz = Pa.size[i] * (1 - f * 0.5);
      ctx.globalAlpha = clamp01((1 - f) * Pa.alpha[i]);
      ctx.drawImage(glow, Pa.x[i] - sz, Pa.y[i] - sz, sz * 2, sz * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = prev;
    ctx.lineCap = 'butt';
  }

  /* ================================================================ effects: screen-space rain */

  function RainField(n) {
    this.n = n;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n); this.s = new Float32Array(n);
    this.init = false;
  }
  RainField.prototype.reset = function (i, w, h, fresh) {
    // drops start near the centre (far below the camera eye is the ground; drops stream outward toward the lens)
    this.x[i] = (Math.random() - 0.5) * w * (fresh ? 1.1 : 0.5);
    this.y[i] = (Math.random() - 0.5) * h * (fresh ? 1.1 : 0.5);
    this.z[i] = 0.6 + Math.random() * 0.8;
    this.s[i] = 0.7 + Math.random() * 0.6;
  };
  /** Advance + draw. intensity 0..1, (vx, vy) = camera ground motion in screen px/s. */
  RainField.prototype.draw = function (ctx, w, h, dt, intensity, vx, vy, dark) {
    if (intensity <= 0) return;
    var n = Math.floor(this.n * intensity);
    if (!this.init) { for (var k = 0; k < this.n; k++) this.reset(k, w, h, true); this.init = true; }
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.strokeStyle = dark ? 'rgba(200,215,235,0.32)' : 'rgba(225,235,245,0.38)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    var maxR = Math.hypot(w, h) * 0.55;
    for (var i = 0; i < n; i++) {
      var x = this.x[i], y = this.y[i], r = Math.hypot(x, y) + 1;
      var sp = (260 + r * 1.9) * this.s[i] * this.z[i];
      var dx = x / r * sp - vx * 0.6, dy = y / r * sp - vy * 0.6;
      var len = 0.028 + 0.02 * this.z[i];
      ctx.moveTo(x, y); ctx.lineTo(x - dx * len, y - dy * len);
      this.x[i] = x + dx * dt; this.y[i] = y + dy * dt;
      if (Math.abs(this.x[i]) > w * 0.6 || Math.abs(this.y[i]) > h * 0.6 || r > maxR) this.reset(i, w, h, false);
    }
    ctx.stroke();
    ctx.restore();
  };

  /* ================================================================ racing-line advisory speeds */

  /** Max entry speed per sample from the racing-line curvature with a backward braking pass (two laps for wrap). */
  function computeVMax(G, mu, brakeA) {
    var N = G.N, geom = G.geom || {}, kArr = geom.racingLineCurvature, v = new Float32Array(N), i;
    for (i = 0; i < N; i++) {
      var k = Math.abs(kArr && typeof kArr[i] === 'number' ? kArr[i] : G.curv[i]);
      v[i] = Math.min(95, Math.sqrt(mu * 9.81 / Math.max(k, 1e-5)));
    }
    for (var pass = 0; pass < 2; pass++) {
      for (i = N - 1; i >= 0; i--) {
        var nx = v[(i + 1) % N], lim = Math.sqrt(nx * nx + 2 * brakeA * G.ds);
        if (v[i] > lim) v[i] = lim;
      }
    }
    return v;
  }

  /* ================================================================ quality presets */

  var QUALITY = {
    high: { maxLevel: 5, particles: PART_CAP, rain: 420, lightScale: LIGHT_SCALE, budget: 6, dpr: 2, splash: 140 },
    medium: { maxLevel: 4, particles: 1300, rain: 260, lightScale: LIGHT_SCALE, budget: 4.5, dpr: 1.5, splash: 80 },
    low: { maxLevel: 3, particles: 600, rain: 140, lightScale: 3, budget: 3, dpr: 1, splash: 30 }
  };

  /* ================================================================ renderer instance */

  function create(canvas, geom, trackDef, opts) {
    opts = opts || {};
    geom = geom || {};
    var def = trackDef || geom.def || {};
    var G = prepGeom(geom, def);
    var theme = Object.assign({}, DEFAULT_THEME, geom.theme || {}, def.theme || {});
    var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    var S = new SpriteCache();
    var st = {
      timeOfDay: opts.timeOfDay || def.timeOfDay || 'day',
      weather: opts.weather || 'dry',
      camera: CAMERA_MODES.indexOf(opts.camera) >= 0 ? opts.camera : 'chase',
      racingLine: !!opts.racingLine,
      labels: opts.labels !== false,
      quality: opts.quality || 'auto',
      q: QUALITY[opts.quality] || QUALITY.high,
      followId: null,
      destroyed: false
    };
    var W = null, tiles = null, vMax = null;
    var skids = new SkidBuffer(SKID_CAP), Pa = new Particles(PART_CAP), rain = new RainField(QUALITY.high.rain);
    var carCache = new Map(), carFx = new Map();
    var mainPatterns = new Map();
    var lm = null, lmCtx = null;
    var dpr = 1, cssW = 1, cssH = 1;
    var cam = { x: 0, y: 0, zoom: 6, rot: 0 }, modeCam = { x: 0, y: 0, zoom: 6, rot: 0, init: false };
    var blend = { t: 1, dur: 0.9, from: null };
    var tvState = { idx: -1, lastSwitch: -10 };
    var shake = { amp: 0, x: 0, y: 0 };
    var clock = { last: null, simT: null, anim: 0, frames: 0, sinceReset: 0 };
    var perf = { avg: 8, samples: 0, fps: 60, lastLevel: 0, upT: 0 };
    var finishedFx = {};
    var lastFocusPos = null;

    function buildWorld() {
      var wetLevel = st.weather === 'wet' ? 1 : st.weather === 'damp' ? 0.5 : 0;
      var street = !!(def.style && def.style.street) || !!(def.surface && def.surface.type === 'street');
      var w = {
        G: G, theme: theme, def: def, wet: wetLevel > 0, wetLevel: wetLevel,
        night: st.timeOfDay === 'night', dusk: st.timeOfDay === 'dusk', street: street,
        wallType: def.wallType || (street ? 'concrete' : 'armco'),
        sun: st.timeOfDay === 'dusk' ? SUN_DUSK : SUN_DAY, P: {}
      };
      w.asphaltColor = wetLevel ? shade(theme.asphalt, -0.16 * wetLevel) : theme.asphalt;
      w.groundColor = street ? (theme.ground || theme.grass) : theme.grass;
      if (wetLevel) w.groundColor = shade(w.groundColor, -0.08 * wetLevel);
      try { w.T = buildTextures(theme, hashStr(def.id || def.name || 'track'), w.wet, street); } catch (e) { w.T = null; }
      return w;
    }
    function rebuild() {
      W = buildWorld();
      if (tiles) tiles.clear();
      tiles = new TileCache(W, {});
      tiles.prerenderBase();
      mainPatterns.clear();
      vMax = computeVMax(G, W.wet ? 0.95 + (1 - W.wetLevel) * 0.3 : 1.35, W.wet ? 7 : 9.5);
    }
    rebuild();

    /* ---------------------------------------------------------- sizing */

    function resize() {
      if (!canvas) return;
      var devR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      var d = Math.min(devR, opts.maxDpr || 2, st.q.dpr || 2);
      var cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (!cw || !ch) { cssW = canvas.width || 800; cssH = canvas.height || 450; dpr = 1; return; }
      var pw = Math.max(1, Math.round(cw * d)), ph = Math.max(1, Math.round(ch * d));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      dpr = pw / cw; cssW = cw; cssH = ch;
    }

    function patternFor(tex, metres, rot) {
      if (!ctx || !tex) return null;
      var key = (tex.__pid || (tex.__pid = 'p' + Math.random().toString(36).slice(2))) + '|' + metres + '|' + (rot || 0).toFixed(3);
      if (mainPatterns.has(key)) return mainPatterns.get(key);
      var p = makePattern(ctx, tex, metres, rot);
      mainPatterns.set(key, p);
      return p;
    }

    /* ---------------------------------------------------------- view math */

    function toScreen(x, y) {
      var dx = (x - cam.x) * cam.zoom, dy = -(y - cam.y) * cam.zoom, c = Math.cos(cam.rot), s = Math.sin(cam.rot);
      return [cssW / 2 + shake.x + dx * c - dy * s, cssH / 2 + shake.y + dx * s + dy * c];
    }
    function toWorld(px, py) {
      var ux = px - cssW / 2 - shake.x, uy = py - cssH / 2 - shake.y, c = Math.cos(cam.rot), s = Math.sin(cam.rot);
      var dx = ux * c + uy * s, dy = -ux * s + uy * c;
      return [cam.x + dx / cam.zoom, cam.y - dy / cam.zoom];
    }
    function viewBox(marginM) {
      var pts = [toWorld(0, 0), toWorld(cssW, 0), toWorld(cssW, cssH), toWorld(0, cssH)];
      var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      pts.forEach(function (p) { b.x0 = Math.min(b.x0, p[0]); b.x1 = Math.max(b.x1, p[0]); b.y0 = Math.min(b.y0, p[1]); b.y1 = Math.max(b.y1, p[1]); });
      var m = marginM || 0;
      b.x0 -= m; b.y0 -= m; b.x1 += m; b.y1 += m;
      return b;
    }
    function applyView(g, scale) {
      var k = scale || dpr;
      g.setTransform(k, 0, 0, k, 0, 0);
      g.translate(cssW / 2 + shake.x, cssH / 2 + shake.y);
      g.rotate(cam.rot);
      g.scale(cam.zoom, -cam.zoom);
      g.translate(-cam.x, -cam.y);
    }

    /* ---------------------------------------------------------- cameras */

    function overviewTarget() {
      var B = G.trackBounds, w = Math.max(50, B.x1 - B.x0), h = Math.max(50, B.y1 - B.y0);
      return { x: (B.x0 + B.x1) / 2, y: (B.y0 + B.y1) / 2, zoom: Math.min(cssW / (w * 1.12), cssH / (h * 1.12)), rot: 0 };
    }
    function chooseTvCam(p) {
      var cams = G.tvCams;
      if (!cams.length) return -1;
      var best = -1, bestD = Infinity;
      for (var i = 0; i < cams.length; i++) {
        var d = Math.hypot(cams[i].x - p.x, cams[i].y - p.y);
        // prefer cameras the car is approaching (look ahead along the lap)
        var ds = mod(cams[i].s - num(p.car.s, 0), G.length);
        if (ds > G.length / 2) ds -= G.length;
        var score = d + (ds < -40 ? 60 : 0);
        if (score < bestD) { bestD = score; best = i; }
      }
      if (tvState.idx >= 0 && best !== tvState.idx) {
        var cur = cams[tvState.idx], dc = Math.hypot(cur.x - p.x, cur.y - p.y);
        if (dc < bestD + 25 && clock.anim - tvState.lastSwitch < 6) return tvState.idx;   // hysteresis
      }
      return best;
    }
    function modeTarget(mode, p, dt) {
      var minDim = Math.min(cssW, cssH);
      if (!p) return overviewTarget();
      var spd = Math.abs(num(p.car.speed, 0));
      var vx = num(p.car.vx, Math.cos(p.h) * spd), vy = num(p.car.vy, Math.sin(p.h) * spd);
      var vl = Math.hypot(vx, vy), dirx = vl > 1 ? vx / vl : Math.cos(p.h), diry = vl > 1 ? vy / vl : Math.sin(p.h);
      if (mode === 'tv') {
        var idx = chooseTvCam(p);
        if (idx !== tvState.idx) {
          if (tvState.idx >= 0) startBlend(0.38);
          tvState.idx = idx; tvState.lastSwitch = clock.anim;
        }
        var tc = G.tvCams[idx] || { x: p.x - 30, y: p.y - 30 };
        var dist = Math.hypot(p.x - tc.x, p.y - tc.y);
        var viewM = clamp(38 + dist * 0.5, 42, 170);
        var ang = Math.atan2(p.y - tc.y, p.x - tc.x) - HALF_PI;
        return { x: p.x + dirx * Math.min(spd * 0.15, 8), y: p.y + diry * Math.min(spd * 0.15, 8), zoom: minDim / viewM, rot: ang, tv: true };
      }
      var la = clamp(spd * 0.42, 0, 30);
      if (mode === 'north') {
        var viewN = clamp(52 + spd * 0.75, 52, 135);
        return { x: p.x + dirx * la, y: p.y + diry * la, zoom: minDim / viewN, rot: 0 };
      }
      // chase: car sits low on the screen, rotation follows the heading
      var viewC = clamp(44 + spd * 0.85, 44, 130), z = minDim / viewC;
      var ahead = (cssH * 0.17) / z;
      var hx = Math.cos(p.h), hy = Math.sin(p.h);
      return { x: p.x + dirx * la * 0.6 + hx * ahead, y: p.y + diry * la * 0.6 + hy * ahead, zoom: z, rot: p.h - HALF_PI };
    }
    function startBlend(dur) {
      blend.from = { x: cam.x, y: cam.y, zoom: cam.zoom, rot: cam.rot };
      blend.t = 0; blend.dur = dur || 0.9;
    }
    function updateCamera(dt, p) {
      var tg = modeTarget(st.camera, p, dt);
      if (!modeCam.init) {
        modeCam.x = tg.x; modeCam.y = tg.y; modeCam.zoom = tg.zoom; modeCam.rot = tg.rot; modeCam.init = true;
      } else {
        var kp = damp(st.camera === 'tv' ? 3.2 : 6.5, dt), kz = damp(st.camera === 'tv' ? 1.6 : 2.2, dt);
        modeCam.x += (tg.x - modeCam.x) * kp;
        modeCam.y += (tg.y - modeCam.y) * kp;
        modeCam.zoom = Math.exp(lerp(Math.log(modeCam.zoom), Math.log(Math.max(0.05, tg.zoom)), kz));
        var dr = wrapAngle(tg.rot - modeCam.rot), maxRate = st.camera === 'tv' ? 1.2 : 2.6;
        var step = dr * damp(st.camera === 'tv' ? 2.0 : 4.2, dt);
        step = clamp(step, -maxRate * dt, maxRate * dt);
        modeCam.rot = wrapAngle(modeCam.rot + step);
        // the chase cam must not let the car escape the screen when it snaps around
        // (the TV cam gets a looser leash so cuts/long-lens pans still feel like a broadcast operator)
        if (p) {
          var maxOff = Math.min(cssW, cssH) * (st.camera === 'tv' ? 0.46 : 0.42) / modeCam.zoom, ox = p.x - modeCam.x, oy = p.y - modeCam.y, od = Math.hypot(ox, oy);
          if (od > maxOff) { modeCam.x = p.x - ox / od * maxOff; modeCam.y = p.y - oy / od * maxOff; }
        }
      }
      if (blend.t < 1 && blend.from) {
        blend.t = Math.min(1, blend.t + dt / blend.dur);
        var e = easeInOut(blend.t), f = blend.from;
        cam.x = lerp(f.x, modeCam.x, e); cam.y = lerp(f.y, modeCam.y, e);
        cam.zoom = Math.exp(lerp(Math.log(f.zoom), Math.log(modeCam.zoom), e));
        cam.rot = lerpAngle(f.rot, modeCam.rot, e);
      } else {
        cam.x = modeCam.x; cam.y = modeCam.y; cam.zoom = modeCam.zoom; cam.rot = modeCam.rot;
      }
      // shake
      if (shake.amp > 0.05) {
        shake.amp *= Math.exp(-7 * dt);
        shake.x = (Math.random() - 0.5) * 2 * shake.amp; shake.y = (Math.random() - 0.5) * 2 * shake.amp;
      } else { shake.amp = 0; shake.x = 0; shake.y = 0; }
    }

    /* ---------------------------------------------------------- cars */

    function poseOf(c, alpha) {
      var x = num(c.x, 0), y = num(c.y, 0), h = num(c.heading, 0);
      if (alpha < 1 && typeof c.prevX === 'number' && typeof c.prevY === 'number') {
        var px = c.prevX, py = c.prevY, ph = num(c.prevHeading, num(c.prevH, h));
        if (Math.abs(px - x) + Math.abs(py - y) < 25) { x = lerp(px, x, alpha); y = lerp(py, y, alpha); h = lerpAngle(ph, h, alpha); }
      }
      return { x: x, y: y, h: h };
    }
    function carEntry(c) {
      var e = carCache.get(c.id);
      if (e && e.build === c.build && e.color === c.color && e.len === c.length_m && e.num === c.number) return e;
      var m = carModel(c);
      if (e && e.key === m.key) { e.build = c.build; e.color = c.color; e.len = c.length_m; e.num = c.number; e.m = m; return e; }
      var spr = null;
      try { spr = buildCarSprite(m, c.isPlayer ? CAR_PPM * 1.25 : CAR_PPM); } catch (err) { spr = null; }
      e = { key: m.key, m: m, spr: spr, build: c.build, color: c.color, len: c.length_m, num: c.number };
      carCache.set(c.id, e);
      return e;
    }
    function fxOf(id) {
      var f = carFx.get(id);
      if (!f) { f = { wheels: [null, null, null, null], phase: 0, gear: 0, rpm: 0, acc: {}, lastX: null, lastY: null }; carFx.set(id, f); }
      return f;
    }
    function wheelWorld(p, m, k) {
      var lx = k < 2 ? m.axF : m.axR, ly = (k % 2 ? -1 : 1) * m.track / 2;
      var c = Math.cos(p.h), s = Math.sin(p.h);
      return [p.x + c * lx - s * ly, p.y + s * lx + c * ly];
    }
    function emitRate(f, key, rate, dt) {
      var a = (f.acc[key] || 0) + rate * dt, n = Math.floor(a);
      f.acc[key] = a - n;
      return n;
    }

    /** Skid marks, smoke, dirt, spray and backfires for one car for one sim interval. */
    function emitCar(p, dt, simT) {
      var c = p.car, m = p.m, f = fxOf(c.id);
      var spd = Math.abs(num(c.speed, 0)), sk = clamp01(num(c.skidding, 0)), ws = clamp01(num(c.wheelspin, 0));
      var brake = num(c.brake, 0), surf = c.surface || 'asphalt';
      var onTar = surf === 'asphalt' || surf === 'kerb' || surf === 'tarmac' || surf === 'wall', onGrass = surf === 'grass', onSand = surf === 'sand' || surf === 'gravel';
      var cosH = Math.cos(p.h), sinH = Math.sin(p.h);
      var vx = num(c.vx, cosH * num(c.speed, 0)), vy = num(c.vy, sinH * num(c.speed, 0));
      // teleport (reset to track / restart): forget last wheel points
      if (f.lastX !== null && Math.hypot(p.x - f.lastX, p.y - f.lastY) > 15) f.wheels = [null, null, null, null];
      f.lastX = p.x; f.lastY = p.y;
      f.phase += num(c.speed, 0) * dt / m.circ;
      var lock = brake > 0.55 && sk > 0.25 && spd > 4;
      var slideF = Math.abs(num(c.slipF, 0)) > 0.14 && sk > 0.35;
      var wet = W.wetLevel;
      for (var k = 0; k < 4; k++) {
        var wp = wheelWorld(p, m, k), last = f.wheels[k];
        var rear = k >= 2;
        var mark = 0, type = SKID_RUBBER;
        if (onTar && spd > 0.5) {
          if (rear && (sk > 0.22 || ws > 0.3)) mark = Math.max(sk, ws);
          if (!rear && (lock || slideF)) mark = sk;
          if (wet) { type = SKID_WET; mark *= 0.8; }
        } else if ((onGrass || onSand) && spd > 1.5) {
          mark = clamp01(0.35 + spd / 40); type = SKID_DIRT;
        }
        if (mark > 0 && last) {
          var d = Math.hypot(wp[0] - last[0], wp[1] - last[1]);
          if (d > 0.12 && d < 4) { skids.add(last[0], last[1], wp[0], wp[1], rear ? m.twR : m.twF, clamp01(mark), simT, type); f.wheels[k] = wp; }
          else if (d >= 4) f.wheels[k] = wp;
        } else {
          f.wheels[k] = mark > 0 ? wp : null;
        }
      }
      var rl = wheelWorld(p, m, 2), rr = wheelWorld(p, m, 3), fl = wheelWorld(p, m, 0), fr = wheelWorld(p, m, 1);
      var R = Math.random;
      // tyre smoke
      if (onTar) {
        var smokeRate = (ws * 46 + sk * 34 + (lock ? 18 : 0)) * (wet ? 0.25 : 1);
        if (smokeRate > 2 && (spd > 1 || ws > 0.3)) {
          var n = emitRate(f, 'smoke', smokeRate, dt);
          for (var i = 0; i < n; i++) {
            var src = lock && R() < 0.4 ? (R() < 0.5 ? fl : fr) : (R() < 0.5 ? rl : rr);
            Pa.spawn(PT.SMOKE, src[0] + (R() - 0.5) * 0.3, src[1] + (R() - 0.5) * 0.3, vx * 0.12 + (R() - 0.5) * 2, vy * 0.12 + (R() - 0.5) * 2,
              1.4 + R() * 1.4, 0.45 + R() * 0.3, 1.5 + R() * 1.2, 0.32 + 0.3 * Math.max(sk, ws));
          }
        }
      }
      // grass / gravel thrown up
      if ((onGrass || onSand) && spd > 2.5) {
        var nChunk = emitRate(f, 'chunk', spd * (onSand ? 2.4 : 1.6), dt);
        for (var j = 0; j < nChunk; j++) {
          var s2 = R() < 0.5 ? rl : rr;
          Pa.spawn(onSand ? PT.SAND : PT.GRASS, s2[0], s2[1], -vx * 0.15 + (R() - 0.5) * 4, -vy * 0.15 + (R() - 0.5) * 4,
            0.9 + R() * 0.5, 0.08 + R() * 0.1, 0, 0.95, 1.5 + R() * 3.5);
        }
        if (!wet || onSand) {
          var nDust = emitRate(f, 'dust', spd * (onSand ? 1.6 : 0.6), dt);
          for (var q = 0; q < nDust; q++) {
            var s3 = R() < 0.5 ? rl : rr;
            Pa.spawn(PT.DUST, s3[0], s3[1], vx * 0.1 + (R() - 0.5) * 2, vy * 0.1 + (R() - 0.5) * 2, 1.6 + R() * 1.6, 0.8 + R() * 0.6, 2.2 + R() * 1.6, onSand ? 0.34 : 0.2);
          }
        }
      }
      // wet spray / mist
      if (wet && spd > 6 && !onGrass) {
        var nSpray = emitRate(f, 'spray', wet * spd * 1.25, dt);
        for (var w = 0; w < nSpray; w++) {
          var s4 = R() < 0.5 ? rl : rr;
          Pa.spawn(PT.SPRAY, s4[0] - cosH * 0.4, s4[1] - sinH * 0.4, vx * 0.55 + (R() - 0.5) * 3, vy * 0.55 + (R() - 0.5) * 3,
            0.6 + R() * 0.6, 0.5 + R() * 0.3, 2.4 + spd * 0.03, 0.2 * wet);
        }
        if (spd > 25) {
          var nMist = emitRate(f, 'mist', wet * (spd - 20) * 0.35, dt);
          for (var mm = 0; mm < nMist; mm++) {
            Pa.spawn(PT.MIST, p.x - cosH * m.L * 0.7, p.y - sinH * m.L * 0.7, vx * 0.5 + (R() - 0.5) * 2, vy * 0.5 + (R() - 0.5) * 2, 1.0 + R() * 0.8, 1.6, 3.2, 0.12 * wet);
          }
        }
      }
      // backfire on upshift at high rpm / on lift-off
      var gear = num(c.gear, 0), rpm = num(c.rpm, 0), red = num(c.redline, 7000);
      var bang = (gear > f.gear && f.gear > 0 && f.rpm > red * 0.78) || (num(c.throttle, 0) < 0.1 && f.thr > 0.8 && rpm > red * 0.7 && R() < 0.4);
      if (bang && spd > 3) {
        m.exhaust.forEach(function (ex) {
          var wx = p.x + cosH * ex.x - sinH * ex.y, wy = p.y + sinH * ex.x + cosH * ex.y;
          for (var b = 0; b < 3; b++) Pa.spawn(PT.FLAME, wx - cosH * b * 0.15, wy - sinH * b * 0.15, vx * 0.8 - cosH * 4, vy * 0.8 - sinH * 4, 0.1 + R() * 0.1, 0.35 + R() * 0.25, 0, 0.9);
        });
      }
      f.gear = gear; f.rpm = rpm; f.thr = num(c.throttle, 0);
    }

    function handleEvents(snap, poses, focus) {
      var ev = snap.events || [];
      for (var i = 0; i < ev.length; i++) {
        var e = ev[i];
        if (!e) continue;
        var I = clamp01(num(e.intensity, 0.5)), x = num(e.x, NaN), y = num(e.y, NaN);
        var car = null;
        for (var k = 0; k < poses.length; k++) if (poses[k].car.id === e.carId) { car = poses[k]; break; }
        if (!isFinite(x) && car) { x = car.x; y = car.y; }
        if (e.type === 'collision' || e.type === 'wall') {
          if (!isFinite(x)) continue;
          var n = Math.round((e.type === 'wall' ? 10 : 6) + I * (e.type === 'wall' ? 46 : 30));
          var vx = car ? num(car.car.vx, 0) : 0, vy = car ? num(car.car.vy, 0) : 0;
          for (var s = 0; s < n; s++) {
            var a = Math.random() * TAU, sp = 6 + Math.random() * 22 * (0.4 + I);
            Pa.spawn(PT.SPARK, x, y, vx * 0.6 + Math.cos(a) * sp, vy * 0.6 + Math.sin(a) * sp, 0.18 + Math.random() * 0.4, 0.05, 0, 1);
          }
          var nd = Math.round(1 + I * 7), col = car ? parseInt(String(car.m.paint).replace('#', ''), 16) || 0 : 0;
          for (var d = 0; d < nd; d++) {
            var a2 = Math.random() * TAU, sp2 = 2 + Math.random() * 8;
            Pa.spawn(PT.DEBRIS, x, y, vx * 0.4 + Math.cos(a2) * sp2, vy * 0.4 + Math.sin(a2) * sp2, 2 + Math.random() * 3, 0.08 + Math.random() * 0.12, 0, 1, 1 + Math.random() * 3, Math.random() < 0.5 ? col : 0x1d1e21);
          }
          if (I > 0.3) Pa.spawn(PT.SMOKE, x, y, vx * 0.2, vy * 0.2, 1.4, 0.8, 2.2, 0.25 * I);
          if (focus && (e.carId === focus.car.id || e.otherId === focus.car.id || Math.hypot(x - focus.x, y - focus.y) < 8)) shake.amp = Math.max(shake.amp, 3 + 11 * I);
        } else if (e.type === 'finish' && focus && e.carId === focus.car.id && !finishedFx[e.carId]) {
          finishedFx[e.carId] = true;
          for (var cf = 0; cf < 220; cf++) {
            var lat = (Math.random() - 0.5) * G.hw[0] * 2.4, al = (Math.random() - 0.5) * 30;
            var cx = G.cx[0] + G.nx[0] * lat + G.tx[0] * al, cy = G.cy[0] + G.ny[0] * lat + G.ty[0] * al;
            Pa.spawn(PT.CONFETTI, cx, cy, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 3 + Math.random() * 3, 0.22, 0, 1, 4 + Math.random() * 6, (Math.random() * 6) | 0);
          }
        }
      }
    }

    /* ---------------------------------------------------------- drawing helpers */

    function drawShadows(g, list) {
      var sun = W.sun, a = W.night ? 0.2 : W.dusk ? 0.3 : 0.34;
      g.fillStyle = 'rgba(0,0,10,' + a + ')';
      for (var i = 0; i < list.length; i++) {
        var p = list[i], m = p.m;
        g.save();
        g.translate(p.x + (W.night ? 0 : sun.x * 0.55), p.y + (W.night ? 0 : sun.y * 0.55));
        g.rotate(p.h);
        if (m.shape) bodyPath(g, m, 0.04); else { g.beginPath(); roundRectPath(g, -m.L / 2 - 0.05, -m.W / 2 - 0.02, m.L + 0.1, m.W + 0.04, 0.5); }
        g.fill();
        g.restore();
      }
      g.fillStyle = 'rgba(0,0,0,0.22)';
      for (i = 0; i < list.length; i++) {
        var q = list[i];
        g.save(); g.translate(q.x, q.y); g.rotate(q.h);
        if (q.m.shape) bodyPath(g, q.m, 0.12); else { g.beginPath(); roundRectPath(g, -q.m.L / 2 - 0.12, -q.m.W / 2 - 0.1, q.m.L + 0.24, q.m.W + 0.2, 0.6); }
        g.fill();
        g.restore();
      }
    }
    function drawCar(g, p, devPpm, isFocus) {
      var m = p.m, e = p.e, c = p.car;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.h);
      if (isFocus && st.camera !== 'chase') {
        g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = Math.max(0.12, 1.5 / cam.zoom);
        g.beginPath(); g.arc(0, 0, m.L * 0.72, 0, TAU); g.stroke();
      }
      drawWheels(g, m, num(c.steerAngle, 0), fxOf(c.id).phase, devPpm);
      if (e.spr) {
        var pad = e.spr.pad;
        g.drawImage(e.spr.canvas, -(m.L / 2 + pad), -(m.W / 2 + pad), m.L + pad * 2, m.W + pad * 2);
      } else {
        g.fillStyle = m.paint; bodyPath(g, m, 0); g.fill();
      }
      var brake = num(c.brake, 0), rev = num(c.gear, 1) < 0 || (num(c.speed, 0) < -0.5);
      if (brake > 0.05 || rev) {
        g.fillStyle = rev && brake <= 0.05 ? 'rgba(245,248,255,0.95)' : 'rgba(255,' + Math.round(40 - brake * 30) + ',30,' + (0.55 + brake * 0.45).toFixed(2) + ')';
        m.tails.forEach(function (r) { g.beginPath(); roundRectPath(g, r.x0 + 0.01, r.y0 + 0.01, r.x1 - r.x0 - 0.02, r.y1 - r.y0 - 0.02, 0.03); g.fill(); });
      }
      if (c.dnf) { g.fillStyle = 'rgba(30,30,30,0.45)'; bodyPath(g, m, 0); g.fill(); }
      g.restore();
    }
    function drawGhost(g, gh, focus) {
      if (!gh || typeof gh.x !== 'number') return;
      var m = focus ? focus.m : carModel({ length_m: 4.5, width_m: 1.9, bodyStyle: 'coupe' });
      g.save();
      g.translate(gh.x, gh.y); g.rotate(num(gh.heading, 0));
      g.globalAlpha = 0.28;
      if (focus && focus.e.spr) { var pad = focus.e.spr.pad; g.drawImage(focus.e.spr.canvas, -(m.L / 2 + pad), -(m.W / 2 + pad), m.L + pad * 2, m.W + pad * 2); }
      g.globalAlpha = 0.85;
      g.strokeStyle = '#7fd8ff'; g.lineWidth = Math.max(0.06, 1.2 / cam.zoom);
      bodyPath(g, m, 0.04); g.stroke();
      g.globalAlpha = 1;
      g.restore();
    }
    function drawBridgeDecks(g) {
      var th = theme;
      G.bridges.forEach(function (br) {
        var a = br.a - 1, b = br.b + 1;
        g.fillStyle = shade(th.bridge || '#7d848c', -0.25);
        bandPath(g, G, a, b, function (i) { return -G.hw[i] - 1.4; }, function (i) { return G.hw[i] + 1.4; }); g.fill();
        g.fillStyle = W.asphaltColor;
        bandPath(g, G, a, b, function (i) { return -G.hw[i] - 0.05; }, function (i) { return G.hw[i] + 0.05; }); g.fill();
        var gp = W.T && patternFor(W.T.grain, W.T.grainM, 0);
        if (gp && cam.zoom * dpr > 5) { g.fillStyle = gp; g.fill(); }
        g.strokeStyle = rgba(th.line || '#fff', 0.9); g.lineWidth = 0.18;
        g.beginPath(); tracePath(g, G, a, b, function (i) { return G.hw[i] - 0.32; }); g.stroke();
        g.beginPath(); tracePath(g, G, a, b, function (i) { return -G.hw[i] + 0.32; }); g.stroke();
        g.strokeStyle = th.bridge || '#b9bec4'; g.lineWidth = 0.55;
        g.beginPath(); tracePath(g, G, a, b, function (i) { return G.hw[i] + 1.05; }); g.stroke();
        g.beginPath(); tracePath(g, G, a, b, function (i) { return -G.hw[i] - 1.05; }); g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.15;
        g.beginPath(); tracePath(g, G, a, b, function (i) { return G.hw[i] + 1.1; }); g.stroke();
        g.beginPath(); tracePath(g, G, a, b, function (i) { return -G.hw[i] - 1.1; }); g.stroke();
      });
    }
    function drawRacingLine(g, focus) {
      if (!st.racingLine || !focus || !vMax) return;
      var spd = Math.abs(num(focus.car.speed, 0));
      var i0 = idxAtS(G, num(focus.car.s, 0)), n = Math.min(G.N - 2, Math.round(320 / G.ds));
      var paths = [[], [], []];
      for (var k = 2; k < n; k++) {
        var i = (i0 + k) % G.N, j = (i + 1) % G.N;
        var ratio = spd / Math.max(1, vMax[i]);
        // the further ahead, the more speed we can still scrub
        var dAhead = k * G.ds, allowance = Math.sqrt(vMax[i] * vMax[i] + 2 * 8.5 * dAhead) / Math.max(1, vMax[i]);
        var r = ratio / allowance;
        var bin = r > 0.98 ? 2 : r > 0.86 ? 1 : 0;
        paths[bin].push(i, j);
      }
      var cols = ['rgba(60,220,120,', 'rgba(255,196,0,', 'rgba(255,50,40,'];
      g.lineCap = 'butt';
      g.lineWidth = 0.75;
      for (var b = 0; b < 3; b++) {
        var arr = paths[b];
        if (!arr.length) continue;
        g.strokeStyle = cols[b] + (b ? 0.55 : 0.38) + ')';
        g.beginPath();
        for (var q = 0; q < arr.length; q += 2) {
          var a = arr[q], c = arr[q + 1];
          g.moveTo(G.rlx[a], G.rly[a]); g.lineTo(G.rlx[c], G.rly[c]);
        }
        g.stroke();
      }
    }
    function drawLabels(g, poses, focus) {
      if (!st.labels) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = '700 10.5px "Inter", "Helvetica Neue", Arial, sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'middle';
      for (var i = 0; i < poses.length; i++) {
        var p = poses[i];
        if (focus && p === focus) continue;
        var sp = toScreen(p.x, p.y);
        if (sp[0] < -40 || sp[0] > cssW + 40 || sp[1] < -40 || sp[1] > cssH + 40) continue;
        var dist = focus ? Math.hypot(p.x - focus.x, p.y - focus.y) : 0;
        var alpha = focus ? clamp01(1.4 - dist / 120) : 0.9;
        if (alpha <= 0.05) continue;
        var name = String(p.car.name || '').split(' ').pop().toUpperCase().slice(0, 10);
        var numS = String(p.car.number != null ? p.car.number : '');
        var pos = p.car.position ? 'P' + p.car.position : '';
        var txt = (pos ? pos + ' ' : '') + name;
        var tw = g.measureText(txt).width, nw = numS ? g.measureText(numS).width + 8 : 0;
        var y = sp[1] - Math.max(14, p.m.L * cam.zoom * 0.62) - 6, x = sp[0] - (tw + nw + 10) / 2;
        g.globalAlpha = alpha;
        g.fillStyle = 'rgba(12,13,16,0.72)';
        g.beginPath(); roundRectPath(g, x, y - 8, tw + nw + 10, 16, 3); g.fill();
        if (numS) { g.fillStyle = p.car.color || '#888'; g.beginPath(); roundRectPath(g, x, y - 8, nw, 16, 3); g.fill(); g.fillStyle = luminance(p.car.color || '#888') > 0.6 ? '#111' : '#fff'; g.fillText(numS, x + 4, y + 0.5); }
        g.fillStyle = '#f2f2f2'; g.fillText(txt, x + nw + 5, y + 0.5);
      }
      g.globalAlpha = 1;
    }

    /* ---------------------------------------------------------- lighting */

    function ensureLightMap(w, h) {
      if (!lm) { lm = makeCanvas(w, h); lmCtx = ctx2d(lm); }
      if (lm && (lm.width !== w || lm.height !== h)) { lm.width = w; lm.height = h; }
      return lmCtx;
    }
    function renderLights(poses, tallList, box) {
      var night = W.night, dusk = W.dusk;
      if (!night && !dusk) return false;
      var LS = st.q.lightScale, lw = Math.ceil(cssW / LS), lh = Math.ceil(cssH / LS);
      var g = ensureLightMap(lw, lh);
      if (!g) return false;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.fillStyle = night ? (theme.night ? '#3a4266' : '#222a48') : '#d9b39c';
      if (W.wetLevel && night) g.fillStyle = theme.night ? '#343c5e' : '#1e2540';
      g.fillRect(0, 0, lw, lh);
      g.globalCompositeOperation = 'lighter';
      applyView(g, 1 / LS);
      var k = night ? 1 : 0.38;
      // lamps
      var lamps = G.lamps;
      for (var i = 0; i < lamps.length; i++) {
        var o = lamps[i];
        if (o.x < box.x0 - 50 || o.x > box.x1 + 50 || o.y < box.y0 - 50 || o.y > box.y1 + 50) continue;
        var vr = o.variant || 'street', r = vr === 'stadium' ? 46 : vr === 'flood' ? 24 : vr === 'road' ? 11 : 15;
        var spr = softSprite(S, o.color || (vr === 'stadium' ? '#fff6e0' : '#ffd79a'));
        if (!spr) continue;
        var tc = -(o.side || 1), off = vr === 'stadium' ? 10 : 3;
        var px = o.x - Math.sin(o.rot) * tc * off, py = o.y + Math.cos(o.rot) * tc * off;
        g.globalAlpha = 0.85 * k;
        g.drawImage(spr, px - r, py - r, r * 2, r * 2);
      }
      // lit scenery spill (neon, glass towers, grandstands, pits)
      for (i = 0; i < tallList.length; i++) {
        var t = tallList[i];
        if (!t.lit && t.type !== 'pits') continue;
        var rr = Math.min(60, Math.max(t.l || 4, t.w || 4) * 0.75 + 6);
        var s2 = softSprite(S, t.accent || t.color || '#ffe0b0');
        if (!s2) continue;
        g.globalAlpha = (t.type === 'billboard' ? 0.5 : 0.32) * k;
        g.drawImage(s2, t.x - rr, t.y - rr, rr * 2, rr * 2);
      }
      // gantry start lights
      if (G.gantry._lights) G.gantry._lights.forEach(function (l) {
        if (!l.on) return; var s3 = softSprite(S, '#ff2a1a'); if (!s3) return;
        g.globalAlpha = 0.7; g.drawImage(s3, l.x - 7, l.y - 7, 14, 14);
      });
      // cars: headlight cones, tail light pools
      var cone = coneSprite(S, '#fff3da'), red = softSprite(S, '#ff2a1a'), white = softSprite(S, '#f0f4ff');
      for (i = 0; i < poses.length; i++) {
        var p = poses[i], m = p.m, c = Math.cos(p.h), s = Math.sin(p.h);
        if (p.car.dnf) continue;
        if (cone) {
          var reach = night ? 36 : 22;
          g.save();
          g.translate(p.x + c * m.L * 0.48, p.y + s * m.L * 0.48);
          g.rotate(p.h);
          g.globalAlpha = night ? 0.9 : 0.4;
          g.drawImage(cone, 0, -reach * 0.28, reach, reach * 0.56);
          g.restore();
        }
        var brake = num(p.car.brake, 0);
        if (red) {
          var tr = 1.6 + brake * 3;
          g.globalAlpha = 0.35 + brake * 0.5;
          g.drawImage(red, p.x - c * m.L * 0.55 - tr, p.y - s * m.L * 0.55 - tr, tr * 2, tr * 2);
        }
        if (white) { g.globalAlpha = 0.5; g.drawImage(white, p.x - 3, p.y - 3, 6, 6); }
      }
      // sparks and flames light their surroundings
      var orange = softSprite(S, '#ff9a3a');
      if (orange) {
        for (i = 0; i < Pa.n; i++) {
          var ty = Pa.type[i];
          if (ty !== PT.SPARK && ty !== PT.FLAME) continue;
          var a = 1 - Pa.life[i] / Pa.max[i], rad = ty === PT.FLAME ? 3.5 : 1.8;
          g.globalAlpha = a * 0.6;
          g.drawImage(orange, Pa.x[i] - rad, Pa.y[i] - rad, rad * 2, rad * 2);
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.setTransform(1, 0, 0, 1, 0, 0);
      // multiply onto the frame
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(lm, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      return true;
    }
    function drawCarEmissive(g, poses, dark) {
      var glowR = softSprite(S, '#ff2a1a');
      var prev = g.globalCompositeOperation;
      for (var i = 0; i < poses.length; i++) {
        var p = poses[i], m = p.m, c = p.car;
        if (c.dnf) continue;
        var brake = num(c.brake, 0);
        if (!dark && brake < 0.05) continue;
        g.save();
        g.translate(p.x, p.y); g.rotate(p.h);
        g.globalCompositeOperation = 'lighter';
        if (dark) {
          var hc = softSprite(S, LIGHT_COL[m.lights] || '#f3f7ff');
          if (hc) {
            g.globalAlpha = 0.85;
            m.heads.forEach(function (r) { var cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2; g.drawImage(hc, cx - 0.8, cy - 0.8, 1.6, 1.6); });
          }
        }
        if (glowR) {
          g.globalAlpha = dark ? 0.45 + brake * 0.55 : brake * 0.65;
          m.tails.forEach(function (r) {
            var cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, sz = 0.5 + brake * 0.6 + Math.abs(r.y1 - r.y0) * 0.5;
            g.drawImage(glowR, cx - sz, cy - sz, sz * 2, sz * 2);
          });
        }
        g.restore();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }

    /* ---------------------------------------------------------- quality governor */

    function setQualityLevel(name) {
      var q = QUALITY[name] || QUALITY.high;
      if (q === st.q) return;
      st.q = q;
      Pa.limit = Math.min(Pa.cap, q.particles);
      if (Pa.n > Pa.limit) Pa.n = Pa.limit;
    }
    function governor(ms) {
      perf.avg = perf.avg * 0.95 + ms * 0.05;
      perf.samples++;
      if (st.quality !== 'auto' || perf.samples < 90) return;
      var cur = st.q === QUALITY.high ? 'high' : st.q === QUALITY.medium ? 'medium' : 'low';
      if (perf.avg > 15 && cur !== 'low') { setQualityLevel(cur === 'high' ? 'medium' : 'low'); perf.samples = 0; perf.upT = 0; }
      else if (perf.avg < 6 && cur !== 'high') {
        perf.upT += 1;
        if (perf.upT > 240) { setQualityLevel(cur === 'low' ? 'medium' : 'high'); perf.samples = 0; perf.upT = 0; }
      } else perf.upT = 0;
    }

    /* ---------------------------------------------------------- frame */

    var lastStats = { level: 0, drawn: 0, fallback: 0, ms: 0, painted: 0 };

    function render(snap, alpha) {
      if (st.destroyed || !ctx) return;
      var t0 = now();
      var camOverride = alpha && typeof alpha === 'object' ? alpha : null;
      alpha = typeof alpha === 'number' && isFinite(alpha) ? clamp01(alpha) : 1;
      snap = snap || { cars: [] };
      resize();
      var realDt = clock.last === null ? 1 / 60 : clamp((t0 - clock.last) / 1000, 0, 0.1);
      clock.last = t0;
      clock.anim += realDt;
      clock.frames++; clock.sinceReset++;
      perf.fps = perf.fps * 0.9 + (realDt > 0 ? 1 / realDt : 60) * 0.1;
      // sim clock drives the effects (frozen while paused)
      var simT = num(snap.t, clock.simT === null ? 0 : clock.simT);
      var simDt = clock.simT === null ? 0 : simT - clock.simT;
      if (simDt < -0.25 || simDt > 3) { clearEffects(); simDt = 0; }
      simDt = clamp(simDt, 0, 0.1);
      clock.simT = simT;

      // --- cars & focus
      var cars = Array.isArray(snap.cars) ? snap.cars : [];
      var poses = [], focus = null, wantId = st.followId != null ? st.followId : snap.playerId;
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (!c || typeof c.x !== 'number') continue;
        var pz = poseOf(c, alpha), e = carEntry(c);
        pz.car = c; pz.m = e.m; pz.e = e;
        pz.layer = G.bridges.length ? G.layer[idxAtS(G, num(c.s, 0))] : 0;
        poses.push(pz);
        if (c.id === wantId || (!focus && c.isPlayer && wantId == null)) focus = pz;
      }
      if (!focus) for (i = 0; i < poses.length; i++) if (poses[i].car.isPlayer) { focus = poses[i]; break; }
      if (!focus && poses.length) { poses.forEach(function (p) { if (!focus || num(p.car.position, 99) < num(focus.car.position, 99)) focus = p; }); }
      if (focus && lastFocusPos && Math.hypot(focus.x - lastFocusPos[0], focus.y - lastFocusPos[1]) > 60) { modeCam.init = false; blend.t = 1; }
      if (focus) lastFocusPos = [focus.x, focus.y];

      // --- camera
      if (camOverride) {
        cam.x = num(camOverride.x, cam.x); cam.y = num(camOverride.y, cam.y);
        cam.zoom = num(camOverride.zoom, cam.zoom); cam.rot = num(camOverride.rot, cam.rot);
      } else updateCamera(realDt, focus);

      // --- simulation-driven effects
      if (simDt > 0) {
        for (i = 0; i < poses.length; i++) emitCar(poses[i], simDt, simT);
        if (W.wetLevel >= 1) {
          var vb = viewBox(0), ns = Math.round(st.q.splash * simDt * 10);
          for (var r = 0; r < ns; r++) Pa.spawn(PT.SPLASH, lerp(vb.x0, vb.x1, Math.random()), lerp(vb.y0, vb.y1, Math.random()), 0, 0, 0.35, 0.18 + Math.random() * 0.15, 0, 0.7);
        }
        Pa.update(simDt, { x: 1.4, y: 0.7 });
      }
      handleEvents(snap, poses, focus);

      // --- world
      var devPpm = cam.zoom * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = W.groundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      applyView(ctx);
      var box = viewBox(4);
      var ts = tiles.draw(ctx, box, devPpm, st.q.maxLevel, cam.x, cam.y);
      skids.draw(ctx, box, simT, W.wetLevel);
      drawRacingLine(ctx, focus);
      // cars: lower layer, bridge decks, upper layer
      var low = [], high = [];
      for (i = 0; i < poses.length; i++) {
        var pp = poses[i];
        if (pp.x < box.x0 - 8 || pp.x > box.x1 + 8 || pp.y < box.y0 - 8 || pp.y > box.y1 + 8) continue;
        (pp.layer ? high : low).push(pp);
      }
      // the focus car is drawn last in its layer so it is never hidden by a rival
      function byFocus(a, b) { return (a === focus ? 1 : 0) - (b === focus ? 1 : 0); }
      low.sort(byFocus); high.sort(byFocus);
      drawShadows(ctx, low);
      for (i = 0; i < low.length; i++) drawCar(ctx, low[i], devPpm, low[i] === focus);
      if (G.bridges.length) {
        drawBridgeDecks(ctx);
        drawShadows(ctx, high);
        for (i = 0; i < high.length; i++) drawCar(ctx, high[i], devPpm, high[i] === focus);
      }
      drawGhost(ctx, snap.ghost, focus);
      drawParticles(ctx, Pa, S, box, { dark: W.night, dusk: W.dusk, W: W });

      // --- tall scenery (fake 3D)
      var camH = Math.max(40, 1.25 * Math.max(cssW, cssH) / cam.zoom);
      var sl = Math.hypot(W.sun.x, W.sun.y) || 1;
      var V = {
        ex: cam.x, ey: cam.y, leanK: 1 / camH, toScreen: toScreen, lx: -W.sun.x / sl, ly: -W.sun.y / sl,
        dark: W.night, dusk: W.dusk, t: clock.anim, ppm: cam.zoom, W: W, snap: snap, S: S, camRot: cam.rot,
        wind: W.wetLevel ? 2 : 1, pattern: patternFor
      };
      var tallBox = { x0: box.x0 - 30, y0: box.y0 - 30, x1: box.x1 + 30, y1: box.y1 + 30 };
      var tall = [];
      var stampSet = new Set();
      G.tallb.query(tallBox.x0, tallBox.y0, tallBox.x1, tallBox.y1, function (id) {
        if (stampSet.has(id)) return; stampSet.add(id);
        var o = G.tall[id]; if (o) tall.push(o);
      });
      tall.forEach(function (o) { o._d = (o.x - cam.x) * (o.x - cam.x) + (o.y - cam.y) * (o.y - cam.y); });
      tall.sort(function (a, b) { return b._d - a._d; });
      ctx.lineJoin = 'round';
      for (i = 0; i < tall.length; i++) {
        try { drawTall(ctx, tall[i], V); } catch (err) { /* a broken prop must never kill the frame */ }
      }

      // --- lighting
      var dark = W.night || W.dusk;
      if (dark) {
        renderLights(poses, tall, box);
        applyView(ctx);
        for (i = 0; i < tall.length; i++) { try { drawTallEmissive(ctx, tall[i], V); } catch (err2) { /* ignore */ } }
      } else if (W.wetLevel) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(40,56,76,' + (0.10 * W.wetLevel).toFixed(3) + ')';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      if (!dark && G.gantry._lights) { for (i = 0; i < tall.length; i++) if (tall[i] === G.gantry) drawTallEmissive(ctx, G.gantry, V); }
      drawCarEmissive(ctx, poses, W.night || W.dusk);
      drawEmissiveParticles(ctx, Pa, S, box);

      // --- screen space
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (W.wetLevel >= 1 || st.weather === 'wet') {
        var mv = focus ? Math.abs(num(focus.car.speed, 0)) * cam.zoom : 0;
        var hv = focus ? focus.h : 0;
        var svx = Math.cos(hv) * mv, svy = -Math.sin(hv) * mv, cr = Math.cos(cam.rot), sr = Math.sin(cam.rot);
        rain.n = Math.min(rain.x.length, st.q.rain);
        rain.draw(ctx, cssW, cssH, realDt, 1, svx * cr - svy * sr, svx * sr + svy * cr, dark);
      }
      if (dark || W.wetLevel) {
        var vg = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH / 2, Math.hypot(cssW, cssH) * 0.6);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,8,' + (W.night ? 0.45 : 0.22) + ')');
        ctx.fillStyle = vg; ctx.fillRect(0, 0, cssW, cssH);
      }
      drawLabels(ctx, poses, focus);

      // --- background work: paint queued tiles within the budget
      var budget = clock.sinceReset < 4 ? 45 : st.q.budget;
      var painted = tiles.work(budget);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      var ms = now() - t0;
      governor(ms);
      lastStats = { level: ts.level, drawn: ts.drawn, fallback: ts.fallback, ms: ms, painted: painted };
    }

    function clearEffects() {
      skids.clear(); Pa.clear(); carFx.clear(); finishedFx = {};
    }

    /* ---------------------------------------------------------- public API */

    var api = {
      canvas: canvas,
      cameras: CAMERA_MODES.slice(),
      render: render,
      setCamera: function (mode) {
        if (CAMERA_MODES.indexOf(mode) < 0) return st.camera;
        if (mode !== st.camera) {
          startBlend(0.9);
          st.camera = mode;
          tvState.idx = -1;
          modeCam.init = false;   // new mode starts from its own target; the blend hides the jump
        }
        return st.camera;
      },
      cycleCamera: function () {
        var i = CAMERA_MODES.indexOf(st.camera);
        return api.setCamera(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
      },
      getCamera: function () { return st.camera; },
      getView: function () { return { x: cam.x, y: cam.y, zoom: cam.zoom, rot: cam.rot, width: cssW, height: cssH }; },
      worldToScreen: function (x, y) { return toScreen(x, y); },
      screenToWorld: function (x, y) { return toWorld(x, y); },
      follow: function (id) { st.followId = id == null ? null : id; return st.followId; },
      resize: function () { resize(); },
      reset: function () {
        clearEffects();
        modeCam.init = false; blend.t = 1; tvState.idx = -1;
        clock.simT = null; clock.sinceReset = 0; shake.amp = 0; lastFocusPos = null;
      },
      setRacingLine: function (on) { st.racingLine = !!on; },
      setLabels: function (on) { st.labels = !!on; },
      setQuality: function (q) {
        st.quality = QUALITY[q] ? q : 'auto';
        setQualityLevel(QUALITY[q] ? q : 'high');
        perf.samples = 0;
        return st.quality;
      },
      setWeather: function (w) { if (w !== st.weather) { st.weather = w; rebuild(); clearEffects(); } },
      setTimeOfDay: function (t) { if (t !== st.timeOfDay) { st.timeOfDay = t; rebuild(); } },
      stats: function () {
        return {
          fps: Math.round(perf.fps), renderMs: Math.round(lastStats.ms * 100) / 100, avgMs: Math.round(perf.avg * 100) / 100,
          tileLevel: lastStats.level, tilesDrawn: lastStats.drawn, tilesFallback: lastStats.fallback, tilesCached: tiles.count,
          tilesPainted: tiles.painted, tilePaintMs: Math.round(tiles.paintMs), particles: Pa.n, skids: skids.size,
          quality: st.q === QUALITY.high ? 'high' : st.q === QUALITY.medium ? 'medium' : 'low', qualityMode: st.quality,
          camera: st.camera, zoom: cam.zoom, dpr: dpr
        };
      },
      destroy: function () {
        st.destroyed = true;
        if (tiles) tiles.clear();
        S.clear(); carCache.clear(); carFx.clear(); mainPatterns.clear();
        skids.clear(); Pa.clear();
        lm = null; lmCtx = null;
      }
    };
    if (opts.quality && QUALITY[opts.quality]) setQualityLevel(opts.quality);
    resize();
    return api;
  }

  /* ================================================================ module surface */

  return {
    create: create,
    cameras: CAMERA_MODES.slice(),
    WORLD_Y_UP: true,
    // pure helpers exposed for tests / other modules
    _internals: {
      prepGeom: prepGeom, pointAt: pointAt, idxAtS: idxAtS, sampleRuns: sampleRuns, carModel: carModel, bodyHints: bodyHints, buildCarSprite: buildCarSprite, drawWheels: drawWheels, shapeFitted: shapeFitted,
      bodyHalfAt: bodyHalfAt, computeVMax: computeVMax, hexToRgb: hexToRgb, shade: shade, mix: mix, hueShift: hueShift,
      luminance: luminance, rng: rng, hashStr: hashStr, wrapAngle: wrapAngle, lerpAngle: lerpAngle, convexHull: convexHull,
      SkidBuffer: SkidBuffer, Particles: Particles, PT: PT, LEVELS: LEVELS.slice()
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.race.renderer;

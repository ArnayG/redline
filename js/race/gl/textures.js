/* ==========================================================================
   FORGE Atelier — js/race/gl/textures.js
   CB.gl.textures : procedural textures for the 3D race renderer (docs/RACE3D-SPEC.md).

   Every texture is generated at runtime (canvas 2D or pure-JS pixel buffers),
   uploaded as RGBA8, mipmapped (power-of-two sizes everywhere so WebGL1 can mip
   and REPEAT), anisotropically filtered when EXT_texture_filter_anisotropic is
   available, and CACHED PER GL CONTEXT (same call + same args -> same texture).

   Public API (ctx = object from CB.gl.createContext, or a raw WebGL context):
     asphalt(ctx, {wet})          asphaltNormal(ctx)        grass(ctx, {stripes})
     sand(ctx)  gravel(ctx)  gravelNormal(ctx)  concrete(ctx)  barrierArmco(ctx)
     kerb(ctx, colorA, colorB)    tyreWall(ctx, {paint})     crowd(ctx, {frame})
     trees(ctx)  (atlas; tex.atlas describes cells, also TREE_SPECIES)
     buildingFacade(ctx, seed, night)   billboard(ctx, text|index, brandColor)
     startLine(ctx)  gridBox(ctx, number)  skidmark(ctx)  smoke(ctx)  spark(ctx)
     rainDrop(ctx)  carNumber(ctx, number, color)  tireSidewall(ctx, {stripe})  numberPlate(ctx, text, {country})
     carbonWeave(ctx)  white(ctx)  black(ctx)  flatNormal(ctx)
     asphaltMottle(ctx)  (macro variation; sample at ASPHALT_MOTTLE_M = 41 m vs the 6 m base tile)
     car material families -> albedo; + <fam>Normal / <fam>Orm (/ <fam>Emissive for lamps):
       tyreTread({pattern})  brakeDisc({type, hat})  caliper({color, text, sub, finish})
       brushedMetal({style, tint, finish})  carbonFibre({style})  headlight({style})
       taillight({style, smoked})  grille({pattern, finish})  leather({color, style, stitch})
         headlight styles: projector reflector round led matrix laser oval-4pt c-clamp y-blade
           round-halo slim-led projector-twin quad-round blade (T.HEADLIGHT_STYLES)
         taillight styles: cluster bar ring blade light-bar c-ring round-ring slim full-width
           y-shape vertical quad-round (T.TAILLIGHT_STYLES)
         grille patterns: honeycomb slats vertical mesh diamond kidney blanked seven-slot hex
           horseshoe split-v bar (T.GRILLE_PATTERNS); unknown values -> the family default
       alcantara({color})   tireSidewallNormal/Orm   carNumber(..., {style, sdf})
       carSet(ctx, family, opts) -> {map, normalMap, ormMap, emissiveMap, meta}
       ORM = glTF packing (R occlusion, G roughness, B metalness), all non-albedo maps linear.
     dashboard(ctx, {width,height}) -> dynamic gauge canvas {canvas, g, texture, draw(state), update(fn)}
     dynamic(ctx, w, h)           -> generic per-frame canvas texture
     canvas(ctx, w, h, drawFn, opts) -> WebGLTexture from a one-off canvas drawing
     generate(name, opts)         -> raw source (canvas or {data,width,height}) without GL
     preload(ctx, names?, onProgress?) -> Promise (generates in idle slices)
     setQuality('low'|'medium'|'high'|'ultra'), invalidate(ctx), dispose(ctx), info(tex), stats(ctx)

   Conventions
     - Color textures are sRGB-encoded RGBA8 (decode with pow(c, 2.2) in shader).
       Normal maps are linear, tangent space, R = +u, G = +v (v grows with canvas
       rows, i.e. v = 0 at the TOP row; UNPACK_FLIP_Y is false), B = up.
     - Textures with alpha are NOT premultiplied; transparent texels carry dilated
       color so filtering/mipmapping never creates dark halos. Alpha-tested atlases
       (trees) use coverage-preserving mipmaps (alpha test threshold 0.5).
     - Every returned WebGLTexture gets expando fields: tex.width, tex.height,
       tex.key, tex.wrapS, tex.wrapT, and for atlases tex.atlas.
     - When there is no DOM/OffscreenCanvas (Node), canvas-based textures return
       null (and generate() throws a clear Error); pure pixel textures still work.
   UV layouts are documented on each generator below.
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.gl = CB.gl || {};
  var T = CB.gl.textures && typeof CB.gl.textures === 'object' ? CB.gl.textures : {};

  /* ==================================================================== math */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(e0, e1, x) { var t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }
  function fract(x) { return x - Math.floor(x); }
  function mod(a, n) { return ((a % n) + n) % n; }

  function hashStr(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  /** mulberry32 PRNG -> function returning [0,1). Extra helpers attached. */
  function rng(seed) {
    var a = (typeof seed === 'string' ? hashStr(seed) : (seed >>> 0)) || 0x9e3779b9;
    function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    next.range = function (lo, hi) { return lo + (hi - lo) * next(); };
    next.int = function (lo, hi) { return Math.floor(lo + (hi - lo + 1) * next()); };
    next.pick = function (arr) { return arr[Math.floor(next() * arr.length) % arr.length]; };
    next.chance = function (p) { return next() < p; };
    return next;
  }
  /** integer lattice hash -> [0,1) */
  function hash2(x, y, s) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((s | 0) + 1, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  /** Float32Array of len uniform randoms */
  function whiteNoise(len, seed) {
    var r = rng(seed), out = new Float32Array(len);
    for (var i = 0; i < len; i++) out[i] = r();
    return out;
  }

  /**
   * Periodic (tileable) fractal value noise sampled on an nx*ny grid.
   * px, py = lattice period of the first octave (cells across the tile); each octave doubles it.
   * Returns Float32Array in [0,1], with .nx/.ny for sampleField.
   */
  function noiseField(nx, ny, px, py, octaves, seed, persistence) {
    var out = new Float32Array(nx * ny);
    var amp = 1, total = 0, pers = persistence == null ? 0.5 : persistence;
    octaves = octaves || 1;
    for (var o = 0; o < octaves; o++) {
      var PX = Math.max(1, Math.min(px << o, nx)), PY = Math.max(1, Math.min(py << o, ny));
      var lat = whiteNoise(PX * PY, (seed | 0) * 7919 + o * 104729 + 17);
      for (var y = 0; y < ny; y++) {
        var fy = y / ny * PY, y0 = Math.floor(fy), ty = fy - y0;
        ty = ty * ty * (3 - 2 * ty);
        var r0 = (y0 % PY) * PX, r1 = ((y0 + 1) % PY) * PX;
        for (var x = 0; x < nx; x++) {
          var fx = x / nx * PX, x0 = Math.floor(fx), tx = fx - x0;
          tx = tx * tx * (3 - 2 * tx);
          var x0w = x0 % PX, x1w = (x0 + 1) % PX;
          var a = lat[r0 + x0w], b = lat[r0 + x1w], c = lat[r1 + x0w], d = lat[r1 + x1w];
          out[y * nx + x] += amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
        }
      }
      total += amp; amp *= pers;
    }
    for (var i = 0; i < out.length; i++) out[i] /= total;
    out.nx = nx; out.ny = ny;
    return out;
  }
  /** bilinear wrap sample of a noiseField at (u, v) in tile units (any real; wraps) */
  function sampleField(f, u, v) {
    var nx = f.nx, ny = f.ny;
    var fx = fract(u) * nx, fy = fract(v) * ny;
    var x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    x0 %= nx; y0 %= ny;
    var x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny;
    var a = f[y0 * nx + x0], b = f[y0 * nx + x1], c = f[y1 * nx + x0], d = f[y1 * nx + x1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /* ================================================================== color */
  var NAMED = {
    red: [208, 24, 24], white: [244, 244, 244], blue: [20, 70, 200], yellow: [250, 210, 20],
    green: [20, 150, 60], black: [12, 12, 12], orange: [255, 120, 20], grey: [128, 128, 128],
    gray: [128, 128, 128], silver: [192, 192, 196], gold: [212, 162, 76], purple: [110, 40, 160]
  };
  /** '#rgb' | '#rrggbb' | 'rgb(a)()' | name | [r,g,b] | {r,g,b} -> [r,g,b] 0..255 */
  function parseColor(c, fallback) {
    fallback = fallback || [128, 128, 128];
    if (c == null) return fallback.slice();
    if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0];
    if (typeof c === 'object' && 'r' in c) {
      var s = (c.r <= 1 && c.g <= 1 && c.b <= 1) ? 255 : 1;
      return [Math.round(c.r * s), Math.round(c.g * s), Math.round(c.b * s)];
    }
    if (typeof c === 'number') return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    var str = String(c).trim().toLowerCase();
    if (NAMED[str]) return NAMED[str].slice();
    var m;
    if (str[0] === '#') {
      var hex = str.slice(1);
      if (hex.length === 3 || hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (/^[0-9a-f]{6}/.test(hex)) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    } else if ((m = str.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/))) {
      return [+m[1] | 0, +m[2] | 0, +m[3] | 0];
    }
    return fallback.slice();
  }
  function css(c, a) {
    return a == null || a >= 1
      ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'
      : 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (+a).toFixed(3) + ')';
  }
  function mixC(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function scaleC(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function hsl(h, s, l) {
    h = mod(h, 360) / 360;
    function f(n) {
      var k = mod(n + h * 12, 12), a = s * Math.min(l, 1 - l);
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    }
    return [f(0), f(8), f(4)];
  }
  function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  /* ========================================================= pixel buffers */
  function makePixels(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  function setPx(d, i, r, g, b, a) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a == null ? 255 : a; }

  /**
   * Tangent-space normal map from a height field (Float32 0..1, wraps at edges).
   * strength scales slopes (height units per texel). Returns Uint8ClampedArray RGBA.
   */
  function heightToNormal(height, w, h, strength) {
    var out = new Uint8ClampedArray(w * h * 4), k = strength == null ? 2 : strength;
    for (var y = 0; y < h; y++) {
      var ym = ((y - 1 + h) % h) * w, yc = y * w, yp = ((y + 1) % h) * w;
      for (var x = 0; x < w; x++) {
        var xm = (x - 1 + w) % w, xp = (x + 1) % w;
        // Sobel
        var dx = (height[ym + xp] + 2 * height[yc + xp] + height[yp + xp]) - (height[ym + xm] + 2 * height[yc + xm] + height[yp + xm]);
        var dy = (height[yp + xm] + 2 * height[yp + x] + height[yp + xp]) - (height[ym + xm] + 2 * height[ym + x] + height[ym + xp]);
        var nx = -dx * k * 0.25, ny = -dy * k * 0.25, nz = 1;
        var inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        var i = (yc + x) * 4;
        out[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        out[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        out[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
        out[i + 3] = 255;
      }
    }
    return out;
  }

  /**
   * Fill rgb of (nearly) transparent texels with the colour of neighbouring opaque texels
   * (iterative dilation), then the remaining ones with the average opaque colour. Alpha untouched.
   */
  function dilateRGB(data, w, h, passes, alphaMin) {
    var n = w * h, filled = new Uint8Array(n), amin = alphaMin == null ? 8 : alphaMin;
    var sr = 0, sg = 0, sb = 0, cnt = 0, i, p;
    for (i = 0; i < n; i++) {
      if (data[i * 4 + 3] >= amin) { filled[i] = 1; sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; cnt++; }
    }
    if (!cnt) return data;
    passes = passes == null ? 6 : passes;
    var next = new Uint8Array(n);
    for (p = 0; p < passes; p++) {
      next.set(filled);
      var changed = false;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          i = y * w + x;
          if (filled[i]) continue;
          var r = 0, g = 0, b = 0, c = 0;
          for (var dy = -1; dy <= 1; dy++) {
            var yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx; if (xx < 0 || xx >= w) continue;
              var j = yy * w + xx;
              if (filled[j]) { r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; c++; }
            }
          }
          if (c) { data[i * 4] = r / c; data[i * 4 + 1] = g / c; data[i * 4 + 2] = b / c; next[i] = 1; changed = true; }
        }
      }
      filled.set(next);
      if (!changed) break;
    }
    var ar = sr / cnt, ag = sg / cnt, ab = sb / cnt;
    for (i = 0; i < n; i++) if (!filled[i]) { data[i * 4] = ar; data[i * 4 + 1] = ag; data[i * 4 + 2] = ab; }
    return data;
  }

  function coverage(data, thr) {
    var c = 0, n = data.length / 4, t = thr * 255;
    for (var i = 3; i < data.length; i += 4) if (data[i] > t) c++;
    return n ? c / n : 0;
  }
  /**
   * Full mip chain by alpha-weighted 2x2 box filter. If coverageThreshold is given, each level's
   * alpha is rescaled so the fraction of texels passing an alpha test at that threshold matches
   * level 0 (keeps alpha-tested foliage from thinning out in the distance).
   * plainRGB: average colour without alpha weighting (for masks whose openings carry a meaningful
   * dark colour, e.g. grille holes, so opaque use stays dark in the distance).
   * Returns [{width, height, data}] (level 0 = the input).
   */
  function buildMips(data, w, h, coverageThreshold, plainRGB) {
    var levels = [{ width: w, height: h, data: data }];
    var useCov = coverageThreshold != null, cov0 = useCov ? coverage(data, coverageThreshold) : 0;
    var cur = data, cw = w, ch = h;
    while (cw > 1 || ch > 1) {
      var nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1), nd = new Uint8ClampedArray(nw * nh * 4);
      for (var y = 0; y < nh; y++) {
        for (var x = 0; x < nw; x++) {
          var r = 0, g = 0, b = 0, a = 0, pr = 0, pg = 0, pb = 0, k = 0;
          for (var dy = 0; dy < 2; dy++) {
            var sy = Math.min(ch - 1, y * 2 + dy);
            for (var dx = 0; dx < 2; dx++) {
              var sx = Math.min(cw - 1, x * 2 + dx), si = (sy * cw + sx) * 4, sa = cur[si + 3];
              r += cur[si] * sa; g += cur[si + 1] * sa; b += cur[si + 2] * sa; a += sa;
              pr += cur[si]; pg += cur[si + 1]; pb += cur[si + 2]; k++;
            }
          }
          var di = (y * nw + x) * 4;
          if (a > 0 && !plainRGB) { nd[di] = r / a; nd[di + 1] = g / a; nd[di + 2] = b / a; }
          else { nd[di] = pr / k; nd[di + 1] = pg / k; nd[di + 2] = pb / k; }
          nd[di + 3] = a / k;
        }
      }
      if (useCov && cov0 > 0 && nw * nh >= 4) {
        var lo = 0, hi = 8, t = coverageThreshold * 255, n = nw * nh;
        for (var it = 0; it < 12; it++) {
          var mid = (lo + hi) / 2, c = 0;
          for (var q = 3; q < nd.length; q += 4) if (nd[q] * mid > t) c++;
          if (c / n < cov0) lo = mid; else hi = mid;
        }
        var s = (lo + hi) / 2;
        for (var q2 = 3; q2 < nd.length; q2 += 4) nd[q2] = Math.min(255, nd[q2] * s);
      }
      levels.push({ width: nw, height: nh, data: nd });
      cur = nd; cw = nw; ch = nh;
    }
    return levels;
  }

  /* ================================================================ canvas */
  var canvasFactory = null;
  function hasCanvas() {
    if (canvasFactory) return true;
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') return true;
    return typeof OffscreenCanvas !== 'undefined';
  }
  /** create a canvas (DOM, OffscreenCanvas, or injected factory). Throws a clear Error in Node. */
  function makeCanvas(w, h) {
    var c;
    if (canvasFactory) c = canvasFactory(w, h);
    else if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') c = document.createElement('canvas');
    else if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
    else {
      var e = new Error('CB.gl.textures: no canvas available (no document / OffscreenCanvas) - canvas textures can only be generated in a browser');
      e.code = 'CB_NO_CANVAS';
      throw e;
    }
    c.width = w; c.height = h;
    return c;
  }
  function ctx2d(c) {
    var g = c.getContext('2d', { willReadFrequently: true }) || c.getContext('2d');
    if (!g) throw new Error('CB.gl.textures: 2D canvas context unavailable');
    return g;
  }
  /** draw a pixel function straight into canvas */
  function pixelPass(g, w, h, fn) {
    var img = g.createImageData(w, h), d = img.data;
    for (var y = 0, i = 0; y < h; y++) for (var x = 0; x < w; x++, i += 4) fn(x, y, i, d);
    g.putImageData(img, 0, 0);
  }
  /** run fn at the 9 wrap offsets (for strokes that must tile) */
  function each9(g, w, h, fn) {
    for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
      g.save(); g.translate(ox * w, oy * h); fn(); g.restore();
    }
  }
  function readPixels(g, w, h) {
    var img = g.getImageData(0, 0, w, h);
    return { width: w, height: h, data: img.data };
  }
  var FONT_HEAVY = '"Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif';
  var FONT_SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  var FONT_COND = '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  /** pick largest font size (<= size) whose text width fits maxW */
  function fitFont(g, text, maxW, size, weight, family) {
    var s = size;
    for (var i = 0; i < 30; i++) {
      g.font = weight + ' ' + Math.round(s) + 'px ' + family;
      var m = g.measureText(text);
      if (!m || !(m.width > maxW)) break;
      s *= 0.92;
    }
    return Math.round(s);
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function spacedText(g, text, x, y, spacing) {
    // manual letter spacing (canvas letterSpacing is not universal)
    var total = 0, i, ws = [];
    for (i = 0; i < text.length; i++) { var mw = g.measureText(text[i]); ws.push(mw && mw.width || 0); total += ws[i] + (i ? spacing : 0); }
    var align = g.textAlign, cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    var save = g.textAlign; g.textAlign = 'left';
    for (i = 0; i < text.length; i++) { g.fillText(text[i], cx, y); cx += ws[i] + spacing; }
    g.textAlign = save;
    return total;
  }

  /* ================================================================ quality */
  var QUALITY = { low: 0.5, medium: 0.5, high: 1, ultra: 1 };
  var quality = 'high';
  function S(base, minSize) {
    var s = base * (QUALITY[quality] || 1);
    if (quality === 'ultra' && base >= 1024) s = base * 2;
    return Math.max(minSize || 16, pot(s));
  }
  function pot(v) { var p = 1; while (p < v) p <<= 1; return p; }

  /* ===================================================== sponsors (logos) */
  var SPONSORS = [
    { id: 'forge', name: 'REDLINE', tagline: 'BUILD  \u00b7  RACE  \u00b7  DRIFT', bg: ['#0c0c0e', '#22201c'], fg: '#f2ead8', accent: '#e0412f', logo: 'forge' },
    { id: 'veloce', name: 'VELOCE OIL', tagline: 'SYNTHETIC RACING LUBRICANTS', bg: ['#0a2e78', '#1450b8'], fg: '#ffffff', accent: '#ffcc00', logo: 'drop' },
    { id: 'kronos', name: 'KRONOS', tagline: 'OFFICIAL TIMEKEEPER', bg: ['#f4f4f2', '#d9d9d6'], fg: '#111111', accent: '#d81e2c', logo: 'watch' },
    { id: 'apex', name: 'APEX TYRES', tagline: 'GRIP IS EVERYTHING', bg: ['#ffd100', '#ffb800'], fg: '#111111', accent: '#111111', logo: 'tyre' },
    { id: 'nimbus', name: 'NIMBUS ENERGY', tagline: 'POWER THE NIGHT', bg: ['#003d2b', '#00a86b'], fg: '#ffffff', accent: '#c6ff3d', logo: 'bolt' },
    { id: 'halcyon', name: 'HALCYON BANK', tagline: 'PRIVATE BANKING SINCE 1897', bg: ['#071631', '#0f2d5c'], fg: '#ffffff', accent: '#3fd0c9', logo: 'wing' },
    { id: 'orbital', name: 'ORBITAL', tagline: 'TELECOM  \u00b7  ALWAYS CONNECTED', bg: ['#3a1260', '#6b2fa0'], fg: '#ffffff', accent: '#ff6ad5', logo: 'orbit' },
    { id: 'meridian', name: 'MERIDIAN AIR', tagline: 'FLY FURTHER', bg: ['#a50d24', '#d8183a'], fg: '#ffffff', accent: '#ffffff', logo: 'globe' },
    { id: 'torque', name: 'TORQUE LABS', tagline: 'ENGINEERED TO WIN', bg: ['#151517', '#2b2b2f'], fg: '#ffffff', accent: '#ff6a00', logo: 'gear' }
  ];
  function findSponsor(text) {
    if (typeof text === 'number' && isFinite(text)) return SPONSORS[mod(Math.floor(text), SPONSORS.length)];
    if (text == null || text === '') return SPONSORS[0];
    var t = String(text).trim().toUpperCase();
    for (var i = 0; i < SPONSORS.length; i++) {
      var s = SPONSORS[i];
      if (t === s.name || t === s.id.toUpperCase() || t.split(/\s+/)[0] === s.name.split(' ')[0]) return s;
    }
    return null;
  }

  /* ============================================================ generators
     Each generator(opts) -> { source, wrapS, wrapT, aniso, mips, coverage }
     source: HTMLCanvasElement/OffscreenCanvas | {width,height,data}
     needsCanvas marks generators that require a 2D canvas.                */
  var GEN = {};
  var NEEDS_CANVAS = {};

  /* ---------------------------------------------------------------- asphalt
     Tileable (REPEAT) road surface, isotropic: u across, v along the road.
     Aggregate grain, quartz specks, cracks with branches, sealed tar snakes,
     repaired patches, oil stains. opts.wet darkens + adds puddle sheen tone.  */
  function drawAsphalt(g, W, opts) {
    var seed = opts.seed == null ? 7 : opts.seed;
    var heightMode = !!opts.heightMode;
    var low = noiseField(128, 128, 4, 4, 4, seed + 1);
    var mid = noiseField(256, 256, 16, 16, 3, seed + 2);
    var tint = noiseField(64, 64, 3, 3, 2, seed + 3);
    var wn = whiteNoise(W * W, seed + 4), wn2 = whiteNoise(W * W, seed + 5);
    pixelPass(g, W, W, function (x, y, i, d) {
      var u = x / W, v = y / W, k = y * W + x;
      var h = wn[k], h2 = wn2[k];
      var lo = sampleField(low, u, v), mi = sampleField(mid, u, v);
      if (heightMode) {
        var hv = 0.45 + (mi - 0.5) * 0.25 + (h - 0.5) * 0.35;
        if (h2 > 0.955) hv += 0.35 + (h2 - 0.955) * 4;
        else if (h2 < 0.04) hv -= 0.3;
        var c = clamp(hv * 255, 0, 255); setPx(d, i, c, c, c); return;
      }
      // low-frequency content kept weak: anything >1 m inside a 6 m tile repeats visibly down a
      // straight. Macro variation comes from asphaltMottle sampled at a different world scale.
      var b = 60 + (lo - 0.5) * 4 + (mi - 0.5) * 9 + (h - 0.5) * 22;
      var r = b, gg = b, bb = b + 2;
      if (h2 > 0.962) { var s = 34 + (h2 - 0.962) * 1500; r += s + 6; gg += s + 3; bb += s; }
      else if (h2 < 0.035) { r -= 22; gg -= 22; bb -= 21; }
      var tn = sampleField(tint, u, v) - 0.5;
      r += tn * 2; gg += tn * 1.5; bb -= tn * 0.8;
      setPx(d, i, r, gg, bb);
    });
    var R = rng(seed + 11), n, j;
    // individual stones (slightly bigger aggregate with a lit edge)
    var stones = Math.round(W * W / 260);
    for (n = 0; n < stones; n++) {
      var sx = R() * W, sy = R() * W, rr = 0.6 + Math.pow(R(), 2) * 2.2, tone = 70 + R() * 70;
      if (heightMode) { g.fillStyle = css([200, 200, 200], 0.7); }
      else g.fillStyle = css([tone + 4, tone + 2, tone], 0.55 + R() * 0.35);
      g.beginPath(); g.ellipse(sx, sy, rr, rr * (0.6 + R() * 0.4), R() * PI, 0, TAU); g.fill();
      if (!heightMode && rr > 1.4) {
        g.fillStyle = 'rgba(220,220,215,0.25)';
        g.beginPath(); g.arc(sx - rr * 0.3, sy - rr * 0.3, rr * 0.35, 0, TAU); g.fill();
      }
    }
    // (no discrete repair patches: the road maps 1 tile = 6 m, so any single large feature
    //  repeats down the straight as an obvious grid. Keep the surface statistically uniform.)
    // cracks: branching random walks
    var cracks = [];
    function walk(x, y, ang, steps, depth) {
      var pts = [[x, y]];
      for (var s2 = 0; s2 < steps; s2++) {
        ang += (R() - 0.5) * 0.9;
        var st = (3 + R() * 7) * W / 1024;
        x += Math.cos(ang) * st; y += Math.sin(ang) * st;
        pts.push([x, y]);
        if (depth < 2 && R() < 0.07) walk(x, y, ang + (R() < 0.5 ? 1 : -1) * (0.7 + R() * 0.8), (steps * 0.45) | 0, depth + 1);
      }
      cracks.push({ pts: pts, w: (depth ? 0.6 : 1.0) * Math.max(0.7, W / 1024) });
    }
    for (n = 0; n < 7; n++) walk(R() * W, R() * W, R() * TAU, 10 + (R() * 18 | 0), 0);
    each9(g, W, W, function () {
      cracks.forEach(function (c) {
        g.beginPath(); g.moveTo(c.pts[0][0], c.pts[0][1]);
        for (var k = 1; k < c.pts.length; k++) g.lineTo(c.pts[k][0], c.pts[k][1]);
        g.lineJoin = 'round'; g.lineCap = 'round';
        if (heightMode) { g.strokeStyle = 'rgba(0,0,0,0.32)'; g.lineWidth = c.w * 1.3; g.stroke(); return; }
        g.strokeStyle = 'rgba(20,20,22,0.15)'; g.lineWidth = c.w; g.stroke();
        g.save(); g.translate(0.8, 0.8); g.strokeStyle = 'rgba(150,150,150,0.035)'; g.lineWidth = c.w * 0.7; g.stroke(); g.restore();
      });
    });
    if (heightMode) return;
    // tar snakes (sealed cracks): glossy black wavy bands
    for (n = 0; n < 3; n++) {
      var tx = R() * W, ty = R() * W, ta = R() * TAU, len = 12 + (R() * 16 | 0), tpts = [[tx, ty]];
      for (j = 0; j < len; j++) { ta += (R() - 0.5) * 0.5; tx += Math.cos(ta) * 6 * W / 1024; ty += Math.sin(ta) * 6 * W / 1024; tpts.push([tx, ty]); }
      var tw = (2.5 + R() * 2.5) * W / 1024;
      each9(g, W, W, function () {
        g.beginPath(); g.moveTo(tpts[0][0], tpts[0][1]);
        for (var k = 1; k < tpts.length; k++) g.lineTo(tpts[k][0], tpts[k][1]);
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = 'rgba(22,22,24,0.08)'; g.lineWidth = tw; g.stroke();
        g.strokeStyle = 'rgba(120,125,135,0.03)'; g.lineWidth = tw * 0.3; g.stroke();
      });
    }
    // oil stains: blotchy radial gradients with faint iridescent rim
    for (n = 0; n < 9; n++) {
      var ox = R() * W, oy = R() * W, orad = W * (0.006 + R() * 0.012), blobs = 2 + (R() * 4 | 0), bl = [];
      for (j = 0; j < blobs; j++) bl.push([ox + (R() - 0.5) * orad * 1.6, oy + (R() - 0.5) * orad * 1.6, orad * (0.4 + R() * 0.7)]);
      each9(g, W, W, function () {
        bl.forEach(function (b) {
          if (typeof g.createRadialGradient !== 'function') return;
          var gr = g.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
          gr.addColorStop(0, 'rgba(14,11,8,0.07)'); gr.addColorStop(0.65, 'rgba(18,14,10,0.035)');
          gr.addColorStop(0.85, 'rgba(70,40,90,0.012)'); gr.addColorStop(1, 'rgba(20,16,10,0)');
          g.fillStyle = gr; g.beginPath(); g.arc(b[0], b[1], b[2], 0, TAU); g.fill();
        });
      });
    }
    if (opts.wet) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = 'rgb(128,131,140)'; g.fillRect(0, 0, W, W);
      g.globalCompositeOperation = 'source-over';
      var pud = noiseField(64, 64, 3, 3, 3, seed + 21);
      pixelPassOver(g, W, function (u, v) { var p = sampleField(pud, u, v); return smooth(0.58, 0.72, p) * 0.45; }, [8, 10, 14]);
    }
  }
  /** blend a solid colour over the canvas with per-pixel alpha fn(u,v) */
  function pixelPassOver(g, W, fn, col) {
    var img = g.getImageData(0, 0, W, W), d = img.data;
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i += 4) {
      var a = fn(x / W, y / W);
      if (a <= 0) continue;
      d[i] += (col[0] - d[i]) * a; d[i + 1] += (col[1] - d[i + 1]) * a; d[i + 2] += (col[2] - d[i + 2]) * a;
    }
    g.putImageData(img, 0, 0);
  }
  GEN.asphalt = function (o) {
    var W = o.size || S(1024), c = makeCanvas(W, W), g = ctx2d(c);
    drawAsphalt(g, W, o);
    return { source: c, wrapS: 'repeat', wrapT: 'repeat', aniso: 16 };
  };
  NEEDS_CANVAS.asphalt = true;
  GEN.asphaltNormal = function (o) {
    var W = o.size || S(1024), c = makeCanvas(W, W), g = ctx2d(c);
    drawAsphalt(g, W, { seed: o.seed, heightMode: true });
    var px = readPixels(g, W, W), hgt = new Float32Array(W * W);
    for (var i = 0; i < W * W; i++) hgt[i] = px.data[i * 4] / 255;
    return { source: { width: W, height: W, data: heightToNormal(hgt, W, W, o.strength || 3.2) }, wrapS: 'repeat', wrapT: 'repeat', aniso: 16, linear: true };
  };
  NEEDS_CANVAS.asphaltNormal = true;

  /* ------------------------------------------------------------------ grass
     Tileable lawn seen from above; u/v isotropic. Mowing stripes run along u
     (opts.stripes, 4 bands per tile: 2 light, 2 dark). Blades lean one way in
     light bands and the other in dark bands, like a real striped lawn.       */
  GEN.grass = function (o) {
    var W = o.size || S(1024), c = makeCanvas(W, W), g = ctx2d(c), seed = o.seed == null ? 3 : o.seed;
    var stripes = o.stripes !== false, dry = clamp01(o.dry || 0);
    var low = noiseField(128, 128, 4, 4, 4, seed + 1), hue = noiseField(64, 64, 3, 3, 3, seed + 2);
    var wn = whiteNoise(W * W, seed + 3);
    function band(v) { var b = fract(v * 2); return stripes ? smooth(0.0, 0.02, b) * (1 - smooth(0.48, 0.5, b)) + smooth(0.98, 1, b) * 0 : 0; }
    pixelPass(g, W, W, function (x, y, i, d) {
      var u = x / W, v = y / W;
      var lo = sampleField(low, u, v), hu = sampleField(hue, u, v);
      var col = hsl(92 + (hu - 0.5) * 30 - dry * 40, 0.42 + (lo - 0.5) * 0.2 - dry * 0.15, 0.24 + (lo - 0.5) * 0.08 + band(v) * 0.05 + dry * 0.08);
      var gr = 1 + (wn[y * W + x] - 0.5) * 0.18;
      setPx(d, i, col[0] * gr, col[1] * gr, col[2] * gr);
    });
    // blades, batched by colour bucket
    var R = rng(seed + 9), NB = 10, buckets = [], b;
    for (b = 0; b < NB; b++) buckets.push([]);
    var blades = Math.round(W * W / 14);
    for (var n = 0; n < blades; n++) {
      var bx = R() * W, by = R() * W, v = by / W, light = band(v) > 0.5;
      var ang = (light ? -0.5 : 0.5) * PI / 2 + (R() - 0.5) * 2.2 - PI / 2;
      var len = (2 + R() * 6) * W / 1024 + 1;
      var bk = Math.min(NB - 1, (R() * NB) | 0);
      buckets[bk].push(bx, by, bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
    }
    g.lineCap = 'round';
    for (b = 0; b < NB; b++) {
      var t = b / (NB - 1);
      var col = hsl(85 + t * 25 - dry * 35, 0.45 + 0.15 * t, 0.16 + t * 0.2 + dry * 0.08);
      g.strokeStyle = css(col, 0.55 + 0.4 * t);
      g.lineWidth = Math.max(0.8, W / 1024);
      g.beginPath();
      var arr = buckets[b];
      for (var k = 0; k < arr.length; k += 4) {
        var x0 = arr[k], y0 = arr[k + 1], x1 = arr[k + 2], y1 = arr[k + 3];
        g.moveTo(x0, y0); g.lineTo(x1, y1);
        var ex = x0 < 10 ? W : x0 > W - 10 ? -W : 0, ey = y0 < 10 ? W : y0 > W - 10 ? -W : 0;
        if (ex) { g.moveTo(x0 + ex, y0); g.lineTo(x1 + ex, y1); }
        if (ey) { g.moveTo(x0, y0 + ey); g.lineTo(x1, y1 + ey); }
        if (ex && ey) { g.moveTo(x0 + ex, y0 + ey); g.lineTo(x1 + ex, y1 + ey); }
      }
      g.stroke();
    }
    // dry patches & clover, tiny flowers
    for (n = 0; n < 7; n++) {
      var cx = R() * W, cy = R() * W, rad = W * (0.03 + R() * 0.06), yellow = R() < 0.5;
      each9(g, W, W, function () {
        if (typeof g.createRadialGradient !== 'function') return;
        var gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, yellow ? 'rgba(150,140,60,0.18)' : 'rgba(20,60,15,0.22)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.fill();
      });
    }
    var flowers = Math.round(W * W / 9000);
    for (n = 0; n < flowers; n++) {
      g.fillStyle = R() < 0.6 ? 'rgba(245,245,235,0.8)' : 'rgba(250,215,60,0.8)';
      g.beginPath(); g.arc(R() * W, R() * W, 0.7 + R() * 0.9, 0, TAU); g.fill();
    }
    return { source: c, wrapS: 'repeat', wrapT: 'repeat', aniso: 16 };
  };
  NEEDS_CANVAS.grass = true;

  /* -------------------------------------------------------------- sand (pure)
     Tileable run-off sand: fine grain, dark mineral & quartz specks, wind ripples
     running along u (ripple crests vary with v), a few pebbles.               */
  GEN.sand = function (o) {
    var W = o.size || S(512), seed = o.seed == null ? 5 : o.seed, P = makePixels(W, W), d = P.data;
    var low = noiseField(64, 64, 3, 3, 4, seed + 1), warp = noiseField(64, 64, 2, 2, 3, seed + 2);
    var wn = whiteNoise(W * W, seed + 3);
    var base = parseColor(o.color || [198, 172, 126]);
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / W, h = wn[y * W + x];
      var lo = sampleField(low, u, v), wp = sampleField(warp, u, v);
      var rip = Math.sin(TAU * (v * 12 + (wp - 0.5) * 2.6 + (lo - 0.5) * 0.6));
      var s = 1 + rip * 0.05 + (lo - 0.5) * 0.16 + (h - 0.5) * 0.12;
      if (h > 0.965) s *= 1.18; else if (h < 0.05) s *= 0.72;
      var tint = h < 0.02 ? [-20, -10, 0] : [0, 0, 0];
      setPx(d, i, base[0] * s + tint[0], base[1] * s + tint[1], base[2] * s + tint[2]);
    }
    pebbles(d, W, W, rng(seed + 7), Math.round(W * W / 3000), 1.2, 3.5, [[150, 132, 110], [120, 110, 100], [190, 175, 150]]);
    return { source: P, wrapS: 'repeat', wrapT: 'repeat', aniso: 16 };
  };
  /** shaded dome pebbles rasterised into pixel buffer (wraps) */
  function pebbles(d, w, h, R, count, rmin, rmax, palette) {
    for (var n = 0; n < count; n++) {
      var cx = R() * w, cy = R() * h, r = rmin + R() * (rmax - rmin), col = palette[(R() * palette.length) | 0], el = 0.6 + R() * 0.4;
      for (var yy = Math.floor(cy - r - 1); yy <= cy + r + 1; yy++) for (var xx = Math.floor(cx - r - 1); xx <= cx + r + 1; xx++) {
        var dx = (xx - cx) / r, dy = (yy - cy) / (r * el), dd = dx * dx + dy * dy;
        var i = (mod(yy, h) * w + mod(xx, w)) * 4;
        if (dd < 1) {
          var nz = Math.sqrt(1 - dd), lit = clamp01(-dx * 0.45 - dy * 0.55 + nz * 0.7);
          var s = 0.45 + 0.75 * lit;
          d[i] = col[0] * s; d[i + 1] = col[1] * s; d[i + 2] = col[2] * s;
        } else if (dd < 1.6 && dx + dy > 0) { // contact shadow
          d[i] *= 0.82; d[i + 1] *= 0.82; d[i + 2] *= 0.82;
        }
      }
    }
  }

  /* ------------------------------------------------------------ gravel (pure)
     Tileable gravel trap: Voronoi stones with dome shading, crevices between,
     varied stone colours. gravelNormal is its matching normal map.            */
  function gravelFields(W, seed) {
    var N = Math.max(8, Math.round(W / 14)), cs = W / N, R = rng(seed + 1);
    var jx = new Float32Array(N * N), jy = new Float32Array(N * N), cid = new Uint8Array(N * N), cs2 = new Float32Array(N * N);
    for (var k = 0; k < N * N; k++) { jx[k] = 0.15 + R() * 0.7; jy[k] = 0.15 + R() * 0.7; cid[k] = (R() * 8) | 0; cs2[k] = 0.8 + R() * 0.45; }
    var col = new Float32Array(W * W * 3), hgt = new Float32Array(W * W), wn = whiteNoise(W * W, seed + 2);
    var pal = [[150, 145, 138], [176, 170, 160], [120, 116, 110], [192, 182, 166], [142, 128, 112], [208, 203, 195], [108, 100, 92], [166, 150, 128]];
    var L = [-0.45, -0.55, 0.7];
    for (var y = 0; y < W; y++) for (var x = 0; x < W; x++) {
      var gx = Math.floor(x / cs), gy = Math.floor(y / cs), d1 = 1e9, d2 = 1e9, bx = 0, by = 0, bid = 0;
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        var ncx = gx + ox, ncy = gy + oy, ki = mod(ncy, N) * N + mod(ncx, N);
        var fx = (ncx + jx[ki]) * cs, fy = (ncy + jy[ki]) * cs, dx = x - fx, dy = y - fy, dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < d1) { d2 = d1; d1 = dd; bx = dx; by = dy; bid = ki; } else if (dd < d2) d2 = dd;
      }
      var rs = cs * 0.62 * cs2[bid], nd = d1 / rs, i = y * W + x, edge = d2 - d1;
      var crev = 0.22 + 0.78 * smooth(0, 3.2 * W / 512, edge);
      var c = pal[cid[bid]], s, hh;
      if (nd < 1) {
        var nz = Math.sqrt(1 - nd * nd), nx = bx / rs, ny = by / rs;
        var lit = clamp01(nx * L[0] + ny * L[1] + nz * L[2]);
        s = (0.32 + 0.8 * lit) * crev; hh = nz * crev;
      } else { s = 0.3 * crev; hh = 0; c = [92, 82, 70]; }
      s *= 1 + (wn[i] - 0.5) * 0.14;
      col[i * 3] = c[0] * s; col[i * 3 + 1] = c[1] * s; col[i * 3 + 2] = c[2] * s;
      hgt[i] = hh * 0.85 + wn[i] * 0.05;
    }
    return { col: col, hgt: hgt };
  }
  GEN.gravel = function (o) {
    var W = o.size || S(512), f = gravelFields(W, o.seed == null ? 9 : o.seed), P = makePixels(W, W);
    for (var i = 0; i < W * W; i++) setPx(P.data, i * 4, f.col[i * 3], f.col[i * 3 + 1], f.col[i * 3 + 2]);
    return { source: P, wrapS: 'repeat', wrapT: 'repeat', aniso: 16 };
  };
  GEN.gravelNormal = function (o) {
    var W = o.size || S(512), f = gravelFields(W, o.seed == null ? 9 : o.seed);
    return { source: { width: W, height: W, data: heightToNormal(f.hgt, W, W, o.strength || 4) }, wrapS: 'repeat', wrapT: 'repeat', aniso: 16, linear: true };
  };

  /* -------------------------------------------------------------- kerb (pure)
     u ALONG the track: one colorA block + one colorB block per repeat (REPEAT).
     v ACROSS the kerb (0 = track-side edge, 1 = outer edge, CLAMP).
     Rumble ridges, rounded profile shading, block gaps, worn paint, rubber.   */
  GEN.kerb = function (o) {
    var W = o.size || S(512), H = W >> 2, seed = o.seed == null ? 13 : o.seed, P = makePixels(W, H), d = P.data;
    var A = parseColor(o.colorA || '#d01818'), B = parseColor(o.colorB || '#f2f2f0'), conc = [150, 148, 142];
    var wear = noiseField(128, 32, 8, 2, 4, seed + 1), rub = noiseField(256, 16, 2, 4, 3, seed + 2), wn = whiteNoise(W * H, seed + 3);
    var ridges = o.ridges == null ? 16 : o.ridges;
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / H;
      var c = u < 0.5 ? A : B;
      var prof = 0.72 + 0.28 * Math.pow(Math.sin(PI * clamp(v * 1.04 - 0.02, 0, 1)), 0.5);
      var rid = 0.9 + 0.1 * Math.cos(TAU * u * ridges + 0.6);
      var gapPx = Math.min(x, Math.abs(x - W / 2), W - x);
      var gap = gapPx < 1.5 * W / 512 ? 0.42 : gapPx < 3 * W / 512 ? 0.85 : 1;
      var we = smooth(0.66, 0.8, sampleField(wear, u, v) + (1 - v) * 0.05);
      var col = mixC(c, conc, we * 0.7);
      var rb = smooth(0.55, 0.85, sampleField(rub, u, v)) * (1 - v) * 0.6;
      col = mixC(col, [26, 26, 28], rb);
      var s = prof * rid * gap * (1 + (wn[y * W + x] - 0.5) * 0.12);
      setPx(d, i, col[0] * s, col[1] * s, col[2] * s);
    }
    return { source: P, wrapS: 'repeat', wrapT: 'clamp', aniso: 16 };
  };

  /* ---------------------------------------------------------- concrete (pure)
     Wall / pit concrete: u along the wall (one formwork panel per repeat, joint
     at u = 0), v = 0 top .. 1 bottom (bottom has grime + tyre scuffs).         */
  GEN.concrete = function (o) {
    var W = o.size || S(512), seed = o.seed == null ? 17 : o.seed, P = makePixels(W, W), d = P.data;
    var low = noiseField(64, 64, 4, 4, 4, seed + 1), mid = noiseField(128, 128, 16, 16, 2, seed + 2);
    var drip = noiseField(256, 4, 32, 1, 2, seed + 3), scuff = noiseField(128, 64, 2, 6, 3, seed + 4), wn = whiteNoise(W * W, seed + 5);
    var base = parseColor(o.color || [172, 170, 164]), joint = 3 * W / 512;
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / W, h = wn[y * W + x];
      var s = 1 + (sampleField(low, u, v) - 0.5) * 0.18 + (sampleField(mid, u, v) - 0.5) * 0.08 + (h - 0.5) * 0.1;
      if (h < 0.008) s *= 0.55; else if (h > 0.992) s *= 1.12;
      var dr = Math.max(0, sampleField(drip, u, 0) - 0.55) * 2.4;
      s *= 1 - dr * (0.3 * (1 - v) + 0.06);
      var c = base.slice();
      var grime = smooth(0.7, 1, v);
      c = mixC(c, [110, 98, 82], grime * 0.45);
      var sc = smooth(0.62, 0.8, sampleField(scuff, u, v)) * smooth(0.55, 0.7, v) * (1 - smooth(0.9, 0.97, v));
      c = mixC(c, [30, 30, 32], sc * 0.75);
      if (x < joint) s *= 0.55; else if (x < joint * 1.6) s *= 1.08;
      if (Math.abs(y - W / 2) < 1) s *= 0.9;
      // form-tie holes
      for (var tx = 0; tx < 2; tx++) for (var ty = 0; ty < 2; ty++) {
        var hx = (0.25 + tx * 0.5) * W, hy = (0.2 + ty * 0.6) * W, dd = Math.sqrt((x - hx) * (x - hx) + (y - hy) * (y - hy)) / (W / 128);
        if (dd < 1) s *= 0.45; else if (dd < 1.6) s *= 0.9;
      }
      setPx(d, i, c[0] * s, c[1] * s, c[2] * s);
    }
    return { source: P, wrapS: 'repeat', wrapT: 'repeat', aniso: 8 };
  };

  /* ------------------------------------------------------------- armco (pure)
     Galvanised W-beam guardrail: u along the rail (one beam section per repeat,
     splice at u = 0, post bolt at u = 0.5), v = 0 top edge .. 1 bottom edge.   */
  GEN.barrierArmco = function (o) {
    var W = o.size || S(512), H = W >> 2, seed = o.seed == null ? 19 : o.seed, P = makePixels(W, H), d = P.data;
    var rust = noiseField(128, 32, 8, 2, 4, seed + 1), scuff = noiseField(256, 16, 3, 2, 3, seed + 2), wn = whiteNoise(W * H, seed + 3);
    var bolts = [[0.5, 0.5], [0.035, 0.28], [0.035, 0.72], [0.965, 0.28], [0.965, 0.72]];
    var br = 5 * W / 512, sp = 7 * W / 512;
    var R = rng(seed + 4), paints = [];
    for (var p = 0; p < 2; p++) paints.push({ u: R(), w: 0.08 + R() * 0.15, v: 0.3 + R() * 0.4, c: hsl(R() * 360, 0.7, 0.45) });
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / H;
      var sh = 0.74 + 0.22 * Math.cos(TAU * 2 * v - PI * 0.4);
      var spec = Math.pow(Math.max(0, Math.cos(TAU * 2 * (v - 0.18))), 30) * 0.35;
      if (v < 0.04 || v > 0.96) sh *= 0.6;
      var cell = hash2(Math.floor(x / (6 * W / 512)), Math.floor(y / (6 * W / 512)), seed);
      var s = sh * (1 + (cell - 0.5) * 0.1 + (wn[y * W + x] - 0.5) * 0.06);
      var c = [176, 181, 186];
      if (x < 2 * W / 512) s *= 0.5; else if (x > W - 1.5 * W / 512) s *= 1.15;
      var bp = 0;
      for (var b = 0; b < bolts.length; b++) {
        var dx = x - bolts[b][0] * W, dy = y - bolts[b][1] * H, dd = Math.sqrt(dx * dx + dy * dy);
        bp = Math.max(bp, 1 - smooth(0, sp * 3, dd));
        if (dd < br) { var nz = Math.sqrt(1 - (dd / br) * (dd / br)); s = 0.5 + 0.6 * clamp01(-dx / br * 0.5 - dy / br * 0.5 + nz * 0.7); spec = 0; c = [150, 152, 150]; }
        else if (dd < sp) s *= 0.7;
      }
      var ra = smooth(0.66, 0.82, sampleField(rust, u, v) + bp * 0.28 + smooth(0.8, 1, v) * 0.18);
      c = mixC(c, [118 + (wn[y * W + x] - 0.5) * 30, 60, 28], ra * 0.85);
      if (ra > 0.2) spec *= 1 - ra;
      var sc = smooth(0.6, 0.85, sampleField(scuff, u, v)) * smooth(0.25, 0.4, v) * (1 - smooth(0.6, 0.75, v));
      c = mixC(c, [24, 24, 26], sc * 0.7);
      for (var q = 0; q < paints.length; q++) {
        var pu = Math.abs(mod(u - paints[q].u + 0.5, 1) - 0.5);
        if (pu < paints[q].w && Math.abs(v - paints[q].v) < 0.03 + 0.02 * Math.sin(u * 80)) c = mixC(c, paints[q].c, 0.6 * (1 - pu / paints[q].w));
      }
      c = mixC(c, [90, 80, 66], smooth(0.85, 1, v) * 0.35);
      setPx(d, i, c[0] * s + spec * 255, c[1] * s + spec * 255, c[2] * s + spec * 255);
    }
    return { source: P, wrapS: 'repeat', wrapT: 'clamp', aniso: 8 };
  };

  /* --------------------------------------------------------- tyre wall (pure)
     Stacked tyre barrier seen from the track: 4 stacks across u (REPEAT), 4 tyres
     high across v (v = 0 top .. 1 ground, CLAMP). opts.paint (default true)
     paints alternate tyres in opts.colors ([red, white]).                     */
  GEN.tyreWall = function (o) {
    var W = o.size || S(512), H = W >> 1, seed = o.seed == null ? 23 : o.seed, P = makePixels(W, H), d = P.data;
    var cols = 4, rows = 4, cw = W / cols, th = H / rows, paint = o.paint !== false;
    var pc = (o.colors || ['#d42020', '#efefef']).map(function (c) { return parseColor(c); });
    var wear = noiseField(64, 32, 6, 3, 3, seed + 1), wn = whiteNoise(W * H, seed + 2);
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var col = Math.floor(x / cw), row = Math.floor(y / th), lx = (x - col * cw) / cw, ly = (y - row * th) / th;
      var cyl = Math.sqrt(Math.max(0, 1 - (2 * lx - 1) * (2 * lx - 1)));
      var tread = Math.pow(Math.sin(PI * ly), 0.55);
      var groove = (ly > 0.22 && ly < 0.78 && fract((lx * cw * 0.9 + (ly - 0.5) * th * (row % 2 ? 0.6 : -0.6)) / (9 * W / 512)) < 0.2) ? 0.7 : 1;
      var shoulder = (Math.abs(ly - 0.2) < 0.03 || Math.abs(ly - 0.8) < 0.03) ? 0.8 : 1;
      var s = (0.18 + 0.82 * cyl) * (0.3 + 0.7 * tread) * groove * shoulder;
      var c = [32, 32, 34];
      if (paint && (col + row) % 2 === 0) {
        var pcol = pc[(row >> 0) % pc.length];
        var w = smooth(0.62, 0.78, sampleField(wear, x / W, y / H));
        c = mixC(pcol, c, w * 0.8);
      }
      var spec = Math.pow(cyl, 10) * tread * 0.18 * groove;
      s *= 1 + (wn[y * W + x] - 0.5) * 0.1;
      setPx(d, i, c[0] * s + spec * 200, c[1] * s + spec * 200, c[2] * s + spec * 200);
    }
    return { source: P, wrapS: 'repeat', wrapT: 'clamp', aniso: 8 };
  };

  /* ------------------------------------------------------------------- crowd
     Grandstand spectators: 8 tiers per tile (v), REPEAT in u. Colourful shirts,
     skin tones, hair/caps, raised arms, flags, umbrellas, empty seats.
     opts.frame (0|1) moves arms/flags for a cheap 2-frame cheer animation.    */
  GEN.crowd = function (o) {
    var W = o.size || S(1024), H = W >> 1, c = makeCanvas(W, H), g = ctx2d(c), seed = o.seed == null ? 29 : o.seed;
    var frame = (o.frame | 0) & 1, rows = 8, rh = H / rows, sc = W / 1024;
    var R = rng(seed);
    var seatCols = [[30, 70, 160], [190, 30, 40], [230, 190, 30], [40, 130, 70]];
    var shirts = [[220, 30, 40], [250, 210, 30], [255, 120, 20], [30, 90, 220], [245, 245, 245], [30, 160, 80], [240, 90, 170], [20, 20, 24], [120, 60, 180], [0, 180, 200], [200, 200, 205], [140, 30, 30]];
    var skins = [[255, 220, 190], [240, 195, 160], [210, 160, 120], [175, 120, 85], [130, 85, 55], [95, 60, 40]];
    var hairs = [[25, 20, 18], [70, 45, 30], [130, 90, 50], [210, 180, 110], [150, 150, 150], [160, 70, 30]];
    // tiers
    for (var r = 0; r < rows; r++) {
      var y0 = r * rh, sec = seatCols[r % 2 === 0 ? 0 : 1];
      g.fillStyle = css([58, 58, 62]); g.fillRect(0, y0, W, rh);
      g.fillStyle = css([40, 40, 44]); g.fillRect(0, y0 + rh * 0.82, W, rh * 0.18);
      g.fillStyle = css([82, 82, 86]); g.fillRect(0, y0 + rh * 0.8, W, 2 * sc);
      // seat backs in sections
      for (var sx = 0; sx < W; sx += 16 * sc) {
        var section = Math.floor(sx / (W / 4));
        var scol = seatCols[(section + r) % seatCols.length];
        g.fillStyle = css(scaleC(scol, 0.85)); roundRect(g, sx + 2 * sc, y0 + rh * 0.48, 12 * sc, rh * 0.34, 3 * sc); g.fill();
      }
      void sec;
    }
    // spectators back row first (top), front rows overlap
    for (r = 0; r < rows; r++) {
      var base = r * rh + rh * 0.8, x = R() * 8 * sc;
      while (x < W) {
        var step = (17 + R() * 7) * sc;
        if (R() < 0.88) person(g, x, base, sc, R, frame, shirts, skins, hairs, W);
        x += step;
      }
    }
    // occasional banners on tier fronts
    var banners = ['GO REDLINE!', '#7', 'ALLEZ!', 'VAMOS', 'P1', 'FULL SEND'];
    for (var b = 0; b < 3; b++) {
      var bx = (0.1 + b * 0.33 + R() * 0.1) * W, by = ((R() * rows) | 0) * rh + rh * 0.78, bw = (90 + R() * 50) * sc;
      g.fillStyle = css(shirts[(R() * shirts.length) | 0]); g.fillRect(bx, by, bw, 14 * sc);
      g.fillStyle = '#fff'; g.font = '900 ' + Math.round(11 * sc) + 'px ' + FONT_HEAVY; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(banners[(R() * banners.length) | 0], bx + bw / 2, by + 7.5 * sc);
    }
    return { source: c, wrapS: 'repeat', wrapT: 'repeat', aniso: 8 };
  };
  function person(g, x, base, sc, R, frame, shirts, skins, hairs, W) {
    var sh = shirts[(R() * shirts.length) | 0], sk = skins[(R() * skins.length) | 0], hr = hairs[(R() * hairs.length) | 0];
    var tw = (11 + R() * 5) * sc, tH = (17 + R() * 5) * sc, hrad = (4.2 + R() * 1.2) * sc;
    var stand = R() < 0.35, lift = stand ? 6 * sc : 0;
    var armsUp = R() < 0.22, armsAlt = R() < 0.5;
    if (frame && armsAlt) armsUp = !armsUp;
    var topY = base - tH - lift;
    function at(fn) { fn(x); if (x < 30 * sc) fn(x + W); else if (x > W - 30 * sc) fn(x - W); }
    at(function (px) {
      // arms raised (behind head)
      if (armsUp) {
        g.strokeStyle = css(sh); g.lineWidth = 3.4 * sc; g.lineCap = 'round';
        var sway = frame ? 2 * sc : -2 * sc;
        g.beginPath(); g.moveTo(px - tw * 0.4, topY + 3 * sc); g.lineTo(px - tw * 0.7 + sway, topY - 9 * sc); g.stroke();
        g.beginPath(); g.moveTo(px + tw * 0.4, topY + 3 * sc); g.lineTo(px + tw * 0.7 + sway, topY - 9 * sc); g.stroke();
        g.fillStyle = css(sk);
        g.beginPath(); g.arc(px - tw * 0.7 + sway, topY - 10 * sc, 1.9 * sc, 0, TAU); g.fill();
        g.beginPath(); g.arc(px + tw * 0.7 + sway, topY - 10 * sc, 1.9 * sc, 0, TAU); g.fill();
      }
      // torso
      g.fillStyle = css(sh); roundRect(g, px - tw / 2, topY, tw, tH + lift, 4 * sc); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(px - tw / 2, topY + (tH + lift) * 0.6, tw, (tH + lift) * 0.4);
      if (R() < 0.3) { g.fillStyle = 'rgba(255,255,255,0.65)'; g.fillRect(px - tw * 0.25, topY + 4 * sc, tw * 0.5, 2 * sc); }
      // neck + head
      var hy = topY - hrad * 0.75;
      g.fillStyle = css(sk); g.beginPath(); g.arc(px, hy, hrad, 0, TAU); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.beginPath(); g.arc(px + hrad * 0.3, hy + hrad * 0.2, hrad * 0.8, 0, TAU); g.fill();
      var hat = R();
      if (hat < 0.28) { // cap
        g.fillStyle = css(shirts[(R() * shirts.length) | 0]);
        g.beginPath(); g.arc(px, hy - hrad * 0.15, hrad * 1.02, PI, TAU); g.fill();
        g.fillRect(px - hrad * 1.1, hy - hrad * 0.2, hrad * 2.2, hrad * 0.35);
      } else if (hat < 0.9) {
        g.fillStyle = css(hr); g.beginPath(); g.arc(px, hy - hrad * 0.1, hrad * 1.04, PI * 1.05, TAU - 0.05 * PI); g.fill();
      }
      // props
      var prop = R();
      if (prop < 0.035) { // flag on a stick
        var fx = px + tw * 0.5, fy = topY - 16 * sc, wave = frame ? 3 * sc : -1 * sc;
        g.strokeStyle = '#ddd'; g.lineWidth = 1.2 * sc; g.beginPath(); g.moveTo(fx, topY + 6 * sc); g.lineTo(fx, fy - 6 * sc); g.stroke();
        var fc = [shirts[(R() * 12) | 0], shirts[(R() * 12) | 0], shirts[(R() * 12) | 0]];
        for (var k = 0; k < 3; k++) {
          g.fillStyle = css(fc[k]);
          g.beginPath(); g.moveTo(fx, fy - 6 * sc + k * 4 * sc); g.lineTo(fx + 20 * sc, fy - 6 * sc + k * 4 * sc + wave);
          g.lineTo(fx + 20 * sc, fy - 2 * sc + k * 4 * sc + wave); g.lineTo(fx, fy - 2 * sc + k * 4 * sc); g.closePath(); g.fill();
        }
      } else if (prop < 0.05) { // umbrella
        g.fillStyle = css(shirts[(R() * 12) | 0]);
        g.beginPath(); g.arc(px, topY - 8 * sc, 15 * sc, PI, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.moveTo(px, topY - 23 * sc); g.lineTo(px - 5 * sc, topY - 8 * sc); g.lineTo(px + 5 * sc, topY - 8 * sc); g.fill();
      } else if (prop < 0.08) { // phone / camera glint
        g.fillStyle = '#111'; g.fillRect(px - 3 * sc, topY - 2 * sc, 6 * sc, 4 * sc);
        g.fillStyle = 'rgba(200,230,255,0.9)'; g.fillRect(px - 2 * sc, topY - 1 * sc, 4 * sc, 2 * sc);
      }
    });
  }
  NEEDS_CANVAS.crowd = true;

  /* -------------------------------------------------------------- tree atlas
     1024x1024 atlas, 4 cols x 2 rows of 256x512 cells. Alpha-tested foliage
     (threshold 0.5), coverage-preserving mips, colour dilated into gaps.
     tex.atlas = {cols, rows, entries: [{name, index, u0, v0, u1, v1, crop:{...}, heightM, widthM}]}
     Trunk base sits at the cell's bottom-centre (v1).                         */
  var TREE_SPECIES = [
    { name: 'spruce', heightM: 16, widthM: 7 },
    { name: 'pine', heightM: 18, widthM: 9 },
    { name: 'oak', heightM: 13, widthM: 12 },
    { name: 'birch', heightM: 14, widthM: 7 },
    { name: 'poplar', heightM: 20, widthM: 5 },
    { name: 'palm', heightM: 12, widthM: 8 },
    { name: 'maple-autumn', heightM: 12, widthM: 10 },
    { name: 'shrub', heightM: 3, widthM: 4.5 }
  ];
  var TREE_CROP = { spruce: 0.02, pine: 0.05, oak: 0.08, birch: 0.06, poplar: 0.02, palm: 0.12, 'maple-autumn': 0.1, shrub: 0.5 };
  function treeAtlasInfo(size) {
    var entries = TREE_SPECIES.map(function (sp, k) {
      var cx = k % 4, cy = (k / 4) | 0, u0 = cx / 4, v0 = cy / 2, u1 = u0 + 0.25, v1 = v0 + 0.5, top = TREE_CROP[sp.name] || 0;
      return { name: sp.name, index: k, u0: u0, v0: v0, u1: u1, v1: v1, crop: { u0: u0, v0: v0 + top * 0.5, u1: u1, v1: v1 }, heightM: sp.heightM, widthM: sp.widthM, aspect: 0.5 };
    });
    return { cols: 4, rows: 2, size: size, entries: entries, byName: entries.reduce(function (m, e) { m[e.name] = e; return m; }, {}) };
  }
  /** batched shaded leaf cloud inside an ellipse */
  function leafCloud(g, R, cx, cy, rx, ry, count, dark, light, leafSize, elong) {
    var NB = 8, buckets = [], b;
    for (b = 0; b < NB; b++) buckets.push([]);
    for (var n = 0; n < count; n++) {
      var a = R() * TAU, rr = Math.sqrt(R());
      var px = cx + Math.cos(a) * rr * rx, py = cy + Math.sin(a) * rr * ry;
      var nx = (px - cx) / rx, ny = (py - cy) / ry;
      var sh = 0.45 + 0.35 * (-nx * 0.55 - ny * 0.8) + rr * 0.15 + (R() - 0.5) * 0.35;
      buckets[clamp((sh * NB) | 0, 0, NB - 1)].push(px, py, R() * PI, leafSize * (0.6 + R() * 0.8));
    }
    for (b = 0; b < NB; b++) {
      var t = b / (NB - 1), arr = buckets[b];
      if (!arr.length) continue;
      g.fillStyle = css(mixC(dark, light, t));
      g.beginPath();
      for (var k = 0; k < arr.length; k += 4) {
        g.moveTo(arr[k] + arr[k + 3], arr[k + 1]);
        g.ellipse(arr[k], arr[k + 1], arr[k + 3], arr[k + 3] * (elong || 0.6), arr[k + 2], 0, TAU);
      }
      g.fill();
    }
  }
  function trunk(g, cx, yb, yt, wb, wt, col, R, lean) {
    lean = lean || 0;
    g.fillStyle = css(col);
    g.beginPath();
    g.moveTo(cx - wb / 2, yb);
    g.quadraticCurveTo(cx - wt / 2 + lean * 0.5, (yb + yt) / 2, cx - wt / 2 + lean, yt);
    g.lineTo(cx + wt / 2 + lean, yt);
    g.quadraticCurveTo(cx + wt / 2 + lean * 0.5, (yb + yt) / 2, cx + wb / 2, yb);
    g.closePath(); g.fill();
    // bark shading: right side darker, vertical streaks
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath(); g.moveTo(cx + wb * 0.1, yb); g.lineTo(cx + wt * 0.1 + lean, yt); g.lineTo(cx + wt / 2 + lean, yt); g.lineTo(cx + wb / 2, yb); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
    for (var k = 0; k < 6; k++) {
      var f = R() - 0.5, y1 = lerp(yb, yt, R() * 0.6), y2 = y1 - (yb - yt) * (0.1 + R() * 0.2);
      g.beginPath(); g.moveTo(cx + f * wb * 0.8, y1); g.lineTo(cx + f * wt * 0.8 + lean * (yb - y2) / (yb - yt), y2); g.stroke();
    }
  }
  function branch(g, x0, y0, x1, y1, w, col) {
    g.strokeStyle = css(col); g.lineWidth = w; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 - 6, x1, y1); g.stroke();
  }
  var TREE_DRAW = {
    spruce: function (g, R, W, H) {
      var cx = W / 2, top = H * 0.03, bot = H * 0.93, tiers = 15;
      trunk(g, cx, H, H * 0.4, W * 0.07, W * 0.03, [80, 55, 38], R);
      for (var t = 0; t < tiers; t++) {
        var f = t / (tiers - 1), y = lerp(top + H * 0.06, bot - H * 0.04, Math.pow(f, 0.95));
        var hw = W * 0.46 * (0.1 + 0.9 * Math.pow(f, 0.85)), th = H * 0.075;
        // silhouette tier: drooping skirt with jagged edge
        g.fillStyle = css([18, 46, 30]);
        g.beginPath(); g.moveTo(cx, y - th);
        var segs = 10;
        for (var s = 0; s <= segs; s++) {
          var a = s / segs, px = cx - hw + a * 2 * hw, droop = Math.pow(Math.abs(a - 0.5) * 2, 1.4) * th * 0.6;
          g.lineTo(px + (R() - 0.5) * 6, y + droop * 0.4 + (R() - 0.3) * 8 * (s % 2 ? 1 : 0.3));
        }
        g.closePath(); g.fill();
        // needle strokes along drooping branches
        var NB = 5;
        for (var b = 0; b < NB; b++) {
          var tt = b / (NB - 1);
          g.strokeStyle = css(mixC([16, 44, 28], [70, 120, 70], tt)); g.lineWidth = 1.3;
          g.beginPath();
          var nN = Math.round(hw * 1.4);
          for (var n = 0; n < nN; n++) {
            var side = R() < 0.5 ? -1 : 1, d = R(), bx = cx + side * d * hw, by = y - th * (1 - d) * 0.9 + d * d * th * 0.35 + (R() - 0.5) * th * 0.5;
            var lit = side < 0 ? 0.6 : 0.25;
            if (Math.abs(R() - (lit + (1 - d) * 0.2)) > 0.32 + tt * 0.0) continue;
            var la = side < 0 ? PI + 0.5 + (R() - 0.5) : -0.5 + (R() - 0.5);
            g.moveTo(bx, by); g.lineTo(bx + Math.cos(la) * 5, by + Math.sin(la) * 5 + 2);
          }
          g.stroke();
        }
      }
    },
    pine: function (g, R, W, H) {
      var cx = W / 2;
      trunk(g, cx, H, H * 0.12, W * 0.085, W * 0.035, [120, 70, 45], R, 6);
      // orange upper bark
      g.fillStyle = 'rgba(200,110,60,0.35)'; g.fillRect(cx - W * 0.02, H * 0.15, W * 0.04, H * 0.4);
      branch(g, cx, H * 0.35, cx - W * 0.3, H * 0.22, 4, [90, 55, 35]);
      branch(g, cx + 3, H * 0.28, cx + W * 0.32, H * 0.16, 4, [90, 55, 35]);
      var clumps = [[0, 0.1, 0.32, 0.075], [-0.28, 0.2, 0.2, 0.06], [0.3, 0.15, 0.2, 0.06], [-0.1, 0.25, 0.25, 0.06], [0.15, 0.04, 0.2, 0.05], [0.12, 0.28, 0.22, 0.055]];
      clumps.forEach(function (c) {
        var x = cx + c[0] * W + 3, y = H * c[1] + H * 0.05, rx = c[2] * W, ry = c[3] * H;
        g.fillStyle = css([20, 48, 34]); g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill();
        leafCloud(g, R, x, y - ry * 0.1, rx * 0.95, ry * 0.9, Math.round(rx * ry * 0.35), [16, 40, 30], [95, 140, 85], 3.2, 0.35);
      });
    },
    oak: function (g, R, W, H) {
      var cx = W / 2;
      trunk(g, cx, H, H * 0.45, W * 0.14, W * 0.07, [85, 62, 44], R);
      branch(g, cx, H * 0.55, cx - W * 0.25, H * 0.35, 7, [80, 58, 40]);
      branch(g, cx, H * 0.5, cx + W * 0.27, H * 0.32, 6, [80, 58, 40]);
      branch(g, cx, H * 0.5, cx + W * 0.04, H * 0.2, 6, [80, 58, 40]);
      var lumps = [];
      for (var k = 0; k < 22; k++) {
        var a = R() * TAU, rr = Math.sqrt(R());
        lumps.push([cx + Math.cos(a) * rr * W * 0.3, H * 0.32 + Math.sin(a) * rr * H * 0.17, W * (0.1 + R() * 0.08)]);
      }
      lumps.sort(function (a, b) { return a[1] - b[1]; });
      g.fillStyle = css([24, 50, 22]);
      lumps.forEach(function (l) { g.beginPath(); g.arc(l[0], l[1], l[2], 0, TAU); g.fill(); });
      lumps.forEach(function (l) { leafCloud(g, R, l[0], l[1], l[2], l[2], Math.round(l[2] * l[2] * 0.55), [20, 46, 20], [120, 160, 70], 3.6); });
    },
    birch: function (g, R, W, H) {
      var cx = W / 2;
      trunk(g, cx, H, H * 0.12, W * 0.06, W * 0.025, [228, 226, 218], R, -4);
      g.fillStyle = 'rgba(20,20,20,0.85)';
      for (var k = 0; k < 18; k++) { var y = H * (0.2 + R() * 0.78); g.fillRect(cx - W * 0.03 + R() * W * 0.03, y, W * (0.01 + R() * 0.025), 2 + R() * 3); }
      branch(g, cx, H * 0.45, cx - W * 0.2, H * 0.3, 2.5, [200, 196, 188]);
      branch(g, cx, H * 0.4, cx + W * 0.2, H * 0.25, 2.5, [200, 196, 188]);
      for (k = 0; k < 14; k++) {
        var a = R() * TAU, rr = Math.sqrt(R()), x = cx + Math.cos(a) * rr * W * 0.25, yy = H * 0.3 + Math.sin(a) * rr * H * 0.2;
        leafCloud(g, R, x, yy, W * 0.12, W * 0.12, 260, [50, 85, 30], [175, 205, 90], 2.8);
      }
    },
    poplar: function (g, R, W, H) {
      var cx = W / 2;
      trunk(g, cx, H, H * 0.6, W * 0.07, W * 0.04, [95, 80, 60], R);
      g.fillStyle = css([28, 58, 26]); g.beginPath(); g.ellipse(cx, H * 0.47, W * 0.2, H * 0.44, 0, 0, TAU); g.fill();
      for (var k = 0; k < 12; k++) {
        var y = H * (0.08 + k / 11 * 0.78), w = W * 0.2 * Math.sin(PI * (0.08 + k / 11 * 0.84));
        leafCloud(g, R, cx + (R() - 0.5) * 8, y, w, H * 0.06, Math.round(w * 6), [22, 50, 22], [110, 150, 60], 3, 0.5);
      }
    },
    palm: function (g, R, W, H) {
      var cx = W / 2, tx = cx + W * 0.12, ty = H * 0.28;
      // curved segmented trunk
      for (var k = 0; k < 40; k++) {
        var t = k / 39, x = lerp(cx, tx, t * t), y = lerp(H, ty, t), w = lerp(W * 0.08, W * 0.045, t);
        g.fillStyle = css(k % 2 ? [140, 110, 75] : [120, 92, 62]);
        g.beginPath(); g.ellipse(x, y, w / 2, (H - ty) / 39 * 0.8, 0, 0, TAU); g.fill();
      }
      var fronds = 11;
      for (var f = 0; f < fronds; f++) {
        var ang = -PI / 2 + (f / (fronds - 1) - 0.5) * PI * 1.7 + (R() - 0.5) * 0.2, len = W * (0.38 + R() * 0.1);
        var ex = tx + Math.cos(ang) * len, ey = ty + Math.sin(ang) * len * 0.6 + len * 0.45, mx = tx + Math.cos(ang) * len * 0.5, my = ty + Math.sin(ang) * len * 0.5 - 10;
        g.strokeStyle = css([60, 90, 30]); g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
        for (var l = 2; l < 26; l++) {
          var t2 = l / 26, it = 1 - t2;
          var px = it * it * tx + 2 * it * t2 * mx + t2 * t2 * ex, py = it * it * ty + 2 * it * t2 * my + t2 * t2 * ey;
          var dx = 2 * it * (mx - tx) + 2 * t2 * (ex - mx), dy = 2 * it * (my - ty) + 2 * t2 * (ey - my), dl = Math.sqrt(dx * dx + dy * dy) || 1;
          var nx = -dy / dl, ny = dx / dl, ll = (1 - t2) * 26 + 6;
          var col = mixC([40, 80, 25], [140, 175, 60], clamp01(0.5 - ny * 0.5 + (R() - 0.5) * 0.3));
          g.strokeStyle = css(col); g.lineWidth = 2;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + nx * ll + dx / dl * 6, py + Math.abs(ny * ll) + 8); g.stroke();
          g.beginPath(); g.moveTo(px, py); g.lineTo(px - nx * ll + dx / dl * 6, py + Math.abs(ny * ll) + 8); g.stroke();
        }
      }
      g.fillStyle = css([90, 60, 30]);
      for (k = 0; k < 4; k++) { g.beginPath(); g.arc(tx + (R() - 0.5) * 14, ty + 6 + R() * 6, 5, 0, TAU); g.fill(); }
    },
    'maple-autumn': function (g, R, W, H) {
      var cx = W / 2;
      trunk(g, cx, H, H * 0.5, W * 0.1, W * 0.05, [70, 50, 40], R);
      branch(g, cx, H * 0.6, cx - W * 0.2, H * 0.4, 5, [65, 45, 35]);
      branch(g, cx, H * 0.58, cx + W * 0.22, H * 0.38, 5, [65, 45, 35]);
      for (var k = 0; k < 18; k++) {
        var a = R() * TAU, rr = Math.sqrt(R()), x = cx + Math.cos(a) * rr * W * 0.28, y = H * 0.36 + Math.sin(a) * rr * H * 0.16, r = W * (0.09 + R() * 0.07);
        var hue = R() < 0.5 ? [150, 40, 20] : [170, 80, 15];
        g.fillStyle = css(scaleC(hue, 0.6)); g.beginPath(); g.arc(x, y, r * 0.9, 0, TAU); g.fill();
        leafCloud(g, R, x, y, r, r, Math.round(r * r * 0.5), scaleC(hue, 0.6), R() < 0.5 ? [250, 170, 50] : [235, 90, 40], 3.6);
      }
    },
    shrub: function (g, R, W, H) {
      var lumps = [];
      for (var k = 0; k < 9; k++) lumps.push([W * (0.2 + R() * 0.6), H * (0.82 + R() * 0.08), W * (0.12 + R() * 0.1)]);
      lumps.sort(function (a, b) { return a[1] - b[1]; });
      g.fillStyle = css([26, 52, 24]);
      lumps.forEach(function (l) { g.beginPath(); g.arc(l[0], l[1], l[2], 0, TAU); g.fill(); });
      g.fillRect(W * 0.15, H * 0.9, W * 0.7, H * 0.1);
      lumps.forEach(function (l) { leafCloud(g, R, l[0], l[1], l[2], l[2], Math.round(l[2] * l[2] * 0.6), [22, 46, 22], [120, 165, 70], 3); });
      for (k = 0; k < 18; k++) { g.fillStyle = R() < 0.5 ? '#f3e9f5' : '#f2c84a'; g.beginPath(); g.arc(W * (0.18 + R() * 0.64), H * (0.78 + R() * 0.18), 2, 0, TAU); g.fill(); }
    }
  };
  GEN.trees = function (o) {
    var A = o.size || S(1024, 256), c = makeCanvas(A, A), g = ctx2d(c), cw = A / 4, ch = A / 2, sc = A / 1024;
    g.clearRect(0, 0, A, A);
    TREE_SPECIES.forEach(function (sp, k) {
      var R = rng('tree:' + sp.name + ':' + (o.seed || 0));
      g.save();
      g.translate((k % 4) * cw, ((k / 4) | 0) * ch);
      g.beginPath(); g.rect(1, 1, cw - 2, ch - 1); g.clip();
      g.scale(sc, sc);
      TREE_DRAW[sp.name](g, R, 256, 512);
      g.restore();
    });
    var px = readPixels(g, A, A);
    dilateRGB(px.data, A, A, 8);
    var levels = buildMips(px.data, A, A, 0.5);
    return { source: { width: A, height: A, data: px.data, levels: levels }, wrapS: 'clamp', wrapT: 'clamp', aniso: 4, atlas: treeAtlasInfo(A) };
  };
  NEEDS_CANVAS.trees = true;

  /* -------------------------------------------------------- building facade
     512x1024, REPEAT both ways: 4 window columns (u) x 4 floors (v) per tile
     (tex.floors / tex.columns; ~3.5 m per floor). Style chosen by seed:
     glass curtain wall, brick, concrete ribbon windows, stucco + balconies.
     night = true: dark walls + randomly lit warm/cool windows (draw with the
     unlit program or a strong emissive, the texture already is night-toned). */
  var FACADE_STYLES = ['glass', 'brick', 'ribbon', 'stucco'];
  GEN.buildingFacade = function (o) {
    var W = o.size || S(512), H = W * 2, c = makeCanvas(W, H), g = ctx2d(c);
    var seed = o.seed | 0, night = !!o.night, R = rng('facade:' + seed), style = FACADE_STYLES[mod(seed, 4)];
    var cols = 4, floors = 4, cw = W / cols, fh = H / floors, sc = W / 512;
    var wallPal = {
      glass: [[60, 70, 80], [70, 72, 78], [50, 60, 70]],
      brick: [[150, 72, 52], [125, 60, 45], [170, 100, 70]],
      ribbon: [[188, 186, 180], [160, 158, 152], [205, 200, 190]],
      stucco: [[230, 205, 160], [220, 170, 140], [200, 210, 200], [235, 225, 205]]
    };
    var wall = wallPal[style][(R() * wallPal[style].length) | 0];
    // ---- wall
    if (style === 'brick') {
      var bw = 32 * sc, bh = 12 * sc;
      pixelPass(g, W, H, function (x, y, i, d) {
        var row = Math.floor(y / bh), off = (row % 2) * bw / 2, bx = Math.floor((x + off) / bw);
        var mx = (x + off) % bw, my = y % bh;
        if (mx < 2 * sc || my < 2 * sc) { setPx(d, i, 175, 168, 155); return; }
        var hv = hash2(mod(bx, Math.round(W / bw)), row, seed) - 0.5, n = hash2(x, y, seed + 9) - 0.5;
        setPx(d, i, wall[0] * (1 + hv * 0.25 + n * 0.08), wall[1] * (1 + hv * 0.22 + n * 0.08), wall[2] * (1 + hv * 0.2 + n * 0.08));
      });
    } else {
      pixelPass(g, W, H, function (x, y, i, d) {
        var n = hash2(x, y, seed + 3) - 0.5, n2 = hash2(x >> 3, y >> 3, seed + 4) - 0.5;
        var s = 1 + n * 0.06 + n2 * 0.05;
        setPx(d, i, wall[0] * s, wall[1] * s, wall[2] * s);
      });
    }
    var winColsLit = [];
    for (var f = 0; f < floors; f++) for (var k = 0; k < cols; k++) {
      var r = R();
      winColsLit.push(r < 0.45 ? (R() < 0.75 ? 'warm' : R() < 0.6 ? 'cool' : 'tv') : 'off');
    }
    var litRects = [];
    function windowPane(x, y, w, h, lit) {
      var gr;
      if (night && lit !== 'off') litRects.push([x, y, x + w, y + h, lit]);
      if (!night) {
        gr = g.createLinearGradient(x, y, x + w * 0.4, y + h);
        var sky = style === 'glass' ? [[150, 185, 220], [70, 100, 140]] : [[120, 140, 165], [40, 50, 62]];
        gr.addColorStop(0, css(sky[0])); gr.addColorStop(0.55, css(mixC(sky[0], sky[1], 0.7))); gr.addColorStop(1, css(sky[1]));
        g.fillStyle = gr; g.fillRect(x, y, w, h);
        // diagonal reflection streak
        g.fillStyle = 'rgba(255,255,255,0.13)';
        g.beginPath(); g.moveTo(x + w * 0.15, y + h); g.lineTo(x + w * 0.45, y); g.lineTo(x + w * 0.6, y); g.lineTo(x + w * 0.3, y + h); g.fill();
        // curtains / interior hint
        if (R() < 0.4) { g.fillStyle = 'rgba(230,220,200,0.35)'; g.fillRect(x, y, w * (0.2 + R() * 0.25), h); }
      } else if (lit === 'off') {
        g.fillStyle = css([10, 12, 18]); g.fillRect(x, y, w, h);
        g.fillStyle = 'rgba(80,100,140,0.12)'; g.fillRect(x, y, w, h * 0.3);
      } else {
        var col = lit === 'warm' ? [255, 205, 130] : lit === 'cool' ? [205, 225, 255] : [120, 160, 255];
        gr = g.createLinearGradient(x, y, x, y + h);
        gr.addColorStop(0, css(col)); gr.addColorStop(1, css(scaleC(col, 0.55)));
        g.fillStyle = gr; g.fillRect(x, y, w, h);
        // interior silhouettes (furniture, plants, people)
        g.fillStyle = 'rgba(30,20,10,0.45)';
        if (R() < 0.6) g.fillRect(x + w * R() * 0.6, y + h * 0.62, w * 0.3, h * 0.38);
        if (R() < 0.3) { g.beginPath(); g.arc(x + w * (0.2 + R() * 0.6), y + h * 0.5, w * 0.06, 0, TAU); g.fill(); g.fillRect(x + w * 0.4, y + h * 0.56, w * 0.12, h * 0.44); }
        if (R() < 0.5) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x, y, w, Math.max(1, h * 0.04)); }
      }
    }
    for (f = 0; f < floors; f++) {
      var fy = f * fh;
      if (style === 'glass') {
        for (k = 0; k < cols; k++) {
          windowPane(k * cw + 3 * sc, fy + 3 * sc, cw - 6 * sc, fh * 0.78, winColsLit[f * cols + k]);
          g.fillStyle = css([45, 50, 56]);
          g.fillRect(k * cw + 3 * sc, fy + fh * 0.78 + 3 * sc, cw - 6 * sc, fh * 0.22 - 6 * sc); // spandrel
        }
        g.fillStyle = css(night ? [110, 116, 124] : [150, 158, 166]);
        for (k = 0; k <= cols; k++) g.fillRect(k * cw - 3 * sc, fy, 6 * sc, fh);
        g.fillRect(0, fy, W, 4 * sc); g.fillRect(0, fy + fh * 0.78 + 1 * sc, W, 3 * sc);
      } else if (style === 'ribbon') {
        for (k = 0; k < cols; k++) windowPane(k * cw, fy + fh * 0.35, cw, fh * 0.42, winColsLit[f * cols + k]);
        g.fillStyle = css(scaleC(wall, 0.7));
        for (k = 0; k < cols; k++) g.fillRect(k * cw - 2 * sc, fy + fh * 0.35, 4 * sc, fh * 0.42);
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, fy + fh * 0.33, W, fh * 0.02);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, fy + fh * 0.78, W, fh * 0.015);
      } else {
        var ww = cw * 0.52, wh = fh * 0.5;
        for (k = 0; k < cols; k++) {
          var wx = k * cw + (cw - ww) / 2, wy = fy + fh * 0.22;
          // frame + lintel + sill
          g.fillStyle = style === 'brick' ? css([200, 196, 186]) : css(scaleC(wall, 0.82));
          g.fillRect(wx - 6 * sc, wy - 10 * sc, ww + 12 * sc, 8 * sc);
          g.fillRect(wx - 8 * sc, wy + wh, ww + 16 * sc, 7 * sc);
          g.fillStyle = css([235, 235, 230]); g.fillRect(wx - 3 * sc, wy - 3 * sc, ww + 6 * sc, wh + 6 * sc);
          windowPane(wx, wy, ww, wh, winColsLit[f * cols + k]);
          g.fillStyle = css([235, 235, 230]); g.fillRect(wx + ww / 2 - 1.5 * sc, wy, 3 * sc, wh); g.fillRect(wx, wy + wh * 0.4, ww, 3 * sc);
          if (style === 'stucco') {
            // shutters
            var shc = [[40, 90, 60], [50, 80, 130], [150, 60, 40]][mod(seed, 3)];
            if (!(winColsLit[f * cols + k] !== 'off' && night)) {
              g.fillStyle = css(shc);
              g.fillRect(wx - ww * 0.36, wy - 2 * sc, ww * 0.3, wh + 4 * sc); g.fillRect(wx + ww * 1.06, wy - 2 * sc, ww * 0.3, wh + 4 * sc);
              g.fillStyle = 'rgba(0,0,0,0.25)';
              for (var sl = 0; sl < 10; sl++) { g.fillRect(wx - ww * 0.36, wy + sl * wh / 10, ww * 0.3, 1.5 * sc); g.fillRect(wx + ww * 1.06, wy + sl * wh / 10, ww * 0.3, 1.5 * sc); }
            }
          } else if (R() < 0.2) { // AC unit
            g.fillStyle = css([190, 190, 185]); g.fillRect(wx + ww * 0.6, wy + wh + 7 * sc, ww * 0.35, 14 * sc);
            g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.arc(wx + ww * 0.78, wy + wh + 14 * sc, 5 * sc, 0, TAU); g.fill();
          }
        }
        if (style === 'stucco' && f % 2 === 0) { // balcony
          var by = fy + fh * 0.72 + 7 * sc;
          g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, by + 4 * sc, W, 6 * sc);
          g.fillStyle = css([210, 210, 205]); g.fillRect(0, by, W, 5 * sc);
          g.strokeStyle = css([40, 40, 42]); g.lineWidth = 2 * sc;
          g.beginPath(); g.moveTo(0, by - 34 * sc); g.lineTo(W, by - 34 * sc);
          for (var rx = 0; rx < W; rx += 9 * sc) { g.moveTo(rx, by - 34 * sc); g.lineTo(rx, by); }
          g.stroke();
          if (!night && R() < 0.7) { g.fillStyle = css([40, 120, 50]); g.beginPath(); g.arc(W * R(), by - 8 * sc, 9 * sc, 0, TAU); g.fill(); }
        }
        // floor band
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, fy + fh - 4 * sc, W, 4 * sc);
      }
    }
    // weathering streaks
    for (k = 0; k < 10; k++) {
      var sx = R() * W, gw = (2 + R() * 10) * sc;
      if (typeof g.createLinearGradient !== 'function') break;
      var sg = g.createLinearGradient(0, 0, 0, H);
      sg.addColorStop(0, 'rgba(0,0,0,0.10)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sg; g.fillRect(sx, 0, gw, H);
    }
    if (night) {
      // darken everything except the explicitly recorded lit panes (no colour heuristics:
      // a cream stucco wall is as "warm" as a lit window), then spill a soft glow on the wall.
      var img = g.getImageData(0, 0, W, H), d = img.data, nl = litRects.length;
      for (var py = 0, i = 0; py < H; py++) {
        for (var px = 0; px < W; px++, i += 4) {
          var inside = false;
          for (var q = 0; q < nl; q++) {
            var lr = litRects[q];
            if (px >= lr[0] && px < lr[2] && py >= lr[1] && py < lr[3]) { inside = true; break; }
          }
          if (!inside) { d[i] *= 0.16; d[i + 1] *= 0.18; d[i + 2] *= 0.25; }
        }
      }
      g.putImageData(img, 0, 0);
      if (typeof g.createRadialGradient === 'function') {
        g.save();
        g.globalCompositeOperation = 'lighter';
        litRects.forEach(function (lr) {
          var cxr = (lr[0] + lr[2]) / 2, cyr = (lr[1] + lr[3]) / 2, rr = Math.max(lr[2] - lr[0], lr[3] - lr[1]) * 0.9;
          var col = lr[4] === 'warm' ? '255,170,80' : lr[4] === 'cool' ? '150,180,255' : '90,120,255';
          var gg = g.createRadialGradient(cxr, cyr, rr * 0.35, cxr, cyr, rr);
          gg.addColorStop(0, 'rgba(' + col + ',0.16)'); gg.addColorStop(1, 'rgba(' + col + ',0)');
          g.fillStyle = gg; g.fillRect(cxr - rr, cyr - rr, rr * 2, rr * 2);
        });
        g.restore();
      }
    }
    var out = { source: c, wrapS: 'repeat', wrapT: 'repeat', aniso: 8 };
    // litRects in UV space [u0, v0, u1, v1] (v = 0 at top row) so callers can build an emissive mask
    out.meta = { floors: floors, columns: cols, style: style, night: night,
      litRects: litRects.map(function (lr) { return [lr[0] / W, lr[1] / H, lr[2] / W, lr[3] / H]; }) };
    return out;
  };
  NEEDS_CANVAS.buildingFacade = true;

  /* ------------------------------------------------------------- billboards
     1024x256 (4:1) trackside hoarding, CLAMP. text = sponsor name/id/index
     (FORGE + 8 fictional sponsors with drawn logos) or any custom text, drawn
     on brandColor. The full texture includes a metal frame.                   */
  function drawLogo(g, kind, x, y, s, sp) {
    var ac = sp.accent, fg = sp.fg;
    g.save(); g.translate(x, y);
    g.lineJoin = 'round'; g.lineCap = 'round';
    switch (kind) {
      case 'forge': { // the Redline mark: tachometer arc ending in the red zone, needle pinned into it
        g.lineWidth = s * 0.1;
        g.strokeStyle = fg; g.beginPath(); g.arc(0, s * 0.12, s * 0.36, PI, PI * 1.72); g.stroke();
        g.strokeStyle = ac; g.beginPath(); g.arc(0, s * 0.12, s * 0.36, PI * 1.8, PI * 2); g.stroke();
        g.strokeStyle = fg; g.lineWidth = s * 0.08;
        g.beginPath(); g.moveTo(0, s * 0.12); g.lineTo(s * 0.27, -s * 0.07); g.stroke();
        g.fillStyle = fg; g.beginPath(); g.arc(0, s * 0.12, s * 0.08, 0, PI * 2); g.fill();
        break;
      }
      case 'drop': {
        g.fillStyle = ac;
        g.beginPath(); g.moveTo(0, -s * 0.42); g.bezierCurveTo(s * 0.12, -s * 0.2, s * 0.32, -s * 0.02, s * 0.3, s * 0.15);
        g.arc(0, s * 0.15, s * 0.3, 0, PI); g.bezierCurveTo(-s * 0.32, -s * 0.02, -s * 0.12, -s * 0.2, 0, -s * 0.42); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.ellipse(-s * 0.1, s * 0.1, s * 0.05, s * 0.12, 0.3, 0, TAU); g.fill();
        break;
      }
      case 'watch': {
        g.strokeStyle = fg; g.lineWidth = s * 0.07; g.beginPath(); g.arc(0, s * 0.04, s * 0.34, 0, TAU); g.stroke();
        g.fillStyle = fg; g.fillRect(-s * 0.06, -s * 0.44, s * 0.12, s * 0.08);
        g.strokeStyle = ac; g.lineWidth = s * 0.05; g.beginPath(); g.moveTo(0, s * 0.04); g.lineTo(s * 0.17, -s * 0.15); g.stroke();
        g.strokeStyle = fg; g.lineWidth = s * 0.03;
        for (var t = 0; t < 12; t++) { var aa = t * PI / 6; g.beginPath(); g.moveTo(Math.cos(aa) * s * 0.26, s * 0.04 + Math.sin(aa) * s * 0.26); g.lineTo(Math.cos(aa) * s * 0.3, s * 0.04 + Math.sin(aa) * s * 0.3); g.stroke(); }
        break;
      }
      case 'tyre': {
        g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, s * 0.42, 0, TAU); g.fill();
        g.fillStyle = sp.bg[0]; g.beginPath(); g.arc(0, 0, s * 0.22, 0, TAU); g.fill();
        g.strokeStyle = sp.bg[0]; g.lineWidth = s * 0.03;
        for (var q = 0; q < 16; q++) { var qa = q * PI / 8; g.beginPath(); g.moveTo(Math.cos(qa) * s * 0.33, Math.sin(qa) * s * 0.33); g.lineTo(Math.cos(qa + 0.15) * s * 0.42, Math.sin(qa + 0.15) * s * 0.42); g.stroke(); }
        g.fillStyle = '#111'; g.beginPath(); g.moveTo(-s * 0.12, s * 0.1); g.lineTo(0, -s * 0.1); g.lineTo(s * 0.12, s * 0.1); g.lineTo(s * 0.06, s * 0.1); g.lineTo(0, 0); g.lineTo(-s * 0.06, s * 0.1); g.fill();
        break;
      }
      case 'bolt': {
        g.fillStyle = ac;
        g.beginPath(); g.moveTo(s * 0.08, -s * 0.45); g.lineTo(-s * 0.22, s * 0.06); g.lineTo(-s * 0.02, s * 0.06); g.lineTo(-s * 0.1, s * 0.45); g.lineTo(s * 0.24, -s * 0.08); g.lineTo(s * 0.03, -s * 0.08); g.closePath(); g.fill();
        g.strokeStyle = fg; g.lineWidth = s * 0.03; g.beginPath(); g.arc(0, 0, s * 0.44, -0.9, 2.2); g.stroke();
        break;
      }
      case 'wing': {
        g.strokeStyle = ac; g.lineWidth = s * 0.06;
        for (var w = 0; w < 3; w++) { g.beginPath(); g.arc(-s * 0.05, s * (0.22 - w * 0.13), s * (0.34 - w * 0.06), PI * 1.1, PI * 1.9); g.stroke(); }
        g.fillStyle = fg; g.beginPath(); g.arc(s * 0.22, -s * 0.14, s * 0.06, 0, TAU); g.fill();
        break;
      }
      case 'orbit': {
        var pg = typeof g.createRadialGradient === 'function' ? g.createRadialGradient(-s * 0.08, -s * 0.08, s * 0.02, 0, 0, s * 0.24) : ac;
        if (pg.addColorStop) { pg.addColorStop(0, '#ffffff'); pg.addColorStop(1, ac); }
        g.fillStyle = pg; g.beginPath(); g.arc(0, 0, s * 0.22, 0, TAU); g.fill();
        g.strokeStyle = fg; g.lineWidth = s * 0.04; g.beginPath(); g.ellipse(0, 0, s * 0.46, s * 0.14, -0.35, 0, TAU); g.stroke();
        g.fillStyle = fg; g.beginPath(); g.arc(s * 0.4, -s * 0.15, s * 0.05, 0, TAU); g.fill();
        break;
      }
      case 'globe': {
        g.strokeStyle = fg; g.lineWidth = s * 0.04;
        g.beginPath(); g.arc(0, 0, s * 0.38, 0, TAU); g.stroke();
        for (var m = 1; m < 3; m++) { g.beginPath(); g.ellipse(0, 0, s * 0.38 * m / 3, s * 0.38, 0, 0, TAU); g.stroke(); }
        g.beginPath(); g.moveTo(-s * 0.38, 0); g.lineTo(s * 0.38, 0); g.stroke();
        g.beginPath(); g.moveTo(-s * 0.33, -s * 0.19); g.lineTo(s * 0.33, -s * 0.19); g.moveTo(-s * 0.33, s * 0.19); g.lineTo(s * 0.33, s * 0.19); g.stroke();
        g.fillStyle = fg; g.beginPath(); g.moveTo(-s * 0.5, s * 0.12); g.lineTo(s * 0.5, -s * 0.3); g.lineTo(s * 0.1, s * 0.0); g.closePath(); g.fill();
        break;
      }
      case 'gear': {
        g.fillStyle = ac; g.beginPath();
        var teeth = 10;
        for (var tt = 0; tt < teeth * 2; tt++) { var ga = tt * PI / teeth, gr = tt % 2 ? s * 0.33 : s * 0.43; g.lineTo(Math.cos(ga - 0.12) * gr, Math.sin(ga - 0.12) * gr); g.lineTo(Math.cos(ga + 0.12) * gr, Math.sin(ga + 0.12) * gr); }
        g.closePath(); g.fill();
        g.fillStyle = sp.bg[1]; g.beginPath(); g.arc(0, 0, s * 0.16, 0, TAU); g.fill();
        break;
      }
      default: break;
    }
    g.restore();
  }
  GEN.billboard = function (o) {
    var W = o.size || S(1024, 256), H = W >> 2, c = makeCanvas(W, H), g = ctx2d(c), sc = W / 1024;
    var sp = findSponsor(o.text);
    var custom = !sp;
    if (custom) {
      var bc = parseColor(o.brandColor || '#c8102e'), dark = luma(bc) < 140;
      sp = { name: String(o.text).toUpperCase(), tagline: o.tagline || '', bg: [css(scaleC(bc, 0.7)), css(bc)], fg: dark ? '#ffffff' : '#111111', accent: dark ? '#ffffff' : '#111111', logo: null };
    } else if (o.brandColor) {
      sp = Object.assign({}, sp, { accent: css(parseColor(o.brandColor)) });
    }
    // frame
    g.fillStyle = '#2a2c30'; g.fillRect(0, 0, W, H);
    var fr = 10 * sc;
    g.fillStyle = '#4a4d52'; g.fillRect(0, 0, W, fr * 0.4);
    g.fillStyle = '#16171a'; g.fillRect(0, H - fr * 0.4, W, fr * 0.4);
    var x0 = fr, y0 = fr, pw = W - fr * 2, ph = H - fr * 2;
    var bg = g.createLinearGradient(x0, y0, x0 + pw, y0 + ph);
    bg.addColorStop(0, sp.bg[0]); bg.addColorStop(1, sp.bg[1]);
    g.fillStyle = bg; g.fillRect(x0, y0, pw, ph);
    // dynamic diagonal accent bars
    g.save(); g.beginPath(); g.rect(x0, y0, pw, ph); g.clip();
    g.fillStyle = css(parseColor(sp.accent), 0.18);
    g.beginPath(); g.moveTo(x0 + pw * 0.78, y0); g.lineTo(x0 + pw * 0.86, y0); g.lineTo(x0 + pw * 0.8, y0 + ph); g.lineTo(x0 + pw * 0.72, y0 + ph); g.fill();
    g.beginPath(); g.moveTo(x0 + pw * 0.88, y0); g.lineTo(x0 + pw * 0.9, y0); g.lineTo(x0 + pw * 0.84, y0 + ph); g.lineTo(x0 + pw * 0.82, y0 + ph); g.fill();
    var logoS = ph * 0.9, textX = x0 + (sp.logo ? logoS + 40 * sc : 40 * sc);
    if (sp.logo) drawLogo(g, sp.logo, x0 + 30 * sc + logoS / 2, y0 + ph / 2, logoS, sp);
    // name
    var name = sp.name, words = name.split(' '), main = words[0], rest = words.slice(1).join(' ');
    var maxW = x0 + pw * 0.95 - textX;
    g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.fillStyle = sp.fg;
    var hasTag = !!sp.tagline;
    var fs = fitFont(g, name, maxW, ph * (hasTag ? 0.56 : 0.7), '900', FONT_HEAVY);
    var baseY = y0 + ph * (hasTag ? 0.62 : 0.72);
    g.font = '900 ' + fs + 'px ' + FONT_HEAVY;
    if (sp.id === 'forge') {
      spacedText(g, 'REDLINE', textX, baseY, fs * 0.18);
    } else if (sp.id === 'veloce') {
      g.save(); g.translate(textX, baseY); g.transform(1, 0, -0.22, 1, 0, 0);
      g.fillText(main, 0, 0);
      var mw = g.measureText(main + ' ').width || 0;
      g.fillStyle = sp.accent; g.fillText(rest, mw, 0); g.restore();
    } else if (rest) {
      g.fillText(main, textX, baseY);
      var mw2 = g.measureText(main + ' ').width || 0;
      g.font = '300 ' + fs + 'px ' + FONT_SANS; g.fillStyle = sp.accent === sp.fg ? sp.fg : sp.accent;
      g.fillText(rest, textX + mw2, baseY);
    } else {
      g.fillText(main, textX, baseY);
    }
    if (hasTag) {
      g.fillStyle = sp.fg; g.globalAlpha = 0.85;
      g.font = '600 ' + fitFont(g, sp.tagline, maxW, ph * 0.15, '600', FONT_COND) + 'px ' + FONT_COND;
      spacedText(g, sp.tagline, textX + 4 * sc, y0 + ph * 0.86, 3 * sc);
      g.globalAlpha = 1;
      g.fillStyle = sp.accent; g.fillRect(textX + 4 * sc, y0 + ph * 0.7, Math.min(maxW, 180 * sc), 4 * sc);
    }
    // gloss + bottom grime
    var gl = g.createLinearGradient(0, y0, 0, y0 + ph);
    gl.addColorStop(0, 'rgba(255,255,255,0.16)'); gl.addColorStop(0.45, 'rgba(255,255,255,0.02)'); gl.addColorStop(0.85, 'rgba(0,0,0,0)'); gl.addColorStop(1, 'rgba(40,30,20,0.25)');
    g.fillStyle = gl; g.fillRect(x0, y0, pw, ph);
    g.restore();
    // frame bolts
    g.fillStyle = '#8a8d92';
    for (var b = 0; b < 8; b++) { g.beginPath(); g.arc(fr * 0.5 + b * (W - fr) / 7, fr * 0.5, 2.5 * sc, 0, TAU); g.arc(fr * 0.5 + b * (W - fr) / 7, H - fr * 0.5, 2.5 * sc, 0, TAU); g.fill(); }
    return { source: c, wrapS: 'clamp', wrapT: 'clamp', aniso: 8, meta: { sponsor: custom ? null : sp.id } };
  };
  NEEDS_CANVAS.billboard = true;

  /* -------------------------------------------------------- start line (pure)
     Chequered finish band: u ACROSS the full track width (16 squares), v along
     the track through the band (2 rows). CLAMP. Paint wear + rubber streaks.  */
  GEN.startLine = function (o) {
    var W = o.size || S(512), H = W >> 3, P = makePixels(W, H), d = P.data, seed = o.seed == null ? 31 : o.seed;
    var colsN = o.columns || 16, cs = W / colsN;
    var wear = noiseField(128, 16, 16, 2, 3, seed + 1), rub = noiseField(64, 16, 12, 1, 2, seed + 2), wn = whiteNoise(W * H, seed + 3);
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / H, cx = Math.floor(x / cs), cy = Math.floor(y / cs);
      var white = (cx + cy) % 2 === 0;
      var c = white ? [236, 236, 230] : [24, 24, 26];
      var we = smooth(0.62, 0.8, sampleField(wear, u, v));
      c = mixC(c, [68, 68, 70], we * 0.65);
      var rb = smooth(0.55, 0.8, sampleField(rub, u, v)) * (0.6 + 0.4 * Math.abs(Math.sin(u * PI * 4)));
      c = mixC(c, [30, 30, 32], rb * 0.5);
      var s = 1 + (wn[y * W + x] - 0.5) * 0.12;
      setPx(d, i, c[0] * s, c[1] * s, c[2] * s);
    }
    return { source: P, wrapS: 'clamp', wrapT: 'clamp', aniso: 16 };
  };

  /* ---------------------------------------------------------------- grid box
     256x512 decal with alpha (CLAMP). v = 0 is the FRONT of the slot (towards
     the race direction); u across the slot. White "U" bracket open at the back,
     slot number painted (stretched along v so it reads from a low eye height). */
  GEN.gridBox = function (o) {
    var W = o.size || S(256, 64), H = W * 2, c = makeCanvas(W, H), g = ctx2d(c), sc = W / 256, num = String(o.number == null ? 1 : o.number);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    var lw = 14 * sc, m = 12 * sc;
    g.fillRect(m, m, W - 2 * m, lw);                  // front bar
    g.fillRect(m, m, lw, H * 0.34);                   // left leg
    g.fillRect(W - m - lw, m, lw, H * 0.34);          // right leg
    g.save();
    g.translate(W / 2, H * 0.62);
    g.scale(1, 1.9);
    var fs = fitFont(g, num, W * 0.7, 120 * sc, '900', FONT_HEAVY);
    g.font = '900 ' + fs + 'px ' + FONT_HEAVY; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(num, 0, 0);
    g.restore();
    var px = readPixels(g, W, H), dd = px.data;
    var wear = noiseField(64, 128, 8, 16, 3, hashStr('grid' + num) & 255);
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var w = smooth(0.6, 0.78, sampleField(wear, x / W, y / H));
      var a = dd[i + 3] * (0.92 - w * 0.75) * (0.9 + hash2(x, y, 3) * 0.1);
      dd[i] = 238; dd[i + 1] = 238; dd[i + 2] = 232; dd[i + 3] = a;
    }
    return { source: px, wrapS: 'clamp', wrapT: 'clamp', aniso: 16 };
  };
  NEEDS_CANVAS.gridBox = true;

  /* ------------------------------------------------------------ skid (pure)
     Rubber skid ribbon: u ACROSS the tyre width (CLAMP, alpha fades at edges),
     v ALONG the mark (REPEAT). rgb near-black, alpha = rubber density.         */
  GEN.skidmark = function (o) {
    var W = o.size || S(128, 32), H = W * 2, P = makePixels(W, H), d = P.data, seed = o.seed == null ? 37 : o.seed;
    var along = noiseField(8, 64, 1, 6, 3, seed + 1), groove = whiteNoise(16, seed + 2);
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / H;
      var prof = smooth(0, 0.16, u) * (1 - smooth(0.84, 1, u));
      var gi = Math.floor(u * 12), gt = u * 12 - gi;
      var gr = lerp(groove[gi % 16], groove[(gi + 1) % 16], gt * gt * (3 - 2 * gt));
      var streak = 0.55 + 0.45 * gr;
      var dens = 0.55 + 0.45 * sampleField(along, u, v);
      var a = clamp01(prof * streak * dens * 0.95 + (hash2(x, y, seed) - 0.5) * 0.08 * prof);
      setPx(d, i, 14, 14, 15, a * 255);
    }
    return { source: P, wrapS: 'clamp', wrapT: 'repeat', aniso: 8 };
  };

  /* ----------------------------------------------------------- smoke (pure)
     256x256 soft billowy puff sprite, alpha (non-premultiplied), lit top-left. */
  GEN.smoke = function (o) {
    var W = o.size || S(256, 64), P = makePixels(W, W), d = P.data, seed = o.seed == null ? 41 : o.seed;
    var n1 = noiseField(128, 128, 4, 4, 5, seed + 1), n2 = noiseField(64, 64, 3, 3, 3, seed + 2);
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i += 4) {
      var u = x / W, v = y / W, dx = u * 2 - 1, dy = v * 2 - 1;
      var wu = u + (sampleField(n2, u, v) - 0.5) * 0.25, wv = v + (sampleField(n2, v + 0.3, u) - 0.5) * 0.25;
      var n = sampleField(n1, wu, wv);
      var r = Math.sqrt(dx * dx + dy * dy) + (n - 0.5) * 0.35;
      var fall = 1 - smooth(0.25, 1, r);
      var a = clamp01(fall * (0.3 + 1.1 * n) * fall);
      var light = clamp01(0.65 + (n - 0.5) * 0.7 - (dx + dy) * 0.18);
      var c = 150 + 100 * light;
      setPx(d, i, c, c, c + 3, a * 255);
    }
    return { source: P, wrapS: 'clamp', wrapT: 'clamp', aniso: 1 };
  };

  /* ----------------------------------------------------------- spark (pure)
     64x64 additive spark sprite: white-hot core, orange glow, 4-point flare.  */
  GEN.spark = function (o) {
    var W = o.size || 64, P = makePixels(W, W), d = P.data;
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i += 4) {
      var dx = (x + 0.5) / W * 2 - 1, dy = (y + 0.5) / W * 2 - 1, r2 = dx * dx + dy * dy;
      var core = Math.exp(-r2 * 60), glow = Math.exp(-r2 * 7) * 0.55;
      var rays = (Math.exp(-Math.abs(dy) * 45) * Math.exp(-Math.abs(dx) * 3.5) + Math.exp(-Math.abs(dx) * 45) * Math.exp(-Math.abs(dy) * 3.5)) * 0.55;
      var I = clamp01(core + glow + rays) * (1 - smooth(0.85, 1, Math.sqrt(r2)));
      var c = mixC([255, 120, 30], [255, 250, 235], clamp01(core * 1.4 + rays * 0.5));
      setPx(d, i, c[0], c[1], c[2], I * 255);
    }
    return { source: P, wrapS: 'clamp', wrapT: 'clamp', aniso: 1 };
  };

  /* -------------------------------------------------------- raindrop (pure)
     32x128 rain streak sprite (v = 0 top tail .. bright head near v = 0.9).   */
  GEN.rainDrop = function (o) {
    var W = o.size || 32, H = W * 4, P = makePixels(W, H), d = P.data;
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i += 4) {
      var dx = (x + 0.5 - W / 2) / (W * 0.11), t = (y + 0.5) / H;
      var gx = Math.exp(-dx * dx);
      var prof = smooth(0, 0.85, t) * (1 - smooth(0.9, 1, t));
      var head = Math.exp(-Math.pow((t - 0.88) / 0.04, 2)) * 0.5;
      var a = clamp01(gx * (prof * 0.6 + head));
      setPx(d, i, 205, 220, 240, a * 255);
    }
    return { source: P, wrapS: 'clamp', wrapT: 'clamp', aniso: 1 };
  };

  /* -------------------------------------------------------------- car number
     Race number decal with alpha (CLAMP), 512 at high/ultra for crisp edges, uploaded with
     its own alpha-weighted mip chain (no dark fringes, no halo). opts.style:
       'roundel' (default) white disc + coloured ring, 256-unit square;
       'panel'   Le Mans style white rounded board with a coloured border;
       'plain'   bare number in opts.color with a dark outline + white keyline.
     opts.sdf: alpha holds a signed distance field instead of coverage (0.5 = edge,
     tex.meta.sdfSpread texels per 0.5) for smoothstep(0.5 - w, 0.5 + w, a) magnification.  */
  GEN.carNumber = function (o) {
    var W = o.size || S(512, 64), c = makeCanvas(W, W), g = ctx2d(c), sc = W / 256;
    var num = String(o.number == null ? 7 : o.number), ring = parseColor(o.color || '#d01818'), style = o.style || 'roundel';
    g.clearRect(0, 0, W, W);
    var cx = W / 2, R0 = W * 0.47, fs;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (style === 'panel') {
      var pw = W * 0.92, ph = W * 0.66, x0 = (W - pw) / 2, y0 = (W - ph) / 2;
      g.fillStyle = css(ring); roundRect(g, x0, y0, pw, ph, 14 * sc); g.fill();
      g.fillStyle = '#f7f7f4'; roundRect(g, x0 + 7 * sc, y0 + 7 * sc, pw - 14 * sc, ph - 14 * sc, 9 * sc); g.fill();
      fs = fitFont(g, num, pw - 34 * sc, ph * 0.86, '900', FONT_HEAVY);
      g.font = '900 ' + fs + 'px ' + FONT_HEAVY;
      g.fillStyle = '#0d0d0f'; g.fillText(num, cx, cx + 5 * sc);
    } else if (style === 'plain') {
      fs = fitFont(g, num, W * 0.9, W * 0.78, '900', FONT_HEAVY);
      g.font = '900 ' + fs + 'px ' + FONT_HEAVY; g.lineJoin = 'round';
      g.strokeStyle = '#0d0d0f'; g.lineWidth = 16 * sc; g.strokeText(num, cx, cx + 4 * sc);
      g.strokeStyle = '#f7f7f4'; g.lineWidth = 7 * sc; g.strokeText(num, cx, cx + 4 * sc);
      g.fillStyle = css(ring); g.fillText(num, cx, cx + 4 * sc);
    } else {
      g.fillStyle = css(ring); g.beginPath(); g.arc(cx, cx, R0, 0, TAU); g.fill();
      g.fillStyle = css(scaleC(ring, 0.6)); g.beginPath(); g.arc(cx, cx, R0, 0, TAU); g.arc(cx, cx, R0 - 3 * sc, 0, TAU, true); g.fill();
      g.fillStyle = '#f7f7f4'; g.beginPath(); g.arc(cx, cx, R0 - 16 * sc, 0, TAU); g.fill();
      fs = fitFont(g, num, (R0 - 22 * sc) * 1.7, 150 * sc, '900', FONT_HEAVY);
      g.font = '900 ' + fs + 'px ' + FONT_HEAVY;
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillText(num, cx + 3 * sc, cx + 9 * sc);
      g.fillStyle = '#0d0d0f'; g.fillText(num, cx, cx + 6 * sc);
    }
    var px = readPixels(g, W, W), meta = { style: style };
    dilateRGB(px.data, W, W, 4);
    if (o.sdf) { meta.sdfSpread = alphaToSDF(px.data, W, W, Math.max(4, Math.round(4 * sc))); meta.sdf = true; }
    else px.levels = buildMips(px.data, W, W);
    return { source: px, wrapS: 'clamp', wrapT: 'clamp', aniso: 8, meta: meta };
  };
  /** replace alpha (coverage) with a signed distance field: 0.5 at the edge, +-0.5 at +-spread texels */
  function alphaToSDF(d, w, h, spread) {
    var n = w * h, inD = F32(n), outD = F32(n), BIG = 1e6, i, x, y;
    for (i = 0; i < n; i++) {
      var a = d[i * 4 + 3] / 255;
      inD[i] = a > 0.999 ? BIG : a < 0.001 ? 0 : Math.max(0, a - 0.5);     // distance to the outside
      outD[i] = a < 0.001 ? BIG : a > 0.999 ? 0 : Math.max(0, 0.5 - a);   // distance to the inside
    }
    function chamfer(D) {
      var c1 = 1, c2 = 1.41421356;
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        i = y * w + x; var v = D[i];
        if (x > 0) v = Math.min(v, D[i - 1] + c1);
        if (y > 0) { v = Math.min(v, D[i - w] + c1); if (x > 0) v = Math.min(v, D[i - w - 1] + c2); if (x < w - 1) v = Math.min(v, D[i - w + 1] + c2); }
        D[i] = v;
      }
      for (y = h - 1; y >= 0; y--) for (x = w - 1; x >= 0; x--) {
        i = y * w + x; var u = D[i];
        if (x < w - 1) u = Math.min(u, D[i + 1] + c1);
        if (y < h - 1) { u = Math.min(u, D[i + w] + c1); if (x < w - 1) u = Math.min(u, D[i + w + 1] + c2); if (x > 0) u = Math.min(u, D[i + w - 1] + c2); }
        D[i] = u;
      }
    }
    chamfer(inD); chamfer(outD);
    for (i = 0; i < n; i++) {
      var sd = inD[i] > 0 ? inD[i] : -outD[i];
      d[i * 4 + 3] = clamp01(0.5 + sd / (2 * spread)) * 255;
    }
    return spread;
  }
  NEEDS_CANVAS.carNumber = true;
  /** number plate (EU style, 4:1): off-white reflective ground (sRGB ~0.82 -> linear ~0.62, never a glowing slab), a
      narrow dark sans registration, a 2 px dark border and a faint blue country strip on the left */
  GEN.numberPlate = function (o) {
    var W = o.size || S(256, 64), H = W / 4, c = makeCanvas(W, H), g = ctx2d(c), sc = W / 256;
    var txt = String(o.text == null ? 'FG 007' : o.text).slice(0, 10);
    g.fillStyle = '#d2d2cd'; g.fillRect(0, 0, W, H);
    // faint retro-reflective grain so the ground is not a dead flat fill
    var R = rng(hashStr('plate' + txt));
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (var i = 0; i < 260 * sc; i++) g.fillRect(R() * W, R() * H, 1, 1);
    g.fillStyle = '#2f4fa0'; g.fillRect(2 * sc, 2 * sc, 22 * sc, H - 4 * sc);
    g.fillStyle = 'rgba(255,214,0,0.85)';
    for (var k = 0; k < 8; k++) { var a = k / 8 * TAU; g.beginPath(); g.arc(13 * sc + Math.cos(a) * 6 * sc, 22 * sc + Math.sin(a) * 6 * sc, 0.9 * sc, 0, TAU); g.fill(); }
    g.fillStyle = '#e8e8e4'; g.font = '700 ' + Math.round(11 * sc) + 'px ' + FONT_SANS; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(o.country || 'D', 13 * sc, 46 * sc);
    g.strokeStyle = '#141416'; g.lineWidth = 2 * sc; roundRect(g, 1 * sc, 1 * sc, W - 2 * sc, H - 2 * sc, 4 * sc); g.stroke();
    var fs = fitFont(g, txt, W - 46 * sc, 44 * sc, '700', FONT_COND);
    g.font = '700 ' + fs + 'px ' + FONT_COND; g.fillStyle = '#121214';
    g.fillText(txt, (W + 24 * sc) / 2, H / 2 + 2 * sc);
    var px = readPixels(g, W, H);
    px.levels = buildMips(px.data, W, H);
    return { source: px, wrapS: 'clamp', wrapT: 'clamp', aniso: 8, meta: { text: txt } };
  };
  NEEDS_CANVAS.numberPlate = true;

  /* ----------------------------------------------------------- tyre sidewall
     1024x128 strip: u AROUND the circumference (REPEAT, branding twice), v =
     0 at the TREAD shoulder (outer) .. 1 at the RIM (inner) so upright text
     reads outward. Raised lettering: "FORGE", "CORSA R-ZERO", size code, DOT.
     opts.stripe = optional coloured compound ring (e.g. '#ffd400').            */
  GEN.tireSidewall = function (o) {
    var W = o.size || S(1024, 256), H = W >> 3, c = makeCanvas(W, H), g = ctx2d(c);
    drawSidewall(g, W, H, o, false);
    return { source: c, wrapS: 'repeat', wrapT: 'clamp', aniso: 8 };
  };
  NEEDS_CANVAS.tireSidewall = true;
  /** sidewall artwork; heightMode draws a greyscale relief (bulge, rim ridge, knurl, raised letters) */
  function drawSidewall(g, W, H, o, heightMode) {
    var sc = W / 1024, seed = 43;
    pixelPass(g, W, H, function (x, y, i, d) {
      var v = y / H;
      if (heightMode) {
        // bulge, rim-protector ridge near the bead, fine knurled ring, mould vent dimples
        var hb = 0.35 + 0.25 * Math.sin(PI * v) + 0.18 * smooth(0.8, 0.86, v) * (1 - smooth(0.9, 0.96, v));
        var kn = v > 0.9 ? 0.04 * Math.sin(x * TAU / (6 * sc)) * Math.sin(v * 90) : 0;
        var vh = 0.02 * (hash2(x, y, seed) - 0.5);
        var hv = clamp01(hb + kn + vh) * 255; setPx(d, i, hv, hv, hv); return;
      }
      var ring = 0.9 + 0.1 * Math.sin(v * 70) * (v > 0.85 || v < 0.12 ? 1 : 0.3);
      var s = (24 + (hash2(x, y, seed) - 0.5) * 6) * ring * (0.75 + 0.25 * Math.sin(PI * v));
      setPx(d, i, s, s, s + 1);
    });
    if (o.stripe && !heightMode) {
      var st = parseColor(o.stripe);
      g.fillStyle = css(st); g.fillRect(0, H * 0.74, W, 4 * sc);
      g.fillStyle = css(st, 0.4); g.fillRect(0, H * 0.74 + 4 * sc, W, 1 * sc);
    }
    function raised(text, x, y, font, spacing) {
      g.font = font; g.textAlign = 'left'; g.textBaseline = 'middle';
      if (heightMode) {
        g.globalCompositeOperation = 'lighter'; g.fillStyle = 'rgb(64,64,64)';
        spacedText(g, text, x, y, spacing); g.globalCompositeOperation = 'source-over'; return;
      }
      // moulded rubber lettering (a slightly lighter, smoother rubber that reads through the relief + sheen);
      // opts.whiteLetters keeps the painted white-letter look as a build option
      var wl = !!o.whiteLetters;
      g.fillStyle = 'rgba(0,0,0,' + (wl ? 0.75 : 0.5) + ')'; spacedText(g, text, x + 1.2 * sc, y + 1.4 * sc, spacing);
      g.fillStyle = wl ? 'rgba(205,205,200,0.95)' : 'rgba(60,60,61,1)'; spacedText(g, text, x, y, spacing);
      g.fillStyle = wl ? 'rgba(255,255,255,0.3)' : 'rgba(96,96,98,0.18)'; spacedText(g, text, x - 0.6 * sc, y - 0.6 * sc, spacing);
    }
    function textW(text, font, spacing) {
      g.font = font;
      var t = 0;
      for (var q = 0; q < text.length; q++) { var m = g.measureText(text[q]); t += (m && m.width || 0) + (q ? spacing : 0); }
      return t;
    }
    var label = String(o.label || 'REDLINE').toUpperCase();
    var half = W / 2, gap = 22 * sc, dotR = 4 * sc;
    // main row: LABEL  •  CORSA R-ZERO   (fonts shrink together until the row fits 88% of a half)
    var fBig = H * 0.36, fMid = H * 0.21, row, wL, wM;
    for (var it = 0; it < 24; it++) {
      wL = textW(label, '900 ' + Math.round(fBig) + 'px ' + FONT_HEAVY, 6 * sc);
      wM = textW('CORSA R-ZERO', '700 ' + Math.round(fMid) + 'px ' + FONT_COND, 4 * sc);
      row = wL + gap * 2 + dotR * 2 + wM;
      if (row <= half * 0.88) break;
      fBig *= 0.94; fMid *= 0.94;
    }
    // lower row: size code  -  DOT code
    var fSm = H * 0.13, sizeTxt = '275/35 ZR20  101Y  XL', dotTxt = 'DOT  FG7R  4226', wS, wD, row2;
    for (var it2 = 0; it2 < 24; it2++) {
      wS = textW(sizeTxt, '600 ' + Math.round(fSm) + 'px ' + FONT_SANS, 2 * sc);
      wD = textW(dotTxt, '600 ' + Math.round(fSm * 0.85) + 'px ' + FONT_SANS, 1.5 * sc);
      row2 = wS + gap * 2 + wD;
      if (row2 <= half * 0.8) break;
      fSm *= 0.94;
    }
    for (var rep = 0; rep < 2; rep++) {
      var ox = rep * half, x0 = ox + (half - row) / 2, yMain = H * 0.4;
      raised(label, x0, yMain, '900 ' + Math.round(fBig) + 'px ' + FONT_HEAVY, 6 * sc);
      var xd = x0 + wL + gap + dotR;
      g.fillStyle = o.whiteLetters ? 'rgba(180,180,175,0.7)' : 'rgba(58,58,59,0.9)'; g.beginPath(); g.arc(xd, yMain, dotR, 0, TAU); g.fill();
      raised('CORSA R-ZERO', xd + dotR + gap, yMain, '700 ' + Math.round(fMid) + 'px ' + FONT_COND, 4 * sc);
      var x1 = ox + (half - row2) / 2, yLow = H * 0.78;
      raised(sizeTxt, x1, yLow, '600 ' + Math.round(fSm) + 'px ' + FONT_SANS, 2 * sc);
      raised(dotTxt, x1 + wS + gap * 2, yLow, '600 ' + Math.round(fSm * 0.85) + 'px ' + FONT_SANS, 1.5 * sc);
    }
  }

  /* --------------------------------------------------------- carbon (pure)
     2x2 twill carbon weave, 8 tows per tile (REPEAT). Fibre striation and
     anisotropic sheen difference between warp & weft.                         */
  GEN.carbonWeave = function (o) {
    var W = o.size || S(256, 64), P = makePixels(W, W), d = P.data, tows = o.tows || 8, cs = W / tows;
    var tint = parseColor(o.tint || [20, 21, 24]);
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i += 4) {
      var cx = Math.floor(x / cs), cy = Math.floor(y / cs), fx = (x - cx * cs) / cs, fy = (y - cy * cs) / cs;
      var warp = mod(cx - cy, 4) < 2;
      var across = warp ? fy : fx, along = warp ? fx : fy;
      var cyl = Math.sin(PI * clamp(across, 0, 1));
      var dip = 0.55 + 0.45 * smooth(0, 0.18, along) * (1 - smooth(0.82, 1, along));
      var stri = hash2(warp ? Math.floor(y * 1.5) : Math.floor(x * 1.5), warp ? cx : cy, 5) - 0.5;
      var sheen = warp ? 1 : 0.42;
      var b = (0.5 + 2.9 * sheen * Math.pow(cyl, 1.6) * dip + stri * 0.5) * (0.85 + 0.15 * cyl);
      if (across < 0.04 || across > 0.96) b *= 0.4;
      setPx(d, i, tint[0] * b, tint[1] * b, tint[2] * b * 1.04);
    }
    return { source: P, wrapS: 'repeat', wrapT: 'repeat', aniso: 8 };
  };

  /* ===================================================== car material maps
     Showroom-grade procedural maps for the car meshes. Each FAMILY is computed once per
     (family, opts, quality) - shared height / masks - and split into channels:
       <family>          albedo   sRGB RGBA8 (alpha documented per family; 255 when unused)
       <family>Normal    normal   linear tangent-space (R = +u, G = +v, B = up)
       <family>Orm       orm      linear glTF packing: R = ambient occlusion, G = roughness, B = metalness
       <family>Emissive  emissive linear RGB light masks, only for lights:
                                  headlight: R = low/high beam, G = DRL, B = indicator
                                  taillight: R = tail + brake, G = reverse, B = indicator
     Getters: T.<family>(ctx, opts) -> albedo; opts.channel = 'normal'|'orm'|'emissive' picks another,
     or T.<family>Normal(ctx, opts) etc.  T.carSet(ctx, family, opts) -> {map, normalMap, ormMap,
     emissiveMap, meta}. Every texture carries tex.meta = {family, channel, layout, ...}.
     Pure pixel math (no DOM needed) except text: lettering is skipped when there is no canvas. */
  var FAM = {}, FAM_CHANNELS = {}, famMemo = [];
  function famKey(fam, o) {
    var c = {}; for (var k in o) if (k !== 'channel') c[k] = o[k];
    return keyOf(fam, c);
  }
  function famCompute(fam, o) {
    var key = famKey(fam, o);
    for (var i = 0; i < famMemo.length; i++) if (famMemo[i].key === key) return famMemo[i].res;
    var res = FAM[fam](o || {});
    famMemo.push({ key: key, res: res });
    if (famMemo.length > 4) famMemo.shift();
    return res;
  }
  var CH_SUFFIX = { albedo: '', normal: 'Normal', orm: 'Orm', emissive: 'Emissive' };
  function registerFamily(fam, channels, compute) {
    FAM[fam] = compute; FAM_CHANNELS[fam] = channels;
    channels.forEach(function (ch) {
      GEN[fam + CH_SUFFIX[ch]] = function (o) {
        var r = famCompute(fam, o || {}), data;
        if (ch === 'albedo') data = r.albedo;
        else if (ch === 'normal') data = r.normal || (r.normal = heightToNormal(r.height, r.w, r.h, r.strength == null ? 2 : r.strength));
        else if (ch === 'orm') data = r.orm;
        else data = r.emissive;
        var src = { width: r.w, height: r.h, data: data };
        if (ch === 'albedo' && r.alphaCov != null) src.levels = buildMips(data, r.w, r.h, r.alphaCov, r.plainRGB);
        else if (ch === 'albedo' && r.alphaMips) src.levels = buildMips(data, r.w, r.h);
        return {
          source: src, wrapS: r.wrapS || r.wrap || 'repeat', wrapT: r.wrapT || r.wrap || 'repeat', aniso: r.aniso || 8,
          linear: ch !== 'albedo', meta: { family: fam, channel: ch, layout: r.layout || '', info: r.info || null }
        };
      };
    });
  }

  /* ---- buffer helpers (Float32 planes, pixel units, analytic AA) ---- */
  function F32(n) { return new Float32Array(n); }
  /** coverage of a signed distance d (pixels, negative inside) -> 0..1 with a 1px AA ramp */
  function cov(d) { return d <= -0.5 ? 1 : d >= 0.5 ? 0 : 0.5 - d; }
  function blurF(src, w, h, r, wrap) {
    if (r < 1) return src.slice();
    var tmp = F32(w * h), out = F32(w * h), inv = 1 / (2 * r + 1), x, y, k, s, xx, yy;
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        s = 0;
        for (k = -r; k <= r; k++) { xx = x + k; xx = wrap ? (xx + w) % w : (xx < 0 ? 0 : xx >= w ? w - 1 : xx); s += src[row + xx]; }
        tmp[row + x] = s * inv;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        s = 0;
        for (k = -r; k <= r; k++) { yy = y + k; yy = wrap ? (yy + h) % h : (yy < 0 ? 0 : yy >= h ? h - 1 : yy); s += tmp[yy * w + x]; }
        out[y * w + x] = s * inv;
      }
    }
    return out;
  }
  /** cavity AO: texels below their blurred neighbourhood get darker */
  function aoFromHeight(hgt, w, h, r, k, wrap) {
    var b = blurF(hgt, w, h, r, wrap), ao = F32(w * h);
    for (var i = 0; i < ao.length; i++) ao[i] = clamp01(1 - Math.max(0, b[i] - hgt[i]) * k);
    return ao;
  }
  function pv(a, i) { return typeof a === 'number' ? a : a[i]; }
  function packORM(w, h, ao, rough, metal) {
    var d = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, j = 0; i < w * h; i++, j += 4) {
      d[j] = clamp01(ao == null ? 1 : pv(ao, i)) * 255;
      d[j + 1] = clamp01(pv(rough, i)) * 255;
      d[j + 2] = clamp01(pv(metal, i)) * 255;
      d[j + 3] = 255;
    }
    return d;
  }
  function packRGB(w, h, r, g, b, a) {
    var d = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, j = 0; i < w * h; i++, j += 4) { d[j] = r[i]; d[j + 1] = g[i]; d[j + 2] = b[i]; d[j + 3] = a == null ? 255 : pv(a, i) * 255; }
    return d;
  }
  /** layered material buffer used by the lamp / caliper / disc painters */
  function MatBuf(w, h, bg) {
    var n = w * h, B = { w: w, h: h, r: F32(n), g: F32(n), b: F32(n), hgt: F32(n), rough: F32(n), metal: F32(n), ao: null, er: F32(n), eg: F32(n), eb: F32(n), a: F32(n) };
    bg = bg || {};
    var c = bg.color || [0, 0, 0];
    for (var i = 0; i < n; i++) { B.r[i] = c[0]; B.g[i] = c[1]; B.b[i] = c[2]; B.hgt[i] = bg.hgt || 0; B.rough[i] = bg.rough == null ? 0.5 : bg.rough; B.metal[i] = bg.metal || 0; B.a[i] = 1; }
    return B;
  }
  /** blend a layer into texel i with coverage k. L: {color|[r,g,b], hgt, rough, metal, em:[r,g,b], a} (missing = keep) */
  function put(B, i, k, col, L) {
    if (k <= 0) return;
    if (col) { B.r[i] += (col[0] - B.r[i]) * k; B.g[i] += (col[1] - B.g[i]) * k; B.b[i] += (col[2] - B.b[i]) * k; }
    if (!L) return;
    if (L.hgt != null) B.hgt[i] += (L.hgt - B.hgt[i]) * k;
    if (L.rough != null) B.rough[i] += (L.rough - B.rough[i]) * k;
    if (L.metal != null) B.metal[i] += (L.metal - B.metal[i]) * k;
    if (L.a != null) B.a[i] += (L.a - B.a[i]) * k;
    if (L.em) { B.er[i] += (L.em[0] - B.er[i]) * k; B.eg[i] += (L.em[1] - B.eg[i]) * k; B.eb[i] += (L.em[2] - B.eb[i]) * k; }
  }
  /** signed distance (pixels) to a rounded box centred (cx,cy), half size (hx,hy), corner radius rr */
  function sdRoundBox(x, y, cx, cy, hx, hy, rr) {
    var qx = Math.abs(x - cx) - hx + rr, qy = Math.abs(y - cy) - hy + rr;
    var ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rr;
  }
  /** unsigned distance (px) to segment a-b */
  function sdSeg(x, y, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay, wx = x - ax, wy = y - ay, l = vx * vx + vy * vy;
    var t = l > 0 ? clamp01((wx * vx + wy * vy) / l) : 0, dx = wx - vx * t, dy = wy - vy * t;
    return Math.sqrt(dx * dx + dy * dy);
  }
  /** unsigned distance to an open polyline pts = [x0, y0, x1, y1, ...] */
  function sdPoly(x, y, pts) {
    var d = 1e9;
    for (var p = 0; p + 3 < pts.length; p += 2) d = Math.min(d, sdSeg(x, y, pts[p], pts[p + 1], pts[p + 2], pts[p + 3]));
    return d;
  }
  /** unsigned distance to a circular arc (centre, radius) spanning angles a0..a1 (radians, a1 > a0, atan2 convention) */
  function sdArc(x, y, cx, cy, r, a0, a1) {
    var dx = x - cx, dy = y - cy, ang = Math.atan2(dy, dx);
    while (ang < a0) ang += TAU;
    while (ang >= a0 + TAU) ang -= TAU;
    if (ang <= a1) return Math.abs(Math.sqrt(dx * dx + dy * dy) - r);
    var e0x = cx + Math.cos(a0) * r, e0y = cy + Math.sin(a0) * r, e1x = cx + Math.cos(a1) * r, e1y = cy + Math.sin(a1) * r;
    return Math.min(Math.hypot(x - e0x, y - e0y), Math.hypot(x - e1x, y - e1y));
  }
  /** approximate signed distance (px, negative inside) to an axis-aligned ellipse with semi-axes a, b */
  function sdEllipse(x, y, cx, cy, a, b) {
    var ux = (x - cx) / a, uy = (y - cy) / b, q = Math.sqrt(ux * ux + uy * uy);
    if (q < 1e-6) return -Math.min(a, b);
    var gx = ux / (a * q), gy = uy / (b * q), g = Math.sqrt(gx * gx + gy * gy);
    return (q - 1) / Math.max(1e-6, g);
  }
  /** iterate the texels of a bounding box (clamped), fn(x, y, i) */
  function boxEach(B, x0, y0, x1, y1, fn) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(B.w - 1, Math.ceil(x1)); y1 = Math.min(B.h - 1, Math.ceil(y1));
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) fn(x + 0.5, y + 0.5, y * B.w + x);
  }
  /** paint a disc; fn(i, k, t, dx, dy) with t = r / radius (0 centre .. 1 edge) */
  function paintDisc(B, cx, cy, rad, fn) {
    boxEach(B, cx - rad - 1, cy - rad - 1, cx + rad + 1, cy + rad + 1, function (x, y, i) {
      var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), k = cov(r - rad);
      if (k > 0) fn(i, k, r / rad, dx / rad, dy / rad);
    });
  }
  function paintRing(B, cx, cy, r0, r1, fn) {
    boxEach(B, cx - r1 - 1, cy - r1 - 1, cx + r1 + 1, cy + r1 + 1, function (x, y, i) {
      var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), k = Math.min(cov(r - r1), cov(r0 - r));
      if (k > 0) fn(i, k, (r - r0) / Math.max(1e-6, r1 - r0), dx, dy);
    });
  }
  /** paint a rounded box; fn(i, k, d, x, y) with d = signed distance in px (negative inside) */
  function paintBox(B, cx, cy, hx, hy, rr, fn) {
    boxEach(B, cx - hx - 1, cy - hy - 1, cx + hx + 1, cy + hy + 1, function (x, y, i) {
      var d = sdRoundBox(x, y, cx, cy, hx, hy, rr), k = cov(d);
      if (k > 0) fn(i, k, d, x, y);
    });
  }
  function finishBuf(B, o) {
    o = o || {};
    var w = B.w, h = B.h, n = w * h;
    var alb = packRGB(w, h, B.r, B.g, B.b, o.alpha ? B.a : null);
    var ao = aoFromHeight(B.hgt, w, h, o.aoR || Math.max(2, w >> 7), o.aoK || 2.2, !!o.wrap);
    if (o.extraAO) for (var i = 0; i < n; i++) ao[i] *= o.extraAO[i];
    var emi = null;
    if (o.emissive) {
      emi = new Uint8ClampedArray(n * 4);
      for (var j = 0; j < n; j++) { emi[j * 4] = clamp01(B.er[j]) * 255; emi[j * 4 + 1] = clamp01(B.eg[j]) * 255; emi[j * 4 + 2] = clamp01(B.eb[j]) * 255; emi[j * 4 + 3] = 255; }
    }
    return { w: w, h: h, albedo: alb, height: B.hgt, orm: packORM(w, h, ao, B.rough, B.metal), emissive: emi };
  }
  /** 1D periodic value noise table (n bins, smoothed) -> fn(t in bins, any real) */
  function noise1D(n, seed, smoothR) {
    var a = whiteNoise(n, seed), b = new Float32Array(n), r = smoothR || 0;
    for (var i = 0; i < n; i++) { var s = 0; for (var k = -r; k <= r; k++) s += a[mod(i + k, n)]; b[i] = s / (2 * r + 1); }
    return function (t) { var f = Math.floor(t), fr = t - f, i0 = mod(f, n), i1 = (i0 + 1) % n; return b[i0] + (b[i1] - b[i0]) * fr; };
  }
  /** periodic Worley (cellular) noise: P cells across the tile. Writes into out {f1, f2, id, cx, cy} */
  function worley(u, v, P, seed, out) {
    var gx = u * P, gy = v * P, ix = Math.floor(gx), iy = Math.floor(gy), f1 = 1e9, f2 = 1e9, id = 0, bx = 0, by = 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var cx = ix + dx, cy = iy + dy, wx = mod(cx, P), wy = mod(cy, P);
      var px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 101);
      var ddx = gx - px, ddy = gy - py, d = ddx * ddx + ddy * ddy;
      if (d < f1) { f2 = f1; f1 = d; id = wy * P + wx; bx = px; by = py; } else if (d < f2) f2 = d;
    }
    out.f1 = Math.sqrt(f1); out.f2 = Math.sqrt(f2); out.id = id; out.cx = bx / P; out.cy = by / P;
    return out;
  }
  /** canvas text -> coverage mask Float32 (null when no canvas). draw(g, w, h) fills with opaque white */
  function textMask(w, h, draw) {
    if (!hasCanvas()) return null;
    try {
      var c = makeCanvas(w, h), g = ctx2d(c);
      g.clearRect(0, 0, w, h); g.fillStyle = '#ffffff'; g.strokeStyle = '#ffffff';
      draw(g, w, h);
      var d = g.getImageData(0, 0, w, h).data, m = F32(w * h);
      for (var i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
      return m;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------- tyre tread
     tyreTread: contact-patch rubber. u = AROUND the circumference (REPEAT), v = ACROSS the
     tread (0 = outer shoulder .. 1 = inner shoulder). One tile covers 2 tread widths of
     circumference (texels square on a W x W/2 map) -> use uRepeat = round(circumference /
     (2 * width)) so the pattern stays seamless. opts.pattern: 'sport' (asymmetric UHP, default),
     'semi' (track-day semi-slick), 'slick' (grained racing slick), 'wet' (directional rain),
     'offroad' (blocks). opts.wear 0..1 scuffs the surface.                                  */
  registerFamily('tyreTread', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), H = W >> 1, n = W * H, pat = o.pattern || 'sport', wear = o.wear == null ? 0.35 : clamp01(o.wear);
    var px = W / 512, hgt = F32(n), grv = F32(n), seed = hashStr(pat) & 1023;
    var grain = noiseField(256, 64, 3, 24, 3, seed + 3), blot = noiseField(64, 32, 4, 2, 3, seed + 4);
    function lineD(phase, grad) { return Math.abs(fract(phase + 0.5) - 0.5) / grad; } // px distance to nearest periodic line
    var CIRC = { sport: [[0.24, 0.026], [0.42, 0.032], [0.61, 0.032], [0.79, 0.024]], semi: [[0.36, 0.03], [0.66, 0.028]],
      wet: [[0.5, 0.03]], slick: [], offroad: [] }[pat] || [];
    for (var y = 0; y < H; y++) {
      var v = (y + 0.5) / H;
      for (var x = 0; x < W; x++) {
        var u = (x + 0.5) / W, i = y * W + x, g = 0, d, k;
        for (var c = 0; c < CIRC.length; c++) {
          d = (Math.abs(v - CIRC[c][0]) - CIRC[c][1]) * H;
          g = Math.max(g, smooth(1.2, -1.2, d) * (0.85 + 0.15 * smooth(-1, -4 * px, d)));
        }
        if (pat === 'sport' || pat === 'semi') {
          var N = pat === 'sport' ? 22 : 14, sh = pat === 'sport' ? 0.205 : 0.13;
          var gradL = Math.sqrt(Math.pow(N / W, 2) + Math.pow(1.4 / H, 2));
          // outer shoulder slots (end before the first rib), inner shoulder slots mirrored and offset
          if (v < sh + 0.02) { d = Math.max(lineD(u * N + v * 1.4, gradL) - 2.6 * px, (v - sh) * H); g = Math.max(g, smooth(1, -1, d)); }
          if (v > 1 - sh - 0.02) { d = Math.max(lineD(u * N - v * 1.4 + 0.5, gradL) - 2.6 * px, (1 - sh - v) * H); g = Math.max(g, smooth(1, -1, d)); }
          if (pat === 'sport') {
            // sipes: fine slanted cuts in ribs 2 and 4, alternating short segments
            var gs = Math.sqrt(Math.pow(44 / W, 2) + Math.pow(2.2 / H, 2));
            if ((v > 0.28 && v < 0.375) || (v > 0.655 && v < 0.75)) {
              var sp = u * 44 + v * 2.2, seg = Math.floor(sp + 0.5);
              var vin = v < 0.5 ? (v - 0.28) / 0.095 : (v - 0.655) / 0.095;
              var on = (seg & 1) ? vin < 0.72 : vin > 0.28;
              if (on) g = Math.max(g, 0.75 * smooth(1, -0.6, lineD(sp, gs) - 0.7 * px));
            }
          }
        } else if (pat === 'wet') {
          // directional chevrons sweeping outward from the centre groove
          var Nw = 12, sl = 2.6, ph = u * Nw + Math.abs(v - 0.5) * sl, gw = Math.sqrt(Math.pow(Nw / W, 2) + Math.pow(sl / H, 2));
          d = lineD(ph, gw) - (3.2 + 2.5 * Math.abs(v - 0.5)) * px;
          if (Math.abs(v - 0.5) > 0.05) g = Math.max(g, smooth(1, -1, d));
          var ps = u * Nw * 2 + Math.abs(v - 0.5) * sl * 2 + 0.25;
          if (Math.abs(v - 0.5) > 0.12 && Math.abs(v - 0.5) < 0.38) g = Math.max(g, 0.7 * smooth(1, -0.6, lineD(ps, gw * 2) - 0.7 * px));
        } else if (pat === 'offroad') {
          var cols = 9, rows = 5, rr = Math.floor(v * rows), off = (rr & 1) ? 0.5 : 0, cu = u * cols + off;
          var bx = (fract(cu) - 0.5) * W / cols, by = (fract(v * rows) - 0.5) * H / rows;
          d = sdRoundBox(bx, by, 0, 0, W / cols * 0.36, H / rows * 0.36, 5 * px);
          g = Math.max(g, smooth(-1.5, 1.5, d));
        }
        // shoulders roll off toward the sidewall
        var sho = Math.min(smooth(0, 0.075, v), smooth(1, 0.925, v));
        var gr = sampleField(grain, u, v) - 0.5, bl = sampleField(blot, u, v);
        var hv = 1 - g * 0.92;
        hv = hv * (0.55 + 0.45 * sho) + gr * 0.04 * (1 - g);
        if (pat === 'slick') hv += gr * 0.05 + (hash2(x, y, 9) - 0.5) * 0.03;
        hgt[i] = hv; grv[i] = g * sho;
      }
    }
    var alb = new Uint8ClampedArray(n * 4), ao = aoFromHeight(hgt, W, H, Math.max(2, 4 * px | 0), 2.6, true), rough = F32(n);
    for (var j = 0; j < n; j++) {
      var yy = (j / W) | 0, vv = (yy + 0.5) / H, uu = (j % W + 0.5) / W;
      var gr2 = sampleField(grain, uu, vv) - 0.5, bl2 = sampleField(blot, uu, vv), wn = hash2(j % W, yy, 77) - 0.5;
      var sho2 = Math.min(smooth(0, 0.075, vv), smooth(1, 0.925, vv));
      var scuff = wear * sho2 * (1 - grv[j]) * (0.6 + 0.8 * gr2 + 0.3 * (bl2 - 0.5));
      var b = 31 + scuff * 22 + wn * 4 - grv[j] * 14;
      if (pat === 'slick') { b += gr2 * 10 * wear; if (bl2 > 0.68 && sho2 < 0.9) b -= 6; }
      alb[j * 4] = b; alb[j * 4 + 1] = b; alb[j * 4 + 2] = b + 1.5; alb[j * 4 + 3] = 255;
      rough[j] = clamp(0.78 - scuff * 0.22 + grv[j] * 0.16 + wn * 0.04, 0.45, 0.98);
      ao[j] *= 1 - grv[j] * 0.45;
    }
    return { w: W, h: H, albedo: alb, height: hgt, strength: 2.2 * px, orm: packORM(W, H, ao, rough, 0), wrap: 'repeat', aniso: 16,
      layout: 'u around circumference (1 tile = 2 tread widths, REPEAT), v across tread 0 outer..1 inner', info: { pattern: pat } };
  });

  /* --------------------------------------------------------------- brake disc
     brakeDisc: whole rotor face, polar in a square (CLAMP): centre = hub, radius 0.5 (uv) =
     outer edge. Friction ring r in [0.29, 0.49] uv, bell/bobbins ~0.27, hat with 5 lug holes,
     centre bore. alpha = 0 in through-holes and outside the rotor (alpha test at 0.5; holes
     keep a dark RGB so non-alpha-tested use still reads as holes). opts.type: 'drilled'
     (default), 'slotted', 'drilledSlotted', 'plain', 'ceramic' (carbon-ceramic, drilled),
     opts.hat: hat colour.                                                                 */
  registerFamily('brakeDisc', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), type = o.type || 'drilled', ceramic = type === 'ceramic';
    var drilled = type === 'drilled' || type === 'drilledSlotted' || ceramic, slotted = type === 'slotted' || type === 'drilledSlotted';
    var B = MatBuf(W, W, { color: [10, 10, 11], rough: 0.6 }), half = W / 2, px = 2 / W;
    var hatC = o.hat ? parseColor(o.hat) : ceramic ? [34, 34, 37] : [96, 98, 102];
    var rO = 0.985, rI = 0.585, rH = 0.5, rB = 0.27;
    var score = noise1D(Math.round(W * 0.9), 31, 0), score2 = noise1D(48, 32, 1), mott = noiseField(128, 128, 6, 6, 4, 33);
    var holes = [];
    if (drilled) {
      var NR = ceramic ? 3 : 4, NA = ceramic ? 22 : 30;
      for (var rw = 0; rw < NR; rw++) {
        var rr = rI + (rO - rI) * (rw + 0.75) / (NR + 0.5);
        for (var q = 0; q < NA; q++) { var aa = (q + rw / NR) * TAU / NA; holes.push([Math.cos(aa) * rr, Math.sin(aa) * rr]); }
      }
    }
    var hr = ceramic ? 0.026 : 0.022;
    for (var y = 0; y < W; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x, dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half, r = Math.sqrt(dx * dx + dy * dy), a = Math.atan2(dy, dx);
      var kDisc = cov((r - rO) / px), kBore = cov((r - 0.135) / px);
      if (kDisc <= 0) { B.a[i] = 0; continue; }
      var m = sampleField(mott, dx * 0.5 + 0.5, dy * 0.5 + 0.5);
      if (r > rI - px) {
        // friction ring: turned steel with concentric scoring, faint heat tint at the edges
        var sc = score(r * W * 0.45) - 0.5, sc2 = score2(r * 48) - 0.5, k = cov((rI - r) / px);
        var col, rough, metal;
        if (ceramic) {
          var fl = hash2(x, y, 5) > 0.985 ? 30 : 0, band = 74 + (m - 0.5) * 30 + sc * 10 + fl;
          col = [band, band - 2, band - 4]; rough = 0.55 + (m - 0.5) * 0.2; metal = 0.2;
        } else {
          var s = 150 + sc * 26 + sc2 * 14 + (m - 0.5) * 10, edge = Math.max(smooth(rI + 0.06, rI, r), smooth(rO - 0.05, rO, r));
          col = mixC([s, s, s + 2], [s * 0.82, s * 0.74, s * 0.95], edge * 0.6); rough = 0.26 + sc * 0.14 + (m - 0.5) * 0.1; metal = 1;
        }
        put(B, i, k, col, { hgt: 1 + sc * 0.02, rough: rough, metal: metal });
        // outer chamfer
        var ch = smooth(rO - 0.018, rO, r);
        if (ch > 0) put(B, i, ch * 0.7, scaleC(col, 0.55), { hgt: 1 - ch * 0.5, rough: 0.5 });
      }
      if (r < rI + px) {
        var kh = cov((r - rI) / px);
        if (r > rH) {
          // bell: dark gap between floating bobbins (or the cast neck on one-piece rotors)
          put(B, i, kh, ceramic ? [24, 24, 26] : [44, 44, 46], { hgt: 0.55, rough: 0.7, metal: ceramic ? 0 : 0.6 });
        } else {
          var spun = score(r * W * 0.3 + 11) - 0.5;
          put(B, i, kh, [hatC[0] + spun * 14, hatC[1] + spun * 14, hatC[2] + spun * 14], { hgt: 0.72 + spun * 0.01, rough: 0.38 + spun * 0.1, metal: 0.9 });
          var step = smooth(rH - 0.02, rH, r);
          if (step > 0) put(B, i, step * 0.6, scaleC(hatC, 0.5), { hgt: 0.6 });
        }
      }
      // slots: curved, blind (not through)
      if (slotted && r > rI + 0.03 && r < rO - 0.03) {
        var NS = 12, ph = a * NS / TAU + (r - rI) * 2.2, dAng = Math.abs(fract(ph + 0.5) - 0.5) * TAU / NS * r;
        var ends = Math.max(rI + 0.05 - r, r - (rO - 0.05));
        var dS = Math.max(dAng - 0.011, ends) / px;
        var kS = cov(dS);
        if (kS > 0) put(B, i, kS, ceramic ? [30, 30, 32] : [52, 52, 55], { hgt: 0.45 + 0.4 * smooth(-3, 0, dS), rough: 0.6 });
      }
      if (kBore > 0) { put(B, i, kBore, [6, 6, 7], { hgt: 0, a: 0 }); }
      if (kDisc < 1) B.a[i] *= kDisc;
    }
    // drilled holes (through: alpha 0) with chamfered lips
    holes.forEach(function (h) {
      var cx = (h[0] * half + half), cy = (h[1] * half + half), R = hr * half;
      paintDisc(B, cx, cy, R * 1.35, function (i, k, t) {
        var lip = smooth(1, 0.74, t);
        put(B, i, k * lip * 0.7, [40, 40, 42], { hgt: 1 - 0.6 * lip, rough: 0.55 });
      });
      paintDisc(B, cx, cy, R, function (i, k) { put(B, i, k, [8, 8, 9], { hgt: 0.1, a: 0 }); });
    });
    // floating-disc bobbins + lug holes
    var NB = 10, rb = (rH + rI) / 2;
    for (var b = 0; b < NB; b++) {
      var ab = b * TAU / NB + 0.3;
      paintDisc(B, half + Math.cos(ab) * rb * half, half + Math.sin(ab) * rb * half, 0.026 * half, function (i, k, t) {
        var dome = Math.sqrt(Math.max(0, 1 - t * t));
        put(B, i, k, ceramic ? [150, 120, 60] : [175, 176, 180], { hgt: 0.62 + dome * 0.25, rough: 0.3, metal: 1 });
      });
    }
    for (var l = 0; l < 5; l++) {
      var al = l * TAU / 5 - PI / 2;
      paintDisc(B, half + Math.cos(al) * rB * half, half + Math.sin(al) * rB * half, 0.05 * half, function (i, k, t) {
        put(B, i, k * smooth(1, 0.8, t), [20, 20, 22], { hgt: 0.45 });
      });
      paintDisc(B, half + Math.cos(al) * rB * half, half + Math.sin(al) * rB * half, 0.04 * half, function (i, k) { put(B, i, k, [6, 6, 7], { hgt: 0.1, a: 0 }); });
    }
    var res = finishBuf(B, { alpha: true });
    res.strength = 1.6 * W / 512; res.wrap = 'clamp'; res.alphaCov = 0.5; res.aniso = 8;
    res.layout = 'polar: centre = hub, uv radius 0.5 = rotor edge, CLAMP; alpha 0 = through-hole / outside';
    res.info = { type: type, frictionInner: rI * 0.5, frictionOuter: rO * 0.5, hatOuter: rH * 0.5 };
    return res;
  });

  /* ------------------------------------------------------------------ caliper
     caliper: the outboard face of a monoblock caliper, 2:1 (CLAMP). u along the caliper's
     arc (0 = leading end), v = 0 outer (rim side) .. 1 inner (hub side). Painted body with
     bevelled edges, raised clean lettering (no logos), two bleed nipples / bridge bolts.
     opts.color (default '#c8102e'), opts.text ('REDLINE'), opts.sub (optional small 2nd line,
     e.g. 'CERAMIC'), opts.finish 'gloss'|'satin'|'anodised'.                            */
  registerFamily('caliper', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), H = W >> 1, n = W * H, px = W / 512;
    var col = parseColor(o.color || '#c8102e'), text = String(o.text == null ? 'REDLINE' : o.text).toUpperCase(), sub = o.sub ? String(o.sub).toUpperCase() : '';
    var finish = o.finish || 'gloss', pr = finish === 'satin' ? 0.45 : finish === 'anodised' ? 0.32 : 0.2;
    var B = MatBuf(W, H, { color: scaleC(col, 0.25), hgt: 0, rough: 0.6 }), pn = noiseField(64, 32, 4, 2, 3, 61);
    var bevel = 22 * px;
    paintBox(B, W / 2, H / 2, W / 2 - 3 * px, H / 2 - 3 * px, H * 0.22, function (i, k, d, x, y) {
      var e = clamp01(-d / bevel), prof = Math.sin(e * PI / 2), m = sampleField(pn, x / W, y / H) - 0.5;
      var shade = 0.78 + 0.22 * prof + m * 0.05;
      put(B, i, k, [col[0] * shade, col[1] * shade, col[2] * shade], { hgt: 0.35 + 0.65 * prof, rough: pr + m * 0.06, metal: finish === 'anodised' ? 0.6 : 0 });
    });
    // pad-retaining bridge recess along the inner edge
    paintBox(B, W / 2, H * 0.86, W * 0.3, H * 0.045, H * 0.04, function (i, k) { put(B, i, k * 0.85, scaleC(col, 0.45), { hgt: 0.55, rough: 0.5 }); });
    // bolts / bleed nipples
    [[0.075, 0.5], [0.925, 0.5]].forEach(function (p) {
      paintDisc(B, p[0] * W, p[1] * H, H * 0.075, function (i, k, t) {
        var dome = Math.sqrt(Math.max(0, 1 - t * t)), ring = smooth(0.62, 0.7, t) * (1 - smooth(0.82, 0.9, t));
        put(B, i, k, mixC([200, 202, 206], [90, 92, 96], ring), { hgt: 0.9 + dome * 0.2 - ring * 0.1, rough: 0.28, metal: 1 });
      });
    });
    // lettering (raised, contrasting)
    var light = luma(col) > 170, tcol = light ? [20, 20, 22] : [246, 246, 242];
    var tm = textMask(W, H, function (g) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      var fs = fitFont(g, text, W * 0.66, H * (sub ? 0.36 : 0.44), '900', FONT_HEAVY);
      g.font = '900 ' + fs + 'px ' + FONT_HEAVY;
      spacedText(g, text, W / 2, H * (sub ? 0.43 : 0.5), 3 * px);
      if (sub) { var fs2 = fitFont(g, sub, W * 0.5, H * 0.14, '700', FONT_SANS); g.font = '700 ' + fs2 + 'px ' + FONT_SANS; spacedText(g, sub, W / 2, H * 0.7, 6 * px); }
    });
    if (tm) for (var i = 0; i < n; i++) if (tm[i] > 0) put(B, i, tm[i], tcol, { hgt: B.hgt[i] + 0.12, rough: pr + 0.18, metal: 0 });
    var res = finishBuf(B, {});
    res.strength = 1.4 * px; res.wrap = 'clamp'; res.aniso = 8;
    res.layout = 'u along caliper (0 leading end), v 0 outer..1 inner, CLAMP';
    res.info = { color: css(col), text: text, lettering: !!tm };
    return res;
  });

  /* ---------------------------------------------------------- brushed metal
     brushedMetal: anisotropic machined aluminium / steel. The micro-groove normal map varies
     only ACROSS the brush direction, so an isotropic GGX lobe stretches into the long
     brushed highlight. opts.style 'linear' (grain along u, REPEAT, default), 'spun' (lathe
     rings, polar CLAMP - wheel centres, caps), 'radial' (grain along radii, polar CLAMP).
     opts.tint (F0-ish metal colour, default aluminium), opts.finish 'satin'|'polished'|'rough'. */
  registerFamily('brushedMetal', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), n = W * W, style = o.style || 'linear', tint = parseColor(o.tint || [214, 216, 220]);
    var fin = o.finish || 'satin', rBase = fin === 'polished' ? 0.1 : fin === 'rough' ? 0.42 : 0.24;
    var hgt = F32(n), rough = F32(n), alb = new Uint8ClampedArray(n * 4);
    var polar = style !== 'linear';
    var f1 = polar ? null : noiseField(W, W, 2, Math.min(W, 256), 3, 71, 0.6);
    var rowN = noise1D(W * 2, 72, 0), rowC = noise1D(64, 73, 1), angN = noise1D(1024, 74, 0);
    for (var y = 0; y < W; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x, s;
      if (!polar) {
        var sx = sampleField(f1, (x + 0.5) / W, (y + 0.5) / W);
        s = 0.45 * sx + 0.4 * rowN(y * 2 + 0.5) + 0.15 * rowC(y / W * 64);
        if (hash2(y, (x * 4 / W) | 0, 75) > 0.993) s -= 0.35;   // occasional deeper scratch
      } else {
        var dx = (x + 0.5) / W - 0.5, dy = (y + 0.5) / W - 0.5, r = Math.sqrt(dx * dx + dy * dy) * 2, a = Math.atan2(dy, dx) / TAU + 0.5;
        if (style === 'spun') s = 0.6 * rowN(r * W * 1.2 + Math.sin(a * TAU * 3) * 0.6) + 0.4 * rowC(r * 40);
        else s = 0.65 * angN(a * 1024 + r * 2) + 0.35 * rowC(r * 18);
      }
      hgt[i] = s * 0.5;
      rough[i] = clamp(rBase + (0.5 - s) * 0.14, 0.04, 0.9);
      var sh = 0.88 + 0.12 * s, j = i * 4;
      alb[j] = tint[0] * sh; alb[j + 1] = tint[1] * sh; alb[j + 2] = tint[2] * sh; alb[j + 3] = 255;
    }
    return { w: W, h: W, albedo: alb, height: hgt, strength: 1.3, orm: packORM(W, W, null, rough, 1), wrap: polar ? 'clamp' : 'repeat', aniso: 16,
      layout: polar ? 'polar (centre = axis), CLAMP' : 'brush grain along u, REPEAT', info: { style: style } };
  });

  /* ---------------------------------------------------------------- carbon fibre
     carbonFibre: matches carbonWeave's twill layout (8 tows / tile, REPEAT) so the normal /
     orm channels can be layered under the existing albedo; or opts.style 'forged' (chopped
     strands, Lamborghini-style), 'plain' (1x1 weave). Lay a clearcoat over it in the shader. */
  registerFamily('carbonFibre', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), n = W * W, style = o.style || 'twill', tows = o.tows || 8, cs = W / tows;
    var tint = parseColor(o.tint || [20, 21, 24]), hgt = F32(n), rough = F32(n), alb = new Uint8ClampedArray(n * 4), ao = F32(n);
    var wo = {}, fWarp = style === 'forged' ? noiseField(128, 128, 3, 3, 3, 84) : null;
    for (var y = 0, i = 0; y < W; y++) for (var x = 0; x < W; x++, i++) {
      var b, h, rgh, a = 1;
      if (style === 'forged') {
        // domain-warped cells -> marbled, elongated chopped-tow chunks with per-chunk sheen
        var wu = (x + 0.5) / W, wv = (y + 0.5) / W;
        var w1 = sampleField(fWarp, wu, wv) - 0.5, w2 = sampleField(fWarp, wu + 0.37, wv + 0.61) - 0.5;
        worley(wu + w1 * 0.3, wv + w2 * 0.3, 11, 81, wo);
        var th = hash2(wo.id, 3, 82) * PI, ct = Math.cos(th), st = Math.sin(th);
        var du = (wu + w1 * 0.3 - wo.cx) * W, dv = (wv + w2 * 0.3 - wo.cy) * W, across = -du * st + dv * ct;
        var stri = hash2(Math.floor(across * 0.7), wo.id, 83) - 0.5;
        var sheen = Math.pow(Math.abs(Math.cos(th - 0.6)), 4);
        var edge = smooth(0, 0.05, wo.f2 - wo.f1);
        b = (0.45 + 3.0 * sheen + stri * 0.5) * (0.8 + 0.2 * edge);
        h = 0.5 + stri * 0.1 + edge * 0.12; rgh = 0.28 + (1 - sheen) * 0.12; a = 0.85 + 0.15 * edge;
      } else {
        var cx = Math.floor(x / cs), cy = Math.floor(y / cs), fx = (x - cx * cs) / cs, fy = (y - cy * cs) / cs;
        var warp = style === 'plain' ? ((cx + cy) & 1) === 0 : mod(cx - cy, 4) < 2;
        var acr = warp ? fy : fx, alg = warp ? fx : fy;
        var cyl = Math.sin(PI * clamp(acr, 0, 1));
        var dip = 0.55 + 0.45 * smooth(0, 0.18, alg) * (1 - smooth(0.82, 1, alg));
        var str2 = hash2(warp ? Math.floor(y * 1.5 * 256 / W) : Math.floor(x * 1.5 * 256 / W), warp ? cx : cy, 5) - 0.5;
        var sh2 = warp ? 1 : 0.42;
        b = (0.5 + 2.9 * sh2 * Math.pow(cyl, 1.6) * dip + str2 * 0.5) * (0.85 + 0.15 * cyl);
        if (acr < 0.04 || acr > 0.96) b *= 0.4;
        h = 0.25 + 0.6 * Math.pow(cyl, 0.7) * dip + str2 * 0.03; rgh = 0.3 + (warp ? 0 : 0.08) + (1 - dip) * 0.1; a = 0.7 + 0.3 * dip * cyl;
      }
      hgt[i] = h; rough[i] = rgh; ao[i] = a;
      alb[i * 4] = tint[0] * b; alb[i * 4 + 1] = tint[1] * b; alb[i * 4 + 2] = tint[2] * b * 1.04; alb[i * 4 + 3] = 255;
    }
    return { w: W, h: W, albedo: alb, height: hgt, strength: style === 'forged' ? 0.8 : 1.4, orm: packORM(W, W, ao, rough, 0), wrap: 'repeat', aniso: 16,
      layout: style === 'forged' ? 'forged chopped strands, REPEAT' : tows + ' tows per tile ' + style + ', REPEAT', info: { style: style } };
  });

  /* ------------------------------------------------------------- headlight
     headlight: lamp INTERIOR seen through the (separate, glossy) cover glass. 2:1, CLAMP,
     u = 0 inboard .. 1 outboard (mirror u for the other side), v = 0 top. Black bezel,
     chrome reflectors, projector lenses, light-guide DRL, amber indicator zone.
     opts.style 'projector' (default; also any unknown value), 'reflector' (twin chrome bowls),
     'round' (single bowl + halo ring), 'led' / 'matrix' (row of LED modules), 'laser' (LED +
     blue accent). Real-car styles: 'oval-4pt' (911: oval bowl, central projector, four-point
     DRL), 'c-clamp' (Supra: twin projectors + C-shaped DRL bracket), 'y-blade' (Huracan: Y DRL
     across a slim dark lamp), 'round-halo' (Mini / G-Class / Bronco: round lamp, projector core,
     LED halo), 'slim-led' (ID. Buzz / Cybertruck: thin full-width LED slit over LED cubes),
     'projector-twin' (twin equal projectors + swept hooked DRL), 'quad-round' (four round lamps
     with halos), 'blade' (M4 / Ferrari: stacked tapered LED blades + two small projectors).
     Emissive channel: R = beams, G = DRL (every light guide), B = indicator.               */
  registerFamily('headlight', ['albedo', 'normal', 'orm', 'emissive'], function (o) {
    var W = o.size || S(512, 128), H = W >> 1, px = W / 512, style = o.style || 'projector';
    var B = MatBuf(W, H, { color: [16, 16, 18], hgt: 0.2, rough: 0.55 }), env = noise1D(32, 91, 2);
    // housing: subtle textured black plastic with a chrome-ish lower trim
    for (var i = 0; i < W * H; i++) { var nn = hash2(i % W, (i / W) | 0, 92) - 0.5; B.r[i] += nn * 3; B.g[i] += nn * 3; B.b[i] += nn * 3; }
    function chromeBowl(cx, cy, R, bulb) {
      paintDisc(B, cx, cy, R, function (i, k, t, dx, dy) {
        // concave parabolic chrome: fake horizon band + facet rings
        var band = env(4 + dy * 10 + t * 3), facet = 0.85 + 0.15 * Math.cos(t * 26);
        var v = (60 + 170 * band * (0.4 + 0.6 * t)) * facet;
        put(B, i, k, [v, v, v + 6], { hgt: 0.25 + 0.6 * t * t, rough: 0.07, metal: 1 });
      });
      paintRing(B, cx, cy, R, R + 3 * px, function (i, k) { put(B, i, k, [30, 30, 32], { hgt: 0.9, rough: 0.4 }); });
      if (bulb) paintDisc(B, cx, cy, R * 0.16, function (i, k, t) { put(B, i, k, [235, 232, 220], { hgt: 0.9, rough: 0.1, em: [1 - t * 0.3, 0, 0] }); });
    }
    function projector(cx, cy, R) {
      paintRing(B, cx, cy, R, R * 1.45, function (i, k, t, dx, dy) {
        var band = env(10 + dy / R * 4 + t * 2), v = 70 + 150 * band;
        put(B, i, k, [v, v, v + 5], { hgt: 0.3 + 0.5 * (1 - t), rough: 0.08, metal: 1 });
      });
      paintRing(B, cx, cy, R * 0.98, R * 1.07, function (i, k) { put(B, i, k, [8, 8, 9], { hgt: 0.95, rough: 0.35 }); });
      paintDisc(B, cx, cy, R * 0.98, function (i, k, t, dx, dy) {
        var dome = Math.sqrt(Math.max(0, 1 - t * t)), rim = smooth(0.7, 0.98, t), spec = smooth(0.35, 0, Math.hypot(dx + 0.35, dy + 0.4));
        var c = mixC([22, 26, 34], [120, 130, 150], rim * 0.5 + spec * 0.8);
        put(B, i, k, c, { hgt: 0.6 + dome * 0.4, rough: 0.04, metal: 0, em: [0.85 + 0.15 * dome, 0, 0] });
      });
    }
    function drlStrip(x0, x1, y, thick, curve) {
      boxEach(B, x0 - thick, y - thick * 3 - Math.abs(curve), x1 + thick, y + thick * 3 + Math.abs(curve), function (x, yy, i) {
        var t = clamp01((x - x0) / (x1 - x0)), yc = y + curve * (4 * t * (1 - t)) - curve;
        var d = Math.max(Math.abs(yy - yc) - thick, Math.max(x0 - x, x - x1));
        var k = cov(d);
        if (k > 0) put(B, i, k, [214, 220, 228], { hgt: 0.75, rough: 0.35, metal: 0, em: [0, 1, 0] });
        var glow = cov(d - 2.5 * px) - k;
        if (glow > 0) put(B, i, glow * 0.6, [90, 92, 96], { hgt: 0.7 });
      });
    }
    function indicator(x0, y0, x1, y1) {
      paintBox(B, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 4 * px, function (i, k, d, x, y) {
        var f = 0.8 + 0.2 * Math.cos((x - x0) / (6 * px) * PI);
        put(B, i, k, [190 * f, 118 * f, 30 * f], { hgt: 0.45 + 0.1 * f, rough: 0.12, metal: 0.6, em: [0, 0, 1] });
      });
    }
    /* light guide along a distance field df(x, y) (px to the guide centreline) inside bbox [x0, y0, x1, y1];
       kind 'drl' (white, emissive G), 'amber' (indicator, B) or 'beam' (R). Rounded profile + soft diffuser halo. */
    function guide(bb, df, thick, kind) {
      var col = kind === 'amber' ? [200, 122, 32] : [216, 222, 230], em = kind === 'amber' ? [0, 0, 1] : kind === 'beam' ? [1, 0, 0] : [0, 1, 0], pad = thick + 4 * px;
      boxEach(B, bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad, function (x, y, i) {
        var d = df(x, y) - thick, k = cov(d);
        if (k > 0) {
          var prof = clamp01(-d / Math.max(0.5, thick)), e = 0.82 + 0.18 * prof;
          put(B, i, k, scaleC(col, 0.86 + 0.14 * prof), { hgt: 0.68 + 0.17 * prof, rough: 0.3, metal: 0, em: [em[0] * e, em[1] * e, em[2] * e] });
        }
        var glow = cov(d - 2.5 * px) - k;
        if (glow > 0) put(B, i, glow * 0.6, [90, 92, 96], { hgt: 0.7 });
      });
    }
    /** recessed dark gloss pocket (lamp lens interior) with a thin chrome lip */
    function pocket(cx, cy, hx, hy, rr) {
      paintBox(B, cx, cy, hx, hy, rr, function (i, k, d) {
        var lip = smooth(-3 * px, -0.5 * px, d), v = 6 + 120 * lip;
        put(B, i, k, [v, v, v + 3], { hgt: 0.32 + 0.4 * lip, rough: 0.08 + 0.2 * (1 - lip), metal: lip });
      });
    }
    /** small square LED projector cube (Matrix / slim-LED modules) */
    function ledCube(cx, cy, r) {
      paintBox(B, cx, cy, r * 1.25, r * 1.25, r * 0.35, function (i, k, d) { put(B, i, k, [14, 14, 16], { hgt: 0.45 - 0.15 * smooth(-3 * px, 0, d), rough: 0.35 }); });
      projector(cx, cy, r * 0.62);
    }
    var NEWHL = {
      // Porsche 911 (992): oval lens, chrome bowl, central round projector, four-point LED DRL around it
      'oval-4pt': function () {
        var cx = W * 0.5, cy = H * 0.5, a = W * 0.46, b = H * 0.45;
        boxEach(B, cx - a - 4, cy - b - 4, cx + a + 4, cy + b + 4, function (x, y, i) {
          var d = sdEllipse(x, y, cx, cy, a, b), k = cov(d);
          if (k <= 0) return;
          var t = clamp01(1 + d / (b * 0.55)), band = env(6 + (y - cy) / b * 6 + t * 3);
          var v = (34 + 150 * band * t) * (0.9 + 0.1 * Math.cos(t * 30));
          put(B, i, k, [v, v, v + 5], { hgt: 0.2 + 0.55 * t, rough: 0.08, metal: 0.9 });
          var rim = cov(d + 2.5 * px) * k; if (rim < k) put(B, i, k - rim, [26, 26, 28], { hgt: 0.95, rough: 0.4, metal: 0 });
        });
        boxEach(B, cx - a * 0.62, cy - b * 0.62, cx + a * 0.62, cy + b * 0.62, function (x, y, i) {
          var k = cov(sdEllipse(x, y, cx, cy, a * 0.56, b * 0.56)); if (k > 0) put(B, i, k, [10, 10, 12], { hgt: 0.3, rough: 0.2, metal: 0.2 });
        });
        projector(cx, cy, H * 0.17);
        var ox = a * 0.58, oy = b * 0.62, L = H * 0.07;
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
          var px0 = cx + s[0] * ox, py0 = cy + s[1] * oy, dx = s[0] * L * 0.8, dy = s[1] * L * 0.6;
          guide([px0 - L, py0 - L, px0 + L, py0 + L], function (x, y) { return sdSeg(x, y, px0 - dx, py0 - dy, px0 + dx, py0 + dy); }, 4.5 * px, 'drl');
        });
        var thr = cx + a * 0.55;
        guide([thr, cy - b, cx + a, cy + b], function (x, y) { return Math.max(Math.abs(sdEllipse(x, y, cx, cy, a * 0.86, b * 0.8)), thr - x); }, 3 * px, 'amber');
      },
      // Toyota GR Supra & co: twin projectors with a C-shaped DRL bracket wrapping the outboard lens
      'c-clamp': function () {
        pocket(W * 0.47, H * 0.52, W * 0.4, H * 0.36, 26 * px);
        projector(W * 0.3, H * 0.54, H * 0.2);
        projector(W * 0.6, H * 0.54, H * 0.2);
        var ccx = W * 0.6, ccy = H * 0.54, R = H * 0.33;
        guide([ccx - R, ccy - R, ccx + R, ccy + R], function (x, y) { return sdArc(x, y, ccx, ccy, R, -PI * 0.62, PI * 0.62); }, 4.5 * px, 'drl');
        guide([W * 0.12, H * 0.12, ccx, H * 0.24], function (x, y) { return sdSeg(x, y, W * 0.12, H * 0.2, ccx + Math.cos(-PI * 0.62) * R, ccy + Math.sin(-PI * 0.62) * R); }, 3.5 * px, 'drl');
        indicator(W * 0.9, H * 0.22, W * 0.97, H * 0.82);
      },
      // Lamborghini Huracan: slim dark lamp crossed by a Y-shaped DRL blade
      'y-blade': function () {
        pocket(W * 0.5, H * 0.5, W * 0.46, H * 0.3, 18 * px);
        [[0.7, 0.5], [0.84, 0.5], [0.24, 0.66]].forEach(function (p) { ledCube(W * p[0], H * p[1], H * 0.06); });
        var sx = W * 0.07, jx = W * 0.44, cy = H * 0.5;
        guide([sx, H * 0.2, W * 0.95, H * 0.8], function (x, y) {
          return Math.min(sdSeg(x, y, sx, cy, jx, cy), sdSeg(x, y, jx, cy, W * 0.93, H * 0.24), sdSeg(x, y, jx, cy, W * 0.93, H * 0.76));
        }, 4 * px, 'drl');
        guide([W * 0.14, H * 0.22, W * 0.38, H * 0.26], function (x, y) { return sdSeg(x, y, W * 0.14, H * 0.25, W * 0.38, H * 0.25); }, 2.5 * px, 'amber');
      },
      // classic / Mini / G-Class / Bronco: round reflector with a projector core and a full LED halo ring
      'round-halo': function () {
        var cx = W * 0.44, cy = H * 0.5, R = H * 0.4;
        chromeBowl(cx, cy, R, false);
        projector(cx, cy, R * 0.34);
        paintRing(B, cx, cy, R * 1.07, R * 1.14, function (i, k, t) {
          var prof = Math.sin(clamp01(t) * PI);
          put(B, i, k, [210 + 16 * prof, 216 + 14 * prof, 226 + 10 * prof], { hgt: 0.7 + 0.2 * prof, rough: 0.3, em: [0, 0.75 + 0.25 * prof, 0] });
        });
        paintRing(B, cx, cy, R * 1.14, R * 1.2, function (i, k) { put(B, i, k, [176, 178, 184], { hgt: 0.95, rough: 0.12, metal: 1 }); });
        paintDisc(B, W * 0.86, cy, H * 0.13, function (i, k, t) {
          var f = 0.85 + 0.15 * Math.cos(t * 18);
          put(B, i, k, [196 * f, 120 * f, 32 * f], { hgt: 0.5 + 0.2 * (1 - t), rough: 0.12, metal: 0.5, em: [0, 0, 1 - t * 0.3] });
        });
      },
      // VW ID. Buzz / Cybertruck / Raptor: thin full-width LED slit over a hidden row of LED cubes
      'slim-led': function () {
        pocket(W * 0.5, H * 0.6, W * 0.47, H * 0.2, 10 * px);
        for (var c = 0; c < 7; c++) ledCube(W * (0.11 + c * 0.13), H * 0.6, H * 0.065);
        guide([W * 0.02, H * 0.26, W * 0.98, H * 0.3], function (x, y) { return sdSeg(x, y, W * 0.03, H * 0.28, W * 0.97, H * 0.28); }, 3.5 * px, 'drl');
        guide([W * 0.84, H * 0.86, W * 0.97, H * 0.88], function (x, y) { return sdSeg(x, y, W * 0.84, H * 0.87, W * 0.97, H * 0.87); }, 3 * px, 'amber');
      },
      // twin equal projectors + swept DRL with an outboard hook (modern premium saloon)
      'projector-twin': function () {
        pocket(W * 0.47, H * 0.5, W * 0.36, H * 0.3, 30 * px);
        projector(W * 0.3, H * 0.5, H * 0.2);
        projector(W * 0.62, H * 0.5, H * 0.2);
        var pts = [W * 0.06, H * 0.9, W * 0.5, H * 0.88, W * 0.82, H * 0.78, W * 0.88, H * 0.46, W * 0.86, H * 0.16];
        guide([W * 0.04, H * 0.12, W * 0.9, H * 0.92], function (x, y) { return sdPoly(x, y, pts); }, 4 * px, 'drl');
        guide([W * 0.18, H * 0.08, W * 0.78, H * 0.1], function (x, y) { return sdSeg(x, y, W * 0.18, H * 0.09, W * 0.78, H * 0.09); }, 2.5 * px, 'amber');
      },
      // Skyline / quad-projector: four round lamps in a row, each with a thin halo
      'quad-round': function () {
        for (var q = 0; q < 4; q++) {
          var cx = W * (0.125 + q * 0.25), cy = H * 0.5, R = H * 0.2;
          if (q & 1) { projector(cx, cy, R * 0.66); } else chromeBowl(cx, cy, R * 0.92, true);
          paintRing(B, cx, cy, R * 1.04, R * 1.12, function (i, k) { put(B, i, k, [214, 220, 230], { hgt: 0.8, rough: 0.3, em: [0, 1, 0] }); });
        }
        guide([W * 0.7, H * 0.9, W * 0.98, H * 0.92], function (x, y) { return sdSeg(x, y, W * 0.72, H * 0.91, W * 0.97, H * 0.91); }, 2.5 * px, 'amber');
      },
      // BMW M4 / Ferrari: stacked horizontal LED blades (tapered toward inboard) beside two small projectors
      'blade': function () {
        pocket(W * 0.5, H * 0.5, W * 0.47, H * 0.42, 14 * px);
        ledCube(W * 0.15, H * 0.32, H * 0.1); ledCube(W * 0.15, H * 0.68, H * 0.1);
        for (var b = 0; b < 4; b++) {
          var y0 = H * (0.2 + b * 0.2), xa = W * (0.3 + b * 0.04), xb = W * 0.95, th = (b === 3 ? 3 : 4.5) * px;
          (function (y0, xa, xb, th, amber) {
            guide([xa, y0 - th, xb, y0 + th], function (x, y) {
              var t = clamp01((x - xa) / (xb - xa));
              return sdSeg(x, y, xa, y0, xb, y0) + th * 0.55 * (1 - t);
            }, th, amber ? 'amber' : 'drl');
          })(y0, xa, xb, th, b === 3);
        }
      }
    };
    if (Object.prototype.hasOwnProperty.call(NEWHL, style)) NEWHL[style]();
    else if (style === 'reflector') {
      chromeBowl(W * 0.28, H * 0.5, H * 0.38, true); chromeBowl(W * 0.66, H * 0.5, H * 0.32, true);
      indicator(W * 0.86, H * 0.25, W * 0.97, H * 0.75);
    } else if (style === 'round') {
      chromeBowl(W * 0.5, H * 0.5, H * 0.42, true);
      paintRing(B, W * 0.5, H * 0.5, H * 0.44, H * 0.47, function (i, k) { put(B, i, k, [220, 226, 236], { hgt: 0.8, rough: 0.3, em: [0, 1, 0] }); });
      indicator(W * 0.84, H * 0.3, W * 0.95, H * 0.7);
    } else if (style === 'led' || style === 'matrix' || style === 'laser') {
      var NM = style === 'matrix' ? 6 : 4, mw = W * 0.62 / NM;
      for (var m = 0; m < NM; m++) {
        var mx = W * 0.12 + mw * (m + 0.5);
        paintBox(B, mx, H * 0.48, mw * 0.44, H * 0.2, 6 * px, function (i, k, d) { put(B, i, k, [10, 10, 11], { hgt: 0.5 - 0.2 * smooth(-4, 0, d), rough: 0.4 }); });
        projector(mx, H * 0.48, Math.min(mw * 0.3, H * 0.14));
      }
      drlStrip(W * 0.08, W * 0.8, H * 0.2, 3.5 * px, -H * 0.04);
      drlStrip(W * 0.08, W * 0.74, H * 0.8, 2.5 * px, H * 0.03);
      if (style === 'laser') paintBox(B, W * 0.42, H * 0.67, W * 0.3, 2.2 * px, 2 * px, function (i, k) { put(B, i, k, [30, 90, 230], { hgt: 0.7, rough: 0.2, metal: 0.8 }); });
      indicator(W * 0.84, H * 0.36, W * 0.96, H * 0.64);
    } else {
      // projector (default): main + high-beam projectors in chrome cups, swept DRL guide
      projector(W * 0.3, H * 0.55, H * 0.25);
      projector(W * 0.6, H * 0.57, H * 0.18);
      drlStrip(W * 0.06, W * 0.84, H * 0.18, 4 * px, -H * 0.05);
      boxEach(B, W * 0.8, H * 0.16, W * 0.86, H * 0.88, function (x, y, i) {
        var d = Math.max(Math.abs(x - W * 0.83) - 3.5 * px, Math.max(H * 0.18 - y, y - H * 0.86));
        var k = cov(d); if (k > 0) put(B, i, k, [214, 220, 228], { hgt: 0.75, rough: 0.35, em: [0, 1, 0] });
      });
      indicator(W * 0.88, H * 0.3, W * 0.97, H * 0.8);
    }
    var res = finishBuf(B, { emissive: true });
    res.strength = 1.2 * px; res.wrap = 'clamp'; res.aniso = 8;
    res.layout = 'u 0 inboard..1 outboard, v 0 top, CLAMP; emissive R beams, G DRL, B indicator';
    res.info = { style: style };
    return res;
  });

  /* ------------------------------------------------------------- taillight
     taillight: lens + interior in one map, 2:1, CLAMP, u = 0 inboard .. 1 outboard, v = 0 top.
     Deep red lens with a fine hexagonal prism (normal), visible LED rows, reverse (clear) and
     indicator zones. opts.style 'cluster' (default; also any unknown value), 'bar' (full-width
     light bar + blocks), 'ring' (twin round rings), 'blade' (stacked 3D blades). Real-car styles
     on a dark smoked housing: 'light-bar' (911 992 / Raptor: thin full-width bar + outboard
     corner block), 'c-ring' (C-shaped light guide around reverse), 'round-ring' (Skyline /
     Ferrari: twin round lamps with guide rings), 'slim' (thin horizontal slit), 'full-width'
     (lens filling the whole box with stacked light lines), 'y-shape' (Huracan Y guide),
     'vertical' (pickup / van / Volvo vertical strips), 'quad-round' (four round lamps).
     opts.smoked darkens the lens. Emissive channel: R = tail + brake, G = reverse, B = indicator. */
  registerFamily('taillight', ['albedo', 'normal', 'orm', 'emissive'], function (o) {
    var W = o.size || S(512, 128), H = W >> 1, n = W * H, px = W / 512, style = o.style || 'cluster';
    var smoked = o.smoked ? 0.55 : 1, RED = [92 * smoked, 8 * smoked, 10 * smoked];
    var B = MatBuf(W, H, { color: RED, hgt: 0.5, rough: 0.06 });
    // hex prism lens over everything
    var hx = 9 * px, hy = hx * 0.8660254 * 2, prism = F32(n);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var row = Math.floor(y / (hy / 2)), ox = (row & 1) ? hx : 0, cx = Math.round((x - ox) / (2 * hx)) * 2 * hx + ox, cy = (row + 0.5) * hy / 2;
      var dx = (x - cx) / hx, dy = (y - cy) / (hy / 2), t = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      prism[y * W + x] = 1 - t * t;
    }
    function zone(cx, cy, hw, hh, rr, kind) {
      paintBox(B, cx, cy, hw, hh, rr, function (i, k, d, x, y) {
        var inner = smooth(0, -6 * px, d);
        if (kind === 'red') {
          var lx = fract(x / (14 * px)), ly = fract(y / (14 * px)), led = Math.hypot(lx - 0.5, ly - 0.5);
          var dot = smooth(0.32, 0.18, led);
          put(B, i, k, mixC([118 * smoked, 12, 14], [190 * smoked, 30, 30], dot * 0.6), { hgt: 0.55, rough: 0.06, em: [0.45 + 0.55 * dot * inner, 0, 0] });
        } else if (kind === 'reverse') {
          var band = 0.7 + 0.3 * Math.cos((y - cy) / hh * 3);
          put(B, i, k, [168 * band * smoked, 170 * band * smoked, 176 * band * smoked], { hgt: 0.55, rough: 0.05, metal: 0.4, em: [0, inner, 0] });
        } else {
          put(B, i, k, [150 * smoked, 72 * smoked, 18 * smoked], { hgt: 0.55, rough: 0.06, metal: 0.2, em: [0, 0, inner] });
        }
        var frame = smooth(-3 * px, 0, d) * k;
        if (frame > 0) put(B, i, frame * 0.7, [20, 4, 5], { hgt: 0.3 });
      });
    }
    /** dark smoked housing behind the lens (black-out cluster); fills the whole map */
    function darkBase() {
      for (var q = 0; q < n; q++) {
        var nn = hash2(q % W, (q / W) | 0, 37) - 0.5;
        B.r[q] = (30 + nn * 3) * smoked; B.g[q] = (7 + nn) * smoked; B.b[q] = (9 + nn) * smoked; B.hgt[q] = 0.45; B.rough[q] = 0.07;
      }
    }
    /** light guide along distance field df (px to centreline) in bbox; kind 'red' (R), 'reverse' (G), 'amber' (B) */
    function tguide(bb, df, thick, kind) {
      var col = kind === 'reverse' ? [196, 198, 204] : kind === 'amber' ? [196, 104, 26] : [214, 40, 40];
      var em = kind === 'reverse' ? [0, 1, 0] : kind === 'amber' ? [0, 0, 1] : [1, 0, 0], pad = thick + 5 * px;
      boxEach(B, bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad, function (x, y, i) {
        var d = df(x, y) - thick, k = cov(d);
        if (k > 0) {
          var prof = clamp01(-d / Math.max(0.5, thick)), e = 0.8 + 0.2 * prof;
          put(B, i, k, scaleC(col, (0.82 + 0.18 * prof) * (kind === 'red' ? smoked : 1)), { hgt: 0.6 + 0.3 * prof, rough: 0.05, em: [em[0] * e, em[1] * e, em[2] * e] });
        }
        var glow = cov(d - 4 * px) - k;
        if (glow > 0 && kind === 'red') put(B, i, glow * 0.5, [120 * smoked, 14, 16], { em: [0.25, 0, 0] });
      });
    }
    /** round lamp: chrome bezel, red LED-dotted body, bright guide ring; centre 'red' | 'reverse' | 'amber' | 'dark' */
    function roundLamp(cx, cy, R, centre) {
      paintRing(B, cx, cy, R, R * 1.1, function (i, k, t) { var v = 90 + 110 * Math.sin(t * PI); put(B, i, k, [v, v * 0.96, v * 0.96], { hgt: 0.8, rough: 0.1, metal: 1 }); });
      zone(cx, cy, R, R, R, 'red');
      tguide([cx - R, cy - R, cx + R, cy + R], function (x, y) { return Math.abs(Math.hypot(x - cx, y - cy) - R * 0.78); }, Math.max(2, R * 0.07), 'red');
      if (centre === 'dark') paintDisc(B, cx, cy, R * 0.3, function (i, k, t) { var v = 30 + 60 * t; put(B, i, k, [v, v * 0.3, v * 0.32], { hgt: 0.3, rough: 0.08, metal: 0.8 }); });
      else if (centre !== 'red') zone(cx, cy, R * 0.32, R * 0.32, R * 0.32, centre);
    }
    var NEWTL = {
      // 911 (992) / Raptor: full-width thin light bar running across, solid corner blocks outboard
      'light-bar': function () {
        darkBase();
        tguide([0, H * 0.24, W, H * 0.3], function (x, y) { return Math.abs(y - H * 0.27); }, 4 * px, 'red');
        zone(W * 0.78, H * 0.6, W * 0.19, H * 0.2, 6 * px, 'red');
        zone(W * 0.5, H * 0.66, W * 0.07, H * 0.12, 4 * px, 'reverse');
        zone(W * 0.2, H * 0.66, W * 0.14, H * 0.05, 3 * px, 'amber');
      },
      // C-shaped light guide (opening inboard) around a reverse lamp
      'c-ring': function () {
        darkBase();
        var cx = W * 0.6, cy = H * 0.5, R = H * 0.36;
        tguide([cx - R, cy - R, cx + R, cy + R], function (x, y) { return sdArc(x, y, cx, cy, R, -PI * 0.72, PI * 0.72); }, 6 * px, 'red');
        tguide([W * 0.05, H * 0.1, cx, H * 0.3], function (x, y) { return sdSeg(x, y, W * 0.06, H * 0.2, cx + Math.cos(-PI * 0.72) * R, cy + Math.sin(-PI * 0.72) * R); }, 4 * px, 'red');
        zone(cx, cy, R * 0.45, R * 0.3, 4 * px, 'reverse');
        zone(W * 0.2, H * 0.72, W * 0.13, H * 0.06, 4 * px, 'amber');
      },
      // Skyline / Ferrari: twin round lamps with bright guide rings
      'round-ring': function () {
        darkBase();
        roundLamp(W * 0.27, H * 0.5, H * 0.38, 'reverse');
        roundLamp(W * 0.71, H * 0.5, H * 0.38, 'dark');
        zone(W * 0.94, H * 0.5, W * 0.025, H * 0.22, 4 * px, 'amber');
      },
      // thin horizontal slit lamp (with a reverse + indicator section)
      'slim': function () {
        darkBase();
        tguide([W * 0.03, H * 0.4, W * 0.7, H * 0.48], function (x, y) { return sdSeg(x, y, W * 0.04, H * 0.44, W * 0.7, H * 0.44); }, H * 0.05, 'red');
        zone(W * 0.79, H * 0.44, W * 0.06, H * 0.045, 3 * px, 'reverse');
        zone(W * 0.92, H * 0.44, W * 0.05, H * 0.045, 3 * px, 'amber');
        tguide([W * 0.08, H * 0.62, W * 0.62, H * 0.64], function (x, y) { return sdSeg(x, y, W * 0.08, H * 0.63, W * 0.62, H * 0.63); }, 1.5 * px, 'red');
      },
      // wide lamp filling the whole box: red lens with stacked fine light lines, inboard reverse, bottom indicator
      'full-width': function () {
        zone(W * 0.5, H * 0.5, W * 0.49, H * 0.47, 12 * px, 'red');
        for (var l = 0; l < 6; l++) (function (yy) {
          tguide([W * 0.2, yy - 4, W * 0.97, yy + 4], function (x, y) { return sdSeg(x, y, W * 0.22, yy, W * 0.96, yy); }, 2.5 * px, 'red');
        })(H * (0.14 + l * 0.12));
        zone(W * 0.1, H * 0.42, W * 0.07, H * 0.3, 6 * px, 'reverse');
        zone(W * 0.6, H * 0.88, W * 0.36, H * 0.04, 3 * px, 'amber');
      },
      // Huracan: Y-shaped light guide (stem outboard, arms reaching inboard)
      'y-shape': function () {
        darkBase();
        var sx = W * 0.95, jx = W * 0.56, cy = H * 0.5;
        tguide([W * 0.08, H * 0.12, W, H * 0.88], function (x, y) {
          return Math.min(sdSeg(x, y, sx, cy, jx, cy), sdSeg(x, y, jx, cy, W * 0.1, H * 0.16), sdSeg(x, y, jx, cy, W * 0.1, H * 0.84));
        }, 6 * px, 'red');
        zone(W * 0.26, cy, W * 0.08, H * 0.06, 4 * px, 'reverse');
        zone(W * 0.78, H * 0.78, W * 0.1, H * 0.04, 3 * px, 'amber');
      },
      // pickup / van / Volvo: vertical light strips
      'vertical': function () {
        darkBase();
        zone(W * 0.3, H * 0.5, W * 0.27, H * 0.46, 8 * px, 'red');
        for (var s = 0; s < 4; s++) (function (xx) {
          tguide([xx - 4, H * 0.08, xx + 4, H * 0.92], function (x, y) { return sdSeg(x, y, xx, H * 0.1, xx, H * 0.9); }, 4 * px, 'red');
        })(W * (0.1 + s * 0.135));
        zone(W * 0.7, H * 0.5, W * 0.08, H * 0.46, 6 * px, 'reverse');
        zone(W * 0.89, H * 0.5, W * 0.08, H * 0.46, 6 * px, 'amber');
      },
      // four round lamps in a row (R32-R34 Skyline style)
      'quad-round': function () {
        darkBase();
        for (var q = 0; q < 4; q++) roundLamp(W * (0.125 + q * 0.25), H * 0.5, H * 0.21, q === 1 ? 'reverse' : q === 3 ? 'amber' : 'red');
      }
    };
    if (Object.prototype.hasOwnProperty.call(NEWTL, style)) NEWTL[style]();
    else if (style === 'bar') {
      zone(W * 0.5, H * 0.16, W * 0.48, H * 0.06, 4 * px, 'red');
      zone(W * 0.36, H * 0.56, W * 0.3, H * 0.22, 10 * px, 'red');
      zone(W * 0.78, H * 0.56, W * 0.08, H * 0.22, 8 * px, 'reverse');
      zone(W * 0.93, H * 0.56, W * 0.04, H * 0.22, 6 * px, 'amber');
    } else if (style === 'ring') {
      [[0.28, 'reverse'], [0.7, 'amber']].forEach(function (p) {
        var cx = W * p[0], cy = H * 0.5, R = H * 0.4;
        paintRing(B, cx, cy, R * 0.62, R, function (i, k, t) {
          var prof = Math.sin(t * PI);
          put(B, i, k, [150 * smoked, 18, 20], { hgt: 0.5 + 0.4 * prof, rough: 0.05, em: [0.5 + 0.5 * prof, 0, 0] });
        });
        paintDisc(B, cx, cy, R * 0.62, function (i, k, t) { var v = 40 + 120 * t; put(B, i, k, [v, v * 0.4, v * 0.42], { hgt: 0.25 + t * 0.2, rough: 0.08, metal: 0.8 }); });
        paintDisc(B, cx, cy, R * 0.22, function (i, k, t) {
          if (p[1] === 'reverse') put(B, i, k, [200, 200, 206], { hgt: 0.7, rough: 0.05, em: [0, 1 - t * 0.3, 0] });
          else put(B, i, k, [190, 100, 24], { hgt: 0.7, rough: 0.05, em: [0, 0, 1 - t * 0.3] });
        });
      });
    } else if (style === 'blade') {
      for (var b = 0; b < 5; b++) {
        var by = H * (0.16 + b * 0.13), len = W * (0.44 - b * 0.03);
        paintBox(B, W * 0.5 + (W * 0.44 - len) * 0.5, by, len, H * 0.028, 3 * px, function (i, k, d, x) {
          var g = clamp01((x - W * 0.06) / (W * 0.9));
          put(B, i, k, [200 * smoked, 28, 28], { hgt: 0.85, rough: 0.05, em: [0.55 + 0.45 * g, 0, 0] });
        });
      }
      zone(W * 0.3, H * 0.86, W * 0.12, H * 0.07, 4 * px, 'reverse');
      zone(W * 0.72, H * 0.86, W * 0.16, H * 0.07, 4 * px, 'amber');
    } else {
      zone(W * 0.32, H * 0.5, W * 0.28, H * 0.4, 18 * px, 'red');
      zone(W * 0.7, H * 0.32, W * 0.08, H * 0.22, 8 * px, 'amber');
      zone(W * 0.7, H * 0.76, W * 0.08, H * 0.14, 8 * px, 'reverse');
      zone(W * 0.88, H * 0.5, W * 0.08, H * 0.4, 10 * px, 'red');
    }
    for (var j = 0; j < n; j++) B.hgt[j] += prism[j] * 0.05;
    var res = finishBuf(B, { emissive: true });
    res.strength = 1.6 * px; res.wrap = 'clamp'; res.aniso = 8;
    res.layout = 'u 0 inboard..1 outboard, v 0 top, CLAMP; emissive R tail/brake, G reverse, B indicator';
    res.info = { style: style };
    return res;
  });

  /* ------------------------------------------------------------------ grille
     grille: tileable intake / grille mesh (REPEAT). alpha = solid (1) vs opening (0) with
     coverage-preserving mips for alpha testing at 0.5; openings keep near-black RGB so
     opaque (non-tested) use reads as a deep mesh. ~11 cm per tile.
     opts.pattern 'honeycomb' (default; also any unknown value), 'slats' (horizontal louvres),
     'mesh' (woven diamond wire), 'diamond', 'vertical' (bars). Real-car patterns: 'kidney'
     (BMW: deep bevelled vertical slats, 8 per tile, + cross-tie), 'blanked' (EV closed panel:
     alpha 1 everywhere, faint ribs; finish defaults to 'gloss'), 'seven-slot' (Jeep: tall
     rounded vertical slots, 2 per tile), 'hex' (Audi / Lamborghini: 3 large chamfered hexagons
     across), 'horseshoe' (Bugatti: tight staggered round-hole mesh), 'split-v' (Lexus spindle /
     Huracan: chevron V fins), 'bar' (pickup: two thick horizontal bars per tile).
     opts.finish 'black' (satin plastic), 'gloss', 'chrome', 'satin' (dark metal).          */
  registerFamily('grille', ['albedo', 'normal', 'orm'], function (o) {
    var GPATS = ['honeycomb', 'slats', 'vertical', 'mesh', 'diamond', 'kidney', 'blanked', 'seven-slot', 'hex', 'horseshoe', 'split-v', 'bar'];
    var W = o.size || S(512, 128), n = W * W, pat = GPATS.indexOf(o.pattern) >= 0 ? o.pattern : 'honeycomb', px = W / 512;
    var fin = o.finish || (pat === 'blanked' ? 'gloss' : 'black');
    var FIN = { black: [[24, 24, 26], 0.5, 0], gloss: [[12, 12, 14], 0.12, 0], chrome: [[222, 224, 228], 0.06, 1], satin: [[78, 80, 84], 0.32, 1] }[fin] || [[24, 24, 26], 0.5, 0];
    var hgt = F32(n), sol = F32(n), shade = F32(n);
    for (var y = 0; y < W; y++) for (var x = 0; x < W; x++) {
      var u = (x + 0.5) / W, v = (y + 0.5) / W, i = y * W + x, s = 0, h = 0, sh = 1;
      if (pat === 'honeycomb') {
        var N = 7, A = W / N / 2, rows = 8, py = W / rows, best = 1e9, bx = 0, by = 0;
        var ry = Math.floor((y + 0.5) / py);
        for (var dr = -1; dr <= 1; dr++) {
          var r2 = ry + dr, off = (mod(r2, 2) === 1) ? A : 0, cyy = (r2 + 0.5) * py;
          var cxx = Math.round((x + 0.5 - off - A) / (2 * A)) * 2 * A + off + A;
          for (var dc = -1; dc <= 1; dc++) {
            var ccx = cxx + dc * 2 * A, ddx = x + 0.5 - ccx, ddy = (y + 0.5 - cyy) * (2 * A * 0.8660254 / py);
            var dd = ddx * ddx + ddy * ddy;
            if (dd < best) { best = dd; bx = ddx; by = ddy; }
          }
        }
        var qx = Math.abs(bx), qy = Math.abs(by), m = Math.max(qx, qx * 0.5 + qy * 0.8660254), t = A * 0.16;
        var e = A - m;
        s = cov(e - t); h = Math.sqrt(clamp01(1 - e / (t * 1.6)));
        sh = 0.8 + 0.2 * (by < 0 ? 1 : 0.6);
      } else if (pat === 'slats') {
        var Ns = 6, f = fract(v * Ns), dsl = (Math.abs(f - 0.4) - 0.3) * W / Ns;
        s = cov(dsl); var tt = clamp01((f - 0.1) / 0.6); h = Math.sin(tt * PI) * 0.6 + 0.4 * (1 - tt); sh = 0.7 + 0.45 * (1 - tt);
      } else if (pat === 'vertical') {
        var Nv = 10, fv = fract(u * Nv), dv = (Math.abs(fv - 0.5) - 0.2) * W / Nv;
        s = cov(dv); h = Math.sqrt(clamp01(1 - Math.pow((fv - 0.5) / 0.2, 2))); sh = 0.75 + 0.35 * h;
      } else if (pat === 'kidney') {
        // BMW kidney: deep vertical slats (8 per tile) with a bright leading bevel + one recessed cross-tie
        var Nk = 8, fk = fract(u * Nk), dk = (Math.abs(fk - 0.5) - 0.17) * W / Nk, tie = (Math.abs(fract(v) - 0.5) - 0.47) * W;
        var sk = cov(dk), pk = clamp01((fk - 0.33) / 0.34);
        s = Math.max(sk, cov(-tie));
        h = sk > 0 ? 0.55 + 0.45 * Math.sin(pk * PI) : 0.35; sh = sk > 0 ? 0.6 + 0.65 * (1 - pk) : 0.7;
      } else if (pat === 'blanked') {
        // EV closed panel: solid everywhere, faint shallow ribs + very subtle dimple texture
        var rib = Math.sin(v * 16 * TAU), dim = Math.cos(u * 32 * TAU) * Math.cos(v * 32 * TAU);
        s = 1; h = 0.5 + 0.035 * rib + 0.012 * dim; sh = 0.95 + 0.04 * rib;
      } else if (pat === 'seven-slot') {
        // Jeep: tall rounded vertical slots (openings) punched through a solid panel, 2 per tile
        var Nj = 2, cxj = (Math.floor(u * Nj) + 0.5) / Nj, hwj = 0.17 / Nj, hhj = 0.42;
        var dj = sdRoundBox(x + 0.5, y + 0.5, cxj * W, W * 0.5, hwj * W, hhj * W, hwj * W * 0.9);
        s = cov(-dj); var bev = clamp01(dj / (W * 0.035)); h = 0.4 + 0.6 * Math.sqrt(bev); sh = 0.75 + 0.3 * bev;
      } else if (pat === 'hex') {
        // large hexagons (Audi / Lamborghini): 3 cells across, thick chamfered frames
        var Nh = 3, Ah = W / Nh / 2, rowsH = 4, pyh = W / rowsH, bestH = 1e9, bxh = 0, byh = 0, ryh = Math.floor((y + 0.5) / pyh);
        for (var drh = -1; drh <= 1; drh++) {
          var r2h = ryh + drh, offh = (mod(r2h, 2) === 1) ? Ah : 0, cyh = (r2h + 0.5) * pyh;
          var cxh = Math.round((x + 0.5 - offh - Ah) / (2 * Ah)) * 2 * Ah + offh + Ah;
          for (var dch = -1; dch <= 1; dch++) {
            var exh = x + 0.5 - (cxh + dch * 2 * Ah), eyh = (y + 0.5 - cyh) * (2 * Ah * 0.8660254 / pyh), ddh = exh * exh + eyh * eyh;
            if (ddh < bestH) { bestH = ddh; bxh = exh; byh = eyh; }
          }
        }
        var mh = Math.max(Math.abs(bxh), Math.abs(bxh) * 0.5 + Math.abs(byh) * 0.8660254), eh = Ah - mh, th = Ah * 0.13;
        s = cov(eh - th); var pf = clamp01(eh / th);
        h = 1 - 0.65 * pf * pf; sh = 0.72 + 0.45 * (byh < 0 ? 1 - 0.3 * pf : 0.45 * (1 - pf));
      } else if (pat === 'horseshoe') {
        // Bugatti horseshoe: tight staggered round-hole (macaron) mesh, 14 holes across
        var Nm = 14, rowm = Math.floor(v * Nm), offm = (rowm & 1) ? 0.5 : 0, fxm = fract(u * Nm + offm) - 0.5, fym = fract(v * Nm) - 0.5;
        var rm = Math.sqrt(fxm * fxm + fym * fym), dm = (0.36 - rm) * W / Nm;
        s = cov(dm); var rimm = clamp01((rm - 0.36) / 0.14); h = 0.45 + 0.55 * Math.sin(rimm * PI * 0.5); sh = 0.8 + 0.3 * (fym > 0 ? 1 : 0.5) * rimm;
      } else if (pat === 'split-v') {
        // spindle / V-split: chevron fins (2 V's per tile), left / right fin faces lit differently
        var Nf = 6, Nc = 2, kv = 3, tu = Math.abs(fract(u * Nc) - 0.5), ff = fract(v * Nf + tu * kv);
        var gv = Math.sqrt(Nf * Nf + kv * kv * Nc * Nc) / W, dvf = (Math.abs(ff - 0.4) - 0.24) / gv;
        s = cov(dvf); var tf = clamp01((ff - 0.16) / 0.48); h = 0.4 + 0.6 * Math.sin(tf * PI);
        sh = (fract(u * Nc) < 0.5 ? 0.95 : 0.7) + 0.25 * (1 - tf);
      } else if (pat === 'bar') {
        // pickup bar grille: two thick horizontal bars per tile with rounded top / bottom edges
        var Nb = 2, fb = fract(v * Nb), db = (Math.abs(fb - 0.5) - 0.28) * W / Nb;
        s = cov(db); var tb = clamp01((fb - 0.22) / 0.56), edge = smooth(0, 0.3, tb) * smooth(1, 0.7, tb);
        h = 0.25 + 0.75 * Math.sqrt(edge); sh = 0.65 + 0.45 * (tb < 0.5 ? 1 : 0.6) * (0.5 + 0.5 * edge);
      } else {
        // mesh (woven wire) / diamond (stamped bars): two diagonal families
        var Nd = pat === 'mesh' ? 8 : 6, a1 = fract(u * Nd + v * Nd), a2 = fract(u * Nd - v * Nd), hw = pat === 'mesh' ? 0.11 : 0.09;
        var g = Nd * 1.41421356 / W, d1 = (Math.abs(a1 - 0.5) - (0.5 - hw)) / g, d2 = (Math.abs(a2 - 0.5) - (0.5 - hw)) / g;
        // wire centre lines are at a == 0 (|a - .5| = .5)
        var w1 = cov(-d1), w2 = cov(-d2);
        var p1 = 1 - Math.pow(clamp01((0.5 - Math.abs(a1 - 0.5)) / hw), 2), p2 = 1 - Math.pow(clamp01((0.5 - Math.abs(a2 - 0.5)) / hw), 2);
        var over = pat === 'mesh' ? ((Math.floor(u * Nd + v * Nd) + Math.floor(u * Nd - v * Nd)) & 1) : 0;
        var h1 = Math.sqrt(Math.max(0, p1)) * (over ? 1 : 0.75), h2 = Math.sqrt(Math.max(0, p2)) * (over ? 0.75 : 1);
        s = Math.max(w1, w2); h = Math.max(w1 * h1, w2 * h2); sh = 0.75 + 0.3 * h;
      }
      sol[i] = s; hgt[i] = s * (0.3 + 0.7 * h); shade[i] = sh;
    }
    var alb = new Uint8ClampedArray(n * 4), ao = aoFromHeight(hgt, W, W, Math.max(2, 3 * px | 0), 2.4, true), rough = F32(n), metal = F32(n);
    for (var j = 0; j < n; j++) {
      var c = FIN[0], k = sol[j], sh2 = shade[j], hole = 7;
      alb[j * 4] = lerp(hole, c[0] * sh2, k); alb[j * 4 + 1] = lerp(hole, c[1] * sh2, k); alb[j * 4 + 2] = lerp(hole + 1, c[2] * sh2, k); alb[j * 4 + 3] = k * 255;
      rough[j] = lerp(0.9, FIN[1], k); metal[j] = FIN[2] * k; ao[j] = lerp(0.15, ao[j], k);
    }
    return { w: W, h: W, albedo: alb, height: hgt, strength: 1.6 * px, orm: packORM(W, W, ao, rough, metal), wrap: 'repeat', aniso: 16,
      alphaCov: 0.5, plainRGB: true, layout: 'REPEAT; alpha 1 solid / 0 opening (alpha test 0.5)', info: { pattern: pat, finish: fin } };
  });

  /* ---------------------------------------------------------------- leather
     leather: upholstery hide (REPEAT, ~15 cm per tile). Cellular grain creases, low-frequency
     hide variation. opts.color (default '#2b2420'), opts.style 'smooth' | 'perforated'
     (diagonal hole grid) | 'quilted' (diamond quilt with contrast stitching, opts.stitch).  */
  registerFamily('leather', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), n = W * W, px = W / 512, style = o.style || 'smooth';
    var col = parseColor(o.color || '#2b2420'), stc = parseColor(o.stitch || '#cdb68a');
    var hide = noiseField(128, 128, 3, 3, 4, 101), wo = {};
    var hgt = F32(n), tone = F32(n), rough = F32(n), thread = F32(n);
    for (var y = 0; y < W; y++) for (var x = 0; x < W; x++) {
      var u = (x + 0.5) / W, v = (y + 0.5) / W, i = y * W + x;
      worley(u, v, 46, 102, wo);
      var crease = smooth(0, 0.16, wo.f2 - wo.f1), pebble = 1 - wo.f1 * 0.6;
      var hv = 0.55 + 0.25 * crease * pebble, hd = sampleField(hide, u, v) - 0.5, tn = 0.9 + 0.12 * crease + hd * 0.16, rg = 0.5 + (1 - crease) * 0.12 - hd * 0.05;
      if (style === 'perforated') {
        var Np = 22, fu = u * Np, fv = v * Np, ix = Math.floor(fu), iy = Math.floor(fv);
        if ((ix + iy) & 1) { var dd = Math.hypot(fract(fu) - 0.5, fract(fv) - 0.5) * W / Np, k = cov(dd - 3.2 * px); hv -= k * 0.5; tn *= 1 - k * 0.85; hv -= smooth(6 * px, 3 * px, dd) * 0.08; }
      } else if (style === 'quilted') {
        var Nq = 3, a1 = fract(u * Nq + v * Nq), a2 = fract(u * Nq - v * Nq), e1 = Math.min(a1, 1 - a1), e2 = Math.min(a2, 1 - a2), e = Math.min(e1, e2);
        var puff = Math.sin(clamp01(e / 0.5) * PI / 2);
        hv = hv * 0.25 + 0.75 * (0.15 + 0.85 * Math.sqrt(puff));
        tn *= 0.78 + 0.22 * puff;
        // stitch rows either side of each seam: dashed thread
        var sd = W / (Nq * 1.41421356), dpx = Math.abs(e * sd - 7 * px), along = e1 < e2 ? (u * Nq - v * Nq) : (u * Nq + v * Nq);
        var dash = fract(along * 14) < 0.62 ? 1 : 0, ts = cov(dpx - 1.4 * px) * dash;
        thread[i] = ts;
      }
      hgt[i] = hv + thread[i] * 0.12; tone[i] = tn; rough[i] = rg;
    }
    var alb = new Uint8ClampedArray(n * 4), ao = aoFromHeight(hgt, W, W, Math.max(2, 3 * px | 0), 1.8, true);
    for (var j = 0; j < n; j++) {
      var c = mixC(scaleC(col, tone[j]), stc, thread[j]);
      alb[j * 4] = c[0]; alb[j * 4 + 1] = c[1]; alb[j * 4 + 2] = c[2]; alb[j * 4 + 3] = 255;
      rough[j] = lerp(rough[j], 0.7, thread[j]);
    }
    return { w: W, h: W, albedo: alb, height: hgt, strength: style === 'quilted' ? 2.6 * px : 1.1 * px, orm: packORM(W, W, ao, rough, 0), wrap: 'repeat', aniso: 8,
      layout: 'REPEAT, ~0.15 m per tile', info: { style: style } };
  });

  /* -------------------------------------------------------------- alcantara
     alcantara: suede microfibre (REPEAT, ~10 cm per tile): fine fibre noise, nap patches
     where the pile was brushed the other way (lighter/darker), very rough. opts.color.    */
  registerFamily('alcantara', ['albedo', 'normal', 'orm'], function (o) {
    var W = o.size || S(512, 128), n = W * W, col = parseColor(o.color || '#232325');
    var nap = noiseField(64, 64, 3, 3, 3, 111), wn = F32(n);
    for (var i = 0; i < n; i++) wn[i] = hash2(i % W, (i / W) | 0, 112);
    var fib = blurF(wn, W, W, 1, true), alb = new Uint8ClampedArray(n * 4), hgt = F32(n), rough = F32(n);
    for (var j = 0; j < n; j++) {
      var u = (j % W + 0.5) / W, v = ((j / W | 0) + 0.5) / W, np = sampleField(nap, u, v) - 0.5;
      var f = (fib[j] - 0.5) * 2.2 + (wn[j] - 0.5) * 0.5, t = 1 + f * 0.14 + np * 0.22;
      alb[j * 4] = col[0] * t; alb[j * 4 + 1] = col[1] * t; alb[j * 4 + 2] = col[2] * t; alb[j * 4 + 3] = 255;
      hgt[j] = 0.5 + f * 0.25; rough[j] = 0.93 - np * 0.06;
    }
    return { w: W, h: W, albedo: alb, height: hgt, strength: 0.7, orm: packORM(W, W, null, rough, 0), wrap: 'repeat', aniso: 8, layout: 'REPEAT, ~0.1 m per tile' };
  });

  /* ---------------------------------------------------------- tyre sidewall maps
     tireSidewallNormal / tireSidewallOrm: same layout as tireSidewall (u around, v 0 tread
     shoulder .. 1 rim): bulge profile, rim-protector ridge, knurled ring near the bead and
     the raised lettering as relief. Requires a canvas for the lettering.                   */
  function sidewallHeight(o) {
    var W = o.size || S(1024, 256), H = W >> 3, c = makeCanvas(W, H), g = ctx2d(c);
    drawSidewall(g, W, H, o, true);
    var d = g.getImageData(0, 0, W, H).data, hgt = F32(W * H);
    for (var i = 0; i < hgt.length; i++) hgt[i] = d[i * 4] / 255;
    return { W: W, H: H, hgt: hgt };
  }
  GEN.tireSidewallNormal = function (o) {
    var s = sidewallHeight(o || {});
    return { source: { width: s.W, height: s.H, data: heightToNormal(s.hgt, s.W, s.H, 2.4 * s.W / 1024) }, wrapS: 'repeat', wrapT: 'clamp', aniso: 8, linear: true, meta: { family: 'tireSidewall', channel: 'normal' } };
  };
  GEN.tireSidewallOrm = function (o) {
    var s = sidewallHeight(o || {}), ao = aoFromHeight(s.hgt, s.W, s.H, 3, 1.6, true), rough = F32(s.W * s.H);
    for (var i = 0; i < rough.length; i++) rough[i] = s.hgt[i] > 0.78 ? 0.45 : 0.82;   // raised lettering: smoother moulded rubber
    return { source: { width: s.W, height: s.H, data: packORM(s.W, s.H, ao, rough, 0) }, wrapS: 'repeat', wrapT: 'clamp', aniso: 8, linear: true, meta: { family: 'tireSidewall', channel: 'orm' } };
  };
  NEEDS_CANVAS.tireSidewallNormal = true; NEEDS_CANVAS.tireSidewallOrm = true;

  /* ----------------------------------------------------------- asphalt mottle
     asphaltMottle: large-scale 2D variation that breaks up the visible repeat of the 6 m
     asphalt tile. Sample it at a DIFFERENT, non-integer scale (T.ASPHALT_MOTTLE_M = 41 m per
     tile, ~6.83x the base) from world XZ:
        base.rgb *= mix(0.84, 1.16, mottle.r);  rough += (mottle.g - 0.5) * 0.12;
        patch = mottle.b (repaired / fresher tarmac blotches: darken ~12%, a touch smoother).
     Linear, REPEAT, pure pixel math.                                                      */
  GEN.asphaltMottle = function (o) {
    o = o || {};
    var W = o.size || S(512, 128), n = W * W, seed = o.seed == null ? 9 : o.seed;
    var a = noiseField(W, W, 3, 3, 5, seed + 1, 0.55), b = noiseField(W, W, 5, 5, 4, seed + 2, 0.5), p = noiseField(W >> 1, W >> 1, 4, 4, 4, seed + 3, 0.6);
    var d = new Uint8ClampedArray(n * 4), lo = 1, hi = 0, i;
    for (i = 0; i < n; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
    for (i = 0; i < n; i++) {
      var x = i % W, y = (i / W) | 0;
      var r = (a[i] - lo) / Math.max(1e-6, hi - lo);
      var pp = sampleField(p, (x + 0.5) / W, (y + 0.5) / W);
      d[i * 4] = r * 255; d[i * 4 + 1] = clamp01(0.5 + (b[i] - 0.5) * 2.2) * 255;
      d[i * 4 + 2] = smooth(0.66, 0.7, pp) * 255; d[i * 4 + 3] = 255;
    }
    return { source: { width: W, height: W, data: d }, wrapS: 'repeat', wrapT: 'repeat', aniso: 16, linear: true, meta: { family: 'asphalt', channel: 'mottle', tileMeters: 41 } };
  };

  /* ------------------------------------------------------------ getters for cars */
  function famGetter(fam) {
    return function (ctx, o) {
      o = o || {};
      var ch = o.channel || 'albedo';
      if (FAM_CHANNELS[fam].indexOf(ch) < 0) throw new Error('CB.gl.textures.' + fam + ': no "' + ch + '" channel');
      var c = {}; for (var k in o) if (k !== 'channel' && o[k] !== undefined) c[k] = (k === 'color' || k === 'tint' || k === 'hat' || k === 'stitch') ? css(parseColor(o[k])) : o[k];
      return get(ctx, fam + CH_SUFFIX[ch], c);
    };
  }
  function carSet(ctx, fam, o) {
    if (fam === 'tireSidewall' || fam === 'tyreSidewall') {
      return { map: T.tireSidewall(ctx, o), normalMap: hasCanvas() ? get(ctx, 'tireSidewallNormal', { label: o && o.label, size: o && o.size }) : null,
        ormMap: hasCanvas() ? get(ctx, 'tireSidewallOrm', { label: o && o.label, size: o && o.size }) : null, emissiveMap: null, meta: { family: 'tireSidewall' } };
    }
    if (!FAM[fam]) throw new Error('CB.gl.textures.carSet: unknown family "' + fam + '"');
    var g = famGetter(fam), base = {}; o = o || {};
    for (var k in o) if (k !== 'channel') base[k] = o[k];
    function ch(c) { var x = {}; for (var k2 in base) x[k2] = base[k2]; x.channel = c; return g(ctx, x); }
    var set = { map: ch('albedo'), normalMap: ch('normal'), ormMap: ch('orm'), emissiveMap: FAM_CHANNELS[fam].indexOf('emissive') >= 0 ? ch('emissive') : null };
    set.meta = set.map && set.map.meta ? set.map.meta : { family: fam };
    return set;
  }

  /* ------------------------------------------------------------ 1x1 helpers */
  GEN.white = function () { var P = makePixels(1, 1); setPx(P.data, 0, 255, 255, 255, 255); return { source: P, wrapS: 'repeat', wrapT: 'repeat', mips: false }; };
  GEN.black = function () { var P = makePixels(1, 1); setPx(P.data, 0, 0, 0, 0, 255); return { source: P, wrapS: 'repeat', wrapT: 'repeat', mips: false }; };
  GEN.flatNormal = function () { var P = makePixels(1, 1); setPx(P.data, 0, 128, 128, 255, 255); return { source: P, wrapS: 'repeat', wrapT: 'repeat', mips: false, linear: true }; };

  /* ============================================================== GL upload */
  var GL = { TEXTURE_2D: 0x0DE1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, LINEAR: 0x2601, NEAREST: 0x2600, LINEAR_MIPMAP_LINEAR: 0x2703, REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_ALIGNMENT: 0x0CF5, TEXTURE_BINDING_2D: 0x8069, UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243 };
  function K(gl, name) { return gl[name] != null ? gl[name] : GL[name]; }
  function glOf(ctx) {
    if (!ctx) throw new Error('CB.gl.textures: a GL context (CB.gl.createContext result or WebGLRenderingContext) is required');
    if (ctx.gl && typeof ctx.gl.createTexture === 'function') return ctx.gl;
    if (typeof ctx.createTexture === 'function') return ctx;
    throw new Error('CB.gl.textures: object passed is not a GL context');
  }
  var states = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  var wrapGens = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  /**
   * Per-GL-context texture state. Browsers keep the SAME WebGLRenderingContext object across a
   * lost/restored cycle, so a cache keyed by gl alone would hand back dead WebGLTexture handles
   * after restore (white road/grass/crowd/decals). We therefore watch the canvas for
   * webglcontextlost/-restored (capture phase, so we run before the renderer's own restore handler
   * starts re-requesting textures) and also compare the wrapper's ctx.generation when one is passed.
   * A stale state is flushed on the first access after the context is usable again.
   */
  function stateOf(gl, ctx) {
    var st = states ? states.get(gl) : gl.__cbTexState;
    if (!st) {
      st = { cache: Object.create(null), bytes: 0, aniso: undefined, list: [], epoch: 0, stale: false, gen: null, watched: false };
      if (states) states.set(gl, st); else gl.__cbTexState = st;
    }
    if (!st.watched) watchContext(gl, st);
    // generation is tracked per wrapper: renderer3d may build a fresh CB.gl ctx wrapper on restore
    // (its generation restarts at 0), so a single max() would miss later bumps on the new wrapper.
    var gen = ctx && ctx !== gl && typeof ctx.generation === 'number' ? ctx.generation : null;
    if (gen !== null) {
      var seen = wrapGens ? wrapGens.get(ctx) : ctx.__cbTexGen;
      if (seen !== undefined && seen !== gen) st.stale = true;
      if (seen !== gen) { if (wrapGens) wrapGens.set(ctx, gen); else { try { ctx.__cbTexGen = gen; } catch (e0) { /* ignore */ } } }
      st.gen = gen;
    }
    if (st.stale) {
      var lost = false;
      try { lost = typeof gl.isContextLost === 'function' && gl.isContextLost(); } catch (e) { lost = false; }
      if (!lost) resetState(st);
    }
    return st;
  }
  function resetState(st) {
    // old handles belong to the dead context: drop them (deleteTexture on them is a no-op anyway)
    st.cache = Object.create(null); st.bytes = 0; st.list = []; st.aniso = undefined;
    st.stale = false; st.epoch++;
  }
  function watchContext(gl, st) {
    st.watched = true;
    var cv = gl.canvas;
    if (!cv || typeof cv.addEventListener !== 'function') return;
    var mark = function () { st.stale = true; };
    try {
      cv.addEventListener('webglcontextlost', mark, true);
      cv.addEventListener('webglcontextrestored', mark, true);
    } catch (e) { /* ignore */ }
  }
  function anisoExt(gl, st) {
    if (st.aniso === undefined) {
      var ext = null;
      try { ext = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') || gl.getExtension('MOZ_EXT_texture_filter_anisotropic'); } catch (e) { ext = null; }
      var max = 1;
      if (ext) { try { max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT || 0x84FF) || 1; } catch (e2) { max = 1; } }
      st.aniso = ext ? { ext: ext, max: max } : null;
    }
    return st.aniso;
  }
  function isPOT(n) { return n > 0 && (n & (n - 1)) === 0; }
  function isGL2(gl) { return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext; }
  var ANISO_CAP = { low: 2, medium: 4, high: 16, ultra: 16 };

  /**
   * Upload a source (canvas / ImageData / {width,height,data[,levels]}) as a texture.
   * opts: {wrapS, wrapT ('repeat'|'clamp'), mips (default true), aniso, filter ('linear'|'nearest')}
   */
  function upload(ctx, src, opts) {
    var gl = glOf(ctx), st = stateOf(gl, ctx);
    opts = opts || {};
    var tex = gl.createTexture();
    var prev = null;
    try { prev = gl.getParameter(K(gl, 'TEXTURE_BINDING_2D')); } catch (e) { prev = null; }
    var T2 = K(gl, 'TEXTURE_2D'), RGBA = K(gl, 'RGBA'), UB = K(gl, 'UNSIGNED_BYTE');
    gl.bindTexture(T2, tex);
    gl.pixelStorei(K(gl, 'UNPACK_FLIP_Y_WEBGL'), false);
    gl.pixelStorei(K(gl, 'UNPACK_PREMULTIPLY_ALPHA_WEBGL'), false);
    gl.pixelStorei(K(gl, 'UNPACK_ALIGNMENT'), 1);
    if (opts.linear) { try { gl.pixelStorei(K(gl, 'UNPACK_COLORSPACE_CONVERSION_WEBGL'), 0); } catch (e3) { /* ignore */ } }
    var w = src.width, h = src.height, levels = null;
    var isRaw = src.data && !(typeof ImageData !== 'undefined' && src instanceof ImageData);
    if (isRaw && src.levels && opts.mips !== false) levels = src.levels;
    if (levels) {
      for (var l = 0; l < levels.length; l++) {
        var L = levels[l];
        gl.texImage2D(T2, l, RGBA, L.width, L.height, 0, RGBA, UB, toU8(L.data));
      }
    } else if (isRaw) {
      gl.texImage2D(T2, 0, RGBA, w, h, 0, RGBA, UB, toU8(src.data));
    } else {
      gl.texImage2D(T2, 0, RGBA, RGBA, UB, src);
    }
    var pot = isPOT(w) && isPOT(h), gl2 = isGL2(gl);
    var canMip = opts.mips !== false && (pot || gl2) && (w > 1 || h > 1);
    var wrapS = (opts.wrapS === 'repeat' && (pot || gl2)) ? K(gl, 'REPEAT') : K(gl, 'CLAMP_TO_EDGE');
    var wrapT = (opts.wrapT === 'repeat' && (pot || gl2)) ? K(gl, 'REPEAT') : K(gl, 'CLAMP_TO_EDGE');
    if (canMip && !levels) gl.generateMipmap(T2);
    var nearest = opts.filter === 'nearest';
    gl.texParameteri(T2, K(gl, 'TEXTURE_MIN_FILTER'), canMip ? K(gl, 'LINEAR_MIPMAP_LINEAR') : (nearest ? K(gl, 'NEAREST') : K(gl, 'LINEAR')));
    gl.texParameteri(T2, K(gl, 'TEXTURE_MAG_FILTER'), nearest ? K(gl, 'NEAREST') : K(gl, 'LINEAR'));
    gl.texParameteri(T2, K(gl, 'TEXTURE_WRAP_S'), wrapS);
    gl.texParameteri(T2, K(gl, 'TEXTURE_WRAP_T'), wrapT);
    var an = anisoExt(gl, st), wantAniso = Math.min(opts.aniso || 4, ANISO_CAP[quality] || 16);
    if (an && canMip && wantAniso > 1) {
      try { gl.texParameterf(T2, an.ext.TEXTURE_MAX_ANISOTROPY_EXT || 0x84FE, Math.min(an.max, wantAniso)); } catch (e4) { /* ignore */ }
    }
    if (opts.linear) { try { gl.pixelStorei(K(gl, 'UNPACK_COLORSPACE_CONVERSION_WEBGL'), K(gl, 'BROWSER_DEFAULT_WEBGL') || 0x9244); } catch (e5) { /* ignore */ } }
    gl.bindTexture(T2, prev || null);
    var bytes = w * h * 4 * (canMip ? 4 / 3 : 1);
    st.bytes += bytes;
    st.list.push(tex);
    try {
      tex.width = w; tex.height = h; tex.wrapS = opts.wrapS || 'clamp'; tex.wrapT = opts.wrapT || 'clamp';
      tex.bytes = bytes; tex.mipmapped = canMip;
    } catch (e6) { /* non-extensible texture objects in exotic envs */ }
    return tex;
  }
  function toU8(d) { return d instanceof Uint8Array ? d : new Uint8Array(d.buffer, d.byteOffset || 0, d.length); }

  /* ========================================================== cache + API */
  function keyOf(name, opts) {
    var parts = [name, quality];
    if (opts) {
      Object.keys(opts).sort().forEach(function (k) {
        var v = opts[k];
        if (v === undefined || typeof v === 'function') return;
        parts.push(k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
      });
    }
    return parts.join('|');
  }
  var warned = {};
  function warnOnce(msg) {
    if (warned[msg]) return; warned[msg] = true;
    if (typeof console !== 'undefined' && console.warn) console.warn(msg);
  }
  /** cached texture getter */
  function get(ctx, name, opts) {
    var gl = glOf(ctx), st = stateOf(gl, ctx), key = keyOf(name, opts);
    if (st.cache[key]) return st.cache[key];
    if (NEEDS_CANVAS[name] && !hasCanvas()) {
      warnOnce('CB.gl.textures.' + name + ': no canvas available in this environment; returning null');
      return null;
    }
    var res = GEN[name](opts || {});
    var tex = upload(gl, res.source, res);
    if (!tex) return null; // context lost mid-generation: don't cache a null handle
    try {
      tex.key = key; tex.textureName = name;
      if (res.atlas) tex.atlas = res.atlas;
      if (res.meta) { tex.meta = res.meta; for (var m in res.meta) if (!(m in tex)) tex[m] = res.meta[m]; }
    } catch (e) { /* ignore */ }
    st.cache[key] = tex;
    return tex;
  }

  /** generate a texture source without GL (canvas or {width,height,data}). Throws without a canvas for canvas textures. */
  function generate(name, opts) {
    if (!GEN[name]) throw new Error('CB.gl.textures.generate: unknown texture "' + name + '"');
    return GEN[name](opts || {});
  }

  /** helper: one-off canvas texture */
  function canvasTexture(ctx, w, h, drawFn, opts) {
    opts = opts || {};
    var st = opts.key ? stateOf(glOf(ctx), ctx) : null;
    if (st && st.cache['canvas|' + opts.key]) return st.cache['canvas|' + opts.key];
    var c = makeCanvas(w, h), g = ctx2d(c);
    if (drawFn) drawFn(g, w, h, c);
    if (st) {
      var t = upload(ctx, c, opts);
      if (!t) return null;
      try { t.key = 'canvas|' + opts.key; } catch (e) { /* ignore */ }
      st.cache['canvas|' + opts.key] = t; return t;
    }
    return upload(ctx, c, { wrapS: opts.wrapS || 'clamp', wrapT: opts.wrapT || 'clamp', mips: opts.mips, aniso: opts.aniso, filter: opts.filter });
  }

  /**
   * Dynamic canvas texture updated every frame (gauges, screens, mirrors overlays).
   * Returns {canvas, g, texture, width, height, update(drawFn?) -> texture, destroy()}.
   * Uses LINEAR filtering without mipmaps (cheap re-upload with texSubImage2D).
   */
  function dynamic(ctx, w, h, opts) {
    var gl = glOf(ctx);
    w = pot(w || 512); h = pot(h || 256);
    var c = makeCanvas(w, h), g = ctx2d(c);
    var DOPT = { wrapS: 'clamp', wrapT: 'clamp', mips: false, aniso: 1 };
    var tex = upload(gl, c, DOPT), epoch = stateOf(gl).epoch;
    var T2 = K(gl, 'TEXTURE_2D');
    var dyn = {
      canvas: c, g: g, texture: tex, width: w, height: h,
      update: function (drawFn) {
        if (drawFn) drawFn(g, w, h, c);
        var st = stateOf(gl);
        if (st.epoch !== epoch || !tex) {
          // context was lost + restored: the old handle is dead, re-create from the canvas
          var lost = false;
          try { lost = gl.isContextLost && gl.isContextLost(); } catch (e0) { lost = false; }
          if (lost) return tex;
          tex = upload(gl, c, DOPT); epoch = st.epoch; dyn.texture = tex;
          return tex;
        }
        var prev = null;
        try { prev = gl.getParameter(K(gl, 'TEXTURE_BINDING_2D')); } catch (e) { prev = null; }
        gl.bindTexture(T2, tex);
        gl.pixelStorei(K(gl, 'UNPACK_FLIP_Y_WEBGL'), false);
        gl.pixelStorei(K(gl, 'UNPACK_PREMULTIPLY_ALPHA_WEBGL'), false);
        gl.texSubImage2D(T2, 0, 0, 0, K(gl, 'RGBA'), K(gl, 'UNSIGNED_BYTE'), c);
        gl.bindTexture(T2, prev || null);
        return tex;
      },
      destroy: function () { try { if (tex) gl.deleteTexture(tex); } catch (e) { /* ignore */ } tex = null; dyn.texture = null; }
    };
    void opts;
    return dyn;
  }

  /**
   * Default race dashboard gauge renderer (cockpit may use or replace it).
   * state: {rpm, maxRpm, redline, speedKmh | speed (m/s), gear (-1 R, 0 N, 1..), throttle, brake,
   *         shift (0..1 shift-light fill; derived from rpm if absent), time (s), accent (css), units ('kmh'|'mph'),
   *         lap, position, fuel (0..1)}
   */
  function drawGauges(g, w, h, state) {
    state = state || {};
    var sc = w / 1024, maxRpm = state.maxRpm || 8000, red = state.redline || maxRpm * 0.88, rpm = clamp(state.rpm || 0, 0, maxRpm * 1.05);
    var accent = state.accent || '#d4a24c', time = state.time || 0, mph = state.units === 'mph';
    var spd = state.speedKmh != null ? state.speedKmh : (state.speed || 0) * 3.6;
    if (mph) spd /= 1.609344;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    // background
    var bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0b0c0f'); bg.addColorStop(1, '#16181d');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // shift lights
    var shift = state.shift != null ? state.shift : clamp01((rpm - red * 0.75) / (red * 0.25));
    var n = 15, lw = (w * 0.6) / n, lx = w * 0.2, ly = 18 * sc, blink = rpm >= red && Math.floor(time * 12) % 2 === 0;
    for (var k = 0; k < n; k++) {
      var on = (k + 0.5) / n <= shift;
      var col = k < 5 ? '#18e05a' : k < 10 ? '#ff3030' : '#3a7bff';
      if (rpm >= red) col = blink ? '#3a7bff' : '#0a0a14';
      g.fillStyle = on || rpm >= red ? col : '#202228';
      g.beginPath(); g.arc(lx + lw * (k + 0.5), ly + 10 * sc, 9 * sc, 0, TAU); g.fill();
      if (on && !(rpm >= red && !blink)) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(lx + lw * (k + 0.5) - 3 * sc, ly + 7 * sc, 3 * sc, 0, TAU); g.fill(); }
    }
    // tach dial
    var cx = w * 0.5, cy = h * 0.6, R = h * 0.38, a0 = PI * 0.75, a1 = PI * 2.25;
    g.lineCap = 'butt';
    g.strokeStyle = '#25272d'; g.lineWidth = 22 * sc; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    var ar = lerp(a0, a1, red / maxRpm);
    g.strokeStyle = '#7a1414'; g.beginPath(); g.arc(cx, cy, R, ar, a1); g.stroke();
    var av = lerp(a0, a1, clamp01(rpm / maxRpm));
    var arcG = g.createLinearGradient(cx - R, cy, cx + R, cy);
    arcG.addColorStop(0, accent); arcG.addColorStop(1, rpm > red ? '#ff2a2a' : '#ffffff');
    g.strokeStyle = arcG; g.beginPath(); g.arc(cx, cy, R, a0, av); g.stroke();
    g.fillStyle = '#c9ccd2'; g.font = '700 ' + Math.round(22 * sc) + 'px ' + FONT_SANS; g.textAlign = 'center'; g.textBaseline = 'middle';
    var steps = Math.ceil(maxRpm / 1000);
    for (var t = 0; t <= steps; t++) {
      var a = lerp(a0, a1, t * 1000 / maxRpm);
      if (t * 1000 > maxRpm) break;
      g.strokeStyle = t * 1000 >= red ? '#ff4040' : '#9aa0aa'; g.lineWidth = 3 * sc;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - 18 * sc), cy + Math.sin(a) * (R - 18 * sc)); g.lineTo(cx + Math.cos(a) * (R - 34 * sc), cy + Math.sin(a) * (R - 34 * sc)); g.stroke();
      g.fillText(String(t), cx + Math.cos(a) * (R - 56 * sc), cy + Math.sin(a) * (R - 56 * sc));
    }
    // needle
    g.strokeStyle = '#ff5a1f'; g.lineWidth = 5 * sc; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx - Math.cos(av) * 20 * sc, cy - Math.sin(av) * 20 * sc); g.lineTo(cx + Math.cos(av) * (R - 10 * sc), cy + Math.sin(av) * (R - 10 * sc)); g.stroke();
    g.fillStyle = '#30333a'; g.beginPath(); g.arc(cx, cy, 16 * sc, 0, TAU); g.fill();
    // gear
    var gear = state.gear == null ? 0 : state.gear, gtxt = gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear);
    g.fillStyle = rpm >= red ? '#ff3a3a' : '#ffffff'; g.font = '900 ' + Math.round(110 * sc) + 'px ' + FONT_HEAVY;
    g.fillText(gtxt, cx, cy - 6 * sc);
    // speed digits
    g.fillStyle = '#ffffff'; g.font = '800 ' + Math.round(64 * sc) + 'px ' + FONT_SANS;
    g.fillText(String(Math.round(Math.abs(spd))), cx, cy + R * 0.62);
    g.fillStyle = '#8b9099'; g.font = '600 ' + Math.round(20 * sc) + 'px ' + FONT_SANS;
    g.fillText(mph ? 'MPH' : 'KM/H', cx, cy + R * 0.62 + 40 * sc);
    // side panels: throttle/brake bars, fuel, lap/pos
    function bar(x, val, col, label) {
      var bh = h * 0.5, by = h * 0.32;
      g.fillStyle = '#1f2126'; g.fillRect(x, by, 24 * sc, bh);
      g.fillStyle = col; g.fillRect(x, by + bh * (1 - clamp01(val)), 24 * sc, bh * clamp01(val));
      g.fillStyle = '#8b9099'; g.font = '700 ' + Math.round(16 * sc) + 'px ' + FONT_SANS; g.fillText(label, x + 12 * sc, by + bh + 18 * sc);
    }
    bar(w * 0.12, state.throttle || 0, '#2ee06a', 'THR');
    bar(w * 0.16, state.brake || 0, '#ff3b3b', 'BRK');
    g.textAlign = 'left';
    g.fillStyle = '#c9ccd2'; g.font = '700 ' + Math.round(26 * sc) + 'px ' + FONT_SANS;
    if (state.position != null) g.fillText('P' + state.position, w * 0.76, h * 0.38);
    if (state.lap != null) g.fillText('LAP ' + state.lap, w * 0.76, h * 0.5);
    if (state.fuel != null) {
      g.fillStyle = '#1f2126'; g.fillRect(w * 0.76, h * 0.6, 160 * sc, 14 * sc);
      g.fillStyle = state.fuel < 0.15 ? '#ff8a00' : accent; g.fillRect(w * 0.76, h * 0.6, 160 * sc * clamp01(state.fuel), 14 * sc);
    }
    // glass glare
    var gl = g.createLinearGradient(0, 0, w, h);
    gl.addColorStop(0, 'rgba(255,255,255,0.06)'); gl.addColorStop(0.5, 'rgba(255,255,255,0)'); gl.addColorStop(1, 'rgba(255,255,255,0.02)');
    g.fillStyle = gl; g.fillRect(0, 0, w, h);
    g.restore();
  }
  /** dashboard(ctx, {width, height}) -> dynamic texture with .draw(state) using drawGauges */
  function dashboard(ctx, opts) {
    opts = opts || {};
    if (!hasCanvas()) { warnOnce('CB.gl.textures.dashboard: no canvas available; returning null'); return null; }
    var big = quality === 'high' || quality === 'ultra';
    var d = dynamic(ctx, opts.width || (big ? 1024 : 512), opts.height || (big ? 512 : 256));
    d.draw = function (state) { return d.update(function (g, w, h) { drawGauges(g, w, h, state); }); };
    d.draw({});
    return d;
  }

  var CAR_PRELOAD = ['tyreTread', 'tyreTreadNormal', 'tyreTreadOrm', 'brakeDisc', 'brakeDiscNormal', 'brakeDiscOrm', 'caliper', 'brushedMetal', 'brushedMetalNormal',
    'carbonFibreNormal', 'carbonFibreOrm', 'headlight', 'headlightEmissive', 'taillight', 'taillightEmissive', 'grille', 'grilleNormal', 'leather', 'alcantara', 'asphaltMottle'];
  var DEFAULT_PRELOAD = ['asphalt', 'asphaltNormal', 'grass', 'sand', 'gravel', 'concrete', 'barrierArmco', 'tyreWall', 'kerb', 'crowd', 'trees', 'startLine', 'skidmark', 'smoke', 'spark', 'carbonWeave', 'billboard'];
  /**
   * Generate textures incrementally (one per macrotask) so first frames don't hitch.
   * names: array of names or [name, ...args] arrays. Resolves with {name: texture}.
   */
  /** run fn on a fresh macrotask; MessageChannel is not clamped/throttled like setTimeout in background tabs */
  var yieldCh = null, yieldQ = [];
  function yieldThen(fn) {
    if (yieldCh === null) {
      yieldCh = false;
      if (typeof MessageChannel === 'function' && typeof document !== 'undefined') {
        try {
          yieldCh = new MessageChannel();
          yieldCh.port1.onmessage = function () { var f = yieldQ.shift(); if (f) f(); };
          if (yieldCh.port1.unref) yieldCh.port1.unref();
        } catch (e) { yieldCh = false; }
      }
    }
    if (yieldCh) { yieldQ.push(fn); yieldCh.port2.postMessage(0); }
    else if (typeof setTimeout === 'function') setTimeout(fn, 0);
    else fn();
  }
  function preload(ctx, names, onProgress) {
    names = names || DEFAULT_PRELOAD;
    var out = {}, i = 0;
    return new Promise(function (resolve) {
      function step() {
        if (i >= names.length) { resolve(out); return; }
        var item = names[i++], nm = Array.isArray(item) ? item[0] : item, args = Array.isArray(item) ? item.slice(1) : [];
        try { if (typeof T[nm] === 'function') out[nm + (args.length ? ':' + args.join(',') : '')] = T[nm].apply(null, [ctx].concat(args)); }
        catch (e) { warnOnce('CB.gl.textures.preload: ' + nm + ' failed: ' + (e && e.message)); }
        if (onProgress) { try { onProgress(i / names.length, nm); } catch (e2) { /* ignore */ } }
        yieldThen(step);
      }
      step();
    });
  }

  function invalidate(ctx) {
    var gl = glOf(ctx), st = stateOf(gl);
    resetState(st);
  }
  function dispose(ctx) {
    var gl = glOf(ctx), st = stateOf(gl);
    st.list.forEach(function (t) { try { gl.deleteTexture(t); } catch (e) { /* ignore */ } });
    invalidate(ctx);
  }
  function stats(ctx) {
    var st = stateOf(glOf(ctx));
    return { textures: Object.keys(st.cache).length, uploaded: st.list.length, bytes: Math.round(st.bytes), anisotropy: st.aniso ? st.aniso.max : 1, quality: quality };
  }
  function info(tex) {
    if (!tex) return null;
    return { width: tex.width, height: tex.height, key: tex.key, name: tex.textureName, wrapS: tex.wrapS, wrapT: tex.wrapT, atlas: tex.atlas || null, meta: tex.meta || null };
  }
  function setQuality(q) { if (QUALITY[q] != null) quality = q; return quality; }

  /* --------------------------------------------------------- public getters */
  T.asphalt = function (ctx, o) { o = o || {}; return get(ctx, 'asphalt', { wet: !!o.wet, seed: o.seed, size: o.size }); };
  T.asphaltNormal = function (ctx, o) { o = o || {}; return get(ctx, 'asphaltNormal', { seed: o.seed, size: o.size, strength: o.strength }); };
  T.grass = function (ctx, o) { o = o || {}; return get(ctx, 'grass', { stripes: o.stripes !== false, dry: o.dry, seed: o.seed, size: o.size }); };
  T.sand = function (ctx, o) { o = o || {}; return get(ctx, 'sand', { color: o.color, seed: o.seed, size: o.size }); };
  T.gravel = function (ctx, o) { o = o || {}; return get(ctx, 'gravel', { seed: o.seed, size: o.size }); };
  T.gravelNormal = function (ctx, o) { o = o || {}; return get(ctx, 'gravelNormal', { seed: o.seed, size: o.size, strength: o.strength }); };
  T.kerb = function (ctx, colorA, colorB, o) {
    if (colorA && typeof colorA === 'object' && !Array.isArray(colorA) && !('r' in colorA)) { o = colorA; colorA = o.colorA; colorB = o.colorB; }
    o = o || {};
    return get(ctx, 'kerb', { colorA: colorA ? css(parseColor(colorA)) : '#d01818', colorB: colorB ? css(parseColor(colorB)) : '#f2f2f0', ridges: o.ridges, size: o.size });
  };
  T.concrete = function (ctx, o) { o = o || {}; return get(ctx, 'concrete', { color: o.color, seed: o.seed, size: o.size }); };
  T.barrierArmco = function (ctx, o) { o = o || {}; return get(ctx, 'barrierArmco', { seed: o.seed, size: o.size }); };
  T.armco = T.barrierArmco;
  T.tyreWall = function (ctx, o) { o = o || {}; return get(ctx, 'tyreWall', { paint: o.paint !== false, colors: o.colors, size: o.size }); };
  T.tireWall = T.tyreWall;
  T.crowd = function (ctx, o) { o = o || {}; return get(ctx, 'crowd', { frame: (o.frame | 0) & 1, seed: o.seed, size: o.size }); };
  T.trees = function (ctx, o) { o = o || {}; return get(ctx, 'trees', { seed: o.seed, size: o.size }); };
  T.treeAtlas = T.trees;
  T.buildingFacade = function (ctx, seed, night, o) {
    if (seed && typeof seed === 'object') { o = seed; seed = o.seed; night = o.night; }
    o = o || {};
    return get(ctx, 'buildingFacade', { seed: (seed | 0), night: !!night, size: o.size });
  };
  T.billboard = function (ctx, text, brandColor, o) {
    if (text && typeof text === 'object') { o = text; text = o.text; brandColor = o.brandColor; }
    o = o || {};
    return get(ctx, 'billboard', { text: text == null ? 'REDLINE' : text, brandColor: brandColor ? css(parseColor(brandColor)) : undefined, tagline: o.tagline, size: o.size });
  };
  T.startLine = function (ctx, o) { o = o || {}; return get(ctx, 'startLine', { columns: o.columns, size: o.size }); };
  T.checker = T.startLine;
  T.gridBox = function (ctx, number, o) { o = o || {}; return get(ctx, 'gridBox', { number: number == null ? 1 : String(number), size: o.size }); };
  T.skidmark = function (ctx, o) { o = o || {}; return get(ctx, 'skidmark', { size: o.size }); };
  T.smoke = function (ctx, o) { o = o || {}; return get(ctx, 'smoke', { seed: o.seed, size: o.size }); };
  T.spark = function (ctx) { return get(ctx, 'spark', null); };
  T.rainDrop = function (ctx) { return get(ctx, 'rainDrop', null); };
  T.raindrop = T.rainDrop;
  T.carNumber = function (ctx, number, color, o) { o = o || {}; return get(ctx, 'carNumber', { number: number == null ? '7' : String(number), color: color ? css(parseColor(color)) : '#d01818', style: o.style, sdf: o.sdf ? true : undefined, size: o.size }); };
  T.numberPlate = function (ctx, text, o) { o = o || {}; return get(ctx, 'numberPlate', { text: text == null ? 'FG 007' : String(text), country: o.country, size: o.size }); };
  T.tireSidewall = function (ctx, o) { o = o || {}; return get(ctx, 'tireSidewall', { stripe: o.stripe ? css(parseColor(o.stripe)) : undefined, label: o.label, size: o.size }); };
  T.tyreSidewall = T.tireSidewall;
  T.carbonWeave = function (ctx, o) { o = o || {}; return get(ctx, 'carbonWeave', { tint: o.tint, tows: o.tows, size: o.size }); };
  T.carbon = T.carbonWeave;
  T.white = function (ctx) { return get(ctx, 'white', null); };
  T.black = function (ctx) { return get(ctx, 'black', null); };
  T.flatNormal = function (ctx) { return get(ctx, 'flatNormal', null); };
  // car material families (+ <family>Normal / <family>Orm / <family>Emissive channel getters)
  Object.keys(FAM).forEach(function (fam) {
    var g = famGetter(fam);
    T[fam] = g;
    FAM_CHANNELS[fam].forEach(function (ch) {
      if (ch === 'albedo') return;
      T[fam + CH_SUFFIX[ch]] = function (ctx, o) { var x = {}; for (var k in (o || {})) x[k] = o[k]; x.channel = ch; return g(ctx, x); };
    });
  });
  T.tireTread = T.tyreTread; T.tireTreadNormal = T.tyreTreadNormal; T.tireTreadOrm = T.tyreTreadOrm;
  T.carbonNormal = function (ctx, o) { return T.carbonFibreNormal(ctx, o); };
  T.carbonOrm = function (ctx, o) { return T.carbonFibreOrm(ctx, o); };
  T.tireSidewallNormal = function (ctx, o) { o = o || {}; return get(ctx, 'tireSidewallNormal', { label: o.label, size: o.size }); };
  T.tireSidewallOrm = function (ctx, o) { o = o || {}; return get(ctx, 'tireSidewallOrm', { label: o.label, size: o.size }); };
  T.tyreSidewallNormal = T.tireSidewallNormal; T.tyreSidewallOrm = T.tireSidewallOrm;
  T.asphaltMottle = function (ctx, o) { o = o || {}; return get(ctx, 'asphaltMottle', { seed: o.seed, size: o.size }); };
  T.ASPHALT_TILE_M = 6;
  T.ASPHALT_MOTTLE_M = 41;
  T.carSet = carSet;
  T.CAR_FAMILIES = Object.keys(FAM);
  T.HEADLIGHT_STYLES = ['projector', 'reflector', 'round', 'led', 'matrix', 'laser', 'oval-4pt', 'c-clamp', 'y-blade', 'round-halo', 'slim-led', 'projector-twin', 'quad-round', 'blade'];
  T.TAILLIGHT_STYLES = ['cluster', 'bar', 'ring', 'blade', 'light-bar', 'c-ring', 'round-ring', 'slim', 'full-width', 'y-shape', 'vertical', 'quad-round'];
  T.GRILLE_PATTERNS = ['honeycomb', 'slats', 'vertical', 'mesh', 'diamond', 'kidney', 'blanked', 'seven-slot', 'hex', 'horseshoe', 'split-v', 'bar'];
  T.familyChannels = function (fam) { return (FAM_CHANNELS[fam] || []).slice(); };
  T.preloadCar = function (ctx, onProgress) { return preload(ctx, CAR_PRELOAD, onProgress); };

  T.canvas = canvasTexture;
  T.dynamic = dynamic;
  T.dashboard = dashboard;
  T.drawGauges = drawGauges;
  T.upload = upload;
  T.generate = generate;
  T.preload = preload;
  T.invalidate = invalidate;
  T.dispose = dispose;
  T.stats = stats;
  T.info = info;
  T.setQuality = setQuality;
  T.getQuality = function () { return quality; };
  T.hasCanvas = hasCanvas;
  T.makeCanvas = makeCanvas;
  T.SPONSORS = SPONSORS.map(function (s) { return s.name; });
  T.sponsors = SPONSORS;
  T.findSponsor = findSponsor;
  T.TREE_SPECIES = TREE_SPECIES.map(function (s) { return s.name; });
  T.treeAtlasInfo = treeAtlasInfo;
  T.FACADE_STYLES = FACADE_STYLES;
  T.names = Object.keys(GEN);
  /** inject a canvas factory (tests / workers): fn(w, h) -> canvas-like with getContext('2d'); null resets */
  T._setCanvasFactory = function (fn) { canvasFactory = fn || null; };
  T._internal = {
    rng: rng, hash2: hash2, hashStr: hashStr, noiseField: noiseField, sampleField: sampleField, heightToNormal: heightToNormal,
    dilateRGB: dilateRGB, buildMips: buildMips, coverage: coverage, parseColor: parseColor, hsl: hsl, keyOf: keyOf,
    GEN: GEN, NEEDS_CANVAS: NEEDS_CANVAS, pot: pot, FAM: FAM, alphaToSDF: alphaToSDF, worley: worley, famMemo: famMemo
  };

  CB.gl.textures = T;
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
})();

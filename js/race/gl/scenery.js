/* ==========================================================================
   FORGE Atelier — js/race/gl/scenery.js
   CB.gl.scenery : trackside world for the 3D race renderer (docs/RACE3D-SPEC.md).

   API
     CB.gl.scenery.build(ctx, geom, trackDef, opts {quality, timeOfDay, weather, groundY}) -> {
        items: [...],                 every draw item ({mesh, material, model, castShadow, worldBounds, lod, visible})
        getItems(camPos) -> array     items active for the current camera (LOD / distance culled)
        update(time, camPos, snap, camera)   LOD selection, countdown lights, crowd cheer, blinkers, wheel/turbines
        setCountdown(cd)              snapshot.countdown {lightsOn 0..5, lightsOut}
        lights: [{pos, dir, color, range, cosInner, cosOuter, type}]   lamp posts (GL world space)
        setQuality(q), stats, destroy()
     }
     CB.gl.scenery.buildGeometry(geom, trackDef, opts) -> pure (no GL / DOM) result:
        { parts: [{key, mat, lod, chunk, positions, normals, uvs, colors, indices, bounds, castShadow}],
          dynamic: [...], lights, signTexts, placed: [{type, x, y, r}], stats }

   Design
     * Deterministic: everything is seeded from the track id (mulberry32), so the same track always
       produces the same world.
     * Never on the track: all procedural placement goes through a sample-accurate barrier clearance
       test (spatial hash over the centerline, wallL/wallR per sample, so it also respects other
       parts of the circuit, e.g. hairpins and figure-8 crossings) plus CB.race.tracks.project and an
       occupancy grid so props never overlap each other or the authored trackDef scenery.
     * Batching: geometry is merged per (material, LOD band, 256 m chunk) into static meshes (Uint16,
       split at 64k vertices). This gives instancing-like draw-call counts using only createMesh, and
       each chunk has a world bounding sphere so the renderer frustum-culls it.
     * LOD bands: 'near' (full low-poly trees), 'far' (crossed billboard trees from the atlas),
       'all' (structures), 'detail' (small props), 'global' (skyline / far ground; always drawn).
     * World axes: sim (x, y) -> GL (x, z = -y), +Y up. Objects are authored in a local frame
       X = along the track, Y = up, Z = away from the track (front faces the track at -Z).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

CB.gl.scenery = (function () {
  'use strict';

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var MAX_VERTS = 64000;
  var CHUNK = 256;
  var SIGN_SLOT_W = 512, SIGN_SLOT_H = 128;

  var QUALITY = {
    low: { near: 150, far: 1400, detail: 170, trees: 0.45, city: 0.55, fill: 0.5, segs: 0, grass: 0, tufts: 0, sway: 0 },
    medium: { near: 240, far: 1900, detail: 260, trees: 0.7, city: 0.8, fill: 0.75, segs: 1, grass: 90, tufts: 0.55, sway: 1 },
    high: { near: 340, far: 2500, detail: 380, trees: 1.0, city: 1.0, fill: 1.0, segs: 1, grass: 140, tufts: 1, sway: 1 },
    ultra: { near: 520, far: 3300, detail: 560, trees: 1.35, city: 1.25, fill: 1.2, segs: 2, grass: 210, tufts: 1.4, sway: 1 }
  };
  function normQ(q) { return QUALITY[q] ? q : (q === 'med' ? 'medium' : (q === 'max' || q === 'epic') ? 'ultra' : 'high'); }

  /* ================================================================ utils */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function fin(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function wrapAngle(a) { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; }

  function hashStr(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rngFor(seed) {
    var a = (typeof seed === 'string' ? hashStr(seed) : seed >>> 0) || 0x9e3779b9;
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
  function hash2(x, y, s) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((s | 0) + 1, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    var u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, y, s, oct) {
    var sum = 0, amp = 0.5, f = 1, norm = 0;
    for (var o = 0; o < (oct || 3); o++) { sum += vnoise(x * f, y * f, s + o * 17) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
    return sum / norm;
  }
  // periodic 1D noise on a circle (for skyline rings)
  function ringNoise(theta, freq, s) {
    return fbm(Math.cos(theta) * freq + 50, Math.sin(theta) * freq + 50, s, 4);
  }

  // sRGB hex -> linear RGBA
  function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  /** Cap a linear albedo so its brightest channel stays <= m (default 0.7): near-white painted surfaces (roofs,
      pit walls, tents) otherwise clip under a day sun, most visibly on 'low' quality where post FX are off. */
  function alb(c, m) {
    m = m || 0.7;
    var mx = Math.max(c[0], c[1], c[2]);
    if (!(mx > m)) return c;
    var k = m / mx;
    return [c[0] * k, c[1] * k, c[2] * k, c.length > 3 ? c[3] : 1];
  }
  function lin(hex, fallback) {
    if (Array.isArray(hex)) return [hex[0], hex[1], hex[2], hex.length > 3 ? hex[3] : 1];
    var h = typeof hex === 'string' ? hex.replace('#', '').trim() : '';
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h.slice(0, 6)) || h.length < 6) return fallback ? lin(fallback) : [0.5, 0.5, 0.5, 1];
    var n = parseInt(h.slice(0, 6), 16);
    return [s2l(((n >> 16) & 255) / 255), s2l(((n >> 8) & 255) / 255), s2l((n & 255) / 255), 1];
  }
  function mul(c, k) { return [c[0] * k, c[1] * k, c[2] * k, c[3]]; }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)]; }
  function jit(c, r, amt) { var k = 1 + (r() - 0.5) * 2 * amt; return [c[0] * k * (1 + (r() - 0.5) * amt * 0.5), c[1] * k, c[2] * k * (1 + (r() - 0.5) * amt * 0.5), c[3]]; }
  function normHex(h) { var c = lin(h); return '#' + c.slice(0, 3).map(function (v) { var s = Math.round(Math.pow(clamp(v, 0, 1), 1 / 2.2) * 255).toString(16); return s.length < 2 ? '0' + s : s; }).join(''); }

  var WHITE = [1, 1, 1, 1];
  var COL = {
    concrete: lin('#b9b6ae'), concreteDark: lin('#8e8b84'), steel: lin('#9aa2aa'), dark: lin('#25272b'),
    black: lin('#111214'), white: lin('#eeeeea'), offwhite: lin('#d9d6cf'), glass: lin('#7d93a8'),
    bark: lin('#4a3424'), barkDark: lin('#3a281b'), birch: lin('#dcd8cc'), orange: lin('#f07a12'),
    yellow: lin('#f4c419'), red: lin('#c8202a'), terracotta: lin('#b5562f'), wood: lin('#6b4a32'),
    rubber: lin('#1b1b1d'), asphalt: lin('#3a3c40'), grassDark: lin('#3d5f2c'), lampOff: lin('#c9cdd2')
  };

  /* ============================================================ batches */
  function Sink() { this.map = {}; this.list = []; this.signTexts = []; this.signIndex = {}; this.tris = 0; }
  Sink.prototype.get = function (mat, lod, chunk, reserve) {
    var key = mat + '|' + lod + '|' + chunk;
    var b = this.map[key];
    if (!b || b.vc + reserve > MAX_VERTS) {
      b = { key: key + '#' + (b ? b.seq + 1 : 0), mat: mat, lod: lod, chunk: chunk, seq: b ? b.seq + 1 : 0,
        p: [], n: [], uv: [], c: [], idx: [], vc: 0,
        min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      this.map[key] = b; this.list.push(b);
    }
    return b;
  };
  /** sign atlas slot for (text, variant, colour); 2 columns x up to 16 rows of 512x128 cells */
  Sink.prototype.slot = function (text, variant, color, aspect) {
    var t = String(text == null ? 'REDLINE' : text).toUpperCase(), v = variant || 'brand', c = color || '';
    var a = Math.round(clamp(fin(aspect, 4), 0.25, 16) * 4) / 4;
    var key = t + '|' + v + '|' + c + '|' + a;
    if (this.signIndex[key] != null) return this.signIndex[key];
    if (this.signTexts.length >= 32) return hashStr(key) % 32;
    this.signIndex[key] = this.signTexts.length;
    this.signTexts.push({ text: t, variant: v, color: c, aspect: a });
    return this.signIndex[key];
  };
  Sink.prototype.slotRows = function () { var n = Math.max(1, Math.ceil(this.signTexts.length / 2)), r = 1; while (r < n) r *= 2; return r; };

  function bvert(b, x, y, z, nx, ny, nz, u, v, col) {
    b.p.push(x, y, z); b.n.push(nx, ny, nz); b.uv.push(u, v); b.c.push(col[0], col[1], col[2], col[3]);
    if (x < b.min[0]) b.min[0] = x; if (y < b.min[1]) b.min[1] = y; if (z < b.min[2]) b.min[2] = z;
    if (x > b.max[0]) b.max[0] = x; if (y > b.max[1]) b.max[1] = y; if (z > b.max[2]) b.max[2] = z;
    return b.vc++;
  }

  /* ============================================================ writer
     Local frame: X along, Y up, Z right (away from the track for trackside objects). */
  function Writer(sink) {
    this.sink = sink; this.ox = 0; this.oy = 0; this.oz = 0; this.c = 1; this.s = 0;
    this.mat = 'paint'; this.lod = 'all'; this.chunk = '0,0';
  }
  var W = Writer.prototype;
  W.at = function (simx, simy, yaw, baseY, chunk) {
    this.sx = simx; this.sy = simy;
    this.ox = simx; this.oy = baseY || 0; this.oz = -simy; this.yaw = yaw || 0; this.c = Math.cos(this.yaw); this.s = Math.sin(this.yaw);
    this.chunk = chunk || null;
    return this;
  };
  /** batch chunk for the current LOD band (chunk size depends on the band) */
  W.chunkKey = function () { return this.chunk || chunkFor(this.lod, this.sx, this.sy); };
  /** raw quad/polygon with an explicit (local) normal: billboards & foliage cards */
  W.polyN = function (pts, uvs, col, nrm) {
    var n = pts.length, b0 = this.sink.get(this.mat, this.lod, this.chunkKey(), n), base = b0.vc, i;
    var wn = this.wd(nrm[0], nrm[1], nrm[2]);
    for (i = 0; i < n; i++) {
      var p = pts[i];
      bvert(b0, this.ox + p[0] * this.c + p[2] * this.s, this.oy + p[1], this.oz - p[0] * this.s + p[2] * this.c,
        wn[0], wn[1], wn[2], uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0, col);
    }
    for (i = 1; i < n - 1; i++) b0.idx.push(base, base + i, base + i + 1);
    this.sink.tris += n - 2;
  };
  W.use = function (mat, lod) { this.mat = mat; if (lod) this.lod = lod; return this; };
  /** world position of a local point (GL) */
  W.wp = function (lx, ly, lz) { return [this.ox + lx * this.c + lz * this.s, this.oy + ly, this.oz - lx * this.s + lz * this.c]; };
  W.wd = function (lx, ly, lz) { return [lx * this.c + lz * this.s, ly, -lx * this.s + lz * this.c]; };

  /** convex planar polygon, CCW seen from the front. ref: optional interior point to auto-orient outward. */
  W.face = function (pts, col, uvs, ref, vcols) {
    var n = pts.length;
    if (n < 3) return;
    var nx = 0, ny = 0, nz = 0, i, j;
    for (i = 0; i < n; i++) {
      j = (i + 1) % n;
      var a = pts[i], b = pts[j];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (ref) {
      var cx = 0, cy = 0, cz = 0;
      for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
      cx = cx / n - ref[0]; cy = cy / n - ref[1]; cz = cz / n - ref[2];
      if (cx * nx + cy * ny + cz * nz < 0) {
        pts = pts.slice().reverse(); if (uvs) uvs = uvs.slice().reverse(); if (vcols) vcols = vcols.slice().reverse();
        nx = -nx; ny = -ny; nz = -nz;
      }
    }
    var b0 = this.sink.get(this.mat, this.lod, this.chunkKey(), n);
    var wnx = nx * this.c + nz * this.s, wnz = -nx * this.s + nz * this.c;
    var base = b0.vc;
    for (i = 0; i < n; i++) {
      var p = pts[i];
      bvert(b0, this.ox + p[0] * this.c + p[2] * this.s, this.oy + p[1], this.oz - p[0] * this.s + p[2] * this.c,
        wnx, ny, wnz, uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0, vcols ? vcols[i] : col);
    }
    for (i = 1; i < n - 1; i++) b0.idx.push(base, base + i, base + i + 1);
    this.sink.tris += n - 2;
  };
  W.face2 = function (pts, col, uvs) { this.face(pts, col, uvs); this.face(pts.slice().reverse(), col, uvs ? uvs.slice().reverse() : null); };

  /** oriented box from center + three half-axis vectors */
  W.obox = function (c, ax, ay, az, col, o) {
    o = o || {};
    var P = [];
    for (var i = 0; i < 8; i++) {
      var sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1, sz = i & 4 ? 1 : -1;
      P.push([c[0] + ax[0] * sx + ay[0] * sy + az[0] * sz, c[1] + ax[1] * sx + ay[1] * sy + az[1] * sz, c[2] + ax[2] * sx + ay[2] * sy + az[2] * sz]);
    }
    var F = { px: [1, 3, 7, 5], nx: [0, 4, 6, 2], py: [2, 6, 7, 3], ny: [0, 1, 5, 4], pz: [4, 5, 7, 6], nz: [0, 2, 3, 1] };
    for (var k in F) {
      if (o.skip && o.skip[k]) continue;
      var f = F[k], q = [P[f[0]], P[f[1]], P[f[2]], P[f[3]]];
      var fc = (o.cols && o.cols[k]) || (k === 'py' && o.top) || (k === 'ny' && o.bottom) || col;
      this.face(q, fc, o.uv ? o.uv(k, q) : null, c);
    }
  };
  /** axis-aligned box (local frame). center (cx, cy, cz), full sizes */
  W.box = function (cx, cy, cz, sx, sy, sz, col, o) {
    this.obox([cx, cy, cz], [sx / 2, 0, 0], [0, sy / 2, 0], [0, 0, sz / 2], col, o);
  };
  /** box from y0 to y1 */
  W.boxY = function (cx, y0, cz, sx, y1, sz, col, o) { this.box(cx, (y0 + y1) / 2, cz, sx, y1 - y0, sz, col, o); };
  /** beam between two local points with width (horizontal-ish) and height */
  W.beam = function (a, b, w, h, col, o) {
    var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-6) return;
    var ex = [d[0] / L, d[1] / L, d[2] / L];
    var up = Math.abs(ex[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    var ez = norm3(cross3(ex, up)), ey = cross3(ez, ex);
    this.obox([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      [ex[0] * L / 2, ex[1] * L / 2, ex[2] * L / 2], [ey[0] * h / 2, ey[1] * h / 2, ey[2] * h / 2], [ez[0] * w / 2, ez[1] * w / 2, ez[2] * w / 2], col, o);
  };
  /** vertical cylinder / cone frustum */
  W.cyl = function (cx, y0, cz, r0, r1, h, seg, col, o) {
    o = o || {};
    seg = Math.max(3, seg | 0);
    var ref = [cx, y0 + h / 2, cz], a0 = o.rot || 0, rz = o.rz || 1, i;
    var ring0 = [], ring1 = [];
    for (i = 0; i < seg; i++) {
      var a = a0 + i / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      ring0.push([cx + ca * r0, y0, cz + sa * r0 * rz]);
      ring1.push([cx + ca * r1, y0 + h, cz + sa * r1 * rz]);
    }
    var top = o.colTop || col;
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      if (r1 <= 1e-4) this.face([ring0[i], ring0[j], ring1[i]], o.colFn ? o.colFn(i) : col, null, ref);
      else if (r0 <= 1e-4) this.face([ring0[i], ring1[j], ring1[i]], o.colFn ? o.colFn(i) : col, null, ref);
      else this.face([ring0[i], ring0[j], ring1[j], ring1[i]], o.colFn ? o.colFn(i) : col, null, ref);
    }
    if (o.top !== false && r1 > 1e-4) this.face(ring1.slice(), top, null, [cx, y0, cz]);
    if (o.bottom && r0 > 1e-4) this.face(ring0.slice(), o.colBottom || col, null, [cx, y0 + h, cz]);
  };
  /** tube between two local points */
  W.tube = function (a, b, r, seg, col, o) {
    o = o || {};
    var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-6) return;
    var ex = [d[0] / L, d[1] / L, d[2] / L];
    var up = Math.abs(ex[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    var u = norm3(cross3(ex, up)), v = cross3(u, ex);
    var r1 = o.r1 != null ? o.r1 : r, ra = [], rb = [], i;
    seg = Math.max(3, seg | 0);
    for (i = 0; i < seg; i++) {
      var t = i / seg * TAU, ct = Math.cos(t), st = Math.sin(t);
      ra.push([a[0] + (u[0] * ct + v[0] * st) * r, a[1] + (u[1] * ct + v[1] * st) * r, a[2] + (u[2] * ct + v[2] * st) * r]);
      rb.push([b[0] + (u[0] * ct + v[0] * st) * r1, b[1] + (u[1] * ct + v[1] * st) * r1, b[2] + (u[2] * ct + v[2] * st) * r1]);
    }
    var ref = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      if (r1 <= 1e-4) this.face([ra[i], ra[j], rb[i]], col, null, ref);
      else this.face([ra[i], ra[j], rb[j], rb[i]], col, null, ref);
    }
    if (o.caps) { this.face(ra.slice(), o.capCol || col, null, b); if (r1 > 1e-4) this.face(rb.slice(), o.capCol || col, null, a); }
  };
  /** jittered icosahedron blob (flat shaded, per-face colour variation) */
  var ICO = (function () {
    var t = (1 + Math.sqrt(5)) / 2;
    var v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    v = v.map(function (p) { var l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; });
    var f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    return { v: v, f: f };
  })();
  W.blob = function (cx, cy, cz, rx, ry, rz, col, rnd, jitter, o) {
    o = o || {};
    var jv = ICO.v.map(function (p) {
      var k = 1 + (rnd ? (rnd() - 0.5) * 2 * (jitter || 0) : 0);
      return [cx + p[0] * rx * k, cy + p[1] * ry * k, cz + p[2] * rz * k];
    });
    var ref = [cx, cy, cz];
    for (var i = 0; i < ICO.f.length; i++) {
      var f = ICO.f[i], a = jv[f[0]], b = jv[f[1]], c = jv[f[2]];
      if (o.cutBelow != null && a[1] < o.cutBelow && b[1] < o.cutBelow && c[1] < o.cutBelow) continue;
      var fy = (a[1] + b[1] + c[1]) / 3 - cy;
      var shade = 0.82 + 0.3 * clamp(fy / ry, -1, 1) * 0.5 + (rnd ? (rnd() - 0.5) * 0.14 : 0);
      var fc = o.colFn ? o.colFn(fy / ry) : col;
      this.face([a, b, c], mul(fc, shade), null, ref);
    }
  };
  /** gable roof over x0..x1 (ridge along X), z0..z1, eaves at y0, ridge height h */
  W.gable = function (x0, x1, z0, z1, y0, h, over, col, colEnd) {
    var zm = (z0 + z1) / 2, X0 = x0 - over, X1 = x1 + over, Z0 = z0 - over, Z1 = z1 + over, yr = y0 + h, ye = y0 - over * h / ((z1 - z0) / 2);
    var ref = [(x0 + x1) / 2, y0, zm];
    this.face([[X0, ye, Z0], [X1, ye, Z0], [X1, yr, zm], [X0, yr, zm]], col, null, ref);
    this.face([[X0, ye, Z1], [X0, yr, zm], [X1, yr, zm], [X1, ye, Z1]], col, null, ref);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, yr, zm]], colEnd || col, null, ref);
    this.face([[x1, y0, z0], [x1, yr, zm], [x1, y0, z1]], colEnd || col, null, ref);
    this.face([[X0, ye - 0.08, Z0], [X0, ye - 0.08, Z1], [X1, ye - 0.08, Z1], [X1, ye - 0.08, Z0]], mul(col, 0.5), null, [ref[0], yr + 5, ref[2]]);
  };
  /** hip roof (pyramid-ish) */
  W.hip = function (x0, x1, z0, z1, y0, h, over, col) {
    var X0 = x0 - over, X1 = x1 + over, Z0 = z0 - over, Z1 = z1 + over, yr = y0 + h;
    var lx = X1 - X0, lz = Z1 - Z0, cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2, ref = [cx, y0 - 1, cz];
    var ra, rb;
    if (lx >= lz) { ra = [X0 + lz / 2, yr, cz]; rb = [X1 - lz / 2, yr, cz]; }
    else { ra = [cx, yr, Z0 + lx / 2]; rb = [cx, yr, Z1 - lx / 2]; }
    var c00 = [X0, y0, Z0], c10 = [X1, y0, Z0], c11 = [X1, y0, Z1], c01 = [X0, y0, Z1];
    if (lx >= lz) {
      this.face([c00, c10, rb, ra], col, null, ref);
      this.face([c11, c01, ra, rb], col, null, ref);
      this.face([c01, c00, ra], mul(col, 0.92), null, ref);
      this.face([c10, c11, rb], mul(col, 0.92), null, ref);
    } else {
      this.face([c00, c10, ra], col, null, ref);
      this.face([c11, c01, rb], col, null, ref);
      this.face([c01, c00, ra, rb], mul(col, 0.92), null, ref);
      this.face([c10, c11, rb, ra], mul(col, 0.92), null, ref);
    }
    this.face([c00, c01, c11, c10], mul(col, 0.45), null, [cx, yr + 5, cz]);
  };
  W.disc = function (cx, y, cz, r, seg, col) {
    var pts = [];
    for (var i = 0; i < seg; i++) { var a = i / seg * TAU; pts.push([cx + Math.cos(a) * r, y, cz - Math.sin(a) * r]); }
    this.face(pts, col, null, [cx, y - 1, cz]);
  };
  /** sign panel from the signs atlas. pts = [bottom-left, bottom-right, top-right, top-left] as seen by the viewer.
      UV v encodes slot + fraction (remapped to the atlas layout when the batch is finalised). */
  W.sign = function (pts, text, col, variant, color, aspect) {
    if (aspect == null && pts.length >= 4) {
      var p0 = pts[0], p1 = pts[1], p3 = pts[3];
      aspect = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / Math.max(0.01, Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]));
    }
    if ((variant == null || variant === 'brand') && aspect > 5.2 && pts.length === 4 && typeof text !== 'number') {
      var ns = Math.max(2, Math.round(aspect / 4)), P0 = pts[0], P1 = pts[1], P2 = pts[2], P3 = pts[3];
      var lp = function (a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
      for (var si = 0; si < ns; si++) {
        var t0 = si / ns + 0.004, t1 = (si + 1) / ns - 0.004;
        this.sign([lp(P0, P1, t0), lp(P0, P1, t1), lp(P3, P2, t1), lp(P3, P2, t0)], text, col, variant, color, aspect / ns);
      }
      return;
    }
    if (variant == null || variant === 'brand') aspect = 4;
    var slot = typeof text === 'number' ? text : this.sink.slot(text, variant, color, aspect);
    var v0 = slot + 0.04, v1 = slot + 0.96;
    this.face(pts, col || WHITE, [[0.01, v1], [0.99, v1], [0.99, v0], [0.01, v0]]);
  };

  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm3(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function chunkOf(x, y) { return Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK); }
  // chunk sizes per LOD band (near/far trees share the grid so their selection is exactly complementary)
  var LOD_CHUNK = { near: 192, far: 192, detail: 160, grass: 64, all: 512, bill: 512 };
  function chunkFor(lod, x, y) {
    var sz = LOD_CHUNK[lod];
    if (!sz) return 'g';
    return Math.floor(x / sz) + ',' + Math.floor(y / sz);
  }
  /** GL centre of a chunk cell */
  function chunkCenter(lod, key) {
    var sz = LOD_CHUNK[lod], m = /^(-?\d+),(-?\d+)/.exec(key || '');
    if (!sz || !m) return null;
    return [(+m[1] + 0.5) * sz, 0, -((+m[2] + 0.5) * sz)];
  }

  /* ======================================================= placement helpers */
  /** signed clearance (m) from (x, y) to the nearest barrier line of ANY part of the circuit (negative = inside). */
  function makeClearance(geom) {
    var S = geom.samples, N = S.length, cell = 32, map = {}, maxW = 0, ds = geom.ds || 2;
    for (var i = 0; i < N; i++) {
      var q = S[i], k = Math.floor(q.x / cell) + ',' + Math.floor(q.y / cell);
      (map[k] || (map[k] = [])).push(i);
      maxW = Math.max(maxW, q.wallL + (q.layer ? 13 : 0), q.wallR + (q.layer ? 13 : 0));
    }
    var R = maxW + 30, cr = Math.ceil(R / cell), lonTol = ds * 0.55 + 0.05;
    function clearance(x, y) {
      var best = R, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (var gx = cx - cr; gx <= cx + cr; gx++) {
        for (var gy = cy - cr; gy <= cy + cr; gy++) {
          var list = map[gx + ',' + gy];
          if (!list) continue;
          for (var n = 0; n < list.length; n++) {
            var q = S[list[n]], dx = x - q.x, dy = y - q.y;
            var lon = dx * q.tx + dy * q.ty, lat = dx * q.nx + dy * q.ny;
            var w = (lat >= 0 ? q.wallL : q.wallR) + (q.layer ? 13 : 0), c;
            if (Math.abs(lon) <= lonTol) c = Math.abs(lat) - w;
            else c = Math.sqrt(dx * dx + dy * dy) - w;
            if (c < best) best = c;
          }
        }
      }
      return best;
    }
    clearance.maxWall = maxW;
    return clearance;
  }

  /** occupancy grid (4 m cells) so props never overlap */
  function Occupancy() { this.cells = {}; this.size = 4; }
  Occupancy.prototype.key = function (ix, iy) { return ix + ',' + iy; };
  Occupancy.prototype.markCircle = function (x, y, r, tag) {
    var s = this.size, x0 = Math.floor((x - r) / s), x1 = Math.floor((x + r) / s), y0 = Math.floor((y - r) / s), y1 = Math.floor((y + r) / s);
    for (var ix = x0; ix <= x1; ix++) for (var iy = y0; iy <= y1; iy++) {
      var cx = (ix + 0.5) * s, cy = (iy + 0.5) * s;
      if (Math.hypot(cx - x, cy - y) <= r + s * 0.71) this.cells[this.key(ix, iy)] = tag || 1;
    }
  };
  Occupancy.prototype.markRect = function (x, y, rot, l, w, pad, tag) {
    var c = Math.cos(rot), s = Math.sin(rot), hl = l / 2 + (pad || 0), hw = w / 2 + (pad || 0), st = this.size * 0.5;
    for (var a = -hl; a <= hl + 1e-6; a += st) for (var b = -hw; b <= hw + 1e-6; b += st) {
      var px = x + c * a - s * b, py = y + s * a + c * b;
      this.cells[this.key(Math.floor(px / this.size), Math.floor(py / this.size))] = tag || 1;
    }
  };
  Occupancy.prototype.hitCircle = function (x, y, r, tag) {
    var s = this.size, x0 = Math.floor((x - r) / s), x1 = Math.floor((x + r) / s), y0 = Math.floor((y - r) / s), y1 = Math.floor((y + r) / s);
    for (var ix = x0; ix <= x1; ix++) for (var iy = y0; iy <= y1; iy++) {
      var v = this.cells[this.key(ix, iy)];
      if (v && (!tag || v === tag)) {
        var cx = (ix + 0.5) * s, cy = (iy + 0.5) * s;
        if (Math.hypot(cx - x, cy - y) <= r + s * 0.71) return true;
      }
    }
    return false;
  };
  Occupancy.prototype.hitRect = function (x, y, rot, l, w, pad) {
    var c = Math.cos(rot), s = Math.sin(rot), hl = l / 2 + (pad || 0), hw = w / 2 + (pad || 0), st = this.size * 0.5;
    for (var a = -hl; a <= hl + 1e-6; a += st) for (var b = -hw; b <= hw + 1e-6; b += st) {
      if (this.cells[this.key(Math.floor((x + c * a - s * b) / this.size), Math.floor((y + s * a + c * b) / this.size))]) return true;
    }
    return false;
  };

  /* ================================================================ writer extensions */
  /** polygon with an explicit local normal (+ optional per-vertex colours): cards, skyline, foliage */
  W.quadN = function (pts, uvs, col, nrm, vcols) {
    var n = pts.length, b0 = this.sink.get(this.mat, this.lod, this.chunkKey(), n), base = b0.vc, i;
    var wn = this.wd(nrm[0], nrm[1], nrm[2]), l = Math.hypot(wn[0], wn[1], wn[2]) || 1;
    for (i = 0; i < n; i++) {
      var p = pts[i];
      bvert(b0, this.ox + p[0] * this.c + p[2] * this.s, this.oy + p[1], this.oz - p[0] * this.s + p[2] * this.c,
        wn[0] / l, wn[1] / l, wn[2] / l, uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0, vcols ? vcols[i] : (col || WHITE));
    }
    for (i = 1; i < n - 1; i++) b0.idx.push(base, base + i, base + i + 1);
    this.sink.tris += n - 2;
  };
  /** faceted mesh in the local frame (stylised low-poly, docs/LOWPOLY-SPEC.md): P positions, Nn per-vertex hint
      normals, C per-vertex colours, I triangle indices. Every triangle is emitted unwelded with its own face
      normal (wound outward, i.e. agreeing with the hint normals, since the standard shader flips back faces) and
      the averaged corner colour; colour ALPHA stays per vertex (wind-sway weight) so swaying facets never crack.
      raw: keep the given winding and the hint normals (double-wound grass blades). */
  W.meshL = function (P, Nn, C, I, raw) {
    var nt = (I.length / 3) | 0, b0 = this.sink.get(this.mat, this.lod, this.chunkKey(), nt * 3), self = this, i, k;
    function put(p, n, c) {
      var wn = self.wd(n[0], n[1], n[2]);
      return bvert(b0, self.ox + p[0] * self.c + p[2] * self.s, self.oy + p[1], self.oz - p[0] * self.s + p[2] * self.c,
        wn[0], wn[1], wn[2], 0, 0, c);
    }
    for (i = 0; i < nt; i++) {
      var a = I[i * 3], b = I[i * 3 + 1], c = I[i * 3 + 2], A = P[a], B = P[b], Cc = P[c];
      if (raw) { b0.idx.push(put(A, Nn[a], C[a]), put(B, Nn[b], C[b]), put(Cc, Nn[c], C[c])); continue; }
      var ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
      var g = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], gl = Math.hypot(g[0], g[1], g[2]);
      if (!(gl > 1e-9)) continue;
      var na = Nn[a], nb = Nn[b], nc = Nn[c], flip = g[0] * (na[0] + nb[0] + nc[0]) + g[1] * (na[1] + nb[1] + nc[1]) + g[2] * (na[2] + nb[2] + nc[2]) < 0;
      var fn = flip ? [-g[0] / gl, -g[1] / gl, -g[2] / gl] : [g[0] / gl, g[1] / gl, g[2] / gl];
      var col = [0, 0, 0];
      for (k = 0; k < 3; k++) col[k] = (C[a][k] + C[b][k] + C[c][k]) / 3;
      var i0 = put(A, fn, [col[0], col[1], col[2], C[a][3]]), i1 = put(B, fn, [col[0], col[1], col[2], C[b][3]]), i2 = put(Cc, fn, [col[0], col[1], col[2], C[c][3]]);
      if (flip) b0.idx.push(i0, i2, i1); else b0.idx.push(i0, i1, i2);
    }
    this.sink.tris += nt;
  };
  /** sign in the XY plane at z, facing -Z (the track side); text reads left-to-right for the viewer */
  W.signF = function (x0, x1, y0, y1, z, text, col, variant, color) {
    var a = Math.abs(x1 - x0) / Math.max(0.01, Math.abs(y1 - y0));
    this.sign([[x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z]], text, col, variant, color, a);
  };
  /** sign in the YZ plane at x, facing -X (facing < 0) or +X */
  W.signX = function (z0, z1, y0, y1, x, facing, text, col, variant, color) {
    var a = Math.abs(z1 - z0) / Math.max(0.01, Math.abs(y1 - y0));
    if (facing < 0) this.sign([[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]], text, col, variant, color, a);
    else this.sign([[x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1]], text, col, variant, color, a);
  };
  /** textured wall along X at z (facing -1: -Z / +1: +Z); us = [metres per u tile, metres per v tile]; floors align at local y = 0 */
  W.wallX = function (xa, xb, z, ya, yb, facing, tint, us) {
    var uw = us ? us[0] : 10, vh = us ? us[1] : 14, len = Math.abs(xb - xa) / uw;
    this.face([[xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z]], tint || WHITE,
      [[0, 1 - ya / vh], [len, 1 - ya / vh], [len, 1 - yb / vh], [0, 1 - yb / vh]], [(xa + xb) / 2, (ya + yb) / 2, z - facing]);
  };
  W.wallZ = function (za, zb, x, ya, yb, facing, tint, us) {
    var uw = us ? us[0] : 10, vh = us ? us[1] : 14, len = Math.abs(zb - za) / uw;
    this.face([[x, ya, za], [x, ya, zb], [x, yb, zb], [x, yb, za]], tint || WHITE,
      [[0, 1 - ya / vh], [len, 1 - ya / vh], [len, 1 - yb / vh], [0, 1 - yb / vh]], [x - facing, (ya + yb) / 2, (za + zb) / 2]);
  };
  /** low-poly standing person at local (x, y, z) facing -Z */
  W.person = function (x, y, z, shirt, r, o) {
    o = o || {};
    r = r || Math.random;
    var pick = function (a) { return a[Math.floor(r() * a.length) % a.length]; };
    var s = 0.92 + r() * 0.16, sk = pick(SKIN), sh = shirt || pick(SHIRTS), legs = o.legs || mul(lin('#2a2d36'), 0.9 + r() * 0.3);
    this.box(x, y + 0.42 * s, z, 0.32 * s, 0.84 * s, 0.22 * s, legs);
    this.box(x, y + 1.16 * s, z, 0.44 * s, 0.64 * s, 0.26 * s, sh);
    this.box(x, y + 1.62 * s, z, 0.2 * s, 0.24 * s, 0.22 * s, sk);
    if (o.cap || r() < 0.35) this.box(x, y + 1.78 * s, z - 0.03, 0.24 * s, 0.07 * s, 0.3 * s, o.cap || pick(SHIRTS));
    if (o.armsUp) {
      this.beam([x - 0.2 * s, y + 1.42 * s, z], [x - 0.32 * s, y + 2.05 * s, z - 0.06], 0.09, 0.09, sh);
      this.beam([x + 0.2 * s, y + 1.42 * s, z], [x + 0.32 * s, y + 2.05 * s, z - 0.06], 0.09, 0.09, sh);
    } else {
      this.box(x - 0.27 * s, y + 1.12 * s, z, 0.09 * s, 0.56 * s, 0.12 * s, sh);
      this.box(x + 0.27 * s, y + 1.12 * s, z, 0.09 * s, 0.56 * s, 0.12 * s, sh);
    }
  };

  /* ================================================================ palettes */
  var TEAM = ['#d42a2a', '#1e5aa8', '#f2c200', '#1d1d1f', '#00a86b', '#ff6a00', '#6b2fa0', '#e6e6e6', '#00b3c7', '#a50d24'].map(function (h) { return lin(h); });
  var SHIRTS = ['#d42a2a', '#1e5aa8', '#f2c200', '#ffffff', '#20242a', '#00a86b', '#ff6a00', '#c9ced6', '#6b2fa0', '#e85d9a'].map(function (h) { return lin(h); });
  var SKIN = ['#f1c7a5', '#d9a07a', '#a96f4c', '#6e4630', '#e8b894'].map(function (h) { return lin(h); });
  var BRANDS = ['REDLINE', 'VELOCE OIL', 'KRONOS', 'APEX TYRES', 'NIMBUS ENERGY', 'HALCYON BANK', 'ORBITAL', 'MERIDIAN AIR', 'TORQUE LABS'];

  function paletteFor(def, geom) {
    var th = (def && def.theme) || (geom && geom.theme) || {};
    return {
      th: th, tree: lin(th.tree, '#2f5a2a'), grass: lin(th.grass, '#4f7a34'), accent: lin(th.accent, '#ffb21e'),
      sand: lin(th.sand, '#cfb680'), glow: lin(th.glow || th.accent, '#2bf3ff'), rock: lin(th.rock, '#7c7468'),
      sky: lin(th.sky, '#8ec5f2'), kerbA: lin(th.kerbA, '#d42a2a'), wall: lin(th.wall, '#d8d8d8'), water: lin(th.water, '#2f6f9f')
    };
  }

  /* ================================================================ props */
  function flagPole(wr, x, z, h, col, r) {
    var lod = wr.lod;
    wr.use('metal', lod);
    wr.cyl(x, 0, z, 0.05, 0.035, h, 4, COL.offwhite, { top: false });
    wr.use('paint', lod);
    var fl = 1.5 + (r ? r() : 0.5) * 0.6, fh = 0.9, wv = 0.18;
    var a = [x, h - 0.05, z], b = [x + fl * 0.5, h - 0.05 - wv, z + 0.12], c = [x + fl, h - 0.1, z], d = [x + fl, h - 0.1 - fh, z], e = [x + fl * 0.5, h - fh - wv, z + 0.12], f = [x, h - fh, z];
    wr.face2([a, b, e, f], col);
    wr.face2([b, c, d, e], mul(col, 0.85));
  }
  function rock(wr, r, P, rnd, flat) {
    wr.use('paint', 'detail');
    var c = jit(mix(P.rock, COL.concreteDark, 0.25), rnd, 0.16);
    var k = flat || 0.62;
    wr.blob(0, r * k * 0.35, 0, r, r * k, r * (0.75 + rnd() * 0.4), c, rnd, 0.32, { cutBelow: -r * 0.2, colFn: function (fy) { return fy > 0.55 ? mix(c, P.grass, 0.35) : c; } });
  }
  /** grass tuft: 4..7 leaning blades, each emitted with both windings (material culls back faces, so each side
      shows its own front copy with an up-ish normal that matches the terrain lighting) */
  function grassTuft(wr, rnd, col, tipCol, h, w8) {
    var G = geoNew(), n = 3 + ((rnd() * 3) | 0), i;
    for (i = 0; i < n; i++) {
      var bx = (rnd() - 0.5) * 0.36, bz = (rnd() - 0.5) * 0.36, a = rnd() * TAU, ca = Math.cos(a), sa = Math.sin(a);
      var bw = 0.03 + rnd() * 0.035, hh = h * (0.55 + rnd() * 0.6), la = rnd() * TAU, ln = hh * (0.15 + rnd() * 0.35);
      var lx = Math.cos(la), lz = Math.sin(la), nl = Math.hypot(lx * 0.35, 1, lz * 0.35), nn = [lx * 0.35 / nl, 1 / nl, lz * 0.35 / nl];
      var base = G.P.length, cb = swc(mul(col, 0.42 + rnd() * 0.12), 0), ct = swc(mul(tipCol, 0.9 + rnd() * 0.25), w8);
      G.P.push([bx - sa * bw, -0.04, bz + ca * bw], [bx + sa * bw, -0.04, bz - ca * bw], [bx + lx * ln, hh, bz + lz * ln]);
      G.N.push(nn, nn, nn); G.C.push(cb, cb, ct);
      G.I.push(base, base + 1, base + 2, base + 1, base, base + 2);
    }
    wr.meshL(G.P, G.N, G.C, G.I, true);
  }
  /** roadside delineator post (touge): white post, black band, amber reflector facing the road (-Z) */
  function delineator(wr) {
    wr.use('paint', 'detail');
    wr.boxY(0, -0.2, 0, 0.1, 1.05, 0.1, COL.white);
    wr.boxY(0, 0.72, 0, 0.104, 0.86, 0.104, COL.black);
    wr.boxY(0, 0.76, -0.055, 0.07, 0.84, 0.012, [1.4, 0.62, 0.08, 1]);
  }
  /** wooden utility pole with a cross arm + insulators; returns the GL positions of the 3 wire attachments */
  function utilityPole(wr, h) {
    wr.use('paint', 'all');
    wr.cyl(0, -0.4, 0, 0.16, 0.12, h + 0.4, 6, lin('#5b4632'), { top: true });
    wr.boxY(0, h - 0.75, 0, 0.12, h - 0.6, 2.2, lin('#4a3828'));
    wr.use('paint', 'detail');
    var at = [];
    [-0.95, 0, 0.95].forEach(function (z) {
      wr.cyl(0, h - 0.6, z, 0.05, 0.04, 0.16, 5, lin('#6f7f88'));
      at.push(wr.wp(0, h - 0.47, z));
    });
    wr.use('paint', 'detail');
    wr.boxY(0, 2.6, -0.17, 0.3, 3.1, 0.04, COL.yellow);
    return at;
  }
  function cone(wr, x, z, s) {
    s = s || 1;
    wr.use('paint', 'detail');
    wr.boxY(x, 0, z, 0.42 * s, 0.04 * s, 0.42 * s, COL.orange);
    wr.cyl(x, 0.04 * s, z, 0.17 * s, 0.11 * s, 0.24 * s, 6, COL.orange, { top: false });
    wr.cyl(x, 0.28 * s, z, 0.11 * s, 0.07 * s, 0.14 * s, 6, COL.white, { top: false });
    wr.cyl(x, 0.42 * s, z, 0.07 * s, 0.015 * s, 0.26 * s, 6, COL.orange);
  }
  /** tyre barrier along X (textured with the tyre-wall atlas), front at -Z */
  function tyreStack(wr, l, w, h, color, rnd) {
    l = Math.max(1, l || 6); w = Math.max(0.6, w || 1.4); h = Math.max(0.4, h || 1);
    var tint = color ? mix(WHITE, mul(color, 1.6), 0.35) : WHITE;
    tint = [clamp(tint[0], 0.4, 1.3), clamp(tint[1], 0.4, 1.3), clamp(tint[2], 0.4, 1.3), 1];
    var u = l / 2.4, v = h / 1.2, z0 = -w / 2, z1 = w / 2, x0 = -l / 2, x1 = l / 2;
    wr.use('tyres', 'all');
    wr.face([[x1, -0.1, z0], [x0, -0.1, z0], [x0, h, z0], [x1, h, z0]], tint, [[u, v], [0, v], [0, 0], [u, 0]], [0, h / 2, 0]);
    wr.face([[x0, -0.1, z1], [x1, -0.1, z1], [x1, h, z1], [x0, h, z1]], mul(tint, 0.9), [[0, v], [u, v], [u, 0], [0, 0]], [0, h / 2, 0]);
    var ue = w / 2.4;
    wr.face([[x0, -0.1, z0], [x0, -0.1, z1], [x0, h, z1], [x0, h, z0]], tint, [[0, v], [ue, v], [ue, 0], [0, 0]], [0, h / 2, 0]);
    wr.face([[x1, -0.1, z1], [x1, -0.1, z0], [x1, h, z0], [x1, h, z1]], tint, [[0, v], [ue, v], [ue, 0], [0, 0]], [0, h / 2, 0]);
    wr.use('paint', 'all');
    wr.face([[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]], COL.rubber, null, [0, 0, 0]);
    // conveyor belt facing on long runs (F1 style) + tyre tops (detail)
    if (l > 10 && rnd && rnd() < 0.5) {
      wr.use('paint', 'detail');
      wr.boxY(0, 0.05, z0 - 0.06, l, h * 0.92, 0.04, mix(color || COL.red, COL.dark, 0.35));
    } else {
      wr.use('paint', 'detail');
      var n = Math.min(60, Math.floor(l / 0.62));
      for (var i = 0; i < n; i++) {
        var xc = x0 + 0.31 + i * (l - 0.62) / Math.max(1, n - 1);
        wr.disc(xc, h + 0.012, (z0 + z1) / 2 - w * 0.22, 0.17, 6, mul(COL.rubber, 0.45));
        if (w > 1) wr.disc(xc, h + 0.012, (z0 + z1) / 2 + w * 0.22, 0.17, 6, mul(COL.rubber, 0.45));
      }
    }
  }

  /* ================================================================ trees */
  var ATLAS_FALLBACK = ['spruce', 'pine', 'oak', 'birch', 'poplar', 'palm', 'maple-autumn', 'shrub'];
  var ATLAS_DIMS = { spruce: [16, 7], pine: [18, 9], oak: [13, 12], birch: [14, 7], poplar: [20, 5], palm: [12, 8], 'maple-autumn': [12, 10], shrub: [3, 4.5] };
  /** tree billboard atlas layout (CB.gl.textures.treeAtlasInfo when loaded; identical built-in fallback) */
  function atlasEntries() {
    var T = CB.gl && CB.gl.textures;
    try { if (T && typeof T.treeAtlasInfo === 'function') { var a = T.treeAtlasInfo(1024); if (a && a.byName) return a.byName; } } catch (e) { /* fallback */ }
    var by = {};
    ATLAS_FALLBACK.forEach(function (n, k) {
      var u0 = (k % 4) / 4, v0 = ((k / 4) | 0) / 2;
      by[n] = { name: n, u0: u0, v0: v0, u1: u0 + 0.25, v1: v0 + 0.5, crop: { u0: u0, v0: v0, u1: u0 + 0.25, v1: v0 + 0.5 }, heightM: ATLAS_DIMS[n][0], widthM: ATLAS_DIMS[n][1] };
    });
    return by;
  }
  var SPECIES = {
    pine: { form: 'conifer', atlas: 'pine', tiers: 3, trunk: 0.36, leaf: '#2f5a2a', hk: 3.8, bark: '#5a3d28' },
    spruce: { form: 'conifer', atlas: 'spruce', tiers: 4, trunk: 0.1, leaf: '#24482a', hk: 4.0, bark: '#4a3424' },
    cedar: { form: 'conifer', atlas: 'spruce', tiers: 4, trunk: 0.16, leaf: '#21422b', hk: 4.6, bark: '#5b3a26' },
    oak: { form: 'broad', atlas: 'oak', leaf: '#41702d', hk: 2.7, bark: '#4a3424' },
    ash: { form: 'broad', atlas: 'oak', leaf: '#4d7d34', hk: 3.0, bark: '#5a4a3a' },
    maple: { form: 'broad', atlas: 'maple-autumn', leaf: '#b8481e', alt: ['#c9661f', '#d79a2a', '#9e2f1c', '#4f7a30'], hk: 2.7, bark: '#3e2c22' },
    birch: { form: 'broad', atlas: 'birch', leaf: '#6f9c3e', hk: 3.4, bark: '#dcd8cc', slim: true },
    poplar: { form: 'column', atlas: 'poplar', leaf: '#4f7f35', hk: 5.4, bark: '#5a4a3a' },
    cypress: { form: 'column', atlas: 'poplar', leaf: '#2f4f2a', hk: 4.8, bark: '#4a3424' },
    palm: { form: 'palm', atlas: 'palm', leaf: '#4f7d2f', hk: 3.6, bark: '#8a6a48' },
    shrub: { form: 'bush', atlas: 'shrub', leaf: '#3f6a2c', hk: 0.9, bark: '#4a3424' }
  };
  function speciesOf(v) {
    v = String(v || 'oak').toLowerCase();
    if (SPECIES[v]) return v;
    if (/maple|autumn/.test(v)) return 'maple';
    if (/fir|spruce/.test(v)) return 'spruce';
    if (/bush|shrub|hedge/.test(v)) return 'shrub';
    if (/willow|elm|beech|lime/.test(v)) return 'oak';
    return 'oak';
  }
  /** deterministic per-tree shape from the writer position, so near model and far card always match */
  function treeShape(wr, variant, r, P) {
    var spk = speciesOf(variant), sp = SPECIES[spk];
    var h = hash2(Math.round(wr.ox * 4), Math.round(wr.oz * 4), 7), h2 = hash2(Math.round(wr.oz * 4), Math.round(wr.ox * 4), 13);
    var R = clamp(fin(r, 3), 0.5, 9) * (0.9 + h * 0.2);
    var H = R * sp.hk * (0.85 + h2 * 0.3);
    if (sp.form === 'palm') H = clamp(H, 6, 16);
    var leaf = sp.form === 'conifer' ? mix(lin(sp.leaf), P.tree, 0.3) : mix(lin(sp.leaf), P.tree, 0.25);
    if (sp.alt && h2 < 0.65) leaf = lin(sp.alt[Math.floor(h * sp.alt.length) % sp.alt.length]);
    return { spk: spk, sp: sp, R: R, H: H, leaf: leaf, h: h, h2: h2 };
  }
  /* ---- smooth foliage geometry (indexed, per-vertex normals + colours; colour alpha encodes wind sway) ---- */
  /** sway weight w (0..1) is stored as alpha = 1 - 0.01 w: invisible to the standard shader (alpha ~1, far above any
      alpha-test threshold) and decoded by the foliage vertex shader (wind sway). */
  function swc(c, w) { return [c[0], c[1], c[2], 1 - 0.01 * clamp(w, 0, 1)]; }
  function geoNew() { return { P: [], N: [], C: [], I: [] }; }
  /** canopy clump: jittered icosahedron with smooth (ellipsoid + tree-outward) normals, darker underside / interior */
  function clumpG(G, cx, cy, cz, rx, ry, rz, col, rnd, jitter, o) {
    var base = G.P.length, ctr = o.ctr || [0, cy, 0], H = o.H || 10, sk = o.sway == null ? 1 : o.sway, Rr = o.R || rx;
    var ox = cx - ctr[0], oy = cy - ctr[1], oz = cz - ctr[2], ol = Math.hypot(ox, oy, oz) || 1;
    for (var i = 0; i < 12; i++) {
      var d = ICO.v[i], k = 1 + (rnd() - 0.5) * 2 * jitter;
      var px = cx + d[0] * rx * k, py = cy + d[1] * ry * k, pz = cz + d[2] * rz * k;
      var nx = d[0] / rx, ny = d[1] / ry, nz = d[2] / rz, nl = Math.hypot(nx, ny, nz) || 1;
      nx = nx / nl * 0.62 + ox / ol * 0.38; ny = ny / nl * 0.62 + oy / ol * 0.38 + 0.22; nz = nz / nl * 0.62 + oz / ol * 0.38;
      nl = Math.hypot(nx, ny, nz) || 1;
      var rad = Math.hypot(px - ctr[0], pz - ctr[2]) / Math.max(0.5, Rr);
      var sh = (0.5 + 0.5 * (d[1] * 0.5 + 0.5)) * (0.72 + 0.34 * clamp(rad, 0, 1)) * (0.94 + rnd() * 0.12) * (o.shade || 1);
      var c = mul(col, sh);
      if (d[1] > 0.4) c = mix(c, mul(o.tip || col, sh * 1.08), 0.35);
      G.P.push([px, py, pz]); G.N.push([nx / nl, ny / nl, nz / nl]);
      G.C.push(swc(c, Math.pow(clamp(py / H, 0, 1), 1.5) * sk));
    }
    for (var f = 0; f < 20; f++) G.I.push(base + ICO.f[f][0], base + ICO.f[f][1], base + ICO.f[f][2]);
  }
  /** tapered smooth tube a -> b (no caps); colours ca / cb, sway weights wa / wb */
  function tubeG(G, a, b, r0, r1, seg, ca, cb, wa, wb, rot) {
    var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-6) return;
    var ex = [d[0] / L, d[1] / L, d[2] / L], up = Math.abs(ex[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    var u = norm3(cross3(ex, up)), v = cross3(u, ex), base = G.P.length, i;
    for (i = 0; i < seg; i++) {
      var t = (rot || 0) + i / seg * TAU, ct = Math.cos(t), st = Math.sin(t);
      var n = [u[0] * ct + v[0] * st, u[1] * ct + v[1] * st, u[2] * ct + v[2] * st];
      var shd = 0.86 + 0.14 * ct;
      G.P.push([a[0] + n[0] * r0, a[1] + n[1] * r0, a[2] + n[2] * r0]); G.N.push(n); G.C.push(swc(mul(ca, shd), wa));
      G.P.push([b[0] + n[0] * r1, b[1] + n[1] * r1, b[2] + n[2] * r1]); G.N.push(n); G.C.push(swc(mul(cb, shd), wb));
    }
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg, a0 = base + i * 2, a1 = base + j * 2;
      G.I.push(a0, a1, a1 + 1, a0, a1 + 1, a0 + 1);
    }
  }
  /** layered conifer: trunk + 4..7 stacked skirts with a star-shaped (branch-tip) hem; back faces of the open
      cones give a dark underside for free (the shader flips back-facing normals). */
  function coniferG(G, t, sp, leaf, bark, rnd) {
    var R = t.R, H = t.H, th = H * sp.trunk + H * 0.05, hk = Math.min(1, H / 14);
    var nt = t.lite ? 4 : clamp(Math.round(H / 3), 4, 6), span = H - th, rot0 = rnd() * TAU, i, j;
    tubeG(G, [0, -0.4, 0], [0, th + span * 0.55, 0], R * 0.13, R * 0.05, 6, mul(bark, 0.72), bark, 0, 0.25 * hk, rot0);
    var tipC = mix(leaf, lin('#5f9a4a'), 0.16), K = t.lite ? 5 : 7;
    for (i = 0; i < nt; i++) {
      var f = i / (nt - 1), yb = th + span * 0.8 * Math.pow(f, 0.92);
      var apex = i === nt - 1 ? H : Math.min(H, yb + span * (0.42 - 0.16 * f));
      var rr = R * (1.02 - 0.74 * f) * (0.9 + rnd() * 0.2), hgt = apex - yb;
      var shade = 0.66 + 0.4 * f, base = G.P.length, rot = rot0 + i * 0.7 + rnd() * 0.5;
      var ax = (rnd() - 0.5) * R * 0.05, az = (rnd() - 0.5) * R * 0.05;
      G.P.push([ax, apex, az]); G.N.push([0, 1, 0]); G.C.push(swc(mul(tipC, shade * 1.12), Math.pow(apex / H, 1.5) * hk));
      for (j = 0; j < K * 2; j++) {
        var a = rot + j / (K * 2) * TAU, outer = !(j & 1), ca = Math.cos(a), sa = Math.sin(a);
        var r2 = outer ? rr * (0.92 + rnd() * 0.16) : rr * 0.66, y = outer ? yb - rr * (0.16 + rnd() * 0.08) : yb + rr * 0.05;
        var nl = Math.hypot(hgt, rr * 1.25) || 1;
        G.P.push([ca * r2, y, sa * r2]);
        G.N.push([ca * hgt / nl, rr * 1.25 / nl, sa * hgt / nl]);
        var c = outer ? mix(mul(leaf, shade), mul(tipC, shade), 0.45) : mul(leaf, shade * 0.6);
        G.C.push(swc(mul(c, 0.94 + rnd() * 0.12), Math.pow(clamp(y / H, 0, 1), 1.5) * hk + (outer ? 0.12 : 0)));
      }
      for (j = 0; j < K * 2; j++) G.I.push(base, base + 1 + j, base + 1 + (j + 1) % (K * 2));
    }
  }
  /** deciduous: bent trunk + branches + 6..9 clustered canopy clumps */
  function broadG(G, t, sp, leaf, bark, rnd) {
    var R = t.R, H = t.H, slim = !!sp.slim, tb = H * (slim ? 0.42 : 0.36), hk = Math.min(1, H / 12), i;
    var cy = tb + (H - tb) * 0.5, ry = (H - tb) * 0.52, ctr = [0, cy, 0];
    var lean = [(rnd() - 0.5) * R * 0.18, (rnd() - 0.5) * R * 0.18];
    var mid = [lean[0] * 0.5, tb * 0.55, lean[1] * 0.5], top = [lean[0], cy, lean[1]];
    var trunkR = R * (slim ? 0.075 : 0.12), bk = slim ? COL.birch : bark;
    tubeG(G, [0, -0.4, 0], mid, trunkR * 1.25, trunkR, 6, mul(bk, 0.7), bk, 0, 0.05 * hk, rnd() * TAU);
    tubeG(G, mid, top, trunkR, trunkR * 0.55, 5, bk, mul(bk, 0.9), 0.05 * hk, 0.3 * hk, rnd() * TAU);
    if (slim) {   // birch: dark lenticel bands
      for (var bi = 0; bi < 4; bi++) {
        var by = 0.4 + bi * tb * 0.26 + rnd() * 0.3, tt = by / tb;
        tubeG(G, [lean[0] * tt * 0.5, by, lean[1] * tt * 0.5], [lean[0] * tt * 0.5, by + 0.12, lean[1] * tt * 0.5], trunkR * 1.07, trunkR * 1.07, 6, COL.dark, COL.dark, 0, 0);
      }
    }
    var nc = t.lite ? 4 : clamp(Math.round(4 + R * 0.6), 5, 7), ang0 = rnd() * TAU;
    var tip = mix(leaf, lin('#b6c95a'), 0.22);
    var opts = { ctr: ctr, H: H, R: R, tip: tip, sway: hk };
    // branches toward the ring clumps
    for (i = 0; i < (t.lite ? 0 : 3); i++) {
      var ba = ang0 + i * TAU / 3 + 0.4;
      tubeG(G, [mid[0], tb * (0.75 + i * 0.1), mid[2]], [Math.cos(ba) * R * 0.55, cy + ry * 0.1, Math.sin(ba) * R * 0.55], trunkR * 0.45, trunkR * 0.2, 4, bk, bk, 0.04 * hk, 0.4 * hk);
    }
    clumpG(G, top[0], cy - ry * 0.18, top[2], R * 0.72, ry * 0.55, R * 0.72, mul(leaf, 0.82), rnd, 0.16, opts);
    clumpG(G, top[0] + (rnd() - 0.5) * R * 0.3, cy + ry * 0.48, top[2] + (rnd() - 0.5) * R * 0.3, R * 0.6, ry * 0.5, R * 0.6, leaf, rnd, 0.18, opts);
    for (i = 0; i < nc - 2; i++) {
      var a = ang0 + i / (nc - 2) * TAU + (rnd() - 0.5) * 0.5, rd = R * (0.48 + rnd() * 0.16);
      var cr = R * (0.44 + rnd() * 0.18), cc = jit(leaf, rnd, 0.1);
      if (rnd() < 0.3) cc = mix(cc, tip, 0.3);
      clumpG(G, top[0] + Math.cos(a) * rd, cy + (rnd() - 0.42) * ry * 0.75, top[2] + Math.sin(a) * rd, cr, cr * (0.75 + rnd() * 0.2), cr, cc, rnd, 0.2, opts);
    }
  }
  /** column (poplar / cypress): short trunk + stacked narrow clumps */
  function columnG(G, t, sp, leaf, bark, rnd) {
    var R = t.R, H = t.H, hk = Math.min(1, H / 14), n = 5, opts = { ctr: [0, H * 0.55, 0], H: H, R: R * 0.55, tip: mix(leaf, lin('#9fb85a'), 0.15), sway: hk };
    tubeG(G, [0, -0.4, 0], [0, H * 0.3, 0], R * 0.12, R * 0.07, 5, mul(bark, 0.75), bark, 0, 0.1 * hk);
    for (var i = 0; i < n; i++) {
      var f = i / (n - 1), y = H * (0.2 + 0.68 * f), rr = R * 0.55 * (1 - 0.55 * Math.pow(f, 1.6)) * (0.9 + rnd() * 0.2);
      clumpG(G, (rnd() - 0.5) * R * 0.12, y, (rnd() - 0.5) * R * 0.12, rr, H * 0.17, rr, mul(jit(leaf, rnd, 0.08), 0.85 + f * 0.25), rnd, 0.14, opts);
    }
  }
  /** shrub: 3..4 low clumps */
  function bushG(G, t, leaf, rnd) {
    var R = t.R, n = 2 + (rnd() < 0.5 ? 1 : 0), opts = { ctr: [0, R * 0.2, 0], H: R * 4, R: R, tip: mix(leaf, lin('#a5bd55'), 0.2), sway: 0.25 };
    clumpG(G, 0, R * 0.5, 0, R * 0.8, R * 0.62, R * 0.8, mul(leaf, 0.9), rnd, 0.18, opts);
    for (var i = 0; i < n - 1; i++) {
      var a = i / (n - 1) * TAU + rnd(), d = R * 0.55, cr = R * (0.5 + rnd() * 0.2);
      clumpG(G, Math.cos(a) * d, cr * 0.55, Math.sin(a) * d, cr, cr * 0.75, cr, jit(leaf, rnd, 0.1), rnd, 0.2, opts);
    }
  }
  function treeNear(wr, variant, r, P, rnd, lite) {
    var t = treeShape(wr, variant, r, P), sp = t.sp, R = t.R, H = t.H, i;
    t.lite = !!lite;
    if (sp.form === 'bush') wr.use('foliage'); else wr.use('foliage', 'near');
    var leaf = jit(t.leaf, rnd, 0.14), bark = jit(lin(sp.bark), rnd, 0.1);
    if (sp.form !== 'palm') {
      var G = geoNew();
      if (sp.form === 'conifer') coniferG(G, t, sp, leaf, bark, rnd);
      else if (sp.form === 'broad') broadG(G, t, sp, leaf, bark, rnd);
      else if (sp.form === 'column') columnG(G, t, sp, leaf, bark, rnd);
      else bushG(G, t, leaf, rnd);
      wr.meshL(G.P, G.N, G.C, G.I);
      return t;
    } else if (sp.form === 'palm') {
      var lean = (t.h - 0.5) * 0.5, la = t.h2 * TAU, segs = 4, prev = [0, -0.3, 0];
      for (i = 1; i <= segs; i++) {
        var f = i / segs, off = lean * f * f * H * 0.5;
        var p = [Math.cos(la) * off, f * H, Math.sin(la) * off];
        wr.tube(prev, p, R * 0.12 * (1 - (f - 0.25) * 0.35) + 0.08, 5, i % 2 ? bark : mul(bark, 0.85), { r1: R * 0.12 * (1 - f * 0.35) + 0.08 });
        prev = p;
      }
      var tp = prev, nf = 7, Lf = R * 1.7;
      for (i = 0; i < nf; i++) {
        var a = i / nf * TAU + rnd() * 0.4, ca = Math.cos(a), sa = Math.sin(a), droop = 0.25 + rnd() * 0.35;
        var mid = [tp[0] + ca * Lf * 0.5, tp[1] + Lf * 0.12, tp[2] + sa * Lf * 0.5];
        var tip = [tp[0] + ca * Lf, tp[1] - Lf * droop, tp[2] + sa * Lf];
        var wx = -sa * Lf * 0.17, wz = ca * Lf * 0.17;
        var mL = [mid[0] + wx, mid[1] - 0.15, mid[2] + wz], mR = [mid[0] - wx, mid[1] - 0.15, mid[2] - wz];
        var lc = mul(leaf, 0.85 + rnd() * 0.3);
        wr.face2([tp, mL, mid], lc); wr.face2([tp, mid, mR], lc);
        wr.face2([mL, tip, mid], mul(lc, 0.9)); wr.face2([mid, tip, mR], mul(lc, 0.9));
      }
      wr.blob(tp[0], tp[1] - 0.3, tp[2], 0.5, 0.4, 0.5, lin('#5a4428'), rnd, 0.2);
    } else {
      wr.blob(0, R * 0.42, 0, R, R * 0.68, R * (0.8 + rnd() * 0.4), leaf, rnd, 0.25, { cutBelow: -0.1 });
    }
    return t;
  }
  /** crossed alpha-tested cards from the tree atlas (lod 'far' = paired with a near model, 'bill' = card only) */
  function treeFar(wr, variant, r, P, rnd, atlas, lod) {
    var t = treeShape(wr, variant, r, P), sp = t.sp;
    if (sp.form === 'bush') return t;
    var e = (atlas && (atlas[sp.atlas] || atlas.oak)) || null;
    if (!e) return t;
    wr.use('treeCard', lod || 'far');
    var H = t.H, hm = fin(e.heightM, 12), wm = fin(e.widthM, 8), bw = H * wm / hm * 0.5;
    var u0 = e.u0, u1 = e.u1, vb = e.v1, vt = e.crop ? e.crop.v0 : e.v0;
    var lf = t.leaf, mx = Math.max(0.04, lf[0], lf[1], lf[2]);
    var tint = mix(WHITE, [lf[0] / mx, lf[1] / mx, lf[2] / mx, 1], sp.alt ? 0.3 : 0.2);
    var k = 0.88 + t.h * 0.2;
    tint = [tint[0] * k, tint[1] * k, tint[2] * k, 1];
    var a0 = t.h2 * PI, hk = Math.min(1, H / 14);
    // darker base (ground occlusion), sway weight at the top (foliage vertex shader)
    var cb = swc(mul(tint, 0.8), 0), ct = swc(tint, hk);
    for (var i = 0; i < 2; i++) {
      var a = a0 + i * PI / 2, ca = Math.cos(a), sa = Math.sin(a);
      wr.quadN([[-ca * bw, -0.3, -sa * bw], [ca * bw, -0.3, sa * bw], [ca * bw, H, sa * bw], [-ca * bw, H, -sa * bw]],
        [[u0, vb], [u1, vb], [u1, vt], [u0, vt]], tint, [0, 1, 0], [cb, cb, ct, ct]);
    }
    return t;
  }

  /* ================================================================ structures
     All trackside builders work in the writer's local frame: X along the track, Y up, Z away from the
     track; the footprint is x in [-l/2, l/2], z in [-w/2, w/2] and the track-facing front is z = -w/2. */
  function addLight(B, lx, ly, lz, dir, col, range, inner, outer) {
    var wr = B.wr, p = wr.wp(lx, ly, lz), d = dir ? norm3(wr.wd(dir[0], dir[1], dir[2])) : null;
    B.lights.push({ pos: p, dir: d, color: col || [2.4, 2.1, 1.7], range: range || 40,
      cosInner: Math.cos((inner || 32) * DEG), cosOuter: Math.cos((outer || 62) * DEG), type: d ? 1 : 0 });
  }

  function grandstand(B, o) {
    var wr = B.wr, P = B.P, rnd = B.rnd;
    var L = Math.max(10, o.l), D = Math.max(6, o.w), H = Math.max(5, o.h || 14);
    var z0 = -D / 2, z1 = D / 2, body = alb(lin(o.color || '#c8cdd4')), acc = lin(o.accent || P.th.accent || '#d42a2a');
    var front = 1.5, back = Math.max(3.2, H * 0.66), dz0 = z0 + 0.9, dz1 = z1 - 0.9;
    var tiers = clamp(Math.round((dz1 - dz0) / 0.85), 5, 40);
    var conc = mix(body, COL.concrete, 0.5);
    // structure: front wall, side walls (stepped profile), back wall
    wr.use('paint', 'all');
    wr.boxY(0, -2, z0 + 0.45, L, front, 0.9, conc, { cols: { nz: mul(conc, 0.95) } });
    var prof = [[z0, -2], [z0, front], [dz0, front], [dz1, back], [z1, back], [z1, -2]];
    [-1, 1].forEach(function (sx) {
      var x = sx * L / 2;
      wr.face(prof.map(function (p) { return [x, p[1], p[0]]; }), mul(body, 0.92), null, [0, back / 2, 0]);
      wr.face(prof.map(function (p) { return [x - sx * 0.35, p[1], p[0]]; }), mul(body, 0.8), null, [x * 2, back / 2, 0]);
    });
    wr.boxY(0, -2, z1 - 0.25, L, back + 1.1, 0.5, mul(body, 0.86), { cols: { pz: mul(body, 0.7) } });
    // accent band on the back wall top
    wr.boxY(0, back + 0.2, z1 - 0.25, L + 0.1, back + 1.1, 0.56, acc);
    // seating deck: crowd sheet (crowd texture: 8 tiers per tile in v, ~26 m per tile in u)
    wr.use('crowd', 'all');
    var vT = tiers / 8, uL = L / 26;
    wr.face([[-L / 2 + 0.35, front + 0.05, dz0], [L / 2 - 0.35, front + 0.05, dz0], [L / 2 - 0.35, back + 0.05, dz1], [-L / 2 + 0.35, back + 0.05, dz1]],
      WHITE, [[0, vT], [uL, vT], [uL, 0], [0, 0]], [0, -10, 0]);
    // aisles + front railing
    wr.use('paint', 'all');
    var aisles = Math.max(1, Math.round(L / 14));
    for (var a = 1; a < aisles; a++) {
      var ax = -L / 2 + a * L / aisles;
      wr.face([[ax - 0.55, front + 0.09, dz0], [ax + 0.55, front + 0.09, dz0], [ax + 0.55, back + 0.09, dz1], [ax - 0.55, back + 0.09, dz1]], COL.offwhite, null, [ax, -10, 0]);
    }
    wr.use('metal', 'detail');
    wr.tube([-L / 2, front + 1.0, z0 + 0.15], [L / 2, front + 1.0, z0 + 0.15], 0.04, 4, COL.steel);
    // front hoardings with sponsor signs (atlas)
    wr.use('signs', 'all');
    var nb = Math.max(1, Math.floor(L / 9)), bw = L / nb;
    for (var k = 0; k < nb; k++) {
      var bx0 = -L / 2 + k * bw + 0.15, bx1 = bx0 + bw - 0.3, hh = Math.min(1.25, (bx1 - bx0) / 4);
      wr.signF(bx0, bx1, 0.15, 0.15 + hh, z0 - 0.02, B.brand(rnd), WHITE);
    }
    // roof: columns at the back, cantilever trusses, slab, fascia sign
    var roofB = back + 4.2, roofF = roofB + 1.4, rz0 = z0 + D * 0.05, rz1 = z1 + 0.4;
    wr.use('metal', 'all');
    var cols = Math.max(2, Math.round(L / 11) + 1);
    for (var c = 0; c < cols; c++) {
      var cx = -L / 2 + 0.3 + c * (L - 0.6) / (cols - 1);
      wr.boxY(cx, back, z1 - 0.3, 0.32, roofB + 0.1, 0.32, COL.steel);
      wr.beam([cx, roofB + 0.05, z1 - 0.3], [cx, roofF - 0.1, rz0 + 0.6], 0.22, 0.5, mul(COL.steel, 0.9));
      wr.beam([cx, back + 1.2, z1 - 0.3], [cx, roofB - 0.2, (z1 + rz0) / 2], 0.12, 0.12, mul(COL.steel, 0.85));
    }
    wr.use('metal', 'all');
    var slab = [[-L / 2 - 0.4, roofF, rz0], [L / 2 + 0.4, roofF, rz0], [L / 2 + 0.4, roofB, rz1], [-L / 2 - 0.4, roofB, rz1]];
    wr.face(slab, mix(body, COL.white, 0.5), null, [0, -50, 0]);
    wr.face(slab.map(function (p) { return [p[0], p[1] - 0.25, p[2]]; }), mul(COL.steel, 0.55), null, [0, 50, 0]);
    // fascia
    wr.use('paint', 'all');
    wr.boxY(0, roofF - 1.25, rz0 - 0.1, L + 0.8, roofF + 0.05, 0.2, acc);
    wr.use('signs', 'all');
    var fsw = Math.min(L * 0.45, 4.6 * 4), fsh = fsw / 4;
    if (fsh > 1.6) { fsh = 1.6; fsw = fsh * 4; }
    wr.signF(-fsw / 2, fsw / 2, roofF - 0.65 - fsh / 2, roofF - 0.65 + fsh / 2, rz0 - 0.22, B.brand(rnd), WHITE);
    // floodlight strip under the fascia (lit at dusk / night)
    wr.use('lamp', 'all');
    wr.face([[-L / 2, roofF - 1.32, rz0 + 0.1], [L / 2, roofF - 1.32, rz0 + 0.1], [L / 2, roofF - 1.32, rz0 + 0.7], [-L / 2, roofF - 1.32, rz0 + 0.7]], [2.6, 2.5, 2.2, 1], null, [0, 50, 0]);
    var nl = Math.max(1, Math.round(L / 45));
    for (var li = 0; li < nl; li++) addLight(B, -L / 2 + (li + 0.5) * L / nl, roofF - 1.4, rz0, [0, -0.75, -1], [1.3, 1.25, 1.1], 55, 40, 75);
    // roof flags + TV platform
    wr.oy += roofB;
    for (var f = 0; f < Math.min(6, Math.floor(L / 12)); f++) flagPole(wr, -L / 2 + 4 + f * 12, rz1 - 1.5, 4, rnd.pick(TEAM), rnd);
    wr.oy -= roofB;
    return { roofY: roofF };
  }

  function pitBuilding(B, o) {
    var wr = B.wr, P = B.P, rnd = B.rnd;
    var L = Math.max(30, o.l), D = Math.max(10, o.w), H = Math.max(6.5, o.h || 9);
    var z0 = -D / 2, z1 = D / 2, body = alb(lin(o.color || '#e6e6e6')), acc = lin(o.accent || P.th.accent || '#d42a2a');
    var gH = Math.min(4.8, H * 0.52), nb = Math.max(3, Math.floor(L / 7.2)), bw = L / nb;
    var lit = B.night || o.lit;
    // core shell: back + sides + roof slab
    wr.use('paint', 'all');
    wr.boxY(0, -2, (z0 + 6.2 + z1) / 2, L, H, z1 - z0 - 6.2, body, { skip: { nz: true }, top: mul(body, 0.75) });
    // ground floor: pillars, header, garage bays
    for (var i = 0; i < nb; i++) {
      var x0 = -L / 2 + i * bw, xc = x0 + bw / 2, team = TEAM[i % TEAM.length];
      if (Array.isArray(o.teams) && o.teams.length) {   // F1 circuits: real team colours in box order (docs/F1-SPEC.md)
        var ti = Math.min(o.teams.length - 1, Math.floor(i * o.teams.length / nb));
        team = alb(lin(o.teams[o.side > 0 ? ti : o.teams.length - 1 - ti]), 0.8);
      }
      wr.use('paint', 'all');
      wr.boxY(x0 + 0.3, -1, z0 + 0.4, 0.6, gH, 0.8, mul(body, 0.96));
      // interior (lit garage): back wall, floor, ceiling, side walls in team colour
      wr.use('paint', 'all');
      wr.face([[x0 + 0.6, 0, z0 + 6.1], [x0 + bw, 0, z0 + 6.1], [x0 + bw, gH - 0.9, z0 + 6.1], [x0 + 0.6, gH - 0.9, z0 + 6.1]], mix(COL.offwhite, team, 0.35), null, [xc, 1, z0]);
      wr.use('lamp', 'all');
      wr.face([[x0 + 0.6, gH - 0.95, z0 + 0.8], [x0 + bw, gH - 0.95, z0 + 0.8], [x0 + bw, gH - 0.95, z0 + 6.1], [x0 + 0.6, gH - 0.95, z0 + 6.1]], [1.4, 1.38, 1.3, 1], null, [xc, 0, z0 + 3]);
      wr.use('paint', 'all');
      wr.face([[x0 + 0.6, 0.02, z0 + 0.8], [x0 + bw, 0.02, z0 + 0.8], [x0 + bw, 0.02, z0 + 6.1], [x0 + 0.6, 0.02, z0 + 6.1]], lin('#8d9096'), null, [xc, 5, z0 + 3]);
      wr.face([[x0 + 0.62, 0, z0 + 0.8], [x0 + 0.62, 0, z0 + 6.1], [x0 + 0.62, gH - 0.95, z0 + 6.1], [x0 + 0.62, gH - 0.95, z0 + 0.8]], mul(team, 0.8), null, [xc, 1, z0 + 3]);
      // tool chests + tyre racks inside (detail)
      wr.use('paint', 'detail');
      wr.boxY(xc - bw * 0.25, 0, z0 + 5.6, bw * 0.3, 1.0, 0.6, team);
      wr.boxY(xc + bw * 0.22, 0, z0 + 5.5, bw * 0.28, 1.6, 0.5, mul(COL.dark, 1.2));
      for (var t = 0; t < 4; t++) wr.cyl(xc + bw * 0.12 + t * 0.66, 0, z0 + 4.3, 0.32, 0.32, 0.6, 6, COL.rubber, { colTop: mul(COL.rubber, 2) });
      // half-open roll-up door
      wr.use('metal', 'all');
      var dr = rnd.range(0.25, 0.55);
      wr.boxY(xc + 0.3, gH - 0.95 - (gH - 0.95) * dr, z0 + 0.7, bw - 0.6, gH - 0.95, 0.06, mix(team, COL.steel, 0.35));
      // team board over the bay
      wr.use('paint', 'all');
      wr.boxY(xc + 0.3, gH - 0.85, z0 - 0.05, bw - 0.9, gH - 0.15, 0.1, team, { cols: { nz: team } });
      wr.boxY(xc + 0.3, gH - 0.55, z0 - 0.11, bw - 1.6, gH - 0.45, 0.02, COL.white);
    }
    wr.use('paint', 'all');
    wr.boxY(L / 2 - 0.3, -1, z0 + 0.4, 0.6, gH, 0.8, mul(body, 0.96));
    wr.boxY(0, gH - 0.15, z0 + 0.5, L, gH + 0.35, 1.0, body);
    // first floor balcony slab + railing
    wr.boxY(0, gH + 0.15, z0 - 1.2, L + 0.4, gH + 0.45, 2.4, mul(body, 0.92), { bottom: mul(body, 0.7) });
    wr.use('metal', 'detail');
    wr.tube([-L / 2, gH + 1.45, z0 - 2.3], [L / 2, gH + 1.45, z0 - 2.3], 0.04, 4, COL.steel);
    for (var rp = -L / 2; rp <= L / 2 + 0.01; rp += 2.5) wr.boxY(rp, gH + 0.45, z0 - 2.3, 0.05, gH + 1.45, 0.05, COL.steel);
    // glazed hospitality floor (set back) with mullions
    var gTop = H - 0.55;
    wr.use('glass', 'all');
    wr.face([[-L / 2, gH + 0.45, z0 + 0.9], [L / 2, gH + 0.45, z0 + 0.9], [L / 2, gTop, z0 + 0.25], [-L / 2, gTop, z0 + 0.25]], lin('#6f8aa6'), null, [0, gH, z1]);
    wr.use('metal', 'all');
    for (var m = -L / 2; m <= L / 2 + 0.01; m += 2.4) wr.beam([m, gH + 0.45, z0 + 0.86], [m, gTop, z0 + 0.21], 0.1, 0.1, mul(COL.steel, 0.6));
    // roof slab with overhang + fascia band + sign
    wr.use('paint', 'all');
    wr.boxY(0, H - 0.55, z0 - 1.6 + (z1 - z0 + 1.6) / 2 - 0.0, L + 1.2, H, z1 - z0 + 1.6 + 0.0, mix(body, COL.white, 0.4), { bottom: mul(body, 0.65) });
    wr.boxY(0, H - 0.95, z0 - 1.65, L + 1.25, H + 0.05, 0.18, acc);
    wr.use(B.night || o.lit ? 'signsLit' : 'signs', 'all');
    var sw = Math.min(L * 0.32, 14), sh = sw / 4;
    var ns = L > 120 ? 2 : 1;
    for (var sI = 0; sI < ns; sI++) {
      var sx = ns === 1 ? 0 : (sI ? L * 0.25 : -L * 0.25);
      wr.signF(sx - sw / 2, sx + sw / 2, H + 0.1, H + 0.1 + sh, z0 - 1.2, o.text || 'PIT LANE', WHITE, 'plain', normHex(o.accent || P.th.accent || '#d42a2a'));
      wr.use('metal', 'all');
      wr.boxY(sx, H, z0 - 1.0, sw, H + 0.12, 0.3, COL.dark);
      wr.boxY(sx - sw * 0.35, H, z0 - 1.0, 0.12, H + sh * 0.9, 0.12, COL.dark);
      wr.boxY(sx + sw * 0.35, H, z0 - 1.0, 0.12, H + sh * 0.9, 0.12, COL.dark);
      wr.use(B.night || o.lit ? 'signsLit' : 'signs', 'all');
    }
    // roof plant (detail): AC units, vents, antenna, flags
    wr.use('metal', 'detail');
    for (var u = 0; u < Math.floor(L / 25); u++) {
      var ux = -L / 2 + 10 + u * 25 + rnd.range(-3, 3);
      wr.boxY(ux, H, z1 - 3, 3.2, H + 1.4, 2.2, COL.steel, { top: mul(COL.steel, 1.1) });
      wr.cyl(ux - 0.7, H + 1.4, z1 - 3, 0.6, 0.6, 0.12, 8, COL.dark);
      wr.cyl(ux + 0.8, H + 1.4, z1 - 3, 0.6, 0.6, 0.12, 8, COL.dark);
    }
    wr.cyl(L / 2 - 6, H, z1 - 2, 0.1, 0.05, 9, 5, COL.offwhite);
    for (var f = 0; f < 5; f++) { wr.oy += H; flagPole(wr, -L / 2 + 6 + f * 4, z1 - 1, 5, rnd.pick(TEAM), rnd); wr.oy -= H; }
    // glass stair tower at one end
    wr.use('glass', 'all');
    wr.boxY(-L / 2 + 3, 0, z1 - 3, 5.5, H + 3, 5.5, lin('#5d7690'));
    wr.use('paint', 'all');
    wr.boxY(-L / 2 + 3, H + 3, z1 - 3, 6, H + 3.4, 6, body);
    if (lit) addLight(B, 0, gH - 0.5, z0 - 1.5, [0, -1, -0.4], [1.3, 1.25, 1.12], 30, 40, 75);
    if (lit && L > 120) { addLight(B, -L * 0.3, gH - 0.5, z0 - 1.5, [0, -1, -0.4], [1.3, 1.25, 1.12], 30, 40, 75); addLight(B, L * 0.3, gH - 0.5, z0 - 1.5, [0, -1, -0.4], [1.3, 1.25, 1.12], 30, 40, 75); }
  }

  /** transporter truck (paddock): cab + trailer, local X along its length */
  function truck(wr, col, rnd) {
    wr.use('paint', 'all');
    wr.boxY(0, 0.9, 0, 13.6, 4.0, 2.5, col, { top: mul(col, 0.8) });
    wr.boxY(0, 2.4, 1.26, 12.6, 3.4, 0.02, COL.white);
    wr.boxY(7.9, 0.6, 0, 2.2, 3.6, 2.45, mul(col, 0.9));
    wr.use('glass', 'all');
    wr.boxY(9.02, 2.2, 0, 0.04, 3.2, 2.2, COL.glass);
    wr.use('paint', 'detail');
    [-5, -3.8, 5.2, 8.2].forEach(function (x) { [-1.1, 1.1].forEach(function (z) { wr.tube([x, 0.5, z - 0.15], [x, 0.5, z + 0.15], 0.5, 6, COL.rubber, { caps: true }); }); });
  }

  function marshalPost(B, o) {
    var wr = B.wr, rnd = B.rnd, L = Math.max(2, o.l || 2.6), D = Math.max(1.6, o.w || 2.2);
    wr.use('paint', 'all');
    wr.boxY(0, -0.5, 0, L, 0.6, D, COL.concrete);
    wr.boxY(0, 0.6, D * 0.25, L * 0.85, 2.3, D * 0.45, COL.offwhite);
    wr.boxY(0, 0.6, -D * 0.2, L * 0.85, 1.05, 0.06, COL.offwhite);
    wr.use('glass', 'all');
    wr.boxY(0, 1.3, D * 0.02, L * 0.7, 2.0, 0.04, COL.glass);
    wr.use('paint', 'all');
    wr.boxY(0, 2.3, 0.1, L * 1.05, 2.5, D * 1.05, COL.orange);
    wr.use('paint', 'detail');
    wr.person(-L * 0.18, 0.6, -D * 0.3, COL.orange, rnd, { legs: COL.orange, cap: COL.white });
    flagPole(wr, L * 0.35, -D * 0.38, 2.6, rnd.chance(0.5) ? COL.yellow : lin('#1c9a3c'), rnd);
    wr.use('signs', 'detail');
    wr.signF(-0.5, 0.5, 2.55, 2.8, -D * 0.53, 'MARSHAL', WHITE, 'plain', '#f07a12');
  }

  function billboard(B, o) {
    var wr = B.wr, rnd = B.rnd, L = Math.max(1, o.l || 14), H = Math.max(1, o.h || 5), v = o.variant;
    var lit = !!o.lit && (B.night || B.tod === 'dusk');
    if (v === 'chevron') {
      var n = Math.max(1, Math.round(L / 4)), pw = L / n, ph = Math.min(1.2, pw / 4 * 1.2);
      wr.use('metal', 'all');
      for (var k = 0; k <= n; k++) wr.boxY(-L / 2 + k * pw, -0.3, 0.05, 0.08, 0.35 + ph + 0.1, 0.08, COL.steel);
      wr.use('signs', 'all');
      for (k = 0; k < n; k++) {
        var x0 = -L / 2 + k * pw + 0.04, x1 = x0 + pw - 0.08;
        wr.signF(x0, x1, 0.35, 0.35 + ph, -0.02, o.text || '>', WHITE, 'chevron');
      }
      return;
    }
    // standard hoarding on two legs, panel facing the track (-Z), grey back
    var leg = Math.max(0.6, H - Math.min(H * 0.7, L / 4)), ph2 = Math.min(H - leg + 0.0, L / 4), y0 = Math.max(0.4, H - ph2);
    if (H <= 2.6) { y0 = 0.25; ph2 = Math.min(H - 0.25, L / 4); }
    wr.use('metal', 'all');
    [-L * 0.32, L * 0.32].forEach(function (x) { wr.boxY(x, -0.4, 0.15, 0.22, y0 + ph2 * 0.9, 0.22, COL.steel); });
    wr.boxY(0, y0 - 0.12, 0.12, L + 0.2, y0 + ph2 + 0.12, 0.16, COL.dark, { cols: { pz: lin('#4b4e54') } });
    var segs = Math.max(1, Math.round(L / (ph2 * 4)));
    wr.use(lit ? 'signsLit' : 'signs', 'all');
    var txt = o.text || B.brand(rnd);
    for (var s = 0; s < segs; s++) {
      var a0 = -L / 2 + s * L / segs, a1 = a0 + L / segs;
      wr.signF(a0, a1, y0, y0 + ph2, 0.02, txt, WHITE, 'brand', o.color ? normHex(o.color) : '');
    }
    if (lit) {
      wr.use('glow', 'all');
      var gc = lin(o.color || B.P.th.glow || '#2bf3ff'); gc = [gc[0] * 3, gc[1] * 3, gc[2] * 3, 1];
      wr.boxY(0, y0 + ph2 + 0.05, -0.05, L + 0.3, y0 + ph2 + 0.18, 0.08, gc);
      wr.boxY(0, y0 - 0.2, -0.05, L + 0.3, y0 - 0.07, 0.08, gc);
    }
  }
  /** distance board (150 / 100 / 50) facing approaching cars: placed by the caller in a yaw = heading frame */
  function distanceBoard(B, text) {
    var wr = B.wr;
    wr.use('metal', 'detail');
    wr.boxY(0, -0.3, 0, 0.08, 0.9, 0.08, COL.steel);
    wr.use('signs', 'all');
    // 4:1 slot drawn rotated: panel 0.5 wide (z) x 2 tall shows the number vertically readable thanks to a 'distance' slot
    wr.sign([[-0.05, 0.6, -0.65], [-0.05, 0.6, 0.65], [-0.05, 0.6 + 1.3 / 4 * 2.6, 0.65], [-0.05, 0.6 + 1.3 / 4 * 2.6, -0.65]], text, WHITE, 'distance');
  }

  function tent(B, o) {
    var wr = B.wr, L = Math.max(3, o.l || 10), D = Math.max(3, o.w || 10), H = Math.max(2.5, o.h || 4);
    var col = alb(lin(o.color || '#ffffff')), eave = H * 0.6;
    wr.use('metal', 'detail');
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (c) { wr.boxY(c[0] * (L / 2 - 0.1), 0, c[1] * (D / 2 - 0.1), 0.08, eave, 0.08, COL.steel); });
    wr.use('paint', 'all');
    if (L > D * 1.4) wr.gable(-L / 2, L / 2, -D / 2, D / 2, eave, H - eave, 0.15, col, mul(col, 0.92));
    else wr.hip(-L / 2, L / 2, -D / 2, D / 2, eave, H - eave, 0.15, col);
    // scalloped valance
    var vc = mix(col, B.P.accent, 0.5);
    wr.boxY(0, eave - 0.45, -D / 2 - 0.12, L + 0.3, eave, 0.03, vc);
    wr.boxY(0, eave - 0.45, D / 2 + 0.12, L + 0.3, eave, 0.03, vc);
    wr.use('paint', 'detail');
    wr.boxY(0, 0, 0, L * 0.5, 0.95, 0.8, COL.offwhite);
  }

  function lampPost(B, o) {
    var wr = B.wr, v = o.variant || 'street', H = Math.max(4, o.h || 8);
    var lc = lin(o.color || '#fff1d6'), lightC = [lc[0] * 1.15, lc[1] * 1.08, lc[2] * 0.95];
    var head = [2.6 * lc[0] + 0.4, 2.5 * lc[1] + 0.4, 2.3 * lc[2] + 0.4, 1];
    if (v === 'stadium' || v === 'flood') {
      wr.use('metal', 'all');
      wr.cyl(0, -0.5, 0, 0.45, 0.22, H + 0.5, 6, COL.steel, { top: false });
      var fw = v === 'stadium' ? 4.2 : 2.4;
      wr.box(0, H, -0.2, fw, 1.6, 0.35, COL.dark, { cols: { nz: COL.dark } });
      wr.beam([0, H - 1.2, 0], [0, H - 0.2, -0.2], 0.2, 0.2, COL.steel);
      wr.use('lamp', 'all');
      var nx = v === 'stadium' ? 4 : 2, ny = v === 'stadium' ? 2 : 1;
      for (var ix = 0; ix < nx; ix++) for (var iy = 0; iy < ny; iy++) {
        var lx = -fw / 2 + (ix + 0.5) * fw / nx, ly = H - 0.6 + (iy + 0.5) * 1.2 / ny;
        wr.face([[lx - 0.4, ly - 0.25, -0.39], [lx + 0.4, ly - 0.25, -0.39], [lx + 0.4, ly + 0.25, -0.39], [lx - 0.4, ly + 0.25, -0.39]], head, null, [lx, ly, 1]);
      }
      addLight(B, 0, H, -1, [0, -0.85, -1], v === 'stadium' ? mul(lightC, 1.7).slice(0, 3) : lightC, v === 'stadium' ? 95 : 60, 30, 65);
      return;
    }
    // street / road lamp: tapered pole + curved arm towards the track
    wr.use('metal', 'all');
    wr.cyl(0, -0.3, 0, 0.14, 0.08, H + 0.3, 6, mix(COL.steel, COL.dark, 0.4), { top: false });
    var arm = v === 'road' ? 1.4 : 2.2;
    wr.tube([0, H - 0.1, 0], [0, H + 0.25, -arm * 0.45], 0.06, 4, COL.dark);
    wr.tube([0, H + 0.25, -arm * 0.45], [0, H + 0.2, -arm], 0.06, 4, COL.dark);
    wr.box(0, H + 0.12, -arm - 0.2, 0.42, 0.18, 0.75, COL.dark);
    wr.use('lamp', 'all');
    // glowing lens: a shallow box under the housing so it reads side-on from the road, not just from below
    wr.box(0, H - 0.005, -arm - 0.2, 0.34, 0.07, 0.58, head, { skip: { py: true } });
    addLight(B, 0, H, -arm - 0.2, [0, -1, -0.25], lightC, Math.max(26, H * 3.2), 38, 70);
  }

  function water(B, o) {
    var wr = B.wr, r = Math.max(2, o.r || 20), seg = r > 25 ? 28 : 20, pts = [], rim = [];
    var jitR = B.rnd;
    for (var i = 0; i < seg; i++) {
      var a = -i / seg * TAU, rr = r * (0.92 + 0.12 * ringNoise(a, 1.4, (o.x | 0) + (o.y | 0)));
      pts.push([Math.cos(a) * rr, 0, Math.sin(a) * rr]);
      rim.push([Math.cos(a) * (rr + 1.6), -0.35, Math.sin(a) * (rr + 1.6)]);
    }
    wr.use('water', 'all');
    wr.face(pts, B.waterCol, null, [0, -5, 0]);
    wr.use('paint', 'all');
    var shore = o.variant === 'harbour' || o.variant === 'bay' ? COL.concrete : mix(B.P.sand, B.P.grass, 0.35);
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      wr.face([[pts[i][0], 0.02, pts[i][2]], [pts[j][0], 0.02, pts[j][2]], rim[j], rim[i]], shore, null, [0, -5, 0]);
    }
    void jitR;
  }

  /* -------------------------------------------------------------- towers */
  function tower(B, o) {
    var wr = B.wr, P = B.P, rnd = B.rnd, v = o.variant || '', H = Math.max(4, o.h || 30), L = Math.max(2, o.l || 10), D = Math.max(1, o.w || 10);
    var col = alb(lin(o.color || '#d8dde3')), acc = lin(o.accent || P.th.accent || '#ff6a00');
    if (v === 'torii') {
      var red = lin(o.color || '#c8202a'), span = Math.max(3.5, L * 0.75);
      wr.use('paint', 'all');
      [-span / 2, span / 2].forEach(function (x) { wr.cyl(x, -0.2, 0, 0.32, 0.27, H + 0.2, 8, red); wr.cyl(x, -0.2, 0, 0.42, 0.42, 0.6, 8, COL.black); });
      wr.box(0, H * 0.78, 0, span + 1.2, 0.36, 0.36, red);
      wr.boxY(0, H * 0.78, 0, 0.35, H - 0.2, 0.3, red);
      wr.face([[-span / 2 - 1.6, H + 0.25, -0.35], [span / 2 + 1.6, H + 0.25, -0.35], [span / 2 + 1.9, H + 0.6, -0.35], [-span / 2 - 1.9, H + 0.6, -0.35]], COL.black, null, [0, H, 1]);
      wr.box(0, H - 0.05, 0, span + 2.6, 0.45, 0.62, COL.black, { top: COL.black });
      wr.box(0, H - 0.4, 0, span + 1.8, 0.32, 0.5, red);
      return;
    }
    if (v === 'observation-wheel') {
      // static base; the wheel itself is a dynamic part (rotates) built by the caller
      var R = Math.min(H * 0.46, 80);
      wr.use('metal', 'all');
      [-1, 1].forEach(function (sz) {
        wr.beam([-R * 0.45, 0, sz * 6], [0, H - R, sz * 3.2], 1.2, 1.2, COL.steel);
        wr.beam([R * 0.45, 0, sz * 6], [0, H - R, sz * 3.2], 1.2, 1.2, COL.steel);
      });
      wr.boxY(0, -0.5, 0, R * 1.1, 4, 18, mix(COL.dark, acc, 0.15));
      B.wheels.push({ wr: wr.wp(0, H - R, 0), R: R, yaw: wr.yaw, col: col, acc: acc, lit: !!o.lit });
      return;
    }
    if (v === 'scoring-pylon') {
      wr.use('paint', 'all');
      wr.boxY(0, -1, 0, Math.min(L, 7), H * 0.25, Math.min(D, 7), mul(col, 0.9));
      wr.boxY(0, H * 0.25, 0, Math.min(L, 4.2), H, 2.6, COL.dark);
      wr.use('glow', 'all');
      var rows = Math.min(12, Math.floor(H * 0.65 / 3.2));
      for (var k = 0; k < rows; k++) {
        var yy = H - 3 - k * 3.2, gc = k < 3 ? [3.2, 2.4, 0.4, 1] : [2.4, 2.4, 2.6, 1];
        wr.face([[-1.8, yy, -1.32], [1.8, yy, -1.32], [1.8, yy + 2.2, -1.32], [-1.8, yy + 2.2, -1.32]], k % 2 ? mul(gc, 0.8) : gc, null, [0, yy, 1]);
        wr.face([[-1.8, yy, 1.32], [1.8, yy, 1.32], [1.8, yy + 2.2, 1.32], [-1.8, yy + 2.2, 1.32]], k % 2 ? mul(gc, 0.8) : gc, null, [0, yy, -1]);
      }
      wr.use('signs', 'all');
      wr.signF(-2.1, 2.1, H + 0.2, H + 1.25, -1.4, o.text || 'REDLINE', WHITE);
      B.blinkers.push(wr.wp(0, H + 1.6, 0));
      return;
    }
    if (v === 'timing') {
      wr.use('paint', 'all');
      wr.boxY(0, -1, 0, L, H * 0.7, D, col, { top: mul(col, 0.8) });
      wr.use('glass', 'all');
      wr.boxY(0, H * 0.7, 0, L * 1.1, H, D * 1.1, COL.glass);
      wr.use('paint', 'all');
      wr.boxY(0, H, 0, L * 1.3, H + 0.3, D * 1.3, acc);
      wr.use('signs', 'all');
      var tw = L * 1.1;
      wr.signF(-tw / 2, tw / 2, H * 0.48, H * 0.48 + tw / 4, -D / 2 - 0.03, o.text || 'TIMING', WHITE, 'plain', '#1b1c20');
      return;
    }
    // control tower: shaft + flared glass cab + roof sign + antenna
    var sh = Math.min(L, D) * 0.45;
    wr.use('paint', 'all');
    wr.boxY(0, -1, 0, L, 5, D, mul(col, 0.92));
    wr.cyl(0, 5, 0, sh * 0.62, sh * 0.5, H * 0.72 - 5, 8, col, { rot: PI / 8 });
    wr.cyl(0, H * 0.72, 0, sh * 0.62, sh * 1.25, 1.6, 8, mul(col, 0.85), { rot: PI / 8, bottom: true });
    wr.use('glass', 'all');
    wr.cyl(0, H * 0.72 + 1.6, 0, sh * 1.25, sh * 1.45, H * 0.17, 8, lin('#58718c'), { rot: PI / 8, top: false });
    wr.use('paint', 'all');
    wr.cyl(0, H * 0.89 + 1.6, 0, sh * 1.55, sh * 1.2, 1.0, 8, acc, { rot: PI / 8 });
    wr.use('metal', 'all');
    wr.cyl(0, H * 0.89 + 2.6, 0, 0.15, 0.05, 7, 5, COL.offwhite);
    B.blinkers.push(wr.wp(0, H * 0.89 + 9.7, 0));
    wr.use('signs', 'all');
    var cw = sh * 2.4;
    wr.signF(-cw / 2, cw / 2, H * 0.72 - 3.6, H * 0.72 - 3.6 + cw / 4, -sh * 0.7, o.text || 'RACE CONTROL', WHITE, 'plain', '#1b1c20');
    if (B.night) { wr.use('lamp', 'all'); wr.cyl(0, H * 0.72 + 1.7, 0, sh * 1.2, sh * 1.4, H * 0.16, 8, [1.2, 1.1, 0.9, 1], { rot: PI / 8, top: false }); }
  }

  /* -------------------------------------------------------------- buildings */
  function building(B, o, cityOpts) {
    var wr = B.wr, P = B.P, rnd = B.rnd, v = o.variant || '', L = Math.max(3, o.l || 20), D = Math.max(2, o.w || 14), H = Math.max(1.5, o.h || 12);
    var col = lin(o.color || '#c9c4bb'), acc = o.accent ? lin(o.accent) : null;
    if (v === 'yacht') {
      wr.use('paint', 'all');
      var hull = [[-L / 2, 0.2], [-L / 2 + 0.6, -0.9], [L / 2 - 2.4, -0.9], [L / 2, 0.5], [L / 2 - 0.4, 1.2], [-L / 2, 1.2]];
      [-1, 1].forEach(function (sz) { wr.face(hull.map(function (p) { return [p[0], p[1], sz * D / 2 * (p[1] < 0 ? 0.8 : 1)]; }), col, null, [0, 0, -sz * 5]); });
      wr.face([[-L / 2, 1.2, -D / 2], [L / 2 - 0.4, 1.2, -D / 2], [L / 2 - 0.4, 1.2, D / 2], [-L / 2, 1.2, D / 2]], lin('#b48a5a'), null, [0, -5, 0]);
      wr.boxY(-L * 0.08, 1.2, 0, L * 0.5, 2.6, D * 0.7, COL.white);
      wr.boxY(-L * 0.12, 2.6, 0, L * 0.3, 3.6, D * 0.55, COL.white);
      wr.use('glass', 'all');
      wr.boxY(-L * 0.08 + 0.02, 1.7, 0, L * 0.5 + 0.04, 2.3, D * 0.7 + 0.04, lin(o.accent || '#1d3557'));
      wr.use('metal', 'detail');
      wr.cyl(-L * 0.1, 3.6, 0, 0.08, 0.05, L * 0.9, 5, COL.offwhite);
      if (B.night) B.blinkers.push(wr.wp(-L * 0.1, 3.6 + L * 0.9, 0));
      return;
    }
    if (v === 'parking') {
      wr.use('paint', 'all');
      wr.boxY(0, -0.4, 0, L, 0.05, D, lin('#4a4c50'));
      wr.use('paint', 'detail');
      for (var px = -L / 2 + 2; px < L / 2 - 1; px += 2.8) {
        wr.box(px, 0.06, -D * 0.2, 0.12, 0.01, D * 0.45, COL.white);
        if (rnd() < 0.6) {
          var cc = rnd.pick(TEAM.concat(SHIRTS)), cz = -D * 0.2;
          wr.boxY(px + 1.4, 0.3, cz, 1.85, 1.0, 4.3, cc);
          wr.boxY(px + 1.4, 1.0, cz + 0.2, 1.6, 1.45, 2.3, mix(cc, COL.glass, 0.6));
        }
      }
      return;
    }
    if (v === 'teahouse') {
      wr.use('paint', 'all');
      wr.boxY(0, -0.6, 0, L, 0.5, D, COL.concrete);
      wr.boxY(0, 0.5, 0, L - 0.6, H * 0.72, D - 0.6, alb(lin('#e8dfc8')));
      wr.use('paint', 'all');
      for (var bx = -L / 2 + 0.3; bx <= L / 2 - 0.3 + 1e-6; bx += (L - 0.6) / 6) wr.boxY(bx, 0.5, -D / 2 + 0.28, 0.2, H * 0.72, 0.06, col);
      wr.hip(-L / 2 + 0.3, L / 2 - 0.3, -D / 2 + 0.3, D / 2 - 0.3, H * 0.72, H * 0.5, 1.1, lin(o.accent || '#2b2b2b'));
      wr.use('lamp', 'detail');
      [-L * 0.3, L * 0.3].forEach(function (x) { wr.box(x, H * 0.6, -D / 2 - 0.6, 0.45, 0.65, 0.45, [2.4, 0.6, 0.3, 1]); });
      // vending machines (glowing) by the door
      wr.use('lamp', 'detail');
      wr.boxY(L / 2 + 0.8, 0, -D / 2 + 1, 1.0, 1.85, 0.8, [1.6, 1.7, 1.9, 1]);
      wr.boxY(L / 2 + 2.0, 0, -D / 2 + 1, 1.0, 1.85, 0.8, [1.9, 0.5, 0.4, 1]);
      if (B.night || B.tod === 'dusk') addLight(B, L / 2 + 1.4, 1.2, -D / 2 - 1, null, [1.2, 1.3, 1.5], 12);
      return;
    }
    if (v === 'clubhouse' || v === 'media') {
      wr.use('paint', 'all');
      wr.boxY(0, -1, 0, L, H * (v === 'media' ? 0.45 : 0.75), D, col);
      wr.use('glass', 'all');
      if (v === 'media') {
        wr.boxY(0, H * 0.45, -D * 0.05, L * 1.02, H * 0.92, D * 0.9, lin('#5e7894'));
        wr.use('paint', 'all');
        wr.boxY(0, H * 0.92, 0, L * 1.06, H, D * 1.04, mix(col, COL.white, 0.4));
        wr.use('metal', 'detail');
        for (var dsh = 0; dsh < 4; dsh++) {
          var dx = -L * 0.35 + dsh * L * 0.2;
          wr.cyl(dx, H, D * 0.2, 0.15, 0.15, 1.2, 5, COL.steel);
          wr.cyl(dx, H + 1.2, D * 0.2, 0.2, 1.3, 0.6, 10, COL.offwhite, { rot: 0.3 });
        }
      } else {
        for (var wx = -L / 2 + 2.2; wx < L / 2 - 1.5; wx += 3.2) wr.boxY(wx, H * 0.3, -D / 2 - 0.02, 1.6, H * 0.6, 0.04, COL.glass);
        wr.use('paint', 'all');
        wr.gable(-L / 2, L / 2, -D / 2, D / 2, H * 0.75, H * 0.45, 0.6, lin(o.accent || '#b5562f'), col);
      }
      return;
    }
    // generic (city / town) building with facade texture
    city(B, L, D, H, col, acc, !!o.lit, cityOpts || {});
  }

  /* facade texture layout (textures.buildingFacade: 4 bays x 4 storeys per tile) in metres */
  var FACADE_BAY = 2.5, FACADE_STOREY = 3.2, FACADE_COLS = 4, FACADE_FLOORS = 4;

  /** podium shop fronts on the track-facing (-Z) side: human-scale ~2.5 m bays, each a pair of
      ~1.1 m panes under a transom + fascia band (lit and varied at dusk / night, mullioned glass by day) */
  function shopfront(B, L, D, ph, col, acc, lightsNow) {
    var wr = B.wr, rnd = B.rnd, z = -D / 2 - 0.03, ref = [0, ph / 2, 0];
    var span = L * 0.92, bays = Math.max(2, Math.round(span / FACADE_BAY)), bw = span / bays;
    var gy0 = 0.35, gy1 = Math.min(ph - 1.4, 2.75), ty1 = Math.min(ph - 0.9, gy1 + 0.55), x0 = -span / 2;
    function pane(xa, xb, ya, yb, c) { wr.face([[xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z]], c, null, ref); }
    // fascia / sign band above the glazing + slab edge
    wr.use('paint', 'all');
    wr.boxY(0, ty1 + 0.05, -D / 2 - 0.12, L * 0.94, ty1 + 0.5, 0.24, mul(col, 0.45));
    if (lightsNow) {
      wr.use('lamp', 'all');
      var shop = -1, shopC = null;
      for (var bi = 0; bi < bays; bi++) {
        // neighbouring bays usually belong to the same shop (same light colour / state)
        if (bi === 0 || rnd() < 0.45) {
          shop++;
          var rv = rnd();
          shopC = rv < 0.2 ? null : rv < 0.62 ? [0.36, 0.23, 0.11, 1] : rv < 0.84 ? [0.15, 0.21, 0.28, 1] : [0.42, 0.33, 0.22, 1];
        }
        var bx = x0 + bw * bi, m = 0.09;
        if (!shopC) { pane(bx + m, bx + bw - m, gy0, gy1, [0.012, 0.014, 0.018, 1]); continue; }
        var k = 0.85 + rnd() * 0.3, c = [shopC[0] * k, shopC[1] * k, shopC[2] * k, 1], cl = mul(c, 0.55);
        var mid = bx + bw / 2, door = rnd() < 0.3;
        if (door) {
          // glazed door (lit interior behind) + side light
          pane(bx + m, mid - 0.05, gy0, gy1, c);
          pane(mid + 0.05, bx + bw - m, gy0 + 0.05, gy1 - 0.25, mul(c, 1.15));
        } else {
          pane(bx + m, mid - 0.04, gy0 + 0.45, gy1, c);           // stall riser below the glass
          pane(mid + 0.04, bx + bw - m, gy0 + 0.45, gy1, mul(c, 0.92));
        }
        pane(bx + m, bx + bw - m, gy1 + 0.08, ty1 - 0.06, cl);    // transom
      }
      // illuminated fascia lettering strip over part of the front
      if (acc && rnd() < 0.7) {
        wr.use('glow', 'all');
        var g = mul(acc, 1.6), sw = Math.min(span * 0.5, bw * (2 + Math.floor(rnd() * 3))), sx = rnd.range(-span / 2 + sw / 2, span / 2 - sw / 2);
        wr.face([[sx - sw / 2, ty1 + 0.14, -D / 2 - 0.25], [sx + sw / 2, ty1 + 0.14, -D / 2 - 0.25], [sx + sw / 2, ty1 + 0.4, -D / 2 - 0.25], [sx - sw / 2, ty1 + 0.4, -D / 2 - 0.25]], [g[0], g[1], g[2], 1], null, [0, ty1, 0]);
      }
    } else {
      wr.use('glass', 'all');
      wr.boxY(0, gy0, -D / 2 - 0.02, span, ty1 - 0.06, 0.04, COL.glass);
      wr.use('metal', 'detail');
      for (var mi = 0; mi <= bays; mi++) wr.boxY(x0 + bw * mi, gy0, -D / 2 - 0.07, 0.1, ty1 - 0.06, 0.06, COL.steel);
      wr.boxY(0, gy1, -D / 2 - 0.07, span, gy1 + 0.08, 0.06, COL.steel);
    }
  }

  /** textured block: facade material by style seed, flat roof plant or pitched roof, neon crown at night */
  function city(B, L, D, H, col, acc, lit, co) {
    var wr = B.wr, rnd = B.rnd;
    var tall = H > 30, style = co.style != null ? co.style : (tall ? (rnd() < 0.75 ? 0 : 2) : (rnd() < 0.5 ? 3 : 1));
    var mat = 'facade' + style, tint = mix(WHITE, col, 0.35);
    // facade UVs in real metres: the texture tile is FACADE_COLS bays x FACADE_FLOORS storeys,
    // so every face (whatever its length) gets ~2.5 m bays and 3.2 m storeys aligned at local y = 0
    var us = [FACADE_BAY * FACADE_COLS, FACADE_STOREY * FACADE_FLOORS];
    var y0 = -3, podium = tall && H > 60 ? FACADE_STOREY * 2 : 0;
    var lightsNow = lit || B.night || B.tod === 'dusk';
    // at night / dusk the facade is unlit (emissive windows), so give each side its own value
    var shadeX0 = lightsNow ? 1.0 : 1, shadeX1 = lightsNow ? 0.72 : 1, shadeZ0 = lightsNow ? 0.86 : 1, shadeZ1 = lightsNow ? 0.8 : 1;
    wr.use(mat, 'all');
    function walls(x0, x1, z0, z1, ya, yb, t) {
      wr.wallX(x0, x1, z0, ya, yb, -1, mul(t, shadeX0), us);
      wr.wallX(x1, x0, z1, ya, yb, 1, mul(t, shadeX1), us);
      wr.wallZ(z1, z0, x0, ya, yb, -1, mul(t, shadeZ0), us);
      wr.wallZ(z0, z1, x1, ya, yb, 1, mul(t, shadeZ1), us);
    }
    if (podium) {
      wr.use('paint', 'all');
      wr.boxY(0, y0, 0, L, podium, D, mul(col, 0.7));
      shopfront(B, L, D, podium, col, acc, lightsNow);
      wr.use(mat, 'all');
      var setb = Math.min(3, L * 0.08);
      walls(-L / 2 + setb, L / 2 - setb, -D / 2 + setb, D / 2 - setb, podium, H, tint);
      L -= setb * 2; D -= setb * 2;
    } else walls(-L / 2, L / 2, -D / 2, D / 2, y0, H, tint);
    // roof
    var roofCol = mul(col, 0.55);
    if (!tall && acc && H < 30 && co.pitched !== false) {
      wr.use('paint', 'all');
      wr.face([[-L / 2, H, -D / 2], [L / 2, H, -D / 2], [L / 2, H, D / 2], [-L / 2, H, D / 2]], roofCol, null, [0, 0, 0]);
      wr.hip(-L / 2, L / 2, -D / 2, D / 2, H, Math.min(L, D) * 0.28, 0.5, acc);
      if (rnd() < 0.5) { wr.use('paint', 'detail'); wr.boxY(L * 0.2, H, D * 0.1, 0.8, H + Math.min(L, D) * 0.3, 0.8, mul(col, 0.8)); }
    } else {
      wr.use('paint', 'all');
      wr.boxY(0, H, 0, L + 0.4, H + 0.9, D + 0.4, mul(col, 0.75), { top: roofCol });
      wr.use('metal', 'detail');
      var nu = Math.max(1, Math.floor(L * D / 300));
      for (var u = 0; u < Math.min(nu, 5); u++) wr.boxY(rnd.range(-L / 3, L / 3), H + 0.9, rnd.range(-D / 3, D / 3), rnd.range(2, 4), H + 0.9 + rnd.range(1, 2.2), rnd.range(2, 4), COL.steel);
      if (tall) {
        // crown + antenna (+ neon edge at night / lit)
        var ch = Math.min(8, H * 0.06);
        wr.use('paint', 'all');
        wr.boxY(0, H + 0.9, 0, L * 0.6, H + 0.9 + ch, D * 0.6, mul(col, 0.6));
        if (rnd() < 0.6) {
          wr.use('metal', 'all');
          wr.cyl(0, H + 0.9 + ch, 0, 0.35, 0.08, H * 0.12, 5, COL.offwhite);
          B.blinkers.push(wr.wp(0, H + 0.9 + ch + H * 0.12, 0));
        } else B.blinkers.push(wr.wp(L * 0.3, H + 1.2, D * 0.3));
        if (lit || B.night) {
          var nc = acc || B.P.glow, k = 3.2;
          wr.use('glow', 'all');
          var g = [nc[0] * k, nc[1] * k, nc[2] * k, 1];
          wr.boxY(0, H + 0.55, -D / 2 - 0.25, L + 0.5, H + 0.95, 0.12, g);
          wr.boxY(0, H + 0.55, D / 2 + 0.25, L + 0.5, H + 0.95, 0.12, g);
          wr.boxY(-L / 2 - 0.25, H + 0.55, 0, 0.12, H + 0.95, D + 0.5, g);
          wr.boxY(L / 2 + 0.25, H + 0.55, 0, 0.12, H + 0.95, D + 0.5, g);
          if (rnd() < 0.5) {
            wr.boxY(-L / 2 - 0.2, 4, -D / 2 - 0.2, 0.25, H, 0.25, g);
            wr.boxY(L / 2 + 0.2, 4, -D / 2 - 0.2, 0.25, H, 0.25, g);
          }
        }
      }
    }
    // shop awnings for low town buildings
    if (!tall && !podium && rnd() < 0.55) {
      wr.use('paint', 'detail');
      var ac = rnd.pick([lin('#2e5e4e'), lin('#8c2b2b'), lin('#c8a24a'), lin('#2b3e6b')]);
      wr.face([[-L * 0.35, 3.2, -D / 2], [L * 0.35, 3.2, -D / 2], [L * 0.35, 2.6, -D / 2 - 1.4], [-L * 0.35, 2.6, -D / 2 - 1.4]], ac, null, [0, -5, 0]);
    }
  }

  /* ---------------------------------------------------------- start gantry */
  function gantry(B, geom, cl) {
    var S = geom.samples, s0 = S[0], wr = B.wr;
    var wl = s0.wallL, wrr = s0.wallR, H = 6.2;
    // pillar positions must be clear of every barrier line
    var zl = -(wl + 1.1), zr = wrr + 1.1;
    for (var k = 0; k < 6 && cl(s0.x + s0.nx * -zl, s0.y + s0.ny * -zl) < 0.4; k++) zl -= 0.5;
    for (k = 0; k < 6 && cl(s0.x - s0.nx * zr, s0.y - s0.ny * zr) < 0.4; k++) zr += 0.5;
    var gx = 2.0;
    var p = { x: s0.x + s0.tx * gx, y: s0.y + s0.ty * gx };
    wr.at(p.x, p.y, s0.heading, 0, 'gantry');
    wr.use('metal', 'all');
    [zl, zr].forEach(function (z) {
      wr.boxY(0, -0.4, z, 1.4, 0.5, 1.4, COL.concrete);
      wr.boxY(0, 0.5, z, 0.6, H + 1.4, 0.6, COL.dark);
    });
    // truss beam: two chords + lacing
    var span0 = zl - 0.3, span1 = zr + 0.3;
    wr.tube([-0.35, H, span0], [-0.35, H, span1], 0.1, 5, COL.dark);
    wr.tube([0.35, H, span0], [0.35, H, span1], 0.1, 5, COL.dark);
    wr.tube([-0.35, H + 1.2, span0], [-0.35, H + 1.2, span1], 0.1, 5, COL.dark);
    wr.tube([0.35, H + 1.2, span0], [0.35, H + 1.2, span1], 0.1, 5, COL.dark);
    wr.use('metal', 'detail');
    for (var z = span0, f = 0; z < span1 - 1.2; z += 1.2, f++) {
      wr.tube([-0.35, H + (f % 2 ? 0 : 1.2), z], [-0.35, H + (f % 2 ? 1.2 : 0), z + 1.2], 0.04, 3, COL.dark);
      wr.tube([0.35, H + (f % 2 ? 0 : 1.2), z], [0.35, H + (f % 2 ? 1.2 : 0), z + 1.2], 0.04, 3, COL.dark);
    }
    // sponsor panels on both faces of the beam
    wr.use('signs', 'all');
    var cw = Math.min(10, (span1 - span0) * 0.3), ch = cw / 4;
    [[-0.5, -1], [0.5, 1]].forEach(function (fc) {
      [span0 + cw * 0.6, span1 - cw * 0.6].forEach(function (zc) {
        wr.signX(zc - cw / 2, zc + cw / 2, H + 0.6 - ch / 2, H + 0.6 + ch / 2, fc[0], fc[1], 'REDLINE', WHITE);
      });
    });
    // light cluster housing (centre, hanging below the beam, facing the grid = -X)
    wr.use('metal', 'all');
    wr.boxY(-0.2, H - 1.65, 0, 0.5, H + 0.05, 5.2, COL.black);
    wr.use('paint', 'all');
    for (var c = 0; c < 5; c++) {
      var zc = (c - 2) * 1.0;
      for (var r = 0; r < 2; r++) {
        var yc = H - 0.45 - r * 0.72;
        wr.cyl(-0.48, yc, zc, 0.27, 0.27, 0.06, 10, COL.dark);
      }
      wr.boxY(-0.5, H - 1.6, zc - 0.36, 0.04, H, 0.04, mul(COL.dark, 1.5));
    }
    // dynamic lamp lenses: one part per column so their emissive can be switched
    var lenses = [];
    for (c = 0; c < 5; c++) {
      var sink = new Sink(), lw = new Writer(sink);
      lw.at(p.x, p.y, s0.heading, 0, 'gantry'); lw.use('cd', 'dyn');
      zc = (c - 2) * 1.0;
      for (r = 0; r < 2; r++) {
        yc = H - 0.45 - r * 0.72;
        var ring = [];
        for (var i = 0; i < 12; i++) { var a = i / 12 * TAU; ring.push([-0.53, yc + Math.sin(a) * 0.22, zc + Math.cos(a) * 0.22]); }
        lw.face(ring, WHITE, null, [1, yc, zc]);
        // repeater on the back face
        lw.face(ring.map(function (q) { return [0.07, q[1], q[2]]; }), WHITE, null, [-1, yc, zc]);
      }
      lenses.push(sink.list[0]);
    }
    B.gantryLenses = lenses;
    B.gantryPos = wr.wp(0, H, 0);
    return { zl: zl, zr: zr };
  }

  /* ----------------------------------------------------------- footbridge */
  function footbridge(B, sm, zl, zr) {
    var wr = B.wr, H = 6.4, Wd = 3.2, acc = B.P.accent;
    wr.at(sm.x, sm.y, sm.heading, 0, null);
    var z0 = zl - 2.2, z1 = zr + 2.2;
    // deck + fascia sign panels on both faces
    wr.use('paint', 'all');
    wr.boxY(0, H, (z0 + z1) / 2, Wd, H + 0.55, z1 - z0, COL.concrete, { bottom: COL.concreteDark });
    wr.boxY(-Wd / 2 - 0.05, H - 0.2, (z0 + z1) / 2, 0.1, H + 0.65, z1 - z0, acc);
    wr.boxY(Wd / 2 + 0.05, H - 0.2, (z0 + z1) / 2, 0.1, H + 0.65, z1 - z0, acc);
    wr.use('signs', 'all');
    var sw = Math.min(16, (zr - zl) * 0.7), sh = sw / 4, ys = H + 0.75;
    var zm = (zl + zr) / 2;
    wr.signX(zm - sw / 2, zm + sw / 2, ys, ys + sh, -Wd / 2 - 0.15, -1, B.brand(B.rnd), WHITE);
    wr.signX(zm - sw / 2, zm + sw / 2, ys, ys + sh, Wd / 2 + 0.15, 1, B.brand(B.rnd), WHITE);
    wr.use('metal', 'all');
    wr.boxY(0, ys - 0.1, (zl + zr) / 2, Wd + 0.2, ys, sw, COL.dark);
    wr.boxY(0, ys + sh, (zl + zr) / 2, Wd + 0.2, ys + sh + 0.1, sw, COL.dark);
    // arched steel trusses
    var n = 16, prevT = null;
    [-1, 1].forEach(function (sx) {
      prevT = null;
      for (var i = 0; i <= n; i++) {
        var t = i / n, z = lerp(z0, z1, t), y = H + 0.55 + 0.4 + 2.8 * Math.sin(PI * t), pt = [sx * Wd / 2, y, z];
        if (prevT) wr.tube(prevT, pt, 0.12, 5, COL.white);
        if (i > 0 && i < n) wr.tube([sx * Wd / 2, H + 0.55, z], pt, 0.04, 3, COL.white);
        prevT = pt;
      }
    });
    for (var i2 = 2; i2 < n - 1; i2 += 2) {
      var t2 = i2 / n, z2 = lerp(z0, z1, t2), y2 = H + 0.95 + 2.8 * Math.sin(PI * t2);
      wr.tube([-Wd / 2, y2, z2], [Wd / 2, y2, z2], 0.05, 3, COL.white);
    }
    // stair towers / ramps both ends
    [z0, z1].forEach(function (ze, k) {
      var dir = k ? 1 : -1;
      wr.use('paint', 'all');
      wr.boxY(0, -0.5, ze + dir * 1.6, Wd + 1.2, H + 0.55, 3.2, COL.concrete);
      wr.use('glass', 'all');
      wr.boxY(0, 1.5, ze + dir * 1.6, Wd + 1.25, H - 0.6, 3.25, COL.glass);
      wr.use('paint', 'all');
      wr.boxY(0, H + 0.55, ze + dir * 1.6, Wd + 1.6, H + 3.2, 3.6, mix(COL.concrete, COL.white, 0.4), { cols: {} });
      wr.boxY(0, H + 3.2, ze + dir * 1.6, Wd + 2.0, H + 3.45, 4.0, acc);
    });
    wr.use('lamp', 'all');
    wr.face([[-0.6, H - 0.02, zl], [0.6, H - 0.02, zl], [0.6, H - 0.02, zr], [-0.6, H - 0.02, zr]], [1.8, 1.75, 1.6, 1], null, [0, H + 3, 0]);
    addLight(B, 0, H - 0.3, (zl + zr) / 2, [0, -1, 0], [1.1, 1.05, 0.95], 22, 45, 80);
  }
  /* ===================================================== coarse distance field
     approx. distance (m) from (x, y) to the nearest track edge (centerline distance - half width), 12 m cells. */
  function makeFarField(geom, pad) {
    var S = geom.samples, N = S.length, step = Math.max(1, Math.round(10 / (geom.ds || 2))), pts = [], i;
    var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (i = 0; i < N; i += step) {
      var q = S[i]; pts.push(q);
      if (q.x < mnX) mnX = q.x; if (q.x > mxX) mxX = q.x; if (q.y < mnY) mnY = q.y; if (q.y > mxY) mxY = q.y;
    }
    mnX -= pad; mnY -= pad; mxX += pad; mxY += pad;
    var cell = 12, gx = Math.ceil((mxX - mnX) / cell) + 1, gy = Math.ceil((mxY - mnY) / cell) + 1;
    var D = new Float32Array(gx * gy), px = new Float64Array(pts.length), py = new Float64Array(pts.length), ph = new Float64Array(pts.length);
    for (i = 0; i < pts.length; i++) { px[i] = pts[i].x; py[i] = pts[i].y; ph[i] = pts[i].hw; }
    for (var yy = 0; yy < gy; yy++) {
      var wy = mnY + yy * cell;
      for (var xx = 0; xx < gx; xx++) {
        var wx = mnX + xx * cell, best = Infinity;
        for (i = 0; i < pts.length; i++) {
          var dx = wx - px[i], dy = wy - py[i], d = dx * dx + dy * dy;
          if (d < best) { best = d; D[yy * gx + xx] = Math.sqrt(d) - ph[i]; }
        }
      }
    }
    function far(x, y) {
      var fx = Math.round((x - mnX) / cell), fy = Math.round((y - mnY) / cell);
      if (fx < 0 || fy < 0 || fx >= gx || fy >= gy) return 1e9;
      return D[fy * gx + fx];
    }
    far.bounds = { minX: mnX, minY: mnY, maxX: mxX, maxY: mxY };
    return far;
  }

  /* ======================================================= skyline rings
     Unit-radius geometry around the origin; the item model is T(camera) * S(R) so the ring sits at a constant
     angular size "at infinity" (no parallax), drawn first with depth writes off (a backdrop behind everything). */
  function skyline(sink, P, style, night, rnd, seed) {
    var wr = new Writer(sink);
    wr.at(0, 0, 0, 0, 'sky');
    function ring(radius, seg, hFn, colFn, mat) {
      wr.use(mat || 'skyline', 'global');
      var prev = null;
      for (var i = 0; i <= seg; i++) {
        var th = i / seg * TAU, c = Math.cos(th), s = Math.sin(th), h = hFn(th);
        var cur = { c: c, s: s, h: h };
        if (prev) {
          var nIn = norm3([-(c + prev.c) * 0.5 * 0.55, 0.85, -(s + prev.s) * 0.5 * 0.55]);
          var mid0 = prev.h * 0.5, mid1 = h * 0.5;
          var A = [prev.c * radius, -0.07, prev.s * radius], Bp = [c * radius, -0.07, s * radius];
          var A1 = [prev.c * radius, mid0, prev.s * radius], B1 = [c * radius, mid1, s * radius];
          var A2 = [prev.c * radius * 0.995, prev.h, prev.s * radius * 0.995], B2 = [c * radius * 0.995, h, s * radius * 0.995];
          wr.quadN([A, Bp, B1, A1], null, null, nIn, [colFn(-1, prev.h), colFn(-1, h), colFn(0.5, h), colFn(0.5, prev.h)]);
          wr.quadN([A1, B1, B2, A2], null, null, nIn, [colFn(0.5, prev.h), colFn(0.5, h), colFn(1, h), colFn(1, prev.h)]);
        }
        prev = cur;
      }
    }
    var hill = night ? mul(mix(P.tree, P.grass, 0.4), 0.35) : mix(mul(P.tree, 0.9), P.grass, 0.35);
    var rockC = night ? lin('#1b1f2b') : mix(lin('#6f7787'), P.sky, 0.25), snow = night ? lin('#5a6070') : lin('#f2f5f8');
    var S1 = seed % 997;
    if (style.oval) {
      var mesa = lin('#b07a4f');
      ring(1.0, 160, function (t) { var n = ringNoise(t, 2.6, S1); return 0.012 + 0.05 * smooth((n - 0.47) / 0.06) + 0.006 * ringNoise(t, 14, S1 + 3); },
        function (k, h) { return k < 0 ? mul(mesa, 0.55) : k < 1 ? mesa : mul(mesa, 1.12 - h * 2); });
      ring(0.8, 120, function (t) { return 0.006 + 0.016 * ringNoise(t, 7, S1 + 5); }, function (k) { return k < 0 ? mul(hill, 0.6) : k < 1 ? mix(hill, mesa, 0.4) : mix(hill, mesa, 0.25); });
      return;
    }
    var big = style.touge ? 0.15 : style.kart ? 0.05 : 0.095;
    ring(1.0, 200, function (t) {
      var n = ringNoise(t, 3.4, S1), r2 = ringNoise(t, 11, S1 + 9);
      return 0.018 + big * Math.pow(n, 1.7) * 1.4 + 0.012 * r2;
    }, function (k, h) {
      if (k < 0) return mul(rockC, 0.62);
      var sn = !style.street && h > big * 0.62 ? smooth((h - big * 0.62) / (big * 0.2)) : 0;
      return k < 1 ? mix(rockC, hill, 0.25) : mix(rockC, snow, sn);
    });
    ring(0.82, 150, function (t) { return 0.008 + (style.touge ? 0.06 : 0.022) * ringNoise(t, 8, S1 + 21); },
      function (k) { return k < 0 ? mul(hill, 0.5) : k < 1 ? mul(hill, 0.85) : hill; });
    if (style.street || night) {
      // distant city skyline (textured towers)
      var tall = night || style.night, n = tall ? 120 : 90, rr = 0.7, U = 1400;
      for (var i = 0; i < n; i++) {
        var th = (i + rnd() * 0.6) / n * TAU;
        var dens = ringNoise(th, 2.2, S1 + 40);
        if (dens < (tall ? 0.38 : 0.5)) continue;
        var hgt = (tall ? 0.03 + 0.13 * Math.pow(rnd(), 2) * (0.5 + dens) : 0.006 + 0.012 * rnd());
        var w = (tall ? 0.018 : 0.022) * (0.6 + rnd() * 0.8), d = w * (0.7 + rnd() * 0.6);
        var cx = Math.cos(th) * rr, cz = Math.sin(th) * rr;
        var wr2 = new Writer(sink); wr2.at(cx, -cz, PI / 2 - th, 0, 'sky');
        wr2.use('facade' + (tall ? (rnd() < 0.7 ? 0 : 2) : 3), 'global');
        // local Z points outward; the visible face is -Z (towards the camera at the centre)
        var us = [FACADE_BAY * FACADE_COLS / U, FACADE_STOREY * FACADE_FLOORS / U], tint = mix(WHITE, rnd.pick([lin('#9fb3c8'), lin('#d0c8bc'), lin('#8aa0b8')]), 0.3);
        wr2.wallX(-w / 2, w / 2, -d / 2, -0.07, hgt, -1, tint, us);
        wr2.wallZ(d / 2, -d / 2, -w / 2, -0.07, hgt, -1, tint, us);
        wr2.wallZ(-d / 2, d / 2, w / 2, -0.07, hgt, 1, tint, us);
        wr2.use('skyline', 'global');
        wr2.face([[-w / 2, hgt, -d / 2], [w / 2, hgt, -d / 2], [w / 2, hgt, d / 2], [-w / 2, hgt, d / 2]], mul(rockC, 0.6), null, [0, 0, 0]);
        if (night && rnd() < 0.5) {
          wr2.use('glow', 'global');
          var gc = mul(rnd.pick([P.glow, P.accent, lin('#ff3b30')]), 2.5);
          wr2.box(0, hgt + 0.0006, -d / 2, w, 0.0012, 0.0005, gc);
        }
      }
    }
  }

  /* ================================================================ main */
  function buildGeometry(geom, trackDef, opts) {
    opts = opts || {};
    if (!geom || !geom.samples || geom.samples.length < 8) throw new Error('scenery: invalid geometry');
    var def = trackDef || geom.def || {};
    var qn = normQ(opts.quality), Q = QUALITY[qn];
    var style = def.style || {}, theme = def.theme || geom.theme || {};
    var tod = opts.timeOfDay || def.timeOfDay || 'day';
    var night = tod === 'night';
    var P = paletteFor(def, geom);
    var seedStr = (geom.id || def.id || 'track') + ':scenery3d';
    var rnd = rngFor(seedStr), seed = hashStr(seedStr);
    var S = geom.samples, N = S.length, L = geom.length || N * (geom.ds || 2), ds = geom.ds || L / N;
    var gfn = typeof opts.groundY === 'function' ? opts.groundY : (opts.track && typeof opts.track.groundY === 'function' ? opts.track.groundY : null);
    function gy(x, y) { if (!gfn) return 0; var v; try { v = gfn(x, -y); } catch (e) { v = 0; } return fin(v, 0); }
    function baseRect(x, y, rot, l, w) {
      var c = Math.cos(rot), s = Math.sin(rot), m = gy(x, y);
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (k) { m = Math.min(m, gy(x + c * l / 2 * k[0] - s * w / 2 * k[1], y + s * l / 2 * k[0] + c * w / 2 * k[1])); });
      return m;
    }
    var projectFn = (CB.race && CB.race.tracks && typeof CB.race.tracks.project === 'function') ? function (x, y) { return CB.race.tracks.project(geom, x, y); }
      : (typeof geom.project === 'function' ? function (x, y) { return geom.project(x, y); } : null);
    var clearance = makeClearance(geom), far = makeFarField(geom, 320), occ = new Occupancy();
    var sink = new Sink(), wr = new Writer(sink);
    var atlas = atlasEntries();
    var B = {
      wr: wr, P: P, rnd: rnd, lights: [], night: night, tod: tod, wheels: [], blinkers: [], gantryLenses: null,
      waterCol: lin(theme.water || (night ? '#0b2440' : '#2f6f9f')),
      brand: function (r) { return (r || rnd).pick(BRANDS); }
    };
    var placed = [], stats = { trees: 0, nearTrees: 0, objects: 0, byType: {} };
    function note(type, x, y, r, extra) {
      var o = { type: type, x: x, y: y, r: r };
      if (extra) for (var k in extra) o[k] = extra[k];
      placed.push(o); stats.byType[type] = (stats.byType[type] || 0) + 1; stats.objects++;
    }
    function trackOK(x, y, r) {
      if (clearance(x, y) < r) return false;
      if (projectFn) {
        var p = null;
        try { p = projectFn(x, y); } catch (e) { p = null; }
        if (p && isFinite(p.wallDist) && p.wallDist > -r * 0.5) return false;
      }
      return true;
    }
    function rectOK(x, y, rot, l, w, pad) {
      var c = Math.cos(rot), s = Math.sin(rot), hl = l / 2, hw = w / 2;
      for (var a = -1; a <= 1.001; a += 0.5) for (var b = -1; b <= 1.001; b += 0.5) {
        if (Math.abs(a) < 1 && Math.abs(b) < 1) continue;
        var px = x + c * hl * a - s * hw * b, py = y + s * hl * a + c * hw * b;
        if (clearance(px, py) < pad) return false;
      }
      return trackOK(x, y, Math.min(hl, hw));
    }
    var nearCap = { low: 600, medium: 1200, high: 1800, ultra: 2900 }[qn];

    function putTree(x, y, r, variant, forceFar, lite) {
      var yaw = rnd() * TAU, base = gy(x, y) - 0.05;
      var nearOK = !forceFar && stats.nearTrees < nearCap;
      wr.at(x, y, yaw, base);
      // trees without near geometry keep their cards at every distance ('bill' band)
      if (nearOK) { treeNear(wr, variant, r, P, rnd, lite); stats.nearTrees++; treeFar(wr, variant, r, P, rnd, atlas, 'far'); }
      else treeFar(wr, variant, r, P, rnd, atlas, 'bill');
      stats.trees++;
    }

    /* ---------- 1. authored trackDef scenery (resolved by tracks.build) ---------- */
    var items = (geom.scenery || []).slice();
    items.forEach(function (o) {
      if (o.shape === 'circle' || o.type === 'tree' || o.type === 'water') occ.markCircle(o.x, o.y, Math.max(0.5, o.r * (o.type === 'tree' ? 0.7 : 1)), o.type === 'water' ? 2 : 1);
      else occ.markRect(o.x, o.y, o.rot, o.l, o.w, 0.5, 1);
    });
    var authoredTypes = {}, variantsSeen = {};
    items.forEach(function (o) {
      authoredTypes[o.type] = (authoredTypes[o.type] || 0) + 1;
      if (o.type === 'tree' && o.variant) variantsSeen[o.variant] = 1;
      var yawF = fin(o.rot, 0) + (o.side > 0 ? PI : 0);
      var shape = o.shape === 'circle' ? 0 : 1, base = shape ? baseRect(o.x, o.y, o.rot, o.l, o.w) : gy(o.x, o.y);
      try {
        switch (o.type) {
          case 'tree': putTree(o.x, o.y, o.r || 3, o.variant || 'oak'); return;
          case 'bush': wr.at(o.x, o.y, rnd() * TAU, base); wr.use('foliage', 'detail'); treeNear(wr, 'shrub', o.r || 1.2, P, rnd); break;
          case 'rock': wr.at(o.x, o.y, rnd() * TAU, base - 0.2); rock(wr, o.r || 2, P, rnd); break;
          case 'water': wr.at(o.x, o.y, 0, Math.max(-0.02, base) + 0.06); water(B, o); break;
          case 'cone': wr.at(o.x, o.y, 0, base); cone(wr, 0, 0, 1); break;
          case 'lamp': wr.at(o.x, o.y, yawF, base); lampPost(B, o); break;
          case 'grandstand': wr.at(o.x, o.y, yawF, base); grandstand(B, o); break;
          case 'pits': wr.at(o.x, o.y, yawF, base); pitBuilding(B, o); paddock(o, yawF); break;
          case 'tower': wr.at(o.x, o.y, yawF, base); tower(B, o); break;
          case 'building': wr.at(o.x, o.y, yawF, base); building(B, o); break;
          case 'tyres': wr.at(o.x, o.y, yawF, base); tyreStack(wr, o.l, o.w, o.h || 1, o.color ? lin(o.color) : null, rnd); break;
          case 'marshal': wr.at(o.x, o.y, yawF, base); marshalPost(B, o); break;
          case 'billboard':
            if (o.variant === 'distance') { wr.at(o.x, o.y, fin(o.rot, 0) - 0.3 * (o.side > 0 ? -1 : 1), base); distanceBoard(B, o.text || '100'); }
            else {
              var txt = o.text;
              if (o.variant === 'chevron') {
                var sm = S[Math.round(mod(o.s || 0, L) / ds) % N], ahead = S[(Math.round(mod(o.s || 0, L) / ds) + Math.round(20 / ds)) % N];
                var k = ahead && sm ? wrapAngle(ahead.heading - sm.heading) : 0;
                txt = k > 0 ? '<' : '>';
              }
              wr.at(o.x, o.y, yawF, base); billboard(B, { l: o.l, h: o.h, text: txt, variant: o.variant, lit: o.lit || (night && style.night), color: o.color });
            }
            break;
          case 'tent': wr.at(o.x, o.y, yawF, base); tent(B, o); break;
          case 'barrier': wr.at(o.x, o.y, yawF, base); wr.use('paint', 'all'); wr.boxY(0, -0.2, 0, o.l, o.h || 1, Math.min(o.w, 0.8), COL.concrete); break;
          case 'f1-landmark': break;   // drawn by CB.gl.f1scenery.decorate (js/race/gl/f1-scenery.js)
          default: wr.at(o.x, o.y, yawF, base); wr.use('paint', 'all'); wr.boxY(0, -0.5, 0, o.l, o.h || 3, o.w, lin(o.color || '#b9b6ae')); break;
        }
        note(o.type, o.x, o.y, o.r || (isFinite(o.l) || isFinite(o.w) ? Math.max(fin(o.l, 0), fin(o.w, 0)) / 2 : 1), { authored: true, variant: o.variant, l: o.l, w: o.w, h: o.h, rot: fin(o.rot, yawF) });
      } catch (e) { if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] item ' + o.type, e); }
    });

    function paddock(o, yawF) {
      // transporters + motorhomes parked behind the pit building
      var c = Math.cos(yawF), s = Math.sin(yawF), n = Math.min(8, Math.floor(o.l / 16));
      for (var i = 0; i < n; i++) {
        var lx = -o.l / 2 + 8 + i * (o.l - 16) / Math.max(1, n - 1), lz = o.w / 2 + 10;
        // local -> sim: X along (c, -s) in GL => sim (c, s); local Z -> sim (s, -c)
        var x = o.x + c * lx + s * lz, y = o.y + s * lx - c * lz;
        var yaw = yawF + PI / 2;
        if (!rectOK(x, y, yaw, 16, 3.5, 2) || occ.hitRect(x, y, yaw, 16, 3.5, 0.5)) continue;
        occ.markRect(x, y, yaw, 16, 3.5, 0.5);
        wr.at(x, y, yaw, gy(x, y)); truck(wr, TEAM[(i * 3 + 1) % TEAM.length], rnd);
        note('truck', x, y, 8);
      }
    }

    /* ---------- 2. start / finish gantry ---------- */
    var gInfo = null;
    try {
      gInfo = gantry(B, geom, clearance);
      var s0 = S[0];
      [gInfo.zl, gInfo.zr].forEach(function (z) { var px = s0.x - s0.nx * z, py = s0.y - s0.ny * z; occ.markCircle(px, py, 1.5); note('gantry-pillar', px, py, 0.8); });
    } catch (e) { gInfo = null; if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] gantry', e); }
    /* ---------- 2b. F1 circuits: pit wall / lane paint / team boxes / DRS + sector boards / landmarks (docs/F1-SPEC.md) ---------- */
    if (def.f1 && CB.gl.f1scenery && typeof CB.gl.f1scenery.decorate === 'function') {
      try {
        stats.f1 = CB.gl.f1scenery.decorate({ wr: wr, B: B, geom: geom, def: def, occ: occ, note: note, gy: gy, quality: qn, Q: Q, night: night,
          lin: lin, mix: mix, mul: mul, COL: COL, WHITE: WHITE, rnd: rnd });
      } catch (eF) { if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] f1', eF); }
    }

    /* ---------- 3. footbridge over the track (one location) ---------- */
    (function () {
      if (style.kart) return;
      var best = null, bestScore = -Infinity, crossings = geom.crossings || [];
      var step = Math.max(1, Math.round(10 / ds));
      for (var i = Math.round(N * 0.22); i < Math.round(N * 0.8); i += step) {
        var sm = S[i], straight = true;
        for (var k = -Math.round(40 / ds); k <= Math.round(40 / ds); k += 2) if (Math.abs(S[mod(i + k, N)].curvature) > 0.0025 || S[mod(i + k, N)].layer) { straight = false; break; }
        if (!straight) continue;
        var span = sm.wallL + sm.wallR;
        if (span > 46) continue;
        var bad = false;
        crossings.forEach(function (cr) { if (cr && Math.hypot((cr.x || 0) - sm.x, (cr.y || 0) - sm.y) < 140) bad = true; });
        if (bad) continue;
        var zl = -(sm.wallL + 2.4), zr = sm.wallR + 2.4;
        var pl = [sm.x - sm.nx * zl, sm.y - sm.ny * zl], pr = [sm.x - sm.nx * zr, sm.y - sm.ny * zr];
        var ends = [[sm.x - sm.nx * (zl - 2.2), sm.y - sm.ny * (zl - 2.2)], [sm.x - sm.nx * (zr + 2.2), sm.y - sm.ny * (zr + 2.2)]];
        if (clearance(pl[0], pl[1]) < 1.2 || clearance(pr[0], pr[1]) < 1.2) continue;
        if (occ.hitCircle(ends[0][0], ends[0][1], 3.5) || occ.hitCircle(ends[1][0], ends[1][1], 3.5)) continue;
        var sc = -Math.abs(i / N - 0.5) * 20 - span * 0.1 + rnd() * 2;
        if (sc > bestScore) { bestScore = sc; best = { sm: sm, zl: zl, zr: zr, ends: ends }; }
      }
      if (!best) return;
      footbridge(B, best.sm, best.zl, best.zr);
      best.ends.forEach(function (e) { occ.markCircle(e[0], e[1], 4); note('footbridge-tower', e[0], e[1], 2.5); });
      note('footbridge', best.sm.x, best.sm.y, 0, { spans: true, s: best.sm.s });
    })();

    /* ---------- 4. grandstand + pits near the start when the recipe has none ---------- */
    function nearStart(type, dist) {
      return items.some(function (o) { return o.type === type && Math.hypot(o.x - S[0].x, o.y - S[0].y) < dist; });
    }
    function besideTrack(sIdx, side, l, w, off) {
      var sm = S[mod(sIdx, N)], span = Math.ceil((l / 2 + 2) / ds), wmax = 0;
      for (var k = -span; k <= span; k++) { var q = S[mod(sIdx + k, N)]; wmax = Math.max(wmax, side > 0 ? q.wallL : q.wallR); }
      var lat = side * (wmax + off + w / 2);
      return { x: sm.x + sm.nx * lat, y: sm.y + sm.ny * lat, rot: sm.heading, side: side, l: l, w: w };
    }
    function tryRect(o, pad) {
      if (!rectOK(o.x, o.y, o.rot, o.l, o.w, pad || 1) || occ.hitRect(o.x, o.y, o.rot, o.l, o.w, 0)) return false;
      occ.markRect(o.x, o.y, o.rot, o.l, o.w, 0.5);
      return true;
    }
    if (!style.touge) {
      if (!nearStart('grandstand', 300)) {
        var gsd = besideTrack(-Math.round(60 / ds), 1, 70, 20, 3);
        if (tryRect(gsd)) { wr.at(gsd.x, gsd.y, gsd.rot + PI, baseRect(gsd.x, gsd.y, gsd.rot, 70, 20)); grandstand(B, { l: 70, w: 20, h: 15 }); note('grandstand', gsd.x, gsd.y, 36, { l: 70, w: 20, h: 15, rot: gsd.rot }); }
      }
      if (!nearStart('pits', 400)) {
        var pd = besideTrack(-Math.round(80 / ds), -1, 140, 14, 3);
        if (tryRect(pd)) { wr.at(pd.x, pd.y, pd.rot, baseRect(pd.x, pd.y, pd.rot, 140, 14)); pitBuilding(B, { l: 140, w: 14, h: 8, text: (def.short || 'PIT LANE') }); note('pits', pd.x, pd.y, 70, { l: 140, w: 14, h: 8, rot: pd.rot }); }
      }
    }

    /* ---------- 5. corner furniture: tyre stacks at gravel run-offs, spectators, TV towers, curve mirrors ---------- */
    (corners(geom) || []).forEach(function (cn, ci) {
      var apex = cn.apex != null ? cn.apex : cn.start, dir = cn.dir || (S[apex].curvature >= 0 ? 1 : -1), out = -dir;
      var exitIdx = cn.end != null ? mod(cn.end + Math.round(15 / ds), N) : apex;
      var sm = S[exitIdx], sand = out > 0 ? sm.sandL : sm.sandR;
      var hasTyres = items.some(function (o) { return o.type === 'tyres' && Math.hypot(o.x - sm.x, o.y - sm.y) < 60; });
      if (!style.street && sand > 1 && !hasTyres) {
        var t = besideTrack(exitIdx, out, 24, 1.4, 0.3);
        if (tryRect(t, 0.15)) { wr.at(t.x, t.y, t.rot + (out > 0 ? PI : 0), baseRect(t.x, t.y, t.rot, 24, 1.4)); tyreStack(wr, 24, 1.4, 1, P.kerbA, rnd); note('tyres', t.x, t.y, 12, { l: 24, w: 1.4, h: 1, rot: t.rot }); }
      }
      var radius = cn.minRadius || 1 / Math.max(1e-4, Math.abs(S[apex].curvature));
      // spectators along the fence on the outside of slow corners
      if (radius < 90 && !style.kart) {
        var crowdN = Math.round((style.touge ? 14 : 10) * Q.fill);
        for (var p = 0; p < crowdN; p++) {
          var idx = mod(apex + Math.round(rnd.range(-25, 25) / ds), N), q = S[idx];
          var lat = out * ((out > 0 ? q.wallL : q.wallR) + rnd.range(2.2, 5));
          var x = q.x + q.nx * lat, y = q.y + q.ny * lat;
          if (clearance(x, y) < 1.6 || occ.hitCircle(x, y, 0.4)) continue;
          occ.markCircle(x, y, 0.5);
          wr.at(x, y, q.heading + (out > 0 ? PI : 0) + rnd.range(-0.4, 0.4), gy(x, y)); wr.use('paint', 'detail');
          wr.person(0, 0, 0, rnd.pick(SHIRTS), rnd, { armsUp: rnd() < 0.25 });
        }
        note('spectators', S[apex].x, S[apex].y, 20, { marker: true });
      }
      // TV camera scaffold (circuits)
      if (!style.street && !style.touge && !style.kart && ci % 3 === 1) {
        var tv = besideTrack(apex, out, 3, 3, 6);
        if (tryRect(tv, 2)) {
          wr.at(tv.x, tv.y, tv.rot + (out > 0 ? PI : 0), gy(tv.x, tv.y)); wr.use('metal', 'all');
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (c) { wr.boxY(c[0] * 1.3, 0, c[1] * 1.3, 0.1, 5, 0.1, COL.steel); });
          wr.boxY(0, 5, 0, 3, 5.15, 3, COL.dark);
          wr.use('paint', 'detail'); wr.person(0.4, 5.15, 0.4, COL.dark, rnd, {});
          wr.box(-0.3, 6.4, -0.3, 0.6, 0.5, 0.9, COL.black);
          wr.use('paint', 'all'); wr.boxY(0, 7.4, 0, 3.4, 7.5, 3.4, COL.white);
          [-1.6, 1.6].forEach(function (x) { wr.boxY(x, 5.15, 1.6, 0.06, 7.4, 0.06, COL.steel); });
          note('tv-tower', tv.x, tv.y, 2);
        }
      }
      // convex traffic mirror (touge)
      if (style.touge && radius < 60) {
        var mi = besideTrack(apex, out, 0.6, 0.6, 0.8);
        if (clearance(mi.x, mi.y) > 0.5 && !occ.hitCircle(mi.x, mi.y, 0.5)) {
          occ.markCircle(mi.x, mi.y, 0.6);
          wr.at(mi.x, mi.y, mi.rot + (out > 0 ? PI : 0), gy(mi.x, mi.y));
          wr.use('paint', 'detail');
          wr.cyl(0, -0.2, 0, 0.06, 0.06, 3.2, 5, COL.orange, { top: false });
          wr.use('metal', 'detail');
          var ring = []; for (var a = 0; a < 10; a++) { var an = a / 10 * TAU; ring.push([Math.cos(an) * 0.45, 3.2 + Math.sin(an) * 0.45, -0.1]); }
          wr.face(ring, lin('#cfd6dc'), null, [0, 3.2, 1]);
          wr.use('paint', 'detail'); wr.cyl(0, 3.2, 0, 0.5, 0.5, 0.05, 10, COL.orange);
          note('mirror', mi.x, mi.y, 0.5);
        }
      }
    });

    /* ---------- 6. extra hoardings on long straights + night lamps ---------- */
    if (!style.touge) {
      var stepB = Math.round(90 / ds), lastB = -1e9;
      for (var bi = Math.round(N * 0.08); bi < N * 0.95; bi += stepB) {
        var bs = S[bi];
        if (Math.abs(bs.curvature) > 0.002 || bs.layer) continue;
        if (items.some(function (o) { return o.type === 'billboard' && Math.hypot(o.x - bs.x, o.y - bs.y) < 120; })) continue;
        if (bi - lastB < stepB * 2 || rnd() > 0.6 * Q.fill) continue;
        var side = rnd() < 0.5 ? 1 : -1, bb = besideTrack(bi, side, 16, 1.2, 1.2);
        if (!tryRect(bb, 0.6)) continue;
        lastB = bi;
        wr.at(bb.x, bb.y, bb.rot + (side > 0 ? PI : 0), baseRect(bb.x, bb.y, bb.rot, 16, 1.2));
        billboard(B, { l: 16, h: 5, text: B.brand(), lit: night && style.night });
        note('billboard', bb.x, bb.y, 8, { l: 16, w: 1.2, h: 5, rot: bb.rot });
      }
    }
    var lightsWanted = night || tod === 'dusk' || style.street;
    if (lightsWanted && (authoredTypes.lamp || 0) < L / 90) {
      var lampStep = Math.round((style.street ? 36 : 60) / ds), lampK = 0;
      for (var li = 0; li < N; li += lampStep) {
        var sl = (lampK++ % 2) ? 1 : -1, lp = besideTrack(li, sl, 0.6, 0.6, style.street ? 0.5 : 1.0);
        if (clearance(lp.x, lp.y) < 0.5 || occ.hitCircle(lp.x, lp.y, 0.6)) continue;
        occ.markCircle(lp.x, lp.y, 0.7);
        wr.at(lp.x, lp.y, lp.rot + (sl > 0 ? PI : 0), gy(lp.x, lp.y)); lampPost(B, { variant: style.night ? 'flood' : style.touge ? 'road' : 'street', h: style.night ? 14 : style.touge ? 7 : 9.5, color: style.night ? '#fff4d6' : null });
        note('lamp', lp.x, lp.y, 0.5, { l: 0.6, w: 0.6, h: style.night ? 14 : style.touge ? 7 : 9.5, rot: lp.rot });
      }
    }

    if (style.street && (authoredTypes.tree || 0) < L / 200) {
      var tStep = Math.round(48 / ds), tk = 0, sv = style.night ? ['palm'] : ['palm', 'cypress'];
      for (var ti = Math.round(20 / ds); ti < N; ti += tStep) {
        var tside = (tk++ % 2) ? 1 : -1, tp = besideTrack(ti, tside, 2, 2, 1.0);
        if (clearance(tp.x, tp.y) < 1.2 || occ.hitCircle(tp.x, tp.y, 1.2)) continue;
        occ.markCircle(tp.x, tp.y, 1.4);
        putTree(tp.x, tp.y, rnd.range(1.6, 2.5), rnd.pick(sv));
        note('tree', tp.x, tp.y, 1.5, { street: true });
      }
    }

    /* ---------- 7. touge: retaining walls with frame grid, cliff rocks ---------- */
    if (style.touge) {
      [1, -1].forEach(function (side) {
        var prev = null, stepW = Math.max(1, Math.round(6 / ds));
        for (var i = 0; i <= N; i += stepW) {
          var q = S[i % N], w = side > 0 ? q.wallL : q.wallR;
          var gx = q.x + q.nx * side * (w + 40), gyy = q.y + q.ny * side * (w + 40), g40 = gy(gx, gyy);
          var h = clamp(g40 * 0.55, 0, 9);
          var bx = q.x + q.nx * side * (w + 1.3), by = q.y + q.ny * side * (w + 1.3);
          var tx = q.x + q.nx * side * (w + 1.3 + h * 0.45), ty = q.y + q.ny * side * (w + 1.3 + h * 0.45);
          var ok = h > 2.5 && clearance(bx, by) > 0.3 && clearance(tx, ty) > 0.3 && !occ.hitCircle(bx, by, 0.5);
          var cur = ok ? { b: [bx, -0.3, -by], t: [tx, h, -ty], f: [gx, g40 - 0.3, -gyy], i: i, h: h } : null;
          // skip twisted / stretched panels (inside of tight hairpins, where the offset base and top lines cross)
          var segOk = cur && prev && cur.i - prev.i <= stepW;
          if (segOk) {
            var dbx = cur.b[0] - prev.b[0], dbz = cur.b[2] - prev.b[2], dtx = cur.t[0] - prev.t[0], dtz = cur.t[2] - prev.t[2];
            var lb = Math.hypot(dbx, dbz), lt = Math.hypot(dtx, dtz), dsx = stepW * ds;
            var dfx = cur.f[0] - prev.f[0], dfz = cur.f[2] - prev.f[2];
            segOk = dbx * dtx + dbz * dtz > 0 && dbx * dfx + dbz * dfz > 0 && lb < dsx * 2.2 + 1 && lt < dsx * 2.6 + 2 && lt > lb * 0.25;
          }
          if (segOk) {
            wr.at(0, 0, 0, 0, chunkOf(bx, by));
            var rockyN = vnoise(i * ds / 90, side * 7, seed % 101) > 0.55;
            wr.use('paint', 'all');
            var wc = rockyN ? mix(P.rock, COL.concreteDark, 0.3) : mix(COL.concrete, P.rock, 0.25);
            wr.face([prev.b, cur.b, cur.t, prev.t], wc, null, [prev.b[0] + (prev.f[0] - prev.b[0]) * 0.5, -5, prev.b[2] + (prev.f[2] - prev.b[2]) * 0.5]);
            // slope above the wall blending into the hillside
            wr.use('foliage', 'all');
            wr.face([prev.t, cur.t, cur.f, prev.f], mix(P.grass, P.tree, 0.4), null, [cur.t[0], -50, cur.t[2]]);
            if (!rockyN) {
              // frame grid ribs (detail)
              wr.use('paint', 'detail');
              for (var r = 1; r < 3; r++) {
                var f = r / 3, a = [lerp(prev.b[0], prev.t[0], f), lerp(prev.b[1], prev.t[1], f), lerp(prev.b[2], prev.t[2], f)], b = [lerp(cur.b[0], cur.t[0], f), lerp(cur.b[1], cur.t[1], f), lerp(cur.b[2], cur.t[2], f)];
                wr.beam(a, b, 0.35, 0.3, mul(COL.concrete, 1.08));
              }
              wr.beam(cur.b, cur.t, 0.35, 0.3, mul(COL.concrete, 1.08));
            } else if (rnd() < 0.5) {
              wr.at(bx, by, rnd() * TAU, -0.3); rock(wr, rnd.range(1.0, 2.2), P, rnd, 0.8);
            }
          }
          prev = cur;
        }
      });
      note('retaining-walls', S[0].x, S[0].y, 0, { marker: true });
    }

    /* ---------- 8. city fill (street / night-city circuits) ---------- */
    if (style.street) {
      // extend harbour / bay water outward first so the city does not grow out of the sea
      items.filter(function (o) { return o.type === 'water' && (o.variant === 'harbour' || o.variant === 'bay'); }).forEach(function (o, k) {
        if (k % 2) return;
        var sm = S[Math.round(mod(o.s, L) / ds) % N];
        [[1.7, 1.5], [3.4, 2.2], [5.8, 3]].forEach(function (f) {
          var lat = o.lat + o.side * o.r * f[0], x = sm.x + sm.nx * lat, y = sm.y + sm.ny * lat, rr = o.r * f[1];
          if (clearance(x, y) < rr + 3 || occ.hitCircle(x, y, rr * 0.6, 1)) return;
          occ.markCircle(x, y, rr, 2);
          wr.at(x, y, 0, Math.max(-0.02, gy(x, y)) + 0.06); water(B, { r: rr, variant: o.variant, x: x, y: y });
          note('water', x, y, rr);
        });
      });
      var fb = far.bounds, cellC = style.night ? 46 : 34, cnt = 0, cap = Math.round((style.night ? 260 : 340) * Q.city);
      for (var cy2 = fb.minY; cy2 < fb.maxY && cnt < cap; cy2 += cellC) {
        for (var cx2 = fb.minX; cx2 < fb.maxX && cnt < cap; cx2 += cellC) {
          var x = cx2 + rnd.range(-6, 6), y = cy2 + rnd.range(-6, 6), fd = far(x, y);
          if (fd < 16 || fd > (style.night ? 300 : 230)) continue;
          var pr = projectFn ? projectFn(x, y) : null, rot = pr && isFinite(pr.heading) ? pr.heading : 0;
          var l = rnd.range(16, cellC - 4), w = rnd.range(14, cellC - 6);
          if (!rectOK(x, y, rot, l, w, 3) || occ.hitRect(x, y, rot, l, w, 1)) continue;
          occ.markRect(x, y, rot, l, w, 1);
          var h, col, acc;
          if (style.night) {
            h = clamp(40 + 220 * Math.pow(rnd(), 1.6) * smooth(1 - fd / 360) + fd * 0.05, 20, 260);
            col = rnd.pick([lin('#9fb3c8'), lin('#5e7088'), lin('#c2ccd8'), lin('#3d4b60')]); acc = rnd.pick([P.glow, P.accent, lin('#ffb21e'), lin('#7cff6b')]);
          } else {
            h = rnd.range(9, 26) * (1 + smooth(fd / 230) * 0.3);
            col = rnd.pick([lin('#e9dcc3'), lin('#d8b38a'), lin('#efe6d6'), lin('#c99f7a'), lin('#e3c9a0')]); acc = rnd.pick([lin('#b5562f'), lin('#9c4a2a'), lin('#c06a3a')]);
          }
          var side3 = pr && pr.lateral >= 0 ? 1 : -1;
          wr.at(x, y, rot + (side3 > 0 ? PI : 0), baseRect(x, y, rot, l, w));
          city(B, l, w, h, col, acc, style.night, {});
          note('city', x, y, Math.max(l, w) / 2, { l: l, w: w, h: h, rot: rot });
          cnt++;
        }
      }
    }

    /* ---------- 9. forest fill (procedural, clustered) ---------- */
    if (!style.street) {
      var kinds = Object.keys(variantsSeen);
      if (!kinds.length) kinds = style.oval ? ['oak', 'poplar'] : ['oak', 'pine', 'birch'];
      var perKm = style.touge ? 520 : style.kart ? 260 : style.oval ? 160 : 330;
      var target = Math.round(perKm * (L / 1000) * Q.trees), placedT = 0, tries = 0, fb2 = far.bounds;
      var maxBand = style.kart ? 160 : 290;
      while (placedT < target && tries < target * 8) {
        tries++;
        var x = rnd.range(fb2.minX, fb2.maxX), y = rnd.range(fb2.minY, fb2.maxY), fd = far(x, y);
        if (fd < 10 || fd > maxBand) continue;
        var dens = fbm(x / 210, y / 210, seed % 911, 3);
        var pAcc = smooth((dens - 0.4) / 0.18) * 0.95 + 0.05;
        if (rnd() > pAcc) continue;
        var r = rnd.range(1.8, 3.8), variant = rnd.pick(kinds);
        if (fd < 60 && clearance(x, y) < r + 2.5) continue;
        if (occ.hitCircle(x, y, r * 0.75)) continue;
        if (fd < 40 && !trackOK(x, y, r + 1)) continue;
        occ.markCircle(x, y, r * 0.75);
        putTree(x, y, r, variant, fd > 115 && rnd() < 0.8, fd > 45);
        placedT++;
      }
      // scattered bushes / small rocks near the run-off (detail)
      var nB = Math.round(L / 1000 * 70 * Q.fill);
      for (var bk = 0; bk < nB; bk++) {
        var si = (rnd() * N) | 0, sq = S[si], sd = rnd() < 0.5 ? 1 : -1, lat2 = sd * ((sd > 0 ? sq.wallL : sq.wallR) + rnd.range(3, 22));
        var bx2 = sq.x + sq.nx * lat2, by2 = sq.y + sq.ny * lat2;
        if (clearance(bx2, by2) < 2 || occ.hitCircle(bx2, by2, 1)) continue;
        occ.markCircle(bx2, by2, 1);
        wr.at(bx2, by2, rnd() * TAU, gy(bx2, by2) - 0.1);
        if (rnd() < 0.7) { wr.use('foliage', 'detail'); treeNear(wr, 'shrub', rnd.range(0.7, 1.6), P, rnd); }
        else rock(wr, rnd.range(0.5, 1.2), P, rnd);
      }
    }

    /* ---------- 9b. edge vegetation (grass tufts, bushes) + roadside details (delineators, utility poles) ---------- */
    if (!style.street) {
      // grass tufts in a band just outside the barriers (never inside the walls: run-off grass is drivable)
      if (Q.tufts > 0) {
        var gCol = mix(P.grass, P.tree, 0.25), gTip = mix(P.grass, lin('#b9b46a'), 0.3), tStep2 = Math.max(1, Math.round(2.4 / ds)), nT = 0;
        var tCap = Math.round(Math.min(L / 1000 * 1450, 7000) * Q.tufts);
        for (var gi = 0; gi < N && nT < tCap; gi += tStep2) {
          var gq = S[gi];
          if (gq.layer) continue;
          for (var gs = -1; gs <= 1; gs += 2) {
            var dn = fbm(gq.x / 26 + gs * 9, gq.y / 26, seed % 577, 2);
            var cntT = dn > 0.62 ? 3 : dn > 0.45 ? 2 : dn > 0.32 ? 1 : 0;
            for (var tk2 = 0; tk2 < cntT; tk2++) {
              var latT = gs * ((gs > 0 ? gq.wallL : gq.wallR) + 0.5 + Math.pow(rnd(), 1.6) * 9);
              var lonT = (rnd() - 0.5) * 2.4 * ds;
              var tx2 = gq.x + gq.nx * latT + gq.tx * lonT, ty2 = gq.y + gq.ny * latT + gq.ty * lonT;
              if (clearance(tx2, ty2) < 0.35 || occ.hitCircle(tx2, ty2, 0.3, 2)) continue;
              wr.at(tx2, ty2, rnd() * TAU, gy(tx2, ty2)); wr.use('grass', 'grass');
              var dry = vnoise(tx2 / 40, ty2 / 40, seed % 313);
              grassTuft(wr, rnd, mix(gCol, lin('#8a7d45'), dry * 0.35), mix(gTip, lin('#d2c27a'), dry * 0.4), 0.3 + rnd() * 0.35, 0.35);
              nT++;
            }
          }
        }
        stats.tufts = nT;
      }
      // denser bushes + boulders along the barrier line (detail)
      var nB2 = Math.round(L / 1000 * (style.touge ? 90 : 60) * Q.fill);
      for (var bk2 = 0; bk2 < nB2; bk2++) {
        var si2 = (rnd() * N) | 0, sq2 = S[si2], sd2 = rnd() < 0.5 ? 1 : -1, lat3 = sd2 * ((sd2 > 0 ? sq2.wallL : sq2.wallR) + rnd.range(1.4, 7));
        var bx3 = sq2.x + sq2.nx * lat3, by3 = sq2.y + sq2.ny * lat3;
        if (sq2.layer || clearance(bx3, by3) < 1.4 || occ.hitCircle(bx3, by3, 0.9)) continue;
        occ.markCircle(bx3, by3, 0.9);
        wr.at(bx3, by3, rnd() * TAU, gy(bx3, by3) - 0.08);
        if (rnd() < 0.72) { wr.use('foliage', 'detail'); treeNear(wr, 'shrub', rnd.range(0.6, 1.3), P, rnd); }
        else rock(wr, rnd.range(0.4, 1.0), P, rnd);
        note('roadside', bx3, by3, 1, { marker: true });
      }
      if (style.touge) {
        // delineator posts both sides, just behind the guardrail
        var dStep = Math.max(1, Math.round(32 / ds));
        for (var di = 0; di < N; di += dStep) {
          var dq = S[di];
          [1, -1].forEach(function (sd3) {
            var lat4 = sd3 * ((sd3 > 0 ? dq.wallL : dq.wallR) + 0.45), dx4 = dq.x + dq.nx * lat4, dy4 = dq.y + dq.ny * lat4;
            if (dq.layer || clearance(dx4, dy4) < 0.3 || occ.hitCircle(dx4, dy4, 0.25)) return;
            occ.markCircle(dx4, dy4, 0.3);
            wr.at(dx4, dy4, dq.heading + (sd3 > 0 ? PI : 0), gy(dx4, dy4)); delineator(wr);
          });
        }
        note('delineators', S[0].x, S[0].y, 0, { marker: true });
        // utility poles with sagging wires along one side
        var pStep = Math.max(1, Math.round(46 / ds)), prevAt = null, prevI = -1e9, pSide = (seed & 1) ? 1 : -1, nPoles = 0;
        for (var pi = 0; pi < N; pi += pStep) {
          var pq = S[pi], lat5 = pSide * ((pSide > 0 ? pq.wallL : pq.wallR) + 3.2), px5 = pq.x + pq.nx * lat5, py5 = pq.y + pq.ny * lat5;
          if (pq.layer || clearance(px5, py5) < 2.4 || occ.hitCircle(px5, py5, 0.8)) { prevAt = null; continue; }
          occ.markCircle(px5, py5, 1);
          var ph5 = 8.5 + rnd() * 1.2;
          wr.at(px5, py5, pq.heading + (pSide > 0 ? PI : 0), gy(px5, py5) - 0.1);
          var at5 = utilityPole(wr, ph5);
          nPoles++;
          if (prevAt && pi - prevI <= pStep) {
            var mxs = (prevAt[1][0] + at5[1][0]) / 2, mzs = (prevAt[1][2] + at5[1][2]) / 2;
            if (clearance(mxs, -mzs) > 1.5) {
              wr.at(0, 0, 0, 0, chunkOf(mxs, -mzs)); wr.use('metal', 'all');
              for (var wi = 0; wi < 3; wi++) {
                var A5 = prevAt[wi], B5 = at5[wi], sag = Math.hypot(B5[0] - A5[0], B5[2] - A5[2]) * 0.03, pp = A5;
                for (var sgi = 1; sgi <= 4; sgi++) {
                  var tq = sgi / 4, np5 = [lerp(A5[0], B5[0], tq), lerp(A5[1], B5[1], tq) - sag * 4 * tq * (1 - tq), lerp(A5[2], B5[2], tq)];
                  wr.beam(pp, np5, 0.03, 0.03, COL.dark, { skip: { px: true, nx: true } });
                  pp = np5;
                }
              }
            }
          }
          prevAt = at5; prevI = pi;
          note('pole', px5, py5, 0.5);
        }
        stats.poles = nPoles;
      }
    }

    /* ---------- 10. distant skyline ---------- */
    try { skyline(sink, P, style, night, rngFor(seedStr + ':sky'), seed); } catch (e) { if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] skyline', e); }

    /* ---------- finalise batches ---------- */
    var rows = sink.slotRows();
    var parts = [];
    function finish(b, dynamic) {
      if (!b.idx.length) return;
      var uv = new Float32Array(b.uv);
      if (b.mat === 'signs' || b.mat === 'signsLit') {
        for (var i = 0; i < uv.length; i += 2) {
          var v = uv[i + 1], slot = Math.floor(v), fr = v - slot, col = slot % 2, row = (slot / 2) | 0;
          uv[i] = (col + clamp(uv[i], 0, 1)) / 2; uv[i + 1] = (row + fr) / rows;
        }
      }
      var mn = b.min, mx = b.max, c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
      var shadowMat = /^(paint|metal|foliage|glass|crowd|facade|signs)/.test(b.mat);
      parts.push({
        key: b.key, mat: b.mat, lod: b.lod, chunk: b.chunk, dynamic: !!dynamic,
        positions: new Float32Array(b.p), normals: new Float32Array(b.n), uvs: uv, colors: new Float32Array(b.c),
        indices: new Uint16Array(b.idx), vertexCount: b.vc, triangleCount: b.idx.length / 3,
        bounds: { min: mn.slice(), max: mx.slice(), center: c, radius: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 },
        castShadow: shadowMat && (b.lod === 'near' || b.lod === 'all' || b.lod === 'detail')
      });
    }
    sink.list.forEach(function (b) { finish(b, false); });
    var dyn = [];
    if (B.gantryLenses) B.gantryLenses.forEach(function (b, k) { if (!b) return; b.key = 'gantry-light-' + k; finish(b, true); parts[parts.length - 1].light = k; dyn.push(parts[parts.length - 1]); });
    // observation wheels: rim + spokes + capsules in wheel-local space (rotated per frame)
    var wheels = B.wheels.map(function (wh, k) {
      var ws = new Sink(), w2 = new Writer(ws), R = wh.R, n = 24;
      w2.at(0, 0, 0, 0, 'wheel'); w2.use('metal', 'dyn');
      var rimPts = [];
      for (var i = 0; i < n; i++) { var a = i / n * TAU; rimPts.push([Math.cos(a) * R, Math.sin(a) * R]); }
      [-2.2, 2.2].forEach(function (z) {
        for (var i = 0; i < n; i++) {
          var a = rimPts[i], b = rimPts[(i + 1) % n];
          w2.tube([a[0], a[1], z], [b[0], b[1], z], 0.45, 4, wh.col);
          w2.tube([0, 0, z * 0.5], [a[0], a[1], z], 0.12, 3, wh.col);
        }
      });
      w2.tube([0, 0, -4], [0, 0, 4], 1.4, 8, COL.steel, { caps: true });
      w2.use('paint', 'dyn');
      for (i = 0; i < n; i += 2) w2.box(rimPts[i][0], rimPts[i][1] - 1.8, 0, 2.6, 2.4, 3.2, mix(WHITE, wh.acc, 0.25));
      if (wh.lit || night) {
        w2.use('glow', 'dyn');
        var gcol = mul(wh.acc, 3);
        for (i = 0; i < n; i++) { var a2 = rimPts[i], b2 = rimPts[(i + 1) % n]; w2.tube([a2[0], a2[1], -2.7], [b2[0], b2[1], -2.7], 0.18, 3, gcol); }
      }
      var start = parts.length;
      ws.list.forEach(function (b) { b.key = 'wheel' + k + ':' + b.key; finish(b, true); });
      return { center: wh.wr, yaw: wh.yaw || 0, R: R, parts: parts.slice(start) };
    });
    var tris = 0, verts = 0;
    parts.forEach(function (p) { tris += p.triangleCount; verts += p.vertexCount; });
    stats.triangles = tris; stats.vertices = verts; stats.parts = parts.length; stats.lights = B.lights.length; stats.quality = qn;
    return {
      parts: parts, dynamic: dyn, wheels: wheels, blinkers: B.blinkers, lights: B.lights, signTexts: sink.signTexts.slice(), signRows: rows,
      placed: placed, stats: stats, gantry: gInfo ? { pos: B.gantryPos } : null, quality: qn, timeOfDay: tod, night: night,
      waterColor: B.waterCol, palette: P, seedStr: seedStr
    };
  }

  /** corners from geom (tracks.build detectCorners) — fallback: derive from curvature */
  function corners(geom) {
    if (geom.corners && geom.corners.length) return geom.corners;
    var S = geom.samples, N = S.length, out = [], inC = false, cur = null;
    for (var i = 0; i < N; i++) {
      var k = Math.abs(S[i].curvature);
      if (k > 1 / 250 && !inC) { inC = true; cur = { start: i, apex: i, dir: S[i].curvature > 0 ? 1 : -1, kmax: k }; }
      else if (inC && k > cur.kmax) { cur.kmax = k; cur.apex = i; }
      if (inC && k < 1 / 400) { inC = false; cur.end = i; cur.minRadius = 1 / cur.kmax; out.push(cur); }
    }
    return out;
  }

  /* ================================================================ sign atlas (canvas)
     2 columns x rows of 512x128 cells. Each slot is drawn into a virtual box of its panel aspect and
     squeezed into the cell, so text keeps its proportions on any panel shape. */
  function hueHex(text) {
    var h = hashStr(text) % 360, s = 0.62, l = 0.42;
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r, g, b;
    if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
    var hx = function (v) { var t = Math.round((v + m) * 255).toString(16); return t.length < 2 ? '0' + t : t; };
    return '#' + hx(r) + hx(g) + hx(b);
  }
  function fitFont(g, text, maxW, size, weight) {
    var s = size;
    for (var i = 0; i < 12; i++) {
      g.font = (weight || '900') + ' ' + Math.round(s) + 'px "Helvetica Neue", Arial, sans-serif';
      if (g.measureText(text).width <= maxW) break;
      s *= 0.88;
    }
    return s;
  }
  function drawSlot(g, w, h, t, T, genCache) {
    var text = t.text || 'REDLINE', v = t.variant || 'brand';
    g.save();
    g.beginPath(); g.rect(0, 0, w, h); g.clip();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (v === 'brand' && T && typeof T.generate === 'function' && Math.abs(w / h - 4) < 1.2) {
      var src = genCache[text + '|' + t.color];
      if (src === undefined) {
        try { var gen = T.generate('billboard', { text: text, brandColor: t.color || undefined }); src = gen && (gen.source || gen); }
        catch (e) { src = null; }
        genCache[text + '|' + t.color] = src;
      }
      if (src && src.width) { try { g.drawImage(src, 0, 0, w, h); g.restore(); return; } catch (e2) { /* fall through */ } }
    }
    if (v === 'distance') {
      g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#111'; g.fillRect(0, 0, w, h * 0.08); g.fillRect(0, h * 0.92, w, h * 0.08);
      var fs = fitFont(g, text, w * 0.84, h * 0.7);
      g.fillStyle = '#111'; g.fillText(text, w / 2, h * 0.53);
      void fs;
    } else if (v === 'chevron') {
      g.fillStyle = '#c8202a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff';
      var n = Math.max(1, Math.round(w / h * 0.9)), cw = w / n, left = text.indexOf('<') >= 0;
      for (var i = 0; i < n; i++) {
        var x0 = i * cw + cw * 0.2, x1 = x0 + cw * 0.55, xm = left ? x0 : x1, xb = left ? x1 : x0, th = cw * 0.22 * (left ? 1 : -1);
        g.beginPath();
        g.moveTo(xb, h * 0.12); g.lineTo(xm, h * 0.5); g.lineTo(xb, h * 0.88);
        g.lineTo(xb + th, h * 0.88); g.lineTo(xm + th, h * 0.5); g.lineTo(xb + th, h * 0.12); g.closePath();
        g.fill();
      }
    } else {
      // 'plain' / 'brand' fallback / 'led': colour block + bold text + accent rule
      var bg = t.color || (v === 'plain' ? '#1b1c20' : hueHex(text));
      var grd = g.createLinearGradient ? g.createLinearGradient(0, 0, 0, h) : null;
      if (grd) { grd.addColorStop(0, bg); grd.addColorStop(1, '#0d0e10'); g.fillStyle = grd; } else g.fillStyle = bg;
      if (v !== 'plain') { g.fillStyle = bg; }
      g.fillRect(0, 0, w, h);
      if (v === 'plain') { g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, h * 0.86, w, h * 0.05); }
      else { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, h * 0.8, w, h * 0.2); g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(0, 0, w, h * 0.06); }
      fitFont(g, text, w * 0.88, h * (text.length > 12 ? 0.42 : 0.56));
      g.fillStyle = '#ffffff';
      g.fillText(text, w / 2, h * 0.47);
    }
    g.restore();
  }
  function signAtlas(ctx, signTexts, rows) {
    var T = CB.gl.textures;
    if (!T || typeof T.canvas !== 'function' || !signTexts.length) return null;
    var W2 = 1024, H2 = rows * 128, genCache = {};
    var key = 'forge-scenery-signs:' + hashStr(signTexts.map(function (t) { return t.text + '|' + t.variant + '|' + t.color + '|' + t.aspect; }).join(';')) + ':' + rows;
    try {
      return T.canvas(ctx, W2, H2, function (g) {
        g.fillStyle = '#202226'; g.fillRect(0, 0, W2, H2);
        signTexts.forEach(function (t, k) {
          var x0 = (k % 2) * 512, y0 = (k >> 1) * 128, vw = 128 * clamp(t.aspect || 4, 0.25, 16);
          g.save(); g.translate(x0, y0); g.scale(512 / vw, 1);
          drawSlot(g, vw, 128, t, T, genCache);
          g.restore();
        });
      }, { key: key, mips: true, aniso: 8 });
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] sign atlas', e);
      return null;
    }
  }

  /* ================================================================ materials */
  function mkMat(name, o) {
    o = o || {};
    var c = o.color || WHITE;
    c = [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
    var map = o.map || null, em = (o.emissive || [0, 0, 0]).slice(0, 3);
    var m = {
      name: 'scenery-' + name,
      uBaseColor: c, baseColor: c, color: c, opacity: c[3],
      uMap: map, map: map, uUseMap: map ? 1 : 0, useMap: !!map,
      uMetallic: o.metallic || 0, metallic: o.metallic || 0, uRoughness: o.roughness != null ? o.roughness : 0.75, roughness: o.roughness != null ? o.roughness : 0.75,
      uClearcoat: o.clearcoat || 0, clearcoat: o.clearcoat || 0, uFlake: 0,
      uEmissive: em, emissive: em,
      transparent: !!o.transparent, blend: !!o.transparent, alphaTest: o.alphaTest || 0,
      doubleSided: !!o.doubleSided, depthWrite: o.depthWrite !== false, unlit: !!o.unlit, uUnlit: o.unlit ? 1 : 0,
      polygonOffset: o.polygonOffset || null
    };
    return m;
  }
  function setColor(m, c) { m.uBaseColor = m.baseColor = m.color = c; }

  function texOr(fn) { try { var t = fn(); return t || null; } catch (e) { return null; } }

  function makeMaterials(ctx, res, opts) {
    var T = CB.gl.textures || {}, night = res.night, lightsOn = night || /dusk|sunset|evening/.test(res.timeOfDay || '');
    var M = {}, tex = {};
    tex.trees = typeof T.trees === 'function' ? texOr(function () { return T.trees(ctx); }) : null;
    tex.crowd0 = typeof T.crowd === 'function' ? texOr(function () { return T.crowd(ctx, { frame: 0 }); }) : null;
    tex.crowd1 = typeof T.crowd === 'function' ? texOr(function () { return T.crowd(ctx, { frame: 1 }); }) : null;
    tex.tyres = typeof T.tyreWall === 'function' ? texOr(function () { return T.tyreWall(ctx); }) : null;
    tex.signs = signAtlas(ctx, res.signTexts, res.signRows);
    M.paint = mkMat('paint', { roughness: 0.72 });
    M.metal = mkMat('metal', { metallic: 0.62, roughness: 0.36 });
    M.glass = mkMat('glass', { metallic: 0.25, roughness: 0.1, clearcoat: 0.5 });
    M.foliage = mkMat('foliage', { roughness: 0.9 });
    M.treeCard = mkMat('tree-card', { map: tex.trees, roughness: 0.95, alphaTest: 0.5, doubleSided: true });
    M.grass = mkMat('grass', { roughness: 0.96 });
    M.grass.cull = true;
    // wind (GL xz direction, gust amplitude m, leaf flutter m): read by the foliage sway program
    var wa = (hashStr(String(res.seedStr || 'wind')) % 628) / 100, wind = [Math.cos(wa), Math.sin(wa), res.night ? 0.14 : 0.2, 0.025];
    [M.foliage, M.treeCard, M.grass].forEach(function (m) { m.uWind = wind; });
    M.crowd = mkMat('crowd', { map: tex.crowd0, roughness: 0.95, color: tex.crowd0 ? WHITE : [0.55, 0.5, 0.48, 1] });
    M.tyres = mkMat('tyres', { map: tex.tyres, roughness: 0.9, color: tex.tyres ? WHITE : [0.12, 0.12, 0.13, 1] });
    M.signs = mkMat('signs', { map: tex.signs, roughness: 0.45, clearcoat: 0.2 });
    M.signsLit = lightsOn ? mkMat('signs-lit', { map: tex.signs, unlit: true, color: [1.05, 1.05, 1.05, 1] }) : M.signs;
    M.lamp = lightsOn ? mkMat('lamp', { unlit: true }) : mkMat('lamp-off', { color: [0.34, 0.34, 0.34, 1], roughness: 0.3, metallic: 0.2 });
    M.glow = mkMat('glow', { unlit: true });
    M.water = mkMat('water', { roughness: 0.05, clearcoat: 0.8, metallic: 0.05 });
    M.skyline = mkMat('skyline', { roughness: 1, depthWrite: false });
    M.blink = mkMat('blink', { unlit: true, color: [6, 0.3, 0.2, 1] });
    for (var k = 0; k < 4; k++) {
      (function (k) {
        // dusk uses the night-toned texture too (lit windows), drawn unlit but brighter: the walls keep
        // some of the evening light while the windows push into bloom
        var ft = typeof T.buildingFacade === 'function' ? texOr(function () { return T.buildingFacade(ctx, k, lightsOn); }) : null;
        var duskC = [1.7, 1.55, 1.45, 1];
        M['facade' + k] = night ? mkMat('facade' + k + '-night', { map: ft, unlit: true, color: ft ? WHITE : [0.06, 0.07, 0.09, 1] })
          : lightsOn ? mkMat('facade' + k + '-dusk', { map: ft, unlit: true, color: ft ? duskC : [0.16, 0.15, 0.15, 1] })
          : mkMat('facade' + k, { map: ft, roughness: k === 0 ? 0.35 : 0.8, metallic: k === 0 ? 0.25 : 0, clearcoat: k === 0 ? 0.3 : 0 });
      })(k);
    }
    return { M: M, tex: tex, lightsOn: lightsOn };
  }

  /* ================================================================ foliage wind sway program
     The core standard program with a vertex-stage wind displacement: sway weight decoded from the vertex colour
     alpha (see swc), gusting sway along uWind.xy plus a small leaf flutter. Same fragment shader, so lighting /
     shadows / fog match every other surface. Cached per context generation; null when unavailable. */
  var SWAY_VS = [
    '  float swk = clamp((1.0 - aColor.a) * 100.0, 0.0, 1.0);',
    '  vColor.a = 1.0;',
    '  if (swk > 0.0) {',
    '    float ph = dot(w.xz, vec2(0.11, 0.07));',
    '    float gust = 0.55 + 0.45 * sin(uSwayTime * 0.31 + w.x * 0.004 + w.z * 0.003);',
    '    float s1 = sin(uSwayTime * 1.35 + ph) * 0.6 + sin(uSwayTime * 2.1 + ph * 1.7) * 0.25;',
    '    vec2 fl = vec2(sin(uSwayTime * 5.3 + ph * 13.0), cos(uSwayTime * 4.7 + ph * 11.0));',
    '    w.xz += (uWind.xy * (0.35 + s1) * gust * uWind.z + fl * uWind.w) * swk;',
    '  }'
  ].join('\n');
  function swayProgram(ctx) {
    var G = CB.gl, SRC = G && G.SOURCES;
    if (!ctx || !ctx.gl || typeof G.createProgram !== 'function' || !SRC || !SRC.STANDARD_VS || !SRC.STANDARD_FS) return null;
    var c = ctx._forgeSwayProg;
    if (c && c.gen === ctx.generation) return c.prog;
    var prog = null;
    try {
      var anchor = '  vec4 w = M * vec4(aPos, 1.0);', head = 'uniform vec4 uAnisoAxis;', vs = SRC.STANDARD_VS;
      if (vs.indexOf(anchor) < 0 || vs.indexOf(head) < 0) throw new Error('standard VS layout changed');
      vs = vs.replace(head, head + '\nuniform vec4 uWind; uniform float uSwayTime;').replace(anchor, anchor + '\n' + SWAY_VS);
      prog = G.createProgram(ctx, vs, SRC.STANDARD_FS, { name: 'scenery-foliage', defines: ctx.isWebGL2 ? { SHADOW_HW: true } : {} });
    } catch (e) {
      prog = null;
      if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] foliage sway program', e && e.message);
    }
    ctx._forgeSwayProg = { gen: ctx.generation, prog: prog };
    return prog;
  }

  /* ================================================================ GL build + runtime */
  function build(ctx, geom, trackDef, opts) {
    opts = opts || {};
    var res = buildGeometry(geom, trackDef, opts);
    var qName = res.quality, Qr = QUALITY[qName];
    var canMesh = !!(ctx && CB.gl && typeof CB.gl.createMesh === 'function');
    var MT = canMesh ? makeMaterials(ctx, res, opts) : { M: {}, tex: {}, lightsOn: false };
    var swayProg = canMesh && Qr.sway ? swayProgram(ctx) : null, SWAY_MATS = { foliage: 1, treeCard: 1, grass: 1 };
    var M = MT.M, hasCards = !!MT.tex.trees;
    var items = [], meshes = [], globalItems = [], wheelItems = [], lensMats = [], skyModel = ident();
    var globalMats = {};
    function matFor(p) {
      if (!canMesh) return null;
      var base = M[p.mat] || M.paint;
      if (p.lod !== 'global') return base;
      if (!globalMats[p.mat]) {
        var g = {};
        for (var k in base) g[k] = base[k];
        g.depthWrite = false; g.name = base.name + '-sky';
        globalMats[p.mat] = g;
      }
      return globalMats[p.mat];
    }
    function meshOf(p) {
      if (!canMesh) return null;
      try {
        var m = CB.gl.createMesh(ctx, { positions: p.positions, normals: p.normals, uvs: p.uvs, colors: p.colors, colorSize: 4, indices: p.indices });
        if (m && !m.bounds) m.bounds = p.bounds;
        if (m) meshes.push(m);
        return m;
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[scenery] mesh failed', p.key, e);
        return null;
      }
    }
    var wheelPartKeys = {};
    (res.wheels || []).forEach(function (wh) { wh.parts.forEach(function (p) { wheelPartKeys[p.key] = 1; }); });
    res.parts.forEach(function (p) {
      if (wheelPartKeys[p.key]) return;
      var mesh = meshOf(p);
      if (canMesh && !mesh) return;
      var cc = chunkCenter(p.lod, p.chunk) || p.bounds.center;
      var it = {
        mesh: mesh, material: matFor(p), model: null, castShadow: !!p.castShadow, kind: 'scenery:' + p.mat, lod: p.lod,
        chunk: p.chunk, center: cc, bcenter: p.bounds.center, radius: p.bounds.radius, worldBounds: { min: p.bounds.min, max: p.bounds.max },
        triangles: p.triangleCount, transparent: false, geometry: canMesh ? null : p
      };
      if (swayProg && SWAY_MATS[p.mat]) it.program = swayProg;
      if (p.lod === 'global') {
        it.model = skyModel; it.alwaysVisible = true; it.noCull = true; it.castShadow = false; it.worldBounds = null; it.order = -10; it.background = true;
        globalItems.push(it);
      } else {
        it.model = ident();
        if (p.light != null && canMesh) {
          var lm = mkMat('countdown-' + p.light, { unlit: true, color: [0.08, 0.012, 0.01, 1] });
          it.material = lm; lensMats[p.light] = lm; it.castShadow = false;
        }
      }
      items.push(it);
    });
    // observation wheels: rotating parts in wheel-local space
    (res.wheels || []).forEach(function (wh) {
      var model = ident();
      rotWheel(model, wh, 0);
      wh.parts.forEach(function (p) {
        var mesh = meshOf(p);
        if (canMesh && !mesh) return;
        var it = { mesh: mesh, material: matFor(p), model: model, castShadow: false, kind: 'scenery:wheel', lod: 'dyn', chunk: 'wheel',
          center: wh.center, bcenter: wh.center, radius: wh.R + 6, worldBounds: { center: wh.center, radius: wh.R + 6 }, geometry: canMesh ? null : p };
        items.push(it);
      });
      wheelItems.push({ wh: wh, model: model });
    });
    // aviation / mast blinkers
    var blinkMat = M.blink || null;
    if (res.blinkers && res.blinkers.length) {
      var bs = new Sink(), bw = new Writer(bs);
      bw.at(0, 0, 0, 0, 'blink'); bw.use('blink', 'all');
      res.blinkers.forEach(function (p) { bw.box(p[0], p[1], p[2], 1.1, 1.1, 1.1, [1, 1, 1, 1]); });
      bs.list.forEach(function (b) {
        var p = finishBatch(b, 1);
        var mesh = meshOf(p);
        if (canMesh && !mesh) return;
        items.push({ mesh: mesh, material: blinkMat, model: ident(), castShadow: false, kind: 'scenery:blink', lod: 'all', chunk: 'blink',
          center: p.bounds.center, bcenter: p.bounds.center, radius: p.bounds.radius, worldBounds: { min: p.bounds.min, max: p.bounds.max }, geometry: canMesh ? null : p });
      });
    }

    var visibleList = [], lastCd = -1, crowdFrame = 0, crowdT = 0, destroyed = false;
    function getItems(camPos) {
      visibleList.length = 0;
      if (destroyed) return visibleList;
      var cx = camPos ? camPos[0] : 0, cz = camPos ? camPos[2] : 0;
      var nearD = hasCards ? Qr.near : Qr.far * 0.55;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it.mesh && canMesh) continue;
        var lod = it.lod, ok = true;
        if (lod !== 'global' && lod !== 'dyn') {
          var c = it.center, d = Math.hypot(c[0] - cx, c[2] - cz);
          var bc = it.bcenter, de = Math.max(0, Math.hypot(bc[0] - cx, bc[2] - cz) - it.radius);
          if (lod === 'near') ok = d < nearD;
          else if (lod === 'far') ok = hasCards && d >= nearD && d < Qr.far;
          else if (lod === 'bill') ok = hasCards && de < Qr.far;
          else if (lod === 'detail') ok = de < Qr.detail;
          else if (lod === 'grass') ok = de < Qr.grass;
          else ok = de < Qr.far;
        }
        if (ok) visibleList.push(it);
      }
      return visibleList;
    }
    function setCountdown(cd) {
      var on = cd && !cd.lightsOut ? clamp(Math.round(fin(cd.lightsOn, 0)), 0, 5) : 0;
      if (on === lastCd) return;
      lastCd = on;
      for (var i = 0; i < lensMats.length; i++) {
        var m = lensMats[i];
        if (!m) continue;
        setColor(m, i < on ? [7.5, 0.32, 0.14, 1] : [0.08, 0.012, 0.01, 1]);
      }
    }
    function update(time, camPos, snap, camera) {
      if (destroyed) return;
      time = fin(time, 0);
      if (snap && snap.countdown) setCountdown(snap.countdown);
      // crowd cheer (2-frame animation; faster at the start and the finish)
      var ph = snap && snap.phase, rate = ph === 'countdown' || ph === 'finished' ? 0.22 : 0.55;
      if (time - crowdT > rate || time < crowdT) {
        crowdT = time; crowdFrame ^= 1;
        var ct = crowdFrame ? MT.tex.crowd1 : MT.tex.crowd0;
        if (ct && M.crowd) { M.crowd.map = M.crowd.uMap = ct; }
      }
      if (M.foliage) M.foliage.uSwayTime = M.treeCard.uSwayTime = M.grass.uSwayTime = time % 600;
      if (blinkMat) setColor(blinkMat, (time % 1.6) < 0.14 ? [9, 0.5, 0.3, 1] : [0.12, 0.01, 0.01, 1]);
      for (var w = 0; w < wheelItems.length; w++) rotWheel(wheelItems[w].model, wheelItems[w].wh, time * 0.035);
      // skyline backdrop: centred on the camera, radius inside the far plane
      var far = camera && isFinite(camera.far) ? camera.far : Qr.far;
      var R = Math.min(1500, far * 0.86);
      var px = camPos ? camPos[0] : 0, py = camPos ? camPos[1] : 0, pz = camPos ? camPos[2] : 0;
      skyModel[0] = R; skyModel[5] = R; skyModel[10] = R; skyModel[12] = px; skyModel[13] = py; skyModel[14] = pz;
    }
    update(0, [0, 0, 0], null, null);
    function setQuality(q) { qName = normQ(q); Qr = QUALITY[qName]; return qName; }
    function destroy() {
      destroyed = true;
      meshes.forEach(function (m) { if (m && typeof m.destroy === 'function') { try { m.destroy(); } catch (e) { /* ignore */ } } });
      meshes.length = 0; items.length = 0; visibleList.length = 0;
    }
    var tris = 0;
    items.forEach(function (it) { tris += it.triangles || (it.geometry && it.geometry.triangleCount) || 0; });
    return {
      items: items, getItems: getItems, update: update, setCountdown: setCountdown, setQuality: setQuality, destroy: destroy,
      lights: res.lights, hasGantry: !!res.gantry, gantry: res.gantry, placed: res.placed,
      stats: res.stats, materials: M, textures: MT.tex, quality: function () { return qName; }
    };
  }
  function ident() { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function rotWheel(out, wh, angle) {
    // T(center) * Ry(yaw) * Rz(angle)
    var cy = Math.cos(wh.yaw || 0), sy = Math.sin(wh.yaw || 0), ca = Math.cos(angle), sa = Math.sin(angle);
    // Ry columns: X -> (cy, 0, -sy), Y -> (0,1,0), Z -> (sy, 0, cy); Rz: X -> (ca, sa, 0), Y -> (-sa, ca, 0)
    out[0] = cy * ca; out[1] = sa; out[2] = -sy * ca; out[3] = 0;
    out[4] = -cy * sa; out[5] = ca; out[6] = sy * sa; out[7] = 0;
    out[8] = sy; out[9] = 0; out[10] = cy; out[11] = 0;
    out[12] = wh.center[0]; out[13] = wh.center[1]; out[14] = wh.center[2]; out[15] = 1;
    return out;
  }
  /** batch -> plain part (used for extra batches built at GL time) */
  function finishBatch(b, rows) {
    var mn = b.min, mx = b.max;
    void rows;
    return {
      key: b.key, mat: b.mat, lod: b.lod, chunk: b.chunk,
      positions: new Float32Array(b.p), normals: new Float32Array(b.n), uvs: new Float32Array(b.uv), colors: new Float32Array(b.c),
      indices: new Uint16Array(b.idx), vertexCount: b.vc, triangleCount: b.idx.length / 3,
      bounds: { min: mn.slice(), max: mx.slice(), center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], radius: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 }
    };
  }

  return {
    build: build,
    buildGeometry: buildGeometry,
    QUALITY: QUALITY,
    _internal: { makeClearance: makeClearance, Occupancy: Occupancy, rngFor: rngFor, hashStr: hashStr, chunkFor: chunkFor, chunkCenter: chunkCenter, rotWheel: rotWheel, atlasEntries: atlasEntries, speciesOf: speciesOf, drawSlot: drawSlot }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.gl.scenery;

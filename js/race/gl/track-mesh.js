/* ==========================================================================
   FORGE Atelier — js/race/gl/track-mesh.js
   CB.gl.track : 3D track + terrain geometry built from CB.race.tracks geometry.

   API (RACE3D-SPEC.md)
     CB.gl.track.build(ctx, geom, trackDef, opts?) -> {
        meshes: [{ mesh, material, castShadow, transparent, kind, bounds, model }],
        bounds: { min:[x,y,z], max:[x,y,z] },
        groundY(x, z)            terrain height at GL (x, z)   (z = -sim y)
        heightAt(s)              road surface height at arc length s (bridge ramps; 0 elsewhere)
        heightAtIndex(i)         same, per centerline sample
        carY(carSnap)            road height under a car snapshot (uses car.s)
        stats, destroy()
     }
     CB.gl.track.buildGeometry(geom, trackDef, opts?) -> pure (no GL / DOM) version returning
        { parts: [{ kind, material(descriptor), castShadow, transparent, positions, normals, uvs,
                    colors (RGBA), indices (Uint16), bounds, vertexCount, triangleCount }],
          bounds, groundY, heightAt, heightAtIndex, elevation (Float32Array per sample),
          walls: { left: [[x,z],...], right: [...] }, stats }

   World axes: sim (x, y) -> GL (x, z = -y), +Y up. Road surface y = 0 (except the elevated
   upper deck of a figure-8 bridge crossing, see heightAt). All lateral distances are taken
   verbatim from the sim samples (hw, leftKerb/rightKerb, sandL/sandR, wallL/wallR, runoffL/R)
   so the visuals line up exactly with tracks.project() surface classification and the
   engine's wall collision (engine uses sample.wallL / wallR, lateral +left).
   Geometry code is pure and Node-testable; GL work only happens inside build().
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

CB.gl.track = (function () {
  'use strict';

  var PI = Math.PI, TAU = PI * 2;
  var MAX_VERTS = 65000;               // per part (Uint16 indices, WebGL1 safe)
  var LINE_W = 0.24;                   // painted edge line width (m), inside the asphalt edge
  var DECAL_Y = 0.012;                 // lift for painted decals laid over the road ribbon
  var KERB_H = 0.055;                  // kerb crown height
  var TERRAIN_SINK = 0.08;             // terrain sits this far below the track surfaces
  var BRIDGE_H = 7.2;                  // deck height of a figure-8 bridge crossing
  var BRIDGE_RAMP = 150;               // ramp length each side (m)
  var DECK_T = 1.25;                   // deck structural depth

  /* ------------------------------------------------------------ utils */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function fin(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  function hashStr(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rngFor(seed) {
    var a = (typeof seed === 'string' ? hashStr(seed) : seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // sRGB hex -> linear RGBA (shaders tonemap + gamma at the end)
  function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function hexLin(hex, fallback, alpha) {
    var h = typeof hex === 'string' ? hex.replace('#', '') : '';
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback ? hexLin(fallback, null, alpha) : [0.5, 0.5, 0.5, alpha == null ? 1 : alpha];
    var n = parseInt(h, 16);
    return [s2l(((n >> 16) & 255) / 255), s2l(((n >> 8) & 255) / 255), s2l((n & 255) / 255), alpha == null ? 1 : alpha];
  }
  function mulC(c, k, a) { return [c[0] * k, c[1] * k, c[2] * k, a == null ? c[3] : a]; }
  function mixC(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)]; }
  var WHITE = [1, 1, 1, 1];

  /* ------------------------------------------------- value noise / fbm */
  function makeNoise(seed) {
    var perm = new Uint8Array(512), r = rngFor(seed), i;
    var p = [];
    for (i = 0; i < 256; i++) p.push(i);
    for (i = 255; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = p[i]; p[i] = p[j]; p[j] = t; }
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];
    var vals = new Float32Array(256);
    for (i = 0; i < 256; i++) vals[i] = r() * 2 - 1;
    function lat(ix, iy) { return vals[perm[(perm[ix & 255] + iy) & 511]]; }
    function noise(x, y) {
      var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      var a = lat(ix, iy), b = lat(ix + 1, iy), c = lat(ix, iy + 1), d = lat(ix + 1, iy + 1);
      return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
    }
    function fbm(x, y, oct) {
      var sum = 0, amp = 0.5, f = 1, norm = 0;
      for (var o = 0; o < (oct || 4); o++) { sum += amp * noise(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.03; }
      return sum / norm;
    }
    return { noise: noise, fbm: fbm };
  }

  /* --------------------------------------------------------- part sets
     Parts are keyed by (kind, spatial chunk). Each part is an independent indexed mesh
     with < 65k vertices. Triangles are auto-wound so their geometric normal agrees with
     the supplied vertex normal (counter-clockwise front faces in GL), degenerate ones dropped. */

  function Part(kind, chunk, mat) {
    this.kind = kind; this.chunk = chunk; this.material = mat;
    this.p = []; this.n = []; this.t = []; this.c = []; this.i = [];
    this.vc = 0;
  }
  Part.prototype.v = function (x, y, z, nx, ny, nz, u, w, col) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, w);
    col = col || WHITE;
    this.c.push(col[0], col[1], col[2], col[3] == null ? 1 : col[3]);
    return this.vc++;
  };
  Part.prototype.tri = function (a, b, c) {
    var P = this.p;
    var ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    var e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    var e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    var cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    var area2 = cx * cx + cy * cy + cz * cz;
    if (!(area2 > 1e-10)) return;
    var N = this.n;
    var nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (cx * nx + cy * ny + cz * nz >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  };
  Part.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };

  function PartSet() { this.map = {}; this.list = []; }
  PartSet.prototype.get = function (kind, chunk, mat, need) {
    var key = kind + '#' + chunk;
    var p = this.map[key];
    if (!p || p.vc + (need || 0) > MAX_VERTS) {
      p = new Part(kind, chunk, mat);
      this.map[key] = p;
      this.list.push(p);
    }
    return p;
  };

  // axis-aligned box (in GL space) given center, half extents and a yaw (about +Y)
  function boxGL(part, cx, cy, cz, hx, hy, hz, yaw, col, uvScale, skipBottom) {
    var c = Math.cos(yaw), s = Math.sin(yaw);
    uvScale = uvScale || 1;
    // local axes: ax = (c, 0, -s) (yaw rotates +X toward -Z, i.e. sim CCW), az = (s, 0, c)
    var ax = [c, 0, -s], ay = [0, 1, 0], az = [s, 0, c];
    var faces = [
      [ax, ay, az, hx, hy, hz], [[-ax[0], 0, -ax[2]], ay, [-az[0], 0, -az[2]], hx, hy, hz],
      [az, ay, [-ax[0], 0, -ax[2]], hz, hy, hx], [[-az[0], 0, -az[2]], ay, ax, hz, hy, hx],
      [ay, az, ax, hy, hz, hx], [[0, -1, 0], az, [-ax[0], 0, -ax[2]], hy, hz, hx]
    ];
    for (var f = 0; f < faces.length; f++) {
      if (skipBottom && f === 5) continue;
      var F = faces[f], n = F[0], u = F[1], w = F[2], dn = F[3], du = F[4], dw = F[5];
      var ox = cx + n[0] * dn, oy = cy + n[1] * dn, oz = cz + n[2] * dn;
      var idx = [];
      for (var k = 0; k < 4; k++) {
        var su = k === 0 || k === 3 ? -1 : 1, sw = k < 2 ? -1 : 1;
        idx.push(part.v(ox + u[0] * du * su + w[0] * dw * sw, oy + u[1] * du * su + w[1] * dw * sw, oz + u[2] * du * su + w[2] * dw * sw,
          n[0], n[1], n[2], (su * dw + dw) * uvScale, (sw * du + du) * uvScale, col));
      }
      part.quad(idx[0], idx[1], idx[2], idx[3]);
    }
  }

  // thin beam between two GL points (square cross-section of half size r)
  function beamGL(part, a, b, r, col) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-4) return;
    var d = [dx / L, dy / L, dz / L];
    var up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    var u = norm3(cross3(d, up)), w = cross3(u, d);
    var corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (var k = 0; k < 4; k++) {
      var c0 = corners[k], c1 = corners[(k + 1) % 4];
      var nx = (c0[0] + c1[0]) / 2, ny = (c0[1] + c1[1]) / 2;
      var nrm = norm3([u[0] * nx + w[0] * ny, u[1] * nx + w[1] * ny, u[2] * nx + w[2] * ny]);
      var q = [];
      [[a, c0, 0], [a, c1, 0], [b, c1, L], [b, c0, L]].forEach(function (e) {
        var o = e[0], cc = e[1];
        q.push(part.v(o[0] + (u[0] * cc[0] + w[0] * cc[1]) * r, o[1] + (u[1] * cc[0] + w[1] * cc[1]) * r, o[2] + (u[2] * cc[0] + w[2] * cc[1]) * r,
          nrm[0], nrm[1], nrm[2], k * 0.25, e[2] * 0.25, col));
      });
      part.quad(q[0], q[1], q[2], q[3]);
    }
  }
  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm3(a) { var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /* ---------------------------------------------- 5x7 pixel font (paint) */
  var FONT = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001']
  };

  /* ================================================================ BUILD (pure) */

  function buildGeometry(geom, trackDef, opts) {
    if (!geom || !geom.samples || geom.samples.length < 8) throw new Error('CB.gl.track: invalid geometry');
    trackDef = trackDef || geom.def || {};
    opts = opts || {};
    var quality = opts.quality || 'high';
    var Q = { low: 0, medium: 1, high: 2, ultra: 3 }[quality];
    if (Q == null) Q = 2;
    var S = geom.samples, N = S.length;
    var L = fin(geom.length, 0) || (S[N - 1].s + Math.hypot(S[0].x - S[N - 1].x, S[0].y - S[N - 1].y));
    var ds = fin(geom.ds, L / N);
    var theme = Object.assign({}, trackDef.theme || {}, geom.theme || {});
    var style = trackDef.style || {};
    var wallType = trackDef.wallType || (style.street ? 'concrete' : 'armco');
    var night = !!(theme.night || style.night || trackDef.timeOfDay === 'night');
    var chunkLen = opts.chunkLength || 420;
    var seed = (trackDef.id || geom.id || 'track') + ':gl';
    var noise = makeNoise(seed);
    var rnd = rngFor(seed + ':rnd');
    var parts = new PartSet();

    /* ---- per-sample frame, normalised defensively ---- */
    var X = new Float64Array(N), Y = new Float64Array(N), TX = new Float64Array(N), TY = new Float64Array(N),
        NX = new Float64Array(N), NY = new Float64Array(N), HW = new Float64Array(N),
        KL = new Float64Array(N), KR = new Float64Array(N), SL = new Float64Array(N), SR = new Float64Array(N),
        WL = new Float64Array(N), WR = new Float64Array(N), RL = new Float64Array(N), K = new Float64Array(N),
        SS = new Float64Array(N);
    var i, j, k;
    for (i = 0; i < N; i++) {
      var sm = S[i];
      X[i] = fin(sm.x, 0); Y[i] = fin(sm.y, 0);
      var h = fin(sm.heading, 0);
      TX[i] = fin(sm.tx, Math.cos(h)); TY[i] = fin(sm.ty, Math.sin(h));
      NX[i] = fin(sm.nx, -TY[i]); NY[i] = fin(sm.ny, TX[i]);
      HW[i] = fin(sm.hw, fin(sm.width, fin(geom.width_m, 12)) / 2);
      KL[i] = Math.max(0, fin(sm.leftKerb, 0)); KR[i] = Math.max(0, fin(sm.rightKerb, 0));
      SL[i] = Math.max(0, fin(sm.sandL, 0)); SR[i] = Math.max(0, fin(sm.sandR, 0));
      WL[i] = Math.max(HW[i] + 0.3, fin(sm.wallL, HW[i] + 12)); WR[i] = Math.max(HW[i] + 0.3, fin(sm.wallR, HW[i] + 12));
      RL[i] = clamp(fin(sm.racingLine, 0), -HW[i], HW[i]);
      K[i] = fin(sm.curvature, 0);
      SS[i] = fin(sm.s, i * ds);
    }
    function runoffOf(i, side) {
      var r = side > 0 ? S[i].runoffL : S[i].runoffR;
      if (!r) r = side > 0 ? (trackDef.runoff && trackDef.runoff.left) : (trackDef.runoff && trackDef.runoff.right);
      return r === 'tarmac' ? 'tarmac' : r === 'sand' ? 'sand' : 'grass';
    }

    /* ---- elevation (figure-8 bridge) ---- */
    var E = new Float64Array(N), deck = new Uint8Array(N), bridges = [];
    var crossings = geom.crossings || [];
    crossings.forEach(function (cr) {
      if (cr.type !== 'bridge' || cr.upperIndex == null || opts.flatBridges) return;
      var u = cr.upperIndex, b0 = cr.bridgeStart != null ? cr.bridgeStart : mod(u - 14, N), b1 = cr.bridgeEnd != null ? cr.bridgeEnd : mod(u + 14, N);
      var half0 = mod(u - b0, N), half1 = mod(b1 - u, N);
      var ramp = Math.round(BRIDGE_RAMP / ds);
      for (var o = -(half0 + ramp); o <= half1 + ramp; o++) {
        var idx = mod(u + o, N), w;
        if (o >= -half0 && o <= half1) { w = 1; deck[idx] = 1; }
        else {
          var d = o < 0 ? (-half0 - o) : (o - half1);
          w = 0.5 + 0.5 * Math.cos(PI * d / ramp);
        }
        E[idx] = Math.max(E[idx], BRIDGE_H * w);
      }
      bridges.push({ upper: u, lower: cr.lowerIndex, start: b0, end: b1, x: cr.x, y: cr.y });
    });
    var G = new Float64Array(N);       // grade dE/ds
    for (i = 0; i < N; i++) G[i] = (E[(i + 1) % N] - E[mod(i - 1, N)]) / (2 * ds);
    var elevated = false;
    for (i = 0; i < N; i++) if (E[i] > 0) { elevated = true; break; }

    function upAt(i) { var g = G[i]; var l = Math.sqrt(1 + g * g); return [-TX[i] * g / l, 1 / l, TY[i] * g / l]; }
    function chunkOf(i) { return Math.floor(mod(i, N) * ds / chunkLen); }
    function ringS(key) { return key * ds; }       // unwrapped s for UV continuity

    /* ---- materials (descriptors; resolved to GL uniforms in build()) ---- */
    var C = {
      asphalt: hexLin(theme.asphalt, '#3a3c40'),
      grass: hexLin(theme.grass, '#4f7a34'),
      ground: hexLin(theme.ground || theme.grass, '#4f7a34'),
      sand: hexLin(theme.sand, '#cfb680'),
      line: hexLin(theme.line, '#f2f2ee'),
      kerbA: hexLin(theme.kerbA, '#d42a2a'),
      kerbB: hexLin(theme.kerbB, '#f4f4f4'),
      wall: capAlb(hexLin(theme.wall, '#d8d8d8'), 0.7),   // white walls clip under a day sun (no post on 'low')
      barrier: hexLin(theme.barrier, '#9aa1a8'),
      accent: hexLin(theme.accent, '#ffb21e'),
      bridge: hexLin(theme.bridge || theme.barrier, '#7d848c'),
      rock: hexLin(theme.rock, '#7c7468')
    };
    function capAlb(c, m) {
      var mx = Math.max(c[0], c[1], c[2]);
      return mx > m ? [c[0] * m / mx, c[1] * m / mx, c[2] * m / mx].concat(c.length > 3 ? [c[3]] : []) : c;
    }
    function mat(name, o) {
      return Object.assign({ name: name, map: null, mapOpts: null, color: WHITE, tint: null, roughness: 0.8, metallic: 0,
        clearcoat: 0, emissive: [0, 0, 0], transparent: false, decal: false, uvScale: 1 }, o);
    }
    var M = {
      road: mat('road', { map: 'asphalt', mapOpts: { wet: opts.weather === 'wet' }, tint: C.asphalt, roughness: opts.weather === 'wet' ? 0.5 : 0.86 }),
      runoffTarmac: mat('runoff-tarmac', { map: 'asphalt', tint: mulC(C.asphalt, 1.12), roughness: 0.9 }),
      line: mat('line', { color: C.line, roughness: 0.55 }),
      decal: mat('decal', { color: WHITE, roughness: 0.55, decal: true }),
      kerb: mat('kerb', { color: WHITE, roughness: 0.45, clearcoat: 0.2 }),
      gravel: mat('gravel', { map: trackDef.gravel === false ? 'sand' : 'gravel', tint: C.sand, roughness: 0.97, wetness: 0.2 }),
      sand: mat('sand', { map: 'sand', tint: C.sand, roughness: 0.97, wetness: 0.2 }),
      // stylised low-poly world (LOWPOLY-SPEC.md): grass / terrain are flat colour (no photo texture); the variation
      // comes from the vertex colour field (grassCol) and, for the terrain, faceted per-face shading
      grass: mat('grass', { map: null, tint: mulC(C.grass, 0.86), roughness: 0.95, wetness: 0.15 }),
      terrain: mat('terrain', { map: style.street ? 'concrete' : null, tint: style.street ? C.ground : mulC(C.grass, 0.86), roughness: 0.95,
        wetness: style.street ? 0.7 : 0.15 }),
      concrete: mat('concrete', { map: 'concrete', tint: C.wall, roughness: 0.85 }),
      steel: mat('steel', { color: [0.62, 0.64, 0.66, 1], metallic: 0.85, roughness: 0.32 }),
      paintSteel: mat('painted-steel', { color: C.bridge, metallic: 0.4, roughness: 0.45 }),
      safer: mat('safer', { color: mulC(C.wall, 1.0), metallic: 0.3, roughness: 0.4, clearcoat: 0.3 }),
      tyres: mat('tyres', { map: 'tyreWall', color: WHITE, roughness: 0.9 }),
      fencePost: mat('fence-post', { color: [0.28, 0.29, 0.3, 1], metallic: 0.7, roughness: 0.45 }),
      fence: mat('fence', { map: 'fence', color: [0.42, 0.44, 0.46, 0.45], metallic: 0.6, roughness: 0.5, transparent: true }),
      led: mat('led', { color: C.accent, emissive: mulC(C.accent, 3.2).slice(0, 3), roughness: 0.3 }),
      reflector: mat('reflector', { color: WHITE, emissive: [0.6, 0.45, 0.15], roughness: 0.3 }),
      embank: mat('embankment', { map: null, tint: mulC(C.grass, 0.86), roughness: 0.95, wetness: 0.15 }),
      sidewalk: mat('sidewalk', { map: 'concrete', tint: mulC(mixC(C.wall, C.barrier, 0.6), 0.85), roughness: 0.88 })
    };

    /* ---- natural grass colour field (vertex-colour multiplier over the tinted grass texture) ----
       Hue-preserving ratios relative to the theme grass colour, so desert / autumn / snow themes keep their
       character: large dry (lighter, warmer) and lush (darker, cooler) patches at ~170 m, medium luminance
       breakup at ~45 m, and worn soil where grass meets kerbs / gravel / walls (edge 0..1). Shared by the
       terrain grid and the run-off grass ribbons so the two blend seamlessly. */
    var soilK = (function () {
      var soil = mixC(C.rock, C.sand, 0.4);
      return [0, 1, 2].map(function (c) { return clamp(soil[c] * 0.8 / Math.max(0.02, C.grass[c]), 0.45, 2.6); });
    })();
    var DRY = [1.2, 1.12, 0.8], LUSH = [0.78, 0.9, 0.8];
    function grassCol(wx, wy, edge, lum) {
      var big = noise.fbm(wx / 170 + 11.3, wy / 170 - 4.1, 3);
      var dry = smooth((big - 0.08) / 0.32) * 0.75, lush = smooth((-big - 0.06) / 0.3) * 0.7;
      var med = 0.9 + 0.17 * (0.5 + 0.5 * noise.fbm(wx / 45 + 3, wy / 45, 3));
      var fine = 1 + 0.06 * noise.noise(wx / 9.7 + 31, wy / 9.7);
      var k = med * fine * (lum == null ? 1 : lum), e = clamp(edge || 0, 0, 1), out = [0, 0, 0, 1];
      for (var c = 0; c < 3; c++) {
        var v = lerp(1, DRY[c], dry) * lerp(1, LUSH[c], lush);
        out[c] = lerp(v, soilK[c] * 0.82, e * 0.62) * k;
      }
      return out;
    }

    /* ---- ribbon helper (rings over unwrapped sample keys) ---- */
    // key in [0, 2N): ring at sample key % N; s = key*ds keeps UVs continuous over the wrap.
    // latsFn(r) -> array of laterals (+left, sim meters); colFn(r, j, key) -> RGBA; uvFn(lat, s) -> [u, v]
    function ribbon(kind, material, k0, k1, latsFn, colFn, uvFn, yFn) {
      var prev = null, prevPart = null, m = 0;
      for (var key = k0; key <= k1; key++) {
        var r = mod(key, N);
        var segChunk = chunkOf(key < k1 ? key : key - 1);
        var part = parts.get(kind, segChunk, material, 0);
        var lats = latsFn(r);
        m = lats.length;
        if (part !== prevPart || part.vc + m * 2 > MAX_VERTS) {
          // start (or restart) the strip in this part: re-emit the previous ring
          part = parts.get(kind, segChunk, material, m * 4);
          if (prev && key > k0) prev = emitRing(part, prev.key);
          prevPart = part;
        }
        var cur = emitRing(part, key);
        if (prev) {
          for (j = 0; j < m - 1; j++) part.quad(prev.idx[j], cur.idx[j], cur.idx[j + 1], prev.idx[j + 1]);
        }
        prev = cur;
      }
      function emitRing(part, key) {
        var r = mod(key, N), lats = latsFn(r), up = upAt(r), s = ringS(key);
        var idx = new Array(lats.length);
        for (var jj = 0; jj < lats.length; jj++) {
          var lat = lats[jj];
          var px = X[r] + NX[r] * lat, py = Y[r] + NY[r] * lat;
          var y = (yFn ? yFn(r, jj, lat) : 0) + E[r];
          var uv = uvFn(lat, s, jj);
          idx[jj] = part.v(px, y, -py, up[0], up[1], up[2], uv[0], uv[1], colFn ? colFn(r, jj, key, px, py) : WHITE);
        }
        return { key: key, idx: idx };
      }
    }

    // contiguous runs of samples where pred(i) is true -> [[k0, k1]] in unwrapped keys (k1 may be >= N)
    function runs(pred) {
      var act = new Uint8Array(N), any = false, all = true;
      for (var q = 0; q < N; q++) { act[q] = pred(q) ? 1 : 0; if (act[q]) any = true; else all = false; }
      if (!any) return [];
      if (all) return [[0, N]];
      var start = 0;
      while (act[start]) start++;           // first inactive sample
      var out = [], cur = -1;
      for (var o = 1; o <= N; o++) {
        var q2 = start + o, a = act[q2 % N];
        if (a && cur < 0) cur = q2 - 1;     // include the inactive neighbour as the taper start ring
        if (!a && cur >= 0) { out.push([cur, q2]); cur = -1; }
      }
      if (cur >= 0) out.push([cur, start + N]);
      return out.map(function (rr) { var off = Math.floor(rr[0] / N) * N; return [rr[0] - off, rr[1] - off]; });
    }

    /* ================= 1. ROAD RIBBON (between the painted edge lines) ================= */
    // rubber intensity: racing line + braking zones before corners
    var rubber = new Float64Array(N);
    var look = Math.round(80 / ds);
    for (i = 0; i < N; i++) {
      var mk = 0;
      for (k = 0; k <= look; k += 2) mk = Math.max(mk, Math.abs(K[(i + k) % N]) * (1 - k / (look * 1.4)));
      rubber[i] = clamp(0.35 + mk * 22, 0.35, 1);
    }
    var patch = new Float64Array(N);   // low frequency resurfacing patches along s
    for (i = 0; i < N; i++) patch[i] = 1 + 0.06 * noise.fbm(i * ds / 90, 3.7, 3);
    var ROAD_U = 1 / 6;                // asphalt texture: 1 tile = 6 m
    function roadLats(r) {
      var inner = HW[r] - LINE_W, rl = clamp(RL[r], -inner + 0.3, inner - 0.3);
      var cols = [-inner, -inner + 0.7, rl - 2.3, rl - 1.0, rl, rl + 1.0, rl + 2.3, inner - 0.7, inner];
      // keep every column strictly inside [-inner, inner] and monotone (the rubber band can be
      // pushed against an edge on a wide racing line; it must never fold past the painted line)
      var last = cols.length - 1, eps = Math.min(0.001, inner / 64);
      for (var q = 1; q < last; q++) cols[q] = clamp(cols[q], -inner + q * eps, inner - (last - q) * eps);
      for (q = 1; q < last; q++) cols[q] = Math.max(cols[q], cols[q - 1] + eps);
      cols[0] = -inner; cols[last] = inner;
      return cols;
    }
    var RUB = [0, 0, 0.32, 0.85, 1, 0.85, 0.32, 0, 0];
    ribbon('road', M.road, 0, N, roadLats, function (r, jj) {
      var edge = jj === 0 || jj === 8 ? 1.06 : 1.0;    // dusty edges
      var v = (0.94 - RUB[jj] * 0.3 * rubber[r]) * patch[r] * edge;
      return [v, v, v * 1.01, 1];
    }, function (lat, s) { return [lat * ROAD_U, s * ROAD_U]; });

    /* ================= 2. EDGE LINES (exactly fill hw-LINE_W .. hw) ================= */
    [1, -1].forEach(function (side) {
      ribbon('line', M.line, 0, N, function (r) {
        return side > 0 ? [HW[r] - LINE_W, HW[r]] : [-HW[r], -HW[r] + LINE_W];
      }, null, function (lat, s) { return [lat, s / 4]; });
    });

    /* ================= 3. KERBS (raised, alternating colours) ================= */
    var KERB_F = [0, 0.14, 0.86, 1];
    var KERB_Y = [0.006, 0.7, 1, 0.92];
    var STRIPES = 2;                       // colour stripes per sample segment (~1 m each)
    [1, -1].forEach(function (side) {
      var KW = side > 0 ? KL : KR;
      runs(function (q) { return KW[q] > 0.05; }).forEach(function (run) {
        for (var key = run[0]; key < run[1]; key++) {
          var a = mod(key, N), b = mod(key + 1, N);
          var wa = KW[a], wb = KW[b];
          if (wa < 0.02 && wb < 0.02) continue;
          var part = parts.get('kerb', chunkOf(key), M.kerb, 64);
          var upA = upAt(a), upB = upAt(b);
          for (var st = 0; st < STRIPES; st++) {
            var t0 = st / STRIPES, t1 = (st + 1) / STRIPES;
            var col = ((key * STRIPES + st) & 1) ? C.kerbB : C.kerbA;
            var ts = [t0, (t0 + t1) / 2, t1];
            var ring = [];
            for (var ti = 0; ti < 3; ti++) {
              var t = ts[ti], bump = ti === 1 ? 1 : 0.78;
              var row = [];
              for (var f = 0; f < 4; f++) {
                var latA = side * (HW[a] + KERB_F[f] * wa), latB = side * (HW[b] + KERB_F[f] * wb);
                var pa = [X[a] + NX[a] * latA, Y[a] + NY[a] * latA], pb = [X[b] + NX[b] * latB, Y[b] + NY[b] * latB];
                var wv = lerp(wa, wb, t);
                var hh = KERB_H * Math.min(1, wv / 0.6) * KERB_Y[f] * (f === 0 ? 1 : bump);
                var y = lerp(E[a], E[b], t) + (f === 0 ? 0.006 : hh);
                // normals: slope up from the inner edge, then crown
                var tilt = f <= 1 ? 0.25 : f === 3 ? -0.12 : 0;
                var nx = lerp(upA[0], upB[0], t) - side * tilt * lerp(NX[a], NX[b], t);
                var nz = lerp(upA[2], upB[2], t) + side * tilt * lerp(NY[a], NY[b], t);
                var nn = norm3([nx, 1, nz]);
                row.push(part.v(lerp(pa[0], pb[0], t), y, -lerp(pa[1], pb[1], t), nn[0], nn[1], nn[2],
                  KERB_F[f], (key + t) * ds / 2, col));
              }
              // outer side face (drop to the run-off)
              var latAo = side * (HW[a] + wa), latBo = side * (HW[b] + wb);
              var ox = lerp(X[a] + NX[a] * latAo, X[b] + NX[b] * latBo, t), oy = lerp(Y[a] + NY[a] * latAo, Y[b] + NY[b] * latBo, t);
              var onx = side * lerp(NX[a], NX[b], t), ony = side * lerp(NY[a], NY[b], t);
              var topY = part.p[row[3] * 3 + 1];
              var sideCol = mulC(col, 0.8);
              row.push(part.v(ox, topY, -oy, onx, 0, -ony, 1, (key + t) * ds / 2, sideCol));
              row.push(part.v(ox, lerp(E[a], E[b], t), -oy, onx, 0, -ony, 1.05, (key + t) * ds / 2, sideCol));
              ring.push(row);
            }
            for (ti = 0; ti < 2; ti++) {
              var r0 = ring[ti], r1 = ring[ti + 1];
              for (f = 0; f < 3; f++) part.quad(r0[f], r1[f], r1[f + 1], r0[f + 1]);
              part.quad(r0[4], r1[4], r1[5], r0[5]);
            }
          }
        }
      });
    });

    /* ================= 4. WALL LINES (exact sim lateral, untangled) ================= */
    function wallLine(side) {
      var W = side > 0 ? WL : WR;
      var px = new Float64Array(N), py = new Float64Array(N), lat = new Float64Array(N);
      for (var q = 0; q < N; q++) {
        lat[q] = side * W[q];
        px[q] = X[q] + NX[q] * lat[q]; py[q] = Y[q] + NY[q] * lat[q];
      }
      // offset curves on the inside of tight bends can fold back; collapse reversed points
      var folds = 0;
      for (var pass = 0; pass < 2; pass++) {
        var last = mod(-1, N);
        for (q = 0; q < N; q++) {
          var dx = px[q] - px[last], dy = py[q] - py[last];
          if (dx * TX[q] + dy * TY[q] < 0) { px[q] = px[last]; py[q] = py[last]; if (pass === 0) folds++; }
          else last = q;
        }
      }
      return { x: px, y: py, lat: lat, folds: folds };
    }
    var wallLines = { 1: wallLine(1), '-1': wallLine(-1) };

    /* ================= 5. RUN-OFF SURFACES (gravel, tarmac, grass) ================= */
    var GRASS_U = 1 / 8;
    [1, -1].forEach(function (side) {
      var KW = side > 0 ? KL : KR, SW = side > 0 ? SL : SR, WLn = wallLines[side];
      // gravel / sand trap
      runs(function (q) { return SW[q] > 0.02; }).forEach(function (run) {
        ribbon('gravel', M.gravel, run[0], run[1], function (r) {
          var a0 = HW[r] + KW[r];
          return [side * a0, side * (a0 + SW[r] * 0.5), side * (a0 + SW[r])];
        }, function (r, jj) {
          var v = 1 + 0.05 * noise.noise(r * 0.37, jj * 3.1);
          return [v, v, v, 1];
        }, function (lat, s) { return [lat / 5, s / 5]; }, function (r, jj) {
          return jj === 1 ? -0.015 : 0;     // gravel beds sit a touch low in the middle
        });
      });
      // the rest up to the wall, grouped by run-off kind
      ['tarmac', 'sand', 'grass'].forEach(function (kindName) {
        var material = kindName === 'tarmac' ? M.runoffTarmac : kindName === 'sand' ? M.sand : M.grass;
        runs(function (q) { return runoffOf(q, side) === kindName; }).forEach(function (run) {
          ribbon('runoff-' + kindName, material, run[0], run[1], function (r) {
            var a0 = HW[r] + KW[r] + SW[r];
            var a1 = Math.abs(WLn.lat[r]);
            if (a1 < a0) a1 = a0;
            var mid = (a0 + a1) / 2;
            if (kindName === 'grass') {
              // extra columns: worn soil strip at the kerb / gravel edge fading into the grass over ~3 m
              var w0 = Math.min(a0 + 0.7, mid), w1 = Math.min(a0 + 3.2, mid);
              return [side * a0, side * w0, side * Math.max(w0, w1), side * Math.max(w1, mid), side * a1];
            }
            return [side * a0, side * Math.min(a0 + 1.2, mid), side * mid, side * a1];
          }, function (r, jj, key, px, py) {
            if (kindName === 'grass') {
              // mowing stripes along s (circuits; soft, not on touge verges) + worn soil next to the kerb / gravel
              var band = style.touge ? 1 : (Math.sin(key * ds * PI / 9) > 0 ? 1.04 : 0.9);
              var edge = jj === 0 ? (SW[r] > 0.02 ? 0.85 : 0.7) : jj === 1 ? 0.32 : jj === 2 ? 0.08 : 0;
              return grassCol(px, py, edge, (jj === 4 ? 1 : band) * (1 + 0.05 * noise.noise(key * ds / 13, jj)));
            }
            var t = jj === 0 ? 0.96 : 1;
            return [t, t, t, 1];
          }, function (lat, s) {
            var sc = kindName === 'tarmac' ? ROAD_U : GRASS_U;
            return [lat * sc, s * sc];
          });
        });
      });
    });

    // replace the radial wall positions of the outermost run-off ring by the untangled line:
    // (done implicitly: the run-off outer column uses |wall lat|; folds only collapse points on the
    //  fold, which are inside the run-off anyway)

    /* ================= 6. START / FINISH, GRID, SECTOR & PIT MARKINGS (decals) ================= */
    var decal = function (chunk, need) { return parts.get('decal', chunk, M.decal, need || 64); };
    var WHITE_PAINT = mulC(C.line, 1, 1);
    // rectangle painted on the road: centred at (s, lat), length along s, width across, optional rotation
    function paintRect(s, lat, len, wid, col, rotA) {
      var f = frameAt(s);
      var cs = Math.cos(rotA || 0), sn = Math.sin(rotA || 0);
      var ax = f.tx * cs + f.nx * sn, ay = f.ty * cs + f.ny * sn;    // rotated forward
      var bx = -ay, by = ax;                                         // rotated left
      var cx = f.x + f.nx * lat, cy = f.y + f.ny * lat;
      var y = f.e + DECAL_Y;
      var part = decal(chunkOf(Math.floor(mod(s, L) / ds)), 4);
      var idx = [];
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (q) {
        var px = cx + ax * q[0] * len / 2 + bx * q[1] * wid / 2, py = cy + ay * q[0] * len / 2 + by * q[1] * wid / 2;
        idx.push(part.v(px, y, -py, f.up[0], f.up[1], f.up[2], (q[0] + 1) / 2, (q[1] + 1) / 2, col));
      });
      part.quad(idx[0], idx[1], idx[2], idx[3]);
    }
    function frameAt(s) {
      var ss = mod(s, L), fi = ss / ds, i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N, t = fi - Math.floor(fi);
      var tx = lerp(TX[i0], TX[i1], t), ty = lerp(TY[i0], TY[i1], t), l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      var up0 = upAt(i0);
      return { x: lerp(X[i0], X[i1], t), y: lerp(Y[i0], Y[i1], t), tx: tx, ty: ty, nx: -ty, ny: tx,
        hw: lerp(HW[i0], HW[i1], t), e: lerp(E[i0], E[i1], t), up: up0, i: t < 0.5 ? i0 : i1 };
    }
    function paintText(str, s, lat, pix, col, rot) {
      // characters laid out across the track (reading direction = -left, i.e. facing the driver)
      var cw = pix * 6, total = str.length * cw - pix;
      for (var ci = 0; ci < str.length; ci++) {
        var g = FONT[str[ci]];
        if (!g) continue;
        for (var ry = 0; ry < 7; ry++) {
          for (var rx = 0; rx < 5; rx++) {
            if (g[ry][rx] !== '1') continue;
            // glyph x runs to the driver's right (-lat), glyph rows run towards the driver (-s)
            var gl = lat + total / 2 - (ci * cw + rx * pix + pix / 2);
            var gs = s - (ry * pix + pix / 2) + 3.5 * pix;
            if (rot) { paintRect(gs, gl, pix * 1.02, pix * 1.02, col, 0); }
            else paintRect(gs, gl, pix * 1.02, pix * 1.02, col, 0);
          }
        }
      }
    }
    // start/finish chequered band + solid line
    (function () {
      var f0 = frameAt(0), hw0 = f0.hw - LINE_W;
      var sq = 0.5, cols = Math.max(2, Math.round(hw0 * 2 / sq)), w = hw0 * 2 / cols;
      for (var row = 0; row < 3; row++) {
        for (var cc = 0; cc < cols; cc++) {
          var black = ((row + cc) & 1) === 1;
          paintRect(0.25 + row * sq, -hw0 + (cc + 0.5) * w, sq, w, black ? [0.02, 0.02, 0.02, 1] : WHITE_PAINT);
        }
      }
      paintRect(-0.15, 0, 0.3, hw0 * 2, WHITE_PAINT);
      // FORGE lettering just past the line
      if (hw0 > 3.5) paintText('REDLINE', 14, 0, Math.min(0.6, hw0 * 2 / 34), mulC(C.line, 0.9), 0);
    })();
    // grid boxes + numbers
    var slots = geom.gridSlots || geom.grid || [];
    var gridCount = Math.min(slots.length, opts.gridBoxes || 24);
    for (var gi = 0; gi < gridCount; gi++) {
      var sl = slots[gi];
      if (!sl || !isFinite(sl.s)) continue;
      var sF = (sl.sRel != null ? sl.sRel : sl.s) + 2.6;
      var latG = fin(sl.lateral, 0), bw = 2.4, lw = 0.12;
      paintRect(sF, latG, lw, bw, WHITE_PAINT);
      paintRect(sF - 0.6, latG + bw / 2 - lw / 2, 1.2, lw, WHITE_PAINT);
      paintRect(sF - 0.6, latG - bw / 2 + lw / 2, 1.2, lw, WHITE_PAINT);
      var num = String(gi + 1);
      var side0 = latG >= 0 ? 1 : -1;
      paintText(num, sF - 1.9, latG + side0 * 0.0, 0.11, mulC(C.line, 0.85), 0);
    }
    // sector timing lines (dashed)
    (geom.sectorStarts || []).forEach(function (s0, si) {
      if (si === 0 || !isFinite(s0)) return;
      var f = frameAt(s0), hw1 = f.hw - LINE_W, n = Math.max(3, Math.floor(hw1 * 2 / 1.0));
      for (var q = 0; q < n; q += 1) {
        if (q & 1) continue;
        var w = hw1 * 2 / n;
        paintRect(s0, -hw1 + (q + 0.5) * w, 0.2, w, mulC(C.accent, 1, 1));
      }
    });
    // pit straight: blend lines on the pit side of the start straight with hatched entry/exit
    (function () {
      var pits = (geom.scenery || []).filter(function (o) { return o.type === 'pits'; })[0];
      var side = pits ? (pits.side || (pits.lat >= 0 ? 1 : -1)) : -1;
      var s0 = pits ? pits.s - pits.l / 2 - 40 : -160, s1 = pits ? pits.s + pits.l / 2 + 40 : 120;
      if (s1 - s0 > L * 0.4) { s0 = -L * 0.12; s1 = L * 0.12; }
      var len = s1 - s0, dash = 3, gap = 3;
      for (var s = s0; s < s1; s += dash + gap) {
        var f = frameAt(s);
        if (Math.abs(K[f.i]) > 1 / 120) continue;                 // straight only
        var off = f.hw - LINE_W - 1.0;
        if (off < 2) continue;
        paintRect(s + dash / 2, side * off, dash, 0.15, WHITE_PAINT);
      }
      // hatched chevrons at both ends of the pit straight
      [s0, s1].forEach(function (se, end) {
        for (var h = 0; h < 6; h++) {
          var ss = se + (end ? -1 : 1) * h * 1.6;
          var f = frameAt(ss), off = f.hw - LINE_W - 0.55;
          if (off < 2) continue;
          paintRect(ss, side * off, 1.2, 0.18, mulC(C.accent, 1, 1), side * (end ? -0.6 : 0.6));
        }
      });
      void len;
    })();

    /* ================= 7. BARRIERS ================= */
    // outer side of the circuit (fences for ovals)
    var meanK = 0;
    for (i = 0; i < N; i++) meanK += K[i];
    var outerSide = meanK >= 0 ? -1 : 1;
    // Adaptive ring keys along a wall line: a sample is skipped only when every skipped wall point lies
    // within WALL_TOL of the chord (so the visual face stays on the collision polyline to a few cm),
    // and the face normal direction changes by less than ~2 degrees. Cached per side/range.
    var WALL_TOL = 0.035, WALL_MAX_STRIDE = Q >= 3 ? 3 : Q >= 2 ? 5 : 7, wallKeyCache = {};
    function wallKeys(side, k0, k1) {
      var ck = side + ':' + k0 + ':' + k1;
      if (wallKeyCache[ck]) return wallKeyCache[ck];
      var WLn = wallLines[side], out = [k0], last = k0;
      for (var key = k0 + 1; key <= k1; key++) {
        if (key === k1) { out.push(key); break; }
        var nxt = key + 1, stride = nxt - last, ok = stride <= WALL_MAX_STRIDE;
        if (ok) {
          var a = mod(last, N), b = mod(nxt, N);
          if (TX[a] * TX[b] + TY[a] * TY[b] < 0.99939) ok = false;          // > 2 deg of heading
          var ax = WLn.x[a], ay = WLn.y[a], ex = WLn.x[b] - ax, ey = WLn.y[b] - ay, el = Math.hypot(ex, ey);
          for (var q = last + 1; ok && q < nxt; q++) {
            var c = mod(q, N), px = WLn.x[c] - ax, py = WLn.y[c] - ay;
            var dev = el > 1e-6 ? Math.abs(px * ey - py * ex) / el : Math.hypot(px, py);
            if (dev > WALL_TOL || Math.abs(E[c] - lerp(E[a], E[b], (q - last) / stride)) > WALL_TOL) ok = false;
          }
          if (ok && chunkOf(nxt) !== chunkOf(last) && chunkOf(key) !== chunkOf(last)) ok = false;   // keep chunk seams
        }
        if (!ok) { out.push(key); last = key; }
      }
      wallKeyCache[ck] = out;
      return out;
    }
    function wallRibbon(kind, material, side, profile, colFn, uvV, opts2) {
      // profile: [[d, y], ...] cross-section, d outward from the wall face (m), y up (m).
      // Flat-shaded per profile segment; v texture coordinate along the profile.
      var WLn = wallLines[side];
      opts2 = opts2 || {};
      var segs = [];
      var accum = 0;
      for (var q = 0; q < profile.length - 1; q++) {
        var p0 = profile[q], p1 = profile[q + 1];
        var dd = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dd, dy);
        if (l < 1e-5) continue;
        segs.push({ p0: p0, p1: p1, nO: -dy / l, nU: dd / l, v0: accum, v1: accum + l });
        accum += l;
      }
      var k0 = opts2.k0 || 0, k1 = opts2.k1 == null ? N : opts2.k1;
      var prev = null, prevPart = null;
      var keys = wallKeys(side, k0, k1);
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki], r = mod(key, N);
        var need = segs.length * 2;
        var part = parts.get(kind, chunkOf(key < k1 ? key : key - 1), material, need * 2);
        if (part !== prevPart) { if (prev) prev = emit(part, prev.key); prevPart = part; }
        var cur = emit(part, key);
        if (prev) for (var sg = 0; sg < segs.length; sg++) part.quad(prev.idx[sg * 2], cur.idx[sg * 2], cur.idx[sg * 2 + 1], prev.idx[sg * 2 + 1]);
        prev = cur;
      }
      function emit(part, key) {
        var r = mod(key, N), ox = side * NX[r], oy = side * NY[r];
        var bx = WLn.x[r], by = WLn.y[r], ey = E[r];
        var idx = [], s = key * ds, col = colFn ? colFn(r, key) : WHITE;
        for (var sg = 0; sg < segs.length; sg++) {
          var g = segs[sg];
          var nx = ox * g.nO, nz = -oy * g.nO, ny = g.nU;
          idx.push(part.v(bx + ox * g.p0[0], ey + g.p0[1], -(by + oy * g.p0[0]), nx, ny, nz, s / (uvV || 3), g.v0 / (uvV || 3), col));
          idx.push(part.v(bx + ox * g.p1[0], ey + g.p1[1], -(by + oy * g.p1[0]), nx, ny, nz, s / (uvV || 3), g.v1 / (uvV || 3), col));
        }
        return { key: key, idx: idx };
      }
    }
    function wallPoint(side, s, d) {          // sim point on the wall line at arc s, d outward
      var ss = mod(s, L), fi = ss / ds, i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N, t = fi - Math.floor(fi);
      var WLn = wallLines[side];
      var ox = side * lerp(NX[i0], NX[i1], t), oy = side * lerp(NY[i0], NY[i1], t);
      return { x: lerp(WLn.x[i0], WLn.x[i1], t) + ox * d, y: lerp(WLn.y[i0], WLn.y[i1], t) + oy * d,
        e: lerp(E[i0], E[i1], t), yaw: Math.atan2(lerp(TY[i0], TY[i1], t), lerp(TX[i0], TX[i1], t)), i: t < 0.5 ? i0 : i1 };
    }
    function posts(kind, material, side, spacing, d, h, half, col, phase) {
      var n = Math.floor(L / spacing);
      for (var q = 0; q < n; q++) {
        var s = (q + (phase || 0)) * spacing, w = wallPoint(side, s, d);
        var part = parts.get(kind, chunkOf(Math.floor(s / ds)), material, 24);
        boxGL(part, w.x, w.e + h / 2, -w.y, half, h / 2, half, w.yaw, col, 1, true);
      }
    }
    function catchFence(side, baseY, d, height) {
      // posts leaning slightly toward the track, mesh panel, top cable
      var spacing = 4;
      posts('fence-post', M.fencePost, side, spacing, d + 0.05, baseY + height, 0.055, WHITE);
      wallRibbon('fence', M.fence, side, [[d, baseY], [d - 0.05, baseY + height * 0.85], [d - 0.35, baseY + height]], null, 0.3);
      // top + middle cables
      wallRibbon('fence-post', M.fencePost, side, [[d - 0.33, baseY + height - 0.02], [d - 0.37, baseY + height + 0.04], [d - 0.41, baseY + height - 0.02]], null, 4);
    }
    function wallFor(side) {
      var type = wallType;
      var street = !!style.street;
      if (type === 'safer') {
        if (side === outerSide) {
          // SAFER: steel tube face (energy absorbing) on foam blocks in front of a concrete wall
          wallRibbon('safer', M.safer, side, [[0.32, 0.12], [0, 0.18], [0, 1.0], [0.32, 1.06]], null, 4);
          wallRibbon('concrete', M.concrete, side, [[0.32, 0], [0.32, 1.25], [0.8, 1.25], [0.8, 0]], null, 3);
          catchFence(side, 1.25, 0.7, 4.6);
        } else {
          wallRibbon('concrete', M.concrete, side, [[0, 0], [0.04, 0.12], [0.06, 1.05], [0.5, 1.05], [0.52, 0]], function (r, key) {
            return Math.floor(key * ds / 6) & 1 ? WHITE : [0.92, 0.92, 0.92, 1];
          }, 3);
        }
      } else if (type === 'concrete') {
        // jersey barrier + catch fence (street circuits)
        wallRibbon('concrete', M.concrete, side, [[0, 0], [0.05, 0.08], [0.2, 0.32], [0.28, 1.05], [0.46, 1.05], [0.54, 0.32], [0.69, 0.08], [0.74, 0]], function (r, key) {
          // painted sponsor bands every 30 m
          var b = Math.floor(key * ds / 30) % 4;
          return b === 1 ? mixC(WHITE, C.accent, night ? 0.25 : 0.55) : WHITE;
        }, 3);
        if (night) wallRibbon('led', M.led, side, [[0.255, 0.98], [0.26, 1.02]], null, 2);
        catchFence(side, 1.05, 0.37, street ? 3.4 : 2.8);
      } else if (type === 'guardrail') {
        // single W-beam on posts, delineators
        posts('guardrail-post', M.steel, side, 4, 0.22, 0.8, 0.06, [0.85, 0.85, 0.85, 1]);
        var wb = [[0, 0.5], [0.05, 0.56], [0.02, 0.62], [0.05, 0.68], [0, 0.74]];
        wallRibbon('guardrail', M.steel, side, wb, null, 4);
        wallRibbon('guardrail', M.steel, side, [[0.055, 0.74], [0.06, 0.74], [0.06, 0.5]], null, 4);
        var nDel = Math.floor(L / 25);
        for (var q = 0; q < nDel; q++) {
          var w = wallPoint(side, q * 25 + (side > 0 ? 0 : 12.5), 0.24);
          var part = parts.get('reflector', chunkOf(w.i), M.reflector, 24);
          boxGL(part, w.x, w.e + 0.95, -w.y, 0.03, 0.09, 0.05, w.yaw, side > 0 ? [1, 0.55, 0.1, 1] : WHITE, 1, true);
        }
      } else if (type === 'tyres') {
        // tyre wall: 3 stacked tyres with a belt, paint bands
        var prof = [];
        for (var t = 0; t < 3; t++) {
          var y0 = t * 0.26;
          prof.push([0.06, y0], [0.0, y0 + 0.06], [0.0, y0 + 0.2], [0.06, y0 + 0.26]);
        }
        prof.push([0.3, 0.8], [0.6, 0.8], [0.6, 0]);
        wallRibbon('tyres', M.tyres, side, prof, function (r, key) {
          var b = Math.floor(key * ds / 3) % 4;
          return b === 0 ? [0.85, 0.12, 0.1, 1] : b === 2 ? [0.9, 0.9, 0.9, 1] : [0.18, 0.18, 0.19, 1];
        }, 0.6);
      } else {
        // armco: double W-beam on posts, earth bank behind
        posts('armco-post', M.steel, side, 4, 0.28, 1.12, 0.06, [0.7, 0.7, 0.72, 1]);
        [0.36, 0.74].forEach(function (yb) {
          var wb2 = [[0, yb], [0.06, yb + 0.06], [0.025, yb + 0.155], [0.06, yb + 0.25], [0, yb + 0.31]];
          wallRibbon('armco', M.steel, side, wb2, null, 4);
          // flat back plate + top lip (seen from behind / from the heli cam), far cheaper than a mirrored W
          wallRibbon('armco', M.steel, side, [[0.065, yb + 0.31], [0.07, yb + 0.31], [0.07, yb]], null, 4);
        });
      }
    }
    if (opts.walls !== false) { wallFor(1); wallFor(-1); }

    /* ================= 8. BRIDGE (figure-8 upper deck) ================= */
    bridges.forEach(function (bd) {
      var k0 = bd.upper - mod(bd.upper - bd.start, N), k1 = bd.upper + mod(bd.end - bd.upper, N);
      // deck slab underside + sides from wall to wall
      [1, -1].forEach(function (side) {
        var WLn = wallLines[side];
        // slab edge face + girder under the deck edge
        wallRibbon('bridge', M.paintSteel, side, [[0.8, 0], [0.8, -DECK_T], [0.2, -DECK_T]], null, 3, { k0: k0, k1: k1 });
        // parapet trusses above the deck (steel bridge)
        var span = (k1 - k0) * ds, bays = Math.max(2, Math.round(span / 7)), bay = span / bays;
        var topH = 4.6, prevTop = null, prevBot = null;
        for (var b = 0; b <= bays; b++) {
          var s = k0 * ds + b * bay, wb = wallPoint(side, s, 0.9);
          var bot = [wb.x, wb.e, -wb.y], top = [wb.x, wb.e + topH, -wb.y];
          var part = parts.get('bridge', chunkOf(Math.floor(mod(s, L) / ds)), M.paintSteel, 200);
          beamGL(part, bot, top, 0.16, WHITE);
          if (prevTop) {
            beamGL(part, prevTop, top, 0.18, WHITE);
            beamGL(part, prevBot, bot, 0.18, WHITE);
            beamGL(part, (b & 1) ? prevBot : prevTop, (b & 1) ? top : bot, 0.12, WHITE);
          }
          prevTop = top; prevBot = bot;
        }
        void WLn;
      });
      // underside of the slab (faces down), the deck top is the road/run-off ribbons themselves
      ribbon('bridge', M.paintSteel, k0, k1, function (r) { return [-(WR[r] + 0.8), WL[r] + 0.8]; }, null,
        function (lat, s) { return [lat / 3, s / 3]; }, function () { return -DECK_T; });
      // portal cross beams over the deck
      var nPort = Math.max(2, Math.round((k1 - k0) * ds / 14));
      for (var pq = 0; pq <= nPort; pq++) {
        var sP = k0 * ds + (k1 - k0) * ds * pq / nPort;
        var a = wallPoint(1, sP, 0.9), c = wallPoint(-1, sP, 0.9);
        var partP = parts.get('bridge', chunkOf(a.i), M.paintSteel, 40);
        beamGL(partP, [a.x, a.e + 4.6, -a.y], [c.x, c.e + 4.6, -c.y], 0.17, WHITE);
      }
      // abutments at both ends (concrete) and piers clear of the lower road
      [k0, k1].forEach(function (ka, end) {
        var r = mod(ka, N), e = E[r];
        var wl = WL[r] + 0.8 + 1.6 * e, wr = WR[r] + 0.8 + 1.6 * e;
        var part = parts.get('abutment', chunkOf(r), M.concrete, 16);
        var fx = end ? TX[r] : -TX[r], fy = end ? TY[r] : -TY[r];   // face points toward the span
        var q = [[wl, 0], [WL[r] + 0.8, e], [-(WR[r] + 0.8), e], [-wr, 0]];
        var idx = q.map(function (qq) {
          var px = X[r] + NX[r] * qq[0], py = Y[r] + NY[r] * qq[0];
          return part.v(px, qq[1] - (qq[1] > 0 ? 0 : TERRAIN_SINK), -py, -fx, 0, fy, qq[0] / 3, qq[1] / 3, WHITE);
        });
        part.quad(idx[0], idx[1], idx[2], idx[3]);
      });
      var lower = bd.lower != null ? bd.lower : -1;
      [-10, 10].forEach(function (off) {
        var r = mod(bd.upper + off, N);
        [-1, 1].forEach(function (side) {
          var lat = side * Math.max(1.5, (side > 0 ? WL[r] : WR[r]) - 1.5);
          var px = X[r] + NX[r] * lat, py = Y[r] + NY[r] * lat;
          if (lower >= 0 && !clearOfLower(px, py, lower)) return;
          var part = parts.get('abutment', chunkOf(r), M.concrete, 30);
          var hgt = E[r] - DECK_T + TERRAIN_SINK;
          boxGL(part, px, E[r] - DECK_T - hgt / 2, -py, 0.7, hgt / 2, 0.7, Math.atan2(TY[r], TX[r]), WHITE, 0.5, true);
        });
      });
    });
    function clearOfLower(px, py, lowerIdx) {
      for (var o = -60; o <= 60; o++) {
        var q = mod(lowerIdx + o, N);
        if (E[q] > 0.25) continue;
        var dx = px - X[q], dy = py - Y[q];
        var lon = dx * TX[q] + dy * TY[q];
        if (Math.abs(lon) > ds) continue;
        var la = dx * NX[q] + dy * NY[q];
        if (Math.abs(la) < (la >= 0 ? WL[q] : WR[q]) + 1.2) return false;
      }
      return true;
    }

    /* ================= 9. EMBANKMENTS under bridge ramps ================= */
    if (elevated) {
      [1, -1].forEach(function (side) {
        runs(function (q) { return E[q] > 0.03 && !deck[q]; }).forEach(function (run) {
          ribbon('embankment', M.embank, run[0], run[1], function (r) {
            var w = side > 0 ? WL[r] : WR[r], e = E[r];
            return [side * w, side * (w + 0.8), side * (w + 0.8 + 1.6 * e)];
          }, function (r, jj, key, px, py) { return grassCol(px, py, 0, jj === 2 ? 0.85 : 1); },
          function (lat, s) { return [lat * GRASS_U, s * GRASS_U]; },
          function (r, jj) { return jj === 2 ? -E[r] - TERRAIN_SINK : -0.002; });
        });
      });
    }

    /* ================= 10. TERRAIN ================= */
    // bounds (sim) of everything inside the walls
    var bminX = Infinity, bminY = Infinity, bmaxX = -Infinity, bmaxY = -Infinity;
    for (i = 0; i < N; i++) {
      [wallLines[1], wallLines[-1]].forEach(function (wl) {
        var x = wl.x[i], y = wl.y[i];
        if (x < bminX) bminX = x; if (x > bmaxX) bmaxX = x; if (y < bminY) bminY = y; if (y > bmaxY) bmaxY = y;
      });
    }
    var margin = opts.terrainMargin != null ? opts.terrainMargin : 300;
    var tminX = bminX - margin, tminY = bminY - margin, tmaxX = bmaxX + margin, tmaxY = bmaxY + margin;
    var area = (tmaxX - tminX) * (tmaxY - tminY);
    var targetVerts = [22000, 42000, 72000, 110000][Q];
    var cell = Math.max(opts.terrainCell || 0, 5, Math.sqrt(area / targetVerts));
    var gx = Math.ceil((tmaxX - tminX) / cell), gy = Math.ceil((tmaxY - tminY) / cell);
    var cellX = (tmaxX - tminX) / gx, cellY = (tmaxY - tminY) / gy;
    var VX = gx + 1, VY = gy + 1;
    var eAll = new Float32Array(VX * VY).fill(1e9), eGround = new Float32Array(VX * VY).fill(1e9);
    // rasterise each sample's influence (signed distance beyond the wall on that side)
    var reach = 90;
    for (i = 0; i < N; i++) {
      var maxW = Math.max(WL[i], WR[i]) + reach;
      var ix0 = Math.max(0, Math.floor((X[i] - maxW - tminX) / cellX)), ix1 = Math.min(gx, Math.ceil((X[i] + maxW - tminX) / cellX));
      var iy0 = Math.max(0, Math.floor((Y[i] - maxW - tminY) / cellY)), iy1 = Math.min(gy, Math.ceil((Y[i] + maxW - tminY) / cellY));
      var low = E[i] < 0.25;
      for (var yy = iy0; yy <= iy1; yy++) {
        var py2 = tminY + yy * cellY - Y[i];
        for (var xx = ix0; xx <= ix1; xx++) {
          var px2 = tminX + xx * cellX - X[i];
          var lon = px2 * TX[i] + py2 * TY[i], la = px2 * NX[i] + py2 * NY[i];
          var lx = Math.max(0, Math.abs(lon) - ds * 0.5);
          var dist = Math.sqrt(lx * lx + la * la);
          var e = dist - (la >= 0 ? WL[i] : WR[i]);
          var vi = yy * VX + xx;
          if (e < eAll[vi]) eAll[vi] = e;
          if (low && e < eGround[vi]) eGround[vi] = e;
        }
      }
    }
    var amp = style.street ? 0 : style.touge ? 30 : style.kart ? 3 : style.oval ? 5 : 8;
    if (opts.terrainAmplitude != null) amp = opts.terrainAmplitude;
    var TH = new Float32Array(VX * VY);
    var edgeFade = Math.min(80, margin * 0.3);
    for (yy = 0; yy < VY; yy++) {
      for (xx = 0; xx < VX; xx++) {
        var vi2 = yy * VX + xx;
        var wx = tminX + xx * cellX, wy = tminY + yy * cellY;
        var mask = smooth((eAll[vi2] - 6) / 75);
        var border = Math.min(xx * cellX, (gx - xx) * cellX, yy * cellY, (gy - yy) * cellY);
        var fade = smooth(border / Math.max(1, edgeFade));
        var n1 = 0.5 + 0.5 * noise.fbm(wx / 260, wy / 260, 4);
        var hgt2 = amp * mask * fade * n1;
        // secondary rolling detail (small hummocks) so the far grass is not one smooth blanket
        hgt2 += amp * 0.14 * mask * fade * (0.5 + 0.5 * noise.fbm(wx / 62 - 7, wy / 62 + 5, 2));
        if (style.touge) hgt2 += amp * 0.6 * mask * fade * smooth((eAll[vi2] - 40) / 200) * (0.5 + 0.5 * noise.fbm(wx / 600 + 9, wy / 600, 3));
        TH[vi2] = -TERRAIN_SINK + hgt2;
      }
    }
    /* ---- 10b. STREET SIDEWALKS behind the barriers (street circuits only) ----
       Raised paving from the back of the jersey barrier outwards, width limited per sample so it never
       intrudes into a neighbouring section of the circuit (uses the signed wall-distance field). */
    var sidewalkRings = 0;
    if (style.street && wallType === 'concrete' && opts.sidewalks !== false) {
      var eAt = function (sx, sy) {
        var fx = (sx - tminX) / cellX, fy = (sy - tminY) / cellY;
        if (!(fx >= 0 && fy >= 0 && fx <= gx && fy <= gy)) return 1e9;
        var ix = Math.min(gx - 1, Math.floor(fx)), iy = Math.min(gy - 1, Math.floor(fy)), u = fx - ix, v = fy - iy;
        var a = eAll[iy * VX + ix], b = eAll[iy * VX + ix + 1], c = eAll[(iy + 1) * VX + ix], d = eAll[(iy + 1) * VX + ix + 1];
        return lerp(lerp(a, b, u), lerp(c, d, u), v);
      };
      var SW_IN = 0.76, SW_MAX = 5.2, SW_H = 0.14;
      [1, -1].forEach(function (side) {
        var Wd = side > 0 ? WL : WR, wid = new Float64Array(N);
        for (var q = 0; q < N; q++) {
          var best = 0;
          for (var d = SW_MAX; d >= 1.6; d -= 0.9) {
            var la = Wd[q] + d, px = X[q] + NX[q] * side * la, py = Y[q] + NY[q] * side * la;
            // own sample gives ~d; anything noticeably smaller means another section is nearby
            if (eAt(px, py) >= d - 0.9 - cellX * 0.75) { best = d; break; }
          }
          wid[q] = best;
        }
        // running minimum (+-6 samples) so the paving edge stays smooth and conservative
        var wmin = new Float64Array(N);
        for (q = 0; q < N; q++) {
          var m = wid[q];
          for (var o = -6; o <= 6; o++) m = Math.min(m, wid[mod(q + o, N)]);
          wmin[q] = E[q] > 0.05 ? 0 : m;
        }
        runs(function (q2) { return wmin[q2] >= 1.6; }).forEach(function (run) {
          ribbon('sidewalk', M.sidewalk, run[0], run[1], function (r) {
            var a0 = Wd[r] + SW_IN, w = Math.max(wmin[r], 0.05), a1 = Wd[r] + SW_IN + w;
            return [side * a0, side * (a0 + 0.05), side * Math.max(a0 + 0.1, a1 - 0.32), side * Math.max(a0 + 0.15, a1 - 0.3), side * (a1 + 0.02)];
          }, function (r, jj, key) {
            // paving slabs + a darker granite kerbstone at the outer edge
            if (jj >= 3) return [0.62, 0.62, 0.64, 1];
            var v = (Math.floor(key * ds / 1.5) & 1 ? 1.0 : 0.94) * (1 + 0.05 * noise.noise(key * ds / 7, jj * 1.7));
            return [v, v, v, 1];
          }, function (lat, s) { return [lat / 3, s / 3]; }, function (r, jj) {
            return jj === 0 ? 0.0 : jj === 4 ? -TERRAIN_SINK : SW_H;
          });
          sidewalkRings += run[1] - run[0] + 1;
        });
      });
    }

    // emit tiles
    var TILE = 96;
    var tilesX = Math.ceil(gx / TILE), tilesY = Math.ceil(gy / TILE);
    var dropped = 0;
    for (var ty = 0; ty < tilesY; ty++) {
      for (var tx = 0; tx < tilesX; tx++) {
        var x0 = tx * TILE, x1 = Math.min(gx, x0 + TILE), y0 = ty * TILE, y1 = Math.min(gy, y0 + TILE);
        var facet = !style.street;   // faceted low-poly terrain: unwelded triangles with per-face normal + colour
        var part = parts.get('terrain', 'tile' + tx + '_' + ty, M.terrain, facet ? (x1 - x0) * (y1 - y0) * 6 : (x1 - x0 + 1) * (y1 - y0 + 1));
        var base = part.vc, rowLen = x1 - x0 + 1, tcol = facet ? [] : null, tpos = facet ? [] : null;
        for (yy = y0; yy <= y1; yy++) {
          for (xx = x0; xx <= x1; xx++) {
            var vi3 = yy * VX + xx;
            var hL = TH[yy * VX + Math.max(0, xx - 1)], hR = TH[yy * VX + Math.min(gx, xx + 1)];
            var hD = TH[Math.max(0, yy - 1) * VX + xx], hU = TH[Math.min(gy, yy + 1) * VX + xx];
            // GL normal: d/dx and d/dz where z = -y
            var dhdx = (hR - hL) / (2 * cellX), dhdz = -(hU - hD) / (2 * cellY);
            var nn = norm3([-dhdx, 1, -dhdz]);
            var wx2 = tminX + xx * cellX, wy2 = tminY + yy * cellY;
            var slope = 1 - nn[1], col;
            if (style.street) {
              var tint = 0.86 + 0.16 * (0.5 + 0.5 * noise.fbm(wx2 / 45 + 3, wy2 / 45, 3));
              col = [tint, tint, tint * 0.97, 1];
            } else {
              // worn verge just behind the barriers (mowers / spectators / run-off spill), then natural grass
              var ew = eAll[vi3];
              var edgeT = ew > -1.2 && ew < 7 ? 0.55 * (1 - smooth((ew - 1) / 6)) : 0;
              // hollows a touch darker / lusher, crests lighter (cheap fake of moisture + sky occlusion)
              var crest = clamp((TH[vi3] + TERRAIN_SINK) / Math.max(1, amp), 0, 1);
              col = grassCol(wx2, wy2, edgeT, 0.93 + 0.12 * crest);
            }
            if (!style.street && slope > 0.12) {
              var rk = smooth((slope - 0.12) / 0.25);
              var rkc = [C.rock[0] / Math.max(0.05, C.grass[0]), C.rock[1] / Math.max(0.05, C.grass[1]), C.rock[2] / Math.max(0.05, C.grass[2])];
              col = [lerp(col[0], Math.min(3, rkc[0]) * 0.8, rk), lerp(col[1], Math.min(3, rkc[1]) * 0.8, rk), lerp(col[2], Math.min(3, rkc[2]) * 0.8, rk), 1];
            }
            if (facet) { tcol.push(col); tpos.push(wx2, TH[vi3], -wy2); }
            else part.v(wx2, TH[vi3], -wy2, nn[0], nn[1], nn[2], wx2 / 8, wy2 / 8, col);
          }
        }
        for (yy = y0; yy < y1; yy++) {
          for (xx = x0; xx < x1; xx++) {
            var c00 = yy * VX + xx, c10 = c00 + 1, c01 = c00 + VX, c11 = c01 + 1;
            // fully inside the barriers of a ground-level track part -> covered by track surfaces
            if (eGround[c00] < -1.2 && eGround[c10] < -1.2 && eGround[c01] < -1.2 && eGround[c11] < -1.2) { dropped++; continue; }
            var a0 = base + (yy - y0) * rowLen + (xx - x0);
            if (facet) {
              // same triangulation as groundY(): (00,10,11) and (00,11,01)
              var l00 = (yy - y0) * rowLen + (xx - x0), l10 = l00 + 1, l01 = l00 + rowLen, l11 = l01 + 1;
              facetTri(part, tpos, tcol, l00, l10, l11, c00);
              facetTri(part, tpos, tcol, l00, l11, l01, c00 + 7919);
            } else part.quad(a0, a0 + 1, a0 + 1 + rowLen, a0 + rowLen);
          }
        }
      }
    }
    function facetTri(part, P, Cs, a, b, c, h) {
      var ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
      var ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      var n = norm3([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
      if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
      // per-face value jitter (subtle) on the averaged corner colour
      var j = 0.965 + 0.07 * (((Math.imul(h | 0, 2654435761) >>> 0) % 1000) / 1000), A = Cs[a], B = Cs[b], Cc = Cs[c];
      var col = [(A[0] + B[0] + Cc[0]) / 3 * j, (A[1] + B[1] + Cc[1]) / 3 * j, (A[2] + B[2] + Cc[2]) / 3 * j, 1];
      var i0 = part.v(ax, ay, az, n[0], n[1], n[2], ax / 8, -az / 8, col), i1 = part.v(bx, by, bz, n[0], n[1], n[2], bx / 8, -bz / 8, col), i2 = part.v(cx, cy, cz, n[0], n[1], n[2], cx / 8, -cz / 8, col);
      part.tri(i0, i1, i2);
    }
    // far ground skirt out to the horizon (flat, at terrain edge height)
    (function () {
      var part = parts.get('terrain', 'far', M.terrain, 64);
      var R = Math.max(tmaxX - tminX, tmaxY - tminY) * 2 + 4000;
      var cx = (tminX + tmaxX) / 2, cy = (tminY + tmaxY) / 2;
      var inner = [[tminX, tminY], [tmaxX, tminY], [tmaxX, tmaxY], [tminX, tmaxY]];
      var outer = [[cx - R, cy - R], [cx + R, cy - R], [cx + R, cy + R], [cx - R, cy + R]];
      var y = -TERRAIN_SINK;
      for (var q = 0; q < 4; q++) {
        var a = inner[q], b = inner[(q + 1) % 4], c = outer[(q + 1) % 4], d = outer[q];
        var ids = [a, b, c, d].map(function (p) { return part.v(p[0], y, -p[1], 0, 1, 0, p[0] / 8, p[1] / 8, [0.82, 0.82, 0.8, 1]); });
        part.quad(ids[0], ids[1], ids[2], ids[3]);
      }
    })();

    function groundY(x, z) {
      var sx = x, sy = -z;
      var fx = (sx - tminX) / cellX, fy = (sy - tminY) / cellY;
      if (!(fx >= 0 && fy >= 0 && fx <= gx && fy <= gy)) return -TERRAIN_SINK;
      var ix = Math.min(gx - 1, Math.floor(fx)), iy = Math.min(gy - 1, Math.floor(fy));
      var u = fx - ix, v = fy - iy;
      var h00 = TH[iy * VX + ix], h10 = TH[iy * VX + ix + 1], h01 = TH[(iy + 1) * VX + ix], h11 = TH[(iy + 1) * VX + ix + 1];
      // same triangulation as the mesh: (00,10,11) and (00,11,01)
      if (u >= v) return h00 + (h10 - h00) * u + (h11 - h10) * v;
      return h00 + (h11 - h01) * u + (h01 - h00) * v;
    }
    // road height at GL (x, z): with a sample hint, project onto the hinted segment (lower vs upper
    // deck of a crossing is decided by the hint); without one, search the nearest centerline sample.
    function roadY(x, z, idx) {
      if (!elevated) return 0;
      var sx = fin(x, 0), sy = -fin(z, 0), best = -1, bd = Infinity, q, dx, dy, d;
      if (idx != null && isFinite(idx)) {
        var c0 = mod(Math.round(idx), N);
        for (var o = -3; o <= 3; o++) {
          q = mod(c0 + o, N); dx = sx - X[q]; dy = sy - Y[q]; d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = q; }
        }
      } else {
        for (q = 0; q < N; q++) { dx = sx - X[q]; dy = sy - Y[q]; d = dx * dx + dy * dy; if (d < bd) { bd = d; best = q; } }
      }
      if (best < 0) return 0;
      var lon = (sx - X[best]) * TX[best] + (sy - Y[best]) * TY[best];
      var f = clamp(lon / ds, -1, 1), j = f >= 0 ? (best + 1) % N : mod(best - 1, N);
      return lerp(E[best], E[j], Math.abs(f));
    }
    function heightAtIndex(idx) { return E[mod(Math.round(fin(idx, 0)), N)]; }
    function heightAt(s) {
      var ss = mod(fin(s, 0), L), f = ss / ds, i0 = Math.floor(f) % N, t = f - Math.floor(f);
      return lerp(E[i0], E[(i0 + 1) % N], t);
    }

    /* ---- finalise parts ---- */
    var out = [], tris = 0, verts = 0;
    var gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
    parts.list.forEach(function (p) {
      if (!p.i.length) return;
      var pos = new Float32Array(p.p);
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (var q = 0; q < pos.length; q += 3) {
        for (var a = 0; a < 3; a++) { var v = pos[q + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
      }
      if (p.kind !== 'terrain' || p.chunk !== 'far') for (var a2 = 0; a2 < 3; a2++) { gmin[a2] = Math.min(gmin[a2], mn[a2]); gmax[a2] = Math.max(gmax[a2], mx[a2]); }
      var m = p.material;
      var castShadow = /wall|concrete|safer|armco|guardrail|tyres|fence|bridge|abutment|post|kerb|led/.test(p.kind) && p.kind !== 'kerb';
      out.push({
        kind: p.kind, chunk: p.chunk, material: m, castShadow: castShadow, transparent: !!m.transparent, decal: !!m.decal,
        positions: pos, normals: new Float32Array(p.n), uvs: new Float32Array(p.t), colors: new Float32Array(p.c),
        indices: new Uint16Array(p.i), vertexCount: p.vc, triangleCount: p.i.length / 3,
        bounds: { min: mn, max: mx, center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
          radius: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 }
      });
      tris += p.i.length / 3; verts += p.vc;
    });
    // draw order hint: ground first, then surfaces, decals, barriers, transparent last
    var ORDER = { terrain: 0, embankment: 1, 'runoff-grass': 2, 'runoff-sand': 2, 'runoff-tarmac': 2, gravel: 2, road: 3, line: 4, kerb: 4, decal: 5 };
    out.sort(function (a, b) {
      var oa = a.transparent ? 99 : (ORDER[a.kind] != null ? ORDER[a.kind] : 10), ob = b.transparent ? 99 : (ORDER[b.kind] != null ? ORDER[b.kind] : 10);
      return oa - ob;
    });

    var wallsOut = { left: [], right: [] };
    for (i = 0; i < N; i++) {
      wallsOut.left.push([wallLines[1].x[i], -wallLines[1].y[i]]);
      wallsOut.right.push([wallLines[-1].x[i], -wallLines[-1].y[i]]);
    }
    return {
      parts: out,
      bounds: { min: gmin, max: gmax },
      terrainBounds: { minX: tminX, maxX: tmaxX, minZ: -tmaxY, maxZ: -tminY, cell: [cellX, cellY] },
      groundY: groundY, heightAt: heightAt, heightAtIndex: heightAtIndex, roadY: roadY,
      elevation: new Float32Array(E), bridges: bridges, walls: wallsOut,
      outerSide: outerSide, wallType: wallType,
      stats: { triangles: tris, vertices: verts, parts: out.length, terrainDropped: dropped,
        wallFolds: wallLines[1].folds + wallLines[-1].folds, sidewalkRings: sidewalkRings, samples: N, quality: quality }
    };
  }

  /* ================================================================ GL build */

  var TEX_FOR = {
    asphalt: function (T, ctx, m) { return T.asphalt && T.asphalt(ctx, m.mapOpts || {}); },
    grass: function (T, ctx) { return T.grass && T.grass(ctx); },
    sand: function (T, ctx) { return T.sand && T.sand(ctx); },
    gravel: function (T, ctx) { return (T.gravel && T.gravel(ctx)) || (T.sand && T.sand(ctx)); },
    concrete: function (T, ctx) { return T.concrete && T.concrete(ctx); },
    tyreWall: function (T, ctx) { return T.tyreWall && T.tyreWall(ctx); },
    fence: function (T, ctx) { return fenceTexture(T, ctx); }
  };
  var fenceCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function fenceTexture(T, ctx) {
    if (!T.canvas) return null;
    if (fenceCache && fenceCache.has(ctx)) return fenceCache.get(ctx);
    var tex = null;
    try {
      tex = T.canvas(ctx, 64, 64, function (g, w, h) {
        g = g || this;
        g.clearRect(0, 0, w || 64, h || 64);
        g.strokeStyle = 'rgba(200,205,210,1)';
        g.lineWidth = 1.5;
        g.beginPath();
        // chain-link diamonds (tileable)
        g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64);
        g.moveTo(32, 0); g.lineTo(64, 32); g.lineTo(32, 64); g.lineTo(0, 32); g.closePath();
        g.stroke();
      }, { key: 'forge-track-fence', wrapS: 'repeat', wrapT: 'repeat', mips: true });
    } catch (e) { tex = null; }
    if (fenceCache) fenceCache.set(ctx, tex);
    return tex;
  }

  // ratio of a theme colour to the reference colour each procedural texture is painted in,
  // so per-track theme colours still come through when a texture map is used
  var TEX_REF = { asphalt: '#3a3c40', grass: '#4f7a34', sand: '#cfb680', gravel: '#cfb680', concrete: '#d8d8d8' };
  function tintFor(m) {
    if (!m.tint || !TEX_REF[m.map]) return WHITE;
    var ref = hexLin(TEX_REF[m.map]);
    return [clamp(m.tint[0] / ref[0], 0.5, 1.8), clamp(m.tint[1] / ref[1], 0.5, 1.8), clamp(m.tint[2] / ref[2], 0.5, 1.8), 1];
  }

  function resolveMaterial(ctx, m, cache) {
    if (cache[m.name]) return cache[m.name];
    var T = CB.gl.textures || {};
    var tex = null;
    if (m.map && TEX_FOR[m.map]) { try { tex = TEX_FOR[m.map](T, ctx, m) || null; } catch (e) { tex = null; } }
    var base = tex ? mulC(tintFor(m), 1, m.color[3]) : (m.tint ? [m.tint[0], m.tint[1], m.tint[2], m.color[3]] : m.color);
    if (tex && m.color !== WHITE && !m.tint) base = m.color;
    if (m.name === 'fence' && !tex) base = [0.36, 0.38, 0.4, 0.28];
    var bc = base.slice(0, 4), em = (m.emissive || [0, 0, 0]).slice(0, 3);
    // both naming conventions (uniform names + plain keys) so any drawList flavour picks them up
    var out = {
      name: m.name,
      uBaseColor: bc, baseColor: bc, color: bc, opacity: bc[3],
      uMap: tex, map: tex, uUseMap: tex ? 1 : 0, useMap: !!tex,
      uMetallic: m.metallic, metallic: m.metallic, uRoughness: m.roughness, roughness: m.roughness,
      uClearcoat: m.clearcoat || 0, clearcoat: m.clearcoat || 0, uFlake: 0,
      uEmissive: em, emissive: em,
      transparent: !!m.transparent, blend: !!m.transparent, alphaTest: m.name === 'fence' && tex ? 0.05 : 0,
      // per-material wet response (gl-core multiplies env wetness by this): grass/soil darken only, no puddles
      wetness: m.wetness == null ? 1 : m.wetness,
      doubleSided: m.name === 'fence', depthWrite: !m.transparent,
      decal: !!m.decal, polygonOffset: m.decal ? [-1, -2] : null
    };
    // asphalt: large-scale mottle sampled in world xz at a non-integer multiple of the 6 m base tile (gl-core
    // uMottleMap / uMottle), so the repeat of the base tile never reads as a grid down the straights
    if (tex && m.map === 'asphalt' && typeof T.asphaltMottle === 'function') {
      var mt = null;
      try { mt = T.asphaltMottle(ctx) || null; } catch (e) { mt = null; }
      if (mt) { out.mottleMap = out.uMottleMap = mt; out.mottle = [T.ASPHALT_MOTTLE_M || 41, m.name === 'road' ? 1 : 0.8, 0.37, 0.61]; }
    }
    // grass: the same macro mottle texture at a much larger, non-integer scale (97 m vs the 8 m grass tile) gives
    // luminance blotches + darker lush patches that break the tiling seen from the chase / heli cameras
    if (tex && m.map === 'grass' && typeof T.asphaltMottle === 'function') {
      var gm = null;
      try { gm = T.asphaltMottle(ctx) || null; } catch (e) { gm = null; }
      if (gm) { out.mottleMap = out.uMottleMap = gm; out.mottle = [97, 1.25, 0.13, 0.71]; }
    }
    cache[m.name] = out;
    return out;
  }

  function identity() { var a = new Float32Array(16); a[0] = a[5] = a[10] = a[15] = 1; return a; }

  function build(ctx, geom, trackDef, opts) {
    opts = opts || {};
    var res = buildGeometry(geom, trackDef, opts);
    var meshes = [], matCache = {};
    var canMesh = ctx && CB.gl && typeof CB.gl.createMesh === 'function';
    res.parts.forEach(function (p) {
      var mesh = null;
      if (canMesh) {
        try {
          mesh = CB.gl.createMesh(ctx, { positions: p.positions, normals: p.normals, uvs: p.uvs, colors: p.colors, colorSize: 4, indices: p.indices });
        } catch (e) { mesh = null; if (typeof console !== 'undefined') console.warn('CB.gl.track: mesh failed', p.kind, e); }
        if (!mesh) return;
      }
      if (mesh && !mesh.bounds) mesh.bounds = p.bounds;
      meshes.push({
        mesh: mesh, material: canMesh ? resolveMaterial(ctx, p.material, matCache) : p.material,
        castShadow: p.castShadow, transparent: p.transparent, decal: p.decal, kind: p.kind,
        bounds: p.bounds, model: identity(), triangles: p.triangleCount, geometry: canMesh ? null : p
      });
    });
    return {
      meshes: meshes, items: meshes,
      bounds: res.bounds, terrainBounds: res.terrainBounds,
      groundY: res.groundY, heightAt: res.heightAt, heightAtIndex: res.heightAtIndex,
      // road surface height under a world point (GL x, z); idx = nearest centerline sample hint.
      // Renderer3d calls roadY(x, z, idx). 0 everywhere except on a figure-8 bridge ramp/deck,
      // where the lower road (crossing underneath) is told apart by the hint/proximity.
      roadY: function (x, z, idx) { return res.roadY(x, z, idx); },
      carY: function (car) {
        if (!car) return 0;
        if (car.s != null && isFinite(car.s)) return res.heightAt(car.s);
        return 0;
      },
      elevation: res.elevation, bridges: res.bridges, walls: res.walls, stats: res.stats,
      destroy: function () {
        meshes.forEach(function (m) { if (m.mesh && m.mesh.destroy) { try { m.mesh.destroy(); } catch (e) { /* ignore */ } } });
        meshes.length = 0;
      }
    };
  }

  return {
    build: build,
    buildGeometry: buildGeometry,
    constants: { LINE_W: LINE_W, DECAL_Y: DECAL_Y, KERB_H: KERB_H, TERRAIN_SINK: TERRAIN_SINK, BRIDGE_H: BRIDGE_H },
    _hexLin: hexLin
  };
})();

if (typeof module !== 'undefined') module.exports = CB.gl.track;

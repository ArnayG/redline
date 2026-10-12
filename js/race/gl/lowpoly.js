/* ==========================================================================
   FORGE Atelier — js/race/gl/lowpoly.js
   CB.lowpoly : deliberately faceted low-poly models of the real cars (LOWPOLY-SPEC.md).

   API
     CB.lowpoly.register(id, def)        hand-authored definition (format: LOWPOLY-SPEC.md "Authoring format");
                                         returns {ok, errors}. Files loaded before this script queue on
                                         CB.lowpoly._pending = [[id, def], ...] (drained on load).
     CB.lowpoly.has(id)                  true when a valid hand-authored definition exists
     CB.lowpoly.get(id) / list()         the stored def / registered ids
     CB.lowpoly.validate(def)            {ok, errors[]}
     CB.lowpoly.autoDef(modelOrId)       the automatic low-poly def derived from CB.shapes (ref coordinates)
     CB.lowpoly.build(build, opts)       -> { parts:[{kind, mat, positions, normals, colors, uvs, indices, material,
                                              attach, wheel?, lightKey?, wing?, castShadow, transparent, triangles}],
                                              dims, cockpitEye, hoodCam, bumperCam, anchors, model, stats, lod, auto }
         opts: { lod:'high'|'low', model:id, S (car-mesh resolve()+shapeSetup() spec, optional), isPlayer, id, number,
                 color, accent }
     CB.lowpoly.carStyle(opts)           'lowpoly' | 'detailed' (opts.carStyle > CB.lowpoly.style >
                                         profile graphics.carStyle > 'lowpoly')
     CB.lowpoly.materials(S)             gl-core material descriptors per bucket (body, roof, trim, gloss, chrome,
                                         carbon, glass, head, drl, tail, rev, wing, tyre, rim, caliper, low)
   Authoring extras handled here: projected-decal option maxTilt (planeDecal), def.exhaust tip override
   (exhaustTips), flare() bands clamped to the arch cut radius (clampFlare), mirror stalks (planMirrors).
   Geometry: car-local metres, +x forward, +y up (ground 0), +z right, origin = centre of the overall length
   (shape origin - fitted dims.centerX), same as CB.gl.car. Flat shading: every triangle has its own unwelded
   vertices and face normal; colours are per-face vertex colours (materials carry the PBR parameters only).
   Pure geometry, no DOM / GL: runs in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';
  var LP = CB.lowpoly = CB.lowpoly || {};
  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scl(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  /* ================================================================ colours */
  function hexRgb(hex, fb) {
    if (Array.isArray(hex) && hex.length >= 3) return [num(+hex[0], 0.5), num(+hex[1], 0.5), num(+hex[2], 0.5)];
    var s = typeof hex === 'string' ? hex.trim() : '';
    if (s[0] === '#') s = s.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return fb != null ? hexRgb(fb) : [0.5, 0.5, 0.5];
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function lin(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }
  function lhex(h, fb) { return lin(hexRgb(h, fb)); }
  // linear base colours of the fixed materials
  var PAL = {
    black: [0.016, 0.017, 0.019], gloss: [0.007, 0.007, 0.008], chrome: [0.62, 0.63, 0.65], rubber: [0.022, 0.022, 0.024],
    glass: [0.006, 0.008, 0.011], light: [0.78, 0.81, 0.85], drl: [0.92, 0.95, 1.0], tail: [0.42, 0.012, 0.014],
    rev: [0.8, 0.8, 0.82], indicator: [0.85, 0.33, 0.02], grille: [0.009, 0.009, 0.01], carbon: [0.012, 0.0125, 0.0145],
    plate: [0.80, 0.80, 0.76], badge: [0.55, 0.56, 0.58], well: [0.007, 0.007, 0.008], under: [0.012, 0.012, 0.013],
    white: [0.86, 0.86, 0.84], tyre: [0.026, 0.026, 0.028], disc: [0.28, 0.28, 0.29], hat: [0.09, 0.09, 0.1],
    interior: [0.02, 0.02, 0.022]
  };
  var MATS = ['paint', 'paint2', 'glass', 'black', 'gloss', 'chrome', 'rubber', 'light', 'drl', 'tail', 'indicator', 'grille',
    'carbon', 'plate', 'badge', 'rev', 'well', 'under', 'white', 'mirror', 'interior', 'stripe', 'accent', 'caliper', 'rim'];
  // material key -> geometry bucket
  var BUCKET = {
    paint: 'body', paint2: 'roof', glass: 'glass', black: 'trim', rubber: 'trim', grille: 'trim', plate: 'trim', well: 'trim',
    under: 'trim', white: 'trim', interior: 'trim', gloss: 'gloss', badge: 'gloss', indicator: 'gloss', chrome: 'chrome',
    carbon: 'carbon', light: 'head', drl: 'drl', tail: 'tail', rev: 'rev', stripe: 'body', accent: 'body', caliper: 'gloss', rim: 'chrome'
  };
  var FINISH = {
    solid: { m: 0.0, r: 0.32, cc: 0.7 }, metallic: { m: 0.45, r: 0.34, cc: 0.9 }, pearl: { m: 0.3, r: 0.3, cc: 0.9 },
    matte: { m: 0.1, r: 0.8, cc: 0.0 }, satin: { m: 0.25, r: 0.55, cc: 0.25 }, chrome: { m: 1.0, r: 0.08, cc: 0.4 },
    candy: { m: 0.4, r: 0.22, cc: 1.0 }, chameleon: { m: 0.5, r: 0.24, cc: 1.0 }
  };

  /* ================================================================ materials (gl-core descriptors) */
  function material(o) {
    var c = o.color || [1, 1, 1, 1];
    if (c.length === 3) c = [c[0], c[1], c[2], 1];
    var m = {
      baseColor: c, color: c, metallic: num(o.metallic, 0), roughness: num(o.roughness, 0.7), clearcoat: num(o.clearcoat, 0),
      flake: 0, hueShift: 0, emissive: o.emissive || [0, 0, 0], transparent: false, opacity: c[3], unlit: false,
      doubleSided: false, name: o.name || '', lowpoly: true
    };
    if (o.clearcoatRoughness != null) m.clearcoatRoughness = o.clearcoatRoughness;
    if (o.polygonOffset) m.polygonOffset = o.polygonOffset;
    m.uBaseColor = m.baseColor; m.uMetallic = m.metallic; m.uRoughness = m.roughness; m.uClearcoat = m.clearcoat;
    m.uEmissive = m.emissive; m.uFlake = 0; m.uHueShift = 0; m.useMap = 0; m.uUseMap = 0;
    return m;
  }
  function DARK_ENV(k) { return { envIntensity: k, uEnvIntensity: k }; }
  function materials(S) {
    S = S || {};
    var F = FINISH[S.finishId] || FINISH.metallic;
    var wm = S.wheelMaterial === 'carbon' ? { m: 0.2, r: 0.3 } : S.wheelMaterial === 'steel' ? { m: 0.6, r: 0.45 } : { m: 0.75, r: 0.32 };
    var lampOff = [-1, -2];
    return {
      body: material({ name: 'paint', metallic: F.m, roughness: F.r, clearcoat: F.cc, clearcoatRoughness: 0.08 }),
      // a gloss-black roof is paint-finished but must read black: half the sky reflection (a body-colour / contrast
      // roof keeps the paint's)
      roof: Object.assign(material({ name: 'roof', metallic: F.m * 0.6, roughness: Math.max(0.2, F.r), clearcoat: F.cc, clearcoatRoughness: 0.08 }), S.roof === 'black' ? DARK_ENV(0.5) : {}),
      trim: material({ name: 'trim', roughness: 0.62, metallic: 0, clearcoat: 0.08 }),
      // gloss black (pillars, window surrounds, mirror caps): full clear coat but half the sky reflection, or the
      // Fresnel term turns it white at grazing angles (rear quarters, A-pillars) and the greenhouse stops reading dark
      gloss: Object.assign(material({ name: 'trim-gloss', roughness: 0.22, metallic: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 }), DARK_ENV(0.5)),
      chrome: material({ name: 'chrome', metallic: 1, roughness: 0.14, clearcoat: 0.2 }),
      // carbon: near-black dielectric weave under a thinner lacquer (metallic + full clear coat mirrored the sky and
      // read light grey on up-facing splitters / wings / carbon roofs); the weave is a per-face two-tone in the vertex colours
      carbon: Object.assign(material({ name: 'carbon', roughness: 0.5, metallic: 0, clearcoat: 0.15, clearcoatRoughness: 0.2 }), DARK_ENV(0.25)),
      // tinted glass: standard shading (materialType 0), not gl-core's thin-glass model. Thin glass forces F0 = 0.04
      // and doubles the specular (two interfaces); on big flat low-poly facets the broad sun lobe then lit whole panes
      // white and the Fresnel sky term went pale at grazing angles (rear quarters, A-pillars beside a flat cowl, raked
      // rear screens). Here F0 = mix(0.04, near-black albedo, 0.85) ~ 0.014 (a third of the sun highlight / face-on
      // sheen), a moderate roughness (the split-sum env BRDF falls off fast at grazing) and a reduced env intensity:
      // the greenhouse reads as dark tinted glass from every angle with a faint sky sheen
      glass: Object.assign(material({ name: 'glass-lowpoly', roughness: 0.35, metallic: 0.85, clearcoat: 0, clearcoatRoughness: 0.1 }), DARK_ENV(0.4), { materialType: 'standard' }),
      head: material({ name: 'light-head', roughness: 0.12, metallic: 0.2, clearcoat: 1, polygonOffset: lampOff }),
      drl: material({ name: 'light-drl', roughness: 0.12, metallic: 0, clearcoat: 1, polygonOffset: lampOff }),
      tail: material({ name: 'light-brake', roughness: 0.15, metallic: 0.1, clearcoat: 1, polygonOffset: lampOff }),
      rev: material({ name: 'light-rev', roughness: 0.15, metallic: 0.2, clearcoat: 1, polygonOffset: lampOff }),
      wing: Object.assign(material({ name: 'wing', roughness: 0.5, metallic: 0, clearcoat: 0.15, clearcoatRoughness: 0.2 }), DARK_ENV(0.25)),
      tyre: material({ name: 'tyre', roughness: 0.88, metallic: 0 }),
      rim: material({ name: 'rim', metallic: wm.m, roughness: wm.r, clearcoat: 0.3 }),
      caliper: material({ name: 'caliper', roughness: 0.35, metallic: 0.1, clearcoat: 0.9, clearcoatRoughness: 0.08 }),
      low: material({ name: 'paint', metallic: F.m * 0.7, roughness: Math.max(0.3, F.r), clearcoat: F.cc * 0.7 }),
      wheelsLow: material({ name: 'wheels', roughness: 0.65, metallic: 0.25 })
    };
  }

  /* ================================================================ settings */
  function carStyle(opts) {
    opts = opts || {};
    if (opts.carStyle === 'lowpoly' || opts.carStyle === 'detailed') return opts.carStyle;
    if (LP.style === 'lowpoly' || LP.style === 'detailed') return LP.style;
    try {
      var P = CB.game && CB.game.profile;
      if (P && typeof P.getSetting === 'function') {
        var v = P.getSetting('graphics.carStyle', null);
        if (v === 'lowpoly' || v === 'detailed') return v;
      }
    } catch (e) { /* no profile */ }
    return 'lowpoly';
  }

  /* ================================================================ 2D helpers */
  function area2(P) { var a = 0; for (var i = 0, n = P.length; i < n; i++) { var p = P[i], q = P[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function dedupe(P, eps) {
    var out = [];
    eps = eps || 1e-6;
    for (var i = 0; i < P.length; i++) {
      var p = P[i], q = out[out.length - 1];
      if (!q || Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps) out.push(p);
    }
    while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= eps && Math.abs(out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
    return out;
  }
  /** ear clipping -> [[i,j,k]] (indices into P), CCW output */
  function earClip(P) {
    var n = P.length;
    if (n < 3) return [];
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    if (area2(P) < 0) idx.reverse();
    var out = [], guard = 0;
    function inside(a, b, c, p) {
      var d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      var d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
      var d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
      return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
    }
    while (idx.length > 3 && guard++ < 5000) {
      var found = false;
      for (var k = 0; k < idx.length; k++) {
        var i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
        var a = P[i0], b = P[i1], c = P[i2];
        var cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (cr <= 1e-12) continue;
        var ok = true;
        for (var m = 0; m < idx.length; m++) {
          var j = idx[m];
          if (j === i0 || j === i1 || j === i2) continue;
          if (inside(a, b, c, P[j])) { ok = false; break; }
        }
        if (!ok) continue;
        out.push([i0, i1, i2]); idx.splice(k, 1); found = true; break;
      }
      if (!found) {   // degenerate / self-touching: drop the flattest vertex
        var best = 0, bv = Infinity;
        for (var q = 0; q < idx.length; q++) {
          var A = P[idx[(q + idx.length - 1) % idx.length]], B = P[idx[q]], C = P[idx[(q + 1) % idx.length]];
          var v = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
          if (v < bv) { bv = v; best = q; }
        }
        idx.splice(best, 1);
      }
    }
    if (idx.length === 3) {
      var a3 = P[idx[0]], b3 = P[idx[1]], c3 = P[idx[2]];
      if ((b3[0] - a3[0]) * (c3[1] - a3[1]) - (b3[1] - a3[1]) * (c3[0] - a3[0]) > 1e-12) out.push([idx[0], idx[1], idx[2]]);
    }
    return out;
  }
  /** split a simple CCW polygon into few convex CCW pieces (ear clipping + Hertel-Mehlhorn merge) */
  function convexParts(O) {
    var polys = earClip(O).map(function (t) { return t.slice(); });
    function convexAt(P, i) {
      var a = O[P[(i + P.length - 1) % P.length]], b = O[P[i]], c = O[P[(i + 1) % P.length]];
      return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= -1e-10;
    }
    var merged = true;
    while (merged) {
      merged = false;
      for (var i = 0; i < polys.length && !merged; i++) {
        for (var j = i + 1; j < polys.length && !merged; j++) {
          var A = polys[i], B = polys[j];
          for (var e = 0; e < A.length && !merged; e++) {
            var u = A[e], v = A[(e + 1) % A.length], k = B.indexOf(v);
            if (k < 0 || B[(k + 1) % B.length] !== u) continue;
            // union: A from v round to u, then B from u (exclusive) round to v (exclusive)
            var U = [], q = (e + 1) % A.length;
            for (var c = 0; c < A.length; c++) U.push(A[(q + c) % A.length]);
            var kb = (k + 1) % B.length;
            for (c = 1; c < B.length - 1; c++) U.push(B[(kb + c) % B.length]);
            var ok = true;
            for (c = 0; c < U.length; c++) if (!convexAt(U, c)) { ok = false; break; }
            if (ok) { polys[i] = U; polys.splice(j, 1); merged = true; }
          }
        }
      }
    }
    return polys.map(function (P) { return P.map(function (ix) { return O[ix]; }); });
  }
  /** clip a convex CCW polygon by a convex CCW polygon (Sutherland-Hodgman) */
  function clipConvex(subj, clip) {
    var out = subj;
    for (var e = 0; e < clip.length && out.length; e++) {
      var A = clip[e], B = clip[(e + 1) % clip.length], inp = out;
      out = [];
      var side = function (p) { return (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]); };
      for (var i = 0; i < inp.length; i++) {
        var P = inp[i], Q = inp[(i + 1) % inp.length], sp = side(P), sq = side(Q);
        if (sp >= 0) out.push(P);
        if ((sp >= 0) !== (sq >= 0)) { var t = sp / (sp - sq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
      }
    }
    return out;
  }
  /** Douglas-Peucker on a closed polyline, at most maxPts points */
  function simplifyClosed(P, tol, maxPts) {
    if (P.length <= 4) return P.slice();
    // start at the point farthest from the first one so the split is stable
    function dp(pts, a, b, keep) {
      var A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-9, best = -1, bd = 0;
      for (var i = a + 1; i < b; i++) {
        var d = Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L;
        if (d > bd) { bd = d; best = i; }
      }
      if (best >= 0 && bd > tol) { keep[best] = 1; dp(pts, a, best, keep); dp(pts, best, b, keep); }
    }
    var far = 0, fd = -1;
    for (var i = 1; i < P.length; i++) { var d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > fd) { fd = d; far = i; } }
    var pts = P.concat([P[0]]), keep = {}; keep[0] = 1; keep[far] = 1;
    dp(pts, 0, far, keep); dp(pts, far, P.length, keep);
    var out = [];
    for (i = 0; i < P.length; i++) if (keep[i]) out.push(P[i]);
    while (out.length > maxPts) {   // drop the vertex with the smallest triangle area
      var bi = 0, bv = Infinity;
      for (var k = 0; k < out.length; k++) {
        var A = out[(k + out.length - 1) % out.length], B = out[k], C = out[(k + 1) % out.length];
        var v = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
        if (v < bv) { bv = v; bi = k; }
      }
      out.splice(bi, 1);
    }
    return out;
  }

  /* ================================================================ geometry accumulator */
  function Acc() { this.p = []; this.n = []; this.c = []; this.i = []; }
  Acc.prototype.tri = function (a, b, c, col, hint) {
    var n = cross(sub(b, a), sub(c, a)), l = len(n);
    if (!(l > 1e-9)) return false;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (hint && dot(n, hint) < 0) { var t = b; b = c; c = t; n = [-n[0], -n[1], -n[2]]; }
    var k = this.p.length / 3, P = this.p, N = this.n, C = this.c;
    [a, b, c].forEach(function (v) { P.push(v[0], v[1], v[2]); N.push(n[0], n[1], n[2]); C.push(col[0], col[1], col[2], 1); });
    this.i.push(k, k + 1, k + 2);
    return true;
  };
  Acc.prototype.tris = function () { return this.i.length / 3; };
  /** planar-ish polygon (3D points): Newell normal, ear clipped in its plane, every triangle with the same normal */
  function polyNormal(pts) {
    var n = [0, 0, 0];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return n;
  }
  function emitPoly(acc, pts, col, hint) {
    if (pts.length < 3) return 0;
    var n = polyNormal(pts), l = len(n);
    if (!(l > 1e-10)) return 0;
    n = scl(n, 1 / l);
    if (hint && dot(n, hint) < 0) { pts = pts.slice().reverse(); n = scl(n, -1); }
    // 2D frame
    var ax = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0], u = norm(cross(ax, n)), v = cross(n, u);
    var P2 = pts.map(function (p) { return [dot(p, u), dot(p, v)]; });
    var T = earClip(P2), cnt = 0;
    var k0 = acc.p.length / 3;
    T.forEach(function (t) {
      var a = pts[t[0]], b = pts[t[1]], c = pts[t[2]];
      var k = acc.p.length / 3;
      // own face normal (a slightly non-planar polygon — e.g. a decal piece lifted along shared crease normals —
      // must still shade flat per triangle); the polygon normal only where the triangle is degenerate / folded
      var tn = cross(sub(b, a), sub(c, a)), tl = len(tn), fn = tl > 1e-12 && dot(tn, n) > 0 ? scl(tn, 1 / tl) : n;
      [a, b, c].forEach(function (q) { acc.p.push(q[0], q[1], q[2]); acc.n.push(fn[0], fn[1], fn[2]); acc.c.push(col[0], col[1], col[2], 1); });
      acc.i.push(k, k + 1, k + 2); cnt++;
    });
    void k0;
    return cnt;
  }

  /* ================================================================ ray casting on triangle lists */
  // tri record: {a, b, c, n}
  function rayTri(o, d, T) {
    var e1 = sub(T.b, T.a), e2 = sub(T.c, T.a), p = cross(d, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-12) return -1;
    var inv = 1 / det, s = sub(o, T.a), u = dot(s, p) * inv;
    if (u < -1e-7 || u > 1 + 1e-7) return -1;
    var q = cross(s, e1), v = dot(d, q) * inv;
    if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
    var t = dot(e2, q) * inv;
    return t > 1e-6 ? t : -1;
  }
  function castRay(tris, o, d) {
    var best = null, bt = Infinity;
    for (var i = 0; i < tris.length; i++) {
      var T = tris[i];
      var t = rayTri(o, d, T);
      if (t > 0 && t < bt) { bt = t; best = T; }
    }
    return best ? { t: bt, p: add(o, scl(d, bt)), tri: best } : null;
  }
  function triRec(a, b, c, mat) {
    var n = norm(cross(sub(b, a), sub(c, a)));
    return { a: a, b: b, c: c, n: n, mat: mat, lo: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])] };
  }

  /* ================================================================ views (projection of 2D outlines onto the shell) */
  // view -> ray direction, 2D->3D mapping (a, b, depth)
  var VIEWS = {
    front: { dir: [-1, 0, 0], to2: function (p) { return [p[2], p[1]]; }, at: function (a, b, d) { return [d, b, a]; } },
    rear: { dir: [1, 0, 0], to2: function (p) { return [p[2], p[1]]; }, at: function (a, b, d) { return [d, b, a]; } },
    side: { dir: [0, 0, -1], to2: function (p) { return [p[0], p[1]]; }, at: function (a, b, d) { return [a, b, d]; } },
    left: { dir: [0, 0, 1], to2: function (p) { return [p[0], p[1]]; }, at: function (a, b, d) { return [a, b, d]; } },
    top: { dir: [0, -1, 0], to2: function (p) { return [p[0], p[2]]; }, at: function (a, b, d) { return [a, d, b]; } }
  };
  var PROJ_COS = Math.cos(68 * DEG);
  /** project a 2D outline (view coordinates) onto the visible facets: planar pieces [{pts:[3D], n}] */
  function projectOutline(tris, view, outline, offset, cosMin) {
    if (cosMin == null) cosMin = PROJ_COS;
    var V = VIEWS[view];
    if (!V || !outline || outline.length < 3) return [];
    var O = dedupe(outline, 1e-5);
    if (O.length < 3) return [];
    if (area2(O) < 0) O = O.slice().reverse();
    var ST = convexParts(O);
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    O.forEach(function (p) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); });
    var far = 50, pieces = [];
    tris.forEach(function (T) {
      // facet must face the viewer within ~68 deg of the projection axis: a side outline must not smear onto the
      // tail / nose corner facets (faint stripes seen from straight behind), nor a front / rear one onto the flanks
      if (dot(T.n, V.dir) > -cosMin) return;
      var A = V.to2(T.a), B = V.to2(T.b), C = V.to2(T.c);
      if (Math.max(A[0], B[0], C[0]) < bb[0] || Math.min(A[0], B[0], C[0]) > bb[2] || Math.max(A[1], B[1], C[1]) < bb[1] || Math.min(A[1], B[1], C[1]) > bb[3]) return;
      var clipT = [A, B, C];
      var ar = area2(clipT);
      if (Math.abs(ar) < 1e-9) return;
      if (ar < 0) clipT = [A, C, B];
      ST.forEach(function (st) {
        var R = clipConvex(st, clipT);
        R = dedupe(R, 1e-7);
        if (R.length < 3 || Math.abs(area2(R)) < 2e-7) return;
        // visibility: the facet must be the first hit at the piece centroid
        var cx = 0, cy = 0;
        R.forEach(function (p) { cx += p[0]; cy += p[1]; });
        cx /= R.length; cy /= R.length;
        var o = V.at(cx, cy, 0), dI = V.dir;
        o = [o[0] - dI[0] * far, o[1] - dI[1] * far, o[2] - dI[2] * far];
        var hit = castRay(tris, o, dI);
        if (!hit || hit.tri !== T) {
          // allow coplanar neighbours (same plane within 2 mm)
          if (!hit || Math.abs(dot(sub(hit.p, T.a), T.n)) > 0.002) return;
        }
        // lift onto the facet plane (the offset is applied below, per shared vertex)
        var pts = R.map(function (p) {
          var q = V.at(p[0], p[1], 0), dd = V.dir, den = dot(T.n, dd);
          var o2 = [q[0] - dd[0] * far, q[1] - dd[1] * far, q[2] - dd[2] * far];
          var t = dot(sub(T.a, o2), T.n) / den;
          return add(o2, scl(dd, t));
        });
        pieces.push({ pts: pts, n: T.n.slice(), p2: R });
      });
    });
    // offset: a vertex shared by pieces on neighbouring facets (same view-plane point = same skin point) moves along
    // the MEAN of their normals, so the pieces stay joined across a crease. Offsetting each piece along its own
    // facet normal opened hairline cracks along every convex crease of a large decal (the paint showed through).
    var key = function (p) { return Math.round(p[0] * 2e4) + ',' + Math.round(p[1] * 2e4); }, nrm = {};
    pieces.forEach(function (pc) { pc.p2.forEach(function (p) { var k = key(p); nrm[k] = nrm[k] ? add(nrm[k], pc.n) : pc.n.slice(); }); });
    var cMin = {};
    Object.keys(nrm).forEach(function (k) { nrm[k] = norm(nrm[k]); cMin[k] = 1; });
    pieces.forEach(function (pc) { pc.p2.forEach(function (p) { var k = key(p); cMin[k] = Math.min(cMin[k], dot(nrm[k], pc.n)); }); });
    pieces.forEach(function (pc) {
      pc.pts = pc.pts.map(function (w, i) {
        var k = key(pc.p2[i]);
        return add(w, scl(nrm[k], offset / Math.max(cMin[k], 0.5)));   // >= offset clear of every facet sharing it
      });
      delete pc.p2;
    });
    return pieces;
  }

  /** opt-in alternative to projectOutline (part option maxTilt): instead of draping the outline over every facet
      it crosses — a lamp / grille straddling a bonnet or deck edge then lands on the first sloping facet and reads
      squashed from any other angle — emit it as ONE flat polygon with the exact outline seen from the view. Its plane
      leans like the skin under it (area-weighted normal of the draped pieces) but at most maxTilt (rad) away from
      facing the view, and sits just proud of the skin under every vertex / edge midpoint / the centre, so it is never
      hidden behind the sloping facet. Returns [] when nothing is hit (caller falls back to the default). */
  function planeDecal(tris, view, outline, offset, maxTilt) {
    var V = VIEWS[view];
    if (!V) return [];
    var pcs = projectOutline(tris, view, outline, 0);
    if (!pcs.length) pcs = projectOutline(tris, view, outline, 0, 0.03);
    if (!pcs.length) return [];
    var O = dedupe(outline, 1e-5), toV = scl(V.dir, -1), nA = [0, 0, 0];
    pcs.forEach(function (pc) { for (var k = 1; k < pc.pts.length - 1; k++) nA = add(nA, scl(pc.n, len(cross(sub(pc.pts[k], pc.pts[0]), sub(pc.pts[k + 1], pc.pts[0]))))); });
    nA = norm(nA);
    var c = dot(nA, toV), n = nA;
    if (!(c > Math.cos(maxTilt))) {
      var perp = sub(nA, scl(toV, c)), pl = len(perp);
      n = pl < 1e-6 ? toV : add(scl(toV, Math.cos(maxTilt)), scl(perp, Math.sin(maxTilt) / pl));
    }
    var far = 50, D = -Infinity, smp = O.slice(), cx = 0, cy = 0;
    O.forEach(function (p, k) { var q = O[(k + 1) % O.length]; smp.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]); cx += p[0]; cy += p[1]; });
    smp.push([cx / O.length, cy / O.length]);
    function from(p) { var o = V.at(p[0], p[1], 0); return [o[0] - V.dir[0] * far, o[1] - V.dir[1] * far, o[2] - V.dir[2] * far]; }
    smp.forEach(function (p) { var h = castRay(tris, from(p), V.dir); if (h) D = Math.max(D, dot(h.p, n)); });
    if (!isFinite(D)) return [];
    var den = dot(V.dir, n);
    if (Math.abs(den) < 1e-6) return [];
    var pts = O.map(function (p) { var o = from(p), t = (D + offset - dot(o, n)) / den; return add(o, scl(V.dir, t)); });
    return [{ pts: pts, n: n }];
  }

  /* ================================================================ shells */
  /** normalise a shell def: stations sorted front -> rear (x descending), mats rows aligned */
  function normShell(sh) {
    if (!sh || !Array.isArray(sh.stations) || sh.stations.length < 2) return null;
    var st = sh.stations.map(function (s, i) { return { x: +s.x, pts: s.pts.map(function (p) { return [+p[0], +p[1]]; }), i: i }; });
    var mats = sh.mats || [];
    var desc = st[0].x > st[st.length - 1].x;
    if (!desc) { st.reverse(); mats = mats.slice().reverse(); }
    return {
      stations: st.map(function (s) { return { x: s.x, pts: s.pts }; }), mats: mats,
      capF: sh.capF === undefined ? 'paint' : sh.capF, capR: sh.capR === undefined ? 'paint' : sh.capR,
      wells: sh.wells !== false, open: !!sh.open
    };
  }
  function matAt(mats, r, c, def) {
    var row = mats[clamp(r, 0, mats.length - 1)];
    if (!row) return def;
    var m = row[clamp(c, 0, row.length - 1)];
    return m == null ? def : m;
  }
  /** interpolate a station at x between the stations of a (descending) list */
  function stationAt(st, x) {
    if (x >= st[0].x) return st[0].pts.map(function (p) { return p.slice(); });
    for (var i = 0; i < st.length - 1; i++) {
      var a = st[i], b = st[i + 1];
      if (x <= a.x && x >= b.x) {
        var t = a.x === b.x ? 0 : (a.x - x) / (a.x - b.x);
        return a.pts.map(function (p, k) { return [lerp(p[0], b.pts[k][0], t), lerp(p[1], b.pts[k][1], t)]; });
      }
    }
    return st[st.length - 1].pts.map(function (p) { return p.slice(); });
  }
  function rowOf(st, x) {
    for (var i = 0; i < st.length - 1; i++) if (x <= st[i].x + 1e-9 && x >= st[i + 1].x - 1e-9) return i;
    return x > st[0].x ? 0 : st.length - 2;
  }
  /** insert arch stations + carve wheel wells. arches: [{x, cy, r, zIn}] (fitted). Returns {grid, rowOfInterval, clamped}. */
  function wellGrid(st, arches, K) {
    var list = [], i;
    st.forEach(function (s, k) { list.push({ x: s.x, pts: s.pts.map(function (p) { return p.slice(); }), ph: 0, auth: true, end: k === 0 || k === st.length - 1 }); });
    var x0 = st[0].x, x1 = st[st.length - 1].x;
    arches.forEach(function (A) {
      // arch vertices become stations; a vertex within 3 cm of an authored interior station snaps onto it (the
      // authored ring is kept exactly — no slivers, no lost creases — and every inserted ring stays a pure
      // interpolation of the authored rings above the arch, which lets emitShell skip them there)
      var ov = K > 2 ? 0.3 : 0;   // the arch wraps a little below the axle line (tighter opening round the tyre)
      var used = [];
      for (var k = 0; k <= K; k++) {
        var th = -ov + (PI + 2 * ov) * k / K, x = A.x + A.r * Math.cos(th), y = A.cy + A.r * Math.sin(th);
        if (x >= x0 - 1e-6 || x <= x1 + 1e-6) continue;
        var D = null, bd = 0.03;
        list.forEach(function (s) { if (s.auth && !s.end && used.indexOf(s) < 0 && Math.abs(s.x - x) < bd) { bd = Math.abs(s.x - x); D = s; } });
        if (D) {
          used.push(D);
          var ddx = D.x - A.x;
          if (k > 0 && k < K && Math.abs(ddx) < A.r) y = A.cy + (Math.sin(th) < 0 ? -1 : 1) * Math.sqrt(A.r * A.r - ddx * ddx);
          x = D.x;
        }
        var E = k === 0 || k === K;
        if (D && !E) { D.well = y; D.A = A; continue; }
        if (D) {   // arch end on an authored ring: the authored ring is the open side, a clamped copy closes the well
          D.well = null;
          D.ph = k === 0 ? 0 : 1;
          list.push({ x: x, ph: k === 0 ? 1 : 0, well: y, A: A, pts: D.pts.map(function (p) { return p.slice(); }) });
          continue;
        }
        if (k === 0) { list.push({ x: x, ph: 0, well: null, A: A, pts: stationAt(st, x) }); list.push({ x: x, ph: 1, well: y, A: A, pts: stationAt(st, x) }); }
        else if (k === K) { list.push({ x: x, ph: 0, well: y, A: A, pts: stationAt(st, x) }); list.push({ x: x, ph: 1, well: null, A: A, pts: stationAt(st, x) }); }
        else list.push({ x: x, ph: 0, well: y, A: A, pts: stationAt(st, x) });
      }
    });
    list.sort(function (a, b) { return b.x - a.x || a.ph - b.ph; });
    // well height of authored stations inside an arch
    list.forEach(function (s) {
      if (s.well !== undefined) return;
      s.well = null;
      arches.forEach(function (A) {
        var dx = s.x - A.x;
        if (Math.abs(dx) < A.r * (K > 2 ? Math.cos(0.3) : 1) - 1e-6) { s.well = A.cy + Math.sqrt(A.r * A.r - dx * dx); s.A = A; }
      });
    });
    // build rings: [P0, W1, W2, P1'...]
    var grid = [], clampF = [];
    list.forEach(function (s) {
      var P = s.pts, P0 = P[0], P1 = P[1], n = P.length;
      var A = s.A || arches[0] || { zIn: 0.5 };
      var zW = Math.min(A.zIn, P1[1] - 0.002);
      if (zW < 0) zW = P1[1] * 0.6;
      var tW = P1[1] > 1e-6 ? clamp(zW / P1[1], 0, 1) : 0;
      var W1 = [lerp(P0[0], P1[0], tW), zW];
      var ring = [P0.slice(), W1], cl = [false, false];
      var topY = -Infinity;
      for (i = 0; i < n; i++) topY = Math.max(topY, P[i][0]);
      var yW = s.well == null ? null : clamp(s.well, P0[0], topY - 0.04);
      if (yW != null && yW > W1[0] + 1e-4) { ring.push([yW, zW]); cl.push(true); }
      else { ring.push(W1.slice()); cl.push(false); yW = null; }
      for (i = 1; i < n; i++) {
        var p = P[i];
        if (yW != null && p[0] < yW && p[1] > zW - 1e-4) { ring.push([yW, p[1]]); cl.push(true); }
        else { ring.push(p.slice()); cl.push(false); }
      }
      grid.push({ x: s.x, pts: ring, well: yW, auth: s.auth, A: s.A || null });
      clampF.push(cl);
    });
    // inserted (non-authored) rings only matter up to the highest clamped point of their arch: above it they are
    // exact interpolations of the authored rings, so emitShell spans those quads straight between authored rings
    // (collinear T-junctions, no cracks) — the arch costs triangles only where it actually cuts the body.
    arches.forEach(function (A) {
      var top = 2;
      grid.forEach(function (g, gi) { if (g.A === A) clampF[gi].forEach(function (c, j) { if (c && j > top) top = j; }); });
      grid.forEach(function (g) { if (g.A === A && !g.auth) g.lim = top + 1; });
    });
    return { grid: grid, clamped: clampF };
  }
  /** emit a mirrored shell. grid: [{x, pts:[[y,z]]}] descending x; matFn(i, j, quad) -> mat key */
  function emitShell(B, grid, matFn, o) {
    o = o || {};
    var S2 = grid.length, n = grid[0].pts.length, i, j;
    function P(i2, j2) { var q = grid[i2].pts[j2]; return [grid[i2].x, q[0], q[1]]; }
    // rows with a .lim only take part in the columns below it (see wellGrid); each column strings its active rows
    var rowsFor = [];
    for (j = 0; j < n - 1; j++) {
      var R = [];
      for (i = 0; i < S2; i++) if (i === 0 || i === S2 - 1 || grid[i].lim == null || j < grid[i].lim) R.push(i);
      rowsFor.push(R);
    }
    for (j = 0; j < n - 1; j++) {
      var RJ = rowsFor[j];
      for (var ri = 0; ri < RJ.length - 1; ri++) {
        i = RJ[ri];
        var i2 = RJ[ri + 1];
        var A = P(i, j), Bq = P(i2, j), C = P(i2, j + 1), D = P(i, j + 1);
        var mat = matFn(i, j, [A, Bq, C, D], i2);
        if (!mat) continue;
        var jit = 1 + (hash(i * 131 + j * 17 + (o.seed || 0)) - 0.5) * (o.jitter == null ? 0.07 : o.jitter);
        // shorter diagonal
        var t1, t2;
        if (len(sub(A, C)) <= len(sub(Bq, D))) { t1 = [A, D, C]; t2 = [A, C, Bq]; } else { t1 = [A, D, Bq]; t2 = [D, C, Bq]; }
        [t1, t2].forEach(function (t) {
          B.face(mat, t[0], t[1], t[2], jit, null);
          B.face(mat, [t[0][0], t[0][1], -t[0][2]], [t[2][0], t[2][1], -t[2][2]], [t[1][0], t[1][1], -t[1][2]], jit, null);
        });
      }
    }
    // caps
    [[0, o.capF, [1, 0, 0]], [S2 - 1, o.capR, [-1, 0, 0]]].forEach(function (cp) {
      if (!cp[1]) return;
      var r = grid[cp[0]], pts = [];
      for (j = 0; j < n; j++) pts.push([r.pts[j][1], r.pts[j][0]]);
      for (j = n - 2; j >= 1; j--) pts.push([-r.pts[j][1], r.pts[j][0]]);
      if (!o.closedBottom && r.pts[0][1] > 1e-4) pts.push([-r.pts[0][1], r.pts[0][0]]);
      pts = dedupe(pts, 1e-5);
      if (pts.length < 3 || Math.abs(area2(pts)) < 1e-6) return;
      B.poly(cp[1], pts.map(function (q) { return [r.x, q[1], q[0]]; }), cp[2], 1, true);
    });
  }

  /* ================================================================ builder (buckets + colours) */
  function Builder(colors) {
    this.acc = {}; this.colors = colors; this.cast = [];
  }
  Builder.prototype.bucketOf = function (mat) { var m = this.colors.resolve(mat); return m; };
  Builder.prototype.get = function (b) { return this.acc[b] || (this.acc[b] = new Acc()); };
  Builder.prototype.face = function (mat, a, b, c, jit, hint) {
    var R = this.colors.resolve(mat);
    if (!R) return;
    var col = jit && jit !== 1 ? [R.c[0] * jit, R.c[1] * jit, R.c[2] * jit] : R.c;
    if (this.get(R.b).tri(a, b, c, col, hint) && this.recordCast && a[2] >= -1e-6 && b[2] >= -1e-6 && c[2] >= -1e-6) {
      // (cast list holds the faces actually emitted; hint orientation already applied by Acc)
      var A = this.get(R.b), k = A.p.length - 9;
      this.cast.push(triRec([A.p[k], A.p[k + 1], A.p[k + 2]], [A.p[k + 3], A.p[k + 4], A.p[k + 5]], [A.p[k + 6], A.p[k + 7], A.p[k + 8]], mat));
    }
  };
  Builder.prototype.poly = function (mat, pts, hint, jit, record) {
    var R = this.colors.resolve(mat);
    if (!R) return 0;
    var col = jit && jit !== 1 ? [R.c[0] * jit, R.c[1] * jit, R.c[2] * jit] : R.c;
    var A = this.get(R.b), k0 = A.p.length;
    var n = emitPoly(A, pts, col, hint);
    if (record && this.recordCast) {   // shell caps take part in the ray casts too (right half)
      for (var k = k0; k < A.p.length; k += 9) {
        var a = [A.p[k], A.p[k + 1], A.p[k + 2]], b = [A.p[k + 3], A.p[k + 4], A.p[k + 5]], c = [A.p[k + 6], A.p[k + 7], A.p[k + 8]];
        if (a[2] >= -1e-6 || b[2] >= -1e-6 || c[2] >= -1e-6) this.cast.push(triRec(a, b, c, mat));
      }
    }
    return n;
  };

  /* ================================================================ part primitives */
  function boxPts(c, s, rotY) {
    var hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2, cr = Math.cos(rotY || 0), sr = Math.sin(rotY || 0);
    function P(x, y, z) { return [c[0] + x * cr + z * sr, c[1] + y, c[2] - x * sr + z * cr]; }
    var v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    return [[v[1], v[2], v[6], v[5]], [v[0], v[4], v[7], v[3]], [v[3], v[7], v[6], v[2]], [v[0], v[1], v[5], v[4]], [v[4], v[5], v[6], v[7]], [v[0], v[3], v[2], v[1]]];
  }
  function emitBox(B, mat, c, s, rotY) {
    var faces = boxPts(c, s, rotY), ctr = c;
    faces.forEach(function (f) {
      var m = scl(add(add(f[0], f[1]), add(f[2], f[3])), 0.25);
      B.poly(mat, f, sub(m, ctr));
    });
  }
  /** extrude a 2D polygon along an axis: axis 'z' pts (x,y) from z0..z1; 'y' pts (x,z) y0..y1; 'x' pts (z,y) */
  function emitPrism(B, mat, pts2d, a0, a1, axis, matSide) {
    var P = dedupe(pts2d.map(function (p) { return [+p[0], +p[1]]; }), 1e-6);
    if (P.length < 3) return;
    if (area2(P) < 0) P = P.slice().reverse();
    axis = axis || 'z';
    function to3(p, a) { return axis === 'z' ? [p[0], p[1], a] : axis === 'y' ? [p[0], a, p[1]] : [a, p[1], p[0]]; }
    var lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    var ax = axis === 'z' ? [0, 0, 1] : axis === 'y' ? [0, 1, 0] : [1, 0, 0];
    B.poly(mat, P.map(function (p) { return to3(p, hi); }), ax);
    B.poly(mat, P.map(function (p) { return to3(p, lo); }), scl(ax, -1));
    var cx = 0, cy = 0;
    P.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= P.length; cy /= P.length;
    var cm = (lo + hi) / 2;
    for (var i = 0; i < P.length; i++) {
      var p = P[i], q = P[(i + 1) % P.length];
      var f = [to3(p, lo), to3(q, lo), to3(q, hi), to3(p, hi)];
      var m = to3([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], cm), c3 = to3([cx, cy], cm);
      B.poly(matSide || mat, f, sub(m, c3));
    }
  }
  /** n-gon cylinder along x / y / z */
  function emitCyl(B, mat, c, r, ry, l, axis, sides, matCap) {
    sides = sides || 8;
    var P = [];
    for (var i = 0; i < sides; i++) { var a = (i + 0.5) / sides * TAU; P.push([Math.cos(a) * r, Math.sin(a) * (ry || r)]); }
    var pts = P.map(function (p) { return axis === 'x' ? [c[2] + p[0], c[1] + p[1]] : axis === 'y' ? [c[0] + p[0], c[2] + p[1]] : [c[0] + p[0], c[1] + p[1]]; });
    var a0 = (axis === 'x' ? c[0] : axis === 'y' ? c[1] : c[2]) - l / 2, a1 = a0 + l;
    if (matCap) {
      emitPrism(B, mat, pts, a0, a1, axis);
    } else emitPrism(B, mat, pts, a0, a1, axis);
  }

  /* ================================================================ wheels (wheel-local: axle = z, outer face +z) */
  var WHEEL_STYLE = { y: 'star', monoblock: 'star', centerlock: 'star', star: 'star', split: 'split', mesh: 'mesh', turbine: 'turbine', dish: 'dish', 'aero-disc': 'disc', disc: 'disc' };
  function wheelGeo(W, o) {
    // W: {r, rim, tw}; o: {style, spokes, sides, finish, caliper, low}
    var R = W.r, rr = Math.min(W.rim, R - 0.035), w = W.tw, N = o.sides || 14, hw = w / 2;
    // the rim face reaches a little over the bead (as the lip and the tyre's rim protector do on the real wheel):
    // flat-shaded sidewalls otherwise read thicker than they are. Taller profiles (sidewall / width) get more.
    if (!o.low) { var asp = (R - rr) / Math.max(0.1, w); rr = Math.min(R - 0.04, rr + (R - rr) * clamp(0.08 + asp * 0.3, 0.12, 0.26)); }
    var tyre = new Acc(), rim = new Acc(), cal = new Acc();
    var tc = PAL.tyre, tc2 = [PAL.tyre[0] * 1.35, PAL.tyre[1] * 1.35, PAL.tyre[2] * 1.35];
    // tyre profile (radius, z) from outer sidewall round to inner sidewall
    // outer sidewall, outer shoulder chamfer, tread, inner sidewall (the inner shoulder is merged: it only shows
    // from under the car) -> 4 bands x 12 sides = 96 triangles
    var prof = [[rr + 0.012, hw * 0.9], [R - 0.028, hw], [R, hw * 0.72], [R, -hw * 0.72], [rr + 0.012, -hw * 0.9]];
    var cols = [tc2, tc, tc, tc2];
    if (o.low) { prof = [[rr, hw], [R, hw * 0.8], [R, -hw * 0.8]]; cols = [tc2, tc]; }
    var a, k, s;
    function ring(rad, z, ang) { return [Math.cos(ang) * rad, Math.sin(ang) * rad, z]; }
    for (k = 0; k < N; k++) {
      var a0 = k / N * TAU, a1 = (k + 1) / N * TAU;
      for (s = 0; s < prof.length - 1; s++) {
        var p = prof[s], q = prof[s + 1];
        var A = ring(p[0], p[1], a0), Bv = ring(q[0], q[1], a0), C = ring(q[0], q[1], a1), D = ring(p[0], p[1], a1);
        var mid = (a0 + a1) / 2, out = [Math.cos(mid) * (q[1] === p[1] ? 0 : 1), Math.sin(mid) * (q[1] === p[1] ? 0 : 1), 0];
        // outward hint: away from the tyre's centre torus line
        var cM = scl(add(add(A, Bv), add(C, D)), 0.25), hint = sub(cM, [Math.cos(mid) * (rr + R) / 2, Math.sin(mid) * (rr + R) / 2, 0]);
        void out;
        var jit = 1 + (hash(k * 7 + s) - 0.5) * 0.12, col = [cols[s][0] * jit, cols[s][1] * jit, cols[s][2] * jit];
        tyre.tri(A, Bv, C, col, hint); tyre.tri(A, C, D, col, hint);
      }
    }
    var fin = o.finish || [0.5, 0.5, 0.52], dark = [fin[0] * 0.35 + 0.004, fin[1] * 0.35 + 0.004, fin[2] * 0.35 + 0.004];
    var zr = hw * 0.9 - 0.012, back = [0.012, 0.012, 0.013];
    if (o.low) {
      // flat disc face only
      var pts = [];
      for (k = 0; k < N; k++) pts.push(ring(rr, hw + 0.002, (k + 0.5) / N * TAU));
      emitPoly(rim, pts, fin, [0, 0, 1]);
      return { tyre: tyre, rim: rim, cal: null };
    }
    var style = WHEEL_STYLE[o.style] || 'star', nS = clamp(o.spokes | 0 || 5, 3, 12);
    var lipIn = style === 'dish' ? rr * 0.8 : rr * 0.9, depth = style === 'dish' ? 0.07 : 0.03;
    // lip ring (annulus) at zr, barrel down to the back plate
    for (k = 0; k < N; k++) {
      var b0 = k / N * TAU, b1 = (k + 1) / N * TAU;
      var L0 = ring(rr, zr, b0), L1 = ring(rr, zr, b1), I0 = ring(lipIn, zr, b0), I1 = ring(lipIn, zr, b1);
      emitPoly(rim, [L0, L1, I1, I0], fin, [0, 0, 1]);
      var Z0 = ring(lipIn, zr - depth - 0.05, b0), Z1 = ring(lipIn, zr - depth - 0.05, b1);
      emitPoly(rim, [I0, I1, Z1, Z0], dark, [-Math.cos((b0 + b1) / 2), -Math.sin((b0 + b1) / 2), 0]);
    }
    // back plate (brake disc look; the hub hides its centre)
    var bp = [];
    for (k = 0; k < N; k++) { bp.push(ring(lipIn, zr - depth - 0.05, (k + 0.5) / N * TAU)); }
    emitPoly(rim, bp, PAL.disc, [0, 0, 1]);
    var zs = zr - (style === 'dish' ? depth : 0.012), hubR = rr * (style === 'disc' ? 0.2 : 0.26);
    function spoke(angA, angB, r0, r1, wA, wB, z0, z1, flat) {
      // ridged spoke: two facets meeting on the centre line (z0 at the hub, z1 at the lip), outer edges sunk by dz,
      // so it reads as a solid blade from every angle with 4 triangles (2 when flat: thin mesh spokes)
      var dA = [Math.cos(angA), Math.sin(angA)], dB = [Math.cos(angB), Math.sin(angB)];
      var nA = [-dA[1], dA[0]], nB = [-dB[1], dB[0]], dz = flat ? 0 : 0.018;
      var c0 = [dA[0] * r0, dA[1] * r0, z0], c1 = [dB[0] * r1, dB[1] * r1, z1];
      var l0 = [c0[0] - nA[0] * wA / 2, c0[1] - nA[1] * wA / 2, z0 - dz], l1 = [c1[0] - nB[0] * wB / 2, c1[1] - nB[1] * wB / 2, z1 - dz];
      var q0 = [c0[0] + nA[0] * wA / 2, c0[1] + nA[1] * wA / 2, z0 - dz], q1 = [c1[0] + nB[0] * wB / 2, c1[1] + nB[1] * wB / 2, z1 - dz];
      var up = [0, 0, 1], lit = [fin[0] * 1.12, fin[1] * 1.12, fin[2] * 1.12];
      if (flat) { rim.tri(l0, l1, q1, fin, up); rim.tri(l0, q1, q0, fin, up); return; }
      rim.tri(l0, l1, c1, fin, up); rim.tri(l0, c1, c0, fin, up);
      rim.tri(c0, c1, q1, lit, up); rim.tri(c0, q1, q0, lit, up);
    }
    if (style === 'disc') {
      var dp = [];
      for (k = 0; k < N; k++) dp.push(ring(lipIn + 0.002, zr - 0.006, (k + 0.5) / N * TAU));
      emitPoly(rim, dp, fin, [0, 0, 1]);
      for (k = 0; k < nS; k++) {   // dark slots
        var sa = k / nS * TAU, sw = 0.035;
        var c0 = [Math.cos(sa), Math.sin(sa)], cn = [-c0[1], c0[0]];
        var r0 = rr * 0.48, r1 = rr * 0.74;
        emitPoly(rim, [[c0[0] * r0 - cn[0] * sw, c0[1] * r0 - cn[1] * sw, zr - 0.004], [c0[0] * r1 - cn[0] * sw * 1.5, c0[1] * r1 - cn[1] * sw * 1.5, zr - 0.004],
          [c0[0] * r1 + cn[0] * sw * 1.5, c0[1] * r1 + cn[1] * sw * 1.5, zr - 0.004], [c0[0] * r0 + cn[0] * sw, c0[1] * r0 + cn[1] * sw, zr - 0.004]], back, [0, 0, 1]);
      }
    } else {
      var rIn = hubR * 0.9, rOut = lipIn + 0.004;
      for (k = 0; k < nS; k++) {
        var ang = k / nS * TAU + PI / 2;
        if (style === 'star') {
          if (o.split) {   // Y spoke: a V of two blades meeting at the hub
            spoke(ang, ang - 0.12, rIn, rOut, rr * 0.17, rr * 0.12, zs + 0.004, zs - 0.006);
            spoke(ang, ang + 0.12, rIn, rOut, rr * 0.17, rr * 0.12, zs + 0.004, zs - 0.006);
          } else spoke(ang, ang, rIn, rOut, rr * 0.24, rr * 0.16, zs + 0.004, zs - 0.006);
        } else if (style === 'dish') spoke(ang, ang, rIn, rOut, rr * 0.21, rr * 0.14, zs + 0.004, zs);
        else if (style === 'split') {
          spoke(ang - 0.07, ang - 0.105, rIn, rOut, rr * 0.14, rr * 0.11, zs + 0.004, zs - 0.006);
          spoke(ang + 0.07, ang + 0.105, rIn, rOut, rr * 0.14, rr * 0.11, zs + 0.004, zs - 0.006);
        } else if (style === 'mesh') {
          spoke(ang, ang + 0.35, rIn, rOut, rr * 0.075, rr * 0.062, zs + 0.002, zs - 0.004, true);
          spoke(ang, ang - 0.35, rIn, rOut, rr * 0.075, rr * 0.062, zs + 0.002, zs - 0.004, true);
        } else if (style === 'turbine') spoke(ang, ang + 0.5, rIn, rOut, rr * 0.1, rr * 0.2, zs + 0.004, zs - 0.004);
      }
    }
    // hub + centre cap
    var hub = [], cap = [];
    for (k = 0; k < 6; k++) { a = (k + 0.5) / 6 * TAU; hub.push([Math.cos(a) * hubR, Math.sin(a) * hubR, zs + 0.008]); }
    emitPoly(rim, hub, fin, [0, 0, 1]);
    for (k = 0; k < 6; k++) { a = (k + 0.5) / 6 * TAU; cap.push([Math.cos(a) * hubR * 0.45, Math.sin(a) * hubR * 0.45, zs + 0.012]); }
    emitPoly(rim, cap, dark, [0, 0, 1]);
    // caliper: box at the rear-top of the disc (wheel-local, not spinning)
    if (o.caliper) {
      var ca = o.front ? 150 * DEG : 30 * DEG, cr2 = lipIn * 0.82, cc = [Math.cos(ca) * cr2, Math.sin(ca) * cr2, zr - depth - 0.03];
      var B2 = { poly: function (m, pts, hint) { return emitPoly(cal, pts, o.caliper, hint); } };
      var faces = boxPts([0, 0, 0], [0.07, lipIn * 0.55, 0.05], 0);
      var rot = ca - PI / 2, c3 = Math.cos(rot), s3 = Math.sin(rot);
      faces.forEach(function (f) {
        var g = f.map(function (p) { return [cc[0] + p[0] * c3 - p[1] * s3, cc[1] + p[0] * s3 + p[1] * c3, cc[2] + p[2]]; });
        var m = scl(add(add(g[0], g[1]), add(g[2], g[3])), 0.25);
        B2.poly(null, g, sub(m, cc));
      });
    }
    return { tyre: tyre, rim: rim, cal: cal };
  }
  function mirrorAcc(src) {
    var o = new Acc();
    for (var i = 0; i < src.p.length; i += 3) { o.p.push(src.p[i], src.p[i + 1], -src.p[i + 2]); o.n.push(src.n[i], src.n[i + 1], -src.n[i + 2]); }
    o.c = src.c.slice();
    for (i = 0; i < src.i.length; i += 3) o.i.push(src.i[i], src.i[i + 2], src.i[i + 1]);
    return o;
  }
  function translateAcc(src, dx, dy, dz) {
    var o = new Acc();
    for (var i = 0; i < src.p.length; i += 3) o.p.push(src.p[i] + dx, src.p[i + 1] + dy, src.p[i + 2] + dz);
    o.n = src.n.slice(); o.c = src.c.slice(); o.i = src.i.slice();
    return o;
  }
  function appendAcc(dst, src) {
    var base = dst.p.length / 3;
    for (var i = 0; i < src.p.length; i++) { dst.p.push(src.p[i]); dst.n.push(src.n[i]); }
    for (i = 0; i < src.c.length; i++) dst.c.push(src.c[i]);
    for (i = 0; i < src.i.length; i++) dst.i.push(base + src.i[i]);
    return dst;
  }

  /* ================================================================ registry + validation */
  var defs = {}, compiled = {}, autoCache = {}, errorsById = {};
  function validate(def) {
    var errs = [];
    if (!def || typeof def !== 'object') return { ok: false, errors: ['def must be an object'] };
    function shell(name, sh, req) {
      if (!sh) { if (req) errs.push(name + ': missing'); return; }
      if (!Array.isArray(sh.stations) || sh.stations.length < 2) { errs.push(name + '.stations: need >= 2'); return; }
      var n = -1;
      sh.stations.forEach(function (s, i) {
        if (!s || !isFinite(+s.x)) errs.push(name + '.stations[' + i + '].x not a number');
        if (!s || !Array.isArray(s.pts) || s.pts.length < 3) { errs.push(name + '.stations[' + i + '].pts: need >= 3'); return; }
        if (n < 0) n = s.pts.length;
        else if (s.pts.length !== n) errs.push(name + '.stations[' + i + '] has ' + s.pts.length + ' pts, expected ' + n);
        s.pts.forEach(function (p, k) { if (!Array.isArray(p) || !isFinite(+p[0]) || !isFinite(+p[1])) errs.push(name + '.stations[' + i + '].pts[' + k + '] bad'); else if (+p[1] < -1e-6) errs.push(name + '.stations[' + i + '].pts[' + k + '] z < 0 (half rings are the right side, z >= 0)'); });
      });
      var xs = sh.stations.map(function (s) { return +s.x; });
      for (var i = 1; i < xs.length; i++) if ((xs[i] - xs[i - 1]) * (xs[1] - xs[0]) < 0) { errs.push(name + '.stations: x must be monotonic'); break; }
      if (sh.mats) {
        if (!Array.isArray(sh.mats) || sh.mats.length !== sh.stations.length - 1) errs.push(name + '.mats: need ' + (sh.stations.length - 1) + ' rows (stations - 1), got ' + (sh.mats && sh.mats.length));
        else sh.mats.forEach(function (row, r) {
          if (!Array.isArray(row) || row.length !== n - 1) errs.push(name + '.mats[' + r + ']: need ' + (n - 1) + ' cols (pts - 1), got ' + (row && row.length));
          else row.forEach(function (m) { if (m !== null && MATS.indexOf(m) < 0) errs.push(name + '.mats[' + r + ']: unknown material ' + m); });
        });
      }
    }
    shell('body', def.body, true);
    shell('cabin', def.cabin, false);
    if (def.exhaust != null) {
      if (!Array.isArray(def.exhaust)) errs.push('exhaust must be an array of {cx, cy, w?, h?, shape?, mirror?}');
      else def.exhaust.forEach(function (t, i) { if (!t || !isFinite(+t.cx) || !isFinite(+t.cy)) errs.push('exhaust[' + i + ']: cx / cy required'); });
    }
    (def.parts || []).forEach(function (p, i) {
      if (!p || ['poly', 'box', 'prism', 'cyl', 'mirrorAuto'].indexOf(p.t) < 0) { errs.push('parts[' + i + ']: unknown type ' + (p && p.t)); return; }
      if (p.mat && MATS.indexOf(p.mat) < 0) errs.push('parts[' + i + ']: unknown material ' + p.mat);
      if (p.t === 'poly') {
        if (p.view && !VIEWS[p.view]) errs.push('parts[' + i + ']: unknown view ' + p.view);
        var pts = p.pts || p.pts2d;
        if (!Array.isArray(pts) || pts.length < 3) errs.push('parts[' + i + ']: poly needs >= 3 pts');
        else pts.forEach(function (q) { if (!Array.isArray(q) || q.length < (p.view ? 2 : 3) || !q.every(function (v) { return isFinite(+v); })) errs.push('parts[' + i + ']: bad point'); });
      } else if (p.t === 'box') {
        if (!Array.isArray(p.c) || p.c.length !== 3 || !Array.isArray(p.s) || p.s.length !== 3) errs.push('parts[' + i + ']: box needs c[3], s[3]');
      } else if (p.t === 'prism') {
        if (!Array.isArray(p.pts2d) || p.pts2d.length < 3 || !isFinite(+p.z0) || !isFinite(+p.z1)) errs.push('parts[' + i + ']: prism needs pts2d, z0, z1');
      } else if (p.t === 'cyl') {
        if (!Array.isArray(p.c) || !isFinite(+p.r) || !isFinite(+p.l)) errs.push('parts[' + i + ']: cyl needs c, r, l');
      }
    });
    return { ok: errs.length === 0, errors: errs };
  }
  function register(id, def) {
    var v = validate(def);
    errorsById[id] = v.errors;
    if (!v.ok) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[lowpoly] ' + id + ' rejected:\n  ' + v.errors.slice(0, 12).join('\n  '));
      return v;
    }
    defs[id] = def;
    delete compiled[id];
    return v;
  }

  /* ================================================================ shapes access */
  function shapeLib() { var SH = CB.shapes; return SH && typeof SH.fit === 'function' && SH.models ? SH : null; }
  function modelOf(build, opts) {
    var SH = shapeLib();
    if (!SH) return null;
    opts = opts || {};
    if (opts.model && SH.models[opts.model]) return SH.models[opts.model];
    var body = (build && build.body) || {}, style = String(body.style || opts.bodyStyle || 'coupe');
    var m = body.model && SH.models[body.model];
    if (m && m.style === style) return m;
    if (!body.model && opts.isPlayer === false && (opts.id != null || opts.number != null) && SH.modelsByStyle) {
      var list = SH.modelsByStyle(style) || [], s = String(opts.id != null ? opts.id : opts.number), h = 0;
      for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
      if (list.length) return list[h % list.length];
    }
    return SH.getModel ? SH.getModel({ body: { style: style } }) : null;
  }
  function itemsOf(SH, slot) { try { return SH.items(slot || null).filter(function (i) { return i && i.path; }); } catch (e) { return []; } }
  function outlinesOf(SH, slot, tol, maxPts) {
    var out = [];
    itemsOf(SH, slot).forEach(function (it) {
      var path = SH.toPath ? SH.toPath(it.path) : it.path;
      if (!path) return;
      (SH.flatten(path, 6) || []).forEach(function (pl) {
        var P = dedupe(pl.pts.map(function (p) { return [p[0], p[1]]; }), 1e-5);
        if (P.length >= 3 && Math.abs(area2(P)) > 1e-5) out.push({ pts: simplifyClosed(P, tol || 0.006, maxPts || 14), paint: it.paint });
      });
    });
    return out;
  }
  function boundsOf(SH, slot) {
    var it = itemsOf(SH, slot);
    if (!it.length) return null;
    var b = SH.bounds(it.map(function (i) { return i.path; }));
    return b && !b.empty && isFinite(b.minX) ? b : null;
  }

  /* ================================================================ auto low-poly def (from CB.shapes, ref coords) */
  function halfOf(ring) { var H = ring.length >> 1; return ring.slice(0, H + 1).map(function (q) { return [q[0], Math.max(0, q[1])]; }); }
  function sideAt(H, y) {   // max z of the half ring polyline crossing height y
    var best = null;
    for (var i = 0; i < H.length - 1; i++) {
      var a = H[i], b = H[i + 1];
      if ((a[0] - y) * (b[0] - y) > 0 || a[0] === b[0]) { if (a[0] === y && (best === null || a[1] > best)) best = a[1]; continue; }
      var t = (y - a[0]) / (b[0] - a[0]), z = lerp(a[1], b[1], t);
      if (best === null || z > best) best = z;
    }
    return best;
  }
  function topAtZ(H, z) {
    var best = null;
    for (var i = 0; i < H.length - 1; i++) {
      var a = H[i], b = H[i + 1];
      if ((a[1] - z) * (b[1] - z) > 0 || a[1] === b[1]) continue;
      var t = (z - a[1]) / (b[1] - a[1]), y = lerp(a[0], b[0], t);
      if (best === null || y > best) best = y;
    }
    return best;
  }
  var AUTO_N = 9;
  function sampleHalf(sec, beltG, ghb) {
    var H = halfOf(sec.ring), N = sec.ring.length, Hn = N >> 1;
    var yb = Infinity, yc = H[Hn][0], ymax = -Infinity, zmax = 0, ki = 0, i;
    for (i = 0; i <= Hn; i++) { if (H[i][0] > ymax) { ymax = H[i][0]; ki = i; } zmax = Math.max(zmax, H[i][1]); yb = Math.min(yb, H[i][0]); }
    var h = Math.max(0.05, ymax - yb);
    var yB = null;
    if (sec.glass) {
      var gy = Infinity;
      for (i = 0; i <= Hn; i++) if (sec.glass[i] && H[i][1] > zmax * 0.25) gy = Math.min(gy, H[i][0]);
      if (isFinite(gy)) yB = gy;
    }
    if (yB === null && sec.belt != null && isFinite(sec.belt)) yB = sec.belt;
    if (yB === null) yB = beltG;
    yB = clamp(yB, yb + 0.35 * h, ymax - 0.03);
    function sd(y) { var z = sideAt(H, y); return z === null ? zmax * 0.5 : z; }
    var P = [];
    P.push([yb, 0]);
    var y1 = yb + 0.03 * h; P.push([y1, sd(y1)]);
    var y2 = yb + 0.3 * (yB - yb); P.push([y2, sd(y2)]);
    var y3 = yb + 0.68 * (yB - yb); P.push([y3, sd(y3)]);
    P.push([yB, sd(yB)]);
    var y5 = yB + 0.45 * (ymax - yB); P.push([y5, sd(y5)]);
    var y6 = yB + 0.85 * (ymax - yB); P.push([y6, sd(y6)]);
    var z7 = H[ki][1] > zmax * 0.25 ? H[ki][1] : 0.5 * P[6][1], y7 = topAtZ(H, z7);
    if (y7 === null) y7 = ymax;
    if (z7 >= P[6][1]) { z7 = P[6][1] * 0.6; y7 = topAtZ(H, z7) || ymax; }
    P.push([Math.max(y7, P[6][0]), z7]);
    P.push([yc, 0]);
    // flags per column (glass / paint group) from the nearest source vertex to the column midpoint
    var flags = [];
    for (var c = 0; c < AUTO_N - 1; c++) {
      var m = [(P[c][0] + P[c + 1][0]) / 2, (P[c][1] + P[c + 1][1]) / 2], bi = 0, bd = Infinity;
      for (i = 0; i <= Hn; i++) { var d = Math.hypot(H[i][0] - m[0], H[i][1] - m[1]); if (d < bd) { bd = d; bi = i; } }
      var gq = sec.glass ? !!sec.glass[bi] : false;
      if (!sec.glass && ghb && sec.x > ghb.minX + 0.05 && sec.x < ghb.maxX - 0.02) {
        // no glass flags: side glass between the belt and the roof rail, screens where the roof line is still rising
        if (c === 5 || c === 6) gq = true;
        else if (c === 7 && yc < ghb.maxY - 0.07 && yc > yB + 0.06) gq = true;
      }
      flags.push({ glass: gq, paint: sec.paint ? sec.paint[bi] : null });
    }
    return { x: sec.x, pts: P, flags: flags };
  }
  function autoDef(model) {
    var SH = shapeLib();
    if (typeof model === 'string') model = SH && SH.models[model];
    if (!SH || !model) return null;
    if (autoCache[model.id]) return autoCache[model.id];
    var f0 = SH.fit(model, SH.refBuild ? SH.refBuild(model) : null);
    var secs = SH.sectionsFromViews(f0, model.sections ? {} : { stations: 64, wheelWells: false });
    if (!secs || secs.length < 4) return null;
    secs = secs.slice().sort(function (a, b) { return b.x - a.x; });
    // global belt line (side greenhouse bottom), held flat past its ends
    var ghb = boundsOf(SH, f0.side.greenhouse) || boundsOf(SH, f0.side.windows);
    var beltG = ghb ? ghb.minY : (f0.dims.height * 0.62);
    var dense = secs.map(function (s) { return sampleHalf(s, beltG, ghb); });
    // wheel-well zones: lower points inside the arches come from the stations either side
    var arches = [f0.side.archF, f0.side.archR].filter(Boolean);
    arches.forEach(function (A) {
      var e = A.r * 1.12, zone = [], before = null, after = null;
      dense.forEach(function (d, i) { if (Math.abs(d.x - A.x) < e) zone.push(i); });
      if (!zone.length) return;
      before = zone[0] - 1; after = zone[zone.length - 1] + 1;
      if (before < 0) before = after; if (after >= dense.length) after = before;
      if (before < 0 || after >= dense.length) return;
      var Pa = dense[before], Pb = dense[after];
      zone.forEach(function (i) {
        var d = dense[i], t = Pa.x === Pb.x ? 0 : (Pa.x - d.x) / (Pa.x - Pb.x), top = A.y + Math.sqrt(Math.max(0, A.r * A.r - (d.x - A.x) * (d.x - A.x)));
        d.pts[0] = [lerp(Pa.pts[0][0], Pb.pts[0][0], t), 0];
        for (var k = 1; k <= 4; k++) {
          if (d.pts[k][0] < top + 0.03) d.pts[k] = [lerp(Pa.pts[k][0], Pb.pts[k][0], t), lerp(Pa.pts[k][1], Pb.pts[k][1], t)];
        }
        // keep the ring monotonic in height
        for (k = 1; k < AUTO_N - 1; k++) if (d.pts[k][0] < d.pts[k - 1][0] && k > 1) d.pts[k][0] = d.pts[k - 1][0];
      });
    });
    // greedy station selection: ends + the worst-interpolated station until 13 or the error is < 1 cm
    var sel = [0, dense.length - 1], maxSt = 14;
    function errAt(i, sl) {
      var a = 0, b = sl.length - 1;
      for (var q = 0; q < sl.length - 1; q++) if (sl[q] <= i && sl[q + 1] >= i) { a = q; b = q + 1; break; }
      var A = dense[sl[a]], B = dense[sl[b]], t = A.x === B.x ? 0 : (A.x - dense[i].x) / (A.x - B.x), e = 0;
      for (var k = 0; k < AUTO_N; k++) e = Math.max(e, Math.hypot(lerp(A.pts[k][0], B.pts[k][0], t) - dense[i].pts[k][0], lerp(A.pts[k][1], B.pts[k][1], t) - dense[i].pts[k][1]));
      return e;
    }
    while (sel.length < maxSt) {
      var worst = -1, we = 0.01;
      for (var i = 1; i < dense.length - 1; i++) {
        if (sel.indexOf(i) >= 0) continue;
        var near = false;
        for (var q = 0; q < sel.length; q++) if (Math.abs(dense[sel[q]].x - dense[i].x) < 0.06) near = true;
        if (near) continue;
        var e = errAt(i, sel);
        if (e > we) { we = e; worst = i; }
      }
      if (worst < 0) break;
      sel.push(worst); sel.sort(function (a, b) { return a - b; });
    }
    var st = sel.map(function (i) { return dense[i]; });
    // materials per interval: flags of the dense station nearest to the interval middle
    var ghx = ghb ? [ghb.minX, ghb.maxX] : null;
    var mats = [];
    for (i = 0; i < st.length - 1; i++) {
      var xm = (st[i].x + st[i + 1].x) / 2, bi = 0, bd = Infinity;
      dense.forEach(function (d, k) { var dd = Math.abs(d.x - xm); if (dd < bd) { bd = dd; bi = k; } });
      var fl = dense[bi].flags, row = [];
      for (var c = 0; c < AUTO_N - 1; c++) {
        var F = fl[c], m = 'paint';
        if (c === 0) m = 'under';
        else if (F.glass) m = 'glass';
        else if (F.paint === 'black' || F.paint === 'grille' || F.paint === 'carbon' || F.paint === 'chrome') m = F.paint;
        else if (F.paint === 'gloss-black') m = 'gloss';
        else if (c >= 5 && ghx && xm > ghx[0] && xm < ghx[1]) m = 'paint2';
        row.push(m);
      }
      mats.push(row);
    }
    var def = { body: { stations: st.map(function (s) { return { x: s.x, pts: s.pts }; }), mats: mats }, parts: [], auto: true, notes: 'auto low-poly from CB.shapes ' + model.id };
    // lamps / grille / plates from the front & rear views (projected onto the shell when compiled)
    var fr = f0.front || {}, rr = f0.rear || {};
    function add2(view, slot, mat, maxPts) {
      outlinesOf(SH, slot, 0.006, maxPts).forEach(function (o) {
        var m = mat;
        if (mat === 'auto') m = o.paint === 'light-red' ? 'tail' : o.paint === 'light-amber' ? 'indicator' : o.paint === 'light' ? 'light' : o.paint === 'glass' ? 'glass' : o.paint === 'chrome' ? 'chrome' : 'grille';
        def.parts.push({ t: 'poly', view: view, pts: o.pts, mat: m, offset: mat === 'grille' ? 0.004 : 0.006 });
      });
    }
    add2('front', fr.grille, 'grille', 14);
    add2('front', fr.intakes, 'grille', 10);
    add2('front', fr.plateArea, 'plate', 6);
    add2('front', fr.headlights, 'light', 14);
    add2('front', fr.drl, 'drl', 10);
    add2('rear', rr.diffuser, 'black', 12);
    add2('rear', rr.plateArea, 'plate', 6);
    add2('rear', rr.taillights, 'tail', 14);
    add2('rear', rr.lightBar, 'tail', 14);
    // models without lamp outlines: generic lamp blocks on the nose / tail corners
    function hasMat(m) { return def.parts.some(function (p) { return p.mat === m; }); }
    var sF = st[0], sR = st[st.length - 1], sF2 = st[1] || sF, sR2 = st[st.length - 2] || sR;
    function topOf(s0) { var y = -Infinity, z = 0; s0.pts.forEach(function (q) { y = Math.max(y, q[0]); z = Math.max(z, q[1]); }); return [y, z]; }
    if (!hasMat('light')) {
      var tf = topOf(sF2), yl = tf[0] - 0.12, zl = tf[1];
      def.parts.push({ t: 'poly', view: 'front', mat: 'light', mirror: true, offset: 0.006, pts: [[zl * 0.55, yl - 0.05], [zl * 0.85, yl - 0.05], [zl * 0.85, yl + 0.04], [zl * 0.55, yl + 0.04]] });
    }
    if (!hasMat('tail')) {
      var tr = topOf(sR2), yt = tr[0] - 0.12, zt = tr[1];
      def.parts.push({ t: 'poly', view: 'rear', mat: 'tail', mirror: true, offset: 0.006, pts: [[zt * 0.55, yt - 0.05], [zt * 0.85, yt - 0.05], [zt * 0.85, yt + 0.04], [zt * 0.55, yt + 0.04]] });
    }
    // mirrors: side-view mirror detail (x, y range) x plan-view mirror (z range)
    try {
      var md = (f0.details || []).filter(function (d) { return d.view === 'side' && d.role === 'mirror'; })[0];
      var tm = itemsOf(SH, (f0.top || {}).mirrors).map(function (i) { return SH.bounds(i.path); }).filter(function (b) { return b && !b.empty && b.maxY > 0; })[0];
      if (md && tm) {
        var sb = SH.bounds(SH.toPath(md.path) || md.path);
        if (sb && !sb.empty) def.parts.push({ t: 'mirrorAuto', x0: sb.minX, x1: sb.maxX, y0: sb.minY, y1: sb.maxY, z0: Math.max(0.3, tm.minY), z1: tm.maxY, mat: 'mirror' });
      }
    } catch (e) { /* no mirrors */ }
    autoCache[model.id] = def;
    return def;
  }

  /* ================================================================ compile (ref coords, once per def) */
  function compile(id, def) {
    var key = id + (def.auto ? ':auto' : '');
    if (compiled[key]) return compiled[key];
    var body = normShell(def.body), cabin = normShell(def.cabin);
    if (!body) return null;
    // temporary shell for projections (no wheel wells)
    var all = [];
    function grab(sh) {
      if (!sh) return;
      var acc = new Acc(), Bq = { face: function (m, a, b, c) { if (acc.tri(a, b, c, [1, 1, 1])) { var k = acc.p.length - 9; all.push(triRec([acc.p[k], acc.p[k + 1], acc.p[k + 2]], [acc.p[k + 3], acc.p[k + 4], acc.p[k + 5]], [acc.p[k + 6], acc.p[k + 7], acc.p[k + 8]], m)); } }, poly: function (m, pts, hint) { var a2 = new Acc(); emitPoly(a2, pts, [1, 1, 1], hint); for (var k = 0; k < a2.p.length; k += 9) all.push(triRec([a2.p[k], a2.p[k + 1], a2.p[k + 2]], [a2.p[k + 3], a2.p[k + 4], a2.p[k + 5]], [a2.p[k + 6], a2.p[k + 7], a2.p[k + 8]], m)); } };
      emitShell(Bq, sh.stations, function (i, j) { return matAt(sh.mats, i, j, 'paint') || 'paint'; }, { capF: sh.capF, capR: sh.capR, jitter: 0 });
    }
    grab(body); grab(cabin);
    var parts = [];
    (def.parts || []).forEach(function (p) {
      if (p.t === 'poly' && p.view) {
        var off = num(p.offset, 0.006);
        var outline = p.pts.map(function (q) { return [+q[0], +q[1]]; });
        var lists = [outline];
        // opt-in maxTilt (deg): the decal becomes one flat polygon facing the view within maxTilt (see planeDecal)
        var maxTilt = isFinite(+p.maxTilt) && +p.maxTilt > 0 ? clamp(+p.maxTilt, 0, 80) * DEG : null;
        if (p.mirror) lists.push(outline.map(function (q) { return p.view === 'front' || p.view === 'rear' ? [-q[0], q[1]] : q; }));
        lists.forEach(function (ol, li) {
          var view = p.view;
          if (li === 1 && p.view === 'side') view = 'left';
          if (li === 1 && p.view === 'top') ol = ol.map(function (q) { return [q[0], -q[1]]; });
          var pcs = maxTilt !== null ? planeDecal(all, view, ol, off, maxTilt) : [];
          if (!pcs.length) pcs = projectOutline(all, view, ol, off);
          // small details on steep faces only (badge on a raked nose, repeater on a curved fender): loose limit
          if (!pcs.length) pcs = projectOutline(all, view, ol, off, 0.03);
          pcs.forEach(function (pc) { parts.push({ t: 'poly3', mat: p.mat || 'black', pts: pc.pts, n: pc.n, kind: p.kind }); });
        });
      } else parts.push(p);
    });
    var res = { id: id, def: def, body: body, cabin: cabin, parts: parts, tris: all, wheels: def.wheels || {}, auto: !!def.auto };
    compiled[key] = res;
    return res;
  }

  /* ================================================================ resolve-lite (no car-mesh) */
  var WHEEL_FB = {
    'y-spoke': ['y', 5], 'split-10': ['split', 10], 'twin-7': ['split', 7], 'mesh-bbs': ['mesh', 10], 'multi-spoke': ['mesh', 10],
    turbine: ['turbine', 12], 'fan-blade': ['turbine', 9], 'monoblock-5': ['monoblock', 5], 'monoblock-6': ['monoblock', 6],
    'classic-5': ['monoblock', 5], 'deep-dish': ['dish', 8], beadlock: ['dish', 8], 'centerlock-race': ['centerlock', 10],
    'aero-disc': ['aero-disc', 0], 'aero-blade': ['aero-disc', 5]
  };
  function resolveLite(build, opts) {
    var b = build || {}, ex = b.exterior || {}, wh = b.wheels || {}, ae = b.aero || {}, en = b.engine || {};
    var fin = FINISH[ex.finish] ? ex.finish : 'metallic';
    var wd = WHEEL_FB[wh.design] || WHEEL_FB['y-spoke'];
    var D = CB.data, dd = null;
    try { if (D && D.wheelDesigns) dd = D.wheelDesigns.filter(function (w) { return w.id === wh.design; })[0]; } catch (e) { dd = null; }
    var S = {
      paint: lhex(opts.color || ex.paint, '#b3121f'), finishId: fin,
      roof: ['body', 'black', 'carbon', 'glass', 'contrast'].indexOf(ex.roof) >= 0 ? ex.roof : 'body',
      tint: clamp(num(ex.windowTint_pct, 20), 0, 90) / 100, lights: ex.lights || 'led',
      mirrors: ['body', 'black', 'carbon'].indexOf(ex.mirrors) >= 0 ? ex.mirrors : 'body',
      wheelDesign: { id: wh.design || 'y-spoke', style: dd && dd.style || wd[0], spokes: dd && isFinite(dd.spokes) ? dd.spokes : wd[1] },
      wheelFinish: lhex(wh.finish, '#2b2b2b'), wheelMaterial: wh.material || 'cast', caliper: lhex(ex.caliperColor, '#c0c0c0'),
      wing: ['ducktail', 'lip-spoiler', 'swan-neck', 'gt-wing', 'active', 'biplane'].indexOf(ae.wing) >= 0 ? ae.wing : null,
      wingAngle: clamp(num(ae.wingAngle_deg, 6), -5, 25) * DEG,
      splitter: ['lip', 'carbon', 'race'].indexOf(ae.splitter) >= 0 ? ae.splitter : null,
      diffuser: ['mild', 'carbon', 'race'].indexOf(ae.diffuser) >= 0 ? ae.diffuser : null,
      canards: !!ae.canards, sideSkirts: !!ae.sideSkirts, activeAero: !!ae.activeAero,
      ev: en.type === 'ev', exhaust: en.type === 'ev' ? null : { style: 'round', count: 2 },
      number: ex.livery_number != null && String(ex.livery_number).trim() !== '' ? String(ex.livery_number).trim().slice(0, 3)
        : (opts.isPlayer !== true && opts.number != null && String(opts.number).trim() !== '' ? String(opts.number).trim().slice(0, 3) : ''),
      numberColor: opts.accent || ex.stripeColor || '#d01818', stripe: ex.stripe && ex.stripe !== 'none' ? ex.stripe : null,
      accent: lhex(opts.accent || ex.stripeColor, '#ffffff'), driven: (b.drivetrain && b.drivetrain.layout) || 'rwd', drl: 0.45,
      front: { camber: clamp(num((b.suspension || {}).camberFront_deg, -1), -5, 2) * DEG },
      rear: { camber: clamp(num((b.suspension || {}).camberRear_deg, -1), -5, 2) * DEG }
    };
    S.roofColor = S.roof === 'contrast' ? lhex(ex.roofColor, '#111111') : S.roof === 'black' ? [0.006, 0.006, 0.007] : S.paint;
    return S;
  }
  function specFor(build, opts, model) {
    if (opts.S) return opts.S;
    var S = null;
    try { if (CB.gl && CB.gl.car && typeof CB.gl.car.resolve === 'function') S = CB.gl.car.resolve(build, { lod: opts.lod, color: opts.color, accent: opts.accent, number: opts.number, isPlayer: opts.isPlayer }); }
    catch (e) { S = null; }
    if (!S) S = resolveLite(build, opts);
    S = Object.assign({}, S);
    delete S.eye; delete S.xA;
    var wh0 = (build && build.wheels) || {};
    if (!wh0.design && model && (model.style === 'pickup' || model.style === 'van')) {
      S.wheelDesign = model.style === 'van' || model.powertrain === 'ev' ? { id: 'aero-disc', style: 'aero-disc', spokes: 0 } : { id: 'beadlock', style: 'dish', spokes: 8 };
    }
    if (model && model.twoTone && !S.twoToneColor) S.twoToneColor = S.roof === 'contrast' ? S.roofColor : [0.86, 0.86, 0.84];
    return S;
  }

  /* ================================================================ build */
  function build(buildObj, opts) {
    opts = opts || {};
    var SH = shapeLib();
    if (!SH) return null;
    var model = modelOf(buildObj, opts);
    if (!model) return null;
    var lod = opts.lod === 'low' ? 'low' : 'high';
    var f = SH.fit(model, buildObj || {});
    if (!f || !f.dims || !f.wheels) return null;
    var authored = defs[model.id] && !opts.forceAuto;
    var def = authored ? defs[model.id] : autoDef(model);
    if (!def) return null;
    var C = compile(model.id, def);
    if (!C) return null;
    var S = specFor(buildObj, opts, model);
    var d = f.dims, map = f._map, sz = num(d.scaleZ, 1), dy = num(d.dy, 0), dx = -num(d.centerX, 0);
    function mx(x) { return map && map.x ? map.x(x) : x; }
    function P3(p) { return [mx(p[0]) + dx, p[1] + dy, p[2] * sz]; }
    function fitShell(sh) {
      return sh.stations.map(function (s) { return { x: mx(s.x) + dx, pts: s.pts.map(function (q) { return [q[0] + dy, q[1] * sz]; }) }; });
    }
    // ---- colours
    var paint = S.paint || [0.5, 0.05, 0.05];
    var roofC = S.roof === 'contrast' || S.roof === 'black' ? S.roofColor : (S.twoToneColor || paint);
    var roofB = S.roof === 'carbon' ? 'carbon' : S.roof === 'glass' ? 'glass' : 'roof';
    if (S.roof === 'carbon') roofC = PAL.carbon;
    if (S.roof === 'glass') roofC = PAL.glass;
    // glass reads as the dark cabin behind it (photos show near-black windows), only slightly lighter when untinted;
    // the subtle sky reflection comes from the glass material (thin-glass Fresnel, reduced env intensity)
    var tint = clamp(num(S.tint, 0.2), 0, 0.9), glassC = [lerp(0.0085, PAL.glass[0] * 0.5, tint), lerp(0.0105, PAL.glass[1] * 0.5, tint), lerp(0.0145, PAL.glass[2] * 0.5, tint)];
    var mirrorM = S.mirrors === 'black' ? 'gloss' : S.mirrors === 'carbon' ? 'carbon' : 'paint';
    var stripeC = S.stripeColor || S.accent || [0.9, 0.9, 0.9];
    var low = lod === 'low', weave = 0, CARBON2 = [PAL.carbon[0] * 0.45, PAL.carbon[1] * 0.45, PAL.carbon[2] * 0.5];
    var colors = {
      resolve: function (mat) {
        if (mat === 'mirror') mat = mirrorM;
        var b = BUCKET[mat];
        if (!b) return null;
        var c = mat === 'paint' ? paint : mat === 'paint2' ? roofC : mat === 'glass' ? glassC : mat === 'stripe' || mat === 'accent' ? stripeC
          : mat === 'caliper' ? (S.caliper || [0.6, 0.6, 0.6]) : mat === 'rim' ? (S.wheelFinish || [0.4, 0.4, 0.4]) : PAL[mat] || PAL.black;
        if (mat === 'paint2') b = roofB;
        if (c === PAL.carbon) { weave++; if (weave & 1) c = CARBON2; }   // woven two-tone, alternating per face
        if (low) b = b === 'head' || b === 'drl' ? 'head' : b === 'tail' || b === 'rev' ? 'tail' : 'low';
        return { b: b, c: c };
      }
    };
    var B = new Builder(colors);
    B.recordCast = true;
    // ---- wheels (fitted)
    var wF = f.wheels.front, wR = f.wheels.rear, aF = f.side.archF || {}, aR = f.side.archR || {};
    var arches = [[aF, wF], [aR, wR]].map(function (q) {
      var a = q[0], w = q[1];
      return { x: num(a.x, w.x) + dx, cy: Math.max(num(a.y, w.r), w.r), r: Math.max(num(a.r, w.r + 0.03), w.r + 0.025), zIn: w.track / 2 - w.width / 2 - 0.03 };
    });
    // ---- body shell (+ wells)
    var bodyFit = fitShell(C.body), body = C.body;
    var K = low ? 2 : 5;
    if (low) bodyFit = decimateStations(bodyFit, 6);
    var WG = body.wells ? wellGrid(bodyFit, arches, K) : { grid: bodyFit.map(function (s) { return { x: s.x, pts: s.pts, well: null }; }), clamped: bodyFit.map(function (s) { return s.pts.map(function () { return false; }); }) };
    var grid = WG.grid, wells = body.wells;
    var ringIdx = null;
    if (low) { var DR = decimateRing(grid, wells ? [0, 1, 2] : [0]); grid = DR.grid; ringIdx = DR.idx; }
    var stOrig = C.body.stations.map(function (s) { return { x: mx(s.x) + dx }; });
    emitShell(B, grid, function (i, j, Q, i2) {
      var xm = (grid[i].x + grid[i2].x) / 2, r = rowOf(stOrig, xm);
      if (low) {
        if (j < (wells ? 3 : 1)) return 'under';
        var colL = ringIdx[j] - (wells ? 2 : 0);
        return matAt(body.mats, r, clamp(colL, 1, body.stations[0].pts.length - 2), 'paint');
      }
      if (!wells) return matAt(body.mats, r, j, 'paint');
      if (j === 0) return 'under';
      if (j === 1) return 'well';
      if (j === 2) return (grid[i].well != null || grid[i2].well != null) ? 'well' : 'under';
      var cl = WG.clamped, c4 = [cl[i][j], cl[i2][j], cl[i2][j + 1], cl[i][j + 1]], nc = c4.filter(Boolean).length;
      var m = matAt(body.mats, r, j - 2, 'paint');
      if (nc === 4) return 'well';
      if (nc > 0) {
        // partly clamped quad: only the arch's own walls are well liner — the end walls (between the open and the
        // clamped ring at the same x) and ceiling pieces facing down into the well (not outward). Body panels that merely touch a
        // clamped point (fender tops / shoulders just above the arch, the steep panel beside the arch's end
        // corners) keep the authored material, whatever their slope.
        if (Math.abs(grid[i].x - grid[i2].x) < 1e-6) return 'well';
        var nn = cross(sub(Q[3], Q[0]), sub(Q[2], Q[0])), l = len(nn);
        if (l > 1e-9 && nn[1] / l < -0.35 && Math.abs(nn[2] / l) < 0.6) return 'well';
      }
      return m;
    }, { capF: body.capF, capR: body.capR, seed: 1, jitter: low ? 0.04 : 0.07 });
    // ---- cabin
    if (C.cabin) {
      var cabFit = fitShell(C.cabin), cab = C.cabin;
      if (low) cabFit = decimateStations(cabFit, 5);
      var cg = cabFit.map(function (s) { return { x: s.x, pts: s.pts }; });
      var stC = C.cabin.stations.map(function (s) { return { x: mx(s.x) + dx }; });
      emitShell(B, cg, function (i, j, Q, i2) { return matAt(cab.mats, rowOf(stC, (cg[i].x + cg[i2].x) / 2), j, 'paint'); }, { capF: cab.capF, capR: cab.capR, seed: 7, jitter: low ? 0.04 : 0.07 });
    }
    // ---- authored / auto parts (high LOD; the low LOD keeps lamps only)
    var anchors = { headlights: [], brakeLights: [], exhaust: [], wheels: [] };
    var lampAcc = { light: [], tail: [] };
    var lowLamps = {};
    // shell queries (the cast list holds the shell faces only; parts are not recorded) + mirror mounts
    var Sh = shellInfo(grid, B.cast, f, dx, arches);
    var MP = low ? null : planMirrors(C.parts, Sh, sz, dx, dy, mx);
    C.parts.forEach(function (p, pi) {
      if (low) {
        if ((p.t === 'poly3' || p.t === 'poly') && (p.mat === 'light' || p.mat === 'tail')) {
          (p.t === 'poly' && p.mirror ? [1, -1] : [1]).forEach(function (sg) {
            var key = p.mat + (p.pts[0][2] * sg >= 0 ? 'R' : 'L'), L = lowLamps[key] || (lowLamps[key] = { mat: p.mat, pts: [] });
            p.pts.forEach(function (q) { L.pts.push(P3([q[0], q[1], q[2] * sg])); });
          });
        }
        return;
      }
      emitPart(B, p, P3, sz, f, dx, dy, mx, MP && MP.move[pi], arches);
      if (p.t === 'poly' && p.pts && p.pts[0].length === 3 && (p.mat === 'light' || p.mat === 'tail')) {
        (p.mirror ? [1, -1] : [1]).forEach(function (sg) {
          var c1 = [0, 0, 0];
          p.pts.forEach(function (q) { c1 = add(c1, P3([q[0], q[1], q[2] * sg])); });
          lampAcc[p.mat].push(scl(c1, 1 / p.pts.length));
        });
      }
      if (p.t === 'poly3' && (p.mat === 'light' || p.mat === 'tail')) {
        var c0 = [0, 0, 0];
        p.pts.forEach(function (q) { c0 = add(c0, P3(q)); });
        lampAcc[p.mat].push(scl(c0, 1 / p.pts.length));
      }
    });
    Object.keys(lowLamps).forEach(function (k) {   // low LOD: one flat quad per lamp, at the lamp's front-most point
      var L = lowLamps[k], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      L.pts.forEach(function (q) { for (var c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], q[c]); hi[c] = Math.max(hi[c], q[c]); } });
      var fr = L.mat === 'light', x = fr ? hi[0] + 0.01 : lo[0] - 0.01, s = fr ? 1 : -1;
      B.poly(L.mat, [[x, lo[1], lo[2]], [x, lo[1], hi[2]], [x, hi[1], hi[2]], [x, hi[1], lo[2]]], [s, 0, 0]);
    });
    // ---- build-driven extras on the fitted shell
    if (MP) MP.stalks.forEach(function (bx) { [1, -1].forEach(function (sg) { emitBox(B, 'mirror', [bx.c[0], bx.c[1], bx.c[2] * sg], bx.s, 0); }); });
    if (!low) extras(B, S, Sh, f, model, dx, dy, mx, anchors, exhaustTips(def, f, sz, dy));
    // anchors (lamp centres, one per side)
    function sideAnchors(list, fb) {
      var R = list.filter(function (c) { return c[2] > 0; }), L = list.filter(function (c) { return c[2] < 0; });
      function avg(a) { var s = [0, 0, 0]; a.forEach(function (c) { s = add(s, c); }); return scl(s, 1 / a.length); }
      if (R.length && L.length) return [avg(R), avg(L)];
      if (R.length) { var r0 = avg(R); return [r0, [r0[0], r0[1], -r0[2]]]; }
      return [fb, [fb[0], fb[1], -fb[2]]];
    }
    anchors.headlights = sideAnchors(lampAcc.light, [Sh.xF - 0.08, Sh.noseY - 0.05, Sh.hwF * 0.7]);
    anchors.brakeLights = sideAnchors(lampAcc.tail, [Sh.xR + 0.06, Sh.deckY - 0.1, Sh.hwR * 0.7]);
    // ---- wheels
    var wdz = S.wheelDesign || { style: 'y', spokes: 5 }, wstyle = wdz.style, spokes = wdz.spokes;
    var wdef = C.wheels || {};
    var noDesign = !(buildObj && buildObj.wheels && buildObj.wheels.design);
    if ((noDesign || !wstyle) && wdef.style) { wstyle = wdef.style; if (wdef.spokes != null) spokes = wdef.spokes; }
    var split = wstyle === 'y' || (wdef.style === 'split' && wstyle === 'split');
    var wheelParts = [];
    [['fl', true, -1], ['fr', true, 1], ['rl', false, -1], ['rr', false, 1]].forEach(function (wd) {
      var W = wd[1] ? wF : wR, side = wd[2], aIdx = wd[1] ? 0 : 1;
      var info = { id: wd[0], front: wd[1], side: side, x: W.x + dx, y: W.r, z: side * W.track / 2, r: W.r, width: W.width,
        camber: num((wd[1] ? S.front : S.rear) && (wd[1] ? S.front : S.rear).camber, 0) * side };
      // tuck the tyre under the fender
      var Aw = arches[wd[1] ? 0 : 1], zf = Sh.sideZ(info.x, Aw.cy + Aw.r + 0.02);
      if (zf !== null) { var over = Math.abs(info.z) + W.width / 2 - (zf - 0.006); if (over > 0) info.inset = Math.min(over, 0.08); }
      if (wdef.inset) info.inset = (info.inset || 0) + wdef.inset;
      void aIdx;
      anchors.wheels.push(info);
      wheelParts.push(info);
    });
    var wheelGeos = {};
    function geoFor(front) {
      var k = front ? 'f' : 'r';
      if (wheelGeos[k]) return wheelGeos[k];
      var W = front ? wF : wR;
      return (wheelGeos[k] = wheelGeo({ r: W.r, rim: W.rimR, tw: W.width }, {
        style: wstyle, spokes: spokes, split: split, sides: low ? 6 : 12, finish: S.wheelFinish || [0.45, 0.45, 0.47],
        caliper: low ? null : (S.caliper || [0.6, 0.6, 0.6]), front: front, low: low
      }));
    }
    // ---- output parts
    var M = materials(S), out = [];
    function pushPart(acc, kind, matKey, extra) {
      if (!acc || !acc.i.length) return;
      var nv = acc.p.length / 3;
      var p = {
        kind: kind, mat: matKey, material: M[matKey] || M.trim,
        positions: new Float32Array(acc.p), normals: new Float32Array(acc.n), colors: new Float32Array(acc.c), uvs: new Float32Array(nv * 2),
        indices: nv > 65535 ? new Uint32Array(acc.i) : new Uint16Array(acc.i), attach: 'body', castShadow: true, transparent: false,
        triangles: acc.i.length / 3, vertexCount: nv
      };
      if (extra) for (var k in extra) p[k] = extra[k];
      out.push(p);
    }
    var A = B.acc;
    if (low) {
      pushPart(A.low, 'body', 'low');
      var wl = new Acc();
      wheelParts.forEach(function (info) {
        var g = geoFor(info.front), zc = info.z - info.side * (info.inset || 0);
        var t = appendAcc(appendAcc(new Acc(), g.tyre), g.rim);
        if (info.side < 0) t = mirrorAcc(t);
        appendAcc(wl, translateAcc(t, info.x, info.y, zc));
      });
      pushPart(wl, 'wheels', 'wheelsLow', { attach: 'car' });
      pushPart(A.head, 'light-head', 'head', { castShadow: false });
      pushPart(A.tail, 'light-brake', 'tail', { castShadow: false });
    } else {
      pushPart(A.body, 'body', 'body');
      pushPart(A.roof, 'roof', 'roof');
      pushPart(A.trim, 'trim', 'trim');
      pushPart(A.gloss, 'trim', 'gloss');
      pushPart(A.chrome, 'chrome', 'chrome');
      pushPart(A.carbon, 'carbon', 'carbon');
      pushPart(A.glass, 'glass', 'glass', { castShadow: true });
      pushPart(A.head, 'light-head', 'head', { castShadow: false });
      pushPart(A.drl, 'light-head', 'drl', { castShadow: false, lightKey: 'light-drl' });
      pushPart(A.tail, 'light-brake', 'tail', { castShadow: false });
      pushPart(A.rev, 'light-rev', 'rev', { castShadow: false });
      if (B.wing) pushPart(B.wing.acc, 'wing', 'wing', { wing: { pivot: B.wing.pivot, active: B.wing.active, base: B.wing.base } });
      wheelParts.forEach(function (info) {
        var g = geoFor(info.front), base = { attach: 'wheel', wheel: info };
        var tyre = info.side < 0 ? mirrorAcc(g.tyre) : g.tyre, rim = info.side < 0 ? mirrorAcc(g.rim) : g.rim;
        pushPart(rim, 'wheel-' + info.id, 'rim', base);
        pushPart(tyre, 'tire-' + info.id, 'tyre', base);
        if (g.cal && g.cal.i.length) pushPart(info.side < 0 ? mirrorAcc(g.cal) : g.cal, 'caliper-' + info.id, 'caliper', { attach: 'caliper', wheel: info, castShadow: false });
      });
    }
    var tris = 0;
    out.forEach(function (p) { tris += p.triangles; });
    // ---- dims & cameras
    var dims = {
      length: Sh.xF - Sh.xR, width: num(d.width, Sh.hw * 2), height: Sh.H, wheelbase: d.wheelbase, track: d.track,
      wheelRadius: Math.max(wF.r, wR.r), wheelRadiusFront: wF.r, wheelRadiusRear: wR.r, rideHeight: d.rideHeight,
      frontOverhang: Sh.xF - (wF.x + dx), rearOverhang: (wR.x + dx) - Sh.xR, frontAxle: wF.x + dx, rearAxle: wR.x + dx,
      trackFront: wF.track, trackRear: wR.track, tireWidthFront: wF.width, tireWidthRear: wR.width,
      belt: Sh.beltY, roof: Sh.roofY, deck: Sh.deckY, nose: Sh.noseY, style: model.style, model: model.id, make: model.make, modelName: model.name
    };
    var own = !opts.S;
    var eye = !own && S.eye && S.eye.length === 3 ? S.eye.slice() : [Sh.xA - 0.55, clamp(Sh.beltY + 0.32, Sh.beltY + 0.1, Sh.roofY - 0.12), -Math.min(0.38, Sh.hw * 0.4)];
    var hoodX = (!own && S.xA != null ? S.xA : Sh.xA) + 0.1, hoodTop = Sh.topAt(hoodX, 0);
    if (hoodTop === null) hoodTop = Sh.noseY;
    return {
      parts: out, dims: dims, cockpitEye: eye, hoodCam: [hoodX, hoodTop + 0.21, 0], bumperCam: [Sh.xF + 0.04, Math.max(0.35, Sh.noseY - 0.12), 0],
      anchors: anchors, lod: lod, model: { id: model.id, make: model.make, name: model.name, style: model.style },
      stats: { triangles: tris, parts: out.length }, auto: !authored, S: S, shell: Sh, mirrorPlan: MP
    };
  }
  /** keep n stations (ends + evenly spread interior) for the low LOD */
  function decimateStations(st, n) {
    if (st.length <= n) return st;
    var out = [];
    for (var i = 0; i < n; i++) out.push(st[Math.round(i * (st.length - 1) / (n - 1))]);
    return out;
  }
  /** low LOD ring: keep the well points + rocker, belt, roof edge and top centre of the authored ring */
  function decimateRing(grid, keepIdx) {
    var n = grid[0].pts.length, keep = {}, off = keepIdx[keepIdx.length - 1] - 1, na = n - off;
    keepIdx.forEach(function (k) { keep[k] = 1; });
    [1, Math.floor((na - 1) / 2), na - 2, na - 1].forEach(function (k) { if (k >= 1) keep[k + off] = 1; });
    var idx = Object.keys(keep).map(Number).sort(function (a, b) { return a - b; });
    return { idx: idx, grid: grid.map(function (s) { return { x: s.x, pts: idx.map(function (k) { return s.pts[k]; }), well: s.well }; }) };
  }
  /** queries on the fitted shell (right-half cast triangles) */
  function shellInfo(grid, cast, f, dx, arches) {
    var xF = -Infinity, xR = Infinity, H = 0, hw = 0;
    cast.forEach(function (T) {
      [T.a, T.b, T.c].forEach(function (p) { xF = Math.max(xF, p[0]); xR = Math.min(xR, p[0]); H = Math.max(H, p[1]); hw = Math.max(hw, p[2]); });
    });
    function topAt(x, z) { var h = castRay(cast, [x, 10, Math.abs(z || 0) + 1e-4], [0, -1, 0]); return h ? h.p[1] : null; }
    function sideZ(x, y) { var h = castRay(cast, [x, y, 10], [0, 0, -1]); return h ? h.p[2] : null; }
    function frontX(y, z) { var h = castRay(cast, [xF + 5, y, Math.abs(z) + 1e-4], [-1, 0, 0]); return h ? h.p[0] : null; }
    function rearX(y, z) { var h = castRay(cast, [xR - 5, y, Math.abs(z) + 1e-4], [1, 0, 0]); return h ? h.p[0] : null; }
    function bottomAt(x) { var h = castRay(cast, [x, -5, 0.001], [0, 1, 0]); return h ? h.p[1] : null; }
    function hwAt(x) {
      var best = 0;
      for (var i = 0; i < grid.length - 1; i++) {
        if (x <= grid[i].x && x >= grid[i + 1].x) {
          var t = grid[i].x === grid[i + 1].x ? 0 : (grid[i].x - x) / (grid[i].x - grid[i + 1].x);
          grid[i].pts.forEach(function (p, k) { best = Math.max(best, lerp(p[1], grid[i + 1].pts[k][1], t)); });
          return best;
        }
      }
      return hw;
    }
    var SH = shapeLib(), gh = SH && (boundsOf(SH, f.side.greenhouse) || boundsOf(SH, f.side.windows));
    var beltY = gh ? gh.minY : H * 0.62;
    var xA = gh ? gh.maxX + dx : xF - (xF - xR) * 0.35;
    var xC = gh ? gh.minX + dx : xR + 0.4;
    var roofY = topAt((xA + xC) / 2, 0) || H;
    var noseY = topAt(xF - Math.min(0.15, (xF - arches[0].x) * 0.2), 0) || H * 0.5;
    var deckY = topAt(xR + 0.3, 0) || noseY;
    return { xF: xF, xR: xR, H: H, hw: hw, hwF: hwAt(xF - 0.25), hwR: hwAt(xR + 0.25), topAt: topAt, sideZ: sideZ, frontX: frontX, rearX: rearX,
      bottomAt: bottomAt, hwAt: hwAt, beltY: beltY, xA: xA, xC: xC, roofY: roofY, noseY: noseY, deckY: deckY, arches: arches, cast: cast };
  }
  /** flare() arch bands (4-point prism: inner a0, outer a0, outer a1, inner a1 around an arch centre) must start AT
      the arch cut radius — the fitted arch r the wheel well is cut at (>= wheel r + 25 mm, about wheel r x 1.1):
      an inner edge inside it overhangs the open well with nothing behind it and reads as a floating lip. Inner
      points of such a band are pushed out radially to the cut (fitted side-view points [x, y], in place). */
  function clampFlare(pts, arches) {
    if (!arches || pts.length !== 4) return pts;
    arches.forEach(function (A) {
      var d = pts.map(function (q) { return Math.hypot(q[0] - A.x, q[1] - A.cy); }), a = pts.map(function (q) { return Math.atan2(q[1] - A.cy, q[0] - A.x); });
      var radial = Math.abs(a[0] - a[1]) < 0.03 && Math.abs(a[3] - a[2]) < 0.03 && d[1] > d[0] + 0.01 && d[2] > d[3] + 0.01;
      if (!radial || Math.min(d[0], d[3]) < A.r * 0.8 || Math.max(d[0], d[3]) > A.r * 1.3) return;
      [0, 3].forEach(function (k) {
        if (d[k] >= A.r) return;
        var s = A.r / Math.max(d[k], 1e-6);
        pts[k] = [A.x + (pts[k][0] - A.x) * s, A.cy + (pts[k][1] - A.cy) * s];
      });
    });
    return pts;
  }
  function emitPart(B, p, P3, sz, f, dx, dy, mx, mv, arches) {
    var mat = p.mat || 'black';
    if (mv) {   // mirror mount shift: dy up, dz outward (per side)
      var P3o = P3;
      P3 = function (q) { var r = P3o(q); return [r[0], r[1] + mv.dy, r[2] + (r[2] < 0 ? -mv.dz : mv.dz)]; };
      dy += mv.dy;
    }
    var mirror = !!p.mirror;
    function both(fn) { fn(1); if (mirror) fn(-1); }
    if (p.t === 'poly3') {
      var pts = p.pts.map(P3), n0 = p.n ? [p.n[0], p.n[1], p.n[2] / (sz || 1)] : null;
      B.poly(mat, pts, n0);
    } else if (p.t === 'poly') {
      both(function (s) {
        var pts = p.pts.map(function (q) { return P3([q[0], q[1], q[2] * s]); });
        var c = [0, 0, 0];
        pts.forEach(function (q) { c = add(c, q); });
        c = scl(c, 1 / pts.length);
        var nn = polyNormal(pts), hint = p.normal ? [p.normal[0], p.normal[1], p.normal[2] * s] : sub(c, [c[0] * 0.3, 0.55, 0]);
        if (dot(nn, hint) < 0) nn = scl(nn, -1);
        var off = num(p.offset, 0);
        if (off) { var nl = norm(nn); pts = pts.map(function (q) { return add(q, scl(nl, off)); }); }
        B.poly(mat, pts, hint);
      });
    } else if (p.t === 'box') {
      both(function (s) {
        var c = P3([p.c[0], p.c[1], p.c[2] * s]);
        emitBox(B, mat, c, [p.s[0], p.s[1], p.s[2] * sz], (p.rotY || 0) * DEG * s);
      });
    } else if (p.t === 'prism') {
      both(function (s) {
        var pts = clampFlare(p.pts2d.map(function (q) { return [mx(q[0]) + dx, q[1] + dy]; }), arches);
        var dzs = mv ? mv.dz * (p.z0 + p.z1 < 0 ? -1 : 1) : 0;
        emitPrism(B, mat, pts, (p.z0 * sz + dzs) * s, (p.z1 * sz + dzs) * s, 'z');
      });
    } else if (p.t === 'cyl') {
      both(function (s) {
        var c = P3([p.c[0], p.c[1], p.c[2] * s]);
        emitCyl(B, mat, c, p.r, p.ry || p.r, p.l, p.axis || 'x', p.sides || 8);
      });
    } else if (p.t === 'mirrorAuto') {
      [1, -1].forEach(function (s) {
        var x0 = mx(p.x0) + dx, x1 = mx(p.x1) + dx, y0 = p.y0 + dy, y1 = p.y1 + dy, z0 = p.z0 * sz + (mv ? mv.dz : 0), z1 = p.z1 * sz + (mv ? mv.dz : 0);
        var prof = [[x1, y0 + (y1 - y0) * 0.15], [x1 - (x1 - x0) * 0.15, y1], [x0, y1 - (y1 - y0) * 0.1], [x0 + (x1 - x0) * 0.1, y0]];
        var zo = z1 - (z1 - z0) * 0.08;
        emitPrism(B, mat, prof, s * (z0 + (z1 - z0) * 0.35), s * zo, 'z', mat);
        emitBox(B, 'black', [(x0 + x1) / 2 + 0.01, y0 + (y1 - y0) * 0.3, s * (z0 + (z1 - z0) * 0.2)], [Math.max(0.03, (x1 - x0) * 0.35), 0.03, (z1 - z0) * 0.45], 0);
      });
    }
  }

  /** door mirrors (mat 'mirror' prisms / boxes, auto mirrors) that do not touch the shell: the housing (with any
      part sitting inside / against it, e.g. its black foot or mirror glass) moves toward the skin until the gap is
      at most MGAP — down onto the door / shoulder top or in toward the glass, whichever is nearer — and a short
      body-colour stalk bridges what is left, so no mirror floats beside the glasshouse whatever the authored
      position. Returns { move: {partIndex: {dy, dz}}, stalks: [box] } (right side; mirrored on emission). */
  var MGAP = 0.03, MMOVE = 0.15;
  function partBox(p, sz, dx, dy, mx) {
    if (p.t === 'prism' && p.pts2d) {
      var xs = p.pts2d.map(function (q) { return mx(+q[0]) + dx; }), ys = p.pts2d.map(function (q) { return +q[1] + dy; });
      return { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs), y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
        zIn: Math.min(Math.abs(p.z0), Math.abs(p.z1)) * sz, zOut: Math.max(Math.abs(p.z0), Math.abs(p.z1)) * sz };
    }
    if (p.t === 'box' && p.c && p.s) {
      var cx = mx(p.c[0]) + dx, cz = Math.abs(p.c[2]) * sz, hx = Math.abs(p.s[0]) / 2 + Math.abs(p.s[2]) / 2 * Math.abs(Math.sin((p.rotY || 0) * DEG));
      return { x0: cx - hx, x1: cx + hx, y0: p.c[1] + dy - p.s[1] / 2, y1: p.c[1] + dy + p.s[1] / 2, zIn: cz - p.s[2] * sz / 2, zOut: cz + p.s[2] * sz / 2 };
    }
    if (p.t === 'poly' && !p.view && p.pts && p.pts[0] && p.pts[0].length === 3) {
      var b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, zIn: Infinity, zOut: -Infinity };
      p.pts.forEach(function (q) { var x = mx(+q[0]) + dx, y = +q[1] + dy, z = Math.abs(+q[2]) * sz; b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); b.zIn = Math.min(b.zIn, z); b.zOut = Math.max(b.zOut, z); });
      return b;
    }
    return null;
  }
  function planMirrors(parts, Sh, sz, dx, dy, mx) {
    var res = { move: {}, stalks: [] };
    parts.forEach(function (p, pi) {
      var hb = null;   // housing box (fitted, right side): x0 x1 y0 y1 zIn zOut
      if (p.mat === 'mirror') hb = partBox(p, sz, dx, dy, mx);
      else if (p.t === 'mirrorAuto') {
        var z0 = p.z0 * sz, z1 = p.z1 * sz;
        hb = { x0: mx(p.x0) + dx, x1: mx(p.x1) + dx, y0: p.y0 + dy, y1: p.y1 + dy, zIn: z0 + (z1 - z0) * 0.35, zOut: z1 };
      }
      if (!hb || !(hb.zIn > 0.2) || !(hb.x1 > hb.x0) || res.move[pi]) return;
      var xm = (hb.x0 + hb.x1) / 2, hL = hb.x1 - hb.x0, hH = hb.y1 - hb.y0;
      var yH = hb.y0 + Math.min(0.015, hH * 0.3), zq = hb.zIn + Math.min(0.03, (hb.zOut - hb.zIn) * 0.3);
      var zo = Sh.sideZ(xm, yH);
      if (zo !== null && zo >= hb.zIn - 0.012) return;                   // housing already on / in the skin
      var hh = castRay(Sh.cast, [xm, yH, hb.zIn], [0, 0, -1]);          // across to the glass / door skin
      var zb = hh ? hh.p[2] : null, gH = zb === null ? Infinity : hb.zIn - zb;
      var hv = castRay(Sh.cast, [xm, hb.y0, zq], [0, -1, 0]);           // down to the shoulder / door top
      var yt = hv ? hv.p[1] : null, gV = yt === null ? Infinity : hb.y0 - yt;
      if (Math.min(gH, gV) <= 0.012 || Math.min(gH, gV) > 0.6) return;
      var vert = gV <= gH, mv = { dy: 0, dz: 0 };
      if (vert) mv.dy = -clamp(gV - MGAP, 0, MMOVE); else mv.dz = -clamp(gH - MGAP, 0, MMOVE);
      // companions: parts sitting inside / against the housing move with it (mirror glass, black foot, cap)
      if (mv.dy || mv.dz) {
        res.move[pi] = mv;
        parts.forEach(function (q, qi) {
          if (qi === pi || res.move[qi] || q.t === 'poly3' || q.t === 'mirrorAuto') return;
          var qb = partBox(q, sz, dx, dy, mx), e = 0.03;
          if (!qb || qb.x1 < hb.x0 - e || qb.x0 > hb.x1 + e || qb.y1 < hb.y0 - e || qb.y0 > hb.y1 + e || qb.zOut < hb.zIn - e || qb.zIn > hb.zOut + e) return;
          var qc = [(qb.x0 + qb.x1) / 2, (qb.y0 + qb.y1) / 2, (qb.zIn + qb.zOut) / 2];
          if (qc[0] < hb.x0 - e || qc[0] > hb.x1 + e || qc[1] < hb.y0 - e || qc[1] > hb.y1 + e || qc[2] < hb.zIn - e || qc[2] > hb.zOut + e) return;
          res.move[qi] = mv;
        });
      }
      hb = { x0: hb.x0, x1: hb.x1, y0: hb.y0 + mv.dy, y1: hb.y1 + mv.dy, zIn: hb.zIn + mv.dz, zOut: hb.zOut + mv.dz };
      var w = clamp(hL * 0.25, 0.03, 0.05), xs0 = xm - hL * 0.12, k, h2;
      if (vert) {   // vertical stalk: its foot goes just below the skin under its footprint
        // the foot only reaches a little below the shoulder hit (yt): a footprint corner that misses the shoulder
        // (housing outboard of the skin) or starts inside the shell would otherwise find the sill / lower flank
        // and run a body-colour stalk down the whole door (or poke a box out under the sill)
        var yLo = yt, yFloor = yt - 0.05;
        for (k = 0; k < 4; k++) { h2 = castRay(Sh.cast, [xs0 + (k & 1 ? 0.5 : -0.5) * w, hb.y0, hb.zIn + (k & 2 ? 0.038 : 0.006)], [0, -1, 0]); if (h2 && h2.p[1] >= yFloor && h2.p[1] < yLo) yLo = h2.p[1]; }
        res.stalks.push({ c: [xs0, (yLo - 0.012 + hb.y0 + 0.012) / 2, hb.zIn + 0.022], s: [w, hb.y0 - yLo + 0.024, 0.032] });
      } else {      // horizontal arm into the glass / door skin
        var hA = Math.min(0.032, hH * 0.5), yA = hb.y0 + Math.min(0.025, hH * 0.3), zLo = zb;
        for (k = 0; k < 4; k++) { h2 = castRay(Sh.cast, [xs0 + (k & 1 ? 0.5 : -0.5) * w, yA + (k & 2 ? 0.5 : -0.5) * hA, hb.zIn], [0, 0, -1]); if (h2 && h2.p[2] >= zb - 0.05 && h2.p[2] < zLo) zLo = h2.p[2]; }   // same limit as the vertical foot
        res.stalks.push({ c: [xs0, yA, (zLo - 0.012 + hb.zIn + 0.012) / 2], s: [w, hA, hb.zIn - zLo + 0.024] });
      }
    });
    return res;
  }

  /* ================================================================ build-driven extras */
  /** exhaust tip list (fitted rear-view coords, CB.shapes rear.exhaust format {shape, cx, cy, w, h}): the def's own
      optional `exhaust` override (ref coords; `mirror: true` on a tip adds its twin at -cx; [] = no visible tips)
      wins over the base model's rear.exhaust */
  function exhaustTips(def, f, sz, dy) {
    if (!def || !Array.isArray(def.exhaust)) return (f.rear && f.rear.exhaust) || [];
    var out = [];
    def.exhaust.forEach(function (t) {
      if (!t || !isFinite(+t.cx) || !isFinite(+t.cy)) return;
      (t.mirror ? [1, -1] : [1]).forEach(function (s) {
        out.push({ shape: t.shape || 'round', cx: +t.cx * s * sz, cy: +t.cy + dy, w: num(+t.w, 0.09), h: num(+t.h, num(+t.w, 0.09)) });
      });
    });
    return out;
  }
  function extras(B, S, Sh, f, model, dx, dy, mx, anchors, exTips) {
    var xF = Sh.xF, xR = Sh.xR, aF = Sh.arches[0], aR = Sh.arches[1];
    var floorF = Sh.bottomAt(xF - 0.12), floorR = Sh.bottomAt(xR + 0.12);
    if (floorF === null) floorF = num(f.dims.rideHeight, 0.12) + 0.04;
    if (floorR === null) floorR = num(f.dims.rideHeight, 0.12) + 0.06;
    var carbonish = function (t) { return t === 'carbon' || t === 'race' ? 'carbon' : 'black'; };
    // ---- splitter: a lip that follows the authored bumper's plan shape just above its bottom edge, standing
    //      out only by its own lip (1.2 / 2.5 / 4.5 cm) instead of a flat plate poking ahead of the nose
    if (S.splitter) {
      var ext = S.splitter === 'race' ? 0.045 : S.splitter === 'carbon' ? 0.025 : 0.012;
      var ySp = floorF + 0.03, hwS = Sh.sideZ(xF - 0.15, ySp + 0.02);
      if (hwS === null) hwS = Sh.hwAt(xF - 0.15) * 0.9;
      hwS *= 0.94;
      var xa = Math.min(xF - 0.25, aF.x + aF.r + 0.05), outl = [[xa, -hwS]], NS = 7;
      for (var si = 0; si < NS; si++) {
        var zz = lerp(-hwS, hwS, si / (NS - 1)), fx = Sh.frontX(ySp, Math.abs(zz) * 0.985);
        if (fx === null) fx = Sh.frontX(ySp + 0.05, Math.abs(zz) * 0.985);
        if (fx === null || fx < xa + 0.05) fx = xa + 0.05;
        outl.push([fx + ext * (si === 0 || si === NS - 1 ? 0.4 : 1), zz]);
      }
      outl.push([xa, hwS]);
      emitPrism(B, carbonish(S.splitter), outl, floorF - 0.014, floorF + 0.002, 'y');
    }
    // ---- diffuser: ends on the authored rear bumper face (not behind it)
    if (S.diffuser) {
      var hwD = Sh.hwAt(xR + 0.2) * 0.8, xa2 = Math.max(xR + 0.15, aR.x - aR.r - 0.05), mt = carbonish(S.diffuser);
      var hD = S.diffuser === 'race' ? 0.14 : S.diffuser === 'carbon' ? 0.1 : 0.06;
      var xeD = Sh.rearX(floorR + hD * 0.4, 0);
      if (xeD === null || xeD > xa2 - 0.05) xeD = xR + 0.01;
      var xeF = Math.min(xa2 - 0.04, xeD + 0.004);
      emitPrism(B, mt, [[xa2, floorR - 0.004], [xeF, floorR + hD * 0.4], [xeF, floorR + hD * 0.4 + 0.012], [xa2, floorR + 0.008]], -hwD, hwD, 'z');
      var nf = S.diffuser === 'race' ? 5 : 3;
      for (var i = 0; i < nf; i++) {
        var zf = lerp(-hwD * 0.85, hwD * 0.85, nf === 1 ? 0.5 : i / (nf - 1));
        emitPrism(B, mt, [[xa2 + 0.1, floorR], [xeF + 0.002, floorR + hD * 0.4], [xeF + 0.002, floorR - hD * 0.5 + 0.04], [xeF + 0.11, floorR - hD * 0.35 + 0.02]], zf - 0.004, zf + 0.004, 'z');
      }
    }
    // ---- side skirts: a slim blade under the sill whose outer face sits ~1 cm proud of the narrowest sill point
    if (S.sideSkirts) {
      var xs0 = aF.x - aF.r - 0.04, xs1 = aR.x + aR.r + 0.04;
      if (xs0 - xs1 > 0.4) {
        var ySk = Math.max(floorF, num(f.dims.rideHeight, 0.12)) + 0.02, zSk = Infinity;
        [0.1, 0.5, 0.9].forEach(function (t) { var z = Sh.sideZ(lerp(xs1, xs0, t), ySk + 0.045); if (z !== null) zSk = Math.min(zSk, z); });
        if (!isFinite(zSk)) zSk = Sh.hw * 0.95;
        [1, -1].forEach(function (s) { emitBox(B, carbonish(S.splitter || 'carbon'), [(xs0 + xs1) / 2, ySk, s * (zSk - 0.012)], [xs0 - xs1, 0.06, 0.044], 0); });
      }
    }
    // ---- canards: small blades on the bumper corners, both ends on the skin (no blade ahead of a rounded nose)
    if (S.canards) {
      var xc = xF - 0.16, yc = (floorF + Sh.noseY) / 2, zcR = Sh.sideZ(xc - 0.08, yc), zcF = null, xcF = xc + 0.1;
      for (var tries = 0; tries < 4 && zcF === null; tries++) { zcF = Sh.sideZ(xcF, yc); if (zcF === null) xcF -= 0.03; }
      if (zcR !== null && zcF !== null) {
        [1, -1].forEach(function (s) {
          B.poly('carbon', [[xcF, yc - 0.02, s * (zcF - 0.004)], [xc - 0.08, yc + 0.04, s * (zcR + 0.04)], [xc - 0.08, yc + 0.015, s * (zcR + 0.05)]], [0, 1, 0]);
          B.poly('carbon', [[xcF, yc - 0.02, s * (zcF - 0.004)], [xc - 0.08, yc + 0.015, s * (zcR + 0.05)], [xc - 0.08, yc + 0.04, s * (zcR + 0.04)]], [0, -1, 0]);
        });
      }
    }
    // ---- wings
    if (S.wing) {
      var xw = xR + Math.min(0.32, (aR.x - aR.r - xR) * 0.6 + 0.05);
      var deck = Sh.topAt(xw, 0);
      if (deck === null) deck = Sh.deckY;
      var span = Sh.hwAt(xw) * 2 * 0.88;
      if (S.wing === 'lip-spoiler' || S.wing === 'ducktail') {
        var xe = xR + 0.03, de = Sh.topAt(xR + 0.06, 0) || deck, hL = S.wing === 'ducktail' ? 0.075 : 0.035, Lw = S.wing === 'ducktail' ? 0.34 : 0.16;
        var dl = Sh.topAt(xe + Lw, 0) || de;
        emitPrism(B, 'paint', [[xe + Lw, dl - 0.01], [xe + Lw * 0.5, de + hL * 0.45], [xe, de + hL], [xe - 0.015, de + hL - 0.01], [xe, de - 0.02]], -Sh.hwAt(xe + 0.1) * 0.86, Sh.hwAt(xe + 0.1) * 0.86, 'z');
      } else {
        var wingAcc = new Acc(), WB = { poly: function (m, pts, hint) { var R = B.colors.resolve(m); return emitPoly(wingAcc, pts, R ? R.c : PAL.carbon, hint); } };
        var chord = S.wing === 'active' ? 0.26 : 0.3, ang = num(S.wingAngle, 6 * DEG);
        var h = S.wing === 'active' ? 0.05 : S.wing === 'swan-neck' ? 0.3 : 0.27;
        var roofCap = Sh.roofY + 0.02;
        var yw = Math.min(deck + h, roofCap);
        var xle = xw + chord * 0.55;
        function airfoil(yb0) {
          var raw = [[0, 0], [0.12, 0.026], [0.45, 0.034], [1, 0.012], [1, 0.002], [0.5, -0.004], [0.12, -0.01]];
          var ca = Math.cos(ang), sa = Math.sin(ang);
          return raw.map(function (q) {
            var u = q[0] * chord, v = q[1] * (chord / 0.3);   // trailing edge rises with the wing angle
            return [xle - u * ca - v * sa, yb0 + v * ca + u * sa];
          });
        }
        var planes = S.wing === 'biplane' ? [yw, yw - 0.1] : [yw];
        planes.forEach(function (yp) { emitPrism(WB, 'carbon', airfoil(yp), -span / 2, span / 2, 'z'); });
        if (S.wing !== 'active') {
          [1, -1].forEach(function (s) {
            emitBox(WB, 'carbon', [xle - chord * 0.5, yw - 0.03, s * (span / 2 + 0.004)], [chord * 1.15, 0.2, 0.008], 0);
            var zu = s * Math.min(span * 0.3, 0.42);
            if (S.wing === 'swan-neck') {
              emitBox(WB, 'carbon', [xle - chord * 0.35, (deck + yw + 0.06) / 2, zu], [0.1, yw + 0.06 - deck, 0.014], 0);
            } else emitBox(WB, 'carbon', [xle - chord * 0.45, (deck + yw) / 2, zu], [0.12, Math.max(0.04, yw - deck), 0.014], 0);
          });
        }
        B.wing = { acc: wingAcc, pivot: [xle, yw], active: S.wing === 'active' || !!S.activeAero, base: ang };
      }
    }
    // ---- exhaust tips
    var SH = shapeLib(), ex = exTips || (f.rear && f.rear.exhaust) || [];
    if (!S.ev && S.exhaust !== null) {
      ex.forEach(function (t) {
        if (!t || t.shape === 'hidden' || !isFinite(t.cx) || !isFinite(t.cy)) return;
        var z = t.cx, y = t.cy, xh = Sh.rearX(y, z);
        if (xh === null) xh = xR + 0.05;
        var w = Math.max(0.04, num(t.w, 0.09)), hh = Math.max(0.04, num(t.h, w));
        if (t.shape === 'trapezoid') emitBox(B, 'chrome', [xh - 0.005, y, z], [0.07, hh, w], 0);
        else emitCyl(B, 'chrome', [xh - 0.01, y, z], w / 2, hh / 2, 0.08, 'x', 8);
        B.poly('grille', (function () { var P = []; for (var k = 0; k < 8; k++) { var a = (k + 0.5) / 8 * TAU; P.push([xh - 0.051, y + Math.sin(a) * hh * 0.4, z + Math.cos(a) * w * 0.4]); } return P; })(), [-1, 0, 0]);
        anchors.exhaust.push([xh - 0.05, y, z]);
      });
    }
    void SH;
    // ---- race number roundels on the doors
    if (S.number) {
      var xd = lerp(aR.x + aR.r, aF.x - aF.r, 0.6), yTop = Math.max(aF.cy + aF.r, aR.cy + aR.r), yd = lerp(yTop, Sh.beltY, 0.45);
      var rad = clamp(Math.min((Sh.beltY - yTop) * 0.42, (aF.x - aF.r - (aR.x + aR.r)) * 0.22), 0.1, 0.24);
      var zd = Sh.sideZ(xd, yd);
      if (zd !== null && rad > 0.05) {
        [1, -1].forEach(function (s) {
          var nz = s, zz = s * (zd + 0.012), disc = [];
          for (var k = 0; k < 12; k++) { var a = (k + 0.5) / 12 * TAU; disc.push([xd + Math.cos(a) * rad, yd + Math.sin(a) * rad, zz]); }
          B.poly('white', disc, [0, 0, nz]);
          digits(B, String(S.number), xd, yd, rad * 1.1, s * (zd + 0.016), s);
        });
      }
    }
  }
  // seven-segment digits as flat quads in the z plane (s: +1 right flank reading front->rear... x flips for the left)
  var SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };
  function digits(B, str, xc, yc, h, z, s) {
    str = str.replace(/[^0-9]/g, '').slice(0, 2);
    if (!str) return;
    var dh = h * 0.95, dw = dh * 0.55, t = dh * 0.13, gap = dw * 0.35, n = str.length, total = n * dw + (n - 1) * gap;
    for (var i = 0; i < n; i++) {
      var segs = SEG[str[i]] || '';
      // right flank seen from +z: the viewer's right is +x (text runs rear -> front); left flank: -x
      var ui = -total / 2 + i * (dw + gap) + dw / 2;
      var R = {
        a: [-dw / 2, dh / 2 - t, dw / 2, dh / 2], g: [-dw / 2, -t / 2, dw / 2, t / 2], d: [-dw / 2, -dh / 2, dw / 2, -dh / 2 + t],
        f: [-dw / 2, 0, -dw / 2 + t, dh / 2], b: [dw / 2 - t, 0, dw / 2, dh / 2], e: [-dw / 2, -dh / 2, -dw / 2 + t, 0], c: [dw / 2 - t, -dh / 2, dw / 2, 0]
      };
      for (var k = 0; k < segs.length; k++) {
        var r = R[segs[k]];
        var x0 = xc + s * (ui + r[0]), x1 = xc + s * (ui + r[2]);
        B.poly('black', [[x0, yc + r[1], z], [x1, yc + r[1], z], [x1, yc + r[3], z], [x0, yc + r[3], z]], [0, 0, s]);
      }
    }
  }

  /* ================================================================ API */
  LP.register = register;
  LP.has = function (id) { return !!defs[id]; };
  LP.get = function (id) { return defs[id] || null; };
  LP.list = function () { return Object.keys(defs); };
  LP.errors = function (id) { return errorsById[id] || []; };
  LP.validate = validate;
  LP.autoDef = autoDef;
  LP.build = build;
  LP.carStyle = carStyle;
  LP.materials = materials;
  LP.PAL = PAL;
  LP.MATS = MATS.slice();
  LP.clearCache = function () { compiled = {}; autoCache = {}; };
  LP._ = { earClip: earClip, clipConvex: clipConvex, projectOutline: projectOutline, planeDecal: planeDecal, clampFlare: clampFlare, exhaustTips: exhaustTips, wellGrid: wellGrid, wheelGeo: wheelGeo, compile: compile, sampleHalf: sampleHalf, simplifyClosed: simplifyClosed };
  // drain definitions queued before this script loaded
  var pend = LP._pending;
  LP._pending = { push: function () { for (var i = 0; i < arguments.length; i++) { var e = arguments[i]; if (e) register(e[0], e[1]); } return 0; } };
  if (Array.isArray(pend)) pend.forEach(function (e) { if (e) register(e[0], e[1]); });
  if (typeof module !== 'undefined' && module.exports) module.exports = LP;
})();

/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/coupe.js
   Hand-authored low-poly coupés (docs/LOWPOLY-SPEC.md): BMW M4 (G82), Toyota GR Supra (A90), BMW M2 (G87),
   BMW M3 (E46), Aston Martin Vantage (2018), Alpine A110 (2017), Lotus Emira.

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.

   Every body uses the same 12-point ring so the glass / roof / pillar bands stay clean strips:
     0 bottom centre, 1 bottom edge, 2 sill / rocker top, 3 waist (widest), 4 shoulder, 5 belt (outer edge),
     6 glass base (just inboard of the belt), 7 roof rail (top of the side glass), 8 roof edge (outer edge of the
     A/C-pillar / roof), 9 roof quarter, 10 roof inner, 11 centre line (bonnet / windscreen / roof / deck).
   The rings are lofted from per-car side/plan profile tables (piecewise linear in x, measured off the
   reference photos with the wheelbase as the pixel scale) with per-station overrides where a section needs
   hand shaping (nose, tail, haunches).
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  var LP = CB.lowpoly = CB.lowpoly || {};
  function reg(id, def) {
    if (typeof LP.register === 'function' && !Array.isArray(LP._pending)) LP.register(id, def);
    else (LP._pending = LP._pending || []).push([id, def]);
  }

  /* ---------------------------------------------------------------- helpers */
  function rect(a0, b0, a1, b1) { return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]; }
  function ell(a, b, ra, rb, n, rot) {
    var out = [], r = rot || 0;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n * Math.PI * 2, u = Math.cos(t) * ra, v = Math.sin(t) * rb;
      out.push([a + u * Math.cos(r) - v * Math.sin(r), b + u * Math.sin(r) + v * Math.cos(r)]);
    }
    return out;
  }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  function P(view, mat, off, pts, mirror) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: mirror !== false, pts: pts }; }
  /** flared arch band (side profile) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, a0d, a1d) {
    var parts = [], n = segs || 6, A0 = (a0d == null ? 0 : a0d) * Math.PI / 180, A1 = (a1d == null ? 180 : a1d) * Math.PI / 180;
    for (var k = 0; k < n; k++) {
      var a0 = A0 + (A1 - A0) * k / n, a1 = A0 + (A1 - A0) * (k + 1) / n;
      var Q = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [Q(rIn, a0), Q(rOut, a0), Q(rOut, a1), Q(rIn, a1)] });
    }
    return parts;
  }
  /** piecewise-linear table [[x, v0, v1, ...], ...] -> f(x) = [v0, v1, ...] (held flat past the ends) */
  function T(rows) {
    rows = rows.slice().sort(function (a, b) { return b[0] - a[0]; });   // descending x
    return function (x) {
      if (x >= rows[0][0]) return rows[0].slice(1);
      var last = rows[rows.length - 1];
      if (x <= last[0]) return last.slice(1);
      for (var i = 0; i < rows.length - 1; i++) {
        var A = rows[i], B = rows[i + 1];
        if (x <= A[0] && x >= B[0]) {
          var t = (A[0] - x) / ((A[0] - B[0]) || 1), out = [];
          for (var k = 1; k < A.length; k++) out.push(A[k] + (B[k] - A[k]) * t);
          return out;
        }
      }
      return last.slice(1);
    };
  }
  function inR(x, ranges) {
    for (var i = 0; i < (ranges || []).length; i++) if (x <= Math.max(ranges[i][0], ranges[i][1]) && x >= Math.min(ranges[i][0], ranges[i][1])) return true;
    return false;
  }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  /**
   * loft a 12-point coupé body from profile tables.
   * S: { xs:[...desc], bot:[x,y,z], sill:[x,y,z], waist:[x,y,z], shoulder?:[x,y,z], belt:[x,y,z], rail:[x,y,z],
   *      top:[x,y], roofK?:[x,k8,k9,k10] (fractions of top-rail rise), over:{x:{i:[y,z]}},
   *      ws:[x0,x1] windscreen, rw:[x0,x1] rear glass, side:[[x0,x1]..] side glass, roofMat, pillarMat, sillMat:[[x0,x1]..] }
   */
  function loft(S) {
    var bot = T(S.bot), sill = T(S.sill), waist = T(S.waist), belt = T(S.belt), rail = T(S.rail), top = T(S.top);
    var shoulder = S.shoulder ? T(S.shoulder) : null, gb = S.gb ? T(S.gb) : null;
    var rk = T(S.roofK || [[0, 0.3, 0.72, 0.94]]), rz = T(S.roofZ || [[0, 0.86, 0.56, 0.26]]);
    var xs = S.xs.slice(), taper = S.taper;
    if (S.round) {   // [xTail, len, zScaleAtTail, yDropAtTail]: quarter-ellipse plan / profile round-off of the tail
      var R = S.round, us = [1, 0.7, 0.45, 0.25, 0.1, 0];
      taper = us.map(function (u) { var fq = Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u))); return [R[0] + R[1] * u, R[2] + (1 - R[2]) * fq, R[3] * (1 - fq)]; });
      xs = xs.filter(function (x) { return x > R[0] + R[1] * 0.7 + 0.04 || x === xs[xs.length - 1]; });
      us.slice(1, -1).forEach(function (u) { xs.push(r3(R[0] + R[1] * u)); });
      xs.sort(function (a, b) { return b - a; });
    }
    var tz = T(taper || [[0, 1, 0]]);   // [x, z scale, y drop] for rounded nose / tail bevels
    var stations = xs.map(function (x) {
      var b = bot(x), s = sill(x), w = waist(x), bl = belt(x), rl = rail(x), t = top(x)[0], k = rk(x), kz = rz(x);
      var sh = shoulder ? shoulder(x) : [(w[0] + bl[0]) / 2 + 0.02, (w[1] + bl[1]) / 2 + 0.008];
      var g = gb ? gb(x) : [bl[0] + 0.012, bl[1] - 0.035];
      var pts = [[b[0], 0], [b[0], b[1]], s, w, sh, bl, g, rl,
        [rl[0] + (t - rl[0]) * k[0], rl[1] * kz[0]], [rl[0] + (t - rl[0]) * k[1], rl[1] * kz[1]], [rl[0] + (t - rl[0]) * k[2], rl[1] * kz[2]], [t, 0]];
      var tp = tz(x);
      if (tp[0] !== 1 || tp[1]) pts = pts.map(function (p, i) { return [i === 0 || i === 1 ? p[0] + tp[1] * 0.4 : p[0] - tp[1] * (i / 11), p[1] * tp[0]]; });
      var o = S.over && S.over[x];
      if (o) Object.keys(o).forEach(function (i) { pts[+i] = o[i]; });
      return { x: x, pts: pts.map(function (p) { return [r3(p[0]), r3(Math.max(0, p[1]))]; }) };
    });
    var mats = [];
    for (var i = 0; i < stations.length - 1; i++) {
      var xm = (stations[i].x + stations[i + 1].x) / 2, row = [];
      var cab = xm <= Math.max(S.ws[0], S.ws[1]) && xm >= Math.min(S.rw[0], S.rw[1]);
      for (var j = 0; j < 11; j++) {
        var m = 'paint';
        if (j === 0) m = 'black';
        else if (j === 1) m = inR(xm, S.sillMat) ? 'black' : 'paint';
        else if (j === 6) m = inR(xm, S.side) ? 'glass' : (cab ? (S.pillarMat || 'paint') : 'paint');
        else if (j === 7) m = cab ? (S.railMat || 'paint') : 'paint';
        else if (j >= 8) m = inR(xm, [S.ws]) ? 'glass' : inR(xm, [S.rw]) ? 'glass' : cab ? (S.roofMat || 'paint') : 'paint';
        if (S.mat) m = S.mat(i, j, xm, m) || m;
        row.push(m);
      }
      mats.push(row);
    }
    return { stations: stations, mats: mats, capF: S.capF || 'paint', capR: S.capR || 'paint' };
  }
  /** a pair of door mirrors: body-colour housing (side profile) on a black foot */
  function mirrors(x0, x1, y0, y1, z0, z1, footZ) {
    return [
      { t: 'prism', mat: 'mirror', mirror: true, z0: z0, z1: z1, pts2d: [[x1, y0 + 0.01], [x0 + 0.02, y0], [x0, y1 - 0.01], [x1 - 0.03, y1]] },
      { t: 'box', mat: 'black', mirror: true, c: [(x0 + x1) / 2 + 0.03, y0 + 0.01, (footZ + z0) / 2 + 0.02], s: [0.09, 0.035, z0 - footZ + 0.08] }
    ];
  }
  function tips(x, y, z, r, l, n, dz, mat) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ t: 'cyl', mat: mat || 'chrome', mirror: true, c: [x, y, z + i * (dz || 0)], r: r, l: l, axis: 'x', sides: 8 });
    return out;
  }

  /** rounded tail in plan: z scale falling off over the last `len` metres to the tail x */
  function rearTaper(xT, len, k) {
    k = k || 0.8;
    return [[xT + len, 1, 0], [xT + len * 0.45, 1 - (1 - k) * 0.2, 0], [xT + len * 0.15, 1 - (1 - k) * 0.55, 0.01], [xT, k, 0.03]];
  }

  var DEFS = {};

  /* ================================================================ BMW M4 Competition (G82) */
  // L 4.794 W 1.887 H 1.393 WB 2.857; nose x 2.2985, tail x -2.4955, axles +-1.4285.
  DEFS['bmw-m4-g82'] = (function () {
    var body = loft({
      xs: [2.2985, 2.26, 2.16, 1.92, 1.43, 0.60, 0.20, -0.30, -0.80, -1.15, -1.45, -1.82, -2.36, -2.44, -2.4955],
      taper: rearTaper(-2.4955, 0.40, 0.86),
      bot: [[2.2985, 0.24, 0.58], [2.20, 0.20, 0.78], [1.9, 0.16, 0.84], [1.43, 0.15, 0.85], [-1.43, 0.15, 0.86], [-2.2, 0.22, 0.84], [-2.4955, 0.30, 0.70]],
      sill: [[2.2985, 0.28, 0.66], [2.27, 0.26, 0.76], [2.20, 0.24, 0.86], [1.9, 0.27, 0.90], [1.43, 0.30, 0.91], [0.8, 0.30, 0.905], [-0.9, 0.30, 0.91], [-1.43, 0.30, 0.925], [-2.2, 0.32, 0.90], [-2.38, 0.34, 0.86], [-2.4955, 0.38, 0.76]],
      waist: [[2.2985, 0.48, 0.70], [2.27, 0.50, 0.80], [2.20, 0.55, 0.88], [2.02, 0.60, 0.925], [1.43, 0.66, 0.935], [0.8, 0.64, 0.918], [0.0, 0.62, 0.912], [-0.95, 0.66, 0.93], [-1.43, 0.70, 0.9435], [-1.95, 0.70, 0.935], [-2.20, 0.70, 0.91], [-2.38, 0.68, 0.87], [-2.4955, 0.62, 0.78]],
      shoulder: [[2.2985, 0.62, 0.69], [2.27, 0.66, 0.785], [2.2, 0.72, 0.86], [2.02, 0.77, 0.905], [1.43, 0.82, 0.925], [0.8, 0.835, 0.912], [0.0, 0.85, 0.906], [-0.95, 0.875, 0.925], [-1.43, 0.895, 0.935], [-1.95, 0.915, 0.915], [-2.2, 0.925, 0.87], [-2.38, 0.92, 0.82], [-2.4955, 0.86, 0.71]],
      belt: [[2.2985, 0.7, 0.6], [2.27, 0.75, 0.7], [2.2, 0.8, 0.78], [2.02, 0.85, 0.82], [1.43, 0.905, 0.835], [0.8, 0.945, 0.835], [0.6, 0.96, 0.83], [0.0, 0.98, 0.825], [-0.95, 0.995, 0.835], [-1.45, 1.01, 0.84], [-1.95, 1.025, 0.8], [-2.2, 1.035, 0.76], [-2.36, 1.04, 0.72], [-2.44, 0.98, 0.7], [-2.4955, 0.85, 0.64]],
      rail: [[2.2985, 0.73, 0.46], [2.26, 0.785, 0.57], [2.16, 0.83, 0.63], [1.92, 0.88, 0.665], [1.43, 0.935, 0.68], [0.95, 0.97, 0.70], [0.60, 0.99, 0.72], [0.20, 1.17, 0.68], [-0.30, 1.335, 0.62], [-0.80, 1.345, 0.60], [-1.15, 1.28, 0.62], [-1.45, 1.165, 0.66], [-1.82, 1.06, 0.70], [-2.12, 1.058, 0.68], [-2.36, 1.062, 0.61], [-2.44, 1.0, 0.56], [-2.4955, 0.86, 0.50]],
      top: [[2.2985, 0.745], [2.26, 0.80], [2.16, 0.845], [1.92, 0.895], [1.43, 0.95], [0.95, 0.99], [0.60, 1.02], [0.20, 1.21], [-0.30, 1.378], [-0.80, 1.388], [-1.15, 1.322], [-1.45, 1.195], [-1.82, 1.068], [-2.12, 1.065], [-2.36, 1.075], [-2.44, 1.01], [-2.4955, 0.87]],
      roofK: [[0, 0.35, 0.78, 0.95]],
      ws: [0.60, -0.30], rw: [-1.15, -1.82], side: [[0.50, -1.45]],
      roofMat: 'black', pillarMat: 'paint',
      sillMat: [[2.3, 2.15], [1.0, -1.0], [-2.3, -2.5]],
      over: {
        '2.2985': { 0: [0.24, 0] }
      }
    });
    var parts = [].concat(
      // tall M kidney grilles (signature): chrome-ish surround, black slats grid
      [P('front', 'gloss', 0.004, [[0.025, 0.29], [0.30, 0.29], [0.33, 0.35], [0.33, 0.72], [0.29, 0.79], [0.05, 0.79], [0.025, 0.75]]),
       P('front', 'grille', 0.008, [[0.045, 0.31], [0.29, 0.31], [0.31, 0.36], [0.31, 0.71], [0.28, 0.77], [0.06, 0.77], [0.045, 0.74]])],
      // slim angled headlamps (two-row LED with the hexagonal DRL eyebrow)
      [P('front', 'gloss', 0.006, [[0.36, 0.64], [0.58, 0.665], [0.78, 0.735], [0.80, 0.775], [0.60, 0.78], [0.38, 0.745]]),
       P('front', 'light', 0.009, [[0.40, 0.665], [0.57, 0.685], [0.74, 0.745], [0.76, 0.765], [0.60, 0.765], [0.41, 0.735]]),
       P('front', 'drl', 0.012, [[0.40, 0.725], [0.60, 0.752], [0.76, 0.762], [0.60, 0.764], [0.41, 0.738]])],
      // lower bumper: big outer intakes with the vertical blades, centre lip
      [P('front', 'grille', 0.005, [[0.42, 0.24], [0.74, 0.27], [0.80, 0.50], [0.56, 0.52], [0.44, 0.44]]),
       P('front', 'black', 0.009, [[0.60, 0.28], [0.63, 0.28], [0.67, 0.50], [0.64, 0.50]]),
       P('front', 'grille', 0.005, rect(-0.30, 0.22, 0.30, 0.29), false),
       P('front', 'plate', 0.012, rect(-0.26, 0.36, 0.26, 0.47), false)],
      // bonnet power-dome creases
      polys([[[2.15, 0.10], [0.70, 0.16], [0.70, 0.19], [2.15, 0.13]]], 'top', 'black', 0.003, true).slice(0, 0),
      // side: front-wing "breather" gill behind the front wheel, flush door handle, Hofmeister kink trim
      // M "breather" gill behind the front wheel (gloss black, slanted), quarter-glass divider, Hofmeister kink
      [P('side', 'gloss', 0.006, [[0.99, 0.62], [1.04, 0.63], [0.95, 0.88], [0.90, 0.87]]),
       P('side', 'gloss', 0.008, [[-0.93, 0.99], [-0.96, 0.99], [-0.96, 1.33], [-0.93, 1.33]]),
       P('side', 'paint', 0.008, [[-1.04, 1.31], [-1.20, 1.33], [-1.56, 1.2], [-1.56, 1.0], [-1.40, 1.0], [-1.39, 1.03], [-1.47, 1.075]]),
       P('side', 'gloss', 0.007, [[0.45, 0.968], [-1.39, 1.012], [-1.39, 1.032], [0.45, 0.99]]),
       P('side', 'black', 0.004, [[-0.28, 0.915], [-0.12, 0.915], [-0.12, 0.935], [-0.28, 0.935]])],
      // rear: L-shaped laser tail lamps reaching into the wings, black diffuser with four tips
      [P('rear', 'tail', 0.006, [[0.30, 0.885], [0.60, 0.87], [0.82, 0.90], [0.83, 1.0], [0.55, 1.005], [0.30, 0.955]]),
       P('rear', 'gloss', 0.009, [[0.42, 0.915], [0.74, 0.915], [0.74, 0.932], [0.42, 0.935]]),
       P('rear', 'black', 0.004, [[-0.80, 0.24], [0.80, 0.24], [0.80, 0.40], [0.66, 0.46], [-0.66, 0.46], [-0.80, 0.40]], false),
       P('rear', 'plate', 0.008, rect(-0.26, 0.76, 0.26, 0.87), false)],
      mirrors(0.36, 0.60, 0.955, 1.075, 0.80, 0.985, 0.78)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 10 },
      notes: 'BMW M4 Competition (G82) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2021_BMW_M4_Competition_G82_front.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2021_BMW_M4_Competition_G82_rear.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:BMW_M4_(G82)_IMG_4184.jpg.'
    };
  })();

  /* ================================================================ Toyota GR Supra (A90) */
  // L 4.379 W 1.854 H 1.292 WB 2.47; nose x 2.225, tail x -2.154, axles +-1.235.
  // Signature: long low bonnet with a pointed nose, cabin set far back, double-bubble roof, huge rear haunches
  // that stand proud of a narrow glasshouse, integrated ducktail, slim tail lamps, big central lower grille.
  DEFS['toyota-gr-supra-a90'] = (function () {
    var body = loft({
      xs: [2.225, 2.19, 2.10, 1.90, 1.235, 0.42, 0.05, -0.35, -0.75, -1.05, -1.30, -1.58, -1.90, -2.08, -2.154],
      taper: rearTaper(-2.154, 0.45, 0.78),
      bot: [[2.225, 0.22, 0.25], [2.10, 0.17, 0.60], [1.9, 0.15, 0.78], [1.235, 0.14, 0.80], [-1.235, 0.15, 0.82], [-1.9, 0.22, 0.80], [-2.154, 0.30, 0.62]],
      sill: [[2.225, 0.26, 0.32], [2.19, 0.24, 0.5], [2.1, 0.22, 0.72], [1.9, 0.24, 0.84], [1.235, 0.28, 0.87], [0.42, 0.29, 0.84], [-0.35, 0.29, 0.80], [-0.75, 0.29, 0.82], [-1.235, 0.3, 0.885], [-1.9, 0.32, 0.86], [-2.08, 0.34, 0.8], [-2.154, 0.38, 0.7]],
      waist: [[2.225, 0.42, 0.36], [2.19, 0.46, 0.58], [2.1, 0.5, 0.78], [1.9, 0.56, 0.88], [1.235, 0.62, 0.905], [0.42, 0.58, 0.865], [-0.35, 0.52, 0.81], [-0.75, 0.58, 0.855], [-1.05, 0.66, 0.915], [-1.3, 0.71, 0.927], [-1.58, 0.73, 0.925], [-1.9, 0.73, 0.9], [-2.08, 0.71, 0.85], [-2.154, 0.66, 0.74]],
      shoulder: [[2.225, 0.55, 0.33], [2.19, 0.6, 0.52], [2.1, 0.66, 0.7], [1.9, 0.73, 0.83], [1.235, 0.8, 0.87], [0.42, 0.84, 0.82], [-0.35, 0.84, 0.75], [-0.75, 0.88, 0.805], [-1.05, 0.925, 0.885], [-1.3, 0.955, 0.91], [-1.58, 0.97, 0.9], [-1.9, 0.975, 0.855], [-2.08, 0.97, 0.79], [-2.154, 0.9, 0.68]],
      belt: [[2.225, 0.6, 0.28], [2.19, 0.66, 0.46], [2.1, 0.72, 0.62], [1.9, 0.825, 0.75], [1.235, 0.905, 0.8], [0.42, 0.925, 0.765], [0.05, 0.93, 0.725], [-0.35, 0.94, 0.705], [-0.75, 0.965, 0.74], [-1.05, 0.995, 0.815], [-1.3, 1.015, 0.855], [-1.58, 1.025, 0.84], [-1.9, 1.03, 0.77], [-2.08, 1.035, 0.68], [-2.154, 0.92, 0.58]],
      gb: [[2.225, 0.61, 0.24], [2.19, 0.67, 0.40], [2.10, 0.725, 0.55], [1.9, 0.80, 0.68], [1.235, 0.875, 0.73], [0.42, 0.94, 0.74], [-0.35, 0.96, 0.685], [-1.05, 1.0, 0.665], [-1.30, 1.02, 0.635], [-1.58, 1.03, 0.60], [-1.9, 1.035, 0.56], [-2.08, 1.045, 0.50], [-2.154, 0.93, 0.45]],
      rail: [[2.225, 0.615, 0.18], [2.19, 0.68, 0.32], [2.10, 0.71, 0.45], [1.9, 0.775, 0.55], [1.235, 0.845, 0.60], [0.42, 0.945, 0.66], [0.05, 1.10, 0.62], [-0.35, 1.245, 0.56], [-0.75, 1.262, 0.54], [-1.05, 1.215, 0.55], [-1.30, 1.12, 0.56], [-1.58, 1.04, 0.56], [-1.90, 1.047, 0.52], [-2.08, 1.085, 0.46], [-2.154, 0.945, 0.40]],
      top: [[2.225, 0.60], [2.19, 0.66], [2.10, 0.70], [1.9, 0.76], [1.235, 0.835], [0.42, 0.95], [0.05, 1.15], [-0.35, 1.268], [-0.75, 1.275], [-1.05, 1.235], [-1.30, 1.14], [-1.58, 1.045], [-1.90, 1.052], [-2.08, 1.095], [-2.154, 0.95]],
      // double-bubble roof: the roof quarters stand ~2 cm above the centre line
      roofK: [[0.42, 0.35, 0.78, 0.95], [-0.35, 0.6, 2.0, 1.45], [-0.75, 0.6, 2.0, 1.45], [-1.05, 0.45, 1.3, 1.1], [-1.30, 0.35, 0.78, 0.95]],
      roofZ: [[0, 0.86, 0.6, 0.3]],
      ws: [0.42, -0.35], rw: [-1.05, -1.58], side: [[0.36, -1.30]],
      pillarMat: 'black', roofMat: 'paint2', railMat: 'black',
      sillMat: [[2.3, 2.0], [0.9, -0.9], [-1.95, -2.2]]
    });
    var parts = [].concat(
      // big central lower grille (trapezoid) with the nose badge above it, vertical outer intakes
      [P('front', 'grille', 0.005, [[0, 0.17], [0.40, 0.19], [0.47, 0.40], [0.30, 0.45], [0, 0.45]]),
       P('front', 'gloss', 0.004, [[0.56, 0.20], [0.72, 0.25], [0.79, 0.52], [0.66, 0.50]]),
       P('front', 'badge', 0.008, ell(0, 0.53, 0.04, 0.03, 6), false)],
      // slim swept headlamps on the front corners (six-LED projectors + DRL strip)
      [P('front', 'gloss', 0.006, [[0.33, 0.56], [0.60, 0.58], [0.82, 0.655], [0.85, 0.765], [0.66, 0.745], [0.35, 0.625]]),
       P('front', 'light', 0.009, [[0.39, 0.578], [0.60, 0.595], [0.79, 0.665], [0.81, 0.735], [0.64, 0.715], [0.40, 0.615]]),
       P('front', 'drl', 0.012, [[0.40, 0.57], [0.62, 0.585], [0.82, 0.66], [0.82, 0.672], [0.62, 0.597], [0.40, 0.582]])],
      // bonnet vents + door-side intake, door handle
      [P('top', 'black', 0.004, [[0.78, 0.40], [0.80, 0.43], [0.50, 0.53], [0.48, 0.50]]),
       P('side', 'black', 0.004, [[0.72, 0.56], [0.76, 0.56], [0.86, 0.76], [0.82, 0.76]]),
       P('side', 'black', 0.004, rect(-0.40, 0.87, -0.26, 0.89))],
      // rear: slim tail lamps under the ducktail, black diffuser with the centre fog lamp, twin round tips
      [P('rear', 'tail', 0.006, [[0.24, 0.905], [0.58, 0.88], [0.76, 0.895], [0.80, 0.975], [0.62, 0.97], [0.24, 0.955]]),
       P('rear', 'gloss', 0.004, [[-0.80, 0.20], [0.80, 0.20], [0.78, 0.43], [0.62, 0.45], [-0.62, 0.45], [-0.78, 0.43]], false),
       P('rear', 'tail', 0.008, rect(-0.04, 0.30, 0.04, 0.38), false),
       P('rear', 'plate', 0.008, rect(-0.26, 0.60, 0.26, 0.72), false),
       P('rear', 'badge', 0.008, ell(0, 0.82, 0.035, 0.035, 6), false),
       P('rear', 'gloss', 0.007, [[0.56, 0.30], [0.70, 0.32], [0.70, 0.56], [0.60, 0.52]]),
       P('side', 'tail', 0.006, [[-1.80, 0.50], [-1.86, 0.50], [-1.90, 0.66], [-1.84, 0.66]])],
      mirrors(0.22, 0.44, 0.92, 1.03, 0.72, 0.90, 0.70)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 5 },
      notes: 'Toyota GR Supra (A90) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2020_Toyota_Supra_front_NYIAS_2019.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2020_Toyota_Supra_rear_NYIAS_2019.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Toyota_GR_Supra_SZ_(3BA-DB82-ZSRW)_right.jpg (side 3/4).'
    };
  })();

  /* ================================================================ BMW M2 (G87) */
  // L 4.58 W 1.887 H 1.403 WB 2.747; nose x 2.2405, tail x -2.3395, axles +-1.3735.
  // Signature: blunt upright nose with wide frameless horizontal kidneys, squared corner intakes, boxy
  // box-flared wheel arches, upright glasshouse with the Hofmeister kink, short tall tail, L tail lamps, 4 tips.
  DEFS['bmw-m2-g87'] = (function () {
    var body = loft({
      xs: [2.2405, 2.215, 2.13, 1.90, 1.3735, 0.95, 0.50, -0.02, -0.55, -1.00, -1.30, -1.72, -2.20, -2.29, -2.3395],
      taper: rearTaper(-2.3395, 0.40, 0.86),
      bot: [[2.2405, 0.24, 0.60], [2.13, 0.19, 0.80], [1.9, 0.16, 0.85], [1.37, 0.15, 0.86], [-1.37, 0.15, 0.87], [-2.2, 0.24, 0.84], [-2.3395, 0.30, 0.70]],
      sill: [[2.2405, 0.27, 0.70], [2.215, 0.26, 0.80], [2.13, 0.25, 0.88], [1.9, 0.27, 0.915], [1.3735, 0.30, 0.925], [0.55, 0.30, 0.89], [-0.65, 0.30, 0.89], [-1.3735, 0.30, 0.93], [-2.2, 0.33, 0.91], [-2.29, 0.35, 0.86], [-2.3395, 0.38, 0.78]],
      waist: [[2.2405, 0.48, 0.74], [2.215, 0.50, 0.84], [2.13, 0.55, 0.91], [1.9, 0.62, 0.94], [1.3735, 0.66, 0.9435], [0.55, 0.64, 0.905], [-0.25, 0.62, 0.90], [-1.00, 0.66, 0.93], [-1.3735, 0.70, 0.9435], [-1.72, 0.70, 0.94], [-2.20, 0.70, 0.915], [-2.29, 0.68, 0.875], [-2.3395, 0.62, 0.80]],
      shoulder: [[2.2405, 0.62, 0.73], [2.215, 0.66, 0.825], [2.13, 0.72, 0.895], [1.9, 0.78, 0.932], [1.3735, 0.82, 0.938], [0.95, 0.84, 0.915], [0.55, 0.85, 0.902], [-0.25, 0.86, 0.897], [-0.85, 0.875, 0.915], [-1.3735, 0.89, 0.938], [-1.72, 0.905, 0.93], [-2.2, 0.925, 0.89], [-2.29, 0.92, 0.84], [-2.3395, 0.86, 0.75]],
      belt: [[2.2405, 0.7, 0.66], [2.215, 0.745, 0.74], [2.13, 0.79, 0.8], [1.9, 0.845, 0.83], [1.3735, 0.9, 0.845], [0.55, 0.96, 0.835], [-0.25, 0.98, 0.83], [-1.0, 0.995, 0.84], [-1.3, 1.005, 0.845], [-1.72, 1.025, 0.825], [-2.2, 1.04, 0.78], [-2.29, 1.035, 0.74], [-2.3395, 0.93, 0.66]],
      rail: [[2.2405, 0.73, 0.50], [2.215, 0.775, 0.58], [2.13, 0.815, 0.64], [1.9, 0.865, 0.67], [1.3735, 0.925, 0.69], [0.95, 0.985, 0.73], [0.50, 1.19, 0.685], [-0.02, 1.35, 0.635], [-0.55, 1.37, 0.62], [-1.00, 1.335, 0.628], [-1.30, 1.24, 0.65], [-1.70, 1.08, 0.70], [-2.20, 1.068, 0.69], [-2.29, 1.06, 0.62], [-2.3395, 0.94, 0.52]],
      top: [[2.2405, 0.745], [2.215, 0.79], [2.13, 0.835], [1.9, 0.885], [1.3735, 0.94], [0.95, 1.008], [0.50, 1.24], [-0.02, 1.393], [-0.55, 1.403], [-1.00, 1.372], [-1.30, 1.275], [-1.70, 1.088], [-2.20, 1.078], [-2.29, 1.07], [-2.3395, 0.95]],
      roofK: [[0, 0.35, 0.78, 0.95]],
      ws: [0.95, -0.02], rw: [-1.00, -1.70], side: [[0.80, -1.30]],
      roofMat: 'black', pillarMat: 'paint',
      sillMat: [[2.3, 2.1], [1.0, -1.0], [-2.25, -2.4]]
    });
    var parts = [].concat(
      // wide frameless horizontal kidneys (signature), slim headlamps
      [P('front', 'grille', 0.006, [[0.03, 0.575], [0.30, 0.575], [0.31, 0.59], [0.31, 0.715], [0.29, 0.73], [0.04, 0.73], [0.03, 0.715]]),
       P('front', 'black', 0.009, rect(0.03, 0.635, 0.31, 0.65))],
      [P('front', 'gloss', 0.006, [[0.35, 0.66], [0.62, 0.67], [0.80, 0.715], [0.81, 0.77], [0.60, 0.775], [0.36, 0.735]]),
       P('front', 'light', 0.009, [[0.39, 0.675], [0.60, 0.685], [0.77, 0.725], [0.78, 0.76], [0.60, 0.762], [0.40, 0.725]]),
       P('front', 'drl', 0.012, [[0.40, 0.735], [0.60, 0.753], [0.77, 0.757], [0.60, 0.762], [0.41, 0.742]])],
      // squared corner intakes (body-colour frame, black insert), central lower intake, plate
      [P('front', 'gloss', 0.005, rect(0.50, 0.26, 0.80, 0.53)),
       P('front', 'paint', 0.008, rect(0.53, 0.37, 0.77, 0.40)),
       P('front', 'grille', 0.005, [[0, 0.21], [0.44, 0.22], [0.44, 0.42], [0, 0.42]]),
       P('front', 'plate', 0.011, rect(-0.26, 0.43, 0.26, 0.545), false)],
      // side: door handle, M gill
      // door handle, quarter-glass divider, Hofmeister kink, black window trim, box-flared arches
      [P('side', 'black', 0.004, rect(-0.30, 0.905, -0.15, 0.925)),
       P('side', 'gloss', 0.008, [[-0.84, 0.99], [-0.87, 0.99], [-0.87, 1.34], [-0.84, 1.34]]),
       P('side', 'paint', 0.008, [[-0.95, 1.345], [-1.08, 1.375], [-1.42, 1.2], [-1.42, 0.99], [-1.26, 0.99], [-1.25, 1.025], [-1.33, 1.08]]),
       P('side', 'gloss', 0.007, [[0.80, 0.966], [-1.25, 1.003], [-1.25, 1.023], [0.80, 0.988]])],
      flare(1.3735, 0.3376, 0.405, 0.465, 0.885, 0.945, 'paint', 3),   // inner edge on the generator's arch cut (r x 1.12) so the lip doesn't float over the well
      flare(-1.3735, 0.3395, 0.407, 0.47, 0.885, 0.945, 'paint', 3),
      // rear: slanted L tail lamps, plate on the boot lid, black diffuser with 2+2 tips, corner reflectors
      [P('rear', 'tail', 0.006, [[0.34, 0.89], [0.60, 0.875], [0.83, 0.905], [0.84, 0.995], [0.60, 1.0], [0.34, 0.955]]),
       P('rear', 'gloss', 0.009, rect(0.40, 0.915, 0.76, 0.932)),
       P('rear', 'plate', 0.008, rect(-0.26, 0.76, 0.26, 0.87), false),
       P('rear', 'black', 0.004, [[-0.84, 0.24], [0.84, 0.24], [0.84, 0.40], [0.66, 0.46], [-0.66, 0.46], [-0.84, 0.40]], false),
       P('rear', 'tail', 0.007, rect(0.80, 0.44, 0.835, 0.62))],
      mirrors(0.58, 0.82, 0.96, 1.08, 0.80, 0.99, 0.78)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 10 },
      notes: 'BMW M2 (G87) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:BMW_G87_M2_1X7A1837.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:BMW_G87_M2_1X7A1838.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:BMW_G87_M2_Motorworld_Munich_1X7A0071.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:BMW_M2_(G87)_DSC_7397.jpg (front 3/4; likeness pass: cowl moved forward 0.70 -> 0.95, shorter bonnet).'
    };
  })();

  /* ================================================================ BMW M3 Coupé (E46) */
  // L 4.492 W 1.78 H 1.372 WB 2.731; nose x 2.1605, tail x -2.3315, axles +-1.3655.
  // Signature: small chrome-framed twin kidneys, twin round "angel eye" headlamps under one clear cover, bonnet
  // power dome, round fogs in the bumper, chrome-trimmed M gills on the front wings, soft round body with a
  // short boot, two-piece L tail lamps, quad tips in two pairs.
  DEFS['bmw-m3-e46'] = (function () {
    var body = loft({
      xs: [2.1605, 2.13, 2.03, 1.85, 1.3655, 0.62, 0.20, -0.30, -0.70, -1.05, -1.38, -1.75, -2.20, -2.29, -2.3315],
      taper: rearTaper(-2.3315, 0.40, 0.84),
      bot: [[2.1605, 0.25, 0.52], [2.03, 0.18, 0.76], [1.85, 0.16, 0.80], [1.37, 0.15, 0.81], [-1.37, 0.15, 0.82], [-2.2, 0.24, 0.80], [-2.3315, 0.32, 0.66]],
      sill: [[2.1605, 0.28, 0.64], [2.13, 0.26, 0.74], [2.03, 0.25, 0.82], [1.85, 0.27, 0.85], [1.3655, 0.30, 0.865], [0.62, 0.31, 0.845], [-0.70, 0.31, 0.845], [-1.3655, 0.31, 0.875], [-2.2, 0.33, 0.85], [-2.29, 0.35, 0.81], [-2.3315, 0.38, 0.73]],
      waist: [[2.1605, 0.45, 0.68], [2.13, 0.47, 0.78], [2.03, 0.52, 0.85], [1.85, 0.58, 0.875], [1.3655, 0.63, 0.885], [0.62, 0.62, 0.865], [-0.30, 0.60, 0.86], [-1.05, 0.64, 0.88], [-1.3655, 0.67, 0.89], [-1.75, 0.68, 0.885], [-2.20, 0.68, 0.865], [-2.29, 0.66, 0.83], [-2.3315, 0.58, 0.77]],
      shoulder: [[2.1605, 0.56, 0.65], [2.13, 0.61, 0.75], [2.03, 0.68, 0.82], [1.85, 0.72, 0.85], [1.3655, 0.78, 0.86], [0.62, 0.83, 0.845], [-0.30, 0.85, 0.84], [-1.05, 0.87, 0.855], [-1.3655, 0.885, 0.865], [-1.75, 0.90, 0.855], [-2.20, 0.91, 0.825], [-2.29, 0.90, 0.79], [-2.3315, 0.74, 0.74]],
      belt: [[2.1605, 0.62, 0.60], [2.13, 0.70, 0.68], [2.03, 0.775, 0.76], [1.85, 0.81, 0.80], [1.3655, 0.86, 0.815], [0.62, 0.925, 0.81], [-0.30, 0.95, 0.80], [-1.05, 0.965, 0.81], [-1.38, 0.975, 0.815], [-1.75, 0.965, 0.80], [-2.20, 0.975, 0.76], [-2.29, 0.96, 0.72], [-2.3315, 0.80, 0.70]],
      rail: [[2.1605, 0.645, 0.46], [2.13, 0.72, 0.55], [2.03, 0.79, 0.62], [1.85, 0.835, 0.65], [1.3655, 0.885, 0.67], [0.62, 0.95, 0.705], [0.20, 1.14, 0.685], [-0.30, 1.325, 0.65], [-0.70, 1.345, 0.645], [-1.05, 1.305, 0.65], [-1.38, 1.18, 0.665], [-1.75, 1.005, 0.67], [-2.20, 1.0, 0.66], [-2.29, 0.975, 0.60], [-2.3315, 0.81, 0.58]],
      top: [[2.1605, 0.66], [2.13, 0.735], [2.03, 0.80], [1.85, 0.85], [1.3655, 0.905], [0.62, 0.975], [0.20, 1.165], [-0.30, 1.355], [-0.70, 1.372], [-1.05, 1.335], [-1.38, 1.21], [-1.75, 1.015], [-2.20, 1.01], [-2.29, 0.98], [-2.3315, 0.815]],
      roofK: [[1.0, 0.4, 0.82, 1.15], [0.62, 0.35, 0.78, 0.95]],
      ws: [0.62, -0.30], rw: [-1.05, -1.75], side: [[0.52, -1.38]],
      pillarMat: 'paint', roofMat: 'paint2',
      sillMat: [[2.2, 2.08], [-2.25, -2.4]]
    });
    var parts = [].concat(
      // small chrome-framed twin kidneys with black slats
      [P('front', 'chrome', 0.006, [[0.03, 0.53], [0.20, 0.53], [0.225, 0.56], [0.225, 0.68], [0.20, 0.725], [0.05, 0.725], [0.03, 0.70]]),
       P('front', 'grille', 0.010, [[0.05, 0.55], [0.19, 0.55], [0.205, 0.57], [0.205, 0.675], [0.185, 0.705], [0.06, 0.705], [0.05, 0.69]]),
       P('front', 'chrome', 0.013, rect(0.05, 0.58, 0.205, 0.59)), P('front', 'chrome', 0.013, rect(0.05, 0.625, 0.205, 0.635)),
       P('front', 'chrome', 0.013, rect(0.05, 0.665, 0.20, 0.675))],
      // twin round headlamps (angel eyes) under one clear cover
      [P('front', 'gloss', 0.006, [[0.27, 0.575], [0.62, 0.58], [0.75, 0.625], [0.76, 0.70], [0.60, 0.725], [0.29, 0.705], [0.25, 0.66]]),
       P('front', 'chrome', 0.010, ell(0.37, 0.645, 0.064, 0.058, 10)),
       P('front', 'chrome', 0.010, ell(0.585, 0.65, 0.072, 0.062, 10)),
       P('front', 'gloss', 0.013, ell(0.37, 0.645, 0.05, 0.045, 10)),
       P('front', 'gloss', 0.013, ell(0.585, 0.65, 0.057, 0.048, 10)),
       P('front', 'light', 0.016, ell(0.37, 0.645, 0.026, 0.024, 8)),
       P('front', 'light', 0.016, ell(0.585, 0.65, 0.03, 0.026, 8))],
      // bumper: central intake, outer intakes with round fogs, plate
      [P('front', 'grille', 0.005, [[0, 0.24], [0.40, 0.24], [0.42, 0.37], [0, 0.37]]),
       P('front', 'grille', 0.005, [[0.50, 0.25], [0.72, 0.27], [0.74, 0.40], [0.52, 0.40]]),
       P('front', 'light', 0.009, ell(0.66, 0.325, 0.04, 0.04, 8)),
       P('front', 'plate', 0.010, rect(-0.26, 0.40, 0.26, 0.51), false)],
      // power dome edges on the bonnet, M gills with chrome trim
      [P('side', 'gloss', 0.006, [[0.98, 0.68], [1.14, 0.68], [1.14, 0.74], [0.98, 0.74]]),
       P('side', 'chrome', 0.009, [[0.98, 0.72], [1.14, 0.72], [1.14, 0.735], [0.98, 0.735]]),
       P('side', 'black', 0.004, rect(-0.36, 0.90, -0.22, 0.92))],
      // rear: two-piece L tail lamps, plate on the boot lid, quad tips in two pairs
      [P('rear', 'tail', 0.006, [[0.25, 0.815], [0.48, 0.81], [0.50, 0.755], [0.80, 0.765], [0.81, 0.945], [0.25, 0.96]]),
       P('rear', 'rev', 0.009, [[0.30, 0.875], [0.47, 0.87], [0.47, 0.90], [0.30, 0.905]]),
       P('rear', 'gloss', 0.009, rect(0.25, 0.84, 0.80, 0.848)),
       P('rear', 'plate', 0.008, rect(-0.25, 0.76, 0.25, 0.865), false),
       P('rear', 'black', 0.004, rect(-0.55, 0.25, 0.55, 0.33), false)],
      mirrors(0.38, 0.60, 0.92, 1.03, 0.78, 0.96, 0.76)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 10 },
      notes: 'BMW M3 Coupé (E46) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:BMW_E46_M3_Phoenix_Yellow_(1).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:BMW_E46_M3_Phoenix_Yellow_(2).jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:BMW_M3_CSL_(E46).jpg.'
    };
  })();

  /* ================================================================ Aston Martin Vantage (2018) */
  // L 4.465 W 1.942 H 1.273 WB 2.704; nose x 2.282, tail x -2.183, axles +-1.352.
  // Signature: huge low gaping grille at the very bottom of the nose, slim swept headlamps on the wing tops,
  // long clamshell bonnet, black side strakes behind the front wheels, low fastback with a black roof, rear
  // ducktail over a thin full-width light bar, massive black diffuser.
  DEFS['aston-martin-vantage-2018'] = (function () {
    var body = loft({
      xs: [2.282, 2.25, 2.15, 1.90, 1.352, 0.40, 0.05, -0.30, -0.70, -1.05, -1.40, -1.80, -2.08, -2.14, -2.183],
      round: [-2.183, 0.62, 0.56, 0.08],
      bot: [[2.282, 0.15, 0.55], [2.15, 0.13, 0.80], [1.90, 0.13, 0.86], [1.35, 0.13, 0.88], [-1.35, 0.14, 0.89], [-2.0, 0.17, 0.86], [-2.183, 0.20, 0.64]],
      sill: [[2.282, 0.17, 0.66], [2.25, 0.17, 0.78], [2.15, 0.19, 0.88], [1.90, 0.23, 0.935], [1.352, 0.26, 0.95], [0.40, 0.27, 0.91], [-0.70, 0.27, 0.91], [-1.352, 0.28, 0.955], [-2.0, 0.30, 0.91], [-2.14, 0.32, 0.81], [-2.183, 0.34, 0.70]],
      waist: [[2.282, 0.36, 0.72], [2.25, 0.40, 0.84], [2.15, 0.46, 0.92], [1.90, 0.53, 0.955], [1.352, 0.58, 0.965], [0.40, 0.56, 0.935], [-0.30, 0.55, 0.93], [-1.05, 0.62, 0.96], [-1.40, 0.66, 0.971], [-1.80, 0.67, 0.96], [-2.08, 0.64, 0.89], [-2.14, 0.60, 0.83], [-2.183, 0.55, 0.72]],
      shoulder: [[2.282, 0.44, 0.70], [2.25, 0.52, 0.80], [2.15, 0.60, 0.88], [1.90, 0.68, 0.92], [1.352, 0.76, 0.925], [0.40, 0.81, 0.88], [-0.30, 0.82, 0.865], [-1.05, 0.86, 0.91], [-1.40, 0.89, 0.93], [-1.80, 0.91, 0.91], [-2.08, 0.90, 0.83], [-2.14, 0.89, 0.775], [-2.183, 0.84, 0.68]],
      belt: [[2.282, 0.47, 0.64], [2.25, 0.59, 0.74], [2.15, 0.66, 0.82], [1.90, 0.74, 0.86], [1.352, 0.82, 0.865], [0.40, 0.89, 0.81], [0.05, 0.90, 0.79], [-0.30, 0.91, 0.78], [-0.70, 0.93, 0.80], [-1.05, 0.95, 0.85], [-1.40, 0.965, 0.87], [-1.80, 0.975, 0.85], [-2.08, 0.985, 0.75], [-2.14, 0.975, 0.70], [-2.183, 0.92, 0.62]],
      gb: [[2.282, 0.475, 0.58], [2.25, 0.60, 0.66], [2.15, 0.67, 0.72], [1.90, 0.75, 0.76], [1.352, 0.83, 0.77], [0.40, 0.90, 0.76], [-0.30, 0.92, 0.735], [-1.05, 0.96, 0.69], [-1.40, 0.975, 0.65], [-1.80, 0.985, 0.62], [-2.08, 0.99, 0.60], [-2.14, 0.985, 0.58], [-2.183, 0.93, 0.56]],
      rail: [[2.282, 0.48, 0.42], [2.25, 0.615, 0.50], [2.15, 0.685, 0.56], [1.90, 0.765, 0.60], [1.352, 0.845, 0.63], [0.40, 0.915, 0.68], [0.05, 1.06, 0.64], [-0.30, 1.205, 0.585], [-0.70, 1.24, 0.565], [-1.05, 1.185, 0.565], [-1.40, 1.07, 0.57], [-1.80, 0.99, 0.57], [-2.08, 1.0, 0.55], [-2.14, 0.99, 0.52], [-2.183, 0.935, 0.45]],
      top: [[2.282, 0.485], [2.25, 0.625], [2.15, 0.70], [1.90, 0.785], [1.352, 0.865], [0.40, 0.94], [0.05, 1.10], [-0.30, 1.245], [-0.70, 1.273], [-1.05, 1.215], [-1.40, 1.085], [-1.80, 0.995], [-2.08, 1.005], [-2.14, 0.995], [-2.183, 0.94]],
      roofK: [[0, 0.35, 0.78, 0.95]],
      ws: [0.40, -0.30], rw: [-1.05, -1.80], side: [[0.30, -1.40]],
      pillarMat: 'paint', roofMat: 'black', railMat: 'black',
      sillMat: [[2.3, 2.12], [0.9, -0.95], [-2.0, -2.2]]
    });
    var parts = [].concat(
      // the gaping low grille: gloss frame, dark mesh, number plate on it
      [P('front', 'gloss', 0.004, [[0, 0.12], [0.60, 0.13], [0.70, 0.25], [0.60, 0.45], [0.36, 0.49], [0, 0.49]]),
       P('front', 'grille', 0.008, [[0, 0.15], [0.58, 0.16], [0.66, 0.255], [0.57, 0.425], [0.35, 0.46], [0, 0.46]]),
       P('front', 'plate', 0.012, rect(-0.25, 0.26, 0.25, 0.37), false),
       P('front', 'badge', 0.006, [[0, 0.585], [0.07, 0.60], [0.0, 0.61]])],
      // slim swept headlamps on the wing tops
      [P('front', 'gloss', 0.006, [[0.42, 0.565], [0.62, 0.58], [0.86, 0.66], [0.87, 0.71], [0.66, 0.665], [0.44, 0.615]]),
       P('front', 'light', 0.009, [[0.46, 0.575], [0.62, 0.59], [0.83, 0.665], [0.84, 0.695], [0.65, 0.65], [0.47, 0.605]]),
       P('front', 'drl', 0.012, [[0.62, 0.635], [0.84, 0.69], [0.84, 0.70], [0.62, 0.65]])],
      // bonnet vents, black side strakes, sills
      [P('top', 'black', 0.004, [[1.95, 0.30], [1.70, 0.36], [1.70, 0.40], [1.95, 0.34]]),
       P('side', 'gloss', 0.006, [[0.86, 0.56], [0.98, 0.58], [1.05, 0.80], [0.94, 0.82]]),
       P('side', 'black', 0.004, rect(-0.35, 0.83, -0.22, 0.85))],
      // rear: thin light bar under the ducktail, black diffuser with fins, plate
      [P('rear', 'tail', 0.006, [[0.0, 0.865], [0.36, 0.86], [0.58, 0.88], [0.74, 0.925], [0.73, 0.96], [0.56, 0.92], [0.36, 0.905], [0.0, 0.905]]),
       P('rear', 'gloss', 0.004, [[-0.70, 0.14], [0.70, 0.14], [0.76, 0.38], [0.56, 0.44], [-0.56, 0.44], [-0.76, 0.38]], false),
       P('rear', 'paint', 0.008, rect(0.30, 0.15, 0.32, 0.30)),
       P('rear', 'paint', 0.008, rect(0.50, 0.15, 0.52, 0.30)),
       P('rear', 'plate', 0.008, rect(-0.26, 0.56, 0.26, 0.67), false),
       P('rear', 'badge', 0.008, [[0, 0.795], [0.08, 0.81], [0, 0.82]])],
      mirrors(0.18, 0.40, 0.87, 0.97, 0.76, 0.94, 0.74)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 10 },
      // quad tips: a close pair at each outer corner of the diffuser (generator exhaust override)
      exhaust: [{ cx: 0.53, cy: 0.27, w: 0.095, h: 0.095, mirror: true }, { cx: 0.64, cy: 0.27, w: 0.095, h: 0.095, mirror: true }],
      notes: 'Aston Martin Vantage (2018) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2019_Aston_Martin_Vantage_V8_Automatic_4.0_(1).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2019_Aston_Martin_Vantage_V8_Automatic_4.0_Rear.jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Alpine A110 (2017) */
  // L 4.18 W 1.798 H 1.252 WB 2.419; nose x 2.1205, tail x -2.0595, axles +-1.2095.
  // Signature: small soft mid-engined bubble, low nose with the four "eyes" (headlamps + round LED lamps
  // inboard), bonnet spine between proud front wings, teardrop side glass, wide wraparound rear screen over a
  // short engine deck, thin X-shaped tail lamps, black diffuser with a single centre tip.
  DEFS['alpine-a110'] = (function () {
    // profile re-measured (fresh-eyes audit) off File:Alpine_A110_vue_de_profil.jpg: windscreen header far
    // forward (x +0.18), long flat roof, belt ~0.9 m, rear screen -0.80..-1.45 dropping onto a short deck.
    var body = loft({
      xs: [2.1205, 2.09, 2.00, 1.78, 1.2095, 0.72, 0.45, 0.18, -0.30, -0.80, -1.10, -1.45, -1.80, -1.95, -2.03, -2.0595],
      // rounded tail: the plan narrows progressively over the last 0.6 m (the real tail is a soft bubble)
      taper: [[-1.45, 1, 0], [-1.80, 0.96, 0], [-1.95, 0.90, 0.01], [-2.03, 0.82, 0.03], [-2.0595, 0.70, 0.06]],
      bot: [[2.1205, 0.20, 0.40], [2.0, 0.16, 0.62], [1.78, 0.15, 0.74], [1.21, 0.145, 0.80], [-1.21, 0.15, 0.81], [-1.9, 0.17, 0.78], [-2.0595, 0.19, 0.62]],
      sill: [[2.1205, 0.22, 0.48], [2.09, 0.22, 0.60], [2.00, 0.23, 0.72], [1.78, 0.25, 0.82], [1.2095, 0.28, 0.865], [0.72, 0.29, 0.835], [-0.60, 0.29, 0.83], [-1.2095, 0.30, 0.87], [-1.92, 0.32, 0.84], [-2.01, 0.34, 0.78], [-2.0595, 0.36, 0.70]],
      waist: [[2.1205, 0.38, 0.52], [2.09, 0.42, 0.64], [2.00, 0.47, 0.75], [1.78, 0.53, 0.855], [1.2095, 0.58, 0.899], [0.72, 0.565, 0.87], [-0.30, 0.55, 0.86], [-0.80, 0.60, 0.885], [-1.10, 0.65, 0.899], [-1.45, 0.67, 0.895], [-1.80, 0.67, 0.865], [-1.95, 0.655, 0.83], [-2.03, 0.63, 0.80], [-2.0595, 0.58, 0.72]],
      shoulder: [[2.1205, 0.46, 0.49], [2.09, 0.53, 0.61], [2.00, 0.61, 0.72], [1.78, 0.69, 0.825], [1.2095, 0.75, 0.865], [0.72, 0.79, 0.835], [-0.30, 0.82, 0.82], [-0.80, 0.86, 0.855], [-1.10, 0.89, 0.875], [-1.45, 0.905, 0.87], [-1.80, 0.89, 0.835], [-1.95, 0.87, 0.80], [-2.03, 0.85, 0.77], [-2.0595, 0.80, 0.68]],
      belt: [[2.1205, 0.51, 0.44], [2.09, 0.60, 0.56], [2.00, 0.67, 0.67], [1.78, 0.745, 0.77], [1.2095, 0.80, 0.81], [0.72, 0.855, 0.79], [0.45, 0.875, 0.78], [0.18, 0.89, 0.775], [-0.30, 0.90, 0.775], [-0.80, 0.925, 0.80], [-1.10, 0.94, 0.82], [-1.45, 0.95, 0.815], [-1.80, 0.925, 0.77], [-1.95, 0.905, 0.73], [-2.03, 0.88, 0.69], [-2.0595, 0.84, 0.62]],
      gb: [[2.1205, 0.51, 0.38], [2.09, 0.60, 0.48], [2.00, 0.665, 0.57], [1.78, 0.735, 0.65], [1.2095, 0.79, 0.69], [0.72, 0.865, 0.73], [0.45, 0.885, 0.725], [0.18, 0.90, 0.72], [-0.30, 0.91, 0.715], [-0.80, 0.935, 0.74], [-1.10, 0.95, 0.765], [-1.45, 0.96, 0.755], [-1.80, 0.935, 0.66], [-1.95, 0.915, 0.58], [-2.03, 0.89, 0.55], [-2.0595, 0.85, 0.50]],
      rail: [[2.1205, 0.505, 0.26], [2.09, 0.60, 0.35], [2.00, 0.655, 0.42], [1.78, 0.715, 0.49], [1.2095, 0.78, 0.55], [0.72, 0.875, 0.64], [0.45, 1.02, 0.615], [0.18, 1.175, 0.565], [-0.30, 1.222, 0.54], [-0.80, 1.205, 0.55], [-1.10, 1.12, 0.575], [-1.45, 0.965, 0.61], [-1.80, 0.935, 0.59], [-1.95, 0.915, 0.56], [-2.03, 0.89, 0.52], [-2.0595, 0.855, 0.45]],
      top: [[2.1205, 0.515], [2.09, 0.605], [2.00, 0.65], [1.78, 0.70], [1.2095, 0.77], [0.72, 0.88], [0.45, 1.05], [0.18, 1.215], [-0.30, 1.252], [-0.80, 1.238], [-1.10, 1.15], [-1.45, 0.975], [-1.80, 0.94], [-1.95, 0.92], [-2.03, 0.895], [-2.0595, 0.86]],
      // bonnet spine: the centre line sits a touch proud of the bonnet quarters
      roofK: [[2.0, 0.3, 0.6, 0.8], [1.2, 0.3, 0.6, 0.8], [0.72, 0.35, 0.78, 0.95]],
      ws: [0.72, 0.18], rw: [-0.80, -1.45], side: [[0.62, -1.45]],
      // wraparound rear screen: the quarter glass and the rail strip behind the C-pillar are glass too
      mat: function (i, j, xm, m) { return (j === 7 && xm < -0.80 && xm > -1.45) ? 'glass' : m; },
      pillarMat: 'paint', roofMat: 'paint2',
      sillMat: [[2.2, 2.05], [0.85, -0.85], [-1.9, -2.1]]
    });
    var parts = [].concat(
      // four eyes: swept headlamps with X DRL + round LED lamps inboard
      [P('front', 'gloss', 0.006, [[0.40, 0.555], [0.60, 0.575], [0.78, 0.635], [0.80, 0.715], [0.64, 0.71], [0.42, 0.63]]),
       P('front', 'chrome', 0.009, [[0.44, 0.57], [0.60, 0.585], [0.765, 0.64], [0.78, 0.70], [0.64, 0.697], [0.45, 0.625]]),
       P('front', 'light', 0.012, ell(0.60, 0.64, 0.085, 0.042, 10, 0.3)),
       P('front', 'drl', 0.015, [[0.50, 0.595], [0.72, 0.69], [0.71, 0.70], [0.49, 0.605]]),
       P('front', 'drl', 0.015, [[0.52, 0.685], [0.71, 0.61], [0.72, 0.62], [0.52, 0.695]]),
       P('front', 'gloss', 0.006, ell(0.42, 0.47, 0.072, 0.068, 10)),
       P('front', 'chrome', 0.009, ell(0.42, 0.47, 0.058, 0.055, 10)),
       P('front', 'light', 0.012, ell(0.42, 0.47, 0.04, 0.038, 8))],
      // lower grille with the plate, small corner intakes, badge
      [P('front', 'grille', 0.005, [[0, 0.17], [0.52, 0.19], [0.58, 0.30], [0.46, 0.38], [0, 0.38]]),
       P('front', 'plate', 0.010, rect(-0.24, 0.23, 0.24, 0.33), false),
       P('front', 'gloss', 0.006, [[0.62, 0.24], [0.74, 0.27], [0.76, 0.40], [0.66, 0.40]]),
       P('front', 'badge', 0.008, [[0, 0.60], [0.035, 0.635], [0, 0.67], [-0.035, 0.635]], false)],
      // side: door handle, small rear-quarter intake
      [P('side', 'black', 0.004, rect(-0.36, 0.86, -0.24, 0.88)),
       P('side', 'paint', 0.010, [[-0.62, 0.925], [-0.80, 0.94], [-0.95, 1.10], [-0.88, 1.18], [-0.80, 1.205], [-0.74, 1.10]]),
       P('side', 'gloss', 0.004, [[-0.82, 0.62], [-0.90, 0.62], [-0.98, 0.76], [-0.90, 0.78]])],
      // rear: thin X-shaped tail lamps, plate, black diffuser
      [P('rear', 'gloss', 0.005, [[0.24, 0.735], [0.62, 0.745], [0.76, 0.785], [0.70, 0.815], [0.24, 0.80]]),
       P('rear', 'tail', 0.008, [[0.27, 0.745], [0.62, 0.755], [0.73, 0.787], [0.68, 0.805], [0.27, 0.79]]),
       P('rear', 'gloss', 0.011, [[0.40, 0.745], [0.43, 0.745], [0.60, 0.805], [0.57, 0.805]]),
       P('rear', 'gloss', 0.011, [[0.40, 0.805], [0.43, 0.805], [0.60, 0.745], [0.57, 0.745]]),
       P('rear', 'plate', 0.008, rect(-0.25, 0.56, 0.25, 0.67), false),
       P('rear', 'gloss', 0.004, [[-0.72, 0.15], [0.72, 0.15], [0.78, 0.36], [0.50, 0.42], [-0.50, 0.42], [-0.78, 0.36]], false),
       P('rear', 'chrome', 0.008, [[-0.13, 0.22], [0.13, 0.22], [0.16, 0.27], [0.13, 0.31], [-0.13, 0.31], [-0.16, 0.27]], false),
       P('rear', 'tail', 0.008, rect(0.60, 0.36, 0.70, 0.385))],
      mirrors(0.22, 0.42, 0.84, 0.94, 0.72, 0.89, 0.70)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 5 },
      // one centre tip in the diffuser (generator exhaust override)
      exhaust: [{ cx: 0, cy: 0.255, w: 0.115, h: 0.105 }],
      notes: 'Alpine A110 (2017) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2018_Alpine_A110_Premiere_Edition_1.8_Front.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2019_Alpine_A110_S_1.8_(2).jpg (front 3/4, side), ' +
        'https://commons.wikimedia.org/wiki/File:Alpine_A110_S_Automesse_Ludwigsburg_2022_1X7A5948.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Alpine_A110_vue_de_profil.jpg (side profile), ' +
        'https://commons.wikimedia.org/wiki/File:Alpine_A110_IMG_4992.jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Lotus Emira */
  // L 4.413 W 1.895 H 1.226 WB 2.575; nose x 2.2755, tail x -2.1375, axles +-1.2875.
  // Signature: low nose between tall front wings carrying blade headlamps, twin lower intakes either side of a
  // body-colour centre, the huge side intake scooped into the door / rear wing, black roof and louvred black
  // engine cover, thin blade tail lamps under a ducktail, black rear corner vents and diffuser.
  DEFS['lotus-emira'] = (function () {
    var body = loft({
      xs: [2.2755, 2.24, 2.13, 1.90, 1.2875, 0.95, 0.52, 0.12, -0.30, -0.65, -1.00, -1.40, -1.70, -2.00, -2.09, -2.1375],
      round: [-2.1375, 0.50, 0.66, 0.07],
      bot: [[2.2755, 0.17, 0.50], [2.13, 0.14, 0.78], [1.90, 0.14, 0.84], [1.29, 0.14, 0.86], [-1.29, 0.15, 0.87], [-1.9, 0.18, 0.85], [-2.1375, 0.24, 0.70]],
      sill: [[2.2755, 0.19, 0.62], [2.24, 0.19, 0.76], [2.13, 0.21, 0.87], [1.90, 0.24, 0.92], [1.2875, 0.27, 0.935], [0.55, 0.28, 0.885], [-0.55, 0.28, 0.875], [-1.2875, 0.29, 0.935], [-1.9, 0.31, 0.92], [-2.09, 0.33, 0.86], [-2.1375, 0.35, 0.78]],
      waist: [[2.2755, 0.36, 0.68], [2.24, 0.40, 0.82], [2.13, 0.46, 0.91], [1.90, 0.52, 0.94], [1.2875, 0.58, 0.945], [0.55, 0.56, 0.905], [-0.20, 0.56, 0.885], [-0.55, 0.58, 0.88], [-0.85, 0.62, 0.92], [-1.25, 0.66, 0.9475], [-1.70, 0.67, 0.94], [-2.00, 0.66, 0.91], [-2.09, 0.64, 0.87], [-2.1375, 0.60, 0.80]],
      shoulder: [[2.2755, 0.44, 0.66], [2.24, 0.52, 0.79], [2.13, 0.61, 0.88], [1.90, 0.69, 0.915], [1.2875, 0.77, 0.92], [0.55, 0.82, 0.87], [-0.20, 0.83, 0.85], [-0.55, 0.86, 0.86], [-0.85, 0.89, 0.895], [-1.25, 0.92, 0.92], [-1.70, 0.93, 0.905], [-2.00, 0.93, 0.87], [-2.09, 0.92, 0.83], [-2.1375, 0.87, 0.75]],
      belt: [[2.2755, 0.48, 0.60], [2.24, 0.60, 0.74], [2.13, 0.69, 0.83], [1.90, 0.76, 0.87], [1.2875, 0.84, 0.875], [0.95, 0.87, 0.835], [0.52, 0.885, 0.81], [0.12, 0.895, 0.795], [-0.30, 0.91, 0.80], [-0.65, 0.935, 0.83], [-1.00, 0.96, 0.86], [-1.40, 0.98, 0.865], [-1.70, 0.985, 0.85], [-2.00, 0.995, 0.80], [-2.09, 0.985, 0.76], [-2.1375, 0.92, 0.68]],
      gb: [[2.2755, 0.48, 0.52], [2.24, 0.60, 0.64], [2.13, 0.685, 0.70], [1.90, 0.75, 0.72], [1.2875, 0.825, 0.73], [0.95, 0.865, 0.78], [0.12, 0.905, 0.75], [-0.30, 0.92, 0.735], [-0.65, 0.945, 0.71], [-1.00, 0.97, 0.68], [-1.40, 0.99, 0.65], [-1.70, 0.995, 0.62], [-2.00, 1.0, 0.60], [-2.09, 0.99, 0.58], [-2.1375, 0.93, 0.55]],
      rail: [[2.2755, 0.48, 0.38], [2.24, 0.585, 0.46], [2.13, 0.65, 0.52], [1.90, 0.71, 0.56], [1.2875, 0.785, 0.60], [0.95, 0.875, 0.69], [0.52, 1.01, 0.65], [0.12, 1.165, 0.59], [-0.30, 1.20, 0.565], [-0.65, 1.17, 0.57], [-1.00, 1.09, 0.59], [-1.40, 1.045, 0.59], [-1.70, 1.02, 0.58], [-2.00, 0.995, 0.56], [-2.09, 1.01, 0.53], [-2.1375, 0.945, 0.46]],
      top: [[2.2755, 0.48], [2.24, 0.57], [2.13, 0.63], [1.90, 0.685], [1.2875, 0.765], [0.95, 0.885], [0.52, 1.045], [0.12, 1.20], [-0.30, 1.226], [-0.65, 1.20], [-1.00, 1.11], [-1.40, 1.06], [-1.70, 1.035], [-2.00, 1.0], [-2.09, 1.018], [-2.1375, 0.95]],
      roofK: [[0, 0.35, 0.78, 0.95]],
      ws: [0.95, 0.05], rw: [-0.65, -1.70], side: [[0.75, -0.65]],
      pillarMat: 'paint', roofMat: 'black', railMat: 'black',
      sillMat: [[2.3, 2.1], [0.95, -0.85], [-1.95, -2.2]],
      // the rear "glass" is the louvred black engine cover
      mat: function (i, j, xm, m) { if (j >= 8 && xm < -0.85 && xm > -1.70) return 'black'; return null; }
    });
    var parts = [].concat(
      // twin lower intakes either side of the body-colour centre, Lotus roundel
      [P('front', 'grille', 0.005, [[0.10, 0.17], [0.58, 0.19], [0.66, 0.30], [0.60, 0.40], [0.14, 0.38]]),
       P('front', 'gloss', 0.008, [[0.42, 0.21], [0.60, 0.22], [0.64, 0.30], [0.58, 0.37], [0.44, 0.36]]),
       P('front', 'indicator', 0.008, ell(0, 0.47, 0.035, 0.03, 8), false)],
      // blade headlamps on the wing fronts
      [P('front', 'gloss', 0.006, [[0.46, 0.52], [0.70, 0.56], [0.88, 0.645], [0.875, 0.715], [0.68, 0.65], [0.47, 0.585]]),
       P('front', 'light', 0.009, [[0.52, 0.54], [0.70, 0.575], [0.84, 0.655], [0.84, 0.68], [0.68, 0.62], [0.53, 0.565]]),
       P('front', 'drl', 0.012, [[0.50, 0.57], [0.70, 0.618], [0.86, 0.69], [0.85, 0.70], [0.68, 0.632], [0.50, 0.582]])],
      // bonnet vents
      [P('top', 'gloss', 0.004, [[2.05, 0.10], [1.85, 0.12], [1.85, 0.34], [2.0, 0.36]]),
       P('top', 'black', 0.007, rect(1.86, 0.15, 2.0, 0.17)),
       P('top', 'black', 0.007, rect(1.86, 0.25, 2.0, 0.27))],
      // louvres on the black engine cover
      [-0.98, -1.12, -1.26, -1.40, -1.54].map(function (x) { return P('top', 'carbon', 0.006, rect(x - 0.025, -0.40, x + 0.025, 0.40), false); }),
      // the huge side intake, door handle
      [P('side', 'gloss', 0.006, [[-0.42, 0.47], [-0.80, 0.47], [-0.88, 0.62], [-0.80, 0.87], [-0.52, 0.84], [-0.40, 0.66]]),
       P('side', 'black', 0.004, rect(-0.20, 0.86, -0.08, 0.88))],
      // rear: thin blade tail lamps, black corner vents, plate, diffuser
      [P('rear', 'tail', 0.006, [[0.20, 0.845], [0.62, 0.85], [0.76, 0.89], [0.74, 0.915], [0.60, 0.875], [0.20, 0.87]]),
       P('rear', 'gloss', 0.006, ell(0.62, 0.60, 0.075, 0.11, 8)),
       P('rear', 'plate', 0.008, rect(-0.25, 0.43, 0.25, 0.54), false),
       P('rear', 'gloss', 0.004, [[-0.72, 0.15], [0.72, 0.15], [0.76, 0.33], [0.52, 0.40], [-0.52, 0.40], [-0.76, 0.33]], false),
       P('rear', 'badge', 0.008, rect(-0.16, 0.775, 0.16, 0.79), false)],
      mirrors(0.50, 0.72, 0.89, 0.99, 0.78, 0.97, 0.76)
    );
    return {
      body: body, parts: parts,
      wheels: { style: 'split', spokes: 5 },
      notes: 'Lotus Emira — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2025_Lotus_Emira_V6_in_Vivid_Red,_front_right.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Lotus_Emira_IMG_8027.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Lotus_Emira_IMG_8023.jpg (front 3/4), ' +
        "https://commons.wikimedia.org/wiki/File:Den_Lotus_Emira_2.0_i4_SE_gibt's_bei_Lotus_St._Gallen_(2026).jpg (front 3/4, cabin position)."
    };
  })();

  Object.keys(DEFS).forEach(function (id) { reg(id, DEFS[id]); });
  if (typeof module !== 'undefined' && module.exports) module.exports = DEFS;
})();

/* ==========================================================================
   FORGE Atelier — js/shapes/models/suv.js
   Real-car shape models for body style 'suv':
     - Porsche Cayenne (E3 / 9Y0 facelift, 2023–)
     - Land Rover Range Rover Sport (L461, 2022–)
     - Lamborghini Urus (2018–2022)

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top view = (x, z); front & rear views = (z, y).

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}.
   Outlines are smooth G1 cubic splines through hand-placed landmarks taken
   from published dimensions and reference photography. Front/rear/top
   outlines are generated from one half and mirrored, so they are exactly
   symmetric about z = 0.
   Brand names are text only: no manufacturer logo artwork is drawn;
   badgeArea only marks where a text badge goes.

   Classic script, zero dependencies, no DOM. Registers through
   CB.shapes.registerModel when core.js has loaded, otherwise queues on
   CB.shapes._pending (core.js drains the queue when it loads).
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ */
  /* Geometry helpers (local; must not depend on core.js)               */
  /* ------------------------------------------------------------------ */
  function r5(v) { return Math.round(v * 100000) / 100000; }
  function P2(a, b) { return [r5(a), r5(b)]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function len(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }
  function unit(v) { var l = len(v); return l > 1e-12 ? [v[0] / l, v[1] / l] : [1, 0]; }

  /* Smooth cubic spline through landmarks. A landmark is [a, b] (smooth) or
     [a, b, 'c'] (corner: handles point along the adjacent chords, so a run
     of corners gives straight edges). Handles are chord/3 along a unit
     tangent made from normalised neighbouring chords: no overshoot with
     uneven spacing, near-exact circular arcs when sampled from a circle. */
  function spline(pts, closed) {
    var n = pts.length;
    if (n < 2) return [];
    function at(i) { return closed ? pts[(i + n) % n] : pts[i]; }
    function tan(i) {
      var p = pts[i];
      if (p[2] === 'c') return null;
      var prev = (i > 0 || closed) ? at(i - 1) : null;
      var next = (i < n - 1 || closed) ? at(i + 1) : null;
      if (!prev) return unit(sub(next, p));
      if (!next) return unit(sub(p, prev));
      var a = unit(sub(p, prev)), b = unit(sub(next, p));
      return unit([a[0] + b[0], a[1] + b[1]]);
    }
    var T = pts.map(function (_, i) { return tan(i); });
    var segs = [{ t: 'M', p: [P2(pts[0][0], pts[0][1])] }];
    var m = closed ? n : n - 1;
    for (var i = 0; i < m; i++) {
      var j = (i + 1) % n, a = pts[i], b = pts[j];
      var d = len(sub(b, a)) / 3, ch = unit(sub(b, a));
      var ta = T[i] || ch, tb = T[j] || ch;
      segs.push({ t: 'C', p: [P2(a[0] + ta[0] * d, a[1] + ta[1] * d), P2(b[0] - tb[0] * d, b[1] - tb[1] * d), P2(b[0], b[1])] });
    }
    if (closed) segs.push({ t: 'Z', p: [] });
    return segs;
  }
  function S(pts) { return spline(pts, true); }      // closed smooth shape
  function O(pts) { return spline(pts, false); }     // open smooth line
  function poly(pts) { return spline(pts.map(function (q) { return [q[0], q[1], 'c']; }), true); }

  /* Mirror a landmark list. axis 0 → negate first coord (front/rear (z,y));
     axis 1 → negate second coord (top (x,z)). */
  function mir(pts, axis) {
    return pts.map(function (q) {
      var o = axis === 0 ? [-q[0], q[1]] : [q[0], -q[1]];
      if (q.length > 2) o.push(q[2]);
      return o;
    });
  }
  /* Symmetric closed shape from one half that starts and ends on the axis. */
  function sym(half, axis) {
    var back = mir(half, axis).reverse().slice(1, -1);
    return S(half.concat(back));
  }
  /* Right-hand feature + its mirror image. */
  function pair(pts, axis) { return [S(pts), S(mir(pts, axis).reverse())]; }
  function pairPoly(pts, axis) { return [poly(pts), poly(mir(pts, axis).reverse())]; }

  var K = 0.5522847;
  function ellipse(cx, cy, rx, ry) {
    var kx = rx * K, ky = ry * K;
    return [
      { t: 'M', p: [P2(cx + rx, cy)] },
      { t: 'C', p: [P2(cx + rx, cy + ky), P2(cx + kx, cy + ry), P2(cx, cy + ry)] },
      { t: 'C', p: [P2(cx - kx, cy + ry), P2(cx - rx, cy + ky), P2(cx - rx, cy)] },
      { t: 'C', p: [P2(cx - rx, cy - ky), P2(cx - kx, cy - ry), P2(cx, cy - ry)] },
      { t: 'C', p: [P2(cx + kx, cy - ry), P2(cx + rx, cy - ky), P2(cx + rx, cy)] },
      { t: 'Z', p: [] }
    ];
  }
  function rrect(x0, y0, x1, y1, r) {
    var w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    var a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
    r = Math.min(r === undefined ? Math.min(w, h) * 0.25 : r, w / 2, h / 2);
    var k = r * (1 - K);
    return [
      { t: 'M', p: [P2(a + r, b)] },
      { t: 'L', p: [P2(c - r, b)] },
      { t: 'C', p: [P2(c - k, b), P2(c, b + k), P2(c, b + r)] },
      { t: 'L', p: [P2(c, d - r)] },
      { t: 'C', p: [P2(c, d - k), P2(c - k, d), P2(c - r, d)] },
      { t: 'L', p: [P2(a + r, d)] },
      { t: 'C', p: [P2(a + k, d), P2(a, d - k), P2(a, d - r)] },
      { t: 'L', p: [P2(a, b + r)] },
      { t: 'C', p: [P2(a, b + k), P2(a + k, b), P2(a + r, b)] },
      { t: 'Z', p: [] }
    ];
  }
  function rrectPair(z0, y0, z1, y1, r) { return [rrect(z0, y0, z1, y1, r), rrect(-z1, y0, -z0, y1, r)]; }

  /* Round wheel-arch landmarks, rear end → over the top → front end (x rising).
     yA / yB are the heights where the arch meets the body's lower edge. */
  function roundArch(cx, cy, r, yA, yB) {
    var a0 = Math.PI - Math.asin((yA - cy) / r), a1 = Math.asin((yB - cy) / r);
    var steps = Math.max(6, Math.ceil((a0 - a1) / (Math.PI / 12)));
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * i / steps;
      var q = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      if (i === 0 || i === steps) q.push('c');
      out.push(q);
    }
    return out;
  }
  /* Urus-style trapezoidal / hexagonal arch with crisp vertices. */
  function hexArch(cx, cy, r, yA, yB) {
    return [
      [cx - 0.94 * r, yA, 'c'], [cx - 0.92 * r, cy + 0.38 * r, 'c'], [cx - 0.62 * r, cy + 0.95 * r, 'c'],
      [cx + 0.62 * r, cy + 0.95 * r, 'c'], [cx + 0.92 * r, cy + 0.38 * r, 'c'], [cx + 0.94 * r, yB, 'c']
    ];
  }
  /* Closed band between an arch curve and an offset copy (arch lip / cladding). */
  function archBand(fn, cx, cy, r, w, yA, yB) {
    var outer = fn(cx, cy, r + w, yA, yB), inner = fn(cx, cy, r, yA, yB).reverse();
    return S(outer.concat(inner));
  }
  function tireR(spec) {
    var m = /^(\d+)\/(\d+)\s*Z?R\s*(\d+)/i.exec(spec);
    return (+m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000) / 2;
  }

  function register(model) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(model);
    else (CB.shapes._pending = CB.shapes._pending || []).push(model);
    return model;
  }

  /* ------------------------------------------------------------------ */
  /* Explicit 3D cross-sections (ringHalf: bottom centre → side → top   */
  /* centre, [y, z]). Derived from this file's own side/plan outlines   */
  /* plus per-car shoulder data, so SUV-specific features survive the   */
  /* loft: tall bluff noses, wings standing above the bonnet, wide rear */
  /* haunches with the backlight inset between them, and wheel wells    */
  /* stepped in just inboard of the tyres.                               */
  /* ------------------------------------------------------------------ */
  function flat(path) {
    var pts = [], cur = null, st = null;
    (path || []).forEach(function (sg) {
      if (sg.t === 'M') { cur = sg.p[0]; st = cur; pts.push(cur); }
      else if (sg.t === 'L') { cur = sg.p[0]; pts.push(cur); }
      else if (sg.t === 'C') {
        var c = [cur].concat(sg.p);
        for (var i = 1; i <= 16; i++) {
          var t = i / 16, u = 1 - t;
          pts.push([u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
            u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]]);
        }
        cur = sg.p[2];
      } else if (sg.t === 'Z' && st) { pts.push(st); cur = st; }
    });
    return pts;
  }
  function sliceAt(pts, x) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1];
      if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
      var y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    return lo === Infinity ? null : [lo, hi];
  }
  function halfW(pts, x) { var s = sliceAt(pts, x); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : null; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function tab(T, x) {   // piecewise-linear lookup, T sorted by descending x
    if (x >= T[0][0]) return T[0][1];
    for (var i = 1; i < T.length; i++) if (x >= T[i][0]) {
      var t = (x - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return lerp(T[i - 1][1], T[i][1], t);
    }
    return T[T.length - 1][1];
  }
  // lower body: fraction of height (bottom → shoulder) vs fraction of plan half-width (rocker, sill, mid-door, shoulder)
  var LOW = [[0, 0.80], [0.015, 0.865], [0.04, 0.905], [0.09, 0.935], [0.2, 0.968], [0.32, 0.984], [0.45, 0.995], [0.6, 1.0], [0.75, 1.0], [0.88, 0.996], [1, 0.985]];
  /* Glass-edge alignment: core resamples each half-ring uniformly by arc length and flags glass per
     vertex (y > belt + 0.02). If the belt sat at a different arc-length fraction at each station the
     glass edge would jump a whole vertex row (sawtooth). So every glass station places its belt pivot
     (a point 0.01 m up the side glass) at the same fraction F0 of the half-ring, padding the lower arc
     with a hidden centre-line fin (z = 0, inside the body, below the shoulder). The fin can only
     lengthen the lower arc, so F0 must be at least the largest natural lower-arc fraction along the
     doors (0.60-0.66 on these cars); 0.66 (0.685 for the Urus, whose rear doors narrow) keeps the first
     glass row at one vertex index from the A-pillar base to the D-pillar for both ringVerts 32 and 40.
     Checked by sweeping F0 against core.loftToMesh's glass sub-mesh. */
  var F0 = 0.66;   // per-car override c.F0 (see below)
  function arcLen(h, a, b) { var l = 0; for (var i = a + 1; i <= b; i++) l += Math.hypot(h[i][0] - h[i - 1][0], h[i][1] - h[i - 1][1]); return l; }
  /* c: { shoulder: [[x, y]...] desc x, hoodDrop, deckDrop, glassBase: [x, y] (rear screen meets the tailgate),
          deckW?: max half-width of the tailgate deck behind the rear screen } */
  function buildSections(c, side, top, ref) {
    var sb = flat(side.body), tb = flat(top.body), sg = flat(side.greenhouse), tg = flat(top.greenhouse), tr = flat(top.roof);
    var minX = Infinity, maxX = -Infinity, gMin = Infinity, gMax = -Infinity;
    sb.forEach(function (q) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); });
    sg.forEach(function (q) { gMin = Math.min(gMin, q[0]); gMax = Math.max(gMax, q[0]); });
    var tipBelt = sliceAt(sg, gMin + 0.012)[0], gbX = c.glassBase[0], gbY = c.glassBase[1];
    var arches = [side.archF, side.archR];
    var wells = [[side.archF, ref.trackF, ref.tireF], [side.archR, ref.trackR, ref.tireR]].map(function (A) {
      var tw = parseInt(/(\d+)\//.exec(A[2])[1], 10) / 1000;
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - tw / 2 - 0.025 };
    });
    function bottom(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.12;
        if (Math.abs(x - a.x) < e) {
          var l = sliceAt(sb, a.x - e), q = sliceAt(sb, a.x + e);
          return lerp(l[0], q[0], (x - a.x + e) / (2 * e));
        }
      }
      return sliceAt(sb, x)[0];
    }
    // end stations sit 0.03 m inside the bumper tips: the end caps are the full bumper faces
    var x0 = minX + 0.03, x1 = maxX - 0.03, xs = [], NS = 56;
    for (var k = 1; k < NS; k++) { var t = k / NS; xs.push(x0 + (x1 - x0) * (1 - Math.cos(Math.PI * t)) / 2); }
    wells.forEach(function (wl) { [-1.0, -0.8, -0.5, 0, 0.5, 0.8, 1.0].forEach(function (f) { xs.push(wl.x + f * wl.r); }); });
    [gMax, gMax - 0.03, gMin, gMin + 0.03, gbX, gbX + 0.03].forEach(function (x) { xs.push(x); });
    // dense run through the D-pillar, where the side-glass edge climbs to meet the rear screen
    for (var xd = gMin - 0.12; xd <= gMin + 0.34; xd += 0.03) xs.push(xd);
    // windscreen header: core drops roof triangles whose normal is flatter than ~22 deg (n.y > 0.93), so the
    // glass/roof boundary falls where the roofline slope crosses tan(22 deg) = 0.40; a fine run of stations
    // there keeps the half-triangle teeth along the header to ~0.02 m
    var xh = null;
    for (var xq = gMax - 0.02; xq > gMin + 0.3 && xh == null; xq -= 0.01) {
      var ya = sliceAt(sg, xq), yb2 = sliceAt(sg, xq - 0.01);
      if (ya && yb2 && (ya[1] - yb2[1]) / 0.01 > -0.40 && (ya[1] - yb2[1]) / 0.01 < 0.40) xh = xq;
    }
    if (xh != null) for (var xk = xh - 0.45; xk <= xh + 0.10 + 1e-9; xk += 0.025) xs.push(xk);
    // extra-fine run where that edge is steepest (the glass line climbs ~0.3 m in ~0.12 m of x)
    for (var xe = gMin + 0.0075; xe <= gMin + 0.16; xe += 0.015) xs.push(xe);
    xs = xs.filter(function (x) { return x > x0 + 0.012 && x < x1 - 0.012; });
    xs.sort(function (a, b) { return a - b; });
    var kept = [x0];   // greedy de-dup against the last kept station (min spacing 0.01 m)
    xs.forEach(function (x) { if (x - kept[kept.length - 1] > 0.01) kept.push(x); });
    xs = kept.concat([x1]);
    return xs.map(function (x) {
      var s = sliceAt(sb, x), yt = s[1], yb = Math.min(bottom(x), yt - 0.06);
      var w = Math.max(halfW(tb, x) || 0.2, 0.05);
      // bumper faces: the plan view rounds off to a point at the tip, but the real bumper face is ~0.8 of the
      // body width, so near the ends the section never drops below the car's end half-width
      if (c.endW && (x > x1 - 0.3 || x < x0 + 0.3)) w = Math.max(w, x > 0 ? c.endW[0] : c.endW[1]);
      var g = (x > gMin && x < gMax) ? sliceAt(sg, x) : null;
      var belt = null;
      if (g) { belt = g[0]; yt = Math.max(yt, g[1]); }
      else if (x <= gMin && x > gbX) belt = lerp(gbY, tipBelt, (x - gbX) / (gMin - gbX));   // rear screen between the haunches
      // a rear screen raked flatter than ~23 deg fails core's roof-normal test (n.y > 0.93) row by row, which
      // shows as a staircase of glass/paint; keep such a screen consistently body-side in the 3D loft
      if (c.dropFlatRearGlass && belt != null && !g) { var sa = sliceAt(sb, x + 0.02), sz = sliceAt(sb, x - 0.02); if (sa && sz && (sa[1] - sz[1]) / 0.04 < 0.42) belt = null; }
      if (belt != null && yt - belt < 0.06) belt = null;
      var ys = Math.min(tab(c.shoulder, x), (belt != null ? belt - 0.045 : yt - 0.035));
      ys = Math.max(ys, yb + 0.08);
      var ws = w * 0.985, h = [[yb, 0]], pivot;
      LOW.forEach(function (q) { h.push([yb + q[0] * (ys - yb), q[1] * w]); });
      if (belt != null) {
        var gw = Math.min(halfW(tg, x) || ws * 0.8, ws - 0.06), H = yt - belt;
        var rw = halfW(tr, x); rw = rw ? Math.min(rw, gw - 0.02) : gw * 0.84;
        pivot = [belt + 0.01, gw - 0.0004];
        h.push([lerp(ys, belt, 0.35), lerp(ws, gw + 0.02, 0.25)], [lerp(ys, belt, 0.7), lerp(ws, gw + 0.02, 0.62)], [belt, gw + 0.02], pivot);
        h.push([belt + 0.25 * H, lerp(gw, rw, 0.26)], [belt + 0.5 * H, lerp(gw, rw, 0.55)], [belt + 0.72 * H, lerp(gw, rw, 0.82)],
          [belt + 0.86 * H, rw], [belt + 0.93 * H, rw * 0.9], [belt + 0.97 * H, rw * 0.74], [belt + 0.99 * H, rw * 0.48], [yt, 0]);
      } else {
        var drop = x > 0 ? c.hoodDrop : c.deckDrop, dh = yt - ys;
        if (x < 0 && c.deckW && c.deckW < ws * 0.86) {
          // tailgate deck set in between wide haunches: shoulder rolls in hard to a narrower deck
          var dw = c.deckW;
          pivot = [yt - 0.004, dw];
          h.push([ys + 0.35 * dh, ws * 0.97], [ys + 0.75 * dh, lerp(ws, dw, 0.6)], pivot, [yt, dw * 0.9],
            [yt - drop * 0.3, dw * 0.72], [yt - drop * 0.6, dw * 0.55], [yt - drop * 0.85, dw * 0.28], [yt - drop, 0]);
        } else {
          pivot = [yt - 0.004, ws * 0.86];
          h.push([ys + 0.3 * dh, ws * 0.975], [ys + 0.6 * dh, ws * 0.95], pivot, [yt, ws * 0.76],
            [yt - drop * 0.3, ws * 0.62], [yt - drop * 0.6, ws * 0.45], [yt - drop * 0.85, ws * 0.24], [yt - drop, 0]);
        }
      }
      // wheel well: skin steps in to just inboard of the tyre inside the arch
      wells.forEach(function (wl) {
        var dx = x - wl.x; if (Math.abs(dx) >= wl.r * 0.99) return;
        var yA = Math.min(wl.y + Math.sqrt(wl.r * wl.r - dx * dx), ys - 0.02), out = [];
        h.forEach(function (q, i) {
          if (i > 0 && h[i - 1][0] < yA && q[0] >= yA) out.push([yA, Math.min(wl.zIn, q[1])], [yA + 0.003, q[1]]);
          out.push(q[0] < yA && q[1] > wl.zIn ? [q[0], wl.zIn] : q);
        });
        h = out;
      });
      // hidden centre-line fin: pads the lower arc so the pivot lands at F0 of the half-ring
      var pi = h.indexOf(pivot), lo = arcLen(h, 0, pi), up = arcLen(h, pi, h.length - 1);
      var f0 = c.F0 || F0, pad = (f0 * up / (1 - f0) - lo) / 2, finMax = Math.max(0.02, Math.min(ys, belt != null ? belt : ys) - yb - 0.06);
      if (pad > 1e-4) {
        var trips = Math.ceil(pad / finMax), fh = pad / trips, fin = [];
        for (var f = 0; f < trips; f++) fin.push([yb + fh, 0], [yb, 0]);
        h = [h[0]].concat(fin, h.slice(1));
      }
      return { x: r5(x), ring: h.map(function (q) { return P2(q[0], q[1]); }), ringHalf: true, belt: belt == null ? null : r5(belt) };
    });
  }

  var built = [];

  /* ================================================================== */
  /* 1. PORSCHE CAYENNE (E3, 9Y0 facelift 2023–)                         */
  /*    4930 × 1983 × 1698 mm, wb 2895, track 1676 / 1653,               */
  /*    255/55 R20, Cd 0.36, 2122 kg (US base, Porsche tech data MY24).  */
  /* ================================================================== */
  (function () {
    var WB = 2.895, H = WB / 2, FO = 0.975, RO = 1.060;
    var XF = H + FO, XR = -(H + RO);                       // 2.4225 / -2.5075
    var TF = '255/55R20', rT = tireR(TF);                  // 0.3943
    var AR = 0.44, CY = r5(rT);

    var archFpts = roundArch(H, CY, AR, 0.32, 0.31);
    var archRpts = roundArch(-H, CY, AR, 0.33, 0.32);

    var body = S([].concat(
      [[2.33, 0.235, 'c'], [2.392, 0.30], [2.414, 0.40], [XF, 0.56], [2.418, 0.70], [2.405, 0.80], [2.37, 0.90],
       [2.30, 0.955], [2.05, 0.99], [1.60, 1.02], [1.15, 1.036], [0.95, 1.045, 'c'],
       [0.50, 1.34], [0.02, 1.63], [-0.25, 1.69], [-0.70, 1.698], [-1.30, 1.682], [-1.80, 1.64],
       [-2.05, 1.625], [-2.12, 1.625, 'c'], [-2.10, 1.592, 'c'], [-2.25, 1.385], [-2.40, 1.15, 'c'],
       [-2.44, 1.08], [-2.475, 0.95], [-2.50, 0.78], [XR, 0.62], [-2.495, 0.48], [-2.46, 0.36],
       [-2.39, 0.30, 'c'], [-2.10, 0.32]],
      archRpts,
      [[-0.60, 0.30], [0.60, 0.30]],
      archFpts,
      [[2.10, 0.285]]
    ));

    var greenhouse = S([[0.86, 1.10, 'c'], [0.50, 1.33], [0.10, 1.585], [-0.25, 1.652], [-0.80, 1.662], [-1.40, 1.645],
      [-1.85, 1.612], [-2.05, 1.592, 'c'], [-2.01, 1.40], [-1.93, 1.215, 'c'], [-1.60, 1.175], [-0.50, 1.145], [0.40, 1.118]]);
    var windows = [
      S([[0.78, 1.125, 'c'], [0.45, 1.34], [0.14, 1.555], [0.0, 1.60], [-0.06, 1.612, 'c'], [-0.03, 1.135, 'c'], [0.40, 1.128]]),
      S([[-0.13, 1.620, 'c'], [-0.60, 1.636], [-1.20, 1.625], [-1.40, 1.612, 'c'], [-1.37, 1.165, 'c'], [-0.60, 1.148], [-0.11, 1.140, 'c']]),
      S([[-1.47, 1.606, 'c'], [-1.80, 1.585], [-2.00, 1.52, 'c'], [-1.93, 1.215, 'c'], [-1.62, 1.195], [-1.44, 1.175, 'c']])   // straight rear edge, parallel to the tailgate
    ];
    var pillars = [
      poly([[0.86, 1.10], [0.10, 1.585], [0.0, 1.60], [0.14, 1.555], [0.78, 1.125]]),
      poly([[-0.06, 1.612], [-0.13, 1.620], [-0.11, 1.140], [-0.03, 1.135]]),
      poly([[-1.40, 1.612], [-1.47, 1.608], [-1.44, 1.175], [-1.37, 1.165]]),
      S([[-2.00, 1.52, 'c'], [-1.98, 1.583, 'c'], [-2.05, 1.592, 'c'], [-2.01, 1.40], [-1.93, 1.215, 'c']])
    ];
    var doorCuts = [
      O([[0.86, 1.10], [0.92, 0.80], [0.90, 0.42], [0.84, 0.345, 'c'], [-0.04, 0.345, 'c'], [-0.06, 0.60], [-0.03, 1.135]]),
      O([[-0.11, 1.140], [-0.12, 0.60], [-0.10, 0.345, 'c'], [-0.75, 0.345], [-0.93, 0.39], [-0.975, 0.55], [-1.087, 0.74], [-1.266, 0.86],
        [-1.40, 0.894, 'c'], [-1.40, 1.165]])
    ];
    var panelLines = [
      O([[2.33, 0.93], [1.70, 0.995], [1.20, 1.025], [0.98, 1.040]]),           // bonnet shut line along wing top
      O([[-2.105, 1.595], [-2.23, 1.39], [-2.375, 1.155], [-2.43, 1.05], [-2.465, 0.90], [-2.48, 0.74]]), // tailgate cut
      rrect(-1.82, 0.985, -1.66, 1.095, 0.025),                                 // fuel flap (right rear wing)
      O([[2.40, 0.66], [2.20, 0.70], [2.02, 0.74], [1.86, 0.80]])               // bumper / wing split
    ];
    var characterLines = [
      O([[2.33, 0.845], [1.80, 0.905], [1.40, 0.940], [1.10, 0.960]]),               // front-wing crest (ends at the door)
      O([[-0.90, 1.000], [-1.50, 1.015], [-2.05, 1.028], [-2.42, 1.035]]),           // rear haunch light-catcher
      O([[0.95, 0.52], [0.0, 0.475], [-0.98, 0.50]])                                  // lower door sculpt
    ];
    var sill = S([[1.00, 0.30, 'c'], [0.0, 0.295], [-1.00, 0.30, 'c'], [-0.98, 0.385, 'c'], [0.0, 0.38], [0.98, 0.385, 'c']]);
    var lowerTrim = [
      sill,
      S([[2.33, 0.235, 'c'], [2.39, 0.29], [2.30, 0.30], [2.10, 0.305, 'c'], [2.10, 0.285, 'c']]),
      S([[-2.39, 0.30, 'c'], [-2.46, 0.36], [-2.44, 0.40], [-2.20, 0.39, 'c'], [-2.12, 0.322, 'c']])
    ];

    var side = {
      body: body, greenhouse: greenhouse, windows: windows, pillars: pillars, doorCuts: doorCuts,
      panelLines: panelLines, characterLines: characterLines, sill: sill, lowerTrim: lowerTrim,
      archF: { x: H, y: CY, r: AR, flare: 0.012, shape: 'round' },
      archR: { x: -H, y: CY, r: AR, flare: 0.016, shape: 'round' }
    };

    var W2 = 1.983 / 2;
    var top = {
      body: sym([[XF, 0], [2.41, 0.30], [2.37, 0.62], [2.27, 0.84], [2.05, 0.955], [1.70, 0.988], [1.45, W2], [1.05, 0.985],
        [0.40, 0.966], [-0.60, 0.963], [-1.10, 0.978], [-1.45, W2], [-1.85, 0.986], [-2.20, 0.955], [-2.40, 0.87],
        [-2.49, 0.66], [-2.505, 0.30], [XR, 0]], 1),
      greenhouse: sym([[0.95, 0], [0.93, 0.48], [0.86, 0.72], [0.50, 0.80], [-1.0, 0.80], [-1.80, 0.76], [-2.08, 0.66],
        [-2.26, 0.50], [-2.30, 0]], 1),
      hood: sym([[2.32, 0], [2.29, 0.45], [2.18, 0.76], [1.70, 0.86], [0.98, 0.78, 'c'], [1.00, 0, 'c']], 1),
      roof: sym([[0.06, 0], [0.045, 0.40], [-0.03, 0.56], [-0.18, 0.625], [-0.50, 0.643], [-1.0, 0.648], [-1.55, 0.635], [-1.88, 0.595], [-2.06, 0.50], [-2.14, 0]], 1),
      deck: sym([[-2.13, 0], [-2.13, 0.56], [-2.30, 0.72], [-2.45, 0.74], [-2.50, 0.40], [-2.505, 0]], 1),
      mirrors: pair([[0.88, 0.93, 'c'], [0.80, 1.097], [0.66, 1.088], [0.70, 0.93, 'c']], 1)
    };

    var front = {
      body: sym([[0, 1.698], [0.35, 1.692], [0.56, 1.67], [0.64, 1.62], [0.72, 1.42], [0.80, 1.20], [0.88, 1.12], [0.93, 1.075],
        [0.975, 0.97], [W2, 0.78], [0.985, 0.56], [0.96, 0.40], [0.92, 0.30], [0.84, 0.25], [0.55, 0.237], [0, 0.235]], 0),
      // windscreen: narrow enough at the base to leave a proper A-pillar
      greenhouse: sym([[0, 1.655], [0.42, 1.65], [0.50, 1.62], [0.72, 1.11, 'c'], [0, 1.11]], 0),
      // bonnet shut lines where the clamshell meets the raised wings
      panelLines: [O([[0.60, 0.97], [0.605, 1.04], [0.60, 1.10]]), O([[-0.60, 0.97], [-0.605, 1.04], [-0.60, 1.10]])],
      // wing crests standing ~0.04 m proud of the bonnet centre (~1.06): the Porsche 'wing-crest' read
      characterLines: [O([[0.62, 1.085], [0.70, 1.11], [0.80, 1.115], [0.88, 1.105]]), O([[-0.62, 1.085], [-0.70, 1.11], [-0.80, 1.115], [-0.88, 1.105]])],
      bumper: sym([[0, 0.80], [0.50, 0.795], [0.85, 0.76], [0.95, 0.70], [0.975, 0.56], [0.955, 0.40], [0.92, 0.30], [0.84, 0.25],
        [0.55, 0.237], [0, 0.235]], 0),
      grille: [
        sym([[0, 0.56, 'c'], [0.52, 0.558, 'c'], [0.62, 0.34, 'c'], [0.56, 0.31, 'c'], [0, 0.31, 'c']], 0),   // main lower intake
        sym([[0, 0.725], [0.26, 0.724, 'c'], [0.28, 0.715], [0.26, 0.706, 'c'], [0, 0.705]], 0)              // slim upper cooling slot
      ],
      intakes: pairPoly([[0.67, 0.61], [0.89, 0.65], [0.935, 0.52], [0.905, 0.36], [0.71, 0.335], [0.645, 0.45]], 0),
      // flat-topped lamp under the wing crest, sharp outer-top corner, lower edge tapering to the inner tip
      headlights: pairPoly([[0.52, 0.88], [0.57, 0.958], [0.95, 0.965], [0.962, 0.905], [0.90, 0.872], [0.76, 0.863], [0.62, 0.865]], 0),
      // Porsche four-point LED DRL: four light elements in a 2 x 2 block inside each lens
      drl: [].concat(
        rrectPair(0.62, 0.933, 0.695, 0.955, 0.007), rrectPair(0.745, 0.933, 0.82, 0.955, 0.007),
        rrectPair(0.62, 0.875, 0.695, 0.897, 0.007), rrectPair(0.745, 0.875, 0.82, 0.897, 0.007)),
      splitter: sym([[0, 0.262], [0.70, 0.262], [0.86, 0.268, 'c'], [0.86, 0.245], [0.80, 0.238], [0, 0.235]], 0),
      plateArea: rrect(-0.26, 0.48, 0.26, 0.59, 0.01),
      badgeArea: rrect(-0.06, 0.92, 0.06, 0.95, 0.01),
      badgeText: 'PORSCHE'
    };

    var rear = {
      body: sym([[0, 1.698], [0.35, 1.69], [0.55, 1.665], [0.62, 1.62], [0.70, 1.42], [0.78, 1.22], [0.86, 1.13], [0.93, 1.05],
        [0.975, 0.93], [W2, 0.76], [0.985, 0.56], [0.96, 0.42], [0.92, 0.32], [0.84, 0.29], [0.55, 0.30], [0, 0.30]], 0),
      // rear screen: squared lower corners, straight base
      greenhouse: sym([[0, 1.605], [0.48, 1.60, 'c'], [0.60, 1.18, 'c'], [0, 1.18]], 0),
      bumper: sym([[0, 0.70], [0.60, 0.70], [0.93, 0.72], [0.975, 0.62], [0.96, 0.42], [0.92, 0.32], [0.84, 0.29], [0.55, 0.30], [0, 0.30]], 0),
      // slim 3D lamps: thin top edge, pointed inner end running into the light strip
      taillights: pairPoly([[0.655, 1.065], [0.89, 1.10], [0.955, 1.093], [0.962, 1.048], [0.93, 1.03], [0.72, 1.052]], 0),
      lightBar: sym([[0, 1.074], [0.66, 1.074, 'c'], [0.66, 1.056, 'c'], [0, 1.056]], 0),
      diffuser: sym([[0, 0.42], [0.40, 0.42, 'c'], [0.72, 0.40], [0.80, 0.34, 'c'], [0.76, 0.31], [0, 0.31]], 0),
      exhaust: [
        { shape: 'oval', cx: 0.52, cy: 0.37, w: 0.105, h: 0.062 }, { shape: 'oval', cx: 0.64, cy: 0.37, w: 0.105, h: 0.062 },
        { shape: 'oval', cx: -0.52, cy: 0.37, w: 0.105, h: 0.062 }, { shape: 'oval', cx: -0.64, cy: 0.37, w: 0.105, h: 0.062 }
      ],
      spoiler: sym([[0, 1.632], [0.52, 1.627], [0.58, 1.605, 'c'], [0, 1.598]], 0),
      plateArea: rrect(-0.26, 0.83, 0.26, 0.94, 0.01),
      badgeArea: rrect(-0.22, 0.995, 0.22, 1.025, 0.006),
      badgeText: 'PORSCHE'
    };

    // front/rear-view mirror: root starts on the body side (z 0.87) so it never floats
    var CAY_CREST = [[0.62, 1.08, 'c'], [0.70, 1.106], [0.80, 1.113], [0.885, 1.106, 'c'], [0.90, 1.092, 'c'], [0.80, 1.094], [0.68, 1.083]];
    var CAY_MIR = [[0.87, 1.12, 'c'], [0.97, 1.10, 'c'], [1.097, 1.15], [1.09, 1.235], [0.96, 1.225, 'c'], [0.87, 1.20, 'c']];
    // 0.004 m black frame round each DRL point (a ring with a slit, so the lit element shows through the hole)
    function frame(z0, y0, z1, y1, e) {
      return [[z0 - e, y0 - e], [z1 + e, y0 - e], [z1 + e, y1 + e], [z0 - e, y1 + e], [z0 - e, y0 - e],
        [z0, y0], [z0, y1], [z1, y1], [z1, y0], [z0, y0]];
    }
    var DRL_FRAMES = [];
    [[0.62, 0.695], [0.745, 0.82]].forEach(function (zz) {
      [[0.933, 0.955], [0.875, 0.897]].forEach(function (yy) {
        var fr = frame(zz[0], yy[0], zz[1], yy[1], 0.004);
        DRL_FRAMES.push({ view: 'front', role: 'trim', paint: 'black', path: poly(fr) },
          { view: 'front', role: 'trim', paint: 'black', path: poly(mir(fr, 0).reverse()) });
      });
    });
    var details = [
      { view: 'side', role: 'mirror', paint: 'body', path: S([[0.86, 1.12, 'c'], [0.83, 1.235], [0.68, 1.252], [0.62, 1.18], [0.70, 1.125, 'c']]) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(0.16, 1.000, 0.34, 1.030, 0.012) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(-0.86, 1.010, -0.68, 1.040, 0.012) },
      { view: 'side', role: 'fuelCap', paint: 'body', path: rrect(-1.82, 0.985, -1.66, 1.095, 0.025) },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: pillars[1] },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: pillars[2] },
      { view: 'side', role: 'antenna', paint: 'gloss-black', path: poly([[-1.68, 1.646], [-1.80, 1.700], [-1.88, 1.705], [-1.92, 1.630]]) },   // shark fin, base sunk into the roof
      { view: 'side', role: 'light', paint: 'light', path: S([[2.40, 0.86, 'c'], [2.36, 0.915], [2.27, 0.955, 'c'], [2.32, 0.90], [2.385, 0.855, 'c']]) },
      { view: 'side', role: 'light', paint: 'light-red', path: poly([[-2.20, 1.095], [-2.42, 1.10], [-2.45, 1.05], [-2.22, 1.072]]) },   // blade lamp wrapping the corner
      { view: 'top', role: 'trim', paint: 'glass', path: rrect(-1.60, -0.50, -0.20, 0.50, 0.08) },          // panoramic roof
      { view: 'top', role: 'antenna', paint: 'body', path: S([[-1.70, 0, 'c'], [-1.80, 0.03], [-1.90, 0, 'c'], [-1.80, -0.03]]) },
      { view: 'front', role: 'wiper', paint: 'black', path: poly([[-0.62, 1.095], [0.05, 1.105], [0.05, 1.095], [-0.62, 1.086]]) },
      { view: 'front', role: 'wiper', paint: 'black', path: poly([[0.62, 1.095], [-0.05, 1.105], [-0.05, 1.095], [0.62, 1.086]]) },
      // body-paint highlight along each wing crest, catching light above the bonnet
      { view: 'front', role: 'trim', paint: 'body', path: S(CAY_CREST) },
      { view: 'front', role: 'trim', paint: 'body', path: S(mir(CAY_CREST, 0).reverse()) },
      { view: 'front', role: 'vent', paint: 'black', path: rrect(-0.42, 0.455, 0.42, 0.465, 0.004) },
      { view: 'front', role: 'vent', paint: 'black', path: rrect(-0.44, 0.385, 0.44, 0.395, 0.004) },
      { view: 'front', role: 'mirror', paint: 'body', path: S(CAY_MIR) },
      { view: 'front', role: 'mirror', paint: 'body', path: S(mir(CAY_MIR, 0).reverse()) },
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: sym([[0, 1.03], [0.62, 1.03, 'c'], [0.62, 0.99, 'c'], [0, 0.99]], 0) },
      { view: 'rear', role: 'mirror', paint: 'body', path: S(CAY_MIR) },
      { view: 'rear', role: 'mirror', paint: 'body', path: S(mir(CAY_MIR, 0).reverse()) }
    ].concat(DRL_FRAMES);

    built.push({
      id: 'porsche-cayenne-e3', make: 'Porsche', name: 'Cayenne', gen: 'E3 (9Y0) facelift', years: '2023–', style: 'suv',
      look: { head: 'oval-4pt', tail: 'light-bar', grille: 'slats' },   // renderer lamp / grille signature
      badgeText: { rear: 'PORSCHE' },   // tailgate lettering is the maker name
      default: true, enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice',
      ref: {
        length: 4.930, width: 1.983, height: 1.698, wheelbase: WB, trackF: 1.676, trackR: 1.653,
        frontOverhang: FO, rearOverhang: RO, wheelDiameter_in: 20, tireF: TF, tireR: TF,
        groundClearance: 0.211, rideHeight: 0.211, cd: 0.36, curbWeight_kg: 2122, widthMirrors: 2.194
      },
      side: side, top: top, front: front, rear: rear, details: details,
      sections: buildSections({ shoulder: [[2.4, 0.84], [2.0, 0.93], [1.0, 0.985], [-1.0, 1.0], [-2.1, 1.02], [-2.5, 0.98]],
        hoodDrop: 0.03, deckDrop: 0.01, glassBase: [-2.40, 1.15], endW: [0.72, 0.80] }, side, top, { trackF: 1.676, trackR: 1.653, tireF: TF, tireR: TF }),
      signature: {
        headlights: 'Slim matrix-LED units following the wing line, each with the Porsche four-point DRL (four light elements around the main lens).',
        taillights: 'Three-dimensional LED tail lamps joined by a full-width light strip across the tailgate, PORSCHE lettering beneath it.',
        grille: 'No upper grille: body-colour nose with a slim cooling slot, a wide trapezoidal lower intake and slatted corner intakes.',
        notes: 'Long, low-domed bonnet with raised wings; fast windscreen; roof falls gently into a roof spoiler over a raked tailgate. Rear quarter window with an upswept kink; black B/C pillars.'
      }
    });
  })();

  /* ================================================================== */
  /* 2. RANGE ROVER SPORT (L461, 2022–)                                  */
  /*    4946 × 2047 × 1820 mm, wb 2997, 275/45 R21, Cd 0.29, 216 mm GC.  */
  /*    Tracks approx 1.700 / 1.695 (not published in available sheets). */
  /* ================================================================== */
  (function () {
    var WB = 2.997, H = WB / 2, FO = 0.915, RO = 1.034;
    var XF = H + FO, XR = -(H + RO);                       // 2.4135 / -2.5325
    var TF = '275/45R21', rT = tireR(TF);                  // 0.3905
    var AR = 0.435, CY = r5(rT);

    var archFpts = roundArch(H, CY, AR, 0.345, 0.335);
    var archRpts = roundArch(-H, CY, AR, 0.355, 0.345);

    var body = S([].concat(
      [[2.30, 0.30, 'c'], [2.385, 0.36], [2.408, 0.45], [XF, 0.62], [2.412, 0.80], [2.405, 0.95], [2.385, 1.005],
       [2.27, 1.03], [1.90, 1.06], [1.40, 1.09], [1.00, 1.12, 'c'],
       [0.55, 1.455], [0.12, 1.768], [-0.20, 1.812], [-0.60, 1.820], [-1.20, 1.808], [-1.80, 1.775],
       [-2.15, 1.735], [-2.25, 1.722, 'c'], [-2.235, 1.69, 'c'], [-2.32, 1.50], [-2.40, 1.27, 'c'],
       [-2.47, 1.16], [-2.51, 1.02], [-2.528, 0.86], [XR, 0.70], [-2.52, 0.54], [-2.48, 0.42],
       [-2.40, 0.35, 'c'], [-2.10, 0.355]],
      archRpts,
      [[-0.60, 0.335], [0.60, 0.335]],
      archFpts,
      [[2.10, 0.325]]
    ));

    // floating roof: every pillar is gloss black so the DLO reads as one dark band tapering to the rear
    var greenhouse = S([[0.93, 1.15, 'c'], [0.55, 1.435], [0.15, 1.728], [-0.30, 1.775], [-1.00, 1.775], [-1.70, 1.745],
      [-2.10, 1.705, 'c'], [-2.06, 1.50], [-2.30, 1.32, 'c'], [-1.60, 1.272], [-1.20, 1.255], [0.0, 1.20], [0.60, 1.18]]);
    var windows = [
      S([[0.84, 1.19, 'c'], [0.50, 1.44], [0.22, 1.68], [0.0, 1.728], [-0.10, 1.736, 'c'], [-0.08, 1.205, 'c'], [0.40, 1.192]]),
      S([[-0.18, 1.742, 'c'], [-0.70, 1.755], [-1.30, 1.748, 'c'], [-1.28, 1.235, 'c'], [-0.70, 1.215], [-0.17, 1.200, 'c']]),
      // rear quarter glass tapers to a near point under the falling roof (DLO 'blade' kick)
      S([[-1.40, 1.742, 'c'], [-1.75, 1.722], [-2.04, 1.66, 'c'], [-2.00, 1.515, 'c'], [-1.85, 1.33], [-1.60, 1.28], [-1.38, 1.245, 'c']])
    ];
    var pillars = [
      poly([[0.93, 1.15], [0.55, 1.435], [0.15, 1.728], [0.0, 1.728], [0.22, 1.68], [0.50, 1.44], [0.84, 1.19]]),
      poly([[-0.10, 1.736], [-0.18, 1.742], [-0.17, 1.200], [-0.08, 1.198]]),
      poly([[-1.30, 1.748], [-1.40, 1.745], [-1.38, 1.242], [-1.28, 1.235]]),
      // D-pillar blacked out from the quarter glass back to the tailgate cut: the 'floating roof'
      // lower edge is one straight rising line shared with the greenhouse (no body-colour tooth)
      poly([[-2.00, 1.515], [-2.04, 1.66], [-2.15, 1.722], [-2.225, 1.70], [-2.30, 1.50], [-2.36, 1.32],
        [-1.85, 1.29], [-1.60, 1.275], [-1.85, 1.33]])
    ];
    var doorCuts = [
      O([[0.93, 1.15], [0.98, 0.85], [0.96, 0.45], [0.90, 0.37, 'c'], [-0.10, 0.37, 'c'], [-0.12, 0.60], [-0.08, 1.198]]),
      O([[-0.17, 1.200], [-0.19, 0.60], [-0.16, 0.37, 'c'], [-0.80, 0.37], [-0.985, 0.405], [-1.035, 0.55], [-1.13, 0.72], [-1.30, 0.84],
        [-1.40, 0.876, 'c'], [-1.40, 1.242]])
    ];
    var panelLines = [
      O([[2.385, 0.985], [1.80, 1.025], [1.30, 1.06], [0.98, 1.085]]),                // clamshell bonnet shut line, high on the wing
      O([[-2.235, 1.69], [-2.33, 1.40], [-2.40, 1.22], [-2.48, 1.05], [-2.51, 0.84]]),  // tailgate cut
      rrect(-1.84, 1.02, -1.68, 1.13, 0.025),                                           // fuel flap
      O([[2.405, 0.70], [2.20, 0.74], [2.00, 0.80], [1.86, 0.86]])                     // bumper / wing split
    ];
    var characterLines = [
      O([[0.98, 0.56], [0.0, 0.585], [-1.00, 0.625]])                                  // rising lower body sculpt
    ];
    var sill = S([[1.06, 0.335, 'c'], [0.0, 0.33], [-1.06, 0.345, 'c'], [-1.04, 0.43, 'c'], [0.0, 0.42], [1.04, 0.42, 'c']]);
    var lowerTrim = [
      S([[1.04, 0.395, 'c'], [0.0, 0.39], [-1.04, 0.405, 'c'], [-1.035, 0.43, 'c'], [0.0, 0.42], [1.035, 0.42, 'c']]),
      S([[2.30, 0.30, 'c'], [2.375, 0.37], [2.25, 0.36], [2.12, 0.355, 'c'], [2.10, 0.325, 'c']]),
      S([[-2.40, 0.35, 'c'], [-2.48, 0.42], [-2.44, 0.45], [-2.22, 0.44, 'c'], [-2.10, 0.356, 'c']])
    ];

    var side = {
      body: body, greenhouse: greenhouse, windows: windows, pillars: pillars, doorCuts: doorCuts,
      panelLines: panelLines, characterLines: characterLines, sill: sill, lowerTrim: lowerTrim,
      archF: { x: H, y: CY, r: AR, flare: 0.008, shape: 'round' },
      archR: { x: -H, y: CY, r: AR, flare: 0.008, shape: 'round' }
    };

    var W2 = 2.047 / 2;
    var RRS_ROOF = [[0.14, 0], [0.125, 0.44], [0.04, 0.61], [-0.12, 0.68], [-0.50, 0.698], [-1.0, 0.702], [-1.60, 0.69], [-1.98, 0.64], [-2.18, 0.54], [-2.25, 0]];
    var top = {
      body: sym([[XF, 0], [2.40, 0.35], [2.36, 0.68], [2.25, 0.90], [2.00, 1.00], [1.70, 1.020], [1.50, W2], [1.05, 1.015],
        [0.30, 1.005], [-0.70, 1.005], [-1.15, 1.015], [-1.50, W2], [-1.90, 1.015], [-2.25, 0.97], [-2.45, 0.86],
        [-2.52, 0.62], [-2.53, 0.30], [XR, 0]], 1),
      greenhouse: sym([[1.00, 0], [0.98, 0.52], [0.92, 0.76], [0.60, 0.84], [-1.0, 0.84], [-1.90, 0.80], [-2.25, 0.70],
        [-2.38, 0.48], [-2.42, 0]], 1),
      hood: sym([[2.36, 0], [2.34, 0.50], [2.25, 0.85], [2.00, 0.965], [1.02, 0.86, 'c'], [1.04, 0, 'c']], 1),
      roof: sym(RRS_ROOF, 1),
      deck: sym([[-2.27, 0], [-2.27, 0.60], [-2.38, 0.78], [-2.50, 0.80], [-2.525, 0.45], [-2.53, 0]], 1),
      mirrors: pair([[0.95, 0.98, 'c'], [0.87, 1.105], [0.70, 1.095], [0.74, 0.98, 'c']], 1)
    };

    var front = {
      body: sym([[0, 1.82], [0.40, 1.812], [0.60, 1.79], [0.68, 1.73], [0.77, 1.48], [0.85, 1.24], [0.92, 1.16], [0.985, 1.09],
        [1.015, 0.98], [W2, 0.80], [1.018, 0.60], [0.995, 0.44], [0.96, 0.34], [0.88, 0.30], [0.55, 0.30], [0, 0.30]], 0),
      greenhouse: sym([[0, 1.765], [0.56, 1.755], [0.66, 1.71], [0.83, 1.16, 'c'], [0.40, 1.153], [0, 1.15]], 0),
      bumper: sym([[0, 0.865], [0.48, 0.865], [0.95, 0.865], [1.005, 0.80], [1.012, 0.60], [0.99, 0.44], [0.96, 0.34],
        [0.88, 0.30], [0.55, 0.30], [0, 0.30]], 0),
      grille: [
        sym([[0, 0.955, 'c'], [0.47, 0.955, 'c'], [0.472, 0.94, 'c'], [0.455, 0.78, 'c'], [0, 0.78, 'c']], 0),     // short, wide graphic-mesh grille, top in line with the lamps
        sym([[0, 0.56, 'c'], [0.55, 0.56, 'c'], [0.62, 0.52], [0.60, 0.38, 'c'], [0.52, 0.355, 'c'], [0, 0.355, 'c']], 0) // lower intake
      ],
      intakes: pairPoly([[0.70, 0.70], [0.92, 0.74], [0.965, 0.62], [0.935, 0.42], [0.75, 0.40], [0.68, 0.55]], 0),
      // ultra-slim straight-edged Digital LED lamps, flush with the grille top, sharp outer corner
      headlights: pairPoly([[0.47, 0.875], [0.47, 0.955], [0.935, 0.955], [0.98, 0.94], [0.945, 0.885]], 0),
      // razor-thin DRL blade along the upper edge of each lamp
      drl: pairPoly([[0.49, 0.946], [0.93, 0.948], [0.962, 0.938], [0.955, 0.933], [0.925, 0.940], [0.49, 0.939]], 0),
      splitter: sym([[0, 0.33], [0.70, 0.33], [0.90, 0.33, 'c'], [0.91, 0.31], [0.86, 0.30], [0, 0.30]], 0),
      plateArea: rrect(-0.26, 0.575, 0.26, 0.685, 0.01),
      badgeArea: rrect(-0.30, 0.965, 0.30, 0.995, 0.006),
      badgeText: 'RANGE ROVER'
    };

    var RRS_TAIL = pairPoly([[0.56, 1.15], [0.95, 1.152], [1.0, 1.136], [0.95, 1.12], [0.56, 1.12]], 0);
    var rear = {
      body: sym([[0, 1.82], [0.40, 1.81], [0.58, 1.785], [0.65, 1.72], [0.73, 1.48], [0.82, 1.27], [0.93, 1.19], [0.995, 1.12],
        [1.012, 0.98], [W2, 0.80], [1.018, 0.60], [0.995, 0.46], [0.96, 0.37], [0.88, 0.35], [0.55, 0.355], [0, 0.355]], 0),
      // rear screen: straight sides, square corners
      greenhouse: poly([[0.52, 1.68], [0.58, 1.33], [-0.58, 1.33], [-0.52, 1.68]]),
      bumper: sym([[0, 0.82], [0.60, 0.82], [0.98, 0.84], [1.012, 0.72], [1.00, 0.50], [0.96, 0.37], [0.88, 0.35], [0.55, 0.355], [0, 0.355]], 0),
      // thin red strips running inside the gloss-black band, ending in a sharp wrap at the corner
      taillights: RRS_TAIL,
      diffuser: sym([[0, 0.47], [0.50, 0.47, 'c'], [0.78, 0.45], [0.84, 0.38, 'c'], [0.80, 0.36], [0, 0.36]], 0),
      exhaust: [
        // standard L461: tailpipes hidden behind the bumper (visible quad tips are SV-only)
        { shape: 'hidden', cx: 0.58, cy: 0.40, w: 0.13, h: 0.045 }, { shape: 'hidden', cx: -0.58, cy: 0.40, w: 0.13, h: 0.045 }
      ],
      spoiler: sym([[0, 1.722], [0.56, 1.716], [0.62, 1.69, 'c'], [0, 1.685]], 0),
      plateArea: rrect(-0.26, 0.88, 0.26, 0.99, 0.01),
      badgeArea: rrect(-0.33, 1.112, 0.33, 1.142, 0.006),
      badgeText: 'RANGE ROVER'
    };

    // root starts on the body side (z 0.90) so the mirror never floats in front/rear views
    var mirrorF = [[0.90, 1.17, 'c'], [1.00, 1.165, 'c'], [1.105, 1.21], [1.10, 1.30], [0.99, 1.29, 'c'], [0.90, 1.25, 'c']];
    // rear view: gloss-black D-pillars from the screen edge out to the body side, plus the black roof cap
    var RRS_DPIL = [[0.572, 1.33], [0.779, 1.33], [0.738, 1.45], [0.70, 1.56], [0.655, 1.70], [0.517, 1.70]];
    var RRS_CAP = [[0, 1.816], [0.40, 1.806], [0.575, 1.781], [0.615, 1.76, 'c'], [0, 1.76, 'c']];
    var details = [
      { view: 'side', role: 'mirror', paint: 'body', path: S([[0.90, 1.17, 'c'], [0.87, 1.295], [0.70, 1.31], [0.64, 1.225], [0.72, 1.172, 'c']]) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(0.10, 1.055, 0.30, 1.075, 0.01) },      // flush deploying handles
      { view: 'side', role: 'handle', paint: 'body', path: rrect(-0.98, 1.062, -0.78, 1.082, 0.01) },
      { view: 'side', role: 'vent', paint: 'gloss-black', path: poly([[1.00, 0.745], [1.22, 0.765], [1.20, 0.79], [1.00, 0.775]]) },
      { view: 'side', role: 'trim', paint: 'body', path: poly([[1.04, 0.765], [1.18, 0.776], [1.18, 0.781], [1.04, 0.770]]) },
      { view: 'side', role: 'fuelCap', paint: 'body', path: rrect(-1.84, 1.02, -1.68, 1.13, 0.025) },
      { view: 'side', role: 'antenna', paint: 'gloss-black', path: S([[-1.80, 1.795, 'c'], [-1.90, 1.815], [-2.00, 1.785, 'c']]) },
      { view: 'side', role: 'light', paint: 'light', path: poly([[2.405, 0.90], [2.40, 0.955], [2.28, 0.975], [2.355, 0.905]]) },
      { view: 'side', role: 'light', paint: 'light-red', path: poly([[-2.30, 1.165], [-2.46, 1.155], [-2.49, 1.125], [-2.30, 1.140]]) },   // lamp wraps ~0.15 m onto the flank
      // black contrast roof read along the roofline (floating roof)
      { view: 'side', role: 'roof', paint: 'gloss-black', path: S([[0.10, 1.766, 'c'], [-0.20, 1.81], [-0.60, 1.818], [-1.20, 1.806], [-1.80, 1.773],
        [-2.14, 1.733, 'c'], [-2.12, 1.718, 'c'], [-1.80, 1.752], [-1.20, 1.784], [-0.60, 1.795], [-0.20, 1.788], [0.06, 1.752, 'c']]) }
    ].concat(pillars.map(function (p) { return { view: 'side', role: 'trim', paint: 'gloss-black', path: p }; }), [
      { view: 'top', role: 'trim', paint: 'gloss-black', path: sym(RRS_ROOF, 1) },    // black contrast roof = roof outline itself
      { view: 'top', role: 'trim', paint: 'glass', path: rrect(-1.60, -0.52, -0.10, 0.52, 0.08) },
      { view: 'front', role: 'wiper', paint: 'black', path: poly([[-0.64, 1.145], [0.05, 1.155], [0.05, 1.145], [-0.64, 1.136]]) },
      { view: 'front', role: 'wiper', paint: 'black', path: poly([[0.64, 1.145], [-0.05, 1.155], [-0.05, 1.145], [0.64, 1.136]]) },
      { view: 'front', role: 'mirror', paint: 'body', path: S(mirrorF) },
      { view: 'front', role: 'mirror', paint: 'body', path: S(mir(mirrorF, 0).reverse()) },
      { view: 'rear', role: 'mirror', paint: 'body', path: S(mirrorF) },
      { view: 'rear', role: 'mirror', paint: 'body', path: S(mir(mirrorF, 0).reverse()) },
      // gloss-black 'hidden-until-lit' band spanning the tailgate between the slim lamps
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: poly([[0.70, 1.16], [0.70, 1.09], [-0.70, 1.09], [-0.70, 1.16]]) },
      // floating roof read from behind
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: poly(RRS_DPIL) },
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: poly(mir(RRS_DPIL, 0).reverse()) },
      { view: 'rear', role: 'roof', paint: 'gloss-black', path: sym(RRS_CAP, 0) },
      // vertical bumper reflectors and satin lower finisher
      { view: 'rear', role: 'light', paint: 'light-red', path: rrectPair(0.8875, 0.55, 0.9125, 0.70, 0.008)[0] },
      { view: 'rear', role: 'light', paint: 'light-red', path: rrectPair(0.8875, 0.55, 0.9125, 0.70, 0.008)[1] },
      { view: 'rear', role: 'trim', paint: 'black', path: rrect(-0.94, 0.47, 0.94, 0.50, 0.01) }
    ], RRS_TAIL.map(function (p) { return { view: 'rear', role: 'light', paint: 'light-red', path: p }; }));   // lamp strips drawn over the band

    built.push({
      id: 'range-rover-sport-l461', make: 'Land Rover', name: 'Range Rover Sport', gen: 'L461', years: '2022–', style: 'suv',
      look: { head: 'slim-led', tail: 'slim', grille: 'mesh' },   // renderer lamp / grille signature
      badgeText: { front: 'RANGE ROVER', rear: 'RANGE ROVER' },   // bonnet-edge and tailgate lettering (not the maker name)
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice',
      ref: {
        length: 4.946, width: 2.047, height: 1.820, wheelbase: WB, trackF: 1.700, trackR: 1.695,
        frontOverhang: FO, rearOverhang: RO, wheelDiameter_in: 21, tireF: TF, tireR: TF,
        groundClearance: 0.216, rideHeight: 0.216, cd: 0.29, curbWeight_kg: 2310, widthMirrors: 2.209
      },
      side: side, top: top, front: front, rear: rear, details: details,
      sections: buildSections({ shoulder: [[2.4, 0.93], [2.0, 0.99], [1.0, 1.0], [-1.0, 1.0], [-2.2, 1.01], [-2.55, 0.98]],
        hoodDrop: 0.02, deckDrop: 0.01, glassBase: [-2.40, 1.28], endW: [0.72, 0.80] }, side, top, { trackF: 1.700, trackR: 1.695, tireF: TF, tireR: TF }),
      signature: {
        headlights: 'Ultra-slim Digital LED headlamps set flush in line with the top of the grille, a razor-thin DRL blade along the upper edge.',
        taillights: 'Slim horizontal lamps joined by a gloss-black band across the tailgate that hides the lights until lit; RANGE ROVER lettering in the band.',
        grille: 'Wide, shallow grille with a fine graphic mesh, a large lower intake and vertical corner blades.',
        notes: 'Floating roof (all pillars blacked out), DLO tapering to a point at the rear, near-flat beltline, clamshell bonnet whose shut line runs high along the wing, flush deploying door handles, horizontal side vent behind the front wheel.'
      }
    });
  })();

  /* ================================================================== */
  /* 3. LAMBORGHINI URUS (2018–2022)                                     */
  /*    5112 × 2016 × 1638 mm, wb 3003, track 1695 / 1710,               */
  /*    285/45 ZR21 F, 315/40 ZR21 R, 2200 kg.                           */
  /* ================================================================== */
  (function () {
    var WB = 3.003, H = WB / 2, FO = 1.012, RO = 1.097;
    var XF = H + FO, XR = -(H + RO);                       // 2.5135 / -2.5985
    var TF = '285/45R21', TR = '315/40R21';
    var rF = tireR(TF), rR = tireR(TR);                    // 0.3950 / 0.3927
    var AR = 0.45;
    var CYF = r5(rF), CYR = r5(rR);

    var archFpts = hexArch(H, CYF, AR, 0.28, 0.27);
    var archRpts = hexArch(-H, CYR, AR, 0.29, 0.28);

    var body = S([].concat(
      [[2.42, 0.25, 'c'], [2.49, 0.30], [2.508, 0.40], [XF, 0.48], [2.50, 0.58], [2.47, 0.67], [2.42, 0.74],
       [2.32, 0.785], [1.90, 0.84], [1.40, 0.90], [0.95, 0.97], [0.72, 1.005, 'c'],
       [0.30, 1.27], [-0.18, 1.585], [-0.45, 1.630], [-0.70, 1.638], [-1.10, 1.625], [-1.55, 1.57],
       [-1.95, 1.475], [-2.22, 1.385], [-2.39, 1.315], [-2.47, 1.29, 'c'], [-2.46, 1.25, 'c'],
       [-2.50, 1.14], [-2.56, 1.00], [-2.585, 0.85], [XR, 0.70], [-2.59, 0.55], [-2.56, 0.42],
       [-2.48, 0.30, 'c'], [-2.15, 0.29]],
      archRpts,
      [[-0.60, 0.27], [0.60, 0.27]],
      archFpts,
      [[2.20, 0.265]]
    ));

    var greenhouse = S([[0.66, 1.035, 'c'], [0.30, 1.265], [-0.08, 1.51], [-0.40, 1.595], [-0.90, 1.605], [-1.40, 1.55],
      [-1.82, 1.43], [-2.03, 1.33, 'c'], [-1.70, 1.19], [-0.60, 1.09], [0.20, 1.05]]);
    var windows = [   // frameless glass
      S([[0.58, 1.06, 'c'], [0.25, 1.27], [-0.02, 1.45], [-0.25, 1.560], [-0.42, 1.585, 'c'], [-0.40, 1.088, 'c'], [0.20, 1.062]]),
      S([[-0.50, 1.590, 'c'], [-0.95, 1.592], [-1.35, 1.532, 'c'], [-1.33, 1.135, 'c'], [-0.90, 1.103], [-0.49, 1.090, 'c']]),
      S([[-1.44, 1.515, 'c'], [-1.78, 1.430], [-1.95, 1.345, 'c'], [-1.68, 1.200, 'c'], [-1.42, 1.165, 'c']])
    ];
    var pillars = [
      poly([[0.66, 1.035], [0.30, 1.265], [-0.08, 1.51], [-0.25, 1.560], [-0.02, 1.45], [0.25, 1.27], [0.58, 1.06]]),
      poly([[-0.42, 1.585], [-0.50, 1.590], [-0.49, 1.090], [-0.40, 1.088]]),
      poly([[-1.35, 1.532], [-1.44, 1.515], [-1.42, 1.165], [-1.33, 1.135]]),
      poly([[-1.95, 1.345], [-2.03, 1.33], [-1.70, 1.19], [-1.68, 1.200]])
    ];
    var doorCuts = [
      O([[0.66, 1.035], [0.72, 0.80], [0.70, 0.45], [0.64, 0.31, 'c'], [-0.45, 0.31, 'c'], [-0.48, 0.60], [-0.45, 1.088]]),
      // rear door: smooth curve following the hexagonal arch lip up to the C-pillar
      O([[-0.49, 1.090], [-0.52, 0.60], [-0.50, 0.31, 'c'], [-0.99, 0.31, 'c'], [-1.04, 0.58], [-1.16, 0.80], [-1.30, 0.94],
        [-1.37, 1.04], [-1.38, 1.15]])
    ];
    var panelLines = [
      O([[2.38, 0.76], [1.80, 0.82], [1.20, 0.89], [0.70, 0.985]]),                      // bonnet shut line along wing
      O([[-2.45, 1.25], [-2.49, 1.14], [-2.545, 0.99], [-2.575, 0.82]]),                 // tailgate cut
      rrect(-1.86, 1.02, -1.70, 1.13, 0.02),                                            // fuel flap
      O([[2.47, 0.62], [2.20, 0.66], [2.02, 0.70], [1.95, 0.75]])                       // bumper / wing split
    ];
    var characterLines = [
      O([[1.95, 0.80], [1.40, 0.875], [1.00, 0.92], [0.0, 0.98], [-1.20, 1.06], [-2.45, 1.10]]),   // rising shoulder crease to the haunch
      O([[1.02, 0.47], [0.0, 0.43], [-1.02, 0.50]]),                                   // sharp sill crease
      O([[0.70, 0.62], [0.0, 0.68], [-0.95, 0.80]])                                    // diagonal door sculpt ('Y' flank)
    ];
    var sill = S([[1.05, 0.27, 'c'], [0.0, 0.265], [-1.05, 0.28, 'c'], [-1.04, 0.36, 'c'], [0.0, 0.35], [1.04, 0.35, 'c']]);
    var lowerTrim = [
      sill,
      S([[2.42, 0.25, 'c'], [2.49, 0.30], [2.40, 0.31], [2.20, 0.30, 'c'], [2.20, 0.265, 'c']]),
      S([[-2.48, 0.30, 'c'], [-2.55, 0.39], [-2.53, 0.415], [-2.25, 0.40, 'c'], [-2.15, 0.29, 'c']])
    ];

    var side = {
      body: body, greenhouse: greenhouse, windows: windows, pillars: pillars, doorCuts: doorCuts,
      panelLines: panelLines, characterLines: characterLines, sill: sill, lowerTrim: lowerTrim,
      // well radius = hexagon flat-top height (cy + 0.95 * 0.45), ~0.035 m above the tyre
      archF: { x: H, y: CYF, r: 0.43, flare: 0.02, shape: 'hex', path: O(archFpts) },
      archR: { x: -H, y: CYR, r: 0.43, flare: 0.02, shape: 'hex', path: O(archRpts) }
    };

    var W2 = 2.016 / 2;
    var top = {
      body: sym([[XF, 0], [2.50, 0.35], [2.45, 0.68], [2.33, 0.89], [2.10, 0.985], [1.80, 1.006], [1.50, W2], [1.05, 0.99],
        [0.30, 0.965], [-0.60, 0.965], [-1.10, 1.011], [-1.50, 1.0135], [-1.90, 1.011], [-2.30, 0.96], [-2.52, 0.84],   // rear haunch clears the 315 tyres
        [-2.585, 0.60], [-2.595, 0.30], [XR, 0]], 1),
      greenhouse: sym([[0.70, 0], [0.68, 0.50], [0.60, 0.74], [0.30, 0.80], [-1.0, 0.80], [-1.80, 0.74], [-2.20, 0.60],
        [-2.36, 0.40], [-2.38, 0]], 1),
      hood: sym([[2.40, 0], [2.38, 0.45], [2.28, 0.80], [2.00, 0.92], [0.75, 0.82, 'c'], [0.76, 0, 'c']], 1),
      roof: sym([[-0.10, 0], [-0.115, 0.40], [-0.19, 0.545], [-0.33, 0.605], [-0.65, 0.622], [-1.05, 0.625], [-1.45, 0.612], [-1.70, 0.57], [-1.85, 0.45], [-1.90, 0]], 1),
      deck: sym([[-2.36, 0], [-2.36, 0.55], [-2.42, 0.64], [-2.52, 0.68], [-2.58, 0.40], [-2.59, 0]], 1),
      mirrors: pair([[0.66, 0.94, 'c'], [0.58, 1.098], [0.42, 1.09], [0.46, 0.94, 'c']], 1),
      // Y-shaped bonnet creases (hexagon/Y motif)
      characterLines: [
        O([[2.30, 0.30], [1.80, 0.22], [1.30, 0.14], [0.80, 0.12]]), O([[2.30, -0.30], [1.80, -0.22], [1.30, -0.14], [0.80, -0.12]]),
        O([[2.25, 0.62], [1.80, 0.40], [1.40, 0.18]]), O([[2.25, -0.62], [1.80, -0.40], [1.40, -0.18]])
      ]
    };

    var front = {
      body: sym([[0, 1.638], [0.36, 1.63], [0.52, 1.605], [0.60, 1.55], [0.70, 1.32], [0.80, 1.10], [0.88, 1.00], [0.96, 0.93],
        [1.0, 0.82], [W2, 0.66], [0.998, 0.50], [0.97, 0.36], [0.93, 0.28], [0.84, 0.25], [0.55, 0.25], [0, 0.25]], 0),
      greenhouse: sym([[0, 1.585], [0.48, 1.575], [0.58, 1.53], [0.78, 1.065, 'c'], [0.40, 1.057], [0, 1.055]], 0),
      bumper: sym([[0, 0.70], [0.42, 0.70], [0.90, 0.70], [0.99, 0.66], [1.0, 0.50], [0.97, 0.36], [0.93, 0.28], [0.84, 0.25],
        [0.55, 0.25], [0, 0.25]], 0),
      // V creases running down the bonnet from the windscreen base to the lamps (Y/hexagon motif)
      panelLines: [O([[0.18, 1.04], [0.30, 0.93], [0.42, 0.82]]), O([[-0.18, 1.04], [-0.30, 0.93], [-0.42, 0.82]])],
      // sharp wing crests standing ~0.03 m above the bonnet
      characterLines: [O([[0.66, 1.035], [0.74, 1.05], [0.80, 1.052], [0.86, 1.035]]), O([[-0.66, 1.035], [-0.74, 1.05], [-0.80, 1.052], [-0.86, 1.035]])],
      grille: [
        sym([[0, 0.64, 'c'], [0.40, 0.64, 'c'], [0.47, 0.47, 'c'], [0.52, 0.30, 'c'], [0, 0.30, 'c']], 0),     // hexagonal centre intake, wide base
        sym([[0, 0.735, 'c'], [0.30, 0.73, 'c'], [0.34, 0.705, 'c'], [0, 0.705, 'c']], 0)                    // slim upper slot
      ],
      intakes: pairPoly([[0.52, 0.64], [0.92, 0.68], [0.975, 0.48], [0.92, 0.30], [0.60, 0.33], [0.545, 0.46]], 0),
      // thin (0.04 m) blade lamps climbing outward from the intake corner to the wing
      headlights: pairPoly([[0.40, 0.70], [0.43, 0.73], [0.93, 0.80], [0.975, 0.79], [0.955, 0.77], [0.60, 0.712]], 0),
      // Y-shaped DRL: a long upper blade with a short lower blade branching off it
      drl: [].concat(
        pairPoly([[0.50, 0.744], [0.90, 0.794], [0.90, 0.786], [0.50, 0.736]], 0),
        pairPoly([[0.70, 0.765], [0.81, 0.753], [0.81, 0.746], [0.70, 0.757]], 0)),
      splitter: sym([[0, 0.275], [0.85, 0.275], [0.94, 0.28, 'c'], [0.90, 0.25, 'c'], [0, 0.25, 'c']], 0),
      plateArea: rrect(-0.26, 0.43, 0.26, 0.54, 0.01),
      badgeArea: rrect(-0.05, 0.775, 0.05, 0.82, 0.008),
      badgeText: 'LAMBORGHINI'
    };

    // slim lamps sloping down to the centre, wrapping out to the widened haunch (outer tip y 1.17)
    var URUS_TL = [[0.58, 1.12], [0.88, 1.172], [0.968, 1.172], [0.985, 1.150], [0.983, 1.122], [0.92, 1.114], [0.60, 1.093]];
    var URUS_LENS = [[0.60, 1.115], [0.88, 1.164], [0.964, 1.164], [0.979, 1.148], [0.976, 1.128], [0.92, 1.121], [0.61, 1.100]];
    // Y graphic: stem from the inner end, upper arm along the top edge, lower arm branching to the outer edge (arms >= 0.012 m)
    var URUS_Y = [[0.63, 1.105], [0.63, 1.119], [0.88, 1.161], [0.964, 1.161], [0.973, 1.149], [0.90, 1.149], [0.80, 1.133],
      [0.90, 1.136], [0.975, 1.136], [0.974, 1.124], [0.90, 1.123], [0.78, 1.120]];
    var rear = {
      body: sym([[0, 1.638], [0.35, 1.628], [0.50, 1.60], [0.57, 1.54], [0.66, 1.36], [0.80, 1.30], [0.93, 1.25], [0.995, 1.17], [1.003, 1.06],
        [1.006, 0.90], [W2, 0.72], [0.998, 0.52], [0.97, 0.38], [0.92, 0.31], [0.84, 0.30], [0.55, 0.30], [0, 0.30]], 0),
      greenhouse: sym([[0, 1.50], [0.46, 1.498, 'c'], [0.52, 1.30, 'c'], [0, 1.30]], 0),
      bumper: sym([[0, 0.66], [0.60, 0.66], [0.97, 0.70], [1.0, 0.56], [0.97, 0.38], [0.92, 0.31], [0.84, 0.30], [0.55, 0.30], [0, 0.30]], 0),
      // slim (0.045 m) lamps sloping down toward the centre
      taillights: pairPoly(URUS_TL, 0),
      diffuser: sym([[0, 0.50], [0.36, 0.50, 'c'], [0.80, 0.52, 'c'], [0.86, 0.40, 'c'], [0.80, 0.30], [0, 0.30]], 0),
      exhaust: [
        { shape: 'trapezoid', cx: 0.48, cy: 0.40, w: 0.13, h: 0.07 }, { shape: 'trapezoid', cx: 0.64, cy: 0.40, w: 0.13, h: 0.07 },
        { shape: 'trapezoid', cx: -0.48, cy: 0.40, w: 0.13, h: 0.07 }, { shape: 'trapezoid', cx: -0.64, cy: 0.40, w: 0.13, h: 0.07 }
      ],
      spoiler: sym([[0, 1.285], [0.62, 1.281], [0.68, 1.247, 'c'], [0, 1.24]], 0),
      plateArea: rrect(-0.26, 0.78, 0.26, 0.89, 0.01),
      badgeArea: rrect(-0.30, 1.055, 0.30, 1.09, 0.006),
      badgeText: 'LAMBORGHINI'
    };

    // root starts on the body side (z 0.82) so the mirror never floats in front/rear views
    var mirrorF = [[0.82, 1.06, 'c'], [0.96, 1.05, 'c'], [1.098, 1.10], [1.09, 1.18], [0.95, 1.17, 'c'], [0.82, 1.12, 'c']];
    var details = [
      // dark hexagonal wheel wells (the trapezoidal arch reaches past a round well's radius)
      { view: 'side', role: 'trim', paint: 'black', path: poly(archFpts) },
      { view: 'side', role: 'trim', paint: 'black', path: poly(archRpts) },
      // slim body-colour arch lips (0.03 m) around the hexagonal openings
      { view: 'side', role: 'trim', paint: 'body', path: archBand(hexArch, H, CYF, AR, 0.03, 0.28, 0.27) },
      { view: 'side', role: 'trim', paint: 'body', path: archBand(hexArch, -H, CYR, AR, 0.03, 0.29, 0.28) },
      { view: 'side', role: 'mirror', paint: 'body', path: S([[0.62, 1.08, 'c'], [0.58, 1.20], [0.42, 1.212], [0.38, 1.13], [0.46, 1.082, 'c']]) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(0.06, 0.995, 0.24, 1.025, 0.012) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(-0.94, 1.022, -0.76, 1.052, 0.012) },
      { view: 'side', role: 'fuelCap', paint: 'body', path: rrect(-1.86, 1.02, -1.70, 1.13, 0.02) },
      { view: 'side', role: 'intake', paint: 'black', path: poly([[2.36, 0.33], [2.49, 0.34], [2.50, 0.55], [2.40, 0.50]]) },
      { view: 'side', role: 'antenna', paint: 'gloss-black', path: S([[-1.45, 1.565, 'c'], [-1.55, 1.588], [-1.65, 1.545, 'c']]) },
      { view: 'side', role: 'light', paint: 'light', path: poly([[2.42, 0.74], [2.37, 0.775], [2.24, 0.795], [2.36, 0.735]]) },
      // wraparound Y slit: upper arm along the haunch, leg dropping down the tailgate edge
      { view: 'side', role: 'light', paint: 'light-red', path: poly([[-2.27, 1.19], [-2.455, 1.205], [-2.50, 1.125], [-2.485, 1.12], [-2.44, 1.178], [-2.29, 1.172]]) },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: pillars[1] },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: pillars[2] },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: pillars[3] },
      { view: 'top', role: 'trim', paint: 'glass', path: rrect(-1.65, -0.48, -0.25, 0.48, 0.08) },
      { view: 'front', role: 'trim', paint: 'body', path: pairPoly([[0.60, 0.585], [0.88, 0.625], [0.88, 0.605], [0.62, 0.567]], 0)[0] },
      { view: 'front', role: 'trim', paint: 'body', path: pairPoly([[0.60, 0.585], [0.88, 0.625], [0.88, 0.605], [0.62, 0.567]], 0)[1] },
      // second, lower blade: the two blades read as the Y in each side intake
      { view: 'front', role: 'trim', paint: 'body', path: pairPoly([[0.62, 0.51], [0.88, 0.48], [0.88, 0.46], [0.63, 0.49]], 0)[0] },
      { view: 'front', role: 'trim', paint: 'body', path: pairPoly([[0.62, 0.51], [0.88, 0.48], [0.88, 0.46], [0.63, 0.49]], 0)[1] },
      { view: 'front', role: 'wiper', paint: 'black', path: poly([[-0.60, 1.055], [0.05, 1.065], [0.05, 1.055], [-0.60, 1.046]]) },
      { view: 'front', role: 'wiper', paint: 'black', path: poly([[0.60, 1.055], [-0.05, 1.065], [-0.05, 1.055], [0.60, 1.046]]) },
      { view: 'front', role: 'mirror', paint: 'body', path: S(mirrorF) },
      { view: 'front', role: 'mirror', paint: 'body', path: S(mir(mirrorF, 0).reverse()) },
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: sym([[0, 1.11], [0.58, 1.112, 'c'], [0.60, 1.09, 'c'], [0, 1.04]], 0) },
      // smoked lens inside each slim lamp, with the Y graphic lit across it
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: pairPoly(URUS_LENS, 0)[0] },
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: pairPoly(URUS_LENS, 0)[1] },
      { view: 'rear', role: 'light', paint: 'light-red', path: pairPoly(URUS_Y, 0)[0] },
      { view: 'rear', role: 'light', paint: 'light-red', path: pairPoly(URUS_Y, 0)[1] },
      // vertical bumper reflectors
      { view: 'rear', role: 'light', paint: 'light-red', path: rrectPair(0.915, 0.45, 0.945, 0.60, 0.008)[0] },
      { view: 'rear', role: 'light', paint: 'light-red', path: rrectPair(0.915, 0.45, 0.945, 0.60, 0.008)[1] },
      { view: 'rear', role: 'mirror', paint: 'body', path: S(mirrorF) },
      { view: 'rear', role: 'mirror', paint: 'body', path: S(mir(mirrorF, 0).reverse()) }
    ];

    built.push({
      id: 'lamborghini-urus', make: 'Lamborghini', name: 'Urus', gen: '1st gen', years: '2018–2022', style: 'suv',
      look: { head: 'y-blade', tail: 'y-shape', grille: 'hex' },   // renderer lamp / grille signature
      badgeText: { front: '', rear: 'LAMBORGHINI' },   // no nose lettering (shield only, not drawn); tailgate lettering is the maker name
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice',
      ref: {
        length: 5.112, width: 2.016, height: 1.638, wheelbase: WB, trackF: 1.695, trackR: 1.710,
        frontOverhang: FO, rearOverhang: RO, wheelDiameter_in: 21, tireF: TF, tireR: TR,
        groundClearance: 0.158, rideHeight: 0.158, cd: 0.33, curbWeight_kg: 2200, widthMirrors: 2.196
      },
      side: side, top: top, front: front, rear: rear, details: details,
      sections: buildSections({ shoulder: [[2.5, 0.70], [2.0, 0.84], [1.0, 0.94], [-1.0, 0.98], [-2.0, 0.99], [-2.6, 0.96]],
        hoodDrop: 0.04, deckDrop: 0.02, deckW: 0.70, glassBase: [-2.43, 1.27], endW: [0.60, 0.80], F0: 0.685, dropFlatRearGlass: true }, side, top, { trackF: 1.695, trackR: 1.710, tireF: TF, tireR: TR }),
      signature: {
        headlights: 'Narrow, angular headlamps with a Y-shaped LED daytime-running signature formed by two blades.',
        taillights: 'Slim wraparound tail lamps with an inner Y graphic, linked by a black band carrying LAMBORGHINI lettering.',
        grille: 'Huge hexagonal centre intake with large Y-bladed side intakes and a sharp front splitter; slim slot under the bonnet.',
        notes: 'Super-SUV coupe roofline sloping hard into a tailgate lip; frameless windows; long Y-creased bonnet; trapezoidal/hexagonal wheel arches with black cladding; quad trapezoidal tailpipes in a black diffuser.'
      }
    });
  })();

  built.forEach(register);
  var api = { models: built, tireRadius: tireR };
  CB.shapes.suvModels = built;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

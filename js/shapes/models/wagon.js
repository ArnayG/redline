/* ==========================================================================
   FORGE Atelier — js/shapes/models/wagon.js
   Real-car shape models for body style 'wagon':
     - Audi RS 6 Avant (C8, 2019–)
     - Mercedes-AMG E 63 S 4MATIC+ Estate (S213 facelift, 2020–2023)
     - Volvo V60 T8 Polestar Engineered (2019–)

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y) seen from the right-hand side; top view = (x, z);
   front & rear views = (z, y).

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}. Body
   outlines are built as smooth G1 cubic splines through hand-placed
   landmarks taken from published dimensions and reference photography.
   Brand names are text only: no manufacturer logo artwork is drawn;
   badgeArea only marks where a text badge goes.

   Classic script, zero dependencies, no DOM. Registers via
   CB.shapes.registerModel when core.js has loaded, otherwise queues on
   CB.shapes._pending (core.js drains the queue when it loads).
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ */
  /* Geometry helpers (local; this file must not depend on core.js)      */
  /* ------------------------------------------------------------------ */

  function r4(v) { return Math.round(v * 10000) / 10000; }
  function pt(a, b) { return [r4(a), r4(b)]; }
  function norm(v) {
    var l = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    return l > 1e-12 ? [v[0] / l, v[1] / l] : [1, 0];
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function dist(a, b) { var d = sub(a, b); return Math.sqrt(d[0] * d[0] + d[1] * d[1]); }

  /* Spline landmarks: [a, b] smooth point, [a, b, 'c'] corner,
     [a, b, [ta, tb]] smooth point with explicit tangent (direction of travel). */
  function tangents(pts, closed) {
    var n = pts.length, out = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i], f = p[2];
      var prev = (i > 0) ? pts[i - 1] : (closed ? pts[n - 1] : null);
      var next = (i < n - 1) ? pts[i + 1] : (closed ? pts[0] : null);
      var tin, tout;
      if (Array.isArray(f)) { tin = tout = norm(f); }
      else if (f === 'c') {
        tin = prev ? norm(sub(p, prev)) : norm(sub(next, p));
        tout = next ? norm(sub(next, p)) : norm(sub(p, prev));
      } else {
        var t;
        if (prev && next) {
          // chord-length weighted tangent: smooth with uneven spacing
          var d0 = Math.max(dist(p, prev), 1e-9), d1 = Math.max(dist(next, p), 1e-9);
          var u0 = norm(sub(p, prev)), u1 = norm(sub(next, p));
          t = norm([u0[0] * d1 + u1[0] * d0, u0[1] * d1 + u1[1] * d0]);
        } else t = prev ? norm(sub(p, prev)) : norm(sub(next, p));
        tin = tout = t;
      }
      out.push({ tin: tin, tout: tout });
    }
    return out;
  }

  /* Cubic segments from pts[0] through the rest (no leading M). */
  function splSegs(pts, closed) {
    var n = pts.length, tg = tangents(pts, closed), segs = [];
    var last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var ta = tg[i].tout, tb = tg[(i + 1) % n].tin;
      var d = dist(a, b) / 3;
      segs.push({ t: 'C', p: [pt(a[0] + ta[0] * d, a[1] + ta[1] * d), pt(b[0] - tb[0] * d, b[1] - tb[1] * d), pt(b[0], b[1])] });
    }
    return segs;
  }
  function spl(pts, closed) {
    var segs = [{ t: 'M', p: [pt(pts[0][0], pts[0][1])] }].concat(splSegs(pts, closed));
    if (closed) segs.push({ t: 'Z', p: [] });
    return segs;
  }
  function poly(pts) {
    var segs = [{ t: 'M', p: [pt(pts[0][0], pts[0][1])] }];
    for (var i = 1; i < pts.length; i++) segs.push({ t: 'L', p: [pt(pts[i][0], pts[i][1])] });
    segs.push({ t: 'Z', p: [] });
    return segs;
  }
  /* Circular arc as cubic segments (no leading M); angles in radians. */
  function arcSegs(cx, cy, r, a0, a1) {
    var sweep = a1 - a0, n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    var d = sweep / n, k = 4 / 3 * Math.tan(d / 4), segs = [];
    for (var i = 0; i < n; i++) {
      var s = a0 + d * i, e = s + d;
      var x0 = cx + r * Math.cos(s), y0 = cy + r * Math.sin(s);
      var x1 = cx + r * Math.cos(e), y1 = cy + r * Math.sin(e);
      segs.push({ t: 'C', p: [
        pt(x0 - k * r * Math.sin(s), y0 + k * r * Math.cos(s)),
        pt(x1 + k * r * Math.sin(e), y1 - k * r * Math.cos(e)),
        pt(x1, y1)] });
    }
    return segs;
  }
  function ellipse(cx, cy, rx, ry) {
    var k = 0.5522847498;
    return [
      { t: 'M', p: [pt(cx + rx, cy)] },
      { t: 'C', p: [pt(cx + rx, cy + ry * k), pt(cx + rx * k, cy + ry), pt(cx, cy + ry)] },
      { t: 'C', p: [pt(cx - rx * k, cy + ry), pt(cx - rx, cy + ry * k), pt(cx - rx, cy)] },
      { t: 'C', p: [pt(cx - rx, cy - ry * k), pt(cx - rx * k, cy - ry), pt(cx, cy - ry)] },
      { t: 'C', p: [pt(cx + rx * k, cy - ry), pt(cx + rx, cy - ry * k), pt(cx + rx, cy)] },
      { t: 'Z', p: [] }];
  }
  /* Rounded rectangle (a = horizontal axis of the view, b = vertical). */
  function rrect(a0, b0, a1, b1, rad) {
    var x0 = Math.min(a0, a1), x1 = Math.max(a0, a1), y0 = Math.min(b0, b1), y1 = Math.max(b0, b1);
    var r = Math.min(rad || 0, (x1 - x0) / 2, (y1 - y0) / 2);
    if (r <= 0) return poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    var H = Math.PI / 2, s = [{ t: 'M', p: [pt(x0 + r, y0)] }, { t: 'L', p: [pt(x1 - r, y0)] }];
    s = s.concat(arcSegs(x1 - r, y0 + r, r, -H, 0)); s.push({ t: 'L', p: [pt(x1, y1 - r)] });
    s = s.concat(arcSegs(x1 - r, y1 - r, r, 0, H)); s.push({ t: 'L', p: [pt(x0 + r, y1)] });
    s = s.concat(arcSegs(x0 + r, y1 - r, r, H, 2 * H)); s.push({ t: 'L', p: [pt(x0, y0 + r)] });
    s = s.concat(arcSegs(x0 + r, y0 + r, r, 2 * H, 3 * H)); s.push({ t: 'Z', p: [] });
    return s;
  }
  /* Mirror a path; axis 0 mirrors the first coordinate (front/rear views: z),
     axis 1 mirrors the second (top view: z). */
  function mirror(path, axis) {
    return path.map(function (sg) {
      return { t: sg.t, p: sg.p.map(function (q) { return axis === 1 ? pt(q[0], -q[1]) : pt(-q[0], q[1]); }) };
    });
  }
  function pair(path, axis) { return path.concat(mirror(path, axis || 0)); }
  function join() { var o = []; for (var i = 0; i < arguments.length; i++) o = o.concat(arguments[i]); return o; }
  /* Closed symmetric outline from a half: pts start and end on the mirror axis. */
  function symHalf(pts, axis) {
    axis = axis || 0;
    var n = pts.length, full = pts.slice();
    for (var i = n - 2; i >= 1; i--) {
      var p = pts[i], f = p[2], m;
      if (Array.isArray(f)) f = axis === 1 ? [-f[0], f[1]] : [f[0], -f[1]];
      m = axis === 1 ? [p[0], -p[1]] : [-p[0], p[1]];
      if (f !== undefined) m.push(f);
      full.push(m);
    }
    return spl(full, true);
  }
  /* Flatten a spline through landmarks into a dense polyline; returns y(x) sampler. */
  function curveFn(pts) {
    var segs = splSegs(pts, false), poly = [pts[0].slice(0, 2)], cur = pts[0];
    segs.forEach(function (s) {
      var p0 = cur, c1 = s.p[0], c2 = s.p[1], p3 = s.p[2];
      for (var i = 1; i <= 24; i++) {
        var t = i / 24, u = 1 - t;
        poly.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
                   u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]]);
      }
      cur = p3;
    });
    poly.sort(function (a, b) { return a[0] - b[0]; });
    return function (x) {
      if (x <= poly[0][0]) return poly[0][1];
      for (var i = 1; i < poly.length; i++) {
        if (x <= poly[i][0]) {
          var a = poly[i - 1], b = poly[i], t = (x - a[0]) / Math.max(b[0] - a[0], 1e-12);
          return a[1] + (b[1] - a[1]) * t;
        }
      }
      return poly[poly.length - 1][1];
    };
  }
  function samples(fn, x0, x1, n, dy) {
    var o = [];
    for (var i = 1; i < n; i++) { var x = x0 + (x1 - x0) * i / n; o.push([x, fn(x) + (dy || 0)]); }
    return o;
  }
  /* Thin strip following y = fn(x) between x0..x1 (top edge at fn + off0, bottom at fn + off1). */
  function strip(fn, x0, x1, off0, off1) {
    // dense sampling (~6 cm) so the strip follows tight kinks such as the Volvo hockey-stick belt
    var n = Math.max(8, Math.ceil(Math.abs(x1 - x0) / 0.06));
    var top = [[x0, fn(x0) + off0, 'c']].concat(samples(fn, x0, x1, n, off0), [[x1, fn(x1) + off0, 'c']]);
    var bot = [[x1, fn(x1) + off1, 'c']].concat(samples(fn, x1, x0, n, off1), [[x0, fn(x0) + off1, 'c']]);
    return spl(top.concat(bot), true);
  }
  /* Clamp every point (incl. control points, so the curve hull too) to x >= minX. */
  function clampX(path, minX) {
    return path.map(function (sg) { return { t: sg.t, p: sg.p.map(function (q) { return pt(Math.max(q[0], minX), q[1]); }) }; });
  }
  /* Rearmost x of a closed outline at height y (horizontal slice). */
  function rearX(pts, y) {
    var lo = Infinity;
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1];
      if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
      lo = Math.min(lo, a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
    }
    return lo;
  }
  /* Keep a side-view lamp inside the body tail: control points pulled to body + margin. */
  function clampToTail(path, bodyPts, margin) {
    return path.map(function (sg) {
      return { t: sg.t, p: sg.p.map(function (q) { var bx = rearX(bodyPts, q[1]); return pt(isFinite(bx) ? Math.max(q[0], bx + margin) : q[0], q[1]); }) };
    });
  }
  /* Hexagonal honeycomb cells (pointy-top) inside a convex outline, mirrored pairs about z = 0. */
  function honeycomb(outline, cell, gap, hole) {   // hole: optional [z0, y0, z1, y1] keep-out (number plate)
    var P = flat(outline), s = [], rr = cell / 2 - gap / 2, dx = cell * 0.866, dy = cell * 0.75;
    function inside(z, y) {   // even-odd test
      var c = false;
      for (var i = 0, j = P.length - 1; i < P.length; j = i++) {
        var a = P[i], b = P[j];
        if ((a[1] > y) !== (b[1] > y) && z < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    }
    var b = { y0: Infinity, y1: -Infinity, z1: 0 };
    P.forEach(function (q) { b.y0 = Math.min(b.y0, q[1]); b.y1 = Math.max(b.y1, q[1]); b.z1 = Math.max(b.z1, q[0]); });
    for (var row = 0, y = b.y0 + cell * 0.6; y < b.y1 - cell * 0.4; row++, y += dy) {
      for (var z = (row % 2 ? 0 : dx / 2); z < b.z1; z += dx) {
        var hex = [];
        for (var k = 0; k < 6; k++) { var an = Math.PI / 2 + k * Math.PI / 3; hex.push([z + rr * Math.cos(an), y + rr * Math.sin(an)]); }
        if (!hex.every(function (q) { return inside(q[0], q[1]); })) continue;
        if (hole && hex.some(function (q) { var az = Math.abs(q[0]); return az < hole[2] + gap && q[1] > hole[1] - gap && q[1] < hole[3] + gap; })) continue;
        s = s.concat(poly(hex), z > 1e-9 ? mirror(poly(hex), 0) : []);
      }
    }
    return s;
  }
  /* Thin stroke-like ribbon through landmark points (for character/panel lines rendered as fills). */
  function ribbon(pts, w) {
    var fn = curveFn(pts), x0 = Math.min(pts[0][0], pts[pts.length - 1][0]), x1 = Math.max(pts[0][0], pts[pts.length - 1][0]);
    return strip(fn, x1, x0, w / 2, -w / 2);
  }

  /* Tyre overall diameter (m) from an ISO size string like '275/35R21'. */
  function tyreDia(s) {
    var m = /(\d+)\/(\d+)\s*Z?R\s*(\d+)/.exec(s);
    return (parseInt(m[3], 10) * 25.4 + 2 * parseInt(m[1], 10) * parseInt(m[2], 10) / 100) / 1000;
  }

  /* Front/rear-view upper silhouette: flat wide wagon crown, glass, shoulder.
     Values are the RS 6 crown (W = 0.9755, H = 1.460), scaled to each car. */
  /* Below the belt the side eases in to W - ins at y 0.85 and reaches the full half-width
     only across the wheel-arch band (y 0.45-0.70), so the arches read as the widest point. */
  function crown(W, H, ins) {
    var k = W / 0.9755, dh = H - 1.460;
    ins = ins == null ? 0.04 : ins;
    return [[0, H, [1, 0]], [0.560 * k, H - 0.008, [1, -0.12]], [0.660 * k, H - 0.040], [0.740 * k, 1.300 + dh],
      [0.820 * k, 1.120 + dh * 0.5], [0.900 * k, 1.010], [W - ins - 0.01, 0.955], [W - ins, 0.850],
      [W - 0.004, 0.700], [W, 0.575, [0, -1]], [W - 0.004, 0.450]];
  }
  /* Front view: side window glass seen beyond the A-pillar (right half). */
  function frontSideGlass(W, H) {
    var k = W / 0.9755, dh = H - 1.460;
    return spl([[0.752 * k, 1.040, 'c'], [0.632 * k, 1.378 + dh, 'c'], [0.668 * k, 1.378 + dh, 'c'], [0.812 * k, 1.060, 'c'], [0.800 * k, 1.040, 'c']], true);
  }
  /* Volvo "Thor's hammer" DRL (right half): 0.024 m bar z 0.430-0.786, 0.026 x 0.130 m head at the outer end. */
  function thorHammer() {
    return poly([[0.430, 0.718], [0.786, 0.718], [0.786, 0.665], [0.812, 0.665], [0.812, 0.795], [0.786, 0.795], [0.786, 0.742], [0.430, 0.742]]);
  }
  /* Shift a front/rear-view path vertically. */
  function shiftY(path, d) { return path.map(function (sg) { return { t: sg.t, p: sg.p.map(function (q) { return pt(q[0], q[1] + d); }) }; }); }
  /* Ring path (outer minus inner) for frames: inner half reversed by mirroring. */
  function frame(outerHalf, innerHalf) { return symHalf(outerHalf).concat(mirror(symHalf(innerHalf), 0)); }

  /* Flatten a path to a polyline (for 3D sections). */
  function flat(path) {
    var pts = [], cur = null, st = null;
    (path || []).forEach(function (sg) {
      if (sg.t === 'M') { cur = sg.p[0]; st = cur; pts.push(cur); }
      else if (sg.t === 'L') { cur = sg.p[0]; pts.push(cur); }
      else if (sg.t === 'C') {
        var c = [cur].concat(sg.p);
        for (var i = 1; i <= 12; i++) {
          var t = i / 12, u = 1 - t;
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
  function lerpTab(tab, u) {
    if (u <= tab[0][0]) return tab[0][1];
    for (var i = 1; i < tab.length; i++) if (u <= tab[i][0]) {
      var t = (u - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]); return tab[i - 1][1] + (tab[i][1] - tab[i - 1][1]) * t;
    }
    return tab[tab.length - 1][1];
  }

  /* Explicit 3D cross-sections (ringHalf: bottom centre → side → top centre, [y, z]).
     Flat wide roof, defined shoulder, tumblehome above the belt, rocker tuck, blunt
     bumper ends (≥ 85 % width) and wheel wells stepped in just inboard of the tyres. */
  function buildSections(c, side, top) {
    var sb = flat(side.body), tb = flat(top.body), W = c.ref.width / 2;
    // the DLO landmarks live in the layout frame; map them like the side view (overhangMap) so the
    // glass band lines up with the remapped side greenhouse
    var fx = c.overhangMap || function (x) { return x; }, g0 = c.dlo;
    var g = { aBase: [fx(g0.aBase[0]), g0.aBase[1]], belt: g0.belt.map(function (q) { return [fx(q[0]), q[1]]; }) };
    var belt = curveFn(g.belt), tipX = fx(g0.top[g0.top.length - 1][0]), cowlX = c.cowlX;
    var minX = Infinity, maxX = -Infinity; sb.forEach(function (q) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); });
    var cowlY = sliceAt(sb, cowlX)[1];
    var arches = [side.archF, side.archR], r = c.ref;
    var wells = [[side.archF, r.trackF, r.tireF], [side.archR, r.trackR, r.tireR]].map(function (A) {
      var tw = parseInt(/(\d+)\//.exec(A[2])[1], 10) / 1000;
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - tw / 2 - 0.02 };
    });
    function bottom(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.08;
        if (Math.abs(x - a.x) < e) { var l = sliceAt(sb, a.x - e), q = sliceAt(sb, a.x + e); return l[0] + (q[0] - l[0]) * (x - a.x + e) / (2 * e); }
      }
      return sliceAt(sb, x)[0];
    }
    // greenhouse cross-section, fractions of local half-width vs height above belt
    var GH = [[0, 0.923], [0.244, 0.841], [0.644, 0.759], [0.91, 0.677], [0.98, 0.574], [1, 0]];
    var LOW = [[0, 0.80], [0.03, 0.90], [0.08, 0.925], [0.2, 0.965], [0.4, 0.99], [0.6, 1.0], [0.85, 0.997], [1, 0.985]];
    var xs = [], NS = 46;
    for (var k = 0; k <= NS; k++) { var t = k / NS; xs.push(minX + 0.012 + (maxX - minX - 0.024) * (1 - Math.cos(Math.PI * t)) / 2); }
    wells.forEach(function (wl) { [-1.0, -0.8, -0.5, 0, 0.5, 0.8, 1.0].forEach(function (f) { xs.push(wl.x + f * wl.r); }); });
    [cowlX, cowlX + 0.05, cowlX - 0.012, (cowlX + g.aBase[0]) / 2, g.aBase[0], g.aBase[0] - 0.02, g.aBase[0] + 0.02, tipX, tipX - 0.03, tipX + 0.02, -2.20, -2.28, -2.36, -2.44].forEach(function (x) { xs.push(x); });
    xs.sort(function (a, b) { return a - b; });
    xs = xs.filter(function (x, i) { return x >= minX + 0.01 && x <= maxX - 0.01 && (i === 0 || x - xs[i - 1] > 0.01); });
    // cap rings just inside the bumper tips (half the plan width) so the end faces close softly
    xs = [minX + 0.004].concat(xs, [maxX - 0.004]);
    return xs.map(function (x, idx) {
      var s = sliceAt(sb, x), yt = s[1], yb = Math.min(bottom(x), yt - 0.1);
      var hw = sliceAt(tb, x), w = hw ? Math.max(Math.abs(hw[0]), Math.abs(hw[1])) : 0.3;
      var end = idx === 0 || idx === xs.length - 1;
      // overhangs follow the plan outline (rounded bumper corners); only the cabin/arch band is floored
      var inEnds = x > side.archF.x + side.archF.r || x < side.archR.x - side.archR.r;
      if (end) w = Math.min(0.5 * w, W);
      else w = inEnds ? Math.min(Math.max(w, W * 0.45), W) : Math.min(Math.max(w, W * 0.88), W);
      var yBelt = belt(Math.max(Math.min(x, g.aBase[0]), tipX));
      var gh = x < cowlX + 0.02 && yt > yBelt + 0.06;
      // lower windscreen between the side DLO and the cowl: glass crown right down to the cowl
      var ws = !gh && x > tipX && x < cowlX - 0.01 && yt > cowlY - 0.02;
      var ys = gh ? Math.min(c.shoulderY || 0.955, yBelt - 0.045) : Math.min(c.shoulderY || 0.955, yt - 0.05);
      var h = [[yb, 0], [yb, 0.5 * w]];
      var LY = [];
      LOW.forEach(function (q) { LY.push([yb + q[0] * (ys - yb), q[1] * w]); });
      // wheel well step
      wells.forEach(function (wl) {
        var dx = x - wl.x; if (Math.abs(dx) >= wl.r * 0.995) return;
        var yA = wl.y + Math.sqrt(wl.r * wl.r - dx * dx);
        if (yA >= ys - 0.02) yA = ys - 0.02;
        var out = [];
        LY.forEach(function (q) { if (q[0] < yA) out.push([q[0], Math.min(q[1], wl.zIn)]); });
        out.push([yA, wl.zIn], [yA + 0.004, lerpTab(LOW.map(function (q) { return [yb + q[0] * (ys - yb), q[1] * w]; }), yA + 0.004)]);
        LY.forEach(function (q) { if (q[0] > yA + 0.004) out.push(q); });
        LY = out;
      });
      h = h.concat(LY);
      if (gh) {
        var H = yt - yBelt;
        h.push([ys + 0.5 * (yBelt - ys), 0.955 * w]);
        h.push([yBelt - 0.01, 0.94 * w]);   // keeps the glass/body step on every resampled station
        GH.forEach(function (q) { h.push([yBelt + q[0] * H, q[1] * w]); });
        h.splice(h.length - 1, 0, [yt - 0.002, 0.3 * w]);
      } else if (ws) {
        var dw = yt - ys;
        h.push([ys + 0.55 * dw, 0.955 * w], [yt - 0.012, 0.80 * w], [yt - 0.005, 0.66 * w], [yt - 0.0015, 0.40 * w], [yt, 0]);
      } else {
        var dh = yt - ys;
        h.push([ys + 0.55 * dh, 0.955 * w], [yt - 0.006, 0.86 * w], [yt - 0.001, 0.5 * w], [yt, 0]);
      }
      // D-pillar / tailgate: taper the upper body inboard toward the tail instead of a full-width slab
      if (x < tipX) {
        var tf = 1 - 0.12 * Math.min(1, Math.max(0, (tipX - x) / Math.max(tipX - minX, 0.05)));
        h = h.map(function (q) { return q[0] > 0.95 ? [q[0], q[1] * (1 - (1 - tf) * Math.min(1, (q[0] - 0.95) / 0.15))] : q; });
      }
      if (end) {
        // the plan width already pulls the cap in (ef = 1)
        h = h.map(function (q) { return [Math.min(Math.max(q[0], yb + 0.02), yt - 0.02), q[1]]; });
      }
      var bl = null;
      if (gh && x > tipX) bl = yBelt;
      else if (ws) bl = yt - 0.027;
      if (x <= tipX - 0.005 && x >= minX + 0.02 && yt > c.tailBelt + 0.04) bl = c.tailBelt;   // glass tailgate
      return { x: r4(x), ring: h.map(function (q) { return pt(q[0], q[1]); }), ringHalf: true,
        belt: bl == null ? null : r4(bl) };
    });
  }

  /* Remap overhangs beyond the arches (keeps arches circular). */
  function remapOverhangs(path, fx) {
    return path.map(function (sg) { return { t: sg.t, p: sg.p.map(function (q) { return pt(fx(q[0]), q[1]); }) }; });
  }

  /* ------------------------------------------------------------------ */
  /* Generic wagon assembler — per-car landmarks in, contract model out  */
  /* ------------------------------------------------------------------ */
  function buildSide(c) {
    var a = c.ref.wheelbase / 2, yb = c.sillY;
    var rF = tyreDia(c.ref.tireF) / 2, rR = tyreDia(c.ref.tireR) / 2;
    var arF = { x: a, y: rF, r: rF + c.archGapF, flare: c.flareF };
    var arR = { x: -a, y: rR, r: rR + c.archGapR, flare: c.flareR };
    function archCut(ar) {
      var dy = ar.y - yb, dx = Math.sqrt(ar.r * ar.r - dy * dy);
      return { x0: ar.x - dx, x1: ar.x + dx, a0: Math.atan2(yb - ar.y, -dx), a1: Math.atan2(yb - ar.y, dx) - 2 * Math.PI };
    }
    var cr = archCut(arR), cf = archCut(arF);
    var prof = c.profile;
    var body = [{ t: 'M', p: [pt(prof[0][0], prof[0][1])] }].concat(splSegs(prof, false));
    body.push({ t: 'L', p: [pt(cr.x0, yb)] });
    body = body.concat(arcSegs(arR.x, arR.y, arR.r, cr.a0, cr.a1));
    body.push({ t: 'L', p: [pt(cf.x0, yb)] });
    body = body.concat(arcSegs(arF.x, arF.y, arF.r, cf.a0, cf.a1));
    if (c.frontLower) c.frontLower.forEach(function (q) { body.push({ t: 'L', p: [pt(q[0], q[1])] }); });
    body.push({ t: 'Z', p: [] });

    /* greenhouse / DLO */
    var g = c.dlo, top = curveFn(g.top), belt = curveFn(g.belt);
    var tip = g.top[g.top.length - 1], aB = g.aBase, aT = g.top[0];
    var aMid = [(aB[0] + aT[0]) / 2 + g.aBow * 0.5, (aB[1] + aT[1]) / 2 + g.aBow];
    var green = [[aB[0], aB[1], 'c'], aMid].concat(g.top.slice(0, -1).map(function (p, i) { return i === 0 ? [p[0], p[1]] : p; }));
    green.push([tip[0], tip[1], 'c']);
    green = green.concat(g.belt.slice(1, -1).reverse());
    var greenhouse = spl(green, true);

    /* windows: inset from DLO by the surround width */
    var ins = g.inset, aFn = function (y) { // A-pillar line x at height y (straight approx incl. bow)
      var t = (y - aB[1]) / (aT[1] - aB[1]);
      return aB[0] + (aT[0] - aB[0]) * t + g.aBow * 0.5 * 4 * t * (1 - t);
    };
    function win(xf_top, xf_bot, xr_top, xr_bot, frontIsA, rearIsTip) {
      var pts = [];
      if (frontIsA) {
        var yb0 = belt(aB[0] - ins * 2.2) + ins, yt0 = top(aT[0] - ins * 1.6) - ins;
        pts.push([aFn(yb0) - ins * 1.6, yb0, 'c']);
        pts.push([aFn((yb0 + yt0) / 2) - ins * 1.4, (yb0 + yt0) / 2]);
        pts.push([aFn(yt0) - ins * 1.2, yt0, 'c']);
        xf_top = aFn(yt0) - ins * 1.2; xf_bot = aFn(yb0) - ins * 1.6;
      } else {
        pts.push([xf_bot, belt(xf_bot) + ins, 'c']);
        pts.push([xf_top, top(xf_top) - ins, 'c']);
      }
      if (rearIsTip) {
        var tx = tip[0] + ins * 2.5;
        pts = pts.concat(samples(top, xf_top, tx, 6, -ins));
        pts.push([tx, (top(tx) + belt(tx)) / 2, 'c']);
        pts = pts.concat(samples(belt, tx, xf_bot, 6, ins));
      } else {
        pts = pts.concat(samples(top, xf_top, xr_top, 6, -ins));
        pts.push([xr_top, top(xr_top) - ins, 'c']);
        pts.push([xr_bot, belt(xr_bot) + ins, 'c']);
        pts = pts.concat(samples(belt, xr_bot, xf_bot, 6, ins));
      }
      return spl(pts, true);
    }
    var B = g.B, C = g.C;
    var windows = [
      win(0, 0, B[0][0], B[0][1], true, false),
      win(B[1][0], B[1][1], C[0][0], C[0][1], false, false),
      win(C[1][0], C[1][1], 0, 0, false, true)];
    function pillar(P) {
      return poly([[P[0][1], belt(P[0][1])], [P[0][0], top(P[0][0])], [P[1][0], top(P[1][0])], [P[1][1], belt(P[1][1])]]);
    }
    var pillars = [pillar(B), pillar(C)];

    return {
      body: body, greenhouse: greenhouse, windows: windows, pillars: pillars,
      doorCuts: c.doorCuts.map(function (d) { return ribbon(d, 0.006); }),
      panelLines: c.panelLines.map(function (d) { return d.length && d[0] && d[0].t ? d : ribbon(d, 0.005); }),
      characterLines: c.characterLines.map(function (d) { return ribbon(d, 0.008); }),
      sill: c.sill, archF: arF, archR: arR, lowerTrim: c.lowerTrim,
      _belt: belt, _top: top
    };
  }

  function buildModel(c) {
    var side = buildSide(c);
    var belt = side._belt, top = side._top;
    delete side._belt; delete side._top;
    var roof = curveFn(c.profile.filter(function (q) { return q[1] > 1.25; }));
    var det = (typeof c.details === 'function') ? c.details({ belt: belt, top: top, roof: roof, side: side, bodyPts: flat(side.body) }) : c.details;
    // B/C pillars on all three cars are gloss-black glass-look trims (floating-roof effect)
    side.pillars.forEach(function (pp) { det.push({ view: 'side', role: 'trim', path: pp, paint: c.pillarPaint || 'gloss-black' }); });
    var ref = c.ref, topv = c.top;
    if (c.overhangMap) {          // stretch/compress the overhangs beyond the arch edges (arches stay circular)
      var fx = c.overhangMap;
      var walk = function (o) {
        if (Array.isArray(o) && o.length && o[0] && typeof o[0].t === 'string') return remapOverhangs(o, fx);
        if (Array.isArray(o)) return o.map(walk);
        if (o && typeof o === 'object') { var n = {}; for (var k in o) n[k] = (k === 'archF' || k === 'archR') ? o[k] : walk(o[k]); return n; }
        return o;
      };
      side = walk(side); topv = walk(topv);
      det = det.map(function (d) {
        if (d.view !== 'side' && d.view !== 'top') return d;
        var o = {}; for (var k in d) o[k] = d[k]; o.path = remapOverhangs(d.path, fx); return o;
      });
    }
    var m = {
      id: c.id, make: c.make, name: c.name, gen: c.gen, years: c.years, style: 'wagon',
      enginePosition: 'front', drivetrain: c.drivetrain, powertrain: c.powertrain,
      engine: c.engine,
      ref: ref,
      side: side,
      top: topv,
      front: c.front,
      rear: c.rear,
      details: det,
      look: c.look,
      signature: c.signature
    };
    if (c.color) m.color = c.color;
    if (c.wheel) m.wheel = c.wheel;
    m.sections = buildSections(c, side, topv);
    return m;
  }

  /* ================================================================== */
  /* 1. Audi RS 6 Avant (C8)                                             */
  /* ================================================================== */
  function rs6() {
    var ref = {
      length: 4.995, width: 1.951, height: 1.460, wheelbase: 2.929, trackF: 1.668, trackR: 1.650,
      frontOverhang: 1.010, rearOverhang: 1.056, wheelDiameter_in: 21, tireF: '275/35R21', tireR: '275/35R21',
      groundClearance: 0.120, rideHeight: 0.120, cd: 0.35, curbWeight_kg: 2075
    };
    var xF = 1.4645 + 1.010, xR = -(1.4645 + 1.056);   // 2.4745 / -2.5205
    var RS6_GRILLE = symHalf([[0, 0.730, [1, 0]], [0.400, 0.730, 'c'], [0.500, 0.660, 'c'], [0.500, 0.420, 'c'], [0.400, 0.250, 'c'], [0, 0.250, [-1, 0]]]);
    var c = {
      id: 'audi-rs6-avant-c8', make: 'Audi', name: 'RS 6 Avant', gen: 'C8', years: '2019–',
      look: { head: 'slim-led', tail: 'light-bar', grille: 'honeycomb' },   // renderer lamp / grille signature
      drivetrain: 'awd', powertrain: 'ice', engine: '4.0 TFSI twin-turbo V8 (48 V mild hybrid), 600 PS',
      ref: ref, sillY: 0.200, archGapF: 0.028, archGapR: 0.028, flareF: 0.055, flareR: 0.055, cowlX: 1.050, shoulderY: 0.955, tailBelt: 1.05,
      color: '#8b8e90',                 // Nardo Grey
      wheel: { caliper: '#c8102e' },
      /* front-bottom → over the roof → rear-bottom */
      profile: [
        [2.400, 0.140, 'c'],
        [2.455, 0.215],
        [xF, 0.530, [0, 1]],            // most forward point: blunt Singleframe face
        [2.458, 0.705],
        [2.385, 0.815],                 // headlamp top / bonnet leading edge (matches the front-view lamp top)
        [2.200, 0.848],
        [1.700, 0.906],
        [1.050, 0.984],                 // cowl / windscreen base
        [0.750, 1.140],
        [0.450, 1.288],
        [0.150, 1.425],                 // header (windscreen ~26-28 deg)
        [-0.250, 1.460, [-1, 0]],       // roof peak (incl. flush black roof rails)
        [-1.200, 1.448],
        [-1.950, 1.410],
        [-2.250, 1.388, 'c'],           // roof-spoiler trailing edge
        [-2.290, 1.350, 'c'],
        [-2.410, 1.100],                // tailgate glass, ~30 deg Avant D-pillar rake
        [-2.480, 0.935],
        [xR, 0.700, [0, -1]],           // most rearward: bumper
        [-2.508, 0.420],
        [-2.460, 0.255, 'c'],           // diffuser top edge
        [-2.380, 0.200, 'c']
      ],
      frontLower: [[2.080, 0.180], [2.400, 0.140]],
      dlo: {
        aBase: [0.930, 1.006], aBow: 0.018, inset: 0.014,
        top: [[0.220, 1.356], [-0.400, 1.393], [-1.200, 1.381], [-1.800, 1.352], [-2.080, 1.322], [-2.180, 1.268], [-2.225, 1.110]],
        belt: [[0.930, 1.006], [-0.400, 1.035], [-1.600, 1.062], [-2.000, 1.078], [-2.225, 1.110]],
        B: [[-0.165, -0.135], [-0.245, -0.215]],   // [top x, belt x] front edge, rear edge
        C: [[-1.215, -1.245], [-1.300, -1.335]]
      },
      doorCuts: [
        [[0.958, 0.996], [0.995, 0.760], [0.985, 0.470], [0.925, 0.285]],
        [[-0.200, 1.034], [-0.192, 0.640], [-0.185, 0.285]],
        [[-1.300, 1.055], [-1.304, 0.805], [-1.132, 0.695], [-1.023, 0.524], [-1.000, 0.290]],
        [[0.925, 0.285], [0.0, 0.282], [-1.000, 0.290]]
      ],
      panelLines: [
        [[2.320, 0.818], [1.800, 0.885], [1.060, 0.968]],                       // bonnet shut line
        [[-2.205, 1.372], [-2.395, 0.990], [-2.460, 0.665], [-2.512, 0.645]],   // tailgate
        rrect(-1.705, 0.870, -1.535, 0.990, 0.02),                              // fuel door (right rear)
        [[2.420, 0.600], [2.250, 0.560], [1.980, 0.520], [1.840, 0.470]]        // bumper / wing seam
      ],
      characterLines: [
        [[2.170, 0.793], [1.400, 0.869], [0.000, 0.918], [-1.600, 0.940], [-2.270, 0.952]], // shoulder (tornado) line
        [[2.100, 0.818], [1.800, 0.832], [1.300, 0.833], [1.080, 0.822], [1.000, 0.790]],   // front quattro blister crease
        [[-1.000, 0.800], [-1.080, 0.830], [-1.400, 0.838], [-1.900, 0.836], [-2.150, 0.826]], // rear quattro blister crease
        [[0.960, 0.455], [0.000, 0.470], [-1.020, 0.500]]                                  // lower door concave
      ],
      sill: poly([[1.090, 0.200], [-1.090, 0.200], [-1.080, 0.282], [1.080, 0.282]]),
      lowerTrim: join(
        poly([[1.090, 0.200], [-1.090, 0.200], [-1.080, 0.236], [1.080, 0.236]]),            // gloss sill blade
        spl([[1.850, 0.190, 'c'], [2.400, 0.140, 'c'], [2.430, 0.180], [2.200, 0.215], [1.870, 0.245, 'c']], true), // splitter
        spl([[-2.400, 0.200, 'c'], [-1.880, 0.200, 'c'], [-1.895, 0.250, 'c'], [-2.450, 0.250, 'c']], true)          // diffuser side strip
      ),
      top: {
        body: symHalf([
          [xF, 0, [0, 1]], [2.455, 0.450], [2.360, 0.780], [2.100, 0.935], [1.750, 0.968],
          [1.4645, 0.9755, [-1, 0]], [0.900, 0.955], [0.000, 0.932], [-0.900, 0.952],
          [-1.4645, 0.9755, [-1, 0]], [-1.950, 0.962], [-2.300, 0.900], [-2.455, 0.760], [-2.508, 0.540], [-2.519, 0.260],
          [xR, 0, [0, -1]]], 1),
        greenhouse: symHalf([[1.030, 0, [0, 1]], [1.005, 0.500], [0.930, 0.800, 'c'], [0.000, 0.836], [-1.500, 0.822],
          [-2.050, 0.780], [-2.350, 0.700], [-2.392, 0.450], [-2.400, 0, [0, -1]]], 1),
        hood: symHalf([[2.400, 0, [0, 1]], [2.380, 0.420], [2.300, 0.660], [2.150, 0.780, 'c'], [1.060, 0.800, 'c'],
          [1.010, 0.620], [1.020, 0, [0, -1]]], 1),
        roof: symHalf([[0.220, 0, [0, 1]], [0.214, 0.420], [0.180, 0.590], [0.020, 0.650], [-0.400, 0.665], [-2.000, 0.640], [-2.280, 0.560, 'c'],
          [-2.300, 0, 'c']], 1),
        deck: clampX(symHalf([[-2.300, 0, 'c'], [-2.300, 0.580, 'c'], [-2.440, 0.620], [-2.498, 0.500], [xR + 0.01, 0, [0, -1]]], 1), xR + 0.01),
        mirrors: (function (mp) { return [mp, mirror(mp, 1)]; })(spl([[0.985, 0.880, 'c'], [0.800, 0.905, 'c'], [0.760, 1.040], [0.800, 1.075], [0.880, 1.070], [0.950, 0.990]], true))   // one path per side
      },
      front: {
        body: symHalf(crown(0.9755, 1.460, 0.04).concat([[0.9505, 0.260], [0.900, 0.165], [0.700, 0.140], [0, 0.135, [-1, 0]]])),
        greenhouse: symHalf([[0, 1.405, [1, 0]], [0.500, 1.400, [1, -0.06]], [0.540, 1.392, 'c'], [0.660, 1.030, 'c'], [0.540, 1.005], [0, 0.995, [-1, 0]]]),
        bumper: symHalf([[0, 0.640, [1, 0]], [0.700, 0.645], [0.935, 0.620, 'c'], [0.950, 0.420], [0.935, 0.320], [0.880, 0.175], [0.700, 0.140], [0, 0.135, [-1, 0]]]),
        // C8 RS 6 Singleframe: full +-0.50 width down to y 0.42, chamfered to +-0.40 at 0.25, top under the lamps
        grille: [{ path: RS6_GRILLE, paint: 'grille', pattern: 'honeycomb' }],
        intakes: [
          pair(spl([[0.585, 0.600, 'c'], [0.860, 0.625, 'c'], [0.900, 0.500], [0.870, 0.270, 'c'], [0.640, 0.215, 'c'], [0.555, 0.330, 'c']], true)),
          pair(poly([[0.905, 0.300], [0.935, 0.320], [0.948, 0.560], [0.920, 0.590]]))     // air curtains
        ],
        headlights: [pair(spl([[0.420, 0.800, 'c'], [0.900, 0.815, 'c'], [0.945, 0.770, 'c'], [0.880, 0.730], [0.640, 0.735, 'c'], [0.600, 0.770, 'c'], [0.440, 0.772, 'c']], true))],
        drl: [pair((function () {   // segmented DRL bars along the stepped lower edge
          var s = []; for (var i = 0; i < 4; i++) s = s.concat(rrect(0.660 + 0.054 * i, 0.741, 0.702 + 0.054 * i, 0.750, 0.003));
          for (var j = 0; j < 2; j++) s = s.concat(rrect(0.470 + 0.058 * j, 0.778, 0.514 + 0.058 * j, 0.787, 0.003));
          return s;
        })())],
        splitter: symHalf([[0, 0.180, 'c'], [0.700, 0.185], [0.880, 0.176, 'c'], [0.870, 0.150], [0.700, 0.136], [0, 0.133, 'c']]),
        plateArea: rrect(-0.260, 0.335, 0.260, 0.445, 0.01),
        badgeArea: rrect(-0.110, 0.620, 0.110, 0.700, 0.01),
        badgeText: 'AUDI'
      },
      rear: {
        body: symHalf(crown(0.9755, 1.460, 0.04).concat([[0.9505, 0.300], [0.915, 0.220], [0.700, 0.200], [0, 0.200, [-1, 0]]])),
        // tailgate glass 1.00-1.30: top half-width 0.52, bottom a single convex arc 1.00 (centre) / 1.02 (+-0.62)
        greenhouse: symHalf([[0, 1.300, [1, 0]], [0.470, 1.297, [1, -0.02]], [0.520, 1.284, 'c'], [0.620, 1.020, 'c'], [0.310, 1.005], [0, 1.000, [-1, 0]]]),
        bumper: symHalf([[0, 0.640, [1, 0]], [0.800, 0.645], [0.950, 0.620, 'c'], [0.960, 0.450], [0.940, 0.320], [0.900, 0.220], [0.700, 0.200], [0, 0.200, [-1, 0]]]),
        taillights: [pair(spl([[0.400, 0.976, 'c'], [0.880, 0.988], [0.945, 0.935, 'c'], [0.905, 0.893, 'c'], [0.520, 0.897], [0.420, 0.906, 'c']], true))],
        diffuser: symHalf([[0, 0.400, 'c'], [0.520, 0.400, 'c'], [0.580, 0.380], [0.860, 0.350, 'c'], [0.880, 0.215, 'c'], [0.700, 0.200], [0, 0.200, 'c']]),
        exhaust: [
          { shape: 'oval', cx: -0.690, cy: 0.300, w: 0.230, h: 0.120 },
          { shape: 'oval', cx: 0.690, cy: 0.300, w: 0.230, h: 0.120 }],
        plateArea: rrect(-0.260, 0.700, 0.260, 0.812, 0.01),
        badgeArea: rrect(0.430, 0.830, 0.600, 0.868, 0.006),
        badgeText: 'AUDI',
        spoiler: symHalf([[0, 1.372, [1, 0]], [0.560, 1.368], [0.630, 1.338, 'c'], [0.585, 1.322], [0, 1.326, [-1, 0]]])
      },
      details: function (h) {
        var D = [];
        function d(view, role, path, paint) { D.push({ view: view, role: role, path: path, paint: paint }); }
        // side
        d('side', 'mirror', spl([[0.950, 1.000, 'c'], [0.790, 1.000, 'c'], [0.760, 1.060], [0.800, 1.110], [0.900, 1.110], [0.960, 1.060]], true), 'body');
        d('side', 'handle', rrect(-0.010, 0.896, 0.150, 0.918, 0.010), 'body');
        d('side', 'handle', rrect(-1.050, 0.914, -0.900, 0.936, 0.010), 'body');
        d('side', 'trim', strip(h.roof, 0.000, -2.050, -0.003, -0.027), 'black');           // flush black roof rail
        d('side', 'antenna', spl([[-1.780, 1.420, 'c'], [-1.880, 1.452], [-1.960, 1.418, 'c']], true), 'black');
        d('side', 'trim', strip(h.belt, 0.920, -2.200, 0.000, -0.012), 'gloss-black');      // black-optic belt trim
        d('side', 'trim', spl([[2.385, 0.815, 'c'], [2.250, 0.840], [2.080, 0.840, 'c'], [2.250, 0.790], [2.440, 0.748, 'c']], true), 'light');       // headlamp wrap
        d('side', 'trim', clampToTail(spl([[-2.520, 0.895, 'c'], [-2.300, 0.905], [-2.180, 0.925, 'c'], [-2.180, 1.000, 'c'], [-2.320, 1.009], [-2.520, 1.020, 'c']], true), h.bodyPts, 0.015), 'light-red'); // tail lamp wrap 0.895-1.020
        d('side', 'intake', spl([[2.452, 0.300, 'c'], [2.300, 0.290, 'c'], [2.230, 0.390], [2.310, 0.480, 'c'], [2.462, 0.480, 'c']], true), 'grille');  // corner intake (0.18 m)
        d('side', 'trim', poly([[2.368, 0.296], [2.392, 0.297], [2.392, 0.480], [2.368, 0.480]]), 'body');        // vertical air-curtain blade
        // quattro blisters: light band under the 0.83 crease, shade band above the 0.60 lower edge
        D.push({ view: 'side', role: 'highlight', path: strip(curveFn([[2.100, 0.818], [1.800, 0.832], [1.300, 0.833], [1.080, 0.822], [1.000, 0.790]]), 1.020, 2.090, -0.006, -0.040), paint: 'body', tone: 'light', opacity: 0.25 });
        D.push({ view: 'side', role: 'highlight', path: strip(curveFn([[-1.000, 0.800], [-1.080, 0.830], [-1.400, 0.838], [-1.900, 0.836], [-2.150, 0.826]]), -2.140, -1.020, -0.006, -0.040), paint: 'body', tone: 'light', opacity: 0.25 });
        [[1.800, 2.100], [1.000, 1.140], [-1.140, -1.000], [-2.150, -1.800]].forEach(function (r) {
          D.push({ view: 'side', role: 'shadow', path: strip(function () { return 0.600; }, r[0], r[1], 0.050, 0.004), paint: 'body', tone: 'dark', opacity: 0.28 });
        });
        d('side', 'trim', rrect(1.150, 0.640, 1.250, 0.660, 0.008), 'light-amber');            // side repeater (wing)
        // top
        d('top', 'trim', pair(poly([[0.000, 0.600], [-2.050, 0.585], [-2.050, 0.620], [0.000, 0.640]]), 1), 'black'); // roof rails
        d('top', 'antenna', spl([[-1.780, 0, 'c'], [-1.960, 0.035], [-1.960, -0.035]], true), 'black');
        // front
        d('front', 'mirror', pair(spl([[0.900, 1.000, 'c'], [1.070, 1.010], [1.075, 1.090], [0.960, 1.110, 'c'], [0.900, 1.080, 'c']], true)), 'body');
        d('front', 'wiper', pair(poly([[0.050, 1.010], [0.600, 1.030], [0.600, 1.040], [0.050, 1.020]])), 'black');
        d('front', 'trim', pair(poly([[0.600, 0.794], [0.860, 0.801], [0.860, 0.807], [0.600, 0.800]])), 'light');   // laser/matrix module line
        d('front', 'grille', honeycomb(RS6_GRILLE, 0.042, 0.008, [-0.260, 0.335, 0.260, 0.445]), 'gloss-black');                                  // 3D honeycomb cells
        d('front', 'trim', poly([[-0.330, 0.250], [0.330, 0.250], [0.300, 0.288], [-0.300, 0.288]]), 'body');       // body-colour lower grille lip
        d('front', 'trim', pair(poly([[0.765, 0.300], [0.795, 0.300], [0.795, 0.590], [0.765, 0.590]])), 'body');  // vertical intake blades
        d('front', 'trim', pair(frontSideGlass(0.9755, 1.460)), 'glass');                                            // side glass beyond the A-pillar
        // rear
        d('rear', 'trim', poly([[-0.400, 0.912], [0.400, 0.912], [0.400, 0.950], [-0.400, 0.950]]), 'gloss-black'); // tailgate strip between lamps
        d('rear', 'trim', pair((function () {
          var s = []; for (var i = 0; i < 7; i++) s = s.concat(poly([[0.480 + 0.062 * i, 0.902], [0.492 + 0.062 * i, 0.902], [0.500 + 0.062 * i, 0.975], [0.488 + 0.062 * i, 0.975]]));
          return s;
        })()), 'light');                                                                        // segmented lamp graphic
        d('rear', 'trim', symHalf([[0, 0.560, [1, 0]], [0.900, 0.565, 'c'], [0.905, 0.545, 'c'], [0, 0.540, [-1, 0]]]), 'gloss-black'); // bumper blade
        d('rear', 'antenna', poly([[-0.030, 1.400], [0.030, 1.400], [0.012, 1.450], [-0.012, 1.450]]), 'black');
        return D;
      },
      signature: {
        headlights: 'Slim HD Matrix LED units with laser high beam; flat top edge, pointed inboard end above the grille corners, segmented DRL bars along the lower edge.',
        taillights: 'Wide flat horizontal units split across body and tailgate, joined by a gloss-black strip; vertical segmented light graphics, dynamic indicators.',
        grille: 'RS-specific wide, low hexagonal Singleframe with gloss-black 3D honeycomb and no chrome surround; huge corner intakes with air curtains.',
        notes: 'Only the roof, front doors and tailgate are shared with the A6 Avant: every other panel is new for the 80 mm wider body, with flared "quattro blister" arches over all four wheels. Large oval RS tailpipes in a gloss-black diffuser, roof spoiler above an upright tailgate, black roof rails.'
      }
    };
    return buildModel(c);
  }

  /* ================================================================== */
  /* 2. Mercedes-AMG E 63 S 4MATIC+ Estate (S213 facelift)               */
  /* ================================================================== */
  function e63() {
    var ref = {
      length: 4.995, width: 1.907, height: 1.465, wheelbase: 2.939, trackF: 1.605, trackR: 1.609,
      frontOverhang: 0.930, rearOverhang: 1.126, wheelDiameter_in: 20, tireF: '265/35R20', tireR: '295/30R20',
      groundClearance: 0.120, rideHeight: 0.120, cd: 0.32, curbWeight_kg: 2070,
      estimated: ['frontOverhang', 'rearOverhang']   // split not in a Mercedes spec sheet; length & wheelbase are
    };
    /* Landmarks below were laid out on a 0.875 / 1.181 overhang split; overhangMap
       stretches the nose and shortens the tail beyond the arch edges to the
       AMG Estate's ~0.93 / 1.13 m (long AMG front apron). */
    var a = 1.4695, xF = a + 0.875, xR = -(a + 1.181);   // layout frame: 2.3445 / -2.6505
    var eF = a + 0.376, eR = -(a + 0.371);
    var kF = (0.930 - 0.376) / (0.875 - 0.376), kR = (1.126 - 0.371) / (1.181 - 0.371);
    function ohMap(x) { return x > eF ? eF + (x - eF) * kF : x < eR ? eR + (x - eR) * kR : x; }
    function iv(x) { return x > eF ? eF + (x - eF) / kF : x < eR ? eR + (x - eR) / kR : x; }   // final -> layout frame
    var xRf = -(a + 1.126);                                                                   // final tail x
    var E63_GRILLE = (function () {   // Panamericana: narrow top (+-0.30 @ 0.70), wide bottom (+-0.39 @ 0.42), r 0.04 top corners
      var nz = 0.28 / Math.hypot(0.28, 0.09), ny = 0.09 / Math.hypot(0.28, 0.09), r = 0.040;
      var cx = 0.300 + (-r + ny * r) / nz, cy = 0.700 - r, an = Math.atan2(ny, nz);
      var s = [{ t: 'M', p: [pt(0, 0.420)] }, { t: 'L', p: [pt(0.390, 0.420)] }, { t: 'L', p: [pt(cx + r * nz, cy + r * ny)] }];
      s = s.concat(arcSegs(cx, cy, r, an, Math.PI / 2));
      s.push({ t: 'L', p: [pt(-cx, 0.700)] });
      s = s.concat(arcSegs(-cx, cy, r, Math.PI / 2, Math.PI - an));
      s.push({ t: 'L', p: [pt(-0.390, 0.420)] }, { t: 'Z', p: [] });
      return s;
    })();
    var E63_DROP = [[1.000, 0.705], [0.300, 0.668], [-0.500, 0.618], [-1.000, 0.585], [-1.180, 0.596]];
    function e63SideAt(z) {           // height at which the grille's slanted side reaches half-width z
      return Math.min(0.700, 0.700 - (z - 0.300) * 0.280 / 0.090);
    }
    var c = {
      id: 'mercedes-amg-e63s-estate-s213', make: 'Mercedes-AMG', name: 'E 63 S 4MATIC+ Estate', gen: 'S213', years: '2020–2023',
      look: { head: 'slim-led', tail: 'slim', grille: 'slats' },   // renderer lamp / grille signature
      drivetrain: 'awd', powertrain: 'ice', engine: 'M177 4.0 twin-turbo V8, 612 PS',
      ref: ref, sillY: 0.215, archGapF: 0.028, archGapR: 0.028, flareF: 0.030, flareR: 0.030, cowlX: 0.980, shoulderY: 0.945, tailBelt: 1.07,
      overhangMap: ohMap, color: '#4a4f55',            // Selenite Grey
      wheel: { caliper: '#c8102e' },
      profile: [
        [2.270, 0.150, 'c'],
        [2.330, 0.240],
        [xF, 0.530, [0, 1]],            // Panamericana grille leans forward: nose tip high
        [2.330, 0.670],
        [2.250, 0.760],
        [2.050, 0.800],
        [1.550, 0.870],
        [0.980, 0.975],                 // cowl
        [0.700, 1.123],
        [0.400, 1.272],
        [0.120, 1.408],
        [-0.450, 1.465, [-1, 0]],
        [-1.300, 1.452],
        [-2.100, 1.405],
        [-2.395, 1.360, 'c'],
        [-2.430, 1.330, 'c'],
        [-2.550, 1.080],                // more raked tailgate than the Audi
        [-2.612, 0.920],
        [xR, 0.700, [0, -1]],
        [-2.640, 0.420],
        [-2.580, 0.262, 'c'],
        [-2.490, 0.215, 'c']
      ],
      frontLower: [[1.950, 0.195], [2.270, 0.150]],
      dlo: {
        aBase: [0.860, 1.000], aBow: 0.020, inset: 0.016,
        top: [[0.140, 1.362], [-0.500, 1.406], [-1.300, 1.393], [-1.950, 1.352], [-2.180, 1.310], [-2.282, 1.238], [-2.300, 1.150]],
        belt: [[0.860, 1.000], [-0.500, 1.034], [-1.700, 1.076], [-2.100, 1.098], [-2.300, 1.150]],   // rounded quarter-glass end, thick D-pillar
        B: [[-0.200, -0.170], [-0.280, -0.250]],
        C: [[-1.250, -1.270], [-1.300, -1.320]]
      },
      doorCuts: [
        [[0.895, 0.990], [0.940, 0.720], [0.925, 0.450], [0.860, 0.295]],
        [[-0.210, 1.030], [-0.205, 0.640], [-0.200, 0.295]],
        [[-1.300, 1.068], [-1.314, 0.770], [-1.148, 0.664], [-1.042, 0.498], [-1.020, 0.300]],
        [[0.860, 0.295], [0.000, 0.292], [-1.020, 0.300]]
      ],
      panelLines: [
        [[2.200, 0.774], [1.600, 0.858], [1.000, 0.962]],
        [[-2.360, 1.352], [-2.520, 1.000], [-2.580, 0.700], [-2.642, 0.680]],
        rrect(-1.780, 0.880, -1.620, 0.990, 0.03),
        [[2.300, 0.580], [2.120, 0.520], [1.880, 0.470]]
      ],
      characterLines: [
        [[1.000, 0.936], [0.000, 0.940], [-1.300, 0.944], [-2.380, 0.950]],                  // soft belt crease
        E63_DROP,                                                                             // W213/S213 "dropping line": concave, slight upturn above the rear arch
        [[iv(1.950), 0.800], [1.550, 0.756], [1.200, 0.717]]                                  // straight AMG wing line running into the dropping line
      ],
      sill: poly([[1.100, 0.215], [-1.100, 0.215], [-1.090, 0.292], [1.090, 0.292]]),
      lowerTrim: join(
        poly([[1.100, 0.215], [-1.100, 0.215], [-1.095, 0.250], [1.095, 0.250]]),
        spl([[1.730, 0.200, 'c'], [2.270, 0.150, 'c'], [2.300, 0.190], [2.050, 0.225], [1.760, 0.250, 'c']], true),
        spl([[-2.490, 0.215, 'c'], [-1.840, 0.215, 'c'], [-1.880, 0.265], [-2.380, 0.290], [-2.580, 0.262, 'c']], true)
      ),
      top: {
        body: symHalf([
          [xF, 0, [0, 1]], [2.330, 0.420], [2.220, 0.740], [1.980, 0.905],
          [a, 0.9535, [-1, 0]], [0.700, 0.940], [0.000, 0.925], [-0.700, 0.938],
          [-a, 0.9535, [-1, 0]], [-2.100, 0.925], [-2.480, 0.830], [-2.612, 0.640], [-2.646, 0.400], [-2.6495, 0.200],
          [xR, 0, [0, -1]]], 1),
        greenhouse: symHalf([[0.960, 0, [0, 1]], [0.940, 0.500], [0.860, 0.800, 'c'], [0.000, 0.830], [-1.600, 0.810],
          [iv(-2.150), 0.775], [iv(-2.421), 0.700], [iv(-2.472), 0.450], [iv(-2.480), 0, [0, -1]]], 1),
        hood: symHalf([[2.250, 0, [0, 1]], [2.230, 0.400], [2.120, 0.660], [1.980, 0.760, 'c'], [0.990, 0.790, 'c'],
          [0.945, 0.600], [0.950, 0, [0, -1]]], 1),
        roof: symHalf([[0.130, 0, [0, 1]], [0.124, 0.420], [0.090, 0.585], [-0.070, 0.645], [-0.500, 0.660], [-2.100, 0.630], [-2.400, 0.550, 'c'], [-2.410, 0, 'c']], 1),
        deck: clampX(symHalf([[-2.410, 0, 'c'], [-2.410, 0.550, 'c'], [-2.560, 0.600], [-2.632, 0.450], [iv(xRf + 0.01), 0, [0, -1]]], 1), iv(xRf + 0.01)),
        mirrors: (function (mp) { return [mp, mirror(mp, 1)]; })(spl([[0.900, 0.875, 'c'], [0.720, 0.900, 'c'], [0.690, 1.020], [0.730, 1.055], [0.810, 1.050], [0.870, 0.980]], true))   // one path per side
      },
      front: {
        body: symHalf(crown(0.9535, 1.465, 0.04).concat([[0.9285, 0.260], [0.880, 0.172], [0.650, 0.148], [0, 0.145, [-1, 0]]])),
        greenhouse: symHalf([[0, 1.410, [1, 0]], [0.490, 1.405, [1, -0.06]], [0.530, 1.396, 'c'], [0.650, 1.025, 'c'], [0.530, 0.990], [0, 0.980, [-1, 0]]]),
        bumper: symHalf([[0, 0.600, [1, 0]], [0.700, 0.610], [0.920, 0.600, 'c'], [0.935, 0.420], [0.910, 0.300], [0.860, 0.175], [0.650, 0.148], [0, 0.145, [-1, 0]]]),
        grille: [E63_GRILLE],
        intakes: [
          pair(spl([[0.520, 0.530, 'c'], [0.860, 0.565, 'c'], [0.885, 0.420], [0.860, 0.270, 'c'], [0.760, 0.195, 'c'], [0.560, 0.205, 'c'], [0.500, 0.330]], true)),
          symHalf([[0, 0.255, 'c'], [0.380, 0.255, 'c'], [0.425, 0.220], [0.400, 0.182, 'c'], [0, 0.180, 'c']])     // centre lower intake (below the plate)
        ],
        // S213 facelift MULTIBEAM: almost flat top edge (0.765 inner -> 0.790 outer), inner bottom 0.66
        headlights: [{ path: pair(spl([[0.365, 0.685, 'c'], [0.395, 0.765, 'c'], [0.860, 0.790, 'c'], [0.905, 0.755], [0.865, 0.705, 'c'], [0.540, 0.680], [0.400, 0.660, 'c']], true)), paint: 'gloss-black', opacity: 0.55 }],
        drl: [
          pair(spl([[0.405, 0.752, 'c'], [0.412, 0.758, 'c'], [0.858, 0.781, 'c'], [0.890, 0.756, 'c'], [0.852, 0.771, 'c'], [0.418, 0.747, 'c']], true)),  // upper eyebrow torch (full length)
          pair(spl([[0.425, 0.731, 'c'], [0.855, 0.754, 'c'], [0.868, 0.744, 'c'], [0.432, 0.721, 'c']], true))                                             // second torch
        ],
        splitter: symHalf([[0, 0.172, 'c'], [0.760, 0.178, 'c'], [0.800, 0.160], [0.650, 0.148], [0, 0.145, 'c']]),
        plateArea: rrect(-0.260, 0.270, 0.260, 0.370, 0.01),
        badgeArea: rrect(-0.120, 0.712, 0.120, 0.748, 0.006),     // on the bonnet nose, above the grille
        badgeText: 'MERCEDES-BENZ'
      },
      rear: {
        body: symHalf(crown(0.9535, 1.465, 0.04).concat([[0.9285, 0.310], [0.890, 0.232], [0.700, 0.215], [0, 0.215, [-1, 0]]])),
        greenhouse: symHalf([[0, 1.310, [1, 0]], [0.470, 1.307, [1, -0.02]], [0.520, 1.294, 'c'], [0.620, 1.075, 'c'], [0.310, 1.056], [0, 1.050, [-1, 0]]]),
        bumper: symHalf([[0, 0.640, [1, 0]], [0.780, 0.645], [0.935, 0.625, 'c'], [0.945, 0.450], [0.920, 0.320], [0.880, 0.230], [0.700, 0.215], [0, 0.215, [-1, 0]]]),
        taillights: [shiftY(pair(spl([[0.330, 1.011, 'c'], [0.835, 1.033, [1, -0.12]], [0.895, 0.992, 'c'], [0.902, 0.921, 'c'], [0.600, 0.920], [0.360, 0.945, 'c']], true)), -0.030)],
        diffuser: symHalf([[0, 0.345, 'c'], [0.480, 0.345, 'c'], [0.520, 0.330], [0.880, 0.300, 'c'], [0.890, 0.225, 'c'], [0.700, 0.215], [0, 0.215, 'c']]),
        exhaust: [
          { shape: 'trapezoid', cx: -0.770, cy: 0.288, w: 0.130, h: 0.075 },
          { shape: 'trapezoid', cx: -0.610, cy: 0.288, w: 0.130, h: 0.075 },
          { shape: 'trapezoid', cx: 0.610, cy: 0.288, w: 0.130, h: 0.075 },
          { shape: 'trapezoid', cx: 0.770, cy: 0.288, w: 0.130, h: 0.075 }],
        plateArea: rrect(-0.260, 0.720, 0.260, 0.832, 0.01),
        badgeArea: rrect(0.380, 0.838, 0.560, 0.874, 0.006),
        badgeText: 'MERCEDES-BENZ',
        spoiler: symHalf([[0, 1.362, [1, 0]], [0.540, 1.358], [0.600, 1.328, 'c'], [0.560, 1.318], [0, 1.322, [-1, 0]]])
      },
      details: function (h) {
        var D = [];
        function d(view, role, path, paint) { D.push({ view: view, role: role, path: path, paint: paint }); }
        d('side', 'mirror', spl([[0.880, 0.995, 'c'], [0.710, 0.998, 'c'], [0.680, 1.060], [0.720, 1.108], [0.830, 1.108], [0.890, 1.055]], true), 'body');
        d('side', 'handle', rrect(-0.020, 0.898, 0.150, 0.920, 0.011), 'chrome');
        d('side', 'handle', rrect(-1.080, 0.918, -0.920, 0.940, 0.011), 'chrome');
        d('side', 'trim', strip(h.belt, 0.850, -2.290, 0.000, -0.010), 'chrome');            // chrome DLO belt finisher
        d('side', 'trim', strip(h.top, 0.120, -2.180, 0.008, -0.002), 'chrome');             // chrome DLO header surround
        d('side', 'trim', strip(h.roof, -0.100, -2.150, -0.003, -0.025), 'chrome');         // flush aluminium roof rail
        d('side', 'antenna', spl([[-1.880, 1.410, 'c'], [-1.990, 1.448], [-2.060, 1.405, 'c']], true), 'black');
        d('side', 'trim', rrect(1.120, 0.780, 1.330, 0.806, 0.004), 'chrome');               // "V8 BITURBO 4MATIC+" wing lettering
        d('side', 'trim', spl([[2.250, 0.760, 'c'], [2.080, 0.792], [1.930, 0.790, 'c'], [2.100, 0.745], [2.315, 0.700, 'c']], true), 'light');
        d('side', 'trim', clampToTail(spl([[-2.600, 0.965, 'c'], [-2.420, 1.000], [-2.300, 1.010, 'c'], [-2.380, 1.052], [-2.560, 1.058, 'c']], true), h.bodyPts, 0.015), 'light-red');
        // AMG A-wing corner intake: taller (0.24-0.52) and shorter (2.10-2.36) than the Audi's, two horizontal fins
        d('side', 'intake', spl([[iv(2.360), 0.250, 'c'], [iv(2.150), 0.240, 'c'], [iv(2.112), 0.300], [iv(2.115), 0.470], [iv(2.170), 0.520, 'c'], [iv(2.360), 0.520, 'c']], true), 'grille');
        [0.335, 0.425].forEach(function (y) { d('side', 'trim', poly([[iv(2.108), y], [iv(2.355), y + 0.004], [iv(2.355), y + 0.018], [iv(2.106), y + 0.014]]), 'chrome'); });
        d('top', 'trim', pair(poly([[0.000, 0.600], [-2.050, 0.590], [-2.050, 0.608], [0.000, 0.618]]), 1), 'gloss-black');   // flush roof rails
        D.push({ view: 'top', role: 'highlight', path: pair(spl([[2.100, 0.205, 'c'], [1.500, 0.198], [1.100, 0.200, 'c'], [1.100, 0.300, 'c'], [1.500, 0.302], [2.100, 0.295, 'c']], true), 1), paint: 'body', tone: 'light', opacity: 0.22 });   // AMG power domes (raised panels)
        D.push({ view: 'top', role: 'shadow', path: pair(spl([[2.100, 0.292, 'c'], [1.100, 0.297, 'c'], [1.100, 0.303, 'c'], [2.100, 0.300, 'c']], true), 1), paint: 'body', tone: 'dark', opacity: 0.2 });  // dome shade line
        D.push({ view: 'side', role: 'shadow', path: strip(curveFn(E63_DROP), -1.150, 0.980, 0.004, -0.030), paint: 'body', tone: 'dark', opacity: 0.16 });  // shade under the dropping line
        d('top', 'antenna', spl([[-1.880, 0, 'c'], [-2.060, 0.035], [-2.060, -0.035]], true), 'black');
        d('front', 'mirror', pair(spl([[0.870, 0.995, 'c'], [1.040, 1.005], [1.048, 1.088], [0.930, 1.108, 'c'], [0.870, 1.075, 'c']], true)), 'body');
        d('front', 'wiper', pair(poly([[0.050, 0.995], [0.580, 1.015], [0.580, 1.025], [0.050, 1.005]])), 'black');
        d('front', 'trim', pair(frontSideGlass(0.9535, 1.465)), 'glass');
        d('front', 'grille', (function () {        // AMG Panamericana: 15 chrome slats, 0.012 wide on a 0.044 pitch
          var s = []; for (var i = -7; i <= 7; i++) {
            var zc = i * 0.044, hw = 0.006, yt = Math.min(0.684, e63SideAt(Math.abs(zc) + hw) - 0.016);
            if (Math.abs(zc) < 0.08) {   // centre slats stop short of the large badge roundel
              s = s.concat(poly([[zc - hw, 0.436], [zc + hw, 0.436], [zc + hw, 0.480], [zc - hw, 0.480]]),
                poly([[zc - hw, 0.640], [zc + hw, 0.640], [zc + hw, yt], [zc - hw, yt]]));
            } else s = s.concat(poly([[zc - hw, 0.436], [zc + hw, 0.436], [zc + hw, yt], [zc - hw, yt]]));
          } return s;
        })(), 'chrome');
        d('front', 'badge', ellipse(0, 0.560, 0.075, 0.075), 'chrome');   // large roundel ring (badge position, no logo artwork)
        d('front', 'badge', ellipse(0, 0.560, 0.064, 0.064), 'grille');
        d('front', 'trim', pair(poly([[0.540, 0.440], [0.880, 0.468], [0.880, 0.480], [0.535, 0.452]])), 'chrome');  // intake fins
        d('front', 'trim', pair(poly([[0.530, 0.340], [0.875, 0.360], [0.873, 0.372], [0.525, 0.352]])), 'chrome');
        d('rear', 'trim', poly([[-0.360, 0.885], [0.360, 0.885], [0.360, 0.900], [-0.360, 0.900]]), 'chrome');     // tailgate chrome strip joining the lamps' lower inner corners
        d('rear', 'trim', shiftY(pair(spl([[0.380, 0.991, 'c'], [0.835, 1.012, 'c'], [0.872, 0.990, 'c'], [0.835, 0.999], [0.390, 0.979, 'c']], true)), -0.030), 'light');
        d('rear', 'trim', shiftY(pair(spl([[0.420, 0.957, 'c'], [0.880, 0.950, 'c'], [0.890, 0.937, 'c'], [0.430, 0.945, 'c']], true)), -0.030), 'light');
        d('rear', 'trim', (function () {           // diffuser fins
          var s = []; [-0.36, -0.18, 0, 0.18, 0.36].forEach(function (zc) { s = s.concat(poly([[zc - 0.008, 0.215], [zc + 0.008, 0.215], [zc + 0.008, 0.345], [zc - 0.008, 0.345]])); });
          return s;
        })(), 'carbon');
        d('rear', 'trim', symHalf([[0, 0.420, [1, 0]], [0.880, 0.428, 'c'], [0.890, 0.410, 'c'], [0, 0.402, [-1, 0]]]), 'chrome');
        return D;
      },
      signature: {
        headlights: 'MULTIBEAM LED units, flatter and more wedge-shaped after the 2020 facelift; double "torch" eyebrow DRL running along the top edge and kinking down at the outer corner.',
        taillights: 'Slim horizontal two-piece lamps split by the tailgate shut line with layered horizontal 3D light bars; chrome strip above the number plate.',
        grille: 'AMG-specific Panamericana grille: forward-leaning trapezoid with 15 vertical chrome slats and central star badge position; AMG "A-wing" front apron with big outer intakes and horizontal fins.',
        notes: 'Long raked roof with rounded D-pillars, chrome DLO surround, flush aluminium roof rails, flared AMG front wings with "V8 BITURBO 4MATIC+" lettering, quad trapezoidal tailpipes in a finned diffuser; 265 front / 295 rear staggered 20-inch tyres.'
      }
    };
    return buildModel(c);
  }

  /* ================================================================== */
  /* 3. Volvo V60 T8 Polestar Engineered                                 */
  /* ================================================================== */
  function v60() {
    var ref = {
      length: 4.761, width: 1.850, height: 1.432, wheelbase: 2.872, trackF: 1.600, trackR: 1.600,
      frontOverhang: 0.870, rearOverhang: 1.019, wheelDiameter_in: 19, tireF: '235/40R19', tireR: '235/40R19',
      groundClearance: 0.136, rideHeight: 0.136, cd: 0.29, curbWeight_kg: 2078
    };
    var a = 1.436, xF = a + 0.870, xR = -(a + 1.019);   // 2.306 / -2.455
    var c = {
      id: 'volvo-v60-polestar-engineered', make: 'Volvo', name: 'V60 T8 Polestar Engineered', gen: 'SPA (2nd gen V60)', years: '2019–',
      look: { head: 'blade', tail: 'vertical', grille: 'slats' },   // renderer lamp / grille signature
      drivetrain: 'awd', powertrain: 'hybrid', engine: '2.0 turbo + supercharged I4 with rear e-motor (plug-in hybrid), 405–455 hp',
      ref: ref, sillY: 0.205, archGapF: 0.028, archGapR: 0.028, flareF: 0.015, flareR: 0.020, cowlX: 0.880, shoulderY: 0.950, tailBelt: 1.05,
      color: '#d9dbd8',                 // Crystal White
      wheel: { caliper: '#c9a227', caliperNote: 'gold Brembo (Polestar Engineered)' },
      profile: [
        [2.240, 0.150, 'c'],
        [2.292, 0.250],
        [xF, 0.540, [0, 1]],
        [2.290, 0.705],
        [2.268, 0.790],
        [2.200, 0.830],                 // bonnet leading edge: high, upright Volvo face (no corner vent)
        [1.950, 0.860],
        [1.500, 0.898],
        [0.880, 0.965],                 // cowl set well back: long dash-to-axle
        [0.600, 1.112],
        [0.320, 1.257],
        [0.060, 1.378],
        [-0.450, 1.432, [-1, 0]],
        [-1.200, 1.424],
        [-1.950, 1.405],                // long flat roof
        [-2.215, 1.380, 'c'],
        [-2.245, 1.345, 'c'],
        [-2.340, 1.060],
        [-2.412, 0.920],
        [xR, 0.700, [0, -1]],
        [-2.445, 0.420],
        [-2.400, 0.262, 'c'],
        [-2.320, 0.205, 'c']
      ],
      frontLower: [[1.900, 0.190], [2.240, 0.150]],
      dlo: {
        aBase: [0.800, 1.000], aBow: 0.016, inset: 0.014,
        top: [[0.080, 1.335], [-0.500, 1.372], [-1.300, 1.362], [-1.900, 1.330], [-2.120, 1.300, 'c'], [-2.170, 1.125]],
        belt: [[0.800, 1.000], [-0.500, 1.020], [-1.550, 1.040], [-1.720, 1.055], [-1.860, 1.118], [-2.170, 1.125]],  // short hockey-stick kick, squared rear corner
        B: [[-0.255, -0.225], [-0.335, -0.305]],
        C: [[-1.285, -1.280], [-1.365, -1.360]]
      },
      doorCuts: [
        [[0.830, 0.990], [0.870, 0.720], [0.850, 0.450], [0.800, 0.300]],
        [[-0.265, 1.020], [-0.258, 0.640], [-0.250, 0.300]],
        [[-1.330, 1.045], [-1.300, 0.754], [-1.125, 0.646], [-1.023, 0.486], [-1.000, 0.300]],
        [[0.800, 0.300], [0.000, 0.296], [-1.000, 0.300]]
      ],
      panelLines: [
        [[2.185, 0.818], [1.500, 0.884], [0.900, 0.952]],
        [[-2.200, 1.322], [-2.330, 1.020], [-2.388, 0.840], [-2.412, 0.660], [-2.452, 0.645]],
        rrect(-1.720, 0.880, -1.570, 0.990, 0.02),
        [[2.280, 0.600], [2.100, 0.555], [1.840, 0.470]]
      ],
      characterLines: [
        [[2.100, 0.800], [1.000, 0.878], [-0.800, 0.908], [-1.600, 0.938], [-2.300, 0.960]],  // rising shoulder line
        [[0.760, 0.460], [-0.200, 0.468], [-1.000, 0.478]]                                    // lower door concave
      ],
      sill: poly([[1.075, 0.205], [-1.075, 0.205], [-1.065, 0.296], [1.065, 0.296]]),
      lowerTrim: join(
        poly([[1.075, 0.205], [-1.075, 0.205], [-1.070, 0.250], [1.070, 0.250]]),
        spl([[1.800, 0.195, 'c'], [2.240, 0.150, 'c'], [2.265, 0.190], [2.000, 0.222], [1.820, 0.240, 'c']], true),
        spl([[-2.320, 0.205, 'c'], [-1.800, 0.205, 'c'], [-1.840, 0.250], [-2.250, 0.270], [-2.400, 0.262, 'c']], true)
      ),
      top: {
        body: symHalf([
          [xF, 0, [0, 1]], [2.290, 0.400], [2.200, 0.720], [1.950, 0.880],
          [a, 0.925, [-1, 0]], [0.700, 0.912], [0.000, 0.900], [-0.700, 0.910],
          [-a, 0.925, [-1, 0]], [-2.000, 0.905], [-2.300, 0.820], [-2.425, 0.650], [-2.451, 0.420], [-2.4545, 0.200],
          [xR, 0, [0, -1]]], 1),
        greenhouse: symHalf([[0.860, 0, [0, 1]], [0.840, 0.500], [0.780, 0.780, 'c'], [0.000, 0.810], [-1.600, 0.790],
          [-2.000, 0.765], [-2.260, 0.700], [-2.342, 0.450], [-2.350, 0, [0, -1]]], 1),
        hood: symHalf([[2.240, 0, [0, 1]], [2.220, 0.400], [2.120, 0.660], [1.980, 0.740, 'c'], [0.890, 0.780, 'c'],
          [0.845, 0.600], [0.850, 0, [0, -1]]], 1),
        roof: symHalf([[0.070, 0, [0, 1]], [0.064, 0.400], [0.030, 0.565], [-0.120, 0.625], [-0.500, 0.640], [-1.950, 0.620], [-2.200, 0.550, 'c'], [-2.210, 0, 'c']], 1),
        deck: clampX(symHalf([[-2.210, 0, 'c'], [-2.210, 0.550, 'c'], [-2.370, 0.600], [-2.438, 0.450], [xR + 0.01, 0, [0, -1]]], 1), xR + 0.01),
        mirrors: (function (mp) { return [mp, mirror(mp, 1)]; })(spl([[0.830, 0.855, 'c'], [0.660, 0.875, 'c'], [0.630, 0.995], [0.670, 1.030], [0.750, 1.025], [0.805, 0.955]], true))   // one path per side
      },
      front: {
        body: symHalf(crown(0.925, 1.432, 0.025).concat([[0.900, 0.260], [0.850, 0.172], [0.620, 0.152], [0, 0.150, [-1, 0]]])),
        greenhouse: symHalf([[0, 1.378, [1, 0]], [0.470, 1.373, [1, -0.06]], [0.510, 1.364, 'c'], [0.630, 1.020, 'c'], [0.510, 0.985], [0, 0.975, [-1, 0]]]),
        bumper: symHalf([[0, 0.620, [1, 0]], [0.700, 0.630], [0.895, 0.610, 'c'], [0.905, 0.420], [0.880, 0.300], [0.830, 0.175], [0.620, 0.152], [0, 0.150, [-1, 0]]]),
        grille: [symHalf([[0, 0.760, [1, 0]], [0.300, 0.758, [1, -0.02]], [0.328, 0.738, 'c'], [0.332, 0.494, 'c'], [0.308, 0.470], [0, 0.468, [-1, 0]]])],
        intakes: [
          pair(spl([[0.580, 0.460, 'c'], [0.845, 0.482, 'c'], [0.848, 0.300, 'c'], [0.610, 0.250, 'c'], [0.555, 0.300, 'c']], true)),
          symHalf([[0, 0.300, 'c'], [0.400, 0.298, 'c'], [0.440, 0.250], [0.410, 0.195, 'c'], [0, 0.192, 'c']])
        ],
        // dark smoked lens so the white Thor's hammer reads
        headlights: [{ path: pair(spl([[0.370, 0.690, 'c'], [0.390, 0.758, 'c'], [0.800, 0.796, 'c'], [0.872, 0.768], [0.862, 0.690, 'c'], [0.700, 0.658], [0.410, 0.664, 'c']], true)), paint: 'gloss-black', opacity: 0.6 }],
        drl: [{ path: pair(thorHammer()), paint: 'light' }],
        splitter: symHalf([[0, 0.175, 'c'], [0.740, 0.180, 'c'], [0.780, 0.163], [0.620, 0.152], [0, 0.150, 'c']]),
        plateArea: rrect(-0.260, 0.320, 0.260, 0.420, 0.01),
        badgeArea: rrect(-0.070, 0.560, 0.070, 0.660, 0.05),
        badgeText: 'VOLVO'
      },
      rear: {
        body: symHalf(crown(0.925, 1.432, 0.025).concat([[0.900, 0.310], [0.862, 0.222], [0.680, 0.205], [0, 0.205, [-1, 0]]])),
        greenhouse: symHalf([[0, 1.300, [1, 0]], [0.470, 1.297, [1, -0.02]], [0.520, 1.284, 'c'], [0.620, 1.045, 'c'], [0.310, 1.034], [0, 1.030, [-1, 0]]]),
        bumper: symHalf([[0, 0.640, [1, 0]], [0.760, 0.645], [0.905, 0.625, 'c'], [0.915, 0.450], [0.890, 0.320], [0.850, 0.220], [0.680, 0.205], [0, 0.205, [-1, 0]]]),
        taillights: [pair(spl([
          [0.520, 0.835, 'c'], [0.880, 0.835], [0.912, 0.880], [0.875, 0.960], [0.790, 1.060], [0.672, 1.255, 'c'],
          [0.605, 1.245, 'c'], [0.715, 1.050], [0.770, 0.975], [0.785, 0.935], [0.750, 0.905, 'c'], [0.530, 0.902, 'c']], true))],
        diffuser: symHalf([[0, 0.380, 'c'], [0.500, 0.380, 'c'], [0.560, 0.360], [0.850, 0.330, 'c'], [0.860, 0.215, 'c'], [0.680, 0.205], [0, 0.205, 'c']]),
        exhaust: [
          { shape: 'hidden', cx: -0.600, cy: 0.300, w: 0.240, h: 0.060 },
          { shape: 'hidden', cx: 0.600, cy: 0.300, w: 0.240, h: 0.060 }],
        plateArea: rrect(-0.260, 0.665, 0.260, 0.778, 0.01),
        badgeArea: rrect(-0.160, 0.875, 0.160, 0.905, 0.006),
        badgeText: 'V O L V O',                                   // spaced wordmark (text only)
        spoiler: symHalf([[0, 1.356, [1, 0]], [0.520, 1.352], [0.580, 1.324, 'c'], [0.540, 1.312], [0, 1.316, [-1, 0]]])
      },
      details: function (h) {
        var D = [];
        function d(view, role, path, paint) { D.push({ view: view, role: role, path: path, paint: paint }); }
        d('side', 'mirror', spl([[0.820, 0.995, 'c'], [0.650, 0.998, 'c'], [0.622, 1.055], [0.660, 1.100], [0.770, 1.100], [0.830, 1.050]], true), 'gloss-black');
        d('side', 'handle', rrect(-0.070, 0.896, 0.085, 0.918, 0.011), 'body');
        d('side', 'handle', rrect(-1.110, 0.912, -0.960, 0.934, 0.011), 'body');
        d('side', 'trim', strip(h.belt, 0.790, -2.150, 0.000, -0.010), 'gloss-black');       // black-chrome DLO finisher (PE)
        d('side', 'trim', strip(h.roof, -0.100, -2.100, -0.002, -0.026), 'black');           // black roof rails (PE)
        d('side', 'antenna', spl([[-1.760, 1.396, 'c'], [-1.860, 1.428], [-1.930, 1.392, 'c']], true), 'black');
        d('side', 'trim', spl([[2.215, 0.814, 'c'], [2.080, 0.836], [1.960, 0.838, 'c'], [2.090, 0.790], [2.282, 0.740, 'c']], true), 'light');
        d('side', 'trim', clampToTail(spl([[-2.410, 0.862, 'c'], [-2.340, 0.878], [-2.300, 1.000], [-2.268, 1.230, 'c'], [-2.290, 1.236, 'c'], [-2.345, 1.060], [-2.412, 0.930, 'c']], true), h.bodyPts, 0.012), 'light-red'); // vertical lamp wrap
        d('top', 'chargePort', rrect(1.560, -0.875, 1.680, -0.845, 0.01), 'black');            // PHEV charge flap, left front wing
        d('top', 'antenna', spl([[-1.760, 0, 'c'], [-1.930, 0.035], [-1.930, -0.035]], true), 'black');
        d('top', 'trim', pair(spl([[2.150, 0.300, 'c'], [1.200, 0.330], [0.920, 0.340, 'c'], [0.920, 0.360, 'c'], [1.200, 0.352], [2.150, 0.322, 'c']], true), 1), 'body'); // bonnet creases
        d('front', 'mirror', pair(spl([[0.800, 0.995, 'c'], [0.990, 1.005], [0.998, 1.085], [0.870, 1.105, 'c'], [0.800, 1.075, 'c']], true)), 'gloss-black');
        d('front', 'wiper', pair(poly([[0.050, 0.990], [0.560, 1.008], [0.560, 1.018], [0.050, 1.000]])), 'black');
        d('front', 'trim', pair(frontSideGlass(0.925, 1.432)), 'glass');
        d('front', 'trim', frame(                                                                // thick black-chrome grille frame
          [[0, 0.780, [1, 0]], [0.315, 0.778, [1, -0.02]], [0.350, 0.752, 'c'], [0.354, 0.484, 'c'], [0.322, 0.450], [0, 0.448, [-1, 0]]],
          [[0, 0.760, [1, 0]], [0.300, 0.758, [1, -0.02]], [0.328, 0.738, 'c'], [0.332, 0.494, 'c'], [0.308, 0.470], [0, 0.468, [-1, 0]]]), 'chrome');
        d('front', 'trim', frame(                                                                // concave depth: gloss-black shadow band inside the frame
          [[0, 0.760, [1, 0]], [0.300, 0.758, [1, -0.02]], [0.328, 0.738, 'c'], [0.332, 0.494, 'c'], [0.308, 0.470], [0, 0.468, [-1, 0]]],
          [[0, 0.720, [1, 0]], [0.268, 0.718, [1, -0.02]], [0.288, 0.704, 'c'], [0.292, 0.520, 'c'], [0.272, 0.508], [0, 0.508, [-1, 0]]]), 'gloss-black');
        d('front', 'grille', (function () {        // concave grille vertical slats, 0.010 wide on a 0.030 pitch
          var s = []; for (var i = -10; i <= 10; i++) {
            var zc = i * 0.030, hw = 0.005;
            s = s.concat(poly([[zc - hw, 0.480], [zc + hw, 0.480], [zc + hw, 0.750], [zc - hw, 0.750]]));
          } return s;
        })(), 'gloss-black');                                                                   // black-chrome PE slats
        d('front', 'trim', pair(thorHammer()), 'light');                                        // Thor's hammer DRL over the lens
        d('front', 'trim', pair(poly([[0.585, 0.385], [0.845, 0.395], [0.845, 0.408], [0.580, 0.398]])), 'chrome'); // intake bar
        d('rear', 'trim', pair(spl([[0.545, 0.855, 'c'], [0.860, 0.855], [0.885, 0.882], [0.852, 0.952], [0.762, 1.055], [0.652, 1.235, 'c'],
          [0.636, 1.230, 'c'], [0.740, 1.050], [0.834, 0.950], [0.862, 0.885], [0.845, 0.868, 'c'], [0.545, 0.868, 'c']], true)), 'light'); // C-shaped light guide
        d('rear', 'trim', pair(spl([[0.470, 0.272, 'c'], [0.730, 0.272, 'c'], [0.715, 0.330, 'c'], [0.485, 0.330, 'c']], true)), 'chrome'); // integrated faux outlets
        d('rear', 'trim', symHalf([[0, 0.640, [1, 0]], [0.700, 0.644, 'c'], [0.700, 0.632, 'c'], [0, 0.628, [-1, 0]]]), 'chrome');
        return D;
      },
      signature: {
        headlights: 'Full-LED units with the "Thor\'s hammer" T-shaped DRL: a horizontal bar pointing inboard with a vertical crossbar at the outer end.',
        calipers: 'Gold Brembo calipers (Polestar Engineered) - see model.wheel.caliper',
        taillights: 'Tall C-shaped lamps hugging the tailgate edges and climbing the D-pillars, with a short horizontal leg reaching into the tailgate.',
        grille: 'Concave Volvo grille with fine vertical slats (Polestar Engineered: black-chrome) and central badge position; slim outer intakes with a horizontal bar.',
        notes: 'Long bonnet with the cowl set far back (long dash-to-axle), upright face, "hockey-stick" kink where the beltline rises into the rear quarter window, near-vertical tailgate, exhausts hidden behind integrated faux outlets. Polestar Engineered: gold Brembo calipers and gold seat belts, Öhlins dampers, 19-inch forged wheels, black-chrome trim.'
      }
    };
    return buildModel(c);
  }

  /* ------------------------------------------------------------------ */
  var models = [rs6(), e63(), v60()];
  models.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = models;
})();

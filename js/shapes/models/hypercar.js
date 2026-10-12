/* FORGE Atelier — CB.shapes models for body style 'hypercar'.
   Ferrari SF90 Stradale, McLaren P1, Bugatti Chiron, drawn at their real published dimensions.
   Units are meters. Car-local axes: x forward (front bumper at +x), y up (ground = 0), z right. Origin is the
   midpoint between the axles on the ground centreline. Side view uses (x,y), top (x,z), front/rear (z,y).
   Body surfaces are smooth cubic Béziers built from a non-uniform Catmull-Rom spline through hand-placed key
   points (a 3rd element of 1 on a point marks a crease/corner). Front, rear and top outlines are authored as
   one half and mirrored, so they are exactly symmetric about z = 0.
   Brand names are text only. badgeArea marks where a text badge goes; no logo artwork is drawn.
   Classic script, zero deps, no DOM. Registers through CB.shapes.registerModel, or through CB.shapes._pending
   when core.js is not loaded yet. */
var CB = (globalThis.CB = globalThis.CB || {});
(function () {
  'use strict';
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ path helpers */
  function rd(v) { return Math.round(v * 1e5) / 1e5; }
  function pt(a, b) { return [rd(a), rd(b)]; }
  function tireRadius(w, ar, rim) { return (rim * 25.4 + 2 * w * ar / 100) / 2000; }

  /** Tangent-continuous cubic segments through pts (non-uniform Catmull-Rom). pts[i][2] truthy = corner. */
  function splineSegs(pts, closed) {
    var n = pts.length, segs = [];
    function idx(i) { return closed ? (i + n) % n : i; }
    function dist(i, j) { return Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) || 1e-9; }
    function chord(i, j) { var L = dist(i, j); return [(pts[j][0] - pts[i][0]) / L, (pts[j][1] - pts[i][1]) / L]; }
    function isBreak(i) { return !!pts[i][2] || (!closed && (i === 0 || i === n - 1)); }
    function smoothTan(i) {
      var a = idx(i - 1), b = idx(i + 1), s = dist(a, i) + dist(i, b);
      return [(pts[b][0] - pts[a][0]) / s, (pts[b][1] - pts[a][1]) / s];
    }
    function tanOut(i) {
      if (!isBreak(i)) return smoothTan(i);
      var j = idx(i + 1), c = chord(i, j);
      if (isBreak(j)) return c;
      var m = smoothTan(j); return [1.5 * c[0] - 0.5 * m[0], 1.5 * c[1] - 0.5 * m[1]];
    }
    function tanIn(i) {
      if (!isBreak(i)) return smoothTan(i);
      var j = idx(i - 1), c = chord(j, i);
      if (isBreak(j)) return c;
      var m = smoothTan(j); return [1.5 * c[0] - 0.5 * m[0], 1.5 * c[1] - 0.5 * m[1]];
    }
    var last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var j = idx(i + 1), L = dist(i, j), mo = tanOut(i), mi = tanIn(j);
      segs.push({ t: 'C', p: [
        pt(pts[i][0] + mo[0] * L / 3, pts[i][1] + mo[1] * L / 3),
        pt(pts[j][0] - mi[0] * L / 3, pts[j][1] - mi[1] * L / 3),
        pt(pts[j][0], pts[j][1])] });
    }
    return segs;
  }

  /** Fluent path builder: Pth(x,y).S([...]).L(x,y).arch(...).Z() */
  function Pth(x, y) {
    var segs = [{ t: 'M', p: [pt(x, y)] }], cur = [x, y];
    var api = {
      L: function (a, b) { segs.push({ t: 'L', p: [pt(a, b)] }); cur = [a, b]; return api; },
      /** smooth spline from the current point through pts (current point and last point are corners) */
      S: function (pts) {
        var all = [[cur[0], cur[1], 1]].concat(pts);
        splineSegs(all, false).forEach(function (s) { segs.push(s); });
        var e = pts[pts.length - 1]; cur = [e[0], e[1]]; return api;
      },
      /** circular arc around (cx,cy) from angle a0 to a1 (radians, sign gives direction) */
      A: function (cx, cy, r, a0, a1) {
        var sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
        if (Math.hypot(sx - cur[0], sy - cur[1]) > 1e-6) api.L(sx, sy);
        var n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2))), d = (a1 - a0) / n, k = 4 / 3 * Math.tan(d / 4);
        for (var i = 0; i < n; i++) {
          var t0 = a0 + d * i, t1 = t0 + d;
          var x0 = cx + r * Math.cos(t0), y0 = cy + r * Math.sin(t0), x1 = cx + r * Math.cos(t1), y1 = cy + r * Math.sin(t1);
          segs.push({ t: 'C', p: [pt(x0 - k * r * Math.sin(t0), y0 + k * r * Math.cos(t0)),
            pt(x1 + k * r * Math.sin(t1), y1 - k * r * Math.cos(t1)), pt(x1, y1)] });
          cur = [x1, y1];
        }
        return api;
      },
      /** side-view wheel-arch cut, travelling +x over the top of the wheel: from the circle at height y0
          (rear side of the arch) to the circle at height y1 (front side). */
      arch: function (cx, cy, r, y0, y1) {
        return api.A(cx, cy, r, Math.PI - Math.asin((y0 - cy) / r), Math.asin((y1 - cy) / r));
      },
      Z: function () { segs.push({ t: 'Z', p: [] }); return segs; },
      done: function () { return segs; }
    };
    return api;
  }
  /** open smooth curve through pts */
  function curve(pts) { return Pth(pts[0][0], pts[0][1]).S(pts.slice(1)).done(); }
  /** closed smooth loop through pts */
  function loop(pts) {
    return [{ t: 'M', p: [pt(pts[0][0], pts[0][1])] }].concat(splineSegs(pts, true), [{ t: 'Z', p: [] }]);
  }
  /** closed polygon */
  function poly(pts) {
    return [{ t: 'M', p: [pt(pts[0][0], pts[0][1])] }].concat(pts.slice(1).map(function (q) { return { t: 'L', p: [pt(q[0], q[1])] }; }), [{ t: 'Z', p: [] }]);
  }
  function flip(q, axis) { var o = q.slice(); o[axis] = -o[axis]; return o; }
  /** symmetric closed loop from one half. axis 0: front/rear views (negate z = first coord), half runs from the
      top centre point down the +z side to the bottom centre point. axis 1: top view (negate z = second coord),
      half runs from the nose centre point along +z to the tail centre point. */
  function sym(half, axis) {
    var back = half.slice(1, -1).reverse().map(function (q) { return flip(q, axis); });
    return loop(half.concat(back));
  }
  /** mirror image of a path across z = 0 */
  function mirror(path, axis) {
    return path.map(function (s) { return { t: s.t, p: s.p.map(function (q) { var o = q.slice(); o[axis] = rd(-o[axis] || 0); return o; }) }; });
  }
  /** same outline traversed backwards (used for holes in rings) */
  function reversePath(path) {
    var pts = [], out = [], closed = path[path.length - 1].t === 'Z', i;
    var cur = null;
    path.forEach(function (sg) { if (sg.t !== 'Z') { pts.push({ t: sg.t, from: cur, p: sg.p }); cur = sg.p[sg.p.length - 1]; } });
    out.push({ t: 'M', p: [cur] });
    for (i = pts.length - 1; i > 0; i--) {
      var sg = pts[i];
      if (sg.t === 'C') out.push({ t: 'C', p: [sg.p[1], sg.p[0], sg.from] });
      else if (sg.t === 'Q') out.push({ t: 'Q', p: [sg.p[0], sg.from] });
      else out.push({ t: 'L', p: [sg.from] });
    }
    if (closed) out.push({ t: 'Z', p: [] });
    return out;
  }
  /** band between an outer and an inner closed outline (inner becomes a hole under nonzero and evenodd fill) */
  function ring(outer, inner) { return outer.concat(reversePath(inner)); }
  function pair(path, axis) { return [path, mirror(path, axis)]; }
  function ellipse(cx, cy, rx, ry) {
    var k = 0.5522847;
    return [{ t: 'M', p: [pt(cx + rx, cy)] },
      { t: 'C', p: [pt(cx + rx, cy + k * ry), pt(cx + k * rx, cy + ry), pt(cx, cy + ry)] },
      { t: 'C', p: [pt(cx - k * rx, cy + ry), pt(cx - rx, cy + k * ry), pt(cx - rx, cy)] },
      { t: 'C', p: [pt(cx - rx, cy - k * ry), pt(cx - k * rx, cy - ry), pt(cx, cy - ry)] },
      { t: 'C', p: [pt(cx + k * rx, cy - ry), pt(cx + rx, cy - k * ry), pt(cx + rx, cy)] },
      { t: 'Z', p: [] }];
  }
  function rect(cx, cy, w, h) { return poly([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]); }
  function det(view, role, paint, path) { return { view: view, role: role, paint: paint, path: path }; }
  /** helper for symmetric pairs of details in front/rear (axis 0) or top (axis 1) views */
  function detPair(view, role, paint, path) {
    var ax = view === 'top' ? 1 : 0;
    return [det(view, role, paint, path), det(view, role, paint, mirror(path, ax))];
  }
  /** row of vertical slats inside a front/rear opening (lines), mirrored */
  function slats(view, z0, z1, n, yTop, yBot, paint) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var z = z0 + (z1 - z0) * (n === 1 ? 0.5 : i / (n - 1));
      var p = poly([[z - 0.004, yBot], [z + 0.004, yBot], [z + 0.004, yTop], [z - 0.004, yTop]]);
      out.push(det(view, 'trim', paint, p), det(view, 'trim', paint, mirror(p, 0)));
    }
    return out;
  }
  function register(model) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(model);
    else (CB.shapes._pending = CB.shapes._pending || []).push(model);
  }

  /** rounded rectangle centred on (cx,cy) */
  function rrect(cx, cy, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, k = 0.5522847 * r;
    return [{ t: 'M', p: [pt(x0 + r, y0)] },
      { t: 'L', p: [pt(x1 - r, y0)] }, { t: 'C', p: [pt(x1 - r + k, y0), pt(x1, y0 + r - k), pt(x1, y0 + r)] },
      { t: 'L', p: [pt(x1, y1 - r)] }, { t: 'C', p: [pt(x1, y1 - r + k), pt(x1 - r + k, y1), pt(x1 - r, y1)] },
      { t: 'L', p: [pt(x0 + r, y1)] }, { t: 'C', p: [pt(x0 + r - k, y1), pt(x0, y1 - r + k), pt(x0, y1 - r)] },
      { t: 'L', p: [pt(x0, y0 + r)] }, { t: 'C', p: [pt(x0, y0 + r - k), pt(x0 + r - k, y0), pt(x0 + r, y0)] },
      { t: 'Z', p: [] }];
  }
  /** thin closed band along an open polyline of key points (offset d along the local normal, +b side) — for shut
      lines / creases that have to render as filled shapes */
  function band(pts, d) {
    var top = pts.map(function (q) { return q.slice(0, 2); }), bot = [];
    for (var i = pts.length - 1; i >= 0; i--) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      var tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty) || 1;
      bot.push([pts[i][0] + ty / L * d, pts[i][1] - tx / L * d]);
    }
    top[0][2] = 1; top[top.length - 1][2] = 1; bot[0][2] = 1; bot[bot.length - 1][2] = 1;
    return loop(top.concat(bot));
  }

  /* ------------------------------------------------------------------ explicit 3D sections */
  /** flatten a path into polylines */
  function flat(path, n) {
    n = n || 12;
    var polys = [], cur = null, start = null, poly = null;
    path.forEach(function (s) {
      if (s.t === 'M') { cur = s.p[0]; start = cur; poly = [cur]; polys.push(poly); }
      else if (s.t === 'L') { cur = s.p[0]; poly.push(cur); }
      else if (s.t === 'C' || s.t === 'Q') {
        var c = [cur].concat(s.p);
        for (var i = 1; i <= n; i++) {
          var t = i / n, u = 1 - t;
          poly.push(s.t === 'C'
            ? [u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
               u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]]
            : [u * u * c[0][0] + 2 * u * t * c[1][0] + t * t * c[2][0], u * u * c[0][1] + 2 * u * t * c[1][1] + t * t * c[2][1]]);
        }
        cur = s.p[s.p.length - 1];
      } else if (s.t === 'Z') cur = start;
    });
    return polys;
  }
  /** [min, max] of the second coordinate where the outline crosses first coordinate = x */
  function sliceX(polys, x) {
    var lo = Infinity, hi = -Infinity;
    polys.forEach(function (p) {
      for (var i = 0; i < p.length; i++) {
        var a = p[i], b = p[(i + 1) % p.length];
        if (a[0] === b[0] || (a[0] - x) * (b[0] - x) > 0) continue;
        var y = a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
    });
    return lo <= hi ? [lo, hi] : null;
  }
  /** monotone-clamped Hermite (Catmull-Rom tangents) interpolation of column k of keys sorted by x */
  function keyAt(keys, x, k) {
    var n = keys.length;
    if (x <= keys[0][0]) return keys[0][k];
    if (x >= keys[n - 1][0]) return keys[n - 1][k];
    var i = 0; while (i < n - 2 && keys[i + 1][0] < x) i++;
    var x0 = keys[i][0], x1 = keys[i + 1][0], p0 = keys[i][k], p1 = keys[i + 1][k], dx = x1 - x0;
    function m(j) {
      var a = keys[Math.max(0, j - 1)], b = keys[Math.min(n - 1, j + 1)];
      return (b[k] - a[k]) / ((b[0] - a[0]) || 1);
    }
    var t = (x - x0) / dx, t2 = t * t, t3 = t2 * t;
    var v = (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * dx * m(i) + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * dx * m(i + 1);
    return Math.max(Math.min(p0, p1), Math.min(Math.max(p0, p1), v));
  }
  function r4(v) { return Math.round(v * 1e4) / 1e4; }
  function tireW(s) { var mm = String(s).match(/(\d{3})\//); return mm ? +mm[1] / 1000 : 0.25; }

  /* Ring layout (half ring, bottom centre → top centre, 21 points; full ring = 40, mirrored):
       K0 bottom centre · K1 floor edge · K2 rocker · K3 widest point · K4 upper side (tumblehome) ·
       K5 crest (front-wing dome / door shoulder / rear haunch crown) · K6 · K7 · K8 top centre.
     Over the bonnet and engine cover K6/K7 shape the valley between the crests; in the cabin K6 is the glass base
     (beltline), K7 the roof rail (or flying-buttress top) and K8 the roof centre. Fixed vertex counts per segment
     keep every feature on the same ring index along the car, so the glass edges and creases run clean.
     keys: [x, crestDrop, crestZ, k6Drop, k6Z, k7Drop, k7Z, centreDrop, cabin] — drops are below the side-view
     silhouette top at that x, z values are absolute half-widths (clamped inside the plan outline). */
  var SEG = [1, 2, 2, 2, 3, 3, 3, 4], IDX_K6 = 13, IDX_K7 = 16;
  function buildSections(m, keys, o) {
    o = o || {};
    keys = keys.slice().sort(function (a, b) { return a[0] - b[0]; });
    var sb = flat(m.side.body, 16), tb = flat(m.top.body, 16), win = [];
    (m.side.windows || []).forEach(function (w) { win = win.concat(flat(w, 16)); });
    var roofX = [Infinity, -Infinity];
    flat(m.top.roof, 8).forEach(function (p) { p.forEach(function (q) { roofX[0] = Math.min(roofX[0], q[0]); roofX[1] = Math.max(roofX[1], q[0]); }); });
    var ref = m.ref, arches = [m.side.archF, m.side.archR];
    var wells = [[arches[0], ref.trackF, ref.tireF], [arches[1], ref.trackR, ref.tireR]].map(function (q) {
      return { x: q[0].x, y: q[0].y, r: q[0].r, zIn: q[1] / 2 - tireW(q[2]) / 2 - 0.025 };
    });
    var XF = -Infinity, XR = Infinity;
    sb.forEach(function (p) { p.forEach(function (q) { XF = Math.max(XF, q[0]); XR = Math.min(XR, q[0]); }); });
    var NS = o.stations || 72, xs = [];
    var TAIL = 0.12, NOSE = 0.10;                                   // closing zones re-derived from a base ring
    for (var i = 0; i < NS; i++) {
      var t = i / (NS - 1);
      xs.push(XR + TAIL + (XF - XR - TAIL - NOSE) * (0.5 - 0.5 * Math.cos(Math.PI * t)));
    }
    // stations on the arch circle landmarks (axle ± r·{1, 0.87, 0.5, 0}) plus dense fill, so the cut-outs follow the circle
    arches.forEach(function (a) {
      [-1, -0.87, -0.5, 0, 0.5, 0.87, 1].forEach(function (f) { xs.push(a.x + f * a.r * 0.985); });
      for (var d = -a.r * 1.04; d <= a.r * 1.04; d += 0.03) xs.push(a.x + d);
    });
    var winX = [Infinity, -Infinity];
    win.forEach(function (p) { p.forEach(function (q) { winX[0] = Math.min(winX[0], q[0]); winX[1] = Math.max(winX[1], q[0]); }); });
    xs.sort(function (a, b) { return a - b; });
    xs = xs.filter(function (x, k) { return x >= XR + TAIL - 1e-9 && x <= XF - NOSE + 1e-9 && (k === 0 || x - xs[k - 1] > 0.012); });
    function bottomAt(x) {
      for (var k = 0; k < arches.length; k++) {
        var a = arches[k], e = a.r * 1.12;
        if (Math.abs(x - a.x) < e) {
          var l = sliceX(sb, a.x - e), r = sliceX(sb, a.x + e);
          var lb = l ? l[0] : 0.2, rb = r ? r[0] : 0.2;
          return lb + (rb - lb) * (x - (a.x - e)) / (2 * e);
        }
      }
      var s = sliceX(sb, x); return s ? s[0] : 0.2;
    }
    function cubicPts(P0, c1, c2, P1, n, out) {
      for (var j = 1; j <= n; j++) {
        var tt = j / n, u = 1 - tt;
        out.push([u * u * u * P0[0] + 3 * u * u * tt * c1[0] + 3 * u * tt * tt * c2[0] + tt * tt * tt * P1[0],
          u * u * u * P0[1] + 3 * u * u * tt * c1[1] + 3 * u * tt * tt * c2[1] + tt * tt * tt * P1[1]]);
      }
    }
    function smooth01(v) { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v); }
    var gcl = ref.groundClearance || 0.1, END_SPAN = 0.12, END_TAPER = 0.04;
    var flX0 = arches[1].x + arches[1].r * 1.12, flX1 = arches[0].x - arches[0].r * 1.12;
    function floorW(x) { return Math.min(smooth01((x - flX0) / 0.15), smooth01((flX1 - x) / 0.15)); }
    function endTaper(x) {
      return END_TAPER * Math.max(1 - smooth01((x - (XR + TAIL)) / END_SPAN), 1 - smooth01(((XF - NOSE) - x) / END_SPAN));
    }
    /** taper weight: 0 outside [x1, x0], ramps over e at each end */
    function band01(x, x0, x1, e) { return Math.min(smooth01((x0 - x) / e), smooth01((x - x1) / e)); }
    /** point at arc-length fraction u along a polyline */
    function along(P, u) {
      var L = [0], k;
      for (k = 1; k < P.length; k++) L.push(L[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]));
      var s = u * L[L.length - 1];
      for (k = 1; k < P.length; k++) if (L[k] >= s) {
        var f = (s - L[k - 1]) / ((L[k] - L[k - 1]) || 1);
        return [P[k - 1][0] + (P[k][0] - P[k - 1][0]) * f, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * f];
      }
      return P[P.length - 1].slice();
    }
    /** half ring [z,y] (21 pts, bottom centre → top centre) at x, or null */
    function halfAt(x) {
      var sl = sliceX(sb, x); if (!sl) return null;
      var tw = sliceX(tb, x); if (!tw) return null;
      var yT = sl[1], w = Math.max(Math.abs(tw[0]), Math.abs(tw[1]));
      if (w < 0.03) return null;
      var yb = Math.min(bottomAt(x), yT - 0.05);
      var K = function (k) { return keyAt(keys, x, k); };
      var yC = Math.max(yT - K(1), yb + 0.05), zC = Math.min(K(2), 0.90 * w);
      var y6 = Math.max(yT - K(3), yb + 0.05), z6 = Math.min(K(4), 0.93 * zC);
      var y7 = Math.max(yT - K(5), yb + 0.05), z7 = Math.min(K(6), 0.88 * z6);
      var y8 = Math.max(yT - K(7), yb + 0.05);
      var h = yC - yb, tum = Math.min(o.tumble || 0.06, 0.08 * w);
      // key points as [z, y] so the spline runs in the section plane
      var KP = [[0, yb], [0.86 * w, yb, 1], [0.965 * w, yb + Math.min(0.05, 0.25 * h)], [w, yb + 0.42 * h],
        [w - tum, yb + 0.80 * h], [zC, yC], [z6, y6], [z7, y7], [0, y8]];
      var all = KP.concat(KP.slice(1, -1).reverse().map(function (q) { var c = q.slice(); c[0] = -c[0]; return c; }));
      var segs = splineSegs(all, true), half = [[0, yb]], dense = [[0, yb]], cur = all[0];
      for (var s = 0; s < 8; s++) {
        var sg = segs[s];
        cubicPts(cur, sg.p[0], sg.p[1], sg.p[2], SEG[s], half);
        if (s >= 1 && s <= 4) cubicPts(cur, sg.p[0], sg.p[1], sg.p[2], 24, dense);
        cur = sg.p[2];
      }
      half[half.length - 1][0] = 0;
      // floor between the arches sits at the published ground clearance (not the side-view sill height)
      var fw = floorW(x);
      if (fw > 0) for (var fq = 0; fq <= 1; fq++) half[fq][1] = Math.min(half[fq][1], half[fq][1] + (gcl - half[fq][1]) * fw);
      // the last few stations at each end pull in (no flat slab at the tail / nose)
      var tp = endTaper(x);
      if (tp > 0) half.forEach(function (q) { q[0] *= Math.max(0, (w - tp) / w); });
      dense = dense.slice(1);                                         // floor edge (K1) → crest (K5)
      // wheel wells: rebuild the lower ring with a fixed topology — 1 floor edge, 2–4 inner well wall, 5 lip
      // flange, 6 the lip on the arch circle, 7–10 the outer skin resampled up to the crest — so the cut-out edge
      // runs exactly along the arch circle from station to station
      wells.forEach(function (W) {
        var dx = x - W.x, adx = Math.abs(dx), edge = W.r * 0.986, FADE = 0.30;
        if (adx >= edge + FADE) return;
        var crest = dense[dense.length - 1];
        var inWell = adx < edge;
        var topEdge = W.y + Math.sqrt(W.r * W.r - edge * edge);
        var top = inWell ? W.y + Math.sqrt(W.r * W.r - dx * dx) : topEdge;
        if (crest[1] < top + 0.02) return;
        // blend weight: 1 inside and at the well, fading to the plain ring FADE beyond its ends
        var wt = inWell ? 1 : 1 - smooth01((adx - edge) / FADE);
        var k = 0; while (k < dense.length - 1 && dense[k][1] < top) k++;
        var a = dense[Math.max(0, k - 1)], b = dense[k], f = (top - a[1]) / ((b[1] - a[1]) || 1);
        var lip = [a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, f)), top];
        var skin = [lip].concat(dense.slice(k)), lower = dense.slice(0, k).concat([lip]);
        var q, P = [];
        for (q = 6; q <= 10; q++) P[q] = along(skin, Math.pow((q - 6) / 4, 1.25));
        if (inWell) {
          var zIn = Math.min(W.zIn, lip[0] - 0.06);
          P[1] = [Math.min(half[1][0], zIn - 0.02), yb];
          P[2] = [zIn, yb + 0.30 * (top - yb)];
          P[3] = [zIn, yb + 0.70 * (top - yb)];
          P[4] = [zIn, top + 0.02];
          P[5] = [lip[0] - 0.04, top + 0.012];
        } else {
          for (q = 1; q <= 5; q++) P[q] = lower.length > 1 ? along(lower, (q - 1) / 5) : half[q];
        }
        for (q = 1; q <= 10; q++) half[q] = [half[q][0] + (P[q][0] - half[q][0]) * wt, half[q][1] + (P[q][1] - half[q][1]) * wt];
      });
      return { half: half, yT: yT, y6: y6, cab: K(8) };
    }
    function ridges(half, x) {
      (o.ridges || []).forEach(function (R) {
        var wt = band01(x, R.x0, R.x1, R.ease || 0.10), hh = R.h * wt, j;
        if (wt <= 0) return;
        if (R.type === 'fin') {                                      // thin central fin standing proud of the roof
          half[19] = [half[19][0] + (0.022 - half[19][0]) * wt, half[19][1] - 0.45 * hh];
          half[18][1] -= hh; half[17][1] -= 0.5 * hh;
        } else if (R.type === 'snorkel') {                           // flat-topped duct ~0.2 m wide
          half[18] = [half[18][0] + (0.125 - half[18][0]) * wt, half[19][1] - hh];
          half[19] = [half[19][0] + (0.085 - half[19][0]) * wt, half[20][1] - 0.004 * wt];
        } else if (R.type === 'buttress') {                          // fins at the K7 rail, valleys either side
          half[16][0] += (R.z - half[16][0]) * wt;
          for (j = 11; j <= 15; j++) half[j][1] -= hh * [0.4, 0.8, 1, 1, 0.55][j - 11];
          for (j = 17; j <= 20; j++) half[j][1] -= hh * [0.55, 1, 1, 1][j - 17];
        }
      });
    }
    var out = [];
    function push(x, H, flags) {
      var ring = H.map(function (q) { return [r4(q[1]), r4(q[0])]; }), fl = flags.slice();
      for (var mm = H.length - 2; mm >= 1; mm--) { ring.push([ring[mm][0], r4(-ring[mm][1])]); fl.push(fl[mm]); }
      out.push({ x: r4(x), ring: ring, belt: null, glass: fl });
      return out[out.length - 1];
    }
    xs.forEach(function (x) {
      var A = halfAt(x); if (!A) return;
      var half = A.half, cab = A.cab;
      ridges(half, x);
      var flags = half.map(function (q, j) {
        if (cab < 0.5) return 0;
        // flags by ring index and station range only, so every glass edge runs straight along the car
        if (j >= IDX_K6 && j <= IDX_K7 && x > winX[0] + 0.04 && x < winX[1] - 0.04) return 1;
        if (j >= IDX_K7 && (x > roofX[1] || x < roofX[0])) return 1;
        if (j >= IDX_K7 + 1 && x > 0.15 && x < 0.72) return 1;          // one wide windscreen panel
        return 0;
      });
      push(x, half, flags).belt = cab >= 0.5 ? r4(A.y6) : null;
    });
    var zeros = []; for (var zq = 0; zq < 21; zq++) zeros.push(0);
    // tail: 4 closing rings over the last 0.12 m — the lower edge rises and the ring narrows to a rounded cap
    var T0 = out[0], tb0 = halfAt(T0.x);
    if (tb0) {
      var hb = tb0.half; ridges(hb, T0.x);
      var yb0 = hb[0][1], yt0 = -Infinity; hb.forEach(function (q) { yt0 = Math.max(yt0, q[1]); });
      [[0.09, 0.08, 0.97], [0.06, 0.20, 0.89], [0.03, 0.42, 0.68], [0.004, 0.70, 0.42]].forEach(function (c) {
        var x = XR + c[0], sl = sliceX(sb, x), yt = Math.min(yt0, sl ? sl[1] : yt0), yL = yb0 + c[1] * (yt - yb0);
        var rnd = 0.08 * c[1];
        var H = hb.map(function (q, j) {
          var y = yL + (q[1] - yb0) * (yt - yL) / ((yt0 - yb0) || 1), z = q[0] * c[2];
          if (j >= 1 && j <= 4) { var e = (5 - j) / 4; z -= rnd * e; y += rnd * 0.5 * e * (j === 1 ? 1 : 0.6); }
          return [Math.max(0, z), y];
        });
        out.unshift({ x: r4(x), ring: [], belt: null, glass: [] });
        var o2 = push(x, H, zeros); out.pop(); out[0] = o2;
      });
    }
    // nose: taper the last 0.10 m onto the side-view nose profile, half-width closing to a point
    var N0 = out[out.length - 1], nb0 = halfAt(N0.x);
    if (nb0) {
      var hn = nb0.half, nyb = hn[0][1], nyt = -Infinity, nw = 0;
      hn.forEach(function (q) { nyt = Math.max(nyt, q[1]); nw = Math.max(nw, q[0]); });
      [[0.075, 0.80], [0.050, 0.60], [0.028, 0.40], [0.012, 0.22], [0.003, 0.09]].forEach(function (c) {
        var x = XF - c[0], sl = sliceX(sb, x); if (!sl) return;
        var tw = sliceX(tb, x), wN = tw ? Math.max(Math.abs(tw[0]), Math.abs(tw[1])) : nw * c[1];
        var sc = Math.min(c[1], wN / nw);
        var H = hn.map(function (q) { return [q[0] * sc, sl[0] + (q[1] - nyb) * (sl[1] - sl[0]) / ((nyt - nyb) || 1)]; });
        push(x, H, zeros);
      });
    }
    return out;
  }

  /* ================================================================== FERRARI SF90 STRADALE */
  function sf90() {
    var L = 4.710, W = 1.972, H = 1.186, WB = 2.650, FO = 1.040, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.365, R -2.345
    var rF = tireRadius(255, 35, 20), rR = tireRadius(315, 30, 20);         // 0.3433, 0.3485
    var raF = rF + 0.032, raR = rR + 0.033;

    /* ---- side ---- */
    // knife-edge nose: splitter crease, sharp leading edge at bumper height, then a straight steep rise to the
    // wing tops; the cab-forward glass, buttress-topped roof, haunches that run flat to a gurney lip, raked tail
    var body = Pth(2.25, 0.105)
      .L(2.30, 0.12)
      .S([[2.345, 0.155], [F, 0.20, 1]])                                                    // splitter crease → lower face
      .S([[F + 0.002, 0.29], [F - 0.003, 0.38, 1]])                                         // knife-edge tip crease
      .S([[2.27, 0.468], [2.15, 0.55], [1.95, 0.64], [1.60, 0.74], [1.30, 0.80],
        [1.02, 0.853], [0.80, 0.895]])                                                       // raked face, bonnet → wing crest
      .S([[0.42, 1.02], [0.10, 1.135], [-0.26, H], [-0.62, 1.164], [-0.95, 1.112], [-1.20, 1.066],
        [-1.50, 1.036], [-1.85, 1.004], [-2.10, 0.982], [-2.29, 0.971], [-2.36, 1.0, 1]])   // roof, buttress, haunch, gurney lip
      .S([[-2.28, 0.86], [-2.24, 0.62], [-2.30, 0.40, 1]])                                  // tail undercut below the lip
      .S([[-2.20, 0.25], [-2.02, 0.185], [-1.75, 0.145]])                                   // deep diffuser kick
      .arch(aR, rR, raR, 0.15, 0.17)
      .L(-0.93, 0.118).L(0.93, 0.118)
      .arch(aF, rF, raF, 0.17, 0.25)
      .S([[1.95, 0.19], [2.15, 0.125], [2.25, 0.105]]).Z();
    var greenhouse = Pth(0.80, 0.895)
      .S([[0.42, 1.018], [0.10, 1.13], [-0.26, 1.178], [-0.62, 1.156], [-0.95, 1.104], [-1.20, 1.058]])
      .S([[-1.17, 1.0], [-1.06, 0.975]])
      .S([[-0.55, 0.94], [0.20, 0.908], [0.80, 0.895]]).Z();                                 // dark DLO incl. buttress tunnel
    var sideGlass = Pth(0.64, 0.93)
      .S([[0.30, 1.045], [0.0, 1.118], [-0.32, 1.148], [-0.60, 1.12], [-0.76, 1.06]])
      .S([[-0.55, 0.992], [-0.10, 0.956], [0.64, 0.93]]).Z();
    var aPillar = Pth(0.80, 0.895).S([[0.42, 1.018], [0.10, 1.13], [-0.06, 1.152]])
      .L(-0.02, 1.128).S([[0.30, 1.045], [0.64, 0.93]]).Z();
    // flying buttress: a separate body-colour fin from the roof down to the haunch, with the black tunnel under it
    var buttress = Pth(-0.60, 1.165).S([[-0.95, 1.110], [-1.20, 1.064], [-1.34, 1.046]])
      .S([[-1.14, 1.040], [-0.92, 1.078], [-0.72, 1.118]]).Z();
    var tunnel = Pth(-0.72, 1.115).S([[-0.92, 1.075], [-1.14, 1.037], [-1.30, 1.020]])
      .S([[-1.16, 0.99], [-1.02, 0.972]]).S([[-0.86, 0.985], [-0.78, 1.04]]).Z();

    var side = {
      body: body,
      greenhouse: greenhouse,
      windows: [sideGlass],
      pillars: [aPillar, buttress],
      doorCuts: [
        curve([[0.93, 0.20], [0.905, 0.52], [0.84, 0.78], [0.72, 0.905]]),
        curve([[-0.76, 1.04], [-0.70, 0.95], [-0.36, 0.87], [-0.30, 0.60], [-0.30, 0.20]]),
        curve([[0.93, 0.20], [0.20, 0.19], [-0.30, 0.20]])
      ],
      panelLines: [
        curve([[2.355, 0.36], [2.25, 0.455], [2.13, 0.528], [1.98, 0.598]]),                // front lid / blade edge
        curve([[-1.34, 1.036], [-1.70, 1.002], [-2.05, 0.974], [-2.25, 0.962]]),             // engine cover
        rect(-1.45, 1.005, 0.09, 0.022)                                                       // fuel flap on the haunch
      ],
      characterLines: [
        curve([[1.02, 0.30], [0.50, 0.30], [0.0, 0.36], [-0.30, 0.50]]),                     // rocker kick-up
        curve([[1.80, 0.665], [1.40, 0.758], [1.00, 0.826], [0.82, 0.862]]),                 // front wing crest
        curve([[-0.30, 0.862], [-0.70, 0.864], [-1.06, 0.872], [-1.40, 0.905], [-1.80, 0.93], [-2.27, 0.935]])  // intake lip → haunch
      ],
      sill: Pth(0.93, 0.118).L(-0.93, 0.118).L(-0.95, 0.165).S([[-0.40, 0.19], [0.40, 0.19], [0.97, 0.165]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.028 },
      archR: { x: aR, y: rR, r: raR, flare: 0.034 },
      lowerTrim: [
        Pth(2.25, 0.105).L(2.30, 0.12).L(2.32, 0.14).S([[2.15, 0.15], [1.96, 0.215]]).L(1.95, 0.19).S([[2.15, 0.125]]).Z(), // splitter
        Pth(-2.30, 0.40).S([[-2.20, 0.25], [-2.02, 0.185], [-1.75, 0.145]]).L(-1.76, 0.18).S([[-2.02, 0.22], [-2.18, 0.28], [-2.275, 0.42]]).Z(), // diffuser
        Pth(0.93, 0.118).L(-0.93, 0.118).L(-0.95, 0.165).S([[-0.40, 0.19], [0.40, 0.19], [0.97, 0.165]]).Z()
      ]
    };

    /* ---- top ---- */
    var top = {
      body: sym([[F, 0], [2.358, 0.25], [2.30, 0.55], [2.20, 0.75], [2.00, 0.90], [1.75, 0.962], [1.45, hw],
        [1.00, 0.962], [0.55, 0.935], [0.20, 0.925], [-0.30, 0.94], [-0.75, 0.970], [-1.12, hw], [-1.62, 0.981],
        [-2.05, 0.93], [-2.28, 0.80], [-2.336, 0.55], [R, 0.25], [R, 0]], 1),
      greenhouse: sym([[0.82, 0], [0.80, 0.55], [0.45, 0.66], [-0.20, 0.68], [-0.75, 0.58], [-1.0, 0.40], [-1.06, 0]], 1),
      hood: sym([[2.30, 0], [2.24, 0.36], [2.02, 0.52], [1.50, 0.56], [1.05, 0.55], [0.92, 0]], 1),
      roof: sym([[0.06, 0], [0.04, 0.55], [-0.30, 0.60], [-0.70, 0.52], [-0.80, 0]], 1),
      deck: sym([[-1.10, 0], [-1.12, 0.36], [-1.40, 0.55], [-1.90, 0.60], [-2.20, 0.52], [-2.30, 0]], 1),  // engine cover between the haunches
      mirrors: pair(loop([[0.62, 0.90], [0.58, 1.02], [0.50, 1.085], [0.43, 1.075], [0.45, 0.98], [0.52, 0.91]]), 1),
      characterLines: [].concat(pair(curve([[1.95, 0.70], [1.60, 0.78], [1.10, 0.78], [0.85, 0.76]]), 1),   // front wing crowns
        pair(curve([[-1.15, 0.80], [-1.70, 0.82], [-2.20, 0.76]]), 1))                                     // haunch crowns
    };

    /* ---- front (z,y) ---- */
    var front = {
      body: sym([[0, H], [0.30, H - 0.008], [0.50, 1.135], [0.62, 0.99], [0.68, 0.925], [0.76, 0.885], [0.84, 0.856],
        [0.915, 0.76], [0.962, 0.62], [hw, 0.48], [0.98, 0.33], [0.95, 0.18], [0.88, 0.108, 1], [0, 0.105]], 0),
      greenhouse: sym([[0, 1.15], [0.42, 1.135], [0.64, 0.92, 1], [0.40, 0.898], [0, 0.893]], 0),
      bumper: sym([[0, 0.44], [0.60, 0.452], [0.92, 0.50, 1], [0.975, 0.36], [0.95, 0.18], [0.88, 0.108, 1], [0, 0.105]], 0),
      grille: [sym([[0, 0.30], [0.44, 0.298], [0.52, 0.282, 1], [0.512, 0.18], [0.45, 0.16, 1], [0, 0.16]], 0)],
      intakes: pair(loop([[0.70, 0.46, 1], [0.90, 0.48, 1], [0.94, 0.34], [0.915, 0.18, 1], [0.75, 0.18, 1]]), 0),
      // slim slanted slot: pointed low inner end, outer end tucked under the wing crest; DRL eyebrow on top
      headlights: pair(loop([[0.48, 0.55, 1], [0.62, 0.585], [0.78, 0.635], [0.865, 0.668, 1], [0.878, 0.635],
        [0.80, 0.598], [0.64, 0.556], [0.50, 0.536]]), 0),
      drl: pair(loop([[0.495, 0.552, 1], [0.63, 0.586], [0.78, 0.636], [0.858, 0.664, 1], [0.852, 0.650],
        [0.77, 0.622], [0.63, 0.574], [0.52, 0.547, 1]]), 0),
      splitter: sym([[0, 0.135], [0.86, 0.126, 1], [0.885, 0.105, 1], [0, 0.103]], 0),
      panelLines: [curve([[-0.72, 0.862], [-0.56, 0.80], [-0.30, 0.752], [0, 0.742], [0.30, 0.752], [0.56, 0.80], [0.72, 0.862]])],
      plateArea: rect(0, 0.245, 0.52, 0.11),
      badgeArea: rect(0, 0.50, 0.08, 0.05),
      badgeText: 'FERRARI'
    };

    /* ---- rear (z,y) ---- */
    var rear = {
      body: sym([[0, H], [0.30, 1.172], [0.46, 1.11], [0.56, 1.04], [0.62, 1.0], [0.72, 1.02], [0.80, 1.032],
        [0.90, 1.012], [0.958, 0.93], [hw, 0.75], [0.975, 0.48], [0.94, 0.26], [0.86, 0.14, 1], [0, 0.138]], 0),
      greenhouse: sym([[0, 1.13], [0.36, 1.12], [0.44, 1.03, 1], [0, 1.012]], 0),
      bumper: sym([[0, 0.55], [0.90, 0.55, 1], [0.97, 0.42], [0.94, 0.26], [0.86, 0.14, 1], [0, 0.138]], 0),
      taillights: [].concat(
        pair(rrect(0.60, 0.89, 0.16, 0.10, 0.03), 0),        // inner lamp
        pair(rrect(0.82, 0.89, 0.16, 0.10, 0.03), 0)),       // outer lamp
      diffuser: sym([[0, 0.36], [0.62, 0.36, 1], [0.72, 0.30], [0.70, 0.14, 1], [0, 0.138]], 0),
      exhaust: [{ shape: 'oval', cx: 0.24, cy: 0.62, w: 0.14, h: 0.07 }, { shape: 'oval', cx: -0.24, cy: 0.62, w: 0.14, h: 0.07 }],
      panelLines: [
        curve([[-0.62, 0.995], [-0.40, 0.975], [0, 0.968], [0.40, 0.975], [0.62, 0.995]]),          // engine cover between the crowns
        curve([[0.66, 1.0], [0.80, 1.022], [0.92, 1.0]]), curve([[-0.66, 1.0], [-0.80, 1.022], [-0.92, 1.0]])  // haunch crowns
      ],
      plateArea: rect(0, 0.45, 0.52, 0.11),
      badgeArea: rect(0, 0.80, 0.30, 0.03),
      badgeText: 'FERRARI',
      spoiler: sym([[0, 0.995], [0.90, 0.99, 1], [0.905, 0.968, 1], [0, 0.972]], 0)
    };

    var details = [
      det('side', 'mirror', 'body', loop([[0.60, 0.95], [0.56, 1.01], [0.44, 1.03], [0.38, 0.995], [0.42, 0.955], [0.52, 0.945]])),
      det('side', 'trim', 'black', poly([[0.58, 0.935], [0.62, 0.935], [0.60, 0.955], [0.56, 0.955]])),      // mirror stalk
      det('side', 'intake', 'black', tunnel),                                                                 // buttress tunnel
      // door scallop: sharp horizontal lip at 0.86, opening under it deepening toward the rear wheel
      det('side', 'intake', 'black', Pth(-0.35, 0.858).L(-1.03, 0.866).S([[-1.05, 0.79], [-1.0, 0.685]])
        .S([[-0.80, 0.74], [-0.55, 0.815], [-0.35, 0.858]]).Z()),
      det('side', 'trim', 'light', Pth(2.27, 0.452).S([[2.17, 0.522], [2.04, 0.588]]).L(2.045, 0.565).S([[2.17, 0.498], [2.285, 0.428]]).Z()),
      det('side', 'trim', 'light-red', poly([[-2.335, 0.975], [-2.27, 0.966], [-2.27, 0.94], [-2.325, 0.944]])),
      det('side', 'vent', 'black', Pth(1.02, 0.86).S([[0.90, 0.78], [0.80, 0.70]]).L(0.83, 0.69).S([[0.93, 0.77], [1.06, 0.855]]).Z()), // wing outlet
      det('side', 'wiper', 'black', curve([[0.78, 0.905], [0.55, 0.975]])),
      det('top', 'wiper', 'black', curve([[0.76, -0.45], [0.66, 0.20]])),
      det('front', 'badge', 'body', rect(0, 0.50, 0.06, 0.035)),
      det('front', 'trim', 'body', sym([[0, 0.38], [0.40, 0.379], [0.56, 0.37, 1], [0.56, 0.33, 1], [0, 0.33]], 0)),   // floating blade
      det('front', 'intake', 'black', sym([[0, 0.468], [0.36, 0.465], [0.50, 0.445, 1], [0.40, 0.428], [0, 0.426]], 0)) // S-duct mouth
    ].concat(
      // louvred engine cover between the haunch crowns
      [0, 1, 2, 3, 4, 5].reduce(function (a, i) {
        var x = -1.40 - i * 0.11, zo = 0.44 + 0.08 * Math.sin(Math.PI * (i + 0.5) / 6);
        return a.concat(detPair('top', 'vent', 'black', rrect(x, zo / 2 + 0.03, 0.035, zo - 0.06, 0.015)));
      }, []),
      detPair('top', 'trim', 'body', loop([[-0.60, 0.60, 1], [-0.95, 0.66], [-1.30, 0.74, 1], [-1.30, 0.76, 1], [-0.95, 0.69], [-0.60, 0.635, 1]])), // buttress fins
      detPair('front', 'intake', 'grille', loop([[0.715, 0.445, 1], [0.89, 0.462, 1], [0.925, 0.34], [0.903, 0.195, 1], [0.762, 0.195, 1]])),
      slats('front', 0.08, 0.44, 7, 0.29, 0.17, 'gloss-black'),
      detPair('top', 'vent', 'black', rrect(1.85, 0.25, 0.30, 0.06, 0.025)),                                 // twin bonnet air-exit slots
      detPair('rear', 'vent', 'grille', loop([[0.70, 0.815, 1], [0.95, 0.83, 1], [0.97, 0.62], [0.80, 0.58, 1], [0.72, 0.68]])),
      slats('rear', 0.12, 0.60, 5, 0.34, 0.15, 'carbon'),
      [det('rear', 'trim', 'black', [-0.12, 0.12].reduce(function (o, cx) {                                   // one black bezel round both high pipes
        return o.concat(reversePath(rrect(cx, 0.62, 0.15, 0.08, 0.035)));
      }, rrect(0, 0.62, 0.40, 0.12, 0.05)))],
      detPair('rear', 'trim', 'chrome', ring(rrect(0.12, 0.62, 0.15, 0.08, 0.035), rrect(0.12, 0.62, 0.135, 0.066, 0.03))),
      detPair('rear', 'trim', 'light-red', rrect(0.60, 0.89, 0.13, 0.07, 0.022)),      // lamp inner rings
      detPair('rear', 'trim', 'light-red', rrect(0.82, 0.89, 0.13, 0.07, 0.022))
    );

    var m = {
      id: 'ferrari-sf90-stradale', make: 'Ferrari', name: 'SF90 Stradale', gen: 'F173', years: '2019–2024',
      look: { head: 'slim-led', tail: 'slim', grille: 'mesh' },   // renderer lamp / grille signature
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'awd', powertrain: 'hybrid',
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.679, trackR: 1.652, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 20, tireF: '255/35R20', tireR: '315/30R20', groundClearance: 0.105, rideHeight: 0.118, cd: 0.32,
        curbWeight_kg: 1770 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Slim slashed LED slots tucked under the wing crests, inner ends low and pointed, with an LED eyebrow DRL along the upper edge',
        taillights: 'Two near-square rounded lamps per side under a full-width shut-off Gurney lip; twin exhausts mounted high above the plate and a deep diffuser',
        grille: 'Floating body-colour blade across the nose over a wide dark central intake, S-duct slot above, lateral brake/radiator intakes',
        notes: 'Knife-edge nose, cab-forward screen, teardrop side glass with flying buttresses over black tunnels, horizontal-lipped door scallop feeding the radiators, louvred engine cover between raised haunches'
      }
    };
    //       x      crestD crestZ  k6D   k6Z   k7D   k7Z  centreD cabin
    m.sections = buildSections(m, [
      [2.362, 0.010, 0.30, 0.030, 0.20, 0.040, 0.10, 0.045, 0],
      [2.25, 0.000, 0.60, 0.060, 0.42, 0.090, 0.20, 0.100, 0],
      [2.00, 0.000, 0.72, 0.080, 0.52, 0.120, 0.26, 0.130, 0],
      [1.60, 0.000, 0.78, 0.090, 0.56, 0.130, 0.28, 0.140, 0],
      [1.20, 0.000, 0.78, 0.085, 0.56, 0.120, 0.28, 0.130, 0],
      [0.95, 0.000, 0.78, 0.060, 0.60, 0.080, 0.30, 0.090, 0],
      [0.80, 0.020, 0.78, 0.010, 0.68, 0.000, 0.56, 0.035, 1],
      [0.40, 0.140, 0.80, 0.110, 0.67, 0.020, 0.58, 0.000, 1],
      [0.00, 0.265, 0.77, 0.205, 0.68, 0.035, 0.56, 0.000, 1],
      [-0.40, 0.280, 0.78, 0.220, 0.68, 0.035, 0.56, 0.000, 1],
      [-0.80, 0.190, 0.80, 0.130, 0.70, 0.000, 0.58, 0.030, 1],
      [-1.05, 0.110, 0.80, 0.050, 0.70, 0.000, 0.58, 0.090, 0],
      [-1.30, 0.000, 0.80, 0.025, 0.66, 0.060, 0.45, 0.080, 0],
      [-1.80, 0.000, 0.80, 0.035, 0.62, 0.070, 0.38, 0.080, 0],
      [-2.20, 0.000, 0.74, 0.030, 0.55, 0.050, 0.30, 0.055, 0],
      [-2.34, 0.000, 0.60, 0.020, 0.45, 0.030, 0.25, 0.035, 0]
    ], { ridges: [{ type: 'buttress', x0: -0.60, x1: -1.30, h: 0.04, z: 0.62, ease: 0.22 }] });
    m.wheel = { spokes: 5, style: 'twin', finish: '#8d9196', caliper: '#e8b100' };   // forged twin-5-spoke
    return m;
  }

  /* ================================================================== McLAREN P1 */
  function p1() {
    var L = 4.588, W = 1.946, H = 1.188, WB = 2.670, FO = 0.995, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.330, R -2.258
    var rF = tireRadius(245, 35, 19), rR = tireRadius(315, 30, 20);         // 0.3270, 0.3485
    var raF = rF + 0.033, raR = rR + 0.033;

    // shark nose → one continuous teardrop arc over bonnet, screen and canopy → tapering engine cover → tall diffuser
    var body = Pth(2.22, 0.10)
      .S([[2.30, 0.125], [2.322, 0.20], [F, 0.30, 1]])
      .S([[2.27, 0.41], [2.13, 0.51], [1.92, 0.615], [1.62, 0.725], [1.33, 0.80], [1.02, 0.842], [0.74, 0.875],
        [0.40, 1.00], [0.05, 1.128], [-0.30, H], [-0.70, 1.152], [-1.02, 1.075], [-1.40, 1.0],
        [-1.85, 0.94], [-2.10, 0.915], [-2.24, 0.935, 1]])
      .S([[R, 0.90], [-2.256, 0.75], [-2.245, 0.62], [-2.22, 0.52, 1]])
      .S([[-2.05, 0.33], [-1.85, 0.20], [-1.70, 0.16]])
      .arch(aR, rR, raR, 0.16, 0.17)
      .L(-0.93, 0.115).L(0.93, 0.115)
      .arch(aF, rF, raF, 0.17, 0.24)
      .S([[1.92, 0.18], [2.10, 0.12], [2.22, 0.10]]).Z();
    var greenhouse = Pth(0.74, 0.875)
      .S([[0.40, 0.995], [0.05, 1.122], [-0.30, 1.180], [-0.70, 1.148], [-0.95, 1.094]])
      .S([[-1.02, 1.02], [-0.98, 0.96]])
      .S([[-0.40, 0.93], [0.30, 0.895], [0.74, 0.875]]).Z();
    var sideGlass = Pth(0.60, 0.912)
      .S([[0.30, 1.02], [0.0, 1.112], [-0.32, 1.162], [-0.62, 1.138], [-0.86, 1.08]])
      .S([[-0.80, 1.02], [-0.55, 0.975], [-0.10, 0.94], [0.60, 0.912]]).Z();
    var aPillar = Pth(0.74, 0.875).S([[0.40, 0.995], [0.05, 1.122], [-0.08, 1.15]])
      .L(-0.05, 1.125).S([[0.30, 1.02], [0.60, 0.912]]).Z();
    var cPillar = Pth(-0.70, 1.148).S([[-0.95, 1.094], [-1.02, 1.02], [-0.98, 0.96]])
      .S([[-0.80, 1.02]]).L(-0.86, 1.08).S([[-0.62, 1.138]]).Z();
    // the long concave door scallop: low behind the front arch, rising along the door into the radiator mouth
    // teardrop: a point just behind the front arch, opening to ~0.40 m tall at the radiator mouth
    var scallop = Pth(0.30, 0.62).S([[-0.10, 0.685], [-0.55, 0.765], [-0.90, 0.82]])
      .S([[-0.975, 0.66], [-0.95, 0.45]])
      .S([[-0.50, 0.468], [-0.05, 0.53], [0.30, 0.62]]).Z();
    var scallopLip = band([[0.24, 0.604], [-0.05, 0.53], [-0.50, 0.468], [-0.93, 0.452]], 0.04);
    var mouth = Pth(-0.60, 0.785).S([[-0.90, 0.852]]).S([[-0.972, 0.68], [-0.935, 0.50]]).S([[-0.75, 0.52], [-0.60, 0.785]]).Z();

    var side = {
      body: body, greenhouse: greenhouse, windows: [sideGlass], pillars: [aPillar, cPillar],
      doorCuts: [
        curve([[0.94, 0.36], [0.90, 0.62], [0.80, 0.80], [0.66, 0.895]]),             // dihedral door leading edge
        curve([[0.05, 1.12], [-0.35, 1.168], [-0.72, 1.14]]),                          // roof cut of the dihedral door
        curve([[-0.88, 1.08], [-0.60, 0.93]])
      ],
      panelLines: [
        curve([[2.30, 0.39], [2.16, 0.50], [1.98, 0.585]]),
        curve([[-1.08, 1.05], [-1.50, 0.985], [-1.95, 0.93]]),
        rect(-1.25, 1.02, 0.08, 0.022)
      ],
      characterLines: [
        curve([[1.70, 0.70], [1.36, 0.78], [1.00, 0.818], [0.80, 0.845]]),
        curve([[0.30, 0.62], [-0.10, 0.685], [-0.55, 0.765], [-0.90, 0.82]]),          // scallop top lip
        curve([[0.30, 0.62], [-0.05, 0.53], [-0.50, 0.468], [-0.95, 0.45]]),           // scallop lower lip
        curve([[-1.00, 0.89], [-1.45, 0.895], [-1.95, 0.88], [-2.24, 0.875]])
      ],
      sill: Pth(0.93, 0.115).L(-0.93, 0.115).L(-0.96, 0.165).S([[-0.40, 0.185], [0.40, 0.185], [0.97, 0.165]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.026 },
      archR: { x: aR, y: rR, r: raR, flare: 0.032 },
      lowerTrim: [
        Pth(2.22, 0.10).S([[2.30, 0.125], [2.33, 0.13]]).L(2.325, 0.15).S([[2.12, 0.14], [1.93, 0.205]]).L(1.92, 0.18).S([[2.10, 0.12]]).Z(), // carbon lip
        Pth(-2.22, 0.52).S([[-2.05, 0.33], [-1.85, 0.20], [-1.70, 0.16]]).L(-1.71, 0.195).S([[-1.88, 0.24], [-2.05, 0.37], [-2.19, 0.535]]).Z(), // tall diffuser
        Pth(0.93, 0.115).L(-0.93, 0.115).L(-0.96, 0.165).S([[-0.40, 0.185], [0.40, 0.185], [0.97, 0.165]]).Z()
      ]
    };

    var top = {
      body: sym([[F, 0, 1], [2.32, 0.20], [2.30, 0.40], [2.20, 0.58], [2.10, 0.71], [2.00, 0.82], [1.85, 0.885], [1.70, 0.925],
        [1.30, hw - 0.008], [0.70, 0.905], [0.0, 0.84], [-0.60, 0.885], [-1.12, 0.955], [-1.45, hw], [-1.85, 0.955],
        [-2.15, 0.88], [-2.245, 0.70], [R, 0.35], [R, 0]], 1),
      greenhouse: sym([[0.78, 0], [0.76, 0.42], [0.45, 0.535], [0.0, 0.595], [-0.55, 0.60], [-1.00, 0.46], [-1.35, 0.25], [-1.60, 0]], 1),
      hood: sym([[2.20, 0], [2.12, 0.36], [1.85, 0.56], [1.20, 0.58], [0.85, 0.52], [0.80, 0]], 1),
      roof: sym([[0.05, 0], [0.02, 0.46], [-0.40, 0.52], [-0.78, 0.46], [-0.85, 0]], 1),
      deck: sym([[-1.30, 0], [-1.30, 0.40], [-1.60, 0.56], [-2.05, 0.56], [-2.20, 0.40], [-2.22, 0]], 1),
      mirrors: pair(loop([[0.58, 0.88], [0.55, 1.00], [0.47, 1.07], [0.40, 1.06], [0.42, 0.96], [0.50, 0.89]]), 1),
      characterLines: [].concat(pair(curve([[1.95, 0.70], [1.50, 0.77], [1.00, 0.76]]), 1),
        pair(curve([[-1.10, 0.80], [-1.60, 0.82], [-2.10, 0.74]]), 1))
    };

    var front = {
      body: sym([[0, H], [0.26, H - 0.007], [0.42, 1.15], [0.53, 1.05], [0.60, 0.97], [0.68, 0.895], [0.76, 0.855], [0.84, 0.83],
        [0.915, 0.74], [0.958, 0.60], [hw, 0.46], [0.965, 0.32], [0.93, 0.16], [0.86, 0.102, 1], [0, 0.10]], 0),
      greenhouse: sym([[0, 1.162], [0.24, 1.152], [0.35, 1.11], [0.52, 0.93, 1], [0.36, 0.88], [0, 0.875]], 0),
      bumper: sym([[0, 0.47], [0.50, 0.50], [0.93, 0.56, 1], [0.965, 0.32], [0.93, 0.16], [0.86, 0.102, 1], [0, 0.10]], 0),
      grille: [rrect(0, 0.34, 0.20, 0.08, 0.03)],                                      // small centre intake under the beak
      intakes: pair(loop([[0.48, 0.36, 1], [0.70, 0.42], [0.92, 0.46, 1], [0.935, 0.34], [0.91, 0.20], [0.80, 0.14, 1],
        [0.56, 0.15], [0.48, 0.22, 1]]), 0),
      // swoosh: top edge rising outward, lower edge hooking down at the inner end
      headlights: pair(loop([[0.50, 0.50, 1], [0.65, 0.572], [0.88, 0.64, 1], [0.895, 0.577], [0.75, 0.524], [0.60, 0.466],
        [0.52, 0.42], [0.47, 0.40, 1], [0.478, 0.45]]), 0),
      drl: [].concat(
        pair(loop([[0.52, 0.503, 1], [0.66, 0.566], [0.86, 0.626, 1], [0.862, 0.612], [0.66, 0.552], [0.525, 0.488, 1]]), 0),
        pair(loop([[0.53, 0.462, 1], [0.62, 0.502], [0.80, 0.564, 1], [0.80, 0.551], [0.62, 0.489], [0.535, 0.447], [0.49, 0.418, 1]]), 0)),
      splitter: sym([[0, 0.13], [0.86, 0.125, 1], [0.89, 0.10, 1], [0, 0.098]], 0),
      panelLines: [curve([[-0.70, 0.848], [-0.52, 0.775], [-0.28, 0.714], [0, 0.70], [0.28, 0.714], [0.52, 0.775], [0.70, 0.848]])],
      plateArea: rect(0, 0.215, 0.30, 0.075),
      badgeArea: rect(0, 0.42, 0.10, 0.03),
      badgeText: 'MCLAREN'
    };

    var tailOuter = [[0.12, 0.975, 1], [0.55, 0.975], [0.86, 0.968], [0.935, 0.90], [0.948, 0.75], [0.94, 0.60, 1]];
    var tailInner = [[0.915, 0.62, 1], [0.922, 0.75], [0.912, 0.88], [0.855, 0.946], [0.55, 0.952], [0.12, 0.952, 1]];
    var rear = {
      body: sym([[0, H], [0.28, H - 0.008], [0.46, 1.11], [0.54, 1.03], [0.60, 0.985], [0.70, 0.99], [0.80, 1.0],
        [0.90, 0.975], [0.952, 0.90], [hw, 0.68], [0.965, 0.42], [0.92, 0.27], [0.84, 0.18, 1], [0, 0.16]], 0),
      greenhouse: sym([[0, 1.12], [0.30, 1.11], [0.38, 1.04, 1], [0, 1.03]], 0),
      bumper: sym([[0, 0.45], [0.90, 0.47, 1], [0.96, 0.42], [0.92, 0.27], [0.84, 0.18, 1], [0, 0.16]], 0),
      taillights: pair(loop(tailOuter.concat(tailInner)), 0),
      diffuser: sym([[0, 0.45], [0.70, 0.45, 1], [0.86, 0.38], [0.84, 0.18, 1], [0, 0.16]], 0),
      exhaust: [{ shape: 'oval', cx: 0, cy: 0.66, w: 0.22, h: 0.115 }],
      panelLines: [curve([[-0.60, 0.99], [-0.30, 0.975], [0, 0.97], [0.30, 0.975], [0.60, 0.99]])],
      plateArea: rect(0, 0.515, 0.52, 0.11),
      badgeArea: rect(0, 0.93, 0.26, 0.022),
      badgeText: 'MCLAREN',
      spoiler: sym([[0, 1.03], [0.815, 1.03, 1], [0.815, 1.0, 1], [0, 1.0]], 0)      // retracted active wing
    };

    var details = [
      det('side', 'mirror', 'body', loop([[0.58, 0.93], [0.54, 0.995], [0.42, 1.015], [0.36, 0.98], [0.40, 0.94], [0.50, 0.93]])),
      det('side', 'trim', 'carbon', poly([[0.56, 0.91], [0.60, 0.91], [0.58, 0.935], [0.54, 0.935]])),
      det('side', 'trim', 'body', scallop),                                                  // body-colour concave teardrop
      det('side', 'trim', 'carbon', scallopLip),
      det('side', 'intake', 'black', mouth),
      det('side', 'vent', 'black', Pth(0.97, 0.66).S([[0.95, 0.56], [0.95, 0.46]]).L(0.92, 0.46).S([[0.92, 0.56], [0.93, 0.66]]).Z()),
      det('side', 'scoop', 'black', poly([[-0.22, 1.172], [-0.30, 1.186], [-0.30, 1.166], [-0.24, 1.158]])),  // roof snorkel mouth
      det('side', 'trim', 'light', Pth(2.30, 0.395).S([[2.19, 0.468], [2.07, 0.52]]).L(2.06, 0.50).S([[2.17, 0.448], [2.28, 0.38]]).Z()),
      det('side', 'trim', 'light-red', poly([[-2.235, 0.948], [-2.256, 0.92], [-2.255, 0.62], [-2.24, 0.62]])),
      det('side', 'spoiler', 'carbon', loop([[-1.95, 1.0, 1], [-2.26, 1.0, 1], [-2.278, 1.018], [-2.265, 1.032, 1], [-1.97, 1.03, 1]])),   // retracted wing plank
      det('side', 'spoiler', 'carbon', loop([[-2.02, 1.0, 1], [-2.235, 1.0, 1], [-2.25, 0.93, 1], [-2.06, 0.958, 1]])),                   // endplate
      det('side', 'chargePort', 'body', rect(-1.15, 0.98, 0.07, 0.03)),
      det('side', 'wiper', 'black', curve([[0.72, 0.885], [0.48, 0.97]])),
      det('top', 'scoop', 'black', sym([[-0.20, 0], [-0.24, 0.10, 1], [-0.75, 0.09], [-0.85, 0]], 1)),        // roof snorkel
      det('top', 'trim', 'body', sym([[-0.86, 0], [-0.88, 0.022, 1], [-1.55, 0.016, 1], [-1.62, 0]], 1)),      // canopy spine
      det('top', 'spoiler', 'carbon', sym([[-1.98, 0], [-1.98, 0.80, 1], [-2.22, 0.80, 1], [-2.22, 0]], 1)),
      det('top', 'wiper', 'black', curve([[0.72, -0.40], [0.62, 0.22]])),
      det('front', 'badge', 'body', rect(0, 0.42, 0.07, 0.025)),
      det('front', 'trim', 'body', sym([[0, 0.50], [0.25, 0.492], [0.45, 0.462, 1], [0.30, 0.435], [0.12, 0.408], [0, 0.40]], 0)),   // pointed beak
    ].concat(
      detPair('top', 'vent', 'black', loop([[1.60, 0.12, 1], [1.60, 0.42, 1], [1.10, 0.45, 1], [1.12, 0.10, 1]])),   // twin bonnet ducts by the screen
      detPair('top', 'vent', 'grille', rrect(-1.75, 0.32, 0.30, 0.18, 0.03)),                                          // twin engine-deck vents
      detPair('front', 'intake', 'grille', loop([[0.50, 0.355, 1], [0.70, 0.405], [0.905, 0.443, 1], [0.918, 0.34], [0.895, 0.21],
        [0.795, 0.158, 1], [0.565, 0.167], [0.50, 0.228, 1]])),
      slats('front', 0.57, 0.85, 4, 0.36, 0.19, 'gloss-black'),
      [det('rear', 'vent', 'grille', ring(sym([[0, 0.93], [0.88, 0.93, 1], [0.90, 0.62], [0.80, 0.46, 1], [0, 0.46]], 0),
        rrect(0, 0.66, 0.25, 0.14, 0.05)))],                                                                             // open rear mesh
      [det('rear', 'trim', 'chrome', ring(rrect(0, 0.66, 0.25, 0.14, 0.05), rrect(0, 0.66, 0.232, 0.122, 0.044)))],   // thin bright rim
      [det('rear', 'spoiler', 'carbon', rear.spoiler)],                                                                   // carbon wing plank
      detPair('rear', 'spoiler', 'carbon', rect(0.80, 0.965, 0.03, 0.13)),                                             // wing endplates
      slats('rear', 0.06, 0.66, 6, 0.44, 0.17, 'carbon')
    );

    var m = {
      id: 'mclaren-p1', make: 'McLaren', name: 'P1', gen: 'P12', years: '2013–2015',
      look: { head: 'slim-led', tail: 'full-width', grille: 'mesh' },   // renderer lamp / grille signature
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'hybrid',
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.658, trackR: 1.604, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 19, wheelDiameterR_in: 20, tireF: '245/35R19', tireR: '315/30R20', groundClearance: 0.100, rideHeight: 0.115,
        cd: 0.34, curbWeight_kg: 1490 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Speedmark swoosh lamps — top edge rising outward, lower edge hooking down at the inner end — with twin LED strips, above huge side intakes',
        taillights: 'Thin C-shaped LED strip tracing the top and sides of the tail, framing an open mesh rear; retracted wing across the top',
        grille: 'Body-colour beak dipping between two big side intakes, tiny centre intake below',
        notes: 'Teardrop bubble canopy with a roof snorkel and central spine, dihedral doors with a long concave scallop feeding the side radiators, twin bonnet ducts by the screen, active rear wing, single central high exhaust, tall diffuser'
      }
    };
    m.sections = buildSections(m, [
      [2.325, 0.010, 0.22, 0.025, 0.14, 0.035, 0.07, 0.035, 0],
      [2.20, 0.000, 0.52, 0.050, 0.36, 0.080, 0.18, 0.085, 0],
      [1.95, 0.000, 0.70, 0.080, 0.50, 0.115, 0.25, 0.125, 0],
      [1.55, 0.000, 0.78, 0.090, 0.56, 0.125, 0.28, 0.135, 0],
      [1.10, 0.000, 0.78, 0.075, 0.58, 0.100, 0.30, 0.110, 0],
      [0.88, 0.000, 0.78, 0.050, 0.60, 0.065, 0.30, 0.070, 0],
      [0.74, 0.020, 0.76, 0.010, 0.66, 0.000, 0.54, 0.030, 1],
      [0.40, 0.140, 0.78, 0.100, 0.66, 0.020, 0.56, 0.000, 1],
      [0.00, 0.270, 0.74, 0.210, 0.66, 0.035, 0.54, 0.000, 1],
      [-0.40, 0.280, 0.76, 0.215, 0.66, 0.035, 0.54, 0.000, 1],
      [-0.80, 0.200, 0.78, 0.140, 0.62, 0.030, 0.46, 0.000, 1],
      [-1.10, 0.120, 0.80, 0.090, 0.56, 0.040, 0.32, 0.000, 0],
      [-1.40, 0.050, 0.80, 0.050, 0.50, 0.030, 0.22, 0.000, 0],
      [-1.70, 0.000, 0.80, 0.030, 0.55, 0.050, 0.30, 0.050, 0],
      [-2.10, 0.000, 0.74, 0.030, 0.52, 0.050, 0.28, 0.055, 0],
      [-2.25, 0.000, 0.62, 0.020, 0.45, 0.030, 0.25, 0.035, 0]
    ], { ridges: [{ type: 'snorkel', x0: -0.20, x1: -0.85, h: 0.025, ease: 0.08 }] });
    m.wheel = { spokes: 10, style: 'split', finish: '#3a3c40', caliper: '#1e1f22' };  // super-lightweight 10-spoke
    return m;
  }

  /* ================================================================== BUGATTI CHIRON */
  function chiron() {
    var L = 4.544, W = 2.038, H = 1.212, WB = 2.711, FO = 1.000, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.3555, R -2.1885
    var rF = tireRadius(285, 30, 20), rR = tireRadius(355, 25, 21);         // 0.3395, 0.3555
    var raF = rF + 0.033, raR = rR + 0.033;

    // bluff, near-vertical horseshoe face, long gently rising bonnet, high roof, flat deck, tail leaning in
    var body = Pth(2.25, 0.112)
      .L(2.33, 0.13)
      .S([[2.343, 0.24], [2.33, 0.38], [2.25, 0.56], [2.10, 0.66], [1.85, 0.735], [1.62, 0.788], [1.40, 0.832],
        [1.15, 0.878], [0.82, 0.93]])                                                        // raked horseshoe face, low bonnet
      .S([[0.45, 1.06], [0.10, 1.168], [-0.25, H], [-0.62, 1.194], [-0.95, 1.142], [-1.35, 1.082],
        [-1.75, 1.046], [-2.10, 1.036], [R, 1.03, 1]])
      .S([[-2.18, 0.95], [-2.182, 0.85], [-2.17, 0.70], [-2.13, 0.50], [-2.06, 0.34], [-1.95, 0.28]])
      .arch(aR, rR, raR, 0.28, 0.18)
      .L(-0.95, 0.125).L(0.95, 0.125)
      .arch(aF, rF, raF, 0.18, 0.27)
      .S([[1.98, 0.20], [2.16, 0.135], [2.25, 0.112]]).Z();
    var greenhouse = Pth(0.82, 0.93)
      .S([[0.45, 1.055], [0.10, 1.160], [-0.25, 1.203], [-0.52, 1.192]])
      .S([[-0.60, 1.10], [-0.64, 0.99]])
      .S([[-0.30, 0.975], [0.30, 0.948], [0.82, 0.93]]).Z();
    var sideGlass = Pth(0.66, 0.958)
      .S([[0.35, 1.06], [0.02, 1.150], [-0.28, 1.186], [-0.48, 1.176], [-0.56, 1.10]])
      .S([[-0.58, 1.0]])
      .S([[-0.30, 0.985], [0.10, 0.972], [0.66, 0.958]]).Z();
    var aPillar = Pth(0.82, 0.93).S([[0.45, 1.055], [0.10, 1.160], [-0.04, 1.180]])
      .L(-0.01, 1.155).S([[0.35, 1.06], [0.66, 0.958]]).Z();

    // the C-line: from the roof behind the glass, round a deep rear bow, then forward low along the door
    // upper end sweeps over the B-pillar into the roof edge; lower leg tapers to a point along the door
    var cOuter = [[-0.10, 1.17, 1], [-0.35, 1.196], [-0.62, 1.184], [-0.90, 1.13], [-1.12, 0.98], [-1.225, 0.78], [-1.17, 0.58],
      [-0.98, 0.44], [-0.55, 0.37], [0.0, 0.348], [0.45, 0.36, 1]];
    var cInner = [[0.45, 0.37, 1], [0.20, 0.38], [0.0, 0.39], [-0.52, 0.42], [-0.92, 0.49], [-1.115, 0.61], [-1.175, 0.78],
      [-1.075, 0.95], [-0.87, 1.085], [-0.62, 1.142], [-0.35, 1.166]];
    var cLine = loop(cOuter.concat(cInner));

    var side = {
      body: body, greenhouse: greenhouse, windows: [sideGlass], pillars: [aPillar],
      doorCuts: [
        curve([[0.98, 0.43], [0.95, 0.60], [0.84, 0.88], [0.74, 0.955]]),
        curve([[-0.56, 1.06], [-0.55, 0.85], [-0.56, 0.60], [-0.58, 0.43]])
      ],
      panelLines: [
        curve([[2.27, 0.53], [2.18, 0.60], [2.05, 0.655]]),                          // bonnet leading edge
        curve([[-1.20, 1.10], [-1.60, 1.058], [-2.00, 1.040], [-2.16, 1.034]]),
        curve([[-1.25, 0.98], [-1.30, 0.80], [-1.32, 0.62]])                         // rear quarter panel seam
      ],
      characterLines: [
        curve([[1.80, 0.722], [1.45, 0.80], [1.10, 0.86], [0.86, 0.905]]),
        curve([[-1.25, 0.99], [-1.60, 0.995], [-1.95, 0.99], [-2.17, 0.985]])
      ],
      sill: Pth(0.95, 0.125).L(-0.95, 0.125).L(-0.98, 0.18).S([[-0.40, 0.20], [0.40, 0.20], [0.99, 0.18]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.03 },
      archR: { x: aR, y: rR, r: raR, flare: 0.036 },
      lowerTrim: [
        Pth(2.25, 0.112).L(2.33, 0.13).L(2.335, 0.155).S([[2.17, 0.16], [1.99, 0.225]]).L(1.98, 0.20).S([[2.16, 0.135]]).Z(),
        Pth(-1.95, 0.28).S([[-2.06, 0.34], [-2.13, 0.50]]).L(-2.09, 0.51).S([[-2.02, 0.36], [-1.92, 0.30]]).L(-1.73, 0.30).L(-1.736, 0.28).Z(),
        Pth(0.95, 0.125).L(-0.95, 0.125).L(-0.98, 0.18).S([[-0.40, 0.20], [0.40, 0.20], [0.99, 0.18]]).Z()
      ]
    };

    var top = {
      body: sym([[F, 0], [2.352, 0.20], [2.34, 0.40], [2.29, 0.60], [2.15, 0.80], [1.88, 0.95], [1.40, hw - 0.012], [0.80, 0.982],
        [0.20, 0.965], [-0.50, 0.985], [-1.12, hw], [-1.50, 1.012], [-1.80, 0.975], [-1.98, 0.90], [-2.10, 0.80], [-2.17, 0.62], [R, 0.35], [R, 0]], 1),
      greenhouse: sym([[0.84, 0], [0.82, 0.58], [0.45, 0.70], [-0.20, 0.72], [-0.55, 0.64], [-0.68, 0.45], [-0.72, 0]], 1),
      hood: sym([[2.28, 0], [2.20, 0.40], [1.95, 0.60], [1.30, 0.62], [0.95, 0.58], [0.90, 0]], 1),
      roof: sym([[0.05, 0], [0.03, 0.56], [-0.30, 0.62], [-0.55, 0.54], [-0.62, 0]], 1),
      deck: sym([[-1.15, 0], [-1.15, 0.48], [-1.45, 0.60], [-1.84, 0.62], [-1.84, 0]], 1),
      mirrors: pair(loop([[0.64, 0.93], [0.60, 1.05], [0.52, 1.115], [0.45, 1.105], [0.47, 1.01], [0.55, 0.94]]), 1),
      characterLines: [].concat(pair(curve([[2.05, 0.72], [1.60, 0.80], [1.10, 0.80]]), 1),
        pair(curve([[-1.10, 0.83], [-1.60, 0.85], [-2.05, 0.78]]), 1))
    };

    var horseshoe = sym([[0, 0.64], [0.14, 0.632], [0.205, 0.585], [0.22, 0.46], [0.205, 0.33], [0.16, 0.25, 1], [0, 0.24]], 0);
    var front = {
      body: sym([[0, H], [0.28, H - 0.007], [0.50, 1.15], [0.62, 0.99], [0.70, 0.945], [0.80, 0.905], [0.88, 0.88],
        [0.955, 0.79], [0.995, 0.64], [hw, 0.48], [1.01, 0.34], [0.97, 0.18], [0.90, 0.112, 1], [0, 0.11]], 0),
      greenhouse: sym([[0, 1.175], [0.42, 1.16], [0.62, 0.97, 1], [0.40, 0.935], [0, 0.93]], 0),
      bumper: sym([[0, 0.66], [0.50, 0.672], [0.95, 0.70, 1], [1.01, 0.34], [0.97, 0.18], [0.90, 0.112, 1], [0, 0.11]], 0),
      grille: [horseshoe, sym([[0, 0.215], [0.17, 0.212, 1], [0.19, 0.16, 1], [0, 0.155]], 0)],
      intakes: pair(loop([[0.32, 0.55, 1], [0.62, 0.53], [0.94, 0.50, 1], [0.935, 0.36], [0.91, 0.25], [0.86, 0.17, 1], [0.50, 0.17], [0.32, 0.19, 1]]), 0),
      headlights: pair(rrect(0.75, 0.62, 0.34, 0.07, 0.03), 0),
      drl: [].concat(pair(ellipse(0.630, 0.62, 0.022, 0.022), 0), pair(ellipse(0.710, 0.62, 0.022, 0.022), 0),
        pair(ellipse(0.790, 0.62, 0.022, 0.022), 0), pair(ellipse(0.870, 0.62, 0.022, 0.022), 0)),   // quad LED projectors
      splitter: sym([[0, 0.14], [0.92, 0.13, 1], [0.95, 0.11, 1], [0, 0.108]], 0),
      panelLines: [
        curve([[-0.72, 0.89], [-0.52, 0.82], [-0.30, 0.775], [0, 0.765], [0.30, 0.775], [0.52, 0.82], [0.72, 0.89]]),  // bonnet edge between the wing domes
        curve([[0.015, 0.655], [0.012, 0.78], [0.008, 0.90]]), curve([[-0.015, 0.655], [-0.012, 0.78], [-0.008, 0.90]])  // centre ridge
      ],
      plateArea: rect(0, 0.19, 0.30, 0.07),
      badgeArea: rect(0, 0.585, 0.10, 0.05),
      badgeText: 'BUGATTI'
    };

    var bar = sym([[0, 0.955], [0.87, 0.955, 1], [0.90, 0.94, 1], [0.87, 0.925, 1], [0, 0.925]], 0);
    var rear = {
      body: sym([[0, H], [0.28, H - 0.007], [0.46, 1.15], [0.54, 1.08], [0.60, 1.05], [0.70, 1.062], [0.82, 1.072],
        [0.93, 1.05], [0.995, 0.95], [hw, 0.72], [1.005, 0.45], [0.96, 0.28], [0.88, 0.20, 1], [0, 0.17]], 0),
      greenhouse: sym([[0, 1.15], [0.28, 1.14], [0.36, 1.07, 1], [0, 1.06]], 0),
      bumper: sym([[0, 0.40], [0.98, 0.45, 1], [1.005, 0.45], [0.96, 0.28], [0.88, 0.20, 1], [0, 0.17]], 0),
      taillights: [bar],
      lightBar: bar,
      diffuser: sym([[0, 0.38], [0.70, 0.38, 1], [0.86, 0.32], [0.84, 0.20, 1], [0, 0.17]], 0),
      exhaust: [{ shape: 'trapezoid', cx: 0.075, cy: 0.55, w: 0.12, h: 0.08 }, { shape: 'trapezoid', cx: -0.075, cy: 0.55, w: 0.12, h: 0.08 },
        { shape: 'trapezoid', cx: 0.225, cy: 0.55, w: 0.12, h: 0.08 }, { shape: 'trapezoid', cx: -0.225, cy: 0.55, w: 0.12, h: 0.08 }],
      panelLines: [curve([[-0.60, 1.05], [-0.30, 1.03], [0, 1.025], [0.30, 1.03], [0.60, 1.05]])],
      plateArea: rect(0, 0.305, 0.52, 0.11),
      badgeArea: rect(0, 0.985, 0.36, 0.03),
      badgeText: 'BUGATTI',
      spoiler: sym([[0, 1.04], [0.88, 1.04, 1], [0.88, 1.0, 1], [0, 1.0]], 0)
    };

    var details = [
      det('side', 'trim', 'chrome', cLine),
      det('side', 'intake', 'black', loop([[-0.64, 1.14, 1], [-0.86, 1.07], [-1.03, 0.93], [-1.11, 0.77], [-1.06, 0.60],
        [-0.92, 0.50, 1], [-0.80, 0.62], [-0.73, 0.85], [-0.68, 1.02]])),
      det('side', 'mirror', 'body', loop([[0.62, 0.98], [0.58, 1.045], [0.46, 1.065], [0.40, 1.03], [0.44, 0.99], [0.54, 0.98]])),
      det('side', 'trim', 'black', poly([[0.60, 0.96], [0.64, 0.96], [0.62, 0.985], [0.58, 0.985]])),
      det('side', 'vent', 'black', Pth(0.99, 0.66).S([[0.96, 0.56], [0.955, 0.46]]).L(0.92, 0.46).S([[0.925, 0.56], [0.95, 0.68]]).Z()),
      det('side', 'trim', 'light', Pth(2.235, 0.568).S([[2.18, 0.607], [2.10, 0.645]]).L(2.095, 0.622).S([[2.17, 0.582], [2.245, 0.542]]).Z()),
      det('side', 'trim', 'light-red', poly([[-2.176, 0.955], [-2.185, 0.955], [-2.184, 0.925], [-2.177, 0.925]])),
      det('side', 'spoiler', 'carbon', loop([[-1.86, 1.05, 1], [-2.15, 1.042, 1], [-2.16, 1.026, 1], [-1.86, 1.032, 1]])),   // wing plank
      det('side', 'trim', 'glass', poly([[-1.18, 1.100], [-1.83, 1.040], [-1.83, 1.032], [-1.18, 1.090]])),   // engine-cover glass edge
      det('side', 'wiper', 'black', curve([[0.80, 0.94], [0.56, 1.02]])),
      det('top', 'trim', 'body', sym([[0.30, 0], [0.20, 0.018, 1], [-2.0, 0.018, 1], [-2.05, 0]], 1)),        // central dorsal fin
      det('top', 'trim', 'carbon', sym([[-1.86, 0], [-1.86, 0.84, 1], [-2.10, 0.74, 1], [-2.12, 0]], 1)),     // retracted wing
      det('top', 'wiper', 'black', curve([[0.80, -0.45], [0.70, 0.24]])),
      det('front', 'trim', 'chrome', ring(sym([[0, 0.658], [0.15, 0.65], [0.222, 0.595], [0.238, 0.46], [0.222, 0.32], [0.172, 0.232, 1], [0, 0.222]], 0), horseshoe)),
      det('front', 'badge', 'chrome', ellipse(0, 0.585, 0.04, 0.022)),
      det('rear', 'vent', 'grille', ring(sym([[0, 0.89], [0.90, 0.89, 1], [0.98, 0.80], [0.96, 0.45], [0.80, 0.38, 1], [0, 0.38]], 0),
        rrect(0, 0.55, 0.62, 0.15, 0.04))),
      det('rear', 'trim', 'chrome', ring(rrect(0, 0.55, 0.62, 0.15, 0.04), rrect(0, 0.55, 0.59, 0.12, 0.03))),   // bright exhaust surround
      det('rear', 'trim', 'black', [-0.225, -0.075, 0.075, 0.225].reduce(function (o, cx) {               // dark housing, holes for the tips
        return o.concat(reversePath(rrect(cx, 0.55, 0.13, 0.09, 0.025)));
      }, rrect(0, 0.55, 0.59, 0.12, 0.03)))
    ].concat(
      [det('rear', 'spoiler', 'carbon', rear.spoiler)],                                                       // carbon wing plank
      detPair('top', 'trim', 'glass', rrect(-1.51, 0.13, 0.66, 0.21, 0.05)),                                  // tinted engine-cover window, split by the fin
      detPair('front', 'intake', 'grille', loop([[0.335, 0.535, 1], [0.62, 0.515], [0.92, 0.487, 1], [0.915, 0.36], [0.89, 0.26], [0.85, 0.188, 1], [0.50, 0.188], [0.335, 0.205, 1]])),
      slats('front', 0.42, 0.82, 4, 0.49, 0.20, 'gloss-black'),
      slats('front', 0.04, 0.16, 3, 0.60, 0.28, 'chrome'),
      slats('rear', 0.12, 0.68, 6, 0.36, 0.19, 'carbon'),
      // chrome tip rims
      [0.075, 0.225].reduce(function (a, cx) { return a.concat(detPair('rear', 'trim', 'chrome', ring(rrect(cx, 0.55, 0.13, 0.09, 0.025), rrect(cx, 0.55, 0.11, 0.07, 0.02)))); }, [])
    );

    var m = {
      id: 'bugatti-chiron', make: 'Bugatti', name: 'Chiron', gen: '', years: '2016–2022',
      look: { head: 'slim-led', tail: 'full-width', grille: 'horseshoe' },   // renderer lamp / grille signature
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'awd', powertrain: 'ice',
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.748, trackR: 1.666, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 20, wheelDiameterR_in: 21, tireF: '285/30R20', tireR: '355/25R21', groundClearance: 0.110, rideHeight: 0.125,
        cd: 0.36, curbWeight_kg: 1995 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Flat horizontal housings with four round LED projectors in a row',
        taillights: 'Single thin full-width LED light bar under the wing plank, above a huge mesh tail and quad centre tailpipes in a bright surround',
        grille: 'Upright chrome-framed horseshoe grille with vertical bars and a body-colour centre ridge above it, big upright side intakes, small lower centre intake',
        notes: 'Raked horseshoe nose, signature polished C-line sweeping from the roof edge over the B-pillar round a deep bow and tapering forward along the door around the side air intake; central dorsal fin splitting a tinted engine-cover window; retractable rear wing'
      }
    };
    m.sections = buildSections(m, [
      [2.35, 0.020, 0.40, 0.050, 0.28, 0.060, 0.12, 0.060, 0],
      [2.25, 0.000, 0.64, 0.050, 0.44, 0.075, 0.22, 0.080, 0],
      [2.00, 0.000, 0.74, 0.070, 0.52, 0.100, 0.26, 0.105, 0],
      [1.55, 0.000, 0.80, 0.080, 0.58, 0.110, 0.30, 0.115, 0],
      [1.15, 0.000, 0.80, 0.070, 0.60, 0.095, 0.30, 0.100, 0],
      [0.95, 0.000, 0.80, 0.050, 0.62, 0.065, 0.32, 0.070, 0],
      [0.82, 0.020, 0.80, 0.010, 0.70, 0.000, 0.58, 0.030, 1],
      [0.40, 0.140, 0.82, 0.110, 0.70, 0.020, 0.60, 0.000, 1],
      [0.00, 0.260, 0.80, 0.215, 0.70, 0.035, 0.58, 0.000, 1],
      [-0.40, 0.270, 0.80, 0.220, 0.70, 0.035, 0.58, 0.000, 1],
      [-0.65, 0.200, 0.82, 0.150, 0.68, 0.030, 0.50, 0.000, 1],
      [-0.95, 0.090, 0.84, 0.070, 0.62, 0.050, 0.35, 0.040, 0],
      [-1.30, 0.000, 0.84, 0.030, 0.62, 0.060, 0.35, 0.065, 0],
      [-1.80, 0.000, 0.82, 0.030, 0.60, 0.060, 0.33, 0.065, 0],
      [-2.10, 0.000, 0.76, 0.030, 0.55, 0.050, 0.30, 0.055, 0],
      [-2.18, 0.000, 0.66, 0.020, 0.46, 0.030, 0.25, 0.035, 0]
    ], { ridges: [{ type: 'fin', x0: 0.75, x1: -2.0, h: 0.025, ease: 0.12 }] });
    m.wheel = { spokes: 5, style: 'twin', finish: '#c8ccd0', rimFinish: '#c8ccd0', caliper: '#2c5aa0' };  // bright twin-5-spoke
    return m;
  }

  var list = [sf90(), p1(), chiron()];
  list.forEach(register);
  if (typeof module !== 'undefined' && module.exports) module.exports = list;
})();

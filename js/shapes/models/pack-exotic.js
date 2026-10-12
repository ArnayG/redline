/* FORGE Atelier — CB.shapes model pack "euro exotic".
   Lamborghini Huracán EVO, Ferrari 296 GTB, Koenigsegg Jesko, Audi R8 V10 2nd gen (Type 4S) (style 'hypercar'),
   Porsche 918 Spyder ('roadster'), drawn at their real published dimensions. None of them is a style default.
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
  /** exhaust-style trapezoid (wider at the top, rounded corners) centred on (cx,cy) */
  function trap(cx, cy, w, h) {
    var a = w / 2, b = w / 2 - h * 0.18, c = Math.min(0.012, h / 4);
    return loop([[cx - a + c, cy + h / 2, 1], [cx + a - c, cy + h / 2, 1], [cx + a, cy + h / 2 - c, 1], [cx + b, cy - h / 2 + c, 1],
      [cx + b - c, cy - h / 2, 1], [cx - b + c, cy - h / 2, 1], [cx - b, cy - h / 2 + c, 1], [cx - a, cy + h / 2 - c, 1]]);
  }
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
    var sb = flat(o.profile || m.side.body, 16), tb = flat(m.top.body, 16), win = [];
    var SCR = o.screen || [0.15, 0.72];
    (m.side.windows || []).forEach(function (w) { win = win.concat(flat(w, 16)); });
    var roofX = [Infinity, -Infinity];
    flat(o.roof || m.top.roof, 8).forEach(function (p) { p.forEach(function (q) { roofX[0] = Math.min(roofX[0], q[0]); roofX[1] = Math.max(roofX[1], q[0]); }); });
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
      var sec = { x: r4(x), ring: ring, belt: null, glass: fl };
      if (o.paints) {                                                // per-vertex paint zones by half-ring index
        var ph = H.map(function (q, j) {
          var pp = 'body';
          o.paints.forEach(function (Z) { if (j >= Z.j0 && j <= Z.j1 && x <= Z.x0 && x >= Z.x1) pp = Z.paint; });
          return pp;
        });
        for (var m2 = H.length - 2; m2 >= 1; m2--) ph.push(ph[m2]);
        sec.paint = ph;
      }
      out.push(sec);
      return sec;
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
        if (j >= IDX_K7 + 1 && x > SCR[0] && x < SCR[1]) return 1;      // one wide windscreen panel
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
    if (o.crispTail) crispTail(out, sb, tb, XR, o.crispTail);
    return out;
  }
  /* Explicit tail sections: over the last `span` metres every ring is rebuilt from the last full ring (at XR + span)
     clipped to the side silhouette and the plan outline at its station (the visual hull of the two views), with a
     3 cm fillet on the tail-panel edge. Keeps a flat tail panel, a crisp deck edge and crisp plan corners instead of
     the ellipsoidal tail the smooth closing rings give. */
  function crispTail(out, sb, tb, XR, span) {
    var ref = null;
    out.forEach(function (s) { if (s.x >= XR + span && (!ref || s.x < ref.x)) ref = s; });
    if (!ref) return;
    out.forEach(function (s) {
      if (s.x >= ref.x) return;
      var sl = sliceX(sb, s.x), tw = sliceX(tb, s.x);
      if (!sl || !tw) return;
      var d = s.x - XR, FR = 0.03, ins = d < FR ? FR - Math.sqrt(FR * FR - (FR - d) * (FR - d)) : 0;
      var w = Math.max(0.02, Math.max(Math.abs(tw[0]), Math.abs(tw[1])) - 0.002 - ins), lo = sl[0] + 0.002, hi = Math.max(lo + 0.02, sl[1] - 0.002 - 0.6 * ins);
      s.ring = ref.ring.map(function (q) { return [r4(Math.max(lo, Math.min(hi, q[0]))), r4(Math.max(-w, Math.min(w, q[1])))]; });
      s.glass = s.ring.map(function () { return 0; });
      if (ref.paint) s.paint = ref.paint.slice();
      s.belt = null;
    });
    // flat rear face: two rings shrinking onto the panel centroid just behind the last ring, so the end cap is
    // tiny and the tail panel shades as one flat face (a full-size centroid fan smears the edge normals into an X)
    var e = out[0], cy = 0, cz = 0;
    e.ring.forEach(function (q) { cy += q[0]; cz += q[1]; }); cy /= e.ring.length; cz /= e.ring.length;
    [[0.0003, 0.35], [0.0012, 0.82]].forEach(function (f) {
      if (XR + f[0] >= e.x - 1e-4) return;
      var s2 = { x: r4(XR + f[0]), ring: e.ring.map(function (q) { return [r4(cy + (q[0] - cy) * f[1]), r4(cz + (q[1] - cz) * f[1])]; }),
        belt: null, glass: e.ring.map(function () { return 0; }) };
      if (e.paint) s2.paint = e.paint.slice();
      out.splice(out.indexOf(e), 0, s2);
    });
  }

  /* ================================================================== LAMBORGHINI HURACÁN EVO */
  /* 4520 × 1933 × 1165 mm, wheelbase 2620, track 1668/1620, 245/30R20 · 305/30R20. One unbroken "Linea" arc from
     the pointed nose over the windscreen and roof down the louvred engine cover to a ducktail lip; hexagonal side
     glass with a sharp kink; Y-graphic headlamps and tail lamps; huge trapezoid front intakes with the EVO blade;
     twin high-mounted exhausts in a full-width hexagon mesh. */
  function huracan() {
    var L = 4.520, W = 1.933, H = 1.165, WB = 2.620, FO = 1.050, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.36, R -2.16
    var rF = tireRadius(245, 30, 20), rR = tireRadius(305, 30, 20);         // 0.3275, 0.3455
    var raF = rF + 0.032, raR = rR + 0.033;

    /* ---- side ---- */
    var body = Pth(2.24, 0.110)
      .L(2.30, 0.125)
      .S([[2.34, 0.16], [F, 0.215, 1]])                                                    // splitter lip → lower face
      .S([[F - 0.004, 0.28], [F - 0.012, 0.335, 1]])                                       // pointed nose crease
      .S([[2.30, 0.425], [2.20, 0.50], [2.00, 0.585], [1.70, 0.672], [1.40, 0.733], [1.10, 0.783], [0.85, 0.823]]) // wedge bonnet
      .S([[0.50, 0.948], [0.15, 1.085], [-0.25, H], [-0.65, 1.142], [-0.98, 1.098], [-1.30, 1.050], [-1.62, 1.010],
        [-1.90, 0.986], [-2.08, 0.976], [R, 0.99, 1]])                                     // the single "Linea" arc → ducktail
      .S([[-2.125, 0.93], [-2.12, 0.84], [-2.14, 0.66], [-2.155, 0.52, 1]])                 // short tail face under the lip
      .S([[-2.12, 0.37], [-2.02, 0.255], [-1.86, 0.185], [-1.72, 0.165]])                   // diffuser kick
      .arch(aR, rR, raR, 0.165, 0.17)
      .L(-0.93, 0.125).L(0.93, 0.125)
      .arch(aF, rF, raF, 0.17, 0.24)
      .S([[1.85, 0.20], [2.10, 0.14], [2.24, 0.110]]).Z();
    var greenhouse = Pth(0.85, 0.823)
      .S([[0.50, 0.944], [0.15, 1.078], [-0.25, 1.155], [-0.65, 1.130], [-0.98, 1.084], [-1.18, 1.052, 1]])
      .S([[-0.88, 1.0], [-0.54, 0.932, 1]])                                                // the hexagon kink
      .S([[0.0, 0.896], [0.50, 0.862], [0.85, 0.823]]).Z();
    var doorGlass = Pth(0.66, 0.872).S([[0.35, 0.975], [0.0, 1.092], [-0.30, 1.140], [-0.47, 1.138, 1]])
      .S([[-0.49, 1.03], [-0.47, 0.938, 1]]).S([[0.0, 0.906], [0.66, 0.872]]).Z();
    var quarter = Pth(-0.56, 1.130).S([[-0.84, 1.092], [-1.10, 1.054, 1]])
      .S([[-0.85, 1.006], [-0.585, 0.950, 1]]).S([[-0.59, 1.04], [-0.56, 1.130]]).Z();
    var aPillar = Pth(0.85, 0.823).S([[0.50, 0.944], [0.15, 1.078], [-0.02, 1.118]])
      .L(0.0, 1.094).S([[0.35, 0.975], [0.66, 0.872]]).Z();
    var intake = Pth(-0.47, 0.800).L(-1.00, 0.838).S([[-1.03, 0.74], [-0.975, 0.60, 1]]).S([[-0.74, 0.632], [-0.47, 0.682, 1]]).Z();

    var side = {
      body: body, greenhouse: greenhouse, windows: [doorGlass, quarter], pillars: [aPillar],
      doorCuts: [
        curve([[0.95, 0.24], [0.935, 0.52], [0.89, 0.74], [0.80, 0.852]]),
        curve([[-0.49, 0.935], [-0.44, 0.70], [-0.42, 0.45], [-0.42, 0.22]]),
        curve([[0.95, 0.24], [0.30, 0.215], [-0.42, 0.22]])
      ],
      panelLines: [
        curve([[2.335, 0.395], [2.21, 0.488], [2.06, 0.553]]),                            // front lid / bumper seam
        curve([[-1.18, 1.050], [-1.60, 1.002], [-2.05, 0.968]]),                           // engine cover
        curve([[2.15, 0.36], [2.05, 0.30], [1.85, 0.26]])                                  // bumper / wing seam
      ],
      characterLines: [
        curve([[1.03, 0.50], [0.60, 0.53], [0.10, 0.58], [-0.42, 0.66]]),                 // the low rising door blade
        curve([[1.95, 0.615], [1.55, 0.705], [1.15, 0.768], [0.90, 0.80]]),                // front wing crest
        curve([[-0.98, 0.862], [-1.40, 0.900], [-1.90, 0.920], [-2.12, 0.922]])            // rear haunch
      ],
      sill: Pth(0.93, 0.125).L(-0.93, 0.125).L(-0.95, 0.17).S([[-0.40, 0.20], [0.40, 0.20], [0.97, 0.17]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.026 },
      archR: { x: aR, y: rR, r: raR, flare: 0.032 },
      lowerTrim: [
        Pth(2.24, 0.110).L(2.30, 0.125).L(2.33, 0.15).S([[2.12, 0.16], [1.90, 0.215]]).L(1.88, 0.195).S([[2.10, 0.14]]).Z(),
        Pth(-2.13, 0.38).S([[-2.02, 0.25], [-1.85, 0.18]]).L(-1.86, 0.215).S([[-2.00, 0.27], [-2.10, 0.39]]).Z(),
        Pth(0.93, 0.125).L(-0.93, 0.125).L(-0.95, 0.17).S([[-0.40, 0.20], [0.40, 0.20], [0.97, 0.17]]).Z()
      ]
    };

    /* ---- top ---- */
    var top = {
      body: sym([[F, 0, 1], [2.348, 0.19], [2.31, 0.42], [2.22, 0.61], [2.05, 0.79], [1.80, 0.915], [1.52, 0.958], [1.31, hw],
        [1.00, 0.955], [0.60, 0.925], [0.20, 0.905], [-0.30, 0.915], [-0.80, 0.948], [-1.31, hw], [-1.70, 0.955],
        [-2.00, 0.905], [-2.12, 0.78], [-2.152, 0.55], [R, 0.28], [R, 0]], 1),
      greenhouse: sym([[0.85, 0], [0.83, 0.60], [0.50, 0.68], [-0.25, 0.672], [-0.75, 0.58], [-1.10, 0.42], [-1.20, 0]], 1),
      hood: sym([[2.30, 0], [2.24, 0.38], [2.02, 0.55], [1.50, 0.60], [1.05, 0.58], [0.92, 0]], 1),
      roof: sym([[0.10, 0], [0.08, 0.56], [-0.30, 0.62], [-0.70, 0.54], [-0.78, 0]], 1),
      deck: sym([[-1.18, 0], [-1.19, 0.40], [-1.45, 0.58], [-1.95, 0.62], [-2.10, 0.50], [-2.13, 0]], 1),
      mirrors: pair(loop([[0.60, 0.88], [0.56, 1.00], [0.48, 1.07], [0.41, 1.06], [0.43, 0.96], [0.50, 0.89]]), 1),
      characterLines: [].concat(pair(curve([[2.00, 0.72], [1.60, 0.80], [1.10, 0.79], [0.88, 0.76]]), 1),
        pair(curve([[-1.10, 0.80], [-1.60, 0.84], [-2.05, 0.78]]), 1))
    };

    /* ---- front (z,y) ---- */
    var front = {
      body: sym([[0, H], [0.32, H - 0.008], [0.50, 1.115], [0.62, 0.96], [0.68, 0.895], [0.76, 0.835], [0.86, 0.795],
        [0.925, 0.70], [0.955, 0.58], [hw, 0.45], [0.96, 0.30], [0.93, 0.17], [0.87, 0.112, 1], [0, 0.110]], 0),
      greenhouse: sym([[0, 1.13], [0.42, 1.115], [0.64, 0.875, 1], [0.40, 0.852], [0, 0.848]], 0),
      bumper: sym([[0, 0.40], [0.50, 0.42], [0.92, 0.48, 1], [0.955, 0.34], [0.93, 0.17], [0.87, 0.112, 1], [0, 0.110]], 0),
      grille: [sym([[0, 0.33], [0.36, 0.33], [0.44, 0.30, 1], [0.42, 0.17, 1], [0, 0.165]], 0)],
      intakes: pair(loop([[0.50, 0.415, 1], [0.90, 0.468, 1], [0.935, 0.33], [0.905, 0.175, 1], [0.52, 0.175, 1], [0.46, 0.30]]), 0),
      // sharp slanted lamp: low pointed inner end, outer end climbing round the corner onto the wing
      headlights: pair(loop([[0.46, 0.585, 1], [0.62, 0.625], [0.80, 0.675], [0.895, 0.70, 1], [0.905, 0.655, 1],
        [0.80, 0.622], [0.62, 0.578], [0.49, 0.556, 1]]), 0),
      drl: [].concat(
        pair(loop([[0.48, 0.580, 1], [0.62, 0.617], [0.80, 0.666], [0.885, 0.690, 1], [0.887, 0.679, 1], [0.80, 0.655],
          [0.62, 0.606], [0.49, 0.571, 1]]), 0),                                           // the Y's top bar
        pair(loop([[0.660, 0.611, 1], [0.700, 0.584], [0.760, 0.574, 1], [0.762, 0.583, 1], [0.706, 0.594], [0.674, 0.615, 1]]), 0)), // Y stem
      splitter: sym([[0, 0.135], [0.86, 0.128, 1], [0.885, 0.11, 1], [0, 0.108]], 0),
      panelLines: [curve([[-0.74, 0.83], [-0.56, 0.77], [-0.30, 0.735], [0, 0.728], [0.30, 0.735], [0.56, 0.77], [0.74, 0.83]])],
      plateArea: rect(0, 0.25, 0.52, 0.11),
      badgeArea: rect(0, 0.52, 0.08, 0.06)
    };

    /* ---- rear (z,y) ---- */
    var rear = {
      body: sym([[0, H], [0.30, H - 0.01], [0.46, 1.10], [0.56, 1.03], [0.66, 0.995], [0.80, 0.99], [0.90, 0.965],
        [0.95, 0.88], [hw, 0.70], [0.96, 0.45], [0.925, 0.25], [0.86, 0.14, 1], [0, 0.13]], 0),
      greenhouse: sym([[0, 1.11], [0.34, 1.10], [0.44, 1.02, 1], [0, 1.0]], 0),
      bumper: sym([[0, 0.52], [0.88, 0.53, 1], [0.955, 0.42], [0.925, 0.25], [0.86, 0.14, 1], [0, 0.13]], 0),
      taillights: pair(loop([[0.48, 0.935, 1], [0.70, 0.950], [0.90, 0.956, 1], [0.938, 0.905, 1], [0.90, 0.905],
        [0.70, 0.902], [0.50, 0.898, 1]]), 0),
      diffuser: sym([[0, 0.30], [0.62, 0.30, 1], [0.74, 0.25], [0.72, 0.14, 1], [0, 0.13]], 0),
      exhaust: [{ shape: 'trapezoid', cx: 0.17, cy: 0.64, w: 0.18, h: 0.085 }, { shape: 'trapezoid', cx: -0.17, cy: 0.64, w: 0.18, h: 0.085 }],
      panelLines: [curve([[-0.66, 0.995], [-0.40, 0.985], [0, 0.98], [0.40, 0.985], [0.66, 0.995]])],
      plateArea: rect(0, 0.42, 0.52, 0.11),
      badgeArea: rect(0, 0.875, 0.40, 0.026),
      spoiler: sym([[0, 0.997], [0.86, 0.992, 1], [0.87, 0.972, 1], [0, 0.976]], 0)          // integrated ducktail
    };

    var details = [
      det('side', 'mirror', 'body', loop([[0.62, 0.90], [0.58, 0.962], [0.46, 0.982], [0.40, 0.952], [0.44, 0.905], [0.54, 0.895]])),
      det('side', 'trim', 'black', poly([[0.58, 0.885], [0.62, 0.885], [0.60, 0.905], [0.56, 0.905]])),
      det('side', 'intake', 'black', intake),
      det('side', 'intake', 'grille', Pth(-0.52, 0.785).L(-0.97, 0.818).S([[-0.995, 0.74], [-0.95, 0.63, 1]]).S([[-0.74, 0.655], [-0.52, 0.70, 1]]).Z()),
      det('side', 'trim', 'light', Pth(2.30, 0.425).S([[2.20, 0.497], [2.08, 0.548]]).L(2.085, 0.528).S([[2.20, 0.478], [2.315, 0.405]]).Z()),
      det('side', 'light', 'light-red', poly([[-2.155, 0.985], [-2.10, 0.972], [-2.10, 0.948], [-2.14, 0.950]])),
      det('side', 'vent', 'black', Pth(-2.12, 0.86).S([[-2.13, 0.72]]).L(-2.06, 0.72).S([[-2.05, 0.86]]).Z()),  // rear quarter mesh
      det('side', 'wiper', 'black', curve([[0.82, 0.835], [0.58, 0.915]])),
      det('side', 'trim', 'black', band([[0.0, 0.896], [-0.30, 0.91], [-0.54, 0.932]], 0.012)),
      det('top', 'wiper', 'black', curve([[0.80, -0.45], [0.70, 0.20]])),
      det('front', 'badge', 'body', rect(0, 0.52, 0.06, 0.045)),
      det('front', 'trim', 'carbon', sym([[0, 0.168], [0.42, 0.170], [0.60, 0.178, 1], [0.60, 0.160, 1], [0, 0.150]], 0)),   // EVO splitter wing
      det('rear', 'vent', 'grille', sym([[0, 0.845], [0.46, 0.852], [0.90, 0.862, 1], [0.94, 0.72], [0.90, 0.56, 1], [0, 0.55]], 0)),  // hexagon mesh
      det('rear', 'trim', 'black', sym([[0, 0.548], [0.70, 0.552, 1], [0.70, 0.535, 1], [0, 0.532]], 0))
    ].concat(
      // louvred engine cover: hexagon glass panels either side of the spine with slats over them
      detPair('top', 'glass', 'glass', loop([[-1.22, 0.06, 1], [-1.25, 0.34], [-1.50, 0.50], [-1.95, 0.52, 1], [-2.05, 0.40], [-2.05, 0.06, 1]])),
      [0, 1, 2, 3, 4, 5].reduce(function (a, i) {
        var x = -1.32 - i * 0.13;
        return a.concat(detPair('top', 'vent', 'black', rrect(x, 0.28, 0.022, 0.40, 0.008)));
      }, []),
      detPair('top', 'vent', 'black', loop([[2.12, 0.18, 1], [2.08, 0.42], [1.96, 0.46, 1], [2.0, 0.20, 1]])),        // lid vents
      detPair('front', 'intake', 'grille', loop([[0.53, 0.40, 1], [0.885, 0.45, 1], [0.915, 0.33], [0.89, 0.19, 1], [0.545, 0.19, 1], [0.495, 0.30]])),
      slats('front', 0.55, 0.88, 2, 0.32, 0.30, 'body'),                                                              // EVO blade ends
      detPair('front', 'trim', 'body', loop([[0.50, 0.31, 1], [0.90, 0.33, 1], [0.905, 0.31, 1], [0.50, 0.292, 1]])),  // EVO blade
      slats('front', 0.30, 0.40, 2, 0.31, 0.18, 'gloss-black'),
      detPair('rear', 'trim', 'light-red', loop([[0.62, 0.935, 1], [0.66, 0.910], [0.72, 0.905, 1], [0.72, 0.913, 1], [0.67, 0.918], [0.635, 0.94, 1]])), // Y in the lamp
      detPair('rear', 'trim', 'chrome', ring(trap(0.17, 0.64, 0.18, 0.085), trap(0.17, 0.64, 0.16, 0.068))),
      slats('rear', 0.10, 0.62, 6, 0.29, 0.15, 'carbon'),
      detPair('rear', 'light', 'light-red', rrect(0.80, 0.40, 0.06, 0.02, 0.008))                                   // reflectors
    );

    var m = {
      id: 'lamborghini-huracan-evo', make: 'Lamborghini', name: 'Huracán EVO', gen: 'LB724', years: '2019–2024',
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'awd', powertrain: 'ice', doors: 2,
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.668, trackR: 1.620, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 20, tireF: '245/30R20', tireR: '305/30R20', groundClearance: 0.110, rideHeight: 0.125, cd: 0.36,
        curbWeight_kg: 1600 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Slim sharp-cornered slanted LED lamps whose outer ends climb round onto the wings, with a Y-shaped DRL graphic',
        taillights: 'Thin wedge tail lamps under the ducktail lip with a Y light signature, a full-width hexagon mesh between them',
        grille: 'No grille: a low central intake and two huge trapezoid side intakes split by the EVO wing-profile blade, carbon splitter',
        notes: 'Single unbroken arc from nose to ducktail, hexagonal side glass with a sharp kink, side intake ahead of the rear wheel, louvred engine cover, twin high-mounted exhausts'
      },
      sources: ['lamborghini.com Huracán EVO technical data', 'automobiledimension.com Huracán EVO']
    };
    m.sections = buildSections(m, [
      [2.350, 0.010, 0.30, 0.025, 0.20, 0.035, 0.10, 0.040, 0],
      [2.20, 0.000, 0.62, 0.040, 0.42, 0.060, 0.20, 0.070, 0],
      [1.90, 0.000, 0.74, 0.060, 0.52, 0.090, 0.26, 0.100, 0],
      [1.50, 0.000, 0.79, 0.065, 0.56, 0.095, 0.28, 0.105, 0],
      [1.10, 0.000, 0.79, 0.055, 0.58, 0.080, 0.30, 0.090, 0],
      [0.88, 0.000, 0.78, 0.040, 0.62, 0.060, 0.32, 0.065, 0],
      [0.82, 0.020, 0.78, 0.010, 0.68, 0.000, 0.56, 0.030, 1],
      [0.40, 0.140, 0.80, 0.105, 0.68, 0.020, 0.58, 0.000, 1],
      [0.00, 0.255, 0.77, 0.200, 0.69, 0.035, 0.56, 0.000, 1],
      [-0.40, 0.270, 0.78, 0.215, 0.68, 0.035, 0.56, 0.000, 1],
      [-0.85, 0.180, 0.80, 0.120, 0.66, 0.010, 0.50, 0.020, 1],
      [-1.12, 0.090, 0.82, 0.040, 0.62, 0.020, 0.42, 0.050, 0],
      [-1.40, 0.000, 0.84, 0.030, 0.62, 0.050, 0.36, 0.060, 0],
      [-1.85, 0.000, 0.82, 0.030, 0.60, 0.055, 0.34, 0.060, 0],
      [-2.08, 0.000, 0.74, 0.025, 0.54, 0.040, 0.30, 0.045, 0],
      [-2.15, 0.000, 0.62, 0.020, 0.45, 0.030, 0.25, 0.035, 0]
    ], { screen: [0.10, 0.85] });
    m.wheel = { spokes: 5, style: 'twin', finish: '#2b2d30', caliper: '#1e1f22', design: '20in Aesir forged' };
    return m;
  }

  /* ================================================================== FERRARI 296 GTB */
  /* 4565 × 1958 × 1187 mm, wheelbase 2600, track 1665/1632, 245/35ZR20 · 305/35ZR20. Compact Dino-inspired berlinetta:
     short rounded nose, teardrop headlamps with a black "tear" running down to the brake ducts, wraparound visor
     screen with black A-pillars, flying buttresses over a vertical rear screen, big intakes cut into the rear wings,
     a full-width black "hammerhead" band across the tail carrying the slim lamps and the active spoiler, one central
     high exhaust. */
  function f296() {
    var L = 4.565, W = 1.958, H = 1.187, WB = 2.600, FO = 1.005, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.305, R -2.26
    var rF = tireRadius(245, 35, 20), rR = tireRadius(305, 35, 20);         // 0.3398, 0.3608
    var raF = rF + 0.032, raR = rR + 0.033;

    var body = Pth(2.20, 0.105)
      .L(2.26, 0.12)
      .S([[2.29, 0.16], [F, 0.24, 1]])
      .S([[F + 0.001, 0.31], [2.296, 0.38], [2.27, 0.445], [2.21, 0.505]])                  // rounded nose
      .S([[2.05, 0.585], [1.75, 0.668], [1.40, 0.735], [1.10, 0.785], [0.90, 0.818], [0.78, 0.852]]) // wing crest to screen base
      .S([[0.45, 0.988], [0.10, 1.118], [-0.25, H], [-0.60, 1.163], [-0.92, 1.108], [-1.25, 1.052], [-1.60, 1.012],
        [-1.95, 0.992], [-2.18, 0.986], [R, 1.0, 1]])                                       // visor, roof, buttress, haunch
      .S([[-2.235, 0.90], [-2.24, 0.75], [-2.255, 0.60, 1]])                               // tail face (hammerhead band)
      .S([[-2.20, 0.40], [-2.06, 0.26], [-1.85, 0.185], [-1.70, 0.17]])
      .arch(aR, rR, raR, 0.17, 0.18)
      .L(-0.92, 0.12).L(0.92, 0.12)
      .arch(aF, rF, raF, 0.18, 0.25)
      .S([[1.85, 0.20], [2.08, 0.135], [2.20, 0.105]]).Z();
    var greenhouse = Pth(0.78, 0.852)
      .S([[0.45, 0.984], [0.10, 1.112], [-0.25, 1.178], [-0.60, 1.152], [-0.80, 1.118, 1]])
      .S([[-0.62, 0.99], [-0.30, 0.925], [0.20, 0.885], [0.78, 0.852]]).Z();
    var sideGlass = Pth(0.60, 0.892).S([[0.30, 1.02], [0.0, 1.105], [-0.30, 1.150], [-0.58, 1.13], [-0.72, 1.10, 1]])
      .S([[-0.58, 1.0], [-0.30, 0.94], [0.20, 0.905], [0.60, 0.892]]).Z();
    var aPillar = Pth(0.78, 0.852).S([[0.45, 0.984], [0.10, 1.112], [-0.05, 1.145]]).L(-0.02, 1.122).S([[0.30, 1.02], [0.60, 0.892]]).Z();
    var buttress = Pth(-0.60, 1.163).S([[-0.92, 1.108], [-1.20, 1.058], [-1.38, 1.036]])
      .S([[-1.16, 1.030], [-0.92, 1.072], [-0.72, 1.12]]).Z();
    var tunnel = Pth(-0.72, 1.115).S([[-0.92, 1.068], [-1.14, 1.027], [-1.32, 1.012]]).S([[-1.18, 0.985], [-1.02, 0.97]])
      .S([[-0.86, 0.985], [-0.78, 1.04]]).Z();
    var wingIntake = Pth(-0.40, 0.862).S([[-0.65, 0.886], [-0.90, 0.892], [-0.99, 0.876, 1]]).S([[-1.01, 0.76], [-0.95, 0.645, 1]])
      .S([[-0.70, 0.725], [-0.40, 0.862]]).Z();

    var side = {
      body: body, greenhouse: greenhouse, windows: [sideGlass],
      pillars: [{ path: aPillar, paint: 'gloss-black' }, buttress],                         // black A-pillar → visor look
      doorCuts: [
        curve([[0.92, 0.25], [0.905, 0.52], [0.86, 0.74], [0.78, 0.852]]),
        curve([[-0.72, 1.10], [-0.55, 0.96], [-0.40, 0.86], [-0.38, 0.55], [-0.38, 0.22]]),
        curve([[0.92, 0.25], [0.20, 0.215], [-0.38, 0.22]])
      ],
      panelLines: [
        curve([[2.29, 0.40], [2.18, 0.49], [2.02, 0.56]]),
        curve([[-1.38, 1.03], [-1.75, 1.0], [-2.10, 0.985]]),
        rect(-1.48, 1.012, 0.09, 0.022)                                                   // fuel flap on the haunch
      ],
      characterLines: [
        curve([[0.92, 0.36], [0.40, 0.40], [0.0, 0.46], [-0.38, 0.55]]),                  // door scoop crease
        curve([[1.85, 0.645], [1.45, 0.728], [1.05, 0.79], [0.85, 0.82]]),
        curve([[-1.02, 0.905], [-1.40, 0.928], [-1.85, 0.946], [-2.23, 0.948]])
      ],
      sill: Pth(0.92, 0.12).L(-0.92, 0.12).L(-0.94, 0.165).S([[-0.40, 0.19], [0.40, 0.19], [0.96, 0.165]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.025 },
      archR: { x: aR, y: rR, r: raR, flare: 0.032 },
      lowerTrim: [
        Pth(2.20, 0.105).L(2.26, 0.12).L(2.285, 0.145).S([[2.10, 0.155], [1.88, 0.215]]).L(1.86, 0.195).S([[2.08, 0.135]]).Z(),
        Pth(-2.22, 0.42).S([[-2.06, 0.26], [-1.85, 0.185]]).L(-1.86, 0.22).S([[-2.04, 0.29], [-2.19, 0.44]]).Z(),
        Pth(0.92, 0.12).L(-0.92, 0.12).L(-0.94, 0.165).S([[-0.40, 0.19], [0.40, 0.19], [0.96, 0.165]]).Z()
      ]
    };

    var top = {
      body: sym([[F, 0, 1], [2.298, 0.20], [2.27, 0.42], [2.20, 0.60], [2.06, 0.76], [1.85, 0.88], [1.55, 0.955], [1.30, hw],
        [1.00, 0.965], [0.60, 0.93], [0.20, 0.915], [-0.30, 0.93], [-0.80, 0.962], [-1.30, hw], [-1.70, 0.96],
        [-2.00, 0.91], [-2.18, 0.80], [-2.245, 0.58], [R, 0.30], [R, 0]], 1),
      greenhouse: sym([[0.80, 0], [0.78, 0.58], [0.45, 0.67], [-0.20, 0.67], [-0.70, 0.56], [-0.95, 0.42], [-1.00, 0]], 1),
      hood: sym([[2.22, 0], [2.16, 0.36], [1.95, 0.52], [1.45, 0.56], [1.00, 0.55], [0.88, 0]], 1),
      roof: sym([[0.08, 0], [0.06, 0.55], [-0.30, 0.60], [-0.70, 0.50], [-0.78, 0]], 1),
      deck: sym([[-1.05, 0], [-1.07, 0.35], [-1.35, 0.55], [-1.90, 0.60], [-2.18, 0.50], [-2.22, 0]], 1),
      mirrors: pair(loop([[0.60, 0.89], [0.56, 1.01], [0.48, 1.08], [0.41, 1.07], [0.43, 0.97], [0.50, 0.90]]), 1),
      characterLines: [].concat(pair(curve([[1.95, 0.70], [1.55, 0.78], [1.05, 0.78], [0.85, 0.75]]), 1),
        pair(curve([[-1.10, 0.80], [-1.65, 0.83], [-2.15, 0.76]]), 1))
    };

    var front = {
      body: sym([[0, H], [0.30, H - 0.008], [0.48, 1.135], [0.60, 0.99], [0.67, 0.92], [0.75, 0.87], [0.84, 0.835],
        [0.91, 0.76], [0.955, 0.63], [hw, 0.48], [0.97, 0.32], [0.935, 0.17], [0.87, 0.107, 1], [0, 0.105]], 0),
      greenhouse: sym([[0, 1.15], [0.42, 1.135], [0.63, 0.89, 1], [0.40, 0.865], [0, 0.86]], 0),
      bumper: sym([[0, 0.46], [0.60, 0.47], [0.90, 0.52, 1], [0.965, 0.36], [0.935, 0.17], [0.87, 0.107, 1], [0, 0.105]], 0),
      grille: [sym([[0, 0.37], [0.48, 0.365], [0.62, 0.34, 1], [0.64, 0.20], [0.58, 0.15, 1], [0, 0.15]], 0)],
      intakes: pair(loop([[0.72, 0.43, 1], [0.90, 0.475, 1], [0.935, 0.34], [0.90, 0.19, 1], [0.73, 0.20, 1], [0.69, 0.32]]), 0),
      // teardrop lamp: rounded outer end high on the wing corner, tapering inboard and down
      headlights: pair(loop([[0.50, 0.615, 1], [0.66, 0.66], [0.82, 0.70], [0.885, 0.69], [0.895, 0.63], [0.84, 0.585],
        [0.72, 0.570], [0.60, 0.585]]), 0),
      drl: pair(loop([[0.52, 0.624, 1], [0.66, 0.662], [0.82, 0.697], [0.872, 0.688, 1], [0.82, 0.686], [0.66, 0.650],
        [0.53, 0.616, 1]]), 0),
      splitter: sym([[0, 0.13], [0.86, 0.125, 1], [0.885, 0.105, 1], [0, 0.103]], 0),
      panelLines: [curve([[-0.74, 0.84], [-0.55, 0.78], [-0.30, 0.745], [0, 0.738], [0.30, 0.745], [0.55, 0.78], [0.74, 0.84]])],
      plateArea: rect(0, 0.26, 0.52, 0.11),
      badgeArea: rect(0, 0.53, 0.06, 0.07)
    };

    var lampR = rrect(0.81, 0.872, 0.24, 0.042, 0.018);
    var rear = {
      body: sym([[0, H], [0.30, 1.175], [0.46, 1.11], [0.55, 1.04], [0.62, 1.005], [0.74, 1.0], [0.86, 0.99], [0.93, 0.95],
        [0.965, 0.85], [hw, 0.70], [0.97, 0.46], [0.935, 0.26], [0.86, 0.145, 1], [0, 0.14]], 0),
      greenhouse: sym([[0, 1.14], [0.34, 1.13], [0.42, 1.02, 1], [0, 1.01]], 0),                  // vertical rear screen
      bumper: sym([[0, 0.54], [0.88, 0.55, 1], [0.96, 0.44], [0.935, 0.26], [0.86, 0.145, 1], [0, 0.14]], 0),
      taillights: pair(lampR, 0),
      diffuser: sym([[0, 0.38], [0.66, 0.38, 1], [0.76, 0.30], [0.74, 0.145, 1], [0, 0.14]], 0),
      exhaust: [{ shape: 'oval', cx: 0, cy: 0.63, w: 0.26, h: 0.10 }],
      panelLines: [curve([[-0.62, 1.0], [-0.30, 0.988], [0, 0.985], [0.30, 0.988], [0.62, 1.0]])],
      plateArea: rect(0, 0.46, 0.52, 0.11),
      badgeArea: rect(0, 0.79, 0.30, 0.025),
      spoiler: { path: sym([[0, 0.926], [0.62, 0.928, 1], [0.62, 0.902, 1], [0, 0.900]], 0), paint: 'gloss-black' }   // active spoiler in the band
    };

    var details = [
      det('side', 'mirror', 'body', loop([[0.60, 0.925], [0.56, 0.99], [0.44, 1.01], [0.38, 0.975], [0.42, 0.93], [0.52, 0.92]])),
      det('side', 'trim', 'black', poly([[0.58, 0.905], [0.62, 0.905], [0.60, 0.93], [0.56, 0.93]])),
      det('side', 'intake', 'black', tunnel),
      det('side', 'intake', 'black', wingIntake),
      det('side', 'intake', 'grille', Pth(-0.55, 0.858).S([[-0.75, 0.874], [-0.95, 0.872, 1]]).S([[-0.97, 0.77], [-0.93, 0.68, 1]]).S([[-0.75, 0.74], [-0.55, 0.81]]).Z()),
      det('side', 'intake', 'black', Pth(0.10, 0.36).S([[-0.15, 0.40], [-0.36, 0.46, 1]]).L(-0.36, 0.40).S([[-0.10, 0.355]]).Z()),  // door scoop
      det('side', 'handle', 'black', rrect(-0.26, 0.80, 0.10, 0.012, 0.005)),
      det('side', 'trim', 'light', Pth(2.27, 0.45).S([[2.18, 0.515], [2.06, 0.57]]).L(2.07, 0.548).S([[2.18, 0.494], [2.285, 0.43]]).Z()),
      det('side', 'light', 'light-red', poly([[-2.235, 0.895], [-2.18, 0.89], [-2.18, 0.86], [-2.235, 0.855]])),
      det('side', 'trim', 'gloss-black', poly([[-2.255, 0.94, 1], [-2.15, 0.935], [-2.15, 0.83], [-2.245, 0.82]])),
      det('side', 'wiper', 'black', curve([[0.76, 0.86], [0.52, 0.94]])),
      det('top', 'wiper', 'black', curve([[0.74, -0.45], [0.64, 0.20]])),
      det('top', 'glass', 'glass', rrect(-1.03, 0, 0.05, 0.62, 0.02)),                       // vertical rear screen seen from above
      det('front', 'badge', 'body', rect(0, 0.53, 0.045, 0.06)),
      det('front', 'trim', 'body', sym([[0, 0.352], [0.40, 0.350], [0.60, 0.342, 1], [0.60, 0.322, 1], [0, 0.324]], 0)),  // tea-tray bar
      det('rear', 'trim', 'gloss-black', ring(sym([[0, 0.935], [0.62, 0.938], [0.95, 0.93, 1], [0.962, 0.82, 1], [0, 0.82]], 0),
        lampR).concat(mirror(lampR, 0))),                                                           // hammerhead band round the lamps
      det('rear', 'trim', 'black', rrect(0, 0.63, 0.32, 0.13, 0.05)),
      det('rear', 'vent', 'grille', sym([[0, 0.79], [0.50, 0.79, 1], [0.60, 0.70], [0.55, 0.57, 1], [0, 0.57]], 0))
    ].concat(
      detPair('top', 'trim', 'body', loop([[-0.60, 0.60, 1], [-0.95, 0.66], [-1.32, 0.74, 1], [-1.32, 0.76, 1], [-0.95, 0.69], [-0.60, 0.635, 1]])),
      [0, 1, 2].reduce(function (a, i) { return a.concat(detPair('top', 'vent', 'black', rrect(-1.55 - i * 0.14, 0.24, 0.04, 0.30, 0.015))); }, []),
      detPair('top', 'vent', 'black', loop([[2.08, 0.12, 1], [2.05, 0.30], [1.96, 0.32, 1], [1.99, 0.14, 1]])),
      detPair('front', 'intake', 'grille', loop([[0.745, 0.415, 1], [0.885, 0.455, 1], [0.915, 0.34], [0.885, 0.21, 1], [0.75, 0.215, 1]])),
      detPair('front', 'trim', 'gloss-black', loop([[0.80, 0.585, 1], [0.84, 0.582], [0.83, 0.50], [0.80, 0.455, 1], [0.78, 0.50]])),  // the black "tear"
      slats('front', 0.32, 0.56, 4, 0.32, 0.16, 'gloss-black'),
      detPair('rear', 'trim', 'light-red', rrect(0.81, 0.872, 0.20, 0.014, 0.006)),           // LED line in the lamp
      [det('rear', 'trim', 'chrome', ring(ellipse(0, 0.63, 0.13, 0.05), ellipse(0, 0.63, 0.115, 0.038)))],
      slats('rear', 0.12, 0.62, 5, 0.36, 0.15, 'carbon'),
      detPair('rear', 'light', 'light-red', rrect(0.82, 0.40, 0.06, 0.02, 0.008))
    );

    var m = {
      id: 'ferrari-296-gtb', make: 'Ferrari', name: '296 GTB', gen: 'F171', years: '2022–',
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'hybrid', doors: 2,
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.665, trackR: 1.632, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 20, tireF: '245/35ZR20', tireR: '305/35ZR20', groundClearance: 0.105, rideHeight: 0.12, cd: 0.34,
        curbWeight_kg: 1600 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Teardrop LED lamps with a slim DRL eyebrow, a black "tear" running down from each lamp into the brake-cooling duct',
        taillights: 'Slim lamps set into a full-width black hammerhead band that also carries the active spoiler; one central high exhaust',
        grille: 'Wide single mouth under a body-colour tea-tray bar, small outer brake ducts',
        notes: 'Short nose, wraparound visor screen with black A-pillars, flying buttresses over a vertical rear screen, Dino-style intakes cut into the rear wings'
      },
      sources: ['ferrari.com 296 GTB technical specifications', 'auto-data.net Ferrari 296 GTB']
    };
    m.sections = buildSections(m, [
      [2.300, 0.010, 0.30, 0.030, 0.20, 0.040, 0.10, 0.045, 0],
      [2.15, 0.000, 0.62, 0.050, 0.42, 0.075, 0.20, 0.085, 0],
      [1.90, 0.000, 0.74, 0.070, 0.52, 0.105, 0.26, 0.115, 0],
      [1.50, 0.000, 0.79, 0.080, 0.56, 0.115, 0.28, 0.125, 0],
      [1.10, 0.000, 0.79, 0.070, 0.58, 0.100, 0.30, 0.110, 0],
      [0.85, 0.000, 0.78, 0.050, 0.62, 0.070, 0.32, 0.075, 0],
      [0.78, 0.020, 0.78, 0.010, 0.68, 0.000, 0.56, 0.030, 1],
      [0.40, 0.140, 0.80, 0.110, 0.67, 0.020, 0.58, 0.000, 1],
      [0.00, 0.265, 0.77, 0.205, 0.68, 0.035, 0.56, 0.000, 1],
      [-0.40, 0.280, 0.78, 0.220, 0.68, 0.035, 0.56, 0.000, 1],
      [-0.78, 0.190, 0.80, 0.130, 0.70, 0.000, 0.58, 0.030, 1],
      [-1.02, 0.110, 0.80, 0.050, 0.70, 0.000, 0.58, 0.090, 0],
      [-1.30, 0.000, 0.80, 0.025, 0.66, 0.060, 0.45, 0.080, 0],
      [-1.80, 0.000, 0.80, 0.035, 0.62, 0.070, 0.38, 0.080, 0],
      [-2.15, 0.000, 0.74, 0.030, 0.55, 0.050, 0.30, 0.055, 0],
      [-2.25, 0.000, 0.60, 0.020, 0.45, 0.030, 0.25, 0.035, 0]
    ], { screen: [0.08, 0.78], ridges: [{ type: 'buttress', x0: -0.60, x1: -1.32, h: 0.04, z: 0.62, ease: 0.22 }] });
    m.wheel = { spokes: 10, style: 'split', finish: '#8d9196', caliper: '#e8b100', design: '20in forged 5 double-spoke' };
    return m;
  }

  /* ================================================================== PORSCHE 918 SPYDER */
  /* 4643 × 1940 × 1167 mm (targa roof fitted), wheelbase 2730, track 1664/1612, 265/35ZR20 · 325/30ZR21. Modelled the
     way the roadster style is: windows up, roof panels off. side.body is the open car (belt, headrest fairings,
     rear deck); `windshield`, `greenhouse` (screen frame + door glass) and `softTop` (the two carbon targa panels,
     which set the published height) come separately. Upright fender-top headlamps with four LED spots, three-intake
     apron, "top pipes" exiting through the deck between the fairings, a slim full-width light strip under the
     active wing. The 3D sections are lofted with the roof fitted (black targa panels). */
  function p918() {
    var L = 4.643, W = 1.940, H = 1.167, WB = 2.730, FO = 0.990, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.355, R -2.288
    var rF = tireRadius(265, 35, 20), rR = tireRadius(325, 30, 21);         // 0.3468, 0.3642
    var raF = rF + 0.032, raR = rR + 0.033;

    var NOSE = [[2.30, 0.12], [2.34, 0.17], [F, 0.25, 1], [F - 0.004, 0.33], [2.332, 0.40], [2.285, 0.462],
      [2.18, 0.535], [2.00, 0.612], [1.75, 0.69], [1.45, 0.748], [1.20, 0.778], [0.95, 0.795], [0.75, 0.812], [0.55, 0.832]];
    var TAIL = [[-1.25, 1.06], [-1.55, 1.012], [-1.85, 0.988], [-2.10, 0.977], [-2.25, 0.975], [R, 0.988, 1],
      [-2.278, 0.90], [-2.28, 0.75], [-2.285, 0.60, 1], [-2.23, 0.40], [-2.10, 0.26], [-1.90, 0.19], [-1.78, 0.17]];
    function silhouette(closed) {
      var mid = closed
        ? [[0.25, 0.968], [-0.05, 1.098], [-0.35, 1.156], [-0.62, H], [-0.88, 1.138], [-1.08, 1.098]]          // roof panels on
        : [[0.30, 0.858], [-0.10, 0.878], [-0.45, 0.90, 1], [-0.62, 1.0], [-0.80, 1.068], [-1.00, 1.095]]; // open cockpit, fairings
      return Pth(2.24, 0.100).L(NOSE[0][0], NOSE[0][1]).S(NOSE.slice(1)).S(mid.concat(TAIL.slice(0, 6)))
        .S(TAIL.slice(6, 9)).S(TAIL.slice(9))
        .arch(aR, rR, raR, 0.17, 0.18)
        .L(-0.97, 0.115).L(0.97, 0.115)
        .arch(aF, rF, raF, 0.18, 0.25)
        .S([[1.90, 0.21], [2.12, 0.13], [2.24, 0.100]]).Z();
    }
    var body = silhouette(false), closedBody = silhouette(true);
    var windshield = poly([[0.55, 0.832], [-0.08, 1.112], [-0.15, 1.112], [0.45, 0.838]]);
    var doorGlass = Pth(0.42, 0.862).L(-0.06, 1.092).S([[-0.30, 1.05], [-0.44, 0.925, 1]]).S([[0.0, 0.895], [0.42, 0.862]]).Z();
    var greenhouse = Pth(0.55, 0.832).L(-0.08, 1.112).L(-0.16, 1.112).S([[-0.36, 1.06], [-0.48, 0.92, 1]]).S([[0.0, 0.885], [0.55, 0.832]]).Z();
    var softTop = Pth(-0.08, 1.112).S([[-0.35, 1.156], [-0.62, H], [-0.88, 1.138], [-1.08, 1.098, 1]]).L(-0.62, 1.0).S([[-0.40, 1.05], [-0.16, 1.112]]).Z();
    var fairing = Pth(-0.62, 1.0).S([[-0.80, 1.068], [-1.00, 1.095], [-1.25, 1.06], [-1.55, 1.012, 1]]).S([[-1.20, 1.0], [-0.80, 0.97], [-0.62, 1.0]]).Z();

    var side = {
      body: body, greenhouse: greenhouse, windows: [doorGlass], windshield: windshield,
      pillars: [poly([[0.55, 0.832], [-0.08, 1.112], [-0.16, 1.112], [0.42, 0.862]])],
      rollHoops: [loop([[-0.50, 0.90, 1], [-0.52, 1.02], [-0.60, 1.05], [-0.68, 1.02], [-0.70, 0.93, 1]])],   // headrests
      softTop: softTop,
      doorCuts: [
        curve([[0.97, 0.25], [0.95, 0.52], [0.86, 0.72], [0.62, 0.825]]),
        curve([[-0.45, 0.90], [-0.44, 0.65], [-0.44, 0.40], [-0.44, 0.22]]),
        curve([[0.97, 0.25], [0.30, 0.215], [-0.44, 0.22]])
      ],
      panelLines: [
        curve([[2.33, 0.40], [2.22, 0.50], [2.05, 0.58]]),
        curve([[-1.55, 1.012], [-1.90, 0.988], [-2.20, 0.976]]),                         // active wing / deck
        curve([[2.20, 0.36], [2.08, 0.30], [1.90, 0.27]])
      ],
      characterLines: [
        curve([[1.80, 0.67], [1.45, 0.735], [1.10, 0.768], [0.80, 0.79]]),               // front fender crest
        curve([[0.97, 0.36], [0.40, 0.37], [-0.10, 0.40], [-0.44, 0.44]]),               // low door sweep
        curve([[-1.02, 0.88], [-1.45, 0.915], [-1.95, 0.935], [-2.26, 0.935]])
      ],
      sill: Pth(0.97, 0.115).L(-0.97, 0.115).L(-0.99, 0.165).S([[-0.40, 0.19], [0.40, 0.19], [1.01, 0.165]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.022 },
      archR: { x: aR, y: rR, r: raR, flare: 0.03 },
      lowerTrim: [
        Pth(2.24, 0.100).L(2.30, 0.12).L(2.33, 0.145).S([[2.12, 0.155], [1.92, 0.22]]).L(1.90, 0.20).S([[2.12, 0.13]]).Z(),
        Pth(-2.25, 0.42).S([[-2.10, 0.26], [-1.90, 0.19]]).L(-1.91, 0.225).S([[-2.08, 0.29], [-2.22, 0.44]]).Z(),
        Pth(0.97, 0.115).L(-0.97, 0.115).L(-0.99, 0.165).S([[-0.40, 0.19], [0.40, 0.19], [1.01, 0.165]]).Z()
      ]
    };

    var roofPlan = sym([[-0.08, 0], [-0.09, 0.56], [-0.40, 0.62], [-0.80, 0.56], [-1.05, 0.40], [-1.08, 0]], 1);
    var top = {
      body: sym([[F, 0, 1], [2.345, 0.22], [2.31, 0.45], [2.22, 0.64], [2.06, 0.80], [1.85, 0.90], [1.60, 0.955], [1.365, hw],
        [1.05, 0.955], [0.60, 0.915], [0.10, 0.895], [-0.40, 0.91], [-0.90, 0.945], [-1.365, hw], [-1.75, 0.955],
        [-2.05, 0.90], [-2.22, 0.78], [-2.275, 0.55], [R, 0.28], [R, 0]], 1),
      greenhouse: sym([[0.56, 0], [0.55, 0.62], [0.25, 0.66], [-0.10, 0.62, 1], [-0.14, 0.30], [-0.14, 0]], 1),   // windscreen
      cockpit: sym([[-0.12, 0], [-0.12, 0.58], [-0.30, 0.62], [-0.48, 0.55], [-0.52, 0]], 1),
      hood: sym([[2.25, 0], [2.20, 0.32], [1.95, 0.48], [1.40, 0.52], [0.70, 0.55], [0.62, 0]], 1),
      softTop: roofPlan,
      deck: sym([[-0.75, 0], [-0.78, 0.40], [-1.10, 0.62], [-1.80, 0.68], [-2.20, 0.55], [-2.25, 0]], 1),
      mirrors: pair(loop([[0.40, 0.88], [0.37, 1.0], [0.29, 1.06], [0.22, 1.05], [0.24, 0.95], [0.31, 0.88]]), 1),
      characterLines: [].concat(pair(curve([[2.05, 0.70], [1.60, 0.80], [1.00, 0.80], [0.70, 0.76]]), 1),
        pair(curve([[-1.10, 0.80], [-1.70, 0.84], [-2.15, 0.76]]), 1))
    };

    var front = {
      body: sym([[0, 0.80], [0.40, 0.81], [0.58, 0.85], [0.70, 0.93], [0.78, 0.955], [0.84, 0.93], [0.90, 0.84], [0.945, 0.70],
        [hw, 0.50], [0.96, 0.32], [0.93, 0.17], [0.87, 0.10, 1], [0, 0.10]], 0),
      greenhouse: sym([[0, 1.112], [0.40, 1.102], [0.62, 0.85, 1], [0.40, 0.835], [0, 0.83]], 0),
      softTop: sym([[0, H], [0.36, 1.158], [0.48, 1.12, 1], [0.44, 1.105, 1], [0, 1.11]], 0),
      bumper: sym([[0, 0.42], [0.55, 0.44], [0.90, 0.50, 1], [0.955, 0.34], [0.93, 0.17], [0.87, 0.10, 1], [0, 0.10]], 0),
      grille: [sym([[0, 0.33], [0.30, 0.33], [0.38, 0.30, 1], [0.37, 0.16, 1], [0, 0.155]], 0)],
      intakes: pair(loop([[0.46, 0.42, 1], [0.88, 0.47, 1], [0.93, 0.34], [0.90, 0.18, 1], [0.48, 0.17, 1], [0.42, 0.30]]), 0),
      // upright lamp on the front of the fender peak, leaning outboard
      headlights: pair(loop([[0.66, 0.80], [0.76, 0.795], [0.84, 0.745], [0.865, 0.66], [0.845, 0.585], [0.775, 0.555],
        [0.70, 0.578], [0.655, 0.66]]), 0),
      drl: [].concat(pair(loop([[0.675, 0.785], [0.76, 0.78], [0.83, 0.74], [0.85, 0.66], [0.832, 0.595], [0.775, 0.572],
        [0.71, 0.592], [0.672, 0.66]]), 0).map(function (p) { return { path: p, paint: 'gloss-black', role: 'lampInterior' }; }),
        [[0.725, 0.72], [0.795, 0.715], [0.73, 0.645], [0.80, 0.64]].reduce(function (a, c) {   // four LED spots per lamp
          return a.concat(pair(ellipse(c[0], c[1], 0.026, 0.026), 0));
        }, [])),
      splitter: sym([[0, 0.125], [0.86, 0.12, 1], [0.885, 0.10, 1], [0, 0.098]], 0),
      panelLines: [curve([[-0.66, 0.89], [-0.52, 0.835], [-0.28, 0.808], [0, 0.80], [0.28, 0.808], [0.52, 0.835], [0.66, 0.89]])],
      plateArea: rect(0, 0.25, 0.50, 0.11),
      badgeArea: rect(0, 0.70, 0.06, 0.07)
    };

    var rear = {
      body: sym([[0, 0.99], [0.18, 1.0], [0.30, 1.07], [0.40, 1.095], [0.50, 1.07], [0.58, 1.0], [0.72, 0.985], [0.86, 0.975],
        [0.93, 0.93], [0.96, 0.82], [hw, 0.66], [0.96, 0.45], [0.925, 0.26], [0.86, 0.14, 1], [0, 0.13]], 0),
      greenhouse: sym([[0, 1.112], [0.38, 1.102], [0.46, 1.02, 1], [0, 1.0]], 0),
      softTop: sym([[0, H], [0.36, 1.158], [0.48, 1.11, 1], [0.30, 1.07, 1], [0, 1.0]], 0),
      bumper: sym([[0, 0.56], [0.86, 0.57, 1], [0.955, 0.44], [0.925, 0.26], [0.86, 0.14, 1], [0, 0.13]], 0),
      taillights: pair(loop([[0.62, 0.955, 1], [0.90, 0.948, 1], [0.95, 0.90, 1], [0.935, 0.885, 1], [0.88, 0.928], [0.62, 0.940, 1]]), 0),
      lightBar: sym([[0, 0.952], [0.62, 0.955, 1], [0.62, 0.942, 1], [0, 0.939]], 0),
      diffuser: sym([[0, 0.40], [0.66, 0.40, 1], [0.80, 0.30], [0.78, 0.14, 1], [0, 0.13]], 0),
      exhaust: [{ shape: 'hidden', cx: 0.20, cy: 1.03, w: 0.10, h: 0.06 }, { shape: 'hidden', cx: -0.20, cy: 1.03, w: 0.10, h: 0.06 }],
      panelLines: [curve([[-0.70, 0.985], [-0.35, 0.99], [0, 0.99], [0.35, 0.99], [0.70, 0.985]])],
      plateArea: rect(0, 0.48, 0.52, 0.11),
      badgeArea: rect(0, 0.905, 0.30, 0.022),
      spoiler: sym([[0, 0.985], [0.80, 0.98, 1], [0.80, 0.962, 1], [0, 0.964]], 0),
      rollHoops: pair(curve([[0.30, 1.0], [0.32, 1.07], [0.40, 1.09], [0.48, 1.07], [0.50, 1.0]]), 0)
    };

    var details = [
      det('top', 'interior', 'black', top.cockpit),
      det('side', 'rollHoop', 'black', side.rollHoops[0]),
      det('side', 'fairing', 'body', fairing),
      det('side', 'mirror', 'body', loop([[0.40, 0.87], [0.37, 0.935], [0.25, 0.955], [0.19, 0.92], [0.23, 0.875], [0.33, 0.865]])),
      det('side', 'trim', 'black', poly([[0.38, 0.855], [0.42, 0.855], [0.40, 0.875], [0.36, 0.875]])),
      det('side', 'intake', 'black', Pth(-0.52, 0.80).S([[-0.75, 0.835], [-0.95, 0.858, 1]]).S([[-0.96, 0.75], [-0.92, 0.66, 1]]).S([[-0.72, 0.70], [-0.52, 0.76]]).Z()),
      det('side', 'light', 'light', Pth(2.22, 0.52).S([[2.18, 0.60], [2.10, 0.655]]).L(2.04, 0.65).S([[2.10, 0.59], [2.17, 0.515]]).Z()),   // upright lamp
      det('side', 'exhaust', 'chrome', loop([[-1.10, 1.035, 1], [-1.18, 1.065], [-1.22, 1.07, 1], [-1.20, 1.04, 1]])),      // top pipe tip
      det('side', 'light', 'light-red', poly([[-2.288, 0.955], [-2.20, 0.958], [-2.20, 0.945], [-2.285, 0.94]])),
      det('side', 'handle', 'black', rrect(-0.25, 0.80, 0.10, 0.012, 0.005)),
      det('side', 'wiper', 'black', curve([[0.52, 0.845], [0.30, 0.95]])),
      det('top', 'wiper', 'black', curve([[0.50, -0.40], [0.42, 0.20]])),
      det('front', 'badge', 'body', rect(0, 0.70, 0.045, 0.055)),
      det('rear', 'vent', 'grille', sym([[0, 0.90], [0.60, 0.905], [0.88, 0.89, 1], [0.92, 0.75], [0.86, 0.60, 1], [0, 0.59]], 0)),
      det('rear', 'trim', 'black', sym([[0, 0.585], [0.80, 0.59, 1], [0.80, 0.572, 1], [0, 0.568]], 0))
    ].concat(
      detPair('top', 'fairing', 'body', loop([[-0.55, 0.40], [-0.60, 0.50], [-0.80, 0.52], [-1.20, 0.48], [-1.55, 0.42, 1], [-1.20, 0.30], [-0.80, 0.28], [-0.60, 0.30]])),
      detPair('top', 'exhaust', 'chrome', ellipse(-1.18, 0.20, 0.05, 0.035)),
      detPair('top', 'exhaust', 'black', ellipse(-1.18, 0.20, 0.035, 0.022)),
      detPair('top', 'light', 'light', loop([[2.24, 0.62], [2.20, 0.70], [2.10, 0.74], [2.06, 0.70], [2.12, 0.62]])),
      detPair('top', 'vent', 'black', rrect(-1.80, 0.40, 0.25, 0.04, 0.015)),
      detPair('front', 'intake', 'grille', loop([[0.49, 0.405, 1], [0.865, 0.45, 1], [0.905, 0.34], [0.88, 0.195, 1], [0.505, 0.19, 1], [0.455, 0.30]])),
      detPair('front', 'trim', 'gloss-black', loop([[0.47, 0.31, 1], [0.90, 0.33, 1], [0.905, 0.31, 1], [0.47, 0.292, 1]])),
      slats('front', 0.30, 0.34, 1, 0.31, 0.17, 'gloss-black'),
      detPair('rear', 'rollHoop', 'black', rear.rollHoops[0]),
      detPair('rear', 'exhaust', 'chrome', ellipse(0.20, 1.03, 0.05, 0.03)),
      slats('rear', 0.10, 0.66, 6, 0.38, 0.15, 'carbon'),
      detPair('rear', 'light', 'light-red', rrect(0.82, 0.42, 0.06, 0.02, 0.008))
    );

    var m = {
      id: 'porsche-918-spyder', make: 'Porsche', name: '918 Spyder', gen: '918', years: '2013–2015',
      style: 'roadster', enginePosition: 'mid', drivetrain: 'awd', powertrain: 'hybrid', openTop: true, doors: 2,
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.664, trackR: 1.612, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 21, tireF: '265/35ZR20', tireR: '325/30ZR21', groundClearance: 0.100, rideHeight: 0.115, cd: 0.36,
        curbWeight_kg: 1674 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Upright lamps on the front of the fender peaks, each with four LED spots in a two-by-two block',
        taillights: 'A slim light strip running the full width of the tail under the active rear wing, wrapping the corners',
        grille: 'No grille: three-intake apron, the outer intakes split by a horizontal blade',
        notes: 'Long low cab-rearward roadster with two carbon targa panels, body-colour headrest fairings, top-pipe exhausts exiting through the deck behind the cockpit'
      },
      sources: ['porsche.com 918 Spyder technical data (press kit 2013)', 'auto-data.net Porsche 918 Spyder']
    };
    m.sections = buildSections(m, [
      [2.350, 0.010, 0.30, 0.025, 0.20, 0.035, 0.10, 0.040, 0],
      [2.20, 0.000, 0.62, 0.050, 0.42, 0.080, 0.20, 0.090, 0],
      [1.90, 0.000, 0.76, 0.080, 0.52, 0.120, 0.26, 0.140, 0],
      [1.50, 0.000, 0.80, 0.090, 0.56, 0.130, 0.28, 0.150, 0],
      [1.00, 0.000, 0.80, 0.080, 0.58, 0.110, 0.30, 0.130, 0],
      [0.62, 0.000, 0.78, 0.040, 0.62, 0.060, 0.32, 0.070, 0],
      [0.55, 0.020, 0.78, 0.010, 0.68, 0.000, 0.56, 0.030, 1],
      [0.20, 0.140, 0.80, 0.110, 0.67, 0.020, 0.56, 0.000, 1],
      [-0.20, 0.250, 0.78, 0.200, 0.68, 0.030, 0.56, 0.000, 1],
      [-0.60, 0.260, 0.78, 0.210, 0.66, 0.030, 0.54, 0.000, 1],
      [-1.00, 0.160, 0.82, 0.110, 0.64, 0.010, 0.48, 0.020, 1],
      [-1.15, 0.080, 0.84, 0.040, 0.62, 0.030, 0.42, 0.060, 0],
      [-1.45, 0.000, 0.85, 0.030, 0.62, 0.060, 0.36, 0.075, 0],
      [-1.90, 0.000, 0.82, 0.030, 0.60, 0.055, 0.34, 0.065, 0],
      [-2.20, 0.000, 0.74, 0.025, 0.54, 0.040, 0.30, 0.045, 0],
      [-2.28, 0.000, 0.62, 0.020, 0.45, 0.030, 0.25, 0.035, 0]
    ], { profile: closedBody, roof: roofPlan, screen: [-0.08, 0.55],
      paints: [{ x0: -0.10, x1: -1.06, j0: IDX_K7, j1: 20, paint: 'carbon' }] });           // targa panels
    m.wheel = { spokes: 10, style: 'split', finish: '#3a3c40', caliper: '#c8d400', design: '20/21in forged 918 Spyder wheel, centre lock' };
    return m;
  }

  /* ================================================================== KOENIGSEGG JESKO */
  /* 4610 × 2030 × 1210 mm, wheelbase 2700, 265/35R20 · 325/30R21 (Michelin Pilot Sport Cup 2). Rounded low nose with a
     big carbon splitter and corner canards, louvres in the front-wing tops, a teardrop canopy with a removable targa
     roof and a wraparound visor screen, dihedral synchro-helix doors, large side scoops ahead of the rear wheels,
     a boomerang rear wing hung from two swan-neck pylons rising off the engine cover, small lamps pushed right out
     to the rear corners and a centre exhaust above a huge open diffuser. Track widths are estimated from the
     body width and tyre sizes (not published). */
  function jesko() {
    var L = 4.610, W = 2.030, H = 1.210, WB = 2.700, FO = 0.995, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.345, R -2.265
    var rF = tireRadius(265, 35, 20), rR = tireRadius(325, 30, 21);         // 0.3468, 0.3642
    var raF = rF + 0.032, raR = rR + 0.033;

    var body = Pth(2.22, 0.095)
      .L(2.30, 0.11)
      .S([[2.335, 0.15], [F, 0.20, 1]])                                                     // splitter tip
      .S([[2.328, 0.28], [2.30, 0.36], [2.24, 0.44], [2.10, 0.53], [1.85, 0.63], [1.55, 0.718], [1.25, 0.78],
        [1.00, 0.82], [0.82, 0.85]])                                                         // rounded nose, wing crests
      .S([[0.45, 0.99], [0.10, 1.13], [-0.25, H], [-0.60, 1.183], [-0.95, 1.112], [-1.30, 1.042], [-1.65, 0.992],
        [-1.95, 0.966], [-2.15, 0.955], [R, 0.962, 1]])                                      // canopy → long engine cover
      .S([[-2.24, 0.86], [-2.22, 0.72], [-2.25, 0.56, 1]])
      .S([[-2.20, 0.38], [-2.05, 0.24], [-1.85, 0.175], [-1.75, 0.165]])                     // open diffuser
      .arch(aR, rR, raR, 0.165, 0.17)
      .L(-0.96, 0.11).L(0.96, 0.11)
      .arch(aF, rF, raF, 0.17, 0.24)
      .S([[1.90, 0.20], [2.10, 0.13], [2.22, 0.095]]).Z();
    var greenhouse = Pth(0.82, 0.85)
      .S([[0.45, 0.985], [0.10, 1.122], [-0.25, 1.198], [-0.60, 1.170], [-0.88, 1.115, 1]])
      .S([[-0.60, 0.99], [-0.20, 0.925], [0.30, 0.885], [0.82, 0.85]]).Z();
    var sideGlass = Pth(0.62, 0.89).S([[0.30, 1.02], [0.0, 1.115], [-0.30, 1.175], [-0.60, 1.15], [-0.78, 1.10, 1]])
      .S([[-0.55, 1.0], [-0.20, 0.94], [0.30, 0.905], [0.62, 0.89]]).Z();
    var aPillar = Pth(0.82, 0.85).S([[0.45, 0.985], [0.10, 1.122], [-0.04, 1.155]]).L(-0.01, 1.13).S([[0.30, 1.02], [0.62, 0.89]]).Z();
    var scoop = Pth(-0.52, 0.955).S([[-0.80, 0.945], [-1.00, 0.925, 1]]).S([[-1.03, 0.78], [-0.96, 0.62, 1]]).S([[-0.72, 0.70], [-0.52, 0.80, 1]]).Z();
    // boomerang wing (side profile) and the swan-neck pylon that holds it from above
    var wing = loop([[-1.92, 1.165, 1], [-2.05, 1.178], [-2.20, 1.172], [-2.26, 1.150, 1], [-2.14, 1.140], [-2.00, 1.145]]);
    var pylon = Pth(-1.62, 0.99).S([[-1.72, 1.10], [-1.86, 1.175], [-2.00, 1.188, 1]]).L(-2.00, 1.172)
      .S([[-1.87, 1.158], [-1.76, 1.09], [-1.68, 0.985]]).Z();

    var side = {
      body: body, greenhouse: greenhouse, windows: [sideGlass], pillars: [{ path: aPillar, paint: 'gloss-black' }],
      doorCuts: [
        curve([[0.96, 0.30], [0.94, 0.55], [0.89, 0.76], [0.82, 0.85]]),
        curve([[-0.80, 1.10], [-0.62, 1.0], [-0.50, 0.95], [-0.46, 0.60], [-0.45, 0.22]]),
        curve([[0.96, 0.30], [0.20, 0.215], [-0.45, 0.22]]),
        curve([[0.10, 1.125], [-0.30, 1.19], [-0.70, 1.16]])                                // targa roof joint
      ],
      panelLines: [
        curve([[2.32, 0.32], [2.22, 0.45], [2.06, 0.548]]),
        curve([[-1.05, 1.09], [-1.50, 1.012], [-2.00, 0.962]]),
        rect(-1.30, 1.035, 0.08, 0.022)
      ],
      characterLines: [
        curve([[1.80, 0.64], [1.45, 0.735], [1.10, 0.795], [0.86, 0.835]]),
        curve([[0.96, 0.42], [0.40, 0.44], [-0.10, 0.50], [-0.46, 0.60]]),
        curve([[-1.04, 0.88], [-1.45, 0.90], [-1.95, 0.91], [-2.22, 0.905]])
      ],
      sill: Pth(0.96, 0.11).L(-0.96, 0.11).L(-0.98, 0.16).S([[-0.40, 0.185], [0.40, 0.185], [1.0, 0.16]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.026 },
      archR: { x: aR, y: rR, r: raR, flare: 0.034 },
      lowerTrim: [
        Pth(2.22, 0.095).L(2.30, 0.11).L(2.34, 0.15).S([[2.12, 0.15], [1.92, 0.21]]).L(1.90, 0.19).S([[2.10, 0.13]]).Z(),
        Pth(-2.22, 0.40).S([[-2.05, 0.24], [-1.85, 0.175]]).L(-1.86, 0.215).S([[-2.04, 0.29], [-2.19, 0.43]]).Z(),
        Pth(0.96, 0.11).L(-0.96, 0.11).L(-0.98, 0.16).S([[-0.40, 0.185], [0.40, 0.185], [1.0, 0.16]]).Z()
      ]
    };

    var top = {
      body: sym([[F, 0, 1], [2.338, 0.25], [2.30, 0.50], [2.20, 0.70], [2.03, 0.86], [1.80, 0.96], [1.55, 1.005], [1.35, hw],
        [1.05, 1.0], [0.60, 0.95], [0.10, 0.925], [-0.40, 0.94], [-0.90, 0.985], [-1.35, hw], [-1.75, 1.0],
        [-2.05, 0.95], [-2.20, 0.84], [-2.25, 0.60], [R, 0.30], [R, 0]], 1),
      greenhouse: sym([[0.84, 0], [0.82, 0.60], [0.45, 0.70], [-0.20, 0.69], [-0.70, 0.58], [-0.98, 0.40], [-1.05, 0]], 1),
      hood: sym([[2.25, 0], [2.18, 0.40], [1.95, 0.56], [1.40, 0.60], [1.00, 0.58], [0.90, 0]], 1),
      roof: sym([[0.05, 0], [0.03, 0.56], [-0.30, 0.62], [-0.68, 0.52], [-0.76, 0]], 1),
      deck: sym([[-1.05, 0], [-1.08, 0.40], [-1.40, 0.62], [-1.95, 0.66], [-2.20, 0.50], [-2.24, 0]], 1),
      mirrors: pair(loop([[0.62, 0.92], [0.58, 1.05], [0.50, 1.12], [0.43, 1.11], [0.45, 1.0], [0.52, 0.93]]), 1),
      characterLines: [].concat(pair(curve([[2.00, 0.74], [1.60, 0.82], [1.10, 0.81], [0.88, 0.78]]), 1),
        pair(curve([[-1.10, 0.84], [-1.65, 0.88], [-2.15, 0.80]]), 1))
    };

    var front = {
      body: sym([[0, H], [0.32, H - 0.01], [0.50, 1.15], [0.62, 0.99], [0.70, 0.91], [0.80, 0.86], [0.90, 0.82], [0.96, 0.70],
        [0.995, 0.56], [hw, 0.42], [1.0, 0.28], [0.97, 0.15], [0.90, 0.097, 1], [0, 0.095]], 0),
      greenhouse: sym([[0, 1.17], [0.44, 1.15], [0.66, 0.88, 1], [0.42, 0.86], [0, 0.855]], 0),
      bumper: sym([[0, 0.42], [0.55, 0.44], [0.95, 0.50, 1], [1.0, 0.30], [0.97, 0.15], [0.90, 0.097, 1], [0, 0.095]], 0),
      grille: [sym([[0, 0.36], [0.40, 0.355], [0.55, 0.33, 1], [0.56, 0.19], [0.50, 0.16, 1], [0, 0.16]], 0)],
      intakes: pair(loop([[0.66, 0.41, 1], [0.94, 0.46, 1], [0.98, 0.32], [0.95, 0.17, 1], [0.68, 0.18, 1], [0.62, 0.30]]), 0),
      headlights: pair(loop([[0.50, 0.60, 1], [0.70, 0.625], [0.88, 0.66], [0.95, 0.672, 1], [0.958, 0.638, 1], [0.88, 0.622],
        [0.70, 0.592], [0.52, 0.576, 1]]), 0),
      drl: [].concat(
        pair(loop([[0.52, 0.598, 1], [0.70, 0.622], [0.88, 0.656], [0.94, 0.666, 1], [0.94, 0.657, 1], [0.88, 0.647], [0.70, 0.613], [0.53, 0.590, 1]]), 0),
        [0.62, 0.72, 0.82].reduce(function (a, z) { return a.concat(pair(ellipse(z, 0.602 + (z - 0.62) * 0.18, 0.026, 0.012), 0)); }, [])),
      splitter: sym([[0, 0.14], [0.90, 0.13, 1], [0.93, 0.095, 1], [0, 0.093]], 0),
      panelLines: [curve([[-0.78, 0.86], [-0.58, 0.79], [-0.30, 0.75], [0, 0.742], [0.30, 0.75], [0.58, 0.79], [0.78, 0.86]])],
      plateArea: rect(0, 0.26, 0.50, 0.10),
      badgeArea: rect(0, 0.48, 0.07, 0.06)
    };

    var lamp = loop([[0.76, 0.905, 1], [0.94, 0.915], [0.985, 0.885, 1], [0.97, 0.855, 1], [0.78, 0.858, 1]]);
    var rear = {
      body: sym([[0, H], [0.30, H - 0.01], [0.46, 1.13], [0.56, 1.05], [0.66, 0.99], [0.80, 0.975], [0.92, 0.955], [0.98, 0.88],
        [1.005, 0.75], [hw, 0.60], [1.0, 0.42], [0.96, 0.25], [0.88, 0.13, 1], [0, 0.12]], 0),
      greenhouse: sym([[0, 1.15], [0.34, 1.14], [0.42, 1.04, 1], [0, 1.02]], 0),
      bumper: sym([[0, 0.56], [0.90, 0.58, 1], [0.99, 0.48], [0.96, 0.25], [0.88, 0.13, 1], [0, 0.12]], 0),
      taillights: pair(lamp, 0),
      diffuser: sym([[0, 0.50], [0.40, 0.50, 1], [0.80, 0.42], [0.86, 0.13, 1], [0, 0.12]], 0),
      exhaust: [{ shape: 'round', cx: 0, cy: 0.58, w: 0.17, h: 0.17 }],
      panelLines: [curve([[-0.66, 0.99], [-0.35, 0.975], [0, 0.97], [0.35, 0.975], [0.66, 0.99]])],
      plateArea: rect(0, 0.775, 0.48, 0.10),
      badgeArea: rect(0, 0.905, 0.36, 0.024),
      spoiler: { path: sym([[0, 1.172], [0.60, 1.168], [0.88, 1.18, 1], [0.90, 1.11, 1], [0.60, 1.12], [0, 1.128]], 0), paint: 'carbon' }
    };

    var details = [
      det('side', 'mirror', 'body', loop([[0.62, 0.935], [0.58, 1.0], [0.46, 1.02], [0.40, 0.985], [0.44, 0.94], [0.54, 0.93]])),
      det('side', 'trim', 'black', poly([[0.60, 0.92], [0.64, 0.92], [0.62, 0.94], [0.58, 0.94]])),
      det('side', 'intake', 'black', scoop),
      det('side', 'intake', 'grille', Pth(-0.58, 0.935).S([[-0.80, 0.927], [-0.97, 0.91, 1]]).S([[-0.99, 0.79], [-0.93, 0.67, 1]]).S([[-0.74, 0.735], [-0.58, 0.81, 1]]).Z()),
      det('side', 'wing', 'carbon', wing),
      det('side', 'spoiler', 'carbon', pylon),
      det('side', 'trim', 'carbon', loop([[2.30, 0.30, 1], [2.18, 0.31], [2.12, 0.30, 1], [2.20, 0.29]])),           // canard
      det('side', 'trim', 'carbon', loop([[2.25, 0.24, 1], [2.12, 0.25], [2.06, 0.24, 1], [2.15, 0.23]])),
      det('side', 'trim', 'light', Pth(2.28, 0.40).S([[2.20, 0.468], [2.10, 0.52]]).L(2.11, 0.50).S([[2.20, 0.45], [2.29, 0.38]]).Z()),
      det('side', 'light', 'light-red', poly([[-2.262, 0.92], [-2.20, 0.915], [-2.20, 0.89], [-2.255, 0.888]])),
      det('side', 'handle', 'black', rrect(-0.25, 0.86, 0.08, 0.012, 0.005)),
      det('side', 'wiper', 'black', curve([[0.80, 0.86], [0.56, 0.945]])),
      det('top', 'wiper', 'black', curve([[0.80, -0.45], [0.70, 0.20]])),
      det('top', 'wing', 'carbon', sym([[-1.92, 0], [-1.90, 0.40], [-1.84, 0.78], [-1.88, 0.88], [-2.00, 0.86], [-2.14, 0.50], [-2.22, 0.20], [-2.23, 0]], 1)),
      det('top', 'spoiler', 'carbon', ring(sym([[-1.62, 0], [-1.62, 0.33], [-2.0, 0.33], [-2.0, 0]], 1), sym([[-1.64, 0], [-1.64, 0.31], [-1.98, 0.31], [-1.98, 0]], 1))),
      det('top', 'trim', 'gloss-black', sym([[0.60, 0], [0.58, 0.02], [-1.05, 0.02], [-1.07, 0]], 1)),                       // canopy spine
      det('front', 'badge', 'body', rect(0, 0.48, 0.05, 0.045)),
      det('rear', 'vent', 'grille', sym([[0, 0.86], [0.60, 0.86], [0.74, 0.85, 1], [0.78, 0.62], [0.72, 0.50, 1], [0, 0.50]], 0)),
      det('rear', 'wing', 'carbon', sym([[0, 1.172], [0.60, 1.168], [0.88, 1.18, 1], [0.90, 1.11, 1], [0.60, 1.12], [0, 1.128]], 0)),
      det('rear', 'trim', 'chrome', ring(ellipse(0, 0.58, 0.085, 0.085), ellipse(0, 0.58, 0.07, 0.07))),
      det('rear', 'trim', 'black', ellipse(0, 0.58, 0.115, 0.105))
    ].concat(
      [0, 1, 2, 3, 4].reduce(function (a, i) { return a.concat(detPair('top', 'vent', 'black', rrect(1.78 - i * 0.075, 0.80, 0.025, 0.18, 0.01))); }, []),  // wing-top louvres
      detPair('top', 'vent', 'black', rrect(-1.55, 0.50, 0.30, 0.05, 0.02)),
      detPair('front', 'intake', 'grille', loop([[0.69, 0.395, 1], [0.92, 0.44, 1], [0.955, 0.32], [0.93, 0.19, 1], [0.70, 0.195, 1], [0.65, 0.30]])),
      detPair('front', 'trim', 'carbon', loop([[0.93, 0.33, 1], [1.01, 0.345, 1], [1.01, 0.33, 1], [0.94, 0.318, 1]])),    // canards
      detPair('front', 'trim', 'carbon', loop([[0.93, 0.25, 1], [1.01, 0.262, 1], [1.01, 0.248, 1], [0.94, 0.238, 1]])),
      slats('front', 0.30, 0.50, 3, 0.35, 0.17, 'gloss-black'),
      detPair('rear', 'spoiler', 'carbon', poly([[0.28, 0.97], [0.31, 0.97], [0.33, 1.13], [0.30, 1.13]])),               // swan-neck pylons
      detPair('rear', 'wing', 'carbon', poly([[0.88, 1.20], [0.905, 1.20], [0.905, 1.08], [0.88, 1.08]])),                // end plates
      detPair('rear', 'trim', 'light-red', ring(ellipse(0.90, 0.885, 0.04, 0.018), ellipse(0.90, 0.885, 0.028, 0.010))),
      slats('rear', 0.18, 0.78, 5, 0.46, 0.13, 'carbon'),
      detPair('rear', 'light', 'light-red', rrect(0.90, 0.40, 0.06, 0.02, 0.008))
    );

    var m = {
      id: 'koenigsegg-jesko', make: 'Koenigsegg', name: 'Jesko', gen: 'Attack', years: '2021–',
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'ice', doors: 2,
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.690, trackR: 1.660, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 21, tireF: '265/35R20', tireR: '325/30R21', groundClearance: 0.095, rideHeight: 0.105, cd: 0.38,
        curbWeight_kg: 1420 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Slim horizontal LED strips high on the nose corners with a row of small projector lenses beneath',
        taillights: 'Small lamps pushed right out to the rear corners under the overhanging boomerang wing, a red ring in each',
        grille: 'Wide low central mouth between two big corner intakes, large carbon splitter and twin canards per side',
        notes: 'Teardrop canopy with removable targa roof, dihedral synchro-helix doors, louvred wing tops, large side scoops, swan-neck rear wing, centre exhaust over an open diffuser'
      },
      sources: ['koenigsegg.com Jesko Attack technical specifications', 'en.wikipedia.org Koenigsegg Jesko']
    };
    m.sections = buildSections(m, [
      [2.340, 0.010, 0.30, 0.025, 0.20, 0.035, 0.10, 0.040, 0],
      [2.20, 0.000, 0.64, 0.045, 0.44, 0.065, 0.20, 0.075, 0],
      [1.90, 0.000, 0.78, 0.065, 0.54, 0.095, 0.26, 0.105, 0],
      [1.50, 0.000, 0.82, 0.070, 0.58, 0.100, 0.28, 0.110, 0],
      [1.10, 0.000, 0.82, 0.060, 0.60, 0.085, 0.30, 0.095, 0],
      [0.88, 0.000, 0.80, 0.040, 0.64, 0.060, 0.32, 0.065, 0],
      [0.82, 0.020, 0.80, 0.010, 0.70, 0.000, 0.58, 0.030, 1],
      [0.40, 0.145, 0.82, 0.110, 0.69, 0.020, 0.58, 0.000, 1],
      [0.00, 0.270, 0.79, 0.210, 0.70, 0.035, 0.57, 0.000, 1],
      [-0.40, 0.285, 0.80, 0.225, 0.69, 0.035, 0.56, 0.000, 1],
      [-0.85, 0.180, 0.82, 0.120, 0.66, 0.010, 0.50, 0.020, 1],
      [-1.10, 0.090, 0.85, 0.040, 0.64, 0.020, 0.42, 0.050, 0],
      [-1.40, 0.000, 0.87, 0.030, 0.64, 0.050, 0.36, 0.060, 0],
      [-1.85, 0.000, 0.85, 0.030, 0.62, 0.055, 0.34, 0.060, 0],
      [-2.15, 0.000, 0.76, 0.025, 0.55, 0.040, 0.30, 0.045, 0],
      [-2.25, 0.000, 0.64, 0.020, 0.46, 0.030, 0.25, 0.035, 0]
    ], { screen: [0.05, 0.82], ridges: [{ type: 'fin', x0: 0.70, x1: -1.10, h: 0.012, ease: 0.12 }],
      paints: [{ x0: 0.05, x1: -0.76, j0: IDX_K7 + 1, j1: 20, paint: 'carbon' }] });          // exposed-carbon targa roof
    m.wheel = { spokes: 10, style: 'split', finish: '#1e1f22', caliper: '#c8102e', design: 'Aircore hollow carbon 10-spoke, centre lock' };
    return m;
  }

  /* ================================================================== AUDI R8 V10 (2nd generation) */
  /* 4426 × 1940 × 1240 mm, wheelbase 2650, track 1638/1599, overhangs 990/786, 245/30R20 · 305/30R20. Mid-engine
     coupé on the Huracán's spaceframe but drawn taller and more upright: blunt nose with a wide, flat hexagonal
     Singleframe grille between big three-section side intakes, slim angular LED lamps with a light-guide blade, a
     sharp shoulder ("tornado") line, the split sideblade behind the door framing the engine intake, a glazed
     engine cover over the V10, slim horizontal tail lamps, a full-width black grille in the rear bumper carrying two
     big oval tailpipes at its outer ends. */
  function r8gen2() {
    var L = 4.426, W = 1.940, H = 1.240, WB = 2.650, FO = 0.990, RO = L - WB - FO;
    var aF = WB / 2, aR = -WB / 2, F = aF + FO, R = aR - RO, hw = W / 2;   // F 2.315, R -2.111
    var rF = tireRadius(245, 30, 20), rR = tireRadius(305, 30, 20);         // 0.3275, 0.3455
    var raF = rF + 0.032, raR = rR + 0.033;

    /* ---- side ---- */
    var body = Pth(2.20, 0.115)
      .L(2.26, 0.130)
      .S([[2.296, 0.170], [F, 0.250, 1]])                                                  // splitter lip → bumper face
      .S([[F - 0.003, 0.385], [F - 0.014, 0.525, 1]])                                      // blunt, tall upright nose
      .S([[2.262, 0.600], [2.17, 0.652], [1.97, 0.708], [1.68, 0.760], [1.38, 0.800], [1.15, 0.825], [0.95, 0.840]])   // short front lid
      .S([[0.62, 0.972], [0.25, 1.128], [-0.20, H], [-0.55, 1.233], [-0.85, 1.198], [-1.10, 1.162], [-1.40, 1.130],
        [-1.70, 1.106], [-1.95, 1.092], [R, 1.082, 1]])                                     // cab-forward screen, roof, short high engine deck
      .S([[-2.106, 0.990], [-2.100, 0.800], [-2.108, 0.620, 1]])                            // tall near-vertical tail
      .S([[-2.08, 0.420], [-1.98, 0.280], [-1.82, 0.195], [-1.70, 0.175]])                   // diffuser kick
      .arch(aR, rR, raR, 0.175, 0.175)
      .L(-0.95, 0.130).L(0.95, 0.130)
      .arch(aF, rF, raF, 0.175, 0.250)
      .S([[1.85, 0.210], [2.08, 0.150], [2.20, 0.115]]).Z();
    var greenhouse = Pth(0.95, 0.840)
      .S([[0.62, 0.966], [0.25, 1.118], [-0.20, 1.226], [-0.55, 1.216], [-0.82, 1.180], [-1.00, 1.146, 1]])
      .S([[-0.82, 1.040], [-0.62, 0.966, 1]])                                               // pointed trailing edge over the blade
      .S([[-0.10, 0.930], [0.45, 0.890], [0.95, 0.840]]).Z();
    var doorGlass = Pth(0.76, 0.880).S([[0.47, 1.000], [0.10, 1.152], [-0.25, 1.212], [-0.55, 1.202], [-0.80, 1.170], [-0.95, 1.142, 1]])
      .S([[-0.80, 1.046], [-0.64, 0.980, 1]]).S([[-0.10, 0.946], [0.76, 0.880]]).Z();
    var aPillar = Pth(0.95, 0.840).S([[0.62, 0.966], [0.25, 1.118], [0.07, 1.174]]).L(0.09, 1.150).S([[0.47, 1.000], [0.76, 0.880]]).Z();
    // the split sideblade: lower part (contrast colour) and upper part (body colour) framing the engine intake
    var bladeLo = loop([[-0.58, 0.240, 1], [-0.60, 0.500], [-0.64, 0.745, 1], [-0.92, 0.775, 1], [-0.90, 0.600], [-0.86, 0.420], [-0.80, 0.260, 1]]);
    var bladeHi = loop([[-0.645, 0.770, 1], [-0.635, 0.955, 1], [-0.82, 1.040], [-0.99, 1.136, 1], [-1.02, 0.990], [-0.93, 0.792, 1]]);
    var intake = loop([[-0.935, 0.795, 1], [-1.010, 0.990, 1], [-1.10, 0.950], [-1.14, 0.840], [-1.09, 0.745, 1]]);

    var side = {
      body: body, greenhouse: greenhouse, windows: [doorGlass], pillars: [aPillar, { path: bladeHi, paint: 'body' }],
      doorCuts: [
        curve([[0.98, 0.250], [0.975, 0.520], [0.955, 0.740], [0.92, 0.842]]),
        curve([[-0.62, 0.966], [-0.62, 0.700], [-0.58, 0.450], [-0.58, 0.240]]),
        curve([[0.98, 0.250], [0.20, 0.230], [-0.58, 0.240]])
      ],
      panelLines: [
        curve([[2.292, 0.525], [2.17, 0.615], [2.00, 0.680]]),                              // front lid / bumper seam
        curve([[2.20, 0.340], [2.08, 0.300], [1.88, 0.270]]),                              // bumper / wing seam
        curve([[-1.04, 1.140], [-1.45, 1.108], [-2.00, 1.068]]),                           // engine cover edge
        curve([[-1.70, 0.640], [-1.72, 0.480], [-1.74, 0.300]])                            // rear bumper seam behind the arch
      ],
      characterLines: [
        curve([[0.98, 0.700], [0.40, 0.735], [-0.10, 0.755], [-0.62, 0.770]]),            // sharp shoulder line into the blade
        curve([[1.95, 0.690], [1.55, 0.748], [1.20, 0.795], [0.98, 0.822]]),               // front wing crest
        curve([[-1.14, 0.960], [-1.45, 0.990], [-1.80, 1.000], [-2.10, 0.995]]),           // rear haunch
        curve([[0.95, 0.300], [0.20, 0.290], [-0.58, 0.300]])                              // sill crease
      ],
      sill: Pth(0.95, 0.130).L(-0.95, 0.130).L(-0.97, 0.175).S([[-0.40, 0.200], [0.40, 0.200], [0.99, 0.175]]).Z(),
      archF: { x: aF, y: rF, r: raF, flare: 0.024 },
      archR: { x: aR, y: rR, r: raR, flare: 0.030 },
      lowerTrim: [
        Pth(2.20, 0.115).L(2.26, 0.130).L(2.29, 0.155).S([[2.10, 0.165], [1.88, 0.220]]).L(1.86, 0.200).S([[2.08, 0.150]]).Z(),
        Pth(-2.09, 0.420).S([[-1.98, 0.282], [-1.82, 0.198]]).L(-1.83, 0.235).S([[-1.96, 0.300], [-2.07, 0.430]]).Z(),
        Pth(0.95, 0.130).L(-0.95, 0.130).L(-0.97, 0.175).S([[-0.40, 0.200], [0.40, 0.200], [0.99, 0.175]]).Z()
      ]
    };

    /* ---- top ---- */
    var top = {
      body: sym([[F, 0, 1], [2.310, 0.22], [2.275, 0.46], [2.18, 0.65], [2.02, 0.80], [1.80, 0.905], [1.55, 0.950], [1.325, 0.962],
        [1.00, 0.950], [0.60, 0.925], [0.20, 0.915], [-0.30, 0.925], [-0.80, 0.950], [-1.325, hw], [-1.65, 0.955],
        [-1.90, 0.915], [-2.03, 0.845], [-2.09, 0.710], [-2.106, 0.460], [R, 0.20], [R, 0]], 1),
      greenhouse: sym([[0.95, 0], [0.93, 0.60], [0.50, 0.69], [-0.25, 0.69], [-0.75, 0.60], [-1.00, 0.45], [-1.05, 0]], 1),
      hood: sym([[2.26, 0], [2.20, 0.40], [2.00, 0.58], [1.50, 0.62], [1.12, 0.60], [1.00, 0]], 1),
      roof: sym([[0.15, 0], [0.13, 0.57], [-0.30, 0.63], [-0.72, 0.55], [-0.80, 0]], 1),
      deck: sym([[-1.06, 0], [-1.07, 0.42], [-1.35, 0.60], [-1.90, 0.63], [-2.06, 0.50], [-2.09, 0]], 1),
      mirrors: pair(loop([[0.62, 0.90], [0.58, 1.02], [0.50, 1.09], [0.43, 1.08], [0.45, 0.98], [0.52, 0.91]]), 1),
      characterLines: [].concat(pair(curve([[2.00, 0.72], [1.60, 0.81], [1.10, 0.80], [0.88, 0.77]]), 1),
        pair(curve([[-1.10, 0.82], [-1.60, 0.86], [-2.02, 0.78]]), 1))
    };

    /* ---- front (z,y) ---- */
    var front = {
      body: sym([[0, H], [0.32, H - 0.008], [0.50, 1.190], [0.62, 1.030], [0.68, 0.920], [0.76, 0.860], [0.86, 0.820],
        [0.93, 0.720], [0.958, 0.580], [hw, 0.460], [0.965, 0.300], [0.935, 0.170], [0.87, 0.117, 1], [0, 0.115]], 0),
      greenhouse: sym([[0, 1.200], [0.42, 1.185], [0.64, 0.900, 1], [0.40, 0.875], [0, 0.870]], 0),
      bumper: sym([[0, 0.530], [0.50, 0.535], [0.92, 0.540, 1], [0.960, 0.340], [0.935, 0.170], [0.87, 0.117, 1], [0, 0.115]], 0),
      // wide, flat hexagonal Singleframe grille
      grille: [sym([[0, 0.520], [0.32, 0.520, 1], [0.42, 0.430, 1], [0.38, 0.220, 1], [0.30, 0.165, 1], [0, 0.165]], 0)],
      // big side intakes, each split into three sections by two blades
      intakes: pair(loop([[0.48, 0.470, 1], [0.88, 0.525, 1], [0.930, 0.360], [0.90, 0.180, 1], [0.48, 0.180, 1], [0.44, 0.320]]), 0),
      // slim angular LED lamps, inner end at the grille top corner, outer end climbing round the wing
      headlights: pair(loop([[0.40, 0.580, 1], [0.60, 0.635], [0.80, 0.690], [0.905, 0.715, 1], [0.915, 0.645, 1],
        [0.80, 0.615], [0.60, 0.565], [0.43, 0.540, 1]]), 0),
      drl: [].concat(
        pair(loop([[0.44, 0.575, 1], [0.60, 0.622], [0.80, 0.676], [0.895, 0.700, 1], [0.897, 0.688, 1], [0.80, 0.664],
          [0.60, 0.610], [0.45, 0.563, 1]]), 0),                                            // upper light-guide blade
        pair(loop([[0.66, 0.600, 1], [0.80, 0.640], [0.88, 0.662, 1], [0.882, 0.652, 1], [0.80, 0.630], [0.665, 0.591, 1]]), 0)),   // lower stripe
      splitter: sym([[0, 0.140], [0.86, 0.132, 1], [0.885, 0.115, 1], [0, 0.113]], 0),
      panelLines: [curve([[-0.76, 0.840], [-0.56, 0.780], [-0.30, 0.748], [0, 0.742], [0.30, 0.748], [0.56, 0.780], [0.76, 0.840]])],
      plateArea: rect(0, 0.300, 0.52, 0.11),
      badgeArea: rect(0, 0.470, 0.14, 0.05)
    };

    /* ---- rear (z,y) ---- */
    var lampR = loop([[0.50, 1.022, 1], [0.89, 1.028, 1], [0.940, 0.980, 1], [0.930, 0.935, 1], [0.52, 0.945, 1]]);
    var rear = {
      body: sym([[0, H], [0.30, H - 0.010], [0.46, 1.185], [0.56, 1.110], [0.66, 1.082], [0.80, 1.072], [0.90, 1.045],
        [0.95, 0.960], [hw, 0.760], [0.965, 0.480], [0.935, 0.270], [0.87, 0.150, 1], [0, 0.140]], 0),
      greenhouse: sym([[0, 1.195], [0.34, 1.185], [0.44, 1.125, 1], [0, 1.110]], 0),              // upright rear screen
      bumper: sym([[0, 0.580], [0.88, 0.590, 1], [0.955, 0.450], [0.935, 0.270], [0.87, 0.150, 1], [0, 0.140]], 0),
      taillights: pair(lampR, 0),
      diffuser: sym([[0, 0.300], [0.50, 0.300, 1], [0.62, 0.240], [0.60, 0.140, 1], [0, 0.140]], 0),
      exhaust: [{ shape: 'oval', cx: 0.64, cy: 0.405, w: 0.20, h: 0.10 }, { shape: 'oval', cx: -0.64, cy: 0.405, w: 0.20, h: 0.10 }],
      panelLines: [curve([[-0.80, 1.068], [-0.40, 1.064], [0, 1.062], [0.40, 1.064], [0.80, 1.068]])],
      plateArea: rect(0, 0.680, 0.52, 0.11),
      badgeArea: rect(0, 0.880, 0.24, 0.03),
      spoiler: sym([[0, 1.080], [0.80, 1.072, 1], [0.80, 1.056, 1], [0, 1.064]], 0)             // retractable lip
    };

    var details = [
      det('side', 'mirror', 'body', loop([[0.64, 0.920], [0.60, 0.985], [0.48, 1.005], [0.42, 0.975], [0.46, 0.928], [0.56, 0.918]])),
      det('side', 'trim', 'black', poly([[0.60, 0.905], [0.64, 0.905], [0.62, 0.925], [0.58, 0.925]])),
      det('side', 'trim', 'carbon', bladeLo),
      det('side', 'intake', 'grille', intake),
      det('side', 'handle', 'black', rrect(-0.40, 0.830, 0.12, 0.012, 0.005)),
      det('side', 'trim', 'black', band([[-0.10, 0.930], [-0.40, 0.948], [-0.62, 0.966]], 0.010)),
      det('side', 'trim', 'light', Pth(2.262, 0.600).S([[2.18, 0.646], [2.06, 0.692]]).L(2.07, 0.670).S([[2.18, 0.624], [2.272, 0.574]]).Z()),
      det('side', 'light', 'light-red', poly([[-2.106, 1.036], [-2.03, 1.046], [-2.03, 1.018], [-2.104, 1.004]])),
      det('side', 'intake', 'grille', Pth(2.25, 0.250).L(2.30, 0.262).L(2.305, 0.380).L(2.262, 0.375).Z()),       // bumper-corner intake
      det('side', 'marker', 'light-amber', rrect(2.18, 0.300, 0.04, 0.016, 0.005)),
      det('side', 'wiper', 'black', curve([[0.92, 0.852], [0.68, 0.935]])),
      det('top', 'wiper', 'black', curve([[0.90, -0.45], [0.80, 0.20]])),
      det('top', 'glass', 'glass', rrect(-1.08, 0, 0.05, 0.62, 0.02)),                       // upright rear screen seen from above
      det('top', 'spoiler', 'body', rrect(-2.07, 0, 0.03, 1.40, 0.01)),
      det('rear', 'vent', 'grille', sym([[0, 0.560], [0.80, 0.570, 1], [0.900, 0.440], [0.82, 0.320, 1], [0, 0.320]], 0)),   // full-width rear grille
      det('rear', 'vent', 'grille', sym([[0, 1.018], [0.48, 1.020, 1], [0.50, 0.950, 1], [0, 0.940]], 0)),                    // black panel between the lamps
      det('rear', 'trim', 'light-red', rrect(0, 1.200, 0.16, 0.012, 0.004))                                             // third brake light
    ].concat(
      // glazed engine cover over the V10, framed by black louvre panels
      detPair('top', 'glass', 'glass', loop([[-1.16, 0.04, 1], [-1.18, 0.36], [-1.40, 0.50], [-1.85, 0.52, 1], [-1.95, 0.40], [-1.95, 0.04, 1]])),
      detPair('top', 'vent', 'black', loop([[-1.42, 0.54, 1], [-1.86, 0.56, 1], [-1.88, 0.62, 1], [-1.40, 0.60, 1]])),
      detPair('front', 'intake', 'grille', loop([[0.50, 0.455, 1], [0.865, 0.505, 1], [0.905, 0.360], [0.88, 0.195, 1], [0.50, 0.195, 1], [0.465, 0.320]])),
      slats('front', 0.62, 0.76, 2, 0.48, 0.19, 'gloss-black'),                                                         // intake blades
      detPair('front', 'trim', 'gloss-black', loop([[0.47, 0.330, 1], [0.92, 0.350, 1], [0.92, 0.335, 1], [0.47, 0.316, 1]])),   // horizontal blade
      detPair('rear', 'trim', 'light-red', loop([[0.54, 1.005, 1], [0.88, 1.010, 1], [0.92, 0.978, 1], [0.92, 0.968, 1], [0.88, 0.998, 1], [0.54, 0.994, 1]])),   // LED line
      detPair('rear', 'trim', 'chrome', ring(ellipse(0.64, 0.405, 0.10, 0.05), ellipse(0.64, 0.405, 0.085, 0.038))),
      slats('rear', 0.10, 0.50, 5, 0.29, 0.15, 'carbon'),
      detPair('rear', 'light', 'light-red', rrect(0.86, 0.300, 0.06, 0.02, 0.008))                                   // reflectors
    );

    var m = {
      id: 'audi-r8-v10-gen2', make: 'Audi', name: 'R8 V10', gen: 'Type 4S', years: '2015–2023',
      style: 'hypercar', enginePosition: 'mid', drivetrain: 'awd', powertrain: 'ice', doors: 2,
      ref: { length: L, width: W, height: H, wheelbase: WB, trackF: 1.638, trackR: 1.599, frontOverhang: FO, rearOverhang: RO,
        wheelDiameter_in: 20, tireF: '245/30R20', tireR: '305/30R20', groundClearance: 0.115, rideHeight: 0.130, cd: 0.36,
        curbWeight_kg: 1640 },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Slim angular LED lamps rising from the grille corners round onto the wings, with an upper light-guide blade and a lower LED stripe',
        taillights: 'Slim horizontal LED tail lamps at the upper corners joined by a black panel; a full-width black grille in the bumper carries two big oval tailpipes',
        grille: 'Wide, flat hexagonal Singleframe grille with honeycomb mesh between large side intakes split by blades, carbon splitter',
        notes: 'Blunt upright nose, sharp shoulder line, the split sideblade behind the door framing the engine intake, upright rear screen and glazed engine cover over the V10'
      },
      sources: ['audi.com R8 Coupé V10 technical data', 'auto-data.net Audi R8 II (4S)']
    };
    m.sections = buildSections(m, [
      [2.310, 0.010, 0.32, 0.025, 0.22, 0.035, 0.10, 0.040, 0],
      [2.20, 0.000, 0.64, 0.040, 0.44, 0.060, 0.20, 0.070, 0],
      [1.90, 0.000, 0.76, 0.060, 0.54, 0.090, 0.26, 0.100, 0],
      [1.50, 0.000, 0.81, 0.060, 0.58, 0.090, 0.28, 0.100, 0],
      [1.10, 0.000, 0.81, 0.050, 0.60, 0.075, 0.30, 0.085, 0],
      [0.98, 0.000, 0.79, 0.040, 0.63, 0.060, 0.32, 0.065, 0],
      [0.92, 0.020, 0.80, 0.010, 0.69, 0.000, 0.57, 0.030, 1],
      [0.50, 0.170, 0.81, 0.130, 0.70, 0.020, 0.58, 0.000, 1],
      [0.00, 0.330, 0.79, 0.290, 0.71, 0.035, 0.57, 0.000, 1],
      [-0.40, 0.320, 0.80, 0.275, 0.70, 0.035, 0.56, 0.000, 1],
      [-0.85, 0.180, 0.82, 0.130, 0.67, 0.035, 0.50, 0.020, 1],
      [-1.07, 0.100, 0.85, 0.050, 0.63, 0.020, 0.42, 0.050, 0],
      [-1.40, 0.000, 0.87, 0.030, 0.63, 0.050, 0.36, 0.060, 0],
      [-1.80, 0.000, 0.85, 0.030, 0.60, 0.050, 0.34, 0.055, 0],
      [-2.02, 0.000, 0.77, 0.025, 0.55, 0.040, 0.30, 0.045, 0],
      [-2.10, 0.000, 0.65, 0.020, 0.46, 0.030, 0.25, 0.035, 0]
    ], { screen: [0.12, 0.93], crispTail: 0.26 });
    m.wheel = { spokes: 10, style: 'split', finish: '#3a3d41', caliper: '#c8102e', design: '20in 5-twin-spoke' };
    return m;
  }

  /* Renderer signatures (fixed vocabulary shared by every model file: the 3D and SVG renderers draw the lamp,
     tail-lamp and grille graphics from these) and the text-only front / rear badges. */
  var LOOK = {
    'lamborghini-huracan-evo': [{ head: 'y-blade', tail: 'y-shape', grille: 'hex' }, 'LAMBORGHINI', 'LAMBORGHINI'],
    'ferrari-296-gtb': [{ head: 'slim-led', tail: 'slim', grille: 'mesh' }, 'FERRARI', 'FERRARI'],
    'porsche-918-spyder': [{ head: 'slim-led', tail: 'light-bar', grille: 'mesh' }, 'PORSCHE', 'PORSCHE'],
    'koenigsegg-jesko': [{ head: 'slim-led', tail: 'c-ring', grille: 'mesh' }, 'KOENIGSEGG', 'KOENIGSEGG'],
    'audi-r8-v10-gen2': [{ head: 'blade', tail: 'slim', grille: 'hex' }, 'AUDI', 'AUDI']
  };
  var list = [huracan(), f296(), p918(), jesko(), r8gen2()];
  list.forEach(function (m) {
    var L = LOOK[m.id];
    m.look = { head: L[0].head, tail: L[0].tail, grille: L[0].grille };
    m.front.badgeText = L[1]; m.rear.badgeText = L[2];
  });
  list.forEach(register);
  if (typeof module !== 'undefined' && module.exports) module.exports = list;
})();

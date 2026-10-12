/* FORGE Atelier — shape library: real shooting-brake models.
   Porsche Taycan 4S Cross Turismo (Y1B), Ferrari GTC4Lusso (F151M), Mercedes-Benz CLS 500 Shooting Brake (X218).

   All geometry is in meters at the real car's published dimensions.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles on the ground centerline.
   Side view uses (x, y); top view (x, z); front & rear views (z, y).
   Paths are arrays of segments { t: 'M'|'L'|'C'|'Q'|'Z', p: [[a, b], ...] }.

   Compound fields (single path that may contain several M..Z sub-paths): side.sill, side.lowerTrim, top.mirrors.
   Array fields (one path per element): side.windows/pillars/doorCuts/panelLines/characterLines,
   front.grille/intakes/headlights/drl, rear.taillights.
   Open paths (no Z) are stroke-only lines: doorCuts, panelLines, characterLines.

   Brand names are text only — no logo artwork; badgeArea only marks where a text badge goes.
   Classic script, zero deps, no DOM. Registers via CB.shapes.registerModel, or queues on CB.shapes._pending. */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ geometry helpers (file-local) */

  function r4(v) { return Math.round(v * 10000) / 10000; }
  function P(p) { return [r4(p[0]), r4(p[1])]; }
  function dir(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.sqrt(dx * dx + dy * dy) || 1;
    return [dx / l, dy / l];
  }
  function dist(a, b) { return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])); }
  function unit(v) { var l = Math.sqrt(v[0] * v[0] + v[1] * v[1]) || 1; return [v[0] / l, v[1] / l]; }
  function isCorner(n) { return n.length > 2 && n[2] === 1; }

  /* Smooth G1 spline through nodes (cubic beziers, chord/3 handle lengths — no overshoot lumps).
     A node [a, b, 1] is a sharp corner. Open chains: ends are corners unless t0/t1 directions are given. */
  function splineSegs(nodes, closed, t0, t1) {
    var n = nodes.length, tin = new Array(n), tout = new Array(n), i;
    function at(k) { return nodes[(k + n) % n]; }
    for (i = 0; i < n; i++) {
      var end = !closed && (i === 0 || i === n - 1);
      if (!end && !isCorner(nodes[i])) { tin[i] = tout[i] = dir(at(i - 1), at(i + 1)); }
    }
    // corners and open ends: one-sided tangents, reflected off the smooth neighbour (natural end condition)
    var sm = tin.slice();
    for (i = 0; i < n; i++) {
      if (sm[i]) continue;
      if (closed || i < n - 1) {
        var c = dir(nodes[i], at(i + 1)), tn = sm[(i + 1) % n];
        tout[i] = tn ? unit([2 * c[0] - tn[0], 2 * c[1] - tn[1]]) : c;
      }
      if (closed || i > 0) {
        var c2 = dir(at(i - 1), nodes[i]), tp = sm[(i - 1 + n) % n];
        tin[i] = tp ? unit([2 * c2[0] - tp[0], 2 * c2[1] - tp[1]]) : c2;
      }
    }
    if (!closed && t0) tout[0] = unit(t0);
    if (!closed && t1) tin[n - 1] = unit(t1);
    var segs = [], last = closed ? n : n - 1;
    for (i = 0; i < last; i++) {
      var a = nodes[i], b = at(i + 1), d = dist(a, b) / 3, ta = tout[i], tb = tin[(i + 1) % n];
      segs.push({ t: 'C', p: [P([a[0] + ta[0] * d, a[1] + ta[1] * d]), P([b[0] - tb[0] * d, b[1] - tb[1] * d]), P(b)] });
    }
    return segs;
  }

  function arcSegs(cx, cy, r, a0, a1) { // degrees, CCW in (a,b) space
    var segs = [], n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90)), da = (a1 - a0) / n;
    for (var i = 0; i < n; i++) {
      var s = (a0 + da * i) * Math.PI / 180, e = (a0 + da * (i + 1)) * Math.PI / 180;
      var k = 4 / 3 * Math.tan((e - s) / 4);
      var p0 = [cx + r * Math.cos(s), cy + r * Math.sin(s)], p3 = [cx + r * Math.cos(e), cy + r * Math.sin(e)];
      segs.push({ t: 'C', p: [P([p0[0] - k * r * Math.sin(s), p0[1] + k * r * Math.cos(s)]),
        P([p3[0] + k * r * Math.sin(e), p3[1] - k * r * Math.cos(e)]), P(p3)] });
    }
    return segs;
  }
  function arcPt(cx, cy, r, a) { a = a * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }

  // chainable builder for paths that mix splines, lines and arcs
  function B() {
    var s = [], cur = null, api;
    api = {
      M: function (p) { s.push({ t: 'M', p: [P(p)] }); cur = p; return api; },
      L: function (p) { s.push({ t: 'L', p: [P(p)] }); cur = p; return api; },
      S: function (pts, o) { // smooth through pts from current point
        o = o || {};
        Array.prototype.push.apply(s, splineSegs([[cur[0], cur[1], 1]].concat(pts), false, o.t0, o.t1));
        cur = pts[pts.length - 1]; return api;
      },
      A: function (cx, cy, r, a0, a1) { Array.prototype.push.apply(s, arcSegs(cx, cy, r, a0, a1)); cur = arcPt(cx, cy, r, a1); return api; },
      Z: function () { s.push({ t: 'Z', p: [] }); return api; },
      get: function () { return s; }
    };
    return api;
  }

  function loop(pts) { return [{ t: 'M', p: [P(pts[0])] }].concat(splineSegs(pts, true), [{ t: 'Z', p: [] }]); }
  function line(pts, o) { return B().M(pts[0]).S(pts.slice(1), o).get(); }
  function poly(pts) {
    var s = [{ t: 'M', p: [P(pts[0])] }];
    for (var i = 1; i < pts.length; i++) s.push({ t: 'L', p: [P(pts[i])] });
    s.push({ t: 'Z', p: [] }); return s;
  }
  function rrect(a0, b0, a1, b1, rad) {
    var x0 = Math.min(a0, a1), x1 = Math.max(a0, a1), y0 = Math.min(b0, b1), y1 = Math.max(b0, b1);
    var r = Math.min(rad || 0, (x1 - x0) / 2, (y1 - y0) / 2);
    if (r <= 0) return poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    return B().M([x0 + r, y0]).L([x1 - r, y0]).A(x1 - r, y0 + r, r, -90, 0).L([x1, y1 - r]).A(x1 - r, y1 - r, r, 0, 90)
      .L([x0 + r, y1]).A(x0 + r, y1 - r, r, 90, 180).L([x0, y0 + r]).A(x0 + r, y0 + r, r, 180, 270).Z().get();
  }
  function ellipse(cx, cy, rx, ry) {
    var k = 0.5522847498;
    return [{ t: 'M', p: [P([cx + rx, cy])] },
      { t: 'C', p: [P([cx + rx, cy + ry * k]), P([cx + rx * k, cy + ry]), P([cx, cy + ry])] },
      { t: 'C', p: [P([cx - rx * k, cy + ry]), P([cx - rx, cy + ry * k]), P([cx - rx, cy])] },
      { t: 'C', p: [P([cx - rx, cy - ry * k]), P([cx - rx * k, cy - ry]), P([cx, cy - ry])] },
      { t: 'C', p: [P([cx + rx * k, cy - ry]), P([cx + rx, cy - ry * k]), P([cx + rx, cy])] },
      { t: 'Z', p: [] }];
  }
  function compound() { var s = []; for (var i = 0; i < arguments.length; i++) s = s.concat(arguments[i]); return s; }

  /* Mirror helpers. Front/rear views are (z, y): mirror the FIRST coordinate. Top view is (x, z): mirror the SECOND.
     A "half" runs from the axis (top / nose) round the +side to the axis (bottom / tail). */
  function mirA(p) { return p.length > 2 ? [-p[0], p[1], p[2]] : [-p[0], p[1]]; }
  function mirB(p) { return p.length > 2 ? [p[0], -p[1], p[2]] : [p[0], -p[1]]; }
  function symFull(half, mir) {
    var back = half.slice(1, -1).reverse().map(mir);
    return half.concat(back);
  }
  function symA(half) { return loop(symFull(half, mirA)); }
  function symB(half) { return loop(symFull(half, mirB)); }
  function pairA(pts) { return [loop(pts), loop(pts.slice().reverse().map(mirA))]; }
  function rrectPairA(z0, y0, z1, y1, rad) { return [rrect(z0, y0, z1, y1, rad), rrect(-z1, y0, -z0, y1, rad)]; }
  function circPairA(z, y, r) { return [ellipse(z, y, r, r), ellipse(-z, y, r, r)]; }

  /* Wheel-arch helpers for the side body (x forward). The opening meets the sill line yb. */
  function archAng(cy, r, yb) { return Math.asin(Math.max(-1, Math.min(1, (yb - cy) / r))) * 180 / Math.PI; }
  function archCut(b, a) { // append arch opening (travelling rearward along the underside)
    var t = archAng(a.y, a.r, a.yb);
    return b.L(arcPt(a.x, a.y, a.r, t)).A(a.x, a.y, a.r, t, 180 - t);
  }
  function archBand(a, w) { // black cladding / lip band around the arch opening
    var to = archAng(a.y, a.r + w, a.yb), ti = archAng(a.y, a.r, a.yb);
    return B().M(arcPt(a.x, a.y, a.r + w, to)).A(a.x, a.y, a.r + w, to, 180 - to)
      .L(arcPt(a.x, a.y, a.r, 180 - ti)).A(a.x, a.y, a.r, 180 - ti, ti).Z().get();
  }
  function archBandSq(a, w, h) { // cladding band whose lower ends drop vertically to the sill line (squared-off ends)
    var tk = archAng(a.y, a.r + w, a.yb + h), ti = archAng(a.y, a.r, a.yb);
    var o0 = arcPt(a.x, a.y, a.r + w, tk), o1 = arcPt(a.x, a.y, a.r + w, 180 - tk);
    return B().M([o0[0], a.yb]).L(o0).A(a.x, a.y, a.r + w, tk, 180 - tk).L([o1[0], a.yb])
      .L(arcPt(a.x, a.y, a.r, 180 - ti)).A(a.x, a.y, a.r, 180 - ti, ti).Z().get();
  }
  function frame(outer, inner) { // outline ring: outer polygon + reversed inner polygon (nonzero hole)
    return poly(outer).concat(poly(inner.slice().reverse()));
  }
  function pairPoly(pts) { return [poly(pts), poly(pts.slice().reverse().map(mirA))]; }
  function tireDiameter(spec) { // '245/35R20' -> overall diameter in m
    var m = /^(\d+)\/(\d+)\s*Z?R\s*(\d+)/i.exec(spec);
    return m ? (+m[3] * 25.4 + 2 * (+m[1]) * (+m[2]) / 100) / 1000 : 0.68;
  }
  function D(view, role, path, paint) { return { view: view, role: role, path: path, paint: paint }; }

  /* Tapered blade / strip along a centreline: thickness th0 at the first point, th1 at the last; sharp ends. */
  function taper(pts, th0, th1) {
    var n = pts.length, up = [], dn = [];
    for (var i = 0; i < n; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], d = dir(a, b), nrm = [-d[1], d[0]];
      var h = (th0 + (th1 - th0) * i / (n - 1)) / 2;
      up.push([pts[i][0] + nrm[0] * h, pts[i][1] + nrm[1] * h]);
      dn.push([pts[i][0] - nrm[0] * h, pts[i][1] - nrm[1] * h]);
    }
    up[0].push(1); up[n - 1].push(1); dn[0].push(1); dn[n - 1].push(1);
    return loop(up.concat(dn.reverse()));
  }
  /* Raked louvre slot (side view): x0 (rear) .. x1 (front), centre height yc, height h, rising rearward by rake degrees. */
  function slot(x0, x1, yc, h, rake) {
    var d = (x1 - x0) * Math.tan(rake * Math.PI / 180) / 2, e = h * 0.5;
    return poly([[x1, yc - d - e], [x1 + 0.006, yc - d + e * 0.2], [x1, yc - d + e], [x0, yc + d + e], [x0 - 0.006, yc + d - e * 0.2], [x0, yc + d - e]]);
  }

  /* ------------------------------------------------------------------ explicit 3D cross-sections
     Half rings (ringHalf: bottom centre → right side → top centre, [y, z]) built from the side body, the plan body,
     the plan greenhouse and a per-car belt line: rocker tuck, full-width haunches/shoulders, a sloped shoulder
     shelf onto a narrower tapered greenhouse with tumblehome, a crowned roof, wheel wells stepped in just
     inboard of the tyres, hood dip between fender crests (Taycan) or power domes (CLS). */
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
  function xRange(pts) { var a = Infinity, b = -Infinity; pts.forEach(function (q) { a = Math.min(a, q[0]); b = Math.max(b, q[0]); }); return [a, b]; }
  function tab(t, x) { // piecewise-linear lookup; t sorted by descending x (front → rear)
    if (x >= t[0][0]) return t[0][1];
    for (var i = 1; i < t.length; i++) if (x >= t[i][0]) {
      var k = (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * k;
    }
    return t[t.length - 1][1];
  }
  function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  function plen(p) { var l = 0; for (var i = 1; i < p.length; i++) l += Math.sqrt((p[i][0] - p[i - 1][0]) * (p[i][0] - p[i - 1][0]) + (p[i][1] - p[i - 1][1]) * (p[i][1] - p[i - 1][1])); return l; }
  function tireWidth(spec) { var m = /^(\d+)\//.exec(spec); return m ? +m[1] / 1000 : 0.25; }

  /* Explicit per-vertex glass flags (core: section.glass, used when its length equals the expanded ring, i.e. for
     ringVerts GV). Core resamples each half ring uniformly by arc length (resampleOpen); this replicates that so the
     flags follow arc fractions: side glass = belt vertex .. rail vertex (glassFrac [f0, f1], the glass edge sits on the
     same vertex row on every station: no saw-tooth), windscreen = belt .. roof centre, tailgate = rows above the
     tailgate-glass base. Other ring counts fall back to core's belt + roof-normal rule. */
  var GV = 40;
  function glassFlags(ring, sec, nv) {
    var Lc = [0], i;
    for (i = 1; i < ring.length; i++) Lc.push(Lc[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
    var T = Lc[Lc.length - 1] || 1, f0 = Lc[sec.iB] / T, f1 = sec.kind === 'side' ? Lc[sec.iR] / T : 1, hv = nv / 2, gh = [], j = 0;
    for (var k = 0; k <= hv; k++) {                                                      // resampleOpen(ring, hv + 1)
      var d = T * k / hv;
      while (j < ring.length - 2 && Lc[j + 1] < d) j++;
      var sg = Lc[j + 1] - Lc[j] || 1, t = Math.max(0, Math.min(1, (d - Lc[j]) / sg)), y = ring[j][0] + (ring[j + 1][0] - ring[j][0]) * t;
      var fk = k / hv, on = sec.kind === 'tailgate' ? y > sec.hatchY + 0.01 && fk > f0 - 0.5 / hv
        : fk > f0 - 0.5 / hv && fk < f1 + 0.5 / hv;
      gh.push(on ? 1 : 0);
    }
    var full = gh.slice();
    for (k = hv - 1; k >= 1; k--) full.push(gh[k]);
    return { flags: full, frac: [r4(f0), r4(f1)] };
  }

  function buildSections(m, c) {
    var sb = flat(m.side.body), tb = flat(m.top.body), tg = flat(m.top.greenhouse), dl = flat(m.side.greenhouse);
    var r = m.ref, W = r.width / 2, X = xRange(sb), TG = xRange(tg), DL = xRange(dl);
    var arches = [m.side.archF, m.side.archR];
    var wells = [[m.side.archF, r.trackF, r.tireF], [m.side.archR, r.trackR, r.tireR]].map(function (A) {
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - tireWidth(A[2]) / 2 - 0.025 };
    });
    var LOW = c.low || [[0, 0.70], [0.035, 0.885], [0.13, 0.952], [0.36, 0.985], [0.62, 1.0], [0.82, 0.993], [0.90, 0.975], [0.95, 0.935], [0.985, 0.87]];
    function bottom(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.08;
        if (Math.abs(x - a.x) < e) { var l = sliceAt(sb, a.x - e), q = sliceAt(sb, a.x + e); return l[0] + (q[0] - l[0]) * (x - a.x + e) / (2 * e); }
      }
      return sliceAt(sb, x)[0];
    }
    var RF = xRange(flat(m.top.roof))[1];                                              // roof front edge = windscreen top
    function half(pts, x) { var s = sliceAt(pts, x); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : null; }
    function gPlan(x) { return half(tg, Math.max(TG[0] + 0.004, Math.min(TG[1] - 0.004, x))); }
    // stations: cosine-spaced plus landmarks (wheel wells, cowl, DLO ends, roof end, hatch base)
    var xs = [], NS = 52, k;
    for (k = 0; k <= NS; k++) { var t = k / NS; xs.push(X[0] + 0.012 + (X[1] - X[0] - 0.024) * (1 - Math.cos(Math.PI * t)) / 2); }
    wells.forEach(function (wl) {
      [-1.02, -0.85, -0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6, 0.85, 1.02].forEach(function (f) { xs.push(wl.x + f * wl.r); });
    });
    [c.cowlX, DL[0] + 0.01, DL[1] - 0.01, (DL[1] + c.cowlX) / 2, c.roofEndX, c.hatchBaseX].forEach(function (x) { xs.push(x); });
    xs.sort(function (a, b) { return a - b; });
    xs = xs.filter(function (x, i) { return x >= X[0] + 0.01 && x <= X[1] - 0.01 && (i === 0 || x - xs[i - 1] > 0.012); });
    // rounded tail / nose: end-cap stations within 0.02 m of each bumper shrink the ring (core caps the last ring with a fan)
    var CAP = 0.02, ends = [0.0006, 0.004, 0.009];
    xs = ends.map(function (d) { return X[0] + d; }).concat(xs, ends.slice().reverse().map(function (d) { return X[1] - d; }));
    return xs.map(function (x) {
      var dEnd = Math.min(x - X[0], X[1] - x), kCap = dEnd < CAP ? Math.sqrt(1 - Math.pow(1 - dEnd / CAP, 2)) : 1;
      var xq = Math.max(X[0] + 0.01, Math.min(X[1] - 0.01, x));                          // end caps reuse the last full slice
      var sec = ringAt(xq);
      if (kCap < 1) {
        var kw = 0.3 + 0.7 * kCap, kh = 0.5 + 0.5 * kCap, yc = (sec.ring[0][0] + sec.yTop) / 2;
        sec.ring = sec.ring.map(function (q) { return [yc + (q[0] - yc) * kh, q[1] * kw]; });
        sec.belt = null;
      }
      var ring = sec.ring.map(P), out = { x: r4(x), ring: ring, ringHalf: true, belt: sec.belt == null ? null : r4(sec.belt) };
      if (sec.belt != null) {
        var g = glassFlags(ring, sec, GV);
        out.glassFrac = g.frac;
        out.glass = g.flags;
      }
      return out;
    });
    function ringAt(x) {
      var s = sliceAt(sb, x), yTop = s[1], yb = Math.min(bottom(x), yTop - 0.12);
      var w = Math.min(half(tb, x) || 0.3, W);
      var yBelt = Math.min(tab(c.belt, x), yTop - 0.012);
      var ds0 = sliceAt(dl, x);                                                            // follow the real DLO bottom along the side glass
      if (ds0 && x > DL[0] + 0.005 && x < DL[1] - 0.005 && ds0[1] - ds0[0] > 0.03) yBelt = Math.min(ds0[0] - 0.004, yTop - 0.03);
      // cabin weight: 1 between hatch base and cowl, fading to the flat hood / tail deck
      var kc = x <= c.cowlX && x >= c.hatchBaseX ? 1 : 1 - smooth01((x > c.cowlX ? x - c.cowlX : c.hatchBaseX - x) / 0.35);
      var gFlat = (x > 0 ? c.hoodFrac || 0.84 : 0.84) * w;
      // loft cabin plan: the plan-view DLO tapers to a point at the side-glass tail, but the roof and tailgate carry on
      // full-width to the roof end / hatch base, so the loft uses the wider of the two behind the DLO tail
      var gp = gPlan(x);
      if (c.cabinPlan && x < DL[0] + 0.1) gp = Math.max(gp, tab(c.cabinPlan, x));
      var gB = gFlat + (Math.min(gp, 0.92 * w - 0.02) - gFlat) * kc;
      var H = Math.max(0, yTop - yBelt), cr = Math.min(c.crown || 0.045, 0.3 * H) + 0.002;
      // D-pillar / tailgate flanks behind the DLO tail stand more upright in section than the door glass
      var tb0 = (c.tumble || 0.36) * (c.cabinPlan ? 1 - 0.55 * smooth01((DL[0] + 0.05 - x) / 0.15) : 1);
      var yRail = yTop - cr, gR = Math.max(0.2, gB - tb0 * Math.max(0, yRail - yBelt));
      var h = [[yb, 0]];
      LOW.forEach(function (q) { h.push([yb + q[0] * (yBelt - yb), q[1] * w]); });
      h.push([yBelt - 0.006, gB + 0.12 * (LOW[LOW.length - 1][1] * w - gB)]);           // shoulder rolls ~25 deg up into the glass
      var up = [];
      for (k = 0; k <= 3; k++) {                                                            // side glass with tumblehome
        var u = k / 3;
        up.push([yBelt + 0.004 + u * (yRail - yBelt - 0.004), gB + (gR - gB) * u + 0.012 * Math.sin(Math.PI * u) * kc]);
      }
      // crowned roof: the first crown vertex sits well inboard (60 deg), so every resampled roof vertex has a roof-like
      // normal (ny > 0.97) and the side-glass top edge stops cleanly at the rail on every station
      [60, 80, 90].forEach(function (deg) {
        var a = deg * Math.PI / 180; up.push([yRail + cr * Math.sin(a), gR * Math.cos(a)]);
      });
      // hood dip between fender crests / power domes / deck
      var fl = 1 - kc;
      if (fl > 0 && x > 0 && (c.dip || c.domes)) {
        var dip = c.dip ? c.dip[1] + (c.dip[0] - c.dip[1]) * smooth01((x - c.cowlX) / (X[1] - c.cowlX)) : 0;
        up = up.map(function (q) {
          var zz = Math.min(1, q[1] / gB), y = q[0] - fl * dip * (1 - zz * zz);
          if (c.domes && x > c.domes[0] && x < c.domes[1]) y += fl * c.domes[2] * Math.exp(-Math.pow((q[1] - c.domes[3]) / 0.11, 2));
          return [y, q[1]];
        });
      }
      h = h.concat(up);
      // wheel wells: skin below the arch top steps in to just inboard of the tyre, blended over +-0.04 m in y
      // (and faded over the last 8% of the arch radius in x) so the well edge does not streak between stations
      wells.forEach(function (wl) {
        var dx = x - wl.x; if (Math.abs(dx) >= wl.r * 0.99) return;
        var yA = wl.y + Math.sqrt(wl.r * wl.r - dx * dx), kx = smooth01((wl.r * 0.99 - Math.abs(dx)) / (0.08 * wl.r));
        h = h.map(function (q, i) {
          if (i === 0 || i > LOW.length || q[1] <= wl.zIn) return q;
          var kw = kx * smooth01((yA + 0.04 - q[0]) / 0.08);
          return [q[0], q[1] + (wl.zIn - q[1]) * kw];
        });
      });
      // glass belt (core glazes ring vertices above belt + 0.02 whose normals are not roof-like)
      var belt = null, ds = sliceAt(dl, x);
      if (ds && x > DL[0] + 0.005 && x < DL[1] - 0.005 && ds[1] - ds[0] > 0.03) belt = ds[0];
      else if (x > RF && x < c.cowlX - 0.03 && x >= DL[1] - 0.03) belt = yBelt + 0.01;          // windscreen foot (stops short of the cowl)
      else if (x < c.roofEndX && x >= c.hatchBaseX) belt = c.hatchGlassY;                   // tailgate glass
      /* Glass-edge alignment: core resamples each half ring uniformly by arc length and glazes per vertex. A hidden
         zero-width centre-line fin rising from the floor (inside the body, mirrored onto itself) pads the lower arc
         so the glass bottom (first point of `up`) sits at the same arc fraction fB on every station. Vertex rows then
         follow the DLO bottom from station to station (no saw-tooth glass, no twisting). Nothing pads the roof, so no
         interior faces can be glazed. */
      var nLow = h.length - up.length, L1 = plen(h.slice(0, nLow + 1)), L2 = plen(h.slice(nLow)), fB = c.fB || 0.7;
      var F1 = Math.min(0.9 * (yBelt - yb), (fB / (1 - fB) * L2 - L1) / 2);
      if (F1 > 0.002) h = [[yb, 0], [yb + F1, 0]].concat(h);
      // glass threshold just under the aligned belt vertex (core glazes y > belt + 0.02)
      var gBelt = belt == null ? null : Math.min(belt, up[0][0] - 0.024);
      var iB = h.length - up.length, kind = belt == null ? null : x < c.roofEndX ? 'tailgate' : x > RF ? 'screen' : 'side';
      return { ring: h, belt: gBelt, yTop: yTop, iB: iB, iR: iB + 3, kind: kind, hatchY: c.hatchGlassY };
    }
  }

  /* ================================================================== 1. Porsche Taycan 4S Cross Turismo */
  function taycanCrossTurismo() {
    var ref = { length: 4.974, width: 1.967, widthMirrors: 2.144, height: 1.409, wheelbase: 2.904, trackF: 1.718, trackR: 1.698,
      frontOverhang: 0.965, rearOverhang: 1.105, wheelDiameter_in: 19, tireF: '225/55R19', tireR: '275/45R19',
      groundClearance: 0.146, rideHeight: 0.146, cd: 0.26, curbWeight_kg: 2245 };
    var hw = ref.wheelbase / 2, xf = hw + ref.frontOverhang, xr = -hw - ref.rearOverhang, H = ref.height, W = ref.width / 2;
    var rF = tireDiameter(ref.tireF) / 2, rR = tireDiameter(ref.tireR) / 2, yb = 0.22;
    var aF = { x: hw, y: rF, r: rF + 0.045, yb: yb }, aR = { x: -hw, y: rR, r: rR + 0.045, yb: yb };

    // ---------- side
    var b = B().M([2.33, 0.18]);
    archCut(b, aF).L([-hw + Math.sqrt(aR.r * aR.r - (aR.y - yb) * (aR.y - yb)), yb]);
    archCut(b, aR).L([-2.40, 0.235])
      .S([[-2.47, 0.30], [-2.532, 0.40], [-2.545, 0.45], [xr, 0.70], [-2.545, 0.93], [-2.505, 0.965, 1], [-2.40, 1.06], [-2.26, 1.17], [-2.14, 1.255, 1],
        [-2.07, 1.29], [-1.70, 1.352], [-1.05, 1.398], [-0.52, H], [-0.10, 1.386, 1], [0.38, 1.17], [0.80, 0.975, 1],
        [1.30, 0.895], [1.80, 0.852], [2.12, 0.805], [2.30, 0.755], [2.385, 0.68], [2.412, 0.57], [xf, 0.45], [2.40, 0.32], [2.36, 0.235]])
      .Z();
    var sideBody = b.get();
    // DLO: long falling roof line meeting a rising lower edge in a sharp, upward-kicked point under the roof rail
    var greenhouse = loop([[0.66, 0.955, 1], [0.22, 1.19], [-0.13, 1.356], [-0.62, 1.384], [-1.30, 1.368], [-1.76, 1.33], [-1.98, 1.262], [-2.07, 1.205, 1],
      [-2.015, 1.095], [-1.80, 1.025], [-1.43, 0.99], [-0.40, 0.975]]);
    var windows = [
      loop([[0.58, 0.965, 1], [0.17, 1.19], [-0.12, 1.334], [-0.43, 1.348, 1], [-0.47, 0.982, 1], [0.05, 0.972]]),
      loop([[-0.55, 0.983, 1], [-0.51, 1.348, 1], [-0.90, 1.343], [-1.27, 1.333, 1], [-1.35, 0.991, 1], [-0.95, 0.986]]),
      loop([[-1.43, 0.995, 1], [-1.405, 1.326, 1], [-1.74, 1.306], [-1.95, 1.246], [-2.04, 1.20, 1], [-1.98, 1.10], [-1.80, 1.04], [-1.60, 1.008]])
    ];
    var pillars = [
      poly([[-0.43, 1.348], [-0.51, 1.348], [-0.55, 0.983], [-0.47, 0.982]]),
      poly([[-1.27, 1.333], [-1.405, 1.326], [-1.43, 0.995], [-1.35, 0.991]])
    ];
    var doorCuts = [
      line([[0.66, 0.958], [0.80, 0.74], [0.89, 0.50], [0.90, 0.28]], { t0: [0.45, -1] }),
      line([[-0.47, 0.982], [-0.50, 0.62], [-0.52, 0.28]]),
      line([[-1.36, 0.992], [-1.21, 0.80], [-1.07, 0.62], [-0.99, 0.43], [-0.99, 0.28]]),
      line([[0.90, 0.28], [-0.99, 0.28]]),
      line([[0.62, 0.99], [0.20, 1.215], [-0.14, 1.372], [-0.62, 1.398], [-1.36, 1.38]], { t0: [-0.9, 0.48] })
    ];
    var panelLines = [
      line([[0.80, 0.975], [1.50, 0.882], [2.17, 0.772]]),                       // frunk lid shut line along fender crest
      line([[-2.02, 1.30], [-2.25, 1.13], [-2.43, 0.97], [-2.52, 0.76], [-2.535, 0.58]]), // tailgate
      rrect(0.93, 0.705, 1.16, 0.80, 0.02)                                       // charge-port flap (both front fenders)
    ];
    var characterLines = [
      line([[0.92, 0.905], [0.0, 0.905], [-1.10, 0.925], [-1.70, 0.94], [-2.25, 0.93], [-2.50, 0.905]]), // shoulder over rear haunch
      line([[1.02, 0.45], [0.0, 0.47], [-0.98, 0.51]]),                          // concave lower-door "side blade" crease
      line([[2.05, 0.80], [1.452, 0.875], [0.88, 0.93]])                         // front fender crest
    ];
    var sill = compound(poly([[1.06, 0.22], [-1.06, 0.22], [-1.04, 0.30], [1.04, 0.30]]));
    var lowerTrim = compound(
      archBandSq(aF, 0.065, 0.08), archBandSq(aR, 0.065, 0.08),                  // Off-road Design arch cladding, squared ends
      poly([[1.07, 0.22], [-1.07, 0.22], [-1.06, 0.30], [1.06, 0.30]]),          // rocker cladding up to y = 0.30
      loop([[2.33, 0.18, 1], [1.83, 0.205, 1], [1.88, 0.27], [2.30, 0.28], [2.385, 0.27, 1]]), // front lower cladding
      loop([[-1.85, 0.22, 1], [-2.40, 0.235, 1], [-2.47, 0.30], [-2.533, 0.40, 1], [-2.25, 0.40], [-1.95, 0.33, 1]]) // black diffuser cladding below y = 0.40
    );

    // ---------- top (x, z)
    var top = {
      body: symB([[xf, 0], [2.405, 0.30], [2.36, 0.58], [2.26, 0.80], [2.05, 0.93], [1.70, 0.962], [hw, 0.966], [1.00, 0.955],
        [0.30, 0.935], [-0.50, 0.946], [-1.10, 0.975], [-hw, W], [-1.85, 0.976], [-2.20, 0.93], [-2.42, 0.84], [-2.52, 0.68],
        [-2.553, 0.40], [xr, 0]]),
      // plan taper: 0.74 at the B-pillar, 0.66 at x = -1.6, 0.52 at the roof end, 0.42 at the tailgate top
      greenhouse: symB([[0.66, 0], [0.655, 0.40], [0.60, 0.62], [0.36, 0.715], [-0.40, 0.74], [-1.00, 0.712], [-1.60, 0.66],
        [-1.88, 0.58], [-1.99, 0.52], [-2.06, 0.42, 1], [-2.07, 0]]),
      hood: symB([[2.33, 0], [2.315, 0.38], [2.27, 0.56, 1], [1.60, 0.55], [0.84, 0.50, 1], [0.82, 0]]),   // trapezoid between the fender crests
      roof: symB([[-0.05, 0], [-0.07, 0.52], [-0.30, 0.60], [-1.00, 0.585], [-1.60, 0.53], [-1.85, 0.45], [-1.95, 0.36, 1], [-1.96, 0]]),
      deck: symB([[-2.10, 0], [-2.10, 0.55], [-2.30, 0.60], [-2.48, 0.62], [-2.53, 0.40], [-2.54, 0]]),
      mirrors: [   // one path per side
        loop([[0.62, 0.93], [0.60, 1.04], [0.54, ref.widthMirrors / 2], [0.45, 1.064], [0.42, 1.0], [0.48, 0.93]]),
        loop([[0.48, -0.93], [0.42, -1.0], [0.45, -1.064], [0.54, -ref.widthMirrors / 2], [0.60, -1.04], [0.62, -0.93]])]
    };

    // ---------- front (z, y)
    var front = {
      // raised fender peaks stand proud outboard of the A-pillar feet (crest z 0.86, y 0.94), falling steeply to the shoulder
      body: symA([[0, H], [0.35, 1.398], [0.56, 1.37], [0.66, 1.25], [0.72, 1.07], [0.765, 0.99, 1], [0.80, 0.948], [0.855, 0.94], [0.915, 0.895],
        [0.955, 0.81], [W, 0.72], [0.98, 0.55], [0.965, 0.40], [0.95, 0.335, 1], [0.75, 0.30, 1], [0.74, 0.20], [0.60, 0.172], [0, 0.165]]),
      greenhouse: symA([[0, 1.376], [0.56, 1.36], [0.66, 1.25], [0.75, 1.0, 1], [0, 0.98]]),
      // front fascia: its top edge is the bonnet leading edge, dipping to 0.80 at the centre and humping over each lamp
      bumper: symA([[0, 0.80], [0.30, 0.808], [0.50, 0.83], [0.64, 0.862], [0.76, 0.878], [0.86, 0.866], [0.925, 0.82], [0.958, 0.72], [0.968, 0.56],
        [0.955, 0.45], [0.93, 0.21], [0.60, 0.172], [0, 0.165]]),
      grille: [symA([[0, 0.37], [0.50, 0.369], [0.58, 0.36, 1], [0.58, 0.215, 1], [0.50, 0.21], [0, 0.21]])], // wide inlet, split in three
      // black "air curtain" inlets dropping straight from each lamp's lower outboard edge (lamp + inlet read as one tall element)
      intakes: pairA([[0.70, 0.631, 1], [0.78, 0.641], [0.855, 0.655, 1], [0.893, 0.625], [0.90, 0.45], [0.89, 0.36, 1], [0.80, 0.36, 1], [0.77, 0.45], [0.735, 0.56]]),
      // compact upright teardrops (0.24 x 0.18), narrow end pointing down and inboard, centred z = 0.76, y = 0.72
      headlights: pairA([[0.665, 0.625, 1], [0.652, 0.69], [0.672, 0.765], [0.725, 0.806], [0.80, 0.814], [0.858, 0.804], [0.883, 0.79],
        [0.886, 0.745], [0.885, 0.70, 1], [0.858, 0.668], [0.80, 0.646], [0.72, 0.632]]),
      drl: [].concat(rrectPairA(0.72, 0.732, 0.755, 0.767, 0.006), rrectPairA(0.775, 0.732, 0.81, 0.767, 0.006),
        rrectPairA(0.72, 0.677, 0.755, 0.712, 0.006), rrectPairA(0.775, 0.677, 0.81, 0.712, 0.006)), // 2x2 four-point DRL cluster
      splitter: symA([[0, 0.205], [0.62, 0.198], [0.74, 0.205], [0.73, 0.172], [0, 0.155]]),
      plateArea: rrect(-0.26, 0.385, 0.26, 0.495, 0.01),
      badgeArea: rrect(-0.035, 0.632, 0.035, 0.676, 0.008),
      badgeText: 'PORSCHE'
    };

    // ---------- rear (z, y)
    var rear = {
      body: symA([[0, H], [0.35, 1.40], [0.55, 1.37], [0.62, 1.29], [0.68, 1.18], [0.74, 1.08], [0.80, 1.0], [0.93, 0.935], [0.977, 0.87], [W, 0.76], [0.975, 0.56],
        [0.955, 0.40], [0.94, 0.34, 1], [0.73, 0.32, 1], [0.72, 0.24], [0.58, 0.222], [0, 0.215]]),
      greenhouse: { path: symA([[0, 1.376], [0.56, 1.36], [0.66, 1.25], [0.74, 1.02, 1], [0, 1.0]]), paint: 'body' }, // cabin seen from behind (glass is a detail)
      bumper: symA([[0, 0.82], [0.70, 0.82], [0.93, 0.78], [0.975, 0.56], [0.955, 0.45], [0, 0.45]]),
      lightBar: symA([[0, 0.956], [0.70, 0.956], [0.80, 0.951, 1], [0.80, 0.926, 1], [0, 0.926]]),
      // bold outer lamps (0.045 thick at the ends) wrapping round the corners to z = 0.975
      taillights: pairA([[0.70, 0.962, 1], [0.86, 0.964], [0.925, 0.948], [0.962, 0.905], [0.975, 0.86, 1], [0.95, 0.868], [0.912, 0.902], [0.84, 0.92], [0.70, 0.926, 1]]),
      // black lower cladding from y = 0.45 down with a three-fin diffuser
      diffuser: symA([[0, 0.45], [0.80, 0.45], [0.958, 0.45, 1], [0.955, 0.40], [0.94, 0.34, 1], [0.73, 0.32, 1], [0.72, 0.24], [0.58, 0.222], [0, 0.215]]),
      exhaust: [],                                                                // battery-electric: no tailpipes
      spoiler: symA([[0, 1.302], [0.28, 1.2985], [0.56, 1.292], [0.6, 1.266], [0.55, 1.256], [0.275, 1.258], [0, 1.259]]),
      plateArea: rrect(-0.26, 0.48, 0.26, 0.59, 0.01),
      badgeArea: rrect(-0.22, 0.929, 0.22, 0.953, 0.004),                          // lettering inside the light bar
      badgeText: 'PORSCHE'
    };

    var details = [
      D('side', 'mirror', loop([[0.64, 0.962], [0.625, 1.025], [0.56, 1.052], [0.46, 1.048], [0.44, 1.00], [0.49, 0.962]]), 'body'), // door-mounted pod
      D('side', 'handle', rrect(-0.20, 0.895, 0.03, 0.915, 0.008), 'black'),      // flush pop-out handles
      D('side', 'handle', rrect(-1.16, 0.915, -0.95, 0.935, 0.008), 'black'),
      D('side', 'chargePort', rrect(0.94, 0.715, 1.15, 0.79, 0.015), 'body'),
      D('side', 'trim', line([[-0.25, 1.40], [-1.00, 1.392], [-1.70, 1.348], [-1.98, 1.30]], { t0: [-1, -0.01] }), 'black'), // roof rail
      D('side', 'trim', taper([[-1.45, 1.335], [-1.75, 1.322], [-1.97, 1.262], [-2.06, 1.195], [-2.10, 1.13]], 0.045, 0.015), 'black'), // flyline blade
      D('side', 'light', loop([[2.378, 0.655, 1], [2.33, 0.712], [2.26, 0.748], [2.18, 0.778, 1], [2.215, 0.745], [2.29, 0.70], [2.35, 0.656]]), 'light'), // teardrop lamp on the fender crest
      D('side', 'trim', loop([[-2.52, 0.965, 1], [-2.40, 0.968], [-2.36, 0.94], [-2.48, 0.925, 1]]), 'light-red'), // light-bar wrap
      D('front', 'glass', symA([[0, 1.356], [0.27, 1.3518], [0.54, 1.342], [0.5592, 1.301], [0.7, 1, 1], [0, 0.985]]), 'glass'),
      D('front', 'mirror', loop([[0.90, 0.99], [0.98, 1.05], [1.06, 1.045], [ref.widthMirrors / 2, 1.005], [1.03, 0.962], [0.93, 0.96]]), 'body'),
      D('front', 'mirror', loop([[-0.93, 0.96], [-1.03, 0.962], [-ref.widthMirrors / 2, 1.005], [-1.06, 1.045], [-0.98, 1.05], [-0.90, 0.99]]), 'body'),
      // black off-road apron: full width below y = 0.30, wrapping the inlet
      D('front', 'trim', symA([[0, 0.205], [0.585, 0.205, 1], [0.60, 0.30, 1], [0.75, 0.30, 1], [0.74, 0.20], [0.60, 0.172], [0, 0.165]]), 'black'),
      // fender crests running back from the lamp humps to the raised peaks beside the A-pillars
      D('front', 'trim', line([[0.70, 0.884], [0.80, 0.912], [0.855, 0.936]]), 'line'),
      D('front', 'trim', line([[0.70, 0.884], [0.80, 0.912], [0.855, 0.936]].map(mirA)), 'line'),
      D('rear', 'glass', symA([[0, 1.248], [0.26, 1.247], [0.52, 1.241], [0.548, 1.222], [0.58, 1.06, 1], [0, 1.055]]), 'glass'), // tall tailgate glass up to the spoiler
      D('rear', 'wiper', rrect(-0.02, 1.09, 0.36, 1.105, 0.006), 'black'),
      D('rear', 'trim', rrect(-0.008, 0.23, 0.008, 0.40, 0.004), 'carbon')                  // centre diffuser fin
    ].concat(
      rrectPairA(0.20, 0.21, 0.24, 0.37, 0.006).map(function (p) { return D('front', 'trim', p, 'body'); }),   // body-colour inlet bars
      rrectPairA(0.242, 0.23, 0.258, 0.40, 0.004).map(function (p) { return D('rear', 'trim', p, 'carbon'); }), // outer diffuser fins
      rrectPairA(0.70, 0.938, 0.735, 0.958, 0.005).map(function (p) { return D('rear', 'trim', p, 'light-red'); }),
      rrectPairA(0.84, 0.935, 0.875, 0.955, 0.005).map(function (p) { return D('rear', 'trim', p, 'light-red'); }),
      rrectPairA(0.86, 0.38, 0.90, 0.45, 0.01).map(function (p) { return D('rear', 'trim', p, 'light-red'); }),   // bumper reflectors
      rrectPairA(0.84, 0.965, 0.90, 0.99, 0.008).map(function (p) { return D('front', 'trim', p, 'black'); })       // mirror stalks
    );

    var model = {
      id: 'porsche-taycan-cross-turismo', make: 'Porsche', name: 'Taycan 4S Cross Turismo', gen: 'Y1B', years: '2021–2024',
      look: { head: 'oval-4pt', tail: 'light-bar', grille: 'blanked' },   // renderer lamp / grille signature
      style: 'shooting-brake', enginePosition: 'front', drivetrain: 'awd', powertrain: 'ev',
      ref: ref,
      side: { body: sideBody, greenhouse: greenhouse, windows: windows, pillars: pillars, doorCuts: doorCuts, panelLines: panelLines,
        characterLines: characterLines, sill: sill, archF: { x: aF.x, y: aF.y, r: aF.r, flare: 0.02 }, archR: { x: aR.x, y: aR.y, r: aR.r, flare: 0.02 },
        lowerTrim: lowerTrim },
      top: top, front: front, rear: rear, details: details,
      wheel: { design: 'Taycan Aero 19in covered disc', spokes: 10, finish: '#3a3c40', caliper: '#c8102e' },
      signature: {
        wheels: '19in Taycan Aero wheels: near-flat covered disc with a ring of short slots, dark finish, red 4S calipers.',
        headlights: 'Compact upright teardrop matrix-LED lamps on the raised fender crests (narrow end pointing down and inboard), each with a tight 2x2 four-point DRL; a black vertical "air curtain" inlet drops straight from each lamp so lamp and inlet read as one tall element.',
        taillights: 'Full-width glass light bar across the tailgate with PORSCHE lettering inside; bold outer lamps wrap round the corners and carry the four-point brake light graphic.',
        grille: 'No grille: low nose dipping between the fender peaks, wide lower inlet split in three by two body-colour bars, full-width black off-road apron.',
        notes: 'Long sloping wagon roof that ends in a fixed roof spoiler; DLO ends in a sharp upward-kicked point under the roof rail with the black "flyline" blade sweeping down to the light bar; squared-off black arch cladding, rocker and bumper cladding (Off-road Design), three-fin rear diffuser, roof rails, charge flaps on both front fenders.'
      }
    };
    model.sections = buildSections(model, {
      belt: [[2.6, 0.80], [0.80, 0.975], [0.66, 0.958], [-0.40, 0.975], [-1.43, 0.99], [-2.0, 1.02], [-2.40, 1.05], [-2.6, 1.0]],
      cowlX: 0.80, roofEndX: -2.14, hatchBaseX: -2.40, hatchGlassY: 1.055,
      cabinPlan: [[-1.70, 0.64], [-2.00, 0.60], [-2.14, 0.585], [-2.40, 0.58]], crown: 0.04, tumble: 0.36,
      hoodFrac: 0.81, dip: [0.095, 0.045]                                  // hood centre ~0.07 below the fender crests
    });
    return model;
  }

  /* ================================================================== 2. Ferrari GTC4Lusso */
  function gtc4Lusso() {
    var ref = { length: 4.922, width: 1.980, widthMirrors: 2.17, height: 1.383, wheelbase: 2.990, trackF: 1.674, trackR: 1.668,
      frontOverhang: 0.935, rearOverhang: 0.997, wheelDiameter_in: 20, tireF: '245/35ZR20', tireR: '295/35ZR20',
      groundClearance: 0.12, rideHeight: 0.12, cd: 0.32, curbWeight_kg: 1920, dryWeight_kg: 1790 };
    var hw = ref.wheelbase / 2, xf = hw + ref.frontOverhang, xr = -hw - ref.rearOverhang, H = ref.height, W = ref.width / 2;
    var rF = tireDiameter(ref.tireF) / 2, rR = tireDiameter(ref.tireR) / 2, yb = 0.20;
    var aF = { x: hw, y: rF, r: rF + 0.04, yb: yb }, aR = { x: -hw, y: rR, r: rR + 0.04, yb: yb };

    var b = B().M([2.36, 0.145]);
    archCut(b, aF).L([-hw + Math.sqrt(aR.r * aR.r - (aR.y - yb) * (aR.y - yb)), yb]);
    archCut(b, aR).L([-2.34, 0.21])
      // steep Kamm tailgate (~62 deg) under a pronounced roof spoiler, ducktail lip at y = 0.925
      .S([[-2.44, 0.30], [-2.48, 0.45], [xr, 0.66], [-2.488, 0.84], [-2.478, 0.915, 1], [-2.43, 0.952], [-2.378, 0.985, 1], [-2.29, 1.15], [-2.205, 1.315, 1],
        [-2.10, 1.338], [-1.70, 1.356], [-1.10, 1.377], [-0.75, H], [-0.45, 1.356, 1], [-0.04, 1.15], [0.32, 0.955, 1],
        [1.0, 0.887], [1.50, 0.822], [2.0, 0.735], [2.25, 0.655], [2.335, 0.618], [2.385, 0.572], [2.41, 0.50], [2.424, 0.38], [2.42, 0.28], [2.40, 0.21]])
      .Z();
    var sideBody = b.get();
    // DLO: flat top meeting a lower edge that sweeps up from 0.99 (x = -1.30) to 1.12 (x = -2.0) in a sharp rising arrow-point
    var greenhouse = loop([[0.22, 0.935, 1], [-0.10, 1.12], [-0.42, 1.333], [-0.80, 1.356], [-1.50, 1.34], [-1.90, 1.29], [-2.12, 1.20, 1],
      [-2.00, 1.12], [-1.85, 1.08], [-1.30, 0.99], [-0.40, 0.965]]);
    var windows = [
      loop([[0.16, 0.942, 1], [-0.12, 1.12], [-0.40, 1.316], [-0.80, 1.341], [-1.18, 1.336, 1], [-1.22, 0.988, 1], [-0.50, 0.966]]),
      loop([[-1.30, 0.995, 1], [-1.27, 1.332, 1], [-1.55, 1.324], [-1.88, 1.282], [-2.10, 1.20, 1], [-1.99, 1.122], [-1.85, 1.085], [-1.55, 1.025]])
    ];
    var pillars = [poly([[-1.18, 1.336], [-1.27, 1.332], [-1.30, 0.992], [-1.22, 0.988]])];
    var doorCuts = [
      line([[0.36, 0.94], [0.52, 0.70], [0.60, 0.42], [0.60, 0.24]], { t0: [0.55, -1] }),
      line([[-1.24, 0.99], [-1.17, 0.80], [-1.09, 0.60], [-1.05, 0.40], [-1.06, 0.24]]),
      line([[0.60, 0.24], [-1.06, 0.24]]),
      line([[0.26, 0.97], [-0.10, 1.16], [-0.44, 1.37], [-0.80, 1.372], [-1.24, 1.364]], { t0: [-0.9, 0.5] })
    ];
    var panelLines = [
      line([[0.35, 0.952], [1.40, 0.835], [2.18, 0.69]]),                         // clamshell bonnet shut line (cowl pushed back: front-mid V12)
      line([[-2.16, 1.325], [-2.26, 1.16], [-2.355, 0.99], [-2.46, 0.94], [-2.482, 0.78]]), // steep tailgate
      rrect(-1.92, 0.775, -1.76, 0.875, 0.025)                                    // fuel filler flap (right rear haunch)
    ];
    var characterLines = [
      line([[0.80, 0.67], [0.0, 0.70], [-0.90, 0.76], [-1.35, 0.805], [-1.95, 0.85], [-2.42, 0.87]], { t0: [-1, 0.03] }), // rising flank line from the top gill slot
      line([[-1.10, 0.885], [-1.60, 0.905], [-2.00, 0.915], [-2.40, 0.897]], { t0: [-1, 0.06] }),                      // rear-haunch shoulder
      line([[2.10, 0.72], [1.495, 0.79], [0.90, 0.86]]),                          // front wing crest
      line([[1.10, 0.30], [0.0, 0.31], [-1.08, 0.33]])                            // sill swage
    ];
    var sill = compound(poly([[1.14, 0.20], [-1.12, 0.20], [-1.10, 0.27], [1.12, 0.27]]));
    var lowerTrim = compound(
      poly([[1.14, 0.20], [-1.12, 0.20], [-1.11, 0.235], [1.13, 0.235]]),        // carbon side skirt blade
      loop([[2.36, 0.145, 1], [1.86, 0.19, 1], [1.90, 0.21], [2.37, 0.18, 1]]),  // front splitter
      loop([[-1.87, 0.20, 1], [-2.34, 0.21, 1], [-2.43, 0.29, 1], [-2.20, 0.27]]) // rear diffuser side
    );

    var top = {
      body: symB([[xf, 0], [2.42, 0.30], [2.37, 0.60], [2.25, 0.82], [2.0, 0.94], [1.60, 0.975], [hw, 0.978], [1.0, 0.965], [0.30, 0.94],
        [-0.60, 0.952], [-1.20, 0.981], [-hw, W], [-1.90, 0.975], [-2.22, 0.92], [-2.42, 0.80], [-2.48, 0.60], [-2.491, 0.30], [xr, 0]]),
      greenhouse: symB([[0.22, 0], [0.215, 0.42], [0.15, 0.62], [-0.10, 0.72], [-0.40, 0.74], [-1.00, 0.715], [-1.60, 0.66], [-1.95, 0.56],
        [-2.05, 0.50], [-2.11, 0.40, 1], [-2.12, 0]]),
      hood: symB([[2.36, 0], [2.345, 0.40], [2.28, 0.64, 1], [1.60, 0.62], [0.36, 0.50, 1], [0.34, 0]]),            // clamshell, trapezoid in plan
      roof: symB([[-0.42, 0], [-0.44, 0.54], [-0.62, 0.60], [-1.20, 0.58], [-1.60, 0.53], [-1.90, 0.45], [-2.02, 0.36, 1], [-2.03, 0]]),
      deck: symB([[-2.10, 0], [-2.12, 0.55], [-2.30, 0.62], [-2.44, 0.66], [-2.48, 0.40], [-2.48, 0]]),
      mirrors: [   // one path per side
        loop([[0.30, 0.93], [0.28, 1.04], [0.22, ref.widthMirrors / 2], [0.10, 1.055], [0.08, 1.0], [0.15, 0.93]]),
        loop([[0.15, -0.93], [0.08, -1.0], [0.10, -1.055], [0.22, -ref.widthMirrors / 2], [0.28, -1.04], [0.30, -0.93]])]
    };

    var front = {
      body: symA([[0, H], [0.35, 1.373], [0.54, 1.345], [0.63, 1.24], [0.71, 1.04], [0.78, 0.955], [0.90, 0.86], [W, 0.70], [0.985, 0.52],
        [0.965, 0.36], [0.95, 0.30, 1], [0.72, 0.28, 1], [0.71, 0.17], [0.58, 0.146], [0, 0.14]]),
      greenhouse: symA([[0, 1.35], [0.53, 1.335], [0.63, 1.24], [0.72, 0.99, 1], [0, 0.965]]),
      bumper: symA([[0, 0.655], [0.45, 0.65], [0.80, 0.62], [0.96, 0.50], [0.95, 0.30], [0.72, 0.20], [0, 0.18]]),
      // one very wide grille: half-width 0.74 at the top (y 0.46), 0.66 at the bottom (y 0.19), rounded lower outer corners
      grille: [symA([[0, 0.468], [0.45, 0.466], [0.74, 0.458, 1], [0.728, 0.36], [0.71, 0.27], [0.685, 0.21], [0.62, 0.19], [0.40, 0.187], [0, 0.186]])],
      intakes: [],
      // long swept-back wedges: pointed low inner end, 0.11 tall outer end, LED strip along the top edge
      headlights: pairA([[0.46, 0.56, 1], [0.60, 0.618], [0.78, 0.673], [0.90, 0.70], [0.945, 0.69], [0.94, 0.62], [0.91, 0.59], [0.78, 0.585], [0.60, 0.567]]),
      drl: pairA([[0.50, 0.587, 1], [0.62, 0.632], [0.78, 0.676], [0.90, 0.697], [0.935, 0.689, 1], [0.90, 0.683], [0.78, 0.661], [0.62, 0.617], [0.50, 0.574, 1]]),
      splitter: symA([[0, 0.185], [0.60, 0.18], [0.74, 0.17], [0.72, 0.147], [0, 0.14]]),
      plateArea: rrect(-0.26, 0.20, 0.26, 0.31, 0.01),
      badgeArea: rrect(-0.05, 0.37, 0.05, 0.44, 0.01),
      badgeText: 'FERRARI'
    };

    var rear = {
      body: symA([[0, H], [0.35, 1.375], [0.54, 1.345], [0.62, 1.25], [0.70, 1.07], [0.78, 0.97], [0.92, 0.88], [W, 0.72], [0.985, 0.52],
        [0.965, 0.36], [0.95, 0.31, 1], [0.72, 0.29, 1], [0.71, 0.20], [0.58, 0.171], [0, 0.165]]),
      greenhouse: { path: symA([[0, 1.36], [0.53, 1.345], [0.62, 1.25], [0.70, 1.03, 1], [0, 1.0]]), paint: 'body' }, // cabin seen from behind
      bumper: symA([[0, 0.55], [0.70, 0.55], [0.95, 0.53], [0.985, 0.50], [0.96, 0.34], [0.72, 0.21], [0, 0.20]]),
      characterLines: [line([[-0.86, 0.92], [-0.50, 0.925], [0, 0.926], [0.50, 0.925], [0.86, 0.92]])],   // ducktail crease (ends inside the shoulder)
      taillights: [].concat(circPairA(0.53, 0.835, 0.07), circPairA(0.75, 0.835, 0.07)),  // quad round lamps under the ducktail lip
      diffuser: { path: symA([[0, 0.40], [0.40, 0.40], [0.72, 0.38], [0.76, 0.30], [0.72, 0.20], [0.58, 0.171], [0, 0.165]]), paint: 'carbon' },
      exhaust: [{ shape: 'round', cx: 0.47, cy: 0.255, w: 0.095, h: 0.095 }, { shape: 'round', cx: 0.60, cy: 0.255, w: 0.095, h: 0.095 },
        { shape: 'round', cx: -0.47, cy: 0.255, w: 0.095, h: 0.095 }, { shape: 'round', cx: -0.60, cy: 0.255, w: 0.095, h: 0.095 }],
      spoiler: symA([[0, 1.322], [0.275, 1.3185], [0.55, 1.312], [0.6, 1.286], [0.55, 1.276], [0.275, 1.278], [0, 1.279]]),
      plateArea: rrect(-0.26, 0.42, 0.26, 0.53, 0.01),
      badgeArea: rrect(-0.06, 0.85, 0.06, 0.905, 0.01),
      badgeText: 'FERRARI'
    };

    var details = [
      D('side', 'mirror', loop([[0.32, 0.965], [0.30, 1.06], [0.22, 1.09], [0.10, 1.082], [0.08, 1.02], [0.14, 0.97]]), 'body'),
      D('side', 'handle', rrect(-0.85, 0.93, -0.66, 0.945, 0.007), 'black'),
      // triple-louvre gill at the trailing edge of the front arch: three dark slots (0.28 x 0.03, raked 8 deg up rearward)
      D('side', 'vent', slot(0.80, 1.08, 0.54, 0.03, 8), 'black'),
      D('side', 'vent', slot(0.80, 1.08, 0.60, 0.03, 8), 'black'),
      D('side', 'vent', slot(0.80, 1.08, 0.66, 0.03, 8), 'black'),
      D('side', 'vent', slot(0.81, 1.07, 0.552, 0.008, 8), 'body'),                 // body-colour louvre lips over each slot
      D('side', 'vent', slot(0.81, 1.07, 0.612, 0.008, 8), 'body'),
      D('side', 'vent', slot(0.81, 1.07, 0.672, 0.008, 8), 'body'),
      D('side', 'trim', rrect(1.22, 0.70, 1.30, 0.79, 0.012), 'body'),            // fender shield badge area (no artwork)
      D('side', 'trim', loop([[-2.475, 0.905, 1], [-2.42, 0.906], [-2.40, 0.86], [-2.48, 0.85, 1]]), 'light-red'),
      D('side', 'trim', loop([[2.32, 0.628, 1], [2.10, 0.70], [1.96, 0.728], [2.05, 0.705], [2.36, 0.585, 1]]), 'light'), // headlight from side
      D('front', 'glass', symA([[0, 1.34], [0.26, 1.3358], [0.52, 1.326], [0.5404, 1.2851], [0.69, 0.985, 1], [0, 0.97]]), 'glass'),
      D('front', 'mirror', loop([[0.90, 1.0], [0.98, 1.10], [1.07, 1.085], [ref.widthMirrors / 2, 1.03], [1.03, 0.98], [0.93, 0.975]]), 'body'),
      D('front', 'mirror', loop([[-0.93, 0.975], [-1.03, 0.98], [-ref.widthMirrors / 2, 1.03], [-1.07, 1.085], [-0.98, 1.10], [-0.90, 1.0]]), 'body'),
      D('front', 'grille', symA([[0, 0.338], [0.722, 0.338, 1], [0.718, 0.322, 1], [0, 0.322]]), 'chrome'),
      // wing crests and the shallow clamshell dip between them, seen head-on
      D('front', 'trim', line([[0.62, 0.80], [0.80, 0.805], [0.92, 0.77], [0.985, 0.70]]), 'line'),
      D('front', 'trim', line([[0.62, 0.80], [0.80, 0.805], [0.92, 0.77], [0.985, 0.70]].map(mirA)), 'line'),
      D('front', 'trim', line([[-0.80, 0.80], [-0.50, 0.787], [-0.25, 0.778], [0, 0.775], [0.25, 0.778], [0.50, 0.787], [0.80, 0.80]]), 'line'),        // single horizontal blade at y = 0.33
      D('front', 'wiper', rrect(-0.55, 0.985, 0.05, 1.0, 0.006), 'black'),
      D('rear', 'glass', symA([[0, 1.268], [0.28, 1.267], [0.53, 1.261], [0.555, 1.243], [0.575, 1.03, 1], [0, 1.02]]), 'glass'),
      D('rear', 'trim', symA([[0, 0.918], [0.82, 0.918], [0.86, 0.916, 1], [0.855, 0.909, 1], [0.82, 0.912], [0, 0.912]]), 'black'), // thin ducktail lip shadow
      D('rear', 'trim', symA([[0, 0.40], [0.40, 0.40], [0.72, 0.38], [0.76, 0.30], [0.74, 0.30], [0.70, 0.365], [0.40, 0.385], [0, 0.385]]), 'black') // diffuser surround
    ].concat(
      rrectPairA(0.72, 0.978, 0.92, 1.005, 0.008).map(function (p) { return D('front', 'trim', p, 'body'); }),     // mirror stalks
      circPairA(0.53, 0.835, 0.038).map(function (p) { return D('rear', 'trim', p, 'light-red'); }),
      circPairA(0.75, 0.835, 0.038).map(function (p) { return D('rear', 'trim', p, 'light-red'); }),
      [0.12, 0.24, 0.34].reduce(function (a, z) { return a.concat(rrectPairA(z, 0.18, z + 0.012, 0.37, 0.004)); }, [])
        .map(function (p) { return D('rear', 'trim', p, 'black'); })               // diffuser fins
    );

    var model = {
      id: 'ferrari-gtc4lusso', make: 'Ferrari', name: 'GTC4Lusso', gen: 'F151M', years: '2016–2020',
      look: { head: 'slim-led', tail: 'quad-round', grille: 'mesh' },   // renderer lamp / grille signature
      style: 'shooting-brake', enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice',
      ref: ref,
      side: { body: sideBody, greenhouse: greenhouse, windows: windows, pillars: pillars, doorCuts: doorCuts, panelLines: panelLines,
        characterLines: characterLines, sill: sill, archF: { x: aF.x, y: aF.y, r: aF.r, flare: 0.015 }, archR: { x: aR.x, y: aR.y, r: aR.r, flare: 0.015 },
        lowerTrim: lowerTrim },
      top: top, front: front, rear: rear, details: details,
      wheel: { design: '20in forged 5 double-spoke', spokes: 10, finish: '#8d9196', caliper: '#e8b100' },
      signature: {
        wheels: '20in forged five double-spoke wheels (pairs of slim spokes), diamond-finished, yellow calipers.',
        headlights: 'Long swept-back wedge LED headlights: pointed low inner end at the grille corner, 0.11 m tall outer end wrapping over the wings, LED DRL strip along the top edge.',
        taillights: 'Quad round tail lamps (two per side) with a red inner ring, seated under an overhanging ducktail lip and full-width crease.',
        grille: 'One very wide, low single grille (no separate intakes) with one horizontal blade and a black splitter.',
        notes: 'Front-mid V12 behind a long clamshell bonnet (cowl pushed far back); three-door shooting brake with one long door; three raked body-colour louvres with dark slots at the trailing edge of the front arch feeding a rising flank line to the rear haunch; DLO ending in a sharp rising arrow-point; near-flat roof ending in a pronounced spoiler over a steep Kamm tailgate; quad round exhausts in a carbon-surround finned diffuser.'
      }
    };
    model.sections = buildSections(model, {
      belt: [[2.6, 0.78], [0.32, 0.955], [0.22, 0.935], [-0.40, 0.965], [-1.30, 0.99], [-2.0, 1.0], [-2.38, 0.985], [-2.6, 0.95]],
      cowlX: 0.32, roofEndX: -2.205, hatchBaseX: -2.378, hatchGlassY: 1.02,
      cabinPlan: [[-1.70, 0.62], [-2.05, 0.585], [-2.205, 0.575], [-2.378, 0.57]], crown: 0.035, tumble: 0.34, hoodFrac: 0.84, dip: [0.015, 0.01]
    });
    return model;
  }

  /* ================================================================== 3. Mercedes-Benz CLS 500 Shooting Brake (X218, 2014 facelift) */
  function clsShootingBrake() {
    var ref = { length: 4.956, width: 1.881, widthMirrors: 2.075, height: 1.416, wheelbase: 2.874, trackF: 1.596, trackR: 1.626,
      frontOverhang: 0.955, rearOverhang: 1.127, wheelDiameter_in: 18, tireF: '255/40R18', tireR: '255/40R18',
      groundClearance: 0.125, rideHeight: 0.125, cd: 0.29, curbWeight_kg: 2005 };
    var hw = ref.wheelbase / 2, xf = hw + ref.frontOverhang, xr = -hw - ref.rearOverhang, H = ref.height, W = ref.width / 2;
    var rF = tireDiameter(ref.tireF) / 2, rR = tireDiameter(ref.tireR) / 2, yb = 0.22;
    var aF = { x: hw, y: rF, r: rF + 0.045, yb: yb }, aR = { x: -hw, y: rR, r: rR + 0.045, yb: yb };

    var b = B().M([2.30, 0.175]);
    archCut(b, aF).L([-hw + Math.sqrt(aR.r * aR.r - (aR.y - yb) * (aR.y - yb)), yb]);
    archCut(b, aR).L([-2.42, 0.235])
      // coupe roof that keeps falling: peak over the B-pillar, -0.08 to the spoiler, ~50 deg hatch glass
      .S([[-2.51, 0.30], [-2.55, 0.45], [xr, 0.64], [-2.556, 0.80], [-2.535, 0.915], [-2.47, 1.00, 1], [-2.35, 1.15], [-2.222, 1.30, 1],
        [-2.12, 1.322], [-2.05, 1.332], [-1.40, 1.38], [-0.60, H], [-0.25, 1.398, 1], [0.30, 1.18], [0.88, 0.985, 1],
        [1.40, 0.90], [1.95, 0.818], [2.25, 0.75], [2.36, 0.66], [xf, 0.52], [2.38, 0.36], [2.34, 0.225]])
      .Z();
    var sideBody = b.get();
    // DLO: dropping upper line meeting a rising lower line (1.02 at x = -1.53 to 1.12 at x = -2.0) in a long tapering point
    var greenhouse = loop([[0.80, 0.965, 1], [0.30, 1.17], [-0.22, 1.372], [-0.70, 1.39], [-1.40, 1.352], [-1.90, 1.30], [-2.15, 1.20, 1],
      [-2.00, 1.12], [-1.75, 1.058], [-1.53, 1.02], [-0.40, 0.995]]);
    var windows = [
      loop([[0.74, 0.972, 1], [0.30, 1.165], [-0.20, 1.355], [-0.48, 1.372, 1], [-0.53, 0.996, 1], [0.10, 0.982]]),
      loop([[-0.60, 0.998, 1], [-0.56, 1.374, 1], [-1.00, 1.37], [-1.38, 1.348, 1], [-1.45, 1.018, 1], [-1.00, 1.01]]),
      loop([[-1.53, 1.026, 1], [-1.49, 1.342, 1], [-1.88, 1.296], [-2.12, 1.20, 1], [-1.99, 1.124], [-1.75, 1.064]])
    ];
    var pillars = [
      poly([[-0.48, 1.372], [-0.56, 1.374], [-0.60, 0.998], [-0.53, 0.996]]),
      poly([[-1.38, 1.348], [-1.49, 1.342], [-1.53, 1.026], [-1.45, 1.018]])
    ];
    var doorCuts = [
      line([[0.84, 0.97], [0.97, 0.72], [1.0, 0.45], [0.99, 0.27]], { t0: [0.5, -1] }),
      line([[-0.53, 0.996], [-0.545, 0.62], [-0.56, 0.27]]),
      line([[-1.46, 1.02], [-1.35, 0.80], [-1.13, 0.62], [-1.02, 0.42], [-1.02, 0.27]]),
      line([[0.99, 0.27], [-1.02, 0.27]])
    ];
    var panelLines = [
      line([[0.88, 0.985], [1.60, 0.876], [2.20, 0.762]]),                         // bonnet
      line([[-2.19, 1.312], [-2.33, 1.16], [-2.455, 1.0], [-2.53, 0.90], [-2.548, 0.62]]), // tailgate
      rrect(-2.02, 0.78, -1.86, 0.89, 0.03)                                        // fuel flap (right rear wing)
    ];
    var characterLines = [
      line([[1.40, 0.84], [0.70, 0.79], [-0.10, 0.69], [-0.80, 0.57], [-1.10, 0.53]], { t0: [-1, -0.04] }), // CLS "dropping line"
      line([[-0.60, 0.75], [-1.10, 0.80], [-1.70, 0.86], [-2.46, 0.893]], { t0: [-1, 0.12] }),                 // rising rear-haunch line
      line([[0.95, 0.315], [0.0, 0.32], [-0.98, 0.325]]),                                                      // sill
      line([[2.25, 0.755], [1.437, 0.83], [0.95, 0.90]])                                                       // front wing
    ];
    var sill = compound(poly([[1.08, 0.22], [-1.08, 0.22], [-1.06, 0.30], [1.06, 0.30]]));
    var lowerTrim = compound(
      loop([[2.30, 0.175, 1], [1.80, 0.215, 1], [1.84, 0.235], [2.32, 0.205, 1]]),
      loop([[-1.80, 0.22, 1], [-2.42, 0.235, 1], [-2.50, 0.29, 1], [-2.20, 0.27]])
    );

    var top = {
      body: symB([[xf, 0], [2.38, 0.32], [2.32, 0.60], [2.20, 0.78], [1.95, 0.885], [1.55, 0.925], [hw, 0.928], [1.0, 0.92], [0.30, 0.905],
        [-0.50, 0.915], [-1.10, 0.935], [-hw, W], [-1.85, 0.93], [-2.20, 0.88], [-2.45, 0.78], [-2.54, 0.60], [-2.562, 0.30], [xr, 0]]),
      greenhouse: symB([[0.80, 0], [0.795, 0.40], [0.74, 0.60], [0.40, 0.69], [-0.40, 0.72], [-1.00, 0.70], [-1.60, 0.645], [-1.95, 0.56],
        [-2.08, 0.50], [-2.14, 0.42, 1], [-2.15, 0]]),
      hood: symB([[2.30, 0], [2.285, 0.40], [2.22, 0.62, 1], [1.60, 0.60], [0.90, 0.52, 1], [0.88, 0]]),
      roof: symB([[-0.23, 0], [-0.25, 0.53], [-0.45, 0.60], [-1.00, 0.58], [-1.60, 0.52], [-1.95, 0.44], [-2.06, 0.36, 1], [-2.07, 0]]),
      deck: symB([[-2.20, 0], [-2.22, 0.52], [-2.40, 0.60], [-2.52, 0.62], [-2.55, 0.40], [-2.555, 0]]),
      mirrors: [   // one path per side
        loop([[0.78, 0.90], [0.76, 1.01], [0.71, ref.widthMirrors / 2], [0.60, 1.03], [0.57, 0.97], [0.63, 0.90]]),
        loop([[0.63, -0.90], [0.57, -0.97], [0.60, -1.03], [0.71, -ref.widthMirrors / 2], [0.76, -1.01], [0.78, -0.90]])]
    };

    var front = {
      body: symA([[0, H], [0.33, 1.405], [0.52, 1.38], [0.62, 1.27], [0.70, 1.08], [0.76, 0.99], [0.88, 0.90], [W, 0.74], [0.935, 0.55],
        [0.92, 0.40], [0.905, 0.33, 1], [0.68, 0.31, 1], [0.67, 0.20], [0.55, 0.176], [0, 0.17]]),
      greenhouse: symA([[0, 1.385], [0.51, 1.37], [0.62, 1.26], [0.71, 1.0, 1], [0, 0.98]]),
      bumper: symA([[0, 0.455], [0.395, 0.455, 1], [0.465, 0.636, 1], [0.70, 0.64], [0.91, 0.62], [0.935, 0.50], [0.92, 0.35], [0.67, 0.21], [0, 0.20]]),
      grille: [
        // wide, low twin-louvre grille set below the headlamp line (top 0.625, half-width 0.45 -> 0.40)
        symA([[0, 0.626], [0.40, 0.625], [0.45, 0.62, 1], [0.437, 0.56], [0.418, 0.50], [0.40, 0.47, 1], [0, 0.468]]),
        symA([[0, 0.34], [0.36, 0.335], [0.42, 0.29], [0.40, 0.215], [0, 0.21]])                                        // lower centre intake
      ],
      intakes: pairPoly([[0.49, 0.43], [0.885, 0.475], [0.905, 0.245], [0.56, 0.215]]),                                // large angular AMG Line trapezoids
      // MULTIBEAM wedge: pointed low inner end touching the grille corner, 0.10 tall outer end
      headlights: pairA([[0.425, 0.66, 1], [0.52, 0.69], [0.70, 0.735], [0.86, 0.76], [0.905, 0.755], [0.915, 0.71], [0.90, 0.665], [0.80, 0.656], [0.60, 0.648], [0.47, 0.648]]),
      drl: pairA([[0.46, 0.676, 1], [0.60, 0.71], [0.75, 0.738], [0.87, 0.753], [0.896, 0.745], [0.902, 0.705], [0.89, 0.672, 1], [0.878, 0.70], [0.872, 0.733],
        [0.75, 0.72], [0.60, 0.692], [0.46, 0.66, 1]]),                                                               // LED torch strand hooking down at the outer end
      splitter: symA([[0, 0.21], [0.55, 0.205], [0.66, 0.20], [0.65, 0.176], [0, 0.17]]),
      plateArea: rrect(-0.26, 0.345, 0.26, 0.455, 0.01),
      badgeArea: rrect(-0.07, 0.53, 0.07, 0.60, 0.035),                             // large centre star on the louvres (text badge only)
      badgeText: 'MERCEDES-BENZ'
    };

    var rear = {
      body: symA([[0, H], [0.33, 1.405], [0.52, 1.38], [0.60, 1.29], [0.68, 1.10], [0.78, 1.0], [0.905, 0.962], [0.935, 0.90], [W, 0.76], [0.935, 0.55],
        [0.92, 0.40], [0.91, 0.33, 1], [0.68, 0.31, 1], [0.67, 0.23], [0.55, 0.216], [0, 0.21]]),
      greenhouse: { path: symA([[0, 1.385], [0.51, 1.37], [0.60, 1.28], [0.69, 1.04, 1], [0, 1.02]]), paint: 'body' },  // cabin seen from behind
      bumper: symA([[0, 0.62], [0.60, 0.62], [0.88, 0.605], [0.935, 0.52], [0.92, 0.38], [0.68, 0.23], [0, 0.22]]),   // bumper split under the plate
      // slim horizontal wedges: pointed inboard (z 0.40, 0.02 tall), growing to 0.075 tall at the outer corner
      taillights: pairA([[0.40, 0.90, 1], [0.55, 0.912], [0.75, 0.928], [0.88, 0.94], [0.915, 0.935], [0.922, 0.89], [0.90, 0.866], [0.75, 0.874], [0.55, 0.886]]),
      diffuser: symA([[0, 0.36], [0.45, 0.358], [0.62, 0.352], [0.69, 0.335, 1], [0.70, 0.25], [0.67, 0.23], [0.55, 0.216], [0, 0.21]]),
      characterLines: [line([[-0.85, 0.628], [-0.45, 0.634], [0, 0.635], [0.45, 0.634], [0.85, 0.628]])],  // bumper-shelf crease
      exhaust: [{ shape: 'trapezoid', cx: 0.56, cy: 0.275, w: 0.20, h: 0.06 }, { shape: 'trapezoid', cx: -0.56, cy: 0.275, w: 0.20, h: 0.06 }],
      spoiler: symA([[0, 1.336], [0.26, 1.3325], [0.52, 1.326], [0.56, 1.3], [0.52, 1.29], [0.26, 1.292], [0, 1.293]]),
      plateArea: rrect(-0.26, 0.655, 0.26, 0.758, 0.01),                         // recess directly under the chrome strip
      badgeArea: rrect(-0.07, 0.81, 0.07, 0.90, 0.045),
      badgeText: 'MERCEDES-BENZ'
    };

    var details = [
      D('side', 'mirror', loop([[0.80, 0.975], [0.78, 1.06], [0.70, 1.09], [0.57, 1.085], [0.55, 1.03], [0.62, 0.98]]), 'body'),
      D('side', 'pillar', poly([[-0.48, 1.372], [-0.56, 1.374], [-0.60, 0.998], [-0.53, 0.996]]), 'gloss-black'),  // frameless glass: gloss-black B/C pillars
      D('side', 'pillar', poly([[-1.38, 1.348], [-1.49, 1.342], [-1.53, 1.026], [-1.45, 1.018]]), 'gloss-black'),
      D('side', 'handle', rrect(-0.16, 0.86, 0.05, 0.885, 0.01), 'chrome'),
      D('side', 'handle', rrect(-1.15, 0.875, -0.95, 0.90, 0.01), 'chrome'),
      D('side', 'trim', taper([[0.80, 0.958], [0.20, 0.976], [-0.40, 0.99], [-1.10, 1.006], [-1.53, 1.015], [-1.75, 1.052], [-2.00, 1.114], [-2.155, 1.199]], 0.013, 0.005), 'chrome'), // chrome DLO surround (lower) to the point
      D('side', 'trim', taper([[0.81, 0.972], [0.30, 1.18], [-0.22, 1.381], [-0.70, 1.399], [-1.40, 1.361], [-1.90, 1.308], [-2.155, 1.201]], 0.009, 0.005), 'chrome'), // chrome DLO surround (upper)
      D('side', 'trim', loop([[-2.53, 0.935, 1], [-2.42, 0.945], [-2.30, 0.925, 1], [-2.40, 0.895], [-2.545, 0.875, 1]]), 'light-red'),
      D('side', 'trim', loop([[2.36, 0.70, 1], [2.10, 0.775], [1.98, 0.79], [2.08, 0.76], [2.38, 0.64, 1]]), 'light'),
      D('front', 'glass', symA([[0, 1.375], [0.25, 1.3705], [0.5, 1.36], [0.5216, 1.3162], [0.68, 0.995, 1], [0, 0.985]]), 'glass'),
      D('front', 'mirror', loop([[0.86, 1.0], [0.94, 1.10], [1.03, 1.09], [ref.widthMirrors / 2, 1.03], [1.0, 0.985], [0.89, 0.98]]), 'body'),
      D('front', 'mirror', loop([[-0.89, 0.98], [-1.0, 0.985], [-ref.widthMirrors / 2, 1.03], [-1.03, 1.09], [-0.94, 1.10], [-0.86, 1.0]]), 'body'),
      D('front', 'grille', symA([[0, 0.57], [0.432, 0.57, 1], [0.428, 0.55, 1], [0, 0.55]]), 'chrome'),        // two chrome louvres
      D('front', 'grille', symA([[0, 0.51], [0.416, 0.51, 1], [0.411, 0.49, 1], [0, 0.49]]), 'chrome'),
      D('front', 'trim', symA([[0, 0.29], [0.40, 0.29, 1], [0.41, 0.275, 1], [0, 0.275]]), 'chrome'),
      // bonnet seen head-on: two power domes at z = +-0.30
      D('front', 'trim', line([[-0.86, 0.885], [-0.55, 0.905], [-0.30, 0.925], [-0.15, 0.912], [0, 0.91], [0.15, 0.912], [0.30, 0.925], [0.55, 0.905], [0.86, 0.885]]), 'line'),
      D('front', 'wiper', rrect(-0.60, 1.0, 0.0, 1.015, 0.006), 'black'),
      D('rear', 'glass', symA([[0, 1.282], [0.27, 1.281], [0.52, 1.274], [0.552, 1.252], [0.60, 1.04, 1], [0.30, 1.033], [0, 1.03]]), 'glass'), // wide, low at the sides
      D('rear', 'trim', symA([[0, 0.775], [0.30, 0.775, 1], [0.30, 0.765, 1], [0, 0.765]]), 'chrome'),        // tailgate chrome strip
      D('rear', 'wiper', rrect(-0.02, 1.072, 0.36, 1.087, 0.006), 'black'),
      // tailgate shut lines: from the inner lamp tips down and outward to the bumper split
      D('rear', 'trim', line([[0.40, 0.865], [0.47, 0.76], [0.62, 0.63]]), 'line'),
      D('rear', 'trim', line([[0.40, 0.865], [0.47, 0.76], [0.62, 0.63]].map(mirA)), 'line')
    ].concat(
      pairA([[0.43, 0.906, 1], [0.55, 0.915], [0.75, 0.931], [0.88, 0.941], [0.905, 0.937, 1], [0.88, 0.933], [0.75, 0.923], [0.55, 0.907], [0.43, 0.899, 1]])
        .map(function (p) { return D('rear', 'trim', p, 'light'); }),             // thin LED strand along the top of each lamp
      rrectPairA(0.76, 0.40, 0.90, 0.42, 0.008).map(function (p) { return D('rear', 'trim', p, 'light-red'); }),
      rrectPairA(0.70, 0.983, 0.88, 1.008, 0.008).map(function (p) { return D('front', 'trim', p, 'body'); }),     // mirror stalks
      [-1, 1].map(function (s) {                                                   // chrome exhaust surrounds, inside the bumper outline
        return D('rear', 'trim', poly([[s * 0.45, 0.31], [s * 0.67, 0.31], [s * 0.655, 0.24], [s * 0.465, 0.24]].map(function (p, i, a) { return s > 0 ? p : a[a.length - 1 - i]; })), 'chrome');
      })
    );

    var model = {
      id: 'mercedes-cls-shooting-brake-x218', make: 'Mercedes-Benz', name: 'CLS 500 4MATIC Shooting Brake', gen: 'X218', years: '2012–2017',
      look: { head: 'slim-led', tail: 'slim', grille: 'bar' },   // renderer lamp / grille signature
      style: 'shooting-brake', enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice',
      ref: ref,
      side: { body: sideBody, greenhouse: greenhouse, windows: windows, pillars: pillars, doorCuts: doorCuts, panelLines: panelLines,
        characterLines: characterLines, sill: sill, archF: { x: aF.x, y: aF.y, r: aF.r, flare: 0.012 }, archR: { x: aR.x, y: aR.y, r: aR.r, flare: 0.012 },
        lowerTrim: lowerTrim },
      top: top, front: front, rear: rear, details: details,
      wheel: { design: '18in AMG 5 twin-spoke', spokes: 10, finish: '#b9bdc2', caliper: '#8d9196' },
      signature: {
        wheels: '18in AMG five twin-spoke wheels, silver/titanium finish.',
        headlights: 'MULTIBEAM LED wedge headlights (2014 facelift): pointed low inner end touching the grille corner, taller outer end, with a bright LED "torch" strand along the upper edge hooking down at the outer end.',
        taillights: 'Slim horizontal LED wedge tail lamps that taper to a point inboard and grow toward the outer corner, with a thin LED strand along the top; wrap forward onto the rear wings.',
        grille: 'Wide, low twin-louvre grille with two chrome blades through the large centre star position; AMG Line bumper with angular trapezoid outer intakes and a chrome blade, plus a centre lower intake; twin power domes on the bonnet.',
        notes: 'Coupe-like five-door shooting brake: roof peaks over the B-pillar and keeps falling to a small spoiler over a ~50 deg hatch; frameless door glass with gloss-black pillars and a chrome DLO surround ending in a long tapering point; the CLS "dropping line" falling from the front wing to just ahead of the rear arch, a rising haunch line over the rear wheel; twin trapezoidal exhaust tips set inside the bumper.'
      }
    };
    model.sections = buildSections(model, {
      belt: [[2.6, 0.80], [0.88, 0.985], [0.80, 0.965], [-0.40, 0.995], [-1.53, 1.02], [-2.10, 1.04], [-2.47, 1.0], [-2.6, 0.95]],
      cowlX: 0.88, roofEndX: -2.222, hatchBaseX: -2.47, hatchGlassY: 1.03,
      cabinPlan: [[-1.70, 0.60], [-2.10, 0.565], [-2.222, 0.55], [-2.47, 0.53]], crown: 0.04, tumble: 0.36, hoodFrac: 0.84,
      domes: [0.95, 2.15, 0.03, 0.30]                                          // two power domes at z = +-0.30, +0.03
    });
    return model;
  }

  /* ------------------------------------------------------------------ registration */
  var models = [taycanCrossTurismo(), gtc4Lusso(), clsShootingBrake()];
  models.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  var api = { models: models, tireDiameter: tireDiameter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

/* FORGE Atelier — real-car shape models for body style 'hatchback'.
   Volkswagen Golf GTI (Mk8), Honda Civic Type R (FL5), Toyota GR Yaris (GXPA16).
   Meters, at true published dimensions. Car-local axes: x forward (front bumper at +x), y up (ground y=0), z right.
   Origin = midpoint between the axles on the ground centerline. Side view (x,y); top view (x,z); front/rear views (z,y).
   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}; body surfaces are smooth cubic splines.
   Each model also carries explicit 3D cross-sections (model.sections, 40-vertex closed rings with glass flags)
   built from its own views: convex shoulders, tapered greenhouse, plan-view hips and carved wheel wells.
   Brand names are text only — no logo artwork is drawn; badgeArea marks where a text badge goes. */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ helpers */
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function pt(a, b) { return [r4(a), r4(b)]; }
  function unit(dx, dy) { var l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; }

  /** Smooth spline through points. A point [a,b,1] is a corner (tangent break). Segments between two corners are
      straight lines. Tangents are the bisector of the unit chords; handle length = chord/3 (no overshoot on uneven spacing). */
  function spl(pts, closed) {
    var n = pts.length, i;
    function P(k) { return closed ? pts[(k % n + n) % n] : pts[Math.max(0, Math.min(n - 1, k))]; }
    function dirs(k) {
      var p = P(k), hasPrev = closed || k > 0, hasNext = closed || k < n - 1;
      var q = P(k + 1), o = P(k - 1);
      var dn = hasNext ? unit(q[0] - p[0], q[1] - p[1]) : null;
      var dp = hasPrev ? unit(p[0] - o[0], p[1] - o[1]) : null;
      if (!dn) dn = dp; if (!dp) dp = dn;
      if (p[2]) return { inn: dp, out: dn };
      var s = unit(dn[0] + dp[0], dn[1] + dp[1]);
      return { inn: s, out: s };
    }
    var segs = [{ t: 'M', p: [pt(pts[0][0], pts[0][1])] }];
    var last = closed ? n : n - 1;
    for (i = 0; i < last; i++) {
      var a = P(i), b = P(i + 1);
      if (a[2] && b[2]) { segs.push({ t: 'L', p: [pt(b[0], b[1])] }); continue; }
      var ch = Math.hypot(b[0] - a[0], b[1] - a[1]), L = ch / 3;
      var hasPrev = closed || i > 0, hasNext = closed || i + 1 < n - 1;
      var o = P(i - 1), q = P(i + 2);
      var La = hasPrev && !a[2] ? Math.min(L, 0.9 * Math.hypot(a[0] - o[0], a[1] - o[1])) : L;
      var Lb = hasNext && !b[2] ? Math.min(L, 0.9 * Math.hypot(q[0] - b[0], q[1] - b[1])) : L;
      var da = dirs(i).out, db = dirs(i + 1).inn;
      segs.push({ t: 'C', p: [pt(a[0] + da[0] * La, a[1] + da[1] * La), pt(b[0] - db[0] * Lb, b[1] - db[1] * Lb), pt(b[0], b[1])] });
    }
    if (closed) segs.push({ t: 'Z', p: [] });
    return segs;
  }
  function closedP(pts) { return spl(pts, true); }
  function openP(pts) { return spl(pts, false); }
  function poly(pts) { return spl(pts.map(function (q) { return [q[0], q[1], 1]; }), true); }
  /** Sharp-cornered polygon with every corner rounded to radius ~r (quadratic fillets). */
  function rpoly(pts, r) {
    var n = pts.length, segs = [], ins = [], outs = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i], a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
      var la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
      var ra = Math.min(r, 0.45 * la), rb = Math.min(r, 0.45 * lb);
      ins.push([p[0] + (a[0] - p[0]) / la * ra, p[1] + (a[1] - p[1]) / la * ra]);
      outs.push([p[0] + (b[0] - p[0]) / lb * rb, p[1] + (b[1] - p[1]) / lb * rb]);
    }
    segs.push({ t: 'M', p: [pt(ins[0][0], ins[0][1])] });
    for (var k = 0; k < n; k++) {
      if (k > 0) segs.push({ t: 'L', p: [pt(ins[k][0], ins[k][1])] });
      segs.push({ t: 'Q', p: [pt(pts[k][0], pts[k][1]), pt(outs[k][0], outs[k][1])] });
    }
    segs.push({ t: 'L', p: [pt(ins[0][0], ins[0][1])] });
    segs.push({ t: 'Z', p: [] });
    return segs;
  }
  /** Rounded polygon and its mirror image about z=0 (front/rear views). */
  function rpolyPair(pts, r) { return [rpoly(pts, r), rpoly(pts.map(function (q) { return [-q[0], q[1]]; }).reverse(), r)]; }
  /** Closed ellipse from 4 cubic arcs. */
  function ell(cx, cy, rx, ry) {
    var k = 0.5523;
    return [
      { t: 'M', p: [pt(cx + rx, cy)] },
      { t: 'C', p: [pt(cx + rx, cy + ry * k), pt(cx + rx * k, cy + ry), pt(cx, cy + ry)] },
      { t: 'C', p: [pt(cx - rx * k, cy + ry), pt(cx - rx, cy + ry * k), pt(cx - rx, cy)] },
      { t: 'C', p: [pt(cx - rx, cy - ry * k), pt(cx - rx * k, cy - ry), pt(cx, cy - ry)] },
      { t: 'C', p: [pt(cx + rx * k, cy - ry), pt(cx + rx, cy - ry * k), pt(cx + rx, cy)] },
      { t: 'Z', p: [] }
    ];
  }
  /** Rounded rectangle (corner radius rr). */
  function rrect(x0, y0, x1, y1, rr) {
    var k = 0.5523 * rr;
    return [
      { t: 'M', p: [pt(x0 + rr, y0)] }, { t: 'L', p: [pt(x1 - rr, y0)] },
      { t: 'C', p: [pt(x1 - rr + k, y0), pt(x1, y0 + rr - k), pt(x1, y0 + rr)] }, { t: 'L', p: [pt(x1, y1 - rr)] },
      { t: 'C', p: [pt(x1, y1 - rr + k), pt(x1 - rr + k, y1), pt(x1 - rr, y1)] }, { t: 'L', p: [pt(x0 + rr, y1)] },
      { t: 'C', p: [pt(x0 + rr - k, y1), pt(x0, y1 - rr + k), pt(x0, y1 - rr)] }, { t: 'L', p: [pt(x0, y0 + rr)] },
      { t: 'C', p: [pt(x0, y0 + rr - k), pt(x0 + rr - k, y0), pt(x0 + rr, y0)] }, { t: 'Z', p: [] }
    ];
  }
  function join() { var out = []; for (var i = 0; i < arguments.length; i++) out = out.concat(arguments[i]); return out; }
  function arc(cx, cy, r, a0, a1, n) {
    var out = [];
    for (var i = 0; i <= n; i++) { var a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
  }
  function mirPts(pts) { return pts.map(function (q) { return q[2] ? [-q[0], q[1], 1] : [-q[0], q[1]]; }); }
  function mirPtsZ(pts) { return pts.map(function (q) { return q[2] ? [q[0], -q[1], 1] : [q[0], -q[1]]; }); }
  /** Front/rear view outline symmetric about z=0: half = points from (0,top) around the +z side to (0,bottom). */
  function symFR(half) {
    var back = mirPts(half.slice(1, half.length - 1)).reverse();
    return closedP(half.concat(back));
  }
  /** Top view outline symmetric about z=0: half = points from (front,0) along the +z side to (rear,0). */
  function symTop(half) {
    var back = mirPtsZ(half.slice(1, half.length - 1)).reverse();
    return closedP(half.concat(back));
  }
  function pairFR(pts) { return [closedP(pts), closedP(mirPts(pts).reverse())]; }
  function pairTop(pts) { return [closedP(pts), closedP(mirPtsZ(pts).reverse())]; }
  function ellPair(cz, cy, rx, ry) { return [ell(cz, cy, rx, ry), ell(-cz, cy, rx, ry)]; }
  /** Reverse one closed sub-path (M … Z). */
  function revSub(sub) {
    var segs = sub.filter(function (sg) { return sg.t !== 'Z'; }), out, i;
    var ends = segs.map(function (sg) { return sg.p[sg.p.length - 1]; });
    out = [{ t: 'M', p: [ends[ends.length - 1]] }];
    for (i = segs.length - 1; i >= 1; i--) {
      var sg = segs[i], prev = ends[i - 1];
      if (sg.t === 'C') out.push({ t: 'C', p: [sg.p[1], sg.p[0], prev] });
      else if (sg.t === 'Q') out.push({ t: 'Q', p: [sg.p[0], prev] });
      else out.push({ t: 'L', p: [prev] });
    }
    out.push({ t: 'Z', p: [] });
    return out;
  }
  /** Give every closed sub-path of a compound fill the same winding, so overlaps never cancel under nonzero fill. */
  function uniWind(path) {
    var subs = [], cur = null;
    path.forEach(function (sg) { if (sg.t === 'M') { cur = []; subs.push(cur); } cur.push(sg); });
    var out = [];
    subs.forEach(function (sub) {
      var a = 0;
      flat(sub, 8).forEach(function (pl) { for (var i = 1; i < pl.length; i++) a += pl[i - 1][0] * pl[i][1] - pl[i][0] * pl[i - 1][1]; });
      out = out.concat(a < 0 ? revSub(sub) : sub);
    });
    return out;
  }
  function D(view, role, path, paint) { return { view: view, role: role, path: path, paint: paint }; }
  function Dpair(view, role, paths, paint) { return paths.map(function (p) { return D(view, role, p, paint); }); }
  /** Vertical strakes (front/rear view) at the given z positions. */
  function strakes(zs, y0, y1, w) { return zs.map(function (z) { return rrect(z - w / 2, y0, z + w / 2, y1, w * 0.3); }); }
  function tireRadius(spec, rimIn) { var m = /^(\d+)\/(\d+)/.exec(spec); return (rimIn * 25.4 + 2 * (+m[1]) * (+m[2]) / 100) / 2000; }
  function inPoly(pts, x, y) {
    var c = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /** Honeycomb mesh: small hexagon cells inside a symmetric polygon (half points as for symFR), skipping hole rects. */
  function meshIn(half, cell, holes) {
    var full = half.concat(mirPts(half.slice(1, half.length - 1)).reverse());
    var y0 = Infinity, y1 = -Infinity, zm = 0, out = [], row = 0;
    full.forEach(function (q) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); zm = Math.max(zm, Math.abs(q[0])); });
    var h = cell * 0.36;
    for (var y = y0 + cell * 0.5; y < y1; y += cell * 0.86, row++) {
      for (var z = (row % 2 ? cell / 2 : 0); z < zm; z += cell) {
        [z, -z].forEach(function (zz, k) {
          if (k === 1 && zz === 0) return;
          var hex = [[zz - h, y], [zz - h / 2, y + h * 0.86], [zz + h / 2, y + h * 0.86], [zz + h, y], [zz + h / 2, y - h * 0.86], [zz - h / 2, y - h * 0.86]];
          var inHole = (holes || []).some(function (hl) {
            return hex.some(function (q) { return q[0] > hl[0] - 0.01 && q[0] < hl[2] + 0.01 && q[1] > hl[1] - 0.01 && q[1] < hl[3] + 0.01; });
          });
          if (!inHole && hex.every(function (q) { return inPoly(full, q[0], q[1]); })) out = out.concat(poly(hex));
        });
      }
    }
    return out;
  }
  function strokeOpenDetails(model) {
    model.details = model.details.filter(function (d) {
      var m = 0, z = 0;
      d.path.forEach(function (sg) { if (sg.t === 'M') m++; else if (sg.t === 'Z') z++; });
      if (m === z) return true;
      var v = model[d.view]; (v.panelLines = v.panelLines || []).push(d.path);
      return false;
    });
    return model;
  }
  function register(model) {
    strokeOpenDetails(model);
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(model);
    else (CB.shapes._pending = CB.shapes._pending || []).push(model);
  }

  /* ------------------------------------------------------------------ 3D sections */
  /** Flatten a path into polylines. */
  function flat(path, steps) {
    steps = steps || 12;
    var polys = [], cur = null, start = null, pl = null;
    (path || []).forEach(function (s) {
      if (s.t === 'M') { cur = s.p[0]; start = cur; pl = [cur]; polys.push(pl); }
      else if (s.t === 'L') { cur = s.p[0]; pl.push(cur); }
      else if (s.t === 'Z') { if (pl && start) pl.push(start); cur = start; }
      else {
        for (var i = 1; i <= steps; i++) {
          var t = i / steps, u = 1 - t, q;
          if (s.t === 'C') q = [0, 1].map(function (k) { return u * u * u * cur[k] + 3 * u * u * t * s.p[0][k] + 3 * u * t * t * s.p[1][k] + t * t * t * s.p[2][k]; });
          else q = [0, 1].map(function (k) { return u * u * cur[k] + 2 * u * t * s.p[0][k] + t * t * s.p[1][k]; });
          pl.push(q);
        }
        cur = s.p[s.p.length - 1];
      }
    });
    return polys;
  }
  /** Crossings of the vertical a = x with the polylines → [min b, max b] or null. */
  function sliceX(polys, x) {
    var lo = Infinity, hi = -Infinity;
    polys.forEach(function (p) {
      for (var i = 1; i < p.length; i++) {
        var a = p[i - 1], b = p[i];
        if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) {
          var y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
          if (y < lo) lo = y; if (y > hi) hi = y;
        }
      }
    });
    return lo <= hi ? [lo, hi] : null;
  }
  function halfAt(polys, x) { var s = sliceX(polys, x); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : null; }
  function lin(T, x) {
    if (x <= T[0][0]) return T[0][1];
    for (var i = 1; i < T.length; i++) if (x <= T[i][0]) { var t = (x - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * t; }
    return T[T.length - 1][1];
  }
  /** Normalised half-width vs height table of a front/rear outline, up to its glass base. */
  function profileTable(bodyPath, ghPath) {
    var bp = flat(bodyPath, 16), gp = flat(ghPath, 16), yMin = Infinity, gMin = Infinity;
    bp.forEach(function (p) { p.forEach(function (q) { yMin = Math.min(yMin, q[1]); }); });
    gp.forEach(function (p) { p.forEach(function (q) { gMin = Math.min(gMin, q[1]); }); });
    var swapped = bp.map(function (p) { return p.map(function (q) { return [q[1], q[0]]; }); });
    var T = [], mx = 0;
    for (var i = 0; i <= 48; i++) {
      var y = yMin + 0.004 + (gMin - 0.05 - yMin - 0.004) * i / 48, w = halfAt(swapped, y) || 0;
      T.push([y, w]); mx = Math.max(mx, w);
    }
    return T.map(function (q) { return [q[0], q[1] / (mx || 1)]; });
  }
  function tireW(s) { var m = String(s).match(/(\d{3})\//); return m ? +m[1] / 1000 : 0.25; }
  /** Explicit 40-vertex rings. Half ring layout (21 verts, bottom centre → top centre):
      0 bottom centre, 1 rocker, 2..12 side wall (incl. a vertex pair straddling the wheel-well top),
      cabin: 13 glass base, 14 mid glass, 15 roof rail, 16..20 roof crown; otherwise 13..20 hood/deck crown. */
  function buildSections(m, cfg) {
    cfg = cfg || {};
    var sb = flat(m.side.body, 16), sg = flat(m.side.greenhouse, 16), tb = flat(m.top.body, 16), tg = flat(m.top.greenhouse, 16);
    var tr = flat(m.top.roof, 10), wins = m.side.windows.map(function (w) { return flat(w, 12); });
    function winAt(x) {
      var lo = Infinity, hi = -Infinity;
      wins.forEach(function (wp) { var s = sliceX(wp, x); if (s && s[1] - s[0] > 0.03) { lo = Math.min(lo, s[0]); hi = Math.max(hi, s[1]); } });
      return lo < hi ? [lo, hi] : null;
    }
    var roofB = [Infinity, -Infinity]; tr.forEach(function (p) { p.forEach(function (q) { roofB[0] = Math.min(roofB[0], q[0]); roofB[1] = Math.max(roofB[1], q[0]); }); });
    var PF = profileTable(m.front.body, m.front.greenhouse), PR = profileTable(m.rear.body, m.rear.greenhouse);
    var ref = m.ref, arches = [m.side.archF, m.side.archR];
    var wells = [[m.side.archF, ref.trackF, tireW(ref.tireF)], [m.side.archR, ref.trackR, tireW(ref.tireR)]].map(function (A) {
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - A[2] / 2 - 0.02 };
    });
    var XF = -Infinity, XR = Infinity;
    sb.forEach(function (p) { p.forEach(function (q) { XF = Math.max(XF, q[0]); XR = Math.min(XR, q[0]); }); });
    var xs = [], NS = cfg.stations || 60;
    for (var i = 0; i < NS; i++) xs.push(XR + 0.004 + (XF - XR - 0.008) * (0.5 - 0.5 * Math.cos(Math.PI * i / (NS - 1))));
    [0.012, 0.03, 0.06].forEach(function (d) { xs.push(XF - d, XR + d); });
    [0.014, 0.022, 0.04, 0.08, 0.10, 0.12].forEach(function (d) { xs.push(XR + d); });   // resolve the rounded plan-view tail corner
    var HG = cfg.hatch;                                                                     // explicit backlight (hatch glass) region
    if (HG) HG.xs.forEach(function (x) { xs.push(x); });
    wells.forEach(function (W) { [-1.01, -0.975, -0.85, -0.6, -0.3, 0, 0.3, 0.6, 0.85, 0.975, 1.01].forEach(function (k) { xs.push(W.x + k * W.r); }); });
    // explicit hatch stations win; other stations closer than 8 mm to an already kept one are dropped
    var keep = HG ? HG.xs.slice() : [];
    xs.sort(function (a, b) { return a - b; });
    xs.forEach(function (x) { if (keep.every(function (k) { return Math.abs(k - x) > 0.008; })) keep.push(x); });
    xs = keep.sort(function (a, b) { return a - b; });
    function bottomAt(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.18;
        if (Math.abs(x - a.x) < e) {
          var l = sliceX(sb, a.x - e), r = sliceX(sb, a.x + e);
          var lb = l ? l[0] : ref.groundClearance + 0.05, rb = r ? r[0] : lb;
          return lb + (rb - lb) * (x - (a.x - e)) / (2 * e);
        }
      }
      var s = sliceX(sb, x); return s ? s[0] : ref.groundClearance;
    }
    function beltAt(x) {
      if (cfg.belt) return (x > cfg.xBL && x < cfg.xWS) ? lin(cfg.belt, x) : null;
      var s = sliceX(sg, x); return s && s[1] - s[0] > 0.02 ? s[0] : null;
    }
    function wellAt(x) {
      for (var i = 0; i < wells.length; i++) { var W = wells[i], dx = x - W.x; if (Math.abs(dx) < W.r * 0.985) return { top: W.y + Math.sqrt(W.r * W.r - dx * dx), zIn: W.zIn }; }
      return null;
    }
    function bez(a, c1, c2, b, t) {
      var u = 1 - t;
      return [0, 1].map(function (k) { return u * u * u * a[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * b[k]; });
    }
    var xWS0 = cfg.xWS; if (xWS0 == null) { xWS0 = -Infinity; sg.forEach(function (p) { p.forEach(function (q) { xWS0 = Math.max(xWS0, q[0]); }); }); }
    function sstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
    // tail: the 3D plan-view corner keeps a tight radius (0.12 m) — the plan outline's sweep alone makes a soap-bar tail
    var TR = cfg.tailR || 0.12, TL = cfg.tailL || 0.26, WTL = halfAt(tb, XR + TL) || 0;
    var waistY = cfg.waistY, tuck = cfg.tuck != null ? cfg.tuck : 0.05;
    var out = [];
    xs.forEach(function (x) {
      var sl = sliceX(sb, x); if (!sl) return;
      var yt = sl[1], yb = Math.min(bottomAt(x), yt - 0.03);
      var w = Math.max(halfAt(tb, x) || 0.015, 0.015);
      if (x < XR + TL && WTL > TR) { var dT = Math.max(0, XR + TR - x); w = Math.max(w, WTL - TR + Math.sqrt(Math.max(0, TR * TR - dT * dT))); }
      var bf = x > 0.6 ? 0 : x < -0.6 ? 1 : (0.6 - x) / 1.2; bf = bf * bf * (3 - 2 * bf);
      var P0 = function (y) { return lin(PF, y) * (1 - bf) + lin(PR, y) * bf; };
      // tumblehome: widest at the character-line height, tucking under ~0.05 m to the sill
      var pW = waistY ? Math.max(0.5, P0(waistY)) : 1;
      var P = !waistY ? P0 : function (y) {
        var v = Math.min(1, P0(y) / pW);
        if (y < waistY) { var tt = (waistY - y) / Math.max(0.1, waistY - yb); v = Math.min(v, 1 - (tuck / w) * tt * tt); }
        return Math.max(0.05, v);
      };
      var bl = beltAt(x), cabin = bl != null && yt - bl > 0.05 && bl > yb + 0.15;
      var yS = cabin ? bl - 0.025 : yt - Math.max(0.02, Math.min(0.09, 0.3 * (yt - yb)));
      yS = Math.max(yS, yb + 0.02);
      var wl = wellAt(x);
      function zAt(y) { var z = w * P(y); if (wl && y < wl.top) z = Math.min(z, wl.zIn); return z; }
      var pts = [[yb, 0], [yb, Math.max(0.005, zAt(yb) * 0.9)]];
      // wall: 4 verts up to a pair tracking the arch line (well top inside the arch, wheel-centre height elsewhere),
      // then 5 verts up to the shoulder — every ring vertex keeps its meaning from station to station (no loft twist)
      var na = wells[0], dxa = Math.abs(x - wells[0].x);
      if (Math.abs(x - wells[1].x) < dxa) { na = wells[1]; dxa = Math.abs(x - wells[1].x); }
      var ph = na.y + Math.sqrt(Math.max(0, na.r * na.r - dxa * dxa));
      ph = Math.max(yb + 0.03, Math.min(ph, yS - 0.03));
      if (ph > yS - 0.03) ph = (yb + yS) / 2;
      var hs = [], k;
      for (k = 1; k <= 4; k++) hs.push(yb + (ph - 0.003 - yb) * k / 4);   // last one: just under the well top (clamped)
      hs.push(ph);                                                          // well-top edge (full width)
      for (k = 1; k <= 6; k++) hs.push(ph + (yS - ph) * k / 6);
      hs.forEach(function (y) { pts.push([y, zAt(y)]); });
      var zW = pts[12][1], kind = [];
      if (cabin) {
        var gw = halfAt(tg, x); if (gw == null) gw = zW * 0.8;
        // hatchbacks: the tailgate keeps its width to the tail — no widening shoulder shelf (wagon-like notch) at the C-pillar base
        if (HG && x < HG.x1 + 0.2) gw = Math.max(gw, zW - 0.16 - 0.4 * Math.max(0, x - HG.x1));
        gw = Math.max(0.08, Math.min(gw, zW - 0.04));
        var railY = yt - Math.min(0.06, 0.3 * (yt - bl));
        var rw = Math.max(0.05, gw - 0.16 * (railY - bl));
        pts.push([bl, gw], [(bl + railY) / 2, (gw + rw) / 2 + 0.004], [railY, rw]);
        var ta = unit(railY - bl, rw - gw), rise = yt - railY;
        var c1 = [railY + rise * 0.6, rw + ta[1] / ta[0] * rise * 0.6], c2 = [yt, rw * 0.5];
        for (var c = 1; c <= 5; c++) pts.push(bez([railY, rw], c1, c2, [yt, 0], c / 5));
      } else {
        var a0 = [yS, zW], d1 = [yS + (yt - yS) * 0.8, zW], d2 = [yt, zW * 0.55];
        for (var e = 1; e <= 8; e++) pts.push(bez(a0, d1, d2, [yt, 0], e / 8));
      }
      pts[20] = [yt, 0];
      // 3D surfacing: the hood sits ~0.025 m below the fender crowns (z ≈ ±0.70) from the windshield base to XF-0.15;
      // the crowns themselves carry the side-view silhouette height
      var dip = cfg.hoodDip || { d: 0.025, z: 0.70 }, xD1 = XF - 0.15;
      if (!cabin && x > xWS0 && x < xD1) {
        var wx = sstep((x - xWS0) / 0.15) * sstep((xD1 - x) / 0.15);
        var zF = Math.min(dip.z, zW - 0.06), yF = null;
        for (var hk = 12; hk < 20; hk++) {
          var qa = pts[hk], qb = pts[hk + 1];
          if (qa[1] >= zF && qb[1] <= zF) { var ft = (qa[1] - zF) / ((qa[1] - qb[1]) || 1); yF = qa[0] + (qb[0] - qa[0]) * ft; break; }
        }
        if (yF != null && zF > 0.2) {
          for (var hj = 13; hj <= 20; hj++) {
            var zz = Math.abs(pts[hj][1]), y0 = pts[hj][0], tgt;
            if (zz <= zF) { var uz = 1 - (zz / zF) * (zz / zF); tgt = yt - dip.d * uz * uz; }
            else { var vz = Math.max(0, Math.min(1, (zW - zz) / Math.max(0.01, zW - zF))); tgt = y0 + (yt - yF) * vz * vz; }
            pts[hj] = [y0 + (Math.min(tgt, yt) - y0) * wx, pts[hj][1]];
          }
        }
      }
      var FR = cfg.fenderRise;
      if (FR && !cabin && Math.abs(x - wells[0].x) < FR.dx) {
        var fx = Math.cos(0.5 * Math.PI * (x - wells[0].x) / FR.dx);
        for (var fj = 9; fj <= 20; fj++) {
          var fz = Math.abs(pts[fj][1]);
          if (fz < FR.z0 - 0.06 || fz > FR.z1 + 0.04 || pts[fj][0] < yt - 0.16) continue;
          var fu = fz < FR.z0 ? (fz - FR.z0 + 0.06) / 0.06 : fz > FR.z1 ? 1 - (fz - FR.z1) / 0.04 : 1;
          pts[fj] = [Math.min(m.ref.height, pts[fj][0] + FR.d * fx * fu * fu * (3 - 2 * fu)), pts[fj][1]];
        }
      }
      var flags = pts.map(function (q, j) {
        if (HG && j >= 12 && x >= HG.x0 && x <= HG.x1 && q[0] >= Math.max(HG.y0 - 0.035, yt - 0.07) && q[0] <= HG.y1 + 0.01) {   // the backlight is the ring's crown band
          var ty = Math.max(0, Math.min(1, (q[0] - HG.y0) / (HG.y1 - HG.y0)));
          if ((j >= 16 && Math.abs(q[1]) <= (HG.zMax || Infinity)) || Math.abs(q[1]) <= HG.z0 + (HG.z1 - HG.z0) * ty + 1e-6) return 1;   // whole roof-crown band, plus corners within the outline
        }
        if (!cabin || j < 13) return 0;
        if (j <= 15) { var ws = winAt(x); return ws && q[0] > ws[0] - 0.04 && q[0] < ws[1] + 0.09 ? 1 : 0; }
        if (HG && x <= HG.x1 + 0.02) return 0;   // behind the roof the explicit backlight outline above decides
        return (x > roofB[1] || x < roofB[0]) ? 1 : 0;
      });
      var ring = pts.map(function (q) { return [r4(q[0]), r4(q[1])]; });
      for (var mm = 19; mm >= 1; mm--) { ring.push([ring[mm][0], r4(-ring[mm][1])]); flags.push(flags[mm]); }
      out.push({ x: r4(x), ring: ring, belt: cabin ? r4(bl) : null, glass: flags, _w: w });
    });
    // rear-glass base: blend the last cabin ring into the stations behind it (no step where the greenhouse ends) —
    // strongest on the first stations, fading out toward the tail cap
    for (var bi = 1; bi < out.length; bi++) {
      if (out[bi].belt == null || out[bi - 1].belt != null) continue;
      var cab = out[bi], cr = cab.ring;
      var cyb = cr[0][0], cyt = cr[20][0], Lb = Math.max(0.06, 0.85 * (cab.x - XR)), bl8 = [];
      for (var bk = bi - 1; bk >= 0; bk--) { var dd = cab.x - out[bk].x; if (dd < Lb) bl8.push([bk, 0.85 * Math.pow(1 - dd / Lb, 0.7)]); }
      bl8.forEach(function (BT) {
        var S = out[BT[0]]; if (!S || S.belt != null) return;
        var nr = S.ring, nyb = nr[0][0], nyt = nr[20][0], ws = S._w / (cab._w || 1);
        S.ring = nr.map(function (q, j) {
          var c = cr[j], my = nyb + (c[0] - cyb) / ((cyt - cyb) || 1) * (nyt - nyb), mz = c[1] * ws;
          return [r4(q[0] + (my - q[0]) * BT[1]), r4(q[1] + (mz - q[1]) * BT[1])];
        });
      });
      break;
    }
    out.forEach(function (S) { delete S._w; });
    return out;
  }

  var C = 1; // corner flag

  /* ================================================================== VW GOLF GTI Mk8 */
  function golfGTI() {
    var ref = {
      length: 4.287, width: 1.789, height: 1.457, wheelbase: 2.627, trackF: 1.535, trackR: 1.513,
      frontOverhang: 0.878, rearOverhang: 0.782, wheelDiameter_in: 18, tireF: '225/40R18', tireR: '225/40R18',
      groundClearance: 0.135, rideHeight: 0.135, cd: 0.30, curbWeight_kg: 1463
    };
    var A = ref.wheelbase / 2, XF = A + ref.frontOverhang, XR = -A - ref.rearOverhang, H = ref.height, W2 = ref.width / 2;
    var tr = tireRadius(ref.tireF, ref.wheelDiameter_in), ar = tr + 0.046, GC = ref.groundClearance;

    /* ---------- side ----------
       Crisp near-vertical nose with the hood leading edge at the headlamp tops, windshield base at x≈0.90, roof peak
       just behind the B-pillar falling gently to a body-colour roof spoiler, hatch glass leaning back to the tailgate
       lip; DLO top falling toward the famous forward-leaning C-pillar, wedge quarter glass, gloss-black side skirt. */
    var sideBody = closedP([
      [2.120, 0.200, C], [2.165, 0.245], [2.186, 0.300], [XF, 0.425], [2.188, 0.550], [2.176, 0.640], [2.158, 0.705], [2.128, 0.748], [2.060, 0.770],
      [1.700, 0.822], [1.300, 0.874], [1.080, 0.914], [0.900, 0.966, C],
      [0.500, 1.180], [0.150, 1.356], [-0.120, 1.446], [-0.350, H], [-1.000, 1.430], [-1.550, 1.405], [-1.700, 1.398], [-1.790, 1.400],
      [-1.840, 1.396, C], [-1.876, 1.334],
      [-1.964, 1.130], [-2.046, 1.000], [-2.077, 0.900], [-2.0905, 0.800], [XR, 0.620],
      [-2.0925, 0.410], [-2.075, 0.320], [-2.040, 0.262], [-1.998, 0.235, C], [-1.700, 0.196], [-1.100, 0.150], [-0.900, GC, C],
      [0.900, GC, C], [1.150, 0.152], [1.800, 0.182]
    ]);
    // starts at the A-pillar's inner edge and ends at the quarter-glass tip: both A- and C-pillars are plain body
    // (no separate pillar fill, so they share the body's paint gradient)
    var greenhouse = closedP([
      [0.738, 0.975, C], [0.458, 1.156], [0.150, 1.331], [-0.050, 1.374], [-0.330, 1.384], [-0.700, 1.375], [-0.980, 1.352],
      [-1.160, 1.326, C], [-1.372, 1.058, C], [-1.000, 1.030], [-0.300, 1.000], [0.500, 0.980]
    ]);
    var winFront = closedP([[0.720, 0.984, C], [0.450, 1.150], [0.150, 1.322], [-0.050, 1.364], [-0.285, 1.374, C], [-0.278, 0.998, C]]);
    var winRear = closedP([[-0.368, 1.000, C], [-0.372, 1.374, C], [-0.700, 1.365], [-0.958, 1.343, C], [-0.972, 1.020, C]]);
    var winQtr = closedP([[-1.004, 1.338, C], [-1.085, 1.327], [-1.160, 1.310, C], [-1.360, 1.060, C], [-1.200, 1.044], [-1.018, 1.024, C]]);
    var pillarB = poly([[-0.278, 0.998], [-0.285, 1.374], [-0.372, 1.374], [-0.368, 1.000]]);
    var divider = poly([[-0.972, 1.020], [-0.958, 1.343], [-1.004, 1.338], [-1.018, 1.024]]);
    var rArc = arc(-A, tr, ar + 0.05, 64, 6, 4);
    var doorCuts = [
      openP([[0.892, 0.972], [0.880, 0.760], [0.876, 0.560], [0.880, 0.262, C]]).concat([{ t: 'L', p: [pt(-0.322, 0.256)] }]),
      openP([[-0.322, 0.998], [-0.330, 0.640], [-0.322, 0.256]]),
      openP([[-1.358, 1.056], [-1.310, 0.900], [rArc[0][0], rArc[0][1]]].concat(rArc.slice(1, 4)).concat([[-0.905, 0.300], [-0.905, 0.256, C]])).concat([{ t: 'L', p: [pt(-0.322, 0.256)] }])
    ];
    var panelLines = [
      openP([[2.060, 0.758], [1.700, 0.808], [1.300, 0.860], [1.080, 0.900], [0.905, 0.952]]),
      openP([[-1.852, 1.380], [-1.890, 1.312], [-1.968, 1.120], [-2.026, 0.995], [-2.050, 0.905]]),
      rrect(-1.560, 0.830, -1.300, 0.945, 0.025)
    ];
    var characterLines = [
      openP([[2.040, 0.748], [1.400, 0.808], [0.600, 0.856], [-0.400, 0.878], [-1.300, 0.902], [-1.700, 0.924], [-1.960, 0.936]]), // "tornado" line
      openP([[0.930, 0.430], [0.300, 0.448], [-0.400, 0.462], [-0.930, 0.478]])
    ];
    var sill = closedP([[0.950, 0.200, C], [-0.950, 0.200, C], [-0.968, 0.170], [-0.935, 0.140, C], [0.935, 0.140, C], [0.968, 0.170]]);
    var lowerTrim = join(
      closedP([[2.120, 0.200, C], [2.160, 0.255], [2.050, 0.236], [1.820, 0.214, C], [1.800, 0.182, C]]),
      closedP([[-1.998, 0.235, C], [-2.058, 0.320], [-2.040, 0.335], [-1.900, 0.300], [-1.760, 0.258, C], [-1.700, 0.196, C]])
    );

    /* ---------- top ---------- nose tapers to ~1.50 m at the bumper, haunches over both axles, tail ~1.59 m */
    var topBody = symTop([[XF, 0], [2.180, 0.300], [2.140, 0.520], [2.070, 0.680], [1.960, 0.790], [1.800, 0.860], [1.500, 0.890], [1.320, W2],
      [1.000, 0.884], [0.700, 0.876], [-0.300, 0.876], [-0.900, 0.880], [-1.310, W2], [-1.500, 0.880], [-1.676, 0.850], [-1.816, 0.790], [-1.916, 0.710], [XR + 0.100, 0.600], [XR + 0.045, 0.480], [XR + 0.012, 0.300], [XR, 0]]);
    var topGreen = symTop([[0.905, 0], [0.885, 0.450], [0.820, 0.630], [0.600, 0.700], [0.000, 0.708], [-1.000, 0.696], [-1.600, 0.660], [-1.860, 0.600], [-1.918, 0.460], [-1.930, 0]]);
    var topHood = symTop([[2.040, 0], [2.020, 0.450], [1.940, 0.690], [1.600, 0.758], [1.250, 0.744], [0.930, 0.700], [0.925, 0]]);
    var topRoof = symTop([[0.040, 0], [0.030, 0.500], [-0.050, 0.598], [-0.600, 0.624], [-1.500, 0.600], [-1.820, 0.560], [-1.845, 0.400], [-1.850, 0]]);
    var topDeck = symTop([[-1.850, 0], [-1.845, 0.400], [-1.820, 0.560], [-1.890, 0.620], [-1.950, 0.570], [-1.966, 0.400], [-1.970, 0]]);
    var mR = [[0.700, 0.862], [0.722, 0.930], [0.705, 1.000], [0.645, 1.036], [0.560, 1.024], [0.575, 0.945], [0.600, 0.866]];
    var topMirrors = pairTop(mR);   // one path per side

    /* ---------- front ---------- convex shoulder: body at ±0.845 at the belt, glass base inset to ±0.705 */
    var frontBody = symFR([[0, H], [0.400, 1.455], [0.565, 1.430], [0.630, 1.375], [0.670, 1.200], [0.705, 1.005, C],
      [0.790, 0.978], [0.845, 0.950], [0.880, 0.870], [W2, 0.740], [0.890, 0.560], [0.876, 0.360], [0.850, 0.230], [0.720, 0.180], [0, 0.172]]);
    var frontGreen = symFR([[0, 1.405], [0.420, 1.398], [0.535, 1.380], [0.598, 1.320], [0.655, 1.100], [0.690, 1.012, C], [0.600, 0.999], [0, 0.993]]);
    var frontBumper = symFR([[0, 0.662], [0.460, 0.666], [0.700, 0.680], [0.862, 0.700, C], [0.884, 0.620], [0.890, 0.560], [0.876, 0.360], [0.850, 0.230], [0.720, 0.180], [0, 0.172]]);
    var hlR = [[0.470, 0.700, C], [0.560, 0.738], [0.700, 0.762], [0.820, 0.778], [0.875, 0.790], [0.880, 0.760], [0.852, 0.718], [0.780, 0.688], [0.620, 0.674], [0.500, 0.676]];
    var headlights = pairFR(hlR);
    var drlS = [[0.560, 0.738], [0.700, 0.760], [0.820, 0.775], [0.866, 0.784], [0.868, 0.776], [0.822, 0.767], [0.700, 0.752], [0.565, 0.730]];
    // illuminated cross-bar centred at y 0.705 inside the gloss-black slot, joining the headlamp inner ends
    var drl = [poly([[-0.470, 0.7015], [0.470, 0.7015], [0.470, 0.7085], [-0.470, 0.7085]]), closedP(drlS), closedP(mirPts(drlS).reverse())];
    // gloss-black upper slot across the full nose (±0.60), running in under the headlamp inner ends at y 0.70
    var grilleUpper = symFR([[0, 0.736], [0.380, 0.733], [0.470, 0.726], [0.560, 0.716], [0.600, 0.702, C], [0.560, 0.688], [0.470, 0.680], [0.400, 0.668], [0, 0.666]]);
    // full-width honeycomb trapezoid: 1.20 m at the top (y 0.42), 1.42 m at the bottom (y 0.20), r 0.03 corners
    var gLowH = [[0, 0.420], [0.600, 0.420], [0.740, 0.200], [0, 0.200]];
    var grilleLower = rpoly([[-0.600, 0.420], [0.600, 0.420], [0.740, 0.200], [-0.740, 0.200]], 0.03);
    // the outer ends of the honeycomb (carry the fog clusters) — merged with the main intake, filling the bumper corners
    var intakes = rpolyPair([[0.540, 0.420], [0.600, 0.420], [0.740, 0.200], [0.540, 0.200]], 0.03);
    var FZ = 0.606, FY = 0.320, fog = [];
    [[0, 0], [0.022, 0.022], [-0.022, 0.022], [0.022, -0.022], [-0.022, -0.022]].forEach(function (o) {
      fog.push(ell(FZ + o[0], FY + o[1], 0.0095, 0.0095));
      fog.push(ell(-FZ - o[0], FY + o[1], 0.0095, 0.0095));
    });
    var splitter = symFR([[0, 0.206], [0.600, 0.210], [0.800, 0.222], [0.830, 0.205], [0.780, 0.184], [0.600, 0.176], [0, 0.174]]);

    /* ---------- rear ---------- */
    var rearBody = symFR([[0, H], [0.400, 1.455], [0.565, 1.430], [0.625, 1.375], [0.660, 1.220], [0.690, 1.075, C],
      [0.790, 1.020], [0.850, 0.985], [0.882, 0.900], [W2, 0.760], [0.890, 0.560], [0.872, 0.360], [0.840, 0.232], [0.700, 0.200], [0, 0.198]]);
    var rearGreen = symFR([[0, 1.335], [0.440, 1.330], [0.528, 1.300], [0.590, 1.160], [0.630, 1.082, C], [0.540, 1.074], [0, 1.070]]);
    var spoiler = symFR([[0, 1.392], [0.420, 1.392], [0.555, 1.385], [0.585, 1.352], [0.540, 1.338], [0, 1.338]]);
    var rearBumper = symFR([[0, 0.660], [0.500, 0.662], [0.760, 0.672], [0.870, 0.690, C], [0.890, 0.560], [0.872, 0.360], [0.840, 0.232], [0.700, 0.200], [0, 0.198]]);
    var tlR = [[0.405, 0.990, C], [0.700, 0.996], [0.850, 1.000], [0.878, 0.958], [0.874, 0.884], [0.760, 0.868], [0.560, 0.878], [0.430, 0.912], [0.405, 0.948, C]];
    var taillights = pairFR(tlR);
    var tlInnerSig = pairFR([[0.450, 0.968, C], [0.840, 0.976, C], [0.840, 0.966, C], [0.470, 0.958, C], [0.470, 0.915, C], [0.458, 0.918, C]]);
    var diffuser = symFR([[0, 0.365], [0.500, 0.365], [0.740, 0.352], [0.815, 0.300], [0.800, 0.225], [0.620, 0.205], [0, 0.202]]);
    var exhaust = [{ shape: 'round', cx: 0.570, cy: 0.272, w: 0.092, h: 0.092 }, { shape: 'round', cx: -0.570, cy: 0.272, w: 0.092, h: 0.092 }];

    var details = [];
    // side
    details.push(D('side', 'mirror', closedP([[0.770, 0.930], [0.720, 1.010], [0.610, 1.032], [0.525, 1.010], [0.515, 0.900], [0.580, 0.858], [0.700, 0.850]]), 'body'));
    details.push(D('side', 'mirrorArm', poly([[0.700, 0.935], [0.775, 0.935], [0.765, 0.968], [0.690, 0.968]]), 'black'));
    details.push(D('side', 'handle', closedP([[0.020, 0.862], [-0.200, 0.864], [-0.210, 0.846], [-0.190, 0.832], [0.010, 0.830], [0.028, 0.846]]), 'body'));
    details.push(D('side', 'handle', closedP([[-0.890, 0.902], [-1.100, 0.904], [-1.110, 0.886], [-1.092, 0.872], [-0.900, 0.870], [-0.882, 0.886]]), 'body'));
    // short IQ.Light sliver wrapping into the fender top (x 1.83–2.16, y 0.69–0.775)
    details.push(D('side', 'light', closedP([[1.830, 0.772, C], [1.960, 0.766], [2.070, 0.748], [2.140, 0.712, C], [2.155, 0.690], [2.110, 0.690], [1.980, 0.716], [1.880, 0.746]]), 'light'));
    details.push(D('side', 'light', closedP([[-2.040, 0.952, C], [-1.800, 0.946], [-1.650, 0.906, C], [-1.800, 0.842], [-1.960, 0.802], [-2.055, 0.815, C]]), 'light-red'));
    details.push(D('side', 'grille', rpoly([[2.185, 0.410], [2.125, 0.405], [2.110, 0.275], [2.180, 0.255]], 0.012), 'grille'));
    details.push(D('side', 'marker', ell(-1.985, 0.330, 0.03, 0.008), 'light-red'));
    // hatch glass seen edge-on: a thin dark band just inside the leaning tailgate edge, under the roof spoiler
    details.push(D('side', 'trim', closedP([[-1.850, 1.384, C], [-1.884, 1.316], [-1.954, 1.128], [-1.994, 1.052, C], [-1.970, 1.054], [-1.932, 1.128], [-1.862, 1.314], [-1.828, 1.386, C]]), 'gloss-black'));
    details.push(D('side', 'antenna', closedP([[-1.300, 1.427, C], [-1.390, 1.468], [-1.440, 1.464], [-1.465, 1.415, C]]), 'body'));
    details.push(D('side', 'badge', rrect(0.860, 0.770, 1.050, 0.784, 0.005), 'chrome'));
    // top
    details.push(D('top', 'antenna', ell(-1.400, 0, 0.075, 0.025), 'body'));
    details.push(D('top', 'wiper', poly([[0.930, -0.640], [0.950, -0.640], [0.950, 0.040], [0.930, 0.040]]), 'black'));
    details.push(D('top', 'wiper', poly([[0.930, 0.080], [0.950, 0.080], [0.950, 0.660], [0.930, 0.660]]), 'black'));
    details.push(D('top', 'crease', openP([[2.030, 0.260], [1.500, 0.300], [0.940, 0.330]]), 'body'));
    details.push(D('top', 'crease', openP([[2.030, -0.260], [1.500, -0.300], [0.940, -0.330]]), 'body'));
    // front
    details = details.concat(Dpair('front', 'mirror', pairFR([[0.860, 0.890], [0.950, 0.878], [1.030, 0.908], [1.036, 0.962], [0.990, 0.994], [0.900, 0.990], [0.862, 0.950]]), 'body'));
    details.push(D('front', 'wiper', poly([[-0.600, 0.995], [0.040, 1.012], [0.040, 1.022], [-0.600, 1.005]]), 'black'));
    details.push(D('front', 'wiper', poly([[0.080, 1.002], [0.640, 0.998], [0.640, 1.008], [0.080, 1.012]]), 'black'));
    details.push(D('front', 'stripe', symFR([[0, 0.744], [0.380, 0.741], [0.470, 0.720], [0.474, 0.714], [0.380, 0.735], [0, 0.738]]), 'light-red'));
    details.push(D('front', 'grille', meshIn(gLowH, 0.042, [[-0.260, 0.255, 0.260, 0.365], [FZ - 0.036, FY - 0.036, FZ + 0.036, FY + 0.036], [-FZ - 0.036, FY - 0.036, -FZ + 0.036, FY + 0.036]]), 'grille'));
    details.push(D('front', 'washer', ellPair(0.300, 0.640, 0.012, 0.006)[0], 'black'));
    details.push(D('front', 'washer', ellPair(0.300, 0.640, 0.012, 0.006)[1], 'black'));
    // rear
    details = details.concat(Dpair('rear', 'mirror', pairFR([[0.860, 0.890], [0.950, 0.878], [1.030, 0.908], [1.036, 0.962], [0.990, 0.994], [0.900, 0.990], [0.862, 0.950]]), 'body'));
    details = details.concat(Dpair('rear', 'light', tlInnerSig, 'light'));
    details.push(D('rear', 'wiper', poly([[0.010, 1.088], [0.400, 1.150], [0.398, 1.160], [0.006, 1.098]]), 'black'));
    details.push(D('rear', 'shutline', openP([[-0.620, 1.072], [-0.640, 0.960], [-0.610, 0.740], [-0.500, 0.700], [0, 0.694], [0.500, 0.700], [0.610, 0.740], [0.640, 0.960], [0.620, 1.072]]), 'black'));
    details = details.concat(Dpair('rear', 'reflector', pairFR([[0.700, 0.392, C], [0.810, 0.392, C], [0.810, 0.404, C], [0.700, 0.404, C]]), 'light-red'));
    details = details.concat(strakes([-0.36, -0.12, 0.12, 0.36], 0.215, 0.345, 0.014).map(function (p) { return D('rear', 'strake', p, 'gloss-black'); }));
    details.push(D('rear', 'badgeText', rrect(-0.420, 0.826, -0.300, 0.834, 0.003), 'chrome'));       // "GTI" script
    details.push(D('rear', 'badgeText', rrect(0.300, 0.826, 0.420, 0.834, 0.003), 'chrome'));         // "Golf" script

    var model = {
      id: 'vw-golf-gti-mk8', make: 'Volkswagen', name: 'Golf GTI', gen: 'Mk8', years: '2020–', style: 'hatchback',
      look: { head: 'slim-led', tail: 'slim', grille: 'honeycomb' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'fwd', powertrain: 'ice', doors: 5,
      ref: ref,
      side: {
        body: sideBody, greenhouse: greenhouse, windows: [winFront, winRear, winQtr], pillars: [{ path: pillarB, paint: 'gloss-black' }, { path: divider, paint: 'gloss-black' }],
        doorCuts: doorCuts, panelLines: panelLines, characterLines: characterLines, sill: { path: sill, paint: 'gloss-black' },
        archF: { x: A, y: tr, r: ar, flare: 0.018, shape: 'round' }, archR: { x: -A, y: tr, r: ar, flare: 0.018, shape: 'round' },
        lowerTrim: lowerTrim
      },
      top: { body: topBody, greenhouse: topGreen, hood: topHood, roof: topRoof, deck: topDeck, mirrors: topMirrors },
      front: {
        body: frontBody, greenhouse: frontGreen, bumper: frontBumper, grille: [{ path: grilleUpper, paint: 'gloss-black' }, grilleLower], intakes: intakes,
        headlights: headlights, drl: drl, fogLights: fog, splitter: splitter,
        plateArea: rrect(-0.260, 0.255, 0.260, 0.365, 0.01), badgeArea: ell(0, 0.704, 0.068, 0.068),
        badgeText: 'VW'
      },
      rear: {
        body: rearBody, greenhouse: rearGreen, bumper: rearBumper, taillights: taillights, diffuser: diffuser, exhaust: exhaust,
        plateArea: rrect(-0.260, 0.705, 0.260, 0.815, 0.01), badgeArea: ell(0, 0.930, 0.062, 0.062), spoiler: spoiler,
        badgeText: 'VW'
      },
      details: details,
      signature: {
        headlights: 'Ultra-slim IQ.Light LED matrix units joined by an illuminated LED cross-bar under a thin red GTI stripe that runs the full width of the nose',
        taillights: 'Wide two-piece horizontal LED clusters split across body and tailgate, with a bracket-shaped light signature',
        grille: 'Minimal slot upper grille; full-width trapezoidal honeycomb lower intake carrying X-pattern 5-LED fog light clusters at its outer ends',
        notes: 'Sharp "tornado" shoulder line, forward-leaning thick C-pillar with wedge quarter glass, body-colour roof spoiler, gloss-black skirts, twin round exhaust tips one each side'
      }
    };
    model.sections = buildSections(model, {
      // explicit belt: the 3D cabin continues past the quarter glass to the hatch (body-colour C-pillar)
      xWS: 0.90, xBL: -1.99,
      belt: [[-1.99, 1.062], [-1.66, 1.066], [-1.00, 1.030], [-0.30, 1.000], [0.50, 0.976], [0.90, 0.966]],
      waistY: 0.88,
      hatch: { xs: [-1.993, -1.978, -1.96, -1.935, -1.91, -1.885, -1.86, -1.835, -1.81, -1.80], x0: -1.997, x1: -1.80, y0: 1.04, y1: 1.385, z0: 0.55, z1: 0.47 }
    });
    return model;
  }

  /* ================================================================== HONDA CIVIC TYPE R FL5 */
  function civicTypeR() {
    var ref = {
      length: 4.594, width: 1.890, height: 1.405, wheelbase: 2.735, trackF: 1.625, trackR: 1.615,
      frontOverhang: 0.985, rearOverhang: 0.874, wheelDiameter_in: 19, tireF: '265/30R19', tireR: '265/30R19',
      groundClearance: 0.125, rideHeight: 0.125, cd: 0.31, curbWeight_kg: 1446
    };
    var A = ref.wheelbase / 2, XF = A + ref.frontOverhang, XR = -A - ref.rearOverhang, H = ref.height, W2 = ref.width / 2;
    var tr = tireRadius(ref.tireF, ref.wheelDiameter_in), ar = tr + 0.037, GC = ref.groundClearance;   // tight FL5 arch gap
    var XT = -2.232; // upright tail face (bumper below the lamps)

    /* ---------- side ----------
       Windshield base pushed far forward, long low roof running into a straight flat fastback slope to the lip at
       (-2.05, 1.10), sharp-tailed quarter glass, upright tail with a black diffuser, flared arches with raised lips,
       gloss-black blade wing on two pedestal uprights standing on the hatch lid. */
    var sideBody = closedP([
      [2.250, 0.172, C], [2.300, 0.250], [XF, 0.400], [2.345, 0.560], [2.320, 0.690], [2.270, 0.770, C], [2.180, 0.792],
      [1.800, 0.815], [1.400, 0.852], [1.150, 0.892], [0.950, 0.935, C],
      [0.620, 1.120], [0.330, 1.290], [0.150, 1.368], [-0.150, 1.398], [-0.550, H], [-1.000, 1.392], [-1.300, 1.345], [-1.600, 1.262], [-1.850, 1.175],
      [-2.050, 1.103, C], [-2.110, 1.092, C], [-2.118, 1.060, C],
      [-2.170, 1.000], [-2.205, 0.920], [-2.2285, 0.800], [XT, 0.600], [-2.2288, 0.400], [-2.205, 0.318], [-2.160, 0.250], [-2.100, 0.196, C],
      [-1.700, 0.165], [-1.150, 0.135], [-0.950, GC, C], [0.950, GC, C], [1.200, 0.140], [1.850, 0.150]
    ]);
    var greenhouse = closedP([
      [0.950, 0.935, C], [0.620, 1.120], [0.330, 1.290], [0.150, 1.355], [-0.150, 1.384], [-0.550, 1.390], [-1.000, 1.377], [-1.300, 1.330],
      [-1.600, 1.248], [-1.850, 1.162], [-1.990, 1.112, C], [-1.760, 1.050], [-1.400, 0.992], [-0.800, 0.972], [0.000, 0.958], [0.600, 0.944]
    ]);
    var winFront = closedP([[0.720, 0.950, C], [0.480, 1.110], [0.230, 1.268], [0.060, 1.334], [-0.150, 1.360], [-0.300, 1.362, C], [-0.290, 0.966, C]]);
    var winRear = closedP([[-0.410, 0.968, C], [-0.415, 1.362, C], [-0.700, 1.360], [-0.900, 1.344], [-1.040, 1.324, C], [-1.030, 0.982, C]]);
    var winQtr = closedP([[-1.090, 1.316, C], [-1.380, 1.262], [-1.700, 1.090, C], [-1.560, 1.040], [-1.300, 1.000], [-1.090, 0.986, C]]);
    var pillarA = closedP([[0.950, 0.935, C], [0.620, 1.120], [0.330, 1.290], [0.150, 1.355], [-0.150, 1.384, C], [-0.150, 1.360], [0.060, 1.334], [0.230, 1.268], [0.480, 1.110], [0.720, 0.950, C]]);
    var pillarB = poly([[-0.290, 0.966], [-0.300, 1.362], [-0.415, 1.362], [-0.410, 0.968]]);
    var divider = poly([[-1.030, 0.982], [-1.040, 1.324], [-1.090, 1.316], [-1.090, 0.986]]);
    var pillarC = closedP([[-1.700, 1.090, C], [-1.640, 1.234, C], [-1.850, 1.162], [-1.990, 1.112, C], [-1.760, 1.050], [-1.620, 1.040, C]]);
    var rArc = arc(-A, tr, ar + 0.085, 64, 8, 4);
    var doorCuts = [
      openP([[0.940, 0.942], [0.900, 0.720], [0.875, 0.500], [0.870, 0.240, C]]).concat([{ t: 'L', p: [pt(-0.235, 0.236)] }]),
      openP([[-0.240, 0.962], [-0.235, 0.620], [-0.235, 0.236]]),
      openP([[-1.255, 0.990], [-1.220, 0.860], [rArc[0][0], rArc[0][1]]].concat(rArc.slice(1, 4)).concat([[-0.900, 0.300], [-0.898, 0.236, C]])).concat([{ t: 'L', p: [pt(-0.235, 0.236)] }])
    ];
    var panelLines = [
      openP([[2.140, 0.740], [1.800, 0.786], [1.400, 0.838], [1.150, 0.878], [0.955, 0.920]]),
      openP([[-2.060, 1.094], [-2.125, 1.030], [-2.170, 0.950], [-2.195, 0.870]]),
      rrect(-1.420, 0.800, -1.270, 0.920, 0.018)
    ];
    var characterLines = [
      openP([[2.180, 0.730], [1.700, 0.776], [1.000, 0.846], [0.000, 0.884], [-1.000, 0.900], [-1.650, 0.912], [-2.120, 0.925]]),
      openP([[0.880, 0.400], [0.200, 0.388], [-0.500, 0.390], [-0.900, 0.410]]),
      openP(arc(A, tr, ar + 0.05, 172, 8, 10)),        // raised front flare lip
      openP(arc(-A, tr, ar + 0.05, 172, 8, 10))        // raised rear flare lip
    ];
    var sill = closedP([[0.980, 0.236, C], [0.200, 0.232], [-0.980, 0.236, C], [-1.000, 0.200], [-0.960, GC + 0.002, C], [0.960, GC + 0.002, C], [1.000, 0.200]]);
    var lowerTrim = join(
      closedP([[0.980, 0.240, C], [-0.980, 0.240, C], [-0.990, 0.180], [-0.960, GC + 0.002, C], [0.960, GC + 0.002, C], [0.990, 0.180]]),
      closedP([[2.250, 0.172, C], [2.284, 0.226], [2.180, 0.210], [1.900, 0.190, C], [1.850, 0.150, C]]),
      closedP([[-2.100, 0.196, C], [-2.160, 0.262], [-2.200, 0.350, C], [-2.232, 0.340, C], [-2.236, 0.170, C], [-1.950, 0.160], [-1.700, 0.165, C]])  // diffuser, 0.03 proud
    );

    /* ---------- top ---------- */
    var topBody = symTop([[XF, 0], [2.340, 0.300], [2.300, 0.540], [2.230, 0.710], [2.120, 0.820], [1.950, 0.900], [1.600, 0.935], [1.370, W2], [1.000, 0.938],
      [0.700, 0.915], [-0.500, 0.915], [-0.950, 0.928], [-1.370, W2], [-1.610, 0.925], [-1.812, 0.880], [-1.952, 0.810], [-2.052, 0.720], [XT + 0.100, 0.600], [XT + 0.045, 0.480], [XT + 0.012, 0.300], [XT, 0]]);
    var topGreen = symTop([[0.955, 0], [0.935, 0.480], [0.860, 0.660], [0.600, 0.722], [-0.300, 0.728], [-1.200, 0.700], [-1.800, 0.630], [-2.010, 0.560], [-2.035, 0.400], [-2.040, 0]]);
    var topHood = symTop([[2.135, 0], [2.110, 0.480], [2.040, 0.720], [1.700, 0.778], [1.250, 0.762], [0.975, 0.716], [0.970, 0]]);
    var topRoof = symTop([[0.170, 0], [0.150, 0.520], [0.060, 0.616], [-0.600, 0.640], [-1.200, 0.618], [-1.330, 0.590], [-1.345, 0.420], [-1.350, 0]]);
    var topDeck = symTop([[-1.350, 0], [-1.345, 0.420], [-1.330, 0.590], [-1.800, 0.640], [-2.060, 0.600], [-2.120, 0.420], [-2.128, 0]]);
    var mR = [[0.620, 0.900], [0.645, 0.960], [0.628, 1.030], [0.570, 1.062], [0.480, 1.050], [0.496, 0.975], [0.522, 0.904]];
    var topMirrors = pairTop(mR);   // one path per side

    /* ---------- front ---------- */
    var frontBody = symFR([[0, H], [0.380, 1.398], [0.545, 1.374], [0.615, 1.320], [0.660, 1.160], [0.705, 0.958, C],
      [0.810, 0.945], [0.885, 0.915], [0.925, 0.840], [W2, 0.680], [0.942, 0.470], [0.925, 0.300], [0.885, 0.190], [0.700, 0.150], [0, 0.146]]);
    var frontGreen = symFR([[0, 1.352], [0.400, 1.346], [0.520, 1.328], [0.592, 1.270], [0.645, 1.080], [0.690, 0.966, C], [0.600, 0.956], [0, 0.950]]);
    // bumper corners stop at ±0.905: the bolted-on looking arch flares stand 0.04 m proud of them
    var frontBumper = symFR([[0, 0.612], [0.460, 0.616], [0.760, 0.640], [0.880, 0.662], [0.902, 0.600], [0.905, 0.470], [0.894, 0.300], [0.862, 0.192], [0.700, 0.150], [0, 0.146]]);
    var hlR = [[0.470, 0.658, C], [0.470, 0.708], [0.600, 0.730], [0.780, 0.746], [0.890, 0.752], [0.905, 0.724], [0.860, 0.688], [0.700, 0.668], [0.540, 0.656]];
    var headlights = pairFR(hlR);
    var drlR = [[0.490, 0.666, C], [0.700, 0.676], [0.860, 0.694], [0.866, 0.685], [0.700, 0.667], [0.492, 0.657, C]];
    var drl = pairFR(drlR);
    var grilleUpper = symFR([[0, 0.600], [0.420, 0.598], [0.468, 0.585], [0.450, 0.548], [0.380, 0.536], [0, 0.534]]);
    var grilleBar = symFR([[0, 0.708], [0.440, 0.708], [0.468, 0.700, C], [0.472, 0.680], [0.466, 0.658, C], [0.440, 0.654], [0, 0.652]]);
    // lower intake: sharp trapezoid 1.10 m wide at y 0.50, 1.32 m at y 0.20, r 0.03
    var gLowH = [[0, 0.500], [0.550, 0.500], [0.660, 0.200], [0, 0.200]];
    var grilleLower = rpoly([[-0.550, 0.500], [0.550, 0.500], [0.660, 0.200], [-0.660, 0.200]], 0.03);
    var intakes = rpolyPair([[0.705, 0.530], [0.850, 0.556], [0.868, 0.262], [0.745, 0.236]], 0.025);   // vertical corner ducts
    var splitter = symFR([[0, 0.182], [0.600, 0.186], [0.840, 0.196], [0.890, 0.176], [0.820, 0.152], [0.600, 0.146], [0, 0.144]]);

    /* ---------- rear ---------- */
    var rearBody = symFR([[0, H], [0.360, 1.398], [0.540, 1.374], [0.606, 1.320], [0.650, 1.200], [0.690, 1.110, C],
      [0.820, 1.050], [0.900, 0.990], [0.932, 0.880], [W2, 0.720], [0.940, 0.470], [0.918, 0.310], [0.870, 0.200], [0.700, 0.168], [0, 0.165]]);
    var rearGreen = symFR([[0, 1.348], [0.400, 1.340], [0.500, 1.310], [0.580, 1.200], [0.640, 1.118, C], [0.540, 1.110], [0, 1.106]]);
    var wingRear = uniWind(join(
      symFR([[0, 1.210], [0.700, 1.210], [0.752, 1.204], [0.758, 1.176], [0.700, 1.170], [0, 1.170]]),     // blade
      rpolyPair([[0.745, 1.250], [0.772, 1.250], [0.772, 1.160], [0.745, 1.165]], 0.006)[0],              // thin endplates y 1.16–1.25
      rpolyPair([[0.745, 1.250], [0.772, 1.250], [0.772, 1.160], [0.745, 1.165]], 0.006)[1],
      rpolyPair([[0.335, 1.172], [0.365, 1.172], [0.372, 1.100], [0.328, 1.100]], 0.004)[0],              // pedestal uprights
      rpolyPair([[0.335, 1.172], [0.365, 1.172], [0.372, 1.100], [0.328, 1.100]], 0.004)[1]
    ));
    var rearBumper = symFR([[0, 0.700], [0.500, 0.702], [0.800, 0.722], [0.895, 0.740, C], [0.905, 0.600], [0.905, 0.470], [0.892, 0.310], [0.860, 0.200], [0.700, 0.168], [0, 0.165]]);
    // boomerang C-hook: the inner end turns down 0.02 m
    var tlR = [[0.420, 0.970, C], [0.520, 0.992], [0.700, 1.000], [0.850, 1.004], [0.900, 0.960], [0.912, 0.900], [0.860, 0.886], [0.840, 0.950], [0.640, 0.952], [0.500, 0.944], [0.432, 0.928, C]];
    var taillights = pairFR(tlR);
    var diffuser = symFR([[0, 0.360], [0.520, 0.360], [0.760, 0.342], [0.840, 0.290], [0.820, 0.200], [0.600, 0.172], [0, 0.168]]);
    var exhaust = [
      { shape: 'round', cx: -0.135, cy: 0.268, w: 0.100, h: 0.100 },
      { shape: 'round', cx: 0, cy: 0.262, w: 0.068, h: 0.068 },
      { shape: 'round', cx: 0.135, cy: 0.268, w: 0.100, h: 0.100 }
    ];

    var details = [];
    details.push(D('side', 'mirror', closedP([[0.715, 0.940], [0.660, 1.020], [0.560, 1.034], [0.470, 1.010], [0.460, 0.930], [0.520, 0.880], [0.640, 0.872]]), 'gloss-black'));
    details.push(D('side', 'handle', closedP([[0.065, 0.812], [-0.190, 0.814], [-0.200, 0.795], [-0.180, 0.782], [0.055, 0.780], [0.075, 0.796]]), 'body'));
    details.push(D('side', 'handle', closedP([[-0.860, 0.822], [-1.120, 0.824], [-1.130, 0.805], [-1.110, 0.792], [-0.870, 0.790], [-0.850, 0.806]]), 'body'));
    details.push(D('side', 'vent', closedP([[1.000, 0.630, C], [0.960, 0.640, C], [0.900, 0.480, C], [0.925, 0.462], [0.955, 0.520]]), 'black'));
    details.push(D('side', 'light', closedP([[1.680, 0.762, C], [1.900, 0.756], [2.100, 0.730], [2.230, 0.690, C], [2.215, 0.658], [2.080, 0.666], [1.900, 0.692], [1.720, 0.730]]), 'light'));
    details.push(D('side', 'light-amber', closedP([[2.215, 0.658, C], [2.080, 0.666], [2.000, 0.676, C], [2.040, 0.686], [2.180, 0.676]]), 'light-amber'));
    details.push(D('side', 'light', closedP([[-2.090, 0.968, C], [-1.900, 0.950], [-1.650, 0.882, C], [-1.900, 0.872], [-2.060, 0.858], [-2.120, 0.880]]), 'light-red'));
    // gloss-black blade wing: chord 0.24 m (x -1.94…-2.18), ~6° nose-down, on pedestal uprights from the hatch lid; ~0.12 m endplates
    // separate fills so overlapping sub-paths never cancel under nonzero winding
    // order: blade, thin endplate (straight lower edge, daylight below), then the pedestal upright standing on the hatch
    details.push(D('side', 'wing', closedP([[-1.940, 1.176, C], [-1.972, 1.196], [-2.060, 1.206], [-2.205, 1.212, C], [-2.205, 1.200, C], [-2.060, 1.180], [-1.975, 1.168]]), 'gloss-black')); // blade section
    details.push(D('side', 'wing', closedP([[-1.955, 1.200, C], [-1.985, 1.238], [-2.060, 1.250], [-2.195, 1.246, C], [-2.190, 1.160, C], [-1.960, 1.170, C]]), 'gloss-black')); // thin endplate
    details.push(D('side', 'wing', poly([[-1.975, 1.112], [-2.010, 1.106], [-2.020, 1.172], [-1.985, 1.176]]), 'gloss-black'));                         // pedestal upright
    details.push(D('side', 'antenna', closedP([[-1.200, 1.355, C], [-1.290, 1.392], [-1.340, 1.386], [-1.365, 1.336, C]]), 'body'));
    // top
    details.push(D('top', 'vent', rpoly([[1.760, -0.265], [1.760, 0.265], [1.640, 0.285], [1.640, -0.285]], 0.02), 'black'));   // wide shallow hood vent, 0.55 × 0.12 m
    details.push(D('top', 'wing', rrect(-2.180, -0.770, -1.940, 0.770, 0.02), 'gloss-black'));
    details.push(D('top', 'antenna', ell(-1.280, 0, 0.075, 0.025), 'body'));
    details.push(D('top', 'wiper', poly([[0.975, -0.660], [0.995, -0.660], [0.995, 0.040], [0.975, 0.040]]), 'black'));
    details.push(D('top', 'wiper', poly([[0.975, 0.080], [0.995, 0.080], [0.995, 0.680], [0.975, 0.680]]), 'black'));
    details = details.concat(Dpair('top', 'mirror', pairTop(mR), 'gloss-black'));
    // front
    details = details.concat(Dpair('front', 'mirror', pairFR([[0.880, 0.880], [0.970, 0.868], [1.050, 0.900], [1.055, 0.952], [1.010, 0.990], [0.920, 0.986], [0.884, 0.944]]), 'gloss-black'));
    details.push(D('front', 'trim', grilleBar, 'gloss-black'));
    details.push(D('front', 'grille', meshIn(gLowH, 0.05, [[-0.260, 0.300, 0.260, 0.410]]), 'grille'));
    details.push(D('front', 'wiper', poly([[-0.620, 0.958], [0.040, 0.974], [0.040, 0.984], [-0.620, 0.968]]), 'black'));
    details.push(D('front', 'wiper', poly([[0.080, 0.964], [0.640, 0.956], [0.640, 0.966], [0.080, 0.974]]), 'black'));
    details.push(D('front', 'vent', rpoly([[-0.240, 0.862], [0.240, 0.862], [0.275, 0.832], [-0.275, 0.832]], 0.008), 'black'));   // hood vent, 0.55 × 0.03
    details.push(D('front', 'hood', openP([[-0.700, 0.806], [-0.400, 0.795], [0, 0.792], [0.400, 0.795], [0.700, 0.806]]), 'line'));   // hood leading edge
    details.push(D('front', 'fender', openP([[0.700, 0.806], [0.770, 0.836], [0.860, 0.838], [0.925, 0.800]]), 'line'));              // fender tops proud of the hood
    details.push(D('front', 'fender', openP([[-0.700, 0.806], [-0.770, 0.836], [-0.860, 0.838], [-0.925, 0.800]]), 'line'));
    // rear
    details = details.concat(Dpair('rear', 'mirror', pairFR([[0.880, 0.880], [0.970, 0.868], [1.050, 0.900], [1.055, 0.952], [1.010, 0.990], [0.920, 0.986], [0.884, 0.944]]), 'gloss-black'));
    details = details.concat(Dpair('rear', 'vent', pairFR([[0.860, 0.560, C], [0.920, 0.600, C], [0.928, 0.420, C], [0.876, 0.400, C]]), 'black'));
    details = details.concat(Dpair('rear', 'reflector', pairFR([[0.780, 0.450, C], [0.880, 0.450, C], [0.880, 0.466, C], [0.780, 0.466, C]]), 'light-red'));
    details = details.concat(strakes([-0.54, -0.42, -0.30, 0.30, 0.42, 0.54], 0.200, 0.345, 0.012).map(function (p) { return D('rear', 'strake', p, 'gloss-black'); }));
    details.push(D('rear', 'light', rrect(-0.030, 0.310, 0.030, 0.345, 0.008), 'light-red'));
    details.push(D('rear', 'shutline', openP([[-0.620, 1.110], [-0.660, 0.960], [-0.620, 0.840], [-0.500, 0.800], [0, 0.794], [0.500, 0.800], [0.620, 0.840], [0.660, 0.960], [0.620, 1.110]]), 'black'));
    details.push(D('rear', 'badgeText', rrect(0.300, 0.872, 0.440, 0.880, 0.003), 'chrome'));    // "TYPE R"
    details.push(D('rear', 'badgeText', rrect(-0.440, 0.872, -0.300, 0.880, 0.003), 'chrome'));  // "CIVIC"

    var model = {
      id: 'honda-civic-type-r-fl5', make: 'Honda', name: 'Civic Type R', gen: 'FL5', years: '2022–', style: 'hatchback',
      look: { head: 'slim-led', tail: 'slim', grille: 'honeycomb' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'fwd', powertrain: 'ice', doors: 5,
      ref: ref,
      side: {
        body: sideBody, greenhouse: greenhouse, windows: [winFront, winRear, winQtr], pillars: [{ path: pillarA, paint: 'body' }, { path: pillarB, paint: 'gloss-black' }, { path: divider, paint: 'gloss-black' }, { path: pillarC, paint: 'gloss-black' }],
        doorCuts: doorCuts, panelLines: panelLines, characterLines: characterLines, sill: { path: sill, paint: 'black' },
        archF: { x: A, y: tr, r: ar, flare: 0.030, shape: 'round' }, archR: { x: -A, y: tr, r: ar, flare: 0.030, shape: 'round' },
        lowerTrim: lowerTrim
      },
      top: { body: topBody, greenhouse: topGreen, hood: topHood, roof: topRoof, deck: topDeck, mirrors: topMirrors },
      front: {
        body: frontBody, greenhouse: frontGreen, bumper: frontBumper, grille: [grilleUpper, grilleLower], intakes: intakes,
        headlights: headlights, drl: drl, splitter: splitter,
        plateArea: rrect(-0.260, 0.300, 0.260, 0.410, 0.01), badgeArea: ell(0, 0.681, 0.060, 0.026),
        badgeText: 'HONDA'
      },
      rear: {
        body: rearBody, greenhouse: rearGreen, bumper: rearBumper, taillights: taillights, diffuser: diffuser, exhaust: exhaust,
        plateArea: rrect(-0.260, 0.760, 0.260, 0.865, 0.01), badgeArea: ell(0, 0.975, 0.060, 0.030),
        badgeText: 'HONDA',
        spoiler: { path: wingRear, paint: 'gloss-black' }
      },
      details: details,
      signature: {
        headlights: 'Thin horizontal full-LED units with a single DRL line along the lower edge, linked by a gloss-black bar across the nose',
        taillights: 'Slim wrap-around C-shaped LED clusters spanning tailgate and quarters',
        grille: 'Honeycomb slot beneath the black bar plus a huge sharp-cornered trapezoidal honeycomb lower intake framing the plate, vertical corner brake ducts, black splitter',
        notes: 'Long low straight fastback, wide shallow hood vent, front fender extractor vents, flared arches with raised lips, gloss-black blade wing on two pedestal uprights on the hatch lid, straked diffuser with triple centre exhaust (two large, one small)'
      }
    };
    model.sections = buildSections(model, {
      waistY: 0.86,
      hatch: { xs: [-2.023], x0: -2.03, x1: -1.38, y0: 1.095, y1: 1.33, z0: 0.58, z1: 0.50 },
      fenderRise: { z0: 0.78, z1: 0.90, d: 0.025, dx: 0.45 }
    });
    return model;
  }

  /* ================================================================== TOYOTA GR YARIS */
  function grYaris() {
    var ref = {
      length: 3.995, width: 1.805, height: 1.455, wheelbase: 2.560, trackF: 1.535, trackR: 1.565,
      frontOverhang: 0.835, rearOverhang: 0.600, wheelDiameter_in: 18, tireF: '225/40R18', tireR: '225/40R18',
      groundClearance: 0.124, rideHeight: 0.124, cd: 0.33, curbWeight_kg: 1280
    };
    var A = ref.wheelbase / 2, XF = A + ref.frontOverhang, XR = -A - ref.rearOverhang, H = ref.height, W2 = ref.width / 2;
    var tr = tireRadius(ref.tireF, ref.wheelDiameter_in), ar = tr + 0.044, GC = ref.groundClearance;

    /* ---------- side ----------
       Blunt nose, long swept headlight on the fender top, windshield base far forward, roof falling strongly behind
       the B-pillar (1.455 → 1.40 → 1.31) to a floating gloss-black roof spoiler, small wedge quarter glass tapering to a
       point inside a massive body-colour C-pillar, wide rear blister fender, near-vertical tail face, black skirt. */
    var sideBody = closedP([
      [2.060, 0.232, C], [2.104, 0.285], [XF, 0.390], [2.106, 0.560], [2.086, 0.690], [2.046, 0.762], [1.960, 0.800],
      [1.700, 0.846], [1.400, 0.898], [1.150, 0.962], [0.980, 1.030, C],
      [0.700, 1.200], [0.420, 1.360], [0.150, 1.440], [-0.150, H], [-0.550, 1.425], [-0.900, 1.385], [-1.250, 1.335], [-1.500, 1.305],
      [-1.550, 1.298, C], [-1.570, 1.275, C],
      [-1.640, 1.160], [-1.730, 1.040], [-1.810, 0.985], [-1.855, 0.920], [-1.876, 0.850], [XR, 0.600],
      [-1.878, 0.350], [-1.860, 0.290], [-1.810, 0.236, C], [-1.450, 0.200], [-1.000, 0.150], [-0.850, GC, C],
      [0.850, GC, C], [1.100, 0.160], [1.700, 0.200]
    ]);
    var greenhouse = closedP([
      [0.980, 1.030, C], [0.700, 1.200], [0.420, 1.350], [0.150, 1.424], [-0.150, 1.436], [-0.400, 1.422], [-0.560, 1.346],
      [-0.790, 1.268], [-0.990, 1.140, C], [-0.800, 1.050], [-0.560, 1.022], [0.000, 1.016], [0.500, 1.006]
    ]);
    var winDoor = closedP([[0.875, 1.012, C], [0.650, 1.180], [0.420, 1.326], [0.150, 1.400], [-0.150, 1.414], [-0.385, 1.408, C], [-0.385, 1.032, C], [0.300, 1.016]]);
    var winQtr = closedP([[-0.560, 1.330, C], [-0.780, 1.256], [-0.960, 1.170], [-0.980, 1.140, C], [-0.960, 1.108], [-0.780, 1.056], [-0.560, 1.030, C]]);
    var pillarA = closedP([[0.980, 1.030, C], [0.700, 1.200], [0.420, 1.350], [0.150, 1.424], [0.020, 1.432, C], [0.020, 1.408], [0.150, 1.400], [0.420, 1.326], [0.650, 1.180], [0.875, 1.012, C]]);
    var pillarB = poly([[-0.385, 1.030], [-0.385, 1.414], [-0.560, 1.342], [-0.560, 1.028]]);
    var doorCuts = [
      openP([[0.872, 1.006], [0.862, 0.800], [0.852, 0.440], [0.826, 0.330], [0.760, 0.292, C]]).concat([{ t: 'L', p: [pt(-0.170, 0.292)] }]),
      openP([[-0.170, 0.292], [-0.250, 0.330], [-0.320, 0.440], [-0.390, 0.680], [-0.440, 0.880], [-0.468, 1.034]])
    ];
    var panelLines = [
      openP([[1.960, 0.786], [1.700, 0.830], [1.400, 0.882], [1.150, 0.946], [0.992, 1.012]]),
      openP([[-1.575, 1.272], [-1.640, 1.150], [-1.730, 1.030], [-1.800, 0.980]])
    ];
    var characterLines = [
      openP([[1.880, 0.784], [1.400, 0.842], [0.900, 0.880], [0.300, 0.904], [-0.360, 0.925]]),
      openP([[-0.190, 0.360], [-0.360, 0.520], [-0.600, 0.740], [-0.900, 0.895], [-1.200, 0.958], [-1.420, 0.972]]),
      openP([[1.780, 0.600], [1.640, 0.705], [1.400, 0.750], [1.100, 0.722], [0.930, 0.640]]),
      openP([[0.760, 0.355], [0.300, 0.360], [-0.120, 0.368]])
    ];
    var sill = closedP([[0.900, 0.190, C], [-0.900, 0.190, C], [-0.918, 0.160], [-0.890, 0.130, C], [0.890, 0.130, C], [0.918, 0.160]]);
    var lowerTrim = join(
      closedP([[2.060, 0.232, C], [2.100, 0.278], [1.980, 0.262], [1.800, 0.240, C], [1.700, 0.200, C]]),
      closedP([[-1.810, 0.236, C], [-1.860, 0.290], [-1.840, 0.330], [-1.650, 0.300], [-1.500, 0.250, C], [-1.450, 0.200, C]])
    );

    /* ---------- top ---------- door waist ±0.84, hips ±0.9025 over the rear axle */
    var topBody = symTop([[XF, 0], [2.100, 0.300], [2.060, 0.520], [1.990, 0.680], [1.880, 0.790], [1.700, 0.860], [1.400, 0.885], [1.150, 0.882], [0.950, 0.870],
      [0.700, 0.856], [0.200, 0.856], [-0.350, 0.861], [-0.700, 0.872], [-1.000, 0.894], [-1.280, W2], [-1.480, 0.895], [-1.620, 0.868], [-1.712, 0.800], [-1.780, 0.705], [XR + 0.100, 0.600], [XR + 0.045, 0.480], [XR + 0.012, 0.300], [XR, 0]]);
    var topGreen = symTop([[0.985, 0], [0.965, 0.430], [0.900, 0.600], [0.700, 0.650], [0.000, 0.650], [-0.600, 0.630], [-1.100, 0.590], [-1.500, 0.540], [-1.690, 0.515], [-1.733, 0.400], [-1.740, 0]]);
    var topHood = symTop([[1.960, 0], [1.940, 0.450], [1.860, 0.690], [1.600, 0.752], [1.250, 0.740], [1.000, 0.700], [0.995, 0]]);
    var topRoof = symTop([[0.230, 0], [0.215, 0.480], [0.130, 0.580], [-0.500, 0.590], [-1.200, 0.520], [-1.500, 0.470], [-1.515, 0.360], [-1.520, 0]]);
    var topDeck = symTop([[-1.520, 0], [-1.515, 0.360], [-1.500, 0.470], [-1.660, 0.560], [-1.780, 0.500], [-1.820, 0.360], [-1.828, 0]]);
    var mR = [[0.760, 0.840], [0.782, 0.900], [0.765, 0.968], [0.705, 1.002], [0.620, 0.990], [0.636, 0.915], [0.660, 0.844]];
    var topMirrors = pairTop(mR);   // one path per side

    /* ---------- front ---------- */
    var frontBody = symFR([[0, H], [0.340, 1.448], [0.500, 1.425], [0.565, 1.370], [0.615, 1.200], [0.650, 1.040, C],
      [0.760, 1.010], [0.830, 0.980], [0.870, 0.900], [0.895, 0.780], [W2, 0.700], [0.895, 0.560], [0.872, 0.400], [0.850, 0.240], [0.700, 0.180], [0, 0.172]]);
    var frontGreen = symFR([[0, 1.410], [0.380, 1.402], [0.500, 1.384], [0.555, 1.326], [0.605, 1.120], [0.638, 1.048, C], [0.560, 1.036], [0, 1.030]]);
    var frontBumper = symFR([[0, 0.650], [0.400, 0.652], [0.700, 0.690], [0.860, 0.742], [0.880, 0.640], [0.890, 0.560], [0.868, 0.400], [0.850, 0.240], [0.700, 0.180], [0, 0.172]]);
    var hlR = [[0.420, 0.660, C], [0.560, 0.708], [0.720, 0.752], [0.850, 0.786], [0.874, 0.762], [0.860, 0.720], [0.760, 0.690], [0.560, 0.664], [0.460, 0.648, C]];
    var headlights = pairFR(hlR);
    var drlR = [[0.560, 0.700], [0.720, 0.742], [0.842, 0.772], [0.846, 0.762], [0.722, 0.732], [0.565, 0.692]];
    var drl = pairFR(drlR);
    // G-Matrix grille: straight-sided trapezoid, 0.86 m at the top (y 0.605, just under the lamp inner ends), 1.25 m at the bottom (y 0.23)
    var gH = [[0, 0.605], [0.430, 0.605], [0.625, 0.230], [0, 0.230]];
    var grille = rpoly([[-0.430, 0.605], [0.430, 0.605], [0.625, 0.230], [-0.625, 0.230]], 0.03);
    var intakes = rpolyPair([[0.660, 0.560], [0.835, 0.610], [0.860, 0.262], [0.715, 0.250]], 0.03);
    var fog = [rrect(0.730, 0.300, 0.825, 0.330, 0.012), rrect(-0.825, 0.300, -0.730, 0.330, 0.012)];
    var splitter = symFR([[0, 0.204], [0.600, 0.208], [0.800, 0.226], [0.830, 0.206], [0.780, 0.184], [0.600, 0.176], [0, 0.174]]);

    /* ---------- rear ---------- roof ±0.47, glass base ±0.60, shoulder shelf ±0.78 at y≈1.00, haunches peak ±0.9025 at y≈0.79
       and tuck under ~0.07 m to the bumper bottom */
    var rearBody = symFR([[0, H], [0.330, 1.448], [0.440, 1.430], [0.480, 1.400], [0.535, 1.230], [0.600, 1.020, C],
      [0.700, 1.012], [0.780, 1.000], [0.835, 0.975], [0.880, 0.900], [W2, 0.790], [0.898, 0.680], [0.884, 0.520], [0.860, 0.380], [0.830, 0.250], [0.700, 0.215], [0, 0.212]]);
    var rearGreen = symFR([[0, 1.296], [0.380, 1.290], [0.450, 1.262], [0.515, 1.140], [0.560, 1.072, C], [0.490, 1.064], [0, 1.060]]);
    var spoiler = uniWind(join(
      symFR([[0, 1.350], [0.420, 1.350], [0.520, 1.342], [0.548, 1.305], [0.500, 1.296], [0, 1.296]]),
      pairFR([[0.520, 1.342, C], [0.548, 1.305, C], [0.560, 1.240, C], [0.540, 1.260, C]])[0],
      pairFR([[0.520, 1.342, C], [0.548, 1.305, C], [0.560, 1.240, C], [0.540, 1.260, C]])[1]
    ));
    var rearBumper = symFR([[0, 0.640], [0.500, 0.642], [0.760, 0.646], [0.896, 0.640, C], [0.890, 0.580], [0.884, 0.520], [0.860, 0.380], [0.830, 0.250], [0.700, 0.215], [0, 0.212]]);
    var tlR = [[0.480, 0.958, C], [0.640, 0.980], [0.780, 0.984], [0.828, 0.964], [0.866, 0.902], [0.846, 0.884], [0.700, 0.902], [0.560, 0.920], [0.490, 0.932, C]];
    var taillights = pairFR(tlR);
    var tlSig = pairFR([[0.540, 0.950, C], [0.830, 0.962, C], [0.830, 0.952, C], [0.548, 0.940, C]]);
    var diffuser = symFR([[0, 0.350], [0.480, 0.350], [0.720, 0.330], [0.790, 0.282], [0.770, 0.232], [0.600, 0.216], [0, 0.214]]);
    var exhaust = [{ shape: 'round', cx: 0.555, cy: 0.282, w: 0.094, h: 0.094 }, { shape: 'round', cx: -0.555, cy: 0.282, w: 0.094, h: 0.094 }];

    var details = [];
    details.push(D('side', 'mirror', closedP([[0.800, 1.040], [0.760, 1.110], [0.660, 1.140], [0.560, 1.122], [0.540, 1.062], [0.600, 1.022], [0.720, 1.006]]), 'body'));
    details.push(D('side', 'handle', closedP([[-0.140, 0.895], [-0.355, 0.898], [-0.368, 0.879], [-0.348, 0.864], [-0.150, 0.862], [-0.128, 0.879]]), 'body'));
    details.push(D('side', 'light', closedP([[1.420, 0.890, C], [1.700, 0.852], [1.900, 0.808], [1.990, 0.782, C], [1.996, 0.748], [1.900, 0.738], [1.700, 0.782], [1.460, 0.862]]), 'light'));
    details.push(D('side', 'light', closedP([[-1.815, 1.000, C], [-1.600, 0.992], [-1.400, 0.977], [-1.240, 0.962, C], [-1.400, 0.922], [-1.600, 0.872], [-1.770, 0.846], [-1.852, 0.852]]), 'light-red'));
    // hatch glass seen edge-on: a thin ~0.06 m band along the hatch edge
    details.push(D('side', 'trim', closedP([[-1.578, 1.276, C], [-1.640, 1.160], [-1.730, 1.040], [-1.800, 0.990, C], [-1.752, 0.996], [-1.680, 1.058], [-1.596, 1.168], [-1.540, 1.282, C]]), 'gloss-black'));
    // floating gloss-black roof spoiler blade
    details.push(D('side', 'spoiler', closedP([[-1.420, 1.324, C], [-1.520, 1.316], [-1.615, 1.296, C], [-1.620, 1.279, C], [-1.530, 1.293], [-1.425, 1.307, C]]), 'gloss-black'));
    details.push(D('side', 'vent', closedP([[1.885, 0.620, C], [1.805, 0.600, C], [1.795, 0.300, C], [1.865, 0.272, C]]), 'black'));
    details.push(D('side', 'grille', closedP([[2.100, 0.540, C], [2.066, 0.530, C], [2.066, 0.290, C], [2.104, 0.296, C]]), 'grille'));
    details.push(D('side', 'antenna', closedP([[-0.930, 1.382, C], [-1.010, 1.420], [-1.060, 1.414], [-1.090, 1.360, C]]), 'carbon'));
    details.push(D('side', 'badge', rrect(0.880, 0.810, 0.960, 0.830, 0.005), 'chrome'));
    details.push(D('side', 'roof', closedP([[0.150, 1.440, C], [-0.150, H], [-0.550, 1.425], [-0.900, 1.385], [-1.250, 1.335], [-1.400, 1.317, C], [-1.400, 1.301, C], [-1.250, 1.319], [-0.900, 1.369], [-0.550, 1.409], [-0.150, 1.439], [0.150, 1.425, C]]), 'carbon'));
    // top
    details.push(D('top', 'roof', topRoof, 'carbon'));
    details.push(D('top', 'wiper', poly([[1.000, -0.620], [1.020, -0.620], [1.020, 0.040], [1.000, 0.040]]), 'black'));
    details.push(D('top', 'wiper', poly([[1.000, 0.080], [1.020, 0.080], [1.020, 0.640], [1.000, 0.640]]), 'black'));
    details.push(D('top', 'spoiler', rrect(-1.620, -0.540, -1.430, 0.540, 0.02), 'gloss-black'));
    // front
    details = details.concat(Dpair('front', 'mirror', pairFR([[0.830, 1.010], [0.920, 0.998], [1.000, 1.028], [1.006, 1.080], [0.960, 1.110], [0.870, 1.106], [0.834, 1.070]]), 'body'));
    details.push(D('front', 'grille', meshIn(gH, 0.05, [[-0.260, 0.330, 0.260, 0.440]]), 'grille'));
    details.push(D('front', 'roof', symFR([[0, H], [0.340, 1.448], [0.500, 1.425, C], [0.480, 1.404, C], [0, 1.408]]), 'carbon'));
    details.push(D('front', 'wiper', poly([[-0.580, 1.040], [0.040, 1.056], [0.040, 1.066], [-0.580, 1.050]]), 'black'));
    details.push(D('front', 'wiper', poly([[0.080, 1.048], [0.600, 1.040], [0.600, 1.050], [0.080, 1.058]]), 'black'));
    // rear
    details = details.concat(Dpair('rear', 'mirror', pairFR([[0.830, 1.010], [0.920, 0.998], [1.000, 1.028], [1.006, 1.080], [0.960, 1.110], [0.870, 1.106], [0.834, 1.070]]), 'body'));
    details = details.concat(Dpair('rear', 'light', tlSig, 'light'));
    details.push(D('rear', 'roof', symFR([[0, H], [0.330, 1.448], [0.440, 1.430, C], [0.420, 1.352, C], [0, 1.352]]), 'carbon'));
    details.push(D('rear', 'wiper', poly([[0.010, 1.080], [0.380, 1.136], [0.378, 1.146], [0.006, 1.090]]), 'black'));
    details = details.concat(Dpair('rear', 'reflector', pairFR([[0.800, 0.300, C], [0.818, 0.300, C], [0.830, 0.420, C], [0.812, 0.420, C]]), 'light-red'));
    details = details.concat(strakes([-0.38, -0.25, -0.12, 0.12, 0.25, 0.38], 0.222, 0.335, 0.012).map(function (p) { return D('rear', 'strake', p, 'gloss-black'); }));
    details.push(D('rear', 'light', rrect(-0.030, 0.240, 0.030, 0.290, 0.008), 'light-red'));
    details.push(D('rear', 'shutline', openP([[-0.570, 1.040], [-0.620, 0.920], [-0.600, 0.720], [-0.480, 0.680], [0, 0.674], [0.480, 0.680], [0.600, 0.720], [0.620, 0.920], [0.570, 1.040]]), 'black'));
    details.push(D('rear', 'badgeText', rrect(0.330, 0.808, 0.480, 0.816, 0.003), 'chrome'));    // "GR-FOUR"
    details.push(D('rear', 'badgeText', rrect(-0.430, 0.808, -0.330, 0.816, 0.003), 'chrome'));  // "GR"

    var model = {
      id: 'toyota-gr-yaris', make: 'Toyota', name: 'GR Yaris', gen: 'GXPA16', years: '2020–', style: 'hatchback',
      look: { head: 'slim-led', tail: 'slim', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice', doors: 3,
      ref: ref,
      side: {
        body: sideBody, greenhouse: greenhouse, windows: [winDoor, winQtr], pillars: [{ path: pillarA, paint: 'body' }, { path: pillarB, paint: 'gloss-black' }],
        doorCuts: doorCuts, panelLines: panelLines, characterLines: characterLines, sill: { path: sill, paint: 'black' },
        archF: { x: A, y: tr, r: ar, flare: 0.030, shape: 'round' }, archR: { x: -A, y: tr, r: ar, flare: 0.045, shape: 'round' },
        lowerTrim: lowerTrim
      },
      top: { body: topBody, greenhouse: topGreen, hood: topHood, roof: topRoof, deck: topDeck, mirrors: topMirrors },
      front: {
        body: frontBody, greenhouse: frontGreen, bumper: frontBumper, grille: [grille], intakes: intakes,
        headlights: headlights, drl: drl, fogLights: fog, splitter: splitter,
        plateArea: rrect(-0.260, 0.330, 0.260, 0.440, 0.01), badgeArea: ell(0, 0.630, 0.050, 0.024),
        badgeText: 'GR'
      },
      rear: {
        body: rearBody, greenhouse: rearGreen, bumper: rearBumper, taillights: taillights, diffuser: diffuser, exhaust: exhaust,
        plateArea: rrect(-0.260, 0.682, 0.260, 0.792, 0.01), badgeArea: ell(0, 0.905, 0.055, 0.036), spoiler: { path: spoiler, paint: 'gloss-black' },
        badgeText: 'TOYOTA'
      },
      details: details,
      signature: {
        headlights: 'Narrow swept-back LED units rising toward the fenders with a thin LED line along the upper edge',
        taillights: 'Slim wide horizontal LED clusters wrapping around the blistered rear fenders, single horizontal light bar each side',
        grille: 'Large straight-sided trapezoid "G-Matrix" mesh grille dominating the bumper, sharp-cornered corner intakes with fog lamps',
        notes: 'Three-door body with roofline dropped ~90 mm at the rear, forged-carbon roof, frameless doors, small wedge rear quarter window in a massive body-colour C-pillar, floating roof spoiler, wide rear hips with a shoulder shelf, twin round exhausts either side of a straked diffuser'
      }
    };
    // the 3D cabin continues past the quarter glass to the hatch (body-colour C-pillar, glass only where windows are)
    model.sections = buildSections(model, {
      xWS: 0.98, xBL: -1.80,
      waistY: 0.79,
      hatch: { xs: [-1.74, -1.72, -1.70, -1.68, -1.66, -1.64, -1.62, -1.60, -1.58, -1.56, -1.55], x0: -1.745, x1: -1.545, y0: 1.06, y1: 1.29, z0: 0.57, z1: 0.45, zMax: 0.595 },
      belt: [[-1.80, 0.995], [-1.70, 1.000], [-1.40, 1.025], [-1.00, 1.045], [-0.56, 1.025], [0.00, 1.016], [0.50, 1.006], [0.98, 1.030]]
    });
    return model;
  }

  var models = [golfGTI(), civicTypeR(), grYaris()];
  models.forEach(register);
  if (typeof module !== 'undefined' && module.exports) module.exports = models;
})();

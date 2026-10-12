/* FORGE Atelier — real-car shape library: body style 'pickup'.
   Models: Ford F-150 Raptor (3rd gen, P702, SuperCrew 5.5 ft box, 35" tires),
           Toyota Tacoma TRD Pro (4th gen, 2024, Double Cab 5 ft bed, i-FORCE MAX),
           Tesla Cybertruck (2024, AWD, 20" all-terrain).
   Coordinates in metres at the real vehicle's published dimensions.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top = (x, z); front & rear = (z, y).
   Brand names are text only; no manufacturer logo artwork is drawn (badgeArea marks the spot).
   Sources: Ford 2024 Raptor/Raptor R tech-spec sheet (media.ford.com), Toyota 2024 Tacoma
   TRD Pro spec sheet (via tacoma4g / Toyota pressroom figures), Tesla Cybertruck owner's manual
   dimensions page. Cd / curb weight marked as estimates where the maker publishes none. */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ path helpers */
  var D2R = Math.PI / 180;
  function rd(v) { return Math.round(v * 100000) / 100000; }
  function pt(a, b) { return [rd(a), rd(b)]; }

  /* Circular arc (centre cx,cy radius r, from angle a0 to a1 in radians) as cubic segments. */
  function arcSegs(cx, cy, r, a0, a1) {
    var n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9)), da = (a1 - a0) / n, segs = [];
    var k = (4 / 3) * Math.tan(da / 4);
    for (var i = 0; i < n; i++) {
      var t0 = a0 + da * i, t1 = t0 + da;
      var x0 = cx + r * Math.cos(t0), y0 = cy + r * Math.sin(t0), x1 = cx + r * Math.cos(t1), y1 = cy + r * Math.sin(t1);
      segs.push({ t: 'C', p: [pt(x0 - k * r * Math.sin(t0), y0 + k * r * Math.cos(t0)),
        pt(x1 + k * r * Math.sin(t1), y1 - k * r * Math.cos(t1)), pt(x1, y1)] });
    }
    return segs;
  }

  /* Rounded polyline / polygon. items: [a, b, r] (r = fillet radius; 0 = crisp corner; a huge r
     turns the vertex into a smooth spline-like blend) or {arc:[cx, cy, R, deg0, deg1]} which
     inserts a true circular arc (its end vertices are crisp). Fillets are exact circular arcs
     approximated by cubics, so straight panels stay dead straight and every blend is G1. */
  function rp(items, closed) {
    var V = [];
    items.forEach(function (it) {
      if (Array.isArray(it)) V.push({ p: [it[0], it[1]], r: it[2] || 0 });
      else if (it && it.arc) {
        var a = it.arc, a0 = a[3] * D2R, a1 = a[4] * D2R;
        V.push({ p: [a[0] + a[2] * Math.cos(a0), a[1] + a[2] * Math.sin(a0)], r: 0, arc: arcSegs(a[0], a[1], a[2], a0, a1) });
        V.push({ p: [a[0] + a[2] * Math.cos(a1), a[1] + a[2] * Math.sin(a1)], r: 0, arcEnd: true });
      }
    });
    var n = V.length;
    function at(i) { return closed ? V[(i + n) % n] : V[i]; }
    // fillets
    for (var i = 0; i < n; i++) {
      var v = V[i]; v.A = v.B = v.p; v.C = null;
      if (!v.r || v.arc || v.arcEnd) continue;
      if (!closed && (i === 0 || i === n - 1)) continue;
      var pv = at(i - 1), nx = at(i + 1);
      if (pv.arc || (nx && nx.arcEnd)) { /* neighbour edge is an arc: keep crisp */ }
      var dxi = v.p[0] - pv.p[0], dyi = v.p[1] - pv.p[1], li = Math.hypot(dxi, dyi);
      var dxo = nx.p[0] - v.p[0], dyo = nx.p[1] - v.p[1], lo = Math.hypot(dxo, dyo);
      if (li < 1e-9 || lo < 1e-9) continue;
      var din = [dxi / li, dyi / li], dout = [dxo / lo, dyo / lo];
      var cs = Math.max(-1, Math.min(1, din[0] * dout[0] + din[1] * dout[1])), phi = Math.acos(cs);
      if (phi < 1e-4 || phi > Math.PI - 1e-3) continue;
      var d = v.r * Math.tan(phi / 2);
      var limI = li * ((pv.r && !pv.arc && !pv.arcEnd) ? 0.5 : 0.98), limO = lo * ((nx.r && !nx.arc && !nx.arcEnd) ? 0.5 : 0.98);
      if (pv.arc) limI = li * 0.98;
      d = Math.min(d, limI, limO);
      var h = d * (4 / 3) * Math.tan(phi / 4) / Math.tan(phi / 2);
      v.A = [v.p[0] - din[0] * d, v.p[1] - din[1] * d];
      v.B = [v.p[0] + dout[0] * d, v.p[1] + dout[1] * d];
      v.C = { t: 'C', p: [pt(v.A[0] + din[0] * h, v.A[1] + din[1] * h), pt(v.B[0] - dout[0] * h, v.B[1] - dout[1] * h), pt(v.B[0], v.B[1])] };
    }
    var segs = [], cur = null;
    function lineTo(q) { if (!cur || Math.hypot(q[0] - cur[0], q[1] - cur[1]) > 1e-7) segs.push({ t: 'L', p: [pt(q[0], q[1])] }); cur = q; }
    function visit(i) {
      var prev = at(i - 1), v = at(i);
      if (prev.arc) { segs.push.apply(segs, prev.arc); cur = v.p; }
      else lineTo(v.A);
      if (v.C) { segs.push(v.C); cur = v.B; }
    }
    if (closed) {
      var s0 = V[0].B; segs.push({ t: 'M', p: [pt(s0[0], s0[1])] }); cur = s0;
      for (var j = 1; j < n; j++) visit(j);
      // closing edge back to vertex 0
      var last = V[n - 1], v0 = V[0];
      if (last.arc) { segs.push.apply(segs, last.arc); cur = v0.p; } else lineTo(v0.A);
      if (v0.C) segs.push(v0.C);
      segs.push({ t: 'Z', p: [] });
    } else {
      segs.push({ t: 'M', p: [pt(V[0].p[0], V[0].p[1])] }); cur = V[0].p;
      for (var k = 1; k < n; k++) visit(k);
    }
    return segs;
  }
  function closedP(items) { return rp(items, true); }
  function lineP(items) { return rp(items, false); }
  function rect(x0, y0, x1, y1, r) { r = r || 0; return closedP([[x0, y0, r], [x1, y0, r], [x1, y1, r], [x0, y1, r]]); }
  function ellipse(cx, cy, rx, ry) {
    var k = 0.5522847498, s = [{ t: 'M', p: [pt(cx + rx, cy)] }];
    s.push({ t: 'C', p: [pt(cx + rx, cy + k * ry), pt(cx + k * rx, cy + ry), pt(cx, cy + ry)] });
    s.push({ t: 'C', p: [pt(cx - k * rx, cy + ry), pt(cx - rx, cy + k * ry), pt(cx - rx, cy)] });
    s.push({ t: 'C', p: [pt(cx - rx, cy - k * ry), pt(cx - k * rx, cy - ry), pt(cx, cy - ry)] });
    s.push({ t: 'C', p: [pt(cx + k * rx, cy - ry), pt(cx + rx, cy - k * ry), pt(cx + rx, cy)] });
    s.push({ t: 'Z', p: [] });
    return s;
  }
  /* Mirror-symmetric closed outline from a half running centreline → +side → centreline.
     ax = 0 for front/rear (z, y), ax = 1 for top (x, z). */
  function sym(half, ax) {
    var back = half.slice(1, -1).reverse().map(function (p) { var q = p.slice(); q[ax] = -q[ax]; return q; });
    return closedP(half.concat(back));
  }
  function mirror(path, ax) {
    return path.map(function (s) { return { t: s.t, p: s.p.map(function (q) { var o = q.slice(); o[ax] = rd(-o[ax]); return o; }) }; });
  }
  function pair(path, ax) { return [path, mirror(path, ax || 0)]; }       // [right, left] for front/rear
  function split2(path, ax) { return [path, mirror(path, ax || 0)]; }   // two separate paths (one item per side)
  function both(path, ax) { return path.concat(mirror(path, ax || 0)); } // one path, both sides as subpaths
  function cat() { var o = []; for (var i = 0; i < arguments.length; i++) o = o.concat(arguments[i]); return o; }
  /* Make every closed subpath counter-clockwise so overlapping trim pieces (flare over bumper end)
     add up under the nonzero fill rule instead of cancelling into a body-coloured sliver. */
  function ccw(path) {
    var subs = [], out = [];
    path.forEach(function (sg) { if (sg.t === 'M') subs.push([]); subs[subs.length - 1].push(sg); });
    subs.forEach(function (sp) {
      var ends = [], area = 0;
      sp.forEach(function (sg) { if (sg.p.length) ends.push(sg.p[sg.p.length - 1]); });
      for (var i = 0; i < ends.length; i++) { var a = ends[i], b = ends[(i + 1) % ends.length]; area += a[0] * b[1] - b[0] * a[1]; }
      if (area >= 0) { out = out.concat(sp); return; }
      var segs = sp.filter(function (sg) { return sg.t === 'L' || sg.t === 'C' || sg.t === 'Q'; });
      var start = sp[0].p[0], lastEnd = segs.length ? segs[segs.length - 1].p[segs[segs.length - 1].p.length - 1] : start;
      var closing = Math.hypot(lastEnd[0] - start[0], lastEnd[1] - start[1]) > 1e-7;
      var r = [{ t: 'M', p: [start] }];
      if (closing) r.push({ t: 'L', p: [lastEnd] });
      for (var j = segs.length - 1; j >= 0; j--) {
        var sg = segs[j], prev = j > 0 ? segs[j - 1].p[segs[j - 1].p.length - 1] : start;
        if (sg.t === 'C') r.push({ t: 'C', p: [sg.p[1], sg.p[0], prev] });
        else if (sg.t === 'Q') r.push({ t: 'Q', p: [sg.p[0], prev] });
        else r.push({ t: 'L', p: [prev] });
      }
      r.push({ t: 'Z', p: [] });
      out = out.concat(r);
    });
    return out;
  }

  /* Wheel-arch helpers (side view). Arc arch: angle where a radius-r circle meets a horizontal
     body edge at height yEdge. */
  function edgeAngle(cy, r, yEdge) { return Math.asin(Math.max(-0.99, Math.min(0.99, (yEdge - cy) / r))) / D2R; }
  function arcArch(cx, cy, r, yEdgeRear, yEdgeFront) {
    return { arc: [cx, cy, r, 180 - edgeAngle(cy, r, yEdgeRear), edgeAngle(cy, r, yEdgeFront)] };
  }
  /* Flare band around a round arch between radii r and r + w (closed path). */
  function arcFlare(cx, cy, r, w, yEdgeRear, yEdgeFront) {
    var ro = r + w;
    var o0 = 180 - edgeAngle(cy, ro, yEdgeRear), o1 = edgeAngle(cy, ro, yEdgeFront);
    var i0 = 180 - edgeAngle(cy, r, yEdgeRear), i1 = edgeAngle(cy, r, yEdgeFront);
    var s = [{ t: 'M', p: [pt(cx + ro * Math.cos(o0 * D2R), cy + ro * Math.sin(o0 * D2R))] }];
    s = s.concat(arcSegs(cx, cy, ro, o0 * D2R, o1 * D2R));
    s.push({ t: 'L', p: [pt(cx + r * Math.cos(i1 * D2R), cy + r * Math.sin(i1 * D2R))] });
    s = s.concat(arcSegs(cx, cy, r, i1 * D2R, i0 * D2R));
    s.push({ t: 'Z', p: [] });
    return s;
  }
  /* Polygonal ("squared") arch vertex list, rear edge → over the top → front edge.
     prof: [[dx, dy, rad], ...] for the rear half relative to the centre (dx < 0), mirrored to the front. */
  function polyArch(cx, cy, prof) {
    var rear = prof.map(function (q) { return [cx + q[0], cy + q[1], q[2] || 0]; });
    var front = prof.slice().reverse().map(function (q) { return [cx - q[0], cy + q[1], q[2] || 0]; });
    return rear.concat(front);
  }
  function polyFlare(cx, cy, profIn, profOut) {
    var outer = polyArch(cx, cy, profOut), inner = polyArch(cx, cy, profIn).reverse();
    return closedP(outer.concat(inner));
  }


  /* Block-letter stencil (plain text glyphs on a 3 x 5 grid, no logo artwork) for decals that a
     view has no badgeArea for. x0,y0 = lower-left corner, h = cap height, ws = width stretch. */
  var GLYPH = {
    A: [[0, 0, 1, 4.2], [2, 0, 3, 4.2], [0.4, 4, 2.6, 5], [1, 2, 2, 3]],
    C: [[0, 0.6, 1, 4.4], [0.5, 4, 3, 5], [0.5, 0, 3, 1]],
    D: [[0, 0, 1, 5], [1, 4, 2.2, 5], [1, 0, 2.2, 1], [2, 0.7, 3, 4.3]],
    F: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.4, 3]],
    M: [[0, 0, 0.8, 5], [2.2, 0, 3, 5], [0.8, 4, 2.2, 5], [1.1, 2.2, 1.9, 4]],
    O: [[0, 0.6, 1, 4.4], [2, 0.6, 3, 4.4], [0.5, 4, 2.5, 5], [0.5, 0, 2.5, 1]],
    P: [[0, 0, 1, 5], [1, 4, 2.4, 5], [2, 2.6, 3, 4.4], [1, 2, 2.4, 3]],
    R: [[0, 0, 1, 5], [1, 4, 2.4, 5], [2, 2.6, 3, 4.4], [1, 2, 2.4, 3], [1.9, 0, 3, 2]],
    T: [[0, 4, 3, 5], [1, 0, 2, 4]]
  };
  function stencil(text, x0, y0, h, ws) {
    var u = h / 5, uw = u * (ws || 1), out = [], cx = x0;
    String(text).toUpperCase().split('').forEach(function (ch) {
      (GLYPH[ch] || []).forEach(function (b) { out = out.concat(rect(cx + b[0] * uw, y0 + b[1] * u, cx + b[2] * uw, y0 + b[3] * u)); });
      cx += (ch === ' ' ? 2.4 : 3.8) * uw;
    });
    return out;
  }

  /* ------------------------------------------------------------------ explicit 3D sections
     Fixed-topology rings: 21 vertices per half (bottom centreline -> outer side -> top centreline),
     mirrored to 40 per ring, so each vertex index keeps its meaning along the truck and box-section
     corners stay crisp. Coincident vertex pairs make zero-area quads, so the loft's area-weighted
     normals do not smooth across those creases (flat facets). [y, z] per vertex. */
  function flatPts(path) {
    var pts = [], cur = null, st = null, polys = [];
    path.forEach(function (sg) {
      if (sg.t === 'M') { if (pts.length) polys.push(pts); pts = []; cur = sg.p[0]; st = cur; pts.push(cur); }
      else if (sg.t === 'L') { cur = sg.p[0]; pts.push(cur); }
      else if (sg.t === 'C') {
        var c = [cur].concat(sg.p);
        for (var i = 1; i <= 10; i++) {
          var t = i / 10, u = 1 - t;
          pts.push([u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
            u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]]);
        }
        cur = sg.p[2];
      } else if (sg.t === 'Z' && st) { pts.push(st); cur = st; }
    });
    if (pts.length) polys.push(pts);
    return polys;
  }
  function sliceAt(polys, x) {
    var lo = Infinity, hi = -Infinity;
    polys.forEach(function (pts) {
      for (var i = 0; i + 1 < pts.length; i++) {
        var a = pts[i], b = pts[i + 1];
        if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
        var y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
    });
    return lo === Infinity ? null : [lo, hi];
  }
  function clamp01(t) { return Math.max(0, Math.min(1, t)); }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function tireW(s) { var m = /(\d{3})\//.exec(s); return m ? +m[1] / 1000 : 0.28; }
  function stationList(x0, x1, step, extra) {
    var xs = [];
    for (var x = x0; x <= x1 + 1e-9; x += step) xs.push(x);
    xs = xs.concat(extra).filter(function (x) { return x >= x0 - 1e-9 && x <= x1 + 1e-9; });
    xs.sort(function (a, b) { return a - b; });
    return xs.filter(function (x, i) { return i === 0 || x - xs[i - 1] > 0.004; });
  }
  function mirrorRing(h, flagsHalf, paintHalf) {
    var ring = h.map(function (q) { return [rd(q[0]), rd(q[1])]; });
    for (var i = h.length - 2; i >= 1; i--) ring.push([rd(h[i][0]), rd(-h[i][1])]);
    var sec = { ring: ring };
    if (flagsHalf) sec.glass = flagsHalf.concat(flagsHalf.slice(1, -1).reverse());
    if (paintHalf) sec.paint = paintHalf.concat(paintHalf.slice(1, -1).reverse());
    return sec;
  }
  function wellsOf(m, cfg) {
    var r = m.ref;
    return [[m.side.archF, r.trackF, r.tireF], [m.side.archR, r.trackR, r.tireR]].map(function (A) {
      var wr = Math.max(A[0].r, cfg.wellR || 0);
      return { x: A[0].x, y: A[0].y, r: wr, e: wr + (cfg.archPad || 0.06), zIn: A[1] / 2 - tireW(A[2]) / 2 - 0.025 };
    });
  }

  /* Box-section pickup: hood, windscreen, cab, open bed (U-section), tailgate.
     Half ring = 12-vertex lower chain + 9-vertex top chain (21; mirrored to 40):
       0-3  underbody / rocker corner
       4,5  (doubled) wheel-tub top  — at arch stations the tub wall rises at z = track/2 - tyre/2
       6,7  (doubled) flare underside outer edge / paint break (bumper top)
       8,9  (doubled) flare top
       10   step back onto the body side, 11 lower body side
       12+  top chain (hood / cab / bed / tail)
     Doubled vertices make zero-area quads so creases stay crisp (no saw-tooth normal blending).
     sec.paint[] (per vertex, 40): 'body' | 'black' (flares, tubs, rock rails, bumpers, bed liner) | 'grille'. */
  function truckSections(m, c) {
    var sb = flatPts(m.side.body), tb = flatPts(m.top.body), tg = flatPts(m.top.greenhouse);
    var fl = c.flares.map(flatPts), wells = wellsOf(m, c), r = m.ref;
    var xf = r.wheelbase / 2 + r.frontOverhang, xr = -(r.wheelbase / 2 + r.rearOverhang), hw = r.width / 2;
    function raw(x) { return sliceAt(sb, x); }
    function bottom(x) {
      for (var i = 0; i < wells.length; i++) {
        var w = wells[i];
        if (Math.abs(x - w.x) < w.e) { var l = raw(w.x - w.e), q = raw(w.x + w.e); return lerp(l[0], q[0], (x - w.x + w.e) / (2 * w.e)); }
      }
      return raw(x)[0];
    }
    function half(polys, x) { var s2 = sliceAt(polys, x); return s2 ? Math.max(Math.abs(s2[0]), Math.abs(s2[1])) : 0; }
    var ghRef = half(tg, (c.xA + c.xCab) / 2) || 1;
    function ring(x, type, opt) {
      opt = opt || {};
      var s2 = raw(x), yt = s2[1];
      // recessed grille plane: ahead of it only the protruding bumper remains (the bumper stands proud)
      if (c.face && x > c.face.x) yt = Math.min(yt, c.face.y);
      var yb = Math.min(bottom(x), yt - 0.1);
      var zT = half(tb, x), zW = Math.min(c.zBody, zT), zL = zW - 0.035, well = null, fz = null;
      wells.forEach(function (w) { if (Math.abs(x - w.x) < w.r && s2[0] > yb + 0.015) well = w; });
      fl.forEach(function (f) { var q = sliceAt(f, x); if (q && q[1] - q[0] > 0.01) fz = q; });
      // ---- top chain (9 vertices)
      var top = [], flags = null, yS, topPaint = null;
      if (type === 'hood') {
        yS = yt - 0.03;
        var zH = zW - 0.04, drop = opt.drop || 0;
        top.push([yS, zW], [yt - 0.008, zW - 0.012], [yt - drop * 0.5, zW - 0.04]);
        [0.8, 0.6, 0.42, 0.25, 0.1, 0].forEach(function (k) { top.push([yt - drop + (c.dome ? c.dome(x, zH * k) : 0), zH * k]); });
      } else if (type === 'cab' || type === 'cabEnd' || type === 'screen' || type === 'win' || type === 'winLow') {
        var bel = Math.min(c.belt, yt - 0.03);
        yS = bel;
        var yR = Math.max(yt, bel + 0.03), kz = Math.max(0.85, Math.min(1.02, half(tg, Math.min(x, c.xCowl - 0.03)) / ghRef));   // no plan-view pinch at the cowl corner
        var zBG = c.zBeltG * kz, zGT = c.zGlassTop * kz, yG = Math.max(bel + 0.012, yR - 0.04);
        top.push([bel, zW], [bel + 0.008, zBG], [lerp(bel + 0.008, yG, 0.5), lerp(zBG, zGT, 0.55)], [yG, zGT]);
        if (type === 'win' || type === 'winLow') {
          // cab back wall: rear slider glass opening (raked: top edge at 'win', bottom edge at 'winLow')
          var bw = c.backWin, zWn = bw.z, yTopW = type === 'win' ? bw.y1 : bw.y0;
          top[2] = [bw.y0, zWn]; top[3] = [yTopW, zWn];
          [zWn - 0.004, zWn * 0.8, zWn * 0.5, zWn * 0.2, 0].forEach(function (z) { top.push([yTopW, z]); });
          flags = top.map(function (q, i) { return i >= 2 ? 1 : 0; });
        } else {
          // roof-rail: crisp crease at the glass top (doubled vertex), then a ~35 mm radius onto the roof
          var dyR = Math.max(0.004, yR - yG), zC = zGT - 0.005;
          top.push([yG + 0.15 * dyR, zC], [yG + 0.15 * dyR, zC], [yR, zC - 0.035], [yR + 0.009, (zC - 0.035) * 0.5], [yR + 0.012, 0]);
          // glass only above the beltline, so the windscreen fan never reaches down into the cowl
          flags = top.map(function (q, i) {
            if (type === 'cabEnd') return 0;
            if (q[0] < c.belt - 0.005) return 0;
            return type === 'screen' ? (i >= 1 && i <= 3 || i >= 6 ? 1 : 0) : (i >= 1 && i <= 3 ? 1 : 0);   // screen: body-colour A-pillar strip at the rail crease
          });
        }
      } else {                                  // 'bed' (open U) or 'deck' / 'tail' (closed at the rail / tailgate)
        var rail = type === 'tail' ? yt : Math.min(c.rail, yt);
        yS = rail - 0.015;
        var zI = zW - 0.122, fy = type === 'bed' ? c.floor : rail, bed = type === 'bed';
        top.push([yS, zW], [rail, zW - 0.012], [rail, zW - 0.11], [bed ? rail - 0.012 : rail, zI],
          [bed ? fy + 0.30 : rail, zI], [bed ? fy + 0.03 : rail, zI], [fy, zI - 0.03], [fy, 0.45 * zI], [fy, 0]);
        if (bed) { flags = top.map(function (q, i) { return i >= 3 ? 1 : 0; }); topPaint = top.map(function (q, i) { return i >= 3 ? 'black' : 'body'; }); }
      }
      // ---- lower chain (12 vertices)
      var bF = c.bumperF, bR = c.bumperR, zone = null;
      if (bF && x > bF.x) zone = bF.y; else if (bR && x < bR.x) zone = bR.y;
      var inSill = c.sill && x > c.sill[0] && x < c.sill[1];
      var zF = fz ? Math.max(zW, Math.min(hw, zT + 0.002)) : zW, zl = well ? Math.min(zL, well.zIn) : zL;
      var y4, z4 = zW, y6, z6 = zW, y8;
      if (well) { y4 = Math.max(s2[0], yb + 0.04); z4 = zl; }
      else if (fz) y4 = Math.max(fz[0], yb + 0.07);
      else y4 = yb + 0.07;
      if (fz) { y6 = y4 + 0.002; z6 = zF; y8 = Math.max(fz[1], y6 + 0.012); }
      else if (well) { y6 = y4 + 0.002; y8 = y6 + 0.06; }
      else { y6 = Math.max(y4 + 0.002, zone ? Math.min(zone, yS - 0.012) : 0); y8 = y6; }
      var h = [[yb, 0], [yb, 0.5 * zl], [yb, zl - 0.045], [yb + 0.035, zl], [y4, z4], [y4, z4], [y6, z6], [y6, z6], [y8, z6], [y8, z6], [y8 + 0.004, zW]];
      h.push([y8 + 0.004, zW]);                 // doubled: crisp ledge / body-side crease (no saw-tooth normals)
      // squeeze the lower chain under the shoulder where the body is shallow (bumper ends)
      var nl = h.length, ymax = h[nl - 1][0];
      if (ymax > yS - 0.006) for (var j = 3; j < nl; j++) h[j][0] = yb + (h[j][0] - yb) * (yS - 0.006 - yb) / (ymax - yb);
      for (var i = 4; i < nl; i++) {
        if (i === 5 || i === 7 || i === 9 || i === 11) h[i][0] = h[i - 1][0];          // keep crease pairs coincident
        else if (h[i][0] < h[i - 1][0] + 0.001) h[i][0] = h[i - 1][0] + 0.001;
      }
      // ---- paint
      var P = h.map(function (q, k) { return k <= 2 ? 'black' : 'body'; });
      if (well || inSill) for (var k3 = 3; k3 <= 5; k3++) P[k3] = 'black';
      if (fz) for (var k5 = 5; k5 <= 9; k5++) P[k5] = 'black';
      if (zone && !fz && !well) for (var k0 = 0; k0 <= 7; k0++) P[k0] = 'black';
      P = P.concat(topPaint || top.map(function () { return 'body'; }));
      if (bF && x > bF.xAll) P = P.map(function () { return 'black'; });    // protruding bumper face
      if (c.grille && x >= c.grille.x0 && x <= c.grille.x1) {
        h.concat(top).forEach(function (q, k) { if (k >= 10 && q[1] < c.grille.z && q[0] > c.grille.y0 && q[0] < (c.grille.y1 || 9)) P[k] = 'grille'; });
      }
      h = h.concat(top);
      if (h.length !== 21) throw new Error('pickup ring ' + h.length);
      var sec = mirrorRing(h, flags ? h.slice(0, nl).map(function () { return 0; }).concat(flags) : null, P);
      sec.x = rd(x);
      return sec;
    }
    var e = 0.002;
    var ex = [xf - 0.004, xf - 0.02, xf - 0.033, xf - 0.037, xf - 0.05, xf - 0.08, xf - 0.12, xf - 0.18, xr + 0.004, xr + 0.016, xr + 0.03,
      c.xCowl + 0.02, c.xCowl - 0.02];
    if (c.grille) ex.push(c.grille.x0);
    if (c.face) ex.push(c.face.x + 0.002, c.face.x - 0.002);
    if (c.shut) ex.push(c.shut + 0.008, c.shut - 0.008);
    wells.forEach(function (w) { [-1.12, -1.0, -0.97, -0.9, -0.75, -0.55, -0.3, 0, 0.3, 0.55, 0.75, 0.9, 0.97, 1.0, 1.12].forEach(function (k) { ex.push(w.x + k * w.r); }); });
    var specials = [c.xCowl, c.xCab, c.xBedF, c.xTg].concat(c.shut ? [c.shut] : []);
    var bw = c.backWin;
    var all = stationList(xr + 0.004, xf - 0.004, 0.16, ex).filter(function (x) { return specials.every(function (q) { return Math.abs(x - q) > 0.006; }); })
      .filter(function (x) { return !bw || x > bw.xTop + 0.012 || x < c.xCab - e; });
    var out = [];
    all.forEach(function (x) {
      if (x > c.xCowl) out.push(ring(x, 'hood'));
      else if (x > c.xA) out.push(ring(x, 'screen'));
      else if (x > c.xCab + e) out.push(ring(x, 'cab'));
      else if (x > c.xTg + e && x < c.xBedF - e) out.push(ring(x, 'bed'));
      else if (x <= c.xTg - e) out.push(ring(x, 'tail'));
    });
    if (c.shut) out.push(ring(c.shut, 'hood', { drop: 0.02 }));   // hood shut-line groove behind the nose lip
    // crisp joints: cowl, cab back wall, bed front wall, tailgate inner face
    out.push(ring(c.xCowl + e, 'hood'), ring(c.xCowl, 'screen'));
    // cab back wall: last full cab ring, then (optionally) the raked rear-window rings, then the deck
    if (bw) out.push(ring(bw.xTop + 0.007, 'cabEnd'), ring(bw.xTop, 'win'), ring(bw.xBot, 'winLow'));
    else out.push(ring(c.xCab + e, 'cab'));
    out.push(ring(c.xCab, 'deck'),
      ring(c.xBedF + e, 'deck'), ring(c.xBedF, 'bed'), ring(c.xTg, 'bed'), ring(c.xTg - e, 'tail'));
    out.sort(function (p1, p2) { return p1.x - p2.x; });
    return out;
  }

  /* Faceted Cybertruck: polygonal rings with crisp creases (each crease vertex doubled so the
     loft's normals stay flat per facet). Body side vertical to y 1.20, chamfer facet to
     (z 0.94, y 1.33), side glass to (0.80, 1.62), roof to (0.60, H) at the apex; the same
     facet slopes are followed along the hood and the vault, scaled by the plan-view width. */
  function cyberSections(m, c) {
    var sb = flatPts(m.side.body), tb = flatPts(m.top.body), wells = wellsOf(m, { archPad: 0.07, wellR: 0.56 }), r = m.ref, tail = c.tail;
    var xf = r.wheelbase / 2 + r.frontOverhang, xr = -(r.wheelbase / 2 + r.rearOverhang), hw = r.width / 2, H = r.height;
    function raw(x) { return sliceAt(sb, x); }
    function bottom(x) {
      for (var i = 0; i < wells.length; i++) {
        var w = wells[i];
        if (Math.abs(x - w.x) < w.e) { var l = raw(w.x - w.e), q = raw(w.x + w.e); return lerp(l[0], q[0], (x - w.x + w.e) / (2 * w.e)); }
      }
      return raw(x)[0];
    }
    function half(x) { var s2 = sliceAt(tb, x); return s2 ? Math.max(Math.abs(s2[0]), Math.abs(s2[1])) : hw; }
    var hTop = H - 1.33;
    function ring(x) {
      var s2 = raw(x), yt = c.yTop(x), yb = Math.min(bottom(x), yt - 0.12);
      var k = Math.min(1, half(x) / hw), zW = hw * k, zl = zW, archTop = null;
      wells.forEach(function (w) { if (Math.abs(x - w.x) < w.r + 0.02 && s2[0] > yb + 0.015) { archTop = s2[0]; zl = Math.min(zW - 0.03, w.zIn); } });
      var yA = archTop != null ? archTop : yb + 0.06;
      var yF = Math.min(1.33, yt - 0.004), yS = Math.max(yA + 0.01, Math.min(1.20, yF - 0.06));
      var hgt = Math.max(0, yt - yF), u = hgt / hTop;
      var zF = 0.94 * k, zM = (0.94 - 0.14 * u) * k, yM = yF + 0.63 * hgt, zT = (0.94 - 0.34 * u) * k;
      // sail-pillar facets flanking the vault: outer facet steps from (z 0.94, y 1.33) to (z 0.80, y 1.55)
      var sw = smooth((x + 1.40) / 0.10) * smooth((-1.02 - x) / 0.08);
      if (sw > 0 && yt > yF + 0.03) {
        var ySail = Math.min(1.55, yt - 0.006);
        yM = lerp(yM, ySail, sw); zM = lerp(zM, Math.max(zT + 0.01, 0.80 * k), sw);
      }
      // windscreen runs onto the hood-level top surface back from c.xWs; side glass starts at xGlassF
      var glass = x > c.xGlassR && x < c.xWs, sideGlass = x < c.xGlassF;
      // underbody sweeps up 40 mm over the last 0.35 m at each end (approach / departure chamfers)
      var ybc = Math.min(yA - 0.02, yb + 0.04 * (smooth((x - (xf - 0.35)) / 0.35) + smooth(((xr + 0.35) - x) / 0.35)));
      var vault = x < c.xVault, yV = vault ? yt - 0.012 : yt, zV = vault ? zT - 0.012 : zT;
      var h = [[ybc, 0], [ybc, 0.5 * zl], [yb, zl - 0.03], [yb + 0.03, zl], [yb + 0.03, zl],
        [yA, zl], [yA, zl], [yA + 0.001, zW], [yA + 0.001, zW],
        [yS, zW], [yS, zW], [yF, zF], [yF, zF], [yM, zM], [yM, zM], [yt, zT], [yV, zV],
        [yV, 0.66 * zV], [yV, 0.4 * zV], [yV, 0.18 * zV], [yV, 0]];
      // (vault: the matte-black tonneau sits 12 mm below and inboard of the sail-pillar tops -> separate sails)
      for (var i = 1; i < h.length; i++) if (h[i][0] < h[i - 1][0] - 1e-9 && i < 16) h[i][0] = h[i - 1][0];
      var flags = h.map(function (q, i) { return glass && i >= (sideGlass ? 12 : 15) ? 1 : 0; });
      var sec = mirrorRing(h, flags);
      // per-vertex paint: black cladding below 0.74 (arches, rocker, bumpers), matte-black vault slats,
      // emissive light bars on the nose crease and the tailgate top
      var P = h.map(function (q, i) {
        if (q[0] < 0.745) return 'black';
        if (x >= xf - 0.012 && q[0] >= yt - 0.009) return 'light';
        if (x <= xr + 0.012 && q[0] >= tail[1] - 0.045 && q[0] <= tail[1] - 0.005) return 'light-red';
        if (vault && i >= 16) return 'black';
        return 'body';
      });
      sec.paint = P.concat(P.slice(1, -1).reverse());
      sec.x = rd(x);
      return sec;
    }
    var ex = [xf - 0.01, xf - 0.03, xf - 0.06, xf - 0.10, xr + 0.01, xr + 0.03, xr + 0.06, c.xGlassF - 0.004, c.xGlassF + 0.004, c.xGlassR - 0.004, c.xGlassR + 0.004, 0.12, 1.70, 1.62, -1.30, -1.40, c.xVault + 0.004, c.xVault - 0.004,
      c.xWs + 0.04, c.xWs - 0.003, -1.03, -1.08, xr + 0.012, xf - 0.012];
    wells.forEach(function (w) { [-1.1, -1.0, -0.98, -0.9, -0.7, -0.4, 0, 0.4, 0.7, 0.9, 0.98, 1.0, 1.1].forEach(function (q) { ex.push(w.x + q * w.r); }); });
    return stationList(xr + 0.004, xf - 0.004, 0.18, ex).map(ring);
  }

  function register(m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  }

  /* ==================================================================================
     1. FORD F-150 RAPTOR — 3rd generation (P702), SuperCrew, 5.5 ft box, 35" package
     ================================================================================== */
  function raptor() {
    var IN = 0.0254;
    var wb = 145.4 * IN, a = wb / 2, L = 232.6 * IN, W = 86.6 * IN, H = 79.8 * IN;
    var FO = 0.960, RO = L - wb - FO, xf = a + FO, xr = -a - RO;
    var tireD = 17 * IN + 2 * 0.315 * 0.70, R = tireD / 2;  // LT315/70R17 ≈ 34.4"
    var AR = 0.53, FL = 0.10, FLT = 0.165, hw = W / 2;   // flare: 0.10 m proud at the sides, 0.165 m deep over the top
    var yRF = 0.60, yRR = 0.70;                            // body edge height at front / rear arches
    // gen-3 flares: flat-topped trapezoids (flat top ~0.60 m at y = R + 0.50), 30-degree end cuts
    var archInF = [[-0.53, yRF - R, 0], [-0.50, 0.20, 0.08], [-0.30, 0.50, 0.10]];
    var archInR = [[-0.53, yRR - R, 0], [-0.50, 0.20, 0.08], [-0.30, 0.50, 0.10]];
    function flareOut(yEdge) { return [[-0.53 - 0.11, yEdge - R, 0], [-0.50 - FL, Math.max(0.21, yEdge - R + 0.05), 0.10], [-0.30 - 0.06, 0.50 + FLT, 0.12]]; }
    var flareF = polyFlare(a, R, archInF, flareOut(yRF)), flareR = polyFlare(-a, R, archInR, flareOut(yRR));

    var side = {
      body: closedP([
        [xf - 0.26, 0.50, 0.04],     // skid plate leading edge
        [xf - 0.05, 0.585, 0.06],    // bumper lower lip
        [xf, 0.70, 0.03],
        [xf, 0.86, 0.02],            // bumper top
        [xf - 0.035, 0.89, 0.01],    // step into grille
        [xf - 0.04, 1.42, 0.03],     // grille top (flat, near-vertical 0.55 m nose face)
        [xf - 0.10, 1.47, 0.05],     // hood leading edge
        [xf - 0.80, 1.49, 1.4],      // hood crown (nearly level)
        [1.32, 1.525, 0.05],         // cowl / windshield base
        [0.58, 1.99, 0.10],          // A-pillar top
        [-0.25, H, 3.0],             // roof crest
        [-0.99, H - 0.02, 0.09],     // roof rear corner
        [-1.075, 1.90, 0.05],
        [-1.09, 1.40, 0],            // cab back meets bed rail
        [xr + 0.03, 1.40, 0.015],    // bed rail end
        [xr + 0.015, 1.375, 0.01],
        [xr + 0.015, 0.87, 0.01],    // tailgate bottom
        [xr, 0.85, 0.01],
        [xr, 0.62, 0.03],            // rear step bumper
        [xr + 0.05, 0.56, 0.03],
        [xr + 0.30, 0.56, 0.02],
        [xr + 0.34, yRR, 0.02],      // bumper end cap meets the box
        [-a - 0.64, yRR, 0.03]
      ].concat(polyArch(-a, R, archInR), [
        [-1.13, yRR, 0.02],
        [-1.11, 0.53, 0.03],         // cab rocker
        [a - 0.62, 0.53, 0.03]
      ], polyArch(a, R, archInF), [
        [a + 0.64, 0.575, 0.04]
      ])),
      greenhouse: closedP([[1.25, 1.535, 0.01], [0.57, 1.965, 0.06], [-0.97, H - 0.035, 0.08], [-1.065, 1.90, 0.04], [-1.075, 1.555, 0]]),
      windows: [
        closedP([[1.13, 1.50, 0.01], [0.62, 1.915, 0.04], [0.11, 1.935, 0.03], [0.11, 1.565, 0.01], [0.86, 1.548, 0.01], [0.97, 1.505, 0.01]]),
        closedP([[-0.005, 1.565, 0.01], [-0.005, 1.935, 0.03], [-0.78, 1.92, 0.04], [-0.86, 1.56, 0.01]])
      ],
      pillars: [
        closedP([[1.25, 1.535, 0], [0.57, 1.965, 0.03], [0.62, 1.915, 0.02], [1.13, 1.50, 0]]),                    // A
        rect(-0.005, 1.565, 0.11, 1.95, 0.005),                                                                  // B (gloss black)
        closedP([[-0.86, 1.56, 0], [-0.78, 1.92, 0.02], [-0.97, H - 0.035, 0.05], [-1.065, 1.90, 0.03], [-1.075, 1.555, 0]]) // C (thick)
      ],
      doorCuts: [
        closedP([[1.215, 0.56, 0.02], [1.225, 1.49, 0.02], [1.15, 1.505, 0], [0.60, 1.955, 0.03], [0.065, 1.975, 0.02], [0.055, 0.56, 0.02]]),
        closedP([[0.035, 0.56, 0.02], [0.035, 1.975, 0.02], [-0.80, 1.965, 0.03], [-0.88, 1.94, 0.02], [-0.90, 1.56, 0], [-1.00, 1.50, 0.02], [-1.00, 0.56, 0.02]])
      ],
      panelLines: [
        lineP([[1.32, 1.515], [xf - 0.80, 1.475, 1.4], [xf - 0.11, 1.455]]),        // hood shut line
        lineP([[-1.115, yRR + 0.01], [-1.115, 1.40]]),                              // cab / box gap
        lineP([[xr + 0.05, 0.87], [xr + 0.05, 1.39]]),                              // tailgate edge
        lineP([[xf - 0.03, 0.885], [a + 0.62, 0.875, 0.05], [a + 0.56, 0.70]]),     // bumper cover
        rect(-1.30, 1.08, -1.16, 1.22, 0.015)                                      // fuel door (driver's side, bed side between cab and arch)
      ],
      characterLines: [
        lineP([[a + 0.72, 1.31], [1.23, 1.305]]),                                  // fender shoulder
        lineP([[1.21, 1.305], [-1.10, 1.31]]),                                     // door shoulder
        lineP([[-1.13, 1.31], [xr + 0.06, 1.31]]),                                 // box shoulder
        lineP([[1.19, 0.80], [0.40, 0.84, 0.6], [-0.99, 0.86]]),                   // lower door sculpt
        lineP([[-1.15, 1.16], [xr + 0.10, 1.18]])                                  // stamped bed-side character line
      ],
      sill: rect(-1.06, 0.475, 1.17, 0.555, 0.02),                                 // Raptor rock rail
      archF: { x: a, y: R, r: 0.485, flare: FL, shape: 'squared' },             // dark well radius (body opening is the 0.53 polygon)
      archR: { x: -a, y: R, r: 0.485, flare: FL, shape: 'squared' },
      lowerTrim: ccw(cat(
        flareF, flareR,                                                            // flat-topped composite flares
        rect(-1.06, 0.475, 1.17, 0.555, 0.02),
        closedP([[xf - 0.26, 0.50, 0.04], [xf - 0.05, 0.585, 0.06], [xf, 0.70, 0.02], [xf - 0.15, 0.71, 0.02], [a + 0.56, 0.66, 0.02], [a + 0.50, 0.58, 0.02]]),
        closedP([[xr, 0.62, 0.02], [xr, 0.85, 0.01], [xr + 0.32, 0.85, 0.01], [xr + 0.34, yRR, 0.01], [xr + 0.30, 0.56, 0.02], [xr + 0.05, 0.56, 0.02]])
      ))
    };

    var top = {
      body: sym([
        [xf, 0, 0], [xf - 0.015, 0.70, 0.18], [xf - 0.13, 0.965, 0.10], [a + 0.58, 1.03, 0.05],
        [a + 0.52, hw, 0.06], [a - 0.52, hw, 0.06], [a - 0.60, 1.02, 0.04],
        [-a + 0.60, 1.015, 0.04], [-a + 0.52, hw, 0.06], [-a - 0.52, hw, 0.06], [-a - 0.60, 1.015, 0.04],
        [xr, 1.00, 0.04], [xr, 0, 0]
      ], 1),
      greenhouse: sym([[1.32, 0, 0], [1.30, 0.93, 0.06], [0.58, 0.88, 0.08], [-1.00, 0.88, 0.06], [-1.075, 0.92, 0.03], [-1.075, 0, 0]], 1),
      hood: sym([[xf - 0.10, 0, 0], [xf - 0.12, 0.86, 0.10], [1.34, 0.93, 0.04], [1.34, 0, 0]], 1),
      roof: sym([[0.56, 0, 0], [0.56, 0.80, 0.08], [-0.98, 0.81, 0.06], [-0.98, 0, 0]], 1),
      deck: sym([[-1.17, 0, 0], [-1.17, 0.855, 0.02], [xr + 0.07, 0.855, 0.02], [xr + 0.07, 0, 0]], 1),  // open box
      mirrors: split2(closedP([[1.24, 0.93, 0.01], [1.24, 1.20, 0.03], [1.12, 1.225, 0.03], [0.99, 1.21, 0.03], [1.02, 0.95, 0.02]]), 1)
    };

    var front = {
      // full-width cab (roof ~1.66 m), body sides at 1.03, black flares out to the published 86.6 in
      body: sym([
        [0, H, 0], [0.83, H - 0.01, 0.06], [0.88, 1.96, 0.04], [0.95, 1.56, 0.02], [1.02, 1.535, 0.02],
        [1.03, 1.46, 0.03], [1.03, 1.115, 0.01], [hw, 1.10, 0.015], [hw, 0.86, 0.015], [1.03, 0.84, 0.01],
        [1.03, 0.72, 0.03], [1.00, 0.62, 0.05], [0.80, 0.48, 0.06], [0, 0.46, 0]
      ], 0),
      greenhouse: sym([[0, 1.995, 0], [0.80, 1.985, 0.06], [0.93, 1.57, 0.03], [0, 1.56, 0]], 0),
      bumper: { paint: 'black', path: sym([[0, 0.90, 0], [0.97, 0.90, 0.03], [1.025, 0.80, 0.03], [1.00, 0.62, 0.05], [0.80, 0.48, 0.06], [0, 0.46, 0]], 0) },  // dark-grey Raptor bumper
      grille: [
        sym([[0, 1.42, 0], [0.655, 1.42, 0.02], [0.665, 1.16, 0.01], [0.62, 0.90, 0.03], [0, 0.90, 0]], 0),      // frame / opening
        sym([[0, 1.395, 0], [0.63, 1.395, 0.01], [0.635, 1.20, 0.01], [0, 1.20, 0]], 0),                        // upper mesh
        sym([[0, 1.055, 0], [0.635, 1.055, 0.01], [0.60, 0.93, 0.02], [0, 0.93, 0]], 0)                          // lower mesh
      ],
      intakes: [sym([[0, 0.68, 0], [0.42, 0.68, 0.02], [0.38, 0.54, 0.02], [0, 0.54, 0]], 0)].concat(
        pair(closedP([[0.50, 0.86, 0.01], [0.66, 0.86, 0.02], [0.66, 0.70, 0.02], [0.53, 0.68, 0.01]]))),
      // wide, low rectangular LED lamps, top edge flush with the grille top
      headlights: pair(closedP([[0.62, 1.42, 0.012], [1.00, 1.42, 0.03], [1.00, 1.25, 0.03], [0.95, 1.20, 0.02], [0.62, 1.20, 0.012]])),
      // C-clamp LED signature: bracket opening toward the grille, wrapping the projector
      drl: pair(closedP([[0.72, 1.405, 0], [0.96, 1.405, 0.02], [0.98, 1.27, 0.03], [0.94, 1.215, 0.02], [0.72, 1.215, 0],
        [0.72, 1.245, 0], [0.92, 1.245, 0.01], [0.95, 1.276, 0.02], [0.932, 1.375, 0.01], [0.72, 1.375, 0]])),
      // horizontal fog-lamp pods in the bumper corners, each with a lit LED strip
      fogLights: [{ paint: 'black', path: both(rect(0.69, 0.71, 0.88, 0.80, 0.015)) }].concat(pair(rect(0.71, 0.745, 0.86, 0.767, 0.008))),
      splitter: sym([[0, 0.54, 0], [0.36, 0.54, 0.01], [0.33, 0.47, 0.01], [0, 0.465, 0]], 0),                  // steel skid plate
      plateArea: rect(-0.155, 0.70, 0.155, 0.852, 0.008),
      badgeArea: rect(-0.42, 1.07, 0.42, 1.20, 0.01),                                                            // big "FORD" block letters spanning the grille bar
      badgeText: 'FORD'
    };

    var rear = {
      body: sym([
        [0, H, 0], [0.83, H - 0.01, 0.06], [0.88, 1.96, 0.04], [0.95, 1.565, 0.02], [1.02, 1.54, 0.02],
        [1.03, 1.46, 0.02], [1.03, 1.115, 0.01], [hw, 1.10, 0.015], [hw, 0.86, 0.015], [1.03, 0.84, 0.01],
        [1.03, 0.72, 0.03], [1.00, 0.60, 0.04], [0.85, 0.55, 0.05], [0, 0.55, 0]
      ], 0),
      greenhouse: sym([[0, 1.96, 0], [0.78, 1.95, 0.05], [0.86, 1.57, 0.03], [0, 1.56, 0]], 0),
      bumper: { paint: 'black', path: sym([[0, 0.86, 0], [1.01, 0.86, 0.03], [1.035, 0.72, 0.03], [1.00, 0.60, 0.04], [0.85, 0.545, 0.05], [0, 0.545, 0]], 0) },
      taillights: pair(closedP([[0.84, 1.40, 0.01], [1.005, 1.40, 0.02], [1.02, 1.32, 0.02], [1.02, 0.90, 0.02], [0.84, 0.90, 0.01]])),
      // vertical C-clamp LED tube inside each lamp, opening inboard
      lightBar: pair(closedP([[0.87, 1.37, 0], [0.99, 1.37, 0.02], [0.995, 0.93, 0.02], [0.87, 0.93, 0],
        [0.87, 0.958, 0], [0.968, 0.958, 0.01], [0.966, 1.342, 0.01], [0.87, 1.342, 0]])),
      diffuser: rect(-0.13, 0.50, 0.13, 0.58, 0.01),                                                              // receiver hitch
      exhaust: [{ shape: 'round', cx: 0.72, cy: 0.56, w: 0.10, h: 0.10 }, { shape: 'round', cx: -0.72, cy: 0.56, w: 0.10, h: 0.10 }],  // in the bumper's lower edge
      plateArea: rect(-0.155, 0.645, 0.155, 0.797, 0.008),
      badgeArea: rect(-0.60, 1.08, 0.60, 1.26, 0.01),                                                              // big stamped FORD tailgate letters
      badgeText: 'FORD',
      panelLines: [rect(-0.83, 0.87, 0.83, 1.395, 0.015)]
    };

    var details = [
      { view: 'side', role: 'mirror', paint: 'black', path: closedP([[1.06, 1.50, 0.02], [1.27, 1.52, 0.03], [1.24, 1.80, 0.04], [1.08, 1.82, 0.03]]) },  // tall towing-style mirror, leaning forward
      { view: 'side', role: 'mirrorArm', paint: 'black', path: closedP([[1.11, 1.51, 0.005], [1.21, 1.515, 0.005], [1.17, 1.46, 0.005]]) },                      // arm / sail down to the door
      { view: 'side', role: 'handle', paint: 'black', path: rect(0.22, 1.355, 0.40, 1.395, 0.018) },
      { view: 'side', role: 'handle', paint: 'black', path: rect(-0.70, 1.355, -0.52, 1.395, 0.018) },
      { view: 'side', role: 'vent', paint: 'black', path: closedP([[1.28, 1.14, 0.01], [1.62, 1.17, 0.01], [1.66, 1.33, 0.01], [1.34, 1.30, 0.01]]) },  // functional fender vent, raked back
      { view: 'side', role: 'vent', paint: 'grille', path: closedP([[1.32, 1.19, 0], [1.63, 1.215, 0], [1.635, 1.235, 0], [1.325, 1.21, 0]]) },
      { view: 'side', role: 'vent', paint: 'grille', path: closedP([[1.335, 1.25, 0], [1.645, 1.275, 0], [1.65, 1.295, 0], [1.34, 1.27, 0]]) },
      { view: 'side', role: 'headlight', paint: 'light', path: closedP([[xf - 0.15, 1.20, 0.01], [xf - 0.045, 1.20, 0.01], [xf - 0.043, 1.415, 0.01], [xf - 0.14, 1.415, 0.01]]) },
      { view: 'side', role: 'marker', paint: 'light-amber', path: rect(xf - 0.13, 0.75, xf - 0.02, 0.79, 0.01) },
      { view: 'side', role: 'taillight', paint: 'light-red', path: rect(xr, 0.95, xr + 0.04, 1.37, 0.008) },
      { view: 'side', role: 'marker', paint: 'light-red', path: rect(xr + 0.06, 1.25, xr + 0.12, 1.28, 0.005) },
      { view: 'side', role: 'step', paint: 'black', path: rect(-a - 0.80, 0.60, -a - 0.60, 0.66, 0.01) },
      { view: 'side', role: 'badgeText', text: 'RAPTOR', paint: 'black', path: stencil('RAPTOR', -2.42, 1.205, 0.095) },  // big bed-side decal
      { view: 'top', role: 'vent', paint: 'black', path: both(closedP([[2.30, 0.46, 0.02], [2.56, 0.50, 0.02], [2.56, 0.72, 0.02], [2.30, 0.70, 0.02]]), 1) },
      { view: 'top', role: 'scoop', paint: 'body', path: sym([[2.55, 0, 0], [2.52, 0.26, 0.2], [1.50, 0.30, 0.3], [1.45, 0, 0]], 1) },   // low power-dome ridge
      { view: 'top', role: 'wiper', paint: 'black', path: both(rect(1.34, 0.05, 1.38, 0.62, 0.01), 1) },
      { view: 'top', role: 'trim', paint: 'black', path: both(rect(-1.17, 0.86, xr + 0.04, 0.99, 0.01), 1) },  // bed-rail caps
      { view: 'top', role: 'bedFloor', paint: 'black', path: rect(xr + 0.09, -0.835, -1.19, 0.835, 0.02) },           // spray-in bed liner
      { view: 'top', role: 'trim', paint: 'black', path: cat(rect(-1.75, -0.66, -1.62, -0.52, 0.01), rect(-1.75, 0.52, -1.62, 0.66, 0.01)) },  // wheel-tub tie-downs
      { view: 'front', role: 'mirror', paint: 'black', path: both(closedP([[0.92, 1.52, 0.01], [1.215, 1.53, 0.03], [1.22, 1.79, 0.03], [1.02, 1.80, 0.03], [1.00, 1.60, 0.02], [0.92, 1.58, 0.01]])) },
      { view: 'front', role: 'marker', paint: 'light-amber', path: cat(rect(-0.16, 1.285, -0.10, 1.31, 0.004), rect(-0.03, 1.285, 0.03, 1.31, 0.004), rect(0.10, 1.285, 0.16, 1.31, 0.004)) },
      { view: 'front', role: 'trim', paint: 'gloss-black', path: both(rect(0.62, 1.20, 0.70, 1.42, 0.008)) },   // dark inboard lens strip: keeps the C-clamp open toward the grille
      { view: 'front', role: 'trim', paint: 'gloss-black', path: sym([[0, 1.205, 0], [0.66, 1.205, 0.01], [0.66, 1.062, 0.01], [0, 1.062, 0]], 0) },  // dark grille cross-bar behind the FORD letters
      { view: 'front', role: 'vent', paint: 'black', path: both(closedP([[0.32, 1.43, 0.01], [0.62, 1.43, 0.01], [0.60, 1.48, 0.015], [0.34, 1.48, 0.015]])) },  // hood nostrils
      { view: 'front', role: 'trim', paint: 'black', path: both(closedP([[1.03, 1.115, 0], [hw, 1.10, 0.01], [hw, 0.86, 0.01], [1.03, 0.84, 0]])) },     // flares
      { view: 'front', role: 'wiper', paint: 'black', path: rect(-0.70, 1.57, 0.70, 1.585, 0.005) },
      { view: 'front', role: 'trim', paint: 'black', path: both(rect(0.50, 0.58, 0.58, 0.66, 0.02)) },  // tow hooks
      { view: 'rear', role: 'handle', paint: 'black', path: rect(-0.11, 1.30, 0.11, 1.355, 0.015) },
      { view: 'rear', role: 'mirror', paint: 'black', path: both(closedP([[0.92, 1.52, 0.01], [1.215, 1.53, 0.03], [1.22, 1.79, 0.03], [1.02, 1.80, 0.03], [1.00, 1.60, 0.02], [0.92, 1.58, 0.01]])) },
      { view: 'rear', role: 'trim', paint: 'black', path: lineP([[-0.22, 1.55], [-0.22, 1.95]]).concat(lineP([[0.22, 1.55], [0.22, 1.95]])) },  // sliding rear window
      { view: 'rear', role: 'marker', paint: 'light-red', path: cat(rect(-0.16, 1.975, -0.10, 1.995), rect(-0.03, 1.975, 0.03, 1.995), rect(0.10, 1.975, 0.16, 1.995)) },
      { view: 'rear', role: 'step', paint: 'black', path: both(rect(0.70, 0.835, 0.95, 0.86, 0.01)) },
      { view: 'rear', role: 'step', paint: 'carbon', path: both(rect(0.70, 0.86, 0.90, 0.90, 0.01)) },     // bumper corner steps
      { view: 'rear', role: 'trim', paint: 'black', path: both(closedP([[1.03, 1.115, 0], [hw, 1.10, 0.01], [hw, 0.86, 0.01], [1.03, 0.84, 0]])) }   // flares
    ];

    var model = {
      id: 'ford-f150-raptor-gen3', make: 'Ford', name: 'F-150 Raptor', gen: '3rd gen (P702)', years: '2021–',
      look: { head: 'c-clamp', tail: 'vertical', grille: 'bar' },   // renderer lamp / grille signature
      style: 'pickup', 'default': true, color: '#c8561e', colorName: 'Code Orange', enginePosition: 'front', drivetrain: '4wd', powertrain: 'ice',
      ref: {
        length: L, width: W, height: H, wheelbase: wb, trackF: 74.0 * IN, trackR: 73.6 * IN,
        frontOverhang: FO, rearOverhang: RO, wheelDiameter_in: 17, tireF: 'LT315/70R17', tireR: 'LT315/70R17',
        groundClearance: 12.0 * IN, rideHeight: 12.0 * IN, cd: 0.55, curbWeight_kg: 2590,
        widthWithMirrors: 96.0 * IN, approach_deg: 31.0, departure_deg: 23.9, cdNote: 'estimate (Ford publishes none)'
      },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Squared LED units with a C-clamp DRL bracket wrapping the projector, opening toward the grille',
        taillights: 'Tall vertical lamps on the box corners with an inboard-opening C-clamp LED tube',
        grille: 'Full-width black grille between the headlamps, dark cross-bar with big FORD block letters and three amber identification lamps',
        notes: 'Long level hood over a tall flat-faced nose, flat-topped trapezoid flares with front nostril vents, functional fender vents, wide composite flares, rock rails, steel skid plate, 35-inch BFGoodrich KO2s'
      }
    };
    model.sections = truckSections(model, {
      xCowl: 1.32, xA: 0.58, xCab: -1.09, xBedF: -1.12, xTg: xr + 0.06, rail: 1.40, floor: 0.95, belt: 1.56,
      zBody: 1.03, zBeltG: 0.95, zGlassTop: 0.88, zRoof: 0.83, flares: [flareF, flareR], wellR: AR,
      shut: xf - 0.10,                                                          // hood shut-line groove: crisp nose leading edge
      face: { x: xf - 0.034, y: 0.88 },                                         // grille plane behind the proud bumper
      grille: { x0: xf - 0.06, x1: xf, z: 0.665, y0: 0.89, y1: 1.43 },
      bumperF: { x: a + 0.62, y: 0.86, xAll: xf - 0.03 }, bumperR: { x: xr + 0.34, y: 0.85 },
      backWin: { xTop: -1.035, xBot: -1.075, y0: 1.60, y1: 1.93, z: 0.72 },     // rear slider glass, ~7 deg rake
      dome: function (x, z) { return 0.035 * smooth((x - 1.45) / 0.25) * smooth((2.55 - x) / 0.2) * (1 - smooth((z - 0.24) / 0.1)); }
    });
    return model;
  }

  /* ==================================================================================
     2. TOYOTA TACOMA TRD PRO — 4th generation (N400), 2024, Double Cab 5 ft bed
     ================================================================================== */
  function tacoma() {
    var IN = 0.0254;
    var wb = 131.9 * IN, a = wb / 2, L = 214.2 * IN, W = 80.1 * IN, H = 76.5 * IN;
    var FO = 0.880, RO = L - wb - FO, xf = a + FO, xr = -a - RO;
    var tireD = 18 * IN + 2 * 0.265 * 0.70, R = tireD / 2;   // LT265/70R18 (Toyota: "33-inch")
    var hw = W / 2, FL = 0.085, FLT = 0.14, yRF = 0.58, yRR = 0.66;
    // blocky, squared arch profile (rear half, relative to wheel centre): 0.62 m flat top, tight corners
    var archIn = [[-0.47, yRF - R, 0], [-0.475, 0.12, 0.10], [-0.31, 0.475, 0.06]];
    var archInR = [[-0.47, yRR - R, 0], [-0.475, 0.12, 0.10], [-0.31, 0.475, 0.06]];
    // flare band: both end vertices clamped to the body edge height (no hooks)
    function flareOut(yEdge) { return [[-0.47 - 0.095, yEdge - R, 0], [-0.475 - FL, Math.max(0.13, yEdge - R + 0.05), 0.12], [-0.31 - 0.035, 0.475 + FLT, 0.08]]; }
    var flareF = polyFlare(a, R, archIn, flareOut(yRF)), flareR = polyFlare(-a, R, archInR, flareOut(yRR));

    var side = {
      body: closedP([
        [xf - 0.24, 0.47, 0.04],
        [xf - 0.03, 0.56, 0.06],
        [xf, 0.70, 0.04],
        [xf - 0.005, 0.84, 0.01],     // bumper top: stands proud of the grille
        [xf - 0.035, 0.86, 0.01],     // grille plane, set back 30 mm
        [xf - 0.04, 1.18, 0.01],
        [xf - 0.015, 1.21, 0.01],     // lamp / hood lip overhangs the grille
        [xf - 0.02, 1.27, 0.03],      // tall, blunt, near-vertical face
        [xf - 0.065, 1.405, 0.05],    // hood leading edge (high, squared-off 2024 nose)
        [xf - 0.72, 1.395, 1.2],      // hood crown (level, rising slightly toward the nose)
        [1.18, 1.40, 0.05],           // windshield base
        [0.40, 1.90, 0.10],           // A-pillar top
        [-0.15, H, 3.0],              // roof crest
        [-0.92, H - 0.02, 0.09],
        [-1.02, H - 0.015, 0.008],    // integrated roof spoiler: lip overhangs the cab back by 30 mm
        [-1.03, H - 0.045, 0.008],
        [-0.995, 1.82, 0.05],
        [-1.01, 1.30, 0],             // cab back meets bed rail
        [-2.80, 1.30, 0.006],         // bed rail notch: steps down 40 mm beside the taillamp
        [-2.81, 1.26, 0.006],
        [xr + 0.03, 1.26, 0.012],
        [xr + 0.015, 1.24, 0.008],
        [xr + 0.015, 0.82, 0.01],     // tailgate bottom
        [xr, 0.80, 0.01],
        [xr, 0.60, 0.03],
        [xr + 0.05, 0.545, 0.03],
        [xr + 0.28, 0.545, 0.02],
        [xr + 0.32, yRR, 0.02],
        [-a - 0.60, yRR, 0.03]
      ].concat(polyArch(-a, R, archInR), [
        [-1.05, yRR, 0.02],
        [-1.03, 0.50, 0.03],          // rocker
        [a - 0.56, 0.50, 0.03]
      ], polyArch(a, R, archIn), [
        [a + 0.60, 0.54, 0.04]
      ])),
      greenhouse: closedP([[1.18, 1.405, 0.01], [0.40, 1.885, 0.07], [-0.90, H - 0.035, 0.08], [-0.99, 1.825, 0.04], [-1.00, 1.445, 0]]),
      windows: [
        closedP([[0.98, 1.43, 0.0], [0.98, 1.49, 0.0], [0.44, 1.85, 0.04], [0.02, 1.87, 0.03], [0.02, 1.428, 0.01]]),
        closedP([[-0.06, 1.432, 0.01], [-0.06, 1.87, 0.03], [-0.74, 1.86, 0.03], [-0.79, 1.45, 0.01], [-0.77, 1.443, 0.01]])
      ],
      pillars: [
        closedP([[1.18, 1.405, 0], [0.40, 1.885, 0.03], [0.44, 1.85, 0.02], [0.98, 1.49, 0], [1.08, 1.42, 0]]),             // A
        closedP([[1.08, 1.42, 0], [0.98, 1.49, 0], [0.98, 1.43, 0]]),                                                     // mirror sail
        rect(-0.06, 1.428, 0.02, 1.885, 0.004),                                                                           // B
        closedP([[-0.77, 1.443, 0], [-0.79, 1.45, 0], [-0.74, 1.86, 0.02], [-0.90, H - 0.035, 0.05], [-0.99, 1.825, 0.03], [-1.00, 1.445, 0]]) // thick C
      ],
      doorCuts: [
        closedP([[1.10, 0.53, 0.02], [1.11, 1.39, 0.02], [1.065, 1.42, 0], [0.42, 1.88, 0.03], [-0.025, 1.90, 0.02], [-0.035, 0.53, 0.02]]),
        closedP([[-0.05, 0.53, 0.02], [-0.05, 1.90, 0.02], [-0.75, 1.89, 0.03], [-0.81, 1.45, 0.01], [-0.935, 1.40, 0.02], [-0.945, 0.53, 0.02]])
      ],
      panelLines: [
        lineP([[1.18, 1.315], [1.86, 1.355, 1.2], [xf - 0.10, 1.39]]),               // hood shut line rising toward the nose
        lineP([[1.15, 0.70], [1.15, 1.20]]),                                          // front-fender rear cut
        lineP([[-1.035, yRR + 0.01], [-1.035, 1.30]]),
        lineP([[-2.80, 1.25], [-2.80, 1.29]]),                                       // bed-rail notch edge
        lineP([[xr + 0.05, 0.82], [xr + 0.05, 1.25]]),
        lineP([[xf - 0.02, 0.86], [a + 0.60, 0.855, 0.05], [a + 0.55, 0.70]]),
        rect(-1.32, 1.00, -1.15, 1.15, 0.02)                                                                              // fuel door
      ],
      characterLines: [
        lineP([[xf - 0.04, 1.215], [a + 0.30, 1.225, 0.8], [1.12, 1.23]]),                                                // shoulder starts at the headlamp top
        lineP([[1.09, 1.23], [-1.02, 1.235]]),
        lineP([[-1.05, 1.235], [xr + 0.05, 1.20]]),                                                                       // kicks down toward the taillamp
        lineP([[1.08, 0.78], [-0.92, 0.82]]),                                                                             // door sculpt
        lineP([[-1.06, 0.86], [xr + 0.10, 0.92]])                                                                         // lower bed sculpt
      ],
      sill: rect(-0.95, 0.44, 1.08, 0.52, 0.02),
      archF: { x: a, y: R, r: 0.455, flare: FL, shape: 'squared' },             // dark well radius (body opening is the 0.475 polygon)
      archR: { x: -a, y: R, r: 0.455, flare: FL, shape: 'squared' },
      lowerTrim: ccw(cat(
        flareF, flareR,
        rect(-0.95, 0.44, 1.08, 0.52, 0.02),
        closedP([[xf - 0.24, 0.47, 0.04], [xf - 0.03, 0.56, 0.06], [xf, 0.66, 0.02], [a + 0.55, 0.64, 0.02], [a + 0.47, 0.53, 0.02]]),
        closedP([[xr, 0.60, 0.02], [xr, 0.80, 0.01], [xr + 0.30, 0.80, 0.01], [xr + 0.32, yRR, 0.01], [xr + 0.28, 0.545, 0.02], [xr + 0.05, 0.545, 0.02]])
      ))
    };

    var top = {
      body: sym([
        [xf, 0, 0], [xf - 0.02, 0.62, 0.20], [xf - 0.16, 0.90, 0.10], [a + 0.54, 0.95, 0.05],
        [a + 0.49, hw, 0.06], [a - 0.49, hw, 0.06], [a - 0.56, 0.94, 0.04],
        [-a + 0.56, 0.945, 0.04], [-a + 0.49, hw, 0.06], [-a - 0.49, hw, 0.06], [-a - 0.56, 0.945, 0.04],
        [xr, 0.93, 0.04], [xr, 0, 0]
      ], 1),
      greenhouse: sym([[1.19, 0, 0], [1.17, 0.86, 0.06], [0.40, 0.80, 0.08], [-0.91, 0.80, 0.06], [-1.00, 0.84, 0.03], [-1.00, 0, 0]], 1),
      hood: sym([[xf - 0.12, 0, 0], [xf - 0.14, 0.80, 0.10], [1.20, 0.86, 0.04], [1.20, 0, 0]], 1),
      roof: sym([[0.38, 0, 0], [0.38, 0.72, 0.08], [-0.90, 0.73, 0.06], [-0.90, 0, 0]], 1),
      deck: sym([[-1.09, 0, 0], [-1.09, 0.79, 0.02], [xr + 0.06, 0.79, 0.02], [xr + 0.06, 0, 0]], 1),
      mirrors: split2(closedP([[1.10, 0.86, 0.01], [1.10, 1.10, 0.03], [1.00, 1.12, 0.03], [0.88, 1.10, 0.03], [0.92, 0.88, 0.02]]), 1)
    };

    var front = {
      // wide cab (roof ~1.46 m), body sides at 0.95, black flares out to the published 80.1 in
      body: sym([
        [0, H, 0], [0.73, H - 0.01, 0.06], [0.80, 1.86, 0.04], [0.89, 1.42, 0.02], [0.94, 1.40, 0.02],
        [0.95, 1.33, 0.03], [0.95, 1.045, 0.01], [hw, 1.03, 0.015], [hw, 0.86, 0.015], [0.95, 0.84, 0.01],
        [0.955, 0.70, 0.03], [0.945, 0.58, 0.05], [0.75, 0.48, 0.06], [0, 0.46, 0]
      ], 0),
      greenhouse: sym([[0, 1.89, 0], [0.70, 1.88, 0.06], [0.86, 1.43, 0.03], [0, 1.42, 0]], 0),
      bumper: { paint: 'black', path: sym([[0, 0.62, 0], [0.56, 0.62, 0.03], [0.72, 0.74, 0.03], [0.955, 0.76, 0.03], [0.945, 0.58, 0.05], [0.75, 0.48, 0.06], [0, 0.46, 0]], 0) },  // raised for the 33.8 deg approach angle
      // huge near-rectangular hexagon grille whose upper corners run out under the slim lamps
      grille: [
        sym([[0, 1.20, 0], [0.60, 1.20, 0.01], [0.74, 1.10, 0.02], [0.72, 0.74, 0.02], [0.56, 0.62, 0.02], [0, 0.62, 0]], 0),
        sym([[0, 1.175, 0], [0.59, 1.175, 0.01], [0.715, 1.09, 0.01], [0.695, 0.75, 0.01], [0.55, 0.645, 0.01], [0, 0.645, 0]], 0)
      ],
      intakes: pair(closedP([[0.79, 0.95, 0.01], [0.93, 0.93, 0.02], [0.935, 0.78, 0.02], [0.77, 0.78, 0.01]])),
      // thin horizontal lamp slashes tilting up at the outer end
      headlights: pair(closedP([[0.60, 1.21, 0.01], [0.95, 1.25, 0.015], [0.97, 1.19, 0.015], [0.66, 1.15, 0.01]])),
      drl: pair(closedP([[0.62, 1.205, 0], [0.94, 1.24, 0.008], [0.945, 1.226, 0.005], [0.63, 1.192, 0]])),
      fogLights: pair(rect(0.835, 0.56, 0.885, 0.72, 0.01)),                                                        // Rigid vertical LED bars
      splitter: { paint: 'black', path: sym([[0, 0.53, 0], [0.42, 0.53, 0.01], [0.38, 0.465, 0.01], [0, 0.46, 0]], 0) },  // TRD skid plate
      plateArea: rect(-0.155, 0.466, 0.155, 0.616, 0.008),
      badgeArea: rect(-0.36, 1.07, 0.36, 1.16, 0.01),                                                              // big TOYOTA heritage lettering (~0.70 m span)
      badgeText: 'TOYOTA'
    };

    var rear = {
      body: sym([
        [0, H, 0], [0.73, H - 0.01, 0.06], [0.80, 1.86, 0.04], [0.89, 1.44, 0.02], [0.94, 1.42, 0.02],
        [0.95, 1.33, 0.02], [0.95, 1.045, 0.01], [hw, 1.03, 0.015], [hw, 0.86, 0.015], [0.95, 0.84, 0.01],
        [0.955, 0.70, 0.03], [0.94, 0.58, 0.04], [0.80, 0.54, 0.05], [0, 0.54, 0]
      ], 0),
      greenhouse: sym([[0, 1.86, 0], [0.70, 1.85, 0.05], [0.78, 1.45, 0.03], [0, 1.44, 0]], 0),
      bumper: { paint: 'black', path: sym([[0, 0.80, 0], [0.94, 0.80, 0.03], [0.965, 0.70, 0.03], [0.94, 0.58, 0.04], [0.80, 0.535, 0.05], [0, 0.535, 0]], 0) },
      // tall lamps with an inboard notch (stepped inner edge)
      taillights: pair(closedP([[0.78, 1.29, 0.01], [0.94, 1.29, 0.02], [0.95, 1.22, 0.02], [0.945, 0.86, 0.02], [0.84, 0.86, 0.01],
        [0.84, 1.02, 0.005], [0.80, 1.06, 0.005], [0.78, 1.06, 0.005]])),
      // two long horizontal LED blades across the top plus a vertical outer stroke
      // three stacked horizontal LED blades (4th-gen signature) plus a vertical outer stroke
      lightBar: pair(cat(rect(0.80, 1.24, 0.925, 1.265, 0.005), rect(0.80, 1.188, 0.925, 1.213, 0.005), rect(0.80, 1.135, 0.925, 1.16, 0.005),
        rect(0.90, 0.90, 0.925, 1.135, 0.004))),
      diffuser: rect(-0.12, 0.49, 0.12, 0.57, 0.01),
      exhaust: [{ shape: 'hidden', cx: 0.55, cy: 0.40, w: 0.08, h: 0.08 }],                                       // exits ahead of right rear wheel
      plateArea: rect(-0.155, 0.62, 0.155, 0.772, 0.008),
      badgeArea: rect(-0.62, 1.10, 0.62, 1.22, 0.01),                                                              // big stamped TACOMA across the tailgate
      badgeText: 'TACOMA',
      panelLines: [rect(-0.775, 0.82, 0.775, 1.29, 0.015)]
    };

    var details = [
      { view: 'side', role: 'mirror', paint: 'black', path: closedP([[0.90, 1.43, 0.02], [1.12, 1.435, 0.03], [1.10, 1.65, 0.04], [0.91, 1.66, 0.03]]) },
      { view: 'side', role: 'handle', paint: 'black', path: rect(0.16, 1.26, 0.33, 1.30, 0.018) },
      { view: 'side', role: 'handle', paint: 'black', path: rect(-0.70, 1.265, -0.53, 1.305, 0.018) },
      { view: 'side', role: 'headlight', paint: 'light', path: closedP([[xf - 0.13, 1.15, 0.01], [xf - 0.025, 1.17, 0.01], [xf - 0.022, 1.235, 0.01], [xf - 0.12, 1.25, 0.01]]) },
      { view: 'side', role: 'marker', paint: 'light-amber', path: rect(xf - 0.12, 0.74, xf - 0.02, 0.775, 0.01) },
      { view: 'side', role: 'taillight', paint: 'light-red', path: rect(xr, 0.88, xr + 0.04, 1.25, 0.008) },
      { view: 'side', role: 'trim', paint: 'black', path: rect(-a - 0.75, 0.58, -a - 0.58, 0.64, 0.01) },
      { view: 'side', role: 'badgeText', text: 'TRD PRO', paint: 'black', path: stencil('TRD PRO', -2.30, 1.03, 0.07, 1.25) },  // bed-side decal (letters only)
      { view: 'side', role: 'antenna', paint: 'black', path: closedP([[-0.58, H - 0.012, 0], [-0.80, H - 0.016, 0], [-0.788, H + 0.048, 0.012], [-0.735, H + 0.056, 0.03]]) },  // shark-fin antenna
      { view: 'side', role: 'spoiler', paint: 'black', path: closedP([[-0.93, H - 0.021, 0], [-1.02, H - 0.015, 0.006], [-1.03, H - 0.045, 0.006], [-0.995, H - 0.05, 0]]) },  // integrated roof spoiler
      { view: 'side', role: 'spoiler', paint: 'black', path: rect(xr - 0.005, 1.255, xr + 0.05, 1.285, 0.006) },            // tailgate spoiler lip
      { view: 'side', role: 'vent', paint: 'black', path: rect(xf - 0.10, 0.62, xf - 0.03, 0.84, 0.01) },                 // functional air guide (bumper corner)
      { view: 'front', role: 'vent', paint: 'black', path: both(rect(0.90, 0.62, 0.95, 0.84, 0.008)) },                  // air guides at the bumper corners
      { view: 'rear', role: 'spoiler', paint: 'black', path: rect(-0.78, 1.27, 0.78, 1.30, 0.008) },                    // tailgate spoiler lip
      { view: 'rear', role: 'spoiler', paint: 'black', path: rect(-0.72, H - 0.04, 0.72, H - 0.01, 0.01) },              // roof spoiler over the backlight
      { view: 'top', role: 'scoop', paint: 'body', path: sym([[2.36, 0, 0], [2.32, 0.30, 0.2], [1.40, 0.36, 0.1], [1.30, 0, 0]], 1) },
      { view: 'top', role: 'wiper', paint: 'black', path: both(rect(1.20, 0.05, 1.24, 0.58, 0.01), 1) },
      { view: 'top', role: 'trim', paint: 'black', path: both(rect(-1.09, 0.80, xr + 0.04, 0.92, 0.01), 1) },
      { view: 'top', role: 'bedFloor', paint: 'black', path: rect(xr + 0.08, -0.77, -1.11, 0.77, 0.02) },            // composite bed
      { view: 'front', role: 'mirror', paint: 'black', path: both(closedP([[0.83, 1.40, 0.01], [1.10, 1.41, 0.03], [1.12, 1.63, 0.03], [0.93, 1.64, 0.03], [0.90, 1.47, 0.02], [0.83, 1.45, 0.01]])) },
      { view: 'front', role: 'wiper', paint: 'black', path: rect(-0.66, 1.42, 0.66, 1.435, 0.005) },
      { view: 'front', role: 'trim', paint: 'black', path: both(closedP([[0.95, 1.045, 0], [hw, 1.03, 0.01], [hw, 0.86, 0.01], [0.95, 0.84, 0]])) },  // flares
      { view: 'front', role: 'trim', paint: 'black', path: both(rect(0.46, 0.49, 0.56, 0.545, 0.015)) },                                                    // tow hooks
      { view: 'rear', role: 'handle', paint: 'black', path: rect(-0.11, 1.232, 0.11, 1.274, 0.015) },
      { view: 'rear', role: 'mirror', paint: 'black', path: both(closedP([[0.83, 1.40, 0.01], [1.10, 1.41, 0.03], [1.12, 1.63, 0.03], [0.93, 1.64, 0.03], [0.90, 1.47, 0.02], [0.83, 1.45, 0.01]])) },
      { view: 'rear', role: 'step', paint: 'black', path: rect(-0.20, 0.785, 0.20, 0.80, 0.005) },
      { view: 'rear', role: 'trim', paint: 'black', path: both(closedP([[0.95, 1.045, 0], [hw, 1.03, 0.01], [hw, 0.86, 0.01], [0.95, 0.84, 0]])) },   // flares
      { view: 'rear', role: 'light', paint: 'light-red', path: rect(-0.18, 1.86, 0.18, 1.875, 0.004) }               // high-mount stop lamp
    ];

    var model = {
      id: 'toyota-tacoma-trdpro-2024', make: 'Toyota', name: 'Tacoma TRD Pro', gen: '4th gen (N400)', years: '2024–',
      look: { head: 'slim-led', tail: 'vertical', grille: 'bar' },   // renderer lamp / grille signature
      style: 'pickup', color: '#b0643a', colorName: 'Terra', enginePosition: 'front', drivetrain: '4wd', powertrain: 'hybrid',
      ref: {
        length: L, width: W, height: H, wheelbase: wb, trackF: 68.8 * IN, trackR: 68.8 * IN,
        frontOverhang: FO, rearOverhang: RO, wheelDiameter_in: 18, tireF: 'LT265/70R18', tireR: 'LT265/70R18',
        groundClearance: 9.5 * IN, rideHeight: 9.5 * IN, cd: 0.47, curbWeight_kg: 2345,
        approach_deg: 33.8, departure_deg: 25.7, cdNote: 'estimate (Toyota publishes none)'
      },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Thin horizontal LED slashes tilting up at the outer end, sitting on the upper corners of the grille',
        taillights: 'Tall vertical lamps with an inboard notch, two horizontal LED blades and a vertical outer stroke',
        grille: 'Huge near-rectangular hexagon black mesh grille spanning the face, big TOYOTA heritage lettering, vertical corner vents',
        notes: 'Squared flares over 33-inch all-terrains, TRD skid plate and Rigid fog lamps, stamped TACOMA tailgate, shoulder crease running headlamp to taillamp'
      }
    };
    model.sections = truckSections(model, {
      xCowl: 1.18, xA: 0.40, xCab: -1.01, xBedF: -1.04, xTg: xr + 0.06, rail: 1.30, floor: 0.90, belt: 1.44,
      zBody: 0.95, zBeltG: 0.89, zGlassTop: 0.80, zRoof: 0.73, flares: [flareF, flareR], wellR: 0.475,
      backWin: { xTop: -0.955, xBot: -0.995, y0: 1.47, y1: 1.83, z: 0.66 },     // rear power slider, ~7 deg rake
      face: { x: xf - 0.036, y: 0.86 },                                         // recessed grille plane; the bumper stands proud
      grille: { x0: xf - 0.07, x1: xf, z: 0.74, y0: 0.62, y1: 1.20 },
      bumperF: { x: a + 0.55, y: 0.66, xAll: xf - 0.034 }, bumperR: { x: xr + 0.32, y: 0.80 },
      dome: function (x, z) { return 0.02 * smooth((x - 1.35) / 0.25) * smooth((2.40 - x) / 0.2) * (1 - smooth((z - 0.30) / 0.1)); }
    });
    return model;
  }

  /* ==================================================================================
     3. TESLA CYBERTRUCK — 2024, AWD, 20" wheels with all-terrain tires
     ================================================================================== */
  function cybertruck() {
    var IN = 0.0254;
    var wb = 143.1 * IN, a = wb / 2, L = 223.7 * IN, W = 80.0 * IN, H = 70.5 * IN;
    var FO = 0.990, RO = L - wb - FO, xf = a + FO, xr = -a - RO;
    var tireD = 20 * IN + 2 * 0.285 * 0.65, R = tireD / 2;    // 285/65R20 ≈ 34.6"
    var hw = W / 2;
    // the single "Cyber" profile: nose → roof apex → tail, all straight lines
    var nose = [xf, 1.10], apex = [0.12, H], tail = [xr, 1.30];
    function yMain(x) { return x >= apex[0] ? nose[1] + (nose[0] - x) * (apex[1] - nose[1]) / (nose[0] - apex[0]) : tail[1] + (x - tail[0]) * (apex[1] - tail[1]) / (apex[0] - tail[0]); }
    function xFront(y) { return nose[0] - (y - nose[1]) * (nose[0] - apex[0]) / (apex[1] - nose[1]); }
    var belt = 1.345, yE = 0.56;
    // hexagonal arch (rear half, relative to the wheel centre): vertical lip, steep facet, flat top
    var hex = [[-0.58, yE - R, 0], [-0.58, 0.66 - R, 0.005], [-0.36, 1.00 - R, 0.005]];
    var hexO = [[-0.66, yE - R, 0], [-0.66, 0.70 - R, 0.005], [-0.40, 1.08 - R, 0.005]];
    var gx = xFront(belt + 0.05);
    /* rocker cladding between the arches: top at 0.74 with 45-degree ends meeting the flare lips */
    function clad(x0, x1) { return closedP([[x0, yE, 0], [x1, yE, 0], [x1, 0.70, 0], [x1 - 0.04, 0.74, 0], [x0 + 0.04, 0.74, 0], [x0, 0.70, 0]]); }

    var side = {
      body: closedP([
        [xf - 0.22, 0.52, 0],
        [xf - 0.05, 0.80, 0.005],
        [nose[0], nose[1], 0.01],
        [apex[0], apex[1], 0.03],
        [tail[0], tail[1], 0.005],
        [xr, 0.84, 0.005],
        [xr + 0.20, yE, 0],
        [-a - 0.62, yE, 0]
      ].concat(polyArch(-a, R, hex), [
        [a - 0.62, yE, 0]
      ], polyArch(a, R, hex))),
      greenhouse: closedP([[xFront(belt - 0.015), belt - 0.015, 0], [apex[0], H - 0.012, 0.01], [-1.03, yMain(-1.03) - 0.015, 0], [-1.13, belt - 0.015, 0]]),
      windows: [
        closedP([[gx, belt, 0], [0.14, yMain(0.14) - 0.05, 0.005], [0.14, belt, 0]]),
        closedP([[0.06, belt, 0], [0.06, yMain(0.06) - 0.05, 0.005], [-1.00, yMain(-1.00) - 0.05, 0.005], [-1.09, belt, 0]])
      ],
      pillars: [rect(0.06, belt, 0.14, yMain(0.10) - 0.03, 0.002)],
      doorCuts: [
        closedP([[1.22, 0.60, 0.01], [1.22, belt - 0.01, 0], [xFront(belt - 0.01 + 0.006), belt - 0.01, 0], [0.10, yMain(0.10) - 0.008, 0], [0.10, 0.60, 0.01]]),
        closedP([[0.08, 0.60, 0.01], [0.08, yMain(0.08) - 0.008, 0], [-1.06, yMain(-1.06) - 0.008, 0], [-1.15, belt - 0.03, 0], [-1.15, 0.60, 0.01]])
      ],
      panelLines: [
        lineP([[xf - 0.02, 1.085], [1.78, yMain(1.78) - 0.015]]),                         // frunk lid edge
        lineP([[-1.20, yMain(-1.20) - 0.004], [xr + 0.02, tail[1] - 0.004]]),             // vault tonneau edge
        lineP([[-1.20, 0.72], [-1.20, yMain(-1.20) - 0.004]]),                            // cab / bed seam
        lineP([[xr + 0.03, 0.86], [xr + 0.03, 1.29]]),                                    // tailgate
        rect(-1.62, 1.08, -1.42, 1.20, 0.004)                                             // charge-port door
      ],
      characterLines: [
        lineP([[nose[0], nose[1]], [apex[0], apex[1]], [tail[0], tail[1]]]),              // the defining crease
        lineP([[a + 0.70, 0.74], [xf - 0.19, 0.74]]),                                     // top of the cladding (front)
        lineP([[a - 0.70, 0.74], [-a + 0.70, 0.74]]),                                     // rocker cladding top
        lineP([[-a - 0.70, 0.74], [xr + 0.16, 0.74]])
      ],
      sill: clad(-a + 0.66, a - 0.66),
      archF: { x: a, y: R, r: 0.50, flare: 0.08, shape: 'hexagonal' },          // dark well radius (body opening is the 0.58 hexagon)
      archR: { x: -a, y: R, r: 0.50, flare: 0.08, shape: 'hexagonal' },
      lowerTrim: ccw(cat(
        polyFlare(a, R, hex, hexO), polyFlare(-a, R, hex, hexO),
        clad(-a + 0.66, a - 0.66),
        // front / rear cladding: 0.74 top, 45-degree cuts at both ends
        closedP([[a + 0.66, yE, 0], [xf - 0.22, 0.52, 0], [xf - 0.1256, 0.6756, 0], [xf - 0.19, 0.74, 0], [a + 0.70, 0.74, 0], [a + 0.66, 0.70, 0]]),
        closedP([[xr + 0.20, yE, 0], [-a - 0.66, yE, 0], [-a - 0.66, 0.70, 0], [-a - 0.70, 0.74, 0], [xr + 0.16, 0.74, 0], [xr + 0.108, 0.688, 0]])
      ))
    };

    var top = {
      body: sym([
        [xf, 0, 0], [xf, 0.82, 0.005], [xf - 0.18, 0.995, 0.005], [a + 0.66, 1.00, 0],
        [a + 0.62, hw, 0], [a - 0.62, hw, 0], [a - 0.66, 1.00, 0],
        [-a + 0.66, 1.00, 0], [-a + 0.62, hw, 0], [-a - 0.62, hw, 0], [-a - 0.66, 1.00, 0],
        [xr + 0.03, 1.00, 0.005], [xr, 0.97, 0.005], [xr, 0, 0]
      ], 1),
      greenhouse: sym([[1.76, 0, 0], [1.76, 0.86, 0.005], [0.12, 0.64, 0.005], [-1.03, 0.72, 0.005], [-1.03, 0, 0]], 1),
      hood: sym([[xf - 0.03, 0, 0], [xf - 0.03, 0.80, 0.005], [xf - 0.20, 0.96, 0.005], [1.79, 0.93, 0.005], [1.79, 0, 0]], 1),
      roof: { paint: 'glass', path: sym([[1.76, 0, 0], [1.76, 0.80, 0.005], [0.12, 0.62, 0.005], [-1.03, 0.70, 0.005], [-1.03, 0, 0]], 1) },  // full glass roof, windscreen to backlight
      deck: sym([[-1.20, 0, 0], [-1.20, 0.93, 0.005], [xr + 0.04, 0.95, 0.005], [xr + 0.04, 0, 0]], 1),   // vault tonneau
      mirrors: split2(closedP([[1.52, 0.96, 0.005], [1.52, 1.10, 0.01], [1.38, 1.11, 0.01], [1.36, 0.98, 0.005]]), 1)
    };

    var front = {
      body: sym([
        [0, H, 0], [0.60, H, 0.005], [0.80, 1.62, 0.005], [0.94, 1.33, 0.005], [hw, 1.20, 0.005],
        [hw, 0.62, 0.005], [0.96, 0.50, 0.005], [0, 0.48, 0]
      ], 0),
      greenhouse: sym([[0, H - 0.016, 0], [0.62, H - 0.02, 0.005], [0.865, 1.375, 0.005], [0, 1.375, 0]], 0),
      bumper: { paint: 'black', path: sym([[0, 0.80, 0], [0.98, 0.80, 0.005], [hw, 0.74, 0.005], [hw, 0.62, 0.005], [0.96, 0.50, 0.005], [0, 0.48, 0]], 0) },  // black cladding bumper
      grille: [],
      intakes: [sym([[0, 0.665, 0], [0.46, 0.665, 0.005], [0.44, 0.61, 0.005], [0, 0.61, 0]], 0)],
      headlights: pair(rect(0.72, 1.078, 1.00, 1.100, 0.002)),
      drl: [rect(-1.00, 1.082, 1.00, 1.096, 0.001)],                                                     // full-width 14 mm light bar, corner to corner
      plateArea: rect(-0.155, 0.672, 0.155, 0.785, 0.004),
      badgeArea: null,                                                                                     // production truck carries no front badge
      badgeText: ''
    };

    var rear = {
      body: sym([
        [0, H, 0], [0.60, H, 0.005], [0.80, 1.62, 0.005], [0.94, 1.33, 0.005], [hw, 1.30, 0.005],
        [hw, 0.62, 0.005], [0.96, 0.52, 0.005], [0, 0.50, 0]
      ], 0),
      greenhouse: sym([[0, 1.725, 0], [0.58, 1.72, 0.005], [0.66, 1.55, 0.005], [0, 1.55, 0]], 0),
      bumper: { paint: 'black', path: sym([[0, 0.84, 0], [0.99, 0.84, 0.005], [hw, 0.76, 0.005], [hw, 0.62, 0.005], [0.96, 0.52, 0.005], [0, 0.50, 0]], 0) },
      taillights: pair(rect(0.80, 1.261, 1.00, 1.279, 0.002)),
      lightBar: rect(-1.00, 1.263, 1.00, 1.277, 0.001),                                                    // full-width 14 mm red light bar
      diffuser: sym([[0, 0.60, 0], [0.55, 0.60, 0.005], [0.50, 0.52, 0.005], [0, 0.51, 0]], 0),
      exhaust: [],
      plateArea: rect(-0.155, 0.632, 0.155, 0.784, 0.004),
      badgeArea: rect(-0.52, 1.10, 0.52, 1.20, 0.004),                                                    // TESLA lettering across the tailgate
      badgeText: 'TESLA',
      panelLines: [rect(-0.985, 0.86, 0.985, 1.295, 0.003)]
    };

    var details = [
      { view: 'side', role: 'mirror', paint: 'body', path: closedP([[1.36, 1.30, 0.005], [1.52, 1.305, 0.008], [1.505, 1.40, 0.008], [1.375, 1.40, 0.005]]) },  // straddles the beltline
      { view: 'side', role: 'mirrorArm', paint: 'black', path: rect(1.40, 1.30, 1.45, 1.34, 0.004) },                                                                  // mirror stalk
      { view: 'side', role: 'headlight', paint: 'light', path: closedP([[xf - 0.035, 1.07, 0], [xf, 1.07, 0], [xf, 1.10, 0], [xf - 0.035, 1.109, 0]]) },
      { view: 'side', role: 'taillight', paint: 'light-red', path: rect(xr, 1.25, xr + 0.03, 1.295, 0.002) },
      { view: 'side', role: 'chargePort', paint: 'body', path: rect(-1.60, 1.10, -1.44, 1.18, 0.004) },
      { view: 'side', role: 'wiper', paint: 'black', path: lineP([[1.75, yMain(1.75) + 0.005], [1.05, yMain(1.05) + 0.004]]) },
      { view: 'side', role: 'trim', paint: 'black', path: rect(xr + 0.03, 0.84, xr + 0.12, 0.86, 0) },
      { view: 'top', role: 'wiper', paint: 'black', path: closedP([[1.74, -0.80, 0], [1.76, -0.80, 0], [1.76, 0.78, 0], [1.74, 0.78, 0]]) },
      { view: 'top', role: 'light', paint: 'light', path: rect(xf - 0.015, -0.975, xf, 0.975, 0) },
      { view: 'top', role: 'light', paint: 'light-red', path: rect(xr, -0.985, xr + 0.015, 0.985, 0) },
      { view: 'top', role: 'tonneau', paint: 'black', path: rect(-2.85, -0.96, -1.13, 0.96, 0.004) },       // matte-black slatted vault tonneau
      { view: 'top', role: 'trim', paint: 'gloss-black', path: rect(xr + 0.04, -0.005, -1.20, 0.005, 0) },        // vault slat seam (centre)
      { view: 'front', role: 'mirrorArm', paint: 'black', path: both(rect(0.93, 1.335, 0.995, 1.365, 0.003)) },       // mirror stalk from the body
      { view: 'front', role: 'mirror', paint: 'body', path: both(closedP([[0.99, 1.30, 0.005], [1.10, 1.305, 0.005], [1.11, 1.40, 0.005], [0.995, 1.40, 0.005]])) },
      { view: 'front', role: 'wiper', paint: 'black', path: rect(-0.80, 1.385, 0.80, 1.398, 0.003) },        // single huge wiper
      { view: 'front', role: 'trim', paint: 'black', path: lineP([[-0.98, 0.80], [0.98, 0.80]]) },
      { view: 'rear', role: 'mirrorArm', paint: 'black', path: both(rect(0.93, 1.335, 0.995, 1.365, 0.003)) },
      { view: 'rear', role: 'mirror', paint: 'body', path: both(closedP([[0.99, 1.30, 0.005], [1.10, 1.305, 0.005], [1.11, 1.40, 0.005], [0.995, 1.40, 0.005]])) },
      { view: 'rear', role: 'trim', paint: 'black', path: closedP([[-0.985, 1.30, 0], [-0.66, 1.55, 0], [0.66, 1.55, 0], [0.985, 1.30, 0]]) },   // matte-black vault tonneau / sail facets
      { view: 'rear', role: 'trim', paint: 'gloss-black', path: cat(rect(-0.30, 1.30, -0.29, 1.55), rect(0.29, 1.30, 0.30, 1.55)) },      // tonneau slat seams (10 mm)
      { view: 'side', role: 'camera', paint: 'black', path: rect(1.62, 1.02, 1.70, 1.045, 0.005) },                  // fender repeater camera
      { view: 'side', role: 'trim', paint: 'black', path: lineP([[a + 0.66, yE + 0.01], [a + 0.66, 0.69]]) },        // cladding facet seams
      { view: 'side', role: 'trim', paint: 'black', path: lineP([[-a - 0.66, yE + 0.01], [-a - 0.66, 0.69]]) },
      { view: 'side', role: 'outlet', paint: 'black', path: rect(-1.95, 1.02, -1.86, 1.08, 0.004) },                 // bed power outlet
      { view: 'top', role: 'trim', paint: 'gloss-black', path: cat(rect(xr + 0.04, -0.505, -1.20, -0.495, 0), rect(xr + 0.04, 0.495, -1.20, 0.505, 0)) },  // tonneau slats
      { view: 'top', role: 'trim', paint: 'body', path: rect(0.09, -0.62, 0.15, 0.62, 0) },                    // stainless roof strip at the apex
      { view: 'top', role: 'trim', paint: 'black', path: lineP([[xf - 0.03, 0], [1.79, 0]]) },                        // frunk seam
      { view: 'front', role: 'trim', paint: 'black', path: both(rect(0.52, 0.555, 0.60, 0.605, 0.01)) },            // tow points
      { view: 'front', role: 'camera', paint: 'black', path: rect(-0.03, 0.81, 0.03, 0.83, 0.005) },                 // front camera
      { view: 'rear', role: 'camera', paint: 'black', path: rect(-0.03, 0.80, 0.03, 0.82, 0.005) },                  // rear camera
      { view: 'rear', role: 'step', paint: 'black', path: both(rect(0.60, 0.835, 0.90, 0.855, 0.005)) }
    ];

    var model = {
      id: 'tesla-cybertruck', make: 'Tesla', name: 'Cybertruck', gen: '1st gen', years: '2023–',
      look: { head: 'blade', tail: 'light-bar', grille: 'blanked' },   // renderer lamp / grille signature
      style: 'pickup', color: '#b9bcbe', colorName: 'Stainless steel (unpainted)', enginePosition: 'front', drivetrain: 'awd', powertrain: 'ev',
      ref: {
        length: L, width: W, height: H, wheelbase: wb, trackF: 1.735, trackR: 1.735,
        frontOverhang: FO, rearOverhang: RO, wheelDiameter_in: 20, tireF: '285/65R20', tireR: '285/65R20',
        groundClearance: 12.0 * IN, rideHeight: 12.0 * IN, cd: 0.39, curbWeight_kg: 2995,
        widthWithMirrors: 86.6 * IN, maxGroundClearance: 17.4 * IN, cdNote: 'estimate (Tesla publishes none)'
      },
      side: side, top: top, front: front, rear: rear, details: details,
      signature: {
        headlights: 'Single full-width LED light bar across the nose; headlamp modules in its outer ends',
        taillights: 'Full-width red light bar across the top of the tailgate',
        grille: 'None — flat stainless nose, small black lower slot in the cladding bumper',
        notes: 'Unpainted stainless exoskeleton; one straight crease from nose to roof apex to tail, hexagonal black-clad arches, single giant wiper, vault tonneau'
      }
    };
    model.sections = cyberSections(model, { yTop: yMain, xGlassF: gx, xWs: 1.785, xGlassR: -1.10, xVault: -1.13, tail: tail });
    return model;
  }

  var MODELS = [raptor(), tacoma(), cybertruck()];
  MODELS.forEach(register);

  if (typeof module !== 'undefined' && module.exports) module.exports = { models: MODELS, _helpers: { rp: rp, sym: sym, mirror: mirror } };
})();

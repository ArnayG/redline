/* FORGE Atelier — real-car shape library: body style 'van'.
   Models: Mercedes-Benz Sprinter (VS30, 144" WB high roof), Volkswagen ID. Buzz (SWB),
   Ford Transit (148" WB high roof, 2020+ facelift).
   Coordinates in metres at the real vehicle's published dimensions.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y) seen from the right-hand side; top = (x, z); front & rear = (z, y).
   Brand names are text only; no manufacturer logo artwork is drawn (badgeArea marks the spot). */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ helpers */
  function r5(v) { return Math.round(v * 100000) / 100000; }
  function P2(a, b) { return [r5(a), r5(b)]; }
  function M(a, b) { return { t: 'M', p: [P2(a, b)] }; }
  function L(a, b) { return { t: 'L', p: [P2(a, b)] }; }
  function C3(c1, c2, p) { return { t: 'C', p: [P2(c1[0], c1[1]), P2(c2[0], c2[1]), P2(p[0], p[1])] }; }
  function Z() { return { t: 'Z', p: [] }; }
  var DEG = Math.PI / 180;

  /* Smooth G1 spline through points. A point [x, y, 1] is a hard corner.
     Tangent at a smooth point is parallel to (next - prev); handle length = chord / 3. */
  function splineSegs(pts, closed) {
    var n = pts.length, segs = [];
    function P(i) { return closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]; }
    function tan(i) {
      var p = P(i);
      if (p[2] || (!closed && (i <= 0 || i >= n - 1))) return null;
      var a = P(i - 1), b = P(i + 1), dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    }
    var last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var p0 = P(i), p1 = P(i + 1), t0 = tan(i), t1 = tan(i + 1);
      if (!t0 && !t1) { segs.push(L(p1[0], p1[1])); continue; }
      var d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 3;
      var c1 = t0 ? [p0[0] + t0[0] * d, p0[1] + t0[1] * d] : [p0[0] + (p1[0] - p0[0]) / 3, p0[1] + (p1[1] - p0[1]) / 3];
      var c2 = t1 ? [p1[0] - t1[0] * d, p1[1] - t1[1] * d] : [p1[0] - (p1[0] - p0[0]) / 3, p1[1] - (p1[1] - p0[1]) / 3];
      segs.push(C3(c1, c2, p1));
    }
    return segs;
  }
  function S(pts) { return [M(pts[0][0], pts[0][1])].concat(splineSegs(pts, false)); }        // open spline
  function SC(pts) { return [M(pts[0][0], pts[0][1])].concat(splineSegs(pts, true), [Z()]); } // closed spline
  /* sub-range [i0, i1] of an open spline — identical curves to S(pts) over that range */
  function Ssub(pts, i0, i1) { return [M(pts[i0][0], pts[i0][1])].concat(splineSegs(pts, false).slice(i0, i1)); }
  function poly(pts, closed) {
    var s = [M(pts[0][0], pts[0][1])];
    for (var i = 1; i < pts.length; i++) s.push(L(pts[i][0], pts[i][1]));
    if (closed) s.push(Z());
    return s;
  }
  /* Mirror-symmetric closed outline. `half` runs from the centreline (coord[ax] = 0) round the
     positive side back to the centreline. ax = 0 for front/rear views (z, y), ax = 1 for top (x, z). */
  function sym(half, ax) {
    var back = half.slice(1, -1).reverse().map(function (p) { var q = p.slice(); q[ax] = -q[ax]; return q; });
    return SC(half.concat(back));
  }
  function mir(path, ax) {
    return path.map(function (s) {
      return { t: s.t, p: s.p.map(function (q) { var r = q.slice(); r[ax] = r5(-r[ax]); return r; }) };
    });
  }
  function pair(path, ax) { return [path, mir(path, ax)]; }
  /* circular arc segments (no moveto) from angle a0 to a1 (degrees, CCW positive) */
  function arc(cx, cy, r, a0, a1) {
    var n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 60)), da = (a1 - a0) / n * DEG, out = [];
    var k = 4 / 3 * Math.tan(da / 4);
    for (var i = 0; i < n; i++) {
      var t0 = a0 * DEG + da * i, t1 = t0 + da;
      var x0 = cx + r * Math.cos(t0), y0 = cy + r * Math.sin(t0), x1 = cx + r * Math.cos(t1), y1 = cy + r * Math.sin(t1);
      out.push(C3([x0 - k * r * Math.sin(t0), y0 + k * r * Math.cos(t0)], [x1 + k * r * Math.sin(t1), y1 - k * r * Math.cos(t1)], [x1, y1]));
    }
    return out;
  }
  function openArc(cx, cy, r, a0, a1) {
    return [M(cx + r * Math.cos(a0 * DEG), cy + r * Math.sin(a0 * DEG))].concat(arc(cx, cy, r, a0, a1));
  }
  /* continue a path from point (x0,y0) with an arc concentric to (cx,cy) until angle a1 */
  function arcFrom(cx, cy, x0, y0, a1) {
    var r = Math.hypot(x0 - cx, y0 - cy), a0 = Math.atan2(y0 - cy, x0 - cx) / DEG;
    return arc(cx, cy, r, a0, a1);
  }
  function rr(x0, y0, x1, y1, r) {
    var k = 0.5523 * r;
    return [M(x0 + r, y0), L(x1 - r, y0), C3([x1 - r + k, y0], [x1, y0 + r - k], [x1, y0 + r]), L(x1, y1 - r),
      C3([x1, y1 - r + k], [x1 - r + k, y1], [x1 - r, y1]), L(x0 + r, y1), C3([x0 + r - k, y1], [x0, y1 - r + k], [x0, y1 - r]),
      L(x0, y0 + r), C3([x0, y0 + r - k], [x0 + r - k, y0], [x0 + r, y0]), Z()];
  }
  /* rounded rectangle with per-corner radii: r = [x0y0, x1y0, x1y1, x0y1] */
  function rrv(x0, y0, x1, y1, r) {
    var k = 0.5523, a = r[0], b = r[1], c = r[2], d = r[3];
    return [M(x0 + a, y0), L(x1 - b, y0), C3([x1 - b + k * b, y0], [x1, y0 + b - k * b], [x1, y0 + b]), L(x1, y1 - c),
      C3([x1, y1 - c + k * c], [x1 - c + k * c, y1], [x1 - c, y1]), L(x0 + d, y1), C3([x0 + d - k * d, y1], [x0, y1 - d + k * d], [x0, y1 - d]),
      L(x0, y0 + a), C3([x0, y0 + a - k * a], [x0 + a - k * a, y0], [x0 + a, y0]), Z()];
  }
  /* Boxy "squircle" arch-flare outline (Transit): straight flanks rising from the rocker at (cx ± dx0, y0),
     tangent into corner arcs of radius rc, joined by a flat top of length 2·hx at height yTop. Open path. */
  function squircleFlare(cx, y0, dx0, hx, yTop, rc) {
    var ccx = cx + hx, ccy = yTop - rc, px = cx + dx0, py = y0;   // right corner centre, right foot
    var vx = px - ccx, vy = py - ccy, d = Math.hypot(vx, vy);
    var base = Math.atan2(vy, vx), off = Math.acos(rc / d);      // tangent point angle on the corner circle
    var ta = base + off;                                          // the tangent on the outer (lower-right) side
    if (Math.sin(ta) * 0 + Math.cos(ta) < 0) ta = base - off;
    var tx = ccx + rc * Math.cos(ta), ty = ccy + rc * Math.sin(ta), aDeg = ta / DEG;
    var lt = [2 * cx - tx, ty], la = 180 - aDeg;
    var s = [M(2 * cx - px, py), L(lt[0], lt[1])];
    s = s.concat(arc(2 * cx - ccx, ccy, rc, la, 90));
    s.push(L(ccx, yTop));
    s = s.concat(arc(ccx, ccy, rc, 90, aDeg));
    s.push(L(px, py));
    return s;
  }
  function ell(cx, cy, rx, ry) {
    var kx = 0.5523 * rx, ky = 0.5523 * ry;
    return [M(cx + rx, cy), C3([cx + rx, cy + ky], [cx + kx, cy + ry], [cx, cy + ry]), C3([cx - kx, cy + ry], [cx - rx, cy + ky], [cx - rx, cy]),
      C3([cx - rx, cy - ky], [cx - kx, cy - ry], [cx, cy - ry]), C3([cx + kx, cy - ry], [cx + rx, cy - ky], [cx + rx, cy]), Z()];
  }
  function join() { var o = []; for (var i = 0; i < arguments.length; i++) o = o.concat(arguments[i]); return o; }
  /* tyre overall radius (m) from ISO size */
  function tireR(w, ar, rim) { return (rim * 25.4 / 2 + w * ar / 100) / 1000; }
  /* side silhouette: `top` spline from the front-bottom corner over the roof to the rear-bottom corner,
     then the rocker line at height yb with circular wheel-arch cut-outs, closing back to the nose. */
  function sideBody(top, yb, archR, archF) {
    var s = S(top), endX = 0;
    [archR, archF].forEach(function (a) {
      var dy = yb - a.y, dx = Math.sqrt(a.r * a.r - dy * dy);
      s.push(L(a.x - dx, yb));
      s = s.concat(arc(a.x, a.y, a.r, Math.atan2(dy, -dx) / DEG, Math.atan2(dy, dx) / DEG));
      endX = a.x + dx;
    });
    var p0 = top[0], span = p0[0] - endX;
    s.push(C3([endX + span * 0.45, yb], [p0[0] - span * 0.35, p0[1]], [p0[0], p0[1]]));
    s.push(Z());
    return s;
  }
  /* ------------------------------------------------------------ 3D sections
     Explicit van cross-sections (ringHalf: bottom centre → right side → top centre, [y, z]).
     Slab sides stay flat at the plan half-width from the rocker corner (radius lowR) up to the belt,
     the greenhouse leans in per `cap` (inset vs distance below the roof), and the roof edge is a
     circular corner of radius roofR. Stations without side glass (nose, bonnet, tail) are boxes with
     a hoodR top corner. Wheel openings: the floor follows the side-silhouette bottom (arch circle).

     Glass edge alignment: core resamples each half-ring uniformly by arc length, and loftToMesh flags
     glass per vertex (y > belt + 0.02). If the belt sits at a different arc-length fraction from one
     station to the next, the glass edge jumps a whole vertex row (the "stair-stepping"). To keep it
     clean, every glass station gets the same belt fraction f0: a hidden centre-line fin inside the
     body (from the floor straight up at z = 0, invisible from outside) pads the lower arc length.
     With f0 = 0.5 the belt lands exactly on vertex half/2 for any ringVerts divisible by 4. */
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
  /* piecewise-linear lookup; T = [[key, value], ...] sorted by descending key */
  function tab(T, k) {
    if (k >= T[0][0]) return T[0][1];
    for (var i = 1; i < T.length; i++) if (k >= T[i][0]) {
      var t = (k - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * t;
    }
    return T[T.length - 1][1];
  }
  function plen(p) { var l = 0; for (var i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; }
  /* c: { belt: [[x, y]...] desc x, gx: [xRear, xFront] side-glass range, cap: [[dyBelowRoof, inset]...] desc dy,
          roofR, hoodR, lowR, step (DLO inset at the belt), f0 (belt arc fraction), header (windscreen header x),
          hoodRx / roofRx: optional [[x, r]...] desc-x tables overriding hoodR / roofR along the body,
          cowl: span (m) ahead of gx[1] over which the bonnet corner radius blends down to the A-pillar foot,
          shut: [[x, y]...] bonnet shut line — the bonnet crowns from it at the wing up to the centre-line,
          shapeGx: [xRear, xFront] range that keeps the greenhouse cross-section (tumblehome) without side glass,
          dense: [[x0, x1, step]...] extra stations, maxGap: largest station spacing (Gouraud highlights stay smooth),
          rearGlass: { x, y0, y1, hw, r } flat rear-door glass cap (stations behind x are replaced by the cap),
          tailGlass: { x0, x1, y0, y1, hw, step } glass flags on the ring tops of a raked tailgate } */
  function vanSections(side, top, c) {
    var sb = flat(side.body), tb = flat(top.body);
    var minX = Infinity, maxX = -Infinity;
    sb.forEach(function (q) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); });
    var rg = c.rearGlass, tg = c.tailGlass;
    var xs = [], NS = 64;
    for (var k = 0; k <= NS; k++) { var t = k / NS; xs.push(minX + (maxX - minX) * (1 - Math.cos(Math.PI * t)) / 2); }
    [side.archF, side.archR].forEach(function (a) {
      [-1.02, -0.97, -0.85, -0.6, -0.3, 0, 0.3, 0.6, 0.85, 0.97, 1.02].forEach(function (f) { xs.push(a.x + f * a.r); });
    });
    [c.gx[0] + 0.004, c.gx[1] - 0.004].forEach(function (x) { xs.push(x); });
    xs.sort(function (a, b) { return a - b; });
    xs = xs.filter(function (x) { return x > minX + 0.01 && x < maxX - 0.01; })
      .filter(function (x, i, arr) { return i === 0 || x - arr[i - 1] > 0.015; });
    // extra stations: dense runs (cowl, brow, tailgate), then cap the spacing
    var extra = [];
    (c.dense || []).forEach(function (d) { for (var x = d[0]; x <= d[1] + 1e-9; x += d[2]) extra.push(x); });
    if (c.cowl) [1 / 3, 2 / 3, 1].forEach(function (f) { extra.push(c.gx[1] + c.cowl * f); });
    if (tg) for (var xt = tg.x0; xt <= tg.x1 + 1e-9; xt += tg.step) extra.push(xt);
    if (extra.length) {
      xs = xs.filter(function (x) { return extra.every(function (e) { return Math.abs(e - x) > 0.005; }); }).concat(extra)
        .filter(function (x) { return x > minX + 0.01 && x < maxX - 0.01; });
      xs.sort(function (a, b) { return a - b; });
    }
    if (rg) xs = xs.filter(function (x) { return x > rg.x + 0.005; }).concat([rg.x]).sort(function (a, b) { return a - b; });
    var gap = c.maxGap || 0.06, filled = [], isFill = [];
    xs.forEach(function (x, i) {
      if (i) { var d = x - xs[i - 1], n = Math.ceil(d / gap - 1e-9); for (var j = 1; j < n; j++) { filled.push(xs[i - 1] + d * j / n); isFill.push(1); } }
      filled.push(x); isFill.push(extra.some(function (e) { return Math.abs(e - x) < 1e-9; }) ? 1 : 0);
    });
    xs = filled;
    function arcPts(out, cy, cz, r, a0, a1, n) {   // angles in degrees, y = cy + r sin, z = cz + r cos
      for (var i = 1; i <= n; i++) { var a = (a0 + (a1 - a0) * i / n) * DEG; out.push([cy + r * Math.sin(a), cz + r * Math.cos(a)]); }
    }
    var sgx = c.shapeGx || c.gx;
    var st = xs.map(function (x, xi) {
      var s = sliceAt(sb, x), yb = s[0], yt = s[1], hw = sliceAt(tb, x);
      var w = Math.max(hw ? Math.max(Math.abs(hw[0]), Math.abs(hw[1])) : 0.05, 0.04);
      var glassOn = x > c.gx[0] && x < c.gx[1];
      var belt = x > sgx[0] && x < sgx[1] ? tab(c.belt, x) : null;
      if (belt != null && (yt - belt < 0.03 || belt - yb < 0.2)) belt = null;
      if (belt == null) glassOn = false;
      var lr = Math.min(c.lowR, (yt - yb) * 0.25, w * 0.5);
      var p = [[yb, 0], [yb, w - lr]];
      arcPts(p, yb + lr, w - lr, lr, -90, 0, 4);
      var low = 0;
      if (belt != null) {
        p.push([belt, w]); low = plen(p);
        var H = yt - belt, r = Math.min(c.roofRx ? tab(c.roofRx, x) : c.roofR, H * 0.6);
        p.push([belt + 0.004, w - Math.max(c.step, tab(c.cap, H))]);
        c.cap.forEach(function (q) { if (q[0] < H - 0.02 && q[0] > r + 0.02) p.push([yt - q[0], w - tab(c.cap, q[0])]); });
        var zr = w - tab(c.cap, r);
        p.push([yt - r, zr]);
        arcPts(p, yt - r, zr - r, r, 0, 90, 6);
      } else {
        var rh0 = c.hoodRx ? tab(c.hoodRx, x) : c.hoodR;
        // cowl: the bonnet corner radius blends from the greenhouse roofR at the screen base down to hoodR over
        // c.cowl metres (no one-station switch between the box nose and the glasshouse)
        if (c.cowl && x >= c.gx[1] && x < c.gx[1] + c.cowl) {
          var u = (x - c.gx[1]) / c.cowl; u = u * u * (3 - 2 * u);
          var rR = c.roofRx ? tab(c.roofRx, x) : c.roofR;
          rh0 = rR + (rh0 - rR) * u;
        }
        var rh = Math.min(rh0, (yt - yb) * 0.3, w * 0.5);
        var crown = 0;
        if (c.shut && x <= c.shut[0][0] && x >= c.shut[c.shut.length - 1][0]) crown = Math.max(0, Math.min(0.06, yt - tab(c.shut, x)));
        var ys = yt - crown;
        p.push([ys - rh, w]);
        arcPts(p, ys - rh, w - rh, rh, 0, 90, 5);
        if (crown > 0.002) for (var ci = 1; ci <= 4; ci++) { var zc = (w - rh) * (1 - ci / 4); p.push([ys + crown * (1 - (zc / (w - rh)) * (zc / (w - rh))), zc]); }
      }
      if (p[p.length - 1][1] > 1e-6) p.push([yt, 0]);
      return { x: x, extra: !!isFill[xi], p: p, belt: belt, glassOn: glassOn, low: low, tot: plen(p), yb: yb, yt: yt };
    });
    // common belt fraction for the glass stations behind the windscreen
    var f0 = c.f0 || 0.5;
    if (!c.f0) st.forEach(function (o) {      // smallest common fraction reachable behind the windscreen header
      if (o.glassOn && !o.extra && o.x < c.header) f0 = Math.max(f0, o.low / o.tot);   // added stations follow, never lead
    });
    f0 = Math.max(f0, c.fMin || 0);
    st.forEach(function (o) {
      if (o.belt == null) return;
      var need = (f0 * o.tot - o.low) / (1 - f0);               // fin height that puts the belt at fraction f0
      o.fin = Math.max(0, Math.min(need, (o.yt - o.yb) * 0.85));
    });
    // stations without a greenhouse: taper the fin from the nearest greenhouse station so vertex rows slide smoothly
    st.forEach(function (o) {
      if (o.belt != null) return;
      var best = null, bd = Infinity;
      st.forEach(function (q) { if (q.belt != null && Math.abs(q.x - o.x) < bd) { bd = Math.abs(q.x - o.x); best = q; } });
      o.fin = best ? Math.min(best.fin * Math.max(0, 1 - bd / 0.5), (o.yt - o.yb) * 0.85) : 0;
    });
    // windscreen / A-pillar stations whose belt sits above fraction f0 (short upper arc): move the glass threshold
    // down to the point at fraction f0 so the glass edge stays on the same vertex row (no saw-tooth at the A-pillar)
    st.forEach(function (o) {
      o.thr = o.belt;
      if (!o.glassOn || o.low / o.tot <= f0 + 1e-6) return;
      var target = f0 * o.tot, acc = 0;
      for (var i = 1; i < o.p.length; i++) {
        var a = o.p[i - 1], b = o.p[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc + l >= target) { var y = a[0] + (b[0] - a[0]) * (target - acc) / (l || 1); if (o.belt - y < (c.maxDrop || 0.18)) o.thr = y; break; }
        acc += l;
      }
    });
    /* Per-vertex glass flags for the 40-vertex ring shapes-preview lofts with (GLASS_NV) (core uses them only when the expanded ring length
       matches): side glass only between the belt and the top of the window band, so a high-roof cap above the
       DLO stays body-coloured instead of reading as one tall pane. Other ring sizes fall back to the belt. */
    var GLASS_NV = 40, HALF = GLASS_NV / 2;
    function resampleHalf(pts, n) {
      var Ls = [0], tot = 0, out = [], j = 0;
      for (var i = 1; i < pts.length; i++) { tot += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); Ls.push(tot); }
      for (var k = 0; k < n; k++) {
        var d = tot * k / (n - 1);
        while (j < pts.length - 2 && Ls[j + 1] < d) j++;
        var sg = Ls[j + 1] - Ls[j] || 1, t = Math.max(0, Math.min(1, (d - Ls[j]) / sg));
        out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
      }
      return out;
    }
    /* glass = a contiguous run of half-ring vertex indices [iB, iT]. Behind the windscreen header iT is held at
       the median over those stations so the window-band top edge stays on one vertex row (no stair-steps where the
       roof height changes, e.g. the ID. Buzz crown). */
    function glassRun(ring, thr, gTop, NV) {
      var half = NV / 2, h = resampleHalf(ring, half + 1), iB = -1, iT = -1;
      for (var k = 0; k <= half; k++) {
        var q = h[k];
        if (q[1] <= 0.05) { if (iB >= 0) break; continue; }
        if (q[0] > thr + 0.02 && q[0] < gTop + 0.025) { if (iB < 0) iB = k; iT = k; }
        else if (iB >= 0) break;
      }
      return { iB: iB, iT: iT, half: half };
    }
    function mirrorFlags(f) { for (var i = HALF - 1; i >= 1; i--) f.push(f[i]); return f; }
    function runFlags(g) {
      var f = [];
      for (var k = 0; k <= g.half; k++) f.push(g.iB >= 0 && k >= g.iB && k <= g.iT ? 1 : 0);
      return mirrorFlags(f);
    }
    function ringOf(o) { return o.fin > 0.002 ? [[o.yb + o.fin, 0]].concat(o.p) : o.p; }
    var runs = st.map(function (o) {
      if (!o.glassOn) return null;
      return glassRun(ringOf(o), o.thr - 0.021, Math.min(o.yt, tab(c.glassTop, o.x)), GLASS_NV);
    });
    var tops = runs.filter(function (g, i) { return g && g.iB >= 0 && st[i].x < c.header; }).map(function (g) { return g.iT; }).sort(function (a, b) { return a - b; });
    var medT = tops.length ? tops[tops.length >> 1] : null;
    function tgCols(h) { var n = 0; for (var k = HALF; k >= 0 && h[k][1] <= tg.hw && h[k][0] >= h[HALF][0] - 0.05; k--) n++; return n - 1; }
    var tgN = 0;
    if (tg) {
      var cols = st.filter(function (o) { return o.x >= tg.x0 - 1e-6 && o.x <= tg.x1 + 1e-6; })
        .map(function (o) { return tgCols(resampleHalf(ringOf(o), HALF + 1)); }).sort(function (a, b) { return a - b; });
      tgN = cols.length ? cols[cols.length >> 1] : 0;
    }
    var out = st.map(function (o, i) {
      var ring = ringOf(o), g = runs[i], flags = null;
      if (g && g.iB >= 0 && medT != null && o.x < c.header) g.iT = Math.max(g.iB, medT);
      else if (g && g.iB >= 0) g.iT = g.half;   // ahead of the header the ring top is windscreen: glass to the centre
      if (g) flags = runFlags(g);
      // raked tailgate (ID. Buzz): the ring tops between tg.x0 and tg.x1 are the tailgate glass
      // (one fixed vertex column count from the centre-line at every station, so the pane edges run straight)
      if (tg && o.x >= tg.x0 - 1e-6 && o.x <= tg.x1 + 1e-6 && o.yt >= tg.y0 && o.yt <= tg.y1) {
        var h = resampleHalf(ring, HALF + 1);
        flags = mirrorFlags(h.map(function (q, k) { return k >= HALF - tgN && k <= HALF ? 1 : 0; }));
      }
      return {
        glass: flags,
        x: r5(o.x), ring: ring.map(function (q) { return P2(q[0], q[1]); }), ringHalf: true,
        // threshold 0.021 below the true belt so the aligned belt vertex itself counts as glass
        belt: o.glassOn ? r5(o.thr - 0.021) : null,
        // top of the side glass (window-band top); high-roof caps above it are body, not glass
        glassTop: o.glassOn ? r5(Math.min(o.yt, tab(c.glassTop, o.x))) : null
      };
    });
    /* Flat rear-door glass: the last body ring closes onto the rear face through nested rings at (almost) the same x —
       outline → halfway → rounded glass rectangle → a speck at its centre. The quads between the last two are all
       glass (flags at 40 verts; belt fallback at other ring sizes), the annulus outside them is body. */
    if (rg) {
      var L0 = resampleHalf(out[0].ring, HALF + 1), rr0 = rg.r, yc = (rg.y0 + rg.y1) / 2;
      var rect = [[rg.y0, 0], [rg.y0, rg.hw - rr0]];
      arcPts(rect, rg.y0 + rr0, rg.hw - rr0, rr0, -90, 0, 4);
      rect.push([rg.y1 - rr0, rg.hw]);
      arcPts(rect, rg.y1 - rr0, rg.hw - rr0, rr0, 0, 90, 4);
      rect.push([rg.y1, 0]);
      var L2 = resampleHalf(rect, HALF + 1);
      var L1 = L0.map(function (q, i) { return [q[0] + (L2[i][0] - q[0]) * 0.5, q[1] + (L2[i][1] - q[1]) * 0.5]; });
      var L3 = L2.map(function (q) { return [yc + (q[0] - yc) * 0.004, q[1] * 0.004]; });
      var ones = []; for (var gi = 0; gi < GLASS_NV; gi++) ones.push(1);
      var caps = [[L1, 0.003, null], [L2, 0.006, ones], [L3, 0.008, ones]].map(function (e) {
        return { glass: e[2], x: r5(rg.x - e[1]), ring: e[0].map(function (q) { return P2(q[0], q[1]); }), ringHalf: true,
          belt: e[2] ? r5(rg.y0 - 0.03) : null, glassTop: e[2] ? r5(rg.y1) : null };
      });
      out = caps.reverse().concat(out);
    }
    return out;
  }

  function D(view, role, paint, path) { return { view: view, role: role, paint: paint, path: path }; }
  function Dpair(view, role, paint, path) {
    var ax = view === 'top' ? 1 : 0;
    return pair(path, ax).map(function (p) { return D(view, role, paint, p); });
  }

  /* ================================================================ SPRINTER */
  function sprinter() {
    var A = 3.665 / 2;                     // half wheelbase
    var tr = tireR(245, 75, 16);           // 0.387 m
    var ar = 0.445, yb = 0.46;
    var aF = { x: A, y: tr, r: ar }, aR = { x: -A, y: tr, r: ar };
    var top = [
      [2.60, 0.34, 1], [2.795, 0.365], [2.8255, 0.50], [2.815, 0.69], [2.795, 0.765, 1],    // bumper
      [2.77, 0.90], [2.72, 1.03], [2.66, 1.10], [2.52, 1.155], [2.20, 1.235], [1.88, 1.34, 1], // grille face + short raked hood
      [1.46, 1.70], [1.04, 2.07, 1],                                                          // windscreen
      [0.92, 2.28], [0.76, 2.57], [0.52, 2.695], [0.10, 2.73],                                // high-roof front dome
      [-2.70, 2.73], [-2.97, 2.715], [-3.06, 2.62], [-3.075, 2.30], [-3.08, 0.72, 1],        // roof, rear doors
      [-3.1065, 0.665], [-3.1065, 0.50], [-3.085, 0.435], [-2.98, 0.42, 1]                    // rear step bumper
    ];
    var frontDoor = join(poly([[0.935, 0.475], [0.935, 2.075], [1.06, 2.075]]).concat([L(1.83, 1.375), L(1.82, 0.92)]),
      arcFrom(A, tr, 1.82, 0.92, 168));
    var side = {
      body: sideBody(top, yb, aR, aF),
      greenhouse: SC([[1.86, 1.35, 1], [1.45, 1.71], [1.06, 2.04, 1], [-2.93, 2.04], [-2.975, 2.0], [-2.98, 1.95, 1],
        [-2.98, 1.42, 1], [0.95, 1.43, 1], [1.25, 1.428], [1.50, 1.385], [1.72, 1.305], [1.80, 1.31, 1]]),
      windows: [
        // front door glass: sill kicks down from x 1.25 to the mirror sail at (1.72, 1.33)
        SC([[1.79, 1.375, 1], [1.42, 1.71], [1.09, 1.985, 1], [1.01, 1.995], [0.978, 1.965], [0.975, 1.48, 1], [1.25, 1.468], [1.50, 1.42], [1.72, 1.33], [1.765, 1.335, 1]]),
        rr(-0.40, 1.44, 0.84, 1.99, 0.095),    // sliding-door glass
        rr(-1.78, 1.44, -0.50, 1.99, 0.095),   // fixed quarter glass 1
        rrv(-2.95, 1.44, -1.88, 1.99, [0.09, 0.095, 0.095, 0.14])   // fixed quarter glass 2, rounder top-rear corner
      ],
      pillars: [
        poly([[1.88, 1.345], [1.04, 2.07], [0.98, 2.06], [1.09, 1.985], [1.79, 1.375], [1.765, 1.335]], true),
        rr(0.84, 1.44, 0.975, 1.995, 0.01), rr(-0.50, 1.44, -0.40, 1.99, 0.01), rr(-1.88, 1.44, -1.78, 1.99, 0.01),
        rr(-3.06, 1.44, -2.95, 2.0, 0.02)
      ],
      doorCuts: [
        frontDoor,
        poly([[0.86, 0.475], [0.86, 2.075], [-0.46, 2.075], [-0.46, 0.475]])       // sliding door
      ],
      panelLines: [
        S([[2.69, 1.07], [2.36, 1.16], [1.90, 1.325]]),                              // bonnet shut line (headlamp top edge rides on it)
        S([[2.795, 0.765], [2.55, 0.775], [2.38, 0.70], [2.29, 0.56]]),              // front bumper cover
        S([[-3.08, 0.72], [-2.70, 0.72], [-2.40, 0.64], [-2.26, 0.53]]),             // rear bumper corner
        S([[-0.46, 1.405], [-2.97, 1.405]])                                          // sliding-door rail slot
      ],
      characterLines: [
        S([[2.50, 1.07], [2.10, 1.20], [1.70, 1.255], [1.0, 1.27], [-1.0, 1.27], [-3.06, 1.265]]), // shoulder under the DLO
        S([[1.34, 0.80], [0, 0.79], [-1.36, 0.80]]),                                               // lower swage
        S([[0.97, 2.12], [-1.0, 2.12], [-3.0, 2.12]]),                                             // upper-panel crease above the DLO
        S([[-1.20, 0.98], [-1.90, 1.005], [-2.55, 1.06], [-3.07, 1.07]]),                          // VS30 rear-wing crease
        openArc(-A, tr, 0.50, 160, 20)                                                             // rear arch flare
      ],
      sill: rr(-1.39, 0.46, 1.39, 0.53, 0.01),
      archF: { x: A, y: r5(tr), r: ar, flare: 0.025 },
      archR: { x: -A, y: r5(tr), r: ar, flare: 0.025 },
      lowerTrim: join(
        SC([[2.60, 0.34, 1], [2.795, 0.365], [2.825, 0.50], [2.822, 0.56, 1], [2.45, 0.56], [2.32, 0.52], [2.2715, 0.46, 1], [2.42, 0.39]]),
        SC([[-3.08, 0.72, 1], [-3.1065, 0.665], [-3.1065, 0.50], [-3.085, 0.435], [-2.98, 0.42, 1], [-2.2715, 0.46, 1], [-2.26, 0.53], [-2.40, 0.64], [-2.70, 0.72, 1]]),
        rr(-1.39, 0.46, 1.39, 0.53, 0.01))
    };
    var topv = {
      body: sym([[2.8255, 0], [2.80, 0.55], [2.70, 0.86], [2.50, 0.98], [2.10, 1.005], [1.20, 1.01], [-2.90, 1.01], [-3.06, 1.0], [-3.1065, 0.93], [-3.1065, 0, 1]], 1),
      greenhouse: sym([[1.88, 0], [1.86, 0.62], [1.78, 0.90, 1], [1.06, 0.94], [-2.98, 0.95], [-3.06, 0.92], [-3.07, 0.80], [-3.07, 0, 1]], 1),
      hood: sym([[2.74, 0], [2.71, 0.62], [2.62, 0.84], [2.40, 0.90, 1], [1.88, 0.88, 1], [1.88, 0, 1]], 1),
      roof: sym([[0.93, 0], [0.90, 0.55], [0.72, 0.85], [0.40, 0.885], [-2.96, 0.885], [-3.03, 0.84], [-3.04, 0.70], [-3.04, 0, 1]], 1),
      deck: sym([[-3.08, 0, 1], [-3.08, 0.94, 1], [-3.1065, 0.92, 1], [-3.1065, 0, 1]], 1),
      mirrors: pair(SC([[1.60, 1.01, 1], [1.80, 1.01, 1], [1.80, 1.15], [1.77, 1.21], [1.62, 1.21], [1.60, 1.15]]), 1)   // long-arm mirrors reach ~0.20 past the body
    };
    var spCap = [[0, 2.73], [0.62, 2.73], [0.76, 2.718], [0.85, 2.677], [0.895, 2.605], [0.912, 2.55], [0.935, 2.30], [0.96, 2.00], [0.982, 1.70], [1.0, 1.35], [1.01, 1.05]];
    var front = {
      // high-roof cap leans in: 0.96 @ 2.0, 0.91 @ 2.55, ~0.84 at the crown, 0.18 top corner radius
      body: sym(spCap.concat([[1.005, 0.62], [0.985, 0.40], [0.93, 0.34, 1], [0, 0.34, 1]]), 0),
      greenhouse: sym([[0, 2.035], [0.76, 2.025], [0.85, 1.99], [0.875, 1.90], [0.915, 1.50], [0.90, 1.40], [0.84, 1.375, 1], [0, 1.37, 1]], 0),
      bumper: sym([[0, 0.765], [0.55, 0.765], [0.90, 0.75], [0.99, 0.70], [1.0, 0.55], [0.985, 0.40], [0.93, 0.34, 1], [0, 0.34, 1]], 0),
      // upright trapezoid: half-width 0.56 at the top (y 1.13), 0.47 at the bottom (y 0.80)
      grille: [sym([[0, 1.13], [0.53, 1.13, 1], [0.56, 1.105, 1], [0.475, 0.815, 1], [0.455, 0.80, 1], [0, 0.80, 1]], 0)],
      intakes: [sym([[0, 0.56], [0.58, 0.56], [0.64, 0.53], [0.61, 0.42], [0.56, 0.39, 1], [0, 0.39, 1]], 0)].concat(pair(rr(0.72, 0.42, 0.92, 0.58, 0.04), 0)),
      // tall inner end against the grille (0.86–1.13), top edge kicking up to a point at the outer corner (0.99, 1.16), lower edge sweeping up
      headlights: pair(SC([[0.58, 1.13, 1], [0.86, 1.137], [0.99, 1.16, 1], [0.997, 1.08], [0.995, 0.98, 1], [0.80, 0.905], [0.62, 0.862], [0.58, 0.86, 1]]), 0),
      drl: pair(SC([[0.60, 0.88, 1], [0.80, 0.925], [0.975, 0.995, 1], [0.972, 1.018, 1], [0.80, 0.947], [0.605, 0.902, 1]]), 0),
      fogLights: pair(ell(0.82, 0.50, 0.05, 0.045), 0),
      plateArea: rr(-0.1525, 0.585, 0.1525, 0.737, 0.01),
      badgeArea: ell(0, 0.96, 0.10, 0.10),
      badgeText: 'MERCEDES-BENZ'
    };
    var rear = {
      body: sym(spCap.slice(0, 9).concat([[1.0, 1.40], [1.012, 0.80], [1.005, 0.725, 1], [0.995, 0.46], [0.95, 0.42, 1], [0, 0.42, 1]]), 0),
      greenhouse: rr(-0.80, 1.38, 0.80, 2.06, 0.04),
      bumper: { paint: 'black', path: sym([[0, 0.725], [0.96, 0.725], [1.0, 0.70], [1.005, 0.50], [0.98, 0.44], [0.94, 0.42, 1], [0, 0.42, 1]], 0) },  // black step bumper
      taillights: pair(rr(0.85, 0.745, 1.01, 1.36, 0.02), 0),
      diffuser: sym([[0, 0.48], [0.80, 0.48], [0.94, 0.46], [0.95, 0.42, 1], [0, 0.42, 1]], 0),
      exhaust: [{ shape: 'hidden', cx: -0.55, cy: 0.34, w: 0.07, h: 0.07 }],
      plateArea: rr(-0.1525, 0.50, 0.1525, 0.652, 0.01),
      badgeArea: rr(0.42, 1.22, 0.78, 1.28, 0.01),
      badgeText: 'MERCEDES-BENZ',
      // split doors stop at y 2.52 — the roof cap reads as a separate 0.21 m band (plus the dome) above them
      panelLines: [S([[0, 0.73], [0, 2.52]]), poly([[-0.94, 0.73], [-0.94, 2.30], [-0.90, 2.52], [0.90, 2.52], [0.94, 2.30], [0.94, 0.73]])]
    };
    // arm from the door (z 0.98) to the head (z 1.09), y 1.36–1.47; the head's inner edge tapers down into it
    var spMirror = SC([[0.98, 1.36, 1], [1.09, 1.362], [1.19, 1.40], [1.21, 1.47], [1.21, 1.77], [1.20, 1.80], [1.09, 1.80], [1.08, 1.75], [1.08, 1.57], [1.065, 1.495], [0.98, 1.47, 1]]);
    var details = join(
      [D('side', 'mirror', 'black', SC([[1.60, 1.42, 1], [1.76, 1.42], [1.785, 1.46], [1.79, 1.74], [1.77, 1.79], [1.60, 1.79], [1.575, 1.75], [1.575, 1.46]])),
        D('side', 'pillar', 'gloss-black', rr(0.84, 1.44, 0.975, 1.995, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-0.50, 1.44, -0.40, 1.99, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-1.88, 1.44, -1.78, 1.99, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-3.06, 1.44, -2.95, 2.0, 0.02)),
        D('side', 'handle', 'black', rr(1.00, 1.24, 1.16, 1.275, 0.015)),
        D('side', 'handle', 'black', rr(0.62, 1.24, 0.78, 1.275, 0.015)),
        // headlamp wraps ~0.40 m back along the wing; top edge on the bonnet shut line, lower edge rising to the tip
        D('side', 'light', 'light', SC([[2.775, 0.84, 1], [2.745, 0.98], [2.705, 1.06, 1], [2.55, 1.105], [2.36, 1.145, 1], [2.46, 1.07], [2.57, 0.95], [2.66, 0.86, 1]])),
        D('side', 'light', 'light-red', rr(-3.08, 0.74, -3.045, 1.36, 0.01)),
        D('side', 'marker', 'light-amber', rr(2.60, 0.66, 2.68, 0.70, 0.01)),
        D('side', 'marker', 'light-red', rr(-3.0, 0.62, -2.94, 0.66, 0.01)),
        D('side', 'step', 'black', rr(-0.46, 0.40, 0.86, 0.46, 0.01)),
        D('side', 'antenna', 'black', SC([[0.60, 2.725, 1], [0.45, 2.725, 1], [0.50, 2.78], [0.57, 2.78]])),
        D('front', 'wiper', 'black', rr(-0.80, 1.385, -0.05, 1.40, 0.006)),
        D('front', 'wiper', 'black', rr(0.02, 1.385, 0.72, 1.40, 0.006)),
        D('rear', 'light', 'light-red', rr(-0.22, 2.655, 0.22, 2.69, 0.01)),
        D('rear', 'handle', 'black', rr(0.06, 1.20, 0.20, 1.245, 0.01))],
      // two chrome slats (y 0.90 / 1.00) broken by the round centre badge
      Dpair('front', 'trim', 'chrome', rr(0.105, 0.99, 0.522, 1.01, 0.01)),
      Dpair('front', 'trim', 'chrome', rr(0.10, 0.89, 0.50, 0.91, 0.01)),
      // projector / reflector bowl inset in the headlamp lens
      Dpair('front', 'reflector', 'chrome', ell(0.80, 1.03, 0.10, 0.06)),
      Dpair('front', 'mirror', 'black', spMirror),
      Dpair('rear', 'mirror', 'black', spMirror),
      Dpair('rear', 'glass', 'glass', rr(0.04, 1.38, 0.80, 2.06, 0.04)),
      Dpair('rear', 'light', 'light-amber', rr(0.865, 1.08, 0.995, 1.18, 0.01)),
      Dpair('rear', 'light', 'light', rr(0.865, 0.90, 0.995, 0.98, 0.01)),
      [-0.40, -1.10, -1.80, -2.50].map(function (x) { return D('top', 'trim', 'body', rr(x - 0.03, -0.78, x + 0.03, 0.78, 0.02)); })
    );
    return {
      id: 'mercedes-sprinter-vs30', make: 'Mercedes-Benz', name: 'Sprinter 2500 Passenger 144" High Roof', gen: 'VS30', years: '2018–',
      look: { head: 'projector-twin', tail: 'vertical', grille: 'bar' },   // renderer lamp / grille signature
      style: 'van', enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice',
      ref: { length: 5.932, width: 2.020, height: 2.730, wheelbase: 3.665, trackF: 1.712, trackR: 1.704,
        frontOverhang: 0.993, rearOverhang: 1.274, wheelDiameter_in: 16, tireF: '245/75R16', tireR: '245/75R16',
        groundClearance: 0.185, rideHeight: 0.185, cd: 0.31, curbWeight_kg: 2650 },
      side: side, top: topv, front: front, rear: rear, details: details,
      sections: vanSections(side, topv, { gx: [-2.98, 1.86], step: 0.012, lowR: 0.07, hoodR: 0.14, roofR: 0.18, header: 1.04, cowl: 0.18,
        shut: [[2.69, 1.07], [2.36, 1.16], [1.90, 1.325]], maxGap: 0.06,
        rearGlass: { x: -3.072, y0: 1.38, y1: 2.06, hw: 0.80, r: 0.04 },
        belt: [[1.86, 1.35], [1.72, 1.31], [1.50, 1.395], [1.25, 1.43], [0.95, 1.43], [-2.98, 1.42]],
        cap: [[1.40, 0.015], [0.73, 0.05], [0.18, 0.10], [0, 0.10]], glassTop: [[1.86, 1.37], [1.06, 2.04], [-2.98, 2.04]] }),
      signature: {
        headlights: 'Large swept units outboard of the grille, top edge following the bonnet, LED daytime strip as a lower eyebrow.',
        taillights: 'Tall narrow vertical clusters in the rear corner pillars (red / amber / clear segments); centre high-mount stop lamp on the roof edge.',
        grille: 'Upright trapezoid with three horizontal slats and a large central star badge; black bumper with wide lower intake and corner fog pods.',
        notes: 'High steel roof domes up behind a raked windscreen; short sloping bonnet, flush side glass with black pillars, sliding door rail slot below the rear quarter windows, split rear doors over a step bumper. Fuel filler is on the left side.'
      }
    };
  }

  /* ================================================================ ID. BUZZ */
  function idBuzz() {
    var A = 2.988 / 2;
    var trF = tireR(235, 50, 20), trR = tireR(265, 45, 20);   // 0.3715 / 0.3733
    var ar = 0.418, yb = 0.40;
    var aF = { x: A, y: trF, r: ar }, aR = { x: -A, y: trR, r: ar };
    var top = [
      [2.21, 0.30, 1], [2.305, 0.335], [2.336, 0.45], [2.339, 0.60], [2.325, 0.76], [2.29, 0.90],  // 0-5 rounded nose
      [2.235, 1.005], [2.15, 1.075], [2.04, 1.12], [1.96, 1.141], [1.90, 1.172],                    // 6-10 short front lid, cowl rolls into the screen
      [1.48, 1.50], [1.04, 1.82], [0.78, 1.905], [0.40, 1.932], [0.10, 1.938],                      // 11-15 windscreen into roof (crown well forward)
      [-0.60, 1.935], [-1.60, 1.918], [-2.08, 1.905], [-2.20, 1.899], [-2.24, 1.895, 1],             // 15-19 roof falls gently to the spoiler
      [-2.246, 1.855, 1], [-2.285, 1.80], [-2.31, 1.62],                                             // 20-22 distinct 0.04 m spoiler step, tailgate glass
      [-2.34, 1.25], [-2.36, 0.90], [-2.373, 0.64], [-2.36, 0.46], [-2.30, 0.375], [-2.20, 0.36, 1]  // 23-28 tailgate
    ];
    var belt = [[-2.34, 1.25], [-2.345, 1.17], [-1.0, 1.17], [1.0, 1.168], [1.80, 1.16], [2.10, 1.075], [2.235, 1.005]];
    var contrastSide = Ssub(top, 6, 24).concat(splineSegs([[-2.34, 1.25], [-2.345, 1.17, 1]].concat(belt.slice(2)), false), [Z()]);
    // front door shut line drops almost vertically from the A-pillar base, then rounds the front arch
    var frontDoor = join(S([[0.42, 0.40], [0.42, 1.885, 1], [0.90, 1.885], [1.04, 1.835], [1.46, 1.545], [1.86, 1.205, 1], [1.848, 1.00], [1.84, 0.86]]),
      arcFrom(A, trF, 1.84, 0.86, 172));
    var side = {
      body: sideBody(top, yb, aR, aF),
      greenhouse: SC([[1.885, 1.19, 1], [1.46, 1.525], [1.04, 1.80], [0.82, 1.832], [0.40, 1.84], [-1.62, 1.84, 1], [-1.69, 1.79], [-1.92, 1.22, 1], [1.80, 1.19, 1]]),
      windows: [
        poly([[1.86, 1.215], [1.56, 1.44], [1.56, 1.215]], true),                               // fixed A-pillar quarter glass (big triangle)
        SC([[1.515, 1.47, 1], [1.43, 1.53], [1.04, 1.79], [0.92, 1.812], [0.52, 1.815], [0.475, 1.79], [0.47, 1.25], [0.50, 1.215, 1], [1.515, 1.215, 1]]),
        rr(-0.80, 1.215, 0.36, 1.815, 0.05),                                                       // sliding-door glass
        SC([[-0.90, 1.215, 1], [-0.90, 1.77], [-0.94, 1.815, 1], [-1.62, 1.815, 1], [-1.66, 1.77], [-1.88, 1.27], [-1.86, 1.215, 1]])
      ],
      pillars: [poly([[1.56, 1.215], [1.515, 1.215], [1.515, 1.47], [1.56, 1.44]], true),
        rr(0.36, 1.215, 0.47, 1.815, 0.01), rr(-0.90, 1.215, -0.80, 1.815, 0.01)],
      doorCuts: [frontDoor, poly([[0.32, 0.40], [0.32, 1.885], [-0.86, 1.885], [-0.86, 0.40]])],
      panelLines: [
        rr(-1.82, 0.92, -1.60, 1.06, 0.02),                                                         // charge-port flap (right rear)
        S([[2.325, 0.62], [2.10, 0.62], [1.95, 0.55], [1.91, 0.45]]),
        S([[-2.37, 0.62], [-2.10, 0.62], [-1.95, 0.50], [-1.91, 0.42]]),
        S([[-0.86, 1.205], [-1.93, 1.205]])                                                        // sliding-door rail
      ],
      characterLines: [S(belt.slice(1).reverse()), S([[1.02, 0.60], [0, 0.585], [-1.05, 0.60]])],
      sill: rr(-1.08, 0.40, 1.08, 0.47, 0.01),
      archF: { x: A, y: r5(trF), r: ar, flare: 0.012 },
      archR: { x: -A, y: r5(trR), r: ar, flare: 0.012 },
      lowerTrim: join(
        SC([[2.21, 0.30, 1], [2.305, 0.335], [2.33, 0.42], [2.332, 0.48, 1], [2.05, 0.48], [1.94, 0.45], [1.912, 0.40, 1], [2.05, 0.33]]),
        SC([[-2.362, 0.50, 1], [-2.36, 0.46], [-2.30, 0.375], [-2.20, 0.36, 1], [-1.912, 0.40, 1], [-1.95, 0.46], [-2.05, 0.50, 1]]),
        rr(-1.08, 0.40, 1.08, 0.47, 0.01))
    };
    var topv = {
      body: sym([[2.339, 0], [2.312, 0.50], [2.24, 0.78], [2.11, 0.90], [1.96, 0.97], [1.75, 0.99], [1.30, 0.9925], [-2.10, 0.9925], [-2.25, 0.973], [-2.335, 0.905], [-2.368, 0.80], [-2.373, 0.55], [-2.373, 0, 1]], 1),   // 0.18 plan radius at the tail
      greenhouse: sym([[1.95, 0], [1.93, 0.55], [1.84, 0.85], [1.50, 0.925], [-2.0, 0.935], [-2.22, 0.90], [-2.29, 0.72], [-2.30, 0]], 1),
      hood: sym([[2.29, 0], [2.26, 0.48], [2.16, 0.76], [2.03, 0.88], [1.95, 0.91, 1], [1.95, 0, 1]], 1),
      roof: sym([[0.95, 0], [0.92, 0.58], [0.76, 0.81], [0.40, 0.85], [-2.08, 0.85], [-2.22, 0.76], [-2.26, 0.55], [-2.27, 0]], 1),
      deck: sym([[-2.24, 0, 1], [-2.24, 0.80, 1], [-2.29, 0.78, 1], [-2.29, 0, 1]], 1),
      mirrors: pair(SC([[1.50, 0.99, 1], [1.68, 0.99, 1], [1.67, 1.07], [1.64, 1.105], [1.54, 1.105], [1.51, 1.07]]), 1)
    };
    // rounded roof from the front: half-width 0.74 at y 1.91, shoulder 0.90 at y 1.70
    var fBody = [[0, 1.938], [0.50, 1.934], [0.66, 1.926], [0.74, 1.91], [0.835, 1.835], [0.90, 1.70], [0.94, 1.45], [0.975, 1.18], [0.9925, 0.90], [0.99, 0.58], [0.97, 0.38], [0.91, 0.30, 1], [0, 0.30, 1]];
    var front = {
      body: sym(fBody, 0),
      greenhouse: sym([[0, 1.865], [0.64, 1.858], [0.77, 1.83], [0.84, 1.74], [0.88, 1.50], [0.915, 1.23], [0.885, 1.165], [0.80, 1.15, 1], [0, 1.14, 1]], 0),
      bumper: sym([[0, 0.64], [0.60, 0.635], [0.90, 0.64], [0.985, 0.62], [0.99, 0.45], [0.97, 0.36], [0.91, 0.30, 1], [0, 0.30, 1]], 0),
      // wide lower trapezoid (0.70 → 0.58 half-width) under a 0.05 m body-colour bar
      grille: [sym([[0, 0.60], [0.68, 0.60, 1], [0.70, 0.585, 1], [0.59, 0.372, 1], [0.575, 0.36, 1], [0, 0.36, 1]], 0)],
      intakes: pair(rr(0.86, 0.40, 0.92, 0.62, 0.028), 0),   // vertical C-blade air curtains
      // 0.07 tall at the inner end (meets the light strip at z 0.44), ~0.12 at the rounded outer end, top edge rising outward
      headlights: pair(SC([[0.44, 0.985, 1], [0.65, 1.005], [0.86, 1.038], [0.93, 1.05], [0.968, 0.985], [0.948, 0.905], [0.86, 0.884], [0.70, 0.88], [0.44, 0.882, 1]]), 0),
      drl: pair(rr(0.115, 0.958, 0.445, 0.972, 0.007), 0).concat(pair(SC([[0.47, 0.982, 1], [0.70, 1.003], [0.90, 1.034], [0.94, 1.036, 1], [0.90, 1.022], [0.70, 0.991], [0.47, 0.971, 1]]), 0)),
      splitter: sym([[0, 0.335], [0.70, 0.335], [0.86, 0.32], [0.89, 0.30, 1], [0, 0.30, 1]], 0),
      plateArea: rr(-0.26, 0.415, 0.26, 0.525, 0.01),
      badgeArea: ell(0, 0.935, 0.12, 0.12),
      badgeText: 'VW',
      characterLines: [S([[-0.99, 1.06], [-0.44, 0.99, 1], [0, 0.70, 1], [0.44, 0.99, 1], [0.99, 1.06]])],   // V-face break line (straight legs)
      // the V is a crisp paint split / panel crease, not a faint swage: drawn as a solid line from each lamp's inner end to the apex
      panelLines: [poly([[-0.44, 0.99], [0, 0.70], [0.44, 0.99]])]
    };
    var rBody = [[0, 1.938], [0.50, 1.934], [0.66, 1.926], [0.74, 1.91], [0.835, 1.835], [0.90, 1.70], [0.945, 1.45], [0.978, 1.15], [0.9925, 0.85], [0.99, 0.52], [0.965, 0.39], [0.90, 0.36, 1], [0, 0.36, 1]];
    var rear = {
      body: sym(rBody, 0),
      greenhouse: sym([[0, 1.82], [0.56, 1.812], [0.665, 1.78], [0.70, 1.60], [0.695, 1.34], [0.66, 1.27], [0.58, 1.26, 1], [0, 1.26, 1]], 0),   // thick D-pillars
      bumper: sym([[0, 0.62], [0.80, 0.62], [0.97, 0.60], [0.99, 0.50], [0.965, 0.39], [0.90, 0.36, 1], [0, 0.36, 1]], 0),
      taillights: pair(SC([[0.40, 1.192, 1], [0.70, 1.205], [0.93, 1.225], [0.968, 1.19], [0.974, 1.105, 1], [0.90, 1.105], [0.65, 1.15], [0.40, 1.162, 1]]), 0),   // 0.03 tall inner, 0.12 tall outer
      lightBar: rr(-0.40, 1.163, 0.40, 1.177, 0.007),
      diffuser: sym([[0, 0.48], [0.78, 0.48], [0.80, 0.47], [0.80, 0.36, 1], [0, 0.36, 1]], 0),   // 0.12 m black lower band
      exhaust: [],
      plateArea: rr(-0.26, 0.73, 0.26, 0.84, 0.01),
      badgeArea: ell(0, 1.04, 0.10, 0.10),
      badgeText: 'VW',
      spoiler: sym([[0, 1.938], [0.50, 1.934], [0.66, 1.926], [0.735, 1.905], [0.715, 1.872, 1], [0, 1.875, 1]], 0),
      panelLines: [poly([[-0.80, 0.62], [-0.82, 1.70], [-0.76, 1.86], [0.76, 1.86], [0.82, 1.70], [0.80, 0.62]])],
      characterLines: [S([[-0.972, 1.17], [0.972, 1.17]])]
    };
    var details = join(
      // door-mounted mirror behind the A-pillar quarter glass (the triangle ahead of it stays visible)
      [D('side', 'mirror', 'black', SC([[1.50, 1.23, 1], [1.66, 1.23], [1.68, 1.27], [1.68, 1.40], [1.65, 1.43], [1.52, 1.43], [1.50, 1.40]])),
        D('side', 'pillar', 'gloss-black', rr(0.36, 1.215, 0.47, 1.815, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-0.90, 1.215, -0.80, 1.815, 0.01)),
        D('side', 'handle', 'black', rr(0.60, 1.09, 0.78, 1.12, 0.012)),
        D('side', 'handle', 'black', rr(0.16, 1.09, 0.30, 1.12, 0.012)),
        D('side', 'chargePort', 'black', rr(-1.81, 0.93, -1.61, 1.05, 0.02)),
        // headlamp wraps back to x 2.12 under the belt crease; taillight wraps 0.18 m onto the side on the crease
        D('side', 'light', 'light', SC([[2.29, 0.90, 1], [2.258, 0.972], [2.20, 1.025], [2.12, 1.045, 1], [2.12, 0.995, 1], [2.20, 0.978], [2.25, 0.93]])),
        D('side', 'light', 'light-red', SC([[-2.343, 1.115, 1], [-2.338, 1.205, 1], [-2.20, 1.20], [-2.16, 1.192, 1], [-2.16, 1.128, 1], [-2.20, 1.12]])),
        D('side', 'antenna', 'black', SC([[-1.40, 1.932, 1], [-1.62, 1.926, 1], [-1.56, 1.99], [-1.48, 1.99]])),
        D('front', 'wiper', 'black', rr(-0.78, 1.16, -0.04, 1.172, 0.006)),
        D('front', 'wiper', 'black', rr(0.04, 1.16, 0.70, 1.172, 0.006)),
        D('rear', 'wiper', 'black', rr(-0.02, 1.28, 0.40, 1.292, 0.006)),
        D('rear', 'light', 'light-red', rr(-0.25, 1.84, 0.25, 1.86, 0.008))],
      Dpair('front', 'mirror', 'black', SC([[0.98, 1.24, 1], [1.10, 1.25], [1.105, 1.40], [1.08, 1.43], [1.0, 1.43], [0.97, 1.30, 1]])),
      Dpair('rear', 'mirror', 'black', SC([[0.98, 1.24, 1], [1.10, 1.25], [1.105, 1.40], [1.08, 1.43], [1.0, 1.43], [0.97, 1.30, 1]])),
      Dpair('rear', 'reflector', 'light-red', rr(0.84, 0.42, 0.95, 0.45, 0.01))
    );
    return {
      id: 'vw-id-buzz', make: 'Volkswagen', name: 'ID. Buzz', gen: 'EB1 (SWB)', years: '2022–',
      look: { head: 'slim-led', tail: 'light-bar', grille: 'blanked' },   // renderer lamp / grille signature
      style: 'van', enginePosition: 'rear', drivetrain: 'rwd', powertrain: 'ev',
      ref: { length: 4.712, width: 1.985, height: 1.938, wheelbase: 2.988, trackF: 1.672, trackR: 1.670,
        frontOverhang: 0.851, rearOverhang: 0.873, wheelDiameter_in: 20, tireF: '235/50R20', tireR: '265/45R20',
        groundClearance: 0.155, rideHeight: 0.155, cd: 0.285, curbWeight_kg: 2471 },
      side: side, top: topv, front: front, rear: rear, details: details,
      sections: vanSections(side, topv, { gx: [-1.92, 1.88], step: 0.015, lowR: 0.08, hoodR: 0.16, roofR: 0.24, header: 1.04, cowl: 0.16, maxGap: 0.06,
        hoodRx: [[2.20, 0.16], [2.0, 0.16], [-2.0, 0.16], [-2.25, 0.12]], roofRx: [[-2.0, 0.24], [-2.25, 0.16]],
        shapeGx: [-2.345, 1.88], tailGlass: { x0: -2.334, x1: -2.282, y0: 1.33, y1: 1.84, hw: 0.72, step: 0.0087 },
        belt: [[1.88, 1.19], [0.40, 1.205], [-1.92, 1.22]],
        cap: [[0.80, 0.02], [0.45, 0.05], [0.24, 0.09], [0, 0.09]], glassTop: [[1.88, 1.19], [1.04, 1.80], [0.40, 1.84], [-1.92, 1.84]] }),
      /* Optional factory two-tone (upper body in a contrast colour, V-face at the front). Not drawn by default —
         renderers that support build.style.roof === 'contrast' can paint these regions over the body (under the glass). */
      twoTone: {
        paint: 'contrast',
        side: contrastSide,
        front: sym(fBody.slice(0, 8).concat([[0.99, 1.06, 1], [0.44, 0.99, 1], [0, 0.70, 1]]), 0),
        rear: sym(rBody.slice(0, 7).concat([[0.972, 1.17, 1], [0, 1.17, 1]]), 0)
      },
      /* Two-tone is half of this car's identity: integration should default build.style.roof = 'contrast' for this model. */
      defaultStyle: { roof: 'contrast' },
      signature: {
        headlights: 'Slim horizontal LED matrix lamps joined by a full-width light strip that runs into the large central badge.',
        taillights: 'Slim horizontal rear lamps linked by a red light bar across the tailgate, set on the two-tone break line.',
        grille: 'No upper grille: two-tone V-face (contrast upper "V" down to the badge), wide honeycomb lower grille with plate, C-shaped corner air curtains.',
        notes: 'One-box Bulli homage: very short overhangs, rounded nose, long raked screen, gently arched roof, optional two-tone split along a crisp belt crease (model.twoTone regions), thick body-coloured D-pillar, charge flap on the right rear quarter.'
      }
    };
  }

  /* ================================================================ TRANSIT */
  function transit() {
    var A = 3.750 / 2;
    var tr = tireR(235, 65, 16);           // 0.356 m
    var ar = 0.425, yb = 0.47;
    var aF = { x: A, y: tr, r: ar }, aR = { x: -A, y: tr, r: ar };
    var top = [
      [2.68, 0.36, 1], [2.85, 0.385], [2.893, 0.50], [2.899, 0.62], [2.888, 0.75, 1],                 // bumper
      [2.875, 0.88], [2.862, 1.03], [2.84, 1.15], [2.80, 1.228], [2.75, 1.26], [2.40, 1.335], [1.97, 1.43, 1], // tall blunt nose, flat bonnet
      [1.52, 1.79], [1.10, 2.11],                                                                      // windscreen
      [1.125, 2.16], [1.14, 2.26],                                                                     // filleted brow root
      [1.13, 2.58], [1.04, 2.74], [0.80, 2.80], [0.40, 2.804],                                         // bluff high-roof brow leaning forward
      [-2.80, 2.804], [-2.99, 2.79], [-3.055, 2.70], [-3.065, 2.40], [-3.07, 0.71, 1],
      [-3.083, 0.66], [-3.083, 0.52], [-3.065, 0.47], [-2.98, 0.45, 1]
    ];
    var frontDoor = join(poly([[0.96, 0.475], [0.96, 2.115], [1.10, 2.115]]).concat([L(1.925, 1.465), L(1.93, 0.88)]),
      arcFrom(A, tr, 1.93, 0.88, 168));
    var side = {
      body: sideBody(top, yb, aR, aF),
      greenhouse: SC([[1.95, 1.45, 1], [1.52, 1.79], [1.10, 2.08, 1], [-2.94, 2.07], [-2.985, 2.03], [-2.99, 1.98, 1], [-2.99, 1.51, 1], [0.98, 1.515, 1], [1.35, 1.512], [1.60, 1.45], [1.80, 1.38], [1.88, 1.385, 1]]),
      windows: [
        SC([[1.875, 1.46, 1], [1.50, 1.765], [1.145, 2.035, 1], [1.04, 2.05], [1.005, 2.02], [1.0, 1.535, 1], [1.35, 1.53], [1.60, 1.47], [1.80, 1.40], [1.85, 1.405, 1]]),   // door glass kicks down at the mirror
        rr(-0.52, 1.53, 0.86, 2.04, 0.05), rr(-1.92, 1.53, -0.62, 2.04, 0.05), rr(-2.98, 1.53, -2.02, 2.04, 0.07)
      ],
      pillars: [poly([[1.97, 1.43], [1.10, 2.11], [1.04, 2.10], [1.145, 2.035], [1.875, 1.46], [1.85, 1.405]], true),
        rr(0.86, 1.53, 1.0, 2.04, 0.01), rr(-0.62, 1.53, -0.52, 2.04, 0.01), rr(-2.02, 1.53, -1.92, 2.04, 0.01), rr(-3.06, 1.53, -2.98, 2.04, 0.02)],
      doorCuts: [frontDoor, poly([[0.90, 0.475], [0.90, 2.115], [-0.58, 2.115], [-0.58, 0.475]])],
      panelLines: [
        S([[2.80, 1.205], [2.40, 1.31], [1.99, 1.415]]),
        S([[2.888, 0.75], [2.60, 0.76], [2.40, 0.70], [2.31, 0.58]]),
        S([[-3.07, 0.71], [-2.70, 0.71], [-2.42, 0.64], [-2.29, 0.55]]),
        S([[-0.58, 1.505], [-3.0, 1.505]])
      ],
      characterLines: [
        S([[2.62, 1.12], [2.10, 1.215], [1.0, 1.29], [-1.0, 1.355], [-3.06, 1.42]]),  // strong rising wedge shoulder
        S([[1.38, 0.80], [0, 0.79], [-1.40, 0.80]]),
        // boxy squircle flares: flat top 0.30 long at wheel-centre + 0.48, 0.15 corner radii
        squircleFlare(A, yb, 0.48, 0.15, tr + 0.48, 0.15), squircleFlare(-A, yb, 0.48, 0.15, tr + 0.48, 0.15)
      ],
      sill: rr(-1.46, 0.47, 1.46, 0.55, 0.01),
      archF: { x: A, y: r5(tr), r: ar, flare: 0.045 },
      archR: { x: -A, y: r5(tr), r: ar, flare: 0.045 },
      lowerTrim: join(
        SC([[2.68, 0.36, 1], [2.85, 0.385], [2.893, 0.50], [2.899, 0.62], [2.888, 0.75, 1], [2.60, 0.76], [2.40, 0.70], [2.31, 0.58], [2.2844, 0.47, 1], [2.45, 0.40]]),
        SC([[-3.07, 0.71, 1], [-3.083, 0.66], [-3.083, 0.52], [-3.065, 0.47], [-2.98, 0.45, 1], [-2.2844, 0.47, 1], [-2.29, 0.55], [-2.42, 0.64], [-2.70, 0.71, 1]]),
        // black rubbing strip y 0.66–0.73 from the tail to the front wing, broken only by the arch flares
        rr(-2.95, 0.66, -2.215, 0.73, 0.03), rr(-1.535, 0.66, 1.535, 0.73, 0.03), rr(2.215, 0.66, 2.66, 0.73, 0.03))
    };
    var topv = {
      body: sym([[2.899, 0], [2.88, 0.55], [2.79, 0.87], [2.58, 1.005], [2.15, 1.03], [1.0, 1.0325], [-2.92, 1.0325], [-3.06, 1.02], [-3.083, 0.95], [-3.083, 0, 1]], 1),
      greenhouse: sym([[1.98, 0], [1.955, 0.62], [1.86, 0.92, 1], [1.10, 0.97], [-3.0, 0.98], [-3.06, 0.94], [-3.065, 0.80], [-3.065, 0, 1]], 1),
      hood: sym([[2.80, 0], [2.765, 0.62], [2.64, 0.88], [2.40, 0.93, 1], [1.98, 0.92, 1], [1.98, 0, 1]], 1),
      roof: sym([[1.0, 0], [0.97, 0.58], [0.83, 0.85], [0.50, 0.88], [-2.95, 0.88], [-3.03, 0.83], [-3.035, 0.70], [-3.035, 0, 1]], 1),   // high-roof cap narrower than the body
      deck: sym([[-3.07, 0, 1], [-3.07, 0.97, 1], [-3.083, 0.95, 1], [-3.083, 0, 1]], 1),
      mirrors: pair(SC([[1.62, 1.0325, 1], [1.84, 1.0325, 1], [1.84, 1.17], [1.81, 1.237], [1.65, 1.237], [1.62, 1.17]]), 1)
    };
    var front = {
      body: sym([[0, 2.804], [0.80, 2.80], [0.94, 2.77], [0.985, 2.66], [0.99, 2.30], [0.978, 2.12], [0.995, 1.80], [1.02, 1.40], [1.0325, 1.10], [1.03, 0.62], [1.01, 0.42], [0.95, 0.36, 1], [0, 0.36, 1]], 0),
      greenhouse: sym([[0, 2.09], [0.80, 2.08], [0.885, 2.03], [0.92, 1.80], [0.955, 1.52], [0.93, 1.445], [0.86, 1.425, 1], [0, 1.42, 1]], 0),
      // whole lower bumper in black/grey plastic (y 0.36–0.85) — the Transit's at-a-glance difference
      bumper: { paint: 'black', path: sym([[0, 0.72], [0.50, 0.72, 1], [0.565, 0.85, 1], [0.95, 0.85], [1.022, 0.82], [1.032, 0.60], [1.01, 0.42], [0.95, 0.36, 1], [0, 0.36, 1]], 0) },
      // huge V363 grille: half-width 0.72 at the top (y 1.20) narrowing to 0.50 at the bottom (y 0.72)
      grille: [sym([[0, 1.20], [0.70, 1.20, 1], [0.722, 1.185, 1], [0.512, 0.728, 1], [0.495, 0.72, 1], [0, 0.72, 1]], 0)],
      intakes: [sym([[0, 0.54], [0.605, 0.54, 1], [0.62, 0.53, 1], [0.505, 0.405, 1], [0.495, 0.40, 1], [0, 0.40, 1]], 0)].concat(pair(rr(0.785, 0.435, 0.905, 0.665, 0.03), 0)),
      // tall swept lamps: inner edge follows the grille slant 1.20 → 0.86, level top, outer edge wraps down to y 1.02
      headlights: pair(SC([[0.728, 1.20, 1], [0.95, 1.20], [1.008, 1.17], [1.03, 1.02, 1], [0.90, 0.955], [0.72, 0.885], [0.57, 0.86, 1]]), 0),
      drl: pair(SC([[0.745, 1.188, 1], [0.95, 1.188], [0.997, 1.162], [1.015, 1.035, 1], [0.99, 1.03, 1], [0.975, 1.152], [0.94, 1.163], [0.74, 1.163, 1]]), 0),   // boomerang along top + outer edge
      fogLights: pair(rr(0.80, 0.45, 0.89, 0.65, 0.03), 0),   // vertical fog slots
      plateArea: rr(-0.1525, 0.555, 0.1525, 0.707, 0.01),
      badgeArea: ell(0, 0.97, 0.12, 0.05),
      badgeText: 'FORD'
    };
    var rear = {
      body: sym([[0, 2.804], [0.80, 2.80], [0.94, 2.77], [0.985, 2.66], [1.005, 2.30], [1.026, 1.60], [1.0325, 0.90], [1.03, 0.71, 1], [1.02, 0.49], [0.975, 0.45, 1], [0, 0.45, 1]], 0),
      greenhouse: rr(-0.84, 1.46, 0.84, 2.10, 0.06),
      bumper: { paint: 'black', path: sym([[0, 0.71], [0.98, 0.71], [1.03, 0.68], [1.03, 0.50], [0.985, 0.45, 1], [0, 0.45, 1]], 0) },
      // taller and higher than the Sprinter's: y 0.86–1.62, 0.13 wide at the top, 0.09 at the bottom, kink at y 1.20
      taillights: pair(SC([[0.90, 1.62, 1], [1.012, 1.62], [1.026, 1.59], [1.032, 0.89], [1.02, 0.86, 1], [0.94, 0.86, 1], [0.94, 1.16, 1], [0.90, 1.20, 1]]), 0),
      diffuser: sym([[0, 0.51], [0.85, 0.51], [0.97, 0.48], [0.975, 0.45, 1], [0, 0.45, 1]], 0),
      exhaust: [{ shape: 'round', cx: -0.70, cy: 0.40, w: 0.075, h: 0.075 }],
      plateArea: rr(-0.1525, 0.53, 0.1525, 0.682, 0.01),
      badgeArea: rr(0.40, 1.23, 0.80, 1.29, 0.01),
      badgeText: 'FORD',
      panelLines: [S([[0, 0.72], [0, 2.68]]), poly([[-0.95, 0.72], [-0.95, 2.68], [0.95, 2.68], [0.95, 0.72]])]
    };
    // arm from the door (z 0.99) to the head (z 1.09), y 1.44–1.52; the head's inner edge tapers down into it
    var mirrorF = SC([[0.99, 1.44, 1], [1.09, 1.442], [1.21, 1.465], [1.237, 1.52], [1.237, 1.86], [1.22, 1.89], [1.10, 1.89], [1.08, 1.84], [1.08, 1.62], [1.068, 1.545], [0.99, 1.52, 1]]);
    var details = join(
      [D('side', 'mirror', 'black', SC([[1.60, 1.62, 1], [1.83, 1.62], [1.85, 1.66], [1.85, 1.86], [1.82, 1.89], [1.62, 1.89], [1.60, 1.85]])),
        D('side', 'mirror', 'black', rr(1.61, 1.44, 1.84, 1.60, 0.02)),
        D('side', 'pillar', 'gloss-black', rr(0.86, 1.53, 1.0, 2.04, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-0.62, 1.53, -0.52, 2.04, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-2.02, 1.53, -1.92, 2.04, 0.01)),
        D('side', 'pillar', 'gloss-black', rr(-3.06, 1.53, -2.98, 2.04, 0.02)),
        D('side', 'handle', 'black', rr(1.04, 1.30, 1.20, 1.335, 0.015)),
        D('side', 'handle', 'black', rr(0.70, 1.30, 0.86, 1.335, 0.015)),
        // 2020 lamp sweeps ~0.45 m back up the wing: top edge on the bonnet shut line to (2.45, 1.30), lower edge rising (2.86, 0.90) → (2.52, 1.24)
        D('side', 'light', 'light', SC([[2.858, 0.90, 1], [2.868, 0.95], [2.855, 1.08], [2.815, 1.18], [2.70, 1.24], [2.45, 1.297, 1], [2.52, 1.24], [2.66, 1.12], [2.79, 0.98]])),
        // black front bumper wrapping onto the wing, ending at the front arch
        D('side', 'trim', 'black', SC([[2.68, 0.36, 1], [2.85, 0.385], [2.893, 0.50], [2.899, 0.62], [2.888, 0.75, 1], [2.60, 0.76], [2.40, 0.70], [2.31, 0.58], [2.2844, 0.47, 1], [2.45, 0.40]])),
        D('side', 'marker', 'light-amber', rr(2.70, 0.80, 2.78, 0.84, 0.01)),
        D('side', 'light', 'light-red', rr(-3.07, 0.86, -3.035, 1.62, 0.01)),
        D('side', 'marker', 'light-red', rr(-3.0, 0.60, -2.94, 0.64, 0.01)),
        D('side', 'step', 'black', rr(-0.58, 0.40, 0.90, 0.47, 0.01)),
        D('side', 'antenna', 'black', SC([[0.70, 2.80, 1], [0.55, 2.80, 1], [0.60, 2.85], [0.67, 2.85]])),
        // three very thick chrome bars (0.05 tall) at y 1.10 / 0.97 / 0.84, badge sits on the middle one
        D('front', 'trim', 'chrome', rr(-0.655, 1.075, 0.655, 1.125, 0.016)),
        D('front', 'trim', 'chrome', rr(-0.595, 0.945, 0.595, 0.995, 0.016)),
        D('front', 'trim', 'chrome', rr(-0.535, 0.815, 0.535, 0.865, 0.016)),
        D('front', 'wiper', 'black', rr(-0.82, 1.435, -0.05, 1.45, 0.006)),
        D('front', 'wiper', 'black', rr(0.02, 1.435, 0.74, 1.45, 0.006)),
        D('rear', 'light', 'light-red', rr(-0.25, 2.73, 0.25, 2.765, 0.01)),
        D('rear', 'handle', 'black', rr(0.06, 1.22, 0.20, 1.265, 0.01))],
      Dpair('front', 'mirror', 'black', mirrorF),
      Dpair('rear', 'mirror', 'black', mirrorF),
      Dpair('rear', 'glass', 'glass', rr(0.05, 1.46, 0.84, 2.10, 0.06)),
      Dpair('rear', 'light', 'light-amber', rr(0.915, 1.32, 1.015, 1.44, 0.01)),
      Dpair('rear', 'light', 'light', rr(0.955, 1.02, 1.015, 1.12, 0.01)),
      [-0.30, -1.00, -1.70, -2.40].map(function (x) { return D('top', 'trim', 'body', rr(x - 0.03, -0.80, x + 0.03, 0.80, 0.02)); })
    );
    return {
      id: 'ford-transit-hr', make: 'Ford', name: 'Transit 350 Passenger 148" High Roof', gen: 'V363 (2020 facelift)', years: '2020–',
      look: { head: 'projector-twin', tail: 'vertical', grille: 'bar' },   // renderer lamp / grille signature
      style: 'van', enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice',
      ref: { length: 5.982, width: 2.065, height: 2.804, wheelbase: 3.750, trackF: 1.732, trackR: 1.742,
        frontOverhang: 1.024, rearOverhang: 1.208, wheelDiameter_in: 16, tireF: '235/65R16C', tireR: '235/65R16C',
        groundClearance: 0.17, rideHeight: 0.17, cd: 0.37, curbWeight_kg: 2540 },
      side: side, top: topv, front: front, rear: rear, details: details,
      sections: vanSections(side, topv, { gx: [-2.99, 1.95], step: 0.012, lowR: 0.07, hoodR: 0.14, roofR: 0.20, header: 1.10, fMin: 0.55, maxDrop: 0.21, cowl: 0.15,
        shut: [[2.80, 1.205], [2.40, 1.31], [1.99, 1.415]], maxGap: 0.06, dense: [[1.0, 1.15, 0.012]],
        rearGlass: { x: -3.062, y0: 1.46, y1: 2.10, hw: 0.84, r: 0.06 },
        belt: [[1.95, 1.45], [1.88, 1.385], [1.80, 1.38], [1.60, 1.45], [1.35, 1.512], [0.98, 1.515], [-2.99, 1.51]],
        cap: [[1.40, 0.015], [0.70, 0.04], [0.20, 0.05], [0, 0.05]], glassTop: [[1.95, 1.45], [1.10, 2.08], [-2.99, 2.07]] }),
      signature: {
        headlights: 'Tall swept lamps hugging the grille corners, boomerang LED daytime signature along the top and outer edge.',
        taillights: 'Very tall slim vertical clusters set into the rear corner pillars beside the split doors.',
        grille: 'Big inverted trapezoid with three thick horizontal chrome bars and a central oval badge area; black lower bumper with wide intake and vertical fog pods.',
        notes: 'Tall blunt bonnet, rising wedge shoulder, crisp flared arches, front door glass dropping at the mirror, high roof with a forward visor-like cap above the screen, sliding-door rail slot, black side mouldings.'
      }
    };
  }

  /* ---------------------------------------------------------------- register */
  var models = [sprinter(), idBuzz(), transit()];
  models.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = models;
})();

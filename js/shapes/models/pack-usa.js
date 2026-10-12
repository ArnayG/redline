/* ==========================================================================
   FORGE Atelier — js/shapes/models/pack-usa.js
   American performance pack (none is a style default):
     - Ford Mustang GT Fastback (S650, 2024–)           ford-mustang-gt-s650          coupe
     - Chevrolet Camaro ZL1 (6th gen, 2019–2024)         chevrolet-camaro-zl1-2019     coupe
     - Dodge Challenger SRT Hellcat (LA, 2015–2023)      dodge-challenger-srt-hellcat  coupe
     - Chevrolet Corvette Stingray (C8, 2020–)           chevrolet-corvette-c8         hypercar (mid-engine)
     - Ford GT (2nd gen, 2017–2022)                      ford-gt-2017                  hypercar (mid-engine)
     - Jeep Wrangler Unlimited Rubicon (JL, 2018–)       jeep-wrangler-rubicon-jl      suv

   Published figures (manufacturer spec sheets — Ford / Stellantis media,
   Chevrolet newsroom — as listed by auto-data.net, Wikipedia, owners'-forum
   spec digests and dealer spec pages; overhang splits from reference side
   elevations where the maker gives only length − wheelbase):
     Mustang GT S650   4810 × 1915 × 1397, wb 2720, track 1575/1643,
                       255/40 ZR19 + 275/40 ZR19, 1738 kg
     Camaro ZL1        4783 × 1897 × 1344, wb 2811, track 1610/1591,
                       285/30 ZR20 + 305/30 ZR20, 1760 kg
     Challenger Hellcat 5017 × 1923 × 1454, wb 2946, track 1625/1618,
                       275/40 ZR20 all round, ground clearance 115, Cd 0.382, 2002 kg
     Corvette C8       4630 × 1934 × 1234, wb 2722, track 1647/1590,
                       overhangs 1035/873, 245/35 ZR19 + 305/30 ZR20, 1604 kg
     Ford GT           4779 × 2003 × 1109 (normal ride height), wb 2710,
                       track 1694/1662, 245/35 R20 + 325/30 R20, 1385 kg dry
     Wrangler JLU Rubicon 4785 (incl. spare) × 1894 × 1848, wb 3008,
                       track 1598, overhangs 742/1035, LT285/70 R17,
                       ground clearance 274, 2018 kg

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top view = (x, z); front & rear views = (z, y).

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}. Body
   surfaces are smooth G1 cubic splines through hand-placed landmarks. Brand
   names are text only: no manufacturer logo artwork is drawn (no pony, no
   bowtie, no crossed flags); badgeArea marks where a text badge goes.

   Classic script, zero dependencies, no DOM. Registers via
   CB.shapes.registerModel when core.js has loaded, otherwise queues on
   CB.shapes._pending (core.js drains the queue when it loads).
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ */
  /* Geometry helpers (local; must not depend on core.js)                */
  /* ------------------------------------------------------------------ */
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function P2(a, b) { return [r4(a), r4(b)]; }
  function norm(v) { var l = Math.sqrt(v[0] * v[0] + v[1] * v[1]); return l > 1e-12 ? [v[0] / l, v[1] / l] : [1, 0]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function dist(a, b) { var d = sub(a, b); return Math.sqrt(d[0] * d[0] + d[1] * d[1]); }

  /* Landmark flags: undefined = smooth; 'c' = corner; 'h' = smooth with tangent
     along the first axis; 'v' = smooth with tangent along the second axis;
     [ta, tb] = smooth with explicit tangent direction. */
  function tangentsOf(pts, closed) {
    var n = pts.length, out = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i], f = p[2];
      var prev = i > 0 ? pts[i - 1] : (closed ? pts[n - 1] : null);
      var next = i < n - 1 ? pts[i + 1] : (closed ? pts[0] : null);
      var tin, tout;
      if (f === 'c' || !prev || !next) {
        tin = prev ? norm(sub(p, prev)) : norm(sub(next, p));
        tout = next ? norm(sub(next, p)) : norm(sub(p, prev));
      } else {
        var d = sub(next, prev);
        if (f === 'h') d = [d[0] >= 0 ? 1 : -1, 0];
        else if (f === 'v') d = [0, d[1] >= 0 ? 1 : -1];
        else if (Array.isArray(f)) d = f;
        tin = tout = norm(d);
      }
      out.push({ tin: tin, tout: tout });
    }
    return out;
  }
  /* Cubic segments from pts[0] through pts[n-1] (and back to pts[0] if closed). */
  function splineSegs(pts, closed) {
    var n = pts.length, T = tangentsOf(pts, closed), segs = [];
    var m = closed ? n : n - 1;
    for (var i = 0; i < m; i++) {
      var j = (i + 1) % n, a = pts[i], b = pts[j];
      var cornerA = a[2] === 'c' || (!closed && i === 0), cornerB = b[2] === 'c' || (!closed && j === n - 1);
      var t0 = T[i].tout, t1 = T[j].tin, chord = norm(sub(b, a));
      var straight = cornerA && cornerB && Math.abs(t0[0] * chord[1] - t0[1] * chord[0]) < 1e-9 && Math.abs(t1[0] * chord[1] - t1[1] * chord[0]) < 1e-9;
      if (straight) { segs.push({ t: 'L', p: [P2(b[0], b[1])] }); continue; }
      var d = dist(a, b);
      var cosT = Math.max(-1, Math.min(1, t0[0] * t1[0] + t0[1] * t1[1]));
      var th = Math.acos(cosT);
      var k = th < 1e-3 ? 1 / 3 : (2 / 3) * Math.tan(th / 4) / Math.sin(th / 2);
      k = Math.min(k, 0.5);
      segs.push({ t: 'C', p: [P2(a[0] + t0[0] * d * k, a[1] + t0[1] * d * k), P2(b[0] - t1[0] * d * k, b[1] - t1[1] * d * k), P2(b[0], b[1])] });
    }
    return segs;
  }
  /* Closed smooth loop through landmarks. */
  function loop(pts) { return [{ t: 'M', p: [P2(pts[0][0], pts[0][1])] }].concat(splineSegs(pts, true), [{ t: 'Z', p: [] }]); }
  /* Open smooth curve. */
  function curve(pts) { return [{ t: 'M', p: [P2(pts[0][0], pts[0][1])] }].concat(splineSegs(pts, false)); }
  /* Mirror landmarks / paths across an axis (0: negate first coord, 1: negate second). */
  function mirPt(p, ax) {
    var q = p.slice();
    q[ax] = -q[ax];
    if (Array.isArray(p[2])) { q[2] = p[2].slice(); q[2][ax] = -q[2][ax]; }
    return q;
  }
  function mirPath(path, ax) {
    return path.map(function (s) { return { t: s.t, p: s.p.map(function (q) { var o = q.slice(); o[ax] = r4(-o[ax]); return o; }) }; });
  }
  /* Symmetric closed outline from a half: half runs from a point on the mirror
     axis, through the positive side, to another point on the axis. */
  function sym(half, ax) {
    var full = half.slice();
    for (var i = half.length - 2; i >= 1; i--) full.push(mirPt(half[i], ax));
    return loop(full);
  }
  function pair(path, ax) { return [path, mirPath(path, ax)]; }
  /* Rounded polygon (r = corner radius, or per-vertex 3rd element number). */
  function rpoly(pts, r) {
    var n = pts.length, ins = [], outs = [];
    for (var i = 0; i < n; i++) {
      var v = pts[i], pv = pts[(i + n - 1) % n], nx = pts[(i + 1) % n];
      var rr = typeof v[2] === 'number' ? v[2] : r;
      var a = Math.min(rr, dist(v, pv) * 0.45), b = Math.min(rr, dist(v, nx) * 0.45);
      var u = norm(sub(pv, v)), w = norm(sub(nx, v));
      ins.push([v[0] + u[0] * a, v[1] + u[1] * a]);
      outs.push([v[0] + w[0] * b, v[1] + w[1] * b]);
    }
    var s = [{ t: 'M', p: [P2(outs[0][0], outs[0][1])] }];
    for (var j = 1; j <= n; j++) {
      var k = j % n;
      s.push({ t: 'L', p: [P2(ins[k][0], ins[k][1])] });
      s.push({ t: 'Q', p: [P2(pts[k][0], pts[k][1]), P2(outs[k][0], outs[k][1])] });
    }
    s.push({ t: 'Z', p: [] });
    return s;
  }
  function rrect(a0, b0, a1, b1, r) { return rpoly([[a0, b0], [a1, b0], [a1, b1], [a0, b1]], r == null ? 0.01 : r); }
  function ellipse(cx, cy, rx, ry, rotDeg) {
    var t = (rotDeg || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), K = 0.5523;
    function at(u, v) { return P2(cx + u * c - v * s, cy + u * s + v * c); }
    var q = [[rx, 0], [0, ry], [-rx, 0], [0, -ry]];
    var hd = [[0, ry * K], [-rx * K, 0], [0, -ry * K], [rx * K, 0]];
    var segs = [{ t: 'M', p: [at(q[0][0], q[0][1])] }];
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], ha = hd[i], hb = hd[(i + 1) % 4];
      segs.push({ t: 'C', p: [at(a[0] + ha[0], a[1] + ha[1]), at(b[0] - hb[0], b[1] - hb[1]), at(b[0], b[1])] });
    }
    segs.push({ t: 'Z', p: [] });
    return segs;
  }
  function line(pts) { return [{ t: 'M', p: [P2(pts[0][0], pts[0][1])] }].concat(pts.slice(1).map(function (q) { return { t: 'L', p: [P2(q[0], q[1])] }; })); }

  /* Circular arc as cubic segments (degrees, y-up). */
  function arcSegs(cx, cy, r, a0, a1) {
    var segs = [], n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90)), da = (a1 - a0) / n;
    for (var i = 0; i < n; i++) {
      var s = (a0 + da * i) * Math.PI / 180, e = (a0 + da * (i + 1)) * Math.PI / 180;
      var k = 4 / 3 * Math.tan((e - s) / 4);
      segs.push({ t: 'C', p: [
        P2(cx + r * (Math.cos(s) - k * Math.sin(s)), cy + r * (Math.sin(s) + k * Math.cos(s))),
        P2(cx + r * (Math.cos(e) + k * Math.sin(e)), cy + r * (Math.sin(e) - k * Math.cos(e))),
        P2(cx + r * Math.cos(e), cy + r * Math.sin(e))] });
    }
    return segs;
  }
  function archX(a, yb, sgn) { return a.x + sgn * Math.sqrt(a.r * a.r - (a.y - yb) * (a.y - yb)); }
  function archAng(a, x, y) { return Math.atan2(y - a.y, x - a.x) * 180 / Math.PI; }

  /* Side-view body silhouette.
     upper: landmarks from the front-arch front edge (excluded) forward round the
     nose, over the roof, down the tail to the rear bumper bottom.
     Then: rear arch (over the wheel), sill (straight), front arch, close. */
  function sideBody(aF, aR, ybF, ybR, upper, sillY) {
    var f1x = archX(aF, ybF, +1), f0x = archX(aF, ybF, -1);
    var r0x = archX(aR, ybR, -1), r1x = archX(aR, ybR, +1);
    var pts = [[f1x, ybF, 'c']].concat(upper, [[r0x, ybR, 'c']]);
    var segs = curve(pts);
    var a0 = archAng(aR, r0x, ybR), a1 = archAng(aR, r1x, ybR) - 360;
    segs = segs.concat(arcSegs(aR.x, aR.y, aR.r, a0, a1));
    // sill: rocker runs from the rear-arch front edge to the front-arch rear edge
    segs.push({ t: 'L', p: [P2(r1x + 0.02, sillY)] });
    segs.push({ t: 'L', p: [P2(f0x - 0.02, sillY)] });
    segs.push({ t: 'L', p: [P2(f0x, ybF)] });
    var b0 = archAng(aF, f0x, ybF), b1 = archAng(aF, f1x, ybF) - 360;
    segs = segs.concat(arcSegs(aF.x, aF.y, aF.r, b0, b1));
    segs.push({ t: 'Z', p: [] });
    return segs;
  }
  /* Wheel-arch lip ring (flare) as a thin closed band following the arch. */
  function archLip(a, yb, w) {
    var x0 = archX(a, yb, -1), x1 = archX(a, yb, +1);
    var s0 = archAng(a, x0, yb), s1 = archAng(a, x1, yb) - 360;
    var ro = a.r + w;
    var xo1 = archX({ x: a.x, y: a.y, r: ro }, yb, +1), xo0 = archX({ x: a.x, y: a.y, r: ro }, yb, -1);
    var o0 = archAng(a, xo1, yb), o1 = archAng(a, xo0, yb) + 360;
    var segs = [{ t: 'M', p: [P2(x0, yb)] }].concat(arcSegs(a.x, a.y, a.r, s0, s1));
    segs.push({ t: 'L', p: [P2(xo1, yb)] });
    segs = segs.concat(arcSegs(a.x, a.y, ro, o0, o1));
    segs.push({ t: 'Z', p: [] });
    return segs;
  }
  function tireDia(s) {
    var m = String(s).match(/(\d{3})\/(\d{2})Z?R(\d{2})/);
    return m ? (+m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100000) : 0.68;
  }
  function D(view, role, path, paint) { return { view: view, role: role, path: path, paint: paint }; }
  function pairD(view, role, path, paint, ax) { return pair(path, ax).map(function (p) { return D(view, role, p, paint); }); }
  /* Raked teardrop: round end at +u, pointed end at -u, rotated rotDeg. */
  function teardrop(cx, cy, L, Hh, rotDeg) {
    var t = rotDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    var loc = [[L, 0], [L * 0.72, Hh * 0.92], [L * 0.1, Hh], [-L * 0.55, Hh * 0.55], [-L, 0, 'c'], [-L * 0.55, -Hh * 0.5], [L * 0.1, -Hh * 0.95], [L * 0.72, -Hh * 0.9]];
    return loop(loc.map(function (q) { var o = [cx + q[0] * c - q[1] * s, cy + q[0] * s + q[1] * c]; if (q[2]) o.push(q[2]); return o; }));
  }

  /* ------------------------------------------------------------------ */
  /* 3D: explicit cross-sections (rings of [y, z]) built from the views   */
  /* ------------------------------------------------------------------ */
  /* Flatten a path into polylines (array of [[a,b],...]). */
  function flat(path, steps) {
    steps = steps || 12;
    var polys = [], cur = null, start = null, pl = null;
    path.forEach(function (s) {
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
  /* All crossings of the vertical a = x with the polylines → [min b, max b] or null. */
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
  function sliceY(polys, y) {
    var sw = polys.map(function (p) { return p.map(function (q) { return [q[1], q[0]]; }); });
    return sliceX(sw, y);
  }
  function inside(polys, a, b) {
    var c = false;
    polys.forEach(function (p) {
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
        if (((p[i][1] > b) !== (p[j][1] > b)) && (a < (p[j][0] - p[i][0]) * (b - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c;
      }
    });
    return c;
  }
  /* 1D Catmull-Rom through a table [[x, v...], ...] sorted by descending or ascending x; column k. */
  function tab(T, x, k) {
    k = k || 1;
    var A = T.slice().sort(function (p, q) { return p[0] - q[0]; });
    if (x <= A[0][0]) return A[0][k];
    if (x >= A[A.length - 1][0]) return A[A.length - 1][k];
    for (var i = 0; i < A.length - 1; i++) {
      if (x <= A[i + 1][0]) {
        var p0 = A[Math.max(0, i - 1)], p1 = A[i], p2 = A[i + 1], p3 = A[Math.min(A.length - 1, i + 2)];
        var t = (x - p1[0]) / (p2[0] - p1[0]);
        var m1 = (p2[k] - p0[k]) / Math.max(1e-6, p2[0] - p0[0]) * (p2[0] - p1[0]);
        var m2 = (p3[k] - p1[k]) / Math.max(1e-6, p3[0] - p1[0]) * (p2[0] - p1[0]);
        if ((p2[k] - p1[k]) * m1 <= 0) m1 = 0;
        if ((p2[k] - p1[k]) * m2 <= 0) m2 = 0;
        var t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * p1[k] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[k] + (t3 - t2) * m2;
      }
    }
    return A[A.length - 1][k];
  }
  /* Cubic from a to b ([y,z]) with unit tangents ta (out of a) and tb (into b), n samples (excl. a). */
  function cub(a, ta, b, tb, n, out, type) {
    var d = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.42;
    var c1 = [a[0] + ta[0] * d, a[1] + ta[1] * d], c2 = [b[0] - tb[0] * d, b[1] - tb[1] * d];
    for (var i = 1; i <= n; i++) {
      var t = i / n, u = 1 - t;
      out.push({ q: [u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
        u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]], k: type });
    }
  }
  /* As cub, with explicit handle lengths da (out of a) and db (into b). */
  function cubD(a, ta, da, b, tb, db, n, out, type) {
    var c1 = [a[0] + ta[0] * da, a[1] + ta[1] * da], c2 = [b[0] - tb[0] * db, b[1] - tb[1] * db];
    for (var i = 1; i <= n; i++) {
      var t = i / n, u = 1 - t;
      out.push({ q: [u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
        u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]], k: type });
    }
  }
  /* Normalised half-width profile (0..1 of max) vs normalised height (0..1) of a front/rear outline below its glass. */
  function profileOf(bodyPath, ghPath) {
    var bp = flat(bodyPath), gp = flat(ghPath), yMin = Infinity;
    bp.forEach(function (p) { p.forEach(function (q) { yMin = Math.min(yMin, q[1]); }); });
    var gMin = Infinity; gp.forEach(function (p) { p.forEach(function (q) { gMin = Math.min(gMin, q[1]); }); });
    var yTop = gMin - 0.04, out = [], mx = 0;
    for (var i = 0; i <= 20; i++) {
      var y = yMin + 0.01 + (yTop - yMin - 0.01) * i / 20, s = sliceY(bp, y);
      var w = s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : 0;
      out.push([i / 20, w]); mx = Math.max(mx, w);
    }
    return out.map(function (q) { return [q[0], q[1] / (mx || 1)]; });
  }
  /* Build explicit 3D sections.
     cfg: { side, top, front, rear, ref, archF, archR, sillY, xWS (windscreen base), xBL (backlight base),
            belt: [[x,y]] glass-base line, crest: [[x, y, kz]] body-side crest height (capped by the silhouette)
            and its z as a fraction of the plan half-width, dip: [[x, d]] hood centre drop below the wing crest,
            NV ring verts (even), stations } */
  function buildSections(cfg) {
    var NV = cfg.NV || 40, half = NV / 2;
    var sb = flat(cfg.side.body, 16), tb = flat(cfg.top.body, 16), tg = flat(cfg.top.greenhouse, 16);
    var tr = flat(cfg.top.roof, 8), win = [];
    cfg.side.windows.forEach(function (w) { win = win.concat(flat(w, 16)); });
    var roofB = [Infinity, -Infinity]; tr.forEach(function (p) { p.forEach(function (q) { roofB[0] = Math.min(roofB[0], q[0]); roofB[1] = Math.max(roofB[1], q[0]); }); });
    var PF = profileOf(cfg.front.body, cfg.front.greenhouse), PR = profileOf(cfg.rear.body, cfg.rear.greenhouse);
    var ref = cfg.ref, arches = [cfg.archF, cfg.archR];
    var wells = [[cfg.archF, ref.trackF, tireW(ref.tireF)], [cfg.archR, ref.trackR, tireW(ref.tireR)]].map(function (A) {
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - A[2] / 2 - 0.02 };
    });
    var xs = [], XF = -Infinity, XR = Infinity;
    sb.forEach(function (p) { p.forEach(function (q) { XF = Math.max(XF, q[0]); XR = Math.min(XR, q[0]); }); });
    var NS = cfg.stations || 96;
    for (var i = 0; i < NS; i++) { var t = i / (NS - 1); xs.push(XR + 0.004 + (XF - XR - 0.008) * (0.5 - 0.5 * Math.cos(Math.PI * (0.06 + 0.88 * t)) - 0.0) ); }
    // add end stations close to the bumpers so the nose and tail are rounded, not cut
    [0.004, 0.012, 0.028, 0.05].forEach(function (d) { xs.push(XF - d, XR + d); });
    // dense stations through the cabin so the glass edges (per-quad flags) follow the window outlines closely
    for (var xc = cfg.xBL + 0.02; xc < cfg.xWS; xc += 0.02) xs.push(xc);
    xs.sort(function (a, b) { return a - b; });
    xs = xs.filter(function (v, i) { return i === 0 || v - xs[i - 1] > 0.006; });
    function bottomAt(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.18;
        if (Math.abs(x - a.x) < e) {
          var l = sliceX(sb, a.x - e), r = sliceX(sb, a.x + e);
          var lb = l ? l[0] : cfg.sillY, rb = r ? r[0] : cfg.sillY;
          return lb + (rb - lb) * (x - (a.x - e)) / (2 * e);
        }
      }
      var s = sliceX(sb, x); return s ? s[0] : cfg.sillY;
    }
    var out = [];
    xs.forEach(function (x) {
      var sl = sliceX(sb, x); if (!sl) return;
      var top = sl[1], yb = Math.min(bottomAt(x), top - 0.03);
      var tw = sliceX(tb, x), w = tw ? Math.max(Math.abs(tw[0]), Math.abs(tw[1])) : 0.05; w = Math.max(w, 0.02);
      var bl = (x > cfg.xBL && x < cfg.xWS) ? tab(cfg.belt, x) : null;
      // stations just behind the windscreen base stay cabin (glass) even where the screen meets the scuttle
      var nearWS = bl != null && x > cfg.xWS - 0.25;
      if (nearWS && top - bl < 0.03) bl = top - 0.03;
      var cabin = bl != null && (top - bl > 0.035 || nearWS);
      var yC = Math.min(tab(cfg.crest, x, 1), top), kz = tab(cfg.crest, x, 2);
      if (cabin) yC = Math.min(yC, bl - 0.005);
      var zC = w * kz;
      var bf = x > 0.5 ? 0 : x < -0.5 ? 1 : 0.5 - x;           // front → rear profile blend
      var ySh = yC - Math.max(0.035, (1 - kz) * 0.34);
      if (ySh < yb + 0.04) ySh = yb + 0.04;
      var pts = [{ q: [yb, 0], k: 'b' }];
      function P(u) { return tab(PF, u) * (1 - bf) + tab(PR, u) * bf; }
      pts.push({ q: [yb, w * P(0) * 0.86], k: 'b' });
      for (var j = 0; j <= 14; j++) { var u = j / 14; pts.push({ q: [yb + (ySh - yb) * u, w * P(u)], k: 'b' }); }
      var cuts = [0, pts.length - 1];
      var S = pts[pts.length - 1].q, zS = Math.max(S[1], zC + 0.005);
      S[1] = zS;
      cub(S, [1, 0], [yC, zC], [0.2, -1].map(function (v, i, a) { return v / Math.hypot(a[0], a[1]); }), 6, pts, 'b');
      cuts.push(pts.length - 1);
      if (!cabin) {
        var cen = x >= cfg.xWS ? Math.max(yb + 0.03, yC - tab(cfg.dip, x)) : top;
        if (x < cfg.xWS && x > cfg.xBL) cen = top;
        cub([yC, zC], [0, -1], [cen, 0], [0, -1], 10, pts, 'b');
      } else {
        var gt = sliceX(tg, x), gw = gt ? Math.min(Math.max(Math.abs(gt[0]), Math.abs(gt[1])), zC - 0.01) : zC * 0.8;
        gw = Math.max(gw, 0.1);
        var railY = top - Math.min(0.045, 0.3 * (top - bl)), gr = Math.max(0.08, gw * 0.86);
        var rt = sliceX(tr, x); if (rt) gr = Math.min(gw * 0.97, Math.max(gr, Math.max(Math.abs(rt[0]), Math.abs(rt[1])) + 0.03));
        cub([yC, zC], [0.15, -1], [bl, gw], [1, -0.12], 4, pts, 'b');
        cuts.push(pts.length - 1);
        var tdir = [railY - bl, gr - gw], tl = Math.hypot(tdir[0], tdir[1]) || 1;
        tdir = [tdir[0] / tl, tdir[1] / tl];
        cub([bl, gw], tdir, [railY, gr], tdir, 6, pts, 'gs');
        cuts.push(pts.length - 1);
        // roof crown: leave the cant rail along the glass tangent but never rise above the silhouette top
        // (an unclamped handle ballooned the 3D roof up to 0.07 m over the real height)
        cubD([railY, gr], tdir, Math.min(0.42 * Math.hypot(top - railY, gr), 0.85 * (top - railY) / Math.max(tdir[0], 1e-3)), [top, 0], [0, -1], gr * 0.55, 10, pts, 'gc');
      }
      // dense arc-length resample, carve wheel wells, then final resample to half+1
      // fixed vertex budget per run (body / side glass / roof crown) so vertex j lands on the same feature
      // at every station: no twisted quads, no faceting ripples along the flanks
      cuts.push(pts.length - 1);
      var hp = resampRuns(pts, half + 1, cuts, cabin ? [0.36, 0.10, 0.06, 0.22, 0.26] : [0.40, 0.12, 0.48]);
      var wl = null;
      wells.forEach(function (W) { var dx = x - W.x; if (Math.abs(dx) < W.r * 0.985) wl = { top: W.y + Math.sqrt(W.r * W.r - dx * dx), zIn: W.zIn }; });
      if (wl) {
        // snap the nearest vertex onto the arch line so the cut-out edge follows the arch circle, then step the skin in
        for (var c = 1; c < hp.length; c++) {
          var qa = hp[c - 1].q, qb = hp[c].q;
          if (qa[0] < wl.top && qb[0] >= wl.top) {
            var tt = (wl.top - qa[0]) / Math.max(1e-6, qb[0] - qa[0]), X = [wl.top, qa[1] + (qb[1] - qa[1]) * tt];
            if (tt > 0.5) hp[c].q = X; else hp[c - 1].q = [X[0] - 1e-4, X[1]];
            break;
          }
        }
        hp.forEach(function (d) { if (d.q[0] < wl.top - 2e-4 && d.q[1] > wl.zIn) d.q = [d.q[0], wl.zIn]; });
      }
      hp[0].q = [yb, 0]; hp[hp.length - 1].q = [hp[hp.length - 1].q[0], 0];
      var ring = hp.map(function (d) { return [r4(d.q[0]), r4(d.q[1])]; });
      var flags = hp.map(function (d) {
        var y = d.q[0], z = d.q[1];
        if (!cabin || y < bl + 0.012) return 0;
        if (d.k === 'gs') return inside(win, x, y) ? 1 : 0;
        if (d.k === 'gc') return (x > roofB[1] || x < roofB[0]) && z < gr * 0.86 ? 1 : (inside(win, x, y) && z > gr * 0.7 ? 1 : 0);
        return 0;
      });
      for (var m = half - 1; m >= 1; m--) { ring.push([ring[m][0], r4(-ring[m][1])]); flags.push(flags[m]); }
      out.push({ x: r4(x), ring: ring, belt: cabin ? r4(bl) : null, glass: flags });
    });
    return out;
  }
  function tireW(s) { var m = String(s).match(/(\d{3})\//); return m ? +m[1] / 1000 : 0.25; }
  /* Resample tagged points to n with a fixed vertex budget per run (cuts = run boundary indices, fr = budget
     fractions): lower flank / shoulder / [belt return / side glass / crown] or [top]. Vertex j then lands on the
     same feature at every station, so neighbouring rings never twist (no faceting ripples). */
  function resampRuns(pts, n, cuts, fr) {
    var cnt = fr.map(function (f) { return Math.max(2, Math.round((n - 1) * f)); }), tot = cnt.reduce(function (a, b) { return a + b; }, 0);
    cnt[cnt.length - 1] += (n - 1) - tot;
    var out = [pts[0]];
    for (var r = 0; r < cnt.length; r++) {
      var seg = pts.slice(cuts[r], cuts[r + 1] + 1);
      if (seg.length < 2) seg = [pts[cuts[r]], pts[Math.min(pts.length - 1, cuts[r] + 1)]];
      out = out.concat(resamp(seg, cnt[r] + 1).slice(1));
    }
    return out;
  }
  /* Arc-length resample of tagged points [{q:[y,z], k}] to n points (tags carried from the nearest source). */
  function resamp(pts, n) {
    var L = [0];
    for (var i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].q[0] - pts[i - 1].q[0], pts[i].q[1] - pts[i - 1].q[1]));
    var tot = L[L.length - 1] || 1, out = [], j = 0;
    for (var k = 0; k < n; k++) {
      var d = tot * k / (n - 1);
      while (j < pts.length - 2 && L[j + 1] < d) j++;
      var seg = (L[j + 1] - L[j]) || 1, t = Math.max(0, Math.min(1, (d - L[j]) / seg));
      out.push({ q: [pts[j].q[0] + (pts[j + 1].q[0] - pts[j].q[0]) * t, pts[j].q[1] + (pts[j + 1].q[1] - pts[j].q[1]) * t], k: t < 0.5 ? pts[j].k : pts[j + 1].k });
    }
    return out;
  }

  /* Slanted bar (parallelogram, rounded): bottom centre (a0, b0), top centre (a1, b1), width w across the first axis. */
  function bar(a0, b0, a1, b1, w, r) {
    var h = w / 2;
    return rpoly([[a0 - h, b0], [a0 + h, b0], [a1 + h, b1], [a1 - h, b1]], r == null ? Math.min(0.006, h * 0.8) : r);
  }

  /* ================================================================== */
  /* Ford Mustang GT Fastback (S650)                                     */
  /* ================================================================== */
  function mustangS650() {
    var ref = {
      length: 4.810, width: 1.915, height: 1.397, wheelbase: 2.720, trackF: 1.575, trackR: 1.643,
      frontOverhang: 0.925, rearOverhang: 1.165, wheelDiameter_in: 19,
      tireF: '255/40ZR19', tireR: '275/40ZR19', groundClearance: 0.130, rideHeight: 0.130, cd: 0.33, curbWeight_kg: 1738
    };
    var XF = 2.285, XR = -2.525, H = 1.397;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.36, y: rF, r: rF + 0.034, flare: 0.022 };
    var aR = { x: -1.36, y: rR, r: rR + 0.036, flare: 0.030 };
    var yb = 0.175;

    // fastback: windscreen base well back, roof peak over the B-pillar, long slope onto a short deck
    var roofLine = [[0.58, 0.990, 'c'], [0.20, 1.168], [-0.14, 1.330], [-0.42, H, 'h'], [-0.85, 1.362], [-1.30, 1.245], [-1.68, 1.112], [-1.92, 1.050, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.85, 0.178], [2.12, 0.168, 'c'], [2.19, 0.205], [2.228, 0.330],
      // shark nose: the grille face leans forward, its top edge is the leading point of the car
      [2.262, 0.500], [XF, 0.640, 'v'], [2.272, 0.715], [2.215, 0.770, 'c'],
      // long bonnet climbing to the cowl
      [1.90, 0.815], [1.40, 0.885], [0.90, 0.948]
    ].concat(roofLine, [
      [-2.20, 1.036], [-2.42, 1.040], [-2.470, 1.058, 'c'], [-2.500, 1.000, 'c'], [XR, 0.800, 'v'], [-2.515, 0.560], [-2.480, 0.330], [-2.40, 0.205, 'c'], [-2.06, yb, 'c']
    ]), 0.172);

    var doorGlass = [[0.43, 1.025, 'c'], [0.14, 1.170], [-0.12, 1.296], [-0.42, 1.345, 'h'], [-0.86, 1.312, 'c'], [-0.88, 1.052, 'c']];
    var quarterGlass = [[-0.950, 1.056, 'c'], [-0.940, 1.300, 'c'], [-1.18, 1.215], [-1.40, 1.125, 'c'], [-1.22, 1.086], [-1.05, 1.064]];
    var side = {
      body: body,
      // daylight opening only (frameless door glass, black B-pillar, small tapering quarter glass)
      greenhouse: loop([[0.462, 1.014, 'c'], [0.150, 1.176], [-0.12, 1.305], [-0.42, 1.354, 'h'], [-0.86, 1.322], [-1.20, 1.218], [-1.465, 1.112, 'c'],
        [-1.25, 1.078], [-0.90, 1.052], [-0.40, 1.034], [0.15, 1.020]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.58, 0.990, 'c'], [0.20, 1.168], [-0.14, 1.330, 'c'], [-0.12, 1.296, 'c'], [0.14, 1.170], [0.43, 1.025, 'c']])],
      doorCuts: [loop([[0.64, 0.262, 'c'], [0.646, 0.600], [0.620, 0.880], [0.520, 0.985]].concat(doorGlass, [[-0.950, 0.820], [-0.985, 0.272, 'c']]))],
      panelLines: [
        curve([[2.02, 0.760], [1.90, 0.560], [1.740, 0.420]]),            // front fascia / wing seam
        curve([[-1.80, 0.640], [-1.82, 0.47], [-1.84, 0.300]]),           // rear fascia seam behind the arch
        curve([[-2.10, 0.880], [-2.30, 0.880], [-2.505, 0.876]]),         // bumper top seam under the tri-bar lamps
        curve([[-1.93, 1.046], [-2.02, 1.012], [-2.30, 1.008], [-2.46, 1.020]]),   // deck-lid shut line
        curve([[2.22, 0.760], [1.60, 0.832], [0.70, 0.962]])              // bonnet shut line along the wing top
      ],
      characterLines: [
        curve([[2.00, 0.750], [1.50, 0.808], [0.90, 0.870], [0.20, 0.905]]),               // front wing crest
        // the S650 hip: a sharp crease leaving the door and kicking up over the rear wheel to the tail lamps
        curve([[-0.20, 0.840], [-0.90, 0.875], [-1.40, 0.925], [-1.90, 0.950], [-2.48, 0.930]]),
        curve([[0.62, 0.430], [0.00, 0.452], [-0.70, 0.500], [-1.00, 0.540]])               // lower door sculpt
      ],
      sill: rrect(-0.98, 0.172, 0.98, 0.215, 0.010),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.75, 0.180, 'c'], [1.95, 0.176], [2.12, 0.170, 'c'], [2.17, 0.196, 'c'], [1.95, 0.205], [1.755, 0.222, 'c']]),     // chin splitter
        loop([[-1.77, 0.182, 'c'], [-2.06, 0.180], [-2.40, 0.208, 'c'], [-2.44, 0.265, 'c'], [-2.06, 0.225], [-1.765, 0.225, 'c']]),  // rear valance
        loop([[0.98, 0.172, 'c'], [-0.98, 0.172, 'c'], [-0.985, 0.192, 'c'], [0.985, 0.192, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.14, -0.60], [-0.14, 0.60], [-1.10, 0.56], [-1.10, -0.56]], 0.07);
    var top = {
      // narrow nose, waist at the doors, wide rear hips
      body: sym([[XF, 0, 'v'], [2.270, 0.40], [2.200, 0.70], [2.050, 0.860], [1.70, 0.928], [1.36, 0.942, 'h'], [0.90, 0.930], [0.30, 0.912, 'h'],
        [-0.40, 0.922], [-1.00, 0.945], [-1.40, 0.9575, 'h'], [-1.95, 0.940], [-2.30, 0.880], [-2.475, 0.720], [-2.518, 0.45], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.62, 0, 'v'], [0.55, 0.640, 'c'], [0.10, 0.705], [-0.60, 0.700], [-1.30, 0.620], [-1.78, 0.480], [-1.91, 0.300], [-1.94, 0, 'v']], 1),
      hood: sym([[2.22, 0, 'v'], [2.16, 0.55], [2.02, 0.76, 'c'], [0.66, 0.72, 'c'], [0.60, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.93, 0, 'v'], [-1.95, 0.62, 'c'], [-2.43, 0.74, 'c'], [-2.47, 0, 'v']], 1),
      mirrors: pair(loop([[0.60, 0.905, 'c'], [0.57, 1.000], [0.51, 1.036], [0.42, 1.030], [0.38, 0.970], [0.385, 0.905, 'c']]), 1),
      // raised centre power bulge between two shallow bonnet valleys
      characterLines: pair(curve([[2.15, 0.26], [1.60, 0.28], [1.00, 0.30], [0.66, 0.31]]), 1)
    };

    // shark-nose trapezoid grille, wide at the top between the lamps, narrowing to the splitter
    var front = {
      body: sym([[0, H, 'h'], [0.42, 1.380], [0.56, 1.295], [0.66, 1.120], [0.72, 1.020], [0.84, 0.960], [0.925, 0.860],
        [0.9575, 0.680, 'v'], [0.950, 0.450], [0.920, 0.280], [0.860, 0.190, 'c'], [0.60, 0.170], [0, 0.165, 'h']], 0),
      greenhouse: sym([[0, 1.372, 'h'], [0.42, 1.356], [0.54, 1.280], [0.63, 1.120], [0.70, 1.030, 'c'], [0.36, 1.010], [0, 1.002, 'h']], 0),
      bumper: sym([[0, 0.660, 'h'], [0.45, 0.668], [0.80, 0.690], [0.925, 0.600], [0.950, 0.450], [0.920, 0.280], [0.860, 0.190, 'c'], [0.60, 0.170], [0, 0.165, 'h']], 0),
      characterLines: [
        curve([[-0.90, 0.85], [-0.70, 0.865, 'h'], [-0.50, 0.835], [-0.30, 0.842], [0, 0.858, 'h'], [0.30, 0.842], [0.50, 0.835], [0.70, 0.865, 'h'], [0.90, 0.85]]),
        curve([[-0.30, 0.842], [-0.26, 0.92], [-0.22, 0.990]]),
        curve([[0.30, 0.842], [0.26, 0.92], [0.22, 0.990]])
      ],
      grille: [rpoly([[-0.505, 0.705], [0.505, 0.705], [0.585, 0.560], [0.505, 0.290], [-0.505, 0.290], [-0.585, 0.560]], 0.03)],
      // tall corner brake-cooling intakes + slim lower splitter slot
      intakes: pair(rpoly([[0.655, 0.225], [0.835, 0.240], [0.880, 0.440], [0.705, 0.420]], 0.02), 0).concat([
        rpoly([[-0.48, 0.200], [0.48, 0.200], [0.45, 0.255], [-0.45, 0.255]], 0.015)
      ]),
      // slim lamps: inner end tucked against the grille top corner, outer end swept up onto the wing
      headlights: pair(loop([[0.505, 0.712, 'c'], [0.700, 0.768], [0.885, 0.805, 'c'], [0.905, 0.750], [0.850, 0.705], [0.620, 0.690, 'c']]), 0),
      // tri-bar DRL: three raked LED bars inside each lamp
      drl: [0, 1, 2].reduce(function (acc, k) {
        var z = 0.640 + k * 0.075;
        return acc.concat(pair(bar(z, 0.700 + k * 0.004, z + 0.034, 0.764 + k * 0.012, 0.020, 0.005), 0));
      }, []),
      splitter: rpoly([[-0.86, 0.165], [0.86, 0.165], [0.88, 0.188], [-0.88, 0.188]], 0.008),
      plateArea: rrect(-0.26, 0.305, 0.26, 0.415, 0.01),
      badgeArea: rrect(-0.10, 0.520, 0.10, 0.620, 0.01),
      badgeText: 'MUSTANG'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.42, 1.378], [0.54, 1.290], [0.60, 1.170], [0.66, 1.098], [0.80, 1.062], [0.90, 1.002], [0.948, 0.880],
        [0.9575, 0.700, 'v'], [0.950, 0.480], [0.920, 0.300], [0.860, 0.215, 'c'], [0, 0.205, 'h']], 0),
      greenhouse: sym([[0, 1.340, 'h'], [0.40, 1.320], [0.50, 1.240], [0.56, 1.140], [0.54, 1.112, 'c'], [0, 1.102, 'h']], 0),
      bumper: sym([[0, 0.660, 'h'], [0.60, 0.660], [0.90, 0.640], [0.950, 0.480], [0.920, 0.300], [0.860, 0.215, 'c'], [0, 0.205, 'h']], 0),
      panelLines: [curve([[-0.40, 0.860], [0, 0.856, 'h'], [0.40, 0.860]])],
      characterLines: [curve([[-0.94, 0.640], [-0.60, 0.662], [0, 0.668, 'h'], [0.60, 0.662], [0.94, 0.640]])],
      // tri-bar tail lamps: three vertical LED bars per side, each raked outward at the top
      // (first item: the gloss-black lamp panel the bars sit in, drawn under them)
      taillights: [{ path: sym([[0, 1.010, 'h'], [0.86, 1.008], [0.912, 0.990, 'c'], [0.912, 0.868, 'c'], [0, 0.866, 'h']], 0), paint: 'gloss-black' }].concat([0, 1, 2].reduce(function (acc, k) {
        var z = 0.555 + k * 0.118;
        return acc.concat(pair(bar(z, 0.880, z + 0.022, 0.998 - k * 0.010, 0.050, 0.010), 0));
      }, [])),
      diffuser: sym([[0, 0.330, 'h'], [0.40, 0.330], [0.78, 0.305, 'c'], [0.76, 0.215], [0, 0.205, 'h']], 0),
      exhaust: [0.56, 0.71, -0.56, -0.71].map(function (z) { return { shape: 'round', cx: z, cy: 0.272, w: 0.100, h: 0.100 }; }),
      plateArea: rrect(-0.26, 0.500, 0.26, 0.612, 0.01),
      badgeArea: rrect(-0.12, 0.900, 0.12, 0.968, 0.008),
      badgeText: 'MUSTANG',
      spoiler: sym([[0, 1.060, 'h'], [0.62, 1.060], [0.72, 1.040, 'c'], [0.70, 1.030, 'c'], [0, 1.032, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.60, 1.030, 'c'], [0.588, 1.100], [0.50, 1.118], [0.40, 1.090], [0.402, 1.040], [0.50, 1.024]]), 'body'),
      D('side', 'trim', rpoly([[-0.878, 1.050], [-0.865, 1.320], [-0.945, 1.312], [-0.952, 1.052]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.72, 0.890, -0.54, 0.912, 0.010), 'black'),
      D('side', 'trim', loop([[2.24, 0.760, 'c'], [2.10, 0.790], [1.96, 0.800], [1.99, 0.770], [2.15, 0.745]]), 'light'),          // headlamp wrap
      D('side', 'marker', rrect(2.08, 0.560, 2.16, 0.578, 0.006), 'light-amber'),
      D('side', 'trim', rpoly([[-2.30, 0.890], [-2.505, 0.884], [-2.500, 0.985], [-2.32, 0.995]], 0.008), 'gloss-black'),       // tail-lamp panel wrap
      D('side', 'trim', rrect(-2.48, 0.900, -2.42, 0.980, 0.006), 'light-red'),
      D('side', 'marker', rrect(-2.46, 0.560, -2.40, 0.578, 0.006), 'light-red'),
      D('side', 'vent', rpoly([[1.86, 0.250], [2.10, 0.250], [2.14, 0.420], [1.94, 0.410]], 0.02), 'grille'),                // corner intake seen from the side
      D('top', 'fuelCap', rrect(-1.82, -0.952, -1.68, -0.900, 0.012), 'body'),                                          // capless filler, driver's rear quarter
      D('top', 'wiper', rrect(0.62, -0.05, 0.66, 0.58, 0.01), 'black'),
      D('top', 'trim', rrect(-2.522, -0.62, -2.495, 0.62, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.47, -0.62, -2.43, 0.62, 0.008), 'body')
    ].concat(
      // GT bonnet: twin heat extractors either side of the power bulge
      pairD('top', 'vent', rpoly([[1.92, 0.36], [1.92, 0.52], [1.56, 0.54], [1.56, 0.38]], 0.025), 'gloss-black', 1),
      pairD('top', 'trim', loop([[2.24, 0.48, 'c'], [2.17, 0.74], [2.06, 0.84, 'c'], [2.10, 0.70], [2.19, 0.48, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.72, 1.010, 'c'], [0.86, 1.020], [1.02, 1.032], [1.036, 1.080], [0.97, 1.115], [0.88, 1.110], [0.82, 1.050], [0.72, 1.040, 'c']]), 'body', 0),
      // horizontal grille bars (none across the plate)
      [0.45, 0.50, 0.55, 0.60, 0.65].map(function (y) { return D('front', 'trim', rrect(-0.50, y, 0.50, y + 0.010, 0.004), 'gloss-black'); }),
      pairD('front', 'vent', rpoly([[0.38, 0.880], [0.50, 0.890], [0.50, 0.902], [0.38, 0.892]], 0.004), 'gloss-black', 0),   // bonnet extractors seen head-on
      [
        D('front', 'wiper', rpoly([[-0.05, 1.012], [0.58, 1.032], [0.58, 1.042], [-0.05, 1.024]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.08, 1.046, 0.08, 1.056, 0.004), 'light-red')        // CHMSL in the lip spoiler
      ],
      [0, 0.22, -0.22].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.21, z + 0.008, 0.32, 0.004), 'black'); }),
      pairD('rear', 'trim', rrect(0.860, 0.420, 0.900, 0.480, 0.008), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.96, 1.040, 'c'], [1.02, 1.032], [1.036, 1.080], [0.97, 1.115], [0.96, 1.110, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.172, xWS: 0.58, xBL: -1.92,
      belt: [[0.58, 0.990], [0.46, 1.016], [0.15, 1.020], [-0.40, 1.034], [-0.90, 1.052], [-1.25, 1.078], [-1.46, 1.110], [-1.70, 1.100], [-1.92, 1.045]],
      crest: [[2.28, 0.62, 0.60], [2.10, 0.79, 0.70], [1.70, 0.855, 0.74], [1.20, 0.905, 0.80], [0.60, 0.950, 0.88], [-0.40, 0.985, 0.92],
        [-1.20, 1.010, 0.90], [-1.80, 1.020, 0.82], [-2.20, 1.020, 0.74], [-2.52, 0.980, 0.62]],
      dip: [[2.29, 0.0], [2.18, 0.03], [2.00, 0.05], [1.50, 0.05], [1.00, 0.03], [0.60, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'ford-mustang-gt-s650', make: 'Ford', name: 'Mustang GT Fastback', gen: 'S650', years: '2024–', style: 'coupe',
      look: { head: 'slim-led', tail: 'vertical', grille: 'honeycomb' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      color: '#1d3f8f', colorName: 'Vapor Blue',
      wheel: { style: 'split-5', spokes: 10, caliper: '#c8102e' },   // Performance Pack 19 in wheel, red Brembo callipers
      badgeText: 'MUSTANG',
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim angular LED headlamps swept up onto the wings, each with the three-bar raked DRL signature.',
        taillights: 'Tri-bar tail lamps: three vertical LED bars per side, raked outward, set in a full-width gloss-black tail panel.',
        grille: 'Shark-nose trapezoid grille leaning forward, wide at the top between the lamps, with corner brake intakes below.',
        notes: 'Long-bonnet / short-deck fastback with twin bonnet heat extractors (GT), hip crease kicking up over the rear wheel, small tapering quarter glass, quad round tailpipes.'
      },
      sources: ['Ford Mustang S650 specifications (Ford media)', 'Wikipedia: Ford Mustang (seventh generation)']
    };
  }

  /* ================================================================== */
  /* Chevrolet Camaro ZL1 (6th generation, 2019 facelift)                */
  /* ================================================================== */
  function camaroZL1() {
    var ref = {
      length: 4.783, width: 1.897, height: 1.344, wheelbase: 2.811, trackF: 1.610, trackR: 1.591,
      frontOverhang: 0.935, rearOverhang: 1.037, wheelDiameter_in: 20,
      tireF: '285/30ZR20', tireR: '305/30ZR20', groundClearance: 0.115, rideHeight: 0.115, cd: 0.35, curbWeight_kg: 1760
    };
    var XF = 2.3405, XR = -2.4425, H = 1.344;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.4055, y: rF, r: rF + 0.032, flare: 0.024 };
    var aR = { x: -1.4055, y: rR, r: rR + 0.032, flare: 0.032 };
    var yb = 0.165;

    // chopped roof: low, short greenhouse sitting on very tall body sides
    var roofLine = [[0.50, 0.975, 'c'], [0.10, 1.160], [-0.25, 1.312], [-0.55, H, 'h'], [-0.95, 1.322], [-1.40, 1.215], [-1.82, 1.075, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.95, 0.168], [2.25, 0.150, 'c'], [2.300, 0.200], [2.330, 0.300],
      // blunt, upright nose
      [XF, 0.450, 'v'], [2.332, 0.600], [2.312, 0.720], [2.270, 0.790, 'c'],
      [2.00, 0.828], [1.50, 0.880], [1.00, 0.930]
    ].concat(roofLine, [
      [-2.15, 1.064], [-2.36, 1.068], [-2.400, 1.090, 'c'], [-2.425, 1.032, 'c'], [XR, 0.800, 'v'], [-2.432, 0.550], [-2.400, 0.320], [-2.32, 0.195, 'c'], [-1.98, yb, 'c']
    ]), 0.165);

    var doorGlass = [[0.37, 1.012, 'c'], [0.07, 1.158], [-0.25, 1.282], [-0.55, 1.303, 'h'], [-0.90, 1.285, 'c'], [-0.92, 1.062, 'c']];
    var side = {
      body: body,
      // slit daylight opening: door glass + black B-pillar + short quarter glass
      greenhouse: loop([[0.400, 1.002, 'c'], [0.080, 1.165], [-0.25, 1.290], [-0.55, 1.312, 'h'], [-0.95, 1.288], [-1.25, 1.192], [-1.425, 1.122, 'c'],
        [-1.20, 1.090], [-0.80, 1.068], [-0.20, 1.045], [0.20, 1.020]]),
      windows: [loop(doorGlass), loop([[-0.990, 1.066, 'c'], [-0.980, 1.278, 'c'], [-1.22, 1.188], [-1.385, 1.126, 'c'], [-1.20, 1.096]])],
      pillars: [loop([[0.50, 0.975, 'c'], [0.10, 1.160], [-0.25, 1.312, 'c'], [-0.25, 1.282, 'c'], [0.07, 1.158], [0.37, 1.012, 'c']])],
      doorCuts: [loop([[0.66, 0.262, 'c'], [0.665, 0.600], [0.640, 0.880], [0.520, 0.972]].concat(doorGlass, [[-1.000, 0.800], [-1.030, 0.272, 'c']]))],
      panelLines: [
        curve([[2.10, 0.780], [1.95, 0.560], [1.790, 0.410]]),            // front fascia / wing seam
        curve([[-1.84, 0.640], [-1.86, 0.47], [-1.88, 0.300]]),           // rear fascia seam
        curve([[-2.14, 0.830], [-2.30, 0.830], [-2.430, 0.828]]),         // tail-panel / bumper seam
        curve([[-1.83, 1.068], [-1.95, 1.040], [-2.25, 1.038], [-2.39, 1.050]]),   // deck-lid shut line
        curve([[2.27, 0.782], [1.60, 0.858], [0.62, 0.952]])              // bonnet shut line
      ],
      characterLines: [
        curve([[2.15, 0.770], [1.60, 0.820], [1.00, 0.866], [0.40, 0.890]]),               // front wing crest
        // power line: sweeps from the door into the muscular rear haunch and on to the tail
        curve([[0.30, 0.800], [-0.40, 0.830], [-1.00, 0.880], [-1.50, 0.930], [-2.00, 0.955], [-2.43, 0.940]]),
        curve([[0.64, 0.440], [-0.10, 0.462], [-0.80, 0.520], [-1.05, 0.560]])
      ],
      sill: rrect(-1.02, 0.165, 1.02, 0.208, 0.010),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.78, 0.170, 'c'], [1.95, 0.168], [2.25, 0.150, 'c'], [2.29, 0.180, 'c'], [1.95, 0.196], [1.785, 0.215, 'c']]),    // carbon splitter
        loop([[-1.79, 0.170, 'c'], [-1.98, 0.168], [-2.32, 0.198, 'c'], [-2.37, 0.255, 'c'], [-1.98, 0.215], [-1.785, 0.215, 'c']]),
        loop([[1.02, 0.165, 'c'], [-1.02, 0.165, 'c'], [-1.025, 0.186, 'c'], [1.025, 0.186, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.25, -0.56], [-0.25, 0.56], [-1.15, 0.52], [-1.15, -0.52]], 0.07);
    var top = {
      body: sym([[XF, 0, 'v'], [2.328, 0.40], [2.270, 0.72], [2.120, 0.860], [1.80, 0.925], [1.4055, 0.938, 'h'], [0.90, 0.925], [0.30, 0.905, 'h'],
        [-0.40, 0.915], [-1.00, 0.936], [-1.4055, 0.9485, 'h'], [-1.95, 0.935], [-2.28, 0.880], [-2.405, 0.720], [-2.438, 0.45], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.52, 0, 'v'], [0.45, 0.620, 'c'], [0.00, 0.680], [-0.70, 0.672], [-1.35, 0.600], [-1.72, 0.480], [-1.83, 0.300], [-1.85, 0, 'v']], 1),
      hood: sym([[2.28, 0, 'v'], [2.22, 0.55], [2.08, 0.76, 'c'], [0.55, 0.72, 'c'], [0.50, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.84, 0, 'v'], [-1.86, 0.62, 'c'], [-2.36, 0.74, 'c'], [-2.40, 0, 'v']], 1),
      mirrors: pair(loop([[0.52, 0.895, 'c'], [0.49, 0.990], [0.43, 1.026], [0.34, 1.020], [0.30, 0.960], [0.305, 0.895, 'c']]), 1),
      characterLines: pair(curve([[2.20, 0.30], [1.60, 0.32], [1.00, 0.34], [0.56, 0.35]]), 1)
    };

    var front = {
      body: sym([[0, H, 'h'], [0.40, 1.330], [0.53, 1.258], [0.62, 1.100], [0.70, 1.018], [0.84, 0.958], [0.925, 0.860],
        [0.9485, 0.660, 'v'], [0.940, 0.420], [0.910, 0.260], [0.850, 0.172, 'c'], [0.60, 0.155], [0, 0.150, 'h']], 0),
      greenhouse: sym([[0, 1.322, 'h'], [0.40, 1.308], [0.51, 1.240], [0.60, 1.100], [0.67, 1.012, 'c'], [0.34, 0.992], [0, 0.985, 'h']], 0),
      bumper: sym([[0, 0.700, 'h'], [0.45, 0.705], [0.80, 0.722], [0.920, 0.640], [0.940, 0.420], [0.910, 0.260], [0.850, 0.172, 'c'], [0.60, 0.155], [0, 0.150, 'h']], 0),
      characterLines: [
        curve([[-0.90, 0.85], [-0.70, 0.858, 'h'], [-0.45, 0.826], [0, 0.820, 'h'], [0.45, 0.826], [0.70, 0.858, 'h'], [0.90, 0.85]]),
        curve([[-0.18, 0.822], [-0.16, 0.90], [-0.14, 0.975]]),
        curve([[0.18, 0.822], [0.16, 0.90], [0.14, 0.975]])
      ],
      // two-tier face: thin upper slot between the lamps, huge open lower grille (ZL1: no bowtie, ducted for cooling)
      grille: [
        rpoly([[-0.42, 0.705], [0.42, 0.705], [0.40, 0.772], [-0.40, 0.772]], 0.015),
        rpoly([[-0.62, 0.300], [0.62, 0.300], [0.70, 0.480], [0.62, 0.635], [-0.62, 0.635], [-0.70, 0.480]], 0.03)
      ],
      intakes: pair(rpoly([[0.745, 0.220], [0.885, 0.240], [0.905, 0.520], [0.785, 0.500]], 0.02), 0).concat([
        rpoly([[-0.52, 0.200], [0.52, 0.200], [0.49, 0.262], [-0.49, 0.262]], 0.015)
      ]),
      // slit lamps: flat top edge rising gently to the outer corner
      headlights: pair(loop([[0.425, 0.702, 'c'], [0.425, 0.768, 'c'], [0.66, 0.786], [0.895, 0.808, 'c'], [0.915, 0.765, 'c'], [0.70, 0.726]]), 0),
      drl: pair(rpoly([[0.445, 0.758], [0.880, 0.796], [0.880, 0.806], [0.445, 0.768]], 0.003), 0),
      splitter: rpoly([[-0.88, 0.150], [0.88, 0.150], [0.90, 0.176], [-0.90, 0.176]], 0.008),
      plateArea: rrect(-0.26, 0.335, 0.26, 0.445, 0.01),
      badgeArea: rrect(-0.09, 0.648, 0.09, 0.692, 0.01),
      badgeText: 'ZL1'
    };

    // tail: each side carries two rectangular LED lamps in a black housing
    var rear = {
      body: sym([[0, H, 'h'], [0.40, 1.328], [0.50, 1.250], [0.56, 1.150], [0.62, 1.105], [0.80, 1.085], [0.90, 1.030], [0.940, 0.900],
        [0.9485, 0.700, 'v'], [0.940, 0.460], [0.910, 0.300], [0.850, 0.200, 'c'], [0, 0.190, 'h']], 0),
      greenhouse: sym([[0, 1.300, 'h'], [0.38, 1.285], [0.47, 1.220], [0.53, 1.120], [0.51, 1.095, 'c'], [0, 1.088, 'h']], 0),
      bumper: sym([[0, 0.620, 'h'], [0.60, 0.620], [0.90, 0.600], [0.940, 0.460], [0.910, 0.300], [0.850, 0.200, 'c'], [0, 0.190, 'h']], 0),
      panelLines: [curve([[-0.36, 0.842], [0, 0.838, 'h'], [0.36, 0.842]])],
      characterLines: [curve([[-0.93, 0.600], [-0.60, 0.622], [0, 0.628, 'h'], [0.60, 0.622], [0.93, 0.600]])],
      taillights: [].concat(
        pair(rpoly([[0.36, 0.855], [0.915, 0.862], [0.925, 1.000], [0.37, 1.006]], 0.02), 0).map(function (p) { return { path: p, paint: 'gloss-black' }; }),
        pair(rpoly([[0.395, 0.875], [0.630, 0.878], [0.630, 0.988], [0.400, 0.990]], 0.018), 0),
        pair(rpoly([[0.660, 0.878], [0.895, 0.882], [0.902, 0.985], [0.660, 0.988]], 0.018), 0)
      ),
      diffuser: sym([[0, 0.340, 'h'], [0.40, 0.340], [0.78, 0.310, 'c'], [0.76, 0.200], [0, 0.190, 'h']], 0),
      exhaust: [0.50, 0.64, -0.50, -0.64].map(function (z) { return { shape: 'round', cx: z, cy: 0.268, w: 0.105, h: 0.105 }; }),
      plateArea: rrect(-0.26, 0.660, 0.26, 0.770, 0.01),
      badgeArea: rrect(-0.10, 0.900, 0.10, 0.960, 0.008),
      badgeText: 'CHEVROLET',
      // ZL1 deck-lid spoiler
      spoiler: sym([[0, 1.100, 'h'], [0.66, 1.100], [0.74, 1.076, 'c'], [0.72, 1.066, 'c'], [0, 1.068, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.52, 1.020, 'c'], [0.508, 1.090], [0.42, 1.106], [0.31, 1.078], [0.312, 1.030], [0.42, 1.014]]), 'body'),
      D('side', 'trim', rpoly([[-0.918, 1.062], [-0.905, 1.292], [-0.985, 1.282], [-0.990, 1.065]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.80, 0.900, -0.62, 0.922, 0.010), 'body'),
      D('side', 'vent', rpoly([[0.86, 0.560], [1.06, 0.585], [1.08, 0.620], [0.88, 0.598]], 0.010), 'black'),          // wing vent behind the front wheel
      D('side', 'trim', loop([[2.29, 0.782, 'c'], [2.16, 0.812], [2.02, 0.822], [2.05, 0.792], [2.20, 0.772]]), 'light'),
      D('side', 'marker', rrect(2.20, 0.560, 2.28, 0.578, 0.006), 'light-amber'),
      D('side', 'trim', loop([[-2.30, 0.995, 'c'], [-2.415, 0.992], [-2.425, 0.880, 'c'], [-2.32, 0.885, 'c']]), 'light-red'),
      D('side', 'marker', rrect(-2.38, 0.560, -2.32, 0.578, 0.006), 'light-red'),
      D('side', 'vent', rpoly([[1.95, 0.240], [2.24, 0.240], [2.28, 0.510], [2.02, 0.500]], 0.02), 'grille'),
      D('top', 'fuelCap', rrect(-1.86, -0.944, -1.72, -0.894, 0.012), 'body'),
      D('top', 'vent', sym([[1.95, 0, 'v'], [1.92, 0.24, 'c'], [1.50, 0.26, 'c'], [1.48, 0, 'v']], 1), 'carbon'),        // carbon bonnet extractor
      D('top', 'wiper', rrect(0.54, -0.05, 0.58, 0.58, 0.01), 'black'),
      D('top', 'trim', rrect(-2.440, -0.62, -2.412, 0.62, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.40, -0.66, -2.35, 0.66, 0.008), 'body')
    ].concat(
      pairD('top', 'trim', loop([[2.30, 0.50, 'c'], [2.24, 0.74], [2.12, 0.85, 'c'], [2.16, 0.70], [2.26, 0.50, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.70, 0.995, 'c'], [0.84, 1.005], [1.00, 1.018], [1.014, 1.066], [0.95, 1.100], [0.86, 1.095], [0.80, 1.035], [0.70, 1.025, 'c']]), 'body', 0),
      // body-colour bar splitting the upper slot from the lower grille, plus horizontal mesh bars
      [D('front', 'trim', rpoly([[-0.62, 0.648], [0.62, 0.648], [0.60, 0.690], [-0.60, 0.690]], 0.008), 'body')],
      [0.470, 0.530, 0.590].map(function (y) { return D('front', 'trim', rrect(-0.64, y, 0.64, y + 0.010, 0.004), 'gloss-black'); }),
      [D('front', 'vent', rpoly([[-0.30, 0.826], [0.30, 0.826], [0.27, 0.838], [-0.27, 0.838]], 0.004), 'carbon'),          // extractor lip seen head-on
        D('front', 'wiper', rpoly([[-0.05, 0.996], [0.56, 1.014], [0.56, 1.024], [-0.05, 1.008]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.08, 1.082, 0.08, 1.092, 0.004), 'light-red')],
      [0, 0.22, -0.22].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.20, z + 0.008, 0.33, 0.004), 'black'); }),
      pairD('rear', 'trim', rrect(0.860, 0.400, 0.900, 0.460, 0.008), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.95, 1.020, 'c'], [1.00, 1.018], [1.014, 1.066], [0.95, 1.100], [0.95, 1.095, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.50, xBL: -1.82,
      belt: [[0.50, 0.975], [0.40, 1.004], [0.20, 1.020], [-0.20, 1.045], [-0.80, 1.068], [-1.20, 1.090], [-1.42, 1.122], [-1.65, 1.120], [-1.82, 1.075]],
      crest: [[2.34, 0.45, 0.60], [2.20, 0.80, 0.70], [1.80, 0.850, 0.76], [1.20, 0.900, 0.82], [0.50, 0.960, 0.90], [-0.40, 1.000, 0.94],
        [-1.20, 1.030, 0.92], [-1.80, 1.050, 0.84], [-2.20, 1.050, 0.76], [-2.44, 1.000, 0.64]],
      dip: [[2.34, 0.0], [2.25, 0.03], [2.05, 0.05], [1.50, 0.05], [0.90, 0.03], [0.50, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'chevrolet-camaro-zl1-2019', make: 'Chevrolet', name: 'Camaro ZL1', gen: '6th gen', years: '2019–2024', style: 'coupe',
      look: { head: 'slim-led', tail: 'slim', grille: 'honeycomb' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      color: '#b31b1b', colorName: 'Red Hot',
      wheel: { style: 'split-5', spokes: 10, caliper: '#c8102e' },   // forged 20 in, red Brembo callipers
      badgeText: 'ZL1',
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slit LED headlamps with a flat top edge and a full-length LED light guide, flanking a thin upper grille slot.',
        taillights: 'Two rectangular LED lamps per side in a black housing, under a deck-lid spoiler.',
        grille: 'Two-tier face: thin upper slot and a huge open lower grille split by a body-colour bar, carbon splitter and corner brake ducts.',
        notes: 'Chopped roof with a slit greenhouse over very tall body sides, carbon bonnet extractor, power line sweeping into big rear haunches, quad round tailpipes.'
      },
      sources: ['Chevrolet Camaro ZL1 2019 specifications (Chevrolet newsroom)', 'auto-data.net / encyCARpedia ZL1 coupe dimensions']
    };
  }

  /* Per-vertex paint for explicit sections: fn(x, y, z) → paint id (null/undefined = 'body'). */
  function paintSections(secs, fn) {
    secs.forEach(function (s) { s.paint = s.ring.map(function (q) { return fn(s.x, q[0], Math.abs(q[1])) || 'body'; }); });
    return secs;
  }
  /* ---- Hand-built explicit sections for the boxy / sharp-edged cars (Jeep, Ford GT, Corvette) ----
     ringFn(x) → { h: [[y, z, glass?, paint?] × HK] from the bottom centre up the right side to the roof centre, belt }.
     Every station uses the same slot layout, so vertex j is the same feature along the car (crisp creases come from
     doubled vertices a few mm apart). Wheel wells are carved inboard of the tyres; the left half is mirrored. */
  var HK = 21;   // half-ring points → 40-vertex full rings
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function smooth01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function wellsOf(aF, aR, ref) {
    return [[aF, ref.trackF, tireW(ref.tireF)], [aR, ref.trackR, tireW(ref.tireR)]].map(function (A) {
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - A[2] / 2 - 0.02 };
    });
  }
  function wellAt(wells, x) {
    for (var i = 0; i < wells.length; i++) {
      var W = wells[i], dx = x - W.x;
      if (Math.abs(dx) < W.r * 0.985) return { top: W.y + Math.sqrt(W.r * W.r - dx * dx), zIn: W.zIn, W: W };
    }
    return null;
  }
  function blendRing(A, B, t) {
    return { h: A.h.map(function (q, i) { var p = B.h[i]; return [lerp(q[0], p[0], t), lerp(q[1], p[1], t), t < 0.5 ? q[2] : p[2], t < 0.5 ? q[3] : p[3]]; }),
      belt: t < 0.5 ? A.belt : B.belt };
  }
  /* Stations: every `step` from x0 to x1 plus the extra x values (sorted, de-duplicated at 2 mm). */
  function stationsX(x0, x1, step, extra) {
    var xs = (extra || []).slice();
    for (var x = x0; x <= x1 + 1e-9; x += step) xs.push(x);
    xs.push(x1);
    xs = xs.filter(function (v) { return v >= x0 - 1e-9 && v <= x1 + 1e-9; }).sort(function (a, b) { return a - b; });
    return xs.filter(function (v, i) { return i === 0 || v - xs[i - 1] > 0.002; });
  }
  function ringSections(xs, ringFn, wells) {
    return xs.map(function (x) {
      var R = ringFn(x), h = R.h.map(function (q) { return q.slice(); });
      if (h.length !== HK) throw new Error('pack-usa ring at x=' + x + ' has ' + h.length + ' points');
      var wl = R.noWell ? null : wellAt(wells, x);
      if (wl) h.forEach(function (q) { if (q[0] < wl.top - 2e-4 && q[1] > wl.zIn) q[1] = wl.zIn; });
      h[0][1] = 0; h[HK - 1][1] = 0;
      var ring = h.map(function (q) { return [r4(q[0]), r4(Math.max(0, q[1]))]; });
      var glass = h.map(function (q) { return q[2] ? 1 : 0; }), paint = h.map(function (q) { return q[3] || 'body'; });
      for (var m = HK - 2; m >= 1; m--) { ring.push([ring[m][0], r4(-ring[m][1])]); glass.push(glass[m]); paint.push(paint[m]); }
      var o = { x: r4(x), ring: ring, belt: R.belt == null ? null : r4(R.belt), paint: paint };
      if (glass.some(Boolean)) o.glass = glass;
      return o;
    });
  }

  /* Side-view flare (Jeep style): squared outer edge round a circular wheel opening. */
  function squareFlare(a, yb, outer) {
    var x0 = archX(a, yb, -1), x1 = archX(a, yb, +1);
    var s0 = archAng(a, x0, yb), s1 = archAng(a, x1, yb) - 360;
    var segs = [{ t: 'M', p: [P2(x0, yb)] }].concat(arcSegs(a.x, a.y, a.r, s0, s1));
    outer.forEach(function (q) { segs.push({ t: 'L', p: [P2(q[0], q[1])] }); });
    segs.push({ t: 'Z', p: [] });
    return segs;
  }

  /* ================================================================== */
  /* Chevrolet Corvette Stingray (C8, 2020–) — mid-engine                */
  /* ================================================================== */
  function corvetteC8() {
    var ref = {
      length: 4.630, width: 1.934, height: 1.234, wheelbase: 2.722, trackF: 1.647, trackR: 1.590,
      frontOverhang: 1.035, rearOverhang: 0.873, wheelDiameter_in: 19,
      tireF: '245/35ZR19', tireR: '305/30ZR20', groundClearance: 0.096, rideHeight: 0.096, cd: 0.35, curbWeight_kg: 1604
    };
    var XF = 2.396, XR = -2.234, H = 1.234;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.361, y: rF, r: rF + 0.034, flare: 0.020 };
    var aR = { x: -1.361, y: rR, r: rR + 0.034, flare: 0.026 };
    var yb = 0.150;

    // cab-forward: low pointed nose, short bonnet, screen base just behind the front wheel, long engine deck
    var roofLine = [[0.84, 0.820, 'c'], [0.45, 1.000], [0.05, 1.170], [-0.30, H, 'h'], [-0.70, 1.218], [-1.10, 1.175], [-1.60, 1.125], [-2.02, 1.090]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.90, 0.128], [2.30, 0.110, 'c'], [2.360, 0.150], [2.388, 0.260],
      [XF, 0.360, 'v'], [2.380, 0.430], [2.310, 0.475, 'c'],
      [2.05, 0.560], [1.70, 0.645], [1.30, 0.725]
    ].concat(roofLine, [
      // ducktail lip, then the blunt angular tail face
      [-2.150, 1.102, 'c'], [-2.215, 1.055, 'c'], [XR, 0.820, 'v'], [-2.226, 0.560], [-2.200, 0.320], [-2.140, 0.190, 'c'], [-1.85, 0.140, 'c']
    ]), 0.118);

    var doorGlass = [[0.760, 0.860, 'c'], [0.42, 1.005], [0.05, 1.150], [-0.30, 1.205, 'h'], [-0.580, 1.180, 'c'], [-0.470, 0.930, 'c'], [0.10, 0.880]];
    var side = {
      body: body,
      greenhouse: loop([[0.800, 0.845, 'c'], [0.43, 1.012], [0.05, 1.162], [-0.30, 1.218, 'h'], [-0.70, 1.196], [-1.080, 1.105, 'c'], [-0.620, 0.912, 'c'], [0.10, 0.866]]),
      windows: [loop(doorGlass)],
      pillars: [loop([[0.84, 0.820, 'c'], [0.45, 1.000], [0.05, 1.170, 'c'], [0.05, 1.150, 'c'], [0.42, 1.005], [0.760, 0.860, 'c']])],
      // the door ends in the big side intake ahead of the rear wheel
      doorCuts: [loop([[0.990, 0.190, 'c'], [0.995, 0.520], [0.930, 0.760], [0.84, 0.822, 'c'], [0.05, 1.172], [-0.30, 1.226, 'h'], [-0.600, 1.200, 'c'],
        [-0.585, 0.860, 'c'], [-0.365, 0.300, 'c'], [-0.340, 0.190, 'c']])],
      panelLines: [
        curve([[2.25, 0.520], [2.10, 0.420], [1.95, 0.300]]),                    // front fascia seam
        curve([[2.30, 0.500], [1.80, 0.630], [1.20, 0.745], [0.86, 0.812]]),       // frunk lid shut line
        curve([[-1.08, 1.160], [-1.50, 1.112], [-1.95, 1.082], [-2.12, 1.085]]),   // engine hatch shut line
        curve([[-1.90, 0.700], [-1.95, 0.480], [-1.96, 0.300]])                   // rear fascia seam behind the arch
      ],
      characterLines: [
        // sharp blade crease from the front wheel along the door, drawn into the side intake
        curve([[1.70, 0.600], [1.20, 0.590], [0.60, 0.565], [0.00, 0.560], [-0.30, 0.640], [-0.56, 0.800]]),
        curve([[2.30, 0.505], [1.80, 0.620], [1.20, 0.705]]),                    // front wing top
        curve([[-1.10, 0.920], [-1.60, 0.950], [-2.00, 0.975], [-2.22, 0.975]])   // rear haunch crest into the tail lamps
      ],
      sill: rrect(-0.98, 0.118, 0.98, 0.160, 0.010),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.72, 0.130, 'c'], [1.90, 0.128], [2.30, 0.110, 'c'], [2.34, 0.140, 'c'], [1.95, 0.160], [1.72, 0.175, 'c']]),
        loop([[-1.72, 0.140, 'c'], [-1.85, 0.140], [-2.14, 0.190, 'c'], [-2.18, 0.260, 'c'], [-1.90, 0.200], [-1.72, 0.190, 'c']]),
        loop([[0.98, 0.118, 'c'], [-0.98, 0.118, 'c'], [-0.985, 0.140, 'c'], [0.985, 0.140, 'c']])
      ]
    };

    var top = {
      // pointed nose, pinched cockpit, the widest point over the rear wheels
      body: sym([[XF, 0, 'v'], [2.380, 0.300], [2.320, 0.560], [2.180, 0.770], [1.92, 0.890], [1.45, 0.940], [1.00, 0.925], [0.40, 0.905, 'h'],
        [-0.30, 0.920], [-0.90, 0.955], [-1.361, 0.967, 'h'], [-1.85, 0.957], [-2.100, 0.905], [-2.205, 0.720], [-2.230, 0.420], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.84, 0, 'v'], [0.76, 0.600, 'c'], [0.30, 0.690], [-0.30, 0.680], [-0.70, 0.600], [-0.82, 0.480], [-0.85, 0, 'v']], 1),
      hood: sym([[2.33, 0, 'v'], [2.28, 0.48], [2.10, 0.72, 'c'], [0.88, 0.70, 'c'], [0.86, 0, 'v']], 1),
      roof: rpoly([[0.02, -0.56], [0.02, 0.56], [-0.74, 0.54], [-0.74, -0.54]], 0.06),        // removable targa panel
      deck: sym([[-0.95, 0, 'v'], [-0.98, 0.62, 'c'], [-2.14, 0.74, 'c'], [-2.17, 0, 'v']], 1),
      mirrors: pair(loop([[0.72, 0.900, 'c'], [0.69, 0.990], [0.62, 1.030], [0.53, 1.022], [0.50, 0.960], [0.51, 0.900, 'c']]), 1),
      characterLines: pair(curve([[2.25, 0.36], [1.70, 0.40], [1.20, 0.44], [0.90, 0.46]]), 1)
    };

    var front = {
      body: sym([[0, H, 'h'], [0.36, 1.220], [0.50, 1.140], [0.62, 0.960], [0.72, 0.840], [0.86, 0.760], [0.940, 0.660],
        [0.967, 0.500, 'v'], [0.955, 0.320], [0.920, 0.180], [0.860, 0.122, 'c'], [0.50, 0.112], [0, 0.110, 'h']], 0),
      greenhouse: sym([[0, 1.205, 'h'], [0.36, 1.192], [0.48, 1.120], [0.60, 0.950], [0.660, 0.870, 'c'], [0.30, 0.840], [0, 0.835, 'h']], 0),
      bumper: sym([[0, 0.430, 'h'], [0.55, 0.445], [0.85, 0.490], [0.935, 0.420], [0.955, 0.320], [0.920, 0.180], [0.860, 0.122, 'c'], [0.50, 0.112], [0, 0.110, 'h']], 0),
      characterLines: [
        curve([[-0.94, 0.66], [-0.72, 0.640], [-0.40, 0.560], [0, 0.540, 'h'], [0.40, 0.560], [0.72, 0.640], [0.94, 0.66]]),
        curve([[-0.36, 0.570], [-0.30, 0.700], [-0.24, 0.830]]),
        curve([[0.36, 0.570], [0.30, 0.700], [0.24, 0.830]])
      ],
      // wide central mesh opening under the nose, big corner intakes
      grille: [rpoly([[-0.50, 0.165], [0.50, 0.165], [0.58, 0.300], [0.50, 0.385], [-0.50, 0.385], [-0.58, 0.300]], 0.03)],
      intakes: pair(rpoly([[0.640, 0.150], [0.880, 0.170], [0.925, 0.410], [0.820, 0.455], [0.640, 0.380]], 0.03), 0),
      // slim angular lamps sweeping up and out over the front wings
      headlights: pair(loop([[0.380, 0.470, 'c'], [0.600, 0.505], [0.880, 0.610, 'c'], [0.915, 0.575], [0.820, 0.500], [0.580, 0.445, 'c']]), 0),
      drl: pair(rpoly([[0.400, 0.476], [0.875, 0.600], [0.870, 0.612], [0.396, 0.488]], 0.003), 0),
      splitter: rpoly([[-0.88, 0.110], [0.88, 0.110], [0.90, 0.132], [-0.90, 0.132]], 0.006),
      plateArea: rrect(-0.24, 0.210, 0.24, 0.320, 0.01),
      badgeArea: rrect(-0.07, 0.450, 0.07, 0.520, 0.008),
      badgeText: 'CORVETTE'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.34, 1.220], [0.48, 1.160], [0.58, 1.110], [0.80, 1.090], [0.930, 1.000],
        [0.967, 0.790, 'v'], [0.960, 0.500], [0.930, 0.250], [0.870, 0.150, 'c'], [0, 0.140, 'h']], 0),
      greenhouse: sym([[0, 1.200, 'h'], [0.32, 1.188], [0.42, 1.120], [0.40, 1.085, 'c'], [0, 1.078, 'h']], 0),
      bumper: sym([[0, 0.560, 'h'], [0.70, 0.565], [0.940, 0.590], [0.960, 0.500], [0.930, 0.250], [0.870, 0.150, 'c'], [0, 0.140, 'h']], 0),
      panelLines: [curve([[-0.60, 0.780], [0, 0.775, 'h'], [0.60, 0.780]])],
      characterLines: [curve([[-0.95, 0.590], [-0.60, 0.575], [0, 0.570, 'h'], [0.60, 0.575], [0.95, 0.590]])],
      // angular dual-element lamps: a gloss-black wedge housing with an upper LED blade and a lower bar
      taillights: [].concat(
        pair(rpoly([[0.440, 0.800], [0.930, 0.815], [0.955, 0.975], [0.600, 0.995], [0.440, 0.905]], 0.02), 0).map(function (p) { return { path: p, paint: 'gloss-black' }; }),
        pair(rpoly([[0.480, 0.900], [0.600, 0.968], [0.935, 0.955], [0.928, 0.925], [0.620, 0.935], [0.500, 0.880]], 0.006), 0),
        pair(rpoly([[0.560, 0.830], [0.915, 0.840], [0.925, 0.890], [0.660, 0.885]], 0.008), 0)
      ),
      diffuser: sym([[0, 0.360, 'h'], [0.50, 0.360], [0.82, 0.320, 'c'], [0.82, 0.150], [0, 0.140, 'h']], 0),
      // Z51 performance exhaust: four square tips, two at each outer corner of the diffuser
      exhaust: [0.590, 0.730, -0.590, -0.730].map(function (z) { return { shape: 'trapezoid', cx: z, cy: 0.255, w: 0.115, h: 0.090 }; }),
      plateArea: rrect(-0.26, 0.400, 0.26, 0.510, 0.01),
      badgeArea: rrect(-0.20, 0.700, 0.20, 0.755, 0.008),
      badgeText: 'CORVETTE',
      spoiler: sym([[0, 1.112, 'h'], [0.70, 1.112], [0.80, 1.092, 'c'], [0.78, 1.074, 'c'], [0, 1.078, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.72, 0.880, 'c'], [0.708, 0.950], [0.62, 0.968], [0.51, 0.940], [0.512, 0.892], [0.62, 0.876]]), 'body'),
      // big side intake feeding the rear radiators/engine, with the door blade sweeping into it
      D('side', 'intake', loop([[-0.380, 0.300, 'c'], [-0.600, 0.820, 'c'], [-0.820, 0.870, 'c'], [-0.990, 0.740], [-1.010, 0.460, 'c'], [-0.860, 0.300, 'c']]), 'grille'),
      // upper engine-air intake behind the side glass (in the sail panel)
      D('side', 'vent', loop([[-0.640, 0.935, 'c'], [-1.040, 1.100, 'c'], [-0.760, 1.170, 'c']]), 'grille'),
      D('side', 'trim', loop([[2.33, 0.500, 'c'], [2.18, 0.545], [2.00, 0.590], [2.03, 0.555], [2.20, 0.505]]), 'light'),          // headlamp wrap
      D('side', 'marker', rrect(2.18, 0.330, 2.26, 0.346, 0.006), 'light-amber'),
      D('side', 'trim', loop([[-2.05, 0.950, 'c'], [-2.215, 0.990], [-2.226, 0.820, 'c'], [-2.10, 0.830, 'c']]), 'light-red'),   // tail-lamp wrap
      D('side', 'vent', rpoly([[-2.00, 0.420], [-2.20, 0.430], [-2.21, 0.640], [-2.04, 0.600]], 0.015), 'grille'),            // rear quarter vent
      D('side', 'vent', rpoly([[1.95, 0.170], [2.26, 0.170], [2.30, 0.380], [2.04, 0.370]], 0.02), 'grille'),                // front corner intake
      D('top', 'fuelCap', rrect(-0.98, -0.952, -0.86, -0.905, 0.010), 'body'),                                           // filler on the driver's side intake lip
      D('top', 'wiper', rrect(0.84, -0.05, 0.88, 0.56, 0.01), 'black'),
      D('top', 'glass', sym([[-0.95, 0, 'v'], [-0.98, 0.42, 'c'], [-1.80, 0.36, 'c'], [-1.82, 0, 'v']], 1), 'glass'),       // engine-display glass hatch
      D('top', 'spoiler', rrect(-2.16, -0.72, -2.11, 0.72, 0.008), 'body'),
      D('top', 'trim', rrect(-2.232, -0.70, -2.205, 0.70, 0.008), 'light-red')
    ].concat(
      // side intakes seen from above (notches in the rear hips)
      pairD('top', 'intake', loop([[-0.30, 0.912, 'c'], [-0.95, 0.930, 'c'], [-0.98, 0.962, 'c'], [-0.30, 0.930, 'c']]), 'grille', 1),
      // engine-hatch louvres
      [-1.95, -2.02].map(function (x) { return D('top', 'vent', rrect(x, -0.50, x + 0.04, 0.50, 0.01), 'gloss-black'); }),
      pairD('top', 'trim', loop([[2.33, 0.40, 'c'], [2.25, 0.62], [2.12, 0.78, 'c'], [2.16, 0.62], [2.29, 0.40, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.70, 0.870, 'c'], [0.84, 0.880], [0.99, 0.890], [1.004, 0.930], [0.94, 0.960], [0.85, 0.955], [0.79, 0.905], [0.70, 0.895, 'c']]), 'body', 0),
      [0.235, 0.300].map(function (y) { return D('front', 'trim', rrect(-0.52, y, 0.52, y + 0.008, 0.003), 'gloss-black'); }),
      [D('front', 'vent', rpoly([[-0.30, 0.545], [0.30, 0.545], [0.26, 0.560], [-0.26, 0.560]], 0.004), 'grille'),           // nose air slot above the badge
        D('front', 'wiper', rpoly([[-0.05, 0.850], [0.56, 0.866], [0.56, 0.876], [-0.05, 0.860]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.10, 1.094, 0.10, 1.104, 0.004), 'light-red')],
      // rear corner vents beside the plate
      pairD('rear', 'vent', rpoly([[0.700, 0.420], [0.935, 0.430], [0.950, 0.720], [0.760, 0.740]], 0.02), 'grille', 0),
      pairD('rear', 'mirror', loop([[0.96, 0.880, 'c'], [0.99, 0.890], [1.004, 0.930], [0.96, 0.960], [0.96, 0.955, 'c']]), 'body', 0)
    );

    /* Hand-built sections: wedge nose with knife-edge wing crests over a low bonnet, the door blade crease, the deep
       side intake pocket ahead of the rear wheel, cab-forward canopy, angular haunch crests and a flat engine deck. */
    var sbC = flat(body, 16), tbC = flat(top.body, 16), tgC = flat(top.greenhouse, 16), winC = flat(side.windows[0], 12);
    var intC = flat(details[1].path, 16), wellsC = wellsOf(aF, aR, ref);
    function hiC(polys, x, d) { var s = sliceX(polys, x); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : d; }
    function topC(x) { var s = sliceX(sbC, x); return s ? s[1] : 0.3; }
    function crestC(x, k) { return tab([[2.39, 0.40, 0.56], [2.20, 0.56, 0.70], [1.80, 0.68, 0.80], [1.36, 0.76, 0.86], [0.90, 0.80, 0.88], [0.30, 0.83, 0.90],
      [-0.50, 0.90, 0.92], [-1.36, 0.99, 0.90], [-1.90, 1.015, 0.84], [-2.23, 0.96, 0.72]], x, k); }
    function lowerC(x, yC) {
      var yB = tab([[2.39, 0.150], [2.30, 0.112], [1.90, 0.128], [1.0, 0.118], [-1.0, 0.118], [-1.85, 0.140], [-2.14, 0.190], [-2.23, 0.300]], x);
      var w = hiC(tbC, x, 0.3), wl = wellAt(wellsC, x), a = x > 0 ? aF : aR;
      var yA = wl ? Math.max(wl.top + 0.003, a.y) : a.y;
      var I = sliceX(intC, x), yBl = Math.min(tab([[2.30, 0.50], [1.70, 0.600], [1.20, 0.590], [0.60, 0.565], [0.00, 0.560], [-0.30, 0.640], [-0.56, 0.800]], x), yC - 0.06);
      var h = [[yB, 0], [yB, w - 0.05], [yB + 0.03, w - 0.008]];
      if (I && I[1] - I[0] > 0.004 && !wl) {
        var d = 0.16 * smooth01((I[1] - I[0]) / 0.12);
        yA = Math.min(yA, I[0] - 0.01);
        h.push([yA, w], [I[0], w], [I[0] + 0.006, w - d, 0, 'black'], [I[1] - 0.006, w - d, 0, 'black'], [Math.min(I[1], yC - 0.02), w - 0.016]);
      } else {
        // over a wheel the arch edge leads and the blade crease rides just above it
        yA = Math.max(Math.min(yA, yC - 0.06), yB + 0.05);
        yBl = wl ? Math.min(Math.max(yBl, yA + 0.025), yC - 0.025) : Math.max(yBl, yA + 0.03);
        h.push([yA, w], [lerp(yA, yBl, 0.5), w], [yBl - 0.004, w], [yBl + 0.002, w - 0.014], [lerp(yBl, yC, 0.5), w - 0.016]);
      }
      return { w: w, h: h };
    }
    function frontC(x) {
      var yC = topC(x), L = lowerC(x, yC), w = L.w, h = L.h, zC = w * crestC(x, 2);
      var yH = yC - tab([[2.40, 0.0], [2.20, 0.04], [1.80, 0.06], [1.20, 0.05], [0.90, 0.03]], x), zH = Math.max(zC - 0.17, 0.2);
      h.push([yC - 0.008, lerp(w - 0.016, zC, 0.8)], [yC - 0.002, zC + 0.006], [yC, zC], [yC - 0.01, zC - 0.08], [yH + 0.004, zH + 0.004], [yH, zH - 0.004]);
      for (var k = 1; k <= 7; k++) h.push([yH + 0.012 * k / 7, (zH - 0.004) * (7 - k) / 7]);
      return { h: h, belt: null };
    }
    function cabinC(x) {
      var top = topC(x), bl = tab([[0.84, 0.820], [0.76, 0.860], [0.40, 0.875], [0.00, 0.885], [-0.40, 0.920], [-0.82, 1.010]], x);
      var yC = Math.min(crestC(x, 1), bl - 0.015), L = lowerC(x, yC), w = L.w, h = L.h, zC = w * crestC(x, 2);
      var gw = Math.min(Math.max(hiC(tgC, x, 0.4), 0.25), zC - 0.04), rail = top - Math.min(0.05, 0.35 * (top - bl)), gr = gw * 0.84;
      var screen = x > 0.05 && x < 0.84;
      function g(y) { return screen || inside(winC, x, y) ? 1 : 0; }
      h.push([yC - 0.008, lerp(w - 0.016, zC, 0.8)], [yC - 0.002, zC + 0.006], [yC, zC], [lerp(yC, bl, 0.5), lerp(zC, gw, 0.5)],
        [bl, gw, g(bl + 0.02)], [lerp(bl, rail, 0.55), lerp(gw, gr, 0.5), g(lerp(bl, rail, 0.55))], [rail, gr, g(rail - 0.01)]);
      [0.55, 0.78, 0.92].forEach(function (u, i) { h.push([lerp(rail, top, u), gr * [0.72, 0.50, 0.32][i], screen ? 1 : 0]); });
      h.push([top, gr * 0.20, screen ? 1 : 0], [top, gr * 0.09, screen ? 1 : 0], [top, 0, screen ? 1 : 0]);
      return { h: h, belt: bl };
    }
    function rearC(x) {
      var yD = topC(x), yC = Math.min(crestC(x, 1), yD - 0.04), L = lowerC(x, yC), w = L.w, h = L.h, zC = w * crestC(x, 2);
      var zD = Math.min(tab([[-0.80, 0.600], [-1.20, 0.700], [-1.80, 0.760], [-2.23, 0.700]], x), zC - 0.05);
      var hatch = x < -0.97 && x > -1.80;
      h.push([yC - 0.008, lerp(w - 0.016, zC, 0.8)], [yC - 0.002, zC + 0.006], [yC, zC], [lerp(yC, yD, 0.55), lerp(zC, zD, 0.5)],
        [yD - 0.004, zD + 0.004], [yD, zD - 0.004]);
      for (var k = 1; k <= 7; k++) { var z = (zD - 0.004) * (7 - k) / 7; h.push([yD + 0.006 * k / 7, z, hatch && z < 0.40 ? 1 : 0]); }
      return { h: h, belt: hatch ? yD - 0.02 : null };
    }
    var front095 = frontC(0.95), cab084 = cabinC(0.84), cabM070 = cabinC(-0.70), rearM100 = rearC(-1.00);
    function ringC(x) {
      var R;
      if (x >= 0.95) R = frontC(x);
      else if (x > 0.84) R = blendRing(cab084, front095, smooth01((x - 0.84) / 0.11));
      else if (x >= -0.70) R = cabinC(x);
      else if (x > -1.00) R = blendRing(cabM070, rearM100, smooth01((-0.70 - x) / 0.30));
      else R = rearC(x);
      R.h.forEach(function (q) { if (!q[3] && q[0] < 0.150) q[3] = 'black'; });
      return R;
    }
    var sections = ringSections(stationsX(XR + 0.003, XF - 0.003, 0.05, [XF - 0.010, XF - 0.025, XF - 0.05, XR + 0.010, XR + 0.025, XR + 0.05, 0.84, 0.05,
      -0.37, -0.39, -0.41, -0.44, -1.0, -1.005]
      .concat([aF.x, aR.x].reduce(function (acc, ax) { for (var d = -0.38; d <= 0.38; d += 0.04) acc.push(ax + d); return acc; }, []))), ringC, wellsC);

    return {
      id: 'chevrolet-corvette-c8', make: 'Chevrolet', name: 'Corvette Stingray', gen: 'C8', years: '2020–', style: 'hypercar',
      look: { head: 'blade', tail: 'slim', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      color: '#c8102e', colorName: 'Torch Red',
      wheel: { style: 'split-5', spokes: 10, caliper: '#c8102e' },   // Z51 trident-spoke wheels, red Brembo callipers
      badgeText: 'CORVETTE',
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim angular LED lamps sweeping up and out over the front wings, with a full-length LED light-pipe DRL along the top edge.',
        taillights: 'Angular dual-element LED lamps: an upper blade and a lower bar in a gloss-black wedge housing, wrapping round the tail corners.',
        grille: 'Pointed nose with a wide central mesh opening and large corner intakes; no upper grille (the radiators are fed from the sides).',
        notes: 'Mid-engine cab-forward proportions, removable targa roof panel, huge side intakes ahead of the rear wheels plus upper sail-panel intakes, glass engine hatch, quad square Z51 tailpipes.'
      },
      sources: ['Chevrolet 2020 Corvette Stingray specifications (Chevrolet pressroom)', 'Wikipedia: Chevrolet Corvette (C8)']
    };
  }

  /* ================================================================== */
  /* Dodge Challenger SRT Hellcat (LA, 2015–2023)                        */
  /* ================================================================== */
  function challengerHellcat() {
    var ref = {
      length: 5.017, width: 1.923, height: 1.454, wheelbase: 2.946, trackF: 1.625, trackR: 1.618,
      frontOverhang: 0.995, rearOverhang: 1.076, wheelDiameter_in: 20,
      tireF: '275/40ZR20', tireR: '275/40ZR20', groundClearance: 0.115, rideHeight: 0.115, cd: 0.382, curbWeight_kg: 2002
    };
    var XF = 2.468, XR = -2.549, H = 1.454;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.473, y: rF, r: rF + 0.038, flare: 0.024 };
    var aR = { x: -1.473, y: rR, r: rR + 0.040, flare: 0.030 };
    var yb = 0.190;

    // three-box 1970-style coupe: long flat bonnet, upright recessed grille, notchback roof, long flat deck
    var roofLine = [[0.62, 1.005, 'c'], [0.30, 1.180], [0.00, 1.360], [-0.35, H, 'h'], [-0.80, 1.440], [-1.20, 1.380], [-1.55, 1.245], [-1.86, 1.120, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [2.05, 0.168], [2.38, 0.140, 'c'], [2.440, 0.190], [2.462, 0.300],
      [XF, 0.470, 'v'], [2.460, 0.600], [2.452, 0.700],
      // grille face leaning slightly forward under the bonnet's leading edge
      [2.466, 0.800, 'c'], [2.410, 0.845, 'c'],
      [2.00, 0.890], [1.50, 0.928], [1.00, 0.968]
    ].concat(roofLine, [
      [-2.20, 1.100], [-2.45, 1.106], [-2.505, 1.124, 'c'], [-2.532, 1.075, 'c'], [XR, 0.850, 'v'], [-2.542, 0.560], [-2.505, 0.330], [-2.42, 0.210, 'c'], [-2.12, yb, 'c']
    ]), 0.160);

    var doorGlass = [[0.50, 1.040, 'c'], [0.20, 1.200], [-0.10, 1.360], [-0.40, 1.405, 'h'], [-0.98, 1.380, 'c'], [-1.00, 1.065, 'c']];
    var quarterGlass = [[-1.070, 1.072, 'c'], [-1.060, 1.360, 'c'], [-1.30, 1.280], [-1.520, 1.172, 'c'], [-1.30, 1.110]];
    var side = {
      body: body,
      greenhouse: loop([[0.530, 1.028, 'c'], [0.21, 1.210], [-0.10, 1.372], [-0.40, 1.418, 'h'], [-0.98, 1.392], [-1.30, 1.292], [-1.575, 1.162, 'c'],
        [-1.30, 1.104], [-0.90, 1.075], [-0.30, 1.058], [0.20, 1.045]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.62, 1.005, 'c'], [0.30, 1.180], [0.00, 1.360], [-0.10, 1.380, 'c'], [-0.10, 1.360, 'c'], [0.20, 1.200], [0.50, 1.040, 'c']])],
      doorCuts: [loop([[0.760, 0.270, 'c'], [0.770, 0.620], [0.740, 0.920], [0.620, 1.012]].concat(doorGlass, [[-1.050, 0.850], [-1.080, 0.290, 'c']]))],
      panelLines: [
        curve([[2.40, 0.820], [2.15, 0.600], [1.95, 0.440]]),            // front fascia / wing seam
        curve([[-2.00, 0.700], [-2.02, 0.500], [-2.04, 0.320]]),         // rear fascia seam
        curve([[-1.88, 1.112], [-2.00, 1.080], [-2.35, 1.078], [-2.50, 1.090]]),   // deck-lid shut line
        curve([[2.42, 0.830], [1.80, 0.885], [0.66, 0.990]])             // bonnet shut line
      ],
      characterLines: [
        // full-length beltline crease, plus the 1970-style scallop along the lower doors
        curve([[2.40, 0.800], [1.60, 0.858], [0.60, 0.912], [-0.40, 0.940], [-1.40, 0.960], [-2.53, 0.950]]),
        curve([[1.20, 0.600], [0.40, 0.580], [-0.50, 0.600], [-1.10, 0.680]]),
        curve([[1.20, 0.520], [0.40, 0.500], [-0.50, 0.510], [-1.06, 0.560]])
      ],
      sill: rrect(-1.06, 0.160, 1.06, 0.205, 0.010),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.90, 0.175, 'c'], [2.05, 0.168], [2.38, 0.140, 'c'], [2.42, 0.172, 'c'], [2.05, 0.196], [1.90, 0.215, 'c']]),
        loop([[-1.90, 0.192, 'c'], [-2.12, 0.190], [-2.42, 0.210, 'c'], [-2.46, 0.262, 'c'], [-2.12, 0.228], [-1.90, 0.228, 'c']]),
        loop([[1.06, 0.160, 'c'], [-1.06, 0.160, 'c'], [-1.065, 0.180, 'c'], [1.065, 0.180, 'c']])
      ]
    };

    var top = {
      // slab-sided: almost constant width from the grille to the tail
      body: sym([[XF, 0, 'v'], [2.462, 0.450], [2.440, 0.740], [2.320, 0.900], [1.95, 0.950], [1.473, 0.9615, 'h'], [0.50, 0.952], [-0.50, 0.954],
        [-1.473, 0.9615, 'h'], [-2.10, 0.950], [-2.420, 0.900], [-2.525, 0.720], [-2.546, 0.400], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.64, 0, 'v'], [0.56, 0.660, 'c'], [0.00, 0.720], [-0.90, 0.718], [-1.50, 0.640], [-1.80, 0.500], [-1.88, 0, 'v']], 1),
      hood: sym([[2.42, 0, 'v'], [2.40, 0.62], [2.30, 0.82, 'c'], [0.68, 0.76, 'c'], [0.62, 0, 'v']], 1),
      roof: rpoly([[-0.05, -0.62], [-0.05, 0.62], [-1.20, 0.58], [-1.20, -0.58]], 0.07),
      deck: sym([[-1.88, 0, 'v'], [-1.90, 0.70, 'c'], [-2.50, 0.78, 'c'], [-2.52, 0, 'v']], 1),
      mirrors: pair(loop([[0.56, 0.940, 'c'], [0.53, 1.030], [0.47, 1.068], [0.38, 1.062], [0.34, 1.000], [0.345, 0.940, 'c']]), 1),
      characterLines: pair(curve([[2.36, 0.62], [1.60, 0.64], [0.90, 0.66], [0.68, 0.67]]), 1)
    };

    // quad round lamps with LED halo rings set in a full-width recessed grille (inner left lamp = Air Catcher intake)
    var lampR = 0.093, lampY = 0.706;
    var front = {
      body: sym([[0, H, 'h'], [0.42, 1.440], [0.58, 1.360], [0.68, 1.160], [0.76, 1.045], [0.90, 0.985], [0.950, 0.880],
        [0.9615, 0.700, 'v'], [0.955, 0.450], [0.930, 0.250], [0.870, 0.150, 'c'], [0.60, 0.140], [0, 0.138, 'h']], 0),
      greenhouse: sym([[0, 1.430, 'h'], [0.42, 1.418], [0.56, 1.340], [0.66, 1.150], [0.730, 1.050, 'c'], [0.36, 1.030], [0, 1.025, 'h']], 0),
      bumper: sym([[0, 0.585, 'h'], [0.60, 0.590], [0.900, 0.605], [0.955, 0.450], [0.930, 0.250], [0.870, 0.150, 'c'], [0.60, 0.140], [0, 0.138, 'h']], 0),
      characterLines: [
        curve([[-0.95, 0.88], [-0.70, 0.890, 'h'], [-0.40, 0.900], [0, 0.905, 'h'], [0.40, 0.900], [0.70, 0.890, 'h'], [0.95, 0.88]]),
        curve([[-0.24, 0.905], [-0.22, 0.960], [-0.20, 1.020]]),
        curve([[0.24, 0.905], [0.22, 0.960], [0.20, 1.020]])
      ],
      grille: [
        rpoly([[-0.900, 0.600], [0.900, 0.600], [0.915, 0.812], [-0.915, 0.812]], 0.035),
        // lower grille, split by the plate
        rpoly([[-0.640, 0.200], [0.640, 0.200], [0.690, 0.330], [0.660, 0.520], [-0.660, 0.520], [-0.690, 0.330]], 0.03)
      ],
      intakes: pair(rpoly([[0.740, 0.230], [0.880, 0.240], [0.905, 0.400], [0.770, 0.390]], 0.02), 0),
      headlights: [0.565, 0.790, -0.790].map(function (z) { return ellipse(z, lampY, lampR, lampR); })
        .concat([{ path: ellipse(-0.565, lampY, lampR, lampR), paint: 'light' }]),
      drl: [0.565, 0.790, -0.565, -0.790].map(function (z) { return rrect(z - 0.040, lampY - lampR - 0.012, z + 0.040, lampY - lampR - 0.004, 0.003); }),
      splitter: rpoly([[-0.88, 0.138], [0.88, 0.138], [0.90, 0.162], [-0.90, 0.162]], 0.008),
      plateArea: rrect(-0.26, 0.300, 0.26, 0.410, 0.01),
      badgeArea: rrect(-0.24, 0.640, -0.04, 0.690, 0.008),
      badgeText: 'SRT'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.42, 1.430], [0.54, 1.330], [0.60, 1.200], [0.66, 1.140], [0.85, 1.120], [0.930, 1.070], [0.955, 0.950],
        [0.9615, 0.750, 'v'], [0.955, 0.500], [0.930, 0.300], [0.870, 0.200, 'c'], [0, 0.190, 'h']], 0),
      greenhouse: sym([[0, 1.400, 'h'], [0.40, 1.390], [0.50, 1.300], [0.57, 1.170], [0.55, 1.140, 'c'], [0, 1.130, 'h']], 0),
      bumper: sym([[0, 0.640, 'h'], [0.60, 0.640], [0.900, 0.630], [0.955, 0.500], [0.930, 0.300], [0.870, 0.200, 'c'], [0, 0.190, 'h']], 0),
      panelLines: [curve([[-0.40, 0.820], [0, 0.816, 'h'], [0.40, 0.820]])],
      characterLines: [curve([[-0.95, 0.640], [-0.60, 0.650], [0, 0.655, 'h'], [0.60, 0.650], [0.95, 0.640]])],
      // full-width "racetrack" LED tail lamp: one red ring round a gloss-black centre panel
      taillights: [
        { path: rpoly([[-0.935, 0.835], [0.935, 0.835], [0.945, 1.045], [-0.945, 1.045]], 0.05), paint: 'gloss-black' },
        { path: rpoly([[-0.905, 0.860], [0.905, 0.860], [0.912, 1.020], [-0.912, 1.020]], 0.07), paint: 'light-red' },
        { path: rpoly([[-0.862, 0.890], [0.862, 0.890], [0.868, 0.990], [-0.868, 0.990]], 0.045), paint: 'gloss-black' }
      ],
      lightBar: rpoly([[-0.905, 0.860], [0.905, 0.860], [0.905, 0.878], [-0.905, 0.878]], 0.006),
      diffuser: sym([[0, 0.330, 'h'], [0.40, 0.330], [0.80, 0.305, 'c'], [0.78, 0.200], [0, 0.190, 'h']], 0),
      exhaust: [0.640, 0.775, -0.640, -0.775].map(function (z) { return { shape: 'round', cx: z, cy: 0.268, w: 0.100, h: 0.100 }; }),
      plateArea: rrect(-0.26, 0.660, 0.26, 0.775, 0.01),
      badgeArea: rrect(-0.20, 0.915, 0.20, 0.965, 0.008),
      badgeText: 'CHALLENGER',
      spoiler: sym([[0, 1.130, 'h'], [0.66, 1.130], [0.76, 1.110, 'c'], [0.74, 1.100, 'c'], [0, 1.102, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.56, 1.050, 'c'], [0.548, 1.120], [0.46, 1.138], [0.35, 1.110], [0.352, 1.060], [0.46, 1.044]]), 'body'),
      D('side', 'trim', rpoly([[-0.998, 1.062], [-0.985, 1.390], [-1.065, 1.380], [-1.072, 1.065]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.84, 0.890, -0.66, 0.914, 0.010), 'chrome'),
      D('side', 'trim', loop([[2.455, 0.800, 'c'], [2.452, 0.610, 'c'], [2.40, 0.620], [2.40, 0.790]]), 'grille'),                // grille edge seen from the side
      D('side', 'marker', rrect(2.25, 0.560, 2.36, 0.580, 0.006), 'light-amber'),
      D('side', 'marker', rrect(-2.46, 0.560, -2.36, 0.580, 0.006), 'light-red'),
      D('side', 'trim', loop([[-2.40, 1.040, 'c'], [-2.535, 1.040], [-2.540, 0.860, 'c'], [-2.42, 0.865, 'c']]), 'light-red'),   // racetrack lamp wrap
      D('side', 'fuelCap', ellipse(-1.85, 1.000, 0.060, 0.050), 'chrome'),                                               // round racing filler door, right rear quarter
      D('side', 'vent', rpoly([[2.05, 0.240], [2.36, 0.240], [2.40, 0.430], [2.12, 0.420]], 0.02), 'grille'),
      D('top', 'wiper', rrect(0.68, -0.05, 0.72, 0.62, 0.01), 'black'),
      D('top', 'trim', rrect(-2.548, -0.86, -2.520, 0.86, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.53, -0.70, -2.48, 0.70, 0.008), 'body'),
      D('top', 'fuelCap', ellipse(-1.85, 0.930, 0.050, 0.040), 'chrome'),
      // Hellcat bonnet: centre cold-air scoop
      D('top', 'scoop', sym([[2.22, 0, 'v'], [2.20, 0.17, 'c'], [1.72, 0.20, 'c'], [1.70, 0, 'v']], 1), 'grille')
    ].concat(
      // twin heat extractors either side of the scoop
      pairD('top', 'vent', rpoly([[1.95, 0.30], [1.95, 0.50], [1.45, 0.52], [1.45, 0.32]], 0.03), 'gloss-black', 1),
      pairD('top', 'trim', loop([[2.44, 0.46, 'c'], [2.42, 0.85, 'c'], [2.40, 0.85, 'c'], [2.42, 0.46, 'c']]), 'grille', 1),
      pairD('front', 'mirror', loop([[0.76, 1.040, 'c'], [0.90, 1.050], [1.06, 1.062], [1.076, 1.110], [1.01, 1.145], [0.92, 1.140], [0.86, 1.080], [0.76, 1.070, 'c']]), 'body', 0),
      // lamp lenses inside the halo rings; the inner left "lamp" is the Air Catcher intake
      [0.565, 0.790, -0.790].map(function (z) { return D('front', 'light', ellipse(z, lampY, lampR * 0.74, lampR * 0.74), 'glass'); }),
      [0.565, 0.790, -0.790].map(function (z) { return D('front', 'light', ellipse(z, lampY, lampR * 0.32, lampR * 0.32), 'chrome'); }),
      [D('front', 'intake', ellipse(-0.565, lampY, lampR * 0.74, lampR * 0.74), 'grille')],
      // honeycomb bars in the upper grille between the lamps
      [0.650, 0.705, 0.760].map(function (y) { return D('front', 'trim', rrect(-0.46, y, 0.46, y + 0.008, 0.003), 'gloss-black'); }),
      // scoop mouth and extractors seen head-on
      [D('front', 'scoop', rpoly([[-0.17, 0.905], [0.17, 0.905], [0.15, 0.945], [-0.15, 0.945]], 0.008), 'grille'),
        D('front', 'wiper', rpoly([[-0.05, 1.035], [0.60, 1.055], [0.60, 1.065], [-0.05, 1.047]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.10, 1.134, 0.10, 1.144, 0.004), 'light-red')],
      pairD('front', 'vent', rpoly([[0.30, 0.908], [0.50, 0.912], [0.50, 0.924], [0.30, 0.920]], 0.004), 'gloss-black', 0),
      [0, 0.22, -0.22].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.20, z + 0.008, 0.32, 0.004), 'black'); }),
      pairD('rear', 'trim', rrect(0.870, 0.430, 0.910, 0.490, 0.008), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.96, 1.050, 'c'], [1.06, 1.062], [1.076, 1.110], [1.01, 1.145], [0.96, 1.140, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.160, xWS: 0.62, xBL: -1.86,
      belt: [[0.62, 1.005], [0.53, 1.030], [0.20, 1.045], [-0.30, 1.058], [-0.90, 1.075], [-1.30, 1.104], [-1.57, 1.160], [-1.75, 1.140], [-1.86, 1.120]],
      crest: [[2.46, 0.80, 0.70], [2.30, 0.860, 0.80], [1.80, 0.895, 0.86], [1.20, 0.935, 0.88], [0.62, 0.975, 0.92], [-0.40, 1.000, 0.94],
        [-1.20, 1.020, 0.93], [-1.80, 1.040, 0.90], [-2.20, 1.050, 0.86], [-2.54, 1.020, 0.76]],
      dip: [[2.46, 0.0], [2.38, 0.02], [2.20, 0.03], [1.50, 0.03], [1.00, 0.02], [0.62, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'dodge-challenger-srt-hellcat', make: 'Dodge', name: 'Challenger SRT Hellcat', gen: 'LA', years: '2015–2023', style: 'coupe',
      look: { head: 'quad-round', tail: 'full-width', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      color: '#d4560e', colorName: 'Go Mango',
      wheel: { style: 'split-5', spokes: 10, caliper: '#c8102e' },   // 20 in SRT split-spoke wheels, red Brembo callipers
      badgeText: 'HELLCAT',
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Quad round lamps with LED halo rings in a full-width recessed grille; the inner left lamp is the Air Catcher cold-air intake.',
        taillights: 'Full-width "racetrack" LED tail lamp: one red ring round a gloss-black centre panel spanning the whole tail.',
        grille: 'Full-width recessed upper grille housing the four lamps, wide lower grille split by the plate, corner brake ducts.',
        notes: 'Long flat bonnet with the Hellcat centre scoop and twin heat extractors, 1970-style beltline and lower door scallop, notchback roof, round racing filler on the rear quarter, quad round tailpipes.'
      },
      sources: ['Dodge Challenger SRT Hellcat specifications (Stellantis / FCA US media)', 'Wikipedia: Dodge Challenger (third generation)']
    };
  }

  /* ================================================================== */
  /* Ford GT (2nd generation, 2017–2022)                                 */
  /* ================================================================== */
  function fordGT2017() {
    var ref = {
      length: 4.779, width: 2.003, height: 1.109, wheelbase: 2.710, trackF: 1.694, trackR: 1.662,
      frontOverhang: 0.985, rearOverhang: 1.084, wheelDiameter_in: 20,
      tireF: '245/35ZR20', tireR: '325/30ZR20', groundClearance: 0.120, rideHeight: 0.120, cd: 0.35, curbWeight_kg: 1385
    };
    var XF = 2.340, XR = -2.439, H = 1.109;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.355, y: rF, r: rF + 0.034, flare: 0.020 };
    var aR = { x: -1.355, y: rR, r: rR + 0.034, flare: 0.026 };
    var yb = 0.165, W = 1.0015;

    // teardrop canopy far forward, long tail with the flying buttresses running back to the active wing
    var roofLine = [[0.80, 0.790, 'c'], [0.45, 0.950], [0.10, 1.070], [-0.20, H, 'h'], [-0.60, 1.075], [-1.10, 1.000], [-1.60, 0.955], [-2.10, 0.935]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.95, 0.135], [2.27, 0.110, 'c'], [2.320, 0.160], [XF, 0.270, 'v'], [2.320, 0.350], [2.250, 0.410, 'c'],
      [1.95, 0.520], [1.60, 0.620], [1.20, 0.720]
    ].concat(roofLine, [
      [-2.380, 0.945, 'c'], [-2.430, 0.900, 'c'], [XR, 0.700, 'v'], [-2.430, 0.450], [-2.370, 0.260], [-2.230, 0.150, 'c'], [-1.85, 0.140, 'c']
    ]), 0.118);

    var winGlass = [[0.720, 0.820, 'c'], [0.25, 1.000], [-0.20, 1.075, 'h'], [-0.52, 1.040], [-0.760, 0.950, 'c'], [-0.40, 0.870], [0.10, 0.830]];
    var side = {
      body: body,
      greenhouse: loop([[0.760, 0.808, 'c'], [0.26, 1.012], [-0.20, 1.090, 'h'], [-0.56, 1.052], [-0.840, 0.950, 'c'], [-0.40, 0.858], [0.10, 0.816]]),
      windows: [loop(winGlass)],
      pillars: [loop([[0.80, 0.790, 'c'], [0.45, 0.950], [0.10, 1.070, 'c'], [0.10, 1.040, 'c'], [0.40, 0.950], [0.720, 0.820, 'c']])],
      // dihedral door cut into the roof
      doorCuts: [loop([[1.000, 0.180, 'c'], [1.000, 0.500], [0.900, 0.740], [0.80, 0.792, 'c'], [0.10, 1.072], [-0.20, 1.100, 'h'], [-0.62, 1.060, 'c'],
        [-0.700, 0.700], [-0.640, 0.400], [-0.560, 0.180, 'c']])],
      panelLines: [
        curve([[2.24, 0.420], [2.10, 0.330], [1.98, 0.220]]),
        curve([[2.25, 0.410], [1.80, 0.565], [1.20, 0.712], [0.84, 0.785]]),        // front clamshell shut line
        curve([[-0.90, 1.025], [-1.50, 0.960], [-2.00, 0.938], [-2.36, 0.945]]),     // engine cover shut line
        curve([[-1.88, 0.700], [-1.92, 0.480], [-1.94, 0.300]])
      ],
      characterLines: [
        curve([[2.25, 0.415], [1.80, 0.570], [1.30, 0.650]]),                       // front wing crest
        // the buttress edge: from the canopy back over the rear wheel to the wing
        curve([[-0.70, 0.960], [-1.20, 0.905], [-1.80, 0.880], [-2.40, 0.880]]),
        curve([[1.70, 0.540], [1.10, 0.520], [0.40, 0.470], [-0.20, 0.430]])        // lower door crease into the scoop
      ],
      sill: rrect(-0.99, 0.118, 0.99, 0.160, 0.010),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.72, 0.140, 'c'], [1.95, 0.135], [2.27, 0.110, 'c'], [2.31, 0.140, 'c'], [1.95, 0.165], [1.72, 0.180, 'c']]),        // carbon splitter
        loop([[-1.72, 0.140, 'c'], [-1.85, 0.140], [-2.23, 0.150, 'c'], [-2.30, 0.220, 'c'], [-1.90, 0.190], [-1.72, 0.185, 'c']]),
        loop([[0.99, 0.118, 'c'], [-0.99, 0.118, 'c'], [-0.995, 0.140, 'c'], [0.995, 0.140, 'c']])
      ]
    };

    var top = {
      // narrow canopy between full-width wheel pods; the buttresses close the plan outline at the rear
      body: sym([[XF, 0, 'v'], [2.330, 0.300], [2.260, 0.600], [2.080, 0.850], [1.75, 0.970], [1.355, W, 'h'], [0.90, 0.975], [0.40, 0.905],
        [-0.20, 0.915], [-0.80, 0.970], [-1.355, W, 'h'], [-1.90, 0.990], [-2.250, 0.930], [-2.415, 0.760], [-2.437, 0.400], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.80, 0, 'v'], [0.72, 0.440, 'c'], [0.30, 0.545], [-0.30, 0.548], [-0.90, 0.430], [-1.45, 0.260], [-1.65, 0, 'v']], 1),
      hood: sym([[2.27, 0, 'v'], [2.22, 0.50], [2.05, 0.74, 'c'], [0.86, 0.60, 'c'], [0.84, 0, 'v']], 1),
      roof: rpoly([[0.12, -0.42], [0.12, 0.42], [-0.72, 0.38], [-0.72, -0.38]], 0.06),
      deck: sym([[-1.66, 0, 'v'], [-1.70, 0.72, 'c'], [-2.40, 0.80, 'c'], [-2.42, 0, 'v']], 1),
      mirrors: pair(loop([[0.62, 0.880, 'c'], [0.60, 1.040], [0.55, 1.110], [0.46, 1.105], [0.43, 1.040], [0.45, 0.880, 'c']]), 1),
      characterLines: pair(curve([[-0.60, 0.600], [-1.20, 0.700], [-1.80, 0.760], [-2.38, 0.780]]), 1)    // buttress inner edges
    };

    var front = {
      body: sym([[0, H, 'h'], [0.30, 1.095], [0.42, 1.020], [0.55, 0.860], [0.66, 0.720], [0.82, 0.650], [0.940, 0.570],
        [W, 0.440, 'v'], [0.990, 0.300], [0.950, 0.170], [0.880, 0.120, 'c'], [0.50, 0.112], [0, 0.110, 'h']], 0),
      greenhouse: sym([[0, 1.090, 'h'], [0.28, 1.078], [0.40, 1.000], [0.52, 0.860], [0.580, 0.800, 'c'], [0.30, 0.780], [0, 0.775, 'h']], 0),
      bumper: sym([[0, 0.360, 'h'], [0.60, 0.372], [0.900, 0.400], [0.990, 0.300], [0.950, 0.170], [0.880, 0.120, 'c'], [0, 0.110, 'h']], 0),
      characterLines: [
        curve([[-0.98, 0.56], [-0.70, 0.560], [-0.40, 0.470], [0, 0.430, 'h'], [0.40, 0.470], [0.70, 0.560], [0.98, 0.56]]),
        curve([[-0.20, 0.440], [-0.30, 0.600], [-0.40, 0.760]]),
        curve([[0.20, 0.440], [0.30, 0.600], [0.40, 0.760]])
      ],
      // central hexagonal intake under the nose, outer ducts either side
      grille: [rpoly([[-0.380, 0.150], [0.380, 0.150], [0.480, 0.260], [0.400, 0.370], [-0.400, 0.370], [-0.480, 0.260]], 0.03)],
      intakes: pair(rpoly([[0.560, 0.150], [0.860, 0.170], [0.930, 0.340], [0.640, 0.330], [0.540, 0.250]], 0.03), 0),
      // slim blade lamps sweeping up into the wings
      headlights: pair(loop([[0.420, 0.400, 'c'], [0.640, 0.455], [0.910, 0.560, 'c'], [0.945, 0.520], [0.820, 0.440], [0.560, 0.385, 'c']]), 0),
      drl: pair(rpoly([[0.440, 0.405], [0.900, 0.550], [0.895, 0.562], [0.436, 0.417]], 0.003), 0),
      splitter: rpoly([[-0.90, 0.110], [0.90, 0.110], [0.92, 0.134], [-0.92, 0.134]], 0.006),
      plateArea: rrect(-0.22, 0.195, 0.22, 0.300, 0.01),
      badgeArea: rrect(-0.06, 0.390, 0.06, 0.430, 0.008),
      badgeText: 'FORD'
    };

    var lampZ = 0.700, lampY = 0.760, lampR = 0.130;
    var rear = {
      body: sym([[0, H, 'h'], [0.26, 1.098], [0.36, 1.040], [0.45, 0.985], [0.75, 0.960], [0.920, 0.920], [0.990, 0.800],
        [W, 0.600, 'v'], [0.990, 0.380], [0.950, 0.200], [0.880, 0.150, 'c'], [0, 0.140, 'h']], 0),
      greenhouse: sym([[0, 1.080, 'h'], [0.24, 1.070], [0.32, 1.020], [0.30, 0.990, 'c'], [0, 0.985, 'h']], 0),
      bumper: sym([[0, 0.580, 'h'], [0.40, 0.580], [0.900, 0.560], [0.990, 0.380], [0.950, 0.200], [0.880, 0.150, 'c'], [0, 0.140, 'h']], 0),
      characterLines: [curve([[-0.99, 0.900], [-0.60, 0.890], [0, 0.885, 'h'], [0.60, 0.890], [0.99, 0.900]])],
      // "afterburner" ring lamps with hollow centres (air outlets)
      taillights: pair(ellipse(lampZ, lampY, lampR, lampR), 0),
      diffuser: sym([[0, 0.420, 'h'], [0.55, 0.420], [0.860, 0.360, 'c'], [0.860, 0.150], [0, 0.140, 'h']], 0),
      // twin round tailpipes high in the centre of the rear mesh
      exhaust: [0.085, -0.085].map(function (z) { return { shape: 'round', cx: z, cy: 0.540, w: 0.120, h: 0.120 }; }),
      plateArea: rrect(-0.24, 0.240, 0.24, 0.345, 0.01),
      badgeArea: rrect(-0.10, 0.830, 0.10, 0.870, 0.008),
      badgeText: 'GT',
      spoiler: sym([[0, 0.962, 'h'], [0.80, 0.962], [0.880, 0.945, 'c'], [0.860, 0.925, 'c'], [0, 0.930, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.62, 0.830, 'c'], [0.61, 0.910], [0.52, 0.930], [0.42, 0.900], [0.43, 0.845], [0.52, 0.828]]), 'body'),
      // sculpted door scoop feeding the side-pod intake ahead of the rear wheel
      D('side', 'intake', loop([[-0.30, 0.250, 'c'], [-0.20, 0.430], [-0.420, 0.620, 'c'], [-0.900, 0.640], [-0.980, 0.520, 'c'], [-0.900, 0.300], [-0.700, 0.230, 'c']]), 'grille'),
      // air channel under the flying buttress
      D('side', 'vent', loop([[-0.800, 0.700, 'c'], [-0.860, 0.930, 'c'], [-1.300, 0.890], [-1.780, 0.860, 'c'], [-1.400, 0.760], [-1.000, 0.700]]), 'black'),
      D('side', 'trim', loop([[2.24, 0.410, 'c'], [2.08, 0.465], [1.90, 0.520], [1.93, 0.485], [2.10, 0.425]]), 'light'),
      D('side', 'marker', rrect(2.15, 0.300, 2.24, 0.316, 0.006), 'light-amber'),
      D('side', 'trim', ellipse(-2.40, 0.760, 0.030, 0.110), 'light-red'),
      D('side', 'vent', rpoly([[1.92, 0.150], [2.24, 0.150], [2.28, 0.330], [2.00, 0.320]], 0.02), 'grille'),
      D('side', 'wing', loop([[-2.10, 0.948, 'c'], [-2.42, 0.962, 'c'], [-2.43, 0.940, 'c'], [-2.12, 0.935, 'c']]), 'carbon'),
      D('top', 'fuelCap', rrect(-0.60, 0.40, -0.50, 0.48, 0.010), 'body'),
      D('top', 'wiper', rrect(0.80, -0.05, 0.84, 0.44, 0.01), 'black'),
      D('top', 'glass', sym([[-0.90, 0, 'v'], [-0.95, 0.34, 'c'], [-1.55, 0.20, 'c'], [-1.60, 0, 'v']], 1), 'glass'),   // engine-bay glass
      D('top', 'wing', rrect(-2.42, -0.85, -2.12, 0.85, 0.02), 'carbon'),                                              // active rear wing (stowed)
      D('top', 'trim', rrect(-2.437, -0.80, -2.415, 0.80, 0.008), 'gloss-black')
    ].concat(
      // air channels between the canopy and the buttresses
      pairD('top', 'vent', loop([[-0.45, 0.580, 'c'], [-1.30, 0.500], [-2.05, 0.580, 'c'], [-1.80, 0.760], [-0.90, 0.760, 'c']]), 'black', 1),
      // big bonnet heat extractors
      pairD('top', 'vent', rpoly([[2.00, 0.12], [2.00, 0.46], [1.40, 0.42], [1.40, 0.14]], 0.04), 'grille', 1),
      pairD('top', 'trim', loop([[2.30, 0.40, 'c'], [2.22, 0.66], [2.08, 0.84, 'c'], [2.12, 0.66], [2.26, 0.40, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.62, 0.840, 'c'], [0.80, 0.850], [1.10, 0.865], [1.118, 0.905], [1.04, 0.935], [0.94, 0.930], [0.86, 0.880], [0.62, 0.865, 'c']]), 'body', 0),
      pairD('front', 'vent', rpoly([[0.12, 0.440], [0.42, 0.480], [0.42, 0.500], [0.12, 0.460]], 0.004), 'grille', 0),
      [0.215, 0.280].map(function (y) { return D('front', 'trim', rrect(-0.40, y, 0.40, y + 0.008, 0.003), 'gloss-black'); }),
      [D('front', 'wiper', rpoly([[-0.05, 0.790], [0.48, 0.806], [0.48, 0.816], [-0.05, 0.800]], 0.004), 'black'),
        // open rear mesh between the lamps and around the tailpipes
        D('rear', 'vent', rpoly([[-0.170, 0.620], [0.170, 0.620], [0.170, 0.700], [-0.170, 0.700]], 0.02), 'grille'),
        D('rear', 'trim', rrect(-0.12, 0.900, 0.12, 0.910, 0.004), 'light-red')],
      pairD('rear', 'vent', rpoly([[0.170, 0.430], [0.560, 0.430], [0.560, 0.700], [0.170, 0.700]], 0.04), 'grille', 0),
      // hollow lamp centres
      pairD('rear', 'vent', ellipse(lampZ, lampY, lampR * 0.62, lampR * 0.62), 'grille', 0),
      pairD('rear', 'trim', rrect(0.880, 0.420, 0.930, 0.470, 0.008), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.99, 0.850], [1.10, 0.865], [1.118, 0.905], [1.04, 0.935], [0.99, 0.930, 'c']]), 'body', 0)
    );

    /* Hand-built sections: knife-edged front wing crests over a low centre bonnet, a narrow teardrop canopy with strong
       tumblehome, and behind the doors the flying buttresses as separate fins: side pod top (dark intake shelf) →
       buttress fin standing proud → deep dark air channel → engine-cover/canopy hump. A single closed ring cannot
       carry a true through-hole, so the open space under each buttress is a deep channel painted black. */
    var sbG = flat(body, 16), tbG = flat(top.body, 16), tgG = flat(top.greenhouse, 16), winG = flat(side.windows[0], 12);
    var wellsG = wellsOf(aF, aR, ref);
    function hiG(polys, x, d) { var s = sliceX(polys, x); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : d; }
    function topG(x) { var s = sliceX(sbG, x); return s ? s[1] : 0.3; }
    function lowerG(x, yC) {
      var yB = tab([[2.34, 0.170], [2.25, 0.125], [1.95, 0.135], [1.0, 0.118], [-1.0, 0.118], [-1.85, 0.140], [-2.30, 0.200], [-2.44, 0.300]], x);
      var w = hiG(tbG, x, 0.3), wl = wellAt(wellsG, x), a = x > 0 ? aF : aR;
      var yA = Math.min(wl ? Math.max(wl.top + 0.003, a.y) : a.y, yC - 0.06);
      yA = Math.max(yA, yB + 0.06);
      return { w: w, h: [[yB, 0], [yB, w - 0.06], [yB + 0.04, w - 0.008], [yA, w], [lerp(yA, yC, 0.45), w], [lerp(yA, yC, 0.8), w * 0.997]] };
    }
    function frontG(x) {
      var wl = wellAt(wellsG, x), yC = Math.max(topG(x), wl ? wl.top + 0.07 : 0), L = lowerG(x, yC), w = L.w, h = L.h;   // wing humps over the tyres
      var zC = w * tab([[2.34, 0.56], [2.20, 0.74], [1.80, 0.84], [1.36, 0.88], [0.85, 0.86]], x);
      var yH = yC - tab([[2.34, 0.0], [2.22, 0.030], [1.80, 0.070], [1.20, 0.060], [0.85, 0.035]], x);
      h.push([yC - 0.008, lerp(w, zC, 0.85)], [yC - 0.002, zC + 0.006], [yC, zC], [yC - 0.004, zC - 0.06],
        [lerp(yC, yH, 0.45), zC - 0.14], [lerp(yC, yH, 0.8), zC - 0.22], [yH + 0.003, zC * 0.56], [yH, zC * 0.50]);
      for (var k = 0; k < 7; k++) h.push([yH + 0.006 * k / 6, zC * 0.42 * (6 - k) / 6]);
      return { h: h, belt: null };
    }
    function cabinG(x) {
      var top = topG(x), bl = tab([[0.80, 0.790], [0.72, 0.815], [0.30, 0.828], [-0.30, 0.850], [-0.84, 0.945]], x);
      var yC = Math.min(tab([[0.85, 0.700], [0.30, 0.740], [-0.50, 0.860], [-0.84, 0.900]], x), bl - 0.02);
      var L = lowerG(x, yC), w = L.w, h = L.h, zC = w * 0.86;
      var gw = Math.min(Math.max(hiG(tgG, x, 0.3), 0.20), zC - 0.06), rail = top - Math.min(0.05, 0.35 * (top - bl)), gr = gw * 0.80;
      var screen = x > 0.10 && x < 0.80;
      function g(y) { return screen || inside(winG, x, y) ? 1 : 0; }
      h.push([yC - 0.008, lerp(w, zC, 0.85)], [yC - 0.002, zC + 0.006], [yC, zC],
        [lerp(yC, bl, 0.3), lerp(zC, gw, 0.3)], [lerp(yC, bl, 0.6), lerp(zC, gw, 0.6)], [lerp(yC, bl, 0.85), lerp(zC, gw, 0.85)],
        [bl - 0.002, gw + 0.008], [bl, gw, g(bl + 0.02)], [lerp(bl, rail, 0.55), lerp(gw, gr, 0.5), g(lerp(bl, rail, 0.55))], [rail, gr, g(rail - 0.01)],
        [lerp(rail, top, 0.6), gr * 0.62, screen ? 1 : 0], [lerp(rail, top, 0.85), gr * 0.42, screen ? 1 : 0], [top, gr * 0.26, screen ? 1 : 0],
        [top, gr * 0.12, screen ? 1 : 0], [top, 0, screen ? 1 : 0]);
      return { h: h, belt: bl };
    }
    function rearG(x) {
      var yTop = topG(x);
      var yPod = tab([[-0.62, 0.840], [-0.85, 0.745], [-1.00, 0.760], [-1.355, 0.820], [-1.80, 0.840], [-2.44, 0.860]], x);
      var L0 = lowerG(x, yPod + 0.10), yA = L0.h[3][0];
      yPod = Math.max(yPod, yA + 0.05);
      var L = lowerG(x, yPod), w = L.w, h = L.h;
      var yBt = Math.max(Math.min(tab([[-0.70, 0.960], [-1.20, 0.905], [-1.80, 0.880], [-2.44, 0.880]], x), yTop - 0.004), yPod + 0.07);
      var zBi = tab([[-0.60, 0.600], [-1.20, 0.700], [-1.80, 0.760], [-2.44, 0.780]], x), zBo = Math.min(zBi + 0.11, w - 0.04);
      var yFl = Math.min(tab([[-0.60, 0.860], [-0.95, 0.760], [-1.50, 0.740], [-2.00, 0.780], [-2.30, 0.840], [-2.44, 0.860]], x), yBt - 0.06);
      var zCan = Math.min(Math.max(hiG(tgG, x, 0), 0.30), zBi - 0.08), yC = Math.max(yTop, yFl + 0.05);
      h.push([yPod - 0.006, w], [yPod, w - 0.006], [yPod, zBo + 0.008, 0, 'black'], [yPod + 0.006, zBo],
        [yBt - 0.008, zBo], [yBt, zBo - 0.008], [yBt, zBi + 0.008], [yBt - 0.008, zBi],
        [yFl + 0.006, zBi, 0, 'black'], [yFl, zBi - 0.008, 0, 'black'], [yFl, zCan + 0.008, 0, 'black'], [yFl + 0.006, zCan],
        [lerp(yFl, yC, 0.7), zCan * 0.94], [yC - 0.004, zCan * 0.6], [yC, 0]);
      return { h: h, belt: null };
    }
    var front085 = frontG(0.85), cab075 = cabinG(0.75), cabM062 = cabinG(-0.62), rearM090 = rearG(-0.90);
    function ringG(x) {
      var R;
      if (x >= 0.85) R = frontG(x);
      else if (x > 0.75) R = blendRing(cab075, front085, smooth01((x - 0.75) / 0.10));
      else if (x >= -0.62) R = cabinG(x);
      else if (x > -0.90) R = blendRing(cabM062, rearM090, smooth01((-0.62 - x) / 0.28));
      else R = rearG(x);
      R.h.forEach(function (q) { if (!q[3] && q[0] < 0.150) q[3] = 'carbon'; });   // splitter, sills, diffuser
      return R;
    }
    var sections = ringSections(stationsX(XR + 0.003, XF - 0.003, 0.05, [XF - 0.010, XF - 0.025, XF - 0.05, XR + 0.010, XR + 0.025, XR + 0.05, 0.80, 0.10]
      .concat([aF.x, aR.x].reduce(function (acc, ax) { for (var d = -0.40; d <= 0.40; d += 0.04) acc.push(ax + d); return acc; }, []))), ringG, wellsG);

    return {
      id: 'ford-gt-2017', make: 'Ford', name: 'GT', gen: '2nd gen', years: '2017–2022', style: 'hypercar',
      look: { head: 'slim-led', tail: 'round-ring', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      color: '#1f4fa3', colorName: 'Liquid Blue',
      wheel: { style: 'split-5', spokes: 10, caliper: '#e8b100' },   // 20 in forged wheels, Brembo carbon-ceramic callipers
      badgeText: 'GT',
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim blade LED lamps sweeping up into the front wings above outer brake ducts.',
        taillights: '"Afterburner" ring lamps: one large round LED ring per side with a hollow centre that vents engine-bay air.',
        grille: 'Low hexagonal centre intake under a pointed nose, outer ducts, carbon splitter and big twin bonnet heat extractors.',
        notes: 'Teardrop canopy far forward, flying buttresses running from the rear wings to the tail with open air channels between them and the cabin, sculpted door scoops, active rear wing, twin central tailpipes.'
      },
      sources: ['2017 Ford GT technical specifications (Ford media)', 'Wikipedia: Ford GT (second generation)']
    };
  }

  /* ================================================================== */
  /* Jeep Wrangler Unlimited Rubicon (JL, 2018–)                         */
  /* ================================================================== */
  function wranglerJL() {
    var ref = {
      length: 4.785, width: 1.894, height: 1.848, wheelbase: 3.008, trackF: 1.598, trackR: 1.598,
      frontOverhang: 0.742, rearOverhang: 1.035, wheelDiameter_in: 17,
      tireF: 'LT285/70R17', tireR: 'LT285/70R17', groundClearance: 0.274, rideHeight: 0.274, cd: 0.454, curbWeight_kg: 2018
    };
    var XF = 2.246, XR = -2.539, H = 1.848, W = 0.947;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.504, y: rF, r: rF + 0.075, flare: 0.090 };
    var aR = { x: -1.504, y: rR, r: rR + 0.075, flare: 0.090 };
    var yb = 0.400, sillY = 0.295;
    var spX0 = -2.235, spCY = 1.000;           // tailgate-mounted spare: front face x, centre height

    // body-on-frame box: steel bumper, upright 7-slot grille, flat bonnet, upright screen, flat hardtop, spare on the tailgate
    var body = sideBody(aF, aR, yb, yb, [
      [2.06, 0.420, 'c'], [2.20, 0.425, 'c'], [XF, 0.470, 'c'], [XF, 0.660, 'c'], [2.165, 0.675, 'c'],
      [2.140, 0.720, 'c'], [2.122, 1.180, 'c'], [2.090, 1.250, 'c'],
      [1.70, 1.268], [1.20, 1.285], [0.720, 1.305, 'c'],
      // windscreen, then the hardtop
      [0.405, 1.808, 'c'], [0.330, H, 'c'], [-2.120, H, 'c'], [-2.195, 1.800, 'c'], [-2.210, 1.440, 'c'],
      // spare tyre seen side-on
      [spX0, 1.430, 'c'], [-2.490, 1.418, 'c'], [-2.530, 1.360], [XR, spCY, 'v'], [-2.530, 0.640], [-2.490, 0.585, 'c'], [spX0, 0.585, 'c'],
      // tailgate bottom and steel rear bumper
      [-2.210, 0.600, 'c'], [-2.210, 0.620, 'c'], [-2.285, 0.620, 'c'], [-2.285, 0.430, 'c'], [-2.06, 0.420, 'c']
    ], sillY);

    var fdGlass = [[0.640, 1.400, 'c'], [0.400, 1.762, 'c'], [-0.470, 1.762, 'c'], [-0.470, 1.400, 'c']];
    var rdGlass = [[-0.580, 1.400, 'c'], [-0.580, 1.762, 'c'], [-1.300, 1.762, 'c'], [-1.300, 1.400, 'c']];
    var qGlass = [[-1.420, 1.400, 'c'], [-1.420, 1.762, 'c'], [-2.110, 1.762, 'c'], [-2.130, 1.400, 'c']];
    var side = {
      body: body,
      greenhouse: rpoly([[0.690, 1.378], [0.420, 1.790], [-2.150, 1.790], [-2.170, 1.378]], 0.01),
      windows: [rpoly(fdGlass, 0.02), rpoly(rdGlass, 0.02), rpoly(qGlass, 0.02)],
      pillars: [rpoly([[0.722, 1.310], [0.405, 1.808], [0.330, 1.808], [0.640, 1.330]], 0.006)],
      doorCuts: [
        rpoly([[0.690, 0.560], [0.690, 1.360], [0.425, 1.800], [-0.520, 1.800], [-0.520, 0.560]], 0.02),
        // rear door, notched round the rear flare
        rpoly([[-0.540, 0.560], [-0.540, 1.800], [-1.360, 1.800], [-1.360, 1.240], [-1.100, 0.980], [-1.000, 0.560]], 0.02)
      ],
      panelLines: [
        curve([[0.700, 1.375], [-0.60, 1.378], [-2.200, 1.380]]),          // hardtop / tub joint
        curve([[2.090, 1.240], [1.50, 1.255], [0.740, 1.290]]),            // bonnet shut line
        curve([[0.900, 0.560], [0.900, 1.180]]),                           // wing / cowl seam
        curve([[-2.180, 0.640], [-2.180, 1.360]])                          // tailgate hinge line
      ],
      characterLines: [
        curve([[2.10, 1.170], [1.40, 1.180], [0.75, 1.200]]),              // wing top edge (bonnet sits higher between the wings)
        curve([[0.68, 1.330], [-0.60, 1.335], [-2.20, 1.338]])             // tub top rail
      ],
      sill: rrect(-1.00, sillY, 0.98, 0.430, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, 0.02) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, 0.02) },
      lowerTrim: [
        // steel front bumper, rock rail, steel rear bumper
        { path: rpoly([[1.95, 0.420], [XF, 0.430], [XF, 0.665], [1.95, 0.665]], 0.012), paint: 'black' },
        { path: rpoly([[-1.000, 0.330], [0.980, 0.330], [0.990, 0.500], [-1.010, 0.500]], 0.02), paint: 'black' },
        { path: rpoly([[-1.98, 0.425], [-2.285, 0.430], [-2.285, 0.620], [-1.98, 0.620]], 0.012), paint: 'black' },
        { path: rpoly([[-0.980, sillY], [0.960, sillY], [0.960, 0.335], [-0.980, 0.335]], 0.01), paint: 'black' }      // frame / skid plates
      ]
    };

    var top = {
      body: sym([[XF, 0, 'v'], [XF, 0.820, 'c'], [2.180, 0.890, 'c'], [2.040, W, 'c'], [1.000, W, 'c'], [0.960, 0.880, 'c'],
        [-0.980, 0.880, 'c'], [-1.010, W, 'c'], [-2.030, W, 'c'], [-2.120, 0.880, 'c'], [-2.285, 0.860, 'c'], [-2.285, 0.420, 'c'],
        [-2.480, 0.400], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.720, 0, 'v'], [0.720, 0.800, 'c'], [-2.160, 0.800, 'c'], [-2.160, 0, 'v']], 1),
      hood: sym([[2.130, 0, 'v'], [2.130, 0.700, 'c'], [0.760, 0.720, 'c'], [0.740, 0, 'v']], 1),
      roof: rpoly([[0.340, -0.820], [0.340, 0.820], [-2.150, 0.820], [-2.150, -0.820]], 0.04),
      deck: rpoly([[-2.160, -0.400], [-2.160, 0.400], [XR + 0.01, 0.380], [XR + 0.01, -0.380]], 0.08),
      mirrors: pair(rpoly([[0.620, 0.880], [0.620, 1.080], [0.460, 1.080], [0.460, 0.880]], 0.02), 1),
      // freedom-panel split over the front seats
      panelLines: [line([[-0.400, -0.820], [-0.400, 0.820]]), line([[0.340, 0], [-0.400, 0]])],
      characterLines: pair(line([[2.13, 0.30], [0.76, 0.30]]), 1)
    };

    var slotZ = [-0.270, -0.180, -0.090, 0, 0.090, 0.180, 0.270];
    var lampZ = 0.430, lampY = 0.985, lampR = 0.115;
    var front = {
      body: sym([[0, H, 'h'], [0.680, 1.846, 'c'], [0.720, 1.810, 'c'], [0.745, 1.400, 'c'], [0.860, 1.330, 'c'], [0.880, 1.160, 'c'],
        [W, 1.060, 'c'], [W, 0.620, 'c'], [0.900, 0.540, 'c'], [0.900, 0.420, 'c'], [0, 0.420, 'h']], 0),
      greenhouse: sym([[0, 1.790, 'h'], [0.660, 1.790, 'c'], [0.700, 1.370, 'c'], [0, 1.360, 'h']], 0),
      bumper: { path: sym([[0, 0.665, 'h'], [0.880, 0.665, 'c'], [0.900, 0.640, 'c'], [0.900, 0.430, 'c'], [0.860, 0.420, 'c'], [0, 0.420, 'h']], 0), paint: 'black' },
      characterLines: [line([[-0.880, 1.160], [-0.700, 1.200], [0.700, 1.200], [0.880, 1.160]])],
      panelLines: [line([[-0.680, 1.262], [0.680, 1.262]])],
      // the seven vertical slots, the outer ones notched by the round lamps
      grille: slotZ.map(function (z) { var o = Math.abs(z) > 0.25; return rrect(z - 0.030, o ? 0.840 : 0.800, z + 0.030, o ? 1.120 : 1.150, 0.022); }),
      intakes: [rpoly([[-0.300, 0.690], [0.300, 0.690], [0.280, 0.760], [-0.280, 0.760]], 0.015)],     // lower grille under the slots
      headlights: pair(ellipse(lampZ, lampY, lampR, lampR), 0),
      // LED halo ring: a C-shaped light guide round each lamp
      drl: pair(loop([[lampZ - 0.020, lampY + lampR + 0.010, 'c'], [lampZ + 0.105, lampY + 0.070], [lampZ + lampR + 0.012, lampY - 0.020], [lampZ + 0.092, lampY - 0.092, 'c'],
        [lampZ + 0.084, lampY - 0.082, 'c'], [lampZ + lampR - 0.002, lampY - 0.018], [lampZ + 0.096, lampY + 0.062], [lampZ - 0.020, lampY + lampR - 0.002, 'c']]), 0),
      fogLights: pair(ellipse(0.640, 0.545, 0.048, 0.048), 0),
      plateArea: rrect(-0.155, 0.470, 0.155, 0.610, 0.01),
      badgeArea: rrect(-0.110, 1.168, 0.110, 1.220, 0.008),
      badgeText: 'JEEP'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.680, 1.846, 'c'], [0.720, 1.810, 'c'], [0.750, 1.400, 'c'], [0.860, 1.330, 'c'], [0.880, 1.160, 'c'],
        [W, 1.060, 'c'], [W, 0.620, 'c'], [0.900, 0.560, 'c'], [0.900, 0.425, 'c'], [0, 0.425, 'h']], 0),
      greenhouse: sym([[0, 1.770, 'h'], [0.620, 1.770, 'c'], [0.660, 1.430, 'c'], [0, 1.430, 'h']], 0),
      bumper: { path: sym([[0, 0.620, 'h'], [0.880, 0.620, 'c'], [0.900, 0.600, 'c'], [0.900, 0.435, 'c'], [0.860, 0.425, 'c'], [0, 0.425, 'h']], 0), paint: 'black' },
      panelLines: [line([[-0.740, 1.380], [0.740, 1.380]]), line([[0.700, 0.640], [0.700, 1.360]])],
      // tall rectangular LED lamps at the corners
      taillights: [].concat(
        pair(rpoly([[0.735, 0.760], [0.870, 0.760], [0.870, 1.180], [0.735, 1.180]], 0.02), 0).map(function (p) { return { path: p, paint: 'gloss-black' }; }),
        pair(rpoly([[0.750, 1.010], [0.855, 1.010], [0.855, 1.165], [0.750, 1.165]], 0.015), 0),
        pair(rpoly([[0.750, 0.775], [0.855, 0.775], [0.855, 0.880], [0.750, 0.880]], 0.015), 0)
      ),
      diffuser: { path: rpoly([[-0.700, 0.300], [0.700, 0.300], [0.700, 0.425], [-0.700, 0.425]], 0.02), paint: 'black' },    // frame / hitch receiver area
      exhaust: [{ shape: 'round', cx: -0.560, cy: 0.385, w: 0.075, h: 0.075 }],
      plateArea: rrect(-0.155, 0.450, 0.155, 0.590, 0.01),
      badgeArea: rrect(-0.560, 0.700, -0.360, 0.745, 0.008),
      badgeText: 'WRANGLER'
    };

    var flareF = squareFlare(aF, yb, [[aF.x + aF.r + 0.090, yb], [aF.x + aF.r + 0.070, 0.700], [aF.x + 0.300, aF.y + aF.r + 0.095], [aF.x - 0.300, aF.y + aF.r + 0.095], [aF.x - aF.r - 0.070, 0.700], [aF.x - aF.r - 0.090, yb]]);
    var flareR = squareFlare(aR, yb, [[aR.x + aR.r + 0.090, yb], [aR.x + aR.r + 0.070, 0.700], [aR.x + 0.300, aR.y + aR.r + 0.095], [aR.x - 0.300, aR.y + aR.r + 0.095], [aR.x - aR.r - 0.070, 0.700], [aR.x - aR.r - 0.090, yb]]);
    var details = [
      D('side', 'trim', flareF, 'black'),
      D('side', 'trim', flareR, 'black'),
      D('side', 'marker', rrect(aF.x + 0.20, aF.y + aF.r + 0.050, aF.x + 0.42, aF.y + aF.r + 0.072, 0.008), 'light-amber'),   // LED marker in the flare
      D('side', 'mirror', rpoly([[0.620, 1.400], [0.620, 1.580], [0.430, 1.580], [0.430, 1.400]], 0.02), 'black'),
      D('side', 'handle', rrect(-0.420, 1.250, -0.260, 1.282, 0.010), 'black'),
      D('side', 'handle', rrect(-1.280, 1.250, -1.120, 1.282, 0.010), 'black'),
      // exposed door hinges
      D('side', 'trim', rrect(0.640, 1.120, 0.700, 1.200, 0.006), 'black'),
      D('side', 'trim', rrect(0.640, 0.700, 0.700, 0.780, 0.006), 'black'),
      D('side', 'trim', rrect(-0.560, 1.120, -0.520, 1.200, 0.006), 'black'),
      D('side', 'trim', rrect(-0.560, 0.700, -0.520, 0.780, 0.006), 'black'),
      D('side', 'vent', rpoly([[1.300, 1.200], [1.000, 1.205], [1.000, 1.235], [1.300, 1.230]], 0.01), 'grille'),        // cowl-side vent
      D('side', 'trim', rrect(-2.215, 0.770, -2.180, 1.170, 0.008), 'light-red'),                                       // lamp edge
      D('side', 'trim', rpoly([[spX0, 0.600], [XR + 0.004, 0.640], [XR + 0.004, 1.360], [spX0, 1.415]], 0.03), 'black'),  // spare tyre tread
      D('side', 'trim', rpoly([[2.140, 0.720], [2.200, 0.720], [2.200, 0.665], [2.140, 0.665]], 0.006), 'black'),
      D('side', 'trim', rrect(2.200, 0.540, 2.252, 0.570, 0.008), 'light-red'),        // tow hook
      D('side', 'antenna', line([[1.60, 1.290], [1.62, 1.700]]), 'black'),
      D('top', 'fuelCap', rrect(-1.80, -0.948, -1.66, -0.880, 0.012), 'black'),
      D('top', 'wiper', rrect(0.660, -0.70, 0.700, -0.05, 0.01), 'black'),
      D('top', 'wiper', rrect(0.660, 0.05, 0.700, 0.70, 0.01), 'black'),
      D('top', 'trim', ellipse(-2.390, 0, 0.150, 0.415), 'black')
    ].concat(
      // flares seen from above
      pairD('top', 'trim', rpoly([[2.040, 0.875], [2.040, W], [1.000, W], [1.000, 0.875]], 0.02), 'black', 1),
      pairD('top', 'trim', rpoly([[-1.010, 0.875], [-1.010, W], [-2.030, W], [-2.030, 0.875]], 0.02), 'black', 1),
      pairD('top', 'trim', rpoly([[XF, 0.42], [XF, 0.82], [2.150, 0.82], [2.150, 0.42]], 0.01), 'black', 1),
      // spare wheel, lamp lenses, hood side vents (front view), fender flares, tow hooks
      pairD('front', 'trim', rpoly([[0.880, 1.160], [W, 1.060], [W, 0.620], [0.880, 0.620], [0.860, 1.000]], 0.02), 'black', 0),
      pairD('front', 'light', ellipse(lampZ, lampY, lampR * 0.62, lampR * 0.62), 'glass', 0),
      pairD('front', 'light', ellipse(lampZ, lampY, lampR * 0.24, lampR * 0.24), 'chrome', 0),
      pairD('front', 'marker', rpoly([[0.900, 1.020], [0.940, 1.000], [0.940, 0.960], [0.900, 0.980]], 0.004), 'light-amber', 0),
      pairD('front', 'trim', rrect(0.360, 0.470, 0.440, 0.540, 0.012), 'light-red', 0),
      pairD('front', 'mirror', rpoly([[0.880, 1.400], [1.060, 1.400], [1.060, 1.580], [0.880, 1.580]], 0.02), 'black', 0),
      [D('front', 'wiper', rpoly([[-0.62, 1.395], [-0.05, 1.395], [-0.05, 1.408], [-0.62, 1.408]], 0.004), 'black'),
        D('front', 'wiper', rpoly([[0.05, 1.395], [0.62, 1.395], [0.62, 1.408], [0.05, 1.408]], 0.004), 'black'),
        D('rear', 'wheel', ellipse(0, spCY, rR, rR), 'black'),
        D('rear', 'wheel', ellipse(0, spCY, 0.215, 0.215), 'chrome'),
        D('rear', 'wheel', ellipse(0, spCY, 0.070, 0.070), 'black'),
        D('rear', 'light', rrect(-0.100, 1.440, 0.100, 1.470, 0.008), 'light-red'),       // CHMSL on the spare carrier
        D('rear', 'wiper', rpoly([[-0.05, 1.445], [0.45, 1.445], [0.45, 1.456], [-0.05, 1.456]], 0.004), 'black'),
        D('rear', 'handle', rrect(0.560, 1.240, 0.660, 1.270, 0.008), 'black')],
      pairD('rear', 'trim', rpoly([[0.880, 1.160], [W, 1.060], [W, 0.620], [0.880, 0.620]], 0.02), 'black', 0),
      pairD('rear', 'mirror', rpoly([[0.900, 1.400], [1.060, 1.400], [1.060, 1.580], [0.900, 1.580]], 0.02), 'black', 0)
    );

    /* Hand-built sections: flat vertical tub sides, flat bonnet standing above flat wing tops, square fender flares,
       upright flat windscreen, flat-sided hardtop; the spare is a true cylinder (axis along x) on the tailgate. */
    var sbJ = flat(body, 16), winJ = [];
    side.windows.forEach(function (w) { winJ = winJ.concat(flat(w, 12)); });
    var wellsJ = wellsOf(aF, aR, ref), zB = 0.880, zFl = W;
    function topJ(x) { var s = sliceX(sbJ, x); return s ? s[1] : 0.72; }
    function flareTopJ(a, x) {
      var dx = Math.abs(x - a.x), e1 = 0.30, e2 = 0.51, e3 = 0.53, yT = a.y + a.r + 0.095;
      if (dx <= e1) return yT;
      if (dx <= e2) return lerp(yT, 0.700, (dx - e1) / (e2 - e1));
      if (dx <= e3) return lerp(0.700, yb + 0.06, (dx - e2) / (e3 - e2));
      return null;
    }
    function lowerJ(x) {
      // underside: rock rails between the wheels hang lower than the frame line under the overhangs
      var yB = Math.abs(x) < 0.98 ? 0.330 : Math.abs(x) < 1.03 ? lerp(0.330, 0.400, (Math.abs(x) - 0.98) / 0.05) : (x > 1.9 || x < -1.95 ? 0.420 : 0.400);
      var a = x > 0 ? aF : aR, fT = flareTopJ(a, x), wl = wellAt(wellsJ, x);
      var h = [[yB, 0], [yB, zB - 0.035], [yB + 0.035, zB]];
      if (fT != null) {
        var yA = wl ? Math.max(wl.top + 0.003, yB + 0.05) : yB + 0.05;
        h.push([yA, zFl, 0, 'black'], [Math.max(fT, yA + 0.012), zFl, 0, 'black'], [Math.max(fT, yA + 0.012) + 0.005, zB, 0, 'black']);
      } else h.push([yB + 0.060, zB], [yB + 0.100, zB], [yB + 0.105, zB]);
      return h;
    }
    function hoodJ(x) {   // x >= 0.72: flat wing tops at ~1.18, bonnet wall up to the flat bonnet
      var yH = topJ(x), yW = Math.min(lerp(1.200, 1.170, clamp01((x - 0.75) / 1.35)), yH - 0.04), zI = 0.745, h = lowerJ(x);
      var yT = h[5][0]; yW = Math.max(yW, yT + 0.03);
      h.push([(yT + yW) / 2, zB], [yW - 0.005, zB], [yW, zB - 0.005], [yW, zI + 0.005],
        [yW + 0.005, zI], [(yW + yH) / 2, zI], [yH - 0.005, zI], [yH, zI - 0.005],
        [yH, 0.62], [yH, 0.50], [yH, 0.40], [yH, 0.30], [yH, 0.20], [yH, 0.10], [yH, 0]);
      return { h: h, belt: null };
    }
    function cabinJ(x) {   // x <= 0.405: tub rail, flat-sided hardtop, flat roof
      var top = x > -2.215 ? Math.max(topJ(x), 1.780) : topJ(x), yS = 1.338, zI = 0.795, h = lowerJ(x), yT = h[5][0];
      var yG0 = 1.400, yG1 = Math.min(1.765, top - 0.07), g = inside(winJ, x, (yG0 + yG1) / 2) ? 1 : 0;
      h.push([(yT + yS) / 2, zB], [yS - 0.005, zB], [yS, zB - 0.005], [yS, zI + 0.005],
        [yS + 0.005, zI], [yG0, zI - 0.002, g], [yG1, 0.765, g], [top - 0.030, 0.758],
        [top - 0.008, 0.745], [top, 0.715], [top, 0.55], [top, 0.40], [top, 0.27], [top, 0.13], [top, 0]);
      return { h: h, belt: 1.380 };
    }
    function bumperJ(y0, y1, z) {   // steel bumper block (front)
      var h = [[y0, 0], [y0, 0.25], [y0, 0.50], [y0, z - 0.02], [y0 + 0.015, z], [y1 - 0.015, z], [y1, z - 0.02]];
      for (var k = 0; k < 14; k++) h.push([y1, (z - 0.02) * (13 - k) / 14]);
      return h.map(function (q) { q[3] = 'black'; return q; });
    }
    var rS = rR, phi0 = Math.asin((0.620 - spCY) / rS);
    function circ(phi, r) { return [spCY + (r || rS) * Math.sin(phi), (r || rS) * Math.cos(phi), 0, 'black']; }
    function spareJ(keyhole, r) {   // keyhole = rear bumper block joined to the tyre circle; else the tyre alone
      r = r || rS;
      var p0 = Math.asin(Math.max(-1, (0.620 - spCY) / r)), h;
      if (keyhole) h = [[0.430, 0, 0, 'black'], [0.430, 0.840, 0, 'black'], [0.450, 0.860, 0, 'black'], [0.600, 0.860, 0, 'black'], [0.620, 0.840, 0, 'black']];
      else { h = []; for (var i = 0; i < 5; i++) h.push(circ(-Math.PI / 2 + (p0 + Math.PI / 2) * i / 5, r)); }
      for (var k = 0; k <= 15; k++) h.push(circ(p0 + (Math.PI / 2 - p0) * k / 15, r));
      return h;
    }
    var hood072 = hoodJ(0.72), cab0405 = cabinJ(0.405);
    function ringJ(x) {
      if (x > 2.1425) return { h: bumperJ(0.420, 0.665, 0.820), belt: null, noWell: true };
      if (x >= 0.72) return hoodJ(x);
      if (x > 0.405) {   // flat raked windscreen between the cowl and the header
        var t = (0.72 - x) / (0.72 - 0.405), R = blendRing(hood072, cab0405, t);
        for (var j = 12; j < HK; j++) if (x < 0.700 && x > 0.420) R.h[j][2] = 1;
        R.h[11][2] = 0; R.belt = 1.300; return R;
      }
      if (x >= -2.210) return cabinJ(x);
      if (x >= -2.285) return { h: spareJ(true), belt: null, noWell: true };
      if (x > -2.524) return { h: spareJ(false), belt: null, noWell: true };
      if (x > -2.537) return { h: spareJ(false, rS - 0.030), belt: null, noWell: true };
      return { h: spareJ(false, 0.300), belt: null, noWell: true };
    }
    var xsJ = stationsX(-2.539, XF, 0.06, [XF - 0.004, 2.200, 2.150, 2.1426, 2.140, 2.135, 2.130, 2.125, 2.120, 2.110, 2.100, 2.090,
      0.721, 0.719, 0.70, 0.42, 0.406, 0.404, -2.150, -2.195, -2.209, -2.2125, -2.284, -2.287, -2.523, -2.536, -2.539]
      .concat([aF.x, aR.x].reduce(function (acc, ax) {
        for (var d = -0.54; d <= 0.54; d += 0.03) acc.push(ax + d);
        return acc.concat([ax - 0.531, ax + 0.531, ax - 0.529, ax + 0.529]);
      }, [])));
    var sections = ringSections(xsJ, function (x) {
      var R = ringJ(x);
      R.h.forEach(function (q) { if (!q[3] && q[0] < 0.505) q[3] = 'black'; });   // frame, rock rails, lower bumpers
      return R;
    }, wellsJ);

    return {
      id: 'jeep-wrangler-rubicon-jl', make: 'Jeep', name: 'Wrangler Unlimited Rubicon', gen: 'JL', years: '2018–', style: 'suv',
      look: { head: 'round-halo', tail: 'vertical', grille: 'seven-slot' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice', ref: ref, doors: 4,
      color: '#2f5d3a', colorName: 'Sarge Green',
      wheel: { style: 'multi-spoke', spokes: 5, finish: '#2b2d30', caliper: '#3a3c40' },   // 17 in Rubicon wheels on 33 in mud-terrains
      badgeText: 'RUBICON',
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Round LED headlamps with a C-shaped halo DRL, notching into the outer grille slots.',
        taillights: 'Tall rectangular LED lamps at the rear corners in black housings.',
        grille: 'Seven vertical slots, upright and slightly raked back, with the round lamps set into the outer slots; black steel bumper with round fogs and red tow hooks.',
        notes: 'Body-on-frame box: flat bonnet sitting higher than the wings, upright windscreen, flat removable hardtop, exposed door hinges, squared black fender flares with LED markers, rock rails, tailgate-mounted full-size spare.'
      },
      sources: ['Jeep Wrangler JL specifications (Stellantis media)', 'JLwranglerforums.com: official JL dimensions (overhangs 741.6 / 1036.3 mm)']
    };
  }

  /* ------------------------------------------------------------------ */
  var list = [mustangS650(), camaroZL1(), challengerHellcat(), corvetteC8(), fordGT2017(), wranglerJL()];
  list.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { models: list };
})();

/* ==========================================================================
   FORGE Atelier — js/shapes/models/pack-sport.js
   Sports-car pack (none is a style default):
     - BMW M2 (G87, 2023–)                     bmw-m2-g87                 'coupe'
     - BMW M3 Coupé (E46, 2000–2006)           bmw-m3-e46                 'coupe'
     - Alpine A110 (2017–)                     alpine-a110                'coupe'
     - Aston Martin Vantage (2018–2024)        aston-martin-vantage-2018  'coupe'
     - Lotus Emira (2022–)                     lotus-emira                'coupe'
     - Subaru WRX STI (VA, 2014–2021)          subaru-wrx-sti-va          'sedan'
     - Mitsubishi Lancer Evolution X (2007–16) mitsubishi-lancer-evo-x    'sedan'
   Rear-wheel-drive drivers' cars for the drift mode, plus the two AWD rally-bred sedans.

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top view = (x, z); front & rear views = (z, y).

   Published figures (manufacturer data as listed by auto-data.net, ultimatespecs,
   Wikipedia; overhang splits for the Alpine from Alpine's data sheet, the
   others derived from length − wheelbase and reference side elevations):
     M2 G87   4580 × 1887 × 1403, wb 2747, track 1617/1605, 275/35 R19 + 285/30 R20
     M3 E46   4492 × 1780 × 1372, wb 2731, track 1508/1525, 225/45 R18 + 255/40 R18
     A110     4180 × 1798 × 1252, wb 2419, track 1557/1552, overhangs 911/850,
              205/40 R18 + 235/40 R18
     Vantage  4465 × 1942 × 1273, wb 2704, 255/40 R20 + 295/35 R20
     Emira    4413 × 1895 × 1226, wb 2575, track 1624/1610, overhangs 988/850,
              245/35 ZR20 + 295/30 ZR20
     WRX STI  4595 × 1795 × 1475, wb 2650, track 1530/1540, 245/40 R18
              (overhang split 930/1015 estimated from side elevations)
     Evo X    4505 × 1810 × 1480, wb 2650, track 1545/1545, overhangs 920/935,
              245/40 R18

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}. Body
   surfaces are smooth G1 cubic splines through hand-placed landmarks. Brand
   names are text only: no manufacturer logo artwork is drawn; badgeArea marks
   where a text badge goes.

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
    if (cfg.crispTail) crispTail(out, sb, tb, XR, cfg.crispTail);
    return out;
  }
  /* Explicit tail sections: over the last `span` metres every ring is rebuilt from the last full ring (at XR + span)
     clipped to the side silhouette and the plan outline at its station (the visual hull of the two views). The
     smooth rings otherwise shrink in both directions at once and round the tail into an ellipsoid; clipped rings
     keep a flat tail panel, a crisp deck edge and crisp plan corners, and the end cap closes a flat rear face. */
  function crispTail(out, sb, tb, XR, span) {
    var xr = XR + span, ref = null;
    out.forEach(function (s) { if (s.x >= xr && (!ref || s.x < ref.x)) ref = s; });
    if (!ref) return;
    out.forEach(function (s) {
      if (s.x >= ref.x) return;
      var sl = sliceX(sb, s.x), tw = sliceX(tb, s.x);
      if (!sl || !tw) return;
      // 3 cm fillet round the tail-panel edge so it reads crisp but not knife-sharp
      var d = s.x - XR, FR = 0.03, ins = d < FR ? FR - Math.sqrt(FR * FR - (FR - d) * (FR - d)) : 0;
      var w = Math.max(0.02, Math.max(Math.abs(tw[0]), Math.abs(tw[1])) - 0.002 - ins), lo = sl[0] + 0.002, hi = Math.max(lo + 0.02, sl[1] - 0.002 - 0.6 * ins);
      s.ring = ref.ring.map(function (q) {
        var y = Math.max(lo, Math.min(hi, q[0])), z = Math.max(-w, Math.min(w, q[1]));
        return [r4(y), r4(z)];
      });
      s.glass = s.ring.map(function () { return 0; });
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

  /* ================================================================== */
  /* BMW M2 (G87)                                                        */
  /* ================================================================== */
  function bmwM2() {
    var ref = {
      length: 4.580, width: 1.887, height: 1.403, wheelbase: 2.747, trackF: 1.617, trackR: 1.605,
      frontOverhang: 0.867, rearOverhang: 0.966, wheelDiameter_in: 20, wheelDiameterF_in: 19, wheelDiameterR_in: 20,
      tireF: '275/35ZR19', tireR: '285/30ZR20', groundClearance: 0.123, rideHeight: 0.123, cd: 0.35, curbWeight_kg: 1725
    };
    var XF = 2.2405, XR = -2.3395, H = 1.403;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.3735, y: rF, r: rF + 0.030, flare: 0.030 };
    var aR = { x: -1.3735, y: rR, r: rR + 0.030, flare: 0.036 };
    var yb = 0.170;

    // short, upright and boxy: flat bonnet, near-vertical nose, short square boot deck
    var roofLine = [[0.58, 0.985, 'c'], [0.15, 1.200], [-0.20, 1.372], [-0.48, H, 'h'], [-0.95, 1.372], [-1.42, 1.262], [-1.84, 1.095, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.90, 0.172], [2.15, 0.132, 'c'], [2.222, 0.200], [XF, 0.36, 'v'], [2.237, 0.560], [2.226, 0.720], [2.195, 0.790],
      [2.140, 0.818], [1.95, 0.842], [1.60, 0.877], [1.10, 0.928]
    ].concat(roofLine, [
      [-2.05, 1.082], [-2.25, 1.072], [-2.285, 1.082, 'c'], [-2.318, 1.000, 'c'], [XR, 0.72, 'v'], [-2.332, 0.48], [-2.300, 0.30], [-2.22, 0.192, 'c'], [-1.95, yb, 'c']
    ]), 0.160);

    var doorGlass = [[0.45, 1.020, 'c'], [0.13, 1.195], [-0.20, 1.345], [-0.48, 1.374, 'h'], [-0.86, 1.360, 'c'], [-0.88, 1.050, 'c']];
    var side = {
      body: body,
      // daylight opening only: frameless door glass + B-pillar + quarter glass with the Hofmeister kink
      greenhouse: loop([[0.452, 1.014, 'c'], [0.131, 1.195], [-0.20, 1.347], [-0.48, 1.380, 'h'], [-0.93, 1.354], [-1.12, 1.318], [-1.26, 1.262], [-1.335, 1.205],
        [-1.36, 1.150, 'c'], [-1.440, 1.082, 'c'], [-1.28, 1.066], [-0.90, 1.044], [0.10, 1.012]]),
      windows: [
        loop(doorGlass),
        loop([[-0.930, 1.054, 'c'], [-0.925, 1.346, 'c'], [-1.10, 1.312], [-1.23, 1.262], [-1.30, 1.205], [-1.345, 1.150, 'c'], [-1.425, 1.088, 'c'], [-1.28, 1.076], [-1.10, 1.064]])
      ],
      pillars: [
        loop([[0.58, 0.985, 'c'], [0.15, 1.200], [-0.20, 1.372, 'c'], [-0.20, 1.345, 'c'], [0.13, 1.195], [0.45, 1.020, 'c']])
      ],
      doorCuts: [loop([[0.74, 0.268, 'c'], [0.735, 0.60], [0.69, 0.88], [0.56, 0.995]].concat(doorGlass, [[-0.95, 0.80], [-0.99, 0.275, 'c']]))],
      panelLines: [
        curve([[2.10, 0.800], [1.98, 0.580], [1.760, 0.420]]),            // front bumper / wing seam
        curve([[-1.84, 0.640], [-1.86, 0.47], [-1.88, 0.300]]),           // rear bumper seam behind the arch
        curve([[-1.95, 0.880], [-2.15, 0.879], [-2.322, 0.876]]),         // bumper top seam under the lamps
        curve([[-1.85, 1.080], [-2.00, 1.060], [-2.22, 1.058], [-2.30, 1.045]]),   // boot-lid shut line
        curve([[2.15, 0.808], [1.50, 0.870], [0.70, 0.962]]),             // bonnet shut line
        rrect(-1.78, 0.86, -1.63, 0.97, 0.02)                              // fuel flap (right rear quarter)
      ],
      characterLines: [
        curve([[2.08, 0.790], [1.40, 0.842], [0.40, 0.884], [-0.80, 0.912], [-1.60, 0.950], [-2.30, 0.960]]),   // straight, high shoulder line
        curve([[0.78, 0.430], [0.00, 0.452], [-0.85, 0.505]]),                                                 // door swage rising rearward
        // squared-off box flares: upper edges of the wide front and rear arches
        curve([[1.80, 0.660], [1.55, 0.730], [1.20, 0.740], [0.98, 0.640]]),
        curve([[-0.98, 0.700], [-1.25, 0.780], [-1.60, 0.775], [-1.80, 0.680]])
      ],
      sill: rrect(-1.02, 0.160, 1.02, 0.226, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.02, 0.160, 'c'], [-1.02, 0.160, 'c'], [-1.025, 0.184, 'c'], [1.025, 0.184, 'c']]),              // side-skirt blade
        loop([[1.72, 0.174, 'c'], [1.90, 0.175], [2.15, 0.136, 'c'], [2.20, 0.160, 'c'], [1.90, 0.198], [1.725, 0.216, 'c']]),
        loop([[-1.72, 0.174, 'c'], [-1.95, 0.173], [-2.22, 0.196, 'c'], [-2.27, 0.250, 'c'], [-1.95, 0.214], [-1.715, 0.216, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.20, -0.58], [-0.20, 0.58], [-1.18, 0.55], [-1.18, -0.55]], 0.07);
    var top = {
      // square nose, box-flared front and rear arches, slim waist at the doors
      body: sym([[XF, 0, 'v'], [2.237, 0.40], [2.22, 0.76], [2.16, 0.862], [2.04, 0.906], [1.85, 0.930], [1.37, 0.940, 'h'], [0.85, 0.912], [0.00, 0.900],
        [-0.85, 0.915], [-1.37, 0.9435, 'h'], [-1.92, 0.932], [-2.22, 0.874], [-2.31, 0.66], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.60, 0, 'v'], [0.52, 0.70, 'c'], [0.15, 0.712], [-0.70, 0.682], [-1.36, 0.640], [-1.78, 0.580], [-1.86, 0.40], [-1.87, 0, 'v']], 1),
      hood: sym([[2.17, 0, 'v'], [2.14, 0.55], [2.02, 0.73, 'c'], [0.62, 0.70, 'c'], [0.58, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.87, 0, 'v'], [-1.88, 0.60, 'c'], [-2.27, 0.72, 'c'], [-2.30, 0, 'v']], 1),
      mirrors: pair(loop([[0.48, 0.900, 'c'], [0.45, 1.000], [0.39, 1.036], [0.29, 1.030], [0.25, 0.970], [0.255, 0.900, 'c']]), 1),
      // twin bonnet creases running forward to the outer kidney corners
      characterLines: pair(curve([[2.14, 0.34], [1.60, 0.36], [1.00, 0.38], [0.66, 0.39]]), 1)
    };

    // frameless, wide horizontal kidneys (each 0.32 wide x 0.30 tall) between the lamps
    var kidney = rpoly([[0.030, 0.795, 0.03], [0.330, 0.795, 0.05], [0.358, 0.760, 0.04], [0.352, 0.525, 0.04], [0.325, 0.495, 0.03], [0.036, 0.495, 0.03]], 0.04);
    var front = {
      body: sym([[0, H, 'h'], [0.44, 1.388], [0.60, 1.31], [0.68, 1.13], [0.74, 1.01], [0.86, 0.94], [0.925, 0.85],
        [0.9435, 0.62, 'v'], [0.935, 0.40], [0.905, 0.24], [0.85, 0.150, 'c'], [0.60, 0.132], [0, 0.124, 'h']], 0),
      greenhouse: sym([[0, 1.370, 'h'], [0.44, 1.355], [0.58, 1.29], [0.66, 1.11], [0.72, 1.000, 'c'], [0, 0.975, 'h']], 0),
      bumper: sym([[0, 0.480, 'h'], [0.40, 0.482], [0.38, 0.62], [0.42, 0.700], [0.90, 0.700], [0.935, 0.40], [0.905, 0.24], [0.85, 0.150, 'c'], [0.60, 0.132], [0, 0.124, 'h']], 0),
      characterLines: [
        curve([[-0.88, 0.90], [-0.66, 0.905, 'h'], [-0.40, 0.858], [0, 0.846, 'h'], [0.40, 0.858], [0.66, 0.905, 'h'], [0.88, 0.90]]),   // bonnet edge between the wings
        curve([[-0.34, 0.84], [-0.31, 0.90], [-0.27, 0.958]]),
        curve([[0.34, 0.84], [0.31, 0.90], [0.27, 0.958]])
      ],
      grille: pair(kidney, 0),
      // big squared outer intakes with a vertical splitter bar, wide centre intake below the plate
      intakes: pair(rpoly([[0.43, 0.205], [0.83, 0.205], [0.855, 0.300], [0.845, 0.470], [0.62, 0.462], [0.41, 0.370]], 0.02), 0).concat([
        rpoly([[-0.38, 0.150], [0.38, 0.150], [0.345, 0.285], [-0.345, 0.285]], 0.02)
      ], pair(rrect(0.870, 0.300, 0.905, 0.500, 0.012), 0)),   // vertical air curtains at the corners
      // slim angular lamps: inner tips meet the kidney tops, outer ends wrap the wing corners
      headlights: pair(rpoly([[0.375, 0.805], [0.885, 0.828], [0.905, 0.798], [0.880, 0.718], [0.600, 0.726], [0.395, 0.748]], 0.008), 0),
      drl: [].concat(
        // two upright L-shaped DRL light guides per lamp
        pair(rpoly([[0.480, 0.805], [0.510, 0.806], [0.510, 0.760], [0.545, 0.758], [0.545, 0.738], [0.480, 0.741]], 0.004), 0),
        pair(rpoly([[0.710, 0.815], [0.740, 0.816], [0.740, 0.770], [0.775, 0.768], [0.775, 0.746], [0.710, 0.749]], 0.004), 0)
      ),
      splitter: rpoly([[-0.86, 0.124], [0.86, 0.124], [0.88, 0.150], [-0.88, 0.150]], 0.008),
      plateArea: rrect(-0.26, 0.315, 0.26, 0.425, 0.01),
      badgeArea: rrect(-0.04, 0.806, 0.04, 0.840, 0.01)
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.44, 1.385], [0.56, 1.29], [0.64, 1.14], [0.78, 1.088], [0.89, 1.035], [0.937, 0.90], [0.9435, 0.66, 'v'],
        [0.935, 0.40], [0.89, 0.22], [0.82, 0.170, 'c'], [0, 0.160, 'h']], 0),
      greenhouse: sym([[0, 1.362, 'h'], [0.43, 1.347], [0.54, 1.262], [0.60, 1.130], [0.58, 1.092, 'c'], [0, 1.082, 'h']], 0),
      bumper: sym([[0, 0.760, 'h'], [0.60, 0.760], [0.90, 0.740], [0.94, 0.55], [0.935, 0.40], [0.89, 0.22], [0.82, 0.170, 'c'], [0, 0.160, 'h']], 0),
      panelLines: [curve([[-0.42, 0.952], [0, 0.948, 'h'], [0.42, 0.952]])],                                     // boot-lid shut line between the lamps
      characterLines: [curve([[-0.92, 0.735], [-0.60, 0.762], [0, 0.768, 'h'], [0.60, 0.762], [0.92, 0.735]])],   // bumper step
      // slim horizontal L lamps wrapping onto the boot lid, outer leg drops down the quarter
      taillights: pair(loop([[0.44, 1.024, 'c'], [0.84, 1.030], [0.912, 1.004], [0.925, 0.935], [0.915, 0.902, 'c'], [0.86, 0.908, 'c'], [0.82, 0.950], [0.62, 0.958], [0.46, 0.972, 'c']]), 0),
      // large four-channel diffuser between the two pairs of tailpipes
      diffuser: sym([[0, 0.380, 'h'], [0.30, 0.380], [0.70, 0.335, 'c'], [0.68, 0.170], [0, 0.160, 'h']], 0),
      exhaust: [0.43, 0.57, -0.43, -0.57].map(function (z) { return { shape: 'round', cx: z, cy: 0.255, w: 0.100, h: 0.100 }; }),
      plateArea: rrect(-0.26, 0.585, 0.26, 0.695, 0.01),
      badgeArea: rrect(-0.10, 0.890, 0.10, 0.925, 0.008),
      spoiler: sym([[0, 1.078, 'h'], [0.55, 1.078], [0.70, 1.052, 'c'], [0, 1.042, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.48, 1.022, 'c'], [0.465, 1.095], [0.36, 1.112], [0.25, 1.080], [0.255, 1.030], [0.38, 1.014]]), 'body'),
      D('side', 'trim', rpoly([[-0.874, 1.048], [-0.856, 1.362], [-0.930, 1.354], [-0.936, 1.048]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.66, 0.872, -0.46, 0.896, 0.010), 'body'),
      D('side', 'intake', rpoly([[2.205, 0.300], [2.228, 0.310], [2.230, 0.500], [2.212, 0.498]], 0.006), 'grille'),   // air-curtain opening at the bumper corner
      D('side', 'grille', loop([[2.205, 0.795, 'c'], [2.228, 0.775], [2.236, 0.640], [2.233, 0.505, 'c'], [2.222, 0.505, 'c'], [2.224, 0.640], [2.215, 0.770]]), 'grille'),   // kidney edge
      D('side', 'trim', loop([[2.205, 0.778], [2.13, 0.808], [2.00, 0.826], [2.02, 0.790], [2.15, 0.772]]), 'light'),
      D('side', 'trim', loop([[-2.20, 1.020, 'c'], [-2.300, 1.016], [-2.318, 0.975], [-2.326, 0.910, 'c'], [-2.24, 0.915], [-2.20, 0.97, 'c']]), 'light-red'),
      D('side', 'trim', rrect(-2.24, 1.012, -2.08, 1.030, 0.006), 'light-red'),          // L-return along the boot shut line
      D('side', 'trim', rrect(-2.336, 0.40, -2.300, 0.47, 0.006), 'light-red'),          // rear bumper reflector
      D('side', 'marker', rrect(0.98, 0.700, 1.04, 0.716, 0.006), 'light-amber'),        // side repeater behind the front arch
      D('top', 'trim', sym([[1.98, 0, 'v'], [1.96, 0.24], [0.78, 0.30], [0.66, 0, 'v']], 1), 'body'),   // bonnet power dome
      D('top', 'fuelCap', rrect(-1.78, 0.866, -1.63, 0.926, 0.012), 'body'),
      D('top', 'wiper', rrect(0.56, -0.05, 0.60, 0.60, 0.01), 'black'),
      D('top', 'antenna', rrect(-1.16, -0.03, -1.06, 0.03, 0.02), 'gloss-black'),       // shark-fin
      D('top', 'trim', rrect(-2.335, -0.86, -2.300, 0.86, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.29, -0.62, -2.25, 0.62, 0.008), 'body')
    ].concat(
      pairD('top', 'trim', loop([[2.224, 0.42, 'c'], [2.200, 0.70], [2.150, 0.810, 'c'], [2.07, 0.862, 'c'], [2.115, 0.70], [2.145, 0.42, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.72, 0.990, 'c'], [0.86, 1.005], [1.02, 1.015], [1.036, 1.065], [0.97, 1.105], [0.88, 1.100], [0.83, 1.035], [0.72, 1.022, 'c']]), 'body', 0),
      // double horizontal kidney slats (M-specific), clear of the front plate
      [0.540, 0.590, 0.640, 0.690, 0.740].reduce(function (acc, y) {
        return acc.concat(pairD('front', 'trim', rrect(0.055, y, 0.335, y + 0.010, 0.004), 'gloss-black', 0),
          pairD('front', 'trim', rrect(0.055, y + 0.018, 0.335, y + 0.026, 0.004), 'gloss-black', 0));
      }, []),
      pairD('front', 'vent', rrect(0.618, 0.215, 0.640, 0.458, 0.006), 'gloss-black', 0),     // vertical intake splitter
      pairD('front', 'trim', rrect(0.44, 0.475, 0.83, 0.488, 0.004), 'gloss-black', 0),       // intake upper lip
      [
        D('front', 'wiper', rpoly([[-0.05, 0.985], [0.58, 1.010], [0.58, 1.020], [-0.05, 0.997]], 0.004), 'black'),
        D('rear', 'trim', curve([[-0.70, 1.050], [0, 1.060], [0.70, 1.050]]), 'body')
      ],
      [0, 0.12, -0.12, 0.24, -0.24].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.17, z + 0.008, 0.36, 0.004), 'gloss-black'); }),   // diffuser fins
      pairD('rear', 'trim', rpoly([[0.47, 1.012], [0.86, 1.017], [0.902, 0.918], [0.888, 0.914], [0.846, 1.002], [0.47, 0.998]], 0.004), 'light', 0),  // 3D light-guide
      pairD('rear', 'trim', rrect(0.860, 0.40, 0.890, 0.48, 0.008), 'light-red', 0),          // vertical reflectors
      pairD('rear', 'vent', rpoly([[0.76, 0.30], [0.86, 0.30], [0.88, 0.50], [0.80, 0.50]], 0.01), 'black', 0),   // rear air breathers
      pairD('rear', 'mirror', loop([[0.946, 1.010, 'c'], [1.02, 1.010], [1.036, 1.065], [0.97, 1.105], [0.946, 1.100, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.160, xWS: 0.58, xBL: -1.87,
      belt: [[0.58, 0.985], [0.45, 1.016], [0.00, 1.024], [-0.90, 1.046], [-1.28, 1.068], [-1.38, 1.090], [-1.44, 1.115], [-1.65, 1.110], [-1.87, 1.090]],
      crest: [[2.24, 0.50, 0.60], [2.10, 0.82, 0.70], [1.70, 0.866, 0.76], [1.37, 0.89, 0.80], [0.60, 0.95, 0.90], [-0.40, 0.97, 0.94],
        [-1.37, 1.00, 0.92], [-1.80, 1.03, 0.82], [-2.15, 1.05, 0.74], [-2.34, 0.98, 0.62]],
      dip: [[2.24, 0.0], [2.15, 0.03], [2.05, 0.05], [1.60, 0.05], [1.00, 0.03], [0.58, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'bmw-m2-g87', make: 'BMW', name: 'M2', gen: 'G87', years: '2023–', style: 'coupe',
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      wheel: { style: 'y-spoke', spokes: 10, caliper: '#1e4fa0' },   // M Compound blue callipers
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim angular LED headlamps whose inner tips meet the top corners of the grille, each with two upright L-shaped DRL light guides.',
        taillights: 'Slim L-shaped LED tail lamps wrapping from the quarter onto the boot lid with a three-dimensional light guide; small lip spoiler.',
        grille: 'Frameless, wide horizontal kidney grille with double horizontal M slats, over squared outer intakes with vertical splitters and corner air curtains.',
        notes: 'Compact, upright and boxy: flat bonnet with power dome, box-flared front and rear arches, straight high shoulder line, Hofmeister kink, quad round tailpipes in pairs around a large diffuser.'
      }
    };
  }

  /* ================================================================== */
  /* BMW M3 Coupé (E46)                                                  */
  /* ================================================================== */
  function bmwM3E46() {
    var ref = {
      length: 4.492, width: 1.780, height: 1.372, wheelbase: 2.731, trackF: 1.508, trackR: 1.525,
      frontOverhang: 0.795, rearOverhang: 0.966, wheelDiameter_in: 18,
      tireF: '225/45ZR18', tireR: '255/40ZR18', groundClearance: 0.120, rideHeight: 0.120, cd: 0.32, curbWeight_kg: 1495
    };
    var XF = 2.1605, XR = -2.3315, H = 1.372;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.3655, y: rF, r: rF + 0.025, flare: 0.034 };     // M-flared arches over the wide tyres
    var aR = { x: -1.3655, y: rR, r: rR + 0.027, flare: 0.040 };
    var yb = 0.175;

    // classic three-box coupé: short nose, long cabin, gently curved roof, short high boot
    var roofLine = [[0.60, 0.905, 'c'], [0.20, 1.130], [-0.15, 1.330], [-0.45, H, 'h'], [-0.95, 1.345], [-1.40, 1.235], [-1.72, 1.085, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.85, 0.177], [2.08, 0.150, 'c'], [2.140, 0.220], [XF, 0.380, 'v'], [2.152, 0.520], [2.128, 0.640], [2.090, 0.722],
      [2.00, 0.752], [1.70, 0.778], [1.20, 0.835], [0.85, 0.872]
    ].concat(roofLine, [
      [-1.95, 1.066], [-2.20, 1.052], [-2.270, 1.046, 'c'], [-2.312, 0.970], [XR, 0.70, 'v'], [-2.326, 0.47], [-2.285, 0.28], [-2.19, 0.195, 'c'], [-1.95, yb, 'c']
    ]), 0.165);

    // frameless door glass; small black B-pillar; quarter glass with a pronounced Hofmeister kink
    var doorGlass = [[0.48, 0.935, 'c'], [0.17, 1.125], [-0.15, 1.304], [-0.45, 1.344, 'h'], [-0.80, 1.332, 'c'], [-0.82, 0.965, 'c']];
    var side = {
      body: body,
      greenhouse: loop([[0.482, 0.929, 'c'], [0.171, 1.125], [-0.15, 1.306], [-0.45, 1.350, 'h'], [-0.87, 1.326], [-1.05, 1.296], [-1.20, 1.240], [-1.285, 1.180],
        [-1.33, 1.120, 'c'], [-1.412, 1.000, 'c'], [-1.25, 0.982], [-0.85, 0.962], [0.10, 0.940]]),
      windows: [
        loop(doorGlass),
        loop([[-0.870, 0.970, 'c'], [-0.865, 1.318, 'c'], [-1.05, 1.287], [-1.19, 1.235], [-1.27, 1.178], [-1.315, 1.118, 'c'], [-1.395, 1.006, 'c'], [-1.25, 0.992], [-1.05, 0.980]])
      ],
      pillars: [
        loop([[0.60, 0.905, 'c'], [0.20, 1.130], [-0.15, 1.330, 'c'], [-0.15, 1.304, 'c'], [0.17, 1.125], [0.48, 0.935, 'c']])
      ],
      doorCuts: [loop([[0.80, 0.262, 'c'], [0.795, 0.60], [0.75, 0.82], [0.62, 0.910]].concat(doorGlass, [[-0.90, 0.78], [-0.98, 0.270, 'c']]))],
      panelLines: [
        curve([[2.06, 0.700], [1.92, 0.560], [1.700, 0.440]]),            // bumper / wing seam
        curve([[-1.72, 0.600], [-1.74, 0.46], [-1.76, 0.300]]),           // rear bumper seam behind the arch
        curve([[-1.95, 0.840], [-2.15, 0.839], [-2.318, 0.836]]),         // rear bumper top seam
        curve([[-1.73, 1.078], [-1.90, 1.052], [-2.20, 1.040], [-2.268, 1.034]]),   // boot-lid shut line
        curve([[2.06, 0.735], [1.60, 0.770], [0.80, 0.865]]),             // bonnet shut line (bonnet carries the kidneys)
        rrect(-1.80, 0.830, -1.66, 0.925, 0.03)                            // fuel flap (right rear quarter)
      ],
      characterLines: [
        curve([[2.06, 0.700], [1.50, 0.752], [0.60, 0.800], [-0.60, 0.832], [-1.60, 0.862], [-2.29, 0.878]]),   // soft shoulder line under the belt
        curve([[0.78, 0.400], [0.00, 0.412], [-0.95, 0.428]]),                                                 // low door swage
        // round M wheel-arch flares stand proud of the body
        curve([[1.75, 0.560], [1.62, 0.680], [1.37, 0.718], [1.10, 0.670], [0.98, 0.560]]),
        curve([[-0.98, 0.580], [-1.10, 0.690], [-1.37, 0.735], [-1.63, 0.690], [-1.76, 0.580]])
      ],
      sill: rrect(-0.98, 0.165, 0.98, 0.235, 0.014),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[0.98, 0.165, 'c'], [-0.98, 0.165, 'c'], [-0.985, 0.190, 'c'], [0.985, 0.190, 'c']]),
        loop([[1.69, 0.178, 'c'], [1.85, 0.180], [2.08, 0.154, 'c'], [2.12, 0.180, 'c'], [1.85, 0.204], [1.695, 0.220, 'c']]),
        loop([[-1.70, 0.180, 'c'], [-1.95, 0.178], [-2.19, 0.198, 'c'], [-2.24, 0.240, 'c'], [-1.95, 0.214], [-1.695, 0.222, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.15, -0.55], [-0.15, 0.55], [-1.10, 0.52], [-1.10, -0.52]], 0.07);
    var top = {
      // narrow early-2000s body with M arch flares bulging out front and rear
      body: sym([[XF, 0, 'v'], [2.154, 0.36], [2.12, 0.64], [2.04, 0.790], [1.90, 0.856], [1.37, 0.884, 'h'], [0.85, 0.862], [0.00, 0.855],
        [-0.85, 0.864], [-1.37, 0.890, 'h'], [-1.90, 0.876], [-2.20, 0.826], [-2.30, 0.62], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.62, 0, 'v'], [0.54, 0.66, 'c'], [0.17, 0.680], [-0.70, 0.660], [-1.30, 0.620], [-1.64, 0.560], [-1.71, 0.40], [-1.72, 0, 'v']], 1),
      hood: sym([[2.09, 0, 'v'], [2.07, 0.50], [1.96, 0.70, 'c'], [0.64, 0.68, 'c'], [0.60, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.73, 0, 'v'], [-1.74, 0.58, 'c'], [-2.26, 0.70, 'c'], [-2.29, 0, 'v']], 1),
      mirrors: pair(loop([[0.50, 0.850, 'c'], [0.47, 0.940], [0.41, 0.980], [0.31, 0.975], [0.27, 0.920], [0.275, 0.850, 'c']]), 1),
      // power-dome flanks
      characterLines: pair(curve([[1.98, 0.20], [1.50, 0.22], [1.00, 0.24], [0.68, 0.25]]), 1)
    };

    // small upright kidneys with chrome surrounds, sitting on the bonnet front edge
    var kidney = rpoly([[0.032, 0.712, 0.035], [0.178, 0.718, 0.05], [0.198, 0.690, 0.04], [0.194, 0.572, 0.04], [0.170, 0.548, 0.03], [0.038, 0.553, 0.03]], 0.04);
    var lampOutline = rpoly([[0.225, 0.708], [0.790, 0.728], [0.838, 0.700], [0.828, 0.612], [0.585, 0.594], [0.248, 0.610]], 0.03);
    var front = {
      body: sym([[0, H, 'h'], [0.40, 1.356], [0.56, 1.28], [0.64, 1.10], [0.70, 0.950], [0.80, 0.880], [0.865, 0.800],
        [0.890, 0.600, 'v'], [0.885, 0.400], [0.862, 0.250], [0.812, 0.170, 'c'], [0.55, 0.150], [0, 0.140, 'h']], 0),
      greenhouse: sym([[0, 1.342, 'h'], [0.40, 1.328], [0.54, 1.262], [0.61, 1.090], [0.66, 0.952, 'c'], [0, 0.930, 'h']], 0),
      // bumper top seam level under the lamps and kidneys
      bumper: sym([[0, 0.535, 'h'], [0.42, 0.545], [0.80, 0.575], [0.870, 0.520], [0.885, 0.400], [0.862, 0.250], [0.812, 0.170, 'c'], [0.55, 0.150], [0, 0.140, 'h']], 0),
      characterLines: [
        curve([[-0.84, 0.760], [-0.62, 0.770, 'h'], [-0.36, 0.742], [0, 0.735, 'h'], [0.36, 0.742], [0.62, 0.770, 'h'], [0.84, 0.760]]),   // bonnet front edge
        curve([[-0.24, 0.738], [-0.20, 0.850], [-0.16, 0.925]]),          // power-dome flanks
        curve([[0.24, 0.738], [0.20, 0.850], [0.16, 0.925]])
      ],
      grille: pair(kidney, 0),
      // big centre intake under the plate, rounded outer brake/fog intakes
      intakes: [rpoly([[-0.42, 0.190], [0.42, 0.190], [0.465, 0.300], [0.420, 0.385], [-0.420, 0.385], [-0.465, 0.300]], 0.03)].concat(
        pair(rpoly([[0.555, 0.200], [0.800, 0.212], [0.835, 0.300], [0.790, 0.395], [0.585, 0.380], [0.535, 0.290]], 0.035), 0)),
      // twin round lamps per side under one clear cover
      headlights: pair(lampOutline, 0),
      // "angel eye" corona rings around both round lamps (inner lens drawn as glass details)
      drl: [].concat(pair(ellipse(0.375, 0.655, 0.074, 0.052, 0), 0), pair(ellipse(0.660, 0.662, 0.072, 0.050, 0), 0)),
      fogLights: pair(ellipse(0.700, 0.300, 0.050, 0.044, 0), 0),
      splitter: rpoly([[-0.80, 0.140], [0.80, 0.140], [0.82, 0.160], [-0.82, 0.160]], 0.008),
      plateArea: rrect(-0.26, 0.405, 0.26, 0.515, 0.01),
      badgeArea: rrect(-0.035, 0.738, 0.035, 0.772, 0.012)
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.40, 1.352], [0.53, 1.262], [0.60, 1.100], [0.74, 1.055], [0.84, 1.005], [0.882, 0.880], [0.890, 0.660, 'v'],
        [0.885, 0.400], [0.850, 0.220], [0.790, 0.185, 'c'], [0, 0.175, 'h']], 0),
      greenhouse: sym([[0, 1.335, 'h'], [0.40, 1.318], [0.51, 1.238], [0.56, 1.110], [0.54, 1.078, 'c'], [0, 1.070, 'h']], 0),
      bumper: sym([[0, 0.700, 'h'], [0.60, 0.702], [0.86, 0.690], [0.885, 0.540], [0.885, 0.400], [0.850, 0.220], [0.790, 0.185, 'c'], [0, 0.175, 'h']], 0),
      panelLines: [curve([[-0.34, 0.870], [0, 0.866, 'h'], [0.34, 0.870]])],
      characterLines: [curve([[-0.88, 0.690], [-0.50, 0.704], [0, 0.708, 'h'], [0.50, 0.704], [0.88, 0.690]])],
      // two-piece L lamps: wide outer unit on the quarter, slim inner unit on the boot lid
      taillights: pair(loop([[0.345, 0.990, 'c'], [0.800, 0.996], [0.862, 0.975], [0.878, 0.862], [0.864, 0.830, 'c'], [0.700, 0.836], [0.610, 0.892], [0.350, 0.904, 'c']]), 0),
      diffuser: sym([[0, 0.300, 'h'], [0.35, 0.300], [0.66, 0.280, 'c'], [0.64, 0.185], [0, 0.175, 'h']], 0),
      // quad round tailpipes in two pairs under the outer bumper corners
      exhaust: [0.465, 0.575, -0.465, -0.575].map(function (z) { return { shape: 'round', cx: z, cy: 0.245, w: 0.090, h: 0.090 }; }),
      plateArea: rrect(-0.26, 0.722, 0.26, 0.832, 0.01),
      badgeArea: rrect(-0.035, 0.880, 0.035, 0.915, 0.012),
      spoiler: sym([[0, 1.062, 'h'], [0.50, 1.060], [0.64, 1.046, 'c'], [0, 1.050, 'h']], 0)
    };

    var details = [
      // M aero mirror on a twin-stalk foot
      D('side', 'mirror', loop([[0.50, 0.945, 'c'], [0.485, 1.020], [0.39, 1.040], [0.27, 1.012], [0.275, 0.958], [0.40, 0.940]]), 'body'),
      D('side', 'trim', rpoly([[-0.816, 0.962], [-0.800, 1.330], [-0.870, 1.322], [-0.876, 0.966]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.62, 0.820, -0.44, 0.844, 0.010), 'chrome'),
      // chrome-framed M side gill behind the front wheel with the side repeater
      D('side', 'vent', rpoly([[0.855, 0.582], [1.005, 0.590], [1.010, 0.668], [0.860, 0.660]], 0.012), 'chrome'),
      D('side', 'grille', rpoly([[0.870, 0.592], [0.993, 0.598], [0.997, 0.656], [0.874, 0.650]], 0.008), 'grille'),
      D('side', 'marker', rrect(0.960, 0.612, 0.985, 0.638, 0.006), 'light-amber'),
      D('side', 'trim', loop([[2.090, 0.718], [2.040, 0.744], [1.960, 0.752], [1.975, 0.715], [2.060, 0.700]]), 'light'),
      D('side', 'grille', loop([[2.110, 0.712, 'c'], [2.126, 0.690], [2.132, 0.580], [2.130, 0.556, 'c'], [2.122, 0.570], [2.120, 0.690]]), 'chrome'),   // kidney surround edge
      D('side', 'trim', loop([[-2.10, 1.020, 'c'], [-2.290, 1.012], [-2.312, 0.960], [-2.320, 0.840, 'c'], [-2.20, 0.850], [-2.10, 0.95, 'c']]), 'light-red'),
      D('side', 'trim', rrect(-2.328, 0.400, -2.300, 0.460, 0.006), 'light-red'),
      D('top', 'trim', sym([[1.98, 0, 'v'], [1.96, 0.18], [0.80, 0.22], [0.66, 0, 'v']], 1), 'body'),    // power dome
      D('top', 'fuelCap', rrect(-1.80, 0.830, -1.66, 0.880, 0.012), 'body'),
      D('top', 'wiper', rrect(0.58, -0.05, 0.62, 0.58, 0.01), 'black'),
      D('top', 'wiper', rrect(0.56, -0.62, 0.60, 0.02, 0.01), 'black'),
      D('top', 'trim', rrect(-2.330, -0.84, -2.300, 0.84, 0.008), 'light-red'),
      D('top', 'antenna', rrect(-1.08, -0.025, -1.00, 0.025, 0.02), 'gloss-black')
    ].concat(
      pairD('top', 'trim', loop([[2.150, 0.32, 'c'], [2.120, 0.62], [2.060, 0.760, 'c'], [2.000, 0.800, 'c'], [2.050, 0.62], [2.080, 0.32, 'c']]), 'light', 1),
      pairD('top', 'grille', rrect(0.86, 0.830, 1.00, 0.858, 0.008), 'chrome', 1),      // side gills seen from above
      pairD('front', 'mirror', loop([[0.66, 0.905, 'c'], [0.80, 0.918], [0.960, 0.928], [0.980, 0.972], [0.920, 1.010], [0.830, 1.005], [0.770, 0.950], [0.66, 0.935, 'c']]), 'body', 0),
      // inner lenses inside the angel-eye rings
      pairD('front', 'glass', ellipse(0.375, 0.655, 0.058, 0.040, 0), 'glass', 0),
      pairD('front', 'glass', ellipse(0.660, 0.662, 0.056, 0.038, 0), 'glass', 0),
      pairD('front', 'light', ellipse(0.375, 0.655, 0.022, 0.020, 0), 'light', 0),
      pairD('front', 'light', ellipse(0.660, 0.662, 0.022, 0.020, 0), 'light', 0),
      pairD('front', 'marker', rpoly([[0.790, 0.700], [0.832, 0.698], [0.826, 0.630], [0.800, 0.640]], 0.006), 'light-amber', 0),   // corner indicators
      // vertical kidney bars
      [0.060, 0.090, 0.120, 0.150].reduce(function (acc, z) {
        return acc.concat(pairD('front', 'trim', rrect(z - 0.006, 0.565, z + 0.006, 0.705, 0.003), 'gloss-black', 0));
      }, []),
      [
        D('front', 'wiper', rpoly([[-0.05, 0.935], [0.55, 0.952], [0.55, 0.962], [-0.05, 0.947]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.30, 0.300, 0.30, 0.312, 0.004), 'gloss-black')
      ],
      pairD('rear', 'trim', rpoly([[0.360, 0.950], [0.600, 0.952], [0.600, 0.940], [0.360, 0.938]], 0.003), 'light', 0),     // reversing strip in the inner lamp
      pairD('rear', 'trim', rpoly([[0.700, 0.975], [0.850, 0.965], [0.860, 0.905], [0.710, 0.912]], 0.006), 'light-amber', 0),   // indicator section of the outer lamp
      pairD('rear', 'trim', rrect(0.820, 0.420, 0.860, 0.460, 0.008), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.892, 0.930, 'c'], [0.960, 0.928], [0.980, 0.972], [0.920, 1.010], [0.892, 1.005, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.60, xBL: -1.72,
      belt: [[0.60, 0.905], [0.48, 0.934], [0.00, 0.945], [-0.82, 0.964], [-1.25, 0.984], [-1.33, 0.995], [-1.40, 1.010], [-1.55, 1.050], [-1.72, 1.070]],
      crest: [[2.16, 0.40, 0.60], [2.05, 0.74, 0.70], [1.70, 0.776, 0.76], [1.37, 0.80, 0.80], [0.60, 0.86, 0.90], [-0.40, 0.88, 0.94],
        [-1.37, 0.92, 0.92], [-1.80, 0.96, 0.82], [-2.15, 0.99, 0.74], [-2.33, 0.93, 0.62]],
      dip: [[2.16, 0.0], [2.08, 0.03], [1.95, 0.045], [1.60, 0.045], [1.00, 0.025], [0.60, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'bmw-m3-e46', make: 'BMW', name: 'M3 Coupé', gen: 'E46', years: '2000–2006', style: 'coupe',
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      wheel: { style: 'double-spoke', spokes: 10, caliper: '#8a8f96' },   // style 67 double-spoke, grey callipers
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Twin round headlamps per side under one clear cover, each ringed by an "angel eye" corona ring, with amber corner indicators.',
        taillights: 'Two-piece L-shaped tail lamps: a wide outer unit on the rear quarter and a slim inner unit on the boot lid.',
        grille: 'Small upright twin-kidney grille with chrome surrounds and vertical bars on the bonnet front edge, over a wide centre intake and round fog lamps in the outer intakes.',
        notes: 'Power-dome bonnet, chrome M side gills behind the front wheels, flared arches, M aero mirrors, Hofmeister kink and quad round tailpipes in two pairs.'
      }
    };
  }

  /* ================================================================== */
  /* Alpine A110 (2017–)                                                 */
  /* ================================================================== */
  function alpineA110() {
    var ref = {
      length: 4.180, width: 1.798, height: 1.252, wheelbase: 2.419, trackF: 1.557, trackR: 1.552,
      frontOverhang: 0.911, rearOverhang: 0.850, wheelDiameter_in: 18,
      tireF: '205/40R18', tireR: '235/40R18', groundClearance: 0.125, rideHeight: 0.125, cd: 0.32, curbWeight_kg: 1103
    };
    var XF = 2.1205, XR = -2.0595, H = 1.252;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.2095, y: rF, r: rF + 0.027, flare: 0.018 };
    var aR = { x: -1.2095, y: rR, r: rR + 0.029, flare: 0.020 };
    var yb = 0.165;

    // mid-engine bubble: low rounded nose, screen far forward, roof flowing in one arc to a short kicked tail
    var roofLine = [[0.62, 0.840, 'c'], [0.30, 1.030], [0.00, 1.196], [-0.35, H, 'h'], [-0.80, 1.226], [-1.25, 1.118], [-1.62, 0.998], [-1.86, 0.938]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.70, 0.167], [1.98, 0.150, 'c'], [2.075, 0.215], [XF, 0.360, 'v'], [2.110, 0.460], [2.070, 0.550], [1.985, 0.622],
      [1.80, 0.676], [1.50, 0.724], [1.10, 0.776], [0.82, 0.812]
    ].concat(roofLine, [
      [-1.990, 0.912, 'c'], [-2.036, 0.862, 'c'], [XR, 0.700, 'v'], [-2.055, 0.500], [-2.035, 0.330], [-1.980, 0.212], [-1.90, 0.180, 'c'], [-1.72, yb, 'c']
    ]), 0.160);

    // frameless door glass with a rising lower edge; the wrap-around rear screen shows as a small side light
    var doorGlass = [[0.50, 0.872, 'c'], [0.25, 1.030], [-0.02, 1.176], [-0.35, 1.222, 'h'], [-0.68, 1.203], [-0.90, 1.140, 'c'], [-0.885, 0.935, 'c'], [-0.60, 0.910], [0.10, 0.880]];
    var wrapGlass = [[-1.035, 1.140, 'c'], [-1.25, 1.084], [-1.49, 1.008, 'c'], [-1.30, 0.988], [-1.050, 0.975, 'c']];
    var side = {
      body: body,
      greenhouse: loop([[0.502, 0.865, 'c'], [0.25, 1.034], [-0.02, 1.182], [-0.35, 1.230, 'h'], [-0.70, 1.210], [-1.00, 1.160], [-1.25, 1.092], [-1.505, 1.004, 'c'],
        [-1.30, 0.980], [-1.00, 0.942], [-0.70, 0.904], [0.10, 0.872]]),
      windows: [loop(doorGlass), loop(wrapGlass)],
      pillars: [
        loop([[0.62, 0.840, 'c'], [0.30, 1.030], [0.00, 1.196, 'c'], [-0.02, 1.184, 'c'], [0.25, 1.035], [0.50, 0.872, 'c']]),
        // body-colour sail between the door glass and the wrapped rear screen
        loop([[-0.905, 1.150, 'c'], [-1.035, 1.140, 'c'], [-1.050, 0.975, 'c'], [-0.89, 0.935, 'c']])
      ],
      doorCuts: [loop([[0.78, 0.260, 'c'], [0.775, 0.55], [0.70, 0.76], [0.58, 0.850]].concat(doorGlass.slice(0, 6), [[-0.92, 0.900], [-0.86, 0.60], [-0.82, 0.265, 'c']]))],
      panelLines: [
        curve([[1.95, 0.600], [1.82, 0.470], [1.600, 0.350]]),            // front bumper seam
        curve([[-1.62, 0.560], [-1.64, 0.43], [-1.66, 0.300]]),           // rear bumper seam behind the arch
        curve([[-1.86, 0.760], [-1.95, 0.758], [-2.052, 0.752]]),         // rear bumper top seam under the lamps
        curve([[1.90, 0.640], [1.40, 0.715], [0.70, 0.810]]),             // front lid shut line
        rrect(1.22, 0.700, 1.34, 0.735, 0.015)                             // fuel filler flap on the front right wing
      ],
      characterLines: [
        // the door cove: sharp upper edge sweeping from the front arch back into the side intake
        curve([[1.00, 0.610], [0.50, 0.615], [-0.20, 0.640], [-0.84, 0.700]]),
        curve([[0.90, 0.360], [0.30, 0.380], [-0.40, 0.430], [-0.84, 0.470]]),
        curve([[-0.95, 0.800], [-1.20, 0.840], [-1.55, 0.840], [-1.86, 0.800]])   // rear haunch crown
      ],
      sill: rrect(-0.82, 0.160, 0.86, 0.215, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.52, 0.168, 'c'], [1.70, 0.168], [1.98, 0.154, 'c'], [2.04, 0.180, 'c'], [1.70, 0.192], [1.525, 0.205, 'c']]),
        loop([[-1.53, 0.170, 'c'], [-1.72, 0.168], [-1.90, 0.184, 'c'], [-1.98, 0.232, 'c'], [-1.72, 0.200], [-1.525, 0.208, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.05, -0.54], [-0.05, 0.54], [-0.82, 0.50], [-0.82, -0.50]], 0.07);
    var top = {
      // teardrop plan: round nose, waist at the doors, wide rear hips over the engine
      body: sym([[XF, 0, 'v'], [2.108, 0.30], [2.05, 0.58], [1.93, 0.780], [1.72, 0.872], [1.21, 0.892, 'h'], [0.60, 0.860], [-0.30, 0.858],
        [-0.80, 0.876], [-1.21, 0.899, 'h'], [-1.70, 0.880], [-1.94, 0.800], [-2.04, 0.60], [-2.056, 0.30], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.66, 0, 'v'], [0.58, 0.620, 'c'], [0.20, 0.672], [-0.40, 0.680], [-1.00, 0.640], [-1.50, 0.520], [-1.82, 0.360], [-1.88, 0, 'v']], 1),
      hood: sym([[2.05, 0, 'v'], [2.00, 0.40], [1.88, 0.56, 'c'], [0.70, 0.60, 'c'], [0.66, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.88, 0, 'v'], [-1.880, 0.40, 'c'], [-2.000, 0.60, 'c'], [-2.030, 0, 'v']], 1),
      mirrors: pair(loop([[0.50, 0.850, 'c'], [0.47, 0.946], [0.41, 0.984], [0.32, 0.978], [0.28, 0.920], [0.285, 0.850, 'c']]), 1),
      // central spine on the front lid
      characterLines: [curve([[2.06, 0], [1.40, 0], [0.70, 0]]), curve([[1.95, 0.30], [1.40, 0.38], [0.75, 0.45]]), curve([[1.95, -0.30], [1.40, -0.38], [0.75, -0.45]])]
    };

    var front = {
      body: sym([[0, H, 'h'], [0.38, 1.238], [0.52, 1.160], [0.60, 1.000], [0.66, 0.862], [0.74, 0.780], [0.84, 0.716], [0.885, 0.620],
        [0.899, 0.500, 'v'], [0.890, 0.360], [0.850, 0.220], [0.780, 0.155, 'c'], [0.550, 0.140], [0, 0.135, 'h']], 0),
      greenhouse: sym([[0, 1.222, 'h'], [0.37, 1.208], [0.50, 1.140], [0.57, 0.995], [0.62, 0.870, 'c'], [0, 0.852, 'h']], 0),
      bumper: sym([[0, 0.470, 'h'], [0.30, 0.476], [0.50, 0.520], [0.885, 0.520], [0.890, 0.360], [0.850, 0.220], [0.780, 0.155, 'c'], [0.550, 0.140], [0, 0.135, 'h']], 0),
      // front lid low between rounded wings, with the raised central spine
      characterLines: [
        curve([[-0.84, 0.716], [-0.74, 0.770], [-0.62, 0.760, 'h'], [-0.40, 0.700], [0, 0.690, 'h'], [0.40, 0.700], [0.62, 0.760, 'h'], [0.74, 0.770], [0.84, 0.716]]),
        curve([[-0.06, 0.700], [0, 0.735], [0.06, 0.700]]),
        curve([[0, 0.735], [0, 0.800], [0, 0.852]])
      ],
      // slim upper slot between the round lamps, wide lower intake under the plate
      grille: [rpoly([[-0.22, 0.470], [0.22, 0.470], [0.20, 0.502], [-0.20, 0.502]], 0.012)],
      intakes: [rpoly([[-0.56, 0.165], [0.56, 0.165], [0.60, 0.240], [0.52, 0.310], [-0.52, 0.310], [-0.60, 0.240]], 0.035)].concat(
        pair(rpoly([[0.660, 0.200], [0.800, 0.210], [0.835, 0.300], [0.810, 0.380], [0.680, 0.360]], 0.025), 0)),
      // rounded main lamps at the wing corners plus the two round inboard lamps of the 1960s A110
      headlights: pair(loop([[0.470, 0.598, 'c'], [0.600, 0.646], [0.770, 0.660], [0.858, 0.628], [0.872, 0.565], [0.810, 0.530], [0.630, 0.534], [0.500, 0.556]]), 0).concat(
        pair(ellipse(0.360, 0.548, 0.060, 0.058, 0), 0)),
      drl: [].concat(
        pair(rpoly([[0.520, 0.600], [0.640, 0.638], [0.780, 0.648], [0.840, 0.624], [0.835, 0.612], [0.775, 0.634], [0.640, 0.624], [0.525, 0.588]], 0.004), 0),
        // X-shaped light signature inside each round lamp (two crossing bars, no logo)
        pair(rpoly([[0.326, 0.520], [0.336, 0.514], [0.394, 0.574], [0.384, 0.580]], 0.003), 0),
        pair(rpoly([[0.326, 0.576], [0.384, 0.516], [0.394, 0.522], [0.336, 0.582]], 0.003), 0)
      ),
      splitter: rpoly([[-0.76, 0.135], [0.76, 0.135], [0.78, 0.155], [-0.78, 0.155]], 0.008),
      plateArea: rrect(-0.26, 0.330, 0.26, 0.440, 0.01),
      badgeArea: rrect(-0.15, 0.515, 0.15, 0.545, 0.008)
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.36, 1.236], [0.48, 1.150], [0.56, 1.020], [0.66, 0.945], [0.80, 0.905], [0.880, 0.820], [0.899, 0.680, 'v'],
        [0.895, 0.500], [0.870, 0.300], [0.820, 0.190, 'c'], [0, 0.175, 'h']], 0),
      // large wrap-around rear screen
      greenhouse: sym([[0, 1.225, 'h'], [0.34, 1.212], [0.46, 1.140], [0.53, 1.030], [0.55, 0.968, 'c'], [0, 0.940, 'h']], 0),
      bumper: sym([[0, 0.640, 'h'], [0.40, 0.642], [0.86, 0.660], [0.895, 0.500], [0.870, 0.300], [0.820, 0.190, 'c'], [0, 0.175, 'h']], 0),
      characterLines: [curve([[-0.85, 0.900], [-0.50, 0.912], [0, 0.915, 'h'], [0.50, 0.912], [0.85, 0.900]])],   // tail lip edge
      // horizontal lamps with the X signature, joined by a black panel carrying the name
      taillights: pair(rpoly([[0.380, 0.842], [0.820, 0.852], [0.875, 0.800], [0.866, 0.730], [0.430, 0.728], [0.360, 0.780]], 0.02), 0),
      diffuser: sym([[0, 0.330, 'h'], [0.40, 0.330], [0.70, 0.300, 'c'], [0.68, 0.190], [0, 0.175, 'h']], 0),
      // single central tailpipe in the diffuser
      exhaust: [{ shape: 'round', cx: 0, cy: 0.255, w: 0.115, h: 0.105 }],
      plateArea: rrect(-0.26, 0.500, 0.26, 0.610, 0.01),
      badgeArea: rrect(-0.30, 0.770, 0.30, 0.805, 0.008),
      spoiler: sym([[0, 0.930, 'h'], [0.50, 0.928], [0.66, 0.918, 'c'], [0.62, 0.902, 'c'], [0, 0.908, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.50, 0.880, 'c'], [0.485, 0.948], [0.39, 0.966], [0.29, 0.940], [0.292, 0.890], [0.40, 0.876]]), 'body'),
      D('side', 'trim', rpoly([[-0.880, 0.935], [-0.895, 1.148], [-0.920, 1.142], [-0.905, 0.937]], 0.003), 'gloss-black'),   // door-glass rear seal
      D('side', 'trim', rpoly([[-0.30, 1.236], [-0.90, 1.150], [-0.905, 1.165], [-0.30, 1.246]], 0.003), 'gloss-black'),     // roof-rail seal above the glass
      D('side', 'handle', rrect(-0.62, 0.770, -0.46, 0.790, 0.010), 'black'),
      // side air intake at the end of the door cove, feeding the mid-mounted engine
      D('side', 'intake', loop([[-0.84, 0.700, 'c'], [-0.93, 0.718], [-0.97, 0.640], [-0.95, 0.500, 'c'], [-0.86, 0.472, 'c'], [-0.88, 0.600]]), 'grille'),
      D('side', 'trim', loop([[2.040, 0.590], [1.960, 0.630], [1.860, 0.648], [1.890, 0.610], [1.990, 0.580]]), 'light'),
      D('side', 'trim', loop([[-1.88, 0.850, 'c'], [-2.040, 0.840], [-2.052, 0.790], [-2.050, 0.730, 'c'], [-1.95, 0.738], [-1.88, 0.80, 'c']]), 'light-red'),
      D('side', 'marker', rrect(1.66, 0.400, 1.70, 0.420, 0.006), 'light-amber'),
      D('top', 'fuelCap', rrect(1.22, 0.86, 1.34, 0.89, 0.012), 'body'),
      D('top', 'wiper', rrect(0.64, -0.05, 0.68, 0.56, 0.01), 'black'),
      D('top', 'trim', rrect(-2.058, -0.80, -2.035, 0.80, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.000, -0.66, -1.975, 0.66, 0.008), 'body'),
      D('top', 'vent', sym([[-1.92, 0, 'v'], [-1.93, 0.22, 'c'], [-1.98, 0.22, 'c'], [-1.97, 0, 'v']], 1), 'gloss-black')   // engine-bay outlet under the tail lip
    ].concat(
      pairD('top', 'trim', loop([[2.06, 0.46, 'c'], [2.00, 0.70], [1.90, 0.800, 'c'], [1.86, 0.760, 'c'], [1.95, 0.60], [1.99, 0.44, 'c']]), 'light', 1),
      pairD('top', 'trim', ellipse(2.08, 0.36, 0.025, 0.05, 0), 'light', 1),
      pairD('front', 'mirror', loop([[0.62, 0.860, 'c'], [0.76, 0.872], [0.930, 0.882], [0.946, 0.928], [0.880, 0.962], [0.790, 0.957], [0.730, 0.900], [0.62, 0.888, 'c']]), 'body', 0),
      pairD('front', 'vent', rrect(0.690, 0.230, 0.800, 0.240, 0.004), 'gloss-black', 0),
      [
        D('front', 'wiper', rpoly([[-0.05, 0.860], [0.52, 0.878], [0.52, 0.888], [-0.05, 0.872]], 0.004), 'black'),
        D('rear', 'trim', rpoly([[-0.36, 0.780], [0.36, 0.780], [0.38, 0.800], [-0.38, 0.800]], 0.004), 'gloss-black'),   // black panel between the lamps
        D('rear', 'trim', rrect(-0.04, 0.950, 0.04, 0.962, 0.004), 'light-red')                                          // third brake light
      ],
      // X-shaped light guides in each tail lamp
      pairD('rear', 'trim', rpoly([[0.520, 0.740], [0.540, 0.740], [0.720, 0.835], [0.700, 0.838]], 0.003), 'light-red', 0),
      pairD('rear', 'trim', rpoly([[0.520, 0.836], [0.700, 0.738], [0.720, 0.742], [0.540, 0.840]], 0.003), 'light-red', 0),
      pairD('rear', 'trim', rrect(0.790, 0.750, 0.840, 0.820, 0.010), 'light', 0),       // reversing lamp at the outer end
      [-0.30, -0.15, 0, 0.15, 0.30].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.19, z + 0.008, 0.32, 0.004), 'gloss-black'); }),
      pairD('rear', 'trim', rrect(0.780, 0.400, 0.840, 0.420, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.900, 0.882, 'c'], [0.930, 0.882], [0.946, 0.928], [0.880, 0.962], [0.900, 0.957, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.160, xWS: 0.62, xBL: -1.86,
      belt: [[0.62, 0.840], [0.50, 0.866], [0.10, 0.874], [-0.60, 0.906], [-0.90, 0.936], [-1.05, 0.972], [-1.30, 0.985], [-1.50, 0.998], [-1.70, 0.950], [-1.86, 0.900]],
      crest: [[2.12, 0.36, 0.60], [2.00, 0.60, 0.68], [1.70, 0.70, 0.74], [1.21, 0.770, 0.80], [0.62, 0.830, 0.86], [-0.40, 0.870, 0.92],
        [-1.21, 0.920, 0.94], [-1.70, 0.920, 0.82], [-1.95, 0.890, 0.70], [-2.06, 0.800, 0.60]],
      dip: [[2.12, 0.0], [2.04, 0.04], [1.90, 0.07], [1.50, 0.07], [1.00, 0.04], [0.62, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'alpine-a110', make: 'Alpine', name: 'A110', gen: 'AS1', years: '2017–', style: 'coupe',
      enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      wheel: { style: 'multi-spoke', spokes: 10, caliper: '#2b5fae' },   // 18-inch Grand Prix wheels, blue callipers
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Rounded LED main lamps at the wing corners plus two round inboard lamps with an X light signature, recalling the auxiliary lamps of the 1960s A110.',
        taillights: 'Horizontal LED tail lamps with an X-shaped light signature, linked by a black panel carrying the name in plain text.',
        grille: 'No upper grille: a slim slot between the round lamps and a wide lower intake under the plate, flanked by small brake-cooling intakes.',
        notes: 'Mid-engine bubble: low front lid with a central spine, windscreen far forward, sculpted door cove sweeping into a side air intake, wrap-around rear screen, short kicked tail and a single central tailpipe.'
      }
    };
  }

  /* ================================================================== */
  /* Aston Martin Vantage (2018–2024)                                    */
  /* ================================================================== */
  function astonVantage() {
    var ref = {
      length: 4.465, width: 1.942, height: 1.273, wheelbase: 2.704, trackF: 1.605, trackR: 1.625,
      frontOverhang: 0.930, rearOverhang: 0.831, wheelDiameter_in: 20,
      tireF: '255/40ZR20', tireR: '295/35ZR20', groundClearance: 0.110, rideHeight: 0.110, cd: 0.34, curbWeight_kg: 1630
    };
    var XF = 2.282, XR = -2.183, H = 1.273;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.352, y: rF, r: rF + 0.027, flare: 0.024 };
    var aR = { x: -1.352, y: rR, r: rR + 0.029, flare: 0.032 };
    var yb = 0.170;

    // front-mid V8: very long bonnet, cabin pushed back, fastback roof into an integrated ducktail
    var roofLine = [[0.32, 0.885, 'c'], [0.00, 1.060], [-0.30, 1.212], [-0.62, H, 'h'], [-1.00, 1.240], [-1.35, 1.150], [-1.65, 1.052], [-1.90, 0.990]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.90, 0.172], [2.15, 0.134, 'c'], [2.245, 0.190], [XF, 0.300, 'v'], [2.272, 0.420], [2.225, 0.520], [2.110, 0.622],
      [1.90, 0.700], [1.60, 0.760], [1.20, 0.810], [0.80, 0.852], [0.48, 0.874]
    ].concat(roofLine, [
      [-2.070, 0.962, 'h'], [-2.150, 0.975, 'c'], [-2.176, 0.900, 'c'], [XR, 0.700, 'v'], [-2.178, 0.500], [-2.150, 0.340], [-2.080, 0.220], [-1.98, 0.185, 'c'], [-1.85, yb, 'c']
    ]), 0.160);

    var doorGlass = [[0.22, 0.915, 'c'], [-0.02, 1.054], [-0.30, 1.190], [-0.62, 1.248, 'h'], [-0.93, 1.228, 'c'], [-0.95, 0.952, 'c']];
    var quarterGlass = [[-0.99, 0.955, 'c'], [-0.985, 1.218, 'c'], [-1.18, 1.150], [-1.36, 1.072, 'c'], [-1.20, 1.022], [-1.05, 0.978]];
    var side = {
      body: body,
      // one teardrop daylight opening with a thin chrome surround
      greenhouse: loop([[0.222, 0.908, 'c'], [-0.02, 1.060], [-0.30, 1.196], [-0.62, 1.254, 'h'], [-0.98, 1.226], [-1.18, 1.158], [-1.38, 1.068, 'c'],
        [-1.20, 1.012], [-0.95, 0.945], [-0.40, 0.928]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [
        loop([[0.32, 0.885, 'c'], [0.00, 1.060], [-0.30, 1.212, 'c'], [-0.30, 1.190, 'c'], [-0.02, 1.054], [0.22, 0.915, 'c']])
      ],
      // long swan-wing door
      doorCuts: [loop([[0.86, 0.262, 'c'], [0.855, 0.55], [0.80, 0.78], [0.62, 0.870], [0.40, 0.890]].concat(doorGlass, [[-1.02, 0.80], [-0.98, 0.268, 'c']]))],
      panelLines: [
        curve([[2.08, 0.630], [1.98, 0.500], [1.780, 0.380]]),            // front clip seam
        curve([[-1.80, 0.600], [-1.82, 0.45], [-1.84, 0.300]]),           // rear bumper seam
        curve([[-1.98, 0.830], [-2.08, 0.828], [-2.178, 0.826]]),         // rear bumper top seam
        curve([[2.12, 0.612], [1.60, 0.740], [1.00, 0.818], [0.50, 0.860]]),   // clamshell bonnet shut line along the wing
        curve([[-1.88, 0.980], [-2.00, 0.948], [-2.14, 0.950]]),          // hatch shut line under the ducktail
        rrect(-1.72, 0.840, -1.60, 0.920, 0.03)                            // fuel flap
      ],
      characterLines: [
        curve([[2.10, 0.600], [1.70, 0.700], [1.30, 0.738], [1.00, 0.700]]),                         // front-wing crown
        // rising sill blade: lower body line kicks up toward the rear wheel
        curve([[0.95, 0.320], [0.20, 0.330], [-0.60, 0.380], [-0.98, 0.440]]),
        // muscular rear haunch rising behind the door into the ducktail
        curve([[-0.70, 0.880], [-1.10, 0.925], [-1.50, 0.955], [-1.85, 0.962], [-2.10, 0.948]])
      ],
      sill: rrect(-0.96, 0.160, 0.98, 0.222, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[0.98, 0.160, 'c'], [-0.96, 0.160, 'c'], [-0.965, 0.182, 'c'], [0.985, 0.182, 'c']]),            // carbon sill blade
        loop([[1.69, 0.174, 'c'], [1.90, 0.175], [2.15, 0.138, 'c'], [2.20, 0.160, 'c'], [1.90, 0.198], [1.695, 0.214, 'c']]),
        loop([[-1.70, 0.174, 'c'], [-1.85, 0.173], [-2.08, 0.224, 'c'], [-2.14, 0.320, 'c'], [-1.85, 0.240], [-1.695, 0.216, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.30, -0.55], [-0.30, 0.55], [-1.05, 0.50], [-1.05, -0.50]], 0.07);
    var top = {
      // wide and low, pinched waist, big rear hips
      body: sym([[XF, 0, 'v'], [2.270, 0.30], [2.200, 0.60], [2.060, 0.800], [1.850, 0.905], [1.352, 0.945, 'h'], [0.80, 0.915], [0.00, 0.900],
        [-0.70, 0.935], [-1.352, 0.971, 'h'], [-1.80, 0.950], [-2.050, 0.880], [-2.160, 0.70], [-2.180, 0.40], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.36, 0, 'v'], [0.28, 0.620, 'c'], [-0.10, 0.660], [-0.70, 0.640], [-1.30, 0.540], [-1.70, 0.400], [-1.86, 0.250], [-1.88, 0, 'v']], 1),
      // one-piece clamshell bonnet reaching out over the wings
      hood: sym([[2.22, 0, 'v'], [2.18, 0.45], [2.02, 0.72, 'c'], [0.40, 0.68, 'c'], [0.36, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.88, 0, 'v'], [-1.890, 0.50, 'c'], [-2.140, 0.70, 'c'], [-2.170, 0, 'v']], 1),
      mirrors: pair(loop([[0.20, 0.880, 'c'], [0.17, 0.990], [0.11, 1.030], [0.02, 1.024], [-0.02, 0.960], [-0.015, 0.880, 'c']]), 1),
      characterLines: pair(curve([[2.10, 0.30], [1.60, 0.33], [1.00, 0.36], [0.42, 0.38]]), 1)
    };

    // Vulcan-inspired grille: one huge, low trapezoid mouth that fills the nose
    var grille = rpoly([[-0.52, 0.508], [0.52, 0.508], [0.665, 0.425], [0.640, 0.195], [0.560, 0.160], [-0.560, 0.160], [-0.640, 0.195], [-0.665, 0.425]], 0.05);
    var front = {
      body: sym([[0, H, 'h'], [0.40, 1.258], [0.54, 1.170], [0.62, 1.000], [0.68, 0.880], [0.78, 0.820], [0.88, 0.760], [0.945, 0.640],
        [0.971, 0.500, 'v'], [0.965, 0.360], [0.930, 0.240], [0.860, 0.160, 'c'], [0.600, 0.140], [0, 0.135, 'h']], 0),
      greenhouse: sym([[0, 1.238, 'h'], [0.40, 1.222], [0.52, 1.150], [0.59, 0.995], [0.64, 0.892, 'c'], [0, 0.868, 'h']], 0),
      bumper: sym([[0, 0.560, 'h'], [0.50, 0.560], [0.72, 0.540], [0.93, 0.560], [0.965, 0.360], [0.930, 0.240], [0.860, 0.160, 'c'], [0.600, 0.140], [0, 0.135, 'h']], 0),
      characterLines: [
        // tall wing crowns with the clamshell dipping between them
        curve([[-0.90, 0.750], [-0.78, 0.820], [-0.66, 0.825, 'h'], [-0.45, 0.740], [0, 0.715, 'h'], [0.45, 0.740], [0.66, 0.825, 'h'], [0.78, 0.820], [0.90, 0.750]]),
        curve([[-0.45, 0.740], [-0.38, 0.810], [-0.30, 0.875]]),
        curve([[0.45, 0.740], [0.38, 0.810], [0.30, 0.875]])
      ],
      grille: [grille],
      // narrow vertical air curtains outboard of the mouth
      intakes: pair(rpoly([[0.770, 0.230], [0.900, 0.250], [0.920, 0.420], [0.800, 0.400]], 0.02), 0),
      // slim swept-back lamps high on the wing corners
      headlights: pair(loop([[0.500, 0.665, 'c'], [0.660, 0.705], [0.840, 0.716], [0.925, 0.665, 'c'], [0.905, 0.602], [0.740, 0.600], [0.560, 0.628]]), 0),
      // DRL blade along the lamp's lower edge, turning up at the outer end
      drl: pair(rpoly([[0.560, 0.630], [0.740, 0.606], [0.900, 0.608], [0.918, 0.660], [0.906, 0.662], [0.890, 0.620], [0.742, 0.618], [0.566, 0.642]], 0.004), 0),
      splitter: rpoly([[-0.86, 0.135], [0.86, 0.135], [0.88, 0.158], [-0.88, 0.158]], 0.008),
      plateArea: rrect(-0.26, 0.255, 0.26, 0.365, 0.01),
      badgeArea: rrect(-0.09, 0.560, 0.09, 0.600, 0.01)
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.40, 1.255], [0.50, 1.160], [0.58, 1.060], [0.72, 1.000], [0.86, 0.955], [0.94, 0.870], [0.971, 0.720, 'v'],
        [0.965, 0.520], [0.930, 0.320], [0.860, 0.200, 'c'], [0, 0.180, 'h']], 0),
      greenhouse: sym([[0, 1.236, 'h'], [0.38, 1.220], [0.47, 1.140], [0.53, 1.050], [0.52, 1.012, 'c'], [0, 1.000, 'h']], 0),
      bumper: sym([[0, 0.700, 'h'], [0.50, 0.700], [0.90, 0.690], [0.960, 0.560], [0.965, 0.520], [0.930, 0.320], [0.860, 0.200, 'c'], [0, 0.180, 'h']], 0),
      characterLines: [curve([[-0.94, 0.866], [-0.50, 0.900], [0, 0.905, 'h'], [0.50, 0.900], [0.94, 0.866]])],
      // slim lamps sweeping round the corners, linked across the hatch by a thin light strip
      taillights: pair(loop([[0.400, 0.945, 'c'], [0.800, 0.940], [0.930, 0.900], [0.955, 0.850], [0.940, 0.832, 'c'], [0.800, 0.876], [0.420, 0.916, 'c']]), 0),
      lightBar: sym([[0, 0.934, 'h'], [0.42, 0.934, 'c'], [0.42, 0.924, 'c'], [0, 0.924, 'h']], 0),
      // full-width carbon diffuser with tall fins; twin big round tailpipes at its outer ends
      diffuser: sym([[0, 0.400, 'h'], [0.40, 0.400], [0.76, 0.360, 'c'], [0.74, 0.190], [0, 0.180, 'h']], 0),
      exhaust: [{ shape: 'round', cx: 0.58, cy: 0.280, w: 0.125, h: 0.125 }, { shape: 'round', cx: -0.58, cy: 0.280, w: 0.125, h: 0.125 }],
      plateArea: rrect(-0.26, 0.520, 0.26, 0.630, 0.01),
      badgeArea: rrect(-0.24, 0.800, 0.24, 0.835, 0.008),
      // integrated ducktail
      spoiler: sym([[0, 0.985, 'h'], [0.60, 0.982], [0.80, 0.955, 'c'], [0.70, 0.946, 'c'], [0, 0.956, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.20, 0.930, 'c'], [0.185, 1.000], [0.09, 1.018], [-0.01, 0.990], [-0.008, 0.940], [0.10, 0.926]]), 'body'),
      D('side', 'trim', rpoly([[0.12, 0.890], [0.16, 0.890], [0.16, 0.928], [0.12, 0.928]], 0.004), 'gloss-black'),            // slim mirror stalk
      D('side', 'trim', rpoly([[-0.945, 0.950], [-0.928, 1.236], [-0.990, 1.230], [-0.995, 0.954]], 0.004), 'gloss-black'),    // B-pillar
      D('side', 'handle', rrect(-0.72, 0.880, -0.56, 0.896, 0.008), 'chrome'),
      // side strake behind the front wheel: tall vertical gill with a forward-swept blade
      D('side', 'vent', loop([[0.905, 0.330, 'c'], [0.985, 0.360], [1.000, 0.520], [0.965, 0.620, 'c'], [0.915, 0.600], [0.885, 0.460]]), 'gloss-black'),
      D('side', 'trim', rpoly([[0.885, 0.470], [0.995, 0.500], [0.995, 0.512], [0.885, 0.484]], 0.003), 'body'),
      D('side', 'trim', loop([[2.110, 0.622], [2.030, 0.660], [1.930, 0.684], [1.960, 0.645], [2.080, 0.600]]), 'light'),
      D('side', 'grille', loop([[2.240, 0.200, 'c'], [2.270, 0.290], [2.268, 0.430], [2.250, 0.470, 'c'], [2.250, 0.300]]), 'grille'),   // mouth edge
      D('side', 'trim', loop([[-2.00, 0.952, 'c'], [-2.160, 0.950], [-2.176, 0.900], [-2.170, 0.850, 'c'], [-2.06, 0.900]]), 'light-red'),
      D('side', 'marker', rrect(1.12, 0.560, 1.18, 0.574, 0.006), 'light-amber'),
      D('top', 'fuelCap', rrect(-1.72, 0.930, -1.60, 0.960, 0.012), 'body'),
      D('top', 'wiper', rrect(0.34, -0.05, 0.38, 0.60, 0.01), 'black'),
      D('top', 'trim', rrect(-2.183, -0.86, -2.160, 0.86, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.150, -0.80, -2.090, 0.80, 0.012), 'body')
    ].concat(
      // two louvred bonnet vents
      pairD('top', 'vent', rpoly([[1.58, 0.28], [1.92, 0.30], [1.90, 0.48], [1.60, 0.46]], 0.03), 'gloss-black', 1),
      [0, 1, 2, 3].reduce(function (acc, k) { var x = 1.62 + k * 0.08; return acc.concat(pairD('top', 'trim', rrect(x, 0.30, x + 0.016, 0.46, 0.004), 'body', 1)); }, []),
      pairD('top', 'trim', loop([[2.200, 0.50, 'c'], [2.150, 0.72], [2.060, 0.820, 'c'], [2.020, 0.790, 'c'], [2.100, 0.66], [2.140, 0.48, 'c']]), 'light', 1),
      pairD('top', 'vent', rrect(0.89, 0.900, 1.00, 0.930, 0.010), 'gloss-black', 1),      // side strakes seen from above
      pairD('front', 'mirror', loop([[0.64, 0.880, 'c'], [0.78, 0.892], [0.990, 0.900], [1.012, 0.946], [0.950, 0.982], [0.850, 0.978], [0.790, 0.920], [0.64, 0.908, 'c']]), 'body', 0),
      // horizontal grille vanes across the mouth (clear of the plate)
      [0.405, 0.455].map(function (y) { return D('front', 'trim', rrect(-0.60, y, 0.60, y + 0.012, 0.005), 'gloss-black'); }),
      [0.205, 0.230].map(function (y) { return D('front', 'trim', rrect(-0.56, y, 0.56, y + 0.010, 0.005), 'gloss-black'); }),
      [
        D('front', 'wiper', rpoly([[-0.05, 0.870], [0.56, 0.888], [0.56, 0.898], [-0.05, 0.882]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.06, 1.004, 0.06, 1.014, 0.004), 'light-red')        // third brake light
      ],
      [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.19, z + 0.008, 0.39, 0.004), 'carbon'); }),   // diffuser fins
      pairD('rear', 'trim', rpoly([[0.45, 0.936], [0.80, 0.931], [0.925, 0.893], [0.918, 0.886], [0.80, 0.921], [0.45, 0.926]], 0.003), 'light', 0),
      pairD('rear', 'trim', rrect(0.880, 0.420, 0.930, 0.440, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.975, 0.892, 'c'], [0.990, 0.900], [1.012, 0.946], [0.950, 0.982], [0.975, 0.978, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.160, xWS: 0.32, xBL: -1.88,
      belt: [[0.32, 0.885], [0.22, 0.912], [-0.40, 0.930], [-0.95, 0.950], [-1.20, 1.016], [-1.36, 1.062], [-1.60, 1.040], [-1.88, 0.980]],
      crest: [[2.28, 0.30, 0.60], [2.10, 0.62, 0.66], [1.80, 0.73, 0.74], [1.35, 0.80, 0.80], [0.80, 0.85, 0.86], [0.00, 0.88, 0.92],
        [-0.80, 0.92, 0.94], [-1.35, 0.97, 0.94], [-1.80, 0.98, 0.82], [-2.10, 0.96, 0.70], [-2.18, 0.85, 0.62]],
      dip: [[2.28, 0.0], [2.18, 0.04], [2.00, 0.07], [1.50, 0.07], [0.90, 0.04], [0.32, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'aston-martin-vantage-2018', make: 'Aston Martin', name: 'Vantage', gen: 'AM6', years: '2018–2024', style: 'coupe',
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      wheel: { style: 'twin-5', spokes: 10, caliper: '#1a1b1e' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim swept-back LED headlamps set high on the wing corners, with a DRL blade along the lower edge turning up at the outer end.',
        taillights: 'Very slim LED tail lamps sweeping round the corners under an integrated ducktail, linked across the hatch by a thin light strip.',
        grille: 'Vulcan-inspired grille: one huge, low trapezoid mouth with horizontal vanes filling the whole nose, flanked by narrow air curtains.',
        notes: 'Very long clamshell bonnet with twin louvred vents, cabin pushed far back, swan-wing doors, side strakes behind the front wheels, muscular rear haunches, full-width finned diffuser with twin big round tailpipes.'
      }
    };
  }

  /* Band between an outer and an inner closed outline (the inner one is traversed backwards so it cuts a hole). */
  function ring2(outer, inner) {
    var segs = [], cur = null, start = null, rev = [];
    inner.forEach(function (s) {
      if (s.t === 'M') { cur = s.p[0]; start = cur; }
      else if (s.t === 'Z') { if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) rev.push({ t: 'L', from: cur, p: [start] }); cur = start; }
      else { rev.push({ t: s.t, from: cur, p: s.p }); cur = s.p[s.p.length - 1]; }
    });
    segs.push({ t: 'M', p: [rev[rev.length - 1].p[rev[rev.length - 1].p.length - 1]] });
    for (var i = rev.length - 1; i >= 0; i--) {
      var g = rev[i];
      if (g.t === 'C') segs.push({ t: 'C', p: [g.p[1], g.p[0], g.from] });
      else if (g.t === 'Q') segs.push({ t: 'Q', p: [g.p[0], g.from] });
      else segs.push({ t: 'L', p: [g.from] });
    }
    segs.push({ t: 'Z', p: [] });
    return outer.concat(segs);
  }

  /* ================================================================== */
  /* Lotus Emira (2022–)                                                 */
  /* ================================================================== */
  function lotusEmira() {
    var ref = {
      length: 4.413, width: 1.895, height: 1.226, wheelbase: 2.575, trackF: 1.624, trackR: 1.610,
      frontOverhang: 0.988, rearOverhang: 0.850, wheelDiameter_in: 20,
      tireF: '245/35ZR20', tireR: '295/30ZR20', groundClearance: 0.125, rideHeight: 0.125, cd: 0.37, curbWeight_kg: 1458
    };
    var XF = 2.2755, XR = -2.1375, H = 1.226;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.2875, y: rF, r: rF + 0.028, flare: 0.022 };
    var aR = { x: -1.2875, y: rR, r: rR + 0.030, flare: 0.026 };
    var yb = 0.170;

    // mid-engine wedge: blunt, rounded nose with the lamps high on the wing corners, long front lid, screen well forward, roof arcing into flying buttresses
    // and a long engine deck that ends in a sharp ducktail over a near-vertical tail
    var roofLine = [[0.55, 0.858, 'c'], [0.25, 1.020], [-0.05, 1.168], [-0.35, H, 'h'], [-0.75, 1.204], [-1.15, 1.128], [-1.55, 1.046], [-1.85, 1.002]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.72, 0.176], [2.10, 0.150, 'c'], [2.238, 0.230], [XF, 0.430, 'v'], [2.271, 0.565], [2.254, 0.640], [2.210, 0.690],
      [2.10, 0.716], [1.85, 0.742], [1.55, 0.772], [1.20, 0.802], [0.92, 0.826], [0.80, 0.838]
    ].concat(roofLine, [
      [-2.02, 0.986], [-2.085, 0.992, 'c'], [-2.118, 0.940, 'c'], [XR, 0.700, 'v'], [-2.130, 0.500], [-2.100, 0.320], [-2.030, 0.220], [-1.90, 0.190, 'c'], [-1.70, yb, 'c']
    ]), 0.165);

    // frameless door glass with a pointed trailing edge, small fixed quarter light ahead of the buttress
    var doorGlass = [[0.40, 0.900, 'c'], [0.18, 1.040], [-0.08, 1.170], [-0.35, 1.212, 'h'], [-0.62, 1.196], [-0.80, 1.150, 'c'], [-0.78, 0.945, 'c'], [-0.45, 0.925], [0.05, 0.910]];
    var quarter = [[-0.86, 1.140, 'c'], [-1.05, 1.098], [-1.32, 1.030, 'c'], [-1.10, 0.992], [-0.85, 0.962, 'c']];
    var side = {
      body: body,
      greenhouse: loop([[0.402, 0.893, 'c'], [0.18, 1.045], [-0.08, 1.178], [-0.35, 1.220, 'h'], [-0.65, 1.202], [-1.00, 1.120], [-1.34, 1.028, 'c'],
        [-1.10, 0.982], [-0.80, 0.948], [-0.40, 0.918], [0.05, 0.903]]),
      windows: [loop(doorGlass), loop(quarter)],
      pillars: [
        loop([[0.55, 0.858, 'c'], [0.25, 1.020], [-0.05, 1.168, 'c'], [-0.08, 1.163, 'c'], [0.18, 1.040], [0.40, 0.900, 'c']]),
        loop([[-0.80, 1.150, 'c'], [-0.86, 1.140, 'c'], [-0.85, 0.962, 'c'], [-0.78, 0.945, 'c']])
      ],
      doorCuts: [loop([[0.86, 0.262, 'c'], [0.855, 0.55], [0.78, 0.76], [0.60, 0.872]].concat(doorGlass.slice(0, 6), [[-0.84, 0.900], [-0.72, 0.600], [-0.62, 0.268, 'c']]))],
      panelLines: [
        curve([[2.240, 0.600], [2.08, 0.480], [1.86, 0.370]]),            // front clam / bumper seam
        curve([[2.18, 0.690], [1.50, 0.758], [0.88, 0.818]]),             // front lid shut line
        curve([[-1.64, 0.600], [-1.66, 0.45], [-1.68, 0.300]]),           // rear bumper seam behind the arch
        curve([[-1.88, 0.780], [-2.00, 0.776], [-2.128, 0.770]]),         // rear bumper top seam under the lamps
        curve([[-1.34, 1.040], [-1.70, 1.008], [-2.05, 0.980]])           // tailgate / engine cover shut line
      ],
      characterLines: [
        // the sharp door blade rising rearward into the big side intake
        curve([[0.95, 0.520], [0.40, 0.540], [-0.20, 0.580], [-0.62, 0.660]]),
        curve([[0.90, 0.330], [0.30, 0.350], [-0.40, 0.400], [-0.90, 0.470]]),
        curve([[1.95, 0.700], [1.55, 0.742], [1.15, 0.782], [0.85, 0.810]]),        // front wing crest
        curve([[-0.95, 0.900], [-1.30, 0.925], [-1.70, 0.905], [-2.06, 0.865]])     // rear haunch crown
      ],
      sill: rrect(-0.94, 0.165, 0.94, 0.215, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[0.94, 0.165, 'c'], [-0.94, 0.165, 'c'], [-0.945, 0.188, 'c'], [0.945, 0.188, 'c']]),                  // side-skirt blade
        loop([[1.62, 0.176, 'c'], [1.80, 0.176], [2.10, 0.154, 'c'], [2.16, 0.182, 'c'], [1.80, 0.198], [1.625, 0.212, 'c']]),
        loop([[-1.62, 0.176, 'c'], [-1.85, 0.178], [-2.03, 0.222, 'c'], [-2.09, 0.300, 'c'], [-1.85, 0.215], [-1.615, 0.214, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.05, -0.56], [-0.05, 0.56], [-0.85, 0.52], [-0.85, -0.52]], 0.07);
    var top = {
      // pointed nose, wings over the front wheels, pinched waist at the intakes, wide hips over the engine
      body: sym([[XF, 0, 'v'], [2.268, 0.30], [2.22, 0.58], [2.10, 0.780], [1.90, 0.885], [1.29, 0.935, 'h'], [0.70, 0.905], [-0.20, 0.892],
        [-0.80, 0.918], [-1.29, 0.9475, 'h'], [-1.75, 0.932], [-1.98, 0.880], [-2.09, 0.770], [-2.128, 0.560], [-2.136, 0.280], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.56, 0, 'v'], [0.48, 0.620, 'c'], [0.10, 0.680], [-0.50, 0.680], [-1.00, 0.620], [-1.30, 0.500], [-1.50, 0.300], [-1.55, 0, 'v']], 1),
      hood: sym([[2.20, 0, 'v'], [2.14, 0.42], [2.00, 0.58, 'c'], [0.65, 0.62, 'c'], [0.58, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.36, 0, 'v'], [-1.38, 0.50, 'c'], [-2.03, 0.58, 'c'], [-2.07, 0, 'v']], 1),
      mirrors: pair(loop([[0.40, 0.880, 'c'], [0.37, 0.980], [0.31, 1.020], [0.21, 1.015], [0.17, 0.960], [0.175, 0.880, 'c']]), 1),
      characterLines: [].concat(
        pair(curve([[2.00, 0.70], [1.60, 0.79], [1.10, 0.80], [0.70, 0.76]]), 1),      // wing crowns
        pair(curve([[-1.00, 0.80], [-1.50, 0.86], [-2.00, 0.78]]), 1),                 // rear haunches
        pair(curve([[-0.90, 0.64], [-1.20, 0.60], [-1.40, 0.50]]), 1))                 // flying buttresses
    };

    var front = {
      body: sym([[0, H, 'h'], [0.40, 1.212], [0.55, 1.130], [0.63, 0.980], [0.69, 0.860], [0.78, 0.780], [0.88, 0.720], [0.93, 0.620],
        [0.9475, 0.500, 'v'], [0.940, 0.360], [0.900, 0.220], [0.830, 0.155, 'c'], [0.550, 0.140], [0, 0.135, 'h']], 0),
      greenhouse: sym([[0, 1.200, 'h'], [0.39, 1.186], [0.53, 1.110], [0.60, 0.975], [0.65, 0.875, 'c'], [0, 0.855, 'h']], 0),
      bumper: sym([[0, 0.470, 'h'], [0.30, 0.476], [0.55, 0.520], [0.90, 0.550], [0.940, 0.360], [0.900, 0.220], [0.830, 0.155, 'c'], [0.550, 0.140], [0, 0.135, 'h']], 0),
      // front lid dipping between the raised wing crowns
      characterLines: [
        curve([[-0.88, 0.720], [-0.76, 0.780], [-0.62, 0.770, 'h'], [-0.40, 0.700], [0, 0.690, 'h'], [0.40, 0.700], [0.62, 0.770, 'h'], [0.76, 0.780], [0.88, 0.720]]),
        curve([[-0.30, 0.700], [-0.28, 0.780], [-0.24, 0.850]]),
        curve([[0.30, 0.700], [0.28, 0.780], [0.24, 0.850]])
      ],
      // wide central mouth with a slim upper slot under the lid lip, plus the two big outer intakes with vertical vanes
      grille: [rpoly([[-0.46, 0.190], [0.46, 0.190], [0.53, 0.300], [0.49, 0.430], [-0.49, 0.430], [-0.53, 0.300]], 0.03)],
      intakes: pair(rpoly([[0.62, 0.200], [0.86, 0.225], [0.905, 0.360], [0.870, 0.500], [0.64, 0.460], [0.575, 0.320]], 0.025), 0).concat([
        rpoly([[-0.40, 0.550], [0.40, 0.550], [0.37, 0.585], [-0.37, 0.585]], 0.012)
      ]),
      // swept lamps high on the wing corners, inner end low beside the lid, outer end climbing round the corner
      headlights: pair(loop([[0.46, 0.610, 'c'], [0.62, 0.660], [0.80, 0.700], [0.895, 0.690], [0.912, 0.635], [0.87, 0.585], [0.70, 0.575], [0.52, 0.585]]), 0),
      drl: [].concat(
        // J-shaped light blade: along the top edge, then down the outer end
        pair(rpoly([[0.50, 0.618], [0.62, 0.656], [0.80, 0.694], [0.880, 0.684], [0.892, 0.640], [0.878, 0.638], [0.868, 0.674], [0.80, 0.682], [0.62, 0.645], [0.505, 0.606]], 0.003), 0)
      ),
      splitter: rpoly([[-0.84, 0.135], [0.84, 0.135], [0.86, 0.155], [-0.86, 0.155]], 0.008),
      plateArea: rrect(-0.26, 0.255, 0.26, 0.365, 0.01),
      badgeArea: rrect(-0.05, 0.600, 0.05, 0.640, 0.01)
    };

    var lampC = loop([[0.62, 0.965, 'c'], [0.86, 0.965], [0.912, 0.920], [0.930, 0.820], [0.900, 0.750, 'c'], [0.866, 0.770, 'c'], [0.885, 0.830],
      [0.878, 0.900], [0.840, 0.930], [0.64, 0.932, 'c']]);
    var rear = {
      body: sym([[0, H, 'h'], [0.38, 1.210], [0.52, 1.120], [0.60, 1.020], [0.72, 0.992], [0.88, 0.975], [0.935, 0.900], [0.9475, 0.720, 'v'],
        [0.940, 0.500], [0.910, 0.300], [0.850, 0.190, 'c'], [0, 0.180, 'h']], 0),
      // small near-vertical rear screen between the buttresses
      greenhouse: sym([[0, 1.185, 'h'], [0.30, 1.172], [0.40, 1.115], [0.44, 1.050, 'c'], [0, 1.040, 'h']], 0),
      bumper: sym([[0, 0.620, 'h'], [0.50, 0.622], [0.90, 0.640], [0.940, 0.500], [0.910, 0.300], [0.850, 0.190, 'c'], [0, 0.180, 'h']], 0),
      characterLines: [curve([[-0.88, 0.975], [-0.50, 0.990], [0, 0.995, 'h'], [0.50, 0.990], [0.88, 0.975]])],   // ducktail edge
      // C-shaped LED tail lamps framing the black rear panel
      taillights: pair(lampC, 0),
      diffuser: sym([[0, 0.360, 'h'], [0.45, 0.360], [0.75, 0.320, 'c'], [0.72, 0.190], [0, 0.180, 'h']], 0),
      // twin central tailpipes in the diffuser
      exhaust: [{ shape: 'oval', cx: 0.115, cy: 0.270, w: 0.115, h: 0.085 }, { shape: 'oval', cx: -0.115, cy: 0.270, w: 0.115, h: 0.085 }],
      plateArea: rrect(-0.26, 0.440, 0.26, 0.550, 0.01),
      badgeArea: rrect(-0.24, 0.780, 0.24, 0.810, 0.008),
      spoiler: sym([[0, 0.998, 'h'], [0.55, 0.992], [0.80, 0.978, 'c'], [0.78, 0.964, 'c'], [0, 0.978, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.42, 0.905, 'c'], [0.405, 0.975], [0.31, 0.992], [0.21, 0.965], [0.212, 0.915], [0.32, 0.900]]), 'body'),
      D('side', 'trim', rpoly([[0.30, 0.900], [0.36, 0.900], [0.37, 0.915], [0.31, 0.915]], 0.003), 'black'),   // mirror stalk
      D('side', 'trim', rpoly([[-0.30, 1.218], [-0.80, 1.150], [-0.81, 1.163], [-0.30, 1.228]], 0.003), 'gloss-black'),   // roof-rail seal
      D('side', 'handle', rrect(-0.56, 0.800, -0.42, 0.815, 0.007), 'black'),
      // the big side intake ahead of the rear wheel feeding the mid-mounted engine
      D('side', 'intake', loop([[-0.45, 0.520, 'c'], [-0.75, 0.740], [-1.08, 0.870, 'c'], [-1.11, 0.780], [-0.99, 0.620], [-0.90, 0.450, 'c'], [-0.70, 0.440]]), 'grille'),
      D('side', 'vent', rpoly([[-0.60, 0.560], [-1.02, 0.800], [-1.03, 0.785], [-0.61, 0.545]], 0.003), 'gloss-black'),   // intake splitter vane
      D('side', 'trim', loop([[2.262, 0.600], [2.21, 0.655], [2.08, 0.690], [1.98, 0.702], [2.00, 0.672], [2.12, 0.645], [2.245, 0.588]]), 'light'),
      D('side', 'intake', rpoly([[2.200, 0.250], [2.240, 0.268], [2.252, 0.420], [2.215, 0.420]], 0.006), 'grille'),   // bumper-corner vent
      D('side', 'trim', loop([[-1.95, 0.972, 'c'], [-2.085, 0.968], [-2.112, 0.922], [-2.120, 0.830, 'c'], [-2.085, 0.830], [-2.066, 0.900], [-1.97, 0.935, 'c']]), 'light-red'),
      D('side', 'marker', rrect(1.95, 0.400, 1.99, 0.420, 0.006), 'light-amber'),
      D('side', 'trim', rrect(-2.13, 0.420, -2.10, 0.480, 0.006), 'light-red'),
      D('top', 'vent', rpoly([[1.86, -0.32], [2.02, -0.30], [2.02, 0.30], [1.86, 0.32]], 0.02), 'gloss-black'),   // front-lid radiator outlet
      D('top', 'wiper', rrect(0.56, -0.05, 0.60, 0.56, 0.01), 'black'),
      D('top', 'glass', rrect(-1.40, -0.40, -1.33, 0.40, 0.02), 'glass'),                                            // upright rear screen
      D('top', 'spoiler', rrect(-2.09, -0.52, -2.06, 0.52, 0.008), 'body')
    ].concat(
      [1.90, 1.94, 1.98].map(function (x) { return D('top', 'trim', rrect(x - 0.006, -0.28, x + 0.006, 0.28, 0.003), 'body'); }),   // outlet slats
      // louvred engine-cover panel over the V6 / four
      [-1.50, -1.60, -1.70, -1.80, -1.90].reduce(function (a, x) { return a.concat(pairD('top', 'vent', rrect(x - 0.025, 0.05, x + 0.025, 0.46, 0.01), 'gloss-black', 1)); }, []),
      pairD('top', 'trim', loop([[2.20, 0.50, 'c'], [2.12, 0.74], [2.00, 0.84, 'c'], [1.96, 0.80, 'c'], [2.06, 0.66], [2.14, 0.48, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.65, 0.880, 'c'], [0.78, 0.890], [0.94, 0.900], [0.958, 0.945], [0.890, 0.980], [0.800, 0.975], [0.740, 0.920], [0.65, 0.906, 'c']]), 'body', 0),
      [0.68, 0.74, 0.80].reduce(function (a, z) { return a.concat(pairD('front', 'vent', rrect(z - 0.007, 0.230, z + 0.007, 0.470, 0.004), 'gloss-black', 0)); }, []),   // intake vanes
      pairD('front', 'trim', ellipse(0.60, 0.598, 0.030, 0.020, 0), 'light', 0),                                // projector
      [
        D('front', 'wiper', rpoly([[-0.05, 0.866], [0.52, 0.884], [0.52, 0.894], [-0.05, 0.878]], 0.004), 'black'),
        D('front', 'trim', rpoly([[-0.44, 0.432], [0.44, 0.432], [0.47, 0.445], [-0.47, 0.445]], 0.004), 'body'),   // mouth upper lip
        // black rear panel between the C lamps carrying the name, with a vent mesh below
        D('rear', 'vent', rpoly([[-0.60, 0.760], [0.60, 0.760], [0.62, 0.930], [-0.62, 0.930]], 0.02), 'grille'),
        D('rear', 'trim', rrect(-0.06, 1.000, 0.06, 1.010, 0.004), 'light-red')
      ],
      [-0.42, -0.28, 0.28, 0.42].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.19, z + 0.008, 0.35, 0.004), 'gloss-black'); }),   // diffuser fins
      pairD('rear', 'trim', rpoly([[0.66, 0.952], [0.85, 0.952], [0.895, 0.915], [0.906, 0.83], [0.896, 0.83], [0.884, 0.905], [0.845, 0.940], [0.66, 0.942]], 0.003), 'light', 0),  // LED light guide
      pairD('rear', 'trim', rrect(0.780, 0.400, 0.860, 0.420, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.950, 0.882, 'c'], [0.960, 0.900], [0.958, 0.945], [0.890, 0.980], [0.950, 0.975, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.55, xBL: -1.55, crispTail: 0.28,
      belt: [[0.55, 0.858], [0.40, 0.893], [0.05, 0.903], [-0.40, 0.918], [-0.80, 0.948], [-1.10, 0.982], [-1.34, 1.010], [-1.55, 1.010]],
      crest: [[2.27, 0.46, 0.60], [2.10, 0.70, 0.68], [1.80, 0.745, 0.74], [1.29, 0.795, 0.80], [0.55, 0.840, 0.86], [-0.40, 0.875, 0.92],
        [-1.29, 0.935, 0.95], [-1.75, 0.945, 0.84], [-2.00, 0.925, 0.72], [-2.13, 0.850, 0.60]],
      dip: [[2.27, 0.0], [2.18, 0.04], [2.00, 0.07], [1.50, 0.07], [1.00, 0.04], [0.55, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'lotus-emira', make: 'Lotus', name: 'Emira', gen: 'Type 131', years: '2022–', style: 'coupe',
      enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'ice', ref: ref, doors: 2,
      wheel: { style: 'y-spoke', spokes: 10, caliper: '#b5121b' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Swept LED headlamps high on the wing corners with a J-shaped light blade along the top edge and down the outer end.',
        taillights: 'C-shaped LED tail lamps at the rear corners framing a black rear panel that carries the name in plain text.',
        grille: 'No upper grille: a slim slot under the front-lid lip, a wide central mouth and two big outer intakes with vertical vanes.',
        notes: 'Evija-inspired mid-engine wedge: long front lid with a radiator outlet, screen well forward, sharp door blade sweeping into a huge side intake, flying buttresses, louvred engine cover, ducktail and twin central tailpipes.'
      },
      sources: ['lotuscars.com Emira specifications', 'auto-data.net Lotus Emira (track 1624/1610, overhangs 988/850)']
    };
  }

  /* ================================================================== */
  /* Subaru WRX STI (VA, 2014–2021)                                      */
  /* ================================================================== */
  function subaruWrxSti() {
    var ref = {
      length: 4.595, width: 1.795, height: 1.475, wheelbase: 2.650, trackF: 1.530, trackR: 1.540,
      frontOverhang: 0.930, rearOverhang: 1.015, wheelDiameter_in: 18,
      tireF: '245/40R18', tireR: '245/40R18', groundClearance: 0.135, rideHeight: 0.135, cd: 0.32, curbWeight_kg: 1540
    };
    var XF = 2.255, XR = -2.340, H = 1.475;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.325, y: rF, r: rF + 0.030, flare: 0.028 };
    var aR = { x: -1.325, y: rR, r: rR + 0.030, flare: 0.028 };
    var yb = 0.190;

    // upright four-door: rounded bumper, bonnet with the big top-mount intercooler scoop, tall glasshouse,
    // short boot deck carrying the tall STI wing
    var roofLine = [[0.68, 0.965, 'c'], [0.40, 1.130], [0.10, 1.330], [-0.10, 1.432], [-0.45, H, 'h'], [-0.90, 1.455], [-1.20, 1.400], [-1.50, 1.250], [-1.80, 1.110]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.72, 0.192], [2.10, 0.172, 'c'], [2.220, 0.250], [XF, 0.420, 'v'], [2.252, 0.600], [2.235, 0.720], [2.200, 0.790], [2.130, 0.825],
      [1.90, 0.850], [1.60, 0.872], [1.50, 0.878, 'c'], [1.47, 0.940, 'c'], [1.30, 0.950], [1.05, 0.945], [0.90, 0.948]
    ].concat(roofLine, [
      [-1.97, 1.078], [-2.20, 1.072], [-2.290, 1.068, 'c'], [-2.328, 1.020, 'c'], [XR, 0.800, 'v'], [-2.335, 0.550], [-2.300, 0.340], [-2.200, 0.220, 'c'], [-1.90, yb, 'c']
    ]), 0.185);

    var fdg = [[0.56, 1.000, 'c'], [0.33, 1.138], [0.08, 1.307], [-0.12, 1.386], [-0.33, 1.410, 'c'], [-0.35, 1.034, 'c']];
    var rdg = [[-0.44, 1.036, 'c'], [-0.43, 1.414, 'c'], [-0.85, 1.403], [-1.06, 1.366], [-1.11, 1.350, 'c'], [-1.11, 1.060, 'c']];
    var qtr = [[-1.18, 1.064, 'c'], [-1.18, 1.326, 'c'], [-1.29, 1.258], [-1.42, 1.152, 'c'], [-1.30, 1.090]];
    var side = {
      body: body,
      greenhouse: loop([[0.60, 0.990, 'c'], [0.35, 1.140], [0.08, 1.320], [-0.12, 1.400], [-0.45, 1.430, 'h'], [-0.85, 1.418], [-1.10, 1.375], [-1.30, 1.270],
        [-1.46, 1.150, 'c'], [-1.30, 1.080], [-0.80, 1.048], [0.00, 1.020]]),
      windows: [loop(fdg), loop(rdg), loop(qtr)],
      pillars: [loop([[0.68, 0.965, 'c'], [0.40, 1.130], [0.10, 1.330], [-0.10, 1.432, 'c'], [-0.12, 1.400, 'c'], [0.08, 1.320], [0.35, 1.140], [0.60, 0.990, 'c']])],
      doorCuts: [
        curve([[0.62, 0.990], [0.85, 0.880], [0.96, 0.700], [0.965, 0.215]]),                         // front door leading edge
        line([[-0.39, 1.030], [-0.39, 0.212]]),                                                       // B-pillar
        curve([[-1.40, 1.100], [-1.33, 0.900], [-1.20, 0.760], [-1.05, 0.630], [-0.975, 0.470], [-0.97, 0.212]]),   // rear door round the arch
        curve([[0.965, 0.215], [0.00, 0.210], [-0.97, 0.212]])
      ],
      panelLines: [
        curve([[2.15, 0.820], [1.60, 0.865], [0.75, 0.955]]),             // bonnet shut line on the wing top
        curve([[2.240, 0.560], [2.08, 0.500], [1.82, 0.470]]),            // bumper / wing seam
        curve([[-1.80, 1.090], [-2.00, 1.050], [-2.15, 1.000], [-2.32, 0.985]]),   // boot lid
        curve([[-1.70, 0.640], [-1.72, 0.48], [-1.74, 0.300]]),           // rear bumper seam behind the arch
        rrect(-1.82, 0.850, -1.70, 0.945, 0.016)                           // fuel flap
      ],
      characterLines: [
        curve([[2.10, 0.790], [1.20, 0.850], [0.00, 0.890], [-1.20, 0.925], [-2.30, 0.955]]),      // shoulder line lamp to lamp
        curve([[0.95, 0.400], [0.00, 0.420], [-0.95, 0.480]]),                                    // lower door swage
        // the wider STI front wings and pumped rear arches
        curve([[1.82, 0.620], [1.55, 0.712], [1.10, 0.712], [0.92, 0.610]]),
        curve([[-0.98, 0.660], [-1.20, 0.732], [-1.50, 0.732], [-1.72, 0.640]])
      ],
      sill: rrect(-0.98, 0.185, 0.98, 0.235, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[0.98, 0.185, 'c'], [-0.98, 0.185, 'c'], [-0.985, 0.210, 'c'], [0.985, 0.210, 'c']]),                  // STI side skirt
        loop([[1.66, 0.192, 'c'], [1.80, 0.194], [2.10, 0.176, 'c'], [2.16, 0.205, 'c'], [1.80, 0.218], [1.665, 0.232, 'c']]),   // front lip
        loop([[-1.66, 0.192, 'c'], [-1.95, 0.192], [-2.20, 0.222, 'c'], [-2.26, 0.290, 'c'], [-1.95, 0.234], [-1.655, 0.232, 'c']])
      ]
    };

    var top = {
      body: sym([[XF, 0, 'v'], [2.250, 0.40], [2.220, 0.66], [2.130, 0.800], [1.950, 0.870], [1.325, 0.8975, 'h'], [0.70, 0.880], [-0.30, 0.878],
        [-0.90, 0.888], [-1.325, 0.8975, 'h'], [-1.90, 0.884], [-2.20, 0.856], [-2.300, 0.790], [-2.330, 0.640], [-2.338, 0.360], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.68, 0, 'v'], [0.58, 0.660, 'c'], [0.10, 0.720], [-0.80, 0.710], [-1.40, 0.660], [-1.80, 0.580], [-1.88, 0.400], [-1.90, 0, 'v']], 1),
      hood: sym([[2.18, 0, 'v'], [2.14, 0.55], [2.00, 0.74, 'c'], [0.72, 0.70, 'c'], [0.68, 0, 'v']], 1),
      roof: rpoly([[-0.08, -0.62], [-0.08, 0.62], [-1.22, 0.60], [-1.22, -0.60]], 0.07),
      deck: sym([[-1.90, 0, 'v'], [-1.92, 0.62, 'c'], [-2.28, 0.70, 'c'], [-2.31, 0, 'v']], 1),
      mirrors: pair(loop([[0.56, 0.875, 'c'], [0.53, 0.975], [0.47, 1.012], [0.37, 1.006], [0.33, 0.950], [0.335, 0.875, 'c']]), 1),
      characterLines: pair(curve([[2.10, 0.40], [1.60, 0.44], [1.00, 0.50], [0.72, 0.52]]), 1)             // bonnet creases
    };

    // hexagonal grille: wide top meeting the lamps, tapering below the wing bar
    var grille = rpoly([[-0.34, 0.790], [0.34, 0.790], [0.41, 0.700], [0.31, 0.585], [-0.31, 0.585], [-0.41, 0.700]], 0.02);
    var front = {
      body: sym([[0, H, 'h'], [0.45, 1.458], [0.60, 1.380], [0.68, 1.200], [0.74, 1.060], [0.84, 0.980], [0.88, 0.880], [0.8975, 0.680, 'v'],
        [0.890, 0.450], [0.860, 0.280], [0.800, 0.190, 'c'], [0.550, 0.175], [0, 0.170, 'h']], 0),
      greenhouse: sym([[0, 1.440, 'h'], [0.44, 1.425], [0.58, 1.350], [0.66, 1.190], [0.72, 1.035, 'c'], [0, 1.000, 'h']], 0),
      bumper: sym([[0, 0.585, 'h'], [0.32, 0.590], [0.46, 0.690], [0.86, 0.700], [0.890, 0.450], [0.860, 0.280], [0.800, 0.190, 'c'], [0.550, 0.175], [0, 0.170, 'h']], 0),
      characterLines: [
        curve([[-0.86, 0.900], [-0.66, 0.890, 'h'], [-0.40, 0.840], [0, 0.828, 'h'], [0.40, 0.840], [0.66, 0.890, 'h'], [0.86, 0.900]]),   // bonnet edge
        curve([[-0.45, 0.850], [-0.42, 0.900], [-0.38, 0.950]]),
        curve([[0.45, 0.850], [0.42, 0.900], [0.38, 0.950]])
      ],
      grille: [grille],
      // wide lower mouth plus the fog-lamp bezels in the corners
      intakes: [rpoly([[-0.48, 0.220], [0.48, 0.220], [0.53, 0.400], [0.42, 0.525], [-0.42, 0.525], [-0.53, 0.400]], 0.03)].concat(
        pair(rpoly([[0.60, 0.250], [0.82, 0.270], [0.855, 0.420], [0.81, 0.510], [0.63, 0.470], [0.565, 0.340]], 0.025), 0)),
      fogLights: pair(ellipse(0.715, 0.375, 0.050, 0.040, 0), 0),
      // "hawk-eye" lamps: swept back from the grille corners to the wings, a C-shaped LED around the projector
      headlights: pair(loop([[0.35, 0.805, 'c'], [0.60, 0.835], [0.82, 0.872], [0.878, 0.850], [0.888, 0.780], [0.840, 0.722], [0.65, 0.712], [0.42, 0.740]]), 0),
      drl: [].concat(
        pair(rpoly([[0.64, 0.818], [0.53, 0.813], [0.49, 0.777], [0.53, 0.742], [0.64, 0.738], [0.64, 0.751], [0.54, 0.754], [0.51, 0.777], [0.54, 0.801], [0.64, 0.805]], 0.003), 0)
      ),
      splitter: rpoly([[-0.80, 0.170], [0.80, 0.170], [0.83, 0.195], [-0.83, 0.195]], 0.008),
      plateArea: rrect(-0.26, 0.400, 0.26, 0.510, 0.01),
      badgeArea: rrect(-0.06, 0.660, 0.06, 0.720, 0.012)
    };

    var lampT = loop([[0.42, 1.040, 'c'], [0.84, 1.045], [0.885, 1.000], [0.890, 0.900], [0.860, 0.860, 'c'], [0.70, 0.885], [0.55, 0.930], [0.44, 0.975, 'c']]);
    var rear = {
      body: sym([[0, H, 'h'], [0.44, 1.455], [0.58, 1.370], [0.65, 1.200], [0.70, 1.090], [0.84, 1.060], [0.88, 0.980], [0.8975, 0.800, 'v'],
        [0.890, 0.550], [0.860, 0.330], [0.800, 0.210, 'c'], [0, 0.200, 'h']], 0),
      greenhouse: sym([[0, 1.430, 'h'], [0.43, 1.415], [0.56, 1.330], [0.62, 1.180], [0.64, 1.100, 'c'], [0, 1.085, 'h']], 0),
      bumper: sym([[0, 0.740, 'h'], [0.60, 0.745], [0.86, 0.760], [0.890, 0.550], [0.860, 0.330], [0.800, 0.210, 'c'], [0, 0.200, 'h']], 0),
      panelLines: [curve([[-0.42, 0.780], [0, 0.776, 'h'], [0.42, 0.780]])],
      characterLines: [curve([[-0.86, 0.760], [-0.50, 0.780], [0, 0.782, 'h'], [0.50, 0.780], [0.86, 0.760]])],
      taillights: pair(lampT, 0),
      diffuser: sym([[0, 0.360, 'h'], [0.40, 0.360], [0.74, 0.330, 'c'], [0.72, 0.210], [0, 0.200, 'h']], 0),
      // quad round tailpipes in two pairs at the outer ends of the diffuser
      exhaust: [0.47, 0.59, -0.47, -0.59].map(function (z) { return { shape: 'round', cx: z, cy: 0.270, w: 0.095, h: 0.095 }; }),
      plateArea: rrect(-0.26, 0.820, 0.26, 0.930, 0.01),
      badgeArea: rrect(-0.12, 0.955, 0.12, 0.990, 0.008),
      // tall STI wing on two pylons
      spoiler: sym([[0, 1.215, 'h'], [0.60, 1.215], [0.745, 1.230, 'c'], [0.745, 1.165, 'c'], [0.60, 1.172], [0, 1.172, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.56, 1.020, 'c'], [0.545, 1.095], [0.44, 1.112], [0.34, 1.085], [0.342, 1.030], [0.46, 1.014]]), 'body'),
      D('side', 'trim', rpoly([[-0.345, 1.034], [-0.330, 1.410], [-0.430, 1.414], [-0.440, 1.036]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'trim', rrect(-1.18, 1.062, -1.11, 1.330, 0.003), 'gloss-black'),                                            // rear door division bar
      D('side', 'handle', rrect(-0.22, 0.900, -0.07, 0.922, 0.010), 'body'),
      D('side', 'handle', rrect(-1.00, 0.922, -0.85, 0.944, 0.010), 'body'),
      D('side', 'vent', rpoly([[0.93, 0.620], [1.07, 0.640], [1.07, 0.700], [0.95, 0.690]], 0.006), 'gloss-black'),          // STI wing garnish
      D('side', 'trim', loop([[2.235, 0.760], [2.13, 0.810], [1.98, 0.835], [2.00, 0.795], [2.14, 0.765], [2.245, 0.720]]), 'light'),
      D('side', 'trim', loop([[-2.05, 1.060, 'c'], [-2.27, 1.058], [-2.318, 1.010], [-2.330, 0.930, 'c'], [-2.20, 0.950], [-2.08, 1.000, 'c']]), 'light-red'),
      D('side', 'marker', rrect(2.05, 0.450, 2.12, 0.470, 0.006), 'light-amber'),
      D('side', 'trim', rrect(-2.34, 0.450, -2.31, 0.510, 0.006), 'light-red'),
      // the tall STI wing on its pylons, seen from the side
      D('side', 'wing', loop([[-1.96, 1.215, 'c'], [-2.31, 1.235, 'c'], [-2.325, 1.185, 'c'], [-1.99, 1.172, 'c']]), 'body'),
      D('side', 'spoiler', rpoly([[-2.08, 1.072], [-2.135, 1.072], [-2.195, 1.185], [-2.140, 1.185]], 0.004), 'body'),
      D('side', 'antenna', loop([[-1.08, 1.420, 'c'], [-1.20, 1.465], [-1.26, 1.405, 'c']]), 'gloss-black'),
      D('top', 'scoop', rpoly([[1.00, -0.30], [1.46, -0.30], [1.46, 0.30], [1.00, 0.30]], 0.05), 'body'),                    // bonnet scoop
      D('top', 'intake', rrect(1.40, -0.26, 1.46, 0.26, 0.01), 'gloss-black'),
      D('top', 'wiper', rrect(0.64, -0.05, 0.68, 0.62, 0.01), 'black'),
      D('top', 'antenna', rrect(-1.26, -0.03, -1.08, 0.03, 0.02), 'gloss-black'),
      D('top', 'wing', rrect(-2.30, -0.745, -1.98, 0.745, 0.02), 'body'),
      D('top', 'trim', rrect(-2.338, -0.84, -2.31, 0.84, 0.008), 'light-red')
    ].concat(
      pairD('top', 'trim', loop([[2.21, 0.40, 'c'], [2.17, 0.66], [2.08, 0.80, 'c'], [2.02, 0.78, 'c'], [2.10, 0.62], [2.14, 0.40, 'c']]), 'light', 1),
      pairD('top', 'spoiler', rrect(-2.17, 0.40, -2.10, 0.44, 0.01), 'body', 1),
      pairD('front', 'mirror', loop([[0.72, 1.020, 'c'], [0.84, 1.030], [1.00, 1.040], [1.012, 1.085], [0.95, 1.118], [0.86, 1.112], [0.80, 1.060], [0.72, 1.048, 'c']]), 'body', 0),
      pairD('front', 'trim', ellipse(0.585, 0.777, 0.040, 0.030, 0), 'chrome', 0),                                  // projector lens
      pairD('front', 'trim', rpoly([[0.60, 0.270], [0.80, 0.290], [0.83, 0.300], [0.62, 0.285]], 0.003), 'gloss-black', 0),
      [
        // the bonnet scoop over the bonnet edge and its opening
        D('front', 'scoop', rpoly([[-0.30, 0.872], [0.30, 0.872], [0.27, 0.928], [-0.27, 0.928]], 0.012), 'body'),
        D('front', 'intake', rpoly([[-0.25, 0.878], [0.25, 0.878], [0.23, 0.918], [-0.23, 0.918]], 0.008), 'gloss-black'),
        D('front', 'trim', rpoly([[-0.40, 0.690], [0.40, 0.690], [0.385, 0.715], [-0.385, 0.715]], 0.006), 'chrome'),   // grille wing bar
        D('front', 'wiper', rpoly([[-0.05, 1.005], [0.62, 1.030], [0.62, 1.040], [-0.05, 1.017]], 0.004), 'black'),
        D('rear', 'trim', rrect(-0.10, 1.192, 0.10, 1.204, 0.004), 'light-red')                                          // brake light in the wing
      ],
      pairD('rear', 'spoiler', rpoly([[0.40, 1.065], [0.44, 1.065], [0.45, 1.172], [0.41, 1.172]], 0.004), 'body', 0),   // wing pylons
      pairD('rear', 'wing', rpoly([[0.73, 1.150], [0.755, 1.150], [0.755, 1.245], [0.73, 1.245]], 0.004), 'body', 0),     // end plates
      pairD('rear', 'trim', rpoly([[0.47, 1.025], [0.82, 1.030], [0.868, 0.990], [0.872, 0.910], [0.858, 0.905], [0.852, 0.980], [0.81, 1.016], [0.47, 1.012]], 0.003), 'light', 0),   // C-shaped LED
      pairD('rear', 'trim', rrect(0.780, 0.420, 0.860, 0.445, 0.006), 'light-red', 0),
      [0, 0.12, -0.12, 0.24, -0.24].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.21, z + 0.008, 0.35, 0.004), 'gloss-black'); }),
      pairD('rear', 'mirror', loop([[0.900, 1.020, 'c'], [1.00, 1.040], [1.012, 1.085], [0.95, 1.118], [0.900, 1.110, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.185, xWS: 0.68, xBL: -1.90, crispTail: 0.28,
      belt: [[0.68, 0.965], [0.60, 0.990], [0.00, 1.020], [-0.80, 1.048], [-1.30, 1.080], [-1.46, 1.110], [-1.70, 1.080], [-1.90, 1.070]],
      crest: [[2.25, 0.40, 0.60], [2.12, 0.76, 0.68], [1.80, 0.84, 0.76], [1.33, 0.875, 0.82], [0.68, 0.93, 0.90], [-0.40, 0.96, 0.94],
        [-1.33, 0.99, 0.93], [-1.90, 1.04, 0.84], [-2.20, 1.04, 0.76], [-2.33, 0.98, 0.64]],
      dip: [[2.25, 0.0], [2.15, 0.03], [2.00, 0.04], [1.50, 0.03], [1.00, 0.02], [0.68, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'subaru-wrx-sti-va', make: 'Subaru', name: 'WRX STI', gen: 'VA', years: '2014–2021', style: 'sedan',
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice', ref: ref, doors: 4,
      wheel: { style: 'y-spoke', spokes: 5, caliper: '#d6c400' },   // gold/yellow Brembo callipers with the STI wheels
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: '"Hawk-eye" headlamps swept back from the grille corners, each with a C-shaped LED light guide around the projector.',
        taillights: 'Wide tail lamps wrapping from the quarter onto the boot lid with a C-shaped LED graphic.',
        grille: 'Hexagonal grille with a horizontal wing bar, wide lower mouth and corner fog-lamp bezels, black front lip.',
        notes: 'Bonnet scoop over the top-mount intercooler, widened STI wings with vent garnish, tall wing on pylons, quad round tailpipes in two pairs.'
      },
      sources: ['auto-data.net Subaru WRX STI 2.5 (2014)', 'cars101.com 2015 WRX STI specifications']
    };
  }

  /* ================================================================== */
  /* Mitsubishi Lancer Evolution X (CZ4A, 2007–2016)                     */
  /* ================================================================== */
  function mitsubishiEvoX() {
    var ref = {
      length: 4.505, width: 1.810, height: 1.480, wheelbase: 2.650, trackF: 1.545, trackR: 1.545,
      frontOverhang: 0.920, rearOverhang: 0.935, wheelDiameter_in: 18,
      tireF: '245/40R18', tireR: '245/40R18', groundClearance: 0.140, rideHeight: 0.140, cd: 0.36, curbWeight_kg: 1560
    };
    var XF = 2.245, XR = -2.260, H = 1.480;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.325, y: rF, r: rF + 0.030, flare: 0.030 };
    var aR = { x: -1.325, y: rR, r: rR + 0.030, flare: 0.030 };
    var yb = 0.200;

    // "jet fighter" shark nose: the grille leans forward so the nose is furthest out at the top of the grille,
    // bumper raked back underneath; flat aluminium bonnet with vents, short deck with the wing
    var roofLine = [[0.72, 0.960, 'c'], [0.42, 1.120], [0.12, 1.330], [-0.10, 1.440], [-0.45, H, 'h'], [-0.90, 1.460], [-1.20, 1.400], [-1.48, 1.260], [-1.72, 1.130]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.72, 0.202], [2.02, 0.212, 'c'], [2.075, 0.255], [2.120, 0.400], [2.178, 0.565], [XF, 0.722, 'c'], [2.226, 0.764], [2.175, 0.788], [2.090, 0.802],
      [1.80, 0.845], [1.40, 0.888], [1.00, 0.925]
    ].concat(roofLine, [
      [-1.88, 1.092], [-2.12, 1.084], [-2.205, 1.080, 'c'], [-2.248, 1.030, 'c'], [XR, 0.820, 'v'], [-2.255, 0.580], [-2.220, 0.360], [-2.130, 0.230, 'c'], [-1.85, yb, 'c']
    ]), 0.195);

    var fdg = [[0.60, 0.995, 'c'], [0.38, 1.140], [0.12, 1.310], [-0.08, 1.392], [-0.34, 1.415, 'c'], [-0.36, 1.035, 'c']];
    var rdg = [[-0.44, 1.037, 'c'], [-0.43, 1.420, 'c'], [-0.85, 1.408], [-1.05, 1.368], [-1.10, 1.352, 'c'], [-1.10, 1.063, 'c']];
    var qtr = [[-1.17, 1.068, 'c'], [-1.17, 1.330, 'c'], [-1.30, 1.240], [-1.40, 1.152, 'c'], [-1.28, 1.095]];
    var side = {
      body: body,
      greenhouse: loop([[0.64, 0.985, 'c'], [0.40, 1.140], [0.12, 1.320], [-0.08, 1.405], [-0.45, 1.435, 'h'], [-0.85, 1.422], [-1.12, 1.370], [-1.32, 1.250],
        [-1.43, 1.150, 'c'], [-1.25, 1.090], [-0.80, 1.055], [0.00, 1.020]]),
      windows: [loop(fdg), loop(rdg), loop(qtr)],
      pillars: [loop([[0.72, 0.960, 'c'], [0.42, 1.120], [0.12, 1.330], [-0.10, 1.440, 'c'], [-0.08, 1.405, 'c'], [0.12, 1.320], [0.40, 1.140], [0.64, 0.985, 'c']])],
      doorCuts: [
        curve([[0.66, 0.980], [0.88, 0.870], [0.97, 0.700], [0.975, 0.225]]),
        line([[-0.40, 1.030], [-0.40, 0.222]]),
        curve([[-1.38, 1.110], [-1.31, 0.910], [-1.20, 0.770], [-1.05, 0.640], [-0.975, 0.480], [-0.97, 0.222]]),
        curve([[0.975, 0.225], [0.00, 0.220], [-0.97, 0.222]])
      ],
      panelLines: [
        curve([[2.14, 0.795], [1.50, 0.872], [0.80, 0.948]]),             // aluminium bonnet shut line
        curve([[2.205, 0.660], [2.03, 0.620], [1.82, 0.590]]),            // bumper / wing seam
        curve([[-1.72, 1.110], [-1.95, 1.070], [-2.10, 1.020], [-2.245, 1.005]]),   // boot lid
        curve([[-1.70, 0.640], [-1.72, 0.48], [-1.74, 0.300]]),
        rrect(-1.80, 0.860, -1.68, 0.950, 0.016)
      ],
      characterLines: [
        curve([[2.12, 0.780], [1.20, 0.845], [0.00, 0.885], [-1.20, 0.925], [-2.24, 0.960]]),      // straight shoulder line
        curve([[0.95, 0.420], [0.00, 0.440], [-0.95, 0.500]]),                                    // rising lower swage
        curve([[1.84, 0.640], [1.55, 0.725], [1.10, 0.725], [0.92, 0.630]]),                      // blistered front wings
        curve([[-0.98, 0.680], [-1.20, 0.745], [-1.50, 0.745], [-1.72, 0.660]])
      ],
      sill: rrect(-0.98, 0.195, 0.98, 0.245, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[0.98, 0.195, 'c'], [-0.98, 0.195, 'c'], [-0.985, 0.222, 'c'], [0.985, 0.222, 'c']]),
        loop([[1.66, 0.202, 'c'], [1.85, 0.205], [2.06, 0.218, 'c'], [2.10, 0.255, 'c'], [1.85, 0.232], [1.665, 0.242, 'c']]),   // front lip under the raked bumper
        loop([[-1.66, 0.202, 'c'], [-1.90, 0.202], [-2.13, 0.232, 'c'], [-2.19, 0.300, 'c'], [-1.90, 0.244], [-1.655, 0.242, 'c']])
      ]
    };

    var top = {
      body: sym([[XF, 0, 'v'], [2.242, 0.42], [2.215, 0.68], [2.130, 0.815], [1.950, 0.880], [1.325, 0.905, 'h'], [0.70, 0.888], [-0.30, 0.885],
        [-0.90, 0.895], [-1.325, 0.905, 'h'], [-1.85, 0.890], [-2.12, 0.860], [-2.222, 0.795], [-2.252, 0.650], [-2.258, 0.360], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.72, 0, 'v'], [0.62, 0.670, 'c'], [0.12, 0.730], [-0.80, 0.720], [-1.40, 0.670], [-1.72, 0.580], [-1.80, 0.400], [-1.82, 0, 'v']], 1),
      hood: sym([[2.20, 0, 'v'], [2.16, 0.56], [2.02, 0.76, 'c'], [0.76, 0.72, 'c'], [0.72, 0, 'v']], 1),
      roof: rpoly([[-0.08, -0.63], [-0.08, 0.63], [-1.20, 0.61], [-1.20, -0.61]], 0.07),
      deck: sym([[-1.82, 0, 'v'], [-1.84, 0.62, 'c'], [-2.20, 0.70, 'c'], [-2.23, 0, 'v']], 1),
      mirrors: pair(loop([[0.60, 0.885, 'c'], [0.57, 0.985], [0.51, 1.022], [0.41, 1.016], [0.37, 0.960], [0.375, 0.885, 'c']]), 1),
      characterLines: pair(curve([[2.12, 0.30], [1.60, 0.30], [1.00, 0.32], [0.76, 0.33]]), 1)              // central bonnet bulge edges
    };

    // the big forward-leaning inverted-trapezoid grille fills the whole nose
    var front = {
      body: sym([[0, H, 'h'], [0.46, 1.462], [0.60, 1.380], [0.69, 1.200], [0.75, 1.050], [0.85, 0.980], [0.89, 0.880], [0.905, 0.660, 'v'],
        [0.895, 0.450], [0.860, 0.300], [0.800, 0.205, 'c'], [0.550, 0.190], [0, 0.185, 'h']], 0),
      greenhouse: sym([[0, 1.440, 'h'], [0.44, 1.425], [0.58, 1.350], [0.67, 1.190], [0.73, 1.040, 'c'], [0, 1.005, 'h']], 0),
      bumper: sym([[0, 0.740, 'h'], [0.45, 0.740], [0.60, 0.700], [0.88, 0.700], [0.895, 0.450], [0.860, 0.300], [0.800, 0.205, 'c'], [0.550, 0.190], [0, 0.185, 'h']], 0),
      characterLines: [
        curve([[-0.88, 0.880], [-0.66, 0.860, 'h'], [-0.40, 0.815], [0, 0.805, 'h'], [0.40, 0.815], [0.66, 0.860, 'h'], [0.88, 0.880]]),   // bonnet edge
        curve([[-0.30, 0.810], [-0.30, 0.880], [-0.29, 0.950]]),
        curve([[0.30, 0.810], [0.30, 0.880], [0.29, 0.950]])                                             // bonnet bulge
      ],
      grille: [rpoly([[-0.53, 0.730], [0.53, 0.730], [0.48, 0.560], [0.37, 0.280], [-0.37, 0.280], [-0.48, 0.560]], 0.035)],
      // tall corner ducts with the fog lamps, outboard of the grille
      intakes: pair(rpoly([[0.60, 0.250], [0.80, 0.270], [0.845, 0.420], [0.80, 0.560], [0.69, 0.585], [0.55, 0.420]], 0.025), 0),
      fogLights: pair(ellipse(0.715, 0.405, 0.042, 0.036, 0), 0),
      // angular lamps from the grille corners up to the wings, with a dark brow
      headlights: pair(loop([[0.50, 0.745, 'c'], [0.58, 0.800], [0.80, 0.845], [0.880, 0.825], [0.895, 0.765], [0.850, 0.722], [0.66, 0.705], [0.54, 0.712]]), 0),
      drl: pair(rpoly([[0.56, 0.718], [0.84, 0.732], [0.875, 0.768], [0.862, 0.770], [0.832, 0.744], [0.56, 0.731]], 0.003), 0),   // parking-lamp strip
      splitter: rpoly([[-0.80, 0.185], [0.80, 0.185], [0.83, 0.210], [-0.83, 0.210]], 0.008),
      plateArea: rrect(-0.26, 0.360, 0.26, 0.470, 0.01),
      badgeArea: rrect(-0.06, 0.620, 0.06, 0.680, 0.012)
    };

    var lampT = loop([[0.48, 1.055, 'c'], [0.85, 1.060], [0.890, 1.020], [0.895, 0.930], [0.870, 0.900, 'c'], [0.62, 0.930], [0.50, 0.980, 'c']]);
    var rear = {
      body: sym([[0, H, 'h'], [0.44, 1.460], [0.58, 1.370], [0.66, 1.200], [0.71, 1.110], [0.84, 1.080], [0.89, 1.000], [0.905, 0.820, 'v'],
        [0.895, 0.580], [0.860, 0.360], [0.800, 0.225, 'c'], [0, 0.215, 'h']], 0),
      greenhouse: sym([[0, 1.435, 'h'], [0.43, 1.420], [0.56, 1.330], [0.63, 1.180], [0.65, 1.110, 'c'], [0, 1.095, 'h']], 0),
      bumper: sym([[0, 0.760, 'h'], [0.60, 0.765], [0.87, 0.780], [0.895, 0.580], [0.860, 0.360], [0.800, 0.225, 'c'], [0, 0.215, 'h']], 0),
      panelLines: [curve([[-0.48, 0.800], [0, 0.796, 'h'], [0.48, 0.800]])],
      characterLines: [curve([[-0.88, 0.780], [-0.50, 0.800], [0, 0.802, 'h'], [0.50, 0.800], [0.88, 0.780]])],
      taillights: pair(lampT, 0),
      diffuser: sym([[0, 0.380, 'h'], [0.40, 0.380], [0.74, 0.345, 'c'], [0.72, 0.225], [0, 0.215, 'h']], 0),
      // twin big round tailpipes, one each side of the diffuser
      exhaust: [{ shape: 'round', cx: 0.56, cy: 0.290, w: 0.115, h: 0.115 }, { shape: 'round', cx: -0.56, cy: 0.290, w: 0.115, h: 0.115 }],
      plateArea: rrect(-0.26, 0.840, 0.26, 0.950, 0.01),
      badgeArea: rrect(-0.14, 0.975, 0.14, 1.010, 0.008),
      spoiler: sym([[0, 1.180, 'h'], [0.60, 1.180], [0.78, 1.192, 'c'], [0.78, 1.140, 'c'], [0.60, 1.145], [0, 1.145, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.60, 1.010, 'c'], [0.585, 1.085], [0.48, 1.102], [0.38, 1.075], [0.382, 1.020], [0.50, 1.004]]), 'body'),
      D('side', 'trim', rpoly([[-0.355, 1.035], [-0.340, 1.415], [-0.430, 1.420], [-0.440, 1.037]], 0.004), 'gloss-black'),
      D('side', 'trim', rrect(-1.17, 1.066, -1.10, 1.332, 0.003), 'gloss-black'),
      D('side', 'handle', rrect(-0.22, 0.895, -0.07, 0.917, 0.010), 'body'),
      D('side', 'handle', rrect(-1.00, 0.918, -0.85, 0.940, 0.010), 'body'),
      // fender-top air outlets behind the front wheels
      D('side', 'vent', rpoly([[0.88, 0.905], [1.16, 0.878], [1.17, 0.893], [0.89, 0.922]], 0.004), 'gloss-black'),
      D('side', 'trim', loop([[2.205, 0.765], [2.10, 0.795], [1.96, 0.818], [1.99, 0.780], [2.12, 0.752], [2.230, 0.720]]), 'light'),
      D('side', 'intake', rpoly([[2.065, 0.300], [2.092, 0.320], [2.128, 0.460], [2.100, 0.460]], 0.006), 'grille'),
      // the forward-leaning grille face seen edge-on: dark band along the raked-back shark nose
      D('side', 'trim', loop([[2.078, 0.262, 'c'], [2.124, 0.402], [2.181, 0.566], [2.240, 0.716, 'c'], [2.222, 0.712, 'c'], [2.165, 0.568], [2.108, 0.404], [2.062, 0.266, 'c']]), 'grille'),
      D('side', 'trim', loop([[-1.98, 1.075, 'c'], [-2.19, 1.073], [-2.240, 1.025], [-2.252, 0.940, 'c'], [-2.12, 0.960], [-2.00, 1.010, 'c']]), 'light-red'),
      D('side', 'marker', rrect(1.02, 0.660, 1.08, 0.676, 0.006), 'light-amber'),
      D('side', 'trim', rrect(-2.26, 0.460, -2.23, 0.520, 0.006), 'light-red'),
      D('side', 'wing', loop([[-1.90, 1.170, 'c'], [-2.22, 1.188, 'c'], [-2.232, 1.142, 'c'], [-1.92, 1.135, 'c']]), 'body'),
      D('side', 'spoiler', rpoly([[-2.02, 1.088], [-2.055, 1.088], [-2.090, 1.140], [-2.055, 1.140]], 0.004), 'body'),
      D('top', 'wiper', rrect(0.68, -0.05, 0.72, 0.62, 0.01), 'black'),
      D('top', 'vent', rpoly([[1.52, -0.26], [1.84, -0.24], [1.84, 0.24], [1.52, 0.26]], 0.03), 'gloss-black'),   // big central bonnet outlet
      D('top', 'antenna', rrect(-1.24, -0.03, -1.06, 0.03, 0.02), 'gloss-black'),
      D('top', 'wing', rrect(-2.23, -0.78, -1.90, 0.78, 0.02), 'body'),
      D('top', 'trim', rrect(-2.258, -0.84, -2.23, 0.84, 0.008), 'light-red')
    ].concat(
      [1.58, 1.64, 1.70, 1.76].map(function (x) { return D('top', 'trim', rrect(x - 0.008, -0.22, x + 0.008, 0.22, 0.004), 'body'); }),   // outlet louvres
      pairD('top', 'vent', rpoly([[1.95, 0.30], [2.08, 0.32], [2.06, 0.46], [1.94, 0.44]], 0.02), 'gloss-black', 1),   // front bonnet vents
      [0.92, 0.98, 1.04, 1.10].reduce(function (a, x) { return a.concat(pairD('top', 'vent', rrect(x - 0.018, 0.72, x + 0.018, 0.84, 0.008), 'gloss-black', 1)); }, []),   // fender-top louvres
      pairD('top', 'trim', loop([[2.21, 0.42, 'c'], [2.17, 0.68], [2.08, 0.81, 'c'], [2.02, 0.79, 'c'], [2.10, 0.64], [2.14, 0.42, 'c']]), 'light', 1),
      pairD('top', 'spoiler', rrect(-2.09, 0.40, -2.02, 0.44, 0.01), 'body', 1),
      pairD('front', 'mirror', loop([[0.74, 1.010, 'c'], [0.86, 1.020], [1.01, 1.030], [1.022, 1.075], [0.96, 1.108], [0.87, 1.102], [0.81, 1.050], [0.74, 1.038, 'c']]), 'body', 0),
      pairD('front', 'trim', rpoly([[0.52, 0.790], [0.80, 0.838], [0.874, 0.818], [0.86, 0.805], [0.79, 0.822], [0.55, 0.776]], 0.003), 'gloss-black', 0),   // dark brow
      pairD('front', 'trim', ellipse(0.64, 0.760, 0.040, 0.032, 0), 'chrome', 0),
      pairD('front', 'trim', ellipse(0.78, 0.778, 0.038, 0.030, 0), 'chrome', 0),
      [0.52, 0.60].map(function (y) { return D('front', 'trim', rpoly([[-0.47 + (0.73 - y) * 0.2, y], [0.47 - (0.73 - y) * 0.2, y], [0.47 - (0.73 - y) * 0.2, y + 0.008], [-0.47 + (0.73 - y) * 0.2, y + 0.008]], 0.002), 'gloss-black'); }),
      [
        D('front', 'wiper', rpoly([[-0.05, 1.010], [0.62, 1.035], [0.62, 1.045], [-0.05, 1.022]], 0.004), 'black'),
        D('front', 'vent', rpoly([[-0.22, 0.840], [0.22, 0.840], [0.20, 0.862], [-0.20, 0.862]], 0.006), 'gloss-black'),   // bonnet outlet seen over the nose
        D('rear', 'trim', rrect(-0.10, 1.160, 0.10, 1.170, 0.004), 'light-red'),
        D('rear', 'vent', rrect(-0.40, 0.240, 0.40, 0.350, 0.02), 'black')
      ],
      pairD('rear', 'spoiler', rpoly([[0.46, 1.085], [0.50, 1.085], [0.51, 1.145], [0.47, 1.145]], 0.004), 'body', 0),
      pairD('rear', 'wing', rpoly([[0.765, 1.125], [0.79, 1.125], [0.79, 1.205], [0.765, 1.205]], 0.004), 'body', 0),
      pairD('rear', 'trim', ring2(ellipse(0.72, 0.990, 0.045, 0.038, 0), ellipse(0.72, 0.990, 0.030, 0.024, 0)), 'light-red', 0),   // round lamp cluster
      pairD('rear', 'trim', ellipse(0.83, 0.985, 0.028, 0.026, 0), 'light', 0),
      pairD('rear', 'trim', rrect(0.780, 0.440, 0.860, 0.465, 0.006), 'light-red', 0),
      pairD('rear', 'trim', ring2(ellipse(0.56, 0.290, 0.070, 0.070, 0), ellipse(0.56, 0.290, 0.058, 0.058, 0)), 'chrome', 0),
      [-0.24, -0.12, 0, 0.12, 0.24].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.225, z + 0.008, 0.37, 0.004), 'gloss-black'); }),
      pairD('rear', 'mirror', loop([[0.905, 1.010, 'c'], [1.01, 1.030], [1.022, 1.075], [0.96, 1.108], [0.905, 1.100, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.195, xWS: 0.72, xBL: -1.82, crispTail: 0.28,
      belt: [[0.72, 0.960], [0.64, 0.985], [0.00, 1.020], [-0.80, 1.055], [-1.25, 1.090], [-1.43, 1.110], [-1.62, 1.095], [-1.82, 1.085]],
      crest: [[2.24, 0.73, 0.60], [2.14, 0.79, 0.68], [1.80, 0.84, 0.76], [1.33, 0.88, 0.82], [0.72, 0.93, 0.90], [-0.40, 0.96, 0.94],
        [-1.33, 0.99, 0.93], [-1.85, 1.05, 0.84], [-2.12, 1.05, 0.76], [-2.25, 0.99, 0.64]],
      dip: [[2.24, 0.0], [2.15, 0.02], [2.00, 0.03], [1.50, 0.02], [1.00, 0.015], [0.72, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'mitsubishi-lancer-evo-x', make: 'Mitsubishi', name: 'Lancer Evolution X', gen: 'CZ4A', years: '2007–2016', style: 'sedan',
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice', ref: ref, doors: 4,
      wheel: { style: 'multi-spoke', spokes: 12, caliper: '#1a1b1e' },   // Enkei 12-spoke, Brembo callipers
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Angular headlamps running up from the grille corners to the wings under a dark brow, twin projector/reflector elements.',
        taillights: 'Wrap-around tail lamps with round lamp clusters, joined across the boot lid by the plate recess.',
        grille: '"Jet-fighter" nose: a huge forward-leaning inverted-trapezoid grille filling the bumper, tall corner ducts with fog lamps.',
        notes: 'Shark nose raked back underneath, aluminium bonnet with a big central outlet and front vents, fender-top louvres, blistered wings, rear wing on pylons, twin round tailpipes either side of the diffuser.'
      },
      sources: ['auto-data.net Mitsubishi Lancer Evolution X 2.0 MIVEC (overhangs 920/935)', 'en.wikipedia.org Mitsubishi Lancer Evolution X']
    };
  }

  /* ------------------------------------------------------------------ */
  /* Renderer signatures (fixed vocabulary shared by every model file: the 3D and SVG renderers draw the lamp,
     tail-lamp and grille graphics from these) and the text-only front / rear badges. */
  var LOOK = {
    'bmw-m2-g87': [{ head: 'slim-led', tail: 'slim', grille: 'kidney' }, 'BMW', 'BMW'],
    'bmw-m3-e46': [{ head: 'projector-twin', tail: 'slim', grille: 'kidney' }, 'BMW', 'BMW'],
    'alpine-a110': [{ head: 'round-halo', tail: 'slim', grille: 'mesh' }, 'ALPINE', 'ALPINE'],
    'aston-martin-vantage-2018': [{ head: 'slim-led', tail: 'light-bar', grille: 'mesh' }, 'ASTON MARTIN', 'ASTON MARTIN'],
    'lotus-emira': [{ head: 'blade', tail: 'c-ring', grille: 'mesh' }, 'LOTUS', 'LOTUS'],
    'subaru-wrx-sti-va': [{ head: 'c-clamp', tail: 'c-ring', grille: 'hex' }, 'SUBARU', 'WRX STI'],
    'mitsubishi-lancer-evo-x': [{ head: 'projector-twin', tail: 'round-ring', grille: 'split-v' }, 'MITSUBISHI', 'EVOLUTION']
  };
  var list = [bmwM2(), bmwM3E46(), alpineA110(), astonVantage(), lotusEmira(), subaruWrxSti(), mitsubishiEvoX()];
  list.forEach(function (m) {
    var L = LOOK[m.id];
    m.look = { head: L[0].head, tail: L[0].tail, grille: L[0].grille };
    m.front.badgeText = L[1]; m.rear.badgeText = L[2];
  });
  list.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { models: list };
})();

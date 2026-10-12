/* ==========================================================================
   FORGE Atelier — js/shapes/models/coupe.js
   Real-car shape models for body style 'coupe':
     - Porsche 911 Carrera (992, 2019–)
     - BMW M4 Competition Coupé (G82, 2021–)
     - Toyota GR Supra 3.0 (A90, 2019–)

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top view = (x, z); front & rear views = (z, y).

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}. Body
   surfaces are smooth G1 cubic splines (circular-arc-consistent handle
   lengths) through hand-placed landmarks taken from published dimensions
   and reference photography. Brand names are text only: no manufacturer
   logo artwork is drawn; badgeArea marks where a text badge goes.

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

  /* 911 plan-view DLO: screen base (0.70, ±0.58) → widest at the B-pillar (-0.60, ±0.66) → backlight (-1.60, ±0.40). */
  function ghPlan911() {
    var R = [
      { t: 'C', p: [[0.745, 0.30], [0.725, 0.52], [0.70, 0.58]] },
      { t: 'C', p: [[0.27, 0.636], [-0.17, 0.66], [-0.60, 0.66]] },
      { t: 'C', p: [[-0.95, 0.66], [-1.40, 0.565], [-1.60, 0.40]] },
      { t: 'C', p: [[-1.66, 0.30], [-1.665, 0.15], [-1.64, 0]] }
    ];
    var segs = [{ t: 'M', p: [[0.76, 0]] }].concat(R), pts = [[0.76, 0]];
    R.forEach(function (s) { pts.push(s.p[2]); });
    // mirrored left half, traversed in reverse
    for (var i = R.length - 1; i >= 0; i--) {
      var s = R[i];
      segs.push({ t: 'C', p: [[s.p[1][0], -s.p[1][1]], [s.p[0][0], -s.p[0][1]], [pts[i][0], -pts[i][1]]] });
    }
    segs.push({ t: 'Z', p: [] });
    return segs;
  }

  /* ================================================================== */
  /* Porsche 911 Carrera (992)                                           */
  /* ================================================================== */
  function porsche911() {
    var ref = {
      length: 4.519, width: 1.852, height: 1.298, wheelbase: 2.450, trackF: 1.589, trackR: 1.557,
      frontOverhang: 0.975, rearOverhang: 1.094, wheelDiameter_in: 20, wheelDiameterF_in: 19, wheelDiameterR_in: 20,
      tireF: '235/40ZR19', tireR: '295/35ZR20', groundClearance: 0.110, rideHeight: 0.110, cd: 0.29, curbWeight_kg: 1505
    };
    var XF = 2.200, XR = -2.319, H = 1.298;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.225, y: rF, r: rF + 0.036, flare: 0.022 };
    var aR = { x: -1.225, y: rR, r: rR + 0.036, flare: 0.030 };
    var yb = 0.165;

    // one continuous flyline from the header to the ducktail (no step on the engine lid)
    var roofLine = [[0.70, 0.925, 'c'], [0.36, 1.098], [0.02, 1.258], [-0.40, H, 'h'], [-0.95, 1.250], [-1.45, 1.150], [-1.80, 1.060], [-2.10, 1.000], [-2.24, 0.975, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.80, 0.165], [2.03, 0.142, 'c'], [2.155, 0.205], [XF, 0.40, 'v'], [2.190, 0.500], [2.130, 0.600], [1.995, 0.745], [1.90, 0.800],
      // wing line climbs from the headlamp crown to the scuttle
      [1.60, 0.835], [1.20, 0.865], [0.90, 0.895]
    ].concat(roofLine, [
      [-2.314, 0.905], [XR, 0.700, 'v'], [-2.318, 0.450], [-2.308, 0.300], [-2.289, 0.200], [-2.24, yb, 'c'], [-1.95, yb, 'c']
    ]), 0.160);

    var doorGlass = [[0.56, 0.950, 'c'], [0.30, 1.100], [0.065, 1.222], [-0.30, 1.252, 'h'], [-0.60, 1.240, 'c'], [-0.615, 0.960, 'c']];
    // teardrop quarter window: sharp single-point tip following the flyline
    var quarterGlass = [[-0.672, 0.962, 'c'], [-0.668, 1.236, 'c'], [-0.90, 1.200], [-1.08, 1.140], [-1.24, 1.075, 'c'], [-1.12, 1.030], [-0.95, 0.985]];
    var side = {
      body: body,
      // daylight opening only (door glass + B-pillar + quarter glass), inset under the body-colour roof
      greenhouse: loop([[0.562, 0.950, 'c'], [0.298, 1.098], [0.068, 1.220], [-0.30, 1.258, 'h'], [-0.668, 1.246], [-0.90, 1.212], [-1.08, 1.150], [-1.25, 1.072, 'c'],
        [-1.12, 1.022], [-0.95, 0.980], [-0.62, 0.955], [0.10, 0.946]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [
        loop([[0.70, 0.925, 'c'], [0.36, 1.098], [0.02, 1.258, 'c'], [0.065, 1.222, 'c'], [0.30, 1.100], [0.56, 0.950, 'c']])
      ],
      // 1.25 m frameless door: front edge follows the A-pillar base, rear edge just behind the B-pillar trim
      doorCuts: [loop([[0.722, 0.25, 'c'], [0.722, 0.55], [0.712, 0.80], [0.69, 0.915]].concat(doorGlass, [[-0.60, 0.935], [-0.558, 0.62], [-0.53, 0.252, 'c']]))],
      panelLines: [
        curve([[1.90, 0.790], [1.74, 0.520], [1.596, 0.330]]),            // front bumper / wing seam
        curve([[-1.66, 0.620], [-1.675, 0.46], [-1.70, 0.300]]),          // rear bumper seam just behind the arch
        curve([[-1.98, 0.842], [-2.15, 0.841], [-2.315, 0.838]]),         // bumper top seam under the light bar
        curve([[-1.62, 1.085], [-1.70, 1.065]]),                          // engine-lid front edge (under the backlight)
        rrect(0.86, 0.850, 1.00, 0.872, 0.01)                             // fuel filler flap (front left wing)
      ],
      characterLines: [
        curve([[1.90, 0.780], [1.55, 0.818], [1.20, 0.845], [0.85, 0.880]]),      // front lid / wing-crown shut line (0.02 under the wing line)
        curve([[-0.55, 0.936], [-1.00, 0.920], [-1.45, 0.885], [-1.92, 0.830]]), // wide rear haunch shoulder
        curve([[0.70, 0.370], [0.00, 0.384], [-0.52, 0.398]])                    // lower door sculpt
      ],
      sill: rrect(-0.84, 0.160, 0.85, 0.185, 0.008),
      archF: { x: aF.x, y: aF.y, r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: aR.y, r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.60, 0.168, 'c'], [1.80, 0.167], [2.03, 0.146, 'c'], [2.105, 0.172, 'c'], [2.03, 0.188], [1.80, 0.200], [1.605, 0.206, 'c']]),
        loop([[-1.63, 0.170, 'c'], [-1.95, 0.168], [-2.22, 0.172, 'c'], [-2.275, 0.215, 'c'], [-1.95, 0.206], [-1.625, 0.212, 'c']])
      ]
    };

    var top = {
      // narrow waist at the door, pronounced rear haunches rolling into round tail corners
      body: sym([[XF, 0, 'v'], [2.183, 0.38], [2.12, 0.66], [2.02, 0.80], [1.90, 0.858], [1.55, 0.884], [1.20, 0.890, 'h'], [0.75, 0.874], [0.30, 0.860, 'h'],
        [-0.20, 0.863], [-0.60, 0.875], [-1.25, 0.926, 'h'], [-1.85, 0.905], [-2.12, 0.865], [-2.25, 0.800], [-2.305, 0.60], [XR, 0, 'v']], 1),
      // widest at the B-pillar; two monotone cubics per side (screen base → B-pillar → backlight)
      greenhouse: ghPlan911(),
      hood: sym([[2.12, 0, 'v'], [2.08, 0.40], [1.95, 0.52, 'c'], [0.82, 0.60, 'c'], [0.78, 0, 'v']], 1),
      roof: rpoly([[0.03, -0.55], [0.03, 0.55], [-0.84, 0.50], [-0.84, -0.50]], 0.07),
      deck: sym([[-1.62, 0, 'v'], [-1.62, 0.42, 'c'], [-2.22, 0.60, 'c'], [-2.26, 0, 'v']], 1),
      mirrors: pair(loop([[0.58, 0.872, 'c'], [0.555, 0.98], [0.50, 1.012], [0.41, 1.006], [0.38, 0.95], [0.385, 0.872, 'c']]), 1)
    };

    var hlC = [0.622, 0.740], hlRot = -8;   // upright oval: top (0.86) meets the wing crown (kept just under it so the low-LOD loft still catches the lamp)
    var front = {
      body: sym([[0, H, 'h'], [0.40, 1.285], [0.55, 1.236], [0.63, 1.08], [0.672, 0.955], [0.715, 0.875], [0.78, 0.860], [0.86, 0.80], [0.913, 0.68],
        [0.926, 0.56, 'v'], [0.92, 0.40], [0.88, 0.262], [0.82, 0.205, 'c'], [0.60, 0.15], [0, 0.13, 'h']], 0),
      greenhouse: sym([[0, 1.262, 'h'], [0.42, 1.25], [0.55, 1.20], [0.62, 1.07], [0.66, 0.94, 'c'], [0.36, 0.932], [0, 0.925, 'h']], 0),
      // bumper seam runs level at 0.56 under the lamps, then turns down the corner
      bumper: sym([[0, 0.56, 'h'], [0.42, 0.560], [0.80, 0.562], [0.895, 0.53], [0.918, 0.44], [0.89, 0.30], [0.82, 0.205, 'c'], [0.60, 0.15], [0, 0.13, 'h']], 0),
      // front lid low between the wings; wing crowns peak above it at the lamps
      characterLines: [
        // wing crowns at 0.86 (z ±0.55–0.78) with the windscreen base standing above them
        curve([[-0.80, 0.80], [-0.78, 0.855], [-0.665, 0.860, 'h'], [-0.55, 0.852], [-0.46, 0.76], [-0.40, 0.700], [0, 0.680, 'h'], [0.40, 0.700], [0.46, 0.76], [0.55, 0.852], [0.665, 0.860, 'h'], [0.78, 0.855], [0.80, 0.80]]),
        curve([[-0.40, 0.700], [-0.30, 0.800], [-0.20, 0.866]]),
        curve([[0.40, 0.700], [0.30, 0.800], [0.20, 0.866]])
      ],
      grille: [rpoly([[-0.33, 0.235], [0.33, 0.235], [0.295, 0.312], [-0.295, 0.312]], 0.025)],
      intakes: pair(rpoly([[0.42, 0.220], [0.78, 0.232], [0.80, 0.395], [0.45, 0.400]], 0.03), 0),
      headlights: pair(ellipse(hlC[0], hlC[1], 0.094, 0.120, hlRot), 0),
      drl: [].concat(
        // four-point DRL signature inside each oval headlamp (offsets turn with the lamp)
        [[0.050, 0.066, 50], [-0.050, 0.066, -50], [-0.050, -0.066, 50], [0.050, -0.066, -50]].reduce(function (acc, o) {
          var t = hlRot * Math.PI / 180, dz = o[0] * Math.cos(t) - o[1] * Math.sin(t), dy = o[0] * Math.sin(t) + o[1] * Math.cos(t);
          return acc.concat(pair(ellipse(hlC[0] + dz, hlC[1] + dy, 0.027, 0.010, o[2] + hlRot), 0));
        }, []),
        pair(rrect(0.44, 0.420, 0.80, 0.440, 0.008), 0)   // slim light strips above the side intakes
      ),
      splitter: rpoly([[-0.82, 0.13], [0.82, 0.13], [0.80, 0.152], [-0.80, 0.152]], 0.008),
      plateArea: rrect(-0.26, 0.33, 0.26, 0.445, 0.01),
      badgeArea: rrect(-0.06, 0.615, 0.06, 0.665, 0.01),
      badgeText: 'PORSCHE'
    };

    var rear = {
      // round hips: full width 0.55–0.80, curving in to the deck (0.80 at y 0.98, 0.62 at 1.04)
      body: sym([[0, H, 'h'], [0.42, 1.282], [0.56, 1.20], [0.59, 1.10], [0.62, 1.042], [0.72, 1.018], [0.80, 0.980], [0.875, 0.915], [0.915, 0.845], [0.926, 0.70, 'v'],
        [0.924, 0.55], [0.92, 0.42], [0.89, 0.28], [0.84, 0.215, 'c'], [0.60, 0.17], [0, 0.16, 'h']], 0),
      greenhouse: sym([[0, 1.255, 'h'], [0.40, 1.24], [0.51, 1.17], [0.545, 1.105], [0.52, 1.086, 'c'], [0, 1.080, 'h']], 0),
      bumper: sym([[0, 0.62, 'h'], [0.60, 0.62], [0.88, 0.58], [0.92, 0.42], [0.89, 0.28], [0.84, 0.215, 'c'], [0.60, 0.17], [0, 0.16, 'h']], 0),
      taillights: pair(loop([[0.60, 0.936, 'c'], [0.80, 0.938], [0.856, 0.924], [0.884, 0.880], [0.900, 0.846, 'c'], [0.80, 0.850], [0.62, 0.874, 'c']]), 0),
      lightBar: sym([[0, 0.930, 'h'], [0.62, 0.930, 'c'], [0.62, 0.885, 'c'], [0, 0.885, 'h']], 0),   // 45 mm full-width bar
      diffuser: sym([[0, 0.30, 'h'], [0.45, 0.30], [0.72, 0.27, 'c'], [0.70, 0.19], [0, 0.17, 'h']], 0),
      exhaust: [{ shape: 'oval', cx: 0.48, cy: 0.28, w: 0.18, h: 0.08 }, { shape: 'oval', cx: -0.48, cy: 0.28, w: 0.18, h: 0.08 }],
      plateArea: rrect(-0.26, 0.43, 0.26, 0.545, 0.01),
      badgeArea: rrect(-0.20, 0.838, 0.20, 0.866, 0.006),
      badgeText: 'PORSCHE',
      spoiler: sym([[0, 0.985, 'h'], [0.55, 0.985], [0.64, 0.958, 'c'], [0, 0.950, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.575, 0.982, 'c'], [0.566, 1.030], [0.48, 1.048], [0.400, 1.024], [0.402, 0.985], [0.49, 0.974]]), 'body'),
      D('side', 'trim', rpoly([[0.515, 0.950], [0.548, 0.950], [0.556, 0.980], [0.522, 0.980]], 0.004), 'body'),   // thin door-mounted mirror arm
      D('side', 'trim', rpoly([[-0.612, 0.950], [-0.598, 1.248], [-0.672, 1.244], [-0.678, 0.954]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.46, 0.80, -0.27, 0.824, 0.012), 'body'),
      D('side', 'trim', rrect(-1.745, 1.064, -1.695, 1.076, 0.004), 'light-red'),   // third brake light on the engine lid
      D('side', 'trim', teardrop(1.945, 0.712, 0.125, 0.048, -48), 'light'),
      D('side', 'trim', loop([[-2.25, 0.935, 'c'], [-2.306, 0.926], [-2.316, 0.850, 'c'], [-2.25, 0.858, 'c']]), 'light-red'),
      D('side', 'trim', rrect(-2.318, 0.40, -2.29, 0.42, 0.006), 'light-red'),
      D('top', 'fuelCap', rrect(0.86, -0.80, 1.00, -0.70, 0.012), 'body'),
            D('top', 'wiper', rrect(0.66, -0.05, 0.70, 0.55, 0.01), 'black'),
      D('top', 'trim', rrect(-2.300, -0.66, -2.272, 0.66, 0.008), 'light-red')
    ].concat(
      // engine-lid grille: nine longitudinal slats
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (k) { var z = -0.40 + k * 0.10; return D('top', 'vent', rrect(-2.15, z - 0.009, -1.70, z + 0.009, 0.006), 'gloss-black'); }),
      pairD('top', 'trim', ellipse(1.93, 0.64, 0.145, 0.085, -8), 'light', 1),
      pairD('front', 'mirror', loop([[0.66, 0.925, 'c'], [0.84, 0.94], [1.00, 0.95], [1.012, 0.995], [0.95, 1.025], [0.86, 1.02], [0.80, 0.968], [0.66, 0.958, 'c']]), 'body', 0),
      // five vertical active-flap slats in each side intake
      [0.49, 0.55, 0.61, 0.67, 0.73].reduce(function (acc, z) {
        return acc.concat(pairD('front', 'vent', rrect(z - 0.007, 0.240, z + 0.007, 0.385, 0.004), 'gloss-black', 0));
      }, []),
      [
        D('front', 'wiper', rpoly([[-0.05, 0.930], [0.55, 0.948], [0.55, 0.958], [-0.05, 0.942]], 0.004), 'black'),
        D('rear', 'vent', sym([[0, 1.05, 'h'], [0.42, 1.045], [0.46, 0.995, 'c'], [0, 0.99, 'h']], 0), 'gloss-black'),
        D('rear', 'trim', rrect(-0.10, 1.030, 0.10, 1.042, 0.005), 'light-red'),
        D('rear', 'trim', sym([[0, 0.884, 'h'], [0.60, 0.884, 'c'], [0.60, 0.876, 'c'], [0, 0.876, 'h']], 0), 'gloss-black')   // shadow under the floating light bar
      ],
      pairD('rear', 'trim', rrect(0.70, 0.40, 0.84, 0.42, 0.008), 'light-red', 0),
      // from behind only the outboard part of the mirror shows past the body
      pairD('rear', 'mirror', loop([[0.85, 0.95, 'c'], [1.00, 0.95], [1.012, 0.995], [0.95, 1.025], [0.85, 1.02, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.160, xWS: 0.70, xBL: -1.62,
      belt: [[0.70, 0.865], [0.56, 0.928], [0.10, 0.922], [-0.62, 0.950], [-0.95, 0.982], [-1.12, 1.026], [-1.25, 1.070], [-1.45, 1.080], [-1.62, 1.060]],
      // wing crowns stand proud of the front lid; the rear haunch crown sits wide and low
      crest: [[2.20, 0.40, 0.68], [2.10, 0.74, 0.84], [2.00, 0.80, 0.86], [1.80, 0.83, 0.83], [1.60, 0.835, 0.79], [1.20, 0.865, 0.76], [0.90, 0.895, 0.78], [0.70, 0.90, 0.82], [0.20, 0.91, 0.92],
        [-0.60, 0.93, 0.92], [-1.20, 0.95, 0.84], [-1.80, 0.95, 0.70], [-2.10, 0.93, 0.58], [-2.32, 0.88, 0.50]],
      dip: [[2.21, 0.0], [2.14, 0.08], [2.04, 0.15], [1.80, 0.16], [1.60, 0.14], [1.20, 0.09], [0.80, 0.025], [0.70, 0.0]],
      NV: 40, stations: 120
    });
    return {
      id: 'porsche-911-992', make: 'Porsche', name: '911 Carrera', gen: '992', years: '2019–', style: 'coupe', default: true,
      look: { head: 'oval-4pt', tail: 'light-bar', grille: 'slats' },   // renderer lamp / grille signature
      enginePosition: 'rear', drivetrain: 'rwd', powertrain: 'ice', ref: ref,
      wheel: { style: 'twin-5', spokes: 10, caliper: '#c8102e' },   // red Carrera S callipers
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Upright oval LED headlamps sitting on top of the front wings, each with a four-point DRL ring.',
        taillights: 'Full-width slim LED light bar spanning the tail, flared at the corners, with the vertical-slat engine-lid grille and third brake light above.',
        grille: 'No grille: three-part lower front intake with active vertical shutters behind slim light strips.',
        notes: 'Rear-engine flyline: roof descends in one continuous arc to a retracting ducktail spoiler; wide rear haunches; frameless doors; quarter-window tip follows the flyline.'
      }
    };
  }

  /* ================================================================== */
  /* BMW M4 Competition (G82)                                            */
  /* ================================================================== */
  function bmwM4() {
    var ref = {
      length: 4.794, width: 1.887, height: 1.393, wheelbase: 2.857, trackF: 1.617, trackR: 1.605,
      frontOverhang: 0.870, rearOverhang: 1.067, wheelDiameter_in: 20, wheelDiameterF_in: 19, wheelDiameterR_in: 20,
      tireF: '275/35ZR19', tireR: '285/30ZR20', groundClearance: 0.120, rideHeight: 0.120, cd: 0.34, curbWeight_kg: 1725
    };
    var XF = 2.2985, XR = -2.4955, H = 1.393;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.4285, y: rF, r: rF + 0.028, flare: 0.026 };
    var aR = { x: -1.4285, y: rR, r: rR + 0.030, flare: 0.030 };
    var yb = 0.170;

    var roofLine = [[0.66, 0.975, 'c'], [0.20, 1.190], [-0.15, 1.362], [-0.45, H, 'h'], [-1.00, 1.362], [-1.55, 1.245], [-1.98, 1.080, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.95, 0.172], [2.20, 0.132, 'c'], [2.275, 0.200], [XF, 0.34, 'v'], [2.294, 0.560], [2.282, 0.730], [2.250, 0.800],
      [2.200, 0.822], [2.04, 0.840], [1.70, 0.872], [1.20, 0.925]
    ].concat(roofLine, [
      [-2.20, 1.064], [-2.42, 1.052], [-2.44, 1.065, 'c'], [-2.472, 0.990, 'c'], [XR, 0.72, 'v'], [-2.486, 0.48], [-2.442, 0.30], [-2.36, 0.190, 'c'], [-2.05, yb, 'c']
    ]), 0.160);

    var doorGlass = [[0.52, 1.010, 'c'], [0.18, 1.190], [-0.15, 1.335], [-0.45, 1.363, 'h'], [-0.86, 1.348, 'c'], [-0.88, 1.045, 'c']];
    var side = {
      body: body,
      // daylight opening only: door glass + B-pillar + kinked quarter glass; roof and C-pillar stay body colour
      greenhouse: loop([[0.522, 1.004, 'c'], [0.181, 1.190], [-0.15, 1.337], [-0.45, 1.369, 'h'], [-0.93, 1.345], [-1.13, 1.322], [-1.29, 1.268], [-1.372, 1.205],
        [-1.395, 1.150, 'c'], [-1.472, 1.076, 'c'], [-1.30, 1.060], [-0.90, 1.037], [0.20, 1.002]]),
      windows: [
        loop(doorGlass),
        // quarter glass with the Hofmeister kink sweeping forward at its lower rear corner
        loop([[-0.930, 1.046, 'c'], [-0.925, 1.340, 'c'], [-1.12, 1.316], [-1.26, 1.262], [-1.33, 1.205], [-1.38, 1.145, 'c'], [-1.46, 1.080, 'c'], [-1.30, 1.068], [-1.10, 1.056]])
      ],
      pillars: [
        loop([[0.66, 0.975, 'c'], [0.20, 1.190], [-0.15, 1.362, 'c'], [-0.15, 1.335, 'c'], [0.18, 1.190], [0.52, 1.010, 'c']])
      ],
      doorCuts: [loop([[0.83, 0.262, 'c'], [0.822, 0.60], [0.765, 0.88], [0.64, 0.985]].concat(doorGlass, [[-0.96, 0.80], [-1.03, 0.272, 'c']]))],
      panelLines: [
        curve([[2.12, 0.765], [2.00, 0.550], [1.800, 0.400]]),            // front bumper / wing seam
        curve([[-1.86, 0.620], [-1.875, 0.46], [-1.90, 0.300]]),          // rear bumper seam just behind the arch
        curve([[-2.10, 0.862], [-2.30, 0.861], [-2.475, 0.858]]),         // bumper top seam under the lamps
        curve([[-1.99, 1.068], [-2.10, 1.042], [-2.32, 1.040], [-2.41, 1.025]]),   // boot-lid shut line
        curve([[2.21, 0.812], [1.50, 0.878], [0.80, 0.955]]),             // bonnet shut line
        rrect(-1.80, 0.84, -1.64, 0.96, 0.02)                              // fuel flap (right rear quarter)
      ],
      characterLines: [
        curve([[2.05, 0.780], [1.20, 0.838], [0.00, 0.874], [-1.20, 0.908], [-2.35, 0.930]]), // continuous shoulder line
        curve([[0.82, 0.420], [0.00, 0.452], [-0.80, 0.520], [-1.05, 0.560]])                 // rising lower swage
      ],
      sill: rrect(-1.04, 0.160, 1.04, 0.227, 0.012),
      archF: { x: aF.x, y: aF.y, r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: aR.y, r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.04, 0.160, 'c'], [-1.04, 0.160, 'c'], [-1.045, 0.183, 'c'], [1.045, 0.183, 'c']]),              // carbon side-skirt blade
        loop([[1.79, 0.173, 'c'], [1.95, 0.174], [2.20, 0.136, 'c'], [2.24, 0.156, 'c'], [1.95, 0.196], [1.795, 0.215, 'c']]),
        loop([[-1.80, 0.174, 'c'], [-2.05, 0.173], [-2.36, 0.194, 'c'], [-2.405, 0.240, 'c'], [-2.05, 0.212], [-1.795, 0.215, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.16, -0.58], [-0.16, 0.58], [-1.18, 0.55], [-1.18, -0.55]], 0.07);
    var top = {
      // blunt, square nose carrying the wide kidney face
      body: sym([[XF, 0, 'v'], [2.297, 0.46], [2.287, 0.80], [2.235, 0.880], [2.12, 0.912], [1.95, 0.928], [1.43, 0.935], [0.80, 0.912], [0.00, 0.905],
        [-0.90, 0.920], [-1.43, 0.9435, 'h'], [-1.95, 0.932], [-2.35, 0.88], [-2.47, 0.66], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.70, 0, 'v'], [0.62, 0.70, 'c'], [0.20, 0.712], [-0.70, 0.682], [-1.40, 0.642], [-1.88, 0.58], [-1.97, 0.40], [-1.98, 0, 'v']], 1),
      hood: sym([[2.18, 0, 'v'], [2.15, 0.55], [2.02, 0.72, 'c'], [0.70, 0.70, 'c'], [0.66, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.98, 0, 'v'], [-1.99, 0.60, 'c'], [-2.43, 0.72, 'c'], [-2.46, 0, 'v']], 1),
      mirrors: pair(loop([[0.56, 0.905, 'c'], [0.53, 1.00], [0.47, 1.036], [0.37, 1.03], [0.33, 0.97], [0.335, 0.905, 'c']]), 1),
      // bonnet creases running from the power dome forward to the kidneys
      characterLines: pair(curve([[2.17, 0.30], [1.60, 0.33], [0.95, 0.36], [0.72, 0.37]]), 1)
    };

    // tall kidneys (0.30 x 0.565, tops meeting the bonnet shut line), outer edges flaring out toward the bottom, 0.07 m apart
    var kidney = rpoly([[0.035, 0.850, 0.04], [0.300, 0.850, 0.05], [0.322, 0.800, 0.05], [0.338, 0.340, 0.04], [0.318, 0.285, 0.03], [0.040, 0.285, 0.03]], 0.04);
    var front = {
      body: sym([[0, H, 'h'], [0.44, 1.378], [0.60, 1.30], [0.68, 1.12], [0.74, 1.00], [0.86, 0.93], [0.925, 0.84],
        [0.9435, 0.62, 'v'], [0.935, 0.40], [0.90, 0.24], [0.84, 0.15, 'c'], [0.60, 0.13], [0, 0.12, 'h']], 0),
      greenhouse: sym([[0, 1.36, 'h'], [0.44, 1.345], [0.58, 1.28], [0.66, 1.10], [0.72, 0.99, 'c'], [0, 0.965, 'h']], 0),
      bumper: sym([[0, 0.60, 'h'], [0.40, 0.62], [0.80, 0.66], [0.92, 0.62], [0.935, 0.40], [0.90, 0.24], [0.84, 0.15, 'c'], [0.60, 0.13], [0, 0.12, 'h']], 0),
      characterLines: [
        curve([[-0.86, 0.90], [-0.66, 0.905, 'h'], [-0.40, 0.862], [0, 0.848, 'h'], [0.40, 0.862], [0.66, 0.905, 'h'], [0.86, 0.90]]),   // bonnet edge between the wings
        curve([[-0.32, 0.84], [-0.30, 0.90], [-0.26, 0.955]]),
        curve([[0.32, 0.84], [0.30, 0.90], [0.26, 0.955]])
      ],
      grille: pair(kidney, 0),
      // sharp-edged trapezoid outer intakes, each split by a horizontal bar (detail)
      intakes: pair(rpoly([[0.47, 0.24], [0.82, 0.24], [0.84, 0.36], [0.80, 0.53], [0.60, 0.49], [0.44, 0.34]], 0.015), 0).concat([
        rpoly([[-0.34, 0.16], [0.34, 0.16], [0.30, 0.255], [-0.30, 0.255]], 0.02)
      ], pair(rrect(0.86, 0.38, 0.90, 0.56, 0.012), 0)),   // vertical corner air curtains
      // hexagonal lamps: inner top meets the kidney top, outer top wraps the wing corner
      headlights: pair(rpoly([[0.36, 0.840], [0.89, 0.862], [0.908, 0.832], [0.88, 0.740], [0.60, 0.752], [0.38, 0.770]], 0.008), 0),
      drl: [].concat(
        // two vertical "L" DRL blades per lamp
        pair(rpoly([[0.465, 0.840], [0.495, 0.841], [0.495, 0.792], [0.525, 0.790], [0.525, 0.770], [0.465, 0.772]], 0.004), 0),
        pair(rpoly([[0.705, 0.849], [0.735, 0.850], [0.735, 0.800], [0.765, 0.798], [0.765, 0.775], [0.705, 0.778]], 0.004), 0)
      ),
      splitter: rpoly([[-0.86, 0.12], [0.86, 0.12], [0.88, 0.15], [-0.88, 0.15]], 0.008),
      plateArea: rrect(-0.26, 0.29, 0.26, 0.39, 0.01),
      badgeArea: rrect(-0.04, 0.848, 0.04, 0.888, 0.01),
      badgeText: 'BMW'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.44, 1.375], [0.56, 1.28], [0.64, 1.13], [0.78, 1.075], [0.89, 1.025], [0.937, 0.90], [0.9435, 0.66, 'v'],
        [0.935, 0.40], [0.89, 0.22], [0.82, 0.17, 'c'], [0, 0.16, 'h']], 0),
      greenhouse: sym([[0, 1.35, 'h'], [0.43, 1.335], [0.54, 1.25], [0.60, 1.12], [0.58, 1.08, 'c'], [0, 1.07, 'h']], 0),
      bumper: sym([[0, 0.74, 'h'], [0.60, 0.74], [0.90, 0.72], [0.94, 0.55], [0.935, 0.40], [0.89, 0.22], [0.82, 0.17, 'c'], [0, 0.16, 'h']], 0),
      panelLines: [curve([[-0.42, 0.945], [0, 0.940, 'h'], [0.42, 0.945]])],                     // boot-lid shut line between the lamps
      characterLines: [curve([[-0.92, 0.715], [-0.60, 0.742], [0, 0.748, 'h'], [0.60, 0.742], [0.92, 0.715]])],   // bumper step
      // large L-shaped lamps: slim inner leg on the boot lid, tall outer leg on the quarter
      taillights: pair(loop([[0.42, 1.015, 'c'], [0.84, 1.020], [0.912, 0.995], [0.925, 0.90], [0.915, 0.860, 'c'], [0.862, 0.866, 'c'], [0.845, 0.950], [0.76, 0.966], [0.44, 0.965, 'c']]), 0),
      diffuser: sym([[0, 0.36, 'h'], [0.30, 0.36], [0.68, 0.32, 'c'], [0.66, 0.17], [0, 0.16, 'h']], 0),
      exhaust: [0.40, 0.55, -0.40, -0.55].map(function (z) { return { shape: 'round', cx: z, cy: 0.25, w: 0.10, h: 0.10 }; }),
      plateArea: rrect(-0.26, 0.56, 0.26, 0.67, 0.01),
      badgeArea: rrect(-0.10, 0.880, 0.10, 0.915, 0.008),
      badgeText: 'BMW',
      spoiler: sym([[0, 1.065, 'h'], [0.55, 1.065], [0.70, 1.040, 'c'], [0, 1.030, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.56, 1.012, 'c'], [0.545, 1.085], [0.44, 1.102], [0.33, 1.07], [0.335, 1.02], [0.46, 1.004]]), 'body'),
      D('side', 'trim', rpoly([[-0.874, 1.040], [-0.855, 1.352], [-0.930, 1.344], [-0.936, 1.040]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.64, 0.860, -0.44, 0.884, 0.010), 'body'),
      D('side', 'vent', rpoly([[0.86, 0.600], [1.04, 0.625], [1.06, 0.660], [0.88, 0.635]], 0.010), 'black'),       // M gill blade, raked 8 deg
      D('side', 'trim', rpoly([[0.952, 0.606], [0.966, 0.608], [0.974, 0.652], [0.960, 0.650]], 0.002), 'body'),     // mid-length split bar
      D('side', 'grille', loop([[2.262, 0.800, 'c'], [2.287, 0.780], [2.296, 0.550], [2.292, 0.320], [2.280, 0.300, 'c'], [2.281, 0.550], [2.271, 0.760]]), 'grille'), // kidney edge
      D('side', 'trim', loop([[2.262, 0.770], [2.18, 0.808], [2.04, 0.822], [2.06, 0.786], [2.20, 0.768]]), 'light'),
      D('side', 'trim', loop([[-2.38, 1.000, 'c'], [-2.452, 0.998], [-2.475, 0.960], [-2.484, 0.900, 'c'], [-2.40, 0.905], [-2.38, 0.95, 'c']]), 'light-red'),
      D('side', 'trim', rrect(-2.40, 0.995, -2.22, 1.015, 0.006), 'light-red'),      // thin L-return along the boot shut line
      D('side', 'trim', rrect(-2.49, 0.40, -2.43, 0.47, 0.006), 'light-red'),
      D('top', 'trim', roofPlan, 'carbon'),                                                                         // CFRP roof
      D('top', 'trim', sym([[2.00, 0, 'v'], [1.98, 0.22], [0.80, 0.28], [0.72, 0, 'v']], 1), 'body'),          // bonnet power dome
      D('top', 'fuelCap', rrect(-1.80, 0.86, -1.64, 0.92, 0.012), 'body'),
      D('top', 'wiper', rrect(0.64, -0.05, 0.68, 0.60, 0.01), 'black'),
      D('top', 'trim', rrect(-2.49, -0.86, -2.45, 0.86, 0.008), 'light-red'),
      D('top', 'spoiler', rrect(-2.45, -0.62, -2.40, 0.62, 0.008), 'carbon')
    ].concat(
      // lamps wrap the square nose corners inside the plan outline
      pairD('top', 'trim', loop([[2.284, 0.42, 'c'], [2.255, 0.70], [2.205, 0.800, 'c'], [2.12, 0.852, 'c'], [2.168, 0.70], [2.198, 0.42, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.72, 0.975, 'c'], [0.86, 0.99], [1.02, 1.00], [1.036, 1.05], [0.97, 1.09], [0.88, 1.085], [0.83, 1.02], [0.72, 1.008, 'c']]), 'body', 0),
      // horizontal kidney slats; none behind the front plate (y 0.29–0.39)
      [0.410, 0.470, 0.530, 0.590, 0.650, 0.710, 0.770].reduce(function (acc, y) {
        return acc.concat(pairD('front', 'trim', rrect(0.06, y, 0.31, y + 0.012, 0.004), 'gloss-black', 0));
      }, []),
      [
        D('front', 'wiper', rpoly([[-0.05, 0.975], [0.58, 1.000], [0.58, 1.010], [-0.05, 0.987]], 0.004), 'black'),
        D('rear', 'trim', curve([[-0.70, 1.04], [0, 1.05], [0.70, 1.04]]), 'body')
      ],
      [0, 0.20, -0.20].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.17, z + 0.008, 0.34, 0.004), 'carbon'); }),   // diffuser fins
      pairD('rear', 'trim', rpoly([[0.46, 1.003], [0.86, 1.008], [0.902, 0.885], [0.888, 0.880], [0.848, 0.993], [0.46, 0.990]], 0.004), 'light', 0),
      pairD('rear', 'trim', rrect(0.845, 0.40, 0.875, 0.47, 0.008), 'light-red', 0),        // vertical bumper reflectors
      pairD('front', 'trim', rrect(0.48, 0.385, 0.80, 0.40, 0.004), 'gloss-black', 0),        // intake cross bar
      pairD('rear', 'mirror', loop([[0.946, 1.00, 'c'], [1.02, 1.00], [1.036, 1.05], [0.97, 1.09], [0.946, 1.085, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.160, xWS: 0.66, xBL: -1.98,
      belt: [[0.66, 0.975], [0.52, 1.005], [0.00, 1.015], [-0.90, 1.038], [-1.30, 1.064], [-1.40, 1.086], [-1.46, 1.11], [-1.70, 1.10], [-1.98, 1.08]],
      crest: [[2.30, 0.76, 0.80], [2.25, 0.81, 0.84], [2.10, 0.84, 0.86], [1.70, 0.87, 0.86], [1.20, 0.90, 0.86], [0.60, 0.93, 0.90], [-0.40, 0.95, 0.94],
        [-1.20, 0.98, 0.90], [-1.80, 1.00, 0.80], [-2.20, 1.02, 0.72], [-2.50, 0.96, 0.62]],
      dip: [[2.30, 0.0], [2.25, 0.03], [2.10, 0.05], [1.60, 0.05], [1.00, 0.03], [0.70, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'bmw-m4-g82', make: 'BMW', name: 'M4 Competition', gen: 'G82', years: '2021–', style: 'coupe',
      look: { head: 'slim-led', tail: 'slim', grille: 'kidney' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref,
      wheel: { style: 'y-spoke', spokes: 10, caliper: '#1e4fa0' },   // 826M-style Y-spoke forged wheel
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim angular LED headlamps reaching in to the top corners of the grille, each with two L-shaped DRL light guides.',
        taillights: 'Wrap-around L-shaped LED tail lamps with three-dimensional light guides, carbon lip spoiler on the boot lid.',
        grille: 'Tall vertical kidney grille with horizontal slats, extending down into the bumper, carrying the front plate.',
        notes: 'Long bonnet with power dome, Hofmeister kink at the C-pillar, CFRP roof, quad round tailpipes in a carbon diffuser, M gill vents behind the front wheels.'
      }
    };
  }

  /* ================================================================== */
  /* Toyota GR Supra 3.0 (A90)                                           */
  /* ================================================================== */
  function supraA90() {
    var ref = {
      length: 4.379, width: 1.854, height: 1.292, wheelbase: 2.470, trackF: 1.594, trackR: 1.589,
      frontOverhang: 0.990, rearOverhang: 0.919, wheelDiameter_in: 19,
      tireF: '255/35ZR19', tireR: '275/35ZR19', groundClearance: 0.125, rideHeight: 0.125, cd: 0.31, curbWeight_kg: 1520
    };
    var XF = 2.225, XR = -2.154, H = 1.292;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.235, y: rF, r: rF + 0.028, flare: 0.024 };
    var aR = { x: -1.235, y: rR, r: rR + 0.030, flare: 0.034 };
    var yb = 0.170;

    // cab-rearward: long bonnet, windscreen base well behind the front wheels
    var roofLine = [[0.45, 0.900, 'c'], [0.08, 1.105], [-0.27, 1.258], [-0.62, H, 'h'], [-1.05, 1.252], [-1.40, 1.160], [-1.60, 1.100], [-1.85, 1.068]];
    var body = sideBody(aF, aR, yb, yb, [
      [1.82, 0.152], [2.08, 0.142], [2.15, 0.160, 'c'], [2.205, 0.270], [XF, 0.380, 'c'], [2.18, 0.440], [2.00, 0.600], [1.80, 0.718],
      [1.55, 0.795], [1.28, 0.845, 'h'], [1.00, 0.852], [0.70, 0.870]
    ].concat(roofLine, [
      // integrated ducktail kick-up, then a near-vertical, slightly concave tail face
      [-1.975, 1.020, 'h'], [-2.08, 1.046, 'c'], [-2.150, 1.000, 'c'], [-2.136, 0.800], [-2.140, 0.560], [XR, 0.400, 'c'], [-2.12, 0.300], [-2.06, 0.192, 'c'], [-1.85, yb, 'c']
    ]), 0.165);

    var doorGlass = [[0.35, 0.940, 'c'], [0.05, 1.100], [-0.20, 1.205], [-0.63, 1.262, 'h'], [-0.91, 1.242, 'c'], [-0.93, 0.972, 'c']];
    var side = {
      body: body,
      // daylight opening only (door glass + B-pillar + quarter glass)
      greenhouse: loop([[0.356, 0.936, 'c'], [0.052, 1.104], [-0.20, 1.213], [-0.63, 1.270, 'h'], [-0.97, 1.243], [-1.20, 1.200], [-1.41, 1.118], [-1.57, 1.062, 'c'],
        [-1.50, 1.018], [-1.25, 0.990], [-0.95, 0.970], [-0.40, 0.955], [0.10, 0.945]]),
      windows: [
        loop(doorGlass),
        loop([[-0.98, 0.978, 'c'], [-0.97, 1.236, 'c'], [-1.20, 1.192], [-1.40, 1.110], [-1.55, 1.062, 'c'], [-1.50, 1.025], [-1.25, 0.998]])
      ],
      pillars: [
        loop([[0.45, 0.900, 'c'], [0.08, 1.105], [-0.27, 1.258, 'c'], [-0.20, 1.205, 'c'], [0.05, 1.100], [0.35, 0.940, 'c']])
      ],
      doorCuts: [loop([[0.74, 0.272, 'c'], [0.74, 0.60], [0.62, 0.840], [0.45, 0.915]].concat(doorGlass, [[-0.95, 0.75], [-0.86, 0.55], [-0.80, 0.272, 'c']]))],
      panelLines: [
        curve([[1.90, 0.640], [1.74, 0.500], [1.600, 0.370]]),            // front clip / wing seam
        curve([[-1.66, 0.620], [-1.675, 0.46], [-1.70, 0.300]]),          // rear bumper seam just behind the arch
        curve([[-1.90, 0.880], [-2.02, 0.879], [-2.138, 0.876]]),         // bumper top seam under the lamps
        curve([[-1.82, 1.058, 'c'], [-1.86, 1.000], [-2.03, 0.985], [-2.075, 1.035]]), // hatch shut line
        rrect(-1.75, 0.84, -1.61, 0.93, 0.02)                              // fuel flap (rear quarter)
      ],
      characterLines: [
        curve([[1.90, 0.630], [1.55, 0.772], [1.25, 0.828], [0.95, 0.836]]),     // tall front-wing crest
        curve([[0.75, 0.450], [0.00, 0.520], [-0.60, 0.640], [-0.95, 0.760]]),  // dramatic rising door sweep
        // rear-haunch crest rising above the beltline behind the door, up into the ducktail
        curve([[-0.60, 0.900], [-0.95, 0.945], [-1.25, 0.968], [-1.60, 1.000], [-2.00, 1.004]])
      ],
      sill: rrect(-0.84, 0.165, 0.85, 0.232, 0.012),
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) },
      lowerTrim: [
        loop([[1.59, 0.174, 'c'], [1.82, 0.156], [2.08, 0.140, 'c'], [2.13, 0.165, 'c'], [1.82, 0.182], [1.595, 0.205, 'c']]),
        loop([[-1.60, 0.175, 'c'], [-1.85, 0.174], [-2.06, 0.196, 'c'], [-2.12, 0.290], [-2.14, 0.360, 'c'], [-1.85, 0.270], [-1.595, 0.215, 'c']]),
        loop([[0.84, 0.165, 'c'], [-0.83, 0.165, 'c'], [-0.835, 0.186, 'c'], [0.845, 0.186, 'c']])
      ]
    };

    var roofPlan = rpoly([[-0.27, -0.53], [-0.27, 0.53], [-1.10, 0.48], [-1.10, -0.48]], 0.07);
    var top = {
      body: sym([[XF, 0, 'v'], [2.21, 0.22], [2.14, 0.50], [1.98, 0.76], [1.62, 0.895], [1.25, 0.905], [0.75, 0.870], [0.00, 0.858],
        [-0.70, 0.890], [-1.24, 0.927, 'h'], [-1.70, 0.914], [-2.00, 0.880], [-2.12, 0.800], [-2.148, 0.56], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.48, 0, 'v'], [0.43, 0.66, 'c'], [0.05, 0.652], [-0.70, 0.58], [-1.25, 0.50], [-1.62, 0.40], [-1.76, 0.26], [-1.79, 0, 'v']], 1),
      hood: sym([[2.15, 0, 'v'], [2.10, 0.38], [1.90, 0.60, 'c'], [0.52, 0.64, 'c'], [0.49, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.80, 0, 'v'], [-1.81, 0.48, 'c'], [-2.07, 0.62, 'c'], [-2.10, 0, 'v']], 1),
      mirrors: pair(loop([[0.44, 0.852, 'c'], [0.41, 0.96], [0.35, 1.006], [0.27, 1.00], [0.24, 0.94], [0.245, 0.852, 'c']]), 1),
      // double-bubble: shallow 0.10 m channel between two roof crowns
      characterLines: pair(curve([[-0.30, 0.050], [-0.70, 0.052], [-1.06, 0.050]]), 1)
    };

    var front = {
      // double-bubble roof: a shallow central dip between two crowns
      body: sym([[0, 1.264, 'h'], [0.24, H, 'h'], [0.44, 1.265], [0.56, 1.14], [0.62, 0.98], [0.70, 0.885], [0.80, 0.86], [0.88, 0.79],
        [0.92, 0.66], [0.927, 0.54, 'v'], [0.91, 0.36], [0.86, 0.22], [0.78, 0.15, 'c'], [0.55, 0.14], [0, 0.135, 'h']], 0),
      greenhouse: sym([[0, 1.236, 'h'], [0.24, 1.262, 'h'], [0.42, 1.24], [0.54, 1.12], [0.60, 0.96], [0.64, 0.90, 'c'], [0, 0.885, 'h']], 0),
      // pointed centre beak
      bumper: sym([[0, 0.60, 'c'], [0.20, 0.552], [0.40, 0.520], [0.62, 0.560], [0.85, 0.600], [0.91, 0.50], [0.915, 0.36], [0.86, 0.22], [0.78, 0.15, 'c'], [0.55, 0.14], [0, 0.135, 'h']], 0),
      // bonnet sunk deep between tall wings
      characterLines: [
        curve([[-0.84, 0.80], [-0.66, 0.840, 'h'], [-0.50, 0.785], [-0.42, 0.740], [0, 0.720, 'h'], [0.42, 0.740], [0.50, 0.785], [0.66, 0.840, 'h'], [0.84, 0.80]]),
        curve([[-0.42, 0.740], [-0.36, 0.82], [-0.30, 0.880]]),
        curve([[0.42, 0.740], [0.36, 0.82], [0.30, 0.880]])
      ],
      grille: [rpoly([[-0.49, 0.15], [0.49, 0.15], [0.44, 0.38], [-0.44, 0.38]], 0.03)],
      // tall vertical corner "fangs", inner edge raked 15 deg
      intakes: pair(rpoly([[0.64, 0.16], [0.78, 0.165], [0.85, 0.24], [0.86, 0.50], [0.731, 0.50]], 0.025), 0),
      headlights: pair(loop([[0.40, 0.66, 'c'], [0.55, 0.715], [0.75, 0.750], [0.866, 0.758, 'c'], [0.893, 0.70], [0.880, 0.628, 'c'], [0.70, 0.620], [0.52, 0.632]]), 0),
      drl: pair(rpoly([[0.46, 0.632], [0.862, 0.628], [0.876, 0.742], [0.862, 0.742], [0.849, 0.642], [0.46, 0.645]], 0.004), 0),
      splitter: rpoly([[-0.80, 0.135], [0.80, 0.135], [0.82, 0.16], [-0.82, 0.16]], 0.008),
      plateArea: rrect(-0.26, 0.24, 0.26, 0.35, 0.01),
      badgeArea: rrect(-0.05, 0.545, 0.05, 0.585, 0.01),
      badgeText: 'TOYOTA'
    };

    var rear = {
      body: sym([[0, 1.264, 'h'], [0.24, H, 'h'], [0.44, 1.262], [0.52, 1.15], [0.60, 1.085], [0.80, 1.060], [0.92, 0.95], [0.927, 0.75, 'v'],
        [0.92, 0.44], [0.87, 0.25], [0.80, 0.19, 'c'], [0, 0.18, 'h']], 0),
      greenhouse: sym([[0, 1.236, 'h'], [0.24, 1.258, 'h'], [0.40, 1.235], [0.48, 1.14], [0.50, 1.08, 'c'], [0, 1.07, 'h']], 0),
      bumper: sym([[0, 0.62, 'h'], [0.55, 0.620], [0.86, 0.615], [0.922, 0.54], [0.92, 0.44], [0.87, 0.25], [0.80, 0.19, 'c'], [0, 0.18, 'h']], 0),
      // slim lamp under the ducktail with a downturned outer leg wrapping the corner
      taillights: pair(loop([[0.46, 0.955, 'c'], [0.66, 0.968], [0.86, 0.995], [0.912, 0.975], [0.918, 0.900], [0.880, 0.890, 'c'], [0.84, 0.935], [0.64, 0.940, 'c']]), 0),
      diffuser: sym([[0, 0.34, 'h'], [0.22, 0.34], [0.62, 0.30, 'c'], [0.60, 0.19], [0, 0.18, 'h']], 0),
      exhaust: [{ shape: 'round', cx: 0.42, cy: 0.26, w: 0.10, h: 0.10 }, { shape: 'round', cx: -0.42, cy: 0.26, w: 0.10, h: 0.10 }],
      plateArea: rrect(-0.26, 0.47, 0.26, 0.58, 0.01),
      badgeArea: rrect(-0.15, 0.74, 0.15, 0.78, 0.008),
      badgeText: 'SUPRA',
      // ducktail overhanging the lamps, full width
      spoiler: sym([[0, 1.040, 'h'], [0.62, 1.040], [0.72, 1.020, 'c'], [0.70, 1.000, 'c'], [0, 1.000, 'h']], 0)
    };

    var details = [
      D('side', 'mirror', loop([[0.44, 0.945, 'c'], [0.425, 1.020], [0.33, 1.040], [0.24, 1.008], [0.245, 0.955], [0.35, 0.937]]), 'body'),
      D('side', 'trim', rpoly([[-0.925, 0.968], [-0.905, 1.246], [-0.975, 1.238], [-0.985, 0.974]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.75, 0.870, -0.57, 0.890, 0.010), 'body'),
      D('side', 'vent', rpoly([[0.83, 0.50], [0.95, 0.52], [0.93, 0.66], [0.84, 0.62]], 0.015), 'gloss-black'),
      D('side', 'vent', rpoly([[-0.86, 0.44], [-0.68, 0.46], [-0.74, 0.60], [-0.84, 0.64]], 0.02), 'gloss-black'),
      D('side', 'trim', teardrop(1.925, 0.580, 0.14, 0.030, -30), 'light'),
      D('side', 'trim', loop([[-2.02, 0.992, 'c'], [-2.140, 0.988], [-2.138, 0.925, 'c'], [-2.03, 0.955, 'c']]), 'light-red'),
      D('top', 'fuelCap', rrect(-1.75, -0.91, -1.61, -0.85, 0.012), 'body'),
      D('top', 'wiper', rrect(0.44, -0.05, 0.48, 0.56, 0.01), 'black'),
      D('top', 'spoiler', rrect(-2.10, -0.62, -2.06, 0.62, 0.01), 'body'),
      D('top', 'trim', rrect(-2.150, -0.74, -2.12, 0.74, 0.008), 'light-red'),
      D('front', 'wiper', rpoly([[-0.05, 0.890], [0.55, 0.915], [0.55, 0.925], [-0.05, 0.902]], 0.004), 'black'),
      D('rear', 'trim', rrect(-0.02, 0.25, 0.02, 0.32, 0.006), 'light-red')   // centre rear fog lamp in the diffuser
    ].concat(
      pairD('top', 'trim', rpoly([[-0.31, 0.07], [-0.31, 0.38], [-1.05, 0.36], [-1.05, 0.07]], 0.06), 'body', 1),   // twin roof crowns
      pairD('top', 'vent', rpoly([[1.80, 0.22], [1.86, 0.36], [1.62, 0.38], [1.58, 0.24]], 0.02), 'gloss-black', 1),
      pairD('top', 'trim', teardrop(1.94, 0.625, 0.235, 0.05, -47.6), 'light', 1),   // swept teardrop lamp (1.78, 0.80) → (2.10, 0.45)
      [0.58, 0.66, 0.74].reduce(function (acc, z) { return acc.concat(pairD('front', 'trim', ellipse(z, 0.688 + (z - 0.58) * 0.15, 0.022, 0.022, 0), 'light', 0)); }, []),
      pairD('front', 'vent', rpoly([[0.20, 0.79], [0.36, 0.80], [0.36, 0.815], [0.20, 0.805]], 0.004), 'gloss-black', 0),
      pairD('front', 'mirror', loop([[0.63, 0.905, 'c'], [0.84, 0.92], [0.99, 0.93], [1.006, 0.975], [0.94, 1.01], [0.86, 1.005], [0.80, 0.955], [0.63, 0.94, 'c']]), 'body', 0),
      pairD('rear', 'vent', rpoly([[0.80, 0.30], [0.88, 0.30], [0.90, 0.50], [0.83, 0.50]], 0.01), 'black', 0),
      pairD('rear', 'trim', rpoly([[0.55, 0.951], [0.85, 0.972], [0.895, 0.952], [0.885, 0.946], [0.845, 0.963], [0.55, 0.943]], 0.003), 'light', 0),
      pairD('rear', 'mirror', loop([[0.929, 0.93, 'c'], [0.99, 0.93], [1.006, 0.975], [0.94, 1.01], [0.929, 1.005, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.45, xBL: -1.80,
      belt: [[0.45, 0.900], [0.36, 0.935], [0.10, 0.945], [-0.40, 0.955], [-0.95, 0.970], [-1.25, 0.990], [-1.55, 1.040], [-1.80, 1.050]],
      crest: [[2.22, 0.38, 0.60], [2.00, 0.60, 0.70], [1.60, 0.80, 0.72], [1.28, 0.845, 0.72], [0.80, 0.86, 0.80], [0.20, 0.90, 0.90],
        [-0.60, 0.92, 0.92], [-1.25, 0.975, 0.90], [-1.60, 1.04, 0.84], [-1.85, 1.05, 0.76], [-2.15, 0.98, 0.58]],
      dip: [[2.23, 0.0], [2.12, 0.05], [1.90, 0.10], [1.40, 0.11], [0.90, 0.06], [0.45, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'toyota-gr-supra-a90', make: 'Toyota', name: 'GR Supra', gen: 'A90', years: '2019–', style: 'coupe',
      look: { head: 'projector-twin', tail: 'slim', grille: 'honeycomb' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', ref: ref,
      wheel: { style: 'double-5', spokes: 10, caliper: '#c8102e' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Swept headlamps with a triple LED projector cluster and an L-shaped DRL running along the lower edge.',
        taillights: 'Slim wrap-around LED tail lamps under an integrated ducktail spoiler; F1-style centre fog lamp in the diffuser.',
        grille: 'Pointed central nose over a wide hexagonal lower intake, flanked by tall corner intakes.',
        notes: 'Double-bubble roof, long bonnet with twin faux vents, very tall front wings, cab-rearward stance, short tail with huge rear haunches and blacked-out side vents ahead of each wheel.'
      }
    };
  }

  /* ------------------------------------------------------------------ */
  var list = [porsche911(), bmwM4(), supraA90()];
  list.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { models: list };
})();

/* ==========================================================================
   FORGE Atelier — js/shapes/models/pack-jdm.js
   JDM drift pack: real-car shape models
     - Nissan Silvia Spec-R (S15, 1999–2002)                 style 'coupe'
     - Nissan Skyline GT-R V-Spec (BNR34, 1999–2002)          style 'coupe'
     - Toyota Sprinter Trueno GT-APEX 3-door (AE86, 1983–87)  style 'hatchback'
     - Mazda RX-7 Type R (FD3S, 1999 spec, 1991–2002)         style 'coupe'
     - Nissan GT-R (R35, 2017 facelift)                       style 'coupe'
   None of them is a style default. coupe.js marks the 911 as the coupe
   default; hatchback.js has no default flag, so its first registered model
   is the hatchback default: load this pack AFTER hatchback.js.

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top view = (x, z); front & rear views = (z, y).

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}. Body
   surfaces are smooth G1 cubic splines through hand-placed landmarks taken
   from published dimensions and reference photography. Brand names are text
   only: no manufacturer logo artwork is drawn; badgeArea marks where a text
   badge goes.

   Pop-up headlamps (AE86, FD3S): the views show the lamps retracted (the
   normal parked look; the slim bumper parking/turn lamps are the visible
   `headlights`). The raised lamp pods are carried in the extra slots
   front.popupLamps / side.popupLamps / top.popupLamps (paint 'light' faces +
   'body' lids) so a renderer can draw them up at night; fit() remaps them
   like any other slot and renderers that do not know the slot ignore it.

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


  function arches(aF, aR, yb) {
    return {
      archF: { x: aF.x, y: r4(aF.y), r: r4(aF.r), flare: aF.flare, path: archLip(aF, yb, aF.flare) },
      archR: { x: aR.x, y: r4(aR.y), r: r4(aR.r), flare: aR.flare, path: archLip(aR, yb, aR.flare) }
    };
  }
  function ext(o, more) { for (var k in more) o[k] = more[k]; return o; }
  function circ(cx, cy, r) { return ellipse(cx, cy, r, r, 0); }
  /* Annulus-free lamp ring: a thin crescent band drawn as two concentric rings is not supported by every
     renderer, so rings are expressed as a smaller concentric disc of a darker paint (drawn on top). */
  function ringPair(view, cz, cy, r, paint) { return pairD(view, 'light', circ(cz, cy, r), paint, 0); }

  /* ================================================================== */
  /* Nissan Silvia Spec-R (S15)                                          */
  /* ================================================================== */
  function silviaS15() {
    var ref = {
      length: 4.445, width: 1.695, height: 1.285, wheelbase: 2.525, trackF: 1.480, trackR: 1.470,
      frontOverhang: 0.905, rearOverhang: 1.015, wheelDiameter_in: 16,
      tireF: '205/55R16', tireR: '205/55R16', groundClearance: 0.125, rideHeight: 0.125, cd: 0.30, curbWeight_kg: 1250
    };
    var XF = 2.1675, XR = -2.2775, H = 1.285;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.2625, y: rF, r: rF + 0.034, flare: 0.020 };
    var aR = { x: -1.2625, y: rR, r: rR + 0.034, flare: 0.022 };
    var yb = 0.170;

    // fast-raked screen, roof peak over the B-pillar, long C-pillar into a short notch deck
    var roofLine = [[0.52, 0.870, 'c'], [0.22, 1.045], [-0.05, 1.222], [-0.38, H, 'h'], [-0.80, 1.262], [-1.20, 1.180], [-1.55, 1.068], [-1.80, 0.992, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.75, 0.168], [2.05, 0.152, 'c'], [2.135, 0.220], [XF, 0.400, 'v'], [2.155, 0.500], [2.105, 0.578],
      // low wedge: swept lamps sit in the leading edge of the bonnet, which climbs straight to the scuttle
      [1.95, 0.650], [1.70, 0.712], [1.30, 0.772], [0.90, 0.828]
    ].concat(roofLine, [
      [-2.05, 0.988], [-2.225, 0.978, 'c'], [-2.266, 0.900], [XR, 0.700, 'v'], [-2.272, 0.450], [-2.252, 0.280], [-2.205, 0.192], [-2.10, yb, 'c'], [-1.85, yb, 'c']
    ]), 0.165);

    var doorGlass = [[0.38, 0.905, 'c'], [0.15, 1.040], [-0.06, 1.180], [-0.38, 1.235, 'h'], [-0.70, 1.218, 'c'], [-0.72, 0.930, 'c']];
    var quarterGlass = [[-0.77, 0.935, 'c'], [-0.765, 1.212, 'c'], [-1.00, 1.160], [-1.20, 1.090], [-1.36, 1.020, 'c'], [-1.15, 0.975], [-0.95, 0.948]];
    var side = ext({
      body: body,
      greenhouse: loop([[0.385, 0.900, 'c'], [0.152, 1.044], [-0.06, 1.188], [-0.38, 1.243, 'h'], [-0.765, 1.222], [-1.00, 1.168], [-1.20, 1.097], [-1.375, 1.018, 'c'],
        [-1.15, 0.968], [-0.95, 0.942], [-0.60, 0.925], [0.10, 0.910]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.52, 0.870, 'c'], [0.22, 1.045], [-0.05, 1.222, 'c'], [-0.06, 1.180, 'c'], [0.15, 1.040], [0.38, 0.905, 'c']])],
      doorCuts: [loop([[0.64, 0.24, 'c'], [0.64, 0.55], [0.60, 0.78], [0.52, 0.862]].concat(doorGlass, [[-0.78, 0.80], [-0.76, 0.25, 'c']]))],
      panelLines: [
        curve([[1.86, 0.676], [1.72, 0.47], [1.585, 0.330]]),             // front bumper / wing seam
        curve([[-1.64, 0.700], [-1.655, 0.48], [-1.68, 0.300]]),          // rear bumper seam behind the arch
        curve([[-1.83, 0.982], [-2.00, 0.974], [-2.20, 0.962], [-2.258, 0.880]]),   // boot-lid shut line
        // bonnet shut line: leaves the top-rear corner of the lamp and runs parallel to the wing top to the scuttle (no crossing of the shoulder line)
        curve([[1.84, 0.672], [1.50, 0.731], [1.10, 0.783], [0.66, 0.832]]),
        rrect(-1.82, 0.80, -1.68, 0.89, 0.02)                              // fuel flap (right rear quarter)
      ],
      characterLines: [
        // one crisp shoulder line from the lamp tail to the tail lamp, rising gently
        curve([[1.83, 0.640], [1.40, 0.700], [0.70, 0.768], [0.00, 0.800], [-1.00, 0.836], [-1.90, 0.870], [-2.24, 0.878]]),
        curve([[0.62, 0.400], [0.00, 0.418], [-0.72, 0.438]])          // lower door sculpt
      ],
      sill: rrect(-0.90, 0.165, 0.90, 0.215, 0.010),
      lowerTrim: [
        loop([[1.60, 0.172, 'c'], [1.75, 0.170], [2.05, 0.155, 'c'], [2.10, 0.185, 'c'], [1.75, 0.198], [1.605, 0.212, 'c']]),
        loop([[-1.62, 0.172, 'c'], [-1.85, 0.171], [-2.20, 0.195, 'c'], [-2.24, 0.240, 'c'], [-1.85, 0.208], [-1.615, 0.214, 'c']])
      ]
    }, arches(aF, aR, yb));

    var roofPlan = rpoly([[-0.05, -0.56], [-0.05, 0.56], [-1.10, 0.52], [-1.10, -0.52]], 0.07);
    var top = {
      // pointed wedge nose, straight flanks, rounded tail corners
      body: sym([[XF, 0, 'v'], [2.155, 0.30], [2.10, 0.55], [2.00, 0.72], [1.80, 0.815], [1.40, 0.843], [1.00, 0.8475, 'h'], [0.50, 0.836], [0.00, 0.832, 'h'],
        [-0.60, 0.836], [-1.26, 0.8475, 'h'], [-1.80, 0.836], [-2.10, 0.800], [-2.24, 0.700], [-2.274, 0.45], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.55, 0, 'v'], [0.50, 0.60, 'c'], [0.10, 0.655], [-0.70, 0.665], [-1.30, 0.620], [-1.72, 0.520], [-1.80, 0.35], [-1.81, 0, 'v']], 1),
      hood: sym([[2.10, 0, 'v'], [2.06, 0.40], [1.95, 0.62, 'c'], [0.58, 0.66, 'c'], [0.54, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.83, 0, 'v'], [-1.84, 0.55, 'c'], [-2.22, 0.66, 'c'], [-2.25, 0, 'v']], 1),
      mirrors: pair(loop([[0.45, 0.832, 'c'], [0.42, 0.93], [0.36, 0.965], [0.28, 0.96], [0.25, 0.90], [0.255, 0.832, 'c']]), 1),
      characterLines: pair(curve([[2.06, 0.42], [1.50, 0.50], [0.90, 0.56], [0.60, 0.58]]), 1)   // bonnet edge creases
    };

    var front = {
      body: sym([[0, H, 'h'], [0.38, 1.272], [0.52, 1.20], [0.60, 1.05], [0.66, 0.92], [0.72, 0.850], [0.80, 0.800], [0.835, 0.700],
        [0.8475, 0.55, 'v'], [0.840, 0.400], [0.810, 0.270], [0.750, 0.190, 'c'], [0.55, 0.150], [0, 0.140, 'h']], 0),
      greenhouse: sym([[0, 1.255, 'h'], [0.38, 1.245], [0.50, 1.18], [0.58, 1.03], [0.62, 0.90, 'c'], [0.30, 0.885], [0, 0.880, 'h']], 0),
      bumper: sym([[0, 0.570, 'h'], [0.30, 0.552], [0.60, 0.556], [0.80, 0.540], [0.835, 0.45], [0.810, 0.270], [0.750, 0.190, 'c'], [0.55, 0.150], [0, 0.140, 'h']], 0),
      characterLines: [
        curve([[-0.80, 0.79], [-0.70, 0.80, 'h'], [-0.45, 0.760], [0, 0.745, 'h'], [0.45, 0.760], [0.70, 0.80, 'h'], [0.80, 0.79]]),   // bonnet leading edge
        curve([[-0.30, 0.752], [-0.26, 0.82], [-0.22, 0.882]]),
        curve([[0.30, 0.752], [0.26, 0.82], [0.22, 0.882]])
      ],
      // small upper slot under the nose badge + big lower mouth
      grille: [
        rpoly([[-0.28, 0.500], [0.28, 0.500], [0.24, 0.548], [-0.24, 0.548]], 0.018),
        rpoly([[-0.50, 0.215], [0.50, 0.215], [0.46, 0.440], [-0.46, 0.440]], 0.045)
      ],
      intakes: pair(rpoly([[0.57, 0.220], [0.75, 0.232], [0.79, 0.380], [0.61, 0.395]], 0.025), 0),
      // swept, angular lamps: thin pointed inner end by the slot, tall outer end wrapping into the wing
      headlights: pair(rpoly([[0.30, 0.585], [0.58, 0.640], [0.80, 0.712], [0.838, 0.680], [0.826, 0.585], [0.60, 0.560], [0.34, 0.556]], 0.012), 0),
      drl: [].concat(
        pair(circ(0.48, 0.590, 0.030), 0),             // low-beam projector
        pair(ellipse(0.69, 0.625, 0.050, 0.038, 12), 0)   // high-beam reflector
      ),
      fogLights: pair(ellipse(0.665, 0.300, 0.050, 0.030, 0), 0),
      splitter: { path: rpoly([[-0.76, 0.140], [0.76, 0.140], [0.74, 0.160], [-0.74, 0.160]], 0.008), paint: 'black' },
      plateArea: rrect(-0.165, 0.270, 0.165, 0.435, 0.010),
      badgeArea: rrect(-0.050, 0.555, 0.050, 0.588, 0.010),
      badgeText: 'NISSAN'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.36, 1.270], [0.48, 1.180], [0.56, 1.060], [0.64, 1.000], [0.76, 0.975], [0.83, 0.920], [0.8475, 0.75, 'v'],
        [0.845, 0.550], [0.830, 0.400], [0.800, 0.260], [0.750, 0.190, 'c'], [0, 0.170, 'h']], 0),
      greenhouse: sym([[0, 1.240, 'h'], [0.34, 1.230], [0.46, 1.140], [0.53, 1.030], [0.52, 1.000, 'c'], [0, 0.995, 'h']], 0),
      bumper: sym([[0, 0.620, 'h'], [0.55, 0.620], [0.80, 0.600], [0.840, 0.500], [0.830, 0.400], [0.800, 0.260], [0.750, 0.190, 'c'], [0, 0.170, 'h']], 0),
      panelLines: [curve([[-0.36, 0.955], [0, 0.950, 'h'], [0.36, 0.955]])],
      // angular wedge lamps: top follows the deck, the lower edge tapers in toward the plate
      taillights: pair(rpoly([[0.36, 0.930], [0.80, 0.942], [0.840, 0.900], [0.832, 0.800], [0.66, 0.782], [0.40, 0.858]], 0.012), 0),
      diffuser: sym([[0, 0.270, 'h'], [0.40, 0.270], [0.62, 0.240, 'c'], [0.60, 0.180], [0, 0.170, 'h']], 0),
      // single oval tailpipe on the left (JDM)
      exhaust: [{ shape: 'oval', cx: -0.50, cy: 0.250, w: 0.120, h: 0.075 }],
      plateArea: rrect(-0.165, 0.645, 0.165, 0.810, 0.010),
      badgeArea: rrect(-0.15, 0.862, 0.15, 0.890, 0.006),
      // Spec-R boot wing on two stalks
      spoiler: sym([[0, 1.045, 'h'], [0.60, 1.045], [0.66, 1.025, 'c'], [0.64, 1.008, 'c'], [0, 1.008, 'h']], 0),
      badgeText: 'SILVIA'
    };

    var details = [
      D('side', 'mirror', loop([[0.43, 0.905, 'c'], [0.42, 0.970], [0.34, 0.985], [0.26, 0.960], [0.265, 0.915], [0.35, 0.900]]), 'body'),
      D('side', 'trim', rpoly([[-0.715, 0.928], [-0.700, 1.222], [-0.765, 1.215], [-0.772, 0.932]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.56, 0.780, -0.39, 0.802, 0.010), 'body'),
      D('side', 'light', loop([[2.105, 0.578, 'c'], [1.95, 0.640], [1.80, 0.672, 'c'], [1.84, 0.628], [2.06, 0.560, 'c']]), 'light'),   // lamp wrap
      D('side', 'marker', rrect(1.62, 0.628, 1.68, 0.645, 0.006), 'light-amber'),                      // fender repeater, below the shoulder line
      D('side', 'light', loop([[-2.18, 0.942, 'c'], [-2.262, 0.930], [-2.270, 0.800, 'c'], [-2.22, 0.830]]), 'light-red'),
      D('side', 'spoiler', loop([[-1.96, 1.040, 'c'], [-2.22, 1.045], [-2.25, 1.030, 'c'], [-2.20, 1.008], [-1.98, 1.020, 'c']]), 'body'),
      D('side', 'spoiler', rpoly([[-2.13, 0.985], [-2.10, 0.985], [-2.12, 1.020], [-2.15, 1.020]], 0.004), 'body'),   // stalk
      D('side', 'marker', rrect(-2.27, 0.40, -2.25, 0.43, 0.006), 'light-red'),
      D('top', 'wiper', rrect(0.56, -0.05, 0.60, 0.55, 0.01), 'black'),
      D('top', 'fuelCap', rrect(-1.82, 0.78, -1.68, 0.84, 0.012), 'body'),
      D('top', 'spoiler', rrect(-2.24, -0.66, -2.19, 0.66, 0.012), 'body'),
      D('top', 'trim', rrect(-2.280, -0.80, -2.252, -0.36, 0.008), 'light-red'),
      D('top', 'trim', rrect(-2.280, 0.36, -2.252, 0.80, 0.008), 'light-red'),
      D('front', 'wiper', rpoly([[-0.05, 0.885], [0.52, 0.905], [0.52, 0.915], [-0.05, 0.897]], 0.004), 'black'),
      D('front', 'trim', rrect(0.185, 0.322, 0.46, 0.336, 0.004), 'gloss-black'),   // mouth cross bar, stops either side of the level centre plate
      D('front', 'trim', rrect(-0.46, 0.322, -0.185, 0.336, 0.004), 'gloss-black'),
      D('rear', 'light', rrect(-0.10, 1.012, 0.10, 1.024, 0.004), 'light-red'),      // high-mount stop lamp in the wing
      D('rear', 'trim', rrect(-0.30, 0.20, 0.30, 0.24, 0.01), 'black')
    ].concat(
      pairD('top', 'light', loop([[2.10, 0.55, 'c'], [2.00, 0.72], [1.86, 0.80, 'c'], [1.84, 0.70], [1.98, 0.50, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.62, 0.900, 'c'], [0.80, 0.912], [0.93, 0.920], [0.945, 0.965], [0.88, 0.995], [0.80, 0.990], [0.75, 0.940], [0.62, 0.932, 'c']]), 'body', 0),
      pairD('front', 'light', rpoly([[0.79, 0.600], [0.825, 0.598], [0.830, 0.640], [0.80, 0.650]], 0.004), 'light-amber', 0),   // indicator in the lamp tail
      pairD('front', 'vent', rrect(0.08, 0.512, 0.24, 0.522, 0.003), 'gloss-black', 0),
      // inner clear reverse section of each tail lamp; lamp facets
      pairD('rear', 'light', rpoly([[0.38, 0.922], [0.52, 0.926], [0.52, 0.880], [0.42, 0.858]], 0.006), 'light', 0),
      pairD('rear', 'trim', rpoly([[0.53, 0.928], [0.545, 0.928], [0.545, 0.838], [0.53, 0.842]], 0.002), 'gloss-black', 0),
      pairD('rear', 'spoiler', rrect(0.40, 0.975, 0.43, 1.010, 0.004), 'body', 0),    // wing stalks
      pairD('rear', 'marker', rrect(0.70, 0.40, 0.80, 0.42, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.86, 0.90, 'c'], [0.93, 0.92], [0.945, 0.965], [0.88, 0.995], [0.86, 0.99, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.52, xBL: -1.80,
      belt: [[0.52, 0.870], [0.38, 0.905], [0.10, 0.910], [-0.60, 0.925], [-0.95, 0.942], [-1.15, 0.968], [-1.375, 1.018], [-1.55, 1.020], [-1.80, 0.990]],
      crest: [[2.17, 0.40, 0.60], [2.00, 0.63, 0.70], [1.60, 0.735, 0.74], [1.20, 0.785, 0.78], [0.80, 0.825, 0.84], [0.40, 0.85, 0.90], [-0.60, 0.87, 0.92],
        [-1.30, 0.90, 0.88], [-1.80, 0.935, 0.80], [-2.10, 0.945, 0.70], [-2.28, 0.90, 0.55]],
      dip: [[2.17, 0.0], [2.10, 0.03], [1.90, 0.05], [1.50, 0.05], [1.00, 0.03], [0.55, 0.0]],
      NV: 40, stations: 110
    });

    return {
      id: 'nissan-silvia-s15', make: 'Nissan', name: 'Silvia Spec-R', gen: 'S15', years: '1999–2002', style: 'coupe',
      look: { head: 'projector-twin', tail: 'slim', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', doors: 2, ref: ref,
      color: '#d9dadb', colorName: 'Sparkling Silver',
      wheel: { style: '5-spoke', spokes: 5, caliper: '#2b2d30' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Swept-back angular projector headlamps set into the bonnet leading edge, thin pointed inner end, tall outer end wrapping into the wing.',
        taillights: 'Wedge-shaped wrap-around tail lamps whose lower edge tapers in toward the boot-lid plate recess, clear inner reverse sections.',
        grille: 'No upper grille: a slim slot under the nose badge and a large lower mouth with the plate, flanked by fog-lamp ducts.',
        notes: 'Short wedge nose, fast screen, long C-pillar into a short notch deck with the Spec-R boot wing; SR20DET turbo four, six-speed manual, helical LSD; single oval tailpipe on the left.'
      },
      sources: ['Nissan Silvia S15 Spec-R catalogue: 4445 x 1695 x 1285 mm, wheelbase 2525 mm, tread 1480/1470 mm, 205/55R16']
    };
  }

  /* ================================================================== */
  /* Nissan Skyline GT-R V-Spec (BNR34)                                  */
  /* ================================================================== */
  function skylineR34() {
    var ref = {
      length: 4.600, width: 1.785, height: 1.360, wheelbase: 2.665, trackF: 1.480, trackR: 1.490,
      frontOverhang: 0.995, rearOverhang: 0.940, wheelDiameter_in: 18,
      tireF: '245/40ZR18', tireR: '245/40ZR18', groundClearance: 0.135, rideHeight: 0.135, cd: 0.34, curbWeight_kg: 1560
    };
    var XF = 2.3275, XR = -2.2725, H = 1.360;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.3325, y: rF, r: rF + 0.032, flare: 0.028 };
    var aR = { x: -1.3325, y: rR, r: rR + 0.032, flare: 0.034 };
    var yb = 0.180;

    // upright, square: tall blunt nose, flat bonnet, upright screen, flat roof, short tall boot
    var roofLine = [[0.62, 0.885, 'c'], [0.30, 1.070], [0.02, 1.300], [-0.30, H, 'h'], [-0.85, 1.350], [-1.25, 1.265], [-1.55, 1.130], [-1.78, 1.045, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.90, 0.180], [2.22, 0.160, 'c'], [2.298, 0.240], [XF, 0.420, 'v'], [2.322, 0.580], [2.292, 0.660], [2.225, 0.722],
      [2.00, 0.756], [1.60, 0.790], [1.20, 0.826], [0.85, 0.860]
    ].concat(roofLine, [
      [-2.00, 1.038], [-2.20, 1.028, 'c'], [-2.256, 0.970], [XR, 0.750, 'v'], [-2.268, 0.500], [-2.242, 0.300], [-2.182, 0.200], [-2.05, yb, 'c'], [-1.80, yb, 'c']
    ]), 0.170);

    var doorGlass = [[0.47, 0.920, 'c'], [0.22, 1.070], [-0.02, 1.255], [-0.30, 1.310, 'h'], [-0.72, 1.300, 'c'], [-0.74, 0.965, 'c']];
    var quarterGlass = [[-0.80, 0.968, 'c'], [-0.795, 1.292, 'c'], [-1.00, 1.258], [-1.18, 1.185], [-1.30, 1.115, 'c'], [-1.12, 1.020], [-0.96, 0.985]];
    var side = ext({
      body: body,
      greenhouse: loop([[0.475, 0.915, 'c'], [0.222, 1.074], [-0.02, 1.263], [-0.30, 1.318, 'h'], [-0.795, 1.300], [-1.00, 1.266], [-1.18, 1.192], [-1.315, 1.112, 'c'],
        [-1.12, 1.012], [-0.96, 0.978], [-0.60, 0.960], [0.10, 0.935]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.62, 0.885, 'c'], [0.30, 1.070], [0.02, 1.300, 'c'], [-0.02, 1.255, 'c'], [0.22, 1.070], [0.47, 0.920, 'c']])],
      doorCuts: [loop([[0.76, 0.26, 'c'], [0.76, 0.60], [0.70, 0.82], [0.60, 0.878]].concat(doorGlass, [[-0.80, 0.80], [-0.78, 0.27, 'c']]))],
      panelLines: [
        curve([[2.05, 0.745], [1.92, 0.50], [1.72, 0.365]]),             // front bumper / wing seam
        curve([[-1.72, 0.720], [-1.73, 0.50], [-1.76, 0.320]]),          // rear bumper seam
        curve([[-1.80, 1.040], [-2.00, 1.033], [-2.215, 1.018], [-2.258, 0.900]]),   // boot-lid shut line
        curve([[2.20, 0.722], [1.60, 0.780], [0.90, 0.848]]),            // bonnet shut line
        rrect(-1.86, 0.86, -1.71, 0.97, 0.02)                             // fuel flap
      ],
      characterLines: [
        // crisp full-length belt crease
        curve([[2.15, 0.700], [1.50, 0.760], [0.60, 0.800], [-0.60, 0.830], [-1.60, 0.870], [-2.22, 0.900]]),
        // blistered rear over-fender edge
        curve([[-0.90, 0.420], [-0.94, 0.62], [-1.02, 0.760], [-1.12, 0.810]]),
        curve([[0.80, 0.400], [0.00, 0.410], [-0.80, 0.420]])
      ],
      sill: rrect(-0.96, 0.170, 0.96, 0.235, 0.012),
      lowerTrim: [
        loop([[0.96, 0.170, 'c'], [-0.96, 0.170, 'c'], [-0.965, 0.192, 'c'], [0.965, 0.192, 'c']]),             // side skirt
        loop([[1.70, 0.182, 'c'], [1.90, 0.182], [2.22, 0.162, 'c'], [2.265, 0.190, 'c'], [1.90, 0.210], [1.705, 0.225, 'c']]),
        loop([[-1.70, 0.183, 'c'], [-2.05, 0.182], [-2.182, 0.202, 'c'], [-2.22, 0.250, 'c'], [-2.05, 0.222], [-1.695, 0.225, 'c']])
      ]
    }, arches(aF, aR, yb));

    var roofPlan = rpoly([[0.00, -0.59], [0.00, 0.59], [-1.05, 0.56], [-1.05, -0.56]], 0.07);
    var top = {
      // boxy plan, blunt square nose, flared wings front and rear
      body: sym([[XF, 0, 'v'], [2.322, 0.40], [2.28, 0.70], [2.18, 0.840], [1.95, 0.885], [1.33, 0.8925, 'h'], [0.60, 0.873], [0.00, 0.870, 'h'],
        [-0.70, 0.875], [-1.33, 0.8925, 'h'], [-1.95, 0.880], [-2.20, 0.820], [-2.265, 0.620], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.64, 0, 'v'], [0.58, 0.64, 'c'], [0.20, 0.685], [-0.70, 0.690], [-1.30, 0.655], [-1.72, 0.580], [-1.78, 0.40], [-1.79, 0, 'v']], 1),
      hood: sym([[2.25, 0, 'v'], [2.22, 0.50], [2.12, 0.70, 'c'], [0.68, 0.70, 'c'], [0.64, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.80, 0, 'v'], [-1.81, 0.62, 'c'], [-2.22, 0.72, 'c'], [-2.25, 0, 'v']], 1),
      mirrors: pair(loop([[0.53, 0.872, 'c'], [0.50, 0.97], [0.44, 1.005], [0.35, 1.00], [0.32, 0.94], [0.325, 0.872, 'c']]), 1),
      characterLines: pair(curve([[2.20, 0.34], [1.60, 0.36], [0.95, 0.38], [0.70, 0.38]]), 1)
    };

    var front = {
      body: sym([[0, H, 'h'], [0.42, 1.345], [0.56, 1.27], [0.64, 1.10], [0.70, 0.95], [0.76, 0.890], [0.85, 0.850], [0.885, 0.760],
        [0.8925, 0.58, 'v'], [0.885, 0.400], [0.860, 0.260], [0.800, 0.190, 'c'], [0.55, 0.165], [0, 0.160, 'h']], 0),
      greenhouse: sym([[0, 1.330, 'h'], [0.42, 1.318], [0.54, 1.25], [0.62, 1.08], [0.66, 0.94, 'c'], [0.30, 0.925], [0, 0.920, 'h']], 0),
      bumper: sym([[0, 0.630, 'h'], [0.40, 0.630], [0.80, 0.632], [0.875, 0.600], [0.885, 0.400], [0.860, 0.260], [0.800, 0.190, 'c'], [0.55, 0.165], [0, 0.160, 'h']], 0),
      characterLines: [
        curve([[-0.86, 0.84], [-0.72, 0.85, 'h'], [-0.45, 0.790], [0, 0.778, 'h'], [0.45, 0.790], [0.72, 0.85, 'h'], [0.86, 0.84]]),
        curve([[-0.36, 0.785], [-0.32, 0.85], [-0.26, 0.925]]),
        curve([[0.36, 0.785], [0.32, 0.85], [0.26, 0.925]])
      ],
      // small upper grille between the lamps + full-width lower intercooler mouth
      grille: [
        rpoly([[-0.30, 0.638], [0.30, 0.638], [0.285, 0.715], [-0.285, 0.715]], 0.015),
        rpoly([[-0.62, 0.215], [0.62, 0.215], [0.60, 0.445], [-0.60, 0.445]], 0.035)
      ],
      intakes: pair(rpoly([[0.68, 0.235], [0.82, 0.245], [0.845, 0.420], [0.70, 0.440]], 0.020), 0),
      // slim angular lamps: inner end tapering down to the grille, outer end wrapping the wing
      headlights: pair(rpoly([[0.31, 0.662], [0.52, 0.705], [0.82, 0.740], [0.872, 0.705], [0.862, 0.650], [0.60, 0.640], [0.33, 0.640]], 0.010), 0),
      drl: [].concat(
        pair(circ(0.62, 0.680, 0.030), 0),                       // projector low beam
        pair(ellipse(0.78, 0.698, 0.045, 0.030, 8), 0)          // high-beam reflector
      ),
      splitter: { path: rpoly([[-0.86, 0.160], [0.86, 0.160], [0.84, 0.185], [-0.84, 0.185]], 0.008), paint: 'carbon' },   // V-Spec carbon chin
      plateArea: rrect(-0.165, 0.460, 0.165, 0.620, 0.010),
      badgeArea: rrect(-0.060, 0.660, 0.060, 0.695, 0.010),
      badgeText: 'GT-R'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.40, 1.345], [0.52, 1.26], [0.58, 1.12], [0.66, 1.050], [0.80, 1.030], [0.875, 0.980], [0.8925, 0.80, 'v'],
        [0.890, 0.550], [0.880, 0.400], [0.850, 0.260], [0.800, 0.200, 'c'], [0, 0.180, 'h']], 0),
      greenhouse: sym([[0, 1.320, 'h'], [0.38, 1.310], [0.50, 1.22], [0.56, 1.10], [0.55, 1.065, 'c'], [0, 1.060, 'h']], 0),
      bumper: sym([[0, 0.700, 'h'], [0.55, 0.700], [0.84, 0.690], [0.885, 0.600], [0.880, 0.400], [0.850, 0.260], [0.800, 0.200, 'c'], [0, 0.180, 'h']], 0),
      panelLines: [curve([[-0.80, 0.995], [0, 0.990, 'h'], [0.80, 0.995]])],
      // the four round tail lamps
      taillights: [].concat(pair(circ(0.430, 0.905, 0.083), 0), pair(circ(0.690, 0.905, 0.083), 0)),
      diffuser: sym([[0, 0.300, 'h'], [0.40, 0.300], [0.70, 0.270, 'c'], [0.68, 0.190], [0, 0.180, 'h']], 0),
      // single large round tailpipe on the left
      exhaust: [{ shape: 'round', cx: -0.52, cy: 0.270, w: 0.115, h: 0.115 }],
      plateArea: rrect(-0.165, 0.720, 0.165, 0.885, 0.010),
      badgeArea: rrect(-0.12, 0.945, 0.12, 0.975, 0.006),
      // adjustable rear wing on tall stalks
      spoiler: sym([[0, 1.150, 'h'], [0.66, 1.150], [0.72, 1.130, 'c'], [0.70, 1.100, 'c'], [0, 1.100, 'h']], 0),
      badgeText: 'GT-R'
    };

    var details = [
      D('side', 'mirror', loop([[0.52, 0.925, 'c'], [0.51, 0.995], [0.42, 1.010], [0.33, 0.985], [0.335, 0.935], [0.43, 0.918]]), 'body'),
      D('side', 'trim', rpoly([[-0.735, 0.962], [-0.720, 1.300], [-0.795, 1.293], [-0.802, 0.967]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.60, 0.840, -0.42, 0.862, 0.010), 'body'),
      D('side', 'vent', rpoly([[0.86, 0.560], [1.02, 0.585], [1.00, 0.680], [0.88, 0.660]], 0.012), 'gloss-black'),   // functional wing vent
      D('side', 'light', loop([[2.29, 0.665, 'c'], [2.18, 0.712], [2.06, 0.726, 'c'], [2.10, 0.690], [2.26, 0.650, 'c']]), 'light'),
      D('side', 'marker', rrect(2.24, 0.30, 2.30, 0.33, 0.006), 'light-amber'),
      D('side', 'intake', rpoly([[2.10, 0.22], [2.26, 0.23], [2.30, 0.42], [2.14, 0.42]], 0.02), 'grille'),   // brake duct in the bumper corner
      D('side', 'light', loop([[-2.12, 0.990, 'c'], [-2.255, 0.980], [-2.262, 0.830, 'c'], [-2.15, 0.860]]), 'light-red'),
      D('side', 'spoiler', loop([[-1.94, 1.100, 'c'], [-2.22, 1.150], [-2.26, 1.135, 'c'], [-2.22, 1.100], [-1.98, 1.095, 'c']]), 'body'),
      D('side', 'spoiler', rpoly([[-2.08, 1.030], [-2.04, 1.030], [-2.08, 1.105], [-2.12, 1.105]], 0.004), 'body'),
      D('top', 'wiper', rrect(0.66, -0.05, 0.70, 0.60, 0.01), 'black'),
      D('top', 'vent', rpoly([[2.12, -0.16], [2.12, 0.16], [1.92, 0.12], [1.92, -0.12]], 0.02), 'gloss-black'),   // bonnet duct
      D('top', 'fuelCap', rrect(-1.86, 0.84, -1.71, 0.89, 0.012), 'body'),
      D('top', 'spoiler', rrect(-2.25, -0.72, -2.15, 0.72, 0.015), 'body'),
      D('top', 'trim', rrect(-2.275, -0.80, -2.250, 0.80, 0.008), 'light-red'),
      D('front', 'wiper', rpoly([[-0.05, 0.925], [0.56, 0.945], [0.56, 0.955], [-0.05, 0.937]], 0.004), 'black'),
      D('front', 'trim', rrect(-0.60, 0.325, 0.60, 0.340, 0.004), 'gloss-black'),
      D('rear', 'trim', rrect(-0.40, 0.205, 0.40, 0.235, 0.008), 'carbon')
    ].concat(
      pairD('top', 'light', loop([[2.29, 0.56, 'c'], [2.24, 0.80], [2.14, 0.86, 'c'], [2.17, 0.70], [2.24, 0.42, 'c']]), 'light', 1),
      pairD('front', 'mirror', loop([[0.66, 0.940, 'c'], [0.84, 0.952], [0.98, 0.960], [0.995, 1.005], [0.93, 1.035], [0.85, 1.030], [0.80, 0.980], [0.66, 0.972, 'c']]), 'body', 0),
      pairD('front', 'marker', rrect(0.70, 0.455, 0.84, 0.480, 0.006), 'light-amber', 0),   // corner indicators
      [0.665, 0.690].reduce(function (acc, y) { return acc.concat([D('front', 'vent', rrect(-0.27, y, 0.27, y + 0.008, 0.003), 'gloss-black')]); }, []),
      // concentric inner rings in each round lamp
      ringPair('rear', 0.430, 0.905, 0.042, 'gloss-black'), ringPair('rear', 0.690, 0.905, 0.042, 'gloss-black'),
      ringPair('rear', 0.430, 0.905, 0.028, 'light-red'), ringPair('rear', 0.690, 0.905, 0.028, 'light-red'),
      [0.0, 0.18, -0.18].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.185, z + 0.008, 0.30, 0.004), 'carbon'); }),   // V-Spec diffuser fins
      pairD('rear', 'spoiler', rrect(0.50, 1.030, 0.54, 1.100, 0.004), 'body', 0),
      pairD('rear', 'marker', rrect(0.72, 0.45, 0.84, 0.47, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.895, 0.94, 'c'], [0.98, 0.96], [0.995, 1.005], [0.93, 1.035], [0.895, 1.03, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.170, xWS: 0.62, xBL: -1.78,
      belt: [[0.62, 0.885], [0.47, 0.920], [0.10, 0.935], [-0.60, 0.960], [-0.96, 0.978], [-1.12, 1.012], [-1.315, 1.112], [-1.55, 1.07], [-1.78, 1.04]],
      crest: [[2.33, 0.42, 0.62], [2.20, 0.72, 0.74], [1.80, 0.775, 0.78], [1.33, 0.82, 0.82], [0.80, 0.855, 0.86], [0.30, 0.88, 0.92], [-0.60, 0.90, 0.94],
        [-1.33, 0.94, 0.92], [-1.80, 0.99, 0.86], [-2.10, 1.00, 0.78], [-2.27, 0.95, 0.62]],
      dip: [[2.33, 0.0], [2.25, 0.03], [2.10, 0.05], [1.60, 0.05], [1.00, 0.03], [0.65, 0.0]],
      NV: 40, stations: 110
    });

    return {
      id: 'nissan-skyline-gtr-r34', make: 'Nissan', name: 'Skyline GT-R V-Spec', gen: 'BNR34', years: '1999–2002', style: 'coupe',
      look: { head: 'projector-twin', tail: 'quad-round', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice', doors: 2, ref: ref,
      color: '#1f4fa8', colorName: 'Bayside Blue',
      wheel: { style: '5-spoke', spokes: 10, caliper: '#c9a227' },   // twin-spoke 18s, gold Brembo callipers
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Slim angular projector headlamps tapering down into a small upper grille, outer ends wrapping the square wings.',
        taillights: 'Four round tail lamps (two per side), each with a concentric inner ring, high on a square tail.',
        grille: 'Small upper grille with the badge between the lamps, plate on the bumper, full-width lower intercooler mouth with brake ducts, carbon V-Spec chin.',
        notes: 'Upright boxy two-door, flat bonnet with duct, blistered rear over-fenders, functional wing vents behind the front wheels, adjustable wing on tall stalks, carbon V-Spec rear diffuser, single big tailpipe on the left; RB26DETT twin-turbo, ATTESA E-TS AWD.'
      },
      sources: ['Nissan BNR34 Skyline GT-R V-Spec catalogue: 4600 x 1785 x 1360 mm, wheelbase 2665 mm, tread 1480/1490 mm, 245/40ZR18, 1560 kg']
    };
  }

  /* ================================================================== */
  /* Toyota Sprinter Trueno GT-APEX 3-door (AE86)                        */
  /* ================================================================== */
  function truenoAE86() {
    var ref = {
      length: 4.205, width: 1.625, height: 1.335, wheelbase: 2.400, trackF: 1.355, trackR: 1.345,
      frontOverhang: 0.815, rearOverhang: 0.990, wheelDiameter_in: 14,
      tireF: '185/60R14', tireR: '185/60R14', groundClearance: 0.155, rideHeight: 0.155, cd: 0.35, curbWeight_kg: 940
    };
    var XF = 2.015, XR = -2.190, H = 1.335;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.200, y: rF, r: rF + 0.036, flare: 0.016 };
    var aR = { x: -1.200, y: rR, r: rR + 0.036, flare: 0.016 };
    var yb = 0.200;

    // sharp wedge nose under the pop-up lamp lids, boxy glasshouse, long liftback slope
    var roofLine = [[0.50, 0.858, 'c'], [0.22, 1.030], [-0.02, 1.255], [-0.25, 1.326], [-0.55, H, 'h'], [-0.85, 1.320], [-1.15, 1.250], [-1.50, 1.150], [-1.85, 1.050], [-2.05, 0.990], [-2.13, 0.958, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.56, 0.205], [1.88, 0.200, 'c'], [1.975, 0.250], [XF, 0.400, 'v'], [2.005, 0.490], [1.975, 0.555], [1.945, 0.615],
      [1.70, 0.676], [1.30, 0.738], [0.90, 0.798], [0.62, 0.838]
    ].concat(roofLine, [
      [-2.168, 0.900], [XR, 0.700, 'v'], [-2.186, 0.500], [-2.160, 0.300], [-2.100, 0.212], [-1.95, yb, 'c'], [-1.75, yb, 'c']
    ]), 0.195);

    var doorGlass = [[0.38, 0.885, 'c'], [0.17, 1.020], [-0.05, 1.218], [-0.30, 1.290, 'h'], [-0.62, 1.300, 'c'], [-0.64, 0.915, 'c']];
    // big quarter glass running back along the liftback slope
    var quarterGlass = [[-0.70, 0.918, 'c'], [-0.695, 1.296, 'c'], [-0.90, 1.282], [-1.15, 1.212], [-1.45, 1.124], [-1.70, 1.045, 'c'], [-1.45, 0.995], [-1.10, 0.950]];
    var side = ext({
      body: body,
      greenhouse: loop([[0.385, 0.880, 'c'], [0.172, 1.024], [-0.05, 1.226], [-0.30, 1.298, 'h'], [-0.695, 1.303], [-0.90, 1.290], [-1.15, 1.220], [-1.45, 1.132], [-1.715, 1.044, 'c'],
        [-1.45, 0.987], [-1.10, 0.942], [-0.60, 0.908], [0.10, 0.890]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.50, 0.858, 'c'], [0.22, 1.030], [-0.02, 1.255, 'c'], [-0.05, 1.218, 'c'], [0.17, 1.020], [0.38, 0.885, 'c']])],
      doorCuts: [loop([[0.60, 0.30, 'c'], [0.60, 0.62], [0.55, 0.80], [0.48, 0.852]].concat(doorGlass, [[-0.70, 0.80], [-0.68, 0.30, 'c']]))],
      panelLines: [
        curve([[2.010, 0.470], [1.85, 0.468], [1.66, 0.462]]),           // front bumper top
        curve([[-2.186, 0.480], [-1.95, 0.478], [-1.76, 0.472]]),        // rear bumper top
        curve([[-1.98, 1.000], [-2.06, 0.930], [-2.168, 0.880]]),        // hatch lower edge under the glass
        curve([[1.945, 0.612], [1.72, 0.668]]),                           // pop-up lid front edge
        curve([[1.72, 0.668], [1.70, 0.640], [1.60, 0.656]]),             // pop-up lid rear edge
        rrect(-1.62, 0.80, -1.50, 0.88, 0.015)                             // fuel flap
      ],
      characterLines: [
        curve([[1.92, 0.600], [1.20, 0.700], [0.00, 0.760], [-1.20, 0.800], [-2.15, 0.840]]),   // straight belt crease
        curve([[0.90, 0.520], [0.00, 0.525], [-0.90, 0.530]])
      ],
      sill: rrect(-0.88, 0.195, 0.88, 0.230, 0.008),
      lowerTrim: [
        rrect(-0.88, 0.450, 0.88, 0.482, 0.008),          // black body-side protection moulding
        rrect(1.52, 0.452, 2.010, 0.482, 0.008),
        rrect(-2.186, 0.452, -1.52, 0.482, 0.008),
        loop([[1.56, 0.205, 'c'], [1.88, 0.200], [1.97, 0.240, 'c'], [1.88, 0.250], [1.57, 0.255, 'c']]),
        loop([[-1.56, 0.205, 'c'], [-1.95, 0.202], [-2.10, 0.214, 'c'], [-2.12, 0.255, 'c'], [-1.95, 0.252], [-1.56, 0.255, 'c']])
      ],
      // raised pop-up pod (lamp face + lid) for night drawing
      popupLamps: [
        { path: rpoly([[1.95, 0.612], [1.94, 0.740], [1.74, 0.760], [1.72, 0.668]], 0.008), paint: 'body' },
        { path: rpoly([[1.952, 0.625], [1.962, 0.730], [1.950, 0.732], [1.940, 0.628]], 0.003), paint: 'light' }
      ]
    }, arches(aF, aR, yb));

    var roofPlan = rpoly([[-0.05, -0.56], [-0.05, 0.56], [-0.95, 0.55], [-0.95, -0.55]], 0.06);
    var top = {
      body: sym([[XF, 0, 'v'], [2.010, 0.35], [1.980, 0.62], [1.90, 0.760], [1.70, 0.800], [1.20, 0.8125, 'h'], [0.50, 0.806], [0.00, 0.805, 'h'],
        [-0.60, 0.806], [-1.20, 0.8125, 'h'], [-1.80, 0.806], [-2.08, 0.772], [-2.17, 0.650], [-2.188, 0.400], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.52, 0, 'v'], [0.47, 0.58, 'c'], [0.10, 0.625], [-0.70, 0.630], [-1.40, 0.600], [-1.95, 0.530], [-2.06, 0.35], [-2.08, 0, 'v']], 1),
      hood: sym([[1.96, 0, 'v'], [1.94, 0.45], [1.86, 0.66, 'c'], [0.55, 0.64, 'c'], [0.52, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-2.03, 0, 'v'], [-2.04, 0.55, 'c'], [-2.13, 0.62, 'c'], [-2.15, 0, 'v']], 1),
      mirrors: pair(loop([[0.42, 0.805, 'c'], [0.40, 0.890], [0.35, 0.925], [0.27, 0.920], [0.25, 0.860], [0.255, 0.805, 'c']]), 1),
      popupLamps: pair(rpoly([[1.93, 0.40], [1.93, 0.74], [1.73, 0.74], [1.73, 0.40]], 0.015), 1)
    };

    var front = {
      body: sym([[0, H, 'h'], [0.40, 1.320], [0.52, 1.25], [0.58, 1.10], [0.63, 0.95], [0.68, 0.870], [0.76, 0.800], [0.80, 0.720],
        [0.8125, 0.55, 'v'], [0.810, 0.400], [0.800, 0.280], [0.770, 0.210, 'c'], [0.55, 0.195], [0, 0.190, 'h']], 0),
      greenhouse: sym([[0, 1.305, 'h'], [0.40, 1.295], [0.50, 1.23], [0.56, 1.08], [0.60, 0.92, 'c'], [0.30, 0.875], [0, 0.870, 'h']], 0),
      // separate full-width bumper bar
      bumper: sym([[0, 0.470, 'h'], [0.70, 0.470], [0.80, 0.460], [0.812, 0.40], [0.800, 0.280], [0.770, 0.210, 'c'], [0.55, 0.195], [0, 0.190, 'h']], 0),
      characterLines: [
        curve([[-0.79, 0.72], [-0.70, 0.705], [-0.40, 0.632], [0, 0.620, 'h'], [0.40, 0.632], [0.70, 0.705], [0.79, 0.72]]),   // nose / lid edge
        curve([[-0.36, 0.632], [-0.36, 0.700]]), curve([[0.36, 0.632], [0.36, 0.700]])                                          // lid side seams
      ],
      // Trueno: no grille, a slim black slatted panel across the nose between the parking lamps
      grille: [rpoly([[-0.36, 0.500], [0.36, 0.500], [0.35, 0.585], [-0.35, 0.585]], 0.010)],
      intakes: pair(rpoly([[0.22, 0.250], [0.56, 0.250], [0.56, 0.300], [0.22, 0.300]], 0.010), 0),
      // with the pop-ups closed the visible front lamps are the wide clear parking / turn units
      headlights: pair(rpoly([[0.375, 0.500], [0.72, 0.500], [0.79, 0.525], [0.78, 0.590], [0.375, 0.590]], 0.010), 0),
      drl: pair(rrect(0.40, 0.512, 0.58, 0.578, 0.006), 0),
      splitter: { path: rpoly([[-0.72, 0.190], [0.72, 0.190], [0.70, 0.210], [-0.70, 0.210]], 0.006), paint: 'black' },
      plateArea: rrect(-0.165, 0.290, 0.165, 0.455, 0.010),
      badgeArea: rrect(-0.06, 0.598, 0.06, 0.615, 0.005),
      badgeText: 'TRUENO',
      // raised twin-lamp pods: lid face (body) + rectangular sealed-beam pair (light)
      popupLamps: [].concat(
        pair(rrect(0.37, 0.620, 0.74, 0.770, 0.012), 0).map(function (p) { return { path: p, paint: 'body' }; }),
        pair(rrect(0.39, 0.640, 0.54, 0.750, 0.010), 0).map(function (p) { return { path: p, paint: 'light' }; }),
        pair(rrect(0.57, 0.640, 0.72, 0.750, 0.010), 0).map(function (p) { return { path: p, paint: 'light' }; })
      )
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.40, 1.320], [0.50, 1.24], [0.56, 1.10], [0.64, 0.980], [0.74, 0.930], [0.80, 0.860], [0.8125, 0.70, 'v'],
        [0.810, 0.500], [0.800, 0.300], [0.770, 0.215, 'c'], [0, 0.200, 'h']], 0),
      greenhouse: sym([[0, 1.300, 'h'], [0.38, 1.290], [0.48, 1.20], [0.54, 1.05], [0.56, 0.995, 'c'], [0, 0.985, 'h']], 0),
      bumper: sym([[0, 0.480, 'h'], [0.70, 0.480], [0.80, 0.470], [0.810, 0.400], [0.800, 0.300], [0.770, 0.215, 'c'], [0, 0.200, 'h']], 0),
      panelLines: [curve([[-0.72, 0.900], [0, 0.895, 'h'], [0.72, 0.900]])],    // hatch lower edge
      // wide horizontal tail lamps wrapping the corners, black garnish between them
      taillights: pair(rpoly([[0.30, 0.680], [0.78, 0.680], [0.808, 0.720], [0.800, 0.862], [0.30, 0.862]], 0.012), 0),
      diffuser: sym([[0, 0.270, 'h'], [0.45, 0.270], [0.70, 0.250, 'c'], [0.68, 0.205], [0, 0.200, 'h']], 0),
      exhaust: [{ shape: 'round', cx: -0.50, cy: 0.250, w: 0.065, h: 0.065 }],
      plateArea: rrect(-0.165, 0.495, 0.165, 0.660, 0.010),
      badgeArea: rrect(-0.20, 0.745, 0.20, 0.795, 0.006),
      badgeText: 'TRUENO'
    };

    var details = [
      D('side', 'mirror', loop([[0.40, 0.890, 'c'], [0.39, 0.950], [0.31, 0.966], [0.24, 0.940], [0.245, 0.898], [0.32, 0.884]]), 'black'),
      D('side', 'trim', rpoly([[-0.635, 0.912], [-0.620, 1.300], [-0.695, 1.297], [-0.702, 0.916]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.50, 0.730, -0.34, 0.750, 0.006), 'black'),
      D('side', 'light', rpoly([[2.006, 0.505], [2.010, 0.590], [1.96, 0.598], [1.97, 0.505]], 0.004), 'light-amber'),   // wrap-round corner lamp
      D('side', 'marker', rrect(1.70, 0.560, 1.76, 0.580, 0.006), 'light-amber'),
      D('side', 'light', rpoly([[-2.183, 0.690], [-2.186, 0.860], [-2.13, 0.860], [-2.13, 0.690]], 0.006), 'light-red'),
      D('top', 'wiper', rrect(0.54, -0.05, 0.58, 0.50, 0.01), 'black'),
      D('top', 'wiper', rrect(-1.98, -0.30, -1.95, 0.05, 0.008), 'black'),          // rear hatch wiper
      D('top', 'fuelCap', rrect(-1.62, 0.770, -1.50, 0.805, 0.010), 'body'),
      D('top', 'trim', rrect(-2.19, -0.80, -2.16, 0.80, 0.008), 'light-red'),
      D('top', 'antenna', rrect(1.10, 0.76, 1.13, 0.79, 0.008), 'black'),
      D('front', 'wiper', rpoly([[-0.05, 0.875], [0.50, 0.895], [0.50, 0.905], [-0.05, 0.887]], 0.004), 'black'),
      D('rear', 'trim', rrect(-0.30, 0.680, 0.30, 0.862, 0.010), 'gloss-black'),       // centre garnish panel
      D('rear', 'wiper', rpoly([[-0.30, 1.010], [0.05, 1.000], [0.05, 1.010], [-0.30, 1.020]], 0.003), 'black')
    ].concat(
      pairD('top', 'trim', rpoly([[1.93, 0.40], [1.93, 0.74], [1.73, 0.74], [1.73, 0.40]], 0.015), 'body', 1),   // closed pop-up lids
      pairD('front', 'mirror', loop([[0.60, 0.885, 'c'], [0.78, 0.895], [0.90, 0.905], [0.92, 0.950], [0.86, 0.975], [0.78, 0.970], [0.72, 0.925], [0.60, 0.915, 'c']]), 'black', 0),
      pairD('front', 'light', rpoly([[0.60, 0.505], [0.72, 0.505], [0.785, 0.528], [0.776, 0.585], [0.60, 0.585]], 0.006), 'light-amber', 0),
      [0.520, 0.545, 0.570].map(function (y) { return D('front', 'vent', rrect(-0.34, y - 0.005, 0.34, y + 0.005, 0.003), 'gloss-black'); }),   // nose slats
      // horizontal lamp ribs; inner amber + clear reverse sections
      [0.715, 0.750, 0.785, 0.820].reduce(function (acc, y) { return acc.concat(pairD('rear', 'trim', rrect(0.31, y - 0.003, 0.80, y + 0.003, 0.002), 'gloss-black', 0)); }, []),
      pairD('rear', 'light', rrect(0.31, 0.690, 0.42, 0.852, 0.006), 'light-amber', 0),
      pairD('rear', 'light', rrect(0.43, 0.690, 0.52, 0.852, 0.006), 'light', 0),
      pairD('rear', 'marker', rrect(0.66, 0.36, 0.78, 0.38, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.815, 0.89, 'c'], [0.90, 0.905], [0.92, 0.950], [0.86, 0.975], [0.815, 0.97, 'c']]), 'black', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.195, xWS: 0.50, xBL: -2.03,
      belt: [[0.50, 0.858], [0.38, 0.885], [0.10, 0.890], [-0.60, 0.908], [-1.10, 0.945], [-1.45, 0.990], [-1.715, 1.040], [-1.90, 1.010], [-2.03, 0.985]],
      crest: [[2.01, 0.42, 0.60], [1.90, 0.60, 0.72], [1.60, 0.665, 0.76], [1.20, 0.725, 0.80], [0.80, 0.79, 0.86], [0.40, 0.835, 0.92], [-0.60, 0.85, 0.94],
        [-1.30, 0.89, 0.92], [-1.80, 0.93, 0.86], [-2.10, 0.90, 0.70], [-2.19, 0.82, 0.55]],
      dip: [[2.01, 0.0], [1.90, 0.03], [1.60, 0.035], [1.00, 0.025], [0.52, 0.0]],
      NV: 40, stations: 110
    });

    return {
      id: 'toyota-sprinter-trueno-ae86', make: 'Toyota', name: 'Sprinter Trueno GT-APEX', gen: 'AE86', years: '1983–1987', style: 'hatchback',
      look: { head: 'blade', tail: 'full-width', grille: 'slats' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', doors: 3, ref: ref,
      color: '#f1f1ec', colorName: 'High Tech Two-Tone (white over black)',
      popUpHeadlights: true,
      wheel: { style: '8-hole', spokes: 8, caliper: '#2a2a2a' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Retractable (pop-up) twin rectangular headlamps under flush lids; with them closed only the wide clear parking / turn lamps across the nose show.',
        taillights: 'Wide horizontal ribbed tail lamps wrapping the corners, amber and clear inner sections, black garnish panel with the name between them.',
        grille: 'No grille: a slim black slatted panel across the wedge nose, separate full-width bumper with the plate and two small slots.',
        notes: 'Three-door liftback, boxy glasshouse with thin pillars, black body-side protection moulding, long rear overhang, single small tailpipe on the left; 4A-GEU 1.6 twin-cam, live rear axle.'
      },
      sources: ['Toyota AE86 Sprinter Trueno 3-door GT-APEX catalogue (1985): 4205 x 1625 x 1335 mm, wheelbase 2400 mm, tread 1355/1345 mm, 185/60R14, 940 kg']
    };
  }

  /* ================================================================== */
  /* Mazda RX-7 Type R (FD3S)                                            */
  /* ================================================================== */
  function rx7FD() {
    var ref = {
      length: 4.285, width: 1.760, height: 1.230, wheelbase: 2.425, trackF: 1.460, trackR: 1.460,
      frontOverhang: 0.955, rearOverhang: 0.905, wheelDiameter_in: 17,
      tireF: '235/45ZR17', tireR: '235/45ZR17', groundClearance: 0.125, rideHeight: 0.125, cd: 0.31, curbWeight_kg: 1270
    };
    var XF = 2.1675, XR = -2.1175, H = 1.230;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.2125, y: rF, r: rF + 0.030, flare: 0.020 };
    var aR = { x: -1.2125, y: rR, r: rR + 0.030, flare: 0.022 };
    var yb = 0.170;

    // very low nose, bonnet dipping between tall front-wing humps, bubble cabin, glass hatch to a ducktail lip
    var roofLine = [[0.45, 0.790, 'c'], [0.15, 0.975], [-0.15, 1.165], [-0.45, H, 'h'], [-0.85, 1.200], [-1.20, 1.110], [-1.55, 1.010], [-1.80, 0.975], [-1.98, 0.988, 'h']];
    var body = sideBody(aF, aR, yb, yb, [
      [1.70, 0.168], [2.00, 0.155, 'c'], [2.110, 0.200], [XF, 0.330, 'v'], [2.155, 0.400], [2.100, 0.470], [1.98, 0.540],
      // front-wing hump over the wheel stands above the bonnet and scuttle
      [1.75, 0.622], [1.45, 0.702], [1.21, 0.726, 'h'], [0.90, 0.716], [0.65, 0.742]
    ].concat(roofLine, [
      [-2.05, 0.970, 'c'], [-2.098, 0.880], [XR, 0.650, 'v'], [-2.110, 0.450], [-2.090, 0.300], [-2.040, 0.200], [-1.95, yb, 'c'], [-1.70, yb, 'c']
    ]), 0.165);

    var doorGlass = [[0.30, 0.840, 'c'], [0.08, 0.985], [-0.15, 1.130], [-0.45, 1.195, 'h'], [-0.74, 1.175, 'c'], [-0.76, 0.880, 'c']];
    var quarterGlass = [[-0.81, 0.885, 'c'], [-0.805, 1.165, 'c'], [-1.00, 1.120], [-1.20, 1.050], [-1.38, 0.985, 'c'], [-1.15, 0.925], [-0.98, 0.898]];
    var side = ext({
      body: body,
      greenhouse: loop([[0.305, 0.835, 'c'], [0.082, 0.990], [-0.15, 1.138], [-0.45, 1.203, 'h'], [-0.805, 1.172], [-1.00, 1.128], [-1.20, 1.058], [-1.395, 0.984, 'c'],
        [-1.15, 0.918], [-0.98, 0.892], [-0.60, 0.872], [0.05, 0.850]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.45, 0.790, 'c'], [0.15, 0.975], [-0.15, 1.165, 'c'], [-0.15, 1.130, 'c'], [0.08, 0.985], [0.30, 0.840, 'c']])],
      doorCuts: [loop([[0.55, 0.24, 'c'], [0.56, 0.55], [0.50, 0.70], [0.42, 0.775]].concat(doorGlass, [[-0.82, 0.75], [-0.80, 0.25, 'c']]))],
      panelLines: [
        curve([[1.80, 0.612], [1.66, 0.45], [1.55, 0.335]]),             // nose / wing seam
        curve([[-1.58, 0.700], [-1.60, 0.45], [-1.60, 0.330]]),          // rear bumper seam
        curve([[-1.66, 0.988], [-1.82, 0.966], [-2.04, 0.962]]),         // hatch rear edge
        curve([[1.98, 0.536], [1.78, 0.604]]),                            // pop-up lid front edge
        rrect(-1.78, 0.78, -1.64, 0.87, 0.02)                              // fuel flap
      ],
      characterLines: [
        // the one sweeping shoulder line that runs from the front hump up into the rear haunch
        curve([[1.50, 0.640], [0.80, 0.662], [0.00, 0.700], [-0.80, 0.760], [-1.50, 0.840], [-2.00, 0.900]]),
        curve([[0.50, 0.380], [-0.10, 0.400], [-0.70, 0.460]])           // concave door scallop
      ],
      sill: rrect(-0.85, 0.165, 0.88, 0.200, 0.008),
      lowerTrim: [
        loop([[1.55, 0.170, 'c'], [1.70, 0.168], [2.00, 0.158, 'c'], [2.06, 0.180, 'c'], [1.70, 0.192], [1.555, 0.205, 'c']]),
        loop([[-1.56, 0.172, 'c'], [-1.95, 0.172], [-2.04, 0.205, 'c'], [-2.07, 0.240, 'c'], [-1.95, 0.210], [-1.555, 0.210, 'c']])
      ],
      popupLamps: [
        { path: rpoly([[1.975, 0.540], [1.97, 0.660], [1.79, 0.680], [1.78, 0.604]], 0.010), paint: 'body' },
        { path: rpoly([[1.975, 0.552], [1.985, 0.650], [1.972, 0.652], [1.962, 0.556]], 0.003), paint: 'light' }
      ]
    }, arches(aF, aR, yb));

    var roofPlan = rpoly([[-0.12, -0.52], [-0.12, 0.52], [-0.95, 0.48], [-0.95, -0.48]], 0.07);
    var top = {
      // rounded nose, wing bulges front and rear, coke-bottle waist at the doors
      body: sym([[XF, 0, 'v'], [2.150, 0.30], [2.08, 0.55], [1.92, 0.740], [1.60, 0.855], [1.21, 0.880, 'h'], [0.75, 0.856], [0.20, 0.836, 'h'],
        [-0.40, 0.846], [-1.21, 0.880, 'h'], [-1.70, 0.866], [-1.98, 0.800], [-2.09, 0.650], [-2.112, 0.40], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.47, 0, 'v'], [0.42, 0.57, 'c'], [0.05, 0.630], [-0.70, 0.640], [-1.30, 0.580], [-1.68, 0.450], [-1.76, 0.28], [-1.77, 0, 'v']], 1),
      hood: sym([[2.08, 0, 'v'], [2.04, 0.40], [1.90, 0.62, 'c'], [0.50, 0.62, 'c'], [0.47, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.78, 0, 'v'], [-1.79, 0.50, 'c'], [-2.06, 0.62, 'c'], [-2.09, 0, 'v']], 1),
      mirrors: pair(loop([[0.36, 0.840, 'c'], [0.33, 0.94], [0.27, 0.975], [0.19, 0.970], [0.16, 0.91], [0.165, 0.840, 'c']]), 1),
      // double-bubble channel down the roof
      characterLines: pair(curve([[-0.15, 0.06], [-0.55, 0.062], [-0.92, 0.06]]), 1),
      popupLamps: pair(rpoly([[1.96, 0.36], [1.98, 0.66], [1.78, 0.72], [1.76, 0.38]], 0.02), 1)
    };

    var front = {
      // double-bubble roof crowns at z +-0.20
      body: sym([[0, 1.212, 'h'], [0.20, H, 'h'], [0.40, 1.200], [0.52, 1.080], [0.58, 0.920], [0.64, 0.800], [0.72, 0.742], [0.80, 0.720], [0.86, 0.650],
        [0.88, 0.52, 'v'], [0.870, 0.380], [0.840, 0.260], [0.780, 0.180, 'c'], [0.55, 0.150], [0, 0.145, 'h']], 0),
      greenhouse: sym([[0, 1.188, 'h'], [0.20, 1.205, 'h'], [0.38, 1.175], [0.49, 1.06], [0.55, 0.90], [0.58, 0.830, 'c'], [0.30, 0.815], [0, 0.810, 'h']], 0),
      bumper: sym([[0, 0.520, 'h'], [0.40, 0.516], [0.70, 0.530], [0.84, 0.500], [0.875, 0.400], [0.840, 0.260], [0.780, 0.180, 'c'], [0.55, 0.150], [0, 0.145, 'h']], 0),
      characterLines: [
        // bonnet sunk between the tall front-wing humps
        curve([[-0.86, 0.66], [-0.75, 0.722, 'h'], [-0.55, 0.660], [-0.30, 0.600], [0, 0.585, 'h'], [0.30, 0.600], [0.55, 0.660], [0.75, 0.722, 'h'], [0.86, 0.66]])
      ],
      // wide oval "smile" mouth, plate on its centre
      grille: [rpoly([[-0.46, 0.230], [0.46, 0.230], [0.50, 0.300], [0.44, 0.405], [-0.44, 0.405], [-0.50, 0.300]], 0.06)],
      intakes: pair(rpoly([[0.60, 0.240], [0.78, 0.260], [0.80, 0.360], [0.62, 0.372]], 0.03), 0),
      // pop-ups closed: slim wrap-round parking / turn lamps in the bumper corners
      headlights: pair(rpoly([[0.56, 0.420], [0.80, 0.440], [0.825, 0.482], [0.60, 0.472]], 0.012), 0),
      drl: pair(rrect(0.585, 0.428, 0.68, 0.462, 0.006), 0),
      splitter: { path: rpoly([[-0.62, 0.145], [0.62, 0.145], [0.60, 0.165], [-0.60, 0.165]], 0.008), paint: 'black' },
      plateArea: rrect(-0.165, 0.240, 0.165, 0.405, 0.010),
      badgeArea: rrect(-0.050, 0.530, 0.050, 0.562, 0.010),
      badgeText: 'MAZDA',
      popupLamps: [].concat(
        pair(rpoly([[0.36, 0.585], [0.70, 0.668], [0.70, 0.800], [0.36, 0.740]], 0.015), 0).map(function (p) { return { path: p, paint: 'body' }; }),
        pair(ellipse(0.53, 0.690, 0.12, 0.045, 13), 0).map(function (p) { return { path: p, paint: 'light' }; })
      )
    };

    var rear = {
      body: sym([[0, 1.212, 'h'], [0.20, H, 'h'], [0.38, 1.200], [0.48, 1.100], [0.55, 1.000], [0.66, 0.960], [0.80, 0.900], [0.865, 0.800], [0.88, 0.65, 'v'],
        [0.875, 0.450], [0.850, 0.280], [0.800, 0.200, 'c'], [0, 0.180, 'h']], 0),
      greenhouse: sym([[0, 1.188, 'h'], [0.20, 1.200, 'h'], [0.36, 1.170], [0.46, 1.080], [0.50, 1.000, 'c'], [0, 0.990, 'h']], 0),
      bumper: sym([[0, 0.620, 'h'], [0.55, 0.620], [0.82, 0.600], [0.875, 0.500], [0.850, 0.280], [0.800, 0.200, 'c'], [0, 0.180, 'h']], 0),
      panelLines: [curve([[-0.55, 0.965], [0, 0.962, 'h'], [0.55, 0.965]])],
      // '99-spec round lamps: two red discs per side, amber inner disc in the details
      taillights: [].concat(pair(ellipse(0.745, 0.830, 0.068, 0.062, 0), 0), pair(ellipse(0.580, 0.835, 0.064, 0.060, 0), 0)),
      diffuser: sym([[0, 0.270, 'h'], [0.40, 0.270], [0.65, 0.240, 'c'], [0.63, 0.185], [0, 0.180, 'h']], 0),
      exhaust: [{ shape: 'round', cx: 0.44, cy: 0.250, w: 0.085, h: 0.085 }, { shape: 'round', cx: -0.44, cy: 0.250, w: 0.085, h: 0.085 }],
      plateArea: rrect(-0.165, 0.630, 0.165, 0.795, 0.010),
      badgeArea: rrect(-0.12, 0.810, 0.12, 0.840, 0.006),
      // Type R high-mount hoop wing
      spoiler: sym([[0, 1.100, 'h'], [0.62, 1.100], [0.68, 1.080, 'c'], [0.66, 1.060, 'c'], [0, 1.060, 'h']], 0),
      badgeText: 'RX-7'
    };

    var details = [
      D('side', 'mirror', loop([[0.34, 0.835, 'c'], [0.33, 0.895], [0.25, 0.910], [0.17, 0.888], [0.175, 0.845], [0.26, 0.830]]), 'body'),
      D('side', 'trim', rpoly([[-0.755, 0.878], [-0.742, 1.172], [-0.805, 1.165], [-0.812, 0.882]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.62, 0.750, -0.46, 0.770, 0.008), 'body'),
      D('side', 'marker', rrect(2.06, 0.420, 2.13, 0.448, 0.006), 'light-amber'),
      D('side', 'intake', rpoly([[1.96, 0.24], [2.10, 0.25], [2.13, 0.36], [1.99, 0.36]], 0.02), 'grille'),
      D('side', 'light', loop([[-2.02, 0.900, 'c'], [-2.10, 0.890], [-2.112, 0.780, 'c'], [-2.06, 0.800]]), 'light-red'),
      D('side', 'spoiler', loop([[-1.80, 1.060, 'c'], [-2.06, 1.100], [-2.10, 1.085, 'c'], [-2.06, 1.058], [-1.84, 1.052, 'c']]), 'body'),
      D('side', 'spoiler', rpoly([[-1.92, 0.985], [-1.89, 0.985], [-1.95, 1.065], [-1.98, 1.065]], 0.004), 'body'),   // hoop upright
      D('top', 'wiper', rrect(0.50, -0.05, 0.54, 0.52, 0.01), 'black'),
      D('top', 'vent', rpoly([[1.95, -0.12], [1.95, 0.12], [1.78, 0.09], [1.78, -0.09]], 0.02), 'gloss-black'),   // bonnet duct
      D('top', 'fuelCap', rrect(-1.78, 0.81, -1.64, 0.86, 0.012), 'body'),
      D('top', 'spoiler', rrect(-2.10, -0.68, -1.96, 0.68, 0.02), 'body'),
      D('top', 'trim', rrect(-2.115, -0.82, -2.09, 0.82, 0.008), 'light-red'),
      D('front', 'wiper', rpoly([[-0.05, 0.815], [0.48, 0.832], [0.48, 0.842], [-0.05, 0.827]], 0.004), 'black'),
      D('rear', 'trim', rrect(-0.30, 0.200, 0.30, 0.235, 0.010), 'black')
    ].concat(
      pairD('top', 'trim', rpoly([[1.96, 0.36], [1.98, 0.66], [1.78, 0.72], [1.76, 0.38]], 0.02), 'body', 1),   // closed pop-up lids
      pairD('front', 'mirror', loop([[0.56, 0.830, 'c'], [0.75, 0.840], [0.90, 0.850], [0.915, 0.895], [0.85, 0.925], [0.77, 0.920], [0.72, 0.870], [0.56, 0.860, 'c']]), 'body', 0),
      pairD('front', 'trim', rpoly([[0.36, 0.585], [0.70, 0.668], [0.70, 0.682], [0.36, 0.598]], 0.004), 'body', 0),   // closed lid faces
      pairD('front', 'light', rpoly([[0.70, 0.437], [0.80, 0.444], [0.822, 0.478], [0.71, 0.470]], 0.006), 'light-amber', 0),
      pairD('front', 'light', circ(0.69, 0.310, 0.035), 'light', 0),                        // fog lamps in the corner ducts
      pairD('rear', 'light', ellipse(0.420, 0.840, 0.056, 0.052, 0), 'light-amber', 0),    // inner amber disc
      ringPair('rear', 0.745, 0.830, 0.030, 'gloss-black'), ringPair('rear', 0.580, 0.835, 0.028, 'gloss-black'),
      ringPair('rear', 0.745, 0.830, 0.018, 'light-red'), ringPair('rear', 0.580, 0.835, 0.017, 'light-red'),
      pairD('rear', 'spoiler', rrect(0.56, 0.965, 0.60, 1.065, 0.006), 'body', 0),
      pairD('rear', 'marker', rrect(0.70, 0.38, 0.82, 0.40, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.88, 0.835, 'c'], [0.90, 0.850], [0.915, 0.895], [0.89, 0.920], [0.88, 0.918, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.45, xBL: -1.78,
      belt: [[0.45, 0.790], [0.30, 0.840], [0.05, 0.850], [-0.60, 0.872], [-0.98, 0.892], [-1.15, 0.918], [-1.395, 0.984], [-1.60, 0.985], [-1.78, 0.975]],
      crest: [[2.17, 0.33, 0.60], [2.00, 0.52, 0.68], [1.60, 0.665, 0.76], [1.21, 0.722, 0.82], [0.80, 0.715, 0.84], [0.45, 0.74, 0.88], [0.00, 0.77, 0.90],
        [-0.60, 0.81, 0.92], [-1.21, 0.87, 0.90], [-1.60, 0.92, 0.84], [-1.90, 0.94, 0.74], [-2.12, 0.86, 0.55]],
      dip: [[2.17, 0.0], [2.05, 0.05], [1.80, 0.09], [1.40, 0.10], [0.90, 0.07], [0.45, 0.0]],
      NV: 40, stations: 110
    });

    return {
      id: 'mazda-rx7-fd3s', make: 'Mazda', name: 'RX-7 Type R', gen: 'FD3S', years: '1991–2002', style: 'coupe',
      look: { head: 'blade', tail: 'round-ring', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice', doors: 2, ref: ref,
      color: '#c3141d', colorName: 'Vintage Red',
      popUpHeadlights: true,
      wheel: { style: '5-spoke', spokes: 5, caliper: '#2b2d30' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Pop-up headlamps hidden under lids in the low nose; with them down only the slim wrap-round parking / turn lamps in the bumper corners show.',
        taillights: "'99-spec round tail lamps, three discs per side (two red, one amber inboard), under a ducktail lip.",
        grille: 'No grille: a wide oval "smile" mouth with the plate, small corner ducts with fog lamps.',
        notes: 'Very low nose, bonnet sunk between tall front-wing humps, double-bubble roof, glass hatch, coke-bottle plan, one sweeping shoulder line, Type R hoop wing, twin round tailpipes; 13B-REW sequential twin-turbo rotary set behind the front axle.'
      },
      sources: ['Mazda RX-7 Type R (FD3S, 1999–2002): 4285 x 1760 x 1230 mm, wheelbase 2425 mm, tread 1460/1460 mm, 235/45ZR17, 1270 kg']
    };
  }

  /* ================================================================== */
  /* Nissan GT-R (R35, 2017)                                             */
  /* ================================================================== */
  function gtrR35() {
    var ref = {
      length: 4.710, width: 1.895, height: 1.370, wheelbase: 2.780, trackF: 1.590, trackR: 1.600,
      frontOverhang: 1.010, rearOverhang: 0.920, wheelDiameter_in: 20,
      tireF: '255/40ZR20', tireR: '285/35ZR20', groundClearance: 0.105, rideHeight: 0.110, cd: 0.26, curbWeight_kg: 1752
    };
    var XF = 2.400, XR = -2.310, H = 1.370;
    var rF = tireDia(ref.tireF) / 2, rR = tireDia(ref.tireR) / 2;
    var aF = { x: 1.390, y: rF, r: rF + 0.030, flare: 0.026 };
    var aR = { x: -1.390, y: rR, r: rR + 0.030, flare: 0.034 };
    var yb = 0.170;

    var roofLine = [[0.70, 0.955, 'c'], [0.35, 1.120], [0.00, 1.310], [-0.35, H, 'h'], [-0.85, 1.345], [-1.30, 1.250], [-1.65, 1.140], [-1.90, 1.092, 'c']];
    var body = sideBody(aF, aR, yb, yb, [
      [2.05, 0.165], [2.30, 0.135, 'c'], [2.370, 0.200], [XF, 0.380, 'v'], [2.390, 0.550], [2.360, 0.660], [2.300, 0.750], [2.220, 0.790],
      [2.00, 0.830], [1.70, 0.865], [1.30, 0.895], [0.95, 0.925]
    ].concat(roofLine, [
      [-2.10, 1.086], [-2.25, 1.080, 'c'], [-2.292, 1.020], [XR, 0.800, 'v'], [-2.305, 0.550], [-2.280, 0.330], [-2.220, 0.200], [-2.10, yb, 'c'], [-1.85, yb, 'c']
    ]), 0.165);

    var doorGlass = [[0.55, 0.990, 'c'], [0.25, 1.150], [-0.02, 1.290], [-0.35, 1.330, 'h'], [-0.80, 1.315, 'c'], [-0.82, 1.010, 'c']];
    // quarter glass with the reverse-kink "blade" at its rear corner
    var quarterGlass = [[-0.88, 1.012, 'c'], [-0.875, 1.308, 'c'], [-1.10, 1.270], [-1.28, 1.200], [-1.40, 1.140, 'c'], [-1.43, 1.090, 'c'], [-1.25, 1.050], [-1.05, 1.025]];
    var side = ext({
      body: body,
      greenhouse: loop([[0.555, 0.985, 'c'], [0.252, 1.154], [-0.02, 1.298], [-0.35, 1.338, 'h'], [-0.875, 1.316], [-1.10, 1.278], [-1.29, 1.205], [-1.41, 1.142, 'c'],
        [-1.445, 1.085, 'c'], [-1.25, 1.042], [-1.05, 1.017], [-0.60, 1.000], [0.10, 0.992]]),
      windows: [loop(doorGlass), loop(quarterGlass)],
      pillars: [loop([[0.70, 0.955, 'c'], [0.35, 1.120], [0.00, 1.310, 'c'], [-0.02, 1.290, 'c'], [0.25, 1.150], [0.55, 0.990, 'c']])],
      doorCuts: [loop([[0.88, 0.26, 'c'], [0.88, 0.60], [0.82, 0.86], [0.70, 0.948]].concat(doorGlass, [[-0.88, 0.80], [-0.86, 0.27, 'c']]))],
      panelLines: [
        curve([[2.20, 0.785], [2.05, 0.55], [1.85, 0.400]]),             // front bumper / wing seam
        curve([[-1.85, 0.760], [-1.87, 0.50], [-1.90, 0.320]]),          // rear bumper seam
        curve([[-1.92, 1.090], [-2.10, 1.082], [-2.27, 1.062], [-2.296, 0.950]]),   // boot-lid shut line
        curve([[2.24, 0.785], [1.60, 0.862], [0.95, 0.912]])             // bonnet shut line
      ],
      characterLines: [
        // shoulder blade: from the lamp, along the wing, rising over the rear haunch
        curve([[2.10, 0.780], [1.50, 0.835], [0.80, 0.860], [0.00, 0.880], [-0.90, 0.920], [-1.80, 0.980], [-2.25, 1.000]]),
        // lower line sweeping back from the wing vent
        curve([[0.95, 0.550], [0.20, 0.500], [-0.60, 0.480], [-1.00, 0.500]])
      ],
      sill: rrect(-1.02, 0.165, 1.02, 0.215, 0.010),
      lowerTrim: [
        loop([[1.02, 0.165, 'c'], [-1.02, 0.165, 'c'], [-1.025, 0.185, 'c'], [1.025, 0.185, 'c']]),
        loop([[1.76, 0.168, 'c'], [2.05, 0.166], [2.30, 0.138, 'c'], [2.34, 0.165, 'c'], [2.05, 0.192], [1.765, 0.205, 'c']]),
        loop([[-1.78, 0.172, 'c'], [-2.10, 0.172], [-2.22, 0.205, 'c'], [-2.26, 0.290, 'c'], [-2.10, 0.215], [-1.775, 0.212, 'c']])
      ]
    }, arches(aF, aR, yb));

    var roofPlan = rpoly([[0.00, -0.60], [0.00, 0.60], [-1.10, 0.57], [-1.10, -0.57]], 0.07);
    var top = {
      body: sym([[XF, 0, 'v'], [2.390, 0.35], [2.350, 0.66], [2.240, 0.840], [2.00, 0.925], [1.39, 0.9475, 'h'], [0.70, 0.926], [0.00, 0.916, 'h'],
        [-0.70, 0.926], [-1.39, 0.9475, 'h'], [-1.95, 0.930], [-2.22, 0.860], [-2.295, 0.660], [XR, 0, 'v']], 1),
      greenhouse: sym([[0.72, 0, 'v'], [0.66, 0.70, 'c'], [0.25, 0.735], [-0.70, 0.735], [-1.40, 0.680], [-1.85, 0.580], [-1.91, 0.40], [-1.92, 0, 'v']], 1),
      hood: sym([[2.30, 0, 'v'], [2.27, 0.55], [2.15, 0.76, 'c'], [0.76, 0.74, 'c'], [0.72, 0, 'v']], 1),
      roof: roofPlan,
      deck: sym([[-1.92, 0, 'v'], [-1.93, 0.62, 'c'], [-2.25, 0.74, 'c'], [-2.28, 0, 'v']], 1),
      mirrors: pair(loop([[0.60, 0.915, 'c'], [0.57, 1.02], [0.51, 1.06], [0.41, 1.055], [0.38, 0.99], [0.385, 0.915, 'c']]), 1),
      characterLines: pair(curve([[2.26, 0.26], [1.70, 0.30], [1.10, 0.33], [0.76, 0.34]]), 1)    // twin bonnet creases
    };

    var front = {
      body: sym([[0, H, 'h'], [0.44, 1.355], [0.60, 1.28], [0.68, 1.12], [0.74, 1.00], [0.82, 0.930], [0.90, 0.880], [0.935, 0.780],
        [0.9475, 0.60, 'v'], [0.940, 0.400], [0.910, 0.240], [0.850, 0.150, 'c'], [0.60, 0.130], [0, 0.125, 'h']], 0),
      greenhouse: sym([[0, 1.345, 'h'], [0.44, 1.330], [0.58, 1.26], [0.66, 1.10], [0.72, 0.99, 'c'], [0.35, 0.965], [0, 0.960, 'h']], 0),
      bumper: sym([[0, 0.700, 'h'], [0.40, 0.700], [0.80, 0.700], [0.920, 0.660], [0.940, 0.400], [0.910, 0.240], [0.850, 0.150, 'c'], [0.60, 0.130], [0, 0.125, 'h']], 0),
      characterLines: [
        curve([[-0.93, 0.85], [-0.80, 0.880, 'h'], [-0.50, 0.825], [0, 0.808, 'h'], [0.50, 0.825], [0.80, 0.880, 'h'], [0.93, 0.85]]),
        curve([[-0.30, 0.812], [-0.28, 0.88], [-0.25, 0.96]]),
        curve([[0.30, 0.812], [0.28, 0.88], [0.25, 0.96]])
      ],
      // 2017 V-motion grille: narrow top under the badge, flaring wide toward the bottom
      grille: [rpoly([[-0.28, 0.700], [0.28, 0.700], [0.36, 0.560], [0.40, 0.300], [0.36, 0.220], [-0.36, 0.220], [-0.40, 0.300], [-0.36, 0.560]], 0.03)],
      intakes: pair(rpoly([[0.50, 0.220], [0.82, 0.240], [0.86, 0.400], [0.78, 0.520], [0.52, 0.400]], 0.02), 0),
      // long swept lamps, inner end at the grille top, outer end wrapping the wing
      headlights: pair(rpoly([[0.36, 0.720], [0.60, 0.760], [0.86, 0.840], [0.92, 0.800], [0.90, 0.720], [0.66, 0.700], [0.40, 0.692]], 0.012), 0),
      // lightning-bolt LED DRL
      drl: pair(rpoly([[0.60, 0.712], [0.84, 0.738], [0.80, 0.752], [0.88, 0.790], [0.875, 0.805], [0.77, 0.762], [0.80, 0.748], [0.60, 0.725]], 0.003), 0),
      splitter: { path: rpoly([[-0.86, 0.125], [0.86, 0.125], [0.84, 0.150], [-0.84, 0.150]], 0.008), paint: 'carbon' },
      plateArea: rrect(-0.165, 0.300, 0.165, 0.465, 0.010),
      badgeArea: rrect(-0.060, 0.620, 0.060, 0.665, 0.010),
      badgeText: 'GT-R'
    };

    var rear = {
      body: sym([[0, H, 'h'], [0.42, 1.355], [0.56, 1.27], [0.62, 1.16], [0.70, 1.100], [0.84, 1.070], [0.92, 0.990], [0.9475, 0.82, 'v'],
        [0.945, 0.550], [0.930, 0.380], [0.890, 0.240], [0.840, 0.180, 'c'], [0, 0.170, 'h']], 0),
      greenhouse: sym([[0, 1.340, 'h'], [0.40, 1.325], [0.52, 1.24], [0.58, 1.14], [0.575, 1.110, 'c'], [0, 1.100, 'h']], 0),
      bumper: sym([[0, 0.780, 'h'], [0.60, 0.780], [0.90, 0.760], [0.940, 0.620], [0.930, 0.380], [0.890, 0.240], [0.840, 0.180, 'c'], [0, 0.170, 'h']], 0),
      panelLines: [curve([[-0.86, 1.045], [0, 1.040, 'h'], [0.86, 1.045]])],
      // four round ring lamps
      taillights: [].concat(pair(circ(0.500, 0.935, 0.072), 0), pair(circ(0.745, 0.935, 0.080), 0)),
      diffuser: sym([[0, 0.360, 'h'], [0.45, 0.360], [0.78, 0.300, 'c'], [0.76, 0.180], [0, 0.170, 'h']], 0),
      // quad round titanium tailpipes
      exhaust: [0.48, 0.63, -0.48, -0.63].map(function (z) { return { shape: 'round', cx: z, cy: 0.270, w: 0.110, h: 0.110 }; }),
      plateArea: rrect(-0.165, 0.600, 0.165, 0.765, 0.010),
      badgeArea: rrect(-0.10, 0.925, 0.10, 0.955, 0.006),
      // fixed rear wing on stalks
      spoiler: sym([[0, 1.160, 'h'], [0.70, 1.160], [0.76, 1.140, 'c'], [0.74, 1.120, 'c'], [0, 1.120, 'h']], 0),
      badgeText: 'GT-R'
    };

    var details = [
      D('side', 'mirror', loop([[0.60, 0.995, 'c'], [0.585, 1.065], [0.49, 1.082], [0.39, 1.055], [0.395, 1.005], [0.50, 0.990]]), 'body'),
      D('side', 'trim', rpoly([[-0.815, 1.005], [-0.800, 1.315], [-0.875, 1.308], [-0.882, 1.010]], 0.004), 'gloss-black'),   // B-pillar
      D('side', 'handle', rrect(-0.68, 0.900, -0.50, 0.922, 0.010), 'chrome'),
      D('side', 'vent', rpoly([[0.88, 0.560], [1.08, 0.600], [1.12, 0.720], [0.92, 0.680]], 0.012), 'gloss-black'),    // wing vent
      D('side', 'trim', rpoly([[0.90, 0.635], [1.10, 0.665], [1.105, 0.675], [0.905, 0.645]], 0.002), 'body'),           // vent blade
      D('side', 'light', loop([[2.36, 0.665, 'c'], [2.24, 0.770], [2.10, 0.800, 'c'], [2.15, 0.755], [2.33, 0.650, 'c']]), 'light'),
      D('side', 'intake', rpoly([[2.20, 0.22], [2.36, 0.23], [2.39, 0.40], [2.24, 0.42]], 0.02), 'grille'),
      D('side', 'light', loop([[-2.18, 1.020, 'c'], [-2.292, 1.010], [-2.300, 0.880, 'c'], [-2.20, 0.900]]), 'light-red'),
      D('side', 'spoiler', loop([[-1.98, 1.120, 'c'], [-2.24, 1.160], [-2.28, 1.145, 'c'], [-2.24, 1.118], [-2.02, 1.112, 'c']]), 'body'),
      D('side', 'spoiler', rpoly([[-2.14, 1.080], [-2.10, 1.080], [-2.12, 1.125], [-2.16, 1.125]], 0.004), 'body'),
      D('top', 'wiper', rrect(0.74, -0.05, 0.78, 0.62, 0.01), 'black'),
      D('top', 'fuelCap', rrect(-1.95, -0.92, -1.80, -0.86, 0.012), 'body'),
      D('top', 'spoiler', rrect(-2.27, -0.76, -2.15, 0.76, 0.015), 'body'),
      D('top', 'trim', rrect(-2.312, -0.84, -2.288, 0.84, 0.008), 'light-red'),
      D('top', 'antenna', rrect(-1.06, -0.03, -0.98, 0.03, 0.02), 'black'),     // shark-fin
      D('front', 'wiper', rpoly([[-0.05, 0.965], [0.60, 0.990], [0.60, 1.000], [-0.05, 0.977]], 0.004), 'black'),
      D('front', 'trim', rpoly([[-0.28, 0.700], [0.28, 0.700], [0.36, 0.560], [0.40, 0.300], [0.36, 0.220], [0.33, 0.235], [0.37, 0.300], [0.33, 0.550], [0.26, 0.680], [-0.26, 0.680], [-0.33, 0.550], [-0.37, 0.300], [-0.33, 0.235], [-0.36, 0.220], [-0.40, 0.300], [-0.36, 0.560]], 0.004), 'chrome'),   // V-motion surround
      D('rear', 'trim', rrect(-0.04, 0.200, 0.04, 0.300, 0.006), 'light-red')   // centre fog
    ].concat(
      pairD('top', 'light', loop([[2.37, 0.48, 'c'], [2.30, 0.76], [2.18, 0.88, 'c'], [2.20, 0.74], [2.30, 0.40, 'c']]), 'light', 1),
      pairD('top', 'vent', rpoly([[1.08, 0.88], [1.12, 0.94], [0.92, 0.94], [0.88, 0.89]], 0.01), 'gloss-black', 1),
      pairD('front', 'mirror', loop([[0.72, 0.985, 'c'], [0.88, 0.995], [1.02, 1.005], [1.04, 1.050], [0.97, 1.085], [0.88, 1.080], [0.83, 1.030], [0.72, 1.018, 'c']]), 'body', 0),
      [0.70, 0.76, 0.82].reduce(function (acc, z) { return acc.concat(pairD('front', 'light', circ(z, 0.775 + (z - 0.70) * 0.30, 0.020), 'light', 0)); }, []),   // LED projectors
      pairD('front', 'trim', rrect(0.53, 0.300, 0.80, 0.312, 0.004), 'gloss-black', 0),
      // ring lamps: dark centre + small bright core
      ringPair('rear', 0.500, 0.935, 0.048, 'gloss-black'), ringPair('rear', 0.745, 0.935, 0.054, 'gloss-black'),
      ringPair('rear', 0.500, 0.935, 0.020, 'light-red'), ringPair('rear', 0.745, 0.935, 0.022, 'light-red'),
      [0, 0.22, -0.22, 0.38, -0.38].map(function (z) { return D('rear', 'trim', rrect(z - 0.008, 0.180, z + 0.008, 0.350, 0.004), 'carbon'); }),
      pairD('rear', 'spoiler', rrect(0.52, 1.085, 0.56, 1.122, 0.004), 'body', 0),
      pairD('rear', 'marker', rrect(0.80, 0.50, 0.90, 0.53, 0.006), 'light-red', 0),
      pairD('rear', 'mirror', loop([[0.95, 0.990, 'c'], [1.02, 1.005], [1.04, 1.050], [0.97, 1.085], [0.95, 1.08, 'c']]), 'body', 0)
    );

    var sections = buildSections({
      side: side, top: top, front: front, rear: rear, ref: ref, archF: aF, archR: aR, sillY: 0.165, xWS: 0.70, xBL: -1.92,
      belt: [[0.70, 0.955], [0.555, 0.985], [0.10, 0.992], [-0.60, 1.000], [-1.05, 1.017], [-1.25, 1.042], [-1.445, 1.085], [-1.70, 1.110], [-1.92, 1.090]],
      crest: [[2.40, 0.38, 0.60], [2.20, 0.78, 0.70], [1.80, 0.845, 0.74], [1.39, 0.885, 0.80], [0.90, 0.915, 0.86], [0.40, 0.94, 0.92], [-0.50, 0.96, 0.94],
        [-1.20, 0.99, 0.92], [-1.80, 1.05, 0.84], [-2.10, 1.075, 0.76], [-2.31, 1.00, 0.60]],
      dip: [[2.40, 0.0], [2.30, 0.03], [2.10, 0.05], [1.60, 0.05], [1.10, 0.03], [0.72, 0.0]],
      NV: 40, stations: 120
    });

    return {
      id: 'nissan-gtr-r35', make: 'Nissan', name: 'GT-R', gen: 'R35', years: '2017–', style: 'coupe',
      look: { head: 'slim-led', tail: 'quad-round', grille: 'mesh' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ice', doors: 2, ref: ref,
      color: '#d8d9db', colorName: 'Ultimate Metal Silver',
      wheel: { style: 'y-spoke', spokes: 6, caliper: '#1d1d1f' },
      side: side, top: top, front: front, rear: rear, details: details, sections: sections,
      signature: {
        headlights: 'Long swept LED headlamps with a lightning-bolt DRL and a triple projector row, outer ends wrapping the wing tops.',
        taillights: 'Four round ring tail lamps (two per side) with dark centres, set high under the boot wing.',
        grille: '2017 V-motion grille: narrow top under the badge, widening into a big mesh mouth with a matte-chrome surround, deep corner intakes, carbon chin.',
        notes: 'Muscular 2+2 coupe, twin bonnet creases, wing vents with a blade behind the front wheels, reverse-kink "blade" C-pillar, fixed rear wing, quad round titanium tailpipes in a finned diffuser; VR38DETT twin-turbo V6, ATTESA E-TS AWD, run-flat tyres.'
      },
      sources: ['Nissan GT-R (R35, MY2017): 4710 x 1895 x 1370 mm, wheelbase 2780 mm, track 1590/1600 mm, 255/40ZRF20 + 285/35ZRF20, 1752 kg, Cd 0.26']
    };
  }

  /* ------------------------------------------------------------------ */
  var list = [silviaS15(), skylineR34(), truenoAE86(), rx7FD(), gtrR35()];
  list.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { models: list };
})();

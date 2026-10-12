/* ==========================================================================
   FORGE Atelier — js/shapes/models/sedan.js
   Real-car shape models for body style 'sedan':
     - BMW M3 Competition (G80, 2021–)
     - Mercedes-AMG C 63 S E PERFORMANCE (W206, 2023–)
     - Tesla Model S (2021 refresh, "Palladium")

   Geometry is in metres at each car's real published size.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles, on the ground centreline.
   Side view = (x, y); top view = (x, z); front & rear views = (z, y).

   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}.
   Body silhouettes are hand-placed cubic beziers through landmarks taken from
   published dimensions and reference photography. Front/rear/top outlines
   are authored as the right half and mirrored, so they are exactly symmetric.
   Brand names are text only: no manufacturer logo artwork is drawn;
   badgeArea only marks where a text badge goes.

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
  var D2R = Math.PI / 180;
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function pt(a, b) { return [r4(a), r4(b)]; }

  /** Tiny path builder. */
  function PB() { this.s = []; this.x = 0; this.y = 0; this.sx = 0; this.sy = 0; }
  PB.prototype.M = function (x, y) { this.s.push({ t: 'M', p: [pt(x, y)] }); this.x = this.sx = x; this.y = this.sy = y; return this; };
  PB.prototype.L = function (x, y) { this.s.push({ t: 'L', p: [pt(x, y)] }); this.x = x; this.y = y; return this; };
  PB.prototype.C = function (x1, y1, x2, y2, x, y) { this.s.push({ t: 'C', p: [pt(x1, y1), pt(x2, y2), pt(x, y)] }); this.x = x; this.y = y; return this; };
  PB.prototype.Q = function (x1, y1, x, y) { this.s.push({ t: 'Q', p: [pt(x1, y1), pt(x, y)] }); this.x = x; this.y = y; return this; };
  PB.prototype.Z = function () { this.s.push({ t: 'Z', p: [] }); this.x = this.sx; this.y = this.sy; return this; };
  /** Circular arc (degrees, a0 → a1, either direction) as ≤90° cubic pieces. */
  PB.prototype.arc = function (cx, cy, r, a0, a1) {
    var n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90)), da = (a1 - a0) / n * D2R;
    var k = 4 / 3 * Math.tan(da / 4);
    var t0 = a0 * D2R, x0 = cx + r * Math.cos(t0), y0 = cy + r * Math.sin(t0);
    if (Math.abs(x0 - this.x) > 1e-5 || Math.abs(y0 - this.y) > 1e-5) this.L(x0, y0);
    for (var i = 0; i < n; i++) {
      var ta = t0 + da * i, tb = ta + da;
      var ax = cx + r * Math.cos(ta), ay = cy + r * Math.sin(ta), bx = cx + r * Math.cos(tb), by = cy + r * Math.sin(tb);
      this.C(ax - k * r * Math.sin(ta), ay + k * r * Math.cos(ta), bx + k * r * Math.sin(tb), by - k * r * Math.cos(tb), bx, by);
    }
    return this;
  };
  /** Wheel-arch cut-out travelling in +x along the body's lower edge: enters at height y0 (rear side), leaves at y1. */
  PB.prototype.arch = function (cx, cy, r, y0, y1) {
    var a0 = 180 + Math.asin((cy - y0) / r) / D2R, a1 = -Math.asin((cy - y1) / r) / D2R;
    return this.arc(cx, cy, r, a0, a1);
  };
  function P() { return new PB(); }
  /** Open circular arc path (starts with M). */
  function arcPath(cx, cy, r, a0, a1) { return P().M(cx + r * Math.cos(a0 * D2R), cy + r * Math.sin(a0 * D2R)).arc(cx, cy, r, a0, a1).s; }
  /** Closed band between radii r0 < r1 from a0 to a1 (wheel-arch flare lips). */
  function arcBand(cx, cy, r0, r1, a0, a1) {
    return P().M(cx + r1 * Math.cos(a0 * D2R), cy + r1 * Math.sin(a0 * D2R)).arc(cx, cy, r1, a0, a1).arc(cx, cy, r0, a1, a0).Z().s;
  }

  function mapPts(path, fn) { return path.map(function (s) { return { t: s.t, p: s.p.map(function (q) { var o = fn(q); return pt(o[0], o[1]); }) }; }); }
  /** Mirror copy (axis 0 → negate first coord, axis 1 → negate second coord). */
  function mirror(path, axis) { return mapPts(path, function (q) { return axis === 0 ? [-q[0], q[1]] : [q[0], -q[1]]; }); }
  /** Pair: [right-hand original, mirrored copy]. */
  function pair(path, axis) { return [path, mirror(path, axis)]; }

  /** Close a half outline that starts and ends on the symmetry axis by appending its reversed mirror. */
  function mirrorClosed(half, axis) {
    var segs = half.s || half, out = [], starts = [], cur = null;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].t === 'Z') break;
      starts.push(cur);
      out.push({ t: segs[i].t, p: segs[i].p.map(function (q) { return q.slice(); }) });
      cur = segs[i].p[segs[i].p.length - 1];
    }
    function m(q) { return axis === 0 ? pt(-q[0], q[1]) : pt(q[0], -q[1]); }
    for (var j = out.length - 1; j >= 1; j--) {
      var s = out[j], S = starts[j];
      if (s.t === 'L') out.push({ t: 'L', p: [m(S)] });
      else if (s.t === 'C') out.push({ t: 'C', p: [m(s.p[1]), m(s.p[0]), m(S)] });
      else if (s.t === 'Q') out.push({ t: 'Q', p: [m(s.p[0]), m(S)] });
    }
    out.push({ t: 'Z', p: [] });
    return out;
  }

  function ellipse(cx, cy, rx, ry) {
    var k = 0.5523;
    return P().M(cx + rx, cy).C(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry)
      .C(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy)
      .C(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry)
      .C(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy).Z().s;
  }
  function rrect(x0, y0, x1, y1, r) {
    var k = 0.5523 * r;
    return P().M(x0 + r, y0).L(x1 - r, y0).C(x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r)
      .L(x1, y1 - r).C(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1)
      .L(x0 + r, y1).C(x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r)
      .L(x0, y0 + r).C(x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0).Z().s;
  }
  /** Open polyline. */
  function line(pts) { var b = P().M(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) b.L(pts[i][0], pts[i][1]); return b.s; }
  /** Closed polygon. */
  function poly(pts) { var b = P().M(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) b.L(pts[i][0], pts[i][1]); return b.Z().s; }
  /** Closed ribbon of width w around a polyline (light strips, DRL signatures, slats). */
  function strip(pts, w) {
    var Lft = [], Rgt = [], n = pts.length;
    for (var i = 0; i < n; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      var tx = b[0] - a[0], ty = b[1] - a[1], l = Math.sqrt(tx * tx + ty * ty) || 1;
      var nx = -ty / l * w / 2, ny = tx / l * w / 2;
      Lft.push([pts[i][0] + nx, pts[i][1] + ny]); Rgt.push([pts[i][0] - nx, pts[i][1] - ny]);
    }
    return poly(Lft.concat(Rgt.reverse()));
  }

  /** Flatten a single closed path to a polygon. */
  function sample(path, steps) {
    steps = steps || 20;
    var out = [], cur = [0, 0];
    path.forEach(function (s) {
      var p = s.p;
      if (s.t === 'M' || s.t === 'L') { cur = p[0]; out.push(cur.slice()); }
      else if (s.t === 'C') {
        for (var i = 1; i <= steps; i++) {
          var t = i / steps, u = 1 - t;
          out.push([u * u * u * cur[0] + 3 * u * u * t * p[0][0] + 3 * u * t * t * p[1][0] + t * t * t * p[2][0],
            u * u * u * cur[1] + 3 * u * u * t * p[0][1] + 3 * u * t * t * p[1][1] + t * t * t * p[2][1]]);
        }
        cur = p[2];
      } else if (s.t === 'Q') {
        for (var j = 1; j <= steps; j++) {
          var tq = j / steps, uq = 1 - tq;
          out.push([uq * uq * cur[0] + 2 * uq * tq * p[0][0] + tq * tq * p[1][0], uq * uq * cur[1] + 2 * uq * tq * p[0][1] + tq * tq * p[1][1]]);
        }
        cur = p[1];
      }
    });
    return out;
  }
  /** Sutherland–Hodgman clip: keep points on the left of a→b. */
  function clipHalf(pl, a, b) {
    function side(q) { return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]); }
    var out = [];
    for (var i = 0; i < pl.length; i++) {
      var P0 = pl[i], P1 = pl[(i + 1) % pl.length], s0 = side(P0), s1 = side(P1);
      if (s0 >= 0) out.push(P0);
      if ((s0 >= 0) !== (s1 >= 0)) { var t = s0 / (s0 - s1); out.push([P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t]); }
    }
    return out;
  }
  /** Shrink a polygon toward its centroid-ish by a fixed offset (approximate inset for glass inside its frame). */
  function inset(pl, d) {
    var n = pl.length, area = 0;
    for (var i = 0; i < n; i++) { var a = pl[i], b = pl[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    var sgn = area > 0 ? 1 : -1, out = [];
    for (var j = 0; j < n; j++) {
      var p0 = pl[(j - 1 + n) % n], p1 = pl[j], p2 = pl[(j + 1) % n];
      var e0 = [p1[0] - p0[0], p1[1] - p0[1]], e1 = [p2[0] - p1[0], p2[1] - p1[1]];
      var l0 = Math.hypot(e0[0], e0[1]) || 1, l1 = Math.hypot(e1[0], e1[1]) || 1;
      var n0 = [-e0[1] / l0 * sgn, e0[0] / l0 * sgn], n1 = [-e1[1] / l1 * sgn, e1[0] / l1 * sgn];
      var nx = n0[0] + n1[0], ny = n0[1] + n1[1], nl = Math.hypot(nx, ny) || 1;
      var cos = (n0[0] * n1[0] + n0[1] * n1[1] + 1) / 2, sc = d / Math.sqrt(Math.max(0.25, cos));
      out.push([p1[0] + nx / nl * sc, p1[1] + ny / nl * sc]);
    }
    return out;
  }
  function dedupe(pl) {
    var out = [];
    pl.forEach(function (q) { var l = out[out.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.004) out.push(q); });
    // closed polygon: drop a trailing vertex that repeats the first (zero-length closing edge breaks inset normals)
    while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.004) out.pop();
    return out;
  }
  /** Region of a closed path between two cut lines; each cut is [bottomPoint, topPoint]; front cut has larger x. */
  function between(path, frontCut, rearCut, ins) {
    var pl = sample(path, 24);
    if (frontCut) pl = clipHalf(pl, frontCut[0], frontCut[1]);
    if (rearCut) pl = clipHalf(pl, rearCut[1], rearCut[0]);
    pl = dedupe(pl);
    if (ins) pl = inset(pl, ins);
    return poly(pl);
  }
  /** Frame ring around a closed path (outer outline + reversed inset hole): fills correctly under nonzero and evenodd. */
  function ring(path, w) {
    var hole = inset(dedupe(sample(path, 24)), w).reverse();
    return path.filter(function (sg) { return sg.t !== 'Z'; }).concat([{ t: 'Z', p: [] }], poly(hole));
  }
  /** Shift a cut line along x. */
  function shiftCut(c, dx) { return [[c[0][0] + dx, c[0][1]], [c[1][0] + dx, c[1][1]]]; }

  /** Plan-view (x,z) outline from landmarks; widest exactly at the axles.
      Optional: halfWF / halfWR (per-axle haunch half-widths, default halfW),
      tailCorner [x,z] and tailHandle [x,z] (rear-corner on-curve point and its incoming handle;
      the outgoing handle is kept collinear so the corner stays G1-smooth). */
  function planOutline(o) {
    var hF = o.halfWF || o.halfW, hR = o.halfWR || o.halfW, th = o.tailHalf;
    var tc = o.tailCorner || [o.xR + o.tailRound * 0.45, th + (hR - th) * 0.3];
    var tk = o.tailHandle || [o.xR + o.tailRound, hR - 0.015];
    var t1;
    if (o.tailCorner) {
      var dx = tc[0] - tk[0], dz = tc[1] - tk[1], k = Math.min(0.6, Math.abs(tc[0] - o.xR) * 0.7 / (Math.abs(dx) || 1));
      t1 = [tc[0] + dx * k, tc[1] + dz * k];
    } else t1 = [o.xR + o.tailRound * 0.12, th * 0.95];
    var b = P().M(o.xF, 0)
      .C(o.xF, o.noseHalf * 0.55, o.xF - o.noseRound * 0.15, o.noseHalf * 0.95, o.xF - o.noseRound * 0.5, o.noseHalf + (hF - o.noseHalf) * 0.35)
      .C(o.xF - o.noseRound, hF - 0.012, o.axF + 0.42, hF, o.axF, hF)
      .C(o.axF - 0.40, hF, o.axF * 0.55, o.waist, 0, o.waist)
      .C(o.axR * 0.55, o.waist, o.axR + 0.40, hR, o.axR, hR)
      .C(o.axR - 0.42, hR, tk[0], tk[1], tc[0], tc[1])
      .C(t1[0], t1[1], o.xR, th * 0.55, o.xR, 0);
    return mirrorClosed(b, 1);
  }
  /** Plan-view greenhouse at belt height. Its x extent is exactly [xr, xf], the side-view DLO ends,
      so sectionsFromViews sees the same cabin length in both views. zf/zm/zr are half-widths
      at the A-pillar base, mid-cabin and C-pillar base. */
  function ghPlan(xf, xr, zf, zm, zr) {
    return mirrorClosed(P().M(xf, 0).C(xf, zf * 0.6, xf - 0.012, zf * 0.92, xf - 0.07, zf)
      .C(xf - 0.55, zm, xr + 0.70, zm, xr + 0.12, zr)
      .C(xr + 0.03, zr * 0.92, xr, zr * 0.6, xr, 0), 1);
  }
  /** Black mirror foot (sail) at the A-pillar / belt corner: ~0.08 x 0.05. */
  function mirrorFoot(x, y) {
    return { view: 'side', role: 'mirrorArm', paint: 'black', path: P().M(x - 0.040, y - 0.022).L(x + 0.030, y - 0.026)
      .C(x + 0.040, y - 0.026, x + 0.042, y - 0.018, x + 0.040, y - 0.010).L(x + 0.020, y + 0.024)
      .C(x + 0.016, y + 0.028, x + 0.010, y + 0.028, x + 0.004, y + 0.026).L(x - 0.034, y + 0.010)
      .C(x - 0.042, y + 0.006, x - 0.044, y - 0.016, x - 0.040, y - 0.022).Z().s };
  }
  /** Translate a path. */
  function shift(path, dx, dy) { return mapPts(path, function (q) { return [q[0] + dx, q[1] + dy]; }); }
  /** Front/rear-view (z,y) body cross-silhouette; widest exactly at shoulderY. */
  function crossOutline(o) {
    var b = P().M(0, o.H)
      .C(o.roofHalf * 0.5, o.H, o.roofHalf * 0.85, o.H - 0.006, o.roofHalf, o.H - 0.024)
      .C(o.roofHalf + 0.07, o.H - 0.05, o.beltHalf - 0.045, o.beltY + 0.16, o.beltHalf, o.beltY)
      .C(o.beltHalf + 0.045, o.beltY - 0.015, o.halfW, o.beltY - 0.07, o.halfW, o.shoulderY)
      .C(o.halfW - (o.cornerIn || 0) * 0.4, o.shoulderY - 0.16, o.halfW - 0.004 - (o.cornerIn || 0) * 1.9, o.lowY + 0.14, o.lowHalf, o.lowY)
      .C(o.lowHalf - 0.02, o.bottomY + 0.02, o.bottomHalf + 0.06, o.bottomY, o.bottomHalf, o.bottomY)
      .L(0, o.bottomY);
    return mirrorClosed(b, 0);
  }
  function tireR(spec) {
    var m = /^(\d+)\/(\d+)\s*Z?R(\d+)/.exec(spec);
    return (+m[3] * 0.0254 + 2 * (+m[1]) * (+m[2]) / 100 / 1000) / 2;
  }
  /** Vertical-ish slats inside a box (grille bars). */
  function vSlats(z0, z1, n, y0, y1, w, lean) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var z = z0 + (z1 - z0) * (n === 1 ? 0.5 : i / (n - 1));
      out.push(strip([[z - (lean || 0), y0], [z, y1]], w));
    }
    return out;
  }
  function hSlats(z0, z1, ys, w) { return ys.map(function (y) { return strip([[z0, y], [z1, y]], w); }); }

  /* ================================================================== */
  /* BMW M3 Competition (G80)                                            */
  /* ================================================================== */
  function bmwM3() {
    var WB = 2.857, FOH = 0.862, ROH = 1.075, axF = WB / 2, axR = -WB / 2;
    var xF = axF + FOH, xR = axR - ROH;               // 2.2905, -2.5035
    var tF = '275/35R19', tR = '285/30R20', rF = tireR(tF), rR = tireR(tR);
    var aF = { x: axF, y: rF, r: rF + 0.036, flare: 0.022 }, aR = { x: axR, y: rR, r: rR + 0.036, flare: 0.024 };
    var sill = 0.165, H = 1.433, W2 = 1.903 / 2;

    var body = P().M(2.248, 0.120).L(2.272, 0.150)
      .C(2.285, 0.22, xF, 0.36, xF, 0.46)                       // bumper face
      .C(xF, 0.60, 2.289, 0.735, 2.284, 0.800)                   // tall, near-vertical kidney face
      .C(2.276, 0.838, 2.225, 0.856, 2.150, 0.862)                // high, upright bonnet leading edge
      .C(1.75, 0.900, 1.15, 0.955, 0.820, 0.985)                  // power-dome bonnet
      .C(0.71, 0.995, 0.65, 1.002, 0.605, 1.010)                  // cowl
      .C(0.30, 1.150, 0.05, 1.335, -0.100, 1.395)                 // windscreen
      .C(-0.22, 1.425, -0.38, H, -0.52, H)                        // roof peak (carbon roof)
      .C(-0.80, H, -1.02, 1.416, -1.200, 1.376)                   // roof to rear header
      .C(-1.45, 1.305, -1.70, 1.130, -1.880, 1.045)               // backlight
      .C(-2.00, 1.024, -2.25, 1.018, -2.400, 1.022)               // short, low boot deck
      .C(-2.430, 1.024, -2.458, 1.031, -2.470, 1.040)             // integrated lip spoiler
      .C(-2.474, 1.010, -2.478, 0.960, -2.480, 0.920)             // near-vertical tail face
      .C(-2.483, 0.780, -2.486, 0.600, -2.488, 0.450)
      .C(-2.489, 0.360, -2.478, 0.290, -2.445, 0.255)             // tuck under to the diffuser
      .C(-2.425, 0.240, -2.400, 0.238, -2.360, 0.238)             // diffuser lower edge
      .L(-1.80, 0.238)
      .arch(aR.x, aR.y, aR.r, 0.238, sill)
      .L(axF - Math.sqrt(aF.r * aF.r - (aF.y - sill) * (aF.y - sill)), sill)
      .arch(aF.x, aF.y, aF.r, sill, 0.205)
      .L(1.95, 0.170).C(2.10, 0.145, 2.20, 0.124, 2.248, 0.120).Z().s;

    // DLO with the Hofmeister kink
    var dlo = P().M(0.505, 0.998)
      .C(0.32, 1.100, 0.10, 1.272, -0.120, 1.350)
      .C(-0.32, 1.386, -0.62, 1.390, -0.860, 1.378)
      .C(-1.06, 1.366, -1.26, 1.326, -1.420, 1.240)
      .C(-1.500, 1.192, -1.562, 1.150, -1.590, 1.128)             // C-pillar trailing edge coming down...
      .C(-1.605, 1.117, -1.604, 1.103, -1.589, 1.096)             // ...tight (r ~0.02) turn: the Hofmeister kink
      .L(-1.505, 1.047)                                           // hooks sharply forward
      .C(-1.495, 1.042, -1.480, 1.040, -1.460, 1.040)
      .C(-1.00, 1.028, 0.00, 1.004, 0.505, 0.998).Z().s;
    var bF = [[-0.300, 1.0], [-0.335, 1.40]], bR = [[-0.385, 1.0], [-0.420, 1.40]];     // B-pillar
    var qF = [[-1.200, 1.0], [-1.235, 1.40]], qR = [[-1.232, 1.0], [-1.267, 1.40]];     // rear door / quarter divider
    var windows = [
      between(dlo, null, bF, 0.012),
      between(dlo, bR, qF, 0.012),
      between(dlo, qR, null, 0.012)
    ];
    var pillars = [between(dlo, bF, bR), between(dlo, qF, qR)];

    var side = {
      body: body, greenhouse: dlo, windows: windows, pillars: pillars,
      doorCuts: [
        line([[0.500, 1.000], [0.565, 0.960]]).concat(P().M(0.565, 0.960).C(0.80, 0.86, 0.985, 0.72, 0.995, 0.55).L(0.990, sill + 0.012).s),
        line([[-0.360, 1.012], [-0.360, sill + 0.01]]),
        P().M(-1.290, 1.040).C(-1.250, 0.900, -1.120, 0.760, -1.035, 0.640).C(-1.010, 0.600, -1.000, 0.540, -1.000, sill + 0.01).s
      ],
      panelLines: [
        P().M(2.165, 0.853).C(1.75, 0.888, 1.20, 0.940, 0.80, 0.975).s,                    // bonnet shut line on fender top
        P().M(-1.895, 1.036).C(-2.00, 1.012, -2.10, 0.995, -2.150, 0.975).s,                // boot lid
        rrect(-1.835, 0.835, -1.700, 0.935, 0.018),                                          // fuel flap (right rear quarter)
        P().M(2.288, 0.540).C(2.10, 0.520, 1.95, 0.510, 1.82, 0.505).s                       // bumper/fender seam
      ],
      characterLines: [
        P().M(2.050, 0.805).C(1.20, 0.850, -0.80, 0.900, -2.240, 0.935).s,                   // shoulder line rising to tail-lamp
        P().M(1.000, 0.360).C(0.30, 0.375, -0.50, 0.425, -1.100, 0.500).s,                   // G80 'dynamic' lower swage kicking up into the rear door
        P().M(0.980, 0.348).C(0.30, 0.362, -0.50, 0.410, -1.080, 0.484).s                    // its shadow edge (makes the swage read as a crease)
      ],
      sill: poly([[-1.030, sill], [1.040, sill], [1.035, sill + 0.05], [-1.025, sill + 0.05]]),
      archF: aF, archR: aR,
      lowerTrim: [
        poly([[-1.040, sill], [1.050, sill], [1.050, sill + 0.02], [-1.040, sill + 0.02]]),  // carbon side-skirt blade
        P().M(2.248, 0.120).L(2.272, 0.150).L(2.000, 0.168).L(1.98, 0.150).C(2.10, 0.135, 2.20, 0.124, 2.248, 0.120).Z().s,
        P().M(-2.445, 0.255).C(-2.425, 0.240, -2.400, 0.238, -2.360, 0.238).L(-1.85, 0.238).L(-1.86, 0.300).L(-2.470, 0.300).Z().s
      ]
    };

    var top = {
      body: planOutline({ xF: xF, xR: xR, axF: axF, axR: axR, halfW: W2, waist: W2 - 0.016, noseHalf: 0.72, noseRound: 0.20, tailHalf: 0.80, tailRound: 0.16,
        tailCorner: [-2.405, 0.800], tailHandle: [-2.300, 0.935] }),                       // tail tapers in plan (no square corners)
      greenhouse: ghPlan(0.505, -1.601, 0.800, 0.862, 0.735),                            // same x span as the side DLO
      characterLines: pair(P().M(2.000, 0.180).C(1.60, 0.205, 1.10, 0.265, 0.750, 0.300).s, 1)            // power-dome creases
        .concat(pair(P().M(1.960, 0.120).C(1.55, 0.140, 1.10, 0.185, 0.800, 0.210).s, 1)),
      hood: mirrorClosed(P().M(2.115, 0).C(2.115, 0.40, 2.095, 0.64, 2.040, 0.700).C(1.60, 0.745, 1.10, 0.762, 0.700, 0.760).L(0.680, 0), 1),
      roof: mirrorClosed(P().M(-0.090, 0).C(-0.090, 0.35, -0.080, 0.580, -0.130, 0.615).C(-0.50, 0.640, -0.90, 0.630, -1.180, 0.600).C(-1.205, 0.45, -1.205, 0.20, -1.205, 0), 1),
      deck: mirrorClosed(P().M(-1.880, 0).L(-1.880, 0.620).C(-2.100, 0.700, -2.350, 0.700, -2.440, 0.620).C(-2.460, 0.40, -2.460, 0.20, -2.460, 0), 1),
      mirrors: pair(P().M(0.690, 0.860).C(0.700, 0.930, 0.675, 1.010, 0.620, 1.034).C(0.570, 1.040, 0.510, 1.020, 0.490, 0.975).L(0.515, 0.870).Z().s, 1)
    };

    var front = {
      // M3 front bumper corners pulled inboard (deep air-curtain recesses) so the face reads narrower low down than the AMG
      body: crossOutline({ H: H, roofHalf: 0.560, beltY: 1.000, beltHalf: 0.865, halfW: W2, shoulderY: 0.700, lowY: 0.160, lowHalf: 0.860, bottomY: 0.120, bottomHalf: 0.790, cornerIn: 0.03 }),
      greenhouse: mirrorClosed(P().M(0, 1.392).C(0.30, 1.392, 0.52, 1.384, 0.570, 1.368).C(0.640, 1.250, 0.700, 1.100, 0.720, 1.008).C(0.50, 1.000, 0.25, 0.996, 0, 0.996), 0),
      bumper: mirrorClosed(P().M(0, 0.700).L(0.360, 0.700).L(0.420, 0.690).C(0.65, 0.680, 0.86, 0.690, 0.935, 0.700).C(0.930, 0.500, 0.890, 0.250, 0.860, 0.160).C(0.845, 0.140, 0.845, 0.120, 0.790, 0.120).L(0, 0.120), 0),
      // tall G80 kidneys: 0.30 wide x 0.50 tall, top edge sloping up toward the centre, bottom slightly wider
      grille: pair(P().M(0.040, 0.330).L(0.040, 0.802).C(0.040, 0.822, 0.052, 0.832, 0.070, 0.830).L(0.312, 0.785)
        .C(0.326, 0.782, 0.334, 0.772, 0.334, 0.758).L(0.344, 0.335).C(0.344, 0.312, 0.330, 0.300, 0.310, 0.300)
        .L(0.070, 0.300).C(0.052, 0.300, 0.040, 0.310, 0.040, 0.330).Z().s, 0),
      intakes: pair(P().M(0.545, 0.520).L(0.830, 0.565).C(0.860, 0.568, 0.882, 0.548, 0.880, 0.515).L(0.868, 0.300)
        .C(0.864, 0.258, 0.840, 0.230, 0.800, 0.226).L(0.600, 0.216).C(0.560, 0.214, 0.540, 0.240, 0.536, 0.280).Z().s, 0)
        .concat([mirrorClosed(P().M(0, 0.288).L(0.420, 0.284).C(0.470, 0.282, 0.500, 0.268, 0.500, 0.245).L(0.490, 0.185)
          .C(0.484, 0.165, 0.465, 0.158, 0.430, 0.158).L(0, 0.158), 0)]),
      // angular G80 lamp: ~0.12 tall at the outer end, near-flat top at ~0.80-0.815, inner end a 0.10 tall
      // blunt tip (z 0.36, y 0.70-0.80) dropping beside the kidney's upper-outer corner
      headlights: pair(P().M(0.360, 0.800).L(0.600, 0.815).L(0.858, 0.806).C(0.882, 0.805, 0.896, 0.792, 0.896, 0.774)
        .L(0.893, 0.700).C(0.892, 0.688, 0.884, 0.682, 0.870, 0.682).L(0.640, 0.700).L(0.470, 0.712)
        .C(0.420, 0.712, 0.385, 0.700, 0.372, 0.700).C(0.364, 0.700, 0.360, 0.704, 0.360, 0.712).Z().s, 0),
      // two inverted-L DRL light guides per lamp (~0.20 x 0.06 each)
      drl: [].concat(pair(strip([[0.420, 0.740], [0.420, 0.796], [0.620, 0.808]], 0.012), 0),
        pair(strip([[0.665, 0.720], [0.665, 0.778], [0.860, 0.792]], 0.012), 0)),
      splitter: mirrorClosed(P().M(0, 0.158).L(0.840, 0.158).C(0.872, 0.152, 0.872, 0.126, 0.850, 0.120).L(0, 0.120), 0),
      plateArea: rrect(-0.260, 0.220, 0.260, 0.330, 0.01),                                  // on the lower bumper bar: full kidney reads
      badgeArea: rrect(-0.036, 0.836, 0.036, 0.874, 0.018),
      badgeText: 'BMW'
    };

    var rear = {
      body: crossOutline({ H: H, roofHalf: 0.560, beltY: 1.030, beltHalf: 0.860, halfW: W2, shoulderY: 0.780, lowY: 0.280, lowHalf: 0.910, bottomY: 0.238, bottomHalf: 0.840 }),
      greenhouse: mirrorClosed(P().M(0, 1.362).C(0.30, 1.362, 0.50, 1.352, 0.550, 1.336).C(0.600, 1.250, 0.640, 1.130, 0.660, 1.070).C(0.40, 1.066, 0.20, 1.064, 0, 1.064), 0),
      bumper: mirrorClosed(P().M(0, 0.740).L(0.400, 0.740).C(0.60, 0.750, 0.85, 0.800, 0.940, 0.820).C(0.950, 0.600, 0.940, 0.360, 0.910, 0.280).C(0.890, 0.250, 0.880, 0.238, 0.840, 0.238).L(0, 0.238), 0),
      // L-shaped lamp: inner horizontal leg ends at z 0.42 (y 0.93-0.99), outer vertical leg y 0.82-1.00
      taillights: pair(P().M(0.420, 0.945).C(0.420, 0.980, 0.430, 0.990, 0.450, 0.990).L(0.880, 1.000)
        .C(0.915, 1.000, 0.932, 0.985, 0.935, 0.960).L(0.936, 0.850).C(0.936, 0.832, 0.926, 0.820, 0.905, 0.820)
        .L(0.815, 0.820).C(0.795, 0.820, 0.785, 0.832, 0.784, 0.850).L(0.780, 0.915).C(0.778, 0.926, 0.770, 0.930, 0.755, 0.930)
        .L(0.440, 0.930).C(0.428, 0.930, 0.420, 0.935, 0.420, 0.945).Z().s, 0),
      lightBar: null,
      diffuser: mirrorClosed(P().M(0, 0.370).L(0.670, 0.370).C(0.690, 0.370, 0.700, 0.360, 0.700, 0.345).L(0.700, 0.238).L(0, 0.238), 0),
      exhaust: [{ shape: 'round', cx: -0.560, cy: 0.300, w: 0.100, h: 0.100 }, { shape: 'round', cx: -0.432, cy: 0.300, w: 0.100, h: 0.100 },
        { shape: 'round', cx: 0.432, cy: 0.300, w: 0.100, h: 0.100 }, { shape: 'round', cx: 0.560, cy: 0.300, w: 0.100, h: 0.100 }],
      plateArea: rrect(-0.260, 0.590, 0.260, 0.700, 0.01),
      badgeArea: rrect(-0.040, 0.880, 0.040, 0.940, 0.02),
      badgeText: 'BMW',
      // M3 Competition boot-lid gurney lip: 0.02 tall across z +/-0.55, top at y 1.055
      spoiler: rrect(-0.550, 1.035, 0.550, 1.062, 0.006)
    };

    var details = pillars.map(function (pl) { return { view: 'side', role: 'trim', paint: 'gloss-black', path: pl }; }).concat([
      // M twin-stalk mirror: black foot on the A-pillar / belt corner (0.505, 0.998), two 0.02 stalks, housing above
      mirrorFoot(0.505, 0.990),
      { view: 'side', role: 'mirrorArm', paint: 'black', path: strip([[0.488, 0.995], [0.478, 1.050]], 0.020) },
      { view: 'side', role: 'mirrorArm', paint: 'black', path: strip([[0.530, 0.995], [0.538, 1.050]], 0.020) },
      { view: 'side', role: 'mirror', paint: 'body', path: P().M(0.432, 1.030).C(0.450, 1.074, 0.505, 1.104, 0.590, 1.106).C(0.660, 1.108, 0.695, 1.078, 0.690, 1.048).C(0.687, 1.030, 0.650, 1.026, 0.590, 1.028).Z().s },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(0.020, 0.880, 0.190, 0.910, 0.014) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(-0.880, 0.900, -0.715, 0.930, 0.014) },
      { view: 'side', role: 'vent', paint: 'gloss-black', path: P().M(1.205, 0.680).C(1.214, 0.688, 1.216, 0.700, 1.210, 0.708).L(1.065, 0.733).C(1.052, 0.735, 1.045, 0.726, 1.046, 0.716).L(1.050, 0.708).Z().s },   // M 'gill' fender vent, slanting up rearward
      { view: 'side', role: 'trim', paint: 'chrome', path: strip([[1.195, 0.694], [1.060, 0.719]], 0.006) },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: ring(dlo, 0.014) },                                                                         // M Shadowline DLO surround
      // headlight wraps round the corner and runs back along the fender top under the bonnet shut line
      { view: 'side', role: 'headlight', paint: 'light', path: P().M(2.284, 0.800).C(2.230, 0.828, 2.120, 0.842, 1.960, 0.850).L(1.990, 0.826).C(2.100, 0.808, 2.200, 0.780, 2.287, 0.752).Z().s },
      // M Competition boot-lid lip: 0.03 kick at the deck end
      { view: 'side', role: 'spoiler', paint: 'carbon', path: P().M(-2.300, 1.018).C(-2.380, 1.022, -2.440, 1.036, -2.484, 1.064).L(-2.488, 1.056).C(-2.480, 1.044, -2.474, 1.034, -2.471, 1.026).C(-2.420, 1.018, -2.360, 1.012, -2.300, 1.012).Z().s },
      { view: 'side', role: 'taillight', paint: 'light-red', path: P().M(-2.472, 1.002).C(-2.350, 1.006, -2.200, 0.998, -2.120, 0.985).C(-2.150, 0.950, -2.260, 0.900, -2.479, 0.875).Z().s },
      { view: 'side', role: 'intake', paint: 'black', path: P().M(2.272, 0.520).C(2.220, 0.505, 2.160, 0.470, 2.130, 0.420).L(2.150, 0.250).C(2.200, 0.240, 2.250, 0.235, 2.282, 0.240).Z().s },
      { view: 'side', role: 'antenna', paint: 'body', path: P().M(-1.020, 1.410).C(-1.060, 1.428, -1.110, 1.430, -1.150, 1.400).Z().s },
      { view: 'side', role: 'trim', paint: 'carbon', path: P().M(-0.130, 1.404).C(-0.25, 1.428, -0.40, 1.432, -0.52, 1.432).C(-0.80, 1.432, -1.00, 1.414, -1.180, 1.378).L(-1.170, 1.372).C(-0.95, 1.408, -0.70, 1.424, -0.52, 1.424).C(-0.38, 1.424, -0.25, 1.420, -0.140, 1.398).Z().s },
      { view: 'top', role: 'trim', paint: 'carbon', path: top.roof },
      { view: 'top', role: 'glass', paint: 'glass', path: mirrorClosed(P().M(0.620, 0).C(0.620, 0.40, 0.600, 0.650, 0.540, 0.700).C(0.300, 0.690, 0.050, 0.640, -0.080, 0.600).L(-0.085, 0), 1) },
      { view: 'top', role: 'glass', paint: 'glass', path: mirrorClosed(P().M(-1.210, 0).L(-1.210, 0.600).C(-1.450, 0.640, -1.700, 0.660, -1.860, 0.640).L(-1.865, 0), 1) },
      { view: 'top', role: 'vent', paint: 'body', path: mirrorClosed(P().M(2.030, 0).C(2.030, 0.100, 2.010, 0.172, 1.960, 0.180).C(1.600, 0.205, 1.100, 0.268, 0.800, 0.300).C(0.755, 0.304, 0.740, 0.200, 0.740, 0), 1) },  // long tapering power dome
      { view: 'front', role: 'mirror', paint: 'body', path: shift(P().M(0.880, 0.990).L(1.020, 1.000).C(1.040, 1.040, 1.040, 1.100, 1.010, 1.125).L(0.900, 1.130).C(0.880, 1.100, 0.875, 1.030, 0.880, 0.990).Z().s, 0, -0.02) },
      { view: 'front', role: 'mirror', paint: 'body', path: mirror(shift(P().M(0.880, 0.990).L(1.020, 1.000).C(1.040, 1.040, 1.040, 1.100, 1.010, 1.125).L(0.900, 1.130).C(0.880, 1.100, 0.875, 1.030, 0.880, 0.990).Z().s, 0, -0.02), 0) }
    ]);
    // kidney slats: two bold horizontal bars per kidney (gloss black, drawn over the grille mesh) and intake blades
    hSlats(0.050, 0.336, [0.480, 0.620], 0.022).forEach(function (s) {
      details.push({ view: 'front', role: 'grille', paint: 'gloss-black', path: s });
      details.push({ view: 'front', role: 'grille', paint: 'gloss-black', path: mirror(s, 0) });
    });
    pair(strip([[0.795, 0.232], [0.808, 0.545]], 0.022), 0).forEach(function (s) { details.push({ view: 'front', role: 'intake', paint: 'gloss-black', path: s }); });
    // air-curtain wing sweeping under the headlight
    pair(strip([[0.440, 0.548], [0.640, 0.562], [0.900, 0.610]], 0.022), 0).forEach(function (s) { details.push({ view: 'front', role: 'intake', paint: 'gloss-black', path: s }); });
    vSlats(-0.33, 0.33, 7, 0.240, 0.360, 0.012).forEach(function (s) { details.push({ view: 'rear', role: 'trim', paint: 'carbon', path: s }); });
    pair(strip([[0.445, 0.962], [0.880, 0.972], [0.908, 0.840]], 0.012), 0).forEach(function (s) { details.push({ view: 'rear', role: 'taillight', paint: 'light-red', path: s }); });
    details.push({ view: 'rear', role: 'taillight', paint: 'light-red', path: rrect(-0.120, 1.330, 0.120, 1.345, 0.006) });   // third brake light

    return {
      id: 'bmw-m3-g80', make: 'BMW', name: 'M3 Competition', gen: 'G80', years: '2021–', style: 'sedan',
      look: { head: 'slim-led', tail: 'slim', grille: 'kidney' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice',
      ref: { length: 4.794, width: 1.903, height: H, wheelbase: WB, trackF: 1.617, trackR: 1.605, frontOverhang: FOH, rearOverhang: ROH,
        wheelDiameter_in: 19, wheelDiameterR_in: 20, tireF: tF, tireR: tR, groundClearance: 0.120, rideHeight: sill, cd: 0.34, curbWeight_kg: 1730 },
      side: side, top: top, front: front, rear: rear, details: details,
      // per-model wheel design hint for renderers (no artwork drawn here)
      wheel: { spokes: 10, finish: '#2b2d30', caliper: '#1d4f9c' },                // read by shapes-preview
      wheelStyle: { type: 'y-spoke', spokes: 5, split: 2, finish: 'gloss-black', centreHub: 'cap', note: 'M forged double/Y-spoke (style 826M/827M), 19 in front / 20 in rear' },
      signature: {
        wheels: 'M forged Y-spoke wheels, staggered 19/20 in, gloss black.',
        headlights: 'Slim twin-L LED headlights, inner ends dropping onto the kidney tops; two inverted-L DRL light guides per side.',
        taillights: 'Dark L-shaped 3D tail-lamps wrapping from the rear quarters onto the boot lid.',
        grille: 'Tall vertical M kidney grille reaching from bonnet edge to the bumper with horizontal double slats; plate mounted across the lower kidneys.',
        notes: 'Power-dome bonnet, M gill vent behind front arch, Hofmeister kink, carbon roof, lip spoiler, carbon diffuser with quad 100 mm round tailpipes.'
      }
    };
  }

  /* ================================================================== */
  /* Mercedes-AMG C 63 S E PERFORMANCE (W206)                            */
  /* ================================================================== */
  function amgC63() {
    var WB = 2.875, FOH = 0.880, ROH = 1.087, axF = WB / 2, axR = -WB / 2;
    var xF = axF + FOH, xR = axR - ROH;               // 2.3175, -2.5245
    var tF = '265/35R20', tR = '275/35R20', rF = tireR(tF), rR = tireR(tR);
    // widened AMG wings: front flare 0.035 (wings ~76 mm wider than a C-Class), rear 0.031
    var aF = { x: axF, y: rF, r: rF + 0.036, flare: 0.035 }, aR = { x: axR, y: rR, r: rR + 0.034, flare: 0.031 };
    var sill = 0.170, H = 1.458, W2 = 1.900 / 2;

    var body = P().M(2.275, 0.110).L(2.298, 0.140)
      .C(2.312, 0.220, xF, 0.340, xF, 0.450)
      .C(xF, 0.560, xF - 0.002, 0.660, 2.298, 0.730)               // Panamericana nose, slight forward lean
      .C(2.278, 0.792, 2.220, 0.830, 2.140, 0.846)
      .C(1.75, 0.893, 1.10, 0.975, 0.700, 1.012)                     // long bonnet, cab-backward
      .C(0.640, 1.018, 0.590, 1.024, 0.550, 1.030)                   // screen base set well back
      .C(0.260, 1.205, -0.040, 1.380, -0.220, 1.428)                 // long, steeply raked A-pillar run
      .C(-0.320, 1.452, -0.390, H, -0.450, H)                        // roof peak further forward than the M3
      .C(-0.850, H, -1.400, 1.400, -1.750, 1.240)                   // one continuous C-pillar arc ...
      .C(-1.880, 1.180, -1.970, 1.118, -2.050, 1.090)               // ... flowing into the deck (no backlight break)
      .C(-2.130, 1.072, -2.320, 1.062, -2.440, 1.065)               // short deck
      .C(-2.470, 1.067, -2.490, 1.075, -2.496, 1.082)               // AMG boot-lid spoiler lip
      .C(-2.500, 1.050, -2.503, 1.000, -2.505, 0.960)               // near-vertical tail face (<= 0.02 lean)
      .C(-2.509, 0.800, -2.513, 0.600, -2.516, 0.450)
      .C(-2.518, 0.360, -2.500, 0.290, -2.462, 0.255)               // tuck 0.06 under to the diffuser
      .C(-2.440, 0.236, -2.410, 0.230, -2.370, 0.230)
      .L(-1.82, 0.230)
      .arch(aR.x, aR.y, aR.r, 0.230, sill)
      .L(axF - Math.sqrt(aF.r * aF.r - (aF.y - sill) * (aF.y - sill)), sill)
      .arch(aF.x, aF.y, aF.r, sill, 0.200)
      .L(1.98, 0.160).C(2.12, 0.135, 2.22, 0.114, 2.275, 0.110).Z().s;

    // DLO: chrome-framed; the roof arc runs down into a long, low, sharp quarter-glass point (no kink)
    var dlo = P().M(0.500, 1.034)
      .C(0.300, 1.145, 0.030, 1.315, -0.220, 1.380)
      .C(-0.450, 1.412, -0.850, 1.406, -1.100, 1.372)
      .C(-1.380, 1.330, -1.580, 1.160, -1.750, 1.052)              // sharp tail point at (-1.75, 1.05)
      .C(-1.350, 1.050, -0.400, 1.040, 0.500, 1.034).Z().s;
    // B-pillar 0.05 further back than the M3's; rear-door / quarter divider further back too
    var bF = [[-0.360, 1.03], [-0.400, 1.42]], bR = [[-0.445, 1.03], [-0.485, 1.42]];
    var qF = [[-1.250, 1.03], [-1.310, 1.42]], qR = [[-1.282, 1.03], [-1.342, 1.42]];
    var windows = [between(dlo, null, bF, 0.012), between(dlo, bR, qF, 0.012), between(dlo, qR, null, 0.012)];
    var pillars = [between(dlo, bF, bR), between(dlo, qF, qR)];

    var side = {
      body: body, greenhouse: dlo, windows: windows, pillars: pillars,
      doorCuts: [
        P().M(0.500, 1.034).C(0.760, 0.930, 0.960, 0.780, 0.990, 0.580).L(0.985, sill + 0.012).s,
        line([[-0.420, 1.046], [-0.410, sill + 0.01]]),
        P().M(-1.340, 1.052).C(-1.300, 0.920, -1.190, 0.780, -1.100, 0.660).C(-1.072, 0.620, -1.060, 0.560, -1.060, sill + 0.01).s
      ],
      panelLines: [
        P().M(2.150, 0.838).C(1.75, 0.880, 1.20, 0.960, 0.78, 1.008).s,
        P().M(-1.995, 1.074).C(-2.100, 1.050, -2.200, 1.030, -2.260, 1.005).s,
        rrect(-1.880, 0.860, -1.745, 0.960, 0.020),                                            // fuel flap
        rrect(-2.420, 0.540, -2.300, 0.640, 0.016),                                            // AC charging flap in rear bumper (right)
        P().M(2.296, 0.560).C(2.12, 0.540, 1.98, 0.530, 1.86, 0.530).s
      ],
      characterLines: [
        P().M(2.000, 0.840).C(1.300, 0.862, 0.300, 0.888, -0.600, 0.900).s,                 // single faint shoulder line fading out over the rear door
        // widened-wing lip: a 0.30 m crease following the front arch just outside the flare (lower door is clean)
        arcPath(aF.x, aF.y, aF.r + 0.035, 112, 68)
      ],
      sill: poly([[-1.030, sill], [1.030, sill], [1.025, sill + 0.050], [-1.025, sill + 0.050]]),
      archF: aF, archR: aR,
      lowerTrim: [
        poly([[-1.040, sill], [1.040, sill], [1.040, sill + 0.020], [-1.040, sill + 0.020]]),
        P().M(2.275, 0.110).L(2.298, 0.140).L(2.020, 0.160).L(2.000, 0.142).C(2.12, 0.128, 2.22, 0.114, 2.275, 0.110).Z().s,
        P().M(-2.462, 0.255).C(-2.440, 0.236, -2.410, 0.230, -2.370, 0.230).L(-1.86, 0.230).L(-1.87, 0.300).L(-2.508, 0.300).C(-2.500, 0.280, -2.485, 0.265, -2.462, 0.255).Z().s
      ]
    };

    var top = {
      // widened AMG front wings (haunch 0.959 covers the 265 tyre on the 1.649 m front track); tail tapers in plan
      body: planOutline({ xF: xF, xR: xR, axF: axF, axR: axR, halfW: W2, halfWF: 0.959, waist: W2 - 0.022, noseHalf: 0.68, noseRound: 0.24, tailHalf: 0.78, tailRound: 0.17,
        tailCorner: [-2.435, 0.805], tailHandle: [-2.300, 0.940] }),
      greenhouse: ghPlan(0.500, -1.750, 0.790, 0.866, 0.700),                            // same x span as the side DLO
      characterLines: pair(P().M(2.000, 0.290).C(1.700, 0.315, 1.300, 0.345, 0.920, 0.358).s, 1)
        .concat(pair(P().M(2.000, 0.218).C(1.700, 0.222, 1.300, 0.232, 0.920, 0.250).s, 1)),
      hood: mirrorClosed(P().M(2.165, 0).C(2.165, 0.40, 2.140, 0.630, 2.080, 0.690).C(1.60, 0.745, 1.10, 0.765, 0.640, 0.765).L(0.620, 0), 1),
      roof: mirrorClosed(P().M(-0.200, 0).C(-0.200, 0.35, -0.190, 0.575, -0.240, 0.612).C(-0.60, 0.635, -1.00, 0.625, -1.290, 0.590).C(-1.315, 0.45, -1.315, 0.20, -1.315, 0), 1),
      deck: mirrorClosed(P().M(-1.995, 0).L(-1.995, 0.600).C(-2.200, 0.690, -2.400, 0.690, -2.480, 0.600).C(-2.500, 0.40, -2.500, 0.20, -2.500, 0), 1),
      mirrors: pair(P().M(0.720, 0.860).C(0.730, 0.930, 0.700, 1.010, 0.640, 1.032).C(0.590, 1.038, 0.530, 1.018, 0.510, 0.975).L(0.540, 0.868).Z().s, 1)
    };

    var front = {
      body: crossOutline({ H: H, roofHalf: 0.540, beltY: 1.030, beltHalf: 0.850, halfW: W2, shoulderY: 0.640, lowY: 0.150, lowHalf: 0.870, bottomY: 0.110, bottomHalf: 0.800 }),
      greenhouse: mirrorClosed(P().M(0, 1.420).C(0.30, 1.420, 0.50, 1.410, 0.550, 1.392).C(0.630, 1.260, 0.700, 1.110, 0.725, 1.032).C(0.50, 1.024, 0.25, 1.020, 0, 1.020), 0),
      bumper: mirrorClosed(P().M(0, 0.400).L(0.440, 0.400).L(0.478, 0.672).C(0.65, 0.690, 0.85, 0.700, 0.935, 0.705).C(0.945, 0.500, 0.925, 0.240, 0.870, 0.150).C(0.850, 0.125, 0.850, 0.110, 0.800, 0.110).L(0, 0.110), 0),
      // Panamericana: trapezoid clearly wider at the bottom (top +/-0.30 @0.74, bottom +/-0.44 @0.40)
      grille: [mirrorClosed(P().M(0, 0.745).L(0.262, 0.745).C(0.276, 0.745, 0.284, 0.738, 0.286, 0.726).L(0.442, 0.424)
        .C(0.446, 0.410, 0.440, 0.400, 0.424, 0.400).L(0, 0.400), 0)],
      intakes: pair(P().M(0.520, 0.440).L(0.860, 0.500).C(0.890, 0.505, 0.902, 0.490, 0.900, 0.460).L(0.888, 0.260)
        .C(0.882, 0.228, 0.865, 0.212, 0.835, 0.212).L(0.590, 0.206).C(0.550, 0.206, 0.528, 0.226, 0.524, 0.266).Z().s, 0)
        // centre lower intake kept low (y 0.146-0.24) so the plate sits on body-colour bumper above it
        .concat([mirrorClosed(P().M(0, 0.240).L(0.440, 0.240).C(0.470, 0.240, 0.490, 0.226, 0.490, 0.206).L(0.484, 0.172)
          .C(0.478, 0.152, 0.460, 0.146, 0.430, 0.146).L(0, 0.146), 0)]),
      // inner tip points down and inboard onto the grille's upper corner; lower edge rises outward, top nearly flat
      // W206 wedge: top edge rising outward to 0.83, notch stepping the lower edge at z ~0.62
      headlights: pair(P().M(0.318, 0.722).C(0.350, 0.758, 0.395, 0.795, 0.460, 0.800).L(0.840, 0.830)
        .C(0.874, 0.832, 0.892, 0.816, 0.890, 0.794).L(0.884, 0.748).C(0.800, 0.738, 0.700, 0.730, 0.640, 0.726)
        .L(0.626, 0.700).L(0.604, 0.702).C(0.540, 0.700, 0.460, 0.698, 0.420, 0.698)
        .C(0.378, 0.698, 0.342, 0.706, 0.318, 0.722).Z().s, 0),
      // eyebrow DRL with the distinct downward hook at the inner end
      drl: pair(strip([[0.440, 0.706], [0.470, 0.774], [0.550, 0.790], [0.840, 0.814], [0.874, 0.792]], 0.011), 0),
      splitter: mirrorClosed(P().M(0, 0.146).L(0.820, 0.146).C(0.860, 0.141, 0.860, 0.116, 0.840, 0.110).L(0, 0.110), 0),
      plateArea: rrect(-0.260, 0.250, 0.260, 0.360, 0.01),
      badgeArea: ellipse(0, 0.570, 0.090, 0.090),
      badgeText: 'MERCEDES-BENZ'
    };

    var rear = {
      body: crossOutline({ H: H, roofHalf: 0.540, beltY: 1.070, beltHalf: 0.850, halfW: W2, shoulderY: 0.800, lowY: 0.270, lowHalf: 0.905, bottomY: 0.230, bottomHalf: 0.830 }),
      greenhouse: mirrorClosed(P().M(0, 1.390).C(0.30, 1.390, 0.48, 1.382, 0.520, 1.368).C(0.580, 1.260, 0.640, 1.150, 0.665, 1.096).C(0.40, 1.092, 0.20, 1.090, 0, 1.090), 0),
      bumper: mirrorClosed(P().M(0, 0.700).L(0.400, 0.700).C(0.60, 0.720, 0.85, 0.800, 0.938, 0.830).C(0.948, 0.600, 0.935, 0.350, 0.905, 0.270).C(0.885, 0.240, 0.870, 0.230, 0.830, 0.230).L(0, 0.230), 0),
      // W206 two-piece lamps: outer (quarter) element 0.12 tall, inner (boot-lid) element tapering to 0.05 at z 0.32
      // W206 wedge: outer (quarter) element 0.15 tall (y 0.84-0.99), inner (boot-lid) element tapering to a 0.02 tip at z 0.32
      taillights: pair(P().M(0.640, 0.978).L(0.892, 0.990).C(0.914, 0.990, 0.926, 0.978, 0.927, 0.958).L(0.930, 0.862)
        .C(0.930, 0.847, 0.921, 0.840, 0.905, 0.840).L(0.690, 0.864).C(0.660, 0.868, 0.640, 0.882, 0.638, 0.906).Z().s, 0)
        .concat(pair(P().M(0.320, 0.960).L(0.320, 0.977).C(0.320, 0.979, 0.322, 0.980, 0.326, 0.980).L(0.612, 0.982)
          .C(0.622, 0.982, 0.626, 0.976, 0.626, 0.966).L(0.626, 0.888).C(0.626, 0.878, 0.618, 0.874, 0.606, 0.877)
          .L(0.326, 0.956).C(0.322, 0.957, 0.320, 0.958, 0.320, 0.960).Z().s, 0)),
      lightBar: null,
      diffuser: mirrorClosed(P().M(0, 0.360).L(0.770, 0.360).C(0.790, 0.360, 0.800, 0.350, 0.800, 0.335).L(0.800, 0.230).L(0, 0.230), 0),
      exhaust: [{ shape: 'round', cx: -0.670, cy: 0.292, w: 0.088, h: 0.088 }, { shape: 'round', cx: -0.570, cy: 0.292, w: 0.088, h: 0.088 },
        { shape: 'round', cx: 0.570, cy: 0.292, w: 0.088, h: 0.088 }, { shape: 'round', cx: 0.670, cy: 0.292, w: 0.088, h: 0.088 }],
      plateArea: rrect(-0.260, 0.740, 0.260, 0.850, 0.01),
      badgeArea: ellipse(0, 0.950, 0.045, 0.045),
      badgeText: 'AMG',
      spoiler: mirrorClosed(P().M(0, 1.070).L(0.560, 1.061).C(0.585, 1.059, 0.590, 1.051, 0.584, 1.045).L(0, 1.051), 0)
    };

    var details = pillars.map(function (pl) { return { view: 'side', role: 'trim', paint: 'gloss-black', path: pl }; }).concat([
      { view: 'side', role: 'mirror', paint: 'body', path: shift(P().M(0.470, 1.030).C(0.490, 1.100, 0.550, 1.140, 0.650, 1.142).C(0.730, 1.144, 0.770, 1.110, 0.765, 1.065).C(0.760, 1.030, 0.710, 1.012, 0.630, 1.012).Z().s, -0.04, -0.02) },
      mirrorFoot(0.500, 1.024),
      // handles sit toward the rear of each door (front door ends at the moved B-pillar, x -0.42)
      { view: 'side', role: 'handle', paint: 'body', path: rrect(-0.250, 0.912, -0.085, 0.940, 0.014) },
      { view: 'side', role: 'handle', paint: 'body', path: rrect(-1.000, 0.930, -0.840, 0.958, 0.014) },
      { view: 'side', role: 'trim', paint: 'chrome', path: ring(dlo, 0.010) },
      { view: 'side', role: 'headlight', paint: 'light', path: P().M(2.285, 0.775).C(2.230, 0.800, 2.150, 0.812, 2.080, 0.806).C(2.110, 0.770, 2.190, 0.740, 2.296, 0.735).Z().s },
      { view: 'side', role: 'taillight', paint: 'light-red', path: P().M(-2.494, 0.990).C(-2.380, 0.992, -2.240, 0.985, -2.160, 0.970).C(-2.190, 0.940, -2.300, 0.905, -2.500, 0.890).Z().s },
      { view: 'side', role: 'intake', paint: 'black', path: P().M(2.300, 0.490).C(2.240, 0.470, 2.180, 0.430, 2.160, 0.380).L(2.170, 0.230).C(2.220, 0.215, 2.270, 0.212, 2.305, 0.215).Z().s },
      { view: 'side', role: 'chargePort', paint: 'body', path: rrect(-2.420, 0.540, -2.300, 0.640, 0.016) },
      { view: 'side', role: 'antenna', paint: 'body', path: P().M(-1.120, 1.426).C(-1.160, 1.446, -1.210, 1.446, -1.250, 1.405).Z().s },
      { view: 'top', role: 'glass', paint: 'glass', path: mirrorClosed(P().M(0.540, 0).C(0.540, 0.40, 0.520, 0.650, 0.460, 0.700).C(0.200, 0.690, -0.050, 0.640, -0.190, 0.600).L(-0.195, 0), 1) },
      { view: 'top', role: 'glass', paint: 'glass', path: mirrorClosed(P().M(-1.320, 0).L(-1.320, 0.585).C(-1.550, 0.630, -1.800, 0.650, -1.970, 0.630).L(-1.975, 0), 1) },
      { view: 'top', role: 'vent', paint: 'body', path: P().M(2.020, 0.250).C(1.950, 0.300, 1.600, 0.325, 1.300, 0.345).C(1.050, 0.360, 0.920, 0.362, 0.900, 0.330).C(0.885, 0.275, 0.950, 0.242, 1.100, 0.236).C(1.400, 0.225, 1.850, 0.212, 2.020, 0.250).Z().s },   // twin power domes, 0.12 wide at z +/-0.30, converging forward
      { view: 'top', role: 'vent', paint: 'body', path: mirror(P().M(2.020, 0.250).C(1.950, 0.300, 1.600, 0.325, 1.300, 0.345).C(1.050, 0.360, 0.920, 0.362, 0.900, 0.330).C(0.885, 0.275, 0.950, 0.242, 1.100, 0.236).C(1.400, 0.225, 1.850, 0.212, 2.020, 0.250).Z().s, 1) },
      { view: 'front', role: 'mirror', paint: 'body', path: shift(P().M(0.870, 1.020).L(1.010, 1.030).C(1.030, 1.070, 1.030, 1.120, 1.000, 1.145).L(0.890, 1.150).C(0.870, 1.120, 0.865, 1.060, 0.870, 1.020).Z().s, 0, -0.02) },
      { view: 'front', role: 'mirror', paint: 'body', path: mirror(shift(P().M(0.870, 1.020).L(1.010, 1.030).C(1.030, 1.070, 1.030, 1.120, 1.000, 1.145).L(0.890, 1.150).C(0.870, 1.120, 0.865, 1.060, 0.870, 1.020).Z().s, 0, -0.02), 0) },
      { view: 'rear', role: 'chargePort', paint: 'body', path: rrect(0.720, 0.560, 0.820, 0.640, 0.014) },
      { view: 'rear', role: 'taillight', paint: 'light-red', path: rrect(-0.120, 1.360, 0.120, 1.374, 0.006) }
    ]);
    // AMG Panamericana: gloss-black frame + 15 thin vertical chrome bars clipped to the trapezoid, broken around the badge
    details.push({ view: 'front', role: 'grille', paint: 'gloss-black', path: ring(front.grille[0], 0.018) });
    for (var gi = 0; gi < 15; gi++) {
      var gz = -0.392 + 0.784 * gi / 14, az = Math.abs(gz);
      var gTop = az <= 0.268 ? 0.722 : 0.722 - (az - 0.268) / 0.156 * 0.302, gBot = 0.420;
      if (az < 0.1) {
        details.push({ view: 'front', role: 'grille', paint: 'chrome', path: strip([[gz, gBot], [gz, 0.475]], 0.008) });
        details.push({ view: 'front', role: 'grille', paint: 'chrome', path: strip([[gz, 0.665], [gz, gTop]], 0.008) });
      } else details.push({ view: 'front', role: 'grille', paint: 'chrome', path: strip([[gz, gBot], [gz, gTop]], 0.008) });
    }
    // centre badge plinth (text badge sits on it; no logo artwork)
    details.push({ view: 'front', role: 'trim', paint: 'gloss-black', path: ellipse(0, 0.570, 0.098, 0.098) });
    // AMG 'A-wing' lip running full width through the lower intake, tips sweeping up at the corners
    details.push({ view: 'front', role: 'trim', paint: 'gloss-black', path: mirrorClosed(P().M(0, 0.200).L(0.700, 0.200)
      .C(0.780, 0.205, 0.840, 0.228, 0.872, 0.262).L(0.884, 0.248).C(0.852, 0.200, 0.790, 0.160, 0.700, 0.150).L(0, 0.150), 0) });
    // AMG outer-intake vertical fins (3 per side) and rear diffuser fins
    pair(strip([[0.620, 0.218], [0.620, 0.448]], 0.024), 0).concat(pair(strip([[0.720, 0.216], [0.720, 0.466]], 0.024), 0))
      .concat(pair(strip([[0.820, 0.220], [0.820, 0.482]], 0.024), 0))
      .forEach(function (s) { details.push({ view: 'front', role: 'intake', paint: 'gloss-black', path: s }); });
    vSlats(-0.40, 0.40, 6, 0.240, 0.350, 0.014).forEach(function (s) { details.push({ view: 'rear', role: 'trim', paint: 'gloss-black', path: s }); });
    // two-piece tail-lamp split + inner light graphics
    pair(strip([[0.345, 0.968], [0.610, 0.962]], 0.009), 0)
      .concat(pair(strip([[0.420, 0.960], [0.500, 0.918], [0.610, 0.905]], 0.009), 0))          // angular inner element
      .concat(pair(strip([[0.655, 0.958], [0.880, 0.964], [0.912, 0.900]], 0.010), 0))
      .forEach(function (s) { details.push({ view: 'rear', role: 'taillight', paint: 'light-red', path: s }); });
    // AMG front splitter in chrome
    details.push({ view: 'front', role: 'trim', paint: 'chrome', path: mirrorClosed(P().M(0, 0.156).L(0.820, 0.156).C(0.850, 0.154, 0.860, 0.146, 0.850, 0.144).L(0, 0.146), 0) });

    return {
      id: 'mercedes-amg-c63-w206', make: 'Mercedes-AMG', name: 'C 63 S E PERFORMANCE', gen: 'W206', years: '2023–', style: 'sedan',
      look: { head: 'slim-led', tail: 'slim', grille: 'slats' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'hybrid',
      ref: { length: 4.842, width: 1.900, height: H, wheelbase: WB, trackF: 1.649, trackR: 1.610, frontOverhang: FOH, rearOverhang: ROH,
        wheelDiameter_in: 20, tireF: tF, tireR: tR, groundClearance: 0.110, rideHeight: sill, cd: 0.30, curbWeight_kg: 2111 },
      side: side, top: top, front: front, rear: rear, details: details,
      // contrast with the M3 comes from the rim: big-diameter 10-spoke design and a thin (0.04 m) sidewall stroke
      wheel: { spokes: 10, finish: '#55585d', caliper: '#c8102e', sidewall: 0.04 },
      wheelStyle: { type: 'multi-spoke', spokes: 10, split: 1, finish: 'matte-grey', centreHub: 'cap', sidewallStroke: 0.04, rimFill: 0.86, note: 'AMG 20 in forged 10-spoke wheel filling the tyre, thin sidewall' },
      signature: {
        wheels: 'AMG 20 in forged 10-spoke wheels, large rim with thin sidewall, dark grey.',
        headlights: 'Slim angular DIGITAL LIGHT units with a continuous eyebrow DRL that hooks down at the inner end beside the grille.',
        taillights: 'Two-piece horizontal wedge tail-lamps split between rear quarter and boot lid, tapering towards the centre.',
        grille: 'AMG Panamericana grille: tall trapezoid widening toward the bottom with 15 vertical chrome bars; badge area in the centre.',
        notes: 'Long bonnet with twin power domes, widened front wings, chrome-framed DLO with pointed quarter window, boot-lid lip spoiler, AC charge flap in the rear bumper, quad round tailpipes.'
      }
    };
  }

  /* ================================================================== */
  /* Tesla Model S (2021 refresh)                                         */
  /* ================================================================== */
  function teslaModelS() {
    var WB = 2.960, FOH = 0.950, ROH = 1.111, axF = WB / 2, axR = -WB / 2;
    var xF = axF + FOH, xR = axR - ROH;               // 2.43, -2.591
    var tF = '255/45R19', tR = '285/40R19', rF = tireR(tF), rR = tireR(tR);
    var aF = { x: axF, y: rF, r: rF + 0.034, flare: 0.012 }, aR = { x: axR, y: rR, r: rR + 0.034, flare: 0.012 };
    var sill = 0.150, H = 1.431, W2 = 1.964 / 2;

    var body = P().M(2.290, 0.120)
      .C(2.330, 0.140, 2.355, 0.175, 2.365, 0.210)                 // tucked chin: bottom of the nose ~0.07 behind the tip
      .C(2.385, 0.280, xF, 0.330, xF, 0.400)                       // rounded 'bullet' nose: furthest forward at y 0.40
      .C(xF, 0.490, 2.410, 0.575, 2.360, 0.620)                    // rolling back as it rises
      .C(2.300, 0.668, 2.230, 0.694, 2.150, 0.704)                 // low frunk leading edge
      .C(1.800, 0.758, 1.300, 0.900, 1.000, 0.968)                 // fender crown (silhouette)
      .C(0.960, 0.976, 0.930, 0.986, 0.900, 0.992)
      .C(0.550, 1.170, 0.220, 1.340, -0.020, 1.400)                // long raked screen
      .C(-0.120, 1.424, -0.220, H, -0.300, H)                      // roof peak
      .C(-0.800, H, -1.400, 1.380, -1.900, 1.200)                  // single continuous fastback arc ...
      .C(-2.180, 1.098, -2.380, 1.045, -2.540, 1.038)              // ... all the way to the duck-tail
      .C(-2.555, 1.037, -2.566, 1.030, -2.568, 1.015)              // integrated duck-tail lip
      .C(-2.572, 0.850, -2.580, 0.620, -2.585, 0.450)              // near-vertical tail face (<= 0.02 lean)
      .C(-2.588, 0.360, -2.570, 0.292, -2.528, 0.262)              // tuck under to the diffuser
      .C(-2.505, 0.252, -2.480, 0.250, -2.440, 0.250)
      .L(-1.88, 0.250)
      .arch(aR.x, aR.y, aR.r, 0.250, sill)
      .L(axF - Math.sqrt(aF.r * aF.r - (aF.y - sill) * (aF.y - sill)), sill)
      .arch(aF.x, aF.y, aF.r, sill, 0.200)
      .L(2.000, 0.150).C(2.130, 0.132, 2.230, 0.121, 2.290, 0.120).Z().s;

    var dlo = P().M(0.800, 1.000)
      .C(0.580, 1.118, 0.240, 1.300, -0.020, 1.356)
      .C(-0.300, 1.392, -0.700, 1.392, -1.050, 1.360)
      .C(-1.380, 1.318, -1.660, 1.176, -1.860, 1.075)            // quarter glass ends ~-1.88, well ahead of the tail
      .C(-1.890, 1.062, -1.885, 1.050, -1.850, 1.050)
      .C(-1.200, 1.035, 0.000, 1.006, 0.800, 1.000).Z().s;
    // glass roof edge in profile: band 0.016 tall just under the roof line, x 0.0 -> -1.05
    var roofBand = (function () {
      var pl = sample(body, 24).filter(function (q) { return q[1] > 1.30 && q[0] <= 0.02 && q[0] >= -1.05; });
      pl.sort(function (a, b) { return b[0] - a[0]; });
      return strip(pl.map(function (q) { return [q[0], q[1] - 0.016]; }), 0.016);
    })();
    var bF = [[-0.150, 1.0], [-0.200, 1.40]], bR = [[-0.250, 1.0], [-0.300, 1.40]];
    var qF = [[-1.110, 1.0], [-1.170, 1.40]], qR = [[-1.142, 1.0], [-1.202, 1.40]];
    var windows = [between(dlo, null, bF, 0.012), between(dlo, bR, qF, 0.012), between(dlo, qR, null, 0.012)];
    var pillars = [between(dlo, bF, bR), between(dlo, qF, qR)];

    var side = {
      body: body, greenhouse: dlo, windows: windows, pillars: pillars,
      doorCuts: [
        P().M(0.800, 1.000).C(0.900, 0.930, 0.975, 0.820, 0.975, 0.650).L(0.975, sill + 0.012).s,
        line([[-0.205, 1.004], [-0.200, sill + 0.01]]),
        P().M(-1.200, 1.036).C(-1.160, 0.880, -1.080, 0.740, -1.050, 0.620).C(-1.035, 0.560, -1.035, 0.500, -1.035, sill + 0.01).s
      ],
      panelLines: [
        P().M(2.150, 0.700).C(1.80, 0.735, 1.30, 0.870, 0.950, 0.942).s,                      // frunk shut line / hood centre, ~0.03 below the fender crown
        P().M(-2.225, 1.072).C(-2.300, 1.000, -2.360, 0.960, -2.420, 0.945).s,                 // liftback shut line
        P().M(2.420, 0.520).C(2.25, 0.500, 2.10, 0.490, 1.98, 0.490).s
      ],
      characterLines: [
        // near-featureless body side: only a soft shoulder that fades out over the rear door
        P().M(2.050, 0.700).C(1.300, 0.790, 0.300, 0.848, -0.600, 0.866).s,
        // glass-roof highlight: the windscreen reflection carries on along the roof glass edge
        P().M(0.000, 1.374).C(-0.300, 1.386, -0.700, 1.386, -1.000, 1.364).s
      ],
      sill: { paint: 'gloss-black', path: poly([[-1.110, sill], [1.090, sill], [1.088, sill + 0.012], [-1.108, sill + 0.012]]) },   // rocker merged into the door skin: only a 0.012 gloss-black lower edge
      archF: aF, archR: aR,
      lowerTrim: [
        poly([[-1.120, sill], [1.100, sill], [1.100, sill + 0.006], [-1.120, sill + 0.006]]),       // rocker underside shadow
        P().M(-2.528, 0.262).C(-2.505, 0.252, -2.480, 0.250, -2.440, 0.250).L(-1.95, 0.250).L(-1.96, 0.310).L(-2.578, 0.310).C(-2.584, 0.290, -2.560, 0.272, -2.528, 0.262).Z().s
      ]
    };

    var top = {
      // rear haunch 0.991 covers the 285 tyre on the 1.690 m rear track
      body: planOutline({ xF: xF, xR: xR, axF: axF, axR: axR, halfW: W2, halfWR: 0.991, waist: W2 - 0.030, noseHalf: 0.56, noseRound: 0.34, tailHalf: 0.74, tailRound: 0.20 }),
      greenhouse: ghPlan(0.800, -1.888, 0.810, 0.880, 0.730),                            // same x span as the side DLO
      hood: mirrorClosed(P().M(2.180, 0).C(2.180, 0.35, 2.130, 0.600, 2.040, 0.680).C(1.70, 0.760, 1.30, 0.780, 0.960, 0.780).L(0.940, 0), 1),
      roofGlass: true,                                                                    // hint for 3D: roof panel is glass
      // fixed glass roof: windscreen header (x -0.02) back to the rear header (x -1.05); painted glass in plan
      roof: { paint: 'glass', path: mirrorClosed(P().M(-0.020, 0).C(-0.020, 0.35, -0.010, 0.590, -0.060, 0.630).C(-0.40, 0.660, -0.80, 0.656, -1.020, 0.640).C(-1.050, 0.45, -1.050, 0.20, -1.050, 0), 1) },
      deck: mirrorClosed(P().M(-2.230, 0).L(-2.230, 0.600).C(-2.380, 0.690, -2.500, 0.690, -2.540, 0.600).C(-2.560, 0.40, -2.560, 0.20, -2.560, 0), 1),
      mirrors: pair(P().M(0.880, 0.880).C(0.890, 0.950, 0.860, 1.020, 0.800, 1.044).C(0.750, 1.050, 0.690, 1.030, 0.670, 0.990).L(0.700, 0.890).Z().s, 1)
    };

    var front = {
      // soft nose cone: half-width tapers from 0.98 at y ~0.55 to ~0.90 at y 0.15, lower corners rounded (r ~0.15)
      body: crossOutline({ H: H, roofHalf: 0.550, beltY: 1.005, beltHalf: 0.880, halfW: W2, shoulderY: 0.600, lowY: 0.250, lowHalf: 0.925, bottomY: 0.120, bottomHalf: 0.760, cornerIn: 0.02 }),
      // bonnet 'valley': hood centre ~0.74 between fender crowns ~0.80 above the headlights
      characterLines: [P().M(-0.930, 0.740).C(-0.880, 0.790, -0.820, 0.802, -0.750, 0.802).C(-0.550, 0.800, -0.300, 0.742, 0, 0.740)
        .C(0.300, 0.742, 0.550, 0.800, 0.750, 0.802).C(0.820, 0.802, 0.880, 0.790, 0.930, 0.740).s],
      greenhouse: mirrorClosed(P().M(0, 1.398).C(0.30, 1.398, 0.52, 1.388, 0.570, 1.372).C(0.660, 1.240, 0.740, 1.080, 0.760, 1.000).C(0.50, 0.990, 0.25, 0.986, 0, 0.986), 0),
      bumper: mirrorClosed(P().M(0, 0.700).C(0.220, 0.700, 0.380, 0.688, 0.450, 0.652).C(0.620, 0.640, 0.850, 0.655, 0.962, 0.680).C(0.975, 0.500, 0.955, 0.330, 0.918, 0.250).C(0.880, 0.170, 0.840, 0.120, 0.760, 0.120).L(0, 0.120), 0),
      grille: [],
      intakes: [mirrorClosed(P().M(0, 0.280).L(0.500, 0.280).C(0.535, 0.280, 0.550, 0.268, 0.552, 0.250).L(0.552, 0.226)
        .C(0.550, 0.208, 0.535, 0.200, 0.505, 0.200).L(0, 0.200), 0)]                    // thin low slot
        .concat(pair(P().M(0.735, 0.400).C(0.760, 0.410, 0.800, 0.410, 0.830, 0.395).L(0.860, 0.250).C(0.862, 0.230, 0.850, 0.220, 0.830, 0.222)
          .L(0.760, 0.228).C(0.740, 0.230, 0.730, 0.245, 0.728, 0.265).Z().s, 0)),        // air-curtain inlets
      // swept lamps at the fender crowns: thin inner tip, growing to 0.09 tall outboard, kinked lower edge
      headlights: pair(P().M(0.460, 0.660).C(0.520, 0.690, 0.640, 0.716, 0.760, 0.734).L(0.880, 0.752)
        .C(0.900, 0.754, 0.912, 0.745, 0.910, 0.730).L(0.902, 0.672).C(0.900, 0.662, 0.892, 0.658, 0.880, 0.660)
        .L(0.730, 0.674).L(0.640, 0.662).C(0.580, 0.655, 0.500, 0.652, 0.460, 0.660).Z().s, 0),
      drl: pair(strip([[0.500, 0.680], [0.650, 0.710], [0.880, 0.741]], 0.009), 0),
      fogLights: null,
      splitter: null,
      plateArea: rrect(-0.260, 0.350, 0.260, 0.460, 0.01),
      badgeArea: rrect(-0.040, 0.560, 0.040, 0.620, 0.02),
      badgeText: 'TESLA'
    };

    var rear = {
      body: crossOutline({ H: H, roofHalf: 0.550, beltY: 1.040, beltHalf: 0.875, halfW: W2, shoulderY: 0.760, lowY: 0.290, lowHalf: 0.930, bottomY: 0.250, bottomHalf: 0.850 }),
      greenhouse: mirrorClosed(P().M(0, 1.330).C(0.30, 1.330, 0.47, 1.323, 0.515, 1.310).C(0.580, 1.240, 0.650, 1.150, 0.690, 1.100).C(0.40, 1.098, 0.20, 1.098, 0, 1.098), 0),   // shallow fastback glass
      bumper: mirrorClosed(P().M(0, 0.660).L(0.400, 0.660).C(0.60, 0.680, 0.85, 0.770, 0.960, 0.800).C(0.972, 0.600, 0.960, 0.370, 0.930, 0.290).C(0.910, 0.262, 0.890, 0.250, 0.850, 0.250).L(0, 0.250), 0),
      // teardrop lamps: 0.13 tall at the outer end, tapering to ~0.03 at the inner tip on the liftback
      taillights: pair(P().M(0.380, 0.938).C(0.380, 0.950, 0.390, 0.956, 0.405, 0.956).L(0.880, 0.960)
        .C(0.922, 0.960, 0.946, 0.940, 0.948, 0.905).L(0.946, 0.865).C(0.944, 0.842, 0.928, 0.830, 0.900, 0.830)
        .C(0.780, 0.832, 0.600, 0.880, 0.405, 0.922).C(0.388, 0.926, 0.380, 0.930, 0.380, 0.938).Z().s, 0),
      panelLines: [P().M(-0.400, 0.660).C(-0.395, 0.750, -0.386, 0.850, -0.372, 0.918).L(-0.360, 0.966).L(0.360, 0.966).L(0.372, 0.918)
        .C(0.386, 0.850, 0.395, 0.750, 0.400, 0.660).L(-0.400, 0.660).s,                       // liftback shut line
        P().M(-0.860, 0.966).L(-0.360, 0.966).s, P().M(0.360, 0.966).L(0.860, 0.966).s],
      lightBar: null,
      diffuser: mirrorClosed(P().M(0, 0.360).L(0.700, 0.360).C(0.740, 0.360, 0.760, 0.340, 0.760, 0.310).L(0.750, 0.250).L(0, 0.250), 0),
      exhaust: [{ shape: 'hidden', cx: 0, cy: 0.300, w: 0, h: 0 }],
      plateArea: rrect(-0.260, 0.700, 0.260, 0.810, 0.01),
      badgeArea: rrect(-0.040, 0.845, 0.040, 0.900, 0.02),
      badgeText: 'TESLA',
      spoiler: mirrorClosed(P().M(0, 1.040).L(0.600, 1.034).C(0.630, 1.032, 0.640, 1.024, 0.632, 1.018).L(0, 1.022), 0)
    };

    var details = pillars.map(function (pl) { return { view: 'side', role: 'trim', paint: 'gloss-black', path: pl }; }).concat([
      { view: 'side', role: 'mirror', paint: 'body', path: shift(P().M(0.800, 0.995).C(0.820, 1.075, 0.870, 1.120, 0.950, 1.124).C(1.020, 1.126, 1.060, 1.095, 1.055, 1.050).C(1.050, 1.010, 1.000, 0.992, 0.920, 0.992).Z().s, -0.04, -0.02) },
      mirrorFoot(0.800, 0.990),
      { view: 'side', role: 'handle', paint: 'chrome', path: rrect(0.180, 0.875, 0.360, 0.895, 0.010) },     // flush pop-out handles
      { view: 'side', role: 'handle', paint: 'chrome', path: rrect(-0.860, 0.890, -0.680, 0.910, 0.010) },
      { view: 'side', role: 'trim', paint: 'black', path: ring(dlo, 0.012) },
      { view: 'side', role: 'trim', paint: 'gloss-black', path: rrect(1.055, 0.805, 1.095, 0.825, 0.008) },   // side repeater camera
      // roof glass edge seen in profile: dark band from the windscreen header back over the roof
      { view: 'side', role: 'glass', paint: 'glass', path: roofBand },
      { view: 'side', role: 'headlight', paint: 'light', path: P().M(2.380, 0.650).C(2.320, 0.690, 2.220, 0.715, 2.120, 0.715).C(2.170, 0.680, 2.280, 0.640, 2.405, 0.620).Z().s },
      { view: 'side', role: 'taillight', paint: 'light-red', path: P().M(-2.480, 0.960).C(-2.380, 0.962, -2.260, 0.955, -2.190, 0.945).C(-2.220, 0.910, -2.340, 0.880, -2.530, 0.860).Z().s },
      { view: 'top', role: 'glass', paint: 'glass', path: mirrorClosed(P().M(0.900, 0).C(0.900, 0.40, 0.880, 0.660, 0.800, 0.720).C(0.500, 0.700, 0.150, 0.650, -0.010, 0.620).L(-0.015, 0), 1) },
      { view: 'top', role: 'glass', paint: 'glass', path: mirrorClosed(P().M(-1.090, 0).L(-1.090, 0.630).C(-1.500, 0.640, -1.950, 0.660, -2.210, 0.640).L(-2.215, 0), 1) },   // liftback glass from the rear header
      { view: 'front', role: 'mirror', paint: 'body', path: shift(P().M(0.900, 0.990).L(1.040, 1.000).C(1.060, 1.040, 1.060, 1.095, 1.030, 1.120).L(0.920, 1.125).C(0.900, 1.095, 0.895, 1.030, 0.900, 0.990).Z().s, 0, -0.02) },
      { view: 'front', role: 'mirror', paint: 'body', path: mirror(shift(P().M(0.900, 0.990).L(1.040, 1.000).C(1.060, 1.040, 1.060, 1.095, 1.030, 1.120).L(0.920, 1.125).C(0.900, 1.095, 0.895, 1.030, 0.900, 0.990).Z().s, 0, -0.02), 0) },
      { view: 'front', role: 'trim', paint: 'black', path: rrect(-0.040, 0.300, 0.040, 0.322, 0.008) },       // front radar/camera window
      { view: 'rear', role: 'chargePort', paint: 'light-red', path: rrect(-0.930, 0.865, -0.860, 0.935, 0.012) },  // charge port hidden in left tail-lamp
      { view: 'rear', role: 'trim', paint: 'light-red', path: rrect(-0.900, 0.400, -0.780, 0.418, 0.008) },   // rear reflectors
      { view: 'rear', role: 'trim', paint: 'light-red', path: rrect(0.780, 0.400, 0.900, 0.418, 0.008) },
      { view: 'rear', role: 'taillight', paint: 'light-red', path: rrect(-0.200, 1.346, 0.200, 1.356, 0.004) }
    ]);
    pair(strip([[0.420, 0.940], [0.880, 0.946], [0.928, 0.900], [0.900, 0.850]], 0.010), 0)
      .forEach(function (s) { details.push({ view: 'rear', role: 'taillight', paint: 'light-red', path: s }); });

    return {
      id: 'tesla-model-s-2021', make: 'Tesla', name: 'Model S', gen: '2021 refresh', years: '2021–', style: 'sedan',
      look: { head: 'slim-led', tail: 'slim', grille: 'blanked' },   // renderer lamp / grille signature
      enginePosition: 'front', drivetrain: 'awd', powertrain: 'ev',
      ref: { length: 5.021, width: 1.964, height: H, wheelbase: WB, trackF: 1.690, trackR: 1.690, frontOverhang: FOH, rearOverhang: ROH,
        wheelDiameter_in: 19, tireF: tF, tireR: tR, groundClearance: 0.117, rideHeight: sill, cd: 0.208, curbWeight_kg: 2069 },
      side: side, top: top, front: front, rear: rear, details: details,
      wheel: { spokes: 5, finish: '#a7abb0', caliper: '#1e1f22' },
      wheelStyle: { type: 'aero-cover', spokes: 5, split: 0, finish: 'silver-grey', centreHub: 'flush', note: '19 in Tempest aero wheel: near-flat disc with five shallow turbine slots' },
      signature: {
        wheels: '19 in Tempest aero wheels: flat turbine-slotted discs.',
        headlights: 'Slim swept LED headlights with pointed inner tips and a thin upper DRL strip; smooth grille-less nose cone.',
        taillights: 'Wrap-around tail-lamps whose inner blades reach onto the liftback; charge port concealed in the left lamp.',
        grille: 'No grille: body-colour nose with a wide low gloss-black intake and vertical air-curtain inlets in the corners.',
        notes: 'Single-arc fastback roofline over a liftback with integrated duck-tail, full glass roof, flush pop-out handles, no exhaust (EV), Cd 0.208.'
      }
    };
  }

  /* ------------------------------------------------------------------ */
  var MODELS = [bmwM3(), amgC63(), teslaModelS()];
  MODELS.forEach(function (m) {
    if (typeof CB.shapes.registerModel === 'function') CB.shapes.registerModel(m);
    else (CB.shapes._pending = CB.shapes._pending || []).push(m);
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = { models: MODELS };
})();

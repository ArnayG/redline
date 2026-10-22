/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/wagon-brake.js
   Hand-authored low-poly fast wagons and shooting brakes (docs/LOWPOLY-SPEC.md):
     Audi RS 6 Avant (C8), Mercedes-AMG E 63 S Estate (S213), Volvo V60 Polestar Engineered,
     Porsche Taycan Cross Turismo, Ferrari GTC4Lusso, Mercedes-Benz CLS Shooting Brake (X218).

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body stations are RIGHT half rings [y, z] from the bottom centre round to the top centre, 11 points
   with fixed meaning so the glass / roof become clean bands in `mats`:
     0 bottom centre, 1 bottom edge, 2 sill, 3 waist (widest, usually the shoulder / blister crease),
     4 upper flank, 5 belt (top of the door skin), 6 glass base, 7 glass top, 8 roof rail, 9 roof quarter, 10 centre.
   On bonnet stations 6..10 run across the bonnet; windscreen stations ('w') are interpolated between the cowl
   and the header so the A-pillar (col 7) and the screen (cols 8-9) stay straight bands.
   Stations are authored as compact numbers measured from the CB.shapes side / top / front views (wheelbase as
   the scale) and checked against side / 3/4 photos (URLs in each car's notes).
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  var LP = CB.lowpoly = CB.lowpoly || {};
  function reg(id, def) {
    if (typeof LP.register === 'function' && !Array.isArray(LP._pending)) LP.register(id, def);
    else (LP._pending = LP._pending || []).push([id, def]);
  }

  /* ---------------------------------------------------------------- helpers */
  function ell(a, b, ra, rb, n, rot) {
    var out = [], r = rot || 0;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n * Math.PI * 2, u = Math.cos(t) * ra, v = Math.sin(t) * rb;
      out.push([a + u * Math.cos(r) - v * Math.sin(r), b + u * Math.sin(r) + v * Math.cos(r)]);
    }
    return out;
  }
  function tilt(deg) { return function (p) { p.maxTilt = deg; return p; }; }
  function rect(a0, b0, a1, b1) { return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]; }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  /** planar ellipse in 3D (ref coords) on a surface tilted `tiltDeg` up from +x (or -x when back) */
  function lamp3d(c, ru, rv, tiltDeg, n, back, off) {
    var t = tiltDeg * Math.PI / 180, sx = back ? -1 : 1;
    var N = [sx * Math.cos(t), Math.sin(t), 0], V = [-sx * Math.sin(t), Math.cos(t), 0], out = [];
    for (var i = 0; i < n; i++) {
      var a = (i + 0.5) / n * Math.PI * 2, u = Math.cos(a) * ru, v = Math.sin(a) * rv;
      out.push([c[0] + V[0] * v + N[0] * off, c[1] + V[1] * v + N[1] * off, c[2] + u]);
    }
    return out;
  }
  /** flared arch band (side profile ring segments) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, a0d, a1d) {
    var parts = [], n = segs || 6, A0 = (a0d == null ? 0 : a0d) * Math.PI / 180, A1 = (a1d == null ? 180 : a1d) * Math.PI / 180;
    for (var k = 0; k < n; k++) {
      var a0 = A0 + (A1 - A0) * k / n, a1 = A0 + (A1 - A0) * (k + 1) / n;
      var P = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, a0), P(rOut, a0), P(rOut, a1), P(rIn, a1)] });
    }
    return parts;
  }
  /* ---------------------------------------------------------------- rear-end kit (rear-view decals [z, y]) */
  /** small round dots (parking sensors, reflector studs): n-gon per [z, y] */
  function dots(list, r, mat, off, mirror, n) {
    return list.map(function (q) { return { t: 'poly', view: 'rear', mat: mat || 'black', offset: off || 0.007, mirror: !!mirror, pts: ell(q[0], q[1], r, r, n || 6) }; });
  }
  /** number-plate recess (black, a little larger), plate, two plate lamps under the recess top edge */
  function plateKit(zc, y0, y1, hw) {
    var w = hw || 0.26;
    return [{ t: 'poly', view: 'rear', mat: 'black', offset: 0.006, pts: rect(zc - w - 0.022, y0 - 0.018, zc + w + 0.022, y1 + 0.02) },
      { t: 'poly', view: 'rear', mat: 'plate', offset: 0.009, pts: rect(zc - w, y0, zc + w, y1) },
      { t: 'poly', view: 'rear', mat: 'white', offset: 0.009, pts: rect(zc - w * 0.62, y1 + 0.005, zc - w * 0.42, y1 + 0.014) },
      { t: 'poly', view: 'rear', mat: 'white', offset: 0.009, pts: rect(zc + w * 0.42, y1 + 0.005, zc + w * 0.62, y1 + 0.014) }];
  }
  /** rear wiper parked on the glass: pivot [z, y], arm length, angle (deg, 0 = toward +z / the viewer's right) */
  function wiper(pz, py, L, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), t = 0.009, ez = pz + c * L, ey = py + sn * L;
    var bt = 0.006;
    return [{ t: 'poly', view: 'rear', mat: 'gloss', offset: 0.012, pts: [[pz + sn * t, py - c * t], [ez + sn * bt, ey - c * bt], [ez - sn * bt, ey + c * bt], [pz - sn * t, py + c * t]] },
      { t: 'poly', view: 'rear', mat: 'black', offset: 0.014, pts: ell(pz, py, 0.022, 0.022, 6) }];
  }
  /** n vertical bars (LED blades) spread across z0..z1 between y0(z) and y1(z) (linear in z), width frac of pitch */
  function vbars(z0, z1, y0a, y0b, y1a, y1b, n, frac, mat, off, mirror) {
    var out = [], pitch = (z1 - z0) / n;
    for (var i = 0; i < n; i++) {
      var za = z0 + pitch * (i + (1 - frac) / 2), zb = za + pitch * frac, ta = (za - z0) / (z1 - z0), tb = (zb - z0) / (z1 - z0);
      out.push({ t: 'poly', view: 'rear', mat: mat, offset: off, mirror: mirror !== false, pts: [[za, y0a + (y0b - y0a) * ta], [zb, y0a + (y0b - y0a) * tb], [zb, y1a + (y1b - y1a) * tb], [za, y1a + (y1b - y1a) * ta]] });
    }
    return out;
  }
  /** low-LOD-only lamp (one flat polygon per side, mirrored unless mirror === false): the chase-cam signature */
  function lowLamp(pts, mirror, mat) { return { t: 'poly', view: 'rear', mat: mat || 'tail', low: 'only', offset: 0.012, maxTilt: 60, mirror: mirror !== false, pts: pts }; }
  function txt(str, z, y, h, mat, o) { return Object.assign({ t: 'text', view: 'rear', str: str, at: [z, y], h: h, mat: mat || 'chrome' }, o || {}); }

  /* ---------------------------------------------------------------- ring builder
     station spec: { x, k:'h'|'c'|'w', m:<row tag for the strip to the next station>,
                     yb, hw, yw, ybl, zbl, yc, (c:) yr, zr, optional overrides zb ys ysh zsh ygb zgb yg zg yq zq,
                     low:[[y,z] x6] (pts 0..5), top:[[y,z] x5] (pts 6..10) } */
  function ring(s) {
    var P = [], hw = s.hw, ybl = s.ybl, zbl = s.zbl, yc = s.yc;
    P[0] = [s.yb, 0];
    P[1] = [s.yb, s.zb != null ? s.zb : hw * 0.84];
    P[2] = [s.ys != null ? s.ys : s.yb + 0.10, s.zs != null ? s.zs : hw * 0.95];
    P[3] = [s.yw, hw];
    P[4] = [s.ysh != null ? s.ysh : ybl - (ybl - s.yw) * 0.3, s.zsh != null ? s.zsh : hw - (hw - zbl) * 0.45];
    P[5] = [ybl, zbl];
    if (s.k === 'h') {
      var d = yc - ybl;
      P[6] = [ybl + (s.e6 != null ? s.e6 : 0.008), zbl - 0.03];
      P[7] = [ybl + d * 0.4, zbl * 0.86];
      P[8] = [ybl + d * 0.62, zbl * 0.76];
      P[9] = [ybl + d * 0.93, zbl * 0.4];
      P[10] = [yc, 0];
    } else {
      P[6] = [s.ygb != null ? s.ygb : ybl + 0.015, s.zgb != null ? s.zgb : zbl - 0.04];
      P[7] = [s.yg != null ? s.yg : s.yr - 0.04, s.zg != null ? s.zg : s.zr + 0.03];
      P[8] = [s.yr, s.zr];
      P[9] = [s.yq != null ? s.yq : yc - (yc - s.yr) * 0.2, s.zq != null ? s.zq : s.zr * 0.52];
      P[10] = [yc, 0];
      for (var i = 6; i <= 10; i++) if (P[i][0] < P[i - 1][0] + 0.002) P[i][0] = P[i - 1][0] + 0.002;
    }
    if (s.low) for (i = 0; i < 6; i++) if (s.low[i]) P[i] = s.low[i].slice();
    if (s.top) for (i = 0; i < 5; i++) if (s.top[i]) P[6 + i] = s.top[i].slice();
    return P.map(function (p) { return [Math.round(p[0] * 10000) / 10000, Math.max(0, Math.round(p[1] * 10000) / 10000)]; });
  }
  /** stations + mats from a spec list and a tag -> 10 materials table */
  function shell(specs, M, capF, capR) {
    var rings = specs.map(function (s) { return s.k === 'w' ? null : ring(s); });
    specs.forEach(function (s, i) {
      if (s.k !== 'w') return;
      var a = i - 1, b = i + 1;
      while (specs[a].k === 'w') a--;
      while (specs[b].k === 'w') b++;
      var t = (specs[a].x - s.x) / (specs[a].x - specs[b].x);
      rings[i] = rings[a].map(function (p, k) { return [p[0] + (rings[b][k][0] - p[0]) * t, p[1] + (rings[b][k][1] - p[1]) * t]; });
      if (s.low) for (var q = 0; q < 6; q++) if (s.low[q]) rings[i][q] = s.low[q].slice();
    });
    return {
      stations: specs.map(function (s, i) { return { x: s.x, pts: rings[i] }; }),
      mats: specs.slice(0, -1).map(function (s) { var row = M[s.m]; if (!row) throw new Error('wagon-brake: no mats for ' + s.m); return row.slice(); }),
      capF: capF || 'paint', capR: capR || 'paint'
    };
  }
  /** a station between two 'c' specs a and b at x (numeric fields and low[] points lerped), strip tag m */
  function mid(a, b, x, m) {
    var t = (a.x - x) / (a.x - b.x), o = { x: x, k: 'c', m: m };
    Object.keys(a).forEach(function (k) {
      if (typeof a[k] === 'number' && typeof b[k] === 'number' && k !== 'x') o[k] = a[k] + (b[k] - a[k]) * t;
    });
    if (a.low && b.low) o.low = a.low.map(function (p, i) { return [p[0] + (b.low[i][0] - p[0]) * t, p[1] + (b.low[i][1] - p[1]) * t]; });
    return o;
  }
  /** splice a pillar strip (tag, default 'pillar') between x0 > x1 into the 'c' strip that contains it, so the
      side glass reads as separate door / quarter windows instead of one continuous band */
  function pillar(S, x0, x1, tag) {
    for (var i = 0; i < S.length - 1; i++) {
      var a = S[i], b = S[i + 1];
      if (a.k === 'c' && b.k === 'c' && a.x > x0 && x1 > b.x) {
        S.splice(i + 1, 0, mid(a, b, x0, tag || 'pillar'), mid(a, b, x1, a.m));
        return S;
      }
    }
    throw new Error('wagon-brake: no strip for pillar ' + x0);
  }
  /** standard material table; trim = DLO surround, roof = roof material */
  function matTable(o) {
    o = o || {};
    var tr = o.trim || 'black', tt = o.topTrim || tr, roof = o.roof || 'paint2', sill = o.sill || 'black', ap = o.aPillar || 'paint', dp = o.dPillar || 'paint';
    return {
      nose: ['under', o.lip || 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],
      hood: ['under', sill, 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],
      screen: ['under', sill, 'paint', 'paint', 'paint', tr, 'glass', ap, 'glass', 'glass'],
      cab: ['under', sill, 'paint', 'paint', 'paint', tr, 'glass', tt, roof, roof],
      pillar: ['under', sill, 'paint', 'paint', 'paint', tr, o.pillar || 'gloss', tt, roof, roof],
      dpil: ['under', sill, 'paint', 'paint', 'paint', 'paint', dp, dp, roof, roof],
      cabR: ['under', sill, 'paint', 'paint', 'paint', tr, 'glass', dp, roof, roof],
      hatch: ['under', sill, 'paint', 'paint', 'paint', 'paint', dp, dp, 'glass', 'glass'],
      tail: ['under', o.rearLip || 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint']
    };
  }
  function mirrorPart(xa, xb, y0, y1, z0, z1) {
    return [
      { t: 'prism', mat: 'mirror', mirror: true, z0: z0, z1: z1, pts2d: [[xa, y0], [xb, y0 + 0.01], [xb - 0.01, y1], [xa - 0.025, y1 - 0.005]] },
      { t: 'box', mat: 'black', mirror: true, c: [(xa + xb) / 2 + 0.03, y0 - 0.01, z0 - 0.03], s: [0.08, 0.03, 0.08] }
    ];
  }
  var defs = {};

  /* ================================================================ Audi RS 6 Avant (C8) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Audi_RS_6):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2021_Audi_RS6_Avant_in_Nardo_Gray,_front_right.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Audi_RS6_Avant_C8_IMG_0344.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Audi_RS6_Avant_C8_at_IAA_2019_IMG_0304.jpg
  // Signature: very wide gloss-black honeycomb Singleframe without a frame, big angular corner intakes, slim
  // laser lamps with a stepped lower edge, quattro blisters front and rear, long low Avant roof with flush black
  // rails and a roof spoiler, light band across the tailgate, big oval tailpipes in a black diffuser.
  (function () {
    var S = [
      { x: 2.484, k: 'h', m: 'nose', yb: 0.30, hw: 0.44, yw: 0.52, ybl: 0.64, zbl: 0.40, yc: 0.68, zb: 0.38, ys: 0.36 },
      { x: 2.45, k: 'h', m: 'nose', yb: 0.18, hw: 0.78, yw: 0.50, ybl: 0.74, zbl: 0.72, yc: 0.79, zb: 0.70, ys: 0.26 },
      { x: 2.33, k: 'h', m: 'hood', yb: 0.15, hw: 0.90, yw: 0.53, ybl: 0.815, zbl: 0.84, yc: 0.835, zb: 0.80, ys: 0.24 },
      { x: 2.06, k: 'h', m: 'hood', yb: 0.18, hw: 0.950, yw: 0.70, ybl: 0.855, zbl: 0.89, yc: 0.87, ys: 0.27 },
      { x: 1.70, k: 'h', m: 'hood', yb: 0.19, hw: 0.973, yw: 0.80, ybl: 0.895, zbl: 0.90, yc: 0.91, low: [[0.19, 0], [0.19, 0.84], [0.30, 0.92], [0.80, 0.975], [0.865, 0.95], [0.895, 0.90]] },
      { x: 1.03, k: 'h', m: 'screen', yb: 0.20, hw: 0.958, yw: 0.78, ybl: 0.985, zbl: 0.875, yc: 0.99, low: [[0.20, 0], [0.20, 0.82], [0.30, 0.89], [0.80, 0.955], [0.90, 0.93], [0.985, 0.875]] },
      // door section: narrower than the blisters, crisp tornado shoulder at 0.94, concave lower door
      { x: 0.66, k: 'w', m: 'screen', low: [[0.20, 0], [0.20, 0.78], [0.30, 0.85], [0.74, 0.928], [0.935, 0.918], [1.0, 0.855]] },
      { x: 0.17, k: 'c', m: 'cab', yb: 0.20, hw: 0.925, yw: 0.74, ybl: 1.02, zbl: 0.836, low: [[0.20, 0], [0.20, 0.78], [0.30, 0.85], [0.74, 0.925], [0.94, 0.915], [1.02, 0.836]], yg: 1.37, zg: 0.64, yr: 1.425, zr: 0.585, yq: 1.44, zq: 0.33, yc: 1.448 },
            { x: -1.10, k: 'c', m: 'cab', yb: 0.20, hw: 0.945, yw: 0.80, ybl: 1.052, zbl: 0.85, yg: 1.384, zg: 0.665, yr: 1.443, zr: 0.6, yc: 1.452, low: [[0.20, 0], [0.20, 0.79], [0.30, 0.86], [0.78, 0.945], [0.95, 0.925], [1.052, 0.85]] },
      { x: -1.85, k: 'c', m: 'cab', yb: 0.20, hw: 0.976, yw: 0.84, ybl: 1.075, zbl: 0.855, yg: 1.338, zg: 0.68, yr: 1.386, zr: 0.595, yc: 1.396, low: [[0.20, 0], [0.20, 0.84], [0.30, 0.915], [0.84, 0.978], [0.95, 0.935], [1.075, 0.855]] },
      { x: -2.10, k: 'c', m: 'cabR', yb: 0.20, hw: 0.958, yw: 0.84, ybl: 1.09, zbl: 0.835, yg: 1.30, zg: 0.695, yr: 1.362, zr: 0.565, yc: 1.372, ysh: 0.95, zsh: 0.915 },
      { x: -2.24, k: 'c', m: 'hatch', yb: 0.20, hw: 0.935, yw: 0.80, ybl: 1.10, zbl: 0.815, ygb: 1.112, zgb: 0.80, yg: 1.12, zg: 0.765, yr: 1.335, zr: 0.515, yq: 1.346, yc: 1.351 },
      { x: -2.40, k: 'c', m: 'tail', yb: 0.21, hw: 0.88, yw: 0.80, ybl: 1.07, zbl: 0.77, yg: 1.085, zg: 0.695, yr: 1.10, zr: 0.585, yc: 1.11 },
      { x: -2.48, k: 'c', m: 'tail', yb: 0.27, hw: 0.80, yw: 0.70, ybl: 0.92, zbl: 0.72, yg: 0.93, zg: 0.675, yr: 0.935, zr: 0.585, yc: 0.94, ys: 0.33 },
      { x: -2.521, k: 'c', m: 'tail', yb: 0.42, hw: 0.68, yw: 0.62, ybl: 0.69, zbl: 0.62, yg: 0.70, zg: 0.575, yr: 0.705, zr: 0.515, yc: 0.71, ys: 0.46, ysh: 0.66 }
    ];
    // gloss-black B-pillar between the door glasses and a C-pillar ahead of the rear quarter glass (the DLO
    // reads as three windows, not one band)
    pillar(pillar(S, -0.30, -0.40), -1.12, -1.22);
    var M = matTable({ trim: 'chrome', roof: 'paint2', sill: 'black' });
    defs['audi-rs6-avant-c8'] = {
      body: shell(S, M, 'paint', 'paint'),
      parts: [].concat(
        // Singleframe: gloss frame-less honeycomb hexagon, slot under the bonnet edge, plate (no emblem)
        polys([[[-0.53, 0.75], [0.53, 0.75], [0.62, 0.60], [0.53, 0.26], [-0.53, 0.26], [-0.62, 0.60]]], 'front', 'grille', 0.006, false),
        polys([rect(-0.40, 0.765, 0.40, 0.79)], 'front', 'black', 0.006, false),
        polys([rect(-0.26, 0.40, 0.26, 0.51)], 'front', 'plate', 0.012, false),
        // corner intakes (angular, honeycomb) with the vertical blade
        polys([[[0.62, 0.26], [0.92, 0.26], [0.95, 0.66], [0.88, 0.69], [0.66, 0.58]]], 'front', 'grille', 0.006, true),
        polys([[[0.70, 0.27], [0.735, 0.27], [0.815, 0.62], [0.78, 0.625]]], 'front', 'paint', 0.009, true),
        // slim laser headlamps: stepped lower edge, DRL blades along the bottom
        polys([[[0.56, 0.745], [0.60, 0.79], [0.93, 0.815], [0.955, 0.78], [0.88, 0.745], [0.74, 0.725], [0.66, 0.70]]], 'front', 'gloss', 0.006, true),
        polys([[[0.60, 0.755], [0.63, 0.785], [0.92, 0.805], [0.935, 0.785], [0.86, 0.76], [0.72, 0.745], [0.66, 0.725]]], 'front', 'light', 0.009, true),
        polys([[[0.64, 0.722], [0.74, 0.738], [0.88, 0.755], [0.885, 0.766], [0.73, 0.75], [0.64, 0.732]]], 'front', 'drl', 0.012, true),
        // lower lip / splitter blade
        polys([rect(-0.92, 0.16, 0.92, 0.215)], 'front', 'black', 0.007, false),
        // rear (C8 rear photos IAA 2019 / 2019 RS6 Rear End / 2023 Nardo Grey rear): smoked lamps with ten vertical
        // LED blades and a lit top edge, split at the tailgate shut line, plate between the lamps, chrome strip,
        // "RS 6" under the left lamp, silver U diffuser surround round a honeycomb diffuser, red
        // corner lamps, sensor dots, roof spoiler with the 3rd brake light, rear wiper
        polys([[[0.33, 0.968], [0.80, 0.962], [0.865, 1.065], [0.33, 1.08]]], 'rear', 'smoke', 0.007, true),
        polys([[[0.34, 1.062], [0.84, 1.052], [0.856, 1.068], [0.34, 1.078]]], 'rear', 'tail', 0.010, true),
        vbars(0.39, 0.81, 0.98, 0.976, 1.052, 1.05, 10, 0.42, 'tail', 0.010),
        polys([rect(0.345, 0.985, 0.372, 1.04)], 'rear', 'rev', 0.010, true),
        polys([[[0.40, 0.969], [0.79, 0.965], [0.80, 0.972], [0.40, 0.976]]], 'rear', 'indicator', 0.010, true),
        polys([rect(0.598, 0.95, 0.606, 1.085)], 'rear', 'black', 0.013, true),     // tailgate shut line through the lamp
        polys([rect(-0.606, 0.842, 0.606, 0.85), rect(0.598, 0.842, 0.606, 0.96)], 'rear', 'black', 0.007, true),
        polys([rect(-0.33, 1.046, 0.33, 1.056)], 'rear', 'chrome', 0.009, false),
        plateKit(0, 0.93, 1.03, 0.235),
        [txt('RS 6', -0.47, 0.905, 0.034, 'chrome', { skew: 0.12 })],
        polys([[[-0.78, 0.25], [0.78, 0.25], [0.80, 0.46], [0.75, 0.46], [0.71, 0.30], [-0.71, 0.30], [-0.75, 0.46], [-0.80, 0.46]]], 'rear', 'badge', 0.006, false).map(tilt(12)),
        polys([[[-0.71, 0.30], [0.71, 0.30], [0.745, 0.44], [-0.745, 0.44]]], 'rear', 'grille', 0.004, false).map(tilt(12)),
        polys([-3, -1, 1, 3].map(function (k) { var z = k * 0.1; return rect(z - 0.008, 0.305, z + 0.008, 0.43); }), 'rear', 'gloss', 0.004, false).map(tilt(12)),
        polys([rect(0.79, 0.31, 0.806, 0.45)], 'rear', 'tail', 0.010, true),
        dots([[0.22, 0.56], [0.52, 0.55]], 0.009, 'gloss', 0.007, true),
        polys([rect(-0.24, 1.322, 0.24, 1.332)], 'rear', 'tail', 0.010, false),
        wiper(0.0, 1.17, 0.40, 8),
        [{ t: 'prism', mat: 'gloss', mirror: true, z0: 0, z1: 0.50, pts2d: [[-2.16, 1.36], [-2.33, 1.338], [-2.335, 1.322], [-2.20, 1.338]] }],
        [lowLamp([[0.33, 0.965], [0.82, 0.962], [0.865, 1.065], [0.33, 1.08]]), lowLamp(rect(0.79, 0.31, 0.806, 0.45))],
        // flush black roof rails, door handles, mirrors, side blade
        [{ t: 'prism', mat: 'gloss', mirror: true, z0: 0.585, z1: 0.645, pts2d: [[0.05, 1.432], [-0.60, 1.458], [-1.40, 1.448], [-2.05, 1.38], [-2.05, 1.40], [-1.40, 1.468], [-0.60, 1.478], [0.05, 1.45]] }],
        polys([rect(0.42, 0.955, 0.56, 0.98), rect(-0.68, 0.98, -0.54, 1.005)], 'side', 'black', 0.004, true),
        mirrorPart(0.78, 0.62, 1.05, 1.13, 0.84, 1.0)
      ),
      exhaust: [{ cx: 0.64, cy: 0.335, w: 0.21, h: 0.115, shape: 'oval', mirror: true }],
      wheels: { style: 'split', spokes: 5 },
      notes: 'Audi RS 6 Avant (C8) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2021_Audi_RS6_Avant_in_Nardo_Gray,_front_right.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Audi_RS6_Avant_C8_IMG_0344.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Audi_RS6_Avant_C8_at_IAA_2019_IMG_0304.jpg (rear 3/4), ' +
        'rear-detail pass: https://commons.wikimedia.org/wiki/File:2019_Audi_RS6_Avant_4.0_Rear_End.jpg (rear), ' +
        'https://commons.wikimedia.org/wiki/File:2023_Audi_RS6_Avant_in_Nardo_Grey_(Rear).jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Mercedes-AMG E 63 S 4MATIC+ Estate (S213, facelift) */
  // Reference photos (Wikimedia Commons):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mercedes-Benz_E-Klasse_T-Modell_(S213)_E_63_S_4MATIC%2B_AMG_(2022)_(53473649223).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mercedes-AMG_E63_Estate_S_(S213)_Washington_DC_Metro_Area,_USA.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Mercedes-AMG_E63_S_Estate_(S213)_Greater_Toronto_Area,_Canada_(1).jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2017_Mercedes-Benz_E220d_AMG_Line_Premium_Estate_2.0_Rear.jpg
  // Signature: AMG Panamericana grille (vertical chrome slats, big round badge), flat angular LED lamps, AMG A-wing
  // bumper with large outer intakes, chrome DLO surround, raked estate tailgate under a roof spoiler, wide
  // horizontal tail lamps running into the tailgate with a chrome strip between, quad square tips in a diffuser.
  (function () {
    var S = [
      { x: 2.409, k: 'h', m: 'nose', yb: 0.30, hw: 0.42, yw: 0.53, ybl: 0.62, zbl: 0.38, yc: 0.66, zb: 0.36, ys: 0.36 },
      { x: 2.37, k: 'h', m: 'nose', yb: 0.19, hw: 0.72, yw: 0.50, ybl: 0.72, zbl: 0.66, yc: 0.75, zb: 0.64, ys: 0.26 },
      { x: 2.25, k: 'h', m: 'hood', yb: 0.16, hw: 0.85, yw: 0.52, ybl: 0.765, zbl: 0.80, yc: 0.79, zb: 0.76, ys: 0.24 },
      { x: 1.99, k: 'h', m: 'hood', yb: 0.19, hw: 0.915, yw: 0.64, ybl: 0.805, zbl: 0.86, yc: 0.825 },
      { x: 1.62, k: 'h', m: 'hood', yb: 0.20, hw: 0.954, yw: 0.78, ybl: 0.855, zbl: 0.88, yc: 0.875, ysh: 0.83, zsh: 0.93 },
      { x: 0.98, k: 'h', m: 'screen', yb: 0.215, hw: 0.946, yw: 0.76, ybl: 0.965, zbl: 0.86, yc: 0.975 },
      { x: 0.55, k: 'w', m: 'screen' },
      { x: 0.12, k: 'c', m: 'cab', yb: 0.215, hw: 0.927, yw: 0.80, ybl: 1.016, zbl: 0.83, yg: 1.355, zg: 0.63, yr: 1.395, zr: 0.575, yq: 1.405, zq: 0.31, yc: 1.41 },
      { x: -0.45, k: 'c', m: 'cab', yb: 0.215, hw: 0.931, yw: 0.80, ybl: 1.032, zbl: 0.83, yg: 1.406, zg: 0.64, yr: 1.452, zr: 0.585, yc: 1.465 },
      { x: -1.30, k: 'c', m: 'cab', yb: 0.215, hw: 0.952, yw: 0.83, ybl: 1.06, zbl: 0.845, yg: 1.393, zg: 0.66, yr: 1.442, zr: 0.595, yc: 1.452, ysh: 0.92, zsh: 0.925 },
      { x: -1.95, k: 'c', m: 'cab', yb: 0.215, hw: 0.945, yw: 0.83, ybl: 1.085, zbl: 0.835, yg: 1.352, zg: 0.67, yr: 1.40, zr: 0.585, yc: 1.415, ysh: 0.95, zsh: 0.91 },
      { x: -2.24, k: 'c', m: 'dpil', yb: 0.215, hw: 0.905, yw: 0.80, ybl: 1.11, zbl: 0.80, ygb: 1.125, zgb: 0.77, yg: 1.29, zg: 0.695, yr: 1.375, zr: 0.54, yc: 1.39 },
      { x: -2.39, k: 'c', m: 'hatch', yb: 0.215, hw: 0.865, yw: 0.80, ybl: 1.12, zbl: 0.77, ygb: 1.13, zgb: 0.76, yg: 1.14, zg: 0.75, yr: 1.35, zr: 0.49, yq: 1.358, yc: 1.362 },
      { x: -2.52, k: 'c', m: 'tail', yb: 0.215, hw: 0.82, yw: 0.80, ybl: 1.08, zbl: 0.73, yg: 1.10, zg: 0.67, yr: 1.115, zr: 0.57, yc: 1.122 },
      { x: -2.585, k: 'c', m: 'tail', yb: 0.30, hw: 0.74, yw: 0.72, ybl: 0.90, zbl: 0.68, yg: 0.91, zg: 0.64, yr: 0.915, zr: 0.56, yc: 0.92, ys: 0.36 },
      { x: -2.598, k: 'c', m: 'tail', yb: 0.42, hw: 0.62, yw: 0.62, ybl: 0.70, zbl: 0.58, yg: 0.71, zg: 0.54, yr: 0.715, zr: 0.48, yc: 0.72, ys: 0.46, ysh: 0.67 }
    ];
    pillar(pillar(S, -0.30, -0.40), -1.40, -1.50);   // B-pillar, C-pillar ahead of the quarter glass
    var M = matTable({ trim: 'chrome', roof: 'paint2', sill: 'black' });
    defs['mercedes-amg-e63s-estate-s213'] = {
      body: shell(S, M, 'paint', 'paint'),
      parts: [].concat(
        // Panamericana grille: chrome frame, dark field, vertical chrome slats, big round badge
        polys([[[-0.31, 0.70], [0.31, 0.70], [0.38, 0.385], [-0.38, 0.385]]], 'front', 'chrome', 0.005, false),
        polys([[[-0.29, 0.685], [0.29, 0.685], [0.355, 0.40], [-0.355, 0.40]]], 'front', 'grille', 0.008, false),
        polys([-4, -3, -2, -1, 0, 1, 2, 3, 4].map(function (k) { var z = k * 0.07; return rect(z - 0.007, 0.41, z + 0.007, 0.675); }), 'front', 'chrome', 0.011, false),   // no star: slats run across
        // flat angular LED lamps with the eyebrow DRL
        polys([[[0.40, 0.665], [0.47, 0.71], [0.82, 0.765], [0.885, 0.735], [0.82, 0.685], [0.55, 0.625]]], 'front', 'gloss', 0.006, true),
        polys([[[0.46, 0.66], [0.50, 0.69], [0.80, 0.735], [0.83, 0.715], [0.78, 0.69], [0.56, 0.645]]], 'front', 'light', 0.009, true),
        polys([[[0.47, 0.70], [0.81, 0.755], [0.84, 0.742], [0.49, 0.688]]], 'front', 'drl', 0.012, true),
        // AMG A-wing bumper: outer intakes with a body-colour fin, centre intake, plate, chrome splitter strip
        polys([[[0.46, 0.22], [0.85, 0.25], [0.90, 0.53], [0.66, 0.53], [0.47, 0.40]]], 'front', 'grille', 0.006, true),
        polys([[[0.52, 0.355], [0.86, 0.37], [0.865, 0.395], [0.53, 0.38]]], 'front', 'paint', 0.009, true),
        polys([rect(-0.44, 0.19, 0.44, 0.30)], 'front', 'grille', 0.006, false),
        polys([rect(-0.26, 0.29, 0.26, 0.385)], 'front', 'plate', 0.009, false),
        // rear (S213 facelift rear photos, Toronto E 63 S / E220d AMG Line): wide two-piece smoked lamps with
        // three red LED light-lines (outer) / two (tailgate piece), reverse + indicator strips, chrome strip,
        // round badge with "AMG" / "E 63 S" either side, plate recess, black diffuser with fins and a chrome
        // blade, quad trapezoid tips, corner reflectors, sensor dots, roof spoiler + 3rd brake light, wiper
        polys([[[0.47, 0.985], [0.84, 0.99], [0.89, 1.06], [0.84, 1.105], [0.47, 1.10]]], 'rear', 'smoke', 0.007, true),
        polys([[[0.30, 1.01], [0.47, 0.995], [0.47, 1.09], [0.30, 1.07]]], 'rear', 'smoke', 0.007, true),
        polys([0, 1, 2].map(function (k) { var y = 1.005 + k * 0.03; return [[0.47, y], [0.80 + k * 0.03, y + 0.004], [0.83 + k * 0.03, y + 0.014], [0.47, y + 0.011]]; }), 'rear', 'tail', 0.010, true),
        polys([0, 1].map(function (k) { var y = 1.02 + k * 0.032; return [[0.31, y - 0.004], [0.468, y], [0.468, y + 0.011], [0.31, y + 0.007]]; }), 'rear', 'tail', 0.010, true),
        polys([[[0.84, 1.098], [0.86, 1.07], [0.875, 1.072], [0.855, 1.10]]], 'rear', 'tail', 0.010, true),
        polys([rect(0.36, 1.075, 0.44, 1.083)], 'rear', 'rev', 0.010, true),
        polys([[[0.50, 0.992], [0.80, 0.995], [0.81, 1.0], [0.50, 0.998]]], 'rear', 'indicator', 0.010, true),
        polys([rect(0.468, 0.99, 0.474, 1.10)], 'rear', 'black', 0.012, true),      // tailgate split between the lamp halves
        polys([[[-2.47, 0.995], [-2.48, 1.10], [-2.535, 1.09], [-2.575, 1.0], [-2.54, 0.985]]], 'side', 'tail', 0.006, true),
        [txt('AMG', -0.20, 1.078, 0.026, 'chrome'), txt('E 63 S', 0.20, 1.078, 0.024, 'chrome')],
        polys([rect(-0.472, 0.84, 0.472, 0.847), rect(0.466, 0.84, 0.473, 0.99)], 'rear', 'black', 0.007, true),
        polys([rect(0.76, 0.47, 0.83, 0.49)], 'rear', 'lens', 0.008, true),
        dots([[0.24, 0.56], [0.55, 0.55]], 0.009, 'gloss', 0.007, true),
        polys([rect(-0.24, 1.34, 0.24, 1.35)], 'rear', 'tail', 0.010, false),
        wiper(0.0, 1.16, 0.38, 10),
        [{ t: 'prism', mat: 'paint', mirror: true, z0: 0, z1: 0.47, pts2d: [[-2.33, 1.372], [-2.45, 1.352], [-2.455, 1.338], [-2.36, 1.35]] }],
        [lowLamp([[0.30, 1.0], [0.84, 0.99], [0.89, 1.06], [0.84, 1.105], [0.30, 1.08]])],
        // chrome DLO surround curling round the rounded rear end of the quarter glass onto the D-pillar
        polys([[[-2.215, 1.118], [-2.25, 1.125], [-2.275, 1.21], [-2.255, 1.305], [-2.225, 1.30], [-2.245, 1.21], [-2.228, 1.135]]], 'side', 'chrome', 0.006, true),
        polys([rect(-0.30, 1.03, 0.30, 1.045)], 'rear', 'chrome', 0.008, false),
        plateKit(0, 0.875, 0.975, 0.24),
        polys([rect(-0.84, 0.22, 0.84, 0.42)], 'rear', 'grille', 0.006, false),
        polys([-3, -1, 1, 3].map(function (k) { var z = k * 0.1; return rect(z - 0.008, 0.25, z + 0.008, 0.40); }), 'rear', 'gloss', 0.010, false),
        polys([rect(-0.84, 0.42, 0.84, 0.435)], 'rear', 'chrome', 0.008, false),
        // chrome roof rails, door handles, mirrors
        [{ t: 'prism', mat: 'chrome', mirror: true, z0: 0.55, z1: 0.60, pts2d: [[0.0, 1.425], [-0.70, 1.462], [-1.50, 1.445], [-2.20, 1.385], [-2.20, 1.405], [-1.50, 1.47], [-0.70, 1.487], [0.0, 1.445]] }],
        polys([rect(0.36, 0.955, 0.50, 0.98), rect(-0.75, 0.985, -0.61, 1.01)], 'side', 'chrome', 0.004, true),
        mirrorPart(0.74, 0.58, 1.04, 1.13, 0.83, 1.0)
      ),
      exhaust: [{ cx: 0.52, cy: 0.295, w: 0.12, h: 0.075, shape: 'trapezoid', mirror: true }, { cx: 0.67, cy: 0.295, w: 0.12, h: 0.075, shape: 'trapezoid', mirror: true }],
      wheels: { style: 'split', spokes: 5 },
      notes: 'Mercedes-AMG E 63 S Estate (S213 facelift) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-Benz_E-Klasse_T-Modell_(S213)_E_63_S_4MATIC%2B_AMG_(2022)_(53473649223).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-AMG_E63_Estate_S_(S213)_Washington_DC_Metro_Area,_USA.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-AMG_E63_S_Estate_(S213)_Greater_Toronto_Area,_Canada_(1).jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2017_Mercedes-Benz_E220d_AMG_Line_Premium_Estate_2.0_Rear.jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Volvo V60 T8 Polestar Engineered (SPA) */
  // Reference photos (Wikimedia Commons):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Volvo_V60_Polestar_Engineered_(SPA)_DSC_0746.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Volvo_V60_Polestar_Engineered_(SPA)_Washington_DC_Metro_Area,_USA.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Volvo_V60_T8_IMG_0976.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2018_Volvo_V60_Momentum_PRO_D4_Automatic_2.0_Rear.jpg
  // Signature: upright concave grille with the diagonal chrome bar, "Thor's hammer" T-shaped DRLs, long
  // bonnet with the cowl set well back, flat roof, short hockey-stick DLO kick, tall L-shaped tail lamps running
  // up the D-pillars, widely spaced VOLVO letters on the tailgate, gold Brembo calipers (Polestar Engineered).
  (function () {
    var S = [
      { x: 2.312, k: 'h', m: 'nose', yb: 0.30, hw: 0.42, yw: 0.54, ybl: 0.66, zbl: 0.38, yc: 0.70, zb: 0.36, ys: 0.36 },
      { x: 2.28, k: 'h', m: 'nose', yb: 0.19, hw: 0.74, yw: 0.52, ybl: 0.785, zbl: 0.70, yc: 0.805, zb: 0.66, ys: 0.26 },
      { x: 2.17, k: 'h', m: 'hood', yb: 0.16, hw: 0.85, yw: 0.53, ybl: 0.828, zbl: 0.82, yc: 0.842, zb: 0.76, ys: 0.24 },
      { x: 1.90, k: 'h', m: 'hood', yb: 0.19, hw: 0.90, yw: 0.66, ybl: 0.857, zbl: 0.865, yc: 0.868 },
      { x: 1.55, k: 'h', m: 'hood', yb: 0.20, hw: 0.926, yw: 0.76, ybl: 0.89, zbl: 0.875, yc: 0.90, ysh: 0.85, zsh: 0.91 },
      { x: 0.88, k: 'h', m: 'screen', yb: 0.205, hw: 0.916, yw: 0.74, ybl: 0.955, zbl: 0.855, yc: 0.965 },
      { x: 0.47, k: 'w', m: 'screen' },
      { x: 0.06, k: 'c', m: 'cab', yb: 0.205, hw: 0.90, yw: 0.78, ybl: 1.008, zbl: 0.81, yg: 1.33, zg: 0.62, yr: 1.365, zr: 0.565, yq: 1.374, zq: 0.30, yc: 1.378 },
      { x: -0.50, k: 'c', m: 'cab', yb: 0.205, hw: 0.906, yw: 0.79, ybl: 1.02, zbl: 0.815, yg: 1.372, zg: 0.63, yr: 1.422, zr: 0.575, yc: 1.432 },
      { x: -1.40, k: 'c', m: 'cab', yb: 0.205, hw: 0.925, yw: 0.82, ybl: 1.04, zbl: 0.83, yg: 1.36, zg: 0.655, yr: 1.415, zr: 0.585, yc: 1.424, ysh: 0.92, zsh: 0.905 },
      { x: -1.74, k: 'c', m: 'cab', yb: 0.205, hw: 0.927, yw: 0.82, ybl: 1.055, zbl: 0.83, yg: 1.345, zg: 0.66, yr: 1.41, zr: 0.58, yc: 1.418, ysh: 0.93, zsh: 0.905 },
      { x: -1.88, k: 'c', m: 'cab', yb: 0.205, hw: 0.922, yw: 0.82, ybl: 1.105, zbl: 0.81, ygb: 1.118, zgb: 0.785, yg: 1.335, zg: 0.67, yr: 1.405, zr: 0.575, yc: 1.412, ysh: 0.95, zsh: 0.90 },
      { x: -2.17, k: 'c', m: 'dpil', yb: 0.205, hw: 0.88, yw: 0.80, ybl: 1.11, zbl: 0.79, ygb: 1.125, zgb: 0.765, yg: 1.30, zg: 0.69, yr: 1.383, zr: 0.54, yc: 1.392 },
      { x: -2.235, k: 'c', m: 'hatch', yb: 0.205, hw: 0.86, yw: 0.80, ybl: 1.10, zbl: 0.775, ygb: 1.11, zgb: 0.765, yg: 1.12, zg: 0.755, yr: 1.36, zr: 0.50, yq: 1.368, yc: 1.372 },
      { x: -2.34, k: 'c', m: 'tail', yb: 0.21, hw: 0.82, yw: 0.80, ybl: 1.04, zbl: 0.75, yg: 1.05, zg: 0.70, yr: 1.06, zr: 0.61, yc: 1.065 },
      { x: -2.41, k: 'c', m: 'tail', yb: 0.25, hw: 0.75, yw: 0.72, ybl: 0.90, zbl: 0.69, yg: 0.91, zg: 0.65, yr: 0.915, zr: 0.58, yc: 0.92, ys: 0.32 },
      { x: -2.457, k: 'c', m: 'tail', yb: 0.42, hw: 0.62, yw: 0.62, ybl: 0.69, zbl: 0.58, yg: 0.70, zg: 0.54, yr: 0.705, zr: 0.50, yc: 0.71, ys: 0.46, ysh: 0.66 }
    ];
    pillar(pillar(S, -0.36, -0.46), -1.42, -1.50);   // B-pillar, C-pillar ahead of the quarter glass
    var M = matTable({ trim: 'gloss', roof: 'paint2', sill: 'black' });
    defs['volvo-v60-polestar-engineered'] = {
      body: shell(S, M, 'paint', 'paint'),
      parts: [].concat(
        // upright grille: chrome frame, dark field, vertical bars, no emblem (text-only badges)
        polys([[[-0.36, 0.42], [0.36, 0.42], [0.40, 0.46], [0.40, 0.70], [0.36, 0.745], [-0.36, 0.745], [-0.40, 0.70], [-0.40, 0.46]]], 'front', 'chrome', 0.005, false),
        polys([[[-0.34, 0.44], [0.34, 0.44], [0.375, 0.47], [0.375, 0.69], [0.34, 0.725], [-0.34, 0.725], [-0.375, 0.69], [-0.375, 0.47]]], 'front', 'grille', 0.008, false),
        polys([-4, -3, -2, -1, 1, 2, 3, 4].map(function (k) { var z = k * 0.075; return rect(z - 0.006, 0.45, z + 0.006, 0.715); }), 'front', 'gloss', 0.010, false),
        // headlamps with Thor's-hammer DRL (horizontal bar + inboard head)
        polys([[[0.42, 0.685], [0.86, 0.715], [0.905, 0.81], [0.47, 0.805], [0.41, 0.75]]], 'front', 'gloss', 0.006, true),
        polys([[[0.68, 0.716], [0.84, 0.728], [0.872, 0.79], [0.68, 0.792]]], 'front', 'light', 0.009, true),
        // Thor's hammer: a full-width bar with the hammer head standing across its inboard end
        polys([rect(0.46, 0.746, 0.86, 0.762), rect(0.585, 0.71, 0.603, 0.796)], 'front', 'drl', 0.012, true),
        // lower bumper: corner vents with chrome slats, lower intake, plate
        polys([[[0.58, 0.28], [0.82, 0.28], [0.86, 0.50], [0.62, 0.50]]], 'front', 'grille', 0.006, true),
        polys([0, 1, 2].map(function (k) { var y = 0.33 + k * 0.06; return [[0.60 + k * 0.009, y], [0.83 + k * 0.009, y], [0.835 + k * 0.009, y + 0.012], [0.605 + k * 0.009, y + 0.012]]; }), 'front', 'chrome', 0.009, true),
        polys([rect(-0.55, 0.19, 0.55, 0.29)], 'front', 'grille', 0.006, false),
        polys([rect(-0.26, 0.30, 0.26, 0.40)], 'front', 'plate', 0.008, false),
        // rear (V60 rear photos, PE Washington DC / 2018 Momentum PRO): tall L lamps up the D-pillars, red lens with
        // the lit L outline + inner blade, indicator / reverse in the inner column, VOLVO spaced letters under the
        // glass, "V60" left, plate recess, tailgate shut line, black diffuser with chrome blade and integrated
        // outlets, red reflector slits, sensor dots, roof spoiler + 3rd brake light, rear wiper
        polys([[[0.60, 0.92], [0.80, 0.93], [0.80, 1.31], [0.72, 1.33], [0.70, 1.0], [0.60, 1.0]]], 'rear', 'lens', 0.008, true),
        polys([[[0.73, 1.03], [0.775, 1.03], [0.775, 1.26], [0.74, 1.27]]], 'rear', 'gloss', 0.011, true),
        polys([[[0.778, 0.95], [0.797, 0.95], [0.797, 1.30], [0.778, 1.312]], [[0.61, 0.928], [0.79, 0.937], [0.79, 0.953], [0.61, 0.947]],
          [[0.705, 0.975], [0.724, 0.975], [0.735, 1.31], [0.72, 1.318]]], 'rear', 'tail', 0.011, true),
        polys([rect(0.737, 1.12, 0.772, 1.16)], 'rear', 'rev', 0.013, true),
        polys([rect(0.737, 1.04, 0.772, 1.07)], 'rear', 'indicator', 0.013, true),
        [txt('VOLVO', 0, 1.03, 0.036, 'chrome', { spacing: 4.2, weight: 0.13 }), txt('V60', -0.44, 0.885, 0.03, 'chrome', { weight: 0.13 })],
        polys([rect(-0.60, 0.80, 0.60, 0.808), rect(0.593, 0.80, 0.60, 0.92)], 'rear', 'black', 0.007, true),
        polys([rect(-0.50, 0.40, 0.50, 0.41)], 'rear', 'chrome', 0.008, false),
        polys([rect(0.70, 0.455, 0.79, 0.472)], 'rear', 'lens', 0.008, true),
        dots([[0.24, 0.56], [0.55, 0.55]], 0.009, 'gloss', 0.007, true),
        polys([rect(-0.20, 1.352, 0.20, 1.362)], 'rear', 'tail', 0.010, false),
        wiper(0.0, 1.13, 0.36, 10),
        [{ t: 'prism', mat: 'paint', mirror: true, z0: 0, z1: 0.50, pts2d: [[-2.15, 1.402], [-2.30, 1.378], [-2.305, 1.362], [-2.19, 1.386]] }],
        [lowLamp([[0.60, 0.92], [0.80, 0.93], [0.80, 1.31], [0.72, 1.33], [0.70, 1.0], [0.60, 1.0]])],
        // the lamps wrap round the tail corners and climb the D-pillars (seen from the side)
        polys([[[-2.38, 0.93], [-2.52, 0.93], [-2.46, 1.10], [-2.28, 1.28], [-2.20, 1.29], [-2.33, 1.05]]], 'side', 'tail', 0.006, true),
        plateKit(0, 0.845, 0.945, 0.24),
        polys([rect(-0.82, 0.22, 0.82, 0.40)], 'rear', 'black', 0.006, false),
        polys([rect(0.50, 0.27, 0.70, 0.33)], 'rear', 'chrome', 0.009, true),
        polys([rect(0.515, 0.28, 0.685, 0.32)], 'rear', 'gloss', 0.012, true),
        // flush roof rails, door handles, mirrors
        [{ t: 'prism', mat: 'gloss', mirror: true, z0: 0.54, z1: 0.59, pts2d: [[-0.05, 1.395], [-0.70, 1.43], [-1.50, 1.423], [-2.15, 1.385], [-2.15, 1.405], [-1.50, 1.443], [-0.70, 1.45], [-0.05, 1.41]] }],
        polys([rect(0.30, 0.94, 0.44, 0.965), rect(-0.80, 0.965, -0.66, 0.99)], 'side', 'chrome', 0.004, true),
        mirrorPart(0.66, 0.50, 1.03, 1.12, 0.81, 0.98)
      ),
      exhaust: [],   // integrated faux outlets (decals) only
      wheels: { style: 'y', spokes: 5 },
      notes: 'Volvo V60 Polestar Engineered — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:Volvo_V60_Polestar_Engineered_(SPA)_DSC_0746.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Volvo_V60_Polestar_Engineered_(SPA)_Washington_DC_Metro_Area,_USA.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Volvo_V60_T8_IMG_0976.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2018_Volvo_V60_Momentum_PRO_D4_Automatic_2.0_Rear.jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Porsche Taycan 4S Cross Turismo (Y1B) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Porsche_Taycan):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Porsche_Taycan_Cross_Turismo.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2024_Porsche_Taycan_Cross_Turismo_IMG_9332.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Porsche_Taycan_Turbo_S_Cross_Turismo_Rear.jpg
  // Signature: low nose dipping between raised fender crests, upright teardrop lamps with the four-point DRL and
  // the black air-curtain inlet below, narrow glasshouse on wide haunches, long sloping roof with rails ending in
  // a roof spoiler, the black "flyline" blade on the D-pillar, full-width light bar with PORSCHE lettering,
  // black Cross Turismo arch / rocker / bumper cladding.
  (function () {
    function hood(ycr, zcr, yc) { return [[ycr - 0.004, zcr - 0.07], [ycr - (ycr - yc) * 0.45, zcr - 0.20], [yc + 0.008, zcr * 0.5], [yc + 0.002, zcr * 0.25], [yc, 0]]; }
    var S = [
      { x: 2.418, k: 'h', m: 'nose', yb: 0.33, hw: 0.40, yw: 0.45, ybl: 0.56, zbl: 0.36, yc: 0.58, zb: 0.33, ys: 0.38 },
      { x: 2.39, k: 'h', m: 'nose', yb: 0.23, hw: 0.74, yw: 0.45, ybl: 0.66, zbl: 0.70, yc: 0.585, zb: 0.66, ys: 0.30, top: hood(0.66, 0.70, 0.585) },
      { x: 2.25, k: 'h', m: 'hood', yb: 0.19, hw: 0.87, yw: 0.50, ybl: 0.765, zbl: 0.79, yc: 0.68, zb: 0.78, ys: 0.26, top: hood(0.765, 0.79, 0.68) },
      { x: 2.00, k: 'h', m: 'hood', yb: 0.21, hw: 0.945, yw: 0.58, ybl: 0.826, zbl: 0.81, yc: 0.765, top: hood(0.826, 0.81, 0.765) },
      { x: 1.65, k: 'h', m: 'hood', yb: 0.22, hw: 0.966, yw: 0.78, ybl: 0.865, zbl: 0.80, yc: 0.815, ysh: 0.83, zsh: 0.90, top: hood(0.865, 0.80, 0.815) },
      { x: 1.20, k: 'h', m: 'hood', yb: 0.22, hw: 0.962, yw: 0.76, ybl: 0.905, zbl: 0.79, yc: 0.865, ysh: 0.86, zsh: 0.89, top: hood(0.905, 0.79, 0.865) },
      { x: 0.80, k: 'h', m: 'screen', yb: 0.22, hw: 0.948, yw: 0.74, ybl: 0.955, zbl: 0.77, yc: 0.935, ysh: 0.88, zsh: 0.87, top: [[0.957, 0.71], [0.952, 0.64], [0.945, 0.55], [0.938, 0.30], [0.935, 0]] },
      { x: 0.33, k: 'w', m: 'screen' },
      { x: -0.13, k: 'c', m: 'cab', yb: 0.22, hw: 0.937, yw: 0.76, ybl: 0.972, zbl: 0.745, yg: 1.335, zg: 0.555, yr: 1.372, zr: 0.50, yq: 1.382, zq: 0.27, yc: 1.386, ysh: 0.89, zsh: 0.86 },
      { x: -0.75, k: 'c', m: 'cab', yb: 0.22, hw: 0.955, yw: 0.78, ybl: 0.978, zbl: 0.73, yg: 1.384, zg: 0.55, yr: 1.402, zr: 0.50, yc: 1.409, ysh: 0.90, zsh: 0.86 },
      { x: -1.40, k: 'c', m: 'cab', yb: 0.22, hw: 0.983, yw: 0.88, ybl: 0.99, zbl: 0.69, yg: 1.36, zg: 0.525, yr: 1.385, zr: 0.48, yc: 1.395, ysh: 0.95, zsh: 0.90 },
      { x: -1.85, k: 'c', m: 'cab', yb: 0.22, hw: 0.98, yw: 0.86, ybl: 1.03, zbl: 0.64, ygb: 1.04, zgb: 0.61, yg: 1.305, zg: 0.50, yr: 1.345, zr: 0.46, yc: 1.35, ysh: 0.97, zsh: 0.86 },
      { x: -2.07, k: 'c', m: 'dpil', yb: 0.225, hw: 0.955, yw: 0.82, ybl: 1.10, zbl: 0.60, ygb: 1.195, zgb: 0.555, yg: 1.205, zg: 0.55, yr: 1.29, zr: 0.45, yc: 1.30, ysh: 1.0, zsh: 0.80 },
      { x: -2.14, k: 'c', m: 'hatch', yb: 0.228, hw: 0.94, yw: 0.80, ybl: 1.10, zbl: 0.62, ygb: 1.11, zgb: 0.60, yg: 1.12, zg: 0.59, yr: 1.255, zr: 0.44, yq: 1.262, yc: 1.265, ysh: 1.0, zsh: 0.80 },
      { x: -2.40, k: 'c', m: 'tail', yb: 0.237, hw: 0.853, yw: 0.80, ybl: 1.04, zbl: 0.66, yg: 1.05, zg: 0.62, yr: 1.058, zr: 0.55, yc: 1.062 },
      { x: -2.505, k: 'c', m: 'tail', yb: 0.25, hw: 0.78, yw: 0.78, ybl: 0.955, zbl: 0.66, yg: 0.96, zg: 0.62, yr: 0.965, zr: 0.55, yc: 0.97, ys: 0.33 },
      { x: -2.557, k: 'c', m: 'tail', yb: 0.42, hw: 0.62, yw: 0.70, ybl: 0.80, zbl: 0.56, yg: 0.81, zg: 0.52, yr: 0.815, zr: 0.46, yc: 0.82, ys: 0.46, ysh: 0.76 }
    ];
    pillar(pillar(S, -0.56, -0.64), -1.52, -1.60);   // B-pillar, C-pillar ahead of the quarter glass
    var M = matTable({ trim: 'gloss', roof: 'paint2', sill: 'black', lip: 'black', dPillar: 'gloss' });   // gloss flyline D-pillar
    M.hood = M.hood.slice(); M.hood[1] = 'black';
    defs['porsche-taycan-cross-turismo'] = {
      body: shell(S, M, 'paint', 'paint'),
      parts: [].concat(
        // upright teardrop lamps on the fender fronts (front-view outline wrapped onto the wing), four-point DRL
        polys([ell(0.68, 0.73, 0.138, 0.108, 12, 0.42)], 'front', 'gloss', 0.006, true),
        polys([ell(0.68, 0.73, 0.112, 0.084, 12, 0.42)], 'front', 'light', 0.009, true),
        polys([[-1, -1], [-1, 1], [1, -1], [1, 1]].map(function (q) { return ell(0.68 + q[0] * 0.046, 0.73 + q[1] * 0.034, 0.019, 0.015, 6); }), 'front', 'drl', 0.012, true),
        // air-curtain inlets, lower intake split by two body-colour bars, black off-road apron, crest
        polys([[[0.655, 0.31], [0.71, 0.31], [0.77, 0.60], [0.72, 0.615]]], 'front', 'gloss', 0.007, true),
        polys([[[-0.56, 0.235], [0.56, 0.235], [0.60, 0.37], [-0.60, 0.37]]], 'front', 'grille', 0.006, false),
        polys([rect(0.17, 0.235, 0.21, 0.37)], 'front', 'paint', 0.009, true),
        polys([rect(-0.95, 0.15, 0.95, 0.235)], 'front', 'black', 0.006, false),
        polys([rect(-0.25, 0.39, 0.25, 0.49)], 'front', 'plate', 0.008, false),
        // rear (Cross Turismo rear photos 2024 IMG_9332 / Turbo S CT rear): smoked full-width glass bar with a thin
        // lit red line and chrome PORSCHE lettering, outer smoked lamps with the 4-point brake lights and a lit
        // outline, "TAYCAN" script left, plate low in the black off-road apron, red reflector strips, diffuser
        // ribs, sensor dots, black roof spoiler with the 3rd brake light, rear wiper
        polys([rect(-0.62, 0.94, 0.62, 0.995)], 'rear', 'smoke', 0.008, false),
        polys([rect(-0.62, 0.983, 0.62, 0.99), rect(-0.62, 0.944, 0.62, 0.949)], 'rear', 'tail', 0.011, false),
        [txt('PORSCHE', 0, 0.965, 0.024, 'chrome', { spacing: 2.4, weight: 0.13 })],
        polys([[[0.60, 0.905], [0.80, 0.915], [0.84, 0.99], [0.60, 0.995]]], 'rear', 'smoke', 0.008, true).map(tilt(40)),
        polys([[[0.62, 0.983], [0.83, 0.98], [0.835, 0.99], [0.62, 0.993]], [[0.795, 0.918], [0.805, 0.918], [0.835, 0.982], [0.825, 0.982]]], 'rear', 'tail', 0.004, true).map(tilt(40)),
        polys([rect(0.66, 0.93, 0.69, 0.95), rect(0.72, 0.93, 0.75, 0.95), rect(0.66, 0.96, 0.69, 0.98), rect(0.72, 0.96, 0.75, 0.98)], 'rear', 'tail', 0.004, true).map(tilt(40)),
        polys([rect(0.61, 0.912, 0.645, 0.93)], 'rear', 'rev', 0.004, true).map(tilt(40)),
        [txt('TAYCAN', -0.40, 0.895, 0.022, 'chrome', { skew: 0.22, weight: 0.12 })],
        polys([rect(-0.95, 0.22, 0.95, 0.52)], 'rear', 'black', 0.006, false),
        plateKit(0, 0.38, 0.48, 0.24),
        polys([rect(-0.30, 0.24, -0.27, 0.36), rect(0.27, 0.24, 0.30, 0.36)], 'rear', 'grille', 0.009, false),
        polys([-0.12, -0.48, -0.62, 0.12, 0.48, 0.62].map(function (z) { return rect(z - 0.008, 0.24, z + 0.008, 0.34); }), 'rear', 'gloss', 0.009, false),
        polys([[[0.56, 0.495], [0.82, 0.49], [0.83, 0.505], [0.56, 0.51]]], 'rear', 'lens', 0.009, true),
        polys([rect(-0.56, 0.80, 0.56, 0.807)], 'rear', 'black', 0.007, false),
        dots([[0.30, 0.60], [0.60, 0.59]], 0.009, 'gloss', 0.007, true),
        polys([rect(-0.24, 1.252, 0.24, 1.26)], 'rear', 'tail', 0.010, false),
        wiper(0.0, 1.135, 0.32, 172),
        [{ t: 'prism', mat: 'gloss', mirror: true, z0: 0, z1: 0.42, pts2d: [[-2.05, 1.312], [-2.20, 1.29], [-2.205, 1.274], [-2.09, 1.296]] }],
        [lowLamp(rect(-0.84, 0.94, 0.84, 0.995), false)],
        // flyline blade, rocker cladding, charge flap, door handles
        polys([[[-2.06, 1.20], [-2.13, 1.25], [-2.43, 1.0], [-2.36, 0.985]]], 'side', 'gloss', 0.006, true),
        polys([rect(1.80, 0.74, 1.98, 0.80)], 'side', 'black', 0.006, true),
        polys([rect(0.18, 0.905, 0.32, 0.925), rect(-0.95, 0.93, -0.81, 0.95)], 'side', 'black', 0.004, true),
        // squared black arch cladding front and rear
        flare(1.452, 0.365, 0.405, 0.47, 0.90, 0.985, 'black', 5, 10, 170),
        flare(-1.452, 0.365, 0.405, 0.47, 0.92, 0.99, 'black', 5, 10, 170),
        // roof rails, mirrors
        [{ t: 'prism', mat: 'gloss', mirror: true, z0: 0.43, z1: 0.48, pts2d: [[-0.30, 1.40], [-1.00, 1.415], [-1.70, 1.375], [-2.10, 1.31], [-2.10, 1.335], [-1.70, 1.40], [-1.00, 1.44], [-0.30, 1.425]] }],
        mirrorPart(0.62, 0.46, 1.0, 1.08, 0.76, 0.94)
      ),
      wheels: { style: 'turbine', spokes: 10 },
      notes: 'Porsche Taycan 4S Cross Turismo — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:Porsche_Taycan_Cross_Turismo.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2024_Porsche_Taycan_Cross_Turismo_IMG_9332.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Porsche_Taycan_Turbo_S_Cross_Turismo_Rear.jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Ferrari GTC4Lusso (F151M) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Ferrari_GTC4Lusso):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Ferrari_GTC4Lusso_IMG_4353.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Ferrari_GTC4Lusso_IMG_4354.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Ferrari_GTC4_Lusso_T_-_Mondial_de_l%27Automobile_de_Paris_2016_-_001.jpg
  // Signature: very long low bonnet with the cowl near mid-wheelbase, wide low mesh mouth, slim swept headlamps
  // on the fender tips, triple fender gills, fastback-style shooting-brake roof ending in a steep Kamm tail with a
  // ducktail lip, quad round tail lamps, four round tailpipes in a black diffuser.
  (function () {
    var S = [
      { x: 2.425, k: 'h', m: 'nose', yb: 0.26, hw: 0.44, yw: 0.38, ybl: 0.48, zbl: 0.40, yc: 0.52, zb: 0.40, ys: 0.30 },
      { x: 2.40, k: 'h', m: 'nose', yb: 0.19, hw: 0.72, yw: 0.40, ybl: 0.56, zbl: 0.66, yc: 0.575, zb: 0.66, ys: 0.24 },
      { x: 2.30, k: 'h', m: 'hood', yb: 0.16, hw: 0.85, yw: 0.45, ybl: 0.625, zbl: 0.80, yc: 0.63, zb: 0.76, ys: 0.22 },
      { x: 2.05, k: 'h', m: 'hood', yb: 0.18, hw: 0.935, yw: 0.52, ybl: 0.71, zbl: 0.87, yc: 0.725 },
      { x: 1.65, k: 'h', m: 'hood', yb: 0.20, hw: 0.972, yw: 0.66, ybl: 0.79, zbl: 0.88, yc: 0.80, ysh: 0.75, zsh: 0.93 },
      { x: 1.00, k: 'h', m: 'hood', yb: 0.20, hw: 0.965, yw: 0.66, ybl: 0.875, zbl: 0.86, yc: 0.887, ysh: 0.80, zsh: 0.92 },
      { x: 0.32, k: 'h', m: 'screen', yb: 0.20, hw: 0.942, yw: 0.66, ybl: 0.935, zbl: 0.80, yc: 0.955, ysh: 0.83, zsh: 0.90 },
      { x: -0.05, k: 'w', m: 'screen' },
      { x: -0.42, k: 'c', m: 'cab', yb: 0.20, hw: 0.947, yw: 0.68, ybl: 0.965, zbl: 0.755, yg: 1.315, zg: 0.56, yr: 1.345, zr: 0.51, yq: 1.352, zq: 0.27, yc: 1.356, ysh: 0.86, zsh: 0.88 },
      { x: -1.10, k: 'c', m: 'cab', yb: 0.20, hw: 0.971, yw: 0.76, ybl: 0.98, zbl: 0.735, yg: 1.352, zg: 0.55, yr: 1.372, zr: 0.51, yc: 1.379, ysh: 0.93, zsh: 0.90 },
      { x: -1.85, k: 'c', m: 'cab', yb: 0.20, hw: 0.983, yw: 0.84, ybl: 1.06, zbl: 0.67, ygb: 1.08, zgb: 0.64, yg: 1.295, zg: 0.53, yr: 1.345, zr: 0.48, yc: 1.354, ysh: 0.96, zsh: 0.88 },
      { x: -2.12, k: 'c', m: 'dpil', yb: 0.205, hw: 0.94, yw: 0.78, ybl: 1.10, zbl: 0.62, ygb: 1.19, zgb: 0.565, yg: 1.20, zg: 0.555, yr: 1.32, zr: 0.46, yc: 1.333, ysh: 1.0, zsh: 0.82 },
      { x: -2.205, k: 'c', m: 'hatch', yb: 0.207, hw: 0.928, yw: 0.75, ybl: 1.08, zbl: 0.64, ygb: 1.09, zgb: 0.62, yg: 1.10, zg: 0.61, yr: 1.30, zr: 0.46, yq: 1.31, yc: 1.315, ysh: 0.98, zsh: 0.82 },
      { x: -2.378, k: 'c', m: 'tail', yb: 0.22, hw: 0.84, yw: 0.72, ybl: 0.975, zbl: 0.70, yg: 0.98, zg: 0.66, yr: 0.99, zr: 0.56, yc: 0.995 },
      { x: -2.478, k: 'c', m: 'tail', yb: 0.25, hw: 0.76, yw: 0.70, ybl: 0.905, zbl: 0.68, yg: 0.91, zg: 0.64, yr: 0.915, zr: 0.56, yc: 0.92, ys: 0.31 },
      { x: -2.492, k: 'c', m: 'tail', yb: 0.40, hw: 0.68, yw: 0.66, ybl: 0.82, zbl: 0.62, yg: 0.83, zg: 0.58, yr: 0.835, zr: 0.50, yc: 0.84, ys: 0.44, ysh: 0.76 }
    ];
    pillar(S, -0.92, -0.97);   // slim divider between the long door glass and the rear quarter glass
    var M = matTable({ trim: 'chrome', roof: 'paint2', sill: 'black' });
    function rl(z, y) {
      // round lamp: gloss bezel, lit outer ring, smoked centre with a small lit core
      return [{ t: 'poly', view: 'rear', mat: 'gloss', offset: 0.006, mirror: true, pts: ell(z, y, 0.072, 0.072, 12) },
        { t: 'poly', view: 'rear', mat: 'tail', offset: 0.009, mirror: true, pts: ell(z, y, 0.06, 0.06, 12) },
        { t: 'poly', view: 'rear', mat: 'smoke', offset: 0.012, mirror: true, pts: ell(z, y, 0.042, 0.042, 12) },
        { t: 'poly', view: 'rear', mat: 'tail', offset: 0.015, mirror: true, pts: ell(z, y, 0.016, 0.016, 8) },
        lowLamp(ell(z, y, 0.065, 0.065, 6))];
    }
    defs['ferrari-gtc4lusso'] = {
      body: shell(S, M, 'paint', 'paint'),
      parts: [].concat(
        // wide low mesh mouth with horizontal bars, plate (no emblem)
        polys([[[-0.62, 0.20], [0.62, 0.20], [0.765, 0.28], [0.785, 0.43], [0.65, 0.495], [-0.65, 0.495], [-0.785, 0.43], [-0.765, 0.28]]], 'front', 'gloss', 0.004, false),
        polys([[[-0.60, 0.22], [0.60, 0.22], [0.74, 0.29], [0.76, 0.42], [0.64, 0.475], [-0.64, 0.475], [-0.76, 0.42], [-0.74, 0.29]]], 'front', 'grille', 0.007, false),
        polys([0, 1].map(function (k) { var y = 0.30 + k * 0.08; return rect(-0.70 + k * 0.01, y, 0.70 - k * 0.01, y + 0.012); }), 'front', 'badge', 0.010, false),
        polys([rect(-0.26, 0.245, 0.26, 0.345)], 'front', 'plate', 0.012, false),
        polys([rect(-0.92, 0.15, 0.92, 0.205)], 'front', 'black', 0.007, false),
        // slim swept-back headlamps along the fender tips (seen from above / front), DRL strip
        polys([[[2.395, 0.57], [2.39, 0.67], [2.295, 0.83], [2.13, 0.908], [2.04, 0.885], [2.17, 0.79], [2.26, 0.66], [2.28, 0.57]]], 'top', 'gloss', 0.006, true),
        polys([[[2.375, 0.585], [2.37, 0.665], [2.28, 0.82], [2.13, 0.893], [2.07, 0.878], [2.19, 0.79], [2.28, 0.665], [2.30, 0.585]]], 'top', 'drl', 0.010, true),
        // corner intakes
        polys([[[0.78, 0.24], [0.92, 0.27], [0.94, 0.44], [0.80, 0.44]]], 'front', 'grille', 0.006, true),
        // triple fender gills behind the front wheels, scudetto
        polys([0, 1, 2].map(function (k) { var x = 1.02 - k * 0.075; return [[x, 0.56], [x + 0.03, 0.56], [x - 0.02, 0.78], [x - 0.05, 0.78]]; }), 'side', 'gloss', 0.006, true),
        polys([rect(1.15, 0.80, 1.20, 0.86)], 'side', 'indicator', 0.006, true),
        // rear: quad round lamps under the ducktail, plate, black diffuser, quad round tailpipes
        rl(0.58, 0.83), rl(0.75, 0.83),
        // (rear photos IMG_4354 / Lusso T Paris 2016): plate recess under the hatch shut line, black diffuser with
        // vertical fins, centre fog lamp, sensor dots, 3rd brake light under the roof edge
        plateKit(0, 0.585, 0.685, 0.24),
        polys([rect(-0.50, 0.545, 0.50, 0.552), rect(0.493, 0.545, 0.50, 0.93)], 'rear', 'black', 0.007, true),
        polys([[[-2.02, 0.31], [-2.24, 0.31], [-2.30, 0.52], [-2.08, 0.54]]], 'side', 'gloss', 0.006, true),   // bumper corner vent behind the rear wheel
        polys([rect(-0.80, 0.23, 0.80, 0.44)], 'rear', 'black', 0.006, false),
        polys([rect(-0.60, 0.24, -0.57, 0.44), rect(0.57, 0.24, 0.60, 0.44), rect(-0.03, 0.24, 0.03, 0.44)], 'rear', 'grille', 0.009, false),
        polys([-0.16, -0.30, -0.70, 0.16, 0.30, 0.70].map(function (z) { return rect(z - 0.009, 0.24, z + 0.009, 0.42); }), 'rear', 'gloss', 0.010, false),
        polys([rect(-0.13, 0.452, 0.13, 0.47)], 'rear', 'tail', 0.010, false),
        dots([[0.25, 0.51], [0.55, 0.50]], 0.009, 'gloss', 0.007, true),
        polys([rect(-0.24, 1.296, 0.24, 1.305)], 'rear', 'tail', 0.010, false),
        [lowLamp(rect(-0.13, 0.452, 0.13, 0.47), false)],
        // door handles, mirrors
        polys([rect(-0.30, 0.90, -0.17, 0.92)], 'side', 'chrome', 0.004, true),
        mirrorPart(0.10, -0.06, 0.95, 1.04, 0.76, 0.95)
      ),
      exhaust: [{ cx: 0.44, cy: 0.315, w: 0.095, h: 0.095, mirror: true }, { cx: 0.56, cy: 0.315, w: 0.095, h: 0.095, mirror: true }],
      wheels: { style: 'split', spokes: 5 },
      notes: 'Ferrari GTC4Lusso — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_GTC4Lusso_IMG_4353.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_GTC4Lusso_IMG_4354.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_GTC4_Lusso_T_-_Mondial_de_l%27Automobile_de_Paris_2016_-_001.jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Mercedes-Benz CLS 500 Shooting Brake (X218, 2014 facelift) */
  // Reference photos (Wikimedia Commons):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mercedes-Benz_CLS_550_4MATIC_Shooting_Brake_(X218)_front.JPG
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Mercedes-Benz_CLS_550_4MATIC_Shooting_Brake_(X218)_rear.JPG
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mercedes_CLS_Shooting_Brake_X218_silver_(1).jpg
  //   rear:      https://commons.wikimedia.org/wiki/File:Mercedes-Benz_X218_CLS_250_CDI_Shooting_Brake_Diamond_White_Bright_(5).jpg
  // Signature: long coupe-like roof that keeps falling to a small spoiler, frameless chrome-edged DLO tapering to
  // a long point, twin-blade grille with a big round badge, swept Multibeam lamps with the eyebrow DRL, AMG-line bumper
  // intakes, wide sweeping tail lamps wrapping into the flanks with a chrome strip across the tailgate.
  (function () {
    // waist (pt 3) carries the CLS "dropping line": high over the front wheel, falling along the doors, rising
    // again into the rear haunch; roof arched with its peak over the B-pillar and falling hard to the spoiler.
    // From 1.50 to -1.30 the dropping line (yw), the max width (hw) and the shoulder crease (ysh / zsh) are kept
    // linear in x so each band between them is one even strip of facets (no zig-zag shading along the doors).
    var S = [
      { x: 2.393, k: 'h', m: 'nose', yb: 0.30, hw: 0.40, yw: 0.52, ybl: 0.60, zbl: 0.36, yc: 0.64, zb: 0.34, ys: 0.36 },
      { x: 2.36, k: 'h', m: 'nose', yb: 0.20, hw: 0.72, yw: 0.50, ybl: 0.69, zbl: 0.66, yc: 0.715, zb: 0.64, ys: 0.27 },
      { x: 2.25, k: 'h', m: 'hood', yb: 0.175, hw: 0.82, yw: 0.56, ybl: 0.75, zbl: 0.78, yc: 0.765, zb: 0.74, ys: 0.25 },
      { x: 1.95, k: 'h', m: 'hood', yb: 0.20, hw: 0.885, yw: 0.755, ybl: 0.815, zbl: 0.83, yc: 0.835, ysh: 0.795, zsh: 0.865 },
      { x: 1.50, k: 'h', m: 'hood', yb: 0.22, hw: 0.918, yw: 0.79, ybl: 0.885, zbl: 0.84, yc: 0.905, ysh: 0.855, zsh: 0.878 },
      { x: 0.88, k: 'h', m: 'screen', yb: 0.22, hw: 0.920, yw: 0.757, ybl: 0.965, zbl: 0.81, yc: 0.985, ysh: 0.878, zsh: 0.876 },
      { x: 0.30, k: 'w', m: 'screen' },
      { x: -0.20, k: 'c', m: 'cab', yb: 0.22, hw: 0.922, yw: 0.699, ybl: 0.995, zbl: 0.72, yg: 1.355, zg: 0.53, yr: 1.375, zr: 0.47, yq: 1.385, zq: 0.25, yc: 1.39, ysh: 0.894, zsh: 0.874 },
      { x: -0.62, k: 'c', m: 'cab', yb: 0.22, hw: 0.925, yw: 0.676, ybl: 1.0, zbl: 0.715, yg: 1.385, zg: 0.53, yr: 1.405, zr: 0.475, yc: 1.416, ysh: 0.906, zsh: 0.874 },
      { x: -1.30, k: 'c', m: 'cab', yb: 0.22, hw: 0.932, yw: 0.64, ybl: 1.015, zbl: 0.685, yg: 1.345, zg: 0.52, yr: 1.368, zr: 0.465, yc: 1.375, ysh: 0.925, zsh: 0.876 },
      { x: -1.90, k: 'c', m: 'cab', yb: 0.221, hw: 0.932, yw: 0.80, ybl: 1.06, zbl: 0.63, ygb: 1.085, zgb: 0.60, yg: 1.275, zg: 0.505, yr: 1.31, zr: 0.445, yc: 1.318, ysh: 0.96, zsh: 0.86 },
      { x: -2.13, k: 'c', m: 'dpil', yb: 0.226, hw: 0.90, yw: 0.82, ybl: 1.10, zbl: 0.58, ygb: 1.17, zgb: 0.54, yg: 1.18, zg: 0.535, yr: 1.275, zr: 0.44, yc: 1.282, ysh: 0.99, zsh: 0.80 },
      { x: -2.222, k: 'c', m: 'hatch', yb: 0.228, hw: 0.88, yw: 0.80, ybl: 1.08, zbl: 0.60, ygb: 1.09, zgb: 0.58, yg: 1.10, zg: 0.57, yr: 1.255, zr: 0.44, yq: 1.262, yc: 1.265, ysh: 0.98, zsh: 0.80 },
      { x: -2.47, k: 'c', m: 'tail', yb: 0.235, hw: 0.78, yw: 0.74, ybl: 1.0, zbl: 0.66, yg: 1.015, zg: 0.62, yr: 1.025, zr: 0.53, yc: 1.03 },
      { x: -2.535, k: 'c', m: 'tail', yb: 0.25, hw: 0.70, yw: 0.70, ybl: 0.905, zbl: 0.62, yg: 0.91, zg: 0.58, yr: 0.915, zr: 0.52, yc: 0.92, ys: 0.32 },
      { x: -2.564, k: 'c', m: 'tail', yb: 0.31, hw: 0.58, yw: 0.64, ybl: 0.78, zbl: 0.54, yg: 0.79, zg: 0.50, yr: 0.795, zr: 0.45, yc: 0.80, ys: 0.46, ysh: 0.73 }
    ];
    pillar(pillar(S, -0.36, -0.44), -1.38, -1.46);   // B-pillar, C-pillar ahead of the quarter glass
    var M = matTable({ trim: 'chrome', topTrim: 'gloss', dPillar: 'paint', roof: 'paint2', sill: 'black' });   // frameless doors: no chrome over the glass; body-colour D-pillar
    defs['mercedes-cls-shooting-brake-x218'] = {
      body: shell(S, M, 'paint', 'paint'),
      parts: [].concat(
        // wide forward-raked grille: chrome frame, dark field, twin chrome blades through a big round badge
        polys([[[-0.38, 0.64], [0.38, 0.64], [0.42, 0.60], [0.40, 0.43], [0.36, 0.40], [-0.36, 0.40], [-0.40, 0.43], [-0.42, 0.60]]], 'front', 'chrome', 0.005, false),
        polys([[[-0.365, 0.625], [0.365, 0.625], [0.40, 0.592], [0.385, 0.44], [0.35, 0.415], [-0.35, 0.415], [-0.385, 0.44], [-0.40, 0.592]]], 'front', 'grille', 0.008, false),
        polys([rect(-0.39, 0.49, 0.39, 0.512), rect(-0.39, 0.545, 0.39, 0.567)], 'front', 'chrome', 0.011, false),
        // long swept lamps reaching back into the wings, three-stroke eyebrow DRL
        polys([[[0.42, 0.635], [0.48, 0.685], [0.86, 0.75], [0.91, 0.72], [0.80, 0.665], [0.56, 0.60]]], 'front', 'gloss', 0.006, true),
        polys([[[0.47, 0.635], [0.51, 0.67], [0.84, 0.725], [0.87, 0.71], [0.79, 0.675], [0.57, 0.62]]], 'front', 'light', 0.009, true),
        polys([[[0.47, 0.678], [0.86, 0.742], [0.88, 0.73], [0.49, 0.665]], [[0.53, 0.645], [0.68, 0.668], [0.685, 0.658], [0.535, 0.636]], [[0.70, 0.672], [0.82, 0.69], [0.825, 0.68], [0.705, 0.662]]], 'front', 'drl', 0.012, true),
        // AMG-line bumper: big outer intakes with chrome fin and LED strip, centre intake, plate, chrome lip
        polys([[[0.48, 0.21], [0.86, 0.23], [0.90, 0.42], [0.62, 0.41], [0.49, 0.33]]], 'front', 'grille', 0.006, true),
        polys([[[0.55, 0.30], [0.87, 0.31], [0.875, 0.325], [0.56, 0.315]]], 'front', 'chrome', 0.009, true),
        polys([[[0.60, 0.36], [0.86, 0.37], [0.865, 0.383], [0.61, 0.373]]], 'front', 'drl', 0.010, true),
        polys([rect(-0.44, 0.19, 0.44, 0.30)], 'front', 'grille', 0.006, false),
        polys([rect(-0.26, 0.30, 0.26, 0.395)], 'front', 'plate', 0.009, false),
        polys([rect(-0.84, 0.165, 0.84, 0.18)], 'front', 'chrome', 0.008, false),
        // rear: big wedge lamps wrapping deep into the flanks, chrome strip, round badge, plate, diffuser, 3rd brake light
        // (maxTilt: the lamps straddle the tailgate's shoulder, flat decals keep their full wedge from behind)
        // (rear photos CLS 550 rear / CLS 250 CDI rear): red lens wedge with a lit outline and three LED lines,
        // smoked inner band with the amber indicator, reverse at the inner end, "CLS 500" / "4MATIC" above the lamps
        polys([[[0.31, 0.93], [0.52, 0.905], [0.69, 0.855], [0.755, 0.885], [0.715, 0.99], [0.31, 0.995]]], 'rear', 'lens', 0.008, true).map(tilt(40)),
        polys([[[0.42, 0.948], [0.58, 0.932], [0.685, 0.895], [0.71, 0.91], [0.62, 0.958], [0.42, 0.968]]], 'rear', 'smoke', 0.011, true).map(tilt(40)),
        polys([[[0.32, 0.982], [0.71, 0.978], [0.715, 0.99], [0.32, 0.993]], [[0.70, 0.89], [0.75, 0.887], [0.715, 0.985], [0.705, 0.98]],
          [[0.36, 0.935], [0.52, 0.913], [0.69, 0.864], [0.70, 0.874], [0.53, 0.922], [0.36, 0.944]]], 'rear', 'tail', 0.014, true).map(tilt(40)),
        polys([[[0.46, 0.953], [0.58, 0.940], [0.63, 0.925], [0.62, 0.935], [0.58, 0.948], [0.46, 0.96]]], 'rear', 'indicator', 0.014, true).map(tilt(40)),
        polys([rect(0.325, 0.945, 0.37, 0.97)], 'rear', 'rev', 0.014, true).map(tilt(40)),
        [txt('CLS 500', -0.43, 1.02, 0.024, 'chrome', { skew: 0.15 }), txt('4MATIC', 0.43, 1.02, 0.024, 'chrome', { skew: 0.15 })],
        polys([[[-2.22, 0.995], [-2.32, 0.845], [-2.50, 0.83], [-2.53, 0.935], [-2.40, 1.0]]], 'side', 'tail', 0.006, true),
        polys([rect(-0.31, 0.935, 0.31, 0.95)], 'rear', 'chrome', 0.008, false),
        plateKit(0, 0.80, 0.90, 0.24),
        polys([rect(-0.45, 0.755, 0.45, 0.762), rect(0.305, 0.755, 0.312, 0.93)], 'rear', 'black', 0.007, true),
        polys([rect(-0.80, 0.23, 0.80, 0.37)], 'rear', 'grille', 0.006, false),
        polys([rect(-0.80, 0.37, 0.80, 0.38)], 'rear', 'chrome', 0.008, false),
        polys([rect(-0.30, 0.325, 0.30, 0.34)], 'rear', 'lens', 0.009, false),
        polys([[[0.72, 0.42], [0.74, 0.42], [0.775, 0.56], [0.755, 0.56]]], 'rear', 'gloss', 0.008, true),
        dots([[0.24, 0.57], [0.52, 0.56]], 0.009, 'gloss', 0.007, true),
        polys([rect(-0.30, 1.245, 0.30, 1.257)], 'rear', 'tail', 0.008, false),
        wiper(0.0, 1.11, 0.30, 172),
        [lowLamp([[0.31, 0.93], [0.69, 0.855], [0.755, 0.885], [0.715, 0.99], [0.31, 0.995]]), lowLamp(rect(-0.30, 1.245, 0.30, 1.257), false)],
        // chrome belt blade to the DLO point, door handles, mirrors
        polys([rect(0.30, 0.925, 0.44, 0.948), rect(-0.85, 0.95, -0.71, 0.972)], 'side', 'chrome', 0.004, true),
        mirrorPart(0.70, 0.54, 1.0, 1.09, 0.76, 0.94)
      ),
      exhaust: [{ cx: 0.56, cy: 0.335, w: 0.24, h: 0.055, shape: 'trapezoid', mirror: true }],
      wheels: { style: 'mesh', spokes: 10, stock: { rim: '#c3c6ca', material: 'cast', caliper: '#3a3d41' } },   // factory silver 10-spoke, grey callipers
      notes: 'Mercedes-Benz CLS Shooting Brake (X218, facelift) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-Benz_CLS_550_4MATIC_Shooting_Brake_(X218)_front.JPG (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-Benz_CLS_550_4MATIC_Shooting_Brake_(X218)_rear.JPG (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes_CLS_Shooting_Brake_X218_silver_(1).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-Benz_X218_CLS_250_CDI_Shooting_Brake_Diamond_White_Bright_(5).jpg (rear). ' +
        'Shoulder / tail-lamp pass: https://commons.wikimedia.org/wiki/File:Mercedes_CLS_Shooting_Brake_X218_silver_(2).jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:MERCEDES-BENZ_CLS-CLASS_SHOOTING_BRAKE_(X218)_China.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-Benz_X218_CLS_250_CDI_Shooting_Brake_Diamond_White_Bright_(4).jpg (rear), ' +
        'https://commons.wikimedia.org/wiki/File:Mercedes-Benz_X218_CLS_250_CDI_Shooting_Brake_Diamond_White_Bright_(3).jpg (front).'
    };
  })();

  Object.keys(defs).forEach(function (id) { reg(id, defs[id]); });
  if (typeof module !== 'undefined' && module.exports) module.exports = defs;
})();

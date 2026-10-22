/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/jdm-muscle.js
   Hand-authored low-poly drift / muscle icons (docs/LOWPOLY-SPEC.md):
     Nissan Silvia S15, Nissan Skyline GT-R R34, Mazda RX-7 FD3S, Nissan GT-R R35,
     Ford Mustang GT S650, Chevrolet Camaro ZL1 (2019), Dodge Challenger SRT Hellcat.

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body stations are RIGHT half rings [y, z] from the bottom centre round to the top centre; one shell
   carries bonnet, glasshouse and deck (like the 911 exemplar).
   Ring points (11, indices are meaningful across every station of every car here):
     0 bottom centre, 1 bottom edge, 2 lower flank, 3 waist (widest), 4 shoulder, 5 belt crest,
     6 glass base, 7 roof rail (top of the side glass), 8 roof edge, 9 roof quarter, 10 centre line.
   On bonnet / deck stations points 6..10 lie across the panel (see ring()). Side glass is drawn as projected
   'side' polygons (the real DLO outline) over the painted glass band, windscreen / rear screen are mats bands.
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
  function rect(a0, b0, a1, b1) { return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]; }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  /** opt-in generator maxTilt (deg) on projected decals: one flat face toward the view (no smear onto the flank) */
  function tilt(list, deg) { list.forEach(function (p) { p.maxTilt = deg; }); return list; }
  function poly(pts, view, mat, off, mirror) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: pts }; }
  /** flared arch band (side profile) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, a0d, a1d) {
    var parts = [], n = segs || 6, A0 = (a0d == null ? 0 : a0d) * Math.PI / 180, A1 = (a1d == null ? 180 : a1d) * Math.PI / 180;
    for (var k = 0; k < n; k++) {
      var a0 = A0 + (A1 - A0) * k / n, a1 = A0 + (A1 - A0) * (k + 1) / n;
      var P = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, a0), P(rOut, a0), P(rOut, a1), P(rIn, a1)] });
    }
    return parts;
  }
  /** round lamp on a rear face (normal -x): a short outer cylinder (lens body) + flat inner rings on its face.
      rings: [[r, mat, depth?], ...] outer -> inner (depth only used by the outer one) */
  function roundLamp(x, y, z, rings, sides) {
    var n = sides || 12, d = rings[0][2] || 0.014, xf = x - d / 2;
    var out = [{ t: 'cyl', mat: rings[0][1], mirror: true, axis: 'x', c: [x, y, z], r: rings[0][0], l: d, sides: n }];
    rings.slice(1).forEach(function (q, i) {
      var pts = [];
      for (var k = 0; k < n; k++) { var a = (k + 0.5) / n * Math.PI * 2; pts.push([xf - 0.003 * (i + 1), y + Math.sin(a) * q[0], z + Math.cos(a) * q[0]]); }
      out.push({ t: 'poly', mat: q[1], mirror: true, normal: [-1, 0, 0], pts: pts });
    });
    return out;
  }

  /**
   * ring(o): an 11-point half ring.
   *  b, zb    bottom height / half-width          yw, w   waist height / max half-width
   *  ys, zs   shoulder                             yb, zbl belt crest
   *  deck:  h (centre height) [, c crown 0..1.5]  -> points 6..10 spread across the panel
   *  cabin: g [y,z] glass base, r [y,z] rail, e [y,z] roof edge, t centre height [, q quarter [y,z]]
   *  lf [y,z] overrides the lower flank point.
   */
  function ring(o) {
    var p = [];
    p.push([o.b, 0]);
    p.push([o.b, o.zb]);
    p.push(o.lf || [o.b + (o.yw - o.b) * 0.3, o.zb + (o.w - o.zb) * 0.82]);
    p.push([o.yw, o.w]);
    p.push([o.ys, o.zs]);
    p.push([o.yb, o.zbl]);
    if (o.t == null) {
      var fr = o.fr || [0.18, 0.32, 0.45, 0.72], c = o.c == null ? 0.8 : o.c;
      fr.forEach(function (f) { p.push([o.yb + (o.h - o.yb) * (1 - Math.pow(1 - f, 1 + c)), o.zbl * (1 - f)]); });
      p.push([o.h, 0]);
    } else {
      p.push(o.g); p.push(o.r); p.push(o.e);
      p.push(o.q || [o.e[0] + (o.t - o.e[0]) * 0.78, o.e[1] * 0.5]);
      p.push([o.t, 0]);
    }
    return p;
  }
  function S(x, o) { return { x: x, pts: ring(o) }; }
  /** S() with explicit panel points 6..9 ([y, z] each, crest -> centre) for hand-shaped bonnet / wing humps */
  function SP(x, o, top) { var st = S(x, o); top.forEach(function (q, i) { st.pts[6 + i] = q; }); return st; }
  /** thin oval shut-line (top view [x, z]) as two simple half-strips */
  function lidLine(cx, cz, rx, rz, w) {
    var out = [];
    [0, 1].forEach(function (h) {
      var a = [], b = [];
      for (var k = 0; k <= 8; k++) {
        var t = (h + k / 8) * Math.PI;
        a.push([cx + Math.cos(t) * rx, cz + Math.sin(t) * rz]);
        b.unshift([cx + Math.cos(t) * (rx - w), cz + Math.sin(t) * (rz - w)]);
      }
      out.push(a.concat(b));
    });
    return out;
  }
  /** material row for an interval: kind sets columns 6..9, sill = c1 colour */
  var TOP = {
    deck: ['paint', 'paint', 'paint', 'paint'],
    cowl: ['paint', 'paint', 'paint', 'paint'],
    screen: ['paint', 'paint', 'glass', 'glass'],
    roof: ['paint', 'paint', 'paint2', 'paint2'],
    rscreen: ['paint', 'paint', 'glass', 'glass'],
    rsail: ['paint', 'paint', 'paint', 'glass'],
    hatch: ['paint', 'glass', 'glass', 'glass']
  };
  function row(kind, sill, low) {
    return ['black', sill || 'black', low || 'paint', 'paint', 'paint', 'paint'].concat(TOP[kind] || TOP.deck);
  }
  function mirrorParts(x0, x1, y0, y1, zIn, zOut, footC, footS) {
    return [
      { t: 'prism', mat: 'mirror', mirror: true, z0: zIn, z1: zOut, pts2d: [[x1, y0], [x0, y0 + 0.01], [x0 + 0.01, y1], [x1 - 0.02, y1 - 0.005]] },
      { t: 'box', mat: 'black', mirror: true, c: footC, s: footS }
    ];
  }

  /* ---------------------------------------------------------------- rear-end helpers (chase-cam detail) */
  /** badge TEXT on the rear (model / trim names only, no logos): generator stroke font, flat facing the view */
  function txt(str, z, y, h, o) {
    var p = { t: 'text', view: 'rear', str: str, at: [z, y], h: h, mat: 'chrome' };
    if (o) for (var k in o) p[k] = o[k];
    return p;
  }
  /** number plate in a dark recess with two plate lamps over it (rear view [z, y]) */
  function plateKit(y0, y1, hw, zc) {
    var c = zc || 0;
    return [
      poly(rect(c - hw - 0.025, y0 - 0.02, c + hw + 0.025, y1 + 0.022), 'rear', 'black', 0.004, false),
      poly(rect(c - hw, y0, c + hw, y1), 'rear', 'plate', 0.008, false),
      poly(rect(c - hw * 0.62, y1 + 0.006, c - hw * 0.42, y1 + 0.016), 'rear', 'white', 0.009, false),
      poly(rect(c + hw * 0.42, y1 + 0.006, c + hw * 0.62, y1 + 0.016), 'rear', 'white', 0.009, false)
    ];
  }
  /** thin dark shut lines / seams on the rear face: segments [z0, y0, z1, y1] (mirrored when asked) */
  function seams(list, mirror, w) {
    var t = (w || 0.006) / 2;
    return list.map(function (s) {
      var dz = s[2] - s[0], dy = s[3] - s[1], l = Math.hypot(dz, dy) || 1, nz = -dy / l * t, ny = dz / l * t;
      return poly([[s[0] + nz, s[1] + ny], [s[2] + nz, s[3] + ny], [s[2] - nz, s[3] - ny], [s[0] - nz, s[1] - ny]], 'rear', 'black', 0.005, mirror);
    });
  }
  /** low-LOD-only tail signature: rear decals (rects [z0, y0, z1, y1], kept inboard of |z| 0.74) that the generator
      fits onto the coarser low-LOD tail; the far car keeps its lamp graphic. (x: unused, kept for call-site context) */
  function lowLamps(x, list, mat, mirror) {
    void x;
    return list.map(function (r) {
      var c = function (z) { return Math.max(-0.74, Math.min(0.74, z)); };
      return { t: 'poly', view: 'rear', mat: mat || 'tail', mirror: mirror !== false, low: 'only', maxTilt: 45, offset: 0.006,
        pts: rect(c(r[0]), r[1], c(r[2]), r[3]) };
    });
  }
  /** diffuser strakes drawn on the rear face (gloss vertical strips at z, y0..y1, mirrored) */
  function strakes(zs, y0, y1, w) {
    return polys(zs.map(function (z) { return rect(z - (w || 0.012) / 2, y0, z + (w || 0.012) / 2, y1); }), 'rear', 'gloss', 0.009, true);
  }
  /** rounded rectangle outline [z, y] (corner radius r, n segments a corner) */
  function rrect(z0, y0, z1, y1, r, n) {
    var out = [], m = n || 3, c = [[z1 - r, y0 + r, -90], [z1 - r, y1 - r, 0], [z0 + r, y1 - r, 90], [z0 + r, y0 + r, 180]];
    c.forEach(function (q) { for (var k = 0; k <= m; k++) { var a = (q[2] + 90 * k / m) * Math.PI / 180; out.push([q[0] + Math.cos(a) * r, q[1] + Math.sin(a) * r]); } });
    return out;
  }
  /** vertical diffuser fins under the rear bumper (boxes at z, from x0 back to x1) */
  function fins(x0, x1, y0, y1, zs, mat) {
    return zs.map(function (z) { return { t: 'box', mat: mat || 'black', mirror: true, c: [(x0 + x1) / 2, (y0 + y1) / 2, z], s: [Math.abs(x1 - x0), y1 - y0, 0.014] }; });
  }

  /* ================================================================ Nissan Silvia Spec-R (S15) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Nissan_Silvia):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:1999_Nissan_Silvia_S15_Spec_R.jpg
  //   side/front:https://commons.wikimedia.org/wiki/File:Nissan_Silvia_S15_001.JPG
  //   front:     https://commons.wikimedia.org/wiki/File:The_frontview_of_Nissan_Silvia_spec_S_(S15)_(cropped).JPG
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Nissan_Silvia_spec_S_(S15)_rear_(cropped).JPG
  var S15 = {
    body: {
      stations: [
        S(2.167, { b: 0.27, zb: 0.40, yw: 0.36, w: 0.54, ys: 0.50, zs: 0.52, yb: 0.545, zbl: 0.45, h: 0.555, c: 0.2 }),
        S(2.13, { b: 0.20, zb: 0.56, yw: 0.36, w: 0.72, ys: 0.56, zs: 0.71, yb: 0.625, zbl: 0.64, h: 0.64, c: 0.6 }),
        S(1.96, { b: 0.17, zb: 0.62, yw: 0.38, w: 0.79, ys: 0.585, zs: 0.78, yb: 0.66, zbl: 0.715, h: 0.68 }),
        S(1.62, { b: 0.17, zb: 0.70, yw: 0.42, w: 0.835, ys: 0.62, zs: 0.825, yb: 0.70, zbl: 0.775, h: 0.735 }),
        S(0.95, { b: 0.17, zb: 0.66, lf: [0.30, 0.80], yw: 0.53, w: 0.847, ys: 0.650, zs: 0.815, yb: 0.770, zbl: 0.770, h: 0.815 }),
        S(0.52, { b: 0.17, zb: 0.66, lf: [0.30, 0.80], yw: 0.53, w: 0.847, ys: 0.700, zs: 0.815, yb: 0.850, zbl: 0.765, h: 0.875, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-0.16, { b: 0.17, zb: 0.66, lf: [0.30, 0.80], yw: 0.53, w: 0.847, ys: 0.750, zs: 0.815, yb: 0.905, zbl: 0.755, g: [0.925, 0.695], r: [1.175, 0.615], e: [1.215, 0.585], t: 1.262 }),
        S(-0.52, { b: 0.17, zb: 0.66, lf: [0.30, 0.80], yw: 0.53, w: 0.847, ys: 0.760, zs: 0.815, yb: 0.915, zbl: 0.760, g: [0.935, 0.70], r: [1.205, 0.625], e: [1.25, 0.585], t: 1.285 }),
        S(-0.90, { b: 0.17, zb: 0.66, lf: [0.30, 0.80], yw: 0.53, w: 0.847, ys: 0.770, zs: 0.815, yb: 0.935, zbl: 0.765, g: [0.955, 0.705], r: [1.18, 0.63], e: [1.215, 0.59], t: 1.245 }),
        S(-1.62, { b: 0.17, zb: 0.66, lf: [0.30, 0.80], yw: 0.53, w: 0.845, ys: 0.80, zs: 0.82, yb: 0.945, zbl: 0.75, h: 0.98, c: 0.5, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-2.08, { b: 0.18, zb: 0.70, yw: 0.50, w: 0.815, ys: 0.78, zs: 0.79, yb: 0.905, zbl: 0.71, h: 0.935, c: 0.5 }),
        S(-2.24, { b: 0.24, zb: 0.60, yw: 0.50, w: 0.77, ys: 0.79, zs: 0.75, yb: 0.895, zbl: 0.66, h: 0.92, c: 0.4 }),
        S(-2.277, { b: 0.34, zb: 0.52, yw: 0.50, w: 0.68, ys: 0.76, zs: 0.67, yb: 0.86, zbl: 0.56, h: 0.88, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('cowl'),
        row('screen'), row('roof'), row('roof'), row('rscreen'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // side glass: frameless door glass + pointed rear quarter light, gloss B-pillar
      polys([[[0.42, 0.935], [-0.13, 1.18], [-0.62, 1.205], [-0.62, 0.95]]], 'side', 'glass', 0.006, true),
      polys([[[-0.66, 0.955], [-0.66, 1.20], [-0.86, 1.18], [-1.30, 0.985]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.66, 0.95, -0.62, 1.205)], 'side', 'gloss', 0.007, true),
      // swept projector headlamps: dark housing, lamp, twin projectors
      polys([[[0.29, 0.585], [0.52, 0.575], [0.74, 0.59], [0.815, 0.615], [0.80, 0.655], [0.56, 0.655], [0.36, 0.635]]], 'front', 'gloss', 0.006, true),
      polys([[[0.32, 0.593], [0.52, 0.584], [0.73, 0.598], [0.79, 0.618], [0.775, 0.645], [0.56, 0.646], [0.38, 0.630]]], 'front', 'light', 0.009, true),
      polys([ell(0.47, 0.615, 0.045, 0.024, 10), ell(0.62, 0.618, 0.05, 0.026, 10)], 'front', 'chrome', 0.012, true),
      // nose: small slot under the badge, lower mouth with the plate, fog-lamp ducts
      polys([rect(-0.22, 0.505, 0.22, 0.53)], 'front', 'grille', 0.005, false),
      polys([[[-0.46, 0.24], [0.46, 0.24], [0.50, 0.44], [-0.50, 0.44]]], 'front', 'grille', 0.005, false),
      polys([rect(-0.2, 0.33, 0.2, 0.44)], 'front', 'plate', 0.009, false),
      tilt(polys([[[0.55, 0.23], [0.73, 0.25], [0.74, 0.37], [0.56, 0.37]]], 'front', 'grille', 0.005, true), 35),
      tilt(polys([ell(0.635, 0.305, 0.04, 0.035, 8)], 'front', 'light', 0.009, true), 35),
      polys([rect(-0.62, 0.19, 0.62, 0.215)], 'front', 'black', 0.004, false),
      // rear: wedge lamps tapering in toward the boot lid: gloss bezel, dark red lens housing, lit outer block, the
      // inboard round lamp (red ring, clear reverse centre), amber indicator strip along the top
      tilt(polys([[[0.752, 0.872], [0.29, 0.878], [0.29, 0.784], [0.46, 0.753], [0.748, 0.728]]], 'rear', 'gloss', 0.005, true), 45),
      tilt(polys([[[0.745, 0.865], [0.30, 0.872], [0.30, 0.79], [0.46, 0.76], [0.74, 0.735]]], 'rear', 'lens', 0.007, true), 45),
      tilt(polys([[[0.738, 0.826], [0.52, 0.829], [0.52, 0.768], [0.736, 0.742]]], 'rear', 'tail', 0.009, true), 45),
      tilt(polys([ell(0.405, 0.810, 0.050, 0.034, 10)], 'rear', 'tail', 0.009, true), 45),
      tilt(polys([ell(0.405, 0.810, 0.030, 0.020, 8)], 'rear', 'rev', 0.011, true), 45),
      tilt(polys([[[0.742, 0.862], [0.34, 0.868], [0.34, 0.846], [0.745, 0.836]]], 'rear', 'indicator', 0.011, true), 45),
      polys([[[-2.00, 0.80], [-2.00, 0.89], [-2.20, 0.885], [-2.24, 0.77]]], 'side', 'tail', 0.006, true),
      // boot lid between the lamps (shut lines), SILVIA script + spec R, plate on the bumper in its recess
      seams([[0.285, 0.715, 0.285, 0.875], [-0.285, 0.715, 0.285, 0.715]], false),
      seams([[-0.285, 0.715, -0.285, 0.875]], false),
      [txt('SILVIA', 0, 0.75, 0.032, { skew: 0.22, weight: 0.13 }), txt('SPEC R', 0.48, 0.665, 0.022, { skew: 0.2, weight: 0.14 })],
      plateKit(0.52, 0.64, 0.17),
      // bumper: corner reflectors, black lower valence, tow-hook cover
      polys([rect(0.56, 0.40, 0.68, 0.425)], 'rear', 'lens', 0.006, true),
      polys([rect(-0.62, 0.20, 0.62, 0.30)], 'rear', 'black', 0.004, false),
      polys([rect(0.30, 0.33, 0.36, 0.36)], 'rear', 'black', 0.006, false),
      // far-car tail signature: wedge block + round inboard lamp
      lowLamps(-2.284, [[0.50, 0.745, 0.70, 0.86], [0.31, 0.78, 0.46, 0.84]], 'tail'),
      lowLamps(-2.284, [[-0.17, 0.52, 0.17, 0.64]], 'plate', false),
      // side: amber marker, door handle, fuel flap
      polys([rect(1.62, 0.58, 1.68, 0.60)], 'side', 'indicator', 0.004, true),
      polys([rect(-0.30, 0.85, -0.18, 0.87)], 'side', 'black', 0.004, true),
      mirrorParts(0.24, 0.40, 0.935, 1.025, 0.74, 0.90, [0.34, 0.935, 0.74], [0.07, 0.03, 0.06]),
      [
        // Spec-R boot wing on two stalks, tips curling down, high-mount brake lamp in the trailing edge
        { t: 'prism', mat: 'paint', z0: -0.62, z1: 0.62, pts2d: [[-2.00, 1.005], [-2.20, 1.015], [-2.215, 1.035], [-2.03, 1.025]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.60, z1: 0.66, pts2d: [[-2.02, 0.975], [-2.20, 0.985], [-2.215, 1.035], [-2.03, 1.025]] },
        { t: 'box', mat: 'paint', mirror: true, c: [-2.10, 0.97, 0.50], s: [0.10, 0.07, 0.03] },
        { t: 'box', mat: 'tail', c: [-2.212, 1.024, 0], s: [0.008, 0.014, 0.22] }
      ]
    ),
    wheels: { style: 'star', spokes: 5 },
    // one exit on the left with twin round tips (rear photos)
    exhaust: [{ cx: -0.50, cy: 0.25, w: 0.075, h: 0.075 }, { cx: -0.415, cy: 0.25, w: 0.075, h: 0.075 }],
    notes: 'Nissan Silvia Spec-R (S15) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:1999_Nissan_Silvia_S15_Spec_R.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Nissan_Silvia_S15_001.JPG (side), ' +
      'https://commons.wikimedia.org/wiki/File:The_frontview_of_Nissan_Silvia_spec_S_(S15)_(cropped).JPG (front), ' +
      'https://commons.wikimedia.org/wiki/File:Nissan_Silvia_spec_S_(S15)_rear_(cropped).JPG (rear 3/4).'
  };
  reg('nissan-silvia-s15', S15);

  /* ================================================================ Nissan Skyline GT-R V-Spec (R34) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Nissan_Skyline_GT-R):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Nissan_Skyline_GT-R_R34_V_Spec_II.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Nissan_Skyline_R34_GT-R_N%C3%BCr_001.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Nissan_Skyline_R34_GT-R_N%C3%BCr_002.jpg
  // Signature: upright boxy two-door, near-vertical nose with slim wedge lamps around a small GT-R grille,
  // big lower intercooler mouth, square tail with FOUR ROUND tail lamps, wing on tall stalks, fender vents.
  var R34 = {
    body: {
      stations: [
        S(2.328, { b: 0.26, zb: 0.60, yw: 0.42, w: 0.70, ys: 0.62, zs: 0.69, yb: 0.705, zbl: 0.62, h: 0.725, c: 0.2 }),
        S(2.30, { b: 0.16, zb: 0.75, yw: 0.42, w: 0.85, ys: 0.66, zs: 0.845, yb: 0.75, zbl: 0.785, h: 0.77, c: 0.5 }),
        S(2.10, { b: 0.15, zb: 0.79, yw: 0.45, w: 0.875, ys: 0.69, zs: 0.87, yb: 0.775, zbl: 0.825, h: 0.79 }),
        S(1.72, { b: 0.16, zb: 0.80, yw: 0.48, w: 0.885, ys: 0.72, zs: 0.88, yb: 0.805, zbl: 0.84, h: 0.82 }),
        S(1.00, { b: 0.16, zb: 0.80, yw: 0.50, w: 0.89, ys: 0.75, zs: 0.88, yb: 0.835, zbl: 0.84, h: 0.85 }),
        S(0.58, { b: 0.16, zb: 0.80, yw: 0.50, w: 0.89, ys: 0.79, zs: 0.875, yb: 0.88, zbl: 0.835, h: 0.91, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-0.02, { b: 0.16, zb: 0.80, yw: 0.52, w: 0.89, ys: 0.82, zs: 0.87, yb: 0.925, zbl: 0.82, g: [0.945, 0.745], r: [1.28, 0.655], e: [1.315, 0.625], t: 1.335 }),
        S(-0.42, { b: 0.16, zb: 0.80, yw: 0.52, w: 0.89, ys: 0.83, zs: 0.87, yb: 0.935, zbl: 0.825, g: [0.955, 0.75], r: [1.315, 0.665], e: [1.345, 0.635], t: 1.36 }),
        S(-0.88, { b: 0.16, zb: 0.80, yw: 0.52, w: 0.89, ys: 0.84, zs: 0.875, yb: 0.955, zbl: 0.83, g: [0.975, 0.755], r: [1.30, 0.67], e: [1.33, 0.64], t: 1.345 }),
        S(-1.62, { b: 0.16, zb: 0.80, yw: 0.52, w: 0.89, ys: 0.86, zs: 0.875, yb: 1.01, zbl: 0.81, h: 1.05, c: 0.4, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-2.10, { b: 0.18, zb: 0.80, yw: 0.55, w: 0.885, ys: 0.86, zs: 0.87, yb: 1.00, zbl: 0.80, h: 1.035, c: 0.4 }),
        S(-2.255, { b: 0.24, zb: 0.75, yw: 0.55, w: 0.855, ys: 0.85, zs: 0.845, yb: 0.975, zbl: 0.77, h: 1.005, c: 0.3 }),
        S(-2.273, { b: 0.30, zb: 0.70, yw: 0.55, w: 0.81, ys: 0.84, zs: 0.80, yb: 0.955, zbl: 0.74, h: 0.98, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('deck'),
        row('screen'), row('roof'), row('roof'), row('rscreen'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // framed door glass, quarter light behind a black B-pillar
      polys([[[0.50, 0.95], [-0.02, 1.275], [-0.56, 1.30], [-0.56, 0.965]]], 'side', 'glass', 0.006, true),
      polys([[[-0.62, 0.968], [-0.62, 1.30], [-0.86, 1.29], [-1.24, 1.005]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.62, 0.96, -0.56, 1.30)], 'side', 'gloss', 0.007, true),
      // front: wedge headlamps tapering in to the small upper grille, GT-R badge
      polys([[[0.27, 0.615], [0.80, 0.625], [0.84, 0.655], [0.82, 0.705], [0.40, 0.70], [0.27, 0.655]]], 'front', 'gloss', 0.006, true),
      polys([[[0.30, 0.625], [0.79, 0.633], [0.825, 0.66], [0.81, 0.695], [0.42, 0.69], [0.30, 0.658]]], 'front', 'light', 0.009, true),
      polys([ell(0.50, 0.66, 0.05, 0.028, 10), ell(0.68, 0.664, 0.055, 0.03, 10)], 'front', 'chrome', 0.012, true),
      polys([[[-0.26, 0.615], [0.26, 0.615], [0.26, 0.69], [-0.26, 0.69]]], 'front', 'grille', 0.006, false),
      [{ t: 'text', view: 'front', str: 'GT-R', at: [0, 0.652], h: 0.022, mat: 'chrome', offset: 0.01 }],
      // big lower intercooler mouth with the plate, brake ducts, fog lamps, carbon chin
      polys([[[-0.62, 0.24], [0.62, 0.24], [0.66, 0.56], [-0.66, 0.56]]], 'front', 'grille', 0.005, false),
      polys([rect(-0.2, 0.38, 0.2, 0.50)], 'front', 'plate', 0.009, false),
      tilt(polys([[[0.68, 0.26], [0.80, 0.27], [0.81, 0.38], [0.69, 0.38]]], 'front', 'grille', 0.005, true), 35),
      tilt(polys([rect(0.56, 0.44, 0.66, 0.50)], 'front', 'light', 0.009, true), 35),
      polys([rect(-0.80, 0.15, 0.80, 0.22)], 'front', 'carbon', 0.006, false),
      // bonnet NACA duct, fender vents behind the front wheels
      polys([[[1.25, -0.05], [1.25, 0.05], [1.05, 0.08], [1.05, -0.08]]], 'top', 'black', 0.004, false),
      polys([[[0.86, 0.50], [0.94, 0.50], [0.92, 0.70], [0.84, 0.70]]], 'side', 'gloss', 0.004, true),
      // rear: quad round tail lamps — gloss bezel, lit red outer ring, smoked inner ring, dark red lens, bright centre
      roundLamp(-2.272, 0.885, 0.645, [[0.092, 'gloss', 0.016], [0.084, 'tail'], [0.056, 'smoke'], [0.044, 'lens'], [0.026, 'tail']]),
      // inboard pair: red ring round an amber indicator ring and the clear reverse centre
      roundLamp(-2.275, 0.885, 0.455, [[0.088, 'gloss', 0.016], [0.080, 'tail'], [0.054, 'smoke'], [0.044, 'indicator'], [0.026, 'rev']]),
      // high-mount stop lamp on the boot lid top, boot lid shut lines between the lamps, GT-R / V-spec badges
      polys([rect(-0.085, 0.952, 0.085, 0.968)], 'rear', 'tail', 0.006, false),
      seams([[0.335, 0.735, 0.335, 0.975], [-0.335, 0.735, 0.335, 0.735]], false),
      seams([[-0.335, 0.735, -0.335, 0.975]], false),
      [txt('GT-R', 0.20, 0.775, 0.036, { weight: 0.16 }), txt('V-SPEC', 0.56, 0.50, 0.022, { skew: 0.25, weight: 0.14 })],
      // bumper: plate between the clear reverse lamp and the red fog lamp, side reflectors, tow hook
      plateKit(0.53, 0.65, 0.18),
      polys([rect(-0.40, 0.57, -0.26, 0.62)], 'rear', 'rev', 0.008, false),
      polys([rect(0.26, 0.57, 0.40, 0.62)], 'rear', 'tail', 0.008, false),
      polys([rect(0.66, 0.46, 0.76, 0.485)], 'rear', 'lens', 0.006, true),
      polys([rect(0.30, 0.32, 0.37, 0.35)], 'rear', 'black', 0.007, false),
      // V-spec carbon rear diffuser with vertical strakes
      polys([rect(-0.80, 0.20, 0.80, 0.36)], 'rear', 'carbon', 0.005, false),
      strakes([0.16, 0.38, 0.60], 0.205, 0.345),
      lowLamps(-2.281, [[0.56, 0.80, 0.73, 0.97], [0.37, 0.80, 0.54, 0.97]], 'tail'),
      lowLamps(-2.281, [[-0.18, 0.53, 0.18, 0.65]], 'plate', false),
      polys([rect(-0.30, 0.86, -0.18, 0.88)], 'side', 'black', 0.004, true),
      mirrorParts(0.28, 0.46, 0.96, 1.07, 0.80, 0.98, [0.40, 0.965, 0.80], [0.08, 0.03, 0.06]),
      [
        // GT-R wing on tall stalks
        { t: 'prism', mat: 'paint', z0: -0.74, z1: 0.74, pts2d: [[-1.94, 1.18], [-2.22, 1.19], [-2.24, 1.215], [-1.98, 1.21]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.56, z1: 0.62, pts2d: [[-2.02, 1.03], [-2.20, 1.02], [-2.18, 1.19], [-2.05, 1.185]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.735, z1: 0.75, pts2d: [[-1.95, 1.15], [-2.24, 1.15], [-2.25, 1.24], [-1.98, 1.235]] },
        // adjustable upper flap over the blade's trailing edge
        { t: 'prism', mat: 'paint', z0: -0.66, z1: 0.66, pts2d: [[-2.16, 1.218], [-2.25, 1.222], [-2.255, 1.236], [-2.17, 1.232]] }
      ]
    ),
    wheels: { style: 'star', spokes: 6 },
    // single exit on the left: one big round titanium tip
    exhaust: [{ cx: -0.56, cy: 0.245, w: 0.11, h: 0.105 }],
    notes: 'Nissan Skyline GT-R V-Spec (R34) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Nissan_Skyline_GT-R_R34_V_Spec_II.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Nissan_Skyline_R34_GT-R_N%C3%BCr_001.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Nissan_Skyline_R34_GT-R_N%C3%BCr_002.jpg (rear 3/4).'
  };
  reg('nissan-skyline-gtr-r34', R34);

  /* ================================================================ Mazda RX-7 Type R (FD3S) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Mazda_RX-7):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mazda_RX-7_SPIRIT_R_Type_A_(GF-FD3S)_(10).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mazda-rx7-3rd-generation01.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Mazda_RX-7_(FD3S)_rear_(cropped).JPG
  // Signature: very low nose with the pop-up lamps down, bonnet sunk between tall front-wing humps, oval "smile"
  // mouth, double-bubble roof, wrap-round glass hatch, smoked '99 tail band with round lamps, hoop wing.
  //   (exhaust tips come from the CB.shapes model: real car has ONE twin-tip exit on the right)
  var FD = {
    body: {
      stations: [
        // blunt rounded nose (lamps down), bonnet sunk between tall front-wing humps peaking over the front wheel,
        // waist dipping at the door, then the rear haunch swelling up over the rear wheel into a short round tail
        // broad, rounded bumper face (round in plan, rolled over into the bonnet), not a pointed wedge
        S(2.167, { b: 0.21, zb: 0.58, yw: 0.32, w: 0.70, ys: 0.41, zs: 0.68, yb: 0.45, zbl: 0.57, h: 0.465, c: 0.1 }),
        S(2.125, { b: 0.15, zb: 0.70, yw: 0.32, w: 0.81, ys: 0.475, zs: 0.795, yb: 0.54, zbl: 0.715, h: 0.53, c: 0.4 }),
        S(2.03, { b: 0.14, zb: 0.73, yw: 0.34, w: 0.835, ys: 0.545, zs: 0.815, yb: 0.615, zbl: 0.73, h: 0.565, c: 0.5 }),
        SP(1.90, { b: 0.14, zb: 0.75, yw: 0.37, w: 0.85, ys: 0.595, zs: 0.835, yb: 0.68, zbl: 0.745, h: 0.57, c: 0.5 }, [[0.678, 0.67], [0.655, 0.56], [0.605, 0.42], [0.575, 0.20]]),
        SP(1.585, { b: 0.15, zb: 0.74, lf: [0.26, 0.84], yw: 0.45, w: 0.875, ys: 0.71, zs: 0.85, yb: 0.785, zbl: 0.73, h: 0.60, c: 0.9 }, [[0.782, 0.66], [0.755, 0.55], [0.685, 0.42], [0.62, 0.20]]),
        SP(1.21, { b: 0.15, zb: 0.74, lf: [0.25, 0.815], yw: 0.45, w: 0.877, ys: 0.725, zs: 0.857, yb: 0.805, zbl: 0.74, h: 0.635, c: 0.9 }, [[0.80, 0.67], [0.77, 0.56], [0.705, 0.43], [0.65, 0.22]]),
        SP(0.76, { b: 0.15, zb: 0.73, lf: [0.25, 0.80], yw: 0.44, w: 0.865, ys: 0.655, zs: 0.855, yb: 0.745, zbl: 0.755, h: 0.675, c: 0.9 }, [[0.742, 0.68], [0.725, 0.57], [0.695, 0.44], [0.68, 0.22]]),
        S(0.56, { b: 0.15, zb: 0.72, lf: [0.26, 0.815], yw: 0.44, w: 0.855, ys: 0.645, zs: 0.855, yb: 0.755, zbl: 0.76, h: 0.735, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        // (pass 7) one continuous double-bubble arc: peak just behind the A-pillar tops, then the big curved hatch
        // glass rolling down onto the haunches (no apex)
        S(-0.20, { b: 0.15, zb: 0.70, lf: [0.26, 0.77], yw: 0.46, w: 0.84, ys: 0.72, zs: 0.83, yb: 0.855, zbl: 0.765, g: [0.875, 0.665], r: [1.13, 0.565], e: [1.16, 0.53], q: [1.205, 0.30], t: 1.19 }),
        S(-0.45, { b: 0.15, zb: 0.70, lf: [0.26, 0.775], yw: 0.47, w: 0.848, ys: 0.745, zs: 0.838, yb: 0.875, zbl: 0.772, g: [0.89, 0.678], r: [1.17, 0.575], e: [1.20, 0.54], q: [1.248, 0.30], t: 1.232 }),
        S(-0.80, { b: 0.15, zb: 0.71, lf: [0.265, 0.795], yw: 0.49, w: 0.872, ys: 0.795, zs: 0.862, yb: 0.915, zbl: 0.79, g: [0.925, 0.688], r: [1.15, 0.578], e: [1.18, 0.54], q: [1.222, 0.30], t: 1.205 }),
        S(-1.05, { b: 0.15, zb: 0.725, lf: [0.275, 0.82], yw: 0.505, w: 0.888, ys: 0.83, zs: 0.878, yb: 0.95, zbl: 0.797, g: [0.955, 0.687], r: [1.105, 0.572], e: [1.13, 0.53], q: [1.165, 0.285], t: 1.15 }),
        S(-1.23, { b: 0.155, zb: 0.73, lf: [0.285, 0.84], yw: 0.51, w: 0.892, ys: 0.85, zs: 0.882, yb: 0.965, zbl: 0.79, g: [0.97, 0.68], r: [1.07, 0.565], e: [1.09, 0.515], q: [1.115, 0.27], t: 1.105 }),
        S(-1.40, { b: 0.16, zb: 0.73, lf: [0.29, 0.84], yw: 0.52, w: 0.89, ys: 0.845, zs: 0.875, yb: 0.96, zbl: 0.78, g: [0.965, 0.665], r: [1.025, 0.55], e: [1.045, 0.48], q: [1.062, 0.25], t: 1.06 }),
        S(-1.64, { b: 0.17, zb: 0.74, lf: [0.30, 0.83], yw: 0.52, w: 0.875, ys: 0.835, zs: 0.85, yb: 0.96, zbl: 0.74, h: 0.995, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-1.94, { b: 0.21, zb: 0.68, yw: 0.50, w: 0.835, ys: 0.77, zs: 0.785, yb: 0.91, zbl: 0.67, h: 0.97, c: 0.3 }),
        S(-2.075, { b: 0.26, zb: 0.58, yw: 0.50, w: 0.755, ys: 0.735, zs: 0.69, yb: 0.85, zbl: 0.56, h: 0.895, c: 0.3 }),
        S(-2.117, { b: 0.36, zb: 0.50, yw: 0.50, w: 0.62, ys: 0.68, zs: 0.58, yb: 0.75, zbl: 0.46, h: 0.77, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('deck'), row('deck'),
        row('screen'), row('roof'), row('roof'), row('hatch'), row('hatch'), row('hatch'), row('hatch'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // teardrop side glass running back into the hatch, hidden black B-pillar
      polys([[[0.32, 0.885], [-0.17, 1.125], [-0.50, 1.165], [-0.85, 1.135], [-1.10, 1.04], [-1.18, 0.965], [-1.04, 0.935]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.60, 0.905, -0.55, 1.16)], 'side', 'gloss', 0.007, true),
      // nose: oval smile mouth with plate, slim wrap-round corner lamps, pop-up lamp lid shut-lines
      // JDM Type R face: plate on the bumper, wide low trapezoid mouth under it, a lamp cluster at each upper
      // corner (slim oval lens + round projector), round fog in a black pocket below it, amber marker outboard
      polys([[[-0.36, 0.205], [0.36, 0.205], [0.42, 0.29], [-0.42, 0.29]]], 'front', 'grille', 0.005, false),
      polys([rect(-0.40, 0.205, 0.40, 0.214)], 'front', 'gloss', 0.007, false),
      polys([rect(-0.16, 0.30, 0.16, 0.385)], 'front', 'plate', 0.009, false),
      tilt(polys([ell(0.62, 0.392, 0.125, 0.032, 12, -0.12)], 'front', 'gloss', 0.007, true), 40),
      tilt(polys([ell(0.61, 0.393, 0.10, 0.022, 10, -0.12)], 'front', 'light', 0.009, true), 40),
      tilt(polys([ell(0.67, 0.388, 0.022, 0.018, 8)], 'front', 'chrome', 0.011, true), 40),
      tilt(polys([[[0.52, 0.215], [0.74, 0.225], [0.76, 0.305], [0.53, 0.30]]], 'front', 'grille', 0.006, true), 40),
      tilt(polys([ell(0.64, 0.262, 0.03, 0.026, 8)], 'front', 'light', 0.009, true), 40),
      tilt(polys([[[0.76, 0.30], [0.80, 0.305], [0.81, 0.34], [0.77, 0.335]]], 'front', 'indicator', 0.01, true), 45),
      polys([rect(-0.20, 0.135, 0.20, 0.15)], 'front', 'black', 0.004, false),
      // pop-up lamp lids: oval shut-line on each front corner of the bonnet
      polys(lidLine(1.87, 0.61, 0.15, 0.15, 0.007), 'top', 'black', 0.004, true),
      // '99 tail: smoked full-width band (gloss rim, smoked red lens) with three round lamps a side behind it: two
      // red tail / brake rings outboard, the inboard one a clear reverse lamp in a red ring
      polys([[[-0.74, 0.69], [0.74, 0.69], [0.82, 0.715], [0.85, 0.76], [0.82, 0.805], [0.74, 0.83], [-0.74, 0.83], [-0.82, 0.805], [-0.85, 0.76], [-0.82, 0.715]]], 'rear', 'gloss', 0.006, false),
      polys([[[-0.73, 0.70], [0.73, 0.70], [0.80, 0.72], [0.83, 0.76], [0.80, 0.798], [0.73, 0.82], [-0.73, 0.82], [-0.80, 0.798], [-0.83, 0.76], [-0.80, 0.72]]], 'rear', 'smoke', 0.008, false),
      polys([ell(0.72, 0.76, 0.05, 0.045, 10), ell(0.59, 0.76, 0.05, 0.045, 10)], 'rear', 'tail', 0.011, true),
      polys([ell(0.72, 0.76, 0.026, 0.023, 8), ell(0.59, 0.76, 0.026, 0.023, 8)], 'rear', 'lens', 0.013, true),
      polys([ell(0.46, 0.76, 0.045, 0.04, 10)], 'rear', 'lens', 0.011, true),
      polys([ell(0.46, 0.76, 0.028, 0.025, 8)], 'rear', 'rev', 0.013, true),
      [txt('RX-7', 0.0, 0.725, 0.026, { weight: 0.15 }), txt('TYPE R', 0.30, 0.855, 0.02, { skew: 0.2, weight: 0.14 })],
      // bumper: plate recess, red reflectors low on the corners, rear fog / reflector strip, black lower valence
      plateKit(0.40, 0.52, 0.17),
      polys([rect(0.40, 0.42, 0.56, 0.45)], 'rear', 'lens', 0.008, true),
      polys([rect(-0.72, 0.22, 0.72, 0.30)], 'rear', 'black', 0.004, false),
      polys([rect(-0.40, 0.31, -0.33, 0.335)], 'rear', 'black', 0.007, false),
      lowLamps(-2.125, [[0.40, 0.70, 0.78, 0.82]], 'tail'),
      lowLamps(-2.125, [[-0.17, 0.40, 0.17, 0.52]], 'plate', false),
      // side: amber marker, the sculpted scoop recess at the front of the door
      polys([rect(1.52, 0.46, 1.58, 0.48)], 'side', 'indicator', 0.004, true),
      polys([[[0.93, 0.33], [0.97, 0.34], [0.985, 0.52], [0.955, 0.56], [0.935, 0.50]]], 'side', 'gloss', 0.005, true),
      mirrorParts(0.12, 0.30, 0.87, 0.97, 0.74, 0.92, [0.24, 0.88, 0.74], [0.07, 0.03, 0.06]),
      [
        // Type R hoop wing: blade on two swept uprights
        { t: 'prism', mat: 'paint', z0: -0.72, z1: 0.72, pts2d: [[-1.82, 1.055], [-2.08, 1.06], [-2.10, 1.085], [-1.86, 1.08]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.64, z1: 0.70, pts2d: [[-1.72, 0.96], [-1.88, 0.96], [-2.08, 1.065], [-1.86, 1.075]] },
        // high-mount stop lamp along the blade's trailing edge
        { t: 'box', mat: 'tail', c: [-2.097, 1.072, 0], s: [0.008, 0.012, 0.30] }
      ]
    ),
    wheels: { style: 'star', spokes: 5, stock: { rim: '#c3c6ca', material: 'cast', caliper: '#2a2a2a' } },   // silver 5-spoke
    // one exit on the right with twin round tips side by side (generator exhaust override; the base model has one per corner)
    exhaust: [{ cx: 0.39, cy: 0.25, w: 0.08, h: 0.08 }, { cx: 0.48, cy: 0.25, w: 0.08, h: 0.08 }],
    notes: 'Mazda RX-7 Type R (FD3S) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_RX-7_SPIRIT_R_Type_A_(GF-FD3S)_(10).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda-rx7-3rd-generation01.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_RX-7_(FD3S)_rear_(cropped).JPG (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:1992_Mazda_RX-7.jpg (front 3/4, wing humps / sunk bonnet), ' +
      'https://commons.wikimedia.org/wiki/File:1994_Mazda_RX-7_R2_in_Vintage_Red,_front_left_(Lime_Rock).jpg (front 3/4 / profile), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_RX-7_(FD)_Washington_DC_Metro_Area,_USA_(1).jpg (front 3/4: lamp lids, bumper face), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_GF-FD3S_RX-7_Type_RS_(23021116282).jpg (front: plate, mouth, lamp clusters, fogs), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_RX-7_(FD)_Washington_DC_Metro_Area,_USA_(1.1).jpg (rear 3/4). Likeness pass 8 ' +
      '(side was long and flat): https://commons.wikimedia.org/wiki/File:Mazda_RX-7_FD3S,_front_right,_05-05-2024.jpg, ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_RX-7_FD3S,_rear_right,_05-05-2024.jpg, https://commons.wikimedia.org/wiki/File:RX-7_fd3s_rear.jpg, ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_RX-7_Restore_2022.jpg (side): rounded wing humps over a sunk bonnet (hand-shaped panel ' +
      'points), one continuous double-bubble roof arc into the curved hatch, rounder tail in plan and section, broader nose, silver 5-spoke stock wheels.'
  };
  reg('mazda-rx7-fd3s', FD);

  /* ================================================================ Nissan GT-R (R35, MY2017+) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Nissan_GT-R):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2018_Nissan_GT-R_Premium_in_Super_Silver,_Front_Right,_10-11-2022.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2018_Nissan_GT-R_Premium_in_Super_Silver,_Rear_Right,_10-11-2022.jpg
  // Signature: V-motion grille with matte-chrome surround, long swept lamps up onto the wing tops, wing vents,
  // kinked "blade" C-pillar, four round RING tail lamps under a low wing, black diffuser with quad tips.
  var R35 = {
    body: {
      stations: [
        S(2.40, { b: 0.24, zb: 0.48, yw: 0.32, w: 0.58, ys: 0.41, zs: 0.56, yb: 0.45, zbl: 0.48, h: 0.46, c: 0.2 }),
        S(2.33, { b: 0.13, zb: 0.72, yw: 0.35, w: 0.84, ys: 0.55, zs: 0.82, yb: 0.65, zbl: 0.72, h: 0.665, c: 0.5 }),
        S(2.10, { b: 0.12, zb: 0.84, yw: 0.40, w: 0.915, ys: 0.63, zs: 0.90, yb: 0.775, zbl: 0.80, h: 0.775, c: 0.3 }),
        S(1.70, { b: 0.13, zb: 0.86, yw: 0.45, w: 0.94, ys: 0.70, zs: 0.925, yb: 0.85, zbl: 0.835, h: 0.855, c: 0.6 }),
        S(1.10, { b: 0.13, zb: 0.86, yw: 0.48, w: 0.945, ys: 0.76, zs: 0.93, yb: 0.90, zbl: 0.85, h: 0.905, c: 0.6 }),
        S(0.66, { b: 0.13, zb: 0.86, yw: 0.50, w: 0.945, ys: 0.80, zs: 0.925, yb: 0.935, zbl: 0.845, h: 0.975, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-0.10, { b: 0.13, zb: 0.86, yw: 0.50, w: 0.945, ys: 0.84, zs: 0.92, yb: 0.975, zbl: 0.835, g: [0.995, 0.735], r: [1.30, 0.625], e: [1.335, 0.59], t: 1.345 }),
        S(-0.50, { b: 0.13, zb: 0.86, yw: 0.50, w: 0.945, ys: 0.85, zs: 0.92, yb: 0.99, zbl: 0.84, g: [1.01, 0.745], r: [1.335, 0.635], e: [1.36, 0.60], t: 1.37 }),
        S(-0.95, { b: 0.13, zb: 0.86, yw: 0.52, w: 0.95, ys: 0.87, zs: 0.925, yb: 1.02, zbl: 0.85, g: [1.04, 0.75], r: [1.29, 0.64], e: [1.315, 0.605], t: 1.325 }),
        S(-1.74, { b: 0.14, zb: 0.86, yw: 0.52, w: 0.95, ys: 0.88, zs: 0.92, yb: 1.08, zbl: 0.80, h: 1.115, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-2.12, { b: 0.18, zb: 0.84, yw: 0.55, w: 0.925, ys: 0.88, zs: 0.895, yb: 1.05, zbl: 0.77, h: 1.085, c: 0.3 }),
        S(-2.275, { b: 0.25, zb: 0.78, yw: 0.55, w: 0.885, ys: 0.90, zs: 0.865, yb: 1.055, zbl: 0.76, h: 1.085, c: 0.3 }),
        S(-2.31, { b: 0.34, zb: 0.68, yw: 0.55, w: 0.84, ys: 0.93, zs: 0.82, yb: 1.03, zbl: 0.72, h: 1.05, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('deck'),
        row('screen'), row('roof'), row('rscreen'), row('rscreen'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // side glass with the reverse-kink blade C-pillar, black B-pillar
      polys([[[0.55, 1.0], [-0.08, 1.295], [-0.70, 1.315], [-0.98, 1.19], [-1.07, 1.11], [-1.24, 1.045], [-0.40, 1.02]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.47, 1.0, -0.42, 1.31)], 'side', 'gloss', 0.007, true),
      // V-motion grille: chrome surround, mesh, badge
      polys([[[-0.29, 0.635], [0.29, 0.635], [0.35, 0.585], [0.44, 0.27], [-0.44, 0.27], [-0.35, 0.585]]], 'front', 'grille', 0.005, false),
      // the matte-chrome V-motion bar across the top of the opening (dark mesh above, badge on it)
      polys([[[-0.31, 0.615], [0.31, 0.615], [0.24, 0.515], [-0.24, 0.515]]], 'front', 'chrome', 0.008, false),
      polys([[[-0.27, 0.618], [0.27, 0.618], [0.215, 0.545], [-0.215, 0.545]]], 'front', 'grille', 0.010, false),
      // long swept headlamps with lightning-bolt DRL, deep corner intakes, carbon chin
      polys([[[0.32, 0.625], [0.62, 0.635], [0.84, 0.70], [0.90, 0.745], [0.82, 0.76], [0.56, 0.69], [0.33, 0.665]]], 'front', 'gloss', 0.006, true),
      polys([[[0.35, 0.633], [0.62, 0.643], [0.83, 0.705], [0.875, 0.74], [0.81, 0.75], [0.56, 0.682], [0.36, 0.66]]], 'front', 'light', 0.009, true),
      polys([[[0.36, 0.636], [0.62, 0.645], [0.66, 0.655], [0.62, 0.652], [0.38, 0.645]], [[0.62, 0.645], [0.70, 0.672], [0.66, 0.672]]], 'front', 'drl', 0.012, true),
      polys([[[0.52, 0.26], [0.74, 0.27], [0.80, 0.52], [0.58, 0.50]]], 'front', 'grille', 0.005, true),
      polys([rect(-0.86, 0.12, 0.86, 0.19)], 'front', 'carbon', 0.006, false),
      polys([[[1.35, 0.28], [1.60, 0.30], [1.60, 0.33], [1.35, 0.31]]], 'top', 'black', 0.004, true),
      // wing vent with blade behind the front wheel
      polys([[[0.80, 0.52], [0.86, 0.52], [0.98, 0.86], [0.92, 0.86]]], 'side', 'gloss', 0.004, true),
      // rear: four round RING lamps — gloss bezel, lit red ring, chrome reflector bowl, red inner ring, chrome core
      roundLamp(-2.306, 0.945, 0.70, [[0.080, 'gloss', 0.02], [0.074, 'tail'], [0.052, 'chrome'], [0.036, 'tail'], [0.022, 'smoke']]),
      roundLamp(-2.306, 0.945, 0.50, [[0.090, 'gloss', 0.02], [0.084, 'tail'], [0.059, 'chrome'], [0.041, 'tail'], [0.025, 'smoke']]),
      // boot lid shut lines between the lamps, plate recess on the lid, GT-R badge
      seams([[0.395, 0.565, 0.395, 1.06], [-0.395, 0.565, 0.395, 0.565]], false),
      seams([[-0.395, 0.565, -0.395, 1.06]], false),
      [txt('GT-R', 0.30, 0.875, 0.038, { weight: 0.16 })],
      plateKit(0.665, 0.79, 0.17),
      // black diffuser: V-shaped top edge, strakes, red rear fog in the centre, slatted corner vents
      polys([[[-0.88, 0.18], [0.88, 0.18], [0.89, 0.46], [0.40, 0.48], [0.0, 0.40], [-0.40, 0.48], [-0.89, 0.46]]], 'rear', 'black', 0.005, false),
      polys([rect(-0.07, 0.25, 0.07, 0.29)], 'rear', 'tail', 0.009, false),
      polys([[[0.68, 0.24], [0.84, 0.24], [0.85, 0.42], [0.70, 0.43]]], 'rear', 'grille', 0.008, true),
      polys([0, 1, 2].map(function (k) { var y = 0.28 + k * 0.05; return rect(0.70, y, 0.845, y + 0.012); }), 'rear', 'gloss', 0.011, true),
      strakes([0.10, 0.22, 0.34], 0.19, 0.38),
      polys([rect(0.80, 0.50, 0.85, 0.53)], 'rear', 'lens', 0.006, true),
      polys([rect(-2.27, 0.50, -2.21, 0.70)], 'side', 'lens', 0.005, true),
      lowLamps(-2.316, [[0.62, 0.87, 0.78, 1.02], [0.41, 0.86, 0.59, 1.03]], 'tail'),
      lowLamps(-2.316, [[-0.17, 0.665, 0.17, 0.79]], 'plate', false),
      polys([rect(-0.25, 0.92, -0.13, 0.94)], 'side', 'black', 0.004, true),
      mirrorParts(0.33, 0.52, 1.02, 1.12, 0.84, 1.02, [0.46, 1.02, 0.84], [0.08, 0.03, 0.06]),
      [
        // low boot wing on end stalks
        { t: 'prism', mat: 'paint', z0: -0.74, z1: 0.74, pts2d: [[-1.98, 1.155], [-2.22, 1.165], [-2.24, 1.19], [-2.01, 1.18]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.62, z1: 0.66, pts2d: [[-2.02, 1.07], [-2.20, 1.06], [-2.21, 1.17], [-2.03, 1.165]] },
        { t: 'box', mat: 'tail', c: [-2.238, 1.176, 0], s: [0.008, 0.012, 0.36] }
      ]
    ),
    wheels: { style: 'split', spokes: 6 },
    // quad round titanium tips, a pair each side of the diffuser
    exhaust: [{ cx: 0.44, cy: 0.235, w: 0.12, h: 0.115, mirror: true }, { cx: 0.575, cy: 0.235, w: 0.12, h: 0.115, mirror: true }],
    notes: 'Nissan GT-R (R35, MY2017+) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2018_Nissan_GT-R_Premium_in_Super_Silver,_Front_Right,_10-11-2022.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2018_Nissan_GT-R_Premium_in_Super_Silver,_Rear_Right,_10-11-2022.jpg (rear 3/4).'
  };
  reg('nissan-gtr-r35', R35);

  /* ================================================================ Ford Mustang GT Fastback (S650) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Ford_Mustang_(seventh_generation)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2024_Ford_Mustang_2.3_EcoBoost_in_Race_Red,_front_left,_06-26-2024.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2024_Ford_Mustang_2.3_EcoBoost_in_Race_Red,_rear_left,_06-26-2024.jpg
  // Signature: forward-leaning shark nose with a big trapezoid mesh grille, slim lamps with the three-bar
  // DRL, long bonnet with GT heat extractors, fastback roof with tapering quarter glass, TRI-BAR tail lamps.
  var MUS = {
    body: {
      stations: [
        S(2.285, { b: 0.46, zb: 0.44, yw: 0.55, w: 0.54, ys: 0.63, zs: 0.52, yb: 0.665, zbl: 0.46, h: 0.675, c: 0.1 }),
        S(2.23, { b: 0.20, zb: 0.68, yw: 0.42, w: 0.80, ys: 0.64, zs: 0.79, yb: 0.725, zbl: 0.72, h: 0.75, c: 0.4 }),
        S(2.06, { b: 0.15, zb: 0.83, yw: 0.45, w: 0.895, ys: 0.67, zs: 0.885, yb: 0.785, zbl: 0.81, h: 0.805, c: 0.6 }),
        S(1.62, { b: 0.15, zb: 0.86, yw: 0.48, w: 0.935, ys: 0.72, zs: 0.925, yb: 0.84, zbl: 0.845, h: 0.875, c: 1.0 }),
        S(0.96, { b: 0.15, zb: 0.86, yw: 0.50, w: 0.94, ys: 0.78, zs: 0.93, yb: 0.89, zbl: 0.855, h: 0.93, c: 1.0 }),
        S(0.58, { b: 0.15, zb: 0.86, yw: 0.50, w: 0.94, ys: 0.82, zs: 0.925, yb: 0.955, zbl: 0.85, h: 0.995, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-0.15, { b: 0.15, zb: 0.86, yw: 0.50, w: 0.94, ys: 0.86, zs: 0.92, yb: 1.01, zbl: 0.835, g: [1.03, 0.74], r: [1.31, 0.63], e: [1.345, 0.595], t: 1.355 }),
        S(-0.50, { b: 0.15, zb: 0.87, yw: 0.50, w: 0.945, ys: 0.87, zs: 0.925, yb: 1.03, zbl: 0.845, g: [1.05, 0.745], r: [1.355, 0.64], e: [1.385, 0.605], t: 1.397 }),
        S(-0.80, { b: 0.15, zb: 0.87, yw: 0.52, w: 0.95, ys: 0.88, zs: 0.93, yb: 1.045, zbl: 0.85, g: [1.065, 0.75], r: [1.33, 0.645], e: [1.36, 0.61], t: 1.37 }),
        S(-1.30, { b: 0.15, zb: 0.88, yw: 0.52, w: 0.955, ys: 0.89, zs: 0.935, yb: 1.065, zbl: 0.85, g: [1.08, 0.72], r: [1.20, 0.635], e: [1.225, 0.595], t: 1.245 }),
        S(-1.86, { b: 0.15, zb: 0.88, yw: 0.52, w: 0.955, ys: 0.90, zs: 0.93, yb: 1.035, zbl: 0.82, h: 1.075, c: 0.4, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-2.30, { b: 0.20, zb: 0.86, yw: 0.55, w: 0.93, ys: 0.90, zs: 0.90, yb: 1.015, zbl: 0.78, h: 1.045, c: 0.3 }),
        S(-2.48, { b: 0.27, zb: 0.78, yw: 0.55, w: 0.87, ys: 0.88, zs: 0.84, yb: 0.985, zbl: 0.74, h: 1.01, c: 0.3 }),
        S(-2.525, { b: 0.40, zb: 0.62, yw: 0.55, w: 0.72, ys: 0.84, zs: 0.70, yb: 0.93, zbl: 0.62, h: 0.95, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('deck'),
        row('screen'), row('roof'), row('roof'), row('rscreen'), row('rscreen'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // door glass + quarter glass tapering to a point, black B-pillar
      polys([[[0.55, 1.035], [-0.12, 1.30], [-0.55, 1.33], [-0.55, 1.045]]], 'side', 'glass', 0.006, true),
      polys([[[-0.60, 1.047], [-0.60, 1.33], [-0.78, 1.32], [-1.32, 1.085]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.60, 1.04, -0.55, 1.33)], 'side', 'gloss', 0.007, true),
      // shark-nose trapezoid mesh grille, plate
      polys([[[-0.56, 0.69], [0.56, 0.69], [0.64, 0.56], [0.44, 0.36], [-0.44, 0.36], [-0.64, 0.56]]], 'front', 'grille', 0.005, false),
      polys([rect(-0.18, 0.40, 0.18, 0.50)], 'front', 'plate', 0.009, false),
      // tri-bar LED headlamps: tall dark housing rising outboard under the bonnet lip, slim projector lens along its
      // top edge and three bold raked vertical DRL bars (the S650's three-element signature)
      polys([[[0.545, 0.572], [0.80, 0.598], [0.865, 0.64], [0.855, 0.718], [0.78, 0.718], [0.555, 0.668]]], 'front', 'gloss', 0.006, true),
      polys([[[0.575, 0.652], [0.78, 0.697], [0.845, 0.700], [0.842, 0.712], [0.778, 0.711], [0.572, 0.664]]], 'front', 'light', 0.009, true),
      polys([0, 1, 2].map(function (k) {
        var z = 0.600 + k * 0.078, yb = 0.586 + k * 0.009, yt = 0.650 + k * 0.016;
        return [[z, yb], [z + 0.032, yb + 0.003], [z + 0.040, yt], [z + 0.008, yt - 0.003]];
      }), 'front', 'drl', 0.012, true),
      // corner intakes, chin
      tilt(polys([[[0.58, 0.25], [0.79, 0.265], [0.80, 0.37], [0.62, 0.38]]], 'front', 'grille', 0.005, true), 40),
      polys([rect(-0.86, 0.14, 0.86, 0.21)], 'front', 'black', 0.006, false),
      // GT bonnet heat extractors
      polys([[[1.20, 0.22], [1.52, 0.24], [1.52, 0.40], [1.20, 0.42]]], 'top', 'black', 0.004, true),
      // rear: dark trapezoid housings (gloss rim, smoked lens) each with three raked vertical TRI-BARS and a red
      // lens sill under them
      polys([[[0.36, 0.83], [0.82, 0.81], [0.86, 0.94], [0.40, 0.96]]], 'rear', 'gloss', 0.006, true),
      polys([[[0.375, 0.838], [0.815, 0.82], [0.848, 0.932], [0.41, 0.95]]], 'rear', 'smoke', 0.008, true),
      polys([0, 1, 2].map(function (k) { var z = 0.46 + k * 0.125; return [[z, 0.835], [z + 0.045, 0.832], [z + 0.07, 0.945], [z + 0.025, 0.948]]; }), 'rear', 'tail', 0.011, true),
      polys([[[0.37, 0.832], [0.82, 0.813], [0.823, 0.826], [0.372, 0.845]]], 'rear', 'lens', 0.012, true),
      // decklid shut lines, GT badge, plate in the bumper, sensor dots
      seams([[0.34, 0.785, 0.34, 0.985], [-0.34, 0.785, 0.34, 0.785]], false),
      seams([[-0.34, 0.785, -0.34, 0.985]], false),
      [txt('GT', 0, 0.875, 0.05, { weight: 0.17, spacing: 1.6 })],
      plateKit(0.58, 0.69, 0.17),
      polys([rect(0.26, 0.505, 0.275, 0.52), rect(0.55, 0.50, 0.565, 0.515)], 'rear', 'black', 0.007, true),
      // black diffuser: red rear fog in the centre, strakes, red corner reflectors
      polys([rect(-0.86, 0.20, 0.86, 0.44)], 'rear', 'black', 0.005, false),
      polys([rect(-0.06, 0.30, 0.06, 0.33)], 'rear', 'tail', 0.009, false),
      strakes([0.14, 0.24], 0.21, 0.40),
      polys([rect(0.76, 0.42, 0.86, 0.44)], 'rear', 'lens', 0.009, true),
      // high-mount stop lamp at the top of the rear glass
      polys([rect(-0.12, 1.315, 0.12, 1.332)], 'rear', 'tail', 0.006, false),
      lowLamps(-2.533, [0, 1, 2].map(function (k) { var z = 0.46 + k * 0.125; return [z, 0.835, z + 0.06, 0.945]; }), 'tail'),
      lowLamps(-2.533, [[-0.17, 0.58, 0.17, 0.69]], 'plate', false),
      polys([rect(-0.32, 0.95, -0.20, 0.97)], 'side', 'black', 0.004, true),
      mirrorParts(0.34, 0.54, 1.05, 1.15, 0.85, 1.04, [0.47, 1.05, 0.85], [0.08, 0.03, 0.06]),
      [
        // ducktail lip
        { t: 'prism', mat: 'paint', z0: -0.70, z1: 0.70, pts2d: [[-2.30, 1.04], [-2.47, 1.005], [-2.49, 1.03], [-2.32, 1.06]] }
      ]
    ),
    wheels: { style: 'split', spokes: 5 },
    // quad round tips in pairs either side of the centre fog lamp
    exhaust: [{ cx: 0.37, cy: 0.255, w: 0.11, h: 0.11, mirror: true }, { cx: 0.485, cy: 0.255, w: 0.11, h: 0.11, mirror: true }],
    notes: 'Ford Mustang GT Fastback (S650) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2024_Ford_Mustang_2.3_EcoBoost_in_Race_Red,_front_left,_06-26-2024.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2024_Ford_Mustang_2.3_EcoBoost_in_Race_Red,_rear_left,_06-26-2024.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Ford_Mustang_GT_(S650)_Washington_DC_Metro_Area,_USA.jpg (rear 3/4).'
  };
  reg('ford-mustang-gt-s650', MUS);

  /* ================================================================ Chevrolet Camaro ZL1 (2019) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Chevrolet_Camaro_(sixth_generation)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2019_Chevrolet_Camaro_2SS,_front_11.9.19.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2019_Chevrolet_Camaro_2SS,_rear_11.9.19.jpg
  // Signature: chopped roof with a SLIT greenhouse over very tall body sides, two-tier face (thin upper slot +
  // huge lower grille split by a body-colour bar), slit lamps with light guides, carbon bonnet extractor,
  // twin rectangular lamps a side in a black housing, deck-lid spoiler.
  var CAM = {
    body: {
      stations: [
        // blunt two-tier nose: the lower bumper (huge grille, splitter) is the leading face, the upper fascia with
        // the slit lamps stands almost upright above it and turns sharply into the bonnet (no pointed wedge)
        S(2.3405, { b: 0.15, zb: 0.56, yw: 0.34, w: 0.66, ys: 0.56, zs: 0.65, yb: 0.64, zbl: 0.57, h: 0.655, c: 0.2 }),
        S(2.30, { b: 0.12, zb: 0.74, yw: 0.36, w: 0.82, ys: 0.68, zs: 0.80, yb: 0.765, zbl: 0.74, h: 0.78, c: 0.3 }),
        S(2.20, { b: 0.12, zb: 0.80, yw: 0.42, w: 0.875, ys: 0.72, zs: 0.86, yb: 0.81, zbl: 0.80, h: 0.82, c: 0.5 }),
        S(2.07, { b: 0.12, zb: 0.845, yw: 0.44, w: 0.915, ys: 0.74, zs: 0.905, yb: 0.825, zbl: 0.85, h: 0.835, c: 0.7 }),
        // long bonnet with crested wing tops; a low shoulder along the front door
        S(1.90, { b: 0.12, zb: 0.86, yw: 0.46, w: 0.935, ys: 0.76, zs: 0.925, yb: 0.84, zbl: 0.865, h: 0.85, c: 0.9 }),
        S(1.45, { b: 0.13, zb: 0.87, yw: 0.48, w: 0.945, ys: 0.79, zs: 0.935, yb: 0.87, zbl: 0.87, h: 0.885, c: 1.0 }),
        S(0.95, { b: 0.13, zb: 0.87, yw: 0.45, w: 0.945, ys: 0.79, zs: 0.915, yb: 0.915, zbl: 0.865, h: 0.93, c: 1.0 }),
        S(0.62, { b: 0.13, zb: 0.87, yw: 0.45, w: 0.945, ys: 0.81, zs: 0.905, yb: 0.96, zbl: 0.85, h: 0.985, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        // chopped slit glasshouse on very tall sides: the belt climbs from the A-pillar to the quarter glass and the
        // shoulder pinches in along the doors, then kicks out into the rear haunch (coke bottle)
        S(-0.10, { b: 0.13, zb: 0.87, yw: 0.47, w: 0.945, ys: 0.83, zs: 0.90, yb: 0.99, zbl: 0.82, g: [1.005, 0.765], r: [1.255, 0.665], e: [1.30, 0.62], t: 1.33 }),
        S(-0.60, { b: 0.13, zb: 0.87, yw: 0.51, w: 0.95, ys: 0.87, zs: 0.93, yb: 1.025, zbl: 0.835, g: [1.04, 0.765], r: [1.29, 0.665], e: [1.325, 0.63], t: 1.344 }),
        S(-1.05, { b: 0.13, zb: 0.875, yw: 0.56, w: 0.952, ys: 0.915, zs: 0.966, yb: 1.065, zbl: 0.855, g: [1.085, 0.765], r: [1.24, 0.665], e: [1.265, 0.63], t: 1.28 }),
        S(-1.45, { b: 0.13, zb: 0.88, yw: 0.59, w: 0.948, ys: 0.94, zs: 0.972, yb: 1.08, zbl: 0.85, g: [1.095, 0.75], r: [1.18, 0.66], e: [1.195, 0.62], t: 1.205 }),
        // short, high deck with the lip spoiler; tall upright tail
        S(-1.85, { b: 0.13, zb: 0.88, yw: 0.56, w: 0.95, ys: 0.935, zs: 0.95, yb: 1.065, zbl: 0.83, h: 1.09, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-2.20, { b: 0.17, zb: 0.86, yw: 0.56, w: 0.925, ys: 0.925, zs: 0.915, yb: 1.05, zbl: 0.80, h: 1.075, c: 0.3 }),
        S(-2.38, { b: 0.24, zb: 0.80, yw: 0.56, w: 0.885, ys: 0.91, zs: 0.865, yb: 1.03, zbl: 0.75, h: 1.055, c: 0.3 }),
        S(-2.4425, { b: 0.31, zb: 0.66, yw: 0.56, w: 0.78, ys: 0.885, zs: 0.76, yb: 0.99, zbl: 0.66, h: 1.015, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('deck'), row('deck'),
        row('screen'), row('roof'), row('roof'), row('rscreen'), row('rsail'), row('deck'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // slit side glass: door glass + small fixed quarter, black B-pillar (the DLO is barely a third of the side height)
      polys([[[0.46, 0.99], [0.12, 1.17], [-0.12, 1.245], [-0.60, 1.28], [-0.60, 1.03]]], 'side', 'glass', 0.006, true),
      polys([[[-0.65, 1.035], [-0.65, 1.28], [-0.84, 1.245], [-0.98, 1.17], [-1.07, 1.075]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.65, 1.025, -0.60, 1.282)], 'side', 'gloss', 0.007, true),
      // face, top to bottom: thin black upper slot between the lamps (text badge on it), body-colour bar,
      // then the huge honeycomb lower grille that fills the bumper, flanked by tall vertical air curtains
      tilt(polys([[[-0.44, 0.665], [0.44, 0.665], [0.47, 0.705], [0.47, 0.745], [-0.47, 0.745], [-0.47, 0.705]]], 'front', 'grille', 0.006, false), 45),
      tilt(polys([[[-0.46, 0.20], [0.46, 0.20], [0.60, 0.33], [0.66, 0.48], [0.61, 0.60], [-0.61, 0.60], [-0.66, 0.48], [-0.60, 0.33]]], 'front', 'grille', 0.005, false), 40),
      // honeycomb: staggered gloss zig-zag bars across the mesh
      tilt(polys([0, 1, 2, 3].map(function (k) {
        var y = 0.255 + k * 0.08, w = 0.46 + k * 0.045, n = 7, top = [], bot = [];
        for (var i = 0; i <= n; i++) {
          var z = -w + 2 * w * i / n, d = ((i + k) % 2) ? 0.022 : -0.022;
          top.push([z, y + d + 0.011]); bot.unshift([z, y + d - 0.011]);
        }
        return top.concat(bot);
      }), 'front', 'gloss', 0.004, false), 40),
      [{ t: 'text', view: 'front', str: 'ZL1', at: [-0.47, 0.517], h: 0.03, mat: 'chrome', maxTilt: 40, weight: 0.17 }],
      // slim swept lamps: low pointed inner end, the outer end climbs and wraps onto the wing; LED light guide
      // along the lower edge hooking down at the outer end
      tilt(polys([[[0.47, 0.666], [0.66, 0.674], [0.76, 0.698], [0.815, 0.733], [0.825, 0.768], [0.70, 0.764], [0.47, 0.742]]], 'front', 'gloss', 0.006, true), 50),
      tilt(polys([[[0.60, 0.70], [0.74, 0.708], [0.795, 0.735], [0.805, 0.756], [0.60, 0.745]]], 'front', 'light', 0.006, true), 50),
      tilt(polys([ell(0.655, 0.726, 0.028, 0.015, 8), ell(0.735, 0.731, 0.028, 0.015, 8)], 'front', 'chrome', 0.006, true), 50),
      tilt(polys([[[0.48, 0.672], [0.76, 0.702], [0.818, 0.738], [0.818, 0.712], [0.80, 0.716], [0.76, 0.688], [0.48, 0.66]]], 'front', 'drl', 0.006, true), 50),
      // vertical corner air curtains (tall black slots), deep carbon splitter
      tilt(polys([[[0.68, 0.22], [0.80, 0.23], [0.85, 0.40], [0.84, 0.56], [0.73, 0.56], [0.70, 0.42]]], 'front', 'grille', 0.006, true), 40),
      tilt(polys([[[0.81, 0.27], [0.84, 0.27], [0.86, 0.40], [0.85, 0.53], [0.825, 0.53], [0.83, 0.40]]], 'front', 'black', 0.006, true), 40),
      polys([[[-0.86, 0.085], [0.86, 0.085], [0.84, 0.15], [-0.84, 0.15]]], 'front', 'carbon', 0.006, false),
      [{ t: 'box', mat: 'carbon', c: [2.33, 0.105, 0], s: [0.09, 0.025, 1.66] }],
      // big carbon bonnet extractor with louvres
      polys([[[1.22, -0.30], [1.86, -0.36], [1.86, 0.36], [1.22, 0.30]]], 'top', 'carbon', 0.004, false),
      polys([0, 1, 2, 3, 4].map(function (k) { var x = 1.30 + k * 0.11; return rect(x, -0.27, x + 0.05, 0.27); }), 'top', 'black', 0.007, false),
      // rear: gloss black housing with two rectangular elements a side, each a lit red light-guide frame round a
      // smoked centre with a red LED bar through it
      polys([[[0.28, 0.885], [0.86, 0.875], [0.89, 0.985], [0.28, 0.995]]], 'rear', 'gloss', 0.006, true),
      polys([rect(0.33, 0.905, 0.55, 0.97), [[0.60, 0.903], [0.83, 0.898], [0.85, 0.965], [0.60, 0.97]]], 'rear', 'tail', 0.009, true),
      polys([rect(0.345, 0.917, 0.535, 0.958), [[0.613, 0.915], [0.818, 0.911], [0.835, 0.953], [0.613, 0.958]]], 'rear', 'smoke', 0.011, true),
      polys([rect(0.40, 0.933, 0.535, 0.942), rect(0.613, 0.931, 0.826, 0.94)], 'rear', 'tail', 0.013, true),
      // high-mount stop lamp under the spoiler, decklid shut lines, ZL1 badge beside the plate
      polys([rect(-0.11, 0.99, 0.11, 1.004)], 'rear', 'tail', 0.007, false),
      seams([[0.265, 0.78, 0.265, 1.0], [-0.265, 0.78, 0.265, 0.78]], false),
      seams([[-0.265, 0.78, -0.265, 1.0]], false),
      [txt('ZL1', -0.32, 0.665, 0.04, { weight: 0.17, skew: 0.15 })],
      plateKit(0.60, 0.71, 0.17),
      // black diffuser with strakes, red reflectors on its top corners
      polys([rect(-0.86, 0.22, 0.86, 0.42)], 'rear', 'black', 0.005, false),
      strakes([0.10, 0.22, 0.34], 0.23, 0.40),
      polys([rect(0.58, 0.425, 0.76, 0.44)], 'rear', 'lens', 0.008, true),
      lowLamps(-2.45, [[0.33, 0.905, 0.55, 0.97], [0.60, 0.90, 0.84, 0.968]], 'tail'),
      lowLamps(-2.45, [[-0.17, 0.60, 0.17, 0.71]], 'plate', false),
      polys([rect(-0.40, 0.955, -0.28, 0.975)], 'side', 'black', 0.004, true),
      // side marker / gill under the front-wing crest
      polys([[[1.95, 0.60], [2.10, 0.62], [2.10, 0.64], [1.95, 0.625]]], 'side', 'indicator', 0.005, true),
      mirrorParts(0.30, 0.50, 1.01, 1.10, 0.85, 1.03, [0.43, 1.01, 0.85], [0.08, 0.03, 0.06]),
      [
        // deck-lid lip spoiler at the very tail
        { t: 'prism', mat: 'black', z0: -0.74, z1: 0.74, pts2d: [[-2.22, 1.08], [-2.42, 1.035], [-2.465, 1.095], [-2.40, 1.11]] }
      ]
    ),
    wheels: { style: 'split', spokes: 5, stock: { rim: '#2a2b2e', material: 'forged', caliper: '#c8102e' } },   // dark forged 20 in, red Brembo
    notes: 'Chevrolet Camaro ZL1 (2019) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2019_Chevrolet_Camaro_2SS,_front_11.9.19.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2019_Chevrolet_Camaro_2SS,_rear_11.9.19.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Chevrolet_Camaro_ZL1.jpg (front 3/4: raked upper face, lower grille), ' +
      'https://commons.wikimedia.org/wiki/File:Chevrolet_Camaro_ZL1_(68283).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Chevrolet_Camaro_ZL1_(SMT03).jpg (rear 3/4). Likeness pass 8 (was a long generic ' +
      'wedge with a blocky face): https://commons.wikimedia.org/wiki/File:Chevrolet_Camaro_VI_02_China_2019-03-13.jpg (side: short ' +
      'slit DLO ending at ~-1.05, thick painted sail), https://commons.wikimedia.org/wiki/File:Chevrolet_Camaro_ZL1_LE_2018_at_Legendy_2019_in_Prague.jpg ' +
      '(front 3/4), https://commons.wikimedia.org/wiki/File:Trieste_Chevrolet_Camaro_ZL1.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Camaro_at_2017_New_York_Auto_Show_(1).jpg (front: slim swept lamps, thin upper slot, huge ' +
      'honeycomb lower grille, air curtains), https://commons.wikimedia.org/wiki/File:-190,_2018_Chevrolet_Camaro_ZL1_1LE,_TT-S1,_Advanced_(53919871458).jpg (side). ' +
      'Blunt two-tier nose rounded in plan, belt climbing to the quarter glass, shoulder pinched along the doors and kicking out ' +
      'over the rear wheel (coke bottle), short high deck with a lip spoiler.'
  };
  reg('chevrolet-camaro-zl1-2019', CAM);

  /* ================================================================ Dodge Challenger SRT Hellcat */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Dodge_Challenger_(2008)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2015_HellCat.JPG
  //   side:      https://commons.wikimedia.org/wiki/File:2016_DodgeChallenger_(Texas_Dealer_special_edition)_Hellcat_side_01.jpg
  //   front:     https://commons.wikimedia.org/wiki/File:2019_Dodge_Challenger_Hellcat_RedEye.jpg
  // Signature: long flat bonnet with the centre scoop + twin extractors, upright full-width recessed grille with
  // QUAD ROUND HALO lamps (inner left = Air Catcher intake), notchback roof, round filler on the quarter,
  // full-width racetrack tail lamp around a gloss-black panel.
  var HC = {
    body: {
      stations: [
        S(2.468, { b: 0.30, zb: 0.58, yw: 0.45, w: 0.72, ys: 0.66, zs: 0.72, yb: 0.78, zbl: 0.64, h: 0.80, c: 0.1 }),
        S(2.42, { b: 0.15, zb: 0.79, yw: 0.45, w: 0.90, ys: 0.72, zs: 0.895, yb: 0.83, zbl: 0.83, h: 0.845, c: 0.3 }),
        S(2.20, { b: 0.13, zb: 0.86, yw: 0.48, w: 0.95, ys: 0.76, zs: 0.945, yb: 0.86, zbl: 0.875, h: 0.87, c: 0.5 }),
        S(1.60, { b: 0.14, zb: 0.88, yw: 0.50, w: 0.96, ys: 0.80, zs: 0.955, yb: 0.895, zbl: 0.89, h: 0.91, c: 0.5 }),
        S(1.05, { b: 0.14, zb: 0.88, yw: 0.50, w: 0.96, ys: 0.84, zs: 0.955, yb: 0.93, zbl: 0.89, h: 0.945, c: 0.5 }),
        S(0.62, { b: 0.14, zb: 0.88, yw: 0.50, w: 0.96, ys: 0.88, zs: 0.95, yb: 0.985, zbl: 0.885, h: 1.01, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-0.05, { b: 0.14, zb: 0.88, yw: 0.52, w: 0.96, ys: 0.92, zs: 0.945, yb: 1.04, zbl: 0.87, g: [1.06, 0.78], r: [1.35, 0.685], e: [1.385, 0.65], t: 1.40 }),
        S(-0.45, { b: 0.14, zb: 0.88, yw: 0.52, w: 0.96, ys: 0.93, zs: 0.945, yb: 1.05, zbl: 0.875, g: [1.07, 0.785], r: [1.42, 0.69], e: [1.445, 0.655], t: 1.454 }),
        S(-1.00, { b: 0.14, zb: 0.88, yw: 0.52, w: 0.96, ys: 0.94, zs: 0.95, yb: 1.07, zbl: 0.88, g: [1.09, 0.79], r: [1.38, 0.69], e: [1.405, 0.655], t: 1.415 }),
        S(-1.80, { b: 0.15, zb: 0.90, yw: 0.52, w: 0.96, ys: 0.95, zs: 0.94, yb: 1.08, zbl: 0.86, h: 1.12, c: 0.3, fr: [0.12, 0.24, 0.32, 0.66] }),
        S(-2.40, { b: 0.18, zb: 0.88, yw: 0.55, w: 0.95, ys: 0.95, zs: 0.93, yb: 1.075, zbl: 0.83, h: 1.10, c: 0.3 }),
        S(-2.535, { b: 0.25, zb: 0.80, yw: 0.55, w: 0.915, ys: 0.95, zs: 0.90, yb: 1.08, zbl: 0.80, h: 1.10, c: 0.3 }),
        S(-2.549, { b: 0.32, zb: 0.72, yw: 0.55, w: 0.86, ys: 0.93, zs: 0.85, yb: 1.055, zbl: 0.74, h: 1.07, c: 0.2 })
      ],
      mats: [
        row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint'), row('deck'), row('deck'),
        row('screen'), row('roof'), row('roof'), row('rscreen'), row('deck', 'paint'), row('deck', 'paint'), row('deck', 'paint')
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // frameless door glass + rounded quarter glass, black B-pillar
      polys([[[0.60, 1.065], [-0.03, 1.345], [-0.50, 1.385], [-0.50, 1.075]]], 'side', 'glass', 0.006, true),
      polys([[[-0.55, 1.077], [-0.55, 1.39], [-0.88, 1.385], [-1.12, 1.27], [-1.26, 1.10]]], 'side', 'glass', 0.006, true),
      polys([rect(-0.55, 1.07, -0.50, 1.39)], 'side', 'gloss', 0.007, true),
      // full-width recessed upper grille with the quad round halo lamps
      polys([rect(-0.90, 0.565, 0.90, 0.775)], 'front', 'grille', 0.005, false),
      polys([ell(0.80, 0.668, 0.072, 0.072, 12), ell(0.625, 0.668, 0.072, 0.072, 12)], 'front', 'drl', 0.008, true),
      polys([ell(0.80, 0.668, 0.058, 0.058, 12), ell(0.625, 0.668, 0.058, 0.058, 12)], 'front', 'light', 0.011, true),
      polys([ell(0.80, 0.668, 0.028, 0.028, 8), ell(0.625, 0.668, 0.028, 0.028, 8)], 'front', 'chrome', 0.014, true),
      polys([ell(-0.625, 0.668, 0.05, 0.05, 10)], 'front', 'grille', 0.016, false),   // Air Catcher (inner left)
      [{ t: 'text', view: 'front', str: 'SRT', at: [-0.06, 0.712], h: 0.022, mat: 'chrome', offset: 0.009, weight: 0.17 }],
      // lower grille split by the plate, corner brake ducts, black splitter
      polys([[[-0.64, 0.22], [0.64, 0.22], [0.66, 0.46], [-0.66, 0.46]]], 'front', 'grille', 0.005, false),
      polys([rect(-0.17, 0.35, 0.17, 0.47)], 'front', 'plate', 0.009, false),
      polys([[[0.72, 0.24], [0.86, 0.25], [0.87, 0.36], [0.73, 0.36]]], 'front', 'grille', 0.006, true),
      polys([rect(-0.92, 0.11, 0.92, 0.18)], 'front', 'black', 0.006, false),
      // Hellcat bonnet: centre scoop + twin heat extractors
      polys([[[1.45, -0.20], [1.75, -0.22], [1.75, 0.22], [1.45, 0.20]]], 'top', 'black', 0.004, false),
      polys([[[1.10, 0.42], [1.40, 0.44], [1.40, 0.62], [1.10, 0.60]]], 'top', 'black', 0.004, true),
      // full-width gloss-black tail panel carrying the two "racetrack" ring lamps (each a lit red rounded-rect ring,
      // split in two, round a smoked centre with a thin lens line), DODGE lettering between them
      tilt(polys([[[-0.86, 0.87], [0.86, 0.87], [0.90, 0.90], [0.90, 1.00], [0.86, 1.03], [-0.86, 1.03], [-0.90, 1.00], [-0.90, 0.90]]], 'rear', 'gloss', 0.006, false), 45),
      tilt(polys([rrect(0.20, 0.893, 0.85, 1.007, 0.045, 2)], 'rear', 'tail', 0.009, true), 45),
      tilt(polys([rrect(0.225, 0.913, 0.825, 0.987, 0.028, 2)], 'rear', 'smoke', 0.012, true), 45),
      tilt(polys([rect(0.505, 0.89, 0.52, 1.01)], 'rear', 'gloss', 0.015, true), 45),
      tilt(polys([rect(0.535, 0.947, 0.81, 0.953)], 'rear', 'lens', 0.015, true), 45),
      tilt(polys([rect(0.245, 0.938, 0.495, 0.962)], 'rear', 'rev', 0.015, true), 45),   // clear reverse strip, inboard half
      [txt('DODGE', 0, 0.95, 0.03, { weight: 0.12, spacing: 2.6 }), txt('SRT', 0.62, 1.05, 0.026, { weight: 0.16, skew: 0.3 })],
      seams([[-0.84, 1.036, 0.84, 1.036]], false),
      plateKit(0.58, 0.70, 0.17),
      polys([rect(-0.88, 0.20, 0.88, 0.40)], 'rear', 'black', 0.005, false),
      polys([rect(0.42, 0.405, 0.66, 0.42)], 'rear', 'lens', 0.007, true),
      // high-mount stop lamp at the top of the rear glass
      polys([rect(-0.15, 1.375, 0.15, 1.39)], 'rear', 'tail', 0.006, false),
      lowLamps(-2.556, [[-0.90, 0.87, 0.90, 1.03]], 'gloss', false),
      lowLamps(-2.562, [[0.20, 0.893, 0.505, 1.007], [0.52, 0.893, 0.85, 1.007]], 'tail'),
      lowLamps(-2.556, [[-0.17, 0.58, 0.17, 0.70]], 'plate', false),
      // side: round racing filler, amber / red markers, door handle
      polys([ell(-1.56, 0.89, 0.055, 0.055, 10)], 'side', 'gloss', 0.004, false),
      polys([rect(2.25, 0.44, 2.33, 0.46)], 'side', 'indicator', 0.004, true),
      polys([rect(-2.30, 0.50, -2.22, 0.52)], 'side', 'tail', 0.004, true),
      polys([rect(-0.32, 0.99, -0.20, 1.01)], 'side', 'black', 0.004, true),
      mirrorParts(0.38, 0.58, 1.08, 1.17, 0.88, 1.06, [0.51, 1.08, 0.88], [0.08, 0.03, 0.06]),
      [
        // deck-lid spoiler lip
        { t: 'prism', mat: 'paint', z0: -0.80, z1: 0.80, pts2d: [[-2.36, 1.10], [-2.53, 1.065], [-2.55, 1.095], [-2.38, 1.13]] }
      ]
    ),
    wheels: { style: 'split', spokes: 5 },
    // twin wide trapezoid tips at the outer ends of the valence
    exhaust: [{ cx: 0.63, cy: 0.24, w: 0.22, h: 0.075, shape: 'trapezoid', mirror: true }],
    notes: 'Dodge Challenger SRT Hellcat — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2015_HellCat.JPG (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2016_DodgeChallenger_(Texas_Dealer_special_edition)_Hellcat_side_01.jpg (side), ' +
      'https://commons.wikimedia.org/wiki/File:2019_Dodge_Challenger_Hellcat_RedEye.jpg (front).'
  };
  reg('dodge-challenger-srt-hellcat', HC);

  if (typeof module !== 'undefined' && module.exports) module.exports = {
    'nissan-silvia-s15': S15, 'nissan-skyline-gtr-r34': R34, 'mazda-rx7-fd3s': FD, 'nissan-gtr-r35': R35,
    'ford-mustang-gt-s650': MUS, 'chevrolet-camaro-zl1-2019': CAM, 'dodge-challenger-srt-hellcat': HC
  };
})();

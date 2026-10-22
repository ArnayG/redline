/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/hatch-roadster.js
   Hand-authored low-poly hot hatches and roadsters (docs/LOWPOLY-SPEC.md):
     VW Golf GTI (Mk8), Honda Civic Type R (FL5), Toyota GR Yaris, Toyota Sprinter Trueno (AE86),
     Mazda MX-5 (ND), BMW Z4 (G29), Porsche 718 Boxster (982).

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body / cabin stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.

   Closed cars (one body shell, 11 points per ring):
     0 bottom centre, 1 bottom edge, 2 sill, 3 lower flank, 4 waist / widest, 5 shoulder line,
     6 belt (top of the door skin), 7 glass base, 8 roof rail (A-pillar line), 9 roof edge, 10 centre line
   Columns: 7 = side glass, 8 = A-pillar / roof edge strip, 9 = windscreen / roof / rear screen.

   Roadsters (open top): the body ring dips into the cockpit between the windscreen and the roll hoops:
     6 door top (outer), 7 door top (inner), 8 cockpit wall bottom, 9 seat floor beside the tunnel, 10 tunnel top.
   The windscreen is a small separate cabin shell (glass + frame) so the car keeps its real windscreen height;
   seats, headrests, roll hoops and the folded-roof cover are flat-coloured parts.
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
  /** planar ellipse on a surface tilted `tiltDeg` up from vertical (normal forward, or back when `back`) */
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
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, a0, a1) {
    var parts = [], n = segs || 6, s = a0 == null ? 0 : a0, e = a1 == null ? Math.PI : a1;
    for (var k = 0; k < n; k++) {
      var b0 = s + (e - s) * k / n, b1 = s + (e - s) * (k + 1) / n;
      var P = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, b0), P(rOut, b0), P(rOut, b1), P(rIn, b1)] });
    }
    return parts;
  }
  // block capitals (3x5 cells, rows from the bottom) for badges / lettering
  var GLYPH = {
    T: [[1, 0, 2, 5], [0, 4, 3, 5]], R: [[0, 0, 1, 5], [1, 4, 2.6, 5], [2, 2.6, 3, 4], [1, 2, 2.6, 3], [2, 0, 3, 2]],
    U: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 0, 2, 1]], E: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.4, 3], [1, 0, 3, 1]],
    N: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 2.4, 2, 3.6]], O: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 0, 2, 1], [1, 4, 2, 5]],
    G: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 0, 3, 1], [2, 1, 3, 2.6], [1.6, 2, 3, 2.6]], I: [[1, 0, 2, 5]],
    Z: [[0, 4, 3, 5], [0, 0, 3, 1], [1, 1, 2, 2.4], [1.4, 2.4, 2.4, 4]], A: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 4, 2, 5], [1, 2, 2, 3]],
    M: [[0, 0, 1, 5], [2.2, 0, 3.2, 5], [1, 3, 2.2, 4]], P: [[0, 0, 1, 5], [1, 4, 3, 5], [2, 2.4, 3, 4], [1, 2, 3, 3]],
    S: [[0, 4, 3, 5], [0, 2.5, 1, 4], [0, 2, 3, 3], [2, 1, 3, 2], [0, 0, 3, 1]], C: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 0, 3, 1]],
    H: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 2, 2, 3]]
  };
  /** word centred at (ac, bc), letter height h; dir = +1 when +a reads left -> right for the viewer */
  function word(txt, ac, bc, h, dir) {
    var cell = h / 5, lw = 3 * cell, gap = cell * 0.9, total = txt.length * lw + (txt.length - 1) * gap, out = [];
    for (var i = 0; i < txt.length; i++) {
      var g = GLYPH[txt[i]]; if (!g) continue;
      var x0 = -total / 2 + i * (lw + gap);
      g.forEach(function (c) {
        var u0 = x0 + c[0] * cell, u1 = x0 + c[2] * cell;
        out.push(rect(ac + dir * Math.min(u0, u1), bc - h / 2 + c[1] * cell, ac + dir * Math.max(u0, u1), bc - h / 2 + c[3] * cell));
      });
    }
    return out.map(function (r) { return r[0][0] > r[1][0] ? [r[1], r[0], r[3], r[2]] : r; });
  }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  function P(view, mat, off, mirror, pts) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: pts }; }
  function box(mat, c, s, mirror, rotY) { return { t: 'box', mat: mat, c: c, s: s, mirror: !!mirror, rotY: rotY || 0 }; }
  function prism(mat, z0, z1, pts2d, mirror) { return { t: 'prism', mat: mat, z0: z0, z1: z1, pts2d: pts2d, mirror: mirror !== false }; }
  function cyl(mat, c, r, l, axis, sides, mirror) { return { t: 'cyl', mat: mat, c: c, r: r, l: l, axis: axis || 'x', sides: sides || 8, mirror: mirror !== false }; }
  /* ---- rear-end helpers (chase-cam detail: lamps, plates, badges, wipers, fins) */
  /** rear-view decal [z, y] (mirrored unless o.m === false); o.off offset, o.tilt maxTilt, o.low low-LOD flag */
  function R(mat, pts, o) {
    o = o || {};
    var p = { t: 'poly', view: 'rear', mat: mat, pts: pts, offset: o.off != null ? o.off : 0.008, mirror: o.m !== false };
    if (o.tilt) p.maxTilt = o.tilt;
    if (o.low) p.low = o.low;
    return p;
  }
  /** badge text (text only, no logos), rear view, centred at z / y */
  function TX(str, z, y, h, mat, o) { return Object.assign({ t: 'text', view: 'rear', str: str, at: [z, y], h: h, mat: mat || 'chrome' }, o || {}); }
  /** number-plate recess + plate + two plate lamps (rear view, centred) */
  function plate(y0, y1, hw, o) {
    o = o || {};
    var off = o.off || 0.006;
    return [
      R('black', rect(-hw - 0.02, y0 - 0.015, hw + 0.02, y1 + 0.02), { off: off - 0.002, m: false }),
      R('plate', rect(-hw, y0, hw, y1), { off: off, m: false }),
      R('light', rect(hw * 0.55, y1 + 0.004, hw * 0.8, y1 + 0.014), { off: off + 0.002 })
    ];
  }
  /** horizontal lines (rear view) between z0..z1 at ys, thickness t */
  function hlines(ys, z0, z1, t, mat, off) { return ys.map(function (y) { return R(mat, rect(z0, y - t / 2, z1, y + t / 2), { off: off, m: false }); }); }
  /** rear wiper on the hatch glass: pivot (z, y), blade to the right, `ang` degrees up from horizontal */
  function wiper(z, y, len, ang, off) {
    var a = ang * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), w = 0.009;
    return [
      R('gloss', [[z - sn * w, y + c * w], [z + c * len - sn * w, y + sn * len + c * w], [z + c * len + sn * w, y + sn * len - c * w], [z + sn * w, y - c * w]], { off: off || 0.01, m: false }),
      R('gloss', ell(z, y, 0.02, 0.02, 6), { off: (off || 0.01) + 0.002, m: false })
    ];
  }
  /** small round dots (parking sensors) at [z, y] pairs, mirrored */
  function dots(list, r, mat, off) { return list.map(function (q) { return R(mat || 'gloss', ell(q[0], q[1], r, r, 6), { off: off || 0.006 }); }); }

  /** mats row: base material for every column, with overrides {col: mat} */
  function row(n, base, o) { var r = []; for (var i = 0; i < n; i++) r.push(o && o[i] ? o[i] : base); return r; }
  function rows(list) { return list.map(function (q) { return row(10, 'paint', q); }); }
  /** door mirror: housing prism + foot */
  function mirrorPart(x0, x1, y0, y1, z0, z1, footZ) {
    return [
      prism('mirror', z0, z1, [[x0, y0], [x1, y0 + 0.01], [x1 - 0.015, y1], [x0 - 0.03, y1 - 0.01]]),
      box('black', [x0 - 0.05, y0 + 0.01, footZ], [0.08, 0.035, 0.12], true)
    ];
  }
  /** roadster seat (cushion + back + headrest) at x (front of the cushion), z centre */
  function seat(x, z, floorY, mat) {
    var m = mat || 'interior';
    return [
      box(m, [x - 0.24, floorY + 0.07, z], [0.46, 0.13, 0.44], true),
      prism(m, z - 0.22, z + 0.22, [[x - 0.40, floorY + 0.10], [x - 0.50, floorY + 0.10], [x - 0.62, floorY + 0.64], [x - 0.52, floorY + 0.66]]),
      prism(m, z - 0.12, z + 0.12, [[x - 0.56, floorY + 0.66], [x - 0.65, floorY + 0.66], [x - 0.68, floorY + 0.82], [x - 0.59, floorY + 0.84]])
    ];
  }
  /** windscreen cabin shell for a roadster: base x/y, header x/y, half widths at base and header */
  function screen(xb, yb, zb, xh, yh, zh, frame) {
    var f = frame || 'black', fz = 0.045;
    return {
      stations: [
        { x: xb, pts: [[yb - 0.01, zb + 0.01], [yb, zb], [yb + 0.002, zb - fz], [yb + 0.004, zb * 0.5], [yb + 0.004, 0]] },
        { x: xb - 0.03, pts: [[yb - 0.025, zb + 0.012], [yb + 0.03, zb - 0.005], [yb + 0.032, zb - fz], [yb + 0.035, zb * 0.5], [yb + 0.035, 0]] },
        { x: xh + 0.035, pts: [[yh - 0.075, zh + 0.014], [yh - 0.02, zh], [yh - 0.035, zh - fz], [yh - 0.03, zh * 0.5], [yh - 0.028, 0]] },
        { x: xh, pts: [[yh - 0.07, zh + 0.01], [yh, zh - 0.005], [yh + 0.002, zh - fz], [yh + 0.004, zh * 0.5], [yh + 0.004, 0]] },
        { x: xh - 0.035, pts: [[yh - 0.06, zh], [yh - 0.04, zh - 0.01], [yh - 0.035, zh - fz], [yh - 0.032, zh * 0.5], [yh - 0.03, 0]] }
      ],
      mats: [
        [f, f, f, f],
        [f, f, 'glass', 'glass'],
        [f, f, f, f],
        [f, f, f, f]
      ],
      capF: f, capR: f, wells: false
    };
  }

  /* ================================================================ VW Golf GTI (Mk8, 2020–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Volkswagen_Golf_Mk8):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Volkswagen_Golf_VIII_GTI_IMG_3604.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:VW_Golf_GTI_(VIII)_–_h_03012021.jpg
  //   front/rear 3/4 (Clubsport): https://commons.wikimedia.org/wiki/File:VW_Golf_VIII_GTI_Clubsport.jpg ,
  //              https://commons.wikimedia.org/wiki/File:VW_Golf_VIII_GTI_Clubsport_Heck.jpg
  // Signature: low slim nose with ultra-thin LED lamps joined by a full-width light bar, minimal upper slot,
  // huge honeycomb lower intake with X-pattern fog clusters, crisp tornado shoulder line, thick forward-leaning
  // C-pillar, roof spoiler over a near-upright hatch, wide two-piece tail lamps, round tips each side.
  var GOLF = {
    body: {
      stations: [
        { x: 2.192, pts: [[0.30, 0], [0.30, 0.20], [0.32, 0.27], [0.38, 0.30], [0.48, 0.31], [0.55, 0.29], [0.585, 0.24], [0.598, 0.19], [0.603, 0.13], [0.605, 0.07], [0.606, 0]] },
        { x: 2.14, pts: [[0.22, 0], [0.22, 0.44], [0.26, 0.55], [0.36, 0.60], [0.52, 0.615], [0.62, 0.58], [0.67, 0.50], [0.685, 0.42], [0.692, 0.30], [0.697, 0.16], [0.70, 0]] },
        { x: 2.03, pts: [[0.195, 0], [0.20, 0.58], [0.25, 0.70], [0.38, 0.75], [0.58, 0.765], [0.71, 0.73], [0.75, 0.65], [0.765, 0.54], [0.77, 0.40], [0.774, 0.22], [0.776, 0]] },
        { x: 1.85, pts: [[0.186, 0], [0.19, 0.66], [0.25, 0.80], [0.42, 0.85], [0.64, 0.862], [0.765, 0.84], [0.79, 0.76], [0.795, 0.63], [0.798, 0.46], [0.80, 0.25], [0.80, 0]] },
        { x: 1.55, pts: [[0.172, 0], [0.17, 0.70], [0.24, 0.84], [0.45, 0.885], [0.68, 0.893], [0.80, 0.868], [0.83, 0.785], [0.835, 0.65], [0.838, 0.46], [0.84, 0.25], [0.84, 0]] },
        { x: 1.10, pts: [[0.15, 0], [0.15, 0.70], [0.24, 0.85], [0.45, 0.888], [0.70, 0.893], [0.86, 0.875], [0.89, 0.79], [0.895, 0.67], [0.90, 0.47], [0.903, 0.26], [0.905, 0]] },
        { x: 0.90, pts: [[0.14, 0], [0.14, 0.70], [0.24, 0.85], [0.45, 0.885], [0.70, 0.89], [0.90, 0.872], [0.955, 0.775], [0.966, 0.712], [0.968, 0.655], [0.97, 0.60], [0.968, 0]] },
        { x: 0.00, pts: [[0.135, 0], [0.135, 0.70], [0.24, 0.855], [0.45, 0.885], [0.70, 0.893], [0.92, 0.874], [0.995, 0.765], [1.005, 0.715], [1.36, 0.625], [1.395, 0.50], [1.41, 0]] },
        { x: -0.40, pts: [[0.135, 0], [0.135, 0.70], [0.24, 0.855], [0.45, 0.885], [0.70, 0.893], [0.925, 0.874], [1.0, 0.765], [1.01, 0.715], [1.375, 0.63], [1.435, 0.48], [1.457, 0]] },
        { x: -1.00, pts: [[0.14, 0], [0.14, 0.70], [0.24, 0.858], [0.45, 0.888], [0.70, 0.896], [0.93, 0.877], [1.01, 0.77], [1.028, 0.72], [1.35, 0.625], [1.412, 0.47], [1.432, 0]] },
        { x: -1.45, pts: [[0.172, 0], [0.172, 0.70], [0.24, 0.86], [0.45, 0.89], [0.72, 0.895], [0.935, 0.875], [1.03, 0.77], [1.055, 0.715], [1.13, 0.695], [1.385, 0.565], [1.41, 0]] },
        { x: -1.80, pts: [[0.20, 0], [0.20, 0.66], [0.26, 0.80], [0.45, 0.835], [0.72, 0.842], [0.93, 0.822], [1.035, 0.735], [1.065, 0.68], [1.29, 0.625], [1.36, 0.53], [1.383, 0]] },
        { x: -2.00, pts: [[0.24, 0], [0.245, 0.55], [0.29, 0.66], [0.45, 0.70], [0.70, 0.71], [0.90, 0.69], [0.99, 0.645], [1.03, 0.615], [1.035, 0.585], [1.042, 0.40], [1.045, 0]] },
        { x: -2.045, pts: [[0.27, 0], [0.28, 0.52], [0.31, 0.62], [0.45, 0.67], [0.70, 0.68], [0.88, 0.665], [0.96, 0.61], [0.99, 0.565], [1.0, 0.50], [1.005, 0.30], [1.005, 0]] },
        { x: -2.085, pts: [[0.33, 0], [0.34, 0.46], [0.36, 0.54], [0.46, 0.585], [0.62, 0.595], [0.72, 0.585], [0.77, 0.555], [0.79, 0.50], [0.80, 0.42], [0.80, 0.28], [0.80, 0]] },
        { x: -2.097, pts: [[0.37, 0], [0.37, 0.38], [0.39, 0.44], [0.46, 0.47], [0.55, 0.475], [0.60, 0.47], [0.62, 0.45], [0.63, 0.42], [0.635, 0.34], [0.64, 0.18], [0.64, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black' },                                   // nose cap
        { 0: 'black', 1: 'black' },                                   // bumper corners
        { 0: 'black', 1: 'black' },                                   // lamps -> fender
        { 0: 'black', 1: 'black' },                                   // front fender
        { 0: 'black', 1: 'black' },                                   // to the cowl
        { 0: 'black', 1: 'black', 8: 'gloss', 9: 'gloss' },           // cowl / wipers
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'glass' },           // windscreen, front door glass, A-pillar
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // front door glass / roof
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // rear door glass / roof
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // quarter glass / roof
        { 0: 'black', 1: 'black', 9: 'paint2' },                      // thick C-pillar / roof end
        { 0: 'black', 1: 'black', 8: 'paint2', 9: 'glass' },          // hatch glass between thick C-pillars
        { 0: 'black', 1: 'black' },                                   // tailgate shoulder (lamps)
        { 0: 'black', 1: 'black' },                                   // tailgate face, sloping under
        { 0: 'black', 1: 'black', 2: 'black' }                        // rear bumper
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // ultra-slim LED headlamps (wider + taller at the outer end), full-width LED light bar between them
      polys([[[0.46, 0.705], [0.70, 0.705], [0.875, 0.722], [0.885, 0.785], [0.74, 0.79], [0.56, 0.765], [0.46, 0.742]]], 'front', 'gloss', 0.004, true),
      polys([[[0.50, 0.712], [0.84, 0.728], [0.862, 0.772], [0.62, 0.766], [0.50, 0.738]]], 'front', 'light', 0.008, true),
      polys([[[0.52, 0.718], [0.84, 0.732], [0.845, 0.742], [0.52, 0.728]]], 'front', 'drl', 0.011, true),
      polys([rect(-0.47, 0.722, 0.47, 0.73)], 'front', 'drl', 0.008, false),
      // upper slot grille under the light bar (no emblem: text badges only)
      polys([[[-0.50, 0.66], [0.50, 0.66], [0.47, 0.716], [-0.47, 0.716]]], 'front', 'gloss', 0.004, false),
      // full-width honeycomb lower intake (trapezoid), X-pattern 5-LED fog clusters at the outer ends
      polys([[[-0.70, 0.20], [0.70, 0.20], [0.76, 0.43], [0.62, 0.45], [-0.62, 0.45], [-0.76, 0.43]]], 'front', 'grille', 0.004, false),
      polys([[[0.45, 0.47], [0.77, 0.44], [0.80, 0.475], [0.47, 0.50]]], 'front', 'gloss', 0.004, true),
      polys([[[0.635, 0.36], [0.67, 0.33], [0.635, 0.30], [0.60, 0.33]]], 'front', 'drl', 0.008, true),
      polys([rect(-0.26, 0.255, 0.26, 0.365)], 'front', 'plate', 0.008, false),
      // rear: two-piece wedge tail lamps split by the tailgate shut line: dark red lens with an upper LED bar, a lower
      // bar and the outer upright joining them (C graphic), clear reverse lamp at the inner (tailgate) end
      polys([[[0.30, 0.89], [0.78, 0.872], [0.93, 0.905], [0.92, 1.01], [0.70, 1.035], [0.30, 1.012]]], 'rear', 'lens', 0.008, true),
      [
        R('tail', [[0.31, 0.975], [0.70, 0.998], [0.915, 0.978], [0.915, 0.995], [0.70, 1.016], [0.31, 0.993]], { off: 0.012 }),
        R('tail', [[0.36, 0.918], [0.78, 0.899], [0.92, 0.922], [0.92, 0.938], [0.78, 0.915], [0.36, 0.934]], { off: 0.012 }),
        R('tail', [[0.895, 0.925], [0.922, 0.925], [0.918, 0.99], [0.893, 0.99]], { off: 0.013 }),
        R('rev', rect(0.34, 0.95, 0.44, 0.96), { off: 0.012 }),
        R('black', rect(0.598, 0.874, 0.605, 1.034), { off: 0.015 }),
        // low LOD: the same wedge lamp, one flat polygon per side
        R('tail', [[0.30, 0.89], [0.78, 0.872], [0.84, 0.89], [0.84, 1.0], [0.70, 1.03], [0.30, 1.012]], { off: 0.012, low: 'only', tilt: 55 })
      ],
      polys([[[-1.76, 0.905], [-1.95, 0.885], [-2.04, 0.90], [-2.04, 1.0], [-1.84, 1.012]]], 'side', 'tail', 0.009, true),
      [TX('GTI', 0, 0.855, 0.034, 'chrome')],
      // tailgate shut lines (beside the glass, through the lamps, across above the bumper)
      [
        R('gloss', rect(0.596, 0.74, 0.606, 0.874), { off: 0.006 }),
        R('gloss', [[0.585, 1.034], [0.597, 1.034], [0.545, 1.36], [0.533, 1.36]], { off: 0.006 }),
        R('gloss', rect(-0.606, 0.735, 0.606, 0.745), { off: 0.006, m: false })
      ],
      plate(0.55, 0.66, 0.26),
      polys([rect(-0.90, 0.18, 0.90, 0.44)], 'rear', 'gloss', 0.004, false),
      // bumper: low rear-fog / reflector strips, slim side reflectors, parking sensors, honeycomb diffuser insert
      polys([rect(0.55, 0.40, 0.78, 0.42)], 'rear', 'lens', 0.007, true),
      [R('lens', rect(0.66, 0.605, 0.86, 0.62), { off: 0.007 }), R('grille', rect(-0.50, 0.24, 0.50, 0.34), { off: 0.007, m: false })],
      dots([[0.40, 0.70], [0.54, 0.69]], 0.014, 'gloss', 0.006),
      // hatch glass: defroster lines, third brake lamp under the roof spoiler, rear wiper
      hlines([1.13, 1.17, 1.21, 1.25], -0.34, 0.34, 0.003, 'lens', 0.004),
      [R('tail', rect(-0.22, 1.335, 0.22, 1.35), { off: 0.006, m: false })],
      wiper(0.0, 1.075, 0.40, 14),
      // side: gloss-black B-pillar, door handles, side-skirt blade
      polys([rect(-0.36, 1.01, -0.29, 1.37)], 'side', 'gloss', 0.004, true),
      polys([[[-1.37, 1.04], [-1.30, 1.04], [-1.28, 1.34], [-1.33, 1.34]]], 'side', 'gloss', 0.004, true),
      polys([rect(0.15, 0.935, 0.30, 0.958), rect(-0.78, 0.94, -0.63, 0.963)], 'side', 'black', 0.004, true),
      [
        // roof spoiler over the hatch glass, black side fins at its ends
        prism('paint', 0.0, 0.50, [[-1.72, 1.395], [-1.90, 1.378], [-1.92, 1.358], [-1.78, 1.37]]),
        prism('gloss', 0.50, 0.53, [[-1.74, 1.39], [-1.92, 1.372], [-1.90, 1.30], [-1.80, 1.33]])
      ],
      mirrorPart(0.62, 0.38, 1.04, 1.14, 0.76, 0.99, 0.74)
    ),
    // one round tip at each corner of the diffuser
    exhaust: [{ cx: 0.56, cy: 0.28, w: 0.09, h: 0.09, shape: 'round', mirror: true }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'VW Golf GTI (Mk8) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Volkswagen_Golf_VIII_GTI_IMG_3604.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:VW_Golf_GTI_(VIII)_–_h_03012021.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:VW_Golf_VIII_GTI_Clubsport.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:VW_Golf_VIII_GTI_Clubsport_Heck.jpg (rear 3/4). Rear detail: ' +
      'https://commons.wikimedia.org/wiki/File:2020_Volkswagen_Golf_GTi_TSi_S-A_2.0_Rear.jpg , ' +
      'https://commons.wikimedia.org/wiki/File:2022_Volkswagen_Golf_GTI_in_Oryx_White_Pearl,_Rear_Left,_04-24-2022.jpg (rear 3/4s).'
  };
  reg('vw-golf-gti-mk8', GOLF);

  /* ================================================================ Honda Civic Type R (FL5, 2022–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Honda_Civic_Type_R):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2023_Honda_Civic_Type_R,_front_4.18.25.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2024_Honda_Civic_Type_R,_rear_right,_06-15-2024.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2024_Honda_Civic_Type_R,_front_right,_06-15-2024.jpg
  // Signature: long low five-door fastback, wide flared arches, black honeycomb grille band with the red H,
  // slim lamps, bonnet scoop, gloss-black swan-free pedestal wing over the hatch, triple centre exhaust in a
  // big black diffuser, black rear-corner vents and side skirts.
  var CIVIC = {
    body: {
      stations: [
        { x: 2.355, pts: [[0.37, 0], [0.37, 0.18], [0.38, 0.22], [0.42, 0.24], [0.50, 0.245], [0.545, 0.225], [0.555, 0.19], [0.558, 0.14], [0.56, 0.10], [0.56, 0.05], [0.56, 0]] },
        { x: 2.30, pts: [[0.25, 0], [0.25, 0.45], [0.28, 0.56], [0.38, 0.62], [0.55, 0.635], [0.66, 0.60], [0.70, 0.52], [0.715, 0.42], [0.72, 0.30], [0.725, 0.16], [0.73, 0]] },
        { x: 2.20, pts: [[0.17, 0], [0.17, 0.62], [0.22, 0.75], [0.40, 0.81], [0.60, 0.82], [0.73, 0.79], [0.775, 0.70], [0.785, 0.56], [0.788, 0.40], [0.789, 0.22], [0.79, 0]] },
        { x: 2.00, pts: [[0.16, 0], [0.16, 0.72], [0.21, 0.85], [0.40, 0.895], [0.62, 0.90], [0.76, 0.87], [0.795, 0.78], [0.80, 0.64], [0.803, 0.46], [0.805, 0.25], [0.805, 0]] },
        { x: 1.70, pts: [[0.147, 0], [0.147, 0.75], [0.20, 0.89], [0.40, 0.935], [0.62, 0.94], [0.78, 0.905], [0.815, 0.80], [0.82, 0.66], [0.823, 0.47], [0.825, 0.25], [0.825, 0]] },
        { x: 1.20, pts: [[0.14, 0], [0.14, 0.75], [0.20, 0.89], [0.40, 0.94], [0.62, 0.945], [0.84, 0.915], [0.87, 0.82], [0.878, 0.68], [0.882, 0.48], [0.885, 0.25], [0.886, 0]] },
        { x: 0.95, pts: [[0.13, 0], [0.13, 0.75], [0.20, 0.885], [0.40, 0.93], [0.62, 0.932], [0.87, 0.90], [0.925, 0.79], [0.935, 0.725], [0.94, 0.665], [0.942, 0.60], [0.94, 0]] },
        { x: 0.10, pts: [[0.125, 0], [0.125, 0.75], [0.20, 0.875], [0.40, 0.91], [0.62, 0.912], [0.84, 0.89], [0.94, 0.79], [0.955, 0.735], [1.33, 0.605], [1.365, 0.47], [1.38, 0]] },
        { x: -0.50, pts: [[0.125, 0], [0.125, 0.75], [0.20, 0.875], [0.40, 0.915], [0.62, 0.918], [0.84, 0.895], [0.955, 0.79], [0.966, 0.735], [1.36, 0.595], [1.392, 0.46], [1.405, 0]] },
        { x: -1.00, pts: [[0.13, 0], [0.13, 0.75], [0.20, 0.885], [0.40, 0.93], [0.62, 0.932], [0.84, 0.905], [0.965, 0.79], [0.976, 0.735], [1.35, 0.585], [1.38, 0.45], [1.392, 0]] },
        { x: -1.35, pts: [[0.145, 0], [0.145, 0.75], [0.20, 0.89], [0.40, 0.94], [0.62, 0.944], [0.86, 0.91], [0.985, 0.79], [0.992, 0.725], [1.29, 0.57], [1.322, 0.44], [1.335, 0]] },
        { x: -1.70, pts: [[0.165, 0], [0.165, 0.72], [0.21, 0.85], [0.40, 0.90], [0.62, 0.909], [0.84, 0.88], [0.99, 0.76], [1.04, 0.68], [1.19, 0.56], [1.215, 0.42], [1.227, 0]] },
        { x: -1.99, pts: [[0.19, 0], [0.19, 0.62], [0.24, 0.73], [0.42, 0.775], [0.62, 0.78], [0.82, 0.755], [0.98, 0.665], [1.08, 0.60], [1.10, 0.55], [1.11, 0.40], [1.115, 0]] },
        { x: -2.08, pts: [[0.21, 0], [0.21, 0.54], [0.26, 0.64], [0.42, 0.68], [0.62, 0.69], [0.80, 0.67], [0.95, 0.60], [1.05, 0.54], [1.07, 0.48], [1.075, 0.32], [1.08, 0]] },
        { x: -2.20, pts: [[0.27, 0], [0.27, 0.44], [0.30, 0.52], [0.42, 0.55], [0.62, 0.555], [0.78, 0.54], [0.88, 0.49], [0.92, 0.44], [0.93, 0.36], [0.932, 0.24], [0.935, 0]] },
        { x: -2.234, pts: [[0.38, 0], [0.38, 0.30], [0.40, 0.34], [0.48, 0.36], [0.62, 0.365], [0.72, 0.35], [0.78, 0.32], [0.80, 0.27], [0.81, 0.20], [0.815, 0.10], [0.82, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black' },                                   // nose
        { 0: 'black', 1: 'black' },                                   // bumper
        { 0: 'black', 1: 'black' },                                   // lamps
        { 0: 'black', 1: 'black' },                                   // front fender
        { 0: 'black', 1: 'black' },                                   // bonnet (scoop)
        { 0: 'black', 1: 'black', 8: 'gloss', 9: 'gloss' },           // cowl
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'glass' },           // windscreen
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // front door glass / roof
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // rear door glass / roof
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // roof end
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'glass' },           // fastback rear screen + quarter glass
        { 0: 'black', 1: 'black', 9: 'glass' },                       // rear screen
        { 0: 'black', 1: 'black' },                                   // hatch lip
        { 0: 'black', 1: 'black', 2: 'black' },                       // tail
        { 0: 'black', 1: 'black', 2: 'black', 3: 'black' }            // diffuser
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // slim headlamps with the DRL line along the top
      polys([[[0.46, 0.70], [0.78, 0.672], [0.915, 0.70], [0.91, 0.765], [0.56, 0.772], [0.46, 0.735]]], 'front', 'gloss', 0.004, true),
      polys([[[0.52, 0.705], [0.80, 0.685], [0.89, 0.71], [0.885, 0.745], [0.56, 0.75]]], 'front', 'light', 0.008, true),
      polys([[[0.50, 0.752], [0.90, 0.745], [0.905, 0.758], [0.52, 0.765]]], 'front', 'drl', 0.011, true),
      // black honeycomb upper grille band (no emblem: text badges only), big lower grille, vertical corner intakes
      polys([[[-0.47, 0.53], [0.47, 0.53], [0.50, 0.66], [0.45, 0.70], [-0.45, 0.70], [-0.50, 0.66]]], 'front', 'grille', 0.004, false),
      polys([[[-0.62, 0.20], [0.62, 0.20], [0.66, 0.48], [0.58, 0.50], [-0.58, 0.50], [-0.66, 0.48]]], 'front', 'grille', 0.004, false),
      polys([[[0.71, 0.24], [0.88, 0.26], [0.86, 0.56], [0.74, 0.52]]], 'front', 'grille', 0.004, true),
      polys([rect(-0.26, 0.30, 0.26, 0.41)], 'front', 'plate', 0.008, false),
      // bonnet scoop
      polys([rect(1.32, -0.20, 1.72, 0.20)], 'top', 'black', 0.006, false),
      // rear: slim wrap-around tail lamps, H badge, plate, diffuser with corner vents
      polys([[[0.40, 0.915], [0.82, 0.895], [0.93, 0.91], [0.92, 0.965], [0.62, 0.99], [0.40, 0.975]]], 'rear', 'gloss', 0.005, true),
      // smoked lens with the red light guide: top line joined across the hatch by the full-width bar, lower line,
      // solid outer block; clear reverse lamp inside
      polys([[[0.42, 0.925], [0.82, 0.905], [0.91, 0.918], [0.90, 0.95], [0.62, 0.975], [0.42, 0.962]]], 'rear', 'smoke', 0.008, true),
      [
        R('tail', [[0.42, 0.952], [0.62, 0.965], [0.90, 0.940], [0.90, 0.952], [0.62, 0.977], [0.42, 0.964]], { off: 0.012 }),
        R('tail', [[0.42, 0.926], [0.80, 0.907], [0.80, 0.918], [0.42, 0.937]], { off: 0.012 }),
        R('tail', [[0.78, 0.909], [0.91, 0.919], [0.902, 0.948], [0.78, 0.958]], { off: 0.012 }),
        R('rev', rect(0.52, 0.938, 0.62, 0.947), { off: 0.012 }),
        R('tail', [[0.40, 0.915], [0.80, 0.897], [0.84, 0.91], [0.84, 0.96], [0.62, 0.99], [0.40, 0.975]], { off: 0.012, low: 'only', tilt: 55 }),
        R('tail', rect(-0.42, 0.952, 0.42, 0.968), { off: 0.012, m: false, low: 'only', tilt: 55 })
      ],
      polys([rect(-0.42, 0.955, 0.42, 0.965)], 'rear', 'tail', 0.009, false),
      polys([[[-1.96, 0.905], [-2.10, 0.89], [-2.15, 0.93], [-2.12, 0.99], [-1.98, 0.995]]], 'side', 'tail', 0.007, true),
      [TX('CIVIC', -0.44, 0.71, 0.03, 'chrome'), TX('TYPE R', 0.44, 0.71, 0.026, 'chrome')],
      plate(0.60, 0.72, 0.26),
      // hatch shut lines
      [R('gloss', rect(0.776, 0.55, 0.786, 0.90), { off: 0.006 }), R('gloss', rect(-0.786, 0.545, 0.786, 0.555), { off: 0.006, m: false })],
      polys([rect(-0.90, 0.17, 0.90, 0.42)], 'rear', 'gloss', 0.004, false),
      polys([[[0.76, 0.28], [0.90, 0.30], [0.92, 0.58], [0.80, 0.55]]], 'rear', 'black', 0.006, true),
      // vertical red reflectors inside the corner vents, parking sensors, roof-edge third brake lamp
      [R('lens', [[0.835, 0.33], [0.86, 0.335], [0.875, 0.52], [0.85, 0.515]], { off: 0.01 })],
      dots([[0.30, 0.47], [0.55, 0.46]], 0.014, 'gloss', 0.006),
      [R('tail', rect(-0.16, 1.318, 0.16, 1.33), { off: 0.006, m: false })],
      // side: door handles
      polys([rect(0.20, 0.885, 0.34, 0.905), rect(-0.84, 0.895, -0.70, 0.915)], 'side', 'black', 0.004, true),
      [
        // gloss-black pedestal wing over the hatch lip
        prism('gloss', 0.0, 0.64, [[-1.99, 1.29], [-2.22, 1.28], [-2.23, 1.262], [-2.01, 1.268]]),
        prism('gloss', 0.64, 0.655, [[-1.98, 1.305], [-2.24, 1.295], [-2.25, 1.22], [-2.09, 1.22]]),
        prism('gloss', 0.36, 0.385, [[-2.03, 1.27], [-2.10, 1.27], [-2.07, 1.07], [-2.01, 1.08]]),
        // gurney lip on the wing's trailing edge
        prism('gloss', 0.0, 0.64, [[-2.215, 1.282], [-2.235, 1.281], [-2.237, 1.30], [-2.225, 1.30]]),
        // big diffuser: vertical strakes either side of the triple tips
        box('gloss', [-2.18, 0.30, 0.27], [0.10, 0.07, 0.014], true),
        box('gloss', [-2.17, 0.295, 0.44], [0.10, 0.065, 0.014], true),
        box('gloss', [-2.16, 0.29, 0.60], [0.10, 0.06, 0.014], true),
        // side skirts
        box('black', [0.0, 0.19, 0.855], [2.0, 0.06, 0.08], true)
      ],
      mirrorPart(0.68, 0.44, 1.00, 1.10, 0.76, 1.00, 0.76)
    ),
    // triple centre exhaust: a bigger middle tip flanked by two smaller ones
    exhaust: [{ cx: 0, cy: 0.30, w: 0.10, h: 0.10, shape: 'round' }, { cx: 0.135, cy: 0.29, w: 0.085, h: 0.085, shape: 'round', mirror: true }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'Honda Civic Type R (FL5) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2023_Honda_Civic_Type_R,_front_4.18.25.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2024_Honda_Civic_Type_R,_rear_right,_06-15-2024.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2024_Honda_Civic_Type_R,_front_right,_06-15-2024.jpg (front 3/4). Rear detail: ' +
      'https://commons.wikimedia.org/wiki/File:Honda_Civic_Type_R_(FL5)_Rear_View.jpg , ' +
      'https://commons.wikimedia.org/wiki/File:2024_Honda_Civic_Type_R_FL5_in_Championship_White,_rear_left,_06-30-2024.jpg (rear 3/4s).'
  };
  reg('honda-civic-type-r-fl5', CIVIC);

  /* ================================================================ Toyota GR Yaris (GXPA16, 2020–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Toyota_GR_Yaris):
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Toyota_GR_Yaris_RZ_1X7A7166.jpg
  //   rear:      https://commons.wikimedia.org/wiki/File:The_rearview_of_Toyota_GR_YARIS_RS_(5BA-MXPA12-AGXXB).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Toyota_GR_Yaris_(XP21)_–_f_03052021.jpg
  // Signature: stubby three-door with a roof that drops ~15 cm toward the rear, short side glass, huge rear
  // haunches with a shoulder shelf, giant black mesh grille filling the fascia with corner vents, slim lamps,
  // gloss-black tailgate band joining the tail lamps, roof spoiler, black (carbon) roof.
  var YARIS = {
    body: {
      stations: [
        { x: 2.115, pts: [[0.29, 0], [0.29, 0.20], [0.31, 0.25], [0.40, 0.28], [0.52, 0.285], [0.59, 0.26], [0.615, 0.21], [0.62, 0.16], [0.622, 0.10], [0.624, 0.05], [0.625, 0]] },
        { x: 2.06, pts: [[0.24, 0], [0.24, 0.47], [0.27, 0.58], [0.40, 0.63], [0.58, 0.645], [0.69, 0.61], [0.735, 0.54], [0.75, 0.43], [0.755, 0.30], [0.76, 0.16], [0.762, 0]] },
        { x: 1.96, pts: [[0.222, 0], [0.222, 0.62], [0.26, 0.72], [0.40, 0.76], [0.60, 0.76], [0.74, 0.72], [0.785, 0.64], [0.795, 0.51], [0.80, 0.36], [0.80, 0.20], [0.801, 0]] },
        { x: 1.75, pts: [[0.205, 0], [0.205, 0.70], [0.25, 0.82], [0.42, 0.855], [0.64, 0.858], [0.79, 0.825], [0.83, 0.74], [0.838, 0.60], [0.84, 0.44], [0.842, 0.24], [0.842, 0]] },
        { x: 1.40, pts: [[0.18, 0], [0.18, 0.72], [0.24, 0.86], [0.42, 0.885], [0.66, 0.886], [0.86, 0.86], [0.895, 0.77], [0.90, 0.62], [0.902, 0.45], [0.904, 0.25], [0.905, 0]] },
        { x: 1.06, pts: [[0.155, 0], [0.155, 0.72], [0.24, 0.85], [0.42, 0.876], [0.68, 0.877], [0.92, 0.85], [0.98, 0.74], [0.99, 0.665], [0.995, 0.615], [0.997, 0.55], [0.998, 0]] },
        { x: 0.15, pts: [[0.124, 0], [0.124, 0.70], [0.22, 0.81], [0.42, 0.84], [0.68, 0.845], [0.92, 0.82], [1.0, 0.70], [1.012, 0.655], [1.40, 0.57], [1.43, 0.42], [1.44, 0]] },
        { x: -0.30, pts: [[0.124, 0], [0.124, 0.70], [0.22, 0.815], [0.42, 0.845], [0.68, 0.85], [0.93, 0.826], [1.005, 0.70], [1.016, 0.65], [1.425, 0.555], [1.445, 0.40], [1.452, 0]] },
        { x: -0.90, pts: [[0.13, 0], [0.13, 0.72], [0.22, 0.86], [0.42, 0.895], [0.68, 0.905], [0.95, 0.885], [1.03, 0.73], [1.08, 0.62], [1.21, 0.595], [1.37, 0.40], [1.386, 0]] },
        { x: -1.25, pts: [[0.18, 0], [0.18, 0.75], [0.24, 0.885], [0.42, 0.915], [0.70, 0.922], [0.97, 0.905], [1.02, 0.74], [1.06, 0.615], [1.19, 0.575], [1.322, 0.40], [1.334, 0]] },
        { x: -1.49, pts: [[0.205, 0], [0.205, 0.73], [0.25, 0.865], [0.42, 0.905], [0.70, 0.91], [0.95, 0.885], [1.01, 0.735], [1.05, 0.59], [1.20, 0.55], [1.29, 0.38], [1.306, 0]] },
        { x: -1.68, pts: [[0.225, 0], [0.225, 0.66], [0.26, 0.79], [0.42, 0.835], [0.70, 0.845], [0.92, 0.815], [0.99, 0.70], [1.04, 0.575], [1.07, 0.53], [1.08, 0.36], [1.085, 0]] },
        { x: -1.80, pts: [[0.25, 0], [0.25, 0.54], [0.28, 0.64], [0.42, 0.68], [0.70, 0.69], [0.90, 0.67], [0.96, 0.60], [0.99, 0.52], [1.0, 0.45], [1.0, 0.30], [1.0, 0]] },
        { x: -1.882, pts: [[0.33, 0], [0.33, 0.36], [0.35, 0.41], [0.45, 0.43], [0.62, 0.435], [0.75, 0.42], [0.82, 0.39], [0.85, 0.34], [0.86, 0.26], [0.866, 0.14], [0.869, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black' },                                   // nose
        { 0: 'black', 1: 'black' },                                   // bumper
        { 0: 'black', 1: 'black' },                                   // lamps
        { 0: 'black', 1: 'black' },                                   // fender
        { 0: 'black', 1: 'black' },                                   // bonnet
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'glass' },           // windscreen
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // door glass / (carbon) roof
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // door glass / roof
        { 0: 'black', 1: 'black', 7: 'glass', 9: 'paint2' },          // quarter glass tip / roof drop
        { 0: 'black', 1: 'black', 9: 'paint2' },                      // C-pillar / roof end
        { 0: 'black', 1: 'black', 8: 'glass', 9: 'glass' },           // rear screen
        { 0: 'black', 1: 'black', 7: 'gloss', 8: 'gloss', 9: 'gloss' },  // gloss-black tailgate band
        { 0: 'black', 1: 'black', 2: 'black' }                        // rear bumper
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // slim lamps over a giant black mesh grille that fills the fascia, corner vents
      polys([[[0.42, 0.68], [0.70, 0.66], [0.87, 0.70], [0.86, 0.79], [0.66, 0.79], [0.42, 0.72]]], 'front', 'gloss', 0.004, true),
      polys([[[0.48, 0.69], [0.70, 0.675], [0.84, 0.705], [0.835, 0.765], [0.62, 0.77], [0.48, 0.715]]], 'front', 'light', 0.008, true),
      polys([[[0.58, 0.70], [0.82, 0.71], [0.80, 0.722], [0.58, 0.712]]], 'front', 'drl', 0.011, true),
      polys([[[-0.55, 0.20], [0.55, 0.20], [0.58, 0.42], [0.52, 0.61], [-0.52, 0.61], [-0.58, 0.42]]], 'front', 'grille', 0.004, false),
      polys([[[0.67, 0.24], [0.87, 0.27], [0.88, 0.60], [0.74, 0.60], [0.67, 0.44]]], 'front', 'gloss', 0.004, true),
      polys([[[0.71, 0.30], [0.84, 0.32], [0.85, 0.52], [0.73, 0.46]]], 'front', 'grille', 0.008, true),
      polys([[[-0.44, 0.63], [0.44, 0.63], [0.52, 0.70], [-0.52, 0.70]]], 'front', 'gloss', 0.005, false),
      polys([rect(-0.26, 0.30, 0.26, 0.41)], 'front', 'plate', 0.008, false),
      // rear: tail lamps joined by the gloss tailgate band, plate, lower bumper diffuser, quad-vane spoiler
      // boomerang lamps: smoked lens, red light guide along the top and a lower stroke pointing inward, outer block
      polys([[[0.44, 0.905], [0.76, 0.885], [0.87, 0.93], [0.85, 1.02], [0.62, 1.0], [0.44, 0.95]]], 'rear', 'lens', 0.009, true),
      polys([[[-1.815, 1.0], [-1.60, 0.992], [-1.40, 0.977], [-1.24, 0.962], [-1.40, 0.922], [-1.60, 0.872], [-1.77, 0.846], [-1.852, 0.852]]], 'side', 'tail', 0.008, true),
      // headlamps sweep a long way back along the front fenders
      polys([[[1.42, 0.89], [1.70, 0.852], [1.90, 0.808], [1.99, 0.782], [1.996, 0.748], [1.90, 0.738], [1.70, 0.782], [1.46, 0.862]]], 'side', 'gloss', 0.006, true),
      polys([[[1.55, 0.865], [1.72, 0.84], [1.90, 0.80], [1.97, 0.78], [1.97, 0.76], [1.90, 0.755], [1.70, 0.795], [1.56, 0.85]]], 'side', 'light', 0.009, true),
      // gloss B-pillar between the door glass and the pointed quarter window
      polys([[[-0.385, 1.03], [-0.56, 1.03], [-0.56, 1.33], [-0.385, 1.41]]], 'side', 'gloss', 0.005, true),
      polys([[[-0.72, 0.90], [0.72, 0.90], [0.80, 0.98], [0.70, 1.10], [-0.70, 1.10], [-0.80, 0.98]]], 'rear', 'gloss', 0.005, false),
      [
        R('tail', [[0.44, 0.925], [0.62, 0.962], [0.85, 0.982], [0.85, 1.018], [0.62, 0.998], [0.44, 0.955]], { off: 0.013 }),
        R('tail', [[0.56, 0.922], [0.76, 0.886], [0.87, 0.93], [0.862, 0.958], [0.76, 0.918], [0.56, 0.95]], { off: 0.013 }),
        R('tail', [[0.74, 0.915], [0.868, 0.935], [0.855, 0.995], [0.74, 0.975]], { off: 0.013 }),
        R('rev', rect(0.48, 0.917, 0.55, 0.926), { off: 0.013 }),
        R('tail', [[0.44, 0.905], [0.72, 0.888], [0.78, 0.91], [0.78, 1.0], [0.62, 0.995], [0.44, 0.95]], { off: 0.013, low: 'only', tilt: 55 })
      ],
      [TX('GR YARIS', 0.27, 0.955, 0.024, 'chrome'), TX('GR-FOUR', 0.40, 0.80, 0.02, 'chrome')],
      plate(0.74, 0.85, 0.26, { off: 0.007 }),
      // tailgate shut lines down the band ends and across above the bumper
      [R('gloss', rect(0.66, 0.69, 0.67, 0.90), { off: 0.006 }), R('gloss', rect(-0.67, 0.685, 0.67, 0.695), { off: 0.006, m: false })],
      polys([[[-0.86, 0.18], [0.86, 0.18], [0.90, 0.40], [0.62, 0.46], [-0.62, 0.46], [-0.90, 0.40]]], 'rear', 'gloss', 0.004, false),
      polys([rect(0.66, 0.47, 0.86, 0.50)], 'rear', 'lens', 0.006, true),
      // horizontal mesh strip across the lower bumper, parking sensors
      [R('grille', rect(-0.42, 0.25, 0.42, 0.31), { off: 0.007, m: false }), R('black', rect(-0.40, 0.262, 0.40, 0.268), { off: 0.009, m: false }), R('black', rect(-0.40, 0.29, 0.40, 0.296), { off: 0.009, m: false })],
      dots([[0.36, 0.55], [0.56, 0.54]], 0.011, 'gloss', 0.006),
      // rear glass: defroster lines, third brake lamp under the spoiler, rear wiper
      hlines([1.13, 1.17, 1.21, 1.245], -0.36, 0.36, 0.004, 'lens', 0.004),
      [R('tail', rect(-0.18, 1.262, 0.18, 1.275), { off: 0.006, m: false })],
      wiper(0.0, 1.095, 0.36, 12),
      // side: door handle, fuel flap
      polys([rect(-0.30, 0.90, -0.16, 0.92)], 'side', 'black', 0.004, true),
      flare(-1.28, 0.32, 0.37, 0.44, 0.84, 0.925, 'paint', 5, 0.15, Math.PI - 0.15),
      [
        // roof spoiler
        prism('gloss', 0.0, 0.46, [[-1.44, 1.315], [-1.70, 1.30], [-1.72, 1.27], [-1.52, 1.285]]),
        // spoiler side blades
        prism('gloss', 0.46, 0.49, [[-1.46, 1.315], [-1.72, 1.295], [-1.70, 1.20], [-1.60, 1.23]])
      ],
      mirrorPart(0.88, 0.62, 1.05, 1.15, 0.70, 0.95, 0.70)
    ),
    // one round tip at each end of the bumper
    exhaust: [{ cx: 0.53, cy: 0.27, w: 0.095, h: 0.095, shape: 'round', mirror: true }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'Toyota GR Yaris — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_GR_Yaris_RZ_1X7A7166.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:The_rearview_of_Toyota_GR_YARIS_RS_(5BA-MXPA12-AGXXB).jpg (rear), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_GR_Yaris_(XP21)_–_f_03052021.jpg (front 3/4). Rear detail: ' +
      'https://commons.wikimedia.org/wiki/File:2020_Toyota_GR_Yaris_(rear).jpg , https://commons.wikimedia.org/wiki/File:2024_Toyota_GR_Yaris_RZ_GR-DAT_rear.jpg .'
  };
  reg('toyota-gr-yaris', YARIS);

  /* ================================================================ Toyota Sprinter Trueno GT-APEX (AE86, 1983–87) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Toyota_AE86):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:1983-1985_Toyota_Sprinter_Trueno_GT_Apex.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:1983-1985_Toyota_Sprinter_Trueno_GT_Apex_rear.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Toyota_Sprinter_Trueno_Black_Limited.jpg
  //   side:      https://commons.wikimedia.org/wiki/File:Toyota_E-AE86_Sprinter_Trueno_GT_APEX_(22092207238).jpg
  // Signature: boxy wedge three-door liftback, pop-up lamp lids on a sharp low nose, black slatted nose bar
  // with wide clear/amber parking lamps and TRUENO lettering, black urethane bumpers, two-tone with a black lower
  // body below the side moulding, thin pillars, long sloping hatch glass, wide ribbed tail lamps on a black panel.
  var AE86 = {
    body: {
      stations: [
        { x: 2.015, pts: [[0.32, 0], [0.32, 0.30], [0.33, 0.38], [0.38, 0.42], [0.44, 0.43], [0.475, 0.41], [0.485, 0.36], [0.49, 0.28], [0.49, 0.20], [0.49, 0.10], [0.49, 0]] },
        { x: 1.95, pts: [[0.24, 0], [0.24, 0.60], [0.26, 0.70], [0.42, 0.745], [0.50, 0.75], [0.56, 0.74], [0.585, 0.70], [0.595, 0.60], [0.60, 0.42], [0.60, 0.22], [0.60, 0]] },
        { x: 1.86, pts: [[0.20, 0], [0.20, 0.70], [0.23, 0.775], [0.42, 0.79], [0.55, 0.79], [0.625, 0.775], [0.64, 0.74], [0.645, 0.62], [0.645, 0.44], [0.645, 0.24], [0.645, 0]] },
        { x: 1.50, pts: [[0.205, 0], [0.205, 0.72], [0.24, 0.795], [0.50, 0.81], [0.62, 0.812], [0.68, 0.80], [0.705, 0.765], [0.712, 0.64], [0.712, 0.46], [0.712, 0.25], [0.712, 0]] },
        { x: 0.95, pts: [[0.195, 0], [0.195, 0.72], [0.24, 0.80], [0.50, 0.812], [0.64, 0.812], [0.73, 0.80], [0.77, 0.765], [0.785, 0.66], [0.79, 0.48], [0.79, 0.26], [0.79, 0]] },
        { x: 0.50, pts: [[0.195, 0], [0.195, 0.72], [0.24, 0.80], [0.50, 0.812], [0.64, 0.812], [0.76, 0.80], [0.83, 0.75], [0.875, 0.68], [0.88, 0.58], [0.882, 0.45], [0.882, 0]] },
        { x: -0.20, pts: [[0.195, 0], [0.195, 0.72], [0.24, 0.80], [0.50, 0.812], [0.64, 0.812], [0.76, 0.80], [0.84, 0.755], [0.895, 0.67], [1.295, 0.55], [1.318, 0.475], [1.328, 0]] },
        { x: -0.70, pts: [[0.195, 0], [0.195, 0.72], [0.24, 0.80], [0.50, 0.813], [0.64, 0.813], [0.76, 0.80], [0.845, 0.755], [0.91, 0.665], [1.30, 0.545], [1.325, 0.47], [1.333, 0]] },
        { x: -1.10, pts: [[0.20, 0], [0.20, 0.72], [0.24, 0.80], [0.50, 0.813], [0.64, 0.813], [0.76, 0.80], [0.85, 0.758], [0.935, 0.66], [1.262, 0.545], [1.282, 0.47], [1.288, 0]] },
        { x: -1.70, pts: [[0.20, 0], [0.20, 0.72], [0.24, 0.80], [0.50, 0.812], [0.64, 0.812], [0.76, 0.80], [0.86, 0.76], [1.03, 0.64], [1.09, 0.575], [1.11, 0.42], [1.115, 0]] },
        { x: -2.04, pts: [[0.20, 0], [0.20, 0.68], [0.24, 0.76], [0.50, 0.78], [0.64, 0.782], [0.76, 0.77], [0.85, 0.735], [0.95, 0.645], [0.98, 0.58], [0.99, 0.42], [0.992, 0]] },
        { x: -2.15, pts: [[0.30, 0], [0.30, 0.64], [0.32, 0.72], [0.50, 0.745], [0.64, 0.748], [0.74, 0.74], [0.80, 0.715], [0.86, 0.63], [0.88, 0.56], [0.885, 0.40], [0.887, 0]] },
        { x: -2.19, pts: [[0.42, 0], [0.42, 0.58], [0.43, 0.65], [0.50, 0.67], [0.64, 0.675], [0.70, 0.67], [0.76, 0.645], [0.82, 0.57], [0.83, 0.50], [0.835, 0.36], [0.836, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black', 2: 'black', 3: 'black' },           // black urethane front bumper
        { 0: 'black', 1: 'black', 2: 'black' },                       // nose (pop-up lids on top)
        { 0: 'black', 1: 'black', 2: 'black' },                       // front fender, black lower body
        { 0: 'black', 1: 'black', 2: 'black' },
        { 0: 'black', 1: 'black', 2: 'black' },                       // to the cowl
        { 0: 'black', 1: 'black', 2: 'black', 7: 'glass', 9: 'glass' },   // windscreen
        { 0: 'black', 1: 'black', 2: 'black', 7: 'glass', 9: 'paint2' },  // door glass / roof
        { 0: 'black', 1: 'black', 2: 'black', 7: 'glass', 9: 'paint2' },
        { 0: 'black', 1: 'black', 2: 'black', 7: 'glass', 9: 'glass' },   // quarter glass + liftback glass
        { 0: 'black', 1: 'black', 2: 'black', 9: 'glass' },               // liftback glass
        { 0: 'black', 1: 'black', 2: 'black' },                           // tail panel
        { 0: 'black', 1: 'black', 2: 'black', 3: 'black', 4: 'black', 5: 'black', 6: 'black', 7: 'black', 8: 'black', 9: 'black' }  // rear bumper
      ]),
      capF: 'black', capR: 'black'
    },
    parts: [].concat(
      // black slatted nose bar with wide clear/amber parking lamps and TRUENO lettering
      polys([rect(-0.80, 0.495, 0.80, 0.59)], 'front', 'gloss', 0.005, false),
      polys([rect(0.40, 0.505, 0.62, 0.58)], 'front', 'light', 0.009, true),
      polys([rect(0.62, 0.505, 0.79, 0.58)], 'front', 'indicator', 0.009, true),
      polys(word('TRUENO', 0, 0.545, 0.045, -1), 'front', 'badge', 0.009, false),
      polys([rect(-0.17, 0.33, 0.17, 0.43)], 'front', 'plate', 0.008, false),
      polys([rect(0.25, 0.36, 0.48, 0.385)], 'front', 'gloss', 0.008, true),
      polys([rect(0.56, 0.33, 0.74, 0.40)], 'front', 'indicator', 0.008, true),
      // pop-up headlamp lids (closed): shut lines on the nose
      polys([rect(1.66, 0.36, 1.68, 0.76), rect(1.66, 0.36, 1.93, 0.375), rect(1.66, 0.745, 1.93, 0.76)], 'top', 'gloss', 0.004, true),
      // rear: wide ribbed tail lamps on a black garnish panel, plate in the bumper
      polys([rect(-0.80, 0.68, 0.80, 0.865)], 'rear', 'gloss', 0.005, false),
      polys([[[0.34, 0.69], [0.80, 0.69], [0.82, 0.86], [0.34, 0.86]]], 'rear', 'tail', 0.008, true),
      // amber indicator across the top of the outer section, clear square reverse block in the middle
      polys([rect(0.62, 0.80, 0.82, 0.86)], 'rear', 'indicator', 0.011, true),
      polys([rect(0.48, 0.69, 0.60, 0.775)], 'rear', 'rev', 0.011, true),
      polys([0, 1, 2].map(function (k) { var y = 0.735 + k * 0.045; return rect(0.34, y - 0.006, 0.82, y + 0.006); }), 'rear', 'gloss', 0.013, true),
      // plate in the centre of the black garnish, TOYOTA lettering above it, small square lamps either side
      plate(0.70, 0.805, 0.16, { off: 0.009 }),
      [
        TX('TOYOTA', 0, 0.84, 0.022, 'badge'),
        R('smoke', rect(0.21, 0.715, 0.27, 0.775), { off: 0.009 }),
        TX('TRUENO', 0.52, 0.915, 0.034, 'badge'), TX('APEX', -0.58, 0.915, 0.026, 'badge'),
        R('tail', rect(0.34, 0.69, 0.82, 0.86), { off: 0.012, low: 'only', tilt: 55 })
      ],
      // liftback glass: wiper at the bottom edge
      wiper(-0.12, 1.012, 0.46, 3, 0.008),
      // side: black protective moulding, door handle
      polys([rect(-2.10, 0.50, 1.96, 0.54)], 'side', 'gloss', 0.004, true),
      polys([rect(-0.62, 0.78, -0.50, 0.80)], 'side', 'black', 0.004, true),
      polys([[[-0.80, 0.90], [-0.74, 0.90], [-0.72, 1.31], [-0.78, 1.31]]], 'side', 'gloss', 0.004, true),
      [
        // black bumper corners wrap the tail: tow-hook loop under the bumper (left)
        box('black', [-2.17, 0.36, -0.30], [0.05, 0.03, 0.05], false)
      ],
      mirrorPart(0.44, 0.26, 0.90, 0.99, 0.70, 0.89, 0.70)
    ),
    // factory look (used while the build keeps the generic dark rim / yellow calliper): the GT-APEX's light silver
    // 14" alloys with a faint warm (champagne) cast and plain dark iron callipers
    // single round tail pipe under the left corner
    exhaust: [{ cx: -0.50, cy: 0.24, w: 0.065, h: 0.065, shape: 'round' }],
    wheels: { style: 'dish', spokes: 8, stock: { rim: '#c4bfae', material: 'cast', caliper: '#2a2a2a' } },
    notes: 'Toyota Sprinter Trueno GT-APEX (AE86) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:1983-1985_Toyota_Sprinter_Trueno_GT_Apex.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:1983-1985_Toyota_Sprinter_Trueno_GT_Apex_rear.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_Sprinter_Trueno_Black_Limited.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_E-AE86_Sprinter_Trueno_GT_APEX_(22092207238).jpg (side). Rear detail: ' +
      'https://commons.wikimedia.org/wiki/File:TOYOTA_SPRINTER_TRUENO_1600GT-APEX_E-AE86_REAR_IMAGE.jpg , ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_SPRINTER_TRUENO_3door_GT_APEX_(E-AE86-FCMVF)_rear.jpg .'
  };
  reg('toyota-sprinter-trueno-ae86', AE86);

  /* ---------------------------------------------------------------- roadster helpers */
  /** backward-facing copy of the windscreen glass (so it reads from behind / inside the cockpit) */
  function screenBack(xb, yb, zb, xh, yh, zh) {
    var dx = xh - xb, dy = yh - yb, l = Math.sqrt(dx * dx + dy * dy), n = [-dy / l, dx / l, 0];   // back / up normal
    var a = [xb - 0.03, yb + 0.03], b = [xh + 0.035, yh - 0.035], za = zb - 0.045, zc = zh - 0.045;
    return { t: 'poly', mat: 'glass', offset: 0.004, normal: n, pts: [[a[0], a[1], za], [b[0], b[1], zc], [b[0], b[1], -zc], [a[0], a[1], -za]] };
  }
  /** roll hoop / headrest fairing behind a seat: side profile extruded across z0..z1 (mirrored) */
  function hoop(prof, z0, z1, mat) { return prism(mat || 'black', z0, z1, prof); }
  /** steering wheel (LHD, driver on the left): rim disc + boss */
  function wheelSteer(x, y, z) {
    return [cyl('black', [x, y, z], 0.19, 0.03, 'x', 10, false), cyl('interior', [x - 0.12, y - 0.06, z], 0.045, 0.22, 'x', 6, false)];
  }

  /* ================================================================ Mazda MX-5 (ND, 2015–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Mazda_MX-5_(ND)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2023_Mazda_MX-5_2.0_Skyactiv-G_Exclusive_Line_at_Green4Motor_Coventry_02.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2023_Mazda_MX-5_2.0_Skyactiv-G_Exclusive_Line_at_Green4Motor_Coventry_03.jpg
  //   front 3/4 (roof up): https://commons.wikimedia.org/wiki/File:Mazda_MX-5_(ND)_1X7A7471.jpg
  //   side:      https://commons.wikimedia.org/wiki/File:2015_Mazda_MX-5_ND_2.0_SKYACTIV-G_160_i-ELOOP_Rubinrot-Metallic_Seitenansicht.jpg
  // Signature: tiny low roadster, Kodo fenders peaking above a low bonnet, slim angular lamps over a wide
  // smiling grille mouth, short raked windscreen, open cockpit with two black roll-hoop fairings behind the
  // headrests, rounded tail with horizontal lamps holding a round ring.
  var MX5_SCREEN = [0.50, 0.815, 0.68, -0.105, 1.185, 0.55];
  var MX5 = {
    body: {
      // cockpit rings (x 0.40 .. -0.79): 6 door top, 7 inner door top, 8 cockpit wall foot, 9 floor by the tunnel, 10 tunnel
      stations: [
        { x: 1.92, pts: [[0.29, 0], [0.29, 0.24], [0.31, 0.29], [0.38, 0.32], [0.46, 0.325], [0.51, 0.31], [0.525, 0.26], [0.53, 0.2], [0.532, 0.13], [0.532, 0.06], [0.532, 0]] },
        { x: 1.86, pts: [[0.23, 0], [0.23, 0.4], [0.26, 0.5], [0.38, 0.55], [0.5, 0.56], [0.59, 0.535], [0.625, 0.47], [0.632, 0.38], [0.628, 0.28], [0.622, 0.14], [0.62, 0]] },
        { x: 1.70, pts: [[0.21, 0], [0.21, 0.62], [0.25, 0.73], [0.4, 0.78], [0.55, 0.79], [0.66, 0.775], [0.715, 0.725], [0.755, 0.635], [0.665, 0.47], [0.635, 0.22], [0.63, 0]] },
        { x: 1.155, pts: [[0.17, 0], [0.17, 0.72], [0.24, 0.805], [0.45, 0.845], [0.63, 0.862], [0.77, 0.83], [0.835, 0.775], [0.875, 0.7], [0.785, 0.52], [0.75, 0.26], [0.742, 0]] },
        { x: 0.70, pts: [[0.15, 0], [0.15, 0.72], [0.25, 0.785], [0.42, 0.825], [0.6, 0.85], [0.735, 0.81], [0.8, 0.765], [0.85, 0.69], [0.795, 0.49], [0.78, 0.24], [0.775, 0]] },
        { x: 0.45, pts: [[0.15, 0], [0.15, 0.72], [0.25, 0.755], [0.4, 0.79], [0.56, 0.84], [0.7, 0.795], [0.81, 0.775], [0.825, 0.66], [0.823, 0.46], [0.822, 0.24], [0.822, 0]] },
        { x: 0.40, pts: [[0.15, 0], [0.15, 0.71], [0.25, 0.752], [0.39, 0.787], [0.555, 0.838], [0.7, 0.792], [0.815, 0.775], [0.825, 0.7], [0.73, 0.58], [0.71, 0.2], [0.73, 0]] },
        { x: 0.15, pts: [[0.15, 0], [0.15, 0.7], [0.25, 0.745], [0.37, 0.78], [0.52, 0.832], [0.68, 0.785], [0.8, 0.772], [0.81, 0.7], [0.4, 0.58], [0.33, 0.18], [0.5, 0]] },
        { x: -0.35, pts: [[0.15, 0], [0.15, 0.7], [0.25, 0.745], [0.35, 0.778], [0.47, 0.83], [0.66, 0.795], [0.82, 0.79], [0.83, 0.71], [0.4, 0.58], [0.33, 0.18], [0.49, 0]] },
        { x: -0.79, pts: [[0.16, 0], [0.16, 0.71], [0.26, 0.77], [0.37, 0.8], [0.48, 0.845], [0.68, 0.83], [0.85, 0.8], [0.855, 0.72], [0.4, 0.58], [0.33, 0.18], [0.48, 0]] },
        { x: -0.86, pts: [[0.17, 0], [0.17, 0.72], [0.27, 0.785], [0.38, 0.815], [0.5, 0.855], [0.7, 0.842], [0.86, 0.8], [0.865, 0.7], [0.866, 0.48], [0.866, 0.24], [0.866, 0]] },
        { x: -1.155, pts: [[0.2, 0], [0.2, 0.74], [0.27, 0.81], [0.44, 0.85], [0.6, 0.872], [0.76, 0.845], [0.88, 0.795], [0.915, 0.69], [0.875, 0.48], [0.855, 0.24], [0.852, 0]] },
        { x: -1.60, pts: [[0.244, 0], [0.244, 0.72], [0.28, 0.8], [0.45, 0.84], [0.61, 0.862], [0.74, 0.83], [0.86, 0.775], [0.895, 0.66], [0.88, 0.46], [0.872, 0.24], [0.87, 0]] },
        { x: -1.84, pts: [[0.268, 0], [0.268, 0.6], [0.3, 0.68], [0.45, 0.725], [0.62, 0.735], [0.76, 0.715], [0.83, 0.66], [0.86, 0.56], [0.87, 0.4], [0.872, 0.21], [0.872, 0]] },
        { x: -1.94, pts: [[0.33, 0], [0.33, 0.4], [0.35, 0.47], [0.45, 0.515], [0.62, 0.525], [0.74, 0.505], [0.8, 0.455], [0.83, 0.38], [0.84, 0.27], [0.842, 0.14], [0.845, 0]] },
        { x: -1.989, pts: [[0.43, 0], [0.43, 0.17], [0.44, 0.21], [0.5, 0.235], [0.62, 0.245], [0.72, 0.235], [0.77, 0.21], [0.795, 0.17], [0.8, 0.12], [0.805, 0.06], [0.805, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black' },                                   // nose
        { 0: 'black', 1: 'black' },                                   // grille mouth / lamps
        { 0: 'black', 1: 'black' },                                   // front fender
        { 0: 'black', 1: 'black' },                                   // bonnet
        { 0: 'black', 1: 'black', 8: 'gloss', 9: 'gloss' },           // cowl
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // dash top
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // dash face
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // open cockpit (door front)
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // open cockpit (door rear)
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // rear bulkhead
        { 0: 'black', 1: 'black', 7: 'black', 8: 'black', 9: 'black' },            // folded soft-top well
        { 0: 'black', 1: 'black' },                                   // boot lid
        { 0: 'black', 1: 'black' },
        { 0: 'black', 1: 'black' },                                   // tail
        { 0: 'black', 1: 'black', 2: 'black' }                        // rear bumper
      ]),
      capF: 'paint', capR: 'paint'
    },
    cabin: screen.apply(null, MX5_SCREEN),
    parts: [].concat(
      [screenBack.apply(null, MX5_SCREEN)],
      // slim angular headlamps, wide smiling grille mouth, no emblem (text badges only)
      polys([[[0.42, 0.655], [0.62, 0.628], [0.80, 0.640], [0.855, 0.700], [0.81, 0.732], [0.60, 0.722], [0.44, 0.692]]], 'front', 'gloss', 0.004, true),
      polys([[[0.46, 0.662], [0.62, 0.638], [0.80, 0.650], [0.84, 0.698], [0.80, 0.722], [0.60, 0.713], [0.46, 0.686]]], 'front', 'light', 0.008, true),
      polys([[[0.50, 0.672], [0.60, 0.662], [0.62, 0.696], [0.52, 0.684]]], 'front', 'gloss', 0.011, true),
      polys([[[0.62, 0.704], [0.81, 0.712], [0.82, 0.722], [0.62, 0.713]]], 'front', 'drl', 0.011, true),
      polys([[[-0.40, 0.19], [0.40, 0.19], [0.49, 0.30], [0.50, 0.47], [0.32, 0.525], [-0.32, 0.525], [-0.50, 0.47], [-0.49, 0.30]]], 'front', 'grille', 0.004, false),
      polys([rect(-0.26, 0.23, 0.26, 0.34)], 'front', 'plate', 0.008, false),
      polys([[[0.54, 0.21], [0.72, 0.215], [0.70, 0.26], [0.56, 0.255]]], 'front', 'grille', 0.004, true),
      // rear: horizontal lamps holding a round ring, plate, black lower bumper, twin tips
      // smoked inner blade with a red line along its top edge and a clear reverse slot, bright red ring outboard
      polys([[[0.36, 0.725], [0.76, 0.69], [0.86, 0.75], [0.82, 0.84], [0.40, 0.81]]], 'rear', 'smoke', 0.010, true),
      [
        R('tail', [[0.40, 0.795], [0.60, 0.812], [0.60, 0.826], [0.40, 0.809]], { off: 0.014 }),
        R('rev', [[0.42, 0.748], [0.56, 0.738], [0.56, 0.754], [0.42, 0.764]], { off: 0.014 })
      ],
      polys([ell(0.665, 0.765, 0.078, 0.062, 12)], 'rear', 'gloss', 0.014, true),
      polys([ell(0.665, 0.765, 0.062, 0.049, 12)], 'rear', 'tail', 0.018, true),
      polys([ell(0.665, 0.765, 0.036, 0.028, 10)], 'rear', 'gloss', 0.022, true),
      [R('tail', ell(0.665, 0.765, 0.022, 0.017, 6), { off: 0.026 })],
      [R('tail', [[0.36, 0.725], [0.72, 0.695], [0.76, 0.75], [0.74, 0.83], [0.40, 0.81]], { off: 0.016, low: 'only', tilt: 55 })],
      [TX('MX-5', 0.33, 0.645, 0.026, 'chrome')],
      plate(0.40, 0.51, 0.26),
      // boot-lid shut lines, centre third brake lamp on the lid edge, corner reflectors
      [
        R('gloss', rect(-0.46, 0.60, 0.46, 0.608), { off: 0.006, m: false }),
        R('gloss', [[0.452, 0.60], [0.462, 0.60], [0.385, 0.725], [0.375, 0.725]], { off: 0.006 }),
        R('tail', rect(-0.12, 0.832, 0.12, 0.842), { off: 0.006, m: false }),
        R('lens', [[0.74, 0.30], [0.765, 0.30], [0.79, 0.40], [0.765, 0.40]], { off: 0.007 })
      ],
      polys([rect(-0.74, 0.25, 0.74, 0.34)], 'rear', 'gloss', 0.004, false),
      [
        // seats, roll-hoop fairings behind the headrests, steering wheel
        hoop([[-0.86, 0.84], [-0.88, 1.035], [-0.96, 1.07], [-1.05, 1.035], [-1.08, 0.86]], 0.13, 0.37, 'black')
      ],
      seat(-0.14, 0.36, 0.26),
      wheelSteer(0.10, 0.70, -0.36),
      mirrorPart(0.40, 0.22, 0.84, 0.93, 0.73, 0.96, 0.76)
    ),
    // twin round tips together under the right-hand corner (one side only, replaces the model's tips)
    exhaust: [{ cx: 0.36, cy: 0.29, w: 0.07, h: 0.07, shape: 'round' }, { cx: 0.45, cy: 0.29, w: 0.07, h: 0.07, shape: 'round' }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'Mazda MX-5 (ND) — hand-authored low-poly (open top). Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2023_Mazda_MX-5_2.0_Skyactiv-G_Exclusive_Line_at_Green4Motor_Coventry_02.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2023_Mazda_MX-5_2.0_Skyactiv-G_Exclusive_Line_at_Green4Motor_Coventry_03.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_MX-5_(ND)_1X7A7471.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2015_Mazda_MX-5_ND_2.0_SKYACTIV-G_160_i-ELOOP_Rubinrot-Metallic_Seitenansicht.jpg (side), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_MX-5_Miata_(ND,_roadster).jpg (side, fender peaks / door scallop / haunch), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_MX-5_ND_Wien_26_July_2020_JM_(1).jpg (side, flank sweep), ' +
      'https://commons.wikimedia.org/wiki/File:Mazda_MX-5_ND_convertible_2017_(6).jpg (rear 3/4, tail lamps / one-side twin tips), ' +
      'https://commons.wikimedia.org/wiki/File:2015_Mazda_MX-5_(ND)_Roadster_GT_convertible_(2018-10-30)_01.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2015_Mazda_MX-5_ND_2.0_SKYACTIV-G_160_i-ELOOP_Heckansicht_Rubinrot-Metallic.jpg (rear 3/4, lamps / MX-5 text). ' +
      'Flank: the crease (ring point 4) runs from the front-fender peak down across the door and rises into the rear haunch, with the door bands above / below it tucked in (concave door) so the facets catch light differently.'
  };
  reg('mazda-mx5-nd', MX5);

  /* ================================================================ BMW Z4 M40i (G29, 2019–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/BMW_Z4_(G29)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:BMW_G29_Z4_sDrive20i_San_Francisco_Red_(1).jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:BMW_G29_Z4_sDrive20i_San_Francisco_Red_(3).jpg
  //   front 3/4 (open): https://commons.wikimedia.org/wiki/File:2019_BMW_Z4_M40i_Front.jpg
  //   side:      https://commons.wikimedia.org/wiki/File:BMW_Z4_M40i_(G29)_left.jpg
  // Signature: long bonnet / set-back cockpit, wide low mesh kidneys, vertically stacked headlamps, big
  // lower intakes, Air Breather slash behind the front wheel, open cockpit with black hoops, ducktail
  // boot lid with slim boomerang tail lamps, tips at both corners.
  var Z4_SCREEN = [0.20, 0.917, 0.74, -0.405, 1.262, 0.60];
  var Z4 = {
    body: {
      stations: [
        { x: 2.142, pts: [[0.31, 0], [0.31, 0.14], [0.33, 0.18], [0.40, 0.20], [0.48, 0.205], [0.55, 0.19], [0.59, 0.16], [0.605, 0.12], [0.61, 0.08], [0.612, 0.04], [0.612, 0]] },
        { x: 2.08, pts: [[0.20, 0], [0.20, 0.42], [0.24, 0.52], [0.38, 0.57], [0.52, 0.58], [0.62, 0.56], [0.665, 0.49], [0.675, 0.40], [0.68, 0.28], [0.682, 0.14], [0.683, 0]] },
        { x: 1.90, pts: [[0.172, 0], [0.172, 0.62], [0.22, 0.73], [0.40, 0.79], [0.56, 0.80], [0.68, 0.78], [0.735, 0.71], [0.748, 0.60], [0.748, 0.42], [0.748, 0.22], [0.748, 0]] },
        { x: 1.60, pts: [[0.18, 0], [0.18, 0.74], [0.24, 0.85], [0.45, 0.89], [0.62, 0.895], [0.74, 0.87], [0.795, 0.80], [0.808, 0.68], [0.805, 0.48], [0.803, 0.25], [0.802, 0]] },
        { x: 1.235, pts: [[0.15, 0], [0.15, 0.78], [0.22, 0.89], [0.48, 0.93], [0.65, 0.932], [0.77, 0.91], [0.83, 0.84], [0.842, 0.70], [0.84, 0.48], [0.838, 0.25], [0.838, 0]] },
        { x: 0.60, pts: [[0.128, 0], [0.128, 0.76], [0.21, 0.87], [0.48, 0.905], [0.66, 0.908], [0.80, 0.89], [0.87, 0.83], [0.887, 0.70], [0.884, 0.48], [0.882, 0.25], [0.882, 0]] },
        { x: 0.15, pts: [[0.128, 0], [0.128, 0.76], [0.21, 0.86], [0.48, 0.896], [0.66, 0.898], [0.80, 0.885], [0.905, 0.83], [0.918, 0.70], [0.918, 0.48], [0.918, 0.25], [0.918, 0]] },
        { x: 0.10, pts: [[0.128, 0], [0.128, 0.76], [0.21, 0.86], [0.48, 0.896], [0.66, 0.898], [0.80, 0.885], [0.91, 0.83], [0.92, 0.72], [0.82, 0.58], [0.80, 0.20], [0.82, 0]] },
        { x: -0.15, pts: [[0.128, 0], [0.128, 0.76], [0.21, 0.86], [0.48, 0.897], [0.66, 0.899], [0.80, 0.886], [0.915, 0.83], [0.925, 0.72], [0.42, 0.58], [0.35, 0.18], [0.52, 0]] },
        { x: -1.10, pts: [[0.13, 0], [0.13, 0.76], [0.21, 0.87], [0.48, 0.905], [0.66, 0.91], [0.82, 0.895], [0.935, 0.84], [0.945, 0.74], [0.42, 0.58], [0.35, 0.18], [0.50, 0]] },
        { x: -1.17, pts: [[0.135, 0], [0.135, 0.76], [0.21, 0.875], [0.48, 0.91], [0.66, 0.915], [0.82, 0.90], [0.94, 0.84], [0.95, 0.74], [0.952, 0.50], [0.952, 0.25], [0.952, 0]] },
        { x: -1.60, pts: [[0.206, 0], [0.206, 0.76], [0.25, 0.87], [0.48, 0.93], [0.66, 0.938], [0.82, 0.915], [0.93, 0.85], [0.962, 0.72], [0.965, 0.50], [0.965, 0.25], [0.965, 0]] },
        { x: -1.95, pts: [[0.215, 0], [0.215, 0.72], [0.25, 0.82], [0.45, 0.87], [0.64, 0.88], [0.80, 0.86], [0.91, 0.79], [0.955, 0.66], [0.968, 0.46], [0.97, 0.24], [0.97, 0]] },
        { x: -2.10, pts: [[0.27, 0], [0.27, 0.55], [0.30, 0.64], [0.45, 0.70], [0.64, 0.715], [0.80, 0.70], [0.90, 0.64], [0.96, 0.55], [0.985, 0.40], [0.987, 0.20], [0.987, 0]] },
        { x: -2.183, pts: [[0.44, 0], [0.44, 0.52], [0.46, 0.59], [0.55, 0.63], [0.68, 0.64], [0.80, 0.63], [0.88, 0.59], [0.94, 0.52], [0.975, 0.40], [0.99, 0.20], [0.995, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black' },                                   // nose
        { 0: 'black', 1: 'black' },                                   // kidneys / lamps
        { 0: 'black', 1: 'black' },                                   // front fender
        { 0: 'black', 1: 'black' },                                   // long bonnet
        { 0: 'black', 1: 'black' },
        { 0: 'black', 1: 'black', 8: 'gloss', 9: 'gloss' },           // cowl
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // dash top
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // dash face
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // open cockpit
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // rear bulkhead
        { 0: 'black', 1: 'black', 8: 'black', 9: 'black' },           // soft-top cover
        { 0: 'black', 1: 'black' },                                   // boot lid
        { 0: 'black', 1: 'black' },                                   // ducktail
        { 0: 'black', 1: 'black', 2: 'black' }                        // rear bumper
      ]),
      capF: 'paint', capR: 'paint'
    },
    cabin: screen.apply(null, Z4_SCREEN),
    parts: [].concat(
      [screenBack.apply(null, Z4_SCREEN)],
      // vertically stacked headlamps with L-shaped DRL bars
      polys([[[0.47, 0.615], [0.70, 0.60], [0.855, 0.65], [0.85, 0.815], [0.70, 0.81], [0.49, 0.71]]], 'front', 'gloss', 0.004, true),
      polys([[[0.53, 0.63], [0.70, 0.62], [0.815, 0.655], [0.80, 0.70], [0.68, 0.695], [0.55, 0.685]], [[0.66, 0.725], [0.82, 0.72], [0.825, 0.79], [0.70, 0.785], [0.64, 0.75]]], 'front', 'light', 0.008, true),
      polys([[[0.70, 0.765], [0.83, 0.77], [0.83, 0.79], [0.70, 0.787]], [[0.54, 0.64], [0.82, 0.655], [0.82, 0.672], [0.54, 0.66]]], 'front', 'drl', 0.011, true),
      // wide low mesh kidneys with chrome surrounds (no emblem: text badges only)
      polys([rect(0.02, 0.45, 0.33, 0.635)], 'front', 'chrome', 0.005, true),
      polys([rect(0.04, 0.465, 0.31, 0.62)], 'front', 'grille', 0.009, true),
      // big lower intakes and centre air dam, plate
      polys([[[0.42, 0.22], [0.87, 0.25], [0.86, 0.46], [0.48, 0.42]]], 'front', 'grille', 0.004, true),
      polys([rect(-0.35, 0.18, 0.35, 0.37)], 'front', 'grille', 0.004, false),
      polys([rect(-0.26, 0.26, 0.26, 0.37)], 'front', 'plate', 0.008, false),
      // Air Breather slash behind the front wheel, door handle
      polys([[[0.76, 0.70], [0.69, 0.70], [0.55, 0.45], [0.62, 0.45]]], 'side', 'gloss', 0.006, true),
      polys([rect(-0.30, 0.86, -0.18, 0.88)], 'side', 'black', 0.004, true),
      // rear: slim boomerang lamps over the ducktail, plate, diffuser, tips at both corners
      // smoked boomerang lens: red L light guide (top edge + outer upright) and a second blade below, clear reverse
      polys([[[0.34, 0.83], [0.86, 0.80], [0.93, 0.85], [0.90, 0.92], [0.70, 0.905], [0.36, 0.875]]], 'rear', 'smoke', 0.006, true),
      [
        R('tail', [[0.36, 0.858], [0.70, 0.887], [0.90, 0.903], [0.905, 0.918], [0.70, 0.902], [0.36, 0.872]], { off: 0.01 }),
        R('tail', [[0.86, 0.812], [0.925, 0.852], [0.902, 0.91], [0.884, 0.902], [0.902, 0.856], [0.855, 0.828]], { off: 0.01 }),
        R('tail', [[0.50, 0.842], [0.85, 0.818], [0.865, 0.832], [0.50, 0.856]], { off: 0.01 }),
        R('rev', [[0.38, 0.838], [0.48, 0.833], [0.48, 0.848], [0.38, 0.853]], { off: 0.01 }),
        R('tail', [[0.34, 0.83], [0.80, 0.805], [0.84, 0.85], [0.82, 0.905], [0.70, 0.9], [0.36, 0.875]], { off: 0.01, low: 'only', tilt: 55 })
      ],
      [TX('Z4', -0.24, 0.79, 0.03, 'chrome'), TX('M40I', 0.24, 0.79, 0.026, 'chrome', { skew: 0.25 })],
      plate(0.52, 0.64, 0.26),
      // boot-lid shut line under the ducktail lamps, vertical corner vents with red reflectors, parking sensors
      [
        R('gloss', rect(-0.34, 0.70, 0.34, 0.709), { off: 0.006, m: false }),
        R('gloss', [[0.33, 0.70], [0.34, 0.70], [0.345, 0.835], [0.335, 0.835]], { off: 0.006 }),
        R('black', [[0.83, 0.30], [0.885, 0.32], [0.935, 0.63], [0.885, 0.61]], { off: 0.006 }),
        R('lens', [[0.85, 0.36], [0.872, 0.37], [0.905, 0.56], [0.882, 0.552]], { off: 0.01 })
      ],
      dots([[0.30, 0.46], [0.52, 0.45]], 0.014, 'gloss', 0.006),
      polys([rect(-0.86, 0.17, 0.86, 0.36)], 'rear', 'gloss', 0.004, false),
      [
        hoop([[-1.24, 0.94], [-1.26, 1.06], [-1.32, 1.085], [-1.38, 1.06], [-1.40, 0.95]], 0.14, 0.40, 'black')
      ],
      seat(-0.38, 0.37, 0.26),
      wheelSteer(-0.20, 0.78, -0.37),
      mirrorPart(0.12, -0.08, 0.92, 1.01, 0.78, 1.03, 0.82)
    ),
    // M40i: one trapezoid tip at each corner of the diffuser
    exhaust: [{ cx: 0.60, cy: 0.26, w: 0.15, h: 0.065, shape: 'trapezoid', mirror: true }],
    wheels: { style: 'y', spokes: 5 },
    notes: 'BMW Z4 M40i (G29) — hand-authored low-poly (open top). Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:BMW_G29_Z4_sDrive20i_San_Francisco_Red_(1).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:BMW_G29_Z4_sDrive20i_San_Francisco_Red_(3).jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2019_BMW_Z4_M40i_Front.jpg (front 3/4, open), ' +
      'https://commons.wikimedia.org/wiki/File:BMW_Z4_M40i_(G29)_left.jpg (side). Rear detail: ' +
      'https://commons.wikimedia.org/wiki/File:BMW_Z4_M40i_(G29)_rear.jpg , https://commons.wikimedia.org/wiki/File:2019_BMW_Z4_M40i_Rear.jpg .'
  };
  reg('bmw-z4-g29', Z4);

  /* ================================================================ Porsche 718 Boxster (982, 2016–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Porsche_Boxster/Cayman_(982)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2018_Porsche_718_Boxster_S_S-A_2.5_Front.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2018_Porsche_718_Boxster_S_S-A_2.5_Rear.jpg
  //   front 3/4 (open): https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_GTS_4.0_1X7A0320.jpg ,
  //                     https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_T_Genf_2019_1Y7A5424.jpg
  //   side:      https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_GTS_RDH-0688_left_side_on_Minsheng_East_Road_20221208.jpg
  // Signature: mid-engine wedge with fenders standing proud of a low bonnet, oval four-point LED lamps,
  // three-part lower intakes with slim DRL bars, big side air intake ahead of the rear wheel, body-colour
  // hoop fairings behind the seats running back onto the deck, black light-bar strip with PORSCHE lettering
  // between slim tail lamps, central twin exhaust.
  var BOX_SCREEN = [0.40, 0.855, 0.70, -0.26, 1.242, 0.56];
  var BOXSTER = {
    body: {
      stations: [
        { x: 2.195, pts: [[0.26, 0], [0.26, 0.16], [0.28, 0.20], [0.35, 0.215], [0.42, 0.215], [0.47, 0.20], [0.49, 0.17], [0.497, 0.13], [0.50, 0.09], [0.50, 0.04], [0.50, 0]] },
        { x: 2.12, pts: [[0.19, 0], [0.19, 0.44], [0.23, 0.52], [0.36, 0.56], [0.50, 0.57], [0.60, 0.55], [0.65, 0.49], [0.645, 0.40], [0.63, 0.28], [0.62, 0.14], [0.62, 0]] },
        { x: 1.96, pts: [[0.168, 0], [0.168, 0.62], [0.21, 0.72], [0.38, 0.77], [0.55, 0.78], [0.68, 0.76], [0.75, 0.70], [0.74, 0.56], [0.715, 0.40], [0.705, 0.20], [0.70, 0]] },
        { x: 1.73, pts: [[0.181, 0], [0.181, 0.72], [0.22, 0.82], [0.40, 0.86], [0.58, 0.865], [0.72, 0.84], [0.80, 0.75], [0.78, 0.58], [0.725, 0.40], [0.705, 0.20], [0.70, 0]] },
        { x: 1.28, pts: [[0.16, 0], [0.16, 0.76], [0.21, 0.86], [0.42, 0.89], [0.60, 0.896], [0.74, 0.875], [0.83, 0.77], [0.80, 0.62], [0.745, 0.46], [0.73, 0.22], [0.725, 0]] },
        { x: 0.80, pts: [[0.122, 0], [0.122, 0.72], [0.20, 0.82], [0.42, 0.87], [0.60, 0.88], [0.74, 0.865], [0.828, 0.77], [0.80, 0.64], [0.765, 0.46], [0.752, 0.24], [0.75, 0]] },
        { x: 0.42, pts: [[0.122, 0], [0.122, 0.72], [0.20, 0.81], [0.42, 0.856], [0.60, 0.866], [0.74, 0.85], [0.835, 0.77], [0.84, 0.66], [0.84, 0.46], [0.84, 0.24], [0.84, 0]] },
        { x: 0.32, pts: [[0.122, 0], [0.122, 0.72], [0.20, 0.81], [0.42, 0.855], [0.60, 0.865], [0.74, 0.85], [0.845, 0.77], [0.85, 0.70], [0.74, 0.58], [0.72, 0.20], [0.74, 0]] },
        { x: 0.10, pts: [[0.122, 0], [0.122, 0.72], [0.20, 0.80], [0.42, 0.852], [0.60, 0.862], [0.74, 0.85], [0.858, 0.77], [0.865, 0.70], [0.40, 0.58], [0.34, 0.17], [0.48, 0]] },
        { x: -0.55, pts: [[0.122, 0], [0.122, 0.72], [0.20, 0.79], [0.42, 0.825], [0.60, 0.835], [0.76, 0.852], [0.88, 0.79], [0.90, 0.70], [0.40, 0.58], [0.34, 0.17], [0.48, 0]] },
        { x: -0.95, pts: [[0.13, 0], [0.13, 0.74], [0.21, 0.83], [0.42, 0.86], [0.60, 0.875], [0.76, 0.885], [0.90, 0.81], [0.935, 0.70], [0.40, 0.58], [0.34, 0.17], [0.48, 0]] },
        { x: -1.02, pts: [[0.14, 0], [0.14, 0.75], [0.21, 0.855], [0.42, 0.885], [0.60, 0.895], [0.77, 0.89], [0.915, 0.81], [0.955, 0.70], [0.935, 0.48], [0.925, 0.24], [0.922, 0]] },
        { x: -1.40, pts: [[0.18, 0], [0.18, 0.76], [0.24, 0.87], [0.45, 0.912], [0.64, 0.925], [0.81, 0.91], [0.945, 0.835], [1.0, 0.69], [0.945, 0.48], [0.915, 0.24], [0.91, 0]] },
        { x: -1.80, pts: [[0.205, 0], [0.205, 0.76], [0.24, 0.865], [0.45, 0.898], [0.62, 0.905], [0.78, 0.888], [0.93, 0.80], [0.985, 0.65], [0.94, 0.46], [0.925, 0.22], [0.92, 0]] },
        { x: -2.05, pts: [[0.235, 0], [0.235, 0.68], [0.27, 0.76], [0.45, 0.80], [0.62, 0.81], [0.76, 0.79], [0.88, 0.72], [0.955, 0.60], [0.95, 0.42], [0.945, 0.22], [0.945, 0]] },
        { x: -2.15, pts: [[0.32, 0], [0.32, 0.48], [0.34, 0.56], [0.45, 0.60], [0.62, 0.61], [0.76, 0.60], [0.86, 0.55], [0.93, 0.47], [0.955, 0.36], [0.96, 0.18], [0.96, 0]] },
        { x: -2.185, pts: [[0.40, 0], [0.40, 0.30], [0.42, 0.34], [0.50, 0.36], [0.62, 0.365], [0.72, 0.355], [0.80, 0.33], [0.86, 0.29], [0.90, 0.22], [0.91, 0.11], [0.91, 0]] }
      ],
      mats: rows([
        { 0: 'black', 1: 'black' },                                   // nose
        { 0: 'black', 1: 'black' },                                   // intakes / lamps
        { 0: 'black', 1: 'black' },                                   // front fenders
        { 0: 'black', 1: 'black' },                                   // bonnet between the fenders
        { 0: 'black', 1: 'black' },
        { 0: 'black', 1: 'black', 8: 'gloss', 9: 'gloss' },           // cowl
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // dash top
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // dash face
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // open cockpit
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // cockpit (side intake scallop below)
        { 0: 'black', 1: 'black', 7: 'interior', 8: 'interior', 9: 'interior' },   // rear bulkhead
        { 0: 'black', 1: 'black', 8: 'black', 9: 'black' },           // stowed roof
        { 0: 'black', 1: 'black' },                                   // engine lid / rear deck
        { 0: 'black', 1: 'black' },                                   // tail
        { 0: 'black', 1: 'black' },                                   // tail lamps
        { 0: 'black', 1: 'black', 2: 'black' }                        // rear bumper
      ]),
      capF: 'paint', capR: 'paint'
    },
    cabin: screen.apply(null, BOX_SCREEN),
    parts: [].concat(
      [screenBack.apply(null, BOX_SCREEN)],
      // oval headlamps laid along the fender crowns (plan-view outline wrapped onto the fender) with the four-point DRL
      polys([ell(1.925, 0.655, 0.205, 0.125, 12, -0.14)], 'top', 'gloss', 0.006, true),
      polys([ell(1.93, 0.655, 0.178, 0.10, 12, -0.14)], 'top', 'light', 0.010, true),
      polys([[-1, -1], [-1, 1], [1, -1], [1, 1]].map(function (q) { return ell(1.93 + q[0] * 0.065, 0.655 + q[1] * 0.042 - q[0] * 0.009, 0.026, 0.017, 6); }), 'top', 'drl', 0.014, true),
      // three-part lower intakes with slim DRL bars, plate
      polys([rect(-0.34, 0.17, 0.34, 0.34)], 'front', 'grille', 0.004, false),
      polys([[[0.43, 0.20], [0.86, 0.24], [0.84, 0.46], [0.48, 0.44]]], 'front', 'grille', 0.004, true),
      polys([rect(0.55, 0.47, 0.82, 0.49)], 'front', 'drl', 0.006, true),
      polys([rect(-0.25, 0.36, 0.25, 0.47)], 'front', 'plate', 0.008, false),
      // big side air intake ahead of the rear wheel, door handle
      polys([[[-0.50, 0.47], [-0.90, 0.43], [-0.90, 0.74], [-0.58, 0.70]]], 'side', 'gloss', 0.006, true),
      polys([[[-0.62, 0.56], [-0.88, 0.545], [-0.88, 0.575], [-0.62, 0.59]]], 'side', 'paint', 0.010, true),
      polys([rect(-0.36, 0.80, -0.24, 0.82)], 'side', 'black', 0.004, true),
      // rear: slim lamps joined by a black strip with PORSCHE lettering, plate, diffuser
      // smoked lamps: red contour (top line, lower line, outer end) round the four-point brake lamp, clear reverse
      polys([[[0.38, 0.81], [0.84, 0.79], [0.89, 0.84], [0.86, 0.91], [0.40, 0.885]]], 'rear', 'smoke', 0.006, true),
      [
        R('tail', [[0.40, 0.866], [0.86, 0.888], [0.865, 0.902], [0.40, 0.879]], { off: 0.01 }),
        R('tail', [[0.39, 0.817], [0.84, 0.797], [0.85, 0.81], [0.39, 0.83]], { off: 0.01 }),
        R('tail', [[0.84, 0.797], [0.89, 0.84], [0.865, 0.902], [0.848, 0.892], [0.87, 0.84], [0.83, 0.81]], { off: 0.01 }),
        R('tail', rect(0.595, 0.84, 0.625, 0.852), { off: 0.01 }), R('tail', rect(0.645, 0.84, 0.675, 0.852), { off: 0.01 }),
        R('tail', rect(0.595, 0.858, 0.625, 0.870), { off: 0.01 }), R('tail', rect(0.645, 0.858, 0.675, 0.870), { off: 0.01 }),
        R('rev', rect(0.44, 0.838, 0.53, 0.856), { off: 0.01 }),
        R('tail', [[0.38, 0.81], [0.80, 0.795], [0.82, 0.84], [0.80, 0.90], [0.40, 0.885]], { off: 0.01, low: 'only', tilt: 55 })
      ],
      polys([rect(-0.40, 0.825, 0.40, 0.87)], 'rear', 'gloss', 0.006, false),
      [TX('PORSCHE', 0, 0.848, 0.024, 'badge', { weight: 0.13, spacing: 2.2 }), TX('718 BOXSTER S', 0.22, 0.795, 0.017, 'chrome', { weight: 0.13 })],
      plate(0.55, 0.66, 0.26),
      // deployable spoiler: its shut line along the lid edge with the slim third brake lamp in it
      [R('gloss', rect(-0.62, 0.905, 0.62, 0.912), { off: 0.006, m: false }), R('tail', rect(-0.16, 0.917, 0.16, 0.924), { off: 0.006, m: false })],
      polys([rect(-0.84, 0.17, 0.84, 0.36)], 'rear', 'gloss', 0.004, false),
      polys([rect(0.50, 0.40, 0.70, 0.42)], 'rear', 'lens', 0.006, true),
      // black vertical vents in the bumper corners, parking sensors
      [R('black', [[0.78, 0.33], [0.86, 0.35], [0.88, 0.52], [0.82, 0.50]], { off: 0.006 })],
      dots([[0.32, 0.47], [0.52, 0.46]], 0.014, 'gloss', 0.006),
      // rear lid shut lines (seen from above / the chase cam), the lid's raised centre panel
      [
        { t: 'poly', view: 'top', mat: 'gloss', mirror: true, offset: 0.004, pts: rect(-2.12, 0.56, -1.60, 0.572) },
        { t: 'poly', view: 'top', mat: 'gloss', mirror: false, offset: 0.004, pts: rect(-1.612, -0.572, -1.60, 0.572) }
      ],
      [
        // body-colour hoop fairings running back onto the deck, stainless hoop caps
        hoop([[-1.15, 0.94], [-1.18, 1.055], [-1.26, 1.08], [-1.56, 0.985], [-1.56, 0.95]], 0.15, 0.41, 'paint'),
        hoop([[-1.17, 1.05], [-1.19, 1.064], [-1.27, 1.088], [-1.33, 1.07], [-1.27, 1.072]], 0.17, 0.39, 'chrome')
      ],
      seat(-0.10, 0.36, 0.24),
      wheelSteer(0.06, 0.74, -0.36),
      mirrorPart(0.28, 0.06, 0.86, 0.95, 0.75, 1.00, 0.80)
    ),
    // 718 Boxster S: twin oval tips together in the centre of the diffuser
    exhaust: [{ cx: 0.07, cy: 0.27, w: 0.085, h: 0.07, shape: 'oval', mirror: true }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'Porsche 718 Boxster (982) — hand-authored low-poly (open top). Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2018_Porsche_718_Boxster_S_S-A_2.5_Front.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2018_Porsche_718_Boxster_S_S-A_2.5_Rear.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_GTS_4.0_1X7A0320.jpg (front 3/4, open), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_T_Genf_2019_1Y7A5424.jpg (front 3/4, open), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_GTS_RDH-0688_left_side_on_Minsheng_East_Road_20221208.jpg (side). Rear detail: ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_S_-_face_arrière.jpg , https://commons.wikimedia.org/wiki/File:Porsche_718_Boxster_(rear),_November_7,_2024.jpg .'
  };
  reg('porsche-718-boxster-982', BOXSTER);

  if (typeof module !== 'undefined' && module.exports) module.exports = { 'vw-golf-gti-mk8': GOLF, 'honda-civic-type-r-fl5': CIVIC, 'toyota-gr-yaris': YARIS, 'toyota-sprinter-trueno-ae86': AE86,
    'mazda-mx5-nd': MX5, 'bmw-z4-g29': Z4, 'porsche-718-boxster-982': BOXSTER };
})();

/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/_examples.js
   Hand-authored low-poly exemplars (docs/LOWPOLY-SPEC.md): Porsche 911 (992) and Ford F-150 Raptor (gen 3).
   They set the quality bar and show the authoring format; copy the patterns for the other cars.

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body / cabin stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.
   The generator mirrors them, cuts the wheel wells at the fitted axles, fits the stations to the build
   (wheelbase / track / ride height) and projects `view` polygons onto the facets they land on.
   ========================================================================== */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  var LP = CB.lowpoly = CB.lowpoly || {};
  function reg(id, def) {
    if (typeof LP.register === 'function' && !Array.isArray(LP._pending)) LP.register(id, def);
    else (LP._pending = LP._pending || []).push([id, def]);
  }

  /* ---------------------------------------------------------------- helpers (view-plane outlines) */
  // ellipse outline (n points) centred (a, b) in view coordinates
  function ell(a, b, ra, rb, n, rot) {
    var out = [], r = rot || 0;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n * Math.PI * 2, u = Math.cos(t) * ra, v = Math.sin(t) * rb;
      out.push([a + u * Math.cos(r) - v * Math.sin(r), b + u * Math.sin(r) + v * Math.cos(r)]);
    }
    return out;
  }
  /** planar ellipse in 3D (ref coords): centre c, normal tilted `tilt` deg up from +x (forward; -x when back),
      radii ru (across, along z) and rv (along the slope); n points; offset along the normal */
  function lamp3d(c, ru, rv, tiltDeg, n, back, off, scale) {
    var t = tiltDeg * Math.PI / 180, sx = back ? -1 : 1, k = scale || 1;
    var N = [sx * Math.sin(t) * 0 + sx * Math.cos(t), Math.sin(t), 0];        // face normal
    var V = [-sx * Math.sin(t), Math.cos(t), 0];                                // along the slope (up / back)
    var out = [];
    for (var i = 0; i < n; i++) {
      var a = (i + 0.5) / n * Math.PI * 2, u = Math.cos(a) * ru * k, v = Math.sin(a) * rv * k;
      out.push([c[0] + V[0] * v + N[0] * off, c[1] + V[1] * v + N[1] * off, c[2] + u]);
    }
    return out;
  }
  function rect(a0, b0, a1, b1) { return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]; }
  // block capitals as rectangles (for grille / tailgate lettering): returns [rect...] in view coordinates
  var GLYPH = {   // cells on a 3x5 grid: [col0, row0, col1, row1] (rows from the bottom)
    F: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.4, 3]],
    O: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 0, 2, 1], [1, 4, 2, 5]],
    R: [[0, 0, 1, 5], [1, 4, 2.6, 5], [2, 2.6, 3, 4], [1, 2, 2.6, 3], [2, 0, 3, 2]],
    D: [[0, 0, 1, 5], [1, 0, 2.2, 1], [1, 4, 2.2, 5], [2.2, 0.8, 3, 4.2]],
    A: [[0, 0, 1, 4], [2, 0, 3, 4], [0.45, 4, 2.55, 5], [1, 2, 2, 2.9]],
    P: [[0, 0, 1, 5], [1, 4, 2.6, 5], [2, 2.4, 3, 4], [1, 2, 2.6, 3]],
    T: [[0, 4, 3, 5], [1, 0, 2, 4]]
  };
  /** word centred at (ac, bc), letter height h; dir = +1 when +a reads left -> right for the viewer */
  function word(txt, ac, bc, h, dir, asp) {   // asp (optional) widens the letters (extended block capitals)
    var cell = h / 5, cw = cell * (asp || 1), lw = 3 * cw, gap = cw * 1.1, total = txt.length * lw + (txt.length - 1) * gap, out = [];
    for (var i = 0; i < txt.length; i++) {
      var g = GLYPH[txt[i]]; if (!g) continue;
      var x0 = -total / 2 + i * (lw + gap);
      g.forEach(function (c) {
        var u0 = x0 + c[0] * cw, u1 = x0 + c[2] * cw;
        out.push(rect(ac + dir * u0, bc - h / 2 + c[1] * cell, ac + dir * u1, bc - h / 2 + c[3] * cell));
      });
    }
    return out;
  }
  /** flared arch band (side profile, segments of an arch ring) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, flatTop) {
    var parts = [], n = segs || 6;
    for (var k = 0; k < n; k++) {
      var a0 = Math.PI * k / n, a1 = Math.PI * (k + 1) / n;
      function P(r, a) {
        var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (flatTop) y = Math.min(y, cy + r * 0.86);
        return [x, y];
      }
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, a0), P(rOut, a0), P(rOut, a1), P(rIn, a1)] });
    }
    return parts;
  }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }

  /* ================================================================ Porsche 911 Carrera (992) */
  // Reference photos (Wikimedia Commons), measured on a pixel grid (wheelbase as scale):
  //   side:      https://commons.wikimedia.org/wiki/File:Porsche_911_Carrera_S_(992)_-_2025-11-21.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2019_Porsche_911_Carrera_S_S-A_3.0_Front.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Porsche_911_Targa_4_(992)_(front_three-quarter_view)_in_Osaka.jpg
  //   rear:      https://commons.wikimedia.org/wiki/File:2020_Porsche_911_Carrera_4_992_White_rear.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2025_Porsche_911_Carrera_S_rear.jpg
  // Measured: arch tops 0.74 m; headlamp lens from (1.60, 0.88) to (1.87, 0.67) on the fender front (~36 deg);
  // windscreen base (0.72, 0.96) -> header (0.0, 1.29); roof peak ~x -0.3; DLO rear tip (-1.19, 1.0); deck lip
  // (-2.0, 0.93); light bar at y 0.80-0.83 wrapping round to x -1.85; door handle x -0.50..-0.34 at y 0.72.
  // Signature: one continuous roof arc, fenders standing proud of a low bonnet with big upright oval lamps +
  // 4-point DRL, teardrop DLO, wide rear haunches, full-width light bar with smoked ends + PORSCHE lettering,
  // louvred engine lid with the vertical third brake light, black three-part intake band.
  var GL911 = {   // spaced capitals for the rear lettering (3x5 cells, rows from the bottom)
    P: [[0, 0, 1, 5], [1, 4, 3, 5], [2, 2.6, 3, 4], [1, 2, 3, 3]],
    O: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 0, 2, 1], [1, 4, 2, 5]],
    R: [[0, 0, 1, 5], [1, 4, 3, 5], [2, 2.6, 3, 4], [1, 2, 2.6, 3], [2, 0, 3, 2]],
    S: [[0, 4, 3, 5], [0, 2.5, 1, 4], [0, 2, 3, 3], [2, 1, 3, 2.5], [0, 0, 3, 1]],
    C: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 0, 3, 1]],
    H: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 2, 2, 3]],
    E: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.5, 3], [1, 0, 3, 1]]
  };
  function spaced(txt, ac, bc, h, pitch, dir) {
    var cell = h / 5, out = [];
    for (var i = 0; i < txt.length; i++) {
      var g = GL911[txt[i]]; if (!g) continue;
      var x0 = (i - (txt.length - 1) / 2) * pitch - 1.5 * cell;
      g.forEach(function (c) {
        out.push(rect(ac + dir * (x0 + c[0] * cell), bc - h / 2 + c[1] * cell, ac + dir * (x0 + c[2] * cell), bc - h / 2 + c[3] * cell));
      });
    }
    return out;
  }
  // headlamp: centre on the fender front slope, normal tilted 54 deg up from +x
  var HL = [1.755, 0.772, 0.64], HT = 54, HN = [Math.cos(HT * Math.PI / 180), Math.sin(HT * Math.PI / 180), 0];
  function hlAt(du, dv, ru, rv, n, off) {   // ellipse offset (du across z, dv along the slope) from the lamp centre
    var t = HT * Math.PI / 180, V = [-Math.sin(t), Math.cos(t)];
    return lamp3d([HL[0] + V[0] * dv, HL[1] + V[1] * dv, HL[2] + du], ru, rv, HT, n, false, off);
  }
  // side window graphic (teardrop DLO): outer black surround, door glass + quarter glass
  var DLO = [[0.70, 0.952], [0.30, 0.958], [-0.20, 0.966], [-0.70, 0.976], [-1.05, 0.985], [-1.23, 1.0],
    [-1.02, 1.10], [-0.75, 1.168], [-0.42, 1.208], [-0.10, 1.218], [0.06, 1.205]];
  function inset(pts, d) {   // crude inset towards the centroid
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    return pts.map(function (p) { var dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx * 0.35, dy) || 1; return [p[0] - dx / l * d * 0.35, p[1] - dy / l * d]; });
  }
  var P911 = {
    body: {
      // pts: 0 bottom centre, 1 bottom edge, 2 lower flank, 3 waist (widest), 4 shoulder, 5 fender crown,
      //      6 crown top / belt, 7 glass base, 8 roof rail / A-pillar, 9 roof quarter, 10 centre line
      stations: [
        { x: 2.20, pts: [[0.25, 0], [0.25, 0.32], [0.28, 0.42], [0.35, 0.47], [0.42, 0.455], [0.46, 0.40], [0.475, 0.32], [0.48, 0.23], [0.485, 0.15], [0.49, 0.07], [0.49, 0]] },
        { x: 2.13, pts: [[0.17, 0], [0.18, 0.60], [0.24, 0.715], [0.38, 0.765], [0.50, 0.75], [0.57, 0.70], [0.60, 0.62], [0.59, 0.46], [0.575, 0.30], [0.565, 0.15], [0.565, 0]] },
        { x: 1.90, pts: [[0.15, 0], [0.16, 0.72], [0.24, 0.845], [0.42, 0.88], [0.58, 0.855], [0.66, 0.80], [0.69, 0.70], [0.67, 0.50], [0.655, 0.30], [0.645, 0.15], [0.64, 0]] },
        { x: 1.62, pts: [[0.16, 0], [0.17, 0.75], [0.27, 0.875], [0.47, 0.90], [0.66, 0.875], [0.80, 0.81], [0.875, 0.68], [0.83, 0.49], [0.77, 0.30], [0.745, 0.15], [0.74, 0]] },
        { x: 1.22, pts: [[0.16, 0], [0.17, 0.75], [0.30, 0.88], [0.50, 0.905], [0.70, 0.88], [0.855, 0.795], [0.905, 0.645], [0.865, 0.47], [0.82, 0.30], [0.80, 0.15], [0.795, 0]] },
        { x: 0.90, pts: [[0.16, 0], [0.18, 0.745], [0.30, 0.88], [0.52, 0.90], [0.72, 0.875], [0.865, 0.785], [0.91, 0.68], [0.915, 0.52], [0.905, 0.34], [0.895, 0.18], [0.89, 0]] },
        { x: 0.72, pts: [[0.16, 0], [0.18, 0.745], [0.30, 0.88], [0.52, 0.90], [0.72, 0.875], [0.87, 0.795], [0.925, 0.715], [0.95, 0.65], [0.965, 0.585], [0.98, 0.32], [0.985, 0]] },
        { x: 0.36, pts: [[0.16, 0], [0.18, 0.745], [0.29, 0.875], [0.50, 0.895], [0.715, 0.875], [0.875, 0.80], [0.915, 0.738], [0.955, 0.66], [1.10, 0.575], [1.14, 0.36], [1.152, 0]] },
        { x: 0.00, pts: [[0.16, 0], [0.19, 0.745], [0.28, 0.87], [0.49, 0.89], [0.71, 0.875], [0.88, 0.805], [0.915, 0.742], [0.955, 0.66], [1.232, 0.56], [1.275, 0.38], [1.288, 0]] },
        { x: -0.35, pts: [[0.16, 0], [0.18, 0.745], [0.28, 0.87], [0.50, 0.895], [0.72, 0.88], [0.885, 0.812], [0.92, 0.748], [0.965, 0.662], [1.238, 0.56], [1.285, 0.38], [1.298, 0]] },
        { x: -0.75, pts: [[0.16, 0], [0.18, 0.75], [0.29, 0.88], [0.53, 0.91], [0.74, 0.895], [0.895, 0.83], [0.935, 0.755], [0.98, 0.66], [1.20, 0.555], [1.245, 0.38], [1.258, 0]] },
        { x: -1.05, pts: [[0.16, 0], [0.18, 0.755], [0.30, 0.88], [0.55, 0.912], [0.77, 0.92], [0.915, 0.85], [0.96, 0.755], [1.005, 0.64], [1.155, 0.55], [1.20, 0.38], [1.21, 0]] },
        { x: -1.35, pts: [[0.16, 0], [0.18, 0.76], [0.30, 0.89], [0.55, 0.915], [0.80, 0.926], [0.935, 0.85], [0.99, 0.725], [1.03, 0.60], [1.085, 0.52], [1.135, 0.36], [1.148, 0]] },
        { x: -1.70, pts: [[0.17, 0], [0.18, 0.75], [0.25, 0.875], [0.45, 0.905], [0.71, 0.918], [0.88, 0.84], [0.945, 0.70], [0.985, 0.57], [1.012, 0.45], [1.035, 0.30], [1.042, 0]] },
        { x: -2.00, pts: [[0.17, 0], [0.18, 0.72], [0.24, 0.845], [0.42, 0.88], [0.67, 0.89], [0.84, 0.82], [0.895, 0.68], [0.925, 0.54], [0.942, 0.40], [0.952, 0.22], [0.955, 0]] },
        { x: -2.20, pts: [[0.17, 0], [0.18, 0.665], [0.26, 0.79], [0.40, 0.83], [0.63, 0.845], [0.78, 0.785], [0.845, 0.66], [0.88, 0.52], [0.90, 0.38], [0.912, 0.21], [0.915, 0]] },
        { x: -2.319, pts: [[0.20, 0], [0.20, 0.56], [0.32, 0.71], [0.42, 0.76], [0.60, 0.76], [0.73, 0.70], [0.80, 0.60], [0.835, 0.48], [0.855, 0.35], [0.865, 0.19], [0.87, 0]] }
      ],
      //       c0 under   c1 sill    c2       c3       c4       c5       c6       c7 side  c8 rail  c9 roof
      mats: [
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // nose cap
        ['black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // bumper face
        ['black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // lamps on the fender front
        ['black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // front fender
        ['black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // to the cowl
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'gloss', 'gloss'],     // scuttle
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'glass', 'glass'],     // windscreen
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'glass', 'glass'],     // windscreen
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint2'],    // roof (DLO projected)
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint2'],    // roof
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint2'],    // roof
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'glass', 'glass'],     // rear screen
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'glass', 'glass'],     // rear screen
        ['black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // engine lid
        ['black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],     // tail
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint']      // tail face
      ],
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // headlamps: silver ring, clear lens, dark projector bowl, four-point DRL around it
      // (audit: the lens reads silver with a dark projector bowl — a full white lens rendered as a blank disc)
      [{ t: 'poly', mat: 'gloss', mirror: true, normal: HN, pts: hlAt(0, 0, 0.13, 0.18, 14, 0.016) },
       { t: 'poly', mat: 'chrome', mirror: true, normal: HN, pts: hlAt(0, 0, 0.115, 0.162, 14, 0.020) },
       { t: 'poly', mat: 'gloss', mirror: true, normal: HN, pts: hlAt(0, 0, 0.066, 0.092, 10, 0.023) },
       { t: 'poly', mat: 'light', mirror: true, normal: HN, pts: hlAt(0, 0, 0.024, 0.032, 8, 0.026) }],
      [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(function (q) {
        return { t: 'poly', mat: 'drl', mirror: true, normal: HN, pts: hlAt(q[0] * 0.06, q[1] * 0.085, 0.019, 0.025, 6, 0.027) };
      }),
      // lower intake band: centre intake, side intakes with a slat, slim position-light bars above them, plate
      polys([[[-0.36, 0.20], [0.36, 0.20], [0.37, 0.33], [-0.37, 0.33]]], 'front', 'grille', 0.004, false),
      polys([[[0.43, 0.20], [0.76, 0.24], [0.79, 0.40], [0.45, 0.40]]], 'front', 'grille', 0.004, true),
      polys([rect(0.45, 0.30, 0.775, 0.32)], 'front', 'black', 0.007, true),
      polys([[[0.46, 0.415], [0.78, 0.415], [0.775, 0.432], [0.46, 0.432]]], 'front', 'drl', 0.007, true),
      polys([rect(-0.25, 0.345, 0.25, 0.455)], 'front', 'plate', 0.006, false),
      // rear: full-width light bar, smoked lamp ends (wrapping round the corner), PORSCHE lettering
      polys([[[0.50, 0.788], [0.79, 0.80], [0.80, 0.845], [0.50, 0.842]]], 'rear', 'gloss', 0.005, true),
      polys([rect(-0.79, 0.818, 0.79, 0.834)], 'rear', 'tail', 0.008, false),
      polys([[[0.52, 0.798], [0.78, 0.806], [0.78, 0.816], [0.52, 0.812]]], 'rear', 'tail', 0.009, true),
      polys(spaced('PORSCHE', 0, 0.778, 0.03, 0.082, 1), 'rear', 'badge', 0.007, false),
      polys([[[-2.31, 0.79], [-2.06, 0.80], [-1.86, 0.835], [-2.06, 0.842], [-2.31, 0.842]]], 'side', 'gloss', 0.005, true),
      polys([[[-2.31, 0.818], [-2.06, 0.822], [-1.90, 0.834], [-2.06, 0.834], [-2.31, 0.834]]], 'side', 'tail', 0.008, true),
      // rear bumper: black diffuser band, reflectors, plate
      polys([[[-0.74, 0.19], [0.74, 0.19], [0.80, 0.33], [0.62, 0.37], [-0.62, 0.37], [-0.80, 0.33]]], 'rear', 'black', 0.004, false),
      polys([rect(0.46, 0.335, 0.68, 0.355)], 'rear', 'tail', 0.006, true),
      polys([rect(-0.25, 0.39, 0.25, 0.50)], 'rear', 'plate', 0.006, false),
      // louvred engine lid with the vertical third brake light
      polys([rect(-1.98, -0.42, -1.66, 0.42)], 'top', 'gloss', 0.004, false),
      polys([-0.36, -0.28, -0.2, -0.12, 0.12, 0.2, 0.28, 0.36].map(function (z) { return rect(-1.97, z - 0.016, -1.67, z + 0.016); }), 'top', 'black', 0.007, false),
      polys([rect(-1.97, -0.04, -1.67, 0.04)], 'top', 'tail', 0.008, false),
      // side windows: black surround, door glass, quarter glass (gap = the slim pillar)
      polys([DLO], 'side', 'gloss', 0.004, true),
      polys([[[0.665, 0.962], [0.30, 0.968], [-0.20, 0.976], [-0.60, 0.985], [-0.57, 1.192], [-0.42, 1.198], [-0.10, 1.207], [0.04, 1.196]]], 'side', 'glass', 0.008, true),
      polys([[[-0.66, 0.985], [-1.04, 0.995], [-1.19, 1.008], [-1.0, 1.095], [-0.74, 1.158], [-0.63, 1.176]]], 'side', 'glass', 0.008, true),
      // door handle
      polys([rect(-0.50, 0.715, -0.34, 0.738)], 'side', 'black', 0.004, true),
      [
        // door mirrors: body-colour housing on a stalk from the door top
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.77, z1: 0.965, pts2d: [[0.50, 0.965], [0.28, 0.975], [0.27, 1.065], [0.46, 1.075]] },
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.64, z1: 0.79, pts2d: [[0.50, 0.925], [0.41, 0.925], [0.39, 0.99], [0.46, 0.99]] }
      ]
    ),
    wheels: { style: 'split', spokes: 5 },
    notes: 'Porsche 911 Carrera (992) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_911_Carrera_S_(992)_-_2025-11-21.jpg (side), ' +
      'https://commons.wikimedia.org/wiki/File:2019_Porsche_911_Carrera_S_S-A_3.0_Front.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_911_Targa_4_(992)_(front_three-quarter_view)_in_Osaka.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2020_Porsche_911_Carrera_4_992_White_rear.jpg (rear), ' +
      'https://commons.wikimedia.org/wiki/File:2025_Porsche_911_Carrera_S_rear.jpg (rear 3/4).'
  };
  reg('porsche-911-992', P911);

  /* ================================================================ Ford F-150 Raptor (gen 3, 2021–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Ford_F-Series_(fourteenth_generation)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2021_Ford_F-150_Raptor,_front.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2021_Ford_F-150_Raptor,_rear.jpg
  // Re-checked 2026-10 against both photos at matching angles (front 3/4, rear 3/4, front, side): grille box +
  // FORD letters, C-clamp lamps, flat-topped flares, crew cab glasshouse, FORD tailgate band all line up; the
  // roof clearance lamps are small flush lenses on the real truck, so they are kept slim.
  // Signature: tall flat nose with a dark grille box carrying block FORD letters, C-clamp lamps at the grille
  // ends, three amber cab-roof clearance lamps, flat-topped black flares, crew cab + 5.5 ft bed, tall upright
  // tail lamps, dark FORD tailgate band, dark bumpers with a silver skid plate, rock rails.
  var RAPTOR = {
    body: {
      // pts: 0 bottom centre, 1 bottom edge, 2 lower flank, 3 waist, 4 upper flank, 5 shoulder,
      //      6 hood edge / bed-rail inner, 7 hood / bed wall, 8 centre (hood or bed floor)
      stations: [
        { x: 2.805, pts: [[0.64, 0], [0.64, 0.86], [0.72, 0.95], [0.95, 0.97], [1.30, 0.97], [1.45, 0.93], [1.47, 0.70], [1.48, 0.40], [1.485, 0]] },
        { x: 2.70, pts: [[0.56, 0], [0.56, 0.90], [0.62, 0.99], [0.95, 1.01], [1.32, 1.01], [1.48, 0.96], [1.50, 0.70], [1.515, 0.40], [1.53, 0]] },
        { x: 2.40, pts: [[0.56, 0], [0.57, 0.95], [0.64, 1.035], [0.95, 1.055], [1.34, 1.055], [1.495, 1.00], [1.515, 0.72], [1.54, 0.40], [1.565, 0]] },
        { x: 1.85, pts: [[0.56, 0], [0.57, 0.97], [0.66, 1.06], [0.95, 1.08], [1.33, 1.07], [1.48, 1.01], [1.51, 0.72], [1.53, 0.40], [1.555, 0]] },
        { x: 1.12, pts: [[0.53, 0], [0.54, 0.97], [0.62, 1.01], [0.95, 1.025], [1.30, 1.02], [1.41, 0.99], [1.43, 0.76], [1.44, 0.40], [1.44, 0]] },
        { x: -1.12, pts: [[0.53, 0], [0.54, 0.97], [0.62, 1.01], [0.95, 1.025], [1.30, 1.02], [1.41, 0.99], [1.43, 0.76], [1.44, 0.40], [1.44, 0]] },
        { x: -1.18, pts: [[0.70, 0], [0.70, 0.95], [0.75, 1.00], [0.95, 1.02], [1.39, 1.02], [1.50, 1.00], [1.50, 0.90], [0.97, 0.88], [0.97, 0]] },
        { x: -1.85, pts: [[0.70, 0], [0.70, 0.97], [0.76, 1.06], [0.95, 1.08], [1.39, 1.07], [1.50, 1.01], [1.50, 0.90], [0.97, 0.88], [0.97, 0]] },
        { x: -3.03, pts: [[0.62, 0], [0.62, 0.95], [0.68, 1.00], [0.95, 1.01], [1.39, 1.01], [1.50, 1.00], [1.50, 0.90], [0.97, 0.88], [0.97, 0]] },
        { x: -3.10, pts: [[0.66, 0], [0.66, 0.84], [0.70, 0.88], [0.95, 0.885], [1.39, 0.885], [1.48, 0.875], [1.48, 0.70], [1.48, 0.40], [1.48, 0]] }
      ],
      //       c0 under  c1       c2       c3       c4       c5       c6       c7
      mats: [
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // fascia
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // nose
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // front fender
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // to the cowl
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // cab (under the cabin shell)
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'black', 'black'],   // cab back / bed front wall
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black', 'black'],   // bed (rail cap, liner)
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black', 'black'],   // bed
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'paint', 'paint']    // tailgate
      ],
      capF: 'paint', capR: 'paint'
    },
    cabin: {
      // pts: belt, glass base, roof rail, roof edge, roof centre. Placed from a straight side shot of a 2025 Raptor
      // scaled by the wheelbase (Commons "Ford F-150 Raptor Pace Truck Madera 2025.jpg"): windscreen base about
      // over the front wheel's rear edge, steeply raked A-pillar, flat roof back to just ahead of the rear arch,
      // B-pillar at the axle midpoint, near-vertical back glass down to the cab back; 0.46 m tall side glass
      stations: [
        { x: 1.58, pts: [[1.455, 0.93], [1.465, 0.92], [1.475, 0.88], [1.48, 0.84], [1.51, 0]] },
        { x: 0.92, pts: [[1.43, 0.955], [1.46, 0.945], [1.92, 0.865], [1.975, 0.80], [2.022, 0]] },
        { x: 0.02, pts: [[1.43, 0.955], [1.46, 0.945], [1.925, 0.865], [1.98, 0.80], [2.027, 0]] },
        { x: -0.09, pts: [[1.43, 0.955], [1.46, 0.945], [1.925, 0.865], [1.98, 0.80], [2.027, 0]] },
        { x: -0.86, pts: [[1.43, 0.955], [1.46, 0.945], [1.92, 0.865], [1.975, 0.80], [2.02, 0]] },
        { x: -1.13, pts: [[1.43, 0.94], [1.455, 0.93], [1.885, 0.85], [1.93, 0.79], [1.955, 0]] }
      ],
      mats: [
        ['paint', 'glass', 'glass', 'glass'],      // windscreen + front quarter glass up to the A-pillar
        ['paint', 'glass', 'paint', 'paint'],      // front door glass, roof
        ['paint', 'gloss', 'paint', 'paint'],      // B-pillar (gloss black)
        ['paint', 'glass', 'paint', 'paint'],      // rear door glass
        ['paint', 'paint', 'paint', 'paint']       // C-pillar + back glass (rear-view part)
      ],
      capF: null, capR: 'paint'
    },
    parts: [].concat(
      // grille: grey-bezel frame round a dark inset with mesh bars, a gloss bar through the middle carrying the
      // extended block FORD letters (they span most of the grille), three amber clearance lamps along the top edge
      polys([rect(-0.67, 0.955, 0.67, 1.425)], 'front', 'chrome', 0.004, false),
      polys([rect(-0.645, 0.978, 0.645, 1.402)], 'front', 'grille', 0.007, false),
      polys([1.012, 1.05, 1.088, 1.262, 1.30, 1.338, 1.372].map(function (y) { return rect(-0.62, y, 0.62, y + 0.012); }), 'front', 'black', 0.009, false),
      polys([rect(-0.635, 1.11, 0.635, 1.24)], 'front', 'gloss', 0.011, false),
      polys(word('FORD', 0, 1.175, 0.10, -1, 2.45), 'front', 'badge', 0.014, false),
      polys([-0.16, 0, 0.16].map(function (zc) { return rect(zc - 0.045, 1.405, zc + 0.045, 1.42); }), 'front', 'indicator', 0.012, false),
      // C-clamp headlamps: dark housing, a bright C-shaped LED guide wrapping the projector (open inboard), a
      // small chrome-ringed dark lens pair inside, amber turn strip under the C
      polys([rect(0.66, 1.17, 1.0, 1.425)], 'front', 'gloss', 0.006, true),
      polys([[[0.72, 1.395], [0.985, 1.395], [0.985, 1.205], [0.72, 1.205], [0.72, 1.228], [0.958, 1.228], [0.958, 1.372], [0.72, 1.372]]], 'front', 'drl', 0.011, true),
      polys([rect(0.745, 1.255, 0.925, 1.345)], 'front', 'chrome', 0.009, true),
      polys([rect(0.76, 1.268, 0.83, 1.332), rect(0.845, 1.268, 0.912, 1.332)], 'front', 'grille', 0.011, true),
      polys([ell(0.795, 1.30, 0.02, 0.02, 6), ell(0.878, 1.30, 0.02, 0.02, 6)], 'front', 'light', 0.013, true),
      polys([rect(0.72, 1.18, 0.985, 1.195)], 'front', 'indicator', 0.011, true),
      // lower bumper: black side sections with dark fog pods (small round lenses), grey/silver skid centre, tow hooks
      polys([rect(-1.0, 0.62, 1.0, 0.925)], 'front', 'black', 0.005, false),
      polys([[[-0.46, 0.665], [0.46, 0.665], [0.42, 0.875], [-0.42, 0.875]]], 'front', 'grille', 0.008, false),
      polys([0.72, 0.775, 0.83].map(function (y) { return rect(-0.43, y, 0.43, y + 0.012); }), 'front', 'black', 0.010, false),
      polys([rect(0.60, 0.74, 0.88, 0.83)], 'front', 'gloss', 0.008, true),
      polys([ell(0.68, 0.785, 0.035, 0.03, 6), ell(0.80, 0.785, 0.035, 0.03, 6)], 'front', 'chrome', 0.010, true),
      polys([[[-0.66, 0.555], [0.66, 0.555], [0.62, 0.67], [-0.62, 0.67]]], 'front', 'chrome', 0.009, false),
      // hood heat extractors on the leading corners
      polys([rect(2.28, 0.50, 2.56, 0.555), rect(2.28, 0.595, 2.56, 0.65)], 'top', 'black', 0.004, true),
      // cab: rear window, third brake light, roof clearance lamps
      polys([rect(-0.64, 1.50, 0.64, 1.86)], 'rear', 'glass', 0.005, false),
      polys([rect(-0.14, 1.89, 0.14, 1.925)], 'rear', 'tail', 0.008, false),
      // rear: tall tail lamps from the bed rail down (white reverse block in the middle), dark full-width tailgate
      // band with extended FORD letters, handle, dark bumper + step pads, plate
      polys([rect(0.80, 0.93, 0.985, 1.475)], 'rear', 'tail', 0.006, true),
      polys([rect(0.835, 1.10, 0.95, 1.235)], 'rear', 'rev', 0.009, true),
      polys([rect(-0.79, 1.00, 0.79, 1.235)], 'rear', 'gloss', 0.005, false),
      polys(word('FORD', 0, 1.118, 0.11, 1, 2.3), 'rear', 'badge', 0.009, false),
      polys([rect(-0.11, 1.33, 0.11, 1.375)], 'rear', 'black', 0.008, false),
      polys([rect(-1.03, 0.60, 1.03, 0.88)], 'rear', 'black', 0.005, false),
      polys([rect(0.66, 0.845, 0.98, 0.875)], 'rear', 'gloss', 0.008, true),
      polys([rect(-0.155, 0.665, 0.155, 0.815)], 'rear', 'plate', 0.009, false),
      // door handles, RAPTOR lettering on the bed sides (each flank reads front -> rear... i.e. left to right)
      polys([rect(0.02, 1.245, 0.16, 1.28), rect(-0.98, 1.245, -0.84, 1.28)], 'side', 'black', 0.004, true),
      polys(word('RAPTOR', -1.72, 1.375, 0.075, 1, 1.3), 'side', 'gloss', 0.005, false),
      polys(word('RAPTOR', -1.72, 1.375, 0.075, -1, 1.3), 'left', 'gloss', 0.005, false),
      // flat-topped black flares over both axles
      flare(1.8466, 0.4364, 0.49, 0.68, 0.93, 1.14, 'black', 6, true),
      flare(-1.8466, 0.4364, 0.49, 0.68, 0.93, 1.14, 'black', 6, true),
      [
        // rock rails, bed-rail caps, black tow mirrors on black arms (mirror glass facing back),
        // roof clearance lamps, front tow hooks, hitch receiver
        { t: 'box', mat: 'black', mirror: true, c: [0.0, 0.47, 1.02], s: [2.25, 0.06, 0.16] },
        { t: 'box', mat: 'black', mirror: true, c: [-2.11, 1.51, 0.955], s: [1.86, 0.025, 0.12] },
        { t: 'prism', mat: 'gloss', mirror: true, z0: 1.0, z1: 1.26, pts2d: [[1.40, 1.465], [1.17, 1.46], [1.17, 1.695], [1.36, 1.70]] },
        { t: 'poly', mat: 'glass', mirror: true, normal: [-1, 0, 0], pts: [[1.164, 1.48, 1.02], [1.164, 1.48, 1.245], [1.164, 1.68, 1.245], [1.164, 1.68, 1.02]] },
        { t: 'box', mat: 'black', mirror: true, c: [1.30, 1.475, 0.97], s: [0.12, 0.05, 0.08] },
        { t: 'box', mat: 'indicator', c: [0.84, 2.03, 0.0], s: [0.04, 0.016, 0.06] },
        { t: 'box', mat: 'indicator', c: [0.84, 2.03, 0.16], s: [0.04, 0.016, 0.06] },
        { t: 'box', mat: 'indicator', c: [0.84, 2.03, -0.16], s: [0.04, 0.016, 0.06] },
        { t: 'box', mat: 'black', mirror: true, c: [2.83, 0.635, 0.44], s: [0.09, 0.055, 0.045] },
        { t: 'box', mat: 'black', c: [-3.15, 0.55, 0], s: [0.14, 0.075, 0.075] }
      ]
    ),
    // twin tips under the rear bumper ends (rap-r34 photo)
    exhaust: [{ cx: 0.52, cy: 0.6, w: 0.11, shape: 'round', mirror: true }],
    wheels: { style: 'star', spokes: 6, tyre: 'at' },
    notes: 'Ford F-150 Raptor (gen 3) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2021_Ford_F-150_Raptor,_front.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2021_Ford_F-150_Raptor,_rear.jpg (rear 3/4).'
  };
  // shoulder crease: the flank leans out to a sharp horizontal crease a hand below the belt and tucks back in
  // above it (both trucks carry one along the doors and the bed), so the light splits the slab side in two
  RAPTOR.body.stations.forEach(function (st) {
    var a = st.pts[3], b = st.pts[4];
    if (Math.abs(a[1] - b[1]) < 0.015) { a[1] -= 0.015; b[0] -= 0.03; b[1] += 0.03; }
  });
  reg('ford-f150-raptor-gen3', RAPTOR);

  // exported for authors / tests
  LP.helpers = LP.helpers || { ell: ell, rect: rect, word: word, flare: flare, polys: polys };
  if (typeof module !== 'undefined' && module.exports) module.exports = { 'porsche-911-992': P911, 'ford-f150-raptor-gen3': RAPTOR };
})();

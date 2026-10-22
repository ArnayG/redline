/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/suv.js
   Hand-authored low-poly SUVs (docs/LOWPOLY-SPEC.md): Porsche Cayenne (E3 facelift), Range Rover Sport (L461),
   Lamborghini Urus, Jeep Wrangler Unlimited Rubicon (JL).

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body / cabin stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.
   Body ring points (all four cars):  0 bottom centre, 1 bottom edge, 2 rocker / lower flank, 3 waist (door
   widest), 4 shoulder, 5 belt / wing crown, 6 hood edge (or belt inner under the cabin), 7 hood mid, 8 centre.
   Cabin ring points: 0 belt (sits on the body), 1 glass base, 2 glass top, 3 roof rail, 4 roof edge, 5 centre.
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
  function ell(a, b, ra, rb, n, rot) {
    var out = [], r = rot || 0;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n * Math.PI * 2, u = Math.cos(t) * ra, v = Math.sin(t) * rb;
      out.push([a + u * Math.cos(r) - v * Math.sin(r), b + u * Math.sin(r) + v * Math.cos(r)]);
    }
    return out;
  }
  function rect(a0, b0, a1, b1) { return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]; }
  /** arch band (side profile ring segments) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, a0d, a1d) {
    var parts = [], n = segs || 6, A0 = (a0d == null ? 0 : a0d) * Math.PI / 180, A1 = (a1d == null ? 180 : a1d) * Math.PI / 180;
    for (var k = 0; k < n; k++) {
      var a0 = A0 + (A1 - A0) * k / n, a1 = A0 + (A1 - A0) * (k + 1) / n;
      var P = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, a0), P(rOut, a0), P(rOut, a1), P(rIn, a1)] });
    }
    return parts;
  }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  function rows(n, row) { var out = []; for (var i = 0; i < n; i++) out.push(row.slice()); return out; }

  /* ================================================================ Porsche Cayenne (E3 / 9Y0 facelift, 2023–) */
  // Reference photos (Wikimedia Commons):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Porsche_Cayenne_(III,_Facelift)_–_f_01012025.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Porsche_Cayenne_(III,_Facelift)_–_h_01012025.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Porsche_Cayenne_S_(III,_Facelift)_–_f_22022025.jpg
  // Signature: wings standing proud of a domed bonnet with slim lamps + four-point DRL, no upper grille, wide
  // trapezoid lower intake with slatted corner intakes; roof falling gently into a spoiler over a raked
  // tailgate; full-width light strip with PORSCHE lettering; black sills, roof rails, quad tailpipes.
  var CAY = {
    body: {
      stations: [
        { x: 2.42, pts: [[0.36, 0], [0.36, 0.55], [0.4, 0.66], [0.55, 0.7], [0.73, 0.7], [0.82, 0.66], [0.84, 0.55], [0.85, 0.3], [0.85, 0]] },
        { x: 2.37, pts: [[0.28, 0], [0.28, 0.7], [0.34, 0.8], [0.55, 0.83], [0.775, 0.82], [0.9, 0.77], [0.925, 0.64], [0.935, 0.32], [0.935, 0]] },
        { x: 2.22, pts: [[0.27, 0], [0.27, 0.82], [0.32, 0.9], [0.6, 0.93], [0.84, 0.925], [0.985, 0.86], [1.005, 0.72], [0.975, 0.36], [0.965, 0]] },
        { x: 1.95, pts: [[0.3, 0], [0.3, 0.87], [0.36, 0.95], [0.66, 0.978], [0.905, 0.975], [1.05, 0.9], [1.07, 0.75], [1.025, 0.38], [1.012, 0]] },
        { x: 1.42, pts: [[0.31, 0], [0.31, 0.88], [0.37, 0.955], [0.7, 0.985], [0.93, 0.985], [1.105, 0.905], [1.125, 0.75], [1.085, 0.38], [1.075, 0]] },
        { x: 1.03, pts: [[0.31, 0], [0.31, 0.875], [0.37, 0.95], [0.72, 0.975], [0.955, 0.965], [1.155, 0.875], [1.17, 0.75], [1.16, 0.38], [1.155, 0]] },
        { x: 0.30, pts: [[0.3, 0], [0.3, 0.865], [0.37, 0.935], [0.62, 0.95], [0.93, 0.948], [1.185, 0.868], [1.19, 0.8], [1.19, 0.4], [1.19, 0]] },
        { x: -0.60, pts: [[0.3, 0], [0.3, 0.865], [0.37, 0.935], [0.64, 0.95], [0.98, 0.952], [1.2, 0.87], [1.205, 0.8], [1.205, 0.4], [1.205, 0]] },
        { x: -1.45, pts: [[0.32, 0], [0.32, 0.875], [0.38, 0.96], [0.7, 0.99], [1.068, 0.988], [1.21, 0.862], [1.22, 0.78], [1.22, 0.4], [1.22, 0]] },
        { x: -1.95, pts: [[0.33, 0], [0.33, 0.88], [0.4, 0.96], [0.7, 0.985], [1.075, 0.975], [1.225, 0.835], [1.24, 0.74], [1.24, 0.4], [1.24, 0]] },
        { x: -2.37, pts: [[0.31, 0], [0.31, 0.85], [0.38, 0.92], [0.62, 0.945], [0.935, 0.935], [1.13, 0.78], [1.23, 0.62], [1.265, 0.32], [1.265, 0]] },
        { x: -2.46, pts: [[0.31, 0], [0.31, 0.79], [0.37, 0.855], [0.6, 0.875], [0.87, 0.85], [1.01, 0.72], [1.06, 0.58], [1.08, 0.3], [1.08, 0]] },
        { x: -2.505, pts: [[0.38, 0], [0.38, 0.7], [0.42, 0.77], [0.6, 0.79], [0.8, 0.78], [0.9, 0.72], [0.93, 0.6], [0.94, 0.3], [0.94, 0]] }
      ],
      mats: rows(12, ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint']),
      capF: 'paint', capR: 'paint'
    },
    cabin: {
      stations: [
        { x: 1.04, pts: [[1.16, 0.875], [1.162, 0.85], [1.165, 0.77], [1.167, 0.7], [1.168, 0.6], [1.17, 0]] },
        { x: 0.14, pts: [[1.195, 0.865], [1.215, 0.845], [1.565, 0.69], [1.6, 0.64], [1.625, 0.54], [1.635, 0]] },
        { x: -0.50, pts: [[1.2, 0.865], [1.22, 0.845], [1.592, 0.69], [1.635, 0.64], [1.67, 0.545], [1.682, 0]] },
        { x: -0.62, pts: [[1.202, 0.865], [1.222, 0.845], [1.592, 0.69], [1.637, 0.64], [1.672, 0.545], [1.685, 0]] },
        { x: -1.45, pts: [[1.215, 0.855], [1.245, 0.835], [1.518, 0.68], [1.58, 0.628], [1.614, 0.53], [1.626, 0]] },
        { x: -1.56, pts: [[1.22, 0.85], [1.255, 0.83], [1.492, 0.672], [1.562, 0.62], [1.598, 0.522], [1.61, 0]] },
        { x: -1.80, pts: [[1.225, 0.835], [1.32, 0.8], [1.395, 0.66], [1.5, 0.595], [1.543, 0.505], [1.555, 0]] },
        { x: -2.00, pts: [[1.22, 0.815], [1.25, 0.79], [1.345, 0.655], [1.445, 0.575], [1.49, 0.475], [1.5, 0]] },
        { x: -2.37, pts: [[1.265, 0.62], [1.265, 0.61], [1.265, 0.58], [1.265, 0.54], [1.265, 0.46], [1.265, 0]] }
      ],
      mats: [
        ['black', 'glass', 'paint', 'glass', 'glass'],     // windscreen (front door glass runs up to the slim A-pillar)
        ['black', 'glass', 'paint', 'paint', 'paint2'],    // front door glass
        ['black', 'gloss', 'paint', 'paint', 'paint2'],    // B-pillar
        ['black', 'glass', 'paint', 'paint', 'paint2'],    // rear door glass
        ['black', 'gloss', 'paint', 'paint', 'paint2'],    // C-pillar
        ['paint', 'glass', 'paint', 'paint', 'paint2'],    // rear quarter glass (lower edge kicks up)
        ['paint', 'paint', 'paint', 'paint', 'paint2'],    // D-pillar
        ['black', 'paint', 'paint', 'glass', 'glass']      // tailgate glass framed by thick D-pillars
      ],
      capF: null, capR: null
    },
    parts: [].concat(
      // headlamps: slim lozenge following the wing line, gloss bezel, lamp, four-point DRL
      polys([[[0.45, 0.872], [0.62, 0.846], [0.82, 0.85], [0.945, 0.885], [0.972, 0.95], [0.925, 0.995], [0.70, 0.992], [0.50, 0.95]]], 'front', 'gloss', 0.006, true),
      polys([[[0.49, 0.886], [0.63, 0.864], [0.81, 0.868], [0.925, 0.898], [0.948, 0.947], [0.91, 0.978], [0.70, 0.976], [0.53, 0.944]]], 'front', 'light', 0.009, true),
      polys([[0.60, 0.895], [0.71, 0.895], [0.60, 0.94], [0.71, 0.94]].map(function (c) { return rect(c[0], c[1], c[0] + 0.08, c[1] + 0.02); }), 'front', 'drl', 0.012, true),
      // no upper grille: slim cooling slot
      polys([rect(-0.26, 0.705, 0.26, 0.722)], 'front', 'grille', 0.005, false),
      // wide trapezoid lower intake, slatted corner intakes with a silver blade, plate
      polys([[[-0.58, 0.31], [0.58, 0.31], [0.61, 0.66], [-0.61, 0.66]]], 'front', 'grille', 0.004, false),
      polys([0.405, 0.475, 0.545, 0.615].map(function (y) { return rect(-0.57, y, 0.57, y + 0.012); }), 'front', 'gloss', 0.007, false),
      polys([[[0.64, 0.36], [0.93, 0.33], [0.945, 0.73], [0.66, 0.75]]], 'front', 'grille', 0.004, true),
      polys([rect(0.65, 0.585, 0.935, 0.607)], 'front', 'chrome', 0.007, true),
      polys([rect(-0.26, 0.335, 0.26, 0.445)], 'front', 'plate', 0.009, false),
      // rear (E3 facelift): smoked full-width light bar, a thin lit line along its lower edge, PORSCHE lettering in
      // the bar, 3D lamp ends (red lens with three lit slats, reverse + indicator segments inboard), Cayenne script
      [{ t: 'poly', view: 'rear', mat: 'smoke', offset: 0.005, pts: [[-0.84, 1.088], [0.84, 1.088], [0.85, 1.158], [-0.85, 1.158]] }],
      [{ t: 'poly', view: 'rear', mat: 'tail', offset: 0.008, pts: [[-0.60, 1.093], [0.60, 1.093], [0.60, 1.106], [-0.60, 1.106]] }],
      [{ t: 'text', view: 'rear', str: 'PORSCHE', at: [0, 1.128], h: 0.03, mat: 'badge', weight: 0.13, spacing: 3.2, maxTilt: 35 }],
      [{ t: 'poly', view: 'rear', mat: 'lens', mirror: true, offset: 0.009, pts: [[0.60, 1.09], [0.84, 1.092], [0.85, 1.157], [0.60, 1.156]] }],
      [1.100, 1.120, 1.140].map(function (y) { return { t: 'poly', view: 'rear', mat: 'tail', mirror: true, offset: 0.013, pts: [[0.66, y], [0.845, y + 0.002], [0.847, y + 0.010], [0.66, y + 0.008]] }; }),
      [{ t: 'poly', view: 'rear', mat: 'rev', mirror: true, offset: 0.013, pts: [[0.615, 1.112], [0.645, 1.112], [0.645, 1.138], [0.615, 1.138]] }],
      [{ t: 'poly', view: 'rear', mat: 'indicator', mirror: true, offset: 0.013, pts: [[0.66, 1.147], [0.84, 1.148], [0.84, 1.154], [0.66, 1.153]] }],
      [{ t: 'text', view: 'rear', str: 'Cayenne', at: [0.42, 1.055], h: 0.024, mat: 'badge', weight: 0.12, skew: 0.25 }],
      // low LOD: the light bar alone (one quad) instead of a per-side block spanning bar + bumper reflectors
      [{ t: 'poly', view: 'rear', mat: 'tail', low: 'only', offset: 0.006, maxTilt: 35, pts: [[-0.76, 1.09], [0.76, 1.09], [0.76, 1.155], [-0.76, 1.155]] }],
      // tailgate shut lines (the lid wraps round the lamp ends and drops to the bumper line), wiper on the screen
      polys([rect(0.605, 0.72, 0.615, 1.085), rect(-0.615, 0.72, 0.615, 0.728)], 'rear', 'gloss', 0.004, true),
      polys([[[0.04, 1.33], [0.44, 1.385], [0.44, 1.398], [0.04, 1.345]]], 'rear', 'black', 0.004, false),
      polys([ell(0.04, 1.337, 0.018, 0.018, 6)], 'rear', 'black', 0.005, false),
      // plate recess + plate + plate lights, parking-sensor dots, bumper reflectors, diffuser with silver trim + fins
      polys([rect(-0.29, 0.545, 0.29, 0.69)], 'rear', 'gloss', 0.004, false),
      polys([rect(-0.26, 0.56, 0.26, 0.67)], 'rear', 'plate', 0.007, false),
      polys([rect(-0.20, 0.676, -0.14, 0.684), rect(0.14, 0.676, 0.20, 0.684)], 'rear', 'white', 0.008, false),
      polys([ell(0.38, 0.50, 0.014, 0.014, 6), ell(0.66, 0.49, 0.014, 0.014, 6)], 'rear', 'paint', 0.006, true),
      polys([[[0.74, 0.47], [0.90, 0.48], [0.90, 0.505], [0.74, 0.495]]], 'rear', 'lens', 0.006, true),
      polys([[[-0.80, 0.27], [0.80, 0.27], [0.84, 0.43], [-0.84, 0.43]]], 'rear', 'black', 0.004, false),
      polys([rect(-0.82, 0.415, 0.82, 0.428)], 'rear', 'chrome', 0.006, false),
      polys([-0.32, -0.16, 0, 0.16, 0.32].map(function (z) { return rect(z - 0.012, 0.275, z + 0.012, 0.39); }), 'rear', 'gloss', 0.006, false),
      // tail lamps wrapping round the rear corners (seen from the side)
      polys([[[-2.30, 1.15], [-2.47, 1.14], [-2.48, 1.095], [-2.33, 1.115]]], 'side', 'tail', 0.006, true),
      // door handles
      polys([rect(0.02, 1.02, 0.17, 1.045), rect(-0.86, 1.03, -0.71, 1.055)], 'side', 'black', 0.004, true),
      // raked quarter-window trailing edge (parallel to the tailgate glass): body-colour wedge over the rear of the
      // quarter glass, so the D-pillar leans forward instead of standing vertical like an estate's
      polys([[[-1.60, 1.51], [-1.83, 1.405], [-1.83, 1.30], [-1.78, 1.30]]], 'side', 'paint', 0.006, true),
      // body-colour arch lips standing proud of the flanks
      flare(1.4475, 0.394, 0.43, 0.475, 0.93, 0.988, 'paint', 6, 8, 172),
      flare(-1.4475, 0.394, 0.43, 0.475, 0.94, 0.992, 'paint', 6, 8, 172),
      [
        // roof spoiler over the tailgate glass, roof rails
        { t: 'prism', mat: 'paint', z0: -0.47, z1: 0.47, pts2d: [[-1.93, 1.53], [-2.16, 1.468], [-2.18, 1.443], [-2.03, 1.478]] },
        // third brake light under the spoiler's trailing edge, spoiler side fins
        { t: 'box', mat: 'tail', c: [-2.165, 1.452, 0], s: [0.012, 0.012, 0.36] },
        { t: 'prism', mat: 'gloss', mirror: true, z0: 0.47, z1: 0.49, pts2d: [[-1.95, 1.525], [-2.17, 1.463], [-2.17, 1.445], [-2.03, 1.47]] },
        { t: 'prism', mat: 'black', mirror: true, z0: 0.49, z1: 0.53, pts2d: [[-0.10, 1.65], [-0.60, 1.69], [-1.50, 1.632], [-1.90, 1.556], [-1.90, 1.536], [-1.50, 1.612], [-0.60, 1.67], [-0.10, 1.63]] },
        // door mirrors: body-colour housing on a black foot
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.82, z1: 1.06, pts2d: [[0.86, 1.175], [0.68, 1.175], [0.67, 1.285], [0.83, 1.295]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.80, 1.17, 0.87], s: [0.12, 0.05, 0.08] }
      ]
    ),
    wheels: { style: 'y', spokes: 5 },
    notes: 'Porsche Cayenne (E3 facelift) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_Cayenne_(III,_Facelift)_–_f_01012025.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_Cayenne_(III,_Facelift)_–_h_01012025.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_Cayenne_S_(III,_Facelift)_–_f_22022025.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2018_Porsche_Cayenne_(9YA_MY19)_Turbo_4WD_wagon_(2018-09-28)_02.jpg (side: belt ~1.20 m, roof falling into the spoiler, raked D-pillar), ' +
      'https://commons.wikimedia.org/wiki/File:Porsche_PO536_Cayenne_Turbo_E-Hybrid_IAA_2023_1X7A0537.jpg (rear 3/4).'
  };
  reg('porsche-cayenne-e3', CAY);

  /* ================================================================ Range Rover Sport (L461, 2022–) */
  // Reference photos (Wikimedia Commons):
  //   front:     https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Varesine_Blue_(10).jpg
  //   rear:      https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Varesine_Blue_(12).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Carpathian_Grey_(1).jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Carpathian_Grey_(3).jpg
  //   above:     https://commons.wikimedia.org/wiki/File:Range_Rover_Sport_(L461)_Washington_DC_Metro_Area,_USA.jpg
  // Signature: slab-sided reductive body, bluff upright nose with razor-slim lamps either side of a slim mesh
  // grille, long flat bonnet, floating roof (every pillar gloss black so the DLO reads as one dark band
  // tapering to the rear), slim tail lamps joined by a gloss black band with RANGE ROVER lettering.
  var RRS = {
    body: {
      stations: [
        { x: 2.413, pts: [[0.42, 0], [0.42, 0.62], [0.47, 0.73], [0.66, 0.77], [0.86, 0.77], [0.98, 0.73], [1.00, 0.63], [1.00, 0.32], [1.00, 0]] },
        { x: 2.385, pts: [[0.33, 0], [0.33, 0.78], [0.38, 0.87], [0.66, 0.91], [0.88, 0.91], [1.00, 0.87], [1.02, 0.72], [1.025, 0.34], [1.025, 0]] },
        { x: 2.24, pts: [[0.32, 0], [0.32, 0.89], [0.36, 0.955], [0.68, 0.985], [0.90, 0.99], [1.035, 0.93], [1.048, 0.77], [1.048, 0.38], [1.048, 0]] },
        { x: 1.85, pts: [[0.33, 0], [0.33, 0.90], [0.38, 0.97], [0.68, 1.0], [0.92, 1.015], [1.06, 0.955], [1.075, 0.79], [1.072, 0.40], [1.07, 0]] },
        { x: 1.30, pts: [[0.34, 0], [0.34, 0.90], [0.38, 0.972], [0.69, 1.005], [0.93, 1.02], [1.09, 0.955], [1.10, 0.79], [1.098, 0.40], [1.095, 0]] },
        { x: 0.95, pts: [[0.34, 0], [0.34, 0.90], [0.38, 0.972], [0.70, 1.005], [0.94, 1.015], [1.13, 0.95], [1.145, 0.80], [1.14, 0.40], [1.135, 0]] },
        { x: 0.20, pts: [[0.33, 0], [0.33, 0.90], [0.38, 0.97], [0.67, 1.0], [0.97, 0.99], [1.19, 0.885], [1.20, 0.80], [1.20, 0.40], [1.20, 0]] },
        { x: -0.80, pts: [[0.34, 0], [0.34, 0.90], [0.38, 0.97], [0.70, 1.0], [1.00, 0.99], [1.23, 0.87], [1.24, 0.80], [1.24, 0.40], [1.24, 0]] },
        { x: -1.60, pts: [[0.35, 0], [0.35, 0.91], [0.40, 0.985], [0.75, 1.018], [1.05, 0.99], [1.28, 0.86], [1.29, 0.78], [1.29, 0.40], [1.29, 0]] },
        { x: -2.10, pts: [[0.355, 0], [0.355, 0.90], [0.42, 0.97], [0.72, 1.0], [1.05, 0.965], [1.30, 0.83], [1.31, 0.74], [1.31, 0.40], [1.31, 0]] },
        { x: -2.39, pts: [[0.36, 0], [0.36, 0.87], [0.41, 0.93], [0.64, 0.95], [0.98, 0.925], [1.22, 0.81], [1.29, 0.70], [1.30, 0.38], [1.30, 0]] },
        { x: -2.49, pts: [[0.40, 0], [0.40, 0.80], [0.44, 0.87], [0.62, 0.895], [0.90, 0.885], [1.06, 0.80], [1.15, 0.67], [1.17, 0.36], [1.17, 0]] },
        { x: -2.532, pts: [[0.48, 0], [0.48, 0.68], [0.52, 0.77], [0.70, 0.81], [0.86, 0.81], [0.97, 0.75], [1.01, 0.63], [1.02, 0.32], [1.02, 0]] }
      ],
      mats: rows(12, ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint']),
      capF: 'paint', capR: 'paint'
    },
    cabin: {
      stations: [
        { x: 0.95, pts: [[1.135, 0.95], [1.14, 0.93], [1.143, 0.84], [1.146, 0.78], [1.148, 0.68], [1.15, 0]] },
        { x: 0.12, pts: [[1.19, 0.885], [1.21, 0.865], [1.665, 0.745], [1.725, 0.675], [1.758, 0.585], [1.768, 0]] },
        { x: -0.10, pts: [[1.20, 0.882], [1.22, 0.862], [1.69, 0.745], [1.755, 0.675], [1.795, 0.585], [1.806, 0]] },
        { x: -0.20, pts: [[1.205, 0.88], [1.225, 0.86], [1.695, 0.745], [1.76, 0.675], [1.80, 0.585], [1.812, 0]] },
        { x: -1.30, pts: [[1.252, 0.87], [1.272, 0.85], [1.672, 0.742], [1.735, 0.67], [1.772, 0.58], [1.782, 0]] },
        { x: -1.40, pts: [[1.256, 0.868], [1.276, 0.848], [1.662, 0.74], [1.728, 0.668], [1.765, 0.578], [1.775, 0]] },
        { x: -1.90, pts: [[1.295, 0.84], [1.315, 0.82], [1.55, 0.73], [1.672, 0.65], [1.708, 0.565], [1.716, 0]] },
        { x: -2.08, pts: [[1.308, 0.815], [1.328, 0.795], [1.49, 0.72], [1.632, 0.64], [1.672, 0.555], [1.68, 0]] },
        { x: -2.39, pts: [[1.30, 0.70], [1.30, 0.69], [1.30, 0.66], [1.30, 0.62], [1.30, 0.54], [1.30, 0]] }
      ],
      mats: [
        ['black', 'glass', 'gloss', 'glass', 'glass'],     // windscreen, gloss A-pillar
        ['black', 'glass', 'gloss', 'paint', 'paint2'],    // front door glass
        ['black', 'gloss', 'gloss', 'paint', 'paint2'],    // B-pillar
        ['black', 'glass', 'gloss', 'paint', 'paint2'],    // rear door glass
        ['black', 'gloss', 'gloss', 'paint', 'paint2'],    // C-pillar
        ['black', 'glass', 'gloss', 'paint', 'paint2'],    // tapering rear quarter glass
        ['black', 'gloss', 'gloss', 'paint', 'paint2'],    // gloss D-pillar (floating roof)
        ['black', 'gloss', 'gloss', 'glass', 'glass']      // tailgate glass inside a gloss frame
      ],
      capF: null, capR: null
    },
    parts: [].concat(
      // razor-slim headlamps with a DRL line along the top, slim mesh grille between them
      polys([rect(0.45, 0.875, 0.995, 0.962)], 'front', 'gloss', 0.004, true),
      polys([[[0.48, 0.885], [0.97, 0.885], [0.975, 0.935], [0.49, 0.94]]], 'front', 'light', 0.007, true),
      polys([rect(0.49, 0.943, 0.975, 0.955)], 'front', 'drl', 0.010, true),
      polys([rect(-0.44, 0.86, 0.44, 0.955)], 'front', 'grille', 0.004, false),
      [{ t: 'text', view: 'front', str: 'RANGE ROVER', at: [0, 1.0115], h: 0.017, mat: 'badge', weight: 0.14, spacing: 3, maxTilt: 40 }],
      // lower bumper: wide dark intake with a body-colour bar, corner blades, plate, dark lip
      polys([[[-0.86, 0.44], [0.86, 0.44], [0.90, 0.77], [-0.90, 0.77]]], 'front', 'grille', 0.004, false),
      polys([rect(0.66, 0.53, 0.86, 0.545)], 'front', 'chrome', 0.007, true),
      polys([rect(-0.26, 0.57, 0.26, 0.69)], 'front', 'plate', 0.008, false),
      polys([rect(-0.82, 0.36, 0.82, 0.45)], 'front', 'black', 0.004, false),
      // rear: slim tail lamps joined by a gloss band with RANGE ROVER lettering, plate, lower bumper
      // lamps: red lens housing, lit upper bar (two segments split by a dark gap), smoked lower strip, reverse inboard
      polys([[[0.56, 1.10], [0.90, 1.11], [0.905, 1.16], [0.56, 1.165]]], 'rear', 'lens', 0.007, true),
      polys([[[0.585, 1.124], [0.735, 1.127], [0.735, 1.158], [0.585, 1.158]], [[0.75, 1.127], [0.895, 1.131], [0.897, 1.157], [0.75, 1.158]]], 'rear', 'tail', 0.011, true),
      polys([[[0.585, 1.106], [0.895, 1.114], [0.897, 1.122], [0.585, 1.118]]], 'rear', 'smoke', 0.011, true),
      polys([rect(0.60, 1.107, 0.64, 1.118)], 'rear', 'rev', 0.014, true),
      polys([rect(-0.56, 1.10, 0.56, 1.165)], 'rear', 'gloss', 0.005, false),
      [{ t: 'text', view: 'rear', str: 'RANGE ROVER', at: [0, 1.1325], h: 0.028, mat: 'badge', weight: 0.12, spacing: 3.4, maxTilt: 40 }],
      [{ t: 'text', view: 'rear', str: 'SPORT', at: [-0.70, 1.065], h: 0.017, mat: 'gloss', weight: 0.16, spacing: 1.8 }],
      // low LOD: lamps + band as three flat quads
      [{ t: 'poly', view: 'rear', mat: 'tail', low: 'only', mirror: true, offset: 0.008, maxTilt: 30, pts: [[0.56, 1.105], [0.83, 1.11], [0.83, 1.16], [0.56, 1.16]] }],
      [{ t: 'poly', view: 'rear', mat: 'gloss', low: 'only', offset: 0.006, maxTilt: 30, pts: [[-0.56, 1.10], [0.56, 1.10], [0.56, 1.165], [-0.56, 1.165]] }],
      // tailgate shut lines: round under the lamp band, down the sides, across above the bumper plate recess
      polys([rect(0.60, 0.885, 0.61, 1.098)], 'rear', 'gloss', 0.004, true),
      polys([rect(-0.61, 0.878, 0.61, 0.886)], 'rear', 'gloss', 0.004, false),
      // plate in a shallow trapezoid recess in the bumper, plate lights, sensor dots, reflectors
      polys([[[-0.34, 0.72], [0.34, 0.72], [0.30, 0.865], [-0.30, 0.865]]], 'rear', 'gloss', 0.004, false),
      polys([rect(-0.26, 0.74, 0.26, 0.85)], 'rear', 'plate', 0.007, false),
      polys([rect(-0.18, 0.853, -0.12, 0.86), rect(0.12, 0.853, 0.18, 0.86)], 'rear', 'white', 0.008, false),
      polys([ell(0.26, 0.58, 0.013, 0.013, 6), ell(0.56, 0.585, 0.013, 0.013, 6)], 'rear', 'gloss', 0.006, true),
      polys([rect(0.70, 0.60, 0.88, 0.616)], 'rear', 'lens', 0.006, true),
      // black diffuser with a recessed centre panel and silver trim, rectangular tips with chrome surrounds
      polys([rect(-0.86, 0.34, 0.86, 0.52)], 'rear', 'gloss', 0.004, false),
      polys([rect(-0.86, 0.515, 0.86, 0.527)], 'rear', 'chrome', 0.006, false),
      polys([[[-0.30, 0.35], [0.30, 0.35], [0.33, 0.47], [-0.33, 0.47]]], 'rear', 'black', 0.007, false),
      polys([rect(0.42, 0.40, 0.66, 0.47)], 'rear', 'chrome', 0.007, true),
      polys([rect(0.432, 0.41, 0.648, 0.46)], 'rear', 'grille', 0.010, true),
      // flush door handles, side gill on the front door
      polys([rect(0.05, 1.10, 0.22, 1.115), rect(-0.95, 1.12, -0.78, 1.135)], 'side', 'gloss', 0.004, true),
      polys([[[0.95, 0.80], [0.60, 0.80], [0.60, 0.82], [0.95, 0.835]]], 'side', 'gloss', 0.004, true),
      [
        // roof spoiler, door mirrors
        { t: 'prism', mat: 'gloss', z0: -0.58, z1: 0.58, pts2d: [[-1.98, 1.712], [-2.20, 1.672], [-2.22, 1.652], [-2.00, 1.688]] },
        // wide slim third brake light along the spoiler's trailing edge
        { t: 'box', mat: 'tail', c: [-2.214, 1.665, 0], s: [0.012, 0.012, 0.42] },
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.85, z1: 1.09, pts2d: [[0.86, 1.19], [0.66, 1.19], [0.65, 1.31], [0.82, 1.31]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.80, 1.19, 0.90], s: [0.12, 0.04, 0.08] }
      ]
    ),
    wheels: { style: 'y', spokes: 5 },
    notes: 'Range Rover Sport (L461) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Varesine_Blue_(10).jpg (front), ' +
      'https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Varesine_Blue_(12).jpg (rear), ' +
      'https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Carpathian_Grey_(1).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Land_Rover_Range_Rover_Sport_L461_Carpathian_Grey_(3).jpg (rear 3/4).'
  };
  reg('range-rover-sport-l461', RRS);

  /* ================================================================ Lamborghini Urus (2018–2022) */
  // Reference photos (Wikimedia Commons):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2019_Lamborghini_Urus_V8_Automatic_4.0_Front.jpg
  //   front:     https://commons.wikimedia.org/wiki/File:Lamborghini_Urus_front_view_dllu.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2019_Lamborghini_Urus_V8_Automatic_4.0_Rear.jpg
  //   side:      https://commons.wikimedia.org/wiki/File:Lamborghini_Urus_Performante_(2024)_(53621960053).jpg
  // Signature: super-SUV wedge — very low bonnet, steeply raked screen, coupe roof falling straight to a lip
  // over the tailgate; Y-blade lamps; huge hexagonal lower intakes split by body-colour Y bars; angular black
  // arch cladding and sills; Y tail lamps, LAMBORGHINI tailgate lettering, quad trapezoid pipes.
  var URUS = {
    body: {
      stations: [
        { x: 2.51, pts: [[0.32, 0], [0.32, 0.48], [0.35, 0.55], [0.45, 0.585], [0.56, 0.585], [0.62, 0.555], [0.64, 0.45], [0.645, 0.24], [0.645, 0]] },
        { x: 2.45, pts: [[0.27, 0], [0.27, 0.66], [0.31, 0.72], [0.48, 0.745], [0.64, 0.735], [0.71, 0.68], [0.725, 0.52], [0.73, 0.26], [0.73, 0]] },
        { x: 2.28, pts: [[0.26, 0], [0.26, 0.86], [0.30, 0.925], [0.55, 0.945], [0.72, 0.935], [0.80, 0.87], [0.805, 0.66], [0.795, 0.32], [0.79, 0]] },
        { x: 2.00, pts: [[0.27, 0], [0.27, 0.93], [0.31, 0.975], [0.60, 0.985], [0.80, 1.003], [0.87, 0.935], [0.83, 0.72], [0.865, 0.42], [0.835, 0]] },
        { x: 1.20, pts: [[0.28, 0], [0.28, 0.935], [0.33, 0.985], [0.62, 0.985], [0.87, 1.008], [0.945, 0.925], [0.91, 0.72], [0.955, 0.36], [0.92, 0]] },
        { x: 0.72, pts: [[0.27, 0], [0.27, 0.90], [0.32, 0.955], [0.62, 0.955], [0.90, 0.978], [0.995, 0.90], [0.985, 0.74], [1.005, 0.30], [0.995, 0]] },
        { x: 0.00, pts: [[0.27, 0], [0.27, 0.88], [0.32, 0.935], [0.66, 0.935], [0.95, 0.962], [1.05, 0.885], [1.06, 0.80], [1.06, 0.40], [1.06, 0]] },
        { x: -0.90, pts: [[0.28, 0], [0.28, 0.88], [0.33, 0.935], [0.68, 0.94], [0.98, 0.968], [1.10, 0.875], [1.11, 0.80], [1.11, 0.40], [1.11, 0]] },
        { x: -1.55, pts: [[0.285, 0], [0.285, 0.90], [0.34, 0.965], [0.72, 0.975], [1.03, 1.012], [1.15, 0.88], [1.16, 0.80], [1.16, 0.40], [1.16, 0]] },
        { x: -2.05, pts: [[0.29, 0], [0.29, 0.90], [0.34, 0.965], [0.72, 0.975], [1.05, 1.0], [1.21, 0.86], [1.23, 0.78], [1.23, 0.40], [1.23, 0]] },
        { x: -2.43, pts: [[0.29, 0], [0.29, 0.86], [0.34, 0.93], [0.70, 0.955], [0.96, 0.94], [1.18, 0.84], [1.275, 0.74], [1.31, 0.40], [1.31, 0]] },
        { x: -2.53, pts: [[0.30, 0], [0.30, 0.80], [0.34, 0.87], [0.62, 0.89], [0.92, 0.88], [1.08, 0.79], [1.16, 0.67], [1.20, 0.36], [1.20, 0]] },
        { x: -2.598, pts: [[0.44, 0], [0.44, 0.66], [0.47, 0.74], [0.62, 0.78], [0.86, 0.78], [0.94, 0.72], [0.96, 0.60], [0.97, 0.32], [0.97, 0]] }
      ],
      mats: rows(12, ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint']),
      capF: 'paint', capR: 'paint'
    },
    cabin: {
      stations: [
        { x: 0.72, pts: [[0.995, 0.90], [0.997, 0.88], [0.998, 0.80], [0.999, 0.74], [1.0, 0.62], [1.0, 0]] },
        { x: -0.28, pts: [[1.07, 0.875], [1.085, 0.858], [1.52, 0.65], [1.58, 0.585], [1.607, 0.49], [1.617, 0]] },
        { x: -0.75, pts: [[1.095, 0.875], [1.11, 0.858], [1.55, 0.655], [1.605, 0.59], [1.628, 0.495], [1.636, 0]] },
        { x: -0.85, pts: [[1.10, 0.875], [1.115, 0.858], [1.55, 0.655], [1.605, 0.59], [1.628, 0.495], [1.636, 0]] },
        { x: -1.70, pts: [[1.155, 0.88], [1.17, 0.862], [1.47, 0.68], [1.53, 0.605], [1.555, 0.50], [1.562, 0]] },
        { x: -1.92, pts: [[1.20, 0.865], [1.215, 0.848], [1.43, 0.69], [1.48, 0.61], [1.50, 0.50], [1.505, 0]] },
        { x: -2.43, pts: [[1.31, 0.74], [1.31, 0.73], [1.31, 0.68], [1.31, 0.62], [1.31, 0.52], [1.31, 0]] }
      ],
      mats: [
        ['black', 'glass', 'paint', 'glass', 'glass'],     // windscreen
        ['black', 'glass', 'paint', 'paint', 'paint2'],    // front door glass
        ['black', 'gloss', 'paint', 'paint', 'paint2'],    // B-pillar
        ['black', 'glass', 'paint', 'paint', 'paint2'],    // rear door glass
        ['black', 'glass', 'paint', 'paint', 'paint2'],    // rear glass kicks up to a point
        ['black', 'paint', 'glass', 'glass', 'glass']      // rear screen
      ],
      capF: null, capR: null
    },
    parts: [].concat(
      // Y-blade headlamps: slim lamp, blade DRL along the top with a downward Y branch
      polys([[[0.40, 0.705], [0.62, 0.70], [0.88, 0.715], [0.97, 0.745], [0.975, 0.785], [0.90, 0.80], [0.62, 0.79], [0.44, 0.745]]], 'front', 'gloss', 0.006, true),
      polys([[[0.44, 0.712], [0.62, 0.708], [0.86, 0.722], [0.95, 0.748], [0.955, 0.777], [0.88, 0.788], [0.62, 0.78], [0.47, 0.742]]], 'front', 'light', 0.009, true),
      polys([[[0.50, 0.772], [0.90, 0.778], [0.90, 0.79], [0.50, 0.784]], [[0.70, 0.776], [0.72, 0.776], [0.66, 0.715], [0.64, 0.715]]], 'front', 'drl', 0.012, true),
      // huge hex lower intakes split by body-colour Y bars
      polys([[[-0.50, 0.30], [0.50, 0.30], [0.56, 0.52], [0.40, 0.60], [-0.40, 0.60], [-0.56, 0.52]]], 'front', 'grille', 0.004, false),
      polys([[[0.56, 0.30], [0.97, 0.32], [0.97, 0.66], [0.62, 0.66], [0.52, 0.56]]], 'front', 'grille', 0.004, true),
      polys([rect(0.66, 0.425, 0.95, 0.44), rect(0.66, 0.50, 0.95, 0.515), rect(0.66, 0.575, 0.95, 0.59)], 'front', 'paint', 0.007, true),
      polys([[[0.46, 0.62], [0.52, 0.62], [0.60, 0.33], [0.55, 0.32]]], 'front', 'paint', 0.007, true),
      polys([rect(-0.20, 0.43, 0.20, 0.54)], 'front', 'plate', 0.008, false),
      // rear: Y tail lamps, gloss band with LAMBORGHINI lettering, black diffuser with quad pipes, plate
      // arrow-shaped smoked lamps pointing outboard; lit blades along top and bottom converge on the tip (the Y),
      // a short centre stem from the tip, reverse segment inboard
      polys([[[0.56, 1.112], [0.86, 1.104], [0.95, 1.14], [0.87, 1.176], [0.58, 1.178]]], 'rear', 'smoke', 0.005, true),
      polys([[[0.59, 1.160], [0.865, 1.158], [0.862, 1.168], [0.59, 1.170]], [[0.865, 1.158], [0.935, 1.137], [0.945, 1.142], [0.862, 1.168]],
        [[0.64, 1.114], [0.858, 1.110], [0.862, 1.120], [0.64, 1.124]], [[0.858, 1.110], [0.945, 1.138], [0.935, 1.143], [0.862, 1.120]],
        [[0.80, 1.137], [0.92, 1.138], [0.92, 1.143], [0.80, 1.142]]], 'rear', 'tail', 0.009, true),
      polys([rect(0.59, 1.133, 0.615, 1.146)], 'rear', 'rev', 0.009, true),
      polys([[[-2.40, 1.165], [-2.53, 1.15], [-2.54, 1.10], [-2.44, 1.12]]], 'side', 'tail', 0.006, true),
      polys([rect(-0.58, 1.13, 0.58, 1.165)], 'rear', 'gloss', 0.005, false),
      [{ t: 'text', view: 'rear', str: 'Lamborghini', at: [0, 1.1475], h: 0.022, mat: 'badge', weight: 0.13, skew: 0.18, spacing: 1.6, maxTilt: 40 }],
      // low LOD: arrow lamps + band
      [{ t: 'poly', view: 'rear', mat: 'tail', low: 'only', mirror: true, offset: 0.008, maxTilt: 30, pts: [[0.56, 1.11], [0.80, 1.106], [0.85, 1.14], [0.80, 1.174], [0.58, 1.176]] }],
      [{ t: 'poly', view: 'rear', mat: 'gloss', low: 'only', offset: 0.006, maxTilt: 30, pts: [[-0.56, 1.128], [0.56, 1.128], [0.56, 1.166], [-0.56, 1.166]] }],
      // tailgate: shut lines, plate high on the lid with plate lights; black corner slashes either side
      polys([rect(0.595, 0.80, 0.605, 1.10)], 'rear', 'gloss', 0.004, true),
      polys([rect(-0.605, 0.795, 0.605, 0.803)], 'rear', 'gloss', 0.004, false),
      polys([rect(-0.25, 0.865, 0.25, 0.985)], 'rear', 'gloss', 0.004, false),
      polys([rect(-0.23, 0.875, 0.23, 0.975)], 'rear', 'plate', 0.007, false),
      polys([rect(-0.16, 0.987, -0.10, 0.994), rect(0.10, 0.987, 0.16, 0.994)], 'rear', 'white', 0.008, false),
      polys([[[0.80, 0.64], [0.87, 0.64], [0.97, 0.96], [0.93, 0.98]]], 'rear', 'black', 0.006, true),
      // black lower bumper, grey diffuser surround with fins, reflectors, sensor dots
      polys([[[-0.86, 0.24], [0.86, 0.24], [0.92, 0.62], [0.80, 0.64], [-0.80, 0.64], [-0.92, 0.62]]], 'rear', 'black', 0.004, false),
      polys([rect(-0.56, 0.50, 0.56, 0.52), rect(-0.56, 0.26, -0.54, 0.50), rect(0.54, 0.26, 0.56, 0.50)], 'rear', 'rim', 0.007, false),
      polys([-0.36, -0.18, 0, 0.18, 0.36].map(function (z) { return rect(z - 0.011, 0.27, z + 0.011, 0.49); }), 'rear', 'gloss', 0.007, false),
      polys([rect(-0.12, 0.44, 0.12, 0.47)], 'rear', 'lens', 0.009, false),
      polys([rect(0.66, 0.58, 0.88, 0.60)], 'rear', 'lens', 0.007, true),
      polys([ell(0.30, 0.70, 0.012, 0.012, 6), ell(0.58, 0.70, 0.012, 0.012, 6)], 'rear', 'gloss', 0.006, true),
      // dark lower door cladding between the arches
      polys([[[0.98, 0.31], [0.98, 0.47], [-1.0, 0.50], [-1.0, 0.31]]], 'side', 'black', 0.004, true),
      // front-fender vent, door handles
      polys([[[1.0, 0.86], [0.92, 0.96], [0.89, 0.96], [0.96, 0.86]]], 'side', 'black', 0.004, true),
      polys([rect(-0.15, 0.98, 0.0, 1.0), rect(-1.02, 1.01, -0.87, 1.03)], 'side', 'black', 0.004, true),
      // angular black arch cladding (polygonal arches)
      flare(1.5015, 0.395, 0.43, 0.50, 0.92, 1.012, 'black', 5, -8, 188),
      flare(-1.5015, 0.395, 0.43, 0.50, 0.94, 1.02, 'black', 5, -8, 188),
      [
        // tailgate lip spoiler, door mirrors
        { t: 'prism', mat: 'paint', z0: -0.70, z1: 0.70, pts2d: [[-2.38, 1.33], [-2.50, 1.325], [-2.51, 1.30], [-2.42, 1.305]] },
        // third brake light: slim strip along the top of the rear screen
        { t: 'box', mat: 'tail', c: [-1.99, 1.486, 0], s: [0.04, 0.014, 0.5] },
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.82, z1: 1.07, pts2d: [[0.62, 1.09], [0.42, 1.09], [0.40, 1.20], [0.58, 1.21]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.56, 1.08, 0.87], s: [0.12, 0.04, 0.08] }
      ]
    ),
    wheels: { style: 'split', spokes: 5 },
    notes: 'Lamborghini Urus — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2019_Lamborghini_Urus_V8_Automatic_4.0_Front.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Lamborghini_Urus_front_view_dllu.jpg (front), ' +
      'https://commons.wikimedia.org/wiki/File:2019_Lamborghini_Urus_V8_Automatic_4.0_Rear.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Lamborghini_Urus_Performante_(2024)_(53621960053).jpg (side).'
  };
  reg('lamborghini-urus', URUS);

  /* ================================================================ Jeep Wrangler Unlimited Rubicon (JL, 2018–) */
  // Reference photos (Wikimedia Commons):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2026_Jeep_Wrangler_4-door_Rubicon_Whitecap,_front_left,_09-12-2026.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2026_Jeep_Wrangler_4-door_Rubicon_Whitecap,_rear_left,_09-12-2026.jpg
  //   front:     https://commons.wikimedia.org/wiki/File:2024_Jeep_Wrangler_Unlimited_Rubicon,_front_NYIAS_2023.jpg
  // Signature: body-on-frame box — upright seven-slot grille with round lamps (LED halo) notching the outer
  // slots, flat bonnet standing above flat wing tops, upright flat windscreen, flat-sided black hardtop,
  // squared high-clearance flares, exposed door hinges, steel bumpers, rock rails, vertical tail lamps and the
  // spare tyre on the side-hinged tailgate.
  var AXJ = 1.504, RTJ = 0.4154;
  var rowsBlack = ['black', 'black', 'black', 'black', 'black', 'black', 'black'], rowsRubber = ['rubber', 'rubber', 'rubber', 'rubber', 'rubber', 'rubber', 'rubber'];
  function jeepFlare(ax) {   // squared flare: inner edge follows the arch, outer outline trapezoidal (side profile)
    var rIn = RTJ + 0.075, out = [];
    var outer = [[ax + rIn + 0.09, 0.40], [ax + rIn + 0.07, 0.70], [ax + 0.30, RTJ + rIn + 0.095], [ax - 0.30, RTJ + rIn + 0.095], [ax - rIn - 0.07, 0.70], [ax - rIn - 0.09, 0.40]];
    var ang = [-0.0, 0.62, 1.30, 1.84, 2.52, 3.14];
    for (var k = 0; k < 5; k++) {
      var a0 = ang[k], a1 = ang[k + 1];
      var i0 = [ax + Math.cos(a0) * rIn, Math.max(0.40, RTJ + Math.sin(a0) * rIn)], i1 = [ax + Math.cos(a1) * rIn, Math.max(0.40, RTJ + Math.sin(a1) * rIn)];
      out.push({ t: 'prism', mat: 'black', mirror: true, z0: 0.86, z1: 0.95, pts2d: [i0, outer[k], outer[k + 1], i1] });
    }
    return out;
  }
  var JEEP = {
    body: {
      // front: steel bumper -> upright grille face -> flat bonnet over flat wing tops; tub; tailgate face folds
      // down to the steel rear bumper, whose back face closes onto the spare tyre (a 14-sided cylinder, axis x)
      stations: [
        { x: 2.246, pts: [[0.42, 0], [0.42, 0.8], [0.44, 0.82], [0.665, 0.82], [0.665, 0.8], [0.665, 0.6], [0.665, 0.3], [0.665, 0]] },
        { x: 2.15, pts: [[0.42, 0], [0.42, 0.8], [0.44, 0.82], [0.665, 0.82], [0.665, 0.8], [0.665, 0.6], [0.665, 0.3], [0.665, 0]] },
        { x: 2.1495, pts: [[0.42, 0], [0.42, 0.84], [0.44, 0.87], [1.06, 0.875], [1.16, 0.865], [1.18, 0.745], [1.245, 0.7], [1.25, 0]] },
        { x: 2.09, pts: [[0.42, 0], [0.42, 0.86], [0.45, 0.88], [1.1, 0.88], [1.175, 0.872], [1.195, 0.745], [1.255, 0.7], [1.262, 0]] },
        { x: 0.75, pts: [[0.40, 0], [0.40, 0.86], [0.43, 0.88], [1.14, 0.88], [1.20, 0.875], [1.21, 0.745], [1.30, 0.72], [1.305, 0]] },
        { x: 0.70, pts: [[0.33, 0], [0.33, 0.86], [0.36, 0.88], [1.20, 0.88], [1.338, 0.875], [1.34, 0.80], [1.34, 0.40], [1.34, 0]] },
        { x: -2.15, pts: [[0.40, 0], [0.40, 0.86], [0.43, 0.88], [1.20, 0.88], [1.338, 0.875], [1.34, 0.80], [1.34, 0.40], [1.34, 0]] },
        { x: -2.21, pts: [[0.6, 0], [0.6, 0.84], [0.62, 0.86], [1.2, 0.868], [1.33, 0.86], [1.335, 0.8], [1.335, 0.4], [1.335, 0]] },
        { x: -2.2105, pts: [[0.43, 0], [0.43, 0.88], [0.45, 0.9], [0.62, 0.9], [0.62, 0.88], [0.62, 0.8], [0.62, 0.4], [0.62, 0]] },
        { x: -2.285, pts: [[0.43, 0], [0.43, 0.88], [0.45, 0.9], [0.62, 0.9], [0.62, 0.88], [0.62, 0.8], [0.62, 0.4], [0.62, 0]] },
        { x: -2.2855, pts: [[0.59, 0], [0.593, 0.013], [0.6013, 0.0235], [0.6133, 0.0292], [0.6267, 0.0292], [0.6387, 0.0235], [0.647, 0.013], [0.65, 0]] },
        { x: -2.29, pts: [[0.5846, 0], [0.6257, 0.1802], [0.741, 0.3248], [0.9076, 0.405], [1.0924, 0.405], [1.259, 0.3248], [1.3743, 0.1802], [1.4154, 0]] },
        { x: -2.525, pts: [[0.5846, 0], [0.6257, 0.1802], [0.741, 0.3248], [0.9076, 0.405], [1.0924, 0.405], [1.259, 0.3248], [1.3743, 0.1802], [1.4154, 0]] },
        { x: -2.539, pts: [[0.63, 0], [0.6666, 0.1605], [0.7693, 0.2893], [0.9177, 0.3607], [1.0823, 0.3607], [1.2307, 0.2893], [1.3334, 0.1605], [1.37, 0]] }
      ],
      wells: true,
      mats: [
        rowsBlack,                                                     // steel front bumper
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // grille face
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // grille surround
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // wings + bonnet
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black'],    // cowl step
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // tub
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // tub end
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // tailgate face
        rowsBlack,                                                     // steel rear bumper
        rowsBlack,                                                     // bumper back face
        rowsRubber,                                                    // spare: inner sidewall
        rowsRubber,                                                    // spare: tread
        rowsRubber                                                     // spare: outer shoulder
      ],
      capF: 'black', capR: 'rubber'
    },
    cabin: {
      stations: [
        { x: 0.72, pts: [[1.305, 0.80], [1.305, 0.79], [1.305, 0.765], [1.305, 0.745], [1.305, 0.70], [1.305, 0]] },
        { x: 0.405, pts: [[1.338, 0.84], [1.40, 0.80], [1.765, 0.772], [1.80, 0.76], [1.808, 0.715], [1.808, 0]] },
        { x: 0.33, pts: [[1.338, 0.84], [1.40, 0.80], [1.765, 0.772], [1.835, 0.758], [1.848, 0.715], [1.848, 0]] },
        { x: -2.11, pts: [[1.338, 0.84], [1.40, 0.80], [1.765, 0.772], [1.835, 0.758], [1.848, 0.715], [1.848, 0]] },
        { x: -2.17, pts: [[1.338, 0.835], [1.40, 0.795], [1.765, 0.765], [1.82, 0.75], [1.832, 0.71], [1.832, 0]] }
      ],
      mats: [
        ['paint', 'glass', 'paint', 'glass', 'glass'],     // upright windscreen in a body-colour frame
        ['paint', 'glass', 'paint', 'paint', 'paint'],     // screen header
        ['black', 'black', 'black', 'black', 'black'],     // flat-sided black hardtop (door glass: side polys)
        ['black', 'black', 'black', 'black', 'black']      // hardtop rear edge
      ],
      capF: null, capR: 'black'
    },
    parts: [].concat(
      // door + quarter glass on the flat hardtop sides
      polys([rect(-0.46, 1.41, 0.39, 1.755), rect(-1.29, 1.41, -0.59, 1.755), rect(-2.10, 1.41, -1.43, 1.755)], 'side', 'glass', 0.004, true),
      // seven-slot grille (outer slots notched by the lamps), round lamps with LED halo rings, amber markers
      polys([-0.27, -0.18, -0.09, 0, 0.09, 0.18, 0.27].map(function (z) {
        var o = Math.abs(z) > 0.25; return rect(z - 0.032, o ? 0.84 : 0.80, z + 0.032, o ? 1.12 : 1.15);
      }), 'front', 'grille', 0.005, false),
      polys([rect(-0.30, 0.69, 0.30, 0.76)], 'front', 'grille', 0.005, false),
      polys([ell(0.43, 0.985, 0.125, 0.125, 12)], 'front', 'drl', 0.008, true),
      polys([ell(0.43, 0.985, 0.104, 0.104, 10)], 'front', 'gloss', 0.011, true),
      polys([ell(0.43, 0.985, 0.05, 0.05, 8)], 'front', 'light', 0.014, true),
      polys([[[0.90, 1.02], [0.94, 1.00], [0.94, 0.96], [0.90, 0.98]]], 'front', 'indicator', 0.006, true),
      [{ t: 'text', view: 'front', str: 'JEEP', at: [0, 1.1925], h: 0.032, mat: 'black', weight: 0.17 }],
      // RUBICON decal on the bonnet side wall (reads correctly on both sides), hood vents
      [{ t: 'text', view: 'side', str: 'RUBICON', at: [1.62, 1.225], h: 0.032, mat: 'black', weight: 0.17 }],
      [{ t: 'text', view: 'left', str: 'RUBICON', at: [1.62, 1.225], h: 0.032, mat: 'black', weight: 0.17 }],
      // windscreen wipers, rear window on the hardtop back, CHMSL
      polys([rect(0.66, -0.70, 0.70, -0.05), rect(0.66, 0.05, 0.70, 0.70)], 'top', 'black', 0.006, false),
      polys([rect(-0.62, 1.43, 0.62, 1.77)], 'rear', 'glass', 0.005, false),
      // vertical tail lamps (JL LED): red lens, lit rounded-ring outline round the upper lamp, reverse lens in the
      // lower lamp, black bezel down the outboard edge (wraps the tub corner)
      polys([rect(0.735, 0.77, 0.865, 1.17)], 'rear', 'lens', 0.006, true),
      polys([rect(0.75, 1.145, 0.85, 1.16), rect(0.75, 0.93, 0.85, 0.945), rect(0.75, 0.945, 0.765, 1.145), rect(0.835, 0.945, 0.85, 1.145),
        rect(0.78, 1.00, 0.82, 1.09)], 'rear', 'tail', 0.010, true),
      polys([rect(0.75, 0.83, 0.85, 0.915)], 'rear', 'rev', 0.010, true),
      polys([rect(0.75, 0.782, 0.85, 0.818)], 'rear', 'tail', 0.010, true),
      polys([rect(0.865, 0.77, 0.89, 1.17)], 'rear', 'gloss', 0.006, true),
      // low LOD: one lamp quad per side
      [{ t: 'poly', view: 'rear', mat: 'tail', low: 'only', mirror: true, offset: 0.008, maxTilt: 20, pts: [[0.74, 0.78], [0.86, 0.78], [0.86, 1.165], [0.74, 1.165]] }],
      // tailgate: shut lines (hinge side right, latch side left), handle on the latch side, JEEP badge lower left
      polys([rect(-0.715, 0.64, -0.705, 1.33), rect(0.705, 0.64, 0.715, 1.33), rect(-0.715, 0.632, 0.715, 0.64)], 'rear', 'gloss', 0.005, false),
      polys([rect(-0.67, 1.235, -0.57, 1.268)], 'rear', 'black', 0.008, false),
      [{ t: 'text', view: 'rear', str: 'JEEP', at: [-0.56, 0.69], h: 0.04, mat: 'black', weight: 0.17 }],
      // plate with its light bar, red bumper-end reflectors
      polys([rect(0.40, 0.625, 0.74, 0.79)], 'rear', 'black', 0.006, false),
      polys([rect(0.42, 0.635, 0.72, 0.78)], 'rear', 'plate', 0.009, false),
      polys([rect(0.53, 0.783, 0.61, 0.79)], 'rear', 'white', 0.011, false),
      // spare wheel face on the tyre's rear cap: dark rim with five slots, hub
      polys([ell(0, 1.0, 0.25, 0.25, 10)], 'rear', 'rim', 0.006, false),
      polys([0, 1, 2, 3, 4].map(function (k) { var a = Math.PI / 2 + k * Math.PI * 2 / 5, c = Math.cos(a), sn = Math.sin(a); return [[c * 0.10, 1.0 + sn * 0.10], [Math.cos(a + 0.42) * 0.21, 1.0 + Math.sin(a + 0.42) * 0.21], [Math.cos(a + 0.82) * 0.21, 1.0 + Math.sin(a + 0.82) * 0.21], [Math.cos(a + 1.0) * 0.10, 1.0 + Math.sin(a + 1.0) * 0.10]]; }), 'rear', 'black', 0.009, false),
      polys([ell(0, 1.0, 0.065, 0.065, 8)], 'rear', 'black', 0.011, false),
      polys([ell(0, 1.0, 0.035, 0.035, 6)], 'rear', 'badge', 0.013, false),
      polys([0, 1, 2, 3, 4].map(function (k) { var a = Math.PI / 2 + k * Math.PI * 2 / 5 + 0.63; return ell(Math.cos(a) * 0.085, 1.0 + Math.sin(a) * 0.085, 0.011, 0.011, 5); }), 'rear', 'chrome', 0.013, false),
      // fog lamps in the steel bumper
      polys([ell(0.64, 0.545, 0.048, 0.048, 8)], 'front', 'light', 0.006, true),
      // hardtop liftglass: wiper parked across the lower glass
      polys([[[-0.02, 1.455], [-0.50, 1.50], [-0.50, 1.513], [-0.02, 1.468]]], 'rear', 'black', 0.009, false),
      // door handles, exposed door hinges, cowl vent
      polys([rect(-0.42, 1.25, -0.26, 1.282), rect(-1.28, 1.25, -1.12, 1.282)], 'side', 'black', 0.004, true),
      polys([[[1.30, 1.20], [1.00, 1.205], [1.00, 1.235], [1.30, 1.23]]], 'side', 'grille', 0.004, true),
      jeepFlare(AXJ), jeepFlare(-AXJ),
      [
        // exposed door hinges (front + rear doors, two each)
        { t: 'box', mat: 'black', mirror: true, c: [0.67, 1.16, 0.885], s: [0.065, 0.08, 0.025] },
        { t: 'box', mat: 'black', mirror: true, c: [0.67, 0.74, 0.885], s: [0.065, 0.08, 0.025] },
        { t: 'box', mat: 'black', mirror: true, c: [-0.54, 1.16, 0.885], s: [0.05, 0.08, 0.025] },
        { t: 'box', mat: 'black', mirror: true, c: [-0.54, 0.74, 0.885], s: [0.05, 0.08, 0.025] },
        // tailgate hinges
        { t: 'box', mat: 'black', mirror: false, c: [-2.215, 1.16, 0.86], s: [0.03, 0.08, 0.05] },
        { t: 'box', mat: 'black', mirror: false, c: [-2.215, 0.78, 0.86], s: [0.03, 0.08, 0.05] },
        // red tow hooks, rock rails
        { t: 'box', mat: 'tail', mirror: true, c: [2.25, 0.505, 0.40], s: [0.04, 0.06, 0.07] },
        { t: 'box', mat: 'black', mirror: true, c: [0.0, 0.40, 0.855], s: [2.0, 0.085, 0.09] },
        // hidden body-colour fillers inside the steel bumper and the spare tyre: the painted shell must span the
        // full length (bumper face to spare) so the body part is centred like the real car's bounding box
        { t: 'box', mat: 'paint', c: [2.20, 0.55, 0], s: [0.08, 0.06, 0.06] },
        { t: 'box', mat: 'paint', c: [-2.47, 1.0, 0], s: [0.12, 0.06, 0.06] },
        // CHMSL on the spare carrier
        { t: 'box', mat: 'tail', c: [-2.23, 1.45, 0], s: [0.03, 0.03, 0.20] },
        // hitch receiver under the bumper (square tube, dark mouth), red tow hook on the latch side, red
        // reflectors on the bumper ends
        { t: 'box', mat: 'black', c: [-2.27, 0.40, 0], s: [0.10, 0.075, 0.075] },
        { t: 'box', mat: 'grille', c: [-2.322, 0.40, 0], s: [0.004, 0.05, 0.05] },
        { t: 'box', mat: 'tail', c: [-2.25, 0.395, -0.55], s: [0.05, 0.05, 0.035] },
        { t: 'box', mat: 'lens', mirror: true, c: [-2.287, 0.525, 0.80], s: [0.004, 0.03, 0.09] },
        // black door mirrors on stalks, antenna
        { t: 'box', mat: 'black', mirror: true, c: [0.53, 1.49, 1.0], s: [0.17, 0.18, 0.04] },
        { t: 'box', mat: 'black', mirror: true, c: [0.56, 1.42, 0.92], s: [0.06, 0.04, 0.10] }
      ]
    ),
    // factory look (Commons: Jeep Wrangler Rubicon (JL) 4xe 1X7A0285/0287): gunmetal 17" Rubicon alloys, black callipers
    wheels: { style: 'star', spokes: 5, stock: { rim: '#5d6166', material: 'cast', caliper: '#1c1c1e' } },
    notes: 'Jeep Wrangler Unlimited Rubicon (JL) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2026_Jeep_Wrangler_4-door_Rubicon_Whitecap,_front_left,_09-12-2026.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2026_Jeep_Wrangler_4-door_Rubicon_Whitecap,_rear_left,_09-12-2026.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2024_Jeep_Wrangler_Unlimited_Rubicon,_front_NYIAS_2023.jpg (front).'
  };
  reg('jeep-wrangler-rubicon-jl', JEEP);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 'porsche-cayenne-e3': CAY, 'range-rover-sport-l461': RRS, 'lamborghini-urus': URUS, 'jeep-wrangler-rubicon-jl': JEEP };
  }
})();

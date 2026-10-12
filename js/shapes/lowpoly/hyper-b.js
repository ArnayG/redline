/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/hyper-b.js
   Hand-authored low-poly mid-engine supercars (docs/LOWPOLY-SPEC.md):
     Lamborghini Huracán EVO, Ferrari 296 GTB, Audi R8 V10 (gen 2 facelift), Chevrolet Corvette Stingray (C8),
     Ford GT (2nd gen, flying buttresses as real gaps).
   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body / cabin stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.
   Body ring points (11): 0 bottom centre, 1 bottom edge (sill), 2 lower flank, 3 waist (widest), 4 shoulder,
   5 fender crown, 6 belt / inner shoulder, 7 glass base, 8 roof rail, 9 roof quarter, 10 centre line.
   Mats columns: c0 under, c1 sill, c2 lower flank, c3 waist, c4 shoulder, c5 crown, c6 belt, c7 side glass,
   c8 roof edge, c9 roof / screen.
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
  function rect(a0, b0, a1, b1) { return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]; }
  function ell(a, b, ra, rb, n) {
    var out = [];
    for (var i = 0; i < n; i++) { var t = (i + 0.5) / n * Math.PI * 2; out.push([a + Math.cos(t) * ra, b + Math.sin(t) * rb]); }
    return out;
  }
  /** ring (annulus) as n quads: outline pairs in view coordinates */
  function ring(a, b, r0, r1, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t0 = i / n * Math.PI * 2, t1 = (i + 1) / n * Math.PI * 2;
      out.push([[a + Math.cos(t0) * r0, b + Math.sin(t0) * r0], [a + Math.cos(t0) * r1, b + Math.sin(t0) * r1],
        [a + Math.cos(t1) * r1, b + Math.sin(t1) * r1], [a + Math.cos(t1) * r0, b + Math.sin(t1) * r0]]);
    }
    return out;
  }
  /** thin strip from p to q (view coordinates), width w */
  function strip(p, q, w) {
    var dx = q[0] - p[0], dy = q[1] - p[1], l = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / l * w / 2, ny = dx / l * w / 2;
    return [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]];
  }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  function P(view, mat, off, mirror, pts) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: pts }; }
  /** flared arch band (side profile) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, a0d, a1d) {
    var parts = [], n = segs || 6, A0 = (a0d == null ? 0 : a0d) * Math.PI / 180, A1 = (a1d == null ? 180 : a1d) * Math.PI / 180;
    for (var k = 0; k < n; k++) {
      var a0 = A0 + (A1 - A0) * k / n, a1 = A0 + (A1 - A0) * (k + 1) / n;
      var Q = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [Q(rIn, a0), Q(rOut, a0), Q(rOut, a1), Q(rIn, a1)] });
    }
    return parts;
  }
  function row(n, m, over) {   // material row of n columns, default m, overrides {col: mat}
    var r = [];
    for (var i = 0; i < n; i++) r.push(over && over[i] != null ? over[i] : m);
    return r;
  }

  var DEFS = {};

  /* ================================================================ Lamborghini Huracán EVO (LB724, 2019–2024) */
  // Signature: one unbroken wedge arc from the nose to the tail, very raked screen, short roof, narrow glasshouse
  // on wide haunches; slim Y-blade headlamps on the fender tips, big triangular outer intakes, side intake in
  // front of the rear wheel, louvred engine cover, full-width black rear with slim Y tail lamps, high exhausts.
  (function () {
    var S = [
      { x: 2.36, pts: [[0.14, 0], [0.14, 0.56], [0.17, 0.63], [0.22, 0.65], [0.28, 0.62], [0.33, 0.54], [0.36, 0.44], [0.375, 0.32], [0.385, 0.20], [0.39, 0.10], [0.39, 0]] },
      { x: 2.20, pts: [[0.12, 0], [0.12, 0.76], [0.16, 0.83], [0.26, 0.86], [0.40, 0.835], [0.49, 0.75], [0.505, 0.62], [0.485, 0.46], [0.475, 0.30], [0.47, 0.15], [0.47, 0]] },
      { x: 1.95, pts: [[0.13, 0], [0.13, 0.85], [0.20, 0.92], [0.36, 0.945], [0.53, 0.915], [0.635, 0.83], [0.65, 0.70], [0.625, 0.52], [0.61, 0.35], [0.60, 0.17], [0.595, 0]] },
      { x: 1.55, pts: [[0.15, 0], [0.15, 0.86], [0.24, 0.93], [0.42, 0.957], [0.60, 0.935], [0.73, 0.865], [0.755, 0.745], [0.73, 0.56], [0.715, 0.38], [0.705, 0.19], [0.70, 0]] },
      { x: 1.10, pts: [[0.14, 0], [0.14, 0.87], [0.25, 0.94], [0.44, 0.962], [0.64, 0.94], [0.79, 0.87], [0.82, 0.76], [0.80, 0.58], [0.79, 0.40], [0.782, 0.20], [0.778, 0]] },
      { x: 0.84, pts: [[0.13, 0], [0.13, 0.86], [0.25, 0.93], [0.45, 0.952], [0.66, 0.93], [0.81, 0.865], [0.85, 0.76], [0.845, 0.64], [0.835, 0.44], [0.828, 0.22], [0.825, 0]] },
      { x: 0.40, pts: [[0.12, 0], [0.12, 0.85], [0.25, 0.925], [0.45, 0.945], [0.66, 0.925], [0.80, 0.875], [0.865, 0.80], [0.885, 0.69], [0.93, 0.62], [0.975, 0.36], [0.99, 0]] },
      { x: -0.12, pts: [[0.11, 0], [0.11, 0.85], [0.24, 0.925], [0.45, 0.945], [0.67, 0.935], [0.81, 0.895], [0.88, 0.845], [0.905, 0.72], [1.09, 0.605], [1.125, 0.35], [1.145, 0]] },
      { x: -0.45, pts: [[0.11, 0], [0.11, 0.86], [0.25, 0.935], [0.46, 0.955], [0.68, 0.95], [0.83, 0.915], [0.9, 0.865], [0.925, 0.7], [1.1, 0.57], [1.145, 0.33], [1.165, 0]] },
      { x: -0.85, pts: [[0.12, 0], [0.12, 0.88], [0.26, 0.945], [0.48, 0.967], [0.7, 0.958], [0.85, 0.92], [0.94, 0.84], [0.965, 0.62], [1.075, 0.47], [1.115, 0.28], [1.13, 0]] },
      { x: -1.15, pts: [[0.13, 0], [0.13, 0.90], [0.27, 0.96], [0.50, 0.972], [0.72, 0.965], [0.87, 0.935], [0.955, 0.86], [1.01, 0.66], [1.045, 0.48], [1.068, 0.28], [1.078, 0]] },
      { x: -1.55, pts: [[0.15, 0], [0.15, 0.90], [0.29, 0.96], [0.52, 0.975], [0.74, 0.965], [0.885, 0.925], [0.95, 0.83], [0.985, 0.66], [1.00, 0.48], [1.015, 0.28], [1.02, 0]] },
      { x: -1.95, pts: [[0.21, 0], [0.21, 0.84], [0.34, 0.90], [0.55, 0.915], [0.75, 0.90], [0.88, 0.855], [0.95, 0.765], [0.975, 0.60], [0.98, 0.44], [0.985, 0.25], [0.985, 0]] },
      { x: -2.15, pts: [[0.36, 0], [0.36, 0.72], [0.45, 0.80], [0.60, 0.825], [0.76, 0.815], [0.88, 0.765], [0.95, 0.685], [0.975, 0.54], [0.98, 0.40], [0.985, 0.22], [0.985, 0]] }
    ];
    var M = [
      row(10, 'paint', { 0: 'black', 1: 'grille', 2: 'grille', 3: 'grille', 4: 'grille' }), // nose: outer intakes are the corner facets
      row(10, 'paint', { 0: 'black', 2: 'grille' }),                      // front bumper -> lamps (intake wraps the corner)
      row(10, 'paint', { 0: 'black' }),                                   // bonnet
      row(10, 'paint', { 0: 'black' }),                                   // front fender
      row(10, 'paint', { 0: 'black' }),                                   // to the cowl
      row(10, 'paint', { 0: 'black', 8: 'glass', 9: 'glass' }),           // windscreen (lower)
      row(10, 'paint', { 0: 'black', 7: 'glass', 8: 'glass', 9: 'glass' }), // windscreen (upper) + side glass
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),          // roof
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),          // roof (rear)
      row(10, 'paint', { 0: 'black', 7: 'glass', 8: 'paint', 9: 'glass' }), // rear window
      row(10, 'paint', { 0: 'black', 9: 'grille' }),                      // engine cover (louvres)
      row(10, 'paint', { 0: 'black', 9: 'grille' }),                      // engine cover (rear)
      row(10, 'paint', { 0: 'black', 1: 'black' })                        // tail
    ];
    DEFS['lamborghini-huracan-evo'] = {
      body: { stations: S, mats: M, capF: 'black', capR: 'paint' },
      parts: [].concat(
        // ---- front: Y-blade headlamps on the fender tips (dark housing, lamp, Y DRL)
        polys([[[0.38, 0.52], [0.66, 0.56], [0.86, 0.63], [0.83, 0.66], [0.60, 0.612], [0.40, 0.555]]], 'front', 'gloss', 0.006, true),
        polys([[[0.47, 0.552], [0.66, 0.578], [0.80, 0.622], [0.79, 0.642], [0.62, 0.604], [0.48, 0.574]]], 'front', 'light', 0.009, true),
        polys([strip([0.47, 0.566], [0.70, 0.60], 0.011), strip([0.70, 0.60], [0.81, 0.638], 0.009), strip([0.70, 0.60], [0.80, 0.615], 0.009)], 'front', 'drl', 0.012, true),
        // outer intakes: big black triangles with the body-colour blade, centre lower intake, splitter
        // (the intakes themselves are body facets in 'grille'; narrow draped blades keep them crisp: the diagonal
        // body-colour divider from the centre intake and the EVO's horizontal wing across each outer intake)
        { t: 'poly', view: 'front', mat: 'paint', mirror: true, offset: 0.008, pts: [[0.55, 0.15], [0.61, 0.15], [0.68, 0.42], [0.62, 0.44]] },
        { t: 'poly', view: 'front', mat: 'paint', mirror: true, offset: 0.008, pts: [[0.64, 0.27], [0.83, 0.25], [0.84, 0.28], [0.65, 0.30]] },
        polys([[[-0.46, 0.13], [0.46, 0.13], [0.52, 0.21], [0.42, 0.36], [0.12, 0.33], [0, 0.31], [-0.12, 0.33], [-0.42, 0.36], [-0.52, 0.21]]], 'front', 'grille', 0.005, false),
        polys([rect(-0.92, 0.12, 0.92, 0.155)], 'front', 'black', 0.006, false),
        polys([[[-0.035, 0.44], [0.035, 0.44], [0.03, 0.49], [0, 0.505], [-0.03, 0.49]]], 'front', 'badge', 0.008, false),
        // ---- side: intake ahead of the rear wheel, black sill blade, door shut, mirrors
        polys([[[-0.50, 0.66], [-0.93, 0.80], [-0.97, 0.60], [-0.83, 0.52]]], 'side', 'grille', 0.005, true),
        polys([[[0.93, 0.15], [-0.93, 0.15], [-0.93, 0.25], [-0.50, 0.30], [0.93, 0.26]]], 'side', 'black', 0.004, true),
        [
          { t: 'prism', mat: 'mirror', mirror: true, z0: 0.85, z1: 0.985, pts2d: [[0.36, 0.875], [0.20, 0.88], [0.19, 0.94], [0.34, 0.945]] },
          { t: 'box', mat: 'black', mirror: true, c: [0.30, 0.87, 0.83], s: [0.06, 0.025, 0.08] }
        ],
        // ---- rear: body-colour top, full-width black mesh, slim Y tail lamps, plate, diffuser
        polys([rect(-0.86, 0.43, 0.86, 0.80)], 'rear', 'grille', 0.005, false),
        polys([[[0.30, 0.86], [0.66, 0.875], [0.86, 0.82], [0.86, 0.79], [0.66, 0.84], [0.30, 0.835]]], 'rear', 'tail', 0.009, true),
        polys([strip([0.66, 0.857], [0.80, 0.905], 0.018), strip([0.66, 0.857], [0.84, 0.86], 0.016)], 'rear', 'tail', 0.010, true),
        polys([rect(-0.30, 0.83, 0.30, 0.855)], 'rear', 'black', 0.008, false),
        polys([rect(-0.25, 0.445, 0.25, 0.545)], 'rear', 'plate', 0.009, false),
        polys([rect(-0.82, 0.37, 0.82, 0.43)], 'rear', 'paint', 0.007, false),
        polys([[[-0.80, 0.37], [0.80, 0.37], [0.74, 0.20], [-0.74, 0.20]]], 'rear', 'black', 0.007, false),
        // engine cover louvres (hexagonal glass -> dark slats across the cover)
        polys([0, 1, 2, 3].map(function (k) { var x = -1.20 - k * 0.15; return rect(x - 0.03, -0.30, x + 0.03, 0.30); }), 'top', 'black', 0.007, false)
      ),
      wheels: { style: 'split', spokes: 5 },
      notes: 'Lamborghini Huracán EVO — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2022_Lamborghini_Huracan_EVO_Orange.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2020_Lamborghini_Huracan_EVO_RWD.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Lamborghini_Huracan_Evo,_GIMS_2019,_Le_Grand-Saconnex_(GIMS1010).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2019_Lamborghini_Huracan_EVO_LP_640-4_S-A_5.2_Rear.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Lamborghini_Huracán_604-4_EVO_2021_(2).jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Ferrari 296 GTB (F171, 2022–) */
  // Signature: compact cab-forward shape, wraparound "visor" glasshouse, slim headlamps with black teardrop
  // brake ducts under them, wide low mesh grille, big intake on the shoulder behind the door, buttressed
  // C-pillars over a flat engine cover, high body-colour tail with the black active-spoiler band between
  // twin slim tail lamps and one central oval exhaust.
  (function () {
    var S = [
      { x: 2.30, pts: [[0.17, 0], [0.17, 0.40], [0.21, 0.48], [0.28, 0.51], [0.36, 0.50], [0.41, 0.45], [0.43, 0.36], [0.44, 0.26], [0.445, 0.17], [0.45, 0.08], [0.45, 0]] },
      { x: 2.18, pts: [[0.12, 0], [0.12, 0.62], [0.17, 0.70], [0.30, 0.73], [0.44, 0.71], [0.53, 0.65], [0.555, 0.55], [0.55, 0.42], [0.545, 0.28], [0.54, 0.14], [0.54, 0]] },
      { x: 1.90, pts: [[0.13, 0], [0.13, 0.78], [0.21, 0.85], [0.38, 0.875], [0.55, 0.85], [0.66, 0.78], [0.68, 0.66], [0.655, 0.50], [0.64, 0.34], [0.635, 0.17], [0.63, 0]] },
      { x: 1.50, pts: [[0.15, 0], [0.15, 0.88], [0.25, 0.945], [0.44, 0.97], [0.62, 0.95], [0.75, 0.88], [0.78, 0.76], [0.745, 0.58], [0.73, 0.40], [0.72, 0.20], [0.715, 0]] },
      { x: 1.10, pts: [[0.14, 0], [0.14, 0.89], [0.26, 0.955], [0.45, 0.975], [0.65, 0.955], [0.80, 0.89], [0.84, 0.78], [0.815, 0.60], [0.80, 0.42], [0.795, 0.21], [0.79, 0]] },
      { x: 0.80, pts: [[0.13, 0], [0.13, 0.88], [0.26, 0.95], [0.46, 0.965], [0.67, 0.945], [0.82, 0.88], [0.87, 0.78], [0.865, 0.64], [0.855, 0.44], [0.85, 0.22], [0.845, 0]] },
      { x: 0.35, pts: [[0.12, 0], [0.12, 0.86], [0.25, 0.935], [0.46, 0.955], [0.67, 0.94], [0.81, 0.89], [0.87, 0.82], [0.89, 0.71], [0.96, 0.62], [1.015, 0.36], [1.03, 0]] },
      { x: -0.10, pts: [[0.1, 0], [0.1, 0.85], [0.24, 0.93], [0.46, 0.955], [0.68, 0.945], [0.82, 0.905], [0.89, 0.85], [0.915, 0.73], [1.115, 0.62], [1.165, 0.35], [1.175, 0]] },
      { x: -0.40, pts: [[0.1, 0], [0.1, 0.87], [0.25, 0.94], [0.47, 0.965], [0.7, 0.96], [0.84, 0.93], [0.92, 0.87], [0.95, 0.7], [1.13, 0.59], [1.17, 0.33], [1.185, 0]] },
      { x: -0.75, pts: [[0.11, 0], [0.11, 0.89], [0.26, 0.955], [0.49, 0.975], [0.72, 0.965], [0.86, 0.935], [0.96, 0.86], [0.985, 0.66], [1.11, 0.5], [1.13, 0.3], [1.14, 0]] },
      { x: -1.05, pts: [[0.12, 0], [0.12, 0.90], [0.27, 0.96], [0.50, 0.98], [0.73, 0.97], [0.87, 0.94], [0.96, 0.87], [1.03, 0.70], [1.08, 0.53], [0.95, 0.42], [0.94, 0]] },
      { x: -1.45, pts: [[0.15, 0], [0.15, 0.91], [0.29, 0.965], [0.52, 0.98], [0.74, 0.97], [0.88, 0.935], [0.955, 0.86], [1.0, 0.70], [1.035, 0.55], [0.93, 0.43], [0.925, 0]] },
      { x: -1.90, pts: [[0.19, 0], [0.19, 0.86], [0.33, 0.92], [0.55, 0.935], [0.75, 0.925], [0.88, 0.89], [0.95, 0.82], [0.985, 0.68], [1.0, 0.52], [0.965, 0.40], [0.965, 0]] },
      { x: -2.25, pts: [[0.42, 0], [0.42, 0.72], [0.50, 0.80], [0.64, 0.83], [0.78, 0.82], [0.89, 0.78], [0.96, 0.70], [0.99, 0.58], [1.0, 0.42], [0.995, 0.25], [0.99, 0]] }
    ];
    var M = [
      row(10, 'paint', { 0: 'black', 1: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black', 8: 'glass', 9: 'glass' }),             // windscreen
      row(10, 'paint', { 0: 'black', 7: 'glass', 8: 'glass', 9: 'glass' }),  // windscreen top, visor side glass
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),             // roof
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),             // roof
      row(10, 'paint', { 0: 'black', 9: 'glass' }),                          // buttresses, rear screen
      row(10, 'paint', { 0: 'black', 9: 'grille' }),                         // engine cover vents
      row(10, 'paint', { 0: 'black' }),                                      // rear deck
      row(10, 'paint', { 0: 'black', 1: 'black' })                           // tail
    ];
    DEFS['ferrari-296-gtb'] = {
      body: { stations: S, mats: M, capF: 'black', capR: 'paint' },
      parts: [].concat(
        // headlamps: slim swept LED units, DRL eyebrow, black teardrop brake ducts below the inner ends
        polys([[[0.44, 0.565], [0.86, 0.60], [0.90, 0.64], [0.86, 0.655], [0.46, 0.615]]], 'front', 'gloss', 0.006, true),
        polys([[[0.50, 0.578], [0.84, 0.608], [0.86, 0.635], [0.52, 0.605]]], 'front', 'light', 0.009, true),
        polys([strip([0.47, 0.612], [0.86, 0.648], 0.011)], 'front', 'drl', 0.012, true),
        polys([[[0.44, 0.565], [0.53, 0.575], [0.56, 0.50], [0.53, 0.43], [0.47, 0.44], [0.43, 0.50]]], 'front', 'grille', 0.006, true),
        // hammerhead: the dark band across the nose that links the two lamps
        polys([[[-0.44, 0.565], [0.44, 0.565], [0.46, 0.605], [-0.46, 0.605]]], 'front', 'gloss', 0.005, false),
                // full-width low mesh grille with the plate, outer corner ducts, splitter, prancing-horse badge
        polys([[[-0.66, 0.17], [0.66, 0.17], [0.72, 0.26], [0.68, 0.38], [-0.68, 0.38], [-0.72, 0.26]]], 'front', 'grille', 0.005, false),
        polys([rect(-0.24, 0.24, 0.24, 0.33)], 'front', 'plate', 0.009, false),
        polys([[[0.78, 0.16], [0.95, 0.17], [0.97, 0.30], [0.82, 0.30]]], 'front', 'grille', 0.005, true),
        polys([rect(-0.86, 0.12, 0.86, 0.16)], 'front', 'black', 0.006, false),
        polys([rect(-0.025, 0.43, 0.025, 0.49)], 'front', 'indicator', 0.008, false),
        // side: shoulder intake behind the door, sculpted lower door scoop, sill
        polys([[[-0.46, 0.80], [-0.84, 0.98], [-0.95, 0.90], [-0.90, 0.74], [-0.64, 0.72]]], 'side', 'grille', 0.005, true),
        polys([[[0.80, 0.30], [-0.55, 0.30], [-0.80, 0.48], [-0.86, 0.36], [-0.70, 0.22], [0.80, 0.22]]], 'side', 'black', 0.004, true),
        polys([rect(-0.90, 0.13, 0.90, 0.21)], 'side', 'black', 0.004, true),
        [
          { t: 'prism', mat: 'mirror', mirror: true, z0: 0.86, z1: 1.0, pts2d: [[0.34, 0.89], [0.18, 0.895], [0.17, 0.955], [0.32, 0.96]] },
          { t: 'box', mat: 'black', mirror: true, c: [0.28, 0.88, 0.84], s: [0.06, 0.025, 0.08] }
        ],
        // rear: black active-spoiler band, twin slim tail lamps per side, mesh lower band, diffuser, plate
        polys([[[-0.90, 0.86], [0.90, 0.86], [0.92, 0.94], [-0.92, 0.94]]], 'rear', 'gloss', 0.007, false),
        polys([rect(0.56, 0.88, 0.86, 0.915), rect(0.58, 0.815, 0.84, 0.845)], 'rear', 'tail', 0.010, true),
        polys([[[-0.80, 0.44], [0.80, 0.44], [0.84, 0.56], [0.80, 0.66], [-0.80, 0.66], [-0.84, 0.56]]], 'rear', 'grille', 0.006, false),
        polys([rect(-0.25, 0.47, 0.25, 0.56)], 'rear', 'plate', 0.009, false),
        polys([[[-0.82, 0.43], [0.82, 0.43], [0.76, 0.24], [-0.76, 0.24]]], 'rear', 'black', 0.007, false),
        polys([rect(-0.025, 0.73, 0.025, 0.79)], 'rear', 'indicator', 0.008, false)
      ),
      wheels: { style: 'split', spokes: 5 },
      notes: 'Ferrari 296 GTB — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2022_Ferrari_296_(cropped).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_296_GTB_Assetto_Fiorano_front.png (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_296_GTB_Assetto_Fiorano_rear.png (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_296_GTB_1X7A6379.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ferrari_296_GTB_(2022)_(52570602358).jpg (side).'
    };
  })();

  /* ================================================================ Audi R8 V10 (Type 4S facelift, 2019–2023) */
  // Signature: taller, longer glasshouse than the Italians, the black sideblade behind the doors, very wide
  // flat hexagonal Singleframe grille with the slot above, angular slim headlamps, big honeycomb corner
  // intakes, glass engine cover, slim tail lamps over a full-width honeycomb rear, two big oval tailpipes.
  (function () {
    var S = [
      { x: 2.30, pts: [[0.17, 0], [0.17, 0.38], [0.22, 0.46], [0.33, 0.50], [0.46, 0.49], [0.53, 0.44], [0.555, 0.36], [0.565, 0.26], [0.57, 0.17], [0.575, 0.08], [0.575, 0]] },
      { x: 2.17, pts: [[0.13, 0], [0.13, 0.60], [0.19, 0.68], [0.34, 0.71], [0.50, 0.70], [0.61, 0.65], [0.645, 0.56], [0.648, 0.42], [0.65, 0.28], [0.65, 0.14], [0.65, 0]] },
      { x: 1.90, pts: [[0.14, 0], [0.14, 0.78], [0.22, 0.86], [0.40, 0.885], [0.58, 0.865], [0.69, 0.80], [0.725, 0.68], [0.72, 0.52], [0.718, 0.35], [0.716, 0.17], [0.715, 0]] },
      { x: 1.50, pts: [[0.15, 0], [0.15, 0.88], [0.25, 0.945], [0.44, 0.965], [0.63, 0.95], [0.76, 0.89], [0.795, 0.77], [0.785, 0.58], [0.78, 0.40], [0.778, 0.20], [0.775, 0]] },
      { x: 1.15, pts: [[0.14, 0], [0.14, 0.89], [0.26, 0.955], [0.46, 0.97], [0.66, 0.955], [0.80, 0.90], [0.835, 0.79], [0.825, 0.60], [0.82, 0.42], [0.818, 0.21], [0.815, 0]] },
      { x: 0.92, pts: [[0.13, 0], [0.13, 0.88], [0.26, 0.95], [0.46, 0.965], [0.67, 0.95], [0.82, 0.895], [0.865, 0.79], [0.855, 0.66], [0.85, 0.45], [0.845, 0.22], [0.84, 0]] },
      { x: 0.45, pts: [[0.12, 0], [0.12, 0.86], [0.25, 0.94], [0.46, 0.955], [0.68, 0.945], [0.83, 0.90], [0.89, 0.83], [0.905, 0.72], [0.98, 0.64], [1.03, 0.37], [1.045, 0]] },
      { x: -0.10, pts: [[0.12, 0], [0.12, 0.86], [0.25, 0.94], [0.47, 0.96], [0.7, 0.955], [0.85, 0.92], [0.92, 0.86], [0.945, 0.73], [1.185, 0.63], [1.215, 0.36], [1.23, 0]] },
      { x: -0.50, pts: [[0.12, 0], [0.12, 0.88], [0.26, 0.95], [0.48, 0.97], [0.72, 0.965], [0.87, 0.935], [0.95, 0.88], [0.975, 0.71], [1.195, 0.6], [1.225, 0.34], [1.235, 0]] },
      { x: -0.92, pts: [[0.13, 0], [0.13, 0.89], [0.27, 0.955], [0.5, 0.975], [0.74, 0.97], [0.89, 0.94], [0.98, 0.88], [1.005, 0.7], [1.14, 0.52], [1.175, 0.3], [1.185, 0]] },
      { x: -1.35, pts: [[0.15, 0], [0.15, 0.90], [0.29, 0.96], [0.52, 0.975], [0.76, 0.97], [0.91, 0.94], [1.0, 0.87], [1.06, 0.70], [1.10, 0.52], [1.12, 0.30], [1.125, 0]] },
      { x: -1.85, pts: [[0.21, 0], [0.21, 0.88], [0.35, 0.935], [0.57, 0.95], [0.79, 0.94], [0.94, 0.90], [1.03, 0.83], [1.075, 0.68], [1.09, 0.50], [1.10, 0.28], [1.10, 0]] },
      { x: -2.10, pts: [[0.42, 0], [0.42, 0.78], [0.52, 0.85], [0.67, 0.875], [0.82, 0.87], [0.95, 0.83], [1.03, 0.76], [1.07, 0.62], [1.08, 0.46], [1.085, 0.25], [1.085, 0]] }
    ];
    var M = [
      row(10, 'paint', { 0: 'black', 1: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black', 8: 'glass', 9: 'glass' }),
      row(10, 'paint', { 0: 'black', 7: 'glass', 8: 'glass', 9: 'glass' }),
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),
      row(10, 'paint', { 0: 'black', 7: 'gloss', 9: 'glass' }),               // rear quarter + glass engine cover
      row(10, 'paint', { 0: 'black', 9: 'black' }),                            // louvred deck
      row(10, 'paint', { 0: 'black', 1: 'black' })
    ];
    DEFS['audi-r8-v10-gen2'] = {
      body: { stations: S, mats: M, capF: 'black', capR: 'paint' },
      parts: [].concat(
        // wide flat hexagonal Singleframe, slot above it, four rings
        polys([[[-0.50, 0.17], [0.50, 0.17], [0.57, 0.30], [0.52, 0.50], [-0.52, 0.50], [-0.57, 0.30]]], 'front', 'grille', 0.005, false),
        polys([rect(-0.36, 0.515, 0.36, 0.535)], 'front', 'black', 0.006, false),
        polys([-0.105, -0.035, 0.035, 0.105].reduce(function (a, z) { return a.concat(ring(z, 0.58, 0.026, 0.035, 8)); }, []), 'front', 'chrome', 0.009, false),
        polys([rect(-0.25, 0.22, 0.25, 0.33)], 'front', 'plate', 0.009, false),
        // angular headlamps (dark unit, lamp, DRL hook) and honeycomb corner intakes with a vertical blade
        polys([[[0.52, 0.53], [0.90, 0.58], [0.92, 0.635], [0.86, 0.645], [0.56, 0.60]]], 'front', 'gloss', 0.006, true),
        polys([[[0.58, 0.545], [0.86, 0.585], [0.88, 0.625], [0.60, 0.588]]], 'front', 'light', 0.009, true),
        polys([strip([0.56, 0.552], [0.88, 0.598], 0.012), strip([0.88, 0.598], [0.90, 0.635], 0.012)], 'front', 'drl', 0.012, true),
        polys([[[0.60, 0.16], [0.95, 0.16], [0.97, 0.36], [0.90, 0.47], [0.62, 0.45], [0.58, 0.30]]], 'front', 'grille', 0.005, true),
        polys([strip([0.76, 0.17], [0.74, 0.45], 0.03)], 'front', 'gloss', 0.008, true),
        polys([rect(-0.86, 0.13, 0.86, 0.165)], 'front', 'black', 0.006, false),
        // the sideblade behind the doors, sill, mirrors
        polys([[[-0.46, 0.84], [-0.80, 0.84], [-0.90, 0.66], [-0.92, 0.42], [-0.86, 0.30], [-0.52, 0.30], [-0.43, 0.42], [-0.42, 0.66]]], 'side', 'gloss', 0.006, true),
        polys([rect(-0.93, 0.13, 0.93, 0.22)], 'side', 'black', 0.004, true),
        [
          { t: 'prism', mat: 'mirror', mirror: true, z0: 0.86, z1: 1.0, pts2d: [[0.40, 0.90], [0.22, 0.905], [0.21, 0.97], [0.38, 0.975]] },
          { t: 'box', mat: 'black', mirror: true, c: [0.34, 0.89, 0.84], s: [0.06, 0.025, 0.08] }
        ],
        // rear: slim tail lamps, full-width honeycomb, four rings, plate, diffuser band
        polys([[[0.42, 0.815], [0.96, 0.80], [0.985, 0.875], [0.42, 0.90]]], 'rear', 'tail', 0.009, true),
        polys([strip([0.46, 0.866], [0.95, 0.85], 0.010)], 'rear', 'drl', 0.012, true),
        polys([rect(-0.90, 0.46, 0.90, 0.80)], 'rear', 'grille', 0.006, false),
        polys([-0.105, -0.035, 0.035, 0.105].reduce(function (a, z) { return a.concat(ring(z, 0.93, 0.03, 0.04, 8)); }, []), 'rear', 'chrome', 0.009, false),
        polys([rect(-0.26, 0.60, 0.26, 0.71)], 'rear', 'plate', 0.010, false),
        polys([[[-0.92, 0.46], [0.92, 0.46], [0.84, 0.25], [-0.84, 0.25]]], 'rear', 'black', 0.007, false)
      ),
      wheels: { style: 'split', spokes: 5 },
      notes: 'Audi R8 V10 (Type 4S facelift) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2020_Audi_R8_V10_5.2_Front.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2020_Audi_R8_V10_5.2_Rear.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2023_Audi_R8_Coupe_V10_Performance_RWD_at_Audi_Manchester_01.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2023_Audi_R8_Coupe_V10_Performance_RWD_at_Audi_Manchester_02.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Audi_R8_V10_RWS_IMG_0669.jpg (side / front 3/4).'
    };
  })();

  /* ================================================================ Chevrolet Corvette Stingray (C8, 2020–) */
  // Signature: long, pointed cab-forward wedge with a long rear deck, sharp swept headlamps, the huge side
  // scoop sculpted into the doors, a black quarter vent behind the pointed side window, glass engine hatch
  // between buttresses, angular stacked tail lamps on a black rear fascia, quad tips in two corner pairs.
  (function () {
    var S = [
      { x: 2.39, pts: [[0.12, 0], [0.12, 0.30], [0.17, 0.38], [0.27, 0.42], [0.37, 0.40], [0.43, 0.34], [0.455, 0.26], [0.465, 0.18], [0.47, 0.11], [0.47, 0.05], [0.47, 0]] },
      { x: 2.25, pts: [[0.11, 0], [0.11, 0.60], [0.16, 0.68], [0.28, 0.70], [0.42, 0.68], [0.50, 0.60], [0.515, 0.50], [0.51, 0.38], [0.505, 0.25], [0.50, 0.12], [0.50, 0]] },
      { x: 1.95, pts: [[0.12, 0], [0.12, 0.80], [0.20, 0.875], [0.37, 0.895], [0.53, 0.87], [0.635, 0.80], [0.655, 0.68], [0.635, 0.52], [0.62, 0.35], [0.61, 0.17], [0.605, 0]] },
      { x: 1.50, pts: [[0.13, 0], [0.13, 0.88], [0.25, 0.93], [0.44, 0.94], [0.62, 0.925], [0.73, 0.87], [0.755, 0.75], [0.73, 0.57], [0.715, 0.38], [0.70, 0.19], [0.695, 0]] },
      { x: 1.05, pts: [[0.13, 0], [0.13, 0.88], [0.26, 0.93], [0.46, 0.935], [0.65, 0.92], [0.79, 0.86], [0.82, 0.76], [0.80, 0.58], [0.785, 0.40], [0.775, 0.20], [0.77, 0]] },
      { x: 0.82, pts: [[0.12, 0], [0.12, 0.87], [0.26, 0.92], [0.46, 0.93], [0.66, 0.915], [0.80, 0.86], [0.845, 0.76], [0.84, 0.63], [0.83, 0.44], [0.822, 0.22], [0.82, 0]] },
      { x: 0.40, pts: [[0.12, 0], [0.12, 0.87], [0.26, 0.92], [0.47, 0.93], [0.68, 0.915], [0.82, 0.87], [0.87, 0.81], [0.885, 0.70], [0.96, 0.62], [1.0, 0.36], [1.015, 0]] },
      { x: -0.10, pts: [[0.12, 0], [0.12, 0.88], [0.26, 0.93], [0.48, 0.94], [0.7, 0.93], [0.84, 0.89], [0.89, 0.84], [0.905, 0.71], [1.185, 0.63], [1.21, 0.36], [1.22, 0]] },
      { x: -0.50, pts: [[0.12, 0], [0.12, 0.9], [0.27, 0.94], [0.5, 0.95], [0.73, 0.94], [0.87, 0.91], [0.92, 0.86], [0.93, 0.7], [1.195, 0.62], [1.22, 0.35], [1.23, 0]] },
      { x: -0.95, pts: [[0.12, 0], [0.12, 0.93], [0.28, 0.955], [0.52, 0.965], [0.76, 0.96], [0.9, 0.935], [0.98, 0.88], [1.005, 0.7], [1.17, 0.53], [1.2, 0.31], [1.205, 0]] },
      { x: -1.40, pts: [[0.14, 0], [0.14, 0.94], [0.30, 0.965], [0.55, 0.97], [0.79, 0.965], [0.93, 0.94], [1.02, 0.87], [1.08, 0.70], [1.13, 0.52], [1.15, 0.30], [1.155, 0]] },
      { x: -1.85, pts: [[0.17, 0], [0.17, 0.92], [0.33, 0.95], [0.58, 0.955], [0.82, 0.95], [0.96, 0.92], [1.04, 0.85], [1.08, 0.70], [1.095, 0.52], [1.10, 0.30], [1.10, 0]] },
      { x: -2.10, pts: [[0.20, 0], [0.20, 0.86], [0.35, 0.89], [0.60, 0.90], [0.83, 0.89], [0.97, 0.86], [1.05, 0.80], [1.09, 0.66], [1.10, 0.48], [1.105, 0.28], [1.105, 0]] },
      { x: -2.22, pts: [[0.30, 0], [0.30, 0.70], [0.40, 0.78], [0.62, 0.80], [0.84, 0.79], [0.96, 0.75], [1.04, 0.68], [1.08, 0.56], [1.095, 0.42], [1.10, 0.24], [1.10, 0]] }
    ];
    var M = [
      row(10, 'paint', { 0: 'black', 1: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black', 8: 'glass', 9: 'glass' }),
      row(10, 'paint', { 0: 'black', 7: 'glass', 8: 'glass', 9: 'glass' }),
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),              // removable roof panel
      row(10, 'paint', { 0: 'black', 7: 'glass', 9: 'paint2' }),
      row(10, 'paint', { 0: 'black', 7: 'black', 9: 'glass' }),               // quarter vent, engine hatch glass
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black', 1: 'black' })
    ];
    DEFS['chevrolet-corvette-c8'] = {
      body: { stations: S, mats: M, capF: 'black', capR: 'paint' },
      parts: [].concat(
        // sharp swept headlamps with the DRL blade along the top edge
        polys([[[0.40, 0.50], [0.70, 0.535], [0.90, 0.62], [0.88, 0.655], [0.66, 0.60], [0.42, 0.545]]], 'front', 'gloss', 0.006, true),
        polys([[[0.46, 0.515], [0.70, 0.548], [0.86, 0.622], [0.84, 0.64], [0.64, 0.588], [0.47, 0.537]]], 'front', 'light', 0.009, true),
        polys([strip([0.44, 0.545], [0.66, 0.598], 0.012), strip([0.66, 0.598], [0.88, 0.652], 0.010)], 'front', 'drl', 0.012, true),
        // black lower: centre intake, big outer intakes, splitter; crossed-flags badge on the nose
        polys([[[-0.46, 0.13], [0.46, 0.13], [0.50, 0.24], [0.40, 0.36], [-0.40, 0.36], [-0.50, 0.24]]], 'front', 'grille', 0.005, false),
        polys([[[0.54, 0.13], [0.94, 0.14], [0.95, 0.34], [0.86, 0.44], [0.60, 0.38]]], 'front', 'grille', 0.005, true),
        polys([rect(-0.90, 0.11, 0.90, 0.145)], 'front', 'black', 0.006, false),
        polys([[[-0.06, 0.42], [0, 0.40], [0.06, 0.42], [0.05, 0.445], [0, 0.43], [-0.05, 0.445]]], 'front', 'badge', 0.008, false),
        // side: the big door scoop (dark opening + body-colour lip), black sill
        // the big side scoop behind the door (top under the belt, swept lower lip)
        polys([[[-0.38, 0.84], [-0.98, 0.88], [-1.0, 0.62], [-0.64, 0.47], [-0.44, 0.52]]], 'side', 'grille', 0.005, true),
        polys([rect(-0.95, 0.12, 0.95, 0.21)], 'side', 'black', 0.004, true),
        [
          { t: 'prism', mat: 'mirror', mirror: true, z0: 0.86, z1: 1.0, pts2d: [[0.40, 0.88], [0.22, 0.885], [0.21, 0.945], [0.38, 0.95]] },
          { t: 'box', mat: 'black', mirror: true, c: [0.34, 0.87, 0.84], s: [0.06, 0.025, 0.08] }
        ],
        // rear: black fascia, stacked angular tail lamps, corner vents, plate, diffuser
        polys([[[0.36, 0.80], [0.80, 0.82], [0.94, 0.90], [0.92, 0.94], [0.76, 0.87], [0.36, 0.845]]], 'rear', 'tail', 0.009, true),
        polys([[[0.42, 0.73], [0.82, 0.75], [0.92, 0.82], [0.90, 0.85], [0.78, 0.79], [0.42, 0.765]]], 'rear', 'tail', 0.009, true),
        polys([[[0.52, 0.32], [0.95, 0.33], [0.97, 0.66], [0.84, 0.70], [0.58, 0.50]]], 'rear', 'grille', 0.008, true),
        polys([rect(-0.26, 0.48, 0.26, 0.60)], 'rear', 'plate', 0.009, false),
        polys([[[-0.94, 0.32], [0.94, 0.32], [0.90, 0.17], [-0.90, 0.17]]], 'rear', 'black', 0.007, false)
      ),
      wheels: { style: 'split', spokes: 5 },
      notes: 'Chevrolet Corvette Stingray (C8) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:Chevrolet_Corvette_C8_IAA_2021_1X7A0156.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2021_Chevrolet_Corvette_C8_rear.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Chevrolet_Corvette_C8_State_Street_Bridge_downtown_Montpelier_VT_May_2022_side.jpg (side), ' +
        'https://commons.wikimedia.org/wiki/File:Gray_Corvette_C8_(side)_(1).jpg (rear 3/4).'
    };
  })();

  /* ================================================================ Ford GT (2nd gen, 2017–2022) */
  // Signature: very low, wide and long; a narrow teardrop cabin with flying buttresses running from the roof to
  // the rear pods with REAL open air channels between them and the cabin; pinched doors between the front
  // fenders and the rear pods with big scoops, long swept headlamps, bonnet extractor vents, hollow ring tail
  // lamps at the channel exits, twin central round exhausts.
  (function () {
    var S = [
      { x: 2.34, pts: [[0.15, 0], [0.15, 0.26], [0.19, 0.32], [0.24, 0.34], [0.29, 0.32], [0.32, 0.27], [0.335, 0.20], [0.34, 0.14], [0.345, 0.09], [0.35, 0.045], [0.35, 0]] },
      { x: 2.18, pts: [[0.12, 0], [0.12, 0.58], [0.16, 0.67], [0.24, 0.71], [0.33, 0.70], [0.405, 0.64], [0.42, 0.54], [0.40, 0.40], [0.395, 0.26], [0.405, 0.13], [0.41, 0]] },
      { x: 1.85, pts: [[0.13, 0], [0.13, 0.86], [0.20, 0.92], [0.32, 0.945], [0.45, 0.93], [0.54, 0.86], [0.555, 0.74], [0.48, 0.56], [0.465, 0.38], [0.48, 0.19], [0.485, 0]] },
      { x: 1.40, pts: [[0.14, 0], [0.14, 0.92], [0.24, 0.985], [0.39, 1.0], [0.54, 0.99], [0.645, 0.93], [0.67, 0.80], [0.57, 0.62], [0.56, 0.40], [0.585, 0.20], [0.59, 0]] },
      { x: 1.00, pts: [[0.13, 0], [0.13, 0.92], [0.24, 0.975], [0.42, 0.99], [0.60, 0.975], [0.73, 0.91], [0.765, 0.78], [0.735, 0.60], [0.73, 0.40], [0.755, 0.20], [0.76, 0]] },
      { x: 0.75, pts: [[0.12, 0], [0.12, 0.90], [0.24, 0.95], [0.42, 0.96], [0.62, 0.94], [0.75, 0.87], [0.79, 0.76], [0.79, 0.62], [0.79, 0.42], [0.79, 0.21], [0.79, 0]] },
      { x: 0.30, pts: [[0.12, 0], [0.12, 0.93], [0.22, 0.88], [0.42, 0.74], [0.62, 0.745], [0.735, 0.74], [0.79, 0.69], [0.80, 0.60], [0.81, 0.42], [0.81, 0.21], [0.81, 0]] },
      { x: -0.30, pts: [[0.12, 0], [0.12, 0.95], [0.22, 0.90], [0.42, 0.76], [0.63, 0.765], [0.745, 0.755], [0.80, 0.70], [0.81, 0.60], [0.82, 0.42], [0.82, 0.21], [0.82, 0]] },
      { x: -0.75, pts: [[0.12, 0], [0.12, 0.94], [0.26, 0.97], [0.46, 0.98], [0.66, 0.975], [0.80, 0.94], [0.86, 0.86], [0.82, 0.70], [0.80, 0.54], [0.81, 0.40], [0.81, 0]] },
      { x: -1.10, pts: [[0.13, 0], [0.13, 0.97], [0.27, 0.995], [0.48, 1.0], [0.70, 0.99], [0.86, 0.95], [0.90, 0.84], [0.74, 0.74], [0.72, 0.46], [0.80, 0.38], [0.82, 0]] },
      { x: -1.60, pts: [[0.15, 0], [0.15, 0.97], [0.29, 0.995], [0.50, 1.0], [0.71, 0.99], [0.86, 0.955], [0.90, 0.85], [0.75, 0.75], [0.73, 0.48], [0.84, 0.30], [0.86, 0]] },
      { x: -2.05, pts: [[0.16, 0], [0.16, 0.95], [0.32, 0.975], [0.54, 0.98], [0.73, 0.97], [0.87, 0.935], [0.92, 0.84], [0.84, 0.75], [0.83, 0.50], [0.89, 0.30], [0.91, 0]] },
      { x: -2.42, pts: [[0.42, 0], [0.42, 0.80], [0.50, 0.86], [0.62, 0.88], [0.76, 0.87], [0.87, 0.84], [0.92, 0.76], [0.90, 0.68], [0.90, 0.48], [0.92, 0.30], [0.93, 0]] }
    ];
    var M = [
      row(10, 'paint', { 0: 'black', 1: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),                                      // door top shelf (cabin sits on it)
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black' }),
      row(10, 'paint', { 0: 'black', 7: 'black', 8: 'black' }),              // channel entry
      row(10, 'paint', { 0: 'black', 7: 'black', 8: 'black', 9: 'black' }),  // air channels + louvred deck
      row(10, 'paint', { 0: 'black', 7: 'black', 8: 'black', 9: 'black' }),
      row(10, 'paint', { 0: 'black', 1: 'black', 7: 'black', 8: 'black' })   // tail
    ];
    var C = [
      { x: 0.78, pts: [[0.79, 0.62], [0.79, 0.60], [0.795, 0.54], [0.80, 0.44], [0.80, 0.26], [0.80, 0]] },
      { x: 0.40, pts: [[0.80, 0.62], [0.81, 0.60], [0.85, 0.55], [0.90, 0.46], [0.945, 0.27], [0.955, 0]] },
      { x: 0.0, pts: [[0.80, 0.62], [0.81, 0.60], [0.90, 0.54], [1.03, 0.42], [1.075, 0.24], [1.085, 0]] },
      { x: -0.35, pts: [[0.81, 0.60], [0.82, 0.58], [0.92, 0.52], [1.05, 0.40], [1.095, 0.23], [1.105, 0]] },
      { x: -0.80, pts: [[0.80, 0.52], [0.83, 0.50], [0.93, 0.45], [1.02, 0.36], [1.05, 0.20], [1.06, 0]] },
      { x: -1.20, pts: [[0.80, 0.38], [0.81, 0.37], [0.88, 0.34], [0.95, 0.27], [0.985, 0.15], [0.995, 0]] },
      { x: -1.65, pts: [[0.84, 0.08], [0.845, 0.075], [0.855, 0.06], [0.865, 0.045], [0.87, 0.025], [0.875, 0]] }
    ];
    var CM = [
      ['paint', 'paint', 'glass', 'glass', 'glass'],     // windscreen
      ['paint', 'glass', 'glass', 'glass', 'glass'],     // windscreen top + door glass
      ['paint', 'glass', 'glass', 'paint', 'paint2'],    // roof
      ['paint', 'glass', 'glass', 'paint', 'paint2'],    // roof
      ['paint', 'paint', 'paint', 'paint', 'glass'],     // engine-cover spine with the rear window
      ['paint', 'paint', 'paint', 'paint', 'glass']
    ];
    // flying buttress: a flat box-section beam from the roof corner to the rear pod (3D quads, mirrored)
    function beam(pts, w, t) {
      var out = [];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1], wa = a[3] != null ? a[3] : w, wb = b[3] != null ? b[3] : w;
        var A0 = [a[0], a[1], a[2] - wa / 2], A1 = [a[0], a[1], a[2] + wa / 2], B0 = [b[0], b[1], b[2] - wb / 2], B1 = [b[0], b[1], b[2] + wb / 2];
        var dn = function (p) { return [p[0], p[1] - t, p[2]]; };
        out.push({ t: 'poly', mat: 'paint', mirror: true, normal: [0, 1, 0], pts: [A0, A1, B1, B0] });
        out.push({ t: 'poly', mat: 'paint', mirror: true, normal: [0, -1, 0], pts: [dn(A0), dn(B0), dn(B1), dn(A1)] });
        out.push({ t: 'poly', mat: 'paint', mirror: true, normal: [0, 0, 1], pts: [A1, dn(A1), dn(B1), B1] });
        out.push({ t: 'poly', mat: 'paint', mirror: true, normal: [0, 0, -1], pts: [A0, B0, dn(B0), dn(A0)] });
      }
      return out;
    }
    DEFS['ford-gt-2017'] = {
      body: { stations: S, mats: M, capF: 'black', capR: 'paint' },
      cabin: { stations: C, mats: CM, capF: null, capR: 'paint' },
      parts: [].concat(
        beam([[-0.62, 1.045, 0.40, 0.14], [-1.05, 0.995, 0.56], [-1.55, 0.95, 0.68], [-2.0, 0.925, 0.76], [-2.40, 0.915, 0.80, 0.16]], 0.13, 0.045),
        // long swept headlamps with the LED light-pipe outline
        polys([[[0.42, 0.40], [0.72, 0.45], [0.93, 0.53], [0.92, 0.575], [0.70, 0.53], [0.44, 0.46]]], 'front', 'gloss', 0.006, true),
        polys([[[0.48, 0.415], [0.72, 0.462], [0.89, 0.538], [0.88, 0.56], [0.70, 0.515], [0.49, 0.45]]], 'front', 'light', 0.009, true),
        polys([strip([0.44, 0.46], [0.70, 0.53], 0.010), strip([0.70, 0.53], [0.92, 0.575], 0.010), strip([0.42, 0.40], [0.44, 0.46], 0.010)], 'front', 'drl', 0.012, true),
        // wide black mouth, splitter, oval badge
        polys([[[-0.62, 0.14], [0.62, 0.14], [0.76, 0.22], [0.60, 0.31], [0, 0.27], [-0.60, 0.31], [-0.76, 0.22]]], 'front', 'grille', 0.005, false),
        polys([rect(-0.96, 0.11, 0.96, 0.15)], 'front', 'black', 0.006, false),
        polys([ell(0, 0.325, 0.05, 0.022, 8)], 'front', 'badge', 0.008, false),
        // bonnet heat-extractor vents either side of the centre keel
        polys([[[2.06, 0.10], [2.02, 0.36], [1.70, 0.42], [1.66, 0.13]]], 'top', 'grille', 0.005, true),
        // side: pinched door with the big scoop into the rear pod, sill, mirrors
        polys([[[-0.20, 0.30], [-0.70, 0.36], [-0.86, 0.74], [-0.70, 0.80], [-0.45, 0.50]]], 'side', 'grille', 0.005, true),
        polys([rect(-0.96, 0.13, 0.96, 0.22)], 'side', 'black', 0.004, true),
        [
          { t: 'prism', mat: 'mirror', mirror: true, z0: 0.70, z1: 0.88, pts2d: [[0.48, 0.86], [0.30, 0.865], [0.29, 0.93], [0.46, 0.935]] },
          { t: 'box', mat: 'black', mirror: true, c: [0.42, 0.835, 0.66], s: [0.05, 0.06, 0.06] }
        ],
        // rear: hollow ring tail lamps at the channel exits, dark rear panel, exhaust surround, diffuser, plate
        polys(ring(0.70, 0.72, 0.08, 0.145, 10), 'rear', 'tail', 0.009, true),
        polys([ell(0.70, 0.72, 0.08, 0.08, 10)], 'rear', 'gloss', 0.008, true),
        polys([rect(-0.20, 0.47, 0.20, 0.61)], 'rear', 'gloss', 0.006, false),
        polys([[[-0.92, 0.44], [0.92, 0.44], [0.86, 0.20], [-0.86, 0.20]]], 'rear', 'grille', 0.007, false),
        polys([rect(-0.25, 0.31, 0.25, 0.42)], 'rear', 'plate', 0.010, false)
      ),
      wheels: { style: 'split', spokes: 5 },
      // twin centre tips sit high, at the ring tail lamps' height (generator exhaust override; base model cy 0.54)
      exhaust: [{ cx: 0.085, cy: 0.72, w: 0.12, h: 0.12, mirror: true }],
      notes: 'Ford GT (2nd gen) — hand-authored low-poly with open flying-buttress air channels. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2018_Ford_GT.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2017_Ford_GT_front.JPG (front 3/4 / side), ' +
        'https://commons.wikimedia.org/wiki/File:2017_Ford_GT_rear.JPG (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ford_GT_(2nd_generation)_coupes_Motorworld_Munich_1X7A0028.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Ford_GT_(2nd_generation)_coupes_1X7A0192.jpg (rear 3/4).'
    };
  })();

  Object.keys(DEFS).forEach(function (id) { reg(id, DEFS[id]); });
  if (typeof module !== 'undefined' && module.exports) module.exports = DEFS;
})();

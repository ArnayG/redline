/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/pickup-van.js
   Hand-authored low-poly pickups and vans (docs/LOWPOLY-SPEC.md):
     toyota-tacoma-trdpro-2024, tesla-cybertruck, mercedes-sprinter-vs30, vw-id-buzz, ford-transit-hr.

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body / cabin stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.
   The generator mirrors them, cuts the wheel wells at the fitted axles, fits the stations to the build and
   projects `view` polygons onto the facets they land on. Front of the body = wheelbase/2 + front overhang,
   rear = -(wheelbase/2 + rear overhang), so the car is centred on its overall length.
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
  /** thick line segment (quad) from p to q, width w, in view coordinates */
  function seg(p, q, w) {
    var dx = q[0] - p[0], dy = q[1] - p[1], l = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / l * w / 2, ny = dx / l * w / 2;
    return [[p[0] - nx, p[1] - ny], [q[0] - nx, q[1] - ny], [q[0] + nx, q[1] + ny], [p[0] + nx, p[1] + ny]];
  }
  // block capitals on a 3x5 grid: [col0, row0, col1, row1] (rows from the bottom)
  var GLYPH = {
    A: [[0, 0, 1, 4], [2, 0, 3, 4], [0.45, 4, 2.55, 5], [1, 2, 2, 2.9]],
    C: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 0, 3, 1]],
    D: [[0, 0, 1, 5], [1, 0, 2.2, 1], [1, 4, 2.2, 5], [2.2, 0.8, 3, 4.2]],
    E: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.4, 3], [1, 0, 3, 1]],
    I: [[1, 0, 2, 5]],
    L: [[0, 0, 1, 5], [1, 0, 3, 1]],
    M: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 3.2, 2, 4.4]],
    N: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 2.4, 2, 4.2]],
    O: [[0, 0, 1, 5], [2, 0, 3, 5], [1, 0, 2, 1], [1, 4, 2, 5]],
    R: [[0, 0, 1, 5], [1, 4, 2.6, 5], [2, 2.6, 3, 4], [1, 2, 2.6, 3], [2, 0, 3, 2]],
    S: [[0, 4, 3, 5], [0, 2, 1, 4], [1, 2, 3, 3], [2, 0, 3, 2], [0, 0, 2, 1]],
    T: [[0, 4, 3, 5], [1, 0, 2, 4]],
    Y: [[0, 3, 1, 5], [2, 3, 3, 5], [0.4, 2.2, 2.6, 3.1], [1, 0, 2, 2.2]]
  };
  /** word centred at (ac, bc), letter height h; dir = +1 when +a reads left -> right for the viewer; asp widens */
  function word(txt, ac, bc, h, dir, asp) {
    var k = asp || 1, cell = h / 5, cw = cell * k, lw = 3 * cw, gap = cw * 1.1, total = txt.length * lw + (txt.length - 1) * gap, out = [];
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
  /** arch band (side profile, segments of an arch ring) extruded across z */
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs, flatTop) {
    var parts = [], n = segs || 6;
    for (var k = 0; k < n; k++) {
      var a0 = Math.PI * k / n, a1 = Math.PI * (k + 1) / n;
      var P = function (r, a) {
        var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (flatTop) y = Math.min(y, cy + r * 0.86);
        return [x, y];
      };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, a0), P(rOut, a0), P(rOut, a1), P(rIn, a1)] });
    }
    return parts;
  }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  /** piecewise-linear profile: knots [[x, v], ...] (any x order) -> v(x) */
  function pl(knots) {
    var K = knots.slice().sort(function (a, b) { return a[0] - b[0]; });
    return function (x) {
      if (x <= K[0][0]) return K[0][1];
      for (var i = 0; i < K.length - 1; i++) if (x <= K[i + 1][0]) return lerp(K[i][1], K[i + 1][1], (x - K[i][0]) / (K[i + 1][0] - K[i][0]));
      return K[K.length - 1][1];
    };
  }

  /* ================================================================ Toyota Tacoma TRD Pro (N400, 2024–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Toyota_Tacoma):
  //   front:     https://commons.wikimedia.org/wiki/File:2024_Cleveland_Auto_Show_(53571764732).jpg  (TRD Pro)
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Toyota_Tacoma_TRD_Off_Road_(N400)_IMG_9727.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Toyota_Tacoma_TRD_Off_Road_(N400)_IMG_9735.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2024_Toyota_Tacoma_iForce_Max_au_SIAM_2024.jpg
  // Signature: hexagonal black grille box with heritage TOYOTA block letters over an LED light bar, slim
  // lamps on the upper grille corners with vertical vent slots beneath, hood scoop, silver skid plate,
  // square black flares, double cab + 5 ft bed, tall tail lamps, stamped TACOMA tailgate.
  if (!GLYPH.P) GLYPH.P = [[0, 0, 1, 5], [1, 4, 2.6, 5], [2, 2.4, 3, 4], [1, 2, 2.6, 3]];   // "TRD PRO" bed badge
  var TACOMA = {
    body: {
      // pts: 0 bottom centre, 1 bottom edge, 2 lower flank, 3 waist, 4 upper flank, 5 shoulder,
      //      6 hood edge / bed-rail inner, 7 hood / bed wall, 8 centre (hood or bed floor)
      stations: [
        { x: 2.555, pts: [[0.50, 0], [0.50, 0.76], [0.60, 0.84], [0.95, 0.865], [1.20, 0.865], [1.285, 0.82], [1.30, 0.60], [1.305, 0.32], [1.305, 0]] },
        { x: 2.50, pts: [[0.47, 0], [0.47, 0.82], [0.57, 0.90], [0.95, 0.925], [1.23, 0.925], [1.325, 0.88], [1.34, 0.62], [1.345, 0.33], [1.345, 0]] },
        { x: 2.30, pts: [[0.49, 0], [0.50, 0.88], [0.60, 0.945], [0.95, 0.968], [1.24, 0.968], [1.35, 0.922], [1.365, 0.66], [1.372, 0.34], [1.372, 0]] },
        { x: 1.80, pts: [[0.55, 0], [0.555, 0.92], [0.64, 0.955], [0.95, 0.972], [1.25, 0.972], [1.365, 0.93], [1.385, 0.67], [1.395, 0.34], [1.395, 0]] },
        { x: 0.92, pts: [[0.50, 0], [0.51, 0.92], [0.59, 0.955], [0.86, 0.972], [1.27, 0.972], [1.40, 0.935], [1.425, 0.70], [1.44, 0.34], [1.44, 0]] },
        { x: -1.10, pts: [[0.50, 0], [0.51, 0.92], [0.59, 0.955], [0.86, 0.972], [1.27, 0.972], [1.405, 0.935], [1.425, 0.72], [1.44, 0.34], [1.44, 0]] },
        { x: -1.16, pts: [[0.62, 0], [0.62, 0.92], [0.68, 0.955], [0.90, 0.972], [1.27, 0.972], [1.425, 0.945], [1.425, 0.84], [0.98, 0.82], [0.98, 0]] },
        { x: -1.80, pts: [[0.62, 0], [0.62, 0.93], [0.69, 0.96], [0.95, 0.972], [1.27, 0.972], [1.43, 0.945], [1.43, 0.84], [0.98, 0.82], [0.98, 0]] },
        { x: -2.84, pts: [[0.64, 0], [0.64, 0.92], [0.69, 0.95], [0.95, 0.968], [1.27, 0.968], [1.42, 0.94], [1.42, 0.84], [0.98, 0.82], [0.98, 0]] },
        { x: -2.885, pts: [[0.68, 0], [0.68, 0.86], [0.71, 0.89], [0.95, 0.90], [1.30, 0.90], [1.405, 0.89], [1.405, 0.66], [1.405, 0.34], [1.405, 0]] }
      ],
      mats: [
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // fascia
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // nose
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // front fender
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // to the cowl
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint', 'paint'],   // cab (under the cabin shell)
        ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'black', 'black'],   // cab back / bed front wall
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black', 'black'],   // bed
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black', 'black'],   // bed
        ['black', 'black', 'paint', 'paint', 'paint', 'black', 'paint', 'paint']    // tailgate
      ],
      capF: 'paint', capR: 'paint'
    },
    cabin: {
      // pts: belt, glass base, roof rail, roof edge, roof centre
      stations: [
        { x: 1.00, pts: [[1.405, 0.925], [1.425, 0.915], [1.43, 0.88], [1.435, 0.84], [1.44, 0]] },
        { x: 0.29, pts: [[1.405, 0.935], [1.44, 0.92], [1.885, 0.80], [1.925, 0.74], [1.943, 0]] },
        { x: -0.24, pts: [[1.405, 0.935], [1.44, 0.92], [1.885, 0.80], [1.925, 0.74], [1.943, 0]] },
        { x: -0.36, pts: [[1.405, 0.935], [1.44, 0.92], [1.882, 0.80], [1.922, 0.74], [1.94, 0]] },
        { x: -0.98, pts: [[1.405, 0.935], [1.44, 0.92], [1.872, 0.80], [1.912, 0.74], [1.93, 0]] },
        { x: -1.10, pts: [[1.405, 0.925], [1.435, 0.91], [1.855, 0.79], [1.895, 0.73], [1.915, 0]] }
      ],
      mats: [
        ['paint', 'glass', 'glass', 'glass'],      // windscreen + front door glass up to the A-pillar
        ['paint', 'glass', 'paint', 'paint'],      // front door glass, roof
        ['paint', 'gloss', 'paint', 'paint'],      // B-pillar
        ['paint', 'glass', 'paint', 'paint'],      // rear door glass
        ['paint', 'paint', 'paint', 'paint']       // C-pillar
      ],
      capF: null, capR: 'paint'
    },
    parts: [].concat(
      // hexagonal grille box, inner hex cells, heritage TOYOTA letters, LED bar beneath them
      polys([[[-0.60, 0.945], [0.60, 0.945], [0.70, 1.050], [0.67, 1.262], [-0.67, 1.262], [-0.70, 1.050]]], 'front', 'grille', 0.004, false),
      polys((function () {   // hex mesh cells (TRD Pro): two full rows under the light bar, cells flanking the letter plate
        var out = [];
        [[0.985, 0], [1.035, 0.065], [1.15, 0], [1.20, 0.065]].forEach(function (rw, r) {
          for (var k = -5; k <= 5; k++) {
            var z = k * 0.13 + rw[1];
            if (Math.abs(z) > 0.62 - (r === 0 ? 0.04 : 0)) continue;
            if (r >= 2 && Math.abs(z) < 0.33) continue;
            out.push(ell(z, rw[0], 0.056, 0.026, 6));
          }
        });
        return out;
      })(), 'front', 'carbon', 0.007, false),
      polys([rect(-0.31, 1.122, 0.31, 1.218)], 'front', 'gloss', 0.007, false),
      polys(word('TOYOTA', 0, 1.170, 0.072, -1, 1.4), 'front', 'badge', 0.011, false),
      polys([rect(-0.32, 1.060, 0.32, 1.085)], 'front', 'drl', 0.009, false),
      // slim lamps on the upper grille corners (amber tip) + vertical vent slots under them
      // big wedge headlamps on the outer corners (top at the hood line, white DRL bar along the bottom) and the
      // stacked vent slots under them beside the grille
      polys([[[0.665, 1.145], [0.695, 1.272], [0.905, 1.290], [0.915, 1.195], [0.875, 1.125]]], 'front', 'gloss', 0.006, true),
      polys([[[0.705, 1.180], [0.725, 1.255], [0.885, 1.268], [0.892, 1.205], [0.86, 1.168]]], 'front', 'light', 0.009, true),
      polys([[[0.675, 1.132], [0.875, 1.122], [0.885, 1.145], [0.685, 1.158]]], 'front', 'drl', 0.010, true),
      polys([[[0.885, 1.205], [0.905, 1.195], [0.902, 1.262], [0.888, 1.262]]], 'front', 'indicator', 0.011, true),
      polys([rect(0.71, 0.945, 0.835, 1.105)], 'front', 'black', 0.006, true),
      polys([0, 1, 2, 3].map(function (k) { var y = 0.962 + k * 0.036; return rect(0.72, y, 0.825, y + 0.014); }), 'front', 'gloss', 0.009, true),
      // lower bumper: black centre, fog / LED pods, silver skid plate with dark cut-outs
      // body-colour bumper bar under the grille, black lower intake (amber LED fog bars at its outer ends,
      // plate box), grey skid plate with dark teeth along the bottom
      polys([[[-0.54, 0.69], [0.54, 0.69], [0.64, 0.845], [-0.64, 0.845]]], 'front', 'black', 0.005, false),
      polys([[[-0.48, 0.71], [0.48, 0.71], [0.58, 0.83], [-0.58, 0.83]]], 'front', 'grille', 0.008, false),
      polys([rect(-0.13, 0.76, 0.13, 0.83)], 'front', 'black', 0.010, false),
      polys([[[0.40, 0.785], [0.56, 0.785], [0.585, 0.81], [0.42, 0.81]]], 'front', 'indicator', 0.011, true),
      polys([[[-0.54, 0.47], [0.54, 0.47], [0.64, 0.64], [-0.64, 0.64]]], 'front', 'chrome', 0.008, false),
      polys([[[-0.62, 0.615], [0.62, 0.615], [0.63, 0.63], [-0.63, 0.63]]], 'front', 'white', 0.011, false),
      polys([-0.40, -0.20, 0, 0.20, 0.40].map(function (z) { return rect(z - 0.07, 0.49, z + 0.07, 0.53); }), 'front', 'black', 0.011, false),
      // cab rear window + 3rd brake light
      polys([rect(-0.62, 1.56, 0.62, 1.84)], 'rear', 'glass', 0.005, false),
      polys([rect(-0.14, 1.865, 0.14, 1.89)], 'rear', 'tail', 0.008, false),
      // rear: tall tail lamps with dark spine, stamped TACOMA, handle, bumper step, plate
      polys([[[0.79, 0.96], [0.94, 0.96], [0.94, 1.39], [0.84, 1.39]]], 'rear', 'tail', 0.006, true),
      polys([rect(0.89, 1.04, 0.925, 1.30)], 'rear', 'gloss', 0.009, true),
      polys([rect(-0.11, 1.28, 0.11, 1.32)], 'rear', 'black', 0.006, false),
      polys(word('TACOMA', 0, 1.105, 0.085, 1, 2.05), 'rear', 'gloss', 0.006, false),
      polys([rect(-0.62, 0.68, 0.62, 0.86)], 'rear', 'black', 0.005, false),
      polys([rect(-0.16, 0.89, 0.16, 0.97)], 'rear', 'plate', 0.008, false),
      // door handles, TACOMA door badge
      polys([rect(0.34, 1.29, 0.48, 1.32), rect(-0.56, 1.29, -0.42, 1.32)], 'side', 'black', 0.004, true),
      polys([[[0.99, 1.43], [0.80, 1.43], [0.80, 1.58]]], 'side', 'gloss', 0.006, true),
      // TRD PRO lettering on the rear of the bed sides (each flank reads left -> right)
      polys(word('TRD PRO', -2.42, 1.30, 0.06, 1, 1.15), 'side', 'gloss', 0.005, false),
      polys(word('TRD PRO', -2.42, 1.30, 0.06, -1, 1.15), 'left', 'gloss', 0.005, false),
      // hood scoop (TRD Pro) — black, in the hood centre
      [{ t: 'prism', mat: 'black', z0: -0.27, z1: 0.27, pts2d: [[2.05, 1.36], [1.45, 1.42], [1.38, 1.475], [1.92, 1.395]] }],
      // square black flares
      flare(1.675, 0.414, 0.47, 0.585, 0.88, 1.015, 'black', 6, true),
      flare(-1.675, 0.414, 0.47, 0.585, 0.88, 1.015, 'black', 6, true),
      [
        // rock rails, bed-rail caps, mirrors on black feet, rear bumper step
        { t: 'box', mat: 'black', mirror: true, c: [-0.10, 0.50, 0.92], s: [2.0, 0.06, 0.13] },
        { t: 'box', mat: 'black', mirror: true, c: [-2.0, 1.432, 0.94], s: [1.78, 0.02, 0.11] },
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.95, z1: 1.16, pts2d: [[0.93, 1.47], [0.71, 1.465], [0.715, 1.69], [0.89, 1.70]] },
        { t: 'poly', mat: 'glass', mirror: true, normal: [-1, 0, 0], pts: [[0.705, 1.485, 0.98], [0.705, 1.485, 1.145], [0.705, 1.675, 1.145], [0.705, 1.675, 0.98]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.86, 1.455, 0.95], s: [0.13, 0.05, 0.09] },
        { t: 'box', mat: 'black', c: [-2.90, 0.70, 0], s: [0.10, 0.12, 1.24] },
        // rear bumper: black centre step, body-colour corner caps (photos)
        { t: 'box', mat: 'paint', mirror: true, c: [-2.87, 0.73, 0.78], s: [0.14, 0.15, 0.30] }
      ]
    ),
    // TRD Pro: matte black 18 in forged wheels, red TRD callipers (photos)
    wheels: { style: 'star', spokes: 6, tyre: 'at', stock: { rim: '#1c1d1f', material: 'forged', caliper: '#c01818' } },
    notes: 'Toyota Tacoma TRD Pro (N400, 2024) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2024_Cleveland_Auto_Show_(53571764732).jpg (front, TRD Pro), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_Tacoma_TRD_Off_Road_(N400)_IMG_9727.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_Tacoma_TRD_Off_Road_(N400)_IMG_9735.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2024_Cleveland_Auto_Show_(53573068825).jpg (front 3/4, TRD Pro: wheels / red callipers), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_Tacoma_TRD_Off_Road_(N400)_DSC_7353.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Toyota_Tacoma_N400_Double_Cab.jpg (front). Final check 2026-10: deeper ' +
      'front fascia (bumper to ~0.47 m), big wedge corner headlamps with DRL bar, body-colour bumper bar over the black ' +
      'lower intake + grey skid plate, body-colour rear bumper corners, factory TRD Pro wheel look (wheels.stock).'
  };
  // shoulder crease: the flank leans out to a sharp horizontal crease a hand below the belt and tucks back in
  // above it (both trucks carry one along the doors and the bed), so the light splits the slab side in two
  TACOMA.body.stations.forEach(function (st) {
    var a = st.pts[3], b = st.pts[4];
    if (Math.abs(a[1] - b[1]) < 0.015) { a[1] -= 0.012; b[0] -= 0.05; b[1] += 0.014; }
  });
  reg('toyota-tacoma-trdpro-2024', TACOMA);

  /* ================================================================ Tesla Cybertruck (2024–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Tesla_Cybertruck):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2024_Tesla_Cybertruck_Foundation_Series,_front_left_(Greenwich).jpg
  //   side 3/4:  https://commons.wikimedia.org/wiki/File:Cybertruck_supercharging_at_Bravoland.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Tesla_Cybertruck_-_04.jpg
  // Signature: a single flat-faceted stainless wedge — straight bonnet/windscreen plane rising to an apex over
  // the rear doors, straight sail falling to the tailgate, flat vertical flanks with a bevel crease, angular
  // trapezoid black arch cladding, full-width front light bar on the nose edge and full-width rear bar.
  var CYB = (function () {
    var XF = 2.807, XR = -2.875, XA = -0.35;            // nose, tail, apex
    var top = pl([[XF, 1.075], [XA, 1.79], [XR, 1.215]]);
    var belt = pl([[XF, 1.04], [XR, 1.13]]);
    var ze = pl([[XF, 0.92], [2.35, 0.84], [1.35, 0.74], [XA, 0.64], [-1.25, 0.68], [XR, 0.82]]);
    function ring(x, yb, zb) {
      var t = top(x), b = belt(x);
      return { x: x, pts: [[yb, 0], [yb, zb], [0.60, 1.0], [b, 1.0], [Math.min(b + 0.085, t - 0.004), 0.93], [t - 0.008, ze(x)], [t - 0.002, ze(x) * 0.5], [t, 0]] };
    }
    var st = [
      { x: XF, pts: [[0.50, 0], [0.50, 0.90], [0.62, 0.97], [1.045, 0.97], [1.07, 0.925], [1.073, 0.88], [1.075, 0.44], [1.075, 0]] },
      ring(2.74, 0.44, 0.96),
      ring(2.35, 0.44, 0.96),
      ring(1.35, 0.44, 0.96),
      ring(1.00, 0.44, 0.96),
      ring(-0.28, 0.44, 0.96),
      ring(-0.42, 0.44, 0.96),
      ring(-0.98, 0.44, 0.96),
      ring(-1.25, 0.44, 0.96),
      ring(-2.78, 0.46, 0.96),
      { x: XR, pts: [[0.52, 0], [0.52, 0.92], [0.64, 0.97], [1.10, 0.97], [1.15, 0.925], [1.205, 0.81], [1.212, 0.41], [1.215, 0]] }
    ];
    return {
      body: {
        // pts: 0 bottom centre, 1 bottom edge, 2 sill top (cladding), 3 belt crease, 4 bevel, 5 roof / bonnet edge,
        //      6 roof quarter, 7 centre line
        stations: st,
        //     c0 under  c1 sill   c2 flank c3 belt  c4 bevel/glass c5 roof  c6 roof
        mats: [
          ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // nose edge
          ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // bonnet
          ['black', 'black', 'paint', 'paint', 'paint', 'paint', 'paint'],    // bonnet
          ['black', 'black', 'paint', 'paint', 'paint', 'glass', 'glass'],    // windscreen, A-pillar side
          ['black', 'black', 'paint', 'paint', 'glass', 'glass', 'glass'],    // front door glass, windscreen / glass roof
          ['black', 'black', 'paint', 'paint', 'gloss', 'glass', 'glass'],    // B-pillar
          ['black', 'black', 'paint', 'paint', 'glass', 'glass', 'glass'],    // rear door glass, rear window behind the apex
          ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black'],    // C-pillar, start of the matte black vault tonneau
          ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black'],    // stainless sail rails + tonneau
          ['black', 'black', 'paint', 'paint', 'paint', 'black', 'black']     // tail (tonneau to the tailgate)
        ],
        capF: 'paint', capR: 'paint'
      },
      parts: [].concat(
        // full-width front light bar along the nose edge (headlamps hidden in it), dark lower bumper + intake
        // (planar strips just ahead of the nose face, so they read at full height from the front)
        [{ t: 'poly', mat: 'gloss', normal: [1, 0, 0], pts: [[2.811, 0.985, -0.95], [2.811, 0.985, 0.95], [2.811, 1.04, 0.95], [2.811, 1.04, -0.95]] },
         { t: 'poly', mat: 'drl', normal: [1, 0, 0], pts: [[2.815, 1.00, -0.93], [2.815, 1.00, 0.93], [2.815, 1.025, 0.93], [2.815, 1.025, -0.93]] },
         { t: 'poly', mat: 'light', mirror: true, normal: [1, 0, 0], pts: [[2.818, 0.995, 0.78], [2.818, 0.995, 0.93], [2.818, 1.03, 0.93], [2.818, 1.03, 0.78]] }],
        polys([rect(-1.0, 0.50, 1.0, 0.70)], 'front', 'black', 0.005, false),
        polys([rect(-0.55, 0.56, 0.55, 0.66)], 'front', 'grille', 0.008, false),
                // rear: full-width red bar on the tailgate top edge, dark bumper, plate, tailgate seam
        polys([[[0.0, 1.10], [0.958, 1.10], [0.965, 1.19], [0.0, 1.19]]], 'rear', 'gloss', 0.005, true),
        polys([[[0.0, 1.135], [0.95, 1.135], [0.955, 1.16], [0.0, 1.16]]], 'rear', 'tail', 0.008, true),
        polys([rect(-1.0, 0.52, 1.0, 0.76)], 'rear', 'black', 0.005, false),
        polys([rect(0.70, 0.78, 0.84, 0.80)], 'rear', 'tail', 0.008, true),
        // door seams / handles-free flanks: the door cut lines
        polys([rect(1.0, 0.62, 1.012, 1.04), rect(-0.30, 0.62, -0.288, 1.07), rect(-1.25, 0.62, -1.238, 1.08)], 'side', 'black', 0.004, true),
        // angular trapezoid arch cladding (3-segment, thick as on the real truck) + dark rocker; the black
        // bumpers wrap round the corners into the arch cladding (cyb-b / cyb-a photos)
        flare(1.81737, 0.43925, 0.52, 0.665, 0.90, 1.025, 'black', 3, false),
        flare(-1.81737, 0.43925, 0.52, 0.665, 0.90, 1.025, 'black', 3, false),
        polys([[[2.46, 0.44], [2.82, 0.48], [2.82, 0.72], [2.42, 0.70]]], 'side', 'black', 0.004, true),
        polys([[[-2.46, 0.46], [-2.88, 0.50], [-2.88, 0.77], [-2.42, 0.72]]], 'side', 'black', 0.004, true),
        [
          { t: 'box', mat: 'black', mirror: true, c: [-0.0, 0.50, 0.985], s: [2.40, 0.14, 0.05] },
          { t: 'box', mat: 'black', c: [2.80, 0.58, 0], s: [0.08, 0.20, 1.98] },
          { t: 'box', mat: 'black', c: [-2.87, 0.63, 0], s: [0.10, 0.24, 1.98] },
          { t: 'box', mat: 'plate', c: [-2.922, 0.65, 0], s: [0.01, 0.11, 0.32] },
          // small black door mirrors at the front corner of the door glass, mirror glass facing back
          { t: 'prism', mat: 'gloss', mirror: true, z0: 0.90, z1: 1.09, pts2d: [[1.03, 1.20], [0.87, 1.21], [0.87, 1.33], [0.99, 1.33]] },
          { t: 'poly', mat: 'glass', mirror: true, normal: [-1, 0, 0], pts: [[0.865, 1.225, 0.93], [0.865, 1.225, 1.075], [0.865, 1.315, 1.075], [0.865, 1.315, 0.93]] }
        ]
      ),
      wheels: { style: 'split', spokes: 6, tyre: 'at', stock: { rim: '#2b2d30', material: 'flow-formed', caliper: '#262628' } },   // dark grey wheels, black callipers (photos)   // black 20 in twin-spoke (covers off) on 35 in all-terrains
      notes: 'Tesla Cybertruck (2024) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2024_Tesla_Cybertruck_Foundation_Series,_front_left_(Greenwich).jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Cybertruck_supercharging_at_Bravoland.jpg (side 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Tesla_Cybertruck_-_04.jpg (3/4).'
    };
  })();
  reg('tesla-cybertruck', CYB);

  /* ================================================================ shared van builder */
  // Van body rings (11 pts): 0 bottom centre, 1 bottom edge, 2 sill, 3 rub-strip top, 4 belt, 5 glass top,
  // 6 upper side, 7 roof shoulder, 8 roof edge, 9 roof quarter, 10 centre line.
  function vanRing(x, o) {
    return { x: x, pts: [[o.yb, 0], [o.yb, o.zb], [o.ys, o.w], [o.yr, o.w + 0.004], [o.belt, o.w - 0.006], [o.gt, o.w - 0.035],
      [o.up, o.w - 0.06], [o.sh, o.w - 0.10], [o.re, o.w - 0.17], [o.rq, o.w * 0.5], [o.top, 0]] };
  }

  /* ================================================================ Mercedes-Benz Sprinter (VS30, 2018–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Mercedes-Benz_Sprinter):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2019_Mercedes-Benz_Sprinter_314_CDi_2.1.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2018_Mercedes-Benz_Sprinter_314_CDi_2.1_Front.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2018_Mercedes-Benz_Sprinter_314_CDi_2.1_Rear.jpg
  // Signature: short sloping bonnet with a protruding dark bumper, two-slat grille with the big three-pointed
  // star, swept headlamps on the fender corners, steep windscreen under a smooth high-roof cap, tall flat
  // flanks with passenger windows and a dark rub strip, tall narrow tail lamps on the rear corners.
  var SPRINTER = (function () {
    var W = 1.0;
    function R(x, o) { var d = { yb: 0.44, zb: 0.97, ys: 0.58, yr: 0.80, belt: 1.33, gt: 1.95, up: 2.42, sh: 2.62, re: 2.70, rq: 2.725, top: 2.73, w: W }; for (var k in o) d[k] = o[k]; return vanRing(x, d); }
    var st = [
      // bumper face (protrudes ahead of the grille), grille face, short bonnet, cowl
      { x: 2.8255, pts: [[0.36, 0], [0.36, 0.80], [0.44, 0.90], [0.70, 0.92], [0.745, 0.90], [0.75, 0.87], [0.752, 0.82], [0.754, 0.74], [0.756, 0.60], [0.758, 0.40], [0.76, 0]] },
      { x: 2.77, pts: [[0.33, 0], [0.33, 0.88], [0.42, 0.96], [0.76, 0.975], [0.99, 0.935], [1.03, 0.89], [1.045, 0.82], [1.05, 0.74], [1.055, 0.60], [1.06, 0.40], [1.06, 0]] },
      { x: 2.58, pts: [[0.33, 0], [0.33, 0.93], [0.43, 0.99], [0.78, 1.0], [1.08, 0.975], [1.115, 0.935], [1.13, 0.87], [1.14, 0.78], [1.145, 0.62], [1.15, 0.40], [1.15, 0]] },
      { x: 2.20, pts: [[0.36, 0], [0.37, 0.96], [0.50, 1.005], [0.80, 1.01], [1.20, 0.995], [1.225, 0.955], [1.24, 0.89], [1.245, 0.80], [1.25, 0.64], [1.255, 0.42], [1.26, 0]] },
      R(1.62, { gt: 1.335, up: 1.34, sh: 1.345, re: 1.35, rq: 1.355, top: 1.36 }),
      R(1.20, { gt: 1.62, up: 1.70, sh: 1.72, re: 1.73, rq: 1.735, top: 1.74 }),
      R(0.78, { gt: 1.95, up: 2.08, sh: 2.11, re: 2.13, rq: 2.14, top: 2.145 }),
      R(0.50, { up: 2.36, sh: 2.53, re: 2.60, rq: 2.625, top: 2.63 }),
      R(0.40),
      R(0.28),
      R(-0.70),
      R(-0.80),
      R(-1.80),
      R(-1.90),
      R(-2.90, { sh: 2.60, re: 2.68, rq: 2.71, top: 2.715 }),
      R(-3.04, { up: 2.40, sh: 2.55, re: 2.62, rq: 2.65, top: 2.655 }),
      R(-3.1065, { yb: 0.46, zb: 0.94, gt: 1.95, up: 2.36, sh: 2.50, re: 2.57, rq: 2.60, top: 2.605, w: 0.985 })
    ];
    //       c0 under  c1 sill  c2 strip  c3 flank c4 glass c5 upper c6 sh   c7 roof c8 roof c9 roof
    var P = 'paint', G = 'glass', K = 'black', Q = 'gloss';
    var mats = [
      [K, K, K, K, K, K, K, K, K, K],          // bumper top -> grille face
      [K, K, K, P, P, P, P, P, P, P],          // nose
      [K, K, K, P, P, P, P, P, P, P],          // bonnet
      [K, K, K, P, P, P, P, P, P, P],          // bonnet -> cowl
      [K, P, K, P, P, P, G, G, G, G],          // windscreen (A-pillar side painted)
      [K, P, K, P, G, P, G, G, G, G],          // windscreen top, front door glass
      [K, P, K, P, G, P, P, P, P, P],          // door glass under the high-roof cap
      [K, P, K, P, G, P, P, P, P, P],
      [K, P, K, P, Q, P, P, P, P, P],          // B-pillar
      [K, P, K, P, G, P, P, P, P, P],          // sliding-door window
      [K, P, K, P, Q, P, P, P, P, P],          // pillar
      [K, P, K, P, G, P, P, P, P, P],          // side window
      [K, P, K, P, Q, P, P, P, P, P],          // pillar
      [K, P, K, P, G, P, P, P, P, P],          // rear side window
      [K, P, K, P, P, P, P, P, P, P],          // rear corner
      [K, K, K, P, P, P, P, P, P, P]           // rear corner
    ];
    // three-pointed star in a ring (front view coordinates, centre (a, b), radius r)
    function star(a, b, r, dir) {
      var out = [];
      for (var k = 0; k < 3; k++) {
        var t = Math.PI / 2 + k * Math.PI * 2 / 3, t1 = t + Math.PI / 2, w = r * 0.13;
        out.push([[a + Math.cos(t) * r * 0.92 * dir, b + Math.sin(t) * r * 0.92], [a + Math.cos(t1) * w * dir, b + Math.sin(t1) * w], [a - Math.cos(t1) * w * dir, b - Math.sin(t1) * w]]);
      }
      return out;
    }
    return {
      body: { stations: st, mats: mats, capF: 'black', capR: 'paint' },
      parts: [].concat(
        // grille: dark trapezoid, two slats, big star in a ring
        polys([[[-0.47, 0.775], [0.47, 0.775], [0.52, 1.015], [-0.52, 1.015]]], 'front', 'grille', 0.004, false),
        polys([rect(-0.49, 0.865, 0.49, 0.885), rect(-0.505, 0.94, 0.505, 0.96)], 'front', 'chrome', 0.007, false),
        polys([ell(0, 0.905, 0.10, 0.10, 14)], 'front', 'chrome', 0.009, false),
        polys([ell(0, 0.905, 0.085, 0.085, 14)], 'front', 'grille', 0.011, false),
        polys(star(0, 0.905, 0.085, 1), 'front', 'chrome', 0.013, false),
        // headlamps swept round the fender corners (+ the side return)
        // (audit: the lamps read as small white slivers — the real units are big, run the full grille height and
        //  sweep a long way back up the fender towards the bonnet shut line)
        polys([[[0.52, 0.86], [0.80, 0.83], [0.96, 0.86], [1.01, 0.97], [0.99, 1.075], [0.55, 1.05]]], 'front', 'gloss', 0.006, true),
        polys([[[0.555, 0.88], [0.80, 0.85], [0.945, 0.875], [0.985, 0.97], [0.97, 1.055], [0.575, 1.035]]], 'front', 'light', 0.009, true),
        polys([[[0.58, 0.885], [0.80, 0.858], [0.94, 0.88], [0.94, 0.90], [0.80, 0.876], [0.58, 0.903]]], 'front', 'drl', 0.012, true),
        polys([[[0.60, 0.935], [0.86, 0.925], [0.92, 0.96], [0.90, 1.005], [0.62, 1.01]]], 'front', 'gloss', 0.012, true),
        polys([rect(0.66, 0.955, 0.86, 0.975)], 'front', 'chrome', 0.014, true),
        polys([[[2.79, 0.86], [2.52, 0.90], [2.30, 1.02], [2.24, 1.14], [2.48, 1.13], [2.70, 1.09], [2.80, 1.06]]], 'side', 'gloss', 0.005, true),
        polys([[[2.77, 0.88], [2.54, 0.92], [2.33, 1.03], [2.29, 1.12], [2.48, 1.11], [2.70, 1.07], [2.78, 1.04]]], 'side', 'light', 0.008, true),
        polys([[[2.76, 0.89], [2.60, 0.915], [2.57, 0.945], [2.765, 0.92]]], 'side', 'indicator', 0.011, true),
        // bumper: lower intake, plate, fog lamps
        // (real: a wide mesh intake under the grille with the plate set low in the bumper beneath it)
        polys([[[-0.56, 0.56], [0.56, 0.56], [0.60, 0.72], [-0.60, 0.72]]], 'front', 'grille', 0.006, false),
        polys([rect(-0.54, 0.625, 0.54, 0.64), rect(-0.56, 0.665, 0.56, 0.68)], 'front', 'gloss', 0.009, false),
        polys([rect(-0.26, 0.42, 0.26, 0.53)], 'front', 'plate', 0.008, false),
        polys([rect(0.68, 0.56, 0.84, 0.64)], 'front', 'gloss', 0.007, true),
        // bonnet vents at the base of the windscreen
        polys([rect(1.66, 0.30, 1.78, 0.70)], 'top', 'black', 0.004, true),
        // rear: tall corner lamps, split doors with windows, star, plate, 3rd brake light, bumper
        polys([[[0.83, 0.80], [0.985, 0.80], [0.985, 1.36], [0.85, 1.36]]], 'rear', 'tail', 0.006, true),
        polys([rect(0.94, 0.95, 0.975, 1.12)], 'rear', 'rev', 0.009, true),
        polys([rect(0.07, 1.42, 0.80, 1.98)], 'rear', 'glass', 0.006, true),
        polys([rect(-0.006, 0.62, 0.006, 2.45)], 'rear', 'black', 0.008, false),
        polys([ell(0, 1.22, 0.07, 0.07, 12)], 'rear', 'chrome', 0.008, false),
        polys(star(0, 1.22, 0.058, -1), 'rear', 'gloss', 0.011, false),
        polys([rect(0.12, 1.06, 0.24, 1.09)], 'rear', 'black', 0.009, true),
        polys([rect(-0.26, 0.66, 0.26, 0.78)], 'rear', 'plate', 0.009, false),
        polys([rect(-0.30, 2.56, 0.30, 2.585)], 'rear', 'tail', 0.008, false),
        // side: amber markers on the rub strip, door handles, sliding-door rail
        polys([rect(0.18, 0.66, 0.24, 0.70), rect(-2.30, 0.66, -2.24, 0.70)], 'side', 'indicator', 0.008, true),
        polys([rect(0.80, 1.20, 0.92, 1.23), rect(0.10, 1.20, 0.22, 1.23)], 'side', 'black', 0.006, true),
        flare(1.8325, 0.387, 0.445, 0.475, 0.97, 1.01, 'black', 5, false),
        flare(-1.8325, 0.387, 0.445, 0.475, 0.97, 1.01, 'black', 5, false),
        [
          { t: 'box', mat: 'black', c: [-3.07, 0.52, 0], s: [0.16, 0.18, 2.0] },
          // big door mirrors on arms
          { t: 'prism', mat: 'gloss', mirror: true, z0: 1.00, z1: 1.22, pts2d: [[1.20, 1.44], [1.08, 1.44], [1.07, 1.72], [1.17, 1.72]] },
          { t: 'box', mat: 'black', mirror: true, c: [1.19, 1.50, 1.02], s: [0.08, 0.05, 0.08] }
        ]
      ),
      wheels: { style: 'star', spokes: 5, stock: { rim: '#b9bcc0', material: 'steel', caliper: '#2a2a2a' } },   // silver steel wheels, black callipers (photos)
      notes: 'Mercedes-Benz Sprinter (VS30) 144" high roof — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2019_Mercedes-Benz_Sprinter_314_CDi_2.1.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2018_Mercedes-Benz_Sprinter_314_CDi_2.1_Front.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2018_Mercedes-Benz_Sprinter_314_CDi_2.1_Rear.jpg (rear 3/4).'
    };
  })();
  reg('mercedes-sprinter-vs30', SPRINTER);

  /* ================================================================ Ford Transit (gen 4, 2020– facelift) 148" high roof */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Ford_Transit):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2020_Ford_Transit_350_Leader_EcoBlue_2.0_facelift_Front.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2020_Ford_Transit_350_Leader_EcoBlue_2.0_facelift_Rear.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2015_Ford_Transit_250_MR_148%22,_fR.jpg
  // Signature: tall blunt nose with a big trapezoid grille (three horizontal bars + Ford oval), large swept
  // headlamps reaching up the fender sides, long rising bonnet flowing into the windscreen, high-roof cap with
  // a peak over the windscreen, a deep black lower band along the whole van, tall corner tail lamps.
  var TRANSIT = (function () {
    var W = 1.02;
    function R(x, o) {
      var d = { yb: 0.42, zb: 0.99, ys: 0.48, yr: 0.78, belt: 1.36, gt: 1.98, up: 2.48, sh: 2.69, re: 2.78, rq: 2.80, top: 2.804, w: W };
      for (var k in o) d[k] = o[k];
      var r = vanRing(x, d);
      // Transit side character: the flank leans out to a sharp shoulder crease right under the side glass
      r.pts[3][1] = d.w - 0.012; r.pts[4][1] = d.w + 0.032;
      return r;
    }
    var st = [
      // upright Ford nose: bumper face, near-vertical grille face, short steep bonnet, cowl
      { x: 2.899, pts: [[0.36, 0], [0.36, 0.84], [0.42, 0.93], [0.72, 0.95], [0.795, 0.93], [0.80, 0.90], [0.802, 0.84], [0.804, 0.76], [0.806, 0.60], [0.808, 0.40], [0.81, 0]] },
      { x: 2.87, pts: [[0.34, 0], [0.34, 0.90], [0.40, 0.98], [0.80, 0.99], [1.19, 0.965], [1.225, 0.925], [1.24, 0.86], [1.245, 0.76], [1.25, 0.60], [1.255, 0.40], [1.255, 0]] },
      { x: 2.70, pts: [[0.34, 0], [0.34, 0.95], [0.42, 1.01], [0.80, 1.02], [1.28, 1.01], [1.315, 0.97], [1.33, 0.90], [1.336, 0.80], [1.34, 0.62], [1.344, 0.40], [1.345, 0]] },
      { x: 2.20, pts: [[0.38, 0], [0.39, 0.98], [0.48, 1.02], [0.80, 1.025], [1.38, 1.025], [1.415, 0.98], [1.43, 0.91], [1.438, 0.82], [1.444, 0.64], [1.448, 0.42], [1.45, 0]] },
      R(1.70, { gt: 1.50, up: 1.505, sh: 1.51, re: 1.515, rq: 1.52, top: 1.525 }),
      R(1.30, { gt: 1.76, up: 1.86, sh: 1.88, re: 1.89, rq: 1.895, top: 1.90 }),
      R(1.00, { gt: 1.98, up: 2.12, sh: 2.145, re: 2.155, rq: 2.16, top: 2.165 }),
      // high-roof brow: a forward lip over the windscreen header, then the cap rises steeply to the roof
      R(0.965, { up: 2.34, sh: 2.39, re: 2.41, rq: 2.415, top: 2.42 }),
      R(0.80, { up: 2.45, sh: 2.60, re: 2.645, rq: 2.66, top: 2.665 }),
      R(0.55, { up: 2.48, sh: 2.68, re: 2.765, rq: 2.79, top: 2.795 }),
      R(0.42),
      R(0.30),
      R(-0.75),
      R(-0.85),
      R(-1.95),
      R(-2.05),
      R(-2.92, { sh: 2.67, re: 2.75, rq: 2.78, top: 2.785 }),
      R(-3.03, { up: 2.44, sh: 2.62, re: 2.70, rq: 2.73, top: 2.735 }),
      R(-3.083, { yb: 0.44, zb: 0.96, up: 2.40, sh: 2.56, re: 2.64, rq: 2.67, top: 2.675, w: 1.005 })
    ];
    var P = 'paint', G = 'glass', K = 'black', Q = 'gloss';
    var mats = [
      [K, K, K, P, P, P, P, P, P, P],          // grille face (body-colour surround; grille / lamps are parts)
      [K, K, K, P, P, P, P, P, P, P],          // nose
      [K, K, K, P, P, P, P, P, P, P],          // bonnet
      [K, K, K, P, P, P, P, P, P, P],          // bonnet -> cowl
      [K, K, K, P, P, P, G, G, G, G],          // windscreen
      [K, K, K, P, G, P, G, G, G, G],          // windscreen top, front door glass
      [K, K, K, P, G, P, P, P, P, P],          // brow lip face
      [K, K, K, P, G, P, P, P, P, P],          // roof cap front
      [K, K, K, P, G, P, P, P, P, P],
      [K, K, K, P, G, P, P, P, P, P],
      [K, K, K, P, Q, P, P, P, P, P],          // B-pillar
      [K, K, K, P, G, P, P, P, P, P],          // sliding-door window
      [K, K, K, P, Q, P, P, P, P, P],          // pillar
      [K, K, K, P, G, P, P, P, P, P],          // side window
      [K, K, K, P, Q, P, P, P, P, P],          // pillar
      [K, K, K, P, G, P, P, P, P, P],          // rear side window
      [K, K, K, P, P, P, P, P, P, P],          // rear corner
      [K, K, K, P, P, P, P, P, P, P]           // rear corner
    ];
    return {
      body: { stations: st, mats: mats, capF: 'black', capR: 'paint' },
      parts: [].concat(
        // big upright trapezoid grille with three bright bars + Ford oval
        polys([[[-0.45, 0.785], [0.45, 0.785], [0.535, 1.225], [-0.535, 1.225]]], 'front', 'chrome', 0.003, false),
        polys([[[-0.42, 0.81], [0.42, 0.81], [0.50, 1.20], [-0.50, 1.20]]], 'front', 'grille', 0.005, false),
        polys([0.87, 0.98, 1.09].map(function (y, i) { var w = 0.43 + i * 0.022; return rect(-w, y, w, y + 0.05); }), 'front', 'chrome', 0.008, false),
        polys([ell(0, 1.02, 0.115, 0.052, 14)], 'front', 'chrome', 0.010, false),
        polys([ell(0, 1.02, 0.098, 0.041, 14)], 'front', 'gloss', 0.012, false),
        // large swept headlamps (and their side return up the fender)
        polys([[[0.51, 1.02], [0.54, 1.235], [0.93, 1.20], [0.99, 1.12], [0.97, 1.03]]], 'front', 'gloss', 0.006, true),
        polys([[[0.54, 1.04], [0.565, 1.215], [0.91, 1.185], [0.96, 1.12], [0.94, 1.045]]], 'front', 'light', 0.009, true),
        polys([[[0.80, 1.045], [0.94, 1.045], [0.955, 1.08], [0.80, 1.08]]], 'front', 'indicator', 0.012, true),
        // dark projector band across the inner lamp (keeps the lens from reading as a blank white block)
        polys([[[0.58, 1.10], [0.84, 1.095], [0.88, 1.13], [0.84, 1.165], [0.60, 1.175]]], 'front', 'gloss', 0.012, true),
        polys([[[2.87, 1.00], [2.60, 1.14], [2.42, 1.36], [2.70, 1.31], [2.88, 1.21]]], 'side', 'gloss', 0.005, true),
        polys([[[2.85, 1.03], [2.61, 1.15], [2.47, 1.33], [2.70, 1.28], [2.86, 1.19]]], 'side', 'light', 0.008, true),
        // black bumper: lower intake, fog pods, plate
        polys([[[-0.62, 0.45], [0.62, 0.45], [0.58, 0.60], [-0.58, 0.60]]], 'front', 'grille', 0.006, false),
        polys([rect(0.66, 0.50, 0.84, 0.58)], 'front', 'gloss', 0.007, true),
        polys([rect(-0.26, 0.63, 0.26, 0.75)], 'front', 'plate', 0.008, false),
        // bonnet vents
        polys([rect(1.95, 0.20, 2.05, 0.52)], 'top', 'black', 0.004, true),
        // rear: tall corner lamps, split doors with windows, plate, 3rd brake light, bumper
        polys([[[0.85, 0.82], [1.0, 0.82], [1.0, 1.47], [0.87, 1.47]]], 'rear', 'tail', 0.006, true),
        polys([rect(0.89, 1.04, 0.97, 1.20)], 'rear', 'rev', 0.009, true),
        polys([rect(0.07, 1.46, 0.84, 2.02)], 'rear', 'glass', 0.006, true),
        polys([rect(-0.006, 0.80, 0.006, 2.52)], 'rear', 'black', 0.008, false),
        polys(word('TRANSIT', -0.35, 1.30, 0.05, 1, 1.3), 'rear', 'gloss', 0.008, false),
        polys([rect(0.12, 1.18, 0.24, 1.21)], 'rear', 'black', 0.009, true),
        polys([rect(-0.32, 2.61, 0.32, 2.64)], 'rear', 'tail', 0.008, false),
        // side: door handles, sliding-door rail
        polys([rect(0.95, 1.24, 1.07, 1.27), rect(0.12, 1.24, 0.24, 1.27)], 'side', 'black', 0.006, true),
        polys([rect(-2.95, 1.30, -0.80, 1.33)], 'side', 'gloss', 0.008, true),
        polys([rect(-0.80, 2.08, 0.80, 2.15)], 'front', 'gloss', 0.007, false),
        flare(1.875, 0.356, 0.425, 0.47, 0.98, 1.03, 'black', 5, false),
        flare(-1.875, 0.356, 0.425, 0.47, 0.98, 1.03, 'black', 5, false),
        [
          { t: 'box', mat: 'black', c: [-3.04, 0.56, 0], s: [0.16, 0.26, 2.04] },
          { t: 'box', mat: 'plate', c: [-3.125, 0.62, 0], s: [0.01, 0.11, 0.50] },
          // big door mirrors with indicator
          { t: 'prism', mat: 'gloss', mirror: true, z0: 1.02, z1: 1.24, pts2d: [[1.28, 1.48], [1.14, 1.48], [1.13, 1.78], [1.25, 1.78]] },
          { t: 'box', mat: 'black', mirror: true, c: [1.26, 1.55, 1.04], s: [0.08, 0.05, 0.08] }
        ]
      ),
      wheels: { style: 'star', spokes: 8, stock: { rim: '#b4b7bb', material: 'steel', caliper: '#2a2a2a' } },   // silver steel wheels, black callipers (photos)
      notes: 'Ford Transit (gen 4, 2020 facelift) 350 148" high roof — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2020_Ford_Transit_350_Leader_EcoBlue_2.0_facelift_Front.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2020_Ford_Transit_350_Leader_EcoBlue_2.0_facelift_Rear.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2015_Ford_Transit_250_MR_148%22,_fR.jpg (front 3/4, US).'
    };
  })();
  reg('ford-transit-hr', TRANSIT);

  /* ================================================================ Volkswagen ID. Buzz (2022–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Volkswagen_ID._Buzz):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2025_Volkswagen_ID.Buzz_1st_Edition_4MOTION_in_Candy_White_%26_Pomelo_Yellow_Metallic_two-tone,_front_left,_2025-03-14.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2025_Volkswagen_ID._Buzz_1st_Edition_4MOTION_in_Candy_White_%26_Pomelo_Yellow_Metallic_two-tone,_rear_right,_2025-05-18.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Volkswagen_ID._Buzz_1X7A6263.jpg
  // Signature: Bulli two-tone — white upper body, roof and a big white V on the nose over the coloured lower
  // body; slim lamps joined by a light strip through the large VW roundel; short sloping nose, upright
  // windscreen, very short overhangs, huge glasshouse with black pillars, honeycomb lower intake, full-width
  // rear light bar on the colour split, white D-pillars with three slots.
  var BUZZ = (function () {
    function R(x, o) {
      var d = { yb: 0.30, zb: 0.90, y2: 0.40, z2: 0.975, yw: 0.70, zw: 0.995, ysh: 1.08, zsh: 0.985, yg: 1.15, zg: 0.955, ygt: 1.80, zgt: 0.865, yre: 1.885, zre: 0.77, yrq: 1.925, top: 1.938 };
      for (var k in o) d[k] = o[k];
      return { x: x, pts: [[d.yb, 0], [d.yb, d.zb], [d.y2, d.z2], [d.yw, d.zw], [d.ysh, d.zsh], [d.yg, d.zg], [d.ygt, d.zgt], [d.yre, d.zre], [d.yrq, 0.42], [d.top, 0]] };
    }
    var st = [
      { x: 2.345, pts: [[0.32, 0], [0.32, 0.70], [0.37, 0.80], [0.50, 0.84], [0.62, 0.82], [0.66, 0.78], [0.68, 0.70], [0.69, 0.55], [0.695, 0.30], [0.70, 0]] },
      { x: 2.30, pts: [[0.28, 0], [0.28, 0.80], [0.34, 0.90], [0.56, 0.935], [0.80, 0.905], [0.85, 0.86], [0.88, 0.78], [0.90, 0.62], [0.91, 0.34], [0.91, 0]] },
      { x: 2.20, pts: [[0.28, 0], [0.28, 0.85], [0.35, 0.95], [0.62, 0.975], [0.95, 0.95], [0.99, 0.915], [1.02, 0.83], [1.03, 0.66], [1.04, 0.36], [1.04, 0]] },
      { x: 1.98, pts: [[0.29, 0], [0.29, 0.88], [0.37, 0.97], [0.66, 0.99], [1.04, 0.978], [1.075, 0.945], [1.095, 0.865], [1.105, 0.70], [1.11, 0.38], [1.115, 0]] },
      R(1.80, { ysh: 1.07, yg: 1.12, ygt: 1.135, zgt: 0.90, yre: 1.145, zre: 0.80, yrq: 1.15, top: 1.155 }),
      R(1.30, { ygt: 1.58, zgt: 0.875, yre: 1.60, zre: 0.79, yrq: 1.61, top: 1.615 }),
      R(1.00),
      R(0.40),
      R(0.28),
      R(-0.86),
      R(-0.98),
      R(-1.86),
      R(-2.20, { ygt: 1.79, yre: 1.875, yrq: 1.915, top: 1.928 }),
      R(-2.367, { yb: 0.34, zb: 0.86, z2: 0.93, zw: 0.95, zsh: 0.945, zg: 0.92, ygt: 1.76, zgt: 0.83, yre: 1.84, zre: 0.73, yrq: 1.875, top: 1.885 })
    ];
    var P = 'paint', G = 'glass', K = 'black', Q = 'gloss', Wt = 'white';
    //       c0 under c1 sill c2 lower c3 flank c4 split c5 glass c6 rail c7 roof c8 roof
    var mats = [
      [K, K, P, P, P, P, P, P, P],           // bumper -> nose
      [K, K, P, P, P, P, P, P, P],           // V-face (white V overlaid)
      [K, K, P, P, Wt, Wt, Wt, Wt, Wt],      // short bonnet (white)
      [K, K, P, P, Wt, Wt, Wt, Wt, Wt],      // cowl
      [K, K, P, P, Wt, Wt, G, G, G],         // windscreen lower
      [K, K, P, P, Wt, G, G, G, G],          // windscreen upper, front door glass
      [K, K, P, P, Wt, G, Wt, Wt, Wt],       // front door glass, white roof
      [K, K, P, P, Wt, Q, Wt, Wt, Wt],       // B-pillar (black)
      [K, K, P, P, Wt, G, Wt, Wt, Wt],       // sliding-door glass
      [K, K, P, P, Wt, Q, Wt, Wt, Wt],       // C-pillar (black)
      [K, K, P, P, Wt, G, Wt, Wt, Wt],       // rear quarter glass
      [K, K, P, P, Wt, Wt, Wt, Wt, Wt],      // white D-pillar
      [K, K, P, P, Wt, Wt, Wt, Wt, Wt]       // tail corner
    ];
    // VW roundel (front / rear view), centre (a, b), radius r
    function vw(a, b, r) {
      var w = r * 0.13;
      return {
        ring: [ell(a, b, r, r, 16)], inner: [ell(a, b, r * 0.84, r * 0.84, 16)],
        lines: [
          seg([a - r * 0.52, b + r * 0.62], [a, b - r * 0.06], w), seg([a + r * 0.52, b + r * 0.62], [a, b - r * 0.06], w),
          seg([a - r * 0.78, b + r * 0.12], [a - r * 0.40, b - r * 0.70], w), seg([a - r * 0.40, b - r * 0.70], [a, b - r * 0.12], w),
          seg([a, b - r * 0.12], [a + r * 0.40, b - r * 0.70], w), seg([a + r * 0.40, b - r * 0.70], [a + r * 0.78, b + r * 0.12], w)
        ]
      };
    }
    // extra block capitals for the rear "ID. BUZZ" badge (local additions; the shared set has no B / U / Z / '.')
    if (!GLYPH.B) GLYPH.B = [[0, 0, 1, 5], [1, 4, 2.4, 5], [1, 2, 2.4, 3], [1, 0, 2.4, 1], [2.2, 3, 3, 4.4], [2.2, 0.6, 3, 2]];
    if (!GLYPH.U) GLYPH.U = [[0, 0, 1, 5], [2, 0, 3, 5], [1, 0, 2, 1]];
    if (!GLYPH.Z) GLYPH.Z = [[0, 4, 3, 5], [0, 0, 3, 1], [1.9, 3, 3, 4], [1, 2, 2, 3], [0, 1, 1.1, 2]];
    if (!GLYPH['.']) GLYPH['.'] = [[1, 0, 2, 1]];
    var fl = vw(0, 1.01, 0.10), rl = vw(0, 1.02, 0.075);
    var holes = [];
    [0.515, 0.445, 0.375].forEach(function (y, r) {
      for (var k = -5; k <= 5; k++) {
        var z = k * 0.15 + (r % 2 ? 0.075 : 0);
        if (Math.abs(z) > 0.80 - (r === 2 ? 0.06 : 0) || (r === 2 && Math.abs(z) < 0.13)) continue;
        holes.push(ell(z, y, 0.066, 0.036, 6, Math.PI / 6 * 0));
      }
    });
    return {
      body: { stations: st, mats: mats, capF: 'paint', capR: 'paint' },
      parts: [].concat(
        // the white V on the nose
        polys([[[-0.93, 1.0], [-0.74, 0.84], [-0.40, 0.68], [0, 0.625], [0.40, 0.68], [0.74, 0.84], [0.93, 1.0], [0.96, 1.12], [-0.96, 1.12]]], 'front', 'white', 0.004, false),
        // slim lamps, the light strip through the roundel, amber tips
        polys([[[0.13, 0.985], [0.78, 0.958], [0.925, 1.005], [0.905, 1.065], [0.15, 1.035]]], 'front', 'gloss', 0.007, true),
        polys([[[0.30, 1.012], [0.80, 1.022], [0.895, 1.035], [0.89, 1.052], [0.30, 1.028]]], 'front', 'light', 0.010, true),
        polys([[[0.45, 0.975], [0.78, 0.965], [0.86, 0.99], [0.78, 0.99], [0.45, 0.995]]], 'front', 'light', 0.010, true),
        polys([rect(0.10, 1.008, 0.30, 1.022)], 'front', 'drl', 0.010, true),
        polys([[[0.81, 1.03], [0.90, 1.022], [0.885, 1.05], [0.80, 1.048]]], 'front', 'indicator', 0.012, true),
        polys(fl.ring, 'front', 'chrome', 0.012, false),
        polys(fl.inner, 'front', 'gloss', 0.014, false),
        polys(fl.lines, 'front', 'chrome', 0.016, false),
        // honeycomb lower intake (body-colour lattice, dark cells) + dark lower lip
        polys(holes, 'front', 'grille', 0.006, false),
        polys([rect(-0.12, 0.33, 0.12, 0.37)], 'front', 'grille', 0.006, false),
        // front plate on the bumper above the honeycomb (audit: missing; the real plate sits over the intake)
        polys([rect(-0.25, 0.455, 0.25, 0.555)], 'front', 'plate', 0.009, false),
        // rear: white upper tailgate, big window, full-width light bar, roundel + ID. BUZZ, plate recess, bumper
        polys([[[-0.96, 1.17], [0.96, 1.17], [0.90, 1.90], [-0.90, 1.90]]], 'rear', 'white', 0.004, false),
        polys([[[-0.76, 1.27], [0.76, 1.27], [0.64, 1.80], [-0.64, 1.80]]], 'rear', 'glass', 0.007, false),
        polys([[[0, 1.115], [0.90, 1.115], [0.945, 1.18], [0, 1.18]]], 'rear', 'tail', 0.008, true),
        polys([[[0.60, 1.10], [0.90, 1.10], [0.945, 1.19], [0.62, 1.19]]], 'rear', 'tail', 0.010, true),
        polys(rl.ring, 'rear', 'chrome', 0.008, false),
        polys(rl.inner, 'rear', 'gloss', 0.010, false),
        polys(rl.lines, 'rear', 'chrome', 0.012, false),
        polys(word('ID. BUZZ', 0, 0.90, 0.036, 1, 0.8), 'rear', 'badge', 0.009, false),
        polys([rect(-0.17, 0.64, 0.17, 0.75)], 'rear', 'gloss', 0.006, false),
        polys([rect(-0.15, 0.65, 0.15, 0.74)], 'rear', 'plate', 0.009, false),
        polys([rect(-0.95, 0.34, 0.95, 0.47)], 'rear', 'black', 0.006, false),
        polys([rect(0.80, 0.42, 0.86, 0.50)], 'rear', 'tail', 0.009, true),
        // side: D-pillar slots, door handles, sliding-door handle
        polys([0, 1, 2].map(function (k) { var y = 1.55 + k * 0.10; return rect(-2.06, y, -1.93, y + 0.03); }), 'side', 'gloss', 0.006, true),
        polys([rect(0.78, 1.00, 0.90, 1.03), rect(0.05, 1.00, 0.17, 1.03)], 'side', 'black', 0.006, true),
        [
          // mirrors (white caps on black arms)
          { t: 'prism', mat: 'gloss', mirror: true, z0: 0.93, z1: 1.13, pts2d: [[1.24, 1.21], [1.06, 1.21], [1.06, 1.36], [1.20, 1.37]] },
          { t: 'box', mat: 'black', mirror: true, c: [1.18, 1.18, 0.97], s: [0.08, 0.04, 0.08] }
        ]
      ),
      wheels: { style: 'turbine', spokes: 5, stock: { rim: '#a7abb0', material: 'cast', caliper: '#2a2a2a' } },   // silver / two-tone alloys, dark callipers (photos)   // 5-blade 'turbine' aero wheel of the 1st Edition / Pro S
      notes: 'Volkswagen ID. Buzz (2022) — hand-authored low-poly. Reference photos: ' +
        'https://commons.wikimedia.org/wiki/File:2025_Volkswagen_ID.Buzz_1st_Edition_4MOTION_in_Candy_White_%26_Pomelo_Yellow_Metallic_two-tone,_front_left,_2025-03-14.jpg (front 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:2025_Volkswagen_ID._Buzz_1st_Edition_4MOTION_in_Candy_White_%26_Pomelo_Yellow_Metallic_two-tone,_rear_right,_2025-05-18.jpg (rear 3/4), ' +
        'https://commons.wikimedia.org/wiki/File:Volkswagen_ID._Buzz_1X7A6263.jpg (front 3/4).'
    };
  })();
  reg('vw-id-buzz', BUZZ);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 'toyota-tacoma-trdpro-2024': TACOMA, 'tesla-cybertruck': CYB, 'mercedes-sprinter-vs30': SPRINTER, 'vw-id-buzz': BUZZ, 'ford-transit-hr': TRANSIT };
  }
})();

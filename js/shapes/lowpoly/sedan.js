/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/sedan.js
   Hand-authored low-poly sports sedans (docs/LOWPOLY-SPEC.md): BMW M3 (G80), Mercedes-AMG C 63 (W206),
   Tesla Model S (2021 refresh), Subaru WRX STI (VA), Mitsubishi Lancer Evolution X.

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body stations are RIGHT half rings [y, z] from the bottom centre round to the top centre, 11 points
   with fixed meaning on every station so glass / roof / trim become clean bands in `mats`:
     0 bottom centre, 1 bottom edge, 2 rocker / lower flank, 3 waist (widest), 4 shoulder line, 5 belt edge,
     6 glass base (bonnet / deck surface on stations without glass), 7 roof rail (DLO top / A- and C-pillar),
     8 roof edge (windscreen / backlight edge), 9 roof quarter, 10 centre line.
   Mats rows are written as 10-letter strings (one letter per column, c0 under .. c9 roof centre), see M below.
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
  // ring outline (thick ring as one concave polygon: outer CCW, seam, inner CW)
  function ringPoly(a, b, ro, ri, n, rbo, rbi) {
    var out = [], i, t;
    rbo = rbo || ro; rbi = rbi || ri;
    for (i = 0; i <= n; i++) { t = i / n * Math.PI * 2 + 0.001; out.push([a + Math.cos(t) * ro, b + Math.sin(t) * rbo]); }
    for (i = n; i >= 0; i--) { t = i / n * Math.PI * 2 + 0.001; out.push([a + Math.cos(t) * ri, b + Math.sin(t) * rbi]); }
    return out;
  }
  /** opt-in generator maxTilt (deg) on projected decals: land on the upright face, not the first sloping facet */
  function tilt(list, deg) { list.forEach(function (p) { p.maxTilt = deg; }); return list; }
  function polys(list, view, mat, off, mirror) {
    return list.map(function (p) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; });
  }
  function poly(view, mat, off, mirror, pts) { return { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: pts }; }
  // block capitals on a 3x5 grid: [col0, row0, col1, row1] rows from the bottom
  var GLYPH = {
    A: [[0, 0, 1, 4.2], [2, 0, 3, 4.2], [0.6, 4, 2.4, 5], [1, 2, 2, 3]],
    E: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.4, 3], [1, 0, 3, 1]],
    L: [[0, 0, 1, 5], [1, 0, 3, 1]],
    S: [[0, 4, 3, 5], [0, 2.5, 1, 4], [0, 2, 3, 3], [2, 1, 3, 2.5], [0, 0, 3, 1]],
    T: [[0, 4, 3, 5], [1, 0, 2, 4]],
    I: [[1, 0, 2, 5]],
    R: [[0, 0, 1, 5], [1, 4, 2.6, 5], [2, 2.6, 3, 4], [1, 2, 2.6, 3], [2, 0, 3, 2]],
    W: [[0, 0, 0.8, 5], [2.2, 0, 3, 5], [1.1, 0, 1.9, 3], [0.8, 0, 2.2, 0.8]],
    X: [[0, 0, 1, 2], [2, 0, 3, 2], [0.8, 2, 2.2, 3], [0, 3, 1, 5], [2, 3, 3, 5]]
  };
  function word(txt, ac, bc, h, dir, wk) {
    var cell = h / 5, cw = cell * (wk || 1), lw = 3 * cw, gap = cw * 1.1, total = txt.length * lw + (txt.length - 1) * gap, out = [];
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
  /** planar polygon in 3D laid on a slope: 2D outline [u (across, z), v (along the slope)] around centre c,
      face tilted tiltDeg up from +x (or -x when back) */
  function slope3d(c, outline, tiltDeg, back, off) {
    var t = tiltDeg * Math.PI / 180, sx = back ? -1 : 1;
    var N = [sx * Math.cos(t), Math.sin(t), 0], V = [-sx * Math.sin(t), Math.cos(t), 0];
    return outline.map(function (q) { return [c[0] + V[0] * q[1] + N[0] * off, c[1] + V[1] * q[1] + N[1] * off, c[2] + q[0]]; });
  }
  function flare(cx, cy, rIn, rOut, z0, z1, mat, segs) {
    var parts = [], n = segs || 6;
    for (var k = 0; k < n; k++) {
      var a0 = Math.PI * k / n, a1 = Math.PI * (k + 1) / n;
      var P = function (r, a) { return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      parts.push({ t: 'prism', mat: mat, mirror: true, z0: z0, z1: z1, pts2d: [P(rIn, a0), P(rOut, a0), P(rOut, a1), P(rIn, a1)] });
    }
    return parts;
  }

  /* ---------------------------------------------------------------- station builders */
  // low = [[bottom edge], [rocker], [waist], [shoulder], [belt edge]] as [y, z]
  /** cabin station: glass base gb, roof rail rl, optional roof-edge e8 (else just inboard of the rail), roof centre y */
  function cab(x, low, gb, rl, yc, e8) {
    var p8 = e8 || [yc - 0.016, rl[1] - 0.075];
    return { x: x, pts: [[low[0][0], 0]].concat(low, [gb, rl, p8, [yc - (yc - p8[0]) * 0.25, p8[1] * 0.5], [yc, 0]]) };
  }
  /** bonnet / deck station: the top surface crowns from the belt edge to the centre height yc;
      zr = z of the roof-rail point (keeps the windscreen / backlight band width continuous) */
  function deck(x, low, yc, zr, crown, dome) {
    var b = low[4], k = crown == null ? 1 : crown, d = dome || 0;   // dome: lift of the power-dome ridge (pt 9) over the centre
    function Y(z) { var u = z / b[1]; return yc - (yc - b[0]) * Math.pow(u, 2) * k - (1 - k) * (yc - b[0]) * u; }
    var z6 = b[1] - 0.035, z8 = zr - 0.075;
    return { x: x, pts: [[low[0][0], 0]].concat(low, [[Y(z6), z6], [Y(zr), zr], [Y(z8) + d * 0.35, z8], [Y(z8 * 0.5) + d, z8 * 0.5], [yc, 0]]) };
  }
  // material letters for mats rows
  var M = { u: 'under', k: 'black', p: 'paint', r: 'paint2', g: 'glass', s: 'gloss', c: 'chrome', n: 'carbon', w: 'well', l: 'light', t: 'tail', d: 'drl', i: 'grille' };
  function rows(list) { return list.map(function (s) { return s.split('').map(function (ch) { return M[ch]; }); }); }

  /* ================================================================ BMW M3 Competition (G80) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/BMW_M3):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:BMW_M3_Competition_(G80)_IMG_4041.jpg
  //   front 3/4 (right): https://commons.wikimedia.org/wiki/File:2021_BMW_M3_Competition_Automatic_3.0_Front.jpg
  //   side/front 3/4: https://commons.wikimedia.org/wiki/File:BMW_M3_COMPETITION_(G80)_China.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2023_BMW_M3_Competition_xDrive_Auto_1.jpg
  // Signature: the huge upright kidney pair reaching from the bonnet edge to the bumper (plate across it), slim
  // dark headlamps with twin L DRLs, big outboard intakes, carbon roof, short Hofmeister-kink quarter window,
  // dark L tail lamps, carbon diffuser with quad tips in two pairs.
  var M3 = {
    body: {
      stations: [
        deck(2.292, [[0.25, 0.30], [0.30, 0.34], [0.50, 0.35], [0.70, 0.34], [0.78, 0.30]], 0.80, 0.22),
        deck(2.255, [[0.135, 0.56], [0.25, 0.66], [0.50, 0.69], [0.70, 0.68], [0.81, 0.60]], 0.83, 0.42),
        deck(2.150, [[0.13, 0.78], [0.25, 0.835], [0.50, 0.85], [0.70, 0.84], [0.835, 0.75]], 0.862, 0.55),
        deck(2.000, [[0.155, 0.86], [0.30, 0.89], [0.55, 0.915], [0.72, 0.905], [0.85, 0.83]], 0.878, 0.62, 1, 0.010),
        deck(1.700, [[0.18, 0.89], [0.30, 0.925], [0.60, 0.952], [0.80, 0.93], [0.875, 0.86]], 0.905, 0.66, 1, 0.026),
        deck(1.150, [[0.17, 0.88], [0.30, 0.905], [0.62, 0.935], [0.875, 0.925], [0.935, 0.858]], 0.955, 0.69, 1, 0.034),
        deck(0.600, [[0.165, 0.86], [0.30, 0.845], [0.62, 0.905], [0.875, 0.922], [0.99, 0.862]], 1.010, 0.765, 1, 0.012),
        cab(0.300, [[0.165, 0.86], [0.30, 0.84], [0.62, 0.905], [0.875, 0.924], [1.0, 0.86]], [1.015, 0.835], [1.15, 0.775], 1.178),
        cab(-0.050, [[0.165, 0.86], [0.30, 0.838], [0.62, 0.903], [0.875, 0.922], [1.006, 0.858]], [1.022, 0.832], [1.335, 0.705], 1.372),
        cab(-0.300, [[0.165, 0.86], [0.30, 0.838], [0.62, 0.903], [0.875, 0.922], [1.012, 0.858]], [1.028, 0.832], [1.373, 0.693], 1.423),
        cab(-0.760, [[0.165, 0.86], [0.30, 0.84], [0.62, 0.908], [0.875, 0.926], [1.022, 0.858]], [1.036, 0.832], [1.385, 0.685], 1.433),
        cab(-1.000, [[0.17, 0.86], [0.30, 0.845], [0.64, 0.925], [0.875, 0.932], [1.028, 0.862]], [1.042, 0.836], [1.36, 0.682], 1.41, [1.39, 0.60]),
        cab(-1.300, [[0.19, 0.86], [0.30, 0.855], [0.66, 0.948], [0.88, 0.936], [1.04, 0.87]], [1.055, 0.845], [1.24, 0.765], 1.34, [1.315, 0.60]),
        deck(-1.640, [[0.225, 0.86], [0.32, 0.865], [0.68, 0.95], [0.89, 0.93], [1.05, 0.86]], 1.13, 0.64),
        deck(-1.960, [[0.238, 0.84], [0.32, 0.86], [0.70, 0.927], [0.88, 0.915], [1.01, 0.845]], 1.045, 0.62),
        deck(-2.320, [[0.238, 0.76], [0.32, 0.785], [0.66, 0.85], [0.86, 0.84], [0.97, 0.775]], 1.028, 0.57),
        deck(-2.470, [[0.28, 0.66], [0.36, 0.72], [0.62, 0.77], [0.82, 0.76], [0.96, 0.68]], 1.035, 0.50, 0.6)
      ],
      //     c0 c1 c2 c3 c4 c5 c6 c7 c8 c9
      mats: rows([
        'kkpppppppp',   // nose face
        'kkpppppppp',   // bumper corners
        'kkpppppppp',   // to the lamps
        'kkpppppppp',   // front wing
        'kkpppppppp',   // wing / bonnet
        'kkpppppppp',   // bonnet to the cowl
        'kkppppspgg',   // windscreen lower, black mirror sail, A-pillar foot (c7)
        'kkppppgpgg',   // front door glass reaches the A-pillar, A-pillar (c7), windscreen upper
        'kkppppgpnn',   // front door glass, carbon roof
        'kkppppgpnn',   // rear door glass (B-pillar is a side poly)
        'kkppppgpnn',   // rear door / backlight top
        'kkppppgpgg',   // Hofmeister quarter glass, backlight
        'kkppppppgg',   // C-pillar, backlight base
        'kkpppppppp',   // boot lid
        'kkpppppppp',   // boot lid
        'kkpppppppp'    // tail face
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // kidney pair: gloss surround, dark mesh, horizontal double slats; BMW roundel above
      polys([[[0.045, 0.36], [0.255, 0.36], [0.29, 0.40], [0.297, 0.735], [0.272, 0.787], [0.065, 0.795], [0.045, 0.76]]], 'front', 'grille', 0.007, true),
      polys([0, 1, 2].map(function (k) { var y = 0.60 + k * 0.06; return rect(0.05, y, 0.29, y + 0.008); }), 'front', 'gloss', 0.009, true),
      polys([ell(0, 0.83, 0.022, 0.022, 8)], 'front', 'badge', 0.006, false),
      polys([rect(-0.26, 0.42, 0.26, 0.53)], 'front', 'plate', 0.011, false),
      // slim headlamps: dark lens, white L light guides
      polys([[[0.325, 0.74], [0.38, 0.705], [0.80, 0.722], [0.865, 0.765], [0.845, 0.797], [0.42, 0.795], [0.335, 0.778]]], 'front', 'gloss', 0.005, true),
      polys([[[0.40, 0.768], [0.56, 0.772], [0.56, 0.785], [0.40, 0.781]], [[0.40, 0.735], [0.413, 0.735], [0.413, 0.775], [0.40, 0.775]],
        [[0.60, 0.773], [0.79, 0.778], [0.79, 0.791], [0.60, 0.786]], [[0.60, 0.74], [0.613, 0.74], [0.613, 0.78], [0.60, 0.78]]], 'front', 'drl', 0.009, true),
      polys([ell(0.685, 0.748, 0.045, 0.022, 8)], 'front', 'light', 0.008, true),
      // lower fascia: centre intake under the kidneys, big outboard intakes with a vertical blade, splitter lip
      polys([[[-0.33, 0.17], [0.33, 0.17], [0.30, 0.31], [-0.30, 0.31]]], 'front', 'grille', 0.004, false),
      polys([[[0.36, 0.20], [0.80, 0.22], [0.83, 0.47], [0.70, 0.56], [0.40, 0.50], [0.34, 0.34]]], 'front', 'grille', 0.004, true),
      polys([rect(0.55, 0.22, 0.575, 0.52)], 'front', 'gloss', 0.007, true),
      polys([rect(-0.84, 0.125, 0.84, 0.165)], 'front', 'carbon', 0.006, false),
      // bonnet power-dome creases (dark lines would be decals; model the twin domes as faint gloss vents instead)
      // side: M gill behind the front wheel, door handles, carbon skirts
      polys([[[0.98, 0.72], [1.03, 0.72], [1.06, 0.86], [1.015, 0.87]]], 'side', 'gloss', 0.005, true),
      polys([[[-0.25, 1.03], [-0.33, 1.03], [-0.355, 1.38], [-0.27, 1.38]]], 'side', 'gloss', 0.006, true),
      polys([rect(0.10, 0.905, 0.25, 0.93), rect(-0.78, 0.915, -0.63, 0.94)], 'side', 'gloss', 0.004, true),
      // rear: dark L tail lamps wrapping onto the boot lid, M lip spoiler, plate, carbon diffuser
      polys([[[0.38, 0.875], [0.71, 0.865], [0.73, 0.775], [0.785, 0.78], [0.83, 0.955], [0.80, 0.99], [0.38, 0.975]]], 'rear', 'tail', 0.006, true),
      polys([[[0.40, 0.905], [0.75, 0.895], [0.765, 0.935], [0.40, 0.945]]], 'rear', 'gloss', 0.009, true),
      polys([rect(-0.26, 0.83, 0.26, 0.945)], 'rear', 'plate', 0.006, false),
      polys([rect(-2.47, -0.58, -2.36, 0.58)], 'top', 'carbon', 0.005, false),
      polys([ell(0, 0.975, 0.03, 0.03, 10)], 'rear', 'badge', 0.006, false),
      polys([[[-0.80, 0.20], [0.80, 0.20], [0.82, 0.42], [-0.82, 0.42]]], 'rear', 'carbon', 0.005, false),
            polys([rect(0.80, 0.46, 0.82, 0.58)], 'rear', 'tail', 0.007, true),
      [
        // M mirrors (carbon caps on Competition): housing on a black foot
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.83, z1: 1.03, pts2d: [[0.60, 1.035], [0.43, 1.04], [0.415, 1.13], [0.545, 1.135]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.53, 1.045, 0.85], s: [0.10, 0.03, 0.05] },
        // carbon side skirt blade
        { t: 'box', mat: 'carbon', mirror: true, c: [0.0, 0.20, 0.87], s: [2.05, 0.05, 0.06] }
      ]
    ),
    wheels: { style: 'y', spokes: 5 },
    notes: 'BMW M3 Competition (G80) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:BMW_M3_Competition_(G80)_IMG_4041.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2021_BMW_M3_Competition_Automatic_3.0_Front.jpg (front 3/4 right), ' +
      'https://commons.wikimedia.org/wiki/File:BMW_M3_COMPETITION_(G80)_China.jpg (side / front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2023_BMW_M3_Competition_xDrive_Auto_1.jpg (rear 3/4).'
  };
  reg('bmw-m3-g80', M3);


  /* ================================================================ Mercedes-AMG C 63 S E PERFORMANCE (W206) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Mercedes-Benz_C-Class_(W206)):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mercedes-AMG_C_63_(W206)_IMG_0305.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Mercedes-AMG_C_63_(W206)_IMG_0310.jpg
  // Signature: upright Panamericana grille (vertical chrome bars, big star), slim angular lamps with an eyebrow DRL,
  // long bonnet / cab-backward glasshouse with chrome DLO, one continuous roof-to-deck arc, two-piece wedge tail lamps,
  // dark diffuser with quad trapezoid tips.
  var C63 = {
    body: {
      stations: [
        deck(2.315, [[0.24, 0.28], [0.30, 0.31], [0.45, 0.32], [0.62, 0.30], [0.69, 0.25]], 0.70, 0.18),
        deck(2.270, [[0.115, 0.58], [0.25, 0.61], [0.50, 0.62], [0.65, 0.60], [0.76, 0.52]], 0.79, 0.40),
        deck(2.170, [[0.125, 0.78], [0.25, 0.80], [0.50, 0.81], [0.70, 0.79], [0.80, 0.70]], 0.838, 0.52),
        deck(2.040, [[0.15, 0.86], [0.30, 0.865], [0.50, 0.895], [0.70, 0.88], [0.83, 0.80]], 0.858, 0.60),
        deck(1.250, [[0.175, 0.90], [0.30, 0.93], [0.64, 0.957], [0.85, 0.93], [0.915, 0.865]], 0.952, 0.68, 1, 0.028),
        deck(0.600, [[0.17, 0.87], [0.30, 0.875], [0.70, 0.933], [0.88, 0.91], [1.0, 0.86]], 1.022, 0.78),
        cab(0.300, [[0.17, 0.87], [0.30, 0.858], [0.70, 0.926], [0.88, 0.91], [1.02, 0.855]], [1.035, 0.83], [1.16, 0.77], 1.179),
        cab(-0.030, [[0.17, 0.87], [0.30, 0.856], [0.70, 0.926], [0.88, 0.909], [1.038, 0.855]], [1.04, 0.83], [1.32, 0.70], 1.35),
        cab(-0.400, [[0.17, 0.87], [0.30, 0.86], [0.70, 0.928], [0.88, 0.912], [1.042, 0.855]], [1.043, 0.83], [1.40, 0.685], 1.45),
        cab(-0.750, [[0.17, 0.87], [0.30, 0.864], [0.70, 0.931], [0.88, 0.916], [1.045, 0.856]], [1.046, 0.83], [1.405, 0.68], 1.452),
        cab(-1.050, [[0.175, 0.87], [0.30, 0.868], [0.70, 0.936], [0.88, 0.924], [1.047, 0.862]], [1.048, 0.835], [1.37, 0.675], 1.42, [1.40, 0.60]),
        cab(-1.400, [[0.198, 0.87], [0.30, 0.87], [0.70, 0.937], [0.85, 0.932], [1.05, 0.875]], [1.051, 0.85], [1.22, 0.76], 1.355, [1.33, 0.60]),
        cab(-1.700, [[0.222, 0.87], [0.32, 0.87], [0.70, 0.939], [0.85, 0.94], [1.052, 0.878]], [1.053, 0.86], [1.075, 0.845], 1.255, [1.20, 0.62]),
        deck(-1.980, [[0.23, 0.86], [0.32, 0.87], [0.70, 0.931], [0.88, 0.92], [1.03, 0.85]], 1.121, 0.62),
        deck(-2.420, [[0.235, 0.75], [0.32, 0.78], [0.70, 0.815], [0.88, 0.80], [1.0, 0.70]], 1.065, 0.52),
        deck(-2.500, [[0.29, 0.68], [0.36, 0.73], [0.60, 0.77], [0.85, 0.765], [0.99, 0.66]], 1.085, 0.50, 0.6)
      ],
      mats: rows([
        'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp',   // nose .. cowl
        'kkppppsggg',   // windscreen lower
        'kkpppcgcgg',   // windscreen upper, front quarter of the door glass, chrome DLO
        'kkpppcgcrr',   // front door glass, roof
        'kkpppcgcrr',   // rear door glass
        'kkpppcgcrr',   // rear door glass / roof end
        'kkpppcgpgg',   // quarter glass, backlight (the roof-rail band widens into a big C-pillar triangle here:
        'kkpppcgpgg',   // pointed quarter glass, backlight   body colour like the real car — chrome read as a white
                        //   panel, glass as a pale up-facing facet between the quarter glass and the backlight)
        'kkppppppgg',   // backlight base
        'kkpppppppp', 'kkpppppppp'   // deck, tail
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // Panamericana grille: tall dark trapezoid from the bonnet edge down, 13 vertical chrome slats, chrome frame,
      // big star (ring + three-point star) in the centre
      polys([[[-0.355, 0.735], [0.355, 0.735], [0.39, 0.70], [0.425, 0.455], [0.40, 0.43], [-0.40, 0.43], [-0.425, 0.455], [-0.39, 0.70]]], 'front', 'chrome', 0.004, false),
      polys([[[-0.335, 0.718], [0.335, 0.718], [0.37, 0.69], [0.402, 0.46], [0.385, 0.447], [-0.385, 0.447], [-0.402, 0.46], [-0.37, 0.69]]], 'front', 'grille', 0.006, false),
      polys([-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map(function (k) { var z = k * 0.054, w = 0.0075; return [[z - w, 0.462], [z + w, 0.462], [z * 0.93 + w, 0.705], [z * 0.93 - w, 0.705]]; }), 'front', 'chrome', 0.009, false),
      polys([ell(0, 0.585, 0.092, 0.092, 12)], 'front', 'chrome', 0.011, false),
      polys([ell(0, 0.585, 0.076, 0.076, 12)], 'front', 'grille', 0.013, false),
      polys([90, 210, 330].map(function (d) {
        function P(r, a) { a = a * Math.PI / 180; return [Math.cos(a) * r, 0.585 + Math.sin(a) * r]; }
        return [P(0.074, d), P(0.016, d + 120), P(0.016, d - 120)];
      }), 'front', 'chrome', 0.015, false),
      // slim angular headlamps with the eyebrow DRL hooking down at the inner end
      // (audit: maxTilt keeps the lamp decals on the upright nose face; the DRL hook used to smear up the bonnet as a white wedge)
      tilt(polys([[[0.405, 0.672], [0.47, 0.655], [0.80, 0.69], [0.875, 0.735], [0.86, 0.765], [0.48, 0.732]]], 'front', 'gloss', 0.005, true), 45),
      tilt(polys([[[0.49, 0.718], [0.845, 0.748], [0.845, 0.758], [0.49, 0.729]], [[0.452, 0.676], [0.464, 0.676], [0.484, 0.724], [0.472, 0.724]]], 'front', 'drl', 0.009, true), 45),
      tilt(polys([ell(0.70, 0.715, 0.05, 0.016, 8)], 'front', 'light', 0.008, true), 45),
      // AMG lower bumper: big outer intakes with a gloss flic, wide centre intake, chrome A-wing blade across, plate
      polys([[[0.44, 0.20], [0.86, 0.235], [0.885, 0.47], [0.70, 0.485], [0.49, 0.43]]], 'front', 'grille', 0.004, true),
      polys([[[0.47, 0.33], [0.87, 0.36], [0.875, 0.385], [0.475, 0.355]]], 'front', 'gloss', 0.008, true),
      polys([[[-0.42, 0.15], [0.42, 0.15], [0.40, 0.31], [-0.40, 0.31]]], 'front', 'grille', 0.004, false),
      polys([rect(-0.43, 0.305, 0.43, 0.322)], 'front', 'chrome', 0.008, false),
      polys([rect(-0.25, 0.33, 0.25, 0.428)], 'front', 'plate', 0.010, false),
      // side: wing vent, door handles, B-pillar
      polys([[[0.98, 0.80], [1.12, 0.81], [1.12, 0.845], [0.99, 0.84]]], 'side', 'gloss', 0.005, true),
      polys([[[-0.355, 1.045], [-0.445, 1.045], [-0.485, 1.40], [-0.395, 1.40]]], 'side', 'gloss', 0.006, true),
      polys([rect(0.05, 0.925, 0.20, 0.95), rect(-0.85, 0.935, -0.70, 0.96)], 'side', 'chrome', 0.004, true),
      // rear: two-piece wedge tail lamps (split at the boot shut line), star, plate, dark diffuser
      polys([[[0.26, 0.86], [0.84, 0.82], [0.89, 0.88], [0.875, 0.995], [0.26, 0.955]]], 'rear', 'tail', 0.006, true),
      polys([[[0.32, 0.912], [0.84, 0.905], [0.84, 0.917], [0.32, 0.922]]], 'rear', 'gloss', 0.009, true),
      polys([ell(0, 0.965, 0.04, 0.04, 10)], 'rear', 'badge', 0.006, false),
      polys([rect(-0.26, 0.72, 0.26, 0.83)], 'rear', 'plate', 0.006, false),
      polys([[[-0.80, 0.22], [0.80, 0.22], [0.82, 0.42], [-0.82, 0.42]]], 'rear', 'gloss', 0.005, false),
      [
        // mirrors: body-colour housing on a black foot
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.83, z1: 1.04, pts2d: [[0.60, 1.05], [0.42, 1.055], [0.405, 1.145], [0.55, 1.15]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.53, 1.06, 0.85], s: [0.10, 0.03, 0.05] }
      ]
    ),
    wheels: { style: 'split', spokes: 5 },
    notes: 'Mercedes-AMG C 63 S E PERFORMANCE (W206) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Mercedes-AMG_C_63_(W206)_IMG_0305.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Mercedes-AMG_C_63_(W206)_IMG_0310.jpg (rear 3/4).'
  };
  reg('mercedes-amg-c63-w206', C63);

  /* ================================================================ Tesla Model S (2021 refresh) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Tesla_Model_S):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Tesla_Model_S_(2023)_Motorworld_Munich_1X7A0025.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Tesla_Model_S_Plaid_Autofr%C3%BChling_Ulm_IMG_9321.jpg
  // Signature: grille-less low nose with swept slim lamps and the T badge, very low bonnet, long single-arc
  // fastback with a full glass roof running into the liftback, black window trim, duck-tail lip, smoked wrap
  // tail lamps with TESLA lettering between them, wide low intake, aero wheels, no exhaust.
  var MS = {
    body: {
      // (likeness pass) rounder plan-view nose cone with fender crowns standing above a lower bonnet centre, and one
      // continuous roof arc from the windscreen header over the B-pillar peak down the liftback to the duck tail
      // (extra stations at 0.23 / -0.60 / -1.10 / -2.03, roofline y = 1.431 - 0.361 u^1.7 over x -0.33 .. -2.40)
      stations: [
        deck(2.425, [[0.33, 0.20], [0.36, 0.24], [0.41, 0.25], [0.46, 0.24], [0.49, 0.20]], 0.50, 0.13),
        deck(2.400, [[0.27, 0.36], [0.31, 0.39], [0.43, 0.405], [0.53, 0.39], [0.565, 0.33]], 0.575, 0.24),
        deck(2.350, [[0.19, 0.52], [0.27, 0.54], [0.46, 0.555], [0.58, 0.54], [0.615, 0.47]], 0.632, 0.34),
        deck(2.270, [[0.12, 0.68], [0.25, 0.695], [0.48, 0.705], [0.61, 0.69], [0.66, 0.61]], 0.674, 0.44),
        deck(2.150, [[0.13, 0.82], [0.25, 0.835], [0.50, 0.85], [0.63, 0.835], [0.70, 0.765]], 0.700, 0.52),
        deck(1.970, [[0.158, 0.90], [0.30, 0.91], [0.55, 0.94], [0.69, 0.93], [0.75, 0.855]], 0.728, 0.60),
        deck(1.550, [[0.16, 0.94], [0.30, 0.97], [0.62, 0.982], [0.78, 0.962], [0.84, 0.89]], 0.828, 0.66),
        deck(1.100, [[0.152, 0.93], [0.30, 0.96], [0.65, 0.975], [0.83, 0.95], [0.91, 0.88]], 0.935, 0.72),
        deck(0.800, [[0.15, 0.92], [0.30, 0.905], [0.70, 0.962], [0.86, 0.945], [0.99, 0.875]], 1.03, 0.80),
        cab(0.450, [[0.15, 0.92], [0.30, 0.895], [0.70, 0.955], [0.86, 0.94], [1.0, 0.87]], [1.015, 0.845], [1.16, 0.79], 1.215),
        cab(0.230, [[0.15, 0.92], [0.30, 0.893], [0.70, 0.953], [0.86, 0.937], [1.006, 0.867]], [1.018, 0.842], [1.268, 0.742], 1.326),
        cab(0.020, [[0.15, 0.92], [0.30, 0.892], [0.70, 0.952], [0.86, 0.935], [1.012, 0.865]], [1.022, 0.84], [1.352, 0.70], 1.396),
        cab(-0.330, [[0.15, 0.92], [0.30, 0.892], [0.70, 0.952], [0.86, 0.935], [1.02, 0.865]], [1.028, 0.84], [1.39, 0.69], 1.431),
        cab(-0.600, [[0.152, 0.92], [0.30, 0.895], [0.70, 0.958], [0.86, 0.944], [1.025, 0.867]], [1.032, 0.842], [1.386, 0.687], 1.424, [1.414, 0.615]),
        cab(-0.850, [[0.155, 0.92], [0.30, 0.90], [0.70, 0.965], [0.86, 0.955], [1.03, 0.87]], [1.036, 0.845], [1.37, 0.685], 1.397, [1.388, 0.615]),
        cab(-1.100, [[0.165, 0.925], [0.30, 0.92], [0.70, 0.97], [0.86, 0.963], [1.034, 0.88]], [1.04, 0.855], [1.335, 0.69], 1.368, [1.358, 0.618]),
        cab(-1.300, [[0.177, 0.93], [0.30, 0.94], [0.70, 0.975], [0.86, 0.97], [1.037, 0.89]], [1.045, 0.865], [1.29, 0.70], 1.335, [1.322, 0.622]),
        cab(-1.650, [[0.22, 0.94], [0.32, 0.96], [0.70, 0.985], [0.86, 0.975], [1.045, 0.90]], [1.055, 0.88], [1.16, 0.79], 1.263, [1.235, 0.645]),
        cab(-1.900, [[0.245, 0.93], [0.32, 0.955], [0.70, 0.975], [0.86, 0.968], [1.05, 0.89]], [1.06, 0.875], [1.072, 0.862], 1.205, [1.18, 0.655]),
        deck(-2.030, [[0.25, 0.918], [0.32, 0.94], [0.70, 0.962], [0.86, 0.956], [1.042, 0.876]], 1.172, 0.64),
        deck(-2.180, [[0.25, 0.895], [0.32, 0.915], [0.70, 0.94], [0.86, 0.934], [1.03, 0.855]], 1.130, 0.62),
        deck(-2.370, [[0.25, 0.84], [0.32, 0.86], [0.70, 0.895], [0.86, 0.885], [1.01, 0.80]], 1.075, 0.58),
        deck(-2.470, [[0.26, 0.76], [0.33, 0.795], [0.66, 0.835], [0.86, 0.825], [1.003, 0.73]], 1.058, 0.54),
        deck(-2.545, [[0.36, 0.64], [0.42, 0.70], [0.64, 0.75], [0.86, 0.75], [0.995, 0.655]], 1.054, 0.50, 0.7),
        deck(-2.590, [[0.58, 0.48], [0.62, 0.56], [0.74, 0.62], [0.88, 0.63], [0.99, 0.55]], 1.046, 0.44, 0.6)
      ],
      mats: rows([
        'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp',   // nose .. cowl
        'kkppppsggg',   // windscreen lower
        'kkpppsgpgg',   // windscreen upper
        'kkpppsgpgg',   // windscreen header
        'kkpppsgsgg',   // front door glass, glass roof
        'kkpppsgsgg',   // B-pillar, glass roof
        'kkpppsgsgg',   // rear door glass, glass roof
        'kkpppsgsgg',   // rear door glass, liftback glass
        'kkpppsgsgg',   // rear door glass, liftback glass
        'kkpppsgsgg',   // quarter glass, black C-pillar trim
        'kkpppsgsgg',   // quarter glass tip
        'kkppppppgg',   // liftback glass base
        'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp'   // liftback, duck tail, tail face leaning in
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // swept slim headlamps (pointed inner tips), thin DRL along the top
      // (audit: enlarged — the real lamps are big swept lenses reaching well round the wing corners)
      tilt(polys([[[0.44, 0.640], [0.56, 0.606], [0.80, 0.612], [0.93, 0.655], [0.935, 0.715], [0.76, 0.718], [0.56, 0.685]]], 'front', 'gloss', 0.005, true), 40),
      tilt(polys([[[0.52, 0.660], [0.66, 0.632], [0.86, 0.640], [0.90, 0.665], [0.80, 0.675], [0.62, 0.668]]], 'front', 'light', 0.009, true), 40),
      tilt(polys([[[0.52, 0.676], [0.92, 0.696], [0.915, 0.708], [0.56, 0.692]]], 'front', 'drl', 0.011, true), 40),
      tilt(polys([ell(0.80, 0.652, 0.04, 0.02, 8)], 'front', 'chrome', 0.012, true), 40),
      // T badge on the nose, plate, wide low intake, air-curtain slots
      polys([[[-0.045, 0.60], [0.045, 0.60], [0.045, 0.588], [0.008, 0.584], [0.008, 0.535], [-0.008, 0.535], [-0.008, 0.584], [-0.045, 0.588]]], 'front', 'badge', 0.008, false),
      polys([rect(-0.26, 0.38, 0.26, 0.49)], 'front', 'plate', 0.007, false),
      polys([[[-0.62, 0.20], [0.62, 0.20], [0.60, 0.32], [-0.60, 0.32]]], 'front', 'grille', 0.004, false),
      polys([[[0.70, 0.26], [0.74, 0.26], [0.76, 0.40], [0.72, 0.40]]], 'front', 'gloss', 0.005, true),
      // side: B-pillar, flush handles
      polys([[[-0.20, 1.03], [-0.29, 1.03], [-0.325, 1.39], [-0.235, 1.39]]], 'side', 'gloss', 0.006, true),
      polys([rect(0.05, 0.935, 0.19, 0.95), rect(-0.95, 0.94, -0.81, 0.955)], 'side', 'gloss', 0.004, true),
      // rear: smoked wrap tail lamps with red inner blades, TESLA letters, plate, black diffuser, reflectors
      polys([[[0.36, 0.89], [0.86, 0.86], [0.945, 0.90], [0.94, 0.995], [0.86, 1.015], [0.36, 0.975]]], 'rear', 'gloss', 0.005, true),
      polys([[[0.38, 0.915], [0.86, 0.89], [0.93, 0.93], [0.86, 0.995], [0.38, 0.958]]], 'rear', 'tail', 0.009, true),
      polys(word('TESLA', 0, 0.94, 0.03, 1, 2.2), 'rear', 'badge', 0.007, false),
      polys([rect(-0.26, 0.79, 0.26, 0.90)], 'rear', 'plate', 0.006, false),
      polys([[[-0.72, 0.26], [0.72, 0.26], [0.74, 0.40], [-0.74, 0.40]]], 'rear', 'gloss', 0.005, false),
      polys([rect(0.55, 0.47, 0.75, 0.49)], 'rear', 'tail', 0.007, true),
      [
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.84, z1: 1.05, pts2d: [[0.70, 1.035], [0.52, 1.04], [0.505, 1.12], [0.65, 1.125]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.63, 1.045, 0.875], s: [0.09, 0.03, 0.05] }
      ]
    ),
    wheels: { style: 'turbine', spokes: 10 },
    notes: 'Tesla Model S (2021 refresh) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Tesla_Model_S_(2023)_Motorworld_Munich_1X7A0025.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Tesla_Model_S_Plaid_Autofr%C3%BChling_Ulm_IMG_9321.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2021_Tesla_Model_S_P2_Long_Range_front_right_view.jpg (front 3/4).'
  };
  reg('tesla-model-s-2021', MS);

  /* ================================================================ Subaru WRX STI (VA) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Subaru_WRX):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Subaru_WRX_STI_(VA)_IMG_4317.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Subaru_WRX_STI_(VA)_IMG_4488.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2018_Subaru_WRX_STI_Type-RA_in_World_Rally_Blue_Pearl,_Rear_Left,_07-13-2022.jpg
  // Signature: bonnet scoop over the top-mount intercooler, hexagonal grille, hawk-eye lamps, wide lower mouth with
  // fog bezels and a black lip, upright glasshouse, tall wing on pylons, wrap tail lamps, quad tips in corner pairs.
  var STI = {
    body: {
      stations: [
        deck(2.255, [[0.26, 0.30], [0.30, 0.36], [0.45, 0.38], [0.58, 0.36], [0.64, 0.30]], 0.66, 0.20),
        deck(2.200, [[0.18, 0.58], [0.25, 0.66], [0.45, 0.70], [0.60, 0.68], [0.70, 0.58]], 0.73, 0.40),
        deck(2.080, [[0.17, 0.76], [0.25, 0.80], [0.45, 0.84], [0.66, 0.82], [0.78, 0.72]], 0.80, 0.52),
        deck(1.900, [[0.18, 0.82], [0.30, 0.85], [0.50, 0.87], [0.70, 0.85], [0.82, 0.76]], 0.835, 0.58),
        deck(1.400, [[0.19, 0.84], [0.30, 0.87], [0.55, 0.885], [0.76, 0.87], [0.845, 0.79]], 0.875, 0.62),
        deck(1.000, [[0.186, 0.84], [0.30, 0.86], [0.55, 0.885], [0.80, 0.86], [0.88, 0.79]], 0.905, 0.65),
        deck(0.620, [[0.185, 0.84], [0.30, 0.84], [0.70, 0.876], [0.86, 0.845], [0.98, 0.77]], 1.0, 0.70),
        cab(0.300, [[0.185, 0.84], [0.30, 0.84], [0.70, 0.876], [0.86, 0.846], [1.0, 0.76]], [1.015, 0.745], [1.17, 0.70], 1.196),
        cab(-0.100, [[0.185, 0.84], [0.30, 0.839], [0.70, 0.877], [0.86, 0.85], [1.025, 0.76]], [1.03, 0.745], [1.40, 0.66], 1.44),
        cab(-0.500, [[0.185, 0.84], [0.30, 0.839], [0.70, 0.88], [0.86, 0.854], [1.035, 0.76]], [1.04, 0.745], [1.43, 0.655], 1.475),
        cab(-1.000, [[0.186, 0.84], [0.30, 0.845], [0.70, 0.888], [0.86, 0.865], [1.055, 0.765]], [1.06, 0.748], [1.41, 0.65], 1.45, [1.43, 0.58]),
        cab(-1.400, [[0.188, 0.84], [0.30, 0.85], [0.70, 0.892], [0.86, 0.871], [1.085, 0.78]], [1.10, 0.76], [1.22, 0.70], 1.303, [1.28, 0.58]),
        deck(-1.720, [[0.19, 0.84], [0.30, 0.85], [0.70, 0.89], [0.86, 0.875], [1.06, 0.80]], 1.13, 0.60),
        deck(-2.040, [[0.204, 0.82], [0.30, 0.84], [0.70, 0.876], [0.86, 0.863], [1.04, 0.78]], 1.074, 0.58),
        deck(-2.240, [[0.255, 0.78], [0.32, 0.80], [0.70, 0.844], [0.86, 0.84], [1.02, 0.75]], 1.069, 0.55),
        deck(-2.335, [[0.30, 0.68], [0.36, 0.74], [0.62, 0.78], [0.86, 0.78], [1.0, 0.68]], 1.06, 0.50, 0.6)
      ],
      mats: rows([
        'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp',   // nose .. cowl
        'kkppppsggg',   // windscreen lower
        'kkpppsgpgg',   // windscreen upper, door quarter window
        'kkpppsgppp',   // front door glass, roof
        'kkpppsgppp',   // rear door glass, roof
        'kkpppsgpgg',   // rear quarter glass, backlight
        'kkppppppgg',   // backlight base
        'kkpppppppp', 'kkpppppppp', 'kkpppppppp'   // boot, tail
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // hexagonal grille with the wing bar and the Subaru oval
      polys([[[-0.30, 0.50], [0.30, 0.50], [0.37, 0.56], [0.355, 0.64], [0.30, 0.672], [-0.30, 0.672], [-0.355, 0.64], [-0.37, 0.56]]], 'front', 'grille', 0.004, false),
      polys([rect(-0.33, 0.585, 0.33, 0.60)], 'front', 'gloss', 0.007, false),
      polys([ell(0, 0.59, 0.065, 0.036, 10)], 'front', 'chrome', 0.010, false),
      // hawk-eye headlamps swept back from the grille corners, C-shaped light guide around the projector
      polys([[[0.38, 0.565], [0.48, 0.55], [0.74, 0.595], [0.82, 0.648], [0.80, 0.69], [0.42, 0.66]]], 'front', 'gloss', 0.005, true),
      polys([[[0.42, 0.575], [0.70, 0.60], [0.70, 0.66], [0.43, 0.645]]], 'front', 'light', 0.008, true),
      polys([[[0.71, 0.60], [0.79, 0.645], [0.785, 0.675], [0.71, 0.665], [0.71, 0.65], [0.77, 0.655], [0.77, 0.645], [0.71, 0.615]]], 'front', 'drl', 0.010, true),
      // lower mouth, plate, fog bezels, black lip
      polys([[[-0.34, 0.21], [0.34, 0.21], [0.37, 0.43], [-0.37, 0.43]]], 'front', 'grille', 0.004, false),
      polys([rect(-0.26, 0.30, 0.26, 0.41)], 'front', 'plate', 0.008, false),
      polys([[[0.45, 0.25], [0.72, 0.28], [0.74, 0.43], [0.47, 0.41]]], 'front', 'grille', 0.004, true),
      polys([rect(-0.84, 0.17, 0.84, 0.21)], 'front', 'black', 0.006, false),
      // side: STI wing vent, door handles, B-pillar
      polys([[[0.86, 0.60], [0.98, 0.60], [0.98, 0.75], [0.88, 0.75]]], 'side', 'gloss', 0.005, true),
      polys([[[-0.30, 1.04], [-0.38, 1.04], [-0.40, 1.43], [-0.32, 1.43]]], 'side', 'gloss', 0.006, true),
      polys([rect(0.02, 0.93, 0.16, 0.955), rect(-0.86, 0.95, -0.72, 0.975)], 'side', 'gloss', 0.004, true),
      // rear: wrap tail lamps with a clear inner band, boot-lid plate, oval, dark diffuser, rear fog
      polys([[[0.42, 0.875], [0.80, 0.865], [0.87, 0.92], [0.86, 1.045], [0.60, 1.05], [0.42, 0.99]]], 'rear', 'tail', 0.006, true),
      polys([[[0.47, 0.925], [0.74, 0.925], [0.74, 0.965], [0.47, 0.96]]], 'rear', 'rev', 0.009, true),
      polys([rect(-0.26, 0.835, 0.26, 0.945)], 'rear', 'plate', 0.006, false),
      polys([ell(0, 1.005, 0.06, 0.032, 10)], 'rear', 'chrome', 0.006, false),
      polys([[[-0.80, 0.24], [0.80, 0.24], [0.82, 0.40], [-0.82, 0.40]]], 'rear', 'gloss', 0.005, false),
      polys([rect(-0.045, 0.30, 0.045, 0.335)], 'rear', 'tail', 0.008, false),
      [
        // bonnet scoop (top-mount intercooler) with its dark mouth
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.0, z1: 0.25, pts2d: [[1.42, 0.874], [0.90, 0.912], [0.93, 0.94], [1.30, 0.962]] },
        { t: 'box', mat: 'grille', c: [1.33, 0.925, 0], s: [0.03, 0.055, 0.44] },
        // tall wing on pylons, down-turned ends
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.0, z1: 0.76, pts2d: [[-2.08, 1.29], [-2.34, 1.295], [-2.36, 1.325], [-2.10, 1.318]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.74, z1: 0.79, pts2d: [[-2.10, 1.20], [-2.33, 1.215], [-2.36, 1.325], [-2.10, 1.318]] },
        { t: 'box', mat: 'paint', mirror: true, c: [-2.20, 1.18, 0.52], s: [0.13, 0.23, 0.03] },
        // door-mounted mirrors
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.73, z1: 0.95, pts2d: [[0.38, 1.04], [0.20, 1.045], [0.19, 1.14], [0.33, 1.145]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.31, 1.05, 0.76], s: [0.10, 0.03, 0.05] }
      ]
    ),
    wheels: { style: 'mesh', spokes: 10 },
    notes: 'Subaru WRX STI (VA) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Subaru_WRX_STI_(VA)_IMG_4317.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Subaru_WRX_STI_(VA)_IMG_4488.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2018_Subaru_WRX_STI_Type-RA_in_World_Rally_Blue_Pearl,_Rear_Left,_07-13-2022.jpg (rear 3/4).'
  };
  reg('subaru-wrx-sti-va', STI);

  /* ================================================================ Mitsubishi Lancer Evolution X */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Mitsubishi_Lancer_Evolution):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2017-04-02_Mitsubishi_Lancer_Evolution_X_MR_SST_14_(2).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Mitsubishi_Lancer_Evolution_X_front_view_(United_States)_(2).jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2010_Mitsubishi_Lancer_Evolution_GSR_in_Apex_Silver_Metallic,_Rear_Right,_10-10-2022.jpg
  // Signature: "jet-fighter" shark nose — a huge forward-leaning inverted-trapezoid grille filling the fascia,
  // angular lamps running up into the wings, corner ducts with round fogs, vented bonnet, fender gills, wing on
  // pylons, round-element tail lamps, a single tip at each rear corner.
  var EVO = {
    body: {
      stations: [
        deck(2.245, [[0.62, 0.30], [0.66, 0.36], [0.70, 0.40], [0.725, 0.38], [0.74, 0.32]], 0.75, 0.20),
        deck(2.170, [[0.30, 0.62], [0.36, 0.72], [0.55, 0.79], [0.72, 0.78], [0.785, 0.70]], 0.79, 0.45),
        deck(2.040, [[0.21, 0.80], [0.30, 0.83], [0.55, 0.865], [0.72, 0.845], [0.80, 0.76]], 0.81, 0.55),
        deck(1.850, [[0.205, 0.84], [0.30, 0.86], [0.55, 0.885], [0.74, 0.87], [0.82, 0.79]], 0.835, 0.60),
        deck(1.300, [[0.20, 0.85], [0.30, 0.87], [0.60, 0.895], [0.78, 0.88], [0.86, 0.80]], 0.883, 0.64),
        deck(0.900, [[0.195, 0.85], [0.30, 0.86], [0.62, 0.89], [0.80, 0.87], [0.88, 0.80]], 0.92, 0.66),
        deck(0.620, [[0.195, 0.84], [0.30, 0.84], [0.70, 0.884], [0.86, 0.854], [0.98, 0.78]], 1.012, 0.71),
        cab(0.300, [[0.195, 0.84], [0.30, 0.838], [0.70, 0.884], [0.86, 0.854], [1.0, 0.77]], [1.012, 0.75], [1.18, 0.70], 1.20),
        cab(-0.120, [[0.195, 0.84], [0.30, 0.836], [0.70, 0.884], [0.86, 0.856], [1.025, 0.77]], [1.03, 0.75], [1.41, 0.66], 1.448),
        cab(-0.500, [[0.195, 0.84], [0.30, 0.836], [0.70, 0.886], [0.86, 0.862], [1.04, 0.77]], [1.045, 0.75], [1.44, 0.655], 1.48),
        cab(-1.000, [[0.196, 0.84], [0.30, 0.842], [0.70, 0.895], [0.86, 0.873], [1.07, 0.77]], [1.075, 0.755], [1.41, 0.65], 1.45, [1.43, 0.58]),
        cab(-1.380, [[0.198, 0.84], [0.30, 0.85], [0.70, 0.899], [0.86, 0.88], [1.10, 0.78]], [1.11, 0.765], [1.22, 0.70], 1.315, [1.29, 0.58]),
        deck(-1.660, [[0.199, 0.84], [0.30, 0.86], [0.70, 0.895], [0.86, 0.885], [1.08, 0.80]], 1.16, 0.60),
        deck(-1.990, [[0.217, 0.82], [0.30, 0.84], [0.70, 0.879], [0.86, 0.869], [1.06, 0.78]], 1.084, 0.58),
        deck(-2.170, [[0.28, 0.76], [0.32, 0.79], [0.70, 0.84], [0.86, 0.84], [1.04, 0.75]], 1.08, 0.55),
        deck(-2.255, [[0.32, 0.68], [0.36, 0.74], [0.62, 0.78], [0.86, 0.78], [1.02, 0.68]], 1.06, 0.50, 0.6)
      ],
      mats: rows([
        'pppppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp', 'kkpppppppp',   // shark nose .. cowl
        'kkppppsggg',   // windscreen lower
        'kkpppsgpgg',   // windscreen upper
        'kkpppsgppp',   // front door glass, roof
        'kkpppsgppp',   // rear door glass, roof
        'kkpppsgpgg',   // rear quarter glass, backlight
        'kkppppppgg',   // backlight base
        'kkpppppppp', 'kkpppppppp', 'kkpppppppp'   // boot, tail
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // the jet-fighter grille: inverted trapezoid filling the forward-leaning fascia, gloss surround, centre bar
      polys([[[-0.60, 0.74], [0.60, 0.74], [0.44, 0.25], [-0.44, 0.25]]], 'front', 'gloss', 0.004, false),
      polys([[[-0.555, 0.72], [0.555, 0.72], [0.415, 0.275], [-0.415, 0.275]]], 'front', 'grille', 0.007, false),
      polys([[[-0.50, 0.555], [0.50, 0.555], [0.495, 0.575], [-0.505, 0.575]]], 'front', 'gloss', 0.010, false),
      polys([[0, 0.66], [-0.028, 0.618], [0.028, 0.618]].length ? [[[0, 0.705], [0.016, 0.678], [0, 0.651], [-0.016, 0.678]], [[-0.018, 0.646], [0.0, 0.646], [-0.016, 0.62], [-0.05, 0.62]], [[0.0, 0.646], [0.018, 0.646], [0.05, 0.62], [0.016, 0.62]]] : [], 'front', 'chrome', 0.012, false),
      polys([rect(-0.26, 0.40, 0.26, 0.51)], 'front', 'plate', 0.012, false),
      // angular headlamps rising from the grille corners into the wings, dark brow, amber marker
      polys([[[0.58, 0.64], [0.66, 0.615], [0.82, 0.655], [0.87, 0.72], [0.84, 0.75], [0.60, 0.71]]], 'front', 'gloss', 0.005, true),
      polys([[[0.61, 0.645], [0.80, 0.665], [0.83, 0.715], [0.62, 0.695]]], 'front', 'light', 0.008, true),
      polys([ell(0.67, 0.668, 0.03, 0.022, 8), ell(0.76, 0.685, 0.026, 0.02, 8)], 'front', 'gloss', 0.011, true),
      polys([rect(0.835, 0.70, 0.86, 0.73)], 'front', 'indicator', 0.010, true),
      // corner ducts with round fog lamps
      polys([[[0.47, 0.25], [0.76, 0.27], [0.79, 0.47], [0.55, 0.47]]], 'front', 'grille', 0.004, true),
      polys([ell(0.64, 0.34, 0.035, 0.035, 8)], 'front', 'light', 0.008, true),
      // vented aluminium bonnet: centre outlet and the outer louvres
      polys([rect(1.45, -0.12, 1.62, 0.12)], 'top', 'grille', 0.005, false),
      polys([rect(0.80, 0.30, 0.98, 0.52)], 'top', 'grille', 0.005, true),
      // side: fender gills, door handles, B-pillar
      polys([[[0.86, 0.60], [0.93, 0.60], [1.00, 0.80], [0.94, 0.80]]], 'side', 'gloss', 0.005, true),
      polys([[[-0.29, 1.04], [-0.37, 1.04], [-0.39, 1.44], [-0.31, 1.44]]], 'side', 'gloss', 0.006, true),
      polys([rect(0.02, 0.93, 0.16, 0.955), rect(-0.86, 0.95, -0.72, 0.975)], 'side', 'gloss', 0.004, true),
      // rear: wedge lamps with two round elements, amber outer, plate in the bumper, three diamonds, dark lower bumper
      polys([[[0.36, 0.855], [0.78, 0.84], [0.84, 0.895], [0.83, 1.0], [0.36, 0.995]]], 'rear', 'tail', 0.006, true),
      polys([ell(0.50, 0.925, 0.055, 0.05, 10), ell(0.67, 0.922, 0.055, 0.05, 10)], 'rear', 'rev', 0.009, true),
      polys([ell(0.50, 0.925, 0.032, 0.029, 8), ell(0.67, 0.922, 0.032, 0.029, 8)], 'rear', 'tail', 0.012, true),
      polys([[[0.745, 0.885], [0.785, 0.882], [0.80, 0.955], [0.76, 0.955]]], 'rear', 'indicator', 0.010, true),
      polys([[[0, 0.985], [0.014, 0.962], [0, 0.94], [-0.014, 0.962]], [[-0.016, 0.936], [0.0, 0.936], [-0.014, 0.915], [-0.044, 0.915]], [[0.0, 0.936], [0.016, 0.936], [0.044, 0.915], [0.014, 0.915]]], 'rear', 'chrome', 0.007, false),
      polys([rect(-0.26, 0.47, 0.26, 0.58)], 'rear', 'plate', 0.008, false),
      polys([[[-0.82, 0.24], [0.82, 0.24], [0.84, 0.42], [-0.84, 0.42]]], 'rear', 'black', 0.005, false),
      polys([rect(0.52, 0.50, 0.74, 0.52)], 'rear', 'tail', 0.007, true),
      [
        // wing on pylons, down-turned ends
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.0, z1: 0.74, pts2d: [[-1.98, 1.205], [-2.21, 1.21], [-2.24, 1.24], [-2.00, 1.235]] },
        { t: 'prism', mat: 'paint', mirror: true, z0: 0.72, z1: 0.77, pts2d: [[-2.00, 1.10], [-2.21, 1.10], [-2.24, 1.24], [-2.00, 1.235]] },
        { t: 'box', mat: 'paint', mirror: true, c: [-2.10, 1.15, 0.50], s: [0.12, 0.13, 0.03] },
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.73, z1: 0.95, pts2d: [[0.40, 1.04], [0.22, 1.045], [0.21, 1.14], [0.35, 1.145]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.33, 1.05, 0.76], s: [0.10, 0.03, 0.05] }
      ]
    ),
    wheels: { style: 'star', spokes: 10 },
    notes: 'Mitsubishi Lancer Evolution X — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2017-04-02_Mitsubishi_Lancer_Evolution_X_MR_SST_14_(2).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Mitsubishi_Lancer_Evolution_X_front_view_(United_States)_(2).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2010_Mitsubishi_Lancer_Evolution_GSR_in_Apex_Silver_Metallic,_Rear_Right,_10-10-2022.jpg (rear 3/4).'
  };
  reg('mitsubishi-lancer-evo-x', EVO);

  if (typeof module !== 'undefined' && module.exports) module.exports = { 'bmw-m3-g80': M3, 'mercedes-amg-c63-w206': C63, 'tesla-model-s-2021': MS, 'subaru-wrx-sti-va': STI, 'mitsubishi-lancer-evo-x': EVO };
})();

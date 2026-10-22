/* ==========================================================================
   FORGE Atelier — js/shapes/lowpoly/hyper-a.js
   Hand-authored low-poly hypercars (docs/LOWPOLY-SPEC.md): Ferrari SF90 Stradale, McLaren P1, Bugatti Chiron,
   Koenigsegg Jesko, Porsche 918 Spyder.  Mid-engine, cab-forward: short low nose, windscreen base just behind
   the front wheels, roof peak behind mid-wheelbase, long engine deck between raised rear haunches.

   Coordinates: reference metres of the CB.shapes model (x forward, origin mid-wheelbase, y up from the ground,
   z right). Body stations are RIGHT half rings [y, z] from the bottom centre round to the top centre.
   Ring points (all cars): 0 bottom centre, 1 bottom edge, 2 lower flank, 3 waist, 4 shoulder, 5 fender crown,
   6 belt / inner crown, 7 glass base, 8 roof rail, 9 roof quarter, 10 centre line (bonnet / roof / deck).
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
  // rounded rectangle (chamfered corners) in view coordinates
  function rrect(a0, b0, a1, b1, c) {
    return [[a0 + c, b0], [a1 - c, b0], [a1, b0 + c], [a1, b1 - c], [a1 - c, b1], [a0 + c, b1], [a0, b1 - c], [a0, b0 + c]];
  }
  function polys(list, view, mat, off, mirror, maxTilt) {   // maxTilt (deg, optional): flat decal, see LOWPOLY-SPEC
    return list.map(function (p) { var o = { t: 'poly', view: view, mat: mat, offset: off, mirror: !!mirror, pts: p }; if (maxTilt) o.maxTilt = maxTilt; return o; });
  }
  function S(x, pts) { return { x: x, pts: pts }; }
  function row(spec) {   // 'b p p p g ...' -> material keys
    var K = { b: 'black', p: 'paint', q: 'paint2', g: 'glass', G: 'gloss', c: 'carbon', h: 'chrome', r: 'grille', i: 'interior' };
    return spec.split(' ').map(function (k) { return K[k]; });
  }
  function mats(list) { return list.map(row); }
  // rear-detail helpers --------------------------------------------------------------------------------------
  // the same outline shrunk inside its own bounding box by du / dv (lamp layers: housing -> LED ring -> lens)
  function shrink(P, du, dv) {
    var a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    P.forEach(function (q) { a0 = Math.min(a0, q[0]); a1 = Math.max(a1, q[0]); b0 = Math.min(b0, q[1]); b1 = Math.max(b1, q[1]); });
    var ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, ka = Math.max(0.05, 1 - 2 * du / (a1 - a0)), kb = Math.max(0.05, 1 - 2 * dv / (b1 - b0));
    return P.map(function (q) { return [ca + (q[0] - ca) * ka, cb + (q[1] - cb) * kb]; });
  }
  // a layered lamp (flat stack facing the rear): layers [[mat, du, dv], ...] from the outline inwards
  function lamp(P, layers, mirror, tilt) {   // tilt: maxTilt (default 40); 0 = conform (lamps wrapping a corner)
    var out = [];
    layers.forEach(function (L, i) { out = out.concat(polys([L[1] || L[2] ? shrink(P, L[1], L[2]) : P], 'rear', L[0], 0.005 + i * 0.003, mirror, tilt === 0 ? 0 : tilt || 40)); });
    return out;
  }
  // vertical diffuser strakes: side-profile triangle (front foot, top at the tail, bottom at the tail) at each z
  function fins(zs, prof, mat, t) {
    return zs.map(function (z) { return { t: 'prism', mat: mat || 'carbon', mirror: z > 0.01, z0: z - (t || 0.014) / 2, z1: z + (t || 0.014) / 2, pts2d: prof }; });
  }
  // spanwise wing from section list [{z, y, x0 (leading), x1 (trailing), t}] (centre -> tip, mirrored):
  // top, underside, leading and trailing faces per span segment
  function wing3d(sec, mat) {
    var out = [];
    for (var i = 0; i < sec.length - 1; i++) {
      var a = sec[i], b = sec[i + 1];
      var aT = a.y + a.t / 2, aB = a.y - a.t / 2, bT = b.y + b.t / 2, bB = b.y - b.t / 2;
      out.push({ t: 'poly', mat: mat, mirror: true, normal: [0, 1, 0], pts: [[a.x0, aT, a.z], [a.x1, aT + 0.012, a.z], [b.x1, bT + 0.012, b.z], [b.x0, bT, b.z]] });
      out.push({ t: 'poly', mat: mat, mirror: true, normal: [0, -1, 0], pts: [[a.x0, aB, a.z], [b.x0, bB, b.z], [b.x1, bB + 0.012, b.z], [a.x1, aB + 0.012, a.z]] });
      out.push({ t: 'poly', mat: mat, mirror: true, normal: [-1, 0, 0], pts: [[a.x1, aB + 0.012, a.z], [b.x1, bB + 0.012, b.z], [b.x1, bT + 0.012, b.z], [a.x1, aT + 0.012, a.z]] });
      out.push({ t: 'poly', mat: mat, mirror: true, normal: [1, 0, 0], pts: [[a.x0, aB, a.z], [a.x0, aT, a.z], [b.x0, bT, b.z], [b.x0, bB, b.z]] });
    }
    return out;
  }

  /* ================================================================ Ferrari SF90 Stradale (2019–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Ferrari_SF90_Stradale):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Red_2019_Ferrari_SF90_Stradale_(48264238897)_(cropped).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2023_Ferrari_SF90_2.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2023_Ferrari_SF90_4.jpg
  // Signature: knife-edge nose with a floating body-colour blade over a wide black mesh intake, slim slashed
  // headlamps under the wing crests, cab-forward teardrop glasshouse, black intake behind the door glass,
  // squared tail with two rounded lamps per side, twin high exhausts flanking the plate, deep black diffuser.
  var SF90 = {
    body: {
      stations: [
        S(2.365, [[0.17, 0], [0.17, 0.42], [0.20, 0.52], [0.26, 0.56], [0.32, 0.54], [0.355, 0.48], [0.365, 0.40], [0.37, 0.30], [0.37, 0.20], [0.37, 0.10], [0.37, 0]]),
        S(2.26, [[0.13, 0], [0.13, 0.64], [0.18, 0.75], [0.30, 0.80], [0.43, 0.78], [0.52, 0.71], [0.545, 0.62], [0.54, 0.46], [0.535, 0.31], [0.53, 0.15], [0.53, 0]]),
        S(2.05, [[0.15, 0], [0.16, 0.77], [0.22, 0.875], [0.38, 0.915], [0.54, 0.895], [0.635, 0.83], [0.665, 0.72], [0.635, 0.53], [0.615, 0.35], [0.605, 0.17], [0.60, 0]]),
        S(1.75, [[0.20, 0], [0.20, 0.82], [0.26, 0.935], [0.43, 0.97], [0.61, 0.945], [0.725, 0.87], [0.76, 0.75], [0.715, 0.56], [0.685, 0.37], [0.675, 0.18], [0.67, 0]]),
        S(1.35, [[0.20, 0], [0.20, 0.83], [0.28, 0.945], [0.46, 0.985], [0.65, 0.96], [0.785, 0.875], [0.815, 0.765], [0.77, 0.58], [0.74, 0.38], [0.73, 0.19], [0.725, 0]]),
        S(0.98, [[0.12, 0], [0.13, 0.84], [0.26, 0.945], [0.47, 0.975], [0.66, 0.945], [0.78, 0.875], [0.83, 0.79], [0.85, 0.70], [0.855, 0.56], [0.855, 0.28], [0.85, 0]]),
        S(0.25, [[0.118, 0], [0.13, 0.86], [0.27, 0.93], [0.47, 0.935], [0.66, 0.905], [0.78, 0.86], [0.835, 0.79], [0.86, 0.725], [1.09, 0.565], [1.145, 0.33], [1.162, 0]]),
        S(-0.20, [[0.118, 0], [0.13, 0.86], [0.27, 0.93], [0.47, 0.935], [0.67, 0.91], [0.80, 0.865], [0.86, 0.80], [0.88, 0.725], [1.11, 0.555], [1.168, 0.32], [1.186, 0]]),
        S(-0.72, [[0.118, 0], [0.13, 0.88], [0.29, 0.96], [0.51, 0.97], [0.71, 0.945], [0.85, 0.885], [0.92, 0.80], [0.985, 0.70], [1.05, 0.61], [1.115, 0.35], [1.13, 0]]),
        S(-1.20, [[0.20, 0], [0.20, 0.88], [0.30, 0.975], [0.52, 0.99], [0.74, 0.965], [0.88, 0.90], [0.98, 0.81], [1.03, 0.71], [1.06, 0.56], [1.02, 0.36], [1.03, 0]]),
        S(-1.75, [[0.17, 0], [0.17, 0.89], [0.28, 0.97], [0.52, 0.985], [0.76, 0.965], [0.92, 0.905], [1.015, 0.81], [1.035, 0.70], [1.015, 0.56], [0.995, 0.33], [0.995, 0]]),
        S(-2.10, [[0.24, 0], [0.24, 0.86], [0.32, 0.94], [0.52, 0.955], [0.74, 0.945], [0.90, 0.915], [0.995, 0.84], [1.015, 0.72], [0.995, 0.56], [0.975, 0.30], [0.975, 0]]),
        S(-2.28, [[0.28, 0], [0.28, 0.82], [0.35, 0.90], [0.52, 0.925], [0.72, 0.92], [0.88, 0.895], [0.975, 0.83], [0.99, 0.71], [0.975, 0.55], [0.965, 0.28], [0.965, 0]]),
        S(-2.345, [[0.32, 0], [0.32, 0.78], [0.38, 0.86], [0.52, 0.885], [0.70, 0.885], [0.86, 0.865], [0.95, 0.80], [0.965, 0.69], [0.95, 0.54], [0.945, 0.27], [0.945, 0]])
      ],
      //            c0 c1 c2 c3 c4 c5 c6 c7 c8 c9
      mats: mats([
        'b b b p p p p p p p',      // nose cap
        'b b p p p p p p p p',      // nose
        'b b p p p p p p p p',      // front wing
        'b b p p p p p p p p',      // to the axle
        'b b p p p p p p p p',      // bonnet to the cowl
        'b b p p p p p G g g',      // wrap-around visor screen (black A-pillar quarter)
        'b b p p p p p g q q',      // door glass / roof
        'b b p p p p p g q q',      // rear of the teardrop glass
        'b b p p p p p p G g',      // buttresses over black tunnels, engine-cover glass
        'b b p p p p p p G g',      // engine cover
        'b b p p p p p p p p',      // deck
        'b b p p p p p p p p',      // tail
        'b b b p p p p p p p'       // tail face
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // nose: wide black mesh intake under the floating blade, lateral intakes, slim slashed headlamps + LED eyebrow
      polys([[[-0.58, 0.15], [0.58, 0.15], [0.66, 0.22], [0.68, 0.38], [-0.68, 0.38], [-0.66, 0.22]]], 'front', 'grille', 0.004, false),
      polys([[[0.71, 0.17], [0.88, 0.19], [0.93, 0.33], [0.90, 0.46], [0.73, 0.43]]], 'front', 'black', 0.004, true),
      polys([[[0.42, 0.565], [0.70, 0.585], [0.87, 0.625], [0.87, 0.665], [0.66, 0.64], [0.47, 0.60]]], 'front', 'gloss', 0.006, true),
      polys([[[0.50, 0.585], [0.70, 0.598], [0.84, 0.628], [0.84, 0.645], [0.66, 0.622], [0.52, 0.598]]], 'front', 'light', 0.009, true),
      polys([[[0.47, 0.598], [0.66, 0.638], [0.87, 0.662], [0.87, 0.672], [0.66, 0.65], [0.47, 0.606]]], 'front', 'drl', 0.011, true),
      // bonnet S-duct slashes
      polys([[[2.06, 0.30], [1.90, 0.17], [1.88, 0.19], [2.04, 0.33]]], 'top', 'gloss', 0.004, true),
      // side: body-colour sail closes the teardrop door glass (rounded rear edge at x -0.36), the big black
      // intake directly behind the glass (top at mid-window height, door trailing edge curving down into it),
      // the door blade crease rising from behind the front wheel into the intake floor, sill blade
      polys([[[-0.33, 0.84], [-0.86, 0.84], [-0.86, 1.13], [-0.44, 1.13], [-0.39, 1.08], [-0.35, 0.99], [-0.33, 0.91]]], 'side', 'paint', 0.005, true),
      polys([[[-0.36, 0.985], [-0.60, 0.995], [-0.86, 0.975], [-0.99, 0.92], [-0.93, 0.85], [-0.76, 0.775], [-0.56, 0.735], [-0.40, 0.735], [-0.33, 0.80], [-0.32, 0.92]]], 'side', 'gloss', 0.009, true),
      polys([[[-0.43, 0.955], [-0.84, 0.94], [-0.90, 0.905], [-0.80, 0.86], [-0.60, 0.80], [-0.44, 0.80], [-0.39, 0.86]]], 'side', 'black', 0.011, true),
      polys([[[0.80, 0.592], [0.30, 0.634], [-0.18, 0.690], [-0.40, 0.745], [-0.40, 0.700], [-0.18, 0.656], [0.30, 0.621], [0.80, 0.587]]], 'side', 'gloss', 0.006, true),
      polys([[[0.92, 0.13], [-0.92, 0.13], [-0.92, 0.21], [0.92, 0.19]]], 'side', 'black', 0.004, true),
      // tail (rear photos: Böblingen straight-on, SF90 Spider rear 3/4, 2023 SF90 rear 3/4): black louvre band with
      // FERRARI lettering under the shut-off Gurney flap, third brake light at the top; two rounded smoked lamps per
      // side (bright LED ring round a dark red core, inner pod with a reverse dash) on a smoked bridge
      polys([rect(-0.50, 0.85, 0.50, 0.905)], 'rear', 'gloss', 0.004, false, 40),
      [{ t: 'text', view: 'rear', str: 'FERRARI', at: [0, 0.878], h: 0.026, mat: 'chrome', weight: 0.16, spacing: 2.2 }],
      polys([rect(-0.24, 0.925, 0.24, 0.936)], 'rear', 'tail', 0.006, false, 50),
      polys([rect(0.47, 0.848, 0.87, 0.888)], 'rear', 'smoke', 0.005, true, 40),
      lamp(rrect(0.468, 0.812, 0.668, 0.926, 0.032), [['smoke'], ['tail', 0.014, 0.013], ['lens', 0.030, 0.026], ['rev', 0.062, 0.049]], true),
      lamp(rrect(0.684, 0.806, 0.872, 0.92, 0.032), [['smoke'], ['tail', 0.014, 0.013], ['lens', 0.030, 0.026], ['tail', 0.064, 0.050]], true),
      // low LOD: the four pods as plain red blocks
      [[0.47, 0.595], [0.615, 0.74]].map(function (zr) { return { t: 'poly', view: 'rear', mat: 'tail', mirror: true, low: 'only', maxTilt: 40, pts: rect(zr[0], 0.825, zr[1], 0.91) }; }),
      // exhaust surrounds (tips: def exhaust), lower black bumper with honeycomb mesh either side, black diffuser
      // brace, the lit red fog / reflector bars, plate in its black recess, vertical corner vents
      polys([ell(0.36, 0.525, 0.095, 0.088, 12)], 'rear', 'gloss', 0.005, true, 40),
      polys([rect(-1.0, 0.16, 1.0, 0.29)], 'rear', 'black', 0.004, false),
      polys([[[0.29, 0.28], [0.62, 0.28], [0.90, 0.30], [0.90, 0.47], [0.80, 0.50], [0.56, 0.45], [0.36, 0.41], [0.29, 0.37]]], 'rear', 'gloss', 0.005, true),
      polys([[[0.32, 0.30], [0.62, 0.30], [0.86, 0.32], [0.86, 0.45], [0.79, 0.475], [0.57, 0.43], [0.38, 0.395], [0.32, 0.365]]], 'rear', 'grille', 0.008, true),
      polys(strip([[0.90, 0.36], [0.70, 0.335], [0.64, 0.30], [0.62, 0.17]], 0.028), 'rear', 'gloss', 0.011, true),
      polys(strip([[0.27, 0.30], [0.24, 0.27], [0, 0.26]], 0.028), 'rear', 'gloss', 0.011, true),
      polys([rect(0.38, 0.315, 0.58, 0.336)], 'rear', 'tail', 0.012, true, 40),
      polys([rect(-0.25, 0.30, 0.25, 0.40)], 'rear', 'plate', 0.010, false, 40),
      polys([rect(-0.12, 0.403, -0.08, 0.408), rect(0.08, 0.403, 0.12, 0.408)], 'rear', 'white', 0.012, false, 40),
      polys([[[-2.06, 0.46], [-2.12, 0.46], [-2.17, 0.80], [-2.11, 0.80]]], 'side', 'gloss', 0.005, true),
      fins([0.14, 0.30, 0.46, 0.62, 0.78], [[-1.98, 0.20], [-2.36, 0.31], [-2.37, 0.15], [-2.08, 0.15]], 'black'),
      [
        // door mirrors on slim stalks
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.83, z1: 0.99, pts2d: [[0.62, 0.90], [0.42, 0.905], [0.40, 0.975], [0.58, 0.985]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.52, 0.87, 0.80], s: [0.06, 0.03, 0.08] }
      ]
    ),
    // twin round tips flanking the plate (rear photo: just outside the plate edges, level with its top half)
    exhaust: [{ cx: 0.36, cy: 0.525, w: 0.115, h: 0.105, shape: 'round', mirror: true }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'Ferrari SF90 Stradale — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:Red_2019_Ferrari_SF90_Stradale_(48264238897)_(cropped).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2023_Ferrari_SF90_2.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2023_Ferrari_SF90_4.jpg (rear 3/4: exhausts at z +-0.24 checked), ' +
      'https://commons.wikimedia.org/wiki/File:Ferrari_SF90_Stradale_(2021)_(52863637352).jpg (side); rear detail: File:Ferrari_SF90_Stradale_in_Böblingen_02.jpg (rear), File:Ferrari_SF90_Spider_IMG_8856.jpg (rear 3/4).'
  };
  reg('ferrari-sf90-stradale', SF90);

  /* ---------------------------------------------------------------- more helpers */
  // thick polyline (view coordinates) -> list of convex quads, width w
  function strip(line, w) {
    var out = [], h = w / 2;
    function nrm(i) {
      var a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l * h, dx / l * h];
    }
    for (var i = 0; i < line.length - 1; i++) {
      var p = line[i], q = line[i + 1], n0 = nrm(i), n1 = nrm(i + 1);
      out.push([[p[0] - n0[0], p[1] - n0[1]], [q[0] - n1[0], q[1] - n1[1]], [q[0] + n1[0], q[1] + n1[1]], [p[0] + n0[0], p[1] + n0[1]]]);
    }
    return out;
  }
  // Bugatti horseshoe outline (front view [z, y]): straight-ish sides, round bottom, gently arched top
  function horseshoe(hw, yb, yt, n) {
    var out = [], rb = hw * 1.05, yc = yb + rb, k;
    out.push([hw * 0.96, yt - 0.01], [hw, yt - 0.06]);
    for (k = 0; k <= n; k++) { var a = -k / n * Math.PI; out.push([Math.cos(a) * hw, yc + Math.sin(a) * rb]); }
    out.push([-hw, yt - 0.06], [-hw * 0.96, yt - 0.01], [0, yt + 0.012]);
    return out.filter(function (p, i) { return i === 0 || Math.abs(p[0] - out[i - 1][0]) + Math.abs(p[1] - out[i - 1][1]) > 1e-4; });
  }

  /* ================================================================ McLaren P1 (2013–2015) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/McLaren_P1):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:McLaren_P1.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2013_McLaren_P1_MSO_Rear_LC24.jpg
  // Signature: body-colour beak dipping between two huge black front intakes, swoosh ("speedmark") headlamps,
  // twin bonnet ducts, teardrop bubble canopy with a roof snorkel, deep door scallop feeding a big side intake,
  // open black mesh tail framed by a thin C-shaped LED strip, wing on twin struts, single high centre exhaust.
  var P1 = {
    body: {
      stations: [
        S(2.33, [[0.20, 0], [0.20, 0.30], [0.24, 0.40], [0.28, 0.43], [0.32, 0.41], [0.35, 0.35], [0.36, 0.27], [0.365, 0.19], [0.365, 0.12], [0.365, 0.06], [0.365, 0]]),
        S(2.22, [[0.12, 0], [0.12, 0.58], [0.17, 0.70], [0.30, 0.755], [0.42, 0.73], [0.50, 0.65], [0.525, 0.55], [0.50, 0.40], [0.49, 0.27], [0.485, 0.13], [0.48, 0]]),
        S(2.00, [[0.15, 0], [0.16, 0.74], [0.22, 0.86], [0.38, 0.90], [0.53, 0.875], [0.625, 0.80], [0.65, 0.68], [0.60, 0.50], [0.58, 0.34], [0.57, 0.17], [0.565, 0]]),
        S(1.70, [[0.20, 0], [0.20, 0.80], [0.26, 0.92], [0.43, 0.955], [0.60, 0.93], [0.715, 0.85], [0.745, 0.72], [0.69, 0.54], [0.665, 0.36], [0.655, 0.18], [0.65, 0]]),
        S(1.33, [[0.20, 0], [0.20, 0.80], [0.28, 0.93], [0.45, 0.965], [0.64, 0.94], [0.785, 0.86], [0.815, 0.75], [0.765, 0.57], [0.74, 0.38], [0.73, 0.19], [0.725, 0]]),
        S(0.92, [[0.115, 0], [0.13, 0.80], [0.26, 0.90], [0.46, 0.925], [0.65, 0.90], [0.775, 0.83], [0.82, 0.74], [0.84, 0.64], [0.845, 0.50], [0.845, 0.25], [0.84, 0]]),
        S(0.10, [[0.115, 0], [0.13, 0.80], [0.26, 0.84], [0.44, 0.76], [0.62, 0.82], [0.76, 0.81], [0.83, 0.76], [0.86, 0.66], [1.07, 0.53], [1.14, 0.25], [1.165, 0]]),
        S(-0.35, [[0.115, 0], [0.13, 0.82], [0.27, 0.85], [0.45, 0.74], [0.64, 0.80], [0.79, 0.81], [0.86, 0.76], [0.895, 0.66], [1.11, 0.52], [1.175, 0.25], [1.188, 0]]),
        S(-0.85, [[0.115, 0], [0.13, 0.86], [0.29, 0.88], [0.48, 0.80], [0.68, 0.86], [0.84, 0.86], [0.93, 0.76], [0.97, 0.60], [1.05, 0.42], [1.10, 0.20], [1.11, 0]]),
        S(-1.30, [[0.20, 0], [0.20, 0.88], [0.30, 0.96], [0.52, 0.972], [0.72, 0.95], [0.86, 0.89], [0.94, 0.78], [0.97, 0.56], [1.0, 0.30], [1.035, 0.13], [1.045, 0]]),
        S(-1.80, [[0.17, 0], [0.17, 0.87], [0.28, 0.95], [0.50, 0.96], [0.70, 0.94], [0.84, 0.88], [0.92, 0.77], [0.955, 0.60], [0.97, 0.40], [0.98, 0.18], [0.985, 0]]),
        S(-2.10, [[0.30, 0], [0.30, 0.82], [0.38, 0.885], [0.54, 0.90], [0.72, 0.88], [0.84, 0.83], [0.91, 0.73], [0.94, 0.57], [0.955, 0.40], [0.96, 0.18], [0.962, 0]]),
        S(-2.258, [[0.36, 0], [0.36, 0.74], [0.42, 0.80], [0.56, 0.82], [0.72, 0.80], [0.83, 0.75], [0.89, 0.67], [0.92, 0.53], [0.93, 0.36], [0.935, 0.17], [0.935, 0]])
      ],
      mats: mats([
        'b b b p p p p p p p',      // beak tip
        'b b p p p p p p p p',      // nose
        'b b p p p p p p p p',      // front wings
        'b b p p p p p p p p',      // to the axle
        'b b p p p p p p p p',      // bonnet to the cowl
        'b b p p p p p G g g',      // wrap-around windscreen, black A-pillar quarter
        'b b p p p p p g g c',      // dark bubble canopy: glass sides, carbon roof
        'b b p p p p p g g c',      // rear of the bubble
        'b b p p p p p p g c',      // canopy tapering into the spine
        'b b p p p p p p p c',      // spine over the engine lid
        'b b p p p p p p p p',      // deck
        'b b b p p p p p p p'       // tail
      ]),
      capF: 'paint', capR: 'black'
    },
    parts: [].concat(
      // nose: two huge black intakes beside the beak, small centre intake, swoosh headlamps
      polys([[[0.26, 0.18], [0.80, 0.22], [0.86, 0.36], [0.80, 0.47], [0.50, 0.44], [0.30, 0.34]]], 'front', 'grille', 0.004, true),
      polys([rect(-0.16, 0.14, 0.16, 0.21)], 'front', 'grille', 0.004, false),
      polys([[[0.36, 0.50], [0.47, 0.485], [0.66, 0.515], [0.82, 0.565], [0.865, 0.635], [0.80, 0.65], [0.60, 0.615], [0.42, 0.575], [0.355, 0.535]]], 'front', 'gloss', 0.006, true),
      polys([[[0.50, 0.53], [0.66, 0.545], [0.80, 0.585], [0.83, 0.625], [0.66, 0.598], [0.52, 0.565]]], 'front', 'light', 0.009, true),
      // the McLaren "speedmark" DRL: sweep along the upper edge, hooking down round the inner end of the pod
      polys(strip([[0.85, 0.638], [0.70, 0.615], [0.52, 0.578], [0.40, 0.55], [0.375, 0.515], [0.42, 0.495]], 0.018), 'front', 'drl', 0.012, true),
      // twin bonnet ducts by the screen
      polys([[[1.12, 0.10], [1.30, 0.12], [1.36, 0.42], [1.10, 0.40]]], 'top', 'gloss', 0.005, true),
      // side: big black intake at the end of the door scallop, sill
      // the huge black door scallop: swept rear edge (radiator intake at its top), swoosh above, rising front edge
      polys([[[-0.64, 0.78], [0.18, 0.67], [0.10, 0.27], [-0.20, 0.30], [-0.40, 0.42], [-0.56, 0.63]],
        [[0.18, 0.67], [0.97, 0.45], [0.88, 0.36], [0.74, 0.27], [0.10, 0.27]]], 'side', 'gloss', 0.005, true),
      polys([[[-0.64, 0.78], [-0.40, 0.745], [-0.47, 0.56], [-0.56, 0.63]]], 'side', 'grille', 0.007, true),
      polys([[[0.90, 0.13], [-0.90, 0.13], [-0.90, 0.20], [0.90, 0.20]]], 'side', 'carbon', 0.004, true),
      // tail (rear photos: Geneva 2013 straight-on, MSO / HDK rear 3/4): the open black mesh tail under the body-
      // colour deck lip, framed on each side by the thin C-shaped LED blade (along the top edge, down the outer
      // edge, curling inward at the bottom); big stadium-shaped centre exhaust high in the mesh; carbon lower
      // panel with the plate, red reflector slashes, huge diffuser tunnels
      polys([[[-0.80, 0.47], [0.80, 0.47], [0.86, 0.56], [0.87, 0.74], [0.84, 0.84], [0.60, 0.86], [0.30, 0.835], [0, 0.825], [-0.30, 0.835], [-0.60, 0.86], [-0.84, 0.84], [-0.87, 0.74], [-0.86, 0.56]]], 'rear', 'grille', 0.004, false, 40),
      polys([rect(-0.70, 0.60, 0.70, 0.62), rect(-0.70, 0.53, 0.70, 0.545)], 'rear', 'gloss', 0.007, false, 40),
      polys(strip([[0.05, 0.832], [0.32, 0.842], [0.60, 0.866], [0.80, 0.85], [0.845, 0.76], [0.85, 0.62], [0.83, 0.53], [0.77, 0.478], [0.68, 0.47]], 0.016), 'rear', 'tail', 0.009, true, 40),
      polys([rect(0.02, 0.828, 0.735, 0.874)], 'rear', 'tail', 0.009, true).map(function (q) { q.low = 'only'; return q; }),
      polys([rect(0.70, 0.50, 0.735, 0.84)], 'rear', 'tail', 0.009, true).map(function (q) { q.low = 'only'; return q; }),
      polys([rrect(-0.22, 0.615, 0.22, 0.755, 0.05)], 'rear', 'chrome', 0.008, false, 40),
      polys([rrect(-0.19, 0.632, 0.19, 0.738, 0.04)], 'rear', 'gloss', 0.011, false, 40),
      polys([rect(-0.86, 0.36, 0.86, 0.47)], 'rear', 'carbon', 0.004, false),
      polys([rect(-0.24, 0.375, 0.24, 0.465)], 'rear', 'plate', 0.008, false, 40),
      [{ t: 'text', view: 'rear', str: 'McLAREN', at: [0, 0.795], h: 0.024, mat: 'chrome', weight: 0.16, spacing: 2 }],
      polys(strip([[0.50, 0.455], [0.55, 0.41], [0.57, 0.375]], 0.014), 'rear', 'tail', 0.010, true),
      polys([rect(-0.03, 0.365, 0.03, 0.385)], 'rear', 'tail', 0.012, false, 40),
      polys([0, 1, 2, 3].map(function (k) { var x = -1.50 - k * 0.07; return rect(x, 0.16, x - 0.035, 0.50); }), 'top', 'gloss', 0.005, true),
      fins([0.20, 0.46, 0.74], [[-1.95, 0.25], [-2.27, 0.36], [-2.28, 0.17], [-2.05, 0.17]], 'carbon', 0.016),
      [
        // roof snorkel
        { t: 'prism', mat: 'carbon', z0: -0.12, z1: 0.12, pts2d: [[-0.45, 1.18], [-0.95, 1.10], [-0.98, 1.17], [-0.62, 1.215]] },
        { t: 'box', mat: 'black', c: [-0.52, 1.195, 0], s: [0.04, 0.03, 0.2] },
        // active rear wing on twin struts: blade dipping in the middle, tips swept up into the deck-edge endplates
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.40, z1: 0.43, pts2d: [[-1.90, 0.98], [-2.05, 0.96], [-2.10, 1.11], [-1.98, 1.10]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.83, z1: 0.85, pts2d: [[-1.82, 1.02], [-2.20, 0.96], [-2.24, 1.10], [-2.20, 1.17], [-1.90, 1.15]] },
        // door mirrors on stalks
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.78, z1: 0.93, pts2d: [[0.70, 0.90], [0.52, 0.905], [0.50, 0.97], [0.66, 0.98]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.62, 0.87, 0.76], s: [0.05, 0.03, 0.08] }
      ],
      wing3d([{ z: 0, y: 1.095, x0: -1.86, x1: -2.20, t: 0.022 }, { z: 0.40, y: 1.105, x0: -1.86, x1: -2.21, t: 0.022 },
        { z: 0.68, y: 1.13, x0: -1.85, x1: -2.21, t: 0.02 }, { z: 0.84, y: 1.16, x0: -1.86, x1: -2.21, t: 0.018 }], 'carbon')
    ),
    // single big centre exit high in the mesh (stadium-shaped tip inside the chrome surround)
    exhaust: [{ cx: 0, cy: 0.685, w: 0.30, h: 0.085, shape: 'oval' }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'McLaren P1 — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:McLaren_P1.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2013_McLaren_P1_MSO_Rear_LC24.jpg (rear 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:P1_side_(14355555293).jpg (side: door scallop); rear detail: File:Geneva_MotorShow_2013_-_McLaren_P1_Rear.jpg (rear), File:2014_McLaren_P1_HDK_Rear.jpg (rear 3/4).'
  };
  reg('mclaren-p1', P1);

  /* ================================================================ Bugatti Chiron (2016–2022) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Bugatti_Chiron):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2020_Bugatti_Chiron_Sport_in_Nocturne_and_Atlantic_Blue,_front_left.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Bugatti_Chiron_1.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Bugatti_Chiron_IMG_0087.jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2021_Bugatti_Chiron_Super_Sport_8.0_Rear.jpg
  // Signature: chrome-framed horseshoe grille, slim headlamps with four round projectors, the polished C-line
  // sweeping from the roof over the B-pillar round a deep bow and forward along the door, two-tone body with the
  // dark carbon rear section and roof, dorsal fin, full-width light bar over a black mesh tail with quad pipes.
  var CLINE = [[-0.10, 1.17], [-0.42, 1.12], [-0.68, 1.0], [-0.84, 0.82], [-0.86, 0.64], [-0.78, 0.48], [-0.60, 0.38], [-0.30, 0.33], [0.10, 0.31], [0.50, 0.30]];
  var CHIRON = {
    body: {
      stations: [
        S(2.356, [[0.24, 0], [0.24, 0.30], [0.28, 0.40], [0.36, 0.44], [0.46, 0.42], [0.55, 0.36], [0.60, 0.28], [0.63, 0.20], [0.645, 0.14], [0.65, 0.07], [0.65, 0]]),
        S(2.25, [[0.14, 0], [0.14, 0.66], [0.20, 0.80], [0.34, 0.86], [0.50, 0.84], [0.62, 0.76], [0.67, 0.64], [0.68, 0.48], [0.69, 0.32], [0.70, 0.15], [0.705, 0]]),
        S(2.05, [[0.17, 0], [0.18, 0.82], [0.24, 0.93], [0.41, 0.97], [0.58, 0.95], [0.69, 0.88], [0.73, 0.76], [0.72, 0.56], [0.725, 0.36], [0.735, 0.17], [0.745, 0]]),
        S(1.75, [[0.22, 0], [0.22, 0.88], [0.28, 0.98], [0.46, 1.01], [0.64, 0.99], [0.77, 0.92], [0.81, 0.80], [0.77, 0.60], [0.765, 0.38], [0.775, 0.18], [0.785, 0]]),
        S(1.35, [[0.22, 0], [0.22, 0.90], [0.30, 0.99], [0.48, 1.015], [0.67, 0.995], [0.82, 0.93], [0.86, 0.82], [0.82, 0.62], [0.81, 0.40], [0.82, 0.20], [0.83, 0]]),
        S(0.85, [[0.125, 0], [0.14, 0.90], [0.28, 0.975], [0.49, 0.99], [0.69, 0.965], [0.83, 0.90], [0.89, 0.81], [0.91, 0.70], [0.915, 0.55], [0.915, 0.28], [0.915, 0]]),
        S(0.05, [[0.125, 0], [0.14, 0.90], [0.28, 0.965], [0.49, 0.975], [0.69, 0.955], [0.83, 0.90], [0.90, 0.82], [0.935, 0.74], [1.15, 0.58], [1.19, 0.32], [1.20, 0]]),
        S(-0.35, [[0.125, 0], [0.14, 0.90], [0.28, 0.97], [0.49, 0.98], [0.70, 0.96], [0.85, 0.91], [0.93, 0.83], [0.97, 0.74], [1.165, 0.58], [1.205, 0.32], [1.212, 0]]),
        S(-0.82, [[0.125, 0], [0.14, 0.92], [0.29, 1.0], [0.51, 1.01], [0.73, 0.995], [0.88, 0.94], [0.97, 0.85], [1.02, 0.72], [1.13, 0.56], [1.165, 0.30], [1.17, 0]]),
        S(-1.30, [[0.22, 0], [0.22, 0.92], [0.31, 1.01], [0.53, 1.02], [0.76, 1.0], [0.91, 0.94], [1.0, 0.84], [1.05, 0.70], [1.085, 0.50], [1.10, 0.10], [1.135, 0]]),
        S(-1.85, [[0.25, 0], [0.25, 0.90], [0.33, 0.985], [0.54, 1.0], [0.76, 0.98], [0.91, 0.92], [0.99, 0.82], [1.03, 0.68], [1.045, 0.48], [1.05, 0.10], [1.075, 0]]),
        S(-2.10, [[0.30, 0], [0.30, 0.86], [0.38, 0.95], [0.56, 0.965], [0.76, 0.945], [0.90, 0.885], [0.98, 0.79], [1.015, 0.66], [1.03, 0.47], [1.035, 0.10], [1.05, 0]]),
        S(-2.189, [[0.33, 0], [0.33, 0.82], [0.40, 0.91], [0.57, 0.925], [0.76, 0.905], [0.89, 0.85], [0.965, 0.76], [1.0, 0.64], [1.015, 0.46], [1.02, 0.10], [1.035, 0]])
      ],
      mats: mats([
        'b b b p p p p p p p',      // nose
        'b b p p p p p p p p',      // bonnet front
        'b b p p p p p p p p',      // wings
        'b b p p p p p p p p',      // to the axle
        'b b p p p p p p p p',      // bonnet to the cowl
        'b b p p p p p g g g',      // windscreen
        'b b p p p p p g G G',      // door glass, Garbon roof
        'b b p p p p p g G G',      // inside the C
        'b b G G G G G G G g',      // Garbon rear section, engine window
        'b b G G G G G G G g',      // engine Gover either side of the fin
        'b b G G G G G G G G',      // deck
        'b b b G G G G G G G'       // tail
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // horseshoe grille: chrome frame, black mesh (no badge artwork)
      polys([horseshoe(0.225, 0.21, 0.68, 10)], 'front', 'chrome', 0.008, false),
      polys([horseshoe(0.19, 0.245, 0.645, 10)], 'front', 'grille', 0.012, false),
      // big lower intakes either side, outer vertical intakes
      polys([[[0.27, 0.20], [0.70, 0.24], [0.72, 0.42], [0.29, 0.40]]], 'front', 'grille', 0.004, true),
      polys([[[0.76, 0.26], [0.92, 0.30], [0.92, 0.52], [0.78, 0.48]]], 'front', 'black', 0.004, true),
      polys([rect(-0.60, 0.15, 0.60, 0.19)], 'front', 'chrome', 0.004, false),
      // slim headlamps with four round projectors in a row
      polys([[[0.33, 0.60], [0.86, 0.645], [0.86, 0.70], [0.34, 0.655]]], 'front', 'gloss', 0.006, true),
      polys([0.42, 0.53, 0.64, 0.75].map(function (z, i) { return ell(z, 0.637 + i * 0.009, 0.034, 0.024, 8); }), 'front', 'light', 0.01, true),
      // the C-line, side intake inside the bow, sill
      polys(strip(CLINE, 0.045), 'side', 'chrome', 0.008, true),
      polys([[[-0.30, 0.42], [-0.60, 0.43], [-0.76, 0.56], [-0.79, 0.76], [-0.66, 0.94], [-0.42, 0.98], [-0.28, 0.80]]], 'side', 'grille', 0.005, true),
      polys([[[0.95, 0.14], [-0.95, 0.14], [-0.95, 0.22], [0.95, 0.21]]], 'side', 'black', 0.004, true),
      // tail (rear photos: London straight-on, Super Sport 8.0 rear 3/4, IAA 2017): the single full-width LED light
      // bar (one thin blade) widening at the outer ends into the saw-tooth lamp sections, a polished strip under it,
      // black mesh below with the plate, BUGATTI lettering, centre fog light, quad exhaust block at the bottom
      polys([rect(-1.0, 0.20, 1.0, 0.735)], 'rear', 'grille', 0.004, false),
      polys([[[-1.0, 0.735], [1.0, 0.735], [1.0, 0.80], [-1.0, 0.80]]], 'rear', 'smoke', 0.005, false),
      polys([rect(-0.90, 0.756, 0.90, 0.772)], 'rear', 'tail', 0.008, false),
      polys([[[0.46, 0.75], [0.88, 0.735], [0.92, 0.76], [0.92, 0.805], [0.50, 0.792]]], 'rear', 'tail', 0.009, true),
      polys([0, 1, 2, 3, 4, 5].map(function (k) { var z = 0.52 + k * 0.064; return [[z, 0.794], [z + 0.064, 0.795], [z + 0.032, 0.768]]; }), 'rear', 'lens', 0.013, true),
      polys([rect(0.04, 0.75, 0.74, 0.79)], 'rear', 'tail', 0.009, true).map(function (q) { q.low = 'only'; q.maxTilt = 40; return q; }),
      polys(strip([[0, 0.728], [0.60, 0.727], [0.84, 0.733], [0.92, 0.765]], 0.012), 'rear', 'chrome', 0.010, true),
      polys([rect(-0.25, 0.46, 0.25, 0.575)], 'rear', 'plate', 0.008, false, 40),
      [{ t: 'text', view: 'rear', str: 'BUGATTI', at: [0, 0.64], h: 0.03, mat: 'chrome', weight: 0.15, spacing: 2.2 }],
      polys([rect(-0.035, 0.39, 0.035, 0.425)], 'rear', 'tail', 0.010, false, 40),
      polys([[[-0.33, 0.33], [0.33, 0.33], [0.29, 0.14], [-0.29, 0.14]]], 'rear', 'chrome', 0.006, false, 40),
      polys([rect(0.60, 0.40, 0.92, 0.44), rect(0.62, 0.48, 0.92, 0.52)], 'rear', 'gloss', 0.008, true, 40),
      fins([0.42, 0.62, 0.82], [[-1.70, 0.24], [-2.19, 0.34], [-2.20, 0.12], [-1.85, 0.12]], 'carbon', 0.016),
      // stowed active wing: carbon blade outline flush on the tail top
      polys([rect(-1.88, -0.82, -2.17, 0.82)], 'top', 'carbon', 0.006, false),
      [
        // dorsal fin
        { t: 'prism', mat: 'carbon', z0: -0.012, z1: 0.012, pts2d: [[-0.40, 1.205], [-2.14, 1.04], [-2.16, 1.075], [-0.80, 1.20]] },
        // door mirrors on A-pillar stalks
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.90, z1: 1.06, pts2d: [[0.62, 0.99], [0.42, 1.0], [0.40, 1.07], [0.58, 1.08]] },
        { t: 'box', mat: 'chrome', mirror: true, c: [0.56, 0.96, 0.90], s: [0.05, 0.025, 0.08] }
      ]
    ),
    // quad exhaust: four tall rectangular outlets in one polished block, centre bottom
    exhaust: [{ cx: 0.075, cy: 0.235, w: 0.10, h: 0.12, shape: 'trapezoid', mirror: true }, { cx: 0.205, cy: 0.235, w: 0.10, h: 0.11, shape: 'trapezoid', mirror: true }],
    wheels: { style: 'split', spokes: 5 },
    notes: 'Bugatti Chiron — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2020_Bugatti_Chiron_Sport_in_Nocturne_and_Atlantic_Blue,_front_left.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Bugatti_Chiron_1.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Bugatti_Chiron_IMG_0087.jpg (front 3/4, C-line), ' +
      'https://commons.wikimedia.org/wiki/File:2021_Bugatti_Chiron_Super_Sport_8.0_Rear.jpg (rear 3/4); rear detail: File:Chiron_Rear.jpg (rear, quad exhaust block, saw-tooth lamp ends).'
  };
  reg('bugatti-chiron', CHIRON);

  /* ================================================================ Koenigsegg Jesko (2019–) */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Koenigsegg_Jesko):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:GIMS_2019,_Le_Grand-Saconnex_(GIMS0833).jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:Koenigsegg_Jesko_Absolut_mock-up_(20220401)_01.jpg
  //   front:     https://commons.wikimedia.org/wiki/File:Koenigsegg_Jesko,_GIMS_2019,_Le_Grand-Saconnex_(GIMS0826).jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:Koenigsegg_Jesko_Genf_2019_1Y7A5553.jpg
  // Signature: very low wide nose with a big carbon splitter + canards, slim slashed LED headlamps, teardrop
  // canopy, big black side scoops ahead of the rear wheels, the tall boomerang swan-neck wing above the tail,
  // small corner tail lamps, single centre exhaust over an open diffuser.
  var JESKO = {
    body: {
      stations: [
        S(2.345, [[0.15, 0], [0.15, 0.62], [0.18, 0.70], [0.23, 0.73], [0.29, 0.70], [0.33, 0.62], [0.35, 0.50], [0.36, 0.38], [0.37, 0.25], [0.375, 0.12], [0.375, 0]]),
        S(2.22, [[0.11, 0], [0.11, 0.70], [0.16, 0.82], [0.27, 0.87], [0.40, 0.86], [0.50, 0.80], [0.53, 0.70], [0.49, 0.54], [0.455, 0.36], [0.445, 0.18], [0.44, 0]]),
        S(2.00, [[0.14, 0], [0.15, 0.84], [0.21, 0.94], [0.37, 0.985], [0.55, 0.965], [0.67, 0.89], [0.70, 0.77], [0.62, 0.60], [0.55, 0.40], [0.53, 0.20], [0.525, 0]]),
        S(1.70, [[0.20, 0], [0.20, 0.88], [0.27, 0.98], [0.44, 1.015], [0.64, 0.995], [0.78, 0.92], [0.80, 0.78], [0.71, 0.62], [0.625, 0.42], [0.60, 0.20], [0.595, 0]]),
        S(1.35, [[0.20, 0], [0.20, 0.88], [0.29, 0.985], [0.47, 1.015], [0.68, 0.995], [0.83, 0.92], [0.845, 0.78], [0.76, 0.63], [0.68, 0.43], [0.655, 0.21], [0.65, 0]]),
        S(0.90, [[0.11, 0], [0.12, 0.86], [0.26, 0.96], [0.47, 0.99], [0.67, 0.965], [0.80, 0.90], [0.83, 0.79], [0.80, 0.68], [0.77, 0.52], [0.765, 0.26], [0.765, 0]]),
        S(0.10, [[0.11, 0], [0.12, 0.84], [0.26, 0.92], [0.47, 0.93], [0.66, 0.91], [0.78, 0.86], [0.845, 0.79], [0.875, 0.72], [1.10, 0.58], [1.15, 0.32], [1.165, 0]]),
        S(-0.32, [[0.11, 0], [0.12, 0.84], [0.26, 0.925], [0.47, 0.935], [0.67, 0.915], [0.80, 0.87], [0.875, 0.79], [0.905, 0.70], [1.15, 0.56], [1.20, 0.31], [1.21, 0]]),
        S(-0.85, [[0.11, 0], [0.12, 0.88], [0.28, 0.97], [0.50, 0.98], [0.71, 0.96], [0.86, 0.90], [0.95, 0.80], [1.0, 0.68], [1.08, 0.54], [1.12, 0.30], [1.13, 0]]),
        S(-1.35, [[0.20, 0], [0.20, 0.90], [0.30, 0.995], [0.52, 1.015], [0.75, 0.995], [0.92, 0.93], [0.98, 0.82], [0.97, 0.68], [0.99, 0.50], [1.0, 0.28], [1.0, 0]]),
        S(-1.85, [[0.17, 0], [0.17, 0.90], [0.28, 0.99], [0.50, 1.005], [0.73, 0.985], [0.90, 0.92], [0.97, 0.81], [0.95, 0.67], [0.96, 0.50], [0.965, 0.28], [0.965, 0]]),
        S(-2.15, [[0.30, 0], [0.30, 0.86], [0.36, 0.945], [0.52, 0.96], [0.72, 0.94], [0.86, 0.88], [0.93, 0.78], [0.93, 0.64], [0.94, 0.48], [0.945, 0.27], [0.945, 0]]),
        S(-2.265, [[0.36, 0], [0.36, 0.80], [0.40, 0.88], [0.54, 0.895], [0.71, 0.875], [0.83, 0.82], [0.89, 0.73], [0.90, 0.60], [0.91, 0.45], [0.915, 0.26], [0.915, 0]])
      ],
      mats: mats([
        'b b b p p p p p p p',      // nose
        'b b p p p p p p p p',      // nose
        'b b p p p p p p p p',      // wings
        'b b p p p p p p p p',      // to the axle
        'b b p p p p p p p p',      // bonnet to the cowl
        'b b p p p p p g g g',      // wrap-around windscreen
        'b b p p p p p g q q',      // canopy / targa roof
        'b b p p p p p g q q',      // rear of the canopy
        'b b p p p p p p p g',      // engine window
        'b b p p p p p p p p',      // engine cover
        'b b p p p p p p p p',      // deck
        'b b b p p p p p p p'       // tail
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // nose: wide low mouth, corner intakes, slim slashed LED headlamps
      polys([[[-0.48, 0.13], [0.48, 0.13], [0.56, 0.22], [0.54, 0.33], [-0.54, 0.33], [-0.56, 0.22]]], 'front', 'grille', 0.004, false),
      polys([[[0.56, 0.15], [0.88, 0.20], [0.92, 0.40], [0.62, 0.36]]], 'front', 'black', 0.004, true),
      polys([[[0.48, 0.555], [0.62, 0.565], [0.86, 0.64], [0.86, 0.675], [0.66, 0.62], [0.50, 0.58]]], 'front', 'gloss', 0.006, true),
      polys([[[0.52, 0.565], [0.64, 0.574], [0.84, 0.645], [0.84, 0.662], [0.64, 0.598], [0.53, 0.575]]], 'front', 'drl', 0.010, true),
      // bonnet vent + front-wing louvres
      polys([[[2.05, -0.30], [2.05, 0.30], [1.72, 0.22], [1.72, -0.22]]], 'top', 'gloss', 0.004, false),
      polys([0, 1, 2].map(function (k) { var x = 1.20 + k * 0.1; return rect(x, 0.56, x + 0.05, 0.76); }), 'top', 'black', 0.004, true),
      // side: big black scoop ahead of the rear wheel, sill
      polys([[[-0.52, 0.40], [-0.92, 0.38], [-0.98, 0.56], [-0.92, 0.84], [-0.72, 0.84], [-0.56, 0.62]]], 'side', 'grille', 0.005, true),
      polys([[[0.92, 0.12], [-0.92, 0.12], [-0.92, 0.19], [0.92, 0.19]]], 'side', 'carbon', 0.004, true),
      // tail (rear photos: LC24 straight-on, GIMS 2019 straight-on, 2022 rear 3/4): body-colour tail face with
      // slim almond lamps high on the corners (red LED outline round a smoked core), the wide black 'smile' mouth
      // with horizontal slats, centre octagonal exhaust in a polished surround, JESKO lettering, plate, red
      // reflectors, carbon diffuser lip sweeping up at the corners, vertical strakes
      lamp([[0.50, 0.83], [0.64, 0.80], [0.82, 0.772], [0.915, 0.785], [0.88, 0.83], [0.70, 0.852]], [['tail'], ['smoke', 0.014, 0.009], ['tail', 0.10, 0.026]], true, 0),
      polys([[[0.50, 0.805], [0.74, 0.785], [0.74, 0.822], [0.50, 0.845]]], 'rear', 'tail', 0.008, true).map(function (q) { q.low = 'only'; q.maxTilt = 40; return q; }),
      polys([[[0, 0.68], [0.30, 0.685], [0.55, 0.66], [0.74, 0.60], [0.84, 0.48], [0.86, 0.34], [0.70, 0.36], [0.50, 0.40], [0, 0.40],
        [-0.50, 0.40], [-0.70, 0.36], [-0.86, 0.34], [-0.84, 0.48], [-0.74, 0.60], [-0.55, 0.66], [-0.30, 0.685]]], 'rear', 'grille', 0.004, false),
      polys([[[0.28, 0.615], [0.62, 0.60], [0.66, 0.585], [0.28, 0.60]], [[0.30, 0.55], [0.72, 0.53], [0.74, 0.515], [0.30, 0.535]], [[0.30, 0.47], [0.78, 0.45], [0.79, 0.435], [0.30, 0.455]]], 'rear', 'gloss', 0.008, true),
      polys([[[-0.20, 0.585], [-0.15, 0.545], [0.15, 0.545], [0.20, 0.585], [0.20, 0.63], [0.15, 0.665], [-0.15, 0.665], [-0.20, 0.63]]], 'rear', 'chrome', 0.008, false, 40),
      [{ t: 'text', view: 'rear', str: 'JESKO', at: [0.46, 0.64], h: 0.03, mat: 'chrome', weight: 0.14, skew: 0.2 }],
      polys([rect(-0.22, 0.42, 0.22, 0.51)], 'rear', 'plate', 0.010, false, 40),
      polys([rect(0.38, 0.425, 0.48, 0.445)], 'rear', 'tail', 0.010, true, 40),
      polys(strip([[0, 0.335], [0.50, 0.33], [0.72, 0.31], [0.86, 0.33], [0.90, 0.42]], 0.02), 'rear', 'carbon', 0.010, true),
      [
        // big open diffuser: ramp + vertical strakes
        { t: 'prism', mat: 'carbon', z0: -0.86, z1: 0.86, pts2d: [[-1.70, 0.115], [-2.30, 0.37], [-2.30, 0.39], [-1.70, 0.135]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.18, z1: 0.195, pts2d: [[-1.80, 0.12], [-2.33, 0.37], [-2.33, 0.11]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.50, z1: 0.515, pts2d: [[-1.80, 0.12], [-2.33, 0.37], [-2.33, 0.11]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.72, z1: 0.735, pts2d: [[-1.85, 0.14], [-2.31, 0.33], [-2.31, 0.13]] },
        { t: 'prism', mat: 'carbon', z0: -0.0075, z1: 0.0075, pts2d: [[-1.80, 0.12], [-2.33, 0.37], [-2.33, 0.11]] },
        // carbon splitter + twin canards per side
        // (stepped in plan so it follows the nose instead of sticking out past the bumper corners)
        { t: 'prism', mat: 'carbon', z0: -0.56, z1: 0.56, pts2d: [[1.95, 0.095], [2.40, 0.095], [2.40, 0.115], [1.95, 0.13]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.56, z1: 0.80, pts2d: [[1.95, 0.095], [2.30, 0.095], [2.30, 0.115], [1.95, 0.13]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.80, z1: 0.93, pts2d: [[1.90, 0.095], [2.16, 0.095], [2.16, 0.115], [1.90, 0.13]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.78, z1: 0.92, pts2d: [[2.02, 0.24], [2.19, 0.22], [2.19, 0.235], [2.02, 0.26]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.74, z1: 0.88, pts2d: [[1.98, 0.34], [2.14, 0.31], [2.14, 0.325], [1.98, 0.36]] },
        // swan-neck boomerang wing: blade, end plates, struts
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.875, z1: 0.895, pts2d: [[-1.98, 1.20], [-2.36, 1.24], [-2.42, 1.44], [-2.08, 1.40]] },
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.24, z1: 0.27, pts2d: [[-1.70, 1.0], [-1.84, 0.99], [-2.0, 1.20], [-2.10, 1.335], [-2.03, 1.345], [-1.92, 1.22]] },
        // door mirrors on stalks
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.84, z1: 1.0, pts2d: [[0.66, 0.92], [0.48, 0.925], [0.46, 0.99], [0.62, 1.0]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.58, 0.89, 0.82], s: [0.05, 0.03, 0.08] }
      ],
      // boomerang swan-neck wing: low centre, tips sweeping up and back into the tall endplates
      wing3d([{ z: 0, y: 1.30, x0: -1.96, x1: -2.36, t: 0.03 }, { z: 0.30, y: 1.305, x0: -1.98, x1: -2.36, t: 0.03 },
        { z: 0.60, y: 1.33, x0: -2.0, x1: -2.38, t: 0.026 }, { z: 0.88, y: 1.38, x0: -2.04, x1: -2.40, t: 0.022 }], 'carbon')
    ),
    // single centre exhaust: wide bright oval low in the rear grille, above the plate (rear 3/4 photo)
    exhaust: [{ cx: 0, cy: 0.605, w: 0.30, h: 0.10, shape: 'oval' }],
    wheels: { style: 'star', spokes: 5 },
    notes: 'Koenigsegg Jesko — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:GIMS_2019,_Le_Grand-Saconnex_(GIMS0833).jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Koenigsegg_Jesko_Absolut_mock-up_(20220401)_01.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:Koenigsegg_Jesko,_GIMS_2019,_Le_Grand-Saconnex_(GIMS0826).jpg (front), ' +
      'https://commons.wikimedia.org/wiki/File:Koenigsegg_Jesko_Genf_2019_1Y7A5553.jpg (rear 3/4); rear detail: File:2023_Koenigsegg_Jesko_Rear_LC24.jpg, File:Koenigsegg_Jesko,_GIMS_2019,_Le_Grand-Saconnex_(GIMS0844).jpg (rear).'
  };
  reg('koenigsegg-jesko', JESKO);

  /* ================================================================ Porsche 918 Spyder (2013–2015), open top */
  // Reference photos (Wikimedia Commons, via en.wikipedia.org/wiki/Porsche_918_Spyder):
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2015_Porsche_918_Spyder_Platinum_Silver_Metallic_SCD_24.jpg
  //   front 3/4: https://commons.wikimedia.org/wiki/File:2014_Porsche_918_Spyder_-_Weissach_Package.jpg
  //   side:      https://commons.wikimedia.org/wiki/File:918_side_(14374138534).jpg
  //   rear 3/4:  https://commons.wikimedia.org/wiki/File:2015_Porsche_918_Spyder_Rear_Quarter_LC24.jpg
  // Signature: low bonnet between peaked front wings carrying upright headlamps with 2x2 LED spots, three-intake
  // apron with blade-split outer intakes, open cockpit behind a short wrap screen, twin body-colour headrest
  // fairings flowing back to the deck, top-pipe exhausts in the deck, slim corner tail lamps under the wing.
  var P918 = {
    body: {
      stations: [
        S(2.355, [[0.18, 0], [0.18, 0.40], [0.21, 0.50], [0.26, 0.54], [0.31, 0.52], [0.34, 0.46], [0.35, 0.38], [0.35, 0.28], [0.345, 0.18], [0.345, 0.09], [0.345, 0]]),
        S(2.24, [[0.12, 0], [0.12, 0.62], [0.17, 0.73], [0.29, 0.78], [0.42, 0.76], [0.52, 0.70], [0.55, 0.61], [0.50, 0.46], [0.47, 0.31], [0.46, 0.15], [0.46, 0]]),
        S(2.02, [[0.16, 0], [0.17, 0.76], [0.23, 0.86], [0.39, 0.90], [0.55, 0.88], [0.65, 0.82], [0.685, 0.72], [0.61, 0.53], [0.565, 0.35], [0.55, 0.17], [0.545, 0]]),
        S(1.72, [[0.22, 0], [0.22, 0.82], [0.28, 0.925], [0.45, 0.955], [0.62, 0.93], [0.74, 0.865], [0.77, 0.76], [0.69, 0.56], [0.635, 0.37], [0.62, 0.18], [0.615, 0]]),
        S(1.36, [[0.22, 0], [0.22, 0.83], [0.30, 0.94], [0.47, 0.965], [0.65, 0.945], [0.78, 0.875], [0.805, 0.77], [0.74, 0.58], [0.69, 0.38], [0.675, 0.19], [0.67, 0]]),
        S(0.95, [[0.115, 0], [0.13, 0.83], [0.27, 0.92], [0.47, 0.945], [0.66, 0.92], [0.77, 0.855], [0.805, 0.77], [0.80, 0.68], [0.79, 0.55], [0.785, 0.28], [0.78, 0]]),
        S(0.22, [[0.115, 0], [0.13, 0.84], [0.27, 0.90], [0.47, 0.905], [0.66, 0.885], [0.78, 0.84], [0.84, 0.77], [0.865, 0.70], [1.06, 0.60], [1.085, 0.34], [1.095, 0]]),
        S(0.17, [[0.115, 0], [0.13, 0.84], [0.27, 0.90], [0.47, 0.905], [0.66, 0.885], [0.78, 0.84], [0.84, 0.77], [0.86, 0.70], [0.80, 0.64], [0.60, 0.44], [0.58, 0]]),
        S(-0.42, [[0.115, 0], [0.13, 0.86], [0.27, 0.92], [0.47, 0.925], [0.67, 0.905], [0.81, 0.86], [0.89, 0.79], [0.92, 0.72], [0.84, 0.66], [0.60, 0.44], [0.58, 0]]),
        S(-0.48, [[0.115, 0], [0.13, 0.86], [0.27, 0.925], [0.47, 0.93], [0.67, 0.91], [0.82, 0.865], [0.91, 0.795], [0.95, 0.70], [1.08, 0.52], [1.12, 0.32], [0.94, 0]]),
        S(-0.95, [[0.115, 0], [0.13, 0.89], [0.29, 0.955], [0.51, 0.965], [0.72, 0.945], [0.88, 0.89], [0.97, 0.80], [1.01, 0.69], [1.09, 0.52], [1.11, 0.32], [0.96, 0]]),
        S(-1.36, [[0.22, 0], [0.22, 0.89], [0.31, 0.965], [0.53, 0.975], [0.75, 0.955], [0.91, 0.90], [1.0, 0.80], [1.035, 0.68], [1.06, 0.52], [1.07, 0.32], [0.99, 0]]),
        S(-1.82, [[0.18, 0], [0.18, 0.88], [0.29, 0.955], [0.51, 0.965], [0.74, 0.945], [0.90, 0.89], [0.985, 0.79], [1.02, 0.66], [1.035, 0.50], [1.04, 0.28], [1.035, 0]]),
        S(-2.15, [[0.27, 0], [0.27, 0.84], [0.35, 0.915], [0.54, 0.93], [0.74, 0.905], [0.88, 0.85], [0.96, 0.75], [0.99, 0.62], [1.005, 0.47], [1.01, 0.26], [1.01, 0]]),
        S(-2.288, [[0.31, 0], [0.31, 0.78], [0.38, 0.86], [0.55, 0.875], [0.73, 0.855], [0.86, 0.80], [0.935, 0.71], [0.965, 0.59], [0.98, 0.45], [0.985, 0.25], [0.985, 0]])
      ],
      mats: mats([
        'b b b p p p p p p p',      // nose
        'b b p p p p p p p p',      // nose
        'b b p p p p p p p p',      // wing peaks
        'b b p p p p p p p p',      // to the axle
        'b b p p p p p p p p',      // bonnet to the cowl
        'b b p p p p p g g g',      // wrap screen
        'b b p p p p p b g g',      // screen back face
        'b b p p p p p i i i',      // open cockpit
        'b b p p p p p p i i',      // bulkhead / headrests
        'b b p p p p p p p c',      // fairings, carbon centre deck
        'b b p p p p p p p c',      // fairings
        'b b p p p p p p p p',      // deck
        'b b p p p p p p p p',      // tail
        'b b b p p p p p p p'       // tail face
      ]),
      capF: 'paint', capR: 'paint'
    },
    parts: [].concat(
      // apron: centre intake, outer intakes split by a body-colour blade
      polys([[[-0.30, 0.16], [0.30, 0.16], [0.34, 0.32], [-0.34, 0.32]]], 'front', 'grille', 0.004, false),
      polys([[[0.44, 0.17], [0.84, 0.21], [0.86, 0.29], [0.45, 0.27]], [[0.46, 0.30], [0.86, 0.32], [0.86, 0.385], [0.50, 0.36]]], 'front', 'grille', 0.004, true),
      // upright headlamps on the wing peaks with 2x2 LED spots
      polys([ell(0.655, 0.50, 0.095, 0.115, 12, -0.45)], 'front', 'gloss', 0.012, true),
      polys([ell(0.655, 0.50, 0.08, 0.098, 12, -0.45)], 'front', 'light', 0.018, true),
      polys([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(function (q) { return ell(0.655 + q[0] * 0.032, 0.505 + q[1] * 0.03, 0.02, 0.018, 6); }), 'front', 'drl', 0.024, true),
      // top-pipe exhausts in the deck behind the fairings

      // side: intake slot behind the door, lower scallop shadow, sill
      polys([[[-0.50, 0.80], [-0.70, 0.78], [-0.72, 0.90], [-0.52, 0.92]]], 'side', 'gloss', 0.005, true),
      polys([[[0.70, 0.30], [-0.80, 0.32], [-0.90, 0.44], [0.40, 0.36]]], 'side', 'gloss', 0.004, true),
      polys([[[0.92, 0.13], [-0.92, 0.13], [-0.92, 0.20], [0.92, 0.20]]], 'side', 'black', 0.004, true),
      // tail (rear photos: Geneva straight-on, LC24 rear 3/4, Mexico Blue rear 3/4): wide wedge lamps high on the
      // corners (smoked housing, bright red outline, dark inner bar with a light blade), PORSCHE lettering and the
      // '918 SPYDER' script between them, the big black corner vents with mesh, plate, carbon diffuser with strakes
      lamp([[0.40, 0.858], [0.80, 0.85], [0.915, 0.858], [0.93, 0.905], [0.84, 0.925], [0.40, 0.912]], [['smoke'], ['tail', 0.010, 0.008], ['lens', 0.03, 0.019], ['tail', 0.07, 0.025]], true, 0),
      polys([rect(0.40, 0.855, 0.74, 0.91)], 'rear', 'tail', 0.008, true).map(function (q) { q.low = 'only'; q.maxTilt = 40; return q; }),
      [{ t: 'text', view: 'rear', str: 'PORSCHE', at: [0, 0.845], h: 0.03, mat: 'black', weight: 0.14, spacing: 2.6 },
        { t: 'text', view: 'rear', str: '918 SPYDER', at: [0.20, 0.79], h: 0.02, mat: 'chrome', weight: 0.16, skew: 0.25 }],
      polys([[[0.44, 0.47], [0.70, 0.49], [0.90, 0.53], [0.93, 0.66], [0.88, 0.72], [0.60, 0.70], [0.48, 0.62]]], 'rear', 'gloss', 0.004, true),
      polys([[[0.50, 0.50], [0.70, 0.515], [0.86, 0.55], [0.88, 0.65], [0.84, 0.69], [0.62, 0.675], [0.52, 0.61]]], 'rear', 'grille', 0.007, true),
      polys([rect(-0.86, 0.22, 0.86, 0.42)], 'rear', 'carbon', 0.004, false),
      polys([rect(-0.27, 0.49, 0.27, 0.62)], 'rear', 'gloss', 0.006, false, 40),
      polys([rect(-0.25, 0.50, 0.25, 0.61)], 'rear', 'plate', 0.008, false, 40),
      polys([rect(-0.12, 0.613, -0.08, 0.618), rect(0.08, 0.613, 0.12, 0.618)], 'rear', 'white', 0.010, false, 40),
      polys([rect(0.30, 0.43, 0.42, 0.45)], 'rear', 'tail', 0.008, true, 40),
      fins([0.16, 0.34, 0.52, 0.70], [[-1.92, 0.20], [-2.29, 0.31], [-2.30, 0.13], [-2.02, 0.13]], 'carbon', 0.016),
      [
        // top-pipe exhausts standing out of the deck between the fairings
        { t: 'cyl', mat: 'chrome', mirror: true, c: [-1.22, 1.03, 0.20], r: 0.06, l: 0.12, axis: 'y', sides: 10 },
        { t: 'poly', mat: 'black', mirror: true, normal: [0, 1, 0], pts: ell(-1.22, 0.20, 0.045, 0.045, 10).map(function (q) { return [q[0], 1.092, q[1]]; }) },
        // wrap screen frame header
        { t: 'box', mat: 'black', c: [0.20, 1.10, 0], s: [0.05, 0.03, 1.12] },
        // rear wing raised on its two posts (Weissach carbon blade, gently up-swept tips)
        { t: 'prism', mat: 'carbon', mirror: true, z0: 0.30, z1: 0.33, pts2d: [[-1.96, 1.02], [-2.08, 1.01], [-2.12, 1.10], [-2.0, 1.095]] },
        // door mirrors
        { t: 'prism', mat: 'mirror', mirror: true, z0: 0.80, z1: 0.96, pts2d: [[0.72, 0.89], [0.54, 0.895], [0.52, 0.96], [0.68, 0.97]] },
        { t: 'box', mat: 'black', mirror: true, c: [0.64, 0.86, 0.78], s: [0.05, 0.03, 0.08] }
      ],
      wing3d([{ z: 0, y: 1.088, x0: -1.94, x1: -2.27, t: 0.024 }, { z: 0.45, y: 1.092, x0: -1.95, x1: -2.27, t: 0.022 },
        { z: 0.66, y: 1.11, x0: -1.98, x1: -2.26, t: 0.018 }], 'carbon')
    ),
    exhaust: [],   // top pipes only (deck cylinders): nothing exits the rear bumper
    wheels: { style: 'split', spokes: 10 },
    notes: 'Porsche 918 Spyder (open top) — hand-authored low-poly. Reference photos: ' +
      'https://commons.wikimedia.org/wiki/File:2015_Porsche_918_Spyder_Platinum_Silver_Metallic_SCD_24.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:2014_Porsche_918_Spyder_-_Weissach_Package.jpg (front 3/4), ' +
      'https://commons.wikimedia.org/wiki/File:918_side_(14374138534).jpg (side), ' +
      'https://commons.wikimedia.org/wiki/File:2015_Porsche_918_Spyder_Rear_Quarter_LC24.jpg (rear 3/4); rear detail: File:Porsche_918_Spyder_rear.jpg, File:2015_Porsche_918_Spyder_in_Mexico_Blue_HCC_25_rear.jpg.'
  };
  reg('porsche-918-spyder', P918);

  LP.hyperA = { 'ferrari-sf90-stradale': SF90, 'mclaren-p1': P1, 'bugatti-chiron': CHIRON, 'koenigsegg-jesko': JESKO, 'porsche-918-spyder': P918 };
  if (typeof module !== 'undefined' && module.exports) module.exports = LP.hyperA;
})();

/* ==========================================================================
   Redline — js/derby/derby-arenas.js
   CB.derby.arenas : the six Demolition Derby arenas (docs/DERBY-SPEC.md §2) + pure geometry helpers.

     list() -> [def]   get(id) -> def|null   ids()
     sdBoundary(def, x, y) -> { d, nx, ny, edge, open }   d > 0 inside (distance to the wall), n = inward normal
     sdObstacle(o, x, y)   -> { d, nx, ny }                d > 0 outside, n = outward normal
     sdBox(cx, cy, hw, hh, rot, x, y) -> { d, nx, ny, u, v }
     heightAt(def, x, y, t?) -> { z, src: null|ramp|floor, nx?, ny? }   (drivable surface height; ramps + raised decks)
     hazardAt(def, x, y, t) -> { grip, drag, dps, ignite, crush, pit, kind, carry {vx, vy}, kick null|{x, y, strength, id, cycle} }
        carry = surface velocity of turntables {x, y, r, rIn?, omega} / conveyors {x, y, hw, hh, rot, speed} (m/s; add it to
        the car's ground velocity reference: tyres grip relative to the moving surface). kick = an active pusher pad
        {x, y, r, period, offset, dir 'out'|'center'|angle, strength (Δv m/s)}: apply once per (id, cycle).
     pusherActive(h, t) -> {on, cycle, phase}   carryAt(def, x, y)   turntableAngle(h, t)   pickupSpots(def) -> [{x, y}]
     crusherClosed(h, t) -> 0..1

   Zero dependencies, classic script, Node-loadable, deterministic (no Math.random).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  var PI = Math.PI;

  function ring(n, rx, ry, inset, phase, face) {
    // n spawn points on an ellipse-ish ring, facing the centre (face = 'in') or tangential
    var out = [];
    for (var i = 0; i < n; i++) {
      var a = phase + i / n * PI * 2;
      var x = Math.cos(a) * (rx - inset), y = Math.sin(a) * (ry - inset);
      var h = Math.atan2(-y, -x);
      if (face === 'tan') h = a + PI / 2;
      out.push({ x: +x.toFixed(2), y: +y.toFixed(2), heading: +h.toFixed(4) });
    }
    return out;
  }
  function circleOf(n, r, cx, cy, rr, h, kind, prefix) {
    var o = [];
    for (var i = 0; i < n; i++) {
      var a = i / n * PI * 2;
      o.push({ id: prefix + i, type: 'circle', x: +(cx + Math.cos(a) * r).toFixed(2), y: +(cy + Math.sin(a) * r).toFixed(2), r: rr, h: h, kind: kind });
    }
    return o;
  }

  /* ------------------------------------------------------------------ the arenas */
  var DEFS = [
    {
      id: 'mud-bowl', name: 'Mud Bowl', theme: 'mud', difficulty: 1, timeOfDay: 'dusk', weather: 'wet',
      tagline: 'The county-fair classic: an oval of churned dirt, concrete walls, tyre stacks.',
      desc: 'Classic oval derby bowl. Soft mud in the middle slows you down; the walls are hard concrete and the tyre stacks in the centre are perfect for pinning.',
      surface: { grip: 0.86, rolling: 0.03, color: '#5a4430', kind: 'dirt' },
      boundary: { type: 'ellipse', rx: 54, ry: 35 },
      wall: { height: 1.3, style: 'concrete', restitution: 0.32, friction: 0.35 },
      obstacles: [
        { id: 'ty0', type: 'circle', x: -14, y: 0, r: 1.9, h: 1.2, kind: 'tyres' },
        { id: 'ty1', type: 'circle', x: 14, y: 0, r: 1.9, h: 1.2, kind: 'tyres' },
        { id: 'ty2', type: 'circle', x: 0, y: 9, r: 1.6, h: 1.0, kind: 'tyres' },
        { id: 'ty3', type: 'circle', x: 0, y: -9, r: 1.6, h: 1.0, kind: 'tyres' }
      ],
      ramps: [
        { id: 'kw', x: -31, y: 0, hw: 2.6, hh: 2.4, rot: 0, h: 0.58, kind: 'kicker' },
        { id: 'ke', x: 31, y: 0, hw: 2.6, hh: 2.4, rot: PI, h: 0.58, kind: 'kicker' }
      ],
      floors: [],
      hazards: [
        { id: 'tt', type: 'turntable', x: 0, y: 0, r: 7, omega: 0.95 },
        { id: 'mud0', type: 'mud', x: -24, y: 17, r: 8, grip: 0.7, drag: 0.35 },
        { id: 'mud1', type: 'mud', x: 24, y: -17, r: 8, grip: 0.7, drag: 0.35 },
        { id: 'pw0', type: 'pusher', x: 0, y: 23, r: 3.2, period: 3.6, offset: 0, dir: 'center', strength: 9 },
        { id: 'pw1', type: 'pusher', x: 0, y: -23, r: 3.2, period: 3.6, offset: 1.8, dir: 'center', strength: 9 }
      ],
      pickupSpots: [[0, 13], [0, -13], [-20, 0], [20, 0], [-38, 12], [38, -12]],
      spawns: ring(12, 54, 35, 9, 0, 'in'),
      decor: { stands: 'oval', lights: 6, flags: true, crowd: 0.8, hay: true }
    },
    {
      id: 'figure-8', name: 'Figure-8 Crossover', theme: 'figure8', difficulty: 2, timeOfDay: 'day', weather: 'dry',
      tagline: 'Two loops, one deadly crossing. T-bones guaranteed.',
      desc: 'An asphalt figure-of-eight around two grassy islands. Every lap crosses the X in the middle — time it right for a T-bone, or get T-boned.',
      surface: { grip: 1.0, rolling: 0.018, color: '#3b3d42', kind: 'asphalt' },
      boundary: { type: 'roundrect', hw: 74, hh: 32, r: 30 },
      wall: { height: 1.1, style: 'barrier', restitution: 0.3, friction: 0.3 },
      obstacles: [
        { id: 'isl0', type: 'circle', x: -36, y: 0, r: 16, h: 0.6, kind: 'island' },
        { id: 'isl1', type: 'circle', x: 36, y: 0, r: 16, h: 0.6, kind: 'island' },
        { id: 'p0', type: 'box', x: 0, y: 26, hw: 4, hh: 1.2, rot: 0, h: 1.1, kind: 'barrier' },
        { id: 'p1', type: 'box', x: 0, y: -26, hw: 4, hh: 1.2, rot: 0, h: 1.1, kind: 'barrier' }
      ],
      ramps: [
        { id: 'jw', x: -10, y: 0, hw: 2.6, hh: 3.2, rot: 0, h: 0.58, kind: 'kicker' },
        { id: 'je', x: 10, y: 0, hw: 2.6, hh: 3.2, rot: PI, h: 0.58, kind: 'kicker' }
      ],
      floors: [],
      hazards: [
        { id: 'oilX', type: 'oil', x: 0, y: 0, r: 3.2, grip: 0.45, drag: 0.1 },
        { id: 'pxn', type: 'pusher', x: 0, y: 12, r: 3.0, period: 2.8, offset: 0, dir: -PI / 2, strength: 8 },
        { id: 'pxs', type: 'pusher', x: 0, y: -12, r: 3.0, period: 2.8, offset: 1.4, dir: PI / 2, strength: 8 }
      ],
      pickupSpots: [[0, 5], [0, -5], [-18, 14], [18, -14], [-18, -14], [18, 14]],
      spawns: (function () {
        var s = [];
        // six around each island, heading along the figure-8 direction (clockwise left loop, CCW right loop)
        for (var i = 0; i < 6; i++) {
          var a = PI * 0.25 + i / 6 * PI * 2;
          var xl = -36 + Math.cos(a) * 25, yl = Math.sin(a) * 25;
          s.push({ x: +xl.toFixed(2), y: +yl.toFixed(2), heading: +(a - PI / 2).toFixed(4) });
          var b = PI * 0.75 - i / 6 * PI * 2;
          var xr = 36 + Math.cos(b) * 25, yr = Math.sin(b) * 25;
          s.push({ x: +xr.toFixed(2), y: +yr.toFixed(2), heading: +(b + PI / 2).toFixed(4) });
        }
        return s;
      })(),
      decor: { stands: 'sides', lights: 4, flags: true, crowd: 0.7, crossing: true }
    },
    {
      id: 'junkyard', name: 'Junkyard Jamboree', theme: 'junkyard', difficulty: 3, timeOfDay: 'day', weather: 'dry',
      tagline: 'Scrap piles, rusty containers, kicker ramps — and a car crusher.',
      desc: 'A maze of scrap. Narrow alleys between containers, kicker ramps made of crushed cars, and a hydraulic crusher in the north-east corner that flattens anything caught inside.',
      surface: { grip: 0.9, rolling: 0.028, color: '#6b5a46', kind: 'sand' },
      boundary: { type: 'poly', pts: [[-58, -36], [-20, -40], [24, -38], [58, -34], [62, 0], [58, 36], [10, 40], [-30, 38], [-60, 32], [-64, 0]] },
      wall: { height: 2.4, style: 'scrap', restitution: 0.22, friction: 0.45 },
      obstacles: [
        { id: 'c0', type: 'box', x: -30, y: 14, hw: 6.1, hh: 1.25, rot: 0.15, h: 2.6, kind: 'container' },
        { id: 'c1', type: 'box', x: -30, y: -14, hw: 6.1, hh: 1.25, rot: -0.2, h: 2.6, kind: 'container' },
        { id: 'c2', type: 'box', x: 22, y: 16, hw: 6.1, hh: 1.25, rot: 1.45, h: 2.6, kind: 'container' },
        { id: 'c3', type: 'box', x: 0, y: -22, hw: 6.1, hh: 1.25, rot: 0.05, h: 2.6, kind: 'container' },
        { id: 'p0', type: 'box', x: -6, y: 12, hw: 3.2, hh: 2.6, rot: 0.6, h: 2.0, kind: 'car-pile' },
        { id: 'p1', type: 'box', x: 34, y: -12, hw: 3.4, hh: 2.4, rot: -0.4, h: 2.2, kind: 'car-pile' },
        { id: 'p2', type: 'box', x: -46, y: 0, hw: 2.6, hh: 3.6, rot: 0.1, h: 2.2, kind: 'car-pile' },
        { id: 's0', type: 'circle', x: 8, y: 2, r: 2.4, h: 2.0, kind: 'scrap' },
        { id: 's1', type: 'circle', x: -16, y: -30, r: 2.2, h: 1.8, kind: 'scrap' },
        { id: 's2', type: 'circle', x: 44, y: 22, r: 2.0, h: 1.6, kind: 'scrap' },
        { id: 'b0', type: 'circle', x: -52, y: 22, r: 0.7, h: 1.1, kind: 'barrel' },
        { id: 'b1', type: 'circle', x: -50, y: 24, r: 0.7, h: 1.1, kind: 'barrel' },
        { id: 'b2', type: 'circle', x: 50, y: -26, r: 0.7, h: 1.1, kind: 'barrel' }
      ],
      ramps: [
        { id: 'k0', x: -12, y: -6, hw: 3.2, hh: 2.2, rot: 0.0, h: 1.3, kind: 'kicker' },
        { id: 'k1', x: 18, y: -2, hw: 3.2, hh: 2.2, rot: PI, h: 1.3, kind: 'kicker' },
        { id: 'k2', x: -36, y: 26, hw: 3.0, hh: 2.0, rot: -0.2, h: 1.1, kind: 'kicker' }
      ],
      floors: [],
      hazards: [
        { id: 'crusher', type: 'crusher', x: 46, y: 26, hw: 5.5, hh: 4, rot: 0.55, period: 6, closed: 2.0, dmg: 1.0 },
        { id: 'belt', type: 'conveyor', x: 34.2, y: 19.3, hw: 6, hh: 2.4, rot: 0.55, speed: 4.5 },
        { id: 'pj', type: 'pusher', x: 4, y: -8, r: 3.0, period: 3.2, offset: 0.6, dir: 'out', strength: 9 },
        { id: 'fire0', type: 'fire', x: -50, y: -24, r: 1.6, dps: 0.06 },
        { id: 'oil0', type: 'oil', x: 4, y: 26, r: 4, grip: 0.4, drag: 0.1 }
      ],
      spawns: [
        { x: -52, y: -10, heading: 0.2 }, { x: 50, y: 6, heading: PI }, { x: -12, y: 30, heading: -1.4 }, { x: 10, y: -32, heading: 1.6 },
        { x: -40, y: -28, heading: 0.6 }, { x: 40, y: -26, heading: 2.4 }, { x: -48, y: 12, heading: -0.3 }, { x: 52, y: -12, heading: 2.9 },
        { x: -22, y: 0, heading: 0 }, { x: 28, y: 4, heading: PI }, { x: 0, y: 32, heading: -PI / 2 }, { x: -6, y: -34, heading: PI / 2 }
      ],
      pickupSpots: [[-2, 0], [12, -12], [-20, -24], [-16, 22], [28, -26], [36, 6]],
      decor: { cranes: [[-56, -30], [54, 32]], stacks: 18, fence: true, crowd: 0.35 }
    },
    {
      id: 'ice-rink', name: 'Frozen Rink', theme: 'ice', difficulty: 4, timeOfDay: 'night', weather: 'snow',
      tagline: 'A hockey rink under floodlights. Zero grip, maximum chaos.',
      desc: 'Studded tyres? Never heard of them. Momentum is everything on the ice: you will slide into the boards, and so will they.',
      surface: { grip: 0.36, rolling: 0.008, color: '#d9e8f2', kind: 'ice', traction: 1.9 },   // studded tyres: launch grip, slides in corners
      boundary: { type: 'roundrect', hw: 50, hh: 25, r: 11 },
      wall: { height: 1.2, style: 'glass', restitution: 0.42, friction: 0.12 },
      obstacles: [
        { id: 'g0', type: 'box', x: -42, y: 0, hw: 1.0, hh: 2.0, rot: 0, h: 1.2, kind: 'goal' },
        { id: 'g1', type: 'box', x: 42, y: 0, hw: 1.0, hh: 2.0, rot: 0, h: 1.2, kind: 'goal' },
        { id: 'z0', type: 'circle', x: 0, y: 0, r: 2.2, h: 1.4, kind: 'zamboni' }
      ],
      ramps: [],
      floors: [],
      hazards: [
        { id: 'slush0', type: 'mud', x: -20, y: 10, r: 5, grip: 1.6, drag: 0.4 },
        { id: 'slush1', type: 'mud', x: 20, y: -10, r: 5, grip: 1.6, drag: 0.4 },
        { id: 'zb', type: 'pusher', x: 0, y: 0, r: 5.5, period: 2.6, offset: 0, dir: 'out', strength: 8 },
        { id: 'ttw', type: 'turntable', x: -30, y: 0, r: 5, omega: -1.1 },
        { id: 'tte', type: 'turntable', x: 30, y: 0, r: 5, omega: 1.1 }
      ],
      pickupSpots: [[0, 10], [0, -10], [-16, 0], [16, 0], [-36, 14], [36, -14]],
      spawns: ring(12, 50, 25, 7, PI / 12, 'in'),
      decor: { stands: 'rink', lights: 8, crowd: 0.9, rinkLines: true }
    },
    {
      id: 'rooftop', name: 'Rooftop Car Park', theme: 'rooftop', difficulty: 5, timeOfDay: 'dusk', weather: 'dry',
      tagline: 'Level 9 of a multi-storey: ramps, an upper deck — and no barrier on the east side.',
      desc: 'A concrete car-park roof high above the city. Two ramps lead to an upper deck. The east edge and parts of the south edge have no barrier: push them off, but do not follow them down.',
      surface: { grip: 0.98, rolling: 0.02, color: '#77787a', kind: 'concrete' },
      boundary: { type: 'poly', pts: [[-56, -32], [-8, -32], [10, -32], [56, -32], [56, 32], [-56, 32]], open: [1, 3] },
      wall: { height: 1.0, style: 'barrier', restitution: 0.28, friction: 0.3 },
      obstacles: [
        { id: 'pl0', type: 'circle', x: -36, y: 14, r: 0.7, h: 3.2, kind: 'pillar' },
        { id: 'pl1', type: 'circle', x: -36, y: -14, r: 0.7, h: 3.2, kind: 'pillar' },
        { id: 'pl2', type: 'circle', x: 16, y: 16, r: 0.7, h: 3.2, kind: 'pillar' },
        { id: 'pl3', type: 'circle', x: 16, y: -16, r: 0.7, h: 3.2, kind: 'pillar' },
        { id: 'lift', type: 'box', x: -52, y: 26, hw: 4.2, hh: 6.2, rot: 0, h: 4, kind: 'block' }
      ],
      ramps: [
        { id: 'r0', x: -18, y: 20, hw: 8, hh: 3.6, rot: 0, h: 3.2, kind: 'deck' },
        { id: 'r1', x: -18, y: -20, hw: 8, hh: 3.6, rot: 0, h: 3.2, kind: 'deck' },
        { id: 'k0', x: 24, y: 0, hw: 2.6, hh: 2.4, rot: 0, h: 0.58, kind: 'kicker' }
      ],
      floors: [
        { id: 'upper', x: -2, y: 0, hw: 8, hh: 23.6, rot: 0, z: 3.2 }
      ],
      hazards: [
        { id: 'tt', type: 'turntable', x: 38, y: -2, r: 6.5, omega: 1.0 },
        { id: 'ps', type: 'pusher', x: 1, y: -27, r: 3.0, period: 4, offset: 0, dir: -PI / 2, strength: 8 },
        { id: 'pn', type: 'pusher', x: 36, y: 22, r: 3.0, period: 4, offset: 2, dir: 0, strength: 8 }
      ],
      pickupSpots: [[-2, 14], [-2, -14], [38, -2], [-30, 0], [30, 18], [30, -22]],
      spawns: [
        { x: -48, y: 0, heading: 0 }, { x: 46, y: 22, heading: PI }, { x: -40, y: -24, heading: 0.5 }, { x: 44, y: -22, heading: 2.6 },
        { x: -46, y: 14, heading: -0.3 }, { x: 34, y: 26, heading: -2.6 }, { x: -30, y: 4, heading: 0 }, { x: 48, y: 10, heading: PI },
        { x: -30, y: -6, heading: 0.1 }, { x: 24, y: -24, heading: 2.0 }, { x: -2, y: 8, heading: -PI / 2 }, { x: -2, y: -8, heading: PI / 2 }
      ],
      decor: { skyline: true, lampPosts: 8, parkingLines: true, crowd: 0 }
    },
    {
      id: 'colosseum', name: 'Night Colosseum', theme: 'colosseum', difficulty: 3, timeOfDay: 'night', weather: 'dry',
      tagline: 'Sand, stone and spotlights. The crowd wants blood.',
      desc: 'An ancient arena under sweeping spotlights. A ring of stone pillars, a gladiator statue in the centre and burning braziers that set careless cars alight.',
      surface: { grip: 0.84, rolling: 0.032, color: '#b89a6a', kind: 'sand' },
      boundary: { type: 'ellipse', rx: 46, ry: 37 },
      wall: { height: 3.2, style: 'stone', restitution: 0.25, friction: 0.4 },
      obstacles: circleOf(8, 22, 0, 0, 1.1, 4.5, 'pillar', 'pc').concat([
        { id: 'statue', type: 'circle', x: 0, y: 0, r: 3.0, h: 6, kind: 'statue' }
      ]),
      ramps: [],
      floors: [],
      hazards: [
        { id: 'br0', type: 'fire', x: 30, y: 16, r: 1.4, dps: 0.07 },
        { id: 'br1', type: 'fire', x: -30, y: -16, r: 1.4, dps: 0.07 },
        { id: 'br2', type: 'fire', x: -30, y: 16, r: 1.4, dps: 0.07 },
        { id: 'br3', type: 'fire', x: 30, y: -16, r: 1.4, dps: 0.07 },
        { id: 'pit0', type: 'mud', x: 0, y: 30, r: 4, grip: 0.75, drag: 0.4 },
        { id: 'tt', type: 'turntable', x: 0, y: 0, r: 12, rIn: 3.0, omega: -0.75 },
        { id: 'pc0', type: 'pusher', x: 34, y: 0, r: 3.0, period: 3.4, offset: 0, dir: 'center', strength: 9 },
        { id: 'pc1', type: 'pusher', x: -34, y: 0, r: 3.0, period: 3.4, offset: 1.7, dir: 'center', strength: 9 }
      ],
      pickupSpots: [[8, 8], [-8, -8], [-8, 8], [8, -8], [0, 28], [0, -28]],
      spawns: ring(12, 46, 37, 8, PI / 12, 'in'),
      decor: { stands: 'colosseum', spotlights: 6, crowd: 1, torches: 16 }
    }
  ];

  /* ------------------------------------------------------------------ derived: bounds */
  DEFS.forEach(function (d) {
    var b = d.boundary, minX, minY, maxX, maxY;
    if (b.type === 'ellipse') { minX = -b.rx; maxX = b.rx; minY = -b.ry; maxY = b.ry; }
    else if (b.type === 'roundrect') { minX = -b.hw; maxX = b.hw; minY = -b.hh; maxY = b.hh; }
    else {
      minX = minY = 1e9; maxX = maxY = -1e9;
      b.pts.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
      b.open = b.open || [];
    }
    d.bounds = { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    d.hazards.forEach(function (h) { if (h.type === 'crusher') { h.r = Math.hypot(h.hw, h.hh); } });
    d.obstacles.forEach(function (o) { o.br = o.type === 'circle' ? o.r : Math.hypot(o.hw, o.hh); });
  });

  /* ------------------------------------------------------------------ signed distances (pure) */
  function sdSegment(px, py, ax, ay, bx, by) {
    var ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-9;
    var t = ((px - ax) * ex + (py - ay) * ey) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var qx = ax + ex * t, qy = ay + ey * t;
    return { d: Math.hypot(px - qx, py - qy), qx: qx, qy: qy, t: t };
  }
  function pointInPoly(pts, x, y) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  /** rotated box: returns {d (>0 outside), nx, ny outward, u, v local} */
  function sdBox(cx, cy, hw, hh, rot, x, y) {
    var c = Math.cos(rot), s = Math.sin(rot);
    var dx = x - cx, dy = y - cy;
    var u = dx * c + dy * s, v = -dx * s + dy * c;
    var qx = Math.abs(u) - hw, qy = Math.abs(v) - hh;
    var d, lnx, lny;
    if (qx > 0 || qy > 0) {
      var ox = Math.max(qx, 0), oy = Math.max(qy, 0), l = Math.hypot(ox, oy) || 1e-9;
      d = l; lnx = ox / l * (u < 0 ? -1 : 1); lny = oy / l * (v < 0 ? -1 : 1);
    } else if (qx > qy) { d = qx; lnx = u < 0 ? -1 : 1; lny = 0; }
    else { d = qy; lnx = 0; lny = v < 0 ? -1 : 1; }
    return { d: d, nx: lnx * c - lny * s, ny: lnx * s + lny * c, u: u, v: v };
  }
  /** boundary SDF: d > 0 inside the arena (distance to the outline), n = inward normal */
  function sdBoundary(def, x, y) {
    var b = def.boundary;
    if (b.type === 'ellipse') {
      // distance approximation by one Newton-ish projection onto the ellipse (good near the wall)
      var rx = b.rx, ry = b.ry;
      var k0 = Math.hypot(x / rx, y / ry);
      if (k0 < 1e-6) return { d: Math.min(rx, ry), nx: 1, ny: 0, edge: -1, open: false };
      var k1 = Math.hypot(x / (rx * rx), y / (ry * ry));
      var d = (1 - k0) * k0 / k1;   // > 0 inside
      var gx = x / (rx * rx), gy = y / (ry * ry), gl = Math.hypot(gx, gy) || 1;
      return { d: d, nx: -gx / gl, ny: -gy / gl, edge: -1, open: false };
    }
    if (b.type === 'roundrect') {
      var r = b.r, ax = Math.abs(x), ay = Math.abs(y);
      var qx = ax - (b.hw - r), qy = ay - (b.hh - r);
      var dd, nx, ny;
      if (qx > 0 && qy > 0) { var l = Math.hypot(qx, qy) || 1e-9; dd = r - l; nx = -qx / l; ny = -qy / l; }
      else if (qx > qy) { dd = r - qx; nx = -1; ny = 0; }
      else { dd = r - qy; nx = 0; ny = -1; }
      return { d: dd, nx: nx * (x < 0 ? -1 : 1), ny: ny * (y < 0 ? -1 : 1), edge: -1, open: false };
    }
    var pts = b.pts, best = null, bi = -1;
    for (var i = 0; i < pts.length; i++) {
      var A = pts[i], B = pts[(i + 1) % pts.length];
      var sg = sdSegment(x, y, A[0], A[1], B[0], B[1]);
      if (!best || sg.d < best.d) { best = sg; bi = i; }
    }
    var inside = pointInPoly(pts, x, y);
    var ddp = inside ? best.d : -best.d;
    var vx = x - best.qx, vy = y - best.qy, vl = Math.hypot(vx, vy);
    var nnx, nny;
    if (vl > 1e-6) { nnx = vx / vl * (inside ? 1 : -1); nny = vy / vl * (inside ? 1 : -1); }
    else { var A2 = pts[bi], B2 = pts[(bi + 1) % pts.length], ex = B2[0] - A2[0], ey = B2[1] - A2[1], el = Math.hypot(ex, ey) || 1; nnx = -ey / el; nny = ex / el; }
    return { d: ddp, nx: nnx, ny: nny, edge: bi, open: (b.open || []).indexOf(bi) >= 0 };
  }
  /** obstacle SDF: d > 0 outside, n = outward normal */
  function sdObstacle(o, x, y) {
    if (o.type === 'circle') {
      var dx = x - o.x, dy = y - o.y, l = Math.hypot(dx, dy) || 1e-9;
      return { d: l - o.r, nx: dx / l, ny: dy / l };
    }
    return sdBox(o.x, o.y, o.hw, o.hh, o.rot || 0, x, y);
  }

  /** drivable surface height at (x, y): ramps rise 0 -> h along their local +x, raised floors are flat decks */
  function heightAt(def, x, y) {
    var z = 0, src = null;
    var fl = def.floors || [];
    for (var i = 0; i < fl.length; i++) {
      var f = fl[i], q = sdBox(f.x, f.y, f.hw, f.hh, f.rot || 0, x, y);
      if (q.d <= 0 && f.z > z) { z = f.z; src = f; }
    }
    var rp = def.ramps || [];
    for (var j = 0; j < rp.length; j++) {
      var r = rp[j], qb = sdBox(r.x, r.y, r.hw, r.hh, r.rot || 0, x, y);
      if (qb.d <= 0) {
        var hz = r.h * (qb.u + r.hw) / (2 * r.hw);
        if (hz > z) { z = hz; src = r; }
      }
    }
    return { z: z, src: src };
  }

  /** pusher pads fire for 0.3 s every `period` s: {on, cycle (integer, for debouncing one kick per firing), phase 0..1} */
  function pusherActive(h, t) {
    var per = h.period || 3, tt = (t || 0) + (h.offset || 0), cyc = Math.floor(tt / per), ph = tt - cyc * per;
    return { on: ph < 0.3, cycle: cyc, phase: ph / per, charge: ph / per };
  }
  /** surface carry velocity of moving platforms (turntables, conveyors) at a point */
  function carryAt(def, x, y) { var c = hazardAt(def, x, y, 0).carry; return { vx: c.vx, vy: c.vy }; }
  /** turntable rotation angle at time t (renderer) */
  function turntableAngle(h, t) { return (h.omega || 0) * (t || 0); }

  function crusherClosed(h, t) {
    var per = h.period || 9, cl = h.closed || 2, ph = ((t % per) + per) % per;
    // 0..1: 0 open; closes during [per - cl - 0.8, per - cl], stays shut cl, opens over 0.8 s
    var a = per - cl - 0.8;
    if (ph < a) return 0;
    if (ph < a + 0.8) return (ph - a) / 0.8;
    if (ph < per - 0.0001) return ph > per - 0.4 ? (per - ph) / 0.4 : 1;
    return 0;
  }

  /** hazards at a point (grip / drag multipliers, damage per second, ignition, crusher, pit) */
  function hazardAt(def, x, y, t) {
    var out = { grip: 1, drag: 0, dps: 0, ignite: 0, crush: 0, pit: false, kind: null, carry: { vx: 0, vy: 0 }, kick: null };
    var hz = def.hazards || [];
    for (var i = 0; i < hz.length; i++) {
      var h = hz[i];
      if (h.type === 'turntable') {
        var tx = x - h.x, ty = y - h.y, tr = Math.hypot(tx, ty);
        if (tr <= h.r && tr >= (h.rIn || 0)) { out.carry.vx += -h.omega * ty; out.carry.vy += h.omega * tx; out.kind = out.kind || 'turntable'; }
        continue;
      }
      if (h.type === 'conveyor') {
        if (sdBox(h.x, h.y, h.hw, h.hh, h.rot || 0, x, y).d <= 0) { out.carry.vx += Math.cos(h.rot || 0) * h.speed; out.carry.vy += Math.sin(h.rot || 0) * h.speed; out.kind = out.kind || 'conveyor'; }
        continue;
      }
      if (h.type === 'pusher') {
        if (Math.hypot(x - h.x, y - h.y) > h.r) continue;
        var pa = pusherActive(h, t || 0);
        out.kind = out.kind || 'pusher';
        if (pa.on) {
          var dx2, dy2;
          if (h.dir === 'out') { dx2 = x - h.x; dy2 = y - h.y; }
          else if (h.dir === 'center') { dx2 = -h.x; dy2 = -h.y; }
          else { dx2 = Math.cos(+h.dir || 0); dy2 = Math.sin(+h.dir || 0); }
          var dl = Math.hypot(dx2, dy2);
          if (dl < 1e-6) { dx2 = 1; dy2 = 0; dl = 1; }
          out.kick = { x: dx2 / dl, y: dy2 / dl, strength: h.strength || 8, id: h.id, cycle: pa.cycle };
        }
        continue;
      }
      if (h.type === 'crusher') {
        if (sdBox(h.x, h.y, h.hw, h.hh, h.rot || 0, x, y).d < 0) { var c = crusherClosed(h, t || 0); if (c > 0.6) { out.crush = Math.max(out.crush, c); out.kind = 'crusher'; } }
        continue;
      }
      var d = Math.hypot(x - h.x, y - h.y);
      if (d > h.r) continue;
      if (h.type === 'pit') { out.pit = true; out.kind = 'pit'; }
      else if (h.type === 'fire') { out.dps += h.dps || 0.05; out.ignite = 1; out.kind = 'fire'; }
      else { out.grip *= h.grip != null ? h.grip : 1; out.drag += h.drag || 0; out.kind = out.kind || h.type; }
    }
    return out;
  }

  var byId = {};
  DEFS.forEach(function (d) { byId[d.id] = d; });

  CB.derby.arenas = {
    list: function () { return DEFS.slice(); },
    get: function (id) { return byId[id] || null; },
    ids: function () { return DEFS.map(function (d) { return d.id; }); },
    DEFAULT: 'mud-bowl',
    sdBoundary: sdBoundary, sdObstacle: sdObstacle, sdBox: sdBox, sdSegment: sdSegment, pointInPoly: pointInPoly,
    heightAt: heightAt, hazardAt: hazardAt, crusherClosed: crusherClosed, pusherActive: pusherActive, carryAt: carryAt, turntableAngle: turntableAngle,
    pickupSpots: function (def) { return (def && def.pickupSpots) ? def.pickupSpots.map(function (p) { return { x: p[0], y: p[1] }; }) : []; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.arenas;
})();

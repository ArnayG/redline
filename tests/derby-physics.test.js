/* Demolition Derby physics (docs/DERBY-SPEC.md §4): impulse momentum conservation, restitution, no tunnelling at 60 m/s,
   floors / ramps, damage + accessory mass changing how the car drives, no NaNs. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, P = CB.derby.physics, A = CB.derby.arenas, D = CB.derby.damage, AC = CB.derby.accessories;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby physics: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
var SPEC = P.withMass(P.specFromBuild(CB.data.presetBuild('muscle')), 0);
var HATCH = P.withMass(P.specFromBuild(CB.data.presetBuild('hot-hatch')), 0);
function car(spec, pose, v) { var c = { spec: spec }; P.createBody(c, pose); c.dmg = D.create(); if (v) { c.vx = v[0]; c.vy = v[1]; c.w = v[2] || 0; } return c; }
function world(id) { return { arena: A.get(id || 'mud-bowl'), t: 0, cars: [] }; }
function momentum(cs) { var px = 0, py = 0; cs.forEach(function (c) { px += c.spec.mass * c.vx; py += c.spec.mass * c.vy; }); return [px, py]; }
function drive(c, w, inp, secs, mods) { for (var i = 0; i < secs * 120; i++) { w.t = i / 120; P.drive(w, c, inp, mods || {}, 1 / 120); } return c; }

test('specFromBuild: every preset gives a sane derby envelope', function () {
  CB.data.presets.forEach(function (p) {
    var s = P.specFromBuild(CB.data.presetBuild(p.id));
    assert.ok(s.mass > 700 && s.mass < 3300, p.id + ' mass');
    assert.ok(s.topSpeed >= 30 && s.topSpeed <= 44.1, p.id + ' top ' + s.topSpeed);
    assert.ok(s.accel >= 6.2 && s.accel <= 11.4, p.id + ' accel ' + s.accel);
    assert.ok(s.length > 3.4 && s.width > 1.5 && s.Iz > 0, p.id + ' dims');
    assert.ok(['front', 'mid', 'rear'].indexOf(s.enginePos) >= 0 && ['rwd', 'fwd', 'awd'].indexOf(s.drive) >= 0);
  });
});

test('car-car impulse conserves linear momentum exactly and angular momentum about the contact point', function () {
  // deterministic overlapping pairs: b within 2-3.4 m of a, any headings / velocities
  var cases = [];
  for (var q = 0; q < 40; q++) {
    var ang = q * 2.399, d = 2 + (q % 7) * 0.2;
    cases.push([[0, 0, q * 0.7], [Math.cos(q) * 12, Math.sin(q * 1.3) * 9, (q % 5) * 0.3 - 0.6], [Math.cos(ang) * d, Math.sin(ang) * d, q * 1.9], [-Math.cos(q * 0.7) * 10, Math.sin(q) * 5, 0.4 - (q % 3) * 0.4]]);
  }
  var collided = 0;
  cases.forEach(function (k, n) {
    var a = car(SPEC, { x: k[0][0], y: k[0][1], heading: k[0][2] }, k[1]), b = car(HATCH, { x: k[2][0], y: k[2][1], heading: k[2][2] }, k[3]);
    var m0 = momentum([a, b]);
    var pos = [[a.x, a.y], [b.x, b.y]];
    var ct = P.collideCars(a, b, { restitution: 0.22, friction: 0.35 });
    if (!ct) return;
    collided++;
    var m1 = momentum([a, b]);
    assert.ok(Math.abs(m1[0] - m0[0]) < 1e-6 * (1 + Math.abs(m0[0])) && Math.abs(m1[1] - m0[1]) < 1e-6 * (1 + Math.abs(m0[1])), 'linear momentum case ' + n);
    // angular momentum about the contact point (impulse applied there exerts no torque about it)
    function L(cs, vel) { var s = 0; cs.forEach(function (c, i) { var rx = pos[i][0] - ct.px, ry = pos[i][1] - ct.py; s += c.spec.Iz * vel[i][2] + c.spec.mass * (rx * vel[i][1] - ry * vel[i][0]); }); return s; }
    var before = L([a, b], [k[1], k[3]]), after = L([a, b], [[a.vx, a.vy, a.w], [b.vx, b.vy, b.w]]);
    assert.ok(Math.abs(after - before) < 1e-6 * (1 + Math.abs(before)) + 1e-6, 'angular momentum case ' + n + ': ' + before + ' -> ' + after);
    assert.ok(ct.energy >= 0 && ct.vn >= 0 && isFinite(ct.j));
  });
  assert.ok(collided >= 25, 'pairs that collided: ' + collided);
});

test('restitution: without friction the normal separation speed is exactly e x the closing speed; kinetic energy never grows', function () {
  [0, 0.2, 0.5].forEach(function (e) {
    var a = car(SPEC, { x: 0, y: 0, heading: 0 }, [10, 0, 0]), b = car(SPEC, { x: 4.5, y: 0, heading: 0 }, [-5, 0, 0]);
    var ke0 = 0.5 * SPEC.mass * (100 + 25);
    var ct = P.collideCars(a, b, { restitution: e, friction: 0 });
    var vnAfter = (b.vx - a.vx) * ct.nx + (b.vy - a.vy) * ct.ny;
    assert.ok(Math.abs(vnAfter - e * 15) < 1e-6, 'e=' + e + ' vn ' + vnAfter);
    var ke1 = 0.5 * SPEC.mass * (a.vx * a.vx + a.vy * a.vy + b.vx * b.vx + b.vy * b.vy) + 0.5 * SPEC.Iz * (a.w * a.w + b.w * b.w);
    assert.ok(ke1 <= ke0 + 1e-6);
  });
  // with friction (the game setting) energy is lost, never created
  for (var k = 0; k < 20; k++) {
    var a2 = car(SPEC, { x: 0, y: 0, heading: k * 0.3 }, [10 * Math.cos(k), 8 * Math.sin(k), k % 3 - 1]), b2 = car(HATCH, { x: 3.2, y: 1.6 * Math.sin(k * 7), heading: -k }, [-4, 2, 0]);
    var ke = function (c) { return 0.5 * c.spec.mass * (c.vx * c.vx + c.vy * c.vy) + 0.5 * c.spec.Iz * c.w * c.w; };
    var e0 = ke(a2) + ke(b2);
    if (P.collideCars(a2, b2, { restitution: 0.2, friction: 0.35 })) assert.ok(ke(a2) + ke(b2) <= e0 + 1e-6, 'friction case ' + k);
  }
});

test('no tunnelling: 60 m/s into the walls and obstacles of every arena, 24 directions each', function () {
  A.ids().forEach(function (id) {
    var ar = A.get(id), w = { arena: ar, t: 0, cars: [] };
    var start = [[0, 0], [0, -12], [-20, -25], [20, 20], [30, 8]].filter(function (p) {
      return A.sdBoundary(ar, p[0], p[1]).d > 4 && ar.obstacles.every(function (o) { return A.sdObstacle(o, p[0], p[1]).d > 3; }) && A.heightAt(ar, p[0], p[1]).z === 0;
    })[0];
    assert.ok(start, id + ' has a clear start');
    for (var k = 0; k < 24; k++) {
      var ang = k / 24 * Math.PI * 2;
      var c = car(SPEC, { x: start[0], y: start[1], heading: ang }, [Math.cos(ang) * 60, Math.sin(ang) * 60, 0]);
      for (var i = 0; i < 300; i++) {
        w.t = i / 120; P.drive(w, c, { throttle: 1 }, { accelMult: 1.65, topMult: 1.2 }, 1 / 120); P.collideArena(w, c);
        assert.ok(isFinite(c.x + c.y + c.vx + c.vy + c.w + c.z), id + ' NaN');
        if (c.overOpen) break;
        var b = A.sdBoundary(ar, c.x, c.y);
        assert.ok(b.open || b.d > -1.2, id + ' through the wall at ' + Math.round(ang * 57.3) + ' deg');
        for (var j = 0; j < ar.obstacles.length; j++) {
          var o = ar.obstacles[j];
          if (c.z < o.h) assert.ok(A.sdObstacle(o, c.x, c.y).d > -0.9, id + ' through ' + o.id + ' at ' + Math.round(ang * 57.3) + ' deg');
        }
      }
    }
  });
});

test('no tunnelling: a 60 m/s car always hits a parked car on its path (any angle)', function () {
  var w = world('figure-8');
  for (var off = -1.25; off <= 1.25; off += 0.25) {
    for (var k = 0; k < 12; k++) {
      var a = car(SPEC, { x: -14, y: -14, heading: 0 }, [60, 0, 0]), b = car(SPEC, { x: 0, y: -14 + off, heading: k / 12 * Math.PI });
      var hit = false;
      for (var i = 0; i < 90; i++) { P.drive(w, a, {}, {}, 1 / 120); P.drive(w, b, {}, {}, 1 / 120); if (P.collideCars(a, b, {})) hit = true; }
      assert.ok(hit, 'hit off ' + off + ' ang ' + k);
      assert.ok(!(a.x > b.x + 3 && Math.hypot(b.vx, b.vy) < 1), 'passed through off ' + off + ' ang ' + k);
    }
  }
});

test('drive envelope: accelerates, tops out in the derby range, reverses, turns both ways', function () {
  var w = world('mud-bowl');
  var c = drive(car(SPEC, { x: -30, y: -25, heading: 0 }), w, { throttle: 1 }, 2);
  assert.ok(c.speed > 7.5 && c.speed < 16, '2 s from rest: ' + c.speed);
  c = drive(car(SPEC, { x: -30, y: -25, heading: 0 }), w, { throttle: 1 }, 15);
  assert.ok(c.speed > 27 && c.speed <= SPEC.topSpeed + 0.5, 'top ' + c.speed);
  c = drive(car(SPEC, { x: -30, y: -25, heading: 0 }), w, { brake: 1 }, 2);
  assert.ok(c.u < -4 && c.gear === -1, 'reverse ' + c.u);
  var l = drive(car(SPEC, { x: -30, y: -25, heading: 0 }), w, { throttle: 0.7, steer: 1 }, 1.5);
  var r = drive(car(SPEC, { x: -30, y: -25, heading: 0 }), w, { throttle: 0.7, steer: -1 }, 1.5);
  assert.ok(l.heading > 0.4 && r.heading < -0.4, 'turns ' + l.heading + ' / ' + r.heading);
  // full lock + full throttle from rest makes progress (no power-donut on the spot)
  var d = drive(car(SPEC, { x: -30, y: -25, heading: 0 }), w, { throttle: 1, steer: 1 }, 2);
  assert.ok(d.speed > 4, 'lock launch ' + d.speed);
});

test('damage changes the drive: engine zone -> accel / top speed, wheels -> grip + drag, side -> steering pull', function () {
  var w = world('mud-bowl');
  function run(prep, inp, secs) {
    var c = car(SPEC, { x: -30, y: -25, heading: 0 });
    if (prep) prep(c);
    return drive(c, w, inp, secs, D.effects(c));
  }
  var base = run(null, { throttle: 1 }, 3), front = run(function (c) { c.dmg.zones.front = 0.8; }, { throttle: 1 }, 3);
  assert.ok(front.speed < base.speed * 0.8, 'wrecked engine accel ' + front.speed + ' vs ' + base.speed);
  var topB = run(null, { throttle: 1 }, 14).speed, topW = run(function (c) { c.dmg.wheels = [0.8, 0.8, 0.8, 0.8]; c.dmg.punct = [true, true, true, true]; }, { throttle: 1 }, 14).speed;
  assert.ok(topW < topB * 0.85, 'punctures cut top speed ' + topW + ' vs ' + topB);
  // a crumpled left side pulls the car left with the wheel straight; the pristine car tracks straight
  var str = run(null, { throttle: 0.8 }, 3), pullL = run(function (c) { c.dmg.zones.left = 0.9; }, { throttle: 0.8 }, 3), pullR = run(function (c) { c.dmg.zones.right = 0.9; }, { throttle: 0.8 }, 3);
  assert.ok(Math.abs(str.heading) < 0.01, 'straight ' + str.heading);
  assert.ok(pullL.heading > 0.08 && pullR.heading < -0.08, 'pull ' + pullL.heading + ' / ' + pullR.heading);
  // a lost front wheel: big drag + pull to that side
  var lost = run(function (c) { c.dmg.wheels[1] = 1; c.dmg.wheelLost[1] = true; }, { throttle: 1 }, 4);
  assert.ok(lost.speed < base.speed * 1.05 && Math.abs(lost.heading) > 0.05, 'lost wheel ' + lost.speed + ' h ' + lost.heading);
  // turn rate: crumpled sides reduce the steering lock
  var t0 = run(null, { throttle: 0.6, steer: 1 }, 1.2).heading, t1 = run(function (c) { c.dmg.zones.left = 1; c.dmg.zones.right = 1; }, { throttle: 0.6, steer: 1 }, 1.2).heading;
  assert.ok(t1 < t0 * 0.9, 'lock ' + t1 + ' vs ' + t0);
  // effects are monotonic in damage
  var prev = null;
  [0, 0.25, 0.5, 0.75, 1].forEach(function (d) {
    var c = car(SPEC, { x: 0, y: 0, heading: 0 }); c.dmg.zones.front = d; c.dmg.zones.left = d; c.dmg.wheels = [d, d, d, d];
    var e = D.effects(c);
    if (prev) { assert.ok(e.powerMult <= prev.powerMult + 1e-9 && e.topMult <= prev.topMult + 1e-9 && e.steerLockMult <= prev.steerLockMult + 1e-9 && e.gripMult[0] <= prev.gripMult[0] + 1e-9); }
    prev = e;
  });
});

test('accessory mass: armour + ram make the car slower off the line, nitro mods add drive', function () {
  var w = world('mud-bowl');
  var light = P.withMass(SPEC, 0), heavy = P.withMass(SPEC, AC.massOf(['armour', 'ram']), AC.reachOf(['armour', 'ram']));
  assert.ok(heavy.mass === SPEC.baseMass + 360 && heavy.reachF === 1);
  var a = drive(car(light, { x: -30, y: -25, heading: 0 }), w, { throttle: 1 }, 6), b = drive(car(heavy, { x: -30, y: -25, heading: 0 }), w, { throttle: 1 }, 6);
  assert.ok(b.speed < a.speed * 0.97, 'heavy ' + b.speed + ' vs ' + a.speed);
  var n = drive(car(light, { x: -30, y: -25, heading: 0 }), w, { throttle: 1 }, 6, { accelMult: 1.65, topMult: 1.2 }), m = drive(car(light, { x: -30, y: -25, heading: 0 }), w, { throttle: 1 }, 6);
  assert.ok(n.speed > m.speed * 1.08, 'nitro ' + n.speed + ' vs ' + m.speed);
});

test('rooftop: the deck ramps climb to the upper deck, its edge drops you to the lower level, the east edge is open', function () {
  var ar = A.get('rooftop'), w = { arena: ar, t: 0, cars: [] };
  // up ramp r0 (x -26..-10 at y 20) heading east
  var c = car(SPEC, { x: -32, y: 20, heading: 0 }, [12, 0, 0]);
  var maxZ = 0;
  for (var i = 0; i < 120 * 4; i++) { w.t = i / 120; P.drive(w, c, { throttle: 0.6 }, {}, 1 / 120); P.collideArena(w, c); maxZ = Math.max(maxZ, c.z); if (c.x > -4) break; }
  assert.ok(maxZ > 3 && c.x > -6, 'reached the deck: z ' + maxZ.toFixed(2) + ' x ' + c.x.toFixed(1));
  // drive off the deck's east side (x = 6): falls to z 0, lands on the floor (not overOpen)
  for (i = 0; i < 120 * 4; i++) { w.t = i / 120; P.drive(w, c, { throttle: 0.5 }, {}, 1 / 120); P.collideArena(w, c); if (c.x > 9 && !c.airborne) break; }
  assert.ok(c.z < 0.2 && !c.overOpen && c.x > 8, 'dropped to the lower level z ' + c.z);
  // the lower level cannot drive into the deck side (step wall)
  var s = car(SPEC, { x: 14, y: 0, heading: Math.PI }, [-14, 0, 0]);
  for (i = 0; i < 120 * 2; i++) { w.t = i / 120; P.drive(w, s, { throttle: 1 }, {}, 1 / 120); P.collideArena(w, s); }
  assert.ok(s.x > 6 - 0.2 && s.z < 0.6, 'deck side is a wall: x ' + s.x.toFixed(2));
  // the open east edge: no wall, the car falls
  var f = car(SPEC, { x: 45, y: 0, heading: 0 }, [15, 0, 0]);
  for (i = 0; i < 120 * 3; i++) { w.t = i / 120; P.drive(w, f, { throttle: 1 }, {}, 1 / 120); P.collideArena(w, f); }
  assert.ok(f.x > 56 && f.z < -6 && f.overOpen, 'fell off the open edge z ' + f.z.toFixed(1));
  // a closed wall stops it (north)
  var n = car(SPEC, { x: 0, y: 26, heading: Math.PI / 2 }, [0, 15, 0]);
  for (i = 0; i < 120 * 2; i++) { w.t = i / 120; P.drive(w, n, { throttle: 1 }, {}, 1 / 120); P.collideArena(w, n); }
  assert.ok(n.y < 32 && n.z > -0.1, 'north wall holds');
});

test('kicker ramps launch the car into the air and it lands on its wheels', function () {
  var ar = A.get('junkyard'), w = { arena: ar, t: 0, cars: [] };
  var c = car(SPEC, { x: -24, y: -6, heading: 0 }, [18, 0, 0]);
  var air = 0, peak = 0;
  for (var i = 0; i < 120 * 3; i++) { w.t = i / 120; P.drive(w, c, { throttle: 0.5 }, {}, 1 / 120); P.collideArena(w, c); if (c.airborne) air += 1 / 120; peak = Math.max(peak, c.z); }
  assert.ok(air > 0.2 && peak > 1.2, 'air ' + air.toFixed(2) + ' peak ' + peak.toFixed(2));
  assert.ok(!c.airborne && !c.flipped && Math.abs(c.roll) < 0.3);
});

test('raycast sees walls, obstacles, open edges and (with z) raised decks', function () {
  var w = { arena: A.get('mud-bowl'), t: 0, cars: [] };
  var r = P.raycast(w, 0, -20, 1, 0, 80);
  assert.strictEqual(r.kind, 'wall');
  r = P.raycast(w, -25, 0, 1, 0, 30);
  assert.strictEqual(r.kind, 'obstacle');
  var wr = { arena: A.get('rooftop'), t: 0, cars: [] };
  assert.strictEqual(P.raycast(wr, 40, 0, 1, 0, 30).kind, 'edge');
  assert.strictEqual(P.raycast(wr, 14, 0, -1, 0, 20, null, 0).kind, 'wall');
  assert.notStrictEqual(P.raycast(wr, 14, 0, -1, 0, 20).kind, 'wall');
});

test('moving ground: a parked car rides a turntable (tyres grip relative to the platform), off it nothing moves', function () {
  var w = world('mud-bowl');
  var tt = (w.arena.hazards || []).filter(function (h) { return h.type === 'turntable'; })[0];
  if (!tt) return;   // arena without a turntable
  var c = car(SPEC, { x: tt.x + tt.r * 0.6, y: tt.y, heading: 0 });
  var h0 = c.heading;
  drive(c, w, { throttle: 0, brake: 0, steer: 0 }, 1);
  var expect = Math.abs(tt.omega) * tt.r * 0.6;
  assert.ok(Math.abs(c.vy) > expect * 0.5 && Math.sign(c.vy) === Math.sign(tt.omega), 'carried vy ' + c.vy + ' expect ~' + expect);
  assert.ok(Math.abs(c.heading - h0) > 0.3, 'turned with the platform ' + (c.heading - h0));
  var off = car(SPEC, { x: -40, y: -20, heading: 0 });
  drive(off, w, { throttle: 0, brake: 0, steer: 0 }, 1);
  assert.ok(off.speed < 0.05, 'parked off the platform');
});

test('ram push (mods.push) surges forward beyond the traction-limited drive', function () {
  var w = world('mud-bowl');
  var a = car(SPEC, { x: -40, y: -20, heading: 0 }), b = car(SPEC, { x: -40, y: -26, heading: 0 });
  drive(a, w, { throttle: 1 }, 1.2);
  drive(b, w, { throttle: 1 }, 1.2, { push: 3.2, accelMult: 1.8, topMult: 1.25 });
  assert.ok(b.speed > a.speed * 1.3, 'boosted ' + b.speed + ' vs ' + a.speed);
  // fun pass: strong cars reach 80 km/h in about 2-3.5 s
  var m = car(SPEC, { x: -40, y: -14, heading: 0 }), t = 0;
  while (m.speed < 80 / 3.6 && t < 6) { P.drive(w, m, { throttle: 1 }, {}, 1 / 120); t += 1 / 120; }
  assert.ok(t < 3.6, '0-80 ' + t.toFixed(2) + ' s');
});

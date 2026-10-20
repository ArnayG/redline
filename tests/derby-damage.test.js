/* Demolition Derby damage model (docs/DERBY-SPEC.md §5): zone attribution by impact point, energy -> damage, wheels,
   parts / dents, engine (front vs mid / rear engined), overheating -> fire, stall, repair, serialisation. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, P = CB.derby.physics, D = CB.derby.damage;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby damage: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function mk(preset, heading) {
  var c = { spec: P.withMass(P.specFromBuild(CB.data.presetBuild(preset || 'muscle')), 0) };
  P.createBody(c, { x: 10, y: -5, heading: heading || 0 });
  c.dmg = D.create();
  return c;
}
/** world point at car-local (lx forward, ly left) */
function at(c, lx, ly) { var w = P.toWorld(c, lx, ly); return w; }
function hit(c, lx, ly, vn, opts) {
  var p = at(c, lx, ly);
  // contact normal points from the car toward the other (outward)
  var nl = Math.hypot(lx, ly) || 1, ch = Math.cos(c.heading), sh = Math.sin(c.heading);
  var nx = (lx / nl) * ch - (ly / nl) * sh, ny = (lx / nl) * sh + (ly / nl) * ch;
  return D.apply(c, { px: p.x, py: p.y, nx: nx, ny: ny, vn: vn }, Object.assign({ share: 0.5, rng: function () { return 0.99; } }, opts || {}));
}

test('zone attribution: front / rear / left / right by the impact point, for any car heading', function () {
  [0, 1.1, -2.5, Math.PI].forEach(function (h) {
    var c = mk('muscle', h), L = c.spec.length / 2, W = c.spec.width / 2;
    assert.strictEqual(D.zoneOf(c, at(c, L, 0).x, at(c, L, 0).y).zone, 'front');
    assert.strictEqual(D.zoneOf(c, at(c, -L, 0.2).x, at(c, -L, 0.2).y).zone, 'rear');
    assert.strictEqual(D.zoneOf(c, at(c, 0.3, W).x, at(c, 0.3, W).y).zone, 'left');
    assert.strictEqual(D.zoneOf(c, at(c, -0.5, -W).x, at(c, -0.5, -W).y).zone, 'right');
    // a corner splits between its two zones and loads the nearest wheel
    var q = D.zoneOf(c, at(c, L, W).x, at(c, L, W).y);
    assert.ok(q.weights.front > 0.2 && q.weights.left > 0.2 && q.weights.rear === 0 && q.weights.right === 0, JSON.stringify(q.weights));
    var wl = D.zoneOf(c, at(c, c.spec.a, W).x, at(c, c.spec.a, W).y);
    assert.strictEqual(wl.wheel, 0); assert.ok(wl.wheelW > 0.8, 'front-left wheel ' + wl.wheelW);
    var rr = D.zoneOf(c, at(c, -c.spec.b, -W).x, at(c, -c.spec.b, -W).y);
    assert.strictEqual(rr.wheel, 3); assert.ok(rr.wheelW > 0.8);
    var mid = D.zoneOf(c, at(c, 0, W).x, at(c, 0, W).y);
    assert.ok(mid.wheelW < 0.2, 'door hit spares the wheels ' + mid.wheelW);
  });
});

test('energy -> damage: nothing below the threshold, grows with speed, sides are weaker than the nose', function () {
  var c = mk();
  assert.strictEqual(hit(c, c.spec.length / 2, 0, 2.0).pts, 0);
  assert.strictEqual(c.dmg.health, 1);
  var prev = 0;
  [5, 10, 15, 20, 25].forEach(function (v) {
    var f = mk(); hit(f, f.spec.length / 2, 0, v);
    assert.ok(f.dmg.zones.front > prev, 'front at ' + v); prev = f.dmg.zones.front;
  });
  var f2 = mk(), s2 = mk();
  hit(f2, f2.spec.length / 2, 0, 15); hit(s2, 0, s2.spec.width / 2, 15);
  assert.ok(s2.dmg.zones.left > f2.dmg.zones.front * 1.2, 'side ' + s2.dmg.zones.left + ' vs front ' + f2.dmg.zones.front);
  // the lighter car (bigger share) takes more
  var l = mk(), h = mk();
  hit(l, l.spec.length / 2, 0, 15, { share: 0.65 }); hit(h, h.spec.length / 2, 0, 15, { share: 0.35 });
  assert.ok(l.dmg.health < h.dmg.health);
  // walls hurt less than an equal-speed car-car hit (a 20 m/s wall < 20 % health)
  var w = mk(); hit(w, w.spec.length / 2, 0, 20, { wall: true });
  assert.ok(1 - w.dmg.health < 0.2 && 1 - w.dmg.health > 0.04, 'wall ' + (1 - w.dmg.health));
  // accessory / difficulty multiplier
  var m = mk(); hit(m, m.spec.length / 2, 0, 15, { mult: 0.5 });
  assert.ok(Math.abs((1 - m.dmg.health) - (1 - f2.dmg.health) * 0.5) < 1e-9);
});

test('a car survives roughly 12-32 solid hits (fun pass: cars crumple long before they die); destroyed zones hurt more (overflow)', function () {
  var c = mk(), n = 0, zs = ['front', 'left', 'rear', 'right'];
  while (c.dmg.health > 0 && n < 60) {
    var z = zs[n % 4], L = c.spec.length / 2, W = c.spec.width / 2;
    hit(c, z === 'front' ? L : z === 'rear' ? -L : 0, z === 'left' ? W : z === 'right' ? -W : 0, 13);
    n++;
  }
  assert.ok(n >= 12 && n <= 32, 'hits to wreck ' + n);
  var a = mk(), b = mk();
  a.dmg.zones.front = 1;
  var ha = 1 - hit(a, a.spec.length / 2, 0, 12).healthLoss, hb = 1 - hit(b, b.spec.length / 2, 0, 12).healthLoss;
  assert.ok(ha < hb, 'overflow ' + ha + ' vs ' + hb);
});

test('wheels: corner hits bend, puncture and finally rip a wheel off (events)', function () {
  var c = mk(), W = c.spec.width / 2, evs = [];
  for (var i = 0; i < 6 && !c.dmg.wheelLost[0]; i++) evs = evs.concat(hit(c, c.spec.a, W, 16).events);
  assert.ok(c.dmg.punct[0] && c.dmg.wheelLost[0], 'wheel ' + c.dmg.wheels[0]);
  var types = evs.map(function (e) { return e.type; });
  assert.ok(types.indexOf('puncture') >= 0 && types.indexOf('wheel-off') >= 0, types.join(','));
  assert.strictEqual(c.dmg.wheels[3], 0, 'other wheels untouched');
});

test('parts and dents: lights break, bumpers / hood / doors come off; dents are local, inward and capped', function () {
  var c = mk(), L = c.spec.length / 2, W = c.spec.width / 2, evs = [];
  for (var i = 0; i < 4; i++) evs = evs.concat(hit(c, L, 0.4, 14).events);
  assert.ok(c.dmg.parts.lightFL && c.dmg.parts.bumperF, JSON.stringify(c.dmg.parts));
  assert.ok(!c.dmg.parts.bumperR && !c.dmg.parts.doorL);
  assert.ok(evs.some(function (e) { return e.type === 'part-off' && e.part === 'bumperF'; }));
  var d = c.dmg.dents[0];
  assert.ok(d && d.x > 1.5 && d.nx < -0.9 && d.depth > 0 && d.depth <= 0.42 && d.seq > 0, JSON.stringify(d));
  for (i = 0; i < 6; i++) hit(c, 0, W, 14);
  assert.ok(c.dmg.parts.doorL);
  var ld = c.dmg.dents.filter(function (q) { return q.y > 0.8; })[0];
  assert.ok(ld && ld.ny < -0.9, 'left dent pushes right (inward)');
  // many hits: dents stay <= 48 and dentSeq increases
  var seq = c.dmg.dentSeq, g = mk();
  for (i = 0; i < 120; i++) hit(g, (i % 9 - 4) * 0.5, (i % 2 ? 1 : -1) * W, 6 + (i % 5));
  assert.ok(g.dmg.dents.length <= 48 && g.dmg.dentSeq > 48);
  assert.ok(c.dmg.dentSeq >= seq);
});

test('engine zone: front-engined cars lose power from nose damage, mid-engined from the tail', function () {
  var fr = mk('muscle'), mid = mk('huracan-evo');
  assert.strictEqual(D.engineZone(fr), 'front'); assert.strictEqual(D.engineZone(mid), 'rear');
  fr.dmg.zones.front = 0.9; mid.dmg.zones.front = 0.9;
  D._.updateEngine(fr); D._.updateEngine(mid);
  assert.ok(D.effects(fr).powerMult < 0.6, 'front-engined ' + D.effects(fr).powerMult);
  assert.ok(D.effects(mid).powerMult > 0.75 && D.effects(mid).powerMult > D.effects(fr).powerMult + 0.25, 'mid-engined nose hit ' + D.effects(mid).powerMult);
  mid.dmg.zones.rear = 0.9; D._.updateEngine(mid);
  assert.ok(D.effects(mid).powerMult < 0.5, 'mid-engined tail ' + D.effects(mid).powerMult);
  // rear damage hurts the drive axle of a RWD car more than of a FWD one
  var r = mk('muscle'), f = mk('hot-hatch');
  r.dmg.zones.rear = 0.8; f.dmg.zones.rear = 0.8;
  assert.ok(D.effects(r).powerMult < D.effects(f).powerMult);
});

test('overheating -> engine fire -> health drains; dead engine stalls; smoke turns black', function () {
  var c = mk();
  c.dmg.zones.front = 0.95;
  var evs = [], t;
  for (t = 0; t < 120 * 40; t++) evs = evs.concat(D.tick(c, 1 / 120, { throttle: 1, rng: function () { return 0.5; } }));
  assert.ok(c.dmg.engine.temp > 0.95, 'temp ' + c.dmg.engine.temp);
  assert.ok(evs.some(function (e) { return e.type === 'fire' && e.engine; }), 'engine fire');
  assert.ok(c.dmg.health < 0.95, 'fire burns ' + c.dmg.health);
  assert.ok(c.dmg.engine.black > 0.9 && c.dmg.engine.smoke > 0.5);
  assert.ok(!c.dmg.engine.stalled, 'not stalled while the car is otherwise healthy');
  c.dmg.zones.front = 1; c.dmg.health = 0.3;
  evs = D.tick(c, 1 / 120, { throttle: 0 });
  assert.ok(c.dmg.engine.stalled && evs.some(function (e) { return e.type === 'stall'; }));
  assert.ok(D.effects(c).noDrive && D.effects(c).powerMult === 0);
  // a pristine engine cools down
  var k = mk(); k.dmg.engine.temp = 0.8;
  for (t = 0; t < 120 * 10; t++) D.tick(k, 1 / 120, { throttle: 1 });
  assert.ok(k.dmg.engine.temp < 0.6);
});

test('body fire burns out; fuel leaks from a crushed tail', function () {
  var c = mk();
  c.dmg.onFire = 0.7; c.dmg.burnT = 3;
  for (var t = 0; t < 120 * 8; t++) D.tick(c, 1 / 120, {});
  assert.ok(c.dmg.health < 0.97 && c.dmg.health > 0.6, 'burn ' + c.dmg.health);
  assert.ok(c.dmg.onFire < 0.2, 'burns out ' + c.dmg.onFire);
  var r = mk();
  hit(r, -r.spec.length / 2, 0, 24); hit(r, -r.spec.length / 2, 0, 24);
  assert.ok(r.dmg.fuelLeak > 0, 'leak ' + r.dmg.zones.rear);
});

test('repair kit: heals, straightens zones, puts out fires, re-inflates (lost wheels stay lost)', function () {
  var c = mk();
  c.dmg.health = 0.3; c.dmg.zones = { front: 0.9, rear: 0.5, left: 0.3, right: 0.1 }; c.dmg.onFire = 0.8; c.dmg.engine.fire = 0.5;
  c.dmg.wheels = [0.8, 1, 0, 0]; c.dmg.punct = [true, true, false, false]; c.dmg.wheelLost = [false, true, false, false];
  D.repair(c, 0.35);
  assert.ok(Math.abs(c.dmg.health - 0.65) < 1e-9 && Math.abs(c.dmg.zones.front - 0.5) < 1e-9 && c.dmg.zones.right === 0);
  assert.ok(c.dmg.onFire === 0 && c.dmg.engine.fire === 0 && !c.dmg.punct[0] && c.dmg.wheelLost[1]);
});

test('serialize / restore round-trips the whole damage state as JSON', function () {
  var c = mk(), L = c.spec.length / 2;
  hit(c, L, 0.5, 18); hit(c, 0, -c.spec.width / 2, 12);
  var s = JSON.stringify(D.serialize(c.dmg));
  var r = D.restore(JSON.parse(s));
  assert.strictEqual(JSON.stringify(r), JSON.stringify(c.dmg));
});

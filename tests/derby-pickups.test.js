/* Demolition Derby pickups (docs/DERBY-SPEC.md §2.1): spawn after the countdown, collection radius, effects
   (repair, boost, ammo, armor, bomb), respawn timing (faster in sudden death), determinism, serialize round trip. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-pickups.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, PK = CB.derby.pickups, A = CB.derby.arenas, D = CB.derby.damage, AC = CB.derby.accessories, PH = CB.derby.physics;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby pickups: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function car(id, x, y, acc) {
  var c = { id: id, isPlayer: id === 'player', short: id.toUpperCase(), spec: PH.withMass(PH.specFromBuild(CB.data.presetBuild('muscle')), 0), out: false, alive: true, stats: {}, ram: { charge: 0 } };
  PH.createBody(c, { x: x, y: y, heading: 0 });
  c.dmg = D.create();
  AC.create(c, acc || []);
  return c;
}
function world(cars, t) {
  var evs = [], feed = [];
  return { t: t, cars: cars, emit: function (e) { evs.push(e); return e; }, feed: function (x) { feed.push(x); }, damage: D, evs: evs, lines: feed, byId: function (id) { return cars.filter(function (c) { return c.id === id; })[0]; } };
}

test('spots fill after the countdown, one by one', function () {
  var P = PK.create(A.get('mud-bowl'), rng(3));
  P.step(world([], 1), 1 / 120);
  assert.strictEqual(P.active().length, 0);
  P.step(world([], 3.6), 1 / 120);
  assert.strictEqual(P.active().length, 1);
  P.step(world([], 20), 1 / 120);
  assert.strictEqual(P.active().length, P.spots.length);
  P.entities().forEach(function (e) { assert.strictEqual(e.type, 'pickup'); assert.ok(PK.KINDS[e.kind]); });
});

test('collection within the radius, effects per kind, respawn 10-15 s later', function () {
  var M = A.get('mud-bowl');
  ['repair', 'boost', 'ammo', 'armor', 'bomb'].forEach(function (kind) {
    var P = PK.create(M, rng(7));
    P.step(world([], 30), 1 / 120);
    var it = P.items[0]; it.kind = kind;
    var c = car('player', it.x + 6, it.y, ['nitro', 'oil']);
    c.dmg.health = 0.5; c.dmg.onFire = 0.8; c.dmg.zones.front = 0.6;
    AC.get(c, 'nitro').charge = 0.1; AC.get(c, 'oil').ammo = 0; AC.get(c, 'oil').cooldown = 1;
    var W = world([c], 30.1);
    P.step(W, 1 / 120);
    assert.ok(it.active, kind + ': not collected from 6 m');
    c.x = it.x + 2.2;
    P.step(W, 1 / 120);
    assert.ok(!it.active, kind + ': collected at 2.2 m');
    assert.ok(it.respawn >= 40 && it.respawn <= 45.1, kind + ' respawn ' + it.respawn);
    assert.strictEqual(W.evs.filter(function (e) { return e.type === 'pickup' && e.kind === kind && e.carId === 'player'; }).length, 1);
    assert.ok(W.lines.length >= 1, 'feed line for the player');
    if (kind === 'repair') { assert.ok(Math.abs(c.dmg.health - 0.75) < 1e-9 && c.dmg.onFire === 0 && c.dmg.zones.front < 0.6); }
    if (kind === 'boost') { assert.strictEqual(c.ram.charge, 1); assert.strictEqual(AC.get(c, 'nitro').charge, 1); }
    if (kind === 'ammo') { assert.strictEqual(AC.get(c, 'oil').ammo, 3); assert.strictEqual(AC.get(c, 'oil').cooldown, 0); assert.strictEqual(AC.get(c, 'nitro').charge, 1); }
    if (kind === 'armor') assert.strictEqual(c.pickupArmorT, 6);
    if (kind === 'bomb') assert.strictEqual(c.bombT, 8);
  });
});

test('eliminated or airborne-high cars cannot collect; sudden death respawns fast', function () {
  var P = PK.create(A.get('colosseum'), rng(9));
  P.step(world([], 40), 1 / 120);
  var it = P.items[1], c = car('ai1', it.x, it.y);
  c.out = true; c.alive = false;
  P.step(world([c], 40.1), 1 / 120);
  assert.ok(it.active);
  c.out = false; c.alive = true; c.z = 3;
  P.step(world([c], 40.2), 1 / 120);
  assert.ok(it.active, 'too high above');
  c.z = 0;
  var W = world([c], 40.3); W.suddenDeath = { on: true };
  P.step(W, 1 / 120);
  assert.ok(!it.active && it.respawn <= 48.4, 'sudden death respawn ' + it.respawn);
  // a long pending respawn is pulled in when sudden death starts
  var P2 = PK.create(A.get('colosseum'), rng(9));
  P2.items[0].respawn = 100;
  var W2 = world([], 50); W2.suddenDeath = { on: true };
  P2.step(W2, 1 / 120);
  assert.ok(P2.items[0].respawn < 55);
});

test('deterministic with the same rng and serialize / restore round trip', function () {
  function run(P, from, to) {
    var cs = [car('player', 0, 0), car('ai1', 10, 0)];
    for (var t = from; t < to; t += 0.05) {
      cs[0].x = Math.cos(t * 0.4) * 20; cs[0].y = Math.sin(t * 0.7) * 14;
      cs[1].x = Math.sin(t * 0.5) * 25; cs[1].y = Math.cos(t * 0.3) * 12;
      P.step(world(cs, t), 0.05);
    }
    return JSON.stringify(P.serialize());
  }
  var a = PK.create(A.get('mud-bowl'), rng(11)), b = PK.create(A.get('mud-bowl'), rng(11));
  assert.strictEqual(run(a, 0, 90), run(b, 0, 90));
  var r1 = rng(5), c = PK.create(A.get('junkyard'), r1);
  run(c, 0, 40);
  var snap = JSON.parse(JSON.stringify(c.serialize()));
  var d = PK.create(A.get('junkyard'), rng(1));
  d.restore(snap);
  assert.deepStrictEqual(d.serialize(), c.serialize());
  assert.deepStrictEqual(d.entities(), c.entities());
});

test('kinds and weights: every kind shows up over many rolls, no immediate repeats dominate', function () {
  var r = rng(21), seen = {}, prev = null, same = 0;
  for (var i = 0; i < 2000; i++) { var k = PK._.pickKind(r, prev); seen[k] = (seen[k] || 0) + 1; if (k === prev) same++; prev = k; }
  PK.ORDER.forEach(function (k) { assert.ok(seen[k] > 100, k + ' ' + seen[k]); });
  assert.ok(same < 2000 * 0.16, 'repeat rate ' + same);
});

if (standalone && !process.exitCode) console.log('derby pickups: all ok');

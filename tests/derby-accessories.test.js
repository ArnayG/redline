/* Demolition Derby accessories (docs/DERBY-SPEC.md §6): loadout rules and every accessory's effect in a scripted session. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-ai.js', 'js/derby/derby-session.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, AC = CB.derby.accessories, SS = CB.derby.session;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby accessories: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
var IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false };
/** scripted 1v1 on the mud bowl's dry south side: player at (px, py, ph), opponent at (bx, by, bh); AI idle */
function duel(o) {
  var S = SS.create({ arenaId: o.arena || 'mud-bowl', seed: 3, opponents: 1, difficulty: 'pro', countdown_s: 0.01, aiDisabled: true, aimAssist: 0,
    player: { presetId: o.pa || 'muscle', accessories: o.acc || [] }, ai: [{ presetId: o.pb || 'muscle', accessories: o.accB || [] }] });
  S.step(IDLE); S.step(IDLE);
  var a = S._cars[0], b = S._cars[1];
  function place(c, x, y, h, v) { c.x = x; c.y = y; c.heading = h; c.vx = Math.cos(h) * (v || 0); c.vy = Math.sin(h) * (v || 0); c.w = 0; c.z = 0; c.vz = 0; c.steer = 0; c.gear = 1; }
  place(a, o.ax, o.ay, o.ah || 0, o.av); place(b, o.bx, o.by, o.bh || 0, o.bv);
  [a, b].forEach(function (c) {   // teleported: hang the wrecking ball behind its car again
    var st = AC.get(c, 'wrecking-ball'); if (!st) return;
    var r = AC._.rearAnchor(c, 4.0); st.ball.x = r.x; st.ball.y = r.y; st.ball.vx = st.ball.vy = st.ball.vz = 0;
  });
  return { S: S, a: a, b: b, run: function (secs, inp, each) { for (var i = 0; i < secs * 120; i++) { S.step(typeof inp === 'function' ? inp(i) : inp || IDLE); if (each) each(i); } return this; },
    events: function () { return S.snapshot().events; } };
}
function hp(c) { return c.dmg.health; }

test('loadout rules: budget, slot limits, at most two ACTION accessories, duplicates / unknown rejected', function () {
  assert.ok(AC.LIST.length >= 14 && AC.BUDGET === 12);
  assert.ok(AC.validate([]).ok);
  assert.ok(AC.validate(['flamethrower', 'ramp', 'armour']).ok);
  var over = AC.validate(['flamethrower', 'wrecking-ball', 'ram', 'armour']);
  assert.ok(!over.ok && /budget/i.test(over.errors.join()), over.errors.join());
  assert.ok(!AC.validate(['ram', 'bullbar']).ok, 'one front slot');
  assert.ok(!AC.validate(['flamethrower', 'magnet']).ok, 'one roof slot');
  assert.ok(AC.validate(['armour', 'nitro']).ok && !AC.validate(['armour', 'nitro', 'repair']).ok, 'two util slots');
  var act = AC.validate(['hammer', 'oil', 'nitro']);
  assert.ok(!act.ok && act.actives.length === 3);
  assert.ok(!AC.validate(['ram', 'ram']).ok && !AC.validate(['laser']).ok);
  assert.deepStrictEqual(AC.sanitize(['ram', 'bullbar', 'armour', 'laser']), ['ram', 'armour']);
  AC.PRESETS.forEach(function (p) { assert.ok(AC.validate(p.items).ok, p.id + ': ' + AC.validate(p.items).errors.join()); });
  assert.strictEqual(AC.massOf(['armour', 'ram']), 360);
  AC.LIST.forEach(function (d) { assert.ok(d.name && d.desc && d.slot && d.points > 0 && d.mass > 0, d.id); });
});

test('ACTION buttons map to the active accessories in loadout order', function () {
  var D = duel({ acc: ['ram', 'nitro', 'repair'], ax: -30, ay: -20, bx: 30, by: -20 });
  assert.deepStrictEqual(D.a.accIds, ['ram', 'nitro', 'repair']);
  var v = AC.view(D.a);
  assert.strictEqual(v.filter(function (x) { return x.id === 'nitro'; })[0].button, 1);
  assert.strictEqual(v.filter(function (x) { return x.id === 'repair'; })[0].button, 2);
  assert.strictEqual(v.filter(function (x) { return x.id === 'ram'; })[0].button, 0);
});

test('flamethrower: burns and ignites what is in the cone, not what is beside you; fuel drains and refills', function () {
  var D = duel({ acc: ['flamethrower'], ax: -30, ay: -20, ah: 0, bx: -23, by: -20, bh: Math.PI / 2 });
  D.run(2, Object.assign({}, IDLE, { action1: true }));
  assert.ok(hp(D.b) < 0.9, 'target burned ' + hp(D.b));
  assert.ok(D.b.dmg.onFire > 0 || D.b.dmg.burnT > 0, 'ignited');
  assert.ok(D.b.stats.taken > 0 && D.a.stats.flameDmg > 0 && D.a.stats.dealt > 0);
  var fuel = AC.get(D.a, 'flamethrower').charge;
  assert.ok(fuel < 0.75, 'fuel ' + fuel);
  D.run(3, IDLE);
  assert.ok(AC.get(D.a, 'flamethrower').charge > fuel, 'refills');
  var side = duel({ acc: ['flamethrower'], ax: -30, ay: -20, ah: 0, bx: -30, by: -14, bh: 0 });
  side.run(2, Object.assign({}, IDLE, { action1: true }));
  assert.strictEqual(hp(side.b), 1, 'beside the cone: untouched');
});

test('hammer: one press slams a car alongside (damage + shove), then a cooldown', function () {
  var D = duel({ acc: ['hammer'], ax: -30, ay: -20, ah: 0, bx: -30, by: -16.8, bh: 0 });
  var y0 = D.b.y;
  D.run(0.05, Object.assign({}, IDLE, { action1: true })).run(1, IDLE);
  assert.ok(hp(D.b) < 0.92, 'hammered ' + hp(D.b));
  assert.ok(D.b.y > y0 + 0.3, 'shoved away ' + (D.b.y - y0));
  assert.ok(AC.get(D.a, 'hammer').cooldown > 0);
  var h1 = hp(D.b);
  D.run(0.05, Object.assign({}, IDLE, { action1: true })).run(0.5, IDLE);
  assert.strictEqual(hp(D.b), h1, 'cooldown blocks a second swing');
});

test('front ramp: a head-on hit launches the other car into the air', function () {
  var D = duel({ acc: ['ramp'], ax: -32, ay: -20, ah: 0, av: 15, bx: -24, by: -20, bh: Math.PI });
  var air = false, peak = 0;
  D.run(1.5, { throttle: 1 }, function () { if (D.b.airborne) air = true; peak = Math.max(peak, D.b.z); });
  assert.ok(air && peak > 0.6, 'launched peak ' + peak);
  var plain = duel({ acc: [], ax: -32, ay: -20, ah: 0, av: 15, bx: -24, by: -20, bh: Math.PI }), p2 = 0;
  plain.run(1.5, { throttle: 1 }, function () { p2 = Math.max(p2, plain.b.z); });
  assert.ok(p2 < 0.3, 'no ramp, no launch ' + p2);
});

test('bull-bar / ram / armour / spikes / shield change damage dealt and taken', function () {
  function ram(accA, accB) {
    var D = duel({ acc: accA, accB: accB, ax: -32, ay: -20, ah: 0, av: 16, bx: -24, by: -20, bh: Math.PI / 2 });
    D.run(1, { throttle: 0 });
    return { a: 1 - hp(D.a), b: 1 - hp(D.b) };
  }
  var base = ram([], []), bull = ram(['bullbar'], []), rm = ram(['ram'], []), arm = ram([], ['armour']);
  assert.ok(bull.b > base.b * 1.2 && bull.a < base.a, 'bull-bar ' + JSON.stringify([base, bull]));
  assert.ok(rm.b > base.b * 1.2, 'ram ' + JSON.stringify(rm));
  assert.ok(arm.b < base.b * 0.8, 'armour ' + JSON.stringify(arm));
  // reverse into it with the rear spikes
  function rev(acc) {
    var D = duel({ acc: acc, ax: -24, ay: -20, ah: Math.PI, av: -12, bx: -17, by: -20, bh: Math.PI / 2 });
    D.run(1, IDLE);
    return 1 - hp(D.b);
  }
  assert.ok(rev(['spikes']) > rev([]) * 1.2, 'spikes');
  // shield: no damage while it is up
  var S = duel({ acc: [], accB: ['shield'], ax: -32, ay: -20, ah: 0, av: 16, bx: -24, by: -20, bh: Math.PI / 2 });
  S.b.scriptInput = Object.assign({}, IDLE, { action1: true });
  S.run(1, IDLE);
  assert.strictEqual(hp(S.b), 1, 'shielded');
  assert.ok(S.b.shieldT > 0 || AC.get(S.b, 'shield').cooldown > 0);
});

test('nitro: holding ACTION boosts acceleration and top speed, the tank drains', function () {
  function go(acc, act) { var D = duel({ acc: acc, ax: -40, ay: -22, ah: 0, bx: 30, by: 20 }); D.run(3, { throttle: 1, action1: act }); return D; }
  var n = go(['nitro'], true), p = go([], false);
  assert.ok(n.a.speed > p.a.speed * 1.1, 'nitro ' + n.a.speed + ' vs ' + p.a.speed);
  assert.ok(AC.get(n.a, 'nitro').charge < 0.4);
});

test('caltrops puncture the tyres of a car that drives over them; oil makes it slide', function () {
  var D = duel({ acc: ['caltrops'], ax: -30, ay: -22, ah: 0, bx: -46, by: -22, bh: 0 });
  D.run(0.05, Object.assign({}, IDLE, { action1: true })).run(0.2, IDLE);
  assert.strictEqual(D.S.world.entities.filter(function (e) { return e.type === 'caltrops'; }).length, 1);
  assert.strictEqual(AC.get(D.a, 'caltrops').ammo, 3);
  D.a.x = 0; D.a.y = -25;    // move out of the way
  D.b.scriptInput = { throttle: 0.7 };
  D.run(3, IDLE);
  assert.ok(D.b.dmg.punct.some(Boolean), 'punctured ' + JSON.stringify(D.b.dmg.wheels));
  var O = duel({ acc: ['oil'], ax: -30, ay: -22, ah: 0, bx: -46, by: -22, bh: 0 });
  O.run(0.05, Object.assign({}, IDLE, { action1: true })).run(0.2, IDLE);
  O.a.x = 0; O.a.y = -25;
  O.b.scriptInput = { throttle: 0.7, steer: 0.02 };
  var slip = false;
  O.run(3, IDLE, function () { O.S.snapshot().events.forEach(function (e) { if (e.type === 'oil' && e.slip && e.carId === O.b.id) slip = true; }); });
  assert.ok(slip, 'slid on the oil');
});

test('electro-magnet pulls the nearest car toward you', function () {
  var D = duel({ acc: ['magnet'], ax: -30, ay: -20, ah: 0, bx: -14, by: -20, bh: Math.PI / 2 });
  var d0 = Math.hypot(D.b.x - D.a.x, D.b.y - D.a.y);
  D.run(0.05, Object.assign({}, IDLE, { action1: true })).run(2, IDLE);
  var d1 = Math.hypot(D.b.x - D.a.x, D.b.y - D.a.y);
  assert.ok(d1 < d0 - 3, 'pulled ' + d0.toFixed(1) + ' -> ' + d1.toFixed(1));
  assert.ok(AC.get(D.a, 'magnet').cooldown > 0);
});

test('repair kit works exactly once', function () {
  var D = duel({ acc: ['repair'], ax: -30, ay: -20, bx: 30, by: 20 });
  D.a.dmg.health = 0.4;
  D.run(0.05, Object.assign({}, IDLE, { action1: true })).run(0.3, IDLE);
  assert.ok(Math.abs(hp(D.a) - 0.75) < 0.01, 'healed ' + hp(D.a));
  D.a.dmg.health = 0.4;
  D.run(0.05, Object.assign({}, IDLE, { action1: true })).run(0.3, IDLE);
  assert.ok(Math.abs(hp(D.a) - 0.4) < 0.01, 'second press does nothing');
});

test('wrecking ball: swung by a hard turn it smashes a nearby car', function () {
  var found = null;
  // a few parked positions around the swing (robust to small tuning changes); at least one must be smashed by the ball
  [[-21, -17], [-18, -14], [-18, -11], [-21, -14], [-18, -18], [-14, -16], [-12, -14], [-10, -12]].some(function (bp) {
    var D = duel({ acc: ['wrecking-ball'], ax: -40, ay: -20, ah: 0, bx: bp[0], by: bp[1], bh: 0 });
    var ballHit = false;
    D.run(4, function (i) { return { throttle: 1, steer: i < 180 ? 0 : 1 }; }, function () {
      D.S.snapshot().events.forEach(function (e) { if (e.type === 'impact' && e.ball && e.otherId === D.b.id) ballHit = true; });
    });
    if (ballHit && hp(D.b) < 1) found = D;
    return !!found;
  });
  assert.ok(found, 'the ball hit something');
  var ent = found.S.snapshot().entities.filter(function (e) { return e.type === 'ball'; })[0];
  assert.ok(ent && isFinite(ent.x) && ent.owner === 'player' && isFinite(ent.ax));
});

test('wheel saws grind a car you rub alongside', function () {
  var D = duel({ acc: ['saws'], ax: -30, ay: -20, ah: 0, av: 6, bx: -30, by: -18.05, bh: 0, bv: 2 });
  D.run(1.5, { throttle: 0.4, steer: 0.15 });
  assert.ok(hp(D.b) < 0.99 && D.b.dmg.zones.right > 0.01, 'ground ' + JSON.stringify(D.b.dmg.zones));
});

test('front ramp launches flip the victim sometimes, not every time; flipped cars auto-right', function () {
  var launched = 0, flipped = 0, righted = 0;
  for (var k = 0; k < 16; k++) {
    var D = duel({ acc: ['ramp'], ax: -32, ay: -20 + (k % 4) * 0.15, ah: 0, av: 11 + k * 0.6, bx: -24, by: -20, bh: Math.PI + (k % 3 - 1) * 0.3 });
    D.S.world.rng.state.s = (D.S.world.rng.state.s + k * 7919) >>> 0;
    var air = false, flip = false;
    D.run(2.5, { throttle: 1 }, function () { if (D.b.airborne) air = true; if (D.b.flipped) flip = true; });
    if (air) launched++;
    if (flip) { flipped++; D.run(3.5, IDLE); if (!D.b.flipped) righted++; }
  }
  assert.ok(launched >= 12, 'launched ' + launched);
  assert.ok(flipped >= 1 && flipped <= launched - 3, 'flipped ' + flipped + ' / ' + launched);
  assert.strictEqual(righted, flipped, 'every flipped car auto-rights');
});

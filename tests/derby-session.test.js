/* Demolition Derby session (docs/DERBY-SPEC.md §7, §11): determinism, getState / setState round trip, elimination rules,
   lives, time limit, sudden death, hazards (crusher, braziers, open edges), snapshot + results contract. */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/derby/derby-arenas.js', 'js/derby/derby-pickups.js', 'js/derby/derby-physics.js',
 'js/derby/derby-damage.js', 'js/derby/derby-accessories.js', 'js/derby/derby-ai.js', 'js/derby/derby-session.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, SS = CB.derby.session;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby session: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
var IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false };
function hash(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16) + ':' + s.length; }
function cfg(o) { return Object.assign({ arenaId: 'colosseum', seed: 11, opponents: 5, difficulty: 'pro', playerAutopilot: true, player: { presetId: 'muscle', accessories: ['ram', 'armour', 'nitro'] } }, o || {}); }
function steps(S, n, inp) { for (var i = 0; i < n; i++) S.step(typeof inp === 'function' ? inp(i) : inp); }
function quiet(o) {
  var S = SS.create(Object.assign({ arenaId: 'mud-bowl', seed: 2, opponents: 1, countdown_s: 0.01, aiDisabled: true, player: { presetId: 'muscle' }, ai: [{ presetId: 'hot-hatch' }] }, o || {}));
  steps(S, 2, IDLE);
  return S;
}

test('the grid: player + N AI cars on presets, deterministic by seed, AI loadouts valid', function () {
  var S = SS.create(cfg({ opponents: 11 }));
  assert.strictEqual(S._cars.length, 12);
  assert.ok(S._cars[0].isPlayer && S._cars[0].id === 'player');
  var g1 = JSON.stringify(SS.makeGrid(cfg({ opponents: 11 }))), g2 = JSON.stringify(SS.makeGrid(cfg({ opponents: 11 })));
  assert.strictEqual(g1, g2);
  assert.notStrictEqual(g1, JSON.stringify(SS.makeGrid(cfg({ opponents: 11, seed: 12 }))));
  S._cars.forEach(function (c) { assert.ok(CB.derby.accessories.validate(c.accIds).ok, c.id); assert.ok(c.build && c.spec.mass > 0); });
  var ids = SS.makeGrid(cfg({ opponents: 11 })).map(function (e) { return e.presetId; });
  assert.ok(ids.indexOf('muscle') < 0, 'AI avoid the player preset while others remain');
});

test('determinism: same cfg + inputs -> bit-identical state; getState / setState mid-match continues identically', function () {
  var A = SS.create(cfg()), B = SS.create(cfg());
  steps(A, 120 * 25); steps(B, 120 * 25);
  assert.strictEqual(hash(JSON.stringify(A.getState())), hash(JSON.stringify(B.getState())));
  var mid = JSON.parse(JSON.stringify(A.getState()));
  steps(A, 120 * 15);
  var C = SS.create(cfg());
  assert.ok(C.setState(mid));
  steps(C, 120 * 15);
  assert.strictEqual(hash(JSON.stringify(C.getState())), hash(JSON.stringify(A.getState())), 'restored run diverged');
  // and with a recorded player input stream instead of the autopilot
  var inp = function (i) { return { throttle: (i % 300) < 200 ? 1 : 0, brake: (i % 300) >= 240 ? 1 : 0, steer: Math.sin(i / 90), handbrake: i % 500 > 480, action1: i % 400 === 0, action2: false }; };
  var P1 = SS.create(cfg({ playerAutopilot: false })), P2 = SS.create(cfg({ playerAutopilot: false }));
  steps(P1, 3000, inp); steps(P2, 3000, inp);
  assert.strictEqual(hash(JSON.stringify(P1.getState())), hash(JSON.stringify(P2.getState())));
});

test('no NaNs and sane values through a full 12-car match; the state is plain JSON', function () {
  var S = SS.create(cfg({ arenaId: 'junkyard', opponents: 11, seed: 5 }));
  for (var i = 0; i < 120 * 60; i++) {
    S.step();
    if (i % 60 === 0) {
      var sn = S.snapshot();
      sn.cars.forEach(function (c) {
        ['x', 'y', 'z', 'heading', 'vx', 'vy', 'speed', 'health', 'pitch', 'roll'].forEach(function (k) { assert.ok(isFinite(c[k]), c.id + '.' + k + ' = ' + c[k]); });
        assert.ok(c.health >= 0 && c.health <= 1 && Math.abs(c.heading) <= Math.PI + 1e-9 && c.speed < 80);
      });
    }
  }
  var st = S.getState();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(st)), st);
});

test('snapshot + results contract', function () {
  var S = SS.create(cfg({ opponents: 3 }));
  steps(S, 120 * 6);
  var sn = S.snapshot();
  ['t', 'phase', 'countdown_s', 'arenaId', 'arena', 'playerId', 'aliveCount', 'total', 'cars', 'events', 'entities', 'feed', 'slowmo', 'suddenDeath'].forEach(function (k) { assert.ok(k in sn, 'snap.' + k); });
  assert.strictEqual(sn.phase, 'fight');
  var c = sn.cars[0];
  ['id', 'name', 'isPlayer', 'x', 'y', 'z', 'heading', 'pitch', 'roll', 'speed', 'health', 'zones', 'wheels', 'wheelLost', 'punct', 'engine', 'onFire', 'parts', 'dents', 'dentSeq', 'acc', 'shield', 'boosting', 'stats', 'alive', 'out', 'build', 'color', 'spec'].forEach(function (k) { assert.ok(k in c, 'car.' + k); });
  assert.ok(Array.isArray(c.acc) && c.acc.length === 3 && 'ready' in c.acc[0]);
  var r = S.results();
  assert.ok(r.derby && r.discipline === 'derby' && r.classification.length === 4 && r.player && r.player.isPlayer);
  r.classification.forEach(function (row, i) { assert.strictEqual(row.position, i + 1); assert.ok(row.stats && 'dealt' in row.stats && 'kills' in row.stats); });
});

test('countdown holds every car; GO releases them', function () {
  var S = SS.create(cfg({ countdown_s: 3 }));
  steps(S, 120 * 2.5, { throttle: 1 });
  var sn = S.snapshot();
  assert.strictEqual(sn.phase, 'countdown');
  sn.cars.forEach(function (c) { assert.ok(c.speed < 0.01, c.id + ' held'); });
  var vmax = 0;
  steps(S, 120 * 2, function () { vmax = Math.max(vmax, S._cars[0].speed || 0); return { throttle: 1 }; });
  assert.strictEqual(S.snapshot().phase, 'fight');
  assert.ok(vmax > 2, 'released: ' + vmax);
});

test('elimination: wrecked (health 0), engine dead + standing, fell off an open edge, immobile', function () {
  var S = quiet();
  var b = S._cars[1];
  b.dmg.health = 0;
  steps(S, 2, IDLE);
  assert.ok(b.out && b.elimReason === 'wrecked');
  var r = S.results();
  assert.strictEqual(r.winnerId, 'player');
  assert.ok(r.won && r.classification[0].id === 'player' && r.classification[1].elimReason === 'wrecked');
  assert.strictEqual(S.snapshot().phase, 'over');

  var E = quiet();
  E._cars[1].dmg.zones.front = 1; E._cars[1].dmg.health = 0.3;
  steps(E, 120 * 7, IDLE);
  assert.ok(E._cars[1].dmg.engine.stalled && E._cars[1].out && E._cars[1].elimReason === 'engine', E._cars[1].elimReason);

  var F = quiet({ arenaId: 'rooftop' });
  var f = F._cars[1];
  f.x = 50; f.y = 0; f.heading = 0; f.vx = 12; f.vy = 0;
  f.scriptInput = { throttle: 1 };
  steps(F, 120 * 4, IDLE);
  assert.ok(f.out && f.elimReason === 'fell', 'fell: ' + f.elimReason + ' z ' + f.z);

  // fun pass: a car wedged nose-first on a wall is popped free (unstick), not eliminated as 'immobile'
  var I = quiet({ rules: { idlePenalty: false } });
  var p = I._cars[0], unstuck = 0;
  p.x = 47; p.y = 0; p.heading = 0;   // nose against the east wall
  for (var k = 0; k < 120 * 8; k++) { I.step({ throttle: 1 }); if (k % 12 === 0) I.snapshot().events.forEach(function (e) { if (e.type === 'unstick' && e.carId === 'player') unstuck++; }); }
  assert.ok(!p.out && unstuck >= 1, 'wedged car popped free: ' + unstuck + ' ' + p.elimReason);
});

test('anti-stalemate: limp floor, pinned cars pushed apart, R pops a stuck car, quick auto-unflip', function () {
  // limp floor: a wrecked-but-alive car keeps >= 38 % power / 60 % lock / 58 % top speed
  var S = quiet();
  var c = S._cars[0];
  c.dmg.zones = { front: 1, rear: 1, left: 1, right: 1 }; c.dmg.wheels = [1, 1, 1, 1]; c.dmg.wheelLost = [true, true, false, false];
  var m = CB.derby.damage.effects(c);
  if (!c.dmg.engine.stalled) assert.ok(m.powerMult >= 0.38 && m.steerLockMult >= 0.6 && m.topMult >= 0.58, JSON.stringify(m));
  // two cars grinding nose to nose never stay locked together (they slide off or get an unstick push)
  var P = quiet({ rules: { idlePenalty: false } });
  var a = P._cars[0], b = P._cars[1], seen = 0;
  a.x = -2.4; a.y = 0; a.heading = 0; b.x = 2.4; b.y = 0; b.heading = Math.PI;
  b.scriptInput = { throttle: 1, brake: 0, steer: 0 };
  var sepMax = 0;
  for (var i = 0; i < 120 * 5; i++) { P.step({ throttle: 1 }); sepMax = Math.max(sepMax, Math.hypot(a.x - b.x, a.y - b.y)); if (i % 12 === 0) P.snapshot().events.forEach(function (e) { if (e.type === 'unstick') seen++; }); }
  assert.ok(seen >= 1 || sepMax > 6, 'grinding pair separated (arcade bounce ricochets them apart): ' + sepMax.toFixed(1));
  // R held on a stuck (not flipped) car: pop after ~1 s
  var R = quiet({ rules: { idlePenalty: false } });
  var r = R._cars[0], pops = 0;
  r.x = 47; r.y = 0; r.heading = 0;
  for (var j = 0; j < 120 * 1.6; j++) { R.step({ throttle: 0, reset: true }); if (j % 12 === 0) R.snapshot().events.forEach(function (e) { if (e.type === 'unstick' && e.forced) pops++; }); }
  assert.ok(pops === 1, 'R pop ' + pops);
  // flipped -> back on the wheels in ~1.5 s
  var U = quiet();
  var u = U._cars[1];
  u.flipped = true; u.flippedT = 0;
  steps(U, 120 * 1.7, IDLE);
  assert.ok(!u.flipped, 'auto-unflip');
});

test('idle penalty: 15 s without dealing / taking damage -> flagged, hunted and burning', function () {
  var S = quiet({ rules: { suddenDeath: false } });
  steps(S, 120 * 14, IDLE);
  assert.ok(!S._cars[0].idle);
  steps(S, 120 * 3, IDLE);
  var sn = S.snapshot(), me = sn.cars[0];
  assert.ok(me.idle && me.health < 1 && sn.feed.some(function (f) { return /camping/i.test(f.text); }), 'idle ' + me.idle + ' ' + me.health);
  var Q = quiet({ rules: { idlePenalty: false, suddenDeath: false } });
  steps(Q, 120 * 20, IDLE);
  assert.ok(!Q._cars[0].idle && Q._cars[0].dmg.health === 1);
});

test('lives: an eliminated car respawns while it has lives left', function () {
  var S = quiet({ rules: { lives: 2 } });
  var b = S._cars[1];
  b.dmg.health = 0;
  steps(S, 2, IDLE);
  assert.ok(b.out && b.lives === 1 && S.snapshot().phase === 'fight');
  steps(S, 120 * 3.2, IDLE);
  assert.ok(!b.out && b.dmg.health === 1 && b.invulnT > 0, 'respawned');
  b.dmg.health = 0;
  steps(S, 120 * 3.5, IDLE);
  assert.ok(b.out && S.snapshot().phase === 'over' && S.results().winnerId === 'player');
});

test('time limit: the healthiest car wins when time is up; sudden death (ring of fire) from 75 s or after a lull', function () {
  var S = quiet({ rules: { timeLimit_s: 20, idlePenalty: false } });
  S._cars[0].dmg.health = 0.5;
  steps(S, 120 * 21, IDLE);
  var r = S.results();
  assert.ok(r.endReason === 'time' && r.winnerId === 'ai1', r.endReason + ' ' + r.winnerId);
  // pure helper
  var f = SS.safeScaleAt;
  assert.ok(!f(74, {}).on && f(74, {}).safeScale === 1 && f(74, {}).mult === 1);
  assert.ok(f(105, {}).on && Math.abs(f(105, {}).safeScale - 0.75) < 1e-9 && Math.abs(f(105, {}).mult - 1.5) < 1e-9 && f(105, {}).ringFire);
  assert.ok(Math.abs(f(500, {}).safeScale - 0.5) < 1e-9 && !f(500, { suddenDeath: false }).on && f(20, {}, 10).on);
  // a quiet match: the lull failsafe starts it at ~44 s (35 s + 9 s with no hits), the feed says so
  var D = quiet({ rules: { idlePenalty: false } });
  steps(D, 120 * 30, IDLE);
  assert.ok(!D.snapshot().suddenDeath.on);
  steps(D, 120 * 16, IDLE);
  var sd = D.snapshot();
  assert.ok(sd.suddenDeath.on && sd.feed.some(function (x) { return /SUDDEN DEATH/.test(x.text); }), 'sudden death ' + JSON.stringify(sd.suddenDeath));
  // outside the shrinking ring you burn
  steps(D, 120 * 40, IDLE);
  var c = D._cars[1];
  assert.ok(c.dmg.health < 1 || c.out, 'ring burn ' + c.dmg.health);
  var N = quiet({ rules: { suddenDeath: false, idlePenalty: false } });
  steps(N, 120 * 90, IDLE);
  assert.ok(!N.snapshot().suddenDeath.on && N.snapshot().damageMult === 1);
});

test('ram boost: held boost surges forward, drains the meter, refills; a boosted hit scores RAM BOOST HIT', function () {
  var S = quiet({ rules: { idlePenalty: false } });
  var a = S._cars[0], b = S._cars[1];
  a.x = -30; a.y = 20; a.heading = 0; b.x = 30; b.y = -20;
  steps(S, 120 * 1.5, { throttle: 1 });
  var plain = a.speed;
  var T = quiet({ rules: { idlePenalty: false } });
  var a2 = T._cars[0]; a2.x = -30; a2.y = 20; a2.heading = 0; T._cars[1].x = 30; T._cars[1].y = -20;
  steps(T, 120 * 1.5, { throttle: 1, boost: true });
  assert.ok(a2.speed > plain * 1.25, 'boost ' + a2.speed + ' vs ' + plain);
  assert.ok(a2.ram.charge < 0.4 && T.snapshot().cars[0].ram.active, 'drained ' + a2.ram.charge);
  steps(T, 120 * 2, { throttle: 0 });
  assert.ok(a2.ram.charge > 0.2 && !a2.ram.active, 'refill');
  // boosted T-bone
  var H = quiet({ rules: { idlePenalty: false } });
  var p = H._cars[0], q = H._cars[1], evs = [];
  p.x = -34; p.y = -20; p.heading = 0; q.x = -21; q.y = -20; q.heading = Math.PI / 2;
  for (var i = 0; i < 120 * 1.5; i++) { H.step({ throttle: 1, boost: true }); evs = evs.concat(H.snapshot().events); }
  var labels = evs.filter(function (e) { return e.type === 'score' && e.carId === 'player'; }).map(function (e) { return e.label; });
  assert.ok(labels.indexOf('T-BONE') >= 0 && labels.indexOf('RAM BOOST HIT') >= 0, JSON.stringify(labels));
  assert.ok(p.stats.score >= 350 && p.stats.boostHits === 1);
});

test('scoring: labels + combo multiplier, takedown + last car standing, results carry score / coins / launches', function () {
  var S = quiet({ rules: { idlePenalty: false } });
  var a = S._cars[0], b = S._cars[1], evs = [];
  // rear-ender
  a.x = -30; a.y = 0; a.heading = 0; a.vx = 17; b.x = -22; b.y = 0; b.heading = 0;
  for (var i = 0; i < 60; i++) { S.step({ throttle: 1 }); evs = evs.concat(S.snapshot().events); }
  var sc = evs.filter(function (e) { return e.type === 'score'; });
  assert.ok(sc.length && sc[0].label === 'REAR-ENDER' && sc[0].carId === 'player' && sc[0].otherId === 'ai1', JSON.stringify(sc));
  // revenge: ai1 hits back at the player within 6 s
  b.x = -20; b.y = -9; b.heading = -Math.PI / 2; b.vx = 0; b.vy = -17; b.w = 0; a.x = -20; a.y = -20; a.vx = 0; a.vy = 0; a.w = 0; a.heading = 0;
  b.scriptInput = { throttle: 1 };
  for (var j = 0; j < 150; j++) { S.step({ throttle: 0 }); evs = evs.concat(S.snapshot().events); }
  assert.ok(evs.some(function (e) { return e.type === 'score' && e.carId === 'ai1' && e.label === 'REVENGE!'; }), 'revenge');
  b.dmg.health = 0; b.lastHitBy = 'player'; b.lastHitT = S.world.t;
  steps(S, 3, IDLE);
  var r = S.results(), me = r.player;
  assert.ok(r.won && me.score >= 150 + 500 + 1000, 'score ' + me.score);
  assert.strictEqual(me.coins, Math.round(me.score / 20));
  assert.ok(r.mvpId === 'player' && typeof me.stats.launches === 'number' && typeof me.stats.bestCombo === 'number');
  var lab = evs.concat(S.snapshot().events).filter(function (e) { return e.type === 'score' && e.carId === 'player'; }).map(function (e) { return e.label; });
  assert.ok(lab.indexOf('TAKEDOWN') >= 0, JSON.stringify(lab));
});

test('hazards: the junkyard crusher hurts, colosseum braziers ignite', function () {
  var S = quiet({ arenaId: 'junkyard' });
  var b = S._cars[1], cr = S.arena.hazards.filter(function (h) { return h.type === 'crusher'; })[0];
  b.x = cr.x; b.y = cr.y;
  steps(S, 120 * 10, IDLE);
  assert.ok(b.dmg.health < 0.7 || b.out, 'crushed ' + b.dmg.health);
  var C = quiet({ arenaId: 'colosseum' });
  var c = C._cars[1], br = C.arena.hazards.filter(function (h) { return h.type === 'fire'; })[0];
  c.x = br.x; c.y = br.y;
  steps(C, 120 * 1, IDLE);
  assert.ok(c.dmg.onFire > 0 && c.dmg.health < 1, 'brazier ' + c.dmg.onFire);
});

test('a big player hit fills the kill feed and the impact event names the zones', function () {
  var S = quiet();
  var a = S._cars[0], b = S._cars[1];
  a.x = -32; a.y = -20; a.heading = 0; a.vx = 18; a.vy = 0;
  b.x = -23; b.y = -20; b.heading = Math.PI / 2; b.vx = 0; b.vy = 0;
  var evs = [], feed = [];
  for (var i = 0; i < 120; i++) { S.step({ throttle: 1 }); var sn = S.snapshot(); evs = evs.concat(sn.events); feed = sn.feed; }
  var imp = evs.filter(function (e) { return e.type === 'impact' && e.carId === 'player'; })[0];
  assert.ok(imp && imp.attZone === 'front' && (imp.zone === 'left' || imp.zone === 'right') && imp.kind === 'tbone' && imp.big, JSON.stringify(imp));
  assert.ok(feed.some(function (f) { return /You T-boned/.test(f.text); }), JSON.stringify(feed));
  assert.ok(a.stats.tbones === 1 && a.stats.dealt > 0.04 && b.stats.taken > 0.04, a.stats.dealt + ' ' + b.stats.taken);
  assert.ok(S.snapshot().cars[0].score >= 250);
  assert.ok(b.dmg.health < a.dmg.health, 'the victim takes more');
});

test('pickups ride along: entities in the snapshot, AI / players collect them, getState round-trips them exactly', function () {
  if (!CB.derby.pickups) return;
  var A = SS.create(cfg({ arenaId: 'mud-bowl' })), got = 0;
  for (var i = 0; i < 120 * 30; i++) { A.step(); if (i % 12 === 0) A.snapshot().events.forEach(function (e) { if (e.type === 'pickup') got++; }); }
  assert.ok(A.snapshot().entities.some(function (e) { return e.type === 'pickup'; }), 'pickup entities');
  assert.ok(got > 0, 'somebody collected a pickup');
  var mid = JSON.parse(JSON.stringify(A.getState()));
  assert.ok(mid.pickups && mid.pkRng != null);
  steps(A, 120 * 10);
  var B = SS.create(cfg({ arenaId: 'mud-bowl' }));
  B.setState(mid); steps(B, 120 * 10);
  assert.strictEqual(hash(JSON.stringify(B.getState())), hash(JSON.stringify(A.getState())));
});

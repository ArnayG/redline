/* Demolition Derby AI (docs/DERBY-SPEC.md §8): full AI matches on every arena (someone wins in time, lots of big hits, no
   stuck / orbiting, no self-eliminations off the roof), difficulty scaling, accessory use, unsticking, 12-car performance. */
'use strict';
var assert = require('assert');
var path = require('path');
var sim = require(path.join(__dirname, '..', 'tools', 'derby-sim.js'));   // loads the derby modules
var CB = globalThis.CB, SS = CB.derby.session;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('derby ai: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
var IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false, action1: false, action2: false };

CB.derby.arenas.ids().forEach(function (id) {
  test('8-car AI match on ' + id + ': ends with a winner, frequent big hits, no stuck / orbiting / self-falls / NaNs', function () {
    var st = sim.runMatch({ arena: id, seed: 1, opponents: 7, difficulty: 'pro', maxSeconds: 260 });
    var tag = id + ' ' + JSON.stringify({ dur: st.duration, imp: +st.impPerCarMin.toFixed(1), big: +st.bigPerMin.toFixed(1), stuck: +st.stuckPct.toFixed(1), orbit: +st.orbitPct.toFixed(1), self: st.selfFalls });
    assert.ok(!st.nan, tag + ' NaN');
    assert.ok(st.ended && st.winner, tag + ' no winner');
    assert.ok(st.duration > 25 && st.duration < 255, tag);
    assert.ok(st.impPerCarMin >= 8, tag + ' impacts');
    assert.ok(st.bigPerMin >= 2.5, tag + ' big hits');
    assert.ok(st.stuckPct < 15, tag + ' stuck');
    assert.ok(st.orbitPct < 20, tag + ' orbit');
    assert.ok(st.selfFalls <= 1, tag + ' self falls');
    var r = st.results;
    assert.strictEqual(r.classification.length, 8);
    assert.ok(r.classification.reduce(function (s, c) { return s + c.stats.hits; }, 0) > 30, tag + ' hits');
  });
});

test('difficulty: harder AI is quicker / more accurate / hits harder, every level stays lively', function () {
  var LV = CB.derby.ai.LEVEL, DF = CB.derby.session.DIFFICULTY, order = ['rookie', 'amateur', 'pro', 'alien'];
  for (var i = 1; i < order.length; i++) {
    var a = order[i - 1], b = order[i];
    assert.ok(LV[b].react <= LV[a].react && LV[b].noise <= LV[a].noise, 'reaction / aim ' + a + ' -> ' + b);
    assert.ok(DF[b].playerTaken >= DF[a].playerTaken && DF[b].aiDealt >= DF[a].aiDealt, 'damage ' + a + ' -> ' + b);
    assert.ok(DF[b].aimAssist <= DF[a].aimAssist, 'human ram assist ' + a + ' -> ' + b);
  }
  function avg(d) { var x = 0; [1, 2].forEach(function (s) { x += sim.runMatch({ arena: 'mud-bowl', seed: s, opponents: 7, difficulty: d, maxSeconds: 200 }).bigPerMin; }); return x / 2; }
  var ro = avg('rookie'), al = avg('alien');
  assert.ok(ro > 8 && al > 8, 'lively: rookie ' + ro.toFixed(1) + ' alien ' + al.toFixed(1) + ' big hits / min');
});

test('an AI hunts down a parked player and keeps hitting it', function () {
  var S = SS.create({ arenaId: 'colosseum', seed: 4, opponents: 1, countdown_s: 0.5, player: { presetId: 'hot-hatch' }, ai: [{ presetId: 'muscle', accessories: [] }] });
  var hits = 0;
  for (var i = 0; i < 120 * 20; i++) { S.step(IDLE); if (i % 12 === 0) S.snapshot().events.forEach(function (e) { if (e.type === 'impact' && e.carId === 'ai1' && e.otherId === 'player') hits++; }); }
  assert.ok(hits >= 3, 'hits ' + hits);
  assert.ok(S._cars[0].dmg.health < 0.96, 'player hp ' + S._cars[0].dmg.health);
});

test('AI use their accessories in a match (flame, hammer, ramp launches, nitro, magnet, drops)', function () {
  var seen = {};
  [1, 2].forEach(function (seed) {
    var st = sim.runMatch({ arena: 'mud-bowl', seed: seed, opponents: 7, difficulty: 'pro', maxSeconds: 120 });
    Object.keys(st.accEv).forEach(function (k) { seen[k] = (seen[k] || 0) + st.accEv[k]; });
  });
  ['hammer', 'launch', 'nitro', 'magnet', 'flame'].forEach(function (k) { assert.ok(seen[k] > 0, k + ' never used: ' + JSON.stringify(seen)); });
  assert.ok((seen.oil || 0) + (seen.caltrops || 0) > 0, 'drops');
});

test('a pinned AI reverses out instead of pushing forever', function () {
  var S = SS.create({ arenaId: 'mud-bowl', seed: 4, opponents: 1, countdown_s: 0.01, player: { presetId: 'hot-hatch' }, ai: [{ presetId: 'muscle', accessories: [] }] });
  S.step(IDLE); S.step(IDLE);
  var a = S._cars[1], p = S._cars[0];
  // nose into the east wall, the player parked far away behind it
  a.x = 50; a.y = 0; a.heading = 0; p.x = -40; p.y = 0;
  var maxD = 0;
  for (var i = 0; i < 120 * 6; i++) { S.step(IDLE); maxD = Math.max(maxD, Math.hypot(a.x - 50, a.y)); }
  assert.ok(maxD > 8, 'got away from the wall: ' + maxD.toFixed(1));
});

test('rooftop: AI hunting a car parked near the open east edge do not follow it off the roof', function () {
  var falls = 0;
  [1, 2, 3].forEach(function (seed) {
    var S = SS.create({ arenaId: 'rooftop', seed: seed, opponents: 3, countdown_s: 0.5, player: { presetId: 'atelier-shuttle', accessories: ['armour'] } });
    S.step(IDLE);
    S._cars[0].x = 50; S._cars[0].y = 10; S._cars[0].heading = Math.PI / 2;
    for (var i = 0; i < 120 * 30; i++) {
      S.step(IDLE);
      if (i % 12 === 0) S.snapshot().events.forEach(function (e) { if (e.type === 'eliminated' && e.reason === 'fell' && e.carId !== 'player' && !e.otherId) falls++; });
    }
  });
  assert.ok(falls <= 1, 'AI self-falls ' + falls);
});

test('performance: 12 cars cost well under real time (< 60 ms on a loaded machine; ~15 ms idle CPU per simulated second)', function () {
  var S = SS.create({ arenaId: 'junkyard', seed: 9, opponents: 11, difficulty: 'pro', playerAutopilot: true, countdown_s: 0.5 });
  for (var i = 0; i < 120 * 3; i++) S.step();
  var t0 = process.hrtime.bigint(), n = 120 * 20;
  for (i = 0; i < n; i++) { S.step(); if (i % 2 === 0) S.snapshot(); }
  var ms = Number(process.hrtime.bigint() - t0) / 1e6;
  var per = ms / (n / 120);
  assert.ok(per < 60, per.toFixed(1) + ' ms per simulated second');
});

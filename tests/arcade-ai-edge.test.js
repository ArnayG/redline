/* Arcade AI edge guard (js/race/ai.js): with the lane reference pinned to the inside edge of a corner, the line's
   curvature feed-forward used to turn the car in past the inside kerb. Regression: Shuto Night Loop, where Rookie /
   Pro arcade cars cut 1.5–2 m beyond the inside edge of its right-handers (s ≈ 300 m and ≈ 880 m). */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
 'js/race/ai.js', 'js/race/engine.js', 'js/race/drift/assist.js', 'js/game/replay.js', 'js/arcade/mode.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, E = CB.race.engine;

var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0;
function test(name, fn) {
  if (!standalone) return globalThis.test('arcade-ai-edge: ' + name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('Shuto Night Loop: an 8-car arcade AI pack laps without cutting inside the track edge', function () {
  [['rookie', 1], ['rookie', 2], ['rookie', 3], ['pro', 3]].forEach(function (c) {
    var s = E.createSession({ trackId: 'shuto-night-loop', laps: 2, opponents: 7, difficulty: c[0], playerBuild: CB.data.defaultBuild(),
      playerAutopilot: true, handling: 'arcade', seed: c[1], persistGhost: false });
    var cut = [], knocked = [], hits = {}, hitAt = {};
    for (var t = 0; t < 600; t += 0.1) {
      s.update(0.1, {});
      var sn = s.snapshot();
      sn.cars.forEach(function (car) {
        if ((car.collisions || 0) !== (hits[car.id] || 0)) { hits[car.id] = car.collisions || 0; hitAt[car.id] = t; }
        if (car.onTrack === false && !car.finished) {
          var tag = car.id + '@' + Math.round(car.s) + '/' + car.lateral.toFixed(1);
          // A car-to-car contact can knock a car wide (a nose locked against a rear quarter mid-corner ploughs both
          // off the outside together): racing incidents, not the line-following cut this test guards. Which seed
          // and lap produce one depends on last-bit float differences between CPUs (pro seed 3 does on x86-64
          // Linux CI, not on arm64), so they are counted apart and only bounded.
          if (hitAt[car.id] != null && t - hitAt[car.id] < 3) knocked.push(tag); else cut.push(tag);
        }
      });
      if (sn.cars.every(function (car) { return car.finished; })) break;
    }
    assert.strictEqual(cut.length, 0, c[0] + ' seed ' + c[1] + ': off-track samples ' + cut.slice(0, 6).join(' '));
    assert.ok(knocked.length < 80, c[0] + ' seed ' + c[1] + ': long off-track excursions after contact ' + knocked.slice(0, 6).join(' '));
  });
});

if (standalone) console.log(passed + ' arcade-ai-edge tests passed');

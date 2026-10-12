/* Regression bots for the arcade drift feel (heavy / auto assist), lifted from the integration harness:
   - Up + ONE arrow held from the grid never gets the car stuck (speed stays > 30 km/h after 8 s)
   - forge-ring Up only on heavy / auto never leaves the track
   - forge-speedway auto, Up only, actually drifts (> 20 % of the lap sideways)
   run: node tests/drift-regress.test.js (or via node tests/run.js drift) */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { console.log('  (skip ' + rel + ': ' + e.message + ')'); return false; }
}
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js',
 'js/game/challenges.js', 'js/race/drift/tune.js', 'js/race/drift/assist.js', 'js/race/drift/scoring.js', 'js/race/drift/tracks.js',
 'js/race/drift/ai.js', 'js/race/drift/arcade.js', 'js/race/drift/session.js'].forEach(tryLoad);
var CB = globalThis.CB;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('drift-regress: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}
var ok = !!(CB && CB.race && CB.race.drift && CB.race.drift.createSession);
var KPH = 3.6, DT = 1 / 60;

test('Up + one arrow held from the grid for 20 s never gets stuck (> 30 km/h after 8 s), heavy and auto', function () {
  if (!ok) return;
  ['kurogane-pass', 'little-anvil', 'ouroboros', 'neon-harbour'].forEach(function (tr) {
    ['heavy', 'auto'].forEach(function (lv) {
      ['left', 'right'].forEach(function (k) {
        var s = CB.race.drift.createSession({ trackId: tr, mode: 'free', seed: 1, assist: lv });
        var t = 0, minv = Infinity, off = 0, ps;
        while (t < 20) {
          var raw = { up: true }; raw[k] = true;
          s.update(DT, raw); t += DT;
          ps = s.playerState();
          if (ps && ps.offTrack) off += DT;
          if (t > 8 && ps) minv = Math.min(minv, ps.speed);
        }
        var tag = tr + ' ' + lv + ' ' + k + ': min ' + (minv * KPH).toFixed(0) + ' km/h, off ' + off.toFixed(1) + ' s';
        assert.ok(minv * KPH > 30, 'not stuck: ' + tag);
        assert.ok(off < 0.5, 'stays on the road: ' + tag);
      });
    });
  });
});

function upOnlyLap(tr, lv, maxT) {
  var s = CB.race.drift.createSession({ trackId: tr, mode: 'free', seed: 3, assist: lv });
  var t = 0, off = 0, drift = 0, spins = 0, lap = 0;
  while (t < maxT) {
    s.update(DT, { up: true }); t += DT;
    var ps = s.playerState();
    if (ps && ps.offTrack) off += DT;
    if (ps && ps.speed > 8 && ps.angle_deg > 15) drift += DT;
    if (ps && ps.speed > 3 && ps.angle_deg > 85) spins++;
    var me = s.snapshot().cars.filter(function (c) { return c.isPlayer; })[0];
    lap = me.lap;
    if (lap > 1) break;
  }
  return { t: t, off: off, drift: drift / Math.max(1, t), spins: spins, lap: lap };
}
function fmt(tr, lv, R) { return tr + ' ' + lv + ' lap ' + R.lap + ' t ' + R.t.toFixed(0) + ' s off ' + R.off.toFixed(1) + ' s drift ' + (R.drift * 100).toFixed(0) + '% spins ' + R.spins; }

test('forge-ring Up only on heavy and auto: a full lap with 0 s off track and no spin', function () {
  if (!ok) return;
  ['heavy', 'auto'].forEach(function (lv) {
    var R = upOnlyLap('forge-ring', lv, 400);
    assert.ok(R.lap > 1, 'finishes the lap: ' + fmt('forge-ring', lv, R));
    assert.ok(R.off === 0, 'never off: ' + fmt('forge-ring', lv, R));
    assert.strictEqual(R.spins, 0, 'no spin: ' + fmt('forge-ring', lv, R));
  });
});

test('forge-speedway auto, Up only: Up alone drifts (> 20 % of the lap sideways), stays on track', function () {
  if (!ok) return;
  var R = upOnlyLap('forge-speedway', 'auto', 300);
  assert.ok(R.lap > 1, 'finishes the lap: ' + fmt('forge-speedway', 'auto', R));
  assert.ok(R.drift > 0.2, 'drifts on its own: ' + fmt('forge-speedway', 'auto', R));
  assert.ok(R.off < 0.5, 'stays on: ' + fmt('forge-speedway', 'auto', R));
});

if (local) {
  var passed = 0, failed = 0;
  queue.forEach(function (t) {
    var t0 = Date.now();
    try { t.fn(); passed++; console.log('  ✓ ' + t.name + ' (' + (Date.now() - t0) + ' ms)'); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

/* Node tests: CB.f1.ai (docs/F1-SPEC.md §5) — F1 racecraft on the real engine, F1 car (CB.f1.hooks / CB.f1.car) and
   F1 circuits (CB.f1.circuits). Clean races on every circuit (small fields), one full 22-car race, DRS use, pit stops by
   strategy, difficulty ordering, determinism. tools/f1-laptimes.js is the full report (lap-time table + 22-car sweep). */
'use strict';
var assert = require('assert');
var path = require('path');
var tool = require(path.join(__dirname, '..', 'tools', 'f1-laptimes.js'));
var CB = tool.load();
var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  name = 'f1-ai: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
if (!(CB.f1 && CB.f1.ai && CB.f1.hooks && CB.f1.circuits && CB.f1.car && CB.race && CB.race.engine)) {
  console.log('  (f1-ai: F1 modules missing — skipped)');
  module.exports = [];
  return;
}
var C = CB.f1.circuits;
// REDLINE_F1_FULL=1: every circuit in the clean-race sweep (default: a representative subset — street / bridge / fast)
var FULL = process.env.REDLINE_F1_FULL === '1';
function circuitIds() { return FULL ? C.ids.slice() : ['f1-monaco', 'f1-suzuka', 'f1-monza', 'f1-interlagos']; }

test('wrapDriver keeps the driver contract and publishes DRS / ERS intent to the hooks', function () {
  var calls = 0;
  var base = { id: 'x', control: function () { calls++; return { throttle: 1, brake: 0, steer: 0.05 }; }, setPace: function () {}, opponent: {} };
  var car = { id: 'x', f1: { ers: { soc: 0.8, mode: 'auto' }, drs: { available: true } }, raceDist: 3000, lapS: 100 };
  var w = CB.f1.ai.wrapDriver(base, car, { skill: 0.9 }, {});
  var out = w.control({ speed: 80 }, { phase: 'racing', t: 10, lap: 2, nearby: [{ id: 'y', ds: 30, speed: 79 }], trackLength: 5000 }, 1 / 120);
  assert.strictEqual(calls, 1);
  assert.strictEqual(out.throttle, 1);
  assert.ok(car.f1Intent && car.f1Intent.drs && car.f1Intent.ersBoost, JSON.stringify(car.f1Intent));
  assert.strictEqual(car.f1.aiDrs, true);
  assert.strictEqual(car.f1.aiBoost, true);
  assert.strictEqual(CB.f1.ai.wrapDriver(null, car, {}), null);
});

test('difficulty orders pace: Alien < Pro < Amateur < Rookie (clean hot laps, Red Bull Ring)', function () {
  var def = C.get('f1-red-bull-ring'), t = {};
  ['alien', 'pro', 'amateur', 'rookie'].forEach(function (d) {
    var r = tool.hotLap(def, d, { laps: 2 });
    assert.ok(r.best, d + ': no lap');
    assert.strictEqual(r.walls, 0, d + ': wall hits');
    t[d] = r.best;
  });
  assert.ok(t.alien < t.pro && t.pro < t.amateur && t.amateur < t.rookie, JSON.stringify(t));
  assert.ok(t.rookie / t.alien < 1.15, 'field spread too wide: ' + JSON.stringify(t));
});

test('clean races on F1 circuits (5 cars, 2 laps' + (FULL ? ', all circuits' : '') + '): all finish, no DNF, few contacts / wall hits', function () {
  var bad = [];
  circuitIds().forEach(function (id) {
    var def = C.get(id);
    var r = tool.race(def, { cars: 5, laps: 2, seed: 5 });
    var ok = r.dnf === 0 && r.finished === 5 && r.contacts <= 4 && r.wallHits <= 3 && r.offTrack_s <= 5;
    if (!ok) bad.push(def.id + ' ' + JSON.stringify({ fin: r.finished, dnf: r.dnf, contacts: r.contacts, walls: r.wallHits, off: r.offTrack_s }));
    r = null;
  });
  assert.deepStrictEqual(bad, []);
});

test('full 22-car grid (Red Bull Ring, time-capped at 230 s): no DNF, clean-ish T1, DRS opened on lap 3', function () {
  var r = tool.race(C.get('f1-red-bull-ring'), { cars: 22, laps: 3, seed: 11, maxSim_s: 230 });
  assert.strictEqual(r.cars, 22);
  assert.strictEqual(r.dnf, 0);
  assert.ok(r.lap1Contacts <= 16, 'lap-1 contacts ' + r.lap1Contacts);   // 22 cars into T1: ~10 light touches typical (tools/f1-laptimes.js)
  assert.ok(r.wallHits <= 3, 'walls ' + r.wallHits);
  assert.ok(r.drsUses >= 1, 'no DRS use');   // race rules: within 1 s at detection, from lap 3
  r = null;
});

test('pit stops by strategy: high-wear race, every car stops and uses two dry compounds (no penalty)', function () {
  var r = tool.race(C.get('f1-monza'), { cars: 6, laps: 5, wearMult: 5, twoCompound: true, seed: 3 });
  assert.strictEqual(r.dnf, 0);
  r.results.classification.forEach(function (c) {
    var used = (c.endurance && c.endurance.f1 && c.endurance.f1.compoundsUsed) || [];
    assert.ok(c.pitStops >= 1, c.name + ' did not stop');
    assert.ok(used.length >= 2, c.name + ' used ' + used.join(','));
    assert.ok(!c.penalties_s, c.name + ' penalised ' + c.penalties_s);
  });
});

test('deterministic: the same seed gives the same race', function () {
  function run() {
    var r = tool.race(C.get('f1-zandvoort'), { cars: 4, laps: 1, seed: 21 });
    return r.results.classification.map(function (c) { return c.id + ':' + (c.raceTime_s || 0).toFixed(3); }).join(' ');
  }
  assert.strictEqual(run(), run());
});

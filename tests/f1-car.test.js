/* Node tests: the single-spec F1 car (js/f1/f1-car.js, docs/F1-SPEC.md §3).
   - spec parameters (800 kg, ~1000 hp hybrid, 8-speed seamless) and the measured performance on CB.race.vehicle:
     0–100 ≈ 2.6 s, top ≈ 340–350 km/h with DRS, 200→0 ≈ 55 m, ≈ 5 g at 300 km/h, 4–5 g in fast corners
   - stability at 1/120 s under random inputs
   - tyres: warm-up, cooling, wear by compound and by driving, grip windows, wet / dry compounds
   - DRS rules, ERS store / deploy / harvest, pit-stop timing */
'use strict';
var assert = require('assert');
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/f1/f1-teams.js', 'js/f1/f1-car.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, V = CB.race.vehicle, C = CB.f1.car;
var R = require(path.join(root, 'tools', 'f1-physics-report.js'));

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  name = 'f1-car: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function near(v, lo, hi, what) { assert.ok(v >= lo && v <= hi, what + ' = ' + v + ' (expected ' + lo + '…' + hi + ')'); }
var M = null;
function meas() { return M || (M = R.measure()); }

test('spec: 800 kg, ~1000 hp hybrid, 8-speed seamless, every variant cached and frozen', function () {
  var p = C.params();
  assert.strictEqual(p.mass, 800);
  assert.strictEqual(p.maxGear, 8);
  assert.strictEqual(p.shiftCut, 1, 'seamless: torque carried through the shift');
  assert.ok(p.shiftTime <= 0.05);
  near(p.power_hp, 960, 1020, 'power hp (ICE + ERS)');
  near(C.params({ ers: false }).power_hp, 780, 830, 'ICE only hp');
  assert.ok(Object.isFrozen(p));
  assert.strictEqual(C.params(), p, 'cached');
  assert.ok(C.params({ drsOpen: true }).cdA < p.cdA * 0.8, 'DRS cuts drag');
  assert.ok(C.params({ drsOpen: true }).clA < p.clA, 'DRS loses rear downforce');
  // downforce ~2x weight at 250 km/h, ~3x at 300
  var df = function (kph) { var v = kph / 3.6; return 0.5 * 1.225 * p.clA * v * v / (p.mass * 9.81); };
  near(df(250), 1.8, 2.4, 'downforce/weight at 250');
  near(df(300), 2.6, 3.4, 'downforce/weight at 300');
});

test('acceleration: 0–100 ≈ 2.6 s, 0–200 ≈ 4.7 s', function () {
  near(meas().zeroTo100_s, 2.4, 2.85, '0–100 s');
  near(meas().zeroTo200_s, 4.2, 5.2, '0–200 s');
});

test('top speed: 340–350 km/h with ERS + DRS, less without', function () {
  var m = meas();
  near(m.top_ers_drs_kph, 338, 356, 'top ERS + DRS');
  near(m.top_ers_kph, 318, 340, 'top ERS, DRS shut');
  assert.ok(m.top_noErs_kph < m.top_ers_kph - 10, 'ERS deploy is worth > 10 km/h');
});

test('braking: 200→0 ≈ 55 m, ≈ 5 g at 300 km/h (aero), much less at low speed', function () {
  var m = meas();
  near(m.brake200_m, 47, 62, '200→0 m');
  near(m.brakePeak300_g, 4.4, 5.8, 'peak g from 300');
  assert.ok(C.params().capabilities.maxBrakeG < 2.4, 'low-speed braking is grip limited (~2 g)');
});

test('cornering: 4–5 g in fast corners, ~2–2.5 g in slow ones', function () {
  var m = meas();
  near(m.lat250_g, 4.0, 5.2, 'lateral g at 250');
  near(m.lat200_g, 3.0, 4.2, 'lateral g at 200');
  near(m.lat120_g, 1.9, 2.8, 'lateral g at 120');
  assert.ok(m.lat300_g > m.lat200_g, 'downforce: more grip with speed');
});

test('stable at 1/120 s with random inputs (no NaN, no runaway yaw)', function () {
  var p = C.params(), s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 0, autoShift: true });
  var seed = 12345; function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  var inp = { throttle: 0, brake: 0, steer: 0 };
  for (var i = 0; i < 120 * 90; i++) {
    if (i % 30 === 0) inp = { throttle: rnd(), brake: rnd() < 0.3 ? rnd() : 0, steer: rnd() * 2 - 1 };
    V.step(p, s, inp, 1 / 120, { gripMult: 1, wetness: 0, assists: { abs: true, tc: true, autoShift: true }, wheelGrip: [1, 1, 1, 1] });
    assert.ok(isFinite(s.x) && isFinite(s.vx) && isFinite(s.yawRate), 'finite at step ' + i);
    assert.ok(Math.abs(s.yawRate) < 12, 'yaw rate bounded');
    assert.ok(s.speed < 105, 'speed bounded');
  }
});

test('analog steering is proportional: half steer turns about half as hard as full steer', function () {
  var p = C.params();
  function yawAt(steer) {
    var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 30, autoShift: true });
    for (var i = 0; i < 240; i++) V.step(p, s, { throttle: 0.3, brake: 0, steer: steer }, 1 / 120, R.ENV);
    return Math.abs(s.yawRate);
  }
  var a = yawAt(0.15), b = yawAt(0.3), full = yawAt(1);
  assert.ok(b > a * 1.6 && b < a * 2.4, 'linear range: ' + a + ' -> ' + b);
  assert.ok(full > b * 0.8, 'full lock still turns (grip limited, no collapse): ' + full);
});

/* ---------------- tyres ---------------- */
function drivenState(level) {
  // a vehicle state shaped like CB.race.vehicle's with per-wheel forces / slips (level 0..1 = how hard it is pushed)
  var w = [];
  for (var i = 0; i < 4; i++) w.push({ fx: 3000 * level, fy: 9000 * level, kappa: 0.06 * level, alpha: 0.09 * level, _wvx: 60, load: 5000, locked: false });
  return { vx: 60, wheels: w };
}
test('tyres: blankets ≈ 75 °C, hard driving heats into the window, a parked car cools', function () {
  var ts = C.createTyres('medium');
  near(ts.temp[0], 60, 85, 'blanket temp');
  for (var i = 0; i < 120 * 60; i++) C.stepTyres(ts, drivenState(0.8), 1 / 120, { wetness: 0 });
  assert.ok(ts.temp[0] > 90, 'pushing heats the tyre: ' + ts.temp[0]);
  var hot = ts.temp[0];
  for (i = 0; i < 120 * 60; i++) C.stepTyres(ts, { vx: 0, wheels: [{}, {}, {}, {}] }, 1 / 120, { wetness: 0 });
  assert.ok(ts.temp[0] < hot - 10, 'cools when parked');
});
test('tyres: wear grows with slip, softs wear faster than hards, worn tyres lose grip (cliff)', function () {
  function wearAfter(comp, level) { var ts = C.createTyres(comp); for (var i = 0; i < 120 * 25; i++) C.stepTyres(ts, drivenState(level), 1 / 120, { wetness: 0 }); return ts.wear[0]; }
  var sHard = wearAfter('soft', 0.8), sEasy = wearAfter('soft', 0.4), hHard = wearAfter('hard', 0.8);
  assert.ok(sHard > sEasy * 1.8, 'pushing wears more: ' + sHard + ' vs ' + sEasy);
  assert.ok(sHard > hHard * 1.6, 'soft wears faster than hard: ' + sHard + ' vs ' + hHard);
  var fresh = C.tyreFactor('medium', 100, 0, 0), half = C.tyreFactor('medium', 100, 0.5, 0), dead = C.tyreFactor('medium', 100, 0.98, 0);
  assert.ok(fresh > half && half > dead, 'grip falls with wear');
  assert.ok(fresh - half < 0.05, 'gentle before the cliff');
  assert.ok(half - dead > 0.2, 'the cliff');
});
test('tyres: grip windows (cold and overheated tyres lose grip), soft > medium > hard when warm', function () {
  assert.ok(C.tyreFactor('soft', 50, 0, 0) < C.tyreFactor('soft', 100, 0, 0) - 0.1, 'cold soft');
  assert.ok(C.tyreFactor('soft', 140, 0, 0) < C.tyreFactor('soft', 100, 0, 0), 'overheated soft');
  assert.ok(C.tyreFactor('soft', 100, 0, 0) > C.tyreFactor('medium', 105, 0, 0));
  assert.ok(C.tyreFactor('medium', 105, 0, 0) > C.tyreFactor('hard', 110, 0, 0));
});
test('tyres: wet compounds win in the wet, slicks in the dry; tyreGrip is per wheel', function () {
  var slickWet = C.tyreFactor('medium', 90, 0, 1), wetWet = C.tyreFactor('wet', 65, 0, 1), interDamp = C.tyreFactor('inter', 75, 0, 0.5), slickDamp = C.tyreFactor('medium', 95, 0, 0.5);
  assert.ok(wetWet > slickWet * 1.4, 'full wets in the wet');
  assert.ok(interDamp > slickDamp, 'inters on a damp track');
  assert.ok(C.tyreFactor('medium', 100, 0, 0) > C.tyreFactor('inter', 75, 0, 0), 'slicks in the dry');
  var ts = C.createTyres('soft'); ts.wear[2] = 0.95;
  var g = C.tyreGrip(ts, 0);
  assert.strictEqual(g.length, 4);
  assert.ok(g[2] < g[0], 'worn rear-left has less grip');
});

/* ---------------- DRS / ERS / pit ---------------- */
test('DRS rules: race within 1.0 s at detection from lap 3; practice / qualifying free; wet disabled', function () {
  var E = C.drs.eligibleAt;
  assert.strictEqual(E({ mode: 'race', lap: 3, gap_s: 0.8 }), true);
  assert.strictEqual(E({ mode: 'race', lap: 3, gap_s: 1.2 }), false, 'outside 1 s');
  assert.strictEqual(E({ mode: 'race', lap: 2, gap_s: 0.3 }), false, 'not before lap 3');
  assert.strictEqual(E({ mode: 'practice', lap: 1, gap_s: Infinity }), true, 'practice: free');
  assert.strictEqual(E({ mode: 'qualifying', lap: 1 }), true, 'qualifying: free');
  assert.strictEqual(E({ mode: 'race', lap: 5, gap_s: 0.2, weather: 'wet' }), false, 'wet');
  var zones = [{ detect_s: 4800, start_s: 5000, end_s: 300 }, { detect_s: 1500, start_s: 1700, end_s: 2300 }];
  assert.strictEqual(C.drs.zoneAt(zones, 5100), 0);
  assert.strictEqual(C.drs.zoneAt(zones, 100), 0, 'zone across the line');
  assert.strictEqual(C.drs.zoneAt(zones, 2000), 1);
  assert.strictEqual(C.drs.zoneAt(zones, 1000), -1);
});
test('ERS: auto deploys on straights and drains, braking harvests, harvest mode never deploys, boost deploys anywhere', function () {
  var es = C.ers.create({ soc: 0.9 }), dt = 1 / 120, i;
  for (i = 0; i < 120 * 10; i++) C.ers.step(es, dt, { throttle: 1, speed: 70, gear: 6, mass: 800 });
  assert.ok(es.deploying, 'deploying at full throttle');
  assert.ok(es.soc < 0.75, 'drained: ' + es.soc);
  var before = es.soc;
  for (i = 0; i < 120 * 3; i++) C.ers.step(es, dt, { throttle: 0, brake: 1, speed: 60, gear: 4, mass: 800 });
  assert.ok(es.soc > before + 0.05 && es.harvesting, 'harvested under braking');
  es.mode = 'harvest';
  for (i = 0; i < 120 * 3; i++) C.ers.step(es, dt, { throttle: 1, speed: 70, gear: 6, mass: 800 });
  assert.ok(!es.deploying, 'harvest mode never deploys');
  es.mode = 'auto';
  C.ers.step(es, dt, { throttle: 1, speed: 15, gear: 1, mass: 800 });
  assert.ok(!es.deploying, 'auto: not in a slow 1st-gear corner exit');
  C.ers.step(es, dt, { throttle: 1, speed: 15, gear: 1, mass: 800, boostHeld: true });
  assert.ok(es.deploying, 'boost button deploys anywhere');
  var lim = C.ers.create({ soc: 1 });
  for (i = 0; i < 120 * 60; i++) C.ers.step(lim, dt, { throttle: 1, speed: 80, gear: 7, mass: 800 });
  assert.ok(lim.lapDeploy_J <= C.ers.LAP_DEPLOY_J + C.ers.DEPLOY_W * dt * 2, 'per-lap deploy limit (4 MJ)');
});
test('pit stops: ≈ 2.5 s stationary on average, deterministic per rng', function () {
  var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  var t = [], sum = 0;
  for (var i = 0; i < 400; i++) { var d = C.pitStopTime(rnd); t.push(d); sum += d; }
  near(sum / t.length, 2.3, 2.75, 'mean stop');
  assert.ok(Math.min.apply(null, t) >= 2.0 && Math.max.apply(null, t) < 6, 'range');
  assert.strictEqual(C.pitStopTime(function () { return 0.5; }), C.pitStopTime(function () { return 0.5; }));
});

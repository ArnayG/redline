/* Node tests for js/race/vehicle.js
   Run standalone: node tests/race-vehicle.test.js   (or via node tests/run.js)
   Uses the real CB.data / CB.physics when present & loadable; otherwise falls back to a
   self-contained fixture build so the vehicle model is verifiable in isolation. */
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
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(tryLoad);
var V = require(path.join(root, 'js', 'race', 'vehicle.js'));
var CB = globalThis.CB;

/* ------------------------------------------------------------ harness */
var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  name = 'vehicle: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ------------------------------------------------------------ fixtures */
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function merge(a, b) {
  for (var k in b) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') merge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}
/** Self-contained 500 hp-class RWD coupe (shape per SPEC.md defaultBuild). */
var FIXTURE = {
  version: 1,
  meta: { name: 'Fixture 500', id: 'b_fixture', created: 0, modified: 0, presetId: null },
  body: { style: 'coupe', chassisMaterial: 'aluminum', wheelbase_mm: 2650, trackWidth_mm: 1600, doors: 2, seats: 2 },
  engine: {
    type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 0.8, compression: 10.0,
    fuel: 'premium', redline_rpm: 7200, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard',
    motors: 1, motorPower_kw: 100, battery_kwh: 10, chemistry: 'nmc', voltage: 400, regen: 0
  },
  transmission: { type: 'dct', gears: 7, ratios: [3.8, 2.6, 1.9, 1.45, 1.15, 0.95, 0.78], finalDrive: 3.42, launchControl: true },
  drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
  suspension: { type: 'double-wishbone', springFront_nmm: 60, springRear_nmm: 70, damping: 5, rideHeight_mm: 120,
    camberFront_deg: -1.5, camberRear_deg: -1.0, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4 },
  brakes: { material: 'iron', frontRotor_mm: 380, rearRotor_mm: 350, frontPistons: 6, rearPistons: 4, abs: 'sport' },
  wheels: { design: 'y-spoke', material: 'forged', diameter_in: 19, widthFront_in: 9, widthRear_in: 10.5, finish: '#222222', staggered: true },
  tires: { compound: 'performance', widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 },
  aero: { splitter: 'lip', wing: 'none', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
  weight: { soundDeadening: true, rearSeats: false, spareTire: false, glass: 'standard', battery: 'lead', rollCage: 'none', ballast_kg: 0, ballastPosition: 'center' },
  exterior: { paint: '#b3121f' }, interior: { steering: 'round' }, tech: {}
};
var FIXTURE_METRICS = { power_hp: 500, power_kw: 373, weight_kg: 1500, weightFront_pct: 52, zeroTo100_s: 4.2 };

function baseBuild(patch) {
  var b;
  if (CB.data && typeof CB.data.defaultBuild === 'function') {
    try { b = merge(CB.data.defaultBuild(), clone(FIXTURE)); } catch (e) { b = clone(FIXTURE); }
  } else b = clone(FIXTURE);
  if (patch) merge(b, clone(patch));
  if (CB.state && typeof CB.state.normalize === 'function') { try { b = CB.state.normalize(b) || b; } catch (e) { /* keep */ } }
  return b;
}
function metricsFor(build) {
  if (CB.physics && typeof CB.physics.compute === 'function') {
    try { return CB.physics.compute(build); } catch (e) { /* fall through */ }
  }
  return null;
}
/** Params with no physics dependency (pure build + catalog derivation). */
function derived(patch) { return V.fromBuild(baseBuild(patch), null, { noPhysics: true }); }

var DT = 1 / 120;
var ENV = { gripMult: 1, wet: 0 };
function finiteState(s) {
  return ['x', 'y', 'heading', 'vx', 'vy', 'yawRate', 'speed', 'rpm', 'steerAngle', 'slipAngleF', 'slipAngleR', 'wheelspin', 'skidding']
    .every(function (k) { return typeof s[k] === 'number' && isFinite(s[k]); });
}
function run(p, s, seconds, inputFn, env) {
  var n = Math.round(seconds / DT);
  for (var i = 0; i < n; i++) V.step(p, s, inputFn(s, i * DT), DT, env || ENV);
  return s;
}
/** Hold a target speed with a P controller on throttle/brake. */
function cruise(target, steer) {
  return function (s) {
    var e = target - s.vx;
    return { throttle: Math.max(0, Math.min(1, e * 0.6 + 0.15)), brake: e < -1.5 ? Math.min(1, -e * 0.2) : 0, steer: steer, handbrake: false };
  };
}
/** Steady-state lateral acceleration (g) on a constant radius-ish circle at speed v. */
function steadyLatG(p, v, steer, env) {
  var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: v });
  run(p, s, 8, cruise(v, steer), env);
  var acc = 0, n = 0, spun = false;
  run(p, s, 2, function (st) {
    acc += Math.abs(st.ay); n++;
    if (Math.abs(st.beta) > 0.3 || st.vx < v * 0.6) spun = true;
    return cruise(v, steer)(st);
  }, env);
  // a spun / sliding car is not a valid steady-state sample
  return { g: spun ? 0 : acc / n / 9.81, state: s, spun: spun };
}
/** Max sustainable lateral g: sweep speeds on full lock-limited steer, keep best. */
function maxLatG(p, env) {
  var best = 0;
  for (var v = 16; v <= 40; v += 4) {
    var r = steadyLatG(p, v, 1, env);
    if (finiteState(r.state) && r.g > best) best = r.g;
  }
  return best;
}

/* -------------------------------------------------------------- tests */

test('module shape & exports', function () {
  ['fromBuild', 'createState', 'step', 'reset', 'worldVelocity', 'setWorldVelocity', 'applyImpulse', 'wheelPositions', 'simulateLaunch']
    .forEach(function (k) { assert.strictEqual(typeof V[k], 'function', k); });
  assert.strictEqual(CB.race.vehicle, V);
});

test('fromBuild(build, null) derives complete, finite, frozen params without CB.physics', function () {
  var p = derived();
  assert.ok(Object.isFrozen(p), 'params frozen');
  ['mass', 'cgHeight', 'wheelbase', 'a', 'b', 'Iz', 'muF', 'muR', 'cdA', 'clA', 'powerKw', 'peakNm', 'redline', 'finalDrive',
    'brakeForceMax', 'maxBrakeTorqueF', 'maxBrakeTorqueR', 'lockR', 'radiusF', 'radiusR', 'maxLatG', 'maxBrakeG', 'topSpeed_ms']
    .forEach(function (k) { assert.ok(typeof p[k] === 'number' && isFinite(p[k]), k + ' = ' + p[k]); });
  assert.ok(Math.abs(p.a + p.b - p.wheelbase) < 1e-9, 'a + b = wheelbase');
  assert.ok(p.mass > 900 && p.mass < 2500, 'plausible mass ' + p.mass);
  assert.ok(p.power_hp > 250 && p.power_hp < 1000, 'plausible power ' + p.power_hp);
  assert.strictEqual(p.ratios.length, p.maxGear);
  assert.strictEqual(p.layout, 'rwd');
  assert.ok(p.torqueTable.every(isFinite));
  assert.ok(p.maxLatG > 0.7 && p.maxLatG < 1.6, 'maxLatG ' + p.maxLatG);
});

test('fromBuild tolerates empty / garbage builds', function () {
  [{}, null, undefined, { engine: { type: 'ev', motors: 'x' } }, { engine: { type: 'ice', layout: 'nope', displacement_l: -4 }, transmission: { ratios: ['a', null] } }]
    .forEach(function (b) {
      var p = V.fromBuild(b, null, { noPhysics: true });
      assert.ok(isFinite(p.mass) && isFinite(p.powerKw) && p.maxGear >= 1);
      var s = V.createState(p, {});
      run(p, s, 3, function () { return { throttle: 1, brake: 0, steer: 0.3 }; });
      assert.ok(finiteState(s) && s.speed > 1, 'drives');
    });
});

test('fromBuild honours supplied metrics (mass, power, weight split)', function () {
  var p = V.fromBuild(baseBuild(), FIXTURE_METRICS);
  assert.strictEqual(p.source, 'metrics');
  assert.ok(Math.abs(p.mass - 1500) < 1e-6);
  assert.ok(Math.abs(p.weightFront - 0.52) < 1e-9);
  assert.ok(Math.abs(p.power_hp - 500) / 500 < 0.06, 'power ' + p.power_hp);
});

test('createState exposes the contract fields', function () {
  var p = derived();
  var s = V.createState(p, { x: 10, y: -5, heading: 1.2 });
  ['x', 'y', 'heading', 'vx', 'vy', 'yawRate', 'speed', 'rpm', 'gear', 'slipAngleF', 'slipAngleR', 'wheelspin', 'skidding', 'steerAngle']
    .forEach(function (k) { assert.ok(k in s, k); });
  assert.strictEqual(s.x, 10); assert.strictEqual(s.y, -5); assert.strictEqual(s.gear, 1);
  assert.ok(finiteState(s));
});

test('stationary car with no input stays put (low-speed stability)', function () {
  var p = derived();
  var s = V.createState(p, {});
  run(p, s, 10, function () { return { throttle: 0, brake: 0, steer: 0 }; });
  assert.ok(s.speed < 0.3 && Math.hypot(s.x, s.y) < 1.0, 'drift ' + s.x + ',' + s.y);
  run(p, s, 5, function (st, t) { return { throttle: 0, brake: 0, steer: Math.sin(t * 5) }; });
  assert.ok(Math.abs(s.yawRate) < 0.05, 'no yaw from steering at rest');
});

test('0-100 km/h within 25% of expected for a ~500 hp coupe', function () {
  var b = baseBuild();
  var M = metricsFor(b);
  var p, expected;
  if (M && isFinite(M.zeroTo100_s)) { p = V.fromBuild(b, M); expected = M.zeroTo100_s; }
  else { p = V.fromBuild(b, FIXTURE_METRICS); expected = FIXTURE_METRICS.zeroTo100_s; }
  var r = V.simulateLaunch(p, 100);
  assert.ok(r.t != null, 'reaches 100');
  var err = Math.abs(r.t - expected) / expected;
  console.log('      0-100: sim ' + r.t.toFixed(2) + ' s vs expected ' + expected.toFixed(2) + ' s (' + (err * 100).toFixed(0) + '%), ' + p.power_hp.toFixed(0) + ' hp / ' + p.mass.toFixed(0) + ' kg');
  assert.ok(err < 0.25, 'sim ' + r.t + ' vs ' + expected);
  // the derived-only path is also in a sane band
  var rd = V.simulateLaunch(derived(), 100);
  assert.ok(rd.t > 2.5 && rd.t < 7.5, 'derived 0-100 ' + rd.t);
});

test('upshifts through the gears and reaches a plausible top speed', function () {
  var p = derived();
  var r = V.simulateLaunch(p, 999, { tMax: 70 });
  var vmax = r.state.vx * 3.6;
  assert.ok(r.state.gear >= p.maxGear - 1, 'gear ' + r.state.gear);
  assert.ok(vmax > 230 && vmax < 400, 'vmax ' + vmax);
  assert.ok(r.state.rpm <= p.limiterRpm + 200);
});

test('more power accelerates harder', function () {
  var lo = V.fromBuild(baseBuild({ engine: { boost_bar: 0.3, tune: 'eco' } }), null, { noPhysics: true });
  var hi = V.fromBuild(baseBuild({ engine: { boost_bar: 1.8, tune: 'stage2' } }), null, { noPhysics: true });
  assert.ok(hi.powerKw > lo.powerKw * 1.2, 'power differs');
  var tLo = V.simulateLaunch(lo, 200, { tMax: 60 }).t, tHi = V.simulateLaunch(hi, 200, { tMax: 60 }).t;
  assert.ok(tLo != null && tHi != null);
  assert.ok(tHi < tLo * 0.92, '0-200 hi ' + tHi + ' lo ' + tLo);
  // same mass, synthetic metrics: +60 % power => faster 0-100 too
  var a = V.fromBuild(baseBuild(), { power_hp: 300, weight_kg: 1500 }), c = V.fromBuild(baseBuild(), { power_hp: 480, weight_kg: 1500 });
  assert.ok(V.simulateLaunch(c, 100).t < V.simulateLaunch(a, 100).t);
});

test('heavier car brakes longer', function () {
  function stopDist(p) {
    var s = V.createState(p, { speed: 100 / 3.6, gear: 4 });
    var x0 = s.x, stopX = null;
    // (holding the brake at standstill selects reverse, so record the first stop)
    run(p, s, 8, function (st) { if (stopX == null && st.speed < 0.2) stopX = st.x; return { throttle: 0, brake: 1, steer: 0 }; });
    assert.ok(stopX != null, 'stopped');
    return stopX - x0;
  }
  var light = V.fromBuild(baseBuild(), { power_hp: 500, weight_kg: 1300 });
  var heavy = V.fromBuild(baseBuild(), { power_hp: 500, weight_kg: 2500 });
  var dl = stopDist(light), dh = stopDist(heavy);
  assert.ok(dl > 25 && dl < 55, '100-0 ' + dl);
  assert.ok(dh > dl * 1.04, 'heavy ' + dh + ' light ' + dl);
});

test('steady circle: bounded, finite, yaw consistent with steer direction', function () {
  var p = derived();
  [8, 20, 35].forEach(function (v) {
    [0.4, -0.4, 1].forEach(function (st) {
      var r = steadyLatG(p, v, st);
      assert.ok(finiteState(r.state), 'finite at ' + v + '/' + st);
      assert.ok(r.g < 2.0, 'lat g bounded ' + r.g);
      assert.ok(Math.abs(r.state.yawRate) < 3, 'yaw bounded');
      if (st > 0) assert.ok(r.state.yawRate > 0, '+steer turns left (CCW) at ' + v);
      else assert.ok(r.state.yawRate < 0, '-steer turns right at ' + v);
    });
  });
});

test('slicks generate more lateral g than eco tyres', function () {
  var eco = derived({ tires: { compound: 'eco' } });
  var slick = derived({ tires: { compound: 'slick' } });
  var gEco = maxLatG(eco), gSlick = maxLatG(slick);
  console.log('      lat g: eco ' + gEco.toFixed(2) + ', slick ' + gSlick.toFixed(2));
  assert.ok(gEco > 0.5 && gEco < 1.2, 'eco ' + gEco);
  assert.ok(gSlick > gEco * 1.25, 'slick ' + gSlick + ' eco ' + gEco);
  assert.ok(slick.maxLatG > eco.maxLatG);
});

test('surface grip multiplier and wet reduce cornering grip', function () {
  var p = derived();
  var dry = maxLatG(p), grass = maxLatG(p, { gripMult: 0.55, surface: 'grass' }), wet = maxLatG(p, { gripMult: 1, wet: 1 });
  assert.ok(grass < dry * 0.8, 'grass ' + grass + ' dry ' + dry);
  assert.ok(wet < dry * 0.95, 'wet ' + wet + ' dry ' + dry);
  // engine-style env (weather factor already in gripMult): slicks suffer far more than road tyres
  var envWet = { gripMult: 0.8, wet: true, wetness: 1 };
  var road = derived({ tires: { compound: 'performance' } }), slick = derived({ tires: { compound: 'slick' } });
  var rRoad = maxLatG(road, envWet) / maxLatG(road), rSlick = maxLatG(slick, envWet) / maxLatG(slick);
  assert.ok(rSlick < rRoad * 0.75, 'wet ratio slick ' + rSlick + ' road ' + rRoad);
  // damp (wetness 0.5) sits between
  var damp = maxLatG(p, { gripMult: 0.9, wet: false, wetness: 0.5 });
  assert.ok(damp < dry && damp > maxLatG(p, envWet), 'damp ' + damp);
});

test('downforce helps at speed', function () {
  var noAero = derived({ aero: { splitter: 'none', wing: 'none', diffuser: 'none', sideSkirts: false } });
  var aero = derived({ aero: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 12, diffuser: 'race' } });
  assert.ok(aero.clA > noAero.clA + 0.5);
  assert.ok(V.latAccelAt(aero, 60) > V.latAccelAt(noAero, 60) * 1.1);
  var gA = steadyLatG(aero, 50, 0.6).g, gN = steadyLatG(noAero, 50, 0.6).g;
  assert.ok(gA >= gN * 0.98, 'aero ' + gA + ' vs ' + gN);
});

test('stable at 0-400 km/h at dt 1/120 (straight + steer + brake)', function () {
  var p = V.fromBuild(baseBuild({ body: { style: 'hypercar' }, engine: { layout: 'W16', displacement_l: 8.0, boost_bar: 2.0, tune: 'stage2', position: 'mid' },
    drivetrain: { layout: 'awd', torqueSplitFront_pct: 40, centerDiff: 'lsd-viscous' }, tires: { compound: 'track' } }), null, { noPhysics: true });
  [0, 50, 150, 300, 400].forEach(function (kph) {
    var s = V.createState(p, { speed: kph / 3.6 });
    run(p, s, 2, function (st, t) { return { throttle: 1, brake: 0, steer: 0.15 * Math.sin(t * 3) }; });
    run(p, s, 1, function () { return { throttle: 0, brake: 1, steer: 0.2 }; });
    assert.ok(finiteState(s), 'finite at ' + kph);
    assert.ok(s.speed < 130, 'sane at ' + kph + ': ' + s.speed);
    assert.strictEqual(s.nanGuard, 0, 'no NaN recovery at ' + kph);
  });
});

test('no NaN after 60 s of random inputs (several layouts)', function () {
  var seed = 12345;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  var builds = [
    derived(),
    derived({ drivetrain: { layout: 'fwd', torqueSplitFront_pct: 100 }, engine: { layout: 'I4', displacement_l: 2.0 } }),
    derived({ drivetrain: { layout: 'awd', torqueSplitFront_pct: 40, centerDiff: 'lsd-torsen', torqueVectoring: true } }),
    derived({ engine: { type: 'ev', motors: 4, motorPower_kw: 250, battery_kwh: 100 }, transmission: { type: 'single-speed', gears: 1, ratios: [1] }, drivetrain: { layout: 'awd' } }),
    derived({ transmission: { type: 'cvt', gears: 1, ratios: [1] } }),
    derived({ transmission: { type: 'manual', gears: 6, ratios: [3.6, 2.2, 1.55, 1.2, 0.98, 0.82] }, brakes: { abs: 'off' }, drivetrain: { tractionControl: 0 } })
  ];
  builds.forEach(function (p, bi) {
    var s = V.createState(p, {});
    var inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    var n = Math.round(60 / DT);
    for (var i = 0; i < n; i++) {
      if (i % 30 === 0) {
        inp = { throttle: rnd() < 0.7 ? rnd() : 0, brake: rnd() < 0.25 ? rnd() : 0, steer: rnd() * 2 - 1, handbrake: rnd() < 0.05,
          shiftUp: rnd() < 0.05, shiftDown: rnd() < 0.05 };
      } else { inp.shiftUp = false; inp.shiftDown = false; }
      var env = { gripMult: 0.4 + rnd() * 0.7, wet: rnd() < 0.3 ? 1 : 0 };
      V.step(p, s, inp, DT, env);
      if (!finiteState(s)) assert.fail('non-finite state in build ' + bi + ' at step ' + i + ': ' + JSON.stringify(s));
    }
    assert.strictEqual(s.nanGuard, 0, 'build ' + bi + ' never needed NaN recovery');
    assert.ok(s.speed < 150, 'speed sane ' + s.speed);
    s.wheels.forEach(function (w) { assert.ok(isFinite(w.omega) && isFinite(w.load) && w.load >= 0); });
  });
  // variable / large dt are clamped and substepped
  var p = derived(), s = V.createState(p, {});
  [0, 1 / 30, 0.1, 0.5, -1, NaN].forEach(function (dt) { V.step(p, s, { throttle: 1, steer: 0.5 }, dt, ENV); });
  assert.ok(finiteState(s));
});

test('reverse: brake held while stopped selects reverse and backs up; throttle returns to 1st', function () {
  var p = derived();
  var s = V.createState(p, {});
  run(p, s, 3, function () { return { throttle: 0, brake: 1, steer: 0 }; });
  assert.strictEqual(s.gear, -1, 'reverse selected');
  assert.ok(s.vx < -1, 'moving backwards ' + s.vx);
  assert.ok(s.vx > -15, 'reverse speed limited-ish');
  run(p, s, 3, function () { return { throttle: 1, brake: 0, steer: 0 }; });
  assert.ok(s.gear >= 1, 'forward gear again');
  assert.ok(s.vx > 1, 'moving forward ' + s.vx);
});

test('manual gearbox: edge-triggered shiftUp / shiftDown', function () {
  var p = derived();
  var s = V.createState(p, { autoShift: false });
  run(p, s, 1.5, function () { return { throttle: 1 }; });
  assert.strictEqual(s.gear, 1, 'no auto upshift in manual');
  V.step(p, s, { throttle: 1, shiftUp: true }, DT, ENV);
  assert.strictEqual(s.gear, 2);
  run(p, s, 0.6, function () { return { throttle: 1 }; });
  V.step(p, s, { throttle: 1, shiftUp: true }, DT, ENV);
  assert.strictEqual(s.gear, 3);
  run(p, s, 0.6, function () { return { throttle: 0.5 }; });
  V.step(p, s, { throttle: 0, shiftDown: true }, DT, ENV);
  assert.strictEqual(s.gear, 2);
  // limiter holds rpm in a low gear
  run(p, s, 6, function () { return { throttle: 1 }; });
  assert.ok(s.rpm <= p.limiterRpm + 200, 'rev limiter ' + s.rpm);
});

test('auto gearbox hysteresis: no gear hunting at steady cruise', function () {
  var p = derived();
  var s = V.createState(p, { speed: 25, gear: 3 });
  var shifts = 0, last = s.gear;
  run(p, s, 10, function (st) { if (st.gear !== last) { shifts++; last = st.gear; } return cruise(25, 0)(st); });
  assert.ok(shifts <= 3, 'shifts ' + shifts);
});

test('handbrake locks the rears and induces rotation', function () {
  var p = derived();
  var a = V.createState(p, { speed: 20 }), b = V.createState(p, { speed: 20 });
  run(p, a, 1.0, function () { return { throttle: 0, steer: 0.35 }; });
  run(p, b, 1.0, function () { return { throttle: 0, steer: 0.35, handbrake: true }; });
  assert.ok(b.wheels[2].locked || Math.abs(b.wheels[2].omega) < 1, 'rear locked');
  assert.ok(b.speed < a.speed, 'handbrake slows');
  assert.ok(Math.abs(b.slipAngleR) > Math.abs(a.slipAngleR), 'rear slides more');
  assert.ok(finiteState(b));
});

test('ABS keeps steering authority under full braking', function () {
  var absOn = derived({ brakes: { abs: 'race' } }), absOff = derived({ brakes: { abs: 'off' } });
  function brakeTurn(p) {
    var s = V.createState(p, { speed: 30, gear: 4 });
    var h0 = s.heading;
    run(p, s, 1.2, function () { return { throttle: 0, brake: 1, steer: 0.6 }; });
    return { dh: Math.abs(s.heading - h0), s: s };
  }
  var on = brakeTurn(absOn), off = brakeTurn(absOff);
  assert.ok(on.dh > off.dh, 'ABS turns more ' + on.dh + ' vs ' + off.dh);
});

test('traction control limits wheelspin on launch for a high-power RWD car', function () {
  var patch = { engine: { boost_bar: 2.2, tune: 'stage3' }, tires: { compound: 'eco' }, transmission: { launchControl: false } };
  var tcOn = derived(merge(clone(patch), { drivetrain: { tractionControl: 3 } }));
  var tcOff = derived(merge(clone(patch), { drivetrain: { tractionControl: 0 } }));
  function spin(p) {
    var s = V.createState(p, {}), acc = 0, n = 0;
    run(p, s, 2, function (st) { acc += st.wheelspin; n++; return { throttle: 1 }; });
    return acc / n;
  }
  var a = spin(tcOn), b = spin(tcOff);
  assert.ok(a < b, 'TC on spin ' + a + ' vs off ' + b);
});

test('diff lock: LSD rear puts more power down on corner exit than open', function () {
  var lsd = derived({ drivetrain: { rearDiff: 'locking', tractionControl: 0 } });
  var open = derived({ drivetrain: { rearDiff: 'open', tractionControl: 0 } });
  assert.ok(lsd.lockR > open.lockR);
  function exitSpeed(p) {
    var s = V.createState(p, { speed: 12, gear: 2 });
    run(p, s, 1.5, function () { return { throttle: 1, steer: 0.5 }; });
    return s.speed;
  }
  assert.ok(exitSpeed(lsd) >= exitSpeed(open) * 0.98);
});

test('FWD understeers more than RWD at the limit (higher front slip share)', function () {
  var fwd = derived({ drivetrain: { layout: 'fwd', torqueSplitFront_pct: 100, frontDiff: 'open', tractionControl: 0 }, engine: { position: 'front' } });
  var rwd = derived({ drivetrain: { layout: 'rwd', tractionControl: 0 }, engine: { position: 'mid' } });
  // rear/front slip-angle ratio under power on a constant steer: < 1 = understeer, high = oversteer
  function rearShare(p) {
    var s = V.createState(p, { speed: 22 }), acc = 0, n = 0;
    run(p, s, 1.5, function (st) { acc += Math.abs(st.slipAngleR) / Math.max(1e-3, Math.abs(st.slipAngleF)); n++; return { throttle: 0.7, steer: 0.7 }; });
    return acc / n;
  }
  var f = rearShare(fwd), r = rearShare(rwd);
  assert.ok(f < 0.6, 'fwd understeers ' + f);
  assert.ok(r > f * 1.3, 'rwd ' + r + ' fwd ' + f);
});

test('speed-sensitive steering: less wheel angle at high speed', function () {
  var p = derived();
  var lo = V.createState(p, { speed: 5 }), hi = V.createState(p, { speed: 60 });
  run(p, lo, 0.6, function () { return { throttle: 0.2, steer: 1 }; });
  run(p, hi, 0.6, function () { return { throttle: 0.5, steer: 1 }; });
  assert.ok(Math.abs(hi.steerAngle) < Math.abs(lo.steerAngle) * 0.5, 'hi ' + hi.steerAngle + ' lo ' + lo.steerAngle);
});

test('EV build: no idle rpm requirement, instant torque, single gear', function () {
  var p = derived({ engine: { type: 'ev', motors: 2, motorPower_kw: 300, battery_kwh: 90 }, transmission: { type: 'single-speed', gears: 1, ratios: [1] }, drivetrain: { layout: 'awd', torqueSplitFront_pct: 45 } });
  assert.ok(p.isEV && p.maxGear === 1);
  var r = V.simulateLaunch(p, 100);
  assert.ok(r.t != null && r.t < 5, 'EV 0-100 ' + r.t);
  assert.strictEqual(r.state.gear, 1);
});

test('world-space helpers: impulse & world velocity round trip', function () {
  var p = derived();
  var s = V.createState(p, { heading: Math.PI / 2, speed: 10 });
  var wv = V.worldVelocity(s);
  assert.ok(Math.abs(wv.vx) < 1e-9 && Math.abs(wv.vy - 10) < 1e-9);
  V.setWorldVelocity(p, s, 5, 0);
  var wv2 = V.worldVelocity(s);
  assert.ok(Math.abs(wv2.vx - 5) < 1e-9 && Math.abs(wv2.vy) < 1e-9);
  V.applyImpulse(p, s, 0, p.mass * 2, s.x + 1, s.y);
  assert.ok(isFinite(s.yawRate) && s.yawRate !== 0);
  var wp = V.wheelPositions(p, s);
  assert.strictEqual(wp.length, 4);
  assert.ok(wp.every(function (w) { return isFinite(w.x) && isFinite(w.y); }));
});

if (standalone) {
  console.log('\nrace-vehicle: ' + passed + ' passed, ' + failed + ' failed');
}

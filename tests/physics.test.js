/* FORGE Atelier — CB.physics tests. Run: node tests/run.js physics */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
const D = require('../js/data.js');
const S = require('../js/state.js');
const P = require('../js/physics.js');
const U = globalThis.CB.util;

/* ------------------------------------------------------------------ helpers */
/* The physics calibration tests run on a front-engined 4.0 twin-turbo V8 coupe (~640 hp, 7-speed DCT): the catalog
   default build became a rear-engined 911 Carrera S, so mk() pins the reference mechanicals explicitly. */
const REF_COUPE = { body: { wheelbase_mm: 2650, trackWidth_mm: 1600 },
  engine: { layout: 'V8', displacement_l: 4.0, boost_bar: 1.2, position: 'front' },
  transmission: { type: 'dct', gears: 7, ratios: [3.80, 2.60, 1.90, 1.45, 1.15, 0.95, 0.78], finalDrive: 3.42 } };
function mk(patch) { return S.normalize(U.deepMerge(D.referenceBuild ? D.referenceBuild() : U.deepMerge(D.defaultBuild(), REF_COUPE), patch || {})); }
function preset(id) { return S.normalize(D.presetBuild(id)); }
function with_(build, patch) { return S.normalize(U.deepMerge(U.deepClone(build), patch)); }
function deepFreeze(o) { if (o && typeof o === 'object') { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); } return o; }

/** Every number anywhere in the metrics must be finite (null is allowed for documented optional values). */
function assertFiniteDeep(o, path) {
  path = path || 'metrics';
  if (typeof o === 'number') { assert.ok(Number.isFinite(o), path + ' is not finite: ' + o); return; }
  if (Array.isArray(o)) { o.forEach((v, i) => assertFiniteDeep(v, path + '[' + i + ']')); return; }
  if (o && typeof o === 'object') Object.keys(o).forEach((k) => { assert.notEqual(typeof o[k], 'function', path + '.' + k + ' is a function'); assertFiniteDeep(o[k], path + '.' + k); });
}

const REQUIRED = ['power_hp', 'power_kw', 'torque_nm', 'peakPowerRpm', 'peakTorqueRpm', 'idleRpm', 'redlineRpm', 'curve',
  'weight_kg', 'weightFront_pct', 'cgHeight_mm', 'powerToWeight_hpPerTon', 'cd', 'frontalArea_m2', 'cda', 'downforce_kg_200',
  'downforceCurve', 'gripFront', 'gripRear', 'lateralG', 'brakingDist_100_0_m', 'brakingDist_60_0_ft', 'zeroTo60_s', 'zeroTo100_s',
  'zeroTo200_s', 'quarterMile_s', 'quarterMileTrap_mph', 'topSpeed_kph', 'topSpeed_mph', 'topSpeedLimitedBy', 'accelCurve',
  'gearSpeeds', 'fuelEconomy_l100', 'fuelEconomy_mpg', 'range_km', 'co2_gkm', 'efficiency_whkm', 'lapTime_s', 'lapSectors',
  'ratings', 'reliabilityScore', 'comfortIndex', 'noise_db_cabin', 'exhaust_db', 'zeroTo60_note', 'warnings'];
const RATINGS = ['acceleration', 'handling', 'braking', 'comfort', 'efficiency', 'reliability', 'practicality', 'luxury', 'sound', 'track'];
const ALWAYS_NUMERIC = REQUIRED.filter((k) => !['curve', 'downforceCurve', 'accelCurve', 'gearSpeeds', 'lapSectors', 'ratings', 'warnings',
  'topSpeedLimitedBy', 'zeroTo60_note', 'zeroTo200_s', 'efficiency_whkm', 'zeroTo60_s', 'zeroTo100_s', 'quarterMile_s', 'quarterMileTrap_mph'].includes(k));

function checkShape(m, label) {
  REQUIRED.forEach((k) => assert.ok(k in m, label + ': missing ' + k));
  ALWAYS_NUMERIC.forEach((k) => assert.ok(Number.isFinite(m[k]), label + ': ' + k + ' = ' + m[k]));
  assertFiniteDeep(m, label);
  assert.ok(!m._error, label + ': physics fell back to error metrics: ' + (m.warnings || []).join(';'));
  // JSON-serialisable and loss-free
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, label + ': not JSON round-trippable');
  RATINGS.forEach((k) => {
    assert.ok(Number.isInteger(m.ratings[k]), label + ': rating ' + k + ' not an integer');
    assert.ok(m.ratings[k] >= 0 && m.ratings[k] <= 100, label + ': rating ' + k + ' = ' + m.ratings[k]);
  });
  assert.ok(['drag', 'redline', 'governor'].includes(m.topSpeedLimitedBy), label + ': topSpeedLimitedBy ' + m.topSpeedLimitedBy);
  assert.ok(Array.isArray(m.warnings) && m.warnings.every((w) => typeof w === 'string' && w.length > 5), label + ': warnings');
  assert.equal(typeof m.zeroTo60_note, 'string');
  assert.ok(m.power_hp > 20 && m.power_hp < 5000, label + ': power ' + m.power_hp);
  assert.ok(Math.abs(m.power_kw - m.power_hp * 0.7457) < 0.5, label + ': kW/hp mismatch');
  assert.ok(m.weight_kg > 600 && m.weight_kg < 4500, label + ': weight ' + m.weight_kg);
  assert.ok(m.weightFront_pct > 25 && m.weightFront_pct < 75, label + ': weightFront ' + m.weightFront_pct);
  assert.ok(m.cgHeight_mm > 250 && m.cgHeight_mm < 1100, label + ': cg ' + m.cgHeight_mm);
  assert.ok(m.lateralG > 0.4 && m.lateralG < 3.5, label + ': lateralG ' + m.lateralG);
  assert.ok(m.brakingDist_100_0_m > 12 && m.brakingDist_100_0_m < 90, label + ': braking ' + m.brakingDist_100_0_m);
  assert.ok(Math.abs(m.brakingDist_60_0_ft / 3.28084 - m.brakingDist_100_0_m * Math.pow(26.8224 / 27.7778, 2)) < 4, label + ': 60-0 vs 100-0 inconsistent');
  assert.ok(m.topSpeed_kph > 60 && m.topSpeed_kph < 520, label + ': top ' + m.topSpeed_kph);
  assert.ok(Math.abs(m.topSpeed_mph * 1.609344 - m.topSpeed_kph) < 0.3, label + ': mph/kph');
  assert.ok(m.lapTime_s > 80 && m.lapTime_s < 400, label + ': lap ' + m.lapTime_s);
  assert.equal(m.lapSectors.length, 3);
  assert.ok(Math.abs(m.lapSectors.reduce((a, b) => a + b, 0) - m.lapTime_s) < 0.02, label + ': sectors do not sum to lap');
  assert.ok(m.range_km > 30, label + ': range ' + m.range_km);
  assert.ok(m.fuelEconomy_l100 > 0.5 && m.fuelEconomy_l100 < 60, label + ': l/100 ' + m.fuelEconomy_l100);
  assert.ok(m.reliabilityScore >= 0 && m.reliabilityScore <= 100 && m.comfortIndex >= 0 && m.comfortIndex <= 100);
  // ordered times
  if (m.zeroTo60_s != null && m.zeroTo100_s != null) assert.ok(m.zeroTo60_s < m.zeroTo100_s, label + ': 0-60 >= 0-100');
  if (m.zeroTo100_s != null && m.zeroTo200_s != null) assert.ok(m.zeroTo100_s < m.zeroTo200_s, label + ': 0-100 >= 0-200');
  if (m.topSpeed_kph > 205) assert.ok(m.zeroTo200_s != null, label + ': 0-200 should be reachable at ' + m.topSpeed_kph + ' km/h');
  if (m.topSpeed_kph < 199) assert.equal(m.zeroTo200_s, null, label + ': 0-200 must be null below 200 km/h');
  // curves
  assert.ok(m.curve.length >= 10, label + ': curve too short');
  m.curve.forEach((p, i) => {
    assert.ok(p.hp >= 0 && p.nm >= 0, label + ': negative curve point');
    if (i && i < m.curve.length - 1) assert.equal(p.rpm - m.curve[i - 1].rpm, 250, label + ': curve step');
  });
  assert.equal(m.curve[0].rpm, m.idleRpm, label + ': curve starts at idle');
  assert.equal(m.curve[m.curve.length - 1].rpm, m.redlineRpm, label + ': curve ends at redline');
  const maxHp = Math.max.apply(null, m.curve.map((p) => p.hp));
  assert.ok(Math.abs(maxHp - m.power_hp) / m.power_hp < 0.03, label + ': curve max hp ' + maxHp + ' vs ' + m.power_hp);
  assert.ok(m.accelCurve.length > 20, label + ': accelCurve');
  m.accelCurve.forEach((p, i) => {
    assert.ok(Number.isInteger(p.gear) && p.gear >= 1, label + ': accel gear');
    if (i) assert.ok(Math.abs(p.t - m.accelCurve[i - 1].t - 0.05) < 0.011, label + ': accel dt');
  });
  const last = m.accelCurve[m.accelCurve.length - 1];
  assert.ok(last.t <= 60.01, label + ': sim beyond 60 s');
  assert.ok(last.t >= 59.9 || last.kph >= m.topSpeed_kph * 0.98 - 0.2, label + ': sim stopped early at ' + last.t + ' s / ' + last.kph);
  m.downforceCurve.forEach((p, i) => { if (i && i < m.downforceCurve.length - 1) assert.equal(p.kph - m.downforceCurve[i - 1].kph, 20); });
  assert.equal(m.downforceCurve[0].kph, 0);
  const d200 = m.downforceCurve.find((p) => p.kph === 200);
  if (d200) assert.ok(Math.abs(d200.kg - m.downforce_kg_200) < 0.2, label + ': downforce curve at 200');
  m.gearSpeeds.forEach((g, i) => { if (i) assert.ok(g.maxKph > m.gearSpeeds[i - 1].maxKph, label + ': gear speeds not increasing'); });
}

/* ------------------------------------------------------------------ module */
test('physics: module shape', () => {
  assert.equal(typeof P.compute, 'function');
  assert.equal(globalThis.CB.physics, P);
  assert.equal(P.track.length_m, 5800);
  const len = P.track.segments.reduce((s, x) => s + x.len, 0);
  assert.ok(Math.abs(len - 5800) < 1e-6, 'Redline Ring length ' + len);
  assert.equal(P.downforceAt({ downforce_kg_200: 100 }, 100), 25);
});

test('physics: default build — complete, finite, JSON-safe metrics', () => {
  const m = P.compute(mk());
  checkShape(m, 'default');
  assert.equal(m.efficiency_whkm, null);
  assert.ok(m.co2_gkm > 50);
});

test('physics: every preset computes finite, plausible metrics', () => {
  assert.ok(D.presets.length >= 8);
  D.presets.forEach((p) => checkShape(P.compute(preset(p.id)), p.id));
});

test('physics: deterministic and does not mutate its input', () => {
  const b = deepFreeze(mk());
  const a = P.compute(b), c = P.compute(b);
  assert.deepEqual(a, c);
  const e = deepFreeze(preset('electric-hyper'));
  assert.deepEqual(P.compute(e), P.compute(e));
});

test('physics: < 5 ms per compute (averaged over presets)', () => {
  const builds = D.presets.map((p) => preset(p.id)).concat([mk()]);
  builds.forEach((b) => P.compute(b)); // warm-up (JIT)
  const N = 6, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) builds.forEach((b) => P.compute(b));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / (N * builds.length);
  console.log('       avg compute ' + ms.toFixed(2) + ' ms');
  assert.ok(ms < 5, 'avg ' + ms.toFixed(2) + ' ms');
});

test('physics: tolerates partial, empty and garbage builds', () => {
  [null, undefined, {}, { engine: { type: 'ev' } }, { body: { style: 'nope' }, engine: { layout: 'V99', displacement_l: 'abc', boost_bar: -5 } },
    { transmission: { ratios: [NaN, 0, -1] }, tires: { widthFront_mm: Infinity } }, { engine: { type: 'hybrid', battery_kwh: 0 } }]
    .forEach((b, i) => {
      const m = P.compute(b);
      assertFiniteDeep(m, 'garbage#' + i);
      assert.ok(m.power_hp > 0 && m.weight_kg > 0 && m.topSpeed_kph > 0, 'garbage#' + i);
      assert.ok(!m._error, 'garbage#' + i + ' fell back: ' + m.warnings.join(';'));
    });
});

/* ------------------------------------------------------------------ SPEC sanity bands */
/** Find the boost giving ~target hp (power is monotonic in boost below the knock limit). */
function tuneBoost(base, targetHp) {
  let lo = 0.1, hi = 2.0;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2, hp = P.compute(with_(base, { engine: { boost_bar: mid } })).power_hp;
    if (hp < targetHp) lo = mid; else hi = mid;
  }
  return with_(base, { engine: { boost_bar: (lo + hi) / 2 } });
}

// band widened from 3.8–4.3 s: with the shared launch / drive-μ model a launch-control DCT coupe on summer UHP tyres
// launches like its real peers (911 Carrera GTS 3.2 s, AMG GT S 3.7 s 0-60)
test('physics sanity: ~1500 kg 500 hp RWD coupe → 0-60 in 3.3–4.3 s', () => {
  const base = mk({
    body: { style: 'coupe', chassisMaterial: 'carbon-tub', seats: 2 },
    engine: { layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', compression: 9.5, fuel: 'premium', tune: 'stock', exhaust: 'sport' },
    transmission: { type: 'dct', gears: 7, launchControl: true },
    drivetrain: { layout: 'rwd', rearDiff: 'lsd-clutch', tractionControl: 2 },
    wheels: { material: 'forged' }, tires: { compound: 'performance' }
  });
  const b = tuneBoost(base, 500);
  const m = P.compute(b);
  console.log('       coupe: ' + m.power_hp + ' hp, ' + m.weight_kg + ' kg, 0-60 ' + m.zeroTo60_s + ' s (' + m.zeroTo60_note + '), 0-100 ' + m.zeroTo100_s + ' s, ¼ mile ' + m.quarterMile_s + ' s @ ' + m.quarterMileTrap_mph + ' mph');
  assert.ok(Math.abs(m.power_hp - 500) < 10, 'power ' + m.power_hp);
  assert.ok(m.weight_kg > 1400 && m.weight_kg < 1620, 'weight ' + m.weight_kg);
  assert.ok(m.zeroTo60_s >= 3.3 && m.zeroTo60_s <= 4.3, '0-60 ' + m.zeroTo60_s);
  assert.ok(m.quarterMile_s > 11 && m.quarterMile_s < 12.8, 'quarter ' + m.quarterMile_s);
});

test('physics sanity: ~2200 kg 1000 kW AWD EV → 0-60 in 2.0–2.4 s', () => {
  const b = mk({
    body: { style: 'sedan', doors: 4, seats: 5, chassisMaterial: 'aluminum' },
    engine: { type: 'ev', motors: 4, motorPower_kw: 250, battery_kwh: 100, chemistry: 'nmc', voltage: 800, position: 'front' },
    transmission: { type: 'single-speed', gears: 1, ratios: [2.65], finalDrive: 3.4, launchControl: true },
    drivetrain: { layout: 'awd', torqueSplitFront_pct: 45, frontDiff: 'open', rearDiff: 'open', centerDiff: 'e-diff', tractionControl: 2 },
    tires: { compound: 'performance' }
  });
  const m = P.compute(b);
  console.log('       EV: ' + m.power_kw + ' kW, ' + m.weight_kg + ' kg, 0-60 ' + m.zeroTo60_s + ' s (' + m.zeroTo60_note + '), ' + m.efficiency_whkm + ' Wh/km, ' + m.range_km + ' km');
  assert.ok(Math.abs(m.power_kw - 1000) < 1, 'power ' + m.power_kw);
  assert.ok(m.weight_kg > 2050 && m.weight_kg < 2350, 'weight ' + m.weight_kg);
  assert.ok(m.zeroTo60_s >= 2.0 && m.zeroTo60_s <= 2.4, '0-60 ' + m.zeroTo60_s);
  assert.ok(m.efficiency_whkm > 120 && m.efficiency_whkm < 350, 'Wh/km ' + m.efficiency_whkm);
  assert.equal(m.co2_gkm, 0);
});

test('physics sanity: ~1300 kg 150 hp FWD hatch → 0-60 in 7.5–9 s', () => {
  const b = mk({
    body: { style: 'hatchback', chassisMaterial: 'steel', doors: 5, seats: 5, wheelbase_mm: 2600 },
    engine: { layout: 'I4', displacement_l: 1.6, aspiration: 'na', boost_bar: 0, compression: 11.5, fuel: 'premium', redline_rpm: 6500, tune: 'stock', exhaust: 'stock' },
    transmission: { type: 'manual', gears: 6, finalDrive: 4.1, launchControl: false },
    drivetrain: { layout: 'fwd', frontDiff: 'open', rearDiff: 'none', centerDiff: 'none', torqueSplitFront_pct: 100, tractionControl: 2 },
    suspension: { type: 'macpherson', rideHeight_mm: 130 },
    brakes: { material: 'iron', frontRotor_mm: 312, rearRotor_mm: 280, frontPistons: 1, rearPistons: 1, abs: 'standard' },
    wheels: { diameter_in: 17, widthFront_in: 7, widthRear_in: 7, material: 'cast', staggered: false },
    tires: { compound: 'touring', widthFront_mm: 225, widthRear_mm: 225, profileFront: 45, profileRear: 45 },
    aero: { splitter: 'none', wing: 'none', diffuser: 'none', sideSkirts: false },
    weight: { soundDeadening: true }, tech: { audio: 'standard' }
  });
  const m = P.compute(b);
  console.log('       hatch: ' + m.power_hp + ' hp, ' + m.weight_kg + ' kg (' + m.weightFront_pct + '% front), 0-60 ' + m.zeroTo60_s + ' s, top ' + m.topSpeed_kph + ' km/h, ' + m.fuelEconomy_l100 + ' L/100 km');
  assert.ok(m.power_hp > 135 && m.power_hp < 165, 'power ' + m.power_hp);
  assert.ok(m.weight_kg > 1220 && m.weight_kg < 1450, 'weight ' + m.weight_kg);
  assert.ok(m.zeroTo60_s >= 7.5 && m.zeroTo60_s <= 9, '0-60 ' + m.zeroTo60_s);
  assert.ok(m.weightFront_pct > 55, 'FWD transverse front bias ' + m.weightFront_pct);
  assert.ok(m.fuelEconomy_l100 > 4.5 && m.fuelEconomy_l100 < 9.5, 'economy ' + m.fuelEconomy_l100);
  assert.ok(m.topSpeed_kph > 190 && m.topSpeed_kph < 240, 'top ' + m.topSpeed_kph);
});

/* ------------------------------------------------------------------ monotonicity: more power is never slower */
function assertNotSlower(a, b, label) {
  const T = 0.011;
  ['zeroTo60_s', 'zeroTo100_s', 'zeroTo200_s', 'quarterMile_s'].forEach((k) => {
    if (a[k] != null && b[k] != null) assert.ok(b[k] <= a[k] + T, label + ': ' + k + ' ' + a[k] + ' → ' + b[k] + ' with more power');
    if (a[k] != null) assert.ok(b[k] != null, label + ': ' + k + ' became unreachable');
  });
  assert.ok(b.topSpeed_kph >= a.topSpeed_kph - 0.05, label + ': top speed ' + a.topSpeed_kph + ' → ' + b.topSpeed_kph);
  assert.ok(b.lapTime_s <= a.lapTime_s + T, label + ': lap ' + a.lapTime_s + ' → ' + b.lapTime_s);
  assert.ok(b.quarterMileTrap_mph >= a.quarterMileTrap_mph - 0.05, label + ': trap speed');
}
function sweep(label, builds) {
  const ms = builds.map((b) => P.compute(b)).sort((x, y) => x.power_hp - y.power_hp);
  for (let i = 1; i < ms.length; i++) if (ms[i].power_hp > ms[i - 1].power_hp + 0.05) assertNotSlower(ms[i - 1], ms[i], label + ' #' + i);
}

test('physics: more power never slower — tune maps across presets', () => {
  ['alpine-gt', 'hot-hatch', 'muscle', 'track-weapon', 'super-wagon', 'overland', 'rally-legend'].forEach((id) => {
    const base = preset(id);
    sweep(id + ' tunes', ['eco', 'stock', 'stage1', 'stage2', 'stage3', 'time-attack'].map((t) => with_(base, { engine: { tune: t } })));
  });
  sweep('default tunes', ['eco', 'stock', 'stage1', 'stage2', 'stage3', 'time-attack'].map((t) => mk({ engine: { tune: t } })));
});

test('physics: more power never slower — boost, displacement, EV motor power', () => {
  sweep('default boost', [0.4, 0.6, 0.8, 1.0, 1.2, 1.4].map((x) => mk({ engine: { boost_bar: x } })));
  sweep('hot-hatch boost', [0.6, 0.9, 1.2, 1.5].map((x) => with_(preset('hot-hatch'), { engine: { boost_bar: x } })));
  sweep('NA V8 displacement', [4.0, 4.5, 5.0, 5.5, 6.0].map((x) => mk({ engine: { aspiration: 'na', boost_bar: 0, compression: 12, displacement_l: x } })));
  sweep('EV motors', [150, 200, 250, 300, 350].map((x) => with_(preset('electric-hyper'), { engine: { motorPower_kw: x } })));
  sweep('shuttle motors', [100, 150, 200].map((x) => with_(preset('atelier-shuttle'), { engine: { motorPower_kw: x } })));
});

/* ------------------------------------------------------------------ aero & grip */
test('physics: more downforce → more lateral g (and more drag)', () => {
  ['default', 'hot-hatch', 'alpine-gt', 'lightweight-roadster'].forEach((id) => {
    const base = id === 'default' ? mk() : preset(id);
    const lo = P.compute(with_(base, { aero: { splitter: 'none', wing: 'none', diffuser: 'none' } }));
    const hi = P.compute(with_(base, { aero: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 10, diffuser: 'race' } }));
    assert.ok(hi.downforce_kg_200 > lo.downforce_kg_200 + 100, id + ': downforce');
    assert.ok(hi.lateralG > lo.lateralG, id + ': lateral g ' + lo.lateralG + ' → ' + hi.lateralG);
    assert.ok(hi.lateralG_200 > lo.lateralG_200 + 0.05, id + ': lateral g @200 ' + lo.lateralG_200 + ' → ' + hi.lateralG_200);
    assert.ok(hi.cd > lo.cd, id + ': drag');
  });
  // adjustable wing: more angle → more downforce → more grip
  const angles = [0, 5, 10, 15, 20].map((a) => P.compute(mk({ aero: { wing: 'gt-wing', wingAngle_deg: a } })));
  for (let i = 1; i < angles.length; i++) {
    assert.ok(angles[i].downforce_kg_200 > angles[i - 1].downforce_kg_200, 'wing angle downforce');
    assert.ok(angles[i].lateralG > angles[i - 1].lateralG, 'wing angle lateral g');
    assert.ok(angles[i].cd > angles[i - 1].cd, 'wing angle drag');
  }
  // downforce grows with v²
  const m = angles[2];
  const at100 = m.downforceCurve.find((p) => p.kph === 100), at200 = m.downforceCurve.find((p) => p.kph === 200);
  assert.ok(Math.abs(at200.kg / at100.kg - 4) < 0.05);
});

test('physics: stickier tyres → more lateral g, shorter stops, faster lap', () => {
  const order = ['eco', 'touring', 'performance', 'super-sport', 'track', 'slick'].map((c) => P.compute(mk({ tires: { compound: c } })));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i].lateralG > order[i - 1].lateralG, 'lateral ' + i);
    assert.ok(order[i].brakingDist_100_0_m < order[i - 1].brakingDist_100_0_m, 'braking ' + i);
    assert.ok(order[i].lapTime_s < order[i - 1].lapTime_s, 'lap ' + i);
  }
});

/* ------------------------------------------------------------------ brakes */
test('physics: carbon-ceramic brakes never stop longer than iron', () => {
  const ids = ['default'].concat(D.presets.map((p) => p.id));
  ids.forEach((id) => {
    const base = id === 'default' ? mk() : preset(id);
    const patch = (mat) => ({ brakes: { material: mat }, wheels: { diameter_in: Math.max(19, base.wheels.diameter_in) } });
    const iron = P.compute(with_(base, patch('iron'))), cc = P.compute(with_(base, patch('carbon-ceramic')));
    assert.ok(cc.brakingDist_100_0_m <= iron.brakingDist_100_0_m, id + ': CC ' + cc.brakingDist_100_0_m + ' vs iron ' + iron.brakingDist_100_0_m);
    assert.ok(cc.weight_kg < iron.weight_kg, id + ': CC lighter');
    assert.ok(cc.lapTime_s <= iron.lapTime_s + 0.001, id + ': CC lap');
  });
});

test('physics: braking — tiny brakes on a heavy car are hydraulically limited; ABS off is worse', () => {
  const big = P.compute(preset('desert-runner'));
  const small = P.compute(with_(preset('desert-runner'), { brakes: { frontRotor_mm: 280, rearRotor_mm: 280, frontPistons: 1, rearPistons: 1 } }));
  assert.ok(small.brakingDist_100_0_m > big.brakingDist_100_0_m, 'small brakes ' + small.brakingDist_100_0_m + ' vs ' + big.brakingDist_100_0_m);
  const race = P.compute(mk({ brakes: { abs: 'race' } })), off = P.compute(mk({ brakes: { abs: 'off' } }));
  assert.ok(off.brakingDist_100_0_m > race.brakingDist_100_0_m);
  assert.ok(off.warnings.some((w) => /ABS off/.test(w)));
  const m = P.compute(mk());
  assert.ok(m.brakingDist_100_0_m > 30 && m.brakingDist_100_0_m < 42, 'default 100-0 ' + m.brakingDist_100_0_m);
});

/* ------------------------------------------------------------------ engine character */
test('physics: torque-curve shapes — NA peaky, turbo plateau, supercharged linear, EV flat then constant power', () => {
  const na = P.compute(preset('alpine-gt'));
  assert.ok(na.peakTorqueRpm > na.redlineRpm * 0.5, 'NA peak torque high in the rev range');
  assert.ok(na.peakPowerRpm > na.redlineRpm * 0.85, 'NA peak power near redline');
  const tt = P.compute(mk());
  const plateau = tt.curve.filter((p) => p.nm >= tt.torque_nm * 0.985);
  assert.ok(plateau.length >= 8, 'turbo plateau spans ≥ 2,000 rpm (' + plateau.length + ' points)');
  assert.ok(tt.peakTorqueRpm < tt.redlineRpm * 0.55, 'turbo peak torque early');
  const sc = P.compute(preset('muscle'));
  const scHp = sc.curve.map((p) => p.hp);
  for (let i = 1; i < scHp.length * 0.8; i++) assert.ok(scHp[i] >= scHp[i - 1] - 0.5, 'supercharged power rises steadily');
  const ev = P.compute(preset('electric-hyper'));
  assert.equal(ev.curve[0].rpm, 0); assert.equal(ev.redlineRpm, 16000); assert.equal(ev.idleRpm, 0);
  assert.equal(ev.curve[0].nm, ev.torque_nm, 'EV full torque from standstill');
  assert.equal(ev.curve[4].nm, ev.torque_nm, 'EV constant torque region');
  const hi = ev.curve.filter((p) => p.rpm > 7000 && p.rpm < 12500);
  hi.forEach((p) => assert.ok(Math.abs(p.hp - ev.power_hp) / ev.power_hp < 0.02, 'EV constant power at ' + p.rpm));
  assert.ok(ev.efficiency_whkm > 100);
});

test('physics: knock limit, compression, fuel and diesel cap', () => {
  const safe = P.compute(mk({ engine: { compression: 10, fuel: 'premium' } }));
  const knock = P.compute(mk({ engine: { compression: 12.5, fuel: 'regular' } }));
  assert.ok(knock.warnings.some((w) => /^Knock/.test(w)), 'knock warning');
  assert.ok(knock.power_hp < safe.power_hp, 'knock retard costs power');
  assert.ok(knock.reliabilityScore < safe.reliabilityScore, 'knock hurts reliability');
  const race = P.compute(mk({ engine: { compression: 12.5, fuel: 'race' } }));
  assert.ok(race.power_hp > knock.power_hp && !race.warnings.some((w) => /^Knock/.test(w)), 'race fuel cures knock');
  const naLo = P.compute(mk({ engine: { aspiration: 'na', boost_bar: 0, compression: 10 } }));
  const naHi = P.compute(mk({ engine: { aspiration: 'na', boost_bar: 0, compression: 13 } }));
  assert.ok(naHi.power_hp > naLo.power_hp && naHi.fuelEconomy_l100 < naLo.fuelEconomy_l100, 'higher CR: more power & efficiency');
  const d = P.compute(preset('overland'));
  assert.ok(d.redlineRpm <= 5200 && d.peakTorqueRpm < 3000, 'diesel: low redline, low-rpm torque');
});

test('physics: transmission torque limit and turbo lag warnings', () => {
  const m = P.compute(preset('muscle'));
  assert.ok(m.warnings.some((w) => /exceeds the .* rating/.test(w)));
  const lag = P.compute(mk({ engine: { aspiration: 'turbo', boost_bar: 1.8 } }));
  const eturbo = P.compute(mk({ engine: { aspiration: 'electric-turbo', boost_bar: 1.8 } }));
  assert.ok(eturbo.peakTorqueRpm < lag.peakTorqueRpm, 'e-turbo spools earlier');
});

/* ------------------------------------------------------------------ mass & balance */
test('physics: mass model — chassis materials, ballast, engine position, EV pack', () => {
  const mats = ['steel', 'high-strength-steel', 'aluminum', 'carbon-tub', 'carbon-monocoque'].map((c) => P.compute(mk({ body: { chassisMaterial: c } })));
  for (let i = 1; i < mats.length; i++) assert.ok(mats[i].weight_kg < mats[i - 1].weight_kg, 'lighter chassis ' + i);
  const front = P.compute(mk({ weight: { ballast_kg: 80, ballastPosition: 'front' } }));
  const rear = P.compute(mk({ weight: { ballast_kg: 80, ballastPosition: 'rear' } }));
  const none = P.compute(mk());
  assert.ok(front.weightFront_pct > none.weightFront_pct && rear.weightFront_pct < none.weightFront_pct);
  assert.ok(Math.abs(front.weight_kg - none.weight_kg - 80) < 0.6);
  const mid = P.compute(mk({ engine: { position: 'mid' } }));
  assert.ok(mid.weightFront_pct < none.weightFront_pct - 5, 'mid engine moves mass rearwards');
  assert.ok(mid.weightBreakdown && mid.weightBreakdown.engine > 150);
  const sumBd = Object.values(none.weightBreakdown).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumBd - none.weight_kg) < 2, 'breakdown sums to curb mass');
  const small = P.compute(with_(preset('electric-hyper'), { engine: { battery_kwh: 60 } }));
  const big = P.compute(with_(preset('electric-hyper'), { engine: { battery_kwh: 150 } }));
  assert.ok(big.weight_kg > small.weight_kg + 300 && big.range_km > small.range_km * 1.8);
  const ss = P.compute(with_(preset('electric-hyper'), { engine: { chemistry: 'solid-state' } }));
  assert.ok(ss.weight_kg < P.compute(preset('electric-hyper')).weight_kg, 'solid-state packs are lighter');
  const lowRide = P.compute(mk({ suspension: { rideHeight_mm: 90 } })), highRide = P.compute(mk({ suspension: { rideHeight_mm: 200 } }));
  assert.ok(lowRide.cgHeight_mm < highRide.cgHeight_mm && lowRide.lateralG > highRide.lateralG);
});

/* ------------------------------------------------------------------ top speed & gearing */
test('physics: top speed limits — drag, redline, governor', () => {
  const eco = P.compute(mk({ engine: { tune: 'eco' } }));
  assert.equal(eco.topSpeedLimitedBy, 'governor'); assert.ok(eco.topSpeed_kph <= 180.05);
  const short = P.compute(mk({ transmission: { finalDrive: 5.5 } }));
  assert.equal(short.topSpeedLimitedBy, 'redline');
  const top = short.gearSpeeds[short.gearSpeeds.length - 1].maxKph;
  assert.ok(Math.abs(short.topSpeed_kph - top) < 1, 'redline top speed equals top-gear redline speed');
  // slicks lift the tyre speed rating; a taller final drive keeps the 7th-gear limiter out of reach → drag-limited
  const slick = P.compute(mk({ tires: { compound: 'slick' }, transmission: { finalDrive: 3.0 } }));
  assert.equal(slick.topSpeedLimitedBy, 'drag');
  assert.ok(slick.topSpeed_kph < slick.gearSpeeds[slick.gearSpeeds.length - 1].maxKph - 1, 'drag top speed below the limiter');
  // gear speeds match rpm/ratio kinematics
  const m = P.compute(mk());
  const g1 = m.gearSpeeds[0];
  const v = m.redlineRpm * Math.PI / 30 * m.wheelRadius_m / (g1.ratio * m.finalDrive) * 3.6;
  assert.ok(Math.abs(v - g1.maxKph) < 0.5);
  // more drag → lower top speed
  const wing = P.compute(mk({ tires: { compound: 'slick' }, transmission: { finalDrive: 3.0 }, aero: { wing: 'biplane', wingAngle_deg: 20 } }));
  assert.ok(wing.topSpeed_kph < slick.topSpeed_kph);
});

test('physics: launch control & traction control effects', () => {
  const lc = P.compute(mk({ transmission: { launchControl: true } }));
  const nolc = P.compute(mk({ transmission: { launchControl: false } }));
  assert.ok(lc.zeroTo60_s < nolc.zeroTo60_s, 'launch control quicker');
  const awd = P.compute(mk({ drivetrain: { layout: 'awd', torqueSplitFront_pct: 40, centerDiff: 'lsd-torsen', frontDiff: 'open' } }));
  assert.ok(awd.zeroTo60_s < lc.zeroTo60_s, 'AWD launches harder than RWD for 640 hp');
  assert.match(lc.zeroTo60_note, /traction/);
  const fwd = P.compute(mk({ drivetrain: { layout: 'fwd', torqueSplitFront_pct: 100, frontDiff: 'open' } }));
  assert.ok(fwd.warnings.some((w) => /Torque steer/.test(w)));
});

/* ------------------------------------------------------------------ energy */
test('physics: fuel economy, hybrid and EV energy', () => {
  const eco = P.compute(preset('eco-commuter')), muscle = P.compute(preset('muscle'));
  assert.ok(eco.fuelEconomy_l100 < 6.5 && muscle.fuelEconomy_l100 > 12, 'eco ' + eco.fuelEconomy_l100 + ' muscle ' + muscle.fuelEconomy_l100);
  assert.ok(eco.ratings.efficiency > muscle.ratings.efficiency + 25);
  assert.ok(eco.co2_gkm < muscle.co2_gkm / 2);
  assert.ok(Math.abs(eco.fuelEconomy_mpg - 235.215 / eco.fuelEconomy_l100) < 0.1);
  assert.ok(eco.electricRange_km > 20, 'plug-in EV range ' + eco.electricRange_km);
  const ice = P.compute(with_(preset('eco-commuter'), { engine: { type: 'ice' } }));
  assert.ok(eco.fuelEconomy_l100 < ice.fuelEconomy_l100, 'hybrid beats the same car without the e-motor');
  const ev = P.compute(preset('atelier-shuttle'));
  assert.ok(ev.efficiency_whkm > 150 && ev.range_km > 200 && ev.co2_gkm === 0);
  const tank = P.compute(mk());
  assert.ok(Math.abs(tank.range_km - 60 / tank.fuelEconomy_l100 * 100) < 1.5, 'ICE range uses the 60 L tank');
  const draggy = P.compute(mk({ aero: { wing: 'biplane', wingAngle_deg: 20, splitter: 'race' } }));
  assert.ok(draggy.fuelEconomy_l100 > tank.fuelEconomy_l100, 'drag costs fuel');
});

/* ------------------------------------------------------------------ comfort, noise, ratings, lap */
test('physics: comfort, noise, sound and practicality respond to the build', () => {
  const plush = P.compute(mk({ suspension: { type: 'air', damping: 3, springFront_nmm: 40, springRear_nmm: 45 }, interior: { seatType: 'lounge' }, tires: { profileFront: 45, profileRear: 40 }, wheels: { diameter_in: 19 } }));
  const harsh = P.compute(mk({ suspension: { type: 'coilover-track', damping: 9, springFront_nmm: 200, springRear_nmm: 220, rideHeight_mm: 80 }, interior: { seatType: 'race-shell' }, weight: { rollCage: 'full', soundDeadening: false } }));
  assert.ok(plush.comfortIndex > harsh.comfortIndex + 25, 'comfort ' + plush.comfortIndex + ' vs ' + harsh.comfortIndex);
  assert.ok(harsh.noise_db_cabin > plush.noise_db_cabin);
  const straight = P.compute(mk({ engine: { exhaust: 'straight-pipe' } })), stock = P.compute(mk({ engine: { exhaust: 'stock' } }));
  assert.ok(straight.exhaust_db > stock.exhaust_db + 15 && straight.ratings.sound > stock.ratings.sound);
  const ev = P.compute(preset('electric-hyper'));
  assert.ok(ev.ratings.sound < 30 && ev.exhaust_db < 70);
  const van = P.compute(preset('atelier-shuttle')), hyper = P.compute(preset('track-weapon'));
  assert.ok(van.ratings.practicality > hyper.ratings.practicality + 40);
  assert.ok(hyper.ratings.track > van.ratings.track + 40);
});

test('physics: lap time — Redline Ring order of the presets is sensible', () => {
  const t = {};
  D.presets.forEach((p) => { t[p.id] = P.compute(preset(p.id)).lapTime_s; });
  console.log('       laps: ' + Object.keys(t).map((k) => k + ' ' + t[k].toFixed(1)).join(', '));
  assert.ok(t['le-mans-hybrid'] < t['alpine-gt'] && t['track-weapon'] < t['alpine-gt']);
  assert.ok(t['alpine-gt'] < t['eco-commuter'] && t['hot-hatch'] < t['eco-commuter']);
  assert.ok(t['track-weapon'] < t['muscle']);
  const m = P.compute(mk());
  assert.ok(m.lapTime_s > 125 && m.lapTime_s < 175, 'default lap ' + m.lapTime_s);
  // lighter is faster
  const light = P.compute(mk({ body: { chassisMaterial: 'carbon-monocoque' } }));
  assert.ok(light.lapTime_s < m.lapTime_s);
});

test('physics: reliability falls with aggressive tunes and boost', () => {
  const r = ['eco', 'stock', 'stage1', 'stage2', 'stage3', 'time-attack'].map((t) => P.compute(mk({ engine: { tune: t } })).reliabilityScore);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] <= r[i - 1], 'tune reliability ' + r.join(','));
  assert.ok(r[0] - r[5] > 20);
  const lo = P.compute(mk({ engine: { boost_bar: 0.8 } })), hi = P.compute(mk({ engine: { boost_bar: 2.0, fuel: 'race' } }));
  assert.ok(hi.reliabilityScore < lo.reliabilityScore);
});

test('physics: limiter & governor hold speed — the sim never overshoots the top speed', () => {
  const ids = ['default'].concat(D.presets.map((p) => p.id));
  ids.forEach((id) => {
    const m = P.compute(id === 'default' ? mk() : preset(id));
    const vmax = Math.max.apply(null, m.accelCurve.map((p) => p.kph));
    assert.ok(vmax <= m.topSpeed_kph + 0.15, id + ': accel curve ' + vmax + ' > top ' + m.topSpeed_kph);
    if (m.quarterMileTrap_mph != null) assert.ok(m.quarterMileTrap_mph <= m.topSpeed_mph + 0.1, id + ': trap above top speed');
  });
});

test('physics: torque-limited gearbox — more engine power is never slower on track (heat derate before the limiter)', () => {
  const m = P.compute(preset('muscle'));
  const hot = P.compute(with_(preset('muscle'), { engine: { tune: 'time-attack' } }));
  assert.ok(hot.lapTime_s <= m.lapTime_s + 0.011, 'lap ' + m.lapTime_s + ' → ' + hot.lapTime_s);
  // e-turbo plateau starts earlier and is at least as wide as the single turbo's
  const t = P.compute(mk({ engine: { aspiration: 'turbo', boost_bar: 1.8 } }));
  const e = P.compute(mk({ engine: { aspiration: 'electric-turbo', boost_bar: 1.8 } }));
  const width = (x) => x.curve.filter((p) => p.nm >= x.torque_nm * 0.985).length;
  assert.ok(width(e) >= width(t), 'plateau width ' + width(t) + ' vs ' + width(e));
});

/* FORGE Atelier — CB.game.endurance tests. Run: node tests/run.js endurance */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

const E = require('../js/game/endurance.js');
const CB = globalThis.CB;

/* ------------------------------------------------------------------ fixtures */
const VP = { mass: 1450, powerKw: 320, weightFront: 0.52, wheelbase: 2.65, track: 1.6, cgHeight: 0.5, muF: 1.05, maxLatG: 1.0, maxBrakeG: 1.05,
  cdA: 0.7, clA: 0.3, brakeForceMax: 1450 * 9.81 * 1.25, brakeBias: 0.62, radiusF: 0.33, radiusR: 0.34, redline: 7500, idle: 850, layout: 'rwd', topSpeed_ms: 80 };
const EV_VP = Object.assign({}, VP, { isEV: true, mass: 2100, powerKw: 450, redline: 16000, idle: 0 });
function build(patch) {
  const b = { meta: { id: 'test' }, engine: { type: 'ice', fuel: 'premium', displacement_l: 3, cooling: 'standard', tune: 'stock', position: 'front' },
    tires: { compound: 'performance', widthFront_mm: 255, widthRear_mm: 255 }, brakes: { material: 'iron', frontRotor_mm: 360, rearRotor_mm: 330 },
    drivetrain: { layout: 'rwd' }, body: { style: 'coupe' } };
  if (patch) for (const k of Object.keys(patch)) b[k] = Object.assign({}, b[k] || {}, patch[k]);
  return b;
}
const evBuild = () => build({ engine: { type: 'ev', battery_kwh: 80, motors: 2, motorPower_kw: 225, regen: 2 } });
function fresh(opts, b, vp) { return E.createCarState(vp || VP, b || build(), Object.assign({ seed: 42 }, opts || {})); }

/** drive with a synthetic vehicle state (fallback wheel-force reconstruction path) */
function drive(cs, seconds, vs, input, env, dt) {
  dt = dt || 1 / 60;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) E.step(cs, typeof vs === 'function' ? vs(i * dt) : vs, input || { throttle: vs.throttle || 0, brake: 0 }, dt, env || {});
  return cs;
}
const CRUISE = { speed: 30, vx: 30, ax: 0, ay: 0, throttle: 0.3, rpm: 4500 };
const CORNER = { speed: 30, vx: 30, ax: 0, ay: 9.5, throttle: 0.45, rpm: 5500 };   // ~0.97 g sustained
const avg4 = (a) => (a[0] + a[1] + a[2] + a[3]) / 4;
const max4 = (a) => Math.max.apply(null, a);

/* ------------------------------------------------------------------ API & state */
test('endurance: API surface per GAME-SPEC', () => {
  ['createCarState', 'step', 'modifiers', 'applyImpact', 'pitStop', 'suggestStrategy', 'pitLaneInfo', 'inPitLane', 'liveAdvice', 'summary',
    'drainEvents', 'setFuelMap', 'environment', 'tempGrip', 'wearGrip', 'compoundInfo', 'createHooks', 'clone', 'simulateLap', 'simulateStint',
    'pitTimeEstimate', 'applyToParams', 'vehicleEnv'].forEach((k) => assert.equal(typeof E[k], 'function', k));
  assert.equal(CB.game.endurance, E);
  assert.equal(E.PIT_SPEED_LIMIT_KPH, 60);
  assert.equal(E.FUEL_RATE_LPS, 2.5);
});

test('endurance: createCarState shape (ICE)', () => {
  const cs = fresh();
  assert.equal(cs.tireWear.length, 4);
  assert.deepEqual(cs.tireWear, [0, 0, 0, 0]);
  assert.equal(cs.tireTemp_c.length, 4);
  cs.tireTemp_c.forEach((t) => assert.ok(t > 0 && t < 60));
  assert.equal(cs.fuel_l, 60);
  assert.equal(cs.tankCapacity_l, 60);
  assert.deepEqual(Object.keys(cs.damage).sort(), ['aero', 'engine', 'front', 'left', 'rear', 'right']);
  assert.ok(Number.isFinite(cs.brakeTemp_c));
  assert.equal(cs.battery, null);
  assert.equal(cs.compound, 'performance');
  assert.equal(cs.mass_kg, 1450);
  // JSON-serialisable round trip
  assert.deepEqual(JSON.parse(JSON.stringify(cs)), cs);
});

test('endurance: createCarState honours opts (fuel, tank, compound, blankets)', () => {
  const cs = fresh({ tank_l: 100, fuel_l: 40, compound: 'slick', tireBlankets: true });
  assert.equal(cs.tankCapacity_l, 100);
  assert.equal(cs.fuel_l, 40);
  assert.equal(cs.compound, 'slick');
  const win = E.compoundInfo('slick').window;
  cs.tireTemp_c.forEach((t) => assert.ok(t >= win[0] - 1, 'blanket-warmed slicks start near the window'));
  // light-fuel start: car is lighter than its full-tank reference
  assert.ok(cs.mass_kg < 1450 && cs.mass_kg > 1450 - 61 * 0.75);
});

test('endurance: EV state has a battery and no fuel', () => {
  const cs = fresh({}, evBuild(), EV_VP);
  assert.equal(cs.isEV, true);
  assert.equal(cs.fuel_l, 0);
  assert.ok(cs.battery);
  assert.equal(cs.battery.capacity_kwh, 80);
  assert.equal(cs.battery.soc, 1);
});

test('endurance: missing inputs never throw and stay finite', () => {
  const cs = E.createCarState(null, null, null);
  E.step(cs, null, null, 1 / 60, null);
  E.step(cs, {}, {}, NaN, {});
  E.step(cs, { speed: 50 }, { throttle: 1 }, 0.5);
  const m = E.modifiers(cs);
  ['powerMult', 'dragMult', 'downforceMult', 'steerPull', 'brakeMult'].forEach((k) => assert.ok(Number.isFinite(m[k]), k));
  assert.deepEqual(E.modifiers(null).gripMult, [1, 1]);
  assert.equal(E.step(null, {}, {}, 0.1), null);
  assert.equal(E.summary({}), null);
});

/* ------------------------------------------------------------------ grip curves */
test('endurance: tempGrip peaks inside the compound window', () => {
  for (const id of Object.keys(E.COMPOUNDS)) {
    const c = E.compoundInfo(id);
    const mid = (c.window[0] + c.window[1]) / 2;
    const gMid = E.tempGrip(id, mid);
    assert.ok(gMid > 0.99, id + ' optimal');
    assert.ok(E.tempGrip(id, c.window[0] - 40) < gMid - 0.02, id + ' cold loses grip');
    assert.ok(E.tempGrip(id, c.window[1] + 50) < gMid - 0.05, id + ' overheated loses grip');
    assert.ok(E.tempGrip(id, c.window[0] - 40) > 0.5);
  }
  // cold slicks are far worse than cold road tyres
  assert.ok(E.tempGrip('slick', 25) < E.tempGrip('touring', 25) - 0.1);
});

test('endurance: wearGrip — scrub-in, gradual fade, cliff', () => {
  assert.ok(E.wearGrip(0) < E.wearGrip(0.03));
  assert.ok(E.wearGrip(0.3) > E.wearGrip(0.6));
  const slopeEarly = E.wearGrip(0.3) - E.wearGrip(0.4), slopeLate = E.wearGrip(0.85) - E.wearGrip(0.95);
  assert.ok(slopeLate > slopeEarly * 3, 'cliff past 70%');
  assert.ok(E.wearGrip(1) < 0.75);
});

/* ------------------------------------------------------------------ thermals */
test('endurance: slip power heats tyres; cornering hotter than cruising', () => {
  const a = drive(fresh(), 90, CRUISE);
  const b = drive(fresh(), 90, CORNER);
  assert.ok(avg4(b.tireTemp_c) > avg4(a.tireTemp_c) + 10, 'cornering ' + avg4(b.tireTemp_c) + ' vs ' + avg4(a.tireTemp_c));
  // left-hand corner (ay > 0) loads the right-side tyres -> they run hotter
  assert.ok(b.tireTemp_c[1] > b.tireTemp_c[0]);
  assert.ok(b.tireTemp_c[3] > b.tireTemp_c[2]);
  // core lags the surface while warming
  assert.ok(b.tireCore_c[1] < b.tireTemp_c[1]);
  assert.ok(b.stats.slipEnergy_MJ > a.stats.slipEnergy_MJ);
});

test('endurance: tyres cool toward ambient; faster at speed and in the wet', () => {
  const hot = () => { const cs = fresh(); cs.tireTemp_c = [110, 110, 110, 110]; cs.tireCore_c = [95, 95, 95, 95]; return cs; };
  const stopped = drive(hot(), 30, { speed: 0, vx: 0 }, { throttle: 0 });
  const rolling = drive(hot(), 30, { speed: 45, vx: 45, ax: 0, ay: 0, throttle: 0.05 }, { throttle: 0.05 });
  const wet = drive(hot(), 30, { speed: 45, vx: 45, ax: 0, ay: 0, throttle: 0.05 }, { throttle: 0.05 }, { wetness: 1 });
  assert.ok(avg4(stopped.tireTemp_c) < 110);
  assert.ok(avg4(rolling.tireTemp_c) < avg4(stopped.tireTemp_c), 'airflow cools');
  assert.ok(avg4(wet.tireTemp_c) < avg4(rolling.tireTemp_c) - 5, 'standing water cools');
  // hot ambient keeps tyres warmer
  const coolDay = drive(fresh({ ambient_c: 10, trackTemp_c: 14 }), 60, CRUISE);
  const hotDay = drive(fresh({ ambient_c: 35, trackTemp_c: 50 }), 60, CRUISE);
  assert.ok(avg4(hotDay.tireTemp_c) > avg4(coolDay.tireTemp_c) + 10);
});

test('endurance: tyre pressure follows carcass temperature (ideal gas)', () => {
  const cs = drive(fresh(), 120, CORNER);
  const p0 = cs.cfg.coldPressure_kpa;
  assert.ok(cs.tirePressure_kpa[1] > p0 * 1.05);
});

test('endurance: warming tyres into the window increases grip', () => {
  const cs = fresh({ compound: 'track' });
  const g0 = avg4(cs.tireGrip);
  drive(cs, 150, CORNER);
  assert.ok(avg4(cs.tireGrip) > g0 + 0.03, g0 + ' -> ' + avg4(cs.tireGrip));
});

/* ------------------------------------------------------------------ wear */
test('endurance: softer compounds wear faster (treadwear rating)', () => {
  const slick = drive(fresh({ compound: 'slick' }), 120, CORNER);
  const perf = drive(fresh({ compound: 'performance' }), 120, CORNER);
  const eco = drive(fresh({ compound: 'eco' }), 120, CORNER);
  assert.ok(max4(slick.tireWear) > max4(perf.tireWear) * 1.5, 'slick vs performance');
  assert.ok(max4(perf.tireWear) > max4(eco.tireWear), 'performance vs eco');
  assert.ok(max4(eco.tireWear) > 0);
});

test('endurance: abrasive surfaces and wearMult scale wear', () => {
  const asph = drive(fresh(), 60, CORNER, null, { surface: 'asphalt' });
  const gravel = drive(fresh(), 60, CORNER, null, { surface: 'gravel' });
  const x3 = drive(fresh({ wearMult: 3 }), 60, CORNER);
  assert.ok(max4(gravel.tireWear) > max4(asph.tireWear) * 1.4);
  assert.ok(max4(x3.tireWear) > max4(asph.tireWear) * 2.5);
});

test('endurance: 100% wear punctures the tyre, emits event, kills grip & pulls', () => {
  const cs = fresh();
  cs.tireWear = [0.9995, 0.2, 0.2, 0.2];
  drive(cs, 5, CORNER);
  assert.equal(cs.punctured[0], true);
  assert.equal(cs.tireWear[0], 1);
  const ev = E.drainEvents(cs);
  assert.ok(ev.some((e) => e.type === 'puncture' && e.wheel === 0));
  assert.equal(E.drainEvents(cs).length, 0, 'drained');
  const m = E.modifiers(cs);
  assert.ok(m.wheelGrip[0] < 0.5);
  assert.ok(m.gripMult[0] < m.gripMult[1]);
  assert.ok(m.steerPull > 0, 'FL puncture pulls left');
  assert.ok(m.rollingMult > 1);
  assert.ok(m.dragMult > 1);
});

/* ------------------------------------------------------------------ fuel & mass */
test('endurance: fuel burn scales with throttle × power (BSFC)', () => {
  const full = drive(fresh(), 60, { speed: 50, vx: 50, ax: 0, ay: 0, throttle: 1, rpm: 6500 }, { throttle: 1 });
  const part = drive(fresh(), 60, { speed: 50, vx: 50, ax: 0, ay: 0, throttle: 0.3, rpm: 6500 }, { throttle: 0.3 });
  const lift = drive(fresh(), 60, { speed: 50, vx: 50, ax: 0, ay: 0, throttle: 0, rpm: 6500 }, { throttle: 0 });
  const usedFull = 60 - full.fuel_l, usedPart = 60 - part.fuel_l;
  assert.ok(usedFull > usedPart * 2, usedFull + ' vs ' + usedPart);
  assert.ok(60 - lift.fuel_l < 0.01, 'overrun fuel cut');
  // physical plausibility: ~300 kW for 60 s at ~260 g/kWh -> ~1.3 kg -> ~1.8 L (allow broad band)
  assert.ok(usedFull > 0.8 && usedFull < 4, 'litres ' + usedFull);
  // more powerful car burns more at full throttle
  const big = drive(E.createCarState(Object.assign({}, VP, { powerKw: 600 }), build(), { seed: 1 }), 60, { speed: 50, vx: 50, throttle: 1, rpm: 6500 }, { throttle: 1 });
  assert.ok(60 - big.fuel_l > usedFull * 1.5);
});

test('endurance: fuel maps trade power for consumption', () => {
  const vs = { speed: 50, vx: 50, throttle: 1, rpm: 6500 };
  const lean = E.setFuelMap(fresh(), 'lean'), push = E.setFuelMap(fresh(), 'push');
  assert.ok(E.modifiers(lean).powerMult < E.modifiers(push).powerMult);
  drive(lean, 30, vs, { throttle: 1 }); drive(push, 30, vs, { throttle: 1 });
  assert.ok(60 - lean.fuel_l < 60 - push.fuel_l);
  assert.equal(E.setFuelMap(fresh(), 'bogus').fuelMap, 'normal');
});

test('endurance: burning fuel lightens the car -> mass-equivalent power/grip boost', () => {
  const cs = fresh({ tank_l: 80 });
  const m0 = E.modifiers(cs);
  cs.fuel_l = 10;
  drive(cs, 0.1, CRUISE);
  const m1 = E.modifiers(cs);
  assert.ok(cs.mass_kg < 1450 - 30, 'mass ' + cs.mass_kg);
  assert.ok(m1.massRatio > 1);
  assert.ok(m1.powerMult > m0.powerMult);
  assert.ok(m1.wheelGrip[0] >= m0.wheelGrip[0] * 0.99);
  assert.equal(m1.raw.powerMult <= m1.powerMult, true);
});

test('endurance: running dry cuts power and emits fuel events', () => {
  const cs = fresh({ fuel_l: 1.5 });
  drive(cs, 120, { speed: 50, vx: 50, throttle: 1, rpm: 6500 }, { throttle: 1 });
  assert.equal(cs.fuel_l, 0);
  assert.equal(E.modifiers(cs).powerMult, 0);
  assert.equal(E.modifiers(cs).engineAlive, false);
  const types = E.drainEvents(cs).map((e) => e.type);
  assert.ok(types.includes('fuel-critical'));
  assert.ok(types.includes('fuel-empty'));
});

test('endurance: EV drains SoC under power and recovers it with regen', () => {
  const cs = fresh({}, evBuild(), EV_VP);
  drive(cs, 60, { speed: 50, vx: 50, throttle: 1 }, { throttle: 1 });
  const afterDrive = cs.battery.energy_kwh;
  assert.ok(afterDrive < 80 - 2, 'used ' + (80 - afterDrive));
  assert.ok(cs.battery.soc < 1);
  drive(cs, 6, (t) => ({ speed: Math.max(5, 60 - t * 9), vx: Math.max(5, 60 - t * 9), ax: -9, throttle: 0 }), { throttle: 0, brake: 0.9 });
  assert.ok(cs.battery.energy_kwh > afterDrive, 'regen recovers energy');
  assert.ok(cs.stats.regen_kwh > 0);
  assert.equal(cs.fuel_l, 0);
  // empty battery limits power hard
  cs.battery.energy_kwh = 0; cs.battery.soc = 0;
  assert.ok(E.modifiers(cs).powerMult < 0.1);
});

/* ------------------------------------------------------------------ brakes */
const BRAKE_CYCLE = (t) => {
  const ph = t % 12;
  if (ph < 3) { const v = 75 - ph * 16; return { speed: v, vx: v, ax: -16, throttle: 0 }; }
  const v = 27 + (ph - 3) * 5.3; return { speed: v, vx: v, ax: 5, throttle: 1 };
};
const BRAKE_INPUT = null;
function brakeLaps(cs, seconds) {
  const dt = 1 / 60, n = Math.round(seconds / dt);
  cs._peakFade = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt, vs = BRAKE_CYCLE(t);
    E.step(cs, vs, { throttle: vs.throttle, brake: (t % 12) < 3 ? 1 : 0 }, dt, {});
    if (t > 20) cs._peakFade = Math.max(cs._peakFade, cs.brakeFade);
  }
  return cs;
}
test('endurance: heavy braking heats brakes; iron fades, carbon-ceramic resists', () => {
  const iron = brakeLaps(fresh({}, build({ brakes: { material: 'iron', frontRotor_mm: 280, rearRotor_mm: 260 } })), 240);
  const cc = brakeLaps(fresh({}, build({ brakes: { material: 'carbon-ceramic', frontRotor_mm: 280, rearRotor_mm: 260 } })), 240);
  assert.ok(iron.brakeTemp_c > 300, 'iron ' + iron.brakeTemp_c);
  assert.ok(iron.stats.maxBrakeTemp_c >= iron.brakeTemp_c);
  assert.ok(iron._peakFade > 0.03 && iron._peakFade > cc._peakFade * 2, 'iron fade ' + iron._peakFade + ' vs cc ' + cc._peakFade);
  assert.ok(iron.brakeWear > 0);
  // cool-down
  const T = iron.brakeTemp_c;
  drive(iron, 60, { speed: 40, vx: 40, throttle: 0.2 }, { throttle: 0.2 });
  assert.ok(iron.brakeTemp_c < T - 50);
  void BRAKE_INPUT;
});

test('endurance: overheated brake past fade onset reduces brake multiplier', () => {
  const cs = fresh();
  cs.brakeTemps_c = [cs.cfg.brake.fadeOnset_c + 200, cs.cfg.brake.fadeOnset_c + 200];
  E.step(cs, { speed: 1 }, { brake: 0 }, 1 / 60, {});
  assert.ok(cs.brakeFade > 0.3);
  assert.ok(E.modifiers(cs).brakeMult < 0.7);
  assert.ok(E.drainEvents(cs).some((e) => e.type === 'brake-fade'));
});

/* ------------------------------------------------------------------ damage */
test('endurance: small knocks do nothing; front hit damages nose & aero', () => {
  const cs = fresh();
  const r0 = E.applyImpact(cs, 500, { x: 1, y: 0 });
  assert.equal(r0.severity, 0);
  assert.equal(cs.damage.front, 0);
  const r = E.applyImpact(cs, 1450 * 12, { x: 1, y: 0 }, { wall: true });
  assert.ok(r.severity > 0.2, 'sev ' + r.severity);
  assert.ok(cs.damage.front > cs.damage.rear);
  assert.ok(cs.damage.aero > 0);
  assert.ok(cs.damage.engine > 0, 'front-engined car hit in the nose');
  const m = E.modifiers(cs);
  assert.ok(m.dragMult > 1);
  assert.ok(m.downforceMult < 1);
  assert.ok(m.powerMult < 1);
  assert.ok(E.drainEvents(cs).some((e) => e.type === 'damage'));
});

test('endurance: side damage causes steering pull toward the damaged side', () => {
  const left = fresh(), right = fresh();
  E.applyImpact(left, { x: 0, y: 1450 * 10 }, [0, 1]);
  E.applyImpact(right, 1450 * 10, -Math.PI / 2);
  assert.ok(left.damage.left > 0 && left.damage.right === 0);
  assert.ok(right.damage.right > 0);
  assert.ok(E.modifiers(left).steerPull > 0, 'pull left');
  assert.ok(E.modifiers(right).steerPull < 0, 'pull right');
  assert.ok(Math.abs(E.modifiers(left).steerPull) <= 0.22);
});

test('endurance: damageMult 0 / features.damage false disable damage', () => {
  const cs = fresh({ features: { damage: false } });
  E.applyImpact(cs, 1450 * 20, { x: 1, y: 0 });
  assert.equal(cs.damage.front, 0);
  assert.equal(E.modifiers(cs).dragMult, 1);
});

test('endurance: overheating engine accumulates damage; failure kills power', () => {
  const cs = fresh();
  cs.damage.front = 1; // radiator destroyed
  drive(cs, 300, { speed: 8, vx: 8, throttle: 1, rpm: 7000 }, { throttle: 1 }, { ambient_c: 38 });
  assert.ok(cs.stats.maxEngineTemp_c > 110, 'eng ' + cs.stats.maxEngineTemp_c);
  assert.ok(cs.damage.engine > 0);
  cs.damage.engine = 0.99;
  E.step(cs, { speed: 10 }, { throttle: 1 }, 0.1, {});
  assert.equal(cs.engineFailed, true);
  assert.equal(E.modifiers(cs).engineAlive, false);
});

/* ------------------------------------------------------------------ pit stops */
test('endurance: tyre change takes 2.5-4 s depending on crew quality', () => {
  const means = [0, 0.5, 1].map((q) => {
    let s = 0, n = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const cs = fresh({ seed, crewQuality: q });
      const r = E.pitStop(cs, { tires: true });
      if (!r.fumble) { s += r.timing.tires_s; n++; }
      assert.ok(r.timing.tires_s >= 2.2);
    }
    return s / n;
  });
  assert.ok(Math.abs(means[0] - 4) < 0.25, 'poor crew ~4 s: ' + means[0]);
  assert.ok(Math.abs(means[2] - 2.5) < 0.15, 'elite crew ~2.5 s: ' + means[2]);
  assert.ok(means[0] > means[1] && means[1] > means[2]);
});

test('endurance: pitStop is pure, refuels at 2.5 L/s, fresh tyres, parallel service', () => {
  const cs = fresh({ fuel_l: 10, crewQuality: 1 });
  cs.tireWear = [0.7, 0.75, 0.8, 0.85]; cs.punctured[3] = true;
  const before = JSON.stringify(cs);
  const r = E.pitStop(cs, { tires: true, compound: 'super-sport', fuel_l: 25 });
  assert.equal(JSON.stringify(cs), before, 'input state untouched');
  const ns = r.newState;
  assert.deepEqual(ns.tireWear, [0, 0, 0, 0]);
  assert.deepEqual(ns.punctured, [false, false, false, false]);
  assert.equal(ns.compound, 'super-sport');
  assert.equal(ns.fuel_l, 35);
  assert.equal(r.fuelAdded_l, 25);
  assert.ok(Math.abs(r.timing.fuel_s - (0.8 + 25 / 2.5)) < 1e-9);
  assert.equal(r.timing.service_s, Math.max(r.timing.tires_s, r.timing.fuel_s));
  assert.ok(Math.abs(r.duration_s - (r.timing.stationary_s + r.timing.service_s + r.timing.repair_s)) < 1e-9);
  assert.equal(ns.stats.pitStops, 1);
  assert.equal(ns.pits.length, 1);
  assert.ok(Array.isArray(r.breakdown) && r.breakdown.length >= 2);
  // sequential service adds instead of overlapping
  const seq = E.pitStop(cs, { tires: true, fuel_l: 25, sequential: true });
  assert.ok(Math.abs(seq.timing.service_s - (seq.timing.tires_s + seq.timing.fuel_s)) < 1e-9);
  // cannot overfill
  const over = E.pitStop(cs, { fuel_l: 500 });
  assert.equal(over.newState.fuel_l, cs.tankCapacity_l);
  // fuelTo_l
  assert.equal(E.pitStop(cs, { fuelTo_l: 30 }).newState.fuel_l, 30);
});

test('endurance: partial tyre change keeps compound; repairs take time and restore', () => {
  const cs = fresh({ crewQuality: 0.5 });
  E.applyImpact(cs, 1450 * 15, { x: 1, y: 0.4 });
  const dmg = cs.damage.front;
  assert.ok(dmg > 0);
  const quick = E.pitStop(cs, { repair: 'quick' });
  const full = E.pitStop(cs, { repair: true });
  assert.ok(quick.timing.repair_s > 0);
  assert.ok(full.timing.repair_s > quick.timing.repair_s);
  assert.ok(quick.newState.damage.front < dmg && quick.newState.damage.front > 0);
  assert.equal(full.newState.damage.front, 0);
  assert.deepEqual(full.newState.suspension, [0, 0, 0, 0]);
  const two = E.pitStop(cs, { tires: [true, true, false, false], compound: 'slick' });
  assert.equal(two.tiresChanged, 2);
  assert.equal(two.newState.compound, cs.compound);
  assert.ok(E.pitStop(cs, { tires: [true, true, false, false] }).timing.tires_s <= E.pitStop(cs, { tires: true }).timing.tires_s + 1.5);
  // brakes service
  const br = E.pitStop(cs, { brakes: true });
  assert.ok(br.timing.repair_s > 10);
  assert.equal(br.newState.brakeWear, 0);
});

test('endurance: EV pit charge with taper above 80 % SoC', () => {
  const cs = fresh({ soc: 0.3 }, evBuild(), EV_VP);
  const r = E.pitStop(cs, { charge_kwh: 20 });
  assert.ok(Math.abs(r.newState.battery.energy_kwh - 44) < 1e-6);
  assert.ok(Math.abs(r.timing.fuel_s - (1.5 + 20 / E.EV_CHARGE_KWPS)) < 1e-6);
  const high = E.pitStop(fresh({ soc: 0.8 }, evBuild(), EV_VP), { charge_kwh: 10 });
  assert.ok(high.timing.fuel_s > r.timing.fuel_s * 0.9, 'taper is slower per kWh');
  assert.equal(E.pitStop(cs, { chargeTo_soc: 1 }).newState.battery.soc, 1);
});

test('endurance: pitTimeEstimate matches mean pit stop', () => {
  const est = E.pitTimeEstimate({ tires: true, fuel_l: 0, crewQuality: 1 });
  assert.ok(est > 1.2 + 2.4 && est < 1.2 + 3);
  assert.ok(Math.abs(E.pitTimeEstimate({ tires: false, fuel_l: 50 }) - (1.2 + 0.8 + 20)) < 1e-9);
});

/* ------------------------------------------------------------------ pit lane */
test('endurance: pitLaneInfo explicit, derived from samples, and fallback; inPitLane wraps', () => {
  const ex = E.pitLaneInfo({ length: 5000, pitEntry_s: 4700, pitExit_s: 250 });
  assert.equal(ex.entry_s, 4700); assert.equal(ex.exit_s, 250); assert.equal(ex.derived, false);
  assert.equal(ex.length_m, 550);
  assert.equal(ex.speedLimit_kph, 60);
  assert.ok(ex.laneLoss_s > 0);
  assert.ok(E.inPitLane(4900, ex)); assert.ok(E.inPitLane(100, ex)); assert.ok(E.inPitLane(5100, ex));
  assert.ok(!E.inPitLane(2500, ex));
  const samples = [];
  for (let i = 0; i < 500; i++) samples.push({ curvature: (i > 40 && i < 460) ? 0.01 : 0 });
  const dv = E.pitLaneInfo({ length: 5000, samples });
  assert.equal(dv.derived, true);
  assert.ok(dv.entry_s > 4000 && dv.exit_s < 500);
  const fb = E.pitLaneInfo(3000);
  assert.ok(fb.derived && fb.entry_s > 2500 && fb.exit_s < 300);
  assert.equal(E.inPitLane(NaN, fb), false);
});

/* ------------------------------------------------------------------ strategy */
test('endurance: suggestStrategy short race -> no stop; stints cover all laps', () => {
  const s = E.suggestStrategy(5, 4000, { params: VP, build: build() });
  assert.equal(s.feasible, true);
  assert.equal(s.stops, 0);
  assert.equal(s.stints.length, 1);
  assert.equal(s.stints[0].laps, 5);
  assert.ok(s.fuelPerLap > 0.5 && s.fuelPerLap < 8, 'fuel/lap ' + s.fuelPerLap);
  assert.ok(s.totalTime_s > 5 * 40);
  assert.ok(s.startFuel_l <= 60 && s.startFuel_l >= s.fuelPerLap * 5);
  assert.ok(Array.isArray(s.notes));
});

test('endurance: suggestStrategy long race -> stops forced by fuel, fuel per stint within tank', () => {
  const s = E.suggestStrategy(60, 5000, { params: VP, build: build(), tank_l: 50 }, { simLaps: 6 });
  assert.equal(s.feasible, true);
  assert.ok(s.stops >= 1);
  assert.equal(s.stints.reduce((a, st) => a + st.laps, 0), 60);
  assert.equal(s.pitStops.length, s.stops);
  s.stints.forEach((st) => { assert.ok(st.laps * s.fuelPerLap <= 50 + 1e-6); assert.ok(st.tireWearEnd <= 0.82 + 1e-6); });
  s.pitStops.forEach((p) => { assert.ok(p.duration_s > 1); assert.ok(p.total_s >= p.duration_s); });
  assert.deepEqual(s.pitLaps, s.pitStops.map((p) => p.lap));
  assert.ok(s.stints[0].startLap === 1 && s.stints[s.stints.length - 1].endLap === 60);
});

test('endurance: analytic strategy — compound choice trades pace vs wear', () => {
  const car = { params: VP, build: build(), fuelPerLap_l: 2.5, lapTime_s: 100, wearPerLap: { slick: 0.06, performance: 0.012 }, compounds: ['slick', 'performance'], tank_l: 100 };
  const s = E.suggestStrategy(30, 4500, car);
  assert.equal(s.feasible, true);
  assert.equal(s.stints.reduce((a, st) => a + st.laps, 0), 30);
  // slicks last ~13 laps (0.82 / 0.06) -> any slick stint must be short
  s.stints.forEach((st) => { if (st.compound === 'slick') assert.ok(st.laps <= 13); });
  assert.ok(s.alternatives.length >= 1);
  s.alternatives.forEach((a) => assert.ok(a.delta_s >= 0));
  assert.ok(s.wearPerLap.slick > s.wearPerLap.performance);
});

test('endurance: infeasible strategy reported cleanly', () => {
  const s = E.suggestStrategy(10, 4000, { params: VP, build: build(), fuelPerLap_l: 30, lapTime_s: 90, wearPerLap: 0.01, tank_l: 20 });
  assert.equal(s.feasible, false);
  assert.ok(s.notes.length);
});

test('endurance: EV strategy plans charging stops', () => {
  const s = E.suggestStrategy(25, 5000, { params: EV_VP, build: evBuild() }, { simLaps: 4 });
  assert.equal(s.isEV, true);
  assert.equal(s.unit, 'kWh');
  assert.ok(s.energyPerLap_kwh > 0);
  if (s.feasible) assert.equal(s.stints.reduce((a, st) => a + st.laps, 0), 25);
});

test('endurance: simulateLap is deterministic and warm tyres are faster than cold', () => {
  const a = E.simulateStint({ params: VP, build: build({ tires: { compound: 'track' } }) }, 3500, 4, { holdFuel: true });
  const b = E.simulateStint({ params: VP, build: build({ tires: { compound: 'track' } }) }, 3500, 4, { holdFuel: true });
  assert.deepEqual(a.laps.map((l) => l.time_s), b.laps.map((l) => l.time_s));
  assert.ok(a.laps[0].time_s > a.laps[3].time_s, 'out-lap on cold tyres is slower');
  const lap = E.simulateLap({ params: VP, build: build() }, 3500);
  assert.ok(lap.time_s > 30 && lap.time_s < 400);
  assert.ok(lap.fuel_l > 0);
});

/* ------------------------------------------------------------------ laps, advice, summary */
test('endurance: lap tracking builds per-lap history; liveAdvice calls the stop', () => {
  const cs = fresh({ fuel_l: 9 });
  for (let lap = 0; lap < 4; lap++) drive(cs, 60, { speed: 50, vx: 50, ax: 0, ay: 6, throttle: 0.8, rpm: 6000 }, { throttle: 0.8 }, { lap });
  E.step(cs, { speed: 50 }, { throttle: 0.5 }, 0.01, { lap: 4 });
  assert.ok(cs.laps.history.length >= 3, 'history ' + cs.laps.history.length);
  assert.ok(cs.laps.history[1].fuel_l > 0);
  const adv = E.liveAdvice(cs, { lapsRemaining: 10 });
  assert.ok(adv.lapsOfFuel < 10);
  assert.ok(adv.reasons.some((r) => /fuel/.test(r)) || adv.lapsOfFuel >= 2.3);
  assert.ok(adv.request.fuel_l > 0);
  assert.ok(adv.estimatedStop_s > 1);
  const sum = E.summary(cs);
  assert.ok(sum.fuelPerLap_l > 0);
  assert.equal(sum.tireState.length, 4);
  assert.ok(sum.tireAge_laps[0] >= 4);
  assert.equal(typeof sum.damageTotal, 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(sum)), sum);
});

test('endurance: liveAdvice boxes for a puncture', () => {
  const cs = fresh();
  cs.punctured[2] = true;
  const a = E.liveAdvice(cs, { lapsRemaining: 5 });
  assert.equal(a.box, true);
  assert.equal(a.request.tires, true);
  assert.equal(E.liveAdvice(cs, { lapsRemaining: 5, wetness: 0.9 }).request.compound, 'wet');
});

test('endurance: wet compounds suit wet tracks; slicks are dreadful in the wet', () => {
  // grip multipliers are relative to the compound the vehicle params were built from (here: slicks)
  const slickBuild = build({ tires: { compound: 'slick' } });
  const slickWet = fresh({ weather: 'wet' }, slickBuild);
  const wetWet = fresh({ compound: 'wet', weather: 'wet' }, slickBuild);
  assert.equal(wetWet.baseCompound, 'slick');
  drive(slickWet, 1, CRUISE, null, { wetness: 1 });
  drive(wetWet, 1, CRUISE, null, { wetness: 1 });
  assert.ok(avg4(wetWet.tireGrip) > avg4(slickWet.tireGrip) * 2, 'wet ' + avg4(wetWet.tireGrip) + ' slick ' + avg4(slickWet.tireGrip));
  assert.ok(E.modifiers(wetWet).gripMult[0] > 2);
  // pitting from slicks to wets in the rain transforms grip; back on a dry track wets lose out
  const pitted = E.pitStop(slickWet, { tires: true, compound: 'wet' }).newState;
  drive(pitted, 1, CRUISE, null, { wetness: 1 });
  assert.ok(avg4(pitted.tireGrip) > avg4(slickWet.tireGrip) * 2);
  const dryWets = fresh({ compound: 'wet', tireBlankets: true }, slickBuild), drySlicks = fresh({ tireBlankets: true }, slickBuild);
  drive(dryWets, 1, CRUISE, null, { wetness: 0 }); drive(drySlicks, 1, CRUISE, null, { wetness: 0 });
  assert.ok(avg4(dryWets.tireGrip) < avg4(drySlicks.tireGrip));
  const env = E.environment('wet', 'night');
  assert.equal(env.wetness, 1);
  assert.ok(env.ambient_c < E.environment('dry', 'day').ambient_c);
});

test('endurance: deterministic for same seed & inputs', () => {
  const run = () => { const cs = fresh({ seed: 7 }); drive(cs, 30, CORNER); E.applyImpact(cs, 1450 * 9, 0.3); return E.pitStop(cs, { tires: true, fuel_l: 10 }); };
  const a = run(), b = run();
  assert.equal(a.duration_s, b.duration_s);
  assert.deepEqual(a.newState, b.newState);
  const c = E.clone(a.newState);
  assert.notEqual(c, a.newState);
  assert.deepEqual(c, a.newState);
});

test('endurance: large dt is sub-stepped stably', () => {
  const a = fresh(), b = fresh();
  E.step(a, CORNER, { throttle: 0.45 }, 2, {});
  for (let i = 0; i < 120; i++) E.step(b, CORNER, { throttle: 0.45 }, 1 / 60, {});
  assert.ok(Math.abs(avg4(a.tireTemp_c) - avg4(b.tireTemp_c)) < 1.5);
  assert.ok(Math.abs(a.fuel_l - b.fuel_l) < 0.02);
});

/* ------------------------------------------------------------------ hooks & vehicle adapters */
test('endurance: createHooks lifecycle with a fake engine car', () => {
  const events = [];
  const hooks = E.createHooks({ extras: { endurance: true, fuel: true, damage: true, onEvent: (e) => events.push(e) }, weather: 'dry', timeOfDay: 'day', seed: 3, fuel_l: 1 });
  const car = { id: 'p1', isPlayer: true, params: VP, build: build(), state: { speed: 50, vx: 50, throttle: 1, rpm: 6500 }, input: { throttle: 1 }, tracker: { lap: 0 } };
  const cs = hooks.carCreated(car);
  assert.equal(car.endurance, cs);
  assert.equal(hooks.state(car), cs);
  for (let i = 0; i < 60 * 60; i++) hooks.postStep(car, 1 / 60);
  assert.ok(events.some((e) => e.type === 'fuel-empty' && e.carId === 'p1'), events.map((e) => e.type).join(','));
  const inp = hooks.preStep(car, { throttle: 1, steer: 0 });
  assert.equal(inp.throttle, 0, 'no fuel -> no throttle');
  const mods = hooks.modifiers(car);
  assert.equal(mods.powerMult, 0);
  const pit = hooks.pitStop(car, { fuel_l: 20, tires: true });
  assert.ok(pit.duration_s > 8);
  assert.equal(car.endurance.fuel_l, 20);
  assert.ok(events.some((e) => e.type === 'pit-stop'));
  car.pitLimiter = true;
  const lim = hooks.preStep(car, { throttle: 1 });
  assert.equal(lim.throttle, 0);
  assert.ok(lim.brake > 0);
  const snap = hooks.snapshot(car);
  assert.equal(snap.enabled, true);
  const imp = hooks.onImpact(car, 1450 * 10, { x: -1, y: 0 });
  assert.ok(imp.severity > 0);
  assert.ok(hooks.advice(car, { lapsRemaining: 3 }));
  // non-endurance cars are left alone
  assert.equal(hooks.modifiers({ id: 'ghost' }), null);
  assert.deepEqual(hooks.preStep({ id: 'ghost' }, { throttle: 1 }), { throttle: 1 });
});

test('endurance: createHooks playerOnly skips AI cars; feature flags propagate', () => {
  const hooks = E.createHooks({ playerOnly: true, extras: { fuel: false } });
  assert.equal(hooks.carCreated({ id: 'ai', isPlayer: false, params: VP }), null);
  const cs = hooks.carCreated({ id: 'me', isPlayer: true, params: VP, build: build() });
  assert.equal(cs.features.fuel, false);
  drive(cs, 10, { speed: 50, throttle: 1 }, { throttle: 1 });
  assert.equal(cs.fuel_l, 60);
});

test('endurance: applyToParams bakes fuel mass, power, aero and brakes into vehicle params', () => {
  const params = Object.freeze(Object.assign({}, VP, { torqueTable: [100, 300, 400, 350], peakNm: 400, maxBrakeTorqueF: 3000, maxBrakeTorqueR: 1800, Iz: 2400, sideCdA: 2.2 }));
  const cs = fresh({ tank_l: 80 });
  const neutral = E.applyToParams(params, E.modifiers(cs));
  assert.equal(neutral, params, 'neutral mods return the same object');
  cs.fuel_l = 20;
  E.applyImpact(cs, 1450 * 14, { x: 1, y: 0 });
  E.step(cs, { speed: 0 }, {}, 0.01, {});
  const m = E.modifiers(cs);
  const cache = {};
  const p = E.applyToParams(params, m, { cache });
  assert.notEqual(p, params);
  assert.ok(p.mass < params.mass - 40);
  assert.ok(p.cdA > params.cdA);
  assert.ok(p.clA < params.clA);
  assert.ok(p.torqueTable[2] < 400, 'engine damage reduces torque');
  assert.ok(Math.abs(p.Iz / params.Iz - p.mass / params.mass) < 1e-9);
  assert.equal(E.applyToParams(params, m, { cache }), p, 'memoised');
  const eq = E.applyToParams(params, m, { massMode: 'equivalent' });
  assert.equal(eq.mass, params.mass);
  assert.ok(eq.powerKw > p.powerKw, 'mass-equivalent power folds in lighter car');
  const env = E.vehicleEnv(m, { gripMult: 0.9, wet: 0, surface: 'grass' });
  assert.equal(env.gripMult, 0.9);
  assert.equal(env.wheelGrip.length, 4);
  assert.equal(env.dragMult, undefined, 'aero drag not mapped onto the surface drag term');
});

/* ------------------------------------------------------------------ real vehicle model (optional) */
test('endurance: integrates with CB.race.vehicle when present', () => {
  let V, D;
  try { require('../js/util.js'); D = require('../js/data.js'); try { require('../js/state.js'); } catch (e) { /* optional */ } V = require('../js/race/vehicle.js'); }
  catch (e) { return; } // race team's module absent -> skip
  if (!V || typeof V.fromBuild !== 'function' || !D || typeof D.defaultBuild !== 'function') return;
  let b = D.defaultBuild();
  if (CB.state && typeof CB.state.normalize === 'function') b = CB.state.normalize(b) || b;
  const vp0 = V.fromBuild(b, null, { noPhysics: true });
  const s = V.createState(vp0, { x: 0, y: 0, heading: 0, autoShift: true });
  const cs = E.createCarState(vp0, b, { seed: 1 });
  const cache = {};
  const dt = 1 / 120;
  for (let k = 0; k < 120 * 40; k++) {
    const t = k * dt, ph = t % 20;
    const inp = ph < 8 ? { throttle: 1, brake: 0, steer: 0 } : ph < 10 ? { throttle: 0, brake: 0.9, steer: 0 } : { throttle: 0.4, brake: 0, steer: 0.25 };
    const m = E.modifiers(cs);
    V.step(E.applyToParams(vp0, m, { cache }), s, inp, dt, E.vehicleEnv(m, { gripMult: 1, wet: 0 }));
    E.step(cs, s, inp, dt, {});
  }
  assert.ok(cs.stats.distance_km > 0.2, 'car moved ' + cs.stats.distance_km);
  assert.ok(cs.fuel_l < 60);
  assert.ok(max4(cs.tireTemp_c) > cs.envBase.ambient_c + 3);
  assert.ok(cs.brakeTemp_c > cs.envBase.ambient_c + 20);
  assert.ok(max4(cs.tireWear) > 0);
  cs.tireTemp_c.concat(cs.tireWear, [cs.brakeTemp_c, cs.engineTemp_c, cs.mass_kg]).forEach((x) => assert.ok(Number.isFinite(x)));
});

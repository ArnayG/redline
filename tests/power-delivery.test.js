/* Power delivery (js/physics.js engine models, js/race/vehicle.js torque table, CB.stock factory calibration):
   EV motor envelope (constant torque to base speed, constant power, field-weakening fade), pack power cap, the boosted
   ICE's ECU torque ceiling, the Garage-edit resets in CB.state.normalize, and real 1/4-mile traps of the cars whose
   power falls off at speed (Model S, Chiron). Run: node tests/run.js power-delivery */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach((f) => require(path.join(root, f)));
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van', 'pack-jdm', 'pack-usa', 'pack-exotic', 'pack-sport']
  .forEach((f) => { const p = path.join(root, 'js/shapes/models', f + '.js'); if (fs.existsSync(p)) require(p); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/vehicle.js', 'js/drag/drag-strip.js', 'js/drag/drag-tree.js',
  'js/drag/drag-timing.js', 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js'].forEach((f) => require(path.join(root, f)));
const CB = globalThis.CB, P = CB.physics, V = CB.race.vehicle, ST = CB.state;
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('power-delivery: ' + n, f);
const R = P.constants.evMaxRpm, W = (rpm) => rpm * Math.PI / 30;
const kwAt = (M, rpm) => { const pts = M.curve; let best = pts[0]; pts.forEach((c) => { if (Math.abs(c.rpm - rpm) < Math.abs(best.rpm - rpm)) best = c; }); return best.nm * W(best.rpm) / 1000; };
const clone = (o) => JSON.parse(JSON.stringify(o));
function ev(over) {
  const b = ST.normalize(Object.assign(clone(CB.data.defaultBuild()), {}));
  b.engine = Object.assign(b.engine, { type: 'ev', motors: 2, motorPower_kw: 250, battery_kwh: 100, chemistry: 'nca', voltage: 400 }, over || {});
  b.transmission = Object.assign(b.transmission, { type: 'single-speed', gears: 1, ratios: [2.65], finalDrive: 2.9 });
  return ST.normalize(b);
}
const stock = (id) => CB.stock.build(id).build;

T('EV generic motor: constant torque to base speed, constant power to the fade point, field weakening above it', () => {
  const b = ev(), M = P.compute(b), c = P.evMotorCurve(b.engine);
  assert.deepEqual(c, { base: 0.30, fade: 0.55, top: 0.60 });
  const pk = 500;   // 2 x 250 kW (the NCA pack can burst more)
  assert.ok(Math.abs(M.power_kw - pk) < 2, 'peak ' + M.power_kw);
  const t0 = M.curve[0].nm;
  assert.ok(M.curve.filter((p) => p.rpm <= R * c.base).every((p) => Math.abs(p.nm - t0) < 1), 'flat torque below base');
  [0.32, 0.4, 0.5, 0.55].forEach((f) => assert.ok(Math.abs(kwAt(M, R * f) - pk) < pk * 0.02, 'constant power at ' + f + ': ' + kwAt(M, R * f)));
  const k70 = kwAt(M, R * 0.7), k85 = kwAt(M, R * 0.85), kTop = kwAt(M, R);
  assert.ok(k70 < pk * 0.92 && k85 < k70 && kTop < k85, 'power fades: ' + [k70, k85, kTop].map(Math.round));
  assert.ok(Math.abs(kTop - pk * 0.6) < pk * 0.02, 'top ' + kTop);
});

T('EV per-spec envelope and the optional pack power cap', () => {
  const M = P.compute(ev({ motorBase_pct: 25, motorFade_pct: 40, motorTopPower_pct: 40 }));
  assert.ok(Math.abs(kwAt(M, R) - 200) < 6, 'P(max rpm) = 40 % of 500 kW: ' + kwAt(M, R));
  assert.ok(Math.abs(M.peakTorqueRpm) < 1 && Math.abs(kwAt(M, R * 0.25) - 500) < 10, 'base at 25 %');
  const C = P.compute(ev({ batteryPower_kw: 380 }));
  assert.ok(Math.abs(C.power_kw - 380) < 2, 'pack cap 380 kW: ' + C.power_kw);
  assert.ok((C.warnings || []).some((w) => /Battery discharge limit/.test(w)), 'warns about the cap');
});

T('race vehicle torque table follows the Garage curve (and its no-physics fallback uses the same envelope)', () => {
  const b = ev({ motorFade_pct: 40, motorTopPower_pct: 50 }), M = P.compute(b), p = V.fromBuild(b, M);
  [2000, 6000, 9000, 12000, 15000].forEach((rpm) => {
    const g = M.curve.find((c) => c.rpm === rpm).nm;
    assert.ok(Math.abs(V.torqueAt(p, rpm) - g) < g * 0.01 + 0.5, rpm + ' rpm: ' + V.torqueAt(p, rpm) + ' vs ' + g);
  });
  const q = V.fromBuild(b, null, { noPhysics: true });
  const pkw = (rpm) => V.torqueAt(q, rpm) * W(rpm) / 1000;
  assert.ok(pkw(15500) < pkw(7000) * 0.6, 'fallback curve fades: ' + Math.round(pkw(7000)) + ' -> ' + Math.round(pkw(15500)));
});

T('boosted ICE: the ECU torque ceiling shapes the plateau; a stage tune lifts it', () => {
  const b = stock('bugatti-chiron');
  assert.equal(b.engine.torqueLimit_nm, 1600);
  const M = P.compute(b);
  assert.ok(M.torque_nm <= 1600 + 0.5, 'peak torque ' + M.torque_nm);
  assert.ok(M.peakPowerRpm >= 6200, 'peak power near the top of the rev range: ' + M.peakPowerRpm);
  assert.ok(Math.abs(M.power_hp - 1479) / 1479 < 0.03, 'power still the real 1,479 hp: ' + M.power_hp);
  const free = clone(b); free.engine.torqueLimit_nm = 0;
  assert.ok(P.compute(free).torque_nm > 1700, 'without the ECU ceiling the map makes a fat mid-range');
  const tuned = clone(b); tuned.engine.tune = 'stage1';
  assert.ok(P.compute(tuned).torque_nm > 1700, 'stage 1 remaps the ceiling');
  // NA engines and hybrids are not torque-limited by the stock calibration
  assert.equal(stock('ford-mustang-gt-s650').engine.torqueLimit_nm, 0);
  assert.equal(stock('ferrari-sf90-stradale').engine.torqueLimit_nm, 0);
});

T('hybrid: system curve = ICE + P2 motor, peak lands on the real system power', () => {
  const b = stock('ferrari-sf90-stradale'), M = P.compute(b);
  assert.ok(Math.abs(M.power_hp - 986) / 986 < 0.03, 'SF90 ' + M.power_hp);
  const ice = clone(b); ice.engine.type = 'ice';
  const Mi = P.compute(ST.normalize(ice));
  M.curve.filter((c) => c.rpm >= 2000 && c.rpm <= 7500 && c.rpm % 1000 === 0).forEach((c) => {
    const ci = Mi.curve.find((x) => x.rpm === c.rpm);
    assert.ok(ci && c.nm > ci.nm + 50, c.rpm + ' rpm: motor adds torque ' + c.nm + ' vs ' + (ci && ci.nm));
  });
});

T('normalize keeps the factory calibration, a Garage edit of what it was calibrated for voids it', () => {
  const b = stock('bugatti-chiron');
  assert.equal(ST.normalize(b).engine.torqueLimit_nm, 1600, 'load / replace keeps it');
  const raised = clone(b); raised.engine.boost_bar = 2.0;
  assert.equal(ST.normalize(raised, { paths: ['engine.boost_bar'], prev: b }).engine.torqueLimit_nm, 0, 'boost edit voids the ECU map');
  assert.equal(ST.normalize(clone(b), { paths: ['engine.boost_bar'], prev: b }).engine.torqueLimit_nm, 1600, 'an unchanged value does not');
  const s = stock('tesla-model-s-2021');
  assert.deepEqual([s.engine.motorBase_pct, s.engine.motorFade_pct, s.engine.motorTopPower_pct], [30, 35, 45]);
  const ice = clone(s); ice.engine.type = 'ice';
  const n = ST.normalize(ice, { paths: ['engine.type'], prev: s }).engine;
  assert.deepEqual([n.motorBase_pct, n.motorFade_pct, n.motorTopPower_pct, n.batteryPower_kw], [0, 0, 0, 0], 'type switch resets the motor');
  const bat = clone(s); bat.engine.batteryPower_kw = 400;
  const bat2 = clone(bat); bat2.engine.battery_kwh = 80;
  assert.equal(ST.normalize(bat2, { paths: ['engine.battery_kwh'], prev: bat }).engine.batteryPower_kw, 0, 'new pack: cap reset');
});

T('1/4 mile traps of the cars whose power falls off at speed are within 5 % of the real ones', () => {
  [['tesla-model-s-2021', 11.2, 119], ['bugatti-chiron', 9.4, 156]].forEach(([id, et, mph]) => {
    const r = CB.drag.session.simulate({ seed: 2, surface: 'street', skipBurnout: true, distanceId: 'quarter',
      lanes: [{ kind: 'ai', build: stock(id), difficulty: 'alien' }, { kind: 'none' }] }).lanes[0];
    const trap = r.trap * 2.2369363;
    assert.ok(Math.abs(trap - mph) / mph < 0.05, id + ' trap ' + trap.toFixed(1) + ' vs ' + mph);
    assert.ok(Math.abs(r.et - et) / et < 0.065, id + ' ET ' + r.et.toFixed(2) + ' vs ' + et);
  });
  // the Model S still reaches its governed 250 km/h and its 0–100 is unchanged
  const M = P.compute(stock('tesla-model-s-2021'));
  assert.equal(M.topSpeedLimitedBy, 'governor');
  assert.ok(Math.abs(M.zeroTo100_s - 3.2) <= 0.3, '0-100 ' + M.zeroTo100_s);
});

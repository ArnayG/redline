/* FORGE Atelier — chassis calculation layer (CB.chassisCalc from js/panels-chassis.js). Run: node tests/run.js */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
require('../js/data.js');
require('../js/state.js');
require('../js/ui-kit.js');
const C = require('../js/panels-chassis.js');
const CB = globalThis.CB;
const U = CB.util;

const base = () => CB.state.normalize(CB.data.defaultBuild());
const withB = (patch) => CB.state.normalize(U.deepMerge(CB.data.defaultBuild(), patch));
const M = (b) => C.estimateMetrics(b);

test('chassis: registers the five Chassis panels with render + update', () => {
  ['suspension', 'brakes', 'wheels', 'aero', 'weight'].forEach((id) => {
    const p = CB.panels[id];
    assert.ok(p, 'panel ' + id);
    assert.equal(p.group, 'Chassis');
    assert.equal(typeof p.render, 'function');
    assert.equal(typeof p.update, 'function');
  });
  const order = CB.panelList().filter((p) => p.group === 'Chassis').map((p) => p.id);
  assert.deepEqual(order, ['suspension', 'brakes', 'wheels', 'aero', 'weight']);
});

test('chassis: tyre geometry and size strings', () => {
  const g = C.tireGeom(base(), 'front');
  assert.equal(g.short, '255/35 R19');
  assert.ok(/^255\/35 ZR19 \d+Y XL$/.test(g.size), g.size);
  assert.ok(Math.abs(g.sidewall_mm - 89.25) < 1e-9);
  assert.ok(Math.abs(g.diameter_mm - (19 * 25.4 + 2 * 89.25)) < 1e-9);
  assert.ok(g.revsPerKm > 450 && g.revsPerKm < 520);
  const slick = C.tireGeom(withB({ tires: { compound: 'slick' } }), 'rear');
  assert.ok(/Slick$/.test(slick.size));
});

test('chassis: rim fit flags stretched and ballooned pairings', () => {
  assert.equal(C.rimFit(9, 255).status, 'ok');
  assert.equal(C.rimFit(12, 205).status, 'stretched');
  assert.equal(C.rimFit(6, 325).status, 'ballooned');
  const r = C.rimRange(295);
  assert.ok(r.min < r.ideal && r.ideal < r.max);
});

test('chassis: speedometer error is zero on factory fitment, positive for taller tyres', () => {
  assert.ok(Math.abs(C.speedo(base()).error_pct) < 1e-9);
  const tall = C.speedo(withB({ tires: { profileRear: 45 } }));
  assert.ok(tall.error_pct > 3, String(tall.error_pct));
  assert.ok(tall.actualAt100 > 100);
  const small = C.speedo(withB({ wheels: { diameter_in: 17 } }));
  assert.ok(small.error_pct < 0);
});

test('chassis: lighter wheel materials cut unsprung mass', () => {
  const cast = C.unsprung(base(), 'front').total;
  const carbon = C.unsprung(withB({ wheels: { material: 'carbon' } }), 'front').total;
  const steel = C.unsprung(withB({ wheels: { material: 'steel' } }), 'front').total;
  assert.ok(carbon < cast && cast < steel);
  const ccb = C.unsprung(withB({ brakes: { material: 'carbon-ceramic' } }), 'front').total;
  assert.ok(ccb < cast);
});

test('chassis: suspension frequencies are plausible and rise with spring rate', () => {
  const b = base(), s = C.suspension(b, M(b));
  assert.ok(s.front.freq_hz > 1.0 && s.front.freq_hz < 2.5, String(s.front.freq_hz));
  const stiff = withB({ suspension: { springFront_nmm: 180 } });
  assert.ok(C.suspension(stiff, M(stiff)).front.freq_hz > s.front.freq_hz);
  assert.ok(s.tlltd_pct > 30 && s.tlltd_pct < 70);
  assert.ok(s.rollGradient_degPerG > 0.5 && s.rollGradient_degPerG < 4);
  const comfy = withB({ suspension: { type: 'air', springFront_nmm: 30, springRear_nmm: 34, damping: 3 } });
  assert.ok(C.suspension(comfy, M(comfy)).comfort > s.comfort);
});

test('chassis: anti-roll bars move the handling balance in the right direction', () => {
  const und = withB({ suspension: { arbFront: 10, arbRear: 1 } });
  const ovr = withB({ suspension: { arbFront: 1, arbRear: 10 } });
  const bu = C.balance(und, M(und)), bo = C.balance(ovr, M(ovr));
  assert.ok(bu.score > bo.score);
  assert.ok(bu.score > 0 && bo.score < 0);
  assert.ok(['Pronounced oversteer', 'Mild oversteer', 'Neutral', 'Mild understeer', 'Pronounced understeer'].includes(bu.label));
  assert.ok(bu.score >= -1 && bu.score <= 1);
});

test('chassis: presets round-trip through matchPreset (ride height clamped per type)', () => {
  C.presets.forEach((p) => {
    const b = withB({ suspension: Object.assign({ type: p.id === 'stance' ? 'air' : 'double-wishbone' }, p.values) });
    assert.equal(C.matchPreset(b), p.id, p.id);
  });
  assert.equal(C.matchPreset(base()), null);
});

test('chassis: brake torque, bias and rotor-in-wheel fit', () => {
  const b = base(), bd = C.brakes(b, M(b));
  assert.ok(bd.front.torque_nm > bd.rear.torque_nm);
  assert.ok(bd.bias_front_pct > 55 && bd.bias_front_pct < 85);
  assert.ok(bd.dist_100_0_m > 25 && bd.dist_100_0_m < 60, String(bd.dist_100_0_m));
  assert.ok(bd.front.fits && bd.front.clearance_mm === 19 * 25.4 - 420);
  const tight = withB({ wheels: { diameter_in: 17 }, brakes: { frontRotor_mm: 400 } });
  assert.equal(C.brakes(tight, M(tight)).front.fits, false);
  const big = withB({ brakes: { frontRotor_mm: 400, frontPistons: 10 } });
  assert.ok(C.brakes(big, M(big)).front.torque_nm > bd.front.torque_nm);
  const cc = withB({ brakes: { material: 'carbon-ceramic' } });
  assert.ok(C.brakes(cc, M(cc)).fadeRisk < bd.fadeRisk);
});

test('chassis: aero elements, wing angle and balance', () => {
  const b = withB({ aero: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 10, diffuser: 'race' } });
  const a = C.aero(b, null);
  assert.ok(a.total_kg_200 > 250);
  assert.ok(a.balance_front_pct > 0 && a.balance_front_pct < 100);
  const steep = C.aero(withB({ aero: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 20, diffuser: 'race' } }), null);
  assert.ok(steep.total_kg_200 > a.total_kg_200 && steep.cd > a.cd);
  assert.ok(steep.balance_front_pct < a.balance_front_pct);
  assert.ok(Math.abs(a.dfAt(100) - a.total_kg_200 / 4) < 1e-9);
  const scaled = C.aero(b, { downforce_kg_200: 500 });
  assert.ok(Math.abs(scaled.total_kg_200 - 500) < 1e-6);
  assert.ok(Math.abs(scaled.balance_front_pct - a.balance_front_pct) < 1e-6);
});

test('chassis: weight ledger tracks reductions, additions and cost per kg', () => {
  const b = withB({ body: { seats: 2 }, weight: { soundDeadening: false, rearSeats: false, glass: 'polycarbonate', battery: 'lithium', rollCage: 'half', ballast_kg: 20 } });
  const lg = C.weightLedger(b);
  assert.equal(lg.saved_kg, 22 + 28 + 18 + 12);
  assert.equal(lg.added_kg, 22 + 20);
  assert.ok(lg.costPerKgSaved > 0);
  assert.ok(M(b).weight_kg < M(base()).weight_kg);
  const front = withB({ weight: { ballast_kg: 100, ballastPosition: 'front' } });
  const rear = withB({ weight: { ballast_kg: 100, ballastPosition: 'rear' } });
  assert.ok(M(front).weightFront_pct > M(rear).weightFront_pct);
});

test('chassis: estimate is JSON-safe and complete for every preset', () => {
  (CB.data.presets || []).forEach((p) => {
    const b = CB.data.presetBuild(p.id);
    const m = M(b);
    JSON.stringify(m);
    ['weight_kg', 'weightFront_pct', 'cgHeight_mm', 'cd', 'downforce_kg_200'].forEach((k) => assert.ok(Number.isFinite(m[k]), p.id + ' ' + k));
    const s = C.suspension(b, m);
    assert.ok(Number.isFinite(s.front.freq_hz) && Number.isFinite(s.comfort), p.id);
    assert.ok(Number.isFinite(C.brakes(b, m).dist_100_0_m), p.id);
    assert.ok(Number.isFinite(C.balance(b, m).score), p.id);
  });
});

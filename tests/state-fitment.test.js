/* FORGE Atelier — picking a body style or a real model (CB.state.set('body.style') / applyModel) refits the
   rims to the real tyres (ideal rim fit), sets staggered, and keeps the brakes inside the wheels, so the build
   never starts with rule errors. Run: node tests/run.js state-fitment */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('state-fitment: ' + n, f);

function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(load);
const modelDir = path.join(root, 'js', 'shapes', 'models');
if (fs.existsSync(modelDir)) fs.readdirSync(modelDir).filter((f) => f.endsWith('.js')).sort().forEach((f) => load('js/shapes/models/' + f));
load('js/state.js');
load('js/rules.js');
const CB = globalThis.CB;
const ST = CB.state, SH = CB.shapes, D = CB.data;

function errors(build) {
  const v = CB.rules.validate(build);
  const list = Array.isArray(v) ? v : (v && (v.issues || v.errors)) || [];
  return list.filter((i) => i.severity === 'error');
}
function describe(errs) { return errs.map((e) => e.id + ': ' + String(e.message || '').slice(0, 100)).join(' | '); }
function fresh() { ST.reset(); ST.clearHistory(); return ST.get(); }
/** Registered models of catalog body styles (other test files register '_test' fixtures in the shared registry). */
const realModels = () => SH.list().filter((m) => m && m.ref && D.bodyStyles.some((s) => s.id === m.style));
const ready = () => CB.rules && typeof CB.rules.validate === 'function' && SH && typeof SH.list === 'function';

T('every body style pick leaves zero rule errors (rims follow the tyres, rotors fit the wheels)', () => {
  if (!ready()) return;
  D.bodyStyles.forEach((s) => {
    fresh();
    ST.set('body.style', s.id);
    const b = ST.get();
    assert.equal(b.body.style, s.id);
    const errs = errors(b);
    assert.equal(errs.length, 0, 'style ' + s.id + ': ' + describe(errs));
  });
});

T('every registered real model (applyModel, from every starting style) leaves zero rule errors', () => {
  if (!ready()) return;
  const models = realModels();
  assert.ok(models.length > 0, 'models registered');
  models.forEach((m) => {
    fresh();
    assert.ok(ST.applyModel(m.id) || ST.get().body.model === m.id, m.id + ' applied');
    let errs = errors(ST.get());
    assert.equal(errs.length, 0, 'model ' + m.id + ': ' + describe(errs));
    D.bodyStyles.forEach((s) => {
      fresh();
      ST.set('body.style', s.id);
      ST.applyModel(m.id);
      errs = errors(ST.get());
      assert.equal(errs.length, 0, s.id + ' -> ' + m.id + ': ' + describe(errs));
    });
  });
});

T('model rims: ideal fit for each tyre, staggered only when front != rear, one undo step', () => {
  if (!ready()) return;
  const range = CB.rules.rimRange;
  realModels().forEach((m) => {
    fresh();
    ST.applyModel(m.id);
    const b = ST.get();
    [['Front', 'widthFront'], ['Rear', 'widthRear']].forEach(([axle, k]) => {
      const tire = b.tires[k + '_mm'], rim = b.wheels[k + '_in'], rr = range(tire);
      assert.ok(rim >= rr[0] - 1e-9 && rim <= rr[1] + 1e-9, m.id + ' ' + axle + ' ' + tire + ' mm on ' + rim + '"');
    });
    const differ = b.wheels.widthFront_in !== b.wheels.widthRear_in || b.tires.widthFront_mm !== b.tires.widthRear_mm || b.tires.profileFront !== b.tires.profileRear;
    assert.equal(b.wheels.staggered, differ, m.id + ' staggered');
    assert.ok(b.brakes.frontRotor_mm + 60 <= b.wheels.diameter_in * 25.4, m.id + ' front rotor fits');
    assert.ok(b.brakes.rearRotor_mm + 60 <= b.wheels.diameter_in * 25.4, m.id + ' rear rotor fits');
  });
  // a single undo reverts the model pick and its refit together
  fresh();
  const before = ST.get();
  const m = realModels().filter((x) => x.style === 'van')[0] || realModels()[0];
  ST.applyModel(m.id);
  ST.undo();
  assert.deepEqual(ST.get().wheels, before.wheels);
  assert.deepEqual(ST.get().brakes, before.brakes);
});

T('an explicit rotor in the same patch as a style change is kept (the caller wins)', () => {
  if (!ready()) return;
  fresh();
  ST.patch({ body: { style: 'van' }, brakes: { frontRotor_mm: 400 } });
  assert.equal(ST.get().brakes.frontRotor_mm, 400);
});

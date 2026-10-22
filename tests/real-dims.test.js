/* FORGE Atelier — real manufacturer dimensions in builds (CB.state.realDims / applyModel / matchRealDims /
   dimsDeviation, default build at the default model's dims, body.model / body.style picks fold the real car's
   wheelbase, track, ride height, wheel diameter and tyre sizes into ONE undo step).
   Run: node tests/run.js real-dims   (or standalone: node tests/real-dims.test.js) */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('real-dims: ' + n, f);

function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(load);
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'].forEach((m) => load('js/shapes/models/' + m + '.js'));
load('js/state.js');
const CB = globalThis.CB;
const SH = CB.shapes, ST = CB.state, D = CB.data, U = CB.util;
const DIMS = ['body.wheelbase_mm', 'body.trackWidth_mm', 'suspension.rideHeight_mm', 'wheels.diameter_in',
  'tires.widthFront_mm', 'tires.widthRear_mm', 'tires.profileFront', 'tires.profileRear'];

function pick(b) { const o = {}; DIMS.forEach((p) => { o[p] = U.get(b, p); }); return o; }
/** What the build should hold for a model: its refBuild, snapped to this shell's ranges / slider steps by normalize. */
function expected(m, base) {
  const rb = SH.refBuild(m);
  const raw = U.deepMerge(base || ST.normalize(D.defaultBuild()), { body: { style: m.style, model: m.id }, suspension: rb.suspension, wheels: Object.assign({ staggered: true }, rb.wheels), tires: rb.tires });
  raw.body.wheelbase_mm = rb.body.wheelbase_mm; raw.body.trackWidth_mm = rb.body.trackWidth_mm;
  return pick(ST.normalize(raw, { paths: DIMS.concat(['body.style', 'body.model', 'wheels.staggered']), prev: base }));
}
// the generic default build (ST.reset() starts a NEW build from a factory car — CB.stock — once stock specs + physics
// are loaded by any suite; these tests are about real dims / fitment from the catalog default)
function fresh() { ST.replace(ST.normalize(ST.defaultBuild()), { resetHistory: true, label: 'fresh' }); ST.clearHistory(); return ST.get(); }
function withoutShapes(fn) { const saved = CB.shapes; try { CB.shapes = undefined; return fn(); } finally { CB.shapes = saved; } }

T('exports the real-dimension API', () => {
  ['realDims', 'applyModel', 'matchRealDims', 'dimsDeviation', 'defaultBuild', 'modelOf'].forEach((k) => assert.equal(typeof ST[k], 'function', k));
  assert.deepEqual(ST.REAL_DIM_PATHS, DIMS);
});

T('realDims(model) carries exactly refBuild\'s dimensions for every registered model (no style/model keys)', () => {
  SH.list().forEach((m) => {
    const rb = SH.refBuild(m), d = ST.realDims(m);
    assert.ok(d, m.id);
    assert.equal(d.body.wheelbase_mm, rb.body.wheelbase_mm, m.id);
    assert.equal(d.body.trackWidth_mm, rb.body.trackWidth_mm, m.id);
    assert.equal(d.suspension.rideHeight_mm, rb.suspension.rideHeight_mm, m.id);
    assert.equal(d.wheels.diameter_in, rb.wheels.diameter_in, m.id);
    assert.deepEqual(d.tires, rb.tires, m.id);
    assert.ok(!('style' in d.body) && !('model' in d.body), m.id + ' no style/model');
    const stag = rb.tires.widthFront_mm !== rb.tires.widthRear_mm || rb.tires.profileFront !== rb.tires.profileRear;
    assert.equal(d.wheels.staggered === true, stag, m.id + ' staggered only when the real car is');
    assert.deepEqual(ST.realDims(m.id), d, 'by id');
  });
  assert.equal(ST.realDims('no-such-car'), null);
  // a build resolves to its shown model (style default when body.model is unset)
  const def = SH.defaultModel('suv');
  assert.deepEqual(ST.realDims({ body: { style: 'suv', model: null } }), ST.realDims(def));
});

T('default build starts at the default model\'s real dimensions', () => {
  const b = fresh();
  const m = SH.defaultModel(b.body.style);
  assert.equal(ST.modelOf(b).id, m.id);
  assert.deepEqual(pick(b), expected(m, b));
  assert.equal(b.body.wheelbase_mm, SH.refBuild(m).body.wheelbase_mm, 'wheelbase exact');
  assert.deepEqual(pick(ST.normalize(ST.defaultBuild())), pick(b));
  assert.equal(ST.dimsDeviation(b).large, false);
  // non-dimension defaults are untouched
  const cat = D.defaultBuild();
  assert.equal(b.engine.layout, cat.engine.layout);
  assert.equal(b.exterior.paint, cat.exterior.paint);
  assert.equal(b.body.model, null, 'model stays "style default"');
});

T('picking a model (set body.model) applies its real dims as ONE undo step; undo restores the old dims', () => {
  const b0 = fresh();
  const m = SH.modelsByStyle('coupe').find((x) => x.id !== SH.defaultModel('coupe').id);
  ST.set('body.model', m.id);
  const b1 = ST.get();
  assert.equal(b1.body.model, m.id);
  assert.deepEqual(pick(b1), expected(m, b0));
  assert.equal(ST.history().length, 1, 'one step');
  ST.undo();
  assert.deepEqual(pick(ST.get()), pick(b0));
  assert.equal(ST.get().body.model, b0.body.model);
  ST.redo();
  assert.deepEqual(pick(ST.get()), pick(b1));
});

T('picking a body style applies that style\'s default model dims in the same step', () => {
  const b0 = fresh();
  ['suv', 'roadster', 'van', 'pickup', 'coupe'].forEach((style) => {
    const before = ST.get(), n = ST.history().length;
    ST.set('body.style', style, { noCoalesce: true });
    const m = SH.defaultModel(style);
    assert.equal(ST.get().body.model, null, style + ' resolves to the style default');
    assert.deepEqual(pick(ST.get()), expected(m, before), style);
    assert.equal(ST.history().length, n + 1, style + ' one step');
  });
  ST.undo();
  assert.equal(ST.get().body.style, 'pickup');
  assert.deepEqual(pick(ST.get()), expected(SH.defaultModel('pickup'), b0));
});

T('explicit dims in the same change win; opts.realDims:false opts out; unrelated edits never re-apply', () => {
  fresh();
  ST.patch({ body: { style: 'suv', wheelbase_mm: 3100 } });
  assert.equal(ST.get().body.wheelbase_mm, 3100, 'caller wheelbase kept');
  assert.equal(ST.get().suspension.rideHeight_mm, expected(SH.defaultModel('suv'), ST.get())['suspension.rideHeight_mm'], 'other dims folded');
  fresh();
  const before = pick(ST.get());
  ST.set('body.style', 'sedan', { realDims: false });
  assert.equal(ST.get().body.wheelbase_mm, D.find('bodyStyles', 'sedan').defaultWheelbase, 'legacy behaviour when opted out');
  assert.equal(ST.get().tires.widthFront_mm, before['tires.widthFront_mm']);
  fresh();
  ST.set('tires.widthFront_mm', 285);
  ST.set('body.wheelbase_mm', 2700);
  ST.set('exterior.paint', '#123456');
  assert.equal(ST.get().tires.widthFront_mm, 285);
  assert.equal(ST.get().body.wheelbase_mm, 2700);
  // re-selecting the model already shown is not a model change
  ST.set('body.model', SH.defaultModel('coupe').id);
  assert.equal(ST.get().body.wheelbase_mm, 2700);
});

T('matchRealDims snaps a tweaked build back in one step; no-op when already matching', () => {
  const b0 = fresh();
  ST.patch({ body: { wheelbase_mm: 2790, trackWidth_mm: 1700 }, suspension: { rideHeight_mm: 60 }, tires: { widthFront_mm: 325 } });
  const dev = ST.dimsDeviation();
  assert.equal(dev.large, true);
  assert.ok(dev.items.find((i) => i.path === 'body.wheelbase_mm').big);
  const n = ST.history().length;
  assert.equal(ST.matchRealDims(), true);
  assert.equal(ST.history().length, n + 1);
  assert.match(ST.history()[ST.history().length - 1], /^Match .*dimensions$/);
  assert.deepEqual(pick(ST.get()), pick(b0));
  assert.equal(ST.dimsDeviation().large, false);
  assert.equal(ST.matchRealDims(), false, 'nothing to change');
});

T('applyModel switches style + model + dims as one labelled step', () => {
  const b0 = fresh();
  const m = SH.models['mazda-mx5-nd'] || SH.modelsByStyle('roadster')[0];
  assert.equal(ST.applyModel(m.id), true);
  const b = ST.get();
  assert.equal(b.body.style, m.style);
  assert.equal(b.body.model, m.id);
  assert.deepEqual(pick(b), expected(m, b0));
  assert.equal(ST.history().length, 1);
  assert.match(ST.history()[0], new RegExp(m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(ST.applyModel('nope'), false);
  const testOnly = SH.list().find((x) => !D.find('bodyStyles', x.style));
  if (testOnly) assert.equal(ST.applyModel(testOnly.id), false, 'models of unknown body styles are rejected');
});

T('dimsDeviation: shell limits never nag (reachable values count as matched)', () => {
  SH.list().filter((m) => D.find('bodyStyles', m.style)).forEach((m) => {
    fresh();
    assert.equal(ST.applyModel(m.id), true, m.id);
    const dev = ST.dimsDeviation();
    assert.equal(dev.model.id, m.id);
    assert.equal(dev.large, false, m.id + ' just matched');
    dev.items.forEach((i) => assert.equal(i.build, i.reachable, m.id + ' ' + i.path));
  });
  // e.g. the F-150 Raptor's 1875 mm track exceeds the 1750 mm slider: flagged as at-limit, not as a deviation
  const raptor = SH.models['ford-f150-raptor-gen3'];
  if (raptor) {
    fresh(); ST.applyModel(raptor.id);
    assert.ok(ST.dimsDeviation().atLimit.indexOf('body.trackWidth_mm') >= 0);
  }
  // small tweaks stay under the tolerance
  fresh();
  ST.set('body.wheelbase_mm', ST.get().body.wheelbase_mm + 20);
  assert.equal(ST.dimsDeviation().large, false);
});

T('without CB.shapes: no folding, legacy defaults, null realDims', () => {
  withoutShapes(() => {
    assert.equal(ST.realDims({ body: { style: 'coupe' } }), null);
    assert.deepEqual(pick(ST.defaultBuild()), pick(D.defaultBuild()));
    ST.reset(); ST.clearHistory();
    ST.set('body.style', 'suv');
    assert.equal(ST.get().body.wheelbase_mm, D.find('bodyStyles', 'suv').defaultWheelbase);
    assert.equal(ST.matchRealDims(), false);
    assert.equal(ST.dimsDeviation().large, false);
  });
});

T('Body panel: model cards use applyModel, the button uses matchRealDims, and the deviation note is wired', () => {
  const src = fs.readFileSync(path.join(root, 'js/panels-powertrain.js'), 'utf8');
  assert.ok(/CB\.state\.applyModel\(m\.id\)/.test(src), 'model card click applies the model + dims');
  assert.ok(/CB\.state\.matchRealDims\(\)/.test(src), 'Match real dimensions button');
  assert.ok(/Match real dimensions/.test(src));
  assert.ok(/function realDimsNote\(b\)/.test(src) && /dimsDeviation\(b\)/.test(src), 'deviation note');
  assert.ok(/realDimsNote: realDimsNote/.test(src), 'note helper exposed');
  // leave the shared store at a clean default for later test files
  fresh();
});

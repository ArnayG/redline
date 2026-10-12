/* FORGE Atelier — pure-generator tests for js/render.js (CB.render markup / thumbnail / resolve). */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
const D = require('../js/data.js');
const S = require('../js/state.js');
require('../js/rules.js');
const P = require('../js/physics.js');
const R = require('../js/render.js');

const VIEWS = ['side', 'front', 'rear', 'top'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const base = S.normalize(D.presetBuild(D.presets[0].id));
const metrics = (b) => { try { return P.compute(b); } catch (e) { return null; } };
function wellFormed(svg, label) {
  assert.equal(typeof svg, 'string', label + ': string');
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), label + ': svg wrapper');
  const bad = svg.match(/.{0,40}(NaN|undefined|Infinity|\[object)/);
  assert.ok(!bad, label + ': no NaN/undefined: ' + (bad && bad[0]));
  const open = (svg.match(/<(g|defs|clipPath|linearGradient|radialGradient|filter|pattern|mask)\b/g) || []).length;
  const close = (svg.match(/<\/(g|defs|clipPath|linearGradient|radialGradient|filter|pattern|mask)>/g) || []).length;
  assert.equal(open, close, label + ': balanced container tags');
}

test('render: exports the SPEC API', () => {
  ['mount', 'update', 'setView', 'toggleXray', 'snapshotSVG', 'thumbnail', 'markup', 'resolve', 'toggleSpin'].forEach((k) => assert.equal(typeof R[k], 'function', k));
  assert.equal(globalThis.CB.render, R);
  assert.deepEqual(R.VIEWS, VIEWS);
});

test('render: every body style x view x xray generates clean markup', () => {
  for (const bs of D.bodyStyles) {
    const b = clone(base); b.body.style = bs.id; b.body.wheelbase_mm = bs.defaultWheelbase;
    const m = metrics(b);
    for (const v of VIEWS) for (const x of [false, true]) wellFormed(R.markup(b, m, { view: v, xray: x }), bs.id + '/' + v + (x ? '/xray' : ''));
  }
});

test('render: body styles have distinct side silhouettes', () => {
  const seen = new Set();
  for (const bs of D.bodyStyles) {
    const b = clone(base); b.body.style = bs.id;
    const svg = R.markup(b, null, { view: 'side', prefix: 'z' });
    const body = svg.match(/<clipPath id="zbody"><path d="([^"]+)"/);
    assert.ok(body, bs.id + ' has a body clip path');
    seen.add(body[1]);
  }
  assert.equal(seen.size, D.bodyStyles.length);
});

test('render: every wheel design and option list renders', () => {
  for (const w of D.wheelDesigns) { const b = clone(base); b.wheels.design = w.id; wellFormed(R.markup(b, null, { view: 'side' }), 'wheel ' + w.id); }
  const lists = { 'exterior.finish': D.paintFinishes, 'exterior.roof': D.roofTypes, 'exterior.stripe': D.stripes, 'exterior.lights': D.lightTypes,
    'exterior.mirrors': D.mirrorTypes, 'exterior.badge': D.badgeTypes, 'engine.exhaust': D.exhausts, 'aero.wing': D.aero.wings,
    'aero.splitter': D.aero.splitters, 'aero.diffuser': D.aero.diffusers, 'drivetrain.layout': D.drivetrainLayouts, 'engine.position': D.enginePositions };
  for (const k in lists) for (const it of lists[k]) {
    const b = clone(base); const [a, c] = k.split('.'); b[a][c] = it.id; b.exterior.livery_number = '42'; b.aero.canards = true;
    for (const v of ['side', 'top']) wellFormed(R.markup(b, null, { view: v, xray: a === 'drivetrain' || a === 'engine' }), k + '=' + it.id + '/' + v);
  }
  for (const t of ['ice', 'hybrid', 'ev']) { const b = clone(base); b.engine.type = t; wellFormed(R.markup(b, metrics(b), { view: 'side', xray: true }), 'xray ' + t); }
});

test('render: geometry responds to wheelbase, ride height and wing angle', () => {
  const a = clone(base), b = clone(base);
  b.body.wheelbase_mm = a.body.wheelbase_mm + 200; b.suspension.rideHeight_mm = a.suspension.rideHeight_mm + 60;
  const ra = R.resolve(a, null), rb = R.resolve(b, null);
  assert.notDeepEqual(ra.n, rb.n);
  assert.notEqual(R.markup(a, null, { prefix: 'p' }), R.markup(b, null, { prefix: 'p' }));
  const w1 = clone(base), w2 = clone(base); w1.aero.wing = w2.aero.wing = 'gt-wing'; w1.aero.wingAngle_deg = 2; w2.aero.wingAngle_deg = 14;
  assert.notEqual(R.markup(w1, null, { prefix: 'p' }), R.markup(w2, null, { prefix: 'p' }));
});

test('render: tolerates garbage and extreme builds', () => {
  for (const b of [null, {}, { body: { style: 'nope' } }, { wheels: { diameter_in: 'x' } }]) for (const v of VIEWS) wellFormed(R.markup(b, null, { view: v }), 'garbage/' + v);
  for (const bs of D.bodyStyles) {
    const b = clone(base); b.body.style = bs.id; b.body.wheelbase_mm = bs.wheelbaseRange[1]; b.suspension.rideHeight_mm = 300; b.wheels.diameter_in = 24; b.tires.profileFront = 25;
    wellFormed(R.markup(b, null, { view: 'side' }), 'extreme ' + bs.id);
  }
});

test('render: thumbnails and markups use unique id prefixes', () => {
  const t1 = R.thumbnail(base), t2 = R.thumbnail(base);
  wellFormed(t1, 'thumb'); wellFormed(t2, 'thumb2');
  const id = (s) => (s.match(/ id="([^"]+)"/) || [])[1];
  assert.notEqual(id(t1), id(t2));
  assert.notEqual(id(R.markup(base, null)), id(R.markup(base, null)));
  for (const v of VIEWS) wellFormed(R.thumbnail(base, { view: v }), 'thumb ' + v);
});

test('render: snapshotSVG works without a mounted DOM', () => {
  const s = R.snapshotSVG();
  wellFormed(s, 'snapshot');
});

test('render: x-ray dimension labels quote the build (physics / Body panel), not the model shell', () => {
  for (const bs of D.bodyStyles) {
    const b = clone(base); b.body.style = bs.id; b.body.wheelbase_mm = bs.defaultWheelbase + 50; b.body.trackWidth_mm = 1650;
    const sv = bs.svg || {};
    const len = Math.round(sv.length_mm + 50), w = Math.round(sv.width_mm + 50);
    const side = R.markup(b, null, { view: 'side', xray: true });
    assert.ok(side.includes('>' + len + ' mm<'), bs.id + ': side x-ray length ' + len);
    for (const v of ['front', 'rear']) assert.ok(R.markup(b, null, { view: v, xray: true }).includes('>W ' + w + ' mm<'), bs.id + '/' + v + ': x-ray width ' + w);
  }
});

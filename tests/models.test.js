/* FORGE Atelier — real-car models in builds: state.normalize keeps body.model valid, presets carry fitting real
   models, AI grids get deterministic, varied real models (and fall back to unset without CB.shapes), and the
   Body panel picker helpers draw a silhouette per model.
   Run: node tests/run.js models   (or standalone: node tests/models.test.js) */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('models: ' + n, f);

function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(load);
const STYLES = ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'];
STYLES.forEach((m) => load('js/shapes/models/' + m + '.js'));
['js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/ai.js'].forEach(load);
const CB = globalThis.CB;
const SH = CB.shapes, ST = CB.state, D = CB.data;

function withBody(b, patch) { return Object.assign({}, b, { body: Object.assign({}, b.body, patch) }); }
function withoutShapes(fn) {
  const saved = CB.shapes;
  try { CB.shapes = undefined; return fn(); } finally { CB.shapes = saved; }
}

T('catalog: every body style names a registered default model of its own style', () => {
  D.bodyStyles.forEach((s) => {
    assert.equal(typeof s.defaultModel, 'string', s.id);
    const m = SH.models[s.defaultModel];
    assert.ok(m, s.id + ' default ' + s.defaultModel + ' is registered');
    assert.equal(m.style, s.id);
    assert.equal(SH.defaultModel(s.id).id, s.defaultModel, s.id + ' matches CB.shapes.defaultModel');
  });
  assert.ok('model' in D.defaultBuild().body, 'defaultBuild carries body.model');
});

T('normalize: keeps valid ids, replaces unknown/mismatched/malformed ones with the style default', () => {
  const base = ST.normalize(D.defaultBuild());
  STYLES.forEach((style) => {
    SH.modelsByStyle(style).forEach((m) => {
      const b = ST.normalize(withBody(base, { style: style, model: m.id }));
      assert.equal(b.body.style, style);
      assert.equal(b.body.model, m.id, m.id + ' kept');
      assert.equal(SH.getModel(b, { strict: true }).id, m.id);
    });
  });
  const coupe = withBody(base, { style: 'coupe' });
  ['ford-f150-raptor-gen3', 'no-such-car', '<script>', 42, ''].forEach((bad) => {
    const b = ST.normalize(withBody(coupe, { model: bad }));
    assert.equal(b.body.model, null, JSON.stringify(bad) + ' dropped');
    assert.equal(SH.getModel(b, { strict: true }).id, 'porsche-911-992', 'renders the style default');
  });
  // idempotent
  const once = ST.normalize(withBody(coupe, { model: 'bmw-m4-g82' }));
  assert.deepEqual(ST.normalize(once).body, once.body);
});

T('normalize: changing body style resets the model unless a model is picked in the same change', () => {
  const prev = ST.normalize(withBody(D.defaultBuild(), { style: 'coupe', model: 'toyota-gr-supra-a90' }));
  const restyled = ST.normalize(withBody(prev, { style: 'suv' }), { paths: ['body.style'], prev: prev });
  assert.equal(restyled.body.model, null);
  assert.equal(SH.getModel(restyled, { strict: true }).id, SH.defaultModel('suv').id);
  const both = ST.normalize(withBody(prev, { style: 'suv', model: 'lamborghini-urus' }), { paths: ['body.style', 'body.model'], prev: prev });
  assert.equal(both.body.model, 'lamborghini-urus');
});

T('normalize without CB.shapes: well-formed ids survive, another style\'s known default is dropped', () => {
  withoutShapes(() => {
    const b = D.defaultBuild();
    assert.equal(ST.normalize(withBody(b, { style: 'coupe', model: 'bmw-m4-g82' })).body.model, 'bmw-m4-g82');
    assert.equal(ST.normalize(withBody(b, { style: 'coupe', model: 'ford-f150-raptor-gen3' })).body.model, null);
    assert.equal(ST.normalize(withBody(b, { style: 'coupe', model: 'bad id!' })).body.model, null);
  });
});

T('presets: every preset normalizes to a real model of its own style, and the line-up is varied', () => {
  const seen = {};
  D.presets.forEach((p) => {
    assert.ok(p.build.body.model, p.id + ' names a model');
    const b = ST.normalize(D.presetBuild(p.id));
    const m = SH.models[b.body.model];
    assert.ok(m, p.id + ' model ' + b.body.model + ' registered');
    assert.equal(m.style, b.body.style, p.id);
    seen[m.id] = 1;
  });
  assert.ok(Object.keys(seen).length >= Math.min(D.presets.length, 12), 'presets use distinct models');
  const want = { 'track-weapon': 'porsche-718-boxster-982', 'hot-hatch': 'vw-golf-gti-mk8', overland: 'range-rover-sport-l461',
    'electric-hyper': 'ferrari-sf90-stradale', 'le-mans-hybrid': 'mclaren-p1', 'lusso-brake': 'ferrari-gtc4lusso' };
  Object.keys(want).forEach((id) => { if (D.preset(id)) assert.equal(D.preset(id).build.body.model, want[id], id); });
});

T('presets + default build: mechanicals match the real model (engine position, plausible engine / body)', () => {
  const builds = [['default', ST.normalize(D.defaultBuild())]].concat(D.presets.map((p) => [p.id, ST.normalize(D.presetBuild(p.id))]));
  builds.forEach(([id, b]) => {
    const m = SH.getModel(b, { strict: true });
    assert.ok(m, id + ' has a model');
    assert.equal(b.engine.position, m.enginePosition, id + ' engine position vs ' + m.id);
    if (m.powertrain === 'ev') assert.equal(b.engine.type, 'ev', id + ' EV model');
  });
  const def = builds[0][1];
  assert.equal(SH.getModel(def, { strict: true }).id, 'porsche-911-992', 'default build shows the coupe default, the 911');
  assert.equal(def.engine.layout, 'flat-6'); assert.equal(def.drivetrain.layout, 'rwd'); assert.equal(def.transmission.type, 'dct');
  assert.equal(def.transmission.gears, 8);
  if (CB.physics && CB.physics.compute) {
    const hp = CB.physics.compute(def).power_hp;
    assert.ok(hp >= 380 && hp <= 470, 'default 911 Carrera S power ' + hp);
  }
  const want = { muscle: 'chevrolet-camaro-zl1-2019', 'alpine-gt': 'aston-martin-vantage-2018', 'eco-commuter': 'volvo-v60-polestar-engineered', 'track-weapon': 'porsche-718-boxster-982' };
  Object.keys(want).forEach((id) => assert.equal(D.preset(id).build.body.model, want[id], id));
  assert.equal(D.preset('rally-legend').build.engine.layout, 'I3', 'GR Yaris is a turbo triple');
  assert.equal(D.preset('le-mans-hybrid').build.drivetrain.layout, 'rwd', 'the P1 is rear-wheel drive');
  if (CB.rules && typeof CB.rules.validate === 'function') {
    builds.forEach(([id, b]) => {
      const issues = CB.rules.validate(b) || [];
      const errs = (Array.isArray(issues) ? issues : issues.issues || []).filter((i) => i && i.severity === 'error');
      assert.equal(errs.length, 0, id + ' ' + JSON.stringify(errs.map((e) => e.id)));
    });
  }
});

T('presets: the V12 shooting brake preset validates (no rule errors) when CB.rules is loaded', () => {
  const p = D.preset('lusso-brake');
  assert.ok(p, 'lusso-brake preset exists');
  const b = ST.normalize(D.presetBuild('lusso-brake'));
  assert.equal(b.engine.layout, 'V12');
  assert.equal(b.body.style, 'shooting-brake');
  if (CB.rules && typeof CB.rules.validate === 'function') {
    const issues = CB.rules.validate(b) || [];
    const errs = (Array.isArray(issues) ? issues : issues.issues || []).filter((i) => i && i.severity === 'error');
    assert.equal(errs.length, 0, JSON.stringify(errs));
  }
});

T('AI grid: opponents get deterministic, varied real models of their own style', () => {
  if (!CB.race || !CB.race.ai) return;
  const player = ST.normalize(withBody(D.defaultBuild(), { style: 'coupe', model: null }));
  const g1 = CB.race.ai.createGrid(player, { count: 7, seed: 1234, field: 'similar' });
  const g2 = CB.race.ai.createGrid(player, { count: 7, seed: 1234, field: 'similar' });
  assert.deepEqual(g1.map((o) => o.build.body.model), g2.map((o) => o.build.body.model), 'deterministic per seed');
  const ids = {};
  g1.forEach((o) => {
    const m = SH.models[o.build.body.model];
    assert.ok(m, o.name + ' has a registered model');
    assert.equal(m.style, o.build.body.style);
    assert.equal(o.model, m.id);
    assert.ok(/\S+ \S+/.test(o.carName), 'carName: ' + o.carName);
    ids[m.id] = 1;
  });
  // (with the model packs loaded there are more coupe models than grid slots: every slot then gets a distinct model)
  assert.equal(Object.keys(ids).length, Math.min(g1.length, SH.modelsByStyle('coupe').length), 'the field spreads over every coupe model');
  // The player's (default) model is the least-favoured for the first picks
  assert.notEqual(g1[0].build.body.model, 'porsche-911-992');

  const mixed = CB.race.ai.createGrid(player, { count: 9, seed: 99, field: 'mixed' });
  const mixedIds = {};
  mixed.forEach((o) => { const m = SH.models[o.build.body.model]; assert.ok(m && m.style === o.build.body.style, o.origin); mixedIds[m.id] = 1; });
  assert.ok(Object.keys(mixedIds).length >= 5, 'mixed field uses several makes: ' + Object.keys(mixedIds));
  // another seed shuffles the order
  const orders = {};
  [1, 2, 3, 4, 5, 6].forEach((s) => { orders[CB.race.ai.createGrid(player, { count: 3, seed: s }).map((o) => o.model).join()] = 1; });
  assert.ok(Object.keys(orders).length >= 2, 'seeded variety');
});

T('AI grid without CB.shapes: body.model is left unset and the grid still builds', () => {
  if (!CB.race || !CB.race.ai) return;
  withoutShapes(() => {
    const g = CB.race.ai.createGrid(ST.normalize(D.defaultBuild()), { count: 5, seed: 7, field: 'mixed' });
    assert.equal(g.length, 5);
    g.forEach((o) => { assert.equal(o.build.body.model, null); assert.equal(o.model, null); });
  });
});

/* REDLINE Garage — Auto-config (CB.stock, js/shapes/stock-specs.js): every real model has a factory spec, applying
   it yields a rule-error-free build whose drivetrain / engine position / powertrain match the real car, power lands
   near the real figure, and it is one undoable step. Run: node tests/run.js stock-specs */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });
const T = (n, f) => test('stock-specs: ' + n, f);

function load(rel) { const p = path.join(root, rel); if (fs.existsSync(p)) require(p); }
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(load);
fs.readdirSync(path.join(root, 'js', 'shapes', 'models')).filter((f) => f.endsWith('.js')).sort().forEach((f) => load('js/shapes/models/' + f));
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js'].forEach(load);
const CB = globalThis.CB;
const ST = CB.state, SH = CB.shapes, D = CB.data, K = CB.stock;
const realModels = () => SH.list().filter((m) => m && m.ref && D.bodyStyles.some((s) => s.id === m.style));
const errors = (b) => { const v = CB.rules.validate(b); return (Array.isArray(v) ? v : v.issues || []).filter((i) => i.severity === 'error'); };
const built = {};
const stockOf = (id) => (built[id] = built[id] || K.build(id));

T('every registered real model has a stock spec (and no orphan specs)', () => {
  const ids = realModels().map((m) => m.id);
  assert.ok(ids.length >= 53, 'expected all 53 models, got ' + ids.length);
  ids.forEach((id) => assert.ok(K.spec(id), 'missing stock spec for ' + id));
  Object.keys(K.SPECS).forEach((id) => assert.ok(SH.models[id], 'spec for unknown model ' + id));
});

T('each stock build has zero rule errors and is road legal', () => {
  realModels().forEach((m) => {
    const r = stockOf(m.id);
    assert.ok(r && r.build, m.id);
    const errs = errors(r.build);
    assert.equal(errs.length, 0, m.id + ': ' + errs.map((e) => e.id).join(', '));
    assert.equal(CB.rules.legality(r.build).streetLegal, true, m.id + ' street legal');
    assert.equal(r.build.body.model, m.id);
    assert.equal(r.build.body.style, m.style);
    assert.equal(r.build.engine.tune, 'stock', m.id + ' factory map');
  });
});

T('key fields match the real car: drivetrain, engine position, ICE / hybrid / EV', () => {
  realModels().forEach((m) => {
    const b = stockOf(m.id).build;
    const dl = m.drivetrain === '4wd' ? 'awd' : m.drivetrain;
    if (dl) assert.equal(b.drivetrain.layout, dl, m.id + ' drivetrain');
    if (m.enginePosition) assert.equal(b.engine.position, m.enginePosition, m.id + ' engine position');
    const sp = K.spec(m.id);
    const type = sp.ev ? 'ev' : sp.hy ? 'hybrid' : 'ice';
    assert.equal(b.engine.type, type, m.id + ' powertrain');
    if (m.powertrain === 'ev') assert.equal(b.engine.type, 'ev', m.id + ' is electric');
    if (m.powertrain !== 'ev') assert.notEqual(b.engine.type, 'ev', m.id + ' is not electric');
    if (type !== 'ev') {
      const e = sp.e.split(' ');
      assert.equal(b.engine.layout, e[0], m.id + ' layout');
      assert.equal(b.engine.displacement_l, Number(e[1]), m.id + ' displacement');
      assert.equal(b.engine.aspiration, e[2], m.id + ' aspiration');
    }
    assert.equal(b.transmission.type, sp.g.split(' ')[0], m.id + ' gearbox');
  });
});

T('computed power within 15 % of the real figure, weight and 0-100 plausible', () => {
  realModels().forEach((m) => {
    const r = stockOf(m.id), x = r.metrics, t = r.target;
    assert.ok(x, m.id + ' metrics');
    assert.ok(Math.abs(x.hp - t.hp) / t.hp <= 0.15, m.id + ' power ' + Math.round(x.hp) + ' vs ' + t.hp);
    assert.ok(Math.abs(x.kg - t.kg) / t.kg <= 0.4, m.id + ' weight ' + x.kg + ' vs ' + t.kg);
    assert.ok(x.zeroTo100_s > t.zeroTo100_s * 0.6 && x.zeroTo100_s < t.zeroTo100_s * 1.5, m.id + ' 0-100 ' + x.zeroTo100_s + ' vs ' + t.zeroTo100_s);
  });
});

T('apply() is one undo step labelled "Stock spec: …"; undo restores the previous build', () => {
  ST.reset(); ST.clearHistory();
  ST.applyModel('ford-f150-raptor-gen3');
  const before = ST.get();
  const n = ST.history().length;
  const res = K.apply();
  assert.ok(res && res.changed, 'applied');
  assert.equal(ST.history().length, n + 1, 'exactly one history step');
  assert.equal(ST.history()[n], 'Stock spec: Ford F-150 Raptor');
  const b = ST.get();
  assert.equal(b.engine.layout, 'V6'); assert.equal(b.transmission.gears, 10); assert.equal(b.drivetrain.layout, 'awd');
  assert.equal(b.meta.id, before.meta.id, 'build identity kept');
  assert.ok(K.isStock(b), 'isStock after apply');
  ST.undo();
  assert.deepEqual(ST.get(), before, 'undo restores');
  assert.equal(K.isStock(ST.get()), false);
});

T('apply() follows the model the build shows; EVs get motors and a battery', () => {
  ST.reset(); ST.clearHistory();
  ST.applyModel('tesla-model-s-2021');
  K.apply();
  const b = ST.get();
  assert.equal(b.engine.type, 'ev'); assert.equal(b.engine.motors, 2); assert.equal(b.drivetrain.layout, 'awd');
  assert.equal(b.transmission.type, 'single-speed');
  ST.applyModel('porsche-911-992');
  const r = K.apply();
  assert.equal(r.title, 'Porsche 911 Carrera S');
  assert.equal(ST.get().engine.layout, 'flat-6'); assert.equal(ST.get().engine.position, 'rear');
  assert.equal(ST.get().aero.wing, 'ducktail');
  assert.equal(K.apply({ model: 'no-such-car' }), null);
});

/* ---- physics realism knobs the stock specs rely on (body.construction, engine.speedLimiter_kph, tires.speedRating) */
T('CB.data.modelRefs mirrors every CB.shapes model ref (style, dims, Cd, kerb)', () => {
  realModels().forEach((m) => {
    const t = D.modelRefs[m.id];
    assert.ok(Array.isArray(t), 'modelRefs entry for ' + m.id);
    assert.equal(t[0], m.style, m.id + ' style');
    [['length', 1], ['width', 2], ['height', 3]].forEach(([k, i]) => assert.ok(Math.abs(t[i] - m.ref[k]) < 0.002, m.id + ' ' + k));
    assert.equal(t[4], m.ref.cd, m.id + ' cd');
  });
});

T('old saved builds (no construction / limiter / speed rating) load with neutral defaults and unchanged physics', () => {
  const b = D.defaultBuild();
  delete b.body.construction; delete b.body.modelPhysics; delete b.engine.speedLimiter_kph; delete b.tires.speedRating;
  b.body.model = 'mazda-mx5-nd'; b.body.style = 'roadster';
  const n = ST.normalize(b);
  assert.equal(n.body.construction, 'standard'); assert.equal(n.body.modelPhysics, false);
  assert.equal(n.engine.speedLimiter_kph, 0);
  assert.equal(n.tires.speedRating, 'compound');
  const ref = D.defaultBuild(); ref.body.model = 'mazda-mx5-nd'; ref.body.style = 'roadster'; ref.body.modelPhysics = false;
  const a = CB.physics.compute(b), c = CB.physics.compute(ref);
  assert.equal(a.weight_kg, c.weight_kg); assert.equal(a.topSpeed_kph, c.topSpeed_kph); assert.equal(a.zeroTo100_s, c.zeroTo100_s);
});

T('electronic speed limiter caps the top speed (configurator and race model)', () => {
  const b = stockOf('bmw-m4-g82').build;
  const x = CB.physics.compute(b);
  assert.equal(b.engine.speedLimiter_kph, 250);
  assert.equal(x.topSpeed_kph, 250); assert.equal(x.topSpeedLimitedBy, 'governor'); assert.equal(x.topSpeedGovernor, 'limiter');
  const off = JSON.parse(JSON.stringify(b)); off.engine.speedLimiter_kph = 0;
  assert.ok(CB.physics.compute(off).topSpeed_kph > 260, 'derestricted M4 goes faster');
  if (CB.race && CB.race.vehicle) {
    const p = CB.race.vehicle.fromBuild(b, x);
    assert.ok(Math.abs(p.governor * 3.6 - 250) < 0.5, 'race governor ' + p.governor * 3.6);
  }
});

T('tyre speed ratings: hypercar tyres let the Chiron reach its 420 km/h limiter; H tyres cap a car at 210', () => {
  const ch = stockOf('bugatti-chiron');
  assert.equal(ch.build.tires.speedRating, 'hyper');
  assert.ok(ch.metrics.topSpeed_kph >= 415, 'Chiron ' + ch.metrics.topSpeed_kph);
  const h = JSON.parse(JSON.stringify(stockOf('porsche-911-992').build)); h.tires.speedRating = 'H';
  const xh = CB.physics.compute(h);
  assert.equal(xh.topSpeed_kph, 210); assert.equal(xh.topSpeedGovernor, 'tyres');
  const bad = JSON.parse(JSON.stringify(h)); bad.tires.speedRating = 'hyper'; bad.tires.compound = 'touring';
  const v = CB.rules.validate(bad); assert.ok((Array.isArray(v) ? v : v.issues).some((i) => i.id === 'tires.hyper-rating'));
});

T('body construction scales the glider: lightweight < standard < reinforced < armoured; size grows big shells', () => {
  const base = JSON.parse(JSON.stringify(stockOf('porsche-911-992').build)); base.weight.ballast_kg = 0;
  const w = (id) => { const c = JSON.parse(JSON.stringify(base)); c.body.construction = id; return CB.physics.compute(c).weight_kg; };
  const ws = ['classic', 'lightweight', 'standard', 'reinforced', 'armoured'].map(w);
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i] > ws[i - 1] + 40, 'construction mass order ' + ws.join(' < '));
  const gen = JSON.parse(JSON.stringify(stockOf('mercedes-sprinter-vs30').build)); const big = CB.physics.compute(gen);
  assert.equal(gen.body.modelPhysics, true, 'stock specs use the real-car mass & aero');
  gen.body.modelPhysics = false; const plain = CB.physics.compute(gen);
  assert.ok(plain.weight_kg < big.weight_kg - 100, 'high-roof Sprinter shell is heavier than the generic van');
  assert.ok(plain.frontalArea_m2 < big.frontalArea_m2 - 0.5, 'and catches more air');
});

T('hybrids take up to three motors (SF90: P2 + twin-motor front axle)', () => {
  const b = stockOf('ferrari-sf90-stradale').build;
  assert.equal(b.engine.motors, 3);
  assert.ok(Math.abs(stockOf('ferrari-sf90-stradale').metrics.hp - 986) / 986 < 0.03);
});

T('calibration accuracy: most stock cars land on the real power, weight, 0-100 and top speed', () => {
  let hp = 0, kg = 0, s = 0, v = 0, n = 0;
  realModels().forEach((m) => {
    const r = stockOf(m.id), x = r.metrics, t = r.target; n++;
    if (Math.abs(x.hp - t.hp) / t.hp <= 0.03) hp++;
    if (Math.abs(x.kg - t.kg) / t.kg <= 0.03) kg++;
    if (Math.abs(x.zeroTo100_s - t.zeroTo100_s) <= 0.3) s++;
    if (Math.abs(x.topSpeed_kph - t.topSpeed_kph) / t.topSpeed_kph <= 0.05) v++;
  });
  assert.ok(hp >= 47 && kg >= 46 && s >= 44 && v >= 48, `hp ${hp} kg ${kg} 0-100 ${s} vmax ${v} of ${n}`);
});

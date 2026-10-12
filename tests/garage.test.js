/* Node tests for js/garage.js pure helpers — run: node tests/run.js garage */
'use strict';
var path = require('path');
function load(f) { try { return require(path.join(__dirname, '..', 'js', f)); } catch (e) { return null; } }
load('util.js'); load('data.js'); load('state.js');
load('physics.js'); load('rules.js'); load('pricing.js');
var G = require(path.join(__dirname, '..', 'js', 'garage.js'));
var CB = globalThis.CB;

function strip(b) { var c = JSON.parse(JSON.stringify(b)); delete c.meta; return c; }

test('garage: exports the API app.js calls', function () {
  ['openSaved', 'openPresets', 'openCompare', 'openShare', 'openSpec', 'surprise', 'save', 'exportJSON', 'importJSON'].forEach(function (k) {
    assert.equal(typeof G[k], 'function', k);
  });
  assert.equal(CB.garage, G);
});

test('garage: surpriseBuild is deterministic for a seed', function () {
  var a = G.surpriseBuild({ seed: 'forge-42' }), b = G.surpriseBuild({ seed: 'forge-42' });
  assert.deepEqual(strip(a.build), strip(b.build));
  assert.equal(a.build.meta.name, b.build.meta.name);
  var c = G.surpriseBuild({ seed: 'forge-43' });
  assert.notDeepEqual(strip(a.build), strip(c.build));
});

test('garage: surprise builds are normalized and (with rules loaded) error-free', function () {
  for (var i = 0; i < 40; i++) {
    var r = G.surpriseBuild({ seed: i + 1 });
    var b = r.build;
    assert.deepEqual(strip(CB.state.normalize(b)), strip(b), 'seed ' + i + ' not normalized');
    assert.ok(b.meta.name && b.meta.name.length <= 60);
    assert.ok(typeof b.meta.id === 'string' && b.meta.id.length > 2);
    if (CB.rules && CB.rules.validate) assert.equal(r.errors, 0, 'seed ' + i + ' has errors: ' + r.issues.filter(function (x) { return x.severity === 'error'; }).map(function (x) { return x.id; }).join(','));
  }
});

test('garage: every archetype yields a coherent build', function () {
  G.archetypes.forEach(function (a) {
    var r = G.surpriseBuild({ seed: 'arch-' + a.id, archetype: a.id });
    var b = r.build;
    assert.equal(r.archetype.id, a.id);
    var style = CB.data.find('bodyStyles', b.body.style);
    assert.ok(style.allowedEnginePositions.indexOf(b.engine.position) >= 0, a.id + ' position');
    assert.equal(b.transmission.ratios.length, b.transmission.gears, a.id + ' ratios');
    if (b.engine.type === 'ev') assert.equal(b.transmission.type, 'single-speed');
    assert.ok(b.brakes.frontRotor_mm + 60 <= b.wheels.diameter_in * 25.4, a.id + ' rotor fits wheel');
    if (a.id === 'hyper') assert.equal(b.body.style, 'hypercar');
    if (a.id === 'offroad') assert.equal(b.drivetrain.layout, 'awd');
  });
});

test('garage: tyre helpers produce catalog-valid sizes', function () {
  var I = G._internal;
  [6, 8.5, 10, 12.5].forEach(function (rim) {
    var w = I.tyreWidthFor(rim, 5);
    assert.ok(w >= 175 && w <= 355 && w % 10 === 5, 'width ' + w);
    var p = I.profileFor(19, w, 680);
    assert.ok(p >= 25 && p <= 70 && p % 5 === 0, 'profile ' + p);
  });
});

test('garage: bestIndices handles high / low / target / ties / nulls', function () {
  assert.deepEqual(G.bestIndices([1, 3, 2], 'high'), { best: [1], worst: [0] });
  assert.deepEqual(G.bestIndices([1, 3, 2], 'low'), { best: [0], worst: [1] });
  assert.deepEqual(G.bestIndices([48, 55, 51], 'target', 50), { best: [2], worst: [1] });
  assert.deepEqual(G.bestIndices([2, 2, 1], 'high'), { best: [0, 1], worst: [2] });
  assert.deepEqual(G.bestIndices([5, 5], 'high'), { best: [], worst: [] });
  assert.deepEqual(G.bestIndices([null, 4], 'high'), { best: [], worst: [] });
  assert.deepEqual(G.bestIndices([1, 2], null), { best: [], worst: [] });
});

test('garage: compareRows computes deltas, best flags and diff filtering', function () {
  var base = CB.state.normalize(CB.data.defaultBuild());
  var fake = function (hp, z100, weight, price) {
    return { build: base, metrics: { power_hp: hp, zeroTo100_s: z100, weight_kg: weight, ratings: { handling: 50 } }, pricing: { total: price }, issues: [], legality: { streetLegal: true } };
  };
  var groups = G.compareRows([fake(500, 4.0, 1500, 100000), fake(600, 3.5, 1500, 120000)], { includeConfig: false });
  var rows = {};
  groups.forEach(function (g) { g.rows.forEach(function (r) { rows[r.key] = r; }); });
  assert.ok(rows.power.cells[1].best && rows.power.cells[0].worst);
  assert.equal(rows.power.cells[1].delta, 100);
  assert.equal(rows.power.cells[1].deltaGood, true);
  assert.ok(rows.z100.cells[1].best);
  assert.equal(rows.z100.cells[1].deltaGood, true);
  assert.equal(rows.weight.differs, false);
  assert.ok(!rows.weight.cells[0].best && !rows.weight.cells[1].best);
  assert.ok(rows.price.cells[0].best);
  assert.equal(rows.price.cells[1].deltaGood, false);
  assert.ok(!rows.z200, 'all-null rows are hidden');
  var only = G.compareRows([fake(500, 4.0, 1500, 100000), fake(600, 3.5, 1500, 120000)], { onlyDiff: true, includeConfig: false });
  only.forEach(function (g) { g.rows.forEach(function (r) { assert.ok(r.differs, r.key + ' should differ'); }); });
  var tally = G.tallyWins(groups, 2);
  assert.ok(tally.wins[1] >= 2 && tally.contested >= 3);
});

test('garage: configuration rows flag changed cells', function () {
  var a = CB.state.normalize(CB.data.defaultBuild());
  var b = CB.state.normalize(CB.util.set(a, 'body.style', 'sedan'));
  var groups = G.compareRows([{ build: a }, { build: b }], { onlyDiff: true });
  var cfg = groups.filter(function (g) { return g.group === 'Configuration'; })[0];
  assert.ok(cfg && cfg.rows.some(function (r) { return r.key === 'c_style' && r.cells[1].changed; }));
});

test('garage: parseImport accepts JSON, wrappers, backups, links and codes', function () {
  var b = CB.state.normalize(CB.util.set(CB.data.defaultBuild(), 'meta.name', 'Import Me'));
  var j = G.parseImport(CB.state.exportJSON(b));
  assert.ok(j.ok && j.kind === 'build' && j.builds[0].meta.name === 'Import Me');
  var w = G.parseImport(JSON.stringify({ name: 'Wrapped', build: b }));
  assert.ok(w.ok && w.builds.length === 1);
  var bk = G.parseImport(JSON.stringify({ format: 'forge-garage', version: 1, entries: [{ id: 'x', name: 'One', build: b }, { id: 'y', name: 'Two', build: b }] }));
  assert.ok(bk.ok && bk.kind === 'garage' && bk.builds.length === 2 && bk.builds[1].meta.name === 'Two');
  var link = G.parseImport('https://example.com/forge/index.html#p=engine&b=' + CB.state.encode(b));
  assert.ok(link.ok && link.kind === 'share' && link.builds[0].meta.name === 'Import Me');
  var code = G.parseImport(CB.state.encode(b));
  assert.ok(code.ok && code.kind === 'share');
  assert.equal(G.parseImport('{bad json').ok, false);
  assert.equal(G.parseImport('{"hello":1}').ok, false);
  assert.equal(G.parseImport('').ok, false);
  assert.equal(G.parseImport('definitely not a build').ok, false);
});

test('garage: garageBackup round-trips through parseImport', function () {
  var bk = G.garageBackup();
  assert.equal(bk.format, 'forge-garage');
  assert.ok(Array.isArray(bk.entries));
});

test('garage: specSections covers every part of the build', function () {
  var b = CB.state.normalize(CB.data.defaultBuild());
  var secs = G.specSections(b);
  var ids = secs.map(function (s) { return s.id; });
  ['overview', 'body', 'engine', 'driveline', 'suspension', 'brakes', 'wheels', 'aero', 'weight', 'exterior', 'interior', 'tech'].forEach(function (id) { assert.ok(ids.indexOf(id) >= 0, id); });
  assert.ok(ids.indexOf('electric') < 0);
  secs.forEach(function (s) { s.rows.forEach(function (r) { assert.equal(typeof r.value, 'string'); assert.ok(r.value.indexOf('undefined') < 0 && r.value.indexOf('NaN') < 0, s.id + '/' + r.label + ': ' + r.value); }); });
  var ev = CB.state.normalize(CB.data.presetBuild('electric-hyper'));
  var evIds = G.specSections(ev).map(function (s) { return s.id; });
  assert.ok(evIds.indexOf('electric') >= 0 && evIds.indexOf('engine') < 0);
});

test('garage: describe / textSummary / fallback thumbnails for every body style', function () {
  CB.data.bodyStyles.forEach(function (st) {
    var b = CB.state.normalize(CB.util.set(CB.data.defaultBuild(), 'body.style', st.id));
    var svg = G._internal.fallbackThumb(b);
    assert.ok(/^<svg[\s\S]*<\/svg>$/.test(svg), st.id);
    assert.ok(svg.indexOf('NaN') < 0, st.id + ' NaN in svg');
    assert.ok(G.describe(b).headline.length > 5);
  });
  var b0 = CB.state.normalize(CB.util.set(CB.data.defaultBuild(), 'meta.name', 'Summary Car'));
  var txt = G.textSummary(b0, { url: 'https://x/#b=1' });
  assert.ok(txt.indexOf('SUMMARY CAR') === 0 && txt.indexOf('https://x/#b=1') > 0);
  assert.ok(G.textSummary(b0, { markdown: true }).indexOf('### Summary Car') === 0);
});

test('garage: resolveIssues applies rule fixes until no fixable errors remain', function () {
  if (!(CB.rules && CB.rules.validate)) return;
  // deliberately broken: carbon-ceramic brakes on small wheels, huge rotor, slicks
  var b = CB.data.defaultBuild();
  b.brakes.material = 'carbon-ceramic'; b.wheels.diameter_in = 16; b.brakes.frontRotor_mm = 440;
  b = CB.state.normalize(b);
  var before = CB.rules.validate(b, CB.physics && CB.physics.compute(b)).filter(function (i) { return i.severity === 'error' && i.fix; }).length;
  var res = G.resolveIssues(b);
  var after = res.issues.filter(function (i) { return i.severity === 'error'; }).length;
  assert.ok(after <= before);
  if (before) assert.ok(res.applied.length >= 1);
});

test('garage: spec sheet dimensions follow wheelbase / track; headline keeps acronyms', function () {
  var b = CB.state.normalize(CB.data.defaultBuild());
  var st = CB.data.bodyStyles.filter(function (s) { return s.id === b.body.style; })[0];
  function dims(bb) { var r = null; G.specSections(bb).forEach(function (s) { s.rows.forEach(function (x) { if (x.label === 'Length × width × height') r = x.value; }); }); return r; }
  var f = CB.util.fmtNum || function (n) { return String(n); };
  var len0 = st.svg.length_mm + (b.body.wheelbase_mm - st.defaultWheelbase), wid0 = st.svg.width_mm + (b.body.trackWidth_mm - 1600);
  assert.ok(dims(b).indexOf(f(len0, 0)) === 0, dims(b));
  assert.ok(dims(b).indexOf(f(wid0, 0)) > 0, dims(b));
  var b2 = CB.state.normalize(CB.util.set(JSON.parse(JSON.stringify(b)), 'body.wheelbase_mm', b.body.wheelbase_mm + 100));
  assert.equal(b2.body.wheelbase_mm, b.body.wheelbase_mm + 100);
  assert.ok(dims(b2).indexOf(f(len0 + 100, 0)) === 0, dims(b2));
  var suv = CB.state.normalize(CB.util.set(CB.data.defaultBuild(), 'body.style', 'suv'));
  var h = G.describe(suv).headline;
  assert.ok(h.indexOf('SUV') >= 0 && h.indexOf('suv') < 0, h);
});

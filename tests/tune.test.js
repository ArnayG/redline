/* Simple Garage (js/tune.js, js/panels-simple.js, app.js Simple/Advanced mode) — run: node tests/run.js tune */
'use strict';
var path = require('path');
var fs = require('fs');
var vm = require('vm');
var JS = path.join(__dirname, '..', 'js');
['util.js', 'data.js', 'shapes/core.js'].forEach(function (f) { require(path.join(JS, f)); });
fs.readdirSync(path.join(JS, 'shapes', 'models')).sort().forEach(function (f) { require(path.join(JS, 'shapes', 'models', f)); });
['shapes/stock-specs.js', 'state.js', 'physics.js', 'rules.js', 'pricing.js', 'tune.js', 'panels-simple.js'].forEach(function (f) { require(path.join(JS, f)); });
var CB = globalThis.CB, T = CB.tune, U = CB.util;

function errorsOf(b) { return CB.rules.validate(b, CB.physics.compute(b)).filter(function (i) { return i.severity === 'error'; }); }
var MODELS = Object.keys(CB.shapes.models).filter(function (id) { return CB.stock.has(id); });
var BASES = MODELS.map(function (id) { return ['model ' + id, CB.stock.build(id).build]; })
  .concat(CB.data.presets.map(function (p) { return ['preset ' + p.id, CB.state.normalize(CB.data.presetBuild(p.id))]; }));

test('tune: 6 categories cover all 12 Advanced sections exactly once; every system belongs to one category', function () {
  assert.equal(T.CATEGORIES.length, 6);
  var secs = [], sys = [];
  T.CATEGORIES.forEach(function (c) { secs = secs.concat(c.sections); sys = sys.concat(c.systems); });
  assert.deepEqual(secs.slice().sort(), ['aero', 'body', 'brakes', 'drivetrain', 'engine', 'exterior', 'interior', 'suspension', 'tech', 'transmission', 'weight', 'wheels']);
  assert.deepEqual(sys.slice().sort(), T.SYSTEMS.map(function (s) { return s.id; }).sort());
  T.SYSTEMS.forEach(function (s) { assert.ok(s.levels.length >= 3 && s.levels.length <= 6, s.id + ' has 3–6 choices'); });
  assert.equal(T.categoryOf('engine'), 'power');
  assert.equal(T.categoryOf('wheels'), 'handling');
  assert.equal(T.categoryOf('tech'), 'style');
  assert.equal(T.categoryOf('nope'), null);
});

test('tune: all ' + MODELS.length + ' models + every preset: every level of every system gives a rule-legal build that detects as that level (also after a share-link round trip)', function () {
  assert.equal(MODELS.length, 53);
  var bad = [], notReached = 0, total = 0;
  BASES.forEach(function (pair) {
    var name = pair[0], b = pair[1];
    T.SYSTEMS.forEach(function (s) {
      if (T.available(s.id, b) !== true) return;
      s.levels.forEach(function (l) {
        total++;
        var r = T.apply(s.id, l.id, b);
        if (!r) { bad.push(name + ' ' + s.id + ':' + l.id + ' null'); return; }
        if (errorsOf(r.build).length) bad.push(name + ' ' + s.id + ':' + l.id + ' errors ' + errorsOf(r.build).map(function (i) { return i.id; }).join(','));
        if (!r.achieved) { notReached++; return; }   // the car cannot take it (e.g. FWD on a mid-engined car): auto-fixed back
        var rt = CB.state.decode(CB.state.encode(r.build));
        if (T.detect(s.id, rt).matches.indexOf(l.id) < 0) bad.push(name + ' ' + s.id + ':' + l.id + ' lost in share link');
      });
    });
  });
  assert.deepEqual(bad, []);
  assert.ok(notReached / total < 0.03, 'only a few levels are impossible on some cars (' + notReached + ' of ' + total + ')');
});

test('tune: a stock car detects as its factory level in every system (no "Custom" out of the box)', function () {
  var custom = [];
  MODELS.forEach(function (id) {
    var b = CB.stock.build(id).build;
    T.SYSTEMS.forEach(function (s) {
      if (T.available(s.id, b) !== true) return;
      var d = T.detect(s.id, b);
      if (!d.exact) custom.push(id + ':' + s.id);
      var lv = T.levels(s.id, b).filter(function (l) { return l.id === d.id; })[0];
      if (lv && !lv.factory) custom.push(id + ':' + s.id + ' not flagged factory');
    });
    assert.equal(T.detect('engine', b).id, 'stock', id);
    assert.equal(T.detect('gearing', b).id, 'standard', id);
  });
  assert.deepEqual(custom, []);
});

test('tune: Advanced edits read as "Custom" with the nearest level', function () {
  var b = CB.stock.build('porsche-911-992').build;
  var tuned = T.apply('engine', 'sport', b).build;
  assert.equal(T.detect('engine', tuned).id, 'sport');
  var off = CB.state.normalize(U.set(tuned, 'engine.boost_bar', tuned.engine.boost_bar + 0.05));
  var d = T.detect('engine', off);
  assert.equal(d.id, 'custom'); assert.equal(d.exact, false); assert.equal(d.nearest, 'sport');
  var fd = CB.state.normalize(U.set(b, 'transmission.finalDrive', Math.round(b.transmission.finalDrive * 1.07 * 100) / 100));
  var g = T.detect('gearing', fd);
  assert.equal(g.id, 'custom'); assert.equal(g.nearest, 'accel1');
  var paint = CB.state.normalize(U.set(b, 'exterior.finish', 'chrome'));
  assert.equal(T.detect('finish', paint).id, 'chrome', 'a finish outside the short list is shown as its own extra choice');
});

test('tune: engine levels add power step by step; gearing trades 0–100 for top speed; weight levels get lighter; aero adds downforce', function () {
  ['porsche-911-992', 'toyota-gr-yaris', 'mazda-mx5-nd'].filter(function (id) { return CB.stock.has(id); }).forEach(function (id) {
    var b = CB.stock.build(id).build;
    var hp = ['stock', 'street', 'sport', 'race', 'max'].map(function (l) { return T.metricsOf(T.apply('engine', l, b).build).metrics.power_hp; });
    for (var i = 1; i < hp.length; i++) assert.ok(hp[i] >= hp[i - 1], id + ' power ' + hp.join(' < '));
    assert.ok(hp[4] > hp[0] * 1.2, id + ' Max is a big step');
    var kg = ['stock', 'light', 'feather'].map(function (l) { return T.metricsOf(T.apply('weight', l, b).build).metrics.weight_kg; });
    assert.ok(kg[0] > kg[1] && kg[1] > kg[2], id + ' weight ' + kg.join(' > '));
    var df = ['off', 'low', 'medium', 'high'].map(function (l) { return T.metricsOf(T.apply('aero', l, b).build).metrics.downforce_kg_200; });
    for (var j = 1; j < df.length; j++) assert.ok(df[j] > df[j - 1], id + ' downforce ' + df.join(' < '));
  });
  var tesla = CB.stock.build('tesla-model-s-2021');
  if (tesla) {
    var e = tesla.build;
    assert.notEqual(T.available('gearbox', e), true, 'EVs have no gearbox choice');
    var kw = ['stock', 'max'].map(function (l) { return T.metricsOf(T.apply('engine', l, e).build).metrics.power_hp; });
    assert.ok(kw[1] > kw[0], 'EV Max adds motor power');
  }
  function gm(id, l) { return T.metricsOf(T.apply('gearing', l, CB.stock.build(id).build).build).metrics; }
  assert.ok(gm('porsche-911-992', 'accel2').zeroTo100_s < gm('porsche-911-992', 'speed2').zeroTo100_s, 'short gears are quicker off the line');
  ['nissan-silvia-s15', 'mazda-mx5-nd'].forEach(function (id) { assert.ok(gm(id, 'speed2').topSpeed_kph > gm(id, 'accel2').topSpeed_kph, id + ': long gears go faster'); });
});

test('tune: preview price deltas match CB.pricing; options() flags the selected level and previews the rest', function () {
  var b = CB.stock.build('bmw-m4-g82').build;
  var r = T.apply('brakes', 'carbon', b).build;
  var pv = T.preview(b, r);
  var p0 = CB.pricing.compute(b, CB.physics.compute(b)).total, p1 = CB.pricing.compute(r, CB.physics.compute(r)).total;
  assert.equal(Math.round(pv.price), Math.round(p1 - p0));
  assert.ok(pv.price > 0 && pv.braking_m <= 0.001, 'carbon brakes cost money and never stop longer');
  var rows = T.options('engine', b, { lockOption: null });
  assert.equal(rows.length, 5);
  assert.equal(rows.filter(function (x) { return x.primary; })[0].id, 'stock');
  assert.ok(rows[1].preview.power_hp > 0 && rows[1].preview.price > 0, 'Street previews more power for money');
  assert.equal(rows[4].streetLegal, false, 'Max (straight pipe) is flagged track only');
});

test('tune: career locks — a level that needs a locked part reports its unlock level', function () {
  var b = CB.stock.build('toyota-gr-yaris').build;
  var lockOption = function (p, id) { return p === 'engine.tune' && id === 'time-attack' ? { level: 12, reason: 'Locked: unlocks at driver level 12' } : false; };
  var rows = T.options('engine', b, { lockOption: lockOption });
  var max = rows.filter(function (x) { return x.id === 'max'; })[0];
  assert.equal(max.lock.level, 12);
  assert.equal(rows.filter(function (x) { return x.id === 'sport'; })[0].lock, null);
  if (CB.game && CB.game.economy) return;
  // with the real economy: a level-1 profile cannot fit a GT wing (aero High)
  var E = require(path.join(JS, 'game', 'economy.js'));
  var locked = E.lockedPaths({ level: 1, xp: 0 });
  var real = function (p, id) { return locked[p] && locked[p].has(id) ? { level: E.partUnlockLevel(p, id), reason: 'Locked' } : false; };
  var high = T.options('aero', b, { lockOption: real }).filter(function (x) { return x.id === 'high'; })[0];
  assert.ok(high.lock && high.lock.level > 1, 'High downforce is locked for a new driver (level ' + (high.lock && high.lock.level) + ')');
});

test('tune: choose() is one undo step and labelled; undo restores the previous build exactly', function () {
  var St = CB.state;
  St.replace(CB.stock.build('porsche-911-992').build, { resetHistory: true });
  var before = St.get(), n0 = St.history().length;
  var res = T.choose('engine', 'race');
  assert.ok(res && res.changed);
  assert.equal(St.history().length, n0 + 1);
  assert.equal(St.history()[St.history().length - 1], 'Engine tune: Race');
  assert.equal(T.detect('engine', St.get()).id, 'race');
  T.choose('tyres', 'semi');
  assert.equal(St.history().length, n0 + 2);
  St.undo(); St.undo();
  assert.deepEqual(U.set(St.get(), 'meta.modified', 0), U.set(before, 'meta.modified', 0));
  // gearing slider drags coalesce into one step
  T.choose('gearing', 'accel1', { coalesce: true }); T.choose('gearing', 'accel2', { coalesce: true });
  assert.equal(St.history().length, n0 + 1);
});

test('simpleGarage: six category panels in the CB.panels contract (not registered in CB.panels)', function () {
  var P = CB.simpleGarage.panels();
  assert.equal(P.length, 6);
  P.forEach(function (p) {
    assert.equal(typeof p.render, 'function'); assert.equal(typeof p.update, 'function'); assert.ok(p.title && p.simple);
    assert.ok(!CB.panels || !CB.panels[p.id], p.id + ' stays out of the Advanced registry');
  });
  assert.equal(CB.simpleGarage.categoryOf('suspension'), 'handling');
});

/* app.js in a stub DOM: Simple is the default mode, Advanced shows the 12 full panels, the choice is remembered per profile */
function loadApp(store, profile) {
  var noop = function () {};
  var doc = { readyState: 'loading', addEventListener: noop, removeEventListener: noop, getElementById: function () { return null; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    documentElement: { setAttribute: noop, getAttribute: function () { return null; }, classList: { add: noop, remove: noop, toggle: noop } },
    createElement: function () { return { style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }; }, body: null, hidden: false };
  var ls = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); } };
  var adv = ['body', 'engine', 'transmission', 'drivetrain', 'suspension', 'brakes', 'wheels', 'aero', 'weight', 'exterior', 'interior', 'tech'];
  var reg = {};
  adv.forEach(function (id, i) { reg[id] = { id: id, title: id, order: i, render: noop }; });
  var cb = Object.assign({}, CB, { panels: reg, panelList: function () { return adv.map(function (id) { return reg[id]; }); },
    game: profile ? { profile: { get: function () { return profile; } } } : undefined });
  var win = { CB: cb, matchMedia: function () { return { matches: false, addEventListener: noop }; }, addEventListener: noop, localStorage: ls };
  var ctx = { window: win, document: doc, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: { userAgent: 'node' } };
  win.window = win; win.document = doc;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JS, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return win.CB.app;
}

test('app: Simple is the default; Advanced reveals the 12 full panels; remembered per profile; panel ids map across modes', function () {
  var store = {};
  var A = loadApp(store, { id: 'p1' });
  assert.equal(A.mode(), 'simple');
  assert.deepEqual(A.panelIds(), ['car', 'power', 'drive', 'handling', 'aero-weight', 'style']);
  assert.ok(A.hasPanel('engine') && A.hasPanel('power'), 'deep links of both modes resolve');
  assert.equal(A.setMode('advanced'), 'advanced');
  assert.equal(A.mode(), 'advanced');
  assert.equal(A.panelIds().length, 12);
  assert.equal(loadApp(store, { id: 'p1' }).mode(), 'advanced', 'remembered for this profile');
  assert.equal(loadApp(store, { id: 'p2' }).mode(), 'simple', 'another profile keeps its own default');
  A.setMode('simple');
  assert.equal(loadApp(store, { id: 'p1' }).mode(), 'simple');
});

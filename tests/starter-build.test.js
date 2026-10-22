/* REDLINE — new-player starting car (js/state.js starterBuild / boot / reset).
   A brand-new build is a real car's factory spec (CB.stock, Auto-config) — the default model, the Porsche 911 (992)
   Carrera S — so the Simple Garage (CB.tune) shows real levels from the first visit instead of "Custom" everywhere.
   Saved builds / autosaves / share links are untouched; share codes still diff against CB.data.defaultBuild(). */
'use strict';
var path = require('path');
var fs = require('fs');
var JS = path.join(__dirname, '..', 'js');
['util.js', 'data.js', 'shapes/core.js'].forEach(function (f) { require(path.join(JS, f)); });
fs.readdirSync(path.join(JS, 'shapes', 'models')).sort().forEach(function (f) { require(path.join(JS, 'shapes', 'models', f)); });
['shapes/stock-specs.js', 'state.js', 'physics.js', 'rules.js', 'pricing.js', 'tune.js', 'garage.js'].forEach(function (f) { require(path.join(JS, f)); });
var CB = globalThis.CB, S = CB.state, T = CB.tune, St = CB.stock;

test('starter: a new build is the factory Porsche 911 Carrera S, named like Auto-config', function () {
  var b = S.starterBuild();
  assert.equal(b.body.model, 'porsche-911-992');
  assert.ok(St.isStock(b), 'exactly the stock spec');
  assert.equal(b.meta.name, 'Stock Porsche 911 Carrera S');
  assert.equal(b.meta.presetId, null);
  assert.ok(b.meta.id && b.meta.id !== S.starterBuild().meta.id, 'fresh id per new build');
  // street-legal, rule-clean, and its numbers are the real car's (443 hp, 1515 kg, 0-100 3.5 s)
  assert.deepEqual(CB.rules.validate(b).filter(function (i) { return i.severity === 'error'; }).map(function (i) { return i.id; }), []);
  var m = CB.physics.compute(b);
  assert.ok(Math.abs(m.power_hp - 443) < 15, 'hp ' + m.power_hp);
  assert.ok(Math.abs(m.weight_kg - 1515) < 40, 'kg ' + m.weight_kg);
  assert.ok(Math.abs(m.zeroTo100_s - 3.5) < 0.4, '0-100 ' + m.zeroTo100_s);
});

test('starter: the Simple Garage shows real levels (no "Custom") for the first-visit build', function () {
  var b = S.normalize(S.starterBuild());
  T.SYSTEMS.forEach(function (sys) {
    var d = T.detect(sys.id, b);
    assert.notEqual(d.id, 'custom', sys.id + ' is a real level');
  });
  assert.equal(T.detect('engine', b).id, 'stock');
  // the generic defaultBuild() (the old "Untitled Build") is no real car's spec: several systems read "Custom"
  var old = S.normalize(S.defaultBuild());
  assert.ok(T.SYSTEMS.filter(function (sys) { return T.detect(sys.id, old).id === 'custom'; }).length >= 3);
});

test('starter: boot with nothing saved starts on the factory car; a saved current build is untouched', function () {
  var store = S._storage, key = S.keys.current;
  var prev = store && store.getItem ? store.getItem(key) : null;
  try {
    if (store && store.removeItem) store.removeItem(key);
    var info = S.boot({ force: true });
    if (info.source === 'default') {
      assert.ok(St.isStock(S.get()), 'first visit: stock spec');
      assert.equal(S.get().meta.name, 'Stock Porsche 911 Carrera S');
    }
    // an existing autosave (any build, e.g. an old "Untitled Build") is restored as it was
    if (store && store.setItem) {
      var mine = S.normalize(CB.data.defaultBuild());
      mine.meta.name = 'My project';
      store.setItem(key, JSON.stringify({ saved: Date.now(), build: mine }));
      var info2 = S.boot({ force: true });
      assert.equal(info2.source, 'autosave');
      assert.equal(S.get().meta.name, 'My project');
      assert.ok(!St.isStock(S.get()), 'saved build kept, not replaced by the factory car');
    }
  } finally {
    if (store && store.setItem) { if (prev == null) store.removeItem(key); else store.setItem(key, prev); }
  }
});

test('starter: "New build" starts from the current model\'s factory spec; share links round-trip', function () {
  S.replace(S.normalize(CB.data.defaultBuild()), { resetHistory: true });
  S.applyModel('bmw-m4-g82');
  S.reset();
  assert.equal(S.get().body.model, 'bmw-m4-g82');
  assert.ok(St.isStock(S.get()), 'stock M4');
  assert.equal(S.get().meta.name, 'Stock ' + St.title('bmw-m4-g82'));
  assert.ok(S.canUndo(), 'the previous build stays in the undo history');
  // a factory car is not "unsaved work"; a tweak of it is
  assert.equal(CB.garage.isDirty(S.get()), false);
  var tweaked = JSON.parse(JSON.stringify(S.get())); tweaked.exterior.paint = '#123456';
  assert.equal(CB.garage.isDirty(S.normalize(tweaked)), true);
  // share code (diff vs CB.data.defaultBuild) decodes back to the same factory car
  var back = S.decode(S.encode(S.get()));
  assert.ok(back && St.isStock(back));
  S.reset({ resetHistory: true });
});

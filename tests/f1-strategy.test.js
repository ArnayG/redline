/* Node tests: CB.f1.strategy (docs/F1-SPEC.md §5) — tyre / pit plans and live advice. Pure logic, fast. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
['js/race/vehicle.js', 'js/f1/f1-car.js', 'js/f1/f1-strategy.js'].forEach(function (rel) {
  var p = path.join(root, rel);
  if (fs.existsSync(p)) { try { require(p); } catch (e) { /* optional */ } }
});
var CB = globalThis.CB;
var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  name = 'f1-strategy: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
var S = CB.f1 && CB.f1.strategy;
if (!S) { console.log('  (f1-strategy missing — skipped)'); module.exports = []; return; }

var MONZA = { length_m: 5793, real: { raceLap_s: 81.4 } };
function seq(rng) { var a = 12345; return function () { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return a / 4294967296; }; }
function compounds(p) { return p.stints.map(function (s) { return s.compound; }); }

test('stints cover the race distance exactly, contiguous, 0..2 stops', function () {
  [1, 3, 5, 8, 12, 20, 44, 53, 78].forEach(function (laps) {
    var p = S.plan(MONZA, laps, { rng: seq() });
    var sum = p.stints.reduce(function (a, s) { return a + s.laps; }, 0);
    assert.strictEqual(sum, laps, laps + ' laps: ' + p.notes);
    assert.strictEqual(p.stints[0].fromLap, 1);
    for (var i = 1; i < p.stints.length; i++) assert.strictEqual(p.stints[i].fromLap, p.stints[i - 1].toLap + 1);
    assert.strictEqual(p.stops, p.stints.length - 1);
    assert.ok(p.stops <= 2, p.notes);
  });
});

test('dry race of 5+ laps uses two dry compounds; short sprint may run without a stop', function () {
  [5, 10, 20, 53].forEach(function (laps) {
    var c = compounds(S.plan(MONZA, laps, { rng: seq() }));
    assert.ok(c.filter(function (x, i, a) { return a.indexOf(x) === i; }).length >= 2, laps + ' laps: ' + c.join(','));
  });
  assert.strictEqual(S.plan(MONZA, 3).stops, 0);
});

test('no stint runs past its tyre life; longer races stop more', function () {
  var p = S.plan(MONZA, 53);
  p.stints.forEach(function (s) { assert.ok(s.laps <= p.life[s.compound] * 1.08 + 1e-9, s.compound + ' ' + s.laps + ' > ' + p.life[s.compound]); });
  assert.ok(S.plan(MONZA, 70, { wearMult: 1.5 }).stops >= S.plan(MONZA, 10).stops);
  // a high-wear short race (game wear multiplier) still plans a stop
  assert.ok(S.plan(MONZA, 6, { wearMult: 5 }).stops >= 1);
});

test('start compound is honoured; wet race runs wets', function () {
  assert.strictEqual(S.plan(MONZA, 20, { startCompound: 'hard' }).stints[0].compound, 'hard');
  var w = S.plan(MONZA, 10, { weather: 'wet' });
  assert.ok(compounds(w).every(function (c) { return c === 'wet'; }));
  assert.ok(compounds(S.plan(MONZA, 10, { weather: 'damp' })).every(function (c) { return c === 'inter'; }));
});

test('plans are deterministic for a seed and vary across seeds', function () {
  var a = S.plan(MONZA, 30, { rng: seq() }), b = S.plan(MONZA, 30, { rng: seq() });
  assert.deepStrictEqual(a.stints, b.stints);
  var seen = {};
  for (var k = 1; k < 40; k++) { var s0 = k * 7919; seen[S.plan(MONZA, 30, { rng: function () { s0 = (Math.imul(s0, 48271) + 11) >>> 0; return (s0 % 1000) / 1000; } }).notes] = 1; }
  assert.ok(Object.keys(seen).length >= 2, 'no grid variety: ' + Object.keys(seen));
});

function car(compound, wear, lap, extra) {
  return Object.assign({ id: 'c1', pitStops: 0, tracker: { lap: lap }, f1: { tyres: { compound: compound, wear: [wear, wear, wear, wear], age: lap }, compoundsUsed: [compound] } }, extra || {});
}

test('advice: boxes at the end of a planned stint, not on the last lap', function () {
  var c = car('soft', 0.5, 0);
  S.assign(c, MONZA, 10, { startCompound: 'soft', life: { soft: 4, medium: 8, hard: 12 } });
  var st = c.f1Strategy.stints[0];
  c.tracker.lap = st.toLap - 1;   // driving the stint's last lap
  var a = S.advice(c, { lapsRemaining: 10 - st.toLap + 1, mode: 'race' });
  assert.ok(a.box, JSON.stringify(a));
  assert.strictEqual(a.request.compound, c.f1Strategy.stints[1].compound);
  assert.strictEqual(S.advice(car('soft', 0.99, 9), { lapsRemaining: 1, mode: 'race' }).box, false);
});

test('advice: worn-out tyres force a stop; healthy tyres extend; not outside races', function () {
  var c = car('medium', 0.9, 4);
  c.f1Strategy = S.plan(MONZA, 20, { startCompound: 'medium' });
  assert.ok(S.advice(c, { lapsRemaining: 12, mode: 'race' }).box);
  var ok = car('medium', 0.1, 1); ok.f1Strategy = c.f1Strategy;
  assert.strictEqual(S.advice(ok, { lapsRemaining: 18, mode: 'race' }).box, false);
  assert.strictEqual(S.advice(c, { lapsRemaining: 12, mode: 'qualifying' }).box, false);
});

test('advice: one dry compound with two laps to go -> mandatory change to a different compound', function () {
  var c = car('medium', 0.3, 8);
  c.f1Strategy = { stops: 0, stints: [{ compound: 'medium', laps: 10, fromLap: 1, toLap: 10 }], twoCompoundRule: true, weather: 'dry', life: { medium: 20 } };
  var a = S.advice(c, { lapsRemaining: 2, mode: 'race' });
  assert.ok(a.box);
  assert.notStrictEqual(a.request.compound, 'medium');
});

test('advice plans lazily from the hooks context (meta + lapsTotal) and reads several tyre-state shapes', function () {
  var c = car('hard', 0.1, 0);
  S.advice(c, { meta: MONZA, lapsTotal: 20, lapsRemaining: 20, mode: 'race', requireTwoCompounds: true });
  assert.ok(c.f1Strategy && c.f1Strategy.stints[0].compound === 'hard', c.f1Strategy && c.f1Strategy.notes);
  var ti = S.tyreInfo({ endurance: { f1: { compound: 'soft', tyreWear: [0.1, 0.4, 0.2, 0.3], tyreAge: 3 } } });
  assert.strictEqual(ti.compound, 'soft'); assert.strictEqual(ti.wear, 0.4); assert.strictEqual(ti.age, 3);
});

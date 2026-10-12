/* Node tests for js/race/race-ui.js pure helpers — run: node tests/race-ui.test.js (or via tests/run.js) */
'use strict';
var assert = require('assert');
var path = require('path');
var ui = require(path.join(__dirname, '..', 'js', 'race', 'race-ui.js'));
var _ = ui._;
var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('exports open/close and pure helpers without a DOM', function () {
  assert.strictEqual(typeof ui.open, 'function');
  assert.strictEqual(typeof ui.close, 'function');
  assert.strictEqual(ui.open({}), null);
  assert.ok(_ && typeof _.fmtTime === 'function');
});

test('fmtTime / fmtGap formatting', function () {
  assert.strictEqual(_.fmtTime(83.4567), '1:23.457');
  assert.strictEqual(_.fmtTime(5), '0:05.000');
  assert.strictEqual(_.fmtTime(3723.456), '1:02:03.456');
  assert.strictEqual(_.fmtTime(null), '--:--.---');
  assert.strictEqual(_.fmtTime(NaN, 'x'), 'x');
  assert.strictEqual(_.fmtGap(1.2344), '+1.234');
  assert.strictEqual(_.fmtGap(-0.5), '−0.500');
  assert.strictEqual(_.fmtGap(62.345), '+1:02.345');
  assert.strictEqual(_.ordinal(1), '1st'); assert.strictEqual(_.ordinal(12), '12th'); assert.strictEqual(_.ordinal(23), '23rd');
});

test('buildHash ignores cosmetics, tracks performance changes', function () {
  var a = _.fallbackBuild(), b = _.fallbackBuild();
  b.exterior.paint = '#00ff00'; b.meta.name = 'Other';
  assert.strictEqual(_.buildHash(a), _.buildHash(b));
  b.engine.displacement_l = 5.0;
  assert.notStrictEqual(_.buildHash(a), _.buildHash(b));
  assert.strictEqual(_.stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('records: per-track per-build best lap with track record', function () {
  var st = _.memoryStorage();
  var R = _.createRecords(st, 'k');
  var r1 = R.submit('ring', 'h1', { time: 90.5, buildName: 'A' });
  assert.ok(r1.buildBest && r1.trackRecord);
  var r2 = R.submit('ring', 'h1', { time: 91 });
  assert.ok(!r2.buildBest && !r2.trackRecord);
  var r3 = R.submit('ring', 'h2', { time: 92 });
  assert.ok(r3.buildBest && !r3.trackRecord);
  var r4 = R.submit('ring', 'h2', { time: 89 });
  assert.ok(r4.buildBest && r4.trackRecord && r4.prevTrack.time === 90.5);
  assert.strictEqual(R.bestFor('ring', 'h1').time, 90.5);
  assert.strictEqual(R.trackBest('ring').time, 89);
  assert.ok(!R.submit('ring', 'h1', { time: -1 }).buildBest);
  var persisted = JSON.parse(st.getItem('k'));
  assert.strictEqual(persisted.v, 1);
  st.setItem('k', 'garbage{');
  assert.strictEqual(R.trackBest('ring'), null);
});

test('settings sanitization clamps and whitelists', function () {
  var s = _.sanitizeSettings({ laps: 99, opponents: 0, mode: 'nope', weather: 'wet', assists: { abs: 0 }, steerSensitivity: 9 });
  assert.strictEqual(s.laps, 50); assert.strictEqual(s.opponents, 1);
  assert.strictEqual(s.mode, 'race'); assert.strictEqual(s.weather, 'wet');
  assert.strictEqual(s.assists.abs, false); assert.strictEqual(s.assists.tc, true);
  assert.strictEqual(s.steerSensitivity, 1.6);
});

test('resolveBuild returns a complete build even with no catalog', function () {
  var b = _.resolveBuild(null);
  ['body', 'engine', 'transmission', 'drivetrain', 'tires', 'aero', 'exterior'].forEach(function (k) { assert.ok(b[k], k); });
  var partial = _.resolveBuild({ body: { style: 'hatchback' }, engine: { type: 'ev' } });
  assert.strictEqual(partial.body.style, 'hatchback');
  assert.ok(partial.transmission.ratios.length > 0);
});

test('estimateMetrics is physically ordered', function () {
  var base = _.fallbackBuild();
  var weak = _.fallbackBuild(); weak.engine.layout = 'I4'; weak.engine.displacement_l = 1.6; weak.engine.aspiration = 'na'; weak.engine.boost_bar = 0;
  var mb = _.estimateMetrics(base), mw = _.estimateMetrics(weak);
  assert.ok(mb.power_hp > mw.power_hp);
  assert.ok(mb.zeroTo60_s < mw.zeroTo60_s);
  assert.ok(mb.topSpeed_kph > mw.topSpeed_kph);
  assert.ok(mb.zeroTo60_s > 2 && mb.zeroTo60_s < 7);
});

test('track stats: spline length & corner counting', function () {
  var sq = [[0, 0], [400, 0], [400, 400], [0, 400]];
  var st = _.trackStats({ id: 't-sq', points: sq });
  assert.ok(st.polyLength > 1000 && st.polyLength < 1700, 'length ' + st.polyLength);
  assert.ok(st.corners >= 3 && st.corners <= 5, 'corners ' + st.corners);
  var rs = _.resampleClosed([[0, 0], [10, 0], [10, 10], [0, 10]], 1);
  assert.ok(rs.length >= 39 && rs.length <= 41);
});

test('input: smoothed digital steering, speed-sensitive, edge-triggered shifts', function () {
  var I = _.createInput({ settings: _.DEFAULT_SETTINGS });
  I.handleKey('ArrowLeft', true);
  var o = I.sample(1 / 120, 0);
  assert.ok(o.steer > 0 && o.steer < 0.1, 'ramps, not instant: ' + o.steer);
  for (var i = 0; i < 120; i++) o = I.sample(1 / 120, 0);
  var lowSpeed = o.steer;
  assert.ok(lowSpeed > 0.9);
  for (i = 0; i < 120; i++) o = I.sample(1 / 120, 80);
  assert.ok(o.steer < lowSpeed * 0.7, 'less lock at speed: ' + o.steer);
  I.handleKey('ArrowLeft', false);
  for (i = 0; i < 120; i++) o = I.sample(1 / 120, 10);
  assert.ok(Math.abs(o.steer) < 1e-9, 'self-centres');
  I.handleKey('KeyE', true, false);
  assert.strictEqual(I.sample(1 / 120, 0).shiftUp, true);
  assert.strictEqual(I.sample(1 / 120, 0).shiftUp, false);
  I.handleKey('KeyE', true, true); // auto-repeat ignored
  assert.strictEqual(I.sample(1 / 120, 0).shiftUp, false);
  var acts = [];
  var J = _.createInput({ onAction: function (a) { acts.push(a); } });
  J.handleKey('KeyC', true); J.handleKey('Escape', true); J.handleKey('KeyM', true); J.handleKey('KeyR', true);
  assert.deepStrictEqual(acts, ['camera', 'pause', 'mute', 'reset']);
  J.handleKey('KeyW', true); J.handleKey('Space', true);
  for (i = 0; i < 60; i++) o = J.sample(1 / 120, 0);
  assert.strictEqual(o.throttle, 1); assert.strictEqual(o.handbrake, true);
  J.leftSign = -1; J.handleKey('KeyA', true);
  for (i = 0; i < 60; i++) o = J.sample(1 / 120, 0);
  assert.ok(o.steer < 0, 'leftSign flips output');
});

test('lap tracker records completed laps', function () {
  var T = _.createLapTracker();
  T.update({ cars: [{ id: 'p', isPlayer: true, lap: 0, position: 2, speed: 10 }] });
  var done = T.update({ cars: [{ id: 'p', isPlayer: true, lap: 1, lastLap_s: 80.1, lapValid: true, position: 1, speed: 50 }] });
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].time, 80.1);
  assert.strictEqual(T.gridOrder.p, 2);
  assert.strictEqual(T.cars.p.topSpeed, 50);
});

test('normalizeResults: classification, gaps, laps down, DNF, fastest lap', function () {
  var snap = { mode: 'race', cars: [
    { id: 'a', name: 'A', position: 1, finished: true, finishTime_s: 300, lap: 3, bestLap_s: 98 },
    { id: 'b', name: 'B', position: 2, finished: true, finishTime_s: 302.5, penalties_s: 5, lap: 3, bestLap_s: 97.5 },
    { id: 'c', name: 'C', position: 3, finished: true, finishTime_s: 320, lap: 2, bestLap_s: 101 },
    { id: 'd', name: 'D', position: 4, dnf: true, lap: 1 }
  ] };
  var r = _.normalizeResults({ classification: snap.cars.map(function (c) { return { id: c.id }; }) }, snap, { mode: 'race' });
  assert.strictEqual(r.rows[0].gapText, '5:00.000');
  assert.strictEqual(r.rows[1].gapText, '+7.500');
  assert.strictEqual(r.rows[2].gapText, '+1 Lap');
  assert.strictEqual(r.rows[3].gapText, 'DNF');
  assert.strictEqual(r.fastestLap.carId, 'b');
  var tt = _.normalizeResults(null, snap, { mode: 'time-trial' });
  assert.strictEqual(tt.rows[0].id, 'b');
});

test('normalizeResults: a car still running on the lead lap keeps a time gap, not "+1 Lap"', function () {
  var snap = { mode: 'race', cars: [
    { id: 'a', name: 'A', position: 1, finished: true, finishTime_s: 130, lap: 1, bestLap_s: 130 },
    { id: 'b', name: 'B', position: 2, finished: false, lap: 0, gapLeader_s: 6.2 },
    { id: 'c', name: 'C', position: 3, finished: false, lap: 0 }
  ] };
  var raw = { classification: [
    { id: 'a', status: 'finished', totalTime_s: 130 },
    { id: 'b', status: 'running', gapText: '+6.200' },
    { id: 'c', status: 'running', gapText: '+1 Lap' }
  ] };
  var r = _.normalizeResults(raw, snap, { mode: 'race' });
  assert.strictEqual(r.rows[1].gapText, '+6.200*');
  assert.strictEqual(r.rows[2].gapText, '+1 Lap');
});

if (typeof module !== 'undefined' && require.main === module) console.log(passed + ' passed');

test('launch lock: launchMismatchOf flags a career round raced on another circuit / laps / field', function () {
  var f = _.launchMismatchOf;
  assert.ok(Array.isArray(_.LOCK_KEYS) && _.LOCK_KEYS.indexOf('trackId') >= 0 && _.LOCK_KEYS.indexOf('laps') >= 0);
  var lock = { discipline: 'race', fieldSize: 8, values: { trackId: 'ring', mode: 'race', laps: 5, opponents: 7, weather: 'dry' } };
  function R(o) {
    var r = { def: { id: 'ring' }, settings: { mode: 'race', laps: 5, weather: 'dry' }, opponents: new Array(7), isDrift: false };
    for (var k in (o || {})) r[k] = o[k];
    return r;
  }
  assert.strictEqual(f(null, R()), null, 'free play: no lock, no flag');
  assert.deepStrictEqual(f(lock, R()), [], 'as launched');
  assert.deepStrictEqual(f(lock, R({ def: { id: 'other' } })), ['trackId']);
  assert.deepStrictEqual(f(lock, R({ settings: { mode: 'race', laps: 1, weather: 'dry' } })), ['laps']);
  assert.deepStrictEqual(f(lock, R({ opponents: new Array(2) })), ['fieldSize']);
  assert.deepStrictEqual(f(lock, R({ settings: { mode: 'time-trial', laps: 5, weather: 'rain' } })), ['mode', 'weather']);
  var dl = { discipline: 'drift', values: { trackId: 'touge', driftMode: 'score', driftDuration: 90, mode: 'race' } };
  assert.deepStrictEqual(f(dl, { def: { id: 'touge' }, settings: { mode: 'practice', driftMode: 'score', driftDuration: 90 }, opponents: [], isDrift: true }), [],
    'drift runs are practice sessions: mode/laps are not compared');
  assert.deepStrictEqual(f(dl, { def: { id: 'touge' }, settings: { mode: 'practice', driftMode: 'free', driftDuration: 90 }, opponents: [], isDrift: true }), ['driftMode']);
});

test('records: drift best scores are stored apart from race lap times (higher = better)', function () {
  var st = _.memoryStorage();
  var R = _.createRecords(st, 'k');
  R.submit('touge', 'h1', { time: 55.044 });
  assert.strictEqual(R.driftBestFor('touge', 'h1'), null, 'a lap time is not a drift score');
  var a = R.submitDrift('touge', 'h1', { score: 42000, medal: 'silver' });
  assert.ok(a.buildBest && a.trackRecord);
  var b = R.submitDrift('touge', 'h1', { score: 30000 });
  assert.ok(!b.buildBest && !b.trackRecord && b.prevTrack.score === 42000);
  var c = R.submitDrift('touge', 'h2', { score: 50000 });
  assert.ok(c.buildBest && c.trackRecord);
  assert.strictEqual(R.driftBestFor('touge', 'h1').score, 42000);
  assert.strictEqual(R.driftTrackBest('touge').score, 50000);
  assert.strictEqual(R.trackBest('touge').time, 55.044, 'lap records untouched');
  assert.ok(!R.submitDrift('touge', 'h1', { score: 0 }).buildBest);
});

test('lap chart: a 1-lap session still draws the player line (level line + "You" label)', function () {
  var hadWin = typeof global.window !== 'undefined';
  if (!hadWin) global.window = { devicePixelRatio: 1 };
  var segs = [], texts = [], cur = null;
  var grad = { addColorStop: function () {} };
  var ctx = new Proxy({
    beginPath: function () { cur = []; }, moveTo: function (x, y) { if (cur) cur.push([x, y]); }, lineTo: function (x, y) { if (cur) cur.push([x, y]); },
    stroke: function () { if (cur) segs.push({ pts: cur.slice(), color: ctx.strokeStyle }); }, fillText: function (t) { texts.push(String(t)); },
    createLinearGradient: function () { return grad; }, setLineDash: function () {}
  }, { get: function (t, k) { return k in t ? t[k] : function () {}; }, set: function (t, k, v) { t[k] = v; return true; } });
  var canvas = { clientWidth: 400, clientHeight: 160, width: 0, height: 0, getContext: function () { return ctx; } };
  try {
    _.drawLapChart(canvas, [{ time: 62.5, valid: true }], null, null, null);
  } finally { if (!hadWin) delete global.window; }
  var level = segs.filter(function (s) { return s.color === '#c8a24a' && s.pts.length >= 2 && Math.abs(s.pts[0][1] - s.pts[s.pts.length - 1][1]) < 1e-6 && Math.abs(s.pts[s.pts.length - 1][0] - s.pts[0][0]) > 100; });
  assert.ok(level.length >= 1, 'a visible horizontal player line');
  assert.ok(texts.indexOf('You') >= 0, 'labelled You');
});

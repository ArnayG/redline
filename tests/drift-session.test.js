/* Node tests for js/race/drift/session.js — run: node tests/drift-session.test.js (or via node tests/run.js)
   Loads the real race core + whichever drift modules exist (assist / tune / scoring / tracks / ai are built in parallel
   and every one of them is optional for the session), then checks the session surface, the hook wiring and the
   built-in fallbacks. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { console.log('  (skip ' + rel + ': ' + e.message + ')'); return false; }
}
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js',
 'js/game/challenges.js', 'js/race/drift/tune.js', 'js/race/drift/assist.js', 'js/race/drift/scoring.js', 'js/race/drift/tracks.js',
 'js/race/drift/ai.js'].forEach(tryLoad);
var S = require(path.join(root, 'js', 'race', 'drift', 'session.js'));
var CB = globalThis.CB;
var I = S._internal;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('drift-session: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}

function driftTrack() {
  var l = S.tracksFor('drift');
  return l[0] ? l[0].id : undefined;
}
function memStorage() { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; }
function run(sess, seconds, raw) {
  var n = Math.round(seconds * 60);
  for (var i = 0; i < n; i++) sess.update(1 / 60, typeof raw === 'function' ? raw(i / 60) : raw);
}
function player(snap) { return snap.cars.filter(function (c) { return c.isPlayer; })[0]; }

/* ---------------------------------------------------------------- pure helpers */
test('toIntent accepts keyboard intent and engine-style input', function () {
  var a = I.toIntent({ left: true, up: true });
  assert.strictEqual(a.left, true); assert.strictEqual(a.right, false); assert.strictEqual(a.up, true);
  var b = I.toIntent({ throttle: 1, steer: -0.8, brake: 0 });
  assert.strictEqual(b.steerAxis, -0.8); assert.strictEqual(b.right, true); assert.strictEqual(b.up, true);
  var d = I.directInput(I.toIntent({ left: true, down: true, handbrake: true }));
  assert.deepStrictEqual([d.steer, d.throttle, d.brake, d.handbrake], [1, 0, 1, true]);
  assert.strictEqual(I.directInput(I.toIntent(null)).steer, 0);
});

test('stateFromSnap converts world velocity to the body frame (beta sign: + = sliding left of the nose)', function () {
  var ps = I.stateFromSnap({ x: 0, y: 0, heading: 0, vx: 10, vy: 5, speed: Math.hypot(10, 5) }, null, 1 / 60);
  assert.ok(Math.abs(ps.vxLocal - 10) < 1e-9 && Math.abs(ps.vyLocal - 5) < 1e-9);
  assert.ok(ps.beta > 0 && Math.abs(ps.angle_deg - Math.atan2(5, 10) * 180 / Math.PI) < 1e-6);
  var ps2 = I.stateFromSnap({ x: 0, y: 0, heading: Math.PI / 2, vx: 0, vy: 10, speed: 10 }, null, 1 / 60);
  assert.ok(Math.abs(ps2.vxLocal - 10) < 1e-9 && Math.abs(ps2.vyLocal) < 1e-9);
});

test('fallback assist: off is direct, heavy is rate-limited and counter-steers into a slide', function () {
  var off = I.createFallbackAssist({ level: 'off', mode: 'drift' });
  assert.strictEqual(off.filter({ left: true }, { speed: 20, vxLocal: 20, vyLocal: 0 }, { dt: 1 / 120 }).steer, 1);
  var hv = I.createFallbackAssist({ level: 'heavy', mode: 'drift' });
  var o = hv.filter({ left: true }, { speed: 20, vxLocal: 20, vyLocal: 0, yawRate: 0, maxSteer_rad: 0.6 }, { dt: 1 / 120 });
  assert.ok(o.steer > 0 && o.steer < 0.2, 'ramped, got ' + o.steer);
  // sliding: velocity to the right of the nose (beta < 0) -> no key -> steer right (negative) to catch it
  var hv2 = I.createFallbackAssist({ level: 'heavy', mode: 'drift' });
  var st = 0;
  for (var i = 0; i < 120; i++) st = hv2.filter({}, { speed: 20, vxLocal: 17, vyLocal: -10, yawRate: 0, maxSteer_rad: 0.6 }, { dt: 1 / 120 }).steer;
  assert.ok(st < -0.4, 'counter-steer, got ' + st);
  assert.ok(typeof hv2.debug().beta === 'number');
});

test('fallback scorer has the spec state/results shape and scores a sustained slide', function () {
  var sc = I.createFallbackScorer(null, null, { duration_s: 60 });
  for (var i = 0; i < 600; i++) sc.update({ speed: 20, angle_deg: 35, vx: 16, vy: 11, heading: 0, onTrack: true }, 1 / 60, []);
  var st = sc.state();
  ['total', 'current', 'multiplier', 'angle_deg', 'grade', 'zones', 'lastEvent'].forEach(function (k) { assert.ok(k in st, 'state.' + k); });
  assert.ok(st.total > 0, 'scored ' + st.total);
  var r = sc.results();
  ['total', 'bestDrift', 'longestDrift_s', 'maxAngle_deg', 'maxCombo', 'zonesHitPct', 'medal'].forEach(function (k) { assert.ok(k in r, 'results.' + k); });
});

test('tracksFor(drift) lists drift venues first; race keeps the catalog order', function () {
  var d = S.tracksFor('drift'), r = S.tracksFor('race');
  assert.strictEqual(d.length, r.length);
  var firstNon = d.findIndex(function (t) { return !S.isDriftTrack(t); });
  var lastDrift = d.map(S.isDriftTrack).lastIndexOf(true);
  assert.ok(firstNon < 0 || lastDrift < firstNon, 'drift tracks before circuits');
});

/* ---------------------------------------------------------------- sessions */
test('free session: surface, practice engine, heavy/street defaults, drift snapshot block', function () {
  var s = CB.race.drift.createSession({ trackId: driftTrack(), seed: 7, storage: memStorage() });
  ['update', 'snapshot', 'results', 'restart', 'scorerState', 'assistDebug', 'playerState', 'setAssistLevel', 'resetPlayerToTrack', 'end'].forEach(function (k) {
    assert.strictEqual(typeof s[k], 'function', k);
  });
  assert.strictEqual(s.mode, 'free');
  assert.strictEqual(s.config.mode, 'practice');
  assert.strictEqual(s.getAssistLevel(), 'heavy');
  assert.strictEqual(s.getTuneLevel(), 'street');
  run(s, 3, { up: true });
  var snap = s.snapshot();
  assert.ok(snap.drift && snap.drift.scorer, 'snap.drift.scorer');
  assert.strictEqual(snap.drift.timeLeft_s, null);
  assert.ok(player(snap).speed > 5, 'player accelerates: ' + player(snap).speed);
  assert.ok(s.playerState().speed > 5 && 'yawRate' in s.playerState());
  assert.strictEqual(snap.cars.length, 1);
  var r = s.results();
  assert.ok(r.drift && 'total' in r.drift);
  assert.strictEqual(r.hookErrors, 0);
});

test('tune is applied to the player params in drift modes and never in race mode', function () {
  var T = CB.race.drift.tune;
  if (!T || typeof T.apply !== 'function') return;          // tune module not present: identity
  var s = CB.race.drift.createSession({ trackId: driftTrack(), seed: 1, tune: 'pro' });
  var pc = s._debug().playerCar;
  assert.ok(pc.params.drift && pc.params.drift.level === 'pro', 'tuned params on the player');
  var rs = CB.race.drift.createSession({ mode: 'race', trackId: 'forge-ring', seed: 1, opponents: 2 });
  assert.ok(!(rs._debug().playerCar.params.drift && rs._debug().playerCar.params.drift.tuned), 'race mode untuned');
});

test('assist filters the raw arrows: tapping left with heavy assist ramps the steering instead of snapping', function () {
  var s = CB.race.drift.createSession({ trackId: driftTrack(), seed: 2, assist: 'heavy' });
  run(s, 2, { up: true });
  s.update(1 / 120, { up: true, left: true });
  var st = s._debug().playerCar.input.steer;
  assert.ok(st < 0.5, 'heavy steer ramps, got ' + st);
  var o = CB.race.drift.createSession({ trackId: driftTrack(), seed: 2, assist: 'off' });
  run(o, 2, { up: true });
  o.update(1 / 120, { up: true, left: true });
  // off: no assist ramp, but keyboard drift steering is speed-sensitive (a tap is a proportional correction, not a flick)
  var stOff = o._debug().playerCar.input.steer;
  assert.ok(stOff > st, 'assist off responds quicker than heavy (' + stOff.toFixed(2) + ' vs ' + st.toFixed(2) + ')');
  assert.ok(o._debug().playerCar.input.slideRack === true, 'off keyboard steering uses the slide-relative rack');
  assert.strictEqual(s.setAssistLevel('light'), 'light');
  assert.strictEqual(s.snapshot().drift.assistLevel, 'light');
});

test('trial: countdown holds the car, timer runs, session ends and banks a result', function () {
  var s = CB.race.drift.createSession({ mode: 'trial', trackId: driftTrack(), seed: 3, duration_s: 8, startDelay_s: 2 });
  run(s, 1.5, { up: true });
  var snap = s.snapshot();
  assert.ok(snap.drift.countdown_s > 0, 'counting down');
  assert.strictEqual(s.getPhase(), 'countdown');
  assert.ok(player(snap).speed < 0.5, 'held during countdown');
  run(s, 4, { up: true });
  assert.ok(s.snapshot().drift.timeLeft_s < 8 && s.snapshot().drift.timeLeft_s > 0);
  run(s, 6, { up: true });
  assert.ok(s.isFinished(), 'finished after duration');
  assert.strictEqual(s.getPhase(), 'finished');
  var r = s.results();
  assert.strictEqual(r.finished, true);
  assert.ok(Math.abs(r.elapsed_s - 8) < 0.1, 'elapsed ' + r.elapsed_s);
  assert.ok(r.drift && isFinite(r.drift.total));
});

test('tandem: one lead car starts ahead of the player and the gap is tracked', function () {
  var s = CB.race.drift.createSession({ mode: 'tandem', trackId: driftTrack(), seed: 4, startDelay_s: 0.5, duration_s: 30 });
  var snap = s.snapshot();
  assert.strictEqual(snap.cars.length, 2);
  var lead = snap.cars.filter(function (c) { return !c.isPlayer; })[0];
  assert.strictEqual(lead.id, 'lead');
  run(s, 3, { up: true });
  var t = s.snapshot().drift.tandem;
  assert.ok(t && isFinite(t.dist_m) && isFinite(t.gap_m), 'tandem info');
  var r = s.results();
  assert.ok(r.tandem && r.tandem.avgDist_m > 0);
});

test('race mode: engine race with AI field, assist mode race, no scorer, heavy assist blocks jump starts', function () {
  var s = CB.race.drift.createSession({ mode: 'race', trackId: 'forge-ring', seed: 5, opponents: 3, laps: 1 });
  assert.strictEqual(s.config.mode, 'race');
  assert.strictEqual(s.scorerState(), null);
  var snap = s.snapshot();
  assert.strictEqual(snap.cars.length, 4);
  run(s, 2, { up: true });                     // still on the grid / lights
  var sn2 = s.snapshot();
  assert.ok(!player(sn2).jumpStart, 'no jump start with heavy assist');
  run(s, 10, { up: true });
  assert.ok(player(s.snapshot()).speed > 5, 'player drives after lights out');
  var d = s.assistDebug();
  assert.ok(d && d.level === 'heavy');
  assert.strictEqual(s.results().drift, null);
});

test('restart resets timer, scorer and replays deterministically', function () {
  var s = CB.race.drift.createSession({ mode: 'trial', trackId: driftTrack(), seed: 9, duration_s: 30, startDelay_s: 0 });
  var drive = function (t) { return { up: true, left: t > 1.5 && t < 3, right: t >= 3 && t < 4 }; };
  run(s, 5, drive);
  var a = player(s.snapshot());
  s.restart();
  assert.ok(s.elapsed() < 0.05);
  var st = s.scorerState();
  assert.ok(!st || st.total === 0);
  run(s, 5, drive);
  var b = player(s.snapshot());
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, 'deterministic replay');
});

test('wall impacts reach the scorer as player events', function () {
  var s = CB.race.drift.createSession({ trackId: driftTrack(), seed: 6, assist: 'off', autoRecover: false });
  var seen = [], engineWalls = 0;
  var sc = s._debug().scorer, orig = sc.update;
  sc.update = function (car, dt, ev) { if (ev && ev.length) seen = seen.concat(ev); return orig.apply(sc, arguments); };
  for (var i = 0; i < 60 * 20 && !engineWalls; i++) {           // flat out, no steering: the first corner's barrier
    s.update(1 / 60, { up: true });
    engineWalls += s.snapshot().events.filter(function (e) { return e.type === 'wall' && e.carId === 'player'; }).length;
  }
  assert.ok(engineWalls > 0, 'test setup: the car hit a wall');
  s.update(1 / 60, { up: true });
  var w = seen.filter(function (e) { return e.type === 'wall' || e.type === 'collision'; });
  assert.ok(w.length > 0, 'wall events forwarded');
  assert.strictEqual(w[0].carId, 'player');
});

test('works without any drift collaborators (engine only): fallback assist + scorer', function () {
  var keep = {};
  ['tune', 'scoring', 'ai'].forEach(function (k) { keep[k] = CB.race.drift[k]; delete CB.race.drift[k]; });
  var keepA = CB.race.assist; delete CB.race.assist;
  try {
    var s = CB.race.drift.createSession({ mode: 'tandem', trackId: driftTrack(), seed: 8, startDelay_s: 0 });
    run(s, 3, { up: true, right: true });
    var d = s._debug();
    assert.ok(d.assist.fallback, 'fallback assist');
    assert.ok(d.scorer.fallback, 'fallback scorer');
    var snap = s.snapshot();
    assert.ok(snap.drift.scorer && isFinite(snap.drift.scorer.total));
    assert.ok(s.results().drift);
  } finally {
    Object.keys(keep).forEach(function (k) { if (keep[k]) CB.race.drift[k] = keep[k]; });
    if (keepA) CB.race.assist = keepA;
  }
});

test('heavy assist + held right arrow and throttle on a drift track: the car keeps moving and does not spin out', function () {
  var s = CB.race.drift.createSession({ trackId: 'circle-lab', seed: 11, assist: 'heavy' });
  var maxBeta = 0, spins = 0;
  for (var i = 0; i < 60 * 12; i++) {
    s.update(1 / 60, { up: true, right: i > 120 });
    var ps = s.playerState();
    if (ps && ps.speed > 5) { maxBeta = Math.max(maxBeta, ps.angle_deg); if (ps.angle_deg > 110) spins++; }
  }
  assert.ok(spins < 30, 'no sustained spin (frames >110°: ' + spins + ', max ' + maxBeta.toFixed(0) + '°)');
  assert.ok(s.playerState().speed > 3, 'still moving');
});

/* loads js/race/drift/arcade.js, so it runs last (the tests above exercise the session without the drift lock) */
test('drift lock hookup: heavy/auto engage the arcade lock in drift modes only; level switches drop / rebuild it; fx block', function () {
  if (!tryLoad('js/race/drift/arcade.js') || !CB.race.drift.arcade) return;
  var s = CB.race.drift.createSession({ trackId: 'circle-lab', seed: 4, assist: 'auto' });
  assert.strictEqual(s.getAssistLevel(), 'auto');
  run(s, 8, { up: true });
  var snap = s.snapshot(), fx = snap.drift.fx;
  assert.strictEqual(snap.drift.arcade, true, 'auto runs the drift lock');
  assert.ok(fx && typeof fx.slip === 'number' && typeof fx.drifting === 'boolean' && 'sweet' in fx && 'limiter' in fx, 'fx block for smoke / camera / audio');
  var ps = s.playerState();
  ['speed', 'vxLocal', 'vyLocal', 'yawRate', 'heading', 'angle_deg'].forEach(function (k) { assert.ok(isFinite(ps[k]), 'playerState.' + k); });
  assert.strictEqual(s.setAssistLevel('medium'), 'medium');
  run(s, 0.5, { up: true });
  assert.strictEqual(s.snapshot().drift.arcade, false, 'medium uses the regular assist');
  s.setAssistLevel('heavy');
  run(s, 0.5, { up: true });
  assert.strictEqual(s.snapshot().drift.arcade, true, 'heavy rebuilds the lock lazily');
  assert.ok(s.playerState().angle_deg < 80, 'no spin across level switches');
  var r = CB.race.drift.createSession({ trackId: 'forge-ring', mode: 'race', opponents: 1, laps: 1, assist: 'auto', seed: 2 });
  run(r, 2, { up: true });
  assert.strictEqual(r.snapshot().drift.arcade, false, 'race mode never uses the drift lock');
  assert.strictEqual(s.results().hookErrors, 0, 'no hook errors');
});

test('tandem on heavy: arrow mashing stays a close chase (no bump-and-pass), scorer gets the assist level', function () {
  if (!CB.race.drift.arcade || !CB.race.drift.ai) return;
  var rng = 7; function rnd() { return (rng = (rng * 16807) % 2147483647) / 2147483647; }
  var s = CB.race.drift.createSession({ trackId: 'circle-lab', mode: 'tandem', assist: 'heavy', duration_s: 60, seed: 3 });
  var inp = { up: true }, ahead = 0, n = 0, close = 0;
  for (var i = 0; i < 60 * 60; i++) {
    if (i % 10 === 0) { var k = rnd(); inp = { up: true, left: k < 0.3, right: k > 0.7 }; }
    s.update(1 / 60, inp);
    if (i % 30 === 0 && i > 360) { var t = s.snapshot().drift.tandem; if (t && t.gap_m != null) { n++; if (t.gap_m < -2) ahead++; if (t.dist_m < 25) close++; } }
  }
  assert.ok(n > 50 && ahead / n < 0.1, 'player stays behind the lead (ahead ' + ahead + '/' + n + ')');
  assert.ok(close / n > 0.7, 'close chase (' + close + '/' + n + ' samples within 25 m)');
  assert.ok(s.scorerState().assistLevel === 'heavy' || s.scorerState().assistLevel == null, 'scorer level');
  var m = CB.race.drift.createSession({ trackId: 'circle-lab', mode: 'trial', assist: 'medium', duration_s: 10 });
  run(m, 1, { up: true });
  if (m.scorerState().assistLevel != null) assert.strictEqual(m.scorerState().assistLevel, 'medium', 'session passes its assist level to the scorer');
  m.setAssistLevel('light');
  if (m.scorerState().assistLevel != null) assert.strictEqual(m.scorerState().assistLevel, 'light', 'setAssistLevel reaches the scorer');
  assert.strictEqual(s.results().hookErrors, 0, 'no hook errors');
});

test('snapshot reports the drift mode (base HUD labels FREE RUN / SCORE ATTACK / TANDEM, not PRACTICE)', function () {
  ['free', 'trial', 'tandem'].forEach(function (md) {
    var s = CB.race.drift.createSession({ trackId: driftTrack(), mode: md, seed: 2, startDelay_s: 0 });
    run(s, 0.5, { up: true });
    var sn = s.snapshot();
    assert.strictEqual(sn.mode, md, md + ': snap.mode');
    assert.strictEqual(sn.engineMode, 'practice', md + ': engine mode kept');
    assert.strictEqual(sn.drift.mode, md);
  });
  var r = CB.race.drift.createSession({ trackId: driftTrack(), mode: 'race', opponents: 1, seed: 2 });
  run(r, 0.2, {});
  assert.strictEqual(r.snapshot().mode, 'race', 'race mode keeps the engine mode');
});

test('tandem on heavy: lead contact never wipes the run (Up + arrows switching every 3 s)', function () {
  if (!CB.race.drift.arcade || !CB.race.drift.ai) return;
  var s = CB.race.drift.createSession({ trackId: 'dockyard-sliders', mode: 'tandem', assist: 'heavy', duration_s: 120, seed: 1 });
  for (var i = 0; i < 60 * 125 && !s.snapshot().drift.finished; i++) { var ph = Math.floor(i / 180) % 2; s.update(1 / 60, { up: true, left: ph === 0, right: ph === 1 }); }
  var r = s.results(), d = r.drift || {};
  assert.strictEqual(d.contacts || 0, 0, 'no combo-losing contacts');
  assert.ok((d.pointsLost || 0) < 0.2 * Math.max(1, d.total || 0), 'points lost ' + d.pointsLost + ' of ' + d.total);
  assert.ok(r.tandem && r.tandem.minDist_m > 2.5, 'chase holds a gap (min ' + (r.tandem && r.tandem.minDist_m) + ' m)');
  assert.strictEqual(r.hookErrors, 0, 'no hook errors');
});

/* ---------------------------------------------------------------- standalone runner */
if (local) {
  var passed = 0, failed = 0;
  queue.forEach(function (t) {
    try { t.fn(); passed++; console.log('  ✓ ' + t.name); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

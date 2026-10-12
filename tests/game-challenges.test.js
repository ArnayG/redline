/* Node tests for js/game/challenges.js (CB.game.challenges) — run via node tests/run.js */
'use strict';
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function tryLoad(rel) {
  var p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  try { require(p); return true; } catch (e) { return false; }
}
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(tryLoad);
var haveTracks = tryLoad('js/race/tracks.js');
var haveVehicle = tryLoad('js/race/vehicle.js');
tryLoad('js/race/ai.js');
var haveEngine = tryLoad('js/race/engine.js');
var C = require(path.join(root, 'js', 'game', 'challenges.js'));
var CB = globalThis.CB;
var REAL = haveTracks && haveVehicle && haveEngine && !!(CB.race && CB.race.engine && CB.race.engine.createSession);

function T(name, fn) { globalThis.test('challenges: ' + name, fn); }
function baseBuild() { return CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null; }
function variant(mut) { var b = JSON.parse(JSON.stringify(baseBuild())); mut(b); return b; }
var weakBuild = function () { return variant(function (b) { b.engine.layout = 'I4'; b.engine.displacement_l = 1.6; b.engine.aspiration = 'na'; b.tires.compound = 'eco'; }); };

/* Canvas 2D mock: records calls, never throws. */
function mockCtx(W, H) {
  var calls = { fillText: [], arc: 0, stroke: 0, fill: 0 };
  var grad = { addColorStop: function () {} };
  var target = {
    canvas: { width: W || 1280, height: H || 720, clientWidth: W || 1280, clientHeight: H || 720 },
    measureText: function (s) { return { width: String(s).length * 6 }; },
    createLinearGradient: function () { return grad; }, createRadialGradient: function () { return grad; },
    fillText: function (s) { calls.fillText.push(String(s)); },
    arc: function () { calls.arc++; }, stroke: function () { calls.stroke++; }, fill: function () { calls.fill++; }
  };
  var ctx = new Proxy(target, {
    get: function (t, k) { if (k in t) return t[k]; return function () {}; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
  ctx.calls = calls;
  return ctx;
}

/* Run an engine session for a challenge; returns the final evaluate() output. */
function runChallenge(id, build, opts) {
  opts = opts || {};
  var s = C.createChallengeSession(id, build, opts.session);
  var es = s.createEngineSession(opts.cfg);
  if (opts.autopilot !== false && es.setPlayerAutopilot) es.setPlayerAutopilot(true);
  var out = null, maxSteps = Math.round((opts.maxSeconds || 120) * 60);
  for (var i = 0; i < maxSteps; i++) {
    es.update(1 / 60, opts.input ? opts.input(i) : undefined);
    if (i % 2 === 0) { out = s.evaluate(es.snapshot()); if (out.done) break; }
  }
  return { session: s, engine: es, out: out };
}

/* ------------------------------------------------------------------ catalog */
T('catalog: 7 challenge kinds, main list and descriptor shape', function () {
  ['launch', 'braking', 'slalom', 'elk', 'drift', 'topspeed', 'hotlap'].forEach(function (k) { assert.ok(C.kinds[k], 'kind ' + k); });
  assert.ok(C.list.length >= 7);
  var kinds = {};
  C.all().forEach(function (ch) {
    kinds[ch.kind] = true;
    ['id', 'name', 'desc', 'rules', 'scoreFn'].forEach(function (f) { assert.ok(ch[f] != null, ch.id + '.' + f); });
    assert.equal(typeof ch.scoreFn, 'function');
    assert.ok('trackDef' in ch && 'medals' in ch);
    assert.equal(C.get(ch.id), ch);
  });
  assert.equal(Object.keys(kinds).length, 7);
});

T('catalog: driving school B/A/S with three tests each, chained requirements', function () {
  assert.deepEqual(C.licenses.map(function (l) { return l.id; }), ['B', 'A', 'S']);
  C.licenses.forEach(function (L) {
    assert.equal(L.tests.length, 3);
    L.tests.forEach(function (tid) { var t = C.get(tid); assert.ok(t); assert.equal(t.license, L.id); assert.equal(t.category, 'license'); });
    assert.ok(L.reward.credits > 0 && L.reward.xp > 0);
  });
  assert.equal(C.licenseTests.length, 9);
  assert.equal(C.licenses[0].requires, null);
  assert.equal(C.licenses[1].requires, 'B');
  assert.equal(C.licenses[2].requires, 'A');
});

/* ------------------------------------------------------------------ medals */
T('medalFor / nextMedal for both score directions', function () {
  var time = { platinum: 10, gold: 11, silver: 12, bronze: 14, higherIsBetter: false };
  assert.equal(C.medalFor(9.9, time), 'platinum');
  assert.equal(C.medalFor(11.5, time), 'silver');
  assert.equal(C.medalFor(14, time), 'bronze');
  assert.equal(C.medalFor(15, time), null);
  assert.equal(C.medalFor(null, time), null);
  var n = C.nextMedal(11.5, time);
  assert.equal(n.medal, 'gold'); assert.ok(Math.abs(n.gap - 0.5) < 1e-9);
  var pts = { platinum: 1000, gold: 800, silver: 500, bronze: 200, higherIsBetter: true };
  assert.equal(C.medalFor(850, pts), 'gold');
  assert.equal(C.nextMedal(850, pts).medal, 'platinum');
  assert.equal(C.nextMedal(2000, pts), null);
  assert.ok(C.medalRank('gold') > C.medalRank('silver'));
});

T('medal ladders are ordered and scaled to the car performance class', function () {
  if (!baseBuild()) return;
  var strong = baseBuild(), weak = weakBuild();
  var pw = C.performanceClass(weak), ps = C.performanceClass(strong);
  assert.ok(pw.pi < ps.pi, 'weak car has a lower PI');
  C.list.forEach(function (ch) {
    var m = C.medalsFor(ch.id, strong);
    assert.ok(m, ch.id);
    var order = ['bronze', 'silver', 'gold', 'platinum'];
    for (var i = 1; i < order.length; i++) {
      if (m.higherIsBetter) assert.ok(m[order[i]] >= m[order[i - 1]], ch.id + ' ' + order[i]);
      else assert.ok(m[order[i]] <= m[order[i - 1]], ch.id + ' ' + order[i]);
    }
    assert.equal(m.classId, ps.id);
  });
  assert.ok(C.medalsFor('launch-control', weak).gold > C.medalsFor('launch-control', strong).gold, 'slow car gets a slower launch target');
  assert.ok(C.medalsFor('top-speed-run', weak).gold < C.medalsFor('top-speed-run', strong).gold);
  assert.ok(C.medalsFor('hot-lap-little-anvil', weak).gold > C.medalsFor('hot-lap-little-anvil', strong).gold);
});

/* ------------------------------------------------------------------ tracks */
T('special track defs match the CB.race.tracks def shape and build', function () {
  var defs = C.trackDefs();
  assert.equal(defs.length, 4);
  defs.forEach(function (d) {
    ['id', 'name', 'points', 'width_m', 'length_m', 'theme', 'surface'].forEach(function (k) { assert.ok(d[k] != null, d.id + '.' + k); });
    assert.ok(Array.isArray(d.points) && d.points.length > 10);
    assert.equal(d.challenge, true);
    if (haveTracks) {
      var ref = CB.race.tracks.list.filter(function (x) { return !x.challenge; })[0];
      Object.keys(ref).forEach(function (k) { assert.ok(k in d, d.id + ' missing ' + k); });
      var g = CB.race.tracks.build(d);
      assert.ok(g && g.length > 500 && g.samples.length > 50, d.id + ' builds');
    }
  });
  var strip = C.challengeTrack('challenge-strip');
  assert.ok(strip.length_m > 5000);
});

T('registerTracks / unregisterTracks round-trip on CB.race.tracks', function () {
  if (!haveTracks) return;
  var T2 = CB.race.tracks, before = T2.list.length;
  C.registerTracks();
  assert.equal(T2.list.length, before + 4);
  assert.ok(T2.get('challenge-drift'));
  C.registerTracks();
  assert.equal(T2.list.length, before + 4, 'idempotent');
  C.unregisterTracks();
  assert.equal(T2.list.length, before);
  assert.ok(!T2.byId['challenge-drift']);
});

/* ------------------------------------------------------------------ drift scoring */
function driftCar(angleDeg, speed, dir) {
  var b = (dir || 1) * angleDeg * Math.PI / 180;
  return { x: 0, y: 0, heading: 0, speed: speed, vx: Math.cos(b) * speed, vy: Math.sin(b) * speed };
}
T('drift: points scale with angle × speed × duration', function () {
  var I = C._internal, o = C.DRIFT_DEFAULTS;
  assert.equal(I.driftAngleFactor(5, o), 0);
  assert.ok(I.driftAngleFactor(40, o) > I.driftAngleFactor(20, o));
  assert.equal(I.driftAngleFactor(130, o), 0);
  function score(angle, speed, secs) {
    var d = C.createDriftScorer({ multiplierMax: 1 });
    for (var t = 0; t < secs; t += 1 / 60) d.update(driftCar(angle, speed), 1 / 60);
    return d.total();
  }
  assert.ok(score(35, 20, 2) > score(18, 20, 2), 'angle');
  assert.ok(score(30, 30, 2) > score(30, 15, 2), 'speed');
  assert.ok(score(30, 20, 4) > score(30, 20, 2) * 1.8, 'duration');
  assert.equal(score(3, 20, 2), 0, 'grip driving scores nothing');
  assert.equal(score(30, 4, 2), 0, 'too slow');
});

T('drift: combo multiplier climbs, chain banks after the window, multiplier decays', function () {
  var d = C.createDriftScorer();
  for (var i = 0; i < 60 * 8; i++) d.update(driftCar(38, 22), 1 / 60);
  var S = d.state;
  assert.ok(S.multiplier >= 3, 'multiplier ' + S.multiplier);
  assert.ok(S.chainPoints > 0 && S.score === 0, 'chain unbanked while drifting');
  var mult = S.multiplier;
  for (var j = 0; j < 60 * 3; j++) d.update(driftCar(0, 22), 1 / 60);
  assert.ok(S.score > 0, 'chain banked');
  assert.equal(S.chainPoints, 0);
  assert.ok(S.lastBank && S.lastBank.multiplier === mult);
  for (var k = 0; k < 60 * 6; k++) d.update(driftCar(0, 22), 1 / 60);
  assert.ok(S.multiplier < mult, 'multiplier decays while idle');
});

T('drift: transitions add bonus; crashes and spins throw the chain away', function () {
  var d = C.createDriftScorer();
  for (var i = 0; i < 90; i++) d.update(driftCar(35, 22, 1), 1 / 60);
  for (var i2 = 0; i2 < 90; i2++) d.update(driftCar(35, 22, -1), 1 / 60);
  assert.ok(d.state.transitions >= 1);
  assert.ok(d.state.chainPoints > 0);
  d.update(driftCar(35, 22), 1 / 60, { crash: 'Wall' });
  assert.equal(d.state.chainPoints, 0);
  assert.equal(d.state.multiplier, 1);
  assert.equal(d.state.crashes, 1);
  assert.equal(d.state.score, 0, 'lost chain is not banked');
  for (var j = 0; j < 120; j++) d.update(driftCar(35, 22), 1 / 60);
  d.update(driftCar(150, 22), 1 / 60);
  assert.equal(d.state.crashes, 2, 'spin counts as a crash');
  for (var k = 0; k < 60; k++) d.update(driftCar(35, 22), 1 / 60);
  var before = d.state.score;
  d.finish();
  assert.ok(d.state.score > before, 'finish banks the open chain');
});

T('drift: proximity + off-track rules', function () {
  var a = C.createDriftScorer({ multiplierMax: 1 }), b = C.createDriftScorer({ multiplierMax: 1 });
  for (var i = 0; i < 120; i++) { a.update(driftCar(35, 22), 1 / 60, { wallDist_m: 0.8 }); b.update(driftCar(35, 22), 1 / 60, { wallDist_m: 5 }); }
  assert.ok(a.total() > b.total() * 1.3);
  b.update(driftCar(35, 22), 1 / 60, { offTrack: true });
  assert.equal(b.state.chainPoints, 0);
});

/* ------------------------------------------------------------------ sessions */
T('createChallengeSession returns an engine-compatible cfg + evaluate hooks', function () {
  var s = C.createChallengeSession('launch-control', baseBuild());
  assert.equal(s.cfg.mode, 'time-trial');
  assert.equal(s.cfg.opponents, 0);
  assert.equal(s.cfg.trackId, 'challenge-strip');
  assert.ok(s.cfg.extras && s.cfg.extras.challenge && typeof s.cfg.extras.challenge.evaluate === 'function');
  assert.equal(typeof s.cfg.extras.onEvent, 'function');
  ['carCreated', 'preStep', 'postStep', 'modifiers'].forEach(function (h) { assert.equal(typeof s.cfg.hooks[h], 'function'); });
  var out = s.evaluate({ t: 0, phase: 'grid', cars: [] });
  assert.ok('score' in out && 'medal' in out && 'done' in out);
  assert.equal(out.done, false);
  assert.throws(function () { C.createChallengeSession('nope'); });
  var d = s.describe();
  assert.equal(d.medals.length, 4);
});

T('drift trial disables traction control; elk hooks cut throttle during an attempt', function () {
  var s = C.createChallengeSession('drift-trial', baseBuild());
  assert.equal(s.cfg.assists.tc, false);
  var e = C.createChallengeSession('elk-test', baseBuild());
  e.state.k.attempt = { n: 1, entryKph: 70, void: false };
  var inp = { throttle: 1 };
  e.hooks.preStep({ isPlayer: true }, inp, 1 / 120);
  assert.equal(inp.throttle, 0);
  var ai = { throttle: 1 };
  e.hooks.preStep({ isPlayer: false }, ai, 1 / 120);
  assert.equal(ai.throttle, 1);
});

T('slalom course: alternating pylons and gates; braking box placed past the board', function () {
  var s = C.createChallengeSession('slalom', baseBuild());
  var py = s.course.cones.filter(function (c) { return c.role === 'slalom'; });
  assert.equal(py.length, 10);
  for (var i = 1; i < py.length; i++) { assert.equal(py[i].passSide, -py[i - 1].passSide); assert.ok(Math.abs(py[i].s - py[i - 1].s - 24) < 1e-6); }
  assert.ok(s.course.gates.some(function (g) { return g.type === 'finish'; }));
  var b = C.createChallengeSession('braking-zone', baseBuild());
  assert.ok(b.info.targetS > b.info.boardS);
  assert.ok(b.course.zones.some(function (z) { return z.type === 'box'; }));
  var e = C.createChallengeSession('elk-test', baseBuild());
  assert.equal(e.info.lanes.length, 3);
  assert.ok(e.info.lanes[1].c > e.info.lanes[0].c, 'avoidance lane is offset left');
});

if (REAL) {
  T('engine run: launch control completes with a time near the reference', function () {
    var r = runChallenge('license-b1', baseBuild(), { maxSeconds: 40 });
    assert.ok(r.out.done && !r.out.failed, JSON.stringify(r.out.reason));
    assert.ok(r.out.score > 2 && r.out.score < 20);
    var res = r.session.result();
    assert.equal(res.id, 'license-b1');
    assert.ok(res.stats.splits[60] > 0 && res.stats.splits[60] < res.score);
  });

  T('engine run: driving straight through the slalom hits cones and misses gates', function () {
    var r = runChallenge('slalom', baseBuild(), { autopilot: false, maxSeconds: 60, input: function () { return { throttle: 0.55, brake: 0, steer: 0 }; } });
    assert.ok(r.out.done);
    var res = r.session.result();
    assert.ok(res.coneHits > 0 || res.stats.missedGates > 0, 'penalties applied');
  });

  T('engine run: top speed run measures vmax', function () {
    var r = runChallenge('top-speed-run', baseBuild(), { maxSeconds: 150, input: function () { return { throttle: 1, brake: 0, steer: 0 }; } });
    assert.ok(r.out.done);
    assert.ok(r.out.score > 150);
  });

  T('overlay draws for every kind (camera + radar) without throwing', function () {
    ['launch-control', 'braking-zone', 'slalom', 'elk-test', 'drift-trial', 'top-speed-run', 'hot-lap-little-anvil'].forEach(function (id) {
      var s = C.createChallengeSession(id, baseBuild());
      var es = s.createEngineSession();
      es.setPlayerAutopilot && es.setPlayerAutopilot(true);
      var snap;
      for (var i = 0; i < 60 * 8; i++) { es.update(1 / 60); snap = es.snapshot(); s.evaluate(snap); }
      var car = snap.cars.filter(function (c) { return c.isPlayer; })[0];
      var ctx = mockCtx();
      s.drawOverlay(ctx, snap);                                           // radar inset
      s.drawOverlay(ctx, snap, { camera: { x: car.x, y: car.y, scale: 6, up: car.heading } });
      C.drawOverlay(ctx, snap, s);
      C.drawOverlay(ctx, snap, s.state);
      C.drawOverlay(ctx, snap, s.cfg.extras.challenge);
      assert.ok(ctx.calls.fillText.length > 5, id + ' drew text');
      s.abort('test');
      C.drawOverlay(ctx, snap, s);                                        // result banner
    });
    var d = C.createDriftScorer();
    for (var k = 0; k < 120; k++) d.update(driftCar(35, 22), 1 / 60);
    var ctx2 = mockCtx();
    C.drawOverlay(ctx2, null, d.state);
    assert.ok(ctx2.calls.fillText.some(function (t) { return /×/.test(t); }), 'stand-alone drift widget');
  });
}

/* ------------------------------------------------------------------ progress */
T('recordResult: best, medals, improvement-only rewards, licences and gating', function () {
  var P = { credits: 0, xp: 0, level: 1, stats: {} };
  assert.equal(C.isUnlocked(P, 'license-b1'), true);
  assert.equal(C.isUnlocked(P, 'license-a1'), false);
  assert.equal(C.isUnlocked(P, 'elk-test'), false);
  assert.ok(/B Licence/.test(C.lockReason(P, 'elk-test')));
  var r1 = C.recordResult(P, 'license-b1', { score: 6.0, medal: 'silver', passed: true, failed: false });
  assert.equal(r1.medal, 'silver'); assert.ok(r1.rewards.credits > 0); assert.ok(r1.improved);
  var r2 = C.recordResult(P, 'license-b1', { score: 6.5, medal: 'bronze', passed: true, failed: false });
  assert.equal(r2.improved, false); assert.equal(r2.medal, 'silver'); assert.equal(r2.rewards.credits, 0, 'no repeat payout');
  var r3 = C.recordResult(P, 'license-b1', { score: 5.1, medal: 'gold', passed: true, failed: false });
  assert.equal(r3.rewards.credits, C.rewardsFor('license-b1', 'gold', 'silver').credits);
  assert.equal(C.bestFor(P, 'license-b1').score, 5.1);
  assert.equal(C.bestFor(P, 'license-b1').attempts, 3);
  C.recordResult(P, 'license-b2', { score: 700, medal: 'silver', passed: true });
  var last = C.recordResult(P, 'license-b3', { score: 14, medal: 'bronze', passed: true });
  assert.ok(last.licenseEarned && last.licenseEarned.id === 'B');
  assert.ok(P.licenses.B.earnedAt);
  assert.ok(C.hasLicense(P, 'B'));
  assert.equal(C.isUnlocked(P, 'elk-test'), true);
  assert.equal(C.isUnlocked(P, 'license-a1'), true);
  assert.equal(C.isUnlocked(P, 'license-s1'), false);
  var st = C.licenseStatus(P);
  assert.equal(st[0].earned, true); assert.equal(st[0].passed, 3);
  assert.equal(st[1].available, true); assert.equal(st[2].available, false);
  var fail = C.recordResult(P, 'drift-trial', { score: 12345, medal: 'bronze', passed: true, kind: 'drift' });
  assert.ok(fail.rewards.credits > 0);
  assert.equal(P.stats.driftScoreBest, 12345);
  var hib = C.recordResult(P, 'license-b1', { score: null, medal: null, failed: true });
  assert.equal(hib.medal, 'gold', 'a failed run keeps the best medal');
});

T('session.commit into a plain profile applies rewards', function () {
  var P = { credits: 1000, xp: 0, level: 1, stats: {} };
  var s = C.createChallengeSession('license-b1', baseBuild());
  s.state.score = s.medals.gold;     // pretend a gold run
  s.state.complete('test');
  var res = s.result();
  assert.equal(res.medal, 'gold');
  var out = s.commit({ profile: P, achievements: false });
  assert.ok(out && out.rewards.credits > 0);
  assert.equal(P.credits, 1000 + out.rewards.credits);
  assert.equal(C.bestFor(P, 'license-b1').medal, 'gold');
});

T('overview lists every challenge with lock state', function () {
  var ov = C.overview({ level: 1 });
  assert.equal(ov.length, C.all().length);
  assert.ok(ov.some(function (o) { return !o.unlocked; }));
});

T('recordResult: challengesCompleted counts first completion even after a failed attempt', function () {
  var P = { stats: {} };
  C.recordResult(P, 'license-b1', { failed: true });
  assert.equal(P.stats.challengesCompleted, undefined);
  C.recordResult(P, 'license-b1', { score: 5, medal: 'gold', passed: true });
  assert.equal(P.stats.challengesCompleted, 1);
  C.recordResult(P, 'license-b1', { score: 4.9, medal: 'gold', passed: true });
  C.recordResult(P, 'license-b1', { failed: true });
  assert.equal(P.stats.challengesCompleted, 1);
  // legacy record without the completed flag but with a medal is not re-counted
  var L = { stats: { challengesCompleted: 1 }, challenges: { 'license-b2': { best: 700, medal: 'silver', attempts: 1, passes: 1, history: [] } } };
  C.recordResult(L, 'license-b2', { score: 650, medal: 'silver', passed: true });
  assert.equal(L.stats.challengesCompleted, 1);
  assert.equal(L.challenges['license-b2'].completed, true);
});

T('cleanup: challenge tracks unregistered after the suite', function () {
  C.unregisterTracks();
  if (haveTracks) assert.ok(!CB.race.tracks.list.some(function (d) { return d.challenge; }));
});

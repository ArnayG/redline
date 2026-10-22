/* Drag racing sim (docs/DRAG-SPEC.md): tree timing + red lights, reaction measurement, staging beams, ET / trap / splits,
   burnout heat, shift windows, AI determinism, bracket rules, records, ghost codes, tournaments, stock-car ETs. */
'use strict';
var assert = require('assert');
var path = require('path'), fs = require('fs');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(function (f) { require(path.join(root, f)); });
// index.html order (the first model registered per body style is its default: tests/shapes-* check it)
['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van', 'pack-jdm', 'pack-usa', 'pack-exotic', 'pack-sport'].forEach(function (f) { require(path.join(root, 'js/shapes/models', f + '.js')); });
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/vehicle.js', 'js/drag/drag-strip.js', 'js/drag/drag-tree.js',
 'js/drag/drag-timing.js', 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js'].forEach(function (f) { require(path.join(root, f)); });
var CB = globalThis.CB, D = CB.drag, V = CB.race.vehicle;

var standalone = require.main === module || typeof globalThis.test !== 'function';
function test(name, fn) {
  if (!standalone) return globalThis.test('drag sim: ' + name, fn);
  try { fn(); console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function stock(id) { return CB.stock.build(id).build; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b + ' ±' + tol); }

/* ------------------------------------------------------------ tree */
test('pro tree: all ambers together, green 0.4 s later; sportsman counts down 0.5 s', function () {
  var T = D.tree, tr = T.create({ type: 'pro', seed: 5 });
  T.arm(tr, 10);
  assert.ok(tr.startT >= 10.6 && tr.startT <= 11.4, 'auto-start delay 0.6–1.4 s');
  near(tr.greenT[0] - tr.startT, 0.4, 1e-9); assert.strictEqual(tr.greenT[0], tr.greenT[1]);
  var L = T.lights(tr, tr.startT + 0.01, 0, { staged: true });
  assert.deepStrictEqual(L.amber, [true, true, true]); assert.ok(!L.green && L.stage);
  L = T.lights(tr, tr.greenT[0] + 0.001, 0, {}); assert.ok(L.green && !L.amber[0]);
  var sp = T.create({ type: 'sportsman', seed: 5 }); T.arm(sp, 0);
  near(sp.greenT[0] - sp.startT, 1.5, 1e-9);
  L = T.lights(sp, sp.startT + 0.6, 1, {}); assert.deepStrictEqual(L.amber, [true, true, false]);
  // seeded delay is deterministic
  var a = T.create({ seed: 9 }), b = T.create({ seed: 9 }); T.arm(a, 0); T.arm(b, 0); assert.strictEqual(a.greenT[0], b.greenT[0]);
});
test('bracket handicap: the slower dial gets its green first by the dial difference', function () {
  var tr = D.tree.create({ type: 'pro', handicap: [0, 1.25] }); D.tree.arm(tr, 0);
  near(tr.greenT[1] - tr.greenT[0], 1.25, 1e-9);
});
test('red light: a lane that left before green shows red, never green; reaction = leave − green', function () {
  var T = D.tree, tr = T.create({ type: 'pro', seed: 1 }); T.arm(tr, 0);
  var g = tr.greenT[0];
  near(T.reaction(tr, 0, g + 0.012), 0.012, 1e-9);
  assert.ok(T.reaction(tr, 0, g - 0.03) < 0);
  T.foul(tr, 0, g - 0.03);
  var L = T.lights(tr, g + 0.5, 0, {}); assert.ok(L.red && !L.green);
  assert.ok(T.lights(tr, g + 0.5, 1, {}).green, 'the other side still gets its green');
});
test('decide: red loses, first red loses, quicker package wins, holeshot flagged', function () {
  var d = D.tree.decide;
  assert.strictEqual(d({ rt: -0.01, et: 10, red: true, redT: 1 }, { rt: 0.5, et: 13, finished: true }).winner, 1);
  assert.strictEqual(d({ rt: -0.05, et: 10, red: true, redT: 1 }, { rt: -0.01, et: 10, red: true, redT: 1.04 }).winner, 1, 'both red: first red loses');
  var r = d({ rt: 0.02, et: 11.0, finished: true }, { rt: 0.20, et: 10.9, finished: true });
  assert.strictEqual(r.winner, 0); assert.ok(r.holeshot); near(r.margin_s, 0.08, 1e-9);
  r = d({ rt: 0.1, et: 11.0, finished: true }, { rt: 0.1, et: 10.5, finished: true });
  assert.strictEqual(r.winner, 1); assert.ok(!r.holeshot);
});
test('bracket rules: breakout loses, both break out -> smaller breakout wins, else closest package', function () {
  var d = D.tree.decide, o = { bracket: true };
  var r = d({ rt: 0.05, et: 11.95, dial: 12.0, finished: true }, { rt: 0.3, et: 14.2, dial: 14.0, finished: true }, o);
  assert.strictEqual(r.winner, 1); assert.strictEqual(r.reason, 'breakout');
  r = d({ rt: 0.05, et: 11.95, dial: 12.0, finished: true }, { rt: 0.05, et: 13.80, dial: 14.0, finished: true }, o);
  assert.strictEqual(r.winner, 0, 'smaller breakout');
  r = d({ rt: 0.05, et: 12.10, dial: 12.0, finished: true }, { rt: 0.02, et: 14.05, dial: 14.0, finished: true }, o);
  assert.strictEqual(r.winner, 1); assert.strictEqual(r.reason, 'closer');
});

/* ------------------------------------------------------------ timing */
test('timing: clock starts at the rollout, splits interpolated, trap over the last 66 ft', function () {
  var T = D.timing, lt = T.createLane('quarter'), a = 8, t, x0 = 0.05;
  // constant-acceleration car staged at 0.05 m, released at t = 0
  for (t = 0; t <= 20 && !lt.finished; t += 1 / 120) { var x = x0 + 0.5 * a * t * t; T.update(lt, t, x, a * t); }
  var tLeave = Math.sqrt(2 * (0.29 - x0) / a);
  near(lt.tStart, tLeave, 2e-3, 'clock start');
  var et = Math.sqrt(2 * (402.336 - x0) / a) - tLeave;
  near(lt.et, et, 2e-4, 'ET');
  var tq = Math.sqrt(2 * (402.336 - x0) / a), tw = Math.sqrt(2 * (402.336 - 20.117 - x0) / a);
  near(lt.trap, 20.117 / (tq - tw), 0.01, 'trap');
  near(T.split(lt, 'ft60').t, Math.sqrt(2 * (18.288 - x0) / a) - tLeave, 2e-4, '60 ft');
  assert.strictEqual(lt.splits.length, 5);
});
test('speed races: 0–200 km/h splits by speed', function () {
  var T = D.timing, lt = T.createLane('dig'), a = 9;
  for (var t = 0; t < 20 && !lt.finished; t += 1 / 120) T.update(lt, t, 0.05 + 0.5 * a * t * t, a * t);
  assert.ok(lt.finished);
  near(lt.et, 200 / 3.6 / a - lt.tStart, 0.002);
});

/* ------------------------------------------------------------ burnout / launch / shifting */
test('burnout: a 3–4 s burnout reaches the ideal window, a long one overheats and costs grip', function () {
  var B = D.launch.burnout, surf = D.strip.surface('prepped');
  var b = B.create();
  assert.strictEqual(B.bonus(b, surf), 0);
  for (var t = 0; t < 3.5; t += 0.01) B.step(b, 0.01, { spinning: true, throttle: 1, rpmFrac: 0.8, powerFactor: 1.3, gain: 1 });
  assert.ok(b.temp >= 70 && b.temp <= 95, 'ideal after 3.5 s: ' + b.temp);
  near(B.bonus(b, surf), surf.maxBonus, 1e-9);
  for (t = 0; t < 6; t += 0.01) B.step(b, 0.01, { spinning: true, throttle: 1, rpmFrac: 0.9, powerFactor: 1.3, gain: 1 });
  assert.ok(b.overheated && B.bonus(b, surf) < 0, 'overheated: ' + b.temp);
  var c = { temp: 90 }; for (t = 0; t < 10; t += 0.1) B.step(c, 0.1, {}); assert.ok(c.temp < 90 && c.temp > 80, 'cools slowly');
});
test('launch sweet spot: a band inside the rev range; bogging below it is slower', function () {
  var p = V.fromBuild(stock('bmw-m3-e46'));
  var ss = D.launch.sweetSpot(p, { gripMult: 1.1 });
  assert.ok(ss.lo > p.idle && ss.hi < p.redline && ss.hi > ss.lo, JSON.stringify(ss));
  assert.ok(D.launch.sixtyAt(p, p.idle + 600, { gripMult: 1.1 }) > ss.t60 + 0.05, 'idle launch bogs');
  var ev = D.launch.sweetSpot(V.fromBuild(stock('tesla-model-s-2021')), { gripMult: 1 });
  assert.ok(ev.ev);
});
test('shift grading against the optimal upshift point', function () {
  var p = V.fromBuild(stock('honda-civic-type-r-fl5'));
  var opt = D.launch.optimalShift(p, 2);
  assert.strictEqual(D.launch.grade(opt + 50, 2, p, 0), 'perfect');
  assert.strictEqual(D.launch.grade(opt - 0.045 * p.redline, 2, p, 0), 'good');
  assert.strictEqual(D.launch.grade(opt - 0.12 * p.redline, 2, p, 0), 'early');
  assert.strictEqual(D.launch.grade(opt + 0.1 * p.redline, 2, p, 0), 'late');
  assert.strictEqual(D.launch.grade(opt, 2, p, 0.3), 'late', 'bouncing off the limiter');
  var sl = D.launch.shiftLight(opt, 2, p); assert.ok(sl.level === 1 && sl.flash);
  assert.ok(D.launch.shiftLight(opt - 3000, 2, p).level === 0);
});
test('N2O adds power above 2500 rpm only; quick tune writes Garage fields', function () {
  var p = V.fromBuild(stock('ford-mustang-gt-s650')), n = D.launch.nitrousParams(p, 150);
  assert.ok(V.torqueAt(n, 5000) > V.torqueAt(p, 5000) + 100);
  near(V.torqueAt(n, 2000), V.torqueAt(p, 2000), 1e-9);
  var b = D.launch.tuneBuild(stock('ford-mustang-gt-s650'), { finalDrive: 4.1, gearSpread: 1.1 });
  assert.strictEqual(b.transmission.finalDrive, 4.1);
  assert.ok(Array.isArray(b.transmission.ratios) && b.transmission.ratios.length === 6);
  var p2 = V.fromBuild(b); assert.ok(p2.ratios[0] * p2.finalDrive > p.ratios[0] * p.finalDrive, 'shorter first gear overall');
});

/* ------------------------------------------------------------ session */
function heads(a, b, o) {
  return Object.assign({ seed: 3, distanceId: 'quarter', lanes: [{ kind: 'ai', name: 'A', build: stock(a), difficulty: 'pro' }, { kind: 'ai', name: 'B', build: stock(b), difficulty: 'pro' }] }, o || {});
}
test('AI heads-up: burnout, stage, launch, splits, finish, decision; deterministic per seed', function () {
  var r1 = D.session.simulate(heads('bmw-m4-g82', 'dodge-challenger-srt-hellcat'));
  var r2 = D.session.simulate(heads('bmw-m4-g82', 'dodge-challenger-srt-hellcat'));
  assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2));
  r1.lanes.forEach(function (l) {
    assert.ok(l.et > 9.5 && l.et < 13, 'ET ' + l.et); assert.ok(l.trap * 2.237 > 110 && l.trap * 2.237 < 140, 'trap');
    assert.ok(l.splits.every(function (s) { return s.t > 0; })); assert.ok(l.burnout.temp > 50, 'did a burnout');
    assert.strictEqual(l.shifts.perfect + l.shifts.good + l.shifts.early + l.shifts.late >= 3, true, 'manual AI shifts graded');
  });
  assert.ok(r1.winner === 0 || r1.winner === 1);
  var r3 = D.session.simulate(heads('bmw-m4-g82', 'dodge-challenger-srt-hellcat', { seed: 4 }));
  assert.notStrictEqual(JSON.stringify(r1), JSON.stringify(r3));
});
test('AI ladder difficulty: alien reacts faster than rookie (median of seeds)', function () {
  function rts(diff) {
    var out = [];
    for (var s = 1; s <= 6; s++) {
      var r = D.session.simulate({ seed: s, distanceId: 'eighth', skipBurnout: true, lanes: [{ kind: 'ai', build: stock('honda-civic-type-r-fl5'), difficulty: diff }, { kind: 'none' }] });
      out.push(r.lanes[0].rt);
    }
    out.sort(function (a, b) { return a - b; }); return out[3];
  }
  var a = rts('alien'), r = rts('rookie');
  assert.ok(a < 0.1 && r > 0.2 && a < r, 'alien ' + a + ' rookie ' + r);
});
function playerRun(o) {
  // scripted human with real-ish inputs: burnout, creep, stage, rev, release relative to the green, manual shifts
  o = o || {};
  var S = D.session.create({ seed: 8, distanceId: o.dist || 'eighth', lanes: [{ kind: 'player', build: stock(o.car || 'ford-mustang-gt-s650'), assists: { autoShift: !!o.auto } }, { kind: 'none' }] });
  var phase = 'burn', t = 0, shifted = 0;
  for (var i = 0; i < 120 * 90 && S.phase() !== 'done'; i++) {
    var v = S.view(0), inp = { throttle: 0, brake: 0 };
    t = S.time();
    if (phase === 'burn') { inp = { throttle: 1, brake: 1 }; if (t > (o.burn || 3)) phase = 'creep'; }
    else if (phase === 'creep') { inp = D.ai.stageControl(v, false); if (v.staged && Math.abs(v.vx) < 0.05) phase = 'held'; }
    else if (phase === 'held') {
      inp = { brake: 1, throttle: v.rpm < (v.launchBand.lo + v.launchBand.hi) / 2 ? 1 : 0 };
      if (v.greenT != null && t >= v.greenT + (o.release || 0.05)) phase = 'go';
    } else {
      inp = { throttle: 1, brake: 0 };
      if (!o.auto && v.rpm > v.optShift - 30 && !v.shifting && v.gear < v.maxGear) { inp.shiftUp = (i % 2 === 0); }
    }
    S.update(1 / 120, inp);
  }
  return { S: S, r: S.results() };
}
test('player run: burnout heats the tyres, staging, launch from the hold, RT measured from green, manual shifts', function () {
  var o = playerRun({ release: 0.05 }), l = o.r.lanes[0];
  assert.ok(!l.red, 'no red light'); assert.ok(l.rt > 0.05 && l.rt < 0.6, 'RT ' + l.rt);
  assert.ok(l.et > 6.5 && l.et < 9, '1/8 ET ' + l.et);
  assert.ok(l.burnout.time > 2.5 && l.burnout.temp > 55, 'burnout ' + JSON.stringify(l.burnout));
  assert.ok(l.launch.rpm > 1500, 'launched from the held revs');
  assert.ok(l.shifts.perfect + l.shifts.good >= 1, JSON.stringify(l.shifts));
  assert.strictEqual(o.r.winner, 0);
});
test('player red light: releasing well before the green', function () {
  var o = playerRun({ release: -0.35 }), l = o.r.lanes[0];
  assert.ok(l.red && l.rt < 0, 'red, rt ' + l.rt);
  assert.strictEqual(o.r.winner, null);
});
test('staging beams: pre-stage then stage, deep staging turns the pre-stage bulb off', function () {
  var S = D.session.create({ seed: 2, skipBurnout: true, lanes: [{ kind: 'player', build: stock('bmw-m3-e46') }, { kind: 'none' }] });
  var seen = {};
  for (var i = 0; i < 120 * 20; i++) {
    var v = S.view(0);
    S.update(1 / 120, D.ai.stageControl(v, true));
    S.snapshot().events.forEach(function (e) { seen[e.type] = (seen[e.type] || 0) + 1; });
    if (v.deep && Math.abs(v.vx) < 0.01) break;
  }
  assert.ok(seen.prestage && seen.stage && seen.deep, JSON.stringify(seen));
  var sn = S.snapshot();
  assert.ok(sn.lanes[0].deep && sn.lanes[0].staged);
  assert.ok(!sn.tree.lanes[0].preStage && sn.tree.lanes[0].stage, 'deep: pre-stage bulb out');
});
test('ghost: share code round trip and the ghost lane runs its trace', function () {
  var o = playerRun({ release: 0.05 });
  var run = o.S.ghostRun(0); assert.ok(run && run.trace.length > 50);
  var code = D.timing.encodeGhost(Object.assign(run, { name: 'Rosé' }));
  assert.ok(/^RLD1[A-Za-z0-9+/]+$/.test(code) && code.length < 2400, code.length);
  var g = D.timing.decodeGhost(code);
  assert.strictEqual(g.name, 'Rosé'); near(g.et, run.et, 0.001);
  assert.strictEqual(D.timing.decodeGhost('nonsense'), null);
  var r = D.session.simulate({ seed: 1, distanceId: 'eighth', lanes: [{ kind: 'ai', build: stock('mazda-mx5-nd'), difficulty: 'pro' }, { kind: 'ghost', ghost: g, build: stock('ford-mustang-gt-s650') }] });
  near(r.lanes[1].et, run.et, 0.03, 'ghost ET'); near(r.lanes[1].rt, run.rt, 0.03, 'ghost RT');
});
test('records: personal bests per car + distance', function () {
  var R = D.timing.records; R.clear();
  var k = R.carKey(stock('bmw-m4-g82'));
  assert.ok(R.submit(k, 'quarter', { et: 11.5, rt: 0.1, trap: 54 }).pb);
  assert.ok(!R.submit(k, 'quarter', { et: 11.7, rt: 0.05, trap: 53 }).pb);
  var b = R.best(k, 'quarter'); assert.strictEqual(b.et, 11.5); assert.strictEqual(b.runs, 2); assert.strictEqual(b.bestRt, 0.05);
  assert.ok(!R.submit(k, 'quarter', { et: 9, red: true }).pb, 'red-light passes never count');
  assert.notStrictEqual(R.carKey(D.launch.tuneBuild(stock('bmw-m4-g82'), { finalDrive: 4.2 })), k, 'tuned build = new key');
});
test('tournament: 8-car single elimination, AI heats deterministic, champion crowned', function () {
  var T = D.ai.tournament;
  var t = T.create({ size: 8, seed: 4, entrants: [{ id: 'me', name: 'You', isPlayer: true, model: 'bmw-m4-g82' }] });
  assert.strictEqual(t.entrants.length, 8); assert.strictEqual(t.rounds.length, 3);
  var sim = function (a, b, seed) { return { winner: (seed + a.name.length + b.name.length) % 2 }; };
  T.playAi(t, sim);
  var p = T.pending(t); assert.ok(p.player && p.round === 0);
  T.record(t, p.round, p.match, 0);
  T.playAi(t, sim);
  p = T.pending(t); assert.ok(p.player && p.round === 1);
  T.record(t, 1, p.match, 0); T.playAi(t, sim);
  p = T.pending(t); T.record(t, 2, 0, t.entrants[t.rounds[2][0].a].isPlayer ? 0 : 1);
  assert.ok(T.champion(t).isPlayer);
  var t2 = T.create({ size: 8, seed: 4, entrants: [{ id: 'me', name: 'You', isPlayer: true }] });
  assert.deepStrictEqual(t2.entrants.map(function (e) { return e.id; }), t.entrants.map(function (e) { return e.id; }));
});
test('rival ladder: 10 rivals with stock cars, slow to fast; beating unlocks the next', function () {
  var L = D.ai.ladder; L.reset();
  assert.strictEqual(L.RIVALS.length, 10);
  L.RIVALS.forEach(function (r) { assert.ok(D.ai.rivalBuild(r), r.model); });
  assert.strictEqual(L.next(), 0); assert.ok(!L.unlocked(null, L.RIVALS[2].id));
  L.beat(L.RIVALS[0].id); assert.strictEqual(L.next(), 1); assert.ok(L.unlocked(null, L.RIVALS[1].id));
});
test('stock cars on the street surface: 1/4-mile ETs within 8 % of the real figures', function () {
  var real = { 'honda-civic-type-r-fl5': 13.4, 'chevrolet-camaro-zl1-2019': 11.4, 'porsche-911-992': 11.3, 'bugatti-chiron': 9.4 };
  Object.keys(real).forEach(function (id) {
    var r = D.session.simulate({ seed: 2, surface: 'street', skipBurnout: true, distanceId: 'quarter', lanes: [{ kind: 'ai', build: stock(id), difficulty: 'alien' }, { kind: 'none' }] });
    var et = r.lanes[0].et;
    assert.ok(Math.abs(et - real[id]) / real[id] < 0.08, id + ' ET ' + et + ' vs ' + real[id]);
  });
});
test('street venue: flag start, AI line up without rolling through, the race finishes', function () {
  var r = D.session.simulate(heads('dodge-challenger-srt-hellcat', 'nissan-gtr-r35', { venue: 'street' }));
  assert.strictEqual(r.treeType, 'flag');
  r.lanes.forEach(function (l) { assert.ok(!l.red, 'no roll-through red'); assert.ok(l.et > 9 && l.et < 13, 'ET ' + l.et); });
  assert.ok(r.winner === 0 || r.winner === 1);
});
test('roll race 60–200 km/h and dig 0–200 km/h finish with speed splits', function () {
  ['roll', 'dig'].forEach(function (id) {
    var r = D.session.simulate(heads('chevrolet-corvette-c8', 'bmw-m4-g82', { distanceId: id }));
    r.lanes.forEach(function (l) { assert.ok(l.et > 4 && l.et < 25, id + ' ET ' + l.et); assert.ok(l.splits.every(function (s) { return s.t > 0; })); });
  });
});

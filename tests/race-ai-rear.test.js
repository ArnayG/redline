/* Node tests: race AI + vehicle dynamics with rear-engined (911), mid-engined, FWD, AWD and heavy cars.
   Run standalone (`node tests/race-ai-rear.test.js`) or via tests/run.js.

   The default build is a rear-engined 911 Carrera S (65 % rear weight, front-biased aero, driven rear axle):
   the rear saturates first, which the AI's single lumped grip figure used to hide (it ran 911s off at
   forge-speedway / gruenwald-ring / circle-lab). These tests pin the axle-aware model and drive real laps and
   6-car packs with a spread of layouts on the hardest tracks. */
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
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js',
  'js/race/drift/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/drift/assist.js'].forEach(tryLoad);
var CB = globalThis.CB;

var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  name = 'race-ai-rear: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

var V = CB.race && CB.race.vehicle, AI = CB.race && CB.race.ai, T = CB.race && CB.race.tracks, D = CB.data;
var ready = V && AI && AI._internal && T && typeof T.build === 'function' && D && typeof D.defaultBuild === 'function' &&
  typeof D.presetBuild === 'function' && CB.physics && typeof CB.physics.compute === 'function';
if (!ready) {
  console.log('  (race-ai-rear: modules missing — skipped)');
  module.exports = [];
  return;
}
var I = AI._internal;

/* ------------------------------------------------------------------ fixtures */

function buildOf(id) {
  if (id === 'default') return D.defaultBuild();
  if (id === 'reference') return (D.referenceBuild || D.defaultBuild)();
  var b = D.presetBuild(id);
  return CB.state && CB.state.normalize ? CB.state.normalize(b) || b : b;
}
function paramsOf(b) { return V.fromBuild(b, CB.physics.compute(b)); }
var geoms = {};
function geomOf(id) {
  if (geoms[id]) return geoms[id];
  var def = (T.get && T.get(id)) || (T.list || []).filter(function (d) { return d.id === id; })[0];
  if (!def && CB.race.tracksExtra && CB.race.tracksExtra.get) def = CB.race.tracksExtra.get(id);
  if (!def && CB.race.drift && CB.race.drift.tracks) def = CB.race.drift.tracks.get(id);
  if (!def) return null;
  return (geoms[id] = def.samples ? def : T.build(def));
}
function poseOn(geom, s, lat) {
  var A = I.adaptGeom(geom), i = Math.round(s / A.ds) % A.n;
  return { x: A.xs[i] - Math.sin(A.hs[i]) * (lat || 0), y: A.ys[i] + Math.cos(A.hs[i]) * (lat || 0), heading: A.hs[i] };
}

/** Real-vehicle sim: every car AI-driven; off-track = centre beyond asphalt + kerb (riding kerbs is legal). */
function simulate(geom, cars, tMax, untilLaps) {
  var A = I.adaptGeom(geom), dt = 1 / 120, t = 0, minDist = Infinity;
  var E = cars.map(function (c) {
    return { id: c.opponent.id, driver: AI.createDriver(c.opponent, geom, c.params), params: c.params,
      state: V.createState(c.params, c.pose), hint: -1, laps: 0, prevS: null, offT: 0, maxOff: 0, progress: 0, maxBeta: 0 };
  });
  while (t < tMax) {
    var snap = E.map(function (e) {
      return { id: e.id, x: e.state.x, y: e.state.y, heading: e.state.heading, speed: e.state.speed, vx: e.state.vx, vy: e.state.vy,
        s: e.prevS || 0, lap: e.laps, length_m: 4.5, width_m: 1.9 };
    });
    var ctx = { t: t, phase: t < 0.5 ? 'countdown' : 'racing', countdown: { lightsOut: t >= 0.5 }, cars: snap, weather: 'dry' };
    E.forEach(function (e) {
      var inp = e.driver.control(e.state, ctx, dt);
      var pr = I.projectLocal(A, e.state.x, e.state.y, e.hint);
      e.hint = pr.index;
      var ex = Math.abs(pr.lateral) - A.hw[pr.index] - (pr.lateral > 0 ? A.kerbL[pr.index] : A.kerbR[pr.index]);
      if (ex > e.maxOff) e.maxOff = ex;
      if (ex > 0) e.offT += dt;
      if (e.state.speed > 8) e.maxBeta = Math.max(e.maxBeta, Math.abs(e.state.beta || 0));
      V.step(e.params, e.state, inp, dt, { gripMult: ex > 0.5 ? 0.6 : 1, wet: false });
      if (e.prevS !== null) {
        var d = pr.s - e.prevS;
        if (d < -A.length / 2) { e.laps++; d += A.length; } else if (d > A.length / 2) { e.laps--; d -= A.length; }
        e.progress += d;
      }
      e.prevS = pr.s;
    });
    for (var a = 0; a < E.length; a++) for (var b = a + 1; b < E.length; b++) {
      var dd = Math.hypot(E[a].state.x - E[b].state.x, E[a].state.y - E[b].state.y);
      if (t > 3 && dd < minDist) minDist = dd;
    }
    t += dt;
    if (untilLaps && E.every(function (e) { return e.laps >= untilLaps; })) break;
  }
  return { entries: E, t: t, minDist: minDist, length: A.length };
}
function solo(buildId, trackId) {
  var g = geomOf(trackId), b = buildOf(buildId), p = paramsOf(b), A = I.adaptGeom(g);
  var opp = { id: 'x', name: 'Test', skill: 0.9, consistency: 0.95, aggression: 0.6, reaction_s: 0.2, seed: 11, build: b };
  var r = simulate(g, [{ opponent: opp, params: p, pose: poseOn(g, 10, 0) }], Math.max(150, A.length / 10), 1);
  return { e: r.entries[0], t: r.t, length: r.length };
}

/* ------------------------------------------------------------------ vehicle physics */

test('vehicle: metrics grip is not load-sensitised twice (static axle load is the reference)', function () {
  var b = buildOf('default'), m = CB.physics.compute(b), p = V.fromBuild(b, m);
  // physics.js quotes gripFront / gripRear at the static wheel load of each axle -> that is the reference load
  assert.ok(Math.abs(p.fzRefF - p.mass * 9.81 * p.weightFront / 2) < 1, 'front reference = static front wheel load');
  assert.ok(Math.abs(p.fzRefR - p.mass * 9.81 * (1 - p.weightFront) / 2) < 1, 'rear reference = static rear wheel load');
  assert.ok(p.fz0R > p.fz0F, 'wider rear tyre: flatter load sensitivity (' + p.fz0F.toFixed(0) + ' / ' + p.fz0R.toFixed(0) + ' N)');
  // a car standing still: the in-sim tyre mu equals the quoted mu on both axles
  var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 0 });
  V.step(p, s, { throttle: 0, brake: 0, steer: 0 }, 1 / 120, { gripMult: 1 });
  assert.ok(Math.abs(s.wheels[0]._mu - p.muF) < 0.01 && Math.abs(s.wheels[2]._mu - p.muR) < 0.01,
    'static mu ' + s.wheels[0]._mu.toFixed(3) + '/' + s.wheels[2]._mu.toFixed(3) + ' vs quoted ' + p.muF + '/' + p.muR);
});

test('vehicle: a rear engine raises yaw inertia (mass behind the rear axle), a mid engine lowers it', function () {
  function di(b) { var p = paramsOf(b); return (p.Iz - p.mass * p.track * p.track * 0.035) / (p.mass * p.a * p.b * 1.02); }
  var rear = buildOf('default'), front = buildOf('default'), mid = buildOf('default');
  front.engine.position = 'front'; mid.engine.position = 'mid';
  var dR = di(rear), dF = di(front), dM = di(mid);
  assert.ok(dR > 1.05 && dF > 0.97 && dF < 1.03 && dM < 0.9, 'dynamic index rear ' + dR.toFixed(2) + ' front ' + dF.toFixed(2) + ' mid ' + dM.toFixed(2));
});

/* ------------------------------------------------------------------ AI capability model */

test('AI limits: the 911 is rear-limited (oversteer balance), the front-engined reference is front-limited', function () {
  var L9 = AI.estimateLimits(paramsOf(buildOf('default')), buildOf('default'));
  var LR = AI.estimateLimits(paramsOf(buildOf('reference')), buildOf('reference'));
  assert.ok(L9.balTable && LR.balTable, 'axle balance tables');
  var b9 = L9.balTable[9].bal, bR = LR.balTable[3].bal;   // 45 m/s, 15 m/s
  assert.ok(b9 < 1, '911 rear/front lateral capacity ' + b9.toFixed(3) + ' < 1');
  assert.ok(bR > 1, 'reference rear/front ' + bR.toFixed(3) + ' > 1');
  // the axle-limited ay never exceeds either axle
  L9.balTable.forEach(function (r) { assert.ok(r.ay <= r.ayF + 1e-9 && r.ay <= r.ayR + 1e-9); });
});

test('AI limits: braking plan respects the brake hardware ceiling (high-downforce cars)', function () {
  var p = paramsOf(buildOf('le-mans-hybrid')), L = AI.estimateLimits(p, buildOf('le-mans-hybrid'));
  assert.ok(isFinite(L.brakeHW) && L.brakeHW > 5 && L.brakeHW < p.brakeForceMax / p.mass + 1e-9, 'brakeHW ' + L.brakeHW);
});

test('AI limits: understeer gradient from the axle stiffnesses (rear-biased aero understeers at speed)', function () {
  var L = AI.estimateLimits(paramsOf(buildOf('le-mans-hybrid')), buildOf('le-mans-hybrid'));
  assert.ok(L.usK && L.usK.length > 10);
  assert.ok(L.usK[14] > L.usK[2], 'K grows with speed for a rear-biased aero map (' + L.usK[2].toExponential(2) + ' -> ' + L.usK[14].toExponential(2) + ')');
});

test('AI profile: an oversteer-limited car plans fast corners with an extra stability margin', function () {
  var g = geomOf('gruenwald-ring'), b = buildOf('default'), p = paramsOf(b), A = I.adaptGeom(g);
  var L = AI.estimateLimits(p, b), Ln = Object.assign({}, L, { balTable: null });   // same car, balance hidden
  var with_ = I.internalProfile(A, L, 1, 0.9), without = I.internalProfile(A, Ln, 1, 0.9), n = 0, slower = 0;
  for (var i = 0; i < A.n; i++) {
    if (without[i] < 40 || Math.abs(A.lineK[i]) < 0.0015) continue;   // fast corners (> 144 km/h)
    n++; if (with_[i] < without[i] * 0.985) slower++;
  }
  assert.ok(n > 20 && slower / n > 0.7, 'fast-corner samples planned slower: ' + slower + ' / ' + n);
});

/* ------------------------------------------------------------------ real laps: layouts x hardest tracks */

var PRESETS = [
  ['track-weapon', 'mid-engined 718'], ['alpine-featherweight', 'mid-engined A110'], ['huracan-evo', 'mid AWD hypercar'],
  ['jesko-attack', 'mid RWD hypercar'], ['le-mans-hybrid', 'high-downforce hybrid hypercar'], ['hot-hatch', 'FWD hot hatch'],
  ['r34-godzilla', 'AWD R34'], ['overland', 'heavy SUV'],
];
var HARD = ['gruenwald-ring', 'circle-lab', 'forge-speedway'];
HARD.forEach(function (tid) {
  if (!geomOf(tid)) return;
  PRESETS.concat([['default', 'rear-engined 911']]).forEach(function (pc) {
    test('real lap: ' + pc[1] + ' (' + pc[0] + ') on ' + tid + ' stays on track at a plausible pace', function () {
      var r = solo(pc[0], tid), e = r.e, avg = r.length / r.t * 3.6;
      if (standalone) console.log('       ' + pc[0] + ' @ ' + tid + ': lap ' + r.t.toFixed(1) + ' s (' + avg.toFixed(0) + ' km/h), off ' + e.offT.toFixed(2) + ' s / ' + e.maxOff.toFixed(2) + ' m, max beta ' + (e.maxBeta * 57.3).toFixed(0) + ' deg');
      assert.ok(e.laps >= 1, 'completed the lap (progress ' + e.progress.toFixed(0) + ' / ' + r.length.toFixed(0) + ' m)');
      assert.ok(e.offT < 1.5, 'off-track time ' + e.offT.toFixed(2) + ' s');
      assert.ok(e.maxOff < 0.5, 'max excess beyond the kerb ' + e.maxOff.toFixed(2) + ' m');
      assert.ok(e.maxBeta < 0.35, 'no slide / spin (max body slip ' + (e.maxBeta * 57.3).toFixed(0) + ' deg)');
      assert.ok(avg > 55 && avg < 270, 'plausible average speed ' + avg.toFixed(0) + ' km/h');
    });
  });
});

test('real laps: the 441 hp 911 and the 645 hp reference coupe lap within 12 % of each other', function () {
  ['forge-ring', 'gruenwald-ring'].forEach(function (tid) {
    var a = solo('default', tid), b = solo('reference', tid);
    var ratio = a.t / b.t;
    assert.ok(ratio > 0.88 && ratio < 1.12, tid + ': 911 ' + a.t.toFixed(1) + ' s vs reference ' + b.t.toFixed(1) + ' s');
  });
});

/* ------------------------------------------------------------------ 6-car packs */

function pack(buildId, tid, field, seed, tMax) {
  var g = geomOf(tid), grid = AI.createGrid(buildOf(buildId), { count: 6, difficulty: 'pro', field: field, seed: seed });
  var slots = g.gridSlots || [];
  return simulate(g, grid.map(function (o, k) {
    var sl = slots[k] || poseOn(g, 10 + k * 12, k % 2 ? 2.5 : -2.5);
    return { opponent: o, params: paramsOf(o.build), pose: { x: sl.x, y: sl.y, heading: sl.heading } };
  }), tMax || 75);
}
[['default', 'gruenwald-ring', 'similar', 21], ['default', 'forge-speedway', 'similar', 21], ['default', 'circle-lab', 'similar', 21],
  ['reference', 'gruenwald-ring', 'similar', 21], ['default', 'forge-ring', 'presets', 3], ['default', 'circle-lab', 'mixed', 7]].forEach(function (c) {
  test('pack: 6 ' + c[0] + '-matched (' + c[2] + ') cars race 75 s on ' + c[1] + ' on track and without contact', function () {
    if (!geomOf(c[1])) return;
    var r = pack(c[0], c[1], c[2], c[3], 75);
    if (standalone) console.log('       ' + c[1] + ' pack: min dist ' + r.minDist.toFixed(2) + ' m, ' + r.entries.map(function (e) { return e.progress.toFixed(0) + 'm/' + e.offT.toFixed(1) + 's'; }).join(' '));
    r.entries.forEach(function (e) {
      assert.ok(e.progress > 1000, e.id + ' progress ' + e.progress.toFixed(0));
      assert.ok(e.offT < 3.5, e.id + ' off-track ' + e.offT.toFixed(2) + ' s');
      assert.ok(e.maxBeta < 0.5, e.id + ' no spin (max beta ' + (e.maxBeta * 57.3).toFixed(0) + ' deg)');
    });
    assert.ok(r.minDist > 1.2, 'min centre distance ' + r.minDist.toFixed(2));
  });
});

/* ------------------------------------------------------------------ player 911 with heavy race assist */

var ASSIST = CB.race.assist;
if (ASSIST && typeof ASSIST.create === 'function' && typeof T.project === 'function') {
  test('player 911 with heavy race assist (arrow-key bot, always on throttle) laps cleanly without spinning', function () {
    ['forge-speedway', 'gruenwald-ring', 'circle-lab', 'porto-vecchio'].forEach(function (tid) {
      var geom = geomOf(tid);
      if (!geom) return;
      var N = geom.samples.length, p = V.fromBuild(buildOf('default')), a = ASSIST.create({ level: 'heavy', mode: 'race' });
      var g0 = (geom.gridSlots && geom.gridSlots[0]) || geom.startLine;
      var s = V.createState(p, { x: g0.x, y: g0.y, heading: g0.heading, speed: 0 }, { autoShift: true });
      var env = { assists: { tc: true, abs: true, autoShift: true } }, hint = null, prog = 0, lastS = null, t = 0, offT = 0, maxBeta = 0;
      while (t < 420 && prog < geom.length) {
        var pr = T.project(geom, s.x, s.y, hint); hint = pr.index;
        if (lastS != null) { var d = pr.s - lastS; if (d < -geom.length / 2) d += geom.length; if (d > geom.length / 2) d -= geom.length; prog += d; }
        lastS = pr.s;
        if (!pr.onTrack) offT += 1 / 60;
        if (s.speed > 3) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(s.vy, s.vx)));
        var sm = geom.samples[(pr.index + Math.round(25 / geom.ds)) % N];
        var err = Math.atan2(sm.y - s.y, sm.x - s.x) - s.heading;
        while (err > Math.PI) err -= 2 * Math.PI; while (err < -Math.PI) err += 2 * Math.PI;
        var inp = a.filter({ up: true, left: err > 0.07, right: err < -0.07 }, s, { dt: 1 / 60, geom: geom, params: p });
        V.step(p, s, inp, 1 / 120, env); V.step(p, s, inp, 1 / 120, env);
        t += 1 / 60;
      }
      assert.ok(prog >= geom.length, tid + ': completed the lap (' + prog.toFixed(0) + ' m)');
      assert.ok(offT < 1.0, tid + ': off-track ' + offT.toFixed(2) + ' s');
      assert.ok(maxBeta < 0.35, tid + ': max body slip ' + (maxBeta * 57.3).toFixed(0) + ' deg');
    });
  });
}

if (standalone) console.log('\nrace-ai-rear: ' + passed + ' passed, ' + failed + ' failed');

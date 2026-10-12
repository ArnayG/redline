/* Node tests for js/race/drift/ai.js (DRIFT-SPEC §5: drifting tandem-lead AI).
   Run: node tests/drift-ai.test.js   (or via node tests/run.js)
   Loads the real race core (tracks / vehicle / engine) + the drift tune / tracks / session when present and checks that
   the drift AI laps the drift circuits sideways (avg |beta| > 15 deg in the corners) without spinning or leaving the road. */
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
 'js/game/challenges.js', 'js/race/drift/tune.js', 'js/race/drift/assist.js', 'js/race/drift/arcade.js', 'js/race/drift/scoring.js',
 'js/race/drift/tracks.js'].forEach(tryLoad);
var AI = require(path.join(root, 'js', 'race', 'drift', 'ai.js'));
var CB = globalThis.CB;
var T = CB.race.tracks, V = CB.race.vehicle, TUNE = CB.race.drift && CB.race.drift.tune;
var DEG = Math.PI / 180;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('drift-ai: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}

/* ---------------------------------------------------------------- fixtures */
function trackList() { var l = T.list; if (typeof l === 'function') l = l(); return Array.isArray(l) ? l : []; }
function getDef(id) { return typeof T.get === 'function' ? T.get(id) : trackList().filter(function (d) { return d.id === id; })[0]; }
/** The drift circuits (js/race/drift/tracks.js) or, when that module is missing, an existing catalog track. */
function driftTrackIds() {
  var D = CB.race.drift && CB.race.drift.tracks;
  var ids = D && Array.isArray(D.ids) ? D.ids.filter(function (id) { return !!getDef(id); }) : [];
  if (ids.length) return ids;
  var l = trackList();
  var ring = l.filter(function (d) { return d.id === 'forge-ring'; })[0] || l[0];
  return ring ? [ring.id] : [];
}
var geomCache = {};
function geomOf(id) { return geomCache[id] || (geomCache[id] = T.build(getDef(id))); }
function deepMerge(a, b) {
  if (CB.util && typeof CB.util.deepMerge === 'function') return CB.util.deepMerge(a, b);
  var out = Object.assign({}, a);
  Object.keys(b || {}).forEach(function (k) {
    var v = b[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMerge(out[k], v) : v;
  });
  return out;
}
/** Same car the drift session gives the tandem lead: 'muscle' preset + tune.recommendedBuildPatch, then tune.apply. */
function leadParams(level, presetId, patch) {
  var b = CB.data && CB.data.presetBuild ? CB.data.presetBuild(presetId || 'muscle') : null;
  if (b && patch !== false && TUNE && TUNE.recommendedBuildPatch) {
    b = deepMerge(b, TUNE.recommendedBuildPatch(b));
    if (CB.state && CB.state.normalize) b = CB.state.normalize(b) || b;
  }
  var p = V.fromBuild(b || (CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : {}));
  return TUNE && TUNE.apply ? TUNE.apply(p, { level: level || 'street', build: b }) : p;
}
function fmt(s) {
  return 'laps ' + s.laps + ' (' + s.lapTimes.map(function (x) { return x.toFixed(1); }).join('/') + ' s), corner |b| ' + s.cornerBetaAvg_deg.toFixed(1) +
    ' deg, max |b| ' + s.maxBeta_deg.toFixed(0) + ', spins ' + s.spins + ', walls ' + s.wallHits + ', off ' + s.offTrack_s.toFixed(1) + ' s, min edge ' +
    s.minEdge_m.toFixed(1) + ' m, resets ' + s.resets;
}
function assertCleanDriftLaps(s, label, minBeta) {
  assert.ok(s.completed, label + ': completes the laps — ' + fmt(s));
  assert.strictEqual(s.spins, 0, label + ': never spins — ' + fmt(s));
  assert.ok(s.maxBeta_deg < 90, label + ': |beta| < 90 deg throughout — ' + fmt(s));
  assert.strictEqual(s.wallHits, 0, label + ': no wall hits — ' + fmt(s));
  assert.ok(s.offTrack_s === 0, label + ': never leaves the asphalt — ' + fmt(s));
  assert.strictEqual(s.resets, 0, label + ': no stuck resets — ' + fmt(s));
  assert.ok(s.cornerBetaAvg_deg > (minBeta || 15), label + ': drifts the corners (avg |beta| > ' + (minBeta || 15) + ' deg) — ' + fmt(s));
}

/* ---------------------------------------------------------------- surface */
test('module surface (CB.race.drift.ai + module.exports)', function () {
  assert.strictEqual(CB.race.drift.ai, AI);
  ['createDriftDriver', 'createDriver', 'asEngineAi', 'buildPlan', 'maxSteerAt', 'simulate'].forEach(function (k) {
    assert.strictEqual(typeof AI[k], 'function', k);
  });
  assert.ok(AI.DEFAULTS && AI.DEFAULTS.angle_deg > 15);
});

test('driver.control returns a clean engine input and holds the brakes on the grid', function () {
  var id = driftTrackIds()[0], g = geomOf(id), p = leadParams('street');
  var drv = AI.createDriftDriver({ skill: 0.92 }, g, p);
  assert.strictEqual(typeof drv.control, 'function');
  var s0 = g.samples[0];
  var st = V.createState(p, { x: s0.x, y: s0.y, heading: s0.heading, speed: 0 }, { autoShift: true });
  var held = drv.control(st, { phase: 'countdown' }, 1 / 120);
  assert.strictEqual(held.brake, 1); assert.strictEqual(held.throttle, 0);
  var out = drv.control(st, { phase: 'racing' }, 1 / 120);
  ['throttle', 'brake', 'steer'].forEach(function (k) { assert.ok(isFinite(out[k]), k + ' finite'); });
  assert.ok(out.throttle >= 0 && out.throttle <= 1 && out.brake >= 0 && out.brake <= 1 && Math.abs(out.steer) <= 1);
  assert.ok(out.throttle > 0.2, 'pulls away from rest');
  ['handbrake', 'shiftUp', 'shiftDown', 'requestReset'].forEach(function (k) { assert.strictEqual(typeof out[k], 'boolean', k); });
  // garbage in -> neutral out, never throws
  var junk = drv.control({ x: NaN, y: undefined, heading: null }, null, NaN);
  ['throttle', 'brake', 'steer'].forEach(function (k) { assert.ok(isFinite(junk[k]), 'junk ' + k + ' finite'); });
  assert.ok(drv.debug() && typeof drv.debug() === 'object');
  drv.reset(); drv.setAngle(30); drv.setPace(0.9);
  assert.strictEqual(drv.options.angle_deg, 30); assert.strictEqual(drv.options.pace, 0.9);
});

test('buildPlan: drift line inside the asphalt, drift intensity in the corners, finite speed profile', function () {
  driftTrackIds().forEach(function (id) {
    var g = geomOf(id), plan = AI.buildPlan(g, leadParams('street'));
    assert.ok(plan && plan.n === g.samples.length, id + ' plan size');
    var drift = 0;
    for (var i = 0; i < plan.n; i++) {
      assert.ok(isFinite(plan.V[i]) && plan.V[i] >= 8 && plan.V[i] <= 60, id + ' V[' + i + '] = ' + plan.V[i]);
      assert.ok(Math.abs(plan.OFF[i]) <= plan.HW[i], id + ' drift line inside the edges at ' + i);
      if (plan.D[i] > 0.5) drift++;
    }
    assert.ok(drift > plan.n * 0.1, id + ': has drift corners (' + drift + '/' + plan.n + ' samples)');
  });
  assert.strictEqual(AI.buildPlan(null, {}), null, 'no geometry -> null');
});

test('maxSteerAt shrinks with speed and never exceeds the lock', function () {
  var p = leadParams('street'), lock = p.lockAngle || p.maxSteer;
  var a = AI.maxSteerAt(p, 3), b = AI.maxSteerAt(p, 20), c = AI.maxSteerAt(p, 50);
  assert.ok(a <= lock + 1e-9 && a >= b && b >= c && c > 0.04, [a, b, c].join(' / '));
});

/* ---------------------------------------------------------------- the main requirement */
driftTrackIds().forEach(function (id) {
  test('tandem-lead car (street tune) drifts 2 clean laps of ' + id, function () {
    var s = AI.simulate(geomOf(id), leadParams('street'), { laps: 2, maxTime: 400 });
    assertCleanDriftLaps(s, id);
    assert.ok(s.driftTime_s > s.time * 0.25, id + ': sideways a good part of the lap (' + (100 * s.driftTime_s / s.time).toFixed(0) + '%)');
  });
});

test('robust across tune levels, cars and start points on the drift tracks', function () {
  // [tune level, preset, drift build patch, min corner |beta|]; the 350 hp FWD->RWD hot hatch is power-limited, so it
  // only has to stay clean and clearly sideways (> 12 deg) — the lead car the session uses (muscle) must exceed 15 deg.
  var cases = [['pro', 'muscle', true, 15], ['competition', 'muscle', true, 15], ['competition', 'muscle', false, 15],
               ['street', 'hot-hatch', false, 12], ['competition', 'hot-hatch', false, 12]];
  var ids = driftTrackIds();
  cases.forEach(function (c) {
    var p = leadParams(c[0], c[1], c[2]);
    ids.forEach(function (id, k) {
      var g = geomOf(id);
      var s = AI.simulate(g, p, { laps: 1, maxTime: 300, startIndex: Math.floor(g.samples.length * (k % 2 ? 0.5 : 0)), startSpeed: k % 2 ? 10 : 0 });
      assertCleanDriftLaps(s, c.slice(0, 3).join('/') + ' @ ' + id, c[3]);
    });
  });
});

test('the drift guard is a light helper: the pure input controller alone does not spin on the drift tracks', function () {
  var p = leadParams('street');
  driftTrackIds().forEach(function (id) {
    var s = AI.simulate(geomOf(id), p, { laps: 1, maxTime: 300, ai: { guard: 0 } });
    assert.ok(s.completed && s.spins === 0 && s.maxBeta_deg < 90, 'guard off @ ' + id + ' — ' + fmt(s));
    assert.ok(s.cornerBetaAvg_deg > 15, 'guard off still drifts @ ' + id + ' — ' + fmt(s));
    // with the guard: its total correction stays small (well under 0.1 rad/s on average)
    var drv = AI.createDriftDriver({ skill: 1 }, geomOf(id), p);
    var s2 = AI.simulate(geomOf(id), p, { laps: 1, maxTime: 300, driver: drv });
    var sum = 0;
    AI.simulate(geomOf(id), p, { laps: 1, maxTime: 300, onStep: function (st, inp, pr, t, d) { var gd = d.debug().guard; if (gd) sum += Math.abs(gd.trim) + Math.abs(gd.feed) + Math.abs(gd.edge); } });
    assert.ok(sum / s2.time < 0.1, 'guard correction ' + (sum / s2.time).toFixed(3) + ' rad/s @ ' + id);
  });
});

test('drift guard never touches frozen / snapshot states and can be switched off per call', function () {
  var id = driftTrackIds()[0], g = geomOf(id), p = leadParams('street');
  var drv = AI.createDriftDriver({ skill: 1 }, g, p);
  var sm = g.samples[10];
  var st = V.createState(p, { x: sm.x, y: sm.y, heading: sm.heading + 0.9, speed: 20 }, { autoShift: true });
  st.vy = 12;                                                        // wildly sideways
  var fz = Object.freeze(Object.assign({}, st));
  assert.doesNotThrow(function () { drv.control(fz, { phase: 'racing' }, 1 / 120); });
  var h0 = st.heading;
  drv.control(st, { phase: 'racing', noGuard: true }, 1 / 120);
  assert.strictEqual(st.heading, h0, 'ctx.noGuard leaves the state alone');
  drv.control(st, { phase: 'racing' }, 1 / 120);
  assert.notStrictEqual(st.heading, h0, 'guard trims an over-rotated state');
  assert.ok(Math.abs(Math.hypot(st.vx, st.vy) - st.speed) < 1e-9, 'speed kept consistent');
});

test('grip tune: stays tidy (no spins / walls) even when the car will barely slide', function () {
  var p = leadParams('grip');
  driftTrackIds().forEach(function (id) {
    var s = AI.simulate(geomOf(id), p, { laps: 1, maxTime: 300 });
    assert.ok(s.completed && s.spins === 0 && s.wallHits === 0 && s.offTrack_s === 0, 'grip @ ' + id + ' — ' + fmt(s));
  });
});

test('fast circuits: a tail-happy drift tune does not fishtail at top speed (no spins on the Speedway / Redline Ring)', function () {
  ['forge-speedway', 'forge-ring'].filter(function (id) { return !!getDef(id); }).forEach(function (id) {
    ['street', 'pro', 'competition'].forEach(function (lv) {
      var s = AI.simulate(geomOf(id), leadParams(lv), { laps: 1, maxTime: 400 });
      assert.ok(s.completed && s.spins === 0 && s.maxBeta_deg < 90 && s.wallHits === 0, lv + ' @ ' + id + ' — ' + fmt(s));
    });
  });
});

test('smooth, readable steering: no step jumps, few direction reversals', function () {
  var id = driftTrackIds()[0], prev = null, maxJump = 0, rev = 0, lastDir = 0;
  var s = AI.simulate(geomOf(id), leadParams('street'), { laps: 1, maxTime: 300, onStep: function (st, inp) {
    if (prev !== null) {
      var d = inp.steer - prev, dir = Math.abs(d) > 0.004 ? (d > 0 ? 1 : -1) : 0;
      maxJump = Math.max(maxJump, Math.abs(d));
      if (dir && lastDir && dir !== lastDir) rev++;
      if (dir) lastDir = dir;
    }
    prev = inp.steer;
  } });
  assert.ok(s.completed, fmt(s));
  assert.ok(maxJump <= 0.08, 'steer change per 1/120 s step <= 0.08 (max ' + maxJump.toFixed(3) + ')');
  assert.ok(rev / s.time < 2, 'steering reversals < 2/s (' + (rev / s.time).toFixed(2) + ')');
});

test('tandem pacing: slows down when the player falls far behind', function () {
  var id = driftTrackIds()[0], g = geomOf(id), p = leadParams('street');
  var a = AI.createDriftDriver({ skill: 1 }, g, p), b = AI.createDriftDriver({ skill: 1 }, g, p);
  var sm = g.samples[Math.floor(g.samples.length * 0.3)];
  var st = V.createState(p, { x: sm.x, y: sm.y, heading: sm.heading, speed: 20 }, { autoShift: true });
  a.control(st, { phase: 'racing', nearby: [] }, 1 / 120);
  b.control(st, { phase: 'racing', nearby: [{ isPlayer: true, ds: -150 }] }, 1 / 120);
  assert.ok(b.debug().vt < a.debug().vt - 0.5, 'target speed ' + b.debug().vt.toFixed(1) + ' < ' + a.debug().vt.toFixed(1));
});

test('asEngineAi: tandem-lead entrants get the drift driver, others keep the base AI', function () {
  var base = { createGrid: function () { return 'grid'; }, createDriver: function () { return { kind: 'base', control: function () { return {}; } }; } };
  var m = AI.asEngineAi(base);
  var g = geomOf(driftTrackIds()[0]), p = leadParams('street');
  assert.strictEqual(m.createGrid(), 'grid');
  assert.strictEqual(m.createDriver({ role: 'tandem-lead' }, g, p, {}).kind, 'drift-ai');
  assert.strictEqual(m.createDriver({ id: 'x' }, g, p, {}).kind, 'base');
});

/* ---------------------------------------------------------------- inside the real engine (drift session, tandem mode) */
test('engine-integrated: the tandem lead drifts the drift tracks inside a real drift session', function () {
  var DS = tryLoad('js/race/drift/session.js') && CB.race.drift.createSession;
  if (typeof DS !== 'function' || !CB.race.engine) { console.log('  (skip: drift session / engine not available)'); return; }
  var ids = driftTrackIds().filter(function (id) { var d = getDef(id); return d && (d.driftZones || d.mode === 'drift' || (d.style && d.style.drift)); });
  if (!ids.length) { console.log('  (skip: no drift tracks registered)'); return; }
  ids.forEach(function (id) {
    var g = geomOf(id), lead = null, follower = null;
    // the "player" is driven by a second drift AI that keeps its distance, so the session's soft leash never interferes
    var hook = {
      carCreated: function (car) { if (!car.isPlayer) lead = car; },
      preStep: function (car, inp) {
        if (!car.isPlayer) return inp;
        if (!follower) follower = AI.createDriftDriver({ skill: 1 }, g, car.params, { tandem: false, pace: 0.97 });
        var o = follower.control(car.state, car.ctx, 1 / 120);
        if (lead) {
          var d = Math.hypot(lead.state.x - car.state.x, lead.state.y - car.state.y);
          if (d < 14) { o.throttle *= Math.max(0, (d - 6) / 8); if (d < 9) o.brake = Math.max(o.brake, 0.3); }
        }
        return o;
      }
    };
    var sess = DS({ trackId: id, mode: 'tandem', duration_s: 150, hooks: [hook] });
    var plan = null, sum = 0, n = 0, maxB = 0, spins = 0, latch = false, off = 0, dist = 0, lastS = null;
    for (var i = 0; i < 100 * 60; i++) {
      sess.update(1 / 60, {});
      if (!lead) continue;
      var s = lead.state, v = Math.hypot(s.vx, s.vy);
      var pr = T.project(g, s.x, s.y);
      if (lastS !== null) { var dS = pr.s - lastS; if (dS < -g.length / 2) dS += g.length; else if (dS > g.length / 2) dS -= g.length; dist += dS; }
      lastS = pr.s;
      if (v < 3) continue;
      if (!plan) plan = AI.buildPlan(g, lead.params);
      var b = Math.abs(Math.atan2(s.vy, Math.max(s.vx, 0.01))) / DEG;
      maxB = Math.max(maxB, b);
      if (b > 90) { if (!latch) { spins++; latch = true; } } else if (b < 30) latch = false;
      if (g.samples[pr.index].hw - Math.abs(pr.lateral) < -0.5) off += 1 / 60;
      if (plan.D[pr.index] > 0.5 && v > 6) { sum += b; n++; }
    }
    var avg = n ? sum / n : 0, msg = id + ': corner |b| ' + avg.toFixed(1) + ', max ' + maxB.toFixed(0) + ', spins ' + spins + ', off ' + off.toFixed(1) + ' s, dist ' + dist.toFixed(0) + ' m';
    assert.ok(lead, id + ': session created a lead car');
    assert.ok(dist > Math.min(g.length, 1500), msg + ' (covers ground)');
    assert.strictEqual(spins, 0, msg);
    assert.ok(maxB < 90, msg);
    assert.ok(off < 0.2, msg);
    assert.ok(avg > 15, msg);
  });
});

/* ---------------------------------------------------------------- standalone runner */
if (local) {
  var passed = 0, failed = 0;
  queue.forEach(function (t) {
    var t0 = Date.now();
    try { t.fn(); passed++; console.log('  ✓ ' + t.name + ' (' + (Date.now() - t0) + ' ms)'); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

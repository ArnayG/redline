/* Node "novice bot" tests: heavy / auto drift assist must be arcade-easy with ONLY the arrow keys, on EVERY drift track.
   run: node tests/drift-novice.test.js (or via node tests/run.js drift) */
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
 'js/race/drift/ai.js', 'js/race/drift/arcade.js', 'js/race/drift/session.js'].forEach(tryLoad);
var CB = globalThis.CB;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('drift-novice: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}

var TRACKS = ['kurogane-pass', 'dockyard-sliders', 'circle-lab'];
function rng(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function curvAt(geom, s) {
  var S = geom.samples, L = geom.length || S[S.length - 1].s; s = ((s % L) + L) % L;
  var lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (S[m].s <= s) lo = m; else hi = m; }
  return S[lo].curvature || 0;
}
/** kind: 'novice' (Up + arrow toward each corner's inside, timing jitter +-0.4 s), 'mash' (random arrows), 'up' (Up only) */
function drive(trackId, level, kind, seed, laps, maxT, onFrame) {
  var s = CB.race.drift.createSession({ trackId: trackId, mode: 'free', seed: seed, assist: level });
  var geom = s.geom, r = rng(seed), dt = 1 / 60, t = 0;
  var R = { spins: 0, walls: 0, driftT: 0, offT: 0, maxAng: 0, lap: 0, t: 0 };
  var pend = 0, pendT = 0, cur = 0, mashT = 0, mash = {};
  while (t < maxT) {
    var ps = s.playerState(), raw = { up: true };
    if (kind === 'novice' && ps) {
      var k = curvAt(geom, (ps.s || 0) + ps.speed * 0.6), want = k > 0.008 ? -1 : k < -0.008 ? 1 : 0;
      if (want !== pend) { pend = want; pendT = t + (r() * 0.8 - 0.4); }
      if (t >= pendT) cur = pend;
      if (cur < 0) raw.left = true; else if (cur > 0) raw.right = true;
    } else if (kind === 'mash') {
      if (t > mashT) { mashT = t + 0.1 + r() * 0.6; mash = { left: r() < 0.4, right: r() < 0.4, down: r() < 0.1 }; }
      raw.left = mash.left; raw.right = mash.right; raw.down = mash.down; raw.up = r() < 0.97;
    }
    s.update(dt, raw); t += dt;
    var snap = s.snapshot();
    (snap.events || []).forEach(function (e) { if (e.type === 'wall' && e.carId === 'player' && e.intensity > 0.05) R.walls++; });
    ps = s.playerState();
    if (ps && ps.speed > 3) { if (ps.angle_deg > 85) R.spins++; if (ps.angle_deg > 15 && ps.speed > 8) R.driftT += dt; R.maxAng = Math.max(R.maxAng, ps.angle_deg); }
    if (ps && ps.offTrack) R.offT += dt;
    if (onFrame) onFrame(s, ps, t);
    var me = snap.cars.filter(function (c) { return c.isPlayer; })[0];
    R.lap = me.lap;
    if (me.lap > laps) break;
  }
  R.t = t; R.drift = R.driftT / Math.max(1, t);
  return R;
}
function fmt(tr, R) { return tr + ' lap ' + R.lap + ' t ' + R.t.toFixed(0) + 's spins ' + R.spins + ' walls ' + R.walls + ' off ' + R.offT.toFixed(1) + 's drift ' + (R.drift * 100).toFixed(0) + '% max ' + R.maxAng.toFixed(0) + 'deg'; }

var haveArcade = !!(CB.race && CB.race.drift && CB.race.drift.arcade && CB.race.drift.createSession);

test('(a) heavy: Up + sloppy arrows toward each inside (+-0.4 s) -> 3 laps, zero spins, zero wall hits, every drift track', function () {
  if (!haveArcade) return;
  TRACKS.forEach(function (tr) {
    [3, 7].forEach(function (seed) {
      var R = drive(tr, 'heavy', 'novice', seed, 3, 900);
      assert.ok(R.lap > 3, '3 laps: ' + fmt(tr, R));
      assert.strictEqual(R.spins, 0, 'no spin: ' + fmt(tr, R));
      assert.strictEqual(R.walls, 0, 'no wall: ' + fmt(tr, R));
      assert.ok(R.offT < 0.5, 'stays on the road: ' + fmt(tr, R));
      assert.ok(R.drift > 0.3, 'actually drifts: ' + fmt(tr, R));
    });
  });
});

test('(b) heavy: random arrow mashing never spins', function () {
  if (!haveArcade) return;
  TRACKS.forEach(function (tr) {
    [1, 2, 3, 4, 5].forEach(function (seed) {
      var R = drive(tr, 'heavy', 'mash', seed, 1, 90);
      assert.strictEqual(R.spins, 0, 'mash no spin: ' + fmt(tr, R) + ' seed ' + seed);
      assert.ok(R.maxAng < 80, 'never past 80 deg: ' + fmt(tr, R));
    });
  });
});

test('(c) auto: holding just Up completes laps drifting on every drift track', function () {
  if (!haveArcade) return;
  TRACKS.forEach(function (tr) {
    var R = drive(tr, 'auto', 'up', 1, 2, 700);
    assert.ok(R.lap > 2, '2 laps: ' + fmt(tr, R));
    assert.strictEqual(R.spins, 0, fmt(tr, R));
    assert.strictEqual(R.walls, 0, fmt(tr, R));
    assert.ok(R.drift > 0.35, 'drifts most corners: ' + fmt(tr, R));
  });
});

test('heavy: releasing the arrows (Up only) keeps the car on the road (auto-steer)', function () {
  if (!haveArcade) return;
  TRACKS.forEach(function (tr) {
    var R = drive(tr, 'heavy', 'up', 1, 2, 700);
    assert.ok(R.lap > 2, fmt(tr, R));
    assert.strictEqual(R.walls, 0, fmt(tr, R));
    assert.ok(R.offT < 0.5, fmt(tr, R));
  });
});

test('heavy: Up held through long corners with no arrow starts a GENTLE drift the corner\'s way (no spin, no wall)', function () {
  if (!haveArcade) return;
  TRACKS.forEach(function (tr) {
    var longest = 0, cur = 0;
    var R = drive(tr, 'heavy', 'up', 1, 2, 700, function (s, ps) { if (ps && ps.angle_deg > 15 && ps.speed > 8) { cur += 1 / 60; longest = Math.max(longest, cur); } else cur = 0; });
    assert.strictEqual(R.spins, 0, fmt(tr, R));
    assert.ok(R.drift > 0.2, 'drift mode drifts with Up only: ' + fmt(tr, R));
    assert.ok(R.maxAng < 34, 'gentle (less angle than a committed arrow drift): ' + fmt(tr, R));
    assert.ok(longest > 4, 'the gentle slide is held through the corner (' + longest.toFixed(1) + ' s): ' + fmt(tr, R));
  });
  // an arrow against the corner straightens it up and the gentle lock does not grab the same corner again
  var s = CB.race.drift.createSession({ trackId: 'circle-lab', mode: 'free', seed: 1, assist: 'heavy' }), t = 0, gentle = -1, dir = 0, after = 0;
  while (t < 40) {
    var dbg = s.assistDebug() || {};
    if (gentle < 0 && dbg.gentle && dbg.phase === 'drift') { gentle = t; dir = dbg.dir; }
    var raw = { up: true };
    if (gentle >= 0 && t - gentle > 3 && t - gentle < 4.5) raw[dir > 0 ? 'right' : 'left'] = true;   // the opposite arrow
    s.update(1 / 60, raw); t += 1 / 60;
    if (gentle >= 0 && t - gentle > 5.5 && t - gentle < 9) { var ps = s.playerState(); if (ps && ps.angle_deg > 15) after += 1 / 60; }
  }
  assert.ok(gentle >= 0, 'circle-lab: a gentle drift started with Up only');
  assert.ok(after < 0.5, 'straightened by the opposite arrow, no re-grab (' + after.toFixed(2) + ' s sideways)');
});

test('SUSTAIN + SMOOTH: a steady drift lasts 10+ s with low yaw-rate jitter and few steer reversals', function () {
  if (!haveArcade) return;
  ['auto', 'heavy'].forEach(function (lvl) {
    var runs = [], cur = null;
    drive('circle-lab', lvl, lvl === 'heavy' ? 'novice' : 'up', 1, 1, 120, function (s, ps) {
      var d = s.assistDebug() || {}, car = s._debug().playerCar;
      if (d.phase === 'drift' && !d.swing) { if (!cur) { cur = { r: [], st: [], ang: [] }; runs.push(cur); } cur.r.push(car.state.yawRate); cur.st.push(d.steer); cur.ang.push(ps.angle_deg); }
      else cur = null;
    });
    runs.sort(function (a, b) { return b.r.length - a.r.length; });
    var c = runs[0];
    assert.ok(c && c.r.length / 60 >= 10, lvl + ': longest held drift ' + (c ? (c.r.length / 60).toFixed(1) : 0) + ' s');
    var a = 90, b = c.r.length - 30, hp = 0, rev = 0, lds = 0, n = b - a;   // skip the 1.5 s entry and the exit
    for (var i = a + 1; i < b; i++) {
      var m = 0, k, cnt = 0;
      for (k = Math.max(a, i - 15); k <= Math.min(b - 1, i + 15); k++) { m += c.r[k]; cnt++; }
      hp += Math.pow(c.r[i] - m / cnt, 2);
      var ds = c.st[i] - c.st[i - 1];
      if (Math.abs(ds) > 2e-4) { if (lds && Math.sign(ds) !== Math.sign(lds)) rev++; lds = ds; }
    }
    var jitter = Math.sqrt(hp / n), angs = c.ang.slice(a, b);
    assert.ok(jitter < 0.04, lvl + ': yaw-rate jitter ' + jitter.toFixed(4) + ' rad/s');
    assert.ok(rev <= 6, lvl + ': steer reversals ' + rev + ' in ' + (n / 60).toFixed(1) + ' s');
    assert.ok(Math.min.apply(null, angs) > 20, lvl + ': angle never collapses (min ' + Math.min.apply(null, angs).toFixed(0) + ')');
  });
});

test('low speed (<30 km/h): launch with an arrow held is a normal easy car (no spin, no twitch)', function () {
  if (!haveArcade) return;
  var s = CB.race.drift.createSession({ trackId: 'circle-lab', mode: 'free', seed: 2, assist: 'heavy' });
  var maxAng = 0, prev = null, maxJump = 0;
  for (var i = 0; i < 60 * 4; i++) {
    s.update(1 / 60, { up: true, left: i > 30 && i < 75 });
    var ps = s.playerState(), d = s.assistDebug() || {};
    // rear-axle slip (the body's CG side-slip at full lock is geometry, not a slide)
    var car = s._debug().playerCar, b = car.params.wheelbase * (car.params.weightFront || 0.5);
    var rear = Math.abs(Math.atan2(ps.vyLocal - ps.yawRate * b, Math.max(0.5, Math.abs(ps.vxLocal)))) * 180 / Math.PI;
    if (ps.speed * 3.6 < 30 && ps.speed > 1.5) maxAng = Math.max(maxAng, rear);
    if (prev != null) maxJump = Math.max(maxJump, Math.abs(d.steer - prev));
    prev = d.steer;
  }
  assert.ok(maxAng < 8, 'no rear slide at low speed (' + maxAng.toFixed(1) + ' deg)');
  assert.ok(maxJump < 0.12, 'steer never snaps (max step ' + maxJump.toFixed(3) + ')');
});

if (local) {
  var passed = 0, failed = 0;
  queue.forEach(function (t) {
    try { t.fn(); passed++; console.log('  ✓ ' + t.name); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

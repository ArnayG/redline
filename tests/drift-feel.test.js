/* Regression bots for the drift-lock FEEL (js/race/drift/arcade.js, heavy assist):
   - A1 drift exits unwind smoothly (no snap to grip: angle rate, yaw accel, no counter-fishtail)
   - A2 the engine never bounces on the rev limiter mid-drift (soft rev cap + short-shift)
   - A3 the car choice matters: a light RWD car holds clearly more angle than a heavy AWD van (both spin-free)
   - A4 the lock reports when it brakes for the player (assistBraking) and has a less timid speed profile
   run: node tests/drift-feel.test.js (or via node tests/run.js drift-feel) */
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
['js/util.js', 'js/data.js', 'js/shapes/core.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js',
 'js/race/vehicle.js', 'js/race/ai.js', 'js/race/engine.js', 'js/game/challenges.js', 'js/race/drift/tune.js', 'js/race/drift/assist.js',
 'js/race/drift/scoring.js', 'js/race/drift/tracks.js', 'js/race/drift/ai.js', 'js/race/drift/arcade.js', 'js/race/drift/session.js'].forEach(tryLoad);
var CB = globalThis.CB;

var local = typeof globalThis.test !== 'function';
var queue = [];
function test(name, fn) {
  if (!local) return globalThis.test('drift-feel: ' + name, function () { fn(); });
  queue.push({ name: name, fn: fn });
}
var ok = !!(CB && CB.race && CB.race.drift && CB.race.drift.createSession && CB.race.drift.arcade);
var DT = 1 / 60;

function buildOf(id) {
  if (!id || !CB.data || !CB.data.presetBuild || !CB.state || !CB.state.normalize) return undefined;
  var b = CB.data.presetBuild(id);
  return b ? CB.state.normalize(b) : undefined;
}
/** Heavy assist, Up held; 'inter' also holds the arrow toward the inside of the corner ahead. */
function run(trackId, kind, secs, preset) {
  var s = CB.race.drift.createSession({ trackId: trackId, mode: 'free', seed: 1, assist: 'heavy', build: buildOf(preset) });
  var geom = s.geom, S = geom.samples, L = geom.length;
  function curvAt(s0) {
    s0 = ((s0 % L) + L) % L; var lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (S[m].s <= s0) lo = m; else hi = m; }
    return S[lo].curvature || 0;
  }
  var R = { exits: [], driftN: 0, limN: 0, spins: 0, walls: 0, off: 0, angs: [], n: 0, brakeFlag: 0, brakeN: 0 };
  var t = 0, prevPh = 'grip', cur = null;
  while (t < secs) {
    var ps = s.playerState(), raw = { up: true };
    var k = curvAt((ps.s || 0) + ps.speed * 0.6), w = k > 0.008 ? -1 : k < -0.008 ? 1 : 0;
    if (kind === 'inter') { if (w < 0) raw.left = true; else if (w > 0) raw.right = true; }
    s.update(DT, raw); t += DT; R.n++;
    ps = s.playerState();
    var d = s.assistDebug(), car = s._debug().playerCar, snap = s.snapshot();
    (snap.events || []).forEach(function (e) { if (e.type === 'wall' && e.carId === 'player' && e.intensity > 0.05) R.walls++; });
    if (ps.speed > 3 && ps.angle_deg > 85) R.spins++;
    if (ps.offTrack) R.off += DT;
    if (d.brake > 0.03) R.brakeN++;
    if (d.assistBraking) R.brakeFlag++;
    var fx = (snap.drift && snap.drift.fx) || {};
    if (d.phase === 'drift') { R.driftN++; if (fx.limiter) R.limN++; R.angs.push(ps.angle_deg); }
    // a drift that ends (drift -> recover/grip) above 8 deg: watch the next ~3 s
    if (prevPh === 'drift' && d.phase !== 'drift' && ps.angle_deg > 8) {
      cur = { frames: 0, maxRate: 0, maxYawAcc: 0, flips: 0, lastB: 0, prevA: null, prevR: null };
      R.exits.push(cur);
    }
    if (cur) {
      cur.frames++;
      var r = car.state.yawRate;
      if (cur.prevR != null) cur.maxYawAcc = Math.max(cur.maxYawAcc, Math.abs(r - cur.prevR) / DT);
      if (cur.prevA != null) cur.maxRate = Math.max(cur.maxRate, Math.abs(ps.angle_deg - cur.prevA) / DT);
      cur.prevR = r; cur.prevA = ps.angle_deg;
      var b = ps.angle_deg > 1.5 ? Math.sign(ps.beta || 0) : 0;
      if (cur.frames > 20 && b && cur.lastB && b !== cur.lastB) cur.flips++;
      if (b) cur.lastB = b;
      if (cur.frames > 180 || d.phase === 'drift') cur = null;
    }
    prevPh = d.phase;
  }
  return R;
}
function mean(a, f) { return a.length ? a.reduce(function (s, e) { return s + f(e); }, 0) / a.length : 0; }
function pct(a, q) { var b = a.slice().sort(function (x, y) { return x - y; }); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * q))] : 0; }

test('A1: drift exits unwind smoothly (angle rate <= 40 deg/s, yaw accel <= 5 rad/s^2, no counter-fishtail)', function () {
  if (!ok) return;
  [['kurogane-pass', 'inter'], ['circle-lab', 'up']].forEach(function (c) {
    var R = run(c[0], c[1], 90);
    var tag = c[0] + '/' + c[1];
    assert.ok(R.exits.length >= 4, tag + ': exits measured ' + R.exits.length);
    var rate = mean(R.exits, function (e) { return e.maxRate; }), acc = mean(R.exits, function (e) { return e.maxYawAcc; });
    var flips = mean(R.exits, function (e) { return e.flips; });
    // before the fix: 62-83 deg/s, 10-13 rad/s^2, 0.9-1.9 fishtail sign flips per exit
    assert.ok(rate <= 40, tag + ': unwind rate ' + rate.toFixed(1) + ' deg/s');
    assert.ok(acc <= 5, tag + ': peak yaw accel ' + acc.toFixed(2) + ' rad/s^2');
    assert.ok(flips <= 0.2, tag + ': fishtail sign flips/exit ' + flips.toFixed(2));
    assert.strictEqual(R.spins, 0, tag + ': spins'); assert.strictEqual(R.walls, 0, tag + ': walls');
    assert.ok(R.off < 0.2, tag + ': off-track ' + R.off.toFixed(2) + ' s');
  });
});

test('A2: no rev-limiter bounce mid-drift (fuel cut < 5 % of drift time)', function () {
  if (!ok) return;
  [['dockyard-sliders', 'inter'], ['circle-lab', 'inter']].forEach(function (c) {
    var R = run(c[0], c[1], 60);
    var duty = R.limN / Math.max(1, R.driftN);
    assert.ok(R.driftN > 600, c[0] + ': drifts');
    // before the fix: 24-51 % of the drift on the fuel cut (~11 Hz on/off)
    assert.ok(duty < 0.05, c[0] + ': limiter duty ' + (duty * 100).toFixed(1) + ' %');
  });
});

test('A3: car choice matters — light RWD holds more angle than a heavy AWD van, both spin-free', function () {
  if (!ok || !CB.data.presetBuild || !CB.data.preset('track-weapon') || !CB.data.preset('atelier-shuttle')) return;
  var A = CB.race.drift.arcade;
  // pure: character from vehicle params
  var light = A.charTuning({ mass: 1300, wheelbase: 2.45, powerKw: 300, layout: 'rwd', drift: { originalLayout: 'rwd', originalHp: 420 } });
  var van = A.charTuning({ mass: 2650, wheelbase: 3.3, powerKw: 300, layout: 'rwd', drift: { originalLayout: 'awd', originalHp: 400 } });
  assert.ok(light.angleBig >= 53 && light.angleBig <= 58, 'light RWD capability ' + light.angleBig.toFixed(1));
  assert.ok(van.angleBig <= 40, 'van capability ' + van.angleBig.toFixed(1));
  assert.ok(light.drive > van.drive, 'drift drive follows power-to-weight');
  var rL = run('circle-lab', 'inter', 45, 'track-weapon'), rV = run('circle-lab', 'inter', 45, 'atelier-shuttle');
  var pL = pct(rL.angs, 0.95), pV = pct(rV.angs, 0.95);
  assert.ok(pL - pV >= 12, 'p95 angle light ' + pL.toFixed(1) + ' vs van ' + pV.toFixed(1));
  [rL, rV].forEach(function (R, i) {
    assert.strictEqual(R.spins, 0, (i ? 'van' : 'light') + ' spins'); assert.strictEqual(R.walls, 0, (i ? 'van' : 'light') + ' walls');
  });
});

test('A4: assistBraking flag mirrors the lock braking with Up held; profile not timid', function () {
  if (!ok) return;
  var T = CB.race.drift.arcade.TUNING;
  assert.ok(T.profLat >= 1.0 * 9.81, 'profLat ' + (T.profLat / 9.81).toFixed(2) + ' g');
  assert.ok(T.pushUpOnly >= 0.05, 'pushUpOnly ' + T.pushUpOnly);
  var R = run('kurogane-pass', 'up', 40);
  assert.ok(R.brakeN > 0, 'brakes somewhere');
  assert.ok(Math.abs(R.brakeFlag - R.brakeN) <= R.brakeN * 0.15 + 10, 'flag ' + R.brakeFlag + ' vs brake frames ' + R.brakeN);
  assert.strictEqual(R.walls, 0, 'walls');
});

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

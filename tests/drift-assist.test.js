/* Node tests for js/race/drift/assist.js (CB.race.assist) — DRIFT-SPEC §1.
   Run standalone: node tests/drift-assist.test.js   (or via node tests/run.js drift-assist)
   Everything is simulated with the real CB.race.vehicle model (and CB.race.drift.tune when present). */
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
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(tryLoad);
var V = require(path.join(root, 'js', 'race', 'vehicle.js'));
tryLoad('js/race/tracks.js');
tryLoad('js/race/drift/tune.js');
tryLoad('js/race/drift/tracks.js');
var A = require(path.join(root, 'js', 'race', 'drift', 'assist.js'));
var CB = globalThis.CB;
var T = CB.race.tracks;

/* ------------------------------------------------------------ harness */
var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  name = 'drift-assist: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ------------------------------------------------------------ fixtures */
var DEG = Math.PI / 180;
function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function buildOf(id) {
  if (!CB.data) return null;
  if (id === 'ref') return (CB.data.referenceBuild || CB.data.defaultBuild)();   // front-engined V8 calibration coupe
  return !id || id === 'def' ? CB.data.defaultBuild() : CB.data.presetBuild(id);
}
function rawParams(id) {
  var b = buildOf(id);
  return b ? V.fromBuild(b) : V.fromBuild({ engine: {}, body: {}, drivetrain: { layout: 'rwd' } }, { power_hp: 380, weight_kg: 1450 });
}
/** Drift-mode params: tune.apply'd when the tune module is present (spec), raw vehicle params otherwise. */
function driftParams(id) {
  var p = rawParams(id);
  var tune = CB.race.drift && CB.race.drift.tune;
  if (tune && typeof tune.apply === 'function') {
    try { return tune.apply(p, { level: 'street', build: buildOf(id) }); } catch (e) { /* fall through */ }
  }
  return p;
}
function betaOf(s) { return s.speed > 1.5 ? Math.atan2(s.vy, s.vx) : 0; }

/** Open-tarmac skidpad sim: rawFn(t) -> key state; returns drift statistics. */
function skidpad(o) {
  var p = o.params, a = A.create({ level: o.level || 'heavy', mode: o.mode || 'drift' });
  var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: o.v0 != null ? o.v0 : 16.7 }, { autoShift: true });
  var env = { assists: { tc: false, abs: true, autoShift: true } };
  var hz = o.hz || 60, n = Math.round(120 / hz), t = 0;
  var r = { maxBeta: 0, run: 0, bestRun: 0, inBand: 0, spun: false, samples: [] };
  for (var i = 0; i < (o.T || 14) * hz; i++) {
    var raw = o.rawFn ? o.rawFn(t) : { right: true, up: true };
    var inp = a.filter(raw, s, { dt: 1 / hz, params: p });
    for (var k = 0; k < n; k++) V.step(p, s, inp, 1 / 120, env);
    t += 1 / hz;
    var b = Math.abs(betaOf(s)) / DEG;
    r.samples.push(b);
    if (t > 1) r.maxBeta = Math.max(r.maxBeta, b);
    if (b > 90) r.spun = true;
    if (b >= 20 && b <= 45) { r.inBand += 1 / hz; r.run += 1 / hz; r.bestRun = Math.max(r.bestRun, r.run); } else r.run = 0;
  }
  r.state = s; r.assist = a;
  return r;
}

/** Arrow-key bot lap: presses left/right toward a point `look` m ahead on the centre line (always on throttle). */
function lap(o) {
  var geom = T.geometry(o.track || 'forge-ring'), N = geom.samples.length;
  var p = o.params, a = A.create({ level: o.level || 'heavy', mode: o.mode || 'race' });
  var g0 = (geom.gridSlots && geom.gridSlots[0]) || geom.startLine;
  var s = V.createState(p, { x: g0.x, y: g0.y, heading: g0.heading, speed: 0 }, { autoShift: true });
  var env = { assists: { tc: o.mode !== 'drift', abs: true, autoShift: true } };
  var hint = null, prog = 0, lastS = null, t = 0, offT = 0, maxBeta = 0, hz = 60;
  var look = o.look || 25, thr = (o.thr || 4) * DEG;
  while (t < (o.T || 300)) {
    var pr = T.project(geom, s.x, s.y, hint); hint = pr.index;
    if (lastS != null) { var d = pr.s - lastS; if (d < -geom.length / 2) d += geom.length; if (d > geom.length / 2) d -= geom.length; prog += d; }
    lastS = pr.s;
    if (!pr.onTrack) offT += 1 / hz;
    if (s.speed > 3) maxBeta = Math.max(maxBeta, Math.abs(betaOf(s)) / DEG);
    if (prog >= geom.length) break;
    var sm = geom.samples[(pr.index + Math.round(look / geom.ds)) % N];
    var course = o.course && s.speed > 3 ? s.heading + betaOf(s) : s.heading;
    var err = wrap(Math.atan2(sm.y - s.y, sm.x - s.x) - course);
    var inp = a.filter({ up: true, left: err > thr, right: err < -thr }, s, { dt: 1 / hz, geom: geom, params: p });
    V.step(p, s, inp, 1 / 120, env); V.step(p, s, inp, 1 / 120, env);
    t += 1 / hz;
  }
  return { done: prog >= geom.length, time: t, offT: offT, maxBeta: maxBeta };
}

/* ================================================================ API */
test('module surface: create / LEVELS / CB.race.drift.assist alias', function () {
  assert.strictEqual(typeof A.create, 'function');
  assert.strictEqual(CB.race.assist, A);
  assert.strictEqual(CB.race.drift.assist, A);
  // 'auto' = heavy + the pilot picks every drift itself (used by js/race/drift/arcade.js)
  assert.deepStrictEqual(A.LEVELS, ['off', 'light', 'medium', 'heavy', 'auto']);
  var a = A.create();
  assert.strictEqual(a.level, 'heavy', 'default level is heavy');
  assert.strictEqual(a.mode, 'race');
  assert.strictEqual(A.create({ level: 'bogus', mode: 'bogus' }).level, 'heavy');
  assert.strictEqual(A.create({ mode: 'drift' }).mode, 'drift');
  ['filter', 'debug', 'setLevel', 'setMode', 'reset', 'engineHook'].forEach(function (k) { assert.strictEqual(typeof a[k], 'function', k); });
});

test('setLevel / setMode / debug()', function () {
  var a = A.create({ level: 'light', mode: 'drift' });
  assert.strictEqual(a.setLevel('medium'), 'medium');
  assert.strictEqual(a.level, 'medium');
  assert.strictEqual(a.setLevel('nope'), 'medium', 'invalid level ignored');
  assert.strictEqual(a.setMode('race'), 'race');
  var p = rawParams('def');
  a.filter({ left: true, up: true }, { speed: 20, vxLocal: 20, vyLocal: 1.5, yawRate: 0.3, heading: 0, gear: 3 }, { dt: 1 / 60, params: p });
  var d = a.debug();
  ['targetAngle_deg', 'beta_deg', 'counterSteer_deg', 'phase', 'level', 'mode'].forEach(function (k) { assert.ok(k in d, 'debug has ' + k); });
  assert.ok(Math.abs(d.beta_deg - Math.atan2(1.5, 20) / DEG) < 1e-6, 'beta = atan2(vyLocal, vxLocal)');
  assert.strictEqual(d.level, 'medium');
});

test('filter output is always a clean engine input (fuzz, missing / garbage fields)', function () {
  var p = rawParams('def');
  var cars = [undefined, null, {}, { speed: NaN }, { speed: 30, vxLocal: 30, vyLocal: -4, yawRate: -0.8, heading: 1 },
    { x: 0, y: 0, heading: 2, vx: -20, vy: 5, speed: 20.6, gear: 'R' }, { speed: 80, vxLocal: -3, vyLocal: 20, yawRate: 4 }];
  var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  ['off', 'light', 'medium', 'heavy'].forEach(function (lv) {
    ['race', 'drift'].forEach(function (mode) {
      var a = A.create({ level: lv, mode: mode });
      for (var i = 0; i < 300; i++) {
        var raw = { left: rnd() < 0.4, right: rnd() < 0.4, up: rnd() < 0.6, down: rnd() < 0.2, handbrake: rnd() < 0.1,
          steerAxis: rnd() < 0.2 ? rnd() * 2 - 1 : undefined, shiftUp: rnd() < 0.05 };
        var ctx = i % 3 === 0 ? undefined : { dt: rnd() < 0.1 ? 0 : 1 / 60, params: i % 2 ? p : undefined };
        var out = a.filter(i % 17 === 0 ? undefined : raw, cars[i % cars.length], ctx);
        assert.ok(out && isFinite(out.throttle) && out.throttle >= 0 && out.throttle <= 1, 'throttle ' + JSON.stringify(out));
        assert.ok(isFinite(out.brake) && out.brake >= 0 && out.brake <= 1, 'brake');
        assert.ok(isFinite(out.steer) && out.steer >= -1 && out.steer <= 1, 'steer');
        assert.strictEqual(typeof out.handbrake, 'boolean');
        assert.strictEqual(typeof out.shiftUp, 'boolean');
        assert.strictEqual(typeof out.shiftDown, 'boolean');
      }
    });
  });
});

/* ================================================================ steering feel */
test('digital arrows -> rate-limited analog ramp; return-to-centre faster than turn-in', function () {
  var p = rawParams('def'), a = A.create({ level: 'heavy', mode: 'race' });
  var car = { speed: 0.5, vxLocal: 0.5, vyLocal: 0, yawRate: 0, heading: 0, gear: 1 };   // parked: pure ramp
  var ctx = { dt: 1 / 60, params: p };
  var seq = [], i;
  for (i = 0; i < 60; i++) seq.push(a.filter({ left: true }, car, ctx).steer);
  assert.ok(seq[0] > 0 && seq[0] < 0.2, 'first frame is a small step, got ' + seq[0]);
  for (i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1] - 1e-9, 'monotone ramp');
  var tIn = seq.findIndex(function (v) { return v >= 0.999; });
  assert.ok(tIn > 5, 'reaches full lock after a ramp (frames: ' + tIn + ')');
  var ret = 0;
  while (a.filter({}, car, ctx).steer > 0.001 && ret < 120) ret++;
  assert.ok(ret < tIn, 'returns to centre (' + ret + ' frames) faster than it turned in (' + tIn + ')');
  // 'off' = raw digital
  var off = A.create({ level: 'off' });
  assert.strictEqual(off.filter({ right: true }, car, ctx).steer, -1);
  assert.strictEqual(off.filter({ left: true, up: true }, car, ctx).throttle, 1);
});

test('gamepad steerAxis is honoured (no digital ramp)', function () {
  var p = rawParams('def'), a = A.create({ level: 'heavy' });
  var car = { speed: 0.5, vxLocal: 0.5, vyLocal: 0, yawRate: 0, heading: 0, gear: 1 };
  var s1 = a.filter({ steerAxis: 1 }, car, { dt: 1 / 60, params: p }).steer;
  var s2 = a.filter({ steerAxis: -0.5 }, car, { dt: 1 / 60, params: p }).steer;
  assert.ok(s1 > 0.95, 'full axis -> full steer immediately (' + s1 + ')');
  assert.ok(s2 < -0.2 && s2 > -0.6, 'half axis -> partial steer (' + s2 + ')');
});

test('speed-sensitive lock: full lock at walking pace, ~25% at 250 km/h (race), drift keeps more', function () {
  var p = rawParams('def');
  var lock = p.lockAngle || p.maxSteer;
  function steadyRad(mode, kph) {
    var a = A.create({ level: 'heavy', mode: mode }), v = kph / 3.6;
    var car = { speed: v, vxLocal: v, vyLocal: 0, yawRate: 0, heading: 0, gear: 3 };
    for (var i = 0; i < 90; i++) a.filter({ right: true }, car, { dt: 1 / 60, params: p });
    return Math.abs(a.debug().steerRad);
  }
  var walk = steadyRad('race', 5), fast = steadyRad('race', 250);
  assert.ok(walk > 0.9 * lock, 'walking pace ~ full lock (' + (walk / DEG).toFixed(1) + ' deg of ' + (lock / DEG).toFixed(1) + ')');
  var ratio = fast / lock;
  assert.ok(ratio > 0.12 && ratio < 0.38, '250 km/h lock ratio ~25% (got ' + ratio.toFixed(2) + ')');
  var drift60 = steadyRad('drift', 60), race60 = steadyRad('race', 60);
  assert.ok(drift60 > race60, 'drift mode keeps more lock at 60 km/h (' + (drift60 / DEG).toFixed(1) + ' vs ' + (race60 / DEG).toFixed(1) + ')');
});

test('counter-steer assist: a sliding car with no keys is steered toward the travel direction', function () {
  var p = rawParams('def');
  // tail out to the left-hand side of the path: beta < 0 (car travels to the right of its nose) -> counter-steer right (-)
  var car = { speed: 25, vxLocal: 25 * Math.cos(20 * DEG), vyLocal: -25 * Math.sin(20 * DEG), yawRate: 0.6, heading: 0, gear: 3 };
  function cs(lv, mode) {
    var a = A.create({ level: lv, mode: mode }); var out;
    for (var i = 0; i < 30; i++) out = a.filter({ up: true }, car, { dt: 1 / 60, params: p });
    return out.steer;
  }
  ['race', 'drift'].forEach(function (mode) {
    var h = cs('heavy', mode), l = cs('light', mode), o = cs('off', mode);
    assert.ok(h < -0.2, mode + ': heavy counter-steers toward beta (steer ' + h.toFixed(2) + ')');
    assert.ok(h < l, mode + ': heavy counter-steers more than light (' + h.toFixed(2) + ' vs ' + l.toFixed(2) + ')');
    if (mode === 'race') assert.strictEqual(o, 0, mode + ': off does nothing');
    // drift mode, keyboard: even 'off' has a self-aligning wheel (the front wheels follow the travel direction)
    else assert.ok(o < -0.1 && o > h - 0.6, mode + ': off self-aligns toward beta (steer ' + o.toFixed(2) + ')');
  });
});

/* ================================================================ drift mode (spec tests) */
test('SPEC: heavy drift skidpad — hold right + throttle sustains |beta| 20-45 deg for >= 10 s, never spins', function () {
  ['def', 'muscle', 'hot-hatch', 'track-weapon'].forEach(function (id) {
    var p = driftParams(id);
    var r = skidpad({ params: p, level: 'heavy', v0: 16.7, T: 14 });
    assert.ok(!r.spun, id + ': spun (max beta ' + r.maxBeta.toFixed(0) + ')');
    assert.ok(r.maxBeta < 90, id + ': |beta| < 90 throughout');
    assert.ok(r.bestRun >= 10, id + ': sustained drift ' + r.bestRun.toFixed(1) + ' s in the 20-45 deg band');
  });
});

test('heavy drift from a standing start: holding right + up builds speed then kicks into a held drift', function () {
  var p = driftParams('def');
  var r = skidpad({ params: p, level: 'heavy', v0: 0, T: 16, hz: 120, rawFn: function (t) { return { up: true, right: t > 1.5 }; } });
  assert.ok(!r.spun, 'no spin');
  assert.ok(r.bestRun >= 10, 'held drift ' + r.bestRun.toFixed(1) + ' s');
});

test('drift initiation helper: direction + throttle above ~40 km/h kicks the rear out quickly', function () {
  var p = driftParams('def');
  var r = skidpad({ params: p, level: 'heavy', v0: 60 / 3.6, T: 2, rawFn: function () { return { up: true, left: true }; } });
  var firstKick = r.samples.findIndex(function (b) { return b > 12; });
  assert.ok(firstKick >= 0 && firstKick < 60 * 1.5, 'beta > 12 deg within 1.5 s (frame ' + firstKick + ')');
  // below the threshold (crawling) a tap of the arrow does not throw the car sideways
  var slow = skidpad({ params: p, level: 'heavy', v0: 15 / 3.6, T: 1.0, rawFn: function () { return { up: true, left: true }; } });
  assert.ok(slow.maxBeta < 15, 'no kick at 15 km/h (max beta ' + slow.maxBeta.toFixed(1) + ')');
});

test('angle hold: up = more angle, down = less; releasing the arrow straightens smoothly without a spin', function () {
  var p = driftParams('def');
  function meanAngle(extra) {
    var r = skidpad({ params: p, level: 'heavy', v0: 16.7, T: 10, rawFn: function (t) {
      var k = { right: true, up: true }; if (t > 4) { k.up = !!extra.up; k.down = !!extra.down; } return k; } });
    var s = r.samples.slice(6 * 60), m = 0; s.forEach(function (b) { m += b; });
    return { mean: m / s.length, spun: r.spun };
  }
  var up = meanAngle({ up: true }), down = meanAngle({ down: true });
  assert.ok(!up.spun && !down.spun, 'no spins');
  assert.ok(up.mean > down.mean + 2, 'throttle holds more angle (' + up.mean.toFixed(1) + ') than brake (' + down.mean.toFixed(1) + ')');
  var rel = skidpad({ params: p, level: 'heavy', v0: 16.7, T: 11, rawFn: function (t) { return { right: t < 6, up: true }; } });
  assert.ok(!rel.spun, 'no spin on exit');
  var tail = rel.samples.slice(9 * 60);
  assert.ok(Math.max.apply(null, tail) < 10, 'straightened out within 3 s of releasing (max beta ' + Math.max.apply(null, tail).toFixed(1) + ')');
});

test('heavy drift survives aggressive / random key mashing without spinning', function () {
  var p = driftParams('def');
  var seed = 99; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  var cur = { up: true }, next = 0;
  var r = skidpad({ params: p, level: 'heavy', v0: 18, T: 20, rawFn: function (t) {
    if (t >= next) { next = t + 0.2 + rnd() * 1.2; var q = rnd(); cur = { up: rnd() < 0.8, down: rnd() < 0.1, left: q < 0.4, right: q > 0.6, handbrake: rnd() < 0.05 }; }
    return cur; } });
  assert.ok(!r.spun, 'random mashing never spins (max beta ' + r.maxBeta.toFixed(0) + ')');
  var sw = skidpad({ params: p, level: 'heavy', v0: 18, T: 14, rawFn: function (t) { var l = Math.floor(t / 3) % 2 === 1; return { up: true, left: l, right: !l }; } });
  assert.ok(!sw.spun, 'left/right swings never spin');
});

test('SPEC: light assist is measurably less stabilizing than heavy', function () {
  var p = driftParams('ref');
  var heavy = skidpad({ params: p, level: 'heavy', v0: 16.7, T: 14 });
  var light = skidpad({ params: p, level: 'light', v0: 16.7, T: 14 });
  assert.ok(heavy.bestRun > light.bestRun + 3 || (light.spun && !heavy.spun),
    'drift: heavy held ' + heavy.bestRun.toFixed(1) + ' s / light ' + light.bestRun.toFixed(1) + ' s (light spun: ' + light.spun + ')');
  // race mode: a yaw kick at 110 km/h with hands off — heavy damps it, light lets it go further
  function kick(lv) {
    var pr = rawParams('ref'), a = A.create({ level: lv, mode: 'race' });
    var s = V.createState(pr, { x: 0, y: 0, heading: 0, speed: 110 / 3.6 }, { autoShift: true });
    s.yawRate = 1.3;
    var env = { assists: { tc: true, abs: true, autoShift: true } }, maxB = 0;
    for (var i = 0; i < 4 * 60; i++) {
      var inp = a.filter({ up: true }, s, { dt: 1 / 60, params: pr });
      V.step(pr, s, inp, 1 / 120, env); V.step(pr, s, inp, 1 / 120, env);
      maxB = Math.max(maxB, Math.abs(betaOf(s)) / DEG);
    }
    return { maxB: maxB, finalYaw: Math.abs(s.yawRate) };
  }
  var kh = kick('heavy'), kl = kick('light');
  assert.ok(kh.maxB < 90, 'heavy catches the yaw kick (max beta ' + kh.maxB.toFixed(1) + ')');
  assert.ok(kh.maxB < kl.maxB, 'heavy peak slip ' + kh.maxB.toFixed(1) + ' < light ' + kl.maxB.toFixed(1));
});

/* ================================================================ race mode (spec tests) */
test('SPEC: race heavy — an arrows-only bot finishes a Redline Ring lap without leaving the track', function () {
  if (!T || !T.geometry || !T.geometry('forge-ring')) { console.log('    (forge-ring unavailable — skipped)'); return; }
  [['def', 25, 4], ['def', 40, 8], ['hot-hatch', 25, 4], ['track-weapon', 25, 4]].forEach(function (c) {
    var r = lap({ params: rawParams(c[0]), level: 'heavy', look: c[1], thr: c[2] });
    assert.ok(r.done, c[0] + ' bot ' + c[1] + 'm finished the lap');
    assert.strictEqual(+r.offT.toFixed(2), 0, c[0] + ' bot ' + c[1] + 'm never left the track (off ' + r.offT.toFixed(2) + ' s)');
    assert.ok(r.maxBeta < 30, 'grip driving, no big slides (max beta ' + r.maxBeta.toFixed(0) + ')');
  });
});

test('race heavy: braking assist slows a flat-out car for corners; off does not', function () {
  if (!T || !T.geometry) return;
  var geom = T.geometry('forge-ring'), p = rawParams('def');
  // find the tightest corner and arrive 40 m before it at 200 km/h (far over any sane corner speed)
  var S = geom.samples, iMin = 0;
  for (var i = 0; i < S.length; i++) if (Math.abs(S[i].curvature) > Math.abs(S[iMin].curvature)) iMin = i;
  var i0 = (iMin - Math.round(40 / geom.ds) + S.length) % S.length, sm = S[i0];
  function run(lv) {
    var a = A.create({ level: lv, mode: 'race' }), maxBrake = 0;
    var car = { x: sm.x, y: sm.y, heading: sm.heading, speed: 200 / 3.6, vxLocal: 200 / 3.6, vyLocal: 0, yawRate: 0, gear: 6 };
    for (var k = 0; k < 10; k++) maxBrake = Math.max(maxBrake, a.filter({ up: true }, car, { dt: 1 / 60, params: p, geom: geom }).brake);
    return { brake: maxBrake, dbg: a.debug() };
  }
  var h = run('heavy'), o = run('off');
  assert.ok(h.brake > 0.3, 'heavy auto-brakes (' + h.brake.toFixed(2) + ', target ' + (h.dbg.targetSpeed_kph | 0) + ' km/h)');
  assert.strictEqual(o.brake, 0, 'off never brakes for you');
});

test('race heavy: off-track recovery steers back toward the track', function () {
  if (!T || !T.geometry) return;
  var geom = T.geometry('forge-ring'), p = rawParams('def'), sm = geom.samples[50];
  var nx = -Math.sin(sm.heading), ny = Math.cos(sm.heading), off = sm.hw + 6;     // 6 m beyond the left edge
  var car = { x: sm.x + nx * off, y: sm.y + ny * off, heading: sm.heading + 0.2, speed: 20, vxLocal: 20, vyLocal: 0, yawRate: 0, gear: 3 };
  var a = A.create({ level: 'heavy', mode: 'race' }), out;
  for (var k = 0; k < 40; k++) out = a.filter({ up: true }, car, { dt: 1 / 60, params: p, geom: geom });
  assert.ok(out.steer < -0.1, 'steers right, back toward the track (steer ' + out.steer.toFixed(2) + ')');
  assert.ok(a.debug().recovering, 'debug reports recovery');
});

/* ================================================================ drift mode on drift tracks */
test('drift heavy: arrows-only drifter gets round Circle Lab on the road and actually drifts', function () {
  if (!T || !T.geometry || !T.get || !T.get('circle-lab')) { console.log('    (circle-lab unavailable — skipped)'); return; }
  var r = lap({ params: driftParams('def'), level: 'heavy', mode: 'drift', course: true, track: 'circle-lab', look: 25, thr: 4, T: 300 });
  assert.ok(r.done, 'lap completed');
  assert.ok(r.offT < 0.5, 'stayed on the road (off ' + r.offT.toFixed(2) + ' s)');
  assert.ok(r.maxBeta > 20 && r.maxBeta < 90, 'drifted without spinning (max beta ' + r.maxBeta.toFixed(0) + ')');
});

/* ================================================================ inputs / integration */
test('accepts session.playerState(), raw vehicle state and engine snapshot cars equivalently', function () {
  var p = rawParams('def');
  var h = 0.7, vxL = 22, vyL = -3, c = Math.cos(h), s = Math.sin(h);
  var player = { x: 5, y: 6, heading: h, speed: Math.hypot(vxL, vyL), vxLocal: vxL, vyLocal: vyL, yawRate: 0.4, gear: 3, rpm: 5000 };
  var state = { x: 5, y: 6, heading: h, speed: Math.hypot(vxL, vyL), vx: vxL, vy: vyL, yawRate: 0.4, gear: 3, rpm: 5000, wheels: [] };
  var snap = { x: 5, y: 6, heading: h, speed: Math.hypot(vxL, vyL), vx: vxL * c - vyL * s, vy: vxL * s + vyL * c, gear: 3, rpm: 5000 };
  function first(car) { var a = A.create({ level: 'heavy', mode: 'race' }); var o = a.filter({ up: true, left: true }, car, { dt: 1 / 60, params: p }); return [o, a.debug()]; }
  var r1 = first(player), r2 = first(state), r3 = first(snap);
  assert.ok(Math.abs(r1[1].beta_deg - r2[1].beta_deg) < 1e-9, 'state frame');
  assert.ok(Math.abs(r1[1].beta_deg - r3[1].beta_deg) < 1e-6, 'snapshot world velocity rotated into the car frame');
  assert.ok(Math.abs(r1[0].steer - r2[0].steer) < 1e-9);
  // snapshot without yawRate: derived from heading change between frames
  var a = A.create({ level: 'heavy', mode: 'race' });
  a.filter({}, { heading: 0, speed: 20, vx: 20, vy: 0 }, { dt: 0.1, params: p });
  a.filter({}, { heading: 0.05, speed: 20, vx: 20 * Math.cos(0.05), vy: 20 * Math.sin(0.05) }, { dt: 0.1, params: p });
  assert.ok(a.debug().beta_deg !== undefined);
});

test('engineHook(): filters the player car only, keeps engine flags, drops TC in drift mode', function () {
  var p = rawParams('def');
  var a = A.create({ level: 'heavy', mode: 'drift' });
  var hook = a.engineHook(function () { return { right: true, up: true }; });
  var st = V.createState(p, { x: 0, y: 0, heading: 0, speed: 20 }, { autoShift: true });
  var player = { isPlayer: true, state: st, params: p, ctx: {} }, ai = { isPlayer: false, state: st, params: p };
  var engIn = { throttle: 0.3, brake: 0, steer: 0.5, requestReset: true };
  var r = hook.preStep(player, engIn, 1 / 120);
  assert.ok(r.steer < 0 && r.throttle > 0, 'player gets the assisted input');
  assert.strictEqual(r.requestReset, true, 'engine flags preserved');
  assert.strictEqual(hook.preStep(ai, engIn, 1 / 120), engIn, 'AI untouched');
  var env = hook.vehicleEnv(player, { gripMult: 1, assists: { tc: true, abs: true } });
  assert.strictEqual(env.assists.tc, false, 'drift mode: TC off for the player');
  assert.strictEqual(env.assists.abs, true);
});

/* ================================================================ drift lock: novice bots through the REAL engine
   CB.race.drift.createSession (engine + walls + drift tune) with the player driven by CB.race.assist ONLY:
   the arcade drift lock (js/race/drift/arcade.js, which shapes the vehicle state) is hidden for these tests,
   so everything below is the assist's own inputs through the real tyre model. */
['js/race/ai.js', 'js/race/engine.js', 'js/game/challenges.js', 'js/race/drift/scoring.js', 'js/race/drift/ai.js',
 'js/race/drift/session.js'].forEach(tryLoad);
var DRIFT_TRACKS = ['kurogane-pass', 'dockyard-sliders', 'circle-lab'];
function haveSession() {
  return !!(CB.race.drift && typeof CB.race.drift.createSession === 'function' && CB.race.engine && T && T.get &&
    DRIFT_TRACKS.every(function (id) { return !!T.get(id); }));
}
/** Runs fn with the arcade drift lock hidden, so the session falls back to CB.race.assist. */
function pureAssist(fn) {
  var D = CB.race.drift, had = Object.prototype.hasOwnProperty.call(D, 'arcade'), saved = D.arcade;
  D.arcade = undefined;
  try { return fn(); } finally { if (had) D.arcade = saved; else delete D.arcade; }
}
function lcg(seed) { var x = seed >>> 0 || 1; return function () { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }
function curvAt(geom, s) {
  var S = geom.samples, L = geom.length || S[S.length - 1].s; s = ((s % L) + L) % L;
  var lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (S[m].s <= s) lo = m; else hi = m; }
  return S[lo].curvature || 0;
}
/** kind: 'novice' (Up + arrow toward each corner's inside, timing jitter +-0.4 s), 'tap' (a 0.15-0.3 s tap per corner),
    'mash' (random arrows / brake / lifts), 'up' (Up only). onFrame(session, playerState, t, assistDebug, car). */
function driveBot(o) {
  return pureAssist(function () {
    var s = CB.race.drift.createSession({ trackId: o.track, mode: 'free', seed: o.seed || 1, assist: o.level || 'heavy', build: o.build });
    var geom = s.geom, r = lcg(o.seed || 1), dt = 1 / 60, t = 0;
    var R = { spins: 0, walls: 0, driftT: 0, offT: 0, maxAng: 0, lap: 0, t: 0, notes: [] };
    var pend = 0, pendT = 0, cur = 0, tapEnd = -1, mashT = 0, mash = {};
    while (t < (o.maxT || 600)) {
      var ps = s.playerState(), raw = { up: true };
      if ((o.kind === 'novice' || o.kind === 'tap') && ps) {
        var k = curvAt(geom, (ps.s || 0) + ps.speed * 0.6), want = k > 0.008 ? -1 : k < -0.008 ? 1 : 0;
        if (want !== pend) { pend = want; pendT = t + (r() * 0.8 - 0.4); tapEnd = -1; }
        if (o.kind === 'novice') { if (t >= pendT) cur = pend; }
        else { if (t >= pendT && tapEnd < 0 && pend) { tapEnd = t + 0.15 + r() * 0.15; cur = pend; } if (tapEnd > 0 && t > tapEnd) cur = 0; }
        if (cur < 0) raw.left = true; else if (cur > 0) raw.right = true;
      } else if (o.kind === 'mash') {
        if (t > mashT) { mashT = t + 0.1 + r() * 0.6; mash = { left: r() < 0.4, right: r() < 0.4, down: r() < 0.1 }; }
        raw.left = mash.left; raw.right = mash.right; raw.down = mash.down; raw.up = r() < 0.97;
      }
      if (o.rawFn) raw = o.rawFn(t, ps, raw);
      s.update(dt, raw); t += dt;
      var snap = s.snapshot();
      (snap.events || []).forEach(function (e) {
        if (e.type === 'wall' && e.carId === 'player' && e.intensity > 0.05) { R.walls++; R.notes.push('wall@' + Math.round(ps ? ps.s : 0) + 'm'); }
      });
      ps = s.playerState();
      var dbgSess = s._debug ? s._debug() : {}, car = dbgSess.playerCar, ad = dbgSess.assist && dbgSess.assist.debug ? dbgSess.assist.debug() : {};
      if (ps && ps.speed > 3) {
        if (ps.angle_deg > 85) { R.spins++; R.notes.push('spin@' + t.toFixed(1) + 's'); }
        if (ps.angle_deg > 15 && ps.speed > 8) R.driftT += dt;
        R.maxAng = Math.max(R.maxAng, ps.angle_deg);
      }
      if (ps && ps.offTrack) R.offT += dt;
      if (o.onFrame) o.onFrame(s, ps, t, ad, car);
      var me = snap.cars.filter(function (c) { return c.isPlayer; })[0];
      R.lap = me ? me.lap : 0;
      if (o.laps && R.lap > o.laps) break;
    }
    R.t = t; R.drift = R.driftT / Math.max(1, t);
    return R;
  });
}
function botStr(o, R) {
  return o.track + ' ' + (o.level || 'heavy') + '/' + o.kind + ' seed ' + (o.seed || 1) + ': lap ' + R.lap + ' t ' + R.t.toFixed(0) + 's spins ' + R.spins +
    ' walls ' + R.walls + ' off ' + R.offT.toFixed(1) + 's drift ' + (R.drift * 100).toFixed(0) + '% max ' + R.maxAng.toFixed(0) + 'deg ' + R.notes.slice(0, 4).join(' ');
}
/** yaw-rate jitter (rms deviation from a 0.5 s moving average, rad/s) and steer-direction reversals over [a, b) */
function smoothness(r, steer, a, b) {
  var hp = 0, n = 0, rev = 0, lds = 0;
  for (var i = a + 1; i < b; i++) {
    var m = 0, cnt = 0;
    for (var k = Math.max(a, i - 15); k <= Math.min(b - 1, i + 15); k++) { m += r[k]; cnt++; }
    hp += Math.pow(r[i] - m / cnt, 2); n++;
    var ds = steer[i] - steer[i - 1];
    if (Math.abs(ds) > 2e-4) { if (lds && Math.sign(ds) !== Math.sign(lds)) rev++; lds = ds; }
  }
  return { jitter: Math.sqrt(hp / Math.max(1, n)), reversals: rev, secs: n / 60 };
}

test('NOVICE (a) heavy: Up + sloppy arrows toward each inside (+-0.4 s) -> 3 laps, 0 spins, 0 walls, on every drift track', function () {
  if (!haveSession()) { console.log('    (drift session unavailable — skipped)'); return; }
  DRIFT_TRACKS.forEach(function (tr) {
    [3, 7].forEach(function (seed) {
      var o = { track: tr, level: 'heavy', kind: 'novice', seed: seed, laps: 3, maxT: 900 }, R = driveBot(o);
      assert.ok(R.lap > 3, '3 laps: ' + botStr(o, R));
      assert.strictEqual(R.spins, 0, 'no spin: ' + botStr(o, R));
      assert.strictEqual(R.walls, 0, 'no wall hit: ' + botStr(o, R));
      assert.ok(R.offT < 0.3, 'stays on the road: ' + botStr(o, R));
      assert.ok(R.drift > 0.3, 'actually drifts the corners: ' + botStr(o, R));
      assert.ok(R.maxAng < 60, 'never near a spin: ' + botStr(o, R));
    });
  });
});

test('NOVICE heavy: a single short tap per corner is enough (the drift lock holds the slide)', function () {
  if (!haveSession()) return;
  DRIFT_TRACKS.forEach(function (tr) {
    var o = { track: tr, level: 'heavy', kind: 'tap', seed: 2, laps: 2, maxT: 700 }, R = driveBot(o);
    assert.ok(R.lap > 2 && R.spins === 0 && R.walls === 0 && R.offT < 0.3, botStr(o, R));
    assert.ok(R.drift > 0.3, 'taps still drift the corners: ' + botStr(o, R));
  });
});

test('NOVICE (b) heavy: random arrow mashing never spins (and never passes 80 deg)', function () {
  if (!haveSession()) return;
  DRIFT_TRACKS.forEach(function (tr) {
    [1, 2, 3, 4, 5].forEach(function (seed) {
      var o = { track: tr, level: 'heavy', kind: 'mash', seed: seed, maxT: 90 }, R = driveBot(o);
      assert.strictEqual(R.spins, 0, 'mash never spins: ' + botStr(o, R));
      assert.ok(R.maxAng < 80, 'never past 80 deg: ' + botStr(o, R));
      assert.strictEqual(R.walls, 0, 'mash never hits a wall: ' + botStr(o, R));
    });
  });
});

test('NOVICE (c) auto: holding just Up completes laps drifting, on every drift track', function () {
  if (!haveSession()) return;
  DRIFT_TRACKS.forEach(function (tr) {
    var o = { track: tr, level: 'auto', kind: 'up', seed: 1, laps: 2, maxT: 700 }, R = driveBot(o);
    assert.ok(R.lap > 2, '2 laps: ' + botStr(o, R));
    assert.strictEqual(R.spins, 0, botStr(o, R));
    assert.strictEqual(R.walls, 0, botStr(o, R));
    assert.ok(R.offT < 0.3, botStr(o, R));
    assert.ok(R.drift > 0.2, 'auto drifts the corners by itself: ' + botStr(o, R));
  });
});

test('NOVICE heavy: releasing every arrow (Up only) keeps the car on the road — no drifting, no walls', function () {
  if (!haveSession()) return;
  DRIFT_TRACKS.forEach(function (tr) {
    var o = { track: tr, level: 'heavy', kind: 'up', seed: 1, laps: 2, maxT: 700 }, R = driveBot(o);
    assert.ok(R.lap > 2 && R.walls === 0 && R.offT < 0.3 && R.spins === 0, botStr(o, R));
    assert.ok(R.maxAng < 12, 'no drifts without a direction key: ' + botStr(o, R));
  });
});

test('NOVICE heavy: every preset car gets round every drift track (sloppy arrows, 2 laps, 0 walls / spins)', function () {
  if (!haveSession() || !CB.data || !CB.data.presets) return;
  var ids = (Array.isArray(CB.data.presets) ? CB.data.presets.map(function (p) { return p.id; }) : Object.keys(CB.data.presets));
  // a representative spread (all 14 pass in tuning runs; kept to 5 here for test time)
  ['muscle', 'hot-hatch', 'track-weapon', 'rally-legend', 'desert-runner'].filter(function (id) { return ids.indexOf(id) >= 0; }).forEach(function (id) {
    DRIFT_TRACKS.forEach(function (tr) {
      var o = { track: tr, level: 'heavy', kind: 'novice', seed: 3, laps: 2, maxT: 700, build: CB.data.presetBuild(id) }, R = driveBot(o);
      assert.ok(R.lap > 2 && R.spins === 0 && R.walls === 0 && R.offT < 0.5, id + ' ' + botStr(o, R));
    });
  });
});

test('SUSTAIN + SMOOTH: the drift lock holds a 10+ s slide on the skidpad circle with low yaw jitter / few steer reversals', function () {
  if (!haveSession()) return;
  [['heavy', 'novice'], ['auto', 'up']].forEach(function (c) {
    var runs = [], cur = null;
    driveBot({ track: 'circle-lab', level: c[0], kind: c[1], seed: 1, maxT: 120, laps: 1, onFrame: function (s, ps, t, d, car) {
      if (d.drifting && car) { if (!cur) { cur = { r: [], st: [], ang: [] }; runs.push(cur); } cur.r.push(car.state.yawRate); cur.st.push(d.steerOut); cur.ang.push(ps.angle_deg); }
      else cur = null;
    } });
    runs.sort(function (a, b) { return b.r.length - a.r.length; });
    var run = runs[0];
    assert.ok(run && run.r.length / 60 >= 10, c[0] + ': longest held drift ' + (run ? (run.r.length / 60).toFixed(1) : 0) + ' s (>= 10 s)');
    var a = 90, b = run.r.length - 30, m = smoothness(run.r, run.st, a, b);       // skip the entry and the exit
    var settled = run.ang.slice(240, run.r.length - 90);                      // 4 s in (entry built) .. 1.5 s before the corner exit
    assert.ok(m.jitter < 0.03, c[0] + ': yaw-rate jitter ' + m.jitter.toFixed(4) + ' rad/s (< 0.03)');
    assert.ok(m.reversals <= 10, c[0] + ': ' + m.reversals + ' steer reversals in ' + m.secs.toFixed(1) + ' s (<= 10)');
    assert.ok(Math.min.apply(null, settled) > 18, c[0] + ': the angle never collapses mid-corner (min ' + Math.min.apply(null, settled).toFixed(0) + ' deg)');
    assert.ok(Math.max.apply(null, settled) < 45, c[0] + ': no over-rotation (max ' + Math.max.apply(null, settled).toFixed(0) + ' deg)');
  });
});

test('SMOOTH: a steady skidpad donut (no track) is rock steady — no yaw jitter, no steering hunt', function () {
  ['def', 'muscle', 'hot-hatch', 'track-weapon'].forEach(function (id) {
    var p = driftParams(id), rr = [], ss = [];
    var a = A.create({ level: 'heavy', mode: 'drift' }), s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 16.7 }, { autoShift: true });
    var env = { assists: { tc: false, abs: true, autoShift: true } };
    for (var i = 0; i < 16 * 60; i++) {
      var inp = a.filter({ right: true, up: true }, s, { dt: 1 / 60, params: p });
      V.step(p, s, inp, 1 / 120, env); V.step(p, s, inp, 1 / 120, env);
      rr.push(s.yawRate); ss.push(inp.steer);
    }
    var m = smoothness(rr, ss, 4 * 60, 16 * 60);
    assert.ok(m.jitter < 0.01, id + ': donut yaw jitter ' + m.jitter.toFixed(4));
    assert.ok(m.reversals <= 4, id + ': donut steer reversals ' + m.reversals);
  });
});

test('DRIFT LOCK: holding keeps the slide, the opposite arrow / lifting Up ends it smoothly (no spin, no off)', function () {
  if (!haveSession()) return;
  function run(action) {
    var tA = null, log = [];
    driveBot({ track: 'circle-lab', level: 'heavy', kind: 'none', seed: 1, maxT: 45, rawFn: function (t, ps, raw) {
      raw = { up: true };
      if (!ps) return raw;
      if (tA == null) { if (ps.s > 380 && ps.s < 640) raw.left = true; }
      else {
        var e = t - tA;
        if (action === 'opp' && e < 0.3) raw.right = true;
        if (action === 'lift') raw.up = false;
        if (action === 'hold' && ps.s > 380 && ps.s < 640) raw.left = true;
      }
      return raw;
    }, onFrame: function (s, ps, t, d) {
      if (tA == null && d.drifting && ps.angle_deg > 18 && ps.s > 470 && ps.s < 520) tA = t;
      else if (tA != null) log.push([t - tA, ps.angle_deg, ps.offTrack]);
    } });
    assert.ok(tA != null, action + ': got into the drift');
    function at(x) { for (var k = 0; k < log.length; k++) if (log[k][0] >= x) return log[k][1]; return log[log.length - 1][1]; }
    return { at: at, max: Math.max.apply(null, log.map(function (l) { return l[1]; })), off: log.some(function (l) { return l[2]; }) };
  }
  var hold = run('hold'), opp = run('opp'), lift = run('lift');
  assert.ok(hold.at(5) > 18 && hold.at(2) > 18, 'held 5 s later (' + hold.at(5).toFixed(0) + ' deg)');
  assert.ok(opp.at(1.5) < 10 && opp.max < 40 && !opp.off, 'opposite arrow straightens within 1.5 s (' + opp.at(1.5).toFixed(0) + ' deg)');
  assert.ok(lift.at(1.5) < 10 && lift.max < 40 && !lift.off, 'lifting Up straightens within 1.5 s (' + lift.at(1.5).toFixed(0) + ' deg)');
  assert.ok(opp.at(0.25) > 8, 'but not with a snap (still ' + opp.at(0.25).toFixed(0) + ' deg after 0.25 s)');
});

test('LOW SPEED (<30 km/h): launch with arrows held is a normal easy car — no rear slide, no steering snaps', function () {
  if (!haveSession()) return;
  ['heavy', 'auto'].forEach(function (lv) {
    var maxRear = 0, maxStep = 0, prev = null;
    var R = driveBot({ track: 'circle-lab', level: lv, kind: 'none', seed: 2, maxT: 6, rawFn: function (t) {
      var i = Math.round(t * 60); return { up: true, left: i > 30 && i < 75, right: i > 150 && i < 250 };
    }, onFrame: function (s, ps, t, d, car) {
      var b = car.params.wheelbase * (car.params.weightFront || 0.5);
      var rear = Math.abs(Math.atan2(ps.vyLocal - ps.yawRate * b, Math.max(0.5, Math.abs(ps.vxLocal)))) / DEG;
      if (ps.speed * 3.6 < 30 && ps.speed > 1.5) maxRear = Math.max(maxRear, rear);
      var st = car.input ? car.input.steer : d.steerOut;
      if (prev != null) maxStep = Math.max(maxStep, Math.abs(st - prev));
      prev = st;
    } });
    assert.strictEqual(R.spins, 0);
    assert.ok(maxRear < 8, lv + ': no rear slide at low speed (' + maxRear.toFixed(1) + ' deg)');
    assert.ok(maxStep < 0.08, lv + ': steer never snaps (max step ' + maxStep.toFixed(3) + ' per frame)');
  });
});

test('RECOVERY: a car thrown to 70-85 deg on a drift track is caught (never rotates further, straight within 3.5 s)', function () {
  if (!T || !T.get || !T.get('circle-lab')) return;
  var p = driftParams('def');
  DRIFT_TRACKS.forEach(function (tr) {
    var g = T.geometry(tr), sm = g.samples[Math.round(400 / g.ds) % g.samples.length];
    [85, -85, 70].forEach(function (bd) {
      [60, 90].forEach(function (kph) {
        var v = kph / 3.6, b = bd * DEG;
        var s = V.createState(p, { x: sm.x, y: sm.y, heading: sm.heading - b, speed: v }, { autoShift: true });
        s.vx = v * Math.cos(b); s.vy = v * Math.sin(b); s.yawRate = 0;
        var a = A.create({ level: 'heavy', mode: 'drift' }), env = { assists: { tc: false, abs: true, autoShift: true } }, mx = 0, tOk = null;
        for (var k = 0; k < 60 * 4; k++) {
          var inp = a.filter({ up: true }, s, { dt: 1 / 60, params: p, geom: g });
          V.step(p, s, inp, 1 / 120, env); V.step(p, s, inp, 1 / 120, env);
          var be = Math.abs(betaOf(s)) / DEG;
          mx = Math.max(mx, be);
          if (tOk == null && be < 20 && k > 3) tOk = k / 60;
        }
        var tag = tr + ' ' + bd + ' deg @' + kph + ' km/h';
        assert.ok(mx <= Math.abs(bd) + 2, tag + ': never rotates further (max ' + mx.toFixed(0) + ')');
        assert.ok(tOk != null && tOk < 3.5, tag + ': straight (< 20 deg) after ' + tOk + ' s');
      });
    });
  });
});

if (standalone) {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
}

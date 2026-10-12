/* Node tests for js/race/drift/tune.js (CB.race.drift.tune)
   Run standalone: node tests/drift-tune.test.js   (or via node tests/run.js drift-tune) */
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
var T = require(path.join(root, 'js', 'race', 'drift', 'tune.js'));
var CB = globalThis.CB;

/* ------------------------------------------------------------ harness */
var standalone = require.main === module || typeof globalThis.test !== 'function';
var passed = 0, failed = 0;
function test(name, fn) {
  name = 'drift-tune: ' + name;
  if (!standalone) return globalThis.test(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ------------------------------------------------------------ fixtures */
var DEG = Math.PI / 180;
function clone(o) { return JSON.parse(JSON.stringify(o)); }
var BASE_BUILD = {
  version: 1, meta: { name: 'Drift Fixture' },
  body: { style: 'coupe', chassisMaterial: 'steel', wheelbase_mm: 2650, trackWidth_mm: 1600 },
  engine: { type: 'ice', layout: 'I6', displacement_l: 3.0, aspiration: 'turbo', boost_bar: 0.9, compression: 10, fuel: 'premium',
    redline_rpm: 7000, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard' },
  transmission: { type: 'manual', gears: 6, finalDrive: 3.7 },
  drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, tractionControl: 2 },
  suspension: { type: 'double-wishbone', springFront_nmm: 60, springRear_nmm: 70, damping: 5, rideHeight_mm: 120,
    camberFront_deg: -1.5, camberRear_deg: -1, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4 },
  brakes: { material: 'iron', frontRotor_mm: 350, rearRotor_mm: 330, frontPistons: 4, rearPistons: 2, abs: 'standard' },
  wheels: { material: 'cast', diameter_in: 18 },
  tires: { compound: 'performance', widthFront_mm: 245, widthRear_mm: 265, profileFront: 40, profileRear: 35 },
  aero: { splitter: 'none', wing: 'none', diffuser: 'none' },
  weight: {}, interior: { steering: 'round' }
};
function baseBuild() {
  var b = CB.data && typeof CB.data.defaultBuild === 'function' ? CB.data.defaultBuild() : clone(BASE_BUILD);
  b.body.style = 'coupe';
  b.drivetrain.layout = 'rwd';
  b.drivetrain.torqueSplitFront_pct = 0;
  return b;
}
/** 300 hp RWD coupe. */
var M300 = { power_hp: 300, power_kw: 300 * 0.7457, weight_kg: 1350, weightFront_pct: 52 };
function coupe300() { return V.fromBuild(baseBuild(), M300); }
function withLayout(layout, split) {
  var b = baseBuild();
  b.drivetrain.layout = layout;
  b.drivetrain.torqueSplitFront_pct = split;
  if (layout === 'awd') b.drivetrain.centerDiff = 'lsd-viscous';
  return V.fromBuild(b, { power_hp: 300, power_kw: 300 * 0.7457, weight_kg: 1400, weightFront_pct: layout === 'fwd' ? 60 : 55 });
}
function presetParams(id) {
  if (!CB.data || typeof CB.data.presetBuild !== 'function') return null;
  try { return V.fromBuild(CB.data.presetBuild(id)); } catch (e) { return null; }
}

/* ---------------------------------------------------- skidpad simulation
   Simple counter-steer driver, identical for tuned and untuned cars:
     initiation: full throttle + a fixed 0.3/0.6 rad turn-in + short handbrake flick, until |beta| > 12 deg
     hold:       wheel angle = kc * beta + bias (steer toward the velocity vector),
                 throttle = thr + kt * (30 deg - |beta|)
   Returns the longest continuous window with 20 deg <= |beta| <= 45 deg (no spin: |beta| > 80 deg ends the run). */
function skidpad(p, o) {
  var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 15 });
  var dt = 1 / 120, init = true, spun = false, cur = 0, longest = 0, maxBeta = 0;
  var n = Math.round((o.T || 15) / dt);
  for (var i = 0; i < n; i++) {
    var t = i * dt;
    var beta = Math.atan2(s.vy, Math.abs(s.vx) + 0.5);
    if (init && (t > 0.8 || Math.abs(beta) > 12 * DEG)) init = false;
    var inp;
    if (init) inp = { throttle: 1, steer: Math.min(1, o.sInit * 0.6 / p.lockAngle), handbrake: t > 0.1 && t < 0.35 };
    else {
      var delta = o.kc * beta + o.bias;
      var thr = Math.max(0, Math.min(1, o.thr + o.kt * (30 * DEG - Math.abs(beta))));
      inp = { throttle: thr, steer: Math.max(-1, Math.min(1, delta / p.lockAngle)), handbrake: false };
    }
    V.step(p, s, inp, dt, {});
    assert.ok(isFinite(s.x) && isFinite(s.vy) && isFinite(s.yawRate), 'finite state');
    var bd = Math.abs(beta) / DEG;
    if (!init) maxBeta = Math.max(maxBeta, bd);
    if (bd > 80) spun = true;
    if (!spun && !init && bd >= 20 && bd <= 45 && s.speed > 4) { cur += dt; if (cur > longest) longest = cur; } else cur = 0;
  }
  return { longest: longest, spun: spun, maxBeta: maxBeta };
}
var CONTROLLERS = [];
[0.8, 1.0, 1.2].forEach(function (kc) {
  [0.15, 0.25].forEach(function (bias) {
    [0.4, 0.6].forEach(function (thr) {
      [0.5, 1].forEach(function (sInit) { CONTROLLERS.push({ kc: kc, bias: bias, thr: thr, kt: 2, sInit: sInit }); });
    });
  });
});
function evaluate(p) {
  var best = 0, sum = 0, good = 0;
  CONTROLLERS.forEach(function (c) {
    var r = skidpad(p, c);
    best = Math.max(best, r.longest); sum += r.longest; if (r.longest >= 6) good++;
  });
  return { best: best, mean: sum / CONTROLLERS.length, good: good };
}

function allFinite(o, pathStr, seen) {
  seen = seen || [];
  if (typeof o === 'number') { assert.ok(isFinite(o) || o === Infinity, pathStr + ' not finite: ' + o); return; }
  if (!o || typeof o !== 'object' || seen.indexOf(o) >= 0) return;
  seen.push(o);
  Object.keys(o).forEach(function (k) {
    if (k === 'governor') return; // Infinity = no governor (vehicle.js convention)
    allFinite(o[k], pathStr + '.' + k, seen);
  });
}

/* ================================================================ tests */

test('module registers on CB.race.drift.tune with the spec API', function () {
  assert.strictEqual(CB.race.drift.tune, T);
  ['apply', 'recommendedBuildPatch', 'forBuild', 'wrapVehicle', 'gearFor', 'levelInfo'].forEach(function (k) {
    assert.strictEqual(typeof T[k], 'function', k);
  });
  assert.strictEqual(T.DEFAULT_LEVEL, 'street');
  assert.deepStrictEqual(T.LEVEL_ORDER, ['grip', 'street', 'pro', 'competition']);
});

test('apply is pure: input untouched, output is a new frozen object', function () {
  var p0 = coupe300();
  var snap = JSON.stringify(p0);
  var p1 = T.apply(p0);
  assert.notStrictEqual(p1, p0);
  assert.strictEqual(JSON.stringify(p0), snap, 'input mutated');
  assert.ok(Object.isFrozen(p1));
  assert.strictEqual(p1.drift.level, 'street', 'default level is street');
  assert.ok(p1.drift.tuned);
  // unfrozen input works too and is not mutated
  var p2 = JSON.parse(snap);
  var copy = JSON.stringify(p2);
  T.apply(p2, { level: 'pro' });
  assert.strictEqual(JSON.stringify(p2), copy);
  // unknown level -> default
  assert.strictEqual(T.apply(p0, { level: 'nope' }).drift.level, 'street');
});

test('spec changes: more lock (<= 60 deg), locked rear, rear grip down / front up, quicker rack, no TC', function () {
  var p0 = coupe300();
  T.LEVEL_ORDER.forEach(function (lv) {
    var p = T.apply(p0, { level: lv });
    assert.ok(p.lockAngle >= p0.lockAngle - 1e-9, lv + ' lock');
    assert.ok(p.lockAngle <= 60 * DEG + 1e-9, lv + ' lock <= 60');
    assert.strictEqual(p.maxSteer, p.lockAngle);
    assert.ok(p.steerRate > p0.steerRate, lv + ' steer rate');
    assert.ok(p.lockR >= Math.max(p0.lockR, 0.6), lv + ' rear diff');
    assert.ok(p.muR < p0.muR && p.muF > p0.muF, lv + ' grip balance');
    assert.ok(p.muR > p0.muR * 0.85, lv + ' rear grip only slightly lower');
    assert.ok(p.shapeC <= p0.shapeC && Math.abs(p.shapeB - Math.tan(Math.PI / (2 * p.shapeC))) < 1e-9, lv + ' progressive tyre');
    assert.ok(p.handbrakeTorque > p0.handbrakeTorque, lv + ' handbrake');
    assert.ok(p.driftGearing && p.driftGearing.holdGear && p.driftGearing.minRpm < p.driftGearing.maxRpm, lv + ' gearing hint');
    p.upshiftRpm.forEach(function (u, i) { assert.ok(u >= p0.upshiftRpm[i] - 1e-6 && u <= p.redline, lv + ' upshift ' + i); });
  });
  assert.ok(Math.abs(T.apply(p0, { level: 'competition' }).lockAngle - 60 * DEG) < 1e-9);
  assert.strictEqual(T.apply(p0, { level: 'street' }).tcLevel, 0);
  assert.strictEqual(T.apply(p0, { level: 'pro' }).lockR, 1);
});

test('300 hp RWD coupe holds a 30 deg skidpad drift much longer when tuned', function () {
  var p0 = coupe300();
  assert.strictEqual(p0.layout, 'rwd');
  assert.ok(Math.abs(p0.power_hp - 300) < 30, 'fixture ~300 hp, got ' + p0.power_hp);
  var u = evaluate(p0);
  var t = evaluate(T.apply(p0, { level: 'street' }));
  if (standalone) console.log('     untuned', JSON.stringify(u), '\n     tuned  ', JSON.stringify(t));
  assert.ok(t.best >= 8, 'tuned car sustains >= 8 s of 20-45 deg drift (got ' + t.best.toFixed(2) + ')');
  assert.ok(t.best > u.best + 3, 'tuned best ' + t.best.toFixed(2) + ' vs untuned ' + u.best.toFixed(2));
  assert.ok(t.mean > u.mean, 'tuned mean ' + t.mean.toFixed(2) + ' vs untuned ' + u.mean.toFixed(2));
  assert.ok(t.good > u.good, 'more controllers succeed when tuned');
});

test('FWD and AWD builds become RWD-biased and drift-capable', function () {
  var cars = [['fwd', withLayout('fwd', 100)], ['awd', withLayout('awd', 40)]];
  var hh = presetParams('hot-hatch'); if (hh) cars.push(['hot-hatch', hh]);
  var rl = presetParams('rally-legend'); if (rl) cars.push(['rally-legend', rl]);
  cars.forEach(function (c) {
    var name = c[0], p0 = c[1];
    assert.ok(p0.layout === 'fwd' || p0.layout === 'awd', name + ' fixture layout ' + p0.layout);
    var p = T.apply(p0, { level: 'street' });
    assert.ok(p.splitF <= 0.1 + 1e-9, name + ' front share ' + p.splitF);
    assert.ok(p.layout === 'awd' || p.layout === 'rwd');
    assert.ok(p.drift.rearBias >= 0.9);
    assert.ok(p.lockC <= 0.05, name + ' centre coupling relaxed');
    var comp = T.apply(p0, { level: 'competition' });
    assert.strictEqual(comp.layout, 'rwd', name + ' competition = full RWD');
    assert.strictEqual(comp.splitF, 0);
    var u = evaluate(p0), t = evaluate(p);
    if (standalone) console.log('     ' + name, 'untuned', u.best.toFixed(1), 'tuned', t.best.toFixed(1), 'good', t.good + '/' + CONTROLLERS.length);
    assert.ok(t.best >= 6, name + ' tuned sustains a drift >= 6 s (got ' + t.best.toFixed(2) + ')');
    assert.ok(t.best > u.best + 2, name + ' tuned ' + t.best.toFixed(2) + ' vs untuned ' + u.best.toFixed(2));
  });
});

test('every preset (street tune) holds a >= 8 s skidpad drift with a plain counter-steer driver', function () {
  var presets = (CB.data && CB.data.presets) || [];
  if (!presets.length) { console.log('     (no CB.data.presets; skipped)'); return; }
  // controllers #18/#19 of the grid: kc 1.2, bias 0.15, thr 0.6 (init 0.5 / 1). Before the full-RWD conversion and the
  // rear peak-slip cap, rally-legend / eco-commuter / desert-runner spun within 0.5 s for every controller.
  var ctl = [{ kc: 1.2, bias: 0.15, thr: 0.6, kt: 2, sInit: 0.5 }, { kc: 1.2, bias: 0.15, thr: 0.6, kt: 2, sInit: 1 }];
  var worst = Infinity, worstId = '';
  presets.forEach(function (pr) {
    var p = T.apply(V.fromBuild(CB.data.presetBuild(pr.id)), { level: 'street' });
    var best = Math.max.apply(null, ctl.map(function (c) { return skidpad(p, c).longest; }));
    if (best < worst) { worst = best; worstId = pr.id; }
    assert.ok(best >= 8, pr.id + ' tuned best held drift ' + best.toFixed(2) + ' s');
  });
  if (standalone) console.log('     weakest preset ' + worstId + ' ' + worst.toFixed(1) + ' s');
});

/* ------------------------------------------- steady-drift smoothness
   Smooth closed-loop driver (80 ms filtered steer/throttle, counter-steer + light yaw damping, PI throttle on
   |beta| -> 30 deg). Measures, over t = 8..20 s: yaw-rate jitter (RMS of yawRate minus its 1 s centred moving
   average), drift-angle band, and gear changes made while sliding. */
function steadyDrift(p) {
  var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 14 });
  var dt = 1 / 120, st = 0, thrF = 0.6, iT = 0, tgt = 30 * DEG, init = true, spun = false;
  var yr = [], bs = [], sts = [], slideShifts = 0, g0 = s.gear;
  for (var i = 0; i < 20 * 120; i++) {
    var t = i * dt, beta = Math.atan2(s.vy, Math.abs(s.vx) + 0.5), stT, thT, hb = false;
    if (init && (Math.abs(beta) > 15 * DEG || t > 1.2)) init = false;
    if (init) { stT = 0.6 / p.lockAngle; thT = 1; hb = t > 0.1 && t < 0.3; }
    else {
      var e = Math.abs(beta) - tgt;
      iT = Math.max(-0.5, Math.min(0.5, iT - e * dt * 0.5));
      stT = (1.2 * beta + 0.15 - 0.1 * s.yawRate) / p.lockAngle;
      thT = 0.6 - 2 * e + iT;
    }
    stT = Math.max(-1, Math.min(1, stT)); thT = Math.max(0, Math.min(1, thT));
    var a = 1 - Math.exp(-dt / 0.08);
    st += (stT - st) * a; thrF += (thT - thrF) * a;
    V.step(p, s, { steer: st, throttle: thrF, handbrake: hb }, dt, {});
    if (Math.abs(beta) > 80 * DEG) spun = true;
    if (t > 8) {
      yr.push(s.yawRate); bs.push(Math.abs(beta) / DEG); sts.push(st);
      if (s.gear !== g0 && Math.abs(beta) > 15 * DEG) slideShifts++;
    }
    g0 = s.gear;
  }
  var w = 60, j = 0, n = 0;
  for (var k = w; k < yr.length - w; k++) {
    var m = 0;
    for (var q = k - w; q <= k + w; q++) m += yr[q];
    m /= 2 * w + 1; j += (yr[k] - m) * (yr[k] - m); n++;
  }
  return { spun: spun, jitter: Math.sqrt(j / n), minB: Math.min.apply(null, bs), maxB: Math.max.apply(null, bs), slideShifts: slideShifts,
    reversals: reversals(sts, 0.02) };
}
/** Number of direction reversals of a signal, with hysteresis `h` (a reversal counts once the signal has moved
    back by more than h from its last extreme) -> sawing at the wheel, not slow drift of the operating point. */
function reversals(a, h) {
  var n = 0, dir = 0, ext = a.length ? a[0] : 0;
  for (var i = 1; i < a.length; i++) {
    var v = a[i];
    if (dir >= 0 && v > ext) ext = v;
    else if (dir <= 0 && v < ext) ext = v;
    if (dir >= 0 && v < ext - h) { if (dir > 0) n++; dir = -1; ext = v; }
    else if (dir <= 0 && v > ext + h) { if (dir < 0) n++; dir = 1; ext = v; }
  }
  return n;
}
/** RMS of x minus its centred moving average (window +-w samples): high-frequency content = jitter. */
function jitterOf(x, w) {
  var j = 0, n = 0;
  for (var k = w; k < x.length - w; k++) {
    var m = 0;
    for (var q = k - w; q <= k + w; q++) m += x[q];
    m /= 2 * w + 1; j += (x[k] - m) * (x[k] - m); n++;
  }
  return n ? Math.sqrt(j / n) : 0;
}
function presetIds() { return ((CB.data && CB.data.presets) || []).map(function (pr) { return pr.id; }); }
function tunedPreset(id, level, overrides) {
  return T.apply(V.fromBuild(CB.data.presetBuild(id)), { level: level || 'street', overrides: overrides });
}

test('steady 12 s drift is smooth: low yaw-rate jitter, no shifts mid-slide, smoother than the stock auto box', function () {
  var p = T.apply(coupe300(), { level: 'street' });
  var r = steadyDrift(p);
  var stock;
  T.uninstallGearbox(V);
  try { stock = steadyDrift(p); } finally { T.installGearbox(V); }
  if (standalone) console.log('     drift box', JSON.stringify(r), '\n     stock box', JSON.stringify(stock));
  assert.ok(!r.spun, 'no spin');
  assert.ok(r.minB >= 20 && r.maxB <= 45, 'held 20-45 deg the whole window: ' + r.minB.toFixed(1) + '..' + r.maxB.toFixed(1));
  assert.ok(r.jitter < 0.05, 'yaw-rate jitter ' + r.jitter.toFixed(4) + ' rad/s');
  assert.strictEqual(r.slideShifts, 0, 'no gear change while sliding');
  assert.ok(r.jitter < stock.jitter, 'drift box smoother than stock box (' + r.jitter.toFixed(4) + ' vs ' + stock.jitter.toFixed(4) + ')');
  // every preset: the drift box never shifts mid-slide (it used to hunt 1-2-1-2 every ~1 s on the limiter)
  var presets = (CB.data && CB.data.presets) || [];
  presets.forEach(function (pr) {
    var q = steadyDrift(T.apply(V.fromBuild(CB.data.presetBuild(pr.id)), { level: 'street' }));
    if (!q.spun) assert.strictEqual(q.slideShifts, 0, pr.id + ' shifted ' + q.slideShifts + 'x mid-slide');
  });
});

test('SUSTAIN: every preset holds a smooth 30 deg drift for 12 s (no spin, 20-45 deg, no sawing at the wheel)', function () {
  var ids = presetIds();
  if (!ids.length) { console.log('     (no CB.data.presets; skipped)'); return; }
  var worst = 0, worstId = '', sum = 0;
  ids.forEach(function (id) {
    var r = steadyDrift(tunedPreset(id, 'street'));
    assert.ok(!r.spun, id + ' spun');
    assert.ok(r.minB >= 18 && r.maxB <= 47, id + ' left the drift band: ' + r.minB.toFixed(1) + '..' + r.maxB.toFixed(1) + ' deg');
    assert.ok(r.jitter < 0.06, id + ' yaw-rate jitter ' + r.jitter.toFixed(4) + ' rad/s');
    assert.ok(r.reversals <= 12, id + ' steer reversals ' + r.reversals + ' in 12 s');
    sum += r.jitter;
    if (r.jitter > worst) { worst = r.jitter; worstId = id; }
  });
  var mean = sum / ids.length;
  if (standalone) console.log('     mean yaw jitter ' + mean.toFixed(4) + ' rad/s, worst ' + worstId + ' ' + worst.toFixed(4));
  assert.ok(mean < 0.02, 'mean steady-drift yaw jitter ' + mean.toFixed(4));
});

test('SMOOTH: the drift-tyre rear (wide kappa peak) + drift aero halve steady-drift yaw jitter vs the same tune without them', function () {
  var ids = presetIds();
  if (!ids.length) { console.log('     (no CB.data.presets; skipped)'); return; }
  // ablation = the same street tune with the anti-cycling changes switched off
  var OFF = { kapR: 1, clAMax: 1e9, muMax: 1e9, dfFMin: 0 };
  var on = 0, off = 0, offBad = 0, revOn = 0, revOff = 0;
  ids.forEach(function (id) {
    var a = steadyDrift(tunedPreset(id, 'street'));
    var b = steadyDrift(tunedPreset(id, 'street', OFF));
    on += a.jitter; off += b.jitter; revOn += a.reversals; revOff += b.reversals;
    if (b.spun || b.minB < 15) offBad++;
  });
  if (standalone) console.log('     jitter on ' + (on / ids.length).toFixed(4) + ' vs off ' + (off / ids.length).toFixed(4) +
    ' | steer reversals on ' + revOn + ' vs off ' + revOff + ' | ablation lost the drift on ' + offBad + ' presets');
  assert.ok(on < off * 0.5, 'jitter ' + on.toFixed(4) + ' vs ' + off.toFixed(4));
  assert.ok(revOn <= revOff, 'steer reversals ' + revOn + ' vs ' + revOff);
});

test('SUSTAIN+SMOOTH with the real heavy assist: hold Right + Up on a skidpad, every preset, 10 s steady drift', function () {
  var A = null;
  try { A = require(path.join(root, 'js', 'race', 'drift', 'assist.js')); } catch (e) { A = null; }
  if (!A || typeof A.create !== 'function') { console.log('     (assist.js unavailable; skipped)'); return; }
  var ids = presetIds();
  if (!ids.length) { console.log('     (no CB.data.presets; skipped)'); return; }
  var worstJ = 0, worstR = 0, minHold = Infinity, minId = '';
  ids.forEach(function (id) {
    var p = tunedPreset(id, 'street');
    var a = A.create({ level: 'heavy', mode: 'drift' });
    var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 16.7 }, { autoShift: true });
    var env = { assists: { tc: false, abs: true, autoShift: true } };
    var run = 0, best = 0, spun = false, yr = [], steer = [];
    for (var i = 0; i < 14 * 60; i++) {
      var inp = a.filter({ right: true, up: true }, s, { dt: 1 / 60, params: p });
      V.step(p, s, inp, 1 / 120, env); V.step(p, s, inp, 1 / 120, env);
      var b = s.speed > 1.5 ? Math.abs(Math.atan2(s.vy, s.vx)) / DEG : 0;
      if (b > 90) spun = true;
      if (b >= 15 && b <= 50) { run += 1 / 60; best = Math.max(best, run); } else run = 0;
      if (i >= 4 * 60) { yr.push(s.yawRate); steer.push(inp.steer); }   // t = 4..14 s: the steady part
    }
    var j = jitterOf(yr, 30), rv = reversals(steer, 0.02);
    assert.ok(!spun, id + ' spun');
    assert.ok(best >= 10, id + ' held the drift ' + best.toFixed(2) + ' s');
    assert.ok(j < 0.02, id + ' yaw-rate jitter ' + j.toFixed(5) + ' rad/s');
    assert.ok(rv <= 6, id + ' steer reversals ' + rv + ' in 10 s');
    worstJ = Math.max(worstJ, j); worstR = Math.max(worstR, rv);
    if (best < minHold) { minHold = best; minId = id; }
  });
  if (standalone) console.log('     worst jitter ' + worstJ.toExponential(2) + ' rad/s, worst reversals ' + worstR + ', shortest hold ' + minId + ' ' + minHold.toFixed(1) + ' s');
});

test('drift aero / drift tyres: downforce capped + moved forward, active aero off, slicks scaled to drift grip, input untouched', function () {
  var ids = presetIds();
  if (!ids.length) { console.log('     (no CB.data.presets; skipped)'); return; }
  var sawAero = false, sawSlick = false;
  ids.forEach(function (id) {
    var p0 = V.fromBuild(CB.data.presetBuild(id)), snap = JSON.stringify(p0);
    var p = T.apply(p0, { level: 'street' });
    assert.strictEqual(JSON.stringify(p0), snap, id + ' input mutated');
    var L = T.LEVELS.street;
    if (p0.clA > L.clAMax) {
      sawAero = true;
      assert.ok(p.clA < p0.clA && p.clA <= L.clAMax + (p0.clA - L.clAMax) * 0.15 + 1e-9, id + ' clA ' + p0.clA + ' -> ' + p.clA);
      assert.ok(p.dfFrontFrac >= Math.max(p0.dfFrontFrac, L.dfFMin) - 1e-9, id + ' downforce balance moved forward');
    } else assert.strictEqual(p.clA, p0.clA, id + ' low-downforce car untouched');
    if (p0.activeAero) assert.strictEqual(p.activeAero, false, id + ' active aero off');
    assert.ok(p.muR <= L.muMax + 1e-9, id + ' muR ' + p.muR);
    if (p0.muR * L.muR > L.muMax) {
      sawSlick = true;
      assert.ok(Math.abs(p.muF / p.muR - p0.muF * L.muF / (p0.muR * L.muR)) < 0.05, id + ' balance kept when scaling slicks');
    }
    assert.ok(p.kappaPeakR >= p0.kappaPeakR - 1e-12 && p.kappaPeakR <= p0.kappaPeakR * (L.kapR + (L.kapRTail || 0)) + 1e-12, id + ' kappaPeakR');
    if (p0.weightFront <= 0.55 && p0.weightFront >= 0.5) assert.ok(Math.abs(p.kappaPeakR - p0.kappaPeakR * L.kapR) < 1e-9, id + ' full drift-tyre kappa peak');
    if (p0.weightFront >= 0.6) assert.ok(Math.abs(p.kappaPeakR - p0.kappaPeakR) < 1e-9, id + ' nose-heavy: kappa peak faded out');
    if (p0.weightFront <= 0.42) assert.ok(p.kappaPeakR > p0.kappaPeakR * L.kapR + 1e-9, id + ' tail-heavy: extra kappa peak');
  });
  assert.ok(sawAero, 'some preset exercised the aero cap');
  assert.ok(sawSlick, 'some preset exercised the slick scaling');
});

test('power floor: low-power cars get >= ~350 hp effective in drift mode; hypercars softly capped', function () {
  var b = baseBuild();
  var weak = V.fromBuild(b, { power_hp: 140, power_kw: 140 * 0.7457, weight_kg: 1100, weightFront_pct: 55 });
  var p = T.apply(weak);
  assert.ok(p.power_hp >= 349, 'effective hp ' + p.power_hp);
  assert.ok(Math.abs(p.powerKw - p.power_hp * 0.7457) < 1e-6);
  var ratio = p.peakNm / weak.peakNm;
  assert.ok(Math.abs(ratio - p.power_hp / T._hpOf(weak)) < 0.02, 'torque scaled with power');
  assert.ok(Math.abs(p.torqueTable[100] / weak.torqueTable[100] - ratio) < 1e-6);
  assert.ok(T.apply(weak, { level: 'competition' }).power_hp >= 449);
  // capabilities recomputed: more accel with more power
  assert.ok(p.capabilities.accelTable[30] > weak.capabilities.accelTable[30] * 1.3);
  assert.ok(p.capabilities.topSpeed_mps > weak.capabilities.topSpeed_mps);
  var big = V.fromBuild(b, { power_hp: 1500, power_kw: 1500 * 0.7457, weight_kg: 1500, weightFront_pct: 50 });
  var pb = T.apply(big, { level: 'street' });
  assert.ok(pb.power_hp < 1500 && pb.power_hp > 700, 'soft cap ' + pb.power_hp);
  assert.ok(Math.abs(T.apply(big, { level: 'street', powerCap: false }).power_hp - T._hpOf(big)) < 1, 'powerCap:false keeps power');
});

test('all presets x all levels produce finite, sane tuned params', function () {
  var presets = (CB.data && CB.data.presets) || [];
  if (!presets.length) { console.log('     (no CB.data.presets; skipped)'); return; }
  presets.forEach(function (pr) {
    var p0 = V.fromBuild(CB.data.presetBuild(pr.id));
    T.LEVEL_ORDER.forEach(function (lv) {
      var p = T.apply(p0, { level: lv });
      allFinite(p, pr.id + '/' + lv);
      assert.ok(p.lockAngle > 0.6 && p.lockAngle <= 60 * DEG + 1e-9, pr.id + ' lock');
      assert.ok(p.power_hp >= T.LEVELS[lv].minHp - 1, pr.id + '/' + lv + ' hp ' + p.power_hp);
      assert.ok(p.mass === p0.mass && p.Iz > 0 && p.muF > 0 && p.muR > 0);
      assert.ok(p.splitF >= 0 && p.splitF <= T.LEVELS[lv].splitF + 1e-9 || p0.layout === 'rwd');
      assert.ok(p.torqueTable.every(function (x) { return isFinite(x) && x >= 0; }));
      assert.ok(p.capabilities && isFinite(p.capabilities.maxLatG) && p.capabilities.maxLatG > 0.3, pr.id + ' caps');
      assert.ok(isFinite(p.capabilities.est0to100_s) && isFinite(p.maxLatG));
      var g = T.gearFor(p, 20);
      assert.ok(g >= 1 && g <= p.maxGear, pr.id + ' gearFor');
      // drives without NaNs
      var s = V.createState(p, { x: 0, y: 0, heading: 0, speed: 15 });
      for (var i = 0; i < 240; i++) V.step(p, s, { throttle: 1, steer: i < 60 ? 0.6 : -0.3, handbrake: i > 20 && i < 40 }, 1 / 120, {});
      assert.ok(isFinite(s.x) && isFinite(s.yawRate) && s.nanGuard === 0, pr.id + '/' + lv + ' sim');
    });
  });
});

test('grip < street < pro < competition progression', function () {
  var p0 = coupe300();
  var ps = T.LEVEL_ORDER.map(function (lv) { return T.apply(p0, { level: lv }); });
  for (var i = 1; i < ps.length; i++) {
    assert.ok(ps[i].lockAngle >= ps[i - 1].lockAngle, 'lock');
    assert.ok(ps[i].muR <= ps[i - 1].muR, 'rear grip');
    assert.ok(ps[i].lockR >= ps[i - 1].lockR, 'diff');
    assert.ok(ps[i].power_hp >= ps[i - 1].power_hp, 'power floor');
  }
  var info = T.levelInfo('pro');
  assert.strictEqual(info.id, 'pro');
  assert.strictEqual(info.rearDiff, 'welded');
});

test('gearFor keeps the engine in the drift band', function () {
  var p = T.apply(coupe300());
  [8, 14, 20, 28, 36].forEach(function (v) {
    var g = T.gearFor(p, v);
    var rpm = v * 1.12 / p.radiusR * p.ratios[g - 1] * p.finalDrive * 60 / (2 * Math.PI);
    assert.ok(rpm <= p.driftGearing.maxRpm + 1, v + ' m/s gear ' + g + ' rpm ' + rpm);
    if (g > 1) assert.ok(rpm >= p.driftGearing.minRpm - 1, v + ' m/s gear ' + g + ' rpm ' + rpm + ' too low');
  });
  assert.ok(T.gearFor(p, 36) >= T.gearFor(p, 8));
});

test('recommendedBuildPatch: valid catalog ids, RWD + locked diff, applies cleanly', function () {
  var b = baseBuild();
  b.drivetrain.layout = 'fwd';
  b.tires.compound = 'slick';
  var patch = T.recommendedBuildPatch(b);
  assert.strictEqual(patch.drivetrain.layout, 'rwd');
  assert.strictEqual(patch.drivetrain.rearDiff, 'locking');
  assert.strictEqual(patch.drivetrain.tractionControl, 0);
  assert.ok(patch.suspension.camberFront_deg < -2);
  assert.strictEqual(patch.tires.compound, 'performance');
  if (CB.data && typeof CB.data.find === 'function') {
    assert.ok(CB.data.find('differentials', patch.drivetrain.rearDiff), 'rear diff id');
    assert.ok(CB.data.find('steeringTypes', patch.interior.steering), 'steering id');
    assert.ok(CB.data.find('absModes', patch.brakes.abs), 'abs id');
    if (patch.engine && patch.engine.tune) assert.ok(CB.data.find('tunes', patch.engine.tune), 'tune id');
  }
  assert.strictEqual(T.recommendedBuildPatch(b).drivetrain.layout, 'rwd', 'deterministic');
  assert.strictEqual(b.drivetrain.layout, 'fwd', 'input build not mutated');
  // deep-merge onto the build -> fromBuild works and is RWD w/ locked diff
  function merge(a, o) { for (var k in o) { if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) { a[k] = a[k] || {}; merge(a[k], o[k]); } else a[k] = o[k]; } return a; }
  var nb = merge(clone(b), patch);
  var p = V.fromBuild(nb);
  assert.strictEqual(p.layout, 'rwd');
  assert.strictEqual(p.lockR, 1);
  assert.strictEqual(p.tcLevel, 0);
  // weak engine gets a tune suggestion
  var weak = clone(b); weak.engine.displacement_l = 1.4; weak.engine.aspiration = 'na'; weak.engine.layout = 'I4';
  var wp = T.recommendedBuildPatch(weak);
  assert.ok(wp.engine && /stage/.test(wp.engine.tune), 'weak engine tune ' + JSON.stringify(wp.engine));
});

test('forBuild and wrapVehicle hand out tuned params (player-only option)', function () {
  var b = baseBuild();
  var p = T.forBuild(b, M300, { level: 'pro' });
  assert.strictEqual(p.drift.level, 'pro');
  var W = T.wrapVehicle(V, { level: 'street', playerOnly: true });
  assert.strictEqual(typeof W.step, 'function');
  assert.strictEqual(typeof W.createState, 'function');
  var pp = W.fromBuild(b, M300, { isPlayer: true });
  var pa = W.fromBuild(b, M300, { isPlayer: false });
  assert.ok(pp.drift && pp.drift.tuned);
  assert.ok(!pa.drift);
  var W2 = T.wrapVehicle(V, { level: 'competition' });
  assert.strictEqual(W2.fromBuild(b, M300).drift.level, 'competition');
  // double-apply is a no-op through the wrapper; apply on tuned params stays sane
  var twice = T.apply(pp, { level: 'street' });
  assert.ok(twice.lockAngle <= 60 * DEG + 1e-9);
  assert.ok(Math.abs(twice.muR - pp.muR) < 1e-12 && Math.abs(twice.power_hp - pp.power_hp) < 1e-9, 're-tune does not compound');
  var re = T.apply(pp, { level: 'competition' });
  assert.ok(Math.abs(re.lockAngle - 60 * DEG) < 1e-9 && re.drift.level === 'competition');
  assert.strictEqual(JSON.stringify(T.apply(re, { level: 'street' })), JSON.stringify(pp), 'street from competition == street from base');
});

test('robust to minimal / foreign params objects', function () {
  var p = T.apply({ mass: 1200, layout: 'fwd' });
  assert.strictEqual(p.layout, 'rwd', 'street converts FWD to RWD');
  assert.strictEqual(T.apply({ mass: 1200, layout: 'fwd' }, { level: 'grip' }).layout, 'awd', 'grip keeps some front drive');
  assert.ok(isFinite(p.lockAngle) && isFinite(p.muR) && isFinite(p.Iz));
  assert.throws(function () { T.apply(null); });
});

if (standalone) {
  process.on('exit', function () { console.log('\n' + passed + ' passed, ' + failed + ' failed'); });
}

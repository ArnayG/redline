/* Node tests for the low-latency local steering sources:
     js/input/mouse-steer.js  (virtual wheel: accumulation, self-centring spring, dead zone, absolute fallback)
     js/input/pad-tilt.js     (WebHID report parsing for DualShock 4 / DualSense / Switch Pro / Joy-Con with the real byte
                               layouts, the gyro + gravity roll filter: hold-independence, unwrap through +-180, drift,
                               latency, gyro sign self-check, shake rejection; steering map)
     js/input/sources.js      (shared steering-source picker prefs)
   and the "Gamepad stick: proportional / digital" setting through race-ui + CB.race.assist (half stick under Heavy).
   Run: node tests/run.js input-mouse-tilt */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/vehicle.js', 'js/race/tracks.js', 'js/race/tracks-extra.js',
  'js/race/engine.js', 'js/race/ai.js', 'js/race/drift/tune.js', 'js/race/drift/tracks.js', 'js/race/drift/assist.js',
  'js/race/drift/arcade.js', 'js/race/drift/scoring.js', 'js/race/drift/ai.js', 'js/race/drift/session.js'].forEach(function (f) { require(path.join(root, f)); });
require(path.join(root, 'js/input/analog.js'));
var SS = require(path.join(root, 'js/input/sources.js'));
var M = require(path.join(root, 'js/input/mouse-steer.js'));
var P = require(path.join(root, 'js/input/pad-tilt.js'));
var UI = require(path.join(root, 'js/race/race-ui.js'));
var CB = globalThis.CB;
var DEG = Math.PI / 180;

/* ------------------------------------------------------------------ mouse wheel */
test('mouse wheel: movementX accumulates proportionally, stops at full lock, invert, sensitivity', function () {
  var W = M.createWheel({ centering: 0, deadzone: 0 });
  W.move(M.LOCK_COUNTS / 2, 0);
  assert.ok(Math.abs(W.read(0) - 0.5) < 1e-9, 'half the travel = half lock');
  W.move(M.LOCK_COUNTS / 4, 1); W.move(-M.LOCK_COUNTS / 8, 2);
  assert.ok(Math.abs(W.read(2) - 0.625) < 1e-9);
  W.move(10 * M.LOCK_COUNTS, 3);
  assert.equal(W.read(3), 1, 'clamped at full lock (the wheel hits its stop)');
  W.move(-M.LOCK_COUNTS / 2, 4);
  assert.ok(Math.abs(W.read(4) - 0.5) < 1e-9, 'coming back from the stop is immediate (no wind-up)');
  var Wi = M.createWheel({ centering: 0, deadzone: 0, invert: true, sensitivity: 2 });
  Wi.move(M.LOCK_COUNTS / 4, 0);
  assert.ok(Math.abs(Wi.read(0) + 0.5) < 1e-9, 'inverted, sensitivity 2: a quarter of the travel = half lock left');
});

test('mouse wheel: self-centring spring (0 = stays put), dead zone, absolute cursor fallback', function () {
  var W0 = M.createWheel({ centering: 0, deadzone: 0 });
  W0.move(300, 0);
  assert.equal(W0.read(5000), 0.5, 'no spring: the wheel stays where it was left');
  var W = M.createWheel({ centering: 0.5, deadzone: 0 });
  W.move(300, 0);
  var k = 0.5 * M.SPRING, v1;
  for (var t0 = 16; t0 <= 1008; t0 += 16) v1 = W.read(t0);
  assert.ok(Math.abs(v1 - 0.5 * Math.exp(-k * 1.008)) < 1e-6, 'exponential return: ' + v1);
  assert.ok(Math.abs(W.read(1008 + 5000) - v1 * Math.exp(-k * 0.25)) < 1e-9, 'a long gap (tab in the background) counts as 0.25 s at most');
  for (var t = 1000; t <= 3000; t += 16) W.read(t);
  assert.ok(Math.abs(W.read(3000)) < 0.001, 'back at centre after 3 s');
  var Wd = M.createWheel({ centering: 0, deadzone: 0.1 });
  Wd.move(M.LOCK_COUNTS * 0.08, 0);
  assert.equal(Wd.read(0), 0, 'inside the dead zone');
  Wd.move(M.LOCK_COUNTS * 0.47, 0);
  assert.ok(Math.abs(Wd.read(0) - (0.55 - 0.1) / 0.9) < 1e-9, 'rescaled outside it');
  var Wa = M.createWheel({ centering: 1, deadzone: 0 });
  Wa.absolute(1000, 1000, 0); assert.equal(Wa.read(0), 1, 'right screen edge = full lock');
  Wa.absolute(500, 1000, 0); assert.equal(Wa.read(10000), 0, 'centre = straight (no spring in absolute mode)');
  Wa.absolute(250, 1000, 0); assert.ok(Math.abs(Wa.read(5000) + 0.5) < 1e-9, 'quarter = half lock left, held');
  var p = M.normPrefs({ sensitivity: 99, centering: -1, deadzone: 1, buttons: 'x', mode: 'nope' });
  assert.deepEqual(p, { sensitivity: 4, centering: 0, deadzone: 0.25, invert: false, buttons: 'off', mode: 'lock' });
});

/* ------------------------------------------------------------------ synthetic controller reports */
function put16(b, o, v) { v = Math.max(-32768, Math.min(32767, Math.round(v))); if (v < 0) v += 65536; b[o] = v & 255; b[o + 1] = v >> 8; }
var SONY_ACC = 8192, SONY_GYR = 32768 / 2000, NIN_ACC = 1 / 0.000244, NIN_GYR = 1 / 0.07;
/** A real-layout input report (bytes WITHOUT the report id, as WebHID delivers them) for canonical up-vector a (g)
    and angular rate w (deg/s) in the controller frame x right, y up out of the face, z toward the player. */
function report(kind, bt, a, w, extra) {
  extra = extra || {};
  var b, off;
  if (kind === 'ds4') {
    off = bt ? 2 : 0; b = new Uint8Array(bt ? 77 : 63);
    for (var i = 0; i < 3; i++) { put16(b, off + 12 + 2 * i, w[i] * SONY_GYR); put16(b, off + 18 + 2 * i, a[i] * SONY_ACC); }
    var ts = (extra.ts || 0) & 0xffff; b[off + 9] = ts & 255; b[off + 10] = ts >> 8;
    if (extra.r3) b[off + 5] |= 0x80;
    return { id: bt ? 0x11 : 0x01, bytes: b };
  }
  if (kind === 'ds') {
    off = bt ? 1 : 0; b = new Uint8Array(bt ? 77 : 63);
    for (var j = 0; j < 3; j++) { put16(b, off + 15 + 2 * j, w[j] * SONY_GYR); put16(b, off + 21 + 2 * j, a[j] * SONY_ACC); }
    var t32 = (extra.ts || 0) >>> 0; b[off + 27] = t32 & 255; b[off + 28] = (t32 >> 8) & 255; b[off + 29] = (t32 >> 16) & 255; b[off + 30] = (t32 >>> 24) & 255;
    if (extra.r3) b[off + 8] |= 0x80;
    return { id: bt ? 0x31 : 0x01, bytes: b };
  }
  // Nintendo 0x30: canonical -> the device's own axes, 3 identical samples
  function toN(v) {
    if (kind === 'pro') return [-v[2], -v[0], v[1]];        // canonical (-y, z, -x)
    if (kind === 'jcl') return [-v[0], v[2], v[1]];         // canonical (-x, z, y)
    return [v[0], -v[2], v[1]];                             // jcr: canonical (x, z, -y)
  }
  var an = toN(a), wn = toN(w);
  b = new Uint8Array(63);
  for (var s = 0; s < 3; s++) {
    var o = 12 + 12 * s;
    for (var k = 0; k < 3; k++) { put16(b, o + 2 * k, an[k] * NIN_ACC); put16(b, o + 6 + 2 * k, wn[k] * NIN_GYR); }
  }
  if (extra.r3) b[3] |= kind === 'jcl' ? 0x08 : 0x04;
  return { id: 0x30, bytes: b };
}
/** Up vector (g) and body rate (deg/s) of a controller held at pitch psi (deg; 0 flat face up, -90 upright facing
    the player) and turned clockwise (as the player sees it) by theta deg at thetaDot deg/s. */
function pose(theta, thetaDot, psi) {
  var p = (psi || 0) * DEG, th = theta * DEG;
  var u0 = [0, Math.cos(p), Math.sin(p)], wax = [0, -Math.sin(p), Math.cos(p)];
  var a = [-Math.sin(th), Math.cos(th) * u0[1], Math.cos(th) * u0[2]];
  var w = [0, -thetaDot * wax[1], -thetaDot * wax[2]];
  return { a: a, w: w };
}

test('pad tilt: DS4 / DualSense (USB + Bluetooth) and Switch Pro / Joy-Con L / R reports parse to one controller frame', function () {
  var a = [0.21, 0.83, -0.4], w = [12.5, -40.25, 97];
  [['ds4', false], ['ds4', true], ['ds', false], ['ds', true], ['pro'], ['jcl'], ['jcr']].forEach(function (c) {
    var r = report(c[0], c[1], a, w, { r3: true }), out = P.parseReport(c[0], r.id, r.bytes, {});
    assert.ok(out && out.samples.length === (c[0].length === 3 && c[0] !== 'ds4' ? 3 : 1), c.join('/') + ' samples');
    out.samples.forEach(function (s) {
      for (var i = 0; i < 3; i++) {
        assert.ok(Math.abs(s.a[i] - a[i]) < 0.001, c.join('/') + ' accel ' + i + ': ' + s.a[i]);
        assert.ok(Math.abs(s.w[i] - w[i]) < 0.08, c.join('/') + ' gyro ' + i + ': ' + s.w[i]);
      }
    });
    assert.equal(out.r3 || out.l3, true, c.join('/') + ' stick click (re-centre)');
    if (c[0] === 'ds4' || c[0] === 'ds') assert.equal(out.transport, c[1] ? 'Bluetooth' : 'USB');
  });
  // reports without motion data are ignored: Bluetooth "simple" 0x01 (9 bytes), Switch subcommand replies 0x21
  assert.equal(P.parseReport('ds4', 0x01, new Uint8Array(9), {}), null);
  assert.equal(P.parseReport('ds', 0x01, new Uint8Array(9), {}), null);
  assert.equal(P.parseReport('pro', 0x21, new Uint8Array(48), {}), null);
  // device timestamps -> sample dt (DS4: 5.33 us units, DualSense: 1/3 us units)
  var mem = {};
  P.parseReport('ds4', 1, report('ds4', false, a, w, { ts: 65000 }).bytes, mem);
  var r2 = P.parseReport('ds4', 1, report('ds4', false, a, w, { ts: (65000 + 750) % 65536 }).bytes, mem);
  assert.ok(Math.abs(r2.samples[0].dt - 0.004) < 1e-6, 'DS4 dt across the 16-bit wrap: ' + r2.samples[0].dt);
  mem = {};
  P.parseReport('ds', 1, report('ds', false, a, w, { ts: 4294960000 }).bytes, mem);
  var r3 = P.parseReport('ds', 1, report('ds', false, a, w, { ts: (4294960000 + 12000) % 4294967296 }).bytes, mem);
  assert.ok(Math.abs(r3.samples[0].dt - 0.004) < 1e-6, 'DualSense dt across the 32-bit wrap: ' + r3.samples[0].dt);
  // known controllers
  assert.equal(P.kindOf({ vendorId: 0x054c, productId: 0x0ce6 }).kind, 'ds');
  assert.equal(P.kindOf({ vendorId: 0x057e, productId: 0x2006 }).kind, 'jcl');
  assert.equal(P.kindOf({ vendorId: 0x1234, productId: 1 }), null);
});

/** Run the filter through parsed synthetic reports: thetaFn(t) -> deg; returns the angle trace. */
function drive(kind, bt, psi, thetaFn, T, opts) {
  opts = opts || {};
  var F = P.createRollFilter(), dt = kind === 'ds4' || kind === 'ds' ? 0.004 : 0.015, trace = [], prev = thetaFn(0);
  for (var t = 0; t <= T + 1e-9; t += dt) {
    var th = thetaFn(t), rate = (th - prev) / dt; prev = th;
    var ps = pose(th, rate, psi);
    if (opts.bias) ps.w = ps.w.map(function (x, i) { return x + opts.bias[i]; });
    if (opts.flipGyro) ps.w = ps.w.map(function (x) { return -x; });
    if (opts.shake && opts.shake(t)) ps.a = ps.a.map(function (x, i) { return x + opts.shake(t)[i]; });
    var r = report(kind, bt, ps.a, ps.w), out = P.parseReport(kind, r.id, r.bytes, {});
    var ang = 0;
    out.samples.forEach(function (s) { ang = F.update(s.a, s.w, dt / out.samples.length); });
    trace.push({ t: t, theta: th, angle: ang });
  }
  return { trace: trace, F: F, last: trace[trace.length - 1] };
}

test('pad tilt filter: roll angle like a wheel for every controller and any hold (flat, tilted, upright)', function () {
  ['ds4', 'ds', 'pro', 'jcl', 'jcr'].forEach(function (kind) {
    [0, 35, -90].forEach(function (psi) {
      var r = drive(kind, kind === 'ds', psi, function (t) { return t < 0.2 ? 0 : Math.min(60, (t - 0.2) * 120); }, 2.5);
      assert.ok(Math.abs(r.last.angle - 60) < 1.2, kind + ' psi ' + psi + ': 60 deg clockwise -> ' + r.last.angle.toFixed(2));
      var l = drive(kind, false, psi, function (t) { return t < 0.2 ? 0 : -Math.min(30, (t - 0.2) * 120); }, 2);
      assert.ok(Math.abs(l.last.angle + 30) < 1.2, kind + ' psi ' + psi + ': 30 deg anticlockwise -> ' + l.last.angle.toFixed(2));
    });
  });
});

test('pad tilt filter: unwraps through +-90 and +-180 (270 deg lock), and back', function () {
  var r = drive('ds', false, 0, function (t) { return t < 0.2 ? 0 : t < 1.7 ? (t - 0.2) * 200 : t < 3.2 ? 300 - (t - 1.7) * 400 + 0 : -300; }, 4);
  var at = function (T) { for (var i = 0; i < r.trace.length; i++) if (r.trace[i].t >= T) return r.trace[i]; return r.last; };
  assert.ok(Math.abs(at(1.69).angle - 298) < 3, 'turned 300 deg clockwise: ' + at(1.69).angle.toFixed(1));
  assert.ok(Math.abs(r.last.angle + 300) < 3, '... then 600 deg back to -300: ' + r.last.angle.toFixed(1));
  var worst = 0;
  r.trace.forEach(function (s) { worst = Math.max(worst, Math.abs(s.angle - s.theta)); });
  assert.ok(worst < 4, 'tracks the whole way (no jump at +-180): worst ' + worst.toFixed(2));
  assert.equal(P.mapSteer(135, { lock: 270, deadzone: 0 }), 1);
  assert.ok(Math.abs(P.mapSteer(67.5, { lock: 270, deadzone: 0 }) - 0.5) < 1e-9);
  assert.ok(Math.abs(P.mapSteer(-45, { lock: 180, deadzone: 0 }) + 0.5) < 1e-9);
  assert.equal(P.mapSteer(1, { lock: 90, deadzone: 1.5 }), 0, 'dead zone');
  assert.ok(Math.abs(P.mapSteer(22.5, { lock: 90, deadzone: 0, invert: true }) + 0.5) < 1e-9, 'invert');
});

test('pad tilt filter: no drift with a biased gyro, gyro sign self-check, shake rejection', function () {
  // 60 s held still at 20 deg with a 3 deg/s gyro bias on every axis: gravity keeps the angle, the PI term learns the bias
  // (the pose at connect is "straight ahead": start level, turn to 20 deg, hold)
  var r = drive('ds4', false, 20, function (t) { return Math.min(20, t * 100); }, 60, { bias: [3, 3, 3] });
  assert.ok(Math.abs(r.last.angle - 20) < 0.3, 'drift-free: ' + r.last.angle.toFixed(3));
  var worst = 0; r.trace.forEach(function (s) { if (s.t > 2) worst = Math.max(worst, Math.abs(s.angle - 20)); });
  assert.ok(worst < 1.2, 'worst error after 2 s ' + worst.toFixed(2));
  // a gyro whose sign disagrees with gravity (unknown clone / axis) is detected and flipped
  var fl = drive('pro', false, 0, function (t) { return 50 * Math.sin(t * 3); }, 8, { flipGyro: true });
  assert.equal(fl.F.gyroSign, -1, 'flipped');
  var err = 0, n = 0; fl.trace.forEach(function (s) { if (s.t > 6) { err += Math.abs(s.angle - s.theta); n++; } });
  assert.ok(err / n < 2, 'then tracks: mean error ' + (err / n).toFixed(2));
  // shaking (0.9 g sideways jolts for 150 ms) while held at 10 deg: the gyro holds the angle
  var sh = drive('ds', false, 0, function (t) { return Math.min(10, t * 100); }, 3, { shake: function (t) { return t > 1 && t < 1.15 ? [0.9, 0.3, 0] : null; } });
  var w2 = 0; sh.trace.forEach(function (s) { if (s.t > 0.5) w2 = Math.max(w2, Math.abs(s.angle - 10)); });
  assert.ok(w2 < 3, 'shake error ' + w2.toFixed(2));
});

test('pad tilt filter latency: the gyro path follows a fast turn with no lag (accelerometer-only filtering lags)', function () {
  // a 45 deg flick in 60 ms (750 deg/s), sampled at the DualSense's 250 Hz
  var r = drive('ds', false, 0, function (t) { return t < 0.5 ? 0 : Math.min(45, (t - 0.5) * 750); }, 1);
  var t90 = null, lp = 0, tLP = null, maxLag = 0;
  r.trace.forEach(function (s, i) {
    if (s.t >= 0.5 && s.t <= 0.56) maxLag = Math.max(maxLag, s.theta - s.angle);
    if (t90 == null && s.angle >= 40.5) t90 = s.t - 0.5;
    lp += (s.theta - lp) * (1 - Math.exp(-0.004 / 0.08));   // what a gravity-only angle with an 80 ms smoother gives
    if (tLP == null && lp >= 40.5) tLP = s.t - 0.5;
  });
  assert.ok(maxLag < 1.5, 'lag behind the true angle while turning: ' + maxLag.toFixed(2) + ' deg');
  assert.ok(t90 != null && t90 <= 0.06, '90 % of the flick after ' + (t90 * 1000).toFixed(0) + ' ms (the flick itself reaches it at 54 ms)');
  assert.ok(tLP > t90 + 0.1, 'accelerometer-only reaches it ' + ((tLP - t90) * 1000).toFixed(0) + ' ms later');
});

/* ------------------------------------------------------------------ sources + gamepad stick setting */
test('steering sources: catalog order, prefs normalisation, default gamepad stick = proportional', function () {
  var ids = SS.list().map(function (x) { return x.id; });
  ['default', 'phone', 'webcam', 'mouse', 'padtilt'].forEach(function (id) { assert.ok(ids.indexOf(id) >= 0, id); });
  assert.ok(ids.indexOf('default') < ids.indexOf('mouse') && ids.indexOf('mouse') < ids.indexOf('padtilt'));
  assert.deepEqual(SS._normPrefs({}), { source: 'default', gamepadStick: 'proportional' });
  assert.equal(SS._normPrefs({ gamepadStick: 'digital' }).gamepadStick, 'digital');
  assert.equal(SS.gamepadProportional(), true);
  assert.equal(P.supported().ok, false, 'no WebHID in Node');
});

function withPad(axisX, fn) {
  var nav = globalThis.navigator, had = nav && Object.getOwnPropertyDescriptor(nav, 'getGamepads');
  var pad = { connected: true, mapping: 'standard', id: 'Test pad', axes: [axisX, 0, 0, 0], buttons: [] };
  for (var i = 0; i < 17; i++) pad.buttons.push({ pressed: false, value: 0 });
  pad.buttons[7].value = 0.6;
  if (!nav) { globalThis.navigator = {}; nav = globalThis.navigator; }
  Object.defineProperty(nav, 'getGamepads', { value: function () { return [pad]; }, configurable: true, writable: true });
  try { return fn(); } finally { if (had) Object.defineProperty(nav, 'getGamepads', had); else delete nav.getGamepads; }
}
test('race-ui: a gamepad stick is proportional (steerAnalog) by default, digital (classic) on request', function () {
  CB.input.hub._reset();
  var save = SS.prefs.gamepadStick;
  try {
    withPad(-0.6, function () {
      var I = UI._.createInput({ settings: UI._.DEFAULT_SETTINGS });
      I.pollGamepad(0); I.sample(1 / 120, 10);
      assert.ok(I.lastIntent.steerAxis > 0.2, 'left stick = + (left): ' + I.lastIntent.steerAxis);
      assert.equal(I.lastIntent.steerAnalog, true); assert.equal(I.lastIntent.steerSource, 'gamepad');
      SS.prefs.gamepadStick = 'digital';
      I.pollGamepad(0); I.sample(1 / 120, 10);
      assert.ok(I.lastIntent.steerAxis > 0.2);
      assert.equal(I.lastIntent.steerAnalog, undefined, 'classic: the assist reads the stick its old way');
    });
  } finally { SS.prefs.gamepadStick = save; }
});

/** forge-ring, race mode, speed held at 16 m/s, the stick held at `stick` from 5 s after the start:
    mean front-wheel angle over the first 0.8 s (+ the lateral offset 4 s later). */
function heldStick(level, stick, proportional) {
  var s = CB.race.drift.createSession({ trackId: 'forge-ring', mode: 'race', seed: 1, assist: level, opponents: 0, laps: 50 });
  var dt = 1 / 60, t = 0, t0 = null, acc = 0, n = 0, ps;
  for (var i = 0; i < 40 * 60; i++) {
    ps = s.playerState();
    if (t0 == null && s.getPhase() === 'racing') t0 = t;
    var e = 16 - ps.speed, raw = { throttleAxis: Math.max(0.03, Math.min(1, 0.3 + 0.3 * e)), brakeAxis: e < -1.5 ? Math.min(1, -0.2 * e) : 0 };
    var on = t0 != null && t > t0 + 5;
    if (on) { raw.steerAxis = stick; if (proportional) { raw.steerAnalog = true; raw.steerSource = 'gamepad'; } }
    s.update(dt, raw); t += dt;
    ps = s.playerState();
    if (on && t < t0 + 5.8) { acc += Math.abs(ps.steerAngle); n++; }
    if (on && t > t0 + 9) break;
  }
  return { steer: acc / n, lat: ps.lateral };
}
test('gamepad stick harness: half stick = about half the steering under Heavy (proportional); classic was all-or-nothing', function () {
  var cH = heldStick('heavy', 0.5, false), cF = heldStick('heavy', 1, false);
  var pH = heldStick('heavy', 0.5, true), pF = heldStick('heavy', 1, true);
  var classic = cH.steer / cF.steer, prop = pH.steer / pF.steer;
  assert.ok(classic > 0.9, 'classic Heavy: half stick steers like full stick (ratio ' + classic.toFixed(2) + ')');
  assert.ok(prop > 0.35 && prop < 0.75, 'proportional Heavy: ratio ' + prop.toFixed(2));
  // Light / Medium: identical either way (they already followed the stick)
  ['light', 'medium'].forEach(function (lv) {
    var a = heldStick(lv, 0.5, false), b = heldStick(lv, 0.5, true);
    assert.ok(Math.abs(a.steer - b.steer) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9, lv + ' unchanged');
  });
});

test('drift Heavy / Auto still drift with an analog (proportional gamepad, mouse) stick', function () {
  function run(level, analog, src) {
    var s = CB.race.drift.createSession({ trackId: 'circle-lab', mode: 'free', seed: 1, assist: level });
    var inBand = 0, spun = false;
    for (var i = 0; i < 20 * 60; i++) {
      var raw = { throttleAxis: 0.85 };
      if (i > 120) { raw.steerAxis = 0.6; if (analog) { raw.steerAnalog = true; raw.steerSource = src; } }
      s.update(1 / 60, raw);
      var b = Math.abs(s.playerState().angle_deg || 0);
      if (i > 300) { if (b >= 15 && b <= 50) inBand += 1 / 60; if (b > 100) spun = true; }
    }
    return { inBand: inBand, spun: spun };
  }
  ['heavy', 'auto'].forEach(function (lv) {
    var c = run(lv, false), g = run(lv, true, 'gamepad'), m = run(lv, true, 'mouse');
    assert.ok(g.inBand > 4 && !g.spun, lv + ' gamepad analog: ' + g.inBand.toFixed(1) + ' s in the drift band');
    assert.ok(m.inBand > 4 && !m.spun, lv + ' mouse analog: ' + m.inBand.toFixed(1) + ' s');
    assert.ok(Math.abs(g.inBand - c.inBand) < 1.5, lv + ' about the same as the classic stick (' + c.inBand.toFixed(1) + ' s)');
  });
});

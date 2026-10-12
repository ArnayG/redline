/* Node tests for phone steering: js/input/analog.js (CB.input.hub), js/input/tilt.js (orientation -> steer), js/input/phone-wheel.js
   (wheel protocol over the loopback transport, disconnect failsafe), the race-ui input merge and the heavy-assist analog path.
   Run: node tests/run.js input-phone */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js'].forEach(function (f) { require(path.join(root, f)); });
var V = require(path.join(root, 'js/race/vehicle.js'));
require(path.join(root, 'js/race/tracks.js'));
require(path.join(root, 'js/race/drift/tune.js'));
var A = require(path.join(root, 'js/race/drift/assist.js'));
require(path.join(root, 'js/race/drift/session.js'));
var NT = require(path.join(root, 'js/net/transport.js'));
var AN = require(path.join(root, 'js/input/analog.js'));
var TL = require(path.join(root, 'js/input/tilt.js'));
var W = require(path.join(root, 'js/input/phone-wheel.js'));
var UI = require(path.join(root, 'js/race/race-ui.js'));
var CB = globalThis.CB;
var DEG = Math.PI / 180;

/** beta/gamma (deg) a browser reports for a phone in screen orientation `a`, turned clockwise by phi, screen pitched back by psi. */
function orient(a, phi, psi, alt) {
  var ar = a * DEG, f = phi * DEG, p = (psi || 0) * DEG;
  var su = [Math.sin(ar), Math.cos(ar)], sr = [Math.cos(ar), -Math.sin(ar)];
  var c = Math.cos(p);
  var u = [c * (Math.cos(f) * su[0] - Math.sin(f) * sr[0]), c * (Math.cos(f) * su[1] - Math.sin(f) * sr[1]), Math.sin(p)];
  var beta = Math.asin(u[1]) / DEG, gamma = Math.atan2(-u[0], u[2]) / DEG;
  if (alt) { beta = 180 - beta; gamma = gamma + 180; }          // the equivalent Euler triple (cos beta < 0)
  return { beta: ((beta + 180) % 360 + 360) % 360 - 180, gamma: ((gamma + 180) % 360 + 360) % 360 - 180 };
}

test('tilt: wheel angle = rotation about the screen normal, both landscape orientations, any pitch', function () {
  [90, 270].forEach(function (a) {
    [-40, -12, 0, 7.5, 25, 60].forEach(function (phi) {
      [0, 25, 50].forEach(function (psi) {
        [false, true].forEach(function (alt) {
          var o = orient(a, phi, psi, alt), w = TL.wheelAngle(o.beta, o.gamma, a);
          assert.ok(Math.abs(w.angle - phi) < 1e-6, 'a=' + a + ' phi=' + phi + ' psi=' + psi + ' alt=' + alt + ' -> ' + w.angle);
          assert.ok(w.conf > 0.5);
        });
      });
    });
  });
  // the same physical pose read in the wrong orientation is off by 180 deg -> orientation matters
  var o = orient(90, 10, 20);
  assert.ok(Math.abs(Math.abs(TL.wheelAngle(o.beta, o.gamma, 270).angle) - 170) < 1e-6);
  // phone flat on a table: no reliable roll
  assert.equal(TL.wheelAngle(0, 0, 90).conf, 0);
  // portrait still works (rotation about the normal)
  var op = orient(0, 15, 30);
  assert.ok(Math.abs(TL.wheelAngle(op.beta, op.gamma, 0).angle - 15) < 1e-6);
});

test('tilt: deadzone and linear mapping, full lock at maxAngle (default 35 deg)', function () {
  var P = { deadzone: 2, maxAngle: 35 };
  assert.equal(TL.mapAngle(1.9, P), 0);
  assert.equal(TL.mapAngle(-2, P), 0);
  assert.ok(TL.mapAngle(2.5, P) > 0 && TL.mapAngle(2.5, P) < 0.02);
  assert.ok(Math.abs(TL.mapAngle(18.5, P) - 0.5) < 1e-9);
  assert.ok(Math.abs(TL.mapAngle(-18.5, P) + 0.5) < 1e-9);
  assert.equal(TL.mapAngle(35, P), 1);
  assert.equal(TL.mapAngle(80, P), 1);
  assert.equal(TL.mapAngle(-80, P), -1);
  assert.ok(Math.abs(TL.mapAngle(10, { deadzone: 2, maxAngle: 18 }) - 0.5) < 1e-9, 'sensitivity = max angle');
});

test('tilt: 1-euro filter removes jitter but follows a real turn quickly', function () {
  var s = TL.createSteer({ deadzone: 2, maxAngle: 35, smoothing: 0.5 });
  var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; }
  var t = 0, outs = [];
  for (var i = 0; i < 240; i++) { t += 1000 / 60; var o = orient(90, 12 + rnd() * 3, 30); s.update(o.beta, o.gamma, 90, t); if (i > 120) outs.push(s.angle); }
  var mean = outs.reduce(function (a, b) { return a + b; }, 0) / outs.length;
  var sd = Math.sqrt(outs.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / outs.length);
  var rawSd = 3 / Math.sqrt(12);
  assert.ok(Math.abs(mean - 12) < 0.6, 'mean ' + mean);
  assert.ok(sd < rawSd * 0.5, 'jitter ' + sd + ' vs raw ' + rawSd);
  // a quick 12 -> 30 deg turn is followed to 90 % within 250 ms
  var reached = null;
  for (var k = 0; k < 60; k++) { t += 1000 / 60; var q = orient(90, 30, 30); s.update(q.beta, q.gamma, 90, t); if (reached === null && s.angle > 12 + 0.9 * 18) reached = k * 1000 / 60; }
  assert.ok(reached !== null && reached <= 250, 'step response ' + reached + ' ms');
});

test('tilt: recalibrate sets the centre; screen orientation flips and +-180 wraps never jump', function () {
  var s = TL.createSteer({ deadzone: 2, maxAngle: 35, smoothing: 0 }), t = 0;
  function feed(a, phi, n) { for (var i = 0; i < (n || 30); i++) { t += 16; var o = orient(a, phi, 35); s.update(o.beta, o.gamma, a, t); } }
  feed(90, 8);
  assert.ok(s.steer > 0.15, 'tilted 8 deg: ' + s.steer);
  s.recalibrate();
  feed(90, 8);
  assert.ok(Math.abs(s.steer) < 1e-9, 'centred after recalibrate');
  feed(90, 8 + 20);
  assert.ok(Math.abs(s.steer - 18 / 33) < 0.02, 'relative to the new centre: ' + s.steer);
  s.recalibrate(); feed(90, 0); s.recalibrate(); feed(90, 0);
  // player turns the phone round to the other landscape orientation (screen angle 90 -> 270) and holds it level
  feed(270, 0);
  assert.ok(Math.abs(s.steer) < 1e-6, 'other landscape, level: ' + s.steer);
  feed(270, -20);
  assert.ok(s.steer < -0.5, 'other landscape, turned left: ' + s.steer);
  // continuous rotation through 180 deg: unwrapped (full lock, never flips sign)
  var s2 = TL.createSteer({ smoothing: 0 }); t = 0;
  for (var ang = 0; ang <= 200; ang += 5) { t += 16; var o = orient(90, ang, 20); s2.update(o.beta, o.gamma, 90, t); assert.ok(ang < 3 || s2.steer > 0, 'no flip at ' + ang); }
});

test('hub: highest-priority active source wins, inactive = centred + no throttle, prefs invert', function () {
  var H = AN.createHub();
  assert.deepEqual(H.read(0), { active: false, steer: 0, throttle: 0, brake: 0, handbrake: false, source: null });
  var a = { active: true, steer: 0.3, throttle: 1, brake: 0 }, b = { active: true, steer: -0.6, throttle: 0.2, brake: 0.4, handbrake: true };
  H.register('tilt', { read: function () { return a; } }, 5);
  var offW = H.register('wheel', { read: function () { return b; } }, 10);
  var r = H.read(0);
  assert.equal(r.source, 'wheel'); assert.equal(r.steer, -0.6); assert.equal(r.handbrake, true);
  b.active = false;
  assert.equal(H.read(0).source, 'tilt');
  offW();
  H.prefs.invert = true;
  assert.equal(H.read(0).steer, -0.3);
  H.prefs.invert = false;
  H.pushEvent('shiftUp', 'wheel'); H.pushEvent('pause', 'wheel');
  assert.deepEqual(H.takeEvents().map(function (e) { return e.type; }), ['shiftUp', 'pause']);
  assert.deepEqual(H.takeEvents(), []);
  // haptics from the race frame: player contact + kerbs (rate-limited), nothing while paused
  var fb = [];
  H.onFeedback(function (f) { fb.push(f.kind); });
  H.frame({ driving: true, speed: 30, surface: 'kerb', events: [{ type: 'collision', carId: 'player', intensity: 0.7 }, { type: 'wall', carId: 'ai1' }], playerId: 'player', now: 1000 });
  H.frame({ driving: true, speed: 30, surface: 'kerb', now: 1050 });
  H.frame({ driving: true, speed: 30, surface: 'kerb', now: 1200 });
  H.frame({ driving: true, paused: true, speed: 30, surface: 'kerb', events: [{ type: 'wall', carId: 'player' }], now: 1500 });
  assert.deepEqual(fb, ['hit', 'kerb', 'kerb']);
});

test('race-ui input: phone steer is continuous end to end; keyboard overrides; source loss centres + lifts', function () {
  var hub = CB.input.hub; hub._reset();
  var src = { active: true, steer: 0.4, throttle: 0.6, brake: 0, handbrake: false };
  hub.register('wheel', { read: function () { return src; } }, 10);
  try {
    var I = UI._.createInput({ settings: UI._.DEFAULT_SETTINGS }), o;
    o = I.sample(1 / 120, 5);
    assert.ok(o.steer < -0.35 && o.steer > -0.41, 'right (+0.4 on the wheel) = negative input steer: ' + o.steer);
    assert.ok(Math.abs(o.throttle - 0.6) < 1e-9);
    var it = I.lastIntent;
    assert.equal(it.steerAxis, -0.4); assert.equal(it.steerAnalog, true); assert.equal(it.throttleAxis, 0.6);
    assert.equal(it.left || it.right, false, 'never quantised to keys');
    src.steer = 0.13;
    I.sample(1 / 120, 5);
    assert.equal(I.lastIntent.steerAxis, -0.13, 'every wheel position passes through');
    I.handleKey('ArrowLeft', true);
    I.sample(1 / 120, 5);
    assert.equal(I.lastIntent.left, true); assert.equal(I.lastIntent.steerAxis, undefined, 'keyboard overrides while held');
    I.handleKey('ArrowLeft', false);
    for (var i = 0; i < 120; i++) o = I.sample(1 / 120, 5);
    assert.equal(I.lastIntent.steerAxis, -0.13, 'phone back after the key is released');
    // phone gone: hub inactive -> centred, no throttle
    src.active = false;
    o = I.sample(1 / 120, 5);
    assert.equal(o.throttle, 0); assert.ok(Math.abs(o.steer) < 1e-9); assert.equal(I.lastIntent.steerAxis, undefined);
    // edge events reach the action handler every frame (also while paused)
    var acts = [], J = UI._.createInput({ onAction: function (a) { acts.push(a); } });
    hub.pushEvent('pause', 'wheel'); hub.pushEvent('shiftUp', 'wheel');
    J.pollGamepad(0);
    assert.deepEqual(acts, ['pause']);
    assert.equal(J.sample(1 / 120, 0).shiftUp, true);
  } finally { hub._reset(); }
});

/* ---------------------------------------------------------------- wheel protocol over the loopback transport */
function wheelRig(o) {
  var net = NT.loopback(Object.assign({ latency: 20, pingInterval: 500 }, o || {}));
  var host = net.host({ graceMs: 3000, pingInterval: 500 });
  var hub = AN.createHub();
  var rx = W.createReceiver(host, { hub: hub, now: net.now });
  var client = net.connect({ id: 'phone1' });
  var tx = W.createSender(client, { now: net.now, name: 'Test phone' });
  function run(ms, fn) { for (var t = 0; t < ms; t += 4) { if (fn) fn(net.now()); tx.tick(net.now()); net.advance(4); } }
  return { net: net, host: host, hub: hub, rx: rx, client: client, tx: tx, run: run };
}

test('wheel: pairing handshake, ~60 Hz input stream, latency, buttons, haptics and status', function () {
  var r = wheelRig(), got = { welcome: 0, hap: [], status: null, tel: null };
  r.tx.on('welcome', function () { got.welcome++; });
  r.tx.on('hap', function (h) { got.hap.push(h.kind); });
  r.tx.on('status', function (s) { got.status = s; });
  r.tx.on('tel', function (m) { got.tel = m; });
  r.run(300);
  assert.equal(r.rx.state, 'connected'); assert.equal(got.welcome, 1);
  assert.equal(r.rx.phone.name, 'Test phone');
  r.tx.set({ steer: 0.37, throttle: 0.8, brake: 0, handbrake: true, angle: 12.4 });
  r.run(1500);
  var rd = r.hub.read(r.net.now());
  assert.equal(rd.source, 'wheel'); assert.equal(rd.steer, 0.37); assert.equal(rd.throttle, 0.8); assert.equal(rd.handbrake, true);
  assert.ok(r.rx.rate >= 55 && r.rx.rate <= 65, 'rate ' + r.rx.rate);
  assert.ok(Math.abs(r.rx.rtt() - 40) <= 6, 'desktop rtt ' + r.rx.rtt());
  assert.ok(Math.abs(r.tx.rtt() - 40) <= 6, 'phone rtt ' + r.tx.rtt());
  // continuous steer: a sweep arrives unquantised (3 decimals)
  var seen = [];
  r.rx.on('input', function (i) { seen.push(i.steer); });
  r.run(500, function (t) { r.tx.set({ steer: Math.sin(t / 200) * 0.9 }); });
  assert.ok(new Set(seen).size > 20, 'distinct values ' + new Set(seen).size);
  // buttons -> hub edge events
  r.tx.press('shiftUp'); r.tx.press('pause'); r.run(100);
  assert.deepEqual(r.hub.takeEvents().map(function (e) { return e.type; }), ['shiftUp', 'pause']);
  // the race reports a wall hit and status -> phone vibrates / shows state
  r.hub.frame({ driving: true, speed: 20, gear: 3, events: [{ type: 'wall', carId: 'player', intensity: 0.9 }], playerId: 'player', now: r.net.now() });
  r.rx.telemetry({ speed: 20, gear: 3, rpmFrac: 0.5 }, r.net.now());
  r.run(100);
  assert.deepEqual(got.hap, ['wall']);
  assert.equal(got.status.driving, true); assert.equal(got.status.gear, 3);
  assert.equal(got.tel.spd, 72); assert.equal(got.tel.gear, 3);
  r.rx.close(); r.host.close();
});

test('wheel failsafe: stalled phone or dropped link -> centred steering, no throttle; reconnect resumes; gone -> inactive', function () {
  var r = wheelRig(), ticking = true;
  r.run(300);
  r.tx.set({ steer: -0.8, throttle: 1, brake: 0 });
  r.run(300);
  assert.equal(r.hub.read(r.net.now()).throttle, 1);
  // 1) the phone stops sending (app backgrounded, screen locked) with the link still up
  var t0 = r.net.now();
  for (var k = 0; k < 100; k++) r.net.advance(4);
  var rd = r.hub.read(r.net.now());
  assert.ok(r.net.now() - t0 >= 250);
  assert.equal(rd.active, true); assert.equal(rd.steer, 0); assert.equal(rd.throttle, 0); assert.equal(rd.brake, 0);
  // the race-ui input sees a car coasting straight
  var hubSave = CB.input.hub; CB.input.hub = r.hub;
  try {
    var I = UI._.createInput({ settings: UI._.DEFAULT_SETTINGS });
    var o = I.sample(1 / 120, 30);
    assert.equal(o.throttle, 0); assert.ok(Math.abs(o.steer) < 1e-9);
  } finally { CB.input.hub = hubSave; }
  r.run(200);
  assert.equal(r.hub.read(r.net.now()).throttle, 1, 'sending again -> live');
  // 2) the link drops (wifi blip): neutral at once, then the transport re-links and input resumes
  r.net.disconnect('phone1');
  r.net.advance(10);
  rd = r.hub.read(r.net.now());
  assert.equal(rd.throttle, 0); assert.equal(rd.steer, 0);
  r.run(1500);
  assert.equal(r.rx.state, 'connected', 'reconnected');
  assert.equal(r.hub.read(r.net.now()).steer, -0.8);
  // 3) gone for good: after the host's grace period the source is inactive (keyboard takes over)
  r.net.disconnect('phone1', { permanent: true });
  for (var j = 0; j < 1200; j++) r.net.advance(4);
  rd = r.hub.read(r.net.now());
  assert.equal(rd.active, false); assert.equal(r.rx.state, 'waiting');
  assert.equal(ticking, true);
  r.rx.close(); r.host.close();
});

test('wheel: route parsing and phone URLs', function () {
  assert.deepEqual(W.parseRoute('#/wheel/ABCDE'), { code: 'ABCDE', via: 'online', invite: null, raw: 'ABCDE' });
  assert.equal(W.parseRoute('#/wheel/abcde?via=local').via, 'local');
  assert.equal(W.parseRoute('#/wheel/abcde?via=local').code, 'ABCDE');
  assert.equal(W.parseRoute('#/wheel/ABC').code, null);
  assert.equal(W.parseRoute('#/wheel/~xyz123').invite, 'xyz123');
  assert.equal(W.parseRoute('#/race'), null);
  assert.ok(/index\.html#\/wheel\/ABCDE\?via=local$/.test(W.urlFor('ABCDE', 'local')));
});

/* ---------------------------------------------------------------- assists */
var T = CB.race.tracks, geom = T.geometry('forge-ring'), S = geom.samples, straight = 0;
for (var si = 0; si < S.length; si++) if (Math.abs(S[si].curvature) < Math.abs(S[straight].curvature)) straight = si;
var P = V.fromBuild(CB.data.defaultBuild());
function yawFor(level, raw, v, dur) {
  var a = A.create({ level: level, mode: 'race' }), sm = S[straight];
  var s = V.createState(P, { x: sm.x, y: sm.y, heading: sm.heading, speed: v }, { autoShift: true });
  var dt = 1 / 120, acc = 0, n = 0;
  for (var t = 0; t < dur; t += dt) {
    var o = a.filter(Object.assign({ throttleAxis: 0.35 }, raw), s, { dt: dt, geom: geom, params: P });
    V.step(P, s, o, dt, { gripMult: 1 });
    if (t > dur - 0.25) { acc += s.yawRate; n++; }
  }
  return acc / n;
}

test('heavy assist: analog wheel steer is proportional (not quantised, no line pick)', function () {
  var r0 = yawFor('heavy', { steerAxis: 0, steerAnalog: true }, 12, 0.8);
  var r1 = yawFor('heavy', { steerAxis: 0.05, steerAnalog: true }, 12, 0.8);
  var r2 = yawFor('heavy', { steerAxis: 0.1, steerAnalog: true }, 12, 0.8);
  var r4 = yawFor('heavy', { steerAxis: 0.2, steerAnalog: true }, 12, 0.8);
  var rn = yawFor('heavy', { steerAxis: -0.1, steerAnalog: true }, 12, 0.8);
  assert.ok(Math.abs(r0) < 0.01, 'centred wheel = straight: ' + r0);
  assert.ok(r1 > 0.01 && r2 > r1 && r4 > r2, 'monotone: ' + [r1, r2, r4]);
  assert.ok(Math.abs(r2 / r1 - 2) < 0.5 && Math.abs(r4 / r2 - 2) < 0.5, 'proportional: ' + [r1, r2, r4]);
  assert.ok(Math.abs(rn + r2) < 0.15 * r2, 'symmetric: ' + [rn, r2]);
  // keys / legacy axis without the analog flag: the line hold picks the line (magnitude ignored) - the old behaviour
  var k1 = yawFor('heavy', { steerAxis: 0.05 }, 12, 0.8), k2 = yawFor('heavy', { steerAxis: 0.2 }, 12, 0.8);
  assert.ok(Math.abs(k1 - k2) < 0.02, 'digital-style path ignores magnitude: ' + [k1, k2]);
  // every level stays proportional for the analog wheel
  ['off', 'light', 'medium'].forEach(function (lvl) {
    var a1 = yawFor(lvl, { steerAxis: 0.05, steerAnalog: true }, 12, 0.8), a2 = yawFor(lvl, { steerAxis: 0.1, steerAnalog: true }, 12, 0.8);
    assert.ok(a2 > a1 * 1.5 && a1 > 0, lvl + ': ' + [a1, a2]);
  });
});

test('drift session keeps the analog flag through its intent normalisation', function () {
  var ti = CB.race.drift.session._internal.toIntent;
  var it = ti({ left: false, right: false, up: true, steerAxis: 0.3, steerAnalog: true });
  assert.equal(it.steerAnalog, true); assert.equal(it.steerAxis, 0.3);
  assert.equal(ti({ left: true }).steerAnalog, undefined);
});

test('drift (heavy, arcade drift lock): analog wheel magnitude scales the steer, both directions', function () {
  ['js/race/ai.js', 'js/race/engine.js', 'js/race/drift/scoring.js', 'js/race/drift/tracks.js', 'js/race/drift/ai.js', 'js/race/drift/arcade.js']
    .forEach(function (f) { require(path.join(root, f)); });
  var DS = CB.race.drift.session, tr = DS.tracksFor('drift')[0].id;
  function steerFor(ax) {
    var s = CB.race.drift.createSession({ trackId: tr, seed: 3, assist: 'heavy' }), acc = 0, n = 0;
    for (var i = 0; i < 60 * 1.5; i++) s.update(1 / 60, { up: false, throttleAxis: 0, steerAxis: 0, steerAnalog: true });
    for (var j = 0; j < 30; j++) { s.update(1 / 60, { throttleAxis: 0.5, steerAxis: ax, steerAnalog: true }); if (j > 15) { acc += s._debug().playerCar.input.steer; n++; } }
    return acc / n;
  }
  var lo = steerFor(0.15), hi = steerFor(0.45), neg = steerFor(-0.45);
  assert.ok(lo > 0 && hi > lo * 1.8, 'proportional low-speed steer: ' + [lo, hi]);
  assert.ok(neg < 0 && Math.abs(neg + hi) < 0.25 * hi + 0.02, 'symmetric: ' + [neg, hi]);
});

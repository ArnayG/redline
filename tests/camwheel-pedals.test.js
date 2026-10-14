/* Node tests for the webcam wheel's hands-only pedals (js/input/camwheel-hands.js createPedals) and the 3-2-1 re-centre
   countdown (js/input/camwheel.js createCountdown). Hands are synthesised from the real MediaPipe landmark fixtures
   (tests/fixtures/hands/landmarks.json, closed fists): an OPEN hand straightens each finger along its MCP direction, a
   half-curl interpolates between the two, push / pull scales the hand about its palm centre, with landmark noise.
   Run: node tests/run.js camwheel-pedals */
'use strict';
var path = require('path');
var CH = require(path.join(__dirname, '..', 'js/input/camwheel-hands.js'));
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var FIX = require('./fixtures/hands/landmarks.json');
var W = FIX.video.w, H = FIX.video.h;

function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function fists() { return FIX.frames[0].hands.map(function (h) { return { lm: h.lm.map(function (p) { return { x: p[0], y: p[1], z: p[2] }; }), score: h.score, label: h.label }; }); }
/** the same hand with straight fingers (each finger continues along wrist -> its MCP) */
function openOf(lm) {
  var o = lm.map(function (p) { return { x: p.x, y: p.y, z: p.z }; }), w = o[0];
  [[5, 8], [9, 12], [13, 16], [17, 20]].forEach(function (f) {
    var b = o[f[0]], dx = b.x - w.x, dy = b.y - w.y;
    for (var k = 1; k <= 3; k++) o[f[0] + k] = { x: b.x + dx * 0.3 * k, y: b.y + dy * 0.3 * k, z: b.z };
  });
  // the thumb out too
  var t1 = o[1]; o[2] = { x: t1.x + (t1.x - w.x) * 0.6, y: t1.y + (t1.y - w.y) * 0.6, z: t1.z }; o[3] = { x: t1.x + (t1.x - w.x) * 1.1, y: t1.y + (t1.y - w.y) * 1.1, z: t1.z }; o[4] = { x: t1.x + (t1.x - w.x) * 1.6, y: t1.y + (t1.y - w.y) * 1.6, z: t1.z };
  return o;
}
/** grip g: 0 = open .. 1 = the fixture fist; scale k about the palm centre (k < 1 = pulled back); noise sigma px */
function pose(g, k, noise, R) {
  return fists().map(function (h) {
    var op = openOf(h.lm), pc = CH.palm(h.lm, W, H), cx = 1 - pc.x / W, cy = pc.y / H;
    var lm = h.lm.map(function (p, i) {
      var x = op[i].x + (p.x - op[i].x) * g, y = op[i].y + (p.y - op[i].y) * g, z = op[i].z + (p.z - op[i].z) * g;
      x = cx + (x - cx) * k; y = cy + (y - cy) * k; z *= k;
      if (noise) { x += (R() - 0.5) * 2 * noise / W; y += (R() - 0.5) * 2 * noise / H; }
      return { x: x, y: y, z: z };
    });
    return { lm: lm, score: h.score, label: h.label };
  });
}
function rig(prefs) {
  var S = CH.createSolver(), P = CH.createPedals(), t = 0;
  var m = S.update(pose(0, 1), W, H, t); S.calibrate();
  P.update(m, t, prefs); P.calibrateNeutral(m, { curl: true });
  var mg = S.update(pose(1, 1), W, H, t += 33); P.update(mg, t, prefs); P.calibrateGrip(mg);
  return {
    S: S, P: P,
    feed: function (g, k, n, noise, R) { var o, m2; for (var i = 0; i < (n || 1); i++) { t += 33; m2 = S.update(pose(g, k, noise, R), W, H, t); o = P.update(m2, t, prefs); } return { out: o, meas: m2, t: t }; },
    lost: function (ms) { t += ms; S.update([], W, H, t); return P.update({ ok: false }, t, prefs); },
    t: function () { return t; }
  };
}

test('camwheel pedals: curl and hand scale on synthesised open / half / closed hands', function () {
  var c0 = CH.curl(pose(0, 1)[0].lm), c5 = CH.curl(pose(0.5, 1)[0].lm), c1 = CH.curl(pose(1, 1)[0].lm);
  assert.ok(c0 < 0.2 && c1 > 0.9 && c5 > c0 + 0.15 && c5 < c1 - 0.15, 'curl open ' + c0 + ' half ' + c5 + ' fist ' + c1);
  // the hand scale uses the palm only: closing the fingers does not change it; pulling back does
  var s0 = CH.handScale(pose(0, 1)[0].lm, null, W, H).s, s1 = CH.handScale(pose(1, 1)[0].lm, null, W, H).s, sb = CH.handScale(pose(1, 0.8)[0].lm, null, W, H).s;
  assert.ok(Math.abs(s1 / s0 - 1) < 1e-9, 'grip leaves the scale alone ' + s1 / s0);
  assert.ok(Math.abs(sb / s1 - 0.8) < 1e-6, 'pulled back 20 %: ' + sb / s1);
  // world landmarks (metres): px per metre, unchanged by tilting the hand towards / away from the camera
  var wl = pose(1, 1)[0].lm.map(function (p) { return { x: (p.x - 0.5) * 0.2, y: (p.y - 0.5) * 0.2 * H / W, z: 0 }; });
  var a = CH.handScale(pose(1, 1)[0].lm, wl, W, H);
  assert.ok(a.world && a.s > 0, 'world scale');
  assert.ok(Math.abs(CH.curl(pose(1, 1)[0].lm, wl) - CH.curl(pose(1, 1)[0].lm)) < 0.35, 'world curl agrees roughly');
});

test('camwheel pedals: steering point and angle unaffected by closing the hands', function () {
  var S = CH.createSolver(), t = 0;
  S.update(pose(0, 1), W, H, t); S.calibrate();
  var a0 = null, maxD = 0, maxP = 0, p0 = null;
  for (var g = 0; g <= 1.0001; g += 0.1) {
    t += 33; var m = S.update(pose(g, 1), W, H, t);
    if (a0 == null) { a0 = m.angle; p0 = m.pts[0]; }
    maxD = Math.max(maxD, Math.abs(m.angle - a0)); maxP = Math.max(maxP, Math.hypot(m.pts[0].x - p0.x, m.pts[0].y - p0.y));
  }
  assert.ok(maxD < 0.01 && maxP < 0.01, 'angle change ' + maxD + ' deg, palm centre moved ' + maxP + ' px');
});

test('camwheel pedals: grip to drive classifies gas / coast / brake with noise (accuracy), proportional gas', function () {
  var R = rng(7), ok = 0, n = 0, conf = {};
  var cases = [[0, 1, 'coast'], [0.1, 1, 'coast'], [1, 1, 'gas'], [0.85, 1, 'gas'], [0, 0.78, 'brake'], [1, 0.78, 'brake'], [0.4, 0.75, 'brake']];
  for (var trial = 0; trial < 40; trial++) {
    cases.forEach(function (c) {
      var r = rig({ pedals: 'grip' });
      var o = r.feed(c[0], c[1], 8, 2.5, R).out;
      n++; if (o.state === c[2]) ok++; else conf[c.join('/') + '->' + o.state] = (conf[c.join('/') + '->' + o.state] || 0) + 1;
    });
  }
  var acc = ok / n;
  console.log('    grip classifier accuracy ' + (acc * 100).toFixed(1) + ' % of ' + n + (Object.keys(conf).length ? ' ' + JSON.stringify(conf) : ''));
  assert.ok(acc >= 0.98, 'accuracy ' + acc);
  // proportional: a half grip gives part throttle, a full grip full throttle; the brake overrides the gas
  var r2 = rig({ pedals: 'grip' });
  var half = r2.feed(0.6, 1, 10).out.throttle, full = r2.feed(1, 1, 10).out.throttle;
  assert.ok(half > 0.2 && half < 0.85 && full === 1, 'half ' + half + ' full ' + full);
  var b = r2.feed(1, 0.75, 10).out;
  assert.ok(b.throttle === 0 && b.brake > 0.6, 'pull back with closed hands brakes: ' + JSON.stringify(b));
  // reverse needs brake > 0.6 at a standstill (engine rule): a firm pull back gives it
  assert.ok(r2.feed(0, 0.72, 10).out.brake >= 0.95, 'full pull = full brake');
});

test('camwheel pedals: hysteresis (no flicker near the thresholds) and quick response', function () {
  var r = rig({ pedals: 'grip' }), R = rng(3), flips = 0, last = null;
  r.feed(1, 1, 5);
  // hover at the grip level just above the release threshold with noise: stays on gas
  for (var i = 0; i < 120; i++) { var o = r.feed(0.45 + (R() - 0.5) * 0.06, 1, 1, 2, R).out; var on = o.throttle > 0; if (last !== null && on !== last) flips++; last = on; }
  assert.equal(flips, 0, 'gas flicker ' + flips);
  // hover in the pull-back band between pullOn and pullOff
  r.feed(0, 0.8, 5); flips = 0; last = null;
  for (i = 0; i < 120; i++) { var b = r.feed(0, 0.885 + (R() - 0.5) * 0.02, 1, 1, R).out; var bo = b.brake > 0; if (last !== null && bo !== last) flips++; last = bo; }
  assert.equal(flips, 0, 'brake flicker ' + flips);
  // response: open -> closed step; gas within 2 camera frames (66 ms), release within 2 frames
  var r2 = rig({ pedals: 'grip' }); r2.feed(0, 1, 10);
  var frames = 0; while (r2.feed(1, 1, 1).out.throttle === 0 && frames < 10) frames++;
  assert.ok(frames <= 1, 'gas after ' + (frames + 1) + ' frames');
  frames = 0; while (r2.feed(0, 1, 1).out.throttle > 0 && frames < 10) frames++;
  assert.ok(frames <= 1, 'release after ' + (frames + 1) + ' frames');
  frames = 0; while (r2.feed(1, 0.75, 1).out.brake === 0 && frames < 10) frames++;
  assert.ok(frames <= 1, 'brake after ' + (frames + 1) + ' frames');
});

test('camwheel pedals: lost hands -> no gas after 150 ms, light brake after 0.5 s, never stuck', function () {
  var r = rig({ pedals: 'grip' }), t0;
  var g = r.feed(1, 1, 10);
  assert.equal(g.out.throttle, 1);
  t0 = g.t;
  assert.equal(r.P.read(t0 + 100).throttle, 1, 'one dropped frame changes nothing');
  var a = r.P.read(t0 + 200); assert.ok(a.throttle === 0 && a.brake === 0 && a.state === 'lost', JSON.stringify(a));
  var b = r.P.read(t0 + 600); assert.ok(b.throttle === 0 && b.brake > 0 && b.brake <= 0.35, JSON.stringify(b));
  // no new results at all (worker stalled): read() still lifts the gas
  assert.equal(r.P.read(t0 + 5000).throttle, 0);
  // back: needs a fresh grip (no stale gas)
  r.lost(5000);
  var back = r.feed(0, 1, 1).out; assert.equal(back.throttle, 0);
});

test('camwheel pedals: auto-gas, push / pull and keyboard-only modes', function () {
  var a = rig({ pedals: 'auto' });
  assert.equal(a.feed(1, 1, 6).out.throttle, 1, 'auto: gripping = gas');
  assert.equal(a.feed(0.5, 1, 6).out.throttle, 1, 'auto: relaxed = still gas');
  var ob = a.feed(0, 1, 6).out; assert.ok(ob.throttle === 0 && ob.brake > 0.4, 'auto: open hands = brake ' + JSON.stringify(ob));
  var p = rig({ pedals: 'push' });
  assert.equal(p.feed(0.5, 1, 6).out.state, 'coast', 'push: neutral = coast');
  var pg = p.feed(0.5, 1.2, 6).out; assert.ok(pg.throttle > 0.3, 'push: towards the screen = gas ' + JSON.stringify(pg));
  assert.equal(p.feed(0.5, 1.4, 6).out.throttle, 1);
  var pb = p.feed(0.5, 0.78, 6).out; assert.ok(pb.brake > 0.4 && pb.throttle === 0, 'push: pull back = brake');
  var k = rig({ pedals: 'off' }), ko = k.feed(1, 0.7, 6).out;
  assert.ok(ko.throttle === 0 && ko.brake === 0 && ko.state === 'off', 'off ' + JSON.stringify(ko));
  assert.equal(k.lost(800).brake, 0, 'off: no lost brake either');
});

test('camwheel pedals: neutral scale follows slow leaning, not a held brake; one hand keeps its own neutral', function () {
  var r = rig({ pedals: 'grip' });
  // leaning in slowly by 5 % over 40 s: no brake later at the new spot
  for (var i = 0; i <= 40 * 30; i++) r.feed(1, 1 + 0.05 * i / 1200, 1);
  assert.equal(r.feed(1, 1.05, 30).out.state, 'gas');
  assert.equal(r.feed(1, 0.98, 5).out.state, 'gas', 'small move back after leaning in: still gas');
  // holding the brake for 10 s does not erode it
  var b = r.feed(1, 0.8, 300).out; assert.equal(b.state, 'brake');
  // one hand (the other out of view) keeps braking / driving by its own neutral
  var S = r.S, P = r.P, t = r.t() + 33, m = S.update([pose(1, 1)[0]], W, H, t), o = P.update(m, t, { pedals: 'grip' });
  for (i = 0; i < 6; i++) { t += 33; m = S.update([pose(1, 1)[0]], W, H, t); o = P.update(m, t, { pedals: 'grip' }); }
  assert.equal(o.state, 'gas', 'one hand: ' + JSON.stringify(o));
});

test('camwheel pedals: handbrake yank and item flick gestures (opt-in), steering turns do not trigger them', function () {
  var S = CH.createSolver(), P = CH.createPedals(), t = 0, prefs = { pedals: 'grip', gestureHandbrake: true, gestureItem: true };
  function shift(hs, dyPx) { return hs.map(function (h) { return { lm: h.lm.map(function (p) { return { x: p.x, y: p.y + dyPx / H, z: p.z }; }), score: h.score, label: h.label }; }); }
  function rotP(hs, deg) {
    var c = { x: 0, y: 0 }; hs.forEach(function (h) { var p = CH.palm(h.lm, W, H); c.x += p.x / 2; c.y += p.y / 2; });
    var a = deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    return hs.map(function (h) { return { score: h.score, label: h.label, lm: h.lm.map(function (p) { var X = (1 - p.x) * W - c.x, Y = p.y * H - c.y; return { x: 1 - (X * co - Y * si + c.x) / W, y: (X * si + Y * co + c.y) / H, z: p.z }; }) }; });
  }
  var m = S.update(pose(1, 1), W, H, t); S.calibrate(); P.update(m, t, prefs); P.calibrateNeutral(m);
  var hb = false, item = false, i, o;
  // brisk steering: +-60 deg at ~1.5 turns/s
  for (i = 0; i < 90; i++) { t += 33; o = P.update(S.update(rotP(pose(1, 1), 60 * Math.sin(i * 0.3)), W, H, t), t, prefs); hb = hb || o.handbrake; item = item || o.item; }
  assert.ok(!hb && !item, 'steering alone: no handbrake / item');
  // a quick yank down by ~1.2 palm sizes in 130 ms
  var size = CH.palm(pose(1, 1)[0].lm, W, H).size;
  for (i = 1; i <= 4; i++) { t += 33; o = P.update(S.update(shift(pose(1, 1), size * 0.3 * i), W, H, t), t, prefs); hb = hb || o.handbrake; }
  assert.ok(hb, 'yank down = handbrake');
  assert.ok(P.read(t + 100).handbrake, 'handbrake held briefly');
  for (i = 0; i < 30; i++) { t += 33; o = P.update(S.update(shift(pose(1, 1), size * 1.2), W, H, t), t, prefs); }
  assert.ok(!o.handbrake, 'released after ~0.4 s');
  for (i = 1; i <= 4; i++) { t += 33; o = P.update(S.update(shift(pose(1, 1), size * (1.2 - 0.3 * i)), W, H, t), t, prefs); item = item || o.item; }
  assert.ok(item, 'flick up = item');
  // off by default
  var P2 = CH.createPedals(), S2 = CH.createSolver(); t = 0; hb = false;
  for (i = 0; i < 8; i++) { t += 33; o = P2.update(S2.update(shift(pose(1, 1), size * 0.3 * i), W, H, t), t, { pedals: 'grip' }); hb = hb || o.handbrake || o.item; }
  assert.ok(!hb, 'gestures off by default');
});

test('camwheel: prefs default to fist = go / open = brake pedals (old grip default migrated); pedal calibration normalised', function () {
  var p = CW.normPrefs({});
  assert.equal(p.pedals, 'fist'); assert.equal(p.pullBrake, false); assert.equal(p.gestureHandbrake, false); assert.equal(p.gestureItem, false); assert.equal(p.gestureNitro, false);
  assert.equal(CW.normPrefs({ pedals: 'push' }).pedals, 'push');
  assert.equal(CW.normPrefs({ pedals: 'bogus' }).pedals, 'fist');
  assert.equal(CW.normPrefs({ pedals: 'grip' }).pedals, 'fist', 'the old default moves to the new one');
  assert.equal(CW.normPrefs({ pedals: 'grip', pedalsV: 2 }).pedals, 'grip', 'chosen again later: kept');
  var c = CW.normPrefs({ pedalCal: { open: 0.5, grip: 0.4, scale: { a: 12, b: -1 }, v: 2 } }).pedalCal;
  assert.ok(c.grip >= c.open + 0.15 && c.scale.a === 12 && c.scale.b == null, JSON.stringify(c));
  assert.equal(CW.normPrefs({ pedalCal: { open: 0.3, grip: 0.9, scale: { a: 12 } } }).pedalCal.scale.a, undefined, 'an old 2D neutral size is dropped');
});

test('camwheel countdown: 3-2-1 then one capture; again = cancel; re-trigger restarts; calibrate adds the grip step', function () {
  var cd = CW.createCountdown();
  assert.equal(cd.step(0), null, 'idle');
  var e = cd.start(1000, [{ id: 'neutral', ms: 3000 }], 'centre');
  assert.equal(e.state, 'count'); assert.equal(e.left, 3);
  assert.equal(cd.step(1999).left, 3); assert.equal(cd.step(2001).left, 2); assert.equal(cd.step(3500).left, 1); assert.equal(cd.step(3999).left, 1);
  var cap = cd.step(4000);
  assert.equal(cap.state, 'capture'); assert.equal(cap.phase, 'neutral'); assert.equal(cap.next, null);
  assert.equal(cd.step(4050), null, 'captured once only');
  // toggle: running -> cancelled, nothing captured afterwards
  cd.toggle(5000, null, 'centre');
  assert.ok(cd.active());
  assert.equal(cd.toggle(6000).state, 'cancelled');
  assert.equal(cd.step(9000), null, 'no capture after a cancel');
  // re-trigger after a cancel: a fresh full 3 s
  cd.toggle(10000, null, 'centre'); cd.cancel(); var r = cd.toggle(10500, null, 'centre');
  assert.equal(r.left, 3); assert.equal(cd.step(13400).state, 'count'); assert.equal(cd.step(13500).state, 'capture');
  // calibrate: neutral, then grip
  cd.start(0, [{ id: 'neutral', ms: 3000 }, { id: 'grip', ms: 2000 }], 'calibrate');
  var c1 = cd.step(3000); assert.equal(c1.phase, 'neutral'); assert.equal(c1.next, 'grip');
  assert.equal(cd.step(3100).phase, 'grip'); assert.equal(cd.step(3100).left, 2);
  var c2 = cd.step(5000); assert.equal(c2.phase, 'grip'); assert.equal(c2.next, null); assert.equal(c2.kind, 'calibrate');
  assert.ok(!cd.active());
});

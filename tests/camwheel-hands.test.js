/* Node tests for the bare-hands webcam wheel maths (js/input/camwheel-hands.js): palm centres / roll / curl, the
   two-hand line angle, crossing past 90 deg, one-hand roll, switching two <-> one hand without jumps, identity by
   continuity, re-identification by geometry after a loss, gestures, and the steer filter's lookahead. Uses real
   MediaPipe landmarks (tests/fixtures/hands/landmarks.json) and rigid rotations of them.
   Run: node tests/run.js camwheel-hands      (the MediaPipe browser test: REDLINE_E2E=1 node tests/run.js camwheel-e2e) */
'use strict';
var path = require('path');
var CH = require(path.join(__dirname, '..', 'js/input/camwheel-hands.js'));
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var FIX = require('./fixtures/hands/landmarks.json');
var W = FIX.video.w, H = FIX.video.h;

function hands(frame) { return frame.hands.map(function (h) { return { lm: h.lm.map(function (p) { return { x: p[0], y: p[1], z: p[2] }; }), score: h.score, label: h.label }; }); }
function level() { return hands(FIX.frames.filter(function (f) { return f.truth === 0; })[0]); }
/** rotate hands rigidly by deg (player view, clockwise +) about (cx, cy) px */
function rot(hs, deg, cx, cy, dx, dy) {
  var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return hs.map(function (h) {
    return { score: h.score, label: h.label, lm: h.lm.map(function (p) {
      var X = (1 - p.x) * W - cx, Y = p.y * H - cy;
      return { x: 1 - (X * c - Y * s + cx + (dx || 0)) / W, y: (X * s + Y * c + cy + (dy || 0)) / H, z: p.z };
    }) };
  });
}
function hub(hs) { var a = CH.palm(hs[0].lm, W, H), b = CH.palm(hs[1].lm, W, H); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

test('camhands: palm centre, roll and curl from real landmarks', function () {
  var hs = level(), p0 = CH.palm(hs[0].lm, W, H), p1 = CH.palm(hs[1].lm, W, H);
  assert.ok(p0.size > 20 && p1.size > 20, 'palm sizes ' + p0.size + ' ' + p1.size);
  assert.ok(Math.abs(p0.y - p1.y) < 6, 'level hands: palm centres at the same height');
  var r0 = CH.handRoll(hs[0].lm, W, H), turned = CH.handRoll(rot(hs, 30, p0.x, p0.y)[0].lm, W, H);
  assert.ok(Math.abs(CW.wrapP(turned.a - r0.a - 30, 360)) < 1e-6 && Math.abs(CW.wrapP(turned.b - r0.b - 30, 360)) < 1e-6, 'roll follows a rotation');
  // a straight open hand vs the fixture's fists
  var open = hs[0].lm.map(function (p) { return { x: p.x, y: p.y, z: p.z }; }), w = open[0], m = open[9];
  [[5, 8], [9, 12], [13, 16], [17, 20]].forEach(function (f) {
    var b = open[f[0]], dx = b.x - w.x, dy = b.y - w.y;
    for (var k = 1; k <= 3; k++) open[f[0] + k] = { x: b.x + dx * 0.33 * k, y: b.y + dy * 0.33 * k, z: b.z };
  });
  assert.ok(m && CH.curl(open) < 0.25, 'open hand curl ' + CH.curl(open));
  assert.ok(CH.curl(hs[0].lm) > CH.curl(open) + 0.3, 'fist curls more: ' + CH.curl(hs[0].lm));
});

test('camhands: two-hand angle matches the real frames (MediaPipe landmarks of the synthetic video)', function () {
  var S = CH.createSolver(), t = 0;
  S.update(level(), W, H, t); S.calibrate();
  var errs = [];
  // the frames are seconds apart: feed each one a few times (continuity is not the point here)
  FIX.frames.forEach(function (f) {
    var m;
    for (var i = 0; i < 3; i++) { t += 33; m = S.update(hands(f), W, H, t); }
    // frames seconds apart: which hand is which cannot follow by continuity, so compare the LINE (mod 180)
    var e = Math.abs(CW.wrapP(m.angle - f.truth, 180));
    errs.push(e);
  });
  errs.forEach(function (e, i) { assert.ok(e < 3, 'frame ' + FIX.frames[i].idx + ' err ' + e); });
});

test('camhands: continuous through the hands crossing past 90 and past 180 deg', function () {
  var S = CH.createSolver(), hs = level(), c = hub(hs), t = 0;
  S.update(hs, W, H, t); S.calibrate();
  var path = [], a;
  for (a = 0; a <= 200; a += 4) path.push(a);
  for (a = 196; a >= -200; a -= 4) path.push(a);
  var maxErr = 0;
  path.forEach(function (deg) { t += 33; var m = S.update(rot(hs, deg, c.x, c.y), W, H, t); assert.equal(m.mode, 'two'); maxErr = Math.max(maxErr, Math.abs(m.angle - deg)); });
  assert.ok(maxErr < 0.01, 'max err ' + maxErr);
  // hand order in the detector output does not matter (identity follows position)
  t += 33; var m2 = S.update(rot(hs, -200, c.x, c.y).reverse(), W, H, t);
  assert.ok(Math.abs(m2.angle + 200) < 0.01, 'swapped order ' + m2.angle);
});

test('camhands: one hand steers by its roll; switching hands never jumps', function () {
  var S = CH.createSolver(), hs = level(), c = hub(hs), t = 0, m;
  S.update(hs, W, H, t); S.calibrate();
  for (var a = 0; a <= 30; a += 3) { t += 33; m = S.update(rot(hs, a, c.x, c.y), W, H, t); }
  var before = m.angle;
  // right hand drops out of view: the left hand alone carries on
  t += 33; m = S.update([rot(hs, 30, c.x, c.y)[0]], W, H, t);
  assert.equal(m.mode, 'one'); assert.ok(Math.abs(m.angle - before) < 1, 'no jump: ' + before + ' -> ' + m.angle);
  // keep turning with one hand (it rotates about its own palm on the rim)
  var errs = [];
  for (a = 30; a >= -40; a -= 5) { t += 33; m = S.update([rot(hs, a, c.x, c.y)[0]], W, H, t); errs.push(Math.abs(m.angle - a)); }
  assert.ok(Math.max.apply(null, errs) < 1.5, 'one-hand err ' + Math.max.apply(null, errs));
  // the other hand comes back: no jump, then it settles on the absolute two-hand angle
  t += 33; var back = S.update(rot(hs, -40, c.x, c.y), W, H, t);
  assert.equal(back.mode, 'two'); assert.ok(Math.abs(back.angle - m.angle) < 1.5, 'no jump back ' + m.angle + ' -> ' + back.angle);
  for (var i = 0; i < 30; i++) { t += 33; back = S.update(rot(hs, -40, c.x, c.y), W, H, t); }
  assert.ok(Math.abs(back.angle + 40) < 0.1, 'settled ' + back.angle);
});

test('camhands: lost hands re-identified by geometry, never upside down on first sight (labels ignored)', function () {
  var S = CH.createSolver(), hs = level(), c = hub(hs), t = 0;
  S.update(hs, W, H, t); S.calibrate();
  var px0 = CH.palm(hs[0].lm, W, H).x, px1 = CH.palm(hs[1].lm, W, H).x;
  assert.notEqual(hs[0].label, hs[1].label, 'fixture: two different handedness labels');
  S.cal.labels = px0 < px1 ? { a: hs[0].label, b: hs[1].label } : { a: hs[1].label, b: hs[0].label };
  t += 33; S.update(rot(hs, 120, c.x, c.y), W, H, t);
  // gone for 2 s, back crossed at 150 deg: on first sight the only plausible reading is the level twin, -30 (the
  // handedness labels are not trusted: they flip with the back of the hand / rotations, and once gave -180 starts)
  t += 2000; S.update([], W, H, t);
  t += 33; var m = S.update(rot(hs, 150, c.x, c.y), W, H, t);
  assert.ok(Math.abs(CW.wrapP(m.angle + 30, 360)) < 0.5, 'labels: ' + m.angle);
  assert.equal(m.fresh, true);
  var S2 = CH.createSolver(); t = 0; S2.update(hs, W, H, t); S2.calibrate();
  t += 2000; S2.update([], W, H, t); t += 33;
  var m2 = S2.update(rot(hs.map(function (h) { return { lm: h.lm, score: h.score, label: '' }; }), 150, c.x, c.y), W, H, t);
  assert.ok(Math.abs(CW.wrapP(m2.angle + 30, 360)) < 0.5, 'no labels: ' + m2.angle);
  // back at 40 deg: 40 (not -140), whichever order the detector lists the hands in
  t += 2000; S2.update([], W, H, t); t += 33;
  var m3 = S2.update(rot(hs, 40, c.x, c.y).reverse(), W, H, t);
  assert.ok(Math.abs(m3.angle - 40) < 0.5, 'reversed order: ' + m3.angle);
});

test('camhands: gestures are off by default; fists = throttle, push towards the camera = nitro', function () {
  var st = {}, meas = { ok: true, pts: [{ curl: 0.9, size: 50 }, { curl: 0.85, size: 50 }] };
  assert.deepEqual(CH.gestures(meas, {}, 0, st), { throttle: null, nitro: false });
  assert.equal(CH.gestures(meas, { gestureThrottle: true }, 0, st).throttle, 1);
  var open = { ok: true, pts: [{ curl: 0.1, size: 50 }, { curl: 0.2, size: 50 }] };
  assert.equal(CH.gestures(open, { gestureThrottle: true }, 33, st).throttle, 0);
  var mid = { ok: true, pts: [{ curl: 0.5, size: 50 }, { curl: 0.5, size: 50 }] };
  assert.equal(CH.gestures(mid, { gestureThrottle: true }, 66, st).throttle, 0, 'in between keeps the last state');
  var g = {}, t = 0, out;
  for (var i = 0; i < 10; i++, t += 33) out = CH.gestures({ ok: true, pts: [{ curl: 0.8, size: 50 }] }, { gestureNitro: true }, t, g);
  assert.equal(out.nitro, false, 'steady size: no nitro');
  for (i = 0; i < 8; i++, t += 33) out = CH.gestures({ ok: true, pts: [{ curl: 0.8, size: 50 + i * 2.5 }] }, { gestureNitro: true }, t, g);
  assert.equal(out.nitro, true, 'push -> nitro');
  out = CH.gestures({ ok: true, pts: [{ curl: 0.8, size: 68 }] }, { gestureNitro: true }, t + 1200, g);
  assert.equal(out.nitro, false, 'nitro lasts ~1 s');
});

test('camhands: lookahead cancels the smoothing lag with little overshoot', function () {
  function run(la) {
    var st = CW.createSteer({ maxAngle: 90, smoothing: 0.3, deadzone: 0, lookahead: la }), lags = [], over = 0;
    for (var i = 0; i < 60; i++) {
      var t = i * 33.3, a = Math.min(60, 0.2 * t);
      st.update({ ok: true, angle: a, period: 360, conf: 1 }, t);
      if (a > 10 && a < 55) lags.push((a - st.angle) / 0.2);
      if (t > 320) over = Math.max(over, st.angle - 60);
    }
    return { lag: lags.reduce(function (p, q) { return p + q; }, 0) / lags.length, over: over };
  }
  var off = run(false), on = run(true);
  assert.ok(off.lag > 6, 'without lookahead the filter trails: ' + off.lag);
  assert.ok(Math.abs(on.lag) < 3, 'with lookahead: ' + on.lag);
  assert.ok(on.over < 1.5, 'overshoot ' + on.over);
});

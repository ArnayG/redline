/* Regression tests: the bare-hands webcam wheel must come back consistently when the hands leave the frame and return
   (user report: "whenever my hands go out of frame and come back the steering wheel starts at -180").
   Feeds real MediaPipe landmarks (tests/fixtures/hands/landmarks.json), rigidly rotated, through the solver
   (js/input/camwheel-hands.js) and the steer stage (js/input/camwheel.js createSteer), with both hands / one hand
   leaving and re-entering at -120..+120 deg, swapped detection order, swapped / missing handedness labels, hands coming
   back one at a time, after crossed poses; asserts the re-acquired angle and that the game's steering never jumps.
   Run: node tests/run.js camwheel-reacquire */
'use strict';
var path = require('path');
var CH = require(path.join(__dirname, '..', 'js/input/camwheel-hands.js'));
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var FIX = require('./fixtures/hands/landmarks.json');
var W = FIX.video.w, H = FIX.video.h, DT = 33;

function hands(frame) { return frame.hands.map(function (h) { return { lm: h.lm.map(function (p) { return { x: p[0], y: p[1], z: p[2] }; }), score: h.score, label: h.label }; }); }
var LEVEL = (function () {
  var hs = hands(FIX.frames.filter(function (f) { return f.truth === 0; })[0]);
  // [left, right] as the player sees them
  return CH.palm(hs[0].lm, W, H).x <= CH.palm(hs[1].lm, W, H).x ? hs : [hs[1], hs[0]];
})();
var C = (function () { var a = CH.palm(LEVEL[0].lm, W, H), b = CH.palm(LEVEL[1].lm, W, H); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; })();
/** both hands at wheel angle deg (player view, clockwise +), optionally shifted (dx, dy px) */
function pose(deg, o) {
  o = o || {};
  var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  var out = LEVEL.map(function (h, i) {
    var lab = o.labels === 'none' ? '' : o.labels === 'swap' ? LEVEL[1 - i].label : h.label;
    return { score: h.score, label: lab, lm: h.lm.map(function (p) {
      var X = (1 - p.x) * W - C.x, Y = p.y * H - C.y;
      return { x: 1 - (X * c - Y * s + C.x + (o.dx || 0)) / W, y: (X * s + Y * c + C.y + (o.dy || 0)) / H, z: p.z };
    }) };
  });
  if (o.only === 'left') return [out[0]];
  if (o.only === 'right') return [out[1]];
  return o.reverse ? out.reverse() : out;
}
function wrap(a) { return CW.wrapP(a, 360); }

/** a rig: solver + steer stage, frames every DT ms, the game reading the steer every 16 ms in between */
function rig(o) {
  o = o || {};
  var S = CH.createSolver(), st = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0.3 }), t = 0, lastOut = null, maxStep = 0, log = [];
  function readTo(t1) {
    for (var g = (R.gt || 0) + 16; g <= t1; g += 16) {
      var r = st.read(g).steer;
      if (lastOut != null) { var d = Math.abs(r - lastOut); if (d > maxStep) { maxStep = d; R.worstAt = g; } }
      lastOut = r; R.gt = g;
    }
  }
  var R = {
    S: S, st: st,
    frame: function (hs) { t += DT; readTo(t); var m = S.update(hs, W, H, t); st.update(m, t); R.m = m; log.push({ t: t, a: m.ok ? m.angle : null }); return m; },
    run: function (hs, ms) { var m; for (var e = 0; e < ms; e += DT) m = R.frame(typeof hs === 'function' ? hs(e) : hs); return m; },
    gone: function (ms) { return R.run([], ms); },
    calibrate: function () { R.frame(pose(0)); S.calibrate(); st.recentre(); },
    settle: function (hs, ms) { return R.run(hs, ms || 900); },
    maxStep: function () { return maxStep; }, resetStep: function () { maxStep = 0; },
    t: function () { return t; }, log: log
  };
  if (o.cal !== false) R.calibrate();
  return R;
}
// the largest steering step the game may see per 16 ms read: a smooth 120 ms ease (peak slope 1.5x) of a swing of up
// to ~1.4 (held lock decaying to centre, then the new reading), never a snap (a snap of a 180 deg error is 1 .. 2)
var MAX_STEP = 0.3;

test('reacquire: both hands leave and return (short / long gaps, -120..+120 deg, order + labels shuffled)', function () {
  var befores = [0, 45, -90, 120], gaps = [100, 400, 2000], afters = [-120, -90, -60, -30, 0, 30, 60, 90, 120];
  var variants = [{}, { reverse: true }, { labels: 'swap' }, { labels: 'none', reverse: true }, { labels: 'swap', reverse: true, dx: 40, dy: 30 }];
  var n = 0;
  befores.forEach(function (b) { gaps.forEach(function (gap) { afters.forEach(function (a) { variants.forEach(function (v) {
    var R = rig();
    // turn smoothly to b (crossing past 90 on the way to 120 is continuous motion: allowed)
    for (var x = 0; Math.abs(x) <= Math.abs(b); x += b >= 0 ? 4 : -4) { R.frame(pose(x)); if (b === 0) break; }
    R.settle(pose(b), 300);
    assert.ok(Math.abs(R.m.angle - b) < 1.5, 'tracked to ' + b + ': ' + R.m.angle);
    R.resetStep();
    R.gone(gap);
    var m = R.frame(pose(a, v));
    var tag = 'before ' + b + ' gap ' + gap + ' after ' + a + ' ' + JSON.stringify(v) + ': ';
    if (gap > 300) {
      // fresh sight: always within +-90 of straight ahead; the true angle when it is
      assert.ok(Math.abs(m.angle) <= 90.5, tag + 'first sight beyond 90: ' + m.angle);
      if (Math.abs(a) <= 90) assert.ok(Math.abs(wrap(m.angle - a)) < 2 || Math.abs(Math.abs(a) - 90) < 1, tag + 'angle ' + m.angle);
      else assert.ok(Math.abs(wrap(m.angle - (a - 180 * Math.sign(a)))) < 2, tag + 'crossed on first sight reads the level twin: ' + m.angle);
    } else if (Math.abs(wrap(a - b)) <= 60) {
      // within the grace window: continuity (an angle that cannot have turned ~180 in 100 ms)
      assert.ok(Math.abs(wrap(m.angle - a)) < 2, tag + 'continuity ' + m.angle);
    }
    // (a > 60 deg turn within a 100 ms dropout is faster than hands move: only the output bound applies to those)
    if (gap > 300 || Math.abs(wrap(a - b)) <= 60) assert.ok(Math.abs(Math.abs(m.angle) - 180) > 25, tag + 'near 180: ' + m.angle);
    R.settle(pose(a, v), 600);
    assert.ok(R.maxStep() <= MAX_STEP, tag + 'output jump ' + R.maxStep().toFixed(3));
    n++;
  }); }); }); });
  assert.ok(n > 500);
});

test('reacquire: hands come back one at a time (right first, then left) never read ~180 (the reported bug)', function () {
  [true, false].forEach(function (cal) { ['right', 'left'].forEach(function (first) { [0, 30, -45, 75].forEach(function (a) { ['', 'none', 'swap'].forEach(function (lb) {
    var R = rig({ cal: cal });
    if (!cal) R.settle(pose(0), 300);
    R.settle(pose(20), 300);
    R.gone(2000);
    R.resetStep();
    var tag = 'cal ' + cal + ' first ' + first + ' at ' + a + ' labels ' + lb + ': ';
    var m = R.run(pose(a, { only: first, labels: lb || undefined }), 300);
    assert.equal(m.mode, 'one', tag);
    assert.ok(Math.abs(m.angle) < 90, tag + 'one hand fresh ' + m.angle);
    m = R.frame(pose(a, { labels: lb || undefined, reverse: first === 'right' }));
    assert.equal(m.mode, 'two', tag);
    assert.ok(Math.abs(m.angle) < 95, tag + 'second hand joins ' + m.angle);
    m = R.settle(pose(a, { labels: lb || undefined }), 1000);
    assert.ok(Math.abs(m.angle - a) < 1, tag + 'settles on the true angle ' + m.angle);
    assert.ok(R.maxStep() <= MAX_STEP, tag + 'output jump ' + R.maxStep().toFixed(3));
  }); }); }); });
});

test('reacquire: one hand leaves and returns (short and long), two -> one -> two never jumps by ~180', function () {
  ['left', 'right'].forEach(function (side) { [100, 500, 3000].forEach(function (gap) { [-60, 0, 40, 100].forEach(function (a) {
    var R = rig();
    for (var x = 0; Math.abs(x) <= Math.abs(a); x += a >= 0 ? 4 : -4) { R.frame(pose(x)); if (a === 0) break; }
    R.settle(pose(a), 300);
    R.resetStep();
    var tag = side + ' gone ' + gap + ' at ' + a + ': ', before = R.m.angle;
    var m = R.run(pose(a, { only: side === 'left' ? 'right' : 'left' }), gap);
    assert.equal(m.mode, 'one', tag);
    assert.ok(Math.abs(wrap(m.angle - before)) < 3, tag + 'one hand carries on ' + before + ' -> ' + m.angle);
    m = R.frame(pose(a, { reverse: true }));
    assert.ok(Math.abs(wrap(m.angle - a)) < 5, tag + 'back to two hands ' + m.angle);
    m = R.settle(pose(a), 900);
    assert.ok(Math.abs(m.angle - a) < 1, tag + 'settled ' + m.angle);
    assert.ok(R.maxStep() <= MAX_STEP, tag + 'output jump ' + R.maxStep().toFixed(3));
  }); }); });
});

test('reacquire: a single hand alone after a long loss, either hand, is identified by plausibility', function () {
  ['left', 'right'].forEach(function (side) { [-50, 0, 50].forEach(function (a) { [0, 120, -80].forEach(function (dx) {
    var R = rig();
    R.settle(pose(10), 300);
    R.gone(2000);
    // the hand comes back on the "wrong" side of the calibrated centre (dx): its roll still reads near straight ahead
    var m = R.run(pose(a, { only: side, dx: side === 'left' ? dx : -dx }), 400);
    var tag = side + ' alone at ' + a + ' dx ' + dx + ': ';
    assert.equal(m.mode, 'one', tag);
    assert.ok(Math.abs(wrap(m.angle - a)) < 3, tag + m.angle);
  }); }); });
});

test('reacquire: a crossed pose (150 deg) held before the loss does not come back upside down', function () {
  var R = rig();
  for (var x = 0; x <= 150; x += 4) R.frame(pose(x));
  R.settle(pose(150), 300);
  assert.ok(Math.abs(R.m.angle - 150) < 1, 'tracked crossed ' + R.m.angle);
  R.gone(1000);
  R.resetStep();
  var m = R.frame(pose(0, { reverse: true, labels: 'swap' }));
  assert.ok(Math.abs(m.angle) < 2, 'level after the loss ' + m.angle);
  R.settle(pose(0), 600);
  assert.ok(Math.abs(R.st.steer) < 0.03, 'steer centred ' + R.st.steer);
  assert.ok(R.maxStep() <= MAX_STEP, 'output jump ' + R.maxStep().toFixed(3));
});

test('reacquire: safety net: a swapped identity held level reads upside down only briefly, then eases back', function () {
  var R = rig();
  R.gone(1000);
  R.frame(pose(150));                                // first sight while really crossed: the level twin (-30)
  assert.ok(Math.abs(R.m.angle + 30) < 2, 'first sight ' + R.m.angle);
  // the player unturns to level: continuous motion carries the reading to -180
  for (var x = 150; x >= 0; x -= 5) R.frame(pose(x));
  assert.ok(Math.abs(Math.abs(R.m.angle) - 180) < 3, 'swapped reads ~180 ' + R.m.angle);
  R.resetStep();
  var m = R.settle(pose(0), 2600);
  assert.ok(Math.abs(m.angle) < 1.5, 'flipped back to level ' + m.angle);
  // (the steer was at full lock; the correction eases, it does not snap)
  assert.ok(R.maxStep() <= MAX_STEP, 'output jump ' + R.maxStep().toFixed(3));
});

test('reacquire: calibrating while the identity is swapped normalises (no 180 deg calibration)', function () {
  var S = CH.createSolver(), t = 0;
  S.update(pose(0), W, H, t); S.calibrate();
  S.cal.two = 180; S._raw = null;                    // e.g. an old stored calibration
  t += DT; S.update(pose(0), W, H, t); S.calibrate();
  assert.ok(Math.abs(S.cal.two) < 2, 'cal.two ' + S.cal.two);
  t += 2000; S.update([], W, H, t);
  t += DT; var m = S.update(pose(30, { reverse: true }), W, H, t);
  assert.ok(Math.abs(m.angle - 30) < 1, 'after re-acquire ' + m.angle);
});

test('reacquire: steer stage eases in after a loss, relocks the unwrap, seeds across a re-centre, resets', function () {
  var st = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0.3 }), t = 0;
  for (; t <= 1000; t += DT) st.update({ ok: true, angle: 170, period: 360, conf: 1 }, t);
  assert.ok(st.read(t).steer === 1, 'full lock');
  // lost: eases to centre; back fresh at -100: the unwrap does not keep 170's turn (no +260), output eases
  var t1 = t + 600, r0 = st.read(t1).steer;
  assert.ok(Math.abs(r0) < 1e-9, 'centred while lost ' + r0);
  st.update({ ok: true, angle: -100, period: 360, conf: 1, fresh: true }, t1);
  assert.ok(Math.abs(st.read(t1).steer) < 0.05, 'starts from the centred value ' + st.read(t1).steer);
  for (t = t1 + DT; t < t1 + 400; t += DT) st.update({ ok: true, angle: -100, period: 360, conf: 1 }, t);
  assert.ok(st.read(t).steer === -1, 'reaches the new reading ' + st.read(t).steer + ' (unwrapped ' + st.unwrapped + ')');
  // responsive: ~half-way within ~70 ms of the first frame back
  var s2 = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0 }), u = 0;
  s2.update({ ok: true, angle: 0, period: 360, conf: 1 }, u); u += 800;
  s2.update({ ok: true, angle: 45, period: 360, conf: 1, fresh: true }, u);
  assert.ok(s2.read(u + 70).steer > 0.25 && s2.read(u + 130).steer > 0.49, 'ease ' + s2.read(u + 70).steer + ' ' + s2.read(u + 130).steer);
  // seed (re-centre hand-over): starts from the old output
  var s3 = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0 });
  s3.seed(0.4, 36, 5000);
  assert.ok(Math.abs(s3.read(5010).steer - 0.4) < 1e-9, 'seeded');
  s3.update({ ok: true, angle: 0, period: 360, conf: 1 }, 5033);
  assert.ok(Math.abs(s3.read(5033).steer - 0.4) < 0.01 && Math.abs(s3.read(5200).steer) < 1e-9, 'eases to the new centre');
  // reset (camera stopped): the next reading relocks from centre
  s3.reset();
  assert.equal(s3.read(9000).lost, true);
  s3.update({ ok: true, angle: 30, period: 360, conf: 1 }, 9000);
  assert.ok(Math.abs(s3.read(9000).steer) < 0.01 && Math.abs(s3.read(9200).steer - 1 / 3) < 1e-6, 'after reset ' + s3.read(9200).steer);
});

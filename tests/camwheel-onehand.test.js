/* Node tests for the one-hand "top of the wheel" steering style of the bare-hands webcam wheel (camwheel-hands.js
   S.style 'top' / 'auto'): one hand grips the rim at 12 o'clock and steers by moving along the arc around a virtual
   wheel centre below it. Real MediaPipe landmarks (tests/fixtures/hands/landmarks.json), rigidly moved along arcs:
   left vs right hand (geometry), wheel size, depth changes (pull back = brake, not steering), roll vs translation,
   re-acquire after a loss, auto (two hands <-> one), and the 3-2-1 calibration countdown through the camwheel API.
   Run: node tests/run.js camwheel-onehand */
'use strict';
var path = require('path');
var CH = require(path.join(__dirname, '..', 'js/input/camwheel-hands.js'));
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var FIX = require('./fixtures/hands/landmarks.json');
var W = FIX.video.w, H = FIX.video.h, DT = 33;

function hands(frame) { return frame.hands.map(function (h) { return { lm: h.lm.map(function (p) { return { x: p[0], y: p[1], z: p[2] }; }), score: h.score, label: h.label }; }); }
var LEVEL = (function () {
  var hs = hands(FIX.frames.filter(function (f) { return f.truth === 0; })[0]);
  return CH.palm(hs[0].lm, W, H).x <= CH.palm(hs[1].lm, W, H).x ? hs : [hs[1], hs[0]];   // [player-left, player-right]
})();
var PA = CH.palm(LEVEL[0].lm, W, H), PB = CH.palm(LEVEL[1].lm, W, H);
var C = { x: (PA.x + PB.x) / 2, y: (PA.y + PB.y) / 2 + 40 }, RT = Math.hypot(PB.x - PA.x, PB.y - PA.y) / 2;
/** one hand ('left' | 'right') gripping a wheel of centre C, radius RT, turned by deg (its grip at 12 o'clock at 0;
    o.home 'side' = at 9 / 3 o'clock at 0, as with two hands); o.depth: scale about the image centre (< 1 = pulled
    back); o.noRoll: the hand translates along the arc without turning; o.labels 'none' | 'swap'; o.dx, o.dy: shift */
function hand(side, deg, o) {
  o = o || {};
  var i = side === 'left' ? 0 : 1, h = LEVEL[i], home = o.home === 'side' ? 0 : (i ? -90 : 90);
  var src = i ? PB : PA, sa = Math.atan2(src.y - (C.y - 40), src.x - C.x);
  var a = (deg + home) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), f = o.depth || 1;
  // the hand's palm goes to the rim point; it turns with the wheel unless noRoll
  var target = { x: C.x + RT * Math.cos(sa + a), y: C.y + RT * Math.sin(sa + a) };
  var lab = o.labels === 'none' ? '' : o.labels === 'swap' ? LEVEL[1 - i].label : h.label;
  return { score: h.score, label: lab, lm: h.lm.map(function (p) {
    var X = (1 - p.x) * W - src.x, Y = p.y * H - src.y, rx = o.noRoll ? X : X * c - Y * s, ry = o.noRoll ? Y : X * s + Y * c;
    var px = target.x + rx + (o.dx || 0), py = target.y + ry + (o.dy || 0);
    px = W / 2 + (px - W / 2) * f; py = H / 2 + (py - H / 2) * f;
    return { x: 1 - px / W, y: py / H, z: p.z * f };
  }) };
}
function both(deg, o) { return [hand('left', deg, Object.assign({ home: 'side' }, o)), hand('right', deg, Object.assign({ home: 'side' }, o))]; }
function wrap(a) { return CW.wrapP(a, 360); }
/** a solver in top style calibrated with `side` at 12 o'clock; wheel size matched to the true radius unless o.ws */
function topSolver(side, o) {
  o = o || {};
  var S = CH.createSolver({ style: o.style || 'top' }), t = 0, m;
  for (var i = 0; i < 4; i++) { t += DT; m = S.update([hand(side, 0)], W, H, t); }
  S.calibrate();
  S.wheelSize = o.ws != null ? o.ws : RT / (CH.TOP_K * CH.palm(hand(side, 0).lm, W, H).size);
  return { S: S, m: m, step: function (hs) { t += DT; return S.update(hs, W, H, t); }, gone: function (ms) { t += ms; return S.update([], W, H, t); }, t: function () { return t; } };
}

test('one hand: which hand is it (geometry: chirality, whatever the labels and the rotation)', function () {
  [-120, -60, 0, 45, 135].forEach(function (a) {
    ['', 'none', 'swap'].forEach(function (lb) {
      assert.equal(CH.handSide(hand('right', a, { labels: lb || undefined }), W), 'R', 'right hand at ' + a + ' labels ' + lb);
      assert.equal(CH.handSide(hand('left', a, { labels: lb || undefined }), W), 'L', 'left hand at ' + a + ' labels ' + lb);
    });
  });
  var R = topSolver('right'); assert.equal(R.m.side, 'R'); assert.equal(R.S.topCal.side, 'R');
  var L = topSolver('left'); assert.equal(L.m.side, 'L'); assert.equal(L.m.pts[0].id, 'a');
});

test('one hand: the angle follows the hand around the rim (left and right hand, up to +-135 and on, continuous)', function () {
  ['right', 'left'].forEach(function (side) {
    var R = topSolver(side), worst = 0, a, m;
    var path = []; for (a = 0; a <= 135; a += 3) path.push(a); for (a = 135; a >= -170; a -= 3) path.push(a); for (a = -170; a <= 0; a += 3) path.push(a);
    path.forEach(function (deg) { m = R.step([hand(side, deg)]); assert.equal(m.mode, 'top'); worst = Math.max(worst, Math.abs(m.angle - deg)); });
    assert.ok(worst < 1.5, side + ' worst error ' + worst.toFixed(2));
    // the preview rim: centre below the top point, grip point on the rim at the hand
    m = R.step([hand(side, 60)]);
    var g = { x: m.rim.gx, y: m.rim.gy }, p = m.pts[0];
    assert.ok(Math.abs(m.rim.r - RT) < 2 && Math.hypot(g.x - p.x, g.y - p.y) < 6, side + ' rim r ' + m.rim.r.toFixed(1) + ' grip off ' + Math.hypot(g.x - p.x, g.y - p.y).toFixed(1));
  });
});

test('one hand: wheel size, pure translation (no roll), pure roll: sign and size stay sensible', function () {
  [0.6, 1, 1.6].forEach(function (k) {
    var R = topSolver('right'), ws = R.S.wheelSize; R.S.wheelSize = ws * k;
    var prev = -Infinity;
    for (var a = -90; a <= 90; a += 10) {
      var m = R.step([hand('right', a)]);
      assert.ok(m.angle > prev, 'monotonic at size x' + k + ': ' + m.angle);
      prev = m.angle;
      if (Math.abs(a) >= 20) assert.ok(Math.sign(m.angle) === Math.sign(a) && Math.abs(m.angle) > Math.abs(a) * 0.45 && Math.abs(m.angle) < Math.abs(a) * 2.2, 'size x' + k + ' at ' + a + ': ' + m.angle.toFixed(1));
    }
  });
  var T = topSolver('left'), m1 = T.step([hand('left', 40, { noRoll: true })]);
  for (var i = 0; i < 5; i++) m1 = T.step([hand('left', 40, { noRoll: true })]);
  assert.ok(m1.angle > 25 && m1.angle < 45, 'translating only ' + m1.angle.toFixed(1));
});

test('one hand: pulling back / leaning in (depth) does not steer', function () {
  var R = topSolver('right'), m;
  [0, 45, -70].forEach(function (a) {
    [1, 0.85, 0.75, 1.15, 1.3, 1].forEach(function (f) {
      for (var i = 0; i < 8; i++) m = R.step([hand('right', a, { depth: f })]);
      assert.ok(Math.abs(m.angle - a) < 2, 'at ' + a + ' depth ' + f + ': ' + m.angle.toFixed(2));
    });
  });
});

test('one hand: grip-to-drive pedals with the single hand (gas; pulled back = brake)', function () {
  var R = topSolver('right'), P = CH.createPedals(), t = 1000, out;
  P.calibrateNeutral(R.step([hand('right', 0)]));
  for (var i = 0; i < 10; i++) { t += DT; out = P.update(R.step([hand('right', 10)]), t, { pedals: 'grip' }); }
  assert.equal(out.state, 'gas', 'closed hand = gas: ' + JSON.stringify(out));
  for (i = 0; i < 10; i++) { t += DT; out = P.update(R.step([hand('right', 10, { depth: 0.75 })]), t, { pedals: 'grip' }); }
  assert.equal(out.state, 'brake', 'pulled back = brake');
  assert.ok(Math.abs(R.S.angle - 10) < 2, 'and no steering from it: ' + R.S.angle);
});

test('one hand: re-acquire after a loss reads near the top, never jumps, eases in', function () {
  [40, -80, 150, -170].forEach(function (back) {
    var R = topSolver('right'), st = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0.3 }), last = null, maxStep = 0, t;
    function feed(hs) { var m = R.step(hs); st.update(m, R.t()); return m; }
    function reads(t0, t1) { for (var g = t0; g <= t1; g += 16) { var v = st.read(g).steer; if (last != null) maxStep = Math.max(maxStep, Math.abs(v - last)); last = v; } }
    for (var a = 0; a <= 60; a += 4) { t = R.t(); feed([hand('right', a)]); reads(t, R.t()); }
    t = R.t(); R.gone(1500); reads(t, R.t());
    var m = feed([hand('right', back)]);
    assert.equal(m.fresh, true);
    if (Math.abs(back) <= 100) assert.ok(Math.abs(m.angle - back) < 2, 'back at ' + back + ': ' + m.angle);
    else assert.ok(Math.abs(m.angle) < 5, 'implausible first sight ' + back + ' re-anchors near the top: ' + m.angle);
    for (var i = 0; i < 20; i++) { t = R.t(); feed([hand('right', back)]); reads(t, R.t()); }
    assert.ok(maxStep <= 0.3, 'output jump ' + maxStep.toFixed(3) + ' (back at ' + back + ')');
  });
  // a short dropout (within the grace window) keeps tracking without re-anchoring
  var R2 = topSolver('left'); for (var b = 0; b <= 120; b += 4) R2.step([hand('left', b)]);
  R2.gone(150); var m2 = R2.step([hand('left', 124)]);
  assert.ok(Math.abs(m2.angle - 124) < 2, 'short dropout ' + m2.angle);
});

test('one hand: top style with both hands in view steers with the calibrated hand; the centre drifts only when still', function () {
  var R = topSolver('right'), m;
  for (var a = 0; a <= 50; a += 5) m = R.step([hand('left', -a + 20, { dx: -60 }), hand('right', a)]);
  assert.equal(m.side, 'R'); assert.ok(Math.abs(m.angle - 50) < 2, 'right hand steers: ' + m.angle);
  // gone, back with both hands: the calibrated (right) hand is picked by its geometry, not the higher one
  R.gone(2000);
  m = R.step([hand('left', 0, { dy: -40 }), hand('right', 20)]);
  assert.equal(m.side, 'R', 'picked the right hand'); assert.ok(Math.abs(m.angle - 20) < 2, m.angle);
  // the player slowly shifts 30 px right (over ~20 s) while holding straight: the centre follows (a few deg at most)
  var R3 = topSolver('right'), worst = 0;
  for (var i = 0; i < 900; i++) { m = R3.step([hand('right', 0, { dx: Math.min(30, i * 0.05) })]); worst = Math.max(worst, Math.abs(m.angle)); }
  assert.ok(Math.abs(m.angle) < 1, 'followed: ' + m.angle.toFixed(2));
  assert.ok(worst < 4, 'on the way: ' + worst.toFixed(2));
  // but never while turned: held at 30 deg for 10 s, it stays 30
  for (i = 0; i < 300; i++) m = R3.step([hand('right', 30, { dx: 30 })]);
  assert.ok(Math.abs(m.angle - 30) < 2.5, 'no drift during a turn: ' + m.angle.toFixed(2));
});

test('one hand: auto style, two hands -> one hand on the rim -> two hands, no jumps', function () {
  var S = CH.createSolver({ style: 'auto' }), t = 0, m;
  function step(hs) { t += DT; return S.update(hs, W, H, t); }
  for (var i = 0; i < 4; i++) m = step(both(0));
  S.calibrate();
  for (var a = 0; a <= 30; a += 3) m = step(both(a));
  assert.equal(m.mode, 'two'); assert.ok(Math.abs(m.angle - 30) < 1);
  m = step([hand('right', 30, { home: 'side' })]);
  assert.equal(m.mode, 'top'); assert.equal(m.rim.kind, 'rim'); assert.ok(Math.abs(m.angle - 30) < 1.5, 'no jump: ' + m.angle);
  // the right hand moves along the same rim (3 o'clock -> past 12)
  var worst = 0;
  for (a = 30; a >= -100; a -= 4) { m = step([hand('right', a, { home: 'side' })]); worst = Math.max(worst, Math.abs(m.angle - a)); }
  assert.ok(worst < 3, 'one hand on the rim: worst ' + worst.toFixed(2));
  m = step(both(-100));
  assert.equal(m.mode, 'two'); assert.ok(Math.abs(m.angle + 100) < 3, 'back to two: ' + m.angle);
  for (i = 0; i < 30; i++) m = step(both(-100));
  assert.ok(Math.abs(m.angle + 100) < 0.5, 'settled ' + m.angle);
  // never calibrated for the top grip: a lone hand after a loss starts straight ahead
  S.update([], W, H, t += 2000);
  m = step([hand('left', 70)]);
  assert.ok(Math.abs(m.angle) < 2 && m.rim.kind === 'top', 'uncalibrated lone hand: ' + m.angle);
});

test('one hand: prefs and the 3-2-1 calibration countdown through the camwheel API (Left / Right hand)', async function () {
  assert.equal(CW.normPrefs({}).handStyle, 'two');
  assert.equal(CW.normPrefs({ handStyle: 'zzz' }).handStyle, 'two');
  assert.equal(CW.normPrefs({ handStyle: 'top', wheelSize: 9 }).wheelSize, 2);
  assert.equal(CW.normPrefs({ handCal: { top: { x: 0.5, y: 0.3, L: 0.1, q: 0.2, side: 'L', roll0: { a: 1, b: 2 } } } }).handCal.top.side, 'L');
  assert.equal(CW.normPrefs({ handCal: { top: { x: 'a' } } }).handCal, null);
  var saved = { countMs: CW.countMs, gripMs: CW.gripMs };
  CW.setPrefs({ method: 'hands', handStyle: 'top', handCal: null, pedals: 'grip' });
  CW.countMs = 300; CW.gripMs = 200;
  var events = [], off = CW.on('countdown', function (e) { events.push(e); });
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
  try {
    for (var i = 0; i < 5; i++) { CW._feed([hand('left', 0)], W, H, now()); await sleep(10); }
    var e0 = CW.startCentre('calibrate');
    assert.equal(e0.state, 'count');
    var tEnd = now() + 1200;
    while (now() < tEnd && !events.some(function (e) { return e.state === 'done' || e.state === 'fail'; })) { CW._feed([hand('left', 0)], W, H, now()); await sleep(15); }
    var done = events.filter(function (e) { return e.state === 'done' || e.state === 'fail'; })[0];
    assert.ok(done, 'countdown finished: ' + JSON.stringify(events.map(function (e) { return e.state; })));
    var cap = events.filter(function (e) { return e.state === 'captured'; })[0];
    assert.ok(cap && cap.result.ok && cap.result.mode === 'top' && cap.result.side === 'L', 'captured: ' + JSON.stringify(cap && cap.result));
    assert.ok(CW.prefs.handCal && CW.prefs.handCal.top && CW.prefs.handCal.top.side === 'L', 'top calibration saved');
    assert.equal(CW.stats().handSide, 'L');
    // steering after the calibration: the left hand turned 40 deg along the rim
    CW.setPrefs({ wheelSize: Math.min(2, RT / (CH.TOP_K * CH.palm(hand('left', 0).lm, W, H).size)) });
    var m;
    for (i = 0; i < 12; i++) { m = CW._feed([hand('left', 40)], W, H, now()); await sleep(5); }
    assert.equal(m.mode, 'top'); assert.ok(Math.abs(m.angle - 40) < 3, 'steers after calibrating: ' + m.angle);
  } finally {
    off(); CW.cancelCentre(); CW.countMs = saved.countMs; CW.gripMs = saved.gripMs;
    CW.setPrefs({ handStyle: 'two', handCal: null, wheelSize: 1 });
  }
});

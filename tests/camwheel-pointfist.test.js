/* Node tests for the reported webcam air wheel glitch: "every so often the wheel goes really small and glitches out,
   though my hands are always in the frame - when I make a fist pointing at the screen". A fist pointed at the camera
   is seen end-on: its palm length (wrist -> knuckles) foreshortens to ~20 % in the image, the wrist hides behind the
   knuckles (the detector guesses it: jitter), and MediaPipe now and then mis-fits the hand (a collapsed skeleton, a
   score drop, both hand slots on the same hand). Real MediaPipe fist landmarks (tests/camwheel-pose3d.js) pitched
   60-90 deg towards the camera, with wrist jitter and such glitch frames; checks the pose-invariant hand size
   (camhands.trueSize), the wheel's size and the steering (two hands at 9 and 3, and the one-hand top grip), the steer
   stage's output (no jumps), and the "Fist = go" pedals (gas, never brake / lost).
   Run: node tests/run.js camwheel-pointfist */
'use strict';
var path = require('path');
var CH = require(path.join(__dirname, '..', 'js/input/camwheel-hands.js'));
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var P3 = require('./camwheel-pose3d.js');
var W = P3.W, H = P3.H, DT = 33;
// P3's hand 1 is the player's LEFT hand (left in the mirrored view), hand 0 the right one; hand 1's knuckle line lies
// in the image plane, so its pitch is a pure "point the fist at the screen" (hand 0's also swings it in the image)
var NOISE = { jitter: 1.5, wjitter: 0.004, wlGain: 0.6, k1: -0.1 };

function ramp(t0, t1, t) { return Math.max(0, Math.min(1, (t - t0) / (t1 - t0))); }

test('pointfist: the pose-invariant hand size holds when a fist points at the camera (the 2D size collapses)', function () {
  var R = P3.rng(7), worst = 0, worstPt = 0, collapse = 1;
  [0, 1].forEach(function (hi) {
    var s0 = CH.trueSize(P3.hands({ only: hi })[0].lm, W, H).s;
    [-90, -75, -60, -30, 0, 30, 60, 75, 90].forEach(function (pitch) {
      [-60, -30, 0, 30, 60].forEach(function (roll) {
        [-90, 0, 45].forEach(function (turn) {
          var h = P3.hands(Object.assign({ only: hi, pitch: pitch, roll: roll, turn: turn, wristJitter: 4, rng: R }, NOISE))[0];
          var e = Math.abs(Math.log(CH.trueSize(h.lm, W, H).s / s0));
          worst = Math.max(worst, e);
          if (Math.abs(roll) <= 30) worstPt = Math.max(worstPt, e);
          if (hi === 1 && Math.abs(pitch) === 90 && roll === 0) collapse = Math.min(collapse, CH.palm(h.lm, W, H).size / (s0 * 85));
        });
      });
    });
  });
  function pc(v) { return (Math.exp(v) * 100 - 100).toFixed(1) + ' %'; }
  console.log('    trueSize, pitch -90..90 (fist pointed at the camera) x roll -30..30: worst ' + pc(worstPt) + ' off; with rolls to 60 on top: ' + pc(worst) + '; the 2D palm length at 90 deg pitch: ' + (collapse * 100).toFixed(0) + ' %');
  assert.ok(collapse < 0.35, 'the 2D palm length does collapse (the cause): ' + collapse);
  // (wrist jitter, landmark jitter and the lens distortion near the frame edges are all in these)
  assert.ok(Math.exp(worstPt) < 1.2, 'trueSize within 20 % with the fist pointed at the camera: ' + pc(worstPt));
  assert.ok(Math.exp(worst) < 1.3, 'and within 30 % with a 60 deg roll on top of a 90 deg pitch: ' + pc(worst));
});

/** two hands at 9 and 3 steering a slow sine; from 0.6 s the hand(s) in `which` pitch towards the camera (0 -> pitchTo
    over 0.5 s, held), with the wrist jittering; glitch(i, hs) may corrupt detector output frames */
function twoHandRun(o) {
  var S = CH.createSolver(), st = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0.3 }), P = CH.createPedals();
  var R = P3.rng(o.seed || 3), t = 0, res = { radErr: 0, angErr: 0, step: 0, outStep: 0, states: {}, held: 0, modes: {} };
  var r0 = null, prevErr = null, prevOut = null;
  for (var i = 0; i < 25; i++) { t += DT; S.update(P3.hands(Object.assign({ rng: R }, NOISE)), W, H, t); }
  S.calibrate();
  var m = S.update(P3.hands(Object.assign({ rng: R }, NOISE)), W, H, t += DT);
  r0 = Math.hypot(m.pts[1].x - m.pts[0].x, m.pts[1].y - m.pts[0].y) / 2;
  var N = Math.round(3600 / DT);
  for (i = 0; i < N; i++) {
    t += DT;
    var ts = i * DT / 1000, turn = (o.turn == null ? 25 : o.turn) * Math.sin(ts * 2.2), k = ramp(0.6, 1.1, ts) * o.pitchTo;
    var pitch = [o.which === 'left' ? 0 : k, o.which === 'right' ? 0 : k], wj = [pitch[0] ? 3 + 9 * k / 90 : 0, pitch[1] ? 3 + 9 * k / 90 : 0];
    var hs = P3.hands(Object.assign({ turn: turn, pitch: pitch, wristJitter: wj, rng: R }, NOISE));
    if (o.glitch) hs = o.glitch(i, hs, R) || hs;
    m = S.update(hs, W, H, t);
    st.update(m, t);
    var out = st.read(t).steer;
    if (prevOut != null) res.outStep = Math.max(res.outStep, Math.abs(out - prevOut));
    prevOut = out;
    var pd = P.update(m, t, { pedals: 'fist' });
    if (i > 3) res.states[pd.state] = (res.states[pd.state] || 0) + 1;
    if (m.held) { res.held++; res.why = res.why || {}; res.why[m.why] = (res.why[m.why] || 0) + 1; }
    res.modes[m.mode] = (res.modes[m.mode] || 0) + 1;
    // the wheel the preview draws: two hands -> half their distance; one hand -> meas.wheelR
    var r = m.mode === 'two' ? Math.hypot(m.pts[1].x - m.pts[0].x, m.pts[1].y - m.pts[0].y) / 2 : m.wheelR;
    res.radErr = Math.max(res.radErr, Math.abs(r / r0 - 1));
    var err = m.angle - turn;
    // (a held frame lags a turning wheel by up to ~holdMs of its turn rate: counted apart)
    if (m.held) res.heldErr = Math.max(res.heldErr || 0, Math.abs(err)); else res.angErr = Math.max(res.angErr, Math.abs(err));
    if (prevErr != null) res.step = Math.max(res.step, Math.abs(err - prevErr));
    prevErr = err;
  }
  return res;
}
function fmt(r) { return 'radius ' + (r.radErr * 100).toFixed(1) + ' %, angle err ' + r.angErr.toFixed(2) + ' deg, step ' + r.step.toFixed(2) + ' deg, output step ' + r.outStep.toFixed(3) + ', held ' + r.held + ' (their err ' + (r.heldErr || 0).toFixed(2) + ' deg), pedals ' + JSON.stringify(r.states) + ', modes ' + JSON.stringify(r.modes) + ' why ' + JSON.stringify(r.why || {}); }

test('pointfist: two hands, one or both fists pointed at the camera (60-90 deg, wrist jitter): same wheel, same steering, gas', function () {
  [['left', 60], ['left', 90], ['right', 75], ['both', 90], ['both', 60]].forEach(function (c) {
    var r = twoHandRun({ which: c[0], pitchTo: c[1] });
    console.log('    ' + c[0] + ' ' + c[1] + ' deg: ' + fmt(r));
    assert.ok(r.radErr < 0.1, c + ': wheel radius within 10 %: ' + fmt(r));
    assert.ok(r.angErr < 5, c + ': steering error < 5 deg: ' + fmt(r));
    assert.ok(r.step < 2.5, c + ': no jumps: ' + fmt(r));
    assert.ok(!r.states.brake && !r.states.lost && !r.states.coast && r.states.gas > 0, c + ': fist = gas throughout: ' + fmt(r));
  });
});

test('pointfist: detector glitches in that pose (collapsed skeleton, score drop, both slots on one hand, a dropped hand) are held or ridden out', function () {
  // every ~0.4 s one bad frame (or two) of a different kind, on the left fist (pointed at the camera)
  function glitch(i, hs, R) {
    if (i < 40) return hs;
    var kind = Math.floor(i / 12) % 5, on = i % 12 === 0 || (kind === 2 && i % 12 === 1);
    if (!on) return hs;
    var L = hs[1];
    function shrink(h, k, dx, dy, score) {
      var c = { x: 0, y: 0 }; h.lm.forEach(function (p) { c.x += p.x / 21; c.y += p.y / 21; });
      return { lm: h.lm.map(function (p, j) { return { x: c.x + (p.x - c.x) * k + (j === 0 ? dx : 0), y: c.y + (p.y - c.y) * k + (j === 0 ? dy : 0), z: p.z * k }; }), wl: h.wl, score: score, label: h.label };
    }
    if (kind === 0) return [hs[0], shrink(L, 0.45, 0, 0, 0.9)];                    // the skeleton collapses for a frame
    if (kind === 1) return [hs[0], shrink(L, 1, 0.06, 0.05, 0.55)];                // a low score, the wrist thrown off
    if (kind === 2) return [hs[0], shrink(hs[0], 1, 0.004, 0.003, 0.7)];          // both slots on the right hand (2 frames)
    if (kind === 3) return [hs[0]];                                                // the pointed fist dropped for a frame
    return [hs[0], shrink(L, 1, 0.09, -0.08, 0.92)];                              // only the (hidden) wrist way off
  }
  [['left', 90], ['left', 70]].forEach(function (c) {
    var r = twoHandRun({ which: c[0], pitchTo: c[1], glitch: glitch, seed: 9 });
    console.log('    glitches, ' + c[0] + ' ' + c[1] + ' deg: ' + fmt(r));
    assert.ok(r.radErr < 0.1, 'wheel radius within 10 %: ' + fmt(r));
    assert.ok(r.angErr < 5, 'steering error < 5 deg: ' + fmt(r));
    assert.ok(r.step < 4, 'no jumps: ' + fmt(r));
    assert.ok(r.outStep < 0.06, 'the game sees no jumps: ' + fmt(r));
    assert.ok(r.held > 0 && r.heldErr < 8, 'glitch frames held (lagging the turn a little): ' + fmt(r));
    assert.ok(!r.states.brake && !r.states.lost, 'never a brake / lost: ' + fmt(r));
  });
  // and a duplicate detection on its own is one hand, not a tiny two-hand wheel
  var S = CH.createSolver(), hs = P3.hands(NOISE), t = 0;
  for (var i = 0; i < 5; i++) S.update(hs, W, H, t += DT);
  S.calibrate();
  var dup = { lm: hs[0].lm.map(function (p) { return { x: p.x + 0.003, y: p.y - 0.002, z: p.z }; }), wl: hs[0].wl, score: 0.8, label: hs[0].label };
  var m = S.update([hs[0], dup], W, H, t += 200);
  assert.equal(m.mode, 'one', 'duplicate -> one hand');
  assert.ok(m.wheelR > 0.9 * S.cal.span / 2, 'the preview keeps the two-hand wheel size: ' + m.wheelR);
});

test('pointfist: the one-hand top grip keeps its wheel size and angle when the fist points at the camera', function () {
  [1, 0].forEach(function (hi) {
    [60, 90].forEach(function (pitchTo) {
      var S = CH.createSolver({ style: 'top' }), P = CH.createPedals(), R = P3.rng(5 + hi), t = 0, m, worstR = 0, worstA = 0, step = 0, prev = null, states = {};
      var st = CW.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0.3 }), outStep = 0, prevOut = null;
      for (var i = 0; i < 20; i++) m = S.update(P3.hands(Object.assign({ only: hi, rng: R }, NOISE)), W, H, t += DT);
      S.calibrate();
      m = S.update(P3.hands(Object.assign({ only: hi, rng: R }, NOISE)), W, H, t += DT);
      var r0 = m.rim.r;
      for (i = 0; i < 100; i++) {
        var k = ramp(10, 30, i) * pitchTo;
        m = S.update(P3.hands(Object.assign({ only: hi, pitch: k, wristJitter: 3 + 9 * k / 90, rng: R }, NOISE)), W, H, t += DT);
        var pd = P.update(m, t, { pedals: 'fist' });
        if (i > 3) states[pd.state] = (states[pd.state] || 0) + 1;
        st.update(m, t); var so = st.read(t).steer; if (prevOut != null) outStep = Math.max(outStep, Math.abs(so - prevOut)); prevOut = so;
        worstR = Math.max(worstR, Math.abs(m.rim.r / r0 - 1));
        worstA = Math.max(worstA, Math.abs(m.angle));
        if (prev != null) step = Math.max(step, Math.abs(m.angle - prev));
        prev = m.angle;
      }
      var tag = 'hand ' + hi + ' pitch ' + pitchTo + ': rim ' + (worstR * 100).toFixed(1) + ' %, angle ' + worstA.toFixed(2) + ' deg, step ' + step.toFixed(2) + ', output step ' + outStep.toFixed(3) + ' ' + JSON.stringify(states);
      console.log('    top grip ' + tag);
      // (a raw reading: the wrist landmark's jitter in this pose is ~10 px, the steer stage's filter smooths it)
      assert.ok(worstR < 0.1, tag); assert.ok(worstA < 5, tag); assert.ok(step < 4, tag); assert.ok(outStep < 0.04, tag);
      assert.ok(!states.brake && !states.lost && states.gas > 0, tag);
    });
  });
  // a depth glitch (the hand's size halves for one frame) never shrinks the rim by more than a few % per frame
  var S2 = CH.createSolver({ style: 'top' }), t2 = 0, m2, hs = P3.hands({ only: 1 });
  for (var j = 0; j < 10; j++) m2 = S2.update(hs, W, H, t2 += DT);
  S2.calibrate();
  var rA = S2.update(hs, W, H, t2 += DT).rim.r;
  var c = { x: 0, y: 0 }; hs[0].lm.forEach(function (p) { c.x += p.x / 21; c.y += p.y / 21; });
  var small = [{ lm: hs[0].lm.map(function (p) { return { x: c.x + (p.x - c.x) * 0.5, y: c.y + (p.y - c.y) * 0.5, z: p.z }; }), score: 0.9, label: hs[0].label }];
  m2 = S2.update(small, W, H, t2 += DT);
  assert.ok(m2.rim.r > rA * 0.93, 'rim after a size glitch: ' + (m2.rim.r / rA).toFixed(3));
  for (j = 0; j < 30; j++) m2 = S2.update(small, W, H, t2 += DT);
  assert.ok(m2.rim.r >= rA * 0.69, 'never below 0.7 x the calibrated rim: ' + (m2.rim.r / rA).toFixed(3));
});

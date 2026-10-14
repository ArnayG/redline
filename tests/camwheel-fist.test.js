/* Node tests for the default webcam pedals "Fist = go, open hand = brake" (js/input/camwheel-hands.js openness +
   createPedals 'fist' / 'auto'): finger extension invariant to the hand's rotation / roll / tilt / distance / lens /
   jitter (real MediaPipe fist landmarks moved in 3D: tests/camwheel-pose3d.js), the "a closed hand never brakes" rule,
   both hands open for the brake, persistence timing (gas ~60 ms, brake ~130 ms), hysteresis, the reverse rule with the
   engine's standstill logic, lost hands (coast, then a gentle brake), the opt-in pull-back brake's guards, migration.
   Run: node tests/run.js camwheel-fist */
'use strict';
var path = require('path');
var CH = require(path.join(__dirname, '..', 'js/input/camwheel-hands.js'));
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var P3 = require('./camwheel-pose3d.js');
var W = P3.W, H = P3.H;

/** every motion a player makes while steering (closed or open hands alike) */
function motions() {
  var out = [];
  [-180, -90, -45, 0, 30, 90, 135].forEach(function (turn) {
    [-70, -35, 0, 40, 70].forEach(function (roll) {
      [-35, 0, 30].forEach(function (pitch) {
        [0.7, 1, 1.4].forEach(function (dist) { out.push({ turn: turn, roll: roll, pitch: pitch, dist: dist, k1: -0.1, jitter: 1.5, wjitter: 0.004, wlGain: 0.6 }); });
      });
    });
  });
  return out;
}
function opens(pose, R) { return P3.hands(Object.assign({ rng: R }, pose)).map(function (h, i) { return [CH.openness(h.lm, h.wl, W, H).o, CH.openness(h.lm, null, W, H).o]; }); }

test('fist pedals: finger extension is rotation / roll / tilt / distance invariant (real fist landmarks in 3D)', function () {
  var R = P3.rng(11), maxFist = 0, minOpen = 1, half = [];
  motions().forEach(function (m) {
    opens(Object.assign({ grip: 1 }, m), R).forEach(function (o) { maxFist = Math.max(maxFist, o[0], o[1]); });
    opens(Object.assign({ grip: 0 }, m), R).forEach(function (o) { minOpen = Math.min(minOpen, o[0], o[1]); });
    if (m.dist === 1) opens(Object.assign({ grip: 0.5 }, m), R).forEach(function (o) { half.push(o[0]); });
  });
  half.sort(function (a, b) { return a - b; });
  console.log('    openness over ' + motions().length + ' poses: fists max ' + maxFist.toFixed(3) + ', open hands min ' + minOpen.toFixed(3) + ', half ' + half[0].toFixed(2) + '..' + half[half.length - 1].toFixed(2));
  var B = CH.PEDALS;
  assert.ok(maxFist < B.closeOn - 0.1, 'fists read closed in every pose: max ' + maxFist);
  assert.ok(minOpen > B.extOn, 'open hands read open in every pose: min ' + minOpen);
  // half-closed: never open (it may read closed = gas in some poses, which is the safe side); mostly in between
  assert.ok(half[half.length - 1] < B.extOn && half[half.length >> 1] > B.closeOn, 'half-closed = in between: ' + half[0] + '..' + half[half.length - 1]);
  // the old 2D hand size swings with the same motions (why it falsely braked): > 14 % smaller in some poses
  var base = CH.handScale(P3.hands({})[0].lm, null, W, H).s, minR = 9;
  motions().forEach(function (m) { if (m.dist === 1) minR = Math.min(minR, CH.handScale(P3.hands(Object.assign({ grip: 1 }, m))[0].lm, null, W, H).s / base); });
  assert.ok(minR < 0.86, 'the 2D size alone would have braked: ratio ' + minR);
});

/** a rig: solver + pedals fed 3D poses at 30 fps */
function rig(prefs, style) {
  var S = CH.createSolver({ style: style || 'two' }), P = CH.createPedals(), t = 0, R = P3.rng(3);
  var m = S.update(P3.hands({}), W, H, t); S.calibrate(); P.update(m, t, prefs); P.calibrateNeutral(m);
  return {
    S: S, P: P,
    feed: function (pose, n, dtMs) { var o, mm; for (var i = 0; i < (n || 1); i++) { t += dtMs || 33; mm = S.update(P3.hands(Object.assign({ rng: R, jitter: 1.2, wjitter: 0.004 }, pose)), W, H, t); o = P.update(mm, t, prefs); } return { out: o, meas: mm, t: t }; },
    lost: function (ms) { t += ms; S.update([], W, H, t); return P.update({ ok: false }, t, prefs); },
    t: function () { return t; }
  };
}

test('fist pedals: closed hands NEVER brake, whatever the motion (with clipping at the frame edge too)', function () {
  ['two', 'top', 'auto'].forEach(function (style) {
    ['fist', 'auto'].forEach(function (mode) {
      var r = rig({ pedals: mode }, style), brakes = 0, gas = 0, n = 0;
      for (var i = 0; i < 600; i++) {
        var s = i / 30, a = 100 * Math.sin(s * 1.3);
        var o = r.feed({ grip: 1, turn: a, roll: 0.7 * a, pitch: 25 * Math.sin(s * 2.1), dist: 1 + 0.35 * Math.sin(s * 0.7), dx: 160 * Math.sin(s * 0.5), dy: 70 * Math.sin(s * 0.9), k1: -0.12, clip: true, wlGain: 0.6, only: style === 'two' ? null : 1 }).out;
        n++; if (o.brake > 0) brakes++; if (o.throttle > 0) gas++;
      }
      assert.equal(brakes, 0, style + '/' + mode + ': brakes ' + brakes);
      assert.ok(gas >= n * 0.95, style + '/' + mode + ': gas ' + gas + ' / ' + n);
    });
  });
  // one hand closed, the other wide open: grip wins, every frame
  var r2 = rig({ pedals: 'fist' }), bad = 0;
  for (var i = 0; i < 120; i++) { var o2 = r2.feed({ grip: [1, 0], turn: 40 * Math.sin(i / 10) }).out; if (o2.brake > 0) bad++; }
  assert.equal(bad, 0, 'one fist + one open hand never brakes');
  assert.equal(r2.feed({ grip: [0, 1] }, 5).out.state, 'gas');
});

test('fist pedals: both hands open = brake (one hand: never on a two-hand wheel; the top grip: that hand)', function () {
  var r = rig({ pedals: 'fist' });
  assert.equal(r.feed({ grip: 1 }, 5).out.state, 'gas');
  var b = r.feed({ grip: 0, turn: 30, roll: 40 }, 8).out;
  assert.ok(b.state === 'brake' && b.brake >= 0.9 && b.throttle === 0, 'open hands, turned and rolled: ' + JSON.stringify(b));
  // fingers out of the picture (turned 60 deg here, the top hand's fingertips leave the frame): only a guess -> coast
  assert.equal(r.feed({ grip: 0, turn: 60, roll: 40 }, 8).out.brake, 0, 'clipped open hand: no brake');
  assert.equal(r.feed({ grip: 0.5 }, 8).out.state, 'coast', 'half-closed = coast');
  // two-hand style, one hand in view, open: coast (taking a hand off is not a brake)
  var one = rig({ pedals: 'fist' }, 'two'); one.feed({ grip: 1 }, 5);
  assert.equal(one.feed({ grip: 0, only: 0 }, 10).out.state, 'coast');
  assert.equal(one.feed({ grip: 1, only: 0 }, 5).out.state, 'gas', 'that one hand closed = gas');
  // one-hand top grip: the hand alone decides
  var top = rig({ pedals: 'fist' }, 'top');
  assert.equal(top.feed({ grip: 1, only: 1 }, 5).out.state, 'gas');
  assert.equal(top.feed({ grip: 0, only: 1 }, 8).out.state, 'brake');
  // auto-gas: drives with closed or half hands, brakes on open hands
  var au = rig({ pedals: 'auto' });
  assert.equal(au.feed({ grip: 0.5 }, 6).out.throttle, 1);
  assert.equal(au.feed({ grip: 0 }, 8).out.state, 'brake');
});

/** direct measurements: pts with given openness (no solver), for exact timing */
function meas(mode, opens) { return { ok: true, mode: mode, angle: 0, pts: opens.map(function (o, i) { return { id: i ? 'b' : 'a', open: o, x: 300, y: 200, size: 50 }; }), W: 640, H: 360 }; }

test('fist pedals: persistence (gas ~60 ms, brake ~130 ms), grip cuts the brake at once, hysteresis without flicker', function () {
  var P = CH.createPedals(), t = 0, o;
  function at(dt, ops, mode) { t += dt; return P.update(meas(mode || 'two', ops), t, { pedals: 'fist' }); }
  at(0, [0.5, 0.5]);
  var t0 = t; o = at(16, [0.05, 0.05]);
  while (o.state !== 'gas') o = at(16, [0.05, 0.05]);
  assert.ok(t - t0 >= 50 && t - t0 <= 80, 'gas after ' + (t - t0) + ' ms');
  assert.ok(o.throttle === 1, 'clearly closed = full gas ' + o.throttle);
  t0 = t; o = at(16, [1, 1]);
  while (o.state !== 'brake') { assert.equal(o.brake, 0); o = at(16, [1, 1]); }
  assert.ok(t - t0 >= 120 && t - t0 <= 160, 'brake after ' + (t - t0) + ' ms');
  o = at(16, [1, 0.1]);
  assert.ok(o.brake === 0, 'a closed hand appears: no brake in that very frame ' + JSON.stringify(o));
  // a single frame of open hands (a detector glitch) never brakes
  at(16, [0.05, 0.05]); at(16, [0.05, 0.05]); at(16, [0.05, 0.05]); at(16, [0.05, 0.05]); at(16, [0.05, 0.05]);
  for (var k = 0; k < 3; k++) { o = at(33, [1, 1]); assert.equal(o.brake, 0, 'glitch frame ' + k); o = at(33, [0.05, 0.05]); }
  // hysteresis: hovering just inside the open band keeps braking, just inside the closed band keeps the gas
  var R = P3.rng(9), flips = 0, last = null, B = P.bands();
  for (k = 0; k < 10; k++) at(33, [1, 1]);
  for (k = 0; k < 150; k++) { o = at(33, [B.extOff + 0.04 + (R() - 0.5) * 0.06, B.extOff + 0.04 + (R() - 0.5) * 0.06]); if (last !== null && (o.brake > 0) !== last) flips++; last = o.brake > 0; }
  assert.equal(flips, 0, 'brake flicker'); assert.ok(last, 'still braking');
  for (k = 0; k < 10; k++) at(33, [0, 0]);
  last = null;
  for (k = 0; k < 150; k++) { o = at(33, [B.closeOff - 0.04 + (R() - 0.5) * 0.06, 0.45]); if (last !== null && (o.throttle > 0) !== last) flips++; last = o.throttle > 0; }
  assert.equal(flips, 0, 'gas flicker'); assert.ok(last, 'still on gas');
  // a hand partly out of the frame can read closed, never open
  var P2 = CH.createPedals(), m2 = meas('two', [1, 1]); m2.pts[1].cut = 3;
  for (k = 0; k < 10; k++) o = P2.update(m2, 1000 + k * 33, { pedals: 'fist' });
  assert.equal(o.state, 'coast', 'clipped hand: no brake');
});

/** the engine's own standstill rule (js/race/vehicle.js): stopped, brake > 0.3, no throttle for 0.4 s -> reverse;
    in reverse throttle > 0.1 (not rolling back fast) for 0.15 s -> 1st */
function engine() {
  var E = { v: 0, gear: 1, rt: 0 };
  E.step = function (thr, brk, dt) {
    if (E.gear >= 0) { if (Math.abs(E.v) < 0.8 && brk > 0.3 && thr < 0.1) { E.rt += dt; if (E.rt > 0.4) { E.gear = -1; E.rt = 0; } } else E.rt = 0; }
    else if (thr > 0.1 && E.v > -0.8) { E.rt += dt; if (E.rt > 0.15) { E.gear = 1; E.rt = 0; } } else E.rt = 0;
    var drive = E.gear < 0 ? -brk : thr, stop = E.gear < 0 ? thr : brk;
    E.v += (drive * 4 - Math.sign(E.v) * Math.min(Math.abs(E.v) / dt, stop * 9)) * dt;
  };
  return E;
}
test('fist pedals: open hands at a stop reverse after ~0.8 s ("R"); closing them drives forward; never while moving', function () {
  var P = CH.createPedals(), E = engine(), t = 0, o, dt = 1 / 60, cam = 0, ops = [0, 0], stopT = null, revT = null, movingRev = false;
  function frame() {
    t += dt * 1000; cam += dt;
    if (cam >= 1 / 30) { cam = 0; P.update(meas('two', ops), t, { pedals: 'fist' }); }
    o = P.read(t, 'fist', { driving: true, speed: Math.abs(E.v), gear: E.gear });
    E.step(o.throttle, o.brake, dt);
    if (E.gear < 0 && revT == null) { revT = t; if (Math.abs(E.v) >= 0.8) movingRev = true; }
  }
  ops = [0, 0]; for (var i = 0; i < 240; i++) frame();          // 4 s of gas
  assert.ok(E.v > 10 && E.gear === 1, 'driving ' + E.v);
  ops = [1, 1];
  var maxBrakeMoving = 0;
  for (i = 0; i < 600 && E.gear > 0; i++) { frame(); if (Math.abs(E.v) >= 0.8) maxBrakeMoving = Math.max(maxBrakeMoving, o.brake); else if (stopT == null) stopT = t; }
  assert.ok(maxBrakeMoving >= 0.95, 'full brake while moving ' + maxBrakeMoving);
  assert.ok(!movingRev, 'never reverses while moving');
  assert.ok(revT != null && revT - stopT >= 650 && revT - stopT <= 1000, 'reverse ' + (revT - stopT) + ' ms after the stop');
  for (i = 0; i < 60; i++) frame();
  assert.ok(o.reverse && o.state === 'reverse' && E.v < -0.5, 'backing up: ' + JSON.stringify(o) + ' v ' + E.v);
  ops = [0, 0];
  for (i = 0; i < 180; i++) frame();
  assert.ok(E.gear === 1 && E.v > 0.5 && !o.reverse, 'fists: forward again, v ' + E.v);
  // braking hard to a stop and closing the hands before 0.8 s: no reverse
  var P2 = CH.createPedals(), E2 = engine(); E2.v = 5; t = 0;
  for (i = 0; i < 120; i++) { t += 16.7; if (i % 2 === 0) P2.update(meas('two', i < 75 ? [1, 1] : [0, 0]), t, { pedals: 'fist' }); var o3 = P2.read(t, 'fist', { driving: true, speed: Math.abs(E2.v), gear: E2.gear }); E2.step(o3.throttle, o3.brake, 1 / 60); }
  assert.equal(E2.gear, 1, 'short stop: no reverse');
  // without a car status (menus, Node): plain brake, no shaping
  var P4 = CH.createPedals(); for (i = 0; i < 10; i++) P4.update(meas('two', [1, 1]), i * 33, { pedals: 'fist' });
  assert.equal(P4.read(330, 'fist', null).brake, 1);
});

test('fist pedals: lost hands -> held 150 ms, then coast (no brake) until 0.5 s, then a gentle brake; never stuck on gas', function () {
  var P = CH.createPedals(), t = 0;
  for (var i = 0; i < 10; i++) P.update(meas('two', [0, 0]), t += 33, { pedals: 'fist' });
  assert.equal(P.read(t + 100, 'fist').throttle, 1, 'one dropped frame changes nothing');
  var a = P.read(t + 300, 'fist'); assert.ok(a.throttle === 0 && a.brake === 0 && a.state === 'lost', 'coast ' + JSON.stringify(a));
  var b = P.read(t + 700, 'fist'); assert.ok(b.throttle === 0 && b.brake > 0 && b.brake <= 0.3, 'gentle brake ' + JSON.stringify(b));
  // the gentle lost brake at a stop is below the engine's reverse rule (> 0.3)
  var c = P.read(t + 5000, 'fist', { driving: true, speed: 0, gear: 1 }); assert.ok(c.brake <= 0.3 && !c.reverse);
  // back: closed hands must be seen again (no stale gas)
  P.update(meas('two', [0, 0]), t + 5000, { pedals: 'fist' });
  assert.equal(P.read(t + 5001, 'fist').throttle, 0);
});

test('fist pedals: the opt-in pull-back brake (off by default) is ignored while turned or rolled', function () {
  var off = rig({ pedals: 'fist' });
  assert.equal(off.feed({ grip: 1, dist: 1.35 }, 10).out.brake, 0, 'default: pulling back does nothing');
  var r = rig({ pedals: 'fist', pullBrake: true });
  assert.equal(r.feed({ grip: 1 }, 5).out.state, 'gas');
  assert.ok(r.feed({ grip: 1, dist: 1.35 }, 10).out.brake > 0.3, 'opt-in: closed hands pulled back = brake');
  assert.equal(r.feed({ grip: 1 }, 10).out.state, 'gas');
  assert.equal(r.feed({ grip: 1, dist: 1.35, turn: 45 }, 10).out.brake, 0, 'turned 45: ignored');
  assert.equal(r.feed({ grip: 1, roll: 50 }, 10).out.brake, 0, 'rolled: ignored');
  assert.equal(r.feed({ grip: 1, roll: 60, turn: 20, k1: -0.12 }, 10).out.brake, 0, 'rolled + lens: ignored');
});

test('fist pedals: the Start flow\'s fist / open tests nudge the bands (bounded); prefs migrate once to the new default', function () {
  var P = CH.createPedals();
  assert.equal(P.calibrateFist(meas('two', [0.9, 0.9])).ok, false, 'open hands are not a fist');
  assert.ok(P.calibrateFist(meas('two', [0.1, 0.15])).ok);
  assert.equal(P.calibrateOpen(meas('two', [0.5, 0.6])).ok, false, 'half-open is not open');
  assert.ok(P.calibrateOpen(meas('two', [0.95, 0.97])).ok);
  var B = P.bands();
  assert.ok(B.closeOn >= 0.25 && B.closeOn <= 0.42 && B.extOn >= 0.75 && B.extOn <= 0.9 && B.extOn - B.closeOn >= 0.3, JSON.stringify(B));
  var P2 = CH.createPedals(); P2.setCal({ fist: P.cal.fist, ext: P.cal.ext }); assert.deepEqual(P2.bands(), B, 'saved and restored');
  // migration: the old default (grip + pull back) -> fist once; a later explicit choice sticks
  var store = {}, ls = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); } };
  store[CW.PREF_KEY] = JSON.stringify({ method: 'hands', pedals: 'grip', handStyle: 'two' });
  var p = CW.normPrefs(JSON.parse(ls.getItem(CW.PREF_KEY)));
  assert.equal(p.pedals, 'fist'); assert.equal(p.pedalsV, 2); assert.equal(p.easyAssist, true); assert.equal(p.pullBrake, false);
  ls.setItem(CW.PREF_KEY, JSON.stringify(Object.assign({}, p, { pedals: 'grip' })));
  assert.equal(CW.normPrefs(JSON.parse(ls.getItem(CW.PREF_KEY))).pedals, 'grip', 'chosen after the migration: kept');
  assert.equal(CW.normPrefs({ pedals: 'auto' }).pedals, 'auto', 'other old modes kept');
  assert.equal(CW.normPrefs({ pedals: 'off' }).pedals, 'off');
});

/* Node tests for the webcam air wheel tracking core (js/input/camwheel.js), on synthetic frames (tests/camwheel-synth.js):
   colour maths, segmentation + moments, calibration (colour picking, warnings), angle accuracy under noise / lighting /
   distractors / motion blur / occlusion, unwrap through +-180, lost-tracking policy, jitter and filter lag.
   Run: node tests/run.js camwheel        (the browser test with Chrome's fake camera: tests/camwheel-e2e.test.js) */
'use strict';
var path = require('path');
var CW = require(path.join(__dirname, '..', 'js/input/camwheel.js'));
var SY = require('./camwheel-synth.js');

var W = 160, H = 120;
function pairBase(o) { return Object.assign({ style: 'pair', radius: 0.2, size: 0.045, color: [40, 200, 70], ss: 2 }, o || {}); }
function barBase(o) { return Object.assign({ style: 'bar', radius: 0.25, size: 0.03, color: [40, 90, 230], ss: 2 }, o || {}); }
function q(a, p) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }

/** calibrate on a level frame, then track a scripted turn; errors are of the UNFILTERED unwrapped angle vs the truth */
function session(base, opts) {
  opts = opts || {};
  var n = opts.frames || 90, fps = opts.fps || 30, truth = opts.truth || SY.truthAngle;
  var per = opts.per || function () { return {}; };
  var f0 = SY.render(Object.assign({}, base, per(0), { angle: 0 }));
  var cal = CW.calibrate(f0, W, H, CW.defaultBoxes(base.style), { style: base.style });
  assert.ok(cal.ok, 'calibration: ' + cal.reason);
  var T = CW.createTracker(cal, { w: W, h: H }), st = CW.createSteer(Object.assign({ maxAngle: 90, smoothing: 0.3 }, opts.prefs || {}));
  st.centre = cal.expect.angle;
  var errs = [], lost = 0, ms = 0, partial = 0;
  for (var i = 0; i < n; i++) {
    var t = (opts.t0 || 0) + i * 1000 / fps, a = truth(t / 1000, i);
    var f = SY.render(Object.assign({}, base, per(i), { angle: a, seed: i + 11 }));
    var t0 = process.hrtime.bigint();
    var m = T.process(f, t); st.update(m, t);
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    if (!m.ok) { lost++; continue; }
    if (m.partial) partial++;
    var e = st.unwrapped - st.centre - a;
    if (opts.mod) e = CW.wrapP(e, opts.mod);
    errs.push(Math.abs(e));
  }
  return { cal: cal, med: q(errs, 0.5), p95: q(errs, 0.95), max: q(errs, 1), lost: lost, partial: partial, ms: ms / n, steer: st, tracker: T };
}
// the scripted turn sampled sparsely (fewer frames keeps the suite fast): +-120 deg sweeps, quick corrections, a hard left
function sweep(tSec, i) { return SY.truthAngle(1.5 + i * 0.1); }

test('camwheel: rgbToHsv / hueDist / lookup table classes', function () {
  var h = CW.rgbToHsv(255, 0, 0); assert.equal(h[0], 0); assert.equal(h[1], 1); assert.equal(h[2], 1);
  h = CW.rgbToHsv(0, 255, 0); assert.equal(h[0], 120);
  h = CW.rgbToHsv(0, 0, 128); assert.equal(h[0], 240); assert.ok(Math.abs(h[2] - 128 / 255) < 1e-9);
  assert.equal(CW.rgbToHsv(90, 90, 90)[1], 0);
  assert.equal(CW.hueDist(350, 10), 20); assert.equal(CW.hueDist(10, 350), 20); assert.equal(CW.hueDist(0, 180), 180);
  var lut = CW.buildLut([{ h: 120, hTol: 15, sMin: 0.4, vMin: 0.2 }, { h: 240, hTol: 15, sMin: 0.4, vMin: 0.2 }]);
  function cls(r, g, b) { return lut[((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)]; }
  assert.equal(cls(30, 200, 40), 1); assert.equal(cls(30, 40, 200), 2); assert.equal(cls(200, 40, 40), 0);
  assert.equal(cls(120, 130, 120), 0, 'grey is not green');
  assert.equal(cls(5, 20, 5), 0, 'too dark');
  assert.ok(CW.skinLike(22, 0.4) && !CW.skinLike(120, 0.8) && !CW.skinLike(22, 0.9));
});

test('camwheel: segmentation finds blobs with sub-pixel centroids, merges fragments, principal axis', function () {
  var w = 80, h = 60, img = new Uint8ClampedArray(w * h * 4).fill(128);
  function disc(cx, cy, r, c) { for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var dx = x + 0.5 - cx, dy = y + 0.5 - cy; if (dx * dx + dy * dy <= r * r) { var i = (y * w + x) * 4; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; } } }
  disc(20.5, 30, 6, [20, 220, 40]); disc(60, 25.5, 6, [20, 220, 40]); disc(40, 50, 1, [20, 220, 40]);
  var lut = CW.buildLut([{ h: 125, hTol: 15, sMin: 0.4, vMin: 0.2 }]);
  var cl = CW.segment(img, w, h, lut, null, { minN: 6 });
  assert.equal(cl.length, 2, 'speck dropped');
  cl.sort(function (a, b) { return a.x - b.x; });
  assert.ok(Math.abs(cl[0].x - 20.5) < 0.15 && Math.abs(cl[0].y - 30) < 0.15, cl[0].x + ',' + cl[0].y);
  assert.ok(Math.abs(cl[1].x - 60) < 0.15 && Math.abs(cl[1].y - 25.5) < 0.15);
  // a marker split by a 2 px shadow line merges back into one cluster
  var img2 = new Uint8ClampedArray(w * h * 4).fill(128);
  img = img2; disc(40, 30, 8, [20, 220, 40]);
  for (var y = 0; y < h; y++) for (var x = 39; x < 41; x++) { var i = (y * w + x) * 4; img[i] = img[i + 1] = img[i + 2] = 30; }
  cl = CW.segment(img, w, h, lut, null, { minN: 6 });
  assert.equal(cl.length, 1); assert.ok(Math.abs(cl[0].x - 40) < 0.3);
  assert.equal(CW.segment(img, w, h, lut, null, { minN: 6, gap: 0 }).length, 2, 'without merging: two halves');
  // a rotated bar: the principal axis is its angle (y down => clockwise +)
  [-60, -20, 0, 35, 80].forEach(function (deg) {
    var f = SY.render({ w: 160, h: 120, style: 'bar', angle: deg, radius: 0.25, size: 0.03, color: [40, 90, 230], skin: false, clutter: 0, noise: 0 });
    var c = CW.segment(f, 160, 120, CW.buildLut([{ h: 224, hTol: 15, sMin: 0.4, vMin: 0.2 }]), null, { minN: 6 })[0];
    var ax = CW.axisAngle(c);
    assert.ok(Math.abs(CW.wrapP(ax.angle - deg, 180)) < 0.5, deg + ' -> ' + ax.angle);
    assert.ok(ax.elong > 3);
  });
});

test('camwheel: calibration picks the marker colour(s) and the tracking style', function () {
  var c = CW.calibrate(SY.render(pairBase()), W, H, CW.defaultBoxes('pair'));
  assert.ok(c.ok); assert.equal(c.style, 'pair'); assert.equal(c.mode, 'same'); assert.equal(c.models.length, 1);
  assert.ok(CW.hueDist(c.models[0].h, 128) < 6, 'green hue ' + c.models[0].h);
  assert.ok(Math.abs(c.expect.sep - 0.4 * W) < 1.5, 'spacing ' + c.expect.sep);
  assert.ok(Math.abs(c.expect.angle) < 1);
  assert.deepEqual(c.warnings, []);
  var two = CW.calibrate(SY.render(pairBase({ color: [235, 40, 60], color2: [40, 90, 230] })), W, H, CW.defaultBoxes('pair'));
  assert.ok(two.ok); assert.equal(two.mode, 'two'); assert.equal(two.models.length, 2);
  assert.ok(CW.hueDist(two.models[0].h, 354) < 8 && CW.hueDist(two.models[1].h, 225) < 8, two.models[0].h + ' / ' + two.models[1].h);
  assert.ok(two.models[0].hTol + two.models[1].hTol < CW.hueDist(two.models[0].h, two.models[1].h), 'colour classes do not overlap');
  var bar = CW.calibrate(SY.render(barBase()), W, H, CW.defaultBoxes('bar'));
  assert.ok(bar.ok); assert.equal(bar.style, 'bar'); assert.equal(bar.mode, 'one'); assert.ok(bar.expect.len > 50);
  // nothing colourful in the boxes
  var none = CW.calibrate(SY.render(pairBase({ color: [128, 128, 128] })), W, H, CW.defaultBoxes('pair'));
  assert.equal(none.ok, false); assert.ok(/nothing|dull|skin/.test(none.reason), none.reason);
  // warnings: skin-like colour, same colour elsewhere in view
  var skin = CW.calibrate(SY.render(pairBase({ color: [230, 150, 95] })), W, H, CW.defaultBoxes('pair'));
  assert.equal(CW.calibrate(SY.render(pairBase({ color: [214, 160, 128] })), W, H, CW.defaultBoxes('pair')).reason, 'skin', 'bare hands are refused');
  assert.ok(skin.ok && skin.warnings.indexOf('skin') >= 0, JSON.stringify(skin.warnings));
  var clut = CW.calibrate(SY.render(pairBase({ distractor: { x: 0.88, y: 0.12, r: 0.05 } })), W, H, CW.defaultBoxes('pair'));
  assert.ok(clut.ok && clut.warnings.indexOf('clutter') >= 0);
  // red markers next to skin: the saturation floor stays above skin tones
  var red = CW.calibrate(SY.render(pairBase({ color: [230, 40, 60] })), W, H, CW.defaultBoxes('pair'));
  assert.ok(red.ok && red.models[0].sMin >= 0.45, 'sMin ' + red.models[0].sMin);
});

test('camwheel: angle accuracy on clean frames (two markers, two colours, bar) and per-frame cost', function () {
  var r = session(pairBase(), { truth: sweep });
  assert.equal(r.lost, 0);
  assert.ok(r.med < 0.3 && r.p95 < 1, 'same colour med ' + r.med + ' p95 ' + r.p95);
  assert.ok(r.ms < 3, 'Node ms/frame ' + r.ms);
  var r2 = session(pairBase({ color: [235, 40, 60], color2: [40, 90, 230] }), { truth: sweep });
  assert.ok(r2.lost === 0 && r2.med < 0.3 && r2.p95 < 1, 'two colours med ' + r2.med);
  var r3 = session(barBase(), { truth: sweep });
  assert.ok(r3.lost === 0 && r3.med < 0.5 && r3.p95 < 2, 'bar med ' + r3.med + ' p95 ' + r3.p95);
});

test('camwheel: robust to noise, lighting changes, gradients, distractors and motion blur', function () {
  var cases = [
    ['noise 12', pairBase({ noise: 12 }), {}],
    ['lighting ramp 1.2 -> 0.55', pairBase(), { per: function (i) { return { gain: 1.2 - 0.65 * Math.min(1, i / 80) }; } }],
    ['flicker', pairBase(), { per: function (i) { return { gain: 1 + 0.25 * Math.sin(i / 2) }; } }],
    ['side light gradient', pairBase({ grad: 0.6 }), {}],
    ['dim room', pairBase({ gain: 0.5, noise: 5 }), {}],
    ['same-colour distractor', pairBase({ distractor: { x: 0.12, y: 0.88, r: 0.06 } }), {}],
    ['motion blur 20 deg', pairBase({ blur: 20 }), { calBlur: true }],
    ['bar, noise', barBase({ noise: 10 }), {}],
    ['bar, dimming', barBase(), { per: function (i) { return { gain: 1.2 - 0.6 * Math.min(1, i / 80) }; } }],
    ['moving closer', pairBase(), { per: function (i) { var k = Math.min(1, i / 70); return { radius: 0.2 + 0.07 * k, size: 0.045 + 0.02 * k }; } }]
  ];
  cases.forEach(function (c) {
    var r = session(c[1], Object.assign({ truth: sweep, frames: 60 }, c[2]));
    assert.ok(r.lost <= 1, c[0] + ': lost ' + r.lost);
    assert.ok(r.med < 1.5 && r.p95 < 4, c[0] + ': med ' + r.med.toFixed(2) + ' p95 ' + r.p95.toFixed(2));
  });
});

test('camwheel: one marker hidden -> keeps steering around the wheel centre; partly covered marker', function () {
  var r = session(pairBase(), { truth: function (t, i) { return 40 * Math.sin(i / 8); }, frames: 90, per: function (i) { return i >= 30 && i < 60 ? { occlude: 1 } : {}; } });
  assert.equal(r.lost, 0); assert.ok(r.partial >= 25, 'partial frames ' + r.partial);
  assert.ok(r.p95 < 4, 'p95 ' + r.p95);
  var r2 = session(pairBase({ occlude: 0.45 }), { truth: sweep, frames: 60 });
  assert.ok(r2.lost === 0 && r2.med < 3, 'half covered med ' + r2.med);
});

test('camwheel: unwraps continuously through +-180 deg (two colours: full turns; same colour: by continuity)', function () {
  var spin = function (t, i) { return i * 4; };            // 0 .. 236 deg
  var p = { maxAngle: 180 };
  var r = session(pairBase({ color: [235, 40, 60], color2: [40, 90, 230] }), { truth: spin, frames: 60, prefs: p });
  assert.ok(r.lost === 0 && r.max < 1.5, 'two colours max err ' + r.max);
  assert.ok(r.steer.unwrapped - r.steer.centre > 230, 'unwrapped ' + r.steer.unwrapped);
  var r2 = session(pairBase(), { truth: spin, frames: 60, prefs: p });
  assert.ok(r2.lost === 0 && r2.max < 1.5, 'same colour max err ' + r2.max);
  var r3 = session(barBase(), { truth: function (t, i) { return -i * 4; }, frames: 60, prefs: p });
  assert.ok(r3.lost === 0 && r3.max < 2, 'bar max err ' + r3.max);
  // steer saturates at full lock
  assert.equal(r.steer.steer, 1);
});

test('camwheel: lost tracking holds briefly, then eases back to centre; re-acquires when the markers return', function () {
  var base = pairBase();
  var cal = CW.calibrate(SY.render(base), W, H, CW.defaultBoxes('pair'));
  var T = CW.createTracker(cal, { w: W, h: H }), st = CW.createSteer({ maxAngle: 90, smoothing: 0 });
  var t = 0, i;
  for (i = 0; i < 20; i++, t += 33) st.update(T.process(SY.render(Object.assign({}, base, { angle: 45, seed: i })), t), t);
  assert.ok(Math.abs(st.steer - 0.48) < 0.03, 'steer ' + st.steer);
  var gone = SY.render(Object.assign({}, base, { color: [128, 128, 128] }));
  var last = t - 33;
  for (i = 0; i < 30; i++, t += 33) { var m = T.process(gone, t); assert.equal(m.ok, false); st.update(m, t); }
  assert.ok(Math.abs(st.read(last + 200).steer - 0.48) < 0.03, 'held for 250 ms');
  var mid = st.read(last + 375).steer; assert.ok(mid > 0.1 && mid < 0.4, 'easing ' + mid);
  assert.equal(st.read(last + 520).steer, 0); assert.ok(st.read(last + 520).lost);
  // back after ~1 s: the tracker acquires afresh and the angle is right again
  for (i = 0; i < 6; i++, t += 33) st.update(T.process(SY.render(Object.assign({}, base, { angle: -30, seed: 50 + i })), t), t);
  assert.ok(Math.abs(st.angle + 30) < 1.5, 'reacquired ' + st.angle);
  // a same-colour distractor appearing while tracking is ignored (gated by position / size / spacing)
  for (i = 0; i < 20; i++, t += 33) st.update(T.process(SY.render(Object.assign({}, base, { angle: -30, seed: 70 + i, distractor: { x: 0.5, y: 0.15, r: 0.045 } })), t), t);
  assert.ok(Math.abs(st.angle + 30) < 1.5, 'with distractor ' + st.angle);
});

test('camwheel: jitter when held still and filter lag when turning', function () {
  var base = pairBase({ noise: 10 });
  var cal = CW.calibrate(SY.render(base), W, H, CW.defaultBoxes('pair'));
  var T = CW.createTracker(cal, { w: W, h: H }), st = CW.createSteer({ maxAngle: 90, smoothing: 0.3, deadzone: 0 });
  st.centre = 0;
  var vals = [];
  for (var i = 0; i < 60; i++) { var t = i * 33.3; st.update(T.process(SY.render(Object.assign({}, base, { angle: 10, seed: i + 3 })), t), t); if (i >= 15) vals.push(st.angle); }
  var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / vals.length);
  assert.ok(Math.abs(mean - 10) < 0.3 && sd < 0.2, 'mean ' + mean + ' sd ' + sd);
  // a 200 deg/s turn: the 1-euro filter trails the raw angle by only a few ms
  var st2 = CW.createSteer({ maxAngle: 90, smoothing: 0.3, deadzone: 0 }), lags = [];
  for (i = 0; i < 40; i++) { var tt = i * 16.7, a = Math.min(90, 0.2 * tt); st2.update({ ok: true, angle: a, period: 180, conf: 1 }, tt); if (a > 15 && a < 85) lags.push((a - st2.angle) / 0.2); }
  var lag = lags.reduce(function (a, b) { return a + b; }, 0) / lags.length;
  assert.ok(lag < 20, 'lag ms ' + lag);
});

test('camwheel: steer mapping (dead zone, full lock, recentre) and prefs', function () {
  assert.equal(CW.mapAngle(1.5, { deadzone: 2, maxAngle: 90 }), 0);
  assert.ok(Math.abs(CW.mapAngle(46, { deadzone: 2, maxAngle: 90 }) - 0.5) < 1e-9);
  assert.equal(CW.mapAngle(-200, { deadzone: 2, maxAngle: 90 }), -1);
  var st = CW.createSteer({ maxAngle: 45, smoothing: 0, deadzone: 0 });
  st.update({ ok: true, angle: 20, period: 180, conf: 1 }, 0);
  assert.ok(Math.abs(st.steer - 20 / 45) < 1e-6);
  st.recentre(); st.update({ ok: true, angle: 20, period: 180, conf: 1 }, 33);
  assert.equal(st.steer, 0);
  st.update({ ok: true, angle: 29, period: 180, conf: 1 }, 66);
  assert.ok(Math.abs(st.angle - 9) < 1e-6);
  var p = CW.normPrefs({ maxAngle: 500, deadzone: -3, smoothing: 2, style: 'zzz', pip: false, cal: { ok: false } });
  assert.deepEqual([p.maxAngle, p.deadzone, p.smoothing, p.style, p.pip, p.cal], [180, 0, 1, 'pair', false, null]);
  assert.equal(CW.normPrefs({}).maxAngle, 90);
  assert.ok(CW.cutoffFor(0) > CW.cutoffFor(0.3) && CW.cutoffFor(0.3) > CW.cutoffFor(1));
  // no camera in Node: start() reports it instead of throwing
  return CW.start().then(function (r) { assert.equal(r.ok, false); });
});

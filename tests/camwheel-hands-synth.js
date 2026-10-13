/* Synthetic webcam video of two REAL hands (cut-outs of freely licensed photos: tests/fixtures/hands/README.md) gripping
   an imaginary steering wheel, for the bare-hands webcam wheel browser test (tests/camwheel-e2e.test.js).
   frame(o) -> RGBA (w x h, the PLAYER'S mirrored view unless o.camera): a cluttered room, a face, and both hands rotated
   by the wheel angle around a hub (left hand = the sprite mirrored; o.hide 'left' | 'right' | 'both' leaves it out), with lighting gain, noise and optional motion blur.
   writeY4m(file, o) -> {frames, truth[], fps} writes a 4:2:0 .y4m for Chrome's --use-file-for-fake-video-capture; the
   frame number is stamped as a barcode (camwheel-synth.stamp) so the page can match each frame to its true angle. */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var SY = require('./camwheel-synth.js');

var cache = {};
function sprite(name) {
  if (cache[name]) return cache[name];
  var b = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'hands', name + '.rgba.gz')));
  var nl = b.indexOf(10), hd = JSON.parse(b.slice(0, nl).toString());
  return (cache[name] = { w: hd.w, h: hd.h, px: b.slice(nl + 1) });
}
/** bilinear RGBA sample of a sprite (premultiplied) */
function sample(S, u, v, out) {
  if (u < 0 || v < 0 || u > S.w - 1 || v > S.h - 1) { out[3] = 0; return; }
  var x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, x1 = Math.min(S.w - 1, x0 + 1), y1 = Math.min(S.h - 1, y0 + 1), px = S.px;
  var r = 0, g = 0, b = 0, a = 0;
  [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]].forEach(function (c) {
    var i = (c[1] * S.w + c[0]) * 4, al = px[i + 3] / 255 * c[2];
    r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
  });
  out[0] = r; out[1] = g; out[2] = b; out[3] = a;
}

function frame(o) {
  o = Object.assign({ w: 640, h: 480, angle: 0, cx: 0.5, cy: 0.58, radius: 0.24, scale: 0.42, gain: 1, noise: 3, seed: 1, blur: 0, sprite: 'open-fist', clutter: 10, hide: null }, o || {});
  var W = o.w, H = o.h, S = sprite(o.sprite), out = new Uint8ClampedArray(W * H * 4), R = SY.rng(o.seed);
  var bg = SY.background(W, H, o.bgSeed || 3, o.clutter);
  var hs = o.scale * H / S.h;                                 // sprite px -> frame px
  var ax = S.w * 0.5, ay = S.h * 0.3;                         // anchor: the middle of the palm (on the sprite's axis)
  var steps = o.blur ? Math.max(3, Math.ceil(o.blur / 1.5)) : 1, tmp = [0, 0, 0, 0];
  var hands = [];
  for (var st = 0; st < steps; st++) {
    var a = (o.angle + (steps > 1 ? (st / (steps - 1) - 0.5) * o.blur : 0)) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    [-1, 1].forEach(function (side) {
      if (o.hide === 'both' || o.hide === (side < 0 ? 'left' : 'right')) return;
      hands.push({ side: side, cx: o.cx * W + side * o.radius * W * c, cy: o.cy * H + side * o.radius * W * s, c: c, s: s, wgt: 1 / steps });
    });
  }
  var ext = Math.hypot(S.w, S.h) * hs;
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var p = (y * W + x) * 3, col = [bg[p], bg[p + 1], bg[p + 2]];
    var fdx = (x - o.cx * W) / (0.11 * W), fdy = (y - (o.cy - 0.36) * H) / (0.19 * H);
    if (fdx * fdx + fdy * fdy <= 1) col = [200 - 30 * fdy, 150 - 25 * fdy, 122 - 20 * fdy];
    var acc = [0, 0, 0], cov = 0;
    for (var k = 0; k < hands.length; k++) {
      var hd = hands[k], dx = x + 0.5 - hd.cx, dy = y + 0.5 - hd.cy;
      if (dx * dx + dy * dy > ext * ext) continue;
      // inverse rotate into sprite space; the left hand is the sprite mirrored
      var lx = (dx * hd.c + dy * hd.s) / hs, ly = (-dx * hd.s + dy * hd.c) / hs;
      sample(S, ax + hd.side * lx, ay + ly, tmp);
      if (tmp[3] > 0) { acc[0] += tmp[0] * hd.wgt; acc[1] += tmp[1] * hd.wgt; acc[2] += tmp[2] * hd.wgt; cov += tmp[3] * hd.wgt; }
    }
    if (cov > 0) { cov = Math.min(1, cov); var inv = 1 / Math.max(1e-6, cov); for (var ch = 0; ch < 3; ch++) col[ch] = col[ch] * (1 - cov) + acc[ch] * inv * cov; }
    var gn = o.gain, q = (y * W + (o.camera ? W - 1 - x : x)) * 4;
    out[q] = col[0] * gn + (R() + R() - 1) * 2.45 * o.noise; out[q + 1] = col[1] * gn + (R() + R() - 1) * 2.45 * o.noise; out[q + 2] = col[2] * gn + (R() + R() - 1) * 2.45 * o.noise; out[q + 3] = 255;
  }
  return out;
}

/** the steering script: level, sweeps to +-110 deg (hands cross past 90), quick corrections, a hard left, level */
function truth(t) {
  var T = t % 12;
  if (T < 1.5) return 0;
  if (T < 5.5) return 110 * Math.sin((T - 1.5) / 4 * Math.PI * 2);
  if (T < 8.5) return 35 * Math.sin((T - 5.5) * Math.PI * 1.4);
  if (T < 10) return -70 * Math.sin((T - 8.5) / 1.5 * Math.PI);
  return 0;
}

function writeY4m(file, o) {
  o = Object.assign({ w: 640, h: 480, fps: 30, seconds: 12 }, o || {});
  var fd = fs.openSync(file, 'w'), N = Math.round(o.fps * o.seconds), tr = [];
  fs.writeSync(fd, 'YUV4MPEG2 W' + o.w + ' H' + o.h + ' F' + o.fps + ':1 Ip A1:1 C420jpeg\n');
  for (var i = 0; i < N; i++) {
    var t = i / o.fps, a = (o.truth || truth)(t);
    var per = o.per ? o.per(i, t) : {};
    var f = frame(Object.assign({ w: o.w, h: o.h, camera: true, seed: i + 1, gain: 1 + 0.1 * Math.sin(t * 0.9), cx: 0.5 + 0.02 * Math.sin(t * 0.7), cy: 0.58 + 0.015 * Math.sin(t * 1.3) }, o.scene || {}, per, { angle: a }));
    SY.stamp(f, o.w, i, Math.round(o.w / 40));
    fs.writeSync(fd, SY.toI420(f, o.w, o.h));
    tr.push(a);
  }
  fs.closeSync(fd);
  return { frames: N, truth: tr, fps: o.fps };
}

module.exports = { frame: frame, truth: truth, writeY4m: writeY4m, sprite: sprite };

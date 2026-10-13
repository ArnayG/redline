/* Synthetic webcam frames for the webcam air wheel tests (tests/camwheel.test.js, tests/camwheel-e2e.test.js).
   render(opts) -> Uint8ClampedArray RGBA (w x h), in the PLAYER'S (mirrored) view unless opts.camera (camera view =
   flipped horizontally, as a real webcam delivers it).
   opts: w, h, style 'pair'|'bar', angle (deg, clockwise +), cx, cy (0..1), radius (0..1 of w: hub -> marker), size
   (marker radius / bar thickness, 0..1 of w), color [r,g,b] (+ color2 for a two-colour pair), gain (lighting), grad
   (left -> right lighting gradient), noise (sigma, 0..255), seed, clutter (n random boxes), distractor ({x, y, r} a
   blob of the marker colour), blur (deg swept during the exposure), occlude (0..1 of one marker covered by a hand),
   skin (draw arms / hands / a face). */
'use strict';

function rng(seed) { var s = (seed >>> 0) || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { return (r() + r() - 1) * 2.449; }   // zero mean, unit variance (triangular), cheap

var SKIN = [214, 160, 128], FACE = [200, 150, 120];
var bgCache = {};
/** wall gradient + furniture-ish boxes in muted colours (cached: the room does not change between frames) */
function background(w, h, seed, clutter) {
  var key = w + 'x' + h + ':' + seed + ':' + clutter;
  if (bgCache[key]) return bgCache[key];
  var bg = new Float32Array(w * h * 3), x, y, p;
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    p = (y * w + x) * 3; var t = y / h;
    bg[p] = 150 - 40 * t; bg[p + 1] = 145 - 35 * t; bg[p + 2] = 135 - 30 * t;
  }
  var R2 = rng(seed * 31 + 5);
  var muted = [[90, 70, 50], [60, 80, 95], [120, 120, 110], [40, 40, 45], [150, 130, 90], [80, 100, 70], [170, 160, 150], [100, 60, 60]];
  for (var k = 0; k < clutter; k++) {
    var bx = R2() * w, by = R2() * h, bw = (0.05 + R2() * 0.25) * w, bh = (0.05 + R2() * 0.3) * h, c = muted[k % muted.length];
    for (y = Math.max(0, by | 0); y < Math.min(h, by + bh); y++) for (x = Math.max(0, bx | 0); x < Math.min(w, bx + bw); x++) {
      p = (y * w + x) * 3; bg[p] = c[0]; bg[p + 1] = c[1]; bg[p + 2] = c[2];
    }
  }
  return (bgCache[key] = bg);
}

function render(o) {
  o = Object.assign({ w: 160, h: 120, style: 'pair', angle: 0, cx: 0.5, cy: 0.55, radius: 0.2, size: 0.045, color: [230, 40, 60], gain: 1, grad: 0, noise: 3, seed: 7, clutter: 10, blur: 0, occlude: 0, skin: true }, o || {});
  var w = o.w, h = o.h, R = rng(o.seed), out = new Uint8ClampedArray(w * h * 4);
  var bg = background(w, h, o.bgSeed || 3, o.clutter), x, y, p;
  var cx = o.cx * w, cy = o.cy * h, rad = o.radius * w, sz = o.size * w;
  // a face behind the wheel
  function inEll(px, py, ex, ey, rx, ry) { var dx = (px - ex) / rx, dy = (py - ey) / ry; return dx * dx + dy * dy <= 1; }
  // coverage of the markers, supersampled 3x3, over the exposure (motion blur: several angles averaged)
  var steps = o.blur ? 5 : 1, SS = o.ss || 3;
  // which pixels can touch a marker / arm at all (everything else is plain background: no supersampling)
  var near = [];
  for (var s0 = 0; s0 < steps; s0++) {
    var an = (o.angle + (steps > 1 ? (s0 / (steps - 1) - 0.5) * o.blur : 0)) * Math.PI / 180;
    near.push({ c: Math.cos(an), s: Math.sin(an) });
  }
  function nearAny(px, py) {
    for (var k = 0; k < near.length; k++) {
      var c = near[k].c, sn = near[k].s;
      if (o.style === 'pair') {
        for (var m = -1; m <= 1; m += 2) {
          var mx = cx + m * rad * c, my = cy + m * rad * sn, dx = px - mx, dy = py - my;
          if (dx * dx + dy * dy <= (sz + 1.5) * (sz + 1.5)) return true;
          if (o.skin && Math.abs(dx) < sz * 0.7 + 1.5 && dy > sz * 0.8 - 1.5 && dy < sz * 4 + 1.5) return true;
        }
      } else {
        var lx = (px - cx) * c + (py - cy) * sn, ly = -(px - cx) * sn + (py - cy) * c;
        if (Math.abs(lx) <= rad + 1.5 && Math.abs(ly) <= sz + 1.5) return true;
      }
    }
    return false;
  }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    p = (y * w + x) * 3;
    var col = [bg[p], bg[p + 1], bg[p + 2]];
    if (o.skin && inEll(x, y, cx, cy - 0.38 * h, 0.12 * w, 0.2 * h)) col = FACE.slice();
    var acc = [0, 0, 0], cov = 0, far = !nearAny(x + 0.5, y + 0.5);
    for (var st = 0; st < (far ? 0 : steps); st++) {
      var ang = (o.angle + (steps > 1 ? (st / (steps - 1) - 0.5) * o.blur : 0)) * Math.PI / 180;
      var ca = Math.cos(ang), sa = Math.sin(ang);
      for (var sy = 0; sy < SS; sy++) for (var sx = 0; sx < SS; sx++) {
        var px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        var hit = null, shade = 1;
        if (o.style === 'pair') {
          for (var m = 0; m < 2; m++) {
            var mx = cx + (m ? 1 : -1) * rad * ca, my = cy + (m ? 1 : -1) * rad * sa;
            var dx = px - mx, dy = py - my, d2 = (dx * dx + dy * dy) / (sz * sz);
            if (d2 <= 1) {
              // a hand covering part of marker 0 (occlusion), from its lower side
              if (m === 0 && o.occlude > 0 && dy > sz * (1 - 2 * o.occlude)) { hit = SKIN; break; }
              hit = m && o.color2 ? o.color2 : o.color; shade = 1 - 0.35 * d2 + 0.15 * (-dy / sz); break;
            }
          }
          // arms / wrists below the fists
          if (!hit && o.skin) {
            for (m = 0; m < 2; m++) {
              var ax = cx + (m ? 1 : -1) * rad * ca, ay = cy + (m ? 1 : -1) * rad * sa;
              if (Math.abs(px - ax) < sz * 0.7 && py > ay + sz * 0.8 && py < ay + sz * 4) { hit = SKIN; shade = 0.95; break; }
            }
          }
        } else {
          var lx = (px - cx) * ca + (py - cy) * sa, ly = -(px - cx) * sa + (py - cy) * ca;
          if (Math.abs(lx) <= rad && Math.abs(ly) <= sz) {
            hit = o.color; shade = 1 - 0.25 * Math.abs(ly) / sz;
            if (o.skin && Math.abs(Math.abs(lx) - rad * 0.55) < sz * 1.1) { hit = SKIN; shade = 1; }   // two hands on the bar
          }
        }
        if (hit) { acc[0] += hit[0] * shade; acc[1] += hit[1] * shade; acc[2] += hit[2] * shade; cov++; }
      }
    }
    var n = SS * SS * steps;
    if (cov) { var f = cov / n; for (var ch = 0; ch < 3; ch++) col[ch] = col[ch] * (1 - f) + (acc[ch] / cov) * f; }
    if (o.distractor && inEll(x, y, o.distractor.x * w, o.distractor.y * h, o.distractor.r * w, o.distractor.r * w)) col = (o.distractor.color || o.color).slice();
    // lighting: global gain + horizontal gradient, then sensor noise
    var g = o.gain * (1 + o.grad * (x / w - 0.5));
    var q = (y * w + (o.camera ? w - 1 - x : x)) * 4;
    out[q] = col[0] * g + gauss(R) * o.noise; out[q + 1] = col[1] * g + gauss(R) * o.noise; out[q + 2] = col[2] * g + gauss(R) * o.noise; out[q + 3] = 255;
  }
  if (o.chroma420) subsample(out, w, h);
  return out;
}
/** webcam-style 4:2:0 chroma: colour is shared by 2x2 pixels (colour bleeds across marker edges) */
function subsample(rgba, w, h) {
  for (var y = 0; y + 1 < h; y += 2) for (var x = 0; x + 1 < w; x += 2) {
    var cb = 0, cr = 0, Y = [], k = 0;
    for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) {
      var i = ((y + dy) * w + x + dx) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      Y[k++] = 0.299 * r + 0.587 * g + 0.114 * b; cb += -0.1687 * r - 0.3313 * g + 0.5 * b; cr += 0.5 * r - 0.4187 * g - 0.0813 * b;
    }
    cb /= 4; cr /= 4; k = 0;
    for (dy = 0; dy < 2; dy++) for (dx = 0; dx < 2; dx++) {
      var j = ((y + dy) * w + x + dx) * 4, yy = Y[k++];
      rgba[j] = yy + 1.402 * cr; rgba[j + 1] = yy - 0.344 * cb - 0.714 * cr; rgba[j + 2] = yy + 1.772 * cb;
    }
  }
}

/** RGBA (w x h) -> one Y4M 4:2:0 frame (Y, Cb, Cr planes; BT.601 limited range) */
function toI420(rgba, w, h) {
  var Y = Buffer.alloc(w * h), U = Buffer.alloc((w >> 1) * (h >> 1)), V = Buffer.alloc((w >> 1) * (h >> 1));
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    Y[y * w + x] = Math.max(0, Math.min(255, Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b)));
  }
  for (y = 0; y < h; y += 2) for (x = 0; x < w; x += 2) {
    var r2 = 0, g2 = 0, b2 = 0;
    for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) { var j = ((y + dy) * w + x + dx) * 4; r2 += rgba[j]; g2 += rgba[j + 1]; b2 += rgba[j + 2]; }
    r2 /= 4; g2 /= 4; b2 /= 4;
    var k = (y >> 1) * (w >> 1) + (x >> 1);
    U[k] = Math.max(0, Math.min(255, Math.round(128 - 0.148 * r2 - 0.291 * g2 + 0.439 * b2)));
    V[k] = Math.max(0, Math.min(255, Math.round(128 + 0.439 * r2 - 0.368 * g2 - 0.071 * b2)));
  }
  return Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]);
}

/** the ground-truth steering script: hold level, then turn +-120 deg with varying speeds */
function truthAngle(tSec) {
  var T = tSec % 12;
  if (T < 1.5) return 0;
  if (T < 4.5) return 120 * Math.sin((T - 1.5) / 3 * Math.PI * 2) ;           // full turns +-120
  if (T < 8.5) return 45 * Math.sin((T - 4.5) * Math.PI * 1.5);               // quick small corrections
  if (T < 10) return -90 * Math.sin((T - 8.5) / 1.5 * Math.PI);               // a hard left
  return 0;
}

/** stamp the frame number as a 12-bit black / white barcode (16x16 px cells) along the top-left edge of a CAMERA-view frame */
function stamp(rgba, w, idx, cell) {
  cell = cell || 16;
  for (var b = 0; b < 12; b++) {
    var on = (idx >> b) & 1, v = on ? 250 : 5;
    for (var y = 0; y < cell; y++) for (var x = b * cell; x < (b + 1) * cell; x++) { var i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; }
  }
}
/** the scripted session as a .y4m webcam file for Chrome's fake capture (--use-file-for-fake-video-capture) */
function writeY4m(file, o) {
  var fs = require('fs');
  o = Object.assign({ w: 640, h: 480, fps: 30, seconds: 12, style: 'pair' }, o || {});
  var fd = fs.openSync(file, 'w'), N = Math.round(o.fps * o.seconds), truth = [];
  fs.writeSync(fd, 'YUV4MPEG2 W' + o.w + ' H' + o.h + ' F' + o.fps + ':1 Ip A1:1 C420jpeg\n');
  for (var i = 0; i < N; i++) {
    var t = i / o.fps, a = (o.truth || truthAngle)(t);
    var per = o.per ? o.per(i, t) : {};
    var f = render(Object.assign({ w: o.w, h: o.h, camera: true, seed: i + 1, noise: 4, gain: 1 + 0.12 * Math.sin(t * 0.9), cx: 0.5 + 0.03 * Math.sin(t * 0.7), cy: 0.56 + 0.02 * Math.sin(t * 1.3) }, o.scene || {}, per, { angle: a, style: o.style }));
    stamp(f, o.w, i, Math.round(o.w / 40));
    fs.writeSync(fd, toI420(f, o.w, o.h));
    truth.push(a);
  }
  fs.closeSync(fd);
  return { frames: N, truth: truth, fps: o.fps };
}

module.exports = { background: background, render: render, toI420: toI420, truthAngle: truthAngle, rng: rng, stamp: stamp, writeY4m: writeY4m };

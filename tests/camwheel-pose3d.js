/* 3D hand poses for the webcam wheel pedal tests (tests/camwheel-fist.test.js) and the false-brake diagnosis.
   Starts from REAL MediaPipe landmarks (tests/fixtures/hands/landmarks.json: two closed fists at 9 and 3, palms to the
   camera) lifted to 3D (x * W, y * H, z * W px), optionally opened (fingers straightened in the palm plane) or half-closed,
   then moved like a player does while steering: the wheel turned (in-plane, about the hub), each hand rolled about its
   forearm axis and pitched, moved nearer / farther (perspective), towards the frame edges (barrel lens distortion,
   optionally clipped at the border like a hand half out of frame), with landmark jitter. Returns detector-style hands:
   {lm (normalised CAMERA coords + relative z), wl (world landmarks, metres, hand-centred, camera-aligned, noisy), score, label}.
     P3.hands({grip, turn, roll, pitch, dist, dx, dy, k1, jitter, wjitter, clip, rng, only}) -> [hand, hand]
       grip 1 = the fixture fist .. 0 = fully open (0.5 half), turn deg (wheel, clockwise as the player sees it),
       roll deg (each hand about its wrist -> middle-MCP axis; mirrored for the left hand so both roll "with" the wheel),
       pitch deg (fingers towards / away from the camera), dist (1 = calibrated distance, 1.2 = 20 % farther),
       dx / dy px offsets of the whole wheel, k1 barrel distortion at the frame corner (-0.1 typical webcam), wlGain: the
       world landmarks' share of the true roll / pitch (MediaPipe's 3D guess under-estimates out-of-plane rotation)
     P3.W, P3.H, P3.rng(seed), P3.gauss(R) */
'use strict';
var FIX = require('./fixtures/hands/landmarks.json');
var W = FIX.video.w, H = FIX.video.h, F = 520;            // focal length (px) of a typical 640-wide webcam (~63 deg HFOV)
var BASE = FIX.frames[0].hands.map(function (h) { return { label: h.label, score: h.score, p: h.lm.map(function (q) { return [q[0] * W, q[1] * H, q[2] * W]; }) }; });

function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(R) { var u = Math.max(1e-9, R()), v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function len(a) { return Math.hypot(a[0], a[1], a[2]); }
function norm(a) { var l = len(a) || 1; return mul(a, 1 / l); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
/** Rodrigues: rotate v about unit axis k by deg */
function rotAx(v, k, deg) {
  var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}
/** fingers straightened (g = 0) .. as in the fixture (g = 1): each finger rotated, joint by joint, towards the line
    continuing wrist -> its MCP, in 3D (bone lengths kept, so the hand is anatomically the same size) */
function openHand(p, g) {
  var o = p.map(function (q) { return q.slice(); });
  [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20], [1, 2, 3, 4]].forEach(function (f, fi) {
    var dir = norm(sub(p[f[0]], p[0]));
    if (fi === 4) dir = norm(add(norm(sub(p[1], p[0])), mul(norm(sub(p[5], p[0])), -0.15)));   // the thumb out to the side
    var prev = o[f[0]];
    for (var k = 1; k < 4; k++) {
      var bone = sub(p[f[k]], p[f[k - 1]]), L = len(bone), cur = norm(bone);
      var want = norm(add(mul(dir, 1 - g), mul(cur, g)));
      if (len(add(mul(dir, 1 - g), mul(cur, g))) < 1e-6) want = dir;
      var q = add(prev, mul(want, L));
      o[f[k]] = q; prev = q;
    }
  });
  return o;
}
function palmC(p) { var c = [0, 0, 0]; [0, 5, 9, 13, 17].forEach(function (i) { c = add(c, mul(p[i], 0.2)); }); return c; }

function hands(o) {
  o = Object.assign({ grip: 1, turn: 0, roll: 0, pitch: 0, dist: 1, dx: 0, dy: 0, k1: 0, jitter: 0, wjitter: 0, wlGain: 1, clip: false, rng: null, only: null }, o || {});
  var R = o.rng || rng(1);
  var cs = BASE.map(function (h) { return palmC(h.p); });
  var hub = [(cs[0][0] + cs[1][0]) / 2, (cs[0][1] + cs[1][1]) / 2, 0];
  var Z0 = F * 1.0;                                         // the calibrated depth, in the fixture's px units
  var out = [];
  BASE.forEach(function (h, hi) {
    if (o.only != null && o.only !== hi) return;
    var c = cs[hi], g = typeof o.grip === 'number' ? o.grip : o.grip[hi];
    var p = g >= 1 ? h.p.map(function (q) { return q.slice(); }) : openHand(h.p, g);
    // hand-local frame: about its palm centre
    var loc = p.map(function (q) { return sub(q, c); });
    var ax = norm(sub(loc[9], loc[0])), wd = norm(sub(loc[17], loc[5]));
    // the PLAYER's left hand (camera right) rolls the other way round its axis for the same wheel motion
    var side = c[0] > hub[0] ? 1 : -1;
    var roll = typeof o.roll === 'number' ? o.roll : o.roll[hi], pitch = typeof o.pitch === 'number' ? o.pitch : o.pitch[hi];
    var loc0 = loc;
    loc = loc0.map(function (q) { var v = rotAx(q, ax, roll * side); return rotAx(v, wd, pitch); });
    // the detector's 3D guess of the hand's orientation is imperfect: wlGain < 1 under-estimates the roll / pitch
    var locW = o.wlGain === 1 ? loc : loc0.map(function (q) { var v = rotAx(q, ax, roll * side * o.wlGain); return rotAx(v, wd, pitch * o.wlGain); });
    // the wheel turn: in the image plane about the hub (camera coords are mirrored: the player's clockwise = -deg here)
    var a = -o.turn * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    function rz(v) { return [v[0] * ca - v[1] * sa, v[0] * sa + v[1] * ca, v[2]]; }
    loc = loc.map(rz); locW = locW === loc ? loc : locW.map(rz);
    var rc = rz(sub(c, hub));
    var centre = [hub[0] + rc[0] + o.dx, hub[1] + rc[1] + o.dy];
    // perspective: the hand's centre at depth Z0 * dist, image position `centre` at the calibrated depth scaled by dist
    var Zc = Z0 * o.dist, Cc = [(centre[0] - W / 2) * o.dist, (centre[1] - H / 2) * o.dist, Zc];
    var lm = [], zw = null;
    loc.forEach(function (q, i) {
      var Q = add(Cc, q), u = W / 2 + F * Q[0] / Q[2], v = H / 2 + F * Q[1] / Q[2];
      if (o.k1) { var nx = (u - W / 2) / (W / 2), ny = (v - H / 2) / (W / 2), r2 = (nx * nx + ny * ny) / (1 + (H / W) * (H / W)); var k = 1 + o.k1 * r2; u = W / 2 + (u - W / 2) * k; v = H / 2 + (v - H / 2) * k; }
      if (o.jitter) { u += gauss(R) * o.jitter; v += gauss(R) * o.jitter; }
      if (o.clip) { u = Math.max(0, Math.min(W, u)); v = Math.max(0, Math.min(H, v)); }
      var z = (q[2] * F / Q[2]) / W;
      if (zw == null) zw = z;
      lm.push({ x: u / W, y: v / H, z: z - zw + (o.jitter ? gauss(R) * o.jitter * 2 / W : 0) });
    });
    // world landmarks: the same 3D hand in metres (palm length wrist -> middle MCP ~ 0.085 m), camera-aligned, noisy
    var pl = len(sub(loc[9], loc[0])) || 1, ms = 0.085 / pl;
    var wl = locW.map(function (q) { return { x: q[0] * ms + (o.wjitter ? gauss(R) * o.wjitter : 0), y: q[1] * ms + (o.wjitter ? gauss(R) * o.wjitter : 0), z: q[2] * ms + (o.wjitter ? gauss(R) * o.wjitter : 0) }; });
    out.push({ lm: lm, wl: wl, score: h.score, label: h.label });
  });
  return out;
}

module.exports = { hands: hands, openHand: openHand, W: W, H: H, F: F, rng: rng, gauss: gauss };

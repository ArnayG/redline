/* ==========================================================================
   FORGE — js/input/camwheel-hands.js
   CB.input.camhands : bare-hands steering for the webcam air wheel. The player holds an IMAGINARY steering wheel in front
   of the webcam; MediaPipe Hand Landmarker (vendored, Apache-2.0: vendor/mediapipe/tasks-vision-0.10.35/, loaded only
   when the webcam wheel is switched on) finds 21 landmarks per hand, and this module turns them into a wheel angle.
   Pure landmark maths (Node-tested with fixture landmark arrays) + the lazy loader / detector.

   Landmarks: MediaPipe normalised image coordinates of the CAMERA frame (x 0..1 left -> right as the camera sees it,
   y 0..1 down). Everything here converts to the PLAYER'S (mirrored) view in pixels: X = (1 - x) * W, Y = y * H, so
   turning the imaginary wheel clockwise (as the player sees it) gives a positive angle = steer right.
     0 wrist, 5 index MCP, 9 middle MCP, 13 ring MCP, 17 pinky MCP; tips 8 12 16 20; PIPs 6 10 14 18.

   Steering
     two hands  angle of the line from the left palm centre to the right palm centre (palm centre = mean of the wrist and
                the four MCPs), like gripping the wheel at 9 and 3. Which hand is "left" follows angle continuity (not
                the handedness labels), so turning past 90 deg, where the hands cross over, keeps going (period 360).
                Re-acquired after a loss (> graceMs): identified by plausibility (within +-90 deg of straight ahead),
                never on first sight at ~180 (see the consistency rules above createSolver).
     one hand   that hand's roll: the index-MCP -> pinky-MCP line and the wrist -> middle-MCP direction, each relative to
                its neutral (calibrated, or taken when the other hand disappears), averaged.
     top grip   S.style 'top' (or 'auto' with one hand in view): ONE hand grips the top of an imaginary wheel; the
                angle is the palm centre's angle around the wheel centre (straight below the calibrated top point by
                R = TOP_K x palm length x S.wheelSize), from 12 o'clock, plus a little of the hand's roll; depth
                compensated by the hand's scale (see topStep). meas.side 'L' | 'R' (ch.handSide: chirality geometry),
                meas.rim {cx, cy, r, gx, gy} (the rim and the grip point, image px, for the preview).
     switching  two <-> one hand never jumps: the new reading is chosen nearest the current angle and re-based onto
                it (|offset| < 90, never a pi turn), and that offset then bleeds back to the source's own zero over
                ~0.5 s (so a long one-hand stint cannot drift).

     ch.palm(lm, W, H) -> {x, y, size}      size = wrist -> middle-MCP length (px), for push / distance gestures
     ch.handRoll(lm, W, H) -> {a: deg (index->pinky MCP line), b: deg (wrist -> middle MCP)}
     ch.curl(lm, wl?) -> 0 (open palm) .. 1 (closed fist)     wl: world landmarks (metres) when the detector has them
     ch.handScale(lm, wl, W, H) -> {s, world}   palm-only apparent scale (push / pull = distance), tilt-robust with wl
     ch.openness(lm, wl, W, H) -> {o 0 (fist) .. 1 (open hand), f [4 fingers], n}   rotation / scale invariant finger extension
     ch.facing(lm, W, H) -> 1 (palm square to the camera) .. 0 (edge-on)   ch.pullScale(lm, wl, W, H) -> {s, world} (3D size)
     ch.createPedals() -> P   hands-only throttle / brake / handbrake ('fist' default | 'auto' | 'grip' | 'push' | 'off')
     ch.handSide(hand, W) -> 'L' | 'R'     ch.chirality(hand) -> -1..1 (+ = a right hand)
     ch.createSolver(opts?) -> S   S.update(hands, W, H, t) -> meas {ok, angle (deg, continuous), period: 360, conf,
                                   mode:'two'|'one'|null, fresh, pts, hands}   S.calibrate() (current pose = centre)
                                   S.state()   hands: [{lm, score, label}] straight from the detector
                                   S.style 'two' (default) | 'top' | 'auto'   S.wheelSize (1)   S.topCal (persisted)
     ch.gestures(meas, prefs, t, st) -> {throttle, nitro}   (nitro push; the old fists-throttle; off unless enabled)
   Browser
     ch.load({preferGpu, worker}) -> Promise<{ok, delegate:'GPU'|'CPU', worker, reason?}>  (worker: js/input/camwheel-worker.js)
     ch.submit(video, tMs) -> taken?   ch.onResult(fn(hands, tMs, inferMs)) -> off   ch.detect(video, tMs) (main thread, sync)
     ch.loaded()  ch.delegate()  ch.mode ('worker'|'main')  ch.lastMs (inference ms)  ch.VENDOR (base path)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var VENDOR = 'vendor/mediapipe/tasks-vision-0.10.35/';
  var PALM = [0, 5, 9, 13, 17];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrap180(a) { return ((a + 180) % 360 + 360) % 360 - 180; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function P(lm, i, W, H) { var p = lm[i]; return { x: (1 - p.x) * W, y: p.y * H }; }
  function ang(a, b) { return Math.atan2(b.y - a.y, b.x - a.x) / DEG; }

  /* ================================================================ landmark maths */
  function palm(lm, W, H) {
    var x = 0, y = 0;
    for (var i = 0; i < PALM.length; i++) { var p = P(lm, PALM[i], W, H); x += p.x; y += p.y; }
    var w = P(lm, 0, W, H), m = P(lm, 9, W, H);
    return { x: x / PALM.length, y: y / PALM.length, size: Math.hypot(m.x - w.x, m.y - w.y) };
  }
  function handRoll(lm, W, H) {
    return { a: ang(P(lm, 5, W, H), P(lm, 17, W, H)), b: ang(P(lm, 0, W, H), P(lm, 9, W, H)) };
  }
  /** finger curl: tips folded back towards the wrist. 0 = open palm, 1 = closed fist (scale-free, 3D). wl: MediaPipe
      world landmarks (metres, hand-centred) when the detector gives them: a true 3D hand, so the camera angle matters less */
  function curl(lm, wl) {
    var L = wl && wl.length >= 21 ? wl : lm;
    function d(i, j) { var a = L[i], b = L[j]; return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }
    var ref = d(0, 9) || 1e-6, s = 0;
    [[8, 5], [12, 9], [16, 13], [20, 17]].forEach(function (f) {
      // open finger: tip far beyond its MCP (~0.75 x palm length); folded: tip back near the MCP / palm
      var r = d(f[0], 0) / ref, m = d(f[1], 0) / ref;
      s += clamp((m + 0.75 - r) / 0.75, 0, 1);
    });
    return s / 4;
  }
  /* finger EXTENSION (the "Fist = go, open hand = brake" pedals): per finger, from 3D joint positions only, so it does not
     change when the hand turns, rolls, tilts, moves nearer / farther or towards the frame edges:
       straightness = |tip - MCP| / (MCP->PIP + PIP->DIP + DIP->tip)   (1 = a straight finger, ~0.3-0.5 folded)
       reach        = |tip - wrist| / |MCP - wrist|                    (~1.6-1.9 open, ~0.8-1.0 in a fist)
     each mapped to 0 (folded) .. 1 (extended) and averaged; the hand's openness is the mean of the four fingers (the thumb
     is ignored: it rests on the "rim" either way). Computed on the world landmarks (metric 3D, when the detector gives
     them) AND on the image landmarks lifted to 3D (x * W, y * H, z * W px), averaged per finger; when either of the two
     reads the hand closed, it counts as that closed, so a doubtful reading leans to "closed" (grip wins, no false brake).
     ch.openness(lm, wl, W, H) -> {o: 0 (fist) .. 1 (open), f: [index, middle, ring, pinky], n: fingers extended (f > 0.6)} */
  var FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  var EXT = { s0: 0.55, s1: 0.92, r0: 1.1, r1: 1.55 };
  function fingerExt(L, sx, sy, sz) {
    function d(i, j) { var a = L[i], b = L[j]; return Math.hypot((a.x - b.x) * sx, (a.y - b.y) * sy, ((a.z || 0) - (b.z || 0)) * sz); }
    var palmL = d(0, 9) || 1e-6;
    return FINGERS.map(function (f) {
      var chain = d(f[0], f[1]) + d(f[1], f[2]) + d(f[2], f[3]);
      if (chain < palmL * 0.15) return 0;                       // collapsed (a detector failure): not "open"
      var st = d(f[3], f[0]) / chain, mw = d(f[0], 0) || 1e-6, rc = d(f[3], 0) / mw;
      return (clamp((st - EXT.s0) / (EXT.s1 - EXT.s0), 0, 1) + clamp((rc - EXT.r0) / (EXT.r1 - EXT.r0), 0, 1)) / 2;
    });
  }
  function openness(lm, wl, W, H) {
    W = W || 1; H = H || 1;
    var fi = fingerExt(lm, W, H, W), fw = wl && wl.length >= 21 ? fingerExt(wl, 1, 1, 1) : null;
    function mean(a) { return (a[0] + a[1] + a[2] + a[3]) / 4; }
    var f = fw ? fi.map(function (v, i) { return (v + fw[i]) / 2; }) : fi, o = mean(f);
    // either reading says "closed": the hand is (at most) that closed
    if (fw) { var lo = Math.min(mean(fi), mean(fw)); if (lo < PED.closeOn) o = Math.min(o, lo); }
    return { o: o, f: f, n: f.filter(function (v) { return v > 0.6; }).length };
  }
  /* how many landmarks lie beyond the frame border (palm landmarks: within 2 % of it): a hand partly out of the picture (the detector guesses the
     fingers it cannot see, often as straight ones) */
  var PALM_SET = { 0: 1, 1: 1, 5: 1, 9: 1, 13: 1, 17: 1 };
  function outside(lm) {
    var n = 0;
    for (var i = 0; i < lm.length; i++) {
      var p = lm[i], m = PALM_SET[i] ? 0.02 : 0;          // the palm: at the border already; a fingertip: beyond it
      if (p.x < m || p.x > 1 - m || p.y < m || p.y > 1 - m) n++;
    }
    return n;
  }
  /* the palm's 2D shape: knuckle-line width / palm length (wrist -> middle MCP), in the image. Rolling the hand narrows it,
     tilting it shortens the length: against the neutral pose's value, a cue for "rotated, not pulled back" that does
     not need the depth estimate */
  function aspect(lm, W, H) { var a = lm[5], b = lm[17], w = lm[0], m = lm[9], L = Math.hypot((m.x - w.x) * W, (m.y - w.y) * H); return L > 1e-6 ? Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) / L : 1; }
  /* out-of-plane rotation of the palm (rolled / tilted hand): the knuckle line's and the palm length's image (2D) share of
     their 3D length (image landmarks lifted to 3D). 1 = palm square to the camera, cos(angle) when rolled / pitched. */
  function facing(lm, W, H) {
    function r(i, j) { var a = lm[i], b = lm[j], dx = (a.x - b.x) * W, dy = (a.y - b.y) * H, dz = ((a.z || 0) - (b.z || 0)) * W, l3 = Math.hypot(dx, dy, dz); return l3 > 1e-9 ? Math.hypot(dx, dy) / l3 : 1; }
    return Math.min(r(5, 17), r(0, 9));
  }
  /* rotation-invariant apparent size for the (opt-in) pull-back brake: 3D lengths of the palm segments, image landmarks
     lifted to 3D (px), per metre of the same segments in the world landmarks when the detector gives them. Unlike the
     2D lengths these do not shrink when the hand rolls or tilts; unlike handScale's projected ratio there is no switch-over. */
  function pullScale(lm, wl, W, H) {
    var px = 0, w3 = 0, i;
    for (i = 0; i < SEG.length; i++) { var a = lm[SEG[i][0]], b = lm[SEG[i][1]]; px += Math.hypot((a.x - b.x) * W, (a.y - b.y) * H, ((a.z || 0) - (b.z || 0)) * W); }
    if (wl && wl.length >= 21) {
      for (i = 0; i < SEG.length; i++) { var p = wl[SEG[i][0]], q = wl[SEG[i][1]]; w3 += Math.hypot(p.x - q.x, p.y - q.y, (p.z || 0) - (q.z || 0)); }
      if (w3 > 1e-4) return { s: px / w3 / 1000, world: true };
    }
    return { s: px / SEG.length, world: false };
  }
  /* apparent hand scale (for push / pull = distance from the camera). Palm segments only (wrist + the four MCPs), which
     do not move when the fingers curl. With world landmarks: image px per metre of the same segments seen in the
     camera's x-y plane (weak perspective), which cancels the hand tilting; without: their mean length in px. */
  var SEG = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17], [5, 17]];
  function handScale(lm, wl, W, H) {
    var px = 0, i;
    for (i = 0; i < SEG.length; i++) { var a = lm[SEG[i][0]], b = lm[SEG[i][1]]; px += Math.hypot((a.x - b.x) * W, (a.y - b.y) * H); }
    if (wl && wl.length >= 21) {
      var w2 = 0, w3 = 0;
      for (i = 0; i < SEG.length; i++) { var p = wl[SEG[i][0]], q = wl[SEG[i][1]]; w2 += Math.hypot(p.x - q.x, p.y - q.y); w3 += Math.hypot(p.x - q.x, p.y - q.y, (p.z || 0) - (q.z || 0)); }
      // nearly edge-on (the x-y projection collapses): the ratio is unreliable, use the palm's true size instead
      if (w2 > 0.45 * w3 && w2 > 1e-4) return { s: px / w2 / 1000, world: true };
      if (w3 > 1e-4) return { s: px / w3 / 1000, world: true };
    }
    return { s: px / SEG.length, world: false };
  }

  /* which hand is it, as the PLAYER sees it ('L' | 'R'), by geometry: the palm normal (index MCP x pinky MCP from the
     wrist) against the side the fingers and thumb sit on (the palm side), in the CAMERA frame (unmirrored, as MediaPipe
     sees it: x right, y down, z smaller = nearer). That is the hand's chirality, whatever its rotation or which side
     faces the camera. Weak (a flat, open hand): MediaPipe's handedness label (on the unmirrored frame it names the
     player's own hand, matching the geometry on the fixtures), then the side of the picture. */
  var TOP_K = 2.5;      // one-hand top grip: wheel radius = TOP_K x palm length (wrist -> middle MCP) x wheelSize
  function chirality(h) {
    var L = h.wl && h.wl.length >= 21 ? h.wl : h.lm;
    function sub(a, b) { return [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)]; }
    var u = sub(L[5], L[0]), v = sub(L[17], L[0]);
    var n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    var m = [0, 0, 0], k = [0, 0, 0], j;
    [8, 12, 16, 20, 4].forEach(function (i) { for (j = 0; j < 3; j++) m[j] += [L[i].x, L[i].y, L[i].z || 0][j] / 5; });
    [5, 9, 13, 17].forEach(function (i) { for (j = 0; j < 3; j++) k[j] += [L[i].x, L[i].y, L[i].z || 0][j] / 4; });
    var d = [m[0] - k[0], m[1] - k[1], m[2] - k[2]], nn = Math.hypot(n[0], n[1], n[2]), dn = Math.hypot(d[0], d[1], d[2]);
    return nn > 0 && dn > 0 ? (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / nn / dn : 0;
  }
  function handSide(h, W) {
    var c = chirality(h);
    if (Math.abs(c) >= 0.08) return c > 0 ? 'R' : 'L';
    if (h.label === 'Right' || h.label === 'Left') return h.label === 'Right' ? 'R' : 'L';
    return palm(h.lm, W || 1, 1).x < (W || 1) / 2 ? 'L' : 'R';
  }

  /* ================================================================ solver: hands -> continuous wheel angle */
  /* Consistency rules (the wheel must never come back from a loss at ~180 deg):
     - identity (which hand is "a" = left at the wheel's straight-ahead pose) follows ANGLE continuity: between two
       tracked frames the wheel cannot turn ~180 deg, so of the two possible assignments the one nearest the previous
       angle wins (this also survives the detector swapping its output order, and hands crossing past 90 deg).
     - after a loss of both hands for more than graceMs (or a hand's own track older than graceMs) nothing stale is
       trusted: tracks, the unwrap state and the re-base offset start afresh, and the hands are identified by
       plausibility: two hands -> the assignment whose (calibrated) angle is within +-90 deg; one hand -> by position,
       unless that hand's roll then reads > 90 deg off while the other identity reads within 90. So |angle| > 90 is
       only ever reached by continuous motion from a tracked state, never on first sight. (MediaPipe's handedness labels
       are not used for this: they are from the camera's point of view, flip for the back of a hand and for some
       rotations; geometry is more reliable.)
     - one <-> two hands: the new reading is chosen nearest the current angle and re-based onto it (|offset| < 90,
       never a pi turn), and the offset bleeds back to the source's own zero over ~rebaseMs.
     - safety net: two hands held near-level but reading > flipDeg (i.e. upside down) for flipMs -> the identity is
       swapped and the angle bleeds smoothly back towards straight ahead (a stale swap can never get stuck at 180).
     meas.fresh = true on the first frame after a fresh (re-)acquisition: the steer stage relocks and eases in. */
  function createSolver(opts) {
    opts = opts || {};
    var rebaseMs = num(opts.rebaseMs, 500), graceMs = num(opts.graceMs, 300);
    var rollMix = num(opts.rollMix, 0.25);
    var flipDeg = num(opts.flipDeg, 155), flipMs = num(opts.flipMs, 1500);
    var S = {
      mode: null, angle: 0, offset: 0, target: 0, lastT: null, tracks: null, cal: null,
      style: opts.style || 'two', wheelSize: num(opts.wheelSize, 1), topCal: null, rim: null, qs: null, stillT: 0,
      neutral: {}, curls: [0, 0], sizes: [0, 0], baseSize: 0, flipT: 0,
      /** hands: [{lm, score}]  ->  meas */
      update: function (hands, W, H, t) {
        t = num(t, nowMs());
        var dt = S.lastT == null ? 0 : clamp((t - S.lastT) / 1000, 0, 0.5);
        S.lastT = t;
        hands = (hands || []).filter(function (h) { return h && h.lm && h.lm.length >= 21; });
        var cand = hands.map(function (h) { var p = palm(h.lm, W, H), sc = handScale(h.lm, h.wl, W, H), op = openness(h.lm, h.wl, W, H), ps = pullScale(h.lm, h.wl, W, H); return { h: h, x: p.x, y: p.y, size: p.size, scale: sc.s, world: sc.world, roll: handRoll(h.lm, W, H), curl: curl(h.lm, h.wl), open: op.o, nExt: op.n, face: facing(h.lm, W, H), ps: ps.s, psWorld: ps.world, cut: outside(h.lm), asp: aspect(h.lm, W, H), score: num(h.score, 1) }; });
        if (!cand.length) return { ok: false, conf: 0, mode: null, pts: [], hands: [] };
        // gone longer than the grace window: identify the hands afresh (calibration and learnt neutrals stay)
        var fresh = S.seenT == null || t - S.seenT > graceMs;
        if (fresh) S.reset();
        S.seenT = t;
        var T = S.tracks;
        if (T) {                                         // a hand's own track expires after the grace window too
          if (T.a && t - T.a.t > graceMs) T.a = null;
          if (T.b && t - T.b.t > graceMs) T.b = null;
          if (!T.a && !T.b) T = null;
        }
        var calTwo = S.cal ? num(S.cal.two, 0) : 0;
        var a = null, b = null, raw, mode, conf, prevMode = S.mode;
        // reference angle for choosing between readings: tracked -> the current angle; fresh -> straight ahead
        var tracked = prevMode !== null && !!T;
        // one-hand top grip: style 'top' always (one hand chosen), 'auto' whenever exactly one hand is in view
        if (S.style === 'top' || (S.style === 'auto' && cand.length === 1)) return topStep(cand, W, H, t, dt, fresh, T, prevMode, tracked);
        var ref = tracked ? (prevMode === 'two' && S._raw != null ? S._raw : S.angle) : 0;
        if (cand.length >= 2) {
          cand.sort(function (p, q) { return q.score - p.score; });
          var c0 = cand[0], c1 = cand[1];
          var r0 = ang(c0, c1) - calTwo;                  // a = c0, b = c1; the swapped assignment reads r0 + 180
          // (a near tie, e.g. a 90 deg change across a dropout, goes to the reading nearer straight ahead)
          var d0 = Math.abs(wrap180(r0 - ref)) + implaus(r0), d1 = Math.abs(wrap180(r0 + 180 - ref)) + implaus(r0 + 180);
          if (d0 <= d1) { a = c0; b = c1; raw = r0; } else { a = c1; b = c0; raw = r0 + 180; }
          mode = 'two';
          // safety net: near-level hands that read upside down for a while are a stale swap, not a 180 deg turn
          if (Math.abs(wrap180(raw)) > flipDeg) S.flipT += dt * 1000; else S.flipT = 0;
          if (S.flipT >= flipMs) {
            var tmp = a; a = b; b = tmp; raw = wrap180(raw + 180); S.flipT = 0;
            S.offset = S.angle - raw; S._raw = raw; S._flipped = true;
          }
          conf = Math.min(a.score, b.score);
          S.size = (a.size + b.size) / 2;
          S.lastTwo = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
        } else {
          var c = cand[0], key;
          if (T && T.a && T.b) key = dist(c, T.a) <= dist(c, T.b) ? 'a' : 'b';
          else if (T && (T.a || T.b)) key = T.a ? 'a' : 'b';
          else { var cx = S.cal && S.cal.ctr ? S.cal.ctr.x : W / 2; key = c.x < cx ? 'a' : 'b'; }
          // plausibility: the identity whose roll reads nearest the reference (the wrong hand's neutral is ~180 off)
          var rk = oneRaw(c, key), other = key === 'a' ? 'b' : 'a', ro = S.neutral[other] ? oneRaw(c, other) : null;
          if (ro != null && Math.abs(wrap180(rk - ref)) > 90 && Math.abs(wrap180(ro - ref)) < Math.abs(wrap180(rk - ref))) { key = other; rk = ro; }
          if (key === 'a') a = c; else b = c;
          var n = S.neutral[key];
          if (!n) n = S.neutral[key] = { a: c.roll.a - S.angle, b: c.roll.b - S.angle, learnt: false };
          S.guessed = !n.learnt;
          raw = oneRaw(c, key);
          mode = 'one'; S.flipT = 0;
          conf = c.score * 0.8;
          S.size = c.size;
        }
        var nt = { a: T && T.a, b: T && T.b };
        if (a) nt.a = { x: a.x, y: a.y, t: t };
        if (b) nt.b = { x: b.x, y: b.y, t: t };
        S.tracks = nt;
        if (mode === 'two') {
          // remember each hand's roll at this angle: the neutral used if that hand is later alone
          var rr = wrap180(raw);
          S.neutral.a = { a: a.roll.a - rr, b: a.roll.b - rr, learnt: true };
          S.neutral.b = { a: b.roll.a - rr, b: b.roll.b - rr, learnt: true };
        }
        // continuity across the 360 wrap (within one source); a new source is unwrapped next to the current angle
        var switched = mode !== prevMode;
        if (S._flipped) S._flipped = false;
        else if (switched || S._raw == null) { var rf = prevMode ? S.angle : 0; raw = rf + wrap180(raw - rf); }
        else raw = S._raw + wrap180(raw - S._raw);
        S._raw = raw;
        // re-base: the new source starts exactly where the wheel is now (the readings were chosen nearest the
        // current angle, so this is a small residual < 90 deg, never a half or whole turn)
        if (switched && prevMode !== null) S.offset = S.angle - raw;
        if (mode === 'two') S.guessed = false;
        S.mode = mode;
        // the re-base offset bleeds back to zero (two hands: absolute angle; one hand: its neutral)
        if (S.offset !== 0 && dt > 0) { var k = Math.exp(-dt / (rebaseMs / 1000 / 3)); S.offset *= k; if (Math.abs(S.offset) < 0.05) S.offset = 0; }
        S.angle = raw + S.offset;
        S.curls = [a ? a.curl : null, b ? b.curl : null];
        return {
          ok: true, angle: S.angle, period: 360, conf: conf, mode: mode, fresh: fresh,
          pts: [a, b].map(function (cc, i) { return cc && ptOf(cc, i ? 'b' : 'a'); }).filter(Boolean), W: W, H: H,
          hands: cand
        };
      },
      /** the current pose is straight ahead (two hands: the line between them; one hand: its roll) */
      calibrate: function () {
        var T = S.tracks;
        if (!T) return false;
        S.cal = S.cal || { two: 0 };
        if (S.mode === 'two') {
          var two = wrap180(num(S.cal.two, 0) + S.angle);
          // straight ahead = hands roughly level: a calibration reading > 90 deg means the identity is swapped
          if (Math.abs(two) > 90) { two = wrap180(two + 180); swapIds(); }
          S.cal.two = two;
          T = S.tracks;
          S.cal.ctr = T.a && T.b ? { x: (T.a.x + T.b.x) / 2, y: (T.a.y + T.b.y) / 2 } : S.cal.ctr;
        }
        else if (S.mode === 'one') { var key = T.a ? 'a' : 'b', n = S.neutral[key]; if (n) { n.a += S.angle; n.b += S.angle; } }
        else if (S.mode === 'top' && S._top) {
          // one hand at 12 o'clock: the wheel's top point, its size (-> radius) and depth, its roll, which hand it is
          var c = S._top.c, Wt = S._top.W, Ht = S._top.H;
          S.topCal = { x: c.x / Wt, y: c.y / Ht, L: c.size / Wt, q: (S.qs || c.scale) / Wt, side: S._top.side, roll0: { a: c.roll.a, b: c.roll.b } };
          S.rim = null;
        }
        S.baseSize = S.size || S.baseSize;
        S._raw = null; S.offset = 0; S.angle = 0; S.flipT = 0;
        return true;
      },
      reset: function () { S.tracks = null; S.mode = null; S._raw = null; S.offset = 0; S.angle = 0; S.seenT = null; S.flipT = 0; S.rim = null; S.qs = null; S.stillT = 0; },
      state: function () { return { mode: S.mode, angle: S.angle, offset: S.offset, cal: S.cal, neutral: S.neutral }; }
    };
    function dist(c, p) { return Math.hypot(c.x - p.x, c.y - p.y); }
    function ptOf(c, id) { return { id: id, x: c.x, y: c.y, size: c.size, scale: c.scale, world: c.world, curl: c.curl, open: c.open, nExt: c.nExt, face: c.face, ps: c.ps, psWorld: c.psWorld, cut: c.cut, asp: c.asp }; }
    function implaus(r) { return 0.25 * Math.max(0, Math.abs(wrap180(r)) - 90); }

    /* ---- one-hand top grip ----------------------------------------------------------------------------------------
       The hand grips an imaginary wheel's rim; the wheel centre is a fixed point (rim.cx, cy) and the steering angle is
       the palm centre's angle around it, from 12 o'clock (clockwise as the player sees it = +), plus rollMix of the
       hand's own roll (gripping the rim, the hand turns with it; this keeps a mostly-translating or a mostly-rolling
       hand working). Depth: the hand's apparent scale (handScale) against the rim's reference scale maps the palm
       position back to the reference depth (about the image centre), so pulling the hand back (= the brake) does not
       steer. rim.kind 'top': from the calibration (or, never calibrated, the hand where it first appears): the top
       point (tx, ty), centre straight below it by R = TOP_K x palm length x wheelSize. rim.kind 'rim' (style 'auto',
       two hands -> one): the two-hand wheel itself (centre between the palms, radius half their span), so the hand
       left on the rim carries on from the current angle. */
    function topStep(cand, W, H, t, dt, fresh, T, prevMode, tracked) {
      var c = pickTop(cand, T, W, H);
      var q = c.scale > 0 ? c.scale : 1;
      var entering = prevMode !== 'top' || !S.rim;
      // which hand: a running vote of the per-frame geometry (one odd frame - a flipped detection - cannot flip it)
      var ch = chirality(c.h), v = Math.abs(ch) >= 0.08 ? ch : c.h.label === 'Right' ? 0.1 : c.h.label === 'Left' ? -0.1 : 0;
      S.sideAcc = entering || S.sideAcc == null ? v : clamp(S.sideAcc * 0.97 + v, -6, 6);
      var side = S.sideAcc > 0 ? 'R' : S.sideAcc < 0 ? 'L' : handSide(c.h, W);
      S.qs = entering || S.qs == null ? q : S.qs + (q - S.qs) * (1 - Math.exp(-dt / 0.08));
      if (entering) S.rim = makeRim(c, W, H, prevMode, tracked, side);
      var rim = S.rim, O = { x: W / 2, y: H / 2 };
      rim.side = side;
      var k0 = rim.q0 / S.qs, pr = { x: O.x + (c.x - O.x) * k0, y: O.y + (c.y - O.y) * k0 };
      var geo = rimGeo(rim), rd = readRim(rim, geo, pr, c);
      // first sight: a plausible reading near the top only (else the player moved: the wheel re-anchors under the hand)
      if (entering && rim.kind === 'top' && !tracked && Math.abs(wrap180(rd.angle)) > 100) { rim.tx = pr.x; rim.ty = pr.y; rim.roll0 = { a: c.roll.a, b: c.roll.b }; rim.rollAng = 0; rim.off = 0; geo = rimGeo(rim); rd = readRim(rim, geo, pr, c); }
      var raw = rd.angle, switched = prevMode !== 'top';
      if (switched || S._raw == null) { var rf = prevMode ? S.angle : 0; raw = rf + wrap180(raw - rf); }
      else raw = S._raw + wrap180(raw - S._raw);
      // the centre follows the player slowly (leaning in the seat), only while the wheel is held straight and still
      var vel = dt > 0 && S._raw != null && !switched ? Math.abs(raw - S._raw) / dt : 999;
      S._raw = raw;
      if (switched && prevMode !== null) S.offset = S.angle - raw;
      S.mode = 'top'; S.flipT = 0;
      if (S.offset !== 0 && dt > 0) { var kb = Math.exp(-dt / (rebaseMs / 1000 / 3)); S.offset *= kb; if (Math.abs(S.offset) < 0.05) S.offset = 0; }
      S.angle = raw + S.offset;
      if (rim.kind === 'top' && Math.abs(S.angle) < 4 && vel < 12) {
        S.stillT += dt;
        if (S.stillT > 1) { var kd = 1 - Math.exp(-dt / 4); rim.tx += (pr.x - rim.tx) * kd; rim.ty += (pr.y - rim.ty) * kd; }
      } else S.stillT = 0;
      var id = rim.side === 'L' ? 'a' : 'b';
      S.tracks = { a: id === 'a' ? { x: c.x, y: c.y, t: t } : null, b: id === 'b' ? { x: c.x, y: c.y, t: t } : null, top: { x: c.x, y: c.y, t: t } };
      S._top = { c: c, side: rim.side, W: W, H: H };
      S.size = c.size;
      S.curls = id === 'a' ? [c.curl, null] : [null, c.curl];
      // the rim in the current image (for the preview): the reference-depth wheel scaled back to the hand's depth
      var f = S.qs / rim.q0, ci = { x: O.x + (geo.cx - O.x) * f, y: O.y + (geo.cy - O.y) * f }, ri = geo.R * f, th = rd.pos * DEG;
      return {
        ok: true, angle: S.angle, period: 360, conf: c.score * 0.85, mode: 'top', fresh: fresh, side: rim.side,
        pts: [ptOf(c, id)], W: W, H: H,
        rim: { cx: ci.x, cy: ci.y, r: ri, gx: ci.x + Math.sin(th) * ri, gy: ci.y - Math.cos(th) * ri, kind: rim.kind, side: rim.side },
        hands: cand
      };
    }
    function pickTop(cand, T, W, H) {
      if (cand.length === 1) return cand[0];
      if (T && T.top) { var best = null, bd = Infinity; cand.forEach(function (c) { var d = dist(c, T.top); if (d < bd) { bd = d; best = c; } }); return best; }
      var want = S.topCal && S.topCal.side;
      if (want) { var m = cand.filter(function (c) { return handSide(c.h, W) === want; }); if (m.length === 1) return m[0]; }
      return cand.slice().sort(function (p, q) { return p.y - q.y; })[0];     // the higher hand (the one on top)
    }
    function makeRim(c, W, H, prevMode, tracked, side) {
      if (prevMode === 'two' && tracked && S.lastTwo) {
        var A = S.lastTwo.a, Bh = S.lastTwo.b, cx = (A.x + Bh.x) / 2, cy = (A.y + Bh.y) / 2, R = Math.max(10, Math.hypot(Bh.x - A.x, Bh.y - A.y) / 2);
        var th = Math.atan2(c.x - cx, cy - c.y) / DEG;
        return { kind: 'rim', cx: cx, cy: cy, R: R, q0: S.qs, off: S.angle - th, roll0: { a: c.roll.a, b: c.roll.b }, rollAng: S.angle, side: side };
      }
      var tc = S.topCal;
      if (tc) return { kind: 'top', tx: tc.x * W, ty: tc.y * H, L: tc.L * W, q0: tc.q * W, off: 0, roll0: { a: tc.roll0.a, b: tc.roll0.b }, rollAng: 0, side: side };
      // never calibrated: the hand is at the top where it first appears
      return { kind: 'top', tx: c.x, ty: c.y, L: c.size, q0: S.qs, off: 0, roll0: { a: c.roll.a, b: c.roll.b }, rollAng: 0, side: side, guess: true };
    }
    function rimGeo(rim) {
      if (rim.kind !== 'top') return { cx: rim.cx, cy: rim.cy, R: rim.R };
      var R = Math.max(10, TOP_K * rim.L * clamp(num(S.wheelSize, 1), 0.3, 3));
      return { cx: rim.tx, cy: rim.ty + R, R: R };
    }
    function readRim(rim, geo, pr, c) {
      var pos = Math.atan2(pr.x - geo.cx, geo.cy - pr.y) / DEG, posR = pos + rim.off;
      var da = wrap180(c.roll.a - rim.roll0.a), db = wrap180(c.roll.b - rim.roll0.b);
      var dr = Math.abs(wrap180(da - db)) < 40 ? da + wrap180(db - da) / 2 : da;
      var rollR = rim.rollAng + dr, d = wrap180(rollR - posR);
      // the roll disagrees wildly (another hand, a flipped detection): re-base it on the position, it then adds nothing
      if (Math.abs(d) > 60) { rim.roll0 = { a: c.roll.a, b: c.roll.b }; rim.rollAng = posR; d = 0; }
      return { angle: posR + rollMix * d, pos: pos };
    }
    // one hand's roll relative to the neutral of identity `key` (index->pinky line and wrist->middle MCP, averaged)
    function oneRaw(c, key) {
      var n = S.neutral[key];
      if (!n) return 0;
      var da = wrap180(c.roll.a - n.a), db = wrap180(c.roll.b - n.b);
      // the two estimates agree for a rigid hand; a mean of both halves the noise
      return Math.abs(wrap180(da - db)) < 40 ? da + wrap180(db - da) / 2 : da;
    }
    function swapIds() {
      var T = S.tracks; if (T) S.tracks = { a: T.b, b: T.a };
      var na = S.neutral.a; S.neutral.a = S.neutral.b; S.neutral.b = na;
      if (S.cal && S.cal.labels) S.cal.labels = { a: S.cal.labels.b, b: S.cal.labels.a };
    }
    return S;
  }

  /* ================================================================ optional gestures (off by default) */
  /**
   * prefs.gestureThrottle: both fists closed -> full throttle, open palms -> coast (0).
   * prefs.gestureNitro: a quick push towards the camera (hands >= 18 % bigger than ~0.4 s ago) -> nitro for 1 s.
   * st: persistent state object owned by the caller.
   */
  function gestures(meas, prefs, t, st) {
    var out = { throttle: null, nitro: false };
    if (!meas || !meas.ok) { st.hist = []; return out; }
    prefs = prefs || {};
    if (prefs.gestureThrottle) {
      var cs = meas.pts.map(function (p) { return p.curl; }).filter(function (c) { return c != null; });
      var fist = cs.length && cs.every(function (c) { return c > 0.62; });
      var open = cs.length && cs.every(function (c) { return c < 0.38; });
      if (fist) st.thr = 1; else if (open) st.thr = 0;           // in between: keep (hysteresis)
      out.throttle = st.thr || 0;
    }
    if (prefs.gestureNitro) {
      var size = meas.pts.reduce(function (s, p) { return s + p.size; }, 0) / Math.max(1, meas.pts.length);
      st.hist = (st.hist || []).filter(function (h) { return t - h.t <= 450; });
      var old = st.hist.length ? st.hist[0] : null;
      if (old && t - old.t >= 150 && size > old.s * 1.18 && !(st.nitroUntil > t)) st.nitroUntil = t + 1000;
      st.hist.push({ t: t, s: size });
      out.nitro = st.nitroUntil > t;
    }
    return out;
  }

  /* ================================================================ hands-only pedals (throttle / brake / handbrake) */
  /*
   * createPedals(opts?) -> P   P.update(meas, t, prefs) -> out   P.read(t, mode, car?) -> out (lost hands + reverse applied)
   *   out {throttle 0..1, brake 0..1, handbrake, item (one-shot), gas (normalised grip 0..1+), pull (scale / neutral),
   *        open (the hands' openness 0..1), hand: 'closed'|'mid'|'open'|null, reverse (bool, read() with a car status),
   *        state:'gas'|'coast'|'brake'|'reverse'|'lost'|'off', ok}
   *   P.calibrateNeutral(meas, {curl}) (hands at 9 and 3: the pull-back neutral size per hand, + the open curl)
   *   P.calibrateGrip(meas) (a firm grip: the full-grip curl, for 'grip')   P.calibrateFist(meas) / P.calibrateOpen(meas)
   *   (the Start flow's "make fists" / "open your hands" tests: the player's own closed / open readings)   P.cal / P.setCal(c)
   * prefs.pedals:
   *   'fist' (default)  "Fist = go, open hand = brake". Closed hand(s) = gas (full once clearly closed, a short ramp near
   *                     the threshold), clearly OPEN hands (fingers extended) = brake, in between = coast. Two hands
   *                     (meas.mode 'two'): the brake needs BOTH hands open; one hand on the rim of a two-hand wheel never
   *                     brakes; the one-hand top grip (mode 'top'): that hand. A closed hand ALWAYS wins: whenever any hand
   *                     reads closed there is no brake that frame, whatever else happens. Measured by finger extension
   *                     (openness(): 3D joint ratios, the same whatever the hand's rotation, roll or distance), with
   *                     hysteresis bands and a persistence time: gas after gasMs (60 ms), brake after brakeMs (130 ms).
   *                     Reverse (read() with the car status): stopped (< 0.8 m/s) with the hands open: the brake holds the
   *                     car at a light 0.3 for revHoldMs, then pushes it to full, and the engine's own standstill rule
   *                     (> 0.3 brake for 0.4 s) selects reverse ~0.8 s after the stop; in reverse open hands back up
   *                     (brake = reverse drive, revDrive), closed hands = gas, which brakes and selects 1st again. Never
   *                     while moving (the engine only reverses below 0.8 m/s, and the hold keeps the brake under its rule).
   *   'auto'            gas on its own; open hands (same rule) = brake; reverse the same way
   *   'grip'            (old default, Advanced) closed hands = gas, proportional to the curl between the calibrated open and
   *                     full-grip samples; pull both hands back (>= 14 % smaller) = brake, overriding the gas
   *   'push'            push both hands towards the screen (>= 10 % bigger) = gas, pull back = brake
   *   'off'             pedals stay on the keyboard / gamepad
   * prefs.pullBrake (opt-in, off): the pull-back brake on top of 'fist' / 'auto' (always on for 'grip' / 'push'). The size is
   * pullScale (3D, rotation-invariant), and the pull is IGNORED while the wheel is turned > pullMaxTurn (30 deg), while a
   * hand is rolled / tilted (facing() < pullFace, ~28 deg, or its palm's 2D width / length off the neutral pose's by > 15 %)
   * or near the frame edge (palm centre within 7 % of it): there a
   * hand looks smaller without being pulled back. The neutral follows only slow changes while straight and near neutral.
   * Lost hands: the last output is held 150 ms (one dropped frame changes nothing), then COAST (no gas, no brake), and after
   * 0.5 s a gentle brake (0.3, below the reverse rule). Never stuck on gas: read(t) applies this even if no new camera
   * result arrives at all.
   * prefs.gestureHandbrake: a quick downward yank of both hands = handbrake for 0.4 s.  prefs.gestureItem: a quick
   * upward flick of both hands = use item (Arcade). (Steering turns move the two hands in opposite directions, so their
   * mean height, in palm sizes, only moves when both go the same way.)
   */
  var PED = {
    open: 0.3, grip: 0.92, tauCurl: 0.045, tauScale: 0.045,
    gasOn: 0.38, gasOff: 0.22, gasFull: 0.8, openOn: 0.2, openOff: 0.4,
    pullOn: 0.86, pullOff: 0.9, pullFull: 0.72, pushOn: 1.1, pushOff: 1.06, pushFull: 1.3,
    pullMaxTurn: 30, pullFace: 0.88, pullEdge: 0.07, pullAsp: 0.15,
    // 'fist' / 'auto': openness bands (hysteresis) and persistence
    closeOn: 0.35, closeOff: 0.5, closeFull: 0.2, extOn: 0.82, extOff: 0.72, extFull: 0.97,
    gasMs: 60, brakeMs: 130, coastMs: 60, gasMin: 0.7, brakeMin: 0.6,
    revStop: 0.8, revHoldMs: 400, revHold: 0.3, revDrive: 0.7,
    holdMs: 150, lostBrakeMs: 500, lostBrake: 0.3, yank: 5.5, yankMs: 400
  };
  var OPEN_MODES = { fist: true, auto: true };
  function createPedals(opts) {
    var C = Object.assign({}, PED, opts || {});
    var P = {
      C: C, cal: { open: C.open, grip: C.grip, scale: {}, world: null, fist: null, ext: null },
      out: { throttle: 0, brake: 0, handbrake: false, item: false, gas: 0, pull: 1, open: null, hand: null, state: 'off', ok: false },
      asp: {}, aspS: {}, cs: null, rs: null, gasOn: false, brakeOn: false, openOn: false, lastT: null, lastOkT: null, hist: [], hbUntil: 0, yankT: -1e9, last: null,
      hs: {}, cur: 'coast', want: null, wantT: 0, stopT: null,
      setCal: function (c) {
        if (!c || typeof c !== 'object') return;
        if (isFinite(c.open)) P.cal.open = clamp(+c.open, 0, 0.8);
        if (isFinite(c.grip)) P.cal.grip = clamp(+c.grip, P.cal.open + 0.15, 1);
        if (c.scale && typeof c.scale === 'object') { P.cal.scale = {}; ['a', 'b'].forEach(function (k) { if (isFinite(c.scale[k]) && c.scale[k] > 0) P.cal.scale[k] = +c.scale[k]; }); P.cal.world = c.world == null ? null : !!c.world; }
        P.cal.fist = isFinite(c.fist) && c.fist != null ? clamp(+c.fist, 0, 0.5) : null;
        P.cal.ext = isFinite(c.ext) && c.ext != null ? clamp(+c.ext, 0.5, 1) : null;
      },
      /** the current pose is the neutral one (hands at 9 and 3): pull-back size per hand, and (o.curl) the open curl */
      calibrateNeutral: function (meas, o) {
        meas = meas || P.last;
        if (!meas || !meas.ok || !meas.pts || !meas.pts.length) return { ok: false };
        var sc = {};
        meas.pts.forEach(function (p) { var s = psOf(p); if (p.id && s > 0) sc[p.id] = s; });
        if (meas.pts.length === 1 && psOf(meas.pts[0]) > 0) { var k = meas.pts[0].id === 'b' ? 'a' : 'b'; sc[k] = P.cal.scale[k] > 0 && P.cal.world === pwOf(meas.pts[0]) ? P.cal.scale[k] : psOf(meas.pts[0]); }
        P.cal.scale = sc; P.cal.world = pwOf(meas.pts[0]);
        P.asp = {}; meas.pts.forEach(function (p) { if (p.id && p.asp > 0) P.asp[p.id] = p.asp; });
        var c = meanCurl(meas), took = false;
        if (o && o.curl && c != null && c < Math.min(0.6, P.cal.grip - 0.2)) { P.cal.open = c; took = true; }
        P.rs = null; P.brakeOn = false;
        return { ok: true, open: took ? c : null };
      },
      /** a firm grip: the full-grip curl (must be clearly more closed than the open sample) */
      calibrateGrip: function (meas) {
        meas = meas || P.last;
        var c = meanCurl(meas);
        if (c == null) return { ok: false, reason: 'nohands' };
        if (c < P.cal.open + 0.2) return { ok: false, reason: 'open', curl: c };
        P.cal.grip = clamp(c, P.cal.open + 0.2, 1); P.cs = null;
        return { ok: true, grip: P.cal.grip };
      },
      /** "make fists": the player's closed reading (the most open hand). Only a clearly closed reading is taken. */
      calibrateFist: function (meas) {
        var o = maxOpen(meas || P.last);
        if (o == null) return { ok: false, reason: 'nohands' };
        if (o > 0.45) return { ok: false, reason: 'open', open: o };
        P.cal.fist = o; return { ok: true, fist: o };
      },
      /** "open your hands": the player's open reading (the least open hand); must be well above the fist */
      calibrateOpen: function (meas) {
        var o = minOpen(meas || P.last);
        if (o == null) return { ok: false, reason: 'nohands' };
        if (o < 0.75 || (P.cal.fist != null && o < P.cal.fist + 0.5)) return { ok: false, reason: 'closed', open: o };
        P.cal.ext = o; return { ok: true, ext: o };
      },
      /** the openness bands in use: the defaults, nudged (within limits) by the player's own fist / open readings */
      bands: function () {
        var f = P.cal.fist, e = P.cal.ext, on = C.closeOn, off = C.closeOff, eOn = C.extOn, eOff = C.extOff;
        if (f != null && e != null && e - f >= 0.4) {
          on = clamp(f + 0.35 * (e - f), 0.25, 0.42); off = on + 0.15;
          eOn = clamp(f + 0.85 * (e - f), 0.75, 0.9); eOff = Math.max(off + 0.05, eOn - 0.1);
        }
        return { closeOn: on, closeOff: off, extOn: eOn, extOff: eOff };
      },
      update: function (meas, t, prefs) {
        t = num(t, nowMs()); prefs = prefs || {};
        var mode = prefs.pedals || 'fist';
        if (!meas || !meas.ok || !meas.pts || !meas.pts.length) { P.hist.length = 0; return P.read(t, mode); }
        P.last = meas;
        var gap = P.lastOkT == null ? Infinity : t - P.lastOkT;
        var dt = P.lastT == null || gap > C.holdMs ? 0 : clamp((t - P.lastT) / 1000, 0, 0.25);
        P.lastT = t; P.lastOkT = t;
        if (gap > C.holdMs) { P.cs = null; P.rs = null; P.gasOn = false; P.brakeOn = false; P.openOn = false; P.hs = {}; P.cur = 'coast'; P.want = null; }
        var o = P.out = { throttle: 0, brake: 0, handbrake: false, item: false, gas: 0, pull: 1, open: null, hand: null, state: 'coast', ok: true };
        if (mode === 'off') { o.state = 'off'; yanks(meas, t, prefs, o); return o; }
        // grip: curl normalised between the open and the full-grip samples, smoothed (the 'grip' mode's gas)
        var c = meanCurl(meas), n = c == null ? 0 : (c - P.cal.open) / Math.max(0.15, P.cal.grip - P.cal.open);
        n = clamp(n, -0.5, 1.5);
        P.cs = P.cs == null || dt === 0 ? n : P.cs + (n - P.cs) * (1 - Math.exp(-dt / C.tauCurl));
        o.gas = P.cs;
        // distance: rotation-invariant size against each hand's neutral (only when the neutral was taken the same way),
        // not trusted while turned / rolled / at the frame edge
        var usePull = mode === 'grip' || mode === 'push' || (OPEN_MODES[mode] && !!prefs.pullBrake);
        var rs = usePull ? ratio(meas) : null, trust = rs != null && pullTrusted(meas);
        if (rs != null) { P.rs = P.rs == null || dt === 0 ? rs : P.rs + (rs - P.rs) * (1 - Math.exp(-dt / C.tauScale)); }
        else P.rs = null;
        var r = P.rs;
        o.pull = r == null ? 1 : r;
        if (r != null && trust) { if (!P.brakeOn && r < C.pullOn) P.brakeOn = true; else if (P.brakeOn && r > C.pullOff) P.brakeOn = false; }
        else P.brakeOn = false;
        var brk = P.brakeOn ? clamp((C.pullOff - r) / (C.pullOff - C.pullFull), 0.35, 1) : 0;
        var thr = 0;
        if (OPEN_MODES[mode]) {
          var hd = handsState(meas, t, mode);
          o.open = hd.open; o.hand = hd.hand;
          if (mode === 'auto') thr = hd.state === 'brake' ? 0 : 1;
          else thr = hd.state === 'gas' ? hd.thr : 0;
          if (hd.state === 'brake') brk = Math.max(brk, hd.brk);
          o.byOpen = hd.state === 'brake';
          if (hd.closed && !(usePull && P.brakeOn)) brk = 0;     // grip wins: a closed hand never brakes
        } else if (mode === 'push') {
          if (r != null) { if (!P.gasOn && r > C.pushOn) P.gasOn = true; else if (P.gasOn && r < C.pushOff) P.gasOn = false; } else P.gasOn = false;
          thr = P.gasOn ? clamp((r - C.pushOff) / (C.pushFull - C.pushOff), 0.2, 1) : 0;
        } else {
          if (!P.gasOn && P.cs > C.gasOn) P.gasOn = true; else if (P.gasOn && P.cs < C.gasOff) P.gasOn = false;
          thr = P.gasOn ? clamp((P.cs - C.gasOff) / (C.gasFull - C.gasOff), 0.15, 1) : 0;
        }
        if (brk > 0) thr = 0;                                  // a brake (open hands, or the opt-in pull) beats the gas
        o.throttle = thr; o.brake = brk;
        o.state = brk > 0 ? 'brake' : thr > 0 ? 'gas' : 'coast';
        if (trust) adapt(meas, r, dt, mode);
        yanks(meas, t, prefs, o);
        return o;
      },
      /** the output for time t: held 150 ms after the last hands, then coast; a gentle brake after 0.5 s.
          car {speed (m/s), gear, driving}: the reverse shaping for 'fist' / 'auto' (see above) */
      read: function (t, mode, car) {
        t = num(t, nowMs());
        var age = P.lastOkT == null ? Infinity : t - P.lastOkT;
        var h;
        if (P.out.ok && age <= C.holdMs) { h = Object.assign({}, P.out); if (t > P.hbUntil) h.handbrake = false; }
        else {
          P.gasOn = false; P.openOn = false; P.stopT = null;
          var off = (mode || '') === 'off';
          h = { throttle: 0, brake: !off && P.lastOkT != null && age > C.lostBrakeMs ? C.lostBrake : 0, handbrake: false, item: false, gas: 0, pull: 1, open: null, hand: null, state: P.lastOkT == null ? 'off' : 'lost', ok: false };
        }
        return reverse(h, t, mode || 'fist', car);
      },
      reset: function () { P.cs = P.rs = null; P.gasOn = P.brakeOn = P.openOn = false; P.lastT = P.lastOkT = null; P.hs = {}; P.cur = 'coast'; P.want = null; P.stopT = null; P.out = { throttle: 0, brake: 0, handbrake: false, item: false, gas: 0, pull: 1, open: null, hand: null, state: 'off', ok: false }; P.hist.length = 0; }
    };
    function psOf(p) { return p.ps > 0 ? p.ps : p.scale; }
    function pwOf(p) { return p.ps > 0 ? !!p.psWorld : !!p.world; }
    function opens(meas) { return meas && meas.ok && meas.pts ? meas.pts.map(function (p) { return p.open; }).filter(function (v) { return v != null && isFinite(v); }) : []; }
    function maxOpen(meas) { var a = opens(meas); return a.length ? Math.max.apply(null, a) : null; }
    function minOpen(meas) { var a = opens(meas); return a.length ? Math.min.apply(null, a) : null; }
    /* 'fist' / 'auto': each hand closed / mid / open (hysteresis per hand), then the hands' joint wish (closed anywhere =
       gas; all the hands that count open = brake; else coast), then persistence before the output follows it */
    function handsState(meas, t, mode) {
      var B = P.bands(), pts = meas.pts, anyClosed = false, nOpen = 0, minO = 1, maxO = 0, k;
      var seen = {};
      for (k = 0; k < pts.length; k++) {
        var p = pts[k], v = p.open, id = p.id || 'a';
        if (v == null || !isFinite(v)) { P.hs[id] = 'mid'; continue; }
        seen[id] = true;
        var s = P.hs[id] || 'mid';
        // partly out of the frame: its fingers are a guess, so it can still read closed but never open
        if (p.cut >= 1 && v > B.closeOn) { P.hs[id] = 'mid'; minO = Math.min(minO, v); maxO = Math.max(maxO, v); continue; }
        if (s === 'closed') { if (v > B.closeOff) s = v > B.extOn ? 'open' : 'mid'; }
        else if (s === 'open') { if (v < B.extOff) s = v < B.closeOn ? 'closed' : 'mid'; }
        else if (v < B.closeOn) s = 'closed'; else if (v > B.extOn) s = 'open';
        P.hs[id] = s;
        if (s === 'closed') anyClosed = true;
        if (s === 'open') nOpen++;
        minO = Math.min(minO, v); maxO = Math.max(maxO, v);
      }
      Object.keys(P.hs).forEach(function (id) { if (!seen[id]) delete P.hs[id]; });
      // which hands must be open for the brake: two hands on the wheel -> both; the one-hand top grip -> that hand;
      // one hand left on a two-hand wheel -> never (taking a hand off is not a brake)
      var need = meas.mode === 'two' ? 2 : meas.mode === 'top' ? 1 : 99;
      var want = anyClosed ? 'gas' : nOpen >= need && nOpen === pts.length ? 'brake' : 'coast';
      if (want !== P.want) { P.want = want; P.wantT = t; }
      var hold = want === 'gas' ? C.gasMs : want === 'brake' ? C.brakeMs : C.coastMs;
      if (want !== P.cur && t - P.wantT >= hold - 1e-6) P.cur = want;
      var st = P.cur;
      if (anyClosed && st === 'brake') st = P.cur = 'coast';            // grip wins at once (the gas follows after gasMs)
      var thr = 0, brk = 0;
      if (st === 'gas') {
        var cl = pts.map(function (p) { return p.open; }).filter(function (v, i) { return v != null && P.hs[pts[i].id || 'a'] === 'closed'; });
        var oc = cl.length ? Math.min.apply(null, cl) : minO;
        thr = C.gasMin + (1 - C.gasMin) * clamp((B.closeOn - oc) / Math.max(0.05, B.closeOn - C.closeFull), 0, 1);
      }
      if (st === 'brake') brk = C.brakeMin + (1 - C.brakeMin) * clamp((minO - B.extOn) / Math.max(0.05, C.extFull - B.extOn), 0, 1);
      var hand = anyClosed ? 'closed' : nOpen && nOpen === pts.length ? 'open' : 'mid';
      return { state: st, thr: thr, brk: brk, closed: anyClosed, open: pts.length ? (anyClosed ? Math.min(minO, maxO) : minO) : null, hand: hand };
    }
    /* reverse: see the header. h: the output for this read; car {speed, gear, driving} (CB.input.hub.status()) */
    function reverse(h, t, mode, car) {
      h.reverse = !!(car && car.driving && car.gear < 0);
      if (!OPEN_MODES[mode] || !car || !car.driving || !isFinite(car.speed)) { P.stopT = null; return h; }
      var openBrake = h.ok && h.state === 'brake' && P.out.byOpen;
      if (car.gear < 0) {
        P.stopT = null;
        if (openBrake) { h.brake = C.revDrive; h.throttle = 0; h.state = 'reverse'; }
        return h;
      }
      if (openBrake && Math.abs(car.speed) < C.revStop) {
        if (P.stopT == null) P.stopT = t;
        if (t - P.stopT < C.revHoldMs) h.brake = Math.min(h.brake, C.revHold);      // hold the car, below the reverse rule
        else h.brake = 1;                                                          // -> the engine selects reverse in 0.4 s
      } else P.stopT = null;
      return h;
    }
    function meanCurl(meas) {
      if (!meas || !meas.ok || !meas.pts) return null;
      var cs = meas.pts.map(function (p) { return p.curl; }).filter(function (c) { return c != null && isFinite(c); });
      return cs.length ? cs.reduce(function (a, c) { return a + c; }, 0) / cs.length : null;
    }
    function ratio(meas) {
      var s = 0, n = 0, sc = P.cal.scale;
      meas.pts.forEach(function (p) {
        var b = sc[p.id || 'a'], v = psOf(p);
        if (b > 0 && v > 0 && (P.cal.world == null || pwOf(p) === P.cal.world)) { s += v / b; n++; }
      });
      return n ? s / n : null;
    }
    /* the pull-back size is only meaningful with the wheel near straight, the palms square to the camera and away from the
       frame edges (lens distortion, a clipped hand) */
    function pullTrusted(meas) {
      if (meas.mode !== 'top' && Math.abs(num(meas.angle, 0)) > C.pullMaxTurn) return false;
      var Wf = meas.W, Hf = meas.H;
      return meas.pts.every(function (p) {
        if (p.face != null && p.face < C.pullFace) return false;
        var id = p.id || 'a', a0 = P.asp[id];
        if (p.asp > 0) P.aspS[id] = P.aspS[id] > 0 ? P.aspS[id] + (p.asp - P.aspS[id]) * 0.35 : p.asp;   // a few frames' mean (jitter)
        if (a0 > 0 && P.aspS[id] > 0 && Math.abs(Math.log(P.aspS[id] / a0)) > C.pullAsp) return false;
        if (Wf && Hf && (p.x < Wf * C.pullEdge || p.x > Wf * (1 - C.pullEdge) || p.y < Hf * C.pullEdge || p.y > Hf * (1 - C.pullEdge))) return false;
        return true;
      });
    }
    // the neutral size follows slow changes (leaning in the seat): only while near neutral and trusted, never while braking
    function adapt(meas, r, dt, mode) {
      if (r == null || dt <= 0 || P.brakeOn) return;
      var tau = 0;
      if (mode === 'push') { if (r > 0.96 && r < 1.04) tau = 20; }
      else if (r > 0.93 && r < 1.1) tau = 15;
      if (!tau) return;
      var k = 1 - Math.exp(-dt / tau);
      meas.pts.forEach(function (p) { var b = P.cal.scale[p.id || 'a'], v = psOf(p); if (b > 0 && v > 0) P.cal.scale[p.id || 'a'] = b + (v - b) * k; });
    }
    function yanks(meas, t, prefs, o) {
      if (t <= P.hbUntil) o.handbrake = true;
      if (!(prefs.gestureHandbrake || prefs.gestureItem) || meas.mode !== 'two' || meas.pts.length < 2) { P.hist.length = 0; return; }
      var size = (meas.pts[0].size + meas.pts[1].size) / 2 || 1, y = (meas.pts[0].y + meas.pts[1].y) / 2 / size;
      P.hist.push({ t: t, y: y });
      while (P.hist.length && t - P.hist[0].t > 200) P.hist.shift();
      var h0 = P.hist[0];
      if (!h0 || t - h0.t < 90 || t - P.yankT < 700) return;
      var vy = (y - h0.y) / ((t - h0.t) / 1000);            // palm sizes per second, + = down
      if (vy > C.yank && prefs.gestureHandbrake) { P.hbUntil = t + C.yankMs; P.yankT = t; o.handbrake = true; P.hist.length = 0; }
      else if (vy < -C.yank && prefs.gestureItem) { o.item = true; P.yankT = t; P.hist.length = 0; }
    }
    return P;
  }

  /* ================================================================ browser: lazy MediaPipe loader + detector */
  /* Preferred: a Web Worker (js/input/camwheel-worker.js) runs the landmarker off the main thread; each camera frame goes
     over as a transferred ImageBitmap and only the 2 x 21 landmarks come back, so inference never stalls the game.
     Fallback (no Worker / OffscreenCanvas / createImageBitmap, or the worker fails): the landmarker on the main thread. */
  var lib = null, landmarker = null, delegate = null, loading = null, lastTs = -1;
  var worker = null, busy = false, frameId = 0, resultFns = [], sentAt = 0;
  var api = {
    VENDOR: VENDOR, palm: palm, handRoll: handRoll, curl: curl, handScale: handScale, createSolver: createSolver, gestures: gestures,
    handSide: handSide, chirality: chirality, TOP_K: TOP_K, STYLES: ['two', 'top', 'auto'],
    openness: openness, facing: facing, pullScale: pullScale,
    createPedals: createPedals, PEDALS: PED, PEDAL_MODES: ['fist', 'auto', 'grip', 'push', 'off'],
    lastMs: 0, mode: null, loaded: function () { return !!(landmarker || (worker && delegate)); }, delegate: function () { return delegate; }
  };
  function base() {
    var b = typeof document !== 'undefined' && document.baseURI ? document.baseURI : (typeof location !== 'undefined' ? location.href : '');
    return new URL(VENDOR, b).href;
  }
  api.base = base;
  function emitResult(hands, ts, ms) { api.lastMs = ms; resultFns.slice().forEach(function (fn) { try { fn(hands, ts, ms); } catch (e) { if (typeof console !== 'undefined') console.error('[camhands]', e); } }); }
  /** onResult(fn(hands, tsMs, inferMs)) -> off   every detection result, in submit order */
  api.onResult = function (fn) { resultFns.push(fn); return function () { var i = resultFns.indexOf(fn); if (i >= 0) resultFns.splice(i, 1); }; };
  function canWorker() {
    return typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
  }
  function loadWorker(b, gpu) {
    return new Promise(function (res, rej) {
      var w;
      try { w = new Worker(new URL('js/input/camwheel-worker.js?v=' + encodeURIComponent(VENDOR), document.baseURI).href); } catch (e) { rej(e); return; }
      var to = setTimeout(function () { rej(new Error('worker timeout')); try { w.terminate(); } catch (x) { /* ignore */ } }, 30000);
      w.onmessage = function (e) {
        var m = e.data || {};
        if (m.t === 'ready') { clearTimeout(to); worker = w; delegate = m.delegate; api.mode = 'worker'; res({ ok: true, delegate: m.delegate, worker: true }); }
        else if (m.t === 'error') { clearTimeout(to); try { w.terminate(); } catch (x) { /* ignore */ } rej(new Error(m.error)); }
        else if (m.t === 'res') { busy = false; emitResult(m.hands, m.ts, m.ms); }
      };
      w.onerror = function (e) { clearTimeout(to); rej(new Error(e && e.message || 'worker error')); };
      w.postMessage({ t: 'init', base: b, gpu: gpu, det: api.det, pres: api.pres });
    });
  }
  function loadMain(b, gpu) {
    return import(b + 'vision_bundle.mjs').then(function (mod) {
      lib = mod;
      var files = { wasmLoaderPath: b + 'wasm/vision_wasm_internal.js', wasmBinaryPath: b + 'wasm/vision_wasm_internal.wasm' };
      function make(dg) {
        return lib.HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: b + 'hand_landmarker.task', delegate: dg },
          runningMode: 'VIDEO', numHands: 2,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5
        }).then(function (h) { landmarker = h; delegate = dg; api.mode = 'main'; return { ok: true, delegate: dg, worker: false }; });
      }
      return (gpu === false ? Promise.reject(new Error('cpu')) : make('GPU')).catch(function () { return make('CPU'); }).then(function (r) {
        try { var c = document.createElement('canvas'); c.width = 256; c.height = 192; var g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 256, 192); detectSync(c, nowMs()); } catch (e) { /* warm-up only */ }
        return r;
      });
    });
  }
  /** load the vendored MediaPipe bundle + model (once): worker first, then the main thread; GPU first, then CPU */
  api.load = function (o) {
    o = o || {};
    if (api.loaded()) return Promise.resolve({ ok: true, delegate: delegate, worker: !!worker });
    if (loading) return loading;
    if (typeof window === 'undefined') return Promise.resolve({ ok: false, reason: 'unsupported' });
    if (location.protocol === 'file:') return Promise.resolve({ ok: false, reason: 'file' });
    if (typeof WebAssembly !== 'object') return Promise.resolve({ ok: false, reason: 'nowasm' });
    var b = base(), gpu = o.preferGpu !== false;
    var first = o.worker !== false && canWorker() ? loadWorker(b, gpu).catch(function (e) { api.workerError = String(e && e.message || e); return loadMain(b, gpu); }) : loadMain(b, gpu);
    loading = first.catch(function (e) {
      loading = null;
      return { ok: false, reason: 'load', error: String(e && e.message || e) };
    });
    return loading;
  };
  function detectSync(src, tMs) {
    var ts = Math.max(lastTs + 1, Math.round(num(tMs, nowMs())));   // VIDEO mode needs strictly increasing timestamps
    lastTs = ts;
    var t0 = nowMs(), r;
    try { r = landmarker.detectForVideo(src, ts); } catch (e) { api.lastError = String(e && e.message || e); return []; }
    api.lastMs = nowMs() - t0;
    var out = [];
    for (var i = 0; r && r.landmarks && i < r.landmarks.length; i++) {
      var hd = r.handedness && r.handedness[i] && r.handedness[i][0];
      out.push({ lm: r.landmarks[i], wl: r.worldLandmarks && r.worldLandmarks[i] || null, score: hd ? hd.score : 1, label: hd ? hd.categoryName : '' });
    }
    return out;
  }
  /** main-thread detection (sync) -> [{lm, score, label}] | null */
  api.detect = function (src, tMs) { return landmarker ? detectSync(src, tMs) : null; };
  /**
   * submit(video, tMs) -> true if taken. Worker: the frame is copied to an ImageBitmap and inferred off-thread (a frame
   * arriving while the previous one is still being inferred is skipped: newest wins, no queue = no added delay).
   * Main thread: inferred right away. Results arrive through onResult.
   */
  api.submit = function (src, tMs) {
    if (worker) {
      if (busy && nowMs() - sentAt < 500) return false;
      busy = true; sentAt = nowMs();
      var id = ++frameId;
      createImageBitmap(src).then(function (bmp) {
        try { worker.postMessage({ t: 'frame', id: id, ts: tMs, bmp: bmp }, [bmp]); } catch (e) { busy = false; try { bmp.close(); } catch (x) { /* ignore */ } }
      }, function () { busy = false; });
      return true;
    }
    if (!landmarker) return false;
    emitResult(detectSync(src, tMs), tMs, api.lastMs);
    return true;
  };
  api.close = function () {
    try { if (landmarker) landmarker.close(); } catch (e) { /* ignore */ }
    try { if (worker) worker.terminate(); } catch (e) { /* ignore */ }
    landmarker = null; worker = null; loading = null; delegate = null; busy = false; api.mode = null;
  };

  CB.input.camhands = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

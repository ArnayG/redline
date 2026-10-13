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
     switching  two <-> one hand never jumps: the new reading is chosen nearest the current angle and re-based onto
                it (|offset| < 90, never a pi turn), and that offset then bleeds back to the source's own zero over
                ~0.5 s (so a long one-hand stint cannot drift).

     ch.palm(lm, W, H) -> {x, y, size}      size = wrist -> middle-MCP length (px), for push / distance gestures
     ch.handRoll(lm, W, H) -> {a: deg (index->pinky MCP line), b: deg (wrist -> middle MCP)}
     ch.curl(lm, wl?) -> 0 (open palm) .. 1 (closed fist)     wl: world landmarks (metres) when the detector has them
     ch.handScale(lm, wl, W, H) -> {s, world}   palm-only apparent scale (push / pull = distance), tilt-robust with wl
     ch.createPedals() -> P   hands-only throttle / brake / handbrake ('grip' default | 'auto' | 'push' | 'off'), see below
     ch.createSolver(opts?) -> S   S.update(hands, W, H, t) -> meas {ok, angle (deg, continuous), period: 360, conf,
                                   mode:'two'|'one'|null, fresh, pts, hands}   S.calibrate() (current pose = centre)
                                   S.state()   hands: [{lm, score, label}] straight from the detector
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
    var flipDeg = num(opts.flipDeg, 155), flipMs = num(opts.flipMs, 1500);
    var S = {
      mode: null, angle: 0, offset: 0, target: 0, lastT: null, tracks: null, cal: null,
      neutral: {}, curls: [0, 0], sizes: [0, 0], baseSize: 0, flipT: 0,
      /** hands: [{lm, score}]  ->  meas */
      update: function (hands, W, H, t) {
        t = num(t, nowMs());
        var dt = S.lastT == null ? 0 : clamp((t - S.lastT) / 1000, 0, 0.5);
        S.lastT = t;
        hands = (hands || []).filter(function (h) { return h && h.lm && h.lm.length >= 21; });
        var cand = hands.map(function (h) { var p = palm(h.lm, W, H), sc = handScale(h.lm, h.wl, W, H); return { h: h, x: p.x, y: p.y, size: p.size, scale: sc.s, world: sc.world, roll: handRoll(h.lm, W, H), curl: curl(h.lm, h.wl), score: num(h.score, 1) }; });
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
          pts: [a, b].map(function (cc, i) { return cc && { id: i ? 'b' : 'a', x: cc.x, y: cc.y, size: cc.size, scale: cc.scale, world: cc.world, curl: cc.curl }; }).filter(Boolean),
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
        S.baseSize = S.size || S.baseSize;
        S._raw = null; S.offset = 0; S.angle = 0; S.flipT = 0;
        return true;
      },
      reset: function () { S.tracks = null; S.mode = null; S._raw = null; S.offset = 0; S.angle = 0; S.seenT = null; S.flipT = 0; },
      state: function () { return { mode: S.mode, angle: S.angle, offset: S.offset, cal: S.cal, neutral: S.neutral }; }
    };
    function dist(c, p) { return Math.hypot(c.x - p.x, c.y - p.y); }
    function implaus(r) { return 0.25 * Math.max(0, Math.abs(wrap180(r)) - 90); }
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
   * createPedals(opts?) -> P   P.update(meas, t, prefs) -> out   P.read(t) -> out (lost-hands policy applied)
   *   out {throttle 0..1, brake 0..1, handbrake, item (one-shot), gas (normalised grip 0..1+), pull (scale / neutral),
   *        state:'gas'|'coast'|'brake'|'lost'|'off', ok}
   *   P.calibrateNeutral(meas, {curl}) (open hands at 9 and 3: hand scale per hand, + the open curl)
   *   P.calibrateGrip(meas) (a firm grip: the full-grip curl)   P.cal / P.setCal(c)
   * prefs.pedals:
   *   'grip' (default)  closed hands = gas, proportional to how tightly they close (finger curl, normalised between the
   *                     calibrated open and full-grip samples); relaxed / open hands = coast; pull both hands back
   *                     towards you (hands >= 14 % smaller than at the neutral pose) = brake, proportional, and it
   *                     overrides the gas. Held at a standstill the brake reverses (the engine's own rule, as for keys).
   *   'auto'            gas on its own; open your hands (or pull back) = brake
   *   'push'            push both hands towards the screen (>= 10 % bigger) = gas, pull back = brake
   *   'off'             pedals stay on the keyboard / gamepad
   * Each signal: a short exponential smoothing (45-60 ms, about one camera frame at 30 fps) + hysteresis bands, so a
   * value near a threshold never flickers. Lost hands: the last output is held 150 ms (one dropped frame changes
   * nothing), then throttle 0, and after 0.5 s a light brake (0.3). Never stuck on gas: read(t) applies this even if no
   * new camera result arrives at all.
   * prefs.gestureHandbrake: a quick downward yank of both hands = handbrake for 0.4 s.  prefs.gestureItem: a quick
   * upward flick of both hands = use item (Arcade). (Steering turns move the two hands in opposite directions, so their
   * mean height, in palm sizes, only moves when both go the same way.)
   */
  var PED = {
    open: 0.3, grip: 0.92, tauCurl: 0.045, tauScale: 0.045,
    gasOn: 0.38, gasOff: 0.22, gasFull: 0.8, openOn: 0.2, openOff: 0.4,
    pullOn: 0.86, pullOff: 0.9, pullFull: 0.72, pushOn: 1.1, pushOff: 1.06, pushFull: 1.3,
    holdMs: 150, lostBrakeMs: 500, lostBrake: 0.3, yank: 5.5, yankMs: 400
  };
  function createPedals(opts) {
    var C = Object.assign({}, PED, opts || {});
    var P = {
      C: C, cal: { open: C.open, grip: C.grip, scale: {}, world: null },
      out: { throttle: 0, brake: 0, handbrake: false, item: false, gas: 0, pull: 1, state: 'off', ok: false },
      cs: null, rs: null, gasOn: false, brakeOn: false, openOn: false, lastT: null, lastOkT: null, closeT: 0, hist: [], hbUntil: 0, yankT: -1e9, last: null,
      setCal: function (c) {
        if (!c || typeof c !== 'object') return;
        if (isFinite(c.open)) P.cal.open = clamp(+c.open, 0, 0.8);
        if (isFinite(c.grip)) P.cal.grip = clamp(+c.grip, P.cal.open + 0.15, 1);
        if (c.scale && typeof c.scale === 'object') { P.cal.scale = {}; ['a', 'b'].forEach(function (k) { if (isFinite(c.scale[k]) && c.scale[k] > 0) P.cal.scale[k] = +c.scale[k]; }); P.cal.world = c.world == null ? null : !!c.world; }
      },
      /** the current pose is the neutral one (open grip at 9 and 3): hand scale per hand, and (o.curl) the open curl */
      calibrateNeutral: function (meas, o) {
        meas = meas || P.last;
        if (!meas || !meas.ok || !meas.pts || !meas.pts.length) return { ok: false };
        var sc = {};
        meas.pts.forEach(function (p) { if (p.id && p.scale > 0) sc[p.id] = p.scale; });
        if (meas.pts.length === 1 && meas.pts[0].scale > 0) { var k = meas.pts[0].id === 'b' ? 'a' : 'b'; sc[k] = P.cal.scale[k] > 0 && P.cal.world === !!meas.pts[0].world ? P.cal.scale[k] : meas.pts[0].scale; }
        P.cal.scale = sc; P.cal.world = !!meas.pts[0].world;
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
      update: function (meas, t, prefs) {
        t = num(t, nowMs()); prefs = prefs || {};
        var mode = prefs.pedals || 'grip';
        if (!meas || !meas.ok || !meas.pts || !meas.pts.length) { P.hist.length = 0; return P.read(t, mode); }
        P.last = meas;
        var gap = P.lastOkT == null ? Infinity : t - P.lastOkT;
        var dt = P.lastT == null || gap > C.holdMs ? 0 : clamp((t - P.lastT) / 1000, 0, 0.25);
        P.lastT = t; P.lastOkT = t;
        if (gap > C.holdMs) { P.cs = null; P.rs = null; P.gasOn = false; P.brakeOn = false; P.openOn = false; }
        var o = P.out = { throttle: 0, brake: 0, handbrake: false, item: false, gas: 0, pull: 1, state: 'coast', ok: true };
        if (mode === 'off') { o.state = 'off'; yanks(meas, t, prefs, o); return o; }
        // grip: curl normalised between the open and the full-grip samples, smoothed
        var c = meanCurl(meas), n = c == null ? 0 : (c - P.cal.open) / Math.max(0.15, P.cal.grip - P.cal.open);
        n = clamp(n, -0.5, 1.5);
        P.cs = P.cs == null || dt === 0 ? n : P.cs + (n - P.cs) * (1 - Math.exp(-dt / C.tauCurl));
        o.gas = P.cs;
        // distance: scale against each hand's neutral scale (only when the neutral was taken the same way)
        var rs = ratio(meas);
        if (rs != null) { P.rs = P.rs == null || dt === 0 ? rs : P.rs + (rs - P.rs) * (1 - Math.exp(-dt / C.tauScale)); }
        else P.rs = null;
        var r = P.rs;
        o.pull = r == null ? 1 : r;
        // pull back = brake (all modes)
        if (r != null) { if (!P.brakeOn && r < C.pullOn) P.brakeOn = true; else if (P.brakeOn && r > C.pullOff) P.brakeOn = false; }
        else P.brakeOn = false;
        var brk = P.brakeOn ? clamp((C.pullOff - r) / (C.pullOff - C.pullFull), 0.35, 1) : 0;
        var thr = 0;
        if (mode === 'auto') {
          if (!P.openOn && P.cs < C.openOn) P.openOn = true; else if (P.openOn && P.cs > C.openOff) P.openOn = false;
          if (P.openOn) brk = Math.max(brk, clamp((C.openOff - P.cs) / (C.openOff - C.openOn + 0.1), 0.5, 1));
          thr = 1;
        } else if (mode === 'push') {
          if (r != null) { if (!P.gasOn && r > C.pushOn) P.gasOn = true; else if (P.gasOn && r < C.pushOff) P.gasOn = false; } else P.gasOn = false;
          thr = P.gasOn ? clamp((r - C.pushOff) / (C.pushFull - C.pushOff), 0.2, 1) : 0;
        } else {
          if (!P.gasOn && P.cs > C.gasOn) P.gasOn = true; else if (P.gasOn && P.cs < C.gasOff) P.gasOn = false;
          thr = P.gasOn ? clamp((P.cs - C.gasOff) / (C.gasFull - C.gasOff), 0.15, 1) : 0;
        }
        if (brk > 0) thr = 0;                                  // the brake always wins
        o.throttle = thr; o.brake = brk;
        o.state = brk > 0 ? 'brake' : thr > 0 ? 'gas' : 'coast';
        adapt(meas, r, dt, mode);
        yanks(meas, t, prefs, o);
        return o;
      },
      /** the output for time t: held 150 ms after the last hands, then no gas; a light brake after 0.5 s */
      read: function (t, mode) {
        t = num(t, nowMs());
        var age = P.lastOkT == null ? Infinity : t - P.lastOkT;
        if (P.out.ok && age <= C.holdMs) { var h = Object.assign({}, P.out); if (t > P.hbUntil) h.handbrake = false; return h; }
        P.gasOn = false; P.openOn = false;
        var off = (mode || '') === 'off';
        return { throttle: 0, brake: !off && P.lastOkT != null && age > C.lostBrakeMs ? C.lostBrake : 0, handbrake: false, item: false, gas: 0, pull: 1, state: P.lastOkT == null ? 'off' : 'lost', ok: false };
      },
      reset: function () { P.cs = P.rs = null; P.gasOn = P.brakeOn = P.openOn = false; P.lastT = P.lastOkT = null; P.out = { throttle: 0, brake: 0, handbrake: false, item: false, gas: 0, pull: 1, state: 'off', ok: false }; P.hist.length = 0; }
    };
    function meanCurl(meas) {
      if (!meas || !meas.ok || !meas.pts) return null;
      var cs = meas.pts.map(function (p) { return p.curl; }).filter(function (c) { return c != null && isFinite(c); });
      return cs.length ? cs.reduce(function (a, c) { return a + c; }, 0) / cs.length : null;
    }
    function ratio(meas) {
      var s = 0, n = 0, sc = P.cal.scale;
      meas.pts.forEach(function (p) {
        var b = sc[p.id || 'a'];
        if (b > 0 && p.scale > 0 && (P.cal.world == null || !!p.world === P.cal.world)) { s += p.scale / b; n++; }
      });
      return n ? s / n : null;
    }
    // the neutral scale follows slow changes (leaning in the seat): only while coasting / driving near neutral, never
    // while braking; a sustained move closer re-bases faster (otherwise pulling back to the old spot would brake)
    function adapt(meas, r, dt, mode) {
      if (r == null || dt <= 0 || P.brakeOn) { P.closeT = 0; return; }
      var tau = 0;
      if (mode === 'push') { if (r > 0.96 && r < 1.04) tau = 20; }
      else if (r > 0.93 && r < 1.1) tau = 15;
      else if (r >= 1.15) { P.closeT += dt; if (P.closeT > 3) tau = 2; }
      if (r < 1.15) P.closeT = 0;
      if (!tau) return;
      var k = 1 - Math.exp(-dt / tau);
      meas.pts.forEach(function (p) { var b = P.cal.scale[p.id || 'a']; if (b > 0 && p.scale > 0) P.cal.scale[p.id || 'a'] = b + (p.scale - b) * k; });
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
    createPedals: createPedals, PEDALS: PED, PEDAL_MODES: ['grip', 'auto', 'push', 'off'],
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

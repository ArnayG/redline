/* ==========================================================================
   FORGE — js/input/tilt.js
   CB.input.tilt : tilt-to-steer. Turns DeviceOrientation readings into a smooth, continuous steering value, like
   holding a steering wheel: steering = rotation of the phone about its SCREEN NORMAL, measured against gravity, so
   leaning the phone back or forward (pitch) does not steer. Works in both landscape orientations and follows
   screen.orientation changes. Pure core (Node-tested) + a thin browser sensor binding + the local 'tilt' hub source.

   Core (pure):
     tilt.upVector(beta, gamma)                  -> [x, y, z] world "up" in device coordinates (W3C Z-X'-Y'' angles, deg)
     tilt.wheelAngle(beta, gamma, screenAngle)   -> {angle (deg, + = turned clockwise / right), conf (0..1)} | null
     tilt.mapAngle(angleDeg, {deadzone, maxAngle}) -> steer [-1, 1] (linear outside the deadzone, full lock at maxAngle)
     tilt.oneEuro({minCutoff, beta, dCutoff})    -> {filter(x, tMs), reset()}  (Casiez 1€ filter)
     tilt.createSteer(prefs?) -> s               s.update(beta, gamma, screenAngle, tMs) -> steer   s.refresh(tMs) (no new event)
                                                 s.recalibrate() (current angle = centre), s.setPrefs(p), s.state()
                                                 s.steer, s.angle (filtered, relative to centre), s.raw, s.flat
                                                 s.lockRef(screenAngle) / s.unlockRef(): freeze the reference side for a
                                                 steering session (CB.input.orient): OS auto-rotations are then ignored, the
                                                 angle is the device-frame gravity roll + a constant, unwrapped, so it stays
                                                 continuous past +-90 / +-180 deg. Flat phone -> last value held.
                                                 Full lock (prefs.maxAngle) may be 10..180 deg.
   Browser:
     tilt.sensor.available() / secure() / needsPermission() / screenAngle()
     tilt.sensor.start() -> Promise<{ok, reason?}>   call from a user gesture (iOS DeviceOrientationEvent.requestPermission)
     tilt.sensor.onReading(fn(beta, gamma, screenAngle, tMs)) -> off ; tilt.sensor.stop()
     tilt.local.enable() -> Promise<{ok, reason?}>  play on THIS phone: registers hub source 'tilt' (steer from the
                                                 sensor, pedals from the on-screen touch pedals: tilt.local.pedals)
     tilt.local.disable() / tilt.local.enabled / tilt.local.recalibrate() / tilt.local.steer
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';

  var DEG = Math.PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function wrap180(a) { a = ((a + 180) % 360 + 360) % 360 - 180; return a; }

  /* ---------------------------------------------------------------- geometry */
  /** World up (0,0,1) expressed in the device frame for R = Rz(alpha) Rx(beta) Ry(gamma). Independent of alpha. */
  function upVector(beta, gamma) {
    var b = num(beta, 0) * DEG, g = num(gamma, 0) * DEG;
    return [-Math.sin(g) * Math.cos(b), Math.sin(b), Math.cos(b) * Math.cos(g)];
  }
  function normAngle(a) { a = Math.round(num(a, 0)) % 360; return a < 0 ? a + 360 : a; }
  /**
   * Rotation of the phone about the screen normal, relative to "screen up = world up".
   * screenAngle: screen.orientation.angle (0 portrait, 90 landscape with the device top to the LEFT, 270 the other way).
   * + = the phone (wheel) is turned clockwise as seen by the player = steer right.
   */
  function wheelAngle(beta, gamma, screenAngle) {
    if (!isFinite(beta) || !isFinite(gamma)) return null;
    var u = upVector(beta, gamma), a = normAngle(screenAngle) * DEG;
    var upS = [Math.sin(a), Math.cos(a)], rightS = [Math.cos(a), -Math.sin(a)];
    var pu = u[0] * upS[0] + u[1] * upS[1], pr = u[0] * rightS[0] + u[1] * rightS[1];
    var mag = Math.hypot(pu, pr);
    return { angle: Math.atan2(-pr, pu) / DEG, conf: clamp((mag - 0.15) / 0.35, 0, 1) };
  }
  function mapAngle(angle, o) {
    o = o || {};
    var dz = clamp(num(o.deadzone, 2), 0, 30), max = Math.max(dz + 1, num(o.maxAngle, 35));
    var a = Math.abs(num(angle, 0));
    if (a <= dz) return 0;
    return (angle < 0 ? -1 : 1) * clamp((a - dz) / (max - dz), 0, 1);
  }

  /* ---------------------------------------------------------------- 1€ filter */
  function oneEuro(o) {
    o = o || {};
    var minCutoff = num(o.minCutoff, 1.2), beta = num(o.beta, 0.02), dCutoff = num(o.dCutoff, 1.0);
    var xPrev = null, dxPrev = 0, tPrev = null;
    function alpha(cut, dt) { var tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
    return {
      filter: function (x, t) {
        if (xPrev === null || tPrev === null) { xPrev = x; tPrev = t; dxPrev = 0; return x; }
        var dt = (t - tPrev) / 1000;
        if (!(dt > 0)) dt = 1 / 60;
        if (dt > 0.5) { xPrev = x; tPrev = t; dxPrev = 0; return x; }      // sensor pause: no slow sweep
        var dx = (x - xPrev) / dt, edx = dxPrev + alpha(dCutoff, dt) * (dx - dxPrev);
        var cut = minCutoff + beta * Math.abs(edx);
        var ex = xPrev + alpha(cut, dt) * (x - xPrev);
        xPrev = ex; dxPrev = edx; tPrev = t;
        return ex;
      },
      reset: function () { xPrev = null; tPrev = null; dxPrev = 0; },
      set: function (p) { if (p) { minCutoff = num(p.minCutoff, minCutoff); beta = num(p.beta, beta); dCutoff = num(p.dCutoff, dCutoff); } }
    };
  }
  /** smoothing 0 (raw, snappy) .. 1 (very smooth) -> 1€ min cutoff (Hz). */
  function cutoffFor(smoothing) { var s = clamp(num(smoothing, 0.5), 0, 1); return 6 * Math.pow(0.08, s); }   // 6 Hz .. 0.48 Hz

  /** how far the unwrapped angle may run before a whole extra turn folds back (always past full lock) */
  function foldLimit(maxAngle) { return clamp(num(maxAngle, 35) + 90, 200, 300); }

  function createSteer(prefs) {
    var P = Object.assign({ maxAngle: 35, deadzone: 2, smoothing: 0.5 }, prefs || {});
    var f = oneEuro({ minCutoff: cutoffFor(P.smoothing), beta: 0.025, dCutoff: 1 });
    var unwrapped = null, prevRaw = null, offset = 0, wantCal = false;
    // reference frame: while a steering session runs the screen angle is FROZEN (refLocked), so an OS auto-rotation
    // (landscape <-> portrait, or to the other landscape side) never changes the measured angle: the angle is then
    // purely the device-frame roll (gravity vector) + a constant, unwrapped -> continuous through +-90 / +-180.
    var ref = null, refLocked = false;
    function fold() {
      var rel = unwrapped - offset;
      if (Math.abs(rel) > foldLimit(P.maxAngle)) { var k = 360 * Math.round(rel / 360); offset += k; S.raw -= k; f.reset(); }
    }
    var S = {
      steer: 0, angle: 0, raw: 0, flat: false, conf: 0, readings: 0, lastT: null,
      update: function (beta, gamma, screenAngle, t) {
        t = num(t, nowMs());
        var sa = refLocked ? ref : normAngle(screenAngle);
        if (!refLocked && ref !== null && sa !== ref) { f.reset(); }   // follow mode (no session): re-based on the new screen
        ref = sa;
        var w = wheelAngle(beta, gamma, sa);
        if (!w) return S.steer;
        S.readings++; S.lastT = t; S.conf = w.conf;
        S.flat = w.conf <= 0;
        // phone lying flat: the roll is noise -> hold the last value and do not unwrap through it
        if (S.flat && prevRaw !== null) return S.steer;
        // unwrap so a turn through +-180 never jumps
        if (prevRaw === null) unwrapped = w.angle;
        else unwrapped += wrap180(w.angle - prevRaw);
        prevRaw = w.angle;
        if (wantCal) { offset = unwrapped; wantCal = false; f.reset(); }
        if (S.flat) return S.steer;
        // a whole extra turn (phone spun round) folds back so the wheel never stays stuck at full lock
        fold();
        var rel = unwrapped - offset;
        // nearly flat (low confidence): ease towards the new reading instead of trusting it fully
        if (w.conf < 1 && S.readings > 1) rel = S.raw + (rel - S.raw) * (0.25 + 0.75 * w.conf);
        S.raw = rel;
        var fa = f.filter(rel, t);
        S.angle = fa;
        S.steer = mapAngle(fa, P);
        return S.steer;
      },
      /** No new sensor event (some browsers only fire on change): let the filter settle on the last reading. */
      refresh: function (t) {
        if (prevRaw === null || S.flat) return S.steer;
        var fa = f.filter(S.raw, num(t, nowMs()));
        S.angle = fa; S.steer = mapAngle(fa, P);
        return S.steer;
      },
      /**
       * Freeze the reference screen angle for a steering session (the landscape side the player holds). Later screen
       * orientation changes are ignored. Re-basing to a different side keeps the angle continuous and folds it so the
       * phone held level on the new side reads ~0.
       */
      lockRef: function (screenAngle) {
        var a = normAngle(screenAngle);
        if (ref !== null && prevRaw !== null && a !== ref) {
          var d = wrap180(a - ref);
          prevRaw = wrap180(prevRaw + d); unwrapped += d;
          var rel = unwrapped - offset;
          offset += 360 * Math.round(rel / 360);
          S.raw = unwrapped - offset; f.reset();
        }
        ref = a; refLocked = true;
        return ref;
      },
      unlockRef: function () { refLocked = false; },
      refLocked: function () { return refLocked; },
      ref: function () { return ref; },
      recalibrate: function () { wantCal = true; if (prevRaw !== null) { offset = unwrapped; wantCal = false; f.reset(); S.angle = 0; S.steer = 0; S.raw = 0; } },
      setPrefs: function (p) { Object.assign(P, p || {}); f.set({ minCutoff: cutoffFor(P.smoothing) }); },
      prefs: function () { return Object.assign({}, P); },
      state: function () { return { steer: S.steer, angle: S.angle, raw: S.raw, flat: S.flat, offset: offset, readings: S.readings, ref: ref, refLocked: refLocked }; },
      reset: function () { f.reset(); unwrapped = null; prevRaw = null; offset = 0; S.steer = 0; S.angle = 0; S.raw = 0; S.readings = 0; }
    };
    return S;
  }

  /* ---------------------------------------------------------------- browser sensor */
  var hasWin = typeof window !== 'undefined';
  var readers = [], listening = false, lastEvT = 0, motionFallback = false;
  function screenAngle() {
    if (!hasWin) return 0;
    try { if (window.screen && window.screen.orientation && isFinite(window.screen.orientation.angle)) return normAngle(window.screen.orientation.angle); } catch (e) { /* ignore */ }
    if (isFinite(window.orientation)) return normAngle(window.orientation);
    return 0;
  }
  function deliver(b, g, t) { var a = screenAngle(); readers.slice().forEach(function (fn) { try { fn(b, g, a, t); } catch (e) { /* ignore */ } }); }
  function onOrient(e) {
    if (!e || e.beta == null || e.gamma == null) return;
    lastEvT = nowMs(); motionFallback = false;
    deliver(+e.beta, +e.gamma, lastEvT);
  }
  function onMotion(e) {
    // fallback when deviceorientation carries no angles: gravity from accelerationIncludingGravity (W3C: points up at rest)
    if (nowMs() - lastEvT < 500 && !motionFallback) return;
    var a = e && e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    var n = Math.hypot(a.x, a.y, a.z);
    if (!(n > 3)) return;
    motionFallback = true;
    var ux = a.x / n, uy = a.y / n, uz = a.z / n;
    // invert upVector(): uy = sin(beta), ux = -sin(gamma) cos(beta), uz = cos(beta) cos(gamma)
    var beta = Math.asin(clamp(uy, -1, 1)) / DEG, gamma = Math.atan2(-ux, uz) / DEG;
    deliver(beta, gamma, nowMs());
  }
  var sensor = {
    available: function () { return hasWin && ('DeviceOrientationEvent' in window || 'DeviceMotionEvent' in window); },
    secure: function () {
      if (!hasWin) return false;
      if (window.isSecureContext === true) return true;
      var h = window.location && window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    },
    needsPermission: function () {
      return hasWin && typeof window.DeviceOrientationEvent !== 'undefined' && typeof window.DeviceOrientationEvent.requestPermission === 'function';
    },
    screenAngle: screenAngle,
    isLandscape: function () { var a = screenAngle(); return a === 90 || a === 270; },
    lastEventT: function () { return lastEvT; },
    /** Must run inside a user gesture on iOS. Resolves {ok:true} or {ok:false, reason:'insecure'|'unsupported'|'denied'|'error'}. */
    start: function () {
      if (!hasWin) return Promise.resolve({ ok: false, reason: 'unsupported' });
      if (!sensor.secure()) return Promise.resolve({ ok: false, reason: 'insecure' });
      if (!sensor.available()) return Promise.resolve({ ok: false, reason: 'unsupported' });
      var perms = [];
      try {
        if (sensor.needsPermission()) perms.push(window.DeviceOrientationEvent.requestPermission());
        if (typeof window.DeviceMotionEvent !== 'undefined' && typeof window.DeviceMotionEvent.requestPermission === 'function') perms.push(window.DeviceMotionEvent.requestPermission().catch(function () { return 'denied'; }));
      } catch (e) { return Promise.resolve({ ok: false, reason: 'error', error: e }); }
      return Promise.all(perms).then(function (res) {
        if (res.length && res[0] !== 'granted') return { ok: false, reason: 'denied' };
        if (!listening) {
          listening = true;
          window.addEventListener('deviceorientation', onOrient, true);
          window.addEventListener('devicemotion', onMotion, true);
        }
        return { ok: true };
      }, function (e) { return { ok: false, reason: 'denied', error: e }; });
    },
    stop: function () {
      if (!listening || !hasWin) return;
      listening = false;
      window.removeEventListener('deviceorientation', onOrient, true);
      window.removeEventListener('devicemotion', onMotion, true);
    },
    listening: function () { return listening; },
    onReading: function (fn) { readers.push(fn); return function () { var i = readers.indexOf(fn); if (i >= 0) readers.splice(i, 1); }; },
    _inject: function (beta, gamma, t) { lastEvT = num(t, nowMs()); deliver(beta, gamma, lastEvT); }
  };

  /* ---------------------------------------------------------------- local 'tilt' hub source (play on this phone) */
  function hub() { return CB.input.hub; }
  var local = {
    enabled: false,
    pedals: { throttle: 0, brake: 0, handbrake: false },
    steerer: null,
    steer: 0,
    _off: null, _unreg: null, _prefsOff: null,
    enable: function () {
      return sensor.start().then(function (r) {
        if (!r.ok) return r;
        var H = hub();
        if (!local.steerer) local.steerer = createSteer(H ? H.prefs : null);
        if (!local._off) local._off = sensor.onReading(function (b, g, a, t) { local.steer = local.steerer.update(b, g, a, t); });
        if (H && !local._unreg) {
          local._unreg = H.register('tilt', {
            read: function (now) {
              if (!local.enabled) return null;
              // some browsers only fire on change: let the filter settle on the last reading (the phone is held still)
              if (local.steerer && now - (local.steerer.lastT || 0) > 40) local.steer = local.steerer.refresh(now);
              return { active: true, steer: local.steer, throttle: local.pedals.throttle, brake: local.pedals.brake, handbrake: local.pedals.handbrake };
            }
          }, 5);
          local._prefsOff = H.onPrefs(function (p) { if (local.steerer) local.steerer.setPrefs(p); });
        }
        local.enabled = true;
        if (H) H.setPrefs({ tiltEnabled: true });
        local.recalibrate();
        return { ok: true };
      });
    },
    disable: function () {
      local.enabled = false;
      local.pedals.throttle = local.pedals.brake = 0; local.pedals.handbrake = false;
      if (local._unreg) { local._unreg(); local._unreg = null; }
      if (local._prefsOff) { local._prefsOff(); local._prefsOff = null; }
      if (local._off) { local._off(); local._off = null; }
      var H = hub(); if (H) H.setPrefs({ tiltEnabled: false });
    },
    recalibrate: function () { if (local.steerer) local.steerer.recalibrate(); }
  };

  var api = {
    upVector: upVector, wheelAngle: wheelAngle, mapAngle: mapAngle, oneEuro: oneEuro, cutoffFor: cutoffFor, createSteer: createSteer, foldLimit: foldLimit,
    sensor: sensor, local: local, _wrap180: wrap180
  };
  CB.input.tilt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

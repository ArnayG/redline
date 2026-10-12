/* ==========================================================================
   FORGE Atelier — js/race/drift/assist.js
   CB.race.assist : steering / driving assist that turns digital arrow keys into a
   smooth, forgiving, fun car — for grip racing AND for drifting (DRIFT-SPEC §1).

   Pure logic (no DOM). Classic script in browsers, require()-able in Node.

     var a = CB.race.assist.create({ level: 'off'|'light'|'medium'|'heavy' (default 'heavy'),
                                     mode: 'race'|'drift' (default 'race') });
     a.filter(raw, car, ctx) -> { throttle, brake, steer, handbrake, shiftUp, shiftDown }
       raw  { left, right, up, down, steerAxis?, throttleAxis?, brakeAxis?, handbrake, shiftUp, shiftDown }
       car  vehicle state (CB.race.vehicle: vx/vy BODY frame, yawRate...), a session.playerState()
            object { speed, vxLocal, vyLocal, yawRate, heading, steerAngle, ... } or an engine
            SNAPSHOT car (vx/vy WORLD frame, no yawRate) — all are normalised internally.
       ctx  { dt, geom, proj, params, gripMult? }   (every field optional; features degrade)
     a.debug()           -> { phase, targetAngle_deg, beta_deg, counterSteer_deg, ... }
     a.setLevel(level) / a.setMode(mode) / a.reset()
     a.engineHook(getRaw, opts) -> engine hook { preStep, vehicleParams, vehicleEnv } that runs the assist
            at the engine's fixed 120 Hz substep for the player car (getRaw() returns the raw key state).

   Conventions (vehicle.js): steer +1 = LEFT. Body frame +x forward, +y left. yaw CCW +.
     beta = atan2(vyLocal, vxLocal): beta > 0 -> the car travels to the LEFT of its nose
     (nose points right of the path: e.g. a right-hand drift). Counter-steer = steer toward beta.

   Drift-direction frame (used by the drift controller): d = +1 left-hand drift, -1 right-hand.
     "drift angle" A = -d * beta (positive while drifting the right way round).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  var G = 9.81, RHO = 1.225, DEG = Math.PI / 180, TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function smooth01(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function approach(cur, target, maxDelta) { return cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target); }
  function wrap(a) { a = a % TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; }
  function softDead(x, d) { var ax = Math.abs(x); return ax <= d ? 0 : sign(x) * (ax - d); }
  function mod(a, n) { return ((a % n) + n) % n; }

  /* ------------------------------------------------------------ levels
     Every behaviour is a continuous knob so 'light' < 'medium' < 'heavy' is a real gradient.  */
  var LEVELS = {
    off: {
      id: 'off', raw: true, rampIn: 99, rampOut: 99, lockSpeedSens: 0, counterSteer: 0, csDead: 0, yawStab: 0, thrLift: 0,
      laneKeep: 0, edgeGuard: 0, cornerBlend: 0, brakeAssist: 0, brakeMargin: 99, tractionLimit: 0, recovery: 0,
      init: 0, angleHold: 0, spinGuard: 0, driftCs: 0, driftTrack: 0
    },
    // light: the player drives (no track pulls, no auto-brake) but a single tap can never spin the car: speed-
    // sensitive lock, a strong spin guard and a tap-safe drift kick (it only fires while the arrow is held)
    light: {
      id: 'light', rampIn: 4.6, rampOut: 8.0, lockSpeedSens: 0.8, slipLimit: 0.35, counterSteer: 0.35, csDead: 3 * DEG, yawStab: 0.45, thrLift: 0.5,
      laneKeep: 0, edgeGuard: 0.5, cornerBlend: 0, brakeAssist: 0, brakeMargin: 99, tractionLimit: 0.4, driftTc: 0.6, recovery: 0.35,
      init: 0.55, angleHold: 0.45, spinGuard: 0.9, driftCs: 0.45, growBoost: 0.3, heldHold: 0.7, heldCs: 0.65, heldCsTrack: 0.8, gripCs: 0.65, trackCatch: 1, driftTrack: 0.6, tapSafe: true, highMix: 0.6,
      driftOv: { yawStab: 0.6, thrLift: 0.6, counterSteer: 0.5, tractionLimit: 0.6 }
    },
    // medium: light + edge guard / off-track recovery strong enough that a sloppy line does not end in the wall
    medium: {
      id: 'medium', rampIn: 4.0, rampOut: 7.0, lockSpeedSens: 0.9, counterSteer: 0.7, csDead: 2 * DEG, yawStab: 0.8, thrLift: 0.8,
      laneKeep: 0.18, edgeGuard: 0.85, cornerBlend: 0.15, brakeAssist: 0.6, brakeMargin: 6, tractionLimit: 0.8, recovery: 0.85,
      init: 0.8, angleHold: 0.92, spinGuard: 1.0, driftCs: 0.8, driftTrack: 0.75, tapSafe: true, highMix: 0.85,
      raceSpin: 0.6
    },
    heavy: {
      id: 'heavy', rampIn: 3.4, rampOut: 6.5, lockSpeedSens: 1.0, counterSteer: 0.85, csDead: 1.5 * DEG, yawStab: 1.0, thrLift: 1.0,
      laneKeep: 0.35, edgeGuard: 1.0, cornerBlend: 0.35, brakeAssist: 1.0, brakeMargin: 0.5, tractionLimit: 1.0, recovery: 1.0,
      init: 1.0, angleHold: 1.0, spinGuard: 1.0, driftCs: 0.85, driftTrack: 1.0, pilot: true,
      lineHold: 1.0, raceSpin: 1.0
    },
    // 'auto': heavy + the pilot picks every drift itself (hold Up only; arrows nudge the angle)
    auto: {
      id: 'auto', rampIn: 3.4, rampOut: 6.5, lockSpeedSens: 1.0, counterSteer: 0.85, csDead: 1.5 * DEG, yawStab: 1.0, thrLift: 1.0,
      laneKeep: 0.6, edgeGuard: 1.0, cornerBlend: 0.6, brakeAssist: 1.0, brakeMargin: 0.3, tractionLimit: 1.0, recovery: 1.0,
      init: 1.0, angleHold: 1.0, spinGuard: 1.0, driftCs: 0.85, driftTrack: 1.0, pilot: true, auto: true,
      lineHold: 1.0, raceSpin: 1.0
    }
  };
  var LEVEL_IDS = ['off', 'light', 'medium', 'heavy', 'auto'];
  /** The level table used in a mode: a level may carry drift-mode overrides (`driftOv`). */
  var ovCache = {};
  function levelFor(id, mode) {
    var base = LEVELS[id] || LEVELS.heavy;
    if (mode !== 'drift' || !base.driftOv) return base;
    if (ovCache[id] && ovCache[id].src === base.driftOv) return ovCache[id].L;
    var o = {}, k;
    for (k in base) o[k] = base[k];
    for (k in base.driftOv) o[k] = base.driftOv[k];
    ovCache[id] = { src: base.driftOv, L: o };
    return o;
  }
  /** Numeric blend of two level tables (a -> b by t); flags come from a. */
  var mixCache = {};
  function mixLevel(a, b, t) {
    var key = a.id + '>' + b.id + ':' + t;
    if (mixCache[key]) return mixCache[key];
    var o = {}, k;
    for (k in a) o[k] = a[k];
    for (k in b) if (typeof b[k] === 'number') o[k] = lerp(typeof a[k] === 'number' ? a[k] : 0, b[k], t);
    o.lineHold = 0; o.pilot = false; o.auto = false;
    // tap-safe levels (light / medium) keep the full hard spin guard at speed: a tap there must never spin the car
    if (a.tapSafe) o.raceSpin = Math.max(num(o.raceSpin, 0), 1);
    return (mixCache[key] = o);
  }

  /* ------------------------------------------------------------ tuning (drift controller) */
  var DRIFT = {
    initSpeed: 40 / 3.6,      // m/s — initiation helper threshold
    flick_s: 0.16,            // handbrake flick duration
    initMax_s: 0.9,           // give up initiating after this
    initMaxSpeed: 33,         // m/s — no kick above this (the speed-limited rack could not catch the slide)
    safeKickSpeed: 24,        // m/s — tap-safe levels (light / medium): no kick above ~86 km/h
    safeDriftSpeed: 24,       // m/s — tap-safe levels: a held slide sheds speed above this
    enterAngle: 9 * DEG,      // |beta| that counts as "drifting"
    exitAngle: 5 * DEG,       // below this (while not asking for angle) the drift is over
    baseAngle: 24 * DEG,      // target with the direction key held, no throttle
    thrAngle: 9 * DEG,        // + with throttle
    brakeAngle: -10 * DEG,    // - with brake
    minAngle: 10 * DEG,
    maxAngle: 45 * DEG,
    spinAngle: 58 * DEG,      // beyond: emergency recovery
    kE: 0.5,                  // steer correction per rad of angle error
    kD: 0.12,                 // steer correction per rad/s of angle rate
    kThrE: 2.2,               // throttle per rad of angle error
    kThrD: 0.2,              // throttle per rad/s of angle rate
    thrBase: 0.62,
    thrFloor: 0.18,
    kYawGrip: 0.12,           // rad steer per rad/s of yaw when driving straight in drift mode
    launchRadius: 10,         // m — tightest circle while accelerating up to drift speed
    spinTarget: 0.3,          // traction limiter spin target while not drifting
    launchG: 0.75,            // lateral g allowed while building speed (lower = wider circle, more drive)
    stallSpeed: 25 / 3.6,     // m/s — holding a direction + throttle below initSpeed: kick anyway once speed stalls
    stall_s: 0.6,             // s of slow acceleration before the stall kick
    stallAcc: 3.0,            // m/s^2 — 'not really gaining speed'
    thrCap: 0.9,
    trRef: 1.9,               // traction ratio at which the throttle map is 1:1
    kV: 0.12,                 // throttle lift per m/s above the rack-limited speed
    tapAngle: 7 * DEG,        // under-angle that triggers a handbrake tap while holding a drift
    tap_s: 0.09,              // handbrake tap length
    tapCool_s: 0.45,          // min gap between taps
    kickV0: 20,               // m/s — full-strength initiation below this ...
    kickV1: 38,               // ... and a gentle (lift / small-steer) kick above this
    predT: 0.22,              // s — look-ahead on the drift angle (catches over-rotation before it happens)
    capMargin: 3 * DEG,       // max target angle = speed-limited rack angle + this
    thrNeutral: 0.10,         // 'rolling' throttle used while catching an over-rotation
    catchMargin: 3 * DEG,     // drift angle the fronts can still catch beyond the rack limit
    // track layer (drift mode, medium / heavy): corner-speed governor + edge guard
    profLat: 0.8,             // x maxLatG: cornering grip assumed for the drift speed profile
    profBrk: 0.7,             // x maxBrakeG
    govLook: 0.6,             // s of travel scanned ahead
    govMargin: 1.0,           // m/s over the profile before the governor acts
    govRamp: 2.0,             // m/s over -> full governor brake
    govBrakeDrift: 0.3,       // max brake while sliding (more would lock the fronts / kill the angle)
    edgeLook: 2.5,            // s — lateral prediction horizon (early: a slide needs time to change its arc)
    edgeMargin: 2.0,          // m from the edge where the guard starts
    edgeSteer: 0.8,           // grip phases: blend toward the track centre
    edgeBrake: 0.35,
    edgeWideSteer: 0,         // running wide mid-slide: blend fronts toward peak grip into the corner
    edgeWideAngle: 22 * DEG,  // ... and ease the held angle down toward this
    hugMargin: 1.5,           // m from the edge: steering toward it is faded out (grip phases)
    edgeAbort: 0.6,           // inside-edge guard strength that ends the slide
    edgeBlock_s: 1.0,         // no new initiation for this long after an edge abort
    edgeOpen: 0.5,            // inside edge mid-slide: blend toward full counter-steer
    edgeOpenSafe: 0.85        // tap-safe levels (light / medium): minimum strength of that inside-edge opening
  };

  /* ------------------------------------------------------------ keyboard drift steering (digital arrows, drift mode) */
  var KB = {
    // 'off': self-aligning wheel + speed-sensitive reach + ramped throttle
    offMinSpeed: 2.5,         // m/s: below this 'off' is plain raw input (parking, reversing)
    offAlign: 0.9,            // share of the front-axle travel direction the wheel self-aligns to (auto counter-steer)
    alignTau: 0.035,          // s: low-pass on that alignment
    offRateLead: 0.12,        // s: counter-steer lead on the sideslip rate (rad per rad/s)
    offLeadMax: 0.25,         // rad
    reachGrip: 1.35,          // x grip-optimal angle a held key reaches at speed (grip)
    reachSlide: 2.2,          // ... while sliding (room to add / take away angle around the counter-steer)
    offRate: 4.2,             // rad/s wheel rate at rest
    rateV: 28,                // m/s: the rate halves by this speed
    slideRate: 1.8,           // x rate while sliding
    returnK: 1.6,             // x rate when releasing / reversing a key
    thrUp: 5.0, thrDown: 9.0, // 1/s throttle ramp
    // light / medium: the slide is steered relative to itself
    holdGrace_s: 0.9,         // released key: the angle is held this long at full throttle ...
    holdDecay: 9 * DEG,       // ... then unwinds at this rate (rad/s) — faster off throttle
    holdLiftDecay: 40 * DEG,  // rad/s unwind with the throttle lifted
    counterReach: 0.6,        // light / medium: counter arrow = this x grip-optimal angle beyond the front axle travel
    counterK: 0.75,           // ... blended in this strongly
    tapMax_s: 0.3,            // opposite key pressed shorter than this and released = switchback (manji)
    tapMin_s: 0.03
  };
  /** Rack limit (rad) the vehicle applies with input.slideRack: the speed-sensitive limit + the front axle's sideslip. */
  function slideRackMax(p, o, vF, grip) {
    var m = vehMaxSteer(p, vF, grip, o.maxSteer), lock = num(p.lockAngle, num(p.maxSteer, 0.6));
    var bF = Math.atan2(o.vy + o.r * num(p.a, num(p.wheelbase, 2.65) * 0.48), Math.max(vF, 3));
    return Math.max(0.03, clamp(m + Math.abs(bF), m, lock));
  }
  /** Digital (keyboard / on-screen buttons) steering intent — not a gamepad stick or a phone wheel. */
  function isDigital(raw) {
    if (!raw || raw.steerAnalog) return false;
    var ax = num(raw.steerAxis, NaN);
    return !(isFinite(ax) && Math.abs(ax) > 0.04);
  }

  var RACE = {
    kYaw: 0.25,              // rad of steer per rad/s of yaw-rate error (race mode yaw tracking)
    brakeLook: 0.35,          // s of travel scanned ahead on the speed profile
    brakeRamp: 1.8,           // m/s over target -> full assisted brake
    spinTarget: 0.25,         // driven-wheel spin (vehicle.wheelspin scale) the traction limiter allows
    edgeBrakeMax: 0.4,        // max brake the edge guard applies
    edgeThr: 0.0,             // throttle cap while the edge guard scrubs speed
    // ---- line hold (race mode, heavy / auto): at speed the arrows choose the LINE, the assist steers it
    lineEdge: 1.7,            // m: the chosen line keeps this far inside the road edge (car half-width + margin)
    lineRate: 3.5,            // m/s: how fast a held arrow moves the line across the road
    lineBack: 2.0,            // m/s: released -> the line drifts back onto the racing line
    lineV0: 3, lineV1: 9,     // m/s: raw arrow steering below lineV0, full line hold above lineV1
    lineLook0: 5, lineLookV: 0.5, lineLookMax: 40, lineLookV2: 0.35,   // pursuit look-ahead (m, m per m/s, max m)
    latSafe: 0.86,            // x maxLatG: cornering grip the line-hold speed governor plans with
    brkSafe: 0.55,            // x maxBrakeG: braking it plans with
    govLook_s: 0.45,          // s of reaction margin in the governor
    // ---- hard spin guard (race mode): the sideslip never builds past a catchable angle
    spinBeta0: 9 * Math.PI / 180, spinBeta1: 22 * Math.PI / 180,
    // ---- traffic guard (race mode, line hold): no rear-ending a slower car (a hit at speed is an uncatchable spin)
    trafHalfW: 2.3,           // m: |side offset| below which a car ahead is in our lane
    trafLook: 45,             // m: scan distance
    trafGap: 2.0,             // m: bumper gap the guard plans to keep
    trafDecel: 5.5,           // m/s^2: braking the guard plans with
    trafDodge: 1.0            // share of the line nudge away from a car close ahead (no arrow held)
  };

  /* ------------------------------------------------------------ helpers */
  /** Arcade handling (ARCADE-SPEC): kinematic grip model, steering = path curvature (vehicle.js arcadeSubstep). */
  function isArc(p) { return !!(p && p.handling === 'arcade' && p.arcade); }
  function arcLat(p, v, grip) {
    var mg = num(p.mass, 1400) * G, df = 0.5 * RHO * num(p.clA, 0) * v * v;
    return num(p.arcade.latG, 1.3) * G * (1 + num(p.arcade.dfGain, 0.35) * Math.min(1.2, df / mg)) * (0.7 + 0.3 * clamp(grip, 0, 1));
  }
  function arcMaxSteer(p, vF, grip) {
    var wb = num(p.wheelbase, 2.65), va = Math.max(vF, 0.1);
    return Math.atan(wb * Math.min(Math.tan(num(p.lockAngle, 0.6)) / wb, arcLat(p, va, grip) / (va * va)));
  }
  function latAccelAt(p, v, grip) {
    if (isArc(p)) return arcLat(p, v, grip);
    var mass = num(p.mass, 1400), mg = mass * G;
    var df = 0.5 * RHO * num(p.clA, 0) * v * v;
    var wf = num(p.weightFront, 0.52);
    var mu = num(p.muF, 1.05) * wf + num(p.muR, 1.05) * (1 - wf);
    var lf = 1 - num(p.loadSens, 0.1) * 0.35 * (df / mg);
    return mu * grip * 0.93 * (mg + df) * lf / mass;
  }
  /** Replica of the vehicle model's internal speed-sensitive steering limit (rad) — maps rad <-> input.steer. */
  function vehMaxSteer(p, vF, grip, carMax) {
    if (isArc(p)) return arcMaxSteer(p, vF, grip);
    var lock = num(p.lockAngle, num(p.maxSteer, num(carMax, 0.6)));
    if (!(p && isFinite(p.wheelbase))) {
      var fbm = num(carMax, lock / (1 + Math.pow(vF / 21, 1.6)));
      return clamp(fbm, 0.045, lock);
    }
    var speedLimit = lock / (1 + Math.pow(vF / 21, 1.6));
    var physLimit = vF > 1 ? Math.atan(p.wheelbase * latAccelAt(p, vF, grip) / (vF * vF)) + Math.atan(num(p.tanAlphaPeakF, 0.15)) * 1.25 : lock;
    return clamp(Math.max(speedLimit, Math.min(physLimit, lock)), 0.045, lock);
  }
  /** Grip-optimal steering angle at speed v (rad): geometric wb*a/v^2 plus front peak slip. */
  function gripSteer(p, vF, grip) {
    var wb = num(p.wheelbase, 2.65), lock = num(p.lockAngle, num(p.maxSteer, 0.6));
    if (vF < 1) return lock;
    if (isArc(p)) return arcMaxSteer(p, vF, grip);   // no slip peak: the limit IS the grip-optimal angle
    return Math.min(lock, Math.atan(wb * latAccelAt(p, vF, grip) / (vF * vF)) + Math.atan(num(p.tanAlphaPeakF, 0.15)) * 0.95);
  }

  /** Highest speed (m/s) at which the speed-sensitive rack still gives `angle` of lock. */
  function capSpeed(p, grip, angle, carMax) {
    var lo = 4, hi = 70;
    if (vehMaxSteer(p, hi, grip, carMax) >= angle) return hi;
    if (vehMaxSteer(p, lo, grip, carMax) < angle) return lo;
    for (var i = 0; i < 14; i++) { var m = (lo + hi) / 2; if (vehMaxSteer(p, m, grip, carMax) >= angle) lo = m; else hi = m; }
    return lo;
  }

  /** Rear drive force at peak torque in the current gear / rear tyre grip. */
  function tractionRatio(p, gear) {
    if (!p || !isFinite(p.peakNm) || !Array.isArray(p.ratios) || !p.ratios.length) return 1.9;
    var n = p.ratios.length, gi = clamp(Math.round(num(gear, 2)), 1, n) - 1;
    var Gt = p.ratios[gi] * num(p.finalDrive, 3.5) * num(p.efficiency, 0.92);
    var F = p.peakNm * Gt / num(p.radiusR, 0.33) * (1 - num(p.splitF, 0));
    var N = num(p.mass, 1400) * G * (1 - num(p.weightFront, 0.5));
    return F / Math.max(1, num(p.muR, 1) * N);
  }
  /* traction limiter (stateful throttle cut on measured / estimated wheelspin) */
  var TC = { minF: 0.2, cut: 6, recover: 2.5 };
  function throttleScale(p, gear) { return clamp(DRIFT.trRef / Math.max(0.2, tractionRatio(p, gear)), 0.3, 1); }

  var DEFAULT_P = { mass: 1450, wheelbase: 2.65, lockAngle: 0.6, maxSteer: 0.6, muF: 1.05, muR: 1.05, weightFront: 0.52,
    loadSens: 0.1, clA: 0, tanAlphaPeakF: 0.15, maxLatG: 1.0, maxBrakeG: 1.1, layout: 'rwd' };

  /* normalise any car-ish object into the assist's view */
  function readCar(car, mem, dt) {
    car = car || {};
    var o = { speed: 0, vx: 0, vy: 0, r: 0, heading: num(car.heading, 0), steer: num(car.steerAngle, 0),
      gear: car.gear === 'R' ? -1 : car.gear === 'N' ? 0 : num(car.gear, 1), rpm: num(car.rpm, 0), x: num(car.x, NaN), y: num(car.y, NaN),
      wheelspin: num(car.wheelspin, NaN), shiftTimer: num(car.shiftTimer, 0), maxSteer: num(car.maxSteer_rad, NaN), slipR: num(car.slipAngleR, num(car.slipR, 0)) };
    if (isFinite(car.vxLocal) || isFinite(car.vyLocal)) {
      o.vx = num(car.vxLocal, 0); o.vy = num(car.vyLocal, 0);
    } else if (!isFinite(car.vxWorld) && (Array.isArray(car.wheels) || isFinite(car.yawRate) || isFinite(car.beta))) {
      o.vx = num(car.vx, 0); o.vy = num(car.vy, 0);           // vehicle state: BODY frame
    } else {                                                 // snapshot car: WORLD frame -> body
      var wx = num(car.vx, 0), wy = num(car.vy, 0), c = Math.cos(o.heading), s = Math.sin(o.heading);
      o.vx = wx * c + wy * s; o.vy = -wx * s + wy * c;
    }
    o.speed = num(car.speed, Math.sqrt(o.vx * o.vx + o.vy * o.vy));
    if (isFinite(car.yawRate)) o.r = car.yawRate;
    else if (mem.prevHeading != null && dt > 0) o.r = wrap(o.heading - mem.prevHeading) / dt;
    mem.prevHeading = o.heading;
    o.beta = o.speed > 1.5 && o.vx > 0.5 ? Math.atan2(o.vy, o.vx) : 0;
    o.reversing = o.gear < 0;
    o.backwards = o.gear >= 0 && o.vx < -0.5;                // spun round / sliding backwards in a forward gear
    return o;
  }
  /** Driven-wheel spin 0..1: from the vehicle state when present, else estimated from rpm / gear / speed. */
  function spinOf(o, p) {
    if (isFinite(o.wheelspin)) return o.wheelspin;
    if (!p || !Array.isArray(p.ratios) || !p.ratios.length || !(o.rpm > 0) || o.gear < 1) return 0;
    var gi = clamp(Math.round(o.gear), 1, p.ratios.length) - 1;
    var Gt = p.ratios[gi] * num(p.finalDrive, 3.5);
    var R = p.layout === 'fwd' ? num(p.radiusF, 0.33) : num(p.radiusR, 0.33);
    var vw = o.rpm * TAU / 60 / Gt * R;
    if (o.rpm <= num(p.idle, 800) * 1.15) return 0;     // clutch slipping at idle, not wheelspin
    return clamp((vw - Math.abs(o.vx) - 1.2) / 6, 0, 1);
  }

  /* racing-line speed profile cache (per geom, per params) */
  var profCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function profileFor(geom, p, safe) {
    var T = CB.race.tracks;
    if (!geom || typeof geom.speedProfile !== 'function' && !(T && T.speedProfile)) return null;
    var drift = safe === 'drift';
    var key = (num(p.maxLatG, 1)).toFixed(3) + '|' + (num(p.maxBrakeG, 1)).toFixed(3) + '|' + num(p.mass, 0) + '|' +
      (drift ? 'd' + DRIFT.profLat + ',' + DRIFT.profBrk : safe ? 's' : 'r');
    var map = profCache ? profCache.get(geom) : geom.__assistProf;
    if (!map) { map = {}; if (profCache) profCache.set(geom, map); else { try { geom.__assistProf = map; } catch (e0) { /* frozen */ } } }
    if (map[key] !== undefined) return map[key];
    var lat = num(p.maxLatG, 1) * (drift ? DRIFT.profLat : safe ? 0.9 : 0.95), brk = num(p.maxBrakeG, 1.1) * (drift ? DRIFT.profBrk : safe ? 0.75 : 0.85);
    var acc = p.capabilities && Array.isArray(p.capabilities.accelTable) ? function (s) {
      var t = p.capabilities.accelTable, i = clamp(Math.floor(s), 0, t.length - 1); return Math.max(0.3, t[i]);
    } : null;
    function prof(line) {
      try {
        var r = typeof geom.speedProfile === 'function' ? geom.speedProfile(lat, brk, acc, { line: line }) : T.speedProfile(geom, lat, brk, acc, { line: line });
        return Array.isArray(r) && r.length ? r : null;
      } catch (e) { return null; }
    }
    var v = drift ? prof('center') : prof('racing');
    if (safe && !drift) {
      // a keyboard driver rarely nails the racing line: blend toward the (tighter) centre-line speeds
      var c = prof('center');
      if (v && c && c.length === v.length) v = v.map(function (x, i) { return Math.min(x, lerp(x, c[i], 0.6)); });
      else v = v || c;
    }
    map[key] = v || null;
    return map[key];
  }

  /* ================================================================ drift pilot (heavy / auto, drift mode)
     The "drift lock": once the player picks a direction for a corner, the pilot owns steering, throttle,
     brake, handbrake and gears and holds the slide for as long as Up is held and the road keeps turning
     that way — indefinitely (sweepers, donuts). Velocity-vector path following keeps it on the road;
     a speed governor from a drift speed profile means the car never arrives too fast.
       chi = heading + beta (course).  r* = chiDot* + Kbeta (beta - beta*)        (yaw-rate demand)
       delta = thetaF (front-axle travel dir = natural counter-steer) + front-slip feed-forward
               + Kr (r* - r) + Kd betaDot                                           (steering)
       throttle = hold + Kt (angle error) (PI on drift angle), speed governor = left-foot brake / lift.
     Every output is low-passed and rate-limited (no snaps, no jitter).                              */
  var PILOT = {
    // ---- intent -> targets
    angle_deg: 32,          // drift angle held in tight corners (heavy, Up only)
    minAngle_deg: 22,       // ... fast sweepers that still count as drift corners
    keyAngle_deg: 8,        // + while the drift-direction arrow is held
    lessAngle_deg: 10,      // - with Down (or the opposite arrow on 'auto')
    autoAngle_deg: 6,       // 'auto' (no key): a touch more angle than heavy with Up only
    maxAngle_deg: 42,
    rackMargin_deg: 4,      // angle <= speed-limited rack lock - this: the fronts can always catch the slide
    tightRadius: 70, driftRadius: 260,
    driftLatG: 0.8,         // first guess of the drift lateral capacity (x mu); measured online
    planMargin: 0.9,        // the look-ahead speed plan assumes this share of it
    latFactor: 0.78, brakeG: 0.5, maxSpeed: 46, lineFactor: 0.2, edgeMargin: 2.8,
    outBias: 0,             // drift line bias toward the outside of drift corners (0..0.5; >0.2 costs walls)
    entryLead_s: 1.2,       // corner look-ahead (sloppy early taps still count)
    exitLead_s: 0.7,        // the angle unwinds this long before the corner ends
    rotLead_s: 0.4,         // the slide starts building this long before the turn-in point
    autoSwing_s: 0.6,       // auto: swing to the next opposite corner this long before it starts
    arm_s: 1.6,             // a tap arms a drift for this long (sloppy late taps still count)
    initSpeed: 32 / 3.6,    // m/s: below this the arrows steer like a normal car
    lowLatG: 0.45,          // lateral g of the arrows' steering bias below initSpeed
    exitSpeed: 22 / 3.6,    // m/s: a held drift lets go below this
    // ---- drift-angle filter: critically damped 2nd order + rate limit (smooth entries, one-arc swings, soft exits)
    wAng: 4.5, angRate: 1.0, swingRate: 0.75, recoverRate: 2.6, exitRate: 0.5,
    thrExit: 0.25, postDrift_s: 1.0,   // rolling throttle for 1 s after a slide (a snap lift flicks a RWD car back)
    // ---- yaw / sideslip regulation (steering)
    Kbeta: 1.5, KbetaGrip: 1.6, Kr: 0.3, Ki: 0.6, afMax: 1.25, rotMax: 0.8, leadIn_deg: 20, leadOut_deg: 10,
    tauChi: 0.15,           // course-rate filter (s): shorter = yaw-rate noise reaches the wheel
    kPathYaw: 0.3,          // share of the path's course-rate demand fed to the yaw demand while sliding
    exitPathYaw: 0.8,       // ... while unwinding (exit / inside guard)
    LdD0: 12, LdDv: 1.2,    // pursuit look-ahead while sliding (m, m per m/s): short = a weaving line
    inT: 2.2, inGMax: 1,    // inside guard: time-to-inside-edge horizon (s), max angle reduction
    // ---- speed regulation (throttle / brake): the road is followed with speed while sliding
    thrHold: 0.45, kV: 0.18, kIv: 0.12, thrFloor: 0.3, thrMaxDrift: 0.85,
    thrMode: 'speed', thrDrift: 0.38, kA: 1.2, kIA: 1.0, tauA: 0.25, iAmin: -0.2, iAmax: 0.4, kVd: 0.04, thrEntry: 0.55, thrNeutral: 0.2, brkK: 0.1, brkDrift: 0.3,
    kLatE: 0.001, kLatD: 0.03,          // lateral PD through the speed target (weak: speed is a slow actuator)
    vPathSettle: 0, vPathUp: 1.3, vtTau: 0.0,
    // ---- initiation / sustain / safety
    flick_s: 0.16, flickCool_s: 1.2, flickAt_deg: 6, rotInit: 0.3, entryHold: 1, tap_s: 0.08, tapCool_s: 0.6, stuck_deg: 10, stuck_s: 1.0, overLift_deg: 6,
    recover_deg: 62, recThrHi: 0.12, recThrLo: 0.25, recBrkHi: 0, recBrkLo: 0,   // recovery: rolling throttle, no brake (braked fronts cannot steer)
    // ---- gearbox / engine: short-shift off the (soft) limiter mid-slide, no fuel-cut bounce
    limUp_s: 0.2, upMinRpm: 0.5, ownBox: true, revSoft: 0.955, revCut: 6, revRecover: 0.6, revCapMin: 0.2,
    // ---- output smoothing (critically damped / rate-limited)
    steerTau: 0.03, steerRate: 2.5, thrTau: 0.06, thrRate: 3.0, brkTau: 0.05, brkRate: 4.0
  };

  function smoothCircular(arr, half) {
    var n = arr.length, out = new Float64Array(n), i;
    if (half < 1) { for (i = 0; i < n; i++) out[i] = arr[i]; return out; }
    var acc = 0, w = 2 * half + 1;
    for (i = -half; i <= half; i++) acc += arr[mod(i, n)];
    for (i = 0; i < n; i++) { out[i] = acc / w; acc += arr[mod(i + half + 1, n)] - arr[mod(i - half, n)]; }
    return out;
  }
  function carInfoOf(p) {
    var wb = num(p.wheelbase, 2.65), wf = clamp(num(p.weightFront, 0.52), 0.3, 0.7);
    var muF = num(p.muF, 1), muR = num(p.muR, 1), mass = num(p.mass, 1400);
    var hp = num(p.power_hp, num(p.powerKw, 250) / 0.7457);
    return { wb: wb, a: num(p.a, wb * (1 - wf)), b: num(p.b, wb * wf), muF: muF, muR: muR, mu: muF * wf + muR * (1 - wf),
      lock: num(p.lockAngle, num(p.maxSteer, 0.6)), tanPkF: num(p.tanAlphaPeakF, 0.16), hpPerTon: hp / (mass / 1000),
      layout: p.layout || 'rwd', redline: num(p.redline, 7000), mass: mass };
  }
  var planCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** Drift plan per (geom, params): drift line, curvature, drift speed profile, drift intensity + direction. */
  function planFor(geom, p) {
    if (!geom || !Array.isArray(geom.samples) || geom.samples.length < 8) return null;
    var key = num(p.mass, 0) + '|' + num(p.muR, 0).toFixed(3) + '|' + num(p.muF, 0).toFixed(3) + '|' + num(p.lockAngle, 0).toFixed(3) + '|' + num(p.power_hp, 0).toFixed(0);
    var map = planCache ? planCache.get(geom) : geom.__assistPlan;
    if (!map) { map = {}; if (planCache) planCache.set(geom, map); else { try { geom.__assistPlan = map; } catch (e0) { /* frozen */ } } }
    if (map[key] !== undefined) return map[key];
    var plan = null;
    try { plan = buildPlan(geom, p); } catch (e) { plan = null; }
    map[key] = plan;
    return plan;
  }
  function buildPlan(geom, p) {
    var o = PILOT, S = geom.samples, n = S.length, i, q;
    var L = num(geom.length, 0), ds = num(geom.ds, L > 0 ? L / n : 2);
    var ci = carInfoOf(p);
    var off = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var sm = S[i], hw = num(sm.hw, num(sm.width, 12) / 2);
      var lim = Math.max(0, hw - o.edgeMargin);
      off[i] = clamp(num(sm.racingLine, 0) * o.lineFactor, -lim, lim);
    }
    var hs = Math.max(1, Math.round(10 / ds));
    off = smoothCircular(smoothCircular(off, hs), hs);
    var X = new Float64Array(n), Y = new Float64Array(n), H = new Float64Array(n), HW = new Float64Array(n), SEG = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var s2 = S[i], nx = num(s2.nx, -Math.sin(s2.heading)), ny = num(s2.ny, Math.cos(s2.heading));
      X[i] = s2.x + nx * off[i]; Y[i] = s2.y + ny * off[i]; HW[i] = num(s2.hw, num(s2.width, 12) / 2);
    }
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n, pv = mod(i - 1, n);
      H[i] = Math.atan2(Y[j] - Y[pv], X[j] - X[pv]);
      SEG[i] = Math.max(0.05, Math.hypot(X[j] - X[i], Y[j] - Y[i]));
    }
    var rawK = new Float64Array(n);
    for (i = 0; i < n; i++) rawK[i] = wrap(H[(i + 1) % n] - H[mod(i - 1, n)]) / (SEG[mod(i - 1, n)] + SEG[i]);
    var kh = Math.max(1, Math.round(6 / ds));
    var K = smoothCircular(smoothCircular(rawK, kh), kh);
    // speed profile
    var aLat = Math.min(ci.mu, ci.muR * 1.02) * G * o.latFactor * (ci.muR < ci.muF * 0.95 ? 0.88 : 1);
    var vmax = Math.min(o.maxSpeed, num(p.topSpeed_ms, 90) * 0.95);
    var V = new Float64Array(n), wK = Math.max(1, Math.round(4 / ds));
    for (i = 0; i < n; i++) {
      var km = 0;
      for (q = -wK; q <= wK; q++) km = Math.max(km, Math.abs(K[mod(i + q, n)]));
      V[i] = Math.max(8, km > 1e-5 ? Math.min(vmax, Math.sqrt(aLat / km)) : vmax);
    }
    var capTab = [];
    for (var cv = 0; cv <= 90; cv += 0.5) capTab.push(vehMaxSteer(p, cv, 1));
    function vForAngle(b) {
      for (var ti = capTab.length - 1; ti >= 0; ti--) if (capTab[ti] >= b + o.rackMargin_deg * DEG) return ti * 0.5 / Math.max(0.5, Math.cos(b));
      return 8;
    }
    var aBrk = o.brakeG * G * Math.min(1.2, ci.mu), pass;
    function backProp() {
      for (pass = 0; pass < 2; pass++) for (i = n - 1; i >= 0; i--) { var jn = (i + 1) % n; V[i] = Math.min(V[i], Math.sqrt(V[jn] * V[jn] + 2 * aBrk * SEG[i])); }
    }
    backProp();
    // drift intensity & direction
    var D0 = new Float64Array(n), DIR = new Float64Array(n), kT = 1 / o.tightRadius, kD = 1 / o.driftRadius;
    for (i = 0; i < n; i++) {
      var ak = Math.abs(K[i]);
      D0[i] = ak < kD ? 0 : lerp(o.minAngle_deg / o.angle_deg, 1, smooth01(kD, kT, ak));
      DIR[i] = sign(K[i]);
    }
    var gap = Math.max(1, Math.round(12 / ds)), D2 = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var before = 0, after = 0;
      for (q = 1; q <= gap; q++) { before = Math.max(before, D0[mod(i - q, n)]); after = Math.max(after, D0[mod(i + q, n)]); }
      D2[i] = D0[i] > 0 ? D0[i] : Math.min(before, after) * 0.85;
    }
    for (i = 0; i < n; i++) {
      if (DIR[i] === 0 || D0[i] === 0) {
        for (q = 1; q < 60; q++) { var iq = (i + q) % n; if (DIR[iq] !== 0 && D0[iq] > 0) { DIR[i] = DIR[iq]; break; } }
      }
    }
    var D = smoothCircular(D2, Math.max(1, Math.round(4 / ds)));
    // drift line: biased toward the outside of drift corners (a slide carries the car inward; the drift lock
    // aims wide so the slide settles mid-road instead of running onto the inside kerb)
    if (o.outBias > 0) {
      var ob = new Float64Array(n);
      for (i = 0; i < n; i++) ob[i] = -DIR[i] * D[i] * o.outBias * Math.max(0, HW[i] - o.edgeMargin);
      ob = smoothCircular(smoothCircular(ob, hs), hs);
      for (i = 0; i < n; i++) {
        var lim2 = Math.max(0, HW[i] - o.edgeMargin), nOff = clamp(off[i] + ob[i], -lim2, lim2), dOff = nOff - off[i];
        var s3 = S[i], nx3 = num(s3.nx, -Math.sin(s3.heading)), ny3 = num(s3.ny, Math.cos(s3.heading));
        X[i] += nx3 * dOff; Y[i] += ny3 * dOff; off[i] = nOff;
      }
    }
    for (i = 0; i < n; i++) {
      if (D[i] > 0.05) {
        var kmD = 0;
        for (q = -wK; q <= wK; q++) kmD = Math.max(kmD, Math.abs(K[mod(i + q, n)]));
        var aD = lerp(aLat, o.driftLatG * o.planMargin * G * Math.min(1.3, ci.mu), clamp(D[i] * 1.4, 0, 1));
        var vD = kmD > 1e-5 ? Math.sqrt(aD / kmD) : vmax;
        V[i] = Math.max(8, Math.min(V[i], vD, vForAngle(Math.max(o.minAngle_deg, o.angle_deg * D[i] * 0.8) * DEG)));
      }
    }
    backProp();
    // gearing: no-slip road speed per rpm in each gear
    var gearV = [];
    if (Array.isArray(p.ratios) && p.ratios.length && !p.isCVT) {
      var radR = num(p.layout === 'fwd' ? p.radiusF : p.radiusR, 0.33), fd = num(p.finalDrive, 3.5);
      for (var gi = 0; gi < p.ratios.length; gi++) gearV.push((Math.PI / 30) / (num(p.ratios[gi], 1) * fd) * radR);
    }
    return { n: n, ds: ds, L: L || ds * n, X: X, Y: Y, H: H, K: K, V: V, D: D, DIR: DIR, OFF: off, HW: HW, car: ci, gearV: gearV };
  }

  function projectCar(geom, o, mem, ctxProj) {
    if (ctxProj && isFinite(ctxProj.index)) { mem.hint = ctxProj.index; return ctxProj; }
    if (!geom || !isFinite(o.x)) return null;
    var T = CB.race.tracks, r = null;
    try {
      if (T && typeof T.project === 'function') r = T.project(geom, o.x, o.y, mem.hint);
      else if (typeof geom.project === 'function') r = geom.project(o.x, o.y, mem.hint);
    } catch (e) { r = null; }
    if (r && isFinite(r.index)) mem.hint = r.index;
    return r;
  }

  /** Pure-pursuit steering angle (rad, + left) toward the line (lateral offset fn) at lookahead L. */
  function pursuit(geom, proj, o, L, lineFn, wb) {
    var S = geom && geom.samples;
    if (!S || !S.length || !proj) return null;
    var N = S.length, ds = num(geom.ds, 2);
    var j = mod(Math.round(proj.index + L / ds), N), sm = S[j];
    var off = lineFn ? lineFn(sm, j) : 0;
    var nx = isFinite(sm.nx) ? sm.nx : -Math.sin(sm.heading), ny = isFinite(sm.ny) ? sm.ny : Math.cos(sm.heading);
    var tx = sm.x + nx * off, ty = sm.y + ny * off;
    var dx = tx - o.x, dy = ty - o.y;
    var c = Math.cos(o.heading), s = Math.sin(o.heading);
    var lx = dx * c + dy * s, ly = -dx * s + dy * c;
    var d2 = lx * lx + ly * ly;
    if (d2 < 1) return 0;
    // curvature of the arc through the target, minus the slip the car already has
    var kappa = 2 * ly / d2;
    return Math.atan(wb * kappa);
  }

  /* ================================================================ create */
  function create(opts) {
    opts = opts || {};
    var level = LEVELS[opts.level] ? opts.level : 'heavy';
    var mode = opts.mode === 'drift' ? 'drift' : 'race';
    var L = levelFor(level, mode);
    var st;   // mutable controller state
    function reset() {
      st = {
        u: 0, thr: 0, lineBias: 0, gEst: 1, phase: 'grip', dir: 0, timer: 0, flick: 0, betaPrev: 0, betaRate: 0, prevHeading: null, hint: null,
        holdAngle: 0, lastSteer: 0, tcf: 1, lowT: 0, stallT: 0, vPrev: 0, acc: 0, initBlock: 0, edgeBrake: 0, dbg: {}, recover: 0, swing: 0, outSteerRad: 0, tap: 0, tapCool: 0, spun: 0, pl: null
      };
    }
    reset();

    function rampedSteer(raw, dt, v) {
      // gamepad axis wins when it carries intent
      var axis = num(raw.steerAxis, NaN);
      // phone wheel / tilt (raw.steerAnalog): the wheel angle IS the driver's steer -> linear, no deadband, no ramp
      if (raw.steerAnalog && isFinite(axis)) { st.u = clamp(axis, -1, 1); return st.u; }
      if (isFinite(axis) && Math.abs(axis) > 0.04) {
        var ax = clamp(axis, -1, 1);
        // light response curve: precise around centre
        st.u = sign(ax) * Math.pow(Math.abs(ax), 1.35);
        return st.u;
      }
      var want = (raw.left ? 1 : 0) - (raw.right ? 1 : 0);
      if (L.raw) { st.u = want; return want; }
      var speedK = 1 / (1 + v / 70);
      var inRate = L.rampIn * (0.55 + 0.45 * speedK) * (mode === 'drift' ? 1.35 : 1);
      if (want === 0) st.u = approach(st.u, 0, L.rampOut * dt);
      else if (sign(st.u) === -want && st.u !== 0) st.u = approach(st.u, 0, L.rampOut * 1.3 * dt); // snap back through centre first
      else st.u = approach(st.u, want, inRate * dt);
      return st.u;
    }

    function pedals(raw) {
      var thr = isFinite(raw.throttleAxis) && raw.throttleAxis > 0.02 ? clamp(raw.throttleAxis, 0, 1) : (raw.up ? 1 : 0);
      var brk = isFinite(raw.brakeAxis) && raw.brakeAxis > 0.02 ? clamp(raw.brakeAxis, 0, 1) : (raw.down ? 1 : 0);
      return { thr: thr, brk: brk };
    }

    /* -------------------------------------------------------------- filter */
    function filter(raw, car, ctx) {
      raw = raw || {}; ctx = ctx || {};
      L = levelFor(level, mode);
      var dt = clamp(num(ctx.dt, 1 / 60), 1 / 1000, 0.1);
      var p = ctx.params || DEFAULT_P;
      var grip = clamp(num(ctx.gripMult, num(ctx.env && ctx.env.gripMult, 1)), 0.3, 1.5);
      var o = readCar(car, st, dt);
      var v = o.speed, vF = Math.max(0, Math.abs(o.vx));
      var ped = pedals(raw);
      var u = rampedSteer(raw, dt, v);
      var out = { throttle: ped.thr, brake: ped.brk, steer: u, handbrake: !!raw.handbrake, shiftUp: !!raw.shiftUp, shiftDown: !!raw.shiftDown };
      var dbg = st.dbg = { level: level, mode: mode, phase: 'raw', beta_deg: o.beta / DEG, targetAngle_deg: 0, counterSteer_deg: 0,
        yawStab_deg: 0, laneKeep_deg: 0, brakeAssist: 0, throttleCut: 0, recovering: false, driftDir: 0, steerIn: u, speed_kph: v * 3.6 };

      // beta rate (filtered)
      var bRaw = (o.beta - st.betaPrev) / dt;
      st.betaRate += (clamp(bRaw, -8, 8) - st.betaRate) * (1 - Math.exp(-dt / 0.05));
      st.betaPrev = o.beta;
      // longitudinal acceleration (filtered) — used by the stall kick
      st.acc += (clamp((v - st.vPrev) / dt, -30, 30) - st.acc) * (1 - Math.exp(-dt / 0.3));
      st.vPrev = v;

      // drift mode, keyboard: even 'off' gets the digital smoothing every drift game gives keyboard players
      // (speed-sensitive steering rate, self-aligning counter-steer, throttle ramp) — no angle hold, no spin guard
      if (L.raw && mode === 'drift' && isDigital(raw) && v > KB.offMinSpeed && !o.reversing) {
        out.steer = clamp(kbOff(raw, o, p, grip, ped, out, dt) / slideRackMax(p, o, vF, grip), -1, 1);
        out.slideRack = true;
        st.phase = 'grip'; st.dir = 0; dbg.phase = 'kb-off'; dbg.steerOut = out.steer; dbg.throttleOut = out.throttle;
        return out;
      }
      if (L.raw) { st.phase = 'grip'; st.dir = 0; st.kbD = null; st.kbThr = null; return out; }

      var maxV = vehMaxSteer(p, vF, grip, o.maxSteer);
      // keyboard drift model (light / medium): the rack limit follows the slide (input.slideRack) so the counter-steer
      // the assist asks for at speed is really there
      var kbRack = mode === 'drift' && L.tapSafe && !L.pilot && isDigital(raw) && v > 3;
      if (kbRack) { maxV = slideRackMax(p, o, vF, grip); out.slideRack = true; }
      var lock = num(p.lockAngle, num(p.maxSteer, maxV));
      var delta;   // commanded front-wheel angle (rad, + left)

      // spun: sliding backwards or broadside in a forward gear -> scrub the speed, wheels straight, no power
      var spunNow = !o.reversing && v > 2.5 && (o.backwards || Math.abs(o.beta) > 100 * DEG ||
                    (o.vx < 1 && Math.abs(o.vy) > 3));
      if (L.spinGuard > 0 && (spunNow || (st.spun > 0 && v > 2.5 && !o.reversing))) {
        if (spunNow) st.spun = 0.35; else st.spun -= dt;
        st.phase = 'grip'; st.dir = 0; st.holdAngle = 0;
        out.throttle = ped.thr * (1 - L.spinGuard);
        out.brake = Math.max(ped.brk, 0.8 * L.spinGuard);
        out.handbrake = false;
        out.steer = 0;
        st.outSteerRad = 0;
        if (st.pl) st.pl.dF = null;
        dbg.phase = 'spin'; dbg.recovering = true;
        return out;
      }
      st.spun = 0;

      if (o.reversing || v < 1.0) {
        // reversing / parking: plain smooth steering, no stability logic
        st.phase = 'grip'; st.dir = 0;
        delta = u * maxV;
        dbg.phase = o.reversing ? 'reverse' : 'stopped';
        out.steer = clamp(delta / maxV, -1, 1);
        st.outSteerRad = delta;
        if (st.pl) st.pl.dF = null;
        return out;
      }

      var geom = ctx.geom || null;
      var proj = projectCar(geom, o, st, ctx.proj);
      st.nearby = ctx.race && Array.isArray(ctx.race.nearby) ? ctx.race.nearby : Array.isArray(ctx.nearby) ? ctx.nearby : null;

      if (mode === 'drift' && L.pilot && geom && proj && geom.samples && (delta = pilotControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, geom, proj)) != null) {
        /* drift pilot owns the car (heavy / auto with a track) */
      } else if (mode === 'drift') {
        if (st.pl) st.pl.dF = null;
        delta = driftControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, geom, proj);
        if (L.driftTrack > 0 && geom && proj && geom.samples) delta = driftTrackLayer(o, p, grip, ped, out, dt, maxV, lock, geom, proj, delta);
      }
      else delta = raceControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, geom, proj);

      st.outSteerRad = delta;
      out.steer = clamp(delta / maxV, -1, 1);
      out.throttle = clamp(out.throttle, 0, 1);
      out.brake = clamp(out.brake, 0, 1);
      dbg.steerOut = out.steer; dbg.throttleOut = out.throttle; dbg.brakeOut = out.brake;
      return out;
    }

    /* ---------------------------------------------------------- keyboard drift steering ('off', drift mode)
       The arrows steer RELATIVE TO THE SLIDE: with no key the front wheels self-align with the front axle's
       travel direction (the automatic counter-steer a real car's caster gives when you relax your hands);
       a key turns the wheels from there by a speed-sensitive reach. The wheel moves at a speed- and
       slip-sensitive rate (quick when catching a slide, gentle at speed in grip) so a tap is a small,
       proportional correction instead of a full-lock flick. Throttle is ramped (a key is 0 -> 100 % in ~0.2 s).
       Nothing else: no angle hold, no spin guard — the angle is the player's throttle and steering. */
    function kbOff(raw, o, p, grip, ped, out, dt) {
      var v = o.speed, vF = Math.max(Math.abs(o.vx), 0), dbg = st.dbg;
      var key = (raw.left ? 1 : 0) - (raw.right ? 1 : 0);
      var wb = num(p.wheelbase, 2.65), lock = num(p.lockAngle, num(p.maxSteer, 0.6));
      var aCG = num(p.a, wb * 0.48);
      var betaF = Math.atan2(o.vy + o.r * aCG, Math.max(vF, 3));          // front axle travel direction (car frame)
      var on = smooth01(KB.offMinSpeed, KB.offMinSpeed + 4, v);
      var slideK = smooth01(4 * DEG, 12 * DEG, Math.abs(o.beta));
      if (st.kbBase == null) st.kbBase = 0;
      // + a lead on the sideslip RATE (the quick counter-steer flick a sliding car's caster gives on its own)
      var lead = clamp(st.betaRate * KB.offRateLead, -KB.offLeadMax, KB.offLeadMax) * on;
      st.kbBase += ((betaF * KB.offAlign + lead) * on - st.kbBase) * (1 - Math.exp(-dt / KB.alignTau));
      // reach: full lock at parking speeds, the grip-optimal angle (x reachGrip) at speed; sliding keeps more
      var gS = Math.min(lock, gripSteer(p, vF, grip));
      var reach = lerp(lock, Math.min(lock, gS * lerp(KB.reachGrip, KB.reachSlide, slideK)), smooth01(6, 22, v));
      if (st.kbOffs == null) st.kbOffs = 0;
      var tgtOff = key * reach;
      var rate = KB.offRate * lerp(1, KB.slideRate, slideK) / (1 + v / KB.rateV);
      if (key === 0 || sign(st.kbOffs) === -key) rate *= KB.returnK;                 // release / reverse: back faster
      st.kbOffs = approach(st.kbOffs, tgtOff, rate * dt);
      var delta = clamp(st.kbBase + st.kbOffs, -lock, lock);
      // throttle ramp: a digital Up is 0 -> 1 in ~1 / thrUp s (feathering = tapping Up), lifts faster
      if (st.kbThr == null) st.kbThr = ped.thr;
      st.kbThr = approach(st.kbThr, ped.thr, (ped.thr > st.kbThr ? KB.thrUp : KB.thrDown) * dt);
      out.throttle = st.kbThr;
      st.outSteerRad = delta;
      dbg.counterSteer_deg = st.kbBase / DEG; dbg.kbReach_deg = reach / DEG; dbg.kbOffset_deg = st.kbOffs / DEG;
      return delta;
    }

    /** Stateful throttle limiter: backs off while the driven wheels spin past `target`, recovers smoothly. */
    function tractionLimit(thr, spin, dt, target, k) {
      if (!(k > 0)) { st.tcf = 1; return thr; }
      // feedback on measured spin
      if (spin > target && thr > 0.05) st.tcf = Math.max(TC.minF, st.tcf - dt * TC.cut * (spin - target + 0.2));
      else st.tcf = Math.min(1, st.tcf + dt * TC.recover);
      st.dbg.tc = 1 - st.tcf;
      return thr * lerp(1, st.tcf, k);
    }

    /* ---------------------------------------------------------- race mode */
    function raceControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, geom, proj, Lo) {
      var LL = Lo || L;
      var dbg = st.dbg, v = o.speed, vF = Math.abs(o.vx), wb = num(p.wheelbase, 2.65);
      dbg.phase = 'race'; st.phase = 'grip'; st.dir = 0;
      // speed-sensitive lock: lerp(vehicle max, grip-optimal) by level
      var gripMax = Math.min(maxV, gripSteer(p, vF, grip));
      var dMax = lerp(maxV, gripMax, LL.lockSpeedSens);
      var delta = u * dMax;
      var noKey = Math.abs(u) < 0.05 && !(isFinite(raw.steerAxis) && Math.abs(raw.steerAxis) > 0.04);
      // analog wheel (phone tilt / wheel): steering stays proportional to the wheel angle; the line picking (line hold,
      // lane keeping, corner blend) is for digital keys. Stability, counter-steer, edge guard and braking help remain.
      var analog = !!raw.steerAnalog && level !== 'auto';
      if (analog) noKey = false;
      var spdOn = smooth01(4, 10, v);

      // ---- line hold (heavy / auto): at speed the arrows pick the line across the road, the assist steers it
      var lineW = 0, lh = null;
      if (LL.lineHold > 0 && !analog && geom && proj && geom.samples && isFinite(proj.lateral)) {
        lh = lineHold(o, p, grip, u, dt, geom, proj, wb);
        if (lh) {
          lineW = LL.lineHold * smooth01(RACE.lineV0, RACE.lineV1, v);
          delta = lerp(delta, clamp(lh.delta, -maxV, maxV), lineW);
          dbg.lineOff = lh.off; dbg.lineBias = st.lineBias; dbg.lineSpeed_kph = lh.vt * 3.6; dbg.lineHold = lineW;
        }
      }
      var freeW = 1 - lineW;

      // ---- track awareness (lane keeping, corner blend, edge guard, recovery)
      var offTrack = proj && proj.onTrack === false;
      if (geom && proj && geom.samples) {
        var look = clamp(6 + v * 0.75, 8, 60);
        var rlFn = function (sm) { return num(sm.racingLine, 0); };
        var dLine = pursuit(geom, proj, o, look, rlFn, wb);
        if (dLine != null) {
          dLine = clamp(dLine, -dMax, dMax);
          if (offTrack && LL.recovery > 0) {
            var dCen = pursuit(geom, proj, o, clamp(5 + v * 0.6, 7, 40), function () { return 0; }, wb);
            delta = lerp(delta, clamp(dCen, -maxV, maxV), 0.75 * LL.recovery * freeW);
            out.throttle = Math.min(out.throttle, lerp(1, 0.55, LL.recovery));
            dbg.recovering = true; st.recover = 0.6;
            // heading further away from the track: scrub speed so the car can turn back
            var thd = num(proj.heading, NaN);
            if (isFinite(thd) && isFinite(proj.lateral)) {
              var away = Math.sin(wrap(o.heading + o.beta - thd)) * sign(proj.lateral);
              if (away > 0.05 && v > 12) { out.brake = Math.max(out.brake, clamp(away * 2, 0, 0.5) * LL.recovery); out.throttle = 0; }
            }
          } else if (lineW > 0.5) {
            /* line hold steers */
          } else if (noKey && LL.laneKeep > 0) {
            // gentle near the line, firmer the further the car has wandered from it
            var dev = isFinite(proj.lateral) ? Math.abs(proj.lateral - num(proj.racingLine, 0)) : 0;
            var lk = LL.laneKeep * lerp(1, 2.2, smooth01(1.5, 5, dev));
            delta = lerp(delta, dLine, clamp(lk, 0, 0.85) * spdOn);
            dbg.laneKeep_deg = dLine / DEG;
          } else if (LL.cornerBlend > 0 && !analog && sign(dLine) === sign(delta) && Math.abs(dLine) > 0.004) {
            // pressing toward the corner: nudge the angle toward what the corner needs
            delta = lerp(delta, dLine, LL.cornerBlend * spdOn);
          }
          // edge guard: approaching the track edge -> pull back in, whatever the input
          if (LL.edgeGuard > 0 && isFinite(proj.lateral)) {
            var hw = num(proj.halfWidth, 6), lat = proj.lateral;
            var th = num(proj.heading, NaN);
            var hErr = isFinite(th) ? wrap(o.heading + o.beta - th) : 0;   // + = travelling leftward vs track
            var latRate = v * Math.sin(hErr);
            var predicted = lat + latRate * 0.6;
            var margin = hw - Math.abs(predicted);
            if (margin < 1.6 && sign(predicted) === sign(latRate || predicted)) {
              var g = clamp((1.6 - margin) / 2.0, 0, 1) * LL.edgeGuard;
              var dCen2 = pursuit(geom, proj, o, look * 0.6, function (sm) { return sign(lat) * Math.max(0, num(sm.hw, hw) - 2.5) * 0.3; }, wb);
              if (dCen2 != null) delta = lerp(delta, clamp(dCen2, -maxV, maxV), g);
              dbg.edgeGuard = g;
              // running out of road at the grip limit: scrub some speed too
              var lu0 = Math.abs(v * o.r) / Math.max(1, latAccelAt(p, v, grip));
              var margin2 = hw - Math.abs(lat + latRate * 1.1);
              if (lu0 > 0.45 && margin2 < 1.2 && v > 5) {
                st.edgeBrake = clamp((1.2 - margin2) * 0.45, 0, RACE.edgeBrakeMax) * LL.edgeGuard;
              }
            }
          }
        }
      }

      // ---- axle slip: is the rear past its peak (a real slide) or just working hard in a fast corner?
      var aCG = num(p.a, num(p.wheelbase, 2.65) * 0.48), bCG = num(p.b, num(p.wheelbase, 2.65) * 0.52);
      var vxs = Math.max(vF, 3);
      var aR = Math.atan2(o.vy - o.r * bCG, vxs);
      var betaF = Math.atan2(o.vy + o.r * aCG, vxs);
      var apR = Math.atan(num(p.tanAlphaPeakR, 0.15)), apF = Math.atan(num(p.tanAlphaPeakF, 0.15));
      var satR = smooth01(0.9 * apR, 1.6 * apR, Math.abs(aR)) * spdOn;
      dbg.rearSat = satR;

      // ---- yaw-rate tracking: the car rotates as fast as the steering asks (within grip), no more, no less
      if (LL.yawStab > 0 && v > 8) {
        var rGrip = latAccelAt(p, v, grip) * 0.95 / v;
        var rRef = clamp(v * Math.tan(delta) / num(p.wheelbase, 2.65), -rGrip, rGrip);
        var yt = RACE.kYaw * LL.yawStab * smooth01(8, 20, v) * (rRef - o.r);
        delta += yt;
        dbg.yawTrack_deg = yt / DEG;
      }

      // ---- front-slip limiter: never steer the fronts far past their peak slip (pure scrub / understeer)
      var slipK = num(LL.slipLimit, LL.lockSpeedSens);
      var arc = isArc(p);   // arcade cars never slide: no front-slip limiter / slide throttle cuts (they only cost pace)
      if (slipK > 0 && v > 8 && !arc) {
        var fs = lerp(2.5, 1.05, slipK) * apF * (1.3 - 0.3 * smooth01(10, 25, v));
        delta = clamp(delta, betaF - fs, betaF + fs);
      }

      // ---- counter-steer (catches slides): toward the travel direction, scaled by how far the rear is gone
      var cs = arc ? 0 : LL.counterSteer * softDead(o.beta, LL.csDead) * lerp(0.15, 1, satR) * spdOn;   // arcade powerslides are intended
      delta += cs;
      dbg.counterSteer_deg = cs / DEG;

      // ---- yaw stabilization: yaw rate beyond what grip can sustain / rear past peak
      var rMax = latAccelAt(p, Math.max(v, 3), grip) / Math.max(v, 3) * 1.15;
      var rEx = Math.max(0, Math.abs(o.r) - rMax);
      var overS = satR > 0.05 && sign(o.beta) === -sign(o.r);       // tail out, nose rotating past the path
      var asksMore = sign(u) === sign(o.r) && Math.abs(u) > 0.5;
      if ((rEx > 0 || overS) && LL.yawStab > 0 && !arc) {
        var ys = -sign(o.r) * (rEx * 0.3 + (overS ? satR * Math.abs(o.beta) * 0.35 : 0)) * LL.yawStab * (asksMore ? 0.6 : 1);
        delta += ys;
        dbg.yawStab_deg = ys / DEG;
        // throttle to a neutral, rear-settling value (a full lift would make a RWD car snap round)
        var k = clamp(Math.max(satR * 1.8, rEx / Math.max(rMax, 0.1)), 0, 1) * LL.thrLift;
        var neutral = 0.28;
        out.throttle = out.throttle > neutral ? lerp(out.throttle, neutral, k) : lerp(out.throttle, Math.min(neutral, ped.thr > 0.1 ? neutral : 0.12), k * 0.6);
        out.brake *= 1 - 0.75 * k;
        dbg.throttleCut = k;
      }

      // ---- traction limiting: wheelspin + friction circle (no full power while the tyres are busy cornering)
      out.throttle = tractionLimit(out.throttle, spinOf(o, p), dt, RACE.spinTarget, LL.tractionLimit);
      if (LL.tractionLimit > 0 && v > 8 && !arc) {
        var latUse = Math.abs(v * o.r) / Math.max(1, latAccelAt(p, v, grip));
        var circ = lerp(1, 0.3, smooth01(0.7, 1.0, latUse) * LL.tractionLimit);
        if (num(p.layout, 0) === 'fwd' || p.layout === 'awd') circ = lerp(circ, 1, 0.4);
        out.throttle = Math.min(out.throttle, Math.max(circ, ped.thr > 0 ? 0 : 0));
        dbg.latUse = latUse;
      }

      // ---- line-hold speed governor: arrive at every corner of the CHOSEN line at a speed the tyres can carry
      if (lineW > 0 && lh && isFinite(lh.vt) && ped.brk < 0.5) {
        var overL = v - lh.vt;
        if (overL > 0.3) {
          var bL = clamp((overL - 0.3) / 1.5, 0, 1) * lineW * (1 - 0.6 * satR);
          out.brake = Math.max(out.brake, bL);
          out.throttle *= 1 - clamp(bL * 4 + 0.5 * lineW, 0, 1);
          dbg.lineBrake = bL;
        } else if (overL > -2.5) {
          out.throttle = Math.min(out.throttle, lerp(1, clamp(0.3 + (-overL) / 2.5 * 0.7, 0.3, 1), lineW));
        }
      }

      // ---- brake assist: auto-brake toward the racing-line speed profile
      if (LL.brakeAssist > 0 && geom && proj && !offTrack && ped.brk < 0.5) {
        var prof = profileFor(geom, p, LL.brakeAssist >= 0.99);
        if (prof) {
          var N = prof.length, ds = num(geom.ds, 2);
          var ahead = Math.round((v * RACE.brakeLook + 2) / ds);
          var vt = Infinity;
          for (var k = 0; k <= ahead; k++) vt = Math.min(vt, prof[mod(proj.index + k, N)]);
          vt *= lerp(1.08, 0.97, LL.brakeAssist) / Math.sqrt(Math.max(0.5, 1 / grip));
          var over = v - vt;
          var bm = LL.brakeMargin * clamp(v / 40, 0.35, 1);
          if (over > bm) {
            var b = clamp((over - bm) / RACE.brakeRamp, 0, 1) * LL.brakeAssist * (1 - 0.8 * satR);
            out.brake = Math.max(out.brake, b);
            out.throttle *= 1 - clamp(b * 4, 0, 1);
            dbg.brakeAssist = b;
          } else if (over > -1.5 && LL.brakeAssist >= 0.99) {
            out.throttle = Math.min(out.throttle, clamp((-over) / 1.5 * 0.7 + 0.3, 0.3, 1));
          }
          dbg.targetSpeed_kph = vt * 3.6;
        }
      }
      if (st.edgeBrake > 0 && !offTrack) {
        out.brake = Math.max(out.brake, st.edgeBrake * (1 - 0.8 * satR));
        out.throttle = Math.min(out.throttle, RACE.edgeThr);
        dbg.edgeBrake = st.edgeBrake;
      }
      st.edgeBrake = 0;
      if (st.recover > 0) st.recover -= dt;

      // ---- traffic guard: closing fast on a car in our lane -> lift / brake to its speed (and ease the line aside)
      if (LL.lineHold > 0 && st.nearby && v > 8) trafficGuard(o, out, lineW, dt, raw);

      // ---- hard spin guard: the sideslip (and where it is heading) never passes a catchable angle
      if (LL.raceSpin > 0 && v > 5 && !arc) {
        var bPred = o.beta + clamp(st.betaRate, -3, 3) * 0.15;
        var sg = Math.max(smooth01(RACE.spinBeta0, RACE.spinBeta1, Math.abs(o.beta)),
                          sign(bPred) === sign(o.beta) ? smooth01(RACE.spinBeta0 * 1.3, RACE.spinBeta1 * 1.3, Math.abs(bPred)) : 0) * LL.raceSpin;
        if (sg > 0) {
          // fronts along the front-axle travel direction (no front force into the spin) + yaw damping
          var dCatch = clamp(betaF - 0.12 * o.r, -lock, lock);
          delta = lerp(delta, dCatch, sg);
          out.throttle = lerp(out.throttle, Math.min(out.throttle, 0.18), sg);
          out.brake = lerp(out.brake, 0, sg);
          out.handbrake = false;
          dbg.spinGuard = sg; dbg.recovering = true;
        }
      }
      return clamp(delta, -lock, lock);
    }

    /** Brake for slower traffic ahead in our lane (car-relative frame from engine ctx.nearby). */
    function trafficGuard(o, out, lineW, dt, raw) {
      var c = Math.cos(o.heading), sn = Math.sin(o.heading), worst = 0, dodge = 0, dbg = st.dbg;
      for (var i = 0; i < st.nearby.length; i++) {
        var q = st.nearby[i];
        if (!q || q.isPlayer || !isFinite(q.ahead) || !isFinite(q.side)) continue;
        var len = num(q.length_m, 4.5), wid = num(q.width_m, 1.9);
        var gap = q.ahead - len;                                   // ~bumper to bumper
        if (q.ahead <= 0.5 || gap > RACE.trafLook) continue;
        var lane = Math.abs(q.side) < Math.max(RACE.trafHalfW, wid + 0.4);
        var vo = num(q.vx, 0) * c + num(q.vy, 0) * sn, close = o.vx - vo;
        if (!lane || close < 0.5) continue;
        var room = Math.max(0.3, gap - RACE.trafGap);
        var need = close * close / (2 * room);                     // decel to match its speed before the gap closes
        var b = clamp((need - 0.5 * RACE.trafDecel) / RACE.trafDecel, 0, 1);
        if (b > worst) worst = b;
        if (gap < 18 && close > 1.5) dodge = Math.abs(dodge) > 0 && Math.abs(dodge) < Math.abs(q.side) ? dodge : (q.side >= 0 ? -1 : 1);
      }
      if (worst > 0) {
        out.brake = Math.max(out.brake, worst * lineW);
        out.throttle *= 1 - clamp(worst * 3, 0, 1) * lineW;
        dbg.traffic = worst;
      }
      // no arrow held: slide the chosen line to the free side of the car ahead (an overtake, not a nudge)
      if (dodge && RACE.trafDodge > 0 && !raw.left && !raw.right) {
        st.lineBias += dodge * RACE.lineRate * RACE.trafDodge * dt;
        dbg.trafficDodge = dodge;
      }
    }

    /** Line hold (race mode, heavy / auto): the arrows move a target line across the road (released: back to the
        racing line); pure pursuit of the velocity vector onto it + a speed governor on that line's curvature. */
    function lineHold(o, p, grip, u, dt, geom, proj, wb) {
      var S = geom.samples, N = S.length, ds = num(geom.ds, 2), E = RACE.lineEdge, v = o.speed;
      if (!N || !isFinite(proj.index)) return null;
      var idx = mod(Math.round(proj.index), N), sm0 = S[idx];
      var hw0 = num(proj.halfWidth, num(sm0.hw, 5)), room0 = Math.max(0.2, hw0 - E);
      var rl0 = clamp(num(proj.racingLine, num(sm0.racingLine, 0)), -room0, room0);
      var lat = num(proj.lateral, 0);
      if (v < RACE.lineV0) st.lineBias = clamp(lat, -room0, room0) - rl0;             // slow: the line starts where the car is
      else if (Math.abs(u) > 0.05) st.lineBias = approach(st.lineBias, sign(u) * room0 - rl0, RACE.lineRate * Math.abs(u) * lerp(1, 0.45, smooth01(25, 50, v)) * dt);
      else st.lineBias = approach(st.lineBias, 0, RACE.lineBack * dt);
      st.lineBias = clamp(st.lineBias, -room0 - rl0, room0 - rl0);
      var bias = st.lineBias;
      function lineAt(sm) { var r = Math.max(0.2, num(sm.hw, hw0) - E); return clamp(num(sm.racingLine, 0) + bias, -r, r); }
      // look-ahead grows faster above ~110 km/h: a short pursuit point at speed weaves (steering + tyre lag)
      var look = clamp(RACE.lineLook0 + v * RACE.lineLookV, 6, RACE.lineLookMax) + Math.max(0, v - 30) * RACE.lineLookV2 * 2;
      var ov = { x: o.x, y: o.y, heading: o.heading + o.beta };
      var d = pursuit(geom, proj, ov, look, lineAt, wb);
      if (d == null) return null;
      // online grip estimate: fronts past their peak and still not turning as asked -> the car has less grip than planned
      var a0 = num(p.maxLatG, 1) * G * grip;
      var aCG = num(p.a, wb * 0.48), betaF = Math.atan2(o.vy + o.r * aCG, Math.max(Math.abs(o.vx), 3));
      var apF = Math.atan(num(p.tanAlphaPeakF, 0.15)), aF = Math.abs(o.steer - betaF);
      var ay = Math.abs(v * o.r);
      if (v > 10 && aF > apF * 1.05 && ay > 0.3 * a0) st.gEst = approach(st.gEst, clamp(ay / (a0 * RACE.latSafe) * 0.97, 0.65, 1), 0.4 * dt);
      else st.gEst = approach(st.gEst, 1, 0.03 * dt);
      // speed governor on the chosen line
      var aLat = a0 * RACE.latSafe * st.gEst, aBrk = num(p.maxBrakeG, 1.1) * G * grip * RACE.brkSafe;
      var react = v * RACE.govLook_s, horizon = react + v * v / (2 * aBrk) + 6;
      var nA = Math.min(N - 1, Math.ceil(horizon / ds)), vt = Infinity;
      for (var q = 0; q <= nA; q++) {
        var sm = S[(idx + q) % N], k = num(sm.curvature, 0);
        if (Math.abs(k) < 1e-4) continue;
        var den = Math.max(0.25, 1 - k * lineAt(sm)), kp = Math.abs(k) / den;
        var dist = Math.max(0, q * ds - react);
        var va = Math.sqrt(aLat / kp + 2 * aBrk * dist);
        if (va < vt) vt = va;
      }
      return { delta: d, off: lineAt(sm0), vt: Math.max(6, vt) };
    }

    /* ---------------------------------------------------------- drift mode */
    function driftControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, geom, proj) {
      var dbg = st.dbg, v = o.speed, b = o.beta;
      var H = L.angleHold, I = L.init, CS = L.driftCs, CSg = num(L.gripCs, L.driftCs);
      var steerKey = Math.abs(u) > 0.3 ? sign(u) : 0;
      var keyNow = (raw.left ? 1 : 0) - (raw.right ? 1 : 0);
      if (isFinite(raw.steerAxis) && Math.abs(raw.steerAxis) > 0.3) keyNow = sign(raw.steerAxis);
      var prevKey = num(st.keyDir, 0), prevKeyT = num(st.keyT, 0);
      st.keyT = keyNow !== 0 && keyNow === st.keyDir ? num(st.keyT, 0) + dt : (keyNow ? dt : 0);
      st.keyDir = keyNow;
      var tapSafe = !!L.tapSafe;
      // keyboard drift model (light / medium, digital arrows): the arrows steer relative to the slide —
      // released = hold the angle, a quick tap of the opposite arrow = switchback (manji)
      var kbd = tapSafe && isDigital(raw);
      if (st.tapSwing > 0) st.tapSwing -= dt;
      if (kbd) {
        if (keyNow !== 0 && keyNow !== prevKey) st.tapFrom = st.phase === 'drift' && keyNow === -st.dir && -st.dir * b > 8 * DEG ? st.dir : 0;
        if (st.tapFrom && keyNow === -st.tapFrom && st.keyT > KB.tapMax_s) st.tapFrom = 0;          // a held counter: straighten
        if (st.tapFrom && keyNow === 0 && prevKey === -st.tapFrom && prevKeyT >= KB.tapMin_s && prevKeyT <= KB.tapMax_s &&
            v > DRIFT.initSpeed * 0.8 && ped.thr > 0.2 && L.init > 0 && !L.noSwing) {
          st.swHold = clamp(Math.max(-st.tapFrom * b, st.holdAngle) * 0.9, DRIFT.minAngle, DRIFT.maxAngle);   // mirror the old slide
          st.dir = -st.tapFrom; st.phase = 'init'; st.timer = 0; st.flick = 0; st.swing = 0.4; st.tapSwing = 0.6; st.tapFrom = 0;
          st.holdAngle = Math.max(st.holdAngle, DRIFT.baseAngle); st.relT = 0;
          dbg.switchback = true;
        }
      }
      var delta;
      // initiation strength: a full flick at drift speeds, a gentle weight-transfer kick at high speed
      var kick = 1 - 0.65 * smooth01(DRIFT.kickV0, DRIFT.kickV1, v);

      // -------- phase transitions
      if (st.initBlock > 0) st.initBlock -= dt;
      var canKick = I > 0 && !(st.initBlock > 0);
      if (st.phase === 'grip') {
        var already = Math.abs(b) > DRIFT.enterAngle && v > 6;
        if (already && v < DRIFT.initMaxSpeed * 1.2 && (canKick ? (steerKey === -sign(b) || Math.abs(b) > 16 * DEG) : Math.abs(b) > 30 * DEG)) {      // natural slide picked up
          st.phase = 'drift'; st.dir = -sign(b); st.timer = 0;
        } else if (canKick && steerKey && v > DRIFT.initSpeed && v < (tapSafe ? DRIFT.safeKickSpeed : DRIFT.initMaxSpeed * lerp(1.6, 1, L.spinGuard)) && (ped.thr > 0.3 || raw.handbrake)) {
          st.phase = 'init'; st.dir = steerKey; st.timer = 0; st.flick = DRIFT.flick_s * I * kick * kick; st.stallT = 0;
        } else if (canKick && steerKey && ped.thr > 0.5 && v > DRIFT.stallSpeed && v <= DRIFT.initSpeed) {
          // circling under power below the kick speed (traction-limited, not gaining speed): kick it anyway
          if (st.acc < DRIFT.stallAcc) st.stallT += dt; else st.stallT = Math.max(0, st.stallT - dt);
          if (st.stallT > DRIFT.stall_s) { st.phase = 'init'; st.dir = steerKey; st.timer = 0; st.flick = DRIFT.flick_s * I; st.stallT = 0; }
        } else st.stallT = 0;
      } else if (st.phase === 'init') {
        st.timer += dt;
        var A0 = -st.dir * b, A0r = -st.dir * st.betaRate;
        if (A0 + Math.max(0, A0r) * DRIFT.predT > DRIFT.enterAngle * lerp(0.7, 1, kick)) { st.phase = 'drift'; st.timer = 0; }
        else if (st.timer > DRIFT.initMax_s * (st.tapSwing > 0 ? 1.6 : 1) || steerKey === -st.dir || v < 5) { st.phase = 'grip'; st.dir = 0; }
        // the rear is stepping out the OTHER way (snap-back / pendulum): no kick, catch it in the grip phase
        // (except in a keyboard switchback: there the car is meant to swing through from the old side)
        else if (!(st.tapSwing > 0) && (A0 < -6 * DEG || (A0 < 2 * DEG && st.dir * o.r < -0.6 && st.timer > 0.05))) { st.phase = 'grip'; st.dir = 0; st.flick = 0; st.swing = 0; }
        // tap-safe levels: the kick only runs while the arrow is held (a quick tap / correction never throws the car)
        else if (tapSafe && keyNow !== st.dir && st.timer > 0.05 && !(st.swing > 0 && keyNow === 0 && st.timer < 0.12) && !(st.tapSwing > 0 && keyNow === 0)) { st.phase = 'grip'; st.dir = 0; st.flick = 0; st.swing = 0; }
      } else if (st.phase === 'drift') {
        st.timer += dt;
        var Ad = -st.dir * b;
        if (steerKey === -st.dir && Ad < 14 * DEG && ped.thr > 0.2 && v > DRIFT.initSpeed * 0.8 && I > 0 &&
            (!tapSafe || (!L.noSwing && keyNow === -st.dir && st.keyT > 0.45))) {
          // swing / transition into the other direction
          st.dir = -st.dir; st.phase = 'init'; st.timer = 0; st.flick = 0; st.swing = 0.4;
        } else if (Ad < DRIFT.exitAngle && steerKey !== st.dir) { st.phase = 'grip'; st.dir = 0; }
        else if (Ad < -6 * DEG) { st.phase = 'grip'; st.dir = 0; }
        else if (v < 4) { st.phase = 'grip'; st.dir = 0; }
        // asking for angle but the rear has hooked up (grippy / low-power car): re-kick it
        // (never while the car is snapping back the other way: a kick then throws it into the opposite spin)
        var snapBack = Ad < 2 * DEG && st.dir * o.r < -0.25;
        if (st.phase === 'drift' && steerKey === st.dir && Ad < DRIFT.enterAngle * 0.8 && I > 0 && !snapBack) {
          st.lowT += dt;
          if (st.lowT > 0.3 && v > DRIFT.initSpeed) { st.phase = 'init'; st.timer = 0; st.flick = DRIFT.flick_s * I * kick * kick; st.lowT = 0; }
        } else st.lowT = 0;
      }

      var d = st.dir;
      dbg.driftDir = d; dbg.phase = st.phase;
      // just out of a slide (the window in which a RWD car snaps back the other way)
      st.postSlide = st.phase === 'drift' ? 1.2 : Math.max(0, num(st.postSlide, 0) - dt);

      if (st.phase === 'grip' && v > DRIFT.initMaxSpeed * 0.85) {
        // too fast to drift safely: drive it like race mode (yaw tracking, slide catching), no track pulls
        var dHi = raceControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, null, null, L.highMix > 0 ? mixLevel(L, LEVELS.heavy, L.highMix) : L.spinGuard >= 0.5 ? LEVELS.heavy : L);
        var wHi = smooth01(DRIFT.initMaxSpeed * 0.85, DRIFT.initMaxSpeed, v);
        var dLo = u * lerp(maxV, Math.min(maxV, gripSteer(p, Math.abs(o.vx), grip) * 1.25), L.lockSpeedSens * 0.6) + CSg * softDead(b, L.csDead);
        st.phase = 'grip'; st.dir = 0; dbg.phase = 'grip-fast';
        return clamp(lerp(dLo, dHi, wHi), -lock, lock);
      }
      if (st.phase === 'grip') {
        // free driving with lots of lock, but stable
        var dMax = lerp(maxV, Math.min(maxV, gripSteer(p, Math.abs(o.vx), grip) * 1.25), L.lockSpeedSens * 0.6);
        delta = u * dMax;
        // under drift speed with the throttle down: open the circle up so the car builds speed (no tight donuts)
        if (v < DRIFT.initSpeed * 1.15 && ped.thr > 0.4 && I > 0) {
          var Rm = Math.max(DRIFT.launchRadius, v * v / (DRIFT.launchG * G * grip));
          var capD = Math.atan(num(p.wheelbase, 2.65) / Rm);
          delta = clamp(delta, -lerp(dMax, capD, I), lerp(dMax, capD, I));
        }
        var cs = CSg * softDead(b, L.csDead) * smooth01(3, 8, v);
        delta += cs;
        dbg.counterSteer_deg = cs / DEG;
        // straightening out of a drift: let the throttle come back gently
        if (Math.abs(b) > 4 * DEG && v > 6) out.throttle *= 1 - clamp((Math.abs(b) - 4 * DEG) / (14 * DEG), 0, 0.6) * L.thrLift;
        // no drift requested: no donut-spinning / power slides — traction-limit the throttle, damp the yaw
        out.throttle = tractionLimit(out.throttle, spinOf(o, p), dt, DRIFT.spinTarget, num(L.driftTc, L.tractionLimit));
        if (tapSafe && v > 2) {
          // power-oversteer guard (no drift asked for yet): the car rotating much faster than the steering asks
          // means the rears are spinning it round — lift toward a rolling throttle and catch it with the fronts
          var rAsk = v * Math.tan(delta) / num(p.wheelbase, 2.65);
          var rOver = sign(o.r) * (o.r - rAsk);
          var rG = latAccelAt(p, Math.max(v, 3), grip) / Math.max(v, 3);
          var po = clamp((rOver - 0.15 * rG - 0.1) / (0.35 * rG + 0.2), 0, 1) * L.spinGuard;
          if (sign(b) === -sign(o.r) && Math.abs(b) > 6 * DEG) po = Math.max(po, smooth01(6 * DEG, 16 * DEG, Math.abs(b)) * L.spinGuard);
          if (po > 0) {
            out.throttle = Math.min(out.throttle, lerp(out.throttle, 0.06, po));
            delta = lerp(delta, clamp(-sign(o.r) * maxV * 0.5 + CSg * b, -maxV, maxV), po);
            dbg.powerOver = po;
          }
        }
        if (!steerKey && v > 6) {
          var yd = -o.r * DRIFT.kYawGrip * L.yawStab * smooth01(6, 14, v);
          delta += yd;
          dbg.yawStab_deg = yd / DEG;
        }
        return clamp(delta, -lock, lock);
      }

      if (st.phase === 'init') {
        // kick the rear out: full lock into the turn, flick the handbrake, then floor it
        delta = d * maxV * lerp(0.55, 1, kick);
        if (st.flick > 0) { out.handbrake = true; out.throttle = st.swing > 0 ? 1 : 0.35; st.flick -= dt; }
        else out.throttle = Math.max(out.throttle, 1 * I);
        if (st.swing > 0) st.swing -= dt;
        out.brake = 0;
        dbg.targetAngle_deg = DRIFT.baseAngle / DEG * d * -1;
        return clamp(delta, -lock, lock);
      }

      // -------- DRIFT: angle hold
      var A = -d * b;                         // current drift angle (+)
      var Ar = -d * st.betaRate;              // its rate
      if (L.growBoost > 0) {
        // light: the catch firms up toward heavy as the slide gets dangerous — still growing, or near the angle the
        // rack can still catch at this speed (a settled, moderate slide stays the player's to straighten)
        var aLim = lerp(DRIFT.maxAngle, 15 * DEG, smooth01(14, 30, v));
        var danger = Math.max(smooth01(0.0, 0.25, Ar), smooth01(aLim * 0.95, aLim * 1.2, A), u * d > 0.1 ? 1 : 0);
        // on a track the catch stays firm (a lingering slide there ends in a wall); with no track geometry
        // (skidpad / free roam) a settled slide is left more to the player
        if (geom && proj) danger = Math.max(danger, num(L.trackCatch, 0));
        // on a track the held slide is caught nearly as firmly as medium (a 3 s hold at 80 km/h must not spin)
        var hCs = geom && proj ? num(L.heldCsTrack, L.heldCs) : L.heldCs;
        H = lerp(H, Math.max(H, L.heldHold), danger); CS = lerp(CS, Math.max(CS, hCs), danger);
        dbg.catchFirm = danger;
      }
      var w = u * d;                          // + into the drift, - counter
      var tgt;
      if (w > 0.1) {
        tgt = DRIFT.baseAngle * (0.55 + 0.45 * w) + DRIFT.thrAngle * ped.thr + DRIFT.brakeAngle * ped.brk;
        tgt = clamp(tgt, DRIFT.minAngle, DRIFT.maxAngle);
      } else if (w < -0.1) tgt = 0;                       // counter key: straighten quickly
      else if (kbd) {
        // released (keyboard): HOLD the slide — the angle it has now, steadily — for a moment at full throttle, then
        // unwind gently; lifting unwinds it quickly; on a track the slide unwinds as the road straightens out
        if (!(st.relT > 0)) st.holdAngle = st.swHold > 0 ? Math.max(st.swHold, st.holdAngle) : clamp(lerp(st.holdAngle, A, 0.5), DRIFT.minAngle, DRIFT.maxAngle);
        st.swHold = 0;
        st.relT = num(st.relT, 0) + dt;
        var decay = ped.thr > 0.3 ? (st.relT > KB.holdGrace_s ? KB.holdDecay : 0) : KB.holdLiftDecay;
        if (geom && proj && geom.samples && isFinite(proj.index)) {
          var Sg = geom.samples, Ng = Sg.length, kAh = 0, nAh = Math.max(1, Math.round(v * 0.7 / num(geom.ds, 2)));
          for (var qa = 0; qa <= nAh; qa += Math.max(1, nAh >> 2)) kAh = Math.max(kAh, d * num(Sg[mod(Math.round(proj.index) + qa, Ng)].curvature, 0));
          decay = lerp(30 * DEG, decay, smooth01(0.002, 0.008, kAh));
          dbg.roadAhead = kAh;
        }
        tgt = Math.max(0, st.holdAngle - decay * dt);
        dbg.holding = true;
      }
      else tgt = Math.max(0, st.holdAngle - 30 * DEG * dt); // released: ease the angle away
      if (w > 0.1 || w < -0.1) { st.relT = 0; if (keyNow !== 0) st.swHold = 0; }
      // edge guard cap (track layer): a slide carrying the car off the inside keeps a smaller angle until it is clear
      st.angCap = Math.min(DRIFT.maxAngle, num(st.angCap, DRIFT.maxAngle) + 15 * DEG * dt);
      tgt = Math.min(tgt, st.angCap);
      st.holdAngle = approach(st.holdAngle, tgt, (tgt > st.holdAngle ? 60 : 45) * DEG * dt);
      // never ask for more angle than the steering rack can catch at this speed
      var cap = maxV + DRIFT.capMargin;
      var At = Math.min(st.holdAngle, cap);
      // tap-safe levels: at speed the slide is kept to an angle the speed-limited rack can still catch, and the
      // over-rotation guard looks further ahead (a fast slide past ~25 deg cannot be caught by any input)
      var predT = DRIFT.predT, aSafe = DRIFT.maxAngle;
      if (tapSafe) {
        var hs = smooth01(14, 30, v);
        aSafe = lerp(DRIFT.maxAngle, 15 * DEG, hs);
        At = Math.min(At, aSafe);
        predT = lerp(DRIFT.predT, 0.42, hs);
      }
      var e = A - At;                          // + too much angle
      var vCap = capSpeed(p, grip, At, o.maxSteer);
      dbg.targetAngle_deg = -d * At / DEG;

      // steering: counter-steer toward the travel direction + PD on the angle error
      var csBase = -d * CS * A;                                // automatic counter-steer (aligns fronts with travel)
      var corr = -d * (DRIFT.kE * e + DRIFT.kD * Ar) * H;      // more counter if over-angled / rotating fast
      var playerAdd = d * (1 - Math.max(CS, num(geom && proj ? num(L.heldCsTrack, L.heldCs) : L.heldCs, 0))) * Math.max(0, w) * maxV * 0.5; // the player's share
      delta = csBase + corr + playerAdd;
      if (kbd && w < -0.1) {
        // keyboard, counter arrow held: steer OUT of the slide from the travel direction (front axle) — the slide
        // straightens however little the level's own counter-steer share is
        var aCGk = num(p.a, num(p.wheelbase, 2.65) * 0.48), betaFk = Math.atan2(o.vy + o.r * aCGk, Math.max(3, Math.abs(o.vx)));
        var cReach = Math.min(lock, gripSteer(p, Math.abs(o.vx), grip)) * KB.counterReach * Math.min(1, -w);
        delta = lerp(delta, betaFk - d * cReach, KB.counterK);
        dbg.kbCounter = true;
      }
      dbg.counterSteer_deg = (csBase + corr) / DEG;

      // throttle: angle hold (more throttle = more rear slip = more angle)
      var thrHold = DRIFT.thrBase + DRIFT.kThrE * (-e) - DRIFT.kThrD * Ar;
      thrHold += (ped.thr - 0.5) * 0.25 - ped.brk * 0.4;
      thrHold -= DRIFT.kV * Math.max(0, v - vCap);                    // stay in the speed range the lock can handle
      if (tapSafe) thrHold -= 0.15 * Math.max(0, v - DRIFT.safeDriftSpeed);
      var need = Math.abs(csBase + corr + playerAdd);
      if (need > maxV * 0.98 && e > 0) thrHold *= 0.35;               // rack saturated + over-angled: lift
      dbg.vCap_kph = vCap * 3.6;
      if (At <= 0.01) thrHold = Math.min(thrHold, 0.35 + ped.thr * 0.3);
      // scale by how hard the engine can overpower the rear tyres in this gear (muscle cars need a feather foot)
      var ts = throttleScale(p, o.gear);
      thrHold = thrHold * ts + (1 - ts) * 0.0;
      dbg.throttleScale = ts;
      // floor: keep the rears turning (a full lift snaps the car straight); cap: no auto-box kickdown (>0.92)
      thrHold = clamp(thrHold, lerp(DRIFT.thrFloor, DRIFT.thrNeutral, smooth01(20, 34, v)) * ts, DRIFT.thrCap);
      var Ht = Math.max(H, num(L.thrHold, 0));               // throttle share of the angle hold (may exceed the steering share)
      out.throttle = lerp(ped.thr, thrHold, Ht);
      out.brake = ped.brk * 0.35 * (1 - Ht) + (ped.brk > 0 ? 0.12 : 0) * Ht;
      out.handbrake = !!raw.handbrake && A < DRIFT.maxAngle;

      // predictive over-rotation guard: the angle is heading past what the (speed-limited) rack can catch
      var Apred = A + Math.max(0, Ar) * predT;
      var catchA = Math.min(Math.min(maxV, lock) + DRIFT.catchMargin, aSafe + 6 * DEG);
      var ov = clamp((Apred - catchA) / (12 * DEG), 0, 1) * L.spinGuard;
      if (ov > 0) {
        // throttle toward a rolling-neutral value: a full lift would engine-brake the (locked-diff) rears
        // and snap the car round; too much keeps them spinning with no side grip
        out.throttle = lerp(out.throttle, DRIFT.thrNeutral * ts * (tapSafe ? 1 - smooth01(18, 28, v) : 1), ov);
        out.handbrake = false;
        delta = lerp(delta, -d * maxV, ov);
        dbg.overRot = ov;
      }

      // under-angled and the rack / speed won't let the throttle add more (grippy tune, AWD, too fast):
      // short handbrake taps swing the rear out and scrub speed — what a real drifter does on entry
      if (H > 0 && I > 0 && w > 0.1 && st.timer > 0.25) {
        var under = -e;                                   // rad short of the target
        var stuck = under > DRIFT.tapAngle && Ar < 0.25 && v > DRIFT.initSpeed;
        if (st.tap > 0) { st.tap -= dt; out.handbrake = true; out.throttle = Math.max(out.throttle, 0.5); }
        else {
          if (st.tapCool > 0) st.tapCool -= dt;
          if (stuck && st.tapCool <= 0) { st.tap = DRIFT.tap_s * H; st.tapCool = DRIFT.tapCool_s; }
        }
        dbg.tap = st.tap > 0;
      }

      // spin guard
      if (A > DRIFT.spinAngle * lerp(1.4, 1, L.spinGuard) && L.spinGuard > 0) {
        delta = lerp(delta, -d * maxV, L.spinGuard);
        out.throttle = lerp(out.throttle, DRIFT.thrNeutral * ts, L.spinGuard);
        out.handbrake = false;
        dbg.recovering = true;
      }
      return clamp(delta, -lock, lock);
    }

    /* ---------------------------------------------------------- drift pilot (heavy / auto) — the "drift lock"
       One control law for grip, entry, hold, swing and exit:
         sideslip target  ang (filtered, signed)       r* = chiRef + Kbeta (beta - ang) - ang'
         steering         delta = thetaVF (front axle travel direction: automatic counter-steer)
                                  + front slip (feed-forward + Kr (r* - r) + I)
         grip  : chiRef = v * kappa_path            -> steering follows the road
         drift : chiRef = measured course rate      -> steering only holds the ANGLE, rock steady;
                 the road is followed with SPEED (v = sqrt(a_lat / kappa)), a_lat measured online.
       Throttle = speed PI (+ angle helpers), brake = governor; every output low-passed + rate limited. */
    function pilotReset() {
      st.pl = { lockDir: 0, arm: 0, armT: 0, keyPrev: 0, keyT: 0, noLock: 0,
        ang: 0, angV: 0, eAf: 0, iA: 0, chiPrev: null, bF: null, bDot: 0, chiDot: 0, iR: 0, iV: 0, aLat: null,
        flick: 0, flickCool: 0, tap: 0, tapCool: 0, stuckT: 0, recover: 0, nudge: 0,
        dF: null, thrF: 0, brkF: 0, shiftCool: 0, limT: 0, tcGrip: 1, driftT: 0, revCap: 1, postDrift: 0 };
    }
    /** Linear interpolation into a circular per-sample plan array at fractional index f. */
    function atF(arr, f, n) {
      var i0 = Math.floor(f), t = f - i0;
      i0 = mod(i0, n);
      return arr[i0] + (arr[(i0 + 1) % n] - arr[i0]) * t;
    }
    function cornerAhead(plan, idx, dir, nAhead, dMin) {
      for (var q = 0; q <= nAhead; q++) { var i = (idx + q) % plan.n; if (plan.D[i] > dMin && plan.DIR[i] === dir) return q; }
      return -1;
    }
    function pilotControl(raw, o, p, grip, u, ped, out, dt, maxV, lock, geom, proj) {
      var plan = planFor(geom, p);
      if (!plan) return null;
      if (!st.pl) pilotReset();
      var P = PILOT, S = st.pl, dbg = st.dbg, ci = plan.car, auto = !!L.auto, q;
      var v = o.speed, vx = o.vx, vy = o.vy, r = o.r, hd = o.heading;
      var beta = v > 1.5 ? Math.atan2(vy, Math.max(vx, 0.5)) : 0;

      /* ---- measurements (lightly filtered: no derivative noise reaches the wheel) */
      if (S.bF == null) S.bF = beta;
      var bPrev = S.bF;
      S.bF += (beta - S.bF) * (1 - Math.exp(-dt / 0.02));
      var bd = (S.bF - bPrev) / dt;
      if (!isFinite(bd)) bd = 0;
      S.bDot += (clamp(bd, -6, 6) - S.bDot) * (1 - Math.exp(-dt / 0.05));
      // course rate from the travel direction itself (one filter: no lag mismatch between r and beta')
      var chiNow = hd + beta;
      if (S.chiPrev == null) S.chiPrev = chiNow;
      var cd = wrap(chiNow - S.chiPrev) / dt; S.chiPrev = chiNow;
      if (!isFinite(cd)) cd = 0;
      S.chiDot += (clamp(cd, -4, 4) - S.chiDot) * (1 - Math.exp(-dt / P.tauChi));
      var aLat0 = P.driftLatG * G * Math.min(1.3, ci.mu) * Math.sqrt(clamp(grip, 0.5, 1.2));
      if (S.aLat == null) S.aLat = aLat0;

      /* ---- where are we */
      var idx = proj.index, n = plan.n, ds = plan.ds;
      var fi = isFinite(proj.s) ? mod(proj.s / ds, n) : idx;
      if (Math.abs(wrap((fi - idx) / n * TAU)) > 4 / n * TAU) fi = idx;
      var hw = atF(plan.HW, fi, n), lat = num(proj.lateral, 0), latLine = lat - atF(plan.OFF, fi, n), edge = hw - Math.abs(lat);
      var backwards = Math.abs(wrap(hd + beta - plan.H[idx])) > 1.9 && v > 2;

      /* ---- keys -> intent */
      var axis = num(raw.steerAxis, NaN);
      var key = isFinite(axis) && Math.abs(axis) > 0.3 ? sign(axis) : (raw.left ? 1 : 0) - (raw.right ? 1 : 0);
      var newPress = key !== 0 && key !== S.keyPrev;
      S.keyT = key !== 0 && key === S.keyPrev ? S.keyT + dt : (key ? dt : 0);
      S.keyPrev = key;
      if (newPress) { S.arm = key; S.armT = P.arm_s; }
      else if (key && key === S.arm) S.armT = P.arm_s;
      else if (S.armT > 0) { S.armT -= dt; if (S.armT <= 0) S.arm = 0; }
      if (S.noLock > 0) S.noLock -= dt;
      var go = ped.thr > 0.3;

      /* ---- plan look-ahead */
      var leadN = Math.round(Math.max(6, v * P.entryLead_s) / ds);
      var dNow = plan.D[idx], dirNow = plan.DIR[idx];
      var dAhead = plan.D[(idx + leadN) % n], dirAhead = plan.DIR[(idx + leadN) % n];
      var dUse = dNow, dirUse = dirNow;
      if (dAhead > dNow + 0.05) { dUse = dAhead * 0.95; dirUse = dirAhead; }
      if (dNow > 0.2 && dirAhead !== dirNow && dAhead > 0.2) { dUse = Math.max(dNow * 0.6, dAhead * 0.8); dirUse = dirAhead; }
      if (dUse < 0.08) dirUse = 0;

      /* ---- the drift lock: picks a direction, then holds it while Up is held and the road turns that way */
      var canDrift = v > P.initSpeed && !backwards && S.recover <= 0;
      var keepDrift = go && v > P.exitSpeed && !backwards && S.recover <= 0;
      if (auto) {
        // S-bends: hold the current slide until the next (opposite) corner is close, then swing — a lock that
        // flips a whole entry-lead early never lets either drift settle
        var dirAuto = dirUse;
        if (S.lockDir && dirUse === -S.lockDir && dirNow === S.lockDir && dNow > 0.08) {
          var swN = Math.round(Math.max(4, v * P.autoSwing_s) / ds);
          if (cornerAhead(plan, idx, -S.lockDir, swN, 0.15) < 0) dirAuto = S.lockDir;
        }
        if (go && canDrift && dirAuto) S.lockDir = dirAuto;
        else if (!(keepDrift && S.lockDir && cornerAhead(plan, idx, S.lockDir, leadN, 0.06) >= 0)) S.lockDir = 0;
      } else {
        if (!keepDrift) S.lockDir = 0;
        if (S.lockDir) {
          var contN = cornerAhead(plan, idx, S.lockDir, Math.round(leadN * 0.5), 0.06);
          if (newPress && key === -S.lockDir) {
            // opposite arrow: swing into the next corner if it goes that way, else straighten up
            if (cornerAhead(plan, idx, key, Math.round(leadN * 1.6), 0.1) >= 0) S.lockDir = key;
            else { S.lockDir = 0; S.noLock = 0.6; S.arm = 0; }
          } else if (contN < 0) {
            // the road stops turning this way: S-bend -> swing through, straight -> straighten
            S.lockDir = dirUse === -S.lockDir && dUse > 0.15 ? -S.lockDir : 0;
          }
        }
        if (!S.lockDir && go && canDrift && S.noLock <= 0 && S.arm && S.armT > 0 && cornerAhead(plan, idx, S.arm, leadN, 0.12) >= 0) S.lockDir = S.arm;
      }
      var lockDir = S.lockDir, dLock = 0;
      if (lockDir) {
        // the lock may be armed early, but the car only starts to rotate just before the turn-in point
        var nRot = Math.round(v * P.rotLead_s / ds);
        for (q = 0; q <= nRot; q++) { var iq = (idx + q) % n; if (plan.DIR[iq] === lockDir) dLock = Math.max(dLock, plan.D[iq]); }
        dLock = dLock > 0.05 ? clamp(dLock, P.minAngle_deg / P.angle_deg, 1) : 0;
        // exit: unwind the angle as the end of the corner approaches (the car arrives straight, on the road)
        var iEx = (idx + Math.round(v * P.exitLead_s / ds)) % n, dEx = plan.DIR[iEx] === lockDir ? plan.D[iEx] : 0;
        if (dirNow === lockDir && dNow > 0.05) dLock *= clamp(dEx / Math.max(dNow, 0.05), 0.25, 1);
      }

      /* ---- drift-angle target (signed sideslip), never more than the rack can catch */
      var A = 0, inG = 0;
      if (lockDir) {
        A = P.angle_deg * dLock;
        if (key === lockDir) A += P.keyAngle_deg * smooth01(0, 0.4, S.keyT);
        else if (auto && key === -lockDir) A -= P.lessAngle_deg;
        else if (auto) A += P.autoAngle_deg;
        A -= P.lessAngle_deg * ped.brk;
        A = dLock > 0 ? clamp(A, 8, P.maxAngle_deg) * DEG : 0;
        for (var it = 0; it < 3; it++) A = Math.min(A, Math.max(8 * DEG, vehMaxSteer(p, Math.max(v, 1) * Math.cos(A), grip) - P.rackMargin_deg * DEG));
        // inside guard: the slide is carrying the car onto the inside edge -> open the angle, steer out
        var psiIn = lockDir * wrap(hd + beta - num(proj.heading, plan.H[idx]));
        var roomIn = hw - lat * lockDir, vIn = v * Math.sin(psiIn);
        var tIn = vIn > 0.3 ? Math.max(0, roomIn - 1.2) / vIn : 99;
        inG = Math.max(clamp((P.inT - tIn) / P.inT, 0, 1), clamp((3 - roomIn) / 2.5, 0, 1) * (psiIn > -0.05 ? 1 : 0.3));
        A *= 1 - inG * P.inGMax;
        A *= smooth01(P.exitSpeed, P.exitSpeed + 3, v);
      }
      var goal = -lockDir * A;
      if (S.recover > 0) goal = 0;
      // critically damped 2nd-order filter with a rate limit: smooth entries, one-arc left<->right swings
      var w = P.wAng, swing = sign(goal) && sign(S.ang) && sign(goal) !== sign(S.ang);
      var unwinding = !swing && Math.abs(goal) < Math.abs(S.ang) - 1e-3;
      var rateMax = S.recover > 0 ? P.recoverRate : swing ? P.swingRate : unwinding ? P.exitRate : P.angRate;
      S.angV += (w * w * (goal - S.ang) - 2 * w * S.angV) * dt;
      S.angV = clamp(S.angV, -rateMax, rateMax);
      S.ang += S.angV * dt;
      if (Math.abs(goal - S.ang) < 1e-4 && Math.abs(S.angV) < 1e-3) { S.ang = goal; S.angV = 0; }
      // the target stays within angLead of the real slide (entries, swings and exits): no wind-up, no yaw spikes
      //   (leads by up to leadIn on the way in, lags by at most leadOut on the way out / over-rotated)
      var dS = lockDir || -sign(S.ang);
      if (dS) {
        var angA = -S.ang * dS, betaA = -beta * dS, vA = -S.angV * dS, bvA = -S.bDot * dS;
        var lo = betaA - P.leadOut_deg * DEG, hi = betaA + P.leadIn_deg * DEG;
        if (angA > hi) { angA = hi; vA = Math.min(vA, Math.max(bvA, 0)); }
        else if (angA < lo) { angA = lo; vA = Math.max(vA, Math.min(bvA, 0)); }
        S.ang = -angA * dS; S.angV = clamp(-vA * dS, -rateMax, rateMax);
      }
      var ang = S.ang, Aabs = Math.abs(ang);
      var wD = smooth01(3 * DEG, 12 * DEG, Aabs);          // 0 = grip, 1 = drifting
      var dSign = sign(ang) ? -sign(ang) : lockDir;        // +1 left-hand drift
      var along = -beta * dSign;                            // current angle measured the right way round

      /* ---- path: pure pursuit on the VELOCITY vector toward the drift line (+ lane nudge) */
      var nudgeT = 0;
      if (!auto && key && !lockDir && v > P.initSpeed * 0.8) nudgeT = key * Math.max(0, hw - P.edgeMargin - 0.5);
      S.nudge = approach(S.nudge, nudgeT, (nudgeT ? 2.5 : 1.5) * dt);
      var chi = hd + beta;
      var Ld = clamp(7 + v * 0.62, 9, 46);
      // sliding: a longer look-ahead (the slide changes its arc slowly — a short one over-corrects into a weave)
      var wD0 = smooth01(3 * DEG, 12 * DEG, Math.abs(S.ang));
      Ld = lerp(Ld, clamp(P.LdD0 + v * P.LdDv, 9, 60), wD0);
      var fj = fi + Ld / ds, jj = mod(Math.round(fj), n), smj = geom.samples[jj] || {};
      var offj = atF(plan.OFF, fj, n), hwj = atF(plan.HW, fj, n), limj = Math.max(0, hwj - P.edgeMargin);
      var nud = clamp(offj + S.nudge, -limj, limj) - offj;
      var tx = atF(plan.X, fj, n) + num(smj.nx, 0) * nud, ty = atF(plan.Y, fj, n) + num(smj.ny, 0) * nud;
      var eChi = wrap(Math.atan2(ty - o.y, tx - o.x) - chi);
      var dist = Math.max(4, Math.hypot(tx - o.x, ty - o.y));
      var kpp = 2 * Math.sin(eChi) / dist;
      var kff = atF(plan.K, fi + v * 0.2 / ds, n);
      var kCmd = kpp * 0.85 + kff * 0.25 + clamp(-(latLine - S.nudge) * 0.004, -0.02, 0.02) * (edge < 2 ? 2 : 1);
      // the player's own arrows at low speed (a normal, easy car)
      //   a bias on the auto-steer (lateral g limited), faded out when it would run the car off the road
      var wPl = 0;
      if (!auto && key && !lockDir && v < P.initSpeed * 1.1) {
        var kGeo = Math.tan(Math.min(maxV, gripSteer(p, Math.abs(vx), grip) * 1.15)) / ci.wb;
        var dK = u * Math.min(kGeo, P.lowLatG * G / Math.max(1, v * v)) * lerp(1, 0.5, smooth01(4, P.initSpeed, v));
        var thR = num(proj.heading, plan.H[idx]), eH = wrap(chi - thR), Tp = 1.6;
        var kRoad = atF(plan.K, fi, n);
        var lat0 = lat + v * Math.sin(eH) * Tp + 0.5 * v * v * (kCmd - kRoad) * Tp * Tp, dLat = 0.5 * v * v * dK * Tp * Tp;
        var limL = Math.max(0, hw - 1.6), sc = 1;
        if (dLat > 1e-6 && lat0 + dLat > limL) sc = clamp((limL - lat0) / dLat, 0, 1);
        else if (dLat < -1e-6 && lat0 + dLat < -limL) sc = clamp((-limL - lat0) / dLat, 0, 1);
        if (v < 2) sc = 1;
        wPl = sc;
        kCmd += dK * sc;
      }
      // never ask the tyres for more than they have (a big pursuit demand mid-swing whips the car round)
      var chiCap = latAccelAt(p, Math.max(v, 3), grip) * 0.95 / Math.max(v, 3);
      var chiPath = clamp(v * kCmd, -chiCap, chiCap);

      /* ---- yaw-rate demand + steering */
      // unwinding (exit / inside guard): the steering takes the road back so the car leaves the corner straight
      var exitW = clamp((Aabs - Math.abs(goal) - 2 * DEG) / (8 * DEG), 0, 1);
      var kPY = Math.max(P.kPathYaw, P.exitPathYaw * Math.max(inG, exitW));
      var chiRef = lerp(chiPath, S.chiDot + kPY * (chiPath - S.chiDot), wD);
      dbg.exitW = exitW;
      dbg.insideGuard = inG;
      var ffK = clamp(1 - (Math.abs(beta - ang) - 4 * DEG) / (8 * DEG), 0, 1);
      var rStar = chiRef + lerp(P.KbetaGrip, P.Kbeta, wD) * (beta - ang) - S.angV * ffK;
      rStar = clamp(rStar, chiRef - P.rotMax, chiRef + P.rotMax);          // rotate smoothly, never whip
      // entry, rear still gripping: rotating the body would only turn the COURSE toward the inside —
      // keep the course on the road and let the flick / power break the rear loose
      if (lockDir && Aabs > 3 * DEG && along < Aabs * 0.5) {
        var gK = clamp(1 - along / (Aabs * 0.5), 0, 1) * P.entryHold;
        rStar = lerp(rStar, clamp(rStar, chiPath - P.rotInit, chiPath + P.rotInit), gK);
      }
      var thetaVF = Math.atan2(vy + ci.a * r, Math.max(vx, 1.5));
      var eR = rStar - r;
      if (v > 5) S.iR = clamp(S.iR + eR * dt * P.Ki, -0.08, 0.08); else S.iR *= Math.exp(-dt * 4);
      var apF = Math.atan(ci.tanPkF), afMax = apF * P.afMax;
      var latDemand = clamp(v * chiRef / (ci.muF * G), -1, 1);
      var af = clamp(Math.atan(latDemand * ci.tanPkF) * 0.9 * (1 - wD) + P.Kr * eR + S.iR, -afMax, afMax);
      var delta = thetaVF + af;
      if (v < 6) {
        // walking pace: plain geometric steering toward the target / the player's arrows
        var dLow = Math.atan(ci.wb * kCmd);
        delta = lerp(clamp(dLow, -lock, lock), delta, smooth01(3, 6, v));
      }

      /* ---- speed target */
      var la = Math.round((3 + v * 0.35) / ds), vt = Infinity;
      for (q = 0; q <= la; q++) vt = Math.min(vt, plan.V[(idx + q) % n]);
      vt *= Math.sqrt(clamp(grip, 0.5, 1.2) * clamp(S.aLat / aLat0, 0.85, 1.15));
      if (edge < 0) vt *= 0.85;
      var outward = dSign ? latLine * -dSign : 0;
      if (wD > 0.5 && (!(P.vPathSettle > 0) || along > Aabs * P.vPathSettle)) {
        // drifting (the slide is established — not during the entry): the road is followed with speed (the tyres are saturated: radius = v^2 / a_lat)
        // curvature the slide needs: road curvature ahead + PD on the outward lateral error (well damped:
        // speed is a slow actuator, so the heading term dominates)
        var thRd = num(proj.heading, plan.H[idx]);
        var eOut = -latLine * dSign, psiOut = -dSign * wrap(chi - thRd);
        var kNeed = atF(plan.K, fi + v * 0.4 / ds, n) * dSign + P.kLatE * eOut + P.kLatD * psiOut;
        var vPath = Math.sqrt(S.aLat / Math.max(kNeed, 1 / 500));
        dbg.eOut = eOut; dbg.psiOut_deg = psiOut / DEG;
        vt = clamp(vPath, vt * 0.75, vt * P.vPathUp);
        var vRack = capSpeed(p, grip, Aabs + P.rackMargin_deg * DEG * 0.5, o.maxSteer) / Math.max(0.5, Math.cos(Aabs));
        vt = Math.min(vt, vRack);
      }
      if (edge < 3 && outward > 0 && wD > 0.3) vt *= clamp(0.8 + edge * 0.065, 0.75, 1);
      vt = Math.max(vt, 4);
      // the speed target is a slow actuator for the line in a slide: low-pass it (no breathing / pumping)
      if (S.vtF == null || wD < 0.3) S.vtF = vt;
      else S.vtF += (vt - S.vtF) * (1 - Math.exp(-dt / (vt < S.vtF && edge < 2.5 ? P.vtTau * 0.3 : P.vtTau)));
      vt = S.vtF;

      /* ---- throttle / brake */
      var ev = v - vt, thr, brk = 0;
      if (Math.abs(ev) < 3 && ev < 1.2) S.iV = clamp(S.iV - ev * dt * P.kIv, -0.15, 0.2);
      thr = P.thrHold + S.iV - P.kV * ev;
      if (ev > 1.2) brk = clamp((ev - 1.2) * P.brkK * (wD > 0.5 ? 1 : 2), 0, wD > 0.5 ? P.brkDrift : 1);
      var phase = wD > 0.5 ? 'drift' : 'grip';
      if (S.flickCool > 0) S.flickCool -= dt;
      if (S.tapCool > 0) S.tapCool -= dt;
      if (wD > 0.3) {
        var eA = Aabs - along;                               // + under-angled
        // entry: the rear will not break loose by steering alone -> a short handbrake flick
        if (lockDir && go && along < 4 * DEG && along > -4 * DEG && Aabs > P.flickAt_deg * DEG && v > P.initSpeed && S.flickCool <= 0) { S.flick = P.flick_s; S.flickCool = P.flickCool_s; }
        if (along < Aabs * 0.6) phase = 'init';
        // DRIFT THROTTLE = the angle holder (slow PI on the filtered angle error; the steering does the fast part).
        // More throttle = more rear slip = more angle; the speed is governed by the brake / a gentle lift.
        S.eAf += (clamp(eA, -15 * DEG, 15 * DEG) - S.eAf) * (1 - Math.exp(-dt / P.tauA));
        var steady = along > Aabs * 0.5;
        if (steady) S.iA = clamp(S.iA + S.eAf * P.kIA * dt, P.iAmin, P.iAmax);
        if (P.thrMode === 'angle') thr = P.thrDrift + S.iA + P.kA * S.eAf - P.kVd * Math.max(0, ev - 1.5);
        if (!steady && lockDir && P.thrMode === 'angle') thr = Math.max(thr, P.thrEntry);           // entry: power over
        // under-angled with the rear hooked up for a while: a handbrake tap
        S.stuckT = eA > P.stuck_deg * DEG && along > 4 * DEG && S.bDot * -dSign < 0.05 ? S.stuckT + dt : 0;
        if (S.stuckT > P.stuck_s && S.tapCool <= 0) { S.tap = P.tap_s; S.tapCool = P.tapCool_s; S.stuckT = 0; }
        // over-angled with the counter-steer near the rack limit: throttle toward a rolling neutral (a full lift snaps the car round)
        var over = along - Aabs;
        var csat = sign(delta) === sign(beta) && Math.abs(beta) > 6 * DEG ? Math.abs(delta) / Math.max(0.05, maxV) : 0;
        if (over > P.overLift_deg * DEG) thr = Math.min(thr, lerp(thr, P.thrNeutral, clamp((over - P.overLift_deg * DEG) / (10 * DEG), 0, 1)));
        // well past the angle the player asked for: settle it (rolling throttle, no brake: braking frees the rear)
        var overG = along - A;
        if (overG > 8 * DEG) {
          var kG = clamp((overG - 8 * DEG) / (8 * DEG), 0, 1);
          thr = Math.min(thr, lerp(thr, P.thrNeutral, kG));
          brk *= 1 - kG;
        }
        dbg.overGoal_deg = overG / DEG;
        if (csat > 0.86 && over > 2 * DEG) thr = Math.min(thr, lerp(thr, P.thrNeutral, clamp((csat - 0.86) / 0.1, 0, 1)));
        thr = clamp(thr, P.thrNeutral * wD, lerp(1, P.thrMaxDrift, wD));
        S.tcGrip = 0.5;
      } else {
        // grip: no power slides (traction limit + friction circle), brake = no throttle
        var spin = spinOf(o, p);
        var aRr = Math.abs(Math.atan2(vy - r * ci.b, Math.max(Math.abs(vx), 1.5)));
        var slide = (aRr > 4 * DEG && v > 4) || spin > (v < 6 ? 0.45 : 0.25);
        S.tcGrip = slide ? Math.max(0.15, S.tcGrip - dt * 4) : Math.min(1, S.tcGrip + dt * 1.2);
        thr = clamp(thr, 0, 1) * S.tcGrip * (v < 20 ? lerp(throttleScale(p, o.gear), 1, smooth01(8, 20, v)) : 1);
        var latUse = Math.abs(v * r) / Math.max(1, latAccelAt(p, Math.max(v, 3), grip));
        thr = Math.min(thr, lerp(1, 0.35, smooth01(0.7, 1.0, latUse)));
        if (aRr > 6 * DEG && v > 6) thr = Math.min(thr, 0.3);
        // just out of a slide: a rolling throttle, never a snap lift (a RWD / locked diff car flicks back)
        if (S.postDrift > 0 && go && brk < 0.15) thr = Math.max(thr, P.thrExit * S.postDrift / P.postDrift_s);
        if (brk > 0.05) thr = 0;
      }
      S.postDrift = wD > 0.5 ? P.postDrift_s : Math.max(0, S.postDrift - dt);

      /* ---- safety: past the recover angle -> point the wheels where the car goes and settle */
      var ab = Math.abs(beta);
      if (ab > P.recover_deg * DEG && v > 4) S.recover = Math.max(S.recover, 0.8);
      if (S.recover > 0) {
        S.recover -= dt; S.flick = 0; S.tap = 0;
        thr = ab > 45 * DEG ? P.recThrHi : P.recThrLo;
        brk = ab > 75 * DEG ? P.recBrkHi : P.recBrkLo;
        phase = 'recover'; dbg.recovering = true;
      }
      if (backwards && v > 3) { thr = 0; brk = 0.7; delta = thetaVF; phase = 'recover'; dbg.recovering = true; }

      /* ---- gearbox: keep the engine in its band while sliding (no limiter bounce, no bogging) */
      var rpm = o.rpm, gear = o.gear, red = ci.redline, gearV = plan.gearV;
      S.shiftCool = Math.max(0, S.shiftCool - dt);
      // the drift tune's gearbox (tune.installGearbox) already holds gears in a slide: never fight it
      var Vm = CB.race.vehicle, tuneBox = !!(p.driftGearing && p.driftGearing.holdGear && Vm && Vm.step && Vm.step._driftGearbox);
      if (gearV.length && gear >= 1 && gear <= gearV.length && wD > 0.5 && S.shiftCool <= 0 && !(o.shiftTimer > 0)) {
        // on the (soft) limiter mid-slide: short-shift if the next gear still pulls in the drift band
        // (a held gear on the limiter = no drive = the rear hooks up and the drift dies)
        S.limT = rpm > red * 0.93 && S.revCap < 0.9 ? S.limT + dt : Math.max(0, S.limT - dt);
        var rpmUp = gear < gearV.length ? Math.abs(vx) / gearV[gear] : 0;
        var rpmDn = gear > 1 ? Math.abs(vx) / gearV[gear - 2] : Infinity;
        if (S.limT > P.limUp_s && gear < gearV.length && rpmUp > red * P.upMinRpm) { out.shiftUp = true; S.shiftCool = 1.0; S.limT = 0; S.revCap = Math.max(S.revCap, 0.8); }
        else if (P.ownBox && !tuneBox) {
          if (rpm < red * 0.42 && gear > 2 && rpmDn < red * 0.8) { out.shiftDown = true; S.shiftCool = 1.2; }
          else if (gear === 1 && gearV.length > 1 && Math.abs(vx) / gearV[1] > red * 0.3) { out.shiftUp = true; S.shiftCool = 1.0; }
        }
      }

      /* ---- the player's pedals: Up = go (the pilot modulates), Down = brake; no Up -> coast */
      if (!go) thr = Math.min(thr, ped.thr * 0.5);
      brk = Math.max(brk, ped.brk * (wD > 0.5 ? 0.3 : 1));
      if (ped.brk > 0.5 && wD <= 0.5) thr = 0;
      var hb = false;
      if (S.flick > 0) { S.flick -= dt; hb = true; }
      if (S.tap > 0) { S.tap -= dt; hb = true; }
      if (raw.handbrake && v > 6 && !(S.recover > 0)) hb = true;
      if (hb) brk = 0;

      /* ---- soft rev limiter: the box holds the gear in a slide, so keep the engine just under the fuel cut
         (a bouncing limiter is an on/off torque step on the rears = a 2-3 Hz yaw twitch) */
      var limR = num(p.limiterRpm, red + 60), revHi = Math.min(red * P.revSoft, limR - 120);
      if (gear >= 1 && rpm > 0) {
        if (rpm > revHi) S.revCap = Math.max(P.revCapMin, S.revCap - dt * P.revCut * (rpm - revHi) / Math.max(200, limR - revHi));
        else S.revCap = Math.min(1, S.revCap + dt * P.revRecover);
        if (wD > 0.3) thr = Math.min(thr, S.revCap);
      }
      dbg.revCap = S.revCap;

      /* ---- output filters: low-pass + rate limit (no snaps, no jitter) */
      delta = clamp(delta, -lock, lock);
      if (S.dF == null) S.dF = clamp(num(st.outSteerRad, 0), -lock, lock);   // continue from the last output: no snap on hand-over
      S.dF = approach(S.dF, S.dF + (delta - S.dF) * (1 - Math.exp(-dt / P.steerTau)), P.steerRate * dt * (S.recover > 0 ? 1.6 : 1));
      S.thrF = approach(S.thrF, S.thrF + (clamp(thr, 0, 1) - S.thrF) * (1 - Math.exp(-dt / P.thrTau)), P.thrRate * dt);
      S.brkF = approach(S.brkF, S.brkF + (clamp(brk, 0, 1) - S.brkF) * (1 - Math.exp(-dt / P.brkTau)), P.brkRate * dt);
      out.throttle = S.thrF; out.brake = S.brkF; out.handbrake = hb;

      /* ---- online drift lateral capacity (steady slides only) */
      if (wD > 0.9 && Math.abs(along - Aabs) < 5 * DEG && v > 8 && S.recover <= 0) {
        S.aLat += (clamp(Math.abs(v * S.chiDot), aLat0 * 0.7, aLat0 * 1.3) - S.aLat) * (1 - Math.exp(-dt / 1.5));
      }

      st.phase = phase === 'grip' || phase === 'recover' ? 'grip' : 'drift';
      st.dir = lockDir;
      st.holdAngle = Aabs;
      dbg.phase = phase; dbg.pilot = true; dbg.lockDir = lockDir; dbg.armed = S.arm; dbg.swing = swing;
      dbg.targetAngle_deg = ang / DEG; dbg.goalAngle_deg = goal / DEG; dbg.counterSteer_deg = thetaVF / DEG;
      dbg.targetSpeed_kph = vt * 3.6; dbg.driftDir = lockDir; dbg.edge = edge; dbg.drifting = wD > 0.5; dbg.driftWeight = wD;
      dbg.cornerDir = dirUse; dbg.cornerD = dUse; dbg.aLat = S.aLat; dbg.handbrake = hb; dbg.af_deg = af / DEG; dbg.delta_deg = delta / DEG; dbg.maxV_deg = maxV / DEG; dbg.yawDemand = rStar; dbg.nudge = S.nudge;
      return S.dF;
    }

    /* ---------------------------------------------------------- drift mode: track layer
       Keeps an arrows-only drifter on the road: brakes for corners that are too fast to drift
       (drift-speed profile), scrubs speed / straightens when the slide is about to run out of road,
       steers back from the edge in the grip phases, and recovers off-track excursions. */
    function driftTrackLayer(o, p, grip, ped, out, dt, maxV, lock, geom, proj, delta) {
      var dbg = st.dbg, v = o.speed, K = L.driftTrack, d = st.dir, wb = num(p.wheelbase, 2.65);
      var sliding = st.phase === 'drift' || st.phase === 'init';
      var offTrack = proj.onTrack === false;
      // ---- corner-speed governor
      if (!offTrack && ped.brk < 0.5) {
        var prof = profileFor(geom, p, 'drift');
        if (prof) {
          var N = prof.length, ds = num(geom.ds, 2), ahead = Math.round((v * DRIFT.govLook + 3) / ds), vt = Infinity;
          for (var k = 0; k <= ahead; k++) vt = Math.min(vt, prof[mod(proj.index + k, N)]);
          vt *= Math.sqrt(clamp(grip, 0.5, 1.2));
          var over = v - vt - DRIFT.govMargin;
          dbg.targetSpeed_kph = vt * 3.6;
          if (over > 0) {
            var g = clamp(over / DRIFT.govRamp, 0, 1) * K;
            if (sliding) {
              out.throttle = Math.min(out.throttle, lerp(out.throttle, DRIFT.thrNeutral, g));
              out.brake = Math.max(out.brake, g * DRIFT.govBrakeDrift * smooth01(1, 4, over));
              if (st.flick > 0 && over > 2) st.flick = 0;
            } else {
              // braking while turning in (or while the spin guard is catching the rear) frees the rear: ease off
              var gB = g * (1 - 0.6 * clamp(Math.abs(st.u), 0, 1)) * (1 - clamp(Math.max(num(dbg.spinGuard, 0), num(dbg.powerOver, 0)) * 1.5, 0, 1));
              out.brake = Math.max(out.brake, gB);
              out.throttle *= 1 - clamp(g * 3, 0, 1);
            }
            dbg.governor = g;
          }
        }
      }
      // ---- edge guard (prediction along the travel direction, not the nose); tap-safe levels: at least edgeGuard
      if (L.tapSafe) K = Math.max(K, num(L.edgeGuard, 0));
      var th = num(proj.heading, NaN), hw = num(proj.halfWidth, 7), lat = num(proj.lateral, 0);
      if (isFinite(th)) {
        var hErr = wrap(o.heading + o.beta - th);
        var latRate = v * Math.sin(hErr);
        var pred = lat + latRate * DRIFT.edgeLook;
        var margin = hw - Math.abs(pred);
        var outward = sign(latRate) === sign(pred) && Math.abs(latRate) > 0.3;
        if (offTrack && K > 0) {
          // off the road: stop sliding, steer back toward the track centre, scrub speed when heading away
          var dRec = pursuit(geom, proj, o, clamp(5 + v * 0.6, 7, 40), function () { return 0; }, wb);
          if (sliding && L.tapSafe && Math.abs(o.beta) < 30 * DEG) {
            // tap-safe levels: a slide off the road is over — straighten up and drive back (no re-kick for a moment)
            st.phase = 'grip'; st.dir = 0; st.flick = 0; st.tap = 0; out.handbrake = false;
            st.initBlock = Math.max(st.initBlock, DRIFT.edgeBlock_s); sliding = false;
          }
          if (dRec != null && !sliding) delta = lerp(delta, clamp(dRec, -maxV, maxV), 0.75 * K);
          if (outward && v > 8) { out.throttle = Math.min(out.throttle, 0.2); out.brake = Math.max(out.brake, 0.35 * K); }
          dbg.recovering = true;
        } else if (outward && margin < DRIFT.edgeMargin) {
          var geRaw = clamp((DRIFT.edgeMargin - margin) / 2.5, 0, 1), ge = geRaw * K;
          if (sliding) {
            // running out of road mid-slide: scrub speed (tightens the arc); toward the inside: less angle
            var wide = sign(pred) === -d;
            if (wide) {
              // running wide: less angle (a big slide scrubs instead of turning), fronts at peak slip toward the
              // inside (they carry the arc), and scrub some speed — a slower, shallower slide runs a tighter line
              var aCGw = num(p.a, wb * 0.48), betaFw = Math.atan2(o.vy + o.r * aCGw, Math.max(3, Math.abs(o.vx)));
              var dGrip = betaFw + d * Math.atan(num(p.tanAlphaPeakF, 0.15));
              delta = lerp(delta, clamp(dGrip, -maxV, maxV), ge * DRIFT.edgeWideSteer);
              st.holdAngle = Math.max(Math.min(st.holdAngle, DRIFT.edgeWideAngle), st.holdAngle - 40 * DEG * dt * ge);
              out.brake = Math.max(out.brake, ge * DRIFT.edgeBrake);
              out.throttle = Math.min(out.throttle, lerp(out.throttle, DRIFT.thrNeutral, ge * 0.8));
            } else {
              // cutting inside: open the arc — less angle, extra counter-steer, no scrubbing
              if (ge > DRIFT.edgeAbort) {
                // the slide itself is carrying the car off the road on its own side (e.g. arrow held on a straight):
                // end it and let the grip-phase edge guard steer back; no re-kick for a moment
                st.phase = 'grip'; st.dir = 0; st.flick = 0; st.tap = 0; out.handbrake = false; st.initBlock = DRIFT.edgeBlock_s;
              }
              // tap-safe levels open the arc as firmly as medium (the slide is about to leave the road on the inside)
              var gO = L.tapSafe ? geRaw * Math.max(K, DRIFT.edgeOpenSafe) : ge;
              st.holdAngle = Math.max(0, st.holdAngle - 40 * DEG * dt * gO);
              st.angCap = Math.min(num(st.angCap, DRIFT.maxAngle), Math.max(DRIFT.minAngle * 0.5, st.holdAngle));
              delta = lerp(delta, -d * maxV, gO * DRIFT.edgeOpen);
              out.brake = 0;
            }
            dbg.edgeWide = wide;
          } else {
            // the rear is stepping out (snap-back after a slide / power oversteer): the slide catch wins —
            // no brake (it frees the rear further) and no steering pull that fights the counter-steer
            var slideC = st.postSlide > 0 ? Math.max(num(dbg.powerOver, 0), num(dbg.spinGuard, 0)) : 0;
            var calm = 1 - clamp(slideC * 1.5, 0, 1), calmS = 1 - clamp((slideC - 0.25) * 2, 0, 1);
            var dIn = pursuit(geom, proj, o, clamp(6 + v * 0.5, 8, 40), function (sm) { return sign(lat) * Math.max(0, num(sm.hw, hw) - 3) * 0.3; }, wb);
            if (dIn != null) delta = lerp(delta, clamp(dIn, -maxV, maxV), ge * DRIFT.edgeSteer * calmS);
            out.brake = Math.max(out.brake, ge * DRIFT.edgeBrake * smooth01(8, 20, v) * calm);
            out.throttle = Math.min(out.throttle, 1 - ge);
          }
          dbg.edgeGuard = ge;
        }
        // hugging the edge (not necessarily moving outward): no steering / kicks further toward it
        var near = clamp((DRIFT.hugMargin - (hw - Math.abs(lat))) / DRIFT.hugMargin, 0, 1) * K;
        if (!offTrack && near > 0 && st.phase === 'grip' && sign(delta) === sign(lat) && sign(hErr) !== -sign(lat)) {
          delta *= 1 - near;
          if (near > 0.3) st.initBlock = Math.max(st.initBlock, 0.3);
          dbg.edgeHug = near;
        }
      }
      return clamp(delta, -lock, lock);
    }

    /* -------------------------------------------------------------- API */
    var api = {
      filter: filter,
      debug: function () {
        var d = st.dbg || {};
        var out = {};
        for (var k in d) out[k] = d[k];
        out.level = level; out.mode = mode; out.phase = d.phase || st.phase; out.driftDir = st.dir;
        out.holdAngle_deg = st.holdAngle / DEG; out.steerRad = st.outSteerRad;
        return out;
      },
      setLevel: function (lv) { if (LEVELS[lv]) { level = lv; L = levelFor(lv, mode); } return level; },
      setMode: function (m) { if (m === 'race' || m === 'drift') { if (m !== mode) reset(); mode = m; } return mode; },
      getLevel: function () { return level; },
      getMode: function () { return mode; },
      reset: reset,
      engineHook: function (getRaw, hopts) {
        hopts = hopts || {};
        var disableTC = hopts.disableTC != null ? !!hopts.disableTC : mode === 'drift';
        return {
          preStep: function (car, input, dt) {
            if (!car || !car.isPlayer || car.autopilotActive) return input;
            var raw = typeof getRaw === 'function' ? getRaw() : null;
            if (!raw) return input;
            var c = car.ctx || {};
            var r = filter(raw, car.state, { dt: dt, geom: c.geom || hopts.geom, params: car.params,
              gripMult: c.gripMult, proj: null });
            r.requestReset = !!(input && input.requestReset); r.pit = !!(input && input.pit); r.reverse = !!(input && input.reverse);
            return r;
          },
          vehicleParams: function (car, params) { return params; },
          vehicleEnv: function (car, env) {
            if (!disableTC || mode !== 'drift' || !car || !car.isPlayer || car.autopilotActive) return env;
            var e = {}; for (var k in env) e[k] = env[k];
            var a = {}; var ea = env && env.assists || {}; for (var k2 in ea) a[k2] = ea[k2];
            a.tc = false; a.steeringAssist = false; e.assists = a; e.tc = false;
            return e;
          }
        };
      }
    };
    Object.defineProperty(api, 'level', { get: function () { return level; }, enumerable: true });
    Object.defineProperty(api, 'mode', { get: function () { return mode; }, enumerable: true });
    return api;
  }

  CB.race.assist = {
    create: create,
    LEVELS: LEVEL_IDS.slice(),
    levels: LEVELS,
    DRIFT: DRIFT,
    RACE: RACE,
    PILOT: PILOT,
    TC: TC,
    _internals: { vehMaxSteer: vehMaxSteer, gripSteer: gripSteer, readCar: readCar, latAccelAt: latAccelAt }
  };
  CB.race.drift.assist = CB.race.assist;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.race.assist;

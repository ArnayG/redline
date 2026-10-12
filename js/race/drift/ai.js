/* ==========================================================================
   FORGE Atelier — js/race/drift/ai.js
   CB.race.drift.ai : a drifting AI driver (DRIFT-SPEC §5) used as the tandem
   lead car. Pure logic (no DOM); classic script in the browser, require()-able
   in Node.

   API
     createDriftDriver(opponent, geom, params, opts?) -> driver
        driver.control(state, ctx, dt) -> { throttle, brake, steer, handbrake, shiftUp, shiftDown, requestReset }
        driver.reset(), driver.debug(), driver.plan, driver.setAngle(deg), driver.setPace(k)
     createDriver(entrant, geom, params, opts)  -- same, engine-compatible signature (CB.race.ai.createDriver shape)
     asEngineAi(baseAi, pick?) -> an object usable as CB.race.ai replacement: createGrid from baseAi,
        createDriver returns a drift driver for entrants where pick(entrant, opts) is true (default: entrant.drift).
     buildPlan(geom, params, opts) -> per-sample drift line / drift intensity / target speed
     maxSteerAt(params, v, grip) -> front-wheel angle (rad) the vehicle model allows at full input
     simulate(geom, params, opts) -> headless run with CB.race.vehicle (used by tests / tuning)

   Controller (per step)
     * Path layer: pure pursuit on a "drift line" (racing line, slightly tamed) gives the desired course
       rate of the VELOCITY vector (chi = heading + beta), not of the body.
     * Angle layer: a target drift angle beta* = -sign(curvature) * angle * intensity is ramped in before
       turn-in and swung through zero on S-bends (rate-limited -> smooth manji transitions).
     * Yaw: desired yaw rate r* = chiDot* - Kb (beta* - beta); steering = front-velocity angle (natural
       counter-steer) + front-slip feed-forward + yaw-rate feedback. Converted to the -1..1 input through
       the vehicle's own speed-sensitive lock so the AI commands real wheel angles.
     * Throttle: PI on drift angle (more throttle = more angle) + speed governor from a drift speed profile.
       Initiation: power-over, plus a brief handbrake flick for low-power / grippy cars.
     * Safety: over-rotation -> lift + stronger counter-steer; > 70 deg -> brake & straighten (no spins);
       off-line -> less angle, more path gain; stuck -> requestReset.
     * Smooth output: steering is slew-limited + low-passed (catching a slide stays fast) -> readable, non-twitchy
       counter-steer for the player to follow in tandem.
     * Narrow roads drift with less angle / speed; tail-happy tunes get a lower straight-line cap (no fishtailing).
     * Drift guard (opts.guard, default 1; 0 = off; ctx.noGuard skips a call): a light, rate-limited state helper on the
       (writable) vehicle state — trims over-rotation past the wanted angle, feeds a little angle to a starved slide and
       bends the path away from an approaching edge — so the lead stays a reliable reference with ANY drift tune.

   Conventions (vehicle.js): steer +1 = LEFT, state.vx/vy body frame (vy + left), heading CCW,
   beta = atan2(vy, vx) is NEGATIVE in a left-hand drift (nose points inside, velocity to the right).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  var G = 9.81;
  var PI = Math.PI;
  var TAU = PI * 2;
  var DEG = PI / 180;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return clamp(v, 0, 1); }
  function num(v, d) { var n = Number(v); return (v !== null && v !== '' && isFinite(n)) ? n : d; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function wrap(a) { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; }
  function approach(cur, target, d) { return cur < target ? Math.min(cur + d, target) : Math.max(cur - d, target); }
  function smoothCircular(arr, half) {
    var n = arr.length, out = new Float64Array(n);
    if (half < 1) { for (var q = 0; q < n; q++) out[q] = arr[q]; return out; }
    var acc = 0, w = 2 * half + 1, i;
    for (i = -half; i <= half; i++) acc += arr[mod(i, n)];
    for (i = 0; i < n; i++) {
      out[i] = acc / w;
      acc += arr[mod(i + half + 1, n)] - arr[mod(i - half, n)];
    }
    return out;
  }

  var DEFAULTS = {
    angle_deg: 34,          // drift angle held in tight corners
    minAngle_deg: 14,       // angle held in fast sweepers that still qualify as drift corners
    tightRadius: 70,        // radius (m) at/below which the full angle is used
    driftRadius: 240,       // corners tighter than this are drifted
    driftLatG: 0.52,        // lateral g a held slide carries (sets the drift speed per corner radius; lower = more margin to the walls)
    latFactor: 0.78,        // fraction of the car's grip used for the drift speed profile
    brakeG: 0.5,
    pace: 1.0,              // speed scale (tandem lead "difficulty")
    lineFactor: 0.2,        // how much of the racing-line offset the drift line uses
    edgeMargin: 2.6,        // keep the drift line this far inside the track edge (m)
    entryLead_s: 1.1,       // start building angle this long before the corner
    transitionRate: 1.1,    // rad/s max change of the target angle (manji swing speed)
    tandem: true,           // wait for a follower that drops back
    waitDist: 35,
    handbrakeKick: 'auto',
    Kpath: 0.15, pathAuth_deg: 8,
    Kb: 0.5, Kd: 0.1, Kt: 3.0, Ki: 0, holdThrottle: 0.5, holdThrottleMin: 0.3, spinGuard_deg: 62,
    turnIn_deg: 15,         // steering used to throw the car into a drift  // true | false | 'auto' (use when power-over alone is not enough)
    law: 2, Kbeta: 2.0, Kr: 0.4, thrCap: 0.9, upRpm: 0.95, lockMargin_deg: 3, vAngleK: 0.8, gearCapGear: 0, driftVmax: 99, lfbMax: 1, hardBrakeEv: 2, gearCapFrac: 0.8,
    rpmCap: 0.93, exitBeta_deg: 8, starveT: 0.6, kGrip: 0.15, exitTc: 0.35, satLift: 0.9, satThr: 0.12, gearHiWeak: 0.78, gearHiStrong: 0.6, gearLoWeak: 0.42, gearLoStrong: 0.32, pathK: 1, initEv: 1.0, lfbNoShift: 0.14, driftGearRpm: 0.5,
    softLine: 0.3, corridor: 3.2, initWideMax: 0.008, initWideEnd: 0.015, Kpt: 1, KptMax: 0.35, limT_s: 0.3, initMaxEv: 1.5, entryBrakeLo: 0.3, entryBrakeHi: 1.5,
    lfbEv0: 0.5, lfbEv1: 3,  // m/s over the drift speed where left-foot braking / lifting starts mid-slide
    narrowHw: [4.2, 7.5],    // half-width band (m) over which narrow-road caution fades out
    narrowAngle: 0.6,        // drift intensity scale on the narrowest roads
    narrowLat: 0.85,         // drift lateral-g scale on the narrowest roads
    catchExtra_deg: 16,      // grip mode: max counter-steer beyond the front-axle travel direction when catching a slide
    guard: 1,                // drift guard strength (0 = pure input control, see guard())
    guardBand_deg: 14, guardMin_deg: 26, guardMax_deg: 58, guardTrimRate: 0.5,   // over-rotation band / trim rate (rad/s)
    guardFeedGap_deg: 7, guardFeedRate: 0.25,                                     // angle feed for starved slides (rad/s)
    guardEdge_m: 1.6, guardEdgeRate: 0.45,                                        // edge guard: distance (m), path bend rate (rad/s)
    steerRate: 5.0,          // input units/s: slew limit on the steering output (smooth, readable counter-steer)
    steerRateFast: 9.0,      // ... while catching an over-rotation / recovering
    steerTau: 0.035,         // s: low-pass on the steering output
    tailSpeed: [40, 52],     // m/s straight-line cap at tailRatio[0] .. [1] (rear / front grip ratio)
    tailRatio: [0.78, 0.9],
    maxSpeed: 52             // m/s cap (a drift lead never needs more; tail-happy tunes get twitchy above ~200 km/h)
  };

  /* ------------------------------------------------------------ geometry */
  function resolveGeom(geom) {
    if (geom && Array.isArray(geom.samples) && geom.samples.length > 8) return geom;
    var T = CB.race && CB.race.tracks;
    if (geom && geom.points && T && typeof T.build === 'function') { try { return T.build(geom); } catch (e) { /* fall through */ } }
    if (typeof geom === 'string' && T && typeof T.geometry === 'function') { try { return T.geometry(geom); } catch (e2) { /* fall through */ } }
    return null;
  }

  function projectOn(geom, x, y, hint) {
    if (typeof geom.project === 'function') { try { return geom.project(x, y, hint); } catch (e) { /* fall back */ } }
    var T = CB.race && CB.race.tracks;
    if (T && typeof T.project === 'function') { try { return T.project(geom, x, y, hint); } catch (e2) { /* fall back */ } }
    // brute-force nearest sample (very defensive; geoms from tracks.build always have project)
    var S = geom.samples, n = S.length, best = 0, bd = Infinity, lo = 0, hi = n;
    if (hint != null && isFinite(hint)) { lo = Math.round(hint) - 30; hi = Math.round(hint) + 30; }
    for (var k = lo; k < hi; k++) {
      var i = mod(k, n), dx = S[i].x - x, dy = S[i].y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    var sm = S[best], nx = num(sm.nx, -Math.sin(sm.heading)), ny = num(sm.ny, Math.cos(sm.heading));
    var lat = (x - sm.x) * nx + (y - sm.y) * ny, hw = num(sm.hw, num(sm.width, 12) / 2);
    return { index: best, s: num(sm.s, 0), lateral: lat, onTrack: Math.abs(lat) <= hw, halfWidth: hw,
      surface: Math.abs(lat) <= hw ? 'asphalt' : 'grass', heading: sm.heading };
  }

  /* --------------------------------------------------------- vehicle info */
  function carInfo(params) {
    var p = params || {};
    var wb = num(p.wheelbase, num(p.wb, 2.65));
    var wf = clamp(num(p.weightFront, 0.52), 0.3, 0.7);
    var muF = num(p.muF, num(p.mu, 1.0)), muR = num(p.muR, num(p.mu, 1.0));
    var hp = num(p.power_hp, num(p.powerKw, 250) / 0.7457);
    var mass = num(p.mass, 1400);
    return {
      wb: wb, a: num(p.a, wb * (1 - wf)), b: num(p.b, wb * wf), wf: wf, muF: muF, muR: muR,
      mu: muF * wf + muR * (1 - wf), lock: num(p.lockAngle, num(p.maxSteer, 0.6)),
      tanPkF: num(p.tanAlphaPeakF, 0.16), hp: hp, mass: mass, hpPerTon: hp / (mass / 1000),
      layout: p.layout || 'rwd', tc: num(p.tcLevel, 0), lockR: num(p.lockR, 0.5),
      redline: num(p.redline, 7000), maxGear: num(p.maxGear, 6)
    };
  }

  /** Front-wheel angle the vehicle model allows at |input| = 1 (mirrors vehicle.js substep steering). */
  function maxSteerAt(params, v, grip) {
    var p = params || {}, ci = carInfo(p);
    var vF = Math.abs(num(v, 0)), lock = ci.lock;
    var speedLimit = lock / (1 + Math.pow(vF / 21, 1.6));
    var V = CB.race && CB.race.vehicle;
    var latCap = (V && typeof V.latAccelAt === 'function' && p.muF != null) ? V.latAccelAt(p, vF, grip == null ? 1 : grip) : ci.mu * G * 0.93 * (grip == null ? 1 : grip);
    var physLimit = vF > 1 ? Math.atan(ci.wb * latCap / (vF * vF)) + Math.atan(ci.tanPkF) * 1.25 : lock;
    return clamp(Math.max(speedLimit, Math.min(physLimit, lock)), 0.045, lock);
  }

  /** Straight-line speed cap: drift tunes (rear grip well below front) fishtail at very high speed, so the
      looser the rear, the lower the lead's top speed (a drift lead never needs more anyway). */
  function tailSpeedCap(ci, o) {
    var ratio = ci.muF > 0 ? ci.muR / ci.muF : 1;
    return Math.min(o.maxSpeed, lerp(o.tailSpeed[0], o.maxSpeed, clamp((ratio - o.tailRatio[0]) / (o.tailRatio[1] - o.tailRatio[0]), 0, 1)));
  }

  /* ---------------------------------------------------------------- plan */
  function buildPlan(geomIn, params, opts) {
    var geom = resolveGeom(geomIn);
    if (!geom) return null;
    var o = Object.assign({}, DEFAULTS, opts || {});
    var S = geom.samples, n = S.length, L = num(geom.length, 0), i;
    var ds = num(geom.ds, L > 0 ? L / n : 2);
    if (!(L > 0)) L = ds * n;
    var ci = carInfo(params);

    // 1. drift line offset (racing line, tamed and kept well inside the edges)
    var off = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var sm = S[i], hw = num(sm.hw, num(sm.width, 12) / 2);
      var rl = num(sm.racingLine, Array.isArray(geom.racingLine) ? num(geom.racingLine[i], 0) : 0);
      var lim = Math.max(0, hw - o.edgeMargin);
      off[i] = clamp(rl * o.lineFactor, -lim, lim);
    }
    off = smoothCircular(smoothCircular(off, Math.max(1, Math.round(10 / ds))), Math.max(1, Math.round(10 / ds)));
    var X = new Float64Array(n), Y = new Float64Array(n), H = new Float64Array(n), K = new Float64Array(n), HW = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var s2 = S[i];
      var nx = num(s2.nx, -Math.sin(s2.heading)), ny = num(s2.ny, Math.cos(s2.heading));
      X[i] = s2.x + nx * off[i]; Y[i] = s2.y + ny * off[i];
      HW[i] = num(s2.hw, num(s2.width, 12) / 2);
    }
    var segLen = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n, pr = mod(i - 1, n);
      H[i] = Math.atan2(Y[j] - Y[pr], X[j] - X[pr]);
      segLen[i] = Math.max(0.05, Math.hypot(X[j] - X[i], Y[j] - Y[i]));
    }
    var rawK = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var hp = H[mod(i - 1, n)], hn = H[(i + 1) % n];
      rawK[i] = wrap(hn - hp) / (segLen[mod(i - 1, n)] + segLen[i]);
    }
    var kh = Math.max(1, Math.round(6 / ds));
    var Ks = smoothCircular(smoothCircular(rawK, kh), kh);
    for (i = 0; i < n; i++) K[i] = Ks[i];

    // 2. drift speed profile (lateral-grip limited, braking back-propagated)
    var aLat = Math.min(ci.mu, ci.muR * 1.02) * G * o.latFactor * (ci.muR < ci.muF * 0.95 ? 0.88 : 1), vmax = Math.min(tailSpeedCap(ci, o), num(params && params.topSpeed_ms, 90) * 0.95);
    var V = new Float64Array(n);
    var wK = Math.max(1, Math.round(4 / ds));
    for (i = 0; i < n; i++) {
      var km = 0;
      for (var q = -wK; q <= wK; q++) km = Math.max(km, Math.abs(K[mod(i + q, n)]));
      V[i] = km > 1e-5 ? Math.min(vmax, Math.sqrt(aLat / km)) : vmax;
      V[i] = Math.max(V[i], 8);
    }
    // speed cap where the wanted drift angle is still catchable with the (speed-sensitive) steering lock
    var capTab = [];
    for (var cv = 0; cv <= 90; cv += 0.5) capTab.push(maxSteerAt(params, cv));
    function vForAngle(b) {
      for (var ti = capTab.length - 1; ti >= 0; ti--) { if (capTab[ti] >= b + o.lockMargin_deg * DEG) return ti * 0.5 / Math.max(0.5, Math.cos(b)); }
      return 8;
    }
    var aBrk = o.brakeG * G * Math.min(1.2, ci.mu);
    // drift speed cap from the gearing: a slide needs wheelspin headroom below the limiter
    var vGearCap = Infinity, PR = params || {};
    if (o.gearCapGear && Array.isArray(PR.ratios) && PR.ratios.length) {
      var gI = Math.min(PR.ratios.length, o.gearCapGear) - 1, rad = num(PR.layout === 'fwd' ? PR.radiusF : PR.radiusR, 0.33);
      var vr = ci.redline * PI / 30 / (num(PR.ratios[gI], 2) * num(PR.finalDrive, 3.5)) * rad;
      if (vr > 5) vGearCap = Math.max(12, vr * o.gearCapFrac);
    }
    for (var pass = 0; pass < 2; pass++) {
      for (i = n - 1; i >= 0; i--) {
        var jn = (i + 1) % n;
        V[i] = Math.min(V[i], Math.sqrt(V[jn] * V[jn] + 2 * aBrk * segLen[i]));
      }
    }

    // 3. drift intensity per sample: 0 on straights/fast kinks, 1 in tight corners; signed direction
    var D = new Float64Array(n), DIR = new Float64Array(n);
    var kTight = 1 / o.tightRadius, kDrift = 1 / o.driftRadius;
    for (i = 0; i < n; i++) {
      var ak = Math.abs(K[i]);
      D[i] = ak < kDrift ? 0 : lerp(o.minAngle_deg / o.angle_deg, 1, smoothstep(kDrift, kTight, ak));
      DIR[i] = sgn(K[i]);
    }
    // keep short gaps inside a corner complex filled (no straighten-up for 1-2 samples)
    var gap = Math.max(1, Math.round(12 / ds)), D2 = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var mx = 0;
      for (q = -gap; q <= gap; q++) mx = Math.max(mx, D[mod(i + q, n)]);
      // only fill when there is drift on both sides
      var before = 0, after = 0;
      for (q = 1; q <= gap; q++) { before = Math.max(before, D[mod(i - q, n)]); after = Math.max(after, D[mod(i + q, n)]); }
      D2[i] = D[i] > 0 ? D[i] : Math.min(before, after) * 0.85;
      void mx;
    }
    // direction for filled gaps: nearest non-zero ahead
    for (i = 0; i < n; i++) {
      if (DIR[i] === 0 || D[i] === 0) {
        for (q = 1; q < 60; q++) { var dq = DIR[(i + q) % n]; if (dq !== 0 && D[(i + q) % n] > 0) { DIR[i] = dq; break; } }
      }
    }
    D = smoothCircular(D2, Math.max(1, Math.round(4 / ds)));
    // narrow roads (street circuits / touge < ~15 m wide): smaller angles and a slower slide -> no guardrail kisses
    var NAR = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var hwMin = Infinity;
      for (q = -wK * 2; q <= wK * 2; q++) hwMin = Math.min(hwMin, HW[mod(i + q, n)]);
      NAR[i] = smoothstep(o.narrowHw[0], o.narrowHw[1], hwMin);
      D[i] *= lerp(o.narrowAngle, 1, NAR[i]);
    }
    for (i = 0; i < n; i++) {
      if (D[i] > 0.05) {
        // a slide carries less lateral g than grip driving: drift speed from the drift lateral capability
        var kmD = 0;
        for (q = -wK; q <= wK; q++) kmD = Math.max(kmD, Math.abs(K[mod(i + q, n)]));
        var aD = lerp(aLat, o.driftLatG * G * Math.min(1.1, ci.mu), clamp(D[i] * 1.4, 0, 1)) * lerp(o.narrowLat, 1, NAR[i]);
        var vD = kmD > 1e-5 ? Math.sqrt(aD / kmD) : vmax;
        V[i] = Math.max(8, Math.min(V[i], vD, vGearCap, o.driftVmax, vForAngle(Math.max(o.minAngle_deg, o.angle_deg * D[i] * o.vAngleK) * DEG)));
      }
    }
    for (pass = 0; pass < 2; pass++) {
      for (i = n - 1; i >= 0; i--) { var jn2 = (i + 1) % n; V[i] = Math.min(V[i], Math.sqrt(V[jn2] * V[jn2] + 2 * aBrk * segLen[i])); }
    }

    return {
      geom: geom, n: n, L: L, ds: ds, X: X, Y: Y, H: H, K: K, V: V, D: D, DIR: DIR, OFF: off, HW: HW, SEG: segLen,
      NAR: NAR, opts: o, car: ci
    };
  }

  /* --------------------------------------------------------------- driver */
  function createDriftDriver(opponent, geomIn, params, opts) {
    opponent = opponent || {};
    var o = Object.assign({}, DEFAULTS, opponent.drift || {}, opts || {});
    var skill = clamp01(num(opponent.skill, 0.85));
    o.pace = num(o.pace, 1) * lerp(0.9, 1.0, skill);
    var plan = buildPlan(geomIn, params, o);
    var ci = carInfo(params);
    var P = params || {};

    var st = null;
    function freshState() {
      return {
        inDrift: false, hint: null, betaT: 0, iB: 0, iR: 0, lastSteer: 0, kickT: 0, kickCool: 0, wasDrift: 0,
        stuckT: 0, recover: 0, t: 0, lastIndex: -1, dbg: {}, initT: 0, initCool: 0, entryBrake: false, tcGrip: 1, prevBeta: 0, bDot: 0, starveT: 0, limT: 0, shiftCool: 0, wasIn: false
      };
    }
    st = freshState();

    // Power-over capability: below ~250 hp/ton the rear needs a handbrake flick to get loose.
    var useKick = o.handbrakeKick === true || (o.handbrakeKick === 'auto' && (ci.hpPerTon < 250 || ci.layout !== 'rwd'));
    // Angle the car can actually hold given steering lock (needs counter-steer ~ beta).
    function angleCap(vfwd) { return Math.max(8 * DEG, maxSteerAt(P, vfwd) - o.lockMargin_deg * DEG); }
    // speed (m/s at the driven wheels, no slip) per engine rpm in each gear -> the drift gear for a corner speed
    var gearV = [];
    if (Array.isArray(P.ratios) && P.ratios.length && !P.isCVT) {
      var radR = num(P.layout === 'fwd' ? P.radiusF : P.radiusR, 0.33), fd = num(P.finalDrive, 3.5);
      for (var gi = 0; gi < P.ratios.length; gi++) gearV.push((PI / 30) / (num(P.ratios[gi], 1) * fd) * radR);
    }
    // drift gear band (no-slip rpm at the corner speed): strong cars short-shift, weak cars stay on the cam
    var powerF = clamp((ci.hpPerTon - 250) / 200, 0, 1);
    var gearHi = lerp(o.gearHiWeak, o.gearHiStrong, powerF), gearLo = lerp(o.gearLoWeak, o.gearLoStrong, powerF);
    /** Rear (driven) axle slip ratio: from the wheel state when available, else estimated from rpm / gear. */
    function rearKappa(state, vx) {
      var w = state.wheels;
      if (Array.isArray(w) && w.length >= 4 && w[2] && isFinite(w[2].kappa)) {
        var ia = P.layout === 'fwd' ? 0 : 2;
        return (num(w[ia].kappa, 0) + num(w[ia + 1].kappa, 0)) / 2;
      }
      var g = num(state.gear, 1), rpm = num(state.rpm, 0);
      if (gearV.length && g >= 1 && g <= gearV.length && rpm > 0) return (rpm * gearV[g - 1] - Math.abs(vx)) / Math.max(Math.abs(vx), 3);
      return clamp(num(state.wheelspin, 0) * 1.5, 0, 2);
    }
    function driftGear(vf) {
      for (var g = 0; g < gearV.length; g++) if (vf / gearV[g] <= ci.redline * o.driftGearRpm) return g + 1;
      return gearV.length || 1;
    }

    /* ---------------- drift guard ----------------
       A light state-level helper (like the player's arcade drift lock, but much weaker) so the lead stays a reliable,
       readable reference for tandem with ANY tune: it trims over-rotation beyond the wanted angle, gently feeds angle
       to an angle-starved slide and bends the path away from an approaching edge. All corrections are rate limited
       (rad/s) and keep the speed; the physics + the input layer above do the actual drifting.
       Off with opts.guard = 0 (or ctx.noGuard). Only runs on a writable vehicle state {heading, vx, vy, yawRate}. */
    function rotBody(state, d) {                                     // rotate the body by +d keeping the world velocity
      var c = Math.cos(d), s = Math.sin(d), vx0 = state.vx, vy0 = state.vy;
      state.heading = wrap(state.heading + d);
      state.vx = vx0 * c + vy0 * s; state.vy = -vx0 * s + vy0 * c;
    }
    function guard(state, dt, k, ctx) {
      var g = num(o.guard, 1);
      var res = { trim: 0, feed: 0, edge: 0 };
      if (!(g > 0) || (ctx && ctx.noGuard) || !state || typeof state.heading !== 'number' || typeof state.vx !== 'number' ||
          typeof state.vy !== 'number' || Object.isFrozen(state)) return res;
      if (k.phase === 'grid' || k.phase === 'countdown' || k.v < 6 || k.vx < 1 || k.backwards) return res;
      var ab = Math.abs(k.beta), sb = sgn(k.beta);
      // 1. over-rotation trim: never far past the wanted angle (and never past the hard cap)
      var band = Math.min(o.guardMax_deg * DEG, Math.max(Math.abs(k.betaT) + o.guardBand_deg * DEG, o.guardMin_deg * DEG));
      if (ab > band) {
        var ex = ab - band, d = Math.min(ex, (o.guardTrimRate + ex * 8) * g * dt) * sb;
        rotBody(state, d);                                           // nose toward the velocity (beta shrinks)
        var rOk = num(state.yawRate, 0), rT = k.v * k.kff;
        if ((rOk - rT) * sb < 0) state.yawRate = rOk + (rT - rOk) * clamp(ex / (10 * DEG), 0, 1) * Math.min(1, 10 * g * dt);
        res.trim = d;
      } else if (k.inDrift && !k.recover && k.v > 10 && Math.abs(k.betaT) > 10 * DEG && k.along < Math.abs(k.betaT) - o.guardFeedGap_deg * DEG) {
        // 2. angle feed: a slide that is short of the wanted angle gets a little help (weak cars / grippy tunes)
        var gap = Math.abs(k.betaT) - o.guardFeedGap_deg * DEG - k.along;
        var f = -k.dSign * Math.min(gap, o.guardFeedRate * g * dt * clamp(gap / (8 * DEG), 0.3, 1));
        rotBody(state, -f);                                          // body away from the velocity (beta grows toward dSign)
        res.feed = f;
      }
      // 3. edge guard: approaching an edge -> bend the whole car (path) back toward the track direction
      if (k.edge < o.guardEdge_m) {
        var sm = plan.geom.samples[k.idx], th = num(sm.heading, 0);
        var chi = state.heading + Math.atan2(state.vy, state.vx);
        var side = sgn(k.lat) || 1;                                  // +1: near the left edge
        var vOut = k.v * Math.sin(wrap(chi - th)) * side;            // m/s toward that edge
        if (vOut > 0) {
          var sev = clamp((o.guardEdge_m - k.edge) / o.guardEdge_m, 0, 1.5);
          var de = -side * Math.min(Math.asin(clamp(vOut / Math.max(k.v, 1), 0, 1)), (o.guardEdgeRate * sev + 0.05) * g * dt);
          state.heading = wrap(state.heading + de);                  // rotates the (body-frame) velocity with it
          res.edge = de;
        }
      }
      if (res.trim || res.feed || res.edge) state.speed = Math.hypot(state.vx, state.vy);
      st.guardSum = num(st.guardSum, 0) + Math.abs(res.trim) + Math.abs(res.feed) + Math.abs(res.edge);
      return res;
    }

    function control(state, ctx, dt) {
      ctx = ctx || {};
      dt = clamp(num(dt, num(ctx.dt, 1 / 120)), 1e-4, 0.1);
      var out = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false, requestReset: false };
      if (!state || !plan) return out;
      var phase = ctx.phase;
      if (phase === 'grid' || phase === 'countdown') { out.brake = 1; st.betaT = 0; st.iB = 0; st.initT = 0; return out; }
      st.t += dt;

      /* ---------------- car state ---------------- */
      var x = num(state.x, 0), y = num(state.y, 0), hd = num(state.heading, 0);
      var vx = num(state.vxLocal, num(state.vx, 0)), vy = num(state.vyLocal, num(state.vy, 0));
      var r = num(state.yawRate, 0);
      var v = Math.hypot(vx, vy);
      var beta = v > 2 ? Math.atan2(vy, Math.max(vx, 0.5)) : 0;
      if (vx < 0.5 && v > 2) beta = Math.atan2(vy, vx);            // sliding sideways / backwards
      var bRate = (beta - st.prevBeta) / dt;
      if (!isFinite(bRate) || Math.abs(bRate) > 20) bRate = 0;
      st.bDot += (bRate - st.bDot) * Math.min(1, dt * 25);
      st.prevBeta = beta;

      /* ---------------- where are we ---------------- */
      var pr = projectOn(plan.geom, x, y, st.hint != null ? st.hint : num(ctx.index, null));
      var idx = pr.index; st.hint = idx;
      var n = plan.n, ds = plan.ds;
      var hw = plan.HW[idx];
      var lat = num(pr.lateral, 0);
      var latLine = lat - plan.OFF[idx];
      var edge = hw - Math.abs(lat);                               // > 0 inside the asphalt
      var backwards = Math.abs(wrap(hd + beta - plan.H[idx])) > 1.9 && v > 2;

      /* ---------------- tandem pace ---------------- */
      var pace = o.pace;
      if (o.tandem && ctx.nearby && ctx.nearby.length) {
        for (var k = 0; k < ctx.nearby.length; k++) {
          var nb = ctx.nearby[k];
          if (nb && nb.isPlayer && isFinite(nb.ds) && nb.ds < -o.waitDist) { pace *= clamp(1 - (-nb.ds - o.waitDist) / 160, 0.75, 1); break; }
        }
      }

      /* ---------------- targets: speed, drift angle ---------------- */
      var la = Math.round((3 + v * 0.35) / ds), vt = Infinity, q;
      for (q = 0; q <= la; q++) vt = Math.min(vt, plan.V[(idx + q) % n]);
      vt *= pace;
      if (edge < 0) vt *= 0.85;

      var leadN = Math.round(Math.max(4, v * o.entryLead_s) / ds);
      var dNow = plan.D[idx], dirNow = plan.DIR[idx];
      var dAhead = plan.D[(idx + leadN) % n], dirAhead = plan.DIR[(idx + leadN) % n];
      var dUse = dNow, dirUse = dirNow;
      if (dAhead > dNow + 0.05) { dUse = dAhead * 0.95; dirUse = dirAhead; }
      if (dNow > 0.2 && dirAhead !== dirNow && dAhead > 0.2) { dUse = Math.max(dNow * 0.6, dAhead * 0.8); dirUse = dirAhead; } // swing
      var canDrift = v > 9 && !backwards && st.recover <= 0;
      // the angle we can catch at this speed (counter-steer ~ beta, the lock shrinks with forward speed)
      var angMax = o.angle_deg * DEG;
      for (var it = 0; it < 3; it++) angMax = Math.min(o.angle_deg * DEG, angleCap(v * Math.cos(angMax)));
      var betaGoal = canDrift ? -dirUse * dUse * angMax * smoothstep(9, 14, v) : 0;
      // path corridor: running wide -> a bit more angle and less speed; tucked inside -> less angle, more speed
      var outward = dirUse ? latLine * -dirUse : 0;
      if (dUse > 0.2) {
        var wide = clamp((Math.abs(outward) - 1.0) / 6, 0, 1) * sgn(outward);
        vt *= clamp(1 - wide * 0.22, 0.75, 1.12);
        betaGoal *= clamp(1 + wide * 0.18, 0.75, 1.15);
      }
      // near the INSIDE edge: less angle; near the OUTSIDE edge: keep the angle (and scrub speed, above)
      var insideSide = dirUse ? sgn(lat) === dirUse : false;
      if (edge < 2 && insideSide) betaGoal *= clamp(0.4 + edge / 3, 0.3, 1);
      if (edge < 3 && !insideSide && dUse > 0.2) vt *= clamp(0.75 + edge * 0.08, 0.7, 1);
      betaGoal = clamp(betaGoal, -angMax, angMax);
      st.betaT = approach(st.betaT, betaGoal, o.transitionRate * dt);
      var betaT = st.betaT;
      var dSign = sgn(betaT) || -dirUse || 1;                      // sign of the wanted slide
      var drifting = Math.abs(betaT) > 4 * DEG && v > 7;
      var along = beta * dSign;                                    // + = sliding the way we want
      var over = along > 0 ? along - Math.abs(betaT) : 0;          // over-rotation (rad)

      /* ---------------- path layer (pure pursuit for the velocity vector) ---------------- */
      var Ld = clamp(7 + v * 0.62, 9, 46);
      var j = (idx + Math.round(Ld / ds)) % n;
      var tx = plan.X[j], ty = plan.Y[j];
      if (drifting && o.softLine < 1) {
        // soft line while sliding: aim at a point that keeps the car's own lateral offset (pulled a little toward the
        // drift line) inside a corridor away from both edges -> no fighting the slide while there is room
        var Sj = plan.geom.samples[j], nxj = num(Sj.nx, -Math.sin(Sj.heading)), nyj = num(Sj.ny, Math.cos(Sj.heading));
        var limj = Math.max(0.5, plan.HW[j] - o.corridor);
        var tl = clamp(lerp(lat, plan.OFF[j], o.softLine), -limj, limj);
        tx = Sj.x + nxj * tl; ty = Sj.y + nyj * tl;
      }
      var chi = hd + beta;
      var eChi = wrap(Math.atan2(ty - y, tx - x) - chi);
      var dist = Math.max(4, Math.hypot(tx - x, ty - y));
      var kpp = 2 * Math.sin(eChi) / dist;
      var kff = plan.K[(idx + Math.round(v * 0.2 / ds)) % n];
      var kCmd = kpp * 0.85 + kff * 0.25 + clamp(-latLine * 0.004, -0.02, 0.02) * (edge < 2 ? 2 : 1);
      var chiDot = v * kCmd;

      var vf = Math.max(vx, 1.5);
      var thetaVF = Math.atan2(vy + ci.a * r, vf);                // direction the front axle travels
      var mxS = maxSteerAt(P, Math.abs(vx)), mxS0 = mxS * 0.95;
      var delta, thr = 0, brk = 0, hb = false, ev = v - vt;

      // initiation only from a (nearly) straight car; a car still sliding the other way swings through (manji) under the hold law
      var vEntry = Infinity;
      for (q = 0; q <= leadN; q++) vEntry = Math.min(vEntry, plan.V[(idx + q) % n] * pace);
      var turnS = sgn(kff) || -dSign;
      var wantWide = (kff - kCmd) * turnS;                         // > 0: the line wants LESS rotation than the corner (we are cutting in)
      // ...and only into a corner that is still coming (never throw the car sideways while the target angle is collapsing)
      var cornerAhead = dAhead > 0.3 && Math.abs(betaGoal) >= Math.abs(betaT) * 0.85;
      var wantInit = cornerAhead && wantWide < o.initWideMax && st.initT <= 0 && st.initCool <= 0 && Math.abs(beta) < 6 * DEG && Math.abs(betaT) > 8 * DEG && v > 9 && ev < o.initMaxEv && v < vEntry + o.initEv;
      if (!drifting && Math.abs(beta) < o.exitBeta_deg * DEG) st.inDrift = false;
      else if (drifting && along < 1 * DEG && along > -4 * DEG && st.initT <= 0 && st.kickT <= 0 && st.initCool <= 0.3 && !wantInit) st.inDrift = false;
      if (drifting && (st.initT > 0 || st.kickT > 0 || along > 7 * DEG || along < -6 * DEG || wantInit)) st.inDrift = true;
      if (st.wasIn && !st.inDrift) st.tcGrip = Math.min(st.tcGrip, o.exitTc);
      st.wasIn = st.inDrift;
      if (st.inDrift) {
        /* ======== DRIFT ======== */
        st.iR = 0; st.entryBrake = false;
        // initiation: firm turn-in + full power (+ handbrake flick if the rear will not let go)
        if (wantInit) st.initT = 1e-6;
        if (st.initT > 0) {
          st.initT += dt;
          delta = -dSign * Math.min(o.turnIn_deg * DEG, mxS0);
          thr = 1;
          if (st.initT > (useKick ? 0.1 : 0.35) && along < 3 * DEG && st.kickCool <= 0) { st.kickT = 0.25; st.kickCool = 1.4; }
          var yawEnough = -dSign * r > Math.abs(v * kff) + 0.6;
          if (along > Math.abs(betaT) * 0.4 || yawEnough || st.initT > 1.2 || v < 8 || wantWide > o.initWideEnd) { st.initT = 0; st.initCool = 0.8; }
        } else {
          // angle hold: wheels follow the front axle's travel (natural counter-steer) + angle error + damping
          if (o.law === 2) {
            var chiD = v * (kff + clamp(kCmd - kff, -o.pathK, o.pathK));
            var rStar = chiD + o.Kbeta * (beta - betaT);
            var aff = Math.atan(clamp(v * Math.cos(beta) * rStar / (ci.muF * G), -1.1, 1.1) * ci.tanPkF);
            delta = thetaVF + aff + o.Kr * (rStar - r) + o.Kd * st.bDot;
            st.comp = [thetaVF / DEG, aff / DEG, o.Kr * (rStar - r) / DEG, o.Kd * st.bDot / DEG, chiD, rStar];
          } else {
          delta = thetaVF + o.Kb * (beta - betaT) + o.Kd * st.bDot;
          // path: a little extra yaw demand toward the line (bounded)
          delta += clamp((chiDot - v * kff) * o.Kpath, -o.pathAuth_deg * DEG, o.pathAuth_deg * DEG);
          }
          var eAng = Math.abs(betaT) - along;                        // + = need more angle
          st.iB = clamp(st.iB + eAng * dt, -0.25, 0.35);
          thr = o.holdThrottle + o.Kt * eAng + o.Ki * st.iB;
          // line via throttle: tighter than the line wants -> more power (wider + more angle); running wide -> lift
          thr += clamp(wantWide * o.Kpt * v, -o.KptMax, o.KptMax);
          if (over > 10 * DEG) thr *= clamp(1 - (over - 10 * DEG) * 3, 0.35, 1);
          if (along > 5 * DEG && over < 15 * DEG) thr = Math.max(thr, o.holdThrottleMin);   // welded diff snaps back on a lift
          if (along < -3 * DEG) thr = Math.min(thr, 0.5);           // sliding the wrong way: settle first
          // speed: left-foot brake (the drift is the throttle's job)
          var e0 = o.lfbEv0, e1 = o.lfbEv1;
          if (ev > e0) brk = clamp((ev - e0) * 0.15, 0, 0.5);
          if (ev > e1) { thr = Math.min(thr, clamp(0.6 - (ev - e1) * 0.08, 0.3, 0.6)); brk = Math.max(brk, clamp(0.35 + (ev - e1) * 0.08, 0, 0.7)); }
          // the auto-box drops a gear on brake > 0.15 (-> limiter -> rear hooks up): keep left-foot braking light
          if (ev < o.hardBrakeEv) brk = Math.min(brk, o.lfbMax);
        }
      } else {
        /* ======== GRIP (straights, approach, fast kinks) ======== */
        st.initT = 0; st.iB *= Math.exp(-dt * 3);
        var alphaH = wrap(Math.atan2(ty - y, tx - x) - hd);
        var dGeo = Math.atan2(2 * ci.wb * Math.sin(alphaH), Ld);
        var latDemand = clamp(v * chiDot / (ci.muF * G), -1, 1);
        var rD = chiDot;
        var eR = rD - r;
        st.iR = clamp(st.iR + eR * dt, -0.6, 0.6);
        var dYaw = thetaVF + Math.atan(latDemand * ci.tanPkF * 0.9) + 0.22 * eR + 0.08 * st.iR;
        delta = v > 4 ? lerp(dYaw, dGeo, 0.35) : clamp(alphaH * 1.2, -ci.lock, ci.lock);
        var err = vt - v;
        thr = err > 0 ? clamp(0.35 + err * 0.25, 0, 1) : 0;
        if (err < -1.2) brk = clamp(-err * 0.14, 0, 1);
        // approaching a drift corner too fast: brake in a straight line first
        st.entryBrake = drifting && ev > o.entryBrakeLo && (st.entryBrake || ev > o.entryBrakeHi);
        if (st.entryBrake) { brk = Math.max(brk, clamp(ev * 0.16, 0.25, 0.9)); thr = 0; }
        // traction control (welded diff + lots of power)
        var spin = num(state.wheelspin, 0);
        var slide = Math.abs(beta) > 3 * DEG || spin > 0.25 || rearKappa(state, vx) > o.kGrip || Math.abs(r - v * kff) > 0.25;
        st.tcGrip = slide ? Math.max(0.15, st.tcGrip - dt * 4) : Math.min(1, st.tcGrip + dt * 1.2);
        thr *= st.tcGrip;
        // rear stepping out with no drift wanted: catch it, no brakes, neutral throttle
        if (Math.abs(beta) > 4 * DEG && v > 10) {
          // extra counter-steer (same side as the slide) may go further than steering into it: kills the
          // pendulum snap when a welded rear re-grips at the end of a drift
          var xs = delta - thetaVF, xLim = sgn(xs) === sgn(beta) ? o.catchExtra_deg * DEG : 6 * DEG;
          delta = thetaVF + clamp(xs, -xLim, xLim) + o.Kd * 0.6 * st.bDot;
          brk = Math.min(brk, 0.1);
          thr = clamp(Math.max(thr, 0.2), 0.2, 0.4);
        }
        // exiting a drift: feed throttle smoothly while the rear re-grips
        if (Math.abs(beta) > 6 * DEG) thr = Math.min(thr, clamp(0.45 - (Math.abs(beta) - 6 * DEG) * 1.5, 0.15, 0.45));
      }
      if (st.inDrift) thr = Math.min(thr, o.thrCap);   // no auto-box kickdown mid-slide
      if (st.kickT > 0) { st.kickT -= dt; hb = true; thr = 1; brk = 0; }
      if (st.kickCool > 0) st.kickCool -= dt;
      if (st.initCool > 0) st.initCool -= dt;
      var steer = clamp(delta / mxS, -1, 1);
      // counter-steer at the lock: the front cannot hold the slide any more -> lift so the rear bites again
      var csat = st.inDrift && st.initT <= 0 && st.kickT <= 0 && sgn(delta) === sgn(beta) && Math.abs(beta) > 8 * DEG ? Math.abs(delta) / mxS : 0;
      if (csat > o.satLift) thr = Math.min(thr, lerp(thr, o.satThr, clamp((csat - o.satLift) / 0.12, 0, 1)));

      /* ---------------- hard safety: near-spin ---------------- */
      var ab = Math.abs(beta);
      if (ab > o.spinGuard_deg * DEG && v > 4) st.recover = Math.max(st.recover, 0.7);
      if (st.recover > 0) {
        st.recover -= dt;
        st.betaT = approach(st.betaT, 0, 3 * dt);
        st.initT = 0; st.kickT = 0;
        thr = ab > 45 * DEG ? 0.1 : 0.3;
        brk = ab > 75 * DEG ? 0.5 : 0.05;
        hb = false;
        steer = clamp((thetaVF + o.Kd * st.bDot) / mxS, -1, 1);    // point the wheels where the car is going
      }
      if (backwards && v > 3) { thr = 0; brk = 0.7; steer = clamp(thetaVF / mxS, -1, 1); }

      /* ---------------- smooth steering output (no twitchy wheels: slew limit + low-pass) ---------------- */
      if (o.steerRate > 0) {
        // catching the slide (adding counter-steer toward the velocity) is never slowed much: only turn-in / unwinding is smoothed
        var catching = ab > 8 * DEG && sgn(steer - st.lastSteer) === sgn(beta);
        var urgent = st.recover > 0 || backwards || over > 5 * DEG || ab > 45 * DEG;
        var sr = (urgent || catching ? o.steerRateFast : o.steerRate) * dt;
        var tau = urgent ? 0 : catching ? o.steerTau * 0.35 : o.steerTau;
        var sl = st.lastSteer + (steer - st.lastSteer) * (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
        steer = clamp(approach(st.lastSteer, sl, sr), -1, 1);
      }

      /* ---------------- gearbox: hold a drift gear with wheelspin headroom below the limiter ----------------
         (the auto-box drops gears on braking / locked rears and upshifts on the limiter; every shift is a torque gap) */
      var rpm = num(state.rpm, 0), gear = num(state.gear, 1), red = ci.redline;
      st.shiftCool = Math.max(0, num(st.shiftCool, 0) - dt);
      if (gearV.length && gear >= 1) {
        var vC = Infinity;
        for (q = 0; q <= leadN; q++) { var qi = (idx + q) % n; if (plan.D[qi] > 0.05) vC = Math.min(vC, plan.V[qi] * pace); }
        var gD = isFinite(vC) ? driftGear(vC) : 0;
        if (st.inDrift) {
          if (rpm > red * o.rpmCap) thr = Math.min(thr, thr * clamp(1 - (rpm - red * o.rpmCap) / (red * 0.04), 0.3, 1));
          if (brk > o.lfbNoShift && ev < o.hardBrakeEv) brk = o.lfbNoShift;
        }
        // angle-starved: full throttle, not enough wheelspin for the angle -> one gear down (more wheel torque)
        st.starveT = st.inDrift && st.initT <= 0 && thr >= o.thrCap - 0.05 && along < Math.abs(betaT) - 6 * DEG ? st.starveT + dt : 0;
        st.limT = st.inDrift && rpm > red * Math.min(o.upRpm, o.rpmCap - 0.03) ? st.limT + dt : 0;
        if (gD && drifting && st.shiftCool <= 0 && !num(state.shiftTimer, 0)) {
          var rpm0 = vC / gearV[gear - 1];                         // no-slip rpm at the corner speed in this gear
          var rpmDn = gear > 1 ? Math.abs(vx) / gearV[gear - 2] : Infinity;
          if (st.inDrift) {
            if (st.limT > o.limT_s && gear < gearV.length && Math.abs(vx) / gearV[gear] > red * 0.3) { out.shiftUp = true; st.shiftCool = 1.2; st.limT = 0; }
            else if (st.starveT > o.starveT && gear > 1 && rpmDn < red * 0.8) { out.shiftDown = true; st.shiftCool = 1.5; st.starveT = 0; }
          } else if (rpm0 > red * gearHi && gear < gearV.length) { out.shiftUp = true; st.shiftCool = 0.5; }
          else if (gear > 1 && rpm0 < red * gearLo && vC / gearV[gear - 2] < red * gearHi && rpmDn < red * 0.85) { out.shiftDown = true; st.shiftCool = 1.0; }
        }
      }

      /* ---------------- stuck / lost ---------------- */
      if (v < 1.5 && phase !== 'finished') st.stuckT += dt; else st.stuckT = Math.max(0, st.stuckT - dt * 2);
      if (st.stuckT > 4 || (edge < -14 && v < 6)) { out.requestReset = true; st.stuckT = 0; }
      if (v < 2 && thr < 0.3 && brk < 0.1) thr = 0.5;

      if (brk > 0.05 && !(drifting && along > 5 * DEG)) thr = Math.min(thr, 0.15);
      out.throttle = clamp01(thr);
      out.brake = clamp01(brk);
      out.steer = steer;
      out.handbrake = hb;
      if (ctx.finished || phase === 'finished') out.throttle *= 0.6;
      st.lastSteer = steer; st.lastIndex = idx;
      var gd = guard(state, dt, { beta: beta, betaT: betaT, along: along, dSign: dSign, v: v, vx: vx, edge: edge, lat: lat, idx: idx, kff: kff,
        inDrift: st.inDrift && st.initT <= 0 && st.kickT <= 0, recover: st.recover > 0, backwards: backwards, phase: phase }, ctx);
      st.dbg = { index: idx, v: v, vt: vt, beta_deg: beta / DEG, betaT_deg: betaT / DEG, eChi: eChi, rD: chiDot, r: r,
        delta: delta, steer: steer, throttle: out.throttle, brake: out.brake, handbrake: hb, drifting: drifting,
        recover: st.recover > 0, init: st.initT > 0, inDrift: st.inDrift, entryBrake: st.entryBrake, edge: edge, latLine: latLine, over_deg: over / DEG, comp: st.comp, mxS: mxS / DEG, guard: gd };
      return out;
    }

    return {
      kind: 'drift-ai',
      opponent: opponent,
      plan: plan,
      control: control,
      reset: function () { st = freshState(); },
      debug: function () { return Object.assign({}, st.dbg); },
      setAngle: function (deg) { o.angle_deg = clamp(num(deg, o.angle_deg), 5, 55); },
      setPace: function (k) { o.pace = clamp(num(k, 1), 0.3, 1.3); },
      options: o
    };
  }

  /** Engine-compatible signature (CB.race.ai.createDriver(entrant, geom, params, opts)). */
  function createDriver(entrant, geom, params, opts) {
    return createDriftDriver(entrant, geom, params, opts && opts.drift ? opts.drift : null);
  }

  /** Wrap a regular AI module so selected entrants drive with the drift AI (others unchanged). */
  function asEngineAi(baseAi, pick) {
    pick = typeof pick === 'function' ? pick : function (ent) { return !!(ent && (ent.drift || ent.driftLead || ent.role === 'tandem-lead')); };
    var out = {};
    if (baseAi) Object.keys(baseAi).forEach(function (k) { out[k] = baseAi[k]; });
    out.createDriver = function (entrant, geom, params, opts) {
      if (pick(entrant, opts) || !baseAi || typeof baseAi.createDriver !== 'function') return createDriver(entrant, geom, params, opts);
      return baseAi.createDriver(entrant, geom, params, opts);
    };
    return out;
  }

  /* ------------------------------------------------------------- simulate
     Headless run on a track with CB.race.vehicle. Walls: if the car passes the barrier line it is pushed
     back and loses most of its speed (counted as wallHits). Stats per corner sample are collected where
     the plan's drift intensity is > 0.5.                                                               */
  function simulate(geomIn, params, opts) {
    opts = opts || {};
    var V = opts.vehicle || (CB.race && CB.race.vehicle);
    var geom = resolveGeom(geomIn);
    if (!V || !geom) throw new Error('drift.ai.simulate: needs CB.race.vehicle and a track geometry');
    var drv = opts.driver || createDriftDriver(opts.opponent || { skill: 1 }, geom, params, opts.ai);
    var dt = num(opts.dt, 1 / 120), laps = num(opts.laps, 1), maxT = num(opts.maxTime, 600);
    var S = geom.samples, s0 = S[0], startIdx = num(opts.startIndex, 0);
    var sp = S[startIdx];
    var state = V.createState(params, { x: sp.x, y: sp.y, heading: sp.heading, speed: num(opts.startSpeed, 0) }, { autoShift: true });
    var env = { gripMult: 1, wet: 0, surface: 'asphalt', assists: { autoShift: true } };
    var t = 0, progress = 0, hint = startIdx, lastS = num(sp.s, 0);
    var stats = { time: 0, laps: 0, lapTimes: [], maxBeta_deg: 0, spins: 0, wallHits: 0, offTrack_s: 0, offTrackMax_m: 0,
      cornerBetaSum: 0, cornerN: 0, cornerBetaAvg_deg: 0, driftTime_s: 0, resets: 0, minEdge_m: Infinity, completed: false,
      betaTrace: [] };
    var lapStartT = 0, spinLatch = false, n = S.length;
    void s0;
    while (t < maxT) {
      var ctx = { t: t, dt: dt, phase: 'racing', index: hint, nearby: [] };
      var inp = drv.control(state, ctx, dt);
      if (inp.requestReset) {
        stats.resets++;
        var rp = S[hint];
        V.reset(params, state, { x: rp.x, y: rp.y, heading: rp.heading, speed: 0 });
      }
      var pr = projectOn(geom, state.x, state.y, hint);
      env.surface = pr.surface === 'wall' ? 'asphalt' : (pr.surface || 'asphalt');
      env.gripMult = pr.surface === 'grass' ? 0.6 : pr.surface === 'sand' ? 0.5 : pr.surface === 'kerb' ? 0.95 : 1;
      V.step(params, state, inp, dt, env);
      t += dt;
      pr = projectOn(geom, state.x, state.y, hint);
      hint = pr.index;
      var sm = S[pr.index], al = Math.abs(pr.lateral);
      var wall = pr.lateral >= 0 ? num(sm.wallL, sm.hw + 6) : num(sm.wallR, sm.hw + 6);
      if (al > wall - 0.9) {
        stats.wallHits++;
        // push back inside and scrub speed (very simple barrier)
        var nx = num(sm.nx, -Math.sin(sm.heading)), ny = num(sm.ny, Math.cos(sm.heading)), sd = sgn(pr.lateral);
        var push = al - (wall - 1.0);
        state.x -= nx * sd * push; state.y -= ny * sd * push;
        state.vx *= 0.4; state.vy *= 0.2; state.yawRate *= 0.3;
      }
      var edge = sm.hw - al;
      if (edge < -0.3) { stats.offTrack_s += dt; stats.offTrackMax_m = Math.max(stats.offTrackMax_m, -edge); }
      stats.minEdge_m = Math.min(stats.minEdge_m, edge);
      var vv = Math.hypot(state.vx, state.vy);
      var b = vv > 3 && state.vx > 0.5 ? Math.atan2(state.vy, state.vx) : (vv > 3 ? PI * sgn(state.vy || 1) : 0);
      var abd = Math.abs(b) / DEG;
      if (vv > 3) stats.maxBeta_deg = Math.max(stats.maxBeta_deg, abd);
      if (abd > 90 && vv > 3) { if (!spinLatch) { stats.spins++; spinLatch = true; } } else if (abd < 30) spinLatch = false;
      if (abd > 12 && vv > 6) stats.driftTime_s += dt;
      if (drv.plan && drv.plan.D[pr.index] > 0.5 && vv > 6) { stats.cornerBetaSum += abd; stats.cornerN++; }
      if (opts.trace && ((t / dt) | 0) % 12 === 0) stats.betaTrace.push([Math.round(t * 10) / 10, pr.index, Math.round(abd), Math.round(vv * 3.6), Math.round(pr.lateral * 10) / 10]);
      // progress
      var dS = pr.s - lastS;
      if (dS > geom.length / 2) dS -= geom.length; else if (dS < -geom.length / 2) dS += geom.length;
      progress += dS; lastS = pr.s;
      if (progress >= geom.length * (stats.laps + 1)) {
        stats.laps++; stats.lapTimes.push(t - lapStartT); lapStartT = t;
        if (stats.laps >= laps) { stats.completed = true; break; }
      }
      if (opts.onStep) opts.onStep(state, inp, pr, t, drv);
    }
    void n;
    stats.time = t;
    stats.progress_m = progress;
    stats.cornerBetaAvg_deg = stats.cornerN ? stats.cornerBetaSum / stats.cornerN : 0;
    return stats;
  }

  CB.race.drift.ai = {
    createDriftDriver: createDriftDriver,
    createDriver: createDriver,
    asEngineAi: asEngineAi,
    buildPlan: buildPlan,
    maxSteerAt: maxSteerAt,
    simulate: simulate,
    DEFAULTS: DEFAULTS,
    _internal: { carInfo: carInfo, projectOn: projectOn, resolveGeom: resolveGeom, wrap: wrap }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.race.drift.ai;

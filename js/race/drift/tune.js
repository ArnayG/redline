/* ==========================================================================
   FORGE Atelier — js/race/drift/tune.js
   CB.race.drift.tune : drift-mode handling tune for CB.race.vehicle params.

   Pure logic (no DOM). Classic <script> in browsers, require()-able in Node.

   tune.apply(params, { level, build?, powerCap? }) -> NEW frozen params (input is never mutated)
     level: 'grip' | 'street' (default) | 'pro' | 'competition'
     What it changes (all relative to the real vehicle.fromBuild() params shape):
       * steering: more lock (up to 60 deg), quicker rack (steerRate), maxSteer alias
       * drivetrain: welded/locked rear diff (lockR), RWD-biased torque for FWD/AWD
         (grip level: FWD -> rear-biased AWD; street+: full RWD conversion), soft centre coupling,
         wide-peak rear tyres capped so a held slide settles instead of snapping,
         traction control / ESC yaw guard off (tcLevel 0) on street+
       * tyres: slightly lower rear grip, higher front grip, more progressive slide
         (lower magic-formula shape factor C -> less grip drop past the peak), wider rear kappa peak
         (no hook/let-go limit cycle while sliding = the drift sustains and doesn't twitch), slicks capped
       * drift aero: downforce capped and moved forward, active aero off (no mid-slide grip steps)
       * yaw inertia multiplier (calmer rotation on easy levels, sharper on comp)
       * power: every car reaches a minimum effective power (~350 hp street) by
         scaling the torque table; optional soft cap for absurd hypercars
       * gearbox: upshift points pushed to the limiter (auto box holds the gear
         while sliding) + p.driftGearing hint {holdGear, minRpm, maxRpm}
       * handbrake: stronger, for flick initiation
       * nose-heavy cars get extra front grip shift; EV regen softened, rotating
         inertia lowered (light flywheel / EV motor) so the rears regain grip on a lift
     Adds p.drift = { level, tuned:true, changes summary } and recomputes
     p.capabilities / maxLatG / power aliases.

   tune.recommendedBuildPatch(build) -> partial build ("Drift setup" button).
   tune.forBuild(build, metrics?, opts?) -> fromBuild + apply in one call.
   tune.wrapVehicle(V, opts) -> vehicle-module facade whose fromBuild() returns
     tuned params (for engine sessions: swap CB.race.vehicle while creating).
   tune.gearFor(params, speed_mps) -> best drift gear for a speed (rpm band).
   tune.LEVELS, tune.DEFAULT_LEVEL, tune.levelInfo(level).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var HP_KW = 0.7457;
  var RADS_TO_RPM = 60 / (Math.PI * 2);

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }
  /** Deep copy of plain data (arrays / objects / primitives). */
  function copy(o) {
    if (Array.isArray(o)) return o.map(copy);
    if (o && typeof o === 'object') {
      var out = {};
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = copy(o[k]);
      return out;
    }
    return o;
  }

  /* ------------------------------------------------------------ levels
     lock_deg       steering lock (wheel angle at full lock)
     steerRate      multiplier on rack speed
     lockR          minimum rear-diff lock (1 = welded / spool)
     muR / muF      rear / front grip multipliers
     shapeCMax      cap on magic-formula C (lower = more progressive slide)
     peakR          multiplier on rear peak slip angle (wider slide window)
     peakRMax       cap on the rear peak slip (tan); wide-peak tyres (all-season/off-road) otherwise
                    build grip with angle and then snap -> the held slide never settles
     iz             yaw inertia multiplier
     minHp          minimum effective power
     maxHp          soft power cap (null = none) — very high power is scaled down toward it
     splitF         maximum front torque share for AWD / converted FWD (0 = full RWD conversion: measured on
                    every preset, any front drive share on street made the low-grip AWD/FWD cars spin or push)
     lockC          maximum AWD centre coupling (lets rears overspeed)
     tc             maximum traction-control level (0 = off, no ESC yaw guard)
     handbrake      handbrake torque multiplier
     shiftT         maximum shift time (s) — a long full-torque-cut upshift mid-slide lets the rears
                    re-grip for a moment and the car snaps straight (the "twitch" players feel)
     shiftCut       minimum fraction of drive torque kept during a shift (seamless-shift emulation)
     kapR           rear kappa-peak multiplier ("drift tyre": rear side grip stays nearly constant while the
                    wheels spin -> a held slide settles instead of hook/let-go cycling; faded out for wf > 0.55)
     kapRTail       extra kappa-peak for tail-heavy cars (wf < 0.5, full at 0.42)
     clAMax/dfFMin  drift aero: downforce cap (excess kept at 15 %) and minimum front downforce share
     muMax          cap on rear mu (slicks / semi-slicks scaled down to drift-tyre grip, balance kept)
     engInertia     optional flywheel multiplier for ICE cars (default 0.8) */
  var LEVELS = {
    grip:        { label: 'Grip',        lock_deg: 45, steerRate: 1.25, lockR: 0.6, muR: 0.97, muF: 1.02, shapeCMax: 1.38, peakR: 1.0,
                   kapR: 1.0, clAMax: 0.6, dfFMin: 0.42, muMax: 1.45,
                   iz: 1.04, minHp: 300, maxHp: null, splitF: 0.30, lockC: 0.15, tc: 1, handbrake: 1.15, shiftT: 0.12, shiftCut: 0.45 },
    street:      { label: 'Street',      lock_deg: 54, steerRate: 1.80, lockR: 0.9, muR: 0.88, muF: 1.06, shapeCMax: 1.22, peakR: 1.0, peakRMax: 0.14,
                   kapR: 1.6, kapRTail: 0.6, clAMax: 0.35, dfFMin: 0.45, muMax: 1.15,
                   iz: 1.04, minHp: 350, maxHp: 700, splitF: 0.00, lockC: 0.02, tc: 0, shiftT: 0.10, shiftCut: 0.55, handbrake: 1.35 },
    pro:         { label: 'Pro',         lock_deg: 57, steerRate: 1.90, lockR: 1.0, muR: 0.87, muF: 1.07, shapeCMax: 1.28, peakR: 1.0, peakRMax: 0.14,
                   kapR: 1.6, kapRTail: 0.6, clAMax: 0.45, dfFMin: 0.45, muMax: 1.20,
                   iz: 1.00, minHp: 380, maxHp: 900, splitF: 0.00, lockC: 0.00, tc: 0, shiftT: 0.10, shiftCut: 0.55, handbrake: 1.45 },
    competition: { label: 'Competition', lock_deg: 60, steerRate: 2.00, lockR: 1.0, muR: 0.86, muF: 1.08, shapeCMax: 1.34, peakR: 1.0, peakRMax: 0.14,
                   kapR: 1.5, kapRTail: 0.5, clAMax: 0.6, dfFMin: 0.45, muMax: 1.30,
                   iz: 0.96, minHp: 450, maxHp: null, splitF: 0.00, lockC: 0.00, tc: 0, shiftT: 0.10, shiftCut: 0.55, handbrake: 1.55 }
  };
  var DEFAULT_LEVEL = 'street';
  var ORDER = ['grip', 'street', 'pro', 'competition'];

  function levelOf(l) { return LEVELS[l] ? l : DEFAULT_LEVEL; }

  /* ------------------------------------------------------- vehicle module */
  function V() { return CB.race && CB.race.vehicle; }

  function torqueAt(p, rpm) {
    var tab = p.torqueTable;
    if (!Array.isArray(tab) || !tab.length) return fin(p.peakNm, 300);
    var f = Math.max(0, rpm) / 50, i = Math.floor(f);
    if (i >= tab.length - 1) return tab[tab.length - 1];
    return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
  }

  /** Estimated current (peak) horsepower of a params object. */
  function hpOf(p) {
    var kw = fin(p.powerKw, fin(p.power_kw, NaN));
    if (!isFinite(kw)) kw = fin(p.power_hp, 300) * HP_KW;
    return kw / HP_KW;
  }

  /* ---------------------------------------------------------------- apply */
  function apply(params, opts) {
    opts = opts || {};
    if (!params || typeof params !== 'object') throw new Error('drift.tune.apply: params required');
    var level = levelOf(opts.level);
    var L = LEVELS[level];
    if (opts.overrides && typeof opts.overrides === 'object') {
      L = copy(L);
      for (var ok in opts.overrides) if (typeof opts.overrides[ok] === 'number' && isFinite(opts.overrides[ok])) L[ok] = opts.overrides[ok];
    }
    // re-tuning already-tuned params starts again from the untuned original (no compounding)
    if (params.drift && params.drift.tuned && params.drift.base && typeof params.drift.base === 'object') params = params.drift.base;
    var p = copy(params);
    var orig = params;
    var changes = [];

    /* --- steering --- */
    var lock0 = fin(orig.lockAngle, 0.6);
    var lock = Math.max(lock0, L.lock_deg * DEG);
    lock = Math.min(lock, 60 * DEG);
    p.lockAngle = lock;
    p.maxSteer = lock;
    p.steerRate = clamp(fin(orig.steerRate, 3.4) * L.steerRate, 2, 9);
    changes.push('lock ' + Math.round(lock0 / DEG) + '°→' + Math.round(lock / DEG) + '°');

    /* --- drivetrain: RWD bias, locked rear --- */
    var layout0 = orig.layout === 'fwd' || orig.layout === 'awd' ? orig.layout : 'rwd';
    var splitT = clamp(L.splitF, 0, 0.9);
    if (layout0 === 'rwd' || (layout0 !== 'rwd' && splitT <= 0.001)) {
      // pure RWD (native, or full conversion on the top level)
      p.layout = 'rwd';
      p.splitF = 0;
      p.lockC = 0;
      if (layout0 !== 'rwd') changes.push(layout0.toUpperCase() + '\u2192RWD');
    } else if (layout0 === 'fwd') {
      // rear-biased AWD conversion: the front still pulls a little (keeps straight-line exits tidy)
      p.layout = 'awd';
      p.splitF = splitT;
      p.lockC = L.lockC;
      changes.push('FWD\u2192RWD-biased AWD ' + Math.round((1 - p.splitF) * 100) + '% rear');
    } else {
      p.layout = 'awd';
      p.splitF = Math.min(fin(orig.splitF, 0.4), splitT);
      p.lockC = Math.min(fin(orig.lockC, 0.35), L.lockC);
      changes.push('AWD split ' + Math.round((1 - p.splitF) * 100) + '% rear');
    }
    p.lockR = Math.max(fin(orig.lockR, 0), L.lockR);
    // a locked front diff fights the steering when the front is driven
    p.lockF = Math.min(fin(orig.lockF, 0), 0.3);
    p.torqueVectoring = false;
    p.tcLevel = Math.min(fin(orig.tcLevel, 2), L.tc);
    p.launchControl = false;
    changes.push(p.lockR >= 0.95 ? 'welded rear diff' : 'tight rear LSD');

    /* --- tyres / balance --- */
    // weight-distribution compensation: nose-heavy cars (FWD conversions, front V12s, pickups) push through
    // a slide -> shift grip toward the front like a ~52 % front car (tail-heavy cars are left alone: tested worse)
    var wfBias = clamp(fin(orig.weightFront, 0.52) - 0.52, 0, 0.12) * fin(L.wfComp, 1);
    p.muR = fin(orig.muR, 1) * L.muR * (1 - wfBias);
    p.muF = fin(orig.muF, 1) * L.muF * (1 + wfBias);
    // semi-slick / slick race tyres: so much grip the car never breaks traction at drift speeds -> scale both
    // axles down (balance preserved) to a drift-tyre level
    if (isFinite(fin(L.muMax, NaN)) && p.muR > L.muMax) { var muK = L.muMax / p.muR; p.muR *= muK; p.muF *= muK; changes.push('drift tyres'); }
    var C = Math.min(fin(orig.shapeC, 1.42), L.shapeCMax);
    p.shapeC = C;
    p.shapeB = Math.tan(Math.PI / (2 * C));
    // wide-peak tyres (all-season / winter / off-road) never settle into a held slide: the rear keeps
    // gaining grip as the angle grows, then lets go all at once -> cap the rear peak slip angle
    p.tanAlphaPeakR = clamp(Math.min(fin(orig.tanAlphaPeakR, 0.12) * L.peakR, fin(L.peakRMax, 0.3)), 0.05, 0.3);
    /* rear longitudinal slip stiffness ("drift tyre"): in the combined-slip tyre model the rear lateral force is
       F * sy / sqrt(sx^2 + sy^2), sx = kappa / kappaPeakR. On a welded diff at the limiter kappa ~0.5-1, so the
       rear side grip swings ~2.5x between "spinning" and "hooked up" with every throttle change, through the
       slow engine+wheel spin-up lag -> a 2-3 s hook/let-go limit cycle (the held drift dies, then snaps).
       A wider kappa peak keeps the rear side force nearly constant while the wheels spin: the slide settles
       on the angle instead of cycling (steady-drift yaw jitter -55 % across the presets, see tests).
       Faded out for nose-heavy cars (wf > 0.55): they lack rear rotation already and would push. */
    if (isFinite(fin(L.kapR, NaN)) && isFinite(fin(orig.kappaPeakR, NaN))) {
      var kFade = clamp((0.6 - fin(orig.weightFront, 0.52)) / 0.05, 0, 1);
      // tail-heavy mid/rear-engined racers (wf < 0.5) pendulum the most: a little extra
      var kTail = fin(L.kapRTail, 0) * clamp((0.5 - fin(orig.weightFront, 0.52)) / 0.08, 0, 1);
      p.kappaPeakR = orig.kappaPeakR * (1 + (L.kapR - 1) * kFade + kTail);
    }
    // keep front cornering stiffness consistent with the new (higher) front mu
    p.tanAlphaPeakF = clamp(fin(orig.tanAlphaPeakF, 0.12) * Math.sqrt(L.muF), 0.05, 0.3);

    /* --- drift aero: downforce is computed from vx^2 in the vehicle model, so on a downforce car the rear
           grip changes with the drift angle AND the speed -> as a slide scrubs speed or swings wider the rear
           re-grips (snap) or lets go (spin). Cap it, move the balance forward (front authority for the
           counter-steer) and switch off active aero (it toggled 0.55x downforce on/off mid-slide whenever the
           assist centred the wheel at full throttle). --- */
    var clA0 = fin(orig.clA, 0);
    var clAMax = fin(L.clAMax, Infinity);
    if (clA0 > clAMax) {
      p.clA = clAMax + (clA0 - clAMax) * fin(L.clAKeep, 0.15);
      if (isFinite(fin(orig.downforce_kg_200, NaN))) p.downforce_kg_200 = orig.downforce_kg_200 * p.clA / clA0;
      changes.push('drift aero ' + Math.round(clA0 / Math.max(p.clA, 1e-6) * 10) / 10 + 'x less downforce');
    }
    if (clA0 > 0.05 && isFinite(fin(L.dfFMin, NaN))) p.dfFrontFrac = Math.max(fin(orig.dfFrontFrac, 0.45), L.dfFMin);
    if (orig.activeAero && L.tc === 0) p.activeAero = false;

    /* --- yaw inertia --- */
    p.Iz = fin(orig.Iz, 2500) * L.iz;

    /* --- power: floor (every car can drift) and soft cap --- */
    var hp0 = hpOf(orig);
    var hpT = hp0;
    var minHp = fin(opts.minHp, L.minHp);
    var maxHp = opts.powerCap === false ? null : fin(opts.powerCap, L.maxHp);
    if (hp0 < minHp) hpT = minHp;
    else if (maxHp != null && hp0 > maxHp) hpT = maxHp + (hp0 - maxHp) * 0.25; // soft knee
    var pm = clamp(hpT / Math.max(hp0, 1), 0.2, 6);
    if (Math.abs(pm - 1) > 1e-6) {
      if (Array.isArray(orig.torqueTable)) p.torqueTable = orig.torqueTable.map(function (t) { return t * pm; });
      p.peakNm = fin(orig.peakNm, 300) * pm;
      p.frictionNm = fin(orig.frictionNm, 30) * Math.sqrt(pm);
      p.powerKw = hpT * HP_KW;
      p.power_kw = p.powerKw;
      p.power_hp = hpT;
      if (p.expected && typeof p.expected === 'object') p.expected.power_hp = hpT;
      changes.push(Math.round(hp0) + '→' + Math.round(hpT) + ' hp');
    }

    /* --- EV / hybrid regen: strong lift-off regen on a locked rear axle snaps the car round --- */
    if (fin(orig.regen, 0) > 0) p.regen = Math.min(fin(orig.regen, 0), L.tc > 0 ? 1 : 0.5);

    /* --- rotating inertia: lightweight flywheel; EV motor inertia reflected through a single tall reduction
           otherwise keeps the rears spinning (no lateral grip) long after a lift --- */
    p.engineInertia = fin(orig.engineInertia, 0.2) * (orig.isEV ? (opts.evInertia != null ? opts.evInertia : 0.3) : fin(L.engInertia, 0.8));

    /* --- brakes: stronger handbrake for flicks --- */
    p.handbrakeTorque = fin(orig.handbrakeTorque, 3000) * L.handbrake;

    /* --- gearbox: hold gears in a slide, shift at the limiter --- */
    var red = fin(orig.redline, 7000);
    if (Array.isArray(orig.upshiftRpm)) {
      p.upshiftRpm = orig.upshiftRpm.map(function (u) { return Math.max(fin(u, red * 0.95), red * 0.965); });
    }
    // quick, part-torque shifts: a shift in a slide is a soft blip instead of a grip snap
    if (!orig.isCVT && fin(orig.maxGear, 1) > 1) {
      p.shiftTime = Math.min(fin(orig.shiftTime, 0.25), fin(L.shiftT, 0.1));
      p.shiftCut = Math.max(fin(orig.shiftCut, 0), fin(L.shiftCut, 0.5));
    }
    // coast downshifts later: the box doesn't drop a gear every time the assist feathers the throttle
    if (Array.isArray(orig.downshiftRpm)) p.downshiftRpm = orig.downshiftRpm.map(function (d) { return fin(d, red * 0.4) * 0.8; });
    var peakRpm = fin(orig.peakNmRpm, red * 0.6);
    p.driftGearing = {
      holdGear: true,                                    // auto-box should not upshift while |beta| > ~10 deg
      minRpm: clamp(Math.max(peakRpm * 0.85, red * 0.5), fin(orig.idle, 800) + 800, red * 0.8),
      maxRpm: red * 0.97,
      shiftUpAt: red * 0.975
    };

    /* --- metadata --- */
    p.drift = {
      tuned: true, level: level, label: L.label,
      originalHp: hp0, effectiveHp: hpT, originalLayout: layout0,
      lock_deg: lock / DEG, rearBias: 1 - p.splitF, changes: changes
    };
    // non-enumerable: invisible to JSON / deepFreeze / copy, used for re-tuning
    Object.defineProperty(p.drift, 'base', { value: orig, enumerable: false });
    p.name = orig.name;

    /* --- recompute derived envelope --- */
    p.capabilities = undefined;
    var Vm = V();
    if (Vm && typeof Vm.capabilities === 'function') {
      try { p.capabilities = Vm.capabilities(p); } catch (e) { p.capabilities = copy(orig.capabilities); }
    } else p.capabilities = copy(orig.capabilities);
    if (p.capabilities) {
      p.maxLatG = p.capabilities.maxLatG;
      p.maxBrakeG = p.capabilities.maxBrakeG;
      p.topSpeed_ms = p.capabilities.topSpeed_mps;
    }
    return deepFreeze(p);
  }

  /* -------------------------------------------------------------- helpers */

  /** fromBuild + apply. */
  function forBuild(build, metrics, opts) {
    var Vm = V();
    if (!Vm || typeof Vm.fromBuild !== 'function') throw new Error('drift.tune.forBuild: CB.race.vehicle missing');
    return apply(Vm.fromBuild(build, metrics || null, opts && opts.fromBuildOpts), Object.assign({ build: build }, opts || {}));
  }

  /**
   * wrapVehicle(V, opts) -> vehicle facade. fromBuild() returns drift-tuned params
   * (only for the player when opts.playerOnly, detected via fromBuild opts.isPlayer).
   */
  function wrapVehicle(Vm, opts) {
    Vm = Vm || V();
    opts = opts || {};
    var w = {};
    for (var k in Vm) w[k] = Vm[k];
    w.fromBuild = function (build, metrics, fbOpts) {
      var p = Vm.fromBuild(build, metrics, fbOpts);
      if (opts.playerOnly && !(fbOpts && fbOpts.isPlayer)) return p;
      if (p && p.drift && p.drift.tuned) return p;
      return apply(p, { level: opts.level, build: build, powerCap: opts.powerCap });
    };
    w._driftWrapped = true;
    return w;
  }

  /** Best gear to hold for a drift at speed v (keeps rpm in the drift band). */
  function gearFor(p, v) {
    v = Math.abs(fin(v, 0));
    if (p.isCVT || !Array.isArray(p.ratios) || p.maxGear <= 1) return 1;
    var g = p.driftGearing || {};
    var minR = fin(g.minRpm, p.redline * 0.55), maxR = fin(g.maxRpm, p.redline * 0.97);
    var rD = p.layout === 'fwd' ? p.radiusF : p.radiusR;
    var slipF = 1.12; // rears overspeed ~12 % while sliding
    var best = 1, bestScore = -Infinity;
    for (var i = 1; i <= p.maxGear; i++) {
      var rpm = v * slipF / rD * p.ratios[i - 1] * p.finalDrive * RADS_TO_RPM;
      var score;
      if (rpm > maxR) score = -1e6 - rpm;
      else if (rpm < minR) score = -(minR - rpm);
      else score = torqueAt(p, rpm) * p.ratios[i - 1] * 1e-3 + 1e3; // inside band: most wheel torque
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /* ----------------------------------------------------- drift gearbox
     The vehicle's stock auto box is a road-car box: it short-shifts at part throttle (the assist feathers
     the throttle 0.2-0.6 to hold an angle), kicks down at full throttle and coast-downshifts on every
     lift. In a slide every one of those shifts is a torque step on the rear axle -> the rear re-grips or
     spins up -> a yaw snap. Measured on Kurogane Pass with heavy assist: ~1 shift every 1.7 s, several
     mid-drift and a 1-2-1-2 kickdown hunt at 55 km/h.
     The drift box holds the gear while sliding (only leaves it when the engine sits on the limiter or
     bogs for a while), never kicks down in a slide, and uses wide hysteresis + a minimum dwell outside one.
     Decision only (pure): returns { shiftUp, shiftDown, sliding, reason }; state lives in `mem`.      */
  function drivenOmegaOf(p, s) {
    var w = s && s.wheels;
    if (!Array.isArray(w) || w.length < 4) return NaN;
    var o = function (i) { return fin(w[i] && w[i].omega, 0); };
    if (p.layout === 'fwd') return (o(0) + o(1)) * 0.5;
    if (p.layout === 'awd') { var sf = clamp(fin(p.splitF, 0.4), 0, 1); return ((o(0) + o(1)) * sf + (o(2) + o(3)) * (1 - sf)) * 0.5; }
    return (o(2) + o(3)) * 0.5;
  }
  function gearboxDecide(p, s, input, dt, mem) {
    var out = { shiftUp: false, shiftDown: false, sliding: false, reason: '' };
    var g = s.gear;
    if (!(g >= 1) || p.isCVT || !Array.isArray(p.ratios) || !(p.maxGear > 1)) return out;
    dt = clamp(fin(dt, 1 / 120), 0, 0.1);
    var G = p.driftGearing || {};
    var red = fin(p.redline, 7000), idle = fin(p.idle, 800), fd = fin(p.finalDrive, 3.5);
    var rD = p.layout === 'fwd' ? fin(p.radiusF, 0.32) : fin(p.radiusR, 0.32);
    var vx = fin(s.vx, 0), vy = fin(s.vy, 0), v = Math.sqrt(vx * vx + vy * vy);
    var beta = Math.atan2(vy, Math.max(Math.abs(vx), 0.5));
    var thr = clamp(fin(input && input.throttle, 0), 0, 1), brk = clamp(fin(input && input.brake, 0), 0, 1);
    var slidingNow = Math.abs(beta) > 8 * DEG && v > 5;
    mem.slideT = slidingNow ? 1.2 : Math.max(0, fin(mem.slideT, 0) - dt);   // slide memory: covers transitions
    mem.since = fin(mem.since, 9) + dt;
    mem.load = fin(mem.load, thr) + (thr - fin(mem.load, thr)) * (1 - Math.exp(-dt / 0.8));
    var sliding = out.sliding = mem.slideT > 0;
    var ratio = function (k) { return fin(p.ratios[k - 1], 1) * fd; };
    var om = drivenOmegaOf(p, s);
    var rpmW = isFinite(om) ? Math.abs(om) * ratio(g) * RADS_TO_RPM : fin(s.rpm, idle);   // includes wheelspin
    var rpmG = function (k) { return Math.abs(vx) / rD * ratio(k) * RADS_TO_RPM; };       // ground-speed rpm
    var minR = fin(G.minRpm, red * 0.55), upR = fin(G.shiftUpAt, red * 0.975);
    var load = Math.max(thr, mem.load);
    var up = false, down = false;
    // --- upshift
    if (g < p.maxGear && brk < 0.1) {
      var upAt = sliding ? upR : lerp(red * 0.5, Math.min(upR, fin(p.upshiftRpm && p.upshiftRpm[g - 1], upR)), Math.pow(load, 0.65));
      if (rpmW > upAt) mem.hiT = fin(mem.hiT, 0) + dt; else mem.hiT = 0;
      // sliding: only upshift if the next gear lands inside the drift band. Otherwise the box goes up, bogs
      // below minRpm, drops back a second later and the rears spin up again: a 1-2-1-2 hunt every ~1 s in a
      // steady skidpad drift (measured on alpine-gt / rally-legend) = a torque step (twitch) each time.
      // Staying on the limiter is the lesser evil (and sounds right).
      var nextOk = sliding ? rpmG(g + 1) >= minR : rpmG(g + 1) > idle + 500;
      if (mem.hiT > (sliding ? 0.3 : 0.05) && mem.since > (sliding ? 1.0 : 0.6) && nextOk) { up = true; out.reason = sliding ? 'limiter' : 'upshift'; }
    } else mem.hiT = 0;
    // --- downshift
    if (!up && g > 1) {
      var lower = Math.max(rpmG(g - 1), rpmW * ratio(g - 1) / ratio(g) * (sliding ? 0 : 1));
      var cur = rpmG(g);
      if (sliding) {
        if (cur < minR * 0.8 && Math.max(rpmW, cur) < minR) mem.loT = fin(mem.loT, 0) + dt; else mem.loT = 0;
        if (mem.loT > 0.5 && mem.since > 1.0 && lower < red * 0.88) { down = true; out.reason = 'bog'; }
      } else {
        mem.loT = 0;
        var upLower = lerp(red * 0.5, Math.min(upR, fin(p.upshiftRpm && p.upshiftRpm[g - 2], upR)), Math.pow(load, 0.65));
        var downAt = lerp(Math.max(idle + 500, red * 0.3), fin(p.downshiftRpm && p.downshiftRpm[g - 1], red * 0.35), Math.pow(load, 0.8));
        if (mem.since > 0.35 && brk > 0.15 && lower < red * 0.78) { down = true; out.reason = 'brake'; }
        else if (mem.since > 1.0 && cur < downAt && lower < Math.min(red * 0.85, upLower * 0.8)) { down = true; out.reason = 'coast'; }
        else if (mem.since > 1.5 && thr > 0.92 && lower < red * 0.8 &&
                 torqueAt(p, lower) * ratio(g - 1) > torqueAt(p, Math.max(cur, idle)) * ratio(g) * 1.15) { down = true; out.reason = 'kickdown'; }
        else if (cur < idle * 1.1 && lower < red * 0.85) { down = true; out.reason = 'idle'; }
      }
    }
    if (up || down) mem.since = 0;
    out.shiftUp = up; out.shiftDown = down;
    return out;
  }

  /** createGearbox(params) -> { update(state, input, dt) -> {shiftUp, shiftDown, sliding, reason}, reset() }.
      For callers that run the vehicle with env.assists.autoShift = false and want the drift box. */
  function createGearbox(params) {
    var mem = {};
    return {
      update: function (s, input, dt) { return gearboxDecide(params, s, input, dt, mem); },
      reset: function () { mem = {}; },
      state: function () { return copy(mem); }
    };
  }

  /**
   * installGearbox(Vm?) — wraps Vm.step (default CB.race.vehicle) ONCE so that drift-tuned params
   * (p.driftGearing.holdGear) run the drift box instead of the stock auto box. Everything else
   * (untuned params, manual gearbox, env.assists.autoShift === false, reverse/neutral, CVT) goes straight
   * to the original step, unchanged. Idempotent; returns true when the wrapper is active.
   * Auto-installed on load (opt out with CB.race.drift.noDriftGearbox = true before loading tune.js).
   */
  function installGearbox(Vm) {
    Vm = Vm || V();
    if (!Vm || typeof Vm.step !== 'function') return false;
    if (Vm.step._driftGearbox) return true;
    var orig = Vm.step;
    var wrapped = function (p, s, input, dt, env) {
      var G = p && p.driftGearing;
      var as = env && env.assists;
      if (!G || !G.holdGear || !s || typeof s !== 'object' || !(s.gear >= 1) || p.isCVT || !(p.maxGear > 1) ||
          (as && as.autoShift === false) || (s.autoShift === false && !(as && as.autoShift))) {
        return orig.apply(this, arguments);
      }
      var mem = s._driftBox || (s._driftBox = {});
      var inp = {};
      if (input) for (var k in input) inp[k] = input[k];
      if (inp.shiftUp || inp.shiftDown) mem.since = 0;          // driver / assist asked explicitly: respect it
      else {
        var d = gearboxDecide(p, s, inp, dt, mem);
        if (d.shiftUp) inp.shiftUp = true;
        else if (d.shiftDown) inp.shiftDown = true;
      }
      var e2 = {};
      if (env) for (var ek in env) e2[ek] = env[ek];
      var a2 = {};
      if (as) for (var ak in as) a2[ak] = as[ak];
      a2.autoShift = false;
      e2.assists = a2;
      var res;
      try { res = orig.call(this, p, s, inp, dt, e2); }
      finally { s.autoShift = true; }                           // still an automatic box for HUD / later steps
      return res;
    };
    wrapped._driftGearbox = true;
    wrapped._original = orig;
    Vm.step = wrapped;
    return true;
  }
  function uninstallGearbox(Vm) {
    Vm = Vm || V();
    if (Vm && Vm.step && Vm.step._driftGearbox) { Vm.step = Vm.step._original; return true; }
    return false;
  }

  /* ----------------------------------------------- recommendedBuildPatch */
  function get(o, path, d) {
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return d; o = o[parts[i]]; }
    return o === undefined ? d : o;
  }
  function estHp(build) {
    var Vm = V();
    try {
      if (CB.physics && typeof CB.physics.compute === 'function') {
        var m = CB.physics.compute(build);
        if (m && isFinite(m.power_hp)) return m.power_hp;
        if (m && isFinite(m.power_kw)) return m.power_kw / HP_KW;
      }
    } catch (e) { /* ignore */ }
    try { if (Vm && typeof Vm.estimatePowerKw === 'function') return Vm.estimatePowerKw(build || {}) / HP_KW; } catch (e2) { /* ignore */ }
    return 300;
  }

  /**
   * recommendedBuildPatch(build) -> partial build for the configurator "Drift setup" button.
   * Only uses catalog ids that exist in CB.data (differentials, tunes, steeringTypes ...).
   */
  function recommendedBuildPatch(build) {
    build = build || {};
    var isEV = get(build, 'engine.type', 'ice') === 'ev';
    var patch = {
      drivetrain: {
        layout: 'rwd', rearDiff: 'locking', frontDiff: 'open', centerDiff: 'none',
        torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 0
      },
      suspension: {
        camberFront_deg: -3.5, camberRear_deg: -0.8, toeFront_deg: 0.1, toeRear_deg: 0.2,
        arbFront: 7, arbRear: 3,
        springFront_nmm: Math.round(clamp(fin(get(build, 'suspension.springFront_nmm', 60), 60) * 1.25, 60, 200)),
        springRear_nmm: Math.round(clamp(fin(get(build, 'suspension.springRear_nmm', 60), 60) * 0.95, 40, 180)),
        damping: 6
      },
      tires: {},
      brakes: { abs: 'sport' },
      interior: { steering: 'race-quick-release' },
      aero: { wing: get(build, 'aero.wing', 'none') === 'none' ? 'ducktail' : get(build, 'aero.wing', 'none') }
    };
    var comp = get(build, 'tires.compound', 'performance');
    if (comp === 'slick' || comp === 'track' || comp === 'eco' || comp === 'winter') patch.tires.compound = 'performance';
    var twF = fin(get(build, 'tires.widthFront_mm', 245), 245), twR = fin(get(build, 'tires.widthRear_mm', twF), twF);
    // rear no wider than front + 20 mm: a narrower rear breaks away progressively
    if (twR > twF + 20) patch.tires.widthRear_mm = twF + 20;
    if (!isEV) {
      var hp = estHp(build);
      var tuneId = get(build, 'engine.tune', 'stock');
      if (hp < 250) patch.engine = { tune: 'stage2' };
      else if (hp < 350 && (tuneId === 'eco' || tuneId === 'stock')) patch.engine = { tune: 'stage1' };
      var trT = get(build, 'transmission.type', 'dct');
      if (trT === 'cvt' || trT === 'auto') patch.transmission = { type: 'sequential' };
    }
    if (!Object.keys(patch.tires).length) delete patch.tires;
    return patch;
  }

  function levelInfo(l) {
    var k = levelOf(l), L = LEVELS[k];
    return { id: k, label: L.label, lock_deg: L.lock_deg, minHp: L.minHp, rearDiff: L.lockR >= 0.95 ? 'welded' : 'LSD', tc: L.tc };
  }

  var api = {
    apply: apply,
    forBuild: forBuild,
    wrapVehicle: wrapVehicle,
    gearFor: gearFor,
    createGearbox: createGearbox,
    installGearbox: installGearbox,
    uninstallGearbox: uninstallGearbox,
    _gearboxDecide: gearboxDecide,
    recommendedBuildPatch: recommendedBuildPatch,
    levelInfo: levelInfo,
    LEVELS: deepFreeze(copy(LEVELS)),
    LEVEL_ORDER: ORDER.slice(),
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    _hpOf: hpOf
  };
  CB.race.drift.tune = api;
  if (!CB.race.drift.noDriftGearbox) installGearbox();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

/* ==========================================================================
   Redline — js/f1/f1-car.js
   CB.f1.car : the single-spec Formula 1 car (docs/F1-SPEC.md §3). Pure logic, no DOM, Node-loadable.

   Every car on an F1 grid is this car: difficulty changes AI skill only.

     params(opts?) -> frozen CB.race.vehicle params            opts { drsOpen, ers: true|false (deploying, default true) }
         ~1000 hp hybrid (ICE 600 kW + ERS 140 kW), 800 kg, 8-speed seamless, 3.6 m wheelbase, downforce ∝ v²
         (≈ 2× weight at 250 km/h, ≈ 3× at 300), CdA 1.2 (DRS open: −22 % drag, −26 % rear downforce), ≈ 5 g brakes.
         Cached per variant (4 objects), so hooks can swap them every step.
     variant(drsOpen, ersDeploy) -> one of the cached params
     SPEC                                                     the headline numbers (UI / tests)

     COMPOUNDS { soft, medium, hard, inter, wet } -> { id, name, letter, color, wet:false|true, grip [dry, damp, wet],
                window [lo, hi] °C, heat, life_km (at wearMult 1), blanket °C }
     createTyres(compound, opts { temp_c, trackTemp_c, wearMult, age }) -> tyre state
         { compound, temp: [4] °C, wear: [4] 0..1, age (laps), dist_m, slipE: [4] J }
     stepTyres(ts, vehicleState, dt, env { wetness 0..1, trackTemp_c, speed }) -> ts   (driving-dependent heat + wear)
     tyreGrip(ts, wetness) -> [4] wheel grip multipliers (1 = a fresh dry soft... medium at its window)
     tyreFactor(compound, temp, wear, wetness) -> scalar
     tyreSummary(ts) -> { compound, wear: [4], temp: [4], avgWear, avgTemp, age, inWindow }

     drs.eligibleAt({ gap_s, lap, mode, weather, enabled }) -> bool      race: within 1.0 s at detection, from lap 3
     drs.zoneAt(zones, s) -> index | -1                                  zones [{detect_s, start_s, end_s}] (metres)
     ERS: ers.create(opts) -> { soc 0..1, mode 'auto'|'boost'|'harvest', deploying, harvesting, lapDeploy_J }
          ers.step(es, dt, ctx { throttle, brake, speed, gear, boostHeld, ax, mass, lapStart }) -> es (deploy decision for
          the NEXT step is es.deploying)
     pitStopTime(rng?, opts { crew 0..1, compoundChange }) -> stationary seconds (~2.0–3.4, mean ≈ 2.5)
     PIT_LIMIT_KPH 80 (Monaco 60 via circuit meta)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var G = 9.81, RHO = 1.225;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function V() {
    if (CB.race && CB.race.vehicle && typeof CB.race.vehicle.fromBuild === 'function') return CB.race.vehicle;
    if (typeof require === 'function') { try { return require('../race/vehicle.js'); } catch (e) { /* ignore */ } }
    return CB.race && CB.race.vehicle;
  }
  function teams() {
    if (CB.f1.teams) return CB.f1.teams;
    if (typeof require === 'function') { try { return require('./f1-teams.js'); } catch (e) { /* ignore */ } }
    return null;
  }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }

  /* ================================================================ spec */
  var SPEC = {
    mass_kg: 800, weightFront: 0.455, wheelbase_m: 3.6, track_m: 1.6, cgHeight_m: 0.28, Iz: 1150,
    length_m: 5.63, width_m: 2.0,
    ice_kw: 600, ers_kw: 140, redline: 12500, idle: 4000,
    ratios: [3.05, 2.42, 2.02, 1.73, 1.50, 1.32, 1.18, 1.065], finalDrive: 4.6, shiftTime: 0.03,
    cdA: 1.3, clA: 5.1, dfFrontFrac: 0.42, drsDrag: 0.78, drsRearDf: 0.74,
    mu: 1.95, radiusF: 0.36, radiusR: 0.362, brakeG: 4.25, brakeBias: 0.56, lockAngle: 0.5,
    ersStore_J: 4e6
  };

  /** Torque curve of the 1.6 V6 turbo hybrid (ICE): ~490 Nm plateau 9–11.5k, power peak ~600 kW at 11 500 rpm. */
  function iceCurve(kw) {
    var pts = [[3000, 300], [4000, 360], [5000, 420], [6000, 465], [7000, 490], [8000, 505], [9000, 510], [10000, 510],
      [11000, 505], [11500, 498], [12000, 470], [12500, 430], [13000, 360]];
    // scale so the power peak is `kw`
    var peak = 0;
    pts.forEach(function (p) { peak = Math.max(peak, p[1] * p[0] * Math.PI / 30 / 1000); });
    var k = kw / peak;
    return pts.map(function (p) { return { rpm: p[0], nm: p[1] * k }; });
  }

  function shiftPoints(p) {
    var up = [], down = [], n = p.maxGear, T = V().torqueAt;
    for (var g = 1; g <= n; g++) {
      if (g === n) { up.push(p.redline * 0.985); continue; }
      var r1 = p.ratios[g - 1], r2 = p.ratios[g], best = p.redline * 0.975;
      for (var rpm = p.redline * 0.6; rpm <= p.redline * 0.985; rpm += 50) {
        if (T(p, rpm * r2 / r1) * r2 >= T(p, rpm) * r1) { best = Math.max(rpm, p.redline * 0.8); break; }
      }
      up.push(Math.min(best, p.redline * 0.985));
    }
    for (var d = 1; d <= n; d++) down.push(d === 1 ? 0 : up[d - 2] * 0.82 * p.ratios[d - 1] / p.ratios[d - 2]);
    p.upshiftRpm = up; p.downshiftRpm = down;
  }

  var CACHE = {};
  function build0() {
    var T = teams();
    if (T && T.buildFor) return T.buildFor(T.ids[0]);
    var b = null;
    try { if (CB.data && CB.data.defaultBuild) b = CB.data.defaultBuild(); } catch (e) { b = null; }
    return b || {};
  }

  function makeBase() {
    var VV = V();
    var metrics = {
      weight_kg: SPEC.mass_kg, weightFront_pct: SPEC.weightFront * 100, cgHeight_mm: SPEC.cgHeight_m * 1000,
      redlineRpm: SPEC.redline, idleRpm: SPEC.idle, power_kw: SPEC.ice_kw + SPEC.ers_kw,
      curve: iceCurve(SPEC.ice_kw + SPEC.ers_kw), cda: SPEC.cdA,
      downforce_kg_200: SPEC.clA * 0.5 * RHO * Math.pow(200 / 3.6, 2) / G,
      gripFront: SPEC.mu, gripRear: SPEC.mu
    };
    var b = build0();
    b = JSON.parse(JSON.stringify(b));
    b.transmission = Object.assign({}, b.transmission || {}, { type: 'dct', gears: 8, ratios: SPEC.ratios.slice(), finalDrive: SPEC.finalDrive, launchControl: true });
    b.drivetrain = Object.assign({}, b.drivetrain || {}, { layout: 'rwd', rearDiff: 'lsd-plated', tractionControl: 2 });
    b.brakes = Object.assign({}, b.brakes || {}, { abs: 'race' });
    var base = VV.fromBuild(b, metrics, { noPhysics: true });
    var p = Object.assign({}, base);
    var mg = SPEC.mass_kg * G;
    p.name = 'Formula 1'; p.bodyStyle = 'f1'; p.isHybrid = true; p.isEV = false; p.f1 = true;
    p.mass = SPEC.mass_kg; p.weightFront = SPEC.weightFront; p.cgHeight = SPEC.cgHeight_m;
    p.wheelbase = SPEC.wheelbase_m; p.a = SPEC.wheelbase_m * (1 - SPEC.weightFront); p.b = SPEC.wheelbase_m * SPEC.weightFront;
    p.track = SPEC.track_m; p.Iz = SPEC.Iz; p.length_m = SPEC.length_m; p.width_m = SPEC.width_m;
    // tyres: warm slicks (the per-wheel grip from temperature / wear / wetness comes in through env.wheelGrip)
    p.radiusF = SPEC.radiusF; p.radiusR = SPEC.radiusR;
    p.IwF = 0.62 * 11 * SPEC.radiusF * SPEC.radiusF + 0.15; p.IwR = 0.62 * 12.5 * SPEC.radiusR * SPEC.radiusR + 0.2;
    p.muF = SPEC.mu; p.muR = SPEC.mu; p.muXScale = 1.08;
    p.wetRatio = 0.85;   // neutral vs. the engine's weather factor: compound wet behaviour lives in tyreGrip()
    p.shapeC = 1.6; p.shapeB = Math.tan(Math.PI / (2 * p.shapeC));
    p.tanAlphaPeakF = 0.13; p.tanAlphaPeakR = 0.12; p.kappaPeakF = 0.11; p.kappaPeakR = 0.11;
    // load sensitivity referenced so the substep tyre and the AI's latAccelAt() agree (0.35 · df / mg)
    p.loadSens = 0.1;
    p.fzRefF = mg * SPEC.weightFront / 2; p.fzRefR = mg * (1 - SPEC.weightFront) / 2;
    p.fz0F = p.fz0R = mg / (4 * 0.35);
    p.rollingRes = 0.012; p.compound = 'slick';
    p.driveXF = p.driveXWarmF = 1; p.driveXR = p.driveXWarmR = 0.80;   // traction-limited out of slow corners (0–100 ≈ 2.6 s)
    // aero
    p.cdA = SPEC.cdA; p.clA = SPEC.clA; p.dfFrontFrac = SPEC.dfFrontFrac; p.sideCdA = 3.4; p.activeAero = false;
    p.downforce_kg_200 = SPEC.clA * 0.5 * RHO * Math.pow(200 / 3.6, 2) / G;
    // power unit + gearbox: seamless (full torque carried through a 30 ms shift)
    p.redline = SPEC.redline; p.limiterRpm = SPEC.redline + 80; p.idle = SPEC.idle;
    p.turbo = false; p.turboLag = 0; p.naFrac = 1; p.engineInertia = 0.06; p.frictionNm = 55;
    p.ratios = SPEC.ratios.slice(); p.finalDrive = SPEC.finalDrive; p.maxGear = 8; p.isCVT = false; p.reverseRatio = SPEC.ratios[0] * 1.05;
    p.transmission = 'seamless'; p.shiftTime = SPEC.shiftTime; p.shiftCut = 1; p.efficiency = 0.94; p.converter = false;
    p.launchControl = true; p.launchRpm = 9200; p.preSpool = 1; p.clutchRamp = 0.16; p.clutchRamp0 = 0.6; p.shiftCap = 1; p.gearTorque = null;
    p.governor = Infinity; p.layout = 'rwd'; p.splitF = 0; p.lockR = 0.55; p.lockF = 0; p.lockC = 0; p.torqueVectoring = false;
    p.tcLevel = 2; p.absLevel = 2;
    // brakes: carbon-carbon, ~4.25 g of tyre force + aero drag ≈ 5 g at 300 km/h; grip-limited (~2 g) at low speed
    p.brakeBias = SPEC.brakeBias; p.brakeForceMax = SPEC.brakeG * mg;
    p.maxBrakeTorqueF = p.brakeForceMax * SPEC.brakeBias * SPEC.radiusF / 2;
    p.maxBrakeTorqueR = p.brakeForceMax * (1 - SPEC.brakeBias) * SPEC.radiusR / 2;
    p.handbrakeTorque = p.maxBrakeTorqueR * 1.5;
    p.rsdF = 0.52; p.loadTau = 0.045;
    p.lockAngle = SPEC.lockAngle; p.steerRate = 3.6;
    p.regen = 0;
    shiftPoints(p);
    return p;
  }

  function finish(p) {
    var VV = V();
    delete p.capabilities;
    p.capabilities = VV.capabilities(p);
    p.maxLatG = p.capabilities.maxLatG; p.maxBrakeG = p.capabilities.maxBrakeG; p.topSpeed_ms = p.capabilities.topSpeed_mps;
    p.power_kw = p.powerKw; p.power_hp = p.powerKw / 0.7457; p.maxSteer = p.lockAngle; p.rollingResistance = p.rollingRes;
    p.autoShift = true;
    p.expected = { zeroTo100_s: p.capabilities.est0to100_s, topSpeed_kph: p.capabilities.topSpeed_mps * 3.6, lateralG: p.maxLatG, power_hp: p.power_hp };
    return deepFreeze(p);
  }

  function variant(drsOpen, ersDeploy) {
    var key = (drsOpen ? 'd' : '-') + (ersDeploy === false ? '-' : 'e');
    if (CACHE[key]) return CACHE[key];
    var p = makeBase();
    if (ersDeploy === false) {
      var k = SPEC.ice_kw / (SPEC.ice_kw + SPEC.ers_kw);
      p.torqueTable = p.torqueTable.map(function (x) { return x * k; });
      p.peakNm *= k; p.powerKw *= k;
    }
    if (drsOpen) {
      var dfR = 1 - SPEC.dfFrontFrac, total = SPEC.dfFrontFrac + dfR * SPEC.drsRearDf;
      p.cdA = SPEC.cdA * SPEC.drsDrag; p.clA = SPEC.clA * total; p.dfFrontFrac = SPEC.dfFrontFrac / total;
    }
    p.f1Variant = key;
    CACHE[key] = finish(p);
    return CACHE[key];
  }
  function params(opts) { opts = opts || {}; return variant(!!opts.drsOpen, opts.ers !== false); }

  /* ================================================================ tyres */
  var COMPOUNDS = {
    soft:   { id: 'soft',   name: 'Soft',         letter: 'S', color: '#ff2e3d', wet: false, grip: [1.035, 0.86, 0.60], window: [88, 112], heat: 1.12, life_km: 95,  blanket: 75 },
    medium: { id: 'medium', name: 'Medium',       letter: 'M', color: '#ffd23f', wet: false, grip: [1.0,   0.84, 0.58], window: [92, 118], heat: 1.0,  life_km: 150, blanket: 75 },
    hard:   { id: 'hard',   name: 'Hard',         letter: 'H', color: '#f4f5f7', wet: false, grip: [0.972, 0.82, 0.56], window: [96, 125], heat: 0.9,  life_km: 215, blanket: 70 },
    inter:  { id: 'inter',  name: 'Intermediate', letter: 'I', color: '#22d36b', wet: true,  grip: [0.88,  1.0,  0.9],  window: [55, 95],  heat: 0.95, life_km: 120, blanket: 60 },
    wet:    { id: 'wet',    name: 'Wet',          letter: 'W', color: '#2f8bff', wet: true,  grip: [0.80,  0.94, 1.0],  window: [45, 85],  heat: 0.85, life_km: 140, blanket: 60 }
  };
  var COMPOUND_IDS = ['soft', 'medium', 'hard', 'inter', 'wet'];
  function compound(id) { return COMPOUNDS[id] || COMPOUNDS.medium; }

  // thermal model: one lumped tread temperature per tyre
  var TYRE_C = 4000;        // J/K (≈ one lap to settle)
  var COOL_K = 12;          // W/K at standstill; × (1 + v / 20) with airflow
  var HEAT_K = 4.2;         // tread heating: HEAT_K · P^0.75 (P = slip power, W; half own wheel, half the car average)
  var WEAR_E_REF = 1.1e7;   // J of slip work per tyre for 100 % wear on a 'life_km = 100' compound at the reference slip

  function createTyres(id, opts) {
    opts = opts || {};
    var c = compound(id);
    var t0 = num(opts.temp_c, c.blanket);
    return { compound: c.id, temp: [t0, t0, t0, t0], wear: [0, 0, 0, 0], age: num(opts.age, 0), dist_m: 0,
      slipE: [0, 0, 0, 0], wearMult: num(opts.wearMult, 1), trackTemp_c: num(opts.trackTemp_c, 35) };
  }
  /** Compound grip vs wetness (dry 0, damp 0.5, wet 1), × temperature window, × wear. */
  function tyreFactor(id, temp, wear, wetness) {
    var c = compound(id), w = clamp(num(wetness, 0), 0, 1);
    var g = w <= 0.5 ? lerp(c.grip[0], c.grip[1], w / 0.5) : lerp(c.grip[1], c.grip[2], (w - 0.5) / 0.5);
    var lo = c.window[0], hi = c.window[1], T = num(temp, lo);
    var tf = 1;
    if (T < lo) tf = 1 - 0.17 * clamp((lo - T) / 45, 0, 1) - 0.05 * clamp((lo - T - 45) / 40, 0, 1);
    else if (T > hi) tf = 1 - 0.1 * clamp((T - hi) / 30, 0, 1.5);
    var wr = clamp(num(wear, 0), 0, 1);
    var wf = 1 - 0.06 * wr - (wr > 0.72 ? 0.32 * Math.pow((wr - 0.72) / 0.28, 1.6) : 0);
    return g * tf * wf;
  }
  function tyreGrip(ts, wetness) {
    var out = [1, 1, 1, 1];
    for (var i = 0; i < 4; i++) out[i] = tyreFactor(ts.compound, ts.temp[i], ts.wear[i], wetness);
    return out;
  }
  /** Heat + wear from the vehicle state's per-wheel forces / slips (CB.race.vehicle wheels). */
  function stepTyres(ts, vs, dt, env) {
    env = env || {};
    var c = compound(ts.compound), wet = clamp(num(env.wetness, 0), 0, 1);
    var amb = num(env.trackTemp_c, ts.trackTemp_c) - wet * 15;
    var v = Math.abs(num(vs && vs.vx, 0));
    var W = vs && vs.wheels;
    var hot = c.window[1];
    // wet tyres on a drying / dry track overheat and wear quickly; slicks in the wet run cold
    var wetCool = c.wet ? (1 + 1.4 * wet) : (1 + 2.2 * wet);
    var wetWear = c.wet ? (1 + 2.6 * Math.max(0, 0.45 - wet)) : 1;
    var Pw = [0, 0, 0, 0], Pavg = 0;
    for (var i0 = 0; i0 < 4; i0++) {
      var w0 = W && W[i0], P0 = 0;
      if (w0) {
        var vx0 = Math.abs(num(w0._wvx, v)), vl0 = Math.max(vx0, 3);
        P0 = Math.abs(num(w0.fx, 0) * num(w0.kappa, 0) * vl0) + Math.abs(num(w0.fy, 0) * Math.tan(num(w0.alpha, 0)) * vl0);
        if (w0.locked) P0 += Math.abs(num(w0.load, 2000)) * 1.2 * vx0;   // a flat-spotting lock-up
      }
      Pw[i0] = Math.min(P0, 4e5); Pavg += Pw[i0] / 4;
    }
    for (var i = 0; i < 4; i++) {
      var P = Pw[i];
      var T = ts.temp[i];
      var cool = COOL_K * (1 + v / 20) * wetCool * (T - amb);
      ts.temp[i] = T + (HEAT_K * c.heat * Math.pow(0.35 * P + 0.65 * Pavg, 0.75) - cool) * dt / TYRE_C;
      ts.slipE[i] += P * dt;
      var over = T > hot ? 1 + (T - hot) / 18 : 1;
      var cold = T < c.window[0] - 25 ? 1.15 : 1;   // graining
      ts.wear[i] = Math.min(1, ts.wear[i] + P * dt * over * cold * wetWear * ts.wearMult * (100 / c.life_km) / WEAR_E_REF);
    }
    ts.dist_m += v * dt;
    return ts;
  }
  function tyreSummary(ts) {
    var c = compound(ts.compound), aw = 0, at = 0, inw = 0;
    for (var i = 0; i < 4; i++) { aw += ts.wear[i]; at += ts.temp[i]; if (ts.temp[i] >= c.window[0] && ts.temp[i] <= c.window[1]) inw++; }
    return { compound: c.id, letter: c.letter, color: c.color, wear: ts.wear.map(r3), temp: ts.temp.map(r1), avgWear: r3(aw / 4), avgTemp: r1(at / 4), age: ts.age, inWindow: inw };
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  /* ================================================================ DRS */
  var drs = {
    DETECT_GAP_S: 1.0, FROM_LAP: 3,
    /** lap = the lap the car is ON (1-based). Race: within 1 s at the detection point, from lap 3. Practice / quali: free. */
    eligibleAt: function (o) {
      o = o || {};
      if (o.enabled === false || o.weather === 'wet') return false;
      if (o.mode !== 'race') return true;
      if (num(o.lap, 1) < drs.FROM_LAP) return false;
      return num(o.gap_s, Infinity) <= drs.DETECT_GAP_S;
    },
    zoneAt: function (zones, s, L) {
      if (!zones) return -1;
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i], a = z.start_s, b = z.end_s;
        if (b >= a ? (s >= a && s <= b) : (s >= a || s <= b)) return i;
      }
      return -1;
    }
  };

  /* ================================================================ ERS */
  var ERS_MODES = ['auto', 'boost', 'harvest'];
  var ers = {
    MODES: ERS_MODES, STORE_J: SPEC.ersStore_J, DEPLOY_W: SPEC.ers_kw * 1000, HARVEST_W: 120000, LAP_DEPLOY_J: 4e6,
    create: function (opts) {
      opts = opts || {};
      return { soc: clamp(num(opts.soc, 0.9), 0, 1), mode: ERS_MODES.indexOf(opts.mode) >= 0 ? opts.mode : 'auto',
        deploying: false, harvesting: false, lapDeploy_J: 0 };
    },
    /** Updates the store with what the last step did, then decides whether the next step deploys. */
    step: function (es, dt, ctx) {
      ctx = ctx || {};
      var store = ers.STORE_J, v = Math.abs(num(ctx.speed, 0)), thr = num(ctx.throttle, 0), brk = num(ctx.brake, 0);
      if (ctx.lapStart) es.lapDeploy_J = 0;
      // what the previous step used
      if (es.deploying) { var e = ers.DEPLOY_W * dt * Math.min(1, thr); es.soc -= e / store; es.lapDeploy_J += e; }
      var harvest = 0;
      if (brk > 0.05 && v > 8) harvest = Math.min(ers.HARVEST_W, 0.32 * brk * num(ctx.mass, 800) * 45 * v);
      else if (thr < 0.25 && v > 25) harvest = 25000;
      if (thr > 0.9 && v > 30) harvest += 32000;                          // MGU-H style recovery at full throttle
      if (es.mode === 'harvest' && thr > 0.5 && v > 30) harvest += 40000;
      es.harvesting = harvest > 0;
      es.soc = clamp(es.soc + harvest * dt / store, 0, 1);
      // next step
      var boost = es.mode === 'boost' || !!ctx.boostHeld;
      var budget = es.lapDeploy_J < ers.LAP_DEPLOY_J || boost;
      var want;
      if (es.mode === 'harvest' && !ctx.boostHeld) want = false;
      else if (boost) want = thr > 0.2 && es.soc > 0.005;
      else want = thr > 0.92 && v > 22 && num(ctx.gear, 1) >= 2 && es.soc > 0.12 && budget;
      es.deploying = !!want && es.soc > 0;
      return es;
    }
  };

  /* ================================================================ pit stop */
  /** Stationary time of a stop: a slick change ≈ 2.4 s, crew variance, the occasional slow wheel. */
  function pitStopTime(rng, opts) {
    opts = opts || {};
    var r = typeof rng === 'function' ? rng : Math.random;
    var crew = clamp(num(opts.crew, 0.85), 0, 1);
    var t = 2.15 + (1 - crew) * 0.5 + r() * 0.45;
    if (r() < 0.06) t += 0.8 + r() * 2.2;   // a slow wheel nut
    return Math.round(t * 100) / 100;
  }

  CB.f1.car = {
    VERSION: 1, SPEC: SPEC, params: params, variant: variant,
    COMPOUNDS: COMPOUNDS, COMPOUND_IDS: COMPOUND_IDS, compound: compound,
    createTyres: createTyres, stepTyres: stepTyres, tyreGrip: tyreGrip, tyreFactor: tyreFactor, tyreSummary: tyreSummary,
    drs: drs, ers: ers, pitStopTime: pitStopTime, PIT_LIMIT_KPH: 80,
    _internal: { iceCurve: iceCurve, makeBase: makeBase, CACHE: CACHE }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.car;

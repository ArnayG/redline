/* ==========================================================================
   FORGE Atelier — js/game/endurance.js
   CB.game.endurance : tyre thermals & wear, fuel / battery energy, mass change,
   damage zones, brake temperature & fade, engine cooling, pit stops, pit-lane
   geometry and race strategy.  Contract: GAME-SPEC.md § "Wear, fuel, damage, pits".

   Pure module (no DOM). Classic script in browsers, require()-able in Node.
   All per-car state is a plain JSON-serialisable object (no functions, no
   Math.random — a seeded PRNG state lives inside the car state), so it can be
   snapshotted, cloned, replayed and stored.

   ---------------------------------------------------------------- API
   createCarState(vehicleParams, build, opts?) -> carState
       opts { compound, tank_l, fuel_l, refFuel_l, soc (0..1), battery_kwh, crewQuality 0..1,
              tireBlankets bool, blanketTemp_c, tireTemp_c, coldPressure_kpa, ambient_c, trackTemp_c,
              weather, timeOfDay, wearMult, fuelMult, damageMult, thermalMult, seed, fuelMap,
              features {tires, fuel, damage, brakes, thermal} }
       -> { tireWear:[fl,fr,rl,rr] 0..1, tireTemp_c:[4] (tread surface), tireCore_c:[4], tirePressure_kpa:[4],
            tireGrip:[4], punctured:[4], compound, fuel_l, tankCapacity_l, battery|null,
            damage:{front,rear,left,right,engine,aero}, suspension:[4], brakeTemp_c, brakeTemps_c:[front,rear],
            brakeWear, brakeFade, engineTemp_c, mass_kg, ... }
   step(carState, vehicleState, input, dt, env?) -> carState (mutated)
       env { ambient_c, trackTemp_c, wetness 0..1 | wet bool, weather, timeOfDay, surface, onTrack, lap, gripMult }
   modifiers(carState) -> { gripMult:[front, rear], powerMult, dragMult, downforceMult, steerPull (+ = left, steer units),
                             brakeMult, wheelGrip:[4], rollingMult, massRatio, mass_kg, engineAlive }
   applyImpact(carState, impulse (N·s | {x,y}), localDir ({x,y}|[x,y]|angle rad, body frame x fwd y left), opts?)
       -> { severity, dv, zones, puncture }
   pitStop(carState, request {tires: bool|[4 bools], compound?, fuel_l?, fuelTo_l?, charge_kwh?, repair: bool|'quick'|'full',
           brakes?: bool, crewQuality?, tireBlankets?, sequential?, lap?}) -> { duration_s, newState, breakdown, ... }
   pitLaneInfo(trackOrGeom?, opts?) -> { entry_s, exit_s, length_m, speedLimit_kph, laneLoss_s, derived }
   inPitLane(s, info) -> bool
   suggestStrategy(laps, trackLength (m | geom | trackDef), carParams (vehicle params | {params, build, ...}), opts?)
       -> { stops, stints:[...], pitStops:[...], totalTime_s, fuelPerLap, wearPerLap, alternatives, notes, ... }
   simulateLap(carParams, trackLength, opts?) / simulateStint(carParams, trackLength, laps, opts?)
       -> physically simulated synthetic laps using this very model (used by the strategy helper)
   liveAdvice(carState, {lapsRemaining, trackLength_m?}) -> { box, urgency, reasons, lapsOfFuel, lapsOfTires, request }
   summary(carState) -> compact HUD / snapshot object
   drainEvents(carState) -> [{type, text, wheel?, value?, t}]
   setFuelMap(carState, 'lean'|'normal'|'rich'|'push')
   environment(weather, timeOfDay, opts?) -> { ambient_c, trackTemp_c, wetness }
   tempGrip(compoundId, temp_c), wearGrip(wear), compoundInfo(id), COMPOUNDS, FUELS, FUEL_MAPS, PIT_SPEED_LIMIT_KPH
   createHooks(opts?) -> race-engine hook object { carCreated, preStep, postStep, modifiers, onImpact, snapshot, pitStop, advice,
                          vehicleParams(car), vehicleEnv(car, env), state }
   applyToParams(vehicleParams, mods, {cache?, massMode?}) -> derived CB.race.vehicle params (fuel mass, torque, cdA, clA, brakes)
   vehicleEnv(mods, env?) -> CB.race.vehicle step env with per-wheel grip & puncture rolling drag merged
       (CB.race.vehicle's env.dragMult is a SURFACE drag term — aero drag goes through applyToParams instead)
   clone(carState)

   Conventions: tyre index order FL, FR, RL, RR (same as CB.race.vehicle wheels). Wear 0 = new, 1 = destroyed
   (a tyre that reaches 1.0 punctures). Damage 0 = pristine, 1 = destroyed.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

(function () {
  'use strict';

  /* ================================================================ constants */
  var G = 9.81;
  var RHO = 1.225;
  var SIGMA = 5.670374e-8;
  var KELVIN = 273.15;
  var PIT_SPEED_LIMIT_KPH = 60;
  var FUEL_RATE_LPS = 2.5;          // refuelling rig flow (L/s)
  var EV_CHARGE_KWPS = 0.6;          // "HyperCharge" pit charger: kWh per second below 80 % SoC
  var EV_TAPER_KWPS = 0.2;           // above 80 % SoC
  var WEAR_ENERGY_REF = 4.7e7;       // J of slip energy a treadwear-100 tyre (255 mm) absorbs before 100 % wear
  var PAD_ENERGY_REF = 1.6e9;        // J of braking energy a set of iron pads absorbs
  var MAX_SUBSTEP = 0.05;
  var TIRE_HEAT_K = 0.69;            // fraction of tyre slip/hysteresis work retained as tread/carcass heat (calibrated)
  var TIRE_CAP_SURFACE = 2600;      // J/K of the tread surface layer (~1.4 kg of compound) for a 255 mm tyre
  var TIRE_CAP_CORE = 7500;         // J/K of carcass + inflation gas (~4.5 kg effective)
  var WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];

  /* Compound thermal / wear behaviour. mu/wetMu/treadwear are overridden by CB.data when present.
     window: optimal contact-patch temperature range (°C). coldLoss/hotLoss: max grip loss outside the window.
     heatGen: hysteresis (loss modulus) factor — softer compounds turn more slip work into heat. */
  var COMPOUNDS = {
    'eco':          { name: 'Eco',          mu: 0.82, wetMu: 0.75, treadwear: 700, window: [35, 75],  coldLoss: 0.06, coldSpan: 35, hotLoss: 0.14, hotSpan: 30, heatGen: 0.84 },
    'all-season':   { name: 'All-Season',   mu: 0.88, wetMu: 0.78, treadwear: 600, window: [30, 80],  coldLoss: 0.06, coldSpan: 35, hotLoss: 0.14, hotSpan: 30, heatGen: 0.80 },
    'winter':       { name: 'Winter',       mu: 0.80, wetMu: 0.82, treadwear: 400, window: [0, 45],   coldLoss: 0.03, coldSpan: 40, hotLoss: 0.24, hotSpan: 25, heatGen: 0.90 },
    'touring':      { name: 'Touring',      mu: 0.92, wetMu: 0.82, treadwear: 500, window: [40, 85],  coldLoss: 0.07, coldSpan: 35, hotLoss: 0.15, hotSpan: 30, heatGen: 0.84 },
    'performance':  { name: 'Performance',  mu: 1.02, wetMu: 0.85, treadwear: 300, window: [55, 95],  coldLoss: 0.10, coldSpan: 35, hotLoss: 0.17, hotSpan: 28, heatGen: 1.00 },
    'super-sport':  { name: 'Super Sport',  mu: 1.12, wetMu: 0.82, treadwear: 200, window: [65, 100], coldLoss: 0.14, coldSpan: 35, hotLoss: 0.18, hotSpan: 28, heatGen: 1.08 },
    'track':        { name: 'Semi-Slick',   mu: 1.28, wetMu: 0.65, treadwear: 100, window: [75, 105], coldLoss: 0.22, coldSpan: 38, hotLoss: 0.20, hotSpan: 26, heatGen: 1.25 },
    'slick':        { name: 'Slick',        mu: 1.55, wetMu: 0.25, treadwear: 40,  window: [85, 115], coldLoss: 0.32, coldSpan: 40, hotLoss: 0.22, hotSpan: 25, heatGen: 1.50 },
    // race-only pit compounds (not in the configurator catalog)
    'intermediate': { name: 'Intermediate', mu: 1.20, wetMu: 1.05, treadwear: 60,  window: [45, 85],  coldLoss: 0.16, coldSpan: 35, hotLoss: 0.30, hotSpan: 22, heatGen: 0.95, raceOnly: true },
    'wet':          { name: 'Full Wet',     mu: 1.02, wetMu: 1.22, treadwear: 50,  window: [30, 70],  coldLoss: 0.12, coldSpan: 35, hotLoss: 0.36, hotSpan: 20, heatGen: 0.92, raceOnly: true }
  };
  var COMPOUND_DEFAULT = 'performance';

  /* Fuel: brake-specific fuel consumption at the best-efficiency island (g/kWh), density (kg/L), lower heating value (MJ/kg). */
  var FUELS = {
    'regular': { bsfc: 268, density: 0.745, lhv: 43.0 },
    'premium': { bsfc: 258, density: 0.745, lhv: 43.0 },
    'e85':     { bsfc: 350, density: 0.781, lhv: 29.2 },
    'race':    { bsfc: 250, density: 0.725, lhv: 43.5 },
    'diesel':  { bsfc: 218, density: 0.832, lhv: 42.8 },
    _default:  { bsfc: 260, density: 0.745, lhv: 43.0 }
  };

  var FUEL_MAPS = {
    'lean':   { power: 0.93, fuel: 0.85, heat: 0.92, label: 'Lean (fuel save)' },
    'normal': { power: 1.00, fuel: 1.00, heat: 1.00, label: 'Normal' },
    'rich':   { power: 1.03, fuel: 1.12, heat: 1.06, label: 'Rich' },
    'push':   { power: 1.05, fuel: 1.22, heat: 1.12, label: 'Push (quali)' }
  };

  var BRAKE_MATERIALS = {
    'iron':            { fadeResistance: 0.45, weightPerRotor_kg: 11,  cp: 460,  padLife: 1.0, coldBite: 1.0 },
    'drilled-slotted': { fadeResistance: 0.60, weightPerRotor_kg: 10.5, cp: 460, padLife: 1.0, coldBite: 1.0 },
    'two-piece':       { fadeResistance: 0.75, weightPerRotor_kg: 8.5, cp: 470,  padLife: 1.2, coldBite: 1.0 },
    'carbon-ceramic':  { fadeResistance: 0.95, weightPerRotor_kg: 5,   cp: 1050, padLife: 2.2, coldBite: 0.88 },
    _default:          { fadeResistance: 0.5,  weightPerRotor_kg: 10,  cp: 470,  padLife: 1.0, coldBite: 1.0 }
  };

  var COOLING = { 'standard': 1.0, 'uprated': 1.3, 'race': 1.7 };
  var SURFACE_ABRASION = { asphalt: 1, kerb: 1.6, grass: 1.15, sand: 2.0, gravel: 2.0, wall: 1.4, pit: 0.8 };
  var REGEN_CAPTURE = [0, 0.28, 0.48, 0.64];

  /* ================================================================ helpers */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : (typeof v === 'string' && v !== '' && isFinite(+v) ? +v : d); }
  function firstNum() { for (var i = 0; i < arguments.length; i++) if (isNum(arguments[i])) return arguments[i]; return undefined; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function get(o, path, d) {
    if (!o) return d;
    var p = path.split('.');
    for (var i = 0; i < p.length; i++) { if (o == null) return d; o = o[p[i]]; }
    return o === undefined ? d : o;
  }
  function round(v, n) { var f = Math.pow(10, n || 0); return Math.round(v * f) / f; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function avg(a) { return a.length ? sum(a) / a.length : 0; }
  function max4(a) { return Math.max(a[0], a[1], a[2], a[3]); }

  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  // mulberry32 on an integer stored in the car state (keeps the state serialisable & deterministic)
  function rand(cs) {
    var t = (cs.rngState = (cs.rngState + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function catalogFind(collection, id) {
    var list = CB.data && CB.data[collection];
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /* ================================================================ compound model */
  function compoundInfo(id) {
    var base = COMPOUNDS[id] || COMPOUNDS[COMPOUND_DEFAULT];
    var cat = catalogFind('tireCompounds', id);
    var out = {};
    for (var k in base) out[k] = base[k];
    out.id = COMPOUNDS[id] ? id : (cat ? id : COMPOUND_DEFAULT);
    if (cat) {
      if (isNum(cat.mu)) out.mu = cat.mu;
      if (isNum(cat.wetMu)) out.wetMu = cat.wetMu;
      if (isNum(cat.treadwear)) out.treadwear = cat.treadwear;
      if (cat.name) out.catalogName = cat.name;
    }
    out.window = base.window.slice();
    out.mid = (out.window[0] + out.window[1]) / 2;
    return out;
  }

  /** Grip multiplier (≈0.68..1.0) of a compound at a contact-patch temperature. */
  function tempGrip(c, T) {
    if (typeof c === 'string') c = compoundInfo(c);
    var lo = c.window[0], hi = c.window[1], mid = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
    if (T >= lo && T <= hi) { var x = (T - mid) / half; return 1 - 0.02 * x * x; }
    if (T < lo) { var d = (lo - T) / c.coldSpan; return 0.98 - c.coldLoss * (1 - Math.exp(-d * d * 1.6)); }
    var e = (T - hi) / c.hotSpan; return 0.98 - c.hotLoss * (1 - Math.exp(-e * e * 1.4));
  }

  /** Grip multiplier vs tread wear: scrub-in, linear fade, then the "cliff" past 70 %. */
  function wearGrip(w) {
    w = clamp(num(w, 0), 0, 1);
    if (w < 0.03) return 0.985 + 0.5 * w;           // mould-release layer on brand-new rubber
    if (w < 0.7) return 1 - 0.07 * (w - 0.03) / 0.67;
    return 0.93 - 0.2 * Math.pow((w - 0.7) / 0.3, 1.6);
  }

  function effMu(c, wet) { return lerp(c.mu, c.wetMu, clamp(wet, 0, 1)); }

  /* ================================================================ environment */
  function environment(weather, timeOfDay, opts) {
    opts = opts || {};
    var amb = { day: 24, dusk: 18, night: 14 }[timeOfDay] ;
    if (!isNum(amb)) amb = 22;
    var sun = { day: 12, dusk: 4, night: 1 }[timeOfDay];
    if (!isNum(sun)) sun = 8;
    var wet = weather === 'wet' ? 1 : weather === 'damp' ? 0.45 : 0;
    if (wet) { amb -= wet * 5; sun *= (1 - wet * 0.9); }
    var ambient = num(opts.ambient_c, amb);
    return { ambient_c: ambient, trackTemp_c: num(opts.trackTemp_c, ambient + sun), wetness: num(opts.wetness, wet), weather: weather || 'dry', timeOfDay: timeOfDay || 'day' };
  }

  function normEnv(env, cs) {
    env = env || {};
    var base = cs.envBase || {};
    var wet = isNum(env.wetness) ? env.wetness : env.wet === true ? 1 : isNum(env.wet) ? env.wet : env.wet === false ? 0 : num(base.wetness, 0);
    if (!isNum(env.wetness) && env.weather && !isNum(env.wet) && env.wet !== true && env.wet !== false) wet = environment(env.weather, env.timeOfDay).wetness;
    var amb = firstNum(env.ambient_c, base.ambient_c, 22);
    return {
      ambient_c: amb,
      trackTemp_c: firstNum(env.trackTemp_c, base.trackTemp_c, amb + 8),
      wetness: clamp(wet, 0, 1),
      surface: env.surface || 'asphalt',
      onTrack: env.onTrack !== false,
      lap: isNum(env.lap) ? env.lap : null,
      t: isNum(env.t) ? env.t : null
    };
  }

  /* ================================================================ car state */
  function vehicleSummary(vp, build) {
    vp = vp || {};
    build = build || {};
    var eng = build.engine || {};
    var isEV = !!vp.isEV || eng.type === 'ev';
    var isHybrid = !isEV && (!!vp.isHybrid || eng.type === 'hybrid');
    var mass = firstNum(vp.mass, vp.mass_kg, get(build, 'metrics.weight_kg'), 1450);
    var powerKw = firstNum(vp.powerKw, vp.power_kw, isNum(vp.power_hp) ? vp.power_hp * 0.7457 : undefined,
      isEV ? num(eng.motors, 2) * num(eng.motorPower_kw, 200) : undefined, 280);
    var wf = clamp(firstNum(vp.weightFront, 0.52), 0.3, 0.7);
    var wb = firstNum(vp.wheelbase, num(get(build, 'body.wheelbase_mm'), 2650) / 1000);
    var track = firstNum(vp.track, num(get(build, 'body.trackWidth_mm'), 1600) / 1000);
    var cgH = firstNum(vp.cgHeight, 0.5);
    var mu = firstNum(vp.muF, vp.mu, 1.0);
    var maxLatG = firstNum(vp.maxLatG, get(vp, 'capabilities.maxLatG'), mu * 0.93);
    var maxBrakeG = firstNum(vp.maxBrakeG, get(vp, 'capabilities.maxBrakeG'), mu * 1.0);
    return {
      isEV: isEV, isHybrid: isHybrid, mass: mass, powerKw: powerKw, weightFront: wf, wheelbase: wb, track: track, cgHeight: cgH,
      maxLatG: maxLatG, maxBrakeG: maxBrakeG,
      cdA: firstNum(vp.cdA, 0.32 * 2.1), clA: firstNum(vp.clA, 0.15),
      brakeForceMax: firstNum(vp.brakeForceMax, mass * G * 1.25), brakeBias: clamp(firstNum(vp.brakeBias, 0.62), 0.4, 0.85),
      radiusF: firstNum(vp.radiusF, 0.33), radiusR: firstNum(vp.radiusR, 0.34),
      tanAlphaPeak: firstNum(vp.tanAlphaPeakF, 0.14), kappaPeak: firstNum(vp.kappaPeakF, 0.11),
      redline: firstNum(vp.redline, eng.redline_rpm, 7000), idle: firstNum(vp.idle, 850),
      layout: vp.layout || get(build, 'drivetrain.layout', 'rwd'), splitF: firstNum(vp.splitF, undefined),
      regenLevel: clamp(Math.round(firstNum(vp.regen, eng.regen, isEV || isHybrid ? 2 : 0)), 0, 3),
      rollingRes: firstNum(vp.rollingRes, vp.rollingResistance, 0.011),
      topSpeed: firstNum(vp.topSpeed_ms, get(vp, 'capabilities.topSpeed_mps'), 80),
      compound: vp.compound
    };
  }

  function createCarState(vehicleParams, build, opts) {
    opts = opts || {};
    build = build || {};
    var vs = vehicleSummary(vehicleParams, build);
    var eng = build.engine || {};
    var tires = build.tires || {};
    var brakesB = build.brakes || {};
    var envB = environment(opts.weather, opts.timeOfDay, opts);
    if (opts.env) { var ne = normEnv(opts.env, { envBase: envB }); envB.ambient_c = ne.ambient_c; envB.trackTemp_c = ne.trackTemp_c; envB.wetness = ne.wetness; }

    var compoundId = opts.compound || tires.compound || vs.compound || COMPOUND_DEFAULT;
    var comp = compoundInfo(compoundId);
    var baseComp = compoundInfo(vs.compound || tires.compound || compoundId).id;
    var wF = clamp(num(tires.widthFront_mm, 245) / 255, 0.6, 1.5), wR = clamp(num(tires.widthRear_mm, 265) / 255, 0.6, 1.5);

    // fuel / energy
    var fuelType = eng.fuel || 'premium';
    var fuel = FUELS[fuelType] || FUELS._default;
    var tank = vs.isEV ? 0 : clamp(num(opts.tank_l, 60), 1, 200);
    var fuelL = vs.isEV ? 0 : clamp(num(opts.fuel_l, tank), 0, tank);
    var refFuel = vs.isEV ? 0 : clamp(num(opts.refFuel_l, tank), 0, tank);
    var battery = null;
    if (vs.isEV || vs.isHybrid) {
      var cap = num(opts.battery_kwh, num(eng.battery_kwh, vs.isEV ? 80 : 1.6));
      var chem = catalogFind('batteryChemistries', eng.chemistry) || {};
      var whPerKg = num(chem.whPerKg, 230);
      var soc = clamp(num(opts.soc, vs.isHybrid ? 0.6 : 1), 0, 1);
      battery = {
        capacity_kwh: cap, energy_kwh: cap * soc, soc: soc, temp_c: envB.ambient_c + 8,
        cRate: num(chem.cRate, 3), thermalMass_jk: Math.max(40, cap * 1000 / whPerKg) * 1000,
        used_kwh: 0, regen_kwh: 0, deployKw: vs.isHybrid ? Math.min(vs.powerKw * 0.3, num(eng.motorPower_kw, 60) * num(eng.motors, 1)) : 0
      };
    }

    // brakes
    var bmId = brakesB.material || 'iron';
    var bm = {}; var bmBase = BRAKE_MATERIALS[bmId] || BRAKE_MATERIALS._default; for (var k in bmBase) bm[k] = bmBase[k];
    var bmCat = catalogFind('brakeMaterials', bmId);
    if (bmCat) { if (isNum(bmCat.fadeResistance)) bm.fadeResistance = bmCat.fadeResistance; if (isNum(bmCat.weightPerRotor_kg)) bm.weightPerRotor_kg = bmCat.weightPerRotor_kg; }
    var rotF = clamp(num(brakesB.frontRotor_mm, 350), 240, 460), rotR = clamp(num(brakesB.rearRotor_mm, 320), 240, 460);
    var coolingId = eng.cooling || 'standard';
    var coolCat = catalogFind('coolings', coolingId);
    var coolGrade = coolCat && isNum(coolCat.heatCapacity) ? coolCat.heatCapacity : (COOLING[coolingId] || 1);
    var tune = catalogFind('tunes', eng.tune || 'stock') || {};
    var tuneEff = num(tune.efficiencyMult, { eco: 1.08, stage1: 0.98, stage2: 0.95, stage3: 0.9, 'time-attack': 0.85 }[eng.tune] || 1);
    var tuneRel = num(tune.reliabilityHit, { stage2: 0.12, stage3: 0.25, 'time-attack': 0.45 }[eng.tune] || 0);

    var blanket = !!opts.tireBlankets;
    var startT = blanket ? num(opts.blanketTemp_c, Math.min(90, comp.window[0] + 2)) : num(opts.tireTemp_c, envB.ambient_c + (envB.trackTemp_c - envB.ambient_c) * 0.4);
    var coldP = num(opts.coldPressure_kpa, comp.id === 'slick' || comp.id === 'track' ? 165 : 210);
    var setT = blanket ? startT : envB.ambient_c;

    var features = { tires: true, fuel: true, damage: true, brakes: true, thermal: true };
    if (opts.features) for (var f in opts.features) if (f in features) features[f] = opts.features[f] !== false;

    var cs = {
      version: 1, kind: 'forge-endurance',
      isEV: vs.isEV, isHybrid: vs.isHybrid,
      // baseCompound = the compound the vehicle params were derived from (grip multipliers are relative to it)
      compound: comp.id, baseCompound: baseComp,
      tireWear: [0, 0, 0, 0],
      tireTemp_c: [startT, startT, startT, startT],
      tireCore_c: [startT, startT, startT, startT],
      tirePressure_kpa: [coldP, coldP, coldP, coldP],
      tireGrip: [1, 1, 1, 1],
      punctured: [false, false, false, false],
      tireAge_laps: [0, 0, 0, 0], tireDistance_km: 0,
      fuel_l: fuelL, tankCapacity_l: tank, fuelType: fuelType, fuelUsed_l: 0, fuelMap: FUEL_MAPS[opts.fuelMap] ? opts.fuelMap : 'normal',
      battery: battery,
      damage: { front: 0, rear: 0, left: 0, right: 0, engine: 0, aero: 0 },
      suspension: [0, 0, 0, 0],
      brakeTemp_c: envB.ambient_c + 15, brakeTemps_c: [envB.ambient_c + 15, envB.ambient_c + 15], brakeWear: 0, brakeFade: 0, brakeMult: 1,
      engineTemp_c: vs.isEV ? envB.ambient_c + 15 : 85, engineFailed: false,
      mass_kg: vs.mass, massRef_kg: vs.mass,
      envBase: { ambient_c: envB.ambient_c, trackTemp_c: envB.trackTemp_c, wetness: envB.wetness },
      cfg: {
        mass: vs.mass, powerKw: vs.powerKw, weightFront: vs.weightFront, wheelbase: vs.wheelbase, track: vs.track, cgHeight: vs.cgHeight,
        maxLatG: vs.maxLatG, maxBrakeG: vs.maxBrakeG, cdA: vs.cdA, clA: vs.clA, brakeForceMax: vs.brakeForceMax, brakeBias: vs.brakeBias,
        radius: [vs.radiusF, vs.radiusF, vs.radiusR, vs.radiusR], tanAlphaPeak: vs.tanAlphaPeak, kappaPeak: vs.kappaPeak,
        redline: vs.redline, idle: vs.idle, layout: vs.layout === 'fwd' || vs.layout === 'awd' ? vs.layout : 'rwd',
        splitF: isNum(vs.splitF) ? vs.splitF : (vs.layout === 'fwd' ? 1 : vs.layout === 'awd' ? 0.4 : 0),
        regenLevel: vs.regenLevel, rollingRes: vs.rollingRes, topSpeed: vs.topSpeed,
        widthScale: [wF, wF, wR, wR], coldPressure_kpa: coldP, pressureSetTemp_c: setT,
        fuelDensity: fuel.density, bsfc: fuel.bsfc / tuneEff, lhv: fuel.lhv, refFuel_l: refFuel,
        displacement_l: num(eng.displacement_l, 3), tuneReliability: tuneRel,
        coolGrade: coolGrade, engineMount: eng.position || (get(build, 'body.style') === 'hypercar' ? 'mid' : 'front'),
        brake: {
          material: bmId, fadeResistance: bm.fadeResistance, cp: bm.cp, padLife: bm.padLife, coldBite: bm.coldBite,
          fadeOnset_c: 330 + 500 * bm.fadeResistance,
          capF: 2 * bm.weightPerRotor_kg * Math.pow(rotF / 360, 2) * 1.3 * bm.cp,
          capR: 2 * bm.weightPerRotor_kg * Math.pow(rotR / 360, 2) * 1.3 * bm.cp,
          areaF: 0.12 * Math.pow(rotF / 360, 2), areaR: 0.12 * Math.pow(rotR / 360, 2),
          duct: coolingId === 'race' ? 1.3 : coolingId === 'uprated' ? 1.12 : 1
        },
        crewQuality: clamp(num(opts.crewQuality, 0.5), 0, 1),
        wearMult: num(opts.wearMult, 1), fuelMult: num(opts.fuelMult, 1), damageMult: num(opts.damageMult, 1), thermalMult: num(opts.thermalMult, 1),
        tireBlankets: blanket, blanketTemp_c: num(opts.blanketTemp_c, 0) || null
      },
      features: features,
      stats: { time_s: 0, distance_km: 0, slipEnergy_MJ: 0, brakeEnergy_MJ: 0, maxTireTemp_c: startT, maxBrakeTemp_c: envB.ambient_c + 15,
               maxEngineTemp_c: 85, impacts: 0, heavyImpacts: 0, pitStops: 0, punctures: 0, fuelUsed_l: 0, energyUsed_kwh: 0, regen_kwh: 0 },
      laps: { current: 0, mark: null, history: [] },
      pits: [],
      flags: {},
      events: [],
      last: { speed: 0, powerKw: 0, fuelFlow_lph: 0, batteryKw: 0, brakeKw: 0, slipKw: [0, 0, 0, 0], wetness: envB.wetness, surface: 'asphalt' },
      rngState: (num(opts.seed, hashSeed(get(build, 'meta.id', '') + '|' + compoundId + '|' + vs.mass)) >>> 0) || 1
    };
    updateMass(cs);
    computeGrip(cs);
    return cs;
  }

  /* ================================================================ events */
  function emit(cs, type, text, extra) {
    var e = { type: type, text: text, t: round(cs.stats.time_s, 2) };
    if (extra) for (var k in extra) e[k] = extra[k];
    cs.events.push(e);
    if (cs.events.length > 64) cs.events.shift();
    return e;
  }
  function latch(cs, key, cond, reset, fn) {
    if (cond && !cs.flags[key]) { cs.flags[key] = true; fn(); }
    else if (reset && cs.flags[key]) cs.flags[key] = false;
  }
  function drainEvents(cs) { if (!cs) return []; var e = cs.events; cs.events = []; return e; }

  /* ================================================================ wheel forces (slip power) */
  var WD = { fx: [0, 0, 0, 0], fy: [0, 0, 0, 0], load: [0, 0, 0, 0], vsx: [0, 0, 0, 0], vsy: [0, 0, 0, 0] };

  function wheelData(cs, vs, input, v) {
    var c = cs.cfg, i;
    var wheels = vs && vs.wheels;
    var vxB = Math.abs(num(vs.vx, v));
    if (Array.isArray(wheels) && wheels.length === 4 && isNum(wheels[0].load)) {
      for (i = 0; i < 4; i++) {
        var w = wheels[i];
        WD.load[i] = Math.max(0, w.load);
        WD.fx[i] = Math.abs(num(w.fx, 0));
        WD.fy[i] = Math.abs(num(w.fy, 0));
        // prefer the wheel-frame contact velocity (includes yaw & steer) exported by CB.race.vehicle
        var wvx = isNum(w._wvx) ? w._wvx : vxB;
        var Rw = isNum(w._R) ? w._R : c.radius[i];
        if (isNum(w.omega)) WD.vsx[i] = Math.abs(w.omega * Rw - wvx);
        else WD.vsx[i] = Math.abs(num(w.kappa, 0)) * Math.max(vxB, 1);
        var al = isNum(w.alpha) ? w.alpha : (i < 2 ? num(vs.slipAngleF, 0) : num(vs.slipAngleR, 0));
        WD.vsy[i] = Math.abs(Math.tan(clamp(al, -1.4, 1.4))) * Math.max(vxB, 0.5);
      }
      return WD;
    }
    // ---- fallback: reconstruct forces from accelerations (synthetic laps, foreign vehicle models)
    var m = cs.mass_kg;
    var ax = firstNum(vs.ax, isNum(vs.gLong) ? vs.gLong * G : undefined, 0);
    var ay = firstNum(vs.ay, isNum(vs.gLat) ? vs.gLat * G : undefined, isNum(vs.yawRate) ? vs.yawRate * v : 0);
    var mg = m * G, df = 0.5 * RHO * c.clA * v * v;
    var sF = (mg * c.weightFront + df * 0.45) / 2, sR = (mg * (1 - c.weightFront) + df * 0.55) / 2;
    var dLong = m * ax * c.cgHeight / c.wheelbase / 2;
    var dLat = m * ay * c.cgHeight / c.track / 2;
    // ay > 0 = accelerating to the left -> load moves to the right wheels (FR, RR)
    WD.load[0] = Math.max(0, sF - dLong - dLat * 0.55); WD.load[1] = Math.max(0, sF - dLong + dLat * 0.55);
    WD.load[2] = Math.max(0, sR + dLong - dLat * 0.45); WD.load[3] = Math.max(0, sR + dLong + dLat * 0.45);
    var Lsum = WD.load[0] + WD.load[1] + WD.load[2] + WD.load[3] || 1;
    var Fy = m * Math.abs(ay);
    var brakeF = ax < 0 ? m * -ax : 0, driveF = ax > 0 ? m * ax + 0.5 * RHO * c.cdA * v * v : 0;
    var latCap = c.maxLatG * G;
    var alphaF = isNum(vs.slipAngleF) ? vs.slipAngleF : Math.atan(c.tanAlphaPeak * 0.85 * Math.min(1.3, Math.abs(ay) / latCap));
    var alphaR = isNum(vs.slipAngleR) ? vs.slipAngleR : alphaF * 0.9;
    var spin = clamp(num(vs.wheelspin, 0), 0, 1), skid = clamp(num(vs.skidding, 0), 0, 1);
    for (i = 0; i < 4; i++) {
      var front = i < 2;
      WD.fy[i] = Fy * WD.load[i] / Lsum;
      var axleLoad = front ? WD.load[0] + WD.load[1] : WD.load[2] + WD.load[3];
      var share = axleLoad > 0 ? WD.load[i] / axleLoad : 0.5;
      var fb = brakeF * (front ? c.brakeBias : 1 - c.brakeBias) * share;
      var drivenShare = front ? c.splitF : 1 - c.splitF;
      var fd = driveF * drivenShare * share;
      WD.fx[i] = fb + fd;
      var muFz = Math.max(200, WD.load[i] * c.maxLatG);
      var kap = c.kappaPeak * 0.6 * Math.min(1.5, WD.fx[i] / muFz);
      WD.vsx[i] = Math.max(kap * v, drivenShare > 0 ? spin * 6 * drivenShare : 0, fb > 0 ? skid * v * 0.3 : 0);
      WD.vsy[i] = Math.abs(Math.tan(front ? alphaF : alphaR)) * Math.max(v, 0.5);
    }
    return WD;
  }

  /* ================================================================ step */
  function step(cs, vs, input, dt, env) {
    if (!cs || cs.kind !== 'forge-endurance') return cs;
    dt = num(dt, 1 / 120);
    if (!(dt > 0)) return cs;
    dt = Math.min(dt, 5);
    vs = vs || {};
    input = input || {};
    var e = normEnv(env, cs);
    var n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    var h = dt / n;
    for (var k = 0; k < n; k++) stepOnce(cs, vs, input, h, e);
    trackLaps(cs, e);
    checkWarnings(cs);
    return cs;
  }

  function stepOnce(cs, vs, input, dt, e) {
    var c = cs.cfg;
    var v = Math.abs(firstNum(vs.speed, isNum(vs.vx) ? Math.hypot(vs.vx, num(vs.vy, 0)) : undefined, 0));
    var throttle = clamp(firstNum(vs.throttle, input.throttle, 0) * (isNum(vs.tcFactor) ? clamp(vs.tcFactor, 0, 1) : 1), 0, 1);
    var brake = clamp(firstNum(input.brake, vs.brake, 0), 0, 1);
    if (vs.reversing || num(vs.gear, 1) < 0) { var tmp = throttle; throttle = brake; brake = tmp; }
    var rpm = firstNum(vs.engineRpm, vs.rpm, c.idle + (c.redline - c.idle) * clamp(v / Math.max(20, c.topSpeed), 0, 1));
    cs.stats.time_s += dt;
    cs.stats.distance_km += v * dt / 1000;
    cs.tireDistance_km += v * dt / 1000;
    cs.last.speed = v; cs.last.wetness = e.wetness; cs.last.surface = e.surface;

    var mods = modifiers(cs);

    /* ---------------- powertrain: power, fuel, battery, regen ---------------- */
    var map = FUEL_MAPS[cs.fuelMap] || FUEL_MAPS.normal;
    var x = clamp(rpm / c.redline, 0, 1.05);
    var shape;
    if (cs.isEV) shape = clamp(v / 22, 0.15, 1);
    else { var f = clamp(x / 0.88, 0.05, 1); shape = f * (2 - f) * (x > 0.96 ? 1 - 2 * (x - 0.96) : 1); }
    var pMech = throttle * c.powerKw * shape * mods.powerMult / Math.max(0.5, mods.massRatio); // kW at the crank (mass effect is not real power)
    if (vs.fuelCut || vs.limiter) pMech *= 0.15;
    if (vs.shifting) pMech *= 0.5;
    cs.last.powerKw = pMech;

    var brakeForce = brake * Math.min(c.brakeForceMax, cs.mass_kg * G * c.maxBrakeG * 1.05) * clamp(cs.brakeMult, 0.3, 1.1);
    var brakePowerKw = brakeForce * v / 1000;
    var regenKw = 0;
    if (cs.battery && cs.features.fuel) {
      var bat = cs.battery;
      var capKw = Math.min(c.powerKw * 0.6, bat.cRate * bat.capacity_kwh * (cs.isEV ? 1 : 4));
      if (bat.soc < 0.98) {
        regenKw = Math.min(capKw, brakePowerKw * REGEN_CAPTURE[c.regenLevel]);
        if (throttle < 0.05 && brake < 0.05 && v > 4) regenKw += c.regenLevel * 0.05 * c.powerKw * smoothstep(3, 15, v) * 0.5;
        regenKw *= smoothstep(1.5, 6, v);
      }
      var drawKw;
      if (cs.isEV) drawKw = pMech / 0.9 + 1.4 + (bat.temp_c > 40 ? 1.2 : 0);
      else drawKw = (throttle > 0.6 && bat.soc > 0.15) ? Math.min(bat.deployKw, pMech * 0.35) / 0.9 : 0;
      var netKw = drawKw - regenKw * 0.88;
      bat.energy_kwh = clamp(bat.energy_kwh - netKw * dt / 3600, 0, bat.capacity_kwh);
      bat.soc = bat.capacity_kwh > 0 ? bat.energy_kwh / bat.capacity_kwh : 0;
      if (netKw > 0) { bat.used_kwh += netKw * dt / 3600; cs.stats.energyUsed_kwh += netKw * dt / 3600; }
      else { bat.regen_kwh += -netKw * dt / 3600; cs.stats.regen_kwh += -netKw * dt / 3600; }
      // battery thermals: I²R losses ~ 4 % of throughput, liquid cooled to 30 °C
      var lossW = Math.abs(drawKw + regenKw) * 1000 * 0.04;
      var coolW = 350 * (bat.temp_c - Math.max(e.ambient_c, 28)) * (cs.isEV ? 1 : 0.3);
      if (cs.features.thermal) bat.temp_c += (lossW - coolW) * dt / bat.thermalMass_jk * c.thermalMult;
      cs.last.batteryKw = netKw;
      if (!cs.isEV) pMech = Math.max(0, pMech - (drawKw * 0.9)); // electric assist displaces combustion power
    }
    // brake heat is what the regen did not capture
    var frictionBrakeKw = Math.max(0, brakePowerKw - regenKw);
    cs.last.brakeKw = frictionBrakeKw;

    var fuelChemKw = 0;
    if (!cs.isEV && cs.features.fuel) {
      var flowGs;
      if (cs.engineFailed) flowGs = 0;
      else if (throttle < 0.03) flowGs = (rpm > c.idle + 400 && v > 3) ? 0 : 0.08 * c.displacement_l; // overrun fuel cut / idle
      else {
        var load = clamp(pMech / Math.max(1, c.powerKw * shape), 0, 1);
        var bsfc = c.bsfc * (1 + 0.35 * (1 - load) * (1 - load) + 0.12 * x * x) * map.fuel;
        flowGs = pMech * bsfc / 3600 + 0.04 * c.displacement_l;
      }
      fuelChemKw = flowGs * c.lhv; // g/s * MJ/kg = kW — heat follows the real combustion, not the race's consumption-rule multiplier
      flowGs *= c.fuelMult;
      var litres = flowGs * dt / 1000 / c.fuelDensity;
      if (litres > cs.fuel_l) litres = cs.fuel_l;
      cs.fuel_l -= litres;
      cs.fuelUsed_l += litres;
      cs.stats.fuelUsed_l += litres;
      cs.last.fuelFlow_lph = flowGs * 3.6 / c.fuelDensity;
    }

    /* ---------------- engine / motor coolant temperature ---------------- */
    if (cs.features.thermal) {
      var heatKw = cs.isEV ? pMech * 0.07 + regenKw * 0.05 : fuelChemKw * 0.27 * map.heat;
      heatKw *= 1 + cs.damage.engine * 0.6;
      var radiator = Math.max(0.12, 1 - 0.85 * Math.pow(cs.damage.front, 1.3));
      var ua = c.coolGrade * Math.max(80, c.powerKw) * (1.6 + 0.11 * v) * radiator;  // W/K
      ua = Math.max(ua, c.coolGrade * Math.max(80, c.powerKw) * 1.8 * radiator);       // electric fan
      var Tt = cs.isEV ? 45 : 90;
      var thermostat = 0.06 + 0.94 * smoothstep(Tt - 12, Tt, cs.engineTemp_c);
      var Q = heatKw * 1000 - ua * thermostat * (cs.engineTemp_c - e.ambient_c);
      cs.engineTemp_c += Q * dt / (cs.isEV ? 6e4 : 1.4e5) * c.thermalMult;
      cs.engineTemp_c = clamp(cs.engineTemp_c, e.ambient_c - 5, 160);
      if (cs.engineTemp_c > cs.stats.maxEngineTemp_c) cs.stats.maxEngineTemp_c = cs.engineTemp_c;
      var critical = cs.isEV ? 85 : 118;
      if (cs.engineTemp_c > critical && cs.features.damage) {
        cs.damage.engine = clamp(cs.damage.engine + dt * (cs.engineTemp_c - critical) / 2400 * (1 + c.tuneReliability), 0, 1);
      }
    }
    if (!cs.engineFailed && cs.damage.engine >= 0.98) {
      cs.engineFailed = true;
      emit(cs, 'engine-failure', cs.isEV ? 'Drive unit failure' : 'Engine failure', { value: cs.damage.engine });
    }

    /* ---------------- brakes ---------------- */
    if (cs.features.brakes) {
      var B = c.brake;
      var pF = frictionBrakeKw * 1000 * c.brakeBias, pR = frictionBrakeKw * 1000 * (1 - c.brakeBias);
      cs.stats.brakeEnergy_MJ += frictionBrakeKw * dt / 1000;
      var Tb = cs.brakeTemps_c;
      for (var a = 0; a < 2; a++) {
        var Tk = Tb[a] + KELVIN, Ta = e.ambient_c + KELVIN;
        var hConv = 2 * (6 + 1.9 * v) * B.duct * (1 + e.wetness * 0.5);
        var area = a === 0 ? B.areaF : B.areaR;
        var rad = 2 * 0.62 * SIGMA * area * (Tk * Tk * Tk * Tk - Ta * Ta * Ta * Ta);
        var cond = 2 * 0.9 * (Tb[a] - avg(a === 0 ? [cs.tireCore_c[0], cs.tireCore_c[1]] : [cs.tireCore_c[2], cs.tireCore_c[3]]));
        var qb = (a === 0 ? pF : pR) - hConv * (Tb[a] - e.ambient_c) - rad - cond;
        Tb[a] = clamp(Tb[a] + qb * dt / (a === 0 ? B.capF : B.capR) * c.thermalMult, e.ambient_c - 5, 1300);
        // conduction through the hub warms the tyre carcass
        if (cs.features.tires) {
          var j = a * 2, capC = TIRE_CAP_CORE;
          cs.tireCore_c[j] += cond / 2 * dt / (capC * c.widthScale[j]);
          cs.tireCore_c[j + 1] += cond / 2 * dt / (capC * c.widthScale[j + 1]);
        }
      }
      cs.brakeTemp_c = Math.max(Tb[0], Tb[1]);
      if (cs.brakeTemp_c > cs.stats.maxBrakeTemp_c) cs.stats.maxBrakeTemp_c = cs.brakeTemp_c;
      // pad wear
      var over = Math.max(0, cs.brakeTemp_c - B.fadeOnset_c);
      cs.brakeWear = clamp(cs.brakeWear + frictionBrakeKw * 1000 * dt / (PAD_ENERGY_REF * B.padLife) * (1 + over * over / 22500) * c.wearMult, 0, 1);
      // fade (hot), cold bite (carbon), worn pads
      var fade = 0.55 * smoothstep(B.fadeOnset_c, B.fadeOnset_c + 220, cs.brakeTemp_c);
      var cold = B.coldBite < 1 ? (1 - B.coldBite) * (1 - smoothstep(60, 220, cs.brakeTemp_c)) : 0;
      var padLoss = cs.brakeWear > 0.85 ? (cs.brakeWear - 0.85) / 0.15 * 0.35 : 0;
      cs.brakeFade = clamp(fade + cold + padLoss, 0, 0.85);
      cs.brakeMult = 1 - cs.brakeFade;
    }

    /* ---------------- tyres: thermal + wear ---------------- */
    if (cs.features.tires) {
      var wd = wheelData(cs, vs, input, v);
      var comp = compoundInfo(cs.compound);
      var abr = SURFACE_ABRASION[e.surface] || 1;
      var staticLoad = cs.mass_kg * G / 4;
      for (var i = 0; i < 4; i++) {
        var Ws = c.widthScale[i];
        var wear = cs.tireWear[i];
        var Ts = cs.tireTemp_c[i], Tc = cs.tireCore_c[i];
        var pSlip = Math.min(4e5, wd.fx[i] * wd.vsx[i] + wd.fy[i] * wd.vsy[i]);
        if (!(pSlip >= 0)) pSlip = 0;
        cs.last.slipKw[i] = pSlip / 1000;
        cs.stats.slipEnergy_MJ += pSlip * dt / 1e6;
        if (cs.punctured[i]) {
          // running on the rim: tread irrelevant, carcass shredding; suspension gets battered
          cs.tireTemp_c[i] = lerp(Ts, e.ambient_c + 10, Math.min(1, dt * 0.2));
          cs.tireCore_c[i] = lerp(Tc, e.ambient_c + 10, Math.min(1, dt * 0.2));
          if (cs.features.damage) cs.suspension[i] = clamp(cs.suspension[i] + v * dt / 1000 * 0.03 * c.damageMult, 0, 1);
          cs.tirePressure_kpa[i] = 20;
          continue;
        }
        var Cs = TIRE_CAP_SURFACE * Ws * (1 - 0.55 * wear), Cc = TIRE_CAP_CORE * Ws;
        var popt = optimalPressure(cs, comp);
        var pres = cs.tirePressure_kpa[i];
        var underInfl = Math.max(0, (popt - pres) / popt);
        var hyst = c.rollingRes * wd.load[i] * v * 0.9 * comp.heatGen * (1 + 1.5 * underInfl);
        var qS = (pSlip * 0.5 * comp.heatGen + hyst * 0.3) * TIRE_HEAT_K;
        var qC = hyst * 0.7 * TIRE_HEAT_K;
        var contact = 0.3 + 0.7 * clamp(wd.load[i] / Math.max(1, staticLoad), 0, 2) * (v > 0.5 ? 1 : 0.4);
        var cAir = (6 + 2.2 * Math.pow(v, 0.8)) * Ws * (Ts - e.ambient_c);
        var cTrack = 14 * Ws * contact * (Ts - e.trackTemp_c);
        var cWet = e.wetness * (55 + 7 * v) * Ws * (Ts - (e.ambient_c - 3));
        var kSC = 60 * Ws * (Ts - Tc);
        var cCore = (2.5 + 0.7 * Math.pow(v, 0.8)) * Ws * (Tc - e.ambient_c);
        var tm = c.thermalMult;
        Ts += (qS - cAir - cTrack - cWet - kSC) * dt / Cs * tm;
        Tc += (qC + kSC - cCore) * dt / Cc * tm;
        cs.tireTemp_c[i] = Ts = clamp(Ts, e.ambient_c - 30, 260);
        cs.tireCore_c[i] = Tc = clamp(Tc, e.ambient_c - 30, 220);
        if (Ts > cs.stats.maxTireTemp_c) cs.stats.maxTireTemp_c = Ts;
        cs.tirePressure_kpa[i] = c.coldPressure_kpa * (Tc + KELVIN) / (c.pressureSetTemp_c + KELVIN);
        // wear: slip energy / tread energy capacity, accelerated by overheating (blistering) and cold graining
        var Tcp = 0.7 * Ts + 0.3 * Tc;
        var hi = comp.window[1], lo = comp.window[0];
        var tw = 1;
        if (Tcp > hi) { var d1 = (Tcp - hi) / 18; tw += d1 * d1; }
        else if (Tcp < lo - 10) tw += 0.3 * smoothstep(0, 25, lo - 10 - Tcp);
        var capJ = WEAR_ENERGY_REF * Math.pow(comp.treadwear / 100, 0.5) * Ws;
        var dWear = pSlip * dt / capJ * tw * abr * (1 - 0.35 * e.wetness);
        dWear += v * dt * (wd.load[i] / 4000) / (comp.treadwear * 4.0e5);   // pure rolling abrasion
        // a slick on a wet track or a wet tyre on a dry one destroys itself quickly
        if (comp.id === 'wet' || comp.id === 'intermediate') dWear *= 1 + (1 - e.wetness) * (comp.id === 'wet' ? 2.5 : 1.2);
        wear = Math.min(1, wear + dWear * c.wearMult);
        cs.tireWear[i] = wear;
        if (wear >= 1) puncture(cs, i, 'worn');
        else if (wear > 0.85 && (e.surface !== 'asphalt' || !e.onTrack) && rand(cs) < 0.03 * (wear - 0.85) / 0.15 * dt) puncture(cs, i, 'debris');
      }
    }

    updateMass(cs);
    computeGrip(cs);
  }

  function optimalPressure(cs, comp) {
    return cs.cfg.coldPressure_kpa * (comp.mid + KELVIN) / (cs.cfg.pressureSetTemp_c + KELVIN) * 0.97;
  }

  function puncture(cs, i, cause) {
    if (cs.punctured[i]) return;
    cs.punctured[i] = true;
    cs.tireWear[i] = Math.max(cs.tireWear[i], cause === 'worn' ? 1 : cs.tireWear[i]);
    cs.tirePressure_kpa[i] = 20;
    cs.stats.punctures++;
    emit(cs, 'puncture', 'Puncture ' + WHEEL_NAMES[i] + (cause === 'worn' ? ' (tyre worn through)' : cause === 'impact' ? ' (contact)' : ' (debris)'), { wheel: i, cause: cause });
  }

  function updateMass(cs) {
    var c = cs.cfg;
    if (cs.isEV) { cs.mass_kg = cs.massRef_kg; return; }
    cs.mass_kg = Math.max(300, cs.massRef_kg - (c.refFuel_l - cs.fuel_l) * c.fuelDensity);
  }

  function computeGrip(cs) {
    var comp = compoundInfo(cs.compound), base = compoundInfo(cs.baseCompound);
    var wet = num(cs.last && cs.last.wetness, 0);
    var ratio = effMu(comp, wet) / Math.max(0.1, effMu(base, wet));
    var popt = optimalPressure(cs, comp);
    for (var i = 0; i < 4; i++) {
      if (!cs.features.tires) { cs.tireGrip[i] = 1; continue; }
      if (cs.punctured[i]) { cs.tireGrip[i] = 0.38 * ratio; continue; }
      var Tcp = 0.7 * cs.tireTemp_c[i] + 0.3 * cs.tireCore_c[i];
      var dp = cs.tirePressure_kpa[i] - popt;
      var pg = clamp(1 - 0.00004 * dp * dp, 0.9, 1);
      // on a wet surface grip is dominated by water evacuation (tread pattern) rather than rubber hysteresis,
      // so the thermal window matters less: blend the temperature factor toward neutral with wetness
      var tg = lerp(tempGrip(comp, Tcp), 1, 0.45 * clamp(wet, 0, 1));
      cs.tireGrip[i] = ratio * tg * wearGrip(cs.tireWear[i]) * pg;
    }
  }

  /* ================================================================ modifiers */
  function modifiers(cs) {
    var neutral = { gripMult: [1, 1], powerMult: 1, dragMult: 1, downforceMult: 1, steerPull: 0, brakeMult: 1, wheelGrip: [1, 1, 1, 1], rollingMult: 1, massRatio: 1, mass_kg: 0, engineAlive: true,
                    raw: { powerMult: 1, brakeMult: 1, wheelGrip: [1, 1, 1, 1] } };
    if (!cs || cs.kind !== 'forge-endurance') return neutral;
    var d = cs.damage, s = cs.suspension, c = cs.cfg;
    var massRatio = cs.massRef_kg / Math.max(1, cs.mass_kg);
    var wg = [0, 0, 0, 0], wgRaw = [0, 0, 0, 0];
    for (var i = 0; i < 4; i++) {
      var g = cs.tireGrip[i];
      if (cs.features.damage) {
        g *= 1 - 0.25 * s[i];
        g *= i < 2 ? 1 - 0.06 * d.front : 1 - 0.05 * d.rear;
        g *= (i % 2 === 0) ? 1 - 0.05 * d.left : 1 - 0.05 * d.right;
      }
      wgRaw[i] = clamp(g, 0.05, 6);
      wg[i] = clamp(g * Math.pow(massRatio, 0.08), 0.05, 6); // wide: wets on a slick-derived car need ~5x
    }
    // power
    var power = 1;
    if (cs.features.damage || cs.features.thermal) {
      power *= 1 - 0.55 * Math.pow(d.engine, 1.3);
      if (cs.features.thermal) power *= 1 - 0.3 * smoothstep(cs.isEV ? 70 : 112, cs.isEV ? 90 : 125, cs.engineTemp_c);
    }
    if (cs.engineFailed) power = 0;
    if (cs.features.fuel) {
      if (!cs.isEV) {
        if (cs.fuel_l <= 0) power = 0;
        else if (cs.fuel_l < 0.6) {
          var t = cs.stats.time_s;
          var sputter = 0.5 + 0.5 * Math.sin(t * 23) * Math.sin(t * 7.1);
          power *= lerp(0.15, 1, (cs.fuel_l / 0.6) * 0.5 + 0.5 * sputter);
        }
      }
      if (cs.battery) {
        var b = cs.battery;
        if (cs.isEV) {
          if (b.soc <= 0) power *= 0.04;
          else if (b.soc < 0.1) power *= lerp(0.3, 1, b.soc / 0.1);
          power *= 1 - 0.5 * smoothstep(50, 65, b.temp_c);
        }
      }
      power *= (FUEL_MAPS[cs.fuelMap] || FUEL_MAPS.normal).power;
    }
    var punct = 0; for (var p = 0; p < 4; p++) if (cs.punctured[p]) punct++;
    var dmg = cs.features.damage;
    var drag = 1 + (dmg ? 0.12 * d.aero + 0.05 * d.front + 0.035 * d.rear + 0.015 * (d.left + d.right) : 0) + 0.03 * punct;
    var downforce = dmg ? clamp(1 - 0.6 * Math.pow(d.aero, 0.9) - 0.08 * d.front, 0.2, 1) : 1;
    // steering pull (+ = left). Damaged/bent corners and deflated tyres drag the car toward that side.
    var pull = 0;
    if (dmg) pull += 0.07 * (d.left - d.right) + 0.05 * ((s[0] + s[2] * 0.4) - (s[1] + s[3] * 0.4));
    pull += 0.06 * ((cs.punctured[0] ? 1 : 0) + (cs.punctured[2] ? 0.5 : 0) - (cs.punctured[1] ? 1 : 0) - (cs.punctured[3] ? 0.5 : 0));
    pull += 0.03 * (cs.tireWear[0] - cs.tireWear[1]) * (cs.features.tires ? 1 : 0);
    pull = clamp(pull, -0.22, 0.22);
    return {
      gripMult: [(wg[0] + wg[1]) / 2, (wg[2] + wg[3]) / 2],
      powerMult: clamp(power * massRatio, 0, 1.4),
      dragMult: drag,
      downforceMult: downforce,
      steerPull: pull,
      brakeMult: clamp((cs.features.brakes ? cs.brakeMult : 1) * massRatio, 0.1, 1.3),
      wheelGrip: wg,
      rollingMult: 1 + 0.6 * punct,
      massRatio: massRatio,
      mass_kg: cs.mass_kg,
      engineAlive: !cs.engineFailed && power > 0,
      // the same effects WITHOUT the fuel-mass equivalence folded in — for integrators that instead feed the real
      // (fuel-burning) mass into the vehicle model (see applyToParams)
      raw: { powerMult: clamp(power, 0, 1.4), brakeMult: clamp(cs.features.brakes ? cs.brakeMult : 1, 0.1, 1.3), wheelGrip: wgRaw }
    };
  }

  /* ================================================================ vehicle-model adapters */
  // CB.race.vehicle surface rolling-resistance multipliers (env.rollingMult REPLACES the surface value there)
  var VEHICLE_SURFACE_RR = { asphalt: 1, kerb: 1.4, grass: 4.5, sand: 14, gravel: 9, wall: 1.5, pit: 1 };

  /**
   * applyToParams(params, mods, opts?) -> derived (unfrozen, shallow-copied) CB.race.vehicle params with the
   * endurance effects baked in: real fuel-burn mass, torque table x power, cdA x drag, clA x downforce,
   * brake torques x brake efficiency. opts.massMode 'mass' (default: real mass, raw multipliers) |
   * 'equivalent' (keep params.mass, use the mass-equivalent multipliers). Returns params unchanged for neutral mods.
   * opts.cache {} -> memoised per quantised modifier key (cheap to call every frame).
   */
  function applyToParams(params, mods, opts) {
    if (!params || !mods) return params;
    opts = opts || {};
    var real = opts.massMode !== 'equivalent' && mods.mass_kg > 0 && mods.raw;
    var pm = real ? mods.raw.powerMult : mods.powerMult;
    var bm = real ? mods.raw.brakeMult : mods.brakeMult;
    var mass = real ? mods.mass_kg : params.mass;
    var q = function (x) { return Math.round(x * 400) / 400; };
    var key = [q(pm), q(bm), q(mods.dragMult), q(mods.downforceMult), Math.round(mass * 2) / 2].join('|');
    var cache = opts.cache;
    if (cache && cache.key === key && cache.base === params) return cache.params;
    var out;
    if (pm === 1 && bm === 1 && mods.dragMult === 1 && mods.downforceMult === 1 && mass === params.mass) out = params;
    else {
      out = {};
      for (var k in params) out[k] = params[k];
      out.mass = mass;
      if (isNum(params.Iz) && isNum(params.mass) && params.mass > 0) out.Iz = params.Iz * mass / params.mass;
      if (Array.isArray(params.torqueTable)) out.torqueTable = params.torqueTable.map(function (t) { return t * pm; });
      if (isNum(params.peakNm)) out.peakNm = params.peakNm * pm;
      if (isNum(params.powerKw)) out.powerKw = params.powerKw * pm;
      if (isNum(params.power_kw)) out.power_kw = params.power_kw * pm;
      if (isNum(params.power_hp)) out.power_hp = params.power_hp * pm;
      if (isNum(params.cdA)) out.cdA = params.cdA * mods.dragMult;
      if (isNum(params.sideCdA)) out.sideCdA = params.sideCdA * mods.dragMult;
      if (isNum(params.clA)) out.clA = params.clA * mods.downforceMult;
      if (isNum(params.maxBrakeTorqueF)) out.maxBrakeTorqueF = params.maxBrakeTorqueF * bm;
      if (isNum(params.maxBrakeTorqueR)) out.maxBrakeTorqueR = params.maxBrakeTorqueR * bm;
      if (isNum(params.brakeForceMax)) out.brakeForceMax = params.brakeForceMax * bm;
      out.enduranceKey = key;
    }
    if (cache) { cache.key = key; cache.base = params; cache.params = out; }
    return out;
  }

  /**
   * vehicleEnv(mods, env?, opts?) -> env for CB.race.vehicle.step with per-wheel grip and the puncture rolling drag
   * merged in. NOTE: CB.race.vehicle's env.dragMult is a *surface* drag term, so aero drag is NOT passed here —
   * use applyToParams for it.
   */
  function vehicleEnv(mods, env, opts) {
    env = env || {};
    opts = opts || {};
    var out = {};
    for (var k in env) out[k] = env[k];
    if (!mods) return out;
    var real = opts.massMode !== 'equivalent' && mods.raw;
    var wg = real ? mods.raw.wheelGrip : mods.wheelGrip;
    var base = Array.isArray(env.wheelGrip) ? env.wheelGrip : null;
    out.wheelGrip = [0, 1, 2, 3].map(function (i) { return (base ? num(base[i], 1) : 1) * num(wg && wg[i], 1); });
    if (mods.rollingMult && mods.rollingMult !== 1) {
      var rr = isNum(env.rollingMult) ? env.rollingMult : (VEHICLE_SURFACE_RR[env.surface || 'asphalt'] || 1);
      out.rollingMult = rr * mods.rollingMult;
    }
    return out;
  }

  /* ================================================================ impacts */
  function dirVec(localDir) {
    var x, y;
    if (isNum(localDir)) { x = Math.cos(localDir); y = Math.sin(localDir); }
    else if (Array.isArray(localDir)) { x = num(localDir[0], 1); y = num(localDir[1], 0); }
    else if (localDir && typeof localDir === 'object') { x = num(localDir.x, 1); y = num(localDir.y, 0); }
    else { x = 1; y = 0; }
    var l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  }

  function applyImpact(cs, impulse, localDir, opts) {
    opts = opts || {};
    var none = { severity: 0, dv: 0, zones: {}, puncture: -1 };
    if (!cs || cs.kind !== 'forge-endurance') return none;
    var J = isNum(impulse) ? Math.abs(impulse) : impulse && typeof impulse === 'object' ? Math.hypot(num(impulse.x, 0), num(impulse.y, 0)) : 0;
    var dv = J / Math.max(100, cs.mass_kg);
    cs.stats.impacts++;
    if (!cs.features.damage || dv < 1.4) return { severity: 0, dv: dv, zones: {}, puncture: -1 };
    var c = cs.cfg;
    var sev = Math.pow((dv - 1.4) / 22, 1.15) * c.damageMult * (opts.wall ? 1.15 : 1);
    sev = clamp(sev, 0, 1);
    if (sev > 0.15) cs.stats.heavyImpacts++;
    var u = dirVec(localDir);
    var wF = Math.max(0, u.x), wR = Math.max(0, -u.x), wL = Math.max(0, u.y), wRt = Math.max(0, -u.y);
    var sq = wF * wF + wR * wR + wL * wL + wRt * wRt || 1;
    var zones = {};
    function add(zone, amt) { if (amt <= 0) return; var before = cs.damage[zone]; cs.damage[zone] = clamp(before + amt, 0, 1); zones[zone] = round(cs.damage[zone] - before, 4); }
    add('front', sev * wF * wF / sq * 1.0);
    add('rear', sev * wR * wR / sq * 0.9);
    add('left', sev * wL * wL / sq * 1.1);
    add('right', sev * wRt * wRt / sq * 1.1);
    add('aero', sev * (0.8 * wF * wF + 0.7 * wR * wR + 0.3 * (wL * wL + wRt * wRt)) / sq);
    var mount = c.engineMount;
    var engHit = mount === 'front' ? 0.35 * wF * wF / sq : 0.35 * wR * wR / sq;
    add('engine', sev * (engHit + 0.04));
    // the corner nearest to the contact point takes suspension damage
    var corner = (u.x >= 0 ? 0 : 2) + (u.y >= 0 ? 0 : 1);
    var lateralness = Math.abs(u.y);
    var before = cs.suspension[corner];
    cs.suspension[corner] = clamp(before + sev * (0.3 + 0.5 * lateralness), 0, 1);
    zones['suspension' + WHEEL_NAMES[corner]] = round(cs.suspension[corner] - before, 4);
    var punctured = -1;
    if (cs.features.tires && sev > 0.06 && !cs.punctured[corner] && rand(cs) < Math.min(0.6, sev * 1.6 * (0.4 + lateralness))) {
      puncture(cs, corner, 'impact'); punctured = corner;
    }
    if (sev > 0.02) emit(cs, 'damage', sev > 0.3 ? 'Heavy damage' : sev > 0.1 ? 'Damage' : 'Light damage', { value: round(sev, 3), zones: zones });
    computeGrip(cs);
    return { severity: sev, dv: dv, zones: zones, puncture: punctured };
  }

  /* ================================================================ pit stops */
  function pitStop(cs, request) {
    request = request || {};
    if (!cs || cs.kind !== 'forge-endurance') return { duration_s: 0, newState: cs, breakdown: [] };
    var ns = clone(cs);
    var c = ns.cfg;
    var q = clamp(num(request.crewQuality, c.crewQuality), 0, 1);
    var breakdown = [];
    var stationary = 1.2; // stop on marks + release
    breakdown.push({ label: 'Stop & release', seconds: 1.2 });

    // --- tyres
    var change = [false, false, false, false];
    if (request.tires === true) change = [true, true, true, true];
    else if (Array.isArray(request.tires)) for (var i = 0; i < 4; i++) change[i] = !!request.tires[i];
    var nChange = change.filter(Boolean).length;
    var tireTime = 0, fumble = false;
    if (nChange > 0) {
      tireTime = (4.0 - 1.5 * q) * (0.6 + 0.4 * nChange / 4);
      tireTime += (rand(ns) - 0.5) * 0.6 * (1 - q);
      if (rand(ns) < 0.02 + 0.08 * (1 - q)) { fumble = true; var extra = 2 + rand(ns) * 3; tireTime += extra; }
      tireTime = Math.max(2.2, tireTime);
      var newComp = request.compound && (COMPOUNDS[request.compound] || catalogFind('tireCompounds', request.compound)) ? request.compound : ns.compound;
      var compI = compoundInfo(newComp);
      if (nChange < 4 && newComp !== ns.compound) newComp = ns.compound; // mixing compounds is illegal: partial change keeps compound
      ns.compound = newComp;
      var blanket = request.tireBlankets != null ? !!request.tireBlankets : c.tireBlankets;
      var amb = ns.envBase.ambient_c;
      var T0 = blanket ? (c.blanketTemp_c || Math.min(90, compI.window[0] + 2)) : amb + 4;
      for (var t = 0; t < 4; t++) {
        if (!change[t]) continue;
        ns.tireWear[t] = 0; ns.tireTemp_c[t] = T0; ns.tireCore_c[t] = T0; ns.punctured[t] = false;
        ns.tirePressure_kpa[t] = c.coldPressure_kpa * (T0 + KELVIN) / (c.pressureSetTemp_c + KELVIN);
        ns.tireAge_laps[t] = 0;
      }
      if (nChange === 4) ns.tireDistance_km = 0;
      ns.flags.tyresWorn = false;
      breakdown.push({ label: (nChange === 4 ? '4 tyres' : nChange + ' tyre' + (nChange > 1 ? 's' : '')) + ' (' + compoundInfo(ns.compound).name + ')', seconds: round(tireTime, 2), parallel: true });
      if (fumble) breakdown.push({ label: 'Wheel-gun fumble', seconds: 0, note: 'included above' });
    }

    // --- fuel / charge
    var fuelTime = 0, fuelAdded = 0, energyAdded = 0;
    if (ns.isEV && ns.battery) {
      var want = firstNum(request.charge_kwh, request.fuel_l, 0);
      if (isNum(request.chargeTo_soc)) want = Math.max(want, (request.chargeTo_soc - ns.battery.soc) * ns.battery.capacity_kwh);
      var b = ns.battery, room = b.capacity_kwh - b.energy_kwh;
      want = clamp(want, 0, room);
      if (want > 0) {
        // integrate with taper above 80 % SoC
        var e0 = b.energy_kwh, e1 = e0 + want, knee = b.capacity_kwh * 0.8;
        var below = Math.max(0, Math.min(e1, knee) - e0), above = Math.max(0, e1 - Math.max(e0, knee));
        fuelTime = 1.5 + below / EV_CHARGE_KWPS + above / EV_TAPER_KWPS;
        b.energy_kwh = e1; b.soc = b.energy_kwh / b.capacity_kwh; energyAdded = want;
        breakdown.push({ label: 'Charge ' + round(want, 1) + ' kWh', seconds: round(fuelTime, 2), parallel: true });
      }
    } else if (!ns.isEV) {
      var add = num(request.fuel_l, 0);
      if (isNum(request.fuelTo_l)) add = Math.max(add, request.fuelTo_l - ns.fuel_l);
      add = clamp(add, 0, ns.tankCapacity_l - ns.fuel_l);
      if (add > 0) {
        fuelTime = 0.8 + add / FUEL_RATE_LPS;
        ns.fuel_l += add; fuelAdded = add;
        breakdown.push({ label: 'Fuel +' + round(add, 1) + ' L', seconds: round(fuelTime, 2), parallel: true });
      }
    }
    var service = request.sequential ? tireTime + fuelTime : Math.max(tireTime, fuelTime);
    if (request.sequential && tireTime && fuelTime) breakdown.push({ label: 'Sequential service (no refuel during tyre change)', seconds: 0 });

    // --- repairs
    var repairTime = 0, repaired = {};
    var mode = request.repair === true ? 'full' : request.repair;
    if (mode === 'quick' || mode === 'full') {
      var d = ns.damage;
      var body = d.front + d.rear + d.left + d.right;
      var target = mode === 'quick' ? 0.3 : 0;
      var fixedBody = 0;
      ['front', 'rear', 'left', 'right', 'aero'].forEach(function (z) {
        var nv = Math.min(d[z], d[z] * target);
        fixedBody += d[z] - nv; repaired[z] = round(d[z] - nv, 3); d[z] = nv;
      });
      var engFix = 0, susFix = 0;
      if (mode === 'full') {
        engFix = Math.min(d.engine, 0.5); d.engine -= engFix; repaired.engine = round(engFix, 3);
        if (d.engine < 0.98) ns.engineFailed = false;
        for (var s = 0; s < 4; s++) { susFix += ns.suspension[s]; ns.suspension[s] = 0; }
        repaired.suspension = round(susFix, 3);
      } else {
        for (var s2 = 0; s2 < 4; s2++) { var nv2 = ns.suspension[s2] * 0.6; susFix += ns.suspension[s2] - nv2; ns.suspension[s2] = nv2; }
      }
      if (fixedBody + engFix + susFix > 0.001) {
        repairTime = (mode === 'quick' ? 2.5 : 4) + 12 * fixedBody + 30 * engFix + 9 * susFix;
        repairTime *= 1.35 - 0.7 * q;
        breakdown.push({ label: mode === 'quick' ? 'Quick repair (bodywork & aero)' : 'Full repair', seconds: round(repairTime, 2) });
      }
      void body;
    }
    if (request.brakes) {
      var bt = 22 * (1.3 - 0.6 * q);
      ns.brakeWear = 0; ns.brakeFade = 0; ns.brakeMult = 1;
      repairTime += bt;
      breakdown.push({ label: 'Brake pads & discs', seconds: round(bt, 2) });
    }

    var duration = stationary + service + repairTime;
    // the car cools while stationary
    var amb2 = ns.envBase.ambient_c, cool = Math.exp(-duration / 70);
    ns.brakeTemps_c = ns.brakeTemps_c.map(function (T) { return amb2 + (T - amb2) * cool; });
    ns.brakeTemp_c = Math.max(ns.brakeTemps_c[0], ns.brakeTemps_c[1]);
    for (var k = 0; k < 4; k++) if (!change[k]) { ns.tireTemp_c[k] = amb2 + (ns.tireTemp_c[k] - amb2) * Math.exp(-duration / 40); }
    if (!ns.isEV) ns.engineTemp_c = Math.max(85, amb2 + (ns.engineTemp_c - amb2) * Math.exp(-duration / 200));

    ns.stats.pitStops++;
    var lap = isNum(request.lap) ? request.lap : ns.laps.current;
    var entry = { lap: lap, t: round(ns.stats.time_s, 2), duration_s: round(duration, 2), tires: nChange, compound: ns.compound, fuel_l: round(fuelAdded, 2), charge_kwh: round(energyAdded, 2), repair: mode || false, fumble: fumble };
    ns.pits.push(entry);
    ns.flags.fuelLow = ns.flags.fuelCritical = false;
    updateMass(ns);
    computeGrip(ns);
    emit(ns, 'pit-stop', 'Pit stop ' + round(duration, 1) + ' s', { value: round(duration, 2), lap: lap });

    var cost = null;
    try {
      if (CB.game.economy && typeof CB.game.economy.pitServiceCost === 'function') {
        cost = CB.game.economy.pitServiceCost({ tires: nChange > 0, compound: ns.compound, fuel_l: ns.isEV ? energyAdded : fuelAdded, repair: !!mode }, request.build || null);
      }
    } catch (err) { cost = null; }

    return {
      duration_s: duration, newState: ns, breakdown: breakdown,
      tiresChanged: nChange, compound: ns.compound, fuelAdded_l: fuelAdded, energyAdded_kwh: energyAdded,
      repaired: repaired, fumble: fumble, crewQuality: q, cost: cost,
      timing: { stationary_s: stationary, tires_s: tireTime, fuel_s: fuelTime, repair_s: repairTime, service_s: service }
    };
  }

  /** Expected (no fumble, mean) stationary time for a request — used by the strategy planner. */
  function pitTimeEstimate(request, ctx) {
    request = request || {}; ctx = ctx || {};
    var q = clamp(num(request.crewQuality, num(ctx.crewQuality, 0.5)), 0, 1);
    var tires = request.tires ? (4.0 - 1.5 * q) + (0.02 + 0.08 * (1 - q)) * 3.5 : 0;
    var fuel = 0;
    if (ctx.isEV) {
      var cap = num(ctx.capacity_kwh, 80), e0 = num(ctx.energy_kwh, 0), add = num(request.charge_kwh, num(request.fuel_l, 0));
      var e1 = Math.min(cap, e0 + add), knee = cap * 0.8;
      if (add > 0) fuel = 1.5 + Math.max(0, Math.min(e1, knee) - e0) / EV_CHARGE_KWPS + Math.max(0, e1 - Math.max(e0, knee)) / EV_TAPER_KWPS;
    } else if (num(request.fuel_l, 0) > 0) fuel = 0.8 + request.fuel_l / FUEL_RATE_LPS;
    return 1.2 + (request.sequential ? tires + fuel : Math.max(tires, fuel));
  }

  /* ================================================================ pit lane */
  function pitLaneInfo(track, opts) {
    opts = opts || {};
    var L = isNum(track) ? track : firstNum(track && track.length_m, track && track.length, track && track.geom && track.geom.length, 4000);
    var entry, exit, derived = false;
    var def = track && (track.def || track.trackDef || track);
    if (def && isNum(def.pitEntry_s) && isNum(def.pitExit_s)) { entry = def.pitEntry_s; exit = def.pitExit_s; }
    else if (track && Array.isArray(track.samples) && track.samples.length > 10) {
      // walk the start/finish straight (s = 0) in both directions while curvature stays small
      var S = track.samples, N = S.length, kLim = 0.0045, back = 0, fwd = 0;
      for (var i = 1; i < N / 3; i++) { if (Math.abs(num(S[(N - i) % N].curvature, 0)) > kLim) break; back = i; }
      for (var j = 1; j < N / 3; j++) { if (Math.abs(num(S[j].curvature, 0)) > kLim) break; fwd = j; }
      var ds = L / N;
      var bm = clamp(back * ds * 0.85, 100, 450), fm = clamp(fwd * ds * 0.85, 80, 350);
      entry = L - bm; exit = fm; derived = true;
    } else {
      var len = clamp(L * 0.07, 250, 550);
      entry = L - len * 0.6; exit = len * 0.4; derived = true;
    }
    var laneLen = exit >= entry ? exit - entry : (L - entry) + exit;
    var vLim = PIT_SPEED_LIMIT_KPH / 3.6;
    var vRace = num(opts.straightSpeed_ms, 58);
    var loss = laneLen / vLim - laneLen / vRace + num(opts.entryExitLoss_s, 3.5);
    return { entry_s: entry, exit_s: exit, length_m: laneLen, trackLength_m: L, speedLimit_kph: PIT_SPEED_LIMIT_KPH, speedLimit_ms: vLim, laneLoss_s: loss, derived: derived };
  }
  function inPitLane(s, info) {
    if (!info || !isNum(s)) return false;
    var L = info.trackLength_m;
    s = ((s % L) + L) % L;
    return info.exit_s >= info.entry_s ? (s >= info.entry_s && s <= info.exit_s) : (s >= info.entry_s || s <= info.exit_s);
  }

  /* ================================================================ lap tracking & warnings */
  function lapSnapshot(cs) {
    return { t: cs.stats.time_s, fuel: cs.fuel_l, energy: cs.battery ? cs.battery.energy_kwh : 0, wear: cs.tireWear.slice(), dist: cs.stats.distance_km };
  }
  function trackLaps(cs, e) {
    if (e.lap == null) return;
    if (!cs.laps.mark) { cs.laps.mark = lapSnapshot(cs); cs.laps.current = e.lap; return; }
    if (e.lap > cs.laps.current) {
      var m = cs.laps.mark, now = lapSnapshot(cs);
      var wear = now.wear.map(function (w, i) { return Math.max(0, w - m.wear[i]); });
      var rec = { lap: e.lap, time_s: round(now.t - m.t, 3), fuel_l: round(Math.max(0, m.fuel - now.fuel), 4), energy_kwh: round(Math.max(0, m.energy - now.energy), 4),
                  wear: wear.map(function (w) { return round(w, 5); }), maxWear: round(max4(wear), 5), km: round(now.dist - m.dist, 3) };
      // pit stops reset the deltas (negative fuel/wear) — don't record a polluted lap
      if (rec.km > 0.05 && !(now.fuel > m.fuel + 0.5) && !now.wear.some(function (w, i) { return w + 1e-6 < m.wear[i]; })) {
        cs.laps.history.push(rec);
        if (cs.laps.history.length > 12) cs.laps.history.shift();
      }
      for (var i = 0; i < 4; i++) cs.tireAge_laps[i] += e.lap - cs.laps.current;
      cs.laps.current = e.lap;
      cs.laps.mark = now;
    }
  }

  function perLap(cs) {
    var h = cs.laps.history;
    if (!h.length) return null;
    var n = Math.min(h.length, 4), f = 0, en = 0, w = 0, t = 0;
    for (var i = h.length - n; i < h.length; i++) { f += h[i].fuel_l; en += h[i].energy_kwh; w += h[i].maxWear; t += h[i].time_s; }
    return { fuel_l: f / n, energy_kwh: en / n, maxWear: w / n, time_s: t / n, samples: n };
  }

  function checkWarnings(cs) {
    var pl = perLap(cs);
    if (!cs.isEV && cs.features.fuel) {
      var lowThr = pl ? pl.fuel_l * 2 : Math.max(4, cs.tankCapacity_l * 0.08);
      latch(cs, 'fuelLow', cs.fuel_l < lowThr && cs.fuel_l > 1, cs.fuel_l > lowThr + 1, function () { emit(cs, 'fuel-low', 'Fuel low: ' + round(cs.fuel_l, 1) + ' L', { value: cs.fuel_l }); });
      latch(cs, 'fuelCritical', cs.fuel_l <= 1 && cs.fuel_l > 0, cs.fuel_l > 2, function () { emit(cs, 'fuel-critical', 'Fuel critical — box now!', { value: cs.fuel_l }); });
      latch(cs, 'fuelEmpty', cs.fuel_l <= 0, cs.fuel_l > 0.5, function () { emit(cs, 'fuel-empty', 'Out of fuel', { value: 0 }); });
    }
    if (cs.battery && cs.isEV) {
      latch(cs, 'batteryLow', cs.battery.soc < 0.12, cs.battery.soc > 0.2, function () { emit(cs, 'battery-low', 'Battery ' + Math.round(cs.battery.soc * 100) + '%', { value: cs.battery.soc }); });
      latch(cs, 'batteryHot', cs.battery.temp_c > 52, cs.battery.temp_c < 46, function () { emit(cs, 'battery-hot', 'Battery overheating — power limited', { value: cs.battery.temp_c }); });
    }
    if (cs.features.tires) {
      var mw = max4(cs.tireWear);
      latch(cs, 'tyresWorn', mw > 0.8, mw < 0.5, function () { emit(cs, 'tyres-worn', 'Tyres worn (' + Math.round(mw * 100) + '%)', { value: mw }); });
      var comp = compoundInfo(cs.compound), hot = Math.max.apply(null, cs.tireTemp_c);
      latch(cs, 'tyresHot', hot > comp.window[1] + 15, hot < comp.window[1], function () { emit(cs, 'tyres-overheat', 'Tyres overheating', { value: hot }); });
    }
    if (cs.features.brakes) latch(cs, 'brakeFade', cs.brakeFade > 0.12, cs.brakeFade < 0.05, function () { emit(cs, 'brake-fade', 'Brake fade', { value: cs.brakeTemp_c }); });
    if (cs.features.thermal) {
      var lim = cs.isEV ? 72 : 112;
      latch(cs, 'engineHot', cs.engineTemp_c > lim, cs.engineTemp_c < lim - 6, function () { emit(cs, 'engine-overheat', (cs.isEV ? 'Drive unit' : 'Engine') + ' overheating', { value: cs.engineTemp_c }); });
    }
  }

  /* ================================================================ advice & summary */
  function tireState(cs, i) {
    if (cs.punctured[i]) return 'punctured';
    if (cs.tireWear[i] > 0.8) return 'worn';
    var comp = compoundInfo(cs.compound), T = 0.7 * cs.tireTemp_c[i] + 0.3 * cs.tireCore_c[i];
    if (T < comp.window[0] - 5) return 'cold';
    if (T > comp.window[1] + 5) return 'hot';
    return 'optimal';
  }

  function liveAdvice(cs, ctx) {
    ctx = ctx || {};
    var lapsRem = Math.max(0, num(ctx.lapsRemaining, 0));
    var pl = perLap(cs);
    var reasons = [], urgency = 0;
    var lapsOfFuel = Infinity, lapsOfTires = Infinity, fuelToFinish = 0;
    if (pl) {
      if (cs.isEV && cs.battery && pl.energy_kwh > 0) lapsOfFuel = cs.battery.energy_kwh / pl.energy_kwh;
      else if (!cs.isEV && pl.fuel_l > 0) lapsOfFuel = cs.fuel_l / pl.fuel_l;
      if (pl.maxWear > 0) lapsOfTires = (1 - max4(cs.tireWear)) / pl.maxWear;
      fuelToFinish = Math.max(0, lapsRem * (cs.isEV ? pl.energy_kwh : pl.fuel_l) * 1.04 + (cs.isEV ? 0.5 : 1) - (cs.isEV ? (cs.battery ? cs.battery.energy_kwh : 0) : cs.fuel_l));
    }
    if (cs.punctured.some(Boolean)) { reasons.push('puncture'); urgency = 1; }
    if (lapsOfFuel < lapsRem) {
      if (lapsOfFuel < 1.3) { reasons.push('fuel'); urgency = Math.max(urgency, 1); }
      else if (lapsOfFuel < 2.3) { reasons.push('fuel (next lap)'); urgency = Math.max(urgency, 0.6); }
    }
    if (lapsOfTires < lapsRem && (lapsOfTires < 1.5 || max4(cs.tireWear) > 0.9)) { reasons.push('tyres'); urgency = Math.max(urgency, max4(cs.tireWear) > 0.92 ? 0.95 : 0.7); }
    var dmg = cs.damage, body = dmg.front + dmg.rear + dmg.left + dmg.right + dmg.aero;
    if (lapsRem > 3 && (dmg.aero > 0.45 || body > 1.4 || dmg.engine > 0.5)) { reasons.push('damage'); urgency = Math.max(urgency, 0.5); }
    var lapsAfter = lapsRem;
    var request = {
      tires: reasons.indexOf('tyres') >= 0 || reasons.indexOf('puncture') >= 0 || (lapsOfTires < lapsAfter && max4(cs.tireWear) > 0.5),
      compound: ctx.wetness > 0.6 ? 'wet' : ctx.wetness > 0.25 ? 'intermediate' : cs.compound,
      repair: reasons.indexOf('damage') >= 0 ? (dmg.engine > 0.5 ? 'full' : 'quick') : false
    };
    if (cs.isEV) request.charge_kwh = round(fuelToFinish, 1); else request.fuel_l = round(Math.min(fuelToFinish, cs.tankCapacity_l - cs.fuel_l), 1);
    return {
      box: urgency >= 0.95 || (urgency >= 0.6 && lapsRem > 0), urgency: urgency, reasons: reasons,
      lapsOfFuel: isFinite(lapsOfFuel) ? round(lapsOfFuel, 2) : null, lapsOfTires: isFinite(lapsOfTires) ? round(lapsOfTires, 2) : null,
      fuelToFinish: round(fuelToFinish, 2), unit: cs.isEV ? 'kWh' : 'L', perLap: pl, request: request,
      estimatedStop_s: round(pitTimeEstimate({ tires: request.tires, fuel_l: request.fuel_l, charge_kwh: request.charge_kwh, crewQuality: cs.cfg.crewQuality },
        { isEV: cs.isEV, capacity_kwh: cs.battery && cs.battery.capacity_kwh, energy_kwh: cs.battery && cs.battery.energy_kwh }), 2)
    };
  }

  function summary(cs) {
    if (!cs || cs.kind !== 'forge-endurance') return null;
    var pl = perLap(cs);
    var warnings = [];
    for (var k in cs.flags) if (cs.flags[k]) warnings.push(k);
    var d = cs.damage;
    return {
      enabled: true,
      compound: cs.compound, compoundName: compoundInfo(cs.compound).name, tireWindow_c: compoundInfo(cs.compound).window,
      tireWear: cs.tireWear.map(function (w) { return round(w, 4); }),
      tireTemp_c: cs.tireTemp_c.map(function (t) { return round(t, 1); }),
      tireCore_c: cs.tireCore_c.map(function (t) { return round(t, 1); }),
      tirePressure_kpa: cs.tirePressure_kpa.map(function (p) { return round(p, 1); }),
      tireGrip: cs.tireGrip.map(function (g) { return round(g, 4); }),
      tireState: [0, 1, 2, 3].map(function (i) { return tireState(cs, i); }),
      punctured: cs.punctured.slice(), tireAge_laps: cs.tireAge_laps.slice(),
      fuel_l: round(cs.fuel_l, 3), tank_l: cs.tankCapacity_l, fuelPct: cs.tankCapacity_l ? round(cs.fuel_l / cs.tankCapacity_l, 4) : null,
      fuelMap: cs.fuelMap, fuelFlow_lph: round(cs.last.fuelFlow_lph, 2),
      fuelPerLap_l: pl ? round(pl.fuel_l, 3) : null,
      lapsOfFuel: pl ? (cs.isEV ? (pl.energy_kwh > 0 && cs.battery ? round(cs.battery.energy_kwh / pl.energy_kwh, 2) : null) : (pl.fuel_l > 0 ? round(cs.fuel_l / pl.fuel_l, 2) : null)) : null,
      battery: cs.battery ? { soc: round(cs.battery.soc, 4), energy_kwh: round(cs.battery.energy_kwh, 3), capacity_kwh: cs.battery.capacity_kwh, temp_c: round(cs.battery.temp_c, 1), powerKw: round(cs.last.batteryKw, 1) } : null,
      damage: { front: round(d.front, 3), rear: round(d.rear, 3), left: round(d.left, 3), right: round(d.right, 3), engine: round(d.engine, 3), aero: round(d.aero, 3) },
      damageTotal: round(clamp((d.front + d.rear + d.left + d.right) / 4 * 0.6 + d.engine * 0.25 + d.aero * 0.15, 0, 1), 3),
      suspension: cs.suspension.map(function (s) { return round(s, 3); }),
      brakeTemp_c: round(cs.brakeTemp_c, 1), brakeTemps_c: cs.brakeTemps_c.map(function (t) { return round(t, 1); }),
      brakeFade: round(cs.brakeFade, 3), brakeWear: round(cs.brakeWear, 4),
      engineTemp_c: round(cs.engineTemp_c, 1), engineFailed: cs.engineFailed,
      mass_kg: round(cs.mass_kg, 1), pitStops: cs.stats.pitStops, lastPit: cs.pits.length ? cs.pits[cs.pits.length - 1] : null,
      fuelLeft_l: round(cs.fuel_l, 3), // alias used by achievements
      warnings: warnings
    };
  }

  function setFuelMap(cs, map) { if (cs && FUEL_MAPS[map]) cs.fuelMap = map; return cs; }

  /* ================================================================ synthetic lap simulation */
  function resolveCar(carParams) {
    carParams = carParams || {};
    var vp = carParams.params || carParams.vehicleParams || carParams;
    var build = carParams.build || null;
    if (!carParams.params && carParams.build && CB.race && CB.race.vehicle && typeof CB.race.vehicle.fromBuild === 'function') {
      try { vp = CB.race.vehicle.fromBuild(carParams.build, carParams.metrics || null); } catch (e) { vp = carParams; }
    }
    return { vp: vp || {}, build: build, extra: carParams };
  }

  // deterministic synthetic circuit with the right length & a realistic corner mix
  function syntheticTrack(L, seed) {
    var st = (seed >>> 0) || 7;
    function r() { st = (st + 0x6D2B79F5) >>> 0; var t = Math.imul(st ^ (st >>> 15), st | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    var nC = Math.max(4, Math.round(L / 480));
    var corners = [], arcTot = 0;
    for (var i = 0; i < nC; i++) {
      var R = 25 + Math.pow(r(), 1.6) * 230;
      var ang = (50 + r() * 100) * Math.PI / 180;
      var arc = R * ang;
      corners.push({ R: R, len: arc }); arcTot += arc;
    }
    var scale = arcTot > L * 0.45 ? L * 0.45 / arcTot : 1;
    corners.forEach(function (c) { c.len *= scale; });
    arcTot *= scale;
    var straightTot = L - arcTot, segs = [];
    var weights = corners.map(function () { return 0.4 + r(); }), wsum = sum(weights);
    weights[0] += wsum * 0.3; wsum *= 1.3; // a long main straight
    corners.forEach(function (c, k) { segs.push({ R: Infinity, len: straightTot * weights[k] / wsum }); segs.push(c); });
    return segs;
  }

  function speedProfile(segs, car, mods, ds) {
    var pts = [];
    segs.forEach(function (sg, si) {
      var n = Math.max(1, Math.round(sg.len / ds));
      for (var k = 0; k < n; k++) pts.push({ R: sg.R, ds: sg.len / n, dir: si % 4 === 1 ? -1 : 1 });
    });
    var N = pts.length, m = car.mass, mu = car.maxLatG * avg(mods.gripMult), muB = car.maxBrakeG * avg(mods.gripMult) * 0.92 * Math.min(1, mods.brakeMult);
    var dfk = 0.5 * RHO * car.clA * mods.downforceMult, drk = 0.5 * RHO * car.cdA * mods.dragMult;
    var P = car.powerKw * 1000 * 0.88 * mods.powerMult, vTop = car.topSpeed;
    var vmax = new Array(N), v = new Array(N);
    for (var i = 0; i < N; i++) {
      var R = pts[i].R;
      if (!isFinite(R)) { vmax[i] = vTop; continue; }
      var den = 1 - mu * dfk * R / m;
      vmax[i] = den > 0.05 ? Math.min(vTop, Math.sqrt(mu * G * R / den)) : vTop;
    }
    function accel(vv) { return Math.min(mu * G * 0.75, P / (m * Math.max(vv, 5))) - drk * vv * vv / m - car.rollingRes * G; }
    function decel(vv) { return muB * G + (dfk * vv * vv / m) * muB * 0.5 + drk * vv * vv / m; }
    var vs = vmax[N - 1];
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < N; i++) { var a = accel(vs); vs = Math.min(vmax[i], Math.sqrt(Math.max(1, vs * vs + 2 * Math.max(0, a) * pts[i].ds))); v[i] = vs; }
      for (i = N - 1; i >= 0; i--) { var nx = v[(i + 1) % N]; var lim = Math.sqrt(nx * nx + 2 * decel(nx) * pts[i].ds); if (lim < v[i]) v[i] = lim; }
      vs = v[N - 1];
    }
    return { pts: pts, v: v, accel: accel, decel: decel, mu: mu, muB: muB };
  }

  function simulateStint(carParams, trackLength, laps, opts) {
    opts = opts || {};
    var rc = resolveCar(carParams);
    var L = isNum(trackLength) ? trackLength : firstNum(trackLength && trackLength.length_m, trackLength && trackLength.length, 4000);
    var csOpts = {};
    for (var k in opts) csOpts[k] = opts[k];
    if (rc.extra && rc.extra.tank_l && !csOpts.tank_l) csOpts.tank_l = rc.extra.tank_l;
    var cs = opts.state ? clone(opts.state) : createCarState(rc.vp, rc.build, csOpts);
    var car = cs.cfg;
    car.maxLatG = cs.cfg.maxLatG; car.mass = cs.massRef_kg;
    var segs = syntheticTrack(L, hashSeed('L' + Math.round(L)));
    var ds = num(opts.ds, 4), aggression = clamp(num(opts.aggression, 0.92), 0.5, 1.05);
    var out = [];
    var envIn = { ambient_c: cs.envBase.ambient_c, trackTemp_c: cs.envBase.trackTemp_c, wetness: cs.envBase.wetness };
    laps = Math.max(1, Math.min(200, Math.round(laps)));
    // The race vehicle model applies the *build* compound's wet behaviour itself (gripMult only carries the ratio to
    // the fitted compound); the synthetic lap has no vehicle model, so emulate that base wet factor here.
    var baseC = compoundInfo(cs.baseCompound);
    var wetFactor = effMu(baseC, envIn.wetness) / Math.max(0.1, baseC.mu);
    for (var lap = 0; lap < laps; lap++) {
      var mods = modifiers(cs);
      var prof = speedProfile(segs, { mass: cs.mass_kg, maxLatG: car.maxLatG * aggression * wetFactor, maxBrakeG: car.maxBrakeG * aggression * wetFactor, clA: car.clA, cdA: car.cdA, powerKw: car.powerKw / Math.max(0.5, mods.massRatio), topSpeed: car.topSpeed, rollingRes: car.rollingRes }, mods, ds);
      var fuel0 = cs.fuel_l, en0 = cs.battery ? cs.battery.energy_kwh : 0, wear0 = cs.tireWear.slice(), t = 0;
      var maxT = 0;
      for (var i = 0; i < prof.pts.length; i++) {
        var p = prof.pts[i], v0 = prof.v[i], v1 = prof.v[(i + 1) % prof.v.length];
        var vm = Math.max(1, (v0 + v1) / 2), dt = p.ds / vm;
        var ax = (v1 * v1 - v0 * v0) / (2 * p.ds);
        var ay = isFinite(p.R) ? p.dir * vm * vm / p.R : 0;
        var aMax = prof.accel(vm), dMax = prof.decel(vm);
        var drag = 0.5 * RHO * car.cdA * mods.dragMult * vm * vm / cs.mass_kg + car.rollingRes * G;
        var thr = ax >= -drag * 0.5 ? clamp((ax + drag) / Math.max(0.5, aMax + drag), 0.05, 1) : 0;
        var brk = ax < -drag ? clamp((-ax - drag) / Math.max(0.5, dMax - drag), 0, 1) : 0;
        var rpm = car.idle + (car.redline - car.idle) * (0.55 + 0.4 * ((vm * 7) % 10) / 10);
        var vsS = { speed: vm, vx: vm, ax: ax, ay: ay, throttle: thr, rpm: rpm };
        stepOnce(cs, vsS, { throttle: thr, brake: brk }, dt, normEnv(envIn, cs));
        t += dt;
        maxT = Math.max(maxT, max4(cs.tireTemp_c));
      }
      var rec = {
        lap: lap + 1, time_s: t,
        fuel_l: Math.max(0, fuel0 - cs.fuel_l), energy_kwh: cs.battery ? Math.max(0, en0 - cs.battery.energy_kwh) : 0,
        wear: cs.tireWear.map(function (w, j) { return w - wear0[j]; }), wearTotal: cs.tireWear.slice(),
        maxWear: max4(cs.tireWear.map(function (w, j) { return w - wear0[j]; })),
        tireTemp_c: cs.tireTemp_c.slice(), maxTireTemp_c: maxT, brakeTemp_c: cs.brakeTemp_c, engineTemp_c: cs.engineTemp_c,
        grip: avg(cs.tireGrip), mass_kg: cs.mass_kg
      };
      out.push(rec);
      if (opts.holdFuel && !cs.isEV) { cs.fuel_l = fuel0; updateMass(cs); }
      if (opts.holdFuel && cs.battery) { cs.battery.energy_kwh = en0; cs.battery.soc = en0 / cs.battery.capacity_kwh; }
      if (opts.stopOnPuncture !== false && cs.punctured.some(Boolean)) break;
    }
    return { laps: out, state: cs, trackLength_m: L };
  }

  function simulateLap(carParams, trackLength, opts) {
    var r = simulateStint(carParams, trackLength, num(opts && opts.warmLaps, 1) + 1, opts);
    var last = r.laps[r.laps.length - 1];
    last.state = r.state;
    return last;
  }

  /* ================================================================ strategy */
  function suggestStrategy(laps, trackLength, carParams, opts) {
    opts = opts || {};
    carParams = carParams || {};
    laps = Math.max(1, Math.round(num(laps, 10)));
    var rc = resolveCar(carParams);
    var ex = rc.extra;
    var L = isNum(trackLength) ? trackLength : firstNum(trackLength && trackLength.length_m, trackLength && trackLength.length, 4000);
    var pit = pitLaneInfo(isNum(trackLength) ? L : (trackLength || L), opts);
    var laneLoss = num(opts.pitLaneLoss_s, num(ex.pitLaneLoss_s, pit.laneLoss_s));
    var baseState = createCarState(rc.vp, rc.build, { tank_l: firstNum(opts.tank_l, ex.tank_l), weather: opts.weather, timeOfDay: opts.timeOfDay, ambient_c: opts.ambient_c,
      wetness: opts.wetness, wearMult: firstNum(opts.wearMult, ex.wearMult), fuelMult: firstNum(opts.fuelMult, ex.fuelMult), crewQuality: firstNum(opts.crewQuality, ex.crewQuality),
      compound: ex.compound || opts.compound, tireBlankets: opts.tireBlankets, battery_kwh: firstNum(opts.battery_kwh, ex.battery_kwh) });
    var isEV = baseState.isEV;
    var tank = isEV ? baseState.battery.capacity_kwh : baseState.tankCapacity_l;
    var reserve = num(opts.reserve, isEV ? tank * 0.03 : 1.0);
    var wearLimit = clamp(num(opts.wearLimit, 0.82), 0.3, 0.98);
    var crewQ = baseState.cfg.crewQuality;
    var candidates = (opts.compounds || ex.compounds || [baseState.baseCompound]).filter(function (id) { return COMPOUNDS[id] || catalogFind('tireCompounds', id); });
    if (!candidates.length) candidates = [baseState.baseCompound];
    var notes = [];

    // ---- per-compound stint model: lap time vs tyre age (fuel held constant), wear per lap, fuel per lap
    var models = {};
    candidates.forEach(function (cid) {
      var model = null;
      if (isNum(ex.fuelPerLap_l) && isNum(ex.lapTime_s) && (isNum(ex.wearPerLap) || (ex.wearPerLap && isNum(ex.wearPerLap[cid])))) {
        var wpl = isNum(ex.wearPerLap) ? ex.wearPerLap : ex.wearPerLap[cid];
        var ratio = effMu(compoundInfo(cid), baseState.envBase.wetness) / effMu(compoundInfo(baseState.baseCompound), baseState.envBase.wetness);
        var lt0 = ex.lapTime_s / Math.sqrt(ratio);
        model = { analytic: true, wearPerLap: wpl, fuelPerLap: ex.fuelPerLap_l, lapTimes: [], lap0: lt0 };
        for (var a = 0; a < 200; a++) model.lapTimes.push(lt0 / Math.sqrt(wearGrip(Math.min(1, a * wpl + wpl / 2))));
      } else {
        try {
          var simLaps = Math.min(laps, num(opts.simLaps, 30));
          var st = clone(baseState); st.compound = cid; st.tireTemp_c = st.tireTemp_c.map(function () { return baseState.cfg.tireBlankets ? Math.min(90, compoundInfo(cid).window[0] + 2) : baseState.envBase.ambient_c + 4; }); st.tireCore_c = st.tireTemp_c.slice(); computeGrip(st);
          var sim = simulateStint(carParams, L, simLaps, { state: st, holdFuel: true, ds: num(opts.ds, 5), stopOnPuncture: true });
          var lt = sim.laps.map(function (r) { return r.time_s; });
          var wp = sim.laps.map(function (r) { return r.maxWear; });
          var fp = sim.laps.map(function (r) { return isEV ? r.energy_kwh : r.fuel_l; });
          var wplS = avg(wp.slice(Math.min(1, wp.length - 1)));
          var fplS = avg(fp.slice(Math.min(1, fp.length - 1)));
          // extrapolate beyond the simulated window using the wear->grip curve
          var lastT = lt[lt.length - 1], lastW = sim.laps[sim.laps.length - 1].wearTotal ? max4(sim.laps[sim.laps.length - 1].wearTotal) : wplS * lt.length;
          for (var b = lt.length; b < 200; b++) {
            var w = Math.min(1, lastW + (b - lt.length + 1) * wplS);
            lt.push(lastT * Math.sqrt(wearGrip(Math.min(1, lastW)) / Math.max(0.3, wearGrip(w))));
          }
          model = { analytic: false, wearPerLap: wplS, fuelPerLap: fplS, lapTimes: lt, lap0: lt[Math.min(1, lt.length - 1)], warmup_s: lt[0] - lt[Math.min(1, lt.length - 1)] };
        } catch (err) {
          notes.push('Simulation failed for ' + cid + ': ' + (err && err.message));
          model = null;
        }
      }
      if (model) models[cid] = model;
    });
    var cids = Object.keys(models);
    if (!cids.length) return { feasible: false, stops: 0, stints: [], pitStops: [], totalTime_s: null, notes: notes.concat(['No usable compound model']) };

    var fpl = models[cids[0]].fuelPerLap * 1.03; // 3 % safety margin
    var massRef = baseState.massRef_kg, density = baseState.cfg.fuelDensity, refFuel = baseState.cfg.refFuel_l;
    function fuelEffect(lapTime, fuelL) {
      if (isEV) return 0;
      var dkg = (refFuel - fuelL) * density;      // lighter than reference -> faster
      return -lapTime * 0.32 * dkg / massRef;
    }
    var maxFuelStint = isEV ? Math.floor((tank * 0.97 - reserve) / Math.max(1e-6, fpl)) : Math.floor((tank - reserve) / Math.max(1e-6, fpl));
    if (maxFuelStint < 1) return { feasible: false, stops: 0, stints: [], pitStops: [], totalTime_s: null, fuelPerLap: fpl, notes: notes.concat(['Tank too small for a single lap']) };
    var minStops = Math.max(0, Math.ceil(laps / maxFuelStint) - 1, num(opts.mandatoryStops, 0));
    var maxStops = Math.min(laps - 1, minStops + num(opts.extraStops, 3), 12);
    if (maxStops < minStops) maxStops = minStops;

    function evaluate(stintLaps, comps) {
      var total = 0, stints = [], pits = [], lapNo = 1, tyreAge = 0, tyreWear = 0, curComp = null, ok = true;
      var fuelNow = 0;
      for (var s = 0; s < stintLaps.length; s++) {
        var n = stintLaps[s], cid = comps[s], m = models[cid];
        var newTyres = s === 0 || cid !== curComp || tyreWear + n * m.wearPerLap > wearLimit;
        var fuelNeed = n * fpl + reserve;
        if (fuelNeed > tank + 1e-9) { ok = false; break; }
        var stop = null;
        if (s === 0) { fuelNow = isEV ? tank : Math.min(tank, fuelNeed); }
        else {
          var add = Math.max(0, fuelNeed - fuelNow);
          var tyreFree = false;
          var tEst = pitTimeEstimate({ tires: true, fuel_l: add, crewQuality: crewQ }, { isEV: isEV, capacity_kwh: tank, energy_kwh: fuelNow });
          var nEst = pitTimeEstimate({ tires: false, fuel_l: add, crewQuality: crewQ }, { isEV: isEV, capacity_kwh: tank, energy_kwh: fuelNow });
          if (tEst - nEst < 0.05) tyreFree = true;
          if (tyreFree && m.wearPerLap > 0) newTyres = true;
          var dur = newTyres ? tEst : nEst;
          stop = { lap: lapNo - 1, tires: newTyres, compound: cid, fuel_l: round(add, 2), duration_s: round(dur, 2), laneLoss_s: round(laneLoss, 2), total_s: round(dur + laneLoss, 2) };
          pits.push(stop);
          total += dur + laneLoss;
          fuelNow += add;
        }
        if (newTyres) { tyreAge = 0; tyreWear = 0; curComp = cid; }
        if (tyreWear + n * m.wearPerLap > wearLimit + 1e-9) { ok = false; break; }
        var st = 0, startFuel = fuelNow;
        for (var k = 0; k < n; k++) {
          var lt = m.lapTimes[Math.min(m.lapTimes.length - 1, tyreAge)];
          if (!newTyres && k === 0 && tyreAge === 0) lt = m.lapTimes[1] || lt;
          lt += fuelEffect(m.lap0, fuelNow - fpl / 2);
          st += lt; tyreAge++; tyreWear += m.wearPerLap; fuelNow -= fpl;
        }
        if (lapNo === 1 && opts.standingStart !== false) st += 2.5;
        total += st;
        stints.push({ index: s + 1, startLap: lapNo, endLap: lapNo + n - 1, laps: n, compound: cid, newTyres: newTyres,
          fuel_l: round(startFuel, 2), fuelEnd_l: round(Math.max(0, fuelNow), 2), tireWearEnd: round(tyreWear, 3), estTime_s: round(st, 2), avgLap_s: round(st / n, 3) });
        lapNo += n;
      }
      if (!ok) return null;
      return { totalTime_s: total, stints: stints, pitStops: pits };
    }

    function split(n, parts, longFirst) {
      var base = Math.floor(n / parts), rem = n - base * parts, out = [];
      for (var i = 0; i < parts; i++) out.push(base + (longFirst ? (i < rem ? 1 : 0) : (i >= parts - rem ? 1 : 0)));
      return out;
    }

    var results = [];
    for (var stops = minStops; stops <= maxStops; stops++) {
      var parts = stops + 1;
      if (parts > laps) break;
      var splits = [split(laps, parts, true), split(laps, parts, false)];
      var combos = [];
      if (cids.length === 1 || Math.pow(cids.length, parts) > 243) combos = cids.map(function (c) { var a = []; for (var i = 0; i < parts; i++) a.push(c); return a; });
      else {
        var total = Math.pow(cids.length, parts);
        for (var ci = 0; ci < total; ci++) { var arr = [], x = ci; for (var p = 0; p < parts; p++) { arr.push(cids[x % cids.length]); x = Math.floor(x / cids.length); } combos.push(arr); }
      }
      if (opts.requireTwoCompounds && cids.length > 1) combos = combos.filter(function (cb) { return cb.some(function (c) { return c !== cb[0]; }); });
      splits.forEach(function (sp) {
        combos.forEach(function (cb) {
          var r = evaluate(sp, cb);
          if (r) { r.stops = stops; r.compounds = cb; results.push(r); }
        });
      });
    }
    if (!results.length) {
      return { feasible: false, laps: laps, stops: null, stints: [], pitStops: [], totalTime_s: null, fuelPerLap: round(fpl, 3), unit: isEV ? 'kWh' : 'L',
               notes: notes.concat(['No feasible plan — tyres cannot last even the shortest stint; try a harder compound']) };
    }
    results.sort(function (a, b) { return a.totalTime_s - b.totalTime_s; });
    // dedupe identical plans
    var seen = {}, uniq = [];
    results.forEach(function (r) { var key = r.stints.map(function (s) { return s.laps + s.compound + (s.newTyres ? '*' : ''); }).join('|'); if (!seen[key]) { seen[key] = 1; uniq.push(r); } });
    var best = uniq[0];
    var wearPerLap = {}, lapTime = {};
    cids.forEach(function (c) { wearPerLap[c] = round(models[c].wearPerLap, 5); lapTime[c] = round(models[c].lap0, 3); });
    if (best.stops === 0) notes.push('Flat-out non-stop is fastest.');
    cids.forEach(function (c) { var life = models[c].wearPerLap > 0 ? Math.floor(wearLimit / models[c].wearPerLap) : Infinity; notes.push(compoundInfo(c).name + ': ~' + (isFinite(life) ? life : '∞') + ' laps per set'); });
    notes.push('Fuel range: ' + maxFuelStint + ' laps per ' + (isEV ? 'charge' : 'tank'));
    return {
      feasible: true, laps: laps, trackLength_m: L, unit: isEV ? 'kWh' : 'L', isEV: isEV,
      stops: best.stops, totalTime_s: round(best.totalTime_s, 2), avgLap_s: round(best.totalTime_s / laps, 3),
      startFuel_l: best.stints[0].fuel_l, fuelPerLap: round(fpl, 4), fuelPerLap_l: isEV ? null : round(fpl, 4), energyPerLap_kwh: isEV ? round(fpl, 4) : null,
      wearPerLap: wearPerLap, lapTime_s: lapTime, maxStintLapsFuel: maxFuelStint,
      stints: best.stints, pitStops: best.pitStops, pitLaps: best.pitStops.map(function (p) { return p.lap; }),
      pitLane: pit, pitLaneLoss_s: round(laneLoss, 2),
      alternatives: uniq.slice(1, 5).map(function (r) { return { stops: r.stops, compounds: r.compounds, stintLaps: r.stints.map(function (s) { return s.laps; }), totalTime_s: round(r.totalTime_s, 2), delta_s: round(r.totalTime_s - best.totalTime_s, 2) }; }),
      notes: notes
    };
  }

  /* ================================================================ race-engine hooks adapter */
  function createHooks(opts) {
    opts = opts || {};
    var extras = opts.extras || {};
    var features = {
      tires: extras.endurance !== false && extras.wear !== false && opts.tires !== false,   // career extras use `wear`
      fuel: extras.fuel !== false && opts.fuel !== false,
      damage: extras.damage !== false && opts.damage !== false,
      brakes: extras.endurance !== false && opts.brakes !== false,
      thermal: opts.thermal !== false
    };
    var env = environment(opts.weather, opts.timeOfDay, opts);
    var states = {}, paramCache = {};
    function onEvent(car, ev) {
      ev.carId = car && car.id;
      if (typeof extras.onEvent === 'function') { try { extras.onEvent(ev); } catch (e) { /* listener errors never break the sim */ } }
      if (typeof opts.onEvent === 'function') { try { opts.onEvent(ev); } catch (e2) { /* ignore */ } }
    }
    function stateOf(car) { return car && (car.endurance || states[car.id]) || null; }
    function flush(car) { var cs = stateOf(car); if (!cs || !cs.events.length) return; drainEvents(cs).forEach(function (e) { onEvent(car, e); }); }
    var hooks = {
      features: features,
      env: env,
      carCreated: function (car) {
        if (!car) return null;
        if (opts.playerOnly && !car.isPlayer) return null;
        var o = { weather: opts.weather, timeOfDay: opts.timeOfDay, ambient_c: env.ambient_c, trackTemp_c: env.trackTemp_c, features: features,
                  wearMult: opts.wearMult, fuelMult: opts.fuelMult, damageMult: opts.damageMult, crewQuality: car.isPlayer ? opts.crewQuality : num(opts.aiCrewQuality, 0.6),
                  tank_l: opts.tank_l, tireBlankets: opts.tireBlankets, seed: hashSeed(String(car.id) + '|' + num(opts.seed, 1)) };
        if (typeof opts.startFuel === 'function') o.fuel_l = opts.startFuel(car); else if (isNum(opts.fuel_l)) o.fuel_l = opts.fuel_l;
        if (opts.compound) o.compound = opts.compound;
        var cs = createCarState(car.params, car.build, o);
        car.endurance = cs; states[car.id] = cs;
        return cs;
      },
      preStep: function (car, input) {
        var cs = stateOf(car);
        if (!cs || !input) return input;
        var m = modifiers(cs);
        var out = {};
        for (var k in input) out[k] = input[k];
        var v = Math.abs(num(car.state && car.state.speed, 0));
        if (m.steerPull) out.steer = clamp(num(out.steer, 0) + m.steerPull * smoothstep(2, 25, v), -1, 1);
        if (!m.engineAlive) out.throttle = 0;
        if (car.pitLimiter) { var lim = PIT_SPEED_LIMIT_KPH / 3.6; if (v > lim) { out.throttle = 0; out.brake = Math.max(num(out.brake, 0), clamp((v - lim) * 0.3, 0, 1)); } else if (v > lim * 0.97) out.throttle = Math.min(num(out.throttle, 0), 0.25); }
        return out;
      },
      postStep: function (car, dt) {
        var cs = stateOf(car);
        if (!cs) return;
        var e = typeof opts.envFor === 'function' ? opts.envFor(car) : null;
        e = e || {
          ambient_c: env.ambient_c, trackTemp_c: env.trackTemp_c, wetness: env.wetness,
          surface: car.surface || 'asphalt', onTrack: car.onTrack !== false,
          lap: car.tracker && isNum(car.tracker.lap) ? car.tracker.lap : (isNum(car.lap) ? car.lap : null)
        };
        step(cs, car.state, car.input || {}, num(dt, 1 / 120), e);
        flush(car);
      },
      modifiers: function (car) { var cs = stateOf(car); return cs ? modifiers(cs) : null; },
      onImpact: function (car, impulse, localDir, o) { var cs = stateOf(car); if (!cs) return null; var r = applyImpact(cs, impulse, localDir, o); flush(car); return r; },
      pitStop: function (car, request) {
        var cs = stateOf(car); if (!cs) return null;
        var r = pitStop(cs, request);
        car.endurance = states[car.id] = r.newState;
        flush(car);
        return r;
      },
      snapshot: function (car) { var cs = stateOf(car); return cs ? summary(cs) : null; },
      advice: function (car, ctx) { var cs = stateOf(car); return cs ? liveAdvice(cs, ctx) : null; },
      /** params with fuel mass / power / aero / brake effects baked in (memoised per car) */
      vehicleParams: function (car, baseParams) {
        var cs = stateOf(car), base = baseParams || (car && car.params);
        if (!cs || !base) return base;
        var cache = paramCache[car.id] || (paramCache[car.id] = {});
        return applyToParams(base, modifiers(cs), { cache: cache, massMode: opts.massMode });
      },
      /** CB.race.vehicle env with per-wheel grip / puncture drag merged in */
      vehicleEnv: function (car, baseEnv) { var cs = stateOf(car); return cs ? vehicleEnv(modifiers(cs), baseEnv, { massMode: opts.massMode }) : baseEnv; },
      state: stateOf
    };
    return hooks;
  }

  /* ================================================================ export */
  var api = {
    version: 1,
    COMPOUNDS: COMPOUNDS, FUELS: FUELS, FUEL_MAPS: FUEL_MAPS, BRAKE_MATERIALS: BRAKE_MATERIALS,
    PIT_SPEED_LIMIT_KPH: PIT_SPEED_LIMIT_KPH, FUEL_RATE_LPS: FUEL_RATE_LPS, EV_CHARGE_KWPS: EV_CHARGE_KWPS, WHEEL_NAMES: WHEEL_NAMES,
    createCarState: createCarState,
    step: step,
    modifiers: modifiers,
    applyImpact: applyImpact,
    pitStop: pitStop,
    pitTimeEstimate: pitTimeEstimate,
    pitLaneInfo: pitLaneInfo,
    inPitLane: inPitLane,
    suggestStrategy: suggestStrategy,
    simulateLap: simulateLap,
    simulateStint: simulateStint,
    liveAdvice: liveAdvice,
    summary: summary,
    drainEvents: drainEvents,
    setFuelMap: setFuelMap,
    environment: environment,
    compoundInfo: compoundInfo,
    tempGrip: tempGrip,
    wearGrip: wearGrip,
    createHooks: createHooks,
    applyToParams: applyToParams,
    vehicleEnv: vehicleEnv,
    clone: clone,
    _internal: { wheelData: wheelData, syntheticTrack: syntheticTrack, speedProfile: speedProfile, normEnv: normEnv, perLap: perLap, optimalPressure: optimalPressure }
  };
  CB.game.endurance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

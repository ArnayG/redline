/* ==========================================================================
   FORGE Atelier — js/physics.js
   CB.physics : the vehicle dynamics model.  compute(build) -> Metrics (pure, deterministic, < 5 ms, JSON-safe).

   Model overview (SI units inside, unit-suffixed keys outside)
   --------------------------------------------------------------
   ENGINE (ICE)   BMEP-based.  A naturally-aspirated brake-mean-effective-pressure is calibrated from the layout's
                  specific output (hp/L at its typical redline) and shaped by a volumetric-efficiency curve
                  VE(u), u = rpm/redline (peaky NA cam profile, low-rpm diesel profile, high-rpm rotary profile).
                  Forced induction multiplies the charge density: a boost term B·spool(u)·choke(u) on top of the
                  NA BMEP (turbo spool logistic driven by aspiration lag, compressor choke at high rpm,
                  positive-displacement supercharger rising linearly, twin-charging crossover, e-turbo instant spool)
                  and turbo engines get an ECU torque plateau.  Modifiers: Otto efficiency vs compression ratio
                  (γ = 1.3), knock limit (effective CR = CR·√(1+boost) vs fuel knockLimit → ignition retard),
                  fuel power potential, tune & exhaust multipliers (NA engines realise less from a reflash).
                  T(rpm) = BMEP(rpm)·Vd / 4π.
   HYBRID         P2 motor at the crank: constant torque to 2,200 rpm then constant power, battery-discharge limited.
   EV             Constant torque to the base speed (30 % / 36 % of 16,000 rpm for 400 / 800 V), constant power,
                  field-weakening fade above 80 % of max speed, pack discharge (C-rate) limited.
   MASS           Component-by-component curb mass from the catalog (glider ∝ chassis material, engine ∝ displacement,
                  pack mass from Wh/kg, rims/tyres/rotors from their sizes …) with a longitudinal position and a
                  height for every item → weight distribution, CG height, yaw inertia, unsprung mass, breakdown.
   AERO           Cd from body + parts + ride height + tyre width; frontal area; downforce ∝ v² with wing-angle
                  lift curve, ground-effect gain for low ride heights and an aero balance (front share).
   TYRES          Load-sensitive friction μ(Fz) = μ0·(1 − k·(Fz/Fz0 − 1)), Fz0 ∝ tyre width; μ0 from compound ×
                  suspension × camber × chassis stiffness × damping × toe × rim-fit.
   LONGITUDINAL   dt = 0.05 s time-stepped launch: clutch slip / launch control / torque-converter multiplication,
                  turbo transient spool, traction limit (μ·Fz on the driven axle incl. load transfer & downforce,
                  diff lock, traction control, AWD centre-diff coupling), drag ½ρCdAv², rolling resistance,
                  rotating-inertia equivalent mass, optimal shift points and shift-time torque interruption.
   TOP SPEED      Steady-state force balance per gear → 'drag' / 'redline' / 'governor' (tyre speed rating, eco map).
   BRAKING        Tyre-limited vs hydraulic capacity (piston area × line pressure × pad μ × effective radius),
                  ABS/EBD efficiency or bias-limited lock-up with ABS off, aero assistance.
   LATERAL        Steady-state cornering with lateral load transfer split by roll stiffness (springs + ARBs),
                  load-sensitive tyres, downforce at 120 km/h; balance → understeer / oversteer.
   LAP            Point-mass quasi-steady simulation of the fictional 5.8 km 'Redline Ring' on 10 m pieces:
                  corner speed limits, forward acceleration pass, backward braking pass, friction ellipse,
                  shift losses, brake-fade & heat-soak derates.
   ENERGY         Willans-line ICE fuel model (indicated efficiency, FMEP/PMEP friction scaling with displacement
                  & rpm) over a city/suburban/highway cycle; hybrid regen + engine-off; EV Wh/km & range; CO2.

   Also exported: CB.physics.track (Redline Ring definition), CB.physics.downforceAt(metrics, kph), constants.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  /* ======================================================================
     CONSTANTS & SMALL HELPERS
     ====================================================================== */
  var G = 9.81;
  var RHO = 1.225;
  var MPH = 0.44704;           // m/s per mph
  var QUARTER_MILE_M = 402.336;
  var EV_MAX_RPM = 16000;
  var FUEL_TANK_L = 60;
  var DT = 0.05;
  var LHV_GASOLINE_MJ_L = 32.0; // lower heating value of pump gasoline (energyFactor 1.0)
  var KWH_PER_L_GASOLINE_EQ = 8.9;
  var PI = Math.PI;
  // longitudinal peak μ (at optimum slip ratio) vs the quoted lateral peak. Piecewise-linear map (lateral → drive):
  //  * eco / touring / summer tyres (μ ≤ 1.0): μ·1.1 + 0.12, as before;
  //  * summer UHP / supercar OE tyres (μ ≈ 1.05–1.15) put down a little more drive force than that linear map gave;
  //  * Cup / slick compounds (μ ≥ 1.3) are launched cold and are slip-peaky — lowered (−5 % at 1.3, −10 % at 1.5), which
  //    keeps RWD hypercars on Cup tyres from out-launching the AWD ones.
  var LONG_MU = [[0.5, 0.67], [0.9, 1.11], [1.0, 1.22], [1.1, 1.36], [1.2, 1.44], [1.3, 1.48], [1.5, 1.6], [1.8, 1.95], [2.2, 2.38]];
  function longMu(mu) {
    var T = LONG_MU;
    if (mu <= T[0][0]) return mu * 1.1 + 0.12;
    for (var i = 1; i < T.length; i++) if (mu <= T[i][0]) return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * (mu - T[i - 1][0]) / (T[i][0] - T[i - 1][0]);
    return T[T.length - 1][1] + (mu - T[T.length - 1][0]) * 1.08;
  }
  function brakeMu(mu) { return mu * 1.06 + 0.1; }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) {
    if (typeof v === 'number') return isFinite(v) ? v : d;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v;
    return d;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function r(n, d) { if (!isNum(n)) return n; var p = Math.pow(10, d == null ? 0 : d); return Math.round(n * p) / p; }
  function sq(x) { return x * x; }

  function D() { return CB.data || null; }
  function find(coll, id) {
    var d = D();
    if (!d || typeof d.find !== 'function') return undefined;
    return d.find(coll, id);
  }
  function list(coll) {
    var d = D();
    if (!d || typeof d.list !== 'function') return [];
    return d.list(coll) || [];
  }
  /** Catalog option by id, falling back to `fallbackId`, then the first entry, then {}. */
  function opt(coll, id, fallbackId) {
    var o = find(coll, id);
    if (!o && fallbackId != null) o = find(coll, fallbackId);
    if (!o) { var l = list(coll); o = l[0]; }
    return o || {};
  }
  function wOf(o) { return o && isNum(o.weight_kg) ? o.weight_kg : 0; }

  function isPlainObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function mergeInto(base, src) {
    if (!isPlainObj(src)) return base;
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (isPlainObj(v) && isPlainObj(base[k])) base[k] = mergeInto(base[k], v);
      else if (v !== undefined) base[k] = Array.isArray(v) ? v.slice() : v;
    });
    return base;
  }
  /** Fill any missing fields of the build with the default build so partial builds are always computable. */
  function complete(build) {
    var d = D(), base = null;
    try { if (d && typeof d.defaultBuild === 'function') base = d.defaultBuild(); } catch (e) { base = null; }
    if (!base) base = {};
    ['body', 'engine', 'transmission', 'drivetrain', 'suspension', 'brakes', 'wheels', 'tires', 'aero', 'weight', 'exterior', 'interior', 'tech']
      .forEach(function (k) { if (!isPlainObj(base[k])) base[k] = {}; });
    return mergeInto(base, isPlainObj(build) ? build : {});
  }

  /** Recursively replaces NaN / ±Infinity by null so the metrics are always JSON-safe & finite. */
  function sanitize(o) {
    if (typeof o === 'number') return isFinite(o) ? o : null;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) o[i] = sanitize(o[i]); return o; }
    if (o && typeof o === 'object') { for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) o[k] = sanitize(o[k]); }
    return o;
  }

  /* Nominal ride height (mm) at which bodyStyles[].cgHeight_mm is quoted. */
  var NOMINAL_RIDE = { coupe: 120, sedan: 130, hatchback: 130, wagon: 135, suv: 200, roadster: 115, pickup: 230, hypercar: 95, 'shooting-brake': 120, van: 160 };
  /* Tyre speed ratings (km/h) by compound (tires.speedRating 'compound'; an explicit rating overrides it). */
  var TYRE_SPEED_RATING = { eco: 210, 'all-season': 210, winter: 240, touring: 270, performance: 300, 'super-sport': 360, track: 300, slick: 420 };
  /* Sound character bonus by layout sound profile. */
  var SOUND_CHARACTER = {
    'thrum-triple': 0.35, 'rasp-four': 0.4, 'warble-five': 0.75, 'silk-six': 0.7, 'snarl-v6': 0.6, 'burble-v8': 0.85,
    'shriek-v10': 0.97, 'aria-v12': 1.0, 'thunder-w16': 0.8, 'rumble-boxer': 0.65, 'howl-flat6': 0.95, 'brap-rotary': 0.9
  };

  /* ======================================================================
     THE REDLINE RING — fictional 5.8 km circuit
     Each segment: { name, len (m), radius (m, 0 = straight), sector }
     ====================================================================== */
  var TRACK_SEGMENTS = [
    { name: 'Pit Straight', len: 820, radius: 0, sector: 0 },
    { name: 'T1 Redline Hairpin', len: 75, radius: 24, sector: 0 },
    { name: 'Hairpin exit', len: 260, radius: 0, sector: 0 },
    { name: 'T2 Fonderia', len: 130, radius: 110, sector: 0 },
    { name: 'T3 Fonderia II', len: 140, radius: 130, sector: 0 },
    { name: 'Redline Rise', len: 380, radius: 0, sector: 0 },
    { name: 'T4 Anvil', len: 115, radius: 58, sector: 0 },
    { name: 'Anvil exit', len: 180, radius: 0, sector: 0 },
    { name: 'T5 Bellows Sweep', len: 420, radius: 260, sector: 1 },
    { name: 'Crucible Straight', len: 620, radius: 0, sector: 1 },
    { name: 'T6 Tongs Chicane L', len: 45, radius: 28, sector: 1 },
    { name: 'T7 Tongs Chicane R', len: 45, radius: 28, sector: 1 },
    { name: 'Quench Run', len: 340, radius: 0, sector: 1 },
    { name: 'T8 Temper', len: 160, radius: 82, sector: 1 },
    { name: 'Temper exit', len: 120, radius: 0, sector: 1 },
    { name: 'T9 Carousel', len: 230, radius: 46, sector: 1 },
    { name: 'Back Straight', len: 760, radius: 0, sector: 2 },
    { name: 'T10 Ingot', len: 190, radius: 150, sector: 2 },
    { name: 'T11 Hammer', len: 90, radius: 38, sector: 2 },
    { name: 'Hammer exit', len: 290, radius: 0, sector: 2 },
    { name: 'T12 Final Bend', len: 200, radius: 92, sector: 2 },
    { name: 'Finish Straight', len: 0, radius: 0, sector: 2 }   // sized so the lap is exactly 5,800 m
  ];
  (function closeLap() {
    var s = 0;
    for (var i = 0; i < TRACK_SEGMENTS.length - 1; i++) s += TRACK_SEGMENTS[i].len;
    TRACK_SEGMENTS[TRACK_SEGMENTS.length - 1].len = Math.max(50, 5800 - s);
  })();
  var PIECE_M = 10;
  var TRACK_PIECES = (function () {
    var out = [];
    TRACK_SEGMENTS.forEach(function (sg, si) {
      var n = Math.max(1, Math.round(sg.len / PIECE_M)), L = sg.len / n;
      for (var i = 0; i < n; i++) out.push({ len: L, radius: sg.radius, sector: sg.sector, seg: si });
    });
    return out;
  })();

  /* ======================================================================
     ENGINE MODEL
     ====================================================================== */

  /** Naturally-aspirated volumetric-efficiency shape VE(u), u = rpm / redline, peak 1.0 at uT. */
  function veShape(u, uT, lowDrop, highDrop, highExp) {
    if (u <= uT) {
      var t = clamp((uT - u) / Math.max(0.05, uT - 0.08), 0, 1.2);
      return Math.max(0.2, 1 - lowDrop * Math.pow(t, 1.6));
    }
    var s = (u - uT) / Math.max(0.05, 1 - uT);
    return Math.max(0.2, 1 - highDrop * Math.pow(s, highExp));
  }

  function engineModel(b) {
    var e = b.engine || {};
    var type = e.type === 'ev' || e.type === 'hybrid' ? e.type : 'ice';
    var M = { type: type, warnings: [] };

    if (type === 'ev') return evModel(b, M);

    var lay = opt('engineLayouts', e.layout, 'V8');
    var asp = opt('aspirations', e.aspiration, 'na');
    var fuel = opt('fuels', e.fuel, 'premium');
    var tune = opt('tunes', e.tune, 'stock');
    var exh = opt('exhausts', e.exhaust, 'stock');
    var cool = opt('coolings', e.cooling, 'standard');
    var range = Array.isArray(lay.displacementRange) ? lay.displacementRange : [1.0, 8.0];
    var V = clamp(num(e.displacement_l, (range[0] + range[1]) / 2), range[0], range[1]);
    var isDiesel = fuel.id === 'diesel';
    var isRotary = lay.config === 'rotary';
    var typR = num(lay.typicalRedline, 7000);
    var R = clamp(num(e.redline_rpm, typR), 3000, 11000);
    if (isDiesel) R = Math.min(R, num(fuel.redlineCap_rpm, 5200));
    var idle = isDiesel ? 750 : isRotary ? 900 : R > 8600 ? 1000 : 850;
    var aspId = asp.id || 'na';
    var boosted = aspId !== 'na';
    var maxB = num(asp.maxBoost_bar, 3);
    var boost = boosted ? clamp(num(e.boost_bar, num(asp.typicalBoost_bar, 1)), 0, Math.max(0, maxB)) : 0;
    var typB = num(asp.typicalBoost_bar, 1);
    var CR = clamp(num(e.compression, 10), 6, 23);
    var ecr = CR * Math.sqrt(1 + boost);
    var knockLimit = num(fuel.knockLimit, 15.5);
    var over = isDiesel ? 0 : Math.max(0, ecr - knockLimit);
    var knockF = over > 0 ? Math.max(0.6, 1 - 0.05 * over - 0.012 * over * over) : (knockLimit - ecr < 0.4 && !isDiesel ? 0.99 : 1);
    var crRef = boosted ? 9.5 : 12.0; // compression the layout's quoted specific output assumes
    var etaR = isDiesel ? 1 : (1 - Math.pow(CR, -0.3)) / (1 - Math.pow(crRef, -0.3));
    var pot = num(fuel.powerPotential, 1);
    var fuelF = isDiesel ? pot : boosted ? pot : 1 + (pot - 1) * 0.5;
    var pm = num(tune.powerMult, 1);
    var tuneF = pm < 1 ? pm : boosted || isDiesel ? pm : 1 + (pm - 1) * 0.45;
    var exhF = num(exh.powerMult, 1);
    var cyl = num(lay.cylinders, 6);
    // bigger bores breathe & burn less efficiently per litre (flame travel, piston speed at a given rpm)
    var cylDisp = V / Math.max(1, cyl);
    var hpPerL = num(lay.specificOutputNA_hpPerL, 95) * (isRotary ? 1 : clamp(Math.pow(0.55 / cylDisp, 0.2), 0.85, 1.12));

    // --- NA volumetric-efficiency profile
    var uT, lowDrop, highDrop, highExp;
    if (isDiesel) { uT = 0.42; lowDrop = 0.42; highDrop = 0.38; highExp = 1.7; }
    else if (isRotary) { uT = 0.80; lowDrop = 0.45; highDrop = 0.16; highExp = 2.0; }
    else {
      uT = clamp(0.64 + 0.0016 * (hpPerL - 95) + (R - typR) / 40000, 0.58, 0.8);
      lowDrop = clamp(0.32 + 0.002 * (hpPerL - 95), 0.25, 0.45);
      highDrop = 0.2; highExp = 1.8;
    }
    if (boosted) { uT = clamp(uT - 0.06, 0.45, 0.8); } // turbo engines use milder cams
    // calibrate the BMEP so that the NA engine at its typical redline makes hpPerL·V
    var k = 0;
    for (var cu = 0.3; cu <= 1.0001; cu += 0.01) k = Math.max(k, veShape(cu, uT, lowDrop, highDrop, highExp) * cu);
    var P_ref = hpPerL * V * 745.7;                                  // W
    var bmep0 = P_ref * 120 / (V * 1e-3 * k * typR);                  // Pa (peak NA BMEP at VE = 1)
    var bmepNA = bmep0 * Math.pow(typR / R, 0.25) * fuelF * etaR * knockF * tuneF * exhF;

    // --- forced induction
    var lag = clamp(num(asp.lag, 0), 0, 1);
    var B = 0;
    if (boosted && typB > 0) {
      B = (num(asp.powerMult, 1.35) - 1) * Math.pow(boost / typB, 0.9) * (aspId === 'supercharged' ? 0.92 : 1.2); // blower: crank-driven parasitic loss
      if (isDiesel) B *= 1.4;
    }
    var uS = clamp((0.2 + 0.36 * lag + 0.015 * (boost - 1.2)) * clamp(Math.pow(3 / Math.max(V, 1), 0.12), 0.85, 1.15), 0.12, 0.7);
    if (isDiesel) uS = clamp(uS + 0.06, 0.2, 0.6);
    var chokeK = aspId === 'turbo' ? 0.45 : aspId === 'twin-turbo' ? 0.38 : aspId === 'quad-turbo' ? 0.3 : aspId === 'electric-turbo' ? 0.32 : aspId === 'twincharged' ? 0.36 : 0.0;
    function turboSpool(u) { return smoothstep((u - 0.45 * uS) / (0.55 * uS)); }
    function choke(u) { return u > 0.7 ? 1 - chokeK * sq((u - 0.7) / 0.3) : 1; }
    function spool(u) {
      if (!boosted || B <= 0) return 0;
      if (aspId === 'supercharged') return 0.55 + 0.45 * u;
      if (aspId === 'twincharged') return Math.max(0.8 * smoothstep(u / 0.15) * (u < 0.5 ? 1 : Math.max(0, 1 - (u - 0.5) * 2)), turboSpool(u) * choke(u));
      return turboSpool(u) * choke(u);
    }
    var tau = aspId === 'supercharged' ? 0.03 : boosted ? 0.15 + lag * 1.6 : 0;
    if (tune.id === 'time-attack' && boosted && aspId !== 'supercharged') tau *= 0.35; // anti-lag

    // --- hybrid motor at the crank (P2)
    var hybridKw = 0, hybMotorKw = 0, battLimitKw = 0;
    if (type === 'hybrid') {
      var chem = opt('batteryChemistries', e.chemistry, 'nmc');
      var nm = clamp(Math.round(num(e.motors, 1)), 1, 3);
      hybMotorKw = nm * clamp(num(e.motorPower_kw, 100), 10, 500);
      var kwh = clamp(num(e.battery_kwh, 10), 0.5, 40);
      battLimitKw = kwh * num(chem.cRate, 4) * 6 * 0.95;
      hybridKw = Math.min(hybMotorKw, battLimitKw);
      if (battLimitKw < hybMotorKw * 0.98) M.warnings.push('Hybrid battery can only deliver ' + Math.round(battLimitKw) + ' kW — motor output is battery-limited');
    }
    var hybBaseRpm = 3000;

    // --- tables at 50 rpm resolution
    var STEP = 50, n = Math.ceil(R / STEP) + 1;
    var Tna = new Array(n), Tb = new Array(n), Tm = new Array(n);
    var dispK = V * 1e-3 / (4 * PI);
    var maxRaw = 0;
    for (var i = 0; i < n; i++) {
      var rpm = Math.min(R, i * STEP), u = rpm / R;
      var ve = veShape(u, uT, lowDrop, highDrop, highExp);
      if (rpm < idle) ve *= lerp(0.7, 1, rpm / idle); // below idle: stall region
      Tna[i] = bmepNA * ve * dispK;
      Tb[i] = Tna[i] * B * spool(u);
      Tm[i] = hybridKw > 0 ? (rpm <= hybBaseRpm ? hybridKw * 1000 / (hybBaseRpm * PI / 30) : hybridKw * 1000 / (rpm * PI / 30)) : 0;
      maxRaw = Math.max(maxRaw, Tna[i] + Tb[i]);
    }
    var plateau = boosted && aspId !== 'supercharged';
    var cap = plateau ? maxRaw * 0.95 : Infinity;
    // torque-based ECU boost control: below ~70 % of the rev range the wastegate is held shut beyond the nominal
    // boost target (compressor headroom) wherever the cam's VE is low, so the torque plateau starts as soon as the
    // turbine has spooled — quick-spooling systems (twin-scroll, e-turbo) therefore reach peak torque earlier.
    var Th = new Array(n);
    for (var hi = 0; hi < n; hi++) Th[hi] = plateau ? 1 + 0.35 * (1 - smoothstep((Math.min(R, hi * STEP) / R - 0.35) / 0.35)) : 1;

    function iceTorque(rpm, bs) {
      var x = clamp(rpm, 0, R) / STEP, i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
      var tn = Tna[i0] + (Tna[i1] - Tna[i0]) * f, tb = Tb[i0] * Th[i0] + (Tb[i1] * Th[i1] - Tb[i0] * Th[i0]) * f;
      return Math.min(cap, tn + tb * (bs == null ? 1 : bs));
    }
    function motorTorque(rpm) {
      if (hybridKw <= 0) return 0;
      var x = clamp(rpm, 0, R) / STEP, i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
      return Tm[i0] + (Tm[i1] - Tm[i0]) * f;
    }
    function torque(rpm, bs) { return iceTorque(rpm, bs) + motorTorque(rpm); }

    M.R = R; M.idle = idle; M.V = V; M.lay = lay; M.asp = asp; M.fuel = fuel; M.tune = tune; M.exh = exh; M.cool = cool;
    M.boost = boost; M.CR = CR; M.ecr = ecr; M.knockLimit = knockLimit; M.knockOver = over; M.knockF = knockF;
    M.isDiesel = isDiesel; M.boosted = boosted; M.tau = tau; M.lag = lag; M.torque = torque; M.iceTorque = iceTorque;
    M.motorTorque = motorTorque; M.hybridKw = hybridKw; M.hybMotorKw = hybMotorKw; M.battLimitKw = battLimitKw;
    M.cyl = cyl; M.inertia = 0.08 + 0.045 * V + (isRotary ? -0.03 : 0); // flywheel + crank + clutch (kg m²)
    M.bmepPeak_bar = 0; M.uT = uT;
    finishCurve(M);
    // BMEP at peak torque (ICE only)
    var iceMax = 0;
    for (var j = 0; j < n; j++) iceMax = Math.max(iceMax, iceTorque(j * STEP, 1));
    M.bmepPeak_bar = iceMax / dispK / 1e5;
    M.icePower_kw = 0;
    for (var q = 0; q < n; q++) { var rq = Math.min(R, q * STEP); M.icePower_kw = Math.max(M.icePower_kw, iceTorque(rq, 1) * rq * PI / 30 / 1000); }
    M.coolingCapacity_kw = 520 * num(cool.heatCapacity, 1); // ICE shaft kW the cooling pack can sustain on track
    return M;
  }

  function evModel(b, M) {
    var e = b.engine || {};
    var chem = opt('batteryChemistries', e.chemistry, 'nmc');
    var motors = clamp(Math.round(num(e.motors, 2)), 1, 4);
    var perKw = clamp(num(e.motorPower_kw, 200), 20, 600);
    var kwh = clamp(num(e.battery_kwh, 85), 10, 250);
    var volt = num(e.voltage, 400) >= 600 ? 800 : 400;
    var motorKw = motors * perKw;
    var battKw = kwh * num(chem.cRate, 4) * 2.5;
    var Pkw = Math.min(motorKw, battKw);
    if (battKw < motorKw * 0.98) M.warnings.push('Battery discharge limit (' + Math.round(battKw) + ' kW at ' + num(chem.cRate, 4) + 'C) caps the ' + Math.round(motorKw) + ' kW of motors — add capacity or a higher-power chemistry');
    var R = EV_MAX_RPM, base = R * (volt === 800 ? 0.36 : 0.30);
    var P = Pkw * 1000, Tmax = P / (base * PI / 30);
    function torque(rpm) {
      rpm = clamp(rpm, 0, R);
      if (rpm <= base) return Tmax;
      var t = P / (rpm * PI / 30);
      if (rpm > 0.8 * R) t *= 1 - 0.15 * (rpm - 0.8 * R) / (0.2 * R);
      return t;
    }
    M.R = R; M.idle = 0; M.V = 0; M.torque = torque; M.iceTorque = torque; M.motorTorque = function () { return 0; };
    M.tau = 0; M.lag = 0; M.boosted = false; M.isDiesel = false; M.boost = 0; M.chem = chem; M.motors = motors; M.perKw = perKw;
    M.kwh = kwh; M.volt = volt; M.motorKw = motorKw; M.battKw = battKw; M.baseRpm = base; M.inertia = 0.035 * motors;
    M.coolingCapacity_kw = 1e9; M.knockOver = 0; M.knockF = 1; M.cyl = 0;
    M.exh = opt('exhausts', 'stock'); M.tune = opt('tunes', 'stock'); M.cool = opt('coolings', e.cooling, 'standard');
    finishCurve(M);
    M.icePower_kw = 0; M.hybridKw = 0;
    return M;
  }

  /** Builds the published 250-rpm curve and finds peaks on a 25-rpm scan. */
  function finishCurve(M) {
    var R = M.R, idle = M.idle, curve = [];
    for (var rpm = idle; rpm < R - 1e-6; rpm += 250) curve.push(curvePoint(M, rpm));
    curve.push(curvePoint(M, R));
    var pMax = 0, tMax = 0, pRpm = R, tRpm = idle;
    for (var s = Math.max(idle, 0); s <= R; s += 25) {
      var t = M.torque(s, 1), p = t * s * PI / 30;
      if (p > pMax + 1e-9) { pMax = p; pRpm = s; }
      if (t > tMax * 1.0005) { tMax = t; tRpm = s; }
    }
    M.curve = curve; M.peakPower_w = pMax; M.peakPowerRpm = pRpm; M.peakTorque = tMax; M.peakTorqueRpm = tRpm;
    // rpm of peak power for CVT target / launch
    M.launchRpm = M.type === 'ev' ? 0 : clamp(M.boosted ? Math.max(tRpm * 0.85, R * 0.45) : Math.max(tRpm * 0.8, R * 0.5), idle + 500, R * 0.8);
  }
  function curvePoint(M, rpm) {
    var nm = M.torque(rpm, 1);
    return { rpm: Math.round(rpm), hp: r(nm * rpm * PI / 30 / 745.7, 1), nm: r(nm, 1) };
  }

  /* ======================================================================
     MASS MODEL — every component with longitudinal position x (fraction of wheelbase from the front axle,
     0 = front axle, 1 = rear axle) and CG height z (mm).
     ====================================================================== */
  function massModel(b, E, geo) {
    var parts = [];
    var cats = {};
    var unsprung = { front: 0, rear: 0 };
    function add(cat, kg, x, z) {
      if (!isNum(kg) || kg === 0) return;
      parts.push({ cat: cat, kg: kg, x: x, z: z });
      cats[cat] = (cats[cat] || 0) + kg;
    }
    var e = b.engine, body = b.body, w8 = b.weight, dl = b.drivetrain.layout;
    var bs = geo.bs, wb = geo.wb, dz = geo.dz;
    var cm = opt('chassisMaterials', body.chassisMaterial, 'steel');
    var svg = bs.svg || {};
    var len = num(svg.length_mm, wb + 1850) + (wb - num(bs.defaultWheelbase, wb));
    var fo = num(svg.frontOverhang_mm, 920);
    var xBody = clamp((len / 2 - fo) / wb + 0.03, 0.35, 0.68); // boot floor, rear subframe & bumper beam sit aft
    var height = num(svg.height_mm, 1350);
    var baseW = num(bs.baseWeight_kg, 1450);
    var cgBody = num(bs.cgHeight_mm, 500);

    /* --- body / glider (BIW scales with chassis material; closures, glass, wiring, HVAC do not). Both scale with the
       real model's size (shell area vs the style's nominal car) and the construction (gauge / insulation / armour). */
    var gF = num(geo.scale && geo.scale.mass, 1) * clamp(num(geo.con && geo.con.weightFactor, 1), 0.5, 2);
    var structure = baseW * 0.29 * num(cm.weightFactor, 1) * gF;
    var closures = baseW * 0.35 * gF;
    add('body', structure, xBody, cgBody + 40 + dz);
    add('body', closures, xBody, cgBody + 120 + dz);
    add('body', (wb - num(bs.defaultWheelbase, wb)) * 0.22, 0.5, cgBody + dz);
    add('body', (num(body.trackWidth_mm, 1600) - 1600) * 0.09, 0.5, cgBody + dz);
    var doorOpts = Array.isArray(bs.doorOptions) && bs.doorOptions.length ? bs.doorOptions : [2];
    var seatOpts = Array.isArray(bs.seatOptions) && bs.seatOptions.length ? bs.seatOptions : [2];
    add('body', (num(body.doors, doorOpts[0]) - Math.min.apply(null, doorOpts)) * 11, 0.45, cgBody + 80 + dz);
    var seats = num(body.seats, seatOpts[0]);
    add('interior', (seats - Math.min.apply(null, seatOpts)) * 14, 0.75, 480 + dz);

    /* --- powertrain */
    var ePos = e.position === 'mid' || e.position === 'rear' ? e.position : 'front';
    if (E.type === 'ev') ePos = e.position === 'front' ? 'front' : e.position === 'mid' ? 'mid' : 'rear';
    var transverse = ePos === 'front' && dl === 'fwd';
    if (E.type !== 'ev') {
      var lay = E.lay, rg = Array.isArray(lay.displacementRange) ? lay.displacementRange : [E.V, E.V];
      var t = rg[1] > rg[0] ? (E.V - rg[0]) / (rg[1] - rg[0]) : 0.5;
      var engKg = num(lay.baseWeight_kg, 180) * (0.9 + 0.2 * t) + (E.isDiesel ? 25 + E.V * 8 : 0);
      var engLen = num(lay.length_mm, 600);
      var xe = ePos === 'mid' ? 1 - (engLen / 2 + 120) / wb : ePos === 'rear' ? 1 + (engLen / 2 - 150) / wb : transverse ? -0.05 : 0.12 - (engLen - 500) / wb * 0.25; // front-mid: block behind the axle line
      var ze = (lay.config === 'flat' ? 360 : lay.config === 'rotary' ? 380 : lay.config === 'inline' ? 480 : 455) + dz;
      add('engine', engKg, xe, ze);
      add('engine', wOf(E.asp) + (E.boosted ? 9 : 0), xe + (ePos === 'front' ? -0.03 : 0.03), ze + 60);  // turbos/blower + intercooler
      add('engine', 16, xe, ze);                                     // alternator, starter, ECU, mounts
      var cool = E.cool, coolX = ePos === 'front' ? -0.22 : (ePos === 'mid' ? 0.72 : 1.18);
      add('engine', 14 + num(E.V, 2) * 2.2 + wOf(cool), coolX, 420 + dz); // radiator, coolant, oil
      add('engine', 22 + num(E.cyl, 4) * 0.8 + wOf(E.exh), ePos === 'front' ? 0.62 : 1.12, 300 + dz);  // exhaust & cats
      var dens = E.fuel.id === 'diesel' ? 0.84 : E.fuel.id === 'e85' ? 0.785 : E.fuel.id === 'race' ? 0.72 : 0.745;
      add('fuel', FUEL_TANK_L * dens + 9, ePos === 'mid' ? 0.45 : 0.72, 330 + dz);
    } else {
      add('fuel', 8, 0.2, 500 + dz); // coolant, washer, brake fluid
    }
    if (E.type === 'ev' || E.type === 'hybrid') {
      var chem = opt('batteryChemistries', e.chemistry, 'nmc');
      var whkg = num(chem.whPerKg, 180);
      var kwh = E.type === 'ev' ? E.kwh : clamp(num(e.battery_kwh, 10), 0.5, 40);
      var packKg = kwh * 1000 / whkg * (E.type === 'ev' ? 1.0 : 1.45) + (E.type === 'ev' ? 28 : 12);
      add('battery', packKg, E.type === 'ev' ? 0.5 : (ePos === 'mid' ? 0.42 : 0.74), (E.type === 'ev' ? 330 : 430) + dz * 0.9);
      var nMot = E.type === 'ev' ? E.motors : clamp(Math.round(num(e.motors, 1)), 1, 3);
      var per = E.type === 'ev' ? E.perKw : clamp(num(e.motorPower_kw, 100), 10, 500);
      var motKg = 24 + per * 0.17; // motor + inverter
      var split = num(b.drivetrain.torqueSplitFront_pct, dl === 'fwd' ? 100 : 0) / 100;
      var nFront = dl === 'fwd' ? nMot : dl === 'rwd' ? 0 : (nMot >= 2 ? clamp(Math.round(nMot * split), 1, nMot - 1) : 0);
      if (E.type === 'hybrid') {
        // P2 motor sits at the gearbox bell-housing; further motors on an AWD car form a front e-axle (one per wheel
        // with three motors, SF90 / NSX style)
        var xP2 = ePos === 'mid' ? 0.95 : ePos === 'rear' ? 0.9 : transverse ? 0.0 : 0.22;
        add('motors', motKg, xP2, 380 + dz);
        for (var hm = 1; hm < nMot; hm++) add('motors', motKg, dl === 'awd' ? 0.0 : xP2, 350 + dz);
        add('motors', 14, 0.5, 400 + dz); // power electronics, HV cabling
        if (dl === 'awd' && nMot > 1) unsprung.front += 0;
      } else {
        for (var mi = 0; mi < nMot; mi++) add('motors', motKg, mi < nFront ? 0.0 : 1.0, 360 + dz);
        add('motors', 12 + nMot * 3, 0.5, 380 + dz);
      }
    }
    /* --- transmission & driveline */
    var tr = opt('transmissions', b.transmission.type, 'dct');
    var trKg = num(tr.weight_kg, 70);
    var xT = transverse ? -0.02 : ePos === 'mid' ? 1.04 : ePos === 'rear' ? 0.92 : (dl === 'fwd' ? 0.0 : 0.3);
    if (E.type === 'ev') {
      var axles = dl === 'awd' ? 2 : 1;
      if (dl !== 'rwd') add('driveline', trKg * (dl === 'awd' ? 0.5 : 1), 0.0, 360 + dz);
      if (dl !== 'fwd') add('driveline', trKg * (dl === 'awd' ? 0.5 : 1), 1.0, 360 + dz);
      add('driveline', 9 * axles, 0.5, 350 + dz); // half-shafts
    } else {
      add('driveline', trKg, xT, 400 + dz);
      if (ePos === 'front' && dl !== 'fwd') add('driveline', 14, 0.55, 330 + dz); // propshaft
      if (dl !== 'fwd' && !(ePos !== 'front')) add('driveline', 26, 1.0, 360 + dz); // rear final drive
      if (dl !== 'rwd' && ePos !== 'front') add('driveline', 22, 0.0, 360 + dz);
      add('driveline', 12, dl === 'fwd' ? 0 : 1, 330 + dz); // half-shafts
    }
    if (dl === 'awd') add('driveline', num(opt('drivetrainLayouts', 'awd').weight_kg, 70) * (E.type === 'ev' ? 0.25 : 1), ePos === 'front' ? 0.2 : 0.35, 360 + dz);
    ['frontDiff', 'rearDiff', 'centerDiff'].forEach(function (k, i) {
      add('driveline', wOf(opt('differentials', b.drivetrain[k], 'open')), i === 0 ? 0 : i === 1 ? 1 : 0.5, 350 + dz);
    });
    if (b.drivetrain.torqueVectoring) add('driveline', num(geo.ow.torqueVectoring, 8), 1, 350 + dz);

    /* --- suspension (half unsprung) */
    var st = opt('suspensionTypes', b.suspension.type, 'multilink');
    var corner = 15 + (geo.mass0 > 1900 ? 4 : 0);
    var arb = (num(b.suspension.arbFront, 5) + num(b.suspension.arbRear, 5)) * 0.35;
    [0, 1].forEach(function (ax) {
      var kg = 2 * corner + wOf(st) / 2 + arb / 2;
      add('suspension', kg, ax, 330 + dz * 0.5);
      if (ax === 0) unsprung.front += kg * 0.5; else unsprung.rear += kg * 0.5;
    });

    /* --- wheels & tyres */
    var wm = opt('wheelMaterials', b.wheels.material, 'cast');
    var d = clamp(num(b.wheels.diameter_in, 19), 13, 24);
    var comp = geo.comp;
    var tyreF = comp.id === 'slick' ? 0.85 : comp.id === 'winter' ? 1.05 : comp.id === 'all-season' ? 1.12 : comp.id === 'track' ? 0.93 : 1;
    function rimKg(wIn) { return (5.0 + 0.55 * (d - 15) + 0.6 * clamp(num(wIn, 8.5), 5, 14)) * num(wm.weightFactor, 1); }
    function tyreKg(wmm, rad) { return PI * 2 * rad * (wmm / 1000) * 20.5 * tyreF; }
    var wF = rimKg(b.wheels.widthFront_in) + tyreKg(geo.twF, geo.rF), wR = rimKg(b.wheels.widthRear_in) + tyreKg(geo.twR, geo.rR);
    add('wheels', 2 * wF, 0, geo.rF * 1000);
    add('wheels', 2 * wR, 1, geo.rR * 1000);
    if (w8.spareTire) add('wheels', num(geo.ow.spareTire, 18), 1.15, 360 + dz);
    unsprung.front += 2 * wF; unsprung.rear += 2 * wR;

    /* --- brakes */
    var bm = opt('brakeMaterials', b.brakes.material, 'iron');
    var rotor = num(bm.weightPerRotor_kg, 11);
    var rf = sq(clamp(num(b.brakes.frontRotor_mm, 360), 240, 460) / 360) * rotor, rr = sq(clamp(num(b.brakes.rearRotor_mm, 330), 240, 460) / 360) * rotor;
    var cf = 1.6 + 0.45 * num(b.brakes.frontPistons, 4), cr = 1.6 + 0.45 * num(b.brakes.rearPistons, 2);
    add('brakes', 2 * (rf + cf), 0, geo.rF * 1000);
    add('brakes', 2 * (rr + cr), 1, geo.rR * 1000);
    add('brakes', 7, -0.1, 650 + dz); // booster, ABS/ESC unit, lines
    unsprung.front += 2 * (rf + cf); unsprung.rear += 2 * (rr + cr);
    geo.rotorKgF = rf; geo.rotorKgR = rr;

    /* --- aero */
    var a = b.aero || {};
    add('aero', wOf(opt('aero.splitters', a.splitter, 'none')), -0.34, 160 + dz);
    add('aero', wOf(opt('aero.wings', a.wing, 'none')), 1.27, height + 120 + dz);
    add('aero', wOf(opt('aero.diffusers', a.diffuser, 'none')), 1.22, 260 + dz);
    if (a.canards) add('aero', num(geo.ow.canards, 1.5), -0.3, 300 + dz);
    if (a.sideSkirts) add('aero', num(geo.ow.sideSkirts, 4), 0.5, 200 + dz);
    if (a.activeAero) add('aero', num(geo.ow.activeAero, 12), 0.6, 300 + dz);

    /* --- interior & tech */
    var it = b.interior || {}, tc = b.tech || {}, ex = b.exterior || {};
    add('interior', wOf(opt('seatTypes', it.seatType, 'sport')), 0.45, 480 + dz);
    add('interior', wOf(opt('upholsteries', it.upholstery, 'leather')), 0.5, 520 + dz);
    add('interior', wOf(opt('trims', it.trim, 'aluminum')), 0.35, 650 + dz);
    add('interior', wOf(opt('audioSystems', tc.audio, 'standard')), 0.5, 450 + dz);
    add('interior', wOf(opt('adasLevels', tc.adas, 'assist')), 0.1, 800 + dz);
    add('interior', wOf(opt('screenSizes', tc.screen_in, 12)), 0.3, 800 + dz);
    if (seats > 2 && w8.rearSeats === false) add('interior', -num(geo.ow.rearSeats, 28) * Math.min(1, (seats - 2) / 2), 0.75, 480 + dz);
    if (w8.soundDeadening === false) add('interior', -num(geo.ow.soundDeadening, 22), 0.5, 400 + dz);
    if (it.harness) add('safety', num(geo.ow.harness, 2), 0.45, 600 + dz);
    if (tc.hud) add('interior', num(geo.ow.hud, 1), 0.3, 800 + dz);
    if (tc.telemetry) add('interior', num(geo.ow.telemetry, 1.5), 0.5, 600 + dz);
    if (tc.liftSystem) add('suspension', num(geo.ow.liftSystem, 9), 0.0, 300 + dz);
    if (tc.nightVision) add('interior', num(geo.ow.nightVision, 2), -0.3, 500 + dz);
    if (it.ambientLighting) add('interior', num(geo.ow.ambientLighting, 0.5), 0.5, 700 + dz);
    add('interior', (clamp(num(tc.climateZones, 2), 1, 4) - 1) * num(geo.ow.perClimateZone, 2), 0.5, 600 + dz);

    /* --- weight-saving / safety options */
    add('body', wOf(opt('glassTypes', w8.glass, 'standard')), 0.5, height * 0.8 + dz);
    add('other', 18 + wOf(opt('batteryTypes', w8.battery, 'lead')), ePos === 'front' && E.type !== 'ev' ? -0.12 : 0.0, 450 + dz);
    add('safety', wOf(opt('rollCages', w8.rollCage, 'none')), 0.55, cgBody + 300 + dz);
    var ballast = clamp(num(w8.ballast_kg, 0), 0, 200);
    if (ballast > 0) add('ballast', ballast, w8.ballastPosition === 'front' ? -0.12 : w8.ballastPosition === 'rear' ? 1.05 : 0.42, 220 + dz);
    add('body', wOf(opt('roofTypes', ex.roof, 'body')), 0.55, height + dz);
    add('body', wOf(opt('lightTypes', ex.lights, 'led')), -0.3, 650 + dz);
    add('body', wOf(opt('mirrorTypes', ex.mirrors, 'body')), 0.25, 950 + dz);

    /* --- totals */
    var m = 0, mx = 0, mz = 0;
    parts.forEach(function (p) { m += p.kg; mx += p.kg * p.x; mz += p.kg * p.z; });
    m = Math.max(400, m);
    var xcg = clamp(mx / m, 0.2, 0.8);
    var cgH = clamp(mz / m, 250, 1100);
    var Iz = 0;
    parts.forEach(function (p) { Iz += p.kg * sq((p.x - xcg) * wb / 1000); });
    Iz += (structure + closures) * (sq(len / 1000) + sq(num(svg.width_mm, 1900) / 1000)) / 12 * 0.35; // distributed body
    var breakdown = {};
    Object.keys(cats).forEach(function (k) { breakdown[k] = r(cats[k], 1); });
    return {
      mass: m, xcg: xcg, wf: 1 - xcg, cgH: cgH, Iz: Iz, breakdown: breakdown, unsprung: unsprung,
      len: len, height: height, ePos: ePos
    };
  }

  /* ======================================================================
     GEOMETRY, TYRES, AERO
     ====================================================================== */
  /** Reference figures of the real car a build names (CB.data.modelRefs[body.model]: length / width / height m, Cd,
   *  kerb kg — a copy of the CB.shapes model refs, so the physics never depends on CB.shapes being loaded). null for a
   *  generic style car (body.model null), an unknown id or a model of another body style. */
  function modelRef(b) {
    if (!b.body || b.body.modelPhysics !== true) return null;   // opt-in (Body → Model "Real-car mass & aero"; stock specs)
    var d = D(), id = b.body && b.body.model, t = d && d.modelRefs && typeof id === 'string' && Object.prototype.hasOwnProperty.call(d.modelRefs, id) ? d.modelRefs[id] : null;
    if (!Array.isArray(t) || t[0] !== b.body.style) return null;
    return { length: t[1], width: t[2], height: t[3], cd: t[4], curbWeight_kg: t[5] };
  }

  /** Model-size scale factors vs the body style's nominal (svg) car: shell area → glider mass (×0.85..1.2),
   *  width·height → frontal area (×0.85..1.45), the real car's Cd blended half-way into the style's. All 1 / style Cd
   *  without a real model or with body.modelPhysics off (the default, so builds saved before it keep their physics). */
  function modelScale(bs, ref) {
    var out = { mass: 1, area: 1, cd: num(bs.cd, 0.32) };
    var sv = bs.svg || {};
    if (!ref || !isNum(ref.length) || !isNum(ref.width) || !isNum(ref.height)) return out;
    var L0 = num(sv.length_mm, 4600) / 1000, W0 = num(sv.width_mm, 1900) / 1000, H0 = num(sv.height_mm, 1400) / 1000;
    var L = clamp(ref.length, 3, 7), W = clamp(ref.width, 1.4, 2.6), H = clamp(ref.height, 0.9, 3.2);
    var shell = (L * W + L * H + W * H) / (L0 * W0 + L0 * H0 + W0 * H0);
    out.mass = clamp(shell, 0.85, 1.2);
    out.area = clamp((W * H) / (W0 * H0), 0.85, 1.45);
    if (isNum(ref.cd) && ref.cd > 0.15 && ref.cd < 0.7) out.cd = out.cd + 0.5 * (ref.cd - out.cd);
    return out;
  }

  function geometry(b) {
    var bs = opt('bodyStyles', b.body.style, 'coupe');
    var ref = modelRef(b), scale = modelScale(bs, ref);
    var wr = Array.isArray(bs.wheelbaseRange) ? bs.wheelbaseRange : [2300, 3700];
    var wb = clamp(num(b.body.wheelbase_mm, num(bs.defaultWheelbase, 2650)), Math.min(2200, wr[0]), Math.max(3800, wr[1]));
    var track = clamp(num(b.body.trackWidth_mm, 1600), 1350, 1850);
    var rh = clamp(num(b.suspension.rideHeight_mm, 120), 40, 320);
    var nominal = NOMINAL_RIDE[bs.id] || 125;
    var d = clamp(num(b.wheels.diameter_in, 19), 13, 24);
    var twF = clamp(num(b.tires.widthFront_mm, 245), 145, 405), twR = clamp(num(b.tires.widthRear_mm, twF), 145, 405);
    var pF = clamp(num(b.tires.profileFront, 40), 20, 80), pR = clamp(num(b.tires.profileRear, pF), 20, 80);
    var rF = (d * 25.4 / 2 + twF * pF / 100) / 1000, rR = (d * 25.4 / 2 + twR * pR / 100) / 1000;
    var D_ = D();
    return {
      bs: bs, wb: wb, track: track, rh: rh, nominal: nominal, dz: (rh - nominal) * 0.9, d: d,
      twF: twF, twR: twR, pF: pF, pR: pR, rF: rF, rR: rR,
      comp: opt('tireCompounds', b.tires.compound, 'performance'),
      ow: (D_ && D_.optionWeights) || {}, mass0: num(bs.baseWeight_kg, 1450),
      ref: ref, scale: scale, con: opt('constructions', b.body.construction, 'standard')
    };
  }

  function aeroModel(b, geo) {
    var a = b.aero || {}, bs = geo.bs;
    var sp = opt('aero.splitters', a.splitter, 'none'), wg = opt('aero.wings', a.wing, 'none'), df = opt('aero.diffusers', a.diffuser, 'none');
    var wd = opt('wheelDesigns', b.wheels.design, 'y-spoke');
    var ang = clamp(num(a.wingAngle_deg, 6), 0, 20);
    var adjustable = !!wg.adjustable;
    var dfAng = adjustable ? 0.35 + 1.2 * (1 - Math.exp(-ang / 7)) : 1;
    var drAng = adjustable ? 0.45 + 0.09 * ang : 1;
    var dRide = geo.rh - geo.nominal;
    var avgTw = (geo.twF + geo.twR) / 2;
    var sc = geo.scale || { cd: num(bs.cd, 0.32), area: 1 };
    var cd = num(sc.cd, num(bs.cd, 0.32)) + num(sp.dragDelta, 0) + num(wg.dragDelta, 0) * drAng + num(df.dragDelta, 0) +
      (a.canards ? 0.006 : 0) + (a.sideSkirts ? -0.002 : 0) + num(wd.dragDelta, 0) +
      dRide * 0.00015 + (avgTw - 245) * 0.00012 + (b.exterior && b.exterior.mirrors === 'carbon' ? -0.001 : 0) +
      Math.abs(num(b.suspension.toeFront_deg, 0)) * 0.004;
    cd = clamp(cd, 0.18, 0.75);
    var cdLow = cd;
    if (wg.active) cdLow -= num(wg.dragDelta, 0) * drAng * 0.7;   // flat wing on the straights
    if (a.activeAero) cdLow -= 0.008;                              // cooling shutters, active diffuser flaps
    cdLow = clamp(cdLow, 0.17, cd);
    var area = num(bs.frontalArea_m2, 2.1) * num(sc.area, 1) + (geo.track - 1600) * 0.0011 + dRide * 0.0016 + (avgTw - 245) * 0.0008 +
      (num(wg.downforce_kg_at_200, 0) >= 100 ? 0.04 : 0);
    area = clamp(area, 1.4, 4.2);
    // ground effect: lower → more underbody downforce (diffuser & splitter)
    var ground = clamp(1 + (-dRide) * 0.006, 0.4, 1.6);
    var dfF = num(sp.downforce_kg_at_200, 0) * ground + (a.canards ? 12 : 0);
    var dfR = num(wg.downforce_kg_at_200, 0) * dfAng;
    var dfD = num(df.downforce_kg_at_200, 0) * ground * (a.sideSkirts ? 1.12 : 1);
    var dfBody = bs.id === 'hypercar' ? 45 * ground : 0;
    dfF += dfD * 0.35 + dfBody * 0.45;
    dfR += dfD * 0.65 + dfBody * 0.55;
    if (a.activeAero) { dfF *= 1.1; dfR *= 1.1; }
    var total = Math.max(0, dfF + dfR);
    return {
      cd: cd, cdLow: cdLow, area: area, cda: cd * area, cdaLow: cdLow * area,
      df200: total, dfFrontShare: total > 0 ? clamp(dfF / total, 0, 1) : 0.45, wingDf: dfR, adjustable: adjustable,
      activeWing: !!wg.active, wing: wg
    };
  }
  /** Downforce in N at speed v (m/s). */
  function dfN(aero, v) { return aero.df200 * G * sq(v / (200 / 3.6)); }

  /** Tyre & chassis grip model. Returns peak μ0 per axle and load sensitivity data. */
  function gripModel(b, geo, mass) {
    var s = b.suspension || {}, comp = geo.comp;
    var st = opt('suspensionTypes', s.type, 'multilink');
    var cm = opt('chassisMaterials', b.body.chassisMaterial, 'steel');
    var cage = opt('rollCages', b.weight.rollCage, 'none');
    var stiff = clamp(num(cm.stiffness, 0.6) + num(cage.stiffnessGain, 0) * 0.8 + num(geo.con && geo.con.stiffness, 0), 0, 1.1);
    function camberLat(c) { return 1 + 0.045 * (1 - sq((c + 2.5) / 2.5)) - (c > 0 ? 0.03 * c : 0); }
    function camberLong(c) { return 1 - 0.012 * Math.abs(c + 0.3); }
    var cF = clamp(num(s.camberFront_deg, -1.5), -6, 2), cR = clamp(num(s.camberRear_deg, -1), -6, 2);
    var damp = clamp(num(s.damping, 5), 1, 10);
    var dampF = 1 - 0.004 * sq(damp - 6);
    var chassisF = 0.96 + 0.06 * stiff;
    var toeF = 1 + clamp(-num(s.toeFront_deg, 0), -0.5, 0.5) * 0.01 - Math.abs(num(s.toeFront_deg, 0)) * 0.01;
    var toeR = 1 + clamp(num(s.toeRear_deg, 0.1), -0.5, 0.5) * 0.012 - Math.max(0, Math.abs(num(s.toeRear_deg, 0.1)) - 0.25) * 0.03;
    function rimFit(wIn, tw) {
      var ideal = tw / 25.4 * 0.85;
      var mis = Math.abs(clamp(num(wIn, ideal), 4, 15) - ideal);
      return 1 - Math.max(0, mis - 1.0) * 0.02;
    }
    var mu = clamp(num(comp.mu, 1.0), 0.3, 2.2) * num(st.gripMult, 1) * chassisF * dampF;
    // bottoming: soft springs + very low ride on bumps
    var bottom = 1;
    var spr = (num(s.springFront_nmm, 60) + num(s.springRear_nmm, 70)) / 2;
    if (geo.rh < 85) bottom -= clamp((85 - geo.rh) / 35, 0, 1) * clamp((110 - spr) / 80, 0, 1) * 0.05;
    mu *= bottom;
    var muF = mu * camberLat(cF) * toeF * rimFit(b.wheels.widthFront_in, geo.twF);
    var muR = mu * camberLat(cR) * toeR * rimFit(b.wheels.widthRear_in, geo.twR);
    var ks = comp.id === 'slick' ? 0.13 : comp.id === 'track' ? 0.11 : 0.09;
    // roll stiffness distribution: springs (wheel rate ∝ k·t²) + bars
    var kF = num(s.springFront_nmm, 60) + num(s.arbFront, 5) * 14, kR = num(s.springRear_nmm, 70) + num(s.arbRear, 4) * 14;
    var lambdaF = clamp(kF / (kF + kR), 0.2, 0.8);
    return {
      muF: muF, muR: muR, longF: camberLong(cF), longR: camberLong(cR), ks: ks,
      Fz0F: 4300 * geo.twF / 245, Fz0R: 4300 * geo.twR / 245, lambdaF: lambdaF, stiff: stiff, bottom: bottom,
      comp: comp, wetRatio: clamp(num(comp.wetMu, 0.8) / num(comp.mu, 1), 0.1, 1.2), suspension: st, spring: spr
    };
  }
  /** Grip (N) of one tyre with vertical load Fz (N), load-sensitive. */
  function tyreGrip(mu0, Fz, Fz0, ks) {
    if (Fz <= 0) return 0;
    var mu = mu0 * Math.max(0.35, 1 - ks * (Fz / Fz0 - 1));
    return mu * Fz;
  }

  /** Steady-state maximum lateral acceleration (m/s²) at speed v. */
  function lateralLimit(ctx, v) {
    var m = ctx.mass, wf = ctx.wf, h = ctx.cgH / 1000, t = ctx.track / 1000, gr = ctx.grip, aero = ctx.aero;
    var df = dfN(aero, v), WF = m * G * wf + df * aero.dfFrontShare, WR = m * G * (1 - wf) + df * (1 - aero.dfFrontShare);
    var ay = 9;
    var capF = 0, capR = 0;
    for (var it = 0; it < 24; it++) {
      var dW = m * ay * h / t;
      var dF = dW * gr.lambdaF, dR = dW * (1 - gr.lambdaF);
      capF = tyreGrip(gr.muF, WF / 2 + dF, gr.Fz0F, gr.ks) + tyreGrip(gr.muF, Math.max(0, WF / 2 - dF), gr.Fz0F, gr.ks);
      capR = tyreGrip(gr.muR, WR / 2 + dR, gr.Fz0R, gr.ks) + tyreGrip(gr.muR, Math.max(0, WR / 2 - dR), gr.Fz0R, gr.ks);
      var aF = capF / (m * wf), aR = capR / (m * (1 - wf));
      var lim = Math.min(aF, aR) * 0.75 + (aF + aR) / 2 * 0.25;
      lim *= ctx.latAssist;
      var nay = ay + (lim - ay) * 0.6;
      if (Math.abs(nay - ay) < 1e-4) { ay = nay; break; }
      ay = nay;
    }
    ctx._lastBal = capF / (m * wf) - capR / (m * (1 - wf));
    return clamp(ay, 2, 60);
  }

  /* ======================================================================
     DRIVELINE
     ====================================================================== */
  function drivelineModel(b, E, geo) {
    var t = b.transmission || {}, dt = b.drivetrain || {};
    var tr = opt('transmissions', t.type, E.type === 'ev' ? 'single-speed' : 'dct');
    var isCVT = tr.id === 'cvt';
    var ratios = Array.isArray(t.ratios) ? t.ratios.map(function (x) { return num(x, NaN); }).filter(function (x) { return isNum(x) && x > 0.2 && x < 8; }) : [];
    if (!ratios.length) {
      try { ratios = typeof tr.defaultRatios === 'function' ? tr.defaultRatios(num(t.gears, 6)) : []; } catch (e) { ratios = []; }
      if (!ratios.length) ratios = E.type === 'ev' ? [2.65] : [3.5, 2.3, 1.7, 1.3, 1.0, 0.8];
    }
    if (isCVT) ratios = [ratios[0]];
    var fd = clamp(num(t.finalDrive, 3.5), 1.5, 7);
    var layout = dt.layout === 'fwd' || dt.layout === 'awd' ? dt.layout : 'rwd';
    var split = layout === 'fwd' ? 1 : layout === 'rwd' ? 0 : clamp(num(dt.torqueSplitFront_pct, 40) / 100, 0.05, 0.95);
    var effTr = clamp(num(tr.efficiency, 0.93), 0.7, 0.99);
    var effDl = layout === 'awd' ? 0.955 : layout === 'fwd' ? 0.99 : 0.98;
    var eff = effTr * effDl;
    var shift = Math.max(0, num(tr.shiftTime_s, 0.2));
    // torque carried through a shift: DCT overlap; modern 8–10-speed automatics fill torque far better than old 6-speeds
    var carry = tr.id === 'dct' ? 0.55 : tr.id === 'auto' ? (ratios.length >= 8 ? 0.5 : 0.35) : 0;
    var lockOf = function (id) { return num(opt('differentials', id, 'open').lockFactor, 0); };
    var lockF = lockOf(dt.frontDiff), lockR = lockOf(dt.rearDiff), lockC = dt.centerDiff === 'none' || !dt.centerDiff ? 0.35 : lockOf(dt.centerDiff);
    var drivenLock = layout === 'fwd' ? lockF : layout === 'rwd' ? lockR : (lockF + lockR) / 2;
    var tc = clamp(Math.round(num(dt.tractionControl, 2)), 0, 3);
    var tcF = [0.92, 0.96, 0.98, 0.95][tc]; // off: driver-modulated wheelspin; 3: conservative intervention
    if (E.type === 'ev') {
      // motor torque is controlled ~10× faster than spark/throttle cuts: slip is held near the optimum
      if (tc > 0) tcF = Math.max(tcF, 0.99);
      // separate front/rear motors actively re-split torque; one motor per wheel acts as a fully locked/vectored diff
      if (layout === 'awd' && E.motors >= 2) lockC = Math.max(lockC, 0.95);
      if (E.motors >= 4 || (layout !== 'awd' && E.motors >= 2)) drivenLock = 1;
    }
    var lc = !!t.launchControl;
    var rDriven = layout === 'fwd' ? geo.rF : layout === 'rwd' ? geo.rR : geo.rF * split + geo.rR * (1 - split);
    var span = Array.isArray(tr.ratioSpan) ? tr.ratioSpan : [2.63, 0.40];
    var cvtLow = ratios[0], cvtHigh = ratios[0] * (num(span[1], 0.4) / num(span[0], 2.63));
    return {
      tr: tr, ratios: ratios, fd: fd, layout: layout, split: split, eff: eff, effTr: effTr, shift: shift, carry: carry,
      lockF: lockF, lockR: lockR, lockC: lockC, drivenLock: drivenLock, tc: tc, tcF: tcF, lc: lc, r: rDriven,
      isCVT: isCVT, cvtLow: cvtLow, cvtHigh: cvtHigh, tv: !!dt.torqueVectoring,
      torqueLimit: num(tr.torqueLimit_nm, 1e9)
    };
  }

  /* ======================================================================
     FORCES
     ====================================================================== */
  /** Engine rpm for speed v in overall ratio Gt. */
  function rpmAt(v, Gt, r_) { return v / r_ * Gt * 30 / PI; }

  /** Max tractive force (N) for longitudinal acceleration a (m/s²) at speed v. */
  function tractionLimit(ctx, v, a, launch) {
    var m = ctx.mass, h = ctx.cgH / 1000, L = ctx.wb / 1000, gr = ctx.grip, dl = ctx.dl, aero = ctx.aero;
    var df = dfN(aero, v);
    var transfer = m * Math.max(0, a) * h / L;
    var WF = Math.max(0, m * G * ctx.wf + df * aero.dfFrontShare - transfer);
    var WR = m * G * (1 - ctx.wf) + df * (1 - aero.dfFrontShare) + transfer;
    var fF = 2 * tyreGrip(longMu(gr.muF) * gr.longF, WF / 2, gr.Fz0F, gr.ks);
    var fR = 2 * tyreGrip(longMu(gr.muR) * gr.longR, WR / 2, gr.Fz0R, gr.ks);
    var diffK = 0.955 + 0.045 * dl.drivenLock;
    var ctl = launch && dl.lc ? Math.max(dl.tcF, 0.99) : dl.tcF;
    var F;
    if (dl.layout === 'fwd') F = fF;
    else if (dl.layout === 'rwd') F = fR;
    else {
      var s = dl.split;
      var fixed = Math.min(fF / s, fR / (1 - s));
      F = dl.lockC * (fF + fR) + (1 - dl.lockC) * fixed;
      F = Math.min(F, fF + fR);
    }
    return F * diffK * ctl * (dl.tv ? 1.01 : 1);
  }

  function resistance(ctx, v, lowDrag) {
    var cda = lowDrag ? ctx.aero.cdaLow : ctx.aero.cda;
    var drag = 0.5 * RHO * cda * v * v;
    var rr = ctx.crr * (ctx.mass * G + dfN(ctx.aero, v)) * (1 + v / 160);
    return drag + rr;
  }

  /** Steady (full boost) wheel force in a given gear index, 0 above the limiter. */
  function gearForce(ctx, v, gi) {
    var E = ctx.E, dl = ctx.dl;
    var Gt = dl.ratios[gi] * dl.fd;
    var rpm = rpmAt(v, Gt, dl.r);
    if (rpm > E.R * 1.0001) return 0;
    // heat-soak derate acts on the engine itself, before the gearbox's electronic torque limit
    var T = Math.min(E.torque(Math.max(rpm, E.idle), 1) * (ctx.heatDerate || 1), dl.torqueLimit);
    return T * Gt * dl.eff / dl.r;
  }
  function cvtForce(ctx, v) {
    var E = ctx.E, dl = ctx.dl;
    var target = E.peakPowerRpm;
    var Gt = clamp(target * PI / 30 * dl.r / Math.max(v, 0.1) / dl.fd, dl.cvtHigh, dl.cvtLow) * dl.fd;
    var rpm = rpmAt(v, Gt, dl.r);
    if (rpm > E.R * 1.0001) return 0;
    // heat-soak derate acts on the engine itself, before the gearbox's electronic torque limit
    var T = Math.min(E.torque(Math.max(rpm, E.idle), 1) * (ctx.heatDerate || 1), dl.torqueLimit);
    return T * Gt * dl.eff / dl.r;
  }
  /** Best available wheel force at speed v over all gears (engine-limited, no traction). */
  function envelopeForce(ctx, v) {
    if (ctx.dl.isCVT) return cvtForce(ctx, v);
    var best = 0, bestG = 0;
    for (var gi = 0; gi < ctx.dl.ratios.length; gi++) {
      var f = gearForce(ctx, v, gi);
      if (f > best) { best = f; bestG = gi; }
    }
    ctx._envGear = bestG;
    return best;
  }

  /* ======================================================================
     TOP SPEED
     ====================================================================== */
  function topSpeed(ctx) {
    var vMax = 0;
    for (var v = 1; v < 160; v += 0.5) {
      if (envelopeForce(ctx, v) >= resistance(ctx, v, true)) vMax = v; else if (v > vMax + 6) break;
    }
    // refine
    for (var v2 = vMax; v2 < vMax + 0.5; v2 += 0.02) if (envelopeForce(ctx, v2) >= resistance(ctx, v2, true)) vMax = v2;
    var dl = ctx.dl, E = ctx.E;
    var topRatio = dl.isCVT ? dl.cvtHigh : dl.ratios[dl.ratios.length - 1];
    var vRed = E.R * PI / 30 * dl.r / (topRatio * dl.fd);
    var by = 'drag';
    // redline-limited when the car runs out of revs with surplus thrust at the limiter
    if (vRed <= vMax + 0.6) {
      var Tred = Math.min(E.torque(E.R, 1), dl.torqueLimit) * topRatio * dl.fd * dl.eff / dl.r;
      if (Tred > resistance(ctx, vRed - 0.05, true)) { by = 'redline'; vMax = Math.min(vMax, vRed); }
    }
    var gov = ctx.governor;
    if (gov && vMax > gov) { vMax = gov; by = 'governor'; }
    return { v: Math.max(1, vMax), by: by, vRed: vRed };
  }

  /* ======================================================================
     LONGITUDINAL SIMULATION (dt = 0.05 s)
     ====================================================================== */
  function shiftSpeeds(ctx) {
    var dl = ctx.dl, E = ctx.E, out = [];
    for (var gi = 0; gi < dl.ratios.length - 1; gi++) {
      var vRed = E.R * PI / 30 * dl.r / (dl.ratios[gi] * dl.fd);
      var vs = vRed * 0.995;
      for (var v = vRed * 0.55; v < vRed * 0.995; v += 0.1) {
        if (gearForce(ctx, v, gi + 1) > gearForce(ctx, v, gi) && rpmAt(v, dl.ratios[gi + 1] * dl.fd, dl.r) > E.idle * 1.4) { vs = v; break; }
      }
      out.push(vs);
    }
    return out;
  }

  function simulate(ctx, top) {
    var dl = ctx.dl, E = ctx.E, m = ctx.mass;
    var nG = dl.ratios.length;
    var shiftV = dl.isCVT ? [] : shiftSpeeds(ctx);
    var Iw = ctx.wheelInertia;
    var trType = dl.tr.id;
    var t = 0, v = 0, x = 0, gi = 0, a = 0, shiftT = 0, nextGi = 0;
    // boost state: launch control holds a 2-step rev limit with partial pre-spool
    var bs = E.boosted ? (dl.lc ? (E.tune && E.tune.id === 'time-attack' ? 0.95 : 0.55) : 0.15) : 1;
    var curve = [];
    var res = { t60: null, t100: null, t200: null, tQM: null, trapQM: null, tractionTime60: 0, lagTime60: 0, tractionGears: {} };
    var v60 = 60 * MPH, v100 = 100 / 3.6, v200 = 200 / 3.6;
    var vStop = top.v * 0.98, reach200 = top.v > v200 + 0.05;
    var launchRpm = dl.lc ? E.launchRpm : (trType === 'manual' || trType === 'sequential' ? E.launchRpm * 0.85 : trType === 'auto' ? Math.min(E.launchRpm, 2600) : Math.min(E.launchRpm, 2800));
    if (E.type === 'ev') launchRpm = 0;
    var stall = trType === 'auto' && E.type !== 'ev';
    var driverRamp = dl.lc || E.type === 'ev' ? 0.12 : trType === 'manual' ? 0.35 : 0.2;
    var maxT = 60;
    var shifts = 0;
    for (var step = 0; step < 2400; step++) {
      var Gt, rpm, T, slip = false;
      if (dl.isCVT) {
        Gt = clamp(E.peakPowerRpm * PI / 30 * dl.r / Math.max(v, 0.5) / dl.fd, dl.cvtHigh, dl.cvtLow) * dl.fd;
      } else Gt = dl.ratios[gi] * dl.fd;
      var wheelRpm = rpmAt(v, Gt, dl.r);
      rpm = wheelRpm;
      var tcMult = 1;
      if (gi === 0 && wheelRpm < launchRpm && E.type !== 'ev') { rpm = dl.isCVT ? Math.max(launchRpm, wheelRpm) : launchRpm; slip = true; }
      if (stall && gi === 0 && wheelRpm < 2400) {
        var sr = wheelRpm / 2400; tcMult = lerp(1.9, 1.0, clamp(sr / 0.85, 0, 1)); rpm = Math.max(rpm, 2400); slip = true;
      }
      rpm = Math.max(rpm, E.idle);
      if (rpm >= E.R) rpm = E.R;
      // turbo transient
      if (E.boosted && E.tau > 0) {
        bs += (1 - bs) * (1 - Math.exp(-DT / E.tau));
      } else bs = 1;
      T = Math.min(E.torque(rpm, bs), dl.torqueLimit) * tcMult;
      var Fe = T * Gt * dl.eff / dl.r;
      // torque converter not yet locked up in 1st / 2nd: a few % slip loss on top of the gearbox efficiency
      if (stall && gi <= 1 && tcMult === 1) Fe *= 0.95;
      if (t < driverRamp) Fe *= lerp(0.55, 1, t / driverRamp);
      if (shiftT > 0) Fe *= dl.carry;
      var Ft = tractionLimit(ctx, v, a, t < 2.5);
      var limitedByTraction = Fe > Ft;
      var F = Math.min(Fe, Ft);
      if (ctx.governor && v >= ctx.governor) F = Math.min(F, resistance(ctx, v, true));
      // engine-side: the crank, gearbox & wheels must be spun up too; tyre-side: once the tyres are at their
      // limit only the vehicle (and undriven wheels) is accelerated by the tyre force — surplus torque spins the driveline
      var Fres = resistance(ctx, v, true);
      var mEff = m + Iw / (dl.r * dl.r) + (slip ? 0 : E.inertia * Gt * Gt / (dl.r * dl.r));
      var aEng = (Math.min(Fe, (ctx.governor && v >= ctx.governor) ? Fres : Fe) - Fres) / mEff;
      var aTyre = (Ft - Fres) / (m + 0.5 * Iw / (dl.r * dl.r));
      var aNew = Math.min(aEng, aTyre);
      if (v <= 0 && aNew < 0) aNew = 0;
      a = aNew;
      var vPrev = v, xPrev = x;
      v = Math.max(0, v + a * DT);
      // rev limiter in top gear (soft cut holds the car on the limiter) and the speed governor: no overshoot
      if ((gi === nG - 1 || dl.isCVT) && shiftT <= 0 && v > top.vRed) v = Math.max(vPrev, top.vRed);
      if (ctx.governor && v > ctx.governor) v = Math.max(Math.min(vPrev, v), ctx.governor);
      x += (vPrev + v) / 2 * DT;
      t += DT;
      // bookkeeping
      if (res.t60 == null) {
        if (limitedByTraction) res.tractionTime60 += DT;
        if (E.boosted && bs < 0.8) res.lagTime60 += DT;
      }
      if (limitedByTraction && !dl.isCVT && v > 2) res.tractionGears[gi + 1] = true;
      function cross(target) { return vPrev < target && v >= target ? t - DT + (target - vPrev) / Math.max(1e-6, v - vPrev) * DT : null; }
      var c;
      if (res.t60 == null && (c = cross(v60)) != null) res.t60 = c;
      if (res.t100 == null && (c = cross(v100)) != null) res.t100 = c;
      if (res.t200 == null && (c = cross(v200)) != null) res.t200 = c;
      if (res.tQM == null && xPrev < QUARTER_MILE_M && x >= QUARTER_MILE_M) {
        var f = (QUARTER_MILE_M - xPrev) / Math.max(1e-6, x - xPrev);
        res.tQM = t - DT + f * DT; res.trapQM = lerp(vPrev, v, f);
      }
      // gear changes
      if (shiftT > 0) {
        shiftT -= DT;
        if (shiftT <= 1e-9) { shiftT = 0; gi = nextGi; }
      } else if (!dl.isCVT && gi < nG - 1 && v >= shiftV[gi]) {
        nextGi = gi + 1; shifts++;
        if (dl.shift <= DT * 0.5) gi = nextGi; else shiftT = dl.shift;
        if (E.boosted && (trType === 'manual')) bs *= 0.7;   // lift-off dumps boost
      }
      curve.push({ t: r(t, 2), kph: r(v * 3.6, 1), gear: dl.isCVT ? 1 : (shiftT > 0 ? gi + 1 : gi + 1) });
      var done = v >= vStop && x >= QUARTER_MILE_M && (!reach200 || res.t200 != null);
      if (done || t >= maxT - 1e-9) break;
    }
    res.curve = curve; res.shifts = shifts; res.endT = t; res.shiftV = shiftV;
    return res;
  }

  /* ======================================================================
     BRAKING
     ====================================================================== */
  function brakeModel(b, ctx) {
    var br = b.brakes || {}, bm = opt('brakeMaterials', br.material, 'iron');
    var abs = br.abs === 'off' || br.abs === 'race' || br.abs === 'standard' ? br.abs : 'sport';
    var fricMult = num(bm.frictionMult, 1);
    var P = 1.2e7; // line pressure at panic stop (120 bar)
    function caliperForce(pistons, rotorMm, rTyre, rear) {
      pistons = clamp(Math.round(num(pistons, 4)), 1, 12);
      // single-piston floating calipers: ~54 mm bore up front, ~38 mm at the rear (sized for a light car);
      // opposed multi-piston calipers: total clamping area of one side = pistons / 2 × bore area
      var area = pistons <= 1 ? (rear ? 1.13e-3 : 2.29e-3) : (pistons <= 4 ? 1.02e-3 : pistons <= 6 ? 0.8e-3 : 0.65e-3) * pistons / 2 * (rear && pistons <= 2 ? 0.8 : 1);
      var clampF = P * area;
      var fr = 2 * 0.42 * fricMult * clampF;
      var rEff = clamp(num(rotorMm, 340), 240, 460) / 2000 - 0.025;
      return fr * rEff / rTyre; // N at the contact patch, per wheel
    }
    var capF = 2 * caliperForce(br.frontPistons, br.frontRotor_mm, ctx.geo.rF);
    var capR = 2 * caliperForce(br.rearPistons, br.rearRotor_mm, ctx.geo.rR, true);
    var bias = capF / (capF + capR);
    var absEff = abs === 'off' ? 0 : abs === 'standard' ? 0.93 : abs === 'race' ? 0.975 : 0.955;
    var m = ctx.mass, h = ctx.cgH / 1000, L = ctx.wb / 1000, gr = ctx.grip, aero = ctx.aero;
    /** Max deceleration (m/s²) at speed v (fresh brakes). */
    function decel(v, fade) {
      var df = dfN(aero, v);
      var a = 10;
      for (var i = 0; i < 16; i++) {
        var tr = m * a * h / L;
        var WF = m * G * ctx.wf + df * aero.dfFrontShare + tr, WR = Math.max(0, m * G * (1 - ctx.wf) + df * (1 - aero.dfFrontShare) - tr);
        var gF = 2 * tyreGrip(brakeMu(gr.muF) * gr.longF, WF / 2, gr.Fz0F, gr.ks);
        var gR = 2 * tyreGrip(brakeMu(gr.muR) * gr.longR, WR / 2, gr.Fz0R, gr.ks);
        var Ftyre;
        if (absEff > 0) Ftyre = (gF + gR) * absEff;                              // ABS + EBD balance the axles
        else {
          // fixed hydraulic bias: the first axle to lock limits the stop; locked tyres slide at ~80 %
          var Fmax = Math.min(gF / Math.max(bias, 0.05), gR / Math.max(1 - bias, 0.05));
          Ftyre = Math.min(Fmax, gF + gR) * 0.97;
          if (Fmax < (gF + gR) * 0.9) Ftyre = Math.max(Ftyre, (gF + gR) * 0.8);
        }
        var Fhyd = (capF + capR) * (fade == null ? 1 : fade);
        var F = Math.min(Ftyre, Fhyd) + 0.5 * RHO * aero.cda * v * v + ctx.crr * m * G;
        var na = F / (m + ctx.wheelInertia / sq(ctx.geo.rR));
        if (Math.abs(na - a) < 1e-4) { a = na; break; }
        a = na;
      }
      return a;
    }
    function stopDist(v0, fade) {
      var d = v0 * 0.03; // pressure build-up (~60 ms)
      var dv = 0.25;
      for (var v = v0; v > 0; v -= dv) { var vv = Math.max(0.01, v - dv / 2); d += vv * dv / decel(vv, fade); }
      return d;
    }
    // thermal: energy of a stop from top speed vs rotor heat capacity
    var cp = bm.id === 'carbon-ceramic' ? 1100 : 480, dTmax = bm.id === 'carbon-ceramic' ? 650 : bm.id === 'two-piece' ? 480 : 420;
    var rotorMass = 2 * (ctx.geo.rotorKgF + ctx.geo.rotorKgR);
    var heatCap = rotorMass * cp * dTmax * (0.8 + 0.4 * num(bm.fadeResistance, 0.5));
    var Etop = 0.5 * m * sq(Math.min(ctx.top.v, 300 / 3.6));
    var heatIndex = Etop / Math.max(1, heatCap);
    var fadeLap = clamp(1 - (1 - num(bm.fadeResistance, 0.5)) * clamp(heatIndex, 0, 2) * 0.22 * (1 / num(opt('coolings', b.engine.cooling, 'standard').heatCapacity, 1)), 0.6, 1);
    return {
      decel: decel, stopDist: stopDist, capF: capF, capR: capR, bias: bias, abs: abs, absEff: absEff, bm: bm,
      heatIndex: heatIndex, fadeLap: fadeLap, hydCapG: (capF + capR) / (m * G)
    };
  }

  /* ======================================================================
     LAP SIMULATION — Redline Ring
     ====================================================================== */
  function lapSim(ctx, brakes) {
    var n = TRACK_PIECES.length, m = ctx.mass;
    var vTop = ctx.top.v;
    // lateral limit table every 2 m/s
    var latTab = [];
    for (var vi = 0; vi <= 100; vi++) latTab.push(lateralLimit(ctx, vi * 2));
    function latAt(v) { var x = clamp(v / 2, 0, 100), i0 = Math.floor(x), i1 = Math.min(100, i0 + 1); return latTab[i0] + (latTab[i1] - latTab[i0]) * (x - i0); }
    // engine/traction envelope every 1 m/s (heat-soak derated inside gearForce)
    var accTab = [], brkTab = [];
    for (var v = 0; v <= 160; v++) {
      var vv = Math.max(v, 0.5);
      var Fe = envelopeForce(ctx, vv);          // already heat-soak derated (ctx.heatDerate)
      var Ft = tractionLimit(ctx, vv, 3, false);
      accTab.push((Math.min(Fe, Ft) - resistance(ctx, vv, false)) / (m * 1.05));
      brkTab.push(brakes.decel(vv, brakes.fadeLap));
    }
    function tab(T, v) { var x = clamp(v, 0, 160), i0 = Math.floor(x), i1 = Math.min(160, i0 + 1); return T[i0] + (T[i1] - T[i0]) * (x - i0); }
    // corner speed limits
    var vLim = new Array(n);
    for (var i = 0; i < n; i++) {
      var R = TRACK_PIECES[i].radius;
      if (R <= 0) { vLim[i] = vTop; continue; }
      var vc = Math.sqrt(latAt(20) * R);
      for (var k = 0; k < 8; k++) vc = Math.sqrt(latAt(vc) * R);
      vLim[i] = Math.min(vTop, vc);
    }
    // two passes over a closed loop (start from the speed the lap ends at)
    function aLongAvail(base, v, R) {
      if (R <= 0) return base;
      var ay = v * v / R, lim = latAt(v);
      var f = clamp(1 - sq(ay / lim), 0, 1);
      return base * Math.sqrt(f);
    }
    var vF = new Array(n), vB = new Array(n);
    var vStart = vLim[n - 1];
    for (var lap = 0; lap < 2; lap++) {
      // forward (acceleration)
      var vc0 = lap === 0 ? Math.min(vStart, 30) : vF[n - 1];
      for (var p = 0; p < n; p++) {
        var piece = TRACK_PIECES[p];
        var v0 = p === 0 ? vc0 : vF[p - 1];
        var aa = Math.max(0, aLongAvail(tab(accTab, v0), v0, piece.radius));
        var v1 = Math.sqrt(Math.max(0, v0 * v0 + 2 * aa * piece.len));
        vF[p] = Math.min(v1, vLim[p]);
      }
    }
    // backward (braking)
    for (var q = n - 1; q >= 0; q--) {
      var nx = q === n - 1 ? vF[0] : vB[q + 1];
      var pc = TRACK_PIECES[q];
      var ab = aLongAvail(tab(brkTab, nx), nx, pc.radius) * 0.97;
      var vb = Math.sqrt(nx * nx + 2 * Math.max(0.5, ab) * pc.len);
      vB[q] = Math.min(vF[q], vb);
    }
    var sectors = [0, 0, 0], total = 0, vmin = 1e9, vmax = 0, fullThrottle = 0, gearChanges = 0, prevG = -1;
    for (var s = 0; s < n; s++) {
      var pcs = TRACK_PIECES[s];
      var va = s === 0 ? vB[n - 1] : vB[s - 1], vb2 = vB[s];
      var vavg = Math.max(1, (va + vb2) / 2);
      var dtp = pcs.len / vavg;
      sectors[pcs.sector] += dtp; total += dtp;
      vmin = Math.min(vmin, vb2); vmax = Math.max(vmax, vb2);
      if (vb2 > va + 0.01) fullThrottle += dtp;
      if (!ctx.dl.isCVT) { envelopeForce(ctx, vb2); if (prevG >= 0 && ctx._envGear > prevG) gearChanges++; prevG = ctx._envGear; }
    }
    // shift interruptions
    var shiftLoss = gearChanges * ctx.dl.shift * (1 - ctx.dl.carry) * 0.55;
    total += shiftLoss;
    var share = [sectors[0] / (total - shiftLoss), sectors[1] / (total - shiftLoss), sectors[2] / (total - shiftLoss)];
    sectors = sectors.map(function (x, i) { return x + shiftLoss * share[i]; });
    return {
      time: total, sectors: sectors, vmin: vmin, vmax: vmax, fullThrottlePct: total > 0 ? fullThrottle / total * 100 : 0,
      gearChanges: gearChanges
    };
  }

  /* ======================================================================
     ENERGY / FUEL ECONOMY
     ====================================================================== */
  var CYCLE = [
    { name: 'city', share: 0.35, v: 32 / 3.6, stopsPerKm: 2.5, vPeak: 50 / 3.6, idleS: 8, rpm: 1700 },
    { name: 'suburban', share: 0.25, v: 62 / 3.6, stopsPerKm: 0.6, vPeak: 80 / 3.6, idleS: 4, rpm: 1900 },
    { name: 'highway', share: 0.40, v: 112 / 3.6, stopsPerKm: 0.1, vPeak: 125 / 3.6, idleS: 0, rpm: 0 }
  ];
  function energyModel(b, ctx) {
    var E = ctx.E, m = ctx.mass, dl = ctx.dl, aero = ctx.aero, e = b.engine || {};
    var tc = b.tech || {};
    var accW = 380 + clamp(num(tc.climateZones, 2), 1, 4) * 70 + (num(tc.screen_in, 12) > 0 ? 25 + num(tc.screen_in, 12) * 2 : 0) +
      ({ none: 0, assist: 40, plus: 90, pilot: 180, 'autonomous-l3': 450 }[tc.adas] || 40) +
      ({ delete: -20, track: 10, standard: 40, premium: 90, reference: 140, concert: 200 }[tc.audio] || 40) +
      (tc.nightVision ? 25 : 0) + (tc.hud ? 15 : 0);
    var out = { whkm: null, l100: null, co2: 0, evRange: 0 };
    var mEff = m * 1.04;
    var wheel = []; // per segment: { Ework (J/km), Einert (J/km), time (s/km) }
    CYCLE.forEach(function (c) {
      var vr = c.v * 1.08;
      var roll = ctx.crr * m * G * (1 + c.v / 160) * 1000;
      var drag = 0.5 * RHO * aero.cdaLow * vr * vr * 1000;
      var inert = c.stopsPerKm * 0.5 * mEff * c.vPeak * c.vPeak;
      var time = 1000 / c.v + c.stopsPerKm * c.idleS;
      wheel.push({ c: c, work: roll + drag, inert: inert, time: time });
    });
    if (E.type === 'ev') {
      var etaM = E.volt === 800 ? 0.915 : 0.895;
      var etaD = dl.effTr * (dl.layout === 'awd' ? 0.985 : 1) * (1 - Math.max(0, E.motors - 2) * 0.015);
      var regenEff = [0.0, 0.35, 0.55, 0.68][clamp(Math.round(num(e.regen, 2)), 0, 3)];
      var Ewh = 0;
      wheel.forEach(function (w) {
        var Ebat = (w.work + w.inert) / (etaM * etaD) - w.inert * regenEff * etaM * etaD + accW * w.time;
        Ewh += Ebat / 3600 * w.c.share / 0.95; // battery round-trip
      });
      out.whkm = Ewh;
      out.l100 = Ewh * 100 / 1000 / KWH_PER_L_GASOLINE_EQ;
      out.range = E.kwh * 0.93 * 1000 / Ewh;
      out.co2 = 0;
      return out;
    }
    // --- ICE / hybrid: Willans line
    var fuel = E.fuel, isD = E.isDiesel;
    var lhv = LHV_GASOLINE_MJ_L * 1e6 * num(fuel.energyFactor, 1);
    var etaInd = (isD ? 0.46 : 0.385 * (1 - Math.pow(E.CR, -0.3)) / (1 - Math.pow(10, -0.3))) * (E.knockOver > 0 ? 0.97 : 1);
    var tuneEff = num(E.tune.efficiencyMult, 1);
    var hybrid = E.type === 'hybrid';
    var Vd = E.V * 1e-3;
    var topG = dl.isCVT ? dl.cvtHigh : dl.ratios[dl.ratios.length - 1];
    var totalFuel = 0;
    var fric = function (rpm) { var kr = rpm / 1000; return (0.9 + 0.12 * kr + 0.04 * kr * kr) * 1e5 * (isD ? 1.1 : 1) * (E.lay && E.lay.config === 'rotary' ? 1.35 : 1); };
    var pumping = isD ? 0.12e5 : (hybrid ? 0.15e5 : 0.4e5);
    wheel.forEach(function (w) {
      var c = w.c;
      var rpm = c.rpm;
      if (!rpm) {
        rpm = rpmAt(c.v, topG * dl.fd, dl.r);
        if (!dl.isCVT && dl.ratios.length <= 5) rpm *= 1.08;
      }
      if (dl.isCVT) rpm = Math.min(rpm, 1600);
      rpm = clamp(rpm, E.idle * 1.1, E.R * 0.6);
      var driveTime = 1000 / c.v;
      var Eb = w.work + w.inert; // J at wheels per km
      var regen = 0, engineOn = 1;
      if (hybrid) {
        var rg = [0.3, 0.45, 0.6, 0.68][clamp(Math.round(num(e.regen, 2)), 0, 3)];
        regen = w.inert * rg * 0.8;
        engineOn = c.name === 'city' ? 0.35 : c.name === 'suburban' ? 0.7 : 1;
      }
      var Eshaft = Math.max(0, Eb - regen) / (dl.eff * 0.99);
      var Efric = (fric(rpm) + pumping) * Vd * rpm / 120 * driveTime * engineOn;
      var Eidle = !hybrid ? (fric(E.idle) + pumping * 1.4) * Vd * E.idle / 120 * c.stopsPerKm * c.idleS : 0;
      var Eacc = accW * w.time / 0.6;
      var Efuel = (Eshaft + Efric + Eidle + Eacc) / (etaInd * tuneEff);
      totalFuel += Efuel / lhv * c.share; // litres per km
    });
    out.l100 = totalFuel * 100;
    out.co2 = out.l100 * num(fuel.co2Factor, 2.31) * 10;
    out.range = FUEL_TANK_L / Math.max(0.5, out.l100) * 100;
    if (hybrid) {
      // plug-in electric range from the buffer pack
      var kwh = clamp(num(e.battery_kwh, 10), 0.5, 40);
      var evWh = 0;
      wheel.forEach(function (w) { evWh += ((w.work + w.inert) / 0.85 - w.inert * 0.5 + accW * w.time) / 3600 * w.c.share; });
      out.evRange = kwh >= 4 ? kwh * 0.8 * 1000 / evWh : 0;
      out.evWhkm = evWh;
      out.range += out.evRange;
    }
    return out;
  }

  /* ======================================================================
     RELIABILITY / COMFORT / NOISE / RATINGS
     ====================================================================== */
  function reliabilityModel(b, ctx) {
    var E = ctx.E, s = 86, notes = [];
    if (E.type === 'ev') {
      s = 90 + (num(E.chem.cycleLife, 1500) - 1500) / 500;
      if (E.motors >= 4) s -= 4;
      if (E.battKw < E.motorKw) s -= 2;
      var cr = E.peakPower_w / 1000 / E.kwh;
      if (cr > 9) s -= (cr - 9) * 1.5;
    } else {
      s -= num(E.tune.reliabilityHit, 0) * 45;
      if (E.boosted) s -= 2 + Math.max(0, E.boost - 1.2) * 6;
      if (E.knockOver > 0) s -= Math.min(25, 6 + E.knockOver * 6);
      var hpl = E.icePower_kw / 0.7457 / Math.max(0.5, E.V);
      if (hpl > 140) s -= Math.min(14, (hpl - 140) * 0.08);
      var lay = E.lay;
      var over = E.R - num(lay.typicalRedline, 7000);
      if (over > 0) s -= over / 120;
      if (lay.id === 'W16') s -= 7;
      if (lay.config === 'rotary') s -= 8;
      if (E.isDiesel) s += 3;
      var heat = E.icePower_kw / E.coolingCapacity_kw;
      if (heat > 1) s -= Math.min(15, (heat - 1) * 25);
      s += (num(E.cool.heatCapacity, 1) - 1) * 6;
      if (E.type === 'hybrid') s -= 3;
    }
    var tu = ctx.peakTorqueAtBox / Math.max(1, ctx.dl.torqueLimit);
    if (tu > 0.9) s -= Math.min(15, (tu - 0.9) * 30);
    if (ctx.dl.tr.id === 'sequential') s -= 4;
    if (ctx.dl.tr.id === 'cvt' && ctx.peakTorqueAtBox > 350) s -= 6;
    var w8 = b.weight || {};
    if (w8.glass === 'polycarbonate') s -= 1;
    if (b.suspension.type === 'coilover-track' || b.suspension.type === 'pushrod') s -= 2;
    if (b.suspension.type === 'air') s -= 2;
    if (b.engine.exhaust === 'straight-pipe' && ctx.E.type !== 'ev') s -= 1;
    return clamp(s, 5, 99);
  }

  function comfortModel(b, ctx) {
    var s = b.suspension || {}, st = ctx.grip.suspension;
    var c = 55 * num(st.comfortMult, 0.9);
    var spr = ctx.grip.spring * Math.sqrt(1500 / ctx.mass);
    c += (90 - spr) * 0.18;
    c += (5 - clamp(num(s.damping, 5), 1, 10)) * 2.2;
    var side = (ctx.geo.twF * ctx.geo.pF + ctx.geo.twR * ctx.geo.pR) / 2 / 100; // sidewall mm
    c += (side - 90) * 0.18;
    c -= (ctx.geo.d - 18) * 1.4;
    c += clamp((ctx.geo.rh - 110) * 0.04, -6, 5);
    var seat = opt('seatTypes', b.interior.seatType, 'sport');
    c += ({ comfort: 7, lounge: 10, sport: 2, bucket: -3, 'carbon-bucket': -6, 'race-shell': -10 }[seat.id] || 0);
    c += num(opt('upholsteries', b.interior.upholstery, 'leather').luxury, 0.5) * 4;
    if (b.weight.soundDeadening === false) c -= 6;
    c += num(ctx.geo.con && ctx.geo.con.comfort, 0);
    if (b.weight.rollCage === 'full') c -= 6; else if (b.weight.rollCage === 'half') c -= 3;
    if (b.interior.harness) c -= 3;
    c += (clamp(num(b.tech.climateZones, 2), 1, 4) - 2) * 1.5;
    c -= Math.max(0, ctx.noiseCabin - 70) * 0.8;
    if (ctx.geo.comp.id === 'slick' || ctx.geo.comp.id === 'track') c -= 6;
    if (ctx.geo.bs.id === 'van' || ctx.geo.bs.id === 'sedan') c += 4;
    if (ctx.E.type === 'ev') c += 3;
    if (b.transmission.type === 'sequential') c -= 4;
    if (b.transmission.type === 'auto' || b.transmission.type === 'cvt') c += 2;
    return clamp(c, 2, 99);
  }

  function noiseModel(b, ctx) {
    var E = ctx.E, comp = ctx.geo.comp, exh = E.exh;
    var exhaust;
    if (E.type === 'ev') exhaust = 56; // AVAS pedestrian warning
    else {
      exhaust = num(exh.loudness_db, 85) + Math.log(Math.max(1, E.V)) * 3 + (E.boosted && E.asp && E.asp.id !== 'supercharged' ? -3 : 0) +
        (E.lay && E.lay.config === 'rotary' ? 4 : 0) + (E.R > 8000 ? 2 : 0) + (E.isDiesel ? -2 : 0);
    }
    var cabin = 66 + (num(comp.noise, 70) - 68) * 0.6 + (b.weight.soundDeadening === false ? 5 : 0) +
      (E.type === 'ev' ? -4 : (num(exh.loudness_db, 85) - 85) * 0.22) +
      (ctx.geo.bs.id === 'roadster' ? 5 : 0) + (b.weight.glass === 'polycarbonate' ? 3 : b.weight.glass === 'thin' ? 1 : 0) +
      ((ctx.geo.twF + ctx.geo.twR) / 2 - 245) * 0.01 + (ctx.geo.d - 18) * 0.3 + (b.transmission.type === 'sequential' ? 3 : 0) +
      (b.suspension.type === 'coilover-track' || b.suspension.type === 'pushrod' ? 1.5 : 0) + (ctx.aero.wingDf > 120 ? 1 : 0) +
      (b.exterior.roof === 'glass' ? 0.5 : 0) + (b.tech.audio === 'concert' ? -2 : 0) + num(ctx.geo.con && ctx.geo.con.noise, 0);
    return { exhaust: clamp(exhaust, 40, 135), cabin: clamp(cabin, 52, 95) };
  }

  function logScore(x, best, worst) {
    if (!isNum(x) || x <= 0) return 0;
    return clamp(100 * (Math.log(worst) - Math.log(x)) / (Math.log(worst) - Math.log(best)), 0, 100);
  }

  function ratingsModel(b, ctx, mx) {
    var E = ctx.E;
    var acc = logScore(mx.zeroTo100_s, 1.9, 16);
    var handling = clamp((mx.lateralG - 0.68) / (1.6 - 0.68) * 85 + (1650 - ctx.mass) / 60 + ctx.grip.stiff * 8 +
      (b.drivetrain.torqueVectoring ? 3 : 0) - Math.abs(mx.balance) * 0.8 + (ctx.cgH < 470 ? (470 - ctx.cgH) / 20 : -(ctx.cgH - 470) / 15), 0, 100);
    var braking = clamp((50 - mx.brakingDist_100_0_m) / (50 - 27) * 92 + num(ctx.brakes.bm.fadeResistance, 0.5) * 8, 0, 100);
    var effWh = E.type === 'ev' ? mx.efficiency_whkm : mx.fuelEconomy_l100 * KWH_PER_L_GASOLINE_EQ * 10;
    var efficiency = logScore(effWh, 110, 2200);
    var bs = ctx.geo.bs;
    var seats = num(b.body.seats, 4) - (b.weight.rearSeats === false ? Math.max(0, num(b.body.seats, 4) - 2) : 0);
    var practicality = clamp(10 + seats * 7 + Math.min(30, num(bs.cargo_l, 300) / 40) + (num(b.body.doors, 2) >= 4 ? 8 : 0) +
      clamp((ctx.geo.rh - 90) * 0.08, -8, 8) + Math.min(10, mx.range_km / 80) - (b.weight.rollCage !== 'none' ? 10 : 0) -
      (ctx.geo.comp.id === 'slick' ? 15 : 0) - (bs.id === 'roadster' ? 6 : 0), 0, 100);
    var up = opt('upholsteries', b.interior.upholstery, 'leather'), au = b.tech.audio;
    var luxury = clamp(num(up.luxury, 0.5) * 30 + ({ delete: -5, track: 0, standard: 6, premium: 12, reference: 16, concert: 20 }[au] || 6) +
      ({ comfort: 8, lounge: 12, sport: 4, bucket: 0, 'carbon-bucket': 1, 'race-shell': -4 }[b.interior.seatType] || 0) +
      ({ cloth: 0, alcantara: 4, leather: 5 }[b.interior.headliner] || 0) + ({ 'gloss-walnut': 5, 'open-pore-wood': 4, 'brushed-titanium': 4, 'forged-carbon': 3, carbon: 2, 'piano-black': 1 }[b.interior.trim] || 1) +
      (num(b.tech.climateZones, 2) - 1) * 2 + (b.interior.ambientLighting ? 2 : 0) + (b.tech.hud ? 2 : 0) + (b.tech.nightVision ? 2 : 0) +
      ({ none: 0, assist: 2, plus: 4, pilot: 6, 'autonomous-l3': 8 }[b.tech.adas] || 0) + (mx.comfortIndex - 50) * 0.25 - Math.max(0, mx.noise_db_cabin - 68) * 0.8 +
      (b.exterior.lights === 'laser' || b.exterior.lights === 'matrix' ? 2 : 0) + (b.tech.screen_in >= 15 ? 2 : 0) + (E.type !== 'ev' && E.lay && num(E.lay.smoothness, 0.7) > 0.95 ? 3 : 0), 0, 100);
    var sound;
    if (E.type === 'ev') sound = 18;
    else {
      sound = clamp((mx.exhaust_db - 80) * 1.4 + num(SOUND_CHARACTER[E.lay.soundProfile], 0.6) * 40 + (E.R - 6000) / 150 +
        (E.boosted ? -5 : 4) + (E.isDiesel ? -15 : 0) + (E.type === 'hybrid' ? -4 : 0), 0, 100);
    }
    var track = clamp((205 - mx.lapTime_s) / (205 - 118) * 100, 0, 100);
    return {
      acceleration: Math.round(acc), handling: Math.round(handling), braking: Math.round(braking), comfort: Math.round(mx.comfortIndex),
      efficiency: Math.round(efficiency), reliability: Math.round(mx.reliabilityScore), practicality: Math.round(practicality),
      luxury: Math.round(luxury), sound: Math.round(sound), track: Math.round(track)
    };
  }

  /* ======================================================================
     COMPUTE
     ====================================================================== */
  function compute(input) {
    var b = complete(input);
    var geo = geometry(b);
    var E = engineModel(b);
    var mass = massModel(b, E, geo);
    var aero = aeroModel(b, geo);
    var grip = gripModel(b, geo, mass);
    var dl = drivelineModel(b, E, geo);
    var comp = geo.comp;
    var warnings = E.warnings.slice();

    var crr = num(comp.rollingResistance, 0.01) * (1 + Math.abs(num(b.suspension.toeFront_deg, 0)) * 0.15 + Math.abs(num(b.suspension.toeRear_deg, 0)) * 0.1) *
      (1 + ((geo.twF + geo.twR) / 2 - 245) * 0.0008);
    // rotating inertia of the four wheel assemblies (rim, tyre, rotor)
    var bd = mass.breakdown;
    var wheelInertia = 0.75 * num(bd.wheels, 90) * sq((geo.rF + geo.rR) / 2) * 0.85 + 0.5 * (geo.rotorKgF * 2 + geo.rotorKgR * 2) * sq(0.16);
    var latAssist = 1 + (b.drivetrain.torqueVectoring ? 0.025 : 0) + (dl.drivenLock > 0.5 ? 0.008 : 0) + (b.aero.activeAero ? 0.005 : 0);
    // top-speed governors: the tyres' speed rating (explicit, else the compound's), the eco map, the ECU speed limiter
    var rating = opt('tireSpeedRatings', b.tires.speedRating, 'compound');
    var tyreKph = isNum(rating.kph) && rating.kph > 0 ? rating.kph : num(TYRE_SPEED_RATING[comp.id], 300);
    var limKph = num(b.engine.speedLimiter_kph, 0) > 0 ? clamp(num(b.engine.speedLimiter_kph, 0), 60, 500) : 1e9;
    var ecoKph = E.tune && E.tune.id === 'eco' ? 180 : 1e9;
    var govKph = Math.min(tyreKph, ecoKph, limKph);
    var govBy = govKph === limKph ? 'limiter' : govKph === ecoKph ? 'eco' : 'tyres';
    var gov = govKph / 3.6;
    var ctx = {
      b: b, E: E, geo: geo, aero: aero, grip: grip, dl: dl, mass: mass.mass, wf: mass.wf, cgH: mass.cgH,
      wb: geo.wb, track: geo.track, crr: crr, wheelInertia: wheelInertia, latAssist: latAssist, governor: gov, heatDerate: 1
    };

    var top = topSpeed(ctx);
    ctx.top = top;
    var sim = simulate(ctx, top);
    var brakes = brakeModel(b, ctx);
    ctx.brakes = brakes;
    var heat = (E.type === 'ev' ? 0 : E.icePower_kw) / Math.max(1, E.coolingCapacity_kw);
    ctx.heatDerate = heat > 1 ? clamp(Math.pow(1 / heat, 0.35), 0.75, 1) : 1;
    var lat120 = lateralLimit(ctx, 120 / 3.6);
    var balance = ctx._lastBal; // >0: rear axle limits (oversteer); <0 front (understeer)
    var latLow = lateralLimit(ctx, 60 / 3.6);
    var lat200 = lateralLimit(ctx, 200 / 3.6);
    var lap = lapSim(ctx, brakes);
    var energy = energyModel(b, ctx);
    var noise = noiseModel(b, ctx);
    ctx.noiseCabin = noise.cabin;
    var peakT = E.peakTorque;
    ctx.peakTorqueAtBox = peakT;
    var reliability = reliabilityModel(b, ctx);
    var comfort = comfortModel(b, ctx);

    var powerKw = E.peakPower_w / 1000;
    var powerHp = powerKw / 0.7457;
    var dist100 = brakes.stopDist(100 / 3.6);
    var dist60ft = brakes.stopDist(60 * MPH) * 3.28084;
    var topKph = top.v * 3.6;

    // effective tyre μ at static load (reported)
    var FzF = mass.mass * G * mass.wf / 2, FzR = mass.mass * G * (1 - mass.wf) / 2;
    var gripFront = grip.muF * Math.max(0.35, 1 - grip.ks * (FzF / grip.Fz0F - 1));
    var gripRear = grip.muR * Math.max(0.35, 1 - grip.ks * (FzR / grip.Fz0R - 1));

    var gearSpeeds = [];
    if (dl.isCVT) gearSpeeds.push({ gear: 1, ratio: r(dl.cvtLow, 2), ratioMin: r(dl.cvtHigh, 2), maxKph: r(E.R * PI / 30 * dl.r / (dl.cvtHigh * dl.fd) * 3.6, 1) });
    else dl.ratios.forEach(function (ra, i) { gearSpeeds.push({ gear: i + 1, ratio: r(ra, 2), maxKph: r(E.R * PI / 30 * dl.r / (ra * dl.fd) * 3.6, 1) }); });

    var downforceCurve = [];
    for (var k = 0; k <= topKph + 1e-6; k += 20) downforceCurve.push({ kph: k, kg: r(aero.df200 * sq(k / 200), 1) });
    if (!downforceCurve.length || downforceCurve[downforceCurve.length - 1].kph < topKph - 0.5) downforceCurve.push({ kph: r(topKph, 0), kg: r(aero.df200 * sq(topKph / 200), 1) });

    // 0-60 note
    var note;
    if (sim.t60 == null) note = 'not reached';
    else if (sim.tractionTime60 > sim.t60 * 0.45) note = 'traction-limited';
    else if (sim.lagTime60 > sim.t60 * 0.35) note = 'boost-lag-limited';
    else if (sim.tractionTime60 > sim.t60 * 0.15) note = 'traction-limited at launch';
    else note = 'power-limited';

    /* --- warnings */
    var tg = Object.keys(sim.tractionGears).map(Number).sort(function (a, b2) { return a - b2; });
    if (tg.length >= 2 || (tg.length === 1 && tg[0] >= 2)) {
      var gLo = tg[0], gHi = tg[tg.length - 1];
      warnings.push('Wheelspin likely in ' + gLo + ordinal(gLo) + (gHi > gLo ? '-' + gHi + ordinal(gHi) : '') + ' gear');
    }
    if (E.knockOver > 0) warnings.push('Knock: effective compression ' + r(E.ecr, 1) + ':1 exceeds the ' + E.fuel.name + ' limit (' + E.knockLimit + ':1) — timing retarded, ' + Math.round((1 - E.knockF) * 100) + '% power lost');
    if (brakes.heatIndex > 1.05 && num(brakes.bm.fadeResistance, 0.5) < 0.8) warnings.push('Brake fade risk — rotors cannot absorb repeated stops from ' + Math.round(Math.min(topKph, 300)) + ' km/h');
    if (brakes.hydCapG < 1.05 * Math.max(gripFront, gripRear)) warnings.push('Brakes are hydraulically limited (' + r(brakes.hydCapG, 2) + ' g) — fit larger rotors or more pistons');
    if (peakT > dl.torqueLimit) warnings.push('Engine torque (' + Math.round(peakT) + ' Nm) exceeds the ' + dl.tr.name + ' rating (' + Math.round(dl.torqueLimit) + ' Nm) — torque is electronically limited');
    if (heat > 1.02) warnings.push('Cooling marginal: ' + Math.round(E.icePower_kw) + ' kW exceeds the ' + E.cool.name + ' capacity — expect heat-soak power loss on track');
    if (top.by === 'redline') warnings.push('Top speed is redline-limited at ' + Math.round(topKph) + ' km/h — a taller final drive or top gear would go faster');
    if (top.by === 'governor') warnings.push('Top speed governed at ' + Math.round(topKph) + ' km/h (' + (govBy === 'limiter' ? 'electronic speed limiter' : govBy === 'eco' ? 'eco map' : (b.tires.speedRating && b.tires.speedRating !== 'compound' ? rating.name + ' tyre' : comp.name) + ' speed rating') + ')');
    if (dl.layout === 'fwd' && peakT > 420) warnings.push('Torque steer: ' + Math.round(peakT) + ' Nm through the front wheels');
    if (E.boosted && E.lag > 0.35 && E.tau > 0.5) warnings.push('Noticeable turbo lag — full boost only above ' + Math.round(E.peakTorqueRpm) + ' rpm');
    if (grip.bottom < 0.99) warnings.push('Ride height too low for the spring rates — the chassis will bottom out over bumps');
    if (balance < -0.6) warnings.push('Strong understeer balance — soften the front anti-roll bar or add front grip');
    if (balance > 0.6) warnings.push('Snap-oversteer risk — rear axle saturates first');
    if (aero.df200 > 40 && (aero.dfFrontShare < 0.18 || aero.dfFrontShare > 0.65)) warnings.push('Aero imbalance — ' + Math.round(aero.dfFrontShare * 100) + '% of downforce on the front axle');
    if (mass.cgH > 640 && lat120 / G > 0.95) warnings.push('High centre of gravity with sticky tyres — rollover margin is low');
    if (geo.comp.id === 'slick') warnings.push('Slicks have almost no wet grip (' + Math.round(grip.wetRatio * 100) + '% of dry)');
    if (dl.tc === 0 && powerHp / (mass.mass / 1000) > 300) warnings.push('Traction control off with ' + Math.round(powerHp / (mass.mass / 1000)) + ' hp/ton — expert drivers only');
    if (E.type === 'ev' && energy.range < 250) warnings.push('Short range (' + Math.round(energy.range) + ' km)');
    if (b.brakes.abs === 'off') warnings.push('ABS off — braking distances depend on perfect brake bias (' + Math.round(brakes.bias * 100) + '% front)');

    var mx = {
      power_hp: r(powerHp, 1), power_kw: r(powerKw, 1), torque_nm: r(peakT, 1),
      peakPowerRpm: Math.round(E.peakPowerRpm), peakTorqueRpm: Math.round(E.peakTorqueRpm), idleRpm: Math.round(E.idle), redlineRpm: Math.round(E.R),
      curve: E.curve,
      icePower_hp: E.type === 'ev' ? 0 : r(E.icePower_kw / 0.7457, 1),
      electricPower_kw: E.type === 'ev' ? r(powerKw, 1) : r(E.hybridKw, 1),
      bmep_bar: E.type === 'ev' ? null : r(E.bmepPeak_bar, 1),
      specificOutput_hpPerL: E.type === 'ev' ? null : r(powerHp / Math.max(0.5, E.V), 1),
      effectiveCompression: E.type === 'ev' ? null : r(E.ecr, 2),
      knockMargin: E.type === 'ev' || E.isDiesel ? null : r(E.knockLimit - E.ecr, 2),
      weight_kg: r(mass.mass, 0), weightFront_pct: r(mass.wf * 100, 1), weightRear_pct: r(100 - mass.wf * 100, 1),
      idealFront_pct: mass.ePos === 'mid' ? 42 : mass.ePos === 'rear' ? 38 : dl.layout === 'fwd' ? 60 : 50,
      weightBreakdown: mass.breakdown, unsprung_kg: r(mass.unsprung.front + mass.unsprung.rear, 1),
      cgHeight_mm: r(mass.cgH, 0), yawInertia_kgm2: r(mass.Iz, 0),
      powerToWeight_hpPerTon: r(powerHp / (mass.mass / 1000), 1),
      cd: r(aero.cd, 3), frontalArea_m2: r(aero.area, 2), cda: r(aero.cda, 3), downforce_kg_200: r(aero.df200, 1),
      aeroBalanceFront_pct: r(aero.dfFrontShare * 100, 1), downforceCurve: downforceCurve,
      gripFront: r(gripFront, 3), gripRear: r(gripRear, 3),
      lateralG: r(lat120 / G, 3), lateralG_low: r(latLow / G, 3), lateralG_200: r(lat200 / G, 3),
      balance: r(balance, 2), balanceNote: balance < -0.25 ? 'understeer' : balance > 0.25 ? 'oversteer' : 'neutral',
      brakingDist_100_0_m: r(dist100, 1), brakingDist_60_0_ft: r(dist60ft, 1), brakeBiasFront_pct: r(brakes.bias * 100, 1),
      brakeHeatIndex: r(brakes.heatIndex, 2),
      zeroTo60_s: sim.t60 == null ? null : r(sim.t60, 2), zeroTo100_s: sim.t100 == null ? null : r(sim.t100, 2),
      zeroTo200_s: sim.t200 == null ? null : r(sim.t200, 2),
      quarterMile_s: sim.tQM == null ? null : r(sim.tQM, 2), quarterMileTrap_mph: sim.trapQM == null ? null : r(sim.trapQM / MPH, 1),
      topSpeed_kph: r(topKph, 1), topSpeed_mph: r(topKph / 1.609344, 1), topSpeedLimitedBy: top.by,
      topSpeedGovernor: top.by === 'governor' ? govBy : null, tyreSpeedRating_kph: tyreKph,
      speedLimiter_kph: limKph < 1e9 ? limKph : 0,
      accelCurve: sim.curve, gearSpeeds: gearSpeeds, shiftTime_s: dl.shift, finalDrive: dl.fd,
      wheelRadius_m: r(dl.r, 3),
      fuelEconomy_l100: r(energy.l100, 2), fuelEconomy_mpg: r(235.215 / Math.max(0.1, energy.l100), 1),
      range_km: r(energy.range, 0), co2_gkm: r(energy.co2, 0),
      efficiency_whkm: E.type === 'ev' ? r(energy.whkm, 1) : null,
      electricRange_km: E.type === 'ev' ? r(energy.range, 0) : E.type === 'hybrid' ? r(energy.evRange, 0) : 0,
      battery_kwh: E.type === 'ev' ? E.kwh : E.type === 'hybrid' ? clamp(num(b.engine.battery_kwh, 10), 0.5, 40) : 0,
      lapTime_s: r(lap.time, 3), lapSectors: lap.sectors.map(function (s) { return r(s, 3); }),
      lapMinSpeed_kph: r(lap.vmin * 3.6, 1), lapMaxSpeed_kph: r(lap.vmax * 3.6, 1), lapFullThrottle_pct: r(lap.fullThrottlePct, 1),
      track: { name: 'Redline Ring', length_km: 5.8 },
      reliabilityScore: r(reliability, 0), comfortIndex: r(comfort, 0),
      noise_db_cabin: r(noise.cabin, 1), exhaust_db: r(noise.exhaust, 1),
      zeroTo60_note: note,
      warnings: warnings
    };
    mx.ratings = ratingsModel(b, ctx, mx);
    return sanitize(mx);
  }

  function ordinal(n) { return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'; }

  /** Safe wrapper: never throws; returns minimal finite metrics with a warning on internal failure. */
  function safeCompute(build) {
    try { return compute(build); }
    catch (err) {
      if (typeof console !== 'undefined' && console.error) console.error('[CB.physics] compute failed', err);
      return fallbackMetrics(String(err && err.message || err));
    }
  }
  function fallbackMetrics(msg) {
    var z = { acceleration: 0, handling: 0, braking: 0, comfort: 0, efficiency: 0, reliability: 0, practicality: 0, luxury: 0, sound: 0, track: 0 };
    return {
      power_hp: 0, power_kw: 0, torque_nm: 0, peakPowerRpm: 0, peakTorqueRpm: 0, idleRpm: 0, redlineRpm: 0, curve: [],
      weight_kg: 0, weightFront_pct: 50, cgHeight_mm: 0, powerToWeight_hpPerTon: 0, cd: 0, frontalArea_m2: 0, cda: 0,
      downforce_kg_200: 0, downforceCurve: [], gripFront: 0, gripRear: 0, lateralG: 0, brakingDist_100_0_m: 0, brakingDist_60_0_ft: 0,
      zeroTo60_s: null, zeroTo100_s: null, zeroTo200_s: null, quarterMile_s: null, quarterMileTrap_mph: null,
      topSpeed_kph: 0, topSpeed_mph: 0, topSpeedLimitedBy: 'drag', accelCurve: [], gearSpeeds: [],
      fuelEconomy_l100: 0, fuelEconomy_mpg: 0, range_km: 0, co2_gkm: 0, efficiency_whkm: null,
      lapTime_s: 0, lapSectors: [0, 0, 0], ratings: z, reliabilityScore: 0, comfortIndex: 0, noise_db_cabin: 0, exhaust_db: 0,
      zeroTo60_note: 'unavailable', warnings: ['Physics model error: ' + msg], _error: true
    };
  }

  /** Downforce (kg) of a computed metrics object at a given speed. */
  function downforceAt(metrics, kph) { return num(metrics && metrics.downforce_kg_200, 0) * sq(num(kph, 0) / 200); }

  CB.physics = {
    version: 2,
    compute: safeCompute,
    _computeUnsafe: compute,
    downforceAt: downforceAt,
    tyreSpeedRating: function (compoundId) { return num(TYRE_SPEED_RATING[compoundId], 300); },
    track: {
      name: 'Redline Ring', length_m: 5800,
      segments: TRACK_SEGMENTS.map(function (s) { return { name: s.name, len: s.len, radius: s.radius, sector: s.sector }; })
    },
    constants: { g: G, airDensity: RHO, fuelTank_l: FUEL_TANK_L, dt: DT, evMaxRpm: EV_MAX_RPM, quarterMile_m: QUARTER_MILE_M }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.physics;

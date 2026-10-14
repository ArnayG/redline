/* ==========================================================================
   FORGE Atelier — js/race/vehicle.js
   CB.race.vehicle : real-time vehicle dynamics derived from a configurator build.

   Pure logic (no DOM). Loads in browsers (classic <script>) and in Node.

   Model overview
   --------------
   * Planar 4-wheel model in body axes (x forward, y left, yaw CCW positive).
     World frame: heading 0 = +x, CCW positive (matches RACE-SPEC / tracks).
   * Per-wheel spin state (omega) solved with a linearised implicit update
     (unconditionally stable for the stiff tyre/wheel coupling at dt = 1/120).
   * "Pacejka-lite" tyre: magic-formula shape on a normalised combined slip
     vector, friction ellipse (separate longitudinal / lateral mu), load
     sensitivity, compound-dependent peak/slide behaviour, wet sensitivity.
   * Quasi-static load transfer (longitudinal + lateral, roll-stiffness
     distribution from springs / ARBs) with a suspension lag filter, plus
     aero downforce split front/rear from the build's aero parts.
   * Aero drag (incl. side drag when sliding), rolling resistance, surface drag.
   * Engine: resampled torque curve (from metrics.curve or derived from the
     build), turbo spool lag, engine braking / EV regen, rev limiter with
     fuel-cut hysteresis, top-speed governor.
   * Driveline: auto clutch with launch slip (+ launch control), torque
     converter multiplication for automatics, gearbox with shift time and
     torque interruption (DCT partial overlap), CVT, single-speed EV,
     reverse gear, auto-shift logic with hysteresis + kickdown + braking
     downshifts, or manual (edge-triggered shiftUp / shiftDown).
   * Differentials: open (equal torque), LSD / locking (speed equalisation
     strength = catalog lockFactor), AWD centre coupling + torque split,
     torque vectoring yaw assist.
   * Traction control (slip-target throttle cut + ESC-style yaw guard), ABS
     (per-wheel brake modulation), handbrake (rear lock + rear decouple).
   * Speed-sensitive steering limit and rate limit, Ackermann geometry,
     optional counter-steer assist.
   * Low-speed kinematic blend so the car is calm and exact at 0 m/s.

   CONVENTIONS (binding for callers):
     input.steer  +1 = steer LEFT (CCW, heading increases), -1 = RIGHT.
     state.steerAngle  rad, + = left.
     state.vx / vy     BODY-frame velocity (m/s), vy + = left.
     Use vehicle.worldVelocity(state) / setWorldVelocity / applyImpulse for
     collision handling in world space.

   createState(params, pose, opts?) — opts.autoShift (or pose.autoShift) selects auto/manual gearbox;
   env.assists.autoShift overrides per step.
   env: { gripMult (surface x weather), wet (bool), wetness (0..1, preferred), surface, assists{abs,tc,autoShift,
   steeringAssist} }. Compound wet behaviour is applied relative to a typical road tyre when gripMult already
   carries a weather factor (< 0.95), absolute otherwise.
   Brake bias is derived from the ideal 1 g split + margin (front-biased => stable under braking); ABS is
   combined-slip aware (cornering brake control); TC uses slip velocity with a low-speed floor.

   Reverse: when (nearly) stopped and brake held with no throttle for ~0.4 s
   the car selects reverse (both auto and manual mode). In reverse the BRAKE
   pedal drives backwards and the THROTTLE pedal brakes; pressing throttle
   while (nearly) stopped in reverse re-selects 1st gear.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.race = CB.race || {};

(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */
  var G = 9.81;
  var RHO = 1.225;
  var TWO_PI = Math.PI * 2;
  var RPM_TO_RADS = TWO_PI / 60;
  var RADS_TO_RPM = 60 / TWO_PI;
  var V200 = 200 / 3.6;
  var MAX_SUBSTEP = 1 / 240;
  var V_LOW_LONG = 3.0;   // slip-ratio denominator floor (m/s)
  var V_LOW_LAT = 3.0;    // slip-angle denominator floor (m/s)
  var KIN_V0 = 0.8;       // below: fully kinematic
  var KIN_V1 = 3.2;       // above: fully dynamic

  /* -------------------------------------------------------------- helpers */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function approach(cur, target, maxDelta) {
    if (cur < target) return Math.min(cur + maxDelta, target);
    return Math.max(cur - maxDelta, target);
  }
  function wrapAngle(a) {
    a = a % TWO_PI;
    if (a > Math.PI) a -= TWO_PI; else if (a < -Math.PI) a += TWO_PI;
    return a;
  }
  function get(obj, path, d) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length; i++) {
      if (o == null) return d;
      o = o[parts[i]];
    }
    return o === undefined ? d : o;
  }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }

  /* ---------------------------------------------------- fallback catalog
     Used when CB.data is missing or a catalog option lacks a field.
     Catalog values (when present & finite) always win.                    */
  var FB = {
    bodyStyles: {
      'coupe':          { baseWeight_kg: 1300, cd: 0.31, frontalArea_m2: 2.00, cgHeight_mm: 480, length_m: 4.55, defaultWheelbase: 2650 },
      'sedan':          { baseWeight_kg: 1400, cd: 0.29, frontalArea_m2: 2.20, cgHeight_mm: 520, length_m: 4.90, defaultWheelbase: 2850 },
      'hatchback':      { baseWeight_kg: 1080, cd: 0.32, frontalArea_m2: 2.10, cgHeight_mm: 530, length_m: 4.15, defaultWheelbase: 2550 },
      'wagon':          { baseWeight_kg: 1480, cd: 0.30, frontalArea_m2: 2.25, cgHeight_mm: 540, length_m: 4.90, defaultWheelbase: 2850 },
      'suv':            { baseWeight_kg: 1800, cd: 0.36, frontalArea_m2: 2.70, cgHeight_mm: 680, length_m: 4.85, defaultWheelbase: 2900 },
      'roadster':       { baseWeight_kg: 1050, cd: 0.34, frontalArea_m2: 1.90, cgHeight_mm: 440, length_m: 4.10, defaultWheelbase: 2400 },
      'pickup':         { baseWeight_kg: 2000, cd: 0.42, frontalArea_m2: 3.00, cgHeight_mm: 720, length_m: 5.60, defaultWheelbase: 3300 },
      'hypercar':       { baseWeight_kg: 1000, cd: 0.28, frontalArea_m2: 1.80, cgHeight_mm: 380, length_m: 4.60, defaultWheelbase: 2700 },
      'shooting-brake': { baseWeight_kg: 1420, cd: 0.30, frontalArea_m2: 2.10, cgHeight_mm: 500, length_m: 4.75, defaultWheelbase: 2750 },
      'van':            { baseWeight_kg: 1900, cd: 0.35, frontalArea_m2: 3.20, cgHeight_mm: 780, length_m: 5.10, defaultWheelbase: 3200 },
      _default:         { baseWeight_kg: 1350, cd: 0.32, frontalArea_m2: 2.15, cgHeight_mm: 520, length_m: 4.60, defaultWheelbase: 2700 }
    },
    chassisMaterials: {
      'steel': { weightFactor: 1.0, stiffness: 0.5 }, 'high-strength-steel': { weightFactor: 0.95, stiffness: 0.6 },
      'aluminum': { weightFactor: 0.85, stiffness: 0.7 }, 'carbon-tub': { weightFactor: 0.76, stiffness: 0.85 },
      'carbon-monocoque': { weightFactor: 0.68, stiffness: 1.0 }, _default: { weightFactor: 1.0, stiffness: 0.5 }
    },
    engineLayouts: {
      'I3': { cylinders: 3, baseWeight_kg: 100 }, 'I4': { cylinders: 4, baseWeight_kg: 130 }, 'I5': { cylinders: 5, baseWeight_kg: 160 },
      'I6': { cylinders: 6, baseWeight_kg: 190 }, 'V6': { cylinders: 6, baseWeight_kg: 175 }, 'V8': { cylinders: 8, baseWeight_kg: 220 },
      'V10': { cylinders: 10, baseWeight_kg: 250 }, 'V12': { cylinders: 12, baseWeight_kg: 290 }, 'W16': { cylinders: 16, baseWeight_kg: 420 },
      'flat-4': { cylinders: 4, baseWeight_kg: 125 }, 'flat-6': { cylinders: 6, baseWeight_kg: 180 }, 'rotary-2': { cylinders: 2, baseWeight_kg: 90 },
      _default: { cylinders: 6, baseWeight_kg: 190 }
    },
    aspirations: {
      'na': { weight_kg: 0, lag: 0, forced: false }, 'turbo': { weight_kg: 25, lag: 0.55, forced: true },
      'twin-turbo': { weight_kg: 40, lag: 0.38, forced: true }, 'quad-turbo': { weight_kg: 70, lag: 0.42, forced: true },
      'supercharged': { weight_kg: 30, lag: 0.04, forced: true, linear: true }, 'twincharged': { weight_kg: 50, lag: 0.15, forced: true },
      'electric-turbo': { weight_kg: 35, lag: 0.08, forced: true }, _default: { weight_kg: 0, lag: 0, forced: false }
    },
    fuels: {
      'regular': { power: 0.96 }, 'premium': { power: 1.0 }, 'e85': { power: 1.06 }, 'race': { power: 1.08 }, 'diesel': { power: 0.82 },
      _default: { power: 1.0 }
    },
    tunes: {
      'eco': { powerMult: 0.9 }, 'stock': { powerMult: 1.0 }, 'stage1': { powerMult: 1.12 }, 'stage2': { powerMult: 1.25 },
      'stage3': { powerMult: 1.4 }, 'time-attack': { powerMult: 1.55 }, _default: { powerMult: 1.0 }
    },
    exhausts: {
      'stock': { powerMult: 1.0, weight_kg: 0 }, 'sport': { powerMult: 1.03, weight_kg: -3 }, 'titanium': { powerMult: 1.05, weight_kg: -9 },
      'straight-pipe': { powerMult: 1.07, weight_kg: -12 }, 'valvetronic': { powerMult: 1.04, weight_kg: 2 }, _default: { powerMult: 1.0, weight_kg: 0 }
    },
    coolings: { 'standard': { weight_kg: 0 }, 'uprated': { weight_kg: 6 }, 'race': { weight_kg: 10 }, _default: { weight_kg: 0 } },
    batteryChemistries: {
      'lfp': { whPerKg: 160 }, 'nmc': { whPerKg: 250 }, 'nca': { whPerKg: 270 }, 'solid-state': { whPerKg: 400 }, _default: { whPerKg: 230 }
    },
    transmissions: {
      'manual': { shiftTime_s: 0.38, efficiency: 0.95, weight_kg: 45, cut: 0.0 },
      'dct': { shiftTime_s: 0.09, efficiency: 0.93, weight_kg: 75, cut: 0.4 },
      'auto': { shiftTime_s: 0.24, efficiency: 0.90, weight_kg: 85, cut: 0.3, converter: true },
      'cvt': { shiftTime_s: 0, efficiency: 0.87, weight_kg: 70, cvt: true },
      'sequential': { shiftTime_s: 0.12, efficiency: 0.95, weight_kg: 55, cut: 0.0 },
      'single-speed': { shiftTime_s: 0, efficiency: 0.96, weight_kg: 30 },
      _default: { shiftTime_s: 0.25, efficiency: 0.92, weight_kg: 60, cut: 0.0 }
    },
    differentials: {
      'none': { lockFactor: 0 }, 'open': { lockFactor: 0 }, 'lsd-viscous': { lockFactor: 0.3 }, 'lsd-clutch': { lockFactor: 0.5 },
      'lsd-torsen': { lockFactor: 0.6 }, 'e-diff': { lockFactor: 0.7 }, 'locking': { lockFactor: 1.0 }, _default: { lockFactor: 0 }
    },
    suspensionTypes: {
      'macpherson': { gripMult: 0.97 }, 'double-wishbone': { gripMult: 1.02 }, 'multilink': { gripMult: 1.0 }, 'pushrod': { gripMult: 1.06 },
      'air': { gripMult: 0.98 }, 'magnetic': { gripMult: 1.03 }, 'coilover-track': { gripMult: 1.07 }, _default: { gripMult: 1.0 }
    },
    brakeMaterials: {
      'iron': { frictionMult: 1.0, weightPerRotor_kg: 11 }, 'drilled-slotted': { frictionMult: 1.04, weightPerRotor_kg: 10 },
      'two-piece': { frictionMult: 1.07, weightPerRotor_kg: 8.5 }, 'carbon-ceramic': { frictionMult: 1.15, weightPerRotor_kg: 5.5 },
      _default: { frictionMult: 1.0, weightPerRotor_kg: 10 }
    },
    wheelMaterials: {
      'steel': { weightFactor: 1.25 }, 'cast': { weightFactor: 1.0 }, 'flow-formed': { weightFactor: 0.92 }, 'forged': { weightFactor: 0.82 },
      'magnesium': { weightFactor: 0.72 }, 'carbon': { weightFactor: 0.62 }, _default: { weightFactor: 1.0 }
    },
    tireCompounds: {
      'eco':         { mu: 0.78, wetMu: 0.60, rollingResistance: 0.0075, shapeC: 1.30, stiff: 0.88 },
      'all-season':  { mu: 0.86, wetMu: 0.70, rollingResistance: 0.0095, shapeC: 1.33, stiff: 0.92 },
      'winter':      { mu: 0.80, wetMu: 0.74, rollingResistance: 0.0115, shapeC: 1.28, stiff: 0.80 },
      'touring':     { mu: 0.92, wetMu: 0.70, rollingResistance: 0.0095, shapeC: 1.36, stiff: 0.95 },
      'performance': { mu: 1.00, wetMu: 0.72, rollingResistance: 0.0105, shapeC: 1.42, stiff: 1.00 },
      'super-sport': { mu: 1.12, wetMu: 0.68, rollingResistance: 0.0115, shapeC: 1.46, stiff: 1.06 },
      'track':       { mu: 1.28, wetMu: 0.55, rollingResistance: 0.0125, shapeC: 1.52, stiff: 1.12 },
      'slick':       { mu: 1.50, wetMu: 0.36, rollingResistance: 0.0135, shapeC: 1.60, stiff: 1.20 },
      _default:      { mu: 0.95, wetMu: 0.70, rollingResistance: 0.0100, shapeC: 1.40, stiff: 1.00 }
    },
    'aero.splitters': {
      'none': { downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 }, 'lip': { downforce_kg_at_200: 15, dragDelta: 0.004, weight_kg: 2 },
      'carbon': { downforce_kg_at_200: 32, dragDelta: 0.007, weight_kg: 3 }, 'race': { downforce_kg_at_200: 60, dragDelta: 0.012, weight_kg: 5 },
      _default: { downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 }
    },
    'aero.wings': {
      'none': { downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 }, 'ducktail': { downforce_kg_at_200: 22, dragDelta: 0.004, weight_kg: 3 },
      'lip-spoiler': { downforce_kg_at_200: 15, dragDelta: 0.003, weight_kg: 2 }, 'swan-neck': { downforce_kg_at_200: 130, dragDelta: 0.030, weight_kg: 9, adjustable: true },
      'gt-wing': { downforce_kg_at_200: 160, dragDelta: 0.036, weight_kg: 10, adjustable: true }, 'active': { downforce_kg_at_200: 120, dragDelta: 0.016, weight_kg: 14, adjustable: true },
      'biplane': { downforce_kg_at_200: 230, dragDelta: 0.052, weight_kg: 14, adjustable: true },
      _default: { downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 }
    },
    'aero.diffusers': {
      'none': { downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 }, 'mild': { downforce_kg_at_200: 15, dragDelta: 0.001, weight_kg: 2 },
      'carbon': { downforce_kg_at_200: 36, dragDelta: 0.002, weight_kg: 3 }, 'race': { downforce_kg_at_200: 75, dragDelta: 0.004, weight_kg: 5 },
      _default: { downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 }
    }
  };

  /** Look up a catalog option merged over the fallback entry. */
  function opt(coll, id) {
    var fbColl = FB[coll] || {};
    var base = fbColl[id] || fbColl._default || {};
    var cat = null;
    var data = CB.data;
    if (data && id != null) {
      try {
        if (typeof data.find === 'function') cat = data.find(coll, id);
        if (!cat) {
          var arr = get(data, coll, null);
          if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) { cat = arr[i]; break; }
        }
      } catch (e) { cat = null; }
    }
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    if (cat) for (k in cat) {
      var v = cat[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'number' && !isFinite(v)) continue;
      out[k] = v;
    }
    out.id = id;
    return out;
  }

  function defaultRatios(n) {
    var table = {
      1: [1.0], 2: [2.5, 1.4], 3: [2.9, 1.6, 1.0], 4: [3.3, 2.0, 1.35, 1.0], 5: [3.5, 2.1, 1.45, 1.1, 0.88],
      6: [3.6, 2.2, 1.55, 1.2, 0.98, 0.82], 7: [3.8, 2.6, 1.9, 1.45, 1.15, 0.95, 0.78],
      8: [4.7, 3.1, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67], 9: [4.7, 2.84, 1.91, 1.38, 1.0, 0.81, 0.7, 0.58, 0.48],
      10: [4.7, 2.99, 2.15, 1.8, 1.52, 1.28, 1.0, 0.85, 0.69, 0.64]
    };
    return (table[n] || table[6]).slice();
  }

  /* --------------------------------------------------- torque curve tools */
  var CURVE_STEP = 50; // rpm resolution of the resampled table

  function makeTable(rpms, nms, maxRpm) {
    var n = Math.ceil(maxRpm / CURVE_STEP) + 2;
    var tab = new Array(n);
    var j = 0;
    for (var i = 0; i < n; i++) {
      var r = i * CURVE_STEP;
      while (j < rpms.length - 2 && rpms[j + 1] < r) j++;
      var v;
      if (r <= rpms[0]) v = nms[0];
      else if (r >= rpms[rpms.length - 1]) v = nms[nms.length - 1];
      else {
        var r0 = rpms[j], r1 = rpms[j + 1];
        v = r1 > r0 ? lerp(nms[j], nms[j + 1], (r - r0) / (r1 - r0)) : nms[j];
      }
      tab[i] = Math.max(0, fin(v, 0));
    }
    return tab;
  }

  function lookupTorque(p, rpm) {
    if (rpm <= 0) return p.torqueTable[0];
    var f = rpm / CURVE_STEP;
    var i = Math.floor(f);
    var tab = p.torqueTable;
    if (i >= tab.length - 1) return tab[tab.length - 1];
    var t = f - i;
    return tab[i] + (tab[i + 1] - tab[i]) * t;
  }

  /** Shape function (0..1-ish) of torque vs rpm fraction for an aspiration. */
  function torqueShape(kind, x) {
    switch (kind) {
      case 'turbo':
        return (0.34 + 0.66 * smoothstep(0.10, 0.36, x)) * (1 - 0.30 * smoothstep(0.62, 1.02, x));
      case 'supercharged':
        return (0.72 + 0.28 * smoothstep(0.08, 0.55, x)) * (1 - 0.14 * smoothstep(0.72, 1.0, x));
      case 'diesel':
        return (0.45 + 0.55 * smoothstep(0.12, 0.32, x)) * (1 - 0.45 * smoothstep(0.55, 1.0, x));
      case 'rotary':
        return 0.62 + 0.38 * Math.exp(-Math.pow((x - 0.78) / 0.30, 2));
      default: // na
        return 0.58 + 0.42 * Math.exp(-Math.pow((x - 0.70) / 0.34, 2));
    }
  }

  /* ----------------------------------------------- build-derived estimates */

  function estimatePowerKw(build) {
    var e = build.engine || {};
    var type = e.type || 'ice';
    var motorKw = num(e.motors, 0) * num(e.motorPower_kw, 0);
    if (type === 'ev') return clamp(motorKw || 300, 40, 2500);
    var disp = clamp(num(e.displacement_l, 3.0), 0.6, 9.0);
    var red = clamp(num(e.redline_rpm, 7000), 4000, 10000);
    var asp = opt('aspirations', e.aspiration || 'na');
    var fuel = opt('fuels', e.fuel || 'premium');
    var tune = opt('tunes', e.tune || 'stock');
    var exh = opt('exhausts', e.exhaust || 'stock');
    var isDiesel = e.fuel === 'diesel';
    var layO = opt('engineLayouts', e.layout || 'V6');
    var hpPerL = isFinite(layO.specificOutputNA_hpPerL)
      ? layO.specificOutputNA_hpPerL * Math.pow(red / fin(layO.typicalRedline, red), 0.7)
      : 62 + (red - 6000) * 0.011;
    if (e.layout === 'rotary-2' && !isFinite(layO.specificOutputNA_hpPerL)) hpPerL *= 1.35;
    var cr = clamp(num(e.compression, 10), 7, 15);
    var crMult = 1 + (cr - (asp.forced ? 9.5 : 11)) * 0.025;
    var boost = asp.forced ? clamp(num(e.boost_bar, 1.0), 0, 3.5) : 0;
    var boostMult = 1;
    if (asp.forced) {
      if (isFinite(asp.powerMult) && isFinite(asp.typicalBoost_bar) && asp.typicalBoost_bar > 0)
        boostMult = 1 + (asp.powerMult - 1) * clamp(boost / asp.typicalBoost_bar, 0.3, 2.5);
      else boostMult = 1 + 0.55 * Math.max(boost, 0.3);
    }
    var fuelPow = fin(fuel.powerPotential, fin(fuel.power, 1));
    if (isDiesel) fuelPow = 0.82;
    var hp = disp * hpPerL * crMult * boostMult * fuelPow * fin(tune.powerMult, 1) * fin(exh.powerMult, 1);
    var kw = hp * 0.7457;
    if (type === 'hybrid') kw += motorKw * 0.85;
    return clamp(kw, 30, 2500);
  }

  function estimateMass(build) {
    var b = build.body || {}, e = build.engine || {}, w = build.weight || {};
    var bs = opt('bodyStyles', b.style || 'coupe');
    var cm = opt('chassisMaterials', b.chassisMaterial || 'steel');
    var type = e.type || 'ice';
    var m = fin(bs.baseWeight_kg, 1350) * fin(cm.weightFactor, 1);
    // body base weight is assumed to carry a generic drivetrain allowance: powertrain parts count at 70 %
    var pt = 0;
    var tr = opt('transmissions', get(build, 'transmission.type', 'dct'));
    pt += fin(tr.weight_kg, 60);
    if (type !== 'ev') {
      var lay = opt('engineLayouts', e.layout || 'V6');
      pt += fin(lay.baseWeight_kg, 190) * (0.75 + 0.25 * clamp(num(e.displacement_l, 3) / 4, 0.4, 2));
      pt += fin(opt('aspirations', e.aspiration || 'na').weight_kg, 0);
      m += fin(opt('exhausts', e.exhaust || 'stock').weight_kg, 0);
      m += fin(opt('coolings', e.cooling || 'standard').weight_kg, 0);
    }
    m += pt * 0.7;
    if (type === 'ev' || type === 'hybrid') {
      var chem = opt('batteryChemistries', e.chemistry || 'nmc');
      var kwh = clamp(num(e.battery_kwh, type === 'ev' ? 80 : 10), 0.5, 250);
      m += kwh * 1000 / fin(chem.whPerKg, 230) * 1.35;
      m += num(e.motors, 1) * (type === 'ev' ? 48 : 32);
    }
    var wm = opt('wheelMaterials', get(build, 'wheels.material', 'cast'));
    var diam = num(get(build, 'wheels.diameter_in', 19), 19);
    m += 4 * 21 * (fin(wm.weightFactor, 1) * Math.pow(diam / 18, 1.4) - 1);
    var bm = opt('brakeMaterials', get(build, 'brakes.material', 'iron'));
    m += 4 * (fin(bm.weightPerRotor_kg, 10) - 10);
    ['aero.splitters:splitter', 'aero.wings:wing', 'aero.diffusers:diffuser'].forEach(function (s) {
      var parts = s.split(':');
      m += fin(opt(parts[0], get(build, 'aero.' + parts[1], 'none')).weight_kg, 0);
    });
    if (w.soundDeadening === false) m -= 25;
    if (w.rearSeats === false) m -= 28;
    if (w.spareTire) m += 18;
    if (w.glass === 'thin') m -= 10; else if (w.glass === 'polycarbonate') m -= 22;
    if (w.battery === 'lithium') m -= 12;
    if (w.rollCage === 'half') m += 25; else if (w.rollCage === 'full') m += 45;
    m += clamp(num(w.ballast_kg, 0), 0, 200);
    return clamp(m, 550, 4500);
  }

  function estimateWeightFront(build) {
    var e = build.engine || {}, w = build.weight || {};
    var pos = e.position || 'front';
    var f = e.type === 'ev' ? 48 : pos === 'mid' ? 42 : pos === 'rear' ? 38 : 54;
    var lay = e.layout;
    if (e.type !== 'ev' && pos === 'front') {
      if (lay === 'V12' || lay === 'W16' || lay === 'V10') f += 2;
      if (lay === 'I3' || lay === 'rotary-2') f -= 2;
    }
    var dl = get(build, 'drivetrain.layout', 'rwd');
    if (dl === 'fwd') f += 4; else if (dl === 'awd') f += 1;
    var trT = get(build, 'transmission.type', '');
    if (dl === 'rwd' && pos === 'front' && (trT === 'dct' || trT === 'sequential')) f -= 2; // transaxle-ish
    var bal = clamp(num(w.ballast_kg, 0), 0, 200);
    if (w.ballastPosition === 'front') f += bal * 0.03; else if (w.ballastPosition === 'rear') f -= bal * 0.03;
    var st = get(build, 'body.style', 'coupe');
    if (st === 'pickup' || st === 'van') f += 2;
    return clamp(f, 30, 68);
  }

  /** Synthesises a torque curve [{rpm, nm}] from the build. */
  function deriveCurve(build, powerKw, idle, redline, isEV) {
    var e = build.engine || {};
    var pts = [];
    var rpm, i;
    if (isEV) {
      var maxR = 16000, baseR = 5200;
      var w = baseR * RPM_TO_RADS;
      var T = powerKw * 1000 / w;
      for (rpm = 0; rpm <= maxR; rpm += 250) {
        var x = Math.max(rpm, 1);
        var tq = rpm <= baseR ? T : T * baseR / x;
        tq *= 1 - 0.12 * smoothstep(0.85 * maxR, maxR, rpm);
        pts.push({ rpm: rpm, nm: tq });
      }
      return pts;
    }
    var asp = opt('aspirations', e.aspiration || 'na');
    var kind = 'na';
    if (e.fuel === 'diesel') kind = 'diesel';
    else if (e.layout === 'rotary-2' && !asp.forced) kind = 'rotary';
    else if (asp.linear || e.aspiration === 'supercharged') kind = 'supercharged';
    else if (asp.forced) kind = 'turbo';
    var raw = [];
    var maxP = 0;
    for (rpm = idle; rpm <= redline + 1; rpm += 250) {
      var t = torqueShape(kind, rpm / redline);
      raw.push([rpm, t]);
      maxP = Math.max(maxP, t * rpm * RPM_TO_RADS);
    }
    var scale = powerKw * 1000 / maxP;
    var hybridKw = e.type === 'hybrid' ? num(e.motors, 1) * num(e.motorPower_kw, 0) * 0.85 : 0;
    var engineScale = hybridKw > 0 ? (powerKw - hybridKw) * 1000 / maxP : scale;
    var mT = hybridKw > 0 ? hybridKw * 1000 / (0.35 * redline * RPM_TO_RADS) : 0;
    for (i = 0; i < raw.length; i++) {
      var nm = raw[i][1] * engineScale;
      if (hybridKw > 0) {
        var wR = raw[i][0] * RPM_TO_RADS;
        nm += Math.min(mT, hybridKw * 1000 / Math.max(wR, 1));
      }
      pts.push({ rpm: raw[i][0], nm: nm });
    }
    return pts;
  }

  /* --------------------------------------------------------- fromBuild */

  /**
   * fromBuild(build, metrics|null, opts?) -> frozen params.
   * metrics: CB.physics.compute(build) output. If null, CB.physics is tried
   * (unless opts.noPhysics) and otherwise everything is derived from the
   * build + catalog (with built-in fallbacks for missing catalog entries).
   */
  function fromBuild(build, metrics, opts) {
    opts = opts || {};
    build = build || {};
    if (!build.engine && CB.data && typeof CB.data.defaultBuild === 'function') {
      try { build = CB.data.defaultBuild(); } catch (e) { /* keep */ }
    }
    var M = metrics;
    if (!M && !opts.noPhysics && CB.physics && typeof CB.physics.compute === 'function') {
      try { M = CB.physics.compute(build); } catch (e) { M = null; }
    }
    M = M || {};
    var source = metrics ? 'metrics' : (M.power_kw || M.power_hp ? 'physics' : 'derived');

    var bodyB = build.body || {}, eng = build.engine || {}, trB = build.transmission || {}, dt = build.drivetrain || {};
    var sus = build.suspension || {}, brk = build.brakes || {}, whl = build.wheels || {}, tyr = build.tires || {}, aer = build.aero || {};
    var bs = opt('bodyStyles', bodyB.style || 'coupe');
    var isEV = eng.type === 'ev';
    var isHybrid = eng.type === 'hybrid';

    /* --- mass & geometry --- */
    var mass = clamp(fin(M.weight_kg, estimateMass(build)), 500, 5000);
    var wf = clamp(fin(M.weightFront_pct, estimateWeightFront(build)), 25, 75) / 100;
    var wheelbase = clamp(num(bodyB.wheelbase_mm, fin(bs.defaultWheelbase, 2700)), 1800, 4200) / 1000;
    var track = clamp(num(bodyB.trackWidth_mm, 1600), 1300, 1900) / 1000;
    var a = wheelbase * (1 - wf); // CG -> front axle
    var b = wheelbase * wf;       // CG -> rear axle
    var rideH = clamp(num(sus.rideHeight_mm, 120), 40, 320);
    var cgH = fin(M.cgHeight_mm, fin(bs.cgHeight_mm, 520) + (rideH - 120) * 0.85 + (isEV ? -45 : 0) +
      (get(build, 'weight.rollCage', 'none') !== 'none' ? 6 : 0)) / 1000;
    cgH = clamp(cgH, 0.25, 1.1);
    // Yaw inertia: k^2 = a*b (dynamic index 1) is right for a front-engined car with the masses spread over
    // both axles. A mid engine sits between the axles (mass centralised, DI ~0.86); a rear engine hangs
    // *behind* the rear axle, so for the same (rear-biased) CG the radius of gyration grows (911: DI ~1.1).
    var posF = eng.position === 'mid' ? 0.86 : eng.position === 'rear' ? 1.1 : 1.0;
    if (isEV) posF = 0.92;
    var Iz = mass * a * b * 1.02 * posF + mass * track * track * 0.035;
    var length = num(get(bs, 'svg.length_mm', get(bs, 'svg.length', NaN)), NaN);
    if (length > 1000) length = length / 1000; // mm given
    if (!(length > 3 && length < 7)) length = num(bs.length_m, NaN);
    if (!(length > 3 && length < 7)) length = wheelbase + 1.85;
    var width = track + 0.32;

    /* --- tyres & wheels --- */
    var comp = opt('tireCompounds', tyr.compound || 'performance');
    var suspT = opt('suspensionTypes', sus.type || 'multilink');
    var diamIn = clamp(num(whl.diameter_in, 18), 14, 24);
    var twF = clamp(num(tyr.widthFront_mm, 245), 145, 405), twR = clamp(num(tyr.widthRear_mm, twF), 145, 405);
    var prF = clamp(num(tyr.profileFront, 40), 20, 80), prR = clamp(num(tyr.profileRear, prF), 20, 80);
    var radiusF = (diamIn * 25.4 / 2 + twF * prF / 100) / 1000;
    var radiusR = (diamIn * 25.4 / 2 + twR * prR / 100) / 1000;
    var wMat = opt('wheelMaterials', whl.material || 'cast');
    var wheelMassF = (11 + diamIn * 0.45) * fin(wMat.weightFactor, 1) + twF * 0.035;
    var wheelMassR = (11 + diamIn * 0.45) * fin(wMat.weightFactor, 1) + twR * 0.035;
    var IwF = 0.7 * wheelMassF * radiusF * radiusF + 0.25;
    var IwR = 0.7 * wheelMassR * radiusR * radiusR + 0.25;

    function camberGrip(c) { c = num(c, -1); return 1 + 0.035 * (1 - Math.pow((c + 2.2) / 2.2, 2)) - 0.035; }
    var baseMu = clamp(fin(comp.mu, 1.0), 0.4, 2.2);
    var muFb = baseMu * fin(suspT.gripMult, 1) * Math.pow(twF / 245, 0.06) * camberGrip(sus.camberFront_deg);
    var muRb = baseMu * fin(suspT.gripMult, 1) * Math.pow(twR / 245, 0.06) * camberGrip(sus.camberRear_deg);
    var muF = clamp(fin(M.gripFront, muFb), 0.4, 2.4);
    var muR = clamp(fin(M.gripRear, muRb), 0.4, 2.4);
    // Load sensitivity reference. CB.physics reports gripFront / gripRear as the *effective* mu at the static
    // wheel load of that axle (its own load sensitivity, referenced to a tyre-size nominal load, is already
    // in the number). Re-applying the sensitivity around mg/4 counted it twice: a rear-engined car (65 % on
    // the rear) lost another ~3 % at the rear and gained ~3 % at the front — a spurious limit-oversteer
    // balance. So: mu(Fz) = mu_axle * (1 - loadSens * (Fz - FzRef) / Fz0), with FzRef the load mu_axle is
    // quoted at and Fz0 the tyre's nominal load (wider tyre = flatter sensitivity). Derived (no metrics) mu
    // is a tyre base value quoted at the generic mg/4 reference, as before.
    var fz0Ref = mass * G / 4, twMean = (twF + twR) / 2;
    var fromMetricsF = isFinite(M.gripFront), fromMetricsR = isFinite(M.gripRear);
    var fzRefF = fromMetricsF ? mass * G * wf / 2 : fz0Ref, fzRefR = fromMetricsR ? mass * G * (1 - wf) / 2 : fz0Ref;
    var fz0F = fz0Ref * (fromMetricsF ? twF / twMean : 1), fz0R = fz0Ref * (fromMetricsR ? twR / twMean : 1);
    var wetRatio = clamp(fin(comp.wetMu, 0.7) / baseMu, 0.15, 1.1);
    var shapeC = clamp(fin(comp.shapeC, 1.42), 1.15, 1.75);
    var shapeB = Math.tan(Math.PI / (2 * shapeC));
    var stiffK = fin(comp.stiff, 1);
    // normalised cornering stiffness (N/rad per N of load)
    var kAlphaF = 17.5 * stiffK * Math.pow(twF / 245, 0.35) * Math.pow(40 / prF, 0.28);
    var kAlphaR = 17.5 * stiffK * Math.pow(twR / 245, 0.35) * Math.pow(40 / prR, 0.28);
    var kKappa = 24 * stiffK;
    var CB_ = shapeC * shapeB;
    var tanAlphaPeakF = clamp(muF * CB_ / kAlphaF, 0.06, 0.24);
    var tanAlphaPeakR = clamp(muR * CB_ / kAlphaR, 0.06, 0.24);
    var kappaPeakF = clamp(muF * CB_ / kKappa, 0.06, 0.2);
    var kappaPeakR = clamp(muR * CB_ / kKappa, 0.06, 0.2);
    var rollingRes = clamp(fin(comp.rollingResistance, 0.011), 0.004, 0.03);
    // toe: small stability/turn-in modifiers on peak slip angle
    var toeR = num(sus.toeRear_deg, 0.1);
    var toeStabR = 1 + clamp(toeR, -0.5, 0.5) * 0.08;

    /* --- aero --- */
    var cdA = fin(M.cda, NaN);
    var splitter = opt('aero.splitters', aer.splitter || 'none');
    var wing = opt('aero.wings', aer.wing || 'none');
    var diffuser = opt('aero.diffusers', aer.diffuser || 'none');
    if (!isFinite(cdA)) {
      var cd = fin(M.cd, fin(bs.cd, 0.32) + fin(splitter.dragDelta, 0) + fin(wing.dragDelta, 0) + fin(diffuser.dragDelta, 0) +
        (aer.canards ? 0.006 : 0) - (aer.sideSkirts ? 0.002 : 0));
      cdA = cd * fin(M.frontalArea_m2, fin(bs.frontalArea_m2, 2.1));
    }
    cdA = clamp(cdA, 0.25, 2.5);
    var wingAngle = clamp(num(aer.wingAngle_deg, 6), 0, 25);
    var wingDf = fin(wing.downforce_kg_at_200, 0) * (wing.adjustable === false ? 1 : (0.5 + wingAngle / 12));
    var dfFrontParts = fin(splitter.downforce_kg_at_200, 0) + (aer.canards ? 18 : 0) + 0.42 * fin(diffuser.downforce_kg_at_200, 0);
    var dfRearParts = wingDf + 0.58 * fin(diffuser.downforce_kg_at_200, 0) + (aer.sideSkirts ? 4 : 0);
    var dfTotalKg = fin(M.downforce_kg_200, dfFrontParts + dfRearParts);
    dfTotalKg = clamp(dfTotalKg, 0, 3000);
    var partsSum = dfFrontParts + dfRearParts;
    var dfFrontFrac = partsSum > 1 ? clamp(dfFrontParts / partsSum, 0.15, 0.85) : 0.45;
    var clA = dfTotalKg * G / (0.5 * RHO * V200 * V200);
    var activeAero = !!aer.activeAero || aer.wing === 'active';

    /* --- engine --- */
    var red = fin(M.redlineRpm, isEV ? 16000 : num(eng.redline_rpm, 7000));
    red = clamp(red, isEV ? 4000 : 3000, isEV ? 25000 : 12000);
    var idle = isEV ? 0 : clamp(fin(M.idleRpm, eng.fuel === 'diesel' ? 750 : 850), 500, 1500);
    var powerKw = fin(M.power_kw, isFinite(M.power_hp) ? M.power_hp * 0.7457 : estimatePowerKw(build));
    powerKw = clamp(powerKw, 20, 3000);
    var curve = null;
    if (Array.isArray(M.curve) && M.curve.length >= 3) {
      curve = M.curve.filter(function (c) { return c && isFinite(c.rpm) && (isFinite(c.nm) || isFinite(c.hp)); })
        .map(function (c) {
          var nm = isFinite(c.nm) ? c.nm : (c.hp * 745.7 / Math.max(1, c.rpm * RPM_TO_RADS));
          return { rpm: c.rpm, nm: Math.max(0, nm) };
        }).sort(function (x, y) { return x.rpm - y.rpm; });
      if (curve.length < 3) curve = null;
    }
    if (!curve) curve = deriveCurve(build, powerKw, idle || 0, red, isEV);
    var cR = curve.map(function (c) { return c.rpm; }), cN = curve.map(function (c) { return c.nm; });
    var curveMax = cR[cR.length - 1];
    if (curveMax < red) red = Math.max(curveMax, red * 0.9);
    var torqueTable = makeTable(cR, cN, Math.max(red, curveMax) + 500);
    var peakNm = 0, peakNmRpm = 0, peakKw = 0, peakKwRpm = 0;
    for (var ti = 0; ti < torqueTable.length; ti++) {
      var rr = ti * CURVE_STEP;
      if (rr > red) break;
      if (torqueTable[ti] > peakNm) { peakNm = torqueTable[ti]; peakNmRpm = rr; }
      var kw = torqueTable[ti] * rr * RPM_TO_RADS / 1000;
      if (kw > peakKw) { peakKw = kw; peakKwRpm = rr; }
    }
    var asp = opt('aspirations', eng.aspiration || 'na');
    var boostBar = asp.forced ? clamp(num(eng.boost_bar, 1), 0, 3.5) : 0;
    var turbo = !isEV && asp.forced && !asp.linear && eng.aspiration !== 'supercharged';
    var turboLag = turbo ? clamp(fin(asp.lag, 0.4), 0, 1) : 0;
    var naFrac = turbo ? clamp(1 / (1 + 0.55 * Math.max(boostBar, 0.4)), 0.4, 1) : 1;
    var engineInertia = isEV ? 0.06 * num(eng.motors, 1) + 0.04 :
      clamp(0.08 + num(eng.displacement_l, 3) * 0.035 + (get(FB.engineLayouts, (eng.layout || 'V6') + '.cylinders', 6)) * 0.004, 0.08, 0.6);
    var frictionNm = isEV ? 0 : peakNm * 0.09 + num(eng.displacement_l, 3) * 6;

    /* --- transmission --- */
    var trT = trB.type || (isEV ? 'single-speed' : 'dct');
    var trO = opt('transmissions', trT);
    var isCVT = trT === 'cvt' || !!trO.cvt;
    var ratios = Array.isArray(trB.ratios) ? trB.ratios.map(Number).filter(function (r) { return isFinite(r) && r > 0.2; }) : [];
    var nG = Math.round(num(trB.gears, ratios.length || 6));
    if (!ratios.length || (ratios.length !== nG && !isCVT)) ratios = defaultRatios(clamp(nG, 1, 10));
    ratios.sort(function (x, y) { return y - x; });
    var finalDrive = clamp(num(trB.finalDrive, 3.5), 1.5, 12);
    if (trT === 'single-speed' || isEV) {
      if (ratios.length !== 1 && (trT === 'single-speed')) ratios = [ratios[0]];
    }
    var radiusDrive = dt.layout === 'fwd' ? radiusF : radiusR;
    var vAtRed = function (gr) { return red * RPM_TO_RADS / (gr * finalDrive) * radiusDrive; };
    // Sanity-fix total ratio for single-speed / EV builds (rpm-equivalent curves)
    if (ratios.length === 1 && !isCVT) {
      var vTop = isFinite(M.topSpeed_kph) ? M.topSpeed_kph / 3.6 * 1.04 : clamp(Math.cbrt(2 * powerKw * 1000 * 0.9 / (RHO * cdA)), 40, 95);
      var vr = vAtRed(ratios[0]);
      if (!(vr > vTop * 0.85 && vr < vTop * 1.6)) ratios = [red * RPM_TO_RADS * radiusDrive / (vTop * finalDrive)];
    }
    var cvtMin = 0.5, cvtMax = 2.9;
    var maxGear = isCVT ? 1 : ratios.length;
    var reverseRatio = (isCVT ? cvtMax : ratios[0]) * 1.05;
    var shiftTime = clamp(fin(trO.shiftTime_s, 0.25), 0, 1.2);
    var shiftCut = clamp(fin(trO.cut, trT === 'dct' ? 0.4 : trT === 'auto' ? 0.3 : 0), 0, 1);
    var efficiency = clamp(fin(trO.efficiency, 0.92), 0.6, 1);
    var converter = trT === 'auto' || !!trO.converter;
    var launchControl = !!trB.launchControl;

    /* --- drivetrain --- */
    var layout = dt.layout === 'fwd' || dt.layout === 'awd' ? dt.layout : 'rwd';
    var splitF = layout === 'fwd' ? 1 : layout === 'rwd' ? 0 : clamp(num(dt.torqueSplitFront_pct, 40) / 100, 0.1, 0.9);
    var lockF = clamp(fin(opt('differentials', dt.frontDiff || 'open').lockFactor, 0), 0, 1);
    var lockR = clamp(fin(opt('differentials', dt.rearDiff || 'open').lockFactor, 0), 0, 1);
    var lockC = layout === 'awd' ? clamp(dt.centerDiff && dt.centerDiff !== 'none' ? fin(opt('differentials', dt.centerDiff).lockFactor, 0.3) : 0.35, 0, 1) : 0;
    var torqueVectoring = !!dt.torqueVectoring || dt.rearDiff === 'e-diff' || (isEV && num(eng.motors, 1) >= 3);
    var tcLevel = clamp(Math.round(num(dt.tractionControl, 2)), 0, 3);
    var absMode = brk.abs || 'standard';
    var absLevel = absMode === 'off' ? 0 : absMode === 'race' ? 3 : absMode === 'sport' ? 2 : 1;

    /* --- brakes --- */
    var bm = opt('brakeMaterials', brk.material || 'iron');
    function pistonF(n) { n = num(n, 4); return clamp(0.68 + 0.06 * n - 0.0018 * n * n, 0.7, 1.2); }
    var rotF = clamp(num(brk.frontRotor_mm, 340), 240, 460), rotR = clamp(num(brk.rearRotor_mm, 310), 240, 460);
    var capF = Math.pow(rotF / 360, 1.1) * pistonF(brk.frontPistons);
    var capR = Math.pow(rotR / 360, 1.1) * pistonF(brk.rearPistons) * 0.82;
    // Brake bias: start from the ideal front share at ~1.05 g (static split + longitudinal transfer, so the
    // rears never saturate before the fronts = stable under braking), add a safety margin, then let the
    // hardware (rotor / piston sizing front vs rear) nudge it a little.
    var hwBias = capF / (capF + capR);
    var idealBias = wf + cgH / wheelbase * 1.05;
    var bias = clamp(idealBias + 0.05 + (hwBias - 0.6) * 0.25, 0.55, 0.85);
    // brakes sized in absolute terms -> heavy cars become brake-limited
    var brakeForceMax = mass * G * 1.3 * Math.pow(1500 / mass, 0.3) * fin(bm.frictionMult, 1) * Math.pow((capF + capR) / 1.82, 0.7);
    var maxBrakeTorqueF = brakeForceMax * bias * radiusF / 2;
    var maxBrakeTorqueR = brakeForceMax * (1 - bias) * radiusR / 2;
    var handbrakeTorque = Math.max(maxBrakeTorqueR * 2.2, mass * G * 0.6 * radiusR);

    /* --- suspension / load transfer --- */
    var kSF = num(sus.springFront_nmm, 60), kSR = num(sus.springRear_nmm, 60);
    var kAF = num(sus.arbFront, 5), kAR = num(sus.arbRear, 5);
    var rollF = kSF + kAF * 14, rollR = kSR + kAR * 14;
    var rsdF = clamp(rollF / (rollF + rollR) * 0.8 + 0.1 + (wf - 0.5) * 0.2, 0.3, 0.72);
    var damping = clamp(num(sus.damping, 5), 1, 10);
    var loadTau = lerp(0.14, 0.045, (damping - 1) / 9);

    /* --- steering --- */
    var steering = get(build, 'interior.steering', 'round');
    var lockAngle = clamp(0.62 - (wheelbase - 2.6) * 0.08, 0.45, 0.7);
    var steerRate = steering === 'yoke' || steering === 'race-quick-release' ? 4.2 : 3.4;

    /* --- governor --- */
    var governor = (M.topSpeedLimitedBy === 'governor' && isFinite(M.topSpeed_kph)) ? M.topSpeed_kph / 3.6 : (isEV ? 400 / 3.6 : Infinity);

    var p = {
      version: 1,
      source: source,
      name: get(build, 'meta.name', 'Car'),
      bodyStyle: bodyB.style || 'coupe',
      isEV: isEV, isHybrid: isHybrid,
      mass: mass, weightFront: wf, cgHeight: cgH, wheelbase: wheelbase, a: a, b: b, track: track, Iz: Iz,
      length_m: length, width_m: width,
      // tyres
      radiusF: radiusF, radiusR: radiusR, IwF: IwF, IwR: IwR,
      muF: muF, muR: muR, wetRatio: wetRatio, muXScale: 1.1,
      shapeC: shapeC, shapeB: shapeB,
      tanAlphaPeakF: tanAlphaPeakF, tanAlphaPeakR: tanAlphaPeakR * toeStabR,
      kappaPeakF: kappaPeakF, kappaPeakR: kappaPeakR,
      loadSens: 0.11, fzRefF: fzRefF, fzRefR: fzRefR, fz0F: fz0F, fz0R: fz0R, rollingRes: rollingRes, compound: comp.id,
      // aero
      cdA: cdA, clA: clA, dfFrontFrac: dfFrontFrac, downforce_kg_200: dfTotalKg, activeAero: activeAero, sideCdA: cdA * 3.2,
      // engine
      powerKw: peakKw || powerKw, peakNm: peakNm, peakNmRpm: peakNmRpm, peakKwRpm: peakKwRpm || red * 0.85,
      redline: red, idle: idle, limiterRpm: red + (isEV ? 0 : 60), torqueTable: torqueTable,
      turbo: turbo, turboLag: turboLag, naFrac: naFrac, engineInertia: engineInertia, frictionNm: frictionNm,
      regen: isEV || isHybrid ? clamp(num(eng.regen, 2), 0, 3) : 0,
      governor: governor,
      // gearbox
      transmission: trT, ratios: ratios, finalDrive: finalDrive, maxGear: maxGear, reverseRatio: reverseRatio,
      reverseMax: 8.5, isCVT: isCVT, cvtMin: cvtMin, cvtMax: cvtMax, shiftTime: shiftTime, shiftCut: shiftCut, efficiency: efficiency,
      converter: converter, launchControl: launchControl, launchRpm: isEV ? 0 : clamp(Math.max(peakNmRpm * 0.85, red * 0.5), idle + 1200, red * 0.75),
      upshiftRpm: null, downshiftRpm: null,
      // drivetrain
      layout: layout, splitF: splitF, lockF: lockF, lockR: lockR, lockC: lockC, torqueVectoring: torqueVectoring,
      tcLevel: tcLevel, absLevel: absLevel,
      // brakes
      brakeBias: bias, maxBrakeTorqueF: maxBrakeTorqueF, maxBrakeTorqueR: maxBrakeTorqueR, handbrakeTorque: handbrakeTorque,
      brakeForceMax: brakeForceMax,
      // suspension
      rsdF: rsdF, loadTau: loadTau,
      // steering
      lockAngle: lockAngle, steerRate: steerRate,
      // reference metrics (for UI / tests)
      expected: {
        zeroTo100_s: fin(M.zeroTo100_s, null), zeroTo60_s: fin(M.zeroTo60_s, null), topSpeed_kph: fin(M.topSpeed_kph, null),
        lateralG: fin(M.lateralG, null), power_hp: (peakKw || powerKw) / 0.7457
      }
    };
    computeShiftPoints(p);
    if (opts.handling === 'arcade') applyArcade(p);
    p.capabilities = computeCapabilities(p);
    // flat convenience aliases (consumed by AI / UI)
    p.maxLatG = p.capabilities.maxLatG;
    p.maxBrakeG = p.capabilities.maxBrakeG;
    p.topSpeed_ms = p.capabilities.topSpeed_mps;
    p.power_kw = p.powerKw;
    p.power_hp = p.powerKw / 0.7457;
    p.maxSteer = p.lockAngle;
    p.rollingResistance = p.rollingRes;
    p.autoShift = true;
    if (p.expected.zeroTo100_s == null) p.expected.zeroTo100_s = p.capabilities.est0to100_s;
    if (p.expected.topSpeed_kph == null) p.expected.topSpeed_kph = p.capabilities.topSpeed_mps * 3.6;
    if (p.expected.lateralG == null) p.expected.lateralG = p.capabilities.maxLatG;
    return deepFreeze(p);
  }

  function gearRatioTotal(p, gear, cvtRatio) {
    if (gear === 0) return 0;
    if (gear < 0) return -p.reverseRatio * p.finalDrive;
    if (p.isCVT) return (cvtRatio || p.cvtMax) * p.finalDrive;
    return p.ratios[Math.min(gear, p.maxGear) - 1] * p.finalDrive;
  }

  function computeShiftPoints(p) {
    var up = [], down = [];
    var n = p.maxGear;
    for (var g = 1; g <= n; g++) {
      if (g === n || p.isCVT) { up.push(p.redline * 0.985); continue; }
      var r1 = p.ratios[g - 1], r2 = p.ratios[g];
      var best = p.redline * 0.975;
      for (var rpm = p.redline * 0.55; rpm <= p.redline * 0.985; rpm += 50) {
        var f1 = lookupTorque(p, rpm) * r1;
        var f2 = lookupTorque(p, rpm * r2 / r1) * r2;
        if (f2 >= f1) { best = Math.max(rpm, p.redline * 0.72); break; }
      }
      up.push(Math.min(best, p.redline * 0.985));
    }
    for (var d = 1; d <= n; d++) {
      if (d === 1) { down.push(0); continue; }
      // rpm in gear d below which the lower gear lands safely under its upshift point
      down.push(up[d - 2] * 0.82 * p.ratios[d - 1] / p.ratios[d - 2]);
    }
    p.upshiftRpm = up;
    p.downshiftRpm = down;
  }

  /* ------------------------------------------------------ capabilities
     Quasi-static performance envelope used by AI / speedProfile.            */
  function downforceN(p, v) { return 0.5 * RHO * p.clA * v * v; }
  function latAccelAt(p, v, gripMult) {
    gripMult = gripMult == null ? 1 : gripMult;
    if (p.handling === 'arcade') return arcadeLatCap(p, v, gripMult);
    var mg = p.mass * G;
    var df = downforceN(p, v);
    var mu = (p.muF * p.weightFront + p.muR * (1 - p.weightFront));
    var loadFactor = 1 - p.loadSens * 0.35 * (df / mg);
    return mu * gripMult * 0.93 * (mg + df) * loadFactor / p.mass;
  }
  function brakeAccelAt(p, v, gripMult) {
    gripMult = gripMult == null ? 1 : gripMult;
    if (p.handling === 'arcade') return p.arcade.brakeG * G * arcadeSurfaceGrip(gripMult) + (0.5 * RHO * p.cdA * v * v + p.rollingRes * p.mass * G) / p.mass;
    var mg = p.mass * G, df = downforceN(p, v);
    var mu = (p.muF * p.weightFront + p.muR * (1 - p.weightFront)) * p.muXScale * gripMult * (p.absLevel ? 0.96 : 0.9);
    var tire = mu * (mg + df) * (1 - p.loadSens * 0.3 * df / mg);
    var brakes = p.brakeForceMax;
    var drag = 0.5 * RHO * p.cdA * v * v;
    return (Math.min(tire, brakes) + drag + p.rollingRes * mg) / p.mass;
  }
  function accelAt(p, v, gripMult) {
    gripMult = gripMult == null ? 1 : gripMult;
    v = Math.max(0, v);
    var best = 0;
    var rDrive = p.layout === 'fwd' ? p.radiusF : p.radiusR;
    var gears = p.isCVT ? 1 : p.maxGear;
    for (var g = 1; g <= gears; g++) {
      var ratio;
      if (p.isCVT) {
        ratio = clamp(p.peakKwRpm * RPM_TO_RADS * rDrive / Math.max(v, 0.1) / p.finalDrive, p.cvtMin, p.cvtMax);
      } else ratio = p.ratios[g - 1];
      var Gt = ratio * p.finalDrive;
      var rpm = v / rDrive * Gt * RADS_TO_RPM;
      if (rpm > p.redline) continue;
      var rpmEff = Math.max(rpm, p.isEV ? 0 : (p.launchControl ? p.launchRpm : Math.max(p.idle + 1500, p.peakNmRpm * 0.6)));
      var F = lookupTorque(p, rpmEff) * Gt * p.efficiency / rDrive;
      if (F > best) best = F;
    }
    var mg = p.mass * G, df = downforceN(p, v);
    var drivenFront = p.splitF;
    // traction: driven axle load with longitudinal transfer at ~0.6g
    var aGuess = Math.min(best / p.mass, 9);
    var transfer = p.mass * aGuess * p.cgHeight / p.wheelbase;
    var FzF = mg * p.weightFront + df * p.dfFrontFrac - transfer;
    var FzR = mg * (1 - p.weightFront) + df * (1 - p.dfFrontFrac) + transfer;
    var trac;
    if (p.layout === 'awd') trac = (p.muF * FzF + p.muR * FzR) * gripMult;
    else if (p.layout === 'fwd') trac = p.muF * FzF * gripMult;
    else trac = p.muR * FzR * gripMult;
    trac *= p.muXScale * 0.92;
    void drivenFront;
    var Fx = Math.min(best, trac);
    if (p.handling === 'arcade') Fx = Math.min(best * ARC.punch, p.arcade.tracG * mg);
    var resist = 0.5 * RHO * p.cdA * v * v + p.rollingRes * (mg + df);
    if (v > p.governor) Fx = 0;
    return (Fx - resist) / p.mass;
  }

  function computeCapabilities(p) {
    var table = [], vmax = 0;
    for (var v = 0; v <= 130; v += 1) {
      var acc = accelAt(p, v, 1);
      table.push(acc);
      if (acc > 0.05) vmax = v;
    }
    // crude 0-100 estimate incl. shift losses
    var t = 0, vv = 0, h = 0.01, shifts = 0, lastG = 1;
    while (vv < 100 / 3.6 && t < 60) {
      var ac = accelAt(p, vv, 1);
      if (ac <= 0) { t = 60; break; }
      vv += ac * h; t += h;
      var g = 1, rD = p.layout === 'fwd' ? p.radiusF : p.radiusR;
      if (!p.isCVT) for (g = 1; g < p.maxGear; g++) if (vv / rD * p.ratios[g - 1] * p.finalDrive * RADS_TO_RPM < p.upshiftRpm[g - 1]) break;
      if (g !== lastG) { shifts++; lastG = g; }
    }
    t += shifts * p.shiftTime * (1 - p.shiftCut) * 0.6;
    return {
      maxLatG: latAccelAt(p, 0, 1) / G,
      maxBrakeG: brakeAccelAt(p, 0, 1) / G,
      latG_200: latAccelAt(p, V200, 1) / G,
      topSpeed_mps: Math.min(vmax, p.governor),
      accelTable: table, // m/s^2 at v = index (m/s)
      est0to100_s: t
    };
  }

  /* ------------------------------------------------------ ARCADE handling
     params.handling === 'arcade' (fromBuild(build, metrics, { handling: 'arcade' }) or withHandling(p, 'arcade')):
     a kinematic grip model for the Arcade game mode (docs/ARCADE-SPEC.md). The tyres never let go: no wheelspin, no
     lock-up, no under/oversteer, no spins. Steering asks for a path CURVATURE (speed-sensitive: full lock is the
     generous, stable cornering limit at every speed), the yaw rate follows it with a short lag and the body slip
     is pulled back to ~0, so the car goes where it is pointed. The engine / gearbox / turbo / aero drag still run,
     so power, weight, gearing and top speed keep separating builds; tyre / suspension stats only nudge the limit.
     Only loss of control: spinOut(p, s, opts) — a brief cartoon 360 (items), which keeps the travel direction.
     env.arcade (optional, per step): { boost: drive-force multiplier (>= 0, default 1), push: extra forward accel
     m/s^2 (boost pads, independent of throttle), topSpeedMult: governor multiplier (speed classes) }.            */
  var ARC = {
    punch: 1.12,          // drive-force bonus (arcade feels a little livelier than the sim)
    yawTau: 0.04,         // s: yaw-rate lag behind the commanded curvature (snappy, Mario-Kart-like, not digital)
    slipTau: 0.035,       // s: body slip decay (the "grip constraint")
    steerRateIn: 14,      // 1/s: normalised steer slew toward a bigger input (pad / phone: ~70 ms to full lock)
    steerRateOut: 18,     // 1/s: ... and back toward centre (quick self-centering)
    lockK: 1.2,           // low-speed lock geometry x this (tight hairpins / parking-lot turns)
    latBase: 2.2,         // g: cornering limit of an average car (was 1.32: ~1.7x the yaw rate at every speed)
    hbCurv: 1.5,          // handbrake / powerslide: tighter turning (and a light brake), never a spin
    hbBrakeG: 0.45,
    engBrakeG: 0.32,      // max engine braking on lift
    scrubG: 0.12,         // g of drag at full cornering load
    slideV: 9,            // m/s: handbrake + steer above this = powerslide (below: handbrake = brake / pivot)
    slideMax: 0.5,        // rad: max cosmetic powerslide angle (~29 deg)
    slideIn: 1.8,         // rad/s: slide angle build-up
    slideOut: 2.6,        // rad/s: ... and recovery once the handbrake is released
    slideBrakeG: 0.06,    // light scrub while powersliding (keeps the speed, Mario-Kart style)
    wallYawCap: 1.6,      // rad/s: yaw kick the engine may leave after a wall / car contact (soft bounces)
    // keyboard shaping for arcade sessions (race-ui I.sample arcade branch, tools/arcade-turn.js): ~100 ms to full lock,
    // no speed-dependent lock cut (full lock already IS the cornering limit at every speed), quick centering / flips
    keys: { rateIn: 10, rateOut: 14, rateFlip: 18 }
  };
  function arcadeSurfaceGrip(g) { return 0.7 + 0.3 * clamp(num(g, 1), 0, 1); }
  /** Arcade lateral limit (m/s^2) at speed v: generous, a little more with downforce, a little less off-road. */
  function arcadeLatCap(p, v, gripMult) {
    var A = p.arcade, mg = p.mass * G;
    var df = downforceN(p, v);
    return A.latG * G * (1 + A.dfGain * Math.min(1.2, df / mg)) * arcadeSurfaceGrip(gripMult == null ? 1 : gripMult);
  }
  /** Max path curvature (1/m) the steering may ask for at speed v (full lock). */
  function arcadeCurvatureLimit(p, v, gripMult) {
    var kLock = Math.tan(p.lockAngle) / p.wheelbase * ARC.lockK;
    var va = Math.max(Math.abs(num(v, 0)), 0.1);
    return Math.min(kLock, arcadeLatCap(p, va, gripMult) / (va * va));
  }
  /** Mutates a (not yet frozen) params object into an arcade one. */
  function applyArcade(p) {
    p.handling = 'sim';
    var simLat = latAccelAt(p, 0, 1) / G, simBrake = brakeAccelAt(p, 0, 1) / G;
    p.handling = 'arcade';
    // heavier cars are a little less agile (a 2.6 t van ~ -10 %), never sluggish
    var massF = clamp(1 - 0.09 * (num(p.mass, 1450) - 1450) / 1000, 0.88, 1.03);
    p.arcade = {
      latG: clamp(ARC.latBase + 0.4 * (simLat - 1.0), 2.0, 2.6) * massF,
      brakeG: clamp(1.35 + 0.25 * (simBrake - 1.0), 1.25, 1.6),
      tracG: p.layout === 'awd' ? 1.25 : 1.12,
      dfGain: 0.35,
      punch: ARC.punch
    };
    return p;
  }
  /** A copy of frozen params with another handling model ('arcade' | 'sim'). */
  function withHandling(p, mode) {
    mode = mode === 'arcade' ? 'arcade' : 'sim';
    if ((p.handling || 'sim') === mode) return p;
    var q = {};
    Object.keys(p).forEach(function (k) { q[k] = p[k]; });
    delete q.arcade;
    q.handling = 'sim';
    if (mode === 'arcade') applyArcade(q);
    q.capabilities = computeCapabilities(q);
    q.maxLatG = q.capabilities.maxLatG; q.maxBrakeG = q.capabilities.maxBrakeG; q.topSpeed_ms = q.capabilities.topSpeed_mps;
    return deepFreeze(q);
  }
  function isArcade(p) { return !!p && p.handling === 'arcade' && !!p.arcade; }

  /**
   * arcadeResponse(p, speed, input, env?) -> pure drive response of the arcade model at a given forward speed
   * (for integrators that move the car along their own track space, e.g. stunt loops):
   *   { accelLong m/s^2 (incl. drag / rolling / brakes, + forward), curvature 1/m (+ left), yawRate rad/s,
   *     steerAngle rad, latAccel m/s^2, maxLatAccel, maxCurvature, topSpeed m/s, brakeDecel m/s^2 }
   * input { throttle, brake, steer (+1 left), handbrake }. Gear is the best gear for that speed (no state).
   */
  function arcadeResponse(p, speed, input, env) {
    input = input || {}; env = env || {};
    var ar = env.arcade || {};
    var v = Math.max(0, num(speed, 0)), grip = num(env.gripMult, 1);
    var thr = clamp(num(input.throttle, 0), 0, 1), brk = clamp(num(input.brake, 0), 0, 1), st = clamp(num(input.steer, 0), -1, 1);
    var boost = Math.max(0, num(ar.boost, 1)), topMult = Math.max(0.2, num(ar.topSpeedMult, 1));
    var a = 0;
    if (thr > 0 && v < p.governor * topMult) a += (accelAt(p, v, grip) + (0.5 * RHO * p.cdA * v * v + p.rollingRes * p.mass * G) / p.mass) * thr * boost;
    a -= (0.5 * RHO * p.cdA * v * v + p.rollingRes * p.mass * G) / p.mass;
    var bd = brk * (isArcade(p) ? p.arcade.brakeG : p.maxBrakeG) * G + (input.handbrake ? ARC.hbBrakeG * G : 0);
    if (v > 0.05) a -= bd;
    a += num(ar.push, 0);
    var P = isArcade(p) ? p : withHandling(p, 'arcade');
    var kMax = arcadeCurvatureLimit(P, v, grip) * (input.handbrake ? ARC.hbCurv : 1);
    var k = st * kMax;
    var topV = p.capabilities ? p.capabilities.topSpeed_mps : p.topSpeed_ms;
    return {
      accelLong: a, curvature: k, yawRate: v * k, steerAngle: Math.atan(k * p.wheelbase), latAccel: v * v * k,
      maxLatAccel: arcadeLatCap(P, v, grip), maxCurvature: kMax, topSpeed: Math.min(num(topV, 90) * Math.cbrt(Math.max(boost, 0.01)), p.governor * topMult),
      brakeDecel: bd
    };
  }

  /** Start a cartoon spin-out (the only allowed loss of control in arcade): a 360 over `duration` s
      (default 1.0) in direction `dir` (+1 CCW), keeping the travel direction and shedding `speedLoss` (0..1,
      default 0.45) of the speed. Steering / throttle are ignored meanwhile. Works on either handling model. */
  function spinOut(p, s, opts) {
    opts = opts || {};
    var dur = clamp(num(opts.duration, 1.0), 0.3, 3);
    var wv = worldVelocity(s);
    s.spin = {
      t: 0, dur: dur, dir: num(opts.dir, 1) >= 0 ? 1 : -1, h0: s.heading, turns: Math.max(1, Math.round(num(opts.turns, 1))),
      vx: wv.vx, vy: wv.vy, keep: Math.pow(clamp(1 - num(opts.speedLoss, 0.45), 0, 1), 1 / dur)
    };
    return s;
  }
  function spinSubstep(p, s, h) {
    var sp = s.spin;
    sp.t += h;
    var f = clamp(sp.t / sp.dur, 0, 1);
    var e = f * f * (3 - 2 * f);                      // ease in / out
    var k = Math.pow(sp.keep, h);
    sp.vx *= k; sp.vy *= k;
    var newH = sp.h0 + sp.dir * TWO_PI * sp.turns * e;
    s.yawRate = (newH - s.heading) / h;
    s.heading = newH;
    var c = Math.cos(s.heading), sn = Math.sin(s.heading);
    s.vx = sp.vx * c + sp.vy * sn; s.vy = -sp.vx * sn + sp.vy * c;
    s.x += sp.vx * h; s.y += sp.vy * h;
    s.speed = Math.sqrt(sp.vx * sp.vx + sp.vy * sp.vy);
    s.odometer += s.speed * h;
    s.steerAngle = approach(s.steerAngle, 0, 3 * h);
    s.arcSteer = 0; s.slideAngle = 0; s.slideRate = 0; s.slideDir = 0; s.powerslide = false; s.slideTime = 0;
    for (var i = 0; i < 4; i++) { var w = s.wheels[i]; w.omega = s.vx / (i < 2 ? p.radiusF : p.radiusR); w.skid = 0.8; }
    s.skidding = 0.8; s.wheelspin = 0;
    s.beta = s.speed > 1 ? Math.atan2(s.vy, Math.abs(s.vx)) : 0;
    s.engineRpm = s.rpm = approach(s.rpm, p.idle + 600, 6000 * h);
    if (f >= 1) { s.heading = wrapAngle(sp.h0); s.yawRate = 0; s.vx = Math.sqrt(sp.vx * sp.vx + sp.vy * sp.vy) * (sp.vx * Math.cos(s.heading) + sp.vy * Math.sin(s.heading) >= 0 ? 1 : -1); s.vy = 0; s.spin = null; }
  }

  function arcadeSubstep(p, s, h, thr, brk, steerIn, hb, gripMult, rrMult, surfDrag, ar) {
    var A = p.arcade, mg = p.mass * G, m = p.mass;
    var vx = s.vx, vy = s.vy, r = s.yawRate, w = s.wheels;
    var vAbs = Math.sqrt(vx * vx + vy * vy), vF = Math.abs(vx);
    var boost = Math.max(0, num(ar.boost, 1)), push = num(ar.push, 0), topMult = Math.max(0.2, num(ar.topSpeedMult, 1));
    s.boosting = boost > 1.01 || push > 0.1;

    /* ---- steering: normalised slew, curvature command ---- */
    var sCur = num(s.arcSteer, 0);
    var rateS = Math.abs(steerIn) > Math.abs(sCur) && steerIn * sCur >= 0 ? ARC.steerRateIn : ARC.steerRateOut;
    sCur = approach(sCur, steerIn, rateS * h);
    s.arcSteer = sCur;
    // powerslide (handbrake + steer at speed): a controlled, cosmetic slide — the nose swings in by up to ~30 deg,
    // the path tightens a little and stays exactly as commanded; it never builds into a spin.
    var slideOn = hb && vF > ARC.slideV && Math.abs(sCur) > 0.2 && s.gear >= 0;
    var dir0 = num(s.slideDir, 0);
    if (slideOn && dir0 === 0) dir0 = sign(sCur);
    if (!slideOn && Math.abs(num(s.slideAngle, 0)) < 0.01) dir0 = 0;
    s.slideDir = dir0;
    var slideT = slideOn ? dir0 * ARC.slideMax * (0.55 + 0.45 * Math.max(0, sCur * dir0)) : 0;
    var slPrev = num(s.slideAngle, 0);
    var slNew = approach(slPrev, slideT, (slideOn ? ARC.slideIn : ARC.slideOut) * h);
    s.slideAngle = slNew;
    s.powerslide = slideOn;
    s.slideTime = slideOn ? num(s.slideTime, 0) + h : 0;
    var hbBrake = hb && !slideOn;
    var kMax = arcadeCurvatureLimit(p, vF, gripMult) * (hb ? ARC.hbCurv : 1);
    var kappa = sCur * kMax;
    var delta = Math.atan(kappa * p.wheelbase);
    s.steerAngle = delta;
    w[0].steer = w[1].steer = delta; w[2].steer = w[3].steer = 0;

    /* ---- spool / CVT (as the sim) ---- */
    if (p.turbo) {
      var spT = clamp(thr * smoothstep(p.idle, p.idle + 2200, s.engineRpm), 0, 1);
      var tau = spT > s.spool ? 0.08 + p.turboLag * 0.8 : 0.35;
      s.spool += (spT - s.spool) * (1 - Math.exp(-h / tau));
      s.boost = s.spool;
    } else { s.spool = 1; s.boost = thr; }
    var rD = p.layout === 'fwd' ? p.radiusF : p.radiusR;
    if (p.isCVT && s.gear > 0) {
      var tgtRpm = lerp(p.idle + 900, p.peakKwRpm, Math.pow(thr, 0.8));
      var desired = clamp(tgtRpm * RPM_TO_RADS / (Math.max(vF / rD, 0.5) * p.finalDrive), p.cvtMin, p.cvtMax);
      s.cvtRatio = approach(s.cvtRatio, desired, 1.6 * h);
    }

    /* ---- driveline: wheels roll with the road (no slip); clutch slips only at launch ---- */
    var thrEff = thr;
    if (vAbs > p.governor * topMult) thrEff = Math.min(thrEff, Math.max(0, 1 - (vAbs - p.governor * topMult) * 0.5));
    if (s.gear < 0) thrEff *= clamp((p.reverseMax + vx) / 2, 0, 1);
    var Gt = gearRatioTotal(p, s.gear, s.cvtRatio);
    var wheelRpm = vx / rD * Gt * RADS_TO_RPM;
    var te = 0;
    if (s.gear === 0 || Gt === 0) {
      s.engineRpm = approach(s.engineRpm, p.isEV ? 0 : p.idle + thrEff * (p.redline * 0.95 - p.idle), h * 6000);
      s.clutchLocked = false; s.clutch = 0;
    } else if (p.isEV) {
      s.engineRpm = Math.abs(wheelRpm);
      te = engineTorque(p, s, s.engineRpm, thrEff);
      if (wheelRpm < -50 && te < 0) te = 0;
      s.clutchLocked = true; s.clutch = 1;
    } else {
      var stall = clamp(p.peakNmRpm * 0.75, p.idle + 1000, p.redline * 0.65);
      var tgt = Math.max(Math.abs(wheelRpm), p.idle + thrEff * (stall - p.idle));
      if (s.shiftTimer > 0) tgt = clamp(Math.abs(wheelRpm), p.idle, p.redline);
      s.engineRpm = tgt > s.engineRpm ? approach(s.engineRpm, tgt, h * (s.shiftTimer > 0 ? 14000 : 9000)) : Math.max(tgt, approach(s.engineRpm, tgt, h * 9000));
      s.clutchLocked = Math.abs(wheelRpm) >= s.engineRpm - 80;
      s.clutch = s.clutchLocked ? 1 : 0.5;
      te = engineTorque(p, s, s.engineRpm, thrEff);
      if (s.shiftTimer > 0) te *= Math.max(p.shiftCut, 0.55);
    }
    s.rpm = clamp(s.engineRpm, 0, p.isEV ? p.redline * 1.05 : p.limiterRpm + 150);
    var driveT = te * Gt * p.efficiency;
    s.driveTorque = driveT;
    var Fd = driveT / rD;
    var fwdSign = s.gear < 0 ? -1 : 1;
    if (Fd * fwdSign > 0) Fd = fwdSign * Math.min(Math.abs(Fd) * A.punch * boost, A.tracG * mg * Math.max(1, boost));
    else Fd = sign(Fd) * Math.min(Math.abs(Fd), ARC.engBrakeG * mg) * smoothstep(0.5, 3, vF);

    /* ---- resistances / brakes ---- */
    var q = 0.5 * RHO * vx * vx;
    var df = q * p.clA;
    var dragX = -sign(vx) * q * p.cdA;
    var rr = p.rollingRes * rrMult * (mg + df) * Math.tanh(vx / 0.5);
    var sd = surfDrag * mg * Math.tanh(vx / 2);
    var bF = brk * A.brakeG * mg * arcadeSurfaceGrip(gripMult) + (hbBrake ? ARC.hbBrakeG * mg : slideOn ? ARC.slideBrakeG * mg : 0);
    var Fb = bF * Math.tanh(vx / 0.4);
    var latCap = arcadeLatCap(p, vF, gripMult) * (hb ? ARC.hbCurv : 1);
    // cornering scrub: leaning on the limit costs a little speed (so lines and braking still matter)
    var uLat = Math.min(1.3, Math.abs(vx * r) / Math.max(latCap, 1));
    var scrub = ARC.scrubG * G * uLat * uLat * smoothstep(3, 10, vF) * sign(vx);
    var axb = (Fd + dragX - rr - sd - Fb) / m + push - scrub;

    /* ---- yaw: follow the commanded curvature; lateral: grip constraint ----
       Solved in the PATH frame (rotated by the powerslide angle; = body frame when not sliding): the path yaw rate
       follows the curvature command, the path-lateral slip is pulled to ~0, and the body is the path + slide angle. */
    var cP = Math.cos(slPrev), sP = Math.sin(slPrev);
    var pu = vx * cP - vy * sP, pv = vx * sP + vy * cP;
    var rp = r - num(s.slideRate, 0);
    var puA = Math.abs(pu);
    var rT = pu * kappa;
    if (puA > 1) rT = clamp(rT, -latCap / puA, latCap / puA);
    var nrp = rp + (rT - rp) * (1 - Math.exp(-h / ARC.yawTau));
    var pvT = rT * p.b * (1 - smoothstep(2, 15, puA));
    var aMax = Math.max(latCap * 2.2, 25);
    var ayT = clamp((pvT - pv) / ARC.slipTau + pu * rp, -aMax, aMax);
    var npu = pu + h * (axb + pv * rp);
    var npv = pv + h * (ayT - pu * rp);
    if (thr < 0.02 && push <= 0 && pu * npu < 0) npu = 0;

    var spdNow = Math.sqrt(npu * npu + npv * npv);
    var stopped = spdNow < 0.25 && (brk > 0.05 || hb) && Math.abs(Fd) < 0.5 * (bF + 1);
    if (stopped || (spdNow < 0.05 && thr < 0.02 && Math.abs(Fd) < 1 && push <= 0)) { npu = 0; npv = 0; nrp = 0; }

    var slRate = (slNew - slPrev) / h;
    var cN = Math.cos(slNew), sN = Math.sin(slNew);
    var nvx = npu * cN + npv * sN, nvy = -npu * sN + npv * cN;
    var nr = nrp + slRate;
    s.slideRate = slRate;
    s.vx = nvx; s.vy = nvy; s.yawRate = nr;
    // world integration: the path direction moves with the path yaw rate only
    var hp = s.heading - slPrev + nrp * h * 0.5;
    var ch = Math.cos(hp), sh = Math.sin(hp);
    s.x += (npu * ch - npv * sh) * h; s.y += (npu * sh + npv * ch) * h;
    s.heading += nrp * h + (slNew - slPrev);
    s.speed = spdNow;
    s.odometer += s.speed * h;
    s.beta = s.speed > 1 ? Math.atan2(nvy, Math.abs(nvx)) : 0;

    var fa = 1 - Math.exp(-h / p.loadTau), lim = 4 * G;
    s.ax += (clamp(axb, -lim, lim) - s.ax) * fa;
    s.ay += (clamp(ayT, -lim, lim) - s.ay) * fa;
    s.gLong = s.ax / G; s.gLat = s.ay / G;

    /* ---- wheels / telemetry (cosmetic: no slip) ---- */
    var longT = m * s.ax * p.cgHeight / p.wheelbase, latT = m * s.ay * p.cgHeight / p.track;
    var axleF = Math.max(0.05 * mg, mg * p.weightFront + df * p.dfFrontFrac - longT);
    var axleR = Math.max(0.05 * mg, mg * (1 - p.weightFront) + df * (1 - p.dfFrontFrac) + longT);
    setAxleLoads(w[0], w[1], axleF, latT * p.rsdF);
    setAxleLoads(w[2], w[3], axleR, latT * (1 - p.rsdF));
    var fyTot = m * ayT, fxTot = Fd - Fb;
    for (var i = 0; i < 4; i++) {
      var wh = w[i], front = i < 2;
      wh.omega = nvx / (front ? p.radiusF : p.radiusR);
      wh.kappa = 0; wh.alpha = 0; wh.slip = 0; wh.skid = 0; wh.locked = false; wh.abs = 1;
      wh.fy = fyTot * (front ? p.b : p.a) / p.wheelbase / 2;
      wh.fx = fxTot / 4;
    }
    s.slipAngleF = 0; s.slipAngleR = 0; s.wheelspin = 0;
    s.skidding = clamp(Math.abs(slNew) / ARC.slideMax, 0, 1) * 0.7 + (hbBrake && vF > 8 ? 0.35 : 0);
    if (s.skidding > 0.05) { w[2].skid = w[3].skid = s.skidding; }
    s.tcFactor = 1; s.tcActive = false; s.absActive = false;
  }

  /* ------------------------------------------------------------ state */

  function makeWheel() {
    return { omega: 0, load: 0, kappa: 0, alpha: 0, fx: 0, fy: 0, slip: 0, skid: 0, locked: false, abs: 1, steer: 0 };
  }

  function createState(params, pose, opts) {
    pose = pose || {};
    opts = opts || {};
    if (opts.autoShift != null && pose.autoShift == null) pose = Object.assign({}, pose, { autoShift: !!opts.autoShift });
    var s = {
      x: 0, y: 0, heading: 0, vx: 0, vy: 0, yawRate: 0, speed: 0,
      rpm: params.idle, engineRpm: params.idle, gear: 1, maxGear: params.maxGear,
      slipAngleF: 0, slipAngleR: 0, beta: 0, wheelspin: 0, skidding: 0, steerAngle: 0,
      ax: 0, ay: 0, gLong: 0, gLat: 0,
      throttle: 0, brake: 0, handbrake: false, clutch: 1, clutchLocked: false,
      shiftTimer: 0, shiftCooldown: 0, shifting: false, autoShift: pose.autoShift !== false, loadHold: 0,
      tcFactor: 1, tcActive: false, absActive: false, launch: false, limiter: false, fuelCut: false,
      spool: 0, boost: 0, cvtRatio: params.cvtMax, reverseTimer: 0, reversing: false,
      wheels: [makeWheel(), makeWheel(), makeWheel(), makeWheel()], // FL, FR, RL, RR
      odometer: 0, t: 0, nanGuard: 0, driveTorque: 0, brakeLight: false, redline: params.redline,
      handling: params.handling === 'arcade' ? 'arcade' : 'sim', arcSteer: 0, spin: null, boosting: false,
      slideAngle: 0, slideDir: 0, powerslide: false, slideTime: 0, slideRate: 0
    };
    reset(params, s, pose);
    return s;
  }

  /** Re-place a car (e.g. reset to track). pose {x,y,heading,speed?,gear?} */
  function reset(params, s, pose) {
    pose = pose || {};
    s.x = num(pose.x, 0); s.y = num(pose.y, 0); s.heading = num(pose.heading, 0);
    var v = Math.max(0, num(pose.speed, 0));
    s.vx = v; s.vy = 0; s.yawRate = 0; s.speed = v;
    s.steerAngle = 0; s.ax = 0; s.ay = 0; s.gLong = 0; s.gLat = 0;
    s.shiftTimer = 0; s.shiftCooldown = 0; s.loadHold = 0; s.shifting = false; s.reverseTimer = 0; s.reversing = false;
    s.tcFactor = 1; s.spool = 0; s.limiter = false; s.fuelCut = false; s.launch = false;
    s.spin = null; s.arcSteer = 0; s.slideAngle = 0; s.slideDir = 0; s.powerslide = false; s.slideTime = 0; s.slideRate = 0;
    for (var i = 0; i < 4; i++) {
      var w = s.wheels[i];
      var R = i < 2 ? params.radiusF : params.radiusR;
      w.omega = v / R; w.kappa = 0; w.alpha = 0; w.fx = 0; w.fy = 0; w.slip = 0; w.skid = 0; w.locked = false; w.abs = 1; w.steer = 0;
    }
    var gear = pose.gear != null ? clamp(Math.round(pose.gear), -1, params.maxGear) : 1;
    if (pose.gear == null && v > 1 && !params.isCVT) {
      var rD = params.layout === 'fwd' ? params.radiusF : params.radiusR;
      gear = 1;
      while (gear < params.maxGear && v / rD * gearRatioTotal(params, gear) * RADS_TO_RPM > params.upshiftRpm[gear - 1] * 0.9) gear++;
    }
    s.gear = gear;
    s.cvtRatio = params.cvtMax;
    var rDr = params.layout === 'fwd' ? params.radiusF : params.radiusR;
    var wr = Math.abs(v / rDr * gearRatioTotal(params, gear, s.cvtRatio) * RADS_TO_RPM);
    s.rpm = s.engineRpm = Math.max(params.idle, Math.min(wr, params.redline));
    s.clutchLocked = wr > params.idle + 200 || params.isEV;
    initLoads(params, s);
    return s;
  }

  function initLoads(p, s) {
    var mg = p.mass * G;
    var FzF = mg * p.weightFront / 2, FzR = mg * (1 - p.weightFront) / 2;
    s.wheels[0].load = s.wheels[1].load = FzF;
    s.wheels[2].load = s.wheels[3].load = FzR;
  }

  /* ------------------------------------------------------- tyre model */
  // Writes into TIRE scratch: fx, fy (wheel frame), s (normalised slip)
  var TIRE = { fx: 0, fy: 0, s: 0 };
  function tire(p, Fz, mu, kp, ap, kappa, tanA) {
    var sx = kappa / kp, sy = tanA / ap;
    var s = Math.sqrt(sx * sx + sy * sy);
    TIRE.s = s;
    if (s < 1e-9 || Fz <= 0) { TIRE.fx = 0; TIRE.fy = 0; return TIRE; }
    var Bs = p.shapeB * s;
    var f = Math.sin(p.shapeC * Math.atan(Bs));
    if (s > 1) f *= 1 - 0.06 * Math.min(1, (s - 1) / 4); // extra sliding friction loss
    var F = mu * Fz * f;
    TIRE.fx = F * p.muXScale * sx / s;
    TIRE.fy = -F * sy / s;
    return TIRE;
  }

  /* ---------------------------------------------------- engine torque */
  function engineTorque(p, s, rpm, throttle) {
    if (p.isEV) {
      var t = lookupTorque(p, Math.abs(rpm));
      if (Math.abs(rpm) > p.redline) t = 0;
      var drive = t * throttle;
      var regen = p.regen > 0 ? -(p.regen / 3) * 0.28 * p.peakNm * (1 - throttle) * smoothstep(300, 2000, Math.abs(rpm)) : 0;
      return drive + regen;
    }
    // rev limiter with fuel-cut hysteresis
    if (rpm >= p.limiterRpm) s.fuelCut = true;
    else if (rpm < p.redline - 180) s.fuelCut = false;
    s.limiter = s.fuelCut;
    var fr = p.frictionNm * (0.35 + 0.65 * clamp(rpm / p.redline, 0, 1.2));
    if (s.fuelCut) return -fr;
    var base = lookupTorque(p, Math.max(rpm, p.idle));
    if (p.turbo) base *= p.naFrac + (1 - p.naFrac) * s.spool;
    return throttle * base - (1 - throttle) * fr;
  }

  /* ---------------------------------------------------- gearbox logic */
  function requestShift(p, s, target) {
    if (target === s.gear) return false;
    if (target > p.maxGear || target < -1) return false;
    s.gear = target;
    s.shiftTimer = p.shiftTime;
    s.shifting = p.shiftTime > 0;
    s.shiftCooldown = Math.max(p.shiftTime + 0.35, 0.45);
    return true;
  }

  function drivenOmega(p, s) {
    var w = s.wheels;
    var f = (w[0].omega + w[1].omega) * 0.5, r = (w[2].omega + w[3].omega) * 0.5;
    if (p.layout === 'fwd') return f;
    if (p.layout === 'rwd') return r;
    return f * p.splitF + r * (1 - p.splitF);
  }

  function autoShiftLogic(p, s, thr, brk, h) {
    if (p.isCVT || p.maxGear <= 1 || s.gear < 1) return;
    // "Lift-off hold": remember recent throttle for ~1.5 s so a quick lift (keyboard tap, corner entry)
    // doesn't short-shift the box to the top gear only for kickdown to drop it straight back.
    var held = Math.max(thr, (s.loadHold || 0) - (h || 0) * 0.65);
    s.loadHold = brk > 0.15 ? Math.max(thr, held * 0.5) : held;
    if (s.shiftCooldown > 0 || s.shiftTimer > 0) return;
    var g = s.gear;
    var wOm = drivenOmega(p, s);
    var rpmG = function (gear) { return Math.abs(wOm * gearRatioTotal(p, gear) * RADS_TO_RPM); };
    var rpm = rpmG(g);
    var load = Math.max(thr, 0);
    // upshift
    if (g < p.maxGear && brk < 0.1) {
      var upLoad = Math.max(load, s.loadHold * 0.9);
      var upAt = lerp(Math.max(p.idle + 1600, p.redline * 0.42), p.upshiftRpm[g - 1], Math.pow(upLoad, 0.65));
      var spinning = s.wheelspin > 0.35 && rpm < p.redline * 0.97;
      if (rpm > upAt && !spinning && !s.launch) { requestShift(p, s, g + 1); return; }
    }
    if (g > 1) {
      var lowerRpm = rpmG(g - 1);
      var safe = lowerRpm < p.upshiftRpm[g - 2] * 0.93;
      // braking downshift (engine braking, ready for exit)
      if (brk > 0.15 && lowerRpm < p.redline * 0.80) { requestShift(p, s, g - 1); return; }
      // coast / part-throttle downshift
      var downAt = lerp(Math.max(p.idle + 500, p.redline * 0.24), p.downshiftRpm[g - 1], Math.pow(load, 0.8));
      if (rpm < downAt && safe) { requestShift(p, s, g - 1); return; }
      // kickdown: driver floors it and lower gear gives >12 % more wheel torque
      if (thr > 0.92 && safe) {
        var fNow = lookupTorque(p, rpm) * p.ratios[g - 1];
        var fLow = lookupTorque(p, lowerRpm) * p.ratios[g - 2];
        if (fLow > fNow * 1.12) { requestShift(p, s, g - 1); return; }
      }
      if (rpm < p.idle * 1.05 && safe) { requestShift(p, s, g - 1); }
    }
    void h;
  }

  /* -------------------------------------------------------------- step */

  var DEFAULT_ENV = { gripMult: 1, wet: 0 };
  var DEFAULT_ARC = {};
  var SURFACE = {
    asphalt: { rr: 1, drag: 0 }, kerb: { rr: 1.4, drag: 0.01 }, grass: { rr: 4.5, drag: 0.035 },
    sand: { rr: 14, drag: 0.12 }, gravel: { rr: 9, drag: 0.08 }, wall: { rr: 1.5, drag: 0.02 }
  };

  /**
   * step(params, state, input, dt, env) -> state (mutated in place)
   * input {throttle 0..1, brake 0..1, steer -1..1 (+left), handbrake, shiftUp, shiftDown}
   * env   {gripMult (surface x weather, default 1), wet (bool|0..1),
   *        surface? ('asphalt'|'kerb'|'grass'|'sand'|...: rolling/drag only, grip comes from gripMult),
   *        rollingMult?, dragMult?, wheelGrip? [4] per-wheel extra grip multipliers,
   *        assists? {abs:bool, tc:bool, autoShift:bool, steeringAssist:bool} (override build settings)}
   */
  function step(p, s, input, dt, env) {
    input = input || {};
    env = env || DEFAULT_ENV;
    dt = clamp(num(dt, 1 / 120), 0, 0.1);
    if (dt <= 0) return s;

    var assists = env.assists || {};
    if (assists.autoShift != null) s.autoShift = !!assists.autoShift;
    var tcLevel = assists.tc === false ? 0 : (assists.tc === true && p.tcLevel === 0 ? 2 : p.tcLevel);
    var absLevel = assists.abs === false ? 0 : (assists.abs === true && p.absLevel === 0 ? 2 : p.absLevel);

    var rawThr = clamp(num(input.throttle, 0), 0, 1);
    var rawBrk = clamp(num(input.brake, 0), 0, 1);
    var steerIn = clamp(num(input.steer, 0), -1, 1);
    var hb = !!input.handbrake;
    // input.slideRack (drift keyboard steering): the speed-sensitive rack limit is measured from the front axle's
    // travel direction while sliding, so a slide can be counter-steered at speed (inert unless the flag is set)
    s.slideRack = !!input.slideRack;

    /* ---------- gear selection: manual edges, reverse logic ---------- */
    var fwdSpeed = s.vx;
    if (input.shiftUp) {
      if (s.gear < 0) requestShift(p, s, 1);
      else if (s.gear < p.maxGear && !p.isCVT) requestShift(p, s, Math.max(1, s.gear + 1));
    }
    if (input.shiftDown) {
      if (s.gear > 1 && !p.isCVT) {
        var wOmD = drivenOmega(p, s);
        var newRpm = Math.abs(wOmD * gearRatioTotal(p, s.gear - 1) * RADS_TO_RPM);
        if (newRpm < p.redline * 1.02) requestShift(p, s, s.gear - 1); // money-shift protection
      } else if (s.gear >= 0 && Math.abs(fwdSpeed) < 1.5) requestShift(p, s, -1);
    }
    if (input.reverse && s.gear >= 0 && Math.abs(fwdSpeed) < 1.5) {
      requestShift(p, s, -1); s.shiftTimer = 0; s.shifting = false; s.reverseTimer = 0;
    } else if (s.gear >= 0) {
      if (Math.abs(fwdSpeed) < 0.8 && rawBrk > 0.3 && rawThr < 0.1) {
        s.reverseTimer += dt;
        if (s.reverseTimer > 0.4) { requestShift(p, s, -1); s.shiftTimer = 0; s.shifting = false; s.reverseTimer = 0; }
      } else s.reverseTimer = 0;
    } else {
      if (rawThr > 0.1 && fwdSpeed > -0.8) {
        s.reverseTimer += dt;
        if (s.reverseTimer > 0.15) { requestShift(p, s, 1); s.shiftTimer = 0; s.shifting = false; s.reverseTimer = 0; }
      } else s.reverseTimer = 0;
    }
    s.reversing = s.gear < 0;
    var pedalDrive = s.reversing ? rawBrk : rawThr;
    var pedalBrake = s.reversing ? rawThr : rawBrk;

    if (s.autoShift) autoShiftLogic(p, s, pedalDrive, pedalBrake, dt);

    /* ---------- launch control ---------- */
    var launchCtl = p.launchControl && p.handling !== 'arcade' && s.gear === 1 && pedalDrive > 0.9 && s.vx < 12 && (s.launch || Math.abs(s.vx) < 1);
    s.launch = launchCtl;

    /* ---------- environment ---------- */
    var grip = clamp(num(env.gripMult, 1), 0.05, 2);
    // wetness 0..1: env.wetness (preferred), env.wet (bool or number)
    var wet = env.wetness != null ? clamp(num(env.wetness, 0), 0, 1) : env.wet === true ? 1 : clamp(num(env.wet, 0), 0, 1);
    if (env.wet === true) wet = Math.max(wet, 0.6);
    // Compound-specific wet behaviour. The caller's gripMult may already carry a generic weather factor
    // (engine: wet ~0.8), so here we apply the compound's wet ratio relative to a typical road tyre (~0.85):
    // good wet tyres lose little extra, slicks fall off a cliff. Without a weather factor in gripMult
    // (gripMult >= 0.95) the absolute ratio is applied instead.
    var wetRef = num(env.gripMult, 1) >= 0.95 ? 1 : 0.85;
    var wetF = clamp(lerp(1, Math.min(1.08, p.wetRatio / wetRef), wet), 0.25, 1.08);
    var surf = SURFACE[env.surface] || SURFACE.asphalt;
    var rrMult = num(env.rollingMult, surf.rr);
    var surfDrag = num(env.dragMult, surf.drag);
    var wg = Array.isArray(env.wheelGrip) ? env.wheelGrip : null;

    /* ---------- substeps ---------- */
    var n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-9));
    var h = dt / n;
    var arcade = p.handling === 'arcade' && p.arcade;
    var arEnv = env.arcade || DEFAULT_ARC;
    for (var k = 0; k < n; k++) {
      if (s.spin) spinSubstep(p, s, h);
      else if (arcade) arcadeSubstep(p, s, h, pedalDrive, pedalBrake, steerIn, hb, grip * wetF, rrMult, surfDrag, arEnv);
      else substep(p, s, h, pedalDrive, pedalBrake, steerIn, hb, grip * wetF, rrMult, surfDrag, wg, tcLevel, absLevel, assists, launchCtl);
    }

    /* ---------- timers ---------- */
    if (s.shiftTimer > 0) { s.shiftTimer -= dt; if (s.shiftTimer <= 0) { s.shiftTimer = 0; s.shifting = false; } }
    if (s.shiftCooldown > 0) s.shiftCooldown = Math.max(0, s.shiftCooldown - dt);
    s.throttle = pedalDrive;
    s.brake = Math.max(pedalBrake, hb ? 0.5 : 0);
    s.handbrake = hb;
    s.brakeLight = pedalBrake > 0.05;
    s.t += dt;

    /* ---------- NaN guard ---------- */
    if (!(isFinite(s.x) && isFinite(s.y) && isFinite(s.heading) && isFinite(s.vx) && isFinite(s.vy) && isFinite(s.yawRate) && isFinite(s.rpm))) {
      s.nanGuard++;
      if (!isFinite(s.x)) s.x = 0;
      if (!isFinite(s.y)) s.y = 0;
      if (!isFinite(s.heading)) s.heading = 0;
      s.vx = 0; s.vy = 0; s.yawRate = 0; s.rpm = s.engineRpm = p.idle; s.ax = s.ay = 0; s.spool = 0;
      for (var wi = 0; wi < 4; wi++) { s.wheels[wi].omega = 0; s.wheels[wi].kappa = 0; s.wheels[wi].alpha = 0; }
      initLoads(p, s);
    }
    s.heading = wrapAngle(s.heading);
    return s;
  }

  // wheel geometry: x (fwd), y (left)
  function wheelX(p, i) { return i < 2 ? p.a : -p.b; }
  function wheelY(p, i) { return (i & 1) ? -p.track / 2 : p.track / 2; }

  /** Rack limit (rad) with input.slideRack: the normal limit plus the front axle's sideslip (capped at full lock). */
  function slideRackLimit(p, s, vF, maxSteer) {
    var a = isFinite(p.a) ? p.a : p.wheelbase * 0.48;
    var betaF = Math.atan2(s.vy + s.yawRate * a, Math.max(vF, 3));
    return clamp(maxSteer + Math.abs(betaF), maxSteer, p.lockAngle);
  }
  function substep(p, s, h, thr, brk, steerIn, hb, gripMult, rrMult, surfDrag, wg, tcLevel, absLevel, assists, launchCtl) {
    var mg = p.mass * G;
    var vx = s.vx, vy = s.vy, r = s.yawRate;
    var vAbs = Math.sqrt(vx * vx + vy * vy);
    var w = s.wheels;

    /* ---- aero ---- */
    var activeLow = p.activeAero && thr > 0.8 && Math.abs(steerIn) < 0.15 && brk < 0.05;
    var activeBrake = p.activeAero && brk > 0.4 && vAbs > 30;
    var q = 0.5 * RHO * vx * vx;
    var df = q * p.clA * (activeLow ? 0.55 : activeBrake ? 1.25 : 1);
    var dragX = -sign(vx) * q * p.cdA * (activeLow ? 0.86 : activeBrake ? 1.35 : 1);
    var dragY = -0.5 * RHO * p.sideCdA * vy * Math.abs(vy);
    // surface drag (grass/sand ploughing), proportional to weight & speed (smooth near 0)
    var sd = surfDrag * mg;
    dragX -= sd * Math.tanh(vx / 2);
    dragY -= sd * Math.tanh(vy / 2);

    /* ---- loads (quasi-static transfer with lag-filtered accelerations) ---- */
    var dfF = df * p.dfFrontFrac, dfR = df - dfF;
    var longT = p.mass * s.ax * p.cgHeight / p.wheelbase;
    var axleF = mg * p.weightFront + dfF - longT;
    var axleR = mg * (1 - p.weightFront) + dfR + longT;
    var minAxle = 0.04 * mg;
    if (axleF < minAxle) { axleR += axleF - minAxle; axleF = minAxle; }
    if (axleR < minAxle) { axleF += axleR - minAxle; axleR = minAxle; }
    var latT = p.mass * s.ay * p.cgHeight / p.track;
    var dF = latT * p.rsdF, dR = latT * (1 - p.rsdF);
    setAxleLoads(w[0], w[1], axleF, dF);
    setAxleLoads(w[2], w[3], axleR, dR);
    var Fz0 = mg / 4;
    var fzRefF = fin(p.fzRefF, Fz0), fzRefR = fin(p.fzRefR, Fz0), fz0F = fin(p.fz0F, Fz0), fz0R = fin(p.fz0R, Fz0);

    /* ---- steering ---- */
    var vF = Math.max(Math.abs(vx), 0);
    var speedLimit = p.lockAngle / (1 + Math.pow(vF / 21, 1.6));
    var latCap = latAccelAt(p, vF, gripMult);
    var physLimit = vF > 1 ? Math.atan(p.wheelbase * latCap / (vF * vF)) + Math.atan(p.tanAlphaPeakF) * 1.25 : p.lockAngle;
    var maxSteer = clamp(Math.max(speedLimit, Math.min(physLimit, p.lockAngle)), 0.045, p.lockAngle);
    if (s.slideRack && vF > 1) maxSteer = slideRackLimit(p, s, vF, maxSteer);
    var target = steerIn * maxSteer;
    if (assists.steeringAssist && vF > 5) {
      // counter-steer toward the direction of travel when the rear steps out
      var betaA = Math.atan2(vy, vF);
      target += clamp(betaA * 0.55, -0.25, 0.25);
      target = clamp(target, -p.lockAngle, p.lockAngle);
    }
    var rate = p.steerRate / (1 + vF / 45);
    s.steerAngle = approach(s.steerAngle, target, rate * h);
    var delta = s.steerAngle;
    // Ackermann (70 %)
    var dL = delta, dRgt = delta;
    if (Math.abs(delta) > 1e-4) {
      var Rt = p.wheelbase / Math.tan(Math.abs(delta));
      var inner = Math.atan(p.wheelbase / Math.max(Rt - p.track / 2, 0.5));
      var outer = Math.atan(p.wheelbase / (Rt + p.track / 2));
      var sg = sign(delta);
      var di = lerp(Math.abs(delta), inner, 0.7) * sg, dout = lerp(Math.abs(delta), outer, 0.7) * sg;
      if (delta > 0) { dL = di; dRgt = dout; } else { dL = dout; dRgt = di; }
    }
    w[0].steer = dL; w[1].steer = dRgt; w[2].steer = 0; w[3].steer = 0;

    /* ---- spool ---- */
    if (p.turbo) {
      var spT = clamp(thr * smoothstep(p.idle, p.idle + 2200, s.engineRpm) + (launchCtl ? 0.8 : 0), 0, 1);
      var tau = spT > s.spool ? 0.08 + p.turboLag * 1.1 : 0.35;
      s.spool += (spT - s.spool) * (1 - Math.exp(-h / tau));
      s.boost = s.spool;
    } else { s.spool = 1; s.boost = thr; }

    /* ---- CVT ratio ---- */
    var rD = p.layout === 'fwd' ? p.radiusF : p.radiusR;
    if (p.isCVT && s.gear > 0) {
      var tgtRpm = lerp(p.idle + 900, p.peakKwRpm, Math.pow(thr, 0.8));
      var wOmC = Math.max(Math.abs(drivenOmega(p, s)), 0.5);
      var desired = clamp(tgtRpm * RPM_TO_RADS / (wOmC * p.finalDrive), p.cvtMin, p.cvtMax);
      s.cvtRatio = approach(s.cvtRatio, desired, 1.6 * h);
    }

    /* ---- traction control (from previous slip) ---- */
    var drv = [p.splitF > 0, p.splitF > 0, p.splitF < 1, p.splitF < 1];
    var maxDrivenK = 0;
    for (var di2 = 0; di2 < 4; di2++) if (drv[di2]) {
      var kp = di2 < 2 ? p.kappaPeakF : p.kappaPeakR;
      // slip-velocity based measure: a deadband + larger low-speed floor than the tyre model, so a few
      // tenths of m/s of creep slip at launch is not mistaken for wheelspin
      var wvxT = num(w[di2]._wvx, vx), Rt2 = di2 < 2 ? p.radiusF : p.radiusR;
      var slipV = (w[di2].omega * Rt2 - wvxT) * (s.gear < 0 ? -1 : 1);
      var kTC = Math.max(0, slipV - 0.4) / Math.max(Math.abs(wvxT), 3.5);
      var kN = kTC / kp;
      // combined slip: a tyre that is already using its grip sideways has less left for drive, so the
      // TC measure includes the (previous step's) lateral utilisation -> TC cuts earlier mid-corner
      if (tcLevel > 0 && w[di2]._tanA != null && kN > 0.05) {
        var lN = Math.abs(w[di2]._tanA) / (di2 < 2 ? p.tanAlphaPeakF : p.tanAlphaPeakR);
        kN = Math.sqrt(kN * kN + 0.55 * Math.min(lN, 2) * Math.min(lN, 2));
      }
      maxDrivenK = Math.max(maxDrivenK, kN);
    }
    var tcTarget = launchCtl ? 1.05 : tcLevel === 3 ? 1.0 : tcLevel === 2 ? 1.35 : tcLevel === 1 ? 1.9 : Infinity;
    if (isFinite(tcTarget)) {
      if (maxDrivenK > tcTarget) s.tcFactor = Math.max(0.05, s.tcFactor - h * 14 * Math.min(3, (maxDrivenK - tcTarget) / tcTarget + 0.2));
      else s.tcFactor = Math.min(1, s.tcFactor + h * 2.8);
      // ESC-style guard on large body slip
      if (tcLevel >= 2 && vAbs > 8) {
        // ESC-style stability guard: body slip angle plus yaw rate in excess of what the front axle asks
        // for (oversteer building up). Throttle is cut progressively, down to zero for a real slide.
        var beta = Math.abs(Math.atan2(vy, Math.abs(vx)));
        var lim = tcLevel === 3 ? 0.07 : 0.12;
        var rRef = Math.abs(vx) * Math.tan(Math.abs(s.steerAngle)) / p.wheelbase;
        var latCapR = latAccelAt(p, vAbs, gripMult) / Math.max(vAbs, 1);
        var rExcess = Math.abs(r) - Math.min(rRef, latCapR) * 1.15;
        var overs = (beta > lim ? (beta - lim) * 7 : 0) + (rExcess > 0.08 && r * vy < 0 ? (rExcess - 0.08) * 2.5 : 0);
        if (overs > 0) s.tcFactor = Math.min(s.tcFactor, clamp(1 - overs, tcLevel === 3 ? 0 : 0.05, 1));
      }
    } else s.tcFactor = 1;
    var thrEff = thr * s.tcFactor;
    s.tcActive = thr > 0.05 && s.tcFactor < 0.97;
    if (vAbs > p.governor) thrEff = Math.min(thrEff, Math.max(0, 1 - (vAbs - p.governor) * 0.5));
    // reverse speed limiter (~30 km/h)
    if (s.gear < 0) thrEff *= clamp((p.reverseMax + vx) / 2, 0, 1);

    /* ---- driveline: clutch / engine / drive torque ---- */
    var Gt = gearRatioTotal(p, s.gear, s.cvtRatio);
    var wOm = drivenOmega(p, s);
    var wheelRpm = wOm * Gt * RADS_TO_RPM; // positive when moving in gear direction
    var driveT = 0;          // torque at the wheels (sum), sign: + forward
    var engineCoupled = false;
    var shiftCutF = s.shiftTimer > 0 ? p.shiftCut : 1;
    if (s.gear === 0 || (hb && p.layout === 'rwd') || Gt === 0) {
      // neutral / clutch in
      var free = p.isEV ? 0 : p.idle + thrEff * (p.redline * 0.95 - p.idle);
      s.engineRpm = approach(s.engineRpm, free, h * (thrEff > 0.05 ? 9000 : 4000));
      s.clutchLocked = false; s.clutch = 0;
    } else if (p.isEV) {
      s.engineRpm = Math.abs(wheelRpm);
      var te = engineTorque(p, s, s.engineRpm, thrEff);
      if (wheelRpm < -50 && te < 0) te = 0; // no regen when rolling the wrong way
      driveT = te * Gt * p.efficiency;
      engineCoupled = true; s.clutchLocked = true; s.clutch = 1;
    } else {
      var engageRpm = launchCtl ? p.launchRpm : p.idle + 350;
      if (s.clutchLocked && (wheelRpm < p.idle * 0.92 || s.shiftTimer > 0 && p.shiftCut === 0)) s.clutchLocked = false;
      if (!s.clutchLocked && s.shiftTimer <= 0 && wheelRpm >= Math.max(engageRpm, s.engineRpm) - 60 && wheelRpm > p.idle) s.clutchLocked = true;
      if (s.shiftTimer > 0) {
        // rev-match toward new gear
        var syncRpm = clamp(Math.abs(wheelRpm), p.idle, p.redline);
        s.engineRpm = approach(s.engineRpm, syncRpm, h * 12000);
        var teS = engineTorque(p, s, s.engineRpm, thrEff);
        driveT = teS * shiftCutF * Gt * p.efficiency;
        s.clutch = shiftCutF;
      } else if (s.clutchLocked) {
        s.engineRpm = Math.max(Math.abs(wheelRpm), p.idle * 0.9);
        var teL = engineTorque(p, s, s.engineRpm, thrEff);
        driveT = teL * Gt * p.efficiency;
        engineCoupled = true; s.clutch = 1;
      } else {
        // slipping clutch / torque converter: engine revs toward a stall/launch speed
        var stall = launchCtl ? p.launchRpm : p.converter ? Math.min(p.redline * 0.42, 2800) : clamp(p.peakNmRpm * 0.7, p.idle + 1000, p.redline * 0.6);
        var tgt = Math.max(p.idle + thrEff * (stall - p.idle), Math.abs(wheelRpm));
        s.engineRpm = approach(s.engineRpm, tgt, h * (tgt > s.engineRpm ? 7000 : 5000));
        var teC = Math.max(0, engineTorque(p, s, s.engineRpm, thrEff));
        var engage = smoothstep(p.idle, p.idle + 400, s.engineRpm) * (thrEff > 0.02 ? 1 : 0);
        var mult = 1;
        if (p.converter) {
          var sr = clamp(Math.abs(wheelRpm) / Math.max(s.engineRpm, 1), 0, 1);
          mult = 1 + 0.9 * (1 - sr); // torque multiplication
          if (thrEff < 0.02 && brk < 0.05) teC = p.peakNm * 0.06, engage = 1; // creep
        }
        driveT = teC * engage * mult * Gt * p.efficiency;
        s.clutch = engage * 0.5;
      }
    }
    s.rpm = clamp(s.engineRpm, 0, p.isEV ? p.redline * 1.05 : p.limiterRpm + 150);
    s.driveTorque = driveT;

    // engine inertia reflected to driven wheels when coupled
    var IeRef = engineCoupled ? p.engineInertia * Gt * Gt : 0;

    // torque distribution: axle split (centre), side-to-side (diff + vectoring)
    var tF = driveT * p.splitF, tR = driveT * (1 - p.splitF);
    if (hb && p.layout === 'awd') { tF = driveT * Math.max(p.splitF, 0.6); tR = driveT - tF; tR *= 0.2; }
    var tvBias = 0;
    if (p.torqueVectoring && vAbs > 3 && driveT > 0) tvBias = clamp(delta / p.lockAngle, -1, 1) * 0.28 * Math.min(1, thr * 1.5);
    // + delta (left turn) -> more torque to RIGHT (outer) wheels
    var Td = [tF * 0.5 * (1 - tvBias * 0.5), tF * 0.5 * (1 + tvBias * 0.5), tR * 0.5 * (1 - tvBias), tR * 0.5 * (1 + tvBias)];
    var share = [p.splitF * 0.5, p.splitF * 0.5, (1 - p.splitF) * 0.5, (1 - p.splitF) * 0.5];

    /* ---- brakes / ABS ---- */
    var absTarget = absLevel === 3 ? 1.0 : absLevel === 2 ? 1.2 : 1.45; // in units of kappaPeak
    var anyAbs = false;
    var cosD, sinD;
    var sumFx = 0, sumFy = 0, sumMz = 0;
    var latBlendA = 0;
    var maxSlip = 0, maxSpin = 0;
    var aF = 0, aR = 0;

    for (var i = 0; i < 4; i++) {
      var wh = w[i];
      var front = i < 2;
      var R = front ? p.radiusF : p.radiusR;
      var Iw = (front ? p.IwF : p.IwR) + IeRef * share[i];
      var mu = (front ? p.muF : p.muR) * gripMult * (wg ? num(wg[i], 1) : 1);
      var Fz = wh.load;
      // load sensitivity
      mu *= clamp(1 - p.loadSens * (Fz - (front ? fzRefF : fzRefR)) / (front ? fz0F : fz0R), 0.72, 1.18);
      var kpk = front ? p.kappaPeakF : p.kappaPeakR;
      var apk = front ? p.tanAlphaPeakF : p.tanAlphaPeakR;
      // contact patch velocity in body frame
      var xi = wheelX(p, i), yi = wheelY(p, i);
      var cvx = vx - r * yi, cvy = vy + r * xi;
      cosD = Math.cos(wh.steer); sinD = Math.sin(wh.steer);
      var wvx = cvx * cosD + cvy * sinD;      // wheel-frame longitudinal
      var wvy = -cvx * sinD + cvy * cosD;     // wheel-frame lateral
      var den = Math.max(Math.abs(wvx), V_LOW_LONG);
      var tanA = wvy / Math.max(Math.abs(wvx), V_LOW_LAT);
      tanA = clamp(tanA, -3, 3);

      // brake torque request
      var Tb = brk * (front ? p.maxBrakeTorqueF : p.maxBrakeTorqueR);
      if (!front && hb) Tb = Math.max(Tb, p.handbrakeTorque);
      // ABS modulation (not on handbrake-locked rears)
      if (absLevel > 0 && Tb > 0 && !(hb && !front) && Math.abs(wvx) > 2) {
        var kn = -wh.kappa / kpk;
        // cornering-brake control: account for the lateral slip already using the friction ellipse
        if (kn > 0.25) { var ln = wh._tanA != null ? wh._tanA / apk : 0; kn = Math.sqrt(kn * kn + 0.6 * ln * ln); }
        if (kn > absTarget) wh.abs = Math.max(0.12, wh.abs - h * (absLevel === 3 ? 40 : 28));
        else wh.abs = Math.min(1, wh.abs + h * (absLevel === 3 ? 14 : 8));
        Tb *= wh.abs;
        if (wh.abs < 0.95) anyAbs = true;
      } else wh.abs = 1;

      // rolling resistance torque
      var Trr = p.rollingRes * rrMult * Fz * R * Math.tanh(wh.omega * R / 0.5);

      // implicit spin update
      var kap0 = clamp((wh.omega * R - wvx) / den, -1.5, 12);
      tire(p, Fz, mu, kpk, apk, kap0, tanA);
      var fx0 = TIRE.fx;
      tire(p, Fz, mu, kpk, apk, kap0 + 0.002, tanA);
      var slope = Math.max(0, (TIRE.fx - fx0) / 0.002); // dFx/dkappa
      var kw = slope * R / den;                         // dFx/domega
      var denomI = Iw + h * R * kw;
      var om = wh.omega + h * (Td[i] - R * fx0 - Trr) / denomI;
      var dOmB = h * Tb / denomI;
      var locked = false;
      if (dOmB > 0) {
        if (Math.abs(om) <= dOmB) { om = 0; locked = Tb > 0 && Math.abs(wvx) > 0.5; }
        else om -= sign(om) * dOmB;
      }
      wh.omega = om;
      wh.locked = locked;
      wh._R = R; wh._mu = mu; wh._kp = kpk; wh._ap = apk; wh._den = den; wh._tanA = tanA; wh._wvx = wvx;
      wh._Iw = Iw;
    }

    /* ---- differentials: speed equalisation (LSD / locking / centre) ---- */
    var drvLock = function (lock, ia, ib, torque) {
      if (lock <= 0) return;
      var eff = lock >= 0.95 ? 1 : 1 - Math.exp(-h * lock * (torque >= 0 ? 70 : 35));
      var A = w[ia], B = w[ib];
      var m = (A.omega * A._Iw + B.omega * B._Iw) / (A._Iw + B._Iw);
      A.omega += (m - A.omega) * eff;
      B.omega += (m - B.omega) * eff;
    };
    if (p.splitF > 0) drvLock(p.lockF, 0, 1, tF);
    if (p.splitF < 1 && !hb) drvLock(p.lockR, 2, 3, tR);
    if (p.layout === 'awd' && p.lockC > 0 && !hb) {
      var effC = 1 - Math.exp(-h * p.lockC * 40);
      var vFr = (w[0].omega + w[1].omega) * 0.5 * p.radiusF, vRr = (w[2].omega + w[3].omega) * 0.5 * p.radiusR;
      var IF = w[0]._Iw + w[1]._Iw, IR = w[2]._Iw + w[3]._Iw;
      var vm = (vFr * IF + vRr * IR) / (IF + IR);
      var cF = (vm - vFr) * effC / p.radiusF, cR = (vm - vRr) * effC / p.radiusR;
      w[0].omega += cF; w[1].omega += cF; w[2].omega += cR; w[3].omega += cR;
    }

    /* ---- tyre forces with final spin ---- */
    for (var j = 0; j < 4; j++) {
      var q2 = w[j];
      var kap = clamp((q2.omega * q2._R - q2._wvx) / q2._den, -1.5, 12);
      tire(p, q2.load, q2._mu, q2._kp, q2._ap, kap, q2._tanA);
      q2.kappa = kap;
      q2.alpha = Math.atan(q2._tanA);
      q2.fx = TIRE.fx; q2.fy = TIRE.fy;
      q2.slip = TIRE.s;
      var cs = Math.cos(q2.steer), sn = Math.sin(q2.steer);
      var bfx = q2.fx * cs - q2.fy * sn;
      var bfy = q2.fx * sn + q2.fy * cs;
      sumFx += bfx; sumFy += bfy;
      sumMz += wheelX(p, j) * bfy - wheelY(p, j) * bfx;
      var spd = Math.abs(q2._wvx) + Math.abs(q2._tanA * q2._den);
      var slideAmt = clamp((TIRE.s - 1.15) / 1.6, 0, 1) * smoothstep(1.5, 6, spd);
      if (q2.locked) slideAmt = Math.max(slideAmt, smoothstep(1, 5, Math.abs(q2._wvx)));
      q2.skid = slideAmt;
      maxSlip = Math.max(maxSlip, slideAmt);
      if (drv[j]) {
        var spin = clamp(((s.gear < 0 ? -kap : kap) / q2._kp - 1.3) / 3, 0, 1);
        if (q2.omega * q2._R - q2._wvx > 1.2) spin = Math.max(spin, clamp((q2.omega * q2._R - q2._wvx - 1.2) / 6, 0, 1));
        maxSpin = Math.max(maxSpin, spin);
      }
      if (j < 2) aF += q2.alpha; else aR += q2.alpha;
    }
    s.absActive = anyAbs;
    s.slipAngleF = aF / 2; s.slipAngleR = aR / 2;
    s.wheelspin = maxSpin;
    s.skidding = maxSlip;

    /* ---- integrate body ---- */
    var Fx = sumFx + dragX;
    var Fy = sumFy + dragY;
    var axb = Fx / p.mass, ayb = Fy / p.mass;
    var nvx = vx + h * (axb + vy * r);
    var nvy = vy + h * (ayb - vx * r);
    var nr = r + h * sumMz / p.Iz;

    // rolling stop: no sign flip from resistive forces alone when nearly stopped
    if (thr < 0.02 && Math.abs(driveT) < 1 && vx * nvx < 0) nvx = 0;

    /* ---- low-speed kinematic blend ---- */
    var spdNow = Math.sqrt(nvx * nvx + nvy * nvy);
    var wDyn = smoothstep(KIN_V0, KIN_V1, spdNow);
    if (wDyn < 1) {
      var kinR = nvx * Math.tan(delta) / p.wheelbase;
      var kinVy = kinR * p.b;
      nr = lerp(kinR, nr, wDyn);
      nvy = lerp(kinVy, nvy, wDyn);
      latBlendA = 1 - wDyn;
    }
    // full stop latch
    var stopped = spdNow < 0.25 && (brk > 0.05 || hb) && Math.abs(driveT) < 0.5 * (brk * p.brakeForceMax * rD + 1);
    if (stopped || (spdNow < 0.05 && thr < 0.02 && Math.abs(driveT) < 1)) {
      nvx = 0; nvy = 0; nr = 0;
      for (var z = 0; z < 4; z++) if (Math.abs(w[z].omega) < 2) w[z].omega = 0;
    }
    void latBlendA;

    s.vx = nvx; s.vy = nvy; s.yawRate = nr;
    // world integration (semi-implicit)
    var hd = s.heading + nr * h * 0.5;
    var ch = Math.cos(hd), sh = Math.sin(hd);
    var wx = nvx * ch - nvy * sh, wy = nvx * sh + nvy * ch;
    s.x += wx * h; s.y += wy * h;
    s.heading += nr * h;
    s.speed = Math.sqrt(nvx * nvx + nvy * nvy);
    s.odometer += s.speed * h;
    s.beta = s.speed > 1 ? Math.atan2(nvy, Math.abs(nvx)) : 0;

    // filtered accelerations for load transfer (suspension lag)
    var fa = 1 - Math.exp(-h / p.loadTau);
    var lim = 4 * G;
    s.ax += (clamp(axb, -lim, lim) - s.ax) * fa;
    s.ay += (clamp(ayb, -lim, lim) - s.ay) * fa;
    s.gLong = s.ax / G; s.gLat = s.ay / G;
  }

  function setAxleLoads(L, Rw, axle, dLat) {
    // dLat > 0 (accelerating left) moves load to the right wheel
    var l = axle / 2 - dLat, rr = axle / 2 + dLat;
    var mn = axle * 0.01;
    if (l < mn) { rr += l - mn; l = mn; }
    if (rr < mn) { l += rr - mn; rr = mn; }
    L.load = l; Rw.load = rr;
  }

  /* ------------------------------------------------- world-space helpers */
  function worldVelocity(s) {
    var c = Math.cos(s.heading), sn = Math.sin(s.heading);
    return { vx: s.vx * c - s.vy * sn, vy: s.vx * sn + s.vy * c };
  }
  function setWorldVelocity(p, s, wvx, wvy) {
    var c = Math.cos(s.heading), sn = Math.sin(s.heading);
    var oldVx = s.vx;
    s.vx = wvx * c + wvy * sn;
    s.vy = -wvx * sn + wvy * c;
    s.speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    // keep wheels roughly consistent with the new longitudinal speed (avoid fake wheelspin)
    var dv = s.vx - oldVx;
    for (var i = 0; i < 4; i++) {
      var R = i < 2 ? p.radiusF : p.radiusR;
      s.wheels[i].omega += dv / R;
    }
    return s;
  }
  /** Apply a world-space impulse (N·s) at world point (px,py). */
  function applyImpulse(p, s, jx, jy, px, py) {
    var c = Math.cos(s.heading), sn = Math.sin(s.heading);
    var bjx = jx * c + jy * sn, bjy = -jx * sn + jy * c;
    var rx = px - s.x, ry = py - s.y;
    var brx = rx * c + ry * sn, bry = -rx * sn + ry * c;
    var oldVx = s.vx;
    s.vx += bjx / p.mass;
    s.vy += bjy / p.mass;
    s.yawRate += (brx * bjy - bry * bjx) / p.Iz;
    s.yawRate = clamp(s.yawRate, -12, 12);
    var dv = s.vx - oldVx;
    for (var i = 0; i < 4; i++) s.wheels[i].omega += dv / (i < 2 ? p.radiusF : p.radiusR);
    s.speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    return s;
  }
  /** World positions of the 4 contact patches with skid intensity (for skid marks / smoke). */
  function wheelPositions(p, s, out) {
    out = out || [{}, {}, {}, {}];
    var c = Math.cos(s.heading), sn = Math.sin(s.heading);
    for (var i = 0; i < 4; i++) {
      var xi = wheelX(p, i), yi = wheelY(p, i);
      var o = out[i] || (out[i] = {});
      o.x = s.x + xi * c - yi * sn;
      o.y = s.y + xi * sn + yi * c;
      o.skid = s.wheels[i].skid;
      o.spin = (i < 2 ? p.splitF > 0 : p.splitF < 1) ? s.wheelspin : 0;
      o.locked = s.wheels[i].locked;
      o.load = s.wheels[i].load;
    }
    return out;
  }

  /** Straight-line launch sim (full throttle). Returns {t (s) to target or null, trace}. */
  function simulateLaunch(p, targetKph, opts) {
    opts = opts || {};
    var s = createState(p, { x: 0, y: 0, heading: 0, autoShift: true });
    var dt = opts.dt || 1 / 120, tMax = opts.tMax || 60;
    var env = opts.env || { gripMult: 1, wet: 0 };
    var target = targetKph / 3.6;
    var trace = [];
    var inp = { throttle: 1, brake: 0, steer: 0, handbrake: false };
    for (var t = 0; t < tMax; t += dt) {
      step(p, s, inp, dt, env);
      if (opts.trace && Math.round(t / dt) % 6 === 0) trace.push({ t: t, kph: s.vx * 3.6, gear: s.gear, rpm: s.rpm });
      if (s.vx >= target) return { t: t + dt, trace: trace, state: s };
    }
    return { t: null, trace: trace, state: s };
  }

  CB.race.vehicle = {
    fromBuild: fromBuild,
    createState: createState,
    reset: reset,
    step: step,
    // helpers
    worldVelocity: worldVelocity,
    setWorldVelocity: setWorldVelocity,
    applyImpulse: applyImpulse,
    wheelPositions: wheelPositions,
    simulateLaunch: simulateLaunch,
    gearRatio: gearRatioTotal,
    torqueAt: lookupTorque,
    accelAt: accelAt,
    latAccelAt: latAccelAt,
    brakeAccelAt: brakeAccelAt,
    capabilities: function (p) { return p.capabilities || computeCapabilities(p); },
    // arcade handling (docs/ARCADE-SPEC.md)
    withHandling: withHandling,
    isArcade: isArcade,
    arcadeResponse: arcadeResponse,
    arcadeCurvatureLimit: arcadeCurvatureLimit,
    arcadeLatCap: function (p, v, gripMult) { return arcadeLatCap(isArcade(p) ? p : withHandling(p, 'arcade'), v, gripMult); },
    spinOut: spinOut,
    ARCADE: ARC,
    estimateMass: estimateMass,
    estimatePowerKw: estimatePowerKw,
    _fallbackCatalog: FB,
    STEER_LEFT_POSITIVE: true
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.vehicle;
